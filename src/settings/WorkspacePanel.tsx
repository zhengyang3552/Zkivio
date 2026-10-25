import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Download, Loader2, Trash2 } from 'lucide-react'
import { api, type AndroidRootfsState } from '../api/tauri'
import { Button } from '../components/Button'
import { confirmDialog } from '../components/dialogQueue'
import type { Lang } from '../components/i18n'
import { SettingRow, SettingsGroup } from './components'
import { workspaceProgress } from './workspaceProgress'

const PROGRESS_EVENT = 'android-rootfs-progress'

const text = {
  zh: {
    title: '工作区',
    status: '状态',
    notInstalled: '尚未下载',
    ready: '已就绪',
    downloading: '下载中',
    extracting: '解包中',
    extractingHint: '正在把解开的文件写进工作区',
    failed: '下载失败',
    download: '下载工作区',
    downloadHint: '从官方源与国内镜像依次尝试，下载后校验 SHA-256。',
    distro: '发行版',
    variantAlpine: 'Alpine（~4MB）',
    variantUbuntu: 'Ubuntu（~30MB）',
    ubuntuHint: 'Ubuntu 自带 bash/apt，但部分机型的系统限制会让其自带命令无法执行；若 shell 全部报 Permission denied，换回 Alpine 即可。',
    uninstall: '卸载 rootfs（保留文件区）',
    uninstallHint: '卸载 Linux 系统本体；agent 写在 /workspace 的文件会保留',
    location: '位置',
    version: '版本',
    retry: '重试',
    confirmTitle: '卸载工作区？',
    confirmBody: '工作区里的全部文件都会被删除（包括 agent 写过的内容），且无法恢复。proot 运行时会保留，之后可以重新下载。',
    confirmLabel: '卸载',
    done: '已清空工作区',
  },
  en: {
    title: 'Workspace',
    status: 'Status',
    notInstalled: 'Not downloaded',
    ready: 'Ready',
    downloading: 'Downloading',
    extracting: 'Extracting',
    extractingHint: 'Writing the unpacked files into the workspace',
    failed: 'Download failed',
    download: 'Download workspace',
    downloadHint: 'Tries the official source and mirrors in order; SHA-256 is verified after download.',
    distro: 'Distro',
    variantAlpine: 'Alpine (~4MB)',
    variantUbuntu: 'Ubuntu (~30MB)',
    ubuntuHint: 'Ubuntu ships bash/apt, but some ROMs block executing their bundled binaries; if every shell call fails with Permission denied, switch back to Alpine.',
    uninstall: 'Uninstall rootfs (keep files)',
    uninstallHint: 'Removes the Linux system; files under /workspace are kept',
    location: 'Location',
    version: 'Version',
    retry: 'Retry',
    confirmTitle: 'Uninstall the workspace?',
    confirmBody: 'Every file in the workspace is deleted (including what the agent wrote) and cannot be recovered. The proot runtime is kept, so you can download again later.',
    confirmLabel: 'Uninstall',
    done: 'Workspace cleared',
  },
} as const

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 「工作区」页面（Android）。
 *
 * 工作区是按需下载的：没装时这里只有一个下载按钮；装好后同一个位置变成
 * 「卸载（格式化）」。状态由后端推 android-rootfs-progress 事件，页面只负责显示，
 * 不自己推断进度（下载可能在后台继续，重进页面也要能看到当前进度）。
 *
 * 进度条与「关于」页的更新下载共用 kv-progress + 百分比排版：两个页面下载的是同一种
 * 东西（按需拉的分发包），显示方式必须一致。
 */
export function WorkspacePanel({ lang }: { lang: Lang }) {
  const t = text[lang]
  const [state, setState] = useState<AndroidRootfsState | null>(null)
  const [busy, setBusy] = useState(false)
  const [variant, setVariant] = useState<'alpine' | 'ubuntu'>('alpine')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // 事件比首次快照新：快照是页面挂载时的旧读数，晚到的响应不能覆盖已经开始推送的进度。
    let sawProgressEvent = false
    const unlisten = listen<AndroidRootfsState>(PROGRESS_EVENT, (event) => {
      sawProgressEvent = true
      if (!cancelled) setState(event.payload)
    })
    void (async () => {
      try {
        const snapshot = await api.androidRootfsState()
        if (!cancelled && !sawProgressEvent) setState(snapshot)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
      // listen() 在非 Tauri 运行时（测试/浏览器）会 reject；这里吃掉，避免未处理拒绝。
      void unlisten.then(
        (off) => off(),
        () => {},
      )
    }
  }, [])

  const status = state?.status ?? 'absent'
  const working = busy || status === 'downloading' || status === 'extracting'
  const received = state?.received ?? 0
  const total = state?.total ?? 0
  const progress = workspaceProgress({ status, received, total })

  const run = useCallback(async (action: () => Promise<AndroidRootfsState>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setState(await action())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  const handleDownload = useCallback(() => {
    void run(() => api.androidRootfsInstall(variant))
  }, [run, variant])

  const handleUninstall = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: t.confirmTitle,
        message: t.confirmBody,
        confirmLabel: t.confirmLabel,
        danger: true,
      })
      if (!confirmed) return
      await run(async () => {
        const next = await api.androidRootfsUninstall()
        setNotice(t.done)
        return next
      })
    })()
  }, [run, t])

  const statusLabel =
    status === 'ready'
      ? t.ready
      : status === 'downloading'
        ? t.downloading
        : status === 'extracting'
          ? t.extracting
          : status === 'failed'
            ? t.failed
            : t.notInstalled

  return (
    <SettingsGroup title={t.title}>
      {/* 页面副标题已经解释过 rootfs 是什么，这里只留状态，避免同一段话出现两次。 */}
      <SettingRow label={statusLabel}>
        {status === 'ready' ? (
          <Button variant="danger" size="sm" onClick={handleUninstall} disabled={working}>
            <Trash2 size={11} />
            {t.uninstall}
          </Button>
        ) : (
          <Button variant="primary" size="sm" onClick={handleDownload} disabled={working}>
            {working ? (
              <Loader2 size={11} className="animate-spin" />
            ) : (
              <Download size={11} />
            )}
            {status === 'failed' ? t.retry : t.download}
          </Button>
        )}
      </SettingRow>

      {/* 发行版选择：下载前可挑；就绪后只读展示（换发行版 = 卸载后重下）。 */}
      {status !== 'ready' && !working && (
        <SettingRow label={t.distro}>
          <div className="flex gap-2">
            <Button size="sm" variant={variant === 'alpine' ? 'primary' : 'default'} onClick={() => setVariant('alpine')}>
              {t.variantAlpine}
            </Button>
            <Button size="sm" variant={variant === 'ubuntu' ? 'primary' : 'default'} onClick={() => setVariant('ubuntu')}>
              {t.variantUbuntu}
            </Button>
          </div>
        </SettingRow>
      )}

      <SettingRow label={t.location} stack>
        <p className="kv-row-desc break-all font-mono">{state?.root ?? '—'}</p>
      </SettingRow>

      {state?.variant && (
        <SettingRow label={t.distro} stack>
          <p className="kv-row-desc">{state.variant}</p>
        </SettingRow>
      )}

      {working && (
        <div className="px-1 pb-2" role="status" aria-live="polite">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="kv-row-desc">
              {status === 'extracting'
                ? t.extractingHint
                : `${formatBytes(received)} / ${formatBytes(total)}`}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
              {progress.indeterminate ? '—' : `${progress.percent}%`}
            </span>
          </div>
          <div
            className="kv-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.indeterminate ? undefined : progress.percent}
          >
            <div style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      )}

      <div className="px-1 pb-2">
        <p className="kv-row-desc">
          {status === 'ready'
            ? t.uninstallHint
            : variant === 'ubuntu'
              ? t.ubuntuHint
              : t.downloadHint}
        </p>
        {error && (
          <p role="alert" className="kv-inline-error mt-2">
            {error}
          </p>
        )}
        {!error && state?.message && (
          <p className="kv-row-desc mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {state.message}
          </p>
        )}
        {notice && <p className="kv-row-desc mt-2">{notice}</p>}
      </div>
    </SettingsGroup>
  )
}
