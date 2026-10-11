import { useCallback, useEffect } from 'react'
import {
  api,
  type RapidOcrStatus,
  type RapidOcrTier,
} from '../api/tauri'
import { createWindowStore, useWindowStore } from '../utils/windowStore'

/** Owns OCR package status and install progress independently of draft saves. */
export type SettingsOcrPort = Pick<typeof api, 'rapidOcrStatus' | 'rapidOcrInstall'>

type OcrDownloadsState = {
  rapidStatus: RapidOcrStatus | null
  rapidDownloadState: 'idle' | 'downloading' | 'failed'
  rapidDownloadError: string
}

const initialOcrDownloadsState: OcrDownloadsState = {
  rapidStatus: null,
  rapidDownloadState: 'idle',
  rapidDownloadError: '',
}

/** Settings screenshot OCR and the knowledge-base RapidOCR widget share this flight. */
const ocrDownloadsStore = createWindowStore(initialOcrDownloadsState)

let epoch = 0
let rapidRefreshSequence = 0

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function pullRapidStatus(port: SettingsOcrPort, enabled: boolean) {
  if (!enabled) return
  const sequence = ++rapidRefreshSequence
  try {
    const status = await port.rapidOcrStatus()
    if (sequence === rapidRefreshSequence) {
      ocrDownloadsStore.setState((state) => ({ ...state, rapidStatus: status }))
    }
  } catch (error) {
    if (sequence === rapidRefreshSequence) console.error('rapidOcrStatus failed:', error)
  }
}

function downloadRapidPack(port: SettingsOcrPort, enabled: boolean, selectedTier: RapidOcrTier) {
  const ticket = epoch
  return ocrDownloadsStore.run(`rapid-install:${ticket}`, async () => {
    if (ticket !== epoch) return
    ocrDownloadsStore.setState((state) => ({
      ...state,
      rapidDownloadState: 'downloading',
      rapidDownloadError: '',
    }))
    try {
      const result = await port.rapidOcrInstall(selectedTier)
      if (ticket !== epoch) return
      if (result.success) {
        ocrDownloadsStore.setState((state) => ({
          ...state,
          rapidDownloadState: 'idle',
          rapidDownloadError: '',
        }))
        await pullRapidStatus(port, enabled)
      } else {
        ocrDownloadsStore.setState((state) => ({
          ...state,
          rapidDownloadState: 'failed',
          rapidDownloadError: result.message,
        }))
      }
    } catch (error) {
      if (ticket !== epoch) return
      ocrDownloadsStore.setState((state) => ({
        ...state,
        rapidDownloadState: 'failed',
        rapidDownloadError: errorText(error),
      }))
    }
  })
}

/** Drops window-owned OCR flight state. Tests call this between cases; the app keeps the store for the window lifetime. */
export function resetSettingsOcrDownloadsForTests() {
  epoch += 1
  rapidRefreshSequence += 1
  ocrDownloadsStore.setState({ ...initialOcrDownloadsState })
}

export function useSettingsOcrDownloads(
  enabled: boolean,
  _tier: RapidOcrTier,
  port: SettingsOcrPort = api,
) {
  const [snapshot] = useWindowStore(ocrDownloadsStore)

  const refreshRapid = useCallback(() => pullRapidStatus(port, enabled), [enabled, port])
  const downloadRapid = useCallback(
    (selectedTier: RapidOcrTier) => downloadRapidPack(port, enabled, selectedTier),
    [enabled, port],
  )

  useEffect(() => { void refreshRapid() }, [refreshRapid])

  return {
    rapidStatus: snapshot.rapidStatus,
    rapidDownloadState: snapshot.rapidDownloadState,
    rapidDownloadError: snapshot.rapidDownloadError,
    refreshRapid,
    downloadRapid,
  }
}
