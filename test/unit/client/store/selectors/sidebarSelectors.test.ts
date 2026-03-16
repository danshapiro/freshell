import { describe, it, expect } from 'vitest'
import type { SidebarSessionItem } from '@/store/selectors/sidebarSelectors'

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

// Import the sort function and buildSessionItems for testing
import { sortSessionItems, buildSessionItems, filterSessionItemsByVisibility } from '@/store/selectors/sidebarSelectors'
import type { CodingCliSession, ProjectGroup } from '@/store/types'

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
        { id: 'tab-no-layout', mode: 'codex', resumeSessionId: 'codex-no-layout' },
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
                    serverInstanceId: 'srv-local',
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
                    serverInstanceId: 'srv-local',
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
      expect(hasTabBySessionId.get(invalidClaudeSessionId)).toBe(true)
    })

    it('creates a fallback sidebar item for a Claude pane with a human-readable resume name', () => {
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

      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({
        sessionId: '137 tour',
        provider: 'claude',
        title: 'Named Resume Session',
        hasTab: true,
      })
    })

    it('synthesizes a local fallback row for restored open sessions that are not in the current server window', () => {
      const fallbackSessionId = 'codex-restored'
      const tabs = [
        { id: 'tab-restored', title: 'Restored Session', mode: 'codex', resumeSessionId: fallbackSessionId, createdAt: 2_000 },
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
        }),
      ])
    })

    it('preserves fallback visibility metadata from tab session metadata so hidden sessions stay filtered', () => {
      const hiddenSessionId = 'codex-hidden'
      const tabs = [
        {
          id: 'tab-hidden',
          title: 'Hidden Session',
          mode: 'codex',
          resumeSessionId: hiddenSessionId,
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
