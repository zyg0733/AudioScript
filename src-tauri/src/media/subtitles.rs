use crate::transcript::{SegmentState, TranscriptSegment, TranslationState};

pub const MAX_SUBTITLE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CUES: usize = 50_000;

fn timestamp(value: &str) -> Result<u64, String> {
    let normalized = value.replace(',', ".");
    let parts: Vec<_> = normalized.split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return Err(format!("字幕时间无效：{value}"));
    }
    let number = |s: &str| -> Result<u64, String> {
        if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) {
            return Err("字幕时间必须为数字".into());
        }
        s.parse().map_err(|_| "字幕时间超出范围".into())
    };
    let (hours, minutes) = if parts.len() == 3 {
        (number(parts[0])?, number(parts[1])?)
    } else {
        (0, number(parts[0])?)
    };
    let (seconds, millis) = parts[parts.len() - 1]
        .split_once('.')
        .ok_or("字幕时间缺少毫秒")?;
    if millis.len() != 3 {
        return Err("字幕毫秒需要三位数字".into());
    }
    let seconds = number(seconds)?;
    let millis = number(millis)?;
    if minutes >= 60 || seconds >= 60 || hours > 999 {
        return Err("字幕时间超出范围".into());
    }
    Ok(((hours * 60 + minutes) * 60 + seconds) * 1000 + millis)
}

fn plain_text(text: &str) -> String {
    let mut output = String::new();
    let mut remaining = text;
    while let Some(start) = remaining.find('<') {
        output.push_str(&remaining[..start]);
        remaining = &remaining[start..];
        if let Some(end) = remaining.find('>') {
            let inside = &remaining[1..end];
            let tag = inside
                .trim_start_matches('/')
                .split([' ', '.', '\t'])
                .next()
                .unwrap_or("");
            if matches!(
                tag,
                "b" | "i"
                    | "u"
                    | "c"
                    | "v"
                    | "lang"
                    | "ruby"
                    | "rt"
                    | "font"
                    | "span"
                    | "strong"
                    | "em"
            ) || timestamp(inside).is_ok()
            {
                remaining = &remaining[end + 1..];
                continue;
            }
        }
        output.push('<');
        remaining = &remaining[1..];
    }
    output.push_str(remaining);
    output
        .trim()
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&quot;", "\"")
        .replace("&amp;", "&")
}

pub fn parse(text: &str) -> Result<Vec<TranscriptSegment>, String> {
    if text.len() > MAX_SUBTITLE_BYTES {
        return Err("字幕文件超过 4 MiB 上限".into());
    }
    let normalized = text
        .trim_start_matches('\u{feff}')
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let text = normalized
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n");
    let mut segments = Vec::new();
    for block in text.split("\n\n") {
        let lines: Vec<_> = block.trim().lines().map(str::trim).collect();
        let Some(first) = lines.first().filter(|line| !line.is_empty()) else {
            continue;
        };
        if first.starts_with("WEBVTT")
            || *first == "NOTE"
            || first.starts_with("NOTE ")
            || first.starts_with("NOTE\t")
            || *first == "STYLE"
            || *first == "REGION"
        {
            continue;
        }
        let Some(index) = lines.iter().position(|line| line.contains("-->")) else {
            return Err("字幕块缺少起止时间；仅支持 SRT / WebVTT 字幕".into());
        };
        let (start, end) = lines[index].split_once("-->").ok_or("字幕时间格式无效")?;
        let start_ms = timestamp(start.trim())?;
        let end_ms = timestamp(end.split_whitespace().next().ok_or("字幕缺少结束时间")?)?;
        if end_ms <= start_ms {
            return Err("字幕结束时间必须晚于开始时间".into());
        }
        let text = plain_text(&lines[index + 1..].join("\n"));
        if text.is_empty() {
            continue;
        }
        segments.push(TranscriptSegment {
            id: uuid::Uuid::new_v4().to_string(),
            start_ms,
            end_ms,
            text,
            translation: None,
            translation_state: TranslationState::Idle,
            translation_error: None,
            state: SegmentState::Final,
            revision: 1,
        });
        if segments.len() > MAX_CUES {
            return Err("字幕超过 50000 段上限".into());
        }
    }
    if segments.is_empty() {
        return Err("字幕中没有可导入的有效段落".into());
    }
    segments.sort_by_key(|segment| (segment.start_ms, segment.end_ms));
    Ok(segments)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_handles_bom_crlf_multiline_and_overlapping_cues() {
        let cues = parse("\u{feff}1\r\n00:00:01,200 --> 00:00:03,004\r\nHello\r\nworld\r\n\r\n2\r\n00:00:02,000 --> 00:00:04,000\r\n第二段\r\n").unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!((cues[0].start_ms, cues[0].end_ms), (1200, 3004));
        assert_eq!(cues[0].text, "Hello\nworld");
        assert_ne!(cues[0].id, cues[1].id);
    }

    #[test]
    fn vtt_handles_identifiers_settings_and_metadata_without_inventing_translations() {
        let cues = parse("WEBVTT\n\nNOTE this is metadata\nignored\n\ncue-id\n01:02.003 --> 01:03.004 align:start\n<v Alice><b>Hello</b></v>\n").unwrap();
        assert_eq!(cues[0].start_ms, 62_003);
        assert_eq!(cues[0].text, "Hello");
        assert_eq!(cues[0].translation_state, TranslationState::Idle);
    }

    #[test]
    fn invalid_times_and_missing_cues_fail_explicitly() {
        for text in [
            "WEBVTT\n",
            "1\nnot a timestamp\nhello",
            "00:99:00,000 --> 01:00:00,000\nhello",
            "00:00.000 --> 00:00.000\nhello",
            "00:00.001 --> 00:00.000\nhello",
            "00:00.x00 --> 00:01.000\nhello",
        ] {
            assert!(parse(text).is_err(), "{text}");
        }
    }

    #[test]
    fn extra_blank_lines_do_not_drop_cues_or_strip_technical_angle_brackets() {
        let cues=parse("00:00.000 --> 00:01.000\nVec<T> and x < 2\n\n  \n\n00:01.000 --> 00:02.000\n&lt;b&gt; literal &amp; escaped").unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].text, "Vec<T> and x < 2");
        assert_eq!(cues[1].text, "<b> literal & escaped");
    }
}
