import { describe, it, expect } from 'vitest'
import {
  buildSessionItems,
  filterSessionItemsByVisibility,
  makeSelectSortedSessionItems,
} from '@/store/selectors/sidebarSelectors'
import type { BackgroundTerminal } from '@/store/types'
import type { RootState } from '@/store/store'

function createState(): RootState {
  return {
    sessions: {
      projects: [
        {
          projectPath: '/repo',
          sessions: [
            {
              provider: 'codex',
              sessionId: 'session-1',
              projectPath: '/repo',
              lastActivityAt: 1,
              title: 'Session One',
              cwd: '/repo',
            },
          ],
        },
      ],
      loading: false,
      error: null,
      expandedProjects: new Set<string>(),
      projectColors: {},
      sessionColorOverrides: {},
      source: 'runtime',
    },
    tabs: {
      tabs: [],
      activeTabId: null,
      renameRequestTabId: null,
    },
    panes: {
      layouts: {},
      activePaneByTabId: {},
      paneTitles: {},
      paneTitleSetByUser: {},
      tabTitleTemplates: {},
      tabTitleTemplateSetByUser: {},
      tabTitleEphemeralSuppressed: {},
      tabTitleTemplateLastAppliedAt: {},
      mode: 'single',
      splitOrientation: 'vertical',
      defaultSplitDirection: 'right',
    },
    settings: {
      settings: {
        sidebar: {
          sortMode: 'recency-pinned',
          showSubagents: false,
          ignoreCodexSubagentSessions: true,
          showNoninteractiveSessions: false,
          hideEmptySessions: true,
          excludeFirstChatSubstrings: [],
          excludeFirstChatMustStart: false,
          showProjectBadges: true,
        },
      },
      loading: false,
      saving: false,
      error: null,
    },
    sessionActivity: {
      sessions: {},
    },
  } as unknown as RootState
}

describe('sidebarSelectors running session mapping', () => {
  const emptyPanes = {
    layouts: {},
    activePaneByTabId: {},
    paneTitles: {},
  } as any

  it('pins session runningTerminalId to the oldest running terminal when duplicate mappings exist', () => {
    const selector = makeSelectSortedSessionItems()
    const state = createState()
    const terminals: BackgroundTerminal[] = [
      {
        terminalId: 'newer-terminal',
        title: 'Codex',
        createdAt: 200,
        lastActivityAt: 500,
        status: 'running',
        hasClients: true,
        mode: 'codex',
        sessionRef: {
          provider: 'codex',
          sessionId: 'session-1',
        },
      },
      {
        terminalId: 'older-terminal',
        title: 'Codex',
        createdAt: 100,
        lastActivityAt: 600,
        status: 'running',
        hasClients: true,
        mode: 'codex',
        sessionRef: {
          provider: 'codex',
          sessionId: 'session-1',
        },
      },
    ]

    const items = selector(state, terminals, '')

    expect(items).toHaveLength(1)
    expect(items[0].runningTerminalId).toBe('older-terminal')
  })

  it('uses server session-directory running state when terminal directory has no sessionRef yet', () => {
    const items = buildSessionItems([
      {
        projectPath: '/repo/live',
        sessions: [{
          provider: 'codex',
          sessionId: 'codex-live-1',
          projectPath: '/repo/live',
          lastActivityAt: 1_700,
          title: 'Live Codex',
          isRunning: true,
          runningTerminalId: 'term-codex-1',
        }],
      },
    ] as any, [], emptyPanes, [], {}, 'repo')

    expect(items[0]).toMatchObject({
      isRunning: true,
      runningTerminalId: 'term-codex-1',
      hasTab: false,
    })
    expect(items[0].runningTerminalIds).toBeUndefined()
  })

  it('does not hide titleless running sessions when hideEmptySessions is enabled', () => {
    const items = buildSessionItems([
      {
        projectPath: '/repo/live',
        sessions: [{
          provider: 'opencode',
          sessionId: 'ses_live_opencode',
          projectPath: '/repo/live',
          lastActivityAt: 1_800,
          isRunning: true,
          runningTerminalId: 'term-opencode-1',
        }],
      },
    ] as any, [], emptyPanes, [], {}, 'repo')

    const visible = filterSessionItemsByVisibility(items, {
      showSubagents: true,
      ignoreCodexSubagents: false,
      showNoninteractiveSessions: true,
      hideEmptySessions: true,
      excludeFirstChatSubstrings: [],
      excludeFirstChatMustStart: false,
    })

    expect(visible.map((item) => item.sessionId)).toEqual(['ses_live_opencode'])
  })

  it('adds a live-only item for running coding terminals without session refs', () => {
    const items = buildSessionItems(
      [],
      [{
        id: 'tab-opencode',
        title: 'OpenCode',
        mode: 'opencode',
        createRequestId: 'tab-opencode',
        status: 'running',
        createdAt: 1_000,
      }] as any,
      {
        layouts: {
          'tab-opencode': {
            type: 'leaf',
            id: 'pane-opencode',
            content: {
              kind: 'terminal',
              mode: 'opencode',
              terminalId: 'term-opencode-live',
              status: 'running',
            },
          },
        },
        activePaneByTabId: {
          'tab-opencode': 'pane-opencode',
        },
        activePane: {
          'tab-opencode': 'pane-opencode',
        },
        paneTitles: {
          'tab-opencode': {
            'pane-opencode': 'OpenCode',
          },
        },
      } as any,
      [{
        terminalId: 'term-opencode-live',
        title: 'OpenCode',
        createdAt: 1_100,
        lastActivityAt: 1_200,
        status: 'running',
        hasClients: true,
        mode: 'opencode',
        cwd: '/repo/live',
      }],
      {},
      'repo',
    )

    expect(items).toEqual([
      expect.objectContaining({
        provider: 'opencode',
        sessionId: 'terminal:term-opencode-live',
        title: 'OpenCode',
        subtitle: 'live',
        hasTab: true,
        isRunning: true,
        runningTerminalId: 'term-opencode-live',
        runningTerminalIds: ['term-opencode-live'],
        liveTerminalOnly: true,
      }),
    ])
  })
})
