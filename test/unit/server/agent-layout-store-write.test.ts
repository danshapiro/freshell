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

it('seeds derived titles for server-created, split, and attached panes', () => {
  const store = new LayoutStore()
  const created = store.createTab({ terminalId: 'term_1' })
  const split = store.splitPane({ paneId: created.paneId, direction: 'horizontal', editor: '/tmp/example.txt' })

  expect(store.listPanes(created.tabId)).toEqual([
    expect.objectContaining({ id: created.paneId, title: 'Shell' }),
    expect.objectContaining({ id: split.newPaneId, title: 'example.txt' }),
  ])

  store.attachPaneContent(created.tabId, created.paneId, {
    kind: 'terminal',
    terminalId: 'term_2',
    mode: 'codex',
    shell: 'system',
    status: 'running',
  })

  expect(store.listPanes(created.tabId)).toEqual([
    expect.objectContaining({ id: created.paneId, title: 'Codex CLI' }),
    expect.objectContaining({ id: split.newPaneId, title: 'example.txt' }),
  ])
})

it('preserves user-set pane titles across attach, respawn, and navigate updates', () => {
  const store = new LayoutStore()
  store.updateFromUi({
    tabs: [{ id: 'tab_a', title: 'Alpha' }],
    activeTabId: 'tab_a',
    layouts: {
      tab_a: {
        type: 'leaf',
        id: 'pane_1',
        content: { kind: 'terminal', terminalId: 'term_1', mode: 'shell', shell: 'system' },
      },
    },
    activePane: { tab_a: 'pane_1' },
    paneTitles: { tab_a: { pane_1: 'Ops desk' } },
    paneTitleSetByUser: { tab_a: { pane_1: true } },
    timestamp: Date.now(),
  } as any, 'conn-1')

  store.attachPaneContent('tab_a', 'pane_1', {
    kind: 'terminal',
    terminalId: 'term_2',
    mode: 'codex',
    shell: 'system',
    status: 'running',
  })
  expect(store.listPanes('tab_a')).toEqual([
    expect.objectContaining({ id: 'pane_1', kind: 'terminal', terminalId: 'term_2', title: 'Ops desk' }),
  ])

  store.attachPaneContent('tab_a', 'pane_1', {
    kind: 'browser',
    url: 'https://docs.example.com/runbook',
    devToolsOpen: false,
  })
  expect(store.listPanes('tab_a')).toEqual([
    expect.objectContaining({ id: 'pane_1', kind: 'browser', title: 'Ops desk' }),
  ])

  store.attachPaneContent('tab_a', 'pane_1', {
    kind: 'terminal',
    terminalId: 'term_3',
    mode: 'shell',
    shell: 'system',
    status: 'running',
  })
  expect(store.listPanes('tab_a')).toEqual([
    expect.objectContaining({ id: 'pane_1', kind: 'terminal', terminalId: 'term_3', title: 'Ops desk' }),
  ])
})

it('swaps pane titles with pane content so title-based targeting stays aligned', () => {
  const store = new LayoutStore()
  store.updateFromUi({
    tabs: [{ id: 'tab_a', title: 'Alpha' }],
    activeTabId: 'tab_a',
    layouts: {
      tab_a: {
        type: 'split',
        id: 'split_1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [
          { type: 'leaf', id: 'pane_1', content: { kind: 'terminal', terminalId: 'term_1', mode: 'codex', shell: 'system' } },
          { type: 'leaf', id: 'pane_2', content: { kind: 'editor', filePath: '/tmp/example.txt', readOnly: false, content: '', viewMode: 'source' } },
        ],
      },
    },
    activePane: { tab_a: 'pane_1' },
    paneTitles: { tab_a: { pane_1: 'Codex', pane_2: 'Editor' } },
    timestamp: Date.now(),
  } as any, 'conn-1')

  expect(store.swapPane('tab_a', 'pane_1', 'pane_2')).toEqual({ tabId: 'tab_a' })
  expect(store.listPanes('tab_a')).toEqual([
    expect.objectContaining({ id: 'pane_1', kind: 'editor', title: 'Editor' }),
    expect.objectContaining({ id: 'pane_2', kind: 'terminal', terminalId: 'term_1', title: 'Codex' }),
  ])
})
