import { describe, it, expect } from 'vitest'
import { LayoutStore } from '../../../server/agent-api/layout-store'

const snapshot = {
  tabs: [{ id: 'tab_a', title: 'alpha' }],
  activeTabId: 'tab_a',
  layouts: {
    tab_a: {
      type: 'leaf',
      id: 'pane_1',
      content: { kind: 'terminal', terminalId: 'term_1' },
    },
  },
  activePane: { tab_a: 'pane_1' },
}

describe('LayoutStore (read)', () => {
  it('lists tabs and panes from snapshot', () => {
    const store = new LayoutStore()
    store.updateFromUi(snapshot, 'conn1')

    const tabs = store.listTabs()
    const panes = store.listPanes('tab_a')

    expect(tabs[0].id).toBe('tab_a')
    expect(panes[0].id).toBe('pane_1')
    expect(panes[0].terminalId).toBe('term_1')
  })

  it('tracks and exposes layout source connection id', () => {
    const store = new LayoutStore()
    store.updateFromUi(snapshot as any, 'conn-abc')
    expect(store.getSourceConnectionId()).toBe('conn-abc')
  })
})
