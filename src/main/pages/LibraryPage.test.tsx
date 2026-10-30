import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { libraryRecord } from '@/main/library/test-fixtures'
import type { MediaJobInfo, MediaProcessOptions } from '@/shared/media'

const mocks = vi.hoisted(() => ({
  libraryCall: vi.fn(),
  open: vi.fn(),
  on: vi.fn(),
  unsubscribe: vi.fn(),
  importMediaFile: vi.fn(),
  importSubtitleFile: vi.fn(),
  mediaJobStatus: vi.fn(),
  cancelMediaJob: vi.fn(),
  reprocessMediaRecord: vi.fn(),
  sessionStatus: vi.fn(),
}))

vi.mock('@/shared/ipc', async () => ({
  ...(await vi.importActual<typeof import('@/shared/ipc')>('@/shared/ipc')),
  libraryCall: mocks.libraryCall,
  on: mocks.on,
  sessionStatus: mocks.sessionStatus,
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.open }))
vi.mock('@/shared/media', () => ({
  importMediaFile: mocks.importMediaFile,
  importSubtitleFile: mocks.importSubtitleFile,
  mediaJobStatus: mocks.mediaJobStatus,
  cancelMediaJob: mocks.cancelMediaJob,
  reprocessMediaRecord: mocks.reprocessMediaRecord,
}))
vi.mock('@/main/library/LibraryRecordView', () => ({
  LibraryRecordView: ({
    record,
    onReprocess,
    initialSegmentId,
  }: {
    record: { id: string; title: string }
    onReprocess: (id: string, mode: 'translate' | 'transcribe') => void
    initialSegmentId?: string
  }) => (
    <div>
      <span data-testid="record-view">{record.title}</span>
      <span data-testid="focused-segment">{initialSegmentId}</span>
      <button type="button" onClick={() => onReprocess(record.id, 'translate')}>
        译文精修测试入口
      </button>
    </div>
  ),
}))

import { LibraryPage } from './LibraryPage'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function job(id: string, status: MediaJobInfo['status'], recordId?: string): MediaJobInfo {
  return {
    jobId: id,
    sourceId: 'source-1',
    status,
    phase: status === 'completed' ? 'done' : 'decoding',
    progress: status === 'completed' ? 100 : 1,
    recordId,
  }
}

describe('LibraryPage records and media jobs', () => {
  let container: HTMLDivElement
  let root: Root

  function button(label: string) {
    const result = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
    if (!result) throw new Error(`按钮未找到：${label}`)
    return result
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    const first = libraryRecord()
    const second = { ...libraryRecord('record-2'), title: '第二条记录' }
    mocks.libraryCall.mockReset().mockImplementation(async (action: string, args: { id?: string }) =>
      action === 'browse'
        ? {
            records: [first, second].map(({ segments, ...record }) => ({
              ...record,
              segmentCount: segments.length,
              bookmarkCount: 0,
            })),
            hits: [],
            issues: [],
          }
        : args.id === 'record-2'
          ? second
          : first,
    )
    mocks.on.mockReset().mockResolvedValue(mocks.unsubscribe)
    mocks.open.mockReset()
    mocks.importMediaFile.mockReset()
    mocks.importSubtitleFile.mockReset()
    mocks.mediaJobStatus.mockReset()
    mocks.cancelMediaJob.mockReset()
    mocks.reprocessMediaRecord.mockReset()
    mocks.sessionStatus.mockReset().mockResolvedValue({ actions: { canStart: true } })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root.render(<LibraryPage />))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('does not let a delayed open replace the later selected record', async () => {
    let finish!: (value: ReturnType<typeof libraryRecord>) => void
    mocks.libraryCall.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const records = container.querySelectorAll<HTMLButtonElement>('[aria-label="最近记录"] li button')
    await act(async () => records[0].click())
    await act(async () => records[1].click())
    expect(container.querySelector('[data-testid="record-view"]')?.textContent).toBe('第二条记录')
    await act(async () => finish(libraryRecord()))
    expect(container.querySelector('[data-testid="record-view"]')?.textContent).toBe('第二条记录')
  })

  it('imports subtitles with an explicitly selected associated media source', async () => {
    mocks.open.mockResolvedValueOnce('/tmp/course.mp4').mockResolvedValueOnce('/tmp/course.srt')
    mocks.importSubtitleFile.mockResolvedValueOnce(libraryRecord())
    await act(async () => button('为字幕选择回放媒体').click())
    await act(async () => button('导入字幕').click())
    expect(mocks.importSubtitleFile).toHaveBeenCalledWith('/tmp/course.srt', {
      mediaPath: '/tmp/course.mp4',
      sourceLang: 'en',
    })
    expect(container.querySelector('[data-testid="record-view"]')?.textContent).toBe('内存管理课程')
  })

  it('recovers from a native file picker failure without locking later imports', async () => {
    mocks.open.mockRejectedValueOnce(new Error('文件选择器暂不可用'))
    await act(async () => button('导入音视频').click())
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('文件选择器暂不可用')
    expect(button('导入音视频').disabled).toBe(false)
    mocks.open.mockResolvedValueOnce('/tmp/retry.srt')
    mocks.importSubtitleFile.mockResolvedValueOnce(libraryRecord())
    await act(async () => button('导入字幕').click())
    expect(mocks.importSubtitleFile).toHaveBeenCalledWith('/tmp/retry.srt', { sourceLang: 'en' })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('checks session availability before picking or decoding a media file', async () => {
    mocks.sessionStatus.mockResolvedValueOnce({ actions: { canStart: false, reason: '正在采集中' } })
    await act(async () => button('导入音视频').click())
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.importMediaFile).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('请先停止转写')
    expect(button('导入音视频').disabled).toBe(false)
  })

  it('shows readable records and searchable evidence alongside damaged record notices', async () => {
    const record = libraryRecord()
    mocks.libraryCall.mockResolvedValueOnce({
      records: [{ ...record, segmentCount: 2, bookmarkCount: 0 }],
      hits: [{ recordId: record.id, segmentId: 'second', startMs: 10000, field: '笔记', excerpt: '复习内存所有权' }],
      issues: [{ id: 'damaged-record', error: '记录无法读取' }],
    })
    await act(async () => button('刷新').click())
    expect(container.textContent).toContain('原文件已保留')
    expect(container.textContent).toContain('复习内存所有权')
    const hit = container.querySelector<HTMLButtonElement>('button[aria-label^="定位笔记"]')
    if (!hit) throw new Error('搜索结果入口未找到')
    await act(async () => hit.click())
    expect(container.querySelector('[data-testid="record-view"]')?.textContent).toBe(record.title)
    expect(container.querySelector('[data-testid="focused-segment"]')?.textContent).toBe('second')
  })

  it('uses the stored record language for refinement instead of the next import preference', async () => {
    const record = { ...libraryRecord(), source: { ...libraryRecord().source, sourceLang: 'zh' } }
    mocks.libraryCall.mockResolvedValueOnce(record)
    const recordButton = container.querySelector<HTMLButtonElement>('[aria-label="最近记录"] li button')
    if (!recordButton) throw new Error('记录入口未找到')
    await act(async () => recordButton.click())
    const language = container.querySelector<HTMLSelectElement>('select')
    if (!language) throw new Error('语言选项未找到')
    await act(async () => {
      language.value = 'en'
      language.dispatchEvent(new Event('change', { bubbles: true }))
    })
    mocks.reprocessMediaRecord.mockResolvedValueOnce(job('language-test', 'completed', 'record-2'))
    await act(async () => button('译文精修测试入口').click())
    expect(mocks.reprocessMediaRecord).toHaveBeenCalledWith('record-1', expect.objectContaining({ sourceLang: 'zh' }))
  })

  it('creates a separately named translation refinement for a record without retained media', async () => {
    const recordButton = container.querySelector<HTMLButtonElement>('[aria-label="最近记录"] li button')
    if (!recordButton) throw new Error('记录入口未找到')
    await act(async () => recordButton.click())
    mocks.reprocessMediaRecord.mockResolvedValueOnce(job('refinement-test', 'completed', 'record-2'))
    await act(async () => button('译文精修测试入口').click())
    expect(mocks.reprocessMediaRecord).toHaveBeenCalledWith(
      'record-1',
      expect.objectContaining({ mode: 'translate', title: '内存管理课程 · 译文精修', translate: true }),
    )
    expect(container.querySelector('[data-testid="record-view"]')?.textContent).toContain('第二条记录')
  })

  it('aborts preparation and cancels its backend job, then allows another import', async () => {
    const pending = job('cancel-test', 'preparing')
    mocks.open.mockResolvedValueOnce('/tmp/course.mp4')
    mocks.importMediaFile.mockImplementationOnce((_path: string, options: MediaProcessOptions) => {
      options.onProgress?.(pending)
      return new Promise((_resolve, reject) =>
        options.signal?.addEventListener('abort', () => reject(new Error('导入已取消'))),
      )
    })
    mocks.cancelMediaJob.mockResolvedValueOnce(job('cancel-test', 'cancelled'))
    await act(async () => button('导入音视频').click())
    expect(button('导入音视频').disabled).toBe(true)
    await act(async () => button('取消处理').click())
    expect(mocks.cancelMediaJob).toHaveBeenCalledWith('cancel-test')
    expect(mocks.importMediaFile.mock.calls[0][1].signal.aborted).toBe(true)
    expect(button('导入音视频').disabled).toBe(false)
  })

  it('keeps an active job across page recreation and opens its saved result', async () => {
    mocks.open.mockResolvedValueOnce('/tmp/course.wav')
    mocks.importMediaFile.mockResolvedValueOnce(job('restore-test', 'queued'))
    await act(async () => button('导入音视频').click())
    await act(async () => root.render(null))
    mocks.mediaJobStatus.mockResolvedValueOnce({
      ...job('restore-test', 'completed', 'record-2'),
      error: '一段翻译失败，原文已保存。',
    })
    await act(async () => root.render(<LibraryPage />))
    expect(button('导入音视频').disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(mocks.mediaJobStatus).toHaveBeenCalledWith('restore-test')
    expect(container.querySelector('[data-testid="record-view"]')?.textContent).toBe('第二条记录')
    expect(container.textContent).toContain('一段翻译失败，原文已保存')
    expect(button('导入音视频').disabled).toBe(false)
  })

  it('continues polling after a transient progress failure until the saved record is available', async () => {
    mocks.open.mockResolvedValueOnce('/tmp/course.wav')
    mocks.importMediaFile.mockResolvedValueOnce(job('poll-retry', 'queued'))
    mocks.mediaJobStatus
      .mockRejectedValueOnce(new Error('短暂连接失败'))
      .mockResolvedValueOnce(job('poll-retry', 'completed', 'record-2'))
    await act(async () => button('导入音视频').click())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(button('导入音视频').disabled).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(container.querySelector('[data-testid="record-view"]')?.textContent).toBe('第二条记录')
    expect(button('导入音视频').disabled).toBe(false)
  })
})
