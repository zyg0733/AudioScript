import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { type CopyMode, copyText, formatSegmentText } from '@/shared/clipboard'
import { SegmentState, type TranscriptSegment, TranslationState } from '@/shared/types'
import { useTranscriptWindow } from '@/shared/useTranscriptWindow'
import { Button } from './Button'
import { cn } from './cn'
import { Select } from './Select'

interface Props {
  segments: TranscriptSegment[]
  emptyText?: string
  onRetry?: (id: string) => void
  retryDisabled?: boolean
}

export function SegmentList({ segments, emptyText = '等待识别…', onRetry, retryDisabled }: Props) {
  const { scrollRef, following, hasUnseen, onScroll, followLatest, visible, start, end, earlier, later, page } =
    useTranscriptWindow(segments)
  const [copyMode, setCopyMode] = useState<CopyMode>('bilingual')
  const [copying, setCopying] = useState<string | null>(null)
  const copyingRef = useRef(false)
  const [copyNotice, setCopyNotice] = useState<{ message: string; failed: boolean } | null>(null)

  useEffect(() => {
    if (!copyNotice || copyNotice.failed) return
    const timer = window.setTimeout(() => setCopyNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [copyNotice])

  const copy = useCallback(async (text: string, target: string, message: string) => {
    if (!text.trim() || copyingRef.current) return
    copyingRef.current = true
    setCopying(target)
    setCopyNotice(null)
    try {
      await copyText(text)
      setCopyNotice({ message, failed: false })
    } catch (error) {
      const detail = error instanceof Error ? error.message : '剪贴板暂不可用'
      setCopyNotice({ message: detail.startsWith('复制失败') ? detail : `复制失败：${detail}`, failed: true })
    } finally {
      copyingRef.current = false
      setCopying(null)
    }
  }, [])

  const copySegment = useCallback(
    (seg: TranscriptSegment) => void copy(formatSegmentText(seg, copyMode), `segment:${seg.id}`, '已复制本段'),
    [copy, copyMode],
  )
  const hasCopyable = segments.some(
    (seg) => seg.state !== SegmentState.Partial && formatSegmentText(seg, copyMode).trim(),
  )

  function copyAll() {
    if (copyingRef.current) return
    const text = segments
      .filter((seg) => seg.state !== SegmentState.Partial)
      .map((seg) => formatSegmentText(seg, copyMode))
      .filter((value) => value.trim())
      .join('\n\n')
    void copy(text, 'all', '已复制全部定稿内容')
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          role={copyNotice ? (copyNotice.failed ? 'alert' : 'status') : undefined}
          className={cn(
            'mr-auto text-xs',
            copyNotice?.failed ? 'text-[var(--color-danger-ink)]' : 'text-[var(--color-ink-2)]',
          )}
        >
          {copyNotice?.message ?? '仅复制已定稿内容'}
        </span>
        <Select
          label="复制格式"
          value={copyMode}
          onChange={setCopyMode}
          disabled={copying !== null}
          options={[
            { value: 'source', label: '原文' },
            { value: 'translation', label: '译文' },
            { value: 'bilingual', label: '双语' },
          ]}
        />
        <Button variant="ghost" size="sm" disabled={!hasCopyable || copying !== null} onClick={copyAll}>
          {copying === 'all' ? '复制中…' : '复制全部'}
        </Button>
      </div>
      {(earlier || later) && (
        <div className="flex items-center gap-2 text-xs text-[var(--color-ink-2)]">
          <Button size="sm" disabled={!earlier} onClick={() => page(-1)}>
            更早的段落
          </Button>
          <span>
            显示 {start + 1}–{end} / {segments.length} 段
          </span>
          <Button size="sm" disabled={!later} onClick={() => page(1)}>
            后面的段落
          </Button>
          {later && (
            <Button size="sm" onClick={followLatest}>
              回到最新
            </Button>
          )}
        </div>
      )}
      <div className="relative">
        <section
          ref={scrollRef}
          onScroll={onScroll}
          aria-label="转写内容"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动字幕区需要键盘聚焦，便于使用方向键和 PageUp 回看。
          tabIndex={0}
          className="max-h-[62vh] overflow-y-auto rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-0)] p-4 pb-12"
          style={{ userSelect: 'text', WebkitUserSelect: 'text' }}
        >
          {segments.length === 0 ? (
            <p className="py-8 text-center text-[var(--color-ink-2)] text-sm">{emptyText}</p>
          ) : (
            <ol className="space-y-3">
              {visible.map((seg, index) => (
                <SegmentItem
                  key={seg.id}
                  seg={seg}
                  index={start + index}
                  copyMode={copyMode}
                  copying={copying}
                  onCopy={copySegment}
                  onRetry={onRetry}
                  retryDisabled={retryDisabled}
                />
              ))}
            </ol>
          )}
        </section>
        {(!following || later) && segments.length > 0 && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-end">
            <Button
              size="sm"
              onClick={followLatest}
              className="pointer-events-auto bg-[var(--color-surface-1)] shadow-sm"
            >
              {hasUnseen ? '有新内容 · 回到最新' : '回到最新'}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

interface SegmentItemProps {
  seg: TranscriptSegment
  index: number
  copyMode: CopyMode
  copying: string | null
  onCopy: (seg: TranscriptSegment) => void
  onRetry?: (id: string) => void
  retryDisabled?: boolean
}

const SegmentItem = memo(function SegmentItem({
  seg,
  index,
  copyMode,
  copying,
  onCopy,
  onRetry,
  retryDisabled,
}: SegmentItemProps) {
  return (
    <li
      className={cn(
        'flex items-start gap-3',
        seg.state === SegmentState.Edited && 'border-[var(--color-accent)] border-l-2 pl-3',
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[0.78em] leading-relaxed" style={{ color: 'var(--color-segment-partial)' }}>
          {seg.text}
          {seg.state === SegmentState.Partial && (
            <span className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] animate-pulse bg-current align-baseline" />
          )}
        </p>

        {seg.translationState === TranslationState.Done && seg.translation && (
          <p className="m-0 text-[0.95em] text-[var(--color-segment-final)] leading-relaxed">{seg.translation}</p>
        )}

        {seg.translationState === TranslationState.Pending && (
          <p className="m-0 text-[var(--color-ink-2)] text-[0.78em]">翻译中…</p>
        )}

        {seg.translationState === TranslationState.Failed && (
          <div className="text-[0.78em] text-[var(--color-warn)]">
            <p className="m-0">翻译失败{seg.translationError ? `：${seg.translationError}` : ''}</p>
            {onRetry && (
              <button
                type="button"
                disabled={retryDisabled}
                onClick={() => onRetry(seg.id)}
                className="underline disabled:opacity-40"
              >
                重新翻译本段
              </button>
            )}
          </div>
        )}
      </div>
      {seg.state !== SegmentState.Partial && (
        <button
          type="button"
          aria-label={`复制第${index + 1}段`}
          disabled={copying !== null || !formatSegmentText(seg, copyMode).trim()}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCopy(seg)}
          className="shrink-0 select-none rounded px-1 py-0.5 text-[var(--color-ink-2)] text-xs opacity-60 hover:opacity-100 disabled:opacity-30"
        >
          {copying === `segment:${seg.id}` ? '复制中…' : '复制'}
        </button>
      )}
    </li>
  )
})
