import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SegmentState, type TranscriptSegment, TranslationState } from '@/shared/types'
import { SegmentList } from './SegmentList'

const mocks = vi.hoisted(() => ({ copyText: vi.fn() }))

vi.mock('@/shared/clipboard', async () => ({
  ...(await vi.importActual<typeof import('@/shared/clipboard')>('@/shared/clipboard')),
  copyText: mocks.copyText,
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function segment(patch: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: 'speaking',
    revision: 1,
    startMs: 0,
    endMs: 100,
    text: '正在讲话',
    state: SegmentState.Partial,
    translationState: TranslationState.Idle,
    ...patch,
  }
}

describe('SegmentList reading and copying', () => {
  let container: HTMLDivElement
  let root: Root
  let contentHeight: number

  async function render(segments: TranscriptSegment[], emptyText?: string) {
    await act(async () => root.render(<SegmentList segments={segments} emptyText={emptyText} />))
    const scroll = container.querySelector<HTMLDivElement>('[aria-label="转写内容"]')
    if (!scroll) throw new Error('转写滚动区域未找到')
    return scroll
  }

  function button(label: string) {
    const element = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.includes(label) || item.getAttribute('aria-label') === label,
    )
    if (!element) throw new Error(`${label}按钮未找到`)
    return element
  }

  async function changeCopyMode(mode: string) {
    const select = container.querySelector<HTMLSelectElement>('[aria-label="复制格式"]')
    if (!select) throw new Error('复制格式选择未找到')
    await act(async () => {
      select.value = mode
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  beforeEach(() => {
    contentHeight = 100
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(40)
    mocks.copyText.mockReset().mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.getSelection()?.removeAllRanges()
    container.remove()
    vi.restoreAllMocks()
  })

  it('follows growing partial text even when the segment count stays the same', async () => {
    const scroll = await render([segment()])
    expect(scroll.scrollTop).toBe(100)
    contentHeight = 180
    await render([segment({ text: '正在讲话，内容继续增长并产生换行', revision: 2 })])
    expect(scroll.scrollTop).toBe(180)
  })

  it('follows translation completion when it adds height to an existing segment', async () => {
    const scroll = await render([segment({ state: SegmentState.Final, translationState: TranslationState.Pending })])
    contentHeight = 160
    await render([
      segment({
        revision: 2,
        state: SegmentState.Final,
        translation: 'The speaker is talking.',
        translationState: TranslationState.Done,
      }),
    ])
    expect(scroll.scrollTop).toBe(160)
  })

  it('preserves the reader position when they have scrolled away from the bottom', async () => {
    const scroll = await render([segment()])
    await act(async () => {
      scroll.scrollTop = 0
      scroll.dispatchEvent(new Event('scroll'))
    })
    contentHeight = 180
    await render([segment({ text: '新内容', revision: 2 })])
    expect(scroll.scrollTop).toBe(0)
  })

  it('resumes following after the reader scrolls back to the bottom', async () => {
    const scroll = await render([segment()])
    await act(async () => {
      scroll.scrollTop = 0
      scroll.dispatchEvent(new Event('scroll'))
      scroll.scrollTop = 60
      scroll.dispatchEvent(new Event('scroll'))
    })
    contentHeight = 180
    await render([segment({ revision: 2 })])
    expect(scroll.scrollTop).toBe(180)
  })

  it('signals unseen content during review and returns to following only on request', async () => {
    const first = segment({ state: SegmentState.Final, translationState: TranslationState.Pending })
    const tail = segment({ id: 'tail', text: '正在追加' })
    const scroll = await render([first, tail])
    await act(async () => {
      scroll.scrollTop = 0
      scroll.dispatchEvent(new Event('scroll'))
    })
    expect(button('回到最新').textContent).toBe('回到最新')

    contentHeight = 180
    const updated = [
      { ...first, revision: 2, translationState: TranslationState.Done, translation: 'The translation arrived.' },
      tail,
      segment({ id: 'new', text: '新段落' }),
    ]
    await render(updated)
    expect(scroll.scrollTop).toBe(0)
    expect(button('回到最新').textContent).toContain('有新内容')
    await act(async () => button('回到最新').click())
    expect(scroll.scrollTop).toBe(180)
    expect(container.textContent).not.toContain('回到最新')

    contentHeight = 200
    await render([...updated, segment({ id: 'latest' })])
    expect(scroll.scrollTop).toBe(200)
  })

  it('resets review and unseen state on clear, preserving the supplied empty message', async () => {
    const scroll = await render([segment()])
    await act(async () => {
      scroll.scrollTop = 0
      scroll.dispatchEvent(new Event('scroll'))
    })
    await render([segment({ revision: 2 })])
    expect(button('回到最新').textContent).toContain('有新内容')

    contentHeight = 0
    await render([], '点击左上角「开始转写」。')
    expect(container.textContent).toContain('点击左上角「开始转写」。')
    expect(container.textContent).not.toContain('回到最新')
    expect(button('复制全部').disabled).toBe(true)
    contentHeight = 120
    await render([segment({ id: 'next-session' })])
    expect(scroll.scrollTop).toBe(120)
    expect(container.textContent).not.toContain('有新内容')
  })

  it('copies finalized text in source, translation and bilingual formats without partial or stale translations', async () => {
    await render([
      segment({
        id: 'one',
        text: 'First source.',
        state: SegmentState.Final,
        translationState: TranslationState.Done,
        translation: '第一段译文。',
      }),
      segment({
        id: 'two',
        text: 'Second source.',
        state: SegmentState.Edited,
        translationState: TranslationState.Pending,
        translation: '不应复制的旧译文',
      }),
      segment({ id: 'partial', text: '不应复制的未定稿' }),
    ])
    await act(async () => button('复制全部').click())
    expect(mocks.copyText).toHaveBeenLastCalledWith('First source.\n第一段译文。\n\nSecond source.')

    await changeCopyMode('source')
    await act(async () => button('复制第1段').click())
    expect(mocks.copyText).toHaveBeenLastCalledWith('First source.')
    await act(async () => button('复制全部').click())
    expect(mocks.copyText).toHaveBeenLastCalledWith('First source.\n\nSecond source.')

    await changeCopyMode('translation')
    expect(button('复制第2段').disabled).toBe(true)
    await act(async () => button('复制第1段').click())
    expect(mocks.copyText).toHaveBeenLastCalledWith('第一段译文。')
    await act(async () => button('复制全部').click())
    expect(mocks.copyText).toHaveBeenLastCalledWith('第一段译文。')
    expect(container.querySelector('[aria-label="复制第3段"]')).toBeNull()
  })

  it('disables copying when no finalized content is available in the selected format', async () => {
    await render([segment()])
    expect(button('复制全部').disabled).toBe(true)
    expect(container.querySelector('[aria-label="复制第1段"]')).toBeNull()

    await render([
      segment({ state: SegmentState.Final, translationState: TranslationState.Failed, translation: 'stale' }),
    ])
    await changeCopyMode('translation')
    expect(button('复制第1段').disabled).toBe(true)
    expect(button('复制全部').disabled).toBe(true)
    expect(mocks.copyText).not.toHaveBeenCalled()
    await changeCopyMode('source')
    expect(button('复制第1段').disabled).toBe(false)
    expect(button('复制全部').disabled).toBe(false)
  })

  it('shows copy errors and allows retry without losing the transcript', async () => {
    mocks.copyText.mockRejectedValueOnce(new Error('剪贴板暂不可用'))
    await render([segment({ state: SegmentState.Final })])
    await act(async () => button('复制第1段').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('复制失败')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('剪贴板暂不可用')
    expect(container.textContent).toContain('正在讲话')
    expect(button('复制第1段').disabled).toBe(false)

    await act(async () => button('复制第1段').click())
    expect(mocks.copyText).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toContain('已复制本段')
  })

  it('prevents rapid duplicate clipboard writes across segment and all-copy actions', async () => {
    let finishCopy!: () => void
    mocks.copyText.mockReturnValue(
      new Promise<void>((resolve) => {
        finishCopy = resolve
      }),
    )
    await render([segment({ state: SegmentState.Final })])
    const copySegment = button('复制第1段')
    const copyAll = button('复制全部')
    await act(async () => {
      copySegment.click()
      copySegment.click()
      copyAll.click()
    })
    expect(mocks.copyText).toHaveBeenCalledOnce()
    expect(copySegment.disabled).toBe(true)
    expect(copyAll.disabled).toBe(true)

    await act(async () => finishCopy())
    expect(copySegment.disabled).toBe(false)
    expect(copyAll.disabled).toBe(false)
  })

  it('keeps text selectable and protects the selected passage from new content and copy clicks', async () => {
    const first = segment({ state: SegmentState.Final, text: '可以选中的原文' })
    const scroll = await render([first])
    expect(scroll.style.userSelect).toBe('text')
    const textNode = scroll.querySelector('li p')?.firstChild
    if (!textNode) throw new Error('原文文字节点未找到')
    const selection = document.getSelection()
    const range = document.createRange()
    range.selectNodeContents(textNode)
    selection?.addRange(range)
    await act(async () => document.dispatchEvent(new Event('selectionchange')))
    expect(button('回到最新')).toBeTruthy()

    scroll.scrollTop = 10
    contentHeight = 180
    await render([first, segment({ id: 'new' })])
    expect(scroll.scrollTop).toBe(10)
    expect(selection?.toString()).toBe('可以选中的原文')
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    button('复制第1段').dispatchEvent(mouseDown)
    expect(mouseDown.defaultPrevented).toBe(true)
    await act(async () => button('复制第1段').click())
    expect(selection?.toString()).toBe('可以选中的原文')
    expect(mocks.copyText).toHaveBeenCalledWith('可以选中的原文')
  })
  it('bounds a long live transcript while keeping all finalized text available for copying', async () => {
    const segments = Array.from({ length: 450 }, (_, index) =>
      segment({ id: `s${index}`, text: `段落${index}`, state: SegmentState.Final }),
    )
    await render(segments)
    expect(container.querySelectorAll('li')).toHaveLength(200)
    expect(container.querySelector('li')?.textContent).toContain('段落250')
    await act(async () => button('更早的段落').click())
    expect(container.querySelector('li')?.textContent).toContain('段落50')
    await act(async () => button('复制全部').click())
    expect(mocks.copyText.mock.calls[0][0]).toContain('段落0')
    expect(mocks.copyText.mock.calls[0][0]).toContain('段落449')
    await act(async () => button('回到最新').click())
    expect(container.querySelector('li')?.textContent).toContain('段落250')
  })
})
