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
import { sortSessionItems, buildSessionItems } from '@/store/selectors/sidebarSelectors'
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
          updatedAt: 1000,
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
