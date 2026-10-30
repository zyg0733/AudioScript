mod pcm;
mod subtitles;
mod worker;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::asr::streaming::StreamingAdapter;
use crate::config::{target_lang_for, AsrConfig, TranslateConfig};
use crate::library::{LibraryRecord, LibrarySource, LibrarySourceKind, LibraryState, Repository};
use crate::transcript::TranscriptSegment;
use crate::translate::local_nmt::LocalNmt;

const MAX_MEDIA_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ACTIVE_JOBS: usize = 4;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ProcessOptions {
    title: Option<String>,
    source_lang: String,
    translate: bool,
    mode: String,
}
impl Default for ProcessOptions {
    fn default() -> Self {
        Self {
            title: None,
            source_lang: "en".into(),
            translate: true,
            mode: "transcribe".into(),
        }
    }
}
impl ProcessOptions {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.source_lang.as_str(), "en" | "zh") {
            return Err("离线处理目前只支持英语或中文，请明确选择语言".into());
        }
        if !matches!(self.mode.as_str(), "transcribe" | "translate") {
            return Err("处理模式必须为 transcribe 或 translate".into());
        }
        if self.title.as_ref().is_some_and(|s| s.chars().count() > 240) {
            return Err("资料标题不能超过 240 字".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedMedia {
    source_id: String,
    path: String,
    original_name: String,
    kind: String,
    size_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaJobInfo {
    job_id: String,
    source_id: String,
    status: String,
    phase: String,
    progress: f32,
    error: Option<String>,
    record_id: Option<String>,
}
impl MediaJobInfo {
    fn terminal(&self) -> bool {
        matches!(self.status.as_str(), "completed" | "cancelled" | "failed")
    }
}

struct Job {
    info: MediaJobInfo,
    source: LibrarySource,
    media: Option<ManagedMedia>,
    options: ProcessOptions,
    prior_segments: Vec<TranscriptSegment>,
    cancel: Arc<AtomicBool>,
    worker_started: bool,
    commit_started: bool,
    committed: bool,
}

impl Job {
    fn can_cleanup_now(&self) -> bool {
        !self.worker_started && self.can_cleanup_after_worker()
    }
    fn can_cleanup_after_worker(&self) -> bool {
        !self.commit_started && !self.committed && self.info.record_id.is_none()
    }
}

#[derive(Default)]
struct Shared {
    root: Option<PathBuf>,
    jobs: HashMap<String, Job>,
    uploads: HashMap<String, pcm::Upload>,
}

struct Task {
    app: AppHandle,
    job_id: String,
    source: LibrarySource,
    options: ProcessOptions,
    prior_segments: Vec<TranscriptSegment>,
    cancel: Arc<AtomicBool>,
}

pub struct MediaState {
    shared: Arc<Mutex<Shared>>,
    sender: mpsc::SyncSender<Task>,
}

impl MediaState {
    /// Call before any native model initialization: the controller thread must pre-exist CT2/MKL.
    pub fn new() -> Result<Self, String> {
        let shared = Arc::new(Mutex::new(Shared::default()));
        let worker_shared = shared.clone();
        let (sender, receiver) = mpsc::sync_channel::<Task>(MAX_ACTIVE_JOBS);
        std::thread::Builder::new()
            .name("media-offline-worker".into())
            .spawn(move || {
                while let Ok(task) = receiver.recv() {
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        execute(&worker_shared, &task)
                    }))
                    .unwrap_or_else(|_| Err("离线任务异常中断，请重试".into()));
                    if let Err(error) = result {
                        let mut shared = worker_shared.lock().unwrap_or_else(|e| e.into_inner());
                        let mut cleanup = false;
                        if let Some(job) = shared.jobs.get_mut(&task.job_id) {
                            cleanup = job.can_cleanup_after_worker();
                            if !job.info.terminal() {
                                job.info.status = "failed".into();
                                job.info.error = Some(error);
                            }
                        }
                        let root = shared.root.clone();
                        drop(shared);
                        if cleanup {
                            if let Some(root) = root {
                                cleanup_owned_source(&root, &task.source);
                            }
                        }
                    }
                }
            })
            .map_err(|e| format!("创建离线媒体工作线程失败：{e}"))?;
        Ok(Self { shared, sender })
    }

    pub fn init(&self, app: &AppHandle) -> Result<(), String> {
        let root = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("library/media");
        std::fs::create_dir_all(&root).map_err(|e| format!("创建媒体目录失败：{e}"))?;
        let root = dunce::canonicalize(root).map_err(|e| e.to_string())?;
        cleanup_parts(&root)?;
        self.shared.lock().unwrap_or_else(|e| e.into_inner()).root = Some(root);
        Ok(())
    }

    pub fn cancel_all(&self) {
        let mut shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        let sources = cancel_jobs(&mut shared);
        shared.uploads.clear();
        let root = shared.root.clone();
        drop(shared);
        if let Some(root) = root {
            for source in sources {
                cleanup_owned_source(&root, &source);
            }
        }
    }

    fn root(&self) -> Result<PathBuf, String> {
        self.shared
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .root
            .clone()
            .ok_or_else(|| "媒体目录尚未初始化".into())
    }

    fn add_job(
        &self,
        source: LibrarySource,
        media: Option<ManagedMedia>,
        options: ProcessOptions,
        prior_segments: Vec<TranscriptSegment>,
    ) -> Result<MediaJobInfo, String> {
        options.validate()?;
        let mut shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        if shared.jobs.values().filter(|j| !j.info.terminal()).count() >= MAX_ACTIVE_JOBS {
            return Err("已有 4 个媒体任务，请等待或取消任务后再导入".into());
        }
        if shared.jobs.len() >= 128 {
            shared.jobs.retain(|_, job| !job.info.terminal());
        }
        let info = MediaJobInfo {
            job_id: uuid::Uuid::new_v4().to_string(),
            source_id: source
                .id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            status: "preparing".into(),
            phase: "decoding".into(),
            progress: 0.0,
            error: None,
            record_id: None,
        };
        shared.jobs.insert(
            info.job_id.clone(),
            Job {
                info: info.clone(),
                source,
                media,
                options,
                prior_segments,
                cancel: Arc::new(AtomicBool::new(false)),
                worker_started: false,
                commit_started: false,
                committed: false,
            },
        );
        Ok(info)
    }

    fn queue(&self, app: &AppHandle, job_id: &str) -> Result<MediaJobInfo, String> {
        let mut shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        let job = shared.jobs.get_mut(job_id).ok_or("媒体任务不存在")?;
        if job.info.status != "preparing" && job.info.status != "uploading" {
            return Err("任务已提交或已结束，不能重复提交".into());
        }
        worker::check_cancel(&job.cancel)?;
        if job.options.mode == "transcribe" && job.source.pcm_path.is_none() {
            return Err("音频尚未完整上传".into());
        }
        let task = Task {
            app: app.clone(),
            job_id: job_id.into(),
            source: job.source.clone(),
            options: job.options.clone(),
            prior_segments: job.prior_segments.clone(),
            cancel: job.cancel.clone(),
        };
        job.info.status = "queued".into();
        job.info.phase = "queued".into();
        job.info.progress = 20.0;
        if self.sender.try_send(task).is_err() {
            job.info.status = "failed".into();
            job.info.error = Some("离线任务队列不可用，请重试".into());
        }
        Ok(job.info.clone())
    }
}

fn local_file(path: &str, max: u64) -> Result<PathBuf, String> {
    let path = dunce::canonicalize(path).map_err(|e| format!("无法读取所选文件：{e}"))?;
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("请选择非空的本地文件".into());
    }
    if metadata.len() > max {
        return Err(format!("文件超过 {} MiB 上限", max / 1024 / 1024));
    }
    Ok(path)
}

fn copy_media(root: &Path, path: &str) -> Result<ManagedMedia, String> {
    let path = local_file(path, MAX_MEDIA_BYTES)?;
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let kind = match extension.as_str() {
        "wav" | "mp3" | "m4a" | "aac" | "flac" | "ogg" | "opus" => "audio",
        "mp4" | "m4v" | "mov" | "webm" | "mkv" => "video",
        _ => return Err("不支持此文件扩展名；可选择 WAV、MP3、M4A、AAC、FLAC、OGG、OPUS、MP4、M4V、MOV、WebM 或 MKV；能否解码取决于系统 WebView".into()),
    };
    let source_id = uuid::Uuid::new_v4().to_string();
    let directory = root.join(&source_id);
    std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
    let destination = directory.join(format!("source.{extension}"));
    let temporary = directory.join("source.part");
    let result = (|| {
        use std::io::Read;
        let input = std::fs::File::open(&path).map_err(|e| e.to_string())?;
        let expected = input.metadata().map_err(|e| e.to_string())?.len();
        let mut output = std::fs::File::create(&temporary).map_err(|e| e.to_string())?;
        let size = std::io::copy(&mut input.take(MAX_MEDIA_BYTES + 1), &mut output)
            .map_err(|e| format!("复制所选媒体失败：{e}"))?;
        if size > MAX_MEDIA_BYTES || size != expected {
            return Err("媒体在导入期间发生变化或超过 512 MiB，请等待文件写入完成后重试".into());
        }
        output.sync_all().map_err(|e| e.to_string())?;
        drop(output);
        std::fs::rename(&temporary, &destination).map_err(|e| e.to_string())?;
        Ok(size)
    })();
    match result {
        Ok(size_bytes) => Ok(ManagedMedia {
            source_id,
            path: destination.to_string_lossy().into_owned(),
            original_name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            kind: kind.into(),
            size_bytes,
        }),
        Err(error) => {
            let _ = std::fs::remove_dir_all(directory);
            Err(error)
        }
    }
}

fn source_for(media: &ManagedMedia) -> LibrarySource {
    let pcm_path = pcm::inspect_wav(Path::new(&media.path))
        .ok()
        .map(|_| media.path.clone());
    let duration_ms = pcm::inspect_wav(Path::new(&media.path))
        .ok()
        .map(|i| i.duration_ms());
    LibrarySource {
        kind: LibrarySourceKind::Media,
        label: media.original_name.clone(),
        url: None,
        id: Some(media.source_id.clone()),
        media_path: Some(media.path.clone()),
        pcm_path,
        duration_ms,
        derived_from_id: None,
        source_lang: None,
    }
}

fn managed_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let path = dunce::canonicalize(path).map_err(|_| "已保留的媒体文件不存在，请重新导入")?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("媒体路径不在应用管理目录内".into());
    }
    Ok(path)
}

fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少参数 {key}"))
}
fn options(args: &Value) -> Result<ProcessOptions, String> {
    serde_json::from_value(args.get("options").cloned().unwrap_or(json!({})))
        .map_err(|e| format!("媒体任务参数无效：{e}"))
}

fn import_subtitles(
    repo: &Repository,
    root: &Path,
    args: &Value,
    default_language: &str,
) -> Result<LibraryRecord, String> {
    let source_lang = match args.get("sourceLang") {
        None => default_language,
        Some(Value::String(language)) => language,
        _ => return Err("字幕语言必须为英语或中文".into()),
    };
    if !matches!(source_lang, "en" | "zh") {
        return Err("字幕语言必须为英语或中文".into());
    }
    let path = local_file(string(args, "path")?, subtitles::MAX_SUBTITLE_BYTES as u64)?;
    if !matches!(
        path.extension()
            .and_then(|s| s.to_str())
            .map(str::to_lowercase)
            .as_deref(),
        Some("srt" | "vtt")
    ) {
        return Err("请选择 .srt 或 .vtt 字幕文件".into());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|_| "字幕必须是有效 UTF-8 文本，请先转换编码")?;
    let segments = subtitles::parse(&text)?;
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("导入字幕")
        })
        .trim();
    if title.is_empty() || title.chars().count() > 240 {
        return Err("资料标题须为 1 到 240 字".into());
    }
    let mut source = if let Some(media_path) = args.get("mediaPath").and_then(Value::as_str) {
        source_for(&copy_media(root, media_path)?)
    } else {
        LibrarySource {
            kind: LibrarySourceKind::Subtitle,
            label: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            url: None,
            id: Some(uuid::Uuid::new_v4().to_string()),
            media_path: None,
            pcm_path: None,
            duration_ms: segments.iter().map(|s| s.end_ms).max(),
            derived_from_id: None,
            source_lang: None,
        }
    };
    source.kind = LibrarySourceKind::Subtitle;
    source.source_lang = Some(source_lang.into());
    // 保存可能在替换记录后因目录同步失败而报错，此时仍须保留记录引用的媒体。
    repo.create_record(title.to_string(), source, segments)
}

fn prepare_reprocess(
    record: &LibraryRecord,
    root: &Path,
    args: &Value,
) -> Result<(LibrarySource, ProcessOptions, Option<ManagedMedia>), String> {
    let mut options = options(args)?;
    let mut source = record.source.clone();
    if args
        .get("options")
        .and_then(|o| o.get("sourceLang"))
        .is_none()
    {
        options.source_lang = source
            .source_lang
            .clone()
            .ok_or("此资料尚未设置原文语言，请先选择英语或中文再处理")?;
    }
    options.validate()?;
    source.source_lang = Some(options.source_lang.clone());
    source.derived_from_id = Some(record.id.clone());
    let mut media = None;
    if options.mode != "translate" {
        if let Some(path) = source.media_path.as_deref() {
            let path = managed_path(root, path)?;
            media = Some(ManagedMedia {
                source_id: source
                    .id
                    .clone()
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                size_bytes: std::fs::metadata(&path).map_err(|e| e.to_string())?.len(),
                original_name: source.label.clone(),
                kind: if matches!(
                    path.extension().and_then(|s| s.to_str()),
                    Some("mp4" | "m4v" | "mov" | "webm" | "mkv")
                ) {
                    "video"
                } else {
                    "audio"
                }
                .into(),
                path: path.to_string_lossy().into_owned(),
            });
        }
        if let Some(path) = source.pcm_path.as_deref() {
            pcm::inspect_wav(&managed_path(root, path)?)?;
        }
        if media.is_none() && source.pcm_path.is_none() {
            options.mode = "translate".into();
        }
    }
    if options.title.is_none() {
        options.title = Some(format!("{} · 新版本", record.title));
    }
    Ok((source, options, media))
}

pub fn route(app: &AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    let state = app.state::<MediaState>();
    match name {
        "media_import" => {
            let options = options(args)?;
            options.validate()?;
            let root = state.root()?;
            let media = copy_media(&root, string(args, "path")?)?;
            let mut source = source_for(&media);
            source.source_lang = Some(options.source_lang.clone());
            let pcm_ready = source.pcm_path.is_some();
            let job = match state.add_job(source, Some(media.clone()), options, Vec::new()) {
                Ok(job) => job,
                Err(error) => {
                    if let Some(directory) = Path::new(&media.path).parent() {
                        let _ = std::fs::remove_dir_all(directory);
                    }
                    return Err(error);
                }
            };
            Ok(json!({"job":job,"media":media,"pcmReady":pcm_ready}))
        }
        "media_import_subtitles" => Ok(json!(import_subtitles(
            &app.state::<LibraryState>().repo(),
            &state.root()?,
            args,
            &crate::prefs::load(app).source_lang,
        )?)),
        "media_reprocess" => {
            let record = app
                .state::<LibraryState>()
                .repo()
                .get(string(args, "recordId")?)?;
            let (source, options, media) = prepare_reprocess(&record, &state.root()?, args)?;
            let pcm_ready = source.pcm_path.is_some();
            let translate_only = options.mode == "translate";
            let job = state.add_job(
                source,
                media.clone(),
                options,
                record.segments.into_iter().map(|s| s.segment).collect(),
            )?;
            let job = if translate_only {
                state.queue(app, &job.job_id)?
            } else {
                job
            };
            Ok(json!({"job":job,"media":media,"pcmReady":pcm_ready}))
        }
        "media_upload_begin" => {
            let job_id = string(args, "jobId")?;
            let total = args
                .get("totalBytes")
                .and_then(Value::as_u64)
                .ok_or("缺少 PCM 总长度")?;
            let mut shared = state.shared.lock().unwrap_or_else(|e| e.into_inner());
            if shared.uploads.values().any(|u| u.job_id == job_id) {
                return Err("该任务已有正在上传的音频".into());
            }
            let job = shared.jobs.get_mut(job_id).ok_or("媒体任务不存在")?;
            if job.info.status != "preparing" {
                return Err("当前任务状态不允许上传".into());
            }
            let directory = Path::new(job.media.as_ref().ok_or("任务没有媒体文件")?.path.as_str())
                .parent()
                .ok_or("媒体目录无效")?;
            let upload = pcm::Upload::new(job_id.into(), directory, total)?;
            job.info.status = "uploading".into();
            job.info.phase = "uploading".into();
            let upload_id = uuid::Uuid::new_v4().to_string();
            shared.uploads.insert(upload_id.clone(), upload);
            Ok(json!({"uploadId":upload_id}))
        }
        "media_upload_chunk" => {
            let upload_id = string(args, "uploadId")?;
            let index = args
                .get("index")
                .and_then(Value::as_u64)
                .and_then(|n| u32::try_from(n).ok())
                .ok_or("分块序号无效")?;
            let mut shared = state.shared.lock().unwrap_or_else(|e| e.into_inner());
            let upload = shared
                .uploads
                .get_mut(upload_id)
                .ok_or("上传不存在或已取消")?;
            upload.append(index, string(args, "pcmBase64")?)?;
            let response = json!({"nextIndex":upload.next_index,"receivedBytes":upload.received});
            let progress = upload.fraction() * 20.0;
            let job_id = upload.job_id.clone();
            if let Some(job) = shared.jobs.get_mut(&job_id) {
                job.info.progress = progress;
            }
            Ok(response)
        }
        "media_upload_finish" => {
            let job_id = string(args, "jobId")?;
            {
                let mut shared = state.shared.lock().unwrap_or_else(|e| e.into_inner());
                let upload_id = shared
                    .uploads
                    .iter()
                    .find(|(_, u)| u.job_id == job_id)
                    .map(|(id, _)| id.clone());
                if let Some(id) = upload_id {
                    let path = shared.uploads.remove(&id).ok_or("上传不存在")?.finish()?;
                    let info = pcm::inspect_wav(&path)?;
                    let job = shared.jobs.get_mut(job_id).ok_or("任务不存在")?;
                    job.source.pcm_path = Some(path.to_string_lossy().into_owned());
                    job.source.duration_ms = Some(info.duration_ms());
                }
            }
            Ok(json!(state.queue(app, job_id)?))
        }
        "media_job_status" | "media_job_cancel" => {
            let id = string(args, "jobId")?;
            let mut shared = state.shared.lock().unwrap_or_else(|e| e.into_inner());
            let job = shared.jobs.get_mut(id).ok_or("媒体任务不存在")?;
            let may_cleanup = job.can_cleanup_now();
            let cleanup_source = job.source.clone();
            if name == "media_job_cancel" && !job.info.terminal() {
                job.cancel.store(true, Ordering::Release);
                job.info.status = "cancelled".into();
                job.info.phase = "cancelled".into();
            }
            let info = job.info.clone();
            if name == "media_job_cancel" {
                shared.uploads.retain(|_, upload| upload.job_id != id);
            }
            let root = shared.root.clone();
            drop(shared);
            if name == "media_job_cancel" && info.status == "cancelled" && may_cleanup {
                if let Some(root) = root {
                    cleanup_owned_source(&root, &cleanup_source);
                }
            }
            Ok(json!(info))
        }
        _ => Err(format!("未知媒体命令：{name}")),
    }
}

fn cancel_jobs(shared: &mut Shared) -> Vec<LibrarySource> {
    for job in shared.jobs.values_mut().filter(|job| !job.info.terminal()) {
        job.cancel.store(true, Ordering::Release);
        job.info.status = "cancelled".into();
    }
    shared
        .jobs
        .values()
        .filter(|job| job.info.status == "cancelled" && job.can_cleanup_now())
        .map(|job| job.source.clone())
        .collect()
}

fn cleanup_parts(root: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir()
            || uuid::Uuid::parse_str(&entry.file_name().to_string_lossy()).is_err()
        {
            continue;
        }
        for file in std::fs::read_dir(entry.path()).map_err(|e| e.to_string())? {
            let file = file.map_err(|e| e.to_string())?;
            if file.file_type().map_err(|e| e.to_string())?.is_file()
                && file.path().extension().is_some_and(|e| e == "part")
            {
                std::fs::remove_file(file.path())
                    .map_err(|e| format!("无法清理上次未完成的临时音频：{e}"))?;
            }
        }
    }
    Ok(())
}

fn cleanup_owned_source(root: &Path, source: &LibrarySource) {
    if source.derived_from_id.is_some() || source.kind != LibrarySourceKind::Media {
        return;
    }
    let Some(directory) = source
        .media_path
        .as_deref()
        .and_then(|p| Path::new(p).parent())
    else {
        return;
    };
    if directory.parent() == Some(root)
        && directory.file_name().and_then(|s| s.to_str()) == source.id.as_deref()
    {
        let _ = std::fs::remove_dir_all(directory);
    }
}

fn progress(shared: &Mutex<Shared>, id: &str, phase: &str, value: f32) {
    if let Some(job) = shared
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .jobs
        .get_mut(id)
    {
        if !job.info.terminal() {
            job.info.status = "running".into();
            job.info.phase = phase.into();
            job.info.progress = value;
        }
    }
}

fn execute(shared: &Mutex<Shared>, task: &Task) -> Result<(), String> {
    {
        let mut shared = shared.lock().unwrap_or_else(|e| e.into_inner());
        worker::check_cancel(&task.cancel)?;
        shared
            .jobs
            .get_mut(&task.job_id)
            .ok_or("媒体任务不存在")?
            .worker_started = true;
    }
    let session = task.app.state::<crate::session::SessionState>();
    let _guard = session.reserve_processing()?;
    let prefs = crate::prefs::load(&task.app);
    let roots = crate::paths::search_roots(&task.app);
    let mut segments = if task.options.mode == "translate" {
        worker::new_version(task.prior_segments.clone())
    } else {
        progress(shared, &task.job_id, "recognizing", 21.0);
        let model = crate::paths::locate_asr(&roots, prefs.asr_model_tier)?;
        let config = AsrConfig {
            model_dir: Some(model.path.to_string_lossy().into_owned()),
            source_lang: task.options.source_lang.clone(),
            ..Default::default()
        };
        worker::recognize(
            &mut StreamingAdapter::new(),
            &config,
            Path::new(task.source.pcm_path.as_deref().ok_or("缺少保留音频")?),
            &task.cancel,
            |p| progress(shared, &task.job_id, "recognizing", 21.0 + p * 49.0),
        )?
    };
    if segments.is_empty() {
        return Err("资料没有可处理的段落".into());
    }
    let failed = if task.options.translate {
        worker::check_cancel(&task.cancel)?;
        progress(shared, &task.job_id, "translating", 71.0);
        let mut config = TranslateConfig {
            source_lang: task.options.source_lang.clone(),
            target_lang: target_lang_for(&task.options.source_lang).into(),
            zh_script: prefs.zh_script,
            ..Default::default()
        };
        let translator = crate::paths::locate_mt_root(&roots, prefs.mt_model_tier).map(|model| {
            config.model_dir = Some(model.path.to_string_lossy().into_owned());
            LocalNmt::new(model.path, prefs.mt_model_tier)
        });
        worker::translate_prepared(translator, &config, &mut segments, &task.cancel, |p| {
            progress(shared, &task.job_id, "translating", 71.0 + p * 25.0)
        })?
    } else {
        0
    };
    progress(shared, &task.job_id, "saving", 98.0);
    let mut shared = shared.lock().unwrap_or_else(|e| e.into_inner());
    worker::check_cancel(&task.cancel)?;
    shared
        .jobs
        .get_mut(&task.job_id)
        .ok_or("媒体任务不存在")?
        .commit_started = true;
    let title = task
        .options
        .title
        .clone()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| task.source.label.clone());
    let record = task.app.state::<LibraryState>().repo().create_record(
        title,
        task.source.clone(),
        segments,
    )?;
    if let Some(job) = shared.jobs.get_mut(&task.job_id) {
        job.committed = true;
        job.info.status = "completed".into();
        job.info.phase = "done".into();
        job.info.progress = 100.0;
        job.info.record_id = Some(record.id);
        if failed > 0 {
            job.info.error = Some(format!(
                "资料已保存，{failed} 段翻译失败，可在资料中查看原因并重试"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture_root() -> PathBuf {
        let path = std::env::temp_dir().join(format!("audioscript-media-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        dunce::canonicalize(path).unwrap()
    }

    #[test]
    fn subtitle_import_keeps_language_and_copies_explicit_media_from_another_directory() {
        let root = fixture_root();
        let outside = fixture_root();
        let repo = Repository::new(root.join("library")).unwrap();
        let media_root = root.join("managed");
        std::fs::create_dir(&media_root).unwrap();
        let subtitles = root.join("lecture.srt");
        std::fs::write(&subtitles, "1\n00:00:00,000 --> 00:00:01,000\n你好\n").unwrap();
        let media = outside.join("lecture.mp3");
        std::fs::write(&media, b"original media").unwrap();
        let args = json!({"path":subtitles,"mediaPath":media,"sourceLang":"zh"});
        let imported = import_subtitles(&repo, &media_root, &args, "en").unwrap();
        let reopened = repo.get(&imported.id).unwrap();
        assert_eq!(reopened.source.source_lang.as_deref(), Some("zh"));
        assert_eq!(reopened.source.kind, LibrarySourceKind::Subtitle);
        assert_eq!(reopened.segments[0].segment.text, "你好");
        let managed = Path::new(reopened.source.media_path.as_ref().unwrap());
        assert!(managed.starts_with(&media_root));
        assert_ne!(managed, media);
        assert_eq!(std::fs::read(managed).unwrap(), b"original media");
        assert_eq!(std::fs::read(&media).unwrap(), b"original media");
        std::fs::remove_file(managed).unwrap();
        let mut missing_media = reopened.clone();
        missing_media.source.pcm_path = Some(media_root.join("missing.wav").display().to_string());
        let (derived, options, prepared_media) = prepare_reprocess(
            &missing_media,
            &media_root,
            &json!({"options":{"mode":"translate"}}),
        )
        .unwrap();
        assert_eq!(options.source_lang, "zh");
        assert_eq!(derived.media_path, missing_media.source.media_path);
        assert_eq!(
            derived.derived_from_id.as_deref(),
            Some(reopened.id.as_str())
        );
        assert!(prepared_media.is_none());
        assert!(prepare_reprocess(
            &missing_media,
            &media_root,
            &json!({"options":{"mode":"transcribe"}}),
        )
        .is_err());
        missing_media.source.source_lang = None;
        assert!(prepare_reprocess(
            &missing_media,
            &media_root,
            &json!({"options":{"mode":"translate"}}),
        )
        .unwrap_err()
        .contains("原文语言"));
        assert!(prepare_reprocess(
            &missing_media,
            &media_root,
            &json!({"options":{"mode":"translate","sourceLang":"zh"}}),
        )
        .is_ok());
        missing_media.source.source_lang = Some("fr".into());
        assert!(prepare_reprocess(
            &missing_media,
            &media_root,
            &json!({"options":{"mode":"translate"}}),
        )
        .is_err());
        let fallback =
            import_subtitles(&repo, &media_root, &json!({"path":subtitles}), "zh").unwrap();
        assert_eq!(fallback.source.source_lang.as_deref(), Some("zh"));
        for invalid in [json!("fr"), json!(null), json!(true)] {
            let args = json!({"path":subtitles,"mediaPath":media,"sourceLang":invalid});
            assert!(import_subtitles(&repo, &media_root, &args, "en").is_err());
        }
        assert!(import_subtitles(
            &repo,
            &media_root,
            &json!({"path":subtitles,"mediaPath":media,"title":" "}),
            "en",
        )
        .is_err());
        assert_eq!(std::fs::read_dir(&media_root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn restart_removes_only_our_unfinished_parts_and_keeps_managed_media() {
        let root = fixture_root();
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("unfinished.part"), b"partial").unwrap();
        std::fs::write(dir.join("source.wav"), b"preserved").unwrap();
        let unrelated = root.join("not-a-source");
        std::fs::create_dir(&unrelated).unwrap();
        std::fs::write(unrelated.join("keep.part"), b"keep").unwrap();
        cleanup_parts(&root).unwrap();
        assert!(!dir.join("unfinished.part").exists());
        assert!(dir.join("source.wav").exists());
        assert!(unrelated.join("keep.part").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn asset_paths_cannot_escape_managed_root_and_derived_cleanup_preserves_original() {
        let root = fixture_root();
        let outside = fixture_root();
        let dir = root.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("source.mp3");
        std::fs::write(&path, b"original").unwrap();
        let external = outside.join("private.mp3");
        std::fs::write(&external, b"private").unwrap();
        assert!(managed_path(&root, &path.to_string_lossy()).is_ok());
        assert!(managed_path(&root, &external.to_string_lossy()).is_err());
        #[cfg(unix)]
        {
            let link = dir.join("escape.mp3");
            std::os::unix::fs::symlink(&external, &link).unwrap();
            assert!(managed_path(&root, &link.to_string_lossy()).is_err());
        }
        let media = ManagedMedia {
            source_id: dir.file_name().unwrap().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            original_name: "original".into(),
            kind: "audio".into(),
            size_bytes: 8,
        };
        let mut source = source_for(&media);
        source.derived_from_id = Some(uuid::Uuid::new_v4().to_string());
        cleanup_owned_source(&root, &source);
        assert!(path.exists());
        source.derived_from_id = None;
        cleanup_owned_source(&root, &source);
        assert!(!dir.exists());
        assert!(external.exists());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn repeated_shutdown_never_discards_running_committing_or_uncertain_assets() {
        fn job(id: &str, status: &str, started: bool, committing: bool, committed: bool) -> Job {
            Job {
                info: MediaJobInfo {
                    job_id: id.into(),
                    source_id: id.into(),
                    status: status.into(),
                    phase: if committing { "saving" } else { "queued" }.into(),
                    progress: 0.0,
                    error: None,
                    record_id: committed.then(|| "record".into()),
                },
                source: LibrarySource {
                    kind: LibrarySourceKind::Media,
                    label: id.into(),
                    url: None,
                    id: Some(id.into()),
                    media_path: None,
                    pcm_path: None,
                    duration_ms: None,
                    derived_from_id: None,
                    source_lang: Some("en".into()),
                },
                media: None,
                options: ProcessOptions::default(),
                prior_segments: Vec::new(),
                cancel: Arc::new(AtomicBool::new(false)),
                worker_started: started,
                commit_started: committing,
                committed,
            }
        }
        let mut shared = Shared::default();
        for item in [
            job("queued", "queued", false, false, false),
            job("running", "running", true, false, false),
            job("saving", "running", true, true, false),
            job("committed", "completed", true, true, true),
            job("uncertain", "failed", true, true, false),
        ] {
            shared.jobs.insert(item.info.job_id.clone(), item);
        }
        for _ in 0..2 {
            let cleanup = cancel_jobs(&mut shared);
            assert_eq!(cleanup.len(), 1);
            assert_eq!(cleanup[0].label, "queued");
            assert_eq!(shared.jobs["committed"].info.status, "completed");
            assert_eq!(shared.jobs["uncertain"].info.status, "failed");
            assert!(!shared.jobs["saving"].can_cleanup_after_worker());
            assert!(!shared.jobs["uncertain"].can_cleanup_after_worker());
            assert!(shared.jobs["running"].can_cleanup_after_worker());
        }
    }
}
