import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RapidOcrStatus } from '../api/tauri'
import { resetSettingsOcrDownloadsForTests, useSettingsOcrDownloads, type SettingsOcrPort } from './useSettingsOcrDownloads'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

const rapid = (ready: boolean): RapidOcrStatus => ({ standardAvailable: ready, highAvailable: false })

function port(overrides: Partial<SettingsOcrPort> = {}): SettingsOcrPort {
  return {
    rapidOcrStatus: vi.fn(async () => rapid(false)),
    rapidOcrInstall: vi.fn(async () => ({ success: true, message: 'ok' })),
    ...overrides,
  }
}

describe('useSettingsOcrDownloads', () => {
  beforeEach(() => {
    resetSettingsOcrDownloadsForTests()
  })

  it('keeps the newest rapid status when an older refresh finishes later', async () => {
    const old = deferred<RapidOcrStatus>()
    const newer = deferred<RapidOcrStatus>()
    const ocrPort = port({ rapidOcrStatus: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(newer.promise) })
    const { result } = renderHook(() => useSettingsOcrDownloads(true, 'standard', ocrPort))
    let refresh!: Promise<void>
    act(() => { refresh = result.current.refreshRapid() })
    await act(async () => { newer.resolve(rapid(true)); await refresh })
    await act(async () => { old.resolve(rapid(false)); await old.promise })
    expect(result.current.rapidStatus?.standardAvailable).toBe(true)
  })

  it('runs each download once while pending and exposes a failed install', async () => {
    const pendingRapid = deferred<{ success: boolean; message: string }>()
    const ocrPort = port({ rapidOcrInstall: vi.fn(() => pendingRapid.promise) })
    const { result } = renderHook(() => useSettingsOcrDownloads(true, 'standard', ocrPort))
    let rapidFlight!: Promise<void>
    await act(async () => {
      rapidFlight = result.current.downloadRapid('standard')
      void result.current.downloadRapid('standard')
    })
    expect(ocrPort.rapidOcrInstall).toHaveBeenCalledOnce()
    await act(async () => {
      pendingRapid.reject(new Error('rapid network failure'))
      await rapidFlight
    })
    expect(result.current.rapidDownloadState).toBe('failed')
    expect(result.current.rapidDownloadError).toContain('rapid network failure')
  })

  it('shares one rapid install across settings and knowledge subscribers, including after both leave', async () => {
    const pending = deferred<{ success: boolean; message: string }>()
    const ocrPort = port({
      rapidOcrInstall: vi.fn(() => pending.promise),
      rapidOcrStatus: vi.fn(async () => ({ standardAvailable: false, highAvailable: false })),
    })
    const settings = renderHook(() => useSettingsOcrDownloads(true, 'standard', ocrPort))
    const knowledge = renderHook(() => useSettingsOcrDownloads(true, 'high', ocrPort))
    let flight!: Promise<void>
    await act(async () => {
      flight = knowledge.result.current.downloadRapid('high')
      void settings.result.current.downloadRapid('standard')
    })
    expect(ocrPort.rapidOcrInstall).toHaveBeenCalledOnce()
    expect(ocrPort.rapidOcrInstall).toHaveBeenCalledWith('high')
    expect(settings.result.current.rapidDownloadState).toBe('downloading')
    knowledge.unmount()
    settings.unmount()

    const returned = renderHook(() => useSettingsOcrDownloads(true, 'high', ocrPort))
    expect(returned.result.current.rapidDownloadState).toBe('downloading')
    await act(async () => {
      pending.reject(new Error('offline'))
      await flight
    })
    expect(returned.result.current.rapidDownloadState).toBe('failed')
    expect(returned.result.current.rapidDownloadError).toContain('offline')

    vi.mocked(ocrPort.rapidOcrStatus).mockResolvedValue({ standardAvailable: true, highAvailable: true })
    vi.mocked(ocrPort.rapidOcrInstall).mockResolvedValue({ success: true, message: 'ok' })
    await act(async () => { await returned.result.current.downloadRapid('high') })
    expect(ocrPort.rapidOcrInstall).toHaveBeenCalledTimes(2)
    expect(returned.result.current.rapidDownloadState).toBe('idle')
    expect(returned.result.current.rapidStatus?.highAvailable).toBe(true)
  })

  it('skips status pulls when the widget is disabled', async () => {
    const ocrPort = port()
    renderHook(() => useSettingsOcrDownloads(false, 'standard', ocrPort))
    await act(async () => { await Promise.resolve() })
    expect(ocrPort.rapidOcrStatus).not.toHaveBeenCalled()
  })
})
