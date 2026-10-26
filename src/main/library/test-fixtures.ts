import { type LibraryRecord, SegmentState, TranslationState } from '@/shared/types'

export function libraryRecord(id = 'record-1'): LibraryRecord {
  return {
    id,
    schemaVersion: 1,
    revision: 4,
    title: '内存管理课程',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    source: { kind: 'subtitle' as LibraryRecord['source']['kind'], label: '课程字幕', durationMs: 14000 },
    segments: ['first', 'second'].map((name, index) => ({
      segment: {
        id: name,
        revision: 2,
        startMs: index * 10_000,
        endMs: index * 10_000 + 4_000,
        text: index ? 'Memory needs ownership.' : 'Rust prevents data races.',
        translation: index ? '内存需要所有权。' : 'Rust 避免数据竞争。',
        state: SegmentState.Final,
        translationState: TranslationState.Done,
      },
      sourceRevision: 1,
      bookmarked: false,
      note: '',
      sourceEdited: false,
      translationEdited: false,
      liveRevision: 2,
      versions: [1, 2].map((revision) => ({
        revision,
        sourceRevision: 1,
        text: revision === 1 ? '旧识别原文' : index ? 'Memory needs ownership.' : 'Rust prevents data races.',
        translation: revision === 1 ? '旧译文' : '当前译文',
        translationState: TranslationState.Done,
        committedAt: 1_700_000_000_000 + revision,
        origin: 'live' as LibraryRecord['segments'][number]['versions'][number]['origin'],
      })),
    })),
  }
}
