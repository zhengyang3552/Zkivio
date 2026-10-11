import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { RuntimePicker } from './RuntimePicker'
import type { AgentRuntimeConfig } from './types'

describe('RuntimePicker（内置 Agent / Kivio Chat 切换）', () => {
  it('未 locked 时可在 Kivio Agent 与 Kivio Chat 之间切换', () => {
    const onRuntimeChange = vi.fn()
    render(
      <RuntimePicker
        agentRuntime={{ kind: 'builtin' }}
        onRuntimeChange={onRuntimeChange}
        conversationId="c1"
      />,
    )
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Kivio Agent' }))
    })
    expect(screen.queryByText('已绑定，新建可切换')).not.toBeInTheDocument()
    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'Kivio Chat' }))
    })
    expect(onRuntimeChange).toHaveBeenCalledWith({
      kind: 'chat',
      externalAgentId: null,
      externalModel: null,
      externalReasoning: null,
    })
  })

  it('locked 时非当前项置灰且不可切换', () => {
    const onRuntimeChange = vi.fn()
    render(
      <RuntimePicker
        agentRuntime={{ kind: 'chat' }}
        onRuntimeChange={onRuntimeChange}
        conversationId="c1"
        locked
      />,
    )
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /^Kivio Chat/ }))
    })
    expect(screen.getByText('已绑定，新建可切换')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Kivio Agent' })).toBeDisabled()
    act(() => {
      fireEvent.click(screen.getByRole('radio', { name: 'Kivio Agent' }))
    })
    expect(onRuntimeChange).not.toHaveBeenCalled()
    expect(screen.getByRole('radio', { name: 'Kivio Chat' })).not.toBeDisabled()
  })

  it('历史遗留的 external 运行时回落为 Kivio Agent 展示', () => {
    const legacy: AgentRuntimeConfig = { kind: 'external', externalAgentId: 'cursor' }
    render(
      <RuntimePicker agentRuntime={legacy} onRuntimeChange={vi.fn()} conversationId={null} />,
    )
    expect(screen.getByRole('button', { name: 'Kivio Agent' })).toBeInTheDocument()
  })
})
