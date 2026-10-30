mod content;
mod model;
mod repository;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

pub use content::{analyze, ask, render_export};
pub use model::*;
pub use repository::{atomic_write, Repository};

pub const EVENT_CHANGED: &str = "library://changed";

pub struct LibraryState {
    repository: Arc<Repository>,
}

impl LibraryState {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        Ok(Self {
            repository: Arc::new(Repository::new(root)?),
        })
    }

    pub fn repo(&self) -> Arc<Repository> {
        Arc::clone(&self.repository)
    }
}

fn string<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("缺少参数 {key}"))
}

fn number(args: &Value, key: &str) -> Result<u32, String> {
    args.get(key)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| format!("参数 {key} 必须为有效版本号"))
}

fn optional_string(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(format!("参数 {key} 必须为文字")),
    }
}

fn encode<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| format!("资料结果序列化失败：{e}"))
}

pub fn route(app: &AppHandle, name: &str, args: &Value) -> Result<Value, String> {
    let state = app
        .try_state::<LibraryState>()
        .ok_or("资料保存暂不可用，请检查应用数据目录后重启")?;
    let repo = state.repo();
    let result = match name {
        "library_list" => encode(repo.list(args.get("query").and_then(Value::as_str))?),
        "library_browse" => encode(repo.browse(args.get("query").and_then(Value::as_str))?),
        "library_get" => encode(repo.get(string(args, "id")?)?),
        "library_rename" => {
            encode(repo.rename(string(args, "id")?, string(args, "title")?.to_owned())?)
        }
        "library_source_update" => encode(repo.update_source(
            string(args, "id")?,
            string(args, "label")?.to_owned(),
            optional_string(args, "url")?,
            optional_string(args, "sourceLang")?,
        )?),
        "library_delete" => {
            repo.delete(string(args, "id")?)?;
            Ok(Value::Null)
        }
        "library_segment_update" => {
            let patch = SegmentPatch {
                expected_revision: number(args, "expectedRevision")?,
                text: optional_string(args, "text")?,
                translation: optional_string(args, "translation")?,
                note: optional_string(args, "note")?,
                bookmarked: match args.get("bookmarked") {
                    None | Some(Value::Null) => None,
                    Some(Value::Bool(value)) => Some(*value),
                    _ => return Err("参数 bookmarked 必须为布尔值".into()),
                },
            };
            encode(repo.update_segment(string(args, "id")?, string(args, "segmentId")?, patch)?)
        }
        "library_history_restore" => encode(repo.restore_version(
            string(args, "id")?,
            string(args, "segmentId")?,
            number(args, "versionRevision")?,
            number(args, "expectedRevision")?,
        )?),
        "library_export" => {
            let ids = args
                .get("segmentIds")
                .map(|value| {
                    serde_json::from_value::<Vec<String>>(value.clone())
                        .map_err(|_| "segmentIds 必须是段落标识列表".to_owned())
                })
                .transpose()?;
            let path = repo.export(
                string(args, "id")?,
                Path::new(string(args, "path")?),
                string(args, "format")?,
                ids.as_deref(),
                args.get("useBookmarkVersions")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )?;
            Ok(json!({ "path": path.display().to_string() }))
        }
        "library_terms_list" => encode(repo.terms()?),
        "library_terms_suggest" => {
            let ids = args
                .get("segmentIds")
                .map(|value| {
                    serde_json::from_value::<Vec<String>>(value.clone())
                        .map_err(|_| "segmentIds 必须是段落标识列表".to_owned())
                })
                .transpose()?;
            encode(repo.term_suggestions(string(args, "id")?, ids.as_deref())?)
        }
        "library_terms_apply" => encode(
            repo.apply_term(
                string(args, "id")?,
                string(args, "segmentId")?,
                string(args, "termId")?,
                number(args, "expectedRevision")?,
                args.get("expectedTermUpdatedAt")
                    .and_then(Value::as_u64)
                    .ok_or("缺少术语建议版本，请重新生成建议")?,
            )?,
        ),
        "library_terms_upsert" => {
            let input: TermInput =
                serde_json::from_value(args.get("term").cloned().ok_or("缺少 term 参数")?)
                    .map_err(|e| format!("术语参数无效：{e}"))?;
            encode(repo.upsert_term(input)?)
        }
        "library_terms_delete" => {
            repo.delete_term(string(args, "id")?)?;
            Ok(Value::Null)
        }
        "library_analyze" => encode(analyze(&repo.get(string(args, "id")?)?)),
        "library_ask" => encode(ask(
            &repo.get(string(args, "id")?)?,
            string(args, "question")?,
        )?),
        _ => Err(format!("未知资料命令：{name}")),
    };
    if result.is_ok()
        && matches!(
            name,
            "library_rename"
                | "library_source_update"
                | "library_delete"
                | "library_segment_update"
                | "library_history_restore"
                | "library_terms_upsert"
                | "library_terms_delete"
                | "library_terms_apply"
        )
    {
        let _ = app.emit(EVENT_CHANGED, json!({ "id": args.get("id") }));
    }
    result
}

#[cfg(test)]
mod tests;
