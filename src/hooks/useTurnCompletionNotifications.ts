import { useEffect, useRef, useState } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  clearTabAttention,
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
  const [focused, setFocused] = useState(() => isWindowFocused())
  const lastHandledSeqRef = useRef(0)

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
      if (windowFocused && activeTabId === event.tabId) {
        continue
      }
      dispatch(markTabAttention({ tabId: event.tabId }))
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

  useEffect(() => {
    if (!focused || !activeTabId) return
    dispatch(clearTabAttention({ tabId: activeTabId }))
  }, [activeTabId, dispatch, focused])
}
