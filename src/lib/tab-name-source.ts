/**
 * Unified agent names (Task 6) — the shared stable-tab-ownership helpers.
 *
 * The plan's "Stable tab ownership" contract
 * (docs/plans/2026-09-16-unified-agent-names.md) in one place: the lifecycle
 * middleware, the registry-copy paths, and the recovery builder all resolve
 * and remap a tab's naming-source pointer through THESE functions, so no
 * surface grows an independent derivation algorithm.
 *
 * A tab stores the RELATIONSHIP (`TabNameSource`), never a second name:
 * `{kind:'session',paneId}` follows that pane's canonical session name;
 * `{kind:'legacy'}` keeps the existing non-agent derivation; `undefined`
 * exists only until initial content (or migration) resolves ownership.
 */
import type { TabNameSource, SessionNameRef } from '@shared/session-names'
import { isUnifiedAgentMode } from '@shared/session-names'
import type { PaneContent, PaneNode } from '@/store/paneTypes'

/**
 * Parse an untrusted pane naming-identity input (registry payloads, recovery
 * snapshot payloads, persisted content, hydrating folds): a schema-valid
 * `nameRef` and a non-empty `namingHandle` survive; malformed values drop.
 * THE single parse point — registry copy, recovery, the panesSlice whitelist
 * and the persisted-state sanitizer all consume this, never a private copy.
 */
export function parsePaneNamingIdentityInput(
  source: { nameRef?: unknown; namingHandle?: unknown },
): { namingHandle?: string; nameRef?: SessionNameRef } {
  const raw = source.nameRef
  let nameRef: SessionNameRef | undefined
  if (raw && typeof raw === 'object') {
    const ref = raw as { kind?: unknown; id?: unknown; provider?: unknown; sessionId?: unknown }
    if (ref.kind === 'pending' && typeof ref.id === 'string' && ref.id.length > 0) {
      nameRef = { kind: 'pending', id: ref.id }
    } else if (
      ref.kind === 'session'
      && (ref.provider === 'claude' || ref.provider === 'codex' || ref.provider === 'opencode')
      && typeof ref.sessionId === 'string'
      && ref.sessionId.length > 0
    ) {
      nameRef = {
        kind: 'session',
        provider: ref.provider,
        sessionId: ref.sessionId,
      }
    }
  }
  const namingHandle = typeof source.namingHandle === 'string' && source.namingHandle.length > 0
    ? source.namingHandle
    : undefined
  return {
    ...(namingHandle ? { namingHandle } : {}),
    ...(nameRef ? { nameRef } : {}),
  }
}

/** Is this pane content one of the six unified naming modes? (Kilroy is
 * never scoped — it shares the Claude runtime but keeps its naming.) */
export function isScopedNameSourceContent(content: PaneContent): boolean {
  if (content.kind === 'terminal') {
    return isUnifiedAgentMode(content.mode, undefined)
  }
  if (content.kind === 'fresh-agent') {
    return isUnifiedAgentMode(content.provider, content.sessionType)
  }
  return false
}

/**
 * A pane content's logical identity — stable across layout slots, so a
 * content swap is detectable by comparing the identity at a fixed pane id
 * before and after the fold. Session panes key by createRequestId; the
 * stateless kinds key by their durable instance field; a picker carries no
 * identity (it is the unresolved initial state).
 */
export function paneContentIdentity(content: PaneContent | undefined): string | undefined {
  if (!content) return undefined
  switch (content.kind) {
    case 'terminal':
      return `t:${content.createRequestId}`
    case 'fresh-agent':
      return `f:${content.createRequestId}`
    case 'browser':
      return `b:${content.browserInstanceId}`
    case 'editor':
      return `e:${content.filePath ?? '<scratch>'}`
    case 'extension':
      return `x:${content.extensionName}`
    case 'picker':
    case 'host-stats':
      return undefined
  }
}

/** Depth-first left-to-right leaf list. */
export function collectNameSourceLeaves(node: PaneNode | undefined): Array<{ paneId: string; content: PaneContent }> {
  if (!node) return []
  if (node.type === 'leaf') return [{ paneId: node.id, content: node.content }]
  return [
    ...collectNameSourceLeaves(node.children[0]),
    ...collectNameSourceLeaves(node.children[1]),
  ]
}

/** The first leaf in depth-first left-to-right order. */
export function firstNameSourceLeaf(
  node: PaneNode | undefined,
): { paneId: string; content: PaneContent } | undefined {
  return collectNameSourceLeaves(node)[0]
}

/**
 * The pane a tab takes its tab-level facts from (name reliability, Task 8:
 * the managed-runtime merge): its session naming source while that pane is
 * still in the layout, else its first leaf.
 */
export function tabNamingLeaf(
  tab: { nameSource?: TabNameSource } | undefined,
  layout: PaneNode | undefined,
): { paneId: string; content: PaneContent } | undefined {
  const leaves = collectNameSourceLeaves(layout)
  if (tab?.nameSource?.kind === 'session') {
    const sourceId = tab.nameSource.paneId
    const source = leaves.find((leaf) => leaf.paneId === sourceId)
    if (source) return source
  }
  return leaves[0]
}

/**
 * The initial-content-choice resolution (plan "Stable tab ownership"): the
 * FIRST leaf decides, because it is the original pane — a scoped agent leaf
 * owns the tab; any other real content keeps the existing non-agent
 * derivation; an initial PICKER stays unresolved until its first actual
 * content choice (a later mixed-tab agent addition never claims ownership).
 */
export function resolveInitialTabNameSource(layout: PaneNode | undefined): TabNameSource | undefined {
  const first = firstNameSourceLeaf(layout)
  if (!first) return undefined
  if (first.content.kind === 'picker') return undefined
  if (isScopedNameSourceContent(first.content)) {
    return { kind: 'session', paneId: first.paneId }
  }
  return { kind: 'legacy' }
}

/**
 * The removal rule: the first remaining scoped leaf in depth-first
 * left-to-right order takes over ONCE; with no scoped leaf left the tab
 * returns to the existing non-agent derivation.
 */
export function nextTabNameSourceAfterSourceLoss(
  layout: PaneNode | undefined,
  excludePaneId?: string,
): TabNameSource {
  for (const leaf of collectNameSourceLeaves(layout)) {
    if (leaf.paneId === excludePaneId) continue
    if (isScopedNameSourceContent(leaf.content)) {
      return { kind: 'session', paneId: leaf.paneId }
    }
  }
  return { kind: 'legacy' }
}

/**
 * Remap a pointer through an explicit old→new pane-ID map (copies/recovery
 * that remint pane ids). A legacy pointer passes through unchanged; a
 * session pointer whose old pane has no mapping resolves to undefined so
 * the caller can re-derive from the rebuilt layout (never a stale pane id).
 */
export function remapTabNameSource(
  nameSource: TabNameSource | undefined,
  paneIdMap: ReadonlyMap<string, string>,
): TabNameSource | undefined {
  if (!nameSource) return undefined
  if (nameSource.kind === 'legacy') return nameSource
  const mapped = paneIdMap.get(nameSource.paneId)
  return mapped ? { kind: 'session', paneId: mapped } : undefined
}
