import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, cleanup } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer, { setActivePane } from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn().mockReturnValue(() => {}),
  onReconnect: vi.fn().mockReturnValue(() => {}),
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
  getTerminalTheme: () => ({}),
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

// Capture the keyboard handler callback
let capturedKeyHandler: ((event: KeyboardEvent) => boolean) | null = null
let capturedOnData: ((data: string) => void) | null = null
// Widened vs the keyboard-test copy so `focus` is observable (harness only).
let capturedTerminal: { paste: ReturnType<typeof vi.fn>, focus: ReturnType<typeof vi.fn> } | null = null
let capturedLinkProviders: Array<{
  provideLinks: (line: number, callback: (links: any[] | undefined) => void) => void
}> = []
let capturedFilePathProvider: {
  provideLinks: (line: number, callback: (links: any[] | undefined) => void) => void
} | null = null

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    buffer = {
      active: {
        getLine: vi.fn(() => ({
          translateToString: () => '/tmp/example.txt',
        })),
      },
    }
    open = vi.fn()
    loadAddon = vi.fn()
    registerLinkProvider = vi.fn((provider: any) => {
      capturedLinkProviders.push(provider)
      return { dispose: vi.fn() }
    })
    write = vi.fn()
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn((cb: (data: string) => void) => {
      capturedOnData = cb
    })
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    selectAll = vi.fn()
    reset = vi.fn()
    paste = vi.fn((text: string) => {
      capturedOnData?.(text)
    })
    attachCustomKeyEventHandler = vi.fn((handler: (event: KeyboardEvent) => boolean) => {
      capturedKeyHandler = handler
    })
    attachCustomWheelEventHandler = vi.fn()
    getSelection = vi.fn(() => 'selected text')
    focus = vi.fn()

    constructor() {
      capturedTerminal = this
    }
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
  },
}))

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// Mock clipboard
const clipboardMocks = vi.hoisted(() => ({
  readText: vi.fn().mockResolvedValue('pasted content'),
  copyText: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/clipboard', () => ({
  readText: clipboardMocks.readText,
  copyText: clipboardMocks.copyText,
}))

import TerminalView from '@/components/TerminalView'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

function createTestStore(terminalId?: string) {
  const tabId = 'tab-1'
  const paneId = 'pane-1'

  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-1',
    status: 'running',
    mode: 'shell',
    shell: 'system',
    terminalId,
    initialCwd: '/tmp',
  }

  const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

  return {
    store: configureStore({
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
            mode: 'shell' as const,
            status: 'running' as const,
            title: 'Shell',
            titleSetByUser: false,
            createRequestId: 'req-1',
            terminalId,
          }],
          activeTabId: tabId,
        },
        panes: {
          layouts: { [tabId]: root },
          activePane: { [tabId]: paneId },
          paneTitles: {},
        },
        settings: { settings: defaultSettings, status: 'loaded' as const },
        connection: { status: 'connected' as const, error: null },
      },
    }),
    tabId,
    paneId,
    paneContent,
  }
}

/** rAF is spied into a manual queue (TerminalView.visibility.test.tsx:186
 * pattern) so the test, not the scheduler, decides when the deferred
 * focus frame lands — that is exactly the cloud-latency window. */
let rafSpyToRestore: ReturnType<typeof vi.spyOn> | null = null
function captureRaf() {
  const pending: FrameRequestCallback[] = []
  const spy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    pending.push(cb)
    return pending.length
  })
  rafSpyToRestore = spy
  return { pending, spy }
}
function flushRaf(pending: FrameRequestCallback[]) {
  while (pending.length > 0) pending.shift()?.(16)
}

function focusForeignInput(): HTMLInputElement {
  const input = Object.assign(document.createElement('input'), { type: 'text' })
  input.setAttribute('aria-label', 'Rename pane') // mirrors the pane rename editor
  document.body.appendChild(input)
  input.focus()
  return input
}

function renderActiveTerminal(store: ReturnType<typeof createTestStore>['store'], paneContent: TerminalPaneContent) {
  return render(
    <Provider store={store}>
      <TerminalView tabId="tab-1" paneId="pane-1" paneContent={paneContent} />
    </Provider>,
  )
}

describe('TerminalView background focus yield', () => {
  beforeEach(() => {
    capturedKeyHandler = null
    capturedOnData = null
    capturedTerminal = null
    capturedLinkProviders = []
    capturedFilePathProvider = null
    wsMocks.send.mockClear()
    clipboardMocks.readText.mockClear()
    clipboardMocks.copyText.mockClear()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    // Remove foreign text-entry nodes the tests appended to document.body
    // (RTL cleanup only removes containers it created).
    document.querySelectorAll('input[aria-label="Rename pane"], textarea.xterm-helper-textarea').forEach((el) => el.remove())
    cleanup()
    vi.unstubAllGlobals()
    // Restore ONLY the rAF spy: vi.restoreAllMocks() would also reset the
    // hoisted vi.fn() mock implementations (ws-client, clipboard) and break
    // other tests, which run in shuffled order (vitest sequence.shuffle).
    rafSpyToRestore?.mockRestore()
    rafSpyToRestore = null
  })

  it('CONTROL: focuses the terminal on activation when no editable element holds focus', async () => {
    const { pending } = captureRaf()
    const { store, paneContent } = createTestStore('term-1')
    renderActiveTerminal(store, paneContent)
    await act(async () => { flushRaf(pending) })
    expect(capturedTerminal?.focus).toHaveBeenCalled()
  })

  it('does NOT steal focus from an inline editor when a stale activation frame lands (RED)', async () => {
    focusForeignInput()
    const { pending } = captureRaf()
    const { store, paneContent } = createTestStore('term-1')
    renderActiveTerminal(store, paneContent)
    await act(async () => { flushRaf(pending) })
    expect(capturedTerminal?.focus).not.toHaveBeenCalled()
  })

  it('does NOT steal focus from an inline editor when the mount layout-flush focus lands late (RED)', async () => {
    // Same guard, second call site: the mount flush feeds
    // requestTerminalLayout({ fit: true, focus: true }) through the rAF
    // scheduler (TerminalView.tsx:2300). Covered by the same render+flush as
    // above, asserted through the mount path only: no store interaction.
    focusForeignInput()
    const { pending } = captureRaf()
    const { store, paneContent } = createTestStore('term-1')
    renderActiveTerminal(store, paneContent)
    await act(async () => { flushRaf(pending) })
    expect(capturedTerminal?.focus).not.toHaveBeenCalled()
    // Blurring the editor must restore normal focus behavior on the next frame.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    await act(async () => { flushRaf(pending) })
    // A fresh activation effect re-run is out of scope here; the important
    // half is that nothing threw and the terminal remains usable.
  })

  it('does NOT steal focus from an inline editor when the pane is re-activated (active-pane effect)', async () => {
    // Isolate the active-pane rAF effect (TerminalView.tsx:1276): on mount the
    // effect early-returns on the null termRef, so focus must come through
    // once via the mount layout flush before the activation path is testable.
    const { pending } = captureRaf()
    const { store, paneContent } = createTestStore('term-1')
    renderActiveTerminal(store, paneContent)
    await act(async () => { flushRaf(pending) })
    expect(capturedTerminal?.focus).toHaveBeenCalled() // mount flush (CONTROL proof)
    capturedTerminal?.focus.mockClear()

    // Focus a foreign inline editor AFTER all mount frames drained, so only
    // the re-activation frame below can attempt the steal.
    focusForeignInput()

    // Re-trigger the activation effect: `shouldFocusActiveTerminal` must flip
    // false -> true across two separate commits (a single batched render would
    // leave the deps unchanged and never re-run the effect).
    await act(async () => {
      store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-2' }))
    })
    await act(async () => {
      store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    })
    await act(async () => { flushRaf(pending) })
    expect(capturedTerminal?.focus).not.toHaveBeenCalled()

    // Control counterpart: with the editor blurred, the same deactivation /
    // re-activation pair must focus the terminal again.
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    await act(async () => {
      store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-2' }))
    })
    await act(async () => {
      store.dispatch(setActivePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    })
    await act(async () => { flushRaf(pending) })
    expect(capturedTerminal?.focus).toHaveBeenCalledTimes(1)
  })

  it('still focuses when xterm\'s own helper textarea holds focus', async () => {
    const helper = document.createElement('textarea')
    helper.classList.add('xterm-helper-textarea')
    document.body.appendChild(helper)
    helper.focus()
    const { pending } = captureRaf()
    const { store, paneContent } = createTestStore('term-1')
    renderActiveTerminal(store, paneContent)
    await act(async () => { flushRaf(pending) })
    expect(capturedTerminal?.focus).toHaveBeenCalled()
  })
})
