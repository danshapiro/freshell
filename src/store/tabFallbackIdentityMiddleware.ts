import type { Middleware } from '@reduxjs/toolkit'
import { buildTabFallbackIdentityUpdates } from '@/lib/tab-fallback-identity'
import type { RootState } from './store'
import { updateTab } from './tabsSlice'

export const tabFallbackIdentityMiddleware: Middleware = (store) => (next) => (action) => {
  const result = next(action)
  const state = store.getState() as RootState

  for (const tab of state.tabs.tabs) {
    const updates = buildTabFallbackIdentityUpdates({
      tab,
      layout: state.panes.layouts[tab.id],
    })
    if (!updates) continue
    store.dispatch(updateTab({
      id: tab.id,
      updates,
    }))
  }

  return result
}
