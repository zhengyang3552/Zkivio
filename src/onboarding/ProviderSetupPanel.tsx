import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { api, isOpenCodeFree, providerAuthenticationReady, type ModelProvider, type ProviderApiFormat, type Settings } from '../api/tauri'
import { applyModelCatalog } from '../data/modelCatalog'
import { ProviderModelsPicker } from '../settings/public/modelSelection'
import { Button, IconButton } from '../components/Button'
import { Input, Label, Select } from '../settings/public/controls'
import type { I18n, Lang } from '../components/i18n'
import { PROVIDER_PRESETS, type ProviderPreset } from '../settings/public/modelSelection'
import { ProviderOAuthPanel } from '../settings/public/providers'
import { ProviderIcon } from '../components/ModelIcon'
import { createProviderRequestDraft } from '../settings/public/providerDraft'

type ProviderSetupPanelProps = {
  t: I18n
  lang: Lang
  settings: Settings
  onChange: (settings: Settings) => void
}

function newProviderId(): string {
  return `provider-${Date.now()}`
}

function isPresetMatch(provider: ModelProvider, preset: ProviderPreset): boolean {
  return provider.name === preset.name && provider.baseUrl === preset.baseUrl
}

function isCustomProvider(provider: ModelProvider): boolean {
  return !PROVIDER_PRESETS.some((preset) => isPresetMatch(provider, preset))
}

function resolveActiveProviderId(settings: Settings): string {
  const chatId = settings.defaultModels.chat.providerId.trim()
  if (chatId) {
    const byChat = settings.providers.find((item) => item.id === chatId)
    if (byChat) return byChat.id
  }

  const configured = settings.providers.find((item) =>
    item.enabled !== false && item.enabledModels.length > 0,
  )
  if (configured) return configured.id

  return settings.providers[0]?.id ?? ''
}

function freshCustomProvider(id: string, lang: Lang, index: number): ModelProvider {
  const suffix = index > 0 ? ` ${index + 1}` : ''
  return {
    id,
    name: lang === 'zh' ? `自定义服务商${suffix}` : `Custom Provider${suffix}`,
    apiKeys: [],
    baseUrl: 'https://api.openai.com/v1',
    availableModels: [],
    enabledModels: [],
    enabled: true,
    apiFormat: 'openai_chat',
    request: createProviderRequestDraft(),
  }
}

function freshPresetProvider(preset: ProviderPreset, id: string): ModelProvider {
  return {
    id,
    name: preset.name,
    apiKeys: [],
    baseUrl: preset.baseUrl,
    availableModels: [],
    enabledModels: [],
    enabled: true,
    apiFormat: preset.apiFormat ?? 'openai_chat',
    request: createProviderRequestDraft(preset.oauth),
  }
}

function updateProviderInSettings(
  settings: Settings,
  providerId: string,
  patch: Partial<ModelProvider>,
): Settings {
  const providers = settings.providers.map((item) =>
    item.id === providerId ? { ...item, ...patch } : item,
  )
  return { ...settings, providers }
}

function addPresetProvider(settings: Settings, preset: ProviderPreset): { settings: Settings; id: string } {
  const existing = settings.providers.find((item) => isPresetMatch(item, preset))
  if (existing) {
    return { settings, id: existing.id }
  }

  const id = newProviderId()
  const provider = freshPresetProvider(preset, id)
  return {
    settings: { ...settings, providers: [...settings.providers, provider] },
    id,
  }
}

function addCustomProvider(settings: Settings, lang: Lang): { settings: Settings; id: string } {
  const customCount = settings.providers.filter(isCustomProvider).length
  const id = newProviderId()
  const provider = freshCustomProvider(id, lang, customCount)
  return {
    settings: { ...settings, providers: [...settings.providers, provider] },
    id,
  }
}

function deleteProviderFromSettings(settings: Settings, id: string): Settings {
  const nextProviders = settings.providers.filter((item) => item.id !== id)
  const deletedProviderWasChatModel =
    settings.defaultModels.chat.providerId === id || settings.chatProviderId === id

  const next: Settings = {
    ...settings,
    providers: nextProviders,
    defaultModels: {
      ...settings.defaultModels,
      chat: settings.defaultModels.chat.providerId === id
        ? { providerId: '', model: '' }
        : settings.defaultModels.chat,
    },
    chatProviderId: deletedProviderWasChatModel ? '' : settings.chatProviderId,
    chatModel: deletedProviderWasChatModel ? '' : settings.chatModel,
  }

  return next
}

export function ProviderSetupPanel({ t, lang, settings, onChange }: ProviderSetupPanelProps) {
  const initializedRef = useRef(false)
  const [activeProviderId, setActiveProviderId] = useState(() => resolveActiveProviderId(settings))
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testFeedback, setTestFeedback] = useState<{ ok: boolean; message: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const provider = useMemo(
    () => settings.providers.find((item) => item.id === activeProviderId),
    [activeProviderId, settings.providers],
  )

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true
    const resolvedId = resolveActiveProviderId(settings)
    if (resolvedId) setActiveProviderId(resolvedId)
  }, [settings])

  useEffect(() => {
    if (activeProviderId && settings.providers.some((item) => item.id === activeProviderId)) return
    const resolvedId = resolveActiveProviderId(settings)
    setActiveProviderId(resolvedId)
  }, [activeProviderId, settings])

  const selectProvider = useCallback((providerId: string) => {
    setActiveProviderId(providerId)
    setTestFeedback(null)
    setConfirmDelete(false)
  }, [])

  const handleAddPreset = useCallback((preset: ProviderPreset) => {
    const { settings: next, id } = addPresetProvider(settings, preset)
    onChange(next)
    selectProvider(id)
  }, [onChange, selectProvider, settings])

  const handleAddCustom = useCallback(() => {
    const { settings: next, id } = addCustomProvider(settings, lang)
    onChange(next)
    selectProvider(id)
  }, [lang, onChange, selectProvider, settings])

  const updateProvider = useCallback((patch: Partial<ModelProvider>) => {
    if (!provider) return
    onChange(updateProviderInSettings(settings, provider.id, patch))
  }, [onChange, provider, settings])

  const handleDeleteProvider = useCallback(() => {
    if (!provider) return
    const next = deleteProviderFromSettings(settings, provider.id)
    onChange(next)
    setConfirmDelete(false)
    setModelPickerOpen(false)
    setTestFeedback(null)
    setActiveProviderId(resolveActiveProviderId(next))
  }, [onChange, provider, settings])

  const fetchModels = async () => {
    if (!provider || fetching) return
    setFetching(true)
    try {
      const catalog = await api.fetchModelCatalog(provider.id, {
        id: provider.id,
        baseUrl: provider.baseUrl,
        apiKeys: provider.apiKeys,
        activeKeyIndex: provider.activeKeyIndex,
        apiFormat: provider.apiFormat,
        request: provider.request,
      })
      updateProvider(applyModelCatalog(provider, catalog))
    } catch (err) {
      console.error('Failed to fetch models:', err)
    } finally {
      setFetching(false)
    }
  }

  const handleTestConnection = async () => {
    if (!provider) return
    setTesting(true)
    setTestFeedback(null)
    try {
      const result = await api.testProviderConnection(provider.id, {
        id: provider.id,
        baseUrl: provider.baseUrl,
        apiKeys: provider.apiKeys,
        activeKeyIndex: provider.activeKeyIndex,
        apiFormat: provider.apiFormat,
        request: provider.request,
        model: provider.enabledModels[0] ?? provider.availableModels[0],
      })
      if (result.success) {
        setTestFeedback({ ok: true, message: t.connectionOk })
      } else {
        setTestFeedback({
          ok: false,
          message: `${t.connectionFailed}${result.error || 'Unknown error'}`,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setTestFeedback({ ok: false, message: `${t.connectionFailed}${message}` })
    } finally {
      setTesting(false)
    }
  }

  const openModelPicker = () => {
    if (!provider) return
    setModelPickerOpen(true)
  }

  // 未添加过的预设直接以「+ 名称」虚线 chip 混排在服务商列表尾部，避免「已添加」和「快速添加」两块重复列表。
  const unaddedPresets = PROVIDER_PRESETS.filter(
    (preset) => !settings.providers.some((item) => isPresetMatch(item, preset)),
  )

  return (
    <div className="onboarding-provider-panel">
      <div className="onboarding-section">
        <div className="onboarding-section-label">{t.onboardingProviderList}</div>
        <div className="onboarding-pick-grid">
          {settings.providers.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`onboarding-pick${item.id === activeProviderId ? ' active' : ''}`}
              onClick={() => selectProvider(item.id)}
              data-tauri-drag-region="false"
            >
              <ProviderIcon name={item.name} baseUrl={item.baseUrl} size={14} />
              {item.name.trim() || item.id}
            </button>
          ))}
          {unaddedPresets.map((preset) => (
            <button
              key={preset.name}
              type="button"
              className="onboarding-pick onboarding-pick--add"
              onClick={() => handleAddPreset(preset)}
              data-tauri-drag-region="false"
            >
              <ProviderIcon name={preset.name} baseUrl={preset.baseUrl} size={14} />
              {preset.name}
            </button>
          ))}
          <button
            type="button"
            className="onboarding-pick onboarding-pick--add"
            onClick={handleAddCustom}
            data-tauri-drag-region="false"
          >
            <Plus size={12} />
            {t.onboardingProviderAddCustom}
          </button>
        </div>
        {settings.providers.length === 0 ? (
          <p className="onboarding-panel-note">{t.onboardingProviderEmpty}</p>
        ) : null}

        {provider ? (
          <div className="onboarding-card onboarding-provider-card">
            <ProviderOAuthPanel
              key={provider.id}
              provider={provider}
              lang={lang}
              authorizedNotice={t.onboardingProviderAuthorized}
              onUpdateProvider={(id, patch) => onChange(updateProviderInSettings(settings, id, patch))}
            />
            <div className="onboarding-provider-grid">
              <div className="onboarding-field">
                <Label>{t.onboardingProviderName}</Label>
                <Input
                  value={provider.name}
                  onChange={(value) => updateProvider({ name: value })}
                  placeholder={t.onboardingProviderCustom}
                />
              </div>
              <div className="onboarding-field">
                <Label>{t.baseUrl}</Label>
                <Input
                  value={provider.baseUrl}
                  disabled={Boolean(provider.request.oauth)}
                  onChange={(value) => {
                    const baseUrlChanged = value !== provider.baseUrl
                    updateProvider({
                      baseUrl: value,
                      ...(baseUrlChanged ? { availableModels: [], enabledModels: [] } : {}),
                    })
                  }}
                  placeholder="https://api.example.com/v1"
                  mono
                />
              </div>
            </div>

            <div className="onboarding-field">
              <Label>{t.onboardingProviderProtocol}</Label>
              <Select
                value={provider.apiFormat}
                disabled={Boolean(provider.request.oauth)}
                onChange={(value) => updateProvider({ apiFormat: value as ProviderApiFormat, availableModels: [], enabledModels: [] })}
                options={[
                  { value: 'openai_chat', label: 'OpenAI Chat' },
                  { value: 'openai_responses', label: 'OpenAI Responses' },
                  { value: 'anthropic_messages', label: 'Anthropic' },
                  { value: 'gemini', label: 'Gemini' },
                  { value: 'xai_responses', label: 'Grok (xAI)' },
                ]}
              />
            </div>
            {isOpenCodeFree(provider) ? <p className="onboarding-panel-note">{t.onboardingProviderFreeHint}</p> : null}
            {!provider.request.oauth && !isOpenCodeFree(provider) ? <div className="onboarding-field">
              <Label>{t.onboardingProviderApiKey}</Label>
              <Input
                type="password"
                value={provider.apiKeys[0] || ''}
                onChange={(value) => updateProvider({ apiKeys: [value.trim(), ...provider.apiKeys.slice(1)] })}
                placeholder="sk-..."
                mono
              />
              <p className="onboarding-field-hint">{t.onboardingProviderKeyHint}</p>
              {(() => {
                // 命中快速预设 baseUrl 时，给出「获取 API Key」外链引导申请（与设置页一致）。
                const preset = PROVIDER_PRESETS.find(
                  (p) => p.baseUrl === provider.baseUrl && p.apiKeyUrl,
                )
                if (!preset?.apiKeyUrl) return null
                return (
                  <button
                    type="button"
                    onClick={() => void api.openExternal(preset.apiKeyUrl!)}
                    className="inline-flex w-fit items-center text-[12px] text-indigo-500 hover:underline dark:text-indigo-300"
                    data-tauri-drag-region="false"
                  >
                    {lang === 'zh' ? `获取 ${preset.name} API Key ↗` : `Get ${preset.name} API key ↗`}
                  </button>
                )
              })()}
            </div> : null}

            <div className="onboarding-action-row">
              <Button
                onClick={() => void handleTestConnection()}
                disabled={testing || !providerAuthenticationReady(provider)}
                data-tauri-drag-region="false"
              >
                {testing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                {t.onboardingProviderTest}
              </Button>
              <Button
                variant="primary"
                onClick={openModelPicker}
                disabled={!providerAuthenticationReady(provider)}
                data-tauri-drag-region="false"
              >
                {t.onboardingProviderManageModels}
                {provider.enabledModels.length > 0 ? ` · ${provider.enabledModels.length}` : ''}
              </Button>
              {testFeedback ? (
                <span className={`kv-tag ${testFeedback.ok ? 'ok' : 'danger'}`}>{testFeedback.message}</span>
              ) : null}
              <IconButton
                variant="danger"
                size="xs"
                className="onboarding-action-trailing"
                onClick={() => setConfirmDelete(true)}
                data-tauri-drag-region="false"
                title={t.deleteProvider}
                label={t.deleteProvider}
              >
                <Trash2 size={13} />
              </IconButton>
            </div>

            {provider.enabledModels.length > 0 ? (
              <div className="onboarding-model-list">
                {provider.enabledModels.map((model) => (
                  <span key={model} className="onboarding-model-chip">
                    <Check size={12} />
                    {model}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {confirmDelete && provider ? (
        <div
          className="kv-modal-backdrop kv-modal-backdrop--portal"
          data-tauri-drag-region="false"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirmDelete(false)
          }}
        >
          <div className="kv-modal space-y-3" data-tauri-drag-region="false">
            <h3 className="text-[14px] font-semibold">{t.confirmDeleteProvider}</h3>
            <p className="kv-panel-body">{t.onboardingProviderDeleteDesc}</p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                onClick={() => setConfirmDelete(false)}
                data-tauri-drag-region="false"
              >
                {t.cancel}
              </Button>
              <Button
                variant="danger"
                onClick={handleDeleteProvider}
                data-tauri-drag-region="false"
              >
                {t.deleteProvider}
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {modelPickerOpen && provider ? (
        <ProviderModelsPicker
          provider={provider}
          lang={lang}
          labels={{
            title: t.onboardingProviderManageModels,
            searchPlaceholder: lang === 'zh' ? '搜索模型 ID 或名称' : 'Search model ID or name',
            fetchModels: t.fetchModels,
            fetching: t.fetching,
            addModel: t.addModel,
            manualAddModel: t.manualAddModel,
            noModels: lang === 'zh' ? '没有可用模型。点刷新重试，或手动添加。' : 'No models yet. Refresh or add one manually.',
            noSearchResults: lang === 'zh' ? '没有匹配的模型' : 'No matching models',
            enabled: t.enabled,
            addAllModels: lang === 'zh' ? '添加当前列表中的全部模型' : 'Add all models in the current list',
            close: lang === 'zh' ? '关闭' : 'Close',
          }}
          fetching={fetching}
          onClose={() => setModelPickerOpen(false)}
          onFetch={() => void fetchModels()}
          onAdd={(model) => {
            if (provider.enabledModels.includes(model)) return
            onChange(updateProviderInSettings(settings, provider.id, {
              enabledModels: [...provider.enabledModels, model],
            }))
          }}
          onAddAll={(models) => {
            const merged = [...provider.enabledModels]
            for (const model of models) {
              if (!merged.includes(model)) merged.push(model)
            }
            onChange(updateProviderInSettings(settings, provider.id, { enabledModels: merged }))
          }}
          onRemove={(model) => {
            onChange(updateProviderInSettings(settings, provider.id, {
              enabledModels: provider.enabledModels.filter((item) => item !== model),
            }))
          }}
        />
      ) : null}
    </div>
  )
}
