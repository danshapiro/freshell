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

it('prefers documented index and tab selectors over pane title collisions', () => {
  const ctx = {
    activeTabId: 't1',
    panesByTab: {
      t1: [
        { id: 'p1', title: 'Shell' },
        { id: 'p2', title: 'Editor' },
      ],
      t2: [
        { id: 'p3', title: '0' },
        { id: 'p4', title: 'alpha.1' },
      ],
    },
    tabs: [
      { id: 't1', title: 'alpha', activePaneId: 'p1' },
      { id: 't2', title: 'alpha.1', activePaneId: 'p3' },
    ],
  } as any

  expect(resolveTarget('0', ctx)).toMatchObject({ tabId: 't1', paneId: 'p1' })
  expect(resolveTarget('alpha.1', ctx)).toMatchObject({ tabId: 't2', paneId: 'p3' })
})

it('returns pane not found for out-of-range pane selectors instead of throwing', () => {
  const ctx = {
    activeTabId: 't1',
    panesByTab: {
      t1: [{ id: 'p1', title: 'Shell' }],
    },
    tabs: [{ id: 't1', title: 'Alpha', activePaneId: 'p1' }],
  } as any

  expect(resolveTarget('99', ctx)).toEqual({ tabId: 't1', paneId: undefined, message: 'active tab used' })
  expect(resolveTarget('Alpha.99', ctx)).toEqual({ tabId: 't1', paneId: 'p1', message: 'pane not found; active pane used' })
})

it('returns a clean tab match when the matched tab has no panes', () => {
  const ctx = {
    activeTabId: 't1',
    panesByTab: {
      t1: [],
    },
    tabs: [{ id: 't1', title: 'Alpha' }],
  } as any

  expect(resolveTarget('Alpha', ctx)).toEqual({ tabId: 't1', paneId: undefined, message: 'tab matched; active pane used' })
})

it('rejects ambiguous pane title targets', () => {
  const ctx = {
    activeTabId: 't1',
    panesByTab: {
      t1: [{ id: 'p1', title: 'Shell' }],
      t2: [{ id: 'p2', title: 'Shell' }],
    },
    tabs: [
      { id: 't1', title: 'Alpha', activePaneId: 'p1' },
      { id: 't2', title: 'Beta', activePaneId: 'p2' },
    ],
  } as any

  expect(resolveTarget('Shell', ctx)).toEqual({
    message: 'pane target is ambiguous; use pane id or tab.pane index',
  })
})
