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

  it('returns an empty normalized snapshot before any ui layout sync', () => {
    const store = new LayoutStore()

    expect(store.getNormalizedSnapshot()).toEqual({
      tabs: [],
      activeTabId: null,
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
    })
  })

  it('filters normalized snapshots by tab id', () => {
    const store = new LayoutStore()
    store.updateFromUi({
      tabs: [
        { id: 'tab_a', title: 'alpha' },
        { id: 'tab_b', title: 'beta' },
      ],
      activeTabId: 'tab_b',
      layouts: {
        tab_a: {
          type: 'leaf',
          id: 'pane_a',
          content: { kind: 'terminal', terminalId: 'term_a' },
        },
        tab_b: {
          type: 'leaf',
          id: 'pane_b',
          content: { kind: 'terminal', terminalId: 'term_b' },
        },
      },
      activePane: { tab_a: 'pane_a', tab_b: 'pane_b' },
      paneTitles: { tab_a: { pane_a: 'Alpha pane' }, tab_b: { pane_b: 'Beta pane' } },
      paneTitleSetByUser: { tab_a: { pane_a: true }, tab_b: { pane_b: true } },
    }, 'conn1')

    expect(store.getNormalizedSnapshot('tab_b')).toEqual({
      tabs: [{ id: 'tab_b', title: 'beta' }],
      activeTabId: 'tab_b',
      layouts: {
        tab_b: {
          type: 'leaf',
          id: 'pane_b',
          content: { kind: 'terminal', terminalId: 'term_b' },
        },
      },
      activePane: { tab_b: 'pane_b' },
      paneTitles: { tab_b: { pane_b: 'Beta pane' } },
      paneTitleSetByUser: { tab_b: { pane_b: true } },
    })
  })

  it('returns an empty filtered snapshot for a missing tab', () => {
    const store = new LayoutStore()
    store.updateFromUi(snapshot as any, 'conn1')

    expect(store.getNormalizedSnapshot('missing')).toEqual({
      tabs: [],
      activeTabId: null,
      layouts: {},
      activePane: {},
      paneTitles: {},
      paneTitleSetByUser: {},
    })
  })

  it('normalizes legacy agent-chat panes in normalized snapshots', () => {
    const store = new LayoutStore()
    store.updateFromUi({
      tabs: [{ id: 'tab_agent', title: 'agent' }],
      activeTabId: 'tab_agent',
      layouts: {
        tab_agent: {
          type: 'leaf',
          id: 'pane_agent',
          content: {
            kind: 'agent-chat',
            provider: 'claude',
            createRequestId: 'req_agent',
            resumeSessionId: '11111111-1111-4111-8111-111111111111',
          },
        },
      },
      activePane: { tab_agent: 'pane_agent' },
    }, 'conn1')

    const pane = store.getNormalizedSnapshot('tab_agent').layouts.tab_agent.content

    expect(pane).toMatchObject({
      kind: 'fresh-agent',
      provider: 'claude',
      sessionType: 'freshclaude',
      createRequestId: 'req_agent',
      sessionRef: { provider: 'claude', sessionId: '11111111-1111-4111-8111-111111111111' },
    })
    expect(JSON.stringify(store.getNormalizedSnapshot('tab_agent'))).not.toContain('"agent-chat"')
  })

  it('does not expose mutable store state from full normalized snapshots', () => {
    const store = new LayoutStore()
    store.updateFromUi({
      ...snapshot,
      paneTitles: { tab_a: { pane_1: 'Original title' } },
      paneTitleSetByUser: { tab_a: { pane_1: true } },
    } as any, 'conn1')

    const returned = store.getNormalizedSnapshot() as any
    returned.tabs[0].title = 'mutated'
    returned.layouts.tab_a.content.kind = 'mutated'
    returned.paneTitles.tab_a.pane_1 = 'Mutated title'
    returned.paneTitleSetByUser.tab_a.pane_1 = false

    const next = store.getNormalizedSnapshot() as any
    expect(next.tabs[0].title).toBe('alpha')
    expect(next.layouts.tab_a.content.kind).toBe('terminal')
    expect(next.paneTitles.tab_a.pane_1).toBe('Original title')
    expect(next.paneTitleSetByUser.tab_a.pane_1).toBe(true)
  })

  it('does not expose mutable store state from tab-filtered normalized snapshots', () => {
    const store = new LayoutStore()
    store.updateFromUi({
      ...snapshot,
      paneTitles: { tab_a: { pane_1: 'Original title' } },
      paneTitleSetByUser: { tab_a: { pane_1: true } },
    } as any, 'conn1')

    const returned = store.getNormalizedSnapshot('tab_a') as any
    returned.tabs[0].title = 'mutated'
    returned.layouts.tab_a.content.kind = 'mutated'
    returned.paneTitles.tab_a.pane_1 = 'Mutated title'
    returned.paneTitleSetByUser.tab_a.pane_1 = false

    const next = store.getNormalizedSnapshot('tab_a') as any
    expect(next.tabs[0].title).toBe('alpha')
    expect(next.layouts.tab_a.content.kind).toBe('terminal')
    expect(next.paneTitles.tab_a.pane_1).toBe('Original title')
    expect(next.paneTitleSetByUser.tab_a.pane_1).toBe(true)
  })
})
