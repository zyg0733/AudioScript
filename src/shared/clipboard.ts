import { type TranscriptSegment, TranslationState } from './types'

export type CopyMode = 'source' | 'translation' | 'bilingual'

export function formatSegmentText(segment: TranscriptSegment, mode: CopyMode): string {
  const source = segment.text.trim()
  const translation = segment.translationState === TranslationState.Done ? (segment.translation?.trim() ?? '') : ''
  if (mode === 'source') return source
  if (mode === 'translation') return translation
  return [source, translation].filter(Boolean).join('\n')
}

export async function copyText(text: string): Promise<void> {
  if (!text.trim()) throw new Error('暂无可复制的内容')
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {}

  const selection = document.getSelection()
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []
  const active = document.activeElement
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.readOnly = true
  textarea.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0'
  document.body.append(textarea)
  try {
    textarea.select()
    if (!document.execCommand?.('copy')) throw new Error('复制失败，请选中文字后使用系统复制快捷键')
  } catch {
    throw new Error('复制失败，请选中文字后使用系统复制快捷键')
  } finally {
    textarea.remove()
    if (active instanceof HTMLElement && active !== document.body) active.focus({ preventScroll: true })
    if (selection) {
      selection.removeAllRanges()
      for (const range of ranges) selection.addRange(range)
    }
  }
}
