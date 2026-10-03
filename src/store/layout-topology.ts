type LayoutLike = {
  tabs?: { tabs?: Array<{ id?: unknown; title?: unknown; titleSetByUser?: unknown }> }
  panes?: {
    layouts?: Record<string, unknown>
    paneTitles?: Record<string, Record<string, unknown>>
    paneTitleSetByUser?: Record<string, Record<string, unknown>>
  }
}

export type IgnoredPaneTitle = { tabId: string; paneId: string }

function leafIdentity(content: any): unknown[] {
  if (!content || typeof content !== 'object') return [null]
  return [
    content.kind,
    content.kind === 'terminal' || content.kind === 'fresh-agent' ? content.mode : undefined,
    content.kind === 'fresh-agent' ? content.sessionType : undefined,
    content.kind === 'fresh-agent' ? content.provider : undefined,
    content.createRequestId,
    content.viewIntentId,
    content.sessionRef?.provider,
    content.sessionRef?.sessionId,
    content.resumeSessionId,
    content.kind === 'browser' ? content.browserInstanceId : undefined,
    content.kind === 'editor' ? content.filePath : undefined,
    content.kind === 'extension' ? content.extensionInstanceId : undefined,
  ]
}

function nodeTopology(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null
  const node = value as Record<string, any>
  if (node.type === 'leaf') {
    return ['leaf', node.id, leafIdentity(node.content)]
  }
  if (node.type === 'split' && Array.isArray(node.children)) {
    return [
      'split',
      node.id,
      node.direction,
      Array.isArray(node.sizes) ? node.sizes : undefined,
      node.children.map(nodeTopology),
    ]
  }
  return ['invalid', node.type]
}

/**
 * True when two layout snapshots describe the same tabs and pane identities,
 * split structure, and managed-view assignments. Pane titles and volatile
 * terminal status are intentionally excluded so a close can proceed over a
 * newer title-only write, while it refuses to serialize a stale tree.
 */
export function sameLayoutTopology(
  localTabs: Array<{ id?: unknown }> | undefined,
  localLayouts: Record<string, unknown> | undefined,
  persisted: LayoutLike,
  locallyClosedTabIds: ReadonlySet<unknown> = new Set(),
): boolean {
  const localTabIds = new Set((localTabs ?? []).map((tab) => tab.id))
  const persistedTabIds = new Set((persisted.tabs?.tabs ?? []).map((tab) => tab.id))
  if ([...localTabIds].some((id) => !persistedTabIds.has(id))) return false
  if ([...persistedTabIds].some((id) => !localTabIds.has(id) && !locallyClosedTabIds.has(id))) return false

  const local = localLayouts ?? {}
  const remote = persisted.panes?.layouts ?? {}
  const tabIds = Array.from(new Set([...Object.keys(local), ...Object.keys(remote)])).sort()
  return tabIds.every((tabId) => (
    locallyClosedTabIds.has(tabId) && !localTabIds.has(tabId)
      ? true
      : JSON.stringify(nodeTopology(local[tabId])) === JSON.stringify(nodeTopology(remote[tabId]))
  ))
}

export function layoutTopologySignature(
  tabs: Array<{ id?: unknown }> | undefined,
  layouts: Record<string, unknown> | undefined,
): string {
  const layoutMap = layouts ?? {}
  return JSON.stringify({
    tabIds: (tabs ?? []).map((tab) => tab.id),
    layouts: Object.keys(layoutMap).sort().map((tabId) => [tabId, nodeTopology(layoutMap[tabId])]),
  })
}

export function persistedLayoutTopologySignature(persisted: LayoutLike): string {
  return layoutTopologySignature(persisted.tabs?.tabs, persisted.panes?.layouts)
}

/** Signature for a pending close write, including display metadata it would overwrite. */
export function layoutClosePersistenceSignature(
  tabs: Array<{ id?: unknown; title?: unknown; titleSetByUser?: unknown }> | undefined,
  layouts: Record<string, unknown> | undefined,
  paneTitles: Record<string, Record<string, unknown>> | undefined,
  paneTitleSetByUser: Record<string, Record<string, unknown>> | undefined,
  ignoredPaneTitle?: IgnoredPaneTitle,
): string {
  const sortedNestedEntries = (metadata: Record<string, Record<string, unknown>> | undefined) => (
    Object.keys(metadata ?? {}).sort().flatMap((tabId) => {
      const entries = Object.keys(metadata?.[tabId] ?? {}).sort()
        .filter((paneId) => !(ignoredPaneTitle?.tabId === tabId && ignoredPaneTitle.paneId === paneId))
        .map((paneId) => [paneId, metadata?.[tabId]?.[paneId]])
      return entries.length > 0 ? [[tabId, entries]] : []
    })
  )
  return JSON.stringify({
    topology: layoutTopologySignature(tabs, layouts),
    tabTitles: (tabs ?? []).map((tab) => [tab.id, tab.title, Boolean(tab.titleSetByUser)]),
    paneTitles: sortedNestedEntries(paneTitles),
    paneTitleSetByUser: sortedNestedEntries(paneTitleSetByUser),
  })
}

export function persistedLayoutClosePersistenceSignature(
  persisted: LayoutLike,
  ignoredPaneTitle?: IgnoredPaneTitle,
): string {
  return layoutClosePersistenceSignature(
    persisted.tabs?.tabs,
    persisted.panes?.layouts,
    persisted.panes?.paneTitles,
    persisted.panes?.paneTitleSetByUser,
    ignoredPaneTitle,
  )
}
