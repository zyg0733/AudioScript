import { open } from '@tauri-apps/plugin-dialog'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { dateLabel, fieldClass, panelClass, positionLabel } from '@/main/library/fields'
import { LibraryRecordView } from '@/main/library/LibraryRecordView'
import { formatCmdError, libraryCall, on, sessionStatus } from '@/shared/ipc'
import {
  cancelMediaJob,
  importMediaFile,
  importSubtitleFile,
  type MediaJobInfo,
  mediaJobStatus,
  reprocessMediaRecord,
} from '@/shared/media'
import type { LibraryListing, LibraryReadIssue, LibraryRecord, LibrarySearchHit, LibrarySummary } from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { Button } from '@/ui/Button'
import { cn } from '@/ui/cn'
import { ProgressBar } from '@/ui/ProgressBar'
import { Select } from '@/ui/Select'

const terminalStatuses = new Set(['completed', 'cancelled', 'failed'])
const phaseLabels: Record<string, string> = {
  decoding: '正在解码媒体…',
  uploading: '正在准备音频…',
  queued: '等待处理…',
  recognizing: '正在识别原文…',
  translating: '正在翻译…',
  saving: '正在保存…',
  done: '已完成',
  cancelled: '已取消',
  failed: '处理失败',
}
let rememberedJob: MediaJobInfo | null = null
let mediaController: AbortController | null = null
const jobObservers = new Set<(job: MediaJobInfo | null) => void>()
const handledJobs = new Set<string>()

function publishJob(job: MediaJobInfo | null) {
  rememberedJob = job
  for (const observer of jobObservers) observer(job)
}

export function LibraryPage({ initialRecordId }: { initialRecordId?: string } = {}) {
  const [records, setRecords] = useState<LibrarySummary[]>([])
  const [hits, setHits] = useState<LibrarySearchHit[]>([])
  const [issues, setIssues] = useState<LibraryReadIssue[]>([])
  const [visibleCount, setVisibleCount] = useState(50)
  const [focus, setFocus] = useState<{ segmentId?: string; sequence: number }>({ sequence: 0 })
  const [record, setRecord] = useState<LibraryRecord | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [opening, setOpening] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sourceLang, setSourceLang] = useState<'en' | 'zh'>('en')
  const [translate, setTranslate] = useState(true)
  const [subtitleMediaPath, setSubtitleMediaPath] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [job, setJob] = useState<MediaJobInfo | null>(() => rememberedJob)
  const importLock = useRef(false)
  const queryVersion = useRef(0)
  const openVersion = useRef(0)
  const currentId = useRef<string | null>(null)
  const completed = useRef(handledJobs)
  const queryRef = useRef(query)
  queryRef.current = query
  currentId.current = record?.id ?? null

  const refresh = useCallback(async (search: string) => {
    const version = ++queryVersion.current
    setLoading(true)
    try {
      const result = await libraryCall<LibraryListing>('browse', { query: search.trim() })
      if (version !== queryVersion.current) return
      setRecords(result.records)
      setHits(result.hits)
      setIssues(result.issues)
    } catch (e) {
      if (version === queryVersion.current) setError(`读取资料库失败：${formatCmdError(e)}`)
    } finally {
      if (version === queryVersion.current) setLoading(false)
    }
  }, [])

  const openRecord = useCallback(async (id: string, segmentId?: string) => {
    const version = ++openVersion.current
    setOpening(id)
    setError(null)
    try {
      const result = await libraryCall<LibraryRecord>('get', { id })
      if (version === openVersion.current) {
        setRecord(result)
        setFocus((current) => ({ segmentId, sequence: current.sequence + 1 }))
      }
    } catch (e) {
      if (version === openVersion.current) setError(`打开记录失败：${formatCmdError(e)}`)
    } finally {
      if (version === openVersion.current) setOpening(null)
    }
  }, [])

  useEffect(() => {
    setVisibleCount(50)
    const timer = window.setTimeout(() => void refresh(query), query ? 250 : 0)
    return () => {
      window.clearTimeout(timer)
      queryVersion.current += 1
    }
  }, [query, refresh])

  useEffect(() => {
    if (initialRecordId) void openRecord(initialRecordId)
  }, [initialRecordId, openRecord])

  useEffect(() => {
    if (record?.source.sourceLang === 'en' || record?.source.sourceLang === 'zh')
      setSourceLang(record.source.sourceLang)
  }, [record?.source.sourceLang])

  useEffect(() => {
    jobObservers.add(setJob)
    return () => {
      jobObservers.delete(setJob)
    }
  }, [])

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    on<{ id: string }>('library://changed', (change) => {
      if (disposed) return
      void refresh(queryRef.current)
      if (currentId.current === change.id) {
        void libraryCall<LibraryRecord>('get', { id: change.id })
          .then((next) => {
            if (!disposed)
              setRecord((current) => (current?.id === next.id && current.revision <= next.revision ? next : current))
          })
          .catch(() => {})
      }
    })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch((e) => {
        if (!disposed) setError(`资料库更新订阅失败：${formatCmdError(e)}`)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [refresh])

  useEffect(() => {
    if (!job || terminalStatuses.has(job.status)) return
    let disposed = false
    let timer: number
    const poll = () => {
      mediaJobStatus(job.jobId)
        .then((next) => {
          if (!disposed) {
            setError((current) => (current?.startsWith('读取导入进度失败，正在重试') ? null : current))
            publishJob(next)
          }
        })
        .catch((e) => {
          if (!disposed) {
            setError(`读取导入进度失败，正在重试：${formatCmdError(e)}`)
            timer = window.setTimeout(poll, 1500)
          }
        })
    }
    timer = window.setTimeout(poll, 1000)
    return () => {
      disposed = true
      window.clearTimeout(timer)
    }
  }, [job])

  useEffect(() => {
    if (!job || !terminalStatuses.has(job.status) || completed.current.has(job.jobId)) return
    completed.current.add(job.jobId)
    if (job.status === 'completed' && job.recordId) {
      setNotice(`处理完成，已保存到资料库。${job.error ? ` ${job.error}` : ''}`)
      void refresh(queryRef.current)
      void openRecord(job.recordId)
    } else if (job.status === 'failed') {
      setError(job.error ?? '处理失败，请重试。')
    } else if (job.status === 'cancelled') {
      setNotice('已取消处理。')
    }
  }, [job, openRecord, refresh])

  useEffect(
    () => () => {
      queryVersion.current += 1
      openVersion.current += 1
    },
    [],
  )

  function onChanged(next: LibraryRecord) {
    if (currentId.current === next.id)
      setRecord((current) => (current?.id === next.id && current.revision <= next.revision ? next : current))
    void refresh(queryRef.current)
  }

  function onDeleted(id: string) {
    if (currentId.current === id) {
      setRecord(null)
      currentId.current = null
    }
    setNotice('已删除记录。')
    void refresh(queryRef.current)
  }

  async function chooseSubtitleMedia() {
    try {
      const path = await open({
        multiple: false,
        title: '选择字幕对应的回放媒体',
        filters: [
          { name: '音视频', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'm4v', 'mov', 'webm'] },
        ],
      })
      if (typeof path === 'string') setSubtitleMediaPath(path)
    } catch (e) {
      setError(formatCmdError(e))
    }
  }

  async function startImport(kind: 'media' | 'subtitle') {
    if (importLock.current || (job && !terminalStatuses.has(job.status))) return
    importLock.current = true
    setImporting(true)
    setError(null)
    setNotice(null)
    let abortForImport: AbortController | null = null
    try {
      if (kind === 'media') {
        const session = await sessionStatus()
        if (!session.actions.canStart)
          throw new Error(
            `请先停止转写并等待当前任务完成，再导入音视频。${session.actions.reason ? ` ${session.actions.reason}` : ''}`,
          )
      }
      const path = await open({
        multiple: false,
        title: kind === 'media' ? '导入音视频' : '导入字幕',
        filters:
          kind === 'subtitle'
            ? [{ name: '字幕', extensions: ['srt', 'vtt'] }]
            : [
                {
                  name: '音视频',
                  extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'm4v', 'mov', 'webm'],
                },
              ],
      })
      if (typeof path !== 'string') return
      publishJob(null)
      if (kind === 'subtitle') {
        const imported = await importSubtitleFile(path, {
          sourceLang,
          ...(subtitleMediaPath ? { mediaPath: subtitleMediaPath } : {}),
        })
        setRecord(imported)
        setNotice('字幕已导入并保存。')
        void refresh(queryRef.current)
      } else {
        const abort = new AbortController()
        abortForImport = abort
        mediaController = abort
        const next = await importMediaFile(path, {
          sourceLang,
          translate,
          signal: abort.signal,
          onProgress: publishJob,
        })
        publishJob(next)
      }
    } catch (e) {
      if (abortForImport?.signal.aborted) setNotice('已取消导入。')
      else setError(`导入失败：${formatCmdError(e)}`)
    } finally {
      importLock.current = false
      setImporting(false)
    }
  }

  async function reprocess(id: string, mode: 'transcribe' | 'translate') {
    if (importLock.current || (job && !terminalStatuses.has(job.status))) return
    importLock.current = true
    setImporting(true)
    setError(null)
    const abort = new AbortController()
    mediaController = abort
    try {
      const recordLanguage = record?.source.sourceLang
      if (recordLanguage !== 'en' && recordLanguage !== 'zh')
        throw new Error('请先在记录来源中设置原文语言，再生成精修记录。')
      const session = await sessionStatus()
      if (!session.actions.canStart)
        throw new Error(
          `请先停止转写并等待当前任务完成，再生成精修记录。${session.actions.reason ? ` ${session.actions.reason}` : ''}`,
        )
      const title = `${record?.title ?? '资料'} · ${mode === 'translate' ? '译文精修' : '重新识别'}`
      publishJob(
        await reprocessMediaRecord(id, {
          mode,
          title,
          sourceLang: recordLanguage,
          translate: mode === 'translate' ? true : translate,
          signal: abort.signal,
          onProgress: publishJob,
        }),
      )
    } catch (e) {
      if (abort.signal.aborted) setNotice('已取消精修。')
      else setError(`精修失败：${formatCmdError(e)}`)
    } finally {
      importLock.current = false
      setImporting(false)
    }
  }

  async function cancelJob() {
    mediaController?.abort()
    if (!job) return
    try {
      publishJob(await cancelMediaJob(job.jobId))
    } catch (e) {
      setError(formatCmdError(e))
    }
  }

  const activeJob = importing || Boolean(job && !terminalStatuses.has(job.status))
  const recordHits = useMemo(() => {
    const result = new Map<string, LibrarySearchHit[]>()
    for (const hit of hits) result.set(hit.recordId, [...(result.get(hit.recordId) ?? []), hit])
    return result
  }, [hits])

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-6 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-base">资料库</h2>
          <p className="mt-1 text-[var(--color-ink-2)] text-xs">保存、核对、摘录和回查音视频内容。</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" disabled={activeJob} onClick={() => void startImport('media')}>
            导入音视频
          </Button>
          <Button size="sm" disabled={activeJob} onClick={() => void startImport('subtitle')}>
            导入字幕
          </Button>
        </div>
      </header>
      {error && (
        <Alert tone="error">
          {error}
          <Button
            size="sm"
            className="ml-2"
            onClick={() => {
              setError(null)
              void refresh(queryRef.current)
              if (job && !terminalStatuses.has(job.status))
                void mediaJobStatus(job.jobId)
                  .then(publishJob)
                  .catch((e) => setError(formatCmdError(e)))
            }}
          >
            重新读取
          </Button>
        </Alert>
      )}
      {notice && <Alert tone="info">{notice}</Alert>}
      {issues.length > 0 && (
        <Alert tone="warn" title={`${issues.length} 条记录暂时无法读取`}>
          其余资料可以继续使用，无法读取的原文件已保留。
          <details className="mt-2">
            <summary className="cursor-pointer">查看受影响记录</summary>
            <ul className="mt-2 space-y-1 break-all">
              {issues.map((issue) => (
                <li key={issue.id}>
                  {issue.id}：{issue.error}
                </li>
              ))}
            </ul>
          </details>
        </Alert>
      )}
      <details className={panelClass}>
        <summary className="cursor-pointer text-xs">导入与精修选项</summary>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Select
            label="导入原文语言"
            value={sourceLang}
            onChange={setSourceLang}
            disabled={activeJob}
            options={[
              { value: 'en', label: '英语' },
              { value: 'zh', label: '中文' },
            ]}
          />
          <p className="text-[var(--color-ink-2)] text-xs">精修使用记录中保存的原文语言，可在记录来源中修改。</p>
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={translate}
              disabled={activeJob}
              onChange={(event) => setTranslate(event.target.checked)}
            />
            同时翻译
          </label>
          <Button size="sm" disabled={activeJob} onClick={() => void chooseSubtitleMedia()}>
            为字幕选择回放媒体
          </Button>
          {subtitleMediaPath && (
            <>
              <span className="break-all text-[var(--color-ink-2)] text-xs">{subtitleMediaPath}</span>
              <Button size="sm" disabled={activeJob} onClick={() => setSubtitleMediaPath(null)}>
                取消关联
              </Button>
            </>
          )}
        </div>
      </details>
      {(job || importing) && (
        <div className={`${panelClass} flex flex-wrap items-center gap-3`}>
          <span role="status" className="text-xs">
            {job ? (phaseLabels[job.phase] ?? '正在处理资料…') : '正在准备导入…'}
          </span>
          <ProgressBar value={job?.progress ?? null} label="资料处理进度" />
          {job && <span className="font-mono text-xs">{Math.round(job.progress)}%</span>}
          {job && !terminalStatuses.has(job.status) && (
            <Button size="sm" onClick={() => void cancelJob()}>
              取消处理
            </Button>
          )}
        </div>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside aria-label="最近记录" className={`${panelClass} space-y-3`}>
          <div className="flex items-center justify-between">
            <h3 className="text-sm">最近记录</h3>
            <Button size="sm" variant="ghost" onClick={() => void refresh(queryRef.current)}>
              刷新
            </Button>
          </div>
          <input
            aria-label="搜索资料库"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索原文、译文与笔记"
            className={fieldClass}
          />
          {loading && (
            <p role="status" className="text-[var(--color-ink-2)] text-xs">
              正在读取…
            </p>
          )}
          {!loading && records.length === 0 && (
            <p className="py-4 text-[var(--color-ink-2)] text-xs">
              {query ? '没有匹配记录。' : '暂无保存记录。开始转写或导入文件后，内容将出现在这里。'}
            </p>
          )}
          <ul className="max-h-[68vh] space-y-2 overflow-y-auto">
            {records.slice(0, visibleCount).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => void openRecord(item.id)}
                  aria-current={record?.id === item.id ? 'true' : undefined}
                  className={cn(
                    'w-full rounded-[var(--radius-ctl)] p-2 text-left transition hover:bg-[var(--color-surface-2)]',
                    record?.id === item.id && 'bg-[var(--color-surface-selected)]',
                  )}
                >
                  <span className="block break-words text-sm">{opening === item.id ? '正在打开…' : item.title}</span>
                  <span className="mt-1 block text-[var(--color-ink-2)] text-[11px]">
                    {dateLabel(item.updatedAt)}
                    <br />
                    {item.segmentCount} 段 · {item.bookmarkCount} 个标记
                  </span>
                </button>
                {recordHits.get(item.id)?.map((hit) => (
                  <button
                    key={hit.segmentId}
                    type="button"
                    className="mt-1 block w-full rounded-[var(--radius-ctl)] border-[var(--color-border-subtle)] border-l-2 p-2 text-left text-xs hover:bg-[var(--color-surface-2)]"
                    aria-label={`定位${hit.field} ${positionLabel(hit.startMs)}`}
                    onClick={() => void openRecord(item.id, hit.segmentId)}
                  >
                    <span className="text-[var(--color-ink-2)]">
                      {hit.field} · {positionLabel(hit.startMs)}
                    </span>
                    <span className="mt-1 block whitespace-pre-wrap break-words">{hit.excerpt}</span>
                  </button>
                ))}
              </li>
            ))}
          </ul>
          {records.length > visibleCount && (
            <Button size="sm" onClick={() => setVisibleCount((count) => count + 50)}>
              查看更多（剩余 {records.length - visibleCount} 条）
            </Button>
          )}
        </aside>
        {record ? (
          <LibraryRecordView
            key={record.id}
            record={record}
            initialSegmentId={focus.segmentId}
            focusSequence={focus.sequence}
            onChanged={onChanged}
            onDeleted={onDeleted}
            onReprocess={(id, mode) => void reprocess(id, mode)}
            reprocessing={activeJob}
          />
        ) : (
          <section className={`${panelClass} py-16 text-center text-[var(--color-ink-2)] text-sm`}>
            选择一条记录，或导入音视频与字幕开始整理。
          </section>
        )}
      </div>
    </div>
  )
}
