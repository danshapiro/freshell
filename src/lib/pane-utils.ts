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

/**
 * The terminal-close pairs for one tab's pane tree (focused-episode-6 round
 * 2): each live terminal's `terminalId` PLUS the pane's `createRequestId` —
 * the durable close envelope's createRequestId key on the server when the
 * registry probe can no longer answer. First reference wins per
 * terminalId (a terminal shared by two panes closes once).
 */
export function collectTerminalCloseTargets(
  node: PaneNode,
): Array<{ terminalId: string; createRequestId: string | null }> {
  const seen = new Set<string>()
  const out: Array<{ terminalId: string; createRequestId: string | null }> = []
  const walk = (n: PaneNode): void => {
    if (n.type === 'leaf') {
      if (n.content.kind === 'terminal' && n.content.terminalId && !seen.has(n.content.terminalId)) {
        seen.add(n.content.terminalId)
        out.push({ terminalId: n.content.terminalId, createRequestId: n.content.createRequestId ?? null })
      }
      return
    }
    walk(n.children[0])
    walk(n.children[1])
  }
  walk(node)
  return out
}

/**
 * Union of every terminalId referenced by any pane in any tab layout.
 * This is the client's complete "terminals I currently reference" set —
 * the primitive the detach middleware diffs to spot dropped references.
 */
export function collectAllTerminalIds(
  layouts: Record<string, PaneNode | undefined>
): Set<string> {
  const ids = new Set<string>()
  for (const layout of Object.values(layouts)) {
    if (!layout) continue
    for (const terminalId of collectTerminalIds(layout)) {
      ids.add(terminalId)
    }
  }
  return ids
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

/**
 * One close-evidence-bearing pane identity (focused-episode-7 round 4,
 * Finding F2): the pane id plus the createRequestId the `pane.closed` /
 * `panes.closed` / `pane.opened` lanes key by, and the terminalId when the
 * pane has one (terminal panes only — fresh-agent identities are CRID-only).
 */
export interface SessionPaneIdentity {
  paneId: string
  createRequestId: string
  terminalId?: string
}

/**
 * Every session-pane identity in a subtree — terminal AND fresh-agent panes.
 * Both kinds carry the mandatory createRequestId the close/open lanes key by,
 * so the close gate, the middleware belt, and the per-ready open sweep all
 * consume this ONE walker (three hand-rolled kind checks would drift again —
 * the round-4 terminal-only exclusions were exactly that drift). The
 * pathological legacy CRID-less shape is skipped (never a malformed record
 * key), and non-session panes (browser/editor/picker/host-stats/extension)
 * carry no identity the close lanes know.
 */
export function collectSessionPaneIdentities(node: PaneNode): SessionPaneIdentity[] {
  const identities: SessionPaneIdentity[] = []
  for (const { paneId, content } of collectPaneEntries(node)) {
    if (content.kind !== 'terminal' && content.kind !== 'fresh-agent') continue
    const createRequestId = typeof content.createRequestId === 'string' && content.createRequestId
      ? content.createRequestId
      : undefined
    if (!createRequestId) continue
    identities.push({
      paneId,
      createRequestId,
      ...(content.kind === 'terminal' && content.terminalId ? { terminalId: content.terminalId } : {}),
    })
  }
  return identities
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
