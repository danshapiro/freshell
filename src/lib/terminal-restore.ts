import { loadPersistedPanes } from '@/store/persistMiddleware'

type PaneNode = {
  type: 'leaf' | 'split'
  content?: { kind?: string; createRequestId?: string }
  children?: PaneNode[]
}

const restoredCreateRequestIds = new Set<string>()

function collectCreateRequestIds(node: PaneNode | null | undefined): void {
  if (!node) return
  if (node.type === 'leaf') {
    if (node.content?.kind === 'terminal' && node.content.createRequestId) {
      restoredCreateRequestIds.add(node.content.createRequestId)
    }
    return
  }
  if (node.type === 'split' && Array.isArray(node.children)) {
    for (const child of node.children) {
      collectCreateRequestIds(child)
    }
  }
}

const persisted = loadPersistedPanes()
if (persisted?.layouts && typeof persisted.layouts === 'object') {
  for (const node of Object.values(persisted.layouts)) {
    collectCreateRequestIds(node as PaneNode)
  }
}

export function consumeTerminalRestoreRequestId(requestId: string): boolean {
  if (!restoredCreateRequestIds.has(requestId)) return false
  restoredCreateRequestIds.delete(requestId)
  return true
}

export function addTerminalRestoreRequestId(requestId: string): void {
  restoredCreateRequestIds.add(requestId)
}
