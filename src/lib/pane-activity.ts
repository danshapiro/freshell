import { getAgentChatProviderConfig } from '@/lib/agent-chat-utils'
import { resolveExactCodexActivity } from '@/lib/codex-activity-resolver'
import { collectPaneEntries } from '@/lib/pane-utils'
import type { ChatSessionState } from '@/store/agentChatTypes'
import type {
  AgentChatPaneContent,
  PaneContent,
  PaneNode,
  TerminalPaneContent,
} from '@/store/paneTypes'
import type { PaneRuntimeActivityRecord } from '@/store/paneRuntimeActivitySlice'
import type { Tab } from '@/store/types'
import type { CodexActivityRecord } from '@shared/ws-protocol'

type PaneActivitySource = 'codex' | 'claude-terminal' | 'agent-chat' | 'browser'

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

function isClaudeTerminalBusy(record: PaneRuntimeActivityRecord | undefined): boolean {
  return record?.source === 'terminal' && record.phase === 'working'
}

function resolveAgentChatSessionKey(
  content: AgentChatPaneContent,
  session: ChatSessionState | undefined,
): string | undefined {
  const explicit = content.sessionRef
  if (explicit?.provider && explicit.sessionId) {
    return `${explicit.provider}:${explicit.sessionId}`
  }

  const provider = getAgentChatProviderConfig(content.provider)?.codingCliProvider
  const sessionId = session?.cliSessionId ?? content.resumeSessionId
  if (!provider || !sessionId) return undefined

  return `${provider}:${sessionId}`
}

function isAgentChatBusy(
  content: AgentChatPaneContent,
  session: ChatSessionState | undefined,
): boolean {
  const status = session?.status ?? content.status
  if (status === 'compacting') return true

  const hasWaitingItems = session != null && (
    Object.keys(session.pendingPermissions).length > 0
    || Object.keys(session.pendingQuestions).length > 0
  )
  if (hasWaitingItems) return false

  if (session?.streamingActive) return true
  return status === 'running'
}

function resolveTerminalSessionKey(
  content: TerminalPaneContent,
  fallbackSessionId?: string,
  fallbackMode?: Tab['mode'],
): string | undefined {
  const explicit = content.sessionRef
  if (explicit?.provider && explicit.sessionId) {
    return `${explicit.provider}:${explicit.sessionId}`
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
  paneRuntimeActivityByPaneId: Record<string, PaneRuntimeActivityRecord>
  agentChatSessions: Record<string, ChatSessionState>
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
      return record?.phase === 'busy'
        ? { isBusy: true, source: 'codex' }
        : IDLE_PANE_ACTIVITY
    }

    if (effectiveMode === 'claude' && isClaudeTerminalBusy(runtimeActivity)) {
      return { isBusy: true, source: 'claude-terminal' }
    }

    return IDLE_PANE_ACTIVITY
  }

  if (input.content.kind === 'browser') {
    return isBrowserBusy(runtimeActivity)
      ? { isBusy: true, source: 'browser' }
      : IDLE_PANE_ACTIVITY
  }

  if (input.content.kind === 'agent-chat') {
    const session = input.content.sessionId
      ? input.agentChatSessions[input.content.sessionId]
      : undefined
    return isAgentChatBusy(input.content, session)
      ? { isBusy: true, source: 'agent-chat' }
      : IDLE_PANE_ACTIVITY
  }

  return IDLE_PANE_ACTIVITY
}

export function getBusyPaneIdsForTab(input: {
  tab: Tab
  paneLayouts: Record<string, PaneNode | undefined>
  codexActivityByTerminalId: Record<string, CodexActivityRecord>
  paneRuntimeActivityByPaneId: Record<string, PaneRuntimeActivityRecord>
  agentChatSessions: Record<string, ChatSessionState>
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
      paneRuntimeActivityByPaneId: input.paneRuntimeActivityByPaneId,
      agentChatSessions: input.agentChatSessions,
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
      paneRuntimeActivityByPaneId: input.paneRuntimeActivityByPaneId,
      agentChatSessions: input.agentChatSessions,
    }).isBusy)
    .map((entry) => entry.paneId)
}

export function collectBusySessionKeys(input: {
  tabs: Tab[]
  paneLayouts: Record<string, PaneNode | undefined>
  codexActivityByTerminalId: Record<string, CodexActivityRecord>
  paneRuntimeActivityByPaneId: Record<string, PaneRuntimeActivityRecord>
  agentChatSessions: Record<string, ChatSessionState>
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
        paneRuntimeActivityByPaneId: input.paneRuntimeActivityByPaneId,
        agentChatSessions: input.agentChatSessions,
      }).isBusy
      if (!busy) continue

      const sessionKey = resolveTerminalSessionKey(syntheticContent, tab.resumeSessionId, tab.mode)
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
        paneRuntimeActivityByPaneId: input.paneRuntimeActivityByPaneId,
        agentChatSessions: input.agentChatSessions,
      }).isBusy
      if (!busy) continue

      const sessionKey = entry.content.kind === 'agent-chat'
        ? resolveAgentChatSessionKey(
          entry.content,
          entry.content.sessionId
            ? input.agentChatSessions[entry.content.sessionId]
            : undefined,
        )
        : entry.content.kind === 'terminal'
          ? resolveTerminalSessionKey(entry.content, tab.resumeSessionId, tab.mode)
          : undefined
      if (sessionKey) busySessionKeys.add(sessionKey)
    }
  }

  return Array.from(busySessionKeys).sort()
}
