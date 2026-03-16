import { describe, it, expect } from 'vitest'
import {
  getSessionsForHello,
  findTabIdForSession,
  findPaneForSession,
  collectSessionLocatorsFromTabs,
  collectSessionRefsFromNode,
  collectSessionRefsFromTabs,
  getActiveSessionRefForTab,
} from '@/lib/session-utils'
import type { RootState } from '@/store/store'
import type {
  PaneNode,
  TerminalPaneContent,
  AgentChatPaneContent,
  PaneContent,
  SessionLocator,
} from '@/store/paneTypes'

const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_SESSION_ID = '6f1c2b3a-4d5e-6f70-8a9b-0c1d2e3f4a5b'

function terminalContent(
  mode: TerminalPaneContent['mode'],
  resumeSessionId: string,
  sessionRef?: SessionLocator
): TerminalPaneContent {
  return {
    kind: 'terminal',
    mode,
    status: 'running',
    createRequestId: `req-${resumeSessionId}`,
    resumeSessionId,
    ...(sessionRef ? { sessionRef } : {}),
  }
}

function agentChatContent(
  resumeSessionId?: string,
  sessionRef?: SessionLocator
): AgentChatPaneContent {
  return {
    kind: 'agent-chat', provider: 'freshclaude',
    status: 'idle',
    createRequestId: `req-chat-${resumeSessionId}`,
    resumeSessionId,
    ...(sessionRef ? { sessionRef } : {}),
  }
}

function leaf(id: string, content: PaneContent): PaneNode {
  return {
    type: 'leaf',
    id,
    content,
  }
}

describe('getSessionsForHello', () => {
  it('filters non-claude sessions from active/visible/background', () => {
    const layoutActive: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        leaf('pane-codex', terminalContent('codex', 'codex-active')),
        leaf('pane-claude', terminalContent('claude', VALID_SESSION_ID)),
      ],
    }

    const layoutBackground: PaneNode = {
      type: 'split',
      id: 'split-2',
      direction: 'vertical',
      sizes: [50, 50],
      children: [
        leaf('pane-claude-bg', terminalContent('claude', OTHER_SESSION_ID)),
        leaf('pane-codex-bg', terminalContent('codex', 'codex-bg')),
      ],
    }

    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }, { id: 'tab-2' }],
      },
      panes: {
        layouts: {
          'tab-1': layoutActive,
          'tab-2': layoutBackground,
        },
        activePane: {
          'tab-1': 'pane-codex',
        },
      },
    } as unknown as RootState

    const result = getSessionsForHello(state)

    expect(result.active).toBeUndefined()
    expect(result.visible).toEqual([VALID_SESSION_ID])
    expect(result.background).toEqual([OTHER_SESSION_ID])
  })

  it('captures active claude session when active pane is claude', () => {
    const layoutActive: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        leaf('pane-claude', terminalContent('claude', VALID_SESSION_ID)),
        leaf('pane-codex', terminalContent('codex', 'codex-visible')),
      ],
    }

    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': layoutActive,
        },
        activePane: {
          'tab-1': 'pane-claude',
        },
      },
    } as unknown as RootState

    const result = getSessionsForHello(state)

    expect(result.active).toBe(VALID_SESSION_ID)
    expect(result.visible).toEqual([])
    expect(result.background).toBeUndefined()
  })

  it('includes non-UUID Claude session IDs in hello (named resume)', () => {
    const layoutActive: PaneNode = {
      type: 'leaf',
      id: 'pane-claude',
      content: terminalContent('claude', 'not-a-uuid'),
    }

    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': layoutActive,
        },
        activePane: {
          'tab-1': 'pane-claude',
        },
      },
    } as unknown as RootState

    const result = getSessionsForHello(state)

    // Non-UUID Claude session IDs are now valid (named resume support)
    expect(result.active).toBe('not-a-uuid')
    expect(result.visible).toEqual([])
    expect(result.background).toBeUndefined()
  })
})

describe('collectSessionLocatorsFromTabs', () => {
  it('preserves exact local and foreign locators, intrinsic local fallbacks, and tab-level fallbacks', () => {
    const tabs = [
      { id: 'tab-local' },
      { id: 'tab-local-duplicate' },
      { id: 'tab-remote' },
      { id: 'tab-chat' },
      { id: 'tab-no-layout', mode: 'codex', resumeSessionId: 'tab-only' },
      { id: 'tab-invalid-claude' },
    ] as RootState['tabs']['tabs']

    const panes = {
      layouts: {
        'tab-local': leaf('pane-local', terminalContent('codex', 'shared', {
          provider: 'codex',
          sessionId: 'shared',
          serverInstanceId: 'srv-local',
        })),
        'tab-local-duplicate': leaf('pane-local-duplicate', terminalContent('codex', 'shared', {
          provider: 'codex',
          sessionId: 'shared',
          serverInstanceId: 'srv-local',
        })),
        'tab-remote': leaf('pane-remote', {
          kind: 'terminal',
          mode: 'codex',
          status: 'running',
          createRequestId: 'req-remote',
          sessionRef: {
            provider: 'codex',
            sessionId: 'shared',
            serverInstanceId: 'srv-remote',
          },
        }),
        'tab-chat': leaf('pane-chat', agentChatContent(VALID_SESSION_ID, {
          provider: 'claude',
          sessionId: VALID_SESSION_ID,
          serverInstanceId: 'srv-local',
        })),
        'tab-invalid-claude': leaf('pane-invalid-claude', terminalContent('claude', 'not-a-uuid')),
      },
      activePane: {},
    } as RootState['panes']

    expect(collectSessionLocatorsFromTabs(tabs, panes)).toEqual([
      { provider: 'codex', sessionId: 'shared', serverInstanceId: 'srv-local' },
      { provider: 'codex', sessionId: 'shared' },
      { provider: 'codex', sessionId: 'shared', serverInstanceId: 'srv-remote' },
      { provider: 'claude', sessionId: VALID_SESSION_ID, serverInstanceId: 'srv-local' },
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      { provider: 'codex', sessionId: 'tab-only' },
      { provider: 'claude', sessionId: 'not-a-uuid' },
    ])

    expect(collectSessionRefsFromTabs(tabs, panes)).toEqual([
      { provider: 'codex', sessionId: 'shared' },
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      { provider: 'codex', sessionId: 'tab-only' },
      { provider: 'claude', sessionId: 'not-a-uuid' },
    ])
  })

  it('drops invalid providers and empty locator fields from persisted pane and tab state', () => {
    const tabs = [
      { id: 'tab-invalid-explicit' },
      { id: 'tab-empty-server' },
      // 'shell' is not a valid session provider (only non-shell modes are valid)
      { id: 'tab-invalid-provider-fallback', mode: 'codex', codingCliProvider: 'shell', resumeSessionId: 'bad-provider' },
      { id: 'tab-empty-session-fallback', mode: 'codex', resumeSessionId: '' },
      { id: 'tab-valid-fallback', mode: 'codex', resumeSessionId: 'tab-valid' },
    ] as unknown as RootState['tabs']['tabs']

    const panes = {
      layouts: {
        'tab-invalid-explicit': leaf('pane-invalid-explicit', terminalContent('codex', 'resume-valid', {
          provider: 'shell',
          sessionId: '',
          serverInstanceId: '',
        } as unknown as SessionLocator)),
        'tab-empty-server': leaf('pane-empty-server', {
          kind: 'terminal',
          mode: 'codex',
          status: 'running',
          createRequestId: 'req-empty-server',
          sessionRef: {
            provider: 'codex',
            sessionId: 'explicit-valid',
            serverInstanceId: '',
          } as unknown as SessionLocator,
        }),
      },
      activePane: {},
    } as RootState['panes']

    expect(collectSessionLocatorsFromTabs(tabs, panes)).toEqual([
      { provider: 'codex', sessionId: 'resume-valid' },
      { provider: 'codex', sessionId: 'explicit-valid' },
      { provider: 'codex', sessionId: 'tab-valid' },
    ])

    expect(collectSessionRefsFromTabs(tabs, panes)).toEqual([
      { provider: 'codex', sessionId: 'resume-valid' },
      { provider: 'codex', sessionId: 'explicit-valid' },
      { provider: 'codex', sessionId: 'tab-valid' },
    ])
  })
})

describe('findTabIdForSession', () => {
  it('prefers a local match over a foreign copied tab for local session targets', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-remote',
        tabs: [{ id: 'tab-remote' }, { id: 'tab-local' }],
      },
      panes: {
        layouts: {
          'tab-remote': leaf('pane-remote', {
            kind: 'terminal',
            mode: 'codex',
            status: 'running',
            createRequestId: 'req-remote',
            sessionRef: {
              provider: 'codex',
              sessionId: 'shared',
              serverInstanceId: 'srv-remote',
            },
          }),
          'tab-local': leaf('pane-local', terminalContent('codex', 'shared', {
            provider: 'codex',
            sessionId: 'shared',
            serverInstanceId: 'srv-local',
          })),
        },
        activePane: {},
      },
    } as unknown as RootState

    expect(findTabIdForSession(
      state,
      { provider: 'codex', sessionId: 'shared' },
      'srv-local'
    )).toBe('tab-local')
  })

  it('ignores a foreign copied tab when it is the only match for a local target', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-remote',
        tabs: [{ id: 'tab-remote' }],
      },
      panes: {
        layouts: {
          'tab-remote': leaf('pane-remote', {
            kind: 'terminal',
            mode: 'codex',
            status: 'running',
            createRequestId: 'req-remote',
            sessionRef: {
              provider: 'codex',
              sessionId: 'shared',
              serverInstanceId: 'srv-remote',
            },
          }),
        },
        activePane: {},
      },
    } as unknown as RootState

    expect(findTabIdForSession(
      state,
      { provider: 'codex', sessionId: 'shared' },
      'srv-local'
    )).toBeUndefined()
  })

  it('still finds layout-backed local sessions before websocket ready via the intrinsic fallback locator', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-remote',
        tabs: [{ id: 'tab-remote' }, { id: 'tab-local' }],
      },
      panes: {
        layouts: {
          'tab-remote': leaf('pane-remote', {
            kind: 'terminal',
            mode: 'codex',
            status: 'running',
            createRequestId: 'req-remote',
            sessionRef: {
              provider: 'codex',
              sessionId: 'shared',
              serverInstanceId: 'srv-remote',
            },
          }),
          'tab-local': leaf('pane-local', terminalContent('codex', 'shared', {
            provider: 'codex',
            sessionId: 'shared',
            serverInstanceId: 'srv-local',
          })),
        },
        activePane: {},
      },
    } as unknown as RootState

    expect(findTabIdForSession(
      state,
      { provider: 'codex', sessionId: 'shared' },
      undefined
    )).toBe('tab-local')
  })

  it('still finds tab-level local fallbacks before websocket ready', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-remote',
        tabs: [
          { id: 'tab-remote' },
          { id: 'tab-local-fallback', mode: 'codex', resumeSessionId: 'shared' },
        ],
      },
      panes: {
        layouts: {
          'tab-remote': leaf('pane-remote', {
            kind: 'terminal',
            mode: 'codex',
            status: 'running',
            createRequestId: 'req-remote',
            sessionRef: {
              provider: 'codex',
              sessionId: 'shared',
              serverInstanceId: 'srv-remote',
            },
          }),
        },
        activePane: {},
      },
    } as unknown as RootState

    expect(findTabIdForSession(
      state,
      { provider: 'codex', sessionId: 'shared' },
      undefined
    )).toBe('tab-local-fallback')
  })

  it('falls back to tab resumeSessionId when layout is missing', () => {
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

    expect(findTabIdForSession(
      state,
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      undefined
    )).toBe('tab-1')
  })
})

describe('findPaneForSession', () => {
  it('can still resolve an explicit foreign target when that is what the caller asked for', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-local',
        tabs: [{ id: 'tab-local' }, { id: 'tab-remote' }],
      },
      panes: {
        layouts: {
          'tab-local': leaf('pane-local', terminalContent('codex', 'shared', {
            provider: 'codex',
            sessionId: 'shared',
            serverInstanceId: 'srv-local',
          })),
          'tab-remote': leaf('pane-remote', {
            kind: 'terminal',
            mode: 'codex',
            status: 'running',
            createRequestId: 'req-remote',
            sessionRef: {
              provider: 'codex',
              sessionId: 'shared',
              serverInstanceId: 'srv-remote',
            },
          }),
        },
        activePane: {},
      },
    } as unknown as RootState

    expect(findPaneForSession(
      state,
      { provider: 'codex', sessionId: 'shared', serverInstanceId: 'srv-remote' },
      'srv-local',
    )).toEqual({
      tabId: 'tab-remote',
      paneId: 'pane-remote',
    })
  })

  it('returns tabId and paneId when session is in a leaf', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-a', terminalContent('claude', VALID_SESSION_ID)),
        },
        activePane: { 'tab-1': 'pane-a' },
      },
    } as unknown as RootState

    expect(findPaneForSession(
      state,
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      undefined
    )).toEqual({
      tabId: 'tab-1',
      paneId: 'pane-a',
    })
  })

  it('finds session in a nested split', () => {
    const layout: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        leaf('pane-a', terminalContent('shell' as TerminalPaneContent['mode'], '')),
        leaf('pane-b', terminalContent('claude', VALID_SESSION_ID)),
      ],
    }

    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-a' },
      },
    } as unknown as RootState

    expect(findPaneForSession(
      state,
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      undefined
    )).toEqual({
      tabId: 'tab-1',
      paneId: 'pane-b',
    })
  })

  it('finds session in a background tab', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }, { id: 'tab-2' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-a', terminalContent('shell' as TerminalPaneContent['mode'], '')),
          'tab-2': leaf('pane-b', terminalContent('codex', OTHER_SESSION_ID)),
        },
        activePane: { 'tab-1': 'pane-a', 'tab-2': 'pane-b' },
      },
    } as unknown as RootState

    expect(findPaneForSession(
      state,
      { provider: 'codex', sessionId: OTHER_SESSION_ID },
      undefined
    )).toEqual({
      tabId: 'tab-2',
      paneId: 'pane-b',
    })
  })

  it('returns undefined when session is not open', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-a', terminalContent('shell' as TerminalPaneContent['mode'], '')),
        },
        activePane: { 'tab-1': 'pane-a' },
      },
    } as unknown as RootState

    expect(findPaneForSession(
      state,
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      undefined
    )).toBeUndefined()
  })

  it('returns undefined for tabs without layouts', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {},
        activePane: {},
      },
    } as unknown as RootState

    expect(findPaneForSession(
      state,
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      undefined
    )).toBeUndefined()
  })

  it('falls back to tab-level match when tab has resumeSessionId but no layout', () => {
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

    // Returns tabId but no paneId since there's no pane tree yet
    expect(findPaneForSession(
      state,
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      undefined
    )).toEqual({
      tabId: 'tab-1',
      paneId: undefined,
    })
  })
})

// === agent-chat pane support ===

describe('collectSessionRefsFromNode — agent-chat panes', () => {
  it('prefers explicit sessionRef over legacy resumeSessionId', () => {
    const node = leaf('p1', {
      kind: 'terminal',
      mode: 'shell',
      status: 'running',
      createRequestId: 'req-explicit',
      resumeSessionId: 'legacy-shell-resume',
      sessionRef: {
        provider: 'codex',
        sessionId: 'codex-explicit-session',
      },
    })
    expect(collectSessionRefsFromNode(node)).toEqual([
      { provider: 'codex', sessionId: 'codex-explicit-session' },
    ])
  })

  it('extracts session ref from an agent-chat pane', () => {
    const node = leaf('p1', agentChatContent(VALID_SESSION_ID))
    expect(collectSessionRefsFromNode(node)).toEqual([
      { provider: 'claude', sessionId: VALID_SESSION_ID },
    ])
  })

  it('returns empty for an agent-chat pane without resumeSessionId', () => {
    const node = leaf('p1', agentChatContent(undefined))
    expect(collectSessionRefsFromNode(node)).toEqual([])
  })

  it('returns empty for an agent-chat pane with invalid session ID', () => {
    const node = leaf('p1', agentChatContent('not-a-uuid'))
    expect(collectSessionRefsFromNode(node)).toEqual([])
  })

  it('returns session ref for a Claude terminal pane with non-UUID resume name', () => {
    const node = leaf('p1', terminalContent('claude', '137 tour'))
    expect(collectSessionRefsFromNode(node)).toEqual([
      { provider: 'claude', sessionId: '137 tour' },
    ])
  })

  it('does not include agent-chat panes with non-UUID session IDs in session refs (invariant)', () => {
    const node = leaf('p1', agentChatContent('not-a-uuid'))
    expect(collectSessionRefsFromNode(node)).toEqual([])
  })

  it('collects from split with terminal and agent-chat children', () => {
    const node: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        leaf('p1', terminalContent('claude', VALID_SESSION_ID)),
        leaf('p2', agentChatContent(OTHER_SESSION_ID)),
      ],
    }
    expect(collectSessionRefsFromNode(node)).toEqual([
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      { provider: 'claude', sessionId: OTHER_SESSION_ID },
    ])
  })
})

describe('findPaneForSession — agent-chat panes', () => {
  it('finds an agent-chat pane by session ID', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-chat', agentChatContent(VALID_SESSION_ID)),
        },
        activePane: { 'tab-1': 'pane-chat' },
      },
    } as unknown as RootState

    expect(findPaneForSession(
      state,
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      undefined
    )).toEqual({
      tabId: 'tab-1',
      paneId: 'pane-chat',
    })
  })

  it('finds agent-chat pane in a split alongside a terminal pane', () => {
    const layout: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        leaf('pane-term', terminalContent('shell' as TerminalPaneContent['mode'], '')),
        leaf('pane-chat', agentChatContent(VALID_SESSION_ID)),
      ],
    }

    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-term' },
      },
    } as unknown as RootState

    expect(findPaneForSession(
      state,
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      undefined
    )).toEqual({
      tabId: 'tab-1',
      paneId: 'pane-chat',
    })
  })
})

describe('findTabIdForSession — agent-chat panes', () => {
  it('finds tab containing an agent-chat pane with matching session', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-chat', agentChatContent(VALID_SESSION_ID)),
        },
        activePane: {},
      },
    } as unknown as RootState

    expect(findTabIdForSession(
      state,
      { provider: 'claude', sessionId: VALID_SESSION_ID },
      undefined
    )).toBe('tab-1')
  })
})

describe('getActiveSessionRefForTab — agent-chat panes', () => {
  it('returns session ref when active pane is an agent-chat pane', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-chat', agentChatContent(VALID_SESSION_ID)),
        },
        activePane: { 'tab-1': 'pane-chat' },
      },
    } as unknown as RootState

    expect(getActiveSessionRefForTab(state, 'tab-1')).toEqual({
      provider: 'claude',
      sessionId: VALID_SESSION_ID,
    })
  })
})

describe('getSessionsForHello — agent-chat panes', () => {
  it('includes agent-chat pane session as active', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-chat', agentChatContent(VALID_SESSION_ID)),
        },
        activePane: { 'tab-1': 'pane-chat' },
      },
    } as unknown as RootState

    const result = getSessionsForHello(state)
    expect(result.active).toBe(VALID_SESSION_ID)
  })

  it('includes agent-chat session as visible when not active pane', () => {
    const layout: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        leaf('pane-term', terminalContent('claude', VALID_SESSION_ID)),
        leaf('pane-chat', agentChatContent(OTHER_SESSION_ID)),
      ],
    }

    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: { 'tab-1': layout },
        activePane: { 'tab-1': 'pane-term' },
      },
    } as unknown as RootState

    const result = getSessionsForHello(state)
    expect(result.active).toBe(VALID_SESSION_ID)
    expect(result.visible).toEqual([OTHER_SESSION_ID])
  })

  it('includes agent-chat session in background tabs', () => {
    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }, { id: 'tab-2' }],
      },
      panes: {
        layouts: {
          'tab-1': leaf('pane-term', terminalContent('claude', VALID_SESSION_ID)),
          'tab-2': leaf('pane-chat', agentChatContent(OTHER_SESSION_ID)),
        },
        activePane: { 'tab-1': 'pane-term' },
      },
    } as unknown as RootState

    const result = getSessionsForHello(state)
    expect(result.background).toEqual([OTHER_SESSION_ID])
  })
})
