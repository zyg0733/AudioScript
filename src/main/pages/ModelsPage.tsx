import { useCallback, useEffect, useState } from 'react'
import { useStore } from '@/main/store'
import {
  EVENT,
  formatCmdError,
  type ModelJobStatus,
  ModelPhase,
  type ModelStatus,
  type ModelsList,
  modelCancel,
  modelDownload,
  modelOpenDir,
  modelRemove,
  modelSelect,
  modelsList,
  on,
} from '@/shared/ipc'
import { ModelKind, TaskStatus } from '@/shared/types'
import { Alert } from '@/ui/Alert'
import { Button } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { Page } from '@/ui/Page'
import { ProgressBar } from '@/ui/ProgressBar'
import { SettingsGroup, SettingsRow } from '@/ui/Settings'
import { StatusBadge } from '@/ui/StatusBadge'

interface Failure {
  modelId: string
  message: string
}

export function ModelsPage() {
  const { status, setError, runSettingsWrite } = useStore()
  const capturing = status === TaskStatus.Capturing

  const [list, setList] = useState<ModelsList | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [job, setJob] = useState<ModelJobStatus | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const next = await modelsList()
      setList(next)
      setJob(next.job ?? null)
      setLoadError(null)
    } catch (e) {
      setLoadError(formatCmdError(e))
    }
  }, [])

  function retry() {
    setLoadError(null)
    void refresh()
  }

  useEffect(() => {
    let disposed = false
    void refresh()

    const unlisten = on<ModelJobStatus>(EVENT.modelsProgress, (payload) => {
      if (disposed) return
      const terminal =
        payload.phase === ModelPhase.Done ||
        payload.phase === ModelPhase.Failed ||
        payload.phase === ModelPhase.Cancelled

      if (!terminal) {
        setJob(payload)
        return
      }

      if (payload.phase === ModelPhase.Failed) {
        setFailure({
          modelId: payload.modelId,
          message: payload.error ?? '下载失败',
        })
      }
      setJob(null)
      void refresh()
    })

    return () => {
      disposed = true
      void unlisten.then((fn) => fn())
    }
  }, [refresh])

  async function download(modelId: string) {
    setFailure(null)
    setBusyId(modelId)
    try {
      await modelDownload(modelId)
      await refresh()
    } catch (e) {
      setError(formatCmdError(e))
    } finally {
      setBusyId(null)
    }
  }

  async function cancel(jobId: string) {
    try {
      await modelCancel(jobId)
    } catch (e) {
      setError(formatCmdError(e))
    }
  }

  async function select(modelId: string) {
    setBusyId(modelId)
    try {
      const kind = [...(list?.asr ?? []), ...(list?.mt ?? [])].find((model) => model.id === modelId)?.kind ?? modelId
      setList(await runSettingsWrite(`model-selection:${kind}`, () => modelSelect(modelId)))
      setConfirmRemove(null)
    } catch (e) {
      setError(formatCmdError(e))
    } finally {
      setBusyId(null)
    }
  }

  async function remove(modelId: string) {
    if (confirmRemove !== modelId) {
      setConfirmRemove(modelId)
      return
    }
    setBusyId(modelId)
    setConfirmRemove(null)
    try {
      setList(await modelRemove(modelId))
    } catch (e) {
      setError(formatCmdError(e))
    } finally {
      setBusyId(null)
    }
  }

  function openModelsDir() {
    void modelOpenDir().catch((e) => setError(formatCmdError(e)))
  }

  if (!list) {
    return (
      <Page title="模型">
        {loadError ? (
          <Alert tone="error" title="读取模型列表失败">
            <p className="font-mono">{loadError}</p>
            <Button size="sm" className="mt-2" onClick={retry}>
              重试
            </Button>
          </Alert>
        ) : (
          <p className="text-[var(--color-ink-2)] text-sm">读取中…</p>
        )}
      </Page>
    )
  }

  const connected = list.userRoot !== undefined
  const brokenSelected = [...list.asr, ...list.mt].find((m) => m.selected && !m.complete)

  return (
    <Page title="模型">
      {loadError && (
        <Alert tone="error" title="刷新模型列表失败">
          <p className="font-mono">{loadError}</p>
          <Button size="sm" className="mt-2" onClick={retry}>
            重试
          </Button>
        </Alert>
      )}

      {brokenSelected && (
        <Alert tone="error" title={`当前使用的「${brokenSelected.title}」文件缺失`}>
          {brokenSelected.bundled
            ? '内置模型文件缺失，请重新安装应用。'
            : '请重新下载该模型，或切换到其他已安装的模型。'}
        </Alert>
      )}

      {capturing && (
        <Alert tone="info" title="正在转写">
          模型切换将在下次开始转写时生效；停止转写后才能删除模型。
        </Alert>
      )}

      {failure && (
        <Alert tone="error" title={`${modelTitle(list, failure.modelId)} 下载失败`}>
          {failure.message}
          <button type="button" className="ml-2 underline underline-offset-2" onClick={() => setFailure(null)}>
            知道了
          </button>
        </Alert>
      )}

      {[
        { title: '语音识别', items: list.asr },
        { title: '机器翻译', items: list.mt },
      ].map((group) => (
        <SettingsGroup key={group.title} title={group.title}>
          {group.items.map((m) => (
            <ModelRow
              key={m.id}
              model={m}
              job={job}
              capturing={capturing}
              busy={busyId === m.id}
              confirmRemove={confirmRemove === m.id}
              onDownload={() => void download(m.id)}
              onCancel={() => job && void cancel(job.jobId)}
              onSelect={() => void select(m.id)}
              onRemove={() => void remove(m.id)}
              onCancelRemove={() => setConfirmRemove(null)}
            />
          ))}
        </SettingsGroup>
      ))}

      <p className="px-1 text-[var(--color-ink-2)] text-[0.7rem] leading-relaxed">
        {connected ? '可选模型下载需联网。' : '无法解析模型存储目录，可选模型暂不可用。'}
        {connected && (
          <button type="button" className="ml-1 underline underline-offset-2" onClick={openModelsDir}>
            打开模型目录
          </button>
        )}
      </p>
    </Page>
  )
}

interface RowProps {
  model: ModelStatus
  job: ModelJobStatus | null
  capturing: boolean
  busy: boolean
  confirmRemove: boolean
  onDownload: () => void
  onCancel: () => void
  onSelect: () => void
  onRemove: () => void
  onCancelRemove: () => void
}

function ModelRow({
  model,
  job,
  capturing,
  busy,
  confirmRemove,
  onDownload,
  onCancel,
  onSelect,
  onRemove,
  onCancelRemove,
}: RowProps) {
  const activeJob = job && job.modelId === model.id ? job : null
  const licenses = [...new Set(model.licenses.map((l) => l.license))]
  const needsAttribution = model.licenses.some((l) => l.requiresAttribution)
  const canDelete = model.installed && !model.bundled && model.downloadable && !model.selected && !capturing && !job

  return (
    <SettingsRow
      icon={model.kind === ModelKind.Asr ? 'waveform' : 'translate'}
      title={
        <span className="flex flex-wrap items-center gap-1.5">
          {model.title}
          {model.selected && (
            <span
              role="img"
              aria-label="使用中"
              title="使用中"
              className="inline-flex items-center text-[var(--color-accent)]"
            >
              <Icon name="check" size={15} strokeWidth={2.25} />
            </span>
          )}
          {model.bundled && <StatusBadge tone="muted">内置</StatusBadge>}
          {!model.selected && statusBadge(model)}
        </span>
      }
      description={
        <span>
          约 {formatBytes(model.installedBytes)}
          {licenses.length > 0 && ` · ${licenses.join(' / ')}${needsAttribution ? '（需署名）' : ''}`}
          {!model.bundled && model.installed && !model.complete && ' · 文件不完整，请重新下载'}
          {model.bundled && !model.complete && ' · 内置文件缺失，请重新安装应用'}
          {!model.bundled && !model.downloadable && ' · 模型包尚未发布'}
        </span>
      }
      control={
        <div className="flex items-center gap-2">
          {activeJob ? (
            <>
              <div className="flex flex-col items-end gap-1">
                <ProgressBar value={activeJob.percent ?? null} label={`${model.title} 下载进度`} />
                <span className="font-mono text-[0.65rem] text-[var(--color-ink-2)]">
                  {phaseLabel(activeJob.phase)}
                  {activeJob.percent != null && ` ${Math.round(activeJob.percent)}%`}
                </span>
              </div>
              <Button size="sm" variant="ghost" onClick={onCancel}>
                取消
              </Button>
            </>
          ) : (
            <>
              {model.selected ? null : model.installed && model.complete ? (
                <Button size="sm" onClick={onSelect} disabled={busy}>
                  使用
                </Button>
              ) : model.downloadable ? (
                <Button
                  size="sm"
                  variant="primary"
                  icon="download"
                  onClick={onDownload}
                  disabled={busy || job !== null}
                >
                  {model.installed ? '重新下载' : '下载'}
                </Button>
              ) : null}

              {canDelete &&
                (confirmRemove ? (
                  <>
                    <Button size="sm" variant="danger" onClick={onRemove} disabled={busy}>
                      确认删除
                    </Button>
                    <Button size="sm" variant="ghost" onClick={onCancelRemove}>
                      取消
                    </Button>
                  </>
                ) : (
                  <Button size="sm" variant="ghost" onClick={onRemove} disabled={busy}>
                    删除
                  </Button>
                ))}
            </>
          )}
        </div>
      }
    />
  )
}

function statusBadge(model: ModelStatus) {
  if (model.complete) return <StatusBadge tone="ok">{model.bundled ? '内置' : '已下载'}</StatusBadge>
  if (model.bundled) return <StatusBadge tone="danger">内置文件缺失</StatusBadge>
  if (model.installed) return <StatusBadge tone="danger">文件不完整</StatusBadge>
  if (model.downloadable) return <StatusBadge tone="warn">未安装</StatusBadge>
  return <StatusBadge tone="muted">资源尚未发布</StatusBadge>
}

function phaseLabel(phase: ModelPhase): string {
  switch (phase) {
    case ModelPhase.Downloading:
      return '下载中'
    case ModelPhase.Verifying:
      return '校验中'
    case ModelPhase.Extracting:
      return '解压中'
    case ModelPhase.Validating:
      return '校验文件'
    case ModelPhase.Done:
      return '完成'
    case ModelPhase.Cancelled:
      return '已取消'
    case ModelPhase.Failed:
      return '失败'
  }
}

function modelTitle(list: ModelsList, id: string): string {
  return [...list.asr, ...list.mt].find((m) => m.id === id)?.title ?? id
}

function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  if (mb >= 10) return `${Math.round(mb)} MB`
  return `${mb.toFixed(1)} MB`
}
