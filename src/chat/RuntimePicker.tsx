import { memo, useState } from 'react'
import { useT } from '../components/i18n'
import type { AgentRuntimeConfig } from './types'
import './runtimePicker.css'

const KIVIO_LOGO_SRC = '/logo-mark.png'

/** Same brand mark as Agent; `variant` only changes color treatment so the shape stays identical. */
function KivioMark({
  size = 20,
  variant = 'agent',
}: {
  size?: number
  variant?: 'agent' | 'chat'
}) {
  return (
    <img
      src={KIVIO_LOGO_SRC}
      alt=""
      aria-hidden="true"
      className={
        variant === 'chat'
          ? 'kv-runtime-picker__builtin-logo kv-runtime-picker__builtin-logo--chat'
          : 'kv-runtime-picker__builtin-logo'
      }
      width={size}
      height={size}
      draggable={false}
    />
  )
}

interface RuntimePickerProps {
  agentRuntime: AgentRuntimeConfig
  onRuntimeChange: (runtime: AgentRuntimeConfig) => void
  conversationId?: string | null
  // 一 agent 一对话：已有消息的会话锁定运行时来源（内置 / Kivio Chat 均不可换）。
  // 锁定时 popover 仍可展开查看，但所有切换项 disabled 并显示提示行。
  locked?: boolean
}

const BUILTIN: AgentRuntimeConfig = {
  kind: 'builtin',
  externalAgentId: null,
  externalModel: null,
  externalReasoning: null,
}

const CHAT: AgentRuntimeConfig = {
  kind: 'chat',
  externalAgentId: null,
  externalModel: null,
  externalReasoning: null,
}

function RuntimePickerBase({ agentRuntime, onRuntimeChange, locked = false }: RuntimePickerProps) {
  const t = useT()
  const [open, setOpen] = useState(false)

  const usesChat = agentRuntime.kind === 'chat'
  const usesBuiltinAgent = !usesChat

  const label = usesChat ? 'Kivio Chat' : 'Kivio Agent'

  const selectBuiltin = () => {
    if (locked) return
    onRuntimeChange(BUILTIN)
    setOpen(false)
  }

  const selectChat = () => {
    if (locked) return
    onRuntimeChange(CHAT)
    setOpen(false)
  }

  return (
    <div className="kv-runtime-picker" data-tauri-drag-region="false">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`kv-runtime-picker__chip${open ? ' is-open' : ''}`}
        title={locked ? `${label} · ${t.chatRuntimeBoundHint}` : label}
        aria-label={locked ? `${label} · ${t.chatRuntimeBoundHint}` : label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <KivioMark size={18} variant={usesChat ? 'chat' : 'agent'} />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="kv-runtime-picker__popover chat-motion-popover" role="menu">
            <div className="kv-runtime-picker__row">
              <div className="kv-runtime-picker__agents-head">
                <span className="kv-runtime-picker__label">{t.chatRuntimeAgent}</span>
                {locked && (
                  <span className="kv-runtime-picker__bound-note" title={t.chatRuntimeBoundHint}>
                    {t.chatRuntimeBoundShort}
                  </span>
                )}
              </div>
              {/* Kivio 自己就有两种运行形态：Agent（带工具的策略执行）与 Chat（纯对话）。 */}
              <div className="kv-runtime-picker__agent-grid" role="radiogroup">
                <button
                  type="button"
                  role="radio"
                  aria-checked={usesBuiltinAgent}
                  disabled={locked && !usesBuiltinAgent}
                  onClick={selectBuiltin}
                  className={`kv-runtime-picker__agent${usesBuiltinAgent ? ' is-active' : ''}`}
                >
                  <KivioMark size={20} variant="agent" />
                  <span className="kv-runtime-picker__agent-name">Kivio Agent</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={usesChat}
                  disabled={locked && !usesChat}
                  onClick={selectChat}
                  className={`kv-runtime-picker__agent${usesChat ? ' is-active' : ''}`}
                >
                  <KivioMark size={20} variant="chat" />
                  <span className="kv-runtime-picker__agent-name">Kivio Chat</span>
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * 保留导出名以维持调用点不变。移动端没有本地 CLI，模型与思考档一律走内置模型选择器，
 * 此组件恒为空（不再接收 props，避免把已移除的 CLI 运行时概念留在类型里）。
 */
export function ExternalModelSelector(): null {
  return null
}

// memo：顶栏选择器，仅在 props 变化时重渲。
export const RuntimePicker = memo(RuntimePickerBase)
