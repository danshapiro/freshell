import { useEffect } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { clearFinished } from '@/store/terminalActivitySlice'
import { useNotificationSound } from '@/hooks/useNotificationSound'

const EMPTY_FINISHED: Record<string, boolean> = {}

export function useTerminalActivityMonitor() {
  const dispatch = useAppDispatch()
  const finished = useAppSelector((state) => state.terminalActivity?.finished ?? EMPTY_FINISHED)
  const { play } = useNotificationSound()

  useEffect(() => {
    const paneIds = Object.keys(finished).filter((paneId) => finished[paneId])
    if (paneIds.length === 0) return
    if (typeof document === 'undefined') return

    const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true
    if (document.hidden || hasFocus) return

    play()
    for (const paneId of paneIds) {
      dispatch(clearFinished({ paneId }))
    }
  }, [dispatch, finished, play])
}
