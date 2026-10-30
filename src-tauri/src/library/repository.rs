use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::model::*;
use crate::transcript::{SegmentState, TranscriptSegment, TranslationState};

pub struct Repository {
    root: PathBuf,
    access: Mutex<()>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TermsFile {
    schema_version: u32,
    terms: Vec<Term>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| format!("创建保存目录失败：{e}"))?;
    let temporary = parent.join(format!(".audioscript-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| format!("创建临时记录失败：{e}"))?;
        file.write_all(bytes)
            .map_err(|e| format!("写入记录失败：{e}"))?;
        file.sync_all().map_err(|e| format!("提交记录失败：{e}"))?;
        drop(file);
        replace_file(&temporary, path)?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|e| format!("提交保存目录失败，请重新打开记录确认：{e}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to).map_err(|e| format!("替换记录失败：{e}"))
}

#[cfg(windows)]
fn replace_file(from: &Path, to: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        return Err(format!("替换记录失败：{}", std::io::Error::last_os_error()));
    }
    Ok(())
}

fn valid_id(id: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| "记录标识无效".into())
}

fn nonempty(value: String, name: &str) -> Result<String, String> {
    let value = value.trim().to_owned();
    if value.is_empty() {
        Err(format!("{name}不能为空"))
    } else {
        Ok(value)
    }
}

fn search_excerpt(text: &str, query: &str) -> Option<String> {
    let offset = text.to_lowercase().find(query)?;
    let chars: Vec<char> = text.chars().collect();
    let mut folded_bytes = 0;
    let matched = chars
        .iter()
        .position(|c| {
            folded_bytes += c.to_lowercase().map(char::len_utf8).sum::<usize>();
            folded_bytes > offset
        })
        .unwrap_or(0);
    let start = matched.saturating_sub(35);
    let end = (matched + 125).min(chars.len());
    let snippet: String = chars[start..end].iter().collect();
    Some(format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        snippet,
        if end < chars.len() { "…" } else { "" }
    ))
}

fn version(segment: &LibrarySegment, origin: VersionOrigin, timestamp: u64) -> SegmentVersion {
    SegmentVersion {
        revision: segment.segment.revision,
        source_revision: segment.source_revision,
        text: segment.segment.text.clone(),
        translation: segment.segment.translation.clone(),
        translation_state: segment.segment.translation_state,
        translation_error: segment.segment.translation_error.clone(),
        committed_at: timestamp,
        origin,
    }
}

fn new_segment(
    mut segment: TranscriptSegment,
    origin: VersionOrigin,
    timestamp: u64,
) -> LibrarySegment {
    let live_revision = segment.revision;
    segment.revision = 1;
    let mut saved = LibrarySegment {
        source_edited: segment.state == SegmentState::Edited,
        segment,
        source_revision: 1,
        bookmarked: false,
        note: String::new(),
        bookmark_version: None,
        versions: Vec::new(),
        translation_edited: false,
        live_revision,
    };
    saved.versions.push(version(&saved, origin, timestamp));
    saved
}

fn validate_segments(segments: &[TranscriptSegment]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for segment in segments {
        if segment.id.is_empty() || !ids.insert(&segment.id) {
            return Err("段落标识为空或重复".into());
        }
        if segment.start_ms > segment.end_ms {
            return Err("段落时间范围无效".into());
        }
    }
    Ok(())
}

fn touch(record: &mut LibraryRecord) {
    record.revision = record.revision.saturating_add(1);
    record.updated_at = now_ms().max(record.updated_at.saturating_add(1));
}

fn commit_segment(segment: &mut LibrarySegment, origin: VersionOrigin) {
    segment.segment.revision = segment.segment.revision.saturating_add(1);
    segment.versions.push(version(segment, origin, now_ms()));
}

fn term_ranges(text: &str, term: &str) -> Vec<std::ops::Range<usize>> {
    let text_folded = text.to_ascii_lowercase();
    let term_folded = term.to_ascii_lowercase();
    let word_term = term.chars().any(|c| c.is_ascii_alphanumeric());
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    if term.is_empty() {
        return Vec::new();
    }
    text_folded
        .match_indices(&term_folded)
        .filter_map(|(start, _)| {
            let end = start + term.len();
            if word_term
                && (text[..start].chars().next_back().is_some_and(is_word)
                    || text[end..].chars().next().is_some_and(is_word))
            {
                None
            } else {
                Some(start..end)
            }
        })
        .collect()
}

fn term_suggestion(saved: &LibrarySegment, term: &Term) -> Option<TermSuggestion> {
    if saved.segment.translation_state != TranslationState::Done
        || term_ranges(&saved.segment.text, &term.source).is_empty()
    {
        return None;
    }
    let original = saved.segment.translation.as_deref()?;
    if !term_ranges(original, &term.target).is_empty() {
        return None;
    }
    let matches = term_ranges(original, &term.source);
    if matches.is_empty() {
        return None;
    }
    let mut proposed = String::new();
    let mut previous = 0;
    for range in &matches {
        proposed.push_str(&original[previous..range.start]);
        proposed.push_str(&term.target);
        previous = range.end;
    }
    proposed.push_str(&original[previous..]);
    Some(TermSuggestion {
        segment_id: saved.segment.id.clone(), term_id: term.id.clone(), term_updated_at: term.updated_at, expected_revision: saved.segment.revision,
        source: term.source.clone(), target: term.target.clone(), original_translation: original.to_owned(),
        suggested_translation: proposed, occurrences: matches.len() as u32,
        explanation: "译后术语校正：原文包含该术语，译文仍含完整原词且未包含约定释义。仅修改本段译文，请核对后应用；不影响识别模型。".into(),
    })
}

impl Repository {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(root.join("records")).map_err(|e| format!("无法创建资料目录：{e}"))?;
        Ok(Self {
            root,
            access: Mutex::new(()),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn record_path(&self, id: &str) -> Result<PathBuf, String> {
        valid_id(id)?;
        Ok(self.root.join("records").join(format!("{id}.json")))
    }

    fn read_record(&self, id: &str) -> Result<LibraryRecord, String> {
        let path = self.record_path(id)?;
        let bytes = fs::read(&path).map_err(|e| format!("读取记录 {id} 失败：{e}"))?;
        let record: LibraryRecord = serde_json::from_slice(&bytes)
            .map_err(|e| format!("记录 {id} 无法读取，原文件已保留：{e}"))?;
        if record.schema_version != SCHEMA_VERSION {
            return Err(format!(
                "记录版本 {} 暂不支持，请升级应用",
                record.schema_version
            ));
        }
        if record.id != id {
            return Err("记录内容与文件标识不一致".into());
        }
        Ok(record)
    }

    fn write_record(&self, record: &LibraryRecord) -> Result<(), String> {
        let bytes =
            serde_json::to_vec_pretty(record).map_err(|e| format!("记录序列化失败：{e}"))?;
        atomic_write(&self.record_path(&record.id)?, &bytes)
    }

    pub fn get(&self, id: &str) -> Result<LibraryRecord, String> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| "资料仓库暂不可用，请重启应用")?;
        self.read_record(id)
    }

    pub fn list(&self, query: Option<&str>) -> Result<Vec<LibrarySummary>, String> {
        Ok(self.browse(query)?.records)
    }

    pub fn browse(&self, query: Option<&str>) -> Result<LibraryListing, String> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| "资料仓库暂不可用，请重启应用")?;
        let query = query.unwrap_or("").trim().to_lowercase();
        let mut records = Vec::new();
        let mut hits = Vec::new();
        let mut issues = Vec::new();
        for entry in
            fs::read_dir(self.root.join("records")).map_err(|e| format!("读取资料列表失败：{e}"))?
        {
            let entry = entry.map_err(|e| format!("读取资料列表失败：{e}"))?;
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or("记录文件名无效")?;
            let record = match self.read_record(id) {
                Ok(record) => record,
                Err(error) => {
                    issues.push(LibraryReadIssue {
                        id: id.into(),
                        error,
                    });
                    continue;
                }
            };
            let mut record_hits = Vec::new();
            if !query.is_empty() {
                for entry in &record.segments {
                    let candidates = [
                        ("原文", entry.segment.text.as_str()),
                        ("译文", entry.segment.translation.as_deref().unwrap_or("")),
                        ("笔记", entry.note.as_str()),
                    ];
                    if let Some((field, excerpt)) = candidates.iter().find_map(|(field, text)| {
                        search_excerpt(text, &query).map(|excerpt| (*field, excerpt))
                    }) {
                        record_hits.push(LibrarySearchHit {
                            record_id: record.id.clone(),
                            segment_id: entry.segment.id.clone(),
                            start_ms: entry.segment.start_ms,
                            field: field.into(),
                            excerpt,
                        });
                        if record_hits.len() == 3 {
                            break;
                        }
                    }
                }
            }
            let matches = query.is_empty()
                || record.title.to_lowercase().contains(&query)
                || record.source.label.to_lowercase().contains(&query)
                || !record_hits.is_empty();
            if matches {
                hits.extend(record_hits);
                records.push(LibrarySummary::from(record));
            }
        }
        records.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        issues.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(LibraryListing {
            records,
            hits,
            issues,
        })
    }

    pub fn create_record(
        &self,
        title: String,
        source: LibrarySource,
        segments: Vec<TranscriptSegment>,
    ) -> Result<LibraryRecord, String> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| "资料仓库暂不可用，请重启应用")?;
        self.create_unlocked(title, source, segments)
    }

    fn create_unlocked(
        &self,
        title: String,
        source: LibrarySource,
        segments: Vec<TranscriptSegment>,
    ) -> Result<LibraryRecord, String> {
        validate_segments(&segments)?;
        let timestamp = now_ms();
        let record = LibraryRecord {
            schema_version: SCHEMA_VERSION,
            revision: 1,
            id: uuid::Uuid::new_v4().to_string(),
            title: nonempty(title, "标题")?,
            created_at: timestamp,
            updated_at: timestamp,
            source,
            segments: segments
                .into_iter()
                .filter(|s| s.is_persistable())
                .map(|s| new_segment(s, VersionOrigin::Asr, timestamp))
                .collect(),
        };
        self.write_record(&record)?;
        Ok(record)
    }

    fn update(
        &self,
        id: &str,
        change: impl FnOnce(&mut LibraryRecord) -> Result<(), String>,
    ) -> Result<LibraryRecord, String> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| "资料仓库暂不可用，请重启应用")?;
        let mut record = self.read_record(id)?;
        change(&mut record)?;
        touch(&mut record);
        self.write_record(&record)?;
        Ok(record)
    }

    pub fn rename(&self, id: &str, title: String) -> Result<LibraryRecord, String> {
        let title = nonempty(title, "标题")?;
        self.update(id, |record| {
            record.title = title;
            Ok(())
        })
    }

    pub fn update_source(
        &self,
        id: &str,
        label: String,
        url: Option<String>,
        source_lang: Option<String>,
    ) -> Result<LibraryRecord, String> {
        let label = nonempty(label, "来源名称")?;
        if source_lang
            .as_deref()
            .is_some_and(|language| !matches!(language, "en" | "zh"))
        {
            return Err("原文语言仅支持英语或中文".into());
        }
        self.update(id, |record| {
            record.source.label = label;
            if let Some(url) = url {
                record.source.url = (!url.trim().is_empty()).then(|| url.trim().to_owned());
            }
            if let Some(language) = source_lang {
                if record.source.source_lang.as_deref() != Some(language.as_str()) {
                    let timestamp = now_ms();
                    for entry in &mut record.segments {
                        entry.source_revision = entry.source_revision.saturating_add(1);
                        entry.segment.revision = entry.segment.revision.saturating_add(1);
                        if entry.segment.translation.is_some()
                            || entry.segment.translation_state == TranslationState::Pending
                        {
                            entry.segment.translation_state = TranslationState::Failed;
                            entry.segment.translation_error =
                                Some("原文语言已更改，请重新翻译；现有译文已保留供核对。".into());
                        }
                        entry
                            .versions
                            .push(version(entry, VersionOrigin::User, timestamp));
                    }
                }
                record.source.source_lang = Some(language);
            }
            Ok(())
        })
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| "资料仓库暂不可用，请重启应用")?;
        fs::remove_file(self.record_path(id)?).map_err(|e| format!("删除记录失败：{e}"))
    }

    pub fn save_live(
        &self,
        id: Option<&str>,
        title: String,
        source: LibrarySource,
        segments: Vec<TranscriptSegment>,
    ) -> Result<LibraryRecord, String> {
        if source.kind != LibrarySourceKind::Live {
            return Err("实时保存只接受当前会话来源".into());
        }
        validate_segments(&segments)?;
        let _guard = self
            .access
            .lock()
            .map_err(|_| "资料仓库暂不可用，请重启应用")?;
        let Some(id) = id else {
            return self.create_unlocked(title, source, segments);
        };
        let mut record = self.read_record(id)?;
        if record.source.kind != LibrarySourceKind::Live {
            return Err("不能用实时会话覆盖导入资料".into());
        }
        if record.source.id.is_some() && record.source.id != source.id {
            return Err("会话来源已变化，未覆盖原记录".into());
        }
        if record.source.source_lang.is_some() && record.source.source_lang != source.source_lang {
            return Err("记录的原文语言已改变，请将当前转写另存为新记录".into());
        }
        let mut changed = false;
        for incoming in segments.into_iter().filter(|s| s.is_persistable()) {
            if let Some(saved) = record
                .segments
                .iter_mut()
                .find(|s| s.segment.id == incoming.id)
            {
                if incoming.revision <= saved.live_revision {
                    continue;
                }
                saved.live_revision = incoming.revision;
                changed = true;
                if saved.source_edited
                    || (saved.translation_edited && incoming.text != saved.segment.text)
                {
                    continue;
                }
                let before = saved.segment.clone();
                if incoming.text != saved.segment.text {
                    saved.source_revision = saved.source_revision.saturating_add(1);
                    saved.segment.text = incoming.text;
                }
                saved.segment.start_ms = incoming.start_ms;
                saved.segment.end_ms = incoming.end_ms;
                if !saved.translation_edited {
                    saved.segment.translation = incoming.translation;
                    saved.segment.translation_state = incoming.translation_state;
                    saved.segment.translation_error = incoming.translation_error;
                }
                if saved.segment != before {
                    commit_segment(saved, VersionOrigin::Live);
                }
            } else {
                record
                    .segments
                    .push(new_segment(incoming, VersionOrigin::Live, now_ms()));
                changed = true;
            }
        }
        if changed {
            touch(&mut record);
            self.write_record(&record)?;
        }
        Ok(record)
    }

    pub fn update_segment(
        &self,
        id: &str,
        segment_id: &str,
        patch: SegmentPatch,
    ) -> Result<LibraryRecord, String> {
        if patch.text.is_none()
            && patch.translation.is_none()
            && patch.note.is_none()
            && patch.bookmarked.is_none()
        {
            return Err("没有要保存的段落修改".into());
        }
        self.update(id, |record| {
            let saved = record
                .segments
                .iter_mut()
                .find(|s| s.segment.id == segment_id)
                .ok_or("未找到该段落")?;
            if saved.segment.revision != patch.expected_revision {
                return Err("段落已变化，请重新打开后再保存".into());
            }
            if let Some(text) = patch.text {
                let text = nonempty(text, "原文")?;
                if text != saved.segment.text {
                    saved.source_revision = saved.source_revision.saturating_add(1);
                    saved.segment.text = text;
                    saved.segment.translation = None;
                    saved.segment.translation_state = TranslationState::Idle;
                    saved.segment.translation_error = None;
                    saved.translation_edited = false;
                }
                saved.source_edited = true;
                saved.segment.state = SegmentState::Edited;
            }
            if let Some(text) = patch.translation {
                saved.segment.translation =
                    (!text.trim().is_empty()).then(|| text.trim().to_owned());
                saved.segment.translation_state = if saved.segment.translation.is_some() {
                    TranslationState::Done
                } else {
                    TranslationState::Idle
                };
                saved.segment.translation_error = None;
                saved.translation_edited = true;
            }
            if let Some(note) = patch.note {
                saved.note = note;
            }
            commit_segment(saved, VersionOrigin::User);
            if let Some(bookmarked) = patch.bookmarked {
                if bookmarked && !saved.bookmarked {
                    saved.bookmark_version = Some(saved.segment.revision);
                }
                if !bookmarked {
                    saved.bookmark_version = None;
                }
                saved.bookmarked = bookmarked;
            }
            Ok(())
        })
    }

    pub fn restore_version(
        &self,
        id: &str,
        segment_id: &str,
        version_revision: u32,
        expected_revision: u32,
    ) -> Result<LibraryRecord, String> {
        self.update(id, |record| {
            let saved = record
                .segments
                .iter_mut()
                .find(|s| s.segment.id == segment_id)
                .ok_or("未找到该段落")?;
            if saved.segment.revision != expected_revision {
                return Err("段落已变化，请重新打开后再恢复".into());
            }
            let old = saved
                .versions
                .iter()
                .find(|v| v.revision == version_revision)
                .cloned()
                .ok_or("未找到该历史版本")?;
            if old.text != saved.segment.text {
                saved.source_revision = saved.source_revision.saturating_add(1);
            }
            saved.segment.text = old.text;
            saved.segment.translation = old.translation;
            saved.segment.translation_state = old.translation_state;
            saved.segment.translation_error = old.translation_error;
            saved.segment.state = SegmentState::Edited;
            saved.source_edited = true;
            saved.translation_edited = true;
            commit_segment(saved, VersionOrigin::Restore);
            Ok(())
        })
    }

    pub fn set_translation(
        &self,
        id: &str,
        segment_id: &str,
        expected_source_revision: u32,
        expected_revision: u32,
        translation: String,
    ) -> Result<LibraryRecord, String> {
        self.apply_translation(
            id,
            segment_id,
            expected_source_revision,
            expected_revision,
            Ok(translation),
        )
    }

    pub fn set_translation_error(
        &self,
        id: &str,
        segment_id: &str,
        expected_source_revision: u32,
        expected_revision: u32,
        error: String,
    ) -> Result<LibraryRecord, String> {
        self.apply_translation(
            id,
            segment_id,
            expected_source_revision,
            expected_revision,
            Err(error),
        )
    }

    fn apply_translation(
        &self,
        id: &str,
        segment_id: &str,
        expected_source_revision: u32,
        expected_revision: u32,
        result: Result<String, String>,
    ) -> Result<LibraryRecord, String> {
        self.update(id, |record| {
            let saved = record
                .segments
                .iter_mut()
                .find(|s| s.segment.id == segment_id)
                .ok_or("未找到该段落")?;
            if saved.source_revision != expected_source_revision
                || saved.segment.revision != expected_revision
            {
                return Err("原文或修订已变化，未采用过期翻译结果".into());
            }
            match result {
                Ok(text) => {
                    saved.segment.translation = Some(nonempty(text, "译文")?);
                    saved.segment.translation_state = TranslationState::Done;
                    saved.segment.translation_error = None;
                }
                Err(error) => {
                    saved.segment.translation = None;
                    saved.segment.translation_state = TranslationState::Failed;
                    saved.segment.translation_error = Some(error);
                }
            }
            saved.translation_edited = true;
            commit_segment(saved, VersionOrigin::Machine);
            Ok(())
        })
    }

    fn read_terms(&self) -> Result<Vec<Term>, String> {
        let bytes = match fs::read(self.root.join("terms.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("读取术语表失败：{error}")),
        };
        let file: TermsFile = serde_json::from_slice(&bytes)
            .map_err(|e| format!("术语表无法读取，原文件已保留：{e}"))?;
        if file.schema_version != SCHEMA_VERSION {
            return Err("术语表版本暂不支持，请升级应用".into());
        }
        Ok(file.terms)
    }

    fn write_terms(&self, terms: Vec<Term>) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(&TermsFile {
            schema_version: SCHEMA_VERSION,
            terms,
        })
        .map_err(|e| format!("术语序列化失败：{e}"))?;
        atomic_write(&self.root.join("terms.json"), &bytes)
    }

    pub fn terms(&self) -> Result<Vec<Term>, String> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| "资料仓库暂不可用，请重启应用")?;
        let mut terms = self.read_terms()?;
        terms.sort_by(|a, b| a.source.to_lowercase().cmp(&b.source.to_lowercase()));
        Ok(terms)
    }

    pub fn term_suggestions(
        &self,
        id: &str,
        segment_ids: Option<&[String]>,
    ) -> Result<Vec<TermSuggestion>, String> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| "资料仓库暂不可用，请重启应用")?;
        let record = self.read_record(id)?;
        let terms = self.read_terms()?;
        if segment_ids.is_some_and(|ids| {
            ids.iter()
                .any(|id| !record.segments.iter().any(|entry| entry.segment.id == *id))
        }) {
            return Err("选中的部分段落已不存在，请刷新记录".into());
        }
        Ok(record
            .segments
            .iter()
            .filter(|entry| segment_ids.is_none_or(|ids| ids.contains(&entry.segment.id)))
            .flat_map(|entry| terms.iter().filter_map(|term| term_suggestion(entry, term)))
            .collect())
    }

    pub fn apply_term(
        &self,
        id: &str,
        segment_id: &str,
        term_id: &str,
        expected_revision: u32,
        expected_term_updated_at: u64,
    ) -> Result<LibraryRecord, String> {
        self.update(id, |record| {
            let term = self
                .read_terms()?
                .into_iter()
                .find(|term| term.id == term_id)
                .ok_or("该术语已删除，请重新生成建议")?;
            if term.updated_at != expected_term_updated_at {
                return Err("术语已变化，请重新生成并核对建议后再应用".into());
            }
            let saved = record
                .segments
                .iter_mut()
                .find(|entry| entry.segment.id == segment_id)
                .ok_or("未找到该段落")?;
            if saved.segment.revision != expected_revision {
                return Err("段落已变化，请重新查看术语建议后再应用".into());
            }
            let suggestion = term_suggestion(saved, &term)
                .ok_or("当前段落已不符合该建议，请重新查看术语建议")?;
            saved.segment.translation = Some(suggestion.suggested_translation);
            saved.segment.translation_error = None;
            saved.translation_edited = true;
            commit_segment(saved, VersionOrigin::User);
            Ok(())
        })
    }

    pub fn upsert_term(&self, input: TermInput) -> Result<Term, String> {
        let _guard = self
            .access
            .lock()
            .map_err(|_| "资料仓库暂不可用，请重启应用")?;
        let mut terms = self.read_terms()?;
        let source = nonempty(input.source, "术语原文")?;
        let target = nonempty(input.target, "术语释义")?;
        let timestamp = now_ms();
        let term = if let Some(id) = input.id {
            valid_id(&id)?;
            let old = terms.iter().find(|t| t.id == id).ok_or("未找到该术语")?;
            Term {
                id,
                source,
                target,
                note: input.note,
                created_at: old.created_at,
                updated_at: timestamp.max(old.updated_at.saturating_add(1)),
            }
        } else {
            Term {
                id: uuid::Uuid::new_v4().to_string(),
                source,
                target,
                note: input.note,
                created_at: timestamp,
                updated_at: timestamp,
            }
        };
        terms.retain(|t| t.id != term.id);
        terms.push(term.clone());
        self.write_terms(terms)?;
        Ok(term)
    }

    pub fn delete_term(&self, id: &str) -> Result<(), String> {
        valid_id(id)?;
        let _guard = self
            .access
            .lock()
            .map_err(|_| "资料仓库暂不可用，请重启应用")?;
        let mut terms = self.read_terms()?;
        let count = terms.len();
        terms.retain(|term| term.id != id);
        if terms.len() == count {
            return Err("未找到该术语".into());
        }
        self.write_terms(terms)
    }
}
