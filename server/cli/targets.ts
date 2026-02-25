export type TargetContext = {
  activeTabId?: string
  panesByTab: Record<string, string[]>
  tabs: Array<{ id: string; title?: string; activePaneId?: string }>
}

type ResolveResult = { tabId?: string; paneId?: string; message?: string }

export function resolveTarget(target: string, ctx: TargetContext): ResolveResult {
  const clean = target.trim()
  if (!clean) return { message: 'target not resolved' }

  for (const [tabId, panes] of Object.entries(ctx.panesByTab)) {
    if (panes.includes(clean)) return { tabId, paneId: clean }
  }

  const tabMatch = ctx.tabs.find((t) => t.id === clean || t.title === clean)
  if (tabMatch) {
    return {
      tabId: tabMatch.id,
      paneId: tabMatch.activePaneId || ctx.panesByTab[tabMatch.id]?.[0],
      message: 'tab matched; active pane used',
    }
  }

  if (clean.includes('.')) {
    const noSession = clean.includes(':') ? clean.split(':').slice(1).join(':') : clean
    const [tabPart, panePart] = noSession.split('.')
    const idx = Number(panePart)
    if (Number.isFinite(idx)) {
      const tab = ctx.tabs.find((t) => t.id === tabPart || t.title === tabPart)
      if (tab) {
        const panes = ctx.panesByTab[tab.id] || []
        const paneId = panes[idx] || tab.activePaneId
        return {
          tabId: tab.id,
          paneId,
          message: panes[idx] ? undefined : 'pane not found; active pane used',
        }
      }
    }
  }

  const activeTabId = ctx.activeTabId || ctx.tabs[0]?.id
  if (activeTabId) {
    const idx = Number(clean)
    if (Number.isFinite(idx)) {
      const panes = ctx.panesByTab[activeTabId] || []
      return { tabId: activeTabId, paneId: panes[idx], message: 'active tab used' }
    }
  }

  return { message: 'target not resolved' }
}
