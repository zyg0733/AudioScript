use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::library::{LibrarySource, LibrarySourceKind, Repository};
use crate::transcript::{TranscriptSegment, TranslationState};

pub const EVENT_WORKSPACE: &str = "workspace://changed";

#[typeshare::typeshare]
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatus {
    pub enabled: bool,
    pub record_id: Option<String>,
    #[typeshare(serialized_as = "Option<u32>")]
    pub saved_at: Option<u64>,
    pub saving: bool,
    pub error: Option<String>,
}

#[derive(Default)]
struct Inner {
    status: WorkspaceStatus,
    epoch: u64,
    pending: Option<Vec<TranscriptSegment>>,
    source_lang: String,
}

struct Shared {
    inner: Mutex<Inner>,
    wake: Condvar,
    repo: Arc<Repository>,
    path: PathBuf,
    app: AppHandle,
}

pub struct WorkspaceState(Arc<Shared>);

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn live_source(source_lang: &str) -> LibrarySource {
    LibrarySource {
        kind: LibrarySourceKind::Live,
        label: "实时转写".into(),
        url: None,
        id: None,
        media_path: None,
        pcm_path: None,
        duration_ms: None,
        derived_from_id: None,
        source_lang: Some(source_lang.into()),
    }
}

impl Shared {
    fn persist(&self, status: &WorkspaceStatus) -> Result<(), String> {
        let bytes = serde_json::to_vec(status).map_err(|e| format!("保存工作区设置失败：{e}"))?;
        crate::library::atomic_write(&self.path, &bytes)
    }

    fn emit(&self, status: &WorkspaceStatus) {
        let _ = self.app.emit(EVENT_WORKSPACE, status);
    }

    fn save(&self, inner: &mut Inner, segments: Vec<TranscriptSegment>) -> Result<(), String> {
        let record = self.repo.save_live(
            inner.status.record_id.as_deref(),
            "实时转写".into(),
            live_source(&inner.source_lang),
            segments,
        )?;
        inner.status.record_id = Some(record.id);
        inner.status.saved_at = Some(now());
        inner.status.error = None;
        self.persist(&inner.status)?;
        let _ = self.app.emit(
            crate::library::EVENT_CHANGED,
            json!({ "id": inner.status.record_id }),
        );
        Ok(())
    }
}

impl WorkspaceState {
    // 在应用 setup 中创建，始终早于任何本地模型初始化。
    pub fn new(app: AppHandle, repo: Arc<Repository>) -> Result<Self, String> {
        let path = repo.root().join("workspace.json");
        let mut status =
            match std::fs::read(&path) {
                Ok(bytes) => serde_json::from_slice::<WorkspaceStatus>(&bytes).unwrap_or_else(
                    |error| WorkspaceStatus {
                        error: Some(format!(
                            "工作区设置无法读取，原文件已保留，请在资料库查看已保存内容：{error}"
                        )),
                        ..Default::default()
                    },
                ),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => WorkspaceStatus::default(),
                Err(e) => WorkspaceStatus {
                    error: Some(format!("读取工作区设置失败：{e}")),
                    ..Default::default()
                },
            };
        status.saving = false;
        let shared = Arc::new(Shared {
            inner: Mutex::new(Inner {
                status,
                source_lang: crate::prefs::load(&app).source_lang,
                ..Inner::default()
            }),
            wake: Condvar::new(),
            repo,
            path,
            app,
        });
        let worker = Arc::clone(&shared);
        std::thread::Builder::new()
            .name("workspace-save".into())
            .spawn(move || loop {
                let mut inner = worker.inner.lock().unwrap_or_else(|e| e.into_inner());
                while inner.pending.is_none() {
                    inner = worker.wake.wait(inner).unwrap_or_else(|e| e.into_inner());
                }
                // 合并短时间内的翻译增量，磁盘队列只保留最新快照。
                let epoch = inner.epoch;
                let (mut inner, _) = worker
                    .wake
                    .wait_timeout(inner, Duration::from_millis(350))
                    .unwrap_or_else(|e| e.into_inner());
                if inner.epoch != epoch {
                    continue;
                }
                if let Some(segments) = inner.pending.take() {
                    if let Err(error) = worker.save(&mut inner, segments) {
                        inner.status.error = Some(error);
                    }
                    inner.status.saving = false;
                    worker.emit(&inner.status);
                }
            })
            .map_err(|e| format!("启动自动保存失败：{e}"))?;
        Ok(Self(shared))
    }

    pub fn restore(&self) {
        let id = self.status().record_id;
        if let Some(id) = id {
            let result = self.0.repo.get(&id).and_then(|record| {
                if let Some(lang) = record.source.source_lang {
                    self.0
                        .inner
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .source_lang = lang;
                }
                let mut segments = record
                    .segments
                    .into_iter()
                    .map(|entry| {
                        let mut segment = entry.segment;
                        segment.revision = segment.revision.max(entry.live_revision);
                        segment
                    })
                    .collect::<Vec<_>>();
                for segment in &mut segments {
                    if segment.translation_state == TranslationState::Pending {
                        segment.translation_state = TranslationState::Failed;
                        segment.translation_error =
                            Some("上次退出时翻译尚未完成，可重新翻译".into());
                        segment.revision += 1;
                    }
                }
                self.0
                    .app
                    .state::<crate::session::SessionState>()
                    .restore(segments)
            });
            if let Err(error) = result {
                self.0
                    .inner
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .status
                    .error = Some(error);
            }
        }
    }

    pub fn begin_capture(&self, source_lang: &str) {
        self.0
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .source_lang = source_lang.to_owned();
    }

    pub fn source_lang(&self) -> String {
        self.0
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .source_lang
            .clone()
    }

    pub fn status(&self) -> WorkspaceStatus {
        self.0
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .status
            .clone()
    }

    pub fn schedule(&self, segments: Vec<TranscriptSegment>) {
        if !segments.iter().any(TranscriptSegment::is_persistable) {
            return;
        }
        let mut inner = self.0.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !inner.status.enabled || inner.status.error.is_some() {
            return;
        }
        inner.pending = Some(segments);
        inner.status.saving = true;
        self.0.wake.notify_one();
    }

    pub fn flush(&self) {
        let mut inner = self.0.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.status.enabled {
            let snapshot = self
                .0
                .app
                .state::<crate::session::SessionState>()
                .snapshot();
            if snapshot.iter().any(TranscriptSegment::is_persistable) {
                if let Err(error) = self.0.save(&mut inner, snapshot) {
                    inner.status.error = Some(error);
                }
            }
        }
        inner.pending = None;
        inner.status.saving = false;
    }

    pub fn reset(&self) {
        let mut inner = self.0.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.epoch += 1;
        inner.pending = None;
        inner.status.record_id = None;
        inner.status.saved_at = None;
        inner.status.error = None;
        inner.status.saving = false;
        if let Err(error) = self.0.persist(&inner.status) {
            inner.status.error = Some(error);
        }
        self.0.emit(&inner.status);
    }

    fn set_enabled(&self, enabled: bool) -> Result<WorkspaceStatus, String> {
        let mut inner = self.0.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut updated = inner.status.clone();
        updated.enabled = enabled;
        updated.error = None;
        self.0.persist(&updated)?;
        inner.status = updated;
        if !enabled {
            inner.pending = None;
            inner.status.saving = false;
            inner.epoch += 1;
        }
        self.0.emit(&inner.status);
        Ok(inner.status.clone())
    }

    fn save_now(
        &self,
        segments: Vec<TranscriptSegment>,
        as_new: bool,
    ) -> Result<WorkspaceStatus, String> {
        if !segments.iter().any(TranscriptSegment::is_persistable) {
            return Err("暂无已定稿内容可保存".into());
        }
        let mut inner = self.0.inner.lock().unwrap_or_else(|e| e.into_inner());
        let previous_id = inner.status.record_id.clone();
        if as_new {
            inner.status.record_id = None;
        }
        inner.pending = None;
        inner.status.saving = false;
        match self.0.save(&mut inner, segments) {
            Ok(()) => {
                self.0.emit(&inner.status);
                Ok(inner.status.clone())
            }
            Err(error) => {
                if inner.status.record_id.is_none() {
                    inner.status.record_id = previous_id;
                }
                inner.status.error = Some(error.clone());
                self.0.emit(&inner.status);
                Err(error)
            }
        }
    }
}

pub fn route(app: &AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    let state = app
        .try_state::<WorkspaceState>()
        .ok_or("工作区保存暂不可用，请检查应用数据目录后重启")?;
    let status = match name {
        "workspace_status" => state.status(),
        "workspace_set" => {
            let enabled = args
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or("enabled 必须是布尔值")?;
            let status = state.set_enabled(enabled)?;
            if enabled {
                state.schedule(app.state::<crate::session::SessionState>().snapshot());
            }
            status
        }
        "workspace_save" => state.save_now(
            app.state::<crate::session::SessionState>()
                .export_snapshot()?,
            args.get("asNew").and_then(Value::as_bool).unwrap_or(false),
        )?,
        _ => return Err(format!("未知工作区命令：{name}")),
    };
    serde_json::to_value(status).map_err(|e| format!("读取工作区失败：{e}"))
}
