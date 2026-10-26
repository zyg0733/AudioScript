import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppInfo, OverlayConfig, Preferences } from '@/shared/ipc'
import { EVENT } from '@/shared/ipc'
import {
  AudioSourceKind,
  OverlayMode,
  type SessionInfo,
  SessionPhase,
  TaskStatus,
  Theme,
  TranslateEngine,
  ZhScript,
} from '@/shared/types'
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
  sessionStop: vi.fn(),
  updateCheck: vi.fn(),
  updateInstall: vi.fn(),
  updateRestart: vi.fn(),
  prefsReset: vi.fn(),
  autostartSet: vi.fn(),
  shortcutsSet: vi.fn(),
  modelSelect: vi.fn(),
  overlayToggle: vi.fn(),
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
  sessionStop: ipc.sessionStop,
  updateCheck: ipc.updateCheck,
  updateInstall: ipc.updateInstall,
  updateRestart: ipc.updateRestart,
  prefsReset: ipc.prefsReset,
  autostartSet: ipc.autostartSet,
  shortcutsSet: ipc.shortcutsSet,
  modelSelect: ipc.modelSelect,
  overlayToggle: ipc.overlayToggle,
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

function sessionInfoFor(
  patch: Omit<Partial<SessionInfo>, 'device' | 'deviceSampleRate' | 'error'> & {
    device?: string | null
    deviceSampleRate?: number | null
    error?: string | null
  } = {},
): SessionInfo {
  const status = patch.status ?? TaskStatus.Ready
  const phase =
    patch.phase ??
    (status === TaskStatus.Capturing
      ? SessionPhase.Capturing
      : status === TaskStatus.Error
        ? SessionPhase.Error
        : SessionPhase.Ready)
  return {
    status,
    phase,
    actions: {
      canStart: phase === SessionPhase.Ready || phase === SessionPhase.Error,
      canStop: phase === SessionPhase.Capturing,
      canClear: phase === SessionPhase.Ready || phase === SessionPhase.Error,
      canExport: phase !== SessionPhase.Finalizing,
      reason: undefined,
    },
    ...patch,
    device: patch.device ?? undefined,
    deviceSampleRate: patch.deviceSampleRate ?? undefined,
    error: patch.error ?? undefined,
  }
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

  async function availableUpdate() {
    info.updaterEnabled = true
    info.updaterDisabledReason = null
    await render()
    await act(async () => store.checkUpdate())
  }

  async function installedUpdate() {
    await availableUpdate()
    await act(async () => store.installUpdate())
    expect(store.updatePhase).toBe('ready')
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
      onboardingDone: false,
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
    ipc.sessionStatus.mockResolvedValue(sessionInfoFor({ status: TaskStatus.Ready, device: null, error: null }))
    ipc.sessionStop.mockResolvedValue(null)
    ipc.updateCheck.mockResolvedValue({
      currentVersion: '0.2.12',
      enabled: true,
      disabledReason: null,
      available: true,
      version: '0.2.13',
      notes: null,
    })
    ipc.updateInstall.mockResolvedValue({ version: '0.2.13' })
    ipc.updateRestart.mockResolvedValue(null)
    ipc.prefsReset.mockImplementation(async () => savedPrefs)
    ipc.autostartSet.mockImplementation(async (enabled) => ({ enabled }))
    ipc.shortcutsSet.mockResolvedValue([])
    ipc.modelSelect.mockResolvedValue({ asr: [], mt: [] })
    ipc.overlayToggle.mockResolvedValue(true)
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
    ipc.sessionStatus.mockResolvedValue(
      sessionInfoFor({ status: TaskStatus.Capturing, device: '系统声音', error: null }),
    )
    await render()
    expect(store.status).toBe(TaskStatus.Capturing)
    expect(store.activeDevice).toBe('系统声音')
  })

  it('refreshes backend phases even when the public task status stays ready', async () => {
    ipc.sessionStatus.mockResolvedValue(sessionInfoFor({ phase: SessionPhase.Preparing }))
    await render()
    expect(store.sessionInfo?.phase).toBe(SessionPhase.Preparing)
    await act(async () => store.toggleSession())
    expect(ipc.sessionStart).not.toHaveBeenCalled()

    ipc.sessionStatus.mockResolvedValue(sessionInfoFor({ phase: SessionPhase.Finalizing }))
    await act(async () => listeners.get(EVENT.taskState)?.(TaskStatus.Ready))
    expect(store.sessionInfo?.phase).toBe(SessionPhase.Finalizing)
    expect(store.sessionInfo?.actions.canExport).toBe(false)

    ipc.sessionStatus.mockResolvedValue(sessionInfoFor())
    await act(async () => listeners.get(EVENT.taskState)?.(TaskStatus.Ready))
    expect(store.sessionInfo?.actions.canStart).toBe(true)
    await act(async () => store.toggleSession())
    expect(ipc.sessionStart).toHaveBeenCalledOnce()
  })

  it('can retry a failed session snapshot without submitting a start request', async () => {
    ipc.sessionStatus.mockRejectedValueOnce(new Error('暂时不可用'))
    await render()
    expect(store.sessionInfo).toBeNull()
    expect(store.error).toContain('读取会话状态失败')
    await act(async () => store.refreshSession())
    expect(store.sessionInfo?.phase).toBe(SessionPhase.Ready)
    expect(ipc.sessionStart).not.toHaveBeenCalled()
  })

  it.each([SessionPhase.Preparing, SessionPhase.Finalizing])(
    'rejects installing during backend %s even without a pending frontend request',
    async (phase) => {
      await availableUpdate()
      ipc.sessionStatus.mockResolvedValue(sessionInfoFor({ phase }))
      await act(async () => listeners.get(EVENT.taskState)?.(TaskStatus.Ready))
      expect(store.pending).toBe(false)
      await act(async () => store.installUpdate())
      expect(ipc.updateInstall).not.toHaveBeenCalled()
      expect(store.updateError).toContain('收尾')
    },
  )

  it('refreshes the session snapshot after a tray start and clears it after stop', async () => {
    await render()
    ipc.sessionStatus.mockResolvedValue(sessionInfoFor({ status: TaskStatus.Capturing, device: '麦克风', error: null }))
    await act(async () => listeners.get(EVENT.taskState)?.(TaskStatus.Capturing))
    expect(store.activeDevice).toBe('麦克风')

    ipc.sessionStatus.mockResolvedValue(sessionInfoFor({ status: TaskStatus.Ready, device: null, error: null }))
    await act(async () => listeners.get(EVENT.taskState)?.(TaskStatus.Ready))
    expect(store.status).toBe(TaskStatus.Ready)
    expect(store.activeDevice).toBeNull()
  })

  it('shows runtime faults and rejects an older pending session snapshot', async () => {
    const pending = deferred<SessionInfo>()
    ipc.sessionStatus.mockReturnValueOnce(pending.promise)
    await render()
    ipc.sessionStatus.mockResolvedValue(
      sessionInfoFor({ status: TaskStatus.Error, error: '设备已断开，请重新选择音源' }),
    )
    await act(async () => listeners.get(EVENT.sessionError)?.('设备已断开，请重新选择音源'))
    await act(async () =>
      pending.resolve(sessionInfoFor({ status: TaskStatus.Capturing, device: '旧设备', error: null })),
    )
    expect(store.status).toBe(TaskStatus.Error)
    expect(store.activeDevice).toBeNull()
    expect(store.error).toBe('设备已断开，请重新选择音源')
  })

  it('restores the backend fault reason when reopening the window', async () => {
    ipc.sessionStatus.mockResolvedValue(sessionInfoFor({ status: TaskStatus.Error, device: null, error: '推理失败' }))
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
    ipc.sessionStatus.mockResolvedValue(
      sessionInfoFor({ status: TaskStatus.Error, device: null, error: '采集启动后断开' }),
    )
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

  it('rejects installing during capture or a pending session start', async () => {
    await availableUpdate()
    ipc.sessionStatus.mockResolvedValue(sessionInfoFor({ status: TaskStatus.Capturing, device: '麦克风', error: null }))
    await act(async () => listeners.get(EVENT.taskState)?.(TaskStatus.Capturing))
    await act(async () => store.installUpdate())
    expect(ipc.updateInstall).not.toHaveBeenCalled()

    ipc.sessionStatus.mockResolvedValue(sessionInfoFor({ status: TaskStatus.Ready, device: null, error: null }))
    await act(async () => listeners.get(EVENT.taskState)?.(TaskStatus.Ready))
    const starting = deferred<TaskStatus>()
    ipc.sessionStart.mockReturnValueOnce(starting.promise)
    let toggle!: Promise<void>
    await act(async () => {
      toggle = store.toggleSession()
    })
    expect(store.pending).toBe(true)
    await act(async () => store.installUpdate())
    expect(ipc.updateInstall).not.toHaveBeenCalled()
    expect(store.updateError).toContain('等待会话收尾')
    await act(async () => {
      starting.resolve(TaskStatus.Capturing)
      await toggle
    })
  })

  it('blocks starting throughout installation and permits retry after an installation failure', async () => {
    await availableUpdate()
    const installing = deferred<{ version: string }>()
    ipc.updateInstall.mockReturnValueOnce(installing.promise)
    let install!: Promise<void>
    await act(async () => {
      install = store.installUpdate()
      await store.toggleSession()
    })
    expect(ipc.sessionStart).not.toHaveBeenCalled()
    expect(store.error).toContain('正在下载、安装更新或重启')
    await act(async () => {
      installing.reject(new Error('下载连接断开'))
      await install
    })
    expect(store.updatePhase).toBe('error')
    expect(store.updateError).toContain('下载连接断开')
    await act(async () => store.installUpdate())
    expect(ipc.updateInstall).toHaveBeenCalledTimes(2)
    expect(store.updateError).toBeNull()
    expect(store.updatePhase).toBe('ready')
  })

  it('waits for pending preferences before installation because Windows exits after installing', async () => {
    await availableUpdate()
    const saving = deferred<Preferences>()
    ipc.prefsSet.mockReturnValueOnce(saving.promise)
    let install!: Promise<void>
    await act(async () => {
      store.setDirection('zh', ZhScript.Traditional)
      install = store.installUpdate()
    })
    expect(ipc.updateInstall).not.toHaveBeenCalled()
    await act(async () => {
      saving.resolve({ ...savedPrefs, sourceLang: 'zh', zhScript: ZhScript.Traditional })
      await install
    })
    expect(ipc.updateInstall).toHaveBeenCalledOnce()
  })

  it('drains previously queued settings and refuses new changes while restart is waiting', async () => {
    await installedUpdate()
    const preferences = deferred<Preferences>()
    const laterPreferences = deferred<Preferences>()
    const overlay = deferred<OverlayConfig>()
    const laterOverlay = deferred<OverlayConfig>()
    ipc.prefsSet.mockReturnValueOnce(preferences.promise).mockReturnValueOnce(laterPreferences.promise)
    ipc.overlayConfigSet.mockReturnValueOnce(overlay.promise).mockReturnValueOnce(laterOverlay.promise)
    let restarting!: Promise<void>
    await act(async () => {
      store.setDirection('zh', ZhScript.Traditional)
      store.setTranslateEngine(TranslateEngine.Off)
      void store.updateOverlay({ glow: false })
      void store.updateOverlay({ fontSize: 30 })
      restarting = store.restartApp()
    })
    expect(store.updateRestarting).toBe(true)
    expect(ipc.updateRestart).not.toHaveBeenCalled()
    await act(async () => {
      store.setDevice('更新期间不能写入的设备')
      void store.updateOverlay({ opacity: 90 })
      await store.restartApp()
      await store.toggleSession()
      preferences.resolve({ ...savedPrefs, sourceLang: 'zh', zhScript: ZhScript.Traditional })
      overlay.resolve({ ...savedPrefs.overlay, glow: false })
    })
    expect(ipc.updateRestart).not.toHaveBeenCalled()
    expect(ipc.sessionStart).not.toHaveBeenCalled()
    await act(async () => {
      laterPreferences.resolve({ ...savedPrefs, sourceLang: 'zh', translateEngine: TranslateEngine.Off })
      laterOverlay.resolve({ ...savedPrefs.overlay, glow: false, fontSize: 30 })
      await restarting
    })
    expect(ipc.updateRestart).toHaveBeenCalledOnce()
    expect(ipc.prefsSet).toHaveBeenCalledTimes(2)
    expect(ipc.overlayConfigSet).toHaveBeenCalledTimes(2)
    expect(store.device).not.toBe('更新期间不能写入的设备')
    expect(store.overlayCfg?.opacity).toBe(60)
    expect(store.updateRestarting).toBe(false)
  })

  it('rejects new preference and overlay writes during installation without poisoning a later retry', async () => {
    await availableUpdate()
    const installing = deferred<{ version: string }>()
    ipc.updateInstall.mockReturnValueOnce(installing.promise)
    let install!: Promise<void>
    await act(async () => {
      install = store.installUpdate()
    })
    const endpoint = store.endpoint
    const overlay = store.overlayCfg
    await act(async () => {
      store.setDirection('zh', ZhScript.Traditional)
      await store.setEndpoint({ trailingSilenceMs: 500, maxUtteranceMs: 6000 })
      await store.updateOverlay({ fontSize: 30 })
      await store.completeOnboarding()
    })
    expect(ipc.prefsSet).not.toHaveBeenCalled()
    expect(ipc.overlayConfigSet).not.toHaveBeenCalled()
    expect(store.sourceLang).toBe('en')
    expect(store.endpoint).toEqual(endpoint)
    expect(store.endpoint).not.toBe(endpoint)
    expect(store.overlayCfg).toEqual(overlay)
    expect(store.overlayCfg).not.toBe(overlay)
    expect(store.onboardingDone).toBe(false)
    expect(store.error).toContain('暂时不能修改设置')
    await act(async () => {
      installing.reject(new Error('下载中断'))
      await install
    })
    await act(async () => store.installUpdate())
    expect(store.updatePhase).toBe('ready')
    await act(async () => store.restartApp())
    expect(ipc.updateRestart).toHaveBeenCalledOnce()
  })

  it('waits for an already pending reset before installation and blocks newly requested direct writes', async () => {
    await availableUpdate()
    const reset = deferred<Preferences>()
    ipc.prefsReset.mockReturnValueOnce(reset.promise)
    let resetting!: Promise<Preferences>
    let installing!: Promise<void>
    await act(async () => {
      resetting = store.runSettingsWrite('preferences-reset', ipc.prefsReset)
      installing = store.installUpdate()
    })
    expect(ipc.prefsReset).toHaveBeenCalledOnce()
    expect(ipc.updateInstall).not.toHaveBeenCalled()
    await expect(store.runSettingsWrite('autostart', () => ipc.autostartSet(true))).rejects.toThrow('暂时不能修改设置')
    expect(ipc.autostartSet).not.toHaveBeenCalled()
    await act(async () => {
      reset.resolve(savedPrefs)
      await resetting
      await installing
    })
    expect(ipc.updateInstall).toHaveBeenCalledOnce()
    await act(async () => store.restartApp())
    expect(ipc.updateRestart).toHaveBeenCalledOnce()
  })

  it('waits for shortcut and autostart IPCs before restarting', async () => {
    await installedUpdate()
    const shortcut = deferred<[]>()
    const autostart = deferred<{ enabled: boolean }>()
    ipc.shortcutsSet.mockReturnValueOnce(shortcut.promise)
    ipc.autostartSet.mockReturnValueOnce(autostart.promise)
    let shortcutWrite!: Promise<[]>
    let autostartWrite!: Promise<{ enabled: boolean }>
    let restarting!: Promise<void>
    await act(async () => {
      shortcutWrite = store.runSettingsWrite('shortcut:toggle', () => ipc.shortcutsSet('toggle', 'Ctrl+Alt+A'))
      autostartWrite = store.runSettingsWrite('autostart', () => ipc.autostartSet(true))
      restarting = store.restartApp()
    })
    expect(ipc.updateRestart).not.toHaveBeenCalled()
    await act(async () => {
      shortcut.resolve([])
      await shortcutWrite
    })
    expect(ipc.updateRestart).not.toHaveBeenCalled()
    await act(async () => {
      autostart.resolve({ enabled: true })
      await autostartWrite
      await restarting
    })
    expect(ipc.updateRestart).toHaveBeenCalledOnce()
  })

  it('propagates direct settings failures and requires a successful retry before restart', async () => {
    await installedUpdate()
    ipc.prefsReset.mockRejectedValueOnce(new Error('重置写入失败'))
    await expect(store.runSettingsWrite('preferences-reset', ipc.prefsReset)).rejects.toThrow('重置写入失败')
    await act(async () => store.restartApp())
    expect(ipc.updateRestart).not.toHaveBeenCalled()
    expect(store.error).toContain('重置写入失败')
    expect(store.updatePhase).toBe('ready')
    await act(async () => store.runSettingsWrite('preferences-reset', ipc.prefsReset))
    await act(async () => store.restartApp())
    expect(ipc.updateRestart).toHaveBeenCalledOnce()
  })

  it.each([true, false])(
    'serializes same-key writes and preserves the latest outcome (latest fails: %s)',
    async (latestFails) => {
      await installedUpdate()
      const first = deferred<{ enabled: boolean }>()
      const second = deferred<{ enabled: boolean }>()
      void second.promise.catch(() => {})
      ipc.autostartSet.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      let firstResult!: Promise<unknown>
      let secondResult!: Promise<unknown>
      await act(async () => {
        firstResult = store.runSettingsWrite('autostart', () => ipc.autostartSet(true)).catch((error) => error)
        secondResult = store.runSettingsWrite('autostart', () => ipc.autostartSet(false)).catch((error) => error)
        if (latestFails) second.reject(new Error('最新自启动设置失败'))
        else second.resolve({ enabled: false })
      })
      expect(ipc.autostartSet).toHaveBeenCalledTimes(1)
      let restarting!: Promise<void>
      await act(async () => {
        restarting = store.restartApp()
      })
      expect(ipc.updateRestart).not.toHaveBeenCalled()
      await act(async () => {
        if (latestFails) first.resolve({ enabled: true })
        else first.reject(new Error('较早自启动设置失败'))
        await firstResult
        await secondResult
        await restarting
      })
      expect(ipc.autostartSet.mock.calls).toEqual([[true], [false]])
      if (latestFails) {
        expect(ipc.updateRestart).not.toHaveBeenCalled()
        expect(store.error).toContain('最新自启动设置失败')
      } else {
        expect(ipc.updateRestart).toHaveBeenCalledOnce()
        expect(store.error).toBeNull()
      }
    },
  )

  it('waits for model selection and overlay visibility persistence before installing', async () => {
    await availableUpdate()
    const selection = deferred<{ asr: []; mt: [] }>()
    const visibility = deferred<boolean>()
    ipc.modelSelect.mockReturnValueOnce(selection.promise)
    ipc.overlayToggle.mockReturnValueOnce(visibility.promise)
    let selecting!: Promise<{ asr: []; mt: [] }>
    let toggling!: Promise<void>
    let installing!: Promise<void>
    await act(async () => {
      selecting = store.runSettingsWrite('model-selection:asr', () => ipc.modelSelect('asr-high'))
      toggling = store.toggleOverlay()
      installing = store.installUpdate()
    })
    expect(ipc.updateInstall).not.toHaveBeenCalled()
    await act(async () => {
      selection.resolve({ asr: [], mt: [] })
      await selecting
    })
    expect(ipc.updateInstall).not.toHaveBeenCalled()
    await act(async () => {
      visibility.resolve(true)
      await toggling
      await installing
    })
    expect(store.overlayVisible).toBe(true)
    expect(ipc.updateInstall).toHaveBeenCalledOnce()
  })

  it('does not treat a failed overlay visibility save as a successful change or ignore it during restart', async () => {
    await installedUpdate()
    ipc.overlayToggle.mockRejectedValueOnce(new Error('悬浮窗可见性保存失败'))
    await act(async () => store.toggleOverlay())
    expect(store.overlayVisible).toBe(false)
    await act(async () => store.restartApp())
    expect(ipc.updateRestart).not.toHaveBeenCalled()
    expect(store.error).toContain('悬浮窗可见性保存失败')
    await act(async () => store.toggleOverlay())
    await act(async () => store.restartApp())
    expect(ipc.updateRestart).toHaveBeenCalledOnce()
  })

  it('keeps failed preference fields blocking restart until those fields are saved again', async () => {
    await installedUpdate()
    ipc.prefsSet.mockRejectedValueOnce(new Error('方向保存失败'))
    await act(async () => store.setDirection('zh', ZhScript.Traditional))
    await act(async () => store.changeTheme(Theme.Dark))
    await act(async () => store.restartApp())
    expect(ipc.updateRestart).not.toHaveBeenCalled()
    expect(store.error).toContain('方向保存失败')
    expect(store.updatePhase).toBe('ready')
    expect(store.updateRestarting).toBe(false)
    await act(async () => store.setDirection('zh', ZhScript.Traditional))
    await act(async () => store.restartApp())
    expect(ipc.updateRestart).toHaveBeenCalledOnce()
  })

  it('keeps an overlay save failure blocking restart and permits a successful retry', async () => {
    await installedUpdate()
    const saving = deferred<OverlayConfig>()
    ipc.overlayConfigSet.mockReturnValueOnce(saving.promise)
    let restarting!: Promise<void>
    await act(async () => {
      void store.updateOverlay({ fontSize: 30 })
      restarting = store.restartApp()
    })
    await act(async () => {
      saving.reject(new Error('悬浮窗配置写入失败'))
      await restarting
    })
    expect(ipc.updateRestart).not.toHaveBeenCalled()
    expect(store.error).toContain('悬浮窗配置写入失败')
    expect(store.updatePhase).toBe('ready')
    await act(async () => store.updateOverlay({ fontSize: 30 }))
    await act(async () => store.restartApp())
    expect(ipc.updateRestart).toHaveBeenCalledOnce()
  })

  it.each(['会话仍在启动', '会话仍在收尾'])(
    'keeps an installed update retryable when restart rejects: %s',
    async (message) => {
      await installedUpdate()
      ipc.updateRestart.mockRejectedValueOnce(new Error(message))
      await act(async () => store.restartApp())
      expect(store.error).toContain(message)
      expect(store.updatePhase).toBe('ready')
      expect(store.installedVersion).toBe('0.2.13')
      expect(store.updateRestarting).toBe(false)
      await act(async () => store.restartApp())
      expect(ipc.updateRestart).toHaveBeenCalledTimes(2)
      expect(store.error).toBeNull()
    },
  )

  it('rejects restarting during a pending session start before reaching backend', async () => {
    await installedUpdate()
    const starting = deferred<TaskStatus>()
    ipc.sessionStart.mockReturnValueOnce(starting.promise)
    let toggle!: Promise<void>
    await act(async () => {
      toggle = store.toggleSession()
    })
    await act(async () => store.restartApp())
    expect(ipc.updateRestart).not.toHaveBeenCalled()
    expect(store.updatePhase).toBe('ready')
    expect(store.error).toContain('等待会话收尾')
    await act(async () => {
      starting.resolve(TaskStatus.Capturing)
      await toggle
    })
  })

  it('unsubscribes all session and window events on unmount', async () => {
    await render()
    expect(listeners.has(EVENT.sessionError)).toBe(true)
    await act(async () => root.unmount())
    expect(listeners.size).toBe(0)
    root = createRoot(container)
  })
})
