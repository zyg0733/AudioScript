pub mod local_nmt;
pub mod mock;
pub mod queue;
pub mod script;

use crate::config::TranslateConfig;

#[derive(Debug, thiserror::Error)]
pub enum TranslateError {
    #[error("翻译引擎未初始化")]
    NotInitialized,

    #[error("模型加载失败：{0}")]
    ModelLoad(String),

    #[error("模型目录缺少文件：{0}")]
    MissingModelFile(String),

    #[error("语言对不支持：{from} → {to}")]
    UnsupportedPair { from: String, to: String },

    #[error("译文无效（{reason}）：翻译方向可能设置错误")]
    Degenerate { reason: String },

    #[error("引擎内部错误：{0}")]
    Internal(String),
}

const UNK_MARKERS: [&str; 2] = ["<unk>", "⁇"];

const REPEAT_MIN_LEN: usize = 8;

const REPEAT_RATIO: f32 = 0.6;

const REPEAT_FLOOR: usize = 4;

const TRAILING_RUN: usize = 4;

pub fn degenerate_translation(text: &str) -> Option<String> {
    let t = text.trim();
    if t.is_empty() {
        return Some("空译文".into());
    }
    if let Some(m) = UNK_MARKERS.iter().find(|m| t.contains(**m)) {
        return Some(format!("含 {m}"));
    }

    let chars: Vec<char> = t.chars().filter(|c| !c.is_whitespace()).collect();
    if chars.len() < REPEAT_FLOOR {
        return None;
    }

    let mut counts: std::collections::HashMap<char, usize> = std::collections::HashMap::new();
    for c in &chars {
        *counts.entry(*c).or_default() += 1;
    }
    let (top, n) = counts
        .iter()
        .map(|(c, n)| (*c, *n))
        .max_by_key(|(_, n)| *n)?;
    let ratio = n as f32 / chars.len() as f32;

    if !top.is_numeric() && n == chars.len() {
        return Some(format!("整串重复同一字符「{top}」×{n}"));
    }

    if !top.is_numeric() && chars.len() >= REPEAT_MIN_LEN && ratio >= REPEAT_RATIO {
        return Some(format!("重复输出：「{top}」占 {:.0}%", ratio * 100.0));
    }

    if let Some(last) = chars.last() {
        let trailing = chars.iter().rev().take_while(|c| *c == last).count();
        if !last.is_numeric() && trailing >= TRAILING_RUN {
            return Some(format!("尾部重复「{last}」×{trailing}"));
        }
    }

    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TranslateCaps {
    pub incremental: bool,
    pub offline: bool,
    pub typical_latency_ms: u32,
}

impl TranslateCaps {
    pub const LOCAL_NMT: Self = Self {
        incremental: false,
        offline: true,
        typical_latency_ms: 300,
    };
}

pub trait Translator: Send {
    fn init(&mut self, cfg: &TranslateConfig) -> Result<(), TranslateError>;

    fn capabilities(&self) -> TranslateCaps;

    fn translate(&mut self, text: &str) -> Result<String, TranslateError>;

    fn shutdown(&mut self);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catches_unk_from_wrong_direction() {
        assert!(degenerate_translation("<unk>").is_some());
        assert!(degenerate_translation("他说 <unk> 和 <unk> 了").is_some());
    }

    #[test]
    fn catches_repetition_loops() {
        for s in [
            "来来来来来来",
            "的 的 的 的 的 的 的 的",
            "所以这里的关键洞见 关键是 我们需要谨慎地处理 长期间预算预算 。。。。。。。",
        ] {
            assert!(degenerate_translation(s).is_some(), "应判为退化：{s}");
        }
    }

    #[test]
    fn empty_output_is_degenerate() {
        assert!(degenerate_translation("").is_some());
        assert!(degenerate_translation("   ").is_some());
    }

    #[test]
    fn normal_translations_are_not_flagged() {
        for s in [
            "所以这里的关键洞察是我们需要处理延迟预算",
            "So the key insight here is that we need to handle the latency budget.",
            "让我来给你们讲讲架构如何将采集和推论分开。",
            "This is actually a really common mistake people make.",
            "The biggest problem with this programme is the delay.",
        ] {
            assert!(
                degenerate_translation(s).is_none(),
                "不该判为退化：{s}（{:?}）",
                degenerate_translation(s)
            );
        }
    }

    #[test]
    fn short_repeats_are_tolerated() {
        assert!(degenerate_translation("的的").is_none());
        assert!(degenerate_translation("嗯嗯").is_none());
    }

    #[test]
    fn natural_repetition_in_real_speech_survives() {
        assert!(degenerate_translation("这个真的很重要很重要").is_none());
    }

    #[test]
    fn repeated_digits_in_amounts_and_identifiers_are_not_degenerate() {
        for text in [
            "100000",
            "100,000,000",
            "1,000,000,000,000,000",
            "10000000 元",
            "0.000001",
            "编号 11111111",
            "验证码 0000",
            "１２３００００",
        ] {
            assert!(
                degenerate_translation(text).is_none(),
                "数字中的重复不得丢弃有效译文：{text}"
            );
        }
    }

    #[test]
    fn numeric_content_does_not_hide_real_repetition_loops() {
        for text in [
            "金额 100000。。。。",
            "的的的的的的的的的的的的的的 100000",
            "100000 来来来来",
        ] {
            assert!(
                degenerate_translation(text).is_some(),
                "仍需识别数字旁的退化输出：{text}"
            );
        }
    }
}
