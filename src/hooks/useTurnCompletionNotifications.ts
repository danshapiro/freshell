import { useEffect, useRef } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  consumeTurnCompleteEvents,
  markTabAttention,
  type TurnCompleteEvent,
} from '@/store/turnCompletionSlice'
import { useNotificationSound } from '@/hooks/useNotificationSound'

const EMPTY_PENDING_EVENTS: TurnCompleteEvent[] = []

function isWindowFocused(): boolean {
  if (typeof document === 'undefined') return true
  const hasFocus = typeof document.hasFocus === 'function' ? document.hasFocus() : true
  return hasFocus && !document.hidden
}

export function useTurnCompletionNotifications() {
  const dispatch = useAppDispatch()
  const activeTabId = useAppSelector((state) => state.tabs.activeTabId)
  const pendingEvents = useAppSelector((state) => state.turnCompletion?.pendingEvents ?? EMPTY_PENDING_EVENTS)
  const { play } = useNotificationSound()
  const lastHandledSeqRef = useRef(0)

  useEffect(() => {
    if (pendingEvents.length === 0) return

    const windowFocused = isWindowFocused()
    let highestHandledSeq = lastHandledSeqRef.current
    let shouldPlay = false

    for (const event of pendingEvents) {
      if (event.seq <= lastHandledSeqRef.current) continue
      highestHandledSeq = Math.max(highestHandledSeq, event.seq)
      dispatch(markTabAttention({ tabId: event.tabId }))
      if (windowFocused && activeTabId === event.tabId) {
        continue
      }
      shouldPlay = true
    }

    if (highestHandledSeq > lastHandledSeqRef.current) {
      lastHandledSeqRef.current = highestHandledSeq
      dispatch(consumeTurnCompleteEvents({ throughSeq: highestHandledSeq }))
    }

    if (shouldPlay) {
      play()
    }
  }, [activeTabId, dispatch, pendingEvents, play])

  // Attention is cleared by TerminalView when the user sends input,
  // not by a timer. This keeps the indicator visible until the user
  // actually engages with the tab.
}
