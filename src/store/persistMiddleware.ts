import type { Middleware } from '@reduxjs/toolkit'
import type { RootState } from './store'

const STORAGE_KEY = 'ccso.tabs.v1'

export function loadPersistedTabs(): any | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed
  } catch {
    return null
  }
}

export const persistMiddleware: Middleware<{}, RootState> = (store) => (next) => (action) => {
  const result = next(action)
  const state = store.getState()

  // Persist only tabs slice (keep tiny and safe).
  const payload = {
    tabs: state.tabs,
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // ignore quota
  }

  return result
}
