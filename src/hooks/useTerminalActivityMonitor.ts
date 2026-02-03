import { useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { checkActivityTimeout, clearFinished, STREAMING_THRESHOLD_MS } from '@/store/terminalActivitySlice'
import { useNotificationSound } from '@/hooks/useNotificationSound'

const ACTIVITY_CHECK_INTERVAL_MS = Math.max(1000, STREAMING_THRESHOLD_MS / 2)

export function useTerminalActivityMonitor() {
  const dispatch = useAppDispatch()
  const working = useAppSelector((state) => state.terminalActivity?.working ?? {})
  const finished = useAppSelector((state) => state.terminalActivity?.finished ?? {})
  const { play } = useNotificationSound()
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Periodically check for activity timeout on working panes
  useEffect(() => {
    const hasWorkingPanes = Object.values(working).some(Boolean)
    if (!hasWorkingPanes) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }

    if (!intervalRef.current) {
      intervalRef.current = setInterval(() => {
        dispatch(checkActivityTimeout({}))
      }, ACTIVITY_CHECK_INTERVAL_MS)
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [dispatch, working])

  // Play notification sound when panes finish while window is unfocused
  // Sound plays when the browser window is not focused (user is in another app/window)
  // or when the browser tab is hidden (user switched to another browser tab)
  useEffect(() => {
    const paneIds = Object.keys(finished).filter((paneId) => finished[paneId])
    if (paneIds.length === 0) return
    if (typeof document === 'undefined') return

    // Check if user is actively looking at this window
    const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true
    // Play sound if window doesn't have focus (user is elsewhere)
    // Don't play if window is focused (user is already looking)
    if (hasFocus) return

    play()
    for (const paneId of paneIds) {
      dispatch(clearFinished({ paneId }))
    }
  }, [dispatch, finished, play])
}
