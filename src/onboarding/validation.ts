import { providerAuthenticationReady } from '../api/tauri'
import type { Settings } from '../api/tauri'
import { isWebSearchConfigured } from '../settings/public/webSearch'

export function providerHasUsableConfig(settings: Settings): boolean {
  return settings.providers.some((provider) =>
    provider.enabled !== false
    && providerAuthenticationReady(provider)
    && provider.enabledModels.length > 0,
  )
}

export function isProviderModelBindingUsable(
  settings: Settings,
  providerId: string,
  model: string,
): boolean {
  const id = providerId.trim()
  const modelName = model.trim()
  if (!id || !modelName) return false

  const provider = settings.providers.find((item) => item.id === id)
  if (!provider || provider.enabled === false) return false
  if (!provider.baseUrl || provider.baseUrl.trim() === '') return false
  if (!providerAuthenticationReady(provider)) return false
  if (provider.enabledModels.length === 0) return false
  return provider.enabledModels.includes(modelName)
}

// 手机端没有截图翻译 / Lens 窗口，只有常规对话与网页搜索，因此引导只要求至少一个可用供应商。
export function validateProviderStep(settings: Settings): { ok: boolean; reason?: string } {
  if (settings.providers.length === 0) {
    return { ok: false, reason: 'no_provider' }
  }
  return { ok: true }
}

export function canCompleteOnboarding(settings: Settings): boolean {
  return validateProviderStep(settings).ok
}

export function webSearchConfigured(settings: Settings): boolean {
  return isWebSearchConfigured(settings.lens?.webSearch)
}
