import { useCallback, useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Download, HardDrive, Loader2, Trash2 } from 'lucide-react'
import { api, type AndroidRootfsState } from '../api/tauri'
import { confirmDialog } from '../components/dialogQueue'
import type { Lang } from '../components/i18n'

const PROGRESS_EVENT = 'android-rootfs-progress'

const text = {
  zh: {
    title: '工作区',
    lead: '工作区是一套随应用自带的 Linux rootfs：agent 在里面读写文件、执行命令，看到的 / 就是这套 rootfs。按需下载，不占安装包体积。',
    notInstalled: '尚未下载',
    ready: '已就绪',
    downloading: '下载中',
    extracting: '解包中',
    failed: '下载失败',
    download: '下载工作区',
    downloadHint: '约 4 MB（Alpine minirootfs）',
    uninstall: '卸载（格式化）',
    uninstallHint: '会清空工作区，包括 agent 在里面写过的文件',
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
    lead: 'The workspace is a Linux rootfs shipped for the app: the agent reads, writes and runs commands inside it, and `/` is that rootfs. Downloaded on demand, so it costs nothing in the installer.',
    notInstalled: 'Not downloaded',
    ready: 'Ready',
    downloading: 'Downloading',
    extracting: 'Extracting',
    failed: 'Download failed',
    download: 'Download workspace',
    downloadHint: 'about 4 MB (Alpine minirootfs)',
    uninstall: 'Uninstall (format)',
    uninstallHint: 'Erases the workspace, including files the agent wrote',
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
 */
export function WorkspacePanel({ lang }: { lang: Lang }) {
  const t = text[lang]
  const [state, setState] = useState<AndroidRootfsState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const snapshot = await api.androidRootfsState()
        if (!cancelled) setState(snapshot)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    // 订阅放在请求之前也行，但这里先订阅再覆盖：事件比响应新时不会被旧快照盖回去。
    const unlisten = listen<AndroidRootfsState>(PROGRESS_EVENT, (event) => {
      if (!cancelled) setState(event.payload)
    })
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
  const percent =
    state && state.total > 0
      ? Math.min(100, Math.round((state.received / state.total) * 100))
      : 0

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
    void run(api.androidRootfsInstall)
  }, [run])

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

  return (
    <div className="flex max-w-[620px] flex-col gap-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-900/[0.05] dark:bg-white/[0.07]">
          <HardDrive size={18} strokeWidth={1.75} />
        </span>
        <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">{t.lead}</p>
      </div>

      <div className="rounded-xl border border-neutral-900/10 p-4 dark:border-white/10">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              {status === 'ready'
                ? t.ready
                : status === 'downloading'
                  ? t.downloading
                  : status === 'extracting'
                    ? t.extracting
                    : status === 'failed'
                      ? t.failed
                      : t.notInstalled}
            </div>
            <div className="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
              {t.location}：{state?.root ?? '—'}
            </div>
            {state?.version && (
              <div className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                {t.version}：{state.version}
              </div>
            )}
          </div>

          {status === 'ready' ? (
            <button
              type="button"
              onClick={handleUninstall}
              disabled={working}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--danger,#dc2626)]/30 px-3 py-2 text-sm font-medium text-[var(--danger,#dc2626)] transition active:scale-[0.98] disabled:opacity-50"
            >
              <Trash2 size={16} strokeWidth={1.75} />
              {t.uninstall}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleDownload}
              disabled={working}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--theme-surface-active)] px-3 py-2 text-sm font-medium transition active:scale-[0.98] disabled:opacity-50"
            >
              {working ? (
                <Loader2 size={16} strokeWidth={1.75} className="animate-spin" />
              ) : (
                <Download size={16} strokeWidth={1.75} />
              )}
              {status === 'failed' ? t.retry : t.download}
            </button>
          )}
        </div>

        {working && (
          <div className="mt-3">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-900/10 dark:bg-white/10">
              <div
                className="h-full rounded-full bg-[var(--theme-surface-active)] transition-[width] duration-200"
                style={{ width: `${status === 'extracting' ? 100 : percent}%` }}
              />
            </div>
            <div className="mt-1.5 text-xs tabular-nums text-neutral-500 dark:text-neutral-400">
              {status === 'extracting'
                ? t.extracting
                : `${formatBytes(state?.received ?? 0)} / ${formatBytes(state?.total ?? 0)}`}
            </div>
          </div>
        )}

        {status !== 'ready' && !working && (
          <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">
            {t.downloadHint}
          </p>
        )}
        {status === 'ready' && (
          <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">{t.uninstallHint}</p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-[var(--danger,#dc2626)]">
            {error}
          </p>
        )}
        {!error && state?.message && (
          <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">{state.message}</p>
        )}
        {notice && <p className="mt-3 text-xs text-neutral-500 dark:text-neutral-400">{notice}</p>}
      </div>
    </div>
  )
}
