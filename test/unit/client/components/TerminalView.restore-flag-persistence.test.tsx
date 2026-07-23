import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

// This file deliberately does NOT mock '@/lib/terminal-restore' -- it uses
// the REAL module so the regression (a restore flag surviving an
// interrupted restore round) is verified end-to-end against production
// code, not against a test double configured to say whatever we want.
//
// Incident: a server restart landed a second time, mid-restore, before a
// shell-mode amplifier pane's terminal.create ever got a terminal.created
// response. Shell-mode panes have no sessionRef (see
// tab-fallback-identity.ts), so they can't rely on App.tsx's
// terminal.inventory-driven re-arm -- the ONLY thing keeping restore:true
// alive across repeated attempts is terminal-restore.ts's flag itself.

const wsHarness = vi.hoisted(() => {
  const messageHandlers = new Set<(msg: any) => void>()
  const send = vi.fn()
  const connect = vi.fn().mockResolvedValue(undefined)
  const onMessage = vi.fn((handler: (msg: any) => void) => {
    messageHandlers.add(handler)
    return () => messageHandlers.delete(handler)
  })
  const onReconnect = vi.fn(() => () => {})
  return {
    send,
    connect,
    onMessage,
    onReconnect,
    emit(msg: any) {
      for (const handler of [...messageHandlers]) handler(msg)
    },
    reset() {
      messageHandlers.clear()
      send.mockClear()
      connect.mockClear()
      onMessage.mockClear()
      onReconnect.mockClear()
    },
  }
})

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsHarness.send,
    connect: wsHarness.connect,
    onMessage: wsHarness.onMessage,
    onReconnect: wsHarness.onReconnect,
  }),
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => ({}),
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn(() => ({ dispose: vi.fn() }))
    write = vi.fn((_data: string, cb?: () => void) => cb?.())
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn(() => ({ dispose: vi.fn() }))
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    attachCustomWheelEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

import TerminalView from '@/components/TerminalView'
import {
  addTerminalRestoreRequestId,
  clearTerminalRestoreRequestId,
  consumeTerminalRestoreRequestId,
} from '@/lib/terminal-restore'

function shellPaneContent(overrides: Partial<TerminalPaneContent> = {}): TerminalPaneContent {
  return {
    kind: 'terminal',
    createRequestId: 'req-shell-restore',
    status: 'creating',
    mode: 'shell',
    shell: 'system',
    initialCwd: '/tmp',
    ...overrides,
  }
}

function buildStoreForShellPane(tabId: string, paneId: string, paneContent: TerminalPaneContent) {
  const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }
  return configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: tabId,
          mode: 'shell',
          status: 'creating',
          title: 'Shell',
          titleSetByUser: false,
          createRequestId: paneContent.createRequestId,
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: root },
        activePane: { [tabId]: paneId },
        paneTitles: {},
      },
      settings: { settings: defaultSettings, status: 'loaded' },
      connection: { status: 'connected', error: null },
    } as any,
  })
}

function createCallsFor(requestId: string) {
  return wsHarness.send.mock.calls
    .map(([msg]) => msg)
    .filter((msg) => msg?.type === 'terminal.create' && msg.requestId === requestId)
}

describe('restore flag persists across interrupted restore rounds (real terminal-restore module)', () => {
  beforeEach(() => {
    wsHarness.reset()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
      cb(0)
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps sending restore:true across an interrupted restore round that never anchors', async () => {
    const requestId = 'req-shell-restore-persist'
    addTerminalRestoreRequestId(requestId)

    const tabId = 'tab-shell-restore-persist'
    const paneId = 'pane-shell-restore-persist'
    const paneContent = shellPaneContent({ createRequestId: requestId })
    const store = buildStoreForShellPane(tabId, paneId, paneContent)

    // --- Round 1: initial mount drives the first terminal.create. The pane
    // never anchors -- no terminal.created is ever delivered, modeling the
    // server dying before it could respond.
    const { unmount } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      const round1 = createCallsFor(requestId)
      expect(round1).toHaveLength(1)
      expect(round1[0].restore).toBe(true)
    })

    // --- Interruption: the component instance is torn down and rebuilt
    // (e.g. by a reconnect-driven remount upstream) while the persisted
    // pane state still shows an unanchored restore in progress -- status is
    // still 'creating', terminalId is still undefined. This models the
    // second server death landing mid-restore, before the first
    // terminal.create was ever answered.
    unmount()
    wsHarness.send.mockClear()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    // --- Round 2: the fresh mount re-drives creation for the SAME
    // still-unanchored createRequestId. THIS IS THE LOAD-BEARING ASSERTION:
    // under the old one-shot consume, this second terminal.create carries
    // restore:false (the flag was deleted by round 1), silently spawning a
    // fresh session with invisible history -- exactly the incident symptom.
    await waitFor(() => {
      const round2 = createCallsFor(requestId)
      expect(round2).toHaveLength(1)
      expect(round2[0].restore).toBe(true)
    })
  })

  it('clears the restore flag once the pane anchors, and does not resurrect it on a later reconnect', async () => {
    const requestId = 'req-shell-restore-anchor'
    addTerminalRestoreRequestId(requestId)
    expect(consumeTerminalRestoreRequestId(requestId)).toBe(true) // sanity: armed

    const tabId = 'tab-shell-restore-anchor'
    const paneId = 'pane-shell-restore-anchor'
    const paneContent = shellPaneContent({ createRequestId: requestId })
    const store = buildStoreForShellPane(tabId, paneId, paneContent)

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      expect(createCallsFor(requestId)).toHaveLength(1)
    })

    // Anchor: the pane receives terminal.created for this requestId.
    act(() => {
      wsHarness.emit({
        type: 'terminal.created',
        requestId,
        terminalId: 'term-shell-restore-anchor',
        createdAt: Date.now(),
      })
    })

    await waitFor(() => {
      const layout = store.getState().panes.layouts[tabId] as { type: 'leaf'; content: TerminalPaneContent }
      expect(layout.content.terminalId).toBe('term-shell-restore-anchor')
    })

    // The flag is resolved -- gone for good, matching v2 non-destructive
    // peek semantics (see terminal-restore.test.ts).
    expect(consumeTerminalRestoreRequestId(requestId)).toBe(false)

    // A reconnect AFTER anchoring goes through the attach path, not
    // sendCreate -- match current post-anchor semantics exactly: no new
    // terminal.create (let alone one with restore:true) is sent for this
    // requestId again.
    wsHarness.send.mockClear()
    act(() => {
      wsHarness.onReconnect.mock.calls.forEach(([cb]) => cb())
    })
    expect(createCallsFor(requestId)).toHaveLength(0)
  })

  it('never sends restore:true for a fresh user-created pane, even across a remount', async () => {
    const requestId = 'req-shell-fresh-pane'
    // Deliberately do NOT arm this requestId -- it's a brand new pane the
    // user just created, never part of any persisted restore set.
    clearTerminalRestoreRequestId(requestId)

    const tabId = 'tab-shell-fresh-pane'
    const paneId = 'pane-shell-fresh-pane'
    const paneContent = shellPaneContent({ createRequestId: requestId })
    const store = buildStoreForShellPane(tabId, paneId, paneContent)

    const { unmount } = render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      const calls = createCallsFor(requestId)
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls[0].restore).toBeUndefined()
    })

    unmount()
    wsHarness.send.mockClear()

    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>
    )

    await waitFor(() => {
      const calls = createCallsFor(requestId)
      expect(calls.length).toBeGreaterThanOrEqual(1)
      expect(calls[0].restore).toBeUndefined()
    })
  })
})
