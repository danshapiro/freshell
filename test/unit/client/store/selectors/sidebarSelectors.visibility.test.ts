import { describe, it, expect } from 'vitest'
import { filterSessionItemsByVisibility } from '@/store/selectors/sidebarSelectors'
import type { SidebarSessionItem } from '@/store/selectors/sidebarSelectors'

function createSessionItem(overrides: Partial<SidebarSessionItem>): SidebarSessionItem {
  return {
    id: 'session-claude-test',
    sessionId: 'test',
    provider: 'claude',
    title: 'Test Session',
    timestamp: 1000,
    hasTab: false,
    isRunning: false,
    ...overrides,
  }
}

describe('filterSessionItemsByVisibility', () => {
  describe('subagent filtering', () => {
    it('hides subagent sessions when showSubagents is false', () => {
      const items = [
        createSessionItem({ id: '1', isSubagent: true }),
        createSessionItem({ id: '2' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: false,
        showNoninteractiveSessions: true,
      })

      expect(result.map((i) => i.id)).toEqual(['2'])
    })

    it('shows subagent sessions when showSubagents is true', () => {
      const items = [
        createSessionItem({ id: '1', isSubagent: true }),
        createSessionItem({ id: '2' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: true,
        showNoninteractiveSessions: true,
      })

      expect(result.map((i) => i.id)).toEqual(['1', '2'])
    })
  })

  describe('non-interactive filtering', () => {
    it('hides non-interactive sessions when showNoninteractiveSessions is false', () => {
      const items = [
        createSessionItem({ id: '1', isNonInteractive: true }),
        createSessionItem({ id: '2' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: true,
        showNoninteractiveSessions: false,
      })

      expect(result.map((i) => i.id)).toEqual(['2'])
    })

    it('shows non-interactive sessions when showNoninteractiveSessions is true', () => {
      const items = [
        createSessionItem({ id: '1', isNonInteractive: true }),
        createSessionItem({ id: '2' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: true,
        showNoninteractiveSessions: true,
      })

      expect(result.map((i) => i.id)).toEqual(['1', '2'])
    })
  })

  describe('combined filtering', () => {
    it('hides both subagent and non-interactive when both settings are false', () => {
      const items = [
        createSessionItem({ id: '1', isSubagent: true }),
        createSessionItem({ id: '2', isNonInteractive: true }),
        createSessionItem({ id: '3' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: false,
        showNoninteractiveSessions: false,
      })

      expect(result.map((i) => i.id)).toEqual(['3'])
    })

    it('shows all when both settings are true', () => {
      const items = [
        createSessionItem({ id: '1', isSubagent: true }),
        createSessionItem({ id: '2', isNonInteractive: true }),
        createSessionItem({ id: '3' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: true,
        showNoninteractiveSessions: true,
      })

      expect(result.map((i) => i.id)).toEqual(['1', '2', '3'])
    })
  })
})
