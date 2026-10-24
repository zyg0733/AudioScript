import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo, OverlayConfig, Preferences } from '@/shared/ipc'
import { EVENT } from '@/shared/ipc'
import { AudioSourceKind, OverlayMode, TaskStatus, Theme, TranslateEngine, ZhScript } from '@/shared/types'
import { StoreProvider, useStore } from './store'

const ipc = vi.hoisted(() => ({
  appInfo: vi.fn(),
  on: vi.fn(),
  prefsGet: vi.fn(),
  prefsSet: vi.fn(),
  overlayConfigGet: vi.fn(),
  overlayConfigSet: vi.fn(),
  sessionStatus: vi.fn(),
  sessionStart: vi.fn(),
  updateInstall: vi.fn(),
  setTrackingEnabled: vi.fn(),
}))

vi.mock('@/shared/analytics', () => ({
  setTrackingEnabled: ipc.setTrackingEnabled,
  track: vi.fn(),
}))

vi.mock('@/shared/ipc', async () => ({
  ...(await vi.importActual<typeof import('@/shared/ipc')>('@/shared/ipc')),
  appInfo: ipc.appInfo,
  on: ipc.on,
  prefsGet: ipc.prefsGet,
  prefsSet: ipc.prefsSet,
  sessionStatus: ipc.sessionStatus,
  sessionStart: ipc.sessionStart,
  updateInstall: ipc.updateInstall,
  hotkeyFailures: vi.fn(async () => []),
  shortcutsGet: vi.fn(async () => []),
  overlayConfigGet: ipc.overlayConfigGet,
  overlayConfigSet: ipc.overlayConfigSet,
  overlayIsVisible: vi.fn(async () => false),
  permissionStatus: vi.fn(async () => null),
  audioDevices: vi.fn(async () => []),
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('StoreProvider session and fork capabilities', () => {
  let container: HTMLDivElement
  let root: Root
  let store: ReturnType<typeof useStore>
  let listeners: Map<string, (value: unknown) => void>
  let info: AppInfo
  let savedPrefs: Preferences

  function Probe() {
    store = useStore()
    return null
  }

  async function render() {
    await act(async () => {
      root.render(
        <StoreProvider>
          <Probe />
        </StoreProvider>,
      )
    })
  }

  beforeEach(() => {
    for (const mock of Object.values(ipc)) mock.mockReset()
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    listeners = new Map()
    ipc.on.mockImplementation(async (name: string, handler: (value: unknown) => void) => {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    })
    info = {
      name: 'AudioScript',
      version: '0.2.10',
      platform: 'macos',
      arch: 'aarch64',
      builtAtMs: null,
      analyticsAvailable: false,
      analyticsDisabledReason: '未配置此 fork 的统计 Key',
      updaterEnabled: false,
      updaterDisabledReason: '未配置此 fork 的更新公钥',
      links: {
        repository: 'https://github.com/zyg0733/AudioScript',
        site: 'https://zyg0733.github.io/AudioScript/',
        upstreamRepository: 'https://github.com/niyongsheng/AudioScript',
        upstreamSponsor: 'https://ifdian.net/a/nico2026',
        updaterEndpoint: 'https://github.com/zyg0733/AudioScript/releases/latest/download/latest.json',
        modelsRelease: 'https://github.com/zyg0733/AudioScript/releases/download/models-v1',
      },
    }
    ipc.appInfo.mockImplementation(async () => info)
    savedPrefs = {
      audioSource: AudioSourceKind.Loopback,
      translateEngine: TranslateEngine.LocalNmt,
      sourceLang: 'en',
      zhScript: ZhScript.Simplified,
      theme: Theme.Light,
      analyticsEnabled: false,
      endpoint: { trailingSilenceMs: 800, maxUtteranceMs: 8000 },
      overlay: {
        enable: true,
        mode: OverlayMode.Edit,
        alwaysOnTop: true,
        opacity: 60,
        fontSize: 22,
        fontColor: '#ffffff',
        bgColor: '#101018',
        maxLines: 6,
        glow: true,
      },
    } as Preferences
    ipc.prefsGet.mockImplementation(async () => savedPrefs)
    ipc.prefsSet.mockImplementation(async (patch) => {
      savedPrefs = { ...savedPrefs, ...patch }
      return savedPrefs
    })
    ipc.overlayConfigGet.mockResolvedValue(savedPrefs.overlay)
    ipc.overlayConfigSet.mockImplementation(async (config) => config)
    ipc.sessionStatus.mockResolvedValue({ status: TaskStatus.Ready, device: null, error: null })
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.unstubAllGlobals()
  })

  it('restores a running session and its active device when the window mounts', async () => {
    ipc.sessionStatus.mockResolvedValue({ status: TaskStatus.Capturing, device: '系统声音', error: null })
    await render()
    expect(store.status).toBe(TaskStatus.Capturing)
    expect(store.activeDevice).toBe('系统声音')
  })

  it('refreshes the session snapshot after a tray start and clears it after stop', async () => {
    await render()
    ipc.sessionStatus.mockResolvedValue({ status: TaskStatus.Capturing, device: '麦克风', error: null })
    await act(async () => listeners.get(EVENT.taskState)?.(TaskStatus.Capturing))
    expect(store.activeDevice).toBe('麦克风')

    ipc.sessionStatus.mockResolvedValue({ status: TaskStatus.Ready, device: null, error: null })
    await act(async () => listeners.get(EVENT.taskState)?.(TaskStatus.Ready))
    expect(store.status).toBe(TaskStatus.Ready)
    expect(store.activeDevice).toBeNull()
  })

  it('shows runtime faults and rejects an older pending session snapshot', async () => {
    const pending = deferred<{ status: TaskStatus; device: string; error: null }>()
    ipc.sessionStatus.mockReturnValue(pending.promise)
    await render()
    await act(async () => listeners.get(EVENT.sessionError)?.('设备已断开，请重新选择音源'))
    await act(async () => pending.resolve({ status: TaskStatus.Capturing, device: '旧设备', error: null }))
    expect(store.status).toBe(TaskStatus.Error)
    expect(store.activeDevice).toBeNull()
    expect(store.error).toBe('设备已断开，请重新选择音源')
  })

  it('restores the backend fault reason when reopening the window', async () => {
    ipc.sessionStatus.mockResolvedValue({ status: TaskStatus.Error, device: null, error: '推理失败' })
    await render()
    expect(store.status).toBe(TaskStatus.Error)
    expect(store.error).toBe('推理失败')
  })

  it('does not let a start response overwrite an early runtime failure', async () => {
    await render()
    const start = deferred<TaskStatus>()
    ipc.sessionStart.mockReturnValue(start.promise)
    let toggle!: Promise<void>
    await act(async () => {
      toggle = store.toggleSession()
    })
    ipc.sessionStatus.mockResolvedValue({ status: TaskStatus.Error, device: null, error: '采集启动后断开' })
    await act(async () => {
      listeners.get(EVENT.sessionError)?.('采集启动后断开')
      start.resolve(TaskStatus.Capturing)
      await toggle
    })
    expect(store.status).toBe(TaskStatus.Error)
    expect(store.error).toBe('采集启动后断开')
    expect(store.activeDevice).toBeNull()
  })

  it('keeps the confirmed translation direction and engine when saving fails', async () => {
    await render()
    ipc.prefsSet.mockRejectedValue(new Error('写入失败'))
    await act(async () => {
      store.setDirection('zh', ZhScript.Traditional)
      store.setTranslateEngine(TranslateEngine.Off)
    })
    expect(store.sourceLang).toBe('en')
    expect(store.zhScript).toBe(ZhScript.Simplified)
    expect(store.translateEngine).toBe(TranslateEngine.LocalNmt)
    expect(store.error).toContain('写入失败')
  })

  it('serializes rapid endpoint saves so an older response cannot replace a newer selection', async () => {
    await render()
    const first = deferred<Preferences>()
    const second = deferred<Preferences>()
    const firstEndpoint = { trailingSilenceMs: 500, maxUtteranceMs: 8000 }
    const secondEndpoint = { trailingSilenceMs: 500, maxUtteranceMs: 6000 }
    ipc.prefsSet.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await act(async () => {
      void store.setEndpoint(firstEndpoint)
      void store.setEndpoint(secondEndpoint)
    })
    expect(ipc.prefsSet).toHaveBeenCalledTimes(1)
    await act(async () => first.resolve({ ...savedPrefs, endpoint: firstEndpoint }))
    expect(ipc.prefsSet).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve({ ...savedPrefs, endpoint: secondEndpoint }))
    expect(store.endpoint).toEqual(secondEndpoint)
  })

  it('notifies endpoint drafts to restore their confirmed value when a save fails', async () => {
    await render()
    const confirmed = store.endpoint
    ipc.prefsSet.mockRejectedValue(new Error('写入失败'))
    await act(async () => store.setEndpoint({ trailingSilenceMs: 500, maxUtteranceMs: 6000 }))
    expect(store.endpoint).toEqual(confirmed)
    expect(store.endpoint).not.toBe(confirmed)
    expect(store.error).toContain('写入失败')
  })

  it('waits for direction persistence before starting with the saved configuration', async () => {
    await render()
    const saving = deferred<Preferences>()
    ipc.prefsSet.mockImplementationOnce(async () => {
      savedPrefs = await saving.promise
      return savedPrefs
    })
    ipc.sessionStart.mockResolvedValue(TaskStatus.Capturing)
    let toggle!: Promise<void>
    await act(async () => {
      store.setDirection('zh', ZhScript.Traditional)
      toggle = store.toggleSession()
    })
    expect(ipc.sessionStart).not.toHaveBeenCalled()
    await act(async () => {
      saving.resolve({ ...savedPrefs, sourceLang: 'zh', zhScript: ZhScript.Traditional })
      await toggle
    })
    expect(ipc.sessionStart).toHaveBeenCalledWith(
      undefined,
      TranslateEngine.LocalNmt,
      'zh',
      ZhScript.Traditional,
      AudioSourceKind.Loopback,
    )
  })

  it('does not silently start with old settings when the awaited save fails', async () => {
    await render()
    const saving = deferred<Preferences>()
    ipc.prefsSet.mockReturnValueOnce(saving.promise)
    let toggle!: Promise<void>
    await act(async () => {
      store.setDirection('zh', ZhScript.Traditional)
      toggle = store.toggleSession()
    })
    await act(async () => {
      saving.reject(new Error('方向保存失败'))
      await toggle
    })
    expect(ipc.sessionStart).not.toHaveBeenCalled()
    expect(store.pending).toBe(false)
    expect(store.error).toContain('方向保存失败')
  })

  it('keeps successful settings after a later save fails and permits retry', async () => {
    await render()
    await act(async () => store.setDirection('zh', ZhScript.Traditional))
    ipc.prefsSet.mockRejectedValueOnce(new Error('临时写入失败'))
    await act(async () => store.setTranslateEngine(TranslateEngine.Off))
    expect(store.sourceLang).toBe('zh')
    expect(store.zhScript).toBe(ZhScript.Traditional)
    expect(store.translateEngine).toBe(TranslateEngine.LocalNmt)

    await act(async () => store.setTranslateEngine(TranslateEngine.Off))
    expect(store.translateEngine).toBe(TranslateEngine.Off)
    expect(store.sourceLang).toBe('zh')
  })

  it('cancels unsent preferences when the provider unmounts without poisoning a new provider', async () => {
    await render()
    const first = deferred<Preferences>()
    ipc.prefsSet.mockReturnValueOnce(first.promise)
    await act(async () => {
      store.setDirection('zh', ZhScript.Traditional)
      store.setTranslateEngine(TranslateEngine.Off)
    })
    expect(ipc.prefsSet).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    await act(async () => first.resolve({ ...savedPrefs, sourceLang: 'zh' }))
    expect(ipc.prefsSet).toHaveBeenCalledTimes(1)

    root = createRoot(container)
    await render()
    await act(async () => store.setTranslateEngine(TranslateEngine.Off))
    expect(ipc.prefsSet).toHaveBeenCalledTimes(2)
    expect(store.sourceLang).toBe('en')
    expect(store.translateEngine).toBe(TranslateEngine.Off)
  })

  it('merges rapid overlay changes with the latest saved configuration', async () => {
    await render()
    const initial = savedPrefs.overlay
    const first = deferred<OverlayConfig>()
    ipc.overlayConfigSet.mockReturnValueOnce(first.promise)
    let firstChange!: Promise<void>
    let secondChange!: Promise<void>
    await act(async () => {
      firstChange = store.updateOverlay({ glow: false })
      secondChange = store.updateOverlay({ fontSize: 30 })
    })
    expect(ipc.overlayConfigSet).toHaveBeenCalledTimes(1)
    await act(async () => {
      first.resolve({ ...initial, glow: false })
      await firstChange
      await secondChange
    })
    expect(ipc.overlayConfigSet).toHaveBeenLastCalledWith({ ...initial, glow: false, fontSize: 30 })
    expect(store.overlayCfg).toMatchObject({ glow: false, fontSize: 30 })
  })

  it('keeps the last overlay configuration on failure and allows a retry', async () => {
    await render()
    await act(async () => store.updateOverlay({ glow: false }))
    ipc.overlayConfigSet.mockRejectedValueOnce(new Error('悬浮窗更新失败'))
    await act(async () => store.updateOverlay({ fontSize: 30 }))
    expect(store.overlayCfg).toMatchObject({ glow: false, fontSize: 22 })
    expect(store.error).toContain('悬浮窗更新失败')
    await act(async () => store.updateOverlay({ fontSize: 30 }))
    expect(store.overlayCfg).toMatchObject({ glow: false, fontSize: 30 })
  })

  it('does not let an older overlay load overwrite a live configuration event', async () => {
    const pending = deferred<OverlayConfig>()
    ipc.overlayConfigGet.mockReturnValue(pending.promise)
    await render()
    const latest = { ...savedPrefs.overlay, mode: OverlayMode.Locked, fontSize: 30 }
    await act(async () => listeners.get(EVENT.overlayState)?.(latest))
    await act(async () => pending.resolve(savedPrefs.overlay))
    expect(store.overlayCfg).toEqual(latest)
  })

  it('does not enable tracking from saved preferences when this fork has no key', async () => {
    ipc.prefsGet.mockResolvedValue({ theme: Theme.Light, analyticsEnabled: true } as Preferences)
    await render()
    expect(ipc.setTrackingEnabled).not.toHaveBeenCalledWith(true)
    await act(async () => store.setAnalyticsEnabled(true))
    expect(ipc.prefsSet).not.toHaveBeenCalled()
    expect(store.error).toBe(info.analyticsDisabledReason)
  })

  it('keeps tracking disabled when saving opt-in fails', async () => {
    info.analyticsAvailable = true
    ipc.prefsSet.mockRejectedValue(new Error('写入失败'))
    await render()
    await act(async () => store.setAnalyticsEnabled(true))
    expect(store.analyticsEnabled).toBe(false)
    expect(ipc.setTrackingEnabled).not.toHaveBeenCalledWith(true)
    expect(store.error).toContain('写入失败')
  })

  it('rejects update installation when this build has no trusted fork public key', async () => {
    await render()
    await act(async () => store.installUpdate())
    expect(ipc.updateInstall).not.toHaveBeenCalled()
    expect(store.updateError).toBe(info.updaterDisabledReason)
  })

  it('unsubscribes all session and window events on unmount', async () => {
    await render()
    expect(listeners.has(EVENT.sessionError)).toBe(true)
    await act(async () => root.unmount())
    expect(listeners.size).toBe(0)
    root = createRoot(container)
  })
})
