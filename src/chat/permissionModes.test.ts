import { describe, expect, it } from 'vitest'
import { derivePermissionModes } from './permissionModes'
import type { AgentRuntimeConfig } from './types'

const builtinRuntime: AgentRuntimeConfig = { kind: 'builtin' }
const chatRuntime: AgentRuntimeConfig = { kind: 'chat' }

describe('derivePermissionModes（底栏模式胶囊）', () => {
  it('内置 Agent 会话给 Kivio 四档', () => {
    const { options, current } = derivePermissionModes({
      target: 'composer',
      agentRuntime: builtinRuntime,
      agentPlanMode: 'plan',
    })
    expect(options.map((o) => o.value)).toEqual(['act', 'goal', 'plan', 'orchestrate'])
    expect(options.map((o) => o.label)).toEqual(['Act', 'Goal', 'Plan', 'Orchestrate'])
    expect(current).toBe('plan')
  })

  it('未完成 Goal 在底栏保持选中，同时后端策略仍为 Act', () => {
    expect(derivePermissionModes({
      target: 'composer',
      agentRuntime: builtinRuntime,
      agentPlanMode: 'act',
      goalActive: true,
    }).current).toBe('goal')
  })

  it('内置会话没有档位状态时回落 act', () => {
    expect(derivePermissionModes({
      target: 'composer',
      agentRuntime: builtinRuntime,
      agentPlanMode: null,
    }).current).toBe('act')
  })

  it('Kivio Chat 运行时底栏无 Act/Plan/Orchestrate（独立 runtime）', () => {
    expect(derivePermissionModes({
      target: 'composer',
      agentRuntime: chatRuntime,
      agentPlanMode: 'act',
    }).options).toEqual([])
  })
})

describe('derivePermissionModes（顶栏权限按钮）', () => {
  it('内置会话给工具审批策略三档', () => {
    const { options, current } = derivePermissionModes({
      target: 'titlebar',
      agentRuntime: builtinRuntime,
      approvalPolicy: 'auto',
    })
    expect(options.map((o) => o.value)).toEqual([
      'always_confirm',
      'readonly_auto_sensitive_confirm',
      'auto',
    ])
    expect(current).toBe('auto')
  })

  it('没有显式策略时回落到「敏感确认」', () => {
    expect(derivePermissionModes({
      target: 'titlebar',
      agentRuntime: builtinRuntime,
    }).current).toBe('readonly_auto_sensitive_confirm')
  })

  it('Kivio Chat 顶栏也无档位表', () => {
    expect(derivePermissionModes({
      target: 'titlebar',
      agentRuntime: chatRuntime,
    }).options).toEqual([])
  })
})
