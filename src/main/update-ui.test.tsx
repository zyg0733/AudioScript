import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TaskStatus } from '@/shared/types'
import { App } from './App'
import { AboutPage } from './pages/AboutPage'

const mocks = vi.hoisted(() => ({
  store: {} as Record<string, unknown>,
  toggleSession: vi.fn(),
  installUpdate: vi.fn(),
  restartApp: vi.fn(),
}))

vi.mock('@/main/store', () => ({
  useStore: () => mocks.store,
  StoreProvider: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('@/main/pages/TranscribePage', () => ({ TranscribePage: () => <div>转写内容</div> }))

vi.mock('@/shared/ipc', async () => ({
  ...(await vi.importActual<typeof import('@/shared/ipc')>('@/shared/ipc')),
  modelsList: vi.fn(async () => ({ asr: [], mt: [] })),
  on: vi.fn(async () => () => {}),
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('Update controls and session exclusion', () => {
  let container: HTMLDivElement
  let root: Root

  async function render(about = false) {
    await act(async () => root.render(about ? <AboutPage /> : <App />))
  }

  function button(label: string) {
    const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(label))
    if (!found) throw new Error(`未找到按钮：${label}`)
    return found
  }

  beforeEach(() => {
    mocks.toggleSession.mockReset()
    mocks.installUpdate.mockReset()
    mocks.restartApp.mockReset()
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    mocks.store = {
      info: { version: '0.2.12', updaterEnabled: true, platform: 'macos', arch: 'aarch64' },
      prefsReady: true,
      onboardingDone: true,
      status: TaskStatus.Ready,
      pending: false,
      activeDevice: null,
      error: null,
      hotkeyProblems: [],
      permissionError: null,
      audio: null,
      updateInfo: { enabled: true, available: true, currentVersion: '0.2.12', version: '0.2.13', notes: null },
      updatePhase: 'idle',
      updateRestarting: false,
      updateProgress: null,
      updateError: null,
      installedVersion: null,
      toggleSession: mocks.toggleSession,
      installUpdate: mocks.installUpdate,
      restartApp: mocks.restartApp,
      checkUpdate: vi.fn(),
    }
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it.each(['downloading', 'restarting'])(
    'disables starting while %s without claiming the session is starting',
    async (operation) => {
      mocks.store.updatePhase = operation === 'downloading' ? 'downloading' : 'ready'
      mocks.store.updateRestarting = operation === 'restarting'
      await render()
      expect(button('开始转写').disabled).toBe(true)
      await act(async () => button('开始转写').click())
      expect(mocks.toggleSession).not.toHaveBeenCalled()
      expect(container.textContent).toContain('正在更新，暂不可开始转写')
      expect(container.querySelector('fieldset')?.disabled).toBe(true)
      expect(container.textContent).toContain('设置暂不可修改')
      expect(container.textContent).not.toContain('启动中')
    },
  )

  it('keeps stopping available if a session is active during an update', async () => {
    mocks.store.status = TaskStatus.Capturing
    mocks.store.updatePhase = 'downloading'
    await render()
    expect(button('停止转写').disabled).toBe(false)
    await act(async () => button('停止转写').click())
    expect(mocks.toggleSession).toHaveBeenCalledOnce()
  })

  it('disables installation while a session command is pending even with ready status', async () => {
    mocks.store.pending = true
    await render(true)
    expect(button('下载并安装').disabled).toBe(true)
    await act(async () => button('下载并安装').click())
    expect(mocks.installUpdate).not.toHaveBeenCalled()
  })

  it('disables restart while a session command or the restart itself is pending', async () => {
    mocks.store.updatePhase = 'ready'
    mocks.store.installedVersion = '0.2.13'
    mocks.store.pending = true
    await render(true)
    expect(button('重启').disabled).toBe(true)
    mocks.store.pending = false
    mocks.store.updateRestarting = true
    await render(true)
    expect(button('重启').disabled).toBe(true)
    expect(container.textContent).toContain('正在保存设置并重启应用')
    await act(async () => button('重启').click())
    expect(mocks.restartApp).not.toHaveBeenCalled()
  })
})
