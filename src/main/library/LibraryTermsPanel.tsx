import { useEffect, useRef, useState } from 'react'
import { formatCmdError, libraryCall } from '@/shared/ipc'
import type { LibraryRecord, Term, TermSuggestion } from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { Button } from '@/ui/Button'
import { fieldClass, panelClass } from './fields'

export function LibraryTermsPanel({
  record,
  segmentIds,
  onChanged,
  onLocate,
}: {
  record: LibraryRecord
  segmentIds?: string[]
  onChanged: (record: LibraryRecord) => void
  onLocate: (id: string) => void
}) {
  const [terms, setTerms] = useState<Term[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [target, setTarget] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [suggestions, setSuggestions] = useState<{ revision: number; items: TermSuggestion[] } | null>(null)

  async function checkTerms() {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      const items = await libraryCall<TermSuggestion[]>('terms_suggest', {
        id: record.id,
        ...(segmentIds ? { segmentIds } : {}),
      })
      setSuggestions({ revision: record.revision, items })
    } catch (e) {
      setError(formatCmdError(e))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  async function applyTerm(suggestion: TermSuggestion) {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      const next = await libraryCall<LibraryRecord>('terms_apply', {
        id: record.id,
        segmentId: suggestion.segmentId,
        termId: suggestion.termId,
        expectedRevision: suggestion.expectedRevision,
        expectedTermUpdatedAt: suggestion.termUpdatedAt,
      })
      onChanged(next)
      const items = await libraryCall<TermSuggestion[]>('terms_suggest', {
        id: record.id,
        ...(segmentIds ? { segmentIds } : {}),
      })
      setSuggestions({ revision: next.revision, items })
    } catch (e) {
      setError(formatCmdError(e))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  async function refresh() {
    try {
      setTerms(await libraryCall<Term[]>('terms_list'))
      setError(null)
    } catch (e) {
      setError(formatCmdError(e))
    }
  }

  useEffect(() => {
    let disposed = false
    libraryCall<Term[]>('terms_list')
      .then((result) => {
        if (!disposed) setTerms(result)
      })
      .catch((e) => {
        if (!disposed) setError(formatCmdError(e))
      })
    return () => {
      disposed = true
    }
  }, [])

  function reset() {
    setEditing(null)
    setSource('')
    setTarget('')
    setNote('')
  }

  async function saveTerm() {
    if (pendingRef.current || !source.trim() || !target.trim()) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      const saved = await libraryCall<Term>('terms_upsert', {
        term: { ...(editing ? { id: editing } : {}), source: source.trim(), target: target.trim(), note: note.trim() },
      })
      setTerms((current) => [...current.filter((term) => term.id !== saved.id), saved])
      setSuggestions(null)
      reset()
    } catch (e) {
      setError(formatCmdError(e))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  async function removeTerm(id: string) {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      await libraryCall('terms_delete', { id })
      setTerms((current) => current.filter((term) => term.id !== id))
      setSuggestions(null)
      if (editing === id) reset()
    } catch (e) {
      setError(formatCmdError(e))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  return (
    <section aria-label="个人术语表" className="space-y-4">
      <p className="text-[var(--color-ink-2)] text-xs">维护专业词汇的原文、译法和备注。</p>
      {error && (
        <Alert tone="error">
          {error}
          <Button size="sm" onClick={() => void refresh()} className="ml-2">
            重新读取
          </Button>
        </Alert>
      )}
      <div className={`${panelClass} space-y-3`}>
        <h3 className="text-sm">译后术语校正</h3>
        <p className="text-[var(--color-ink-2)] text-xs">
          检查原文命中的术语与现有译文，逐项核对并应用惯用译法。每次应用都会保留历史版本。
        </p>
        <Button size="sm" disabled={pending} onClick={() => void checkTerms()}>
          {pending ? '正在处理…' : segmentIds ? '检查所选片段术语' : '检查本记录术语'}
        </Button>
        {suggestions && suggestions.revision !== record.revision && (
          <p className="text-[var(--color-warn)] text-xs">记录已更新，请重新检查术语建议。</p>
        )}
        {suggestions &&
          suggestions.revision === record.revision &&
          (suggestions.items.length === 0 ? (
            <p role="status" className="text-[var(--color-ink-2)] text-xs">
              本次检查没有需要校正的译文。
            </p>
          ) : (
            <ul className="space-y-3">
              {suggestions.items.map((suggestion) => (
                <li
                  key={`${suggestion.segmentId}:${suggestion.termId}`}
                  className="space-y-2 rounded bg-[var(--color-surface-0)] p-3 text-xs"
                >
                  <p>
                    {suggestion.source} → {suggestion.target}
                  </p>
                  <p className="whitespace-pre-wrap text-[var(--color-ink-2)]">
                    原译文：{suggestion.originalTranslation}
                  </p>
                  <p className="whitespace-pre-wrap">建议译文：{suggestion.suggestedTranslation}</p>
                  <p className="text-[var(--color-ink-2)]">{suggestion.explanation}</p>
                  <div className="flex gap-2">
                    <Button size="sm" disabled={pending} onClick={() => void applyTerm(suggestion)}>
                      应用此处校正
                    </Button>
                    <Button size="sm" onClick={() => onLocate(suggestion.segmentId)}>
                      查看原文
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void saveTerm()
        }}
        className={`${panelClass} space-y-3`}
      >
        <fieldset disabled={pending} className="m-0 space-y-3 border-0 p-0">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs">
              原文术语
              <input
                aria-label="原文术语"
                value={source}
                onChange={(event) => setSource(event.target.value)}
                className={fieldClass}
                required
              />
            </label>
            <label className="space-y-1 text-xs">
              惯用译法
              <input
                aria-label="惯用译法"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                className={fieldClass}
                required
              />
            </label>
          </div>
          <label className="block space-y-1 text-xs">
            术语备注
            <input
              aria-label="术语备注"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className={fieldClass}
            />
          </label>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!source.trim() || !target.trim()}
              onClick={() => void saveTerm()}
            >
              {pending ? '保存中…' : editing ? '保存术语' : '添加术语'}
            </Button>
            {editing && (
              <Button size="sm" onClick={reset}>
                取消编辑
              </Button>
            )}
          </div>
        </fieldset>
      </form>
      {terms.length === 0 ? (
        <p className="py-4 text-[var(--color-ink-2)] text-sm">暂无术语，添加常见的专业词汇和译法。</p>
      ) : (
        <ul className="space-y-2">
          {terms.map((term) => (
            <li key={term.id} className={`${panelClass} flex items-start gap-3`}>
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm">
                  {term.source}
                  <span className="px-2 text-[var(--color-ink-2)]">→</span>
                  {term.target}
                </p>
                {term.note && <p className="mt-1 text-[var(--color-ink-2)] text-xs">{term.note}</p>}
              </div>
              <Button
                size="sm"
                disabled={pending}
                onClick={() => {
                  setEditing(term.id)
                  setSource(term.source)
                  setTarget(term.target)
                  setNote(term.note ?? '')
                }}
              >
                编辑
              </Button>
              <Button size="sm" disabled={pending} onClick={() => void removeTerm(term.id)}>
                删除
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
