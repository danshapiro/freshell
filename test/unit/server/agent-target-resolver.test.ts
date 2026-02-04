import { describe, it, expect } from 'vitest'
import { resolveTarget } from '../../../server/agent-api/target-resolver'

const snapshot = {
  tabs: [
    { id: 'tab_plain', title: 'alpha' },
    { id: 'tab_dot', title: 'alpha.1' },
  ],
  activeTabId: 'tab_plain',
  layouts: {
    tab_plain: {
      type: 'split',
      id: 'split_1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'pane_0', content: { kind: 'terminal', terminalId: 'term_0' } },
        { type: 'leaf', id: 'pane_1', content: { kind: 'terminal', terminalId: 'term_1' } },
      ],
    },
    tab_dot: {
      type: 'leaf',
      id: 'pane_dot',
      content: { kind: 'terminal', terminalId: 'term_dot' },
    },
  },
  activePane: {
    tab_plain: 'pane_0',
    tab_dot: 'pane_dot',
  },
}

describe('resolveTarget', () => {
  it('prefers exact tab name over tab.pane parsing', () => {
    const res = resolveTarget('alpha.1', snapshot as any)
    expect(res.tabId).toBe('tab_dot')
    expect(res.paneId).toBe('pane_dot')
  })
})
