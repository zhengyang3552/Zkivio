import { useState } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api/tauri'
import { i18n } from '../components/i18n'
import { makeProvider, makeSettings } from '../settings/tabs/testFixtures'
import { ProviderSetupPanel } from './ProviderSetupPanel'
import { DoneStep } from './steps/DoneStep'
import { WebSearchStep } from './steps/WebSearchStep'

vi.mock('../api/tauri', async () => {
  const actual = await vi.importActual<typeof import('../api/tauri')>('../api/tauri')
  return { ...actual, api: {
    ...actual.api,
    providerOAuthStart: vi.fn(async () => ({ loginId: 'login', userCode: 'CODE', verificationUrl: 'https://example.com/auth', interval: 3, expiresAt: 1900000000 })),
    providerOAuthPoll: vi.fn(async () => ({ status: 'authorized', interval: 3, auth: { provider: 'codex', credentialId: 'credential' } })),
    providerOAuthCancel: vi.fn(async () => {}),
    providerOAuthAccount: vi.fn(async () => ({ email: null, name: null, accountId: 'account' })),
    openExternal: vi.fn(async () => {}),
    testProviderConnection: vi.fn(async () => ({ success: true })),
  } }
})

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

describe('onboarding matches current capabilities', () => {
  it('authorizes an OAuth preset and tests with the unsaved credential reference', async () => {
    vi.useFakeTimers()
    function Setup() {
      const [settings, setSettings] = useState(makeSettings())
      return <ProviderSetupPanel t={i18n.zh} lang="zh" settings={settings} onChange={setSettings} />
    }
    render(<Setup />)
    fireEvent.click(screen.getByRole('button', { name: 'Codex OAuth' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '登录授权' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(screen.getByText('已授权')).toBeInTheDocument()
    expect(screen.queryByText(/设置会自动保存/)).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '测试连接' })) })
    expect(api.testProviderConnection).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      request: expect.objectContaining({ oauth: { provider: 'codex', credentialId: 'credential' } }),
      apiFormat: 'openai_responses',
    }))
  })

  it('reports chat search state in the done summary', () => {
    const settings = makeSettings({ providers: [makeProvider()] })
    render(<DoneStep t={i18n.zh} settings={settings} />)
    const summary = within(screen.getByText(i18n.zh.onboardingDoneSectionModels).parentElement as HTMLElement)
    const chatRow = summary.getByText(`${i18n.zh.webSearchChatSection} · ${i18n.zh.onboardingDoneWebSearch}`).closest('.onboarding-summary-row') as HTMLElement
    expect(chatRow).toBeInTheDocument()
  })

  it('no longer renders translation, Lens or hotkey sections', () => {
    const settings = makeSettings({ providers: [makeProvider()] })
    const { container } = render(<DoneStep t={i18n.zh} settings={settings} />)
    // 仅保留「模型与联网」一节，且只含 Chat 联网搜索一行。
    expect(container.querySelectorAll('.onboarding-summary-row')).toHaveLength(1)
    expect(screen.queryByText('Lens')).not.toBeInTheDocument()
    expect(screen.queryByText('全局快捷键')).not.toBeInTheDocument()
  })

  it('only offers the chat web-search toggle during onboarding', () => {
    render(<WebSearchStep t={i18n.zh} settings={makeSettings()} onChange={() => {}} />)
    const enableSection = screen.getByText(i18n.zh.onboardingWebSearchEnableSection).parentElement as HTMLElement
    expect(within(enableSection).getByText(i18n.zh.webSearchChatSection)).toBeInTheDocument()
    // Lens 已删除：不再有以它命名的开关行。
    expect(within(enableSection).queryByText('Lens')).not.toBeInTheDocument()
  })
})
