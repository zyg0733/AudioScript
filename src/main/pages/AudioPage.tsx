import { useState } from 'react'
import { useStore } from '@/main/store'
import { AudioSourceKind, formatCmdError, openPrivacySettings } from '@/shared/ipc'
import { isMacOS, isWindows } from '@/shared/platform'
import { TaskStatus } from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { Button } from '@/ui/Button'
import { ChoiceCard, ChoiceGroup } from '@/ui/ChoiceCard'
import { LevelMeter } from '@/ui/LevelMeter'
import { Page } from '@/ui/Page'
import { Select } from '@/ui/Select'
import { SectionLabel, SettingsGroup, SettingsRow } from '@/ui/Settings'

const SOURCE_OPTIONS = [
  {
    value: AudioSourceKind.Loopback,
    label: '系统声音',
    description: '转写播放器输出的声音。',
  },
  { value: AudioSourceKind.Mic, label: '麦克风', description: '只转写麦克风输入，不碰播放器。' },
  {
    value: AudioSourceKind.Mix,
    label: '麦克风 + 系统声',
    description: '两路同时采集：对方的声音和你的都进转写，适合会议。',
  },
]

export function AudioPage({ onOpenPermissions }: { onOpenPermissions: () => void }) {
  const {
    audioSource,
    setAudioSource,
    devices,
    device,
    setDevice,
    deviceError,
    refreshDevices,
    audio,
    status,
    pending,
  } = useStore()

  const capturing = status === TaskStatus.Capturing
  const selected = devices.find((d) => d.id === device)

  return (
    <Page title="音频">
      {deviceError && (
        <Alert tone="warn" title="无法枚举音频设备">
          <p className="font-mono text-[0.95em]">{deviceError}</p>
          <p className="mt-1">仍可使用「系统默认」设备，仅手动指定设备受影响。</p>
          <p className="mt-1">
            {isMacOS ? (
              <>
                麦克风授权未决时，macOS 可能无法列出设备，请先确认权限。
                <Button size="sm" className="ml-1.5" onClick={onOpenPermissions}>
                  查看权限
                </Button>
              </>
            ) : isWindows ? (
              '请检查 Windows 的音频设备设置与设备连接，再点击「刷新」。'
            ) : (
              '请检查系统音频服务与设备连接，再点击「刷新」。'
            )}
          </p>
        </Alert>
      )}

      {audio?.silent && audio.segments === 0 && (
        <SilenceHelp audioSource={audioSource} onOpenPermissions={onOpenPermissions} />
      )}

      <section className="space-y-2">
        <SectionLabel>音源</SectionLabel>
        <ChoiceGroup label="音源">
          {SOURCE_OPTIONS.map((o) => (
            <ChoiceCard
              key={o.value}
              title={o.label}
              description={
                o.value === AudioSourceKind.Loopback && isMacOS
                  ? `${o.description}需要「屏幕与系统音频录制」权限。`
                  : o.description
              }
              selected={audioSource === o.value}
              disabled={capturing || pending}
              onSelect={() => setAudioSource(o.value)}
            />
          ))}
        </ChoiceGroup>
        <p className="px-1 text-[var(--color-ink-2)] text-[0.7rem] leading-relaxed">更换音源后设备列表将重新枚举。</p>
      </section>

      <SettingsGroup title="输入设备">
        <SettingsRow
          icon="waveform"
          title="输入设备"
          description={
            selected
              ? `${selected.channels} 声道 · ${selected.sampleRate} Hz${selected.isDefault ? ' · 系统默认' : ''}`
              : undefined
          }
          control={
            <div className="flex items-center gap-1.5">
              <LevelMeter active={capturing} />
              <Select
                label="输入设备"
                value={device}
                options={
                  devices.length === 0
                    ? [{ value: '', label: '（未找到设备）' }]
                    : devices.map((d) => ({
                        value: d.id,
                        label: d.name,
                      }))
                }
                onChange={setDevice}
                disabled={capturing || pending}
                className="max-w-[13rem]"
              />
              <Button icon="refresh" size="sm" onClick={() => void refreshDevices()}>
                刷新
              </Button>
            </div>
          }
        />
      </SettingsGroup>

      {capturing && <p className="text-[var(--color-ink-2)] text-[0.7rem]">请先停止转写，再更换音源或输入设备。</p>}
    </Page>
  )
}

function SilenceHelp({
  audioSource,
  onOpenPermissions,
}: {
  audioSource: AudioSourceKind
  onOpenPermissions: () => void
}) {
  const systemAudio = audioSource !== AudioSourceKind.Mic
  const mic = audioSource !== AudioSourceKind.Loopback
  const [settingsError, setSettingsError] = useState<string | null>(null)

  async function openSettings() {
    setSettingsError(null)
    try {
      await openPrivacySettings(systemAudio ? 'systemAudio' : 'microphone')
    } catch (e) {
      setSettingsError(formatCmdError(e))
    }
  }

  return (
    <Alert tone="warn" title="收不到声音（电平 ≈ 0）">
      <ul className="list-inside list-disc space-y-1">
        {systemAudio && (
          <>
            <li>确认播放器正在输出声音，且系统音量不为零。</li>
            {isMacOS ? (
              <>
                <li>检查 macOS「屏幕与系统音频录制」权限；未授权时可能采集到静音。</li>
                <li>所选设备为虚拟声卡（如 BlackHole）时，需先将音频路由至它。</li>
              </>
            ) : (
              <li>确认播放器的输出设备与当前选择的系统声音采集设备一致；使用虚拟设备时，请检查音频路由。</li>
            )}
          </>
        )}
        {mic && (
          <li>
            {isMacOS
              ? '检查麦克风权限；虚拟回环设备需换为真实麦克风。'
              : isWindows
                ? '在 Windows 系统设置中确认麦克风访问已开启，并选择实际使用的输入设备。'
                : '检查麦克风是否静音，确认所选输入设备有声音。'}
          </li>
        )}
      </ul>
      {isMacOS && (
        <div className="mt-1.5 flex gap-1.5">
          <Button size="sm" onClick={onOpenPermissions}>
            去「权限」页检测
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void openSettings()}>
            直接打开系统设置
          </Button>
        </div>
      )}
      {settingsError && (
        <p role="alert" className="mt-1">
          无法打开系统设置：{settingsError}
        </p>
      )}
    </Alert>
  )
}
