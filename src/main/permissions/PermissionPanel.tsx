import { useCallback, useState } from 'react'
import { useStore } from '@/main/store'
import {
  formatCmdError,
  MicPermission,
  openPrivacySettings,
  type PrivacyPane,
  permissionProbeSystemAudio,
  permissionRequestMic,
  type SystemAudioProbe,
  SystemAudioVerdict,
} from '@/shared/ipc'
import { isMacOS, isWindows } from '@/shared/platform'
import { TaskStatus } from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { Button } from '@/ui/Button'
import { LevelBars, LevelMeter } from '@/ui/LevelMeter'
import { SettingsGroup, SettingsRow } from '@/ui/Settings'
import { StatusBadge } from '@/ui/StatusBadge'

const MIC_TEXT: Record<MicPermission, string> = {
  granted: '已授权',
  denied: '已拒绝',
  restricted: '已受限',
  notDetermined: '未授权',
  notApplicable: '不适用',
  unknown: '未知',
}

const MIC_TONE: Record<MicPermission, 'ok' | 'warn' | 'danger' | 'muted'> = {
  granted: 'ok',
  denied: 'danger',
  restricted: 'danger',
  notDetermined: 'warn',
  notApplicable: 'muted',
  unknown: 'muted',
}

const PROBE_TEXT: Record<SystemAudioVerdict, string> = {
  audible: '可用',
  silentWhilePlaying: '采集静音',
  tapRejected: '已拒绝',
  noAudioPlaying: '未检测',
  unsupportedOs: '系统版本过低',
  inconclusive: '未知',
}

const PROBE_TONE: Record<SystemAudioVerdict, 'ok' | 'warn' | 'danger' | 'muted'> = {
  audible: 'ok',
  silentWhilePlaying: 'danger',
  tapRejected: 'danger',
  noAudioPlaying: 'muted',
  unsupportedOs: 'warn',
  inconclusive: 'muted',
}

export function PermissionPanel() {
  const { permissions, refreshPermission, refreshDevices, status } = useStore()
  const capturing = status === TaskStatus.Capturing
  const [probing, setProbing] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [probe, setProbe] = useState<SystemAudioProbe | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const mic = permissions?.microphone ?? MicPermission.Unknown
  const promptable = permissions?.microphonePromptable ?? false

  const runProbe = useCallback(async () => {
    setProbing(true)
    setNote(null)
    setFailure(null)
    try {
      const result = await permissionProbeSystemAudio()
      setProbe(result)
    } catch (e) {
      setFailure(formatCmdError(e))
    } finally {
      setProbing(false)
    }
  }, [])

  const askMic = useCallback(async () => {
    setRequesting(true)
    setNote(null)
    setFailure(null)
    try {
      const result = await permissionRequestMic()
      if (result.timedOut) {
        setNote('等待系统弹窗超时。弹窗可能仍停留在屏幕上，确认后请重新检测。')
      }
      await refreshPermission()
      if (result.state === MicPermission.Granted) await refreshDevices()
    } catch (e) {
      setFailure(formatCmdError(e))
    } finally {
      setRequesting(false)
    }
  }, [refreshPermission, refreshDevices])

  const open = useCallback(async (pane: PrivacyPane) => {
    try {
      await openPrivacySettings(pane)
    } catch (e) {
      setFailure(formatCmdError(e))
    }
  }, [])

  return (
    <div className="space-y-3">
      {failure && (
        <Alert tone="error" title="操作失败">
          <p className="font-mono text-[0.95em]">{failure}</p>
        </Alert>
      )}
      {note && <Alert tone="info">{note}</Alert>}

      <SettingsGroup title="权限" footer="音频只在本机处理，不会上传；重新安装后系统可能要求重新授权。">
        <SettingsRow
          icon="waveform"
          title="麦克风"
          description={micDescription(mic, promptable)}
          control={
            <div className="flex items-center gap-1.5">
              <StatusBadge tone={MIC_TONE[mic]}>{MIC_TEXT[mic]}</StatusBadge>
              {mic === MicPermission.NotDetermined && promptable && (
                <Button size="sm" pending={requesting} onClick={() => void askMic()}>
                  请求权限
                </Button>
              )}
              {isMacOS &&
                (mic === MicPermission.Denied ||
                  mic === MicPermission.Restricted ||
                  (mic === MicPermission.NotDetermined && !promptable)) && (
                  <Button size="sm" onClick={() => void open('microphone')}>
                    打开设置
                  </Button>
                )}
            </div>
          }
        />

        <SettingsRow
          icon="speaker"
          title="系统声音录制"
          description={
            isWindows ? (
              'Windows 暂不提供系统声音检测；转写时的系统声音采集仍然可用。'
            ) : (
              <>
                {probing ? '正在检测系统声音，请保持播放。' : probeDescription(probe)}
                {probing && (
                  <span className="mt-1 flex items-center gap-2">
                    <LevelMeter active />
                    <span className="font-mono">实时电平</span>
                  </span>
                )}
                {!probing && probe && (
                  <span className="mt-1 flex items-center gap-2">
                    <LevelBars level={probe.peak} />
                    <span className="font-mono">
                      峰值 {formatDbfs(probe.peak)} · 均值 {formatDbfs(probe.rms)}
                    </span>
                  </span>
                )}
                {!probing && probe?.detail && probe.verdict !== SystemAudioVerdict.Inconclusive && (
                  <span className="mt-1 block">{probe.detail}</span>
                )}
              </>
            )
          }
          control={
            isWindows ? (
              <StatusBadge tone="muted">暂不支持检测</StatusBadge>
            ) : (
              <div className="flex items-center gap-1.5">
                <StatusBadge tone={probe ? PROBE_TONE[probe.verdict] : 'muted'}>
                  {probe ? PROBE_TEXT[probe.verdict] : '未检测'}
                </StatusBadge>
                {isMacOS &&
                  (probe?.verdict === SystemAudioVerdict.SilentWhilePlaying ||
                    probe?.verdict === SystemAudioVerdict.TapRejected) && (
                    <Button size="sm" onClick={() => void open('systemAudio')}>
                      打开设置
                    </Button>
                  )}
                <Button size="sm" pending={probing} disabled={capturing || probing} onClick={() => void runProbe()}>
                  检测
                </Button>
              </div>
            )
          }
        />
      </SettingsGroup>
    </div>
  )
}

function micDescription(mic: MicPermission, promptable: boolean): string {
  if (mic === MicPermission.Granted) return '麦克风音源所需。'
  if (mic === MicPermission.NotApplicable) {
    return isWindows
      ? 'Windows 暂不提供应用内麦克风授权检测；如采集无声，请检查系统设置中的麦克风访问。'
      : '当前系统不提供应用内麦克风授权检测；请在「音频」页检查输入设备与电平。'
  }
  if (mic === MicPermission.Denied || mic === MicPermission.Restricted) {
    return '系统不会再弹窗，需要到系统设置里手动打开。'
  }
  if (mic === MicPermission.NotDetermined && !promptable) {
    return '当前启动方式无法请求麦克风权限，请从已安装的 AudioScript 应用启动后重试。'
  }
  if (mic === MicPermission.NotDetermined) {
    return isMacOS ? '未授权时，macOS 可能无法列出设备。' : '请选择允许麦克风访问后重试。'
  }
  return '无法读取麦克风授权状态。'
}

function formatDbfs(value: number): string {
  if (value <= 0) return '静音'
  const db = 20 * Math.log10(value)
  if (db <= -60) return '< -60 dBFS'
  return `${Math.round(db)} dBFS`
}

function probeDescription(probe: SystemAudioProbe | null): string {
  if (!probe) return '先播放一段音频，再点「检测」。'
  switch (probe.verdict) {
    case SystemAudioVerdict.Audible:
      return '本次检测采集到了声音。'
    case SystemAudioVerdict.SilentWhilePlaying:
      return '检测到声音播放，但采集结果为静音。请检查录制权限与音频路由后重试。'
    case SystemAudioVerdict.TapRejected:
      return '系统明确拒绝了系统音频采集。'
    case SystemAudioVerdict.NoAudioPlaying:
      return '没有检测到系统在播放声音，请先播放音频再检测。'
    case SystemAudioVerdict.UnsupportedOs:
      return isMacOS ? '需要 macOS 14.4 或更高版本。' : '当前系统版本不支持此检测。'
    case SystemAudioVerdict.Inconclusive:
      return probe.detail ?? '无法判定，请重试。'
  }
}
