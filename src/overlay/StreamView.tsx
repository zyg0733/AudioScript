import { type CSSProperties, memo, useEffect, useRef, useState } from 'react'
import { copyText, formatSegmentText } from '@/shared/clipboard'
import { OverlayMode, SegmentState, type TranscriptSegment, TranslationState } from '@/shared/types'
import { useTranscriptWindow } from '@/shared/useTranscriptWindow'

const SOURCE_SCALE = 0.8

const SOURCE_OPACITY = 0.7

const PARTIAL_OPACITY = 0.55

interface Props {
  segments: TranscriptSegment[]
  fontSize: number
  fontColor: string
  opacity: number
  bgColor: string
  glow: boolean
  mode: OverlayMode
  error?: string | null
  onReconnect?: () => void
  reconnecting?: boolean
}

export function StreamView({
  segments,
  fontSize,
  fontColor,
  opacity,
  bgColor,
  glow,
  mode,
  error,
  onReconnect,
  reconnecting,
}: Props) {
  const interactive = mode === OverlayMode.Edit
  const { scrollRef, following, hasUnseen, onScroll, followLatest, visible, earlier, later, page } =
    useTranscriptWindow(segments, {
      enabled: interactive,
      layoutKey: `${fontSize}:${error ?? ''}`,
    })
  const [copyNotice, setCopyNotice] = useState<{ text: string; failed: boolean } | null>(null)
  const [copying, setCopying] = useState(false)
  const copyingRef = useRef(false)
  const latestFinal = latestFinalSegment(segments)

  useEffect(() => {
    if (!copyNotice) return
    const timer = window.setTimeout(() => setCopyNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [copyNotice])

  async function copyLatest() {
    if (!latestFinal || copyingRef.current) return
    copyingRef.current = true
    setCopying(true)
    setCopyNotice(null)
    try {
      await copyText(formatSegmentText(latestFinal, 'bilingual'))
      setCopyNotice({ text: '已复制最新定稿', failed: false })
    } catch (e) {
      setCopyNotice({ text: e instanceof Error ? e.message : '复制失败，请重试', failed: true })
    } finally {
      copyingRef.current = false
      setCopying(false)
    }
  }

  const bg = hexToRgba(bgColor, opacity / 100)

  return (
    <div className="relative flex h-full w-full flex-col">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="relative min-h-0 w-full flex-1 overflow-y-auto rounded-[var(--radius-panel)] px-4 py-2"
        style={{
          background: bg,
          fontSize: `${fontSize}px`,
          color: fontColor,
          lineHeight: 1.35,
          scrollbarWidth: 'none',
          paddingTop: interactive ? 18 : 8,
          paddingBottom: interactive && (latestFinal || !following) ? 38 : 8,
          userSelect: interactive ? 'text' : 'none',
          WebkitUserSelect: interactive ? 'text' : 'none',
        }}
      >
        {error && (
          <p role="alert" className="m-0 text-[0.8em]">
            {error}
            {interactive && onReconnect && (
              <button type="button" disabled={reconnecting} onClick={onReconnect} className="ml-2 underline">
                {reconnecting ? '重连中…' : '重新同步'}
              </button>
            )}
          </p>
        )}
        {segments.length === 0 ? (
          <p className="m-0 text-[0.8em]" style={{ color: fontColor, opacity: 0.45 }}>
            等待识别…
          </p>
        ) : (
          visible.map((s) => <BilingualSegment key={s.id} seg={s} />)
        )}
      </div>

      {interactive && (latestFinal || !following || copyNotice || earlier || later) && (
        <div
          className="pointer-events-none absolute inset-x-4 bottom-2 z-20 flex items-end justify-end gap-2 text-[11px]"
          style={{ color: fontColor }}
        >
          {copyNotice && (
            <span
              role={copyNotice.failed ? 'alert' : 'status'}
              className="min-w-0 rounded px-2 py-1"
              style={{ background: bg }}
            >
              {copyNotice.text}
            </span>
          )}
          {earlier && (
            <button type="button" onClick={() => page(-1)} className="pointer-events-auto underline">
              更早
            </button>
          )}
          {later && (
            <button type="button" onClick={() => page(1)} className="pointer-events-auto underline">
              后面
            </button>
          )}
          {(!following || later) && (
            <button
              type="button"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              onClick={followLatest}
              className="pointer-events-auto shrink-0 rounded border border-current/20 px-2 py-1 opacity-80 hover:opacity-100"
              style={{ background: bg }}
            >
              {hasUnseen ? '有新字幕 · 回到最新' : '回到最新'}
            </button>
          )}
          {latestFinal && (
            <button
              type="button"
              tabIndex={-1}
              disabled={copying}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => void copyLatest()}
              className="pointer-events-auto shrink-0 rounded px-2 py-1 opacity-60 hover:opacity-100 disabled:opacity-40"
              style={{ background: bg }}
              aria-label="复制最新定稿双语字幕"
            >
              {copying ? '复制中…' : '复制最新'}
            </button>
          )}
        </div>
      )}

      {glow && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-[var(--radius-panel)]"
          style={rainbowRing(3)}
        />
      )}
    </div>
  )
}

function latestFinalSegment(segments: TranscriptSegment[]): TranscriptSegment | undefined {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].state !== SegmentState.Partial) return segments[index]
  }
}

const RAINBOW_GRADIENT = 'linear-gradient(90deg, #b06ab3 0%, #4facfe 25%, #47cf73 50%, #ffc371 75%, #ff5f6d 100%)'

function rainbowRing(padding: number): CSSProperties {
  const maskImage = 'linear-gradient(#000 0 0), linear-gradient(#000 0 0)'
  return {
    background: RAINBOW_GRADIENT,
    padding,
    maskImage,
    maskClip: 'content-box, border-box',
    maskComposite: 'exclude',
    WebkitMaskImage: maskImage,
    WebkitMaskClip: 'content-box, border-box',
    WebkitMaskComposite: 'xor',
  }
}

const BilingualSegment = memo(function BilingualSegment({ seg }: { seg: TranscriptSegment }) {
  const isPartial = seg.state === SegmentState.Partial

  return (
    <div
      className={`py-[0.2em] ${seg.state === SegmentState.Edited ? 'border-[var(--color-accent)] border-l-2 pl-2' : ''}`}
    >
      <p
        className="m-0"
        style={{
          fontSize: `${SOURCE_SCALE}em`,
          opacity: isPartial ? PARTIAL_OPACITY : SOURCE_OPACITY,
        }}
      >
        {seg.text}
        {isPartial && <Caret />}
      </p>

      {seg.translationState === TranslationState.Done && seg.translation && <p className="m-0">{seg.translation}</p>}
      {seg.translationState === TranslationState.Pending && (
        <p className="m-0 opacity-40" style={{ fontSize: `${SOURCE_SCALE}em` }}>
          翻译中…
        </p>
      )}
      {seg.translationState === TranslationState.Failed && (
        <p className="m-0 opacity-40" style={{ fontSize: `${SOURCE_SCALE}em` }}>
          <span className="italic" title={seg.translationError ?? undefined}>
            翻译失败{interactiveError(seg.translationError)}
          </span>
        </p>
      )}
    </div>
  )
})

function interactiveError(error?: string) {
  return error ? `：${error}` : ''
}

function Caret() {
  return (
    <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] animate-pulse bg-current align-baseline" />
  )
}

function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return `rgba(16, 16, 24, ${alpha})`
  const n = Number.parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
