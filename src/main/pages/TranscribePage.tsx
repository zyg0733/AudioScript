import { save } from '@tauri-apps/plugin-dialog'
import { useRef, useState } from 'react'
import { LivePersistenceControls } from '@/main/LivePersistenceControls'
import { useStore } from '@/main/store'
import { useI18n } from '@/shared/i18n'
import { formatCmdError, retryTranslations, revealPath, transcriptExport } from '@/shared/ipc'
import { TaskStatus } from '@/shared/types'
import { useTranscriptStream } from '@/shared/useTranscriptStream'
import { Alert } from '@/ui/Alert'
import { Button } from '@/ui/Button'
import { Page } from '@/ui/Page'
import { SegmentList } from '@/ui/SegmentList'

function exportStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function TranscribePage({ onOpenLibrary }: { onOpenLibrary?: (id: string) => void } = {}) {
  const { segments, clear, error: streamError, reconnect, reconnecting } = useTranscriptStream()
  const { status, sessionInfo, clearAll, setError, refreshSession } = useStore()
  const { t } = useI18n()
  const [pending, setPending] = useState<'clear' | 'export' | 'reveal' | 'retry' | null>(null)
  const pendingRef = useRef(false)
  const [savedExport, setSavedExport] = useState<{ path: string; revealError: string | null } | null>(null)
  const capturing = status === TaskStatus.Capturing
  const canClear = Boolean(sessionInfo?.actions.canClear) && segments.length > 0
  const canExport = Boolean(sessionInfo?.actions.canExport) && segments.some((s) => s.state !== 'partial')
  const actionReason = sessionInfo?.actions.reason ?? (sessionInfo ? null : '正在同步会话状态，请稍后重试。')
  const accessRef = useRef({ canClear, canExport, reason: actionReason })
  accessRef.current = { canClear, canExport, reason: actionReason }

  function begin(operation: NonNullable<typeof pending>): boolean {
    if (pendingRef.current) return false
    pendingRef.current = true
    setPending(operation)
    return true
  }

  function finish() {
    pendingRef.current = false
    setPending(null)
  }

  async function openSavedPath(path: string) {
    try {
      await revealPath(path)
      setSavedExport({ path, revealError: null })
    } catch (e) {
      setSavedExport({ path, revealError: formatCmdError(e) })
    }
  }

  async function handleClear() {
    if (!accessRef.current.canClear || !begin('clear')) return
    try {
      await clearAll()
      clear()
    } catch (e) {
      setError(formatCmdError(e))
    } finally {
      finish()
    }
  }

  async function handleExport() {
    if (!accessRef.current.canExport || !begin('export')) return
    try {
      const stamp = exportStamp()
      const path = await save({
        defaultPath: t('transcribe.exportFileName', { stamp: stamp.replace(/:/g, '-') }),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (!path) return
      if (!accessRef.current.canExport) {
        setError(accessRef.current.reason ?? '会话状态已变化，请等待转写收尾完成后再导出。')
        return
      }
      const { path: saved } = await transcriptExport(stamp, path)
      setSavedExport({ path: saved, revealError: null })
      await openSavedPath(saved)
    } catch (e) {
      setError(`未能保存转写，请重试：${formatCmdError(e)}`)
    } finally {
      finish()
    }
  }

  async function handleReveal() {
    if (!savedExport || !begin('reveal')) return
    try {
      await openSavedPath(savedExport.path)
    } finally {
      finish()
    }
  }

  async function handleRetry(ids: string[]) {
    if (!sessionInfo?.actions.canStart || !begin('retry')) return
    try {
      await retryTranslations(ids.slice(0, 50))
    } catch (e) {
      setError(formatCmdError(e))
    } finally {
      finish()
      void refreshSession()
    }
  }

  const failedIds = segments.filter((s) => s.translationState === 'failed').map((s) => s.id)

  return (
    <Page title="转写">
      {streamError && (
        <Alert tone="error" title="转写内容同步失败">
          <p>{streamError}</p>
          <Button size="sm" disabled={reconnecting} onClick={reconnect}>
            {reconnecting ? '正在重连…' : '重新同步字幕'}
          </Button>
        </Alert>
      )}
      <LivePersistenceControls canSave={canExport && pending === null} onOpenLibrary={onOpenLibrary} />
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void handleClear()} disabled={!canClear || pending !== null} size="sm">
          {pending === 'clear' ? '清空中…' : '清空'}
        </Button>
        <Button icon="download" size="sm" disabled={!canExport || pending !== null} onClick={() => void handleExport()}>
          {pending === 'export' ? '导出中…' : '导出'}
        </Button>
        {failedIds.length > 0 && (
          <Button
            size="sm"
            disabled={!sessionInfo?.actions.canStart || pending !== null}
            onClick={() => void handleRetry(failedIds)}
          >
            {pending === 'retry' ? '重新翻译中…' : `重试失败译文${failedIds.length > 50 ? '（前50段）' : ''}`}
          </Button>
        )}
        <span className="ml-auto font-mono text-[var(--color-ink-2)] text-[0.7rem]">{segments.length} 段</span>
      </div>
      {actionReason && (!canClear || !canExport) && <p className="text-[var(--color-ink-2)] text-xs">{actionReason}</p>}
      {savedExport && (
        <Alert tone={savedExport.revealError ? 'warn' : 'info'} title="转写已保存">
          <p className="break-all">保存位置：{savedExport.path}</p>
          {savedExport.revealError && <p>文件已保存，但暂时无法打开所在位置：{savedExport.revealError}</p>}
          <Button size="sm" disabled={pending !== null} onClick={() => void handleReveal()} className="mt-2">
            {pending === 'reveal' ? '正在打开…' : savedExport.revealError ? '重试打开所在位置' : '打开所在位置'}
          </Button>
        </Alert>
      )}

      <SegmentList
        onRetry={(id) => void handleRetry([id])}
        retryDisabled={!sessionInfo?.actions.canStart || pending !== null}
        segments={segments}
        emptyText={capturing ? '识别中…' : '点击左上角「开始转写」。'}
      />

      {!capturing && segments.length > 0 && (
        <p className="text-[var(--color-ink-2)] text-[0.7rem]">
          保存后可在资料库继续修订、标记和导出；清空当前转写不会删除已保存记录。
        </p>
      )}
    </Page>
  )
}
