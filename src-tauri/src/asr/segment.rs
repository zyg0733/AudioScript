use std::collections::BTreeMap;

use crate::transcript::{SegmentState, TranscriptSegment, TranslationState};

#[derive(Debug, Default)]
pub struct SegmentBuilder {
    ids: BTreeMap<i64, String>,
    revisions: BTreeMap<i64, u32>,
}

impl SegmentBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn build(
        &mut self,
        utterance: i64,
        text: &str,
        start_ms: u64,
        end_ms: u64,
        is_final: bool,
    ) -> TranscriptSegment {
        let id = self
            .ids
            .entry(utterance)
            .or_insert_with(|| uuid::Uuid::new_v4().to_string())
            .clone();

        let revision = self.revisions.entry(utterance).or_insert(0);
        *revision += 1;

        TranscriptSegment {
            id,
            start_ms,
            end_ms,
            text: text.to_owned(),
            translation: None,
            translation_state: TranslationState::Idle,
            translation_error: None,
            state: if is_final {
                SegmentState::Final
            } else {
                SegmentState::Partial
            },
            revision: *revision,
        }
    }

    pub fn forget(&mut self, utterance: i64) {
        self.ids.remove(&utterance);
        self.revisions.remove(&utterance);
    }

    pub fn tracked(&self) -> usize {
        self.ids.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_utterance_keeps_the_same_id_across_partial_and_final() {
        let mut b = SegmentBuilder::new();
        let p = b.build(0, "今天下午", 0, 500, false);
        let f = b.build(0, "今天下午三点开会", 0, 1800, true);

        assert_eq!(p.id, f.id, "partial → final MUST 保持同一 id");
        assert_ne!(p.text, f.text);
    }

    #[test]
    fn revision_increments_per_build() {
        let mut b = SegmentBuilder::new();
        assert_eq!(b.build(0, "a", 0, 100, false).revision, 1);
        assert_eq!(b.build(0, "ab", 0, 200, false).revision, 2);
        assert_eq!(b.build(0, "abc", 0, 300, true).revision, 3);
    }

    #[test]
    fn different_utterances_get_different_ids() {
        let mut b = SegmentBuilder::new();
        let a = b.build(0, "第一句", 0, 900, true);
        let c = b.build(1, "第二句", 900, 1800, true);
        assert_ne!(a.id, c.id);
    }

    #[test]
    fn state_reflects_is_final() {
        let mut b = SegmentBuilder::new();
        assert_eq!(b.build(0, "x", 0, 1, false).state, SegmentState::Partial);
        assert_eq!(b.build(0, "x", 0, 2, true).state, SegmentState::Final);
    }

    #[test]
    fn forget_releases_bookkeeping() {
        let mut b = SegmentBuilder::new();
        b.build(0, "x", 0, 1, true);
        assert_eq!(b.tracked(), 1);
        b.forget(0);
        assert_eq!(b.tracked(), 0, "定稿后必须能回收，否则长时转写无限累积");
    }

    #[test]
    fn ids_are_uuid_v4_shaped() {
        let mut b = SegmentBuilder::new();
        let s = b.build(0, "x", 0, 1, false);
        assert_eq!(s.id.len(), 36, "SPEC §1.2 要求 UUID v4 字符串");
        assert_eq!(s.id.matches('-').count(), 4);
    }
}
