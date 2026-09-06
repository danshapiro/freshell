import { resolveExactCodexActivity } from '@/lib/codex-activity-resolver'
import { isNonShellMode } from '@/lib/coding-cli-utils'
import { collectPaneEntries } from '@/lib/pane-utils'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'
import { extractSessionLocators } from '@/lib/session-utils'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'
import type {
  FreshAgentPaneContent,
  PaneContent,
  PaneNode,
  TerminalPaneContent,
} from '@/store/paneTypes'
import type { PaneRuntimeActivityRecord } from '@/store/paneRuntimeActivitySlice'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import type { Tab } from '@/store/types'
import type { CodexActivityRecord, ClaudeActivityRecord, AmplifierActivityRecord, OpencodeActivityRecord } from '@shared/ws-protocol'

type PaneActivitySource = 'codex' | 'opencode' | 'claude-terminal' | 'amplifier' | 'fresh-agent' | 'browser'

export type PaneActivityProjection = {
  isBusy: boolean
  source: PaneActivitySource | null
}

const IDLE_PANE_ACTIVITY: PaneActivityProjection = {
  isBusy: false,
  source: null,
}

function isBrowserBusy(record: PaneRuntimeActivityRecord | undefined): boolean {
  return record?.source === 'browser'
    && (record.phase === 'loading' || record.phase === 'forwarding')
}

export function resolveFreshAgentSessionKey(
  content: FreshAgentPaneContent,
  session: FreshAgentSessionState | undefined,
): string | undefined {
  const explicit = content.sessionRef
  if (explicit?.provider && explicit.sessionId) {
    return `${explicit.provider}:${explicit.sessionId}`
  }

  const provider = resolveFreshAgentType(content.sessionType)?.runtimeProvider ?? content.provider
  const sessionId = session?.sessionId ?? content.resumeSessionId
  if (!provider || !sessionId) return undefined
  return `${provider}:${sessionId}`
}

export function hasWaitingPrompt(
  session: Pick<FreshAgentSessionState, 'pendingPermissions' | 'pendingQuestions'> | undefined,
): boolean {
  if (!session) return false
  return Object.keys(session.pendingPermissions).length > 0
    || Object.keys(session.pendingQuestions).length > 0
}

export function isFreshAgentBusy(
  content: FreshAgentPaneContent,
  session: FreshAgentSessionState | undefined,
): boolean {
  // No live session => not busy. Persisted content.status can be stale after
  // reload, so live session state is the source of truth for blue activity.
  if (session == null) return false
  const status = session.status
  if (status === 'compacting') return true
  const hasWaitingItems = session != null && (
    Object.keys(session.pendingPermissions).length > 0
    || Object.keys(session.pendingQuestions).length > 0
  )
  if (hasWaitingItems) return false
  if (session?.streamingActive) return true

  if (content.provider === 'codex') {
    return status === 'running'
  }
  return status === 'running'
}

function resolveTerminalSessionKey(
  content: TerminalPaneContent,
  fallbackSessionRef?: Tab['sessionRef'],
  fallbackSessionId?: string,
  fallbackMode?: Tab['mode'],
): string | undefined {
  const explicit = content.sessionRef
  if (explicit?.provider && explicit.sessionId) {
    return `${explicit.provider}:${explicit.sessionId}`
  }

  if (fallbackSessionRef?.provider && fallbackSessionRef.sessionId) {
    return `${fallbackSessionRef.provider}:${fallbackSessionRef.sessionId}`
  }

  const provider = content.mode !== 'shell' ? content.mode : fallbackMode
  if (!provider || provider === 'shell') return undefined

  const sessionId = content.resumeSessionId ?? fallbackSessionId
  if (!sessionId) return undefined

  return `${provider}:${sessionId}`
}

function buildSyntheticTerminalContent(tab: Tab): TerminalPaneContent | null {
  if (!tab.mode) return null

  return {
    kind: 'terminal',
    createRequestId: tab.createRequestId,
    status: tab.status,
    mode: tab.mode,
    shell: tab.shell,
    sessionRef: tab.sessionRef,
    resumeSessionId: tab.resumeSessionId,
    initialCwd: tab.initialCwd,
  }
}

export function resolvePaneActivity(input: {
  paneId: string
  content: PaneContent
  tabMode?: Tab['mode']
  isOnlyPane: boolean
  codexActivityByTerminalId: Record<string, CodexActivityRecord>
  opencodeActivityByTerminalId: Record<string, OpencodeActivityRecord>
  claudeActivityByTerminalId: Record<string, ClaudeActivityRecord>
  amplifierActivityByTerminalId: Record<string, AmplifierActivityRecord>
  paneRuntimeActivityByPaneId: Record<string, PaneRuntimeActivityRecord>
  freshAgentSessions?: Record<string, FreshAgentSessionState>
}): PaneActivityProjection {
  const runtimeActivity = input.paneRuntimeActivityByPaneId[input.paneId]

  if (input.content.kind === 'terminal') {
    if (input.content.status !== 'running') return IDLE_PANE_ACTIVITY

    const effectiveMode = input.content.mode !== 'shell'
      ? input.content.mode
      : input.tabMode

    if (effectiveMode === 'codex') {
      const record = resolveExactCodexActivity(input.codexActivityByTerminalId, {
        terminalId: input.content.terminalId,
        isOnlyPane: input.isOnlyPane,
      })
      // Render 'pending' (submit accepted, task_started not yet observed) as blue
      // too, for instant onset feedback (decision 5A). 'pending' decays quickly to
      // idle if no turn actually starts, so a no-op submit can only flash blue
      // briefly — never a long-lived false-blue.
      return record?.phase === 'busy' || record?.phase === 'pending'
        ? { isBusy: true, source: 'codex' }
        : IDLE_PANE_ACTIVITY
    }

    if (effectiveMode === 'opencode') {
      const terminalId = input.content.terminalId
      const record = terminalId
        ? input.opencodeActivityByTerminalId[terminalId]
        : undefined
      return record?.phase === 'busy'
        ? { isBusy: true, source: 'opencode' }
        : IDLE_PANE_ACTIVITY
    }

    if (effectiveMode === 'claude') {
      const terminalId = input.content.terminalId
      const record = terminalId
        ? input.claudeActivityByTerminalId[terminalId]
        : undefined
      return record?.phase === 'busy'
        ? { isBusy: true, source: 'claude-terminal' }
        : IDLE_PANE_ACTIVITY
    }

    if (effectiveMode === 'amplifier') {
      const terminalId = input.content.terminalId
      const record = terminalId
        ? input.amplifierActivityByTerminalId[terminalId]
        : undefined
      return record?.phase === 'busy'
        ? { isBusy: true, source: 'amplifier' }
        : IDLE_PANE_ACTIVITY
    }

    return IDLE_PANE_ACTIVITY
  }

  if (input.content.kind === 'browser') {
    return isBrowserBusy(runtimeActivity)
      ? { isBusy: true, source: 'browser' }
      : IDLE_PANE_ACTIVITY
  }

  if (input.content.kind === 'fresh-agent') {
    const session = input.content.sessionId
      ? input.freshAgentSessions?.[makeFreshAgentSessionKey({
        sessionType: input.content.sessionType,
        provider: input.content.provider,
        sessionId: input.content.sessionId,
      })]
      : undefined
    return isFreshAgentBusy(input.content, session)
      ? { isBusy: true, source: 'fresh-agent' }
      : IDLE_PANE_ACTIVITY
  }

  return IDLE_PANE_ACTIVITY
}

const TRULY_IDLE_CLI_MODES = new Set(['claude', 'codex', 'opencode', 'amplifier'])

/** Terminal CLI modes whose alerting (green/bell/shade) is server-authoritative. */
export function isTrulyIdleCliMode(mode: string | undefined): boolean {
  return mode !== undefined && TRULY_IDLE_CLI_MODES.has(mode)
}

/**
 * Persistent green for terminal CLI panes (claude/codex/opencode/amplifier):
 * shown whenever the pane's CLI session is known and the pane is not busy.
 * Replaces the one-shot needs-attention green for these panes; fresh-agent
 * panes keep the attention-based green.
 *
 * "Session known" = an activity record exists for the terminal (claude/amplifier
 * track from creation, codex from session binding) OR the pane content carries a
 * bound sessionRef / resumeSessionId (opencode has no idle-phase records — its
 * records exist only while busy).
 */
export function resolvePaneIdleGreen(input: {
  paneId: string
  content: PaneContent
  tabMode?: Tab['mode']
  isOnlyPane: boolean
  codexActivityByTerminalId: Record<string, CodexActivityRecord>
  opencodeActivityByTerminalId: Record<string, OpencodeActivityRecord>
  claudeActivityByTerminalId: Record<string, ClaudeActivityRecord>
  amplifierActivityByTerminalId: Record<string, AmplifierActivityRecord>
  paneRuntimeActivityByPaneId: Record<string, PaneRuntimeActivityRecord>
  freshAgentSessions?: Record<string, FreshAgentSessionState>
}): boolean {
  if (input.content.kind !== 'terminal') return false
  if (input.content.status !== 'running') return false

  const effectiveMode = input.content.mode !== 'shell'
    ? input.content.mode
    : input.tabMode
  if (!isTrulyIdleCliMode(effectiveMode)) return false

  if (resolvePaneActivity(input).isBusy) return false

  const terminalId = input.content.terminalId
  const record = terminalId
    ? (effectiveMode === 'codex' && input.codexActivityByTerminalId[terminalId])
      || (effectiveMode === 'claude' && input.claudeActivityByTerminalId[terminalId])
      || (effectiveMode === 'amplifier' && input.amplifierActivityByTerminalId[terminalId])
      || (effectiveMode === 'opencode' && input.opencodeActivityByTerminalId[terminalId])
      || undefined
    : undefined

  return Boolean(
    record
    || input.content.sessionRef?.sessionId
    || input.content.resumeSessionId,
  )
}

export function getBusyPaneIdsForTab(input: {
  tab: Tab
  paneLayouts: Record<string, PaneNode | undefined>
  codexActivityByTerminalId: Record<string, CodexActivityRecord>
  opencodeActivityByTerminalId: Record<string, OpencodeActivityRecord>
  claudeActivityByTerminalId: Record<string, ClaudeActivityRecord>
  amplifierActivityByTerminalId: Record<string, AmplifierActivityRecord>
  paneRuntimeActivityByPaneId: Record<string, PaneRuntimeActivityRecord>
  freshAgentSessions?: Record<string, FreshAgentSessionState>
}): string[] {
  const layout = input.paneLayouts[input.tab.id]
  if (!layout) {
    const syntheticContent = buildSyntheticTerminalContent(input.tab)
    if (!syntheticContent) return []

    return resolvePaneActivity({
      paneId: input.tab.id,
      content: syntheticContent,
      tabMode: input.tab.mode,
      isOnlyPane: true,
      codexActivityByTerminalId: input.codexActivityByTerminalId,
      opencodeActivityByTerminalId: input.opencodeActivityByTerminalId,
      claudeActivityByTerminalId: input.claudeActivityByTerminalId,
      amplifierActivityByTerminalId: input.amplifierActivityByTerminalId,
      paneRuntimeActivityByPaneId: input.paneRuntimeActivityByPaneId,
      freshAgentSessions: input.freshAgentSessions,
    }).isBusy
      ? [input.tab.id]
      : []
  }

  const isOnlyPane = layout.type === 'leaf'
  return collectPaneEntries(layout)
    .filter((entry) => resolvePaneActivity({
      paneId: entry.paneId,
      content: entry.content,
      tabMode: input.tab.mode,
      isOnlyPane,
      codexActivityByTerminalId: input.codexActivityByTerminalId,
      opencodeActivityByTerminalId: input.opencodeActivityByTerminalId,
      claudeActivityByTerminalId: input.claudeActivityByTerminalId,
      amplifierActivityByTerminalId: input.amplifierActivityByTerminalId,
      paneRuntimeActivityByPaneId: input.paneRuntimeActivityByPaneId,
      freshAgentSessions: input.freshAgentSessions,
    }).isBusy)
    .map((entry) => entry.paneId)
}

type PaneActivityMaps = {
  codexActivityByTerminalId: Record<string, CodexActivityRecord>
  opencodeActivityByTerminalId: Record<string, OpencodeActivityRecord>
  claudeActivityByTerminalId: Record<string, ClaudeActivityRecord>
  amplifierActivityByTerminalId: Record<string, AmplifierActivityRecord>
  paneRuntimeActivityByPaneId: Record<string, PaneRuntimeActivityRecord>
  freshAgentSessions?: Record<string, FreshAgentSessionState>
}

function lookupLiveFreshAgentSession(
  content: FreshAgentPaneContent,
  freshAgentSessions?: Record<string, FreshAgentSessionState>,
): FreshAgentSessionState | undefined {
  if (!content.sessionId) return undefined
  return freshAgentSessions?.[makeFreshAgentSessionKey({
    sessionType: content.sessionType,
    provider: content.provider,
    sessionId: content.sessionId,
  })]
}

/**
 * A pane's ONE effective busy identity, or undefined when the pane is not
 * busy (per resolvePaneActivity) or has no canonical identity. Shared by
 * collectBusySessionKeys and collectPaneIdentityActivity so both always agree
 * on which single session key a busy pane claims.
 */
function resolveBusyPaneSessionKey(input: PaneActivityMaps & {
  paneId: string
  content: PaneContent
  tabMode?: Tab['mode']
  tabSessionRef?: Tab['sessionRef']
  tabResumeSessionId?: string
  isOnlyPane: boolean
}): string | undefined {
  const busy = resolvePaneActivity({
    paneId: input.paneId,
    content: input.content,
    tabMode: input.tabMode,
    isOnlyPane: input.isOnlyPane,
    codexActivityByTerminalId: input.codexActivityByTerminalId,
    opencodeActivityByTerminalId: input.opencodeActivityByTerminalId,
    claudeActivityByTerminalId: input.claudeActivityByTerminalId,
    amplifierActivityByTerminalId: input.amplifierActivityByTerminalId,
    paneRuntimeActivityByPaneId: input.paneRuntimeActivityByPaneId,
    freshAgentSessions: input.freshAgentSessions,
  }).isBusy
  if (!busy) return undefined

  if (input.content.kind === 'fresh-agent') {
    return resolveFreshAgentSessionKey(
      input.content,
      lookupLiveFreshAgentSession(input.content, input.freshAgentSessions),
    )
  }
  if (input.content.kind === 'terminal') {
    return resolveTerminalSessionKey(input.content, input.tabSessionRef, input.tabResumeSessionId, input.tabMode)
  }
  return undefined
}

/**
 * Fabricated Sidebar fallback row key for a terminal pane (mirrors the
 * live-terminal fallback loop in sidebarSelectors.buildSessionItems): a
 * running non-shell terminal with no bound sessionRef — and, for Codex, no
 * durability thread id — appears in the Sidebar as a fabricated
 * `<mode>:terminal:<terminalId>` row. Stamping that key lets remote devices
 * ring the same row.
 */
function resolveTerminalFallbackRowKey(content: TerminalPaneContent): string | undefined {
  if (content.status !== 'running') return undefined
  if (content.sessionRef) return undefined
  if (!isNonShellMode(content.mode)) return undefined
  if (!content.terminalId) return undefined
  if (content.mode === 'codex') {
    const codexSessionId = content.codexDurability?.durableThreadId
      ?? content.codexDurability?.candidate?.candidateThreadId
    if (codexSessionId) return undefined
  }
  return `${content.mode}:terminal:${content.terminalId}`
}

export type PaneIdentityActivity = {
  sessionKeys: string[]
  busySessionKeys: string[]
}

/**
 * Fabricated terminal fallback row keys across all local panes — the
 * `<mode>:terminal:<terminalId>` rows the Sidebar renders with hasTab=true
 * (green icon when not busy). Walks the same layout leaves as
 * collectPaneIdentityActivity; terminal-only, deduped.
 */
export function collectTerminalFallbackRowKeys(input: PaneActivityMaps & {
  tabs: Tab[]
  paneLayouts: Record<string, PaneNode | undefined>
}): string[] {
  const keys = new Set<string>()
  for (const tab of input.tabs) {
    const layout = input.paneLayouts[tab.id]
    if (!layout) continue
    for (const entry of collectPaneEntries(layout)) {
      if (entry.content.kind !== 'terminal') continue
      const key = resolveTerminalFallbackRowKey(entry.content)
      if (key) keys.add(key)
    }
  }
  return Array.from(keys)
}

/**
 * Per-leaf-pane session identity + busy stamping for the tab registry push.
 * `sessionKeys` holds every identity a remote Sidebar row could join on:
 * the pane's canonical locators (same rules as the local green/hasTab join),
 * the live fresh-agent canonical key when a live session exists, and the
 * fabricated terminal fallback row key. `busySessionKeys` holds the pane's ONE
 * effective busy identity when the pane is busy per resolvePaneActivity
 * (mirroring collectBusySessionKeys' per-entry resolution), empty otherwise.
 *
 * Layout-less tabs contribute nothing: registry records are only built for
 * tabs with a pane layout.
 */
export function collectPaneIdentityActivity(input: PaneActivityMaps & {
  tabs: Tab[]
  paneLayouts: Record<string, PaneNode | undefined>
}): Map<string, PaneIdentityActivity> {
  const activityByPaneId = new Map<string, PaneIdentityActivity>()

  for (const tab of input.tabs) {
    const layout = input.paneLayouts[tab.id]
    if (!layout) continue

    const isOnlyPane = layout.type === 'leaf'
    for (const entry of collectPaneEntries(layout)) {
      const content = entry.content

      const sessionKeySet = new Set<string>()
      for (const locator of extractSessionLocators(content)) {
        sessionKeySet.add(`${locator.provider}:${locator.sessionId}`)
      }
      if (content.kind === 'fresh-agent') {
        const liveSession = lookupLiveFreshAgentSession(content, input.freshAgentSessions)
        if (liveSession) {
          const liveKey = resolveFreshAgentSessionKey(content, liveSession)
          if (liveKey) sessionKeySet.add(liveKey)
        }
      }
      if (content.kind === 'terminal') {
        const fallbackKey = resolveTerminalFallbackRowKey(content)
        if (fallbackKey) sessionKeySet.add(fallbackKey)
      }

      const busyKey = resolveBusyPaneSessionKey({
        paneId: entry.paneId,
        content,
        tabMode: tab.mode,
        tabSessionRef: tab.sessionRef,
        tabResumeSessionId: tab.resumeSessionId,
        isOnlyPane,
        codexActivityByTerminalId: input.codexActivityByTerminalId,
        opencodeActivityByTerminalId: input.opencodeActivityByTerminalId,
        claudeActivityByTerminalId: input.claudeActivityByTerminalId,
        amplifierActivityByTerminalId: input.amplifierActivityByTerminalId,
        paneRuntimeActivityByPaneId: input.paneRuntimeActivityByPaneId,
        freshAgentSessions: input.freshAgentSessions,
      })
      const busySessionKeys = busyKey ? [busyKey] : []

      if (sessionKeySet.size === 0 && busySessionKeys.length === 0) continue
      activityByPaneId.set(entry.paneId, {
        sessionKeys: Array.from(sessionKeySet),
        busySessionKeys,
      })
    }
  }

  return activityByPaneId
}

export function collectBusySessionKeys(input: PaneActivityMaps & {
  tabs: Tab[]
  paneLayouts: Record<string, PaneNode | undefined>
}): string[] {
  const busySessionKeys = new Set<string>()
  const maps: PaneActivityMaps = {
    codexActivityByTerminalId: input.codexActivityByTerminalId,
    opencodeActivityByTerminalId: input.opencodeActivityByTerminalId,
    claudeActivityByTerminalId: input.claudeActivityByTerminalId,
    amplifierActivityByTerminalId: input.amplifierActivityByTerminalId,
    paneRuntimeActivityByPaneId: input.paneRuntimeActivityByPaneId,
    freshAgentSessions: input.freshAgentSessions,
  }

  for (const tab of input.tabs) {
    const layout = input.paneLayouts[tab.id]
    if (!layout) {
      const syntheticContent = buildSyntheticTerminalContent(tab)
      if (!syntheticContent) continue

      const sessionKey = resolveBusyPaneSessionKey({
        ...maps,
        paneId: tab.id,
        content: syntheticContent,
        tabMode: tab.mode,
        tabSessionRef: tab.sessionRef,
        tabResumeSessionId: tab.resumeSessionId,
        isOnlyPane: true,
      })
      if (sessionKey) busySessionKeys.add(sessionKey)
      continue
    }

    const isOnlyPane = layout.type === 'leaf'
    for (const entry of collectPaneEntries(layout)) {
      const sessionKey = resolveBusyPaneSessionKey({
        ...maps,
        paneId: entry.paneId,
        content: entry.content,
        tabMode: tab.mode,
        tabSessionRef: tab.sessionRef,
        tabResumeSessionId: tab.resumeSessionId,
        isOnlyPane,
      })
      if (sessionKey) busySessionKeys.add(sessionKey)
    }
  }

  return Array.from(busySessionKeys).sort()
}
