import { useEffect, useState } from 'react'
import { useStore } from '@/main/store'
import { type ConfigDefaults, configDefaults, TranslateEngine, ZhScript } from '@/shared/ipc'
import {
  MAX_MAX_UTTERANCE_MS,
  MAX_TRAILING_SILENCE_MS,
  MIN_MAX_UTTERANCE_MS,
  MIN_TRAILING_SILENCE_MS,
  TaskStatus,
} from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { Page } from '@/ui/Page'
import { Select } from '@/ui/Select'
import { SettingsGroup, SettingsRow } from '@/ui/Settings'
import { Slider } from '@/ui/Slider'

const ENGINE_OPTIONS = [
  { value: TranslateEngine.LocalNmt, label: '本地离线（opus-mt）' },
  { value: TranslateEngine.Off, label: '关闭（只看原文）' },
  {
    value: TranslateEngine.RemoteApi,
    label: '在线 API',
    unavailableReason: '未接入',
  },
]

const MOCK_OPTION = { value: TranslateEngine.Mock, label: '开发用假引擎' }

const DIRECTIONS = [
  { lang: 'en', script: ZhScript.Simplified, label: '英语 → 简体中文' },
  { lang: 'zh', script: ZhScript.Simplified, label: '简体中文 → 英语' },
  { lang: 'en', script: ZhScript.Traditional, label: '英语 → 繁体中文' },
  { lang: 'zh', script: ZhScript.Traditional, label: '繁体中文 → 英语' },
]

const directionValue = (lang: string, script: ZhScript) => `${lang}:${script}`

const DIRECTION_OPTIONS = DIRECTIONS.map((d) => ({
  value: directionValue(d.lang, d.script),
  label: d.label,
}))

export function TranslatePage() {
  const {
    translateEngine,
    setTranslateEngine,
    sourceLang,
    zhScript,
    setDirection,
    endpoint,
    setEndpoint,
    status,
    pending,
  } = useStore()
  const capturing = status === TaskStatus.Capturing
  const busy = capturing || pending

  const [defaults, setDefaults] = useState<ConfigDefaults | null>(null)
  useEffect(() => {
    configDefaults()
      .then(setDefaults)
      .catch(() => {})
  }, [])

  const [draft, setDraft] = useState(endpoint)
  useEffect(() => setDraft(endpoint), [endpoint])

  return (
    <Page title="翻译">
      {capturing && <Alert tone="info">断句参数仅下次开始转写时生效。</Alert>}

      <SettingsGroup title="引擎">
        <SettingsRow
          icon="translate"
          title="翻译引擎"
          description="本地离线运行，音频与文本不出本机。"
          control={
            <Select
              label="翻译引擎"
              value={translateEngine}
              options={translateEngine === TranslateEngine.Mock ? [...ENGINE_OPTIONS, MOCK_OPTION] : ENGINE_OPTIONS}
              onChange={setTranslateEngine}
              disabled={busy}
            />
          }
        />
        <SettingsRow
          icon="external"
          title="翻译方向"
          description="支持简体/繁体；方向选错时译文会错乱，且不会报错。"
          control={
            <Select
              label="翻译方向"
              value={directionValue(sourceLang, zhScript)}
              options={DIRECTION_OPTIONS}
              onChange={(v) => {
                const d = DIRECTIONS.find((d) => directionValue(d.lang, d.script) === v)
                if (d) setDirection(d.lang, d.script)
              }}
              disabled={busy || translateEngine === TranslateEngine.Off}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup title="断句" footer="段落越长，译文出现越晚。">
        <SettingsRow
          icon="waveform"
          title="说完多久算一句"
          description="调小可让译文更早出现，但句子更碎。"
          control={
            <div className="w-64">
              <Slider
                label="尾部静音"
                value={draft.trailingSilenceMs}
                min={MIN_TRAILING_SILENCE_MS}
                max={MAX_TRAILING_SILENCE_MS}
                step={50}
                format={(v) => `${v} ms`}
                onChange={(v) => setDraft((d) => ({ ...d, trailingSilenceMs: v }))}
                onCommit={(v) => void setEndpoint({ ...draft, trailingSilenceMs: v })}
                defaultValue={defaults?.endpoint.trailingSilenceMs}
                disabled={busy}
              />
            </div>
          }
        />
        <SettingsRow
          icon="alert"
          title="最长一句"
          description="超过此长度强制断句；设得比上一项短会使上一项失效。"
          control={
            <div className="w-64">
              <Slider
                label="最长句"
                value={draft.maxUtteranceMs}
                min={MIN_MAX_UTTERANCE_MS}
                max={MAX_MAX_UTTERANCE_MS}
                step={500}
                format={(v) => `${(v / 1000).toFixed(1)} s`}
                onChange={(v) => setDraft((d) => ({ ...d, maxUtteranceMs: v }))}
                onCommit={(v) => void setEndpoint({ ...draft, maxUtteranceMs: v })}
                defaultValue={defaults?.endpoint.maxUtteranceMs}
                disabled={busy}
              />
            </div>
          }
        />
        <SettingsRow
          icon="chip"
          title="预设"
          control={
            <div className="flex gap-1.5">
              <button
                type="button"
                disabled={busy || !defaults}
                onClick={() => defaults && void setEndpoint(defaults.endpointProfiles.interpretation)}
                className="rounded-[var(--radius-ctl)] border border-[var(--color-border-subtle)] px-2 py-1 text-[var(--color-ink-1)] text-xs transition hover:bg-[var(--color-surface-2)] disabled:opacity-40"
              >
                同传
              </button>
              <button
                type="button"
                disabled={busy || !defaults}
                onClick={() => defaults && void setEndpoint(defaults.endpointProfiles.dictation)}
                className="rounded-[var(--radius-ctl)] border border-[var(--color-border-subtle)] px-2 py-1 text-[var(--color-ink-1)] text-xs transition hover:bg-[var(--color-surface-2)] disabled:opacity-40"
              >
                听写
              </button>
            </div>
          }
        />
      </SettingsGroup>
    </Page>
  )
}
