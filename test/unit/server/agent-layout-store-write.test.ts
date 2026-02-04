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
