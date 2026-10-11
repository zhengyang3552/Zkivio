import { Eye, FilePen, ListChecks, Network, ShieldAlert, ShieldCheck, ShieldQuestion, Target, Zap } from 'lucide-react'
import { APPROVAL_POLICY_OPTIONS } from './approvalPolicies'
import type { AgentPlanMode, AgentRuntimeConfig } from './types'

/** 胶囊配色语义：Act=neutral、Plan=emerald、Orchestrate=violet。 */
export type ModeTone = 'neutral' | 'emerald' | 'violet'

export interface ModeOption {
  value: string
  label: string
  /** 菜单里的副标题。 */
  description?: string
  icon: typeof Zap
  tone: ModeTone
}

/** 哪个控件在问档位：顶栏权限按钮，还是底栏模式胶囊。 */
export type ModeTarget = 'titlebar' | 'composer'

export interface PermissionModesInput {
  target: ModeTarget
  agentRuntime: AgentRuntimeConfig
  /** 内置会话 + titlebar：工具审批策略当前值。 */
  approvalPolicy?: string | null
  /** 内置 Agent 会话 + composer：Kivio 三档当前值。 */
  agentPlanMode?: AgentPlanMode | null
  /** An unfinished Goal selects the Goal entry without changing the persisted Act strategy. */
  goalActive?: boolean
}

export interface PermissionModes {
  options: ModeOption[]
  current: string
}

/** Kivio Agent 模式 —— 仅内置 Agent 运行时显示；Kivio Chat 不显示此胶囊。 */
export const AGENT_MODE_OPTIONS: ModeOption[] = [
  { value: 'act', label: 'Act', description: '普通模式 · Normal', icon: Zap, tone: 'neutral' },
  { value: 'goal', label: 'Goal', description: '持续执行一个目标 · Persistent execution', icon: Target, tone: 'violet' },
  { value: 'plan', label: 'Plan', description: '生成计划文档 · Plan document', icon: ListChecks, tone: 'emerald' },
  {
    value: 'orchestrate',
    label: 'Orchestrate',
    description: '主代理统筹并行协作 · Parallel collaboration',
    icon: Network,
    tone: 'violet',
  },
]

/** Distinct icon per permission level so the capsule reflects the active mode at a glance. */
export function modeIcon(value: string, label: string) {
  if (value === 'always_confirm') return ShieldAlert
  if (value === 'readonly_auto_sensitive_confirm') return ShieldQuestion
  if (value === 'auto') return ShieldCheck
  if (/计划|只读|read|plan/i.test(label)) return Eye
  if (/编辑|edit/i.test(label)) return FilePen
  if (/完全|默认|full|default/i.test(label)) return ShieldCheck
  return ShieldAlert
}

/**
 * 档位推导的唯一入口。空 options 表示该控件此刻无档位可选 → 调用方不渲染。
 *
 * - Kivio Chat 运行时：不是 Agent，底栏不显示 Act/Plan/Orchestrate。
 * - 内置 Agent 会话：底栏是 Act / Plan / Orchestrate，顶栏是工具审批策略。
 */
export function derivePermissionModes({
  target,
  agentRuntime,
  approvalPolicy,
  agentPlanMode,
  goalActive = false,
}: PermissionModesInput): PermissionModes {
  const usesChat = agentRuntime.kind === 'chat'

  // Kivio Chat is a separate runtime (not an agent strategy mode).
  if (usesChat) {
    return { options: [], current: '' }
  }

  if (target === 'composer') {
    const current = goalActive
      ? 'goal'
      : AGENT_MODE_OPTIONS.some((option) => option.value === agentPlanMode)
      ? (agentPlanMode as string)
      : AGENT_MODE_OPTIONS[0].value
    return { options: AGENT_MODE_OPTIONS, current }
  }

  const options: ModeOption[] = APPROVAL_POLICY_OPTIONS.map((option) => ({
    value: option.value,
    label: option.label,
    description: option.description,
    icon: modeIcon(option.value, option.label),
    tone: 'neutral',
  }))
  return { options, current: approvalPolicy ?? APPROVAL_POLICY_OPTIONS[1]?.value ?? '' }
}
