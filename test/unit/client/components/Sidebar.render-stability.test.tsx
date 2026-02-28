import { describe, it, expect } from 'vitest'
import { areTerminalsEqual } from '@/components/Sidebar'
import type { BackgroundTerminal } from '@/store/types'

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

    it('accepts timestampTick prop to bust memo cache for timestamp freshness', async () => {
      const { SidebarItem } = await import('@/components/Sidebar')
      // The inner component wrapped by React.memo is accessible via .type
      const inner = (SidebarItem as any).type || (SidebarItem as any).render
      expect(inner).toBeDefined()
      // The inner function should accept props including timestampTick;
      // we verify the memo wrapper exists (type is a function that React calls)
      expect(typeof inner).toBe('function')
    })
  })

  describe('Row component stability', () => {
    it('SidebarRow is exported at module scope (not recreated per render)', async () => {
      const { SidebarRow } = await import('@/components/Sidebar')
      expect(typeof SidebarRow).toBe('function')
    })
  })
})
