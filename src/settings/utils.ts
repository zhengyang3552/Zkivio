import { type ModelProvider } from '../api/tauri'

export type Platform = 'macos' | 'windows' | 'linux'

export type SelectOption = {
  value: string
  label: string
  title?: string
}

/**
 * 平台检测（用于快捷键可视化）
 */
export const getPlatform = (): Platform => {
  if (navigator.platform.startsWith('Mac')) return 'macos'
  if (navigator.platform.startsWith('Win')) return 'windows'
  return 'linux'
}

/**
 * 将快捷键字符串解析为可视化按键数组
 */
export const formatHotkey = (hotkey: string, platform: 'macos' | 'windows' | 'linux'): string[] => {
  const parts = hotkey.split('+')
  return parts.map((part) => {
    switch (part) {
      case 'CommandOrControl':
        return platform === 'macos' ? '⌘' : 'Ctrl'
      case 'Command':
        return '⌘'
      case 'Control':
        return 'Ctrl'
      case 'Alt':
        return platform === 'macos' ? '⌥' : 'Alt'
      case 'Shift':
        return platform === 'macos' ? '⇧' : 'Shift'
      case 'Escape':
        return 'Esc'
      case 'Space':
        return 'Space'
      case 'ArrowUp':
        return '↑'
      case 'ArrowDown':
        return '↓'
      case 'ArrowLeft':
        return '←'
      case 'ArrowRight':
        return '→'
      default:
        return part.length === 1 ? part.toUpperCase() : part
    }
  })
}

export const modelPairValue = (providerId: string, model: string) =>
  JSON.stringify([providerId, model])

export const parseModelPairValue = (value: string): [string, string] => {
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed) && parsed.length >= 2) {
      return [String(parsed[0] || ''), String(parsed[1] || '')]
    }
  } catch {
    // 兼容旧版本用 "provider:model" 拼接的下拉值。
  }
  const separator = value.indexOf(':')
  if (separator < 0) return [value, '']
  return [value.slice(0, separator), value.slice(separator + 1)]
}

export const isProviderEnabled = (provider: ModelProvider) => provider.enabled !== false

export const buildModelPairOptions = (
  providers: ModelProvider[],
  filterModel?: (provider: ModelProvider, model: string) => boolean,
): SelectOption[] =>
  providers
    .filter(provider => isProviderEnabled(provider))
    .flatMap(provider =>
      provider.enabledModels
        .filter(model => !filterModel || filterModel(provider, model))
        .map(model => ({
          value: modelPairValue(provider.id, model),
          label: `${provider.name} - ${model}`,
          title: `${provider.name} - ${model}`,
        })),
    )

/**
 * 与 JSON.stringify 等价但对对象 key 做递归排序,用于 dirty diff:
 * 后端 sanitize 与前端 spread 都可能改变字段顺序,普通 JSON.stringify 会
 * 把"语义无差异、字段顺序不同"误判为脏。数组顺序保留(数组顺序在 settings
 * 里语义上是有意义的,如 apiKeys 的 primary/backup 顺序)。
 */
export const stableStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k]
      }
      return sorted
    }
    return v
  })

