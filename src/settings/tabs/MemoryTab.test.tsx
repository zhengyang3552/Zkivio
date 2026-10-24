import { render } from '../../test/renderWithNotices'
import { screen, within } from '@testing-library/react'
import { AppDialogHost } from '../../components/AppDialog'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MemoryTab } from './MemoryTab'
import { i18n } from '../../components/i18n'

const t = i18n.zh
void t

// jsdom 没有原生 <dialog> 行为；确认框用例需要它。
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

/**
 * 回归重点：
 *   1. L1 / L2 两个编辑器的 value / savedValue / maxBytes 不串（同类型，接错不报错）
 *   2. onDraftChange 带上正确的 layer（shell 侧靠它写对 key，并清 success 提示）
 *   3. L1 超字节上限时禁用保存
 *   4. 已存记忆按条目列出，改写 / 删除回写整份内容
 */
type Props = Parameters<typeof MemoryTab>[0]

const L1 = '# L1 Online Memory\n\n## 偏好\n\n回答用中文。\n\n## 工具\n\n先读再改。\n'
const L2 = '# L2 Long-Term Memory\n\n## 项目\n\nZkivio 用 Tauri。\n'

function renderTab(overrides: Partial<Props> = {}) {
  const props = {
    lang: 'zh' as const,
    chatMemory: { enabled: true } as Props['chatMemory'],
    memoryDir: '/tmp/kivio/memory',
    memoryError: '',
    memorySuccess: '',
    memoryLoading: false,
    memorySavingLayer: null,
    memoryDrafts: { l1: 'L1 内容', l2: 'L2 内容' },
    memorySnapshots: { l1: 'L1 内容', l2: 'L2 内容' },
    onUpdateChatMemory: vi.fn(),
    onRefresh: vi.fn(),
    onOpenFolder: vi.fn(),
    onDraftChange: vi.fn(),
    onSaveLayer: vi.fn(),
    onReplaceLayerContent: vi.fn(),
    ...overrides,
  }
  render(<><AppDialogHost /><MemoryTab {...props} /></>)
  return props
}

describe('MemoryTab', () => {
  it('L1 / L2 各自回显自己的草稿（不串）', () => {
    renderTab()
    expect(screen.getByDisplayValue('L1 内容')).toBeTruthy()
    expect(screen.getByDisplayValue('L2 内容')).toBeTruthy()
  })

  it('只有 L1 显示字节上限', () => {
    renderTab()
    // L1 带 maxBytes → "x / 5000 bytes"；L2 只有 "x bytes"
    expect(screen.getByText(/\/ 5000 bytes/)).toBeTruthy()
  })

  it('编辑 L1 时 onDraftChange 带 layer=l1', async () => {
    const props = renderTab()
    const areas = screen.getAllByRole('textbox')
    await userEvent.type(areas[0], 'x')
    expect(props.onDraftChange).toHaveBeenCalledWith('l1', expect.stringContaining('x'))
  })

  it('编辑 L2 时 onDraftChange 带 layer=l2', async () => {
    const props = renderTab()
    const areas = screen.getAllByRole('textbox')
    await userEvent.type(areas[1], 'y')
    expect(props.onDraftChange).toHaveBeenCalledWith('l2', expect.stringContaining('y'))
  })

  it('草稿与快照一致时保存按钮禁用', () => {
    renderTab()
    for (const btn of screen.getAllByRole('button', { name: '保存' })) {
      expect(btn).toBeDisabled()
    }
  })

  it('草稿改动后保存按钮可用，点击带对应 layer', async () => {
    const props = renderTab({
      memoryDrafts: { l1: 'L1 改过', l2: 'L2 内容' },
    })
    const saves = screen.getAllByRole('button', { name: '保存' })
    expect(saves[0]).not.toBeDisabled()
    await userEvent.click(saves[0])
    expect(props.onSaveLayer).toHaveBeenCalledWith('l1')
  })

  it('L1 超 5000 字节时禁用保存', () => {
    renderTab({
      memoryDrafts: { l1: 'x'.repeat(5001), l2: 'L2 内容' },
      memorySnapshots: { l1: '', l2: 'L2 内容' },
    })
    expect(screen.getAllByRole('button', { name: '保存' })[0]).toBeDisabled()
  })

  it('显示记忆目录路径', () => {
    renderTab()
    expect(screen.getByText('/tmp/kivio/memory')).toBeTruthy()
  })

  it('错误与成功提示分别渲染', () => {
    renderTab({ memoryError: '读取失败' })
    expect(screen.getByText('读取失败')).toBeTruthy()
  })

  it('保存中状态只作用于对应层', () => {
    renderTab({ memorySavingLayer: 'l2' })
    expect(screen.getAllByRole('button', { name: '保存中' })).toHaveLength(1)
  })

  it('已存记忆按小节列出，默认显示 L1 的条目数', () => {
    renderTab({ memorySnapshots: { l1: L1, l2: L2 }, memoryDrafts: { l1: L1, l2: L2 } })
    expect(screen.getByRole('button', { name: 'L1 · 2' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'L2 · 1' })).toBeTruthy()
    expect(screen.getByText('偏好')).toBeTruthy()
    expect(screen.getByText('工具')).toBeTruthy()
  })

  it('切换到 L2 后只列出 L2 的条目', async () => {
    renderTab({ memorySnapshots: { l1: L1, l2: L2 }, memoryDrafts: { l1: L1, l2: L2 } })
    await userEvent.click(screen.getByRole('button', { name: 'L2 · 1' }))
    expect(screen.getByText('项目')).toBeTruthy()
    expect(screen.queryByText('偏好')).toBeNull()
  })

  it('搜索框按标题与正文过滤', async () => {
    renderTab({ memorySnapshots: { l1: L1, l2: L2 }, memoryDrafts: { l1: L1, l2: L2 } })
    await userEvent.type(screen.getByRole('searchbox'), '中文')
    expect(screen.getByText('偏好')).toBeTruthy()
    expect(screen.queryByText('工具')).toBeNull()
  })

  it('编辑条目正文后按整份内容回写', async () => {
    const props = renderTab({ memorySnapshots: { l1: L1, l2: L2 }, memoryDrafts: { l1: L1, l2: L2 } })
    await userEvent.click(within(screen.getAllByRole('listitem')[0]).getByRole('button', { name: '编辑' }))
    const editor = screen.getByLabelText('编辑条目正文')
    await userEvent.clear(editor)
    await userEvent.type(editor, '回答用简体中文。')
    await userEvent.click(screen.getByRole('button', { name: '保存条目' }))
    expect(props.onReplaceLayerContent).toHaveBeenCalledWith('l1', expect.stringContaining('回答用简体中文。'))
    // 其它条目与标题保持不变
    const [, next] = vi.mocked(props.onReplaceLayerContent).mock.calls[0]
    expect(next).toContain('## 工具')
    expect(next).toContain('# L1 Online Memory')
  })

  it('删除条目时先确认，确认后只移除该小节', async () => {
    const props = renderTab({ memorySnapshots: { l1: L1, l2: L2 }, memoryDrafts: { l1: L1, l2: L2 } })
    await userEvent.click(within(screen.getAllByRole('listitem')[1]).getByRole('button', { name: '删除这条记忆' }))
    const confirm = await screen.findByRole('button', { name: '删除' })
    await userEvent.click(confirm)
    expect(props.onReplaceLayerContent).toHaveBeenCalledTimes(1)
    const [layer, next] = vi.mocked(props.onReplaceLayerContent).mock.calls[0]
    expect(layer).toBe('l1')
    expect(next).not.toContain('## 工具')
    expect(next).toContain('## 偏好')
  })

  it('该层有未保存改动时禁用条目操作', () => {
    renderTab({
      memorySnapshots: { l1: L1, l2: L2 },
      memoryDrafts: { l1: `${L1}新增`, l2: L2 },
    })
    for (const button of screen.getAllByRole('button', { name: '编辑' })) expect(button).toBeDisabled()
    for (const button of screen.getAllByRole('button', { name: '删除这条记忆' })) expect(button).toBeDisabled()
  })
})
