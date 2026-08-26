import { describe, expect, it, vi } from 'vitest'
import {
  buildMenuItems,
  type MenuActions,
  type MenuBuildContext,
} from '@/components/context-menu/menu-defs'
import { findUnopenedProjectSessions } from '@/lib/session-utils'
import type { PaneNode } from '@/store/paneTypes'
import type { ProjectGroup } from '@/store/types'

const OPEN_SESSION_ID = 'open-session'
const MISSING_SESSION_ID = 'not-open'

function actions(): MenuActions {
  return {
    openSessionInNewTab: vi.fn(),
    openSessionInThisTab: vi.fn(),
    openAllSessionsInProject: vi.fn(),
  } as unknown as MenuActions
}

function workspace() {
  const paneLayouts: Record<string, PaneNode> = {
    'tab-1': {
      type: 'leaf',
      id: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'create-1',
        sessionId: 'live-1',
        status: 'idle',
        sessionRef: { provider: 'codex', sessionId: OPEN_SESSION_ID },
      },
    },
  }
  const sessions: ProjectGroup[] = [{
    projectPath: '/repo',
    sessions: [
      {
        provider: 'codex',
        sessionId: OPEN_SESSION_ID,
        projectPath: '/repo',
        lastActivityAt: 2,
      },
      {
        provider: 'codex',
        sessionId: MISSING_SESSION_ID,
        projectPath: '/repo',
        lastActivityAt: 1,
      },
    ],
  }]
  return {
    tabs: [{ id: 'tab-1', title: 'Tab', mode: 'codex' }] as MenuBuildContext['tabs'],
    paneLayouts,
    sessions,
  }
}

function context(overrides: Partial<MenuBuildContext> = {}): MenuBuildContext {
  const current = workspace()
  return {
    view: 'terminal',
    sidebarCollapsed: false,
    tabs: current.tabs,
    paneLayouts: current.paneLayouts,
    sessions: current.sessions,
    expandedProjects: new Set(),
    contextElement: null,
    clickTarget: null,
    actions: actions(),
    aiEnabled: false,
    platform: 'linux',
    ...overrides,
  }
}

function labels(ctx: MenuBuildContext): string[] {
  return buildMenuItems(
    {
      kind: 'sidebar-session',
      provider: 'codex',
      sessionId: OPEN_SESSION_ID,
    },
    ctx,
  )
    .filter((item) => item.type === 'item')
    .map((item) => item.label)
}

describe('session context open actions', () => {
  it('hides both duplicate-open actions when the session is already open anywhere', () => {
    const menuLabels = labels(context())

    expect(menuLabels).not.toContain('Open in new tab')
    expect(menuLabels).not.toContain('Open in this tab')
  })

  it('keeps both open actions for a session not open in the workspace', () => {
    const ctx = context()
    const menuLabels = buildMenuItems(
      {
        kind: 'sidebar-session',
        provider: 'codex',
        sessionId: MISSING_SESSION_ID,
      },
      ctx,
    )
      .filter((item) => item.type === 'item')
      .map((item) => item.label)

    expect(menuLabels).toContain('Open in new tab')
    expect(menuLabels).toContain('Open in this tab')
  })

  it('open all sessions filters out every session already open in the workspace', () => {
    const current = workspace()

    const unopened = findUnopenedProjectSessions(
      {
        tabs: { tabs: current.tabs },
        panes: { layouts: current.paneLayouts },
      },
      current.sessions[0],
    )

    expect(unopened.map((session) => session.sessionId)).toEqual([MISSING_SESSION_ID])
  })

  it('makes Open all clear and unavailable when every project session is already open', () => {
    const current = workspace()
    const allOpenProject: ProjectGroup = {
      ...current.sessions[0],
      sessions: [current.sessions[0].sessions[0]],
    }
    const ctx = context({ sessions: [allOpenProject] })
    const item = buildMenuItems(
      { kind: 'history-project', projectPath: '/repo' },
      ctx,
    ).find((candidate) => candidate.type === 'item' && candidate.id === 'history-project-open-all')

    expect(item?.type).toBe('item')
    if (item?.type === 'item') {
      expect(item.label).toMatch(/already open/i)
      expect(item.disabled).toBe(true)
    }
  })
})
