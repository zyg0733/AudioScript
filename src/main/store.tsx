import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { setTrackingEnabled, track } from '@/shared/analytics'
import {
  type AppInfo,
  AudioSourceKind,
  type AudioStatus,
  appInfo,
  audioDevices,
  type CmdPermissionError,
  EVENT,
  formatCmdError,
  type HotkeyFailure,
  type HotkeyInfo,
  hotkeyFailures,
  type InputDevice,
  type OverlayConfig,
  on,
  overlayConfigGet,
  overlayConfigSet,
  overlayIsVisible,
  overlayToggle,
  type PermissionSnapshot,
  type Preferences,
  type PrefsPatch,
  permissionOf,
  permissionStatus,
  prefsGet,
  prefsSet,
  sessionClear,
  sessionStart,
  sessionStatus,
  sessionStop,
  shortcutsGet,
  Theme,
  TranslateEngine,
  type UpdateCheckResult,
  type UpdateProgress,
  updateCheck,
  updateInstall,
  updateRestart,
  ZhScript,
} from '@/shared/ipc'
import { withTimeout } from '@/shared/timeout'
import { type SessionInfo, SessionPhase, TaskStatus } from '@/shared/types'

type EndpointConfig = Preferences['endpoint']

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

interface Store {
  info: AppInfo | null

  prefsReady: boolean
  audioSource: AudioSourceKind
  device: string
  translateEngine: TranslateEngine
  sourceLang: string
  zhScript: ZhScript
  theme: Theme
  endpoint: EndpointConfig

  status: TaskStatus
  sessionInfo: SessionInfo | null
  refreshSession: () => Promise<void>
  activeDevice: string | null
  audio: AudioStatus | null

  devices: InputDevice[]
  deviceError: string | null

  overlayCfg: OverlayConfig | null
  overlayVisible: boolean

  hotkeys: HotkeyInfo[]
  hotkeyProblems: HotkeyFailure[]

  updateInfo: UpdateCheckResult | null
  updatePhase: UpdatePhase
  updateRestarting: boolean
  updateProgress: UpdateProgress | null
  updateError: string | null
  installedVersion: string | null
  checkUpdate: (silent?: boolean) => Promise<void>
  installUpdate: () => Promise<void>
  restartApp: () => Promise<void>
  runSettingsWrite: <T>(key: string, write: () => Promise<T>) => Promise<T>

  onboardingDone: boolean
  completeOnboarding: () => Promise<void>

  analyticsEnabled: boolean
  setAnalyticsEnabled: (v: boolean) => void

  permissions: PermissionSnapshot | null
  refreshPermission: () => Promise<void>
  permissionError: CmdPermissionError | null
  setPermissionError: (e: CmdPermissionError | null) => void

  error: string | null
  setError: (e: string | null) => void
  pending: boolean

  toggleSession: () => Promise<void>
  clearAll: () => Promise<void>
  setAudioSource: (v: AudioSourceKind) => void
  setDevice: (v: string) => void
  setTranslateEngine: (v: TranslateEngine) => void
  setDirection: (lang: string, script: ZhScript) => void
  changeTheme: (v: Theme) => Promise<void>
  setEndpoint: (v: EndpointConfig) => Promise<void>
  updateOverlay: (patch: Partial<OverlayConfig>) => Promise<void>
  toggleOverlay: () => Promise<void>
  refreshDevices: () => Promise<void>
  refreshHotkeys: () => Promise<void>
}

const STOP_TIMEOUT_MS = 8_000

const START_TIMEOUT_MS = 60_000
const SETTINGS_UPDATE_LOCKED = '正在下载、安装更新或重启，暂时不能修改设置，请等待完成后再试'

const Ctx = createContext<Store | null>(null)

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore 必须在 <StoreProvider> 内使用')
  return s
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [prefsReady, setPrefsReady] = useState(false)

  const [audioSource, setAudioSource] = useState<AudioSourceKind>(AudioSourceKind.Loopback)
  const [device, setDevice] = useState('')
  const [translateEngine, setTranslateEngine] = useState<TranslateEngine>(TranslateEngine.LocalNmt)
  const [sourceLang, setSourceLang] = useState('en')
  const [zhScript, setZhScript] = useState(ZhScript.Simplified)
  const [theme, setTheme] = useState<Theme>(Theme.System)
  const [endpoint, setEndpoint] = useState<EndpointConfig>({
    trailingSilenceMs: 800,
    maxUtteranceMs: 8000,
  })

  const [status, setStatus] = useState<TaskStatus>(TaskStatus.Ready)
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null)
  const [activeDevice, setActiveDevice] = useState<string | null>(null)
  const [audio, setAudio] = useState<AudioStatus | null>(null)
  const sessionVersion = useRef(0)

  const [devices, setDevices] = useState<InputDevice[]>([])
  const [deviceError, setDeviceError] = useState<string | null>(null)

  const [overlayCfg, setOverlayCfg] = useState<OverlayConfig | null>(null)
  const overlayCfgRef = useRef<OverlayConfig | null>(null)
  const overlayVersion = useRef(0)
  const overlayQueue = useRef<Promise<void>>(Promise.resolve())
  const overlayWriteError = useRef<string | null>(null)
  const [overlayVisible, setOverlayVisible] = useState(false)

  const [hotkeys, setHotkeys] = useState<HotkeyInfo[]>([])
  const [hotkeyProblems, setHotkeyProblems] = useState<HotkeyFailure[]>([])

  const [onboardingDone, setOnboardingDone] = useState(false)
  const [analyticsEnabled, setAnalyticsEnabledState] = useState(false)
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null)
  const [permissionError, setPermissionError] = useState<CmdPermissionError | null>(null)

  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const prefsQueue = useRef<Promise<void>>(Promise.resolve())
  const prefsFailureVersion = useRef(0)
  const prefsWriteErrors = useRef(new Map<string, string>())
  const settingsWrites = useRef(new Set<Promise<void>>())
  const settingsWriteQueues = useRef(new Map<string, Promise<void>>())
  const settingsWriteVersion = useRef(0)
  const settingsWriteErrors = useRef(new Map<string, string>())
  const lifetime = useRef({ active: true, version: 0 })

  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [updatePhase, setUpdatePhase] = useState<UpdatePhase>('idle')
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [installedVersion, setInstalledVersion] = useState<string | null>(null)
  const [updateRestarting, setUpdateRestarting] = useState(false)
  const updateBusyRef = useRef(false)
  const updateExclusiveRef = useRef(false)

  useEffect(() => {
    lifetime.current.active = true
    return () => {
      lifetime.current.active = false
      lifetime.current.version += 1
    }
  }, [])

  const applyOverlay = useCallback((config: OverlayConfig) => {
    overlayVersion.current += 1
    overlayCfgRef.current = config
    setOverlayCfg(config)
  }, [])

  const applySession = useCallback((current: SessionInfo) => {
    setSessionInfo(current)
    setStatus(current.status)
    setActiveDevice(current.device ?? null)
    if (current.status !== TaskStatus.Capturing) setAudio(null)
    if (current.error) setError(current.error)
  }, [])

  const refreshSession = useCallback(async () => {
    const version = ++sessionVersion.current
    try {
      const current = await sessionStatus()
      if (!lifetime.current.active || version !== sessionVersion.current) return
      applySession(current)
    } catch (e) {
      if (lifetime.current.active && version === sessionVersion.current) {
        setError(`读取会话状态失败：${formatCmdError(e)}`)
      }
    }
  }, [applySession])

  useEffect(() => {
    appInfo()
      .then(setInfo)
      .catch((e) => setError(formatCmdError(e)))
    hotkeyFailures()
      .then(setHotkeyProblems)
      .catch(() => {})
    shortcutsGet()
      .then(setHotkeys)
      .catch(() => {})

    const unlisten: Array<() => void> = []
    let disposed = false
    const keep = (fn: () => void) => {
      if (disposed) fn()
      else unlisten.push(fn)
    }

    const reportError = (e: unknown) => {
      if (!disposed) setError(formatCmdError(e))
    }
    on<TaskStatus>(EVENT.taskState, (s) => {
      if (disposed) return
      setStatus(s)
      setSessionInfo(null)
      if (s !== TaskStatus.Capturing) {
        setAudio(null)
        setActiveDevice(null)
      }
      void refreshSession()
    })
      .then((fn) => {
        keep(fn)
        if (!disposed) void refreshSession()
      })
      .catch(reportError)

    on<string>(EVENT.sessionError, (message) => {
      if (disposed) return
      sessionVersion.current++
      setStatus(TaskStatus.Error)
      setSessionInfo(null)
      setActiveDevice(null)
      setAudio(null)
      setError(message)
      void refreshSession()
    })
      .then(keep)
      .catch(reportError)

    on<AudioStatus>(EVENT.audio, setAudio).then(keep).catch(reportError)

    on<OverlayConfig>(EVENT.overlayState, (config) => {
      if (!disposed) applyOverlay(config)
    })
      .then(keep)
      .catch(reportError)

    on<boolean>(EVENT.overlayVisibility, setOverlayVisible).then(keep).catch(reportError)

    on<UpdateProgress>(EVENT.updateProgress, setUpdateProgress).then(keep).catch(reportError)

    return () => {
      disposed = true
      sessionVersion.current++
      for (const fn of unlisten) fn()
    }
  }, [applyOverlay, refreshSession])

  useEffect(() => {
    let disposed = false
    prefsGet()
      .then((p) => {
        if (disposed) return
        setAudioSource(p.audioSource as AudioSourceKind)
        setTranslateEngine(p.translateEngine)
        setSourceLang(p.sourceLang)
        setZhScript(p.zhScript)
        setTheme(p.theme)
        setEndpoint(p.endpoint)
        setOnboardingDone(p.onboardingDone)
        setAnalyticsEnabledState(p.analyticsEnabled)
        if (p.deviceId) setDevice(p.deviceId)
      })
      .catch((e) => {
        if (!disposed) setError(`读取设置失败：${formatCmdError(e)}`)
      })
      .finally(() => {
        if (!disposed) setPrefsReady(true)
      })

    const version = overlayVersion.current
    overlayConfigGet()
      .then((config) => {
        if (!disposed && config && version === overlayVersion.current) applyOverlay(config)
      })
      .catch((e) => {
        if (!disposed) setError(`读取悬浮窗配置失败：${formatCmdError(e)}`)
      })
    overlayIsVisible()
      .then((visible) => {
        if (!disposed) setOverlayVisible(visible)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [applyOverlay])

  useEffect(() => {
    setTrackingEnabled(prefsReady && analyticsEnabled && info?.analyticsAvailable === true)
  }, [prefsReady, analyticsEnabled, info])

  const refreshPermission = useCallback(async () => {
    try {
      setPermissions(await permissionStatus())
    } catch {
      setPermissions(null)
    }
  }, [])

  useEffect(() => {
    void refreshPermission()
    const onFocus = () => void refreshPermission()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshPermission])

  const applyTheme = useCallback((pref: Theme) => {
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const dark = pref === Theme.Dark || (pref === Theme.System && systemDark)
    document.documentElement.classList.toggle('theme-light', !dark)
    try {
      localStorage.setItem('audioscript.theme', pref)
    } catch {}
  }, [])

  useEffect(() => {
    applyTheme(theme)
    if (theme !== Theme.System) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme(Theme.System)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme, applyTheme])

  const savePrefs = useCallback((patch: PrefsPatch) => {
    if (updateExclusiveRef.current) return Promise.reject(new Error(SETTINGS_UPDATE_LOCKED))
    const version = lifetime.current.version
    const request = prefsQueue.current.then(async () => {
      if (!lifetime.current.active || version !== lifetime.current.version) return null
      try {
        const saved = await prefsSet(patch)
        if (lifetime.current.active && version === lifetime.current.version) {
          for (const key of Object.keys(patch)) prefsWriteErrors.current.delete(key)
        }
        return lifetime.current.active && version === lifetime.current.version ? saved : null
      } catch (error) {
        if (!lifetime.current.active || version !== lifetime.current.version) return null
        for (const key of Object.keys(patch)) prefsWriteErrors.current.set(key, formatCmdError(error))
        throw error
      }
    })
    prefsQueue.current = request.then(
      () => {},
      () => {
        prefsFailureVersion.current += 1
      },
    )
    return request
  }, [])

  const runSettingsWrite = useCallback(function run<T>(key: string, write: () => Promise<T>): Promise<T> {
    if (updateExclusiveRef.current) return Promise.reject(new Error(SETTINGS_UPDATE_LOCKED))
    const version = lifetime.current.version
    const request = (settingsWriteQueues.current.get(key) ?? Promise.resolve()).then(write)
    settingsWriteVersion.current += 1
    const tracked = request.then(
      () => {
        if (lifetime.current.active && version === lifetime.current.version) settingsWriteErrors.current.delete(key)
        settingsWrites.current.delete(tracked)
        if (settingsWriteQueues.current.get(key) === tracked) settingsWriteQueues.current.delete(key)
      },
      (error) => {
        if (lifetime.current.active && version === lifetime.current.version) {
          settingsWriteErrors.current.set(key, formatCmdError(error))
        }
        settingsWrites.current.delete(tracked)
        if (settingsWriteQueues.current.get(key) === tracked) settingsWriteQueues.current.delete(key)
      },
    )
    settingsWrites.current.add(tracked)
    settingsWriteQueues.current.set(key, tracked)
    return request
  }, [])

  const patchPrefs = useCallback(
    async (patch: PrefsPatch) => {
      try {
        const p = await savePrefs(patch)
        if (!p) return false
        if (patch.audioSource !== undefined) setAudioSource(p.audioSource as AudioSourceKind)
        if (patch.deviceId !== undefined) setDevice(p.deviceId ?? '')
        if (patch.translateEngine !== undefined) setTranslateEngine(p.translateEngine)
        if (patch.sourceLang !== undefined) setSourceLang(p.sourceLang)
        if (patch.zhScript !== undefined) setZhScript(p.zhScript)
        if (patch.theme !== undefined) setTheme(p.theme)
        if (patch.endpoint !== undefined) setEndpoint(p.endpoint)
        return true
      } catch (e) {
        if (patch.endpoint !== undefined) setEndpoint((current) => ({ ...current }))
        setError(formatCmdError(e))
        return false
      }
    },
    [savePrefs],
  )

  const completeOnboarding = useCallback(async () => {
    setError(null)
    try {
      const saved = await savePrefs({ onboardingDone: true })
      if (saved) {
        setOnboardingDone(saved.onboardingDone)
        track('onboarding_completed')
      }
    } catch (e) {
      setError(formatCmdError(e))
    }
  }, [savePrefs])

  const setAnalyticsEnabled = useCallback(
    (next: boolean) => {
      if (next && !info?.analyticsAvailable) {
        setError(info?.analyticsDisabledReason ?? '此构建未配置匿名统计')
        return
      }
      void savePrefs({ analyticsEnabled: next })
        .then((p) => {
          if (!p) return
          setAnalyticsEnabledState(p.analyticsEnabled)
          setTrackingEnabled(p.analyticsEnabled && info?.analyticsAvailable === true)
          if (p.analyticsEnabled) track('setting_changed', { key: 'analytics', value: 'on' })
        })
        .catch((e) => setError(formatCmdError(e)))
    },
    [info, savePrefs],
  )

  const refreshDevices = useCallback(async () => {
    try {
      const list = await audioDevices(audioSource)
      setDevices(list)
      setDeviceError(null)
      setDevice((cur) => cur || (list.find((d) => d.isDefault)?.id ?? ''))
    } catch (e) {
      setDeviceError(formatCmdError(e))
    }
  }, [audioSource])

  useEffect(() => {
    if (!prefsReady) return
    refreshDevices()
  }, [prefsReady, refreshDevices])

  const toggleSession = useCallback(async () => {
    if (pendingRef.current) return
    if (!sessionInfo) {
      await refreshSession()
      return
    }
    const stopping = status === TaskStatus.Capturing
    if (stopping ? !sessionInfo.actions.canStop : !sessionInfo.actions.canStart) {
      setError(sessionInfo.actions.reason ?? '会话状态正在变化，请稍后再试')
      return
    }
    if (status !== TaskStatus.Capturing && updateExclusiveRef.current) {
      setError('正在下载、安装更新或重启，请等待完成后再开始转写')
      return
    }
    pendingRef.current = true
    setPending(true)
    setError(null)
    setPermissionError(null)
    try {
      if (status === TaskStatus.Capturing) {
        await withTimeout(sessionStop(), STOP_TIMEOUT_MS, '停止请求超时：请重试，或使用托盘「停止转写」')
      } else {
        const lifetimeVersion = lifetime.current.version
        const failureVersion = prefsFailureVersion.current
        await prefsQueue.current
        if (!lifetime.current.active || lifetimeVersion !== lifetime.current.version) return
        if (failureVersion !== prefsFailureVersion.current) return
        const saved = await prefsGet()
        await withTimeout(
          sessionStart(
            saved.deviceId || undefined,
            saved.translateEngine,
            saved.sourceLang,
            saved.zhScript,
            saved.audioSource as AudioSourceKind,
          ),
          START_TIMEOUT_MS,
          '开始转写超时，请重试',
        )
        void refreshPermission()
      }
      await refreshSession()
    } catch (e) {
      const denied = permissionOf(e)
      if (denied) {
        setPermissionError(denied)
        void refreshPermission()
      } else {
        setError(formatCmdError(e))
      }
      await refreshSession()
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }, [status, sessionInfo, refreshPermission, refreshSession])

  const clearAll = useCallback(async () => {
    await sessionClear()
  }, [])

  const updateOverlay = useCallback(
    (patch: Partial<OverlayConfig>) => {
      if (updateExclusiveRef.current) {
        setOverlayCfg((config) => config && { ...config })
        setError(SETTINGS_UPDATE_LOCKED)
        return Promise.resolve()
      }
      const lifetimeVersion = lifetime.current.version
      const request = overlayQueue.current.then(async () => {
        if (!lifetime.current.active || lifetimeVersion !== lifetime.current.version) return
        const current = overlayCfgRef.current
        if (!current) return
        const version = overlayVersion.current
        try {
          const saved = await overlayConfigSet({ ...current, ...patch })
          if (!lifetime.current.active || lifetimeVersion !== lifetime.current.version) return
          overlayWriteError.current = null
          if (version === overlayVersion.current) applyOverlay(saved)
        } catch (e) {
          if (!lifetime.current.active || lifetimeVersion !== lifetime.current.version) return
          overlayWriteError.current = formatCmdError(e)
          setOverlayCfg((config) => config && { ...config })
          setError(formatCmdError(e))
        }
      })
      overlayQueue.current = request
      return request
    },
    [applyOverlay],
  )

  const toggleOverlay = useCallback(async () => {
    try {
      setOverlayVisible(await runSettingsWrite('overlay-visibility', overlayToggle))
    } catch (e) {
      setError(formatCmdError(e))
    }
  }, [runSettingsWrite])

  const refreshHotkeys = useCallback(async () => {
    try {
      setHotkeys(await shortcutsGet())
      setHotkeyProblems(await hotkeyFailures())
    } catch (e) {
      setError(formatCmdError(e))
    }
  }, [])

  const changeTheme = useCallback(
    async (next: Theme) => {
      if (await patchPrefs({ theme: next })) track('setting_changed', { key: 'theme', value: next })
    },
    [patchPrefs],
  )

  const changeAudioSource = useCallback(
    (v: AudioSourceKind) => {
      void patchPrefs({ audioSource: v, deviceId: '' }).then((saved) => {
        if (saved) track('setting_changed', { key: 'audio_source', value: v })
      })
    },
    [patchPrefs],
  )

  const changeDevice = useCallback(
    (v: string) => {
      void patchPrefs({ deviceId: v })
    },
    [patchPrefs],
  )

  const changeTranslateEngine = useCallback(
    (v: TranslateEngine) => {
      void patchPrefs({ translateEngine: v }).then((saved) => {
        if (saved) track('setting_changed', { key: 'translate_engine', value: v })
      })
    },
    [patchPrefs],
  )

  const changeDirection = useCallback(
    (lang: string, script: ZhScript) => {
      void patchPrefs({ sourceLang: lang, zhScript: script }).then((saved) => {
        if (saved) track('setting_changed', { key: 'translate_direction', value: `${lang}:${script}` })
      })
    },
    [patchPrefs],
  )

  const changeEndpoint = useCallback(
    async (v: EndpointConfig) => {
      await patchPrefs({ endpoint: v })
    },
    [patchPrefs],
  )

  const checkUpdate = useCallback(async (silent = false) => {
    if (updateBusyRef.current) return
    updateBusyRef.current = true
    setUpdatePhase('checking')
    if (!silent) setUpdateError(null)
    try {
      setUpdateInfo(await updateCheck())
      setUpdatePhase('idle')
    } catch (e) {
      setUpdatePhase(silent ? 'idle' : 'error')
      if (!silent) setUpdateError(formatCmdError(e))
    } finally {
      updateBusyRef.current = false
    }
  }, [])

  const flushSettings = useCallback(async () => {
    let preferences: Promise<void>
    let overlay: Promise<void>
    let directVersion: number
    do {
      preferences = prefsQueue.current
      overlay = overlayQueue.current
      directVersion = settingsWriteVersion.current
      await Promise.all([preferences, overlay, ...settingsWrites.current])
    } while (
      preferences !== prefsQueue.current ||
      overlay !== overlayQueue.current ||
      directVersion !== settingsWriteVersion.current
    )
    const failure =
      prefsWriteErrors.current.values().next().value ??
      overlayWriteError.current ??
      settingsWriteErrors.current.values().next().value
    if (failure) throw new Error(`设置尚未保存，请先重试保存：${failure}`)
  }, [])

  const installUpdate = useCallback(async () => {
    if (updateBusyRef.current) return
    if (!info?.updaterEnabled || !updateInfo?.enabled || !updateInfo.available) {
      setUpdateError(info?.updaterDisabledReason ?? updateInfo?.disabledReason ?? '当前没有可安装的更新')
      setUpdatePhase('error')
      return
    }
    if (!sessionInfo) {
      setUpdateError('会话状态尚未同步，请先重新读取会话状态')
      setUpdatePhase('error')
      return
    }
    if (
      pendingRef.current ||
      status === TaskStatus.Capturing ||
      sessionInfo?.phase === SessionPhase.Preparing ||
      sessionInfo?.phase === SessionPhase.Finalizing
    ) {
      setUpdateError('请先停止转写并等待会话收尾完成，再安装更新')
      setUpdatePhase('error')
      return
    }
    updateBusyRef.current = true
    updateExclusiveRef.current = true
    setUpdatePhase('downloading')
    setUpdateError(null)
    setUpdateProgress({ downloaded: 0, total: null })
    try {
      const version = lifetime.current.version
      await flushSettings()
      if (!lifetime.current.active || version !== lifetime.current.version) return
      const r = await updateInstall()
      setInstalledVersion(r.version)
      setUpdatePhase('ready')
    } catch (e) {
      setUpdatePhase('error')
      setUpdateError(formatCmdError(e))
    } finally {
      updateBusyRef.current = false
      updateExclusiveRef.current = false
    }
  }, [info, updateInfo, status, sessionInfo, flushSettings])

  const restartApp = useCallback(async () => {
    if (updateBusyRef.current) return
    if (updatePhase !== 'ready' || !installedVersion) {
      setError('请先完成更新安装，再重启应用')
      return
    }
    if (!sessionInfo) {
      setError('会话状态尚未同步，请先重新读取会话状态')
      return
    }
    if (
      pendingRef.current ||
      status === TaskStatus.Capturing ||
      sessionInfo?.phase === SessionPhase.Preparing ||
      sessionInfo?.phase === SessionPhase.Finalizing
    ) {
      setError('请先停止转写并等待会话收尾完成，再重启应用')
      return
    }
    updateBusyRef.current = true
    updateExclusiveRef.current = true
    setUpdateRestarting(true)
    try {
      const version = lifetime.current.version
      await flushSettings()
      if (!lifetime.current.active || version !== lifetime.current.version) return
      await updateRestart()
      setError(null)
    } catch (e) {
      setError(formatCmdError(e))
    } finally {
      updateBusyRef.current = false
      updateExclusiveRef.current = false
      setUpdateRestarting(false)
    }
  }, [updatePhase, installedVersion, status, sessionInfo, flushSettings])

  const autoCheckedRef = useRef(false)
  useEffect(() => {
    if (!info || autoCheckedRef.current) return
    autoCheckedRef.current = true
    if (!import.meta.env.PROD) return
    void checkUpdate(true)
  }, [info, checkUpdate])

  const value = useMemo<Store>(
    () => ({
      info,
      updateInfo,
      updatePhase,
      updateRestarting,
      updateProgress,
      updateError,
      installedVersion,
      checkUpdate,
      installUpdate,
      restartApp,
      runSettingsWrite,
      prefsReady,
      audioSource,
      device,
      translateEngine,
      sourceLang,
      zhScript,
      theme,
      endpoint,
      status,
      sessionInfo,
      refreshSession,
      activeDevice,
      audio,
      devices,
      deviceError,
      overlayCfg,
      overlayVisible,
      hotkeys,
      hotkeyProblems,
      onboardingDone,
      completeOnboarding,
      analyticsEnabled,
      setAnalyticsEnabled,
      permissions,
      refreshPermission,
      permissionError,
      setPermissionError,
      error,
      setError,
      pending,
      toggleSession,
      clearAll,
      setAudioSource: changeAudioSource,
      setDevice: changeDevice,
      setTranslateEngine: changeTranslateEngine,
      setDirection: changeDirection,
      changeTheme,
      setEndpoint: changeEndpoint,
      updateOverlay,
      toggleOverlay,
      refreshDevices,
      refreshHotkeys,
    }),
    [
      info,
      updateInfo,
      updatePhase,
      updateRestarting,
      updateProgress,
      updateError,
      installedVersion,
      checkUpdate,
      installUpdate,
      restartApp,
      runSettingsWrite,
      prefsReady,
      audioSource,
      device,
      translateEngine,
      sourceLang,
      zhScript,
      theme,
      endpoint,
      status,
      sessionInfo,
      refreshSession,
      activeDevice,
      audio,
      devices,
      deviceError,
      overlayCfg,
      overlayVisible,
      hotkeys,
      hotkeyProblems,
      onboardingDone,
      completeOnboarding,
      analyticsEnabled,
      setAnalyticsEnabled,
      permissions,
      refreshPermission,
      permissionError,
      error,
      pending,
      toggleSession,
      clearAll,
      changeAudioSource,
      changeDevice,
      changeTranslateEngine,
      changeDirection,
      changeTheme,
      changeEndpoint,
      updateOverlay,
      toggleOverlay,
      refreshDevices,
      refreshHotkeys,
    ],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
