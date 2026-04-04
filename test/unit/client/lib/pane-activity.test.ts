import { describe, it, expect } from 'vitest'
import { collectBusySessionKeys, resolvePaneActivity } from '@/lib/pane-activity'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import type { Tab } from '@/store/types'

describe('pane activity', () => {
  it('keeps Codex exact-match semantics and only treats busy as blue', () => {
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
      tabTerminalId: 'term-tab',
      isOnlyPane: true,
      codexActivityByTerminalId: {
        'term-live': { terminalId: 'term-live', phase: 'busy', updatedAt: 10 },
      },
      paneRuntimeActivityByPaneId: {},
      agentChatSessions: {},
    })).toMatchObject({ isBusy: true, source: 'codex' })

    expect(resolvePaneActivity({
      paneId: 'pane-1',
      content,
      tabTerminalId: 'term-tab',
      isOnlyPane: true,
      codexActivityByTerminalId: {
        'term-live': { terminalId: 'term-live', phase: 'pending', updatedAt: 10 },
      },
      paneRuntimeActivityByPaneId: {},
      agentChatSessions: {},
    }).isBusy).toBe(false)

    expect(resolvePaneActivity({
      paneId: 'pane-1',
      content: { ...content, terminalId: undefined },
      tabTerminalId: undefined,
      isOnlyPane: false,
      codexActivityByTerminalId: {
        'term-foreign': { terminalId: 'term-foreign', phase: 'busy', updatedAt: 10 },
      },
      paneRuntimeActivityByPaneId: {},
      agentChatSessions: {},
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
          kind: 'agent-chat',
          provider: 'freshclaude',
          createRequestId: 'req-fresh',
          sessionId: 'sdk-1',
          resumeSessionId: freshSessionId,
          status: 'running',
        },
      },
    }

    const busySessionKeys = collectBusySessionKeys({
      tabs,
      paneLayouts,
      codexActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {
        'pane-claude': {
          source: 'terminal',
          phase: 'working',
          updatedAt: 1,
        },
      },
      agentChatSessions: {
        'sdk-1': {
          sessionId: 'sdk-1',
          cliSessionId: freshSessionId,
          status: 'running',
          messages: [],
          timelineItems: [],
          timelineBodies: {},
          streamingText: '',
          streamingActive: true,
          pendingPermissions: {},
          pendingQuestions: {},
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
      },
    })

    expect(busySessionKeys).toEqual([
      `claude:${claudeSessionId}`,
      `claude:${freshSessionId}`,
    ])
  })

  it('prefers timelineSessionId for busy freshclaude panes during restore gaps', () => {
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
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-fresh',
            sessionId: 'sdk-restore-1',
            resumeSessionId: 'stale-resume',
            status: 'running',
          },
        },
      },
      codexActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
      agentChatSessions: {
        'sdk-restore-1': {
          sessionId: 'sdk-restore-1',
          timelineSessionId: 'canonical-session-1',
          status: 'running',
          messages: [],
          timelineItems: [],
          timelineBodies: {},
          streamingText: '',
          streamingActive: true,
          pendingPermissions: {},
          pendingQuestions: {},
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
      },
    })

    expect(busySessionKeys).toEqual(['claude:canonical-session-1'])
  })

  it('prefers a canonical cliSessionId over a named timelineSessionId for busy freshclaude panes', () => {
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
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-fresh',
            sessionId: 'sdk-restore-2',
            resumeSessionId: 'stale-resume',
            status: 'running',
          },
        },
      },
      codexActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
      agentChatSessions: {
        'sdk-restore-2': {
          sessionId: 'sdk-restore-2',
          timelineSessionId: 'named-resume',
          cliSessionId: '00000000-0000-4000-8000-000000000321',
          status: 'running',
          messages: [],
          timelineItems: [],
          timelineBodies: {},
          streamingText: '',
          streamingActive: true,
          pendingPermissions: {},
          pendingQuestions: {},
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
      },
    })

    expect(busySessionKeys).toEqual(['claude:00000000-0000-4000-8000-000000000321'])
  })
})
