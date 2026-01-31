import type { Middleware } from '@reduxjs/toolkit'
import { SESSION_ACTIVITY_STORAGE_KEY } from './sessionActivitySlice'

export const SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS = 5000

type SessionActivityState = {
  sessionActivity?: {
    sessions?: Record<string, number>
  }
}

const flushCallbacks = new Set<() => void>()
let flushListenersAttached = false

function notifyFlushCallbacks() {
  for (const cb of flushCallbacks) {
    try {
      cb()
    } catch {
      // ignore
    }
  }
}

function attachFlushListeners() {
  if (flushListenersAttached) return
  if (typeof document === 'undefined' || typeof window === 'undefined') return

  const handleVisibility = () => {
    if (document.visibilityState === 'hidden') {
      notifyFlushCallbacks()
    }
  }

  const handlePageHide = () => {
    notifyFlushCallbacks()
  }

  document.addEventListener('visibilitychange', handleVisibility)
  window.addEventListener('pagehide', handlePageHide)
  window.addEventListener('beforeunload', handlePageHide)

  flushListenersAttached = true
}

function registerFlushCallback(cb: () => void) {
  flushCallbacks.add(cb)
  attachFlushListeners()
}

export function resetSessionActivityFlushListenersForTests() {
  flushCallbacks.clear()
}

function canUseStorage(): boolean {
  return typeof localStorage !== 'undefined'
}

export const sessionActivityPersistMiddleware: Middleware<{}, SessionActivityState> = (store) => {
  let dirty = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    flushTimer = null
    if (!dirty) return
    if (!canUseStorage()) {
      scheduleFlush()
      return
    }

    try {
      const sessions = store.getState().sessionActivity?.sessions || {}
      localStorage.setItem(SESSION_ACTIVITY_STORAGE_KEY, JSON.stringify(sessions))
      dirty = false
    } catch {
      // Ignore storage errors (quota exceeded, etc.)
      scheduleFlush()
    }
  }

  const scheduleFlush = () => {
    if (flushTimer) return
    flushTimer = setTimeout(flush, SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS)
  }

  const flushNow = () => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    flush()
  }

  registerFlushCallback(flushNow)

  return (next) => (action) => {
    const result = next(action)

    if (typeof action?.type === 'string' && action.type.startsWith('sessionActivity/')) {
      dirty = true
      scheduleFlush()
    }

    return result
  }
}
