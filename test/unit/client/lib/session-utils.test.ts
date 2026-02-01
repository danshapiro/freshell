import { describe, it, expect } from 'vitest'
import { getSessionsForHello } from '@/lib/session-utils'
import type { RootState } from '@/store/store'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

function terminalContent(mode: TerminalPaneContent['mode'], resumeSessionId: string): TerminalPaneContent {
  return {
    kind: 'terminal',
    mode,
    status: 'running',
    createRequestId: `req-${resumeSessionId}`,
    resumeSessionId,
  }
}

function leaf(id: string, content: TerminalPaneContent): PaneNode {
  return {
    type: 'leaf',
    id,
    content,
  }
}

describe('getSessionsForHello', () => {
  it('filters non-claude sessions from active/visible/background', () => {
    const layoutActive: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        leaf('pane-codex', terminalContent('codex', 'codex-active')),
        leaf('pane-claude', terminalContent('claude', 'claude-visible')),
      ],
    }

    const layoutBackground: PaneNode = {
      type: 'split',
      id: 'split-2',
      direction: 'vertical',
      sizes: [50, 50],
      children: [
        leaf('pane-claude-bg', terminalContent('claude', 'claude-bg')),
        leaf('pane-codex-bg', terminalContent('codex', 'codex-bg')),
      ],
    }

    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }, { id: 'tab-2' }],
      },
      panes: {
        layouts: {
          'tab-1': layoutActive,
          'tab-2': layoutBackground,
        },
        activePane: {
          'tab-1': 'pane-codex',
        },
      },
    } as unknown as RootState

    const result = getSessionsForHello(state)

    expect(result.active).toBeUndefined()
    expect(result.visible).toEqual(['claude-visible'])
    expect(result.background).toEqual(['claude-bg'])
  })

  it('captures active claude session when active pane is claude', () => {
    const layoutActive: PaneNode = {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        leaf('pane-claude', terminalContent('claude', 'claude-active')),
        leaf('pane-codex', terminalContent('codex', 'codex-visible')),
      ],
    }

    const state = {
      tabs: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1' }],
      },
      panes: {
        layouts: {
          'tab-1': layoutActive,
        },
        activePane: {
          'tab-1': 'pane-claude',
        },
      },
    } as unknown as RootState

    const result = getSessionsForHello(state)

    expect(result.active).toBe('claude-active')
    expect(result.visible).toEqual([])
    expect(result.background).toBeUndefined()
  })
})
