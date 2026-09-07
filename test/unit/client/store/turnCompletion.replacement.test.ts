// Lane D1: the busy/idle tracker and turn-complete dedupe survive the
// terminal being replaced under the pane by server-driven auto-resume.
//
// The fold under test mirrors TerminalView's terminal.replaced handler
// (TerminalView.tsx:4147-4178): foldTerminalReplacement into the ephemeral
// lifecycle slice, then applyReconcileAttach — the ONE reducer that writes a
// server-supplied terminalId into a live pane (panesSlice.ts:1886).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import { applyServerIdle } from '@/store/turnCompletionThunks'
import panesReducer, { applyReconcileAttach } from '@/store/panesSlice'
import tabsReducer from '@/store/tabsSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import terminalLifecycleReducer, { foldTerminalReplacement } from '@/store/terminalLifecycleSlice'
import { terminalDetachMiddleware } from '@/store/terminalDetachMiddleware'
import { resolvePaneActivity } from '@/lib/pane-activity'
import { findPaneContent } from '@/lib/pane-utils'
import type { TerminalPaneContent } from '@/store/paneTypes'
import type { ClaudeActivityRecord } from '@shared/ws-protocol'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: mockSend }),
}))

const TAB_ID = 'tab-1'
const PANE_ID = 'pane-1'
const OLD_ID = 't1'
const NEW_ID = 't2'

function createStore(seedIdleBaselines: Record<string, number> = {}) {
  const now = Date.now()
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      turnCompletion: turnCompletionReducer,
      terminalLifecycle: terminalLifecycleReducer,
    },
    // Realistic harness: the app store runs the detach reconciler, so the
    // fold is exercised WITH it installed (pin 4 asserts on its ws traffic).
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(terminalDetachMiddleware),
    preloadedState: {
      tabs: {
        tabs: [{ id: TAB_ID, createRequestId: 'req-1', title: 'Tab 1', status: 'running' as const, mode: 'claude' as const, shell: 'system' as const, createdAt: now }],
        activeTabId: TAB_ID,
        renameRequestTabId: null,
      },
      panes: {
        layouts: {
          [TAB_ID]: {
            type: 'leaf' as const,
            id: PANE_ID,
            content: {
              kind: 'terminal' as const,
              createRequestId: 'cr-1',
              status: 'running' as const,
              mode: 'claude' as const,
              shell: 'system' as const,
              terminalId: OLD_ID,
            },
          },
        },
        activePane: { [TAB_ID]: PANE_ID },
        paneTitles: {},
        paneTitleSetByUser: {},
        renameRequestTabId: null,
        renameRequestPaneId: null,
        zoomedPane: {},
        refreshRequestsByPane: {},
      },
      settings: { settings: defaultSettings, loaded: true },
      turnCompletion: {
        seq: 0,
        lastAtByTerminalId: {},
        lastIdleAtByTerminalId: seedIdleBaselines,
        pendingEvents: [],
        attentionByTab: {},
        attentionByPane: {},
      },
      terminalLifecycle: { byPaneId: {} },
    },
  })
}

type Store = ReturnType<typeof createStore>

/** Fold t1 -> t2 exactly as TerminalView's terminal.replaced handler does. */
function foldReplacement(
  store: Store,
  runtime?: { runtimeId: string; generation: number },
) {
  store.dispatch(foldTerminalReplacement({
    paneId: PANE_ID,
    newTerminalId: NEW_ID,
    exitCode: 1,
    attempt: 1,
    maxAttempts: 2,
    at: 50,
  }))
  store.dispatch(applyReconcileAttach({
    tabId: TAB_ID,
    paneId: PANE_ID,
    terminalId: NEW_ID,
    serverInstanceId: undefined,
    runtime,
  }))
}

function dispatchServerIdle(store: Store, terminalId: string, at: number) {
  // Same cast the sibling turnCompletionSlice tests use for this thunk.
  store.dispatch(applyServerIdle({ terminalId, at, reason: 'grace' }) as any)
}

function detachedIds(): string[] {
  return mockSend.mock.calls
    .map(([msg]) => msg as { type?: string; terminalId?: string })
    .filter((msg) => msg?.type === 'terminal.detach')
    .map((msg) => msg.terminalId as string)
}

beforeEach(() => {
  mockSend.mockClear()
})

describe('turn completion across terminal.replaced fold', () => {
  it('chimes exactly once for terminal.idle on the NEW terminalId after the fold', () => {
    // The old id carries a high idle baseline: the new id must start FRESH in
    // the per-terminalId dedupe map, so a lower `at` on t2 still rings.
    const store = createStore({ [OLD_ID]: 500 })
    foldReplacement(store)

    dispatchServerIdle(store, NEW_ID, 100)
    // Replayed/stale edge with the same at is deduped — still exactly one.
    dispatchServerIdle(store, NEW_ID, 100)

    expect(store.getState().turnCompletion.pendingEvents).toEqual([{
      tabId: TAB_ID,
      paneId: PANE_ID,
      terminalId: NEW_ID,
      at: 100,
      seq: 1,
    }])
    expect(store.getState().turnCompletion.lastIdleAtByTerminalId?.[NEW_ID]).toBe(100)
  })

  it('drops terminal.idle for the OLD terminalId after the fold (no false chime)', () => {
    const store = createStore()
    foldReplacement(store)

    // Owner lookup finds no pane for t1 (turnCompletionThunks.ts:25-26):
    // the edge is dropped without ringing and without consuming a baseline.
    dispatchServerIdle(store, OLD_ID, 200)

    expect(store.getState().turnCompletion.pendingEvents).toEqual([])
    expect(store.getState().turnCompletion.lastIdleAtByTerminalId?.[OLD_ID]).toBeUndefined()
  })

  it('pane activity resolves via the NEW terminalId after the fold (no permanent wedge)', () => {
    const store = createStore()
    foldReplacement(store)

    const layout = store.getState().panes.layouts[TAB_ID]
    expect(layout).toBeDefined()
    const content = findPaneContent(layout!, PANE_ID) as TerminalPaneContent
    expect(content.terminalId).toBe(NEW_ID)
    expect(content.status).toBe('running')

    const activityInput = (records: Record<string, ClaudeActivityRecord>) => ({
      paneId: PANE_ID,
      content,
      isOnlyPane: true,
      codexActivityByTerminalId: {},
      opencodeActivityByTerminalId: {},
      claudeActivityByTerminalId: records,
      amplifierActivityByTerminalId: {},
      paneRuntimeActivityByPaneId: {},
    })

    // An activity record for the NEW id is what the pane reads now
    // (pane-activity.ts joins on paneContent.terminalId).
    expect(resolvePaneActivity(activityInput({
      [NEW_ID]: { terminalId: NEW_ID, phase: 'busy', updatedAt: 1_000 },
    }))).toEqual({ isBusy: true, source: 'claude-terminal' })

    // A leftover record for the dead OLD id can no longer wedge the pane busy.
    expect(resolvePaneActivity(activityInput({
      [OLD_ID]: { terminalId: OLD_ID, phase: 'busy', updatedAt: 1_000 },
    }))).toEqual({ isBusy: false, source: null })
  })

  it('rebinds a generation-fenced pane only when the replacement descriptor is folded', () => {
    const store = createStore()
    const oldRuntime = { runtimeId: OLD_ID, generation: 1 }
    store.dispatch(applyReconcileAttach({
      tabId: TAB_ID,
      paneId: PANE_ID,
      terminalId: OLD_ID,
      runtime: oldRuntime,
    }))

    foldReplacement(store)
    let content = findPaneContent(
      store.getState().panes.layouts[TAB_ID]!,
      PANE_ID,
    ) as TerminalPaneContent
    expect(content.terminalId).toBe(OLD_ID)

    const replacementRuntime = { runtimeId: NEW_ID, generation: 2 }
    foldReplacement(store, replacementRuntime)
    content = findPaneContent(
      store.getState().panes.layouts[TAB_ID]!,
      PANE_ID,
    ) as TerminalPaneContent
    expect(content.terminalId).toBe(NEW_ID)
    expect(content.runtimeId).toBe(NEW_ID)
    expect(content.runtimeGeneration).toBe(2)
  })

  it('the fold does not emit a terminal.detach for the old terminalId', () => {
    const store = createStore()
    mockSend.mockClear()

    foldReplacement(store)

    // The old terminal is already exited server-side; a detach for it would
    // draw a server error (applyReconcileAttach must be in the skip list,
    // terminalDetachMiddleware.ts:25-31).
    expect(detachedIds()).toEqual([])
    expect(mockSend).not.toHaveBeenCalled()
  })
})
