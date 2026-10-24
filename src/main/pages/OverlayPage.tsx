import { useEffect, useRef, useState } from 'react'
import { useStore } from '@/main/store'
import { formatCmdError, type OverlayConfig, shortcutsSet } from '@/shared/ipc'
import { isMacOS } from '@/shared/platform'
import { MAX_FONT_SIZE, MAX_OVERLAY_LINES, MIN_FONT_SIZE, OverlayMode } from '@/shared/types'
import { Button } from '@/ui/Button'
import { Page } from '@/ui/Page'
import { Select } from '@/ui/Select'
import { SettingsGroup, SettingsRow } from '@/ui/Settings'
import { ShortcutRecorder } from '@/ui/ShortcutRecorder'
import { Slider } from '@/ui/Slider'
import { Switch } from '@/ui/Switch'

export function OverlayPage() {
  const { overlayCfg, overlayVisible, toggleOverlay, updateOverlay, hotkeys, refreshHotkeys, setError } = useStore()

  const [draft, setDraft] = useState<OverlayConfig | null>(overlayCfg)
  useEffect(() => setDraft(overlayCfg), [overlayCfg])

  if (!overlayCfg || !draft) {
    return (
      <Page title="悬浮窗">
        <p className="text-[var(--color-ink-2)] text-sm">读取配置中…</p>
      </Page>
    )
  }

  async function rebind(id: string, accelerator: string) {
    try {
      await shortcutsSet(id, accelerator)
      await refreshHotkeys()
    } catch (e) {
      setError(formatCmdError(e))
    }
  }

  return (
    <Page title="悬浮窗">
      <SettingsGroup title="显示">
        <SettingsRow
          icon="overlay"
          title={overlayVisible ? '隐藏悬浮窗' : '显示悬浮窗'}
          control={<Button onClick={() => void toggleOverlay()}>{overlayVisible ? '隐藏' : '显示'}</Button>}
        />
        <SettingsRow
          icon="keyboard"
          title="交互模式"
          description={
            overlayCfg.mode === OverlayMode.Locked
              ? '鼠标完全穿透，仅能通过快捷键或托盘菜单操作。'
              : '可拖动、缩放、选中文字，会遮挡下层操作。'
          }
          control={
            <Select
              label="交互模式"
              value={overlayCfg.mode}
              options={[
                { value: OverlayMode.Locked, label: '锁定（穿透）' },
                { value: OverlayMode.Edit, label: '编辑' },
              ]}
              onChange={(v) => void updateOverlay({ mode: v })}
            />
          }
        />
        <SettingsRow
          icon="check"
          title="始终置顶"
          unavailableReason={isMacOS ? 'macOS 上强制开启。' : undefined}
          control={<span className="text-[var(--color-ink-2)] text-xs">已开启</span>}
        />
      </SettingsGroup>

      <SettingsGroup title="快捷键" footer="仅支持「修饰键 + 单键」组合，该类组合在 macOS 上无需辅助功能权限。">
        {hotkeys.length === 0 ? (
          <SettingsRow title="读取中…" />
        ) : (
          hotkeys.map((h) => (
            <SettingsRow
              key={h.id}
              icon="keyboard"
              title={h.label}
              description={
                h.registered ? (
                  h.customized ? (
                    '已改过键位'
                  ) : undefined
                ) : (
                  <span className="text-[var(--color-warn)]">注册失败，可能已被其他应用占用</span>
                )
              }
              control={<ShortcutRecorder pretty={h.acceleratorPretty} onRecord={(accel) => void rebind(h.id, accel)} />}
            />
          ))
        )}
      </SettingsGroup>

      <SettingsGroup title="外观" footer="仅背景透明，文字始终不透明。">
        <SettingsRow
          icon="waveform"
          title="字号"
          control={
            <div className="w-56">
              <Slider
                label="字号"
                value={draft.fontSize}
                min={MIN_FONT_SIZE}
                max={MAX_FONT_SIZE}
                format={(v) => `${v} px`}
                onChange={(v) => setDraft((d) => (d ? { ...d, fontSize: v } : d))}
                onCommit={(v) => void updateOverlay({ fontSize: v })}
              />
            </div>
          }
        />
        <SettingsRow
          icon="overlay"
          title="背景不透明度"
          description="过高会遮挡画面。"
          control={
            <div className="w-56">
              <Slider
                label="背景不透明度"
                value={draft.opacity}
                min={0}
                max={100}
                format={(v) => `${v}%`}
                onChange={(v) => setDraft((d) => (d ? { ...d, opacity: v } : d))}
                onCommit={(v) => void updateOverlay({ opacity: v })}
              />
            </div>
          }
        />
        <SettingsRow
          icon="translate"
          title="显示行数"
          description="超出部分不可见。"
          control={
            <div className="w-56">
              <Slider
                label="显示行数"
                value={draft.maxLines}
                min={1}
                max={MAX_OVERLAY_LINES}
                format={(v) => `${v} 行`}
                onChange={(v) => setDraft((d) => (d ? { ...d, maxLines: v } : d))}
                onCommit={(v) => void updateOverlay({ maxLines: v })}
              />
            </div>
          }
        />
        <SettingsRow
          icon="brush"
          title="文字颜色"
          control={<ColorField value={overlayCfg.fontColor} onCommit={(v) => void updateOverlay({ fontColor: v })} />}
        />
        <SettingsRow
          icon="sparkle"
          title="彩虹边框"
          control={
            <Switch label="彩虹边框" checked={overlayCfg.glow} onChange={(v) => void updateOverlay({ glow: v })} />
          }
        />
        <SettingsRow
          icon="swatch"
          title="背景颜色"
          control={<ColorField value={overlayCfg.bgColor} onCommit={(v) => void updateOverlay({ bgColor: v })} />}
        />
      </SettingsGroup>
    </Page>
  )
}

const COLOR_COMMIT_DELAY_MS = 150

function ColorField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [local, setLocal] = useState(value)
  const timer = useRef<number | null>(null)
  const latest = useRef(value)
  const commit = useRef(onCommit)

  useEffect(() => {
    commit.current = onCommit
  })

  useEffect(() => {
    if (timer.current === null) setLocal(value)
  }, [value])

  useEffect(
    () => () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        commit.current(latest.current)
      }
    },
    [],
  )

  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label="颜色"
        value={local}
        onChange={(e) => {
          const next = e.target.value
          latest.current = next
          setLocal(next)
          if (timer.current !== null) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => {
            timer.current = null
            commit.current(latest.current)
          }, COLOR_COMMIT_DELAY_MS)
        }}
        className="h-6 w-12 cursor-pointer rounded-[var(--radius-ctl)] border border-[var(--color-border-subtle)] bg-transparent p-0"
      />
      <span className="font-mono text-[var(--color-ink-2)] text-xs">{local}</span>
    </div>
  )
}
