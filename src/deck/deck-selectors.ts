import type { RootState } from '@/store/store'
import type { Tab } from '@/store/types'
import type { FreshAgentPaneContent, PaneContent, PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import type { TabStatusFlags } from './tile-state'
import { tileFill, tileDot, tilePriority, type TileFill, type TileDot } from './tile-state'
import { collectPaneEntries } from '@/lib/pane-utils'
import { getBusyPaneIdsForTab, hasWaitingPrompt, resolvePaneActivity } from '@/lib/pane-activity'
import { getFreshOpenCodeRouteCwd } from '@/lib/fresh-opencode-route'
import { buildRepoIconUrl, pathBasename, resolvePaneRepoCwd } from '@/lib/repo-icon'
import { hueFromString } from '@/components/icons/RepoIcon'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { DeckKeyLayout, DeckTileStyle } from '@shared/settings'
import { isNonShellMode } from '@/lib/coding-cli-utils'
import { getTabDisplayTitle } from '@/lib/tab-title'

export type TilePaneTint = 'blue' | 'green' | 'amber' | 'red' | 'mutedDim' | 'muted'
export type TilePaneIcon = { provider: string; tint: TilePaneTint }

export type DeckTab = {
  id: string
  title: string
  active: boolean
  busy: boolean
  attention: boolean
  pendingApproval: boolean
  fill: TileFill
  dot: TileDot
  priority: number
  /** Position in the tab bar (index into state.tabs.tabs), surviving any model-level sort. */
  tabIndex: number
  repoIcons: TileRepoIcon[]
  paneIcons: TilePaneIcon[]
}
export type DeckModel = { tabs: DeckTab[]; activeTabId: string | null; tileStyle: DeckTileStyle; keyLayout: DeckKeyLayout }

function activityInputs(state: RootState) {
  return {
    codexActivityByTerminalId: state.codexActivity.byTerminalId,
    opencodeActivityByTerminalId: state.opencodeActivity.byTerminalId,
    claudeActivityByTerminalId: state.claudeActivity.byTerminalId,
    amplifierActivityByTerminalId: state.amplifierActivity.byTerminalId,
    paneRuntimeActivityByPaneId: state.paneRuntimeActivity.byPaneId,
    freshAgentSessions: state.freshAgent.sessions,
  }
}

function freshAgentSessionFor(state: RootState, content: FreshAgentPaneContent) {
  if (!content.sessionId) return undefined
  return state.freshAgent.sessions[makeFreshAgentSessionKey({
    sessionType: content.sessionType, provider: content.provider, sessionId: content.sessionId,
  })]
}

export function tabHasPendingApproval(state: RootState, tabId: string): boolean {
  const layout = state.panes.layouts[tabId]
  if (!layout) return false
  return collectPaneEntries(layout).some((entry) =>
    entry.content.kind === 'fresh-agent' && hasWaitingPrompt(freshAgentSessionFor(state, entry.content)))
}

/**
 * Pane entries for a tab, tolerant of layout-less tabs. This transient is REAL:
 * addTab (tabsSlice.ts:296) never seeds a layout — PaneLayout.tsx:30-35 initializes
 * it in a post-paint useEffect, and persisted-state restore can omit layout entries —
 * while the deck repaints synchronously per dispatch, so it WILL paint such tabs.
 * Mirrors the tab bar's live synthesis fallback (TabBar.tsx:203-221): synthesize a
 * single terminal pane from the tab's own fields. Do NOT touch TabBar; this is the
 * deck-local twin of that fallback.
 */
export function panesForTab(state: RootState, tab: Tab): Array<{ paneId: string; content: PaneContent }> {
  const layout = state.panes.layouts[tab.id]
  if (layout) return collectPaneEntries(layout)
  if (!tab.mode) return []
  return [{
    paneId: tab.id,
    content: {
      kind: 'terminal' as const,
      mode: tab.mode,
      shell: tab.shell,
      createRequestId: tab.createRequestId,
      status: tab.status,
      sessionRef: tab.sessionRef,
      initialCwd: tab.initialCwd,
    },
  }]
}

/** Mirrors MAX_REPO_ICONS in TabItem.tsx (locked decision: cap distinct repo icons at 3). */
export const MAX_TILE_REPO_ICONS = 3

export type TileRepoIcon = {
  /** /api/repo-icon URL when the repo has a detected icon, else null (letter avatar). */
  url: string | null
  letter: string
  hue: number
}

/**
 * Repo icons for a tab, using the SAME resolution pipeline as the tab bar
 * (TabBar.tsx getPaneEntries -> repoIconInfoByCwd): resolvePaneRepoCwd per pane
 * (panesForTab supplies layout entries or the TabBar.tsx:203-221-style synthesized
 * pane for layout-less tabs), meta from state.repoIcons.byCwd (probed by the
 * DeckController itself in Task 8; TabBar also probes when mounted), distinct
 * repos in first-appearance order, capped at 3, silently truncated.
 * Deliberate divergences from TabItem: considers ALL panes (not just the first
 * 3 pane icons) and ignores settings.panes.repoIconsOnTabs (deck tiles always
 * show their center glyph).
 */
export function getTabRepoIcons(state: RootState, tab: Tab): TileRepoIcon[] {
  const terminalMetaById = state.terminalMeta.byTerminalId
  const byCwd = state.repoIcons.byCwd
  const seen = new Set<string>()
  const icons: TileRepoIcon[] = []
  for (const entry of panesForTab(state, tab)) {
    const cwd = resolvePaneRepoCwd(entry.content, tab, terminalMetaById)
    if (!cwd) continue
    const meta = byCwd[cwd]
    if (!meta || meta.status === 'loading') continue
    const repoKey = meta.repoRoot || cwd
    if (seen.has(repoKey)) continue
    seen.add(repoKey)
    const repoName = meta.repoName || pathBasename(repoKey)
    icons.push({
      url: meta.hasIcon ? buildRepoIconUrl(cwd) : null,
      letter: (repoName.trim()[0] || '?').toUpperCase(),
      hue: hueFromString(repoName),
    })
    if (icons.length >= MAX_TILE_REPO_ICONS) break
  }
  return icons
}

/** Mirrors getTerminalStatusIconClassName (src/lib/terminal-status-indicator.ts). */
function paneStatusTint(status: string): TilePaneTint {
  switch (status) {
    case 'running': return 'green'      // text-success
    case 'recovering': return 'amber'   // text-warning
    case 'exited': return 'mutedDim'    // text-muted-foreground/40
    case 'error': return 'red'          // text-destructive
    default: return 'muted'             // creating etc. -> text-muted-foreground
  }
}

/**
 * Agent pane icons for a tab, in layout order, UNCAPPED (the renderer caps
 * drawn icons and folds the rest into a +N badge — TabItem's MAX_PANE_ICONS
 * overflow rule adapted to key size). Agent panes are non-shell terminals
 * (provider = mode) and fresh-agent panes (provider = sessionType);
 * shell/browser/editor/picker/extension panes draw no agent icon on a key
 * this small. Tint mirrors TabItem.tsx renderIcons: busy -> blue (wins),
 * else the pane's effective status (non-terminal kinds count as 'running').
 */
export function getTabPaneIcons(state: RootState, tab: Tab): TilePaneIcon[] {
  const busyIds = getBusyPaneIdsForTab({
    tab,
    paneLayouts: state.panes.layouts as Record<string, PaneNode | undefined>,
    ...activityInputs(state),
  })
  const icons: TilePaneIcon[] = []
  for (const { paneId, content } of panesForTab(state, tab)) {
    let provider: string | null = null
    let status = 'running'
    if (content.kind === 'terminal' && isNonShellMode(content.mode)) {
      provider = content.mode
      status = content.status
    } else if (content.kind === 'fresh-agent') {
      provider = content.sessionType
    }
    if (!provider) continue
    icons.push({ provider, tint: busyIds.includes(paneId) ? 'blue' : paneStatusTint(status) })
  }
  return icons
}

/**
 * Per-tab status flags, derived from the SAME conditions the tab bar uses:
 * - busy: any pane busy (getBusyPaneIdsForTab, TabBar.tsx:329-338)
 * - attention: turnCompletion.attentionByTab gated on tabAttentionStyle !== 'none'
 *   (TabItem.tsx:158-184 renders no bar/fill when the style is 'none')
 * - greenIcon: any non-busy pane whose effective status is 'running'
 *   (TabItem.tsx:135-147; non-terminal pane kinds count as 'running')
 */
export function getTabStatusFlags(state: RootState, tab: Tab): TabStatusFlags {
  const busyIds = getBusyPaneIdsForTab({
    tab,
    paneLayouts: state.panes.layouts as Record<string, PaneNode | undefined>,
    ...activityInputs(state),
  })
  const entries = panesForTab(state, tab) // layout entries, or the synthesized single pane
  const greenIcon = entries.some(({ paneId, content }) => {
    if (busyIds.includes(paneId)) return false
    const status = content.kind === 'terminal' ? content.status : 'running'
    return status === 'running'
  })
  const attentionStyle = state.settings.settings.panes.tabAttentionStyle
  return {
    busy: busyIds.length > 0,
    attention: !!state.turnCompletion.attentionByTab[tab.id] && attentionStyle !== 'none',
    greenIcon,
  }
}

export function selectDeckModel(state: RootState): DeckModel {
  const activeTabId = state.tabs.activeTabId
  const tileStyle = state.settings.settings.streamDeck.tileStyle
  const tabs = state.tabs.tabs.map((tab, index) => {
    const active = tab.id === activeTabId
    const flags = getTabStatusFlags(state, tab)
    return {
      id: tab.id,
      // Same label the tab bar displays (custom title, else derived default such as
      // the working-directory basename) — reuse the tab bar's derivation verbatim.
      // extensions uses ?. because unit-test stores may omit that reducer.
      title: getTabDisplayTitle(tab, state.panes.layouts[tab.id], state.panes.paneTitles?.[tab.id], state.extensions?.entries),
      active,
      busy: flags.busy,
      attention: flags.attention,
      pendingApproval: tabHasPendingApproval(state, tab.id),
      fill: tileFill(active, flags),
      dot: tileDot(flags),
      priority: tilePriority(active, flags),
      tabIndex: index,
      repoIcons: getTabRepoIcons(state, tab),
      paneIcons: getTabPaneIcons(state, tab),
    }
  })
  if (tileStyle === 'status-icons') {
    // Status-priority sort; Array.prototype.sort is stable, so tab-bar order
    // is preserved within each priority group. Paging slices this sorted list
    // (visibleTabs), so the pager pages over the sorted order automatically.
    // Classic terminal-previews style keeps raw tab-bar order (pre-redesign behavior).
    tabs.sort((a, b) => a.priority - b.priority)
  }
  return { activeTabId, tabs, tileStyle, keyLayout: state.settings.settings.streamDeck.keyLayout }
}

export type ApproveTarget = {
  sessionId: string
  sessionType: FreshAgentPaneContent['sessionType']
  provider: FreshAgentPaneContent['provider']
  requestId: string | number
  cwd?: string
}

// freshopencode auth keys embed cwd server-side; claude/codex/kilroy are cwd-less.
// getFreshOpenCodeRouteCwd returns undefined for any non-freshopencode pane.
function freshOpenCodeCwdFor(state: RootState, content: FreshAgentPaneContent): string | undefined {
  return getFreshOpenCodeRouteCwd(content, { freshAgentSessions: state.freshAgent.sessions })
}

export function findApproveTarget(state: RootState, tabId: string): ApproveTarget | null {
  const layout = state.panes.layouts[tabId]
  if (!layout) return null
  for (const entry of collectPaneEntries(layout)) {
    if (entry.content.kind !== 'fresh-agent' || !entry.content.sessionId) continue
    const session = freshAgentSessionFor(state, entry.content)
    const pending = session ? Object.values(session.pendingPermissions) : []
    if (pending.length > 0) {
      const cwd = freshOpenCodeCwdFor(state, entry.content)
      return {
        sessionId: entry.content.sessionId,
        sessionType: entry.content.sessionType,
        provider: entry.content.provider,
        requestId: pending[0].requestId,
        ...(cwd ? { cwd } : {}),
      }
    }
  }
  return null
}

export type StopTarget =
  | { kind: 'fresh-agent'; sessionId: string; sessionType: FreshAgentPaneContent['sessionType']; provider: FreshAgentPaneContent['provider']; runtimeId?: string; runtimeGeneration?: number; cwd?: string }
  | { kind: 'terminal'; paneId: string; terminalId: string; content: TerminalPaneContent }

export function findStopTarget(state: RootState, tabId: string): StopTarget | null {
  const layout = state.panes.layouts[tabId]
  const tab = state.tabs.tabs.find((t) => t.id === tabId)
  if (!layout || !tab) return null
  const entries = collectPaneEntries(layout)
  const isOnlyPane = layout.type === 'leaf'
  let terminalHit: StopTarget | null = null
  for (const entry of entries) {
    const { isBusy } = resolvePaneActivity({
      paneId: entry.paneId, content: entry.content, tabMode: tab.mode, isOnlyPane,
      ...activityInputs(state),
    })
    if (!isBusy) continue
    if (entry.content.kind === 'fresh-agent' && entry.content.sessionId) {
      const cwd = freshOpenCodeCwdFor(state, entry.content)
      return {
        kind: 'fresh-agent',
        sessionId: entry.content.sessionId,
        sessionType: entry.content.sessionType,
        provider: entry.content.provider,
        ...(entry.content.runtimeId && entry.content.runtimeGeneration !== undefined ? {
          runtimeId: entry.content.runtimeId,
          runtimeGeneration: entry.content.runtimeGeneration,
        } : {}),
        ...(cwd ? { cwd } : {}),
      }
    }
    if (!terminalHit && entry.content.kind === 'terminal' && entry.content.terminalId) {
      terminalHit = { kind: 'terminal', paneId: entry.paneId, terminalId: entry.content.terminalId, content: entry.content }
    }
  }
  return terminalHit
}
