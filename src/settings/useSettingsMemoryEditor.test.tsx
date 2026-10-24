import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMemoryLayerContent, ChatMemoryState } from '../api/tauri'
import { useSettingsMemoryEditor, type SettingsMemoryPort } from './useSettingsMemoryEditor'

function memory(l1: string, l2: string): ChatMemoryState {
  return {
    success: true,
    dir: '/memory',
    l1: { layer: 'l1', content: l1, bytes: l1.length },
    l2: { layer: 'l2', content: l2, bytes: l2.length },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function port(
  get: SettingsMemoryPort['get'] = vi.fn(async () => memory('base', 'two')),
  save: SettingsMemoryPort['save'] = vi.fn(async (layer: 'l1' | 'l2', content: string) => ({ layer, content, bytes: content.length })),
): SettingsMemoryPort {
  return { get, save, openFolder: async () => ({ success: true, path: '/memory' }) }
}

describe('useSettingsMemoryEditor', () => {
  it('keeps typing made during a save while advancing only the saved baseline', async () => {
    const pending = deferred<ChatMemoryLayerContent>()
    const save = vi.fn(() => pending.promise)
    const memoryPort = port(undefined, save)
    const { result } = renderHook(() => useSettingsMemoryEditor(memoryPort, 'en', true))
    await act(async () => { await Promise.resolve() })
    act(() => result.current.edit('l1', 'submitted'))
    let saving!: Promise<void>
    act(() => { saving = result.current.save('l1') })
    act(() => result.current.edit('l1', 'newer draft'))
    await act(async () => {
      pending.resolve({ layer: 'l1', content: 'submitted', bytes: 9 })
      await saving
    })

    expect(result.current.view.drafts.l1).toBe('newer draft')
    expect(result.current.view.snapshots.l1).toBe('submitted')
  })

  it('refreshes pristine layers but retains an unsaved local layer', async () => {
    const get = vi.fn()
      .mockResolvedValueOnce(memory('old', 'old-two'))
      .mockResolvedValueOnce(memory('remote', 'remote-two'))
    const memoryPort = port(get)
    const { result } = renderHook(() => useSettingsMemoryEditor(memoryPort, 'en', true))
    await act(async () => { await Promise.resolve() })
    act(() => result.current.edit('l1', 'local'))
    await act(async () => { await result.current.refresh() })

    expect(result.current.view.drafts).toEqual({ l1: 'local', l2: 'remote-two' })
    expect(result.current.view.snapshots).toEqual({ l1: 'remote', l2: 'remote-two' })
  })

  it('条目改写走同一条保存路径：写后端、推进基线、未改动的草稿跟着更新', async () => {
    const save = vi.fn(async (layer: 'l1' | 'l2', content: string) => ({ layer, content, bytes: content.length }))
    const memoryPort = port(undefined, save)
    const { result } = renderHook(() => useSettingsMemoryEditor(memoryPort, 'zh', true))
    await act(async () => { await Promise.resolve() })

    await act(async () => { await result.current.replaceContent('l1', '## 只有一条') })

    expect(save).toHaveBeenCalledWith('l1', '## 只有一条')
    expect(result.current.view.snapshots.l1).toBe('## 只有一条')
    expect(result.current.view.drafts.l1).toBe('## 只有一条')
    expect(result.current.view.success).toBe('L1 已保存')
  })

  it('条目改写不能覆盖正在编辑、尚未保存的草稿', async () => {
    const save = vi.fn(async (layer: 'l1' | 'l2', content: string) => ({ layer, content, bytes: content.length }))
    const memoryPort = port(undefined, save)
    const { result } = renderHook(() => useSettingsMemoryEditor(memoryPort, 'zh', true))
    await act(async () => { await Promise.resolve() })
    act(() => result.current.edit('l1', '正在输入'))

    await act(async () => { await result.current.replaceContent('l1', '## 服务端版本') })

    expect(result.current.view.snapshots.l1).toBe('## 服务端版本')
    expect(result.current.view.drafts.l1).toBe('正在输入')
  })
})
