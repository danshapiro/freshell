import { it, expect } from 'vitest'
import { resolveTarget } from '../../../server/cli/targets'

it('resolves pane index in active tab', () => {
  const res = resolveTarget('0', { activeTabId: 't1', panesByTab: { t1: ['p1'] }, tabs: [] })
  expect(res.paneId).toBe('p1')
})
