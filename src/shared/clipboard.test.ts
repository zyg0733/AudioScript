import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText, formatSegmentText } from './clipboard'
import { SegmentState, type TranscriptSegment, TranslationState } from './types'

const segment: TranscriptSegment = {
  id: 'sentence',
  revision: 1,
  startMs: 0,
  endMs: 1000,
  state: SegmentState.Final,
  text: ' Hello world. ',
  translation: ' 你好，世界。 ',
  translationState: TranslationState.Done,
}

const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const execDescriptor = Object.getOwnPropertyDescriptor(document, 'execCommand')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  document.getSelection()?.removeAllRanges()
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
  else Reflect.deleteProperty(navigator, 'clipboard')
  if (execDescriptor) Object.defineProperty(document, 'execCommand', execDescriptor)
  else Reflect.deleteProperty(document, 'execCommand')
})

describe('subtitle copy', () => {
  it('copies the chosen language and excludes unavailable translations', () => {
    expect(formatSegmentText(segment, 'source')).toBe('Hello world.')
    expect(formatSegmentText(segment, 'translation')).toBe('你好，世界。')
    expect(formatSegmentText(segment, 'bilingual')).toBe('Hello world.\n你好，世界。')
    for (const translationState of [TranslationState.Pending, TranslationState.Failed]) {
      const pending = { ...segment, translationState }
      expect(formatSegmentText(pending, 'translation')).toBe('')
      expect(formatSegmentText(pending, 'bilingual')).toBe('Hello world.')
    }
  })

  it('uses the clipboard API without disturbing the document', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    await copyText('原文\n译文')
    expect(writeText).toHaveBeenCalledWith('原文\n译文')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('falls back after a clipboard rejection and restores the selection and focus', async () => {
    const input = document.createElement('input')
    const text = document.createElement('p')
    text.textContent = '正在核对的内容'
    document.body.append(input, text)
    input.focus()
    const range = document.createRange()
    range.selectNodeContents(text)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(range)
    expect(document.getSelection()?.toString()).toBe('正在核对的内容')
    const clipboard = {
      writeText: vi.fn(async () => {
        throw new Error('denied')
      }),
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => clipboard })
    const execCommand = vi.fn(() => document.querySelector('textarea')?.value === '要复制的字幕')
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    await copyText('要复制的字幕')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
    expect(document.activeElement).toBe(input)
    expect(document.getSelection()?.toString()).toBe('正在核对的内容')
  })

  it('reports copy failure without retaining a hidden input or inventing success', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => undefined })
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false })
    await expect(copyText('字幕')).rejects.toThrow('复制失败')
    await expect(copyText('  ')).rejects.toThrow('暂无可复制的内容')
    expect(document.querySelector('textarea')).toBeNull()
  })
})
