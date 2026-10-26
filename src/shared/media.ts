import { convertFileSrc } from '@tauri-apps/api/core'
import { call } from './ipc'
import type { LibraryRecord } from './types'

export interface MediaJobInfo {
  jobId: string
  sourceId: string
  status: 'preparing' | 'uploading' | 'queued' | 'running' | 'completed' | 'cancelled' | 'failed'
  phase: string
  progress: number
  error?: string | null
  recordId?: string | null
}

export interface MediaProcessOptions {
  title?: string
  sourceLang?: 'en' | 'zh'
  translate?: boolean
  mode?: 'transcribe' | 'translate'
  signal?: AbortSignal
  onProgress?: (job: MediaJobInfo) => void
}

interface Preparation {
  job: MediaJobInfo
  media: { sourceId: string; path: string; originalName: string; kind: 'audio' | 'video'; sizeBytes: number } | null
  pcmReady: boolean
}

const SAMPLE_RATE = 16_000
const CHUNK_BYTES = 64 * 1024
const MAX_PCM_BYTES = 128 * 1024 * 1024
const MAX_MEDIA_BYTES = 512 * 1024 * 1024
const MAX_DURATION_SECONDS = 3600

function commandOptions(options: MediaProcessOptions) {
  return { title: options.title, sourceLang: options.sourceLang, translate: options.translate, mode: options.mode }
}

function checkCancelled(options: MediaProcessOptions) {
  if (options.signal?.aborted) throw new Error('导入已取消')
}

export function mediaJobStatus(jobId: string): Promise<MediaJobInfo> {
  return call<MediaJobInfo>('media_job_status', { jobId })
}

export function cancelMediaJob(jobId: string): Promise<MediaJobInfo> {
  return call<MediaJobInfo>('media_job_cancel', { jobId })
}

export function importSubtitleFile(
  path: string,
  options: { mediaPath?: string; title?: string } = {},
): Promise<LibraryRecord> {
  return call<LibraryRecord>('media_import_subtitles', { path, ...options })
}

function encodeBase64(bytes: Uint8Array): string {
  const pieces: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
  }
  return btoa(pieces.join(''))
}

export function pcmChunk(buffer: AudioBuffer, offset: number, frameCount: number): Uint8Array {
  const bytes = new Uint8Array(frameCount * 2)
  const view = new DataView(bytes.buffer)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
  for (let index = 0; index < frameCount; index++) {
    let mono = 0
    for (const channel of channels) mono += channel[offset + index] / channels.length
    const sample = Number.isFinite(mono) ? Math.max(-1, Math.min(1, mono)) : 0
    view.setInt16(index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
  }
  return bytes
}

async function uploadDecoded(preparation: Preparation, options: MediaProcessOptions): Promise<MediaJobInfo> {
  const { media, job } = preparation
  if (!media) throw new Error('资料没有保留的原媒体文件，请重新导入音频或视频')
  if (media.sizeBytes > MAX_MEDIA_BYTES) throw new Error('媒体文件超过 512 MiB 上限')
  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('当前系统 WebView 不支持离线音频解码，请使用 16 kHz 单声道 PCM16 WAV 文件')
  }
  checkCancelled(options)
  options.onProgress?.({ ...job, phase: 'decoding', progress: 1 })
  const response = await fetch(convertFileSrc(media.path), { signal: options.signal })
  if (!response.ok) throw new Error('无法读取已导入的本地媒体，请重新导入')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error('媒体文件超过 512 MiB 上限')
  checkCancelled(options)
  let buffer: AudioBuffer
  try {
    // decodeAudioData resamples to this context's 16 kHz sample rate without real-time playback.
    const context = new OfflineAudioContext(1, 1, SAMPLE_RATE)
    buffer = await context.decodeAudioData(bytes)
  } catch {
    throw new Error(
      '当前系统 WebView 无法解码此文件的音轨；请转换为 16 kHz 单声道 PCM16 WAV 后导入。格式支持由系统编解码器决定。',
    )
  }
  checkCancelled(options)
  if (buffer.sampleRate !== SAMPLE_RATE)
    throw new Error('系统解码器未返回 16 kHz 音频，请转换为 16 kHz 单声道 PCM16 WAV 后导入')
  if (!buffer.length || !buffer.numberOfChannels) throw new Error('媒体没有可识别的音轨')
  if (buffer.duration > MAX_DURATION_SECONDS) throw new Error('前端解码暂支持最长 1 小时媒体，请先分割文件')
  if (buffer.length * 2 > MAX_PCM_BYTES) throw new Error('解码音频超过 128 MiB 上限，请先分割文件')
  const { uploadId } = await call<{ uploadId: string }>('media_upload_begin', {
    jobId: job.jobId,
    totalBytes: buffer.length * 2,
  })
  for (let offset = 0, index = 0; offset < buffer.length; index++) {
    checkCancelled(options)
    const frames = Math.min(CHUNK_BYTES / 2, buffer.length - offset)
    const chunk = pcmChunk(buffer, offset, frames)
    await call('media_upload_chunk', { uploadId, index, pcmBase64: encodeBase64(chunk) })
    offset += frames
    options.onProgress?.({ ...job, status: 'uploading', phase: 'uploading', progress: (offset / buffer.length) * 20 })
  }
  checkCancelled(options)
  return call<MediaJobInfo>('media_upload_finish', { jobId: job.jobId })
}

async function completePreparation(preparation: Preparation, options: MediaProcessOptions): Promise<MediaJobInfo> {
  const { job } = preparation
  try {
    options.onProgress?.(job)
    checkCancelled(options)
    const result =
      job.status !== 'preparing' && job.status !== 'uploading'
        ? job
        : preparation.pcmReady
          ? await call<MediaJobInfo>('media_upload_finish', { jobId: job.jobId })
          : await uploadDecoded(preparation, options)
    options.onProgress?.(result)
    return result
  } catch (error) {
    try {
      await cancelMediaJob(job.jobId)
    } catch (cleanupError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}；取消未完成上传失败：${String(cleanupError)}`,
      )
    }
    throw error
  }
}

export async function importMediaFile(path: string, options: MediaProcessOptions = {}): Promise<MediaJobInfo> {
  checkCancelled(options)
  const preparation = await call<Preparation>('media_import', { path, options: commandOptions(options) })
  return completePreparation(preparation, options)
}

export async function reprocessMediaRecord(recordId: string, options: MediaProcessOptions = {}): Promise<MediaJobInfo> {
  checkCancelled(options)
  const preparation = await call<Preparation>('media_reprocess', { recordId, options: commandOptions(options) })
  return completePreparation(preparation, options)
}
