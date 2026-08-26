import type {
  FreshAgentPaneContent,
  PaneContent,
  PaneNode,
  PaneRefreshTarget,
  TerminalPaneContent,
} from '@/store/paneTypes'
import type { AgentRestartReplacedMessage, AgentRuntimeKind } from '@shared/ws-protocol'

export interface PaneEntry {
  paneId: string
  content: PaneContent
}

type RestartablePaneContent = TerminalPaneContent | FreshAgentPaneContent

export type AgentRestartTarget = {
  provider: string
  sessionId: string
  kind: AgentRuntimeKind
  liveId: string
  expectedGeneration: number
}

const RESTARTABLE_TERMINAL_PROVIDERS = new Set([
  'claude',
  'codex',
  'opencode',
  'amplifier',
])
const RESTARTABLE_FRESH_AGENT_PROVIDERS = new Set([
  'claude',
  'codex',
  'opencode',
])

function paneRuntimeKind(content: RestartablePaneContent): AgentRuntimeKind {
  return content.kind === 'terminal' ? 'terminal' : 'fresh-agent'
}

function paneRuntimeProvider(content: RestartablePaneContent): string {
  return content.kind === 'terminal' ? content.mode : content.provider
}

/**
 * Resolve the immutable server target for a user-requested pane restart.
 * Restart intentionally fails closed: only built-in Rust adapters with a
 * canonical provider-matching session reference and a live generation fence
 * are eligible. Extension resume templates are command helpers, not proof
 * that the server can safely replace the extension runtime.
 */
export function resolveAgentRestartTarget(content: PaneContent): AgentRestartTarget | null {
  if (content.kind !== 'terminal' && content.kind !== 'fresh-agent') return null

  const provider = paneRuntimeProvider(content)
  const supported = content.kind === 'terminal'
    ? RESTARTABLE_TERMINAL_PROVIDERS.has(provider)
    : RESTARTABLE_FRESH_AGENT_PROVIDERS.has(provider)
  if (!supported) return null

  const sessionRef = content.sessionRef
  if (
    !sessionRef
    || sessionRef.provider !== provider
    || sessionRef.sessionId.length === 0
    || !content.runtimeId
    || !Number.isInteger(content.runtimeGeneration)
    || (content.runtimeGeneration ?? -1) < 0
  ) {
    return null
  }

  return {
    provider,
    sessionId: sessionRef.sessionId,
    kind: paneRuntimeKind(content),
    liveId: content.runtimeId,
    expectedGeneration: content.runtimeGeneration!,
  }
}

/**
 * A restart broadcast names durable identity plus the exact old runtime
 * identity and generation. Only panes viewing that same fully-fenced runtime
 * may follow the replacement. Legacy persisted panes lacking either fence
 * fail closed: durable/session-facing IDs are never runtime identities.
 */
export function paneMatchesAgentRuntimeReplacement(
  content: PaneContent,
  replacement: AgentRestartReplacedMessage,
): content is RestartablePaneContent {
  if (content.kind !== 'terminal' && content.kind !== 'fresh-agent') return false
  if (paneRuntimeKind(content) !== replacement.kind) return false
  if (paneRuntimeProvider(content) !== replacement.provider) return false
  if (
    content.sessionRef?.provider !== replacement.provider
    || content.sessionRef.sessionId !== replacement.sessionId
  ) {
    return false
  }
  if (replacement.generation <= replacement.oldGeneration) return false
  if (content.runtimeId !== replacement.oldRuntimeId) return false
  if (content.runtimeGeneration !== replacement.oldGeneration) return false
  return true
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
