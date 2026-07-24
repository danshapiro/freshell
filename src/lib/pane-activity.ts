import { resolveExactCodexActivity } from '@/lib/codex-activity-resolver'
import { collectPaneEntries } from '@/lib/pane-utils'
import { resolveFreshAgentType } from '@/lib/fresh-agent-registry'
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

export function collectBusySessionKeys(input: {
  tabs: Tab[]
  paneLayouts: Record<string, PaneNode | undefined>
  codexActivityByTerminalId: Record<string, CodexActivityRecord>
  opencodeActivityByTerminalId: Record<string, OpencodeActivityRecord>
  claudeActivityByTerminalId: Record<string, ClaudeActivityRecord>
  amplifierActivityByTerminalId: Record<string, AmplifierActivityRecord>
  paneRuntimeActivityByPaneId: Record<string, PaneRuntimeActivityRecord>
  freshAgentSessions?: Record<string, FreshAgentSessionState>
}): string[] {
  const busySessionKeys = new Set<string>()

  for (const tab of input.tabs) {
    const layout = input.paneLayouts[tab.id]
    if (!layout) {
      const syntheticContent = buildSyntheticTerminalContent(tab)
      if (!syntheticContent) continue

      const busy = resolvePaneActivity({
        paneId: tab.id,
        content: syntheticContent,
        tabMode: tab.mode,
        isOnlyPane: true,
        codexActivityByTerminalId: input.codexActivityByTerminalId,
        opencodeActivityByTerminalId: input.opencodeActivityByTerminalId,
        claudeActivityByTerminalId: input.claudeActivityByTerminalId,
        amplifierActivityByTerminalId: input.amplifierActivityByTerminalId,
        paneRuntimeActivityByPaneId: input.paneRuntimeActivityByPaneId,
        freshAgentSessions: input.freshAgentSessions,
      }).isBusy
      if (!busy) continue

      const sessionKey = resolveTerminalSessionKey(syntheticContent, tab.sessionRef, tab.resumeSessionId, tab.mode)
      if (sessionKey) busySessionKeys.add(sessionKey)
      continue
    }

    const isOnlyPane = layout.type === 'leaf'
    for (const entry of collectPaneEntries(layout)) {
      const busy = resolvePaneActivity({
        paneId: entry.paneId,
        content: entry.content,
        tabMode: tab.mode,
        isOnlyPane,
        codexActivityByTerminalId: input.codexActivityByTerminalId,
        opencodeActivityByTerminalId: input.opencodeActivityByTerminalId,
        claudeActivityByTerminalId: input.claudeActivityByTerminalId,
        amplifierActivityByTerminalId: input.amplifierActivityByTerminalId,
        paneRuntimeActivityByPaneId: input.paneRuntimeActivityByPaneId,
        freshAgentSessions: input.freshAgentSessions,
      }).isBusy
      if (!busy) continue

      const sessionKey = entry.content.kind === 'fresh-agent'
        ? resolveFreshAgentSessionKey(
            entry.content,
            entry.content.sessionId
              ? input.freshAgentSessions?.[makeFreshAgentSessionKey({
                sessionType: entry.content.sessionType,
                provider: entry.content.provider,
                sessionId: entry.content.sessionId,
              })]
              : undefined,
          )
        : entry.content.kind === 'terminal'
          ? resolveTerminalSessionKey(entry.content, tab.sessionRef, tab.resumeSessionId, tab.mode)
          : undefined
      if (sessionKey) busySessionKeys.add(sessionKey)
    }
  }

  return Array.from(busySessionKeys).sort()
}
