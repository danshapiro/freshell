import { describe, it, expect } from 'vitest'
import { areTerminalsEqual, areSessionItemsEqual } from '@/components/Sidebar'
import type { BackgroundTerminal } from '@/store/types'
import type { SidebarSessionItem } from '@/store/selectors/sidebarSelectors'

describe('Sidebar render stability', () => {
  describe('areTerminalsEqual', () => {
    const terminal1: BackgroundTerminal = {
      terminalId: 'term-1',
      title: 'Claude',
      createdAt: 1000,
      lastActivityAt: 2000,
      status: 'running',
      hasClients: false,
      mode: 'claude',
      resumeSessionId: 'session-abc',
      cwd: '/home/user/project',
    }

    const terminal2: BackgroundTerminal = {
      terminalId: 'term-2',
      title: 'Codex',
      createdAt: 3000,
      lastActivityAt: 4000,
      status: 'running',
      hasClients: true,
      mode: 'codex',
      resumeSessionId: 'session-def',
      cwd: '/home/user/other',
    }

    it('returns true for identical terminal lists', () => {
      const a = [terminal1, terminal2]
      const b = [{ ...terminal1 }, { ...terminal2 }]
      expect(areTerminalsEqual(a, b)).toBe(true)
    })

    it('returns true for two empty arrays', () => {
      expect(areTerminalsEqual([], [])).toBe(true)
    })

    it('returns false when lengths differ', () => {
      expect(areTerminalsEqual([terminal1], [terminal1, terminal2])).toBe(false)
    })

    it('returns false when a terminal is added', () => {
      const a = [terminal1]
      const b = [terminal1, terminal2]
      expect(areTerminalsEqual(a, b)).toBe(false)
    })

    it('returns false when a terminal is removed', () => {
      const a = [terminal1, terminal2]
      const b = [terminal1]
      expect(areTerminalsEqual(a, b)).toBe(false)
    })

    it('returns false when terminalId changes', () => {
      const a = [terminal1]
      const b = [{ ...terminal1, terminalId: 'term-changed' }]
      expect(areTerminalsEqual(a, b)).toBe(false)
    })

    it('returns false when status changes', () => {
      const a = [terminal1]
      const b = [{ ...terminal1, status: 'exited' as const }]
      expect(areTerminalsEqual(a, b)).toBe(false)
    })

    it('returns false when hasClients changes', () => {
      const a = [terminal1]
      const b = [{ ...terminal1, hasClients: true }]
      expect(areTerminalsEqual(a, b)).toBe(false)
    })

    it('returns false when resumeSessionId changes', () => {
      const a = [terminal1]
      const b = [{ ...terminal1, resumeSessionId: 'session-new' }]
      expect(areTerminalsEqual(a, b)).toBe(false)
    })

    it('returns false when mode changes', () => {
      const a = [terminal1]
      const b = [{ ...terminal1, mode: 'codex' as const }]
      expect(areTerminalsEqual(a, b)).toBe(false)
    })

    it('ignores lastActivityAt changes (not relevant for sidebar rendering)', () => {
      const a = [terminal1]
      const b = [{ ...terminal1, lastActivityAt: 9999 }]
      expect(areTerminalsEqual(a, b)).toBe(true)
    })

    it('returns false when order changes', () => {
      const a = [terminal1, terminal2]
      const b = [terminal2, terminal1]
      expect(areTerminalsEqual(a, b)).toBe(false)
    })
  })

  describe('SidebarItem memoization', () => {
    it('is wrapped in React.memo', async () => {
      const { SidebarItem } = await import('@/components/Sidebar')
      // React.memo components have $$typeof === Symbol.for('react.memo')
      expect((SidebarItem as any).$$typeof).toBe(Symbol.for('react.memo'))
    })

    it('has a custom comparator (not default shallow equality)', async () => {
      const { SidebarItem } = await import('@/components/Sidebar')
      // React.memo with a custom comparator sets .compare on the memo object
      expect((SidebarItem as any).compare).toBeTypeOf('function')
    })

    it('custom comparator returns true when item data is unchanged despite new references', async () => {
      const { SidebarItem } = await import('@/components/Sidebar')
      const compare = (SidebarItem as any).compare as (a: any, b: any) => boolean

      const item = {
        sessionId: 'abc', provider: 'claude', title: 'Test',
        subtitle: 'project', timestamp: 1000, hasTab: false,
        isRunning: false, archived: false, hasTitle: true,
        id: 'session-claude-abc',
      }
      const prevProps = { item, isActiveTab: false, showProjectBadge: true, onClick: () => {}, timestampTick: 1 }
      // New object references for item and onClick, but same values
      const nextProps = { item: { ...item }, isActiveTab: false, showProjectBadge: true, onClick: () => {}, timestampTick: 1 }

      expect(compare(prevProps, nextProps)).toBe(true)
    })

    it('custom comparator returns false when item title changes', async () => {
      const { SidebarItem } = await import('@/components/Sidebar')
      const compare = (SidebarItem as any).compare as (a: any, b: any) => boolean

      const item = {
        sessionId: 'abc', provider: 'claude', title: 'Test',
        subtitle: 'project', timestamp: 1000, hasTab: false,
        isRunning: false, archived: false, hasTitle: true,
        id: 'session-claude-abc',
      }
      const prevProps = { item, isActiveTab: false, showProjectBadge: true, onClick: () => {}, timestampTick: 1 }
      const nextProps = { item: { ...item, title: 'Changed' }, isActiveTab: false, showProjectBadge: true, onClick: () => {}, timestampTick: 1 }

      expect(compare(prevProps, nextProps)).toBe(false)
    })

    it('custom comparator returns false when timestampTick changes', async () => {
      const { SidebarItem } = await import('@/components/Sidebar')
      const compare = (SidebarItem as any).compare as (a: any, b: any) => boolean

      const item = {
        sessionId: 'abc', provider: 'claude', title: 'Test',
        subtitle: 'project', timestamp: 1000, hasTab: false,
        isRunning: false, archived: false, hasTitle: true,
        id: 'session-claude-abc',
      }
      const prevProps = { item, isActiveTab: false, showProjectBadge: true, onClick: () => {}, timestampTick: 1 }
      const nextProps = { item, isActiveTab: false, showProjectBadge: true, onClick: () => {}, timestampTick: 2 }

      expect(compare(prevProps, nextProps)).toBe(false)
    })

    it('custom comparator ignores onClick reference changes', async () => {
      const { SidebarItem } = await import('@/components/Sidebar')
      const compare = (SidebarItem as any).compare as (a: any, b: any) => boolean

      const item = {
        sessionId: 'abc', provider: 'claude', title: 'Test',
        subtitle: 'project', timestamp: 1000, hasTab: false,
        isRunning: false, archived: false, hasTitle: true,
        id: 'session-claude-abc',
      }
      const fn1 = () => {}
      const fn2 = () => {}
      const prevProps = { item, isActiveTab: false, showProjectBadge: true, onClick: fn1, timestampTick: 1 }
      const nextProps = { item, isActiveTab: false, showProjectBadge: true, onClick: fn2, timestampTick: 1 }

      expect(compare(prevProps, nextProps)).toBe(true)
    })

    it('custom comparator returns false when cwd changes (affects click handler)', async () => {
      const { SidebarItem } = await import('@/components/Sidebar')
      const compare = (SidebarItem as any).compare as (a: any, b: any) => boolean

      const item = {
        sessionId: 'abc', provider: 'claude', title: 'Test',
        subtitle: 'project', timestamp: 1000, hasTab: false,
        isRunning: false, archived: false, hasTitle: true,
        id: 'session-claude-abc', cwd: '/home/user/project',
      }
      const prevProps = { item, isActiveTab: false, showProjectBadge: true, onClick: () => {}, timestampTick: 1 }
      const nextProps = { item: { ...item, cwd: '/home/user/other' }, isActiveTab: false, showProjectBadge: true, onClick: () => {}, timestampTick: 1 }

      expect(compare(prevProps, nextProps)).toBe(false)
    })

    it('custom comparator returns false when isActiveTab changes', async () => {
      const { SidebarItem } = await import('@/components/Sidebar')
      const compare = (SidebarItem as any).compare as (a: any, b: any) => boolean

      const item = {
        sessionId: 'abc', provider: 'claude', title: 'Test',
        subtitle: 'project', timestamp: 1000, hasTab: false,
        isRunning: false, archived: false, hasTitle: true,
        id: 'session-claude-abc',
      }
      const prevProps = { item, isActiveTab: false, showProjectBadge: true, onClick: () => {}, timestampTick: 1 }
      const nextProps = { item, isActiveTab: true, showProjectBadge: true, onClick: () => {}, timestampTick: 1 }

      expect(compare(prevProps, nextProps)).toBe(false)
    })
  })

  describe('areSessionItemsEqual', () => {
    const item1: SidebarSessionItem = {
      id: 'session-claude-abc',
      sessionId: 'abc',
      provider: 'claude',
      title: 'Fix sidebar',
      hasTitle: true,
      subtitle: 'freshell',
      projectPath: '/home/user/freshell',
      projectColor: '#ff0000',
      timestamp: 1000,
      cwd: '/home/user/freshell',
      hasTab: true,
      isRunning: true,
      runningTerminalId: 'term-1',
      archived: false,
    }

    const item2: SidebarSessionItem = {
      id: 'session-codex-def',
      sessionId: 'def',
      provider: 'codex',
      title: 'Add feature',
      hasTitle: true,
      subtitle: 'project',
      projectPath: '/home/user/project',
      timestamp: 2000,
      cwd: '/home/user/project',
      hasTab: false,
      isRunning: false,
      archived: false,
    }

    it('returns true for identical item lists', () => {
      const a = [item1, item2]
      const b = [{ ...item1 }, { ...item2 }]
      expect(areSessionItemsEqual(a, b)).toBe(true)
    })

    it('returns true for two empty arrays', () => {
      expect(areSessionItemsEqual([], [])).toBe(true)
    })

    it('returns false when lengths differ', () => {
      expect(areSessionItemsEqual([item1], [item1, item2])).toBe(false)
    })

    it('ignores timestamp changes (handled by timestampTick)', () => {
      const a = [item1]
      const b = [{ ...item1, timestamp: 9999 }]
      expect(areSessionItemsEqual(a, b)).toBe(true)
    })

    it('returns false when sessionId changes', () => {
      const a = [item1]
      const b = [{ ...item1, sessionId: 'changed' }]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('returns false when title changes', () => {
      const a = [item1]
      const b = [{ ...item1, title: 'New title' }]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('returns false when hasTab changes', () => {
      const a = [item1]
      const b = [{ ...item1, hasTab: false }]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('returns false when isRunning changes', () => {
      const a = [item1]
      const b = [{ ...item1, isRunning: false }]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('returns false when runningTerminalId changes', () => {
      const a = [item1]
      const b = [{ ...item1, runningTerminalId: 'term-new' }]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('returns false when archived changes', () => {
      const a = [item1]
      const b = [{ ...item1, archived: true }]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('returns false when provider changes', () => {
      const a = [item1]
      const b = [{ ...item1, provider: 'codex' as const }]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('returns false when order changes (items reorder)', () => {
      const a = [item1, item2]
      const b = [item2, item1]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('returns false when cwd changes', () => {
      const a = [item1]
      const b = [{ ...item1, cwd: '/other/path' }]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('returns false when projectColor changes', () => {
      const a = [item1]
      const b = [{ ...item1, projectColor: '#00ff00' }]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('returns false when subtitle changes', () => {
      const a = [item1]
      const b = [{ ...item1, subtitle: 'different' }]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('returns false when projectPath changes', () => {
      const a = [item1]
      const b = [{ ...item1, projectPath: '/other' }]
      expect(areSessionItemsEqual(a, b)).toBe(false)
    })

    it('ignores id changes (derived field, not rendered)', () => {
      const a = [item1]
      const b = [{ ...item1, id: 'different-id' }]
      expect(areSessionItemsEqual(a, b)).toBe(true)
    })

    it('ignores ratchetedActivity changes (not rendered in SidebarItem)', () => {
      const a = [{ ...item1, ratchetedActivity: 100 }]
      const b = [{ ...item1, ratchetedActivity: 999 }]
      expect(areSessionItemsEqual(a, b)).toBe(true)
    })
  })

  describe('Row component stability', () => {
    it('SidebarRow is exported at module scope (not recreated per render)', async () => {
      const { SidebarRow } = await import('@/components/Sidebar')
      expect(typeof SidebarRow).toBe('function')
    })
  })
})
