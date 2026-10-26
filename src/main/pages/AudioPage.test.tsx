import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioSourceKind, TaskStatus } from '@/shared/types'
import { AudioPage } from './AudioPage'

const mocks = vi.hoisted(() => ({
  platform: 'mac' as 'mac' | 'windows' | 'linux',
  audioSource: 'loopback',
  deviceError: null as string | null,
  openPrivacySettings: vi.fn(),
  openPermissions: vi.fn(),
  refreshDevices: vi.fn(),
}))

vi.mock('@/shared/platform', () => ({
  get isMacOS() {
    return mocks.platform === 'mac'
  },
  get isWindows() {
    return mocks.platform === 'windows'
  },
}))

vi.mock('@/main/store', () => ({
  useStore: () => ({
    audioSource: mocks.audioSource,
    setAudioSource: vi.fn(),
    devices: [],
    device: '',
    setDevice: vi.fn(),
    deviceError: mocks.deviceError,
    refreshDevices: mocks.refreshDevices,
    audio: { silent: true, rms: 0, segments: 0 },
    status: TaskStatus.Capturing,
    pending: false,
  }),
}))

vi.mock('@/shared/ipc', async () => ({
  ...(await vi.importActual<typeof import('@/shared/ipc')>('@/shared/ipc')),
  openPrivacySettings: mocks.openPrivacySettings,
}))

vi.mock('@/ui/LevelMeter', () => ({ LevelMeter: () => null }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('AudioPage platform and source guidance', () => {
  let container: HTMLDivElement
  let root: Root

  async function render() {
    await act(async () => root.render(<AudioPage onOpenPermissions={mocks.openPermissions} />))
  }

  function settingsButton() {
    return Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('直接打开系统设置'),
    )
  }

  beforeEach(() => {
    mocks.platform = 'mac'
    mocks.audioSource = AudioSourceKind.Loopback
    mocks.deviceError = null
    mocks.openPrivacySettings.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it.each([
    [AudioSourceKind.Mic, 'microphone'],
    [AudioSourceKind.Loopback, 'systemAudio'],
    [AudioSourceKind.Mix, 'systemAudio'],
  ])('opens the relevant macOS privacy pane for %s', async (source, pane) => {
    mocks.audioSource = source
    await render()
    const button = settingsButton()
    if (!button) throw new Error('系统设置按钮未找到')
    await act(async () => button.click())
    expect(mocks.openPrivacySettings).toHaveBeenCalledWith(pane)
  })

  it.each(['windows', 'linux'] as const)('avoids unsupported macOS actions on %s', async (platform) => {
    mocks.platform = platform
    mocks.deviceError = '设备暂不可用'
    await render()

    expect(settingsButton()).toBeUndefined()
    expect(container.textContent).not.toContain('macOS')
    expect(container.textContent).not.toContain('屏幕与系统音频录制')
    expect(container.textContent).not.toContain('BlackHole')
    const refresh = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '刷新')
    if (!refresh) throw new Error('刷新按钮未找到')
    await act(async () => refresh.click())
    expect(mocks.refreshDevices).toHaveBeenCalledOnce()
    expect(mocks.openPrivacySettings).not.toHaveBeenCalled()
  })

  it('shows microphone access guidance on Windows without claiming a system audio permission issue', async () => {
    mocks.platform = 'windows'
    mocks.audioSource = AudioSourceKind.Mic
    await render()

    const alert = container.querySelector('[role="status"]')
    expect(alert?.textContent).toContain('麦克风访问')
    expect(alert?.textContent).not.toContain('播放器')
    expect(settingsButton()).toBeUndefined()
  })

  it('reports failure to open macOS settings without hiding the troubleshooting steps', async () => {
    mocks.openPrivacySettings.mockRejectedValue(new Error('系统设置暂不可用'))
    await render()
    const button = settingsButton()
    if (!button) throw new Error('系统设置按钮未找到')
    await act(async () => button.click())

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('系统设置暂不可用')
    expect(settingsButton()).toBeDefined()
  })
})
