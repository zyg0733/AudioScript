import { useEffect, useRef, useState } from 'react'
import { formatCmdError, on, workspaceCall } from '@/shared/ipc'
import type { WorkspaceStatus } from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { Button } from '@/ui/Button'

export function LivePersistenceControls({
  canSave,
  onOpenLibrary,
}: {
  canSave: boolean
  onOpenLibrary?: (id: string) => void
}) {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const lock = useRef(false)

  useEffect(() => {
    let disposed = false
    let broadcast = false
    let off: (() => void) | undefined
    on<WorkspaceStatus>('workspace://changed', (next) => {
      broadcast = true
      if (!disposed) setStatus(next)
    })
      .then((fn) => {
        if (disposed) fn()
        else off = fn
      })
      .catch((e) => {
        if (!disposed) setError(formatCmdError(e))
      })
    workspaceCall<WorkspaceStatus>('status')
      .then((value) => {
        if (!disposed && !broadcast) setStatus(value)
      })
      .catch((e) => {
        if (!disposed) setError(formatCmdError(e))
      })
    return () => {
      disposed = true
      off?.()
    }
  }, [])

  async function run(action: string, args: Record<string, unknown> = {}) {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setError(null)
    try {
      setStatus(await workspaceCall<WorkspaceStatus>(action, args))
    } catch (e) {
      setError(formatCmdError(e))
    } finally {
      lock.current = false
      setPending(false)
    }
  }

  const failure = error ?? status?.error
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-2 text-[var(--color-ink-2)]">
          <input
            type="checkbox"
            checked={status?.enabled ?? false}
            disabled={!status || pending}
            onChange={(e) => void run('set', { enabled: e.target.checked })}
          />
          自动保存到资料库
        </label>
        <Button size="sm" disabled={!canSave || pending || !status} onClick={() => void run('save')}>
          {pending ? '保存中…' : status?.recordId ? '保存最新内容' : '保存到资料库'}
        </Button>
        {status?.recordId && onOpenLibrary && (
          <Button size="sm" variant="ghost" onClick={() => onOpenLibrary(status.recordId as string)}>
            查看已保存记录
          </Button>
        )}
        <span role="status" className="text-[var(--color-ink-2)]">
          {status?.saving
            ? '正在自动保存…'
            : status?.savedAt
              ? `最近保存 ${new Date(status.savedAt).toLocaleTimeString()}`
              : '临时内容退出后不保留，保存后可修订和摘录。'}
        </span>
      </div>
      {failure && (
        <Alert tone="warn" title="内容尚未保存">
          <p>{failure}</p>
          <Button size="sm" disabled={!canSave || pending} onClick={() => void run('save', { asNew: true })}>
            另存为新记录
          </Button>
        </Alert>
      )}
    </div>
  )
}
