import { describe, it, expect } from 'vitest'
import { resolveTarget } from '../../../server/agent-api/target-resolver'

const snapshot = {
  tabs: [
    { id: 'tab_plain', title: 'alpha' },
    { id: 'tab_dot', title: 'alpha.1' },
  ],
  activeTabId: 'tab_plain',
  layouts: {
    tab_plain: {
      type: 'split',
      id: 'split_1',
      direction: 'horizontal',
      sizes: [50, 50],
      children: [
        { type: 'leaf', id: 'pane_0', content: { kind: 'terminal', terminalId: 'term_0' } },
        { type: 'leaf', id: 'pane_1', content: { kind: 'terminal', terminalId: 'term_1' } },
      ],
    },
    tab_dot: {
      type: 'leaf',
      id: 'pane_dot',
      content: { kind: 'terminal', terminalId: 'term_dot' },
    },
  },
  activePane: {
    tab_plain: 'pane_0',
    tab_dot: 'pane_dot',
  },
}

describe('resolveTarget', () => {
  it('prefers exact tab name over tab.pane parsing', () => {
    const res = resolveTarget('alpha.1', snapshot as any)
    expect(res.tabId).toBe('tab_dot')
    expect(res.paneId).toBe('pane_dot')
  })

  it('resolves pane titles as pane targets', () => {
    const res = resolveTarget('Docs review', {
      ...snapshot,
      paneTitles: {
        tab_plain: { pane_1: 'Docs review' },
      },
    } as any)

    expect(res.tabId).toBe('tab_plain')
    expect(res.paneId).toBe('pane_1')
  })

  it('prefers documented selectors over pane title collisions', () => {
    const resIndex = resolveTarget('0', {
      ...snapshot,
      paneTitles: {
        tab_dot: { pane_dot: '0' },
      },
    } as any)

    expect(resIndex.tabId).toBe('tab_plain')
    expect(resIndex.paneId).toBe('pane_0')

    const resTab = resolveTarget('alpha.1', {
      ...snapshot,
      paneTitles: {
        tab_plain: { pane_1: 'alpha.1' },
      },
    } as any)

    expect(resTab.tabId).toBe('tab_dot')
    expect(resTab.paneId).toBe('pane_dot')
  })

  it('rejects ambiguous pane title matches', () => {
    const res = resolveTarget('Shell', {
      ...snapshot,
      paneTitles: {
        tab_plain: { pane_0: 'Shell' },
        tab_dot: { pane_dot: 'Shell' },
      },
    } as any)

    expect(res).toEqual({
      message: 'pane target is ambiguous; use pane id or tab.pane index',
    })
  })
})
