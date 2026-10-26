import { useEffect, useState } from 'react'
import type { TranscriptSegment } from './types'
import { useFollowLatest } from './useFollowLatest'

const PAGE_SIZE = 200

export function useTranscriptWindow(
  segments: TranscriptSegment[],
  options: { enabled?: boolean; layoutKey?: string } = {},
) {
  const [pageStart, setPageStart] = useState<number | null>(null)
  const latestStart = Math.max(0, segments.length - PAGE_SIZE)
  const start = pageStart === null ? latestStart : Math.min(pageStart, latestStart)
  const end = Math.min(segments.length, start + PAGE_SIZE)
  const flow = useFollowLatest(segments, { ...options, layoutKey: `${options.layoutKey ?? ''}:${start}` })

  useEffect(() => {
    if (segments.length === 0 || options.enabled === false) setPageStart(null)
  }, [segments.length, options.enabled])

  useEffect(() => {
    if (!flow.following && pageStart === null) setPageStart(start)
  }, [flow.following, pageStart, start])

  function onScroll() {
    const element = flow.scrollRef.current
    if (element && options.enabled !== false) {
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
      if (!atBottom && pageStart === null) setPageStart(start)
      else if (atBottom && end === segments.length) setPageStart(null)
    }
    flow.onScroll()
  }

  function page(direction: -1 | 1) {
    flow.pauseFollowing()
    setPageStart(Math.max(0, Math.min(latestStart, start + direction * PAGE_SIZE)))
    const element = flow.scrollRef.current
    if (element) element.scrollTop = 0
  }

  function followLatest() {
    setPageStart(null)
    flow.followLatest()
  }

  return {
    ...flow,
    onScroll,
    followLatest,
    visible: segments.slice(start, end),
    start,
    end,
    earlier: start > 0,
    later: end < segments.length,
    page,
  }
}
