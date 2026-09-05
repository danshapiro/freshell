export type TargetContext = {
  activeTabId?: string
  panesByTab: Record<string, Array<string | { id: string; title?: string }>>
  tabs: Array<{ id: string; title?: string; activePaneId?: string }>
}

type ResolveResult = { tabId?: string; paneId?: string; message?: string }
const AMBIGUOUS_PANE_TARGET_MESSAGE = 'pane target is ambiguous; use pane id or tab.pane index'

function paneIdOf(entry: string | { id: string; title?: string } | undefined) {
  if (!entry) return undefined
  return typeof entry === 'string' ? entry : entry.id
}

function paneTitleOf(entry: string | { id: string; title?: string } | undefined) {
  return typeof entry === 'string' || !entry ? undefined : entry.title
}

export function resolveTarget(target: string, ctx: TargetContext): ResolveResult {
  const clean = target.trim()
  if (!clean) return { message: 'target not resolved' }

  for (const [tabId, panes] of Object.entries(ctx.panesByTab)) {
    const pane = panes.find((entry) => paneIdOf(entry) === clean)
    if (pane) return { tabId, paneId: paneIdOf(pane) }
  }

  const tabMatch = ctx.tabs.find((t) => t.id === clean || t.title === clean)
  if (tabMatch) {
    return {
      tabId: tabMatch.id,
      paneId: tabMatch.activePaneId || paneIdOf(ctx.panesByTab[tabMatch.id]?.[0]),
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
        const paneId = paneIdOf(panes[idx]) || tab.activePaneId
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
      return { tabId: activeTabId, paneId: paneIdOf(panes[idx]), message: 'active tab used' }
    }
  }

  let titleMatch: ResolveResult | undefined
  for (const [tabId, panes] of Object.entries(ctx.panesByTab)) {
    for (const pane of panes) {
      if (paneTitleOf(pane) !== clean) continue
      if (titleMatch) return { message: AMBIGUOUS_PANE_TARGET_MESSAGE }
      titleMatch = { tabId, paneId: paneIdOf(pane) }
    }
  }
  if (titleMatch) return titleMatch

  return { message: 'target not resolved' }
}
