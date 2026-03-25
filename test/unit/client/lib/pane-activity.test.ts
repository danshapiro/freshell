import { describe, it, expect } from 'vitest'
import { collectBusySessionKeys, getBusyPaneIdsForTab, resolvePaneActivity } from '@/lib/pane-activity'
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

  it('ignores no-layout coding tab mirrors for busy ownership', () => {
    const claudeSessionId = '33333333-3333-4333-8333-333333333333'

    const tabs: Tab[] = [
      {
        id: 'tab-mirror',
        title: 'Mirror',
        createRequestId: 'req-mirror',
        status: 'running',
        mode: 'codex',
        shell: 'system',
        createdAt: 1,
        terminalId: 'term-mirror',
        resumeSessionId: 'codex-session-mirror',
      },
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
    }

    expect(getBusyPaneIdsForTab({
      tab: tabs[0],
      paneLayouts,
      codexActivityByTerminalId: {
        'term-mirror': { terminalId: 'term-mirror', phase: 'busy', updatedAt: 10 },
      },
      paneRuntimeActivityByPaneId: {},
      agentChatSessions: {},
    })).toEqual([])

    expect(collectBusySessionKeys({
      tabs,
      paneLayouts,
      codexActivityByTerminalId: {
        'term-mirror': { terminalId: 'term-mirror', phase: 'busy', updatedAt: 10 },
      },
      paneRuntimeActivityByPaneId: {
        'pane-claude': {
          source: 'terminal',
          phase: 'working',
          updatedAt: 1,
        },
      },
      agentChatSessions: {},
    })).toEqual([`claude:${claudeSessionId}`])
  })
})
