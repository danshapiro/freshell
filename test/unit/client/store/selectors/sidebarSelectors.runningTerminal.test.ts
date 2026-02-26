import { describe, it, expect } from 'vitest'
import { makeSelectSortedSessionItems } from '@/store/selectors/sidebarSelectors'
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
              updatedAt: 1,
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
        resumeSessionId: 'session-1',
      },
      {
        terminalId: 'older-terminal',
        title: 'Codex',
        createdAt: 100,
        lastActivityAt: 600,
        status: 'running',
        hasClients: true,
        mode: 'codex',
        resumeSessionId: 'session-1',
      },
    ]

    const items = selector(state, terminals, '')

    expect(items).toHaveLength(1)
    expect(items[0].runningTerminalId).toBe('older-terminal')
  })
})
