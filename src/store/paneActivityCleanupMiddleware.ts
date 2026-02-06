import type { Middleware } from '@reduxjs/toolkit'
import { removePaneActivity } from './terminalActivitySlice'
import type { PaneNode, PaneContent } from './paneTypes'

function collectPaneKindMap(layouts: Record<string, PaneNode>): Record<string, PaneContent['kind']> {
  const map: Record<string, PaneContent['kind']> = {}

  const walk = (node: PaneNode) => {
    if (node.type === 'leaf') {
      map[node.id] = node.content.kind
      return
    }
    walk(node.children[0])
    walk(node.children[1])
  }

  for (const layout of Object.values(layouts || {})) {
    if (layout) walk(layout)
  }

  return map
}

export const paneActivityCleanupMiddleware: Middleware = (store) => (next) => (action) => {
  const actionType =
    typeof (action as { type?: unknown })?.type === 'string'
      ? (action as { type: string }).type
      : null
  const isPaneAction = !!actionType && actionType.startsWith('panes/')
  if (!isPaneAction) return next(action)

  const prevLayouts = (store.getState() as any).panes.layouts as Record<string, PaneNode>
  const prevMap = collectPaneKindMap(prevLayouts)

  const result = next(action)

  const nextLayouts = (store.getState() as any).panes.layouts as Record<string, PaneNode>
  const nextMap = collectPaneKindMap(nextLayouts)

  for (const [paneId, kind] of Object.entries(prevMap)) {
    if (kind !== 'terminal') continue
    const nextKind = nextMap[paneId]
    if (!nextKind || nextKind !== 'terminal') {
      store.dispatch(removePaneActivity({ paneId }))
    }
  }

  return result
}
