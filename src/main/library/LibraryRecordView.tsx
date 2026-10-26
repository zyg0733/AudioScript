import { save } from '@tauri-apps/plugin-dialog'
import { useEffect, useMemo, useRef, useState } from 'react'
import { copyText, formatSegmentText } from '@/shared/clipboard'
import { formatCmdError, libraryCall, revealPath } from '@/shared/ipc'
import { type LibraryAnalysis, type LibraryAnswer, type LibraryRecord, TranslationState } from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { Button } from '@/ui/Button'
import { cn } from '@/ui/cn'
import { Select } from '@/ui/Select'
import { dateLabel, fieldClass, panelClass, positionLabel } from './fields'
import { LibraryMediaPlayer, type PlaybackTarget } from './LibraryMediaPlayer'
import { LibraryTermsPanel } from './LibraryTermsPanel'

type Entry = LibraryRecord['segments'][number]
type Tab = 'transcript' | 'understanding' | 'terms'

interface Props {
  record: LibraryRecord
  onChanged: (record: LibraryRecord) => void
  onDeleted: (id: string) => void
  onReprocess: (id: string, mode: 'transcribe' | 'translate') => void
  reprocessing: boolean
}

export function LibraryRecordView({ record, onChanged, onDeleted, onReprocess, reprocessing }: Props) {
  const [tab, setTab] = useState<Tab>('transcript')
  const [title, setTitle] = useState(record.title)
  const [sourceLabel, setSourceLabel] = useState(record.source.label)
  const [sourceUrl, setSourceUrl] = useState(record.source.url ?? '')
  const [sourceEditing, setSourceEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, setPending] = useState<string | null>(null)
  const pendingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [bookmarksOnly, setBookmarksOnly] = useState(false)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [exportFormat, setExportFormat] = useState<'markdown' | 'srt' | 'vtt'>('markdown')
  const [bookmarkVersions, setBookmarkVersions] = useState(false)
  const [analysis, setAnalysis] = useState<LibraryAnalysis | null>(null)
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<LibraryAnswer | null>(null)
  const [playback, setPlayback] = useState<PlaybackTarget | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const sequence = useRef(0)

  useEffect(() => setTitle(record.title), [record.title])
  useEffect(() => {
    setSourceLabel(record.source.label)
    setSourceUrl(record.source.url ?? '')
  }, [record.source.label, record.source.url])
  // biome-ignore lint/correctness/useExhaustiveDependencies: 记录修订后原文证据需要重新生成。
  useEffect(() => {
    setAnalysis(null)
    setAnswer(null)
  }, [record.revision])

  async function perform(key: string, operation: () => Promise<void>): Promise<boolean> {
    if (pendingRef.current) return false
    pendingRef.current = true
    setPending(key)
    setError(null)
    setNotice(null)
    try {
      await operation()
      return true
    } catch (e) {
      setError(formatCmdError(e))
      return false
    } finally {
      pendingRef.current = false
      setPending(null)
    }
  }

  function mutate(action: string, args: Record<string, unknown>): Promise<boolean> {
    return perform(action, async () => {
      onChanged(await libraryCall<LibraryRecord>(action, { id: record.id, ...args }))
      setNotice('已保存到本机')
    })
  }

  function updateEntry(entry: Entry, patch: Record<string, unknown>): Promise<boolean> {
    return mutate('segment_update', { segmentId: entry.segment.id, expectedRevision: entry.segment.revision, ...patch })
  }

  function retranslate(ids: string[]) {
    return perform('retranslate', async () => {
      for (let start = 0; start < ids.length; start += 50) {
        const next = await libraryCall<LibraryRecord>('retranslate', {
          id: record.id,
          segmentIds: ids.slice(start, start + 50),
        })
        onChanged(next)
      }
      setNotice('译文处理完成，请核查各段结果。')
    })
  }

  function jump(entry: Entry['segment'], play = false) {
    setTab('transcript')
    setBookmarksOnly(false)
    setQuery('')
    setFocused(entry.id)
    const index = record.segments.findIndex((value) => value.segment.id === entry.id)
    setPage(Math.floor(Math.max(0, index) / 100) + 1)
    setPlayback({ startMs: entry.startMs, endMs: entry.endMs, play, sequence: ++sequence.current })
  }

  useEffect(() => {
    if (tab !== 'transcript' || !focused || playback?.sequence === undefined) return
    const element = document.getElementById(`library-segment-${focused}`)
    element?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }, [focused, tab, playback?.sequence])

  async function exportRecord() {
    await perform('export', async () => {
      const extension = exportFormat === 'markdown' ? 'md' : exportFormat
      const path = await save({
        defaultPath: `${record.title.replace(/[\\/:*?"<>|]/g, '-')}${selected.size ? '-摘录' : ''}.${extension}`,
        filters: [{ name: exportFormat === 'markdown' ? 'Markdown' : '字幕', extensions: [extension] }],
      })
      if (!path) return
      const result = await libraryCall<{ path: string }>('export', {
        id: record.id,
        path,
        format: exportFormat,
        ...(selected.size ? { segmentIds: [...selected] } : {}),
        useBookmarkVersions: bookmarkVersions,
      })
      setNotice(`已保存：${result.path}`)
      try {
        await revealPath(result.path)
      } catch {
        setNotice(`已保存：${result.path}。暂时无法打开所在位置。`)
      }
    })
  }

  const needle = query.trim().toLocaleLowerCase()
  const visible = record.segments.filter(
    (entry) =>
      (!bookmarksOnly || entry.bookmarked) &&
      (!needle ||
        [entry.segment.text, entry.segment.translation, entry.note].some((text) =>
          text?.toLocaleLowerCase().includes(needle),
        )),
  )
  const busy = pending !== null
  const mediaPath = record.source.mediaPath
  const pages = Math.max(1, Math.ceil(visible.length / 100))
  const currentPage = Math.min(page, pages)
  const shown = visible.slice((currentPage - 1) * 100, currentPage * 100)
  const segments = useMemo(() => record.segments.map((entry) => entry.segment), [record.segments])
  const positions = useMemo(
    () => new Map(record.segments.map((entry, index) => [entry.segment.id, index])),
    [record.segments],
  )

  return (
    <section aria-label="资料工作区" className="min-w-0 space-y-4">
      {error && (
        <Alert tone="error" title="操作未完成">
          {error}
          <Button
            size="sm"
            className="ml-2"
            disabled={busy}
            onClick={() =>
              void perform('reload', async () => onChanged(await libraryCall<LibraryRecord>('get', { id: record.id })))
            }
          >
            重新读取记录
          </Button>
        </Alert>
      )}
      {notice && <Alert tone="info">{notice}</Alert>}
      <div className={`${panelClass} space-y-3`}>
        <div className="flex items-start gap-2">
          <input
            aria-label="记录标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className={`${fieldClass} min-w-0 flex-1 font-semibold`}
            disabled={busy}
          />
          <Button
            size="sm"
            className="shrink-0 whitespace-nowrap"
            disabled={busy || !title.trim() || title.trim() === record.title}
            onClick={() => void mutate('rename', { title: title.trim() })}
          >
            保存标题
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[var(--color-ink-2)] text-xs">
          <span>
            {dateLabel(record.createdAt)} · {record.segments.length} 段
          </span>
          <span className="break-all">{record.source.label}</span>
          <Button size="sm" variant="ghost" onClick={() => setSourceEditing((value) => !value)}>
            来源
          </Button>
          <Button size="sm" disabled={busy || reprocessing} onClick={() => onReprocess(record.id, 'translate')}>
            译文另存精修版
          </Button>
          {mediaPath && (
            <Button size="sm" disabled={busy || reprocessing} onClick={() => onReprocess(record.id, 'transcribe')}>
              重新识别
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            {confirmDelete ? (
              <>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() =>
                    void perform('delete', async () => {
                      await libraryCall('delete', { id: record.id })
                      onDeleted(record.id)
                    })
                  }
                >
                  确认删除
                </Button>
                <Button size="sm" disabled={busy} onClick={() => setConfirmDelete(false)}>
                  取消
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={busy} onClick={() => setConfirmDelete(true)}>
                删除记录
              </Button>
            )}
          </div>
        </div>
        <p className="text-[var(--color-ink-2)] text-xs">精修使用当前已选模型生成新记录，原记录保留。</p>
        {sourceEditing && (
          <fieldset disabled={busy} className="m-0 space-y-2 border-0 p-0">
            <input
              aria-label="来源名称"
              value={sourceLabel}
              onChange={(event) => setSourceLabel(event.target.value)}
              className={fieldClass}
              placeholder="课程或文件名称"
            />
            <input
              aria-label="来源链接"
              type="url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              className={fieldClass}
              placeholder="https://…（可选）"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                disabled={!sourceLabel.trim()}
                onClick={() =>
                  void mutate('source_update', { label: sourceLabel.trim(), url: sourceUrl.trim() || null })
                }
              >
                保存来源
              </Button>
              {record.source.url && (
                <Button
                  size="sm"
                  onClick={() =>
                    void perform('copy-source', async () => {
                      await copyText(record.source.url ?? '')
                      setNotice('已复制来源链接')
                    })
                  }
                >
                  复制来源链接
                </Button>
              )}
            </div>
            {record.source.kind === 'live' && (
              <p className="text-[var(--color-ink-2)] text-xs">
                时间为本次采集的相对位置；来源链接用于回查，不代表播放器中的绝对进度。
              </p>
            )}
          </fieldset>
        )}
      </div>

      {mediaPath && <LibraryMediaPlayer path={mediaPath} segments={segments} target={playback} />}

      <nav aria-label="资料内容" className="flex gap-2 border-[var(--color-border-subtle)] border-b pb-3">
        {(
          [
            { id: 'transcript', label: '原文与摘录' },
            { id: 'understanding', label: '章节与问答' },
            { id: 'terms', label: '个人术语表' },
          ] as const
        ).map((item) => (
          <Button
            key={item.id}
            size="sm"
            variant={tab === item.id ? 'primary' : 'ghost'}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </Button>
        ))}
      </nav>

      {tab === 'terms' && (
        <LibraryTermsPanel
          record={record}
          segmentIds={selected.size ? [...selected] : undefined}
          onChanged={onChanged}
          onLocate={(id) => {
            const entry = record.segments.find((value) => value.segment.id === id)
            if (entry) jump(entry.segment)
          }}
        />
      )}
      {tab === 'understanding' && (
        <div className="space-y-4">
          <p className="text-[var(--color-ink-2)] text-xs">
            根据保存的原文提取章节和要点，并检索问题相关片段。点击引用回到原文核查。
          </p>
          <Button
            size="sm"
            disabled={busy || record.segments.length === 0}
            onClick={() =>
              void perform('analyze', async () =>
                setAnalysis(await libraryCall<LibraryAnalysis>('analyze', { id: record.id })),
              )
            }
          >
            {pending === 'analyze' ? '整理中…' : '整理章节与要点'}
          </Button>
          {analysis && (
            <div className="space-y-3">
              <p className="text-[var(--color-ink-2)] text-xs">{analysis.notice}</p>
              <h3 className="text-sm">章节</h3>
              {analysis.chapters.map((chapter) => (
                <div key={`${chapter.startMs}-${chapter.segmentIds.join(':')}`} className={panelClass}>
                  <p className="text-sm">{chapter.title}</p>
                  <References ids={chapter.segmentIds} record={record} onJump={jump} />
                </div>
              ))}
              <h3 className="text-sm">原文要点</h3>
              {analysis.points.map((point) => (
                <div key={`${point.startMs}-${point.text}`} className={panelClass}>
                  <p className="text-sm leading-relaxed">{point.text}</p>
                  <References ids={point.segmentIds} record={record} onJump={jump} />
                </div>
              ))}
            </div>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (question.trim())
                void perform('ask', async () =>
                  setAnswer(await libraryCall<LibraryAnswer>('ask', { id: record.id, question: question.trim() })),
                )
            }}
            className={`${panelClass} space-y-3`}
          >
            <label className="block space-y-1 text-xs">
              检索问题
              <input
                aria-label="检索问题"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="例如：这里如何解释内存管理？"
                className={fieldClass}
                disabled={busy}
              />
            </label>
            <Button
              size="sm"
              disabled={busy || !question.trim()}
              onClick={() =>
                void perform('ask', async () =>
                  setAnswer(await libraryCall<LibraryAnswer>('ask', { id: record.id, question: question.trim() })),
                )
              }
            >
              {pending === 'ask' ? '查找中…' : '查找原文依据'}
            </Button>
          </form>
          {answer && (
            <div className={`${panelClass} space-y-3`}>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{answer.answer}</p>
              {answer.evidence.map((evidence) => (
                <blockquote key={evidence.segmentId} className="border-[var(--color-accent)] border-l-2 pl-3 text-sm">
                  <p>{evidence.text}</p>
                  {evidence.translation && <p className="mt-1 text-[var(--color-ink-1)]">{evidence.translation}</p>}
                  <References ids={[evidence.segmentId]} record={record} onJump={jump} />
                </blockquote>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'transcript' && (
        <div className="space-y-3">
          <input
            aria-label="在当前记录中查找"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setPage(1)
            }}
            placeholder="查找原文、译文与笔记"
            className={fieldClass}
          />
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={bookmarksOnly}
                onChange={(event) => {
                  setBookmarksOnly(event.target.checked)
                  setPage(1)
                }}
              />
              只看标记
            </label>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelected(new Set(visible.map((entry) => entry.segment.id)))}
            >
              选择当前结果
            </Button>
            <Button size="sm" variant="ghost" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
              取消选择
            </Button>
            <span className="text-[var(--color-ink-2)]">已选 {selected.size} 段</span>
          </div>
          <div className={`${panelClass} flex flex-wrap items-center gap-2`}>
            <Select
              label="导出格式"
              value={exportFormat}
              onChange={setExportFormat}
              options={[
                { value: 'markdown', label: 'Markdown 摘录' },
                { value: 'srt', label: 'SRT 字幕' },
                { value: 'vtt', label: 'WebVTT 字幕' },
              ]}
              disabled={busy}
            />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={bookmarkVersions}
                onChange={(event) => setBookmarkVersions(event.target.checked)}
                disabled={busy}
              />
              使用标记时的版本
            </label>
            <Button
              size="sm"
              icon="download"
              disabled={busy || record.segments.length === 0}
              onClick={() => void exportRecord()}
            >
              {pending === 'export' ? '导出中…' : selected.size ? '导出所选摘录' : '导出全部'}
            </Button>
            <Button
              size="sm"
              disabled={busy || record.segments.length === 0}
              onClick={() =>
                void retranslate(selected.size ? [...selected] : record.segments.map((entry) => entry.segment.id))
              }
            >
              {pending === 'retranslate' ? '正在翻译…' : selected.size ? '重新翻译所选段' : '重新翻译全部'}
            </Button>
            <Button
              size="sm"
              disabled={busy || record.segments.length === 0}
              onClick={() =>
                void perform('copy-all', async () => {
                  const text = record.segments
                    .filter((entry) => selected.size === 0 || selected.has(entry.segment.id))
                    .map((entry) => formatSegmentText(entry.segment, 'bilingual'))
                    .filter(Boolean)
                    .join('\n\n')
                  await copyText(text)
                  setNotice(selected.size ? '已复制所选摘录' : '已复制全文')
                })
              }
            >
              {selected.size ? '复制所选' : '复制全文'}
            </Button>
          </div>
          {visible.length === 0 && (
            <p className="py-6 text-center text-[var(--color-ink-2)] text-sm">没有匹配的片段。</p>
          )}
          {pages > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-[var(--color-ink-2)]">共 {visible.length} 段，每页 100 段</span>
              <Select
                label="片段页码"
                value={String(currentPage)}
                onChange={(value) => setPage(Number(value))}
                options={Array.from({ length: pages }, (_, index) => ({
                  value: String(index + 1),
                  label: `第 ${index + 1} 页`,
                }))}
              />
              <Button size="sm" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>
                上一页
              </Button>
              <Button size="sm" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>
                下一页
              </Button>
            </div>
          )}
          <ol className="space-y-3">
            {shown.map((entry) => (
              <LibraryEntry
                key={entry.segment.id}
                entry={entry}
                index={positions.get(entry.segment.id) ?? 0}
                selected={selected.has(entry.segment.id)}
                focused={focused === entry.segment.id}
                busy={busy}
                media={Boolean(mediaPath)}
                onSelect={(value) =>
                  setSelected((current) => {
                    const next = new Set(current)
                    if (value) next.add(entry.segment.id)
                    else next.delete(entry.segment.id)
                    return next
                  })
                }
                onJump={(play) => jump(entry.segment, play)}
                onUpdate={(patch) => updateEntry(entry, patch)}
                onRestore={(versionRevision) =>
                  mutate('history_restore', {
                    segmentId: entry.segment.id,
                    versionRevision,
                    expectedRevision: entry.segment.revision,
                  })
                }
                onRetranslate={() => void retranslate([entry.segment.id])}
                onCopy={() =>
                  void perform('copy-segment', async () => {
                    await copyText(formatSegmentText(entry.segment, 'bilingual'))
                    setNotice('已复制本段双语内容')
                  })
                }
              />
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

function References({
  ids,
  record,
  onJump,
}: {
  ids: string[]
  record: LibraryRecord
  onJump: (segment: Entry['segment']) => void
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {ids.map((id) => {
        const entry = record.segments.find((value) => value.segment.id === id)
        return entry ? (
          <Button key={id} size="sm" variant="ghost" onClick={() => onJump(entry.segment)}>
            原文 {positionLabel(entry.segment.startMs)}
          </Button>
        ) : null
      })}
    </div>
  )
}

function LibraryEntry({
  entry,
  index,
  selected,
  focused,
  busy,
  media,
  onSelect,
  onJump,
  onUpdate,
  onRestore,
  onRetranslate,
  onCopy,
}: {
  entry: Entry
  index: number
  selected: boolean
  focused: boolean
  busy: boolean
  media: boolean
  onSelect: (selected: boolean) => void
  onJump: (play: boolean) => void
  onUpdate: (patch: Record<string, unknown>) => Promise<boolean>
  onRestore: (revision: number) => Promise<boolean>
  onRetranslate: () => void
  onCopy: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(entry.segment.text)
  const [translation, setTranslation] = useState(entry.segment.translation ?? '')
  const [editBase, setEditBase] = useState({
    revision: entry.segment.revision,
    text: entry.segment.text,
    translation: entry.segment.translation ?? '',
  })
  const [noteEditing, setNoteEditing] = useState(false)
  const [note, setNote] = useState(entry.note)
  const [noteBase, setNoteBase] = useState({ revision: entry.segment.revision, note: entry.note })
  const [history, setHistory] = useState(false)

  async function saveText() {
    if (entry.segment.revision !== editBase.revision) return
    const patch = {
      ...(text !== editBase.text ? { text } : {}),
      ...(translation !== editBase.translation ? { translation } : {}),
    }
    if (Object.keys(patch).length === 0 || (await onUpdate({ ...patch, expectedRevision: editBase.revision })))
      setEditing(false)
  }

  function rebaseEdit() {
    if (text === editBase.text) setText(entry.segment.text)
    if (translation === editBase.translation) setTranslation(entry.segment.translation ?? '')
    setEditBase({
      revision: entry.segment.revision,
      text: entry.segment.text,
      translation: entry.segment.translation ?? '',
    })
  }

  async function saveNote() {
    if (entry.segment.revision !== noteBase.revision) return
    if (note === noteBase.note || (await onUpdate({ note, expectedRevision: noteBase.revision }))) setNoteEditing(false)
  }

  return (
    <li
      id={`library-segment-${entry.segment.id}`}
      className={cn(panelClass, focused && 'border-[var(--color-accent)]')}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          <input
            aria-label={`选择第${index + 1}段`}
            type="checkbox"
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
          />
          第 {index + 1} 段
        </label>
        <Button size="sm" variant="ghost" onClick={() => onJump(false)}>
          {positionLabel(entry.segment.startMs)}–{positionLabel(entry.segment.endMs)}
        </Button>
        {media && (
          <Button size="sm" onClick={() => onJump(true)}>
            回听片段
          </Button>
        )}
        <Button
          size="sm"
          disabled={busy}
          variant={entry.bookmarked ? 'primary' : 'ghost'}
          onClick={() => void onUpdate({ bookmarked: !entry.bookmarked })}
        >
          {entry.bookmarked ? '取消标记' : '标记'}
        </Button>
        <Button size="sm" disabled={busy} onClick={onCopy}>
          复制
        </Button>
        <Button size="sm" disabled={busy} onClick={onRetranslate}>
          重新翻译
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setText(entry.segment.text)
            setTranslation(entry.segment.translation ?? '')
            setEditBase({
              revision: entry.segment.revision,
              text: entry.segment.text,
              translation: entry.segment.translation ?? '',
            })
            setEditing((value) => !value)
          }}
        >
          修订
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() => {
            setNote(entry.note)
            setNoteBase({ revision: entry.segment.revision, note: entry.note })
            setNoteEditing((value) => !value)
          }}
        >
          笔记
        </Button>
        <Button size="sm" onClick={() => setHistory((value) => !value)}>
          版本 {entry.versions.length}
        </Button>
      </div>
      {editing ? (
        <fieldset disabled={busy} className="m-0 space-y-2 border-0 p-0">
          <label className="block space-y-1 text-xs">
            修订原文
            <textarea
              aria-label={`修订第${index + 1}段原文`}
              rows={3}
              value={text}
              onChange={(event) => setText(event.target.value)}
              className={fieldClass}
            />
          </label>
          <label className="block space-y-1 text-xs">
            修订译文
            <textarea
              aria-label={`修订第${index + 1}段译文`}
              rows={3}
              value={translation}
              onChange={(event) => setTranslation(event.target.value)}
              className={fieldClass}
            />
          </label>
          <p className="text-[var(--color-ink-2)] text-xs">
            更改原文会使旧译文失效；可以同时修订译文，或之后重新翻译。
          </p>
          {entry.segment.revision !== editBase.revision && (
            <div role="status" className="space-y-2 text-[var(--color-warn)] text-xs">
              <p>本段已有新版本，请核对后再保存。</p>
              <details>
                <summary className="cursor-pointer">查看当前已保存内容</summary>
                <p className="mt-1 whitespace-pre-wrap">{entry.segment.text}</p>
                {entry.segment.translation && <p className="mt-1 whitespace-pre-wrap">{entry.segment.translation}</p>}
              </details>
              <Button size="sm" onClick={rebaseEdit}>
                保留改动并载入最新版本
              </Button>
            </div>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!text.trim() || entry.segment.revision !== editBase.revision}
              onClick={() => void saveText()}
            >
              保存修订
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              取消修订
            </Button>
          </div>
        </fieldset>
      ) : (
        <div className="space-y-2">
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{entry.segment.text}</p>
          {entry.segment.translationState === TranslationState.Done && entry.segment.translation && (
            <p className="whitespace-pre-wrap text-[var(--color-ink-1)] text-sm leading-relaxed">
              {entry.segment.translation}
            </p>
          )}
          {entry.segment.translationState === TranslationState.Pending && (
            <p className="text-[var(--color-ink-2)] text-xs">翻译中…</p>
          )}
          {entry.segment.translationState === TranslationState.Failed && (
            <p className="text-[var(--color-warn)] text-xs">翻译失败，可重新翻译或手动修订。</p>
          )}
        </div>
      )}
      {entry.bookmarked && entry.bookmarkVersion !== undefined && (
        <p className="mt-2 text-[var(--color-ink-2)] text-xs">标记保留了版本 {entry.bookmarkVersion} 的摘录。</p>
      )}
      {noteEditing ? (
        <div className="mt-3 space-y-2">
          {entry.segment.revision !== noteBase.revision && (
            <div role="status" className="space-y-2 text-[var(--color-warn)] text-xs">
              <p>本段已有新版本。当前笔记：{entry.note || '无'}</p>
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  if (note === noteBase.note) setNote(entry.note)
                  setNoteBase({ revision: entry.segment.revision, note: entry.note })
                }}
              >
                保留笔记改动并载入最新版本
              </Button>
            </div>
          )}
          <textarea
            aria-label={`第${index + 1}段笔记`}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className={fieldClass}
            disabled={busy}
            rows={3}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || entry.segment.revision !== noteBase.revision}
              onClick={() => void saveNote()}
            >
              保存笔记
            </Button>
            <Button size="sm" disabled={busy} onClick={() => setNoteEditing(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        entry.note && (
          <p className="mt-3 whitespace-pre-wrap border-[var(--color-border-subtle)] border-t pt-2 text-[var(--color-ink-1)] text-xs">
            笔记：{entry.note}
          </p>
        )
      )}
      {history && (
        <div className="mt-3 space-y-2 border-[var(--color-border-subtle)] border-t pt-3">
          <h4 className="text-xs">历史版本</h4>
          {[...entry.versions].reverse().map((version) => (
            <div key={version.revision} className="space-y-1 rounded bg-[var(--color-surface-0)] p-3 text-xs">
              <p className="text-[var(--color-ink-2)]">
                版本 {version.revision} · {dateLabel(version.committedAt)}
              </p>
              <p className="whitespace-pre-wrap">{version.text}</p>
              {version.translation && (
                <p className="whitespace-pre-wrap text-[var(--color-ink-1)]">{version.translation}</p>
              )}
              <Button
                size="sm"
                disabled={busy || version.revision === entry.segment.revision}
                onClick={() => void onRestore(version.revision)}
              >
                恢复此版本
              </Button>
            </div>
          ))}
        </div>
      )}
    </li>
  )
}
