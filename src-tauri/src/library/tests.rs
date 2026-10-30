use std::sync::{Arc, Barrier};

use super::*;
use crate::transcript::{SegmentState, TranscriptSegment, TranslationState};

fn repository() -> Repository {
    Repository::new(
        std::env::temp_dir().join(format!("audioscript-library-{}", uuid::Uuid::new_v4())),
    )
    .unwrap()
}

fn source() -> LibrarySource {
    LibrarySource {
        kind: LibrarySourceKind::Live,
        label: "技术课程".into(),
        url: Some("https://example.com/course".into()),
        id: Some("session-test".into()),
        media_path: None,
        pcm_path: None,
        duration_ms: Some(1000),
        derived_from_id: None,
        source_lang: Some("en".into()),
    }
}

fn segment(id: &str, text: &str, revision: u32) -> TranscriptSegment {
    TranscriptSegment {
        id: id.into(),
        start_ms: 200,
        end_ms: 1000,
        text: text.into(),
        translation: Some("数据库事务".into()),
        translation_state: TranslationState::Done,
        translation_error: None,
        state: SegmentState::Final,
        revision,
    }
}

fn patch(revision: u32) -> SegmentPatch {
    SegmentPatch {
        expected_revision: revision,
        text: None,
        translation: None,
        note: None,
        bookmarked: None,
    }
}

#[test]
fn records_reopen_and_search_actual_final_text_without_persisting_partials() {
    let repo = repository();
    let mut partial = segment("partial", "不能保存的未定稿", 1);
    partial.state = SegmentState::Partial;
    let record = repo
        .create_record(
            "数据库学习".into(),
            source(),
            vec![segment("one", "Database transactions", 7), partial],
        )
        .unwrap();
    assert_eq!(record.segments.len(), 1);
    assert_eq!(record.segments[0].segment.revision, 1);
    assert_eq!(record.segments[0].live_revision, 7);
    assert_eq!(record.segments[0].versions[0].text, "Database transactions");
    let reopened = Repository::new(repo.root().to_path_buf()).unwrap();
    assert_eq!(reopened.get(&record.id).unwrap(), record);
    assert_eq!(reopened.list(Some("transactions")).unwrap().len(), 1);
    assert_eq!(reopened.list(Some("事务")).unwrap().len(), 1);
    assert!(reopened.list(Some("不存在的词语")).unwrap().is_empty());
    std::fs::write(
        repo.root().join("records").join(".unfinished.tmp"),
        b"incomplete",
    )
    .unwrap();
    assert_eq!(reopened.list(None).unwrap().len(), 1);
}

#[test]
fn source_label_edits_preserve_language_media_and_unspecified_link() {
    let repo = repository();
    let record = repo
        .create_record("来源".into(), source(), Vec::new())
        .unwrap();
    let renamed = repo
        .update_source(&record.id, "新来源名称".into(), None, None)
        .unwrap();
    assert_eq!(renamed.source.url, record.source.url);
    assert_eq!(renamed.source.source_lang.as_deref(), Some("en"));
    let cleared = repo
        .update_source(&record.id, "新来源名称".into(), Some(String::new()), None)
        .unwrap();
    assert!(cleared.source.url.is_none());
    assert_eq!(cleared.source.id, record.source.id);
    let changed = repo
        .update_source(&record.id, "中文资料".into(), None, Some("zh".into()))
        .unwrap();
    assert_eq!(changed.source.source_lang.as_deref(), Some("zh"));
    assert!(repo
        .update_source(&record.id, "无效".into(), None, Some("xx".into()))
        .is_err());
    assert_eq!(repo.get(&record.id).unwrap(), changed);
}

#[test]
fn damaged_and_future_records_do_not_hide_readable_records_or_get_overwritten() {
    let repo = repository();
    let good = repo
        .create_record("可读取".into(), source(), vec![segment("one", "hello", 1)])
        .unwrap();
    let broken_id = uuid::Uuid::new_v4().to_string();
    let broken_path = repo
        .root()
        .join("records")
        .join(format!("{broken_id}.json"));
    std::fs::write(&broken_path, b"{broken").unwrap();
    let mut future = good.clone();
    future.id = uuid::Uuid::new_v4().to_string();
    future.schema_version = 100;
    let future_path = repo
        .root()
        .join("records")
        .join(format!("{}.json", future.id));
    std::fs::write(&future_path, serde_json::to_vec(&future).unwrap()).unwrap();
    let listing = repo.browse(None).unwrap();
    assert_eq!(listing.records.len(), 1);
    assert_eq!(listing.records[0].id, good.id);
    assert_eq!(listing.issues.len(), 2);
    assert_eq!(std::fs::read(broken_path).unwrap(), b"{broken");
    assert!(future_path.exists());
    assert!(repo.get(&broken_id).is_err());
}

#[test]
fn source_language_change_rejects_inflight_translations_and_preserves_previous_text() {
    let repo = repository();
    let record = repo
        .create_record(
            "方向切换".into(),
            source(),
            vec![segment("one", "中文原文", 1)],
        )
        .unwrap();
    let original = &record.segments[0];
    let changed = repo
        .update_source(&record.id, "课程".into(), None, Some("zh".into()))
        .unwrap();
    assert!(repo
        .set_translation(
            &record.id,
            "one",
            original.source_revision,
            original.segment.revision,
            "旧方向结果".into()
        )
        .is_err());
    assert_eq!(
        changed.segments[0].segment.translation,
        original.segment.translation
    );
    assert_eq!(
        changed.segments[0].segment.translation_state,
        TranslationState::Failed
    );
    let current = &changed.segments[0];
    let translated = repo
        .set_translation(
            &record.id,
            "one",
            current.source_revision,
            current.segment.revision,
            "Chinese original".into(),
        )
        .unwrap();
    assert_eq!(
        translated.segments[0].segment.translation.as_deref(),
        Some("Chinese original")
    );
    assert!(repo
        .save_live(
            Some(&record.id),
            "旧会话".into(),
            source(),
            vec![segment("one", "旧方向翻译", 9)]
        )
        .is_err());
    assert_eq!(repo.get(&record.id).unwrap(), translated);
}

#[test]
fn library_search_returns_bounded_context_and_real_segment_targets() {
    let repo = repository();
    let record = repo
        .create_record(
            "搜索".into(),
            source(),
            vec![
                segment(
                    "one",
                    &format!("{}İSTANBUL{}", "前文".repeat(100), "后文".repeat(100)),
                    1,
                ),
                segment("two", "second", 1),
            ],
        )
        .unwrap();
    let result = repo.browse(Some("İstanbul")).unwrap();
    assert_eq!(result.records.len(), 1);
    assert_eq!(result.hits.len(), 1);
    let hit = &result.hits[0];
    assert_eq!(hit.record_id, record.id);
    assert_eq!(hit.segment_id, "one");
    assert_eq!(hit.start_ms, 200);
    assert!(hit.excerpt.contains("İSTANBUL"));
    assert!(hit.excerpt.chars().count() <= 162);
    let mut change = patch(1);
    change.note = Some("以后复习内存问题".into());
    repo.update_segment(&record.id, "two", change).unwrap();
    let note = repo.browse(Some("复习")).unwrap();
    assert_eq!(note.hits[0].segment_id, "two");
    assert_eq!(note.hits[0].field, "笔记");
    assert_eq!(repo.browse(Some("事务")).unwrap().hits[0].field, "译文");
    assert!(repo.browse(None).unwrap().hits.is_empty());
}

#[test]
fn live_snapshots_preserve_manual_source_translation_title_and_notes() {
    let repo = repository();
    let record = repo
        .save_live(
            None,
            "第一次标题".into(),
            source(),
            vec![segment("one", "Original text", 1)],
        )
        .unwrap();
    let record = repo.rename(&record.id, "人工标题".into()).unwrap();
    let mut edit = patch(1);
    edit.text = Some("人工校正原文".into());
    edit.translation = Some("人工校正译文".into());
    edit.note = Some("关键概念".into());
    let record = repo.update_segment(&record.id, "one", edit).unwrap();
    let updated = repo
        .save_live(
            Some(&record.id),
            "旧标题".into(),
            source(),
            vec![
                segment("one", "Late old text", 8),
                segment("two", "New final", 1),
            ],
        )
        .unwrap();
    assert_eq!(updated.title, "人工标题");
    assert_eq!(updated.segments[0].segment.text, "人工校正原文");
    assert_eq!(
        updated.segments[0].segment.translation.as_deref(),
        Some("人工校正译文")
    );
    assert_eq!(updated.segments[0].note, "关键概念");
    assert_eq!(updated.segments.len(), 2);
    repo.delete(&record.id).unwrap();
    assert!(repo
        .save_live(
            Some(&record.id),
            "不应复活".into(),
            source(),
            vec![segment("one", "迟到结果", 9)]
        )
        .is_err());
}

#[test]
fn machine_results_require_both_versions_and_do_not_mutate_rejected_history() {
    let repo = repository();
    let record = repo
        .create_record(
            "版本保护".into(),
            source(),
            vec![segment("one", "Before", 1)],
        )
        .unwrap();
    let mut edit = patch(1);
    edit.text = Some("After".into());
    let record = repo.update_segment(&record.id, "one", edit).unwrap();
    assert_eq!(record.segments[0].source_revision, 2);
    assert_eq!(
        record.segments[0].segment.translation_state,
        TranslationState::Idle
    );
    assert!(repo
        .set_translation(&record.id, "one", 1, 1, "过期结果".into())
        .is_err());
    assert_eq!(repo.get(&record.id).unwrap(), record);
    let translated = repo
        .set_translation(&record.id, "one", 2, 2, "新的译文".into())
        .unwrap();
    assert_eq!(
        translated.segments[0].segment.translation.as_deref(),
        Some("新的译文")
    );
    assert!(repo
        .set_translation_error(&record.id, "one", 2, 2, "迟到失败".into())
        .is_err());
    assert_eq!(repo.get(&record.id).unwrap(), translated);
    assert_eq!(translated.segments[0].versions[0].text, "Before");
    assert_eq!(translated.segments[0].versions[1].text, "After");
}

#[test]
fn explicit_translation_survives_later_live_snapshots_with_old_results() {
    let repo = repository();
    let record = repo
        .save_live(
            None,
            "译文修订".into(),
            source(),
            vec![segment("one", "Same source", 1)],
        )
        .unwrap();
    let record = repo
        .set_translation(&record.id, "one", 1, 1, "用户请求的新译文".into())
        .unwrap();
    let late = repo
        .save_live(
            Some(&record.id),
            "旧标题".into(),
            source(),
            vec![segment("one", "Same source", 9)],
        )
        .unwrap();
    assert_eq!(
        late.segments[0].segment.translation.as_deref(),
        Some("用户请求的新译文")
    );
    let mismatched = repo
        .save_live(
            Some(&record.id),
            "旧标题".into(),
            source(),
            vec![segment("one", "Changed source from a late snapshot", 10)],
        )
        .unwrap();
    assert_eq!(mismatched.segments[0].segment.text, "Same source");
    assert_eq!(
        mismatched.segments[0].segment.translation.as_deref(),
        Some("用户请求的新译文")
    );
}

#[test]
fn bookmarks_export_the_original_snapshot_after_edits_and_history_restore_appends() {
    let repo = repository();
    let record = repo
        .create_record(
            "不可变摘录".into(),
            source(),
            vec![segment("one", "Original quote", 1)],
        )
        .unwrap();
    let mut bookmark = patch(1);
    bookmark.bookmarked = Some(true);
    bookmark.note = Some("我的笔记".into());
    let record = repo.update_segment(&record.id, "one", bookmark).unwrap();
    let bookmark_version = record.segments[0].bookmark_version.unwrap();
    let original_versions = record.segments[0].versions.clone();
    let mut edit = patch(2);
    edit.text = Some("Revised quote".into());
    let edited = repo.update_segment(&record.id, "one", edit).unwrap();
    assert_eq!(edited.segments[0].bookmark_version, Some(bookmark_version));
    assert_eq!(
        &edited.segments[0].versions[..original_versions.len()],
        &original_versions
    );
    let ids = vec!["one".into()];
    let excerpt = render_export(&edited, "markdown", Some(&ids), true).unwrap();
    assert!(excerpt.contains("Original quote"));
    assert!(!excerpt.contains("Revised quote"));
    assert!(excerpt.contains("我的笔记"));
    let restored = repo.restore_version(&record.id, "one", 1, 3).unwrap();
    assert_eq!(restored.segments[0].segment.text, "Original quote");
    assert_eq!(
        restored.segments[0].versions.len(),
        edited.segments[0].versions.len() + 1
    );
    assert_eq!(restored.segments[0].source_revision, 3);
    assert_eq!(
        restored.segments[0].versions.last().unwrap().origin,
        VersionOrigin::Restore
    );
}

#[test]
fn concurrent_edits_from_the_same_revision_have_one_winner() {
    let repo = Arc::new(repository());
    let record = repo
        .create_record(
            "并发编辑".into(),
            source(),
            vec![segment("one", "Stable source", 1)],
        )
        .unwrap();
    let gate = Arc::new(Barrier::new(3));
    let handles = (0..2)
        .map(|number| {
            let repo = Arc::clone(&repo);
            let gate = Arc::clone(&gate);
            let id = record.id.clone();
            std::thread::spawn(move || {
                let mut change = patch(1);
                change.note = Some(format!("笔记{number}"));
                gate.wait();
                repo.update_segment(&id, "one", change).is_ok()
            })
        })
        .collect::<Vec<_>>();
    gate.wait();
    assert_eq!(
        handles
            .into_iter()
            .filter_map(|h| h.join().ok())
            .filter(|ok| *ok)
            .count(),
        1
    );
    assert_eq!(repo.get(&record.id).unwrap().segments[0].versions.len(), 2);
}

#[cfg(unix)]
#[test]
fn write_failure_does_not_commit_a_changed_title_or_damage_the_saved_record() {
    use std::os::unix::fs::PermissionsExt;
    let repo = repository();
    let record = repo
        .create_record(
            "原有标题".into(),
            source(),
            vec![segment("one", "Saved", 1)],
        )
        .unwrap();
    let directory = repo.root().join("records");
    let permissions = std::fs::metadata(&directory).unwrap().permissions();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o555)).unwrap();
    let result = repo.rename(&record.id, "不能提交的标题".into());
    std::fs::set_permissions(&directory, permissions).unwrap();
    assert!(result.is_err());
    assert_eq!(repo.get(&record.id).unwrap(), record);
    let recovered = repo.rename(&record.id, "恢复后保存".into()).unwrap();
    assert_eq!(recovered.title, "恢复后保存");
}

#[test]
fn corrupted_or_newer_records_are_preserved_and_never_replaced_by_defaults() {
    let repo = repository();
    let record = repo
        .create_record(
            "原记录".into(),
            source(),
            vec![segment("one", "Content", 1)],
        )
        .unwrap();
    let path = repo
        .root()
        .join("records")
        .join(format!("{}.json", record.id));
    std::fs::write(&path, b"{broken").unwrap();
    assert!(repo.get(&record.id).is_err());
    assert!(repo.rename(&record.id, "不应覆盖".into()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"{broken");
    let mut newer = record.clone();
    newer.schema_version = SCHEMA_VERSION + 1;
    std::fs::write(&path, serde_json::to_vec(&newer).unwrap()).unwrap();
    assert!(repo.get(&record.id).is_err());
    assert!(repo
        .save_live(Some(&record.id), "不应覆盖".into(), source(), Vec::new())
        .is_err());
}

#[test]
fn deletion_never_follows_source_paths_and_rejects_path_traversal() {
    let repo = repository();
    let external = repo.root().join("original-user-audio.wav");
    std::fs::write(&external, b"original audio").unwrap();
    let mut media = source();
    media.media_path = Some(external.display().to_string());
    let record = repo
        .create_record("只删除记录".into(), media, Vec::new())
        .unwrap();
    assert!(repo.delete("../original-user-audio.wav").is_err());
    assert!(repo.get("../terms").is_err());
    repo.delete(&record.id).unwrap();
    assert_eq!(std::fs::read(&external).unwrap(), b"original audio");
}

#[test]
fn terms_are_editable_persistent_and_do_not_replace_record_text() {
    let repo = repository();
    let record = repo
        .create_record("术语".into(), source(), vec![segment("one", "ACID", 1)])
        .unwrap();
    let term = repo
        .upsert_term(TermInput {
            id: None,
            source: "ACID".into(),
            target: "事务属性".into(),
            note: "人工核对".into(),
        })
        .unwrap();
    let edited = repo
        .upsert_term(TermInput {
            id: Some(term.id.clone()),
            source: "ACID".into(),
            target: "数据库事务属性".into(),
            note: "新版说明".into(),
        })
        .unwrap();
    let reopened = Repository::new(repo.root().to_path_buf()).unwrap();
    assert_eq!(reopened.terms().unwrap(), vec![edited]);
    assert_eq!(
        reopened.get(&record.id).unwrap().segments[0].segment.text,
        "ACID"
    );
    reopened.delete_term(&term.id).unwrap();
    assert!(reopened.terms().unwrap().is_empty());
}

#[test]
fn term_suggestions_require_whole_words_and_explicit_application_preserves_history() {
    let repo = repository();
    let mut first = segment("one", "RUST prevents races; Trust is different.", 1);
    first.translation = Some("Rust 防止竞态，Trust 是另一个词。".into());
    let mut substring = segment("two", "Trust matters.", 1);
    substring.translation = Some("Rust should not change here.".into());
    let mut already_fixed = segment("three", "Rust prevents races.", 1);
    already_fixed.translation = Some("Rust语言 防止竞态，Rust 仍出现在引文中。".into());
    let record = repo
        .create_record(
            "术语校正".into(),
            source(),
            vec![first, substring, already_fixed],
        )
        .unwrap();
    let term = repo
        .upsert_term(TermInput {
            id: None,
            source: "Rust".into(),
            target: "Rust语言".into(),
            note: String::new(),
        })
        .unwrap();
    let suggestions = repo.term_suggestions(&record.id, None).unwrap();
    assert_eq!(suggestions.len(), 1);
    assert_eq!(suggestions[0].segment_id, "one");
    assert_eq!(
        suggestions[0].suggested_translation,
        "Rust语言 防止竞态，Trust 是另一个词。"
    );
    let updated_term = repo
        .upsert_term(TermInput {
            id: Some(term.id.clone()),
            source: term.source.clone(),
            target: term.target.clone(),
            note: "更新核对说明".into(),
        })
        .unwrap();
    assert!(updated_term.updated_at > term.updated_at);
    assert!(repo
        .apply_term(&record.id, "one", &term.id, 1, term.updated_at)
        .is_err());
    let applied = repo
        .apply_term(&record.id, "one", &term.id, 1, updated_term.updated_at)
        .unwrap();
    assert_eq!(
        applied.segments[0].versions[0].translation.as_deref(),
        Some("Rust 防止竞态，Trust 是另一个词。")
    );
    assert_eq!(
        applied.segments[0].versions.last().unwrap().origin,
        VersionOrigin::User
    );
    assert!(repo
        .apply_term(&record.id, "one", &term.id, 1, updated_term.updated_at)
        .is_err());
    assert!(repo.term_suggestions(&record.id, None).unwrap().is_empty());
}

#[test]
fn local_organization_and_keyword_answers_always_cite_real_segments() {
    let repo = repository();
    let record = repo
        .create_record(
            "原文整理".into(),
            source(),
            vec![
                segment("one", "Transactions preserve database consistency.", 1),
                segment("two", "Indexes speed up lookups.", 1),
            ],
        )
        .unwrap();
    let analysis = analyze(&record);
    assert_eq!(analysis.method, "extractive");
    assert_eq!(analysis.points[0].text, record.segments[0].segment.text);
    assert_eq!(analysis.chapters[0].segment_ids, vec!["one", "two"]);
    let answer = ask(&record, "database consistency").unwrap();
    assert_eq!(answer.evidence.len(), 1);
    assert_eq!(answer.evidence[0].segment_id, "one");
    assert_eq!(answer.evidence[0].start_ms, 200);
    assert!(answer.answer.contains("原文摘录"));
    assert!(ask(&record, "quantum entanglement")
        .unwrap()
        .evidence
        .is_empty());
    assert!(ask(&record, " ").is_err());
}

#[test]
fn selected_subtitle_exports_have_valid_times_and_never_silently_export_all() {
    let repo = repository();
    let record = repo
        .create_record(
            "字幕导出".into(),
            source(),
            vec![segment("one", "First", 1), segment("two", "Second", 1)],
        )
        .unwrap();
    let selected = vec!["two".into()];
    let srt = render_export(&record, "srt", Some(&selected), false).unwrap();
    assert!(srt.contains("00:00:00,200 --> 00:00:01,000"));
    assert!(srt.contains("Second"));
    assert!(!srt.contains("First"));
    assert!(render_export(&record, "vtt", None, false)
        .unwrap()
        .starts_with("WEBVTT\n"));
    assert!(render_export(&record, "markdown", Some(&[]), false).is_err());
    assert!(render_export(&record, "markdown", Some(&["missing".into()]), false).is_err());
}
