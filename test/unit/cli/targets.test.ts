import { it, expect } from 'vitest'
import { resolveTarget } from '../../../server/cli/targets'

it('resolves pane index in active tab', () => {
  const res = resolveTarget('0', { activeTabId: 't1', panesByTab: { t1: ['p1'] }, tabs: [] })
  expect(res.paneId).toBe('p1')
})

it('resolves pane title targets', () => {
  const res = resolveTarget('Docs review', {
    activeTabId: 't1',
    panesByTab: {
      t1: [
        { id: 'p1', title: 'Shell' },
        { id: 'p2', title: 'Docs review' },
      ],
    },
    tabs: [{ id: 't1', title: 'Workspace', activePaneId: 'p1' }],
  } as any)

  expect(res.tabId).toBe('t1')
  expect(res.paneId).toBe('p2')
 })
