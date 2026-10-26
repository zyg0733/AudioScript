import { convertFileSrc } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import type { TranscriptSegment } from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { positionLabel } from './fields'

export interface PlaybackTarget {
  startMs: number
  endMs?: number
  play: boolean
  sequence: number
}

interface Props {
  path: string
  segments: TranscriptSegment[]
  target: PlaybackTarget | null
}

function captionTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}.${String(Math.floor(ms) % 1000).padStart(3, '0')}`
}

export function LibraryMediaPlayer({ path, segments, target }: Props) {
  const player = useRef<HTMLMediaElement | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [captionUrl, setCaptionUrl] = useState<string | null>(null)
  const stopAt = useRef<number | null>(null)
  const video = /\.(mp4|m4v|mov|webm|mkv|ogv)$/i.test(path)

  useEffect(() => {
    const text = `WEBVTT\n\n${segments
      .filter((segment) => segment.endMs > segment.startMs)
      .map(
        (segment, index) =>
          `${index + 1}\n${captionTime(segment.startMs)} --> ${captionTime(segment.endMs)}\n${segment.text.replace(/-->/g, '→')}\n`,
      )
      .join('\n')}`
    const url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }))
    setCaptionUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [segments])

  useEffect(() => {
    if (!path) return
    setFailure(null)
    stopAt.current = null
  }, [path])

  function applyTarget() {
    const element = player.current
    if (!element || !target) return
    element.currentTime = target.startMs / 1000
    stopAt.current = target.play && target.endMs !== undefined ? target.endMs / 1000 : null
    if (target.play) {
      void element.play().catch(() => setFailure('暂时无法播放此片段，请使用播放器的播放按钮重试。'))
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: sequence 标识每一次引用跳转，包括重复点击同一段。
  useEffect(applyTarget, [target?.sequence, path])

  function checkEnd() {
    if (player.current && stopAt.current !== null && player.current.currentTime >= stopAt.current) {
      player.current.pause()
      stopAt.current = null
    }
  }

  const props = {
    src: convertFileSrc(path),
    controls: true,
    preload: 'metadata',
    onTimeUpdate: checkEnd,
    onLoadedMetadata: applyTarget,
    onError: () => setFailure('无法回放此媒体，请确认文件仍存在且格式受播放器支持。'),
    className: 'w-full rounded-[var(--radius-panel)]',
  }

  return (
    <section className="space-y-2" aria-label="来源媒体播放器">
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
      {target && (
        <p className="text-[var(--color-ink-2)] text-xs">
          {target.play ? '片段回放' : '已定位'} {positionLabel(target.startMs)}
          {target.endMs !== undefined && `–${positionLabel(target.endMs)}`}
        </p>
      )}
    </section>
  )
}
