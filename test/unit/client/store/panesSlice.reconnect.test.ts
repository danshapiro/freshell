// Reconnect-path reducers for the D7-refusal revival fold (reconnect-revive
// Task 7): a close→reopen create that the server refuses with a D7
// `RESTORE_UNAVAILABLE` carrying the STILL-RUNNING owner terminal id must
// reattach the pane to that id instead of dead-ending on
// "Session … is still running on the server." — never a second live writer
// (one-JSONL-writer doctrine), never a silent gray pane.
//
// Placement note: panesSlice.reconcile.test.ts is the slice's reconnect-ish
// test home for the pane.reconcile VERDICT folds (`applyReconcileAttach` and
// siblings). This reducer is NOT a reconcile verdict — it folds an enriched
// create-ERROR frame — so it gets its own home named for the reconnect path,
// mirroring that file's scaffolding.

import { describe, it, expect } from 'vitest'

import panesReducer, {
  initLayout,
  applyReattachToLiveTerminal,
} from '../../../../src/store/panesSlice'
import type { PanesState } from '../../../../src/store/panesSlice'
import type { PaneNode, TerminalPaneContent } from '../../../../src/store/paneTypes'

function emptyState(): PanesState {
  return {
    layouts: {},
    activePane: {},
    paneTitles: {},
    paneTitleSetByUser: {},
    renameRequestTabId: null,
    renameRequestPaneId: null,
    zoomedPane: {},
    refreshRequestsByPane: {},
    restoreFallbackAttemptsByPane: {},
  }
}

function stateWithTerminalPane(overrides: Partial<TerminalPaneContent> = {}): PanesState {
  return panesReducer(emptyState(), initLayout({
    tabId: 'tab1',
    paneId: 'p1',
    content: {
      kind: 'terminal',
      mode: 'claude',
      shell: 'system',
      createRequestId: 'cr-keep',
      ...overrides,
    },
  }))
}

function findTerminalLeaf(node: PaneNode, paneId: string): TerminalPaneContent | undefined {
  if (node.type === 'leaf') {
    if (node.id === paneId && node.content.kind === 'terminal') return node.content
    return undefined
  }
  return findTerminalLeaf(node.children[0], paneId) ?? findTerminalLeaf(node.children[1], paneId)
}

function terminalContent(state: PanesState, tabId: string, paneId: string): TerminalPaneContent {
  const root = state.layouts[tabId]
  if (!root) throw new Error(`no layout for tab ${tabId}`)
  const content = findTerminalLeaf(root, paneId)
  if (!content) throw new Error(`no terminal pane ${paneId} in tab ${tabId}`)
  return content
}

describe('applyReattachToLiveTerminal (D7-refusal revival fold)', () => {
  it('writes terminalId/status, clears restoreError, and bumps reconcileEpoch — createRequestId untouched', () => {
    const state = stateWithTerminalPane({
      createRequestId: 'cr-keep',
      terminalId: undefined,
      status: 'creating',
      restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'dead_live_handle' },
    })
    const next = panesReducer(
      state,
      applyReattachToLiveTerminal({ tabId: 'tab1', paneId: 'p1', terminalId: 't1-live-owner' }),
    )
    const c = terminalContent(next, 'tab1', 'p1')
    expect(c.terminalId).toBe('t1-live-owner')
    expect(c.status).toBe('running')
    expect(c.restoreError).toBeUndefined()
    expect(c.createRequestId).toBe('cr-keep') // council rule 2: never re-minted
    // The epoch bump is the lifecycle effect's ONLY re-fire signal on an
    // already-mounted pane (TerminalView deps exclude terminalId/status by
    // design) — without it the fold stays gray/dead.
    expect(c.reconcileEpoch).toBe(1)
  })

  it('bumps reconcileEpoch monotonically across successive folds', () => {
    let s = stateWithTerminalPane({ createRequestId: 'cr-keep' })
    s = panesReducer(s, applyReattachToLiveTerminal({ tabId: 'tab1', paneId: 'p1', terminalId: 't-live-1' }))
    s = panesReducer(s, applyReattachToLiveTerminal({ tabId: 'tab1', paneId: 'p1', terminalId: 't-live-2' }))
    const c = terminalContent(s, 'tab1', 'p1')
    expect(c.terminalId).toBe('t-live-2')
    expect(c.reconcileEpoch).toBe(2)
  })

  it('is a no-op for an unknown paneKey', () => {
    const state = stateWithTerminalPane({ createRequestId: 'cr-keep', status: 'creating' })
    const next = panesReducer(
      state,
      applyReattachToLiveTerminal({ tabId: 'tab-other', paneId: 'p-other', terminalId: 't-x' }),
    )
    expect(next.layouts).toEqual(state.layouts)
    expect(terminalContent(next, 'tab1', 'p1').terminalId).toBeUndefined()
    expect(terminalContent(next, 'tab1', 'p1').status).toBe('creating')
  })

  it('is a no-op when the refusal names no usable terminal id', () => {
    const state = stateWithTerminalPane({ createRequestId: 'cr-keep', status: 'creating' })
    const next = panesReducer(
      state,
      applyReattachToLiveTerminal({ tabId: 'tab1', paneId: 'p1', terminalId: '' }),
    )
    const c = terminalContent(next, 'tab1', 'p1')
    expect(c.terminalId).toBeUndefined()
    expect(c.status).toBe('creating')
    expect(c.reconcileEpoch).toBeUndefined()
  })

  it('is a no-op when the pane id does not exist on the tab', () => {
    const state = stateWithTerminalPane({ createRequestId: 'cr-keep', status: 'creating' })
    const next = panesReducer(
      state,
      applyReattachToLiveTerminal({ tabId: 'tab1', paneId: 'p-other', terminalId: 't-x' }),
    )
    const c = terminalContent(next, 'tab1', 'p1')
    expect(c.terminalId).toBeUndefined()
    expect(c.status).toBe('creating')
    expect(c.reconcileEpoch).toBeUndefined()
  })
})
