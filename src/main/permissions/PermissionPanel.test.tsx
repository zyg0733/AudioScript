import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MicPermission, type SystemAudioProbe, SystemAudioVerdict, TaskStatus } from '@/shared/types'
import { PermissionPanel } from './PermissionPanel'

const mocks = vi.hoisted(() => ({
  platform: 'mac' as 'mac' | 'windows' | 'linux',
  mic: 'granted',
  promptable: false,
  probeSystemAudio: vi.fn(),
  requestMic: vi.fn(),
  openPrivacySettings: vi.fn(),
  refreshPermission: vi.fn(),
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
    permissions: { microphone: mocks.mic, microphonePromptable: mocks.promptable },
    refreshPermission: mocks.refreshPermission,
    refreshDevices: mocks.refreshDevices,
    status: TaskStatus.Ready,
  }),
}))

vi.mock('@/shared/ipc', async () => ({
  ...(await vi.importActual<typeof import('@/shared/ipc')>('@/shared/ipc')),
  permissionProbeSystemAudio: mocks.probeSystemAudio,
  permissionRequestMic: mocks.requestMic,
  openPrivacySettings: mocks.openPrivacySettings,
}))

vi.mock('@/ui/LevelMeter', () => ({ LevelMeter: () => null, LevelBars: () => null }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function probe(verdict: SystemAudioVerdict, detail?: string): SystemAudioProbe {
  return { verdict, detail, peak: 0, rms: 0, samples: 100, activeProcesses: 1 }
}

describe('PermissionPanel capability and detection results', () => {
  let container: HTMLDivElement
  let root: Root

  function button(label: string) {
    return Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.trim() === label)
  }

  async function render() {
    await act(async () => root.render(<PermissionPanel />))
  }

  async function detect() {
    const detectButton = button('检测')
    if (!detectButton) throw new Error('检测按钮未找到')
    await act(async () => detectButton.click())
  }

  beforeEach(() => {
    mocks.platform = 'mac'
    mocks.mic = MicPermission.Granted
    mocks.promptable = false
    mocks.probeSystemAudio.mockReset()
    mocks.requestMic.mockReset()
    mocks.openPrivacySettings.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('distinguishes unavailable Windows detection from available capture', async () => {
    mocks.platform = 'windows'
    mocks.mic = MicPermission.NotApplicable
    await render()

    expect(button('检测')).toBeUndefined()
    expect(button('打开设置')).toBeUndefined()
    expect(container.textContent).toContain('暂不支持检测')
    expect(container.textContent).toContain('系统声音采集仍然可用')
    expect(container.textContent).not.toContain('无法读取麦克风授权状态')
    expect(mocks.probeSystemAudio).not.toHaveBeenCalled()
    expect(mocks.requestMic).not.toHaveBeenCalled()
  })

  it('keeps a silent capture result distinct from a confirmed permission denial', async () => {
    mocks.probeSystemAudio.mockResolvedValue(probe(SystemAudioVerdict.SilentWhilePlaying, '设备未输出可用音频'))
    await render()
    await detect()

    expect(container.textContent).toContain('采集静音')
    expect(container.textContent).not.toContain('未授权')
    expect(container.textContent).toContain('设备未输出可用音频')
    const open = button('打开设置')
    if (!open) throw new Error('系统设置按钮未找到')
    await act(async () => open.click())
    expect(mocks.openPrivacySettings).toHaveBeenCalledWith('systemAudio')
  })

  it('keeps a no-playback result actionable without reporting a permission failure', async () => {
    mocks.probeSystemAudio.mockResolvedValue(probe(SystemAudioVerdict.NoAudioPlaying))
    await render()
    await detect()

    expect(button('检测')?.disabled).toBe(false)
    expect(button('打开设置')).toBeUndefined()
    expect(container.textContent).toContain('请先播放音频再检测')
    expect(container.textContent).not.toContain('已拒绝')
    expect(mocks.openPrivacySettings).not.toHaveBeenCalled()
  })

  it('preserves backend details when the result is inconclusive', async () => {
    mocks.probeSystemAudio.mockResolvedValue(probe(SystemAudioVerdict.Inconclusive, '音频设备在检测中断开'))
    await render()
    await detect()

    expect(container.textContent).toContain('音频设备在检测中断开')
    expect(button('打开设置')).toBeUndefined()
    expect(button('检测')?.disabled).toBe(false)
  })

  it('does not offer a macOS settings command after a Linux probe', async () => {
    mocks.platform = 'linux'
    mocks.mic = MicPermission.NotApplicable
    mocks.probeSystemAudio.mockResolvedValue(probe(SystemAudioVerdict.SilentWhilePlaying))
    await render()
    await detect()

    expect(mocks.probeSystemAudio).toHaveBeenCalledOnce()
    expect(button('打开设置')).toBeUndefined()
    expect(container.textContent).not.toContain('macOS')
    expect(container.textContent).not.toContain('无法读取麦克风授权状态')
  })

  it('guides an unpromptable macOS app to the installed application', async () => {
    mocks.mic = MicPermission.NotDetermined
    await render()

    expect(button('请求权限')).toBeUndefined()
    const open = button('打开设置')
    if (!open) throw new Error('系统设置按钮未找到')
    await act(async () => open.click())
    expect(mocks.openPrivacySettings).toHaveBeenCalledWith('microphone')
    expect(container.textContent).toContain('已安装的 AudioScript 应用')
    expect(container.textContent).not.toContain('pnpm')
  })
})
