use std::path::{Path, PathBuf};

use sherpa_onnx::{OnlineRecognizer, OnlineRecognizerConfig, OnlineStream};

use super::segment::SegmentBuilder;
use super::{AsrEngine, AsrError, EngineCaps, TARGET_SAMPLE_RATE};
use crate::config::AsrConfig;
use crate::transcript::TranscriptSegment;

const TAIL_SILENCE_SECONDS: f32 = 0.3;

#[derive(Debug, Clone)]
pub struct ModelFiles {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub joiner: PathBuf,
    pub tokens: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Precision {
    Int8,
    Fp32,
}

impl Precision {
    fn matches(self, name: &str) -> bool {
        match self {
            Precision::Int8 => name.contains(".int8."),
            Precision::Fp32 => !name.contains(".int8."),
        }
    }
}

pub fn discover_model_files(dir: &Path) -> Result<ModelFiles, AsrError> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| AsrError::ModelLoad(format!("无法读取模型目录 {}：{e}", dir.display())))?;

    let names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();

    let pick = |prefix: &str, prefer: Precision| -> Result<PathBuf, AsrError> {
        let candidates: Vec<&String> = names
            .iter()
            .filter(|n| n.starts_with(prefix) && n.ends_with(".onnx"))
            .collect();

        let chosen = candidates
            .iter()
            .find(|n| prefer.matches(n))
            .or_else(|| candidates.first())
            .ok_or_else(|| {
                AsrError::MissingModelFile(format!(
                    "{}/{}*.onnx\n目录实际内容：{}",
                    dir.display(),
                    prefix,
                    if names.is_empty() {
                        "(空)".to_string()
                    } else {
                        names.join(", ")
                    }
                ))
            })?;

        Ok(dir.join(chosen.as_str()))
    };

    let tokens = dir.join("tokens.txt");
    if !tokens.is_file() {
        return Err(AsrError::MissingModelFile(format!(
            "{}\n目录实际内容：{}",
            tokens.display(),
            names.join(", ")
        )));
    }

    Ok(ModelFiles {
        encoder: pick("encoder", Precision::Int8)?,
        decoder: pick("decoder", Precision::Fp32)?,
        joiner: pick("joiner", Precision::Int8)?,
        tokens,
    })
}

pub struct StreamingAdapter {
    recognizer: Option<OnlineRecognizer>,
    stream: Option<OnlineStream>,
    utterance: UtteranceState,
    samples_fed: u64,
    flushed: bool,
}

#[derive(Default)]
struct UtteranceState {
    builder: SegmentBuilder,
    index: i64,
    start_ms: u64,
    text: Option<String>,
    last_partial_text: Option<String>,
}

impl UtteranceState {
    fn observe(&mut self, text: &str) {
        if !text.trim().is_empty() {
            self.text = Some(crate::asr::latin_case::restore_sentence_case(text));
        }
    }

    fn partial(&mut self, end_ms: u64) -> Option<TranscriptSegment> {
        let text = self.text.as_deref()?;
        if self.last_partial_text.as_deref() == Some(text) {
            return None;
        }
        let segment = self
            .builder
            .build(self.index, text, self.start_ms, end_ms, false);
        self.last_partial_text = Some(text.to_owned());
        Some(segment)
    }

    fn finish(&mut self, end_ms: u64) -> Option<TranscriptSegment> {
        self.last_partial_text = None;
        let text = self.text.take()?;
        let segment = self
            .builder
            .build(self.index, &text, self.start_ms, end_ms, true);
        self.builder.forget(self.index);
        Some(segment)
    }

    fn endpoint(&mut self, end_ms: u64) -> Option<TranscriptSegment> {
        let segment = self.finish(end_ms);
        self.index += 1;
        self.start_ms = end_ms;
        segment
    }
}

impl Default for StreamingAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamingAdapter {
    pub fn new() -> Self {
        Self {
            recognizer: None,
            stream: None,
            utterance: UtteranceState::default(),
            samples_fed: 0,
            flushed: false,
        }
    }

    fn now_ms(&self) -> u64 {
        self.samples_fed * 1000 / TARGET_SAMPLE_RATE as u64
    }

    fn strm(&self) -> Result<&OnlineStream, AsrError> {
        self.stream.as_ref().ok_or(AsrError::NotInitialized)
    }

    fn drain(
        &mut self,
        out: &mut Vec<TranscriptSegment>,
        finish_input: bool,
    ) -> Result<(), AsrError> {
        let rec = self.recognizer.as_ref().ok_or(AsrError::NotInitialized)?;
        let stream = self.stream.as_ref().ok_or(AsrError::NotInitialized)?;
        let end_ms = self.now_ms();

        while rec.is_ready(stream) {
            rec.decode(stream);

            if let Some(r) = rec.get_result(stream) {
                self.utterance.observe(&r.text);
            }

            if rec.is_endpoint(stream) {
                if let Some(segment) = self.utterance.endpoint(end_ms) {
                    out.push(segment);
                }
                rec.reset(stream);
            }
        }

        let segment = if finish_input {
            self.utterance.finish(end_ms)
        } else {
            self.utterance.partial(end_ms)
        };
        if let Some(segment) = segment {
            out.push(segment);
        }

        Ok(())
    }
}

impl AsrEngine for StreamingAdapter {
    fn init(&mut self, cfg: &AsrConfig) -> Result<(), AsrError> {
        let dir = cfg
            .model_dir
            .as_ref()
            .ok_or_else(|| AsrError::InvalidConfig("model_dir 未设置".into()))?;
        let files = discover_model_files(Path::new(dir))?;

        let mut config = OnlineRecognizerConfig::default();

        config.model_config.transducer.encoder = Some(files.encoder.to_string_lossy().into_owned());
        config.model_config.transducer.decoder = Some(files.decoder.to_string_lossy().into_owned());
        config.model_config.transducer.joiner = Some(files.joiner.to_string_lossy().into_owned());
        config.model_config.tokens = Some(files.tokens.to_string_lossy().into_owned());
        config.model_config.provider = Some("cpu".into());

        config.decoding_method = Some("greedy_search".to_string());

        let (rule1, rule2, rule3) = cfg.endpoint.to_recognizer_rules();
        config.enable_endpoint = true;
        config.rule1_min_trailing_silence = rule1;
        config.rule2_min_trailing_silence = rule2;
        config.rule3_min_utterance_length = rule3;

        let recognizer = OnlineRecognizer::create(&config).ok_or_else(|| {
            AsrError::ModelLoad(format!(
                "OnlineRecognizer::create 返回 None（模型目录 {}）",
                Path::new(dir).display()
            ))
        })?;

        let stream = recognizer.create_stream();

        self.recognizer = Some(recognizer);
        self.stream = Some(stream);
        self.utterance = UtteranceState::default();
        self.samples_fed = 0;
        self.flushed = false;
        Ok(())
    }

    fn capabilities(&self) -> EngineCaps {
        EngineCaps::STREAMING_TRANSDUCER
    }

    fn feed_pcm(&mut self, pcm: &[f32]) -> Result<Vec<TranscriptSegment>, AsrError> {
        if self.flushed {
            return Err(AsrError::InvalidConfig(
                "语音输入已结束，请重新初始化引擎后再输入音频".into(),
            ));
        }
        if self.recognizer.is_none() {
            return Err(AsrError::NotInitialized);
        }
        let stream = self.strm()?;
        stream.accept_waveform(TARGET_SAMPLE_RATE as i32, pcm);
        self.samples_fed += pcm.len() as u64;

        let mut out = Vec::new();
        self.drain(&mut out, false)?;
        Ok(out)
    }

    fn flush(&mut self) -> Result<Vec<TranscriptSegment>, AsrError> {
        if self.recognizer.is_none() {
            return Err(AsrError::NotInitialized);
        }
        if self.flushed {
            return Ok(Vec::new());
        }
        self.flushed = true;

        let tail_len = (TARGET_SAMPLE_RATE as f32 * TAIL_SILENCE_SECONDS) as usize;
        let tail = vec![0.0f32; tail_len];

        {
            let stream = self.strm()?;
            stream.accept_waveform(TARGET_SAMPLE_RATE as i32, &tail);
            stream.input_finished();
        }
        let mut out = Vec::new();
        self.drain(&mut out, true)?;
        Ok(out)
    }

    fn shutdown(&mut self) {
        self.stream = None;
        self.recognizer = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::{SegmentState, TranscriptStore};

    #[test]
    fn repeated_hypotheses_do_not_publish_unchanged_partials_or_delay_the_final() {
        let mut utterance = UtteranceState::default();
        let mut store = TranscriptStore::new();
        utterance.observe("没有变化的字幕");
        let partial = utterance.partial(400).unwrap();
        store.apply(vec![partial.clone()]).unwrap();
        for end_ms in [500, 600, 700] {
            utterance.observe("没有变化的字幕");
            assert!(utterance.partial(end_ms).is_none());
        }

        let final_segment = utterance.endpoint(800).unwrap();
        assert_eq!(final_segment.id, partial.id);
        assert_eq!(final_segment.text, partial.text);
        assert_eq!(final_segment.start_ms, 0);
        assert_eq!(final_segment.end_ms, 800);
        assert_eq!(final_segment.revision, partial.revision + 1);
        assert_eq!(final_segment.state, SegmentState::Final);
        store.apply(vec![final_segment]).unwrap();
        assert_eq!(store.segment_count(), 1);
        assert_eq!(store.snapshot()[0].state, SegmentState::Final);
        assert!(utterance.finish(800).is_none());
    }

    #[test]
    fn partial_comparison_uses_the_displayed_sentence_case() {
        let mut utterance = UtteranceState::default();
        utterance.observe("HELLO THERE");
        let first = utterance.partial(300).unwrap();
        assert_eq!(first.text, "Hello there");
        utterance.observe("Hello there");
        assert!(utterance.partial(400).is_none());
        utterance.observe("HELLO THERE FRIEND");
        let changed = utterance.partial(500).unwrap();
        assert_eq!(changed.id, first.id);
        assert_eq!(changed.revision, first.revision + 1);
        assert_eq!(changed.text, "Hello there friend");
        assert_eq!(changed.end_ms, 500);
    }

    #[test]
    fn hypotheses_that_revert_before_publication_do_not_repeat_the_displayed_text() {
        let mut utterance = UtteranceState::default();
        utterance.observe("已经显示的文字");
        let first = utterance.partial(300).unwrap();
        utterance.observe("临时改写的文字");
        utterance.observe("已经显示的文字");
        assert!(utterance.partial(400).is_none());
        utterance.observe("确实变化的文字");
        let changed = utterance.partial(500).unwrap();
        assert_eq!(changed.id, first.id);
        assert_eq!(changed.revision, first.revision + 1);
        assert_eq!(changed.text, "确实变化的文字");
        assert_eq!(utterance.finish(600).unwrap().text, changed.text);
    }

    #[test]
    fn identical_text_in_the_next_utterance_keeps_its_own_partial_and_final() {
        let mut utterance = UtteranceState::default();
        utterance.observe("重复说的一句话");
        let first_partial = utterance.partial(300).unwrap();
        utterance.endpoint(500).unwrap();
        utterance.observe("重复说的一句话");
        let next_partial = utterance.partial(700).unwrap();
        assert_ne!(next_partial.id, first_partial.id);
        assert_eq!(next_partial.revision, 1);
        assert_eq!(next_partial.start_ms, 500);
        assert_eq!(next_partial.end_ms, 700);
        utterance.observe("重复说的一句话");
        assert!(utterance.partial(800).is_none());
        let stopped = utterance.finish(850).unwrap();
        assert_eq!(stopped.id, next_partial.id);
        assert_eq!(stopped.text, next_partial.text);
        assert_eq!(stopped.revision, 2);
        assert_eq!(stopped.end_ms, 850);
        assert_eq!(stopped.state, SegmentState::Final);
        assert_eq!(utterance.builder.tracked(), 0);
    }

    #[test]
    fn stop_finalizes_the_last_partial_without_a_new_recognizer_result() {
        let mut utterance = UtteranceState::default();
        let mut store = TranscriptStore::new();
        utterance.observe("最后一句还没到端点");
        let partial = utterance.partial(600).unwrap();
        store.apply(vec![partial.clone()]).unwrap();
        assert!(utterance.partial(700).is_none());

        let final_segment = utterance.finish(750).unwrap();
        assert_eq!(final_segment.id, partial.id);
        assert_eq!(final_segment.revision, partial.revision + 1);
        assert_eq!(final_segment.state, SegmentState::Final);
        assert_eq!(final_segment.text, partial.text);
        assert_eq!(final_segment.end_ms, 750);
        store.apply(vec![final_segment]).unwrap();
        assert!(utterance.finish(750).is_none());
        assert_eq!(utterance.builder.tracked(), 0);
    }

    #[test]
    fn endpoint_keeps_the_last_hypothesis_when_the_latest_result_is_empty() {
        let mut utterance = UtteranceState::default();
        utterance.observe("已经显示的原文");
        let partial = utterance.partial(500).unwrap();
        utterance.observe("  ");
        let final_segment = utterance.endpoint(800).unwrap();
        assert_eq!(final_segment.id, partial.id);
        assert_eq!(final_segment.text, partial.text);
        assert_eq!(final_segment.state, SegmentState::Final);
        assert!(utterance.finish(800).is_none());
    }

    #[test]
    fn endpoint_and_next_partial_keep_separate_ids_and_time_ranges() {
        let mut utterance = UtteranceState::default();
        utterance.observe("HELLO THERE");
        let first_partial = utterance.partial(400).unwrap();
        utterance.observe("HELLO THERE FRIEND");
        let first_final = utterance.endpoint(800).unwrap();
        utterance.observe("下一句");
        let next_partial = utterance.partial(900).unwrap();

        assert_eq!(first_partial.id, first_final.id);
        assert_eq!(first_final.text, "Hello there friend");
        assert_eq!(first_final.start_ms, 0);
        assert_eq!(first_final.end_ms, 800);
        assert_ne!(first_final.id, next_partial.id);
        assert_eq!(next_partial.start_ms, 800);
        assert_eq!(next_partial.end_ms, 900);
        assert_eq!(next_partial.revision, 1);
        assert_eq!(utterance.builder.tracked(), 1);
    }

    #[test]
    fn silent_endpoints_do_not_create_empty_segments() {
        let mut utterance = UtteranceState::default();
        assert!(utterance.endpoint(2400).is_none());
        assert!(utterance.finish(2500).is_none());
        utterance.observe("静音之后的第一句");
        let segment = utterance.finish(3000).unwrap();
        assert_eq!(segment.start_ms, 2400);
        assert_eq!(segment.end_ms, 3000);
        assert_eq!(segment.revision, 1);
    }

    #[test]
    fn feed_after_flush_is_rejected_before_calling_the_native_stream() {
        let mut adapter = StreamingAdapter::new();
        adapter.flushed = true;
        assert!(matches!(
            adapter.feed_pcm(&[0.0; 1600]),
            Err(AsrError::InvalidConfig(_))
        ));
    }

    #[test]
    fn discover_reports_missing_dir_clearly() {
        let err = discover_model_files(Path::new("/nonexistent/model/dir")).unwrap_err();
        assert!(matches!(err, AsrError::ModelLoad(_)));
    }

    fn temp_model_dir(files: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("asr-disc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in files {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        dir
    }

    #[test]
    fn discover_uses_mixed_precision_matching_upstream() {
        let dir = temp_model_dir(&[
            "encoder-epoch-99-avg-1.onnx",
            "encoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.onnx",
            "decoder-epoch-99-avg-1.int8.onnx",
            "joiner-epoch-99-avg-1.onnx",
            "joiner-epoch-99-avg-1.int8.onnx",
            "tokens.txt",
        ]);

        let f = discover_model_files(&dir).unwrap();
        assert!(
            f.encoder.to_string_lossy().contains(".int8."),
            "encoder 应用 int8"
        );
        assert!(
            !f.decoder.to_string_lossy().contains(".int8."),
            "decoder 应保持 fp32"
        );
        assert!(
            f.joiner.to_string_lossy().contains(".int8."),
            "joiner 应用 int8"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discover_falls_back_when_preferred_precision_is_absent() {
        let dir = temp_model_dir(&[
            "encoder-epoch-99-avg-1.onnx",
            "decoder-epoch-99-avg-1.int8.onnx",
            "joiner-epoch-99-avg-1.onnx",
            "tokens.txt",
        ]);
        assert!(discover_model_files(&dir).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discover_error_lists_actual_directory_contents() {
        let dir = temp_model_dir(&["encoder-epoch-99-avg-1.int8.onnx", "tokens.txt"]);
        let msg = discover_model_files(&dir).unwrap_err().to_string();
        assert!(msg.contains("decoder"), "{msg}");
        assert!(msg.contains("encoder-epoch-99-avg-1.int8.onnx"), "{msg}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn discover_ignores_chunk_variant_subdirectories() {
        let dir = temp_model_dir(&[
            "encoder-epoch-99-avg-1.int8.onnx",
            "decoder-epoch-99-avg-1.onnx",
            "joiner-epoch-99-avg-1.int8.onnx",
            "tokens.txt",
        ]);
        std::fs::create_dir_all(dir.join("64")).unwrap();
        std::fs::write(dir.join("64").join("encoder-x.onnx"), b"x").unwrap();

        let f = discover_model_files(&dir).unwrap();
        assert!(!f.encoder.to_string_lossy().contains("/64/"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn feed_before_init_is_an_error_not_a_panic() {
        let mut a = StreamingAdapter::new();
        assert!(matches!(
            a.feed_pcm(&[0.0; 1600]),
            Err(AsrError::NotInitialized)
        ));
    }

    #[test]
    fn capabilities_declare_partial_support() {
        let a = StreamingAdapter::new();
        let c = a.capabilities();
        assert!(c.streaming && c.produces_partial && c.supports_endpoint);
        assert!(!c.requires_full_utterance);
    }
}
