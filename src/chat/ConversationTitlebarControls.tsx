import { memo } from 'react'
import { PanelRight } from 'lucide-react'
import { IconButton } from '../components/Button'
import { i18n, type Lang } from '../components/i18n'
import { BackgroundJobsIndicator } from './BackgroundJobsIndicator'
import { RuntimePicker } from './RuntimePicker'
import { ModelSelector } from './ModelSelector'
import { PermissionPicker } from './PermissionPicker'
import { ThinkingLevelSelector } from './ThinkingLevelSelector'
import type { AgentRuntimeConfig, ThinkingLevel } from './types'

export interface ConversationTitlebarControlsProps {
  activeAgentRuntime: AgentRuntimeConfig
  conversationId: string | null
  /** 有消息、或主窗已被弹出占住：锁死 kind / agent。 */
  runtimeLocked: boolean
  usesChatRuntime: boolean
  activeProviderId: string
  activeModel: string
  thinkingLevel: ThinkingLevel | null
  approvalPolicy: string
  dockOpen: boolean
  uiLang: Lang
  onRuntimeChange: (runtime: AgentRuntimeConfig) => void | Promise<void>
  onModelChange: (providerId: string, model: string) => void | Promise<void>
  onThinkingLevelChange: (level: ThinkingLevel | null) => void | Promise<void>
  onApprovalPolicyChange: (policy: string) => void
  onOpenDockTasks: () => void
  onToggleDock: () => void
}

/** 会话页顶栏控件。非 mac 渲染进全宽标题栏带，mac 仍留在主区 52px 顶栏。 */
export const ConversationTitlebarControls = memo(function ConversationTitlebarControls({
  activeAgentRuntime,
  conversationId,
  runtimeLocked,
  usesChatRuntime,
  activeProviderId,
  activeModel,
  thinkingLevel,
  approvalPolicy,
  dockOpen,
  uiLang,
  onRuntimeChange,
  onModelChange,
  onThinkingLevelChange,
  onApprovalPolicyChange,
  onOpenDockTasks,
  onToggleDock,
}: ConversationTitlebarControlsProps) {
  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <div className="shrink-0" data-tauri-drag-region="false">
          <RuntimePicker
            agentRuntime={activeAgentRuntime}
            onRuntimeChange={onRuntimeChange}
            conversationId={conversationId}
            locked={runtimeLocked}
          />
        </div>
        <div className="min-w-0 max-w-full shrink" data-tauri-drag-region="false">
          <ModelSelector
            currentProviderId={activeProviderId}
            currentModel={activeModel}
            onModelChange={onModelChange}
          />
        </div>
        <div className="shrink-0 chat-thinking-pill-wrap" data-tauri-drag-region="false">
          <ThinkingLevelSelector
            currentProviderId={activeProviderId}
            currentModel={activeModel}
            value={thinkingLevel}
            onChange={onThinkingLevelChange}
          />
        </div>
        <div className="shrink-0" data-tauri-drag-region="false">
          <PermissionPicker
            agentRuntime={activeAgentRuntime}
            approvalPolicy={approvalPolicy}
            onApprovalPolicyChange={onApprovalPolicyChange}
          />
        </div>
        {!usesChatRuntime && (
          <div className="shrink-0" data-tauri-drag-region="false">
            <BackgroundJobsIndicator
              conversationId={conversationId}
              onOpen={onOpenDockTasks}
            />
          </div>
        )}
      </div>
      <div className="min-w-5 flex-1" data-tauri-drag-region />
      <div className="flex min-w-0 shrink items-center justify-end gap-1">
        {!usesChatRuntime && (
          <div className="shrink-0" data-tauri-drag-region="false">
            <IconButton
              label={i18n[uiLang].dockToggle}
              size="sm"
              variant="ghost"
              className={dockOpen ? 'bg-neutral-900/5 text-neutral-800' : ''}
              onClick={onToggleDock}
            >
              <PanelRight size={15} />
            </IconButton>
          </div>
        )}
      </div>
    </>
  )
})
