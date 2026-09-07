import { describe, it, expect } from 'vitest'
import { collectBusySessionKeys, collectPaneIdentityActivity, isFreshAgentBusy, resolvePaneActivity, resolvePaneIdleGreen } from '@/lib/pane-activity'
import type { FreshAgentPaneContent, PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import type { FreshAgentSessionState } from '@/store/freshAgentTypes'
import type { Tab } from '@/store/types'
import {
  makeFreshAgentSessionKey,
  type FreshAgentRuntimeProvider,
  type FreshAgentSessionType,
} from '@shared/fresh-agent'

function freshAgentSession(input: {
  sessionType?: FreshAgentSessionType
  provider?: FreshAgentRuntimeProvider
  sessionId: string
  status?: FreshAgentSessionState['status']
  streamingActive?: boolean
}): FreshAgentSessionState {
  const sessionType = input.sessionType ?? 'freshclaude'
  const provider = input.provider ?? 'claude'
  return {
    sessionType,
    provider,
    sessionId: input.sessionId,
    sessionKey: makeFreshAgentSessionKey({ sessionType, provider, sessionId: input.sessionId }),
    threadId: input.sessionId,
    status: input.status ?? 'running',
    turns: [],
    historyItems: [],
    historyBodies: {},
    streamingText: '',
    streamingActive: input.streamingActive ?? true,
    pendingPermissions: {},
    pendingQuestions: {},
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  }
}

function freshAgentSessionMap(
  lookup: { sessionType: FreshAgentSessionType; provider: FreshAgentRuntimeProvider; sessionId: string },
  session: FreshAgentSessionState,
): Record<string, FreshAgentSessionState> {
  return {
    [makeFreshAgentSessionKey(lookup)]: session,
  }
}

describe('pane activity', () => {
  it('keeps Codex exact-match semantics and treats busy and pending as blue', () => {
    const content: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-codex',
      status: 'running',
      mode: 'codex',
      terminalId: 'term-live',
      shell: 'system',
      resumeSessionId: 'session-codex',
    }

    expect(resolvePaneActivity({
      paneId: 'pane-1',
      content,
      isOnlyPane: true,
      codexActivityByTerminalId: {
        'term-live': { terminalId: 'term-live', phase: 'busy', updatedAt: 10 },
      },
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    })).toMatchObject({ isBusy: true, source: 'codex' })

    expect(resolvePaneActivity({
      paneId: 'pane-1',
      content,
      isOnlyPane: true,
      codexActivityByTerminalId: {
        'term-live': { terminalId: 'term-live', phase: 'pending', updatedAt: 10 },
      },
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    })).toMatchObject({ isBusy: true, source: 'codex' })

    expect(resolvePaneActivity({
      paneId: 'pane-1',
      content: { ...content, terminalId: undefined },
      isOnlyPane: false,
      codexActivityByTerminalId: {
        'term-foreign': { terminalId: 'term-foreign', phase: 'busy', updatedAt: 10 },
      },
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    }).isBusy).toBe(false)
  })

  it('isFreshAgentBusy is false for a stuck freshcodex session', () => {
    // Contract pin: 'stuck' is not in any busy set. streamingActive is fixed
    // false so STATUS alone discriminates (the setSessionStatus('stuck') fold
    // clears streamingActive atomically, so this is the exact post-deadman
    // store shape) — the running control proves the fixture is busy-shaped.
    const content: FreshAgentPaneContent = {
      kind: 'fresh-agent',
      createRequestId: 'req-stuck',
      sessionType: 'freshcodex',
      provider: 'codex',
      sessionId: 'thread-stuck-1',
      status: 'running',
    }
    const running = freshAgentSession({
      sessionType: 'freshcodex',
      provider: 'codex',
      sessionId: 'thread-stuck-1',
      status: 'running',
      streamingActive: false,
    })
    expect(isFreshAgentBusy(content, running)).toBe(true)

    const stuck = freshAgentSession({
      sessionType: 'freshcodex',
      provider: 'codex',
      sessionId: 'thread-stuck-1',
      status: 'stuck',
      streamingActive: false,
    })
    expect(isFreshAgentBusy(content, stuck)).toBe(false)
  })

  it('does not show fresh-agent panes as busy when no live session exists (no reload blue-flash)', () => {
    const freshContent = {
      kind: 'fresh-agent',
      createRequestId: 'cr',
      sessionType: 'freshclaude',
      provider: 'claude',
      sessionId: 'abc',
      status: 'running', // stale persisted status — must NOT drive blue without a live session
    } as never

    expect(resolvePaneActivity({
      paneId: 'p',
      content: freshContent,
      isOnlyPane: true,
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
      freshAgentSessions: {},
    }).isBusy).toBe(false)
  })

  it('keeps OpenCode exact-match semantics and only treats live terminal matches as busy', () => {
    const content: TerminalPaneContent = {
      kind: 'terminal',
      createRequestId: 'req-opencode',
      status: 'running',
      mode: 'opencode',
      terminalId: 'term-live',
      shell: 'system',
      resumeSessionId: 'session-opencode',
    }

    expect(resolvePaneActivity({
      paneId: 'pane-1',
      content,
      isOnlyPane: true,
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {
        'term-live': { terminalId: 'term-live', phase: 'busy', updatedAt: 10 },
      },
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    })).toMatchObject({ isBusy: true, source: 'opencode' })

    expect(resolvePaneActivity({
      paneId: 'pane-1',
      content: { ...content, terminalId: undefined },
      isOnlyPane: true,
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {
        'term-foreign': { terminalId: 'term-foreign', phase: 'busy', updatedAt: 10 },
      },
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    }).isBusy).toBe(false)
  })

  it('collects busy session keys from claude terminals and freshclaude panes', () => {
    const claudeResumeId = '11111111-1111-4111-8111-111111111111'
    const freshSessionId = '22222222-2222-4222-8222-222222222222'

    const tabs: Tab[] = [
      {
        id: 'tab-claude',
        title: 'Claude',
        createRequestId: 'req-claude',
        status: 'running',
        mode: 'claude',
        shell: 'system',
        createdAt: 1,
        terminalId: 'term-claude',
        resumeSessionId: claudeResumeId,
      },
      {
        id: 'tab-fresh',
        title: 'Fresh',
        createRequestId: 'req-fresh',
        status: 'running',
        mode: 'shell',
        shell: 'system',
        createdAt: 1,
      },
    ]

    const paneLayouts: Record<string, PaneNode> = {
      'tab-claude': {
        type: 'leaf',
        id: 'pane-claude',
        content: {
          kind: 'terminal',
          createRequestId: 'req-claude',
          status: 'running',
          mode: 'claude',
          shell: 'system',
          terminalId: 'term-claude',
          resumeSessionId: claudeResumeId,
        },
      },
      'tab-fresh': {
        type: 'leaf',
        id: 'pane-fresh',
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: 'req-fresh',
          sessionId: 'sdk-1',
          resumeSessionId: freshSessionId,
          sessionRef: { provider: 'claude', sessionId: freshSessionId },
          status: 'running',
        },
      },
    }

    const busySessionKeys = collectBusySessionKeys({
      tabs,
      paneLayouts,
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {
        'term-claude': { terminalId: 'term-claude', phase: 'busy', updatedAt: 1 },
      },
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
      freshAgentSessions: freshAgentSessionMap(
        { sessionType: 'freshclaude', provider: 'claude', sessionId: 'sdk-1' },
        freshAgentSession({ sessionId: 'sdk-1' }),
      ),
    })

    expect(busySessionKeys).toEqual([
      `claude:${claudeResumeId}`,
      `claude:${freshSessionId}`,
    ])
  })

  it('uses the live fresh-agent session id for busy freshclaude panes during restore gaps', () => {
    const busySessionKeys = collectBusySessionKeys({
      tabs: [
        {
          id: 'tab-fresh',
          title: 'Fresh',
          createRequestId: 'req-fresh',
          status: 'running',
          mode: 'shell',
          shell: 'system',
          createdAt: 1,
        },
      ],
      paneLayouts: {
        'tab-fresh': {
          type: 'leaf',
          id: 'pane-fresh',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-fresh',
            sessionId: 'sdk-restore-1',
            resumeSessionId: 'stale-resume',
            status: 'running',
          },
        },
      },
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
      freshAgentSessions: freshAgentSessionMap(
        { sessionType: 'freshclaude', provider: 'claude', sessionId: 'sdk-restore-1' },
        freshAgentSession({ sessionId: 'canonical-session-1' }),
      ),
    })

    expect(busySessionKeys).toEqual(['claude:canonical-session-1'])
  })

  it('prefers an explicit sessionRef over a live fresh-agent session id', () => {
    const busySessionKeys = collectBusySessionKeys({
      tabs: [
        {
          id: 'tab-fresh',
          title: 'Fresh',
          createRequestId: 'req-fresh',
          status: 'running',
          mode: 'shell',
          shell: 'system',
          createdAt: 1,
        },
      ],
      paneLayouts: {
        'tab-fresh': {
          type: 'leaf',
          id: 'pane-fresh',
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-fresh',
            sessionId: 'sdk-restore-2',
            resumeSessionId: 'stale-resume',
            sessionRef: { provider: 'claude', sessionId: '00000000-0000-4000-8000-000000000321' },
            status: 'running',
          },
        },
      },
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
      freshAgentSessions: freshAgentSessionMap(
        { sessionType: 'freshclaude', provider: 'claude', sessionId: 'sdk-restore-2' },
        freshAgentSession({ sessionId: 'live-session-2' }),
      ),
    })

    expect(busySessionKeys).toEqual(['claude:00000000-0000-4000-8000-000000000321'])
  })

  it('collects busy session keys from OpenCode terminals using exact terminal matches', () => {
    const sessionId = '33333333-3333-4333-8333-333333333333'
    const busySessionKeys = collectBusySessionKeys({
      tabs: [
        {
          id: 'tab-opencode',
          title: 'OpenCode',
          createRequestId: 'req-opencode',
          status: 'running',
          mode: 'opencode',
          shell: 'system',
          createdAt: 1,
          terminalId: 'term-live',
          sessionRef: {
            provider: 'opencode',
            sessionId,
          },
        },
      ],
      paneLayouts: {
        'tab-opencode': {
          type: 'leaf',
          id: 'pane-opencode',
          content: {
            kind: 'terminal',
            createRequestId: 'req-opencode',
            status: 'running',
            mode: 'opencode',
            shell: 'system',
            terminalId: 'term-live',
            sessionRef: {
              provider: 'opencode',
              sessionId,
            },
          },
        },
      },
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {
        'term-live': {
          terminalId: 'term-live',
          sessionId,
          phase: 'busy',
          updatedAt: 1,
        },
      },
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    })

    expect(busySessionKeys).toEqual([`opencode:${sessionId}`])
  })

  it('does not synthesize OpenCode busy session keys from a tab title when no canonical identity exists', () => {
    const busySessionKeys = collectBusySessionKeys({
      tabs: [
        {
          id: 'tab-opencode-title',
          title: 'probe-title-two',
          createRequestId: 'req-opencode-title',
          status: 'running',
          mode: 'opencode',
          shell: 'system',
          createdAt: 1,
          terminalId: 'term-live',
        },
      ],
      paneLayouts: {
        'tab-opencode-title': {
          type: 'leaf',
          id: 'pane-opencode-title',
          content: {
            kind: 'terminal',
            createRequestId: 'req-opencode-title',
            status: 'running',
            mode: 'opencode',
            shell: 'system',
            terminalId: 'term-live',
          },
        },
      },
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {
        'term-live': {
          terminalId: 'term-live',
          sessionId: '33333333-3333-4333-8333-333333333333',
          phase: 'busy',
          updatedAt: 1,
        },
      },
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    })

    expect(busySessionKeys).toEqual([])
  })

  it('treats a claude terminal as busy when the server record is busy', () => {
    const result = resolvePaneActivity({
      paneId: 'p1',
      content: { kind: 'terminal', createRequestId: 'c1', status: 'running', mode: 'claude', terminalId: 't1' } as any,
      isOnlyPane: true,
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: { t1: { terminalId: 't1', phase: 'busy', updatedAt: 1 } },
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    })
    expect(result).toEqual({ isBusy: true, source: 'claude-terminal' })
  })

  it('treats a claude terminal as idle when the server record is idle or absent', () => {
    const base = {
      paneId: 'p1',
      content: { kind: 'terminal', createRequestId: 'c1', status: 'running', mode: 'claude', terminalId: 't1' } as any,
      isOnlyPane: true,
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    }
    expect(resolvePaneActivity({ ...base, claudeActivityByTerminalId: { t1: { terminalId: 't1', phase: 'idle', updatedAt: 1 } } }).isBusy).toBe(false)
    expect(resolvePaneActivity({ ...base, claudeActivityByTerminalId: {} }).isBusy).toBe(false)
  })

  it('treats an amplifier terminal as busy when the server record is busy', () => {
    const result = resolvePaneActivity({
      paneId: 'p1',
      content: { kind: 'terminal', createRequestId: 'c1', status: 'running', mode: 'amplifier', terminalId: 't1' } as any,
      isOnlyPane: true,
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: { t1: { terminalId: 't1', phase: 'busy', updatedAt: 1 } },
      paneRuntimeActivityByPaneId: {},
    })
    expect(result).toEqual({ isBusy: true, source: 'amplifier' })
  })

  it('treats an amplifier terminal as idle when the server record is idle or absent', () => {
    const base = {
      paneId: 'p1',
      content: { kind: 'terminal', createRequestId: 'c1', status: 'running', mode: 'amplifier', terminalId: 't1' } as any,
      isOnlyPane: true,
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    }
    expect(resolvePaneActivity({ ...base, amplifierActivityByTerminalId: { t1: { terminalId: 't1', phase: 'idle', updatedAt: 1 } } }).isBusy).toBe(false)
    expect(resolvePaneActivity({ ...base, amplifierActivityByTerminalId: {} }).isBusy).toBe(false)
  })

  describe('collectPaneIdentityActivity', () => {
    const emptyActivity = {
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    }

    function terminalTab(id: string, overrides: Record<string, unknown> = {}): Tab {
      return {
        id,
        title: id,
        createRequestId: `req-${id}`,
        status: 'running',
        mode: 'claude',
        shell: 'system',
        createdAt: 1,
        ...(overrides as Partial<Tab>),
      }
    }

    it('returns an empty map when there are no tabs', () => {
      const activity = collectPaneIdentityActivity({
        tabs: [],
        paneLayouts: {},
        ...emptyActivity,
      })

      expect(activity.size).toBe(0)
    })

    it('skips layout-less tabs entirely (records are never built for them)', () => {
      const activity = collectPaneIdentityActivity({
        tabs: [terminalTab('tab-no-layout', {
          resumeSessionId: '11111111-1111-4111-8111-111111111111',
        })],
        paneLayouts: {},
        ...emptyActivity,
      })

      expect(activity.size).toBe(0)
    })

    it('stamps the busy identity only for busy panes', () => {
      const activity = collectPaneIdentityActivity({
        tabs: [terminalTab('tab-1', { mode: 'codex' })],
        paneLayouts: {
          'tab-1': {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'pane-busy',
                content: {
                  kind: 'terminal',
                  createRequestId: 'req-busy',
                  status: 'running',
                  mode: 'codex',
                  shell: 'system',
                  terminalId: 'term-busy',
                  sessionRef: { provider: 'codex', sessionId: 'codex-session-1' },
                },
              },
              {
                type: 'leaf',
                id: 'pane-idle',
                content: {
                  kind: 'terminal',
                  createRequestId: 'req-idle',
                  status: 'running',
                  mode: 'codex',
                  shell: 'system',
                  terminalId: 'term-idle',
                  sessionRef: { provider: 'codex', sessionId: 'codex-session-2' },
                },
              },
            ],
          },
        },
        ...emptyActivity,
        codexActivityByTerminalId: {
          'term-busy': { terminalId: 'term-busy', phase: 'busy', updatedAt: 1 },
        },
      })

      expect(activity.get('pane-busy')).toEqual({
        sessionKeys: ['codex:codex-session-1'],
        busySessionKeys: ['codex:codex-session-1'],
      })
      expect(activity.get('pane-idle')).toEqual({
        sessionKeys: ['codex:codex-session-2'],
        busySessionKeys: [],
      })
    })

    it('resolves fresh-agent identity through the live canonical session during restore gaps', () => {
      const activity = collectPaneIdentityActivity({
        tabs: [terminalTab('tab-fresh', { mode: 'shell' })],
        paneLayouts: {
          'tab-fresh': {
            type: 'leaf',
            id: 'pane-fresh',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-fresh',
              sessionId: 'sdk-restore-1',
              resumeSessionId: 'stale-resume',
              status: 'running',
            },
          },
        },
        ...emptyActivity,
        freshAgentSessions: freshAgentSessionMap(
          { sessionType: 'freshclaude', provider: 'claude', sessionId: 'sdk-restore-1' },
          freshAgentSession({ sessionId: 'canonical-session-1' }),
        ),
      })

      const entry = activity.get('pane-fresh')
      // The stale content resumeSessionId is still a locator for the local green
      // join, and the live canonical identity is unioned in next to it.
      expect(entry?.sessionKeys).toEqual(['claude:stale-resume', 'claude:canonical-session-1'])
      expect(entry?.busySessionKeys).toEqual(['claude:canonical-session-1'])
    })

    it('does not stamp a busy identity while the pane waits for approval', () => {
      const sessionId = '44444444-4444-4444-8444-444444444444'
      const activity = collectPaneIdentityActivity({
        tabs: [terminalTab('tab-fresh', { mode: 'shell' })],
        paneLayouts: {
          'tab-fresh': {
            type: 'leaf',
            id: 'pane-fresh',
            content: {
              kind: 'fresh-agent',
              sessionType: 'freshclaude',
              provider: 'claude',
              createRequestId: 'req-fresh',
              sessionId: 'sdk-1',
              sessionRef: { provider: 'claude', sessionId },
              status: 'running',
            },
          },
        },
        ...emptyActivity,
        freshAgentSessions: freshAgentSessionMap(
          { sessionType: 'freshclaude', provider: 'claude', sessionId: 'sdk-1' },
          {
            ...freshAgentSession({ sessionId }),
            pendingPermissions: { 'perm-1': {} as never },
          },
        ),
      })

      const entry = activity.get('pane-fresh')
      expect(entry?.sessionKeys).toEqual([`claude:${sessionId}`])
      expect(entry?.busySessionKeys).toEqual([])
    })

    it('stamps the explicit sessionRef identity for terminal panes', () => {
      const activity = collectPaneIdentityActivity({
        tabs: [terminalTab('tab-1', { mode: 'opencode' })],
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              createRequestId: 'req-1',
              status: 'running',
              mode: 'opencode',
              shell: 'system',
              terminalId: 'term-1',
              sessionRef: { provider: 'opencode', sessionId: 'opencode-session-1' },
            },
          },
        },
        ...emptyActivity,
      })

      expect(activity.get('pane-1')).toEqual({
        sessionKeys: ['opencode:opencode-session-1'],
        busySessionKeys: [],
      })
    })

    it('stamps the Claude resume identity for terminal panes without a sessionRef', () => {
      const resumeId = '55555555-5555-4555-8555-555555555555'
      const activity = collectPaneIdentityActivity({
        tabs: [terminalTab('tab-1')],
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              createRequestId: 'req-1',
              status: 'running',
              mode: 'claude',
              shell: 'system',
              resumeSessionId: resumeId,
            },
          },
        },
        ...emptyActivity,
      })

      expect(activity.get('pane-1')?.sessionKeys).toEqual([`claude:${resumeId}`])
    })

    it('stamps the Codex durability identity for terminal panes', () => {
      const activity = collectPaneIdentityActivity({
        tabs: [terminalTab('tab-1', { mode: 'codex' })],
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              createRequestId: 'req-1',
              status: 'running',
              mode: 'codex',
              shell: 'system',
              terminalId: 'term-1',
              codexDurability: {
                schemaVersion: 1,
                state: 'durable',
                durableThreadId: 'codex-thread-1',
              } as never,
            },
          },
        },
        ...emptyActivity,
      })

      // A Codex terminal WITH a durability identity gets no fabricated terminal:
      // row in the Sidebar — only the canonical key is stamped.
      expect(activity.get('pane-1')?.sessionKeys).toEqual(['codex:codex-thread-1'])
    })

    it('stamps the Sidebar fallback row key for running non-shell terminals without canonical metadata', () => {
      const activity = collectPaneIdentityActivity({
        tabs: [terminalTab('tab-1')],
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              createRequestId: 'req-1',
              status: 'running',
              mode: 'claude',
              shell: 'system',
              terminalId: 'term-fallback',
            },
          },
        },
        ...emptyActivity,
      })

      expect(activity.get('pane-1')).toEqual({
        sessionKeys: ['claude:terminal:term-fallback'],
        busySessionKeys: [],
      })
    })

    it('omits shell terminals and other identity-less panes from the map', () => {
      const activity = collectPaneIdentityActivity({
        tabs: [
          terminalTab('tab-shell', { mode: 'shell' }),
          terminalTab('tab-browser', { mode: 'shell' }),
        ],
        paneLayouts: {
          'tab-shell': {
            type: 'leaf',
            id: 'pane-shell',
            content: {
              kind: 'terminal',
              createRequestId: 'req-shell',
              status: 'running',
              mode: 'shell',
              shell: 'system',
              terminalId: 'term-shell',
            },
          },
          'tab-browser': {
            type: 'leaf',
            id: 'pane-browser',
            content: {
              kind: 'browser',
              browserInstanceId: 'browser-1',
              url: 'https://example.test',
              devToolsOpen: false,
            },
          },
        },
        ...emptyActivity,
      })

      expect(activity.size).toBe(0)
    })

    it('keeps every alias in sessionKeys but stamps only the effective busy identity', () => {
      const explicitId = '66666666-6666-4666-8666-666666666666'
      const resumeId = '77777777-7777-4777-8777-777777777777'
      const activity = collectPaneIdentityActivity({
        tabs: [terminalTab('tab-1')],
        paneLayouts: {
          'tab-1': {
            type: 'leaf',
            id: 'pane-1',
            content: {
              kind: 'terminal',
              createRequestId: 'req-1',
              status: 'running',
              mode: 'claude',
              shell: 'system',
              terminalId: 'term-alias',
              sessionRef: { provider: 'claude', sessionId: explicitId },
              resumeSessionId: resumeId,
            },
          },
        },
        ...emptyActivity,
        claudeActivityByTerminalId: {
          'term-alias': { terminalId: 'term-alias', phase: 'busy', updatedAt: 1 },
        },
      })

      const entry = activity.get('pane-1')
      expect(entry?.sessionKeys).toContain(`claude:${explicitId}`)
      expect(entry?.sessionKeys).toContain(`claude:${resumeId}`)
      expect(entry?.busySessionKeys).toEqual([`claude:${explicitId}`])
    })
  })

  describe('resolvePaneIdleGreen (persistent green for terminal CLI panes)', () => {
    const emptyMaps = {
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: {},
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    }

    function terminalContent(overrides: Partial<TerminalPaneContent> = {}): TerminalPaneContent {
      return {
        kind: 'terminal',
        createRequestId: 'c1',
        status: 'running',
        mode: 'claude',
        shell: 'system',
        terminalId: 't1',
        ...overrides,
      } as TerminalPaneContent
    }

    it('is green when the CLI session is known (idle activity record) and not busy', () => {
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent(),
        isOnlyPane: true,
        ...emptyMaps,
        claudeActivityByTerminalId: { t1: { terminalId: 't1', phase: 'idle', updatedAt: 1 } },
      })).toBe(true)
    })

    it('is not green while busy (blue wins)', () => {
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent(),
        isOnlyPane: true,
        ...emptyMaps,
        claudeActivityByTerminalId: { t1: { terminalId: 't1', phase: 'busy', updatedAt: 1 } },
      })).toBe(false)
    })

    it('is not green when no session is known yet (no record, no sessionRef, no resume id)', () => {
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent(),
        isOnlyPane: true,
        ...emptyMaps,
      })).toBe(false)
    })

    it('treats a bound sessionRef or resumeSessionId as a known session (opencode has no idle records)', () => {
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent({
          mode: 'opencode',
          sessionRef: { provider: 'opencode', sessionId: 'ses-1' },
        }),
        isOnlyPane: true,
        ...emptyMaps,
      })).toBe(true)
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent({ mode: 'opencode', resumeSessionId: 'ses-1' }),
        isOnlyPane: true,
        ...emptyMaps,
      })).toBe(true)
    })

    it('is not green for a busy opencode terminal even with a bound session', () => {
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent({
          mode: 'opencode',
          sessionRef: { provider: 'opencode', sessionId: 'ses-1' },
        }),
        isOnlyPane: true,
        ...emptyMaps,
        opencodeActivityByTerminalId: { t1: { terminalId: 't1', phase: 'busy', updatedAt: 1, lastObservedAt: 1 } as any },
      })).toBe(false)
    })

    it('is not green for codex while pending (queued submit is busy)', () => {
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent({ mode: 'codex' }),
        isOnlyPane: true,
        ...emptyMaps,
        codexActivityByTerminalId: { t1: { terminalId: 't1', phase: 'pending', updatedAt: 1 } },
      })).toBe(false)
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent({ mode: 'codex' }),
        isOnlyPane: true,
        ...emptyMaps,
        codexActivityByTerminalId: { t1: { terminalId: 't1', phase: 'idle', updatedAt: 1 } },
      })).toBe(true)
    })

    it('is never green for shell panes, exited terminals, or non-terminal panes', () => {
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent({ mode: 'shell' }),
        isOnlyPane: true,
        ...emptyMaps,
      })).toBe(false)
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent({ status: 'exited' }),
        isOnlyPane: true,
        ...emptyMaps,
        claudeActivityByTerminalId: { t1: { terminalId: 't1', phase: 'idle', updatedAt: 1 } },
      })).toBe(false)
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: { kind: 'browser', url: 'https://example.com' } as any,
        isOnlyPane: true,
        ...emptyMaps,
      })).toBe(false)
    })

    it('is never green for custom CLI modes (gemini/kimi are status-inert)', () => {
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent({ mode: 'gemini', resumeSessionId: 'ses-1' }),
        isOnlyPane: true,
        ...emptyMaps,
      })).toBe(false)
    })

    it('is green for an amplifier pane with an idle activity record', () => {
      expect(resolvePaneIdleGreen({
        paneId: 'p1',
        content: terminalContent({ mode: 'amplifier' }),
        isOnlyPane: true,
        ...emptyMaps,
        amplifierActivityByTerminalId: { t1: { terminalId: 't1', phase: 'idle', updatedAt: 1 } },
      })).toBe(true)
    })
  })
})
