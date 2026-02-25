import type { Middleware } from '@reduxjs/toolkit'
import { getWsClient } from '@/lib/ws-client'

export const layoutMirrorMiddleware: Middleware = (store) => {
  let lastPayload = ''
  let timer: number | undefined

  return (next) => (action) => {
    const result = next(action)
    const state = store.getState() as any
    const payload = {
      type: 'ui.layout.sync',
      tabs: state.tabs.tabs.map((t: any) => ({ id: t.id, title: t.title })),
      activeTabId: state.tabs.activeTabId,
      layouts: state.panes.layouts,
      activePane: state.panes.activePane,
      paneTitles: state.panes.paneTitles || {},
    }
    const serialized = JSON.stringify(payload)
    if (serialized === lastPayload) return result
    lastPayload = serialized

    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      getWsClient().send({ ...payload, timestamp: Date.now() })
    }, 200)

    return result
  }
}
