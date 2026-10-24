import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AndroidRootfsState } from '../api/tauri'
import { WorkspacePanel } from './WorkspacePanel'
import { workspaceProgress } from './workspaceProgress'

type Handler = (event: { payload: AndroidRootfsState }) => void
const handlers: Handler[] = []

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: Handler) => {
    handlers.push(handler)
    return () => {}
  }),
}))

const readState = vi.fn<() => Promise<AndroidRootfsState>>()
const install = vi.fn<() => Promise<AndroidRootfsState>>()
const uninstall = vi.fn<() => Promise<AndroidRootfsState>>()

vi.mock('../api/tauri', () => ({
  api: {
    androidRootfsState: () => readState(),
    androidRootfsInstall: () => install(),
    androidRootfsUninstall: () => uninstall(),
  },
}))

function rootfs(patch: Partial<AndroidRootfsState> = {}): AndroidRootfsState {
  return {
    status: 'absent',
    received: 0,
    total: 4_028_030,
    message: null,
    root: '/data/user/0/io.kivio/files/rootfs',
    version: '3.24.2',
    ...patch,
  }
}

function push(patch: Partial<AndroidRootfsState>) {
  act(() => {
    for (const handler of handlers) handler({ payload: rootfs(patch) })
  })
}

beforeEach(() => {
  handlers.length = 0
  readState.mockReset().mockResolvedValue(rootfs())
  install.mockReset()
  uninstall.mockReset()
})

describe('WorkspacePanel', () => {
  it('未下载时给出下载入口，并显示后端返回的真实路径', async () => {
    render(<WorkspacePanel lang="zh" />)
    await waitFor(() => expect(screen.getByText('尚未下载')).toBeTruthy())
    expect(screen.getByRole('button', { name: /下载工作区/ })).toBeTruthy()
    expect(screen.getByText('/data/user/0/io.kivio/files/rootfs')).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('点击下载后按钮进入不可点状态，进度靠事件实时推进', async () => {
    let finish!: (value: AndroidRootfsState) => void
    install.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    render(<WorkspacePanel lang="zh" />)
    await waitFor(() => expect(screen.getByText('尚未下载')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /下载工作区/ }))

    // 命令还没返回，页面已经在等：此时只能靠进度事件驱动，不能停在 0%。
    push({ status: 'downloading', received: 0, total: 4_028_030 })
    expect(screen.getByText('下载中')).toBeTruthy()
    expect(screen.getByText('0%')).toBeTruthy()

    push({ status: 'downloading', received: 2_014_015, total: 4_028_030 })
    expect(screen.getByText('50%')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50')

    push({ status: 'extracting' })
    expect(screen.getByText('正在把解开的文件写进工作区')).toBeTruthy()
    expect(screen.getByText('100%')).toBeTruthy()

    await act(async () => {
      finish(rootfs({ status: 'ready', received: 4_028_030 }))
    })
    await waitFor(() => expect(screen.getByText('已就绪')).toBeTruthy())
    expect(screen.getByRole('button', { name: /卸载/ })).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('命令失败时展示后端汇总的原因，并允许重试', async () => {
    install.mockRejectedValue(new Error('下载失败：dl-cdn.alpinelinux.org: 连接失败（timeout）'))
    render(<WorkspacePanel lang="zh" />)
    await waitFor(() => expect(screen.getByText('尚未下载')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /下载工作区/ }))

    const alert = await waitFor(() => screen.getByRole('alert'))
    expect(alert.textContent).toContain('连接失败')
    expect(screen.getByRole('button', { name: /下载工作区/ })).toBeTruthy()
  })

  it('已就绪时只有卸载入口，且提示会清空工作区', async () => {
    readState.mockResolvedValue(rootfs({ status: 'ready' }))
    render(<WorkspacePanel lang="zh" />)
    await waitFor(() => expect(screen.getByText('已就绪')).toBeTruthy())
    expect(screen.getByRole('button', { name: /卸载/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /下载工作区/ })).toBeNull()
    expect(screen.getByText(/会清空工作区/)).toBeTruthy()
  })

  it('首屏快照晚到时不会盖掉已经推送的进度', async () => {
    let resolveSnapshot!: (value: AndroidRootfsState) => void
    readState.mockImplementation(() => new Promise((resolve) => { resolveSnapshot = resolve }))
    render(<WorkspacePanel lang="zh" />)

    push({ status: 'downloading', received: 1_007_000, total: 4_028_030 })
    expect(screen.getByText('25%')).toBeTruthy()

    await act(async () => {
      resolveSnapshot(rootfs({ status: 'absent', received: 0 }))
    })
    // 旧读数（absent）比事件旧，必须被忽略。
    expect(screen.getByText('25%')).toBeTruthy()
    expect(screen.queryByText('尚未下载')).toBeNull()
  })
})

describe('workspaceProgress', () => {
  it('按字节数换算百分比并夹在 0–100', () => {
    expect(workspaceProgress({ status: 'downloading', received: 0, total: 1000 }).percent).toBe(0)
    expect(workspaceProgress({ status: 'downloading', received: 256, total: 1000 }).percent).toBe(26)
    expect(workspaceProgress({ status: 'downloading', received: 2000, total: 1000 }).percent).toBe(100)
  })

  it('解包阶段固定满格', () => {
    expect(workspaceProgress({ status: 'extracting', received: 0, total: 0 })).toEqual({ percent: 100, indeterminate: false })
  })

  it('总字节数未知时标记为不确定，而不是显示 0% 完成', () => {
    expect(workspaceProgress({ status: 'downloading', received: 100, total: 0 })).toEqual({ percent: 0, indeterminate: true })
    expect(workspaceProgress({ status: 'downloading', received: 100, total: Number.NaN }).indeterminate).toBe(true)
  })
})
