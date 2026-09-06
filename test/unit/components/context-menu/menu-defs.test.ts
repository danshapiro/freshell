import { describe, expect, it, vi } from 'vitest'
import {
  buildMenuItems,
  type MenuActions,
  type MenuBuildContext,
} from '@/components/context-menu/menu-defs'
import type { ContextTarget } from '@/components/context-menu/context-menu-types'
import type { PaneContent } from '@/store/paneTypes'

// Platform gating of the restart capability: the server withholds the
// `agentRestartV1` ready advertisement on platforms whose persisted
// replacement-fence recovery cannot succeed, and the menu must then fall
// back from "Restart pane" to "Refresh pane" even for restart-eligible
// content. `MenuBuildContext.agentRestartSupported` carries that capability
// (populated by ContextMenuProvider from `getServerCapabilities()`).

function createMockActions(): MenuActions {
  return {
    refreshPane: vi.fn(),
    restartPane: vi.fn(),
    // The terminal-body menu path reads these during build.
    getTerminalActions: vi.fn(),
    getEditorActions: vi.fn(),
    getBrowserActions: vi.fn(),
  } as unknown as MenuActions
}

// Restart-eligible per `resolveAgentRestartTarget` (built-in terminal
// provider + durable sessionRef + runtime id/generation).
const RESTARTABLE_CONTENT: PaneContent = {
  kind: 'terminal',
  mode: 'claude',
  createRequestId: 'req-restartable',
  terminalId: 'runtime-claude-1',
  runtimeId: 'runtime-claude-1',
  runtimeGeneration: 3,
  status: 'running',
  sessionRef: { provider: 'claude', sessionId: 'claude-session-1' },
}

function createMockContext(agentRestartSupported: boolean): MenuBuildContext {
  return {
    view: 'terminal',
    sidebarCollapsed: false,
    tabs: [{ id: 'tab-1', title: 'Tab', mode: 'claude' }] as MenuBuildContext['tabs'],
    paneLayouts: {
      'tab-1': { type: 'leaf', id: 'pane-1', content: RESTARTABLE_CONTENT },
    },
    sessions: [],
    expandedProjects: new Set<string>(),
    contextElement: null,
    clickTarget: null,
    actions: createMockActions(),
    aiEnabled: false,
    platform: 'linux',
    agentRestartSupported,
  }
}

function lifecycleItemIds(target: ContextTarget, ctx: MenuBuildContext): string[] {
  return buildMenuItems(target, ctx)
    .filter((item) => item.type === 'item')
    .map((item) => item.id)
}

const PANE_TARGET: ContextTarget = { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' }
const TERMINAL_TARGET: ContextTarget = { kind: 'terminal', tabId: 'tab-1', paneId: 'pane-1' }

describe('buildMenuItems - restart capability gating (pane header menu)', () => {
  it('degrades Restart to Refresh when the server does not advertise agentRestartV1', () => {
    const ids = lifecycleItemIds(PANE_TARGET, createMockContext(false))
    expect(ids).toContain('refresh-pane')
    expect(ids).not.toContain('restart-pane')
  })

  it('shows Restart when content is eligible and the server advertises the capability', () => {
    const ids = lifecycleItemIds(PANE_TARGET, createMockContext(true))
    expect(ids).toContain('restart-pane')
    expect(ids).not.toContain('refresh-pane')
  })
})

describe('buildMenuItems - restart capability gating (terminal body menu)', () => {
  it('degrades Restart to Refresh when the server does not advertise agentRestartV1', () => {
    const ids = lifecycleItemIds(TERMINAL_TARGET, createMockContext(false))
    expect(ids).toContain('refresh-pane')
    expect(ids).not.toContain('restart-pane')
  })

  it('shows Restart when content is eligible and the server advertises the capability', () => {
    const ids = lifecycleItemIds(TERMINAL_TARGET, createMockContext(true))
    expect(ids).toContain('restart-pane')
    expect(ids).not.toContain('refresh-pane')
  })
})
