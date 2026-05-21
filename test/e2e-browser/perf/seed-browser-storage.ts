import { PANES_SCHEMA_VERSION, TABS_SCHEMA_VERSION } from '@/store/persistedState'
import { PANES_STORAGE_KEY, TABS_STORAGE_KEY } from '@/store/storage-keys'
import { VISIBLE_FIRST_LONG_HISTORY_SESSION_ID } from './seed-server-home.js'

type StorageSeed = Record<string, string>

function buildTabsPayload(input: {
  activeTabId: string
  tabs: Array<{
    id: string
    title: string
    mode?: 'shell'
    createRequestId?: string
    createdAt?: number
  }>
}): string {
  return JSON.stringify({
    version: TABS_SCHEMA_VERSION,
    tabs: {
      activeTabId: input.activeTabId,
      tabs: input.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        createdAt: tab.createdAt ?? 1,
        createRequestId: tab.createRequestId ?? tab.id,
        status: 'creating',
        mode: tab.mode ?? 'shell',
        shell: 'system',
      })),
    },
  })
}

function buildPanesPayload(input: {
  layouts: Record<string, unknown>
  activePane: Record<string, string>
  paneTitles?: Record<string, Record<string, string>>
}): string {
  return JSON.stringify({
    version: PANES_SCHEMA_VERSION,
    layouts: input.layouts,
    activePane: input.activePane,
    paneTitles: input.paneTitles ?? {},
    paneTitleSetByUser: {},
  })
}

function baseSeed(tabsRaw: string, panesRaw: string): StorageSeed {
  return {
    freshell_version: '3',
    [TABS_STORAGE_KEY]: tabsRaw,
    [PANES_STORAGE_KEY]: panesRaw,
  }
}

export function buildAgentChatBrowserStorageSeed(): StorageSeed {
  const tabId = 'tab-fresh-agent'
  const paneId = 'pane-fresh-agent'

  return baseSeed(
    buildTabsPayload({
      activeTabId: tabId,
      tabs: [
        {
          id: tabId,
          title: 'Fresh Agent Audit',
          createRequestId: 'tab-fresh-agent',
        },
      ],
    }),
    buildPanesPayload({
      layouts: {
        [tabId]: {
          type: 'leaf',
          id: paneId,
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            sessionId: VISIBLE_FIRST_LONG_HISTORY_SESSION_ID,
            createRequestId: 'fresh-agent-audit-create',
            status: 'idle',
            resumeSessionId: VISIBLE_FIRST_LONG_HISTORY_SESSION_ID,
          },
        },
      },
      activePane: {
        [tabId]: paneId,
      },
      paneTitles: {
        [tabId]: {
          [paneId]: 'Fresh Agent Audit',
        },
      },
    }),
  )
}

export function buildTerminalBrowserStorageSeed(): StorageSeed {
  const tabId = 'tab-terminal-audit'
  const paneId = 'pane-terminal-audit'

  return baseSeed(
    buildTabsPayload({
      activeTabId: tabId,
      tabs: [
        {
          id: tabId,
          title: 'Terminal Audit',
          createRequestId: 'tab-terminal-audit',
        },
      ],
    }),
    buildPanesPayload({
      layouts: {
        [tabId]: {
          type: 'leaf',
          id: paneId,
          content: {
            kind: 'terminal',
            createRequestId: 'terminal-audit-create',
            status: 'creating',
            mode: 'shell',
            shell: 'system',
          },
        },
      },
      activePane: {
        [tabId]: paneId,
      },
      paneTitles: {
        [tabId]: {
          [paneId]: 'Terminal Audit',
        },
      },
    }),
  )
}

export function buildOffscreenTabBrowserStorageSeed(): StorageSeed {
  const terminalTabId = 'tab-terminal'
  const terminalPaneId = 'pane-terminal'
  const agentChatTabId = 'tab-heavy-fresh-agent'
  const agentChatPaneId = 'pane-heavy-fresh-agent'

  return baseSeed(
    buildTabsPayload({
      activeTabId: terminalTabId,
      tabs: [
        {
          id: terminalTabId,
          title: 'Terminal Audit',
          createRequestId: 'tab-terminal-audit',
        },
        {
          id: agentChatTabId,
          title: 'Background Fresh Agent',
          createRequestId: 'tab-heavy-fresh-agent',
        },
      ],
    }),
    buildPanesPayload({
      layouts: {
        [terminalTabId]: {
          type: 'leaf',
          id: terminalPaneId,
          content: {
            kind: 'terminal',
            createRequestId: 'terminal-audit-create',
            status: 'creating',
            mode: 'shell',
            shell: 'system',
          },
        },
        [agentChatTabId]: {
          type: 'leaf',
          id: agentChatPaneId,
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            sessionId: VISIBLE_FIRST_LONG_HISTORY_SESSION_ID,
            createRequestId: 'fresh-agent-heavy-create',
            status: 'idle',
            resumeSessionId: VISIBLE_FIRST_LONG_HISTORY_SESSION_ID,
          },
        },
      },
      activePane: {
        [terminalTabId]: terminalPaneId,
        [agentChatTabId]: agentChatPaneId,
      },
      paneTitles: {
        [terminalTabId]: {
          [terminalPaneId]: 'Terminal Audit',
        },
        [agentChatTabId]: {
          [agentChatPaneId]: 'Background Fresh Agent',
        },
      },
    }),
  )
}
