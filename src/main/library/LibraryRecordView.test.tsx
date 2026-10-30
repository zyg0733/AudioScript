import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LibraryRecord } from '@/shared/types'
import { clearDrafts } from './drafts'
import { LibraryRecordView } from './LibraryRecordView'
import { libraryRecord } from './test-fixtures'

const mocks = vi.hoisted(() => ({
  libraryCall: vi.fn(),
  save: vi.fn(),
  revealPath: vi.fn(),
  changed: vi.fn(),
  deleted: vi.fn(),
  reprocess: vi.fn(),
  copyText: vi.fn(),
}))

vi.mock('@/shared/ipc', async () => ({
  ...(await vi.importActual<typeof import('@/shared/ipc')>('@/shared/ipc')),
  libraryCall: mocks.libraryCall,
  revealPath: mocks.revealPath,
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }))
vi.mock('@/shared/clipboard', async () => ({
  ...(await vi.importActual<typeof import('@/shared/clipboard')>('@/shared/clipboard')),
  copyText: mocks.copyText,
}))
vi.mock('./LibraryMediaPlayer', () => ({ LibraryMediaPlayer: () => null }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('LibraryRecordView editing and evidence', () => {
  let container: HTMLDivElement
  let root: Root
  let initial: LibraryRecord
  let publishRecord: (record: LibraryRecord) => void

  function Harness() {
    const [record, setRecord] = useState(initial)
    publishRecord = setRecord
    return (
      <LibraryRecordView
        record={record}
        onChanged={(next) => {
          mocks.changed(next)
          setRecord(next)
        }}
        onDeleted={mocks.deleted}
        onReprocess={mocks.reprocess}
        reprocessing={false}
      />
    )
  }

  function button(label: string, scope: ParentNode = container): HTMLButtonElement {
    const result = Array.from(scope.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
    if (!result) throw new Error(`按钮未找到：${label}`)
    return result
  }

  async function enter(label: string, value: string) {
    const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)
    if (!input) throw new Error(`输入框未找到：${label}`)
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    await act(async () => {
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  beforeEach(async () => {
    initial = libraryRecord()
    clearDrafts(initial.id)
    mocks.libraryCall.mockReset().mockImplementation(async (action: string) => (action === 'terms_list' ? [] : initial))
    mocks.save.mockReset().mockResolvedValue('/tmp/excerpt.md')
    mocks.revealPath.mockReset().mockResolvedValue(undefined)
    mocks.copyText.mockReset().mockResolvedValue(undefined)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<Harness />))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('sends only changed text with its expected revision and preserves a rejected edit draft', async () => {
    await act(async () => button('修订').click())
    await enter('修订第1段原文', 'Rust prevents races.')
    mocks.libraryCall.mockRejectedValueOnce(new Error('版本已变化，请重新读取记录'))
    await act(async () => button('保存修订').click())

    expect(mocks.libraryCall).toHaveBeenCalledWith('segment_update', {
      id: initial.id,
      segmentId: 'first',
      expectedRevision: 2,
      text: 'Rust prevents races.',
    })
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="修订第1段原文"]')?.value).toBe(
      'Rust prevents races.',
    )
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('版本已变化')
    expect(mocks.changed).not.toHaveBeenCalled()
  })

  it('keeps the edit revision frozen until the user reconciles a live update', async () => {
    await act(async () => button('修订').click())
    await enter('修订第1段原文', 'Rust prevents races.')
    const next = {
      ...initial,
      revision: 5,
      segments: initial.segments.map((entry, index) =>
        index ? entry : { ...entry, segment: { ...entry.segment, revision: 3, translation: '新的机器译文' } },
      ),
    }
    await act(async () => publishRecord(next))
    expect(button('保存修订').disabled).toBe(true)
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="修订第1段原文"]')?.value).toBe(
      'Rust prevents races.',
    )
    await act(async () => button('保留改动并载入最新版本').click())
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="修订第1段译文"]')?.value).toBe('新的机器译文')
    expect(button('保存修订').disabled).toBe(false)
    mocks.libraryCall.mockResolvedValueOnce(next)
    await act(async () => button('保存修订').click())
    expect(mocks.libraryCall).toHaveBeenCalledWith('segment_update', {
      id: initial.id,
      segmentId: 'first',
      expectedRevision: 3,
      text: 'Rust prevents races.',
    })
  })

  it('retains text and note drafts across pages, filters, tabs and leaving the record', async () => {
    initial = {
      ...initial,
      segments: Array.from({ length: 101 }, (_, index) => ({
        ...initial.segments[0],
        segment: { ...initial.segments[0].segment, id: `draft-${index}`, text: `原文 ${index}` },
      })),
    }
    await act(async () => root.render(<Harness key="draft-record" />))
    await act(async () => button('修订').click())
    await enter('修订第1段原文', '保留这份修订')
    await act(async () => button('笔记').click())
    await enter('第1段笔记', '保留这份笔记')
    expect(container.textContent).toContain('1 段有未保存修改')
    await act(async () => button('下一页').click())
    expect(container.querySelector('[aria-label="修订第1段原文"]')).toBeNull()
    await act(async () => button('继续修订').click())
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="修订第1段原文"]')?.value).toBe('保留这份修订')
    await enter('在当前记录中查找', '没有匹配的原文')
    await enter('在当前记录中查找', '')
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="第1段笔记"]')?.value).toBe('保留这份笔记')
    await act(async () => button('章节与问答').click())
    await act(async () => button('原文与摘录').click())
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="修订第1段原文"]')?.value).toBe('保留这份修订')
    await act(async () => root.render(null))
    initial = {
      ...initial,
      revision: 5,
      segments: initial.segments.map((entry) => ({ ...entry, segment: { ...entry.segment, revision: 3 } })),
    }
    await act(async () => root.render(<Harness />))
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="第1段笔记"]')?.value).toBe('保留这份笔记')
    expect(button('保存修订').disabled).toBe(true)
    expect(button('保存笔记').disabled).toBe(true)
    await act(async () => button('取消修订').click())
    const first = container.querySelector('#library-segment-draft-0')
    if (!first) throw new Error('草稿片段未找到')
    await act(async () => button('取消', first).click())
    expect(container.textContent).not.toContain('段有未保存修改')
  })

  it('requires an explicit language for older records before translation or refinement', async () => {
    const older = { ...initial, source: { ...initial.source, sourceLang: undefined } }
    await act(async () => publishRecord(older))
    expect(button('译文另存精修版').disabled).toBe(true)
    await act(async () => button('重新翻译全部').click())
    expect(mocks.libraryCall).not.toHaveBeenCalledWith('retranslate', expect.anything())
    expect(container.querySelector('[aria-label="记录原文语言"]')).not.toBeNull()
    const language = container.querySelector<HTMLSelectElement>('[aria-label="记录原文语言"]')
    if (!language) throw new Error('语言设置未找到')
    await act(async () => {
      language.value = 'zh'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })
    mocks.libraryCall.mockResolvedValueOnce({ ...older, source: { ...older.source, sourceLang: 'zh' } })
    await act(async () => button('保存来源').click())
    expect(mocks.libraryCall).toHaveBeenCalledWith('source_update', {
      id: initial.id,
      label: initial.source.label,
      url: '',
      sourceLang: 'zh',
    })
    expect(button('译文另存精修版').disabled).toBe(false)
  })

  it('clears an existing source link by sending an empty URL', async () => {
    await act(async () =>
      publishRecord({ ...initial, source: { ...initial.source, url: 'https://example.com/course' } }),
    )
    await act(async () => button('来源').click())
    await enter('来源链接', '')
    await act(async () => button('保存来源').click())
    expect(mocks.libraryCall).toHaveBeenCalledWith('source_update', {
      id: initial.id,
      label: initial.source.label,
      url: '',
      sourceLang: 'en',
    })
  })

  it('locates a search match beyond the first page and allows repeating the same match', async () => {
    const record = {
      ...initial,
      segments: Array.from({ length: 205 }, (_, index) => ({
        ...initial.segments[0],
        segment: { ...initial.segments[0].segment, id: `match-${index}` },
      })),
    }
    const renderMatch = (focusSequence: number) =>
      root.render(
        <LibraryRecordView
          record={record}
          onChanged={mocks.changed}
          onDeleted={mocks.deleted}
          onReprocess={mocks.reprocess}
          reprocessing={false}
          initialSegmentId="match-204"
          focusSequence={focusSequence}
        />,
      )
    await act(async () => renderMatch(1))
    expect(container.querySelector<HTMLSelectElement>('[aria-label="片段页码"]')?.value).toBe('3')
    expect(container.querySelector('#library-segment-match-204')?.className).toContain('border-[var(--color-accent)]')
    await act(async () => button('上一页').click())
    await act(async () => renderMatch(2))
    expect(container.querySelector<HTMLSelectElement>('[aria-label="片段页码"]')?.value).toBe('3')
  })

  it('exports selected segment IDs with the requested format and pinned bookmark versions', async () => {
    const check = container.querySelector<HTMLInputElement>('[aria-label="选择第1段"]')
    if (!check) throw new Error('片段选择框未找到')
    const pinned = Array.from(container.querySelectorAll('label'))
      .find((label) => label.textContent?.includes('使用标记时的版本'))
      ?.querySelector('input')
    if (!pinned) throw new Error('标记版本选择框未找到')
    await act(async () => {
      check.click()
      pinned.click()
    })
    mocks.libraryCall.mockResolvedValueOnce({ path: '/tmp/excerpt.md' })
    await act(async () => button('导出所选摘录').click())

    expect(mocks.libraryCall).toHaveBeenCalledWith('export', {
      id: initial.id,
      path: '/tmp/excerpt.md',
      format: 'markdown',
      segmentIds: ['first'],
      useBookmarkVersions: true,
    })
    expect(container.textContent).toContain('已保存')
  })

  it('binds bookmark and history restore to the current segment revision', async () => {
    await act(async () => button('标记').click())
    expect(mocks.libraryCall).toHaveBeenCalledWith('segment_update', {
      id: initial.id,
      segmentId: 'first',
      expectedRevision: 2,
      bookmarked: true,
    })
    await act(async () => button('版本 2').click())
    const restore = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent?.trim() === '恢复此版本' && !item.disabled,
    )
    if (!restore) throw new Error('可恢复的历史版本未找到')
    await act(async () => restore.click())
    expect(mocks.libraryCall).toHaveBeenCalledWith('history_restore', {
      id: initial.id,
      segmentId: 'first',
      versionRevision: 1,
      expectedRevision: 2,
    })
  })

  it('retranslates a long record in bounded batches', async () => {
    initial = {
      ...initial,
      segments: Array.from({ length: 51 }, (_, index) => ({
        ...initial.segments[0],
        segment: { ...initial.segments[0].segment, id: `segment-${index}` },
      })),
    }
    mocks.libraryCall.mockResolvedValue(initial)
    await act(async () => root.render(<Harness key="long-record" />))
    await act(async () => button('重新翻译全部').click())
    const calls = mocks.libraryCall.mock.calls.filter(([action]) => action === 'retranslate')
    expect(calls).toHaveLength(2)
    expect(calls[0][1].segmentIds).toHaveLength(50)
    expect(calls[1][1].segmentIds).toEqual(['segment-50'])
    expect(container.textContent).toContain('译文处理完成')
  })

  it('paginates long transcripts while references and full copies still cover every segment', async () => {
    initial = {
      ...initial,
      segments: Array.from({ length: 205 }, (_, index) => ({
        ...initial.segments[0],
        segment: {
          ...initial.segments[0].segment,
          id: `page-segment-${index}`,
          text: `原文片段${index}`,
          startMs: index * 1000,
          endMs: index * 1000 + 900,
        },
      })),
    }
    await act(async () => root.render(<Harness key="paged-record" />))
    expect(container.querySelectorAll('li[id^="library-segment-"]')).toHaveLength(100)
    await act(async () => button('复制全文').click())
    expect(mocks.copyText).toHaveBeenCalledWith(expect.stringContaining('原文片段204'))
    await act(async () => button('章节与问答').click())
    await enter('检索问题', '最后一段')
    mocks.libraryCall.mockResolvedValueOnce({
      method: 'extractive',
      answer: '最后一段如下。',
      evidence: [{ segmentId: 'page-segment-204', startMs: 204000, endMs: 204900, text: '原文片段204' }],
    })
    await act(async () => button('查找原文依据').click())
    await act(async () => button('原文 3:24').click())
    expect(container.querySelectorAll('li[id^="library-segment-"]')).toHaveLength(5)
    expect(container.querySelector('#library-segment-page-segment-204')).not.toBeNull()
    expect(container.querySelector<HTMLSelectElement>('[aria-label="片段页码"]')?.value).toBe('3')
    await enter('在当前记录中查找', '原文片段0')
    expect(container.querySelector('#library-segment-page-segment-0')).not.toBeNull()
  })

  it('opens original transcript evidence from extractive question results', async () => {
    await act(async () => button('章节与问答').click())
    await enter('检索问题', '谁拥有内存？')
    mocks.libraryCall.mockResolvedValueOnce({
      method: 'extractive',
      answer: '相关原文如下。',
      evidence: [{ segmentId: 'second', startMs: 10000, endMs: 14000, text: 'Memory needs ownership.' }],
    })
    await act(async () => button('查找原文依据').click())
    expect(mocks.libraryCall).toHaveBeenCalledWith('ask', { id: initial.id, question: '谁拥有内存？' })
    await act(async () => button('原文 0:10').click())
    const evidence = container.querySelector('#library-segment-second')
    expect(evidence?.className).toContain('border-[var(--color-accent)]')
    expect(evidence?.textContent).toContain('Memory needs ownership.')
  })

  it('does not delete a record until its confirmation action is selected', async () => {
    await act(async () => button('删除记录').click())
    expect(mocks.libraryCall).not.toHaveBeenCalledWith('delete', expect.anything())
    await act(async () => button('确认删除').click())
    expect(mocks.libraryCall).toHaveBeenCalledWith('delete', { id: initial.id })
    expect(mocks.deleted).toHaveBeenCalledWith(initial.id)
  })

  it('offers text-only refinement for every record and re-recognition when media is retained', async () => {
    await act(async () => button('译文另存精修版').click())
    expect(mocks.reprocess).toHaveBeenCalledWith(initial.id, 'translate')
    expect(
      Array.from(container.querySelectorAll('button')).some((item) => item.textContent?.trim() === '重新识别'),
    ).toBe(false)
    await act(async () =>
      publishRecord({ ...initial, source: { ...initial.source, mediaPath: '/library/media/course.wav' } }),
    )
    await act(async () => button('重新识别').click())
    expect(mocks.reprocess).toHaveBeenCalledWith(initial.id, 'transcribe')
  })

  it('saves a new personal term without losing the draft on failure', async () => {
    await act(async () => button('个人术语表').click())
    await enter('原文术语', 'ownership')
    await enter('惯用译法', '所有权')
    mocks.libraryCall.mockRejectedValueOnce(new Error('写入失败'))
    await act(async () => button('添加术语').click())
    expect(container.querySelector<HTMLInputElement>('[aria-label="原文术语"]')?.value).toBe('ownership')
    mocks.libraryCall.mockResolvedValueOnce({
      id: 'term-1',
      source: 'ownership',
      target: '所有权',
      note: '',
      createdAt: 1,
      updatedAt: 1,
    })
    await act(async () => button('添加术语').click())
    expect(mocks.libraryCall).toHaveBeenLastCalledWith('terms_upsert', {
      term: { source: 'ownership', target: '所有权', note: '' },
    })
    expect(container.querySelector<HTMLInputElement>('[aria-label="原文术语"]')?.value).toBe('')
    expect(container.textContent).toContain('所有权')
  })

  it('reviews term correction before applying it against the expected segment version', async () => {
    await act(async () => button('个人术语表').click())
    mocks.libraryCall.mockResolvedValueOnce([
      {
        segmentId: 'first',
        termId: 'term-rust',
        expectedRevision: 2,
        termUpdatedAt: 123,
        source: 'Rust',
        target: '锈语言',
        originalTranslation: 'Rust 避免数据竞争。',
        suggestedTranslation: '锈语言避免数据竞争。',
        occurrences: 1,
        explanation: '原文命中术语，现译文仍保留英文。',
      },
    ])
    await act(async () => button('检查本记录术语').click())
    expect(container.textContent).toContain('原译文：Rust 避免数据竞争。')
    expect(container.textContent).toContain('建议译文：锈语言避免数据竞争。')
    expect(mocks.libraryCall).not.toHaveBeenCalledWith('terms_apply', expect.anything())
    mocks.libraryCall.mockResolvedValueOnce({ ...initial, revision: 5 }).mockResolvedValueOnce([])
    await act(async () => button('应用此处校正').click())
    expect(mocks.libraryCall).toHaveBeenCalledWith('terms_apply', {
      id: initial.id,
      segmentId: 'first',
      termId: 'term-rust',
      expectedRevision: 2,
      expectedTermUpdatedAt: 123,
    })
    expect(container.textContent).toContain('本次检查没有需要校正的译文')
  })
})
