import { describe, it, expect } from 'vitest'
import { filterSessionItemsByVisibility } from '@/store/selectors/sidebarSelectors'
import type { SidebarSessionItem } from '@/store/selectors/sidebarSelectors'

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

describe('filterSessionItemsByVisibility', () => {
  const baseSettings = {
    excludeFirstChatSubstrings: [],
    excludeFirstChatMustStart: false,
    hideEmptySessions: false,
  }

  describe('subagent filtering', () => {
    it('hides subagent sessions when showSubagents is false', () => {
      const items = [
        createSessionItem({ id: '1', isSubagent: true }),
        createSessionItem({ id: '2' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: false,
        showNoninteractiveSessions: true,
        ...baseSettings,
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
        ...baseSettings,
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
        ...baseSettings,
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
        ...baseSettings,
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
        ...baseSettings,
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
        ...baseSettings,
      })

      expect(result.map((i) => i.id)).toEqual(['1', '2', '3'])
    })
  })

  describe('subagent filtering treats all providers equally', () => {
    it('shows subagents from all providers when showSubagents is true', () => {
      const items = [
        createSessionItem({ id: '1', provider: 'codex', isSubagent: true }),
        createSessionItem({ id: '2', provider: 'claude', isSubagent: true }),
        createSessionItem({ id: '3', provider: 'claude' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: true,
        showNoninteractiveSessions: true,
        ...baseSettings,
      })

      expect(result.map((i) => i.id)).toEqual(['1', '2', '3'])
    })

    it('hides subagents from all providers when showSubagents is false', () => {
      const items = [
        createSessionItem({ id: '1', provider: 'codex', isSubagent: true }),
        createSessionItem({ id: '2', provider: 'claude', isSubagent: true }),
        createSessionItem({ id: '3', provider: 'claude' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: false,
        showNoninteractiveSessions: true,
        ...baseSettings,
      })

      expect(result.map((i) => i.id)).toEqual(['3'])
    })
  })

  describe('first chat substring filtering', () => {
    it('hides sessions when first chat contains any configured substring', () => {
      const items = [
        createSessionItem({ id: '1', firstUserMessage: '__AUTO__ generate report please' }),
        createSessionItem({ id: '2', firstUserMessage: 'normal prompt' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: true,
        showNoninteractiveSessions: true,
        excludeFirstChatSubstrings: ['__AUTO__'],
        excludeFirstChatMustStart: false,
      })

      expect(result.map((i) => i.id)).toEqual(['2'])
    })

    it('does not match exclusion substrings with different case', () => {
      const items = [
        createSessionItem({ id: '1', firstUserMessage: '__AUTO__ generate report please' }),
        createSessionItem({ id: '2', firstUserMessage: 'normal prompt' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: true,
        showNoninteractiveSessions: true,
        excludeFirstChatSubstrings: ['__auto__'],
        excludeFirstChatMustStart: false,
      })

      expect(result.map((i) => i.id)).toEqual(['1', '2'])
    })

    it('requires prefix match when excludeFirstChatMustStart is true', () => {
      const items = [
        createSessionItem({ id: '1', firstUserMessage: '__AUTO__ generate report' }),
        createSessionItem({ id: '2', firstUserMessage: 'please run __AUTO__ helper' }),
        createSessionItem({ id: '3', firstUserMessage: 'normal prompt' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: true,
        showNoninteractiveSessions: true,
        excludeFirstChatSubstrings: ['__AUTO__'],
        excludeFirstChatMustStart: true,
      })

      expect(result.map((i) => i.id)).toEqual(['2', '3'])
    })

    it('does not match prefix with different case', () => {
      const items = [
        createSessionItem({ id: '1', firstUserMessage: '__AUTO__ generate report' }),
        createSessionItem({ id: '2', firstUserMessage: 'please run __AUTO__ helper' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        showSubagents: true,
        showNoninteractiveSessions: true,
        excludeFirstChatSubstrings: ['__auto__'],
        excludeFirstChatMustStart: true,
      })

      expect(result.map((i) => i.id)).toEqual(['1', '2'])
    })
  })

  describe('empty session filtering', () => {
    it('hides sessions without a title when hideEmptySessions is true', () => {
      const items = [
        createSessionItem({ id: '1', title: 'a7f3b2c1', hasTitle: false }),
        createSessionItem({ id: '2', title: 'Real conversation', hasTitle: true }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        ...baseSettings,
        showSubagents: true,
        showNoninteractiveSessions: true,
        hideEmptySessions: true,
      })

      expect(result.map((i) => i.id)).toEqual(['2'])
    })

    it('shows empty sessions when hideEmptySessions is false', () => {
      const items = [
        createSessionItem({ id: '1', title: 'a7f3b2c1', hasTitle: false }),
        createSessionItem({ id: '2', title: 'Real conversation', hasTitle: true }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        ...baseSettings,
        showSubagents: true,
        showNoninteractiveSessions: true,
        hideEmptySessions: false,
      })

      expect(result.map((i) => i.id)).toEqual(['1', '2'])
    })

    it('hides sessions with system-only firstUserMessage and no title', () => {
      const items = [
        createSessionItem({
          id: '1',
          title: '63f567a2',
          hasTitle: false,
          firstUserMessage: '<local-command-caveat>system content</local-command-caveat>',
        }),
        createSessionItem({ id: '2', title: 'Real session', hasTitle: true, firstUserMessage: 'Hello' }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        ...baseSettings,
        showSubagents: true,
        showNoninteractiveSessions: true,
        hideEmptySessions: true,
      })

      expect(result.map((i) => i.id)).toEqual(['2'])
    })

    it('keeps sessions with a real title even without firstUserMessage', () => {
      const items = [
        createSessionItem({ id: '1', title: 'Manually titled', hasTitle: true, firstUserMessage: undefined }),
        createSessionItem({ id: '2', title: 'deadbeef', hasTitle: false, firstUserMessage: undefined }),
      ]

      const result = filterSessionItemsByVisibility(items, {
        ...baseSettings,
        showSubagents: true,
        showNoninteractiveSessions: true,
        hideEmptySessions: true,
      })

      expect(result.map((i) => i.id)).toEqual(['1'])
    })
  })
})
