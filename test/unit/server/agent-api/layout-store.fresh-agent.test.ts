import { describe, expect, it } from 'vitest'

import { LayoutStore } from '../../../../server/agent-api/layout-store.js'

describe('LayoutStore fresh-agent titles', () => {
  it('derives a fresh-agent pane title from sessionType', () => {
    const store = new LayoutStore()
    store.updateFromUi({
      tabs: [{ id: 'tab-1', title: 'Fresh Agent' }],
      activeTabId: 'tab-1',
      activePane: { 'tab-1': 'pane-1' },
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'fresh-agent',
            provider: 'codex',
            sessionType: 'freshcodex',
          },
        },
      },
    }, 'conn-1')

    expect(store.listPanes('tab-1')[0]?.title).toBe('Freshcodex')
  })
})
