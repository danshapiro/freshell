import { describe, it, expect } from 'vitest'
import { getSessionsForHello, findTabIdForSession, findPaneForSession, collectSessionRefsFromNode, getActiveSessionRefForTab } from '@/lib/session-utils'
import type { RootState } from '@/store/store'
import type { PaneNode, TerminalPaneContent, AgentChatPaneContent, PaneContent } from '@/store/paneTypes'

const VALID_SESSION_ID = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_SESSION_ID = '6f1c2b3a-4d5e-6f70-8a9b-0c1d2e3f4a5b'

function terminalContent(mode: TerminalPaneContent['mode'], resumeSessionId: string): TerminalPaneContent {
  return {
    kind: 'terminal',
    mode,
    status: 'running',
    createRequestId: `req-${resumeSessionId}`,
    resumeSessionId,
  }
}

function agentChatContent(resumeSessionId?: string): AgentChatPaneContent {
  return {
    kind: 'agent-chat', provider: 'freshclaude',
    status: 'idle',
    createRequestId: `req-chat-${resumeSessionId}`,
    resumeSessionId,
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

  it('drops invalid claude session IDs', () => {
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

    expect(result.active).toBeUndefined()
    expect(result.visible).toEqual([])
    expect(result.background).toBeUndefined()
  })
})

describe('findTabIdForSession', () => {
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

    expect(findTabIdForSession(state, 'claude', VALID_SESSION_ID)).toBe('tab-1')
  })
})

describe('findPaneForSession', () => {
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

    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toEqual({
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

    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toEqual({
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

    expect(findPaneForSession(state, 'codex', OTHER_SESSION_ID)).toEqual({
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

    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toBeUndefined()
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

    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toBeUndefined()
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
    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toEqual({
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

    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toEqual({
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

    expect(findPaneForSession(state, 'claude', VALID_SESSION_ID)).toEqual({
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

    expect(findTabIdForSession(state, 'claude', VALID_SESSION_ID)).toBe('tab-1')
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
