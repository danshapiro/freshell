import { describe, it, expect } from 'vitest'
import { LayoutStore } from '../../../server/agent-api/layout-store'

it('creates a new tab with a terminal pane', () => {
  const store = new LayoutStore()
  const result = store.createTab({ title: 'alpha', terminalId: 'term_1' })
  expect(result.tabId).toBeDefined()
  expect(result.paneId).toBeDefined()
})

it('selects pane even when provided tabId is invalid', () => {
  const store = new LayoutStore()
  const { tabId, paneId } = store.createTab({ title: 'alpha', terminalId: 'term_1' })
  const result = store.selectPane('missing_tab', paneId)
  expect(result.tabId).toBe(tabId)
  const tabs = store.listTabs()
  const active = tabs.find((t) => t.id === tabId)
  expect(active?.activePaneId).toBe(paneId)
})

it('renames a pane in its owning tab', () => {
  const store = new LayoutStore()
  store.updateFromUi({
    tabs: [{ id: 'tab_a', title: 'Alpha' }],
    activeTabId: 'tab_a',
    layouts: {
      tab_a: { type: 'leaf', id: 'pane_1', content: { kind: 'terminal', terminalId: 'term_1' } },
    },
    activePane: { tab_a: 'pane_1' },
    paneTitles: {},
    timestamp: Date.now(),
  }, 'conn-1')

  expect(store.renamePane('pane_1', 'Logs')).toEqual({ tabId: 'tab_a', paneId: 'pane_1' })
  expect((store as any).snapshot.paneTitles.tab_a.pane_1).toBe('Logs')
})

it('lists pane titles from the public pane snapshot', () => {
  const store = new LayoutStore()
  store.updateFromUi({
    tabs: [{ id: 'tab_a', title: 'Alpha' }],
    activeTabId: 'tab_a',
    layouts: {
      tab_a: { type: 'leaf', id: 'pane_1', content: { kind: 'terminal', terminalId: 'term_1' } },
    },
    activePane: { tab_a: 'pane_1' },
    paneTitles: { tab_a: { pane_1: 'Logs' } },
    timestamp: Date.now(),
  }, 'conn-1')

  expect(store.listPanes('tab_a')).toEqual([
    {
      id: 'pane_1',
      index: 0,
      kind: 'terminal',
      terminalId: 'term_1',
      title: 'Logs',
    },
  ])
})
