import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importMediaFile, pcmChunk, reprocessMediaRecord } from './media'

const mocks = vi.hoisted(() => ({ call: vi.fn(), fetch: vi.fn(), decode: vi.fn() }))
vi.mock('./ipc', () => ({ call: mocks.call }))
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => `asset:${path}` }))

const preparing = { jobId: 'job', sourceId: 'source', status: 'preparing', phase: 'decoding', progress: 0 }
const queued = { ...preparing, status: 'queued', phase: 'queued', progress: 20 }

function audioBuffer(length = 32771): AudioBuffer {
  const channels = [new Float32Array(length).fill(1), new Float32Array(length).fill(-0.5)]
  return {
    length,
    numberOfChannels: 2,
    sampleRate: 16000,
    duration: length / 16000,
    getChannelData: (index: number) => channels[index],
  } as AudioBuffer
}

describe('local media decoding and sequential upload', () => {
  beforeEach(() => {
    mocks.call.mockReset().mockImplementation(async (name: string) => {
      if (name === 'media_import' || name === 'media_reprocess')
        return {
          job: preparing,
          pcmReady: false,
          media: { path: '/managed/source.mp3', sourceId: 'source', sizeBytes: 32, kind: 'audio' },
        }
      if (name === 'media_upload_begin') return { uploadId: 'upload' }
      if (name === 'media_upload_finish') return queued
      if (name === 'media_job_cancel') return { ...preparing, status: 'cancelled' }
      return { nextIndex: 1 }
    })
    mocks.fetch.mockReset().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(16) })
    mocks.decode.mockReset().mockResolvedValue(audioBuffer())
    vi.stubGlobal('fetch', mocks.fetch)
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        constructor(channels: number, length: number, sampleRate: number) {
          expect([channels, length, sampleRate]).toEqual([1, 1, 16000])
        }
        decodeAudioData(bytes: ArrayBuffer) {
          return mocks.decode(bytes)
        }
      },
    )
  })
  afterEach(() => vi.unstubAllGlobals())

  it('mixes channels, clamps samples and encodes signed little endian PCM16', () => {
    const buffer = {
      numberOfChannels: 1,
      getChannelData: () => Float32Array.from([-2, -1, 0, 1, 2, Number.NaN]),
    } as unknown as AudioBuffer
    const bytes = pcmChunk(buffer, 0, 6)
    const view = new DataView(bytes.buffer)
    expect(Array.from({ length: 6 }, (_, index) => view.getInt16(index * 2, true))).toEqual([
      -32768, -32768, 0, 32767, 32767, 0,
    ])
    expect(new DataView(pcmChunk(audioBuffer(1), 0, 1).buffer).getInt16(0, true)).toBe(8192)
  })

  it('uploads at most 64 KiB per call in strict sequence and submits only after all bytes', async () => {
    let active = false
    const original = mocks.call.getMockImplementation()
    mocks.call.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'media_upload_chunk') {
        expect(active).toBe(false)
        active = true
        await Promise.resolve()
        active = false
      }
      return original?.(name, args)
    })
    const progress = vi.fn()
    expect(await importMediaFile('/selected/audio.mp3', { sourceLang: 'en', onProgress: progress })).toEqual(queued)
    const chunks = mocks.call.mock.calls.filter(([name]) => name === 'media_upload_chunk')
    expect(chunks.map(([, args]) => args.index)).toEqual([0, 1])
    const byteLengths = chunks.map(([, args]) => atob(args.pcmBase64).length)
    expect(byteLengths).toEqual([65536, 6])
    expect(mocks.call).toHaveBeenLastCalledWith('media_upload_finish', { jobId: 'job' })
    expect(progress.mock.calls[0][0]).toEqual(preparing)
    expect(mocks.fetch).toHaveBeenCalledWith('asset:/managed/source.mp3', { signal: undefined })
  })

  it('cancels and cleans an interrupted upload without submitting an incomplete task', async () => {
    const controller = new AbortController()
    const original = mocks.call.getMockImplementation()
    mocks.call.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'media_upload_chunk') controller.abort()
      return original?.(name, args)
    })
    await expect(importMediaFile('/selected/audio.mp3', { signal: controller.signal })).rejects.toThrow('取消')
    expect(mocks.call.mock.calls.filter(([name]) => name === 'media_upload_chunk')).toHaveLength(1)
    expect(mocks.call).toHaveBeenLastCalledWith('media_job_cancel', { jobId: 'job' })
    expect(mocks.call.mock.calls.some(([name]) => name === 'media_upload_finish')).toBe(false)
  })

  it('reports codec failures explicitly and cancels rather than pretending the file was processed', async () => {
    mocks.decode.mockRejectedValueOnce(new Error('unsupported codec'))
    await expect(importMediaFile('/selected/movie.mkv')).rejects.toThrow('WebView 无法解码')
    expect(mocks.call).toHaveBeenLastCalledWith('media_job_cancel', { jobId: 'job' })
    expect(mocks.call.mock.calls.some(([name]) => name === 'media_upload_begin')).toBe(false)
  })

  it('uses retained valid WAV or queued text refinement without decoding the media again', async () => {
    mocks.call.mockImplementation(async (name: string) =>
      name === 'media_import'
        ? { job: preparing, media: { path: '/managed/source.wav', sizeBytes: 44 }, pcmReady: true }
        : name === 'media_reprocess'
          ? { job: queued, media: null, pcmReady: false }
          : queued,
    )
    expect(await importMediaFile('/selected/audio.wav')).toEqual(queued)
    expect(mocks.call).toHaveBeenLastCalledWith('media_upload_finish', { jobId: 'job' })
    expect(await reprocessMediaRecord('record', { mode: 'translate' })).toEqual(queued)
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(mocks.decode).not.toHaveBeenCalled()
  })

  it('rejects overlong decoded audio before upload and surfaces cleanup errors', async () => {
    mocks.decode.mockResolvedValueOnce({ ...audioBuffer(1), duration: 3601 })
    await expect(importMediaFile('/selected/audio.mp3')).rejects.toThrow('最长 1 小时')
    expect(mocks.call.mock.calls.some(([name]) => name === 'media_upload_begin')).toBe(false)

    mocks.decode.mockRejectedValueOnce(new Error('unsupported'))
    mocks.call.mockImplementationOnce(async () => ({
      job: preparing,
      pcmReady: false,
      media: { path: '/managed/file', sizeBytes: 1 },
    }))
    mocks.call.mockRejectedValueOnce(new Error('cancel failed'))
    await expect(importMediaFile('/selected/audio.mp3')).rejects.toThrow('取消未完成上传失败')
  })
})
