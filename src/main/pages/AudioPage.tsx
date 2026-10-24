import { useStore } from '@/main/store'
import { AudioSourceKind, openPrivacySettings } from '@/shared/ipc'
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
    description: '转写播放器输出的声音。需要「屏幕与系统音频录制」权限。',
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
            麦克风授权未决时，macOS 会拒绝整份设备列表——先去「权限」页确认一下。
            <Button size="sm" className="ml-1.5" onClick={onOpenPermissions}>
              查看权限
            </Button>
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
              description={o.description}
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

      {capturing && <p className="text-[var(--color-ink-2)] text-[0.7rem]">采集期间修改设备仅下次会话生效。</p>}
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

  return (
    <Alert tone="warn" title="收不到声音（电平 ≈ 0）">
      <ul className="list-inside list-disc space-y-1">
        {systemAudio && (
          <>
            <li>确认播放器正在输出声音，且系统音量不为零。</li>
            <li>
              检查 macOS「屏幕与系统音频录制」权限。
              <span className="font-medium">权限被拒时采集会正常启动，但始终返回数字静音</span>。
            </li>
            <li>所选设备为虚拟声卡（如 BlackHole）时，需先将音频路由至它。</li>
          </>
        )}
        {mic && <li>检查麦克风权限；虚拟回环设备需换为真实麦克风。</li>}
      </ul>
      <div className="mt-1.5 flex gap-1.5">
        <Button size="sm" onClick={onOpenPermissions}>
          去「权限」页检测
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            openPrivacySettings().catch(() => {})
          }}
        >
          直接打开系统设置
        </Button>
      </div>
    </Alert>
  )
}
