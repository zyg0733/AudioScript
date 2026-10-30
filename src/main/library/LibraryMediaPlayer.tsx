import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { type TranscriptSegment, TranslationState } from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { Select } from '@/ui/Select'
import { positionLabel } from './fields'

export interface PlaybackTarget {
  startMs: number
  endMs?: number
  play: boolean
  sequence: number
}

interface Props {
  recordId: string
  path: string
  segments: TranscriptSegment[]
  target: PlaybackTarget | null
}

const speeds = ['0.5', '0.75', '1', '1.25', '1.5', '2']
const storageKey = (recordId: string) => `audioscript:playback:${recordId}`

function writeProgress(recordId: string, path: string, value: { position: number; rate: string; loaded: boolean }) {
  if (!value.loaded || !Number.isFinite(value.position) || value.position < 0) return
  try {
    localStorage.setItem(storageKey(recordId), JSON.stringify({ path, position: value.position, rate: value.rate }))
  } catch {
    // 私密模式或空间不足时继续播放。
  }
}

function readProgress(recordId: string, path: string): { position: number; rate: string } {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(recordId)) ?? 'null')
    if (value?.path === path) {
      return {
        position:
          typeof value.position === 'number' && Number.isFinite(value.position) && value.position >= 0
            ? value.position
            : 0,
        rate: speeds.includes(String(value.rate)) ? String(value.rate) : '1',
      }
    }
  } catch {
    // 播放进度不可用不影响媒体回放。
  }
  return { position: 0, rate: '1' }
}

function captionTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(Math.floor(ms) % 1000).padStart(3, '0')}`
}

export function LibraryMediaPlayer({ recordId, path, segments, target }: Props) {
  const player = useRef<HTMLMediaElement | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [captionUrl, setCaptionUrl] = useState<string | null>(null)
  const [position, setPosition] = useState(0)
  const [rate, setRate] = useState(() => readProgress(recordId, path).rate)
  const [loop, setLoop] = useState(false)
  const [restored, setRestored] = useState<number | null>(null)
  const clip = useRef<{ start: number; end: number } | null>(null)
  const loopRef = useRef(loop)
  loopRef.current = loop
  const video = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i.test(path)
  const progress = useRef({ position: 0, rate: '1', loaded: false })
  const lastWrite = useRef(0)

  function persistProgress() {
    writeProgress(recordId, path, progress.current)
  }

  useEffect(() => {
    const text = `WEBVTT\n\n${segments
      .filter((segment) => segment.endMs > segment.startMs)
      .map(
        (segment, index) =>
          `${index + 1}\n${captionTime(segment.startMs)} --> ${captionTime(segment.endMs)}\n${segment.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n`,
      )
      .join('\n')}`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }))
    setCaptionUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [segments])

  useEffect(() => {
    const saved = readProgress(recordId, path)
    setRate(saved.rate)
    setFailure(null)
    setRestored(null)
    setPosition(0)
    clip.current = null
    progress.current = { position: 0, rate: saved.rate, loaded: false }
    const persist = () => writeProgress(recordId, path, progress.current)
    window.addEventListener('pagehide', persist)
    return () => {
      persist()
      window.removeEventListener('pagehide', persist)
    }
  }, [recordId, path])

  function applyTarget() {
    const element = player.current
    if (!element || !target) return
    element.currentTime = target.startMs / 1000
    progress.current.position = element.currentTime
    setPosition(element.currentTime)
    setRestored(null)
    clip.current =
      target.play && target.endMs !== undefined && target.endMs > target.startMs
        ? { start: target.startMs / 1000, end: target.endMs / 1000 }
        : null
    if (target.play) {
      void element
        .play()
        .then(() => setFailure(null))
        .catch(() => setFailure('暂时无法播放此片段，请使用播放器的播放按钮重试。'))
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: sequence 标识每一次引用跳转，包括重复点击同一段。
  useEffect(applyTarget, [target?.sequence, path])

  function loaded() {
    const element = player.current
    if (!element) return
    const saved = readProgress(recordId, path)
    element.playbackRate = Number(progress.current.rate)
    progress.current.loaded = true
    if (target) applyTarget()
    else if (saved.position > 0 && Number.isFinite(element.duration) && saved.position < element.duration - 0.5) {
      element.currentTime = saved.position
      setPosition(saved.position)
      setRestored(saved.position)
    }
    progress.current.position = element.currentTime
  }

  function timeUpdate() {
    const element = player.current
    if (!element) return
    const range = clip.current
    if (range && element.currentTime >= range.end) {
      if (loopRef.current) {
        element.currentTime = range.start
        if (element.paused) void element.play().catch(() => setFailure('暂时无法继续循环，请点击播放重试。'))
      } else {
        element.pause()
        clip.current = null
      }
    }
    setPosition(element.currentTime)
    progress.current.position = element.currentTime
    if (Date.now() - lastWrite.current > 5000) {
      persistProgress()
      lastWrite.current = Date.now()
    }
  }

  function seeking() {
    const element = player.current
    const range = clip.current
    if (element && range && (element.currentTime < range.start - 0.1 || element.currentTime > range.end + 0.1))
      clip.current = null
  }

  const current = segments.find((segment) => segment.startMs <= position * 1000 && segment.endMs > position * 1000)
  const props = {
    src: convertFileSrc(path),
    controls: true,
    preload: 'metadata',
    onTimeUpdate: timeUpdate,
    onLoadedMetadata: loaded,
    onSeeking: seeking,
    onPause: () => {
      if (player.current) progress.current.position = player.current.currentTime
      persistProgress()
    },
    onRateChange: () => {
      if (player.current) {
        const next = String(player.current.playbackRate)
        if (speeds.includes(next)) {
          setRate(next)
          progress.current.rate = next
          persistProgress()
        }
      }
    },
    onError: () => setFailure('无法回放此媒体，请确认文件仍存在且格式受播放器支持。'),
    className: 'w-full rounded-[var(--radius-panel)]',
  }

  return (
    <section className="space-y-3" aria-label="来源媒体播放器">
      {failure && <Alert tone="warn">{failure}</Alert>}
      {video ? (
        <video
          {...props}
          ref={(element) => {
            player.current = element
          }}
          aria-label="来源视频"
        >
          {captionUrl && <track kind="captions" src={captionUrl} srcLang="und" label="原文字幕" default />}
        </video>
      ) : (
        <audio
          {...props}
          ref={(element) => {
            player.current = element
          }}
          aria-label="来源音频"
        >
          {captionUrl && <track kind="captions" src={captionUrl} srcLang="und" label="原文字幕" />}
        </audio>
      )}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Select
          label="播放速度"
          value={rate}
          onChange={(value) => {
            setRate(value)
            progress.current.rate = value
            if (player.current) player.current.playbackRate = Number(value)
            persistProgress()
          }}
          options={speeds.map((value) => ({ value, label: `${value}×` }))}
        />
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />
          回听时循环当前片段
        </label>
        {restored !== null && (
          <span className="text-[var(--color-ink-2)]">已恢复到 {positionLabel(restored * 1000)}，点击播放继续。</span>
        )}
        {target && (
          <span className="text-[var(--color-ink-2)]">
            {target.play ? '片段回放' : '已定位'} {positionLabel(target.startMs)}
            {target.endMs !== undefined && `–${positionLabel(target.endMs)}`}
          </span>
        )}
      </div>
      <section
        aria-label="当前播放字幕"
        className="min-h-16 rounded-[var(--radius-panel)] bg-[var(--color-surface-1)] p-3 text-sm leading-relaxed"
      >
        {current ? (
          <>
            <p className="whitespace-pre-wrap">{current.text}</p>
            {current.translationState === TranslationState.Done && current.translation && (
              <p className="mt-1 whitespace-pre-wrap text-[var(--color-ink-1)]">{current.translation}</p>
            )}
          </>
        ) : (
          <p className="text-[var(--color-ink-2)] text-xs">播放时在此显示对应的原文与译文。</p>
        )}
      </section>
    </section>
  )
}
