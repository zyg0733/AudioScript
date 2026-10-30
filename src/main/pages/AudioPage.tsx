import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '@/main/store'
import { useI18n } from '@/shared/i18n'
import {
  AudioSourceKind,
  formatCmdError,
  type InputDevice,
  type MonitorTarget,
  monitorStart,
  monitorStop,
  openPrivacySettings,
  permissionOf,
} from '@/shared/ipc'
import { isMacOS, isWindows } from '@/shared/platform'
import { TaskStatus } from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { Button } from '@/ui/Button'
import { ChoiceCard, ChoiceGroup } from '@/ui/ChoiceCard'
import { DeviceSelect, describeDevice } from '@/ui/DeviceSelect'
import { DeviceLevelMeter, LevelMeter } from '@/ui/LevelMeter'
import { Page } from '@/ui/Page'
import { SectionLabel, SettingsGroup, SettingsRow } from '@/ui/Settings'

export function AudioPage({ onOpenPermissions }: { onOpenPermissions: () => void }) {
  const {
    audioSource,
    setAudioSource,
    devices,
    device,
    setDevice,
    mixMicDevices = [],
    mixSystemDevices = [],
    mixMicDevice,
    mixSystemDevice,
    setMixMicDevice,
    setMixSystemDevice,
    deviceError,
    refreshDevices,
    audio,
    status,
    pending,
    prefsReady,
    devicesLoading,
  } = useStore()
  const { t } = useI18n()

  const sourceOptions = [
    {
      value: AudioSourceKind.Loopback,
      label: t('audio.sourceLoopbackLabel'),
      description: t('audio.sourceLoopbackDescription'),
    },
    {
      value: AudioSourceKind.Mic,
      label: t('audio.sourceMicLabel'),
      description: t('audio.sourceMicDescription'),
    },
    {
      value: AudioSourceKind.Mix,
      label: t('audio.sourceMixLabel'),
      description: t('audio.sourceMixDescription'),
    },
  ]

  const capturing = status === TaskStatus.Capturing
  const isMix = audioSource === AudioSourceKind.Mix

  const [previewOn, setPreviewOn] = useState(false)
  const [openMenu, setOpenMenu] = useState<'single' | 'mic' | 'system' | null>(null)
  const [monitorError, setMonitorError] = useState<{ message: string; permission: boolean } | null>(null)
  const previewSeq = useRef(0)
  const previewing = previewOn && !pending && !capturing

  const targets = useMemo<MonitorTarget[]>(() => {
    const out: MonitorTarget[] = []
    if (isMix) {
      out.push({ source: AudioSourceKind.Mic, device: mixMicDevice })
      out.push({ source: AudioSourceKind.Loopback, device: mixSystemDevice })
      if (openMenu === 'mic') {
        for (const d of mixMicDevices) out.push({ source: AudioSourceKind.Mic, device: d.id })
      }
      if (openMenu === 'system') {
        for (const d of mixSystemDevices) out.push({ source: AudioSourceKind.Loopback, device: d.id })
      }
      return out
    }
    if (openMenu === 'single') {
      for (const d of devices) out.push({ source: audioSource, device: d.id })
      if (!device) out.push({ source: audioSource, device: null })
      if (out.length === 0) out.push({ source: audioSource, device: null })
      return out
    }
    out.push({ source: audioSource, device })
    return out
  }, [isMix, mixMicDevice, mixSystemDevice, openMenu, mixMicDevices, mixSystemDevices, devices, device, audioSource])

  const startPreview = useCallback(() => {
    if (!prefsReady || devicesLoading || capturing) return
    const seq = ++previewSeq.current
    monitorStart(targets)
      .then(() => {
        if (seq !== previewSeq.current) return
        setPreviewOn(true)
        setMonitorError(null)
      })
      .catch((e) => {
        if (seq !== previewSeq.current) return
        setPreviewOn(false)
        setMonitorError({ message: formatCmdError(e), permission: permissionOf(e) !== null })
      })
  }, [prefsReady, devicesLoading, capturing, targets])

  useEffect(() => {
    if (capturing) {
      setPreviewOn(false)
      setMonitorError(null)
      return
    }
    if (!prefsReady || devicesLoading) return
    const timer = window.setTimeout(() => void startPreview(), 200)
    return () => window.clearTimeout(timer)
  }, [startPreview, capturing, prefsReady, devicesLoading])

  useEffect(() => {
    const onFocus = () => void startPreview()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [startPreview])

  useEffect(() => {
    return () => {
      previewSeq.current += 1
      monitorStop().catch(() => {})
    }
  }, [])

  return (
    <Page title={t('audio.title')}>
      {deviceError && (
        <Alert
          tone="warn"
          title={t('audio.enumerateFailed')}
          actions={
            <Button size="sm" onClick={onOpenPermissions}>
              {t('audio.viewPermissions')}
            </Button>
          }
        >
          <p className="break-words font-mono text-[0.95em]">{deviceError}</p>
          <p className="mt-1">{t('audio.enumerateHintDefault')}</p>
          {isMacOS && <p className="mt-1">{t('audio.enumerateHintPermission')}</p>}
        </Alert>
      )}

      {monitorError && (
        <Alert
          tone="warn"
          title={t('audio.previewFailed')}
          onDismiss={() => setMonitorError(null)}
          actions={
            <>
              {monitorError.permission && (
                <Button size="sm" onClick={onOpenPermissions}>
                  {t('audio.viewPermissions')}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => void startPreview()}>
                {t('common.retry')}
              </Button>
            </>
          }
        >
          <p className="break-words font-mono text-[0.95em]">{monitorError.message}</p>
        </Alert>
      )}

      {audio?.silent && audio.segments === 0 && (
        <SilenceHelp audioSource={audioSource} onOpenPermissions={onOpenPermissions} />
      )}

      <section className="space-y-2">
        <SectionLabel>{t('audio.sourceSection')}</SectionLabel>
        <ChoiceGroup label={t('audio.sourceSection')}>
          {sourceOptions.map((o) => (
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
        <p className="px-1 text-[var(--color-ink-2)] text-[0.7rem] leading-relaxed">{t('audio.sourceHint')}</p>
      </section>

      <SettingsGroup title={t('audio.inputDevice')}>
        {isMix ? (
          <>
            <DeviceRow
              icon="waveform"
              title={t('permissions.mic')}
              label={t('audio.micDevice')}
              devices={mixMicDevices}
              value={mixMicDevice}
              source={AudioSourceKind.Mic}
              capturing={capturing}
              previewing={previewing}
              onChange={setMixMicDevice}
              onOpenChange={(open) => setOpenMenu(open ? 'mic' : null)}
              onRefresh={() => void refreshDevices()}
            />
            <DeviceRow
              icon="speaker"
              title={t('audio.sourceLoopbackLabel')}
              label={t('audio.systemDevice')}
              devices={mixSystemDevices}
              value={mixSystemDevice}
              source={AudioSourceKind.Loopback}
              capturing={capturing}
              previewing={previewing}
              onChange={setMixSystemDevice}
              onOpenChange={(open) => setOpenMenu(open ? 'system' : null)}
              onRefresh={() => void refreshDevices()}
            />
          </>
        ) : (
          <DeviceRow
            icon="waveform"
            title={t('audio.inputDevice')}
            label={t('audio.inputDevice')}
            devices={devices}
            value={device}
            source={audioSource}
            capturing={capturing}
            previewing={previewing}
            onChange={setDevice}
            onOpenChange={(open) => setOpenMenu(open ? 'single' : null)}
            onRefresh={() => void refreshDevices()}
          />
        )}
      </SettingsGroup>

      {capturing && <p className="text-[var(--color-ink-2)] text-[0.7rem]">{t('audio.captureHint')}</p>}
    </Page>
  )
}

function DeviceRow({
  icon,
  title,
  label,
  devices,
  value,
  source,
  capturing,
  previewing,
  onChange,
  onOpenChange,
  onRefresh,
}: {
  icon: 'waveform' | 'speaker'
  title: string
  label: string
  devices: InputDevice[]
  value: string
  source: AudioSourceKind
  capturing: boolean
  previewing: boolean
  onChange: (id: string) => void
  onOpenChange: (open: boolean) => void
  onRefresh: () => void
}) {
  const { t } = useI18n()
  const selected = devices.find((d) => d.id === value)
  const description = selected ? describeDevice(selected, t) : undefined

  return (
    <SettingsRow
      icon={icon}
      title={title}
      description={description}
      control={
        <div className="flex items-center gap-1.5">
          <DeviceSelect
            label={label}
            devices={devices}
            value={value}
            source={source}
            meter={
              capturing ? (
                <LevelMeter active />
              ) : (
                <DeviceLevelMeter device={value || null} source={source} active={previewing} />
              )
            }
            streaming={previewing}
            onChange={onChange}
            onOpenChange={onOpenChange}
            disabled={capturing}
            className="w-[15rem]"
          />
          <Button icon="refresh" size="sm" onClick={onRefresh}>
            {t('common.refresh')}
          </Button>
        </div>
      }
    />
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
