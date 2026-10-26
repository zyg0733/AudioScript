import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OverlayMode, SegmentState, type TranscriptSegment, TranslationState } from '@/shared/types'
import { StreamView } from './StreamView'

const mocks = vi.hoisted(() => ({ copyText: vi.fn(), formatSegmentText: vi.fn() }))

vi.mock('@/shared/clipboard', () => ({ copyText: mocks.copyText, formatSegmentText: mocks.formatSegmentText }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function segment(id: string): TranscriptSegment {
  return {
    id,
    revision: 1,
    startMs: 0,
    endMs: 100,
    text: id,
    state: SegmentState.Final,
    translationState: TranslationState.Pending,
  }
}

describe('StreamView', () => {
  let container: HTMLDivElement
  let root: Root
  let contentHeight: number

  async function render(
    segments: TranscriptSegment[],
    fontSize = 22,
    error: string | null = null,
    mode = OverlayMode.Edit,
  ) {
    await act(async () => {
      root.render(
        <StreamView
          segments={segments}
          fontSize={fontSize}
          fontColor="#ffffff"
          opacity={60}
          bgColor="#101018"
          glow={false}
          mode={mode}
          error={error}
        />,
      )
    })
    const scroll = container.querySelector<HTMLDivElement>('.overflow-y-auto')
    if (!scroll) throw new Error('字幕滚动区域未找到')
    return scroll
  }

  beforeEach(() => {
    contentHeight = 100
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40)
    mocks.copyText.mockReset().mockResolvedValue(undefined)
    mocks.formatSegmentText.mockReset().mockReturnValue('最新原文\n最新译文')
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.restoreAllMocks()
  })

  it('follows translation completion in an earlier segment while the tail stays unchanged', async () => {
    const first = segment('first')
    const tail = segment('tail')
    const scroll = await render([first, tail])
    contentHeight = 180
    await render([{ ...first, revision: 2, translation: '完成翻译', translationState: TranslationState.Done }, tail])
    expect(scroll.scrollTop).toBe(180)
  })

  it('keeps the latest text visible after changing font size', async () => {
    const segments = [segment('first')]
    const scroll = await render(segments)
    contentHeight = 180
    await render(segments, 30)
    expect(scroll.scrollTop).toBe(180)
  })

  it('shows stream failures in the overlay', async () => {
    await render([], 22, '字幕订阅失败：监听不可用')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('字幕订阅失败')
  })

  it('preserves review position through new text, translation and font changes until returning to latest', async () => {
    const first = segment('first')
    const tail = segment('tail')
    const scroll = await render([first, tail])
    await act(async () => {
      scroll.scrollTop = 0
      scroll.dispatchEvent(new Event('scroll'))
    })
    expect(container.textContent).toContain('回到最新')

    contentHeight = 180
    const updated = [
      { ...first, revision: 2, translation: '完成翻译', translationState: TranslationState.Done },
      tail,
      { ...segment('speaking'), state: SegmentState.Partial },
    ]
    await render(updated)
    expect(scroll.scrollTop).toBe(0)
    expect(container.textContent).toContain('有新字幕')
    await render(updated, 30)
    expect(scroll.scrollTop).toBe(0)

    const follow = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('回到最新'),
    )
    if (!follow) throw new Error('回到最新按钮未找到')
    await act(async () => follow.click())
    expect(scroll.scrollTop).toBe(180)
    expect(container.textContent).not.toContain('回到最新')
  })

  it('hides interactive controls and resumes live following when locked', async () => {
    const segments = [segment('first')]
    const scroll = await render(segments)
    await act(async () => {
      scroll.scrollTop = 0
      scroll.dispatchEvent(new Event('scroll'))
    })
    expect(container.textContent).toContain('回到最新')

    await render(segments, 22, null, OverlayMode.Locked)
    expect(scroll.scrollTop).toBe(100)
    expect(container.querySelector('button')).toBeNull()
    expect(scroll.style.userSelect).toBe('none')

    contentHeight = 180
    await render([...segments, segment('second')], 22, null, OverlayMode.Locked)
    expect(scroll.scrollTop).toBe(180)
    await render([...segments, segment('second')])
    expect(container.textContent).not.toContain('回到最新')
    expect(scroll.style.userSelect).toBe('text')
  })

  it('resets review position on clear and follows the next transcript', async () => {
    const scroll = await render([segment('first')])
    await act(async () => {
      scroll.scrollTop = 0
      scroll.dispatchEvent(new Event('scroll'))
    })
    expect(container.textContent).toContain('回到最新')

    contentHeight = 0
    await render([])
    expect(container.textContent).not.toContain('回到最新')
    expect(container.querySelector('button')).toBeNull()
    contentHeight = 120
    await render([segment('next')])
    expect(scroll.scrollTop).toBe(120)
    expect(container.textContent).not.toContain('有新字幕')
  })

  it('copies the latest finalized segment without requesting focus', async () => {
    const final = segment('final')
    await render([final, { ...segment('speaking'), state: SegmentState.Partial }])
    const copy = container.querySelector<HTMLButtonElement>('[aria-label="复制最新定稿双语字幕"]')
    if (!copy) throw new Error('复制按钮未找到')
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    copy.dispatchEvent(mouseDown)
    expect(mouseDown.defaultPrevented).toBe(true)

    await act(async () => copy.click())
    expect(mocks.formatSegmentText).toHaveBeenCalledWith(final, 'bilingual')
    expect(mocks.copyText).toHaveBeenCalledWith('最新原文\n最新译文')
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已复制')
  })

  it('reports clipboard failure and permits retry', async () => {
    mocks.copyText.mockRejectedValueOnce(new Error('无法访问剪贴板，请重试'))
    await render([segment('final')])
    const copy = container.querySelector<HTMLButtonElement>('[aria-label="复制最新定稿双语字幕"]')
    if (!copy) throw new Error('复制按钮未找到')
    await act(async () => copy.click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('无法访问剪贴板')
    expect(copy.disabled).toBe(false)
    await act(async () => copy.click())
    expect(mocks.copyText).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
