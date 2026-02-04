import { describe, it, expect } from 'vitest'
import { LayoutStore } from '../../../server/agent-api/layout-store'

it('creates a new tab with a terminal pane', () => {
  const store = new LayoutStore()
  const result = store.createTab({ title: 'alpha', terminalId: 'term_1' })
  expect(result.tabId).toBeDefined()
  expect(result.paneId).toBeDefined()
})
