export const fieldClass =
  'w-full rounded-[var(--radius-ctl)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-0)] px-3 py-2 text-[var(--color-ink-0)] text-sm disabled:opacity-50'

export const panelClass =
  'rounded-[var(--radius-panel)] border border-[var(--color-border-subtle)] bg-[var(--color-surface-1)] p-4'

export function positionLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function dateLabel(value: number | string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false })
}
