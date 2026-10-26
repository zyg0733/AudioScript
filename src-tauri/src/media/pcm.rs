use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use base64::Engine;

pub const MAX_PCM_BYTES: u64 = 128 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct WavInfo {
    pub data_offset: u64,
    pub data_bytes: u64,
}
impl WavInfo {
    pub fn duration_ms(self) -> u64 {
        self.data_bytes * 1000 / 32_000
    }
}

pub fn inspect_wav(path: &Path) -> Result<WavInfo, String> {
    let mut file = File::open(path).map_err(|e| format!("无法读取 WAV：{e}"))?;
    inspect(&mut file)
}

fn inspect<R: Read + Seek>(reader: &mut R) -> Result<WavInfo, String> {
    let size = reader.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    reader.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut header = [0; 12];
    reader
        .read_exact(&mut header)
        .map_err(|_| "WAV 文件头不完整")?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Err("需要 RIFF/WAVE 音频".into());
    }
    let end = u32::from_le_bytes(header[4..8].try_into().unwrap()) as u64 + 8;
    if end > size || end < 12 {
        return Err("WAV 文件被截断".into());
    }
    let mut position = 12;
    let mut have_format = false;
    let mut data = None;
    while position < end {
        if end - position < 8 {
            return Err("WAV 块头被截断".into());
        }
        reader
            .seek(SeekFrom::Start(position))
            .map_err(|e| e.to_string())?;
        let mut block = [0; 8];
        reader
            .read_exact(&mut block)
            .map_err(|_| "WAV 块头不完整")?;
        let length = u32::from_le_bytes(block[4..].try_into().unwrap()) as u64;
        let offset = position + 8;
        if offset + length > end {
            return Err("WAV 块数据被截断".into());
        }
        match &block[..4] {
            b"fmt " => {
                if have_format || length < 16 {
                    return Err("WAV 格式块无效或重复".into());
                }
                let mut fmt = [0; 16];
                reader
                    .read_exact(&mut fmt)
                    .map_err(|_| "WAV 格式块不完整")?;
                let u16_at = |i| u16::from_le_bytes(fmt[i..i + 2].try_into().unwrap());
                let u32_at = |i| u32::from_le_bytes(fmt[i..i + 4].try_into().unwrap());
                if u16_at(0) != 1
                    || u16_at(2) != 1
                    || u32_at(4) != 16_000
                    || u32_at(8) != 32_000
                    || u16_at(12) != 2
                    || u16_at(14) != 16
                {
                    return Err("需要 16 kHz 单声道 PCM16 WAV；其他格式请由应用解码后导入".into());
                }
                have_format = true;
            }
            b"data" => {
                if data.is_some() || length == 0 || length % 2 != 0 {
                    return Err("WAV 音频数据为空、重复或不完整".into());
                }
                if length > MAX_PCM_BYTES {
                    return Err("解码音频超过 128 MiB 上限（16 kHz 单声道约 69 分钟）".into());
                }
                data = Some(WavInfo {
                    data_offset: offset,
                    data_bytes: length,
                });
            }
            _ => {}
        }
        position = offset + length + length % 2;
        if position > end {
            return Err("WAV 缺少对齐填充".into());
        }
    }
    if !have_format {
        return Err("WAV 缺少格式块".into());
    }
    data.ok_or_else(|| "WAV 缺少音频数据".into())
}

fn header(bytes: u64) -> [u8; 44] {
    let mut value = [0; 44];
    value[..4].copy_from_slice(b"RIFF");
    value[4..8].copy_from_slice(&(bytes as u32 + 36).to_le_bytes());
    value[8..16].copy_from_slice(b"WAVEfmt ");
    value[16..20].copy_from_slice(&16u32.to_le_bytes());
    value[20..22].copy_from_slice(&1u16.to_le_bytes());
    value[22..24].copy_from_slice(&1u16.to_le_bytes());
    value[24..28].copy_from_slice(&16_000u32.to_le_bytes());
    value[28..32].copy_from_slice(&32_000u32.to_le_bytes());
    value[32..34].copy_from_slice(&2u16.to_le_bytes());
    value[34..36].copy_from_slice(&16u16.to_le_bytes());
    value[36..40].copy_from_slice(b"data");
    value[40..44].copy_from_slice(&(bytes as u32).to_le_bytes());
    value
}

pub struct Upload {
    pub job_id: String,
    pub next_index: u32,
    pub received: u64,
    expected: u64,
    file: Option<File>,
    temporary: PathBuf,
    destination: PathBuf,
}

impl Upload {
    pub fn fraction(&self) -> f32 {
        self.received as f32 / self.expected as f32
    }

    pub fn new(job_id: String, directory: &Path, expected: u64) -> Result<Self, String> {
        if expected == 0 || expected > MAX_PCM_BYTES || expected % 2 != 0 {
            return Err("PCM 长度无效；需要非空 PCM16，最多 128 MiB".into());
        }
        let temporary = directory.join(format!("{}.part", uuid::Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| format!("创建临时音频失败：{e}"))?;
        if let Err(error) = file.write_all(&[0; 44]) {
            drop(file);
            let _ = std::fs::remove_file(&temporary);
            return Err(format!("写入临时音频失败：{error}"));
        }
        Ok(Self {
            job_id,
            next_index: 0,
            received: 0,
            expected,
            file: Some(file),
            temporary,
            destination: directory.join(format!("pcm-{}.wav", uuid::Uuid::new_v4())),
        })
    }

    pub fn append(&mut self, index: u32, encoded: &str) -> Result<(), String> {
        if index != self.next_index {
            return Err(format!(
                "音频分块顺序错误：预期 {}，收到 {index}",
                self.next_index
            ));
        }
        if encoded.len() > CHUNK_BYTES.div_ceil(3) * 4 {
            return Err("音频分块超过 64 KiB 上限".into());
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|_| "音频分块不是有效 Base64")?;
        if bytes.is_empty()
            || bytes.len() > CHUNK_BYTES
            || bytes.len() % 2 != 0
            || self.received + bytes.len() as u64 > self.expected
        {
            return Err("音频分块为空、不完整或超过声明的总长度".into());
        }
        self.file
            .as_mut()
            .ok_or("上传已结束")?
            .write_all(&bytes)
            .map_err(|e| format!("写入音频分块失败：{e}"))?;
        self.received += bytes.len() as u64;
        self.next_index += 1;
        Ok(())
    }

    pub fn finish(mut self) -> Result<PathBuf, String> {
        if self.received != self.expected {
            return Err(format!(
                "音频上传不完整：{} / {} 字节",
                self.received, self.expected
            ));
        }
        let mut file = self.file.take().ok_or("上传已结束")?;
        file.seek(SeekFrom::Start(0))
            .and_then(|_| file.write_all(&header(self.received)))
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("保存音频失败：{e}"))?;
        drop(file);
        std::fs::rename(&self.temporary, &self.destination)
            .map_err(|e| format!("完成音频上传失败：{e}"))?;
        Ok(self.destination.clone())
    }
}

impl Drop for Upload {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.temporary);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("audioscript-pcm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn ordered_chunks_create_complete_wav_and_cancel_or_incomplete_upload_removes_parts() {
        let dir = directory();
        let encode = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
        let mut upload = Upload::new("job".into(), &dir, 8).unwrap();
        assert!(upload.append(1, &encode(&[0, 0])).is_err());
        upload.append(0, &encode(&[0, 0, 1, 0])).unwrap();
        assert!(upload.append(0, &encode(&[0, 0])).is_err());
        upload.append(1, &encode(&[2, 0, 3, 0])).unwrap();
        let path = upload.finish().unwrap();
        assert_eq!(inspect_wav(&path).unwrap().data_bytes, 8);
        let unfinished = Upload::new("cancel".into(), &dir, 4).unwrap();
        assert!(unfinished.finish().is_err());
        drop(Upload::new("cancel".into(), &dir, 4).unwrap());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn invalid_pcm_sizes_and_truncated_wavs_are_rejected() {
        let dir = directory();
        for size in [0, 1, MAX_PCM_BYTES + 2] {
            assert!(Upload::new("job".into(), &dir, size).is_err());
        }
        let mut bytes = header(4).to_vec();
        bytes.extend([0; 4]);
        assert_eq!(inspect(&mut Cursor::new(&bytes)).unwrap().data_bytes, 4);
        for end in 0..bytes.len() {
            assert!(inspect(&mut Cursor::new(&bytes[..end])).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
