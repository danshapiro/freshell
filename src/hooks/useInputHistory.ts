import { useCallback, useEffect, useRef } from 'react'
import { loadHistory, pushEntry as storePushEntry } from '@/lib/input-history-store'

export interface UseInputHistoryReturn {
  navigateUp: (currentText: string) => string | null
  navigateDown: (currentText: string) => string | null
  push: (entry: string) => void
  reset: () => void
}

export function useInputHistory(paneId: string | undefined): UseInputHistoryReturn {
  const cursorRef = useRef(-1)
  const draftRef = useRef('')
  const historyRef = useRef<string[]>([])

  useEffect(() => {
    historyRef.current = paneId ? loadHistory(paneId) : []
    cursorRef.current = -1
    draftRef.current = ''
  }, [paneId])

  const navigateUp = useCallback((currentText: string): string | null => {
    const history = historyRef.current
    if (history.length === 0) return null
    if (cursorRef.current >= history.length - 1) return null

    if (cursorRef.current === -1) {
      draftRef.current = currentText
    }

    cursorRef.current++
    return history[history.length - 1 - cursorRef.current]
  }, [])

  const navigateDown = useCallback((_currentText: string): string | null => {
    if (cursorRef.current <= -1) return null

    cursorRef.current--

    if (cursorRef.current === -1) {
      return draftRef.current
    }

    const history = historyRef.current
    return history[history.length - 1 - cursorRef.current]
  }, [])

  const push = useCallback((entry: string): void => {
    if (!paneId) return
    historyRef.current = storePushEntry(paneId, entry)
    cursorRef.current = -1
    draftRef.current = ''
  }, [paneId])

  const reset = useCallback((): void => {
    cursorRef.current = -1
    draftRef.current = ''
  }, [])

  return { navigateUp, navigateDown, push, reset }
}
