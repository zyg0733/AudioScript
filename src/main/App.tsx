import { useState } from 'react'
import { TaskStatus } from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { Button } from '@/ui/Button'
import { LevelStatus } from '@/ui/LevelStatus'
import { PrimaryAction } from '@/ui/PrimaryAction'
import { Sidebar } from '@/ui/Sidebar'
import { TitleBarSpacer } from '@/ui/TitleBarSpacer'
import { Brand } from './Brand'
import { NAV, type PageId } from './navigation'
import { AboutPage } from './pages/AboutPage'
import { AudioPage } from './pages/AudioPage'
import { GeneralPage } from './pages/GeneralPage'
import { LibraryPage } from './pages/LibraryPage'
import { ModelsPage } from './pages/ModelsPage'
import { OverlayPage } from './pages/OverlayPage'
import { PermissionsPage } from './pages/PermissionsPage'
import { TranscribePage } from './pages/TranscribePage'
import { TranslatePage } from './pages/TranslatePage'
import { StoreProvider, useStore } from './store'
import { WelcomeGate } from './WelcomeGate'

export function App() {
  return (
    <StoreProvider>
      <Root />
    </StoreProvider>
  )
}

function Root() {
  const { prefsReady, onboardingDone } = useStore()

  if (!prefsReady) return <BootSplash />
  return onboardingDone ? <Shell /> : <WelcomeGate />
}

function BootSplash() {
  return (
    <main className="flex h-full">
      <section className="flex min-w-0 flex-1 flex-col bg-[var(--color-surface-0)]">
        <TitleBarSpacer />
        <p role="status" className="m-auto text-[var(--color-ink-2)] text-sm">
          正在读取设置…
        </p>
      </section>
    </main>
  )
}

function Shell() {
  const [page, setPage] = useState<PageId>('transcribe')
  const [recordId, setRecordId] = useState<string | undefined>()
  const { status, updatePhase, updateRestarting } = useStore()
  const capturing = status === TaskStatus.Capturing
  const updating = updatePhase === 'downloading' || updateRestarting

  return (
    <main className="flex h-full">
      <Sidebar items={NAV} current={page} onNavigate={setPage} brand={<Brand />} header={<PrimaryActionSlot />} />

      <section className="flex min-w-0 flex-1 flex-col bg-[var(--color-surface-0)]">
        <TitleBarSpacer />

        <Alerts page={page} onOpenPermissions={() => setPage('permissions')} onOpenAbout={() => setPage('about')} />

        <div className="flex-1 overflow-y-auto">
          <fieldset disabled={updating} className="m-0 min-w-0 border-0 p-0">
            <PageSwitch
              page={page}
              recordId={recordId}
              onOpenLibrary={(id) => {
                setRecordId(id)
                setPage('library')
              }}
              onOpenPermissions={() => setPage('permissions')}
            />
          </fieldset>
        </div>

        <footer className="border-[var(--color-border-subtle)] border-t py-2">
          <div className="flex items-center px-6">
            <LevelStatus active={capturing} />
          </div>
        </footer>
      </section>
    </main>
  )
}

function PrimaryActionSlot() {
  const { status, sessionInfo, pending, activeDevice, toggleSession, updatePhase, updateRestarting } = useStore()
  const capturing = status === TaskStatus.Capturing
  const canToggle = capturing ? sessionInfo?.actions.canStop : sessionInfo?.actions.canStart
  return (
    <PrimaryAction
      capturing={capturing}
      pending={pending}
      phase={sessionInfo?.phase}
      disabledReason={
        !capturing && (updatePhase === 'downloading' || updateRestarting)
          ? '正在更新，暂不可开始转写'
          : !canToggle
            ? (sessionInfo?.actions.reason ?? '正在读取会话状态…')
            : undefined
      }
      activeDevice={activeDevice}
      onToggle={() => void toggleSession()}
    />
  )
}

interface PageSwitchProps {
  recordId?: string
  onOpenLibrary: (id: string) => void
  page: PageId
  onOpenPermissions: () => void
}

function PageSwitch({ page, recordId, onOpenLibrary, onOpenPermissions }: PageSwitchProps) {
  switch (page) {
    case 'transcribe':
      return <TranscribePage onOpenLibrary={onOpenLibrary} />
    case 'library':
      return <LibraryPage initialRecordId={recordId} />
    case 'audio':
      return <AudioPage onOpenPermissions={onOpenPermissions} />
    case 'permissions':
      return <PermissionsPage />
    case 'translate':
      return <TranslatePage />
    case 'overlay':
      return <OverlayPage />
    case 'general':
      return <GeneralPage />
    case 'models':
      return <ModelsPage />
    case 'about':
      return <AboutPage />
  }
}

interface AlertsProps {
  page: PageId
  onOpenPermissions: () => void
  onOpenAbout: () => void
}

function Alerts({ page, onOpenPermissions, onOpenAbout }: AlertsProps) {
  const {
    error,
    sessionInfo,
    refreshSession,
    setError,
    hotkeyProblems,
    audio,
    status,
    permissionError,
    setPermissionError,
    updateInfo,
    updatePhase,
    updateRestarting,
  } = useStore()

  return (
    <>
      {!sessionInfo && (
        <Alert tone="info" title="会话状态尚未同步">
          <Button size="sm" onClick={() => void refreshSession()}>
            重新读取会话状态
          </Button>
        </Alert>
      )}
      {(updatePhase === 'downloading' || updateRestarting) && (
        <Alert tone="info" title="正在更新，设置暂不可修改">
          请等待安装或重启完成。
        </Alert>
      )}
      {updateInfo?.available && page !== 'about' && updatePhase !== 'downloading' && updatePhase !== 'ready' && (
        <Alert tone="info" title={`发现新版本 v${updateInfo.version ?? ''}`}>
          <Button size="sm" onClick={onOpenAbout}>
            去「关于」页更新
          </Button>
        </Alert>
      )}

      {error && (
        <Alert tone="error" title="操作失败">
          <p className="font-mono">{error}</p>
          <button type="button" onClick={() => setError(null)} className="mt-1 underline opacity-70 hover:opacity-100">
            关闭
          </button>
        </Alert>
      )}

      {permissionError && (
        <Alert tone="warn" title="缺少系统权限">
          <p>{permissionError.message}</p>
          <div className="mt-1.5 flex gap-1.5">
            <Button size="sm" onClick={onOpenPermissions}>
              去「权限」页处理
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPermissionError(null)}>
              关闭
            </Button>
          </div>
        </Alert>
      )}

      {hotkeyProblems.length > 0 && (
        <Alert tone="warn" title={`${hotkeyProblems.length} 个全局热键注册失败`}>
          {hotkeyProblems.map((h) => `${h.accelerator} ${h.label}`).join('、')}
          。悬浮窗将无法用热键操作，请在「悬浮窗」页重新绑定。
        </Alert>
      )}

      {audio?.silent && audio.segments === 0 && status === TaskStatus.Capturing && (
        <Alert tone="warn" title="收不到声音（电平 ≈ 0）">
          到「音频」页查看排查步骤。
        </Alert>
      )}
    </>
  )
}
