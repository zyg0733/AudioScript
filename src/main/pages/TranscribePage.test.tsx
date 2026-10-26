import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SegmentState, TaskStatus, type TranscriptSegment, TranslationState } from '@/shared/types'
import { TranscribePage } from './TranscribePage'

const mocks = vi.hoisted(() => ({
  clearAll: vi.fn(),
  localClear: vi.fn(),
  setError: vi.fn(),
  save: vi.fn(),
  revealPath: vi.fn(),
  transcriptExport: vi.fn(),
  segments: [] as TranscriptSegment[],
  streamError: null as string | null,
  status: 'ready' as TaskStatus,
  sessionInfo: null as {
    actions: { canClear: boolean; canExport: boolean; reason: string | null }
  } | null,
}))

vi.mock('@/main/store', () => ({
  useStore: () => ({
    status: mocks.status,
    sessionInfo: mocks.sessionInfo,
    clearAll: mocks.clearAll,
    setError: mocks.setError,
  }),
}))

vi.mock('@/shared/useTranscriptStream', () => ({
  useTranscriptStream: () => ({ segments: mocks.segments, clear: mocks.localClear, error: mocks.streamError }),
}))

vi.mock('@/shared/ipc', async () => ({
  ...(await vi.importActual<typeof import('@/shared/ipc')>('@/shared/ipc')),
  revealPath: mocks.revealPath,
  transcriptExport: mocks.transcriptExport,
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('TranscribePage transcript actions', () => {
  let container: HTMLDivElement
  let root: Root

  async function render() {
    await act(async () => root.render(<TranscribePage />))
  }

  function button(label: string) {
    const button = Array.from(container.querySelectorAll('button')).find((item) =>
      item.textContent?.trim().startsWith(label),
    )
    if (!button) throw new Error(`${label}按钮未找到`)
    return button
  }

  const clearButton = () => button('清空')
  const exportButton = () => button('导出')

  beforeEach(() => {
    mocks.clearAll.mockReset()
    mocks.localClear.mockReset()
    mocks.setError.mockReset()
    mocks.save.mockReset()
    mocks.revealPath.mockReset()
    mocks.transcriptExport.mockReset()
    mocks.clearAll.mockResolvedValue(undefined)
    mocks.save.mockResolvedValue(null)
    mocks.transcriptExport.mockResolvedValue({ path: '/tmp/transcript.md' })
    mocks.revealPath.mockResolvedValue(null)
    mocks.streamError = null
    mocks.status = TaskStatus.Ready
    mocks.sessionInfo = { actions: { canClear: true, canExport: true, reason: null } }
    mocks.segments = [
      {
        id: 'saved',
        startMs: 0,
        endMs: 100,
        text: '需要保留的转写',
        state: SegmentState.Final,
        translationState: TranslationState.Idle,
        revision: 1,
      },
    ]
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('reports a backend clear rejection and preserves the local transcript', async () => {
    mocks.clearAll.mockRejectedValue(new Error('上一次会话仍在收尾，请稍后重试'))
    await render()
    await act(async () => clearButton().click())

    expect(mocks.clearAll).toHaveBeenCalledOnce()
    expect(mocks.localClear).not.toHaveBeenCalled()
    expect(mocks.setError).toHaveBeenCalledWith(expect.stringContaining('上一次会话仍在收尾'))
    expect(container.textContent).toContain('需要保留的转写')
  })

  it('clears local state only after the backend confirms success', async () => {
    let finishClear!: () => void
    mocks.clearAll.mockReturnValue(
      new Promise<void>((resolve) => {
        finishClear = resolve
      }),
    )
    await render()
    await act(async () => clearButton().click())
    expect(mocks.clearAll).toHaveBeenCalledOnce()
    expect(mocks.localClear).not.toHaveBeenCalled()

    await act(async () => finishClear())
    expect(mocks.localClear).toHaveBeenCalledOnce()
    expect(mocks.setError).not.toHaveBeenCalled()
  })

  it('locks clear immediately against rapid duplicate clicks and concurrent export', async () => {
    const clearing = deferred<void>()
    mocks.clearAll.mockReturnValue(clearing.promise)
    await render()
    const clear = clearButton()
    const exportAction = exportButton()
    await act(async () => {
      clear.click()
      clear.click()
      exportAction.click()
    })

    expect(mocks.clearAll).toHaveBeenCalledOnce()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(clearButton().disabled).toBe(true)
    expect(exportButton().disabled).toBe(true)
    await act(async () => clearing.resolve(undefined))
    expect(mocks.localClear).toHaveBeenCalledOnce()
    expect(clearButton().disabled).toBe(false)
  })

  it('uses the backend action policy even when the task status still says ready', async () => {
    mocks.sessionInfo = {
      actions: { canClear: false, canExport: false, reason: '正在完成转写收尾，请稍后重试' },
    }
    await render()

    expect(clearButton().disabled).toBe(true)
    expect(exportButton().disabled).toBe(true)
    expect(container.textContent).toContain('正在完成转写收尾，请稍后重试')
    await act(async () => {
      clearButton().click()
      exportButton().click()
    })
    expect(mocks.clearAll).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })

  it('waits for a session policy and requires a final segment before exporting', async () => {
    mocks.sessionInfo = null
    await render()
    expect(clearButton().disabled).toBe(true)
    expect(exportButton().disabled).toBe(true)
    expect(container.textContent).toContain('正在同步会话状态')

    mocks.sessionInfo = { actions: { canClear: true, canExport: true, reason: null } }
    mocks.segments = [{ ...mocks.segments[0], state: SegmentState.Partial }]
    await render()
    expect(clearButton().disabled).toBe(false)
    expect(exportButton().disabled).toBe(true)
  })

  it('shows stream synchronization errors alongside existing transcript content', async () => {
    mocks.streamError = '字幕订阅失败：监听不可用'
    await render()

    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('转写内容同步失败')
    expect(alert?.textContent).toContain('字幕订阅失败：监听不可用')
    expect(container.textContent).toContain('需要保留的转写')
  })

  it('reports an export rejected during teardown and does not reveal an unfinished file', async () => {
    mocks.save.mockResolvedValue('/tmp/transcript.md')
    mocks.transcriptExport.mockRejectedValue(new Error('会话仍在收尾，请稍后再导出'))
    await render()
    await act(async () => exportButton().click())
    expect(mocks.setError).toHaveBeenCalledWith(expect.stringContaining('会话仍在收尾'))
    expect(mocks.revealPath).not.toHaveBeenCalled()
    expect(container.textContent).toContain('需要保留的转写')
  })

  it('locks the entire export flow against double clicks and concurrent clear', async () => {
    const selectingPath = deferred<string | null>()
    const writing = deferred<{ path: string }>()
    mocks.save.mockReturnValue(selectingPath.promise)
    mocks.transcriptExport.mockReturnValue(writing.promise)
    await render()
    const exportAction = exportButton()
    const clear = clearButton()
    await act(async () => {
      exportAction.click()
      exportAction.click()
      clear.click()
    })

    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.clearAll).not.toHaveBeenCalled()
    expect(clearButton().disabled).toBe(true)
    await act(async () => selectingPath.resolve('/tmp/transcript.md'))
    expect(mocks.transcriptExport).toHaveBeenCalledOnce()
    expect(exportButton().disabled).toBe(true)
    expect(mocks.revealPath).not.toHaveBeenCalled()

    await act(async () => writing.resolve({ path: '/tmp/transcript.md' }))
    expect(mocks.revealPath).toHaveBeenCalledWith('/tmp/transcript.md')
    expect(exportButton().disabled).toBe(false)
    expect(container.textContent).toContain('转写已保存')
    expect(mocks.localClear).not.toHaveBeenCalled()
  })

  it('quietly cancels the save dialog and releases the action lock', async () => {
    await render()
    await act(async () => exportButton().click())

    expect(mocks.transcriptExport).not.toHaveBeenCalled()
    expect(mocks.revealPath).not.toHaveBeenCalled()
    expect(mocks.setError).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('转写已保存')
    expect(container.textContent).toContain('需要保留的转写')
    expect(exportButton().disabled).toBe(false)
    await act(async () => clearButton().click())
    expect(mocks.clearAll).toHaveBeenCalledOnce()
  })

  it('rechecks export access after the save dialog if session finalization starts meanwhile', async () => {
    const selectingPath = deferred<string | null>()
    mocks.save.mockReturnValue(selectingPath.promise)
    await render()
    await act(async () => exportButton().click())
    mocks.sessionInfo = {
      actions: { canClear: false, canExport: false, reason: '会话正在收尾，请稍后导出' },
    }
    await render()
    await act(async () => selectingPath.resolve('/tmp/transcript.md'))

    expect(mocks.transcriptExport).not.toHaveBeenCalled()
    expect(mocks.revealPath).not.toHaveBeenCalled()
    expect(mocks.setError).toHaveBeenCalledWith('会话正在收尾，请稍后导出')
    expect(container.textContent).toContain('需要保留的转写')
  })

  it('reports a dialog failure, keeps the transcript, and permits a later attempt', async () => {
    mocks.save.mockRejectedValueOnce(new Error('保存对话框不可用'))
    await render()
    await act(async () => exportButton().click())

    expect(mocks.setError).toHaveBeenCalledWith(expect.stringContaining('保存对话框不可用'))
    expect(mocks.transcriptExport).not.toHaveBeenCalled()
    expect(mocks.localClear).not.toHaveBeenCalled()
    expect(container.textContent).toContain('需要保留的转写')
    expect(exportButton().disabled).toBe(false)
    await act(async () => exportButton().click())
    expect(mocks.save).toHaveBeenCalledTimes(2)
  })

  it('keeps transcript content on a write failure and allows the export to be retried', async () => {
    mocks.save.mockResolvedValue('/tmp/transcript.md')
    mocks.transcriptExport.mockRejectedValueOnce(new Error('磁盘空间不足'))
    await render()
    await act(async () => exportButton().click())

    expect(mocks.setError).toHaveBeenCalledWith(expect.stringContaining('未能保存转写'))
    expect(mocks.setError).toHaveBeenCalledWith(expect.stringContaining('磁盘空间不足'))
    expect(mocks.revealPath).not.toHaveBeenCalled()
    expect(mocks.localClear).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('转写已保存')
    expect(container.textContent).toContain('需要保留的转写')
    expect(exportButton().disabled).toBe(false)

    await act(async () => exportButton().click())
    expect(mocks.transcriptExport).toHaveBeenCalledTimes(2)
    expect(mocks.revealPath).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('转写已保存')
  })

  it('keeps a successful saved path when revealing fails and retries only opening that path', async () => {
    mocks.save.mockResolvedValue('/tmp/chosen.md')
    mocks.transcriptExport.mockResolvedValue({ path: '/tmp/actual-saved.md' })
    mocks.revealPath.mockRejectedValueOnce(new Error('文件管理器暂不可用'))
    await render()
    await act(async () => exportButton().click())

    expect(container.textContent).toContain('转写已保存')
    expect(container.textContent).toContain('/tmp/actual-saved.md')
    expect(container.textContent).toContain('文件已保存，但暂时无法打开所在位置')
    expect(container.textContent).toContain('文件管理器暂不可用')
    expect(mocks.setError).not.toHaveBeenCalled()

    const revealing = deferred<null>()
    mocks.revealPath.mockReturnValueOnce(revealing.promise)
    const retry = button('重试打开所在位置')
    await act(async () => {
      retry.click()
      retry.click()
    })
    expect(mocks.revealPath).toHaveBeenCalledTimes(2)
    expect(mocks.revealPath).toHaveBeenLastCalledWith('/tmp/actual-saved.md')
    expect(mocks.save).toHaveBeenCalledOnce()
    expect(mocks.transcriptExport).toHaveBeenCalledOnce()
    expect(button('正在打开').disabled).toBe(true)

    await act(async () => revealing.resolve(null))
    expect(container.textContent).not.toContain('暂时无法打开')
    expect(container.textContent).toContain('/tmp/actual-saved.md')
    expect(button('打开所在位置').disabled).toBe(false)
    expect(mocks.setError).not.toHaveBeenCalled()
  })

  it('keeps the saved path and retry action available after a second reveal failure', async () => {
    mocks.save.mockResolvedValue('/tmp/transcript.md')
    mocks.revealPath.mockRejectedValue(new Error('仍无法打开'))
    await render()
    await act(async () => exportButton().click())
    await act(async () => button('重试打开所在位置').click())

    expect(container.textContent).toContain('转写已保存')
    expect(container.textContent).toContain('/tmp/transcript.md')
    expect(container.textContent).toContain('仍无法打开')
    expect(button('重试打开所在位置').disabled).toBe(false)
    expect(mocks.transcriptExport).toHaveBeenCalledOnce()
    expect(mocks.setError).not.toHaveBeenCalled()
  })
})
