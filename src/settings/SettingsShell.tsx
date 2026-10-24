import { forwardRef, useImperativeHandle, useState, useEffect, useCallback, useRef, useSyncExternalStore, type ReactNode, type SetStateAction } from 'react'
import {
  X, RefreshCw,
  ArrowLeft, Palette,
} from 'lucide-react'
import { open, save } from '@tauri-apps/plugin-dialog'
import {
  api,
  type Settings as SettingsType,
  type ModelProvider,
  type ModelInfo,
  type DefaultPromptTemplates,
  type ChatToolsConfig,
  type ChatNativeToolsConfig,
  type ChatMemoryConfig,
} from '../api/tauri'
import {
  getSettingsSnapshotCached,
  importSettingsSnapshotCached,
  peekSettingsSnapshot,
  refreshSettingsSnapshot,
  saveSettingsSnapshotCached,
  subscribeSettingsSnapshot,
  updateSettingsCached,
} from '../api/settingsCache'
import { SettingsEditorController, type SettingsCloseOptions } from './SettingsEditorController'
import { useSettingsUpdateController } from './useSettingsUpdateController'
import { useSettingsPermissions } from './useSettingsPermissions'
import { applyProviderDraftIntent, type ProviderDraftIntent } from './providerDraftIntents'
import { i18n, type Lang } from '../components/i18n'
import {
  GeneralIcon, ChatIcon, MemoryIcon, MixerIcon,
  WebSearchIcon, SessionsIcon, UsageIcon, ProvidersIcon, AboutIcon, HooksIcon,
  WorkspaceIcon,
} from './NavIcons'
import { type ProviderPreset } from './providerPresets'
import { ProviderModelsPicker } from './ProviderModelsPicker'
import { UsageStatsPanel } from './UsageStatsPanel'
import { WorkspacePanel } from './WorkspacePanel'
import { isMobilePlatform } from '../chat/platform'
import { RequestDebugPanel } from './RequestDebugPanel'
import { MixerTab } from './tabs/MixerTab'
import { MemoryTab } from './tabs/MemoryTab'
import { ChatTab } from './tabs/ChatTab'
import { ProvidersTab } from './tabs/ProvidersTab'
import { HooksTab } from './tabs/HooksTab'
import { AppearanceGroup, BehaviorGroup, PermissionsGroup } from './tabs/GeneralTab'
import { AppInfoGroup, UpdateGroup } from './tabs/AboutTab'
import { useSettingsMemoryEditor } from './useSettingsMemoryEditor'
import { useProviderCatalogController } from './useProviderCatalogController'
import { useSettingsBackupController } from './useSettingsBackupController'
import { BackupSection } from './BackupSection'
import { captureBackupInterface } from '../api/backupInterface'
import { useProviderModalController } from './useProviderModalController'
import { useSettingsOnboardingController } from './useSettingsOnboardingController'
import { ModelDetailDrawer } from './ModelDetailDrawer'
import { ProviderModelTestModal } from './ProviderModelTestModal'
import { Button } from '../components/Button'
import { confirmDialog } from '../components/dialogQueue'
import { ThemeTab } from './tabs/ThemeTab'
import type { ThemeDefinition } from '../theme/types'
import { resolveModelInfo } from '../data/modelMatching'
import { loadLastModel, resolvePreferredChatModel } from '../data/chatModelPreference'
import { useWindowInteractionFocus } from '../api/windowFocus'
import { hasEnabledNativeBuiltinTool, hasEnabledSkillRuntime } from '../api/chatTools'
import { UI_FONT_PX_MIN, UI_FONT_PX_MAX } from './uiFont'
import {
  SettingRow,
  SettingsGroup,
} from './components'
import { WebSearchPanel } from './WebSearchPanel'

/**
 * 设置页是否折叠成「一级列表 → 二级内容」的移动形态。
 *
 * 判据是可用宽度而不是平台：平板横屏（>839px）有足够空间，导航列与内容区并排更好用，
 * 和桌面端一致；窄屏手机才需要两级跳转，否则点一个分类就把导航整块顶掉。
 */
const COMPACT_SETTINGS_QUERY = '(max-width: 839px)'

function subscribeCompactSettings(onChange: () => void) {
  const query = window.matchMedia(COMPACT_SETTINGS_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function getCompactSettings() {
  return window.matchMedia(COMPACT_SETTINGS_QUERY).matches
}

export type SettingsTab = 'general' | 'themes' | 'chat' | 'memory' | 'mixer' | 'hooks' | 'webSearch' | 'sessions' | 'usage' | 'workspace' | 'providers' | 'about'

type SettingsData = SettingsType
// UI 字号：以 px 展示、以整体缩放（zoom）实现。CSS 全是 px 硬编码，做不了真正的 rem 基准字号，
// 故 14px 锚定为 100%，输入 px → scale = px/14。ponytail: zoom 代理，若将来全量 rem 化可换真基准。
const UI_FONT_BASE_PX = 14

export interface SettingsShellProps {
  variant: 'standalone' | 'embedded'
  onClose: () => void
  onSettingsChange: () => void
  onReady?: () => void
  reserveTrafficLightSpace?: boolean
  /** 打开设置面板时选中的侧栏项（如 Chat 内嵌设置默认 AI 客户端） */
  initialTab?: SettingsTab
  /** embedded 单页模式：隐藏左侧设置导航，只显示 initialTab 对应页（如从扩展点「知识库」进入） */
  hideNav?: boolean
  /** Chat 宿主提供的领域视图；设置只决定它们出现的位置。 */
  renderSessionCenter?: (lang: Lang) => ReactNode
  renderReleaseNotes: (markdown: string) => ReactNode
}

export interface SettingsShellHandle {
  requestClose: (options?: SettingsCloseOptions) => void
}

function resolveEffectiveChatModel(settings: SettingsData): { provider?: ModelProvider, model: string } {
  const selected = resolvePreferredChatModel({
    providers: settings.providers,
    last: loadLastModel(),
    storedChat: settings.defaultModels.chat,
    legacyChat: { providerId: settings.chatProviderId, model: settings.chatModel },
  })

  return {
    provider: settings.providers.find((provider) => provider.id === selected.providerId),
    model: selected.model || '',
  }
}

function resolveEffectiveChatMaxOutput(settings: SettingsData, fallbackTokens: number) {
  const { provider, model } = resolveEffectiveChatModel(settings)
  const override = model ? provider?.modelOverrides?.[model]?.maxOutput : undefined
  const modelInfo = model ? resolveModelInfo(model, provider?.modelOverrides, provider) : {}
  const maxOutput = override || modelInfo.maxOutput || fallbackTokens
  const source: 'override' | 'database' | 'fallback' = override
    ? 'override'
    : modelInfo.maxOutput
      ? 'database'
      : 'fallback'

  return { maxOutput, source, model, provider }
}

/**
 * 设置面板主组件（standalone / embedded 双宿主）
 */
export const SettingsShell = forwardRef<SettingsShellHandle, SettingsShellProps>(function SettingsShell(
  { variant, onClose, onSettingsChange, onReady, reserveTrafficLightSpace = false, initialTab, hideNav = false, renderSessionCenter, renderReleaseNotes },
  ref,
) {
  const onSettingsChangeRef = useRef(onSettingsChange)
  onSettingsChangeRef.current = onSettingsChange
  const editorControllerRef = useRef<SettingsEditorController | null>(null)
  if (!editorControllerRef.current) {
    editorControllerRef.current = new SettingsEditorController({
      peek: peekSettingsSnapshot,
      load: getSettingsSnapshotCached,
      refresh: refreshSettingsSnapshot,
      save: saveSettingsSnapshotCached,
      subscribe: subscribeSettingsSnapshot,
      import: importSettingsSnapshotCached,
    }, () => onSettingsChangeRef.current())
  }
  const editorController = editorControllerRef.current
  const editorView = useSyncExternalStore(editorController.subscribe, () => editorController.snapshot)
  const { settings, loading, loadError, hasUnsavedChanges } = editorView
  const setSettings = useCallback((update: SetStateAction<SettingsData | null>) => {
    editorController.edit((current) => {
      const next = typeof update === 'function' ? update(current) : update
      return next ?? current
    })
  }, [editorController])
  const [appVersion, setAppVersion] = useState('')
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? 'general')
  // 窄屏二级菜单：null = 一级设置列表；否则为已进入的子页。
  // 宽屏（桌面 / 平板横屏）不使用，导航列与内容区并排。
  const [mobilePane, setMobilePane] = useState<SettingsTab | null>(null)
  const compactLayout = useSyncExternalStore(subscribeCompactSettings, getCompactSettings, getCompactSettings)
  const paneNavigation = isMobilePlatform && compactLayout
  const [themeDraft, setThemeDraft] = useState<ThemeDefinition | null>(null)
  // 使用统计页内的视图：应用用量 / 调用明细 / 请求调试
  const [usageView, setUsageView] = useState<'app' | 'calls' | 'debug'>('app')
  useEffect(() => {
    if (initialTab) setActiveTab(initialTab)
  }, [initialTab])
  const [defaultPrompts, setDefaultPrompts] = useState<DefaultPromptTemplates | null>(null)
  const [retryAttemptsInput, setRetryAttemptsInput] = useState('')
  const [uiFontPxInput, setUiFontPxInput] = useState('')
  const [systemFonts, setSystemFonts] = useState<string[]>([])
  const permissions = useSettingsPermissions()
  const providerModals = useProviderModalController(settings?.providers.map((provider) => provider.id) ?? [])
  const selectedProviderId = providerModals.selectedId
  const modelPickerProviderId = providerModals.pickerId
  const confirmDeleteProviderId = providerModals.deleteId
  const drawerModel = providerModals.drawerModel
  const modelTestProviderId = providerModals.testId
  const { closePicker, cancelDelete } = providerModals
  const requestWindowFocus = useWindowInteractionFocus()
  const updates = useSettingsUpdateController(settings ? settings.autoCheckUpdate : null)
  // 加载失败时的错误信息；非空则渲染错误 UI 而不是用合成默认值进入正常视图
  // （否则用户可能没察觉就自动保存把磁盘真实数据覆盖掉）
  const [reloadKey, setReloadKey] = useState(0)
  const readyEmittedRef = useRef(false)

  const lang = settings?.settingsLanguage || 'zh'
  const memoryEditor = useSettingsMemoryEditor(undefined, lang, activeTab === 'memory')
  const providerCatalog = useProviderCatalogController({
    fetch: api.fetchModelCatalog,
    getProvider: (id) => editorController.snapshot.settings?.providers.find((provider) => provider.id === id),
    apply: (id, updates) => editorController.edit((current) => applyProviderDraftIntent(current, { type: 'update', id, updates })),
  })
  const settingsBackup = useSettingsBackupController({
    webdav: {
      load: api.webdavLoad,
      save: api.webdavSave,
      test: api.webdavTest,
      list: api.webdavList,
      upload: async (kind) => {
        if (!await editorController.flush()) throw new Error(lang === 'zh' ? '设置尚未保存，请先解决保存错误。' : 'Save your settings before exporting.')
        return api.webdavUpload(kind, captureBackupInterface())
      },
      download: api.webdavDownload,
      release: api.webdavRelease,
      delete: api.webdavDelete,
      confirmRestore: (kind) => confirmDialog({
        title: lang === 'zh' ? '恢复远程备份' : 'Restore remote backup',
        message: kind === 'full'
          ? (lang === 'zh' ? '此备份将在重启后替换当前 Kivio 数据，并保留恢复前的副本。请先停止正在运行的任务。继续？' : 'This backup replaces your Kivio data after restart and retains a recovery copy. Stop active tasks first. Continue?')
          : (lang === 'zh' ? '将覆盖当前设置，并导入备份中的助手和集。继续？' : 'This replaces current settings and imports assistants and sets. Continue?'),
        confirmLabel: lang === 'zh' ? '继续' : 'Continue',
        danger: true,
      }),
      confirmDelete: (name) => confirmDialog({
        title: lang === 'zh' ? '删除备份' : 'Delete backup',
        message: lang === 'zh' ? `删除远程备份 ${name}？此操作无法撤销。` : `Delete remote backup ${name}? This cannot be undone.`,
        confirmLabel: lang === 'zh' ? '删除' : 'Delete',
        danger: true,
      }),
    },
    pickImport: async () => {
      const selected = await open({ multiple: false, filters: [{ name: 'Kivio backup', extensions: ['json', 'kivio', 'zip'] }] })
      return typeof selected === 'string' ? selected : null
    },
    pickExport: (kind) => save({
      defaultPath: kind === 'full' ? 'kivio-full-backup.kivio' : 'kivio-configuration.json',
      filters: [{ name: 'Kivio backup', extensions: kind === 'full' ? ['kivio'] : ['json'] }],
    }),
    import: (path, trusted) => editorController.import(path, trusted),
    export: async (path, kind) => {
      if (!await editorController.flush()) throw new Error(lang === 'zh' ? '设置尚未保存，请先解决保存错误。' : 'Save your settings before exporting.')
      if (kind === 'full') return api.exportFullBackup(path, captureBackupInterface())
      await api.exportSettings(path)
    },
    importFull: (path, trusted) => api.importFullBackup(path, trusted),
    confirmFullRestore: () => confirmDialog({
      title: lang === 'zh' ? '恢复完全备份' : 'Restore full backup',
      message: lang === 'zh'
        ? '重启后将用备份替换当前 Kivio 数据，恢复前的数据会保留副本。请先停止正在运行的任务。继续准备恢复？'
        : 'After restarting, this backup will replace your Kivio data. A copy of your previous data will be kept. Stop active tasks first. Prepare restore?',
      confirmLabel: lang === 'zh' ? '准备恢复' : 'Prepare restore',
      danger: true,
    }),
    restart: () => api.restartAfterRestore(),
    pendingRestore: () => api.backupRestorePending(),
  }, lang)
  const onboarding = useSettingsOnboardingController({
    flush: () => editorController.flush(),
    writePending: () => updateSettingsCached((current) => ({ ...current, onboardingStatus: 'pending' })),
    committed: () => onSettingsChangeRef.current(),
    navigate: () => { window.location.hash = '#chat/onboarding' },
  }, lang)
  const t = i18n[lang]
  const controllerSaveError = editorView.saveError.startsWith('Settings conflict: ')
    ? `${lang === 'zh' ? '设置冲突：' : 'Settings conflict: '}${editorView.saveError.slice('Settings conflict: '.length)}`
    : editorView.saveError.startsWith('Save failed: ')
      ? `${lang === 'zh' ? '保存失败：' : 'Save failed: '}${editorView.saveError.slice('Save failed: '.length)}`
      : editorView.saveError
  const visibleSaveError = providerCatalog.error
    ? `${lang === 'zh' ? '获取模型失败：' : 'Could not fetch models: '}${providerCatalog.error}`
    : controllerSaveError
  const chatTools = settings?.chatTools
  const nativeBuiltinToolsEnabled = chatTools ? hasEnabledNativeBuiltinTool(chatTools.nativeTools) : false
  const skillRuntimeEnabled = chatTools ? hasEnabledSkillRuntime(chatTools.nativeTools) : false

  // 初始化：加载设置、版本号、默认提示词
  // 重试通过递增 reloadKey 触发本 effect 重跑
  useEffect(() => {
    let active = true
    readyEmittedRef.current = false
    editorController.start()
    api.getAppVersion()
      .then((ver: string) => {
        if (active) setAppVersion(ver)
      })
      .catch(() => {
        if (active) setAppVersion('unknown')
      })
    api.getDefaultPromptTemplates()
      .then((templates) => {
        if (active) setDefaultPrompts(templates)
      })
      .catch((err) => {
        console.error('Failed to load default prompt templates:', err)
      })
    // resizeWindow 已在 App.tsx 中处理，此处不再重复调用
    return () => {
      active = false
    }
  }, [editorController, reloadKey])

  useEffect(() => () => editorController.dispose(), [editorController])

  // 首屏内容就绪信号：settings 数据就绪或错误态就绪时触发一次。用于让宿主（Chat→App）
  // 把窗口 show 推迟到设置页可渲染之后，避免“窗口已弹出但在转圈”。传了 onReady 就触发，
  // 不再限定 standalone（旧独立设置窗时代的遗留条件）。
  useEffect(() => {
    if (!onReady) return
    if (!loading && !readyEmittedRef.current && (settings || loadError)) {
      readyEmittedRef.current = true
      onReady()
    }
  }, [loadError, loading, onReady, settings])

  const retryAttempts = settings?.retryAttempts

  useEffect(() => {
    if (retryAttempts === undefined) return
    setRetryAttemptsInput(String(retryAttempts))
  }, [retryAttempts])

  const uiFontScale = settings?.uiFontScale
  useEffect(() => {
    if (uiFontScale === undefined) return
    setUiFontPxInput(String(Math.round((uiFontScale ?? 1) * UI_FONT_BASE_PX)))
  }, [uiFontScale])

  const commitUiFontPx = (raw: string, commit: boolean) => {
    if (!settings) return
    const fallback = String(Math.round((settings.uiFontScale ?? 1) * UI_FONT_BASE_PX))
    if (raw.trim() === '') {
      if (commit) setUiFontPxInput(fallback)
      return
    }
    const parsed = Number.parseInt(raw, 10)
    if (Number.isNaN(parsed)) {
      if (commit) setUiFontPxInput(fallback)
      return
    }
    const clamped = Math.min(UI_FONT_PX_MAX, Math.max(UI_FONT_PX_MIN, parsed))
    if (commit) setUiFontPxInput(String(clamped))
    updateSettings({ uiFontScale: clamped / UI_FONT_BASE_PX })
  }

  // 系统已装字体列表，仅拉取一次（前端无法枚举，走后端 CoreText/GDI）。
  useEffect(() => {
    let alive = true
    api.listSystemFonts().then((fonts) => {
      if (alive) setSystemFonts(fonts)
    })
    return () => {
      alive = false
    }
  }, [])

  /**
   * 立即把当前草稿写盘。自动保存与关闭前 flush 共用。
   * 保存中若草稿又变了，收尾后会再跑一轮，避免丢字。
   */
  const persistSettingsNow = useCallback(() => editorController.flush(), [editorController])

  /**
   * 关闭设置页：默认等待 flush 成功；显式 waitForSave=false 才立即退场。
   */
  const handleCloseRequest = useCallback((options?: SettingsCloseOptions) => {
    void (async () => {
      if (themeDraft && !await confirmDialog({
        message: lang === 'zh' ? '自定义主题尚未保存。放弃编辑并关闭？' : 'The custom theme is not saved. Discard edits and close?',
        danger: true,
      })) return
      setThemeDraft(null)
      await editorController.requestClose(onClose, options)
    })()
  }, [editorController, onClose, themeDraft, lang])

  useImperativeHandle(ref, () => ({ requestClose: handleCloseRequest }), [handleCloseRequest])

  const handleSettingsDragMouseDown = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement | null
    if (target?.closest('button, input, textarea, select, [data-tauri-drag-region="false"]')) return
    event.preventDefault()
    void api.startDragging().catch((err) => {
      console.error('[settings-drag] startDragging failed:', err)
    })
  }, [])

  // 全局键盘：Esc 关闭、Cmd/Ctrl+S 立即 flush；弹窗打开时优先处理弹窗内的 Esc
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 应用内确认框（原生 <dialog>）自己处理 Esc；捕获阶段在这里先接住会把整个设置页关掉。
      if (e.target instanceof Element && e.target.closest('dialog[open]')) return

      if (modelPickerProviderId) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          closePicker()
        }
        return
      }

      // 删除供应商弹窗：Esc 取消；不绑定 Enter，避免误触发破坏性删除
      if (confirmDeleteProviderId) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          cancelDelete()
        }
        return
      }

      if (e.key === 'Escape') {
        handleCloseRequest({ waitForSave: false })
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (hasUnsavedChanges) void persistSettingsNow()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [
    handleCloseRequest,
    confirmDeleteProviderId,
    modelPickerProviderId,
    closePicker,
    cancelDelete,
    hasUnsavedChanges,
    persistSettingsNow,
  ])

  // 重试次数输入处理
  const handleRetryAttemptsChange = (value: string) => {
    if (!settings) return
    setRetryAttemptsInput(value)
    if (value.trim() === '') return
    const parsed = Number.parseInt(value, 10)
    if (Number.isNaN(parsed)) return
    const clamped = Math.min(8, Math.max(1, parsed))
    updateSettings({ retryAttempts: clamped })
  }

  const handleRetryAttemptsBlur = () => {
    if (!settings) return
    if (retryAttemptsInput.trim() === '') {
      setRetryAttemptsInput(String(settings.retryAttempts))
      return
    }
    const parsed = Number.parseInt(retryAttemptsInput, 10)
    if (Number.isNaN(parsed)) {
      setRetryAttemptsInput(String(settings.retryAttempts))
      return
    }
    const clamped = Math.min(8, Math.max(1, parsed))
    setRetryAttemptsInput(String(clamped))
    if (clamped !== settings.retryAttempts) {
      updateSettings({ retryAttempts: clamped })
    }
  }

  /**
   * 更新设置字段
   */
  const updateSettings = useCallback((updates: Partial<SettingsData>) => {
    setSettings((prev) => {
      if (!prev) return prev
      return { ...prev, ...updates }
    })
  }, [setSettings])

  const commitThemeSettings = useCallback(async (update: (current: SettingsData) => SettingsData) => {
    const before = editorController.snapshot.settings
    if (!before) throw new Error('Settings are not loaded')
    const submitted = update(before)
    editorController.edit(submitted)
    if (!await editorController.flush()) {
      const message = editorController.snapshot.saveError || 'Theme settings could not be saved'
      // Keep the theme editor draft for retry, but never advertise an unconfirmed
      // selection as active. Do not roll back edits made while the save was pending.
      editorController.edit(current => {
        let restored = current
        for (const field of ['theme', 'themeColor', 'customThemes', 'translucentSidebar'] as const) {
          if (JSON.stringify(current[field]) === JSON.stringify(submitted[field])) {
            restored = { ...restored, [field]: before[field] }
          }
        }
        return restored
      })
      throw new Error(message)
    }
  }, [editorController])

  // 哪些 API Key 输入框处于明文显示（按 `${providerId}-${idx}` 记），默认全部隐藏。
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set())
  const [gzipInfoOpen, setGzipInfoOpen] = useState<Set<string>>(new Set())
  const toggleKeyReveal = useCallback((keyId: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(keyId)) next.delete(keyId)
      else next.add(keyId)
      return next
    })
  }, [])

  const updateDefaultModel = useCallback((
    key: keyof SettingsData['defaultModels'],
    providerId: string,
    model: string,
  ) => {
    setSettings((prev) => {
      if (!prev) return prev
      const defaultModels = {
        ...prev.defaultModels,
        [key]: { providerId, model },
      }
      return {
        ...prev,
        defaultModels,
        ...(key === 'chat' ? { chatProviderId: providerId, chatModel: model } : {}),
      }
    })
  }, [setSettings])

  const updateChatTools = useCallback((updates: Partial<ChatToolsConfig> | ((current: ChatToolsConfig) => Partial<ChatToolsConfig>)) => {
    setSettings((prev) => {
      if (!prev) return prev
      const patch = typeof updates === 'function' ? updates(prev.chatTools) : updates
      return { ...prev, chatTools: { ...prev.chatTools, ...patch } }
    })
  }, [setSettings])

  const updateNativeTools = useCallback((updates: Partial<ChatNativeToolsConfig>) => {
    setSettings((prev) => {
      if (!prev) return prev
      const chatTools = prev.chatTools
      return {
        ...prev,
        chatTools: {
          ...chatTools,
          nativeTools: {
            ...chatTools.nativeTools,
            ...updates,
          },
        },
      }
    })
  }, [setSettings])

  const dispatchProviderIntent = useCallback((intent: ProviderDraftIntent) => {
    setSettings((current) => current ? applyProviderDraftIntent(current, intent) : current)
  }, [setSettings])

  const updateProvider = useCallback((id: string, updates: Partial<ModelProvider>) => {
    dispatchProviderIntent({ type: 'update', id, updates })
  }, [dispatchProviderIntent])

  const setProviderIcon = useCallback((id: string, iconKey: string) => {
    dispatchProviderIntent({ type: 'icon', id, iconKey })
  }, [dispatchProviderIntent])

  const reorderProviders = useCallback((fromId: string, toId: string) => {
    dispatchProviderIntent({ type: 'reorder', fromId, toId })
  }, [dispatchProviderIntent])

  /**
   * 添加新提供商
   */
  const addProvider = () => {
    if (!settings) return
    const newId = `provider-${Date.now()}`
    dispatchProviderIntent({ type: 'add', id: newId })
    providerModals.select(newId)
  }

  /** 用预设一键添加 provider —— baseUrl 和默认模型已填好，用户只需填 API key */
  const addProviderFromPreset = (preset: ProviderPreset) => {
    if (!settings) return
    const newId = `provider-${Date.now()}`
    dispatchProviderIntent({ type: 'add', id: newId, preset })
    providerModals.select(newId)
  }

  const deleteProvider = (id: string) => {
    if (!settings) return
    providerModals.providerDeleted(id)
    dispatchProviderIntent({ type: 'delete', id })
  }

  /**
   * 添加已启用模型
   */
  const addEnabledModel = (providerId: string, model: string) => {
    dispatchProviderIntent({ type: 'add-model', id: providerId, model })
  }

  const addAllEnabledModels = (providerId: string, models: string[]) => {
    dispatchProviderIntent({ type: 'add-models', id: providerId, models })
  }

  /**
   * 移除已启用模型
   * 移除后会自动更新使用该模型的功能到新的默认模型
   */
  const removeEnabledModel = (providerId: string, model: string) => {
    dispatchProviderIntent({ type: 'remove-model', id: providerId, model })
  }

  /**
   * 保存模型自定义参数
   */
  const saveModelOverride = useCallback((providerId: string, modelName: string, info: ModelInfo) => {
    dispatchProviderIntent({ type: 'save-override', id: providerId, model: modelName, info })
  }, [dispatchProviderIntent])

  /**
   * 重置模型参数为数据库默认值
   */
  const resetModelOverride = useCallback((providerId: string, modelName: string) => {
    dispatchProviderIntent({ type: 'reset-override', id: providerId, model: modelName })
  }, [dispatchProviderIntent])

  const openModelPicker = (providerId: string) => {
    providerModals.openPicker(providerId)
  }

  const updateChat = useCallback((updates: Partial<NonNullable<SettingsData['chat']>>) => {
    setSettings((prev) => {
      if (!prev) return prev
      return { ...prev, chat: { ...prev.chat, ...updates } }
    })
  }, [setSettings])

  const updateChatMemory = useCallback((updates: Partial<ChatMemoryConfig>) => {
    setSettings((prev) => {
      if (!prev) return prev
      return { ...prev, chatMemory: { ...prev.chatMemory, ...updates } }
    })
  }, [setSettings])

  const updateLensWebSearch = useCallback((updates: Partial<NonNullable<SettingsData['lens']['webSearch']>>) => {
    setSettings((prev) => {
      if (!prev) return prev
      return {
        ...prev,
        lens: {
          ...prev.lens,
          webSearch: {
            ...prev.lens.webSearch!,
            ...updates,
          },
        },
      }
    })
  }, [setSettings])

  const loadingShellClass =
    variant === 'embedded'
      ? 'flex min-h-0 min-w-0 flex-1 items-center justify-center bg-[var(--theme-surface)]'
      : 'flex items-center justify-center h-full bg-[var(--theme-surface-soft)]'

  if (loading) {
    return (
      <div className={loadingShellClass}>
        <div className="w-6 h-6 border-2 border-[var(--theme-surface-border)] border-t-[var(--text)] rounded-full animate-spin" />
      </div>
    )
  }

  if (loadError || !settings) {
    // 加载失败：显示错误 + 重试按钮，禁止用户在不知情的情况下用合成默认值 Save 覆盖磁盘
    return (
      <div className={`${loadingShellClass} p-6`}>
        <div className="max-w-sm w-full bg-[var(--theme-surface)] rounded-xl shadow-sm border border-[var(--theme-surface-border)] p-5 text-center">
          <div className="text-[14px] font-semibold text-[var(--text)] mb-1">
            {lang === 'zh' ? '加载设置失败' : 'Failed to load settings'}
          </div>
          <div className="text-[11px] text-[var(--danger)] mb-4 break-all" title={loadError}>
            {loadError}
          </div>
          <div className="flex gap-2 justify-center">
            <Button variant="primary" size="sm"
              onClick={() => setReloadKey((k) => k + 1)}
              className="flex items-center gap-1.5"
              data-tauri-drag-region="false"
            >
              <RefreshCw size={12} />
              {lang === 'zh' ? '重试' : 'Retry'}
            </Button>
            <Button size="sm" variant="ghost"
              onClick={onClose}
              data-tauri-drag-region="false"
            >
              {t.cancel}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // These values come from the canonical backend response. Do not synthesize persisted defaults
  // in the webview: legacy omissions are migrated before get_settings returns.
  const chatLangKey = settings.chat.defaultLanguage === 'en' ? 'en' : 'zh'
  const chatDefaults = defaultPrompts?.chatPrompts?.[chatLangKey]
  const chatRuntimeDefaults = defaultPrompts?.chatRuntimePrompt
  const chatConfig = settings.chat
  const chatMemory = settings.chatMemory
  const effectiveChatMaxOutput = resolveEffectiveChatMaxOutput(settings, chatConfig.maxOutputTokens)
  const chatMaxOutputSourceLabel = effectiveChatMaxOutput.source === 'override'
    ? (lang === 'zh' ? '模型参数' : 'Model override')
    : effectiveChatMaxOutput.source === 'database'
      ? (lang === 'zh' ? '内置模型库' : 'Model database')
      : (lang === 'zh' ? '兜底设置' : 'Fallback setting')
  const chatMaxOutputModelLabel = effectiveChatMaxOutput.model
    ? (effectiveChatMaxOutput.provider?.name
      ? `${effectiveChatMaxOutput.provider.name} / ${effectiveChatMaxOutput.model}`
      : effectiveChatMaxOutput.model)
    : (lang === 'zh' ? '未配置聊天模型' : 'No chat model configured')

  const navItems = [
    { id: 'general' as const, label: t.tabGeneral, icon: GeneralIcon },
    { id: 'themes' as const, label: lang === 'zh' ? '主题' : 'Themes', icon: Palette },
    { id: 'providers' as const, label: t.tabModels, icon: ProvidersIcon },
    { id: 'chat' as const, label: t.tabChatClient, icon: ChatIcon },
    { id: 'memory' as const, label: t.tabMemory, icon: MemoryIcon },
    { id: 'mixer' as const, label: t.tabMixer, icon: MixerIcon },
    { id: 'hooks' as const, label: t.tabHooks, icon: HooksIcon },
    { id: 'sessions' as const, label: t.tabSessions, icon: SessionsIcon },
    { id: 'webSearch' as const, label: t.tabWebSearch, icon: WebSearchIcon },
    { id: 'usage' as const, label: lang === 'zh' ? '使用统计' : 'Usage', icon: UsageIcon },
    // 工作区只有 Android 才有（自带 rootfs 的按需下载），桌面端不出现这个分类。
    ...(isMobilePlatform
      ? [{ id: 'workspace' as const, label: lang === 'zh' ? '工作区' : 'Workspace', icon: WorkspaceIcon }]
      : []),
    // 关于固定在分类列表最末
    { id: 'about' as const, label: lang === 'zh' ? '关于' : 'About', icon: AboutIcon },
  ]
  const pageMeta: Record<typeof activeTab, { title: string; subtitle: string; right?: string }> = {
    general: {
      title: t.tabGeneral,
      subtitle: lang === 'zh' ? '外观、行为、归档和权限。' : 'Appearance, behavior, archive, and permissions.',
    },
    themes: {
      title: lang === 'zh' ? '主题' : 'Themes',
      subtitle: lang === 'zh' ? '管理明暗色板，预览、编辑与分享自定义主题。' : 'Manage light and dark palettes. Preview, edit, and share custom themes.',
    },
    chat: {
      title: t.tabChatClient,
      subtitle: lang === 'zh'
        ? '主对话模型、流式/思考、系统提示词。'
        : 'Main chat model, streaming/thinking, and system prompt.',
    },
    memory: {
      title: t.tabMemory,
      subtitle: lang === 'zh'
        ? 'L1 注入；L2 按需读取。'
        : 'L1 injected; L2 read on demand.',
    },
    mixer: {
      title: t.tabMixer,
      subtitle: lang === 'zh'
        ? '按副任务路由模型：视觉、标题总结、上下文压缩、生图。'
        : 'Route models by side task: vision, title summaries, context compression, and image generation.',
    },
    hooks: {
      title: t.tabHooks,
      subtitle: t.hooksPageSubtitle,
    },
    sessions: {
      title: t.tabSessions,
      subtitle: t.chatSessionSubtitle,
    },
    webSearch: {
      title: t.tabWebSearch,
      subtitle: lang === 'zh'
        ? 'Tavily/Exa 密钥；分别开启 Lens 与 Chat 联网。'
        : 'Tavily/Exa keys; enable web search for Lens and Chat.',
    },
    usage: {
      title: lang === 'zh' ? '使用统计' : 'Usage',
      subtitle: '',
    },
    workspace: {
      title: lang === 'zh' ? '工作区' : 'Workspace',
      subtitle:
        lang === 'zh'
          ? '随应用自带的 Linux rootfs：按需下载，agent 在里面读写文件、执行命令。'
          : 'The Linux rootfs the app runs the agent in: downloaded on demand for reading, writing and running commands.',
    },
    providers: {
      title: t.tabModels,
      subtitle: lang === 'zh' ? '管理 OpenAI 兼容供应商、密钥和启用模型。' : 'Manage OpenAI-compatible providers, keys, and enabled models.',
    },
    about: {
      title: lang === 'zh' ? '关于' : 'About',
      subtitle: lang === 'zh' ? '应用、版本和更新信息。' : 'Application, version, and update details.',
    },
  }
  const selectedProvider = settings.providers.find((provider) => provider.id === selectedProviderId) ?? settings.providers[0]
  const chatProvider = settings.providers.find((provider) => provider.id === settings.chatProviderId)
    ?? settings.providers.find((provider) => provider.id === settings.lens?.providerId)
    ?? settings.providers.find((provider) => provider.id === settings.translatorProviderId)

  const categoryNav =
    variant === 'embedded' ? (
      <>
        <nav className="settings-embedded-nav-list custom-scrollbar">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveTab(item.id)
                  // 移动端进入二级页；桌面端只切内容区。
                  if (paneNavigation) setMobilePane(item.id)
                }}
                className={`settings-embedded-nav-item ${activeTab === item.id ? 'active' : ''}`}
                data-tauri-drag-region="false"
              >
                <span className="settings-embedded-nav-icon">
                  <Icon size={17} strokeWidth={1.75} />
                </span>
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>
        <div className="min-h-0 flex-1" />
        <nav className="settings-embedded-nav-list settings-embedded-nav-list--footer">
          <button
            type="button"
            onClick={() => handleCloseRequest({ waitForSave: false })}
            className="settings-embedded-back"
            title={lang === 'zh' ? '返回对话' : 'Back to chat'}
            data-tauri-drag-region="false"
          >
            <span className="settings-embedded-nav-icon">
              <ArrowLeft size={17} strokeWidth={1.75} />
            </span>
            <span>{lang === 'zh' ? '返回对话' : 'Back to chat'}</span>
          </button>
        </nav>
      </>
    ) : (
      <>
        <nav className="kv-nav">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`kv-nav-item ${activeTab === item.id ? 'active' : ''}`}
                data-tauri-drag-region="false"
              >
                <Icon strokeWidth={1.7} />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="kv-nav-spacer" />
      </>
    )

  const settingsMain = (
        <main className={`kv-content ${variant === 'embedded' ? 'settings-embedded-main' : ''}${activeTab === 'sessions' ? ' kv-content--wide' : ''}`}>
          <header
            className={`kv-page-header ${variant === 'embedded' ? 'settings-embedded-header' : ''}`}
            onMouseDown={handleSettingsDragMouseDown}
          >
            <div key={activeTab} className={`settings-section-title-enter${activeTab === 'usage' ? ' settings-usage-title' : ''}`}>
              <div className="flex items-center gap-3">
                {/* 移动端二级页返回：回到一级设置列表。 */}
                {variant === 'embedded' && paneNavigation && mobilePane !== null && (
                  <button
                    type="button"
                    className="settings-mobile-back"
                    onClick={() => setMobilePane(null)}
                    aria-label={lang === 'zh' ? '返回设置' : 'Back to settings'}
                    data-tauri-drag-region="false"
                  >
                    <ArrowLeft size={18} strokeWidth={2} />
                  </button>
                )}
                <div className="kv-page-title">{pageMeta[activeTab].title}</div>
                {activeTab === 'usage' && (
                  <div className="inline-flex items-center gap-0.5 rounded-full bg-[var(--bg-input-subtle)] p-0.5" data-tauri-drag-region="false">
                    {([
                      { id: 'app' as const, label: lang === 'zh' ? '应用用量' : 'App usage' },
                      { id: 'calls' as const, label: lang === 'zh' ? '调用明细' : 'Call details' },
                      { id: 'debug' as const, label: lang === 'zh' ? '请求调试' : 'Request debug' },
                    ]).map(option => (
                      <button
                        key={option.id}
                        type="button"
                        className={`rounded-full px-2.5 py-0.5 text-[12px] leading-5 ${
                          usageView === option.id
                            ? 'bg-[var(--bg)] text-[var(--text)] shadow-sm'
                            : 'text-[var(--text-muted)]'
                        }`}
                        onClick={() => setUsageView(option.id)}
                        data-tauri-drag-region="false"
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {pageMeta[activeTab].subtitle ? (
                <div className="kv-page-sub">{pageMeta[activeTab].subtitle}</div>
              ) : null}
            </div>
            <div className="kv-page-header-right">{pageMeta[activeTab].right}</div>
          </header>

          <div
            key={activeTab}
            className={`kv-scroll custom-scrollbar settings-section-enter ${variant === 'embedded' ? 'settings-embedded-scroll' : ''}${activeTab === 'sessions' ? ' kv-scroll--fill' : ''}`}
          >
            {activeTab === 'themes' && (
              <ThemeTab settings={settings} lang={lang} draft={themeDraft}
                onDraftChange={setThemeDraft} onCommit={commitThemeSettings} />
            )}
            {/* ===== 基础设置标签页 ===== */}
            {activeTab === 'general' && (
              <>
                <AppearanceGroup
                  settings={settings}
                  t={t}
                  lang={lang}
                  systemFonts={systemFonts}
                  uiFontPxInput={uiFontPxInput}
                  onUpdateSettings={updateSettings}
                  onUiFontPxInputChange={setUiFontPxInput}
                  onCommitUiFontPx={commitUiFontPx}
                />

                <BehaviorGroup
                  settings={settings}
                  t={t}
                  lang={lang}
                  retryAttemptsInput={retryAttemptsInput}
                  onUpdateSettings={updateSettings}
                  onRetryAttemptsChange={handleRetryAttemptsChange}
                  onRetryAttemptsBlur={handleRetryAttemptsBlur}
                />

                <SettingsGroup title={lang === 'zh' ? '首次使用' : 'First-time setup'}>
                  <SettingRow
                    label={lang === 'zh' ? '首次使用引导' : 'Setup wizard'}
                    description={t.onboardingRestartDesc}
                  >
                    <Button
                      size="sm"
                      onClick={() => void onboarding.restart()}
                      disabled={onboarding.busy}
                      data-tauri-drag-region="false"
                    >
                      {t.onboardingRestart}
                    </Button>
                    {onboarding.error && <span className="text-[12px] text-red-500" role="status">{onboarding.error}</span>}
                  </SettingRow>
                </SettingsGroup>

                <SettingsGroup title={lang === 'zh' ? '备份与恢复' : 'Backup & Restore'}>
                  {/* 备份页的信息层级（本地 / 完全 / WebDAV / 范围）由 BackupSection 独占，
                      分类页只负责挂载它；入口按钮不再在分类页单独铺一套。 */}
                  <BackupSection controller={settingsBackup} lang={lang} />
                </SettingsGroup>

                {(permissions.status?.platform === 'macos' || permissions.status?.platform === 'linux') && (
                  <PermissionsGroup
                    t={t}
                    permissionStatus={permissions.status}
                    permissionsLoading={permissions.loading}
                    onOpenPermissionSettings={permissions.open}
                    onRefreshPermissions={permissions.refresh}
                    onRequestScreenCapture={permissions.requestLinuxScreenCapture}
                    requestingScreenCapture={permissions.requestingScreenCapture}
                  />
                )}
              </>
            )}

            {/* ===== AI 客户端标签页 ===== */}
            {activeTab === 'chat' && (
              <ChatTab
                settings={settings}
                t={t}
                lang={lang}
                chatConfig={chatConfig}
                chatTools={settings.chatTools}
                chatMemory={chatMemory}
                chatDefaults={chatDefaults}
                chatRuntimeDefaults={chatRuntimeDefaults}
                effectiveChatMaxOutput={effectiveChatMaxOutput}
                chatMaxOutputSourceLabel={chatMaxOutputSourceLabel}
                chatMaxOutputModelLabel={chatMaxOutputModelLabel}
                skillRuntimeEnabled={skillRuntimeEnabled}
                nativeBuiltinToolsEnabled={nativeBuiltinToolsEnabled}
                onUpdateChat={updateChat}
                onUpdateNativeTools={updateNativeTools}
                onNavigateTab={setActiveTab}
              />
            )}

            {/* ===== 记忆标签页 ===== */}
            {activeTab === 'memory' && (
              <MemoryTab
                lang={lang}
                chatMemory={chatMemory}
                memoryDir={memoryEditor.view.dir}
                memoryError={memoryEditor.view.error}
                memorySuccess={memoryEditor.view.success}
                memoryLoading={memoryEditor.view.loading}
                memorySavingLayer={memoryEditor.view.savingLayer}
                memoryDrafts={memoryEditor.view.drafts}
                memorySnapshots={memoryEditor.view.snapshots}
                onUpdateChatMemory={updateChatMemory}
                onRefresh={() => void memoryEditor.refresh()}
                onOpenFolder={() => void memoryEditor.openFolder()}
                onDraftChange={memoryEditor.edit}
                onSaveLayer={(layer) => void memoryEditor.save(layer)}
                onReplaceLayerContent={(layer, content) => void memoryEditor.replaceContent(layer, content)}
              />
            )}

            {/* ===== 混音器标签页 ===== */}
            {activeTab === 'mixer' && (
              <MixerTab
                settings={settings}
                t={t}
                lang={lang}
                chatTools={settings.chatTools}
                hasChatProvider={Boolean(chatProvider)}
                defaultPromptOptimize={defaultPrompts?.promptOptimizePrompts?.[lang] ?? ''}
                onUpdateDefaultModel={updateDefaultModel}
                onUpdateChatTools={updateChatTools}
                onUpdateChat={updateChat}
              />
            )}

            {/* ===== Hooks 标签页（对话生命周期） ===== */}
            {activeTab === 'hooks' && (
              <HooksTab
                lang={lang}
                hooks={settings.chatTools.hooks ?? []}
                onChange={(hooks) => updateChatTools({ hooks })}
              />
            )}

            {activeTab === 'sessions' && renderSessionCenter?.(lang)}

            {/* ===== 网络搜索标签页 ===== */}
            {activeTab === 'webSearch' && (
              <WebSearchPanel
                t={t}
                lang={lang}
                webSearch={settings.lens?.webSearch}
                onChange={updateLensWebSearch}
              />
            )}

            {/* ===== 使用统计：应用用量 / 调用明细 / 请求调试 ===== */}
            {activeTab === 'usage' && (
              usageView === 'debug' ? (
                <RequestDebugPanel
                  lang={lang}
                  enabled={settings.chatTools.requestDebugEnabled ?? false}
                  onToggleEnabled={(v) => updateChatTools({ requestDebugEnabled: v })}
                />
              ) : (
                <UsageStatsPanel lang={lang} view={usageView} />
              )
            )}

            {/* ===== 工作区（Android）：自带 rootfs 的按需下载 / 卸载 ===== */}
            {activeTab === 'workspace' && <WorkspacePanel lang={lang} />}

            {/* ===== 模型管理标签页 ===== */}
            {activeTab === 'providers' && (
              <ProvidersTab
                settings={settings}
                t={t}
                lang={lang}
                selectedProvider={selectedProvider}
                revealedKeys={revealedKeys}
                gzipInfoOpen={gzipInfoOpen}
                onSelectProvider={providerModals.select}
                onReorderProviders={reorderProviders}
                onAddProvider={addProvider}
                onAddProviderFromPreset={addProviderFromPreset}
                onUpdateProvider={updateProvider}
                onSetProviderIcon={setProviderIcon}
                onRequestDeleteProvider={providerModals.requestDelete}
                onToggleGzipInfo={(id) => setGzipInfoOpen((prev) => {
                  const next = new Set(prev)
                  if (next.has(id)) next.delete(id)
                  else next.add(id)
                  return next
                })}
                onToggleKeyReveal={toggleKeyReveal}
                onOpenModelPicker={openModelPicker}
                onOpenModelTest={providerModals.openTest}
                onOpenModelDrawer={providerModals.openDrawer}
                onRemoveEnabledModel={removeEnabledModel}
              />
            )}

            {/* ===== 关于标签页 ===== */}
            {activeTab === 'about' && (
              <>
                <AppInfoGroup t={t} lang={lang} appVersion={appVersion} />

                <UpdateGroup
                  settings={settings}
                  t={t}
                  update={{
                    status: updates.status,
                    info: updates.info,
                    downloadState: updates.downloadState,
                    downloadPercent: updates.downloadPercent,
                    downloadError: updates.downloadError,
                  }}
                  onUpdateSettings={updateSettings}
                  onCheck={updates.check}
                  onDownloadAndInstall={updates.downloadAndInstall}
                  onInstall={updates.install}
                  onOpenReleasePage={updates.openReleasePage}
                  onOpenGithubReleases={updates.openGithubReleases}
                  onDismiss={updates.dismiss}
                  renderReleaseNotes={renderReleaseNotes}
                />
              </>
            )}
          </div>

          {visibleSaveError && (
            <div
              className="settings-autosave-toast error"
              role="status"
              title={visibleSaveError}
              data-tauri-drag-region="false"
            >
              {visibleSaveError}
            </div>
          )}
        </main>
  )

  const modelPickerProvider =
    modelPickerProviderId && settings
      ? settings.providers.find((p) => p.id === modelPickerProviderId)
      : undefined

  const settingsModals = (
    <>
      {modelPickerProvider && (
        <ProviderModelsPicker
          provider={modelPickerProvider}
          lang={lang}
          labels={{
            title: lang === 'zh' ? '模型' : 'Models',
            searchPlaceholder: lang === 'zh' ? '搜索模型 ID 或名称' : 'Search model ID or name',
            fetchModels: t.fetchModels,
            fetching: t.fetching,
            addModel: t.addModel,
            manualAddModel: t.manualAddModel,
            noModels: lang === 'zh' ? '没有可用模型。点刷新重试，或手动添加。' : 'No models yet. Refresh or add one manually.',
            noSearchResults: lang === 'zh' ? '没有匹配的模型' : 'No matching models',
            enabled: lang === 'zh' ? '已启用' : 'On',
            addAllModels: lang === 'zh' ? '添加当前列表中的全部模型' : 'Add all models in the current list',
            close: lang === 'zh' ? '关闭' : 'Close',
          }}
          fetching={providerCatalog.fetchingProviderId === modelPickerProvider.id}
          onClose={providerModals.closePicker}
          onFetch={() => void providerCatalog.fetchModels(modelPickerProvider.id)}
          onAdd={(model) => addEnabledModel(modelPickerProvider.id, model)}
          onAddAll={(models) => addAllEnabledModels(modelPickerProvider.id, models)}
          onRemove={(model) => removeEnabledModel(modelPickerProvider.id, model)}
        />
      )}
      {/* 模型详情抽屉 */}
      {drawerModel && settings && (
        <ModelDetailDrawer
          modelName={drawerModel.model}
          provider={settings.providers.find(p => p.id === drawerModel.providerId)}
          overrides={settings.providers.find(p => p.id === drawerModel.providerId)?.modelOverrides}
          lang={lang}
          onClose={providerModals.closeDrawer}
          onSave={(modelName, info) => {
            saveModelOverride(drawerModel.providerId, modelName, info)
            providerModals.closeDrawer()
          }}
          onReset={(modelName) => resetModelOverride(drawerModel.providerId, modelName)}
        />
      )}
      {modelTestProviderId && settings && (() => {
        const p = settings.providers.find(pv => pv.id === modelTestProviderId)
        if (!p) return null
        return (
          <ProviderModelTestModal
            providerId={p.id}
            baseUrl={p.baseUrl}
            apiKeys={p.apiKeys}
            activeKeyIndex={p.activeKeyIndex}
            apiFormat={p.apiFormat}
            request={p.request}
            models={p.enabledModels}
            lang={lang}
            onClose={providerModals.closeTest}
          />
        )
      })()}
      {/* 删除提供商确认弹窗 */}
      {confirmDeleteProviderId && (
        <div className="kv-modal-backdrop" data-tauri-drag-region="false">
          <div className="kv-modal space-y-3">
            <h3 className="text-[14px] font-semibold">{t.confirmDeleteProvider}</h3>
            <p className="kv-panel-body">{t.confirmDeleteProviderDesc}</p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                onClick={providerModals.cancelDelete}
                data-tauri-drag-region="false"
              >
                {t.cancel}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  if (confirmDeleteProviderId) deleteProvider(confirmDeleteProviderId)
                  providerModals.cancelDelete()
                }}
                data-tauri-drag-region="false"
              >
                {t.deleteProvider}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )

  const focusHandlers = {
    onPointerEnter: requestWindowFocus,
    onPointerMove: requestWindowFocus,
    onPointerDownCapture: requestWindowFocus,
  }

  if (variant === 'embedded') {
    // 移动端二级菜单：未选子页时只显示一级设置列表（导航列占满整屏），
    // 进入子页后隐藏导航、内容区占满，靠页头返回按钮回到一级。
    const mobileDetail = paneNavigation && !hideNav && mobilePane !== null
    return (
      <div
        className={`settings-embedded kv flex min-h-0 min-w-0 flex-1 ${
          reserveTrafficLightSpace ? 'settings-embedded--traffic-safe' : ''
        }`}
      >
        {!hideNav && !mobileDetail && (
          <aside className="settings-embedded-nav">
            <h2 className="settings-embedded-nav-title" onMouseDown={handleSettingsDragMouseDown}>
              {t.settings}
            </h2>
            {categoryNav}
          </aside>
        )}
        {(!paneNavigation || hideNav || mobileDetail) && settingsMain}
        {settingsModals}
      </div>
    )
  }

  return (
    <div className="kv kv-window" {...focusHandlers}>
      <div className="kv-titlebar" onMouseDown={handleSettingsDragMouseDown}>
        <div className="kv-titlebar-spacer" aria-hidden="true" />
        <div className="kv-title">{t.settings}</div>
        <button
          type="button"
          onClick={() => handleCloseRequest()}
          className="kv-titlebar-close"
          data-tauri-drag-region="false"
          aria-label={t.cancel}
        >
          <X size={13} strokeWidth={2.2} />
        </button>
      </div>

      <div className="kv-body">
        <aside className="kv-sidebar">
          <div className="kv-sidebar-brand" onMouseDown={handleSettingsDragMouseDown}>
            <div className="kv-sidebar-brand-mark">
              <img src="/icon.png" alt="" aria-hidden="true" />
            </div>
            <div className="kv-sidebar-brand-name">Kivio</div>
            <div className="kv-sidebar-brand-ver">v{appVersion}</div>
          </div>
          {categoryNav}
        </aside>
        {settingsMain}
      </div>
      {settingsModals}
    </div>
  )
})
