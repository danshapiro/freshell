import { describe, it, expect } from 'vitest'
import { enableMapSet } from 'immer'
import sessionsReducer, {
  patchSessionRunningStateFromTerminalMeta,
} from '@/store/sessionsSlice'
import {
  buildSessionItems,
  filterSessionItemsByVisibility,
  makeSelectSortedSessionItems,
} from '@/store/selectors/sidebarSelectors'
import type { BackgroundTerminal } from '@/store/types'
import type { RootState } from '@/store/store'

// Enable Immer's MapSet plugin for Set/Map support in Redux state
enableMapSet()

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

  it('rebind presentation: the new session row is running, the superseded row is not, and no duplicate rows exist', () => {
    // Between the `terminal.meta.updated` frame (terminal t-1 now belongs to
    // codex:new) and the 50ms-debounced session-window refresh, the shipped
    // store holds the LAGGING directory view: codex:old still claims t-1
    // (isRunning: true, runningTerminalId: 't-1'). Run the exact reducer
    // action the invalidation handler dispatches, then project through the
    // selector — the combined path must render the move, not a duplicate.
    const laggingSessionsState = {
      projects: [
        {
          projectPath: '/repo',
          sessions: [
            {
              provider: 'codex',
              sessionId: 'old',
              projectPath: '/repo',
              lastActivityAt: 1,
              title: 'Old thread',
              isRunning: true,
              runningTerminalId: 't-1',
            },
            {
              provider: 'codex',
              sessionId: 'new',
              projectPath: '/repo',
              lastActivityAt: 2,
              title: 'New thread',
            },
          ],
        },
      ],
      expandedProjects: new Set<string>(),
      wsSnapshotReceived: true,
    }
    const sessionsState = sessionsReducer(laggingSessionsState as any, patchSessionRunningStateFromTerminalMeta({
      upsert: [{ terminalId: 't-1', provider: 'codex', sessionId: 'new', updatedAt: 2_000 }],
      remove: [],
    }))

    const terminals: BackgroundTerminal[] = [
      {
        terminalId: 't-1',
        title: 'Codex',
        createdAt: 100,
        lastActivityAt: 2_100,
        status: 'running',
        hasClients: true,
        mode: 'codex',
        sessionRef: {
          provider: 'codex',
          sessionId: 'new',
        },
      },
    ]

    const items = buildSessionItems(sessionsState.projects, [], emptyPanes, terminals, {}, 'repo')

    const newItem = items.find((item) => item.provider === 'codex' && item.sessionId === 'new')
    expect(newItem).toMatchObject({
      isRunning: true,
      runningTerminalId: 't-1',
      hasTab: false,
    })

    const oldItems = items.filter((item) => item.provider === 'codex' && item.sessionId === 'old')
    expect(oldItems.length).toBeLessThanOrEqual(1)
    expect(oldItems.every((item) => !item.isRunning && item.runningTerminalId === undefined)).toBe(true)

    const claimants = items.filter((item) =>
      item.runningTerminalId === 't-1' || (item.runningTerminalIds ?? []).includes('t-1'))
    expect(claimants).toHaveLength(1)
    expect(claimants[0]?.sessionId).toBe('new')
  })
})

describe('subagent-target live terminals (Bug 1)', () => {
  const subagentTerminal = {
    terminalId: 'term-oc-subagent',
    title: 'opencode --session ses_024e59f87ffeEvZWqgMpBXAo78',
    createdAt: 1_100,
    lastActivityAt: 1_200,
    status: 'running' as const,
    hasClients: true,
    mode: 'opencode' as const,
    cwd: '/repo/live',
    resumeTargetIsSubagent: true,
  }
  const rootTerminal = {
    terminalId: 'term-oc-root',
    title: 'OpenCode',
    createdAt: 1_100,
    lastActivityAt: 1_200,
    status: 'running' as const,
    hasClients: true,
    mode: 'opencode' as const,
    cwd: '/repo/live',
  }

  it('marks the manufactured entry isSubagent when the terminal record is flagged', () => {
    const state = createState()
    const items = buildSessionItems(
      state.sessions.projects,
      state.tabs.tabs,
      state.panes,
      [subagentTerminal, rootTerminal],
      {},
      'repo',
    )
    const flagged = items.find((i) => i.sessionId === 'terminal:term-oc-subagent')
    expect(flagged?.isSubagent).toBe(true)
    const unflagged = items.find((i) => i.sessionId === 'terminal:term-oc-root')
    expect(unflagged?.isSubagent).toBeUndefined()
  })

  it('hides the flagged entry under default visibility (showSubagents=false) but keeps the root one', () => {
    const state = createState()
    const items = buildSessionItems(
      state.sessions.projects,
      state.tabs.tabs,
      state.panes,
      [subagentTerminal, rootTerminal],
      {},
      'repo',
    )
    const visible = filterSessionItemsByVisibility(items, {
      showSubagents: false,
      ignoreCodexSubagents: true,
      showNoninteractiveSessions: true,
      hideEmptySessions: false,
      excludeFirstChatSubstrings: [],
      excludeFirstChatMustStart: false,
    })
    const ids = visible.map((i) => i.sessionId)
    expect(ids).not.toContain('terminal:term-oc-subagent')
    expect(ids).toContain('terminal:term-oc-root')
  })

  it('shows the flagged entry when showSubagents is true (opt-in visibility)', () => {
    const state = createState()
    const items = buildSessionItems(
      state.sessions.projects,
      state.tabs.tabs,
      state.panes,
      [subagentTerminal],
      {},
      'repo',
    )
    const visible = filterSessionItemsByVisibility(items, {
      showSubagents: true,
      ignoreCodexSubagents: true,
      showNoninteractiveSessions: true,
      hideEmptySessions: false,
      excludeFirstChatSubstrings: [],
      excludeFirstChatMustStart: false,
    })
    expect(visible.map((i) => i.sessionId)).toContain('terminal:term-oc-subagent')
  })

  it('classifies tab/pane-derived FALLBACK rows for sessionRef-bearing child-target terminals (the load-bearing half)', () => {
    // sessionRef-bearing live terminals NEVER take the manufactured block
    // (sidebarSelectors.ts's `if (terminal.sessionRef) continue` guard); when
    // paned, they surface via pushFallbackItem as an `opencode:<child>` row.
    const CHILD_ID = 'ses_024e59f87ffeEvZWqgMpBXAo78'
    const ROOT_ID = 'ses_rootcontrol000000000000000'
    const makePanedFixture = (tag: string, terminalId: string, sessionId: string) => ({
      tab: {
        id: `tab-${tag}`,
        title: 'OpenCode',
        mode: 'opencode',
        createRequestId: `tab-${tag}`,
        status: 'running',
        createdAt: 1_000,
      },
      layout: {
        type: 'leaf',
        id: `pane-${tag}`,
        content: {
          kind: 'terminal',
          mode: 'opencode',
          terminalId,
          status: 'running',
          sessionRef: { provider: 'opencode', sessionId },
        },
      },
    })
    const child = makePanedFixture('oc-child', 'term-oc-paned-child', CHILD_ID)
    const root = makePanedFixture('oc-root', 'term-oc-paned-root', ROOT_ID)
    const tabs = [child.tab, root.tab] as any
    const panes = {
      layouts: {
        [child.tab.id]: child.layout,
        [root.tab.id]: root.layout,
      },
      activePaneByTabId: {},
      paneTitles: {},
    } as any
    const terminals = [
      {
        terminalId: 'term-oc-paned-child',
        title: `opencode --session ${CHILD_ID}`,
        createdAt: 1_100,
        lastActivityAt: 1_200,
        status: 'running' as const,
        hasClients: true,
        mode: 'opencode' as const,
        cwd: '/repo/live',
        sessionRef: { provider: 'opencode' as const, sessionId: CHILD_ID },
        resumeTargetIsSubagent: true,
      },
      {
        terminalId: 'term-oc-paned-root',
        title: 'OpenCode',
        createdAt: 1_100,
        lastActivityAt: 1_200,
        status: 'running' as const,
        hasClients: true,
        mode: 'opencode' as const,
        cwd: '/repo/live',
        sessionRef: { provider: 'opencode' as const, sessionId: ROOT_ID },
      },
    ]
    // NO matching indexed session for either id (empty projects) -> both
    // become pushFallbackItem rows, not indexed-session rows.
    const items = buildSessionItems([], tabs, panes, terminals, {}, 'repo')
    const fallback = items.find((i) => i.sessionId === CHILD_ID)
    expect(fallback?.isFallback).toBe(true)
    expect(fallback?.isSubagent).toBe(true)
    const rootFallback = items.find((i) => i.sessionId === ROOT_ID)
    expect(rootFallback?.isSubagent).toBeUndefined()

    const visible = filterSessionItemsByVisibility(items, {
      showSubagents: false,
      ignoreCodexSubagents: true,
      showNoninteractiveSessions: true,
      hideEmptySessions: false,
      excludeFirstChatSubstrings: [],
      excludeFirstChatMustStart: false,
    })
    const ids = visible.map((i) => i.sessionId)
    expect(ids).not.toContain(CHILD_ID)
    expect(ids).toContain(ROOT_ID)
  })
})
