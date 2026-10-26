import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SegmentState, type TranscriptSegment, TranslationState } from './types'
import { useFollowLatest } from './useFollowLatest'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('subtitle reading position', () => {
  let container: HTMLDivElement
  let root: Root
  let current: ReturnType<typeof useFollowLatest>
  let height: number

  const sentence: TranscriptSegment = {
    id: 'sentence',
    revision: 1,
    startMs: 0,
    endMs: 1000,
    text: '选择正在核对的句子',
    state: SegmentState.Final,
    translationState: TranslationState.Pending,
  }

  function Harness({ revision }: { revision: number }) {
    current = useFollowLatest([{ ...sentence, revision }])
    return (
      <div ref={current.scrollRef} onScroll={current.onScroll}>
        <p>{sentence.text}</p>
      </div>
    )
  }

  async function render(revision: number) {
    await act(async () => root.render(<Harness revision={revision} />))
  }

  function scrollElement() {
    const element = current.scrollRef.current
    if (!element) throw new Error('字幕滚动区域未找到')
    return element
  }

  beforeEach(async () => {
    height = 100
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await render(1)
    const scroll = scrollElement()
    Object.defineProperties(scroll, {
      scrollHeight: { get: () => height },
      clientHeight: { get: () => 40 },
    })
    await render(2)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.getSelection()?.removeAllRanges()
    container.remove()
  })

  it('holds selected text in place until the reader explicitly returns to latest', async () => {
    const scroll = scrollElement()
    const selection = document.getSelection()
    const text = scroll.querySelector('p')
    if (!selection || !text) throw new Error('字幕选区不可用')
    const range = document.createRange()
    range.selectNodeContents(text)
    selection.addRange(range)
    await act(async () => document.dispatchEvent(new Event('selectionchange')))
    expect(current.following).toBe(false)
    height = 180
    await render(3)
    expect(scroll.scrollTop).toBe(100)
    expect(current.hasUnseen).toBe(true)
    await act(async () => current.followLatest())
    expect(selection.isCollapsed).toBe(true)
    expect(scroll.scrollTop).toBe(180)
    height = 220
    await render(4)
    expect(scroll.scrollTop).toBe(220)
  })

  it('does not pause subtitles when text outside their container is selected', async () => {
    const outside = document.createElement('p')
    outside.textContent = '其他页面文字'
    container.append(outside)
    const range = document.createRange()
    range.selectNodeContents(outside)
    document.getSelection()?.addRange(range)
    await act(async () => document.dispatchEvent(new Event('selectionchange')))
    expect(current.following).toBe(true)
    height = 180
    await render(3)
    expect(current.scrollRef.current?.scrollTop).toBe(180)
  })
})
