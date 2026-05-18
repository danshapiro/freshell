import { describe, expect, it } from 'vitest'
import { buildTabFallbackIdentityUpdates, sanitizeTabsAgainstLayouts } from '@/lib/tab-fallback-identity'
import type { PaneNode } from '@/store/paneTypes'
import type { Tab } from '@/store/types'

const VALID_CLAUDE_SESSION_ID = '00000000-0000-4000-8000-000000000444'
const CODEX_THREAD_ID = 'codex-thread-123'

function makeLeaf(content: PaneNode['content']): Extract<PaneNode, { type: 'leaf' }> {
  return { type: 'leaf', id: 'pane-1', content }
}

describe('buildTabFallbackIdentityUpdates', () => {
  it('derives sessionRef from fresh-agent.sessionRef for a single-pane tab', () => {
    const result = buildTabFallbackIdentityUpdates({
      tab: { id: 't1', mode: 'shell', sessionRef: undefined, resumeSessionId: undefined },
      layout: makeLeaf({
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-1',
        status: 'connected',
        sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
      }),
    })
    expect(result).toBeDefined()
    expect(result!.sessionRef).toEqual({ provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID })
  })

  it('derives sessionRef from fresh-agent with canonical Claude resumeSessionId', () => {
    const result = buildTabFallbackIdentityUpdates({
      tab: { id: 't1', mode: 'shell', sessionRef: undefined, resumeSessionId: undefined },
      layout: makeLeaf({
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-1',
        status: 'connected',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      }),
    })
    expect(result).toBeDefined()
    expect(result!.resumeSessionId).toBeUndefined()
    expect(result!.sessionRef).toMatchObject({ provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID })
  })

  it('returns undefined for fresh-agent with non-canonical named resume alias', () => {
    const result = buildTabFallbackIdentityUpdates({
      tab: { id: 't1', mode: 'shell', sessionRef: undefined, resumeSessionId: undefined },
      layout: makeLeaf({
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-1',
        status: 'connected',
        resumeSessionId: 'named-resume',
      }),
    })
    expect(result?.sessionRef).toBeUndefined()
  })

  it('derives sessionRef from Codex fresh-agent with Codex sessionRef', () => {
    const result = buildTabFallbackIdentityUpdates({
      tab: { id: 't1', mode: 'shell', sessionRef: undefined, resumeSessionId: undefined },
      layout: makeLeaf({
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-1',
        status: 'connected',
        sessionRef: { provider: 'codex', sessionId: CODEX_THREAD_ID },
      }),
    })
    expect(result).toBeDefined()
    expect(result!.sessionRef).toEqual({ provider: 'codex', sessionId: CODEX_THREAD_ID })
  })

  it('clears stale resumeSessionId from the tab', () => {
    const result = buildTabFallbackIdentityUpdates({
      tab: { id: 't1', mode: 'shell', sessionRef: undefined, resumeSessionId: 'stale-resume-alias' },
      layout: makeLeaf({
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-1',
        status: 'connected',
        sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
      }),
    })
    expect(result).toBeDefined()
    expect(result!.resumeSessionId).toBeUndefined()
    expect(result!.sessionRef).toEqual({ provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID })
  })

  it('returns undefined when tab already has the correct sessionRef', () => {
    const result = buildTabFallbackIdentityUpdates({
      tab: { id: 't1', mode: 'shell', sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID }, resumeSessionId: undefined },
      layout: makeLeaf({
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-1',
        status: 'connected',
        sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
      }),
    })
    expect(result).toBeUndefined()
  })

  it('returns undefined for a split layout without recursive leaf analysis', () => {
    const result = buildTabFallbackIdentityUpdates({
      tab: { id: 't1', mode: 'shell', sessionRef: undefined, resumeSessionId: undefined },
      layout: {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [0.5, 0.5],
        children: [
          makeLeaf({
            kind: 'terminal',
            mode: 'shell',
            status: 'running',
            createRequestId: 'req-terminal',
          }),
          makeLeaf({
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-1',
            status: 'connected',
            sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
          }),
        ],
      },
    })
    expect(result).toBeUndefined()
  })
})

describe('sanitizeTabsAgainstLayouts', () => {
  const makeTab = (
    id: string,
    overrides: Partial<Pick<Tab, 'sessionRef' | 'resumeSessionId' | 'mode'>> = {},
  ): Pick<Tab, 'id' | 'mode' | 'sessionRef' | 'resumeSessionId'> => ({
    id,
    mode: 'shell' as Tab['mode'],
    sessionRef: undefined,
    resumeSessionId: undefined,
    ...overrides,
  })

  it('updates tab identity from a fresh-agent pane with sessionRef', () => {
    const tabs = [makeTab('t1')]
    const layouts = {
      t1: makeLeaf({
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-1',
        status: 'connected',
        sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
      }),
    }
    const result = sanitizeTabsAgainstLayouts(tabs, layouts)
    expect(result).not.toBe(tabs)
    expect(result[0].sessionRef).toEqual({ provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID })
  })

  it('returns the same array reference when no changes are needed', () => {
    const tabs = [
      makeTab('t1', { sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID } }),
    ]
    const layouts = {
      t1: makeLeaf({
        kind: 'fresh-agent',
        sessionType: 'freshclaude',
        provider: 'claude',
        createRequestId: 'req-1',
        status: 'connected',
        sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
      }),
    }
    const result = sanitizeTabsAgainstLayouts(tabs, layouts)
    expect(result).toBe(tabs)
  })
})
