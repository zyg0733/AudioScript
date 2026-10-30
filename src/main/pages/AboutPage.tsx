import { useEffect, useState } from 'react'
import { useStore } from '@/main/store'
import { useI18n } from '@/shared/i18n'
import { formatCmdError, type ModelsList, modelsList, openRepo, openSponsor, openUrl } from '@/shared/ipc'
import { modelTitle } from '@/shared/models'
import { ModelKind, SessionPhase, TaskStatus } from '@/shared/types'
import { Button } from '@/ui/Button'
import { Icon } from '@/ui/Icon'
import { Page } from '@/ui/Page'
import { ProgressBar } from '@/ui/ProgressBar'
import { SettingsGroup, SettingsRow } from '@/ui/Settings'

function afdianBadge(label: string): string {
  return `https://img.shields.io/badge/${encodeURIComponent(label)}-Afdian-946ce6?style=for-the-badge&logo=github&logoColor=white`
}

export function AboutPage() {
  const {
    info,
    setError,
    status,
    sessionInfo,
    pending,
    updateInfo,
    updatePhase,
    updateRestarting,
    updateProgress,
    updateError,
    installedVersion,
    checkUpdate,
    installUpdate,
    restartApp,
  } = useStore()
  const { t } = useI18n()
  const [models, setModels] = useState<ModelsList | null>(null)
  const [modelsFailed, setModelsFailed] = useState(false)
  const [licensesOpen, setLicensesOpen] = useState(false)

  useEffect(() => {
    let disposed = false
    modelsList()
      .then((m) => {
        if (!disposed) setModels(m)
      })
      .catch(() => {
        if (!disposed) setModelsFailed(true)
      })
    return () => {
      disposed = true
    }
  }, [])

  async function openSponsorPage() {
    try {
      await openSponsor()
    } catch (e) {
      setError(formatCmdError(e))
    }
  }

  async function openSite() {
    if (!info) return
    try {
      await openUrl(info.links.site)
    } catch (e) {
      setError(formatCmdError(e))
    }
  }

  async function openRepositoryPage() {
    try {
      await openRepo()
    } catch (e) {
      setError(formatCmdError(e))
    }
  }

  const capturing = status === TaskStatus.Capturing
  const sessionBusy =
    !sessionInfo ||
    capturing ||
    pending ||
    sessionInfo.phase === SessionPhase.Preparing ||
    sessionInfo.phase === SessionPhase.Finalizing ||
    sessionInfo.phase === SessionPhase.Processing
  const updaterEnabled = info?.updaterEnabled === true && updateInfo?.enabled !== false
  const percent =
    updateProgress?.total != null
      ? Math.min(100, Math.floor((updateProgress.downloaded / updateProgress.total) * 100))
      : null

  const updateDescription = (() => {
    if (info && !updaterEnabled) {
      return updateInfo?.disabledReason ?? info.updaterDisabledReason ?? '自动更新已禁用'
    }
    if (updatePhase === 'downloading') {
      const version = updateInfo?.version ?? ''
      return percent == null
        ? t('about.updateDownloading', { version })
        : t('about.updateDownloadingPercent', { version, percent })
    }
    if (updatePhase === 'ready') {
      const version = installedVersion ?? updateInfo?.version ?? ''
      if (updateRestarting) return '正在保存设置并重启应用…'
      if (!sessionInfo) return `已安装 v${version}，确认会话状态后可重启`
      return sessionBusy ? `已安装 v${version}，请等待转写收尾完成后再重启` : `已安装 v${version}，重启应用后生效`
    }
    if (updatePhase === 'error') {
      return t('about.updateError', { error: updateError ?? t('about.unknownError') })
    }
    if (updatePhase === 'checking') return t('about.updateChecking')
    if (updateInfo?.available) {
      if (!sessionInfo) return '发现新版本，确认会话状态后可更新'
      return capturing ? '发现新版本，请先停止转写再更新' : `发现新版本 v${updateInfo.version}`
    }
    if (updateInfo) return t('about.updateLatest', { version: updateInfo.currentVersion })
    return t('about.updateIdle')
  })()

  return (
    <Page title={t('about.title')}>
      <SettingsGroup title={t('about.appGroup')}>
        <SettingsRow icon="info" title={t('about.version')} control={<Mono>{info?.version ?? '—'}</Mono>} />
        <SettingsRow
          icon="download"
          title={t('about.checkUpdate')}
          description={
            <>
              {updateDescription}
              {updateInfo?.available && updatePhase === 'idle' && updateInfo.notes && (
                <p className="mt-1 line-clamp-3 whitespace-pre-line">{updateInfo.notes}</p>
              )}
            </>
          }
          control={
            updatePhase === 'downloading' ? (
              <div className="flex items-center gap-2">
                <ProgressBar value={percent} label={t('about.updateProgress')} />
                <Mono>{percent == null ? t('about.downloading') : `${percent}%`}</Mono>
              </div>
            ) : updatePhase === 'ready' ? (
              <Button
                size="sm"
                variant="primary"
                icon="refresh"
                onClick={() => void restartApp()}
                disabled={sessionBusy}
                pending={updateRestarting}
              >
                重启
              </Button>
            ) : updateInfo?.available ? (
              <Button
                size="sm"
                variant="primary"
                icon="download"
                onClick={() => void installUpdate()}
                disabled={!updaterEnabled || sessionBusy || updatePhase === 'checking'}
              >
                {t('common.downloadAndInstall')}
              </Button>
            ) : (
              <Button
                size="sm"
                icon="refresh"
                onClick={() => void checkUpdate()}
                disabled={!updaterEnabled || updatePhase === 'checking'}
                pending={updatePhase === 'checking'}
              >
                {t('common.check')}
              </Button>
            )
          }
        />
        <SettingsRow
          icon="chip"
          title={t('about.platform')}
          control={
            <Mono>
              {info?.platform ?? '—'} · {info?.arch ?? '—'}
            </Mono>
          }
        />
        <SettingsRow
          icon="github"
          title="GitHub 仓库"
          description={info?.links?.repository}
          onClick={() => void openRepositoryPage()}
          control={<Icon name="chevron" size={16} className="mt-0.5 text-[var(--color-ink-2)]" />}
        />
        <SettingsRow
          icon="external"
          title={t('about.website')}
          onClick={() => void openSite()}
          control={<Icon name="chevron" size={16} className="mt-0.5 text-[var(--color-ink-2)] rtl:rotate-180" />}
        />
      </SettingsGroup>

      <SettingsGroup title={t('about.support')}>
        <SettingsRow
          icon="heart"
          title={t('about.sponsor')}
          description={t('about.sponsorDescription')}
          onClick={() => void openSponsorPage()}
          control={<img src={afdianBadge(t('about.afdian'))} alt={t('about.afdian')} className="h-7 w-auto" />}
        />
      </SettingsGroup>

      <SettingsGroup title={t('about.licensesGroup')}>
        <SettingsRow
          icon="github"
          title={
            <span className="flex items-center gap-2">
              LICENSE
              <Mono>MIT</Mono>
            </span>
          }
          onClick={() => void openRepositoryPage()}
          control={<Icon name="chevron" size={16} className="mt-0.5 text-[var(--color-ink-2)]" />}
        />
      </SettingsGroup>

      <SettingsGroup title={t('about.modelsLicenses')} footer={licensesOpen ? t('about.licenseFooter') : undefined}>
        <SettingsRow
          icon="shield"
          title={t('about.modelLicense')}
          onClick={() => setLicensesOpen((open) => !open)}
          control={
            <Icon
              name="chevron"
              size={16}
              className={`mt-0.5 text-[var(--color-ink-2)] transition-transform ${licensesOpen ? 'rotate-90' : ''}`}
            />
          }
        />
        {licensesOpen &&
          (models ? (
            [...models.asr, ...models.mt].flatMap((m) =>
              m.licenses.map((l) => (
                <SettingsRow
                  key={`${m.id}-${l.component}`}
                  icon={m.kind === ModelKind.Asr ? 'waveform' : 'translate'}
                  title={l.component}
                  description={
                    <>
                      {modelTitle(m, t)} · {l.license}
                      {l.requiresAttribution && t('about.needsAttribution')}
                      {l.attribution && ` · ${l.attribution}`}
                    </>
                  }
                  control={
                    l.licenseUrl ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="external"
                        onClick={() => void openUrl(l.licenseUrl as string).catch((e) => setError(formatCmdError(e)))}
                      >
                        {t('about.licenseButton')}
                      </Button>
                    ) : undefined
                  }
                />
              )),
            )
          ) : (
            <SettingsRow title={modelsFailed ? t('about.licenseLoadFailed') : t('common.loading')} />
          ))}
      </SettingsGroup>
    </Page>
  )
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-[var(--color-ink-1)] text-xs">{children}</span>
}
