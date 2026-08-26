import { describe, expect, it, vi } from 'vitest'
import {
  buildMenuItems,
  type MenuActions,
  type MenuBuildContext,
} from '@/components/context-menu/menu-defs'
import type { PaneContent, PaneNode } from '@/store/paneTypes'

function actions(): MenuActions {
  return {
    refreshPane: vi.fn(),
    restartPane: vi.fn(),
    reopenPaneAsSessionTarget: undefined,
  } as unknown as MenuActions
}

function context(content: PaneContent, menuActions = actions()): MenuBuildContext {
  const layout: PaneNode = { type: 'leaf', id: 'pane-1', content }
  return {
    view: 'terminal',
    sidebarCollapsed: false,
    tabs: [{ id: 'tab-1', title: 'Tab', mode: 'shell' }] as MenuBuildContext['tabs'],
    paneLayouts: { 'tab-1': layout },
    sessions: [],
    expandedProjects: new Set(),
    contextElement: null,
    clickTarget: null,
    actions: menuActions,
    aiEnabled: false,
    platform: 'linux',
  }
}

function lifecycleLabels(content: PaneContent): string[] {
  return buildMenuItems(
    { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' },
    context(content),
  )
    .filter((item) => item.type === 'item')
    .map((item) => item.label)
}

describe('restart pane context action', () => {
  it('shows Restart pane instead of Refresh pane only for resumable built-in agent panes', () => {
    const resumableTerminal: PaneContent = {
      kind: 'terminal',
      mode: 'claude',
      createRequestId: 'terminal-create',
      terminalId: 'terminal-runtime',
      runtimeId: 'terminal-runtime',
      runtimeGeneration: 4,
      status: 'running',
      sessionRef: { provider: 'claude', sessionId: 'claude-session' },
    }
    const resumableFreshAgent: PaneContent = {
      kind: 'fresh-agent',
      sessionType: 'freshcodex',
      provider: 'codex',
      createRequestId: 'fresh-create',
      sessionId: 'fresh-session',
      runtimeId: 'fresh-runtime',
      runtimeGeneration: 7,
      status: 'idle',
      sessionRef: { provider: 'codex', sessionId: 'codex-session' },
    }
    const shellPane: PaneContent = {
      kind: 'terminal',
      mode: 'shell',
      createRequestId: 'shell-create',
      terminalId: 'shell-runtime',
      status: 'running',
    }

    expect(lifecycleLabels(resumableTerminal)).toContain('Restart pane')
    expect(lifecycleLabels(resumableTerminal)).not.toContain('Refresh pane')
    expect(lifecycleLabels(resumableFreshAgent)).toContain('Restart pane')
    expect(lifecycleLabels(resumableFreshAgent)).not.toContain('Refresh pane')
    expect(lifecycleLabels(shellPane)).toContain('Refresh pane')
  })

  it('keeps Refresh pane for a custom extension even when it advertises resume arguments', () => {
    const customPane: PaneContent = {
      kind: 'terminal',
      mode: 'acme-agent',
      createRequestId: 'custom-create',
      terminalId: 'custom-runtime',
      runtimeId: 'custom-runtime',
      runtimeGeneration: 2,
      status: 'running',
      sessionRef: { provider: 'acme-agent', sessionId: 'custom-session' },
    }
    const ctx = context(customPane)
    ctx.extensions = [{
      name: 'acme-agent',
      version: '1.0.0',
      label: 'Acme Agent',
      description: '',
      category: 'cli',
      picker: { shortcut: 'A' },
      cli: {
        supportsResume: true,
        resumeCommandTemplate: ['acme-agent', '--resume', '{{sessionId}}'],
      },
    }]

    const labels = buildMenuItems(
      { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' },
      ctx,
    )
      .filter((item) => item.type === 'item')
      .map((item) => item.label)

    expect(labels).toContain('Refresh pane')
    expect(labels).not.toContain('Restart pane')
  })

  it('dispatches restart for the selected pane', () => {
    const menuActions = actions()
    const content: PaneContent = {
      kind: 'terminal',
      mode: 'opencode',
      createRequestId: 'terminal-create',
      terminalId: 'runtime-1',
      runtimeId: 'runtime-1',
      runtimeGeneration: 3,
      status: 'running',
      sessionRef: { provider: 'opencode', sessionId: 'session-1' },
    }
    const item = buildMenuItems(
      { kind: 'pane', tabId: 'tab-1', paneId: 'pane-1' },
      context(content, menuActions),
    ).find((candidate) => candidate.type === 'item' && candidate.label === 'Restart pane')

    expect(item?.type).toBe('item')
    if (item?.type === 'item') item.onSelect()
    expect(menuActions.restartPane).toHaveBeenCalledWith('tab-1', 'pane-1')
    expect(menuActions.refreshPane).not.toHaveBeenCalled()
  })
})
