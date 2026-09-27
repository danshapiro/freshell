import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import freshAgentReducer from '@/store/freshAgentSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import terminalLifecycleReducer, {
  recordTerminalStuck,
  selectExitRecordFrom,
  selectStuckEntryFrom,
} from '@/store/terminalLifecycleSlice'
import { applyTerminalStuck } from '@/store/turnCompletionThunks'
import { updatePaneContent } from '@/store/panesSlice'
import { KILL_ACK_TIMEOUT_MS } from '@/lib/kill-ack'
import { resetPersistedLayoutCacheForTests, resetPersistFlushListenersForTests } from '@/store/persistMiddleware'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import { __resetTerminalCursorCacheForTests } from '@/lib/terminal-cursor'
import { resetHydrationQueueForTests } from '@/lib/hydration-queue'
import { installPerfAuditBridge } from '@/lib/perf-audit-bridge'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'

// Store + render harness mirrored from TerminalView.exitBanner.test.tsx
// (hoisted ws/xterm/lucide mocks, beforeEach/afterEach resets), with ONE
// deliberate divergence: the ws onMessage mock is a BROADCAST (a subscriber
// SET + emit), not a single-slot handler — the stuck-restart handlers wait
// on sendTerminalKillAndAwait, whose correlated wait subscribes its own
// onMessage listener. A single-slot mock would let the kill-wait CLOBBER the
// view's own message handler (or vice versa); the broadcast lets one emit
// reach every subscriber, exactly like the real WsClient.

const { wsMocks, wsHandlers } = vi.hoisted(() => ({
  wsMocks: {
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    onReconnect: vi.fn().mockReturnValue(() => {}),
  },
  wsHandlers: new Set<(msg: any) => void>(),
}))

const terminalThemeMocks = vi.hoisted(() => ({
  getTerminalTheme: vi.fn(() => ({})),
}))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
  }),
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: terminalThemeMocks.getTerminalTheme,
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn((_data: string, onWritten?: () => void) => {
      onWritten?.()
    })
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import TerminalView, { __resetLastSentViewportCacheForTests } from '@/components/TerminalView'
import { resetEnsureExtensionsRegistryCacheForTests } from '@/hooks/useEnsureExtensionsRegistry'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

let reconnectHandler: (() => void) | null = null
let requestAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null
let cancelAnimationFrameSpy: ReturnType<typeof vi.spyOn> | null = null

const REQ = 'req-stuck-card'
const TAB = 'tab-stuck-card'
const PANE = 'pane-stuck-card'
const TID = 'term-stuck-1'
const TID2 = 'term-stuck-2'
const SESSION_ID = 'sess-stuck-1'
/** The seeded runtime-owner record's observed fence pair (A1/F assert it rides the kill). */
const FENCE_EPOCH = 3
const FENCE_GENERATION = 8

function createSettingsState() {
  const serverSettings = createDefaultServerSettings({ loggingDebug: defaultSettings.logging.debug })
  const localSettings = resolveLocalSettings()
  return {
    serverSettings,
    localSettings,
    settings: composeResolvedSettings(serverSettings, localSettings),
    loaded: true,
    lastSavedAt: undefined,
  }
}

interface StoreOptions {
  mode?: string
  status?: TerminalPaneContent['status']
  terminalId?: string
  withSessionRef?: boolean
  /** Seed a codexDurability ref on the pane (arm F): the fresh remint must
   * clear it — an uncleared ref would ride the identity-less create and
   * restore the abandoned codex thread. */
  codexDurability?: boolean
  /** Preload a stuck entry for the pane (the flagged state). */
  stuck?: { at: number; terminalId: string }
}

function makeStore(opts: StoreOptions = {}) {
  const mode = opts.mode ?? 'opencode'
  const status = opts.status ?? 'running'
  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: REQ,
    status,
    mode: mode as TerminalPaneContent['mode'],
    shell: 'system',
    ...(opts.terminalId !== undefined ? { terminalId: opts.terminalId } : { terminalId: TID }),
    ...(opts.withSessionRef === false
      ? {}
      : { sessionRef: { provider: mode, sessionId: SESSION_ID } }),
    ...(opts.codexDurability
      ? { codexDurability: { schemaVersion: 1, state: 'durable' as const, durableThreadId: 'dur-stuck-1' } }
      : {}),
  }
  const root: PaneNode = { type: 'leaf', id: PANE, content: paneContent }
  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      terminalLifecycle: terminalLifecycleReducer,
      freshAgent: freshAgentReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: TAB, mode, status, title: 'Opencode',
          titleSetByUser: false, createRequestId: REQ,
        }],
        activeTabId: TAB,
      },
      panes: { layouts: { [TAB]: root }, activePane: { [TAB]: PANE }, paneTitles: {} },
      settings: createSettingsState(),
      connection: { status: 'connected', error: null },
      terminalLifecycle: {
        byPaneId: {},
        stuckAtByPaneId: opts.stuck ? { [PANE]: opts.stuck } : {},
      },
      // A released (vacant) owner record still carries the observed
      // (epoch, generation) fence pair — the kill fence source — while its
      // ownerKind keeps both divergence and convergence cards null so the
      // matrix isolates the stuck card.
      freshAgent: {
        sessions: {},
        pendingCreates: {},
        pendingCreateFailures: {},
        availableModels: [],
        runtimeOwners: {
          [`${mode}:${SESSION_ID}`]: {
            provider: mode,
            sessionId: SESSION_ID,
            epoch: FENCE_EPOCH,
            generation: FENCE_GENERATION,
            ownerKind: 'vacant' as const,
            previousKind: 'terminal' as const,
            transition: 'released' as const,
            updatedAt: 1,
          },
        },
      },
    } as any,
  })
  return { store, paneContent }
}

function paneState(store: ReturnType<typeof makeStore>['store']) {
  const layout = store.getState().panes.layouts[TAB] as { type: 'leaf'; content: any }
  return layout.content
}

function sentFrames() {
  return wsMocks.send.mock.calls.map(([m]) => m as Record<string, any>)
}

function sentKills() {
  return sentFrames().filter((m) => m.type === 'terminal.kill')
}

/** Broadcast one server frame to every subscribed handler (the real WsClient shape). */
function emit(msg: unknown) {
  for (const handler of [...wsHandlers]) handler(msg)
}

async function renderPane(store: any, paneContent: TerminalPaneContent) {
  const { rerender } = render(
    <Provider store={store}>
      <TerminalView tabId={TAB} paneId={PANE} paneContent={paneContent} />
    </Provider>,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(wsHandlers.size).toBeGreaterThan(0)
  return { rerender }
}

async function rerenderPane(
  rerender: ReturnType<typeof render>['rerender'],
  store: any,
) {
  rerender(
    <Provider store={store}>
      <TerminalView tabId={TAB} paneId={PANE} paneContent={paneState(store)} />
    </Provider>,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const clickRestart = () => act(async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Restart the opencode agent and resume this conversation' }))
})
const clickStartFresh = () => act(async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Start a fresh conversation' }))
})

/** Flush the microtask chain far enough for the kill-await's then-chain to run. */
async function flushAcks() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('TerminalView stuck card (wedge-backstop LB-7 matrix)', () => {
  beforeEach(() => {
    __resetTerminalCursorCacheForTests()
    __resetLastSentViewportCacheForTests()
    resetHydrationQueueForTests()
    resetPersistedLayoutCacheForTests()
    resetPersistFlushListenersForTests()
    resetEnsureExtensionsRegistryCacheForTests()
    wsHandlers.clear()
    wsMocks.send.mockClear()
    terminalThemeMocks.getTerminalTheme.mockReset()
    terminalThemeMocks.getTerminalTheme.mockReturnValue({})
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      wsHandlers.add(callback)
      return () => {
        wsHandlers.delete(callback)
      }
    })
    wsMocks.onReconnect.mockImplementation((callback: () => void) => {
      reconnectHandler = callback
      return () => {
        reconnectHandler = null
      }
    })
    requestAnimationFrameSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    installPerfAuditBridge(null)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    __resetTerminalCursorCacheForTests()
    resetHydrationQueueForTests()
    requestAnimationFrameSpy?.mockRestore()
    cancelAnimationFrameSpy?.mockRestore()
    requestAnimationFrameSpy = null
    cancelAnimationFrameSpy = null
    installPerfAuditBridge(null)
  })

  // ── The flag renders (the matrix's subject fixture) ──
  it('renders the stuck card for a flagged running agent pane', async () => {
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    await renderPane(store, paneContent)

    expect(screen.getByRole('alert')).toHaveTextContent(/appears stuck/i)
  })

  // ── A: server order (terminal.exit BEFORE the correlated terminal.killed) ──
  it('restart (arm A, server order exit→killed): fenced kill with reason stuck-recovery → exit folds → ack resolves → exactly one respawn reset', async () => {
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    const { rerender } = await renderPane(store, paneContent)

    // A1: the kill frame carries the terminalId, the observed fence pair, and
    // the load-bearing stuck-recovery reason.
    await clickRestart()
    const kills = sentKills()
    expect(kills).toHaveLength(1)
    expect(kills[0]).toMatchObject({
      type: 'terminal.kill',
      terminalId: TID,
      reason: 'stuck-recovery',
      observedEpoch: FENCE_EPOCH,
      observedGeneration: FENCE_GENERATION,
    })
    expect(typeof kills[0].requestId).toBe('string')
    const requestId = kills[0].requestId

    // A2: the exit broadcast lands first — the exit fold records the exit,
    // clears the stored terminalId, and (LB-8 belt) drops the stuck entry.
    await act(async () => {
      emit({ type: 'terminal.exit', terminalId: TID, exitCode: 0 })
    })
    expect(paneState(store).status).toBe('exited')
    expect(paneState(store).terminalId).toBeUndefined()
    expect(selectExitRecordFrom(store.getState().terminalLifecycle, PANE))
      .toEqual({ exitCode: 0, at: expect.any(Number) })
    expect(selectStuckEntryFrom(store.getState().terminalLifecycle, PANE)).toBeUndefined()

    // A3: the correlated kill ack — success is silent on the pane (no failure
    // surface), and A4: the await-first reset fires exactly once, AFTER the
    // ack resolved (the reconcileEpoch counter pins "exactly one").
    await act(async () => {
      emit({ type: 'terminal.killed', requestId, terminalId: TID, success: true })
    })
    await flushAcks()
    const content = paneState(store)
    expect(content.status).toBe('creating')
    expect(content.terminalId).toBeUndefined()
    expect(content.pendingReconcile).toBe('respawn')
    expect(content.reconcileEpoch).toBe(1)
    expect(content.sessionRef).toEqual({ provider: 'opencode', sessionId: SESSION_ID })
    // The restart discards the dead terminal's presentation state (Relaunch
    // discipline): no stale exit record survives into the respawn.
    expect(selectExitRecordFrom(store.getState().terminalLifecycle, PANE)).toBeUndefined()
    expect(screen.queryByText(/appears stuck/i)).toBeNull()

    // A-tail: the respawn drives a create (same createRequestId, restore
    // semantics), and adopting the new terminal clears a stale flag
    // (clear-on-adoption) while a re-flag self-heals (never flag-swallowing).
    await rerenderPane(rerender, store)
    const create = sentFrames().find((m) => m.type === 'terminal.create')
    expect(create).toMatchObject({ type: 'terminal.create', requestId: REQ, restore: true })

    // A late stuck:true for the DEAD terminal races the adoption — seed it.
    act(() => {
      store.dispatch(recordTerminalStuck({ paneId: PANE, terminalId: TID, at: 456 }))
    })
    await act(async () => {
      emit({ type: 'terminal.created', requestId: REQ, terminalId: TID2 })
    })
    expect(paneState(store).status).toBe('running')
    expect(paneState(store).terminalId).toBe(TID2)
    // LB-8 clear-on-adoption: the entry keyed by the OLD terminal is gone.
    expect(selectStuckEntryFrom(store.getState().terminalLifecycle, PANE)).toBeUndefined()

    // Self-healing: a genuinely wedged replacement re-flags via the next
    // sweep broadcast (the App fold's thunk) and the card re-renders.
    act(() => {
      store.dispatch(applyTerminalStuck({
        type: 'terminal.stuck',
        terminalId: TID2,
        at: 789,
        stuck: true,
      }) as any)
    })
    expect(selectStuckEntryFrom(store.getState().terminalLifecycle, PANE))
      .toEqual({ at: 789, terminalId: TID2 })
    await rerenderPane(rerender, store)
    expect(screen.getByRole('alert')).toHaveTextContent(/appears stuck/i)
  })

  // ── B: reversed order (terminal.killed BEFORE terminal.exit) ──
  it('restart (arm B, reversed killed→exit): converges identically — the late exit cannot double-consume', async () => {
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    const { rerender } = await renderPane(store, paneContent)

    await clickRestart()
    const kills = sentKills()
    expect(kills).toHaveLength(1)
    const requestId = kills[0].requestId
    expect(kills[0]).toMatchObject({ type: 'terminal.kill', terminalId: TID, reason: 'stuck-recovery' })

    // B1-B3: the correlated ack lands FIRST — the killed fold is silent on
    // success and the await-first reset still fires exactly once.
    await act(async () => {
      emit({ type: 'terminal.killed', requestId, terminalId: TID, success: true })
    })
    await flushAcks()
    let content = paneState(store)
    expect(content.status).toBe('creating')
    expect(content.pendingReconcile).toBe('respawn')

    // The ref-sync effect clears terminalIdRef once the reset's content
    // reaches the pane — propagate the store content like the parent does.
    await rerenderPane(rerender, store)

    // B4: the exit broadcast arrives LATE, naming the now-unbound dead
    // terminal — it must not double-consume (no second exit record, no
    // status regression, still exactly one reset).
    await act(async () => {
      emit({ type: 'terminal.exit', terminalId: TID, exitCode: 0 })
    })
    content = paneState(store)
    expect(content.status).toBe('creating')
    expect(content.pendingReconcile).toBe('respawn')
    expect(content.reconcileEpoch).toBe(1)
    expect(selectExitRecordFrom(store.getState().terminalLifecycle, PANE)).toBeUndefined()
  })

  // ── B': same-tick hazard (exit + killed in ONE act batch) ──
  it("restart (arm B', same-tick): exit+killed in one batch — the exit fold writes 'exited' transiently but the post-ack reset is the last writer", async () => {
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    await renderPane(store, paneContent)

    await clickRestart()
    const kills = sentKills()
    expect(kills).toHaveLength(1)
    const requestId = kills[0].requestId

    // Both frames land inside the SAME act() batch: the exit fold still
    // writes 'exited' transiently, but the batch's end state must converge
    // to the authoritative post-ack reset ('creating').
    await act(async () => {
      emit({ type: 'terminal.exit', terminalId: TID, exitCode: 0 })
      emit({ type: 'terminal.killed', requestId, terminalId: TID, success: true })
      await Promise.resolve()
      await Promise.resolve()
    })
    const content = paneState(store)
    expect(content.status).toBe('creating')
    expect(content.pendingReconcile).toBe('respawn')
    expect(content.reconcileEpoch).toBe(1)
    expect(selectExitRecordFrom(store.getState().terminalLifecycle, PANE)).toBeUndefined()
  })

  // ── C: kill-failure arms ──
  it('restart (arm C, success:false): no reconcile reset — the pane and the card stay', async () => {
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    await renderPane(store, paneContent)

    await clickRestart()
    const kills = sentKills()
    expect(kills).toHaveLength(1)
    const requestId = kills[0].requestId

    await act(async () => {
      emit({ type: 'terminal.killed', requestId, terminalId: TID, success: false, error: 'durable close failed' })
    })
    await flushAcks()

    const content = paneState(store)
    expect(content.status).toBe('running')
    expect(content.terminalId).toBe(TID)
    expect(content.pendingReconcile).toBeUndefined()
    expect(content.reconcileEpoch).toBeUndefined()
    // The card stays so the user can retry.
    expect(screen.getByRole('alert')).toHaveTextContent(/appears stuck/i)
    expect(selectStuckEntryFrom(store.getState().terminalLifecycle, PANE))
      .toEqual({ at: 123, terminalId: TID })
  })

  it('restart (arm C, kill timeout): no reconcile reset — the pane and the card stay', async () => {
    vi.useFakeTimers()
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    await renderPane(store, paneContent)

    await clickRestart()
    expect(sentKills()).toHaveLength(1)

    // No server answer at all: the bounded wait settles as a UI failure and
    // the pane keeps the card (the server close stays authoritative).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 10)
    })

    const content = paneState(store)
    expect(content.status).toBe('running')
    expect(content.pendingReconcile).toBeUndefined()
    expect(content.reconcileEpoch).toBeUndefined()
    expect(screen.getByRole('alert')).toHaveTextContent(/appears stuck/i)
  })

  // ── D: render-gate tests ──
  it('gate (arm D): a shell pane never renders the card', async () => {
    const { store, paneContent } = makeStore({
      mode: 'shell',
      withSessionRef: false,
      stuck: { at: 123, terminalId: TID },
    })
    await renderPane(store, paneContent)

    expect(screen.queryByText(/appears stuck/i)).toBeNull()
  })

  it('gate (arm D): a non-running pane never renders the card', async () => {
    const { store, paneContent } = makeStore({
      status: 'exited',
      stuck: { at: 123, terminalId: TID },
    })
    await renderPane(store, paneContent)

    // The exit banner may legitimately render for an exited pane — the
    // STUCK card specifically must not.
    expect(screen.queryByText(/appears stuck/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start a fresh conversation' })).toBeNull()
  })

  it('gate (arm D): the unstuck transition removes the card while the terminal keeps running', async () => {
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    await renderPane(store, paneContent)
    expect(screen.getByRole('alert')).toHaveTextContent(/appears stuck/i)

    // The server's stuck:false broadcast, driven through the real App fold
    // thunk (pane resolution + record/clear).
    act(() => {
      store.dispatch(applyTerminalStuck({
        type: 'terminal.stuck',
        terminalId: TID,
        at: 200,
        stuck: false,
      }) as any)
    })

    expect(selectStuckEntryFrom(store.getState().terminalLifecycle, PANE)).toBeUndefined()
    expect(screen.queryByText(/appears stuck/i)).toBeNull()
    // The terminal itself is untouched — the flag is surface-only.
    expect(paneState(store).status).toBe('running')
    expect(paneState(store).terminalId).toBe(TID)
  })

  // ── E: retention loss does not take ownership of the stuck-card action ──
  it('restart (arm E): a retention gap leaves restart available for an explicit stuck-recovery kill', async () => {
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    await renderPane(store, paneContent)

    // The mount attach is a viewport_hydrate (sinceSeq 0). A retention gap
    // reports lost history without automatically killing the running agent.
    const attach = sentFrames().find((m) => m.type === 'terminal.attach' && m.terminalId === TID)
    expect(attach).toMatchObject({ intent: 'viewport_hydrate', sinceSeq: 0 })
    await act(async () => {
      emit({
        type: 'terminal.output.gap',
        terminalId: TID,
        attachRequestId: attach!.attachRequestId,
        reason: 'replay_window_exceeded',
        fromSeq: 0,
        toSeq: 5,
      })
    })
    expect(sentKills()).toHaveLength(0)
    expect(paneState(store).status).toBe('running')

    // The user can still restart a stuck agent after losing replay history.
    await clickRestart()
    expect(sentKills()).toHaveLength(1)
    expect(sentKills()[0]).toMatchObject({ terminalId: TID, reason: 'stuck-recovery' })

    // The pane stays in place until the correlated kill is acknowledged.
    const content = paneState(store)
    expect(content.status).toBe('running')
    expect(content.pendingReconcile).toBeUndefined()
  })

  // ── F: start-fresh behavioral coverage ──
  it('start fresh (arm F): kills with the DEFAULT durable close (no reason), then remints the pane identity with the session identity cleared', async () => {
    const { store, paneContent } = makeStore({
      stuck: { at: 123, terminalId: TID },
      codexDurability: true,
    })
    await renderPane(store, paneContent)

    await clickStartFresh()
    const kills = sentKills()
    expect(kills).toHaveLength(1)
    // The fresh path rides the DEFAULT durable close: NO reason field —
    // the user is abandoning the conversation, so its identity must be
    // retired (close envelope + tombstone), mirroring the freshcodex
    // twin's startNewConversation; a resumable abandoned session could
    // resurrect as a duplicate. reason:'stuck-recovery' is the RESTART-only
    // resumable branch (delta-review r2, Major).
    expect(kills[0].reason).toBeUndefined()
    expect(kills[0]).toMatchObject({
      type: 'terminal.kill',
      terminalId: TID,
      observedEpoch: FENCE_EPOCH,
      observedGeneration: FENCE_GENERATION,
    })
    const requestId = kills[0].requestId

    await act(async () => {
      emit({ type: 'terminal.exit', terminalId: TID, exitCode: 0 })
      emit({ type: 'terminal.killed', requestId, terminalId: TID, success: true })
      await Promise.resolve()
      await Promise.resolve()
    })

    const content = paneState(store)
    expect(content.status).toBe('creating')
    // THE REMINT (focused-round-1 Finding 1): the durable close the kill
    // just journaled stores this pane's createRequestId, and recovery
    // classifies panes carrying a closed createRequestId as deliberately
    // closed — the fresh conversation must take a NEW pane identity (the
    // clearTerminalContentForRecreate remint; the freshcodex twin's
    // startNewConversation mirrors it with updatePaneContent + a fresh
    // nanoid), or it inherits the abandoned close identity and can be
    // omitted from recovery after a server restart.
    expect(content.createRequestId).not.toBe(REQ)
    expect(typeof content.createRequestId).toBe('string')
    // The remint is NOT a reconcile-verdict fold: no pendingReconcile flag
    // (a user-driven fresh start is not a verdict result) and no epoch
    // bump — the createRequestId change itself is what re-fires the
    // lifecycle effect's sendCreate (the epoch is only the same-id fold's
    // re-fire signal).
    expect(content.pendingReconcile).toBeUndefined()
    expect(content.reconcileEpoch).toBeUndefined()
    // Fresh semantics: the stale session identity is cleared — a genuinely
    // new identity-less conversation (startFreshConversation's contract).
    expect(content.sessionRef).toBeUndefined()
    expect(content.resumeSessionId).toBeUndefined()
    expect(content.codexDurability).toBeUndefined()
    expect(selectExitRecordFrom(store.getState().terminalLifecycle, PANE)).toBeUndefined()
  })

  it('start fresh (arm F, kill failure): keeps the pane and the card', async () => {
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    await renderPane(store, paneContent)

    await clickStartFresh()
    const kills = sentKills()
    expect(kills).toHaveLength(1)
    const requestId = kills[0].requestId

    await act(async () => {
      emit({ type: 'terminal.killed', requestId, terminalId: TID, success: false, error: 'durable close failed' })
    })
    await flushAcks()

    const content = paneState(store)
    expect(content.status).toBe('running')
    expect(content.sessionRef).toEqual({ provider: 'opencode', sessionId: SESSION_ID })
    expect(content.pendingReconcile).toBeUndefined()
    expect(content.reconcileEpoch).toBeUndefined()
    expect(screen.getByRole('alert')).toHaveTextContent(/appears stuck/i)
  })

  it('start fresh (arm F, kill timeout): keeps the pane and the card', async () => {
    vi.useFakeTimers()
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    await renderPane(store, paneContent)

    await clickStartFresh()
    expect(sentKills()).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(KILL_ACK_TIMEOUT_MS + 10)
    })

    const content = paneState(store)
    expect(content.status).toBe('running')
    expect(content.pendingReconcile).toBeUndefined()
    expect(screen.getByRole('alert')).toHaveTextContent(/appears stuck/i)
  })

  // ── G: in-flight re-entrancy guard (Task 4 review, Minor-1) ──
  it('restart (arm G, double-click): a second click while the kill-await is outstanding is a no-op — exactly one kill, exactly one reset', async () => {
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    await renderPane(store, paneContent)

    // Both clicks land while the first kill's bounded ack-wait
    // (KILL_ACK_TIMEOUT_MS) is still outstanding — no terminal.killed is
    // delivered between them.
    await clickRestart()
    await clickRestart()
    const kills = sentKills()
    expect(kills).toHaveLength(1)
    const requestId = kills[0].requestId
    expect(kills[0]).toMatchObject({ type: 'terminal.kill', terminalId: TID, reason: 'stuck-recovery' })

    // The one outstanding await resolves: exactly ONE reconcile reset
    // (reconcileEpoch pins the count — a re-entered second click would
    // have landed a second reset and driven it to 2).
    await act(async () => {
      emit({ type: 'terminal.exit', terminalId: TID, exitCode: 0 })
      emit({ type: 'terminal.killed', requestId, terminalId: TID, success: true })
      await Promise.resolve()
      await Promise.resolve()
    })
    const content = paneState(store)
    expect(content.pendingReconcile).toBe('respawn')
    expect(content.reconcileEpoch).toBe(1)
  })

  it('restart (arm G, failed kill): the guard clears when the await settles — a retry fires a fresh kill', async () => {
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    await renderPane(store, paneContent)

    await clickRestart()
    let kills = sentKills()
    expect(kills).toHaveLength(1)
    const firstRequestId = kills[0].requestId

    // The kill fails: no reset, the pane and the card stay (arm C's contract).
    await act(async () => {
      emit({ type: 'terminal.killed', requestId: firstRequestId, terminalId: TID, success: false, error: 'durable close failed' })
    })
    await flushAcks()
    expect(screen.getByRole('alert')).toHaveTextContent(/appears stuck/i)

    // The guard must not be a latch: the settled failure clears it, so the
    // user's retry fires a genuinely new correlated kill.
    await clickRestart()
    kills = sentKills()
    expect(kills).toHaveLength(2)
    expect(kills[1]).toMatchObject({ type: 'terminal.kill', terminalId: TID, reason: 'stuck-recovery' })
    expect(kills[1].requestId).not.toBe(firstRequestId)
  })

  // ── Store-propagation sanity (parent contract): the gate reads the pane's
  // CURRENT status, so a status flip through the store removes the card even
  // while the stale prop would still show it.
  it('the card follows the pane status through the store (a status flip to exited removes it)', async () => {
    const { store, paneContent } = makeStore({ stuck: { at: 123, terminalId: TID } })
    const { rerender } = await renderPane(store, paneContent)
    expect(screen.getByRole('alert')).toHaveTextContent(/appears stuck/i)

    act(() => {
      store.dispatch(updatePaneContent({
        tabId: TAB,
        paneId: PANE,
        content: { ...paneState(store), status: 'exited', terminalId: undefined },
      }))
    })
    await rerenderPane(rerender, store)

    expect(screen.queryByText(/appears stuck/i)).toBeNull()
  })
})
