use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::asr::AsrEngine;
use crate::config::{AsrConfig, TranslateConfig};
use crate::transcript::{SegmentState, TranscriptSegment, TranscriptStore, TranslationState};
use crate::translate::Translator;

use super::pcm::{inspect_wav, CHUNK_BYTES};

pub fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("任务已取消".into())
    } else {
        Ok(())
    }
}

pub fn recognize<A: AsrEngine + ?Sized>(
    engine: &mut A,
    config: &AsrConfig,
    path: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
) -> Result<Vec<TranscriptSegment>, String> {
    check_cancel(cancel)?;
    let info = inspect_wav(path)?;
    let initialized = engine
        .init(config)
        .map_err(|e| format!("离线识别初始化失败：{e}"));
    let result = (|| {
        initialized?;
        check_cancel(cancel)?;
        let mut file = File::open(path).map_err(|e| format!("读取音频失败：{e}"))?;
        file.seek(SeekFrom::Start(info.data_offset))
            .map_err(|e| e.to_string())?;
        let mut remaining = info.data_bytes;
        let mut bytes = vec![0; CHUNK_BYTES];
        let mut store = TranscriptStore::new();
        while remaining > 0 {
            check_cancel(cancel)?;
            let count = remaining.min(CHUNK_BYTES as u64) as usize;
            file.read_exact(&mut bytes[..count])
                .map_err(|_| "音频在处理期间被截断")?;
            let samples: Vec<f32> = bytes[..count]
                .chunks_exact(2)
                .map(|p| i16::from_le_bytes([p[0], p[1]]) as f32 / 32768.0)
                .collect();
            for chunk in samples.chunks(crate::audio::CHUNK_SAMPLES) {
                check_cancel(cancel)?;
                store
                    .apply(
                        engine
                            .feed_pcm(chunk)
                            .map_err(|e| format!("离线识别失败：{e}"))?,
                    )
                    .map_err(|e| e.to_string())?;
            }
            remaining -= count as u64;
            progress(1.0 - remaining as f32 / info.data_bytes as f32);
        }
        check_cancel(cancel)?;
        store
            .apply(
                engine
                    .flush()
                    .map_err(|e| format!("离线识别收尾失败：{e}"))?,
            )
            .map_err(|e| e.to_string())?;
        if store
            .snapshot()
            .iter()
            .any(|segment| !segment.is_persistable())
        {
            return Err("识别收尾后仍有未定稿段落，未保存不完整结果".into());
        }
        let segments: Vec<_> = store.persistable().cloned().collect();
        if segments.iter().any(|segment| {
            segment.text.trim().is_empty()
                || segment.start_ms > segment.end_ms
                || segment.end_ms > info.duration_ms()
        }) {
            return Err("离线识别返回了无效文字或时间范围，未保存不完整结果".into());
        }
        if segments.is_empty() {
            return Err("没有识别到有效语音，请确认音轨、语言和模型设置".into());
        }
        Ok(segments)
    })();
    engine.shutdown();
    result
}

pub fn translate_all<T: Translator + ?Sized>(
    translator: &mut T,
    segments: &mut [TranscriptSegment],
    cancel: &AtomicBool,
    mut progress: impl FnMut(f32),
) -> Result<u32, String> {
    let total = segments.len().max(1);
    let mut failed = 0;
    for (index, segment) in segments.iter_mut().enumerate() {
        check_cancel(cancel)?;
        match translator.translate(&segment.text) {
            Ok(text) => {
                segment.translation = Some(text);
                segment.translation_state = TranslationState::Done;
                segment.translation_error = None;
            }
            Err(error) => {
                failed += 1;
                segment.translation = None;
                segment.translation_state = TranslationState::Failed;
                segment.translation_error = Some(error.to_string());
            }
        }
        segment.revision = segment.revision.saturating_add(1);
        progress((index + 1) as f32 / total as f32);
    }
    Ok(failed)
}

pub fn translate_prepared<T: Translator>(
    translator: Result<T, String>,
    config: &TranslateConfig,
    segments: &mut [TranscriptSegment],
    cancel: &AtomicBool,
    progress: impl FnMut(f32),
) -> Result<u32, String> {
    check_cancel(cancel)?;
    let mut translator = match translator {
        Ok(translator) => translator,
        Err(error) => return Ok(mark_translation_failed(segments, &error)),
    };
    let result = (|| match translator.init(config) {
        Ok(()) => translate_all(&mut translator, segments, cancel, progress),
        Err(error) => {
            check_cancel(cancel)?;
            Ok(mark_translation_failed(
                segments,
                &format!("离线翻译初始化失败：{error}"),
            ))
        }
    })();
    translator.shutdown();
    result
}

fn mark_translation_failed(segments: &mut [TranscriptSegment], error: &str) -> u32 {
    for segment in segments.iter_mut() {
        segment.translation = None;
        segment.translation_state = TranslationState::Failed;
        segment.translation_error = Some(error.to_owned());
        segment.revision = segment.revision.saturating_add(1);
    }
    segments.len() as u32
}

pub fn new_version(segments: Vec<TranscriptSegment>) -> Vec<TranscriptSegment> {
    segments
        .into_iter()
        .filter(|s| s.state.is_persistable())
        .map(|mut segment| {
            segment.id = uuid::Uuid::new_v4().to_string();
            segment.state = SegmentState::Final;
            segment.revision = 1;
            segment.translation = None;
            segment.translation_state = TranslationState::Idle;
            segment.translation_error = None;
            segment
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asr::{AsrError, EngineCaps};
    use crate::translate::{TranslateCaps, TranslateError};
    use base64::Engine;

    struct Fake {
        calls: usize,
    }
    impl Translator for Fake {
        fn init(&mut self, _: &TranslateConfig) -> Result<(), TranslateError> {
            Ok(())
        }
        fn capabilities(&self) -> TranslateCaps {
            TranslateCaps::LOCAL_NMT
        }
        fn translate(&mut self, _: &str) -> Result<String, TranslateError> {
            self.calls += 1;
            if self.calls == 2 {
                Err(TranslateError::Internal("失败原因".into()))
            } else {
                Ok("translated".into())
            }
        }
        fn shutdown(&mut self) {}
    }
    struct FakeAsr {
        calls: usize,
        stopped: bool,
    }
    fn final_segment(text: String) -> TranscriptSegment {
        TranscriptSegment {
            id: uuid::Uuid::new_v4().to_string(),
            start_ms: 0,
            end_ms: 1,
            text,
            translation: None,
            translation_state: TranslationState::Idle,
            translation_error: None,
            state: SegmentState::Final,
            revision: 1,
        }
    }
    impl AsrEngine for FakeAsr {
        fn init(&mut self, _: &AsrConfig) -> Result<(), AsrError> {
            Ok(())
        }
        fn capabilities(&self) -> EngineCaps {
            EngineCaps::STREAMING_TRANSDUCER
        }
        fn feed_pcm(&mut self, _: &[f32]) -> Result<Vec<TranscriptSegment>, AsrError> {
            self.calls += 1;
            Ok(vec![final_segment(format!("segment {}", self.calls))])
        }
        fn flush(&mut self) -> Result<Vec<TranscriptSegment>, AsrError> {
            Ok(vec![final_segment("tail".into())])
        }
        fn shutdown(&mut self) {
            self.stopped = true;
        }
    }
    fn wav() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("audioscript-batch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let mut upload =
            super::super::pcm::Upload::new("job".into(), &dir, (CHUNK_BYTES * 2) as u64).unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(vec![0; CHUNK_BYTES]);
        upload.append(0, &encoded).unwrap();
        upload.append(1, &encoded).unwrap();
        upload.finish().unwrap()
    }
    #[test]
    fn file_recognition_keeps_every_chunk_and_flush_result_without_a_realtime_drop_queue() {
        let path = wav();
        let mut engine = FakeAsr {
            calls: 0,
            stopped: false,
        };
        let segments = recognize(
            &mut engine,
            &AsrConfig::default(),
            &path,
            &AtomicBool::new(false),
            |_| {},
        )
        .unwrap();
        assert!(engine.calls > 2);
        assert_eq!(segments.len(), engine.calls + 1);
        assert_eq!(segments.last().unwrap().text, "tail");
        assert!(engine.stopped);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    #[test]
    fn file_cancellation_stops_between_blocks_and_always_shuts_down_the_engine() {
        let path = wav();
        let mut engine = FakeAsr {
            calls: 0,
            stopped: false,
        };
        let cancel = AtomicBool::new(false);
        assert!(
            recognize(&mut engine, &AsrConfig::default(), &path, &cancel, |_| {
                cancel.store(true, Ordering::Release)
            })
            .is_err()
        );
        assert!(engine.calls > 0);
        assert!(engine.stopped);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
    fn segments() -> Vec<TranscriptSegment> {
        super::super::subtitles::parse("00:00.000 --> 00:01.000\none\n\n00:01.000 --> 00:02.000\ntwo\n\n00:02.000 --> 00:03.000\nthree").unwrap()
    }

    #[test]
    fn batch_translation_attempts_every_segment_and_preserves_explicit_failures() {
        let mut engine = Fake { calls: 0 };
        let mut segments = segments();
        let failed =
            translate_all(&mut engine, &mut segments, &AtomicBool::new(false), |_| {}).unwrap();
        assert_eq!(engine.calls, 3);
        assert_eq!(failed, 1);
        assert_eq!(segments[1].translation_state, TranslationState::Failed);
        assert!(segments[1]
            .translation_error
            .as_ref()
            .unwrap()
            .contains("失败原因"));
        assert_eq!(segments[2].translation_state, TranslationState::Done);
    }

    #[test]
    fn unavailable_translation_preserves_recognized_text_for_saving_and_retry() {
        struct Unavailable(std::sync::Arc<AtomicBool>);
        impl Translator for Unavailable {
            fn init(&mut self, _: &TranslateConfig) -> Result<(), TranslateError> {
                Err(TranslateError::ModelLoad("模型文件损坏".into()))
            }
            fn capabilities(&self) -> TranslateCaps {
                TranslateCaps::LOCAL_NMT
            }
            fn translate(&mut self, _: &str) -> Result<String, TranslateError> {
                panic!("初始化失败不得调用翻译")
            }
            fn shutdown(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let stopped = std::sync::Arc::new(AtomicBool::new(false));
        for engine in [
            Err("未找到本地翻译模型".to_owned()),
            Ok(Unavailable(stopped.clone())),
        ] {
            let original = segments();
            let mut result = original.clone();
            assert_eq!(
                translate_prepared(
                    engine,
                    &TranslateConfig::default(),
                    &mut result,
                    &AtomicBool::new(false),
                    |_| {},
                )
                .unwrap(),
                result.len() as u32,
            );
            for (before, after) in original.iter().zip(&result) {
                assert_eq!(after.id, before.id);
                assert_eq!(after.text, before.text);
                assert_eq!(after.start_ms, before.start_ms);
                assert_eq!(after.end_ms, before.end_ms);
                assert!(after.is_persistable());
                assert_eq!(after.translation_state, TranslationState::Failed);
                assert!(after.translation_error.as_ref().unwrap().contains("模型"));
                assert!(after.translation.is_none());
                assert_eq!(after.revision, before.revision + 1);
            }
        }
        assert!(stopped.load(Ordering::Acquire));
        let original = segments();
        let mut cancelled = original.clone();
        assert!(translate_prepared::<Unavailable>(
            Err("未找到本地翻译模型".into()),
            &TranslateConfig::default(),
            &mut cancelled,
            &AtomicBool::new(true),
            |_| {},
        )
        .is_err());
        assert_eq!(cancelled, original);
    }

    #[test]
    fn cancellation_stops_batch_and_new_versions_never_overwrite_original_segment_identity() {
        let original = segments();
        let mut next = new_version(original.clone());
        assert_ne!(original[0].id, next[0].id);
        assert_eq!(original[0].text, next[0].text);
        let cancel = AtomicBool::new(false);
        let mut engine = Fake { calls: 0 };
        assert!(translate_all(&mut engine, &mut next, &cancel, |_| cancel
            .store(true, Ordering::Release))
        .is_err());
        assert_eq!(engine.calls, 1);
        assert_eq!(original[0].translation_state, TranslationState::Idle);
    }
}
