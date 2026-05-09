import type { Middleware } from '@reduxjs/toolkit'
import { collectTerminalPaneIds } from '@/lib/tab-recency'
import { prunePaneTabActivityToLiveTerminalPanes } from './tabRecencySlice'

type RecencyPruneState = {
  tabs?: { tabs?: Array<{ id: string }> }
  panes?: { layouts?: Record<string, unknown> }
}

function collectLiveTabIds(state: RecencyPruneState): string[] {
  return (state.tabs?.tabs ?? []).map((tab) => tab.id)
}

export function collectLiveTerminalPaneIds(state: RecencyPruneState): string[] {
  const liveTabIds = new Set(collectLiveTabIds(state))
  return Object.entries(state.panes?.layouts ?? {})
    .filter(([tabId]) => liveTabIds.has(tabId))
    .flatMap(([, layout]) => collectTerminalPaneIds(layout as any))
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const bSet = new Set(b)
  return a.every((value) => bSet.has(value))
}

export const tabRecencyPruneMiddleware: Middleware<{}, RecencyPruneState> = (store) => {
  let pruneQueued = false

  const pruneToCurrentState = () => {
    pruneQueued = false
    pruneTabRecencyToCurrentLayout(store)
  }

  const queuePruneToCurrentState = () => {
    if (pruneQueued) return
    pruneQueued = true
    const enqueue = typeof queueMicrotask === 'function'
      ? queueMicrotask
      : (fn: () => void) => setTimeout(fn, 0)
    enqueue(pruneToCurrentState)
  }

  return (next) => (action) => {
    const a = action as any
    if (typeof a?.type !== 'string') return next(action)
    if (!a.type.startsWith('tabs/') && !a.type.startsWith('panes/')) {
      return next(action)
    }

    const previousState = store.getState()
    const previousLiveTabIds = collectLiveTabIds(previousState)
    const result = next(action)
    const state = store.getState()

    const liveTabIdsChanged = !sameStringSet(previousLiveTabIds, collectLiveTabIds(state))
    const paneLayoutsChanged = state.panes?.layouts !== previousState.panes?.layouts
    if (!liveTabIdsChanged && !paneLayoutsChanged) return result

    const previousLivePaneIds = collectLiveTerminalPaneIds(previousState)
    const livePaneIds = collectLiveTerminalPaneIds(state)
    if (!sameStringSet(previousLivePaneIds, livePaneIds)) {
      store.dispatch(prunePaneTabActivityToLiveTerminalPanes({
        paneIds: livePaneIds,
      }))
      return result
    }

    if (liveTabIdsChanged) {
      queuePruneToCurrentState()
    }

    return result
  }
}

export function pruneTabRecencyToCurrentLayout(store: {
  getState: () => RecencyPruneState
  dispatch: (action: any) => any
}): void {
  store.dispatch(prunePaneTabActivityToLiveTerminalPanes({
    paneIds: collectLiveTerminalPaneIds(store.getState()),
  }))
}
