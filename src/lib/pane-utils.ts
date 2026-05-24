import type { PaneContent, PaneNode, PaneRefreshTarget } from '@/store/paneTypes'

export interface PaneEntry {
  paneId: string
  content: PaneContent
}

/**
 * Get the cwd of the first terminal in the pane tree (depth-first traversal).
 * Returns null if no terminal with a known cwd is found.
 */
export function getFirstTerminalCwd(
  node: PaneNode,
  cwdMap: Record<string, string>
): string | null {
  if (node.type === 'leaf') {
    if (node.content.kind === 'terminal' && node.content.terminalId) {
      return cwdMap[node.content.terminalId] || null
    }
    return null
  }

  // Split node - check children depth-first
  const leftResult = getFirstTerminalCwd(node.children[0], cwdMap)
  if (leftResult) return leftResult

  return getFirstTerminalCwd(node.children[1], cwdMap)
}

export function collectTerminalIds(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    if (node.content.kind === 'terminal' && node.content.terminalId) {
      return [node.content.terminalId]
    }
    return []
  }

  return [
    ...collectTerminalIds(node.children[0]),
    ...collectTerminalIds(node.children[1]),
  ]
}

export function collectPaneContents(node: PaneNode): PaneContent[] {
  if (node.type === 'leaf') {
    return [node.content]
  }
  return [
    ...collectPaneContents(node.children[0]),
    ...collectPaneContents(node.children[1]),
  ]
}

export function collectPaneEntries(node: PaneNode): PaneEntry[] {
  if (node.type === 'leaf') {
    return [{ paneId: node.id, content: node.content }]
  }
  return [
    ...collectPaneEntries(node.children[0]),
    ...collectPaneEntries(node.children[1]),
  ]
}

export function findPaneContent(node: PaneNode, paneId: string): PaneContent | null {
  if (node.type === 'leaf') {
    return node.id === paneId ? node.content : null
  }
  return findPaneContent(node.children[0], paneId) || findPaneContent(node.children[1], paneId)
}

export function buildPaneRefreshTarget(content: PaneContent): PaneRefreshTarget | null {
  if (content.kind === 'terminal') {
    return content.terminalId
      ? { kind: 'terminal', createRequestId: content.createRequestId }
      : null
  }
  if (content.kind === 'browser') {
    return typeof content.url === 'string' && content.url.trim()
      ? { kind: 'browser', browserInstanceId: content.browserInstanceId }
      : null
  }
  if (content.kind === 'fresh-agent') {
    return content.sessionId || content.status === 'creating' || content.status === 'starting'
      ? {
        kind: 'fresh-agent',
        createRequestId: content.createRequestId,
        sessionId: content.sessionId,
        sessionType: content.sessionType,
        provider: content.provider,
      }
      : null
  }
  return null
}

export function paneRefreshTargetMatchesContent(
  target: PaneRefreshTarget,
  content: PaneContent | null | undefined,
): boolean {
  if (!content) return false

  if (target.kind === 'terminal') {
    return content.kind === 'terminal'
      && !!content.terminalId
      && content.createRequestId === target.createRequestId
  }

  if (target.kind === 'browser') {
    return content.kind === 'browser'
    && typeof content.url === 'string'
    && !!content.url.trim()
    && content.browserInstanceId === target.browserInstanceId
  }

  return content.kind === 'fresh-agent'
    && content.createRequestId === target.createRequestId
    && content.sessionType === target.sessionType
    && content.provider === target.provider
    && (!target.sessionId || content.sessionId === target.sessionId)
}
