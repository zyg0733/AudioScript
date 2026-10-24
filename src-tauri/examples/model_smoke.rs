use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::Instant;

use anyhow::{bail, ensure, Context, Result};
use app_lib::asr::streaming::StreamingAdapter;
use app_lib::asr::{AsrEngine, TARGET_SAMPLE_RATE};
use app_lib::audio::CHUNK_SAMPLES;
use app_lib::config::{AsrConfig, AsrModelTier, MtModelTier, TranslateConfig};
use app_lib::models::catalog;
use app_lib::transcript::{SegmentState, TranscriptSegment, TranscriptStore};
use app_lib::translate::local_nmt::LocalNmt;
use app_lib::translate::{degenerate_translation, Translator};

const USAGE: &str =
    "用法：model_smoke --models-root <解包后的 models 目录> [--wav <16 kHz 单声道 PCM16 WAV>]";
const MAX_WAV_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
struct Options {
    models_root: PathBuf,
    wav: Option<PathBuf>,
}

fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<Option<Options>> {
    let mut args = args.into_iter();
    let mut models_root = None;
    let mut wav = None;
    while let Some(arg) = args.next() {
        let target = match arg.to_str() {
            Some("--help" | "-h") => return Ok(None),
            Some("--models-root") => &mut models_root,
            Some("--wav") => &mut wav,
            _ => bail!("未知参数：{}\n{USAGE}", arg.to_string_lossy()),
        };
        ensure!(target.is_none(), "参数重复：{}", arg.to_string_lossy());
        let value = args
            .next()
            .with_context(|| format!("参数 {} 缺少路径", arg.to_string_lossy()))?;
        ensure!(
            !value.is_empty() && !value.to_string_lossy().starts_with("--"),
            "参数 {} 缺少有效路径",
            arg.to_string_lossy()
        );
        *target = Some(PathBuf::from(value));
    }
    Ok(Some(Options {
        models_root: models_root.with_context(|| format!("缺少 --models-root\n{USAGE}"))?,
        wav,
    }))
}

fn main() -> ExitCode {
    let result = parse_args(std::env::args_os().skip(1)).and_then(|options| match options {
        Some(options) => run(options),
        None => {
            println!("{USAGE}");
            Ok(())
        }
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("模型冒烟验证失败：{error:#}");
            ExitCode::FAILURE
        }
    }
}

fn run(options: Options) -> Result<()> {
    let started = Instant::now();
    let root = dunce::canonicalize(&options.models_root)
        .with_context(|| format!("无法读取模型根目录 {}", options.models_root.display()))?;
    ensure!(root.is_dir(), "模型根路径不是目录：{}", root.display());
    let asr_entry = catalog::asr_entry(AsrModelTier::Builtin);
    let asr_dir = root.join(asr_entry.installed_dir());
    let mt_entry = catalog::mt_entry(MtModelTier::Base);
    let mt_dir = root.join(mt_entry.installed_dir());
    let missing_asr =
        app_lib::paths::missing_asr_files(&asr_dir, asr_entry).map_err(anyhow::Error::msg)?;
    ensure!(
        missing_asr.is_empty(),
        "ASR 模型不完整（{}）：{}",
        asr_dir.display(),
        missing_asr.join("、")
    );
    let missing_mt =
        app_lib::paths::missing_mt_files(&mt_dir, mt_entry).map_err(anyhow::Error::msg)?;
    ensure!(
        missing_mt.is_empty(),
        "翻译模型不完整（{}）：{}",
        mt_dir.display(),
        missing_mt.join("、")
    );

    let pcm = match options.wav.as_deref() {
        Some(path) => {
            let size = std::fs::metadata(path)
                .with_context(|| format!("无法读取 WAV {}", path.display()))?
                .len();
            ensure!(size <= MAX_WAV_BYTES as u64, "WAV 超过 32 MiB 冒烟样本上限");
            let bytes =
                std::fs::read(path).with_context(|| format!("无法读取 WAV {}", path.display()))?;
            let samples = parse_pcm16_wav(&bytes)
                .with_context(|| format!("WAV 格式不符合要求：{}", path.display()))?;
            println!(
                "ASR 语音样本：{}（{} 个采样点）",
                path.display(),
                samples.len()
            );
            samples
        }
        None => {
            println!("ASR 使用 1 秒静音，只验证模型加载、推理和收尾；不验证语音识别准确性");
            vec![0.0; TARGET_SAMPLE_RATE as usize]
        }
    };
    println!("从解包资源加载模型：{}", root.display());
    smoke_asr(&asr_dir, &pcm, options.wav.is_some())?;
    smoke_translation(&mt_dir, "en", "zh", "Hello, world.")?;
    smoke_translation(&mt_dir, "zh", "en", "今天天气很好。")?;
    println!("模型冒烟验证通过（{} ms）", started.elapsed().as_millis());
    Ok(())
}

fn smoke_asr(model_dir: &Path, pcm: &[f32], expect_speech: bool) -> Result<()> {
    let started = Instant::now();
    let cfg = AsrConfig {
        model_dir: Some(
            model_dir
                .to_str()
                .context("ASR 模型路径不是有效的 UTF-8")?
                .to_owned(),
        ),
        ..Default::default()
    };
    let mut engine = StreamingAdapter::new();
    engine.init(&cfg).context("ASR 初始化失败")?;
    let result = (|| {
        let duration_ms = pcm.len() as u64 * 1000 / TARGET_SAMPLE_RATE as u64;
        let mut store = TranscriptStore::new();
        for chunk in pcm.chunks(CHUNK_SAMPLES) {
            let output = engine.feed_pcm(chunk).context("ASR 推理失败")?;
            apply_asr_deltas(&mut store, output, duration_ms)?;
        }
        let tail = engine.flush().context("ASR 收尾失败")?;
        apply_asr_deltas(&mut store, tail, duration_ms)?;
        ensure!(engine.flush()?.is_empty(), "ASR 重复 flush 产生了重复段落");
        ensure!(
            engine.feed_pcm(&[0.0]).is_err(),
            "ASR 在结束输入后仍接受音频"
        );
        let segments = store.snapshot();
        ensure!(
            segments.iter().all(|s| s.state == SegmentState::Final),
            "ASR 收尾后仍有未定稿段落"
        );
        if expect_speech {
            ensure!(!segments.is_empty(), "ASR 没有从语音 WAV 中识别出定稿文字");
        }
        for segment in segments {
            println!(
                "ASR 定稿 [{}–{} ms]：{}",
                segment.start_ms, segment.end_ms, segment.text
            );
        }
        println!(
            "ASR 初始化、投喂、收尾通过（{} 段，{} ms）",
            segments.len(),
            started.elapsed().as_millis()
        );
        Ok(())
    })();
    engine.shutdown();
    result
}

fn apply_asr_deltas(
    store: &mut TranscriptStore,
    deltas: Vec<TranscriptSegment>,
    duration_ms: u64,
) -> Result<()> {
    for segment in &deltas {
        ensure!(!segment.text.trim().is_empty(), "ASR 产生了空段落");
        ensure!(
            segment.start_ms <= segment.end_ms && segment.end_ms <= duration_ms,
            "ASR 时间范围无效：{}–{} ms，样本总长 {} ms",
            segment.start_ms,
            segment.end_ms,
            duration_ms
        );
        ensure!(segment.revision > 0, "ASR 段落 revision 为零");
        let id = uuid::Uuid::parse_str(&segment.id).context("ASR 段落 ID 不是 UUID")?;
        ensure!(id.get_version_num() == 4, "ASR 段落 ID 不是 UUID v4");
        if let Some(previous) = store.get(&segment.id) {
            ensure!(
                segment.revision > previous.revision,
                "ASR 段落 revision 未递增"
            );
        }
    }
    store.apply(deltas).context("ASR 输出违反段落状态机")?;
    Ok(())
}

fn smoke_translation(model_dir: &Path, from: &str, to: &str, input: &str) -> Result<()> {
    let started = Instant::now();
    let mut translator = LocalNmt::new(model_dir.to_path_buf(), MtModelTier::Base);
    let cfg = TranslateConfig {
        source_lang: from.to_owned(),
        target_lang: to.to_owned(),
        ..Default::default()
    };
    translator
        .init(&cfg)
        .with_context(|| format!("NMT {from}→{to} 初始化失败"))?;
    let result = translator.translate(input);
    translator.shutdown();
    let output = result.with_context(|| format!("NMT {from}→{to} 推理失败"))?;
    ensure!(!output.trim().is_empty(), "NMT {from}→{to} 返回空译文");
    ensure!(
        degenerate_translation(&output).is_none(),
        "NMT {from}→{to} 返回退化译文：{output}"
    );
    let target_language_present = match to {
        "zh" => output
            .chars()
            .any(|c| ('\u{3400}'..='\u{9fff}').contains(&c)),
        "en" => output.chars().any(|c| c.is_ascii_alphabetic()),
        _ => false,
    };
    ensure!(
        target_language_present,
        "NMT {from}→{to} 未输出目标语言：{output}"
    );
    println!(
        "NMT {from}→{to}：{input} → {output}（{} ms）",
        started.elapsed().as_millis()
    );
    Ok(())
}

fn parse_pcm16_wav(bytes: &[u8]) -> Result<Vec<f32>> {
    ensure!(bytes.len() <= MAX_WAV_BYTES, "WAV 超过 32 MiB 冒烟样本上限");
    ensure!(
        bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE",
        "文件不是 RIFF/WAVE"
    );
    let riff_end = u32::from_le_bytes(bytes[4..8].try_into()?) as usize + 8;
    ensure!(riff_end >= 12 && riff_end <= bytes.len(), "RIFF 数据被截断");
    let mut position = 12usize;
    let mut have_format = false;
    let mut data = None;
    while position < riff_end {
        ensure!(riff_end - position >= 8, "WAV 块头被截断");
        let id = &bytes[position..position + 4];
        let size = u32::from_le_bytes(bytes[position + 4..position + 8].try_into()?) as usize;
        position += 8;
        let end = position.checked_add(size).context("WAV 块大小溢出")?;
        ensure!(end <= riff_end, "WAV 块数据被截断");
        let chunk = &bytes[position..end];
        match id {
            b"fmt " => {
                ensure!(!have_format, "WAV 包含重复的 fmt 块");
                ensure!(chunk.len() >= 16, "WAV fmt 块不完整");
                let format = u16::from_le_bytes(chunk[0..2].try_into()?);
                let channels = u16::from_le_bytes(chunk[2..4].try_into()?);
                let sample_rate = u32::from_le_bytes(chunk[4..8].try_into()?);
                let byte_rate = u32::from_le_bytes(chunk[8..12].try_into()?);
                let block_align = u16::from_le_bytes(chunk[12..14].try_into()?);
                let bits = u16::from_le_bytes(chunk[14..16].try_into()?);
                ensure!(
                    format == 1 && channels == 1 && sample_rate == TARGET_SAMPLE_RATE && bits == 16,
                    "需要 16 kHz 单声道 PCM16，实际格式码 {format}、{channels} 声道、{sample_rate} Hz、{bits} 位"
                );
                ensure!(
                    block_align == 2 && byte_rate == TARGET_SAMPLE_RATE * 2,
                    "PCM 块对齐或字节率无效"
                );
                have_format = true;
            }
            b"data" => {
                ensure!(data.is_none(), "WAV 包含重复的 data 块");
                ensure!(
                    !chunk.is_empty() && chunk.len() % 2 == 0,
                    "PCM16 数据为空或有不完整的采样点"
                );
                data = Some(chunk);
            }
            _ => {}
        }
        position = end.checked_add(size % 2).context("WAV 填充大小溢出")?;
        ensure!(position <= riff_end, "WAV 块缺少偶数字节对齐填充");
    }
    ensure!(have_format, "WAV 缺少 fmt 块");
    let data = data.context("WAV 缺少 data 块")?;
    Ok(data
        .chunks_exact(2)
        .map(|sample| i16::from_le_bytes([sample[0], sample[1]]) as f32 / 32768.0)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fmt_chunk(format: u16, channels: u16, sample_rate: u32, bits: u16) -> Vec<u8> {
        let align = channels * (bits / 8);
        [
            format.to_le_bytes().to_vec(),
            channels.to_le_bytes().to_vec(),
            sample_rate.to_le_bytes().to_vec(),
            (sample_rate * align as u32).to_le_bytes().to_vec(),
            align.to_le_bytes().to_vec(),
            bits.to_le_bytes().to_vec(),
        ]
        .concat()
    }

    fn wav(chunks: &[(&[u8; 4], Vec<u8>)]) -> Vec<u8> {
        let mut payload = b"WAVE".to_vec();
        for (id, chunk) in chunks {
            payload.extend_from_slice(*id);
            payload.extend_from_slice(&(chunk.len() as u32).to_le_bytes());
            payload.extend_from_slice(chunk);
            if chunk.len() % 2 != 0 {
                payload.push(0);
            }
        }
        [
            b"RIFF".to_vec(),
            (payload.len() as u32).to_le_bytes().to_vec(),
            payload,
        ]
        .concat()
    }

    #[test]
    fn pcm16_is_normalized_and_ancillary_chunks_are_skipped() {
        let bytes = wav(&[
            (b"JUNK", vec![1, 2, 3]),
            (b"fmt ", fmt_chunk(1, 1, 16000, 16)),
            (b"LIST", vec![4, 5]),
            (
                b"data",
                [i16::MIN, 0, i16::MAX]
                    .into_iter()
                    .flat_map(i16::to_le_bytes)
                    .collect(),
            ),
        ]);
        let samples = parse_pcm16_wav(&bytes).unwrap();
        assert_eq!(samples, [-1.0, 0.0, 32767.0 / 32768.0]);
    }

    #[test]
    fn data_before_format_is_supported() {
        let bytes = wav(&[(b"data", vec![0, 0]), (b"fmt ", fmt_chunk(1, 1, 16000, 16))]);
        assert_eq!(parse_pcm16_wav(&bytes).unwrap(), [0.0]);
    }

    #[test]
    fn unsupported_sample_formats_are_rejected() {
        for format in [
            fmt_chunk(3, 1, 16000, 32),
            fmt_chunk(1, 2, 16000, 16),
            fmt_chunk(1, 1, 48000, 16),
        ] {
            let bytes = wav(&[(b"fmt ", format), (b"data", vec![0; 4])]);
            assert!(parse_pcm16_wav(&bytes).is_err());
        }
        let mut format = fmt_chunk(1, 1, 16000, 16);
        format[12] = 4;
        assert!(parse_pcm16_wav(&wav(&[(b"fmt ", format), (b"data", vec![0; 2])])).is_err());
    }

    #[test]
    fn malformed_and_incomplete_wav_files_fail_without_panicking() {
        let valid = wav(&[(b"fmt ", fmt_chunk(1, 1, 16000, 16)), (b"data", vec![0, 0])]);
        for length in 0..valid.len() {
            assert!(parse_pcm16_wav(&valid[..length]).is_err());
        }
        let mut invalid_chunk = valid.clone();
        invalid_chunk[40..44].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(parse_pcm16_wav(&invalid_chunk).is_err());
        for data in [Vec::new(), vec![0], vec![0, 0, 0]] {
            assert!(parse_pcm16_wav(&wav(&[
                (b"fmt ", fmt_chunk(1, 1, 16000, 16)),
                (b"data", data)
            ]))
            .is_err());
        }
        assert!(parse_pcm16_wav(&wav(&[(b"data", vec![0, 0])])).is_err());
        assert!(parse_pcm16_wav(&wav(&[(b"fmt ", fmt_chunk(1, 1, 16000, 16))])).is_err());
    }

    #[test]
    fn duplicate_wav_chunks_are_rejected() {
        let format = fmt_chunk(1, 1, 16000, 16);
        assert!(parse_pcm16_wav(&wav(&[
            (b"fmt ", format.clone()),
            (b"fmt ", format.clone()),
            (b"data", vec![0, 0])
        ]))
        .is_err());
        assert!(parse_pcm16_wav(&wav(&[
            (b"fmt ", format),
            (b"data", vec![0, 0]),
            (b"data", vec![0, 0])
        ]))
        .is_err());
    }

    #[test]
    fn cli_requires_a_model_root_and_accepts_an_optional_wav() {
        let args = |values: &[&str]| values.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(
            parse_args(args(&["--models-root", "models", "--wav", "sample.wav"])).unwrap(),
            Some(Options {
                models_root: "models".into(),
                wav: Some("sample.wav".into())
            })
        );
        assert_eq!(parse_args(args(&["--help"])).unwrap(), None);
        for values in [
            &[][..],
            &["--models-root"][..],
            &["--wav", "sample.wav"][..],
            &["--models-root", "--wav", "sample.wav"][..],
            &["--models-root", "one", "--models-root", "two"][..],
            &["--unknown"][..],
        ] {
            assert!(parse_args(args(values)).is_err(), "{values:?}");
        }
    }
}
