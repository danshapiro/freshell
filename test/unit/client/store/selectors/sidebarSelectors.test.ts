import { describe, it, expect } from 'vitest'
import type { SidebarSessionItem } from '@/store/selectors/sidebarSelectors'
import type { ProjectGroup, CodingCliSession } from '@/store/types'

import {
  buildSessionItems,
  filterSessionItemsByVisibility,
  makeSelectSortedSessionItems,
  sortSessionItems,
} from '@/store/selectors/sidebarSelectors'

// Helper to create test session items
function createSessionItem(overrides: Partial<SidebarSessionItem>): SidebarSessionItem {
  return {
    id: 'session-claude-test',
    sessionId: 'test',
    provider: 'claude',
    sessionType: 'claude',
    title: 'Test Session',
    hasTitle: true,
    timestamp: 1000,
    hasTab: false,
    isRunning: false,
    ...overrides,
  }
}

function createFallbackTab(
  tabId: string,
  sessionId: string,
  title: string,
  cwd: string,
  mode: 'claude' | 'codex' = 'codex',
) {
  const paneId = `pane-${tabId}`
  const sessionRef = {
    provider: mode,
    sessionId,
  }
  return {
    tab: { id: tabId, title, mode, resumeSessionId: sessionId, sessionRef, createdAt: 1_000 },
    paneId,
    layout: {
      type: 'leaf',
      id: paneId,
      content: {
        kind: 'terminal',
        mode,
        status: 'running',
        createRequestId: `req-${tabId}`,
        resumeSessionId: sessionId,
        sessionRef,
        initialCwd: cwd,
      },
    },
  }
}

function createSelectorState(options: {
  projects?: ProjectGroup[]
  tabs?: any[]
  panes?: any
  sortMode?: 'recency' | 'activity' | 'recency-pinned' | 'project'
  query?: string
  searchTier?: 'title' | 'userMessages' | 'fullText'
  appliedQuery?: string
  appliedSearchTier?: 'title' | 'userMessages' | 'fullText'
  sessionActivity?: Record<string, number>
} = {}) {
  const projects = options.projects ?? []
  return {
    sessions: {
      projects,
      windows: {
        sidebar: {
          projects,
          query: options.query ?? '',
          searchTier: options.searchTier ?? 'title',
          appliedQuery: options.appliedQuery,
          appliedSearchTier: options.appliedSearchTier,
        },
      },
    },
    tabs: {
      tabs: options.tabs ?? [],
    },
    panes: options.panes ?? {
      layouts: {},
      activePane: {},
      paneTitles: {},
    },
    settings: {
      settings: {
        sidebar: {
          sortMode: options.sortMode ?? 'activity',
          showSubagents: true,
          ignoreCodexSubagents: false,
          showNoninteractiveSessions: true,
          hideEmptySessions: false,
          excludeFirstChatSubstrings: [],
          excludeFirstChatMustStart: false,
        },
      },
    },
    sessionActivity: {
      sessions: options.sessionActivity ?? {},
    },
  } as any
}

describe('sidebarSelectors', () => {
  describe('buildSessionItems', () => {
    const emptyTabs: [] = []
    const emptyPanes = { layouts: {} } as any
    const emptyTerminals: [] = []
    const emptyActivity: Record<string, number> = {}

    function makeProject(sessions: Partial<CodingCliSession>[], projectPath = '/test/project', color?: string): ProjectGroup {
      return {
        projectPath,
        color,
        sessions: sessions.map((s) => ({
          provider: 'claude' as const,
          sessionId: 'sess-1',
          projectPath,
          lastActivityAt: 1000,
          ...s,
        })),
      }
    }

    it('defaults sessionType to provider when not set on session', () => {
      const projects = [
        makeProject([{ sessionId: 'sess-1', provider: 'claude' }]),
      ]

      const items = buildSessionItems(projects, emptyTabs, emptyPanes, emptyTerminals, emptyActivity)

      expect(items).toHaveLength(1)
      expect(items[0].sessionType).toBe('claude')
    })

    it('defaults sessionType to provider for codex sessions', () => {
      const projects = [
        makeProject([{ sessionId: 'sess-2', provider: 'codex' }]),
      ]

      const items = buildSessionItems(projects, emptyTabs, emptyPanes, emptyTerminals, emptyActivity)

      expect(items).toHaveLength(1)
      expect(items[0].sessionType).toBe('codex')
    })

    it('uses explicit sessionType when set on session', () => {
      const projects = [
        makeProject([{ sessionId: 'sess-3', provider: 'claude', sessionType: 'custom-agent' }]),
      ]

      const items = buildSessionItems(projects, emptyTabs, emptyPanes, emptyTerminals, emptyActivity)

      expect(items).toHaveLength(1)
      expect(items[0].sessionType).toBe('custom-agent')
    })

    it('propagates sessionType for multiple sessions in a project', () => {
      const projects = [
        makeProject([
          { sessionId: 'sess-a', provider: 'claude' },
          { sessionId: 'sess-b', provider: 'claude', sessionType: 'agent-chat' },
        ]),
      ]

      const items = buildSessionItems(projects, emptyTabs, emptyPanes, emptyTerminals, emptyActivity)

      expect(items).toHaveLength(2)
      expect(items[0].sessionType).toBe('claude')
      expect(items[1].sessionType).toBe('agent-chat')
    })

    it('keeps hasTab correct for layout-backed and no-layout fallback sessions', () => {
      const validClaudeSessionId = '550e8400-e29b-41d4-a716-446655440000'
      const invalidClaudeSessionId = 'not-a-uuid'
      const projects = [
        makeProject([
          { sessionId: 'codex-layout', provider: 'codex' },
          { sessionId: 'codex-no-layout', provider: 'codex' },
          { sessionId: validClaudeSessionId, provider: 'claude' },
          { sessionId: invalidClaudeSessionId, provider: 'claude' },
        ]),
      ]

      const tabs = [
        { id: 'tab-layout' },
        {
          id: 'tab-no-layout',
          mode: 'codex',
          resumeSessionId: 'codex-no-layout',
          sessionRef: {
            provider: 'codex',
            sessionId: 'codex-no-layout',
          },
        },
        { id: 'tab-invalid', mode: 'claude', resumeSessionId: invalidClaudeSessionId },
      ] as any

      const panes = {
        layouts: {
          'tab-layout': {
            type: 'split',
            id: 'split-1',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [
              {
                type: 'leaf',
                id: 'pane-codex',
                content: {
                  kind: 'terminal',
                  mode: 'codex',
                  status: 'running',
                  createRequestId: 'req-codex',
                  resumeSessionId: 'codex-layout',
                  sessionRef: {
                    provider: 'codex',
                    sessionId: 'codex-layout',
                  },
                },
              },
              {
                type: 'leaf',
                id: 'pane-claude',
                content: {
                  kind: 'agent-chat',
                  provider: 'freshclaude',
                  status: 'idle',
                  createRequestId: 'req-claude',
                  resumeSessionId: validClaudeSessionId,
                  sessionRef: {
                    provider: 'claude',
                    sessionId: validClaudeSessionId,
                  },
                },
              },
            ],
          },
          'tab-invalid': {
            type: 'leaf',
            id: 'pane-invalid',
            content: {
              kind: 'terminal',
              mode: 'claude',
              status: 'running',
              createRequestId: 'req-invalid',
              resumeSessionId: invalidClaudeSessionId,
            },
          },
        },
        activePane: {},
      } as any

      const items = buildSessionItems(projects, tabs, panes, emptyTerminals, emptyActivity)
      const hasTabBySessionId = new Map(items.map((item) => [item.sessionId, item.hasTab]))

      expect(hasTabBySessionId.get('codex-layout')).toBe(true)
      expect(hasTabBySessionId.get('codex-no-layout')).toBe(true)
      expect(hasTabBySessionId.get(validClaudeSessionId)).toBe(true)
      expect(hasTabBySessionId.get(invalidClaudeSessionId)).toBe(false)
    })

    it('does not create a fallback sidebar item for a Claude pane with a human-readable resume name', () => {
      const tabs = [
        { id: 'tab-named', title: 'Named Resume Session', mode: 'claude', createdAt: 3_000 },
      ] as any

      const panes = {
        layouts: {
          'tab-named': {
            type: 'leaf',
            id: 'pane-named',
            content: {
              kind: 'terminal',
              mode: 'claude',
              status: 'running',
              createRequestId: 'req-named',
              resumeSessionId: '137 tour',
            },
          },
        },
        activePane: {
          'tab-named': 'pane-named',
        },
        paneTitles: {
          'tab-named': {
            'pane-named': 'Named Resume Session',
          },
        },
      } as any

      const items = buildSessionItems([], tabs, panes, emptyTerminals, emptyActivity)

      expect(items).toEqual([])
    })

    it('does not create fallback item for Claude session with special character resume name', () => {
      const tabs = [
        { id: 'tab-special', title: 'Special Name Session', mode: 'claude', createdAt: 3_000 },
      ] as any

      const panes = {
        layouts: {
          'tab-special': {
            type: 'leaf',
            id: 'pane-special',
            content: {
              kind: 'terminal',
              mode: 'claude',
              status: 'running',
              createRequestId: 'req-special',
              resumeSessionId: "fix: can't parse (issue #42)",
            },
          },
        },
        activePane: {},
        paneTitles: {},
      } as any

      const items = buildSessionItems([], tabs, panes, emptyTerminals, emptyActivity)

      expect(items).toEqual([])
    })

    it('synthesizes a local fallback row for restored open sessions that are not in the current server window', () => {
      const fallbackSessionId = 'codex-restored'
      const tabs = [
        {
          id: 'tab-restored',
          title: 'Restored Session',
          mode: 'codex',
          resumeSessionId: fallbackSessionId,
          sessionRef: {
            provider: 'codex',
            sessionId: fallbackSessionId,
          },
          createdAt: 2_000,
        },
      ] as any

      const panes = {
        layouts: {
          'tab-restored': {
            type: 'leaf',
            id: 'pane-restored',
            content: {
              kind: 'terminal',
              mode: 'codex',
              status: 'running',
              createRequestId: 'req-restored',
              resumeSessionId: fallbackSessionId,
              sessionRef: {
                provider: 'codex',
                sessionId: fallbackSessionId,
              },
              initialCwd: '/tmp/restored-project',
            },
          },
        },
        activePane: {
          'tab-restored': 'pane-restored',
        },
        paneTitles: {
          'tab-restored': {
            'pane-restored': 'Restored Session',
          },
        },
      } as any

      const items = buildSessionItems([], tabs, panes, emptyTerminals, emptyActivity)

      expect(items).toEqual([
        expect.objectContaining({
          sessionId: fallbackSessionId,
          provider: 'codex',
          sessionType: 'codex',
          title: 'Restored Session',
          hasTab: true,
          hasTitle: true,
          cwd: '/tmp/restored-project',
          isFallback: true,
        }),
      ])
    })

    it('marks synthesized rows as fallback-only while leaving server-backed rows unmarked', () => {
      const fallback = createFallbackTab('tab-restored', 'codex-restored', 'Restored Session', '/tmp/restored-project')
      const items = buildSessionItems(
        [
          makeProject([{ sessionId: 'server-session', provider: 'claude', title: 'Server Session' }]),
        ],
        [fallback.tab] as any,
        {
          layouts: {
            [fallback.tab.id]: fallback.layout,
          },
          activePane: {
            [fallback.tab.id]: fallback.paneId,
          },
          paneTitles: {
            [fallback.tab.id]: {
              [fallback.paneId]: fallback.tab.title,
            },
          },
        } as any,
        emptyTerminals,
        emptyActivity,
      )

      expect(items.find((item) => item.sessionId === 'server-session')?.isFallback).toBeUndefined()
      expect(items.find((item) => item.sessionId === 'codex-restored')).toMatchObject({
        isFallback: true,
      })
    })

    it('preserves fallback visibility metadata from tab session metadata so hidden sessions stay filtered', () => {
      const hiddenSessionId = 'codex-hidden'
      const tabs = [
        {
          id: 'tab-hidden',
          title: 'Hidden Session',
          mode: 'codex',
          resumeSessionId: hiddenSessionId,
          sessionRef: {
            provider: 'codex',
            sessionId: hiddenSessionId,
          },
          createdAt: 2_000,
          sessionMetadataByKey: {
            'codex:codex-hidden': {
              sessionType: 'codex',
              firstUserMessage: 'IMPORTANT: internal trycycle task',
              isSubagent: true,
              isNonInteractive: true,
            },
          },
        },
      ] as any

      const panes = {
        layouts: {
          'tab-hidden': {
            type: 'leaf',
            id: 'pane-hidden',
            content: {
              kind: 'terminal',
              mode: 'codex',
              status: 'running',
              createRequestId: 'req-hidden',
              resumeSessionId: hiddenSessionId,
              sessionRef: {
                provider: 'codex',
                sessionId: hiddenSessionId,
              },
              initialCwd: '/tmp/hidden-project',
            },
          },
        },
        activePane: {
          'tab-hidden': 'pane-hidden',
        },
        paneTitles: {
          'tab-hidden': {
            'pane-hidden': 'Hidden Session',
          },
        },
      } as any

      const items = buildSessionItems([], tabs, panes, emptyTerminals, emptyActivity)

      expect(items).toEqual([
        expect.objectContaining({
          sessionId: hiddenSessionId,
          sessionType: 'codex',
          isSubagent: true,
          isNonInteractive: true,
          firstUserMessage: 'IMPORTANT: internal trycycle task',
        }),
      ])

      expect(filterSessionItemsByVisibility(items, {
        showSubagents: false,
        ignoreCodexSubagents: true,
        showNoninteractiveSessions: false,
        hideEmptySessions: true,
        excludeFirstChatSubstrings: ['IMPORTANT:'],
        excludeFirstChatMustStart: true,
      })).toEqual([])
    })

    it('merges open-tab fallback data into a matching server-backed titleless session', () => {
      const sessionId = 'claude-current'
      const items = buildSessionItems(
        [makeProject([{ provider: 'claude', sessionId, title: undefined, lastActivityAt: 10 }])],
        [{
          id: 'tab-1',
          title: 'Current Session',
          mode: 'claude',
          resumeSessionId: sessionId,
          sessionRef: {
            provider: 'claude',
            sessionId,
          },
          createdAt: 20_000,
          sessionMetadataByKey: {
            'claude:claude-current': {
              sessionType: 'freshclaude',
              firstUserMessage: 'IMPORTANT: internal trycycle task',
              isSubagent: true,
              isNonInteractive: true,
            },
          },
        }] as any,
        {
          layouts: {
            'tab-1': {
              type: 'leaf',
              id: 'pane-1',
              content: {
                kind: 'terminal',
                mode: 'claude',
                status: 'running',
                createRequestId: 'req-1',
                resumeSessionId: sessionId,
                sessionRef: {
                  provider: 'claude',
                  sessionId,
                },
                initialCwd: '/repo',
              },
            },
          },
          activePane: { 'tab-1': 'pane-1' },
          paneTitles: { 'tab-1': { 'pane-1': 'Current Session' } },
        } as any,
        emptyTerminals,
        emptyActivity,
      )

      expect(items).toEqual([
        expect.objectContaining({
          sessionId,
          provider: 'claude',
          title: 'Current Session',
          hasTitle: true,
          hasTab: true,
          sessionType: 'freshclaude',
          firstUserMessage: 'IMPORTANT: internal trycycle task',
          isSubagent: true,
          isNonInteractive: true,
          isFallback: undefined,
        }),
      ])
    })
  })

  describe('worktree grouping', () => {
    const emptyTabs: [] = []
    const emptyPanes = { layouts: {} } as any
    const emptyTerminals: [] = []
    const emptyActivity: Record<string, number> = {}

    function makeProject(sessions: Partial<CodingCliSession>[], projectPath = '/test/repo', color?: string): ProjectGroup {
      return {
        projectPath,
        color,
        sessions: sessions.map((s) => ({
          provider: 'claude' as const,
          sessionId: 'sess-1',
          projectPath,
          lastActivityAt: 1000,
          ...s,
        })),
      }
    }

    it('uses projectPath for subtitle in repo mode (default)', () => {
      const projects = [
        makeProject([
          { sessionId: 'wt-1', checkoutPath: '/test/repo/.worktrees/feature-a' },
          { sessionId: 'wt-2' },
        ], '/test/repo'),
      ]

      const items = buildSessionItems(projects, emptyTabs, emptyPanes, emptyTerminals, emptyActivity)

      expect(items[0].subtitle).toBe('repo')
      expect(items[0].projectPath).toBe('/test/repo')
      expect(items[1].subtitle).toBe('repo')
      expect(items[1].projectPath).toBe('/test/repo')
    })

    it('uses checkoutPath for subtitle in worktree mode', () => {
      const projects = [
        makeProject([
          { sessionId: 'wt-1', checkoutPath: '/test/repo/.worktrees/feature-a' },
          { sessionId: 'wt-2' },
        ], '/test/repo'),
      ]

      const items = buildSessionItems(projects, emptyTabs, emptyPanes, emptyTerminals, emptyActivity, 'worktree')

      expect(items[0].subtitle).toBe('feature-a')
      expect(items[0].projectPath).toBe('/test/repo/.worktrees/feature-a')
      expect(items[1].subtitle).toBe('repo')
      expect(items[1].projectPath).toBe('/test/repo')
    })

    it('falls back to projectPath when session has no checkoutPath in worktree mode', () => {
      const projects = [
        makeProject([{ sessionId: 'no-wt' }], '/test/repo'),
      ]

      const items = buildSessionItems(projects, emptyTabs, emptyPanes, emptyTerminals, emptyActivity, 'worktree')

      expect(items[0].subtitle).toBe('repo')
      expect(items[0].projectPath).toBe('/test/repo')
    })
  })


  describe('makeSelectSortedSessionItems', () => {
    it('uses the applied title query to keep only matching fallback rows and rejects ancestor-only matches', () => {
      const matchingFallback = createFallbackTab('tab-match', 'fallback-match', 'Matching Fallback', '/tmp/local/trycycle')
      const ancestorFallback = createFallbackTab('tab-ancestor', 'fallback-ancestor', 'Ancestor Fallback', '/tmp/code/local/project')
      const unrelatedFallback = createFallbackTab('tab-unrelated', 'fallback-unrelated', 'Unrelated Fallback', '/tmp/local/elsewhere')
      const selectSortedItems = makeSelectSortedSessionItems()

      const items = selectSortedItems(createSelectorState({
        projects: [
          {
            projectPath: '/repo/server',
            sessions: [{
              provider: 'claude',
              sessionId: 'server-newer',
              projectPath: '/repo/server',
              lastActivityAt: 3_000,
              title: 'Newer Server Result',
            }],
          },
          {
            projectPath: '/repo/code/trycycle',
            sessions: [{
              provider: 'claude',
              sessionId: 'server-leaf',
              projectPath: '/repo/code/trycycle',
              cwd: '/repo/code/trycycle/server',
              lastActivityAt: 2_500,
              title: 'Routine work',
            }],
          },
        ],
        tabs: [matchingFallback.tab, ancestorFallback.tab, unrelatedFallback.tab],
        panes: {
          layouts: {
            [matchingFallback.tab.id]: matchingFallback.layout,
            [ancestorFallback.tab.id]: ancestorFallback.layout,
            [unrelatedFallback.tab.id]: unrelatedFallback.layout,
          },
          activePane: {
            [matchingFallback.tab.id]: matchingFallback.paneId,
            [ancestorFallback.tab.id]: ancestorFallback.paneId,
            [unrelatedFallback.tab.id]: unrelatedFallback.paneId,
          },
          paneTitles: {
            [matchingFallback.tab.id]: { [matchingFallback.paneId]: matchingFallback.tab.title },
            [ancestorFallback.tab.id]: { [ancestorFallback.paneId]: ancestorFallback.tab.title },
            [unrelatedFallback.tab.id]: { [unrelatedFallback.paneId]: unrelatedFallback.tab.title },
          },
        },
        sortMode: 'activity',
        query: 'code',
        searchTier: 'title',
        appliedQuery: 'trycycle',
        appliedSearchTier: 'title',
      }), [], '')

      expect(items.map((item) => item.sessionId)).toEqual([
        'server-newer',
        'server-leaf',
        'fallback-match',
      ])
      expect(items.find((item) => item.sessionId === 'fallback-match')).toMatchObject({
        isFallback: true,
      })
      expect(items.some((item) => item.sessionId === 'fallback-ancestor')).toBe(false)
      expect(items.some((item) => item.sessionId === 'fallback-unrelated')).toBe(false)
    })

    it('drops fallback rows entirely for applied deep-search tiers', () => {
      const matchingFallback = createFallbackTab('tab-match', 'fallback-match', 'Matching Fallback', '/tmp/local/trycycle')
      const selectSortedItems = makeSelectSortedSessionItems()

      const items = selectSortedItems(createSelectorState({
        projects: [{
          projectPath: '/repo/server',
          sessions: [{
            provider: 'claude',
            sessionId: 'server-deep',
            projectPath: '/repo/server',
            lastActivityAt: 3_000,
            title: 'Deep Search Result',
          }],
        }],
        tabs: [matchingFallback.tab],
        panes: {
          layouts: {
            [matchingFallback.tab.id]: matchingFallback.layout,
          },
          activePane: {
            [matchingFallback.tab.id]: matchingFallback.paneId,
          },
          paneTitles: {
            [matchingFallback.tab.id]: { [matchingFallback.paneId]: matchingFallback.tab.title },
          },
        },
        appliedQuery: 'trycycle',
        appliedSearchTier: 'fullText',
      }), [], '')

      expect(items.map((item) => item.sessionId)).toEqual(['server-deep'])
    })

    it('disables tab pinning during applied search in recency-pinned mode while preserving archived-last ordering', () => {
      const matchingFallback = createFallbackTab('tab-match', 'fallback-match', 'Matching Fallback', '/tmp/local/trycycle')
      const selectSortedItems = makeSelectSortedSessionItems()
      const baseOptions = {
        projects: [
          {
            projectPath: '/repo/server',
            sessions: [{
              provider: 'claude',
              sessionId: 'server-newer',
              projectPath: '/repo/server',
              lastActivityAt: 3_000,
              title: 'Newer Server Result',
            }],
          },
          {
            projectPath: '/repo/archive',
            sessions: [{
              provider: 'claude',
              sessionId: 'server-archived',
              projectPath: '/repo/archive',
              lastActivityAt: 4_000,
              title: 'Archived Result',
              archived: true,
            }],
          },
        ],
        tabs: [matchingFallback.tab],
        panes: {
          layouts: {
            [matchingFallback.tab.id]: matchingFallback.layout,
          },
          activePane: {
            [matchingFallback.tab.id]: matchingFallback.paneId,
          },
          paneTitles: {
            [matchingFallback.tab.id]: { [matchingFallback.paneId]: matchingFallback.tab.title },
          },
        },
        sortMode: 'recency-pinned' as const,
      }

      const searchItems = selectSortedItems(createSelectorState({
        ...baseOptions,
        appliedQuery: 'trycycle',
        appliedSearchTier: 'title',
      }), [], '')

      expect(searchItems.map((item) => item.sessionId)).toEqual([
        'server-newer',
        'fallback-match',
        'server-archived',
      ])

      const browseItems = selectSortedItems(createSelectorState({
        ...baseOptions,
        query: 'trycycle',
        searchTier: 'title',
      }), [], '')

      expect(browseItems.map((item) => item.sessionId)).toEqual([
        'fallback-match',
        'server-newer',
        'server-archived',
      ])
    })
  })

  describe('sortSessionItems', () => {
    describe('recency mode', () => {
      it('sorts by timestamp descending', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 1000 }),
          createSessionItem({ id: '2', timestamp: 3000 }),
          createSessionItem({ id: '3', timestamp: 2000 }),
        ]

        const sorted = sortSessionItems(items, 'recency')

        expect(sorted.map((i) => i.id)).toEqual(['2', '3', '1'])
      })

      it('does not prioritize sessions with tabs', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 3000, hasTab: false }),
          createSessionItem({ id: '2', timestamp: 1000, hasTab: true }),
          createSessionItem({ id: '3', timestamp: 2000, hasTab: false }),
        ]

        const sorted = sortSessionItems(items, 'recency')

        // Should be purely by timestamp, not considering hasTab
        expect(sorted.map((i) => i.id)).toEqual(['1', '3', '2'])
      })
    })

    describe('recency-pinned mode', () => {
      it('pins sessions with tabs to the top', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 3000, hasTab: false }),
          createSessionItem({ id: '2', timestamp: 1000, hasTab: true }),
          createSessionItem({ id: '3', timestamp: 2000, hasTab: false }),
        ]

        const sorted = sortSessionItems(items, 'recency-pinned')

        // Session 2 (with tab) should be first, then others by recency
        expect(sorted.map((i) => i.id)).toEqual(['2', '1', '3'])
      })

      it('sorts pinned sessions by timestamp among themselves', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 1000, hasTab: true }),
          createSessionItem({ id: '2', timestamp: 3000, hasTab: true }),
          createSessionItem({ id: '3', timestamp: 2000, hasTab: false }),
        ]

        const sorted = sortSessionItems(items, 'recency-pinned')

        // Both pinned sessions first (by recency), then unpinned
        expect(sorted.map((i) => i.id)).toEqual(['2', '1', '3'])
      })

      it('sorts unpinned sessions by timestamp', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 1000, hasTab: false }),
          createSessionItem({ id: '2', timestamp: 3000, hasTab: false }),
          createSessionItem({ id: '3', timestamp: 2000, hasTab: true }),
        ]

        const sorted = sortSessionItems(items, 'recency-pinned')

        // Pinned first, then unpinned by recency
        expect(sorted.map((i) => i.id)).toEqual(['3', '2', '1'])
      })

      it('handles empty list', () => {
        const sorted = sortSessionItems([], 'recency-pinned')
        expect(sorted).toEqual([])
      })

      it('handles all pinned', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 1000, hasTab: true }),
          createSessionItem({ id: '2', timestamp: 2000, hasTab: true }),
        ]

        const sorted = sortSessionItems(items, 'recency-pinned')

        expect(sorted.map((i) => i.id)).toEqual(['2', '1'])
      })

      it('handles all unpinned (same as recency)', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 1000, hasTab: false }),
          createSessionItem({ id: '2', timestamp: 2000, hasTab: false }),
        ]

        const sorted = sortSessionItems(items, 'recency-pinned')

        expect(sorted.map((i) => i.id)).toEqual(['2', '1'])
      })

      it('keeps archived sessions at the bottom', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 3000, hasTab: false, archived: true }),
          createSessionItem({ id: '2', timestamp: 1000, hasTab: true }),
          createSessionItem({ id: '3', timestamp: 2000, hasTab: false }),
        ]

        const sorted = sortSessionItems(items, 'recency-pinned')

        // Active sessions first (pinned, then by recency), archived last
        expect(sorted.map((i) => i.id)).toEqual(['2', '3', '1'])
      })

      it('sorts archived sessions with same pinned logic', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 3000, hasTab: false, archived: true }),
          createSessionItem({ id: '2', timestamp: 1000, hasTab: true, archived: true }),
          createSessionItem({ id: '3', timestamp: 2000, hasTab: false }),
        ]

        const sorted = sortSessionItems(items, 'recency-pinned')

        // Active first (unpinned), then archived (pinned first within archived)
        expect(sorted.map((i) => i.id)).toEqual(['3', '2', '1'])
      })

      it('can disable tab pinning while keeping archived items last', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 3000, hasTab: false }),
          createSessionItem({ id: '2', timestamp: 1000, hasTab: true }),
          createSessionItem({ id: '3', timestamp: 4000, hasTab: true, archived: true }),
        ]

        const sorted = sortSessionItems(items, 'recency-pinned', { disableTabPinning: true })

        expect(sorted.map((i) => i.id)).toEqual(['1', '2', '3'])
      })
    })

    describe('activity mode', () => {
      it('pins sessions with tabs to the top', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 3000, hasTab: false }),
          createSessionItem({ id: '2', timestamp: 1000, hasTab: true }),
        ]

        const sorted = sortSessionItems(items, 'activity')

        expect(sorted.map((i) => i.id)).toEqual(['2', '1'])
      })

      it('sorts pinned sessions by ratchetedActivity', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 1000, hasTab: true, ratchetedActivity: 5000 }),
          createSessionItem({ id: '2', timestamp: 3000, hasTab: true, ratchetedActivity: 1000 }),
        ]

        const sorted = sortSessionItems(items, 'activity')

        expect(sorted.map((i) => i.id)).toEqual(['1', '2'])
      })

      it('can disable tab pinning and use the normal activity comparator for every item', () => {
        const items = [
          createSessionItem({ id: '1', timestamp: 3000, hasTab: false }),
          createSessionItem({ id: '2', timestamp: 1000, hasTab: true }),
          createSessionItem({ id: '3', timestamp: 4000, hasTab: true, archived: true }),
        ]

        const sorted = sortSessionItems(items, 'activity', { disableTabPinning: true })

        expect(sorted.map((i) => i.id)).toEqual(['1', '2', '3'])
      })
    })

    describe('project mode', () => {
      it('sorts by project path alphabetically', () => {
        const items = [
          createSessionItem({ id: '1', projectPath: '/z/project', timestamp: 3000 }),
          createSessionItem({ id: '2', projectPath: '/a/project', timestamp: 1000 }),
        ]

        const sorted = sortSessionItems(items, 'project')

        expect(sorted.map((i) => i.id)).toEqual(['2', '1'])
      })
    })
  })
})
