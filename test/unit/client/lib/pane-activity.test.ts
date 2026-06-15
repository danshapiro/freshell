import { describe, it, expect } from 'vitest'
import { collectBusySessionKeys, resolvePaneActivity } from '@/lib/pane-activity'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
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
      paneRuntimeActivityByPaneId: {},
    }).isBusy).toBe(false)
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
      paneRuntimeActivityByPaneId: {},
    }).isBusy).toBe(false)
  })

  it('collects busy session keys from claude terminals and freshclaude panes', () => {
    const claudeSessionId = '11111111-1111-4111-8111-111111111111'
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
        resumeSessionId: claudeSessionId,
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
          resumeSessionId: claudeSessionId,
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
      paneRuntimeActivityByPaneId: {},
      freshAgentSessions: freshAgentSessionMap(
        { sessionType: 'freshclaude', provider: 'claude', sessionId: 'sdk-1' },
        freshAgentSession({ sessionId: 'sdk-1' }),
      ),
    })

    expect(busySessionKeys).toEqual([
      `claude:${claudeSessionId}`,
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
      paneRuntimeActivityByPaneId: {},
    }
    expect(resolvePaneActivity({ ...base, claudeActivityByTerminalId: { t1: { terminalId: 't1', phase: 'idle', updatedAt: 1 } } }).isBusy).toBe(false)
    expect(resolvePaneActivity({ ...base, claudeActivityByTerminalId: {} }).isBusy).toBe(false)
  })
})
