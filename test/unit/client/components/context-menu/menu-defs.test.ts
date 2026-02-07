import { describe, it, expect } from 'vitest'
import { buildMenuItems } from '@/components/context-menu/menu-defs'

describe('menu-defs history-session', () => {
  it('treats session panes as open sessions (disables delete)', () => {
    const items = buildMenuItems(
      { kind: 'history-session', sessionId: 's1', provider: 'claude' } as any,
      {
        view: 'sessions',
        sidebarCollapsed: false,
        tabs: [{ id: 't1', title: 'Tab', createdAt: 1 }] as any,
        paneLayouts: {
          t1: {
            type: 'leaf',
            id: 'p1',
            content: { kind: 'session', sessionId: 's1', provider: 'claude', title: 'Session' },
          } as any,
        },
        sessions: [{ projectPath: '/p', sessions: [{ provider: 'claude', sessionId: 's1', updatedAt: 1 }] }] as any,
        expandedProjects: new Set(),
        contextElement: null,
        platform: null,
        actions: new Proxy({}, { get: () => () => {} }) as any,
      } as any,
    )

    const del = items.find((i: any) => i.id === 'history-session-delete')
    expect(del).toBeTruthy()
    expect((del as any).disabled).toBe(true)
  })
})

