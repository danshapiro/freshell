import { describe, expect, it } from 'vitest'
import {
  collectSessionLocatorsFromTabs,
  collectSessionRefsFromNode,
  collectSessionRefsFromTabs,
  findPaneForSession,
  findTabIdForSession,
  getActiveSessionRefForTab,
  getSessionsForHello,
} from '@/lib/session-utils'
import type {
  AgentChatPaneContent,
  PaneContent,
  PaneNode,
  SessionLocator,
  TerminalPaneContent,
} from '@/store/paneTypes'
import type { RootState } from '@/store/store'

const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_SESSION_ID = '6f1c2b3a-4d5e-6f70-8a9b-0c1d2e3f4a5b'

function terminalContent(
  mode: TerminalPaneContent['mode'],
  options: {
    resumeSessionId?: string
    sessionRef?: SessionLocator
    serverInstanceId?: string
    terminalId?: string
  } = {},
): TerminalPaneContent {
  const identity = options.sessionRef?.sessionId ?? options.resumeSessionId ?? 'fresh'
  return {
    kind: 'terminal',
    mode,
    status: 'running',
    createRequestId: `req-${identity}`,
    ...(options.terminalId ? { terminalId: options.terminalId } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    ...(options.sessionRef ? { sessionRef: options.sessionRef } : {}),
    ...(options.serverInstanceId ? { serverInstanceId: options.serverInstanceId } : {}),
  }
}

function agentChatContent(
  options: {
    resumeSessionId?: string
    sessionRef?: SessionLocator
  } = {},
): AgentChatPaneContent {
  const identity = options.sessionRef?.sessionId ?? options.resumeSessionId ?? 'fresh'
  return {
    kind: 'agent-chat',
    provider: 'freshclaude',
    status: 'idle',
    createRequestId: `req-chat-${identity}`,
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    ...(options.sessionRef ? { sessionRef: options.sessionRef } : {}),
  }
}

function leaf(id: string, content: PaneContent): PaneNode {
  return { type: 'leaf', id, content }
}

describe('getSessionsForHello', () => {
  it('reports only canonical Claude identities from active, visible, and background tabs', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }, { id: 'tab-2' }],
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              leaf('pane-claude-active', terminalContent('claude', { resumeSessionId: VALID_SESSION_ID })),
              leaf('pane-codex-visible', terminalContent('codex', {
                sessionRef: { provider: 'codex', sessionId: 'codex-session-1' },
              })),
            ],
          },
          'tab-2': leaf('pane-claude-background', agentChatContent({ resumeSessionId: OTHER_SESSION_ID })),
        },
        activePane: {
          'tab-1': 'pane-claude-active',
        },
      },
    } as unknown as RootState

    expect(getSessionsForHello(state)).toEqual({
      active: VALID_SESSION_ID,
      visible: [],
      background: [OTHER_SESSION_ID],
    })
  })

  it('ignores non-canonical Claude resume strings when building hello session state', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-claude', terminalContent('claude', { resumeSessionId: 'named-resume' })),
        },
        activePane: {
          'tab-1': 'pane-claude',
        },
      },
    } as unknown as RootState

    expect(getSessionsForHello(state)).toEqual({
      visible: [],
    })
  })
})

describe('collectSessionLocatorsFromTabs', () => {
  it('keeps canonical sessionRef values and UUID-backed Claude fallbacks, dropping locality and invalid legacy values', () => {
    const tabs = [
      { id: 'tab-explicit' },
      { id: 'tab-claude-fallback', mode: 'claude', resumeSessionId: VALID_SESSION_ID },
      { id: 'tab-invalid-claude' },
      { id: 'tab-invalid-codex', mode: 'codex', resumeSessionId: 'codex-session-legacy' },
    ] as RootState['tabs']['tabs']

    const panes = {
      layouts: {
        'tab-explicit': leaf('pane-explicit', terminalContent('codex', {
          sessionRef: {
            provider: 'codex',
            sessionId: 'codex-session-1',
          },
          serverInstanceId: 'srv-local',
        })),
        'tab-invalid-claude': leaf('pane-invalid-claude', terminalContent('claude', { resumeSessionId: 'named-resume' })),
      },
      activePane: {},
    } as RootState['panes']

    expect(collectSessionLocatorsFromTabs(tabs, panes)).toEqual([
      { provider: 'codex', sessionId: 'codex-session-1' },
      { provider: 'claude', sessionId: VALID_SESSION_ID },
    ])

    expect(collectSessionRefsFromTabs(tabs, panes)).toEqual([
      { provider: 'codex', sessionId: 'codex-session-1' },
      { provider: 'claude', sessionId: VALID_SESSION_ID },
    ])
  })
})

describe('collectSessionRefsFromNode', () => {
  it('prefers explicit sessionRef over legacy terminal resumeSessionId', () => {
    const node = leaf('pane-1', terminalContent('shell', {
      resumeSessionId: 'legacy-shell-resume',
      sessionRef: {
        provider: 'codex',
        sessionId: 'codex-explicit-session',
      },
    }))

    expect(collectSessionRefsFromNode(node)).toEqual([
      { provider: 'codex', sessionId: 'codex-explicit-session' },
    ])
  })

  it('returns empty for agent-chat panes with non-canonical Claude resume strings', () => {
    const node = leaf('pane-chat', agentChatContent({ resumeSessionId: 'named-resume' }))
    expect(collectSessionRefsFromNode(node)).toEqual([])
  })
})

describe('getActiveSessionRefForTab', () => {
  it('returns the active pane canonical session ref', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              leaf('pane-shell', terminalContent('shell')),
              leaf('pane-codex', terminalContent('codex', {
                sessionRef: { provider: 'codex', sessionId: 'codex-active' },
              })),
            ],
          },
        },
        activePane: { 'tab-1': 'pane-codex' },
      },
    } as unknown as RootState

    expect(getActiveSessionRefForTab(state, 'tab-1')).toEqual({
      provider: 'codex',
      sessionId: 'codex-active',
    })
  })
})

describe('findTabIdForSession', () => {
  it('matches explicit canonical sessionRef values without relying on locality', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-remote',
        tabs: [{ id: 'tab-remote' }, { id: 'tab-local' }],
      },
      panes: {
        layouts: {
          'tab-remote': leaf('pane-remote', terminalContent('codex', {
            sessionRef: { provider: 'codex', sessionId: 'shared' },
          })),
          'tab-local': leaf('pane-local', terminalContent('codex', {
            sessionRef: { provider: 'codex', sessionId: 'shared' },
          })),
        },
        activePane: {},
      },
    } as unknown as RootState

    expect(findTabIdForSession(state, { provider: 'codex', sessionId: 'shared' }, 'srv-local')).toBe('tab-remote')
  })

  it('prefers a same-server explicit sessionRef over an explicitly foreign copy', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-remote',
        tabs: [{ id: 'tab-remote' }, { id: 'tab-local' }],
      },
      panes: {
        layouts: {
          'tab-remote': leaf('pane-remote', terminalContent('codex', {
            sessionRef: {
              provider: 'codex',
              sessionId: 'shared',
            },
            serverInstanceId: 'srv-remote',
          })),
          'tab-local': leaf('pane-local', terminalContent('codex', {
            sessionRef: {
              provider: 'codex',
              sessionId: 'shared',
            },
            serverInstanceId: 'srv-local',
            terminalId: 'term-local',
          })),
        },
        activePane: {},
      },
    } as unknown as RootState

    expect(findTabIdForSession(state, { provider: 'codex', sessionId: 'shared' }, 'srv-local')).toBe('tab-local')
  })

  it('falls back to tab-level canonical Claude resume ids when no layout exists', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', mode: 'claude', resumeSessionId: VALID_SESSION_ID }],
      },
      panes: {
        layouts: {},
        activePane: {},
      },
    } as unknown as RootState

    expect(findTabIdForSession(state, { provider: 'claude', sessionId: VALID_SESSION_ID })).toBe('tab-1')
  })

  it('does not match named Claude resumes without canonical sessionRef', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', mode: 'claude', resumeSessionId: 'named-resume' }],
      },
      panes: {
        layouts: {},
        activePane: {},
      },
    } as unknown as RootState

    expect(findTabIdForSession(state, { provider: 'claude', sessionId: 'named-resume' })).toBeUndefined()
  })
})

describe('findPaneForSession', () => {
  it('finds a pane by explicit canonical sessionRef', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-codex', terminalContent('codex', {
            sessionRef: { provider: 'codex', sessionId: 'codex-pane' },
          })),
        },
        activePane: { 'tab-1': 'pane-codex' },
      },
    } as unknown as RootState

    expect(findPaneForSession(state, { provider: 'codex', sessionId: 'codex-pane' })).toEqual({
      tabId: 'tab-1',
      paneId: 'pane-codex',
    })
  })

  it('does not match an explicitly foreign copied pane when a local server instance is known', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-codex', terminalContent('codex', {
            sessionRef: {
              provider: 'codex',
              sessionId: 'codex-pane',
            },
            serverInstanceId: 'srv-remote',
          })),
        },
        activePane: { 'tab-1': 'pane-codex' },
      },
    } as unknown as RootState

    expect(findPaneForSession(
      state,
      { provider: 'codex', sessionId: 'codex-pane' },
      'srv-local',
    )).toBeUndefined()
  })

  it('finds an agent-chat pane by canonical Claude resume id', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-chat', agentChatContent({ resumeSessionId: VALID_SESSION_ID })),
        },
        activePane: { 'tab-1': 'pane-chat' },
      },
    } as unknown as RootState

    expect(findPaneForSession(state, { provider: 'claude', sessionId: VALID_SESSION_ID })).toEqual({
      tabId: 'tab-1',
      paneId: 'pane-chat',
    })
  })

  it('returns a tab-level fallback only for canonical Claude ids', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', mode: 'claude', resumeSessionId: VALID_SESSION_ID }],
      },
      panes: {
        layouts: {},
        activePane: {},
      },
    } as unknown as RootState

    expect(findPaneForSession(state, { provider: 'claude', sessionId: VALID_SESSION_ID })).toEqual({
      tabId: 'tab-1',
      paneId: undefined,
    })
  })
})
