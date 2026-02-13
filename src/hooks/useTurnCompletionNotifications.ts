import { useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  consumeTurnCompleteEvents,
  markTabAttention,
  markPaneAttention,
  clearTabAttention,
  clearPaneAttention,
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
  const attentionDismiss = useAppSelector((state) => state.settings?.settings?.panes?.attentionDismiss ?? 'click')
  const attentionByTab = useAppSelector((state) => state.turnCompletion?.attentionByTab)
  const attentionByPane = useAppSelector((state) => state.turnCompletion?.attentionByPane)
  const activePaneByTab = useAppSelector((state) => state.panes?.activePane)
  const { play } = useNotificationSound()
  const lastHandledSeqRef = useRef(0)
  const prevActiveTabIdRef = useRef(activeTabId)
  const [focused, setFocused] = useState(() => isWindowFocused())

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return

    const updateFocus = () => setFocused(isWindowFocused())
    window.addEventListener('focus', updateFocus)
    window.addEventListener('blur', updateFocus)
    document.addEventListener('visibilitychange', updateFocus)

    return () => {
      window.removeEventListener('focus', updateFocus)
      window.removeEventListener('blur', updateFocus)
      document.removeEventListener('visibilitychange', updateFocus)
    }
  }, [])

  useEffect(() => {
    if (pendingEvents.length === 0) return

    const windowFocused = isWindowFocused()
    let highestHandledSeq = lastHandledSeqRef.current
    let shouldPlay = false

    for (const event of pendingEvents) {
      if (event.seq <= lastHandledSeqRef.current) continue
      highestHandledSeq = Math.max(highestHandledSeq, event.seq)
      dispatch(markTabAttention({ tabId: event.tabId }))
      dispatch(markPaneAttention({ paneId: event.paneId }))
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

  // 'click' mode: clear attention only when the user *switches* to a tab that has attention.
  // If a completion arrives on the already-active tab, the indicator persists until the user
  // navigates away and back (an actual click/switch).
  useEffect(() => {
    const switched = prevActiveTabIdRef.current !== activeTabId
    prevActiveTabIdRef.current = activeTabId

    if (attentionDismiss !== 'click') return
    if (!switched || !focused || !activeTabId) return
    if (attentionByTab?.[activeTabId]) {
      dispatch(clearTabAttention({ tabId: activeTabId }))
    }
    const activePaneId = activePaneByTab?.[activeTabId]
    if (activePaneId && attentionByPane?.[activePaneId]) {
      dispatch(clearPaneAttention({ paneId: activePaneId }))
    }
  }, [activeTabId, activePaneByTab, attentionByPane, attentionByTab, attentionDismiss, dispatch, focused])

  // 'type' mode: attention is cleared by TerminalView when the user sends input.
}
