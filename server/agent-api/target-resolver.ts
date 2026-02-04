export type LayoutSnapshot = {
  tabs: Array<{ id: string; title?: string }>
  activeTabId?: string | null
  layouts: Record<string, any>
  activePane: Record<string, string>
}

type ResolveResult = { tabId?: string; paneId?: string; message?: string }

type Leaf = { id: string; content?: { terminalId?: string } }

function collectLeaves(node: any, leaves: Leaf[] = []): Leaf[] {
  if (!node) return leaves
  if (node.type === 'leaf') {
    leaves.push(node as Leaf)
    return leaves
  }
  if (node.type === 'split' && Array.isArray(node.children)) {
    collectLeaves(node.children[0], leaves)
    collectLeaves(node.children[1], leaves)
  }
  return leaves
}

function buildPaneIndex(snapshot: LayoutSnapshot) {
  const paneToTab = new Map<string, string>()
  const panesByTab = new Map<string, Leaf[]>()
  for (const tab of snapshot.tabs) {
    const root = snapshot.layouts?.[tab.id]
    const leaves = collectLeaves(root, [])
    panesByTab.set(tab.id, leaves)
    for (const leaf of leaves) {
      paneToTab.set(leaf.id, tab.id)
    }
  }
  return { paneToTab, panesByTab }
}

export function resolveTarget(target: string, snapshot: LayoutSnapshot): ResolveResult {
  const clean = target.trim()
  if (!clean) return { message: 'target not resolved' }

  const { paneToTab, panesByTab } = buildPaneIndex(snapshot)

  // Exact pane ID match
  const paneTabId = paneToTab.get(clean)
  if (paneTabId) return { tabId: paneTabId, paneId: clean }

  // exact tab id or title
  const tabMatch = snapshot.tabs.find((t) => t.id === clean || t.title === clean)
  if (tabMatch) {
    return { tabId: tabMatch.id, paneId: snapshot.activePane?.[tabMatch.id], message: 'tab matched; active pane used' }
  }

  // tab.pane or session:window.pane
  if (clean.includes('.')) {
    const noSession = clean.includes(':') ? clean.split(':').slice(1).join(':') : clean
    const [tabPart, panePart] = noSession.split('.')
    const idx = Number(panePart)
    if (Number.isFinite(idx)) {
      const tab = snapshot.tabs.find((t) => t.id === tabPart || t.title === tabPart)
      if (tab) {
        const leaves = panesByTab.get(tab.id) || []
        const pane = leaves[idx]
        return { tabId: tab.id, paneId: pane?.id, message: pane ? undefined : 'pane not found; active pane used' }
      }
    }
  }

  // numeric pane index in active tab
  const activeTabId = snapshot.activeTabId || snapshot.tabs[0]?.id
  if (activeTabId) {
    const idx = Number(clean)
    if (Number.isFinite(idx)) {
      const leaves = panesByTab.get(activeTabId) || []
      const pane = leaves[idx]
      return { tabId: activeTabId, paneId: pane?.id, message: 'active tab used' }
    }
  }

  return { message: 'target not resolved' }
}
