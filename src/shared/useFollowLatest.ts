import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TranscriptSegment } from './types'

interface Options {
  enabled?: boolean
  layoutKey?: unknown
  resetKey?: unknown
}

export function useFollowLatest(segments: TranscriptSegment[], { enabled = true, layoutKey, resetKey }: Options = {}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)
  const previous = useRef({ segments, resetKey })
  const [following, setFollowing] = useState(true)
  const [hasUnseen, setHasUnseen] = useState(false)

  const scrollToLatest = useCallback(() => {
    followingRef.current = true
    setFollowing(true)
    setHasUnseen(false)
    const element = scrollRef.current
    if (element) element.scrollTop = element.scrollHeight
  }, [])

  const followLatest = useCallback(() => {
    const element = scrollRef.current
    const selection = document.getSelection()
    if (element && selection && element.contains(selection.anchorNode)) selection.removeAllRanges()
    scrollToLatest()
  }, [scrollToLatest])

  const pauseFollowing = useCallback(() => {
    followingRef.current = false
    setFollowing(false)
  }, [])

  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element || !enabled) return
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
    followingRef.current = atBottom
    setFollowing(atBottom)
    if (atBottom) setHasUnseen(false)
  }, [enabled])

  // biome-ignore lint/correctness/useExhaustiveDependencies: 字号等布局变化也需要同步当前跟随位置
  useLayoutEffect(() => {
    const contentChanged = previous.current.segments !== segments
    const reset = previous.current.resetKey !== resetKey || segments.length === 0
    previous.current = { segments, resetKey }
    if (!enabled) followLatest()
    else if (reset || followingRef.current) scrollToLatest()
    else if (contentChanged) setHasUnseen(true)
  }, [segments, enabled, resetKey, layoutKey, followLatest, scrollToLatest])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const reflow = () => {
      if (!enabled || followingRef.current) scrollToLatest()
    }
    const select = () => {
      const selection = document.getSelection()
      if (
        enabled &&
        selection &&
        !selection.isCollapsed &&
        element.contains(selection.anchorNode) &&
        element.contains(selection.focusNode)
      ) {
        followingRef.current = false
        setFollowing(false)
      }
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reflow)
    observer?.observe(element)
    if (element.firstElementChild) observer?.observe(element.firstElementChild)
    window.addEventListener('resize', reflow)
    document.addEventListener('selectionchange', select)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', reflow)
      document.removeEventListener('selectionchange', select)
    }
  }, [enabled, scrollToLatest])

  return { scrollRef, following, hasUnseen, onScroll, followLatest, pauseFollowing }
}
