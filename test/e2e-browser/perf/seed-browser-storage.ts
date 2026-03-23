import { PANES_STORAGE_KEY, TABS_STORAGE_KEY, WORKSPACE_STORAGE_KEY } from '@/store/storage-keys'
import { serializeWorkspaceSnapshot } from '@/store/workspacePersistence'
import { VISIBLE_FIRST_LONG_HISTORY_SESSION_ID } from './seed-server-home.js'

type StorageSeed = Record<string, string>

type SeedTab = {
  id: string
  title: string
  mode?: 'shell'
  createRequestId?: string
  createdAt?: number
}

function buildWorkspaceSeed(input: {
  activeTabId: string
  tabs: SeedTab[]
  layouts: Record<string, unknown>
  activePane: Record<string, string>
  paneTitles?: Record<string, Record<string, string>>
}) {
  const serialized = serializeWorkspaceSnapshot({
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
      renameRequestTabId: null,
    },
    panes: {
      layouts: input.layouts as any,
      activePane: input.activePane,
      paneTitles: input.paneTitles ?? {},
      paneTitleSetByUser: {},
      renameRequestTabId: null,
      renameRequestPaneId: null,
      zoomedPane: {},
      refreshRequestsByPane: {},
    },
  } as any)

  if (!serialized.ok) {
    throw new Error(`Invalid visible-first browser storage seed: ${serialized.missingLayoutTabIds.join(', ')}`)
  }

  return {
    freshell_version: '3',
    [WORKSPACE_STORAGE_KEY]: serialized.workspaceRaw,
    [TABS_STORAGE_KEY]: serialized.tabsRaw,
    [PANES_STORAGE_KEY]: serialized.panesRaw,
  }
}

export function buildAgentChatBrowserStorageSeed(): StorageSeed {
  const tabId = 'tab-agent-chat'
  const paneId = 'pane-agent-chat'

  return buildWorkspaceSeed({
    activeTabId: tabId,
    tabs: [
      {
        id: tabId,
        title: 'Agent Chat Audit',
        createRequestId: 'tab-agent-chat',
      },
    ],
    layouts: {
      [tabId]: {
        type: 'leaf',
        id: paneId,
        content: {
          kind: 'agent-chat',
          provider: 'freshclaude',
          sessionId: VISIBLE_FIRST_LONG_HISTORY_SESSION_ID,
          createRequestId: 'agent-chat-audit-create',
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
        [paneId]: 'Agent Chat Audit',
      },
    },
  })
}

export function buildTerminalBrowserStorageSeed(): StorageSeed {
  const tabId = 'tab-terminal-audit'
  const paneId = 'pane-terminal-audit'

  return buildWorkspaceSeed({
    activeTabId: tabId,
    tabs: [
      {
        id: tabId,
        title: 'Terminal Audit',
        createRequestId: 'tab-terminal-audit',
      },
    ],
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
  })
}

export function buildOffscreenTabBrowserStorageSeed(): StorageSeed {
  const terminalTabId = 'tab-terminal'
  const terminalPaneId = 'pane-terminal'
  const agentChatTabId = 'tab-heavy-agent-chat'
  const agentChatPaneId = 'pane-heavy-agent-chat'

  return buildWorkspaceSeed({
    activeTabId: terminalTabId,
    tabs: [
      {
        id: terminalTabId,
        title: 'Terminal Audit',
        createRequestId: 'tab-terminal-audit',
      },
      {
        id: agentChatTabId,
        title: 'Background Agent Chat',
        createRequestId: 'tab-heavy-agent-chat',
      },
    ],
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
          kind: 'agent-chat',
          provider: 'freshclaude',
          sessionId: VISIBLE_FIRST_LONG_HISTORY_SESSION_ID,
          createRequestId: 'agent-chat-heavy-create',
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
        [agentChatPaneId]: 'Background Agent Chat',
      },
    },
  })
}
