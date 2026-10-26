use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::model::*;
use super::repository::{atomic_write, Repository};
use crate::transcript::{TranscriptSegment, TranslationState};

fn clipped(text: &str, limit: usize) -> String {
    let first = text
        .split(['\n', '。', '！', '？'])
        .find(|part| !part.trim().is_empty())
        .unwrap_or(text)
        .trim();
    let title: String = first.chars().take(limit).collect();
    if first.chars().count() > limit {
        format!("{title}…")
    } else {
        title
    }
}

pub fn analyze(record: &LibraryRecord) -> LibraryAnalysis {
    let mut chapters: Vec<LibraryChapter> = Vec::new();
    let mut points = Vec::new();
    for item in &record.segments {
        let segment = &item.segment;
        if segment.text.trim().is_empty() {
            continue;
        }
        let new_chapter = chapters.last().is_none_or(|chapter| {
            chapter.segment_ids.len() >= 8
                || segment.start_ms.saturating_sub(chapter.start_ms) >= 300_000
        });
        if new_chapter {
            chapters.push(LibraryChapter {
                title: clipped(&segment.text, 36),
                start_ms: segment.start_ms,
                end_ms: segment.end_ms,
                segment_ids: vec![segment.id.clone()],
            });
            points.push(LibraryPoint {
                text: segment.text.clone(),
                start_ms: segment.start_ms,
                end_ms: segment.end_ms,
                segment_ids: vec![segment.id.clone()],
            });
        } else if let Some(chapter) = chapters.last_mut() {
            chapter.end_ms = chapter.end_ms.max(segment.end_ms);
            chapter.segment_ids.push(segment.id.clone());
        }
    }
    LibraryAnalysis {
        method: "extractive".into(),
        notice: "本地原文摘录：按最多 8 段或 5 分钟分组，标题取组首原文，摘录取组首完整段落；没有生成或推断新结论。".into(),
        chapters,
        points,
    }
}

fn query_terms(question: &str) -> HashSet<String> {
    let text = question.to_lowercase();
    let mut terms: HashSet<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|part| {
            part.chars().count() >= 2
                && ![
                    "what", "which", "how", "why", "about", "the", "does", "this", "that",
                    "please", "and", "are", "was", "with", "could", "you", "tell", "have", "can",
                    "for", "from", "into", "is",
                ]
                .contains(part)
        })
        .map(str::to_owned)
        .collect();
    let chars: Vec<char> = text.chars().collect();
    for pair in chars.windows(2) {
        if pair.iter().all(|c| !c.is_ascii() && c.is_alphanumeric()) {
            let term: String = pair.iter().collect();
            if ![
                "什么",
                "如何",
                "为什么",
                "怎么",
                "哪些",
                "请问",
                "这个",
                "那个",
                "的是",
            ]
            .contains(&term.as_str())
            {
                terms.insert(term);
            }
        }
    }
    terms
}

pub fn ask(record: &LibraryRecord, question: &str) -> Result<LibraryAnswer, String> {
    if question.trim().is_empty() {
        return Err("请输入要查找的问题或关键词".into());
    }
    let terms = query_terms(question);
    let mut hits = record
        .segments
        .iter()
        .filter_map(|item| {
            let segment = &item.segment;
            let haystack = format!(
                "{}\n{}",
                segment.text,
                segment.translation.as_deref().unwrap_or("")
            )
            .to_lowercase();
            let score = terms
                .iter()
                .filter(|term| haystack.contains(term.as_str()))
                .count();
            (score > 0).then_some((score, segment))
        })
        .collect::<Vec<_>>();
    hits.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.start_ms.cmp(&b.1.start_ms)));
    let evidence: Vec<LibraryEvidence> = hits
        .into_iter()
        .take(4)
        .map(|(_, segment)| LibraryEvidence {
            segment_id: segment.id.clone(),
            start_ms: segment.start_ms,
            end_ms: segment.end_ms,
            text: segment.text.clone(),
            translation: (segment.translation_state == TranslationState::Done)
                .then(|| segment.translation.clone())
                .flatten(),
        })
        .collect();
    let answer = if evidence.is_empty() {
        "没有找到与这些关键词匹配的原文；请换用资料中的具体词语。此功能仅检索原文，不生成推断性回答。".into()
    } else {
        format!(
            "以下是关键词匹配的原文摘录，并非模型生成的回答：\n\n{}",
            evidence
                .iter()
                .map(|item| format!("[{}] {}", clock(item.start_ms), item.text))
                .collect::<Vec<_>>()
                .join("\n\n")
        )
    };
    Ok(LibraryAnswer {
        method: "extractive".into(),
        answer,
        evidence,
    })
}

fn clock(ms: u64) -> String {
    let seconds = ms / 1000;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    )
}

fn subtitle_clock(ms: u64, separator: char) -> String {
    format!("{}{}{:03}", clock(ms), separator, ms % 1000)
}

fn selected_segments(
    record: &LibraryRecord,
    ids: Option<&[String]>,
    bookmark_versions: bool,
) -> Result<Vec<TranscriptSegment>, String> {
    if let Some(ids) = ids {
        if ids.is_empty() {
            return Err("请先选择要导出的段落".into());
        }
        if ids
            .iter()
            .any(|id| !record.segments.iter().any(|s| s.segment.id == *id))
        {
            return Err("选中的部分段落已不存在，请刷新后再导出".into());
        }
    }
    let mut selected = Vec::new();
    for item in &record.segments {
        if ids.is_some_and(|ids| !ids.contains(&item.segment.id)) {
            continue;
        }
        let mut segment = item.segment.clone();
        if bookmark_versions && item.bookmarked {
            let revision = item
                .bookmark_version
                .ok_or("标记缺少版本信息，请重新打开记录")?;
            let old = item
                .versions
                .iter()
                .find(|v| v.revision == revision)
                .ok_or("未找到标记时的内容版本")?;
            segment.text = old.text.clone();
            segment.translation = old.translation.clone();
            segment.translation_state = old.translation_state;
            segment.translation_error = old.translation_error.clone();
        }
        selected.push(segment);
    }
    if selected.is_empty() {
        return Err("记录中没有可导出的定稿内容".into());
    }
    Ok(selected)
}

pub fn render_export(
    record: &LibraryRecord,
    format: &str,
    ids: Option<&[String]>,
    bookmark_versions: bool,
) -> Result<String, String> {
    let segments = selected_segments(record, ids, bookmark_versions)?;
    if format == "markdown" {
        let mut text = format!(
            "# {}\n\n- 来源：{}\n- 时间基准：{}\n",
            record.title,
            record.source.label,
            if record.source.kind == LibrarySourceKind::Live {
                "本次会话经过时间；未绑定原播放器进度"
            } else {
                "导入媒体或字幕的时间位置"
            }
        );
        if let Some(url) = &record.source.url {
            text.push_str(&format!("- 来源链接：{}\n", url.replace(['\n', '\r'], " ")));
        }
        text.push_str("\n---\n\n");
        for segment in segments {
            text.push_str(&format!(
                "**[{}]** {}\n\n",
                clock(segment.start_ms),
                segment.text
            ));
            if segment.translation_state == TranslationState::Done {
                if let Some(translation) = &segment.translation {
                    text.push_str(&format!("> {}\n\n", translation.replace('\n', "\n> ")));
                }
            }
            if let Some(item) = record
                .segments
                .iter()
                .find(|item| item.segment.id == segment.id)
            {
                if !item.note.trim().is_empty() {
                    text.push_str(&format!("笔记：{}\n\n", item.note));
                }
            }
        }
        return Ok(text);
    }
    if format != "srt" && format != "vtt" {
        return Err("导出格式仅支持 markdown、srt 或 vtt".into());
    }
    let mut text = if format == "vtt" {
        String::from("WEBVTT\n\n")
    } else {
        String::new()
    };
    let separator = if format == "vtt" { '.' } else { ',' };
    for (index, segment) in segments.iter().enumerate() {
        if segment.end_ms <= segment.start_ms {
            return Err("段落时长为零，无法生成有效字幕；可改用 Markdown 导出".into());
        }
        text.push_str(&format!(
            "{}\n{} --> {}\n{}\n",
            index + 1,
            subtitle_clock(segment.start_ms, separator),
            subtitle_clock(segment.end_ms, separator),
            segment.text
        ));
        if segment.translation_state == TranslationState::Done {
            if let Some(translation) = &segment.translation {
                text.push_str(translation);
                text.push('\n');
            }
        }
        text.push('\n');
    }
    Ok(text)
}

impl Repository {
    pub fn export(
        &self,
        id: &str,
        path: &Path,
        format: &str,
        segment_ids: Option<&[String]>,
        bookmark_versions: bool,
    ) -> Result<PathBuf, String> {
        let record = self.get(id)?;
        let text = render_export(&record, format, segment_ids, bookmark_versions)?;
        atomic_write(path, text.as_bytes())?;
        Ok(path.to_path_buf())
    }
}
