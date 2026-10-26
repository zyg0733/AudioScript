import { useRef, useState } from 'react'
import { PermissionPanel } from '@/main/permissions/PermissionPanel'
import { useStore } from '@/main/store'
import { Alert } from '@/ui/Alert'
import { Button } from '@/ui/Button'
import { TitleBarSpacer } from '@/ui/TitleBarSpacer'
import { LogoMark } from './Brand'

export function WelcomeGate() {
  const { info, error, completeOnboarding } = useStore()
  const [pendingAction, setPendingAction] = useState<'skip' | 'start' | null>(null)
  const submitting = useRef(false)

  async function finish(action: 'skip' | 'start') {
    if (submitting.current) return
    submitting.current = true
    setPendingAction(action)
    try {
      await completeOnboarding()
    } finally {
      submitting.current = false
      setPendingAction(null)
    }
  }

  return (
    <main className="flex h-full flex-col bg-[var(--color-surface-0)]">
      <TitleBarSpacer />

      <div className="flex flex-1 items-start justify-center overflow-y-auto px-6 pb-10">
        <div className="w-full max-w-md space-y-6">
          <header className="space-y-3 pt-6 text-center">
            <LogoMark className="mx-auto block h-16 text-[var(--color-ink-0)] [&>svg]:block [&>svg]:h-full [&>svg]:w-auto" />
            <h1 className="font-semibold text-[var(--color-ink-0)] text-xl">欢迎使用 {info?.name ?? 'AudioScript'}</h1>
            <p className="text-[var(--color-ink-1)] text-sm">请先确认系统权限</p>
          </header>

          {error && (
            <Alert tone="error" title="未能完成操作">
              <p>{error}</p>
              <p className="mt-1">请检查后重试。</p>
            </Alert>
          )}

          <PermissionPanel />

          <div className="flex items-center justify-between gap-3">
            <Button disabled={pendingAction !== null} onClick={() => void finish('skip')}>
              {pendingAction === 'skip' ? '正在保存…' : '稍后再说'}
            </Button>
            <Button variant="cta" disabled={pendingAction !== null} onClick={() => void finish('start')}>
              {pendingAction === 'start' ? '正在保存…' : '开始使用'}
            </Button>
          </div>

          <p className="text-center text-[var(--color-ink-2)] text-[0.7rem]">跳过之后可在「权限」页复查。</p>
        </div>
      </div>
    </main>
  )
}
