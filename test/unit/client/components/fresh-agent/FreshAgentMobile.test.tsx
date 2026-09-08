import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import sessionsReducer from '@/store/sessionsSlice'
import connectionReducer from '@/store/connectionSlice'
import settingsReducer from '@/store/settingsSlice'
import { ContextMenuProvider } from '@/components/context-menu/ContextMenuProvider'
import { ContextIds } from '@/components/context-menu/context-menu-constants'
import { FreshAgentActionSheet } from '@/components/fresh-agent/FreshAgentActionSheet'
import { FreshAgentTranscript } from '@/components/fresh-agent/FreshAgentTranscript'
import { FreshAgentComposer } from '@/components/fresh-agent/FreshAgentComposer'

vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => (
      <MarkdownRenderer content={content} />
    ),
  }
})

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn() },
}))

// Only needed by the ContextMenuProvider wrapper in the combined-gesture
// describe below; mirrors the minimal harness in ContextMenu.longpress.test.tsx.
vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onReconnect: vi.fn().mockReturnValue(() => {}),
    setHelloExtensionProvider: vi.fn(),
  }),
}))

vi.mock('@/lib/clipboard', () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}))

function stubCoarsePointer(matches: boolean) {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
}

const TURNS = [
  {
    id: 'turn-1',
    turnId: 'turn-1',
    role: 'user' as const,
    summary: 'ask',
    items: [{ id: 'item-1', kind: 'text' as const, text: 'fix the bug' }],
  },
  {
    id: 'turn-2',
    turnId: 'turn-2',
    role: 'assistant' as const,
    summary: 'answer',
    items: [
      { id: 'item-2', kind: 'text' as const, text: 'done' },
      // Fenced code block: assistant text renders as markdown, producing the
      // specialized `.prose pre code` sub-region used by the coarse-pointer
      // partition guard below.
      { id: 'item-2b', kind: 'text' as const, text: '```bash\nnpm test\n```' },
    ],
  },
]

describe('FreshAgentActionSheet', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders items, runs them, and closes', () => {
    const run = vi.fn()
    const onClose = vi.fn()
    render(
      <FreshAgentActionSheet
        title="fix the bug"
        items={[
          { label: 'Copy turn text', run },
          { label: 'Rewind code to here', disabled: true, destructive: true, run: vi.fn() },
        ]}
        onClose={onClose}
      />,
    )

    expect(screen.getByRole('menu', { name: 'fix the bug' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Rewind code to here' })).toBeDisabled()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy turn text' }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalled()
  })

  it('dismisses via backdrop and Escape', () => {
    const onClose = vi.fn()
    render(<FreshAgentActionSheet items={[{ label: 'X', run: vi.fn() }]} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})

describe('mobile coarse-pointer transcript behavior', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('shows the ⋯ trigger and opens the action sheet instead of the floating menu', () => {
    stubCoarsePointer(true)
    const onFork = vi.fn()
    render(<FreshAgentTranscript turns={TURNS} canFork onForkFromTurn={onFork} />)

    const triggers = screen.getAllByRole('button', { name: 'Turn actions menu' })
    expect(triggers).toHaveLength(2)
    fireEvent.click(triggers[0])

    const sheet = screen.getByRole('menu', { name: /fix the bug/ })
    expect(sheet).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Fork conversation from here' }))
    expect(onFork).toHaveBeenCalledWith('turn-1')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('routes contextmenu (Android long-press) to the sheet on coarse pointers', () => {
    stubCoarsePointer(true)
    render(<FreshAgentTranscript turns={TURNS} canFork={false} />)

    fireEvent.contextMenu(screen.getByRole('article', { name: 'You transcript turn' }))
    expect(screen.getByRole('menu', { name: /fix the bug/ })).toBeInTheDocument()
    expect(screen.queryByRole('menu', { name: 'Turn context menu' })).not.toBeInTheDocument()
  })

  it('yields fine-pointer right-clicks to the global provider (no transcript-owned menu)', () => {
    stubCoarsePointer(false)
    render(<FreshAgentTranscript turns={TURNS} canFork={false} />)

    expect(screen.queryByRole('button', { name: 'Turn actions menu' })).not.toBeInTheDocument()
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    act(() => {
      screen.getByRole('article', { name: 'You transcript turn' }).dispatchEvent(event)
    })
    // The transcript renders no menu of its own on fine pointers and does not
    // cancel the event — the global ContextMenuProvider's capture-phase
    // listener opens its unified menu for this gesture.
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

describe('turn gestures inside the global ContextMenuProvider (single overlay, release-safe)', () => {
  let elementFromPointMock: ReturnType<typeof vi.fn>
  let originalElementFromPoint: typeof document.elementFromPoint

  beforeEach(() => {
    vi.useFakeTimers()
    originalElementFromPoint = document.elementFromPoint
    elementFromPointMock = vi.fn().mockReturnValue(null)
    document.elementFromPoint = elementFromPointMock
  })

  afterEach(() => {
    cleanup()
    document.elementFromPoint = originalElementFromPoint
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function createMenuTestStore() {
    return configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessions: sessionsReducer,
        connection: connectionReducer,
        settings: settingsReducer,
      },
      middleware: (getDefaultMiddleware) =>
        getDefaultMiddleware({ serializableCheck: false }),
      preloadedState: {
        tabs: {
          tabs: [
            {
              id: 'tab-1',
              createRequestId: 'tab-1',
              title: 'Tab One',
              status: 'running',
              mode: 'shell',
              shell: 'system',
              createdAt: 1,
            },
          ],
          activeTabId: 'tab-1',
          renameRequestTabId: null,
        },
        panes: {
          layouts: {},
          activePane: {},
          paneTitles: {},
        },
        sessions: {
          projects: [],
          expandedProjects: new Set<string>(),
        },
        connection: {
          status: 'ready',
          platform: null,
        },
      },
    })
  }

  function renderTranscriptInProvider() {
    stubCoarsePointer(true)
    render(
      <Provider store={createMenuTestStore()}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.FreshAgent}
            data-tab-id="tab-1"
            data-pane-id="pane-1"
            data-session-id="sess-1"
            data-provider="claude"
            data-session-type="freshclaude"
          >
            <FreshAgentTranscript turns={TURNS} canFork={false} />
          </div>
        </ContextMenuProvider>
      </Provider>,
    )
  }

  function simulateTouch(
    type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
    target: Element,
    clientX = 100,
    clientY = 100,
  ) {
    const touch = { clientX, clientY, identifier: 0, target }
    const touchEvent = new TouchEvent(type, {
      bubbles: true,
      cancelable: true,
      touches: type === 'touchend' || type === 'touchcancel' ? [] : [touch as any],
      changedTouches: [touch as any],
    })
    target.dispatchEvent(touchEvent)
    return touchEvent
  }

  function releaseOverSheet(article: Element) {
    const release = simulateTouch('touchend', article, 100, 100)
    // The release was suppressed, so no compatibility click is synthesized and
    // the sheet survives the gesture untouched (assertion immediately below).
    expect(release.defaultPrevented).toBe(true)
    expect(screen.getByRole('menu', { name: /fix the bug/ })).toBeInTheDocument()
  }

  it('long-press route: only the action sheet opens, and the gesture release is suppressed', () => {
    renderTranscriptInProvider()
    const article = screen.getByRole('article', { name: 'You transcript turn' })
    elementFromPointMock.mockReturnValue(article)

    act(() => {
      simulateTouch('touchstart', article, 100, 100)
    })
    // The transcript's 450ms long-press opens the sheet first.
    act(() => {
      vi.advanceTimersByTime(450)
    })
    expect(screen.getByRole('menu', { name: /fix the bug/ })).toBeInTheDocument()

    // The global provider's 500ms long-press timer fires now — it must not
    // stack its pane menu on top of the turn's sheet.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu', { name: /fix the bug/ })).toBeInTheDocument()
    // The provider never re-probes the point (the sheet already covers it).
    expect(elementFromPointMock).not.toHaveBeenCalled()

    releaseOverSheet(article)
  })

  it('native-contextmenu route (Android): only the action sheet opens, and the gesture release is suppressed', () => {
    renderTranscriptInProvider()
    const article = screen.getByRole('article', { name: 'You transcript turn' })
    elementFromPointMock.mockReturnValue(article)

    act(() => {
      simulateTouch('touchstart', article, 100, 100)
    })
    // Android fires a real contextmenu mid-gesture, before the transcript's
    // 450ms long-press timer completes.
    fireEvent.contextMenu(article)
    expect(screen.getByRole('menu', { name: /fix the bug/ })).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu', { name: /fix the bug/ })).toBeInTheDocument()
    expect(elementFromPointMock).not.toHaveBeenCalled()

    releaseOverSheet(article)
  })

  it('late native contextmenu retargeted onto the sheet (Android): still only the sheet, release stays suppressed', () => {
    renderTranscriptInProvider()
    const article = screen.getByRole('article', { name: 'You transcript turn' })
    elementFromPointMock.mockReturnValue(article)

    act(() => {
      simulateTouch('touchstart', article, 100, 100)
    })
    // The transcript's 450ms long-press opens the full-screen sheet first.
    act(() => {
      vi.advanceTimersByTime(450)
    })
    const sheet = screen.getByRole('menu', { name: /fix the bug/ })
    expect(sheet).toBeInTheDocument()

    // The provider's 500ms timer fires now — inert for this turn-owned gesture.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(elementFromPointMock).not.toHaveBeenCalled()

    // Chromium dispatches the LATE native contextmenu via a fresh hit test
    // against the CURRENT DOM: the target is the open sheet, NOT the turn
    // article the gesture started on. Ownership must come from the gesture's
    // original target, so the provider must not stack its menu on the sheet.
    // No transcript handler runs for a sheet-targeted event, so the provider's
    // carve-out early return must also cancel it — otherwise the browser's
    // native context menu opens on top of the sheet.
    const lateContextMenu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    sheet.dispatchEvent(lateContextMenu)
    expect(lateContextMenu.defaultPrevented).toBe(true)
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu', { name: /fix the bug/ })).toBeInTheDocument()

    releaseOverSheet(article)
  })

  it('coarse guard: native contextmenu on a code block inside a turn still opens only the action sheet', () => {
    renderTranscriptInProvider()
    const codeEl = document.querySelector('article[data-turn-role="assistant"] .prose pre code') as HTMLElement | null
    expect(codeEl, 'assistant fenced code block renders .prose pre code').not.toBeNull()
    const article = codeEl!.closest('article') as HTMLElement
    elementFromPointMock.mockReturnValue(article)

    act(() => {
      simulateTouch('touchstart', codeEl!, 100, 100)
    })
    // Android fires the native contextmenu mid-gesture, targeted at the
    // specialized element. Coarse pointers keep the transcript sheet as the
    // owner of the whole turn: specialized regions never yield to the
    // provider's context-sensitive menu (that partition is fine-pointer only).
    fireEvent.contextMenu(codeEl!)
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu', { name: /^done/ })).toBeInTheDocument()

    // The provider's 500ms timer fires now — inert for this turn-owned gesture.
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(elementFromPointMock).not.toHaveBeenCalled()

    // Release suppression is still owned by the transcript's long-press
    // closure: the cancelable release is preventDefault'd and the sheet stays.
    const release = simulateTouch('touchend', codeEl!, 100, 100)
    expect(release.defaultPrevented).toBe(true)
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu', { name: /^done/ })).toBeInTheDocument()
  })

  it('keeps release suppression when the transcript rerenders mid-gesture (new actions identity)', () => {
    stubCoarsePointer(true)
    const store = createMenuTestStore()
    // Identical TURNS/content across renders; only the onForkFromTurn identity
    // changes. That rebuilds the transcript's per-turn `actions` object the
    // same way live snapshot refreshes (FreshAgentView state streaming) do.
    const tree = (onForkFromTurn: (turnId: string) => void) => (
      <Provider store={store}>
        <ContextMenuProvider
          view="terminal"
          onViewChange={() => {}}
          onToggleSidebar={() => {}}
          sidebarCollapsed={false}
        >
          <div
            data-context={ContextIds.FreshAgent}
            data-tab-id="tab-1"
            data-pane-id="pane-1"
            data-session-id="sess-1"
            data-provider="claude"
            data-session-type="freshclaude"
          >
            <FreshAgentTranscript turns={TURNS} canFork={false} onForkFromTurn={onForkFromTurn} />
          </div>
        </ContextMenuProvider>
      </Provider>
    )
    const { rerender } = render(tree(vi.fn()))
    const article = screen.getByRole('article', { name: 'You transcript turn' })
    elementFromPointMock.mockReturnValue(article)

    act(() => {
      simulateTouch('touchstart', article, 100, 100)
    })
    // 100ms into the 450ms press a live-refresh rerender lands: same turn
    // content, new `actions` identity on the article. The gesture's armed
    // timer and suppression state must survive it.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    rerender(tree(vi.fn()))
    // Sanity (assertion-state, not introspection): the article did not remount.
    expect(screen.getByRole('article', { name: 'You transcript turn' })).toBe(article)

    // The single long-press timer completes and opens the sheet for turn-1.
    act(() => {
      vi.advanceTimersByTime(350)
    })
    expect(screen.getByRole('menu', { name: /fix the bug/ })).toBeInTheDocument()

    // The provider's 500ms timer fires now and must not stack a second menu.
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(screen.getByRole('menu', { name: /fix the bug/ })).toBeInTheDocument()
    expect(elementFromPointMock).not.toHaveBeenCalled()

    // The release still hits the closure that armed the gesture: suppressed.
    releaseOverSheet(article)
  })
})

describe('mobile coarse-pointer composer keyboard behavior', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('Enter inserts a newline instead of sending on touch keyboards', () => {
    stubCoarsePointer(true)
    const onSend = vi.fn()
    render(<FreshAgentComposer commands={{ action: [], session: [] }} onSend={onSend} />)

    const input = screen.getByRole('textbox', { name: 'Chat message input' })
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('hello', [])
  })

  it('Enter still sends on fine pointers', () => {
    stubCoarsePointer(false)
    const onSend = vi.fn()
    render(<FreshAgentComposer commands={{ action: [], session: [] }} onSend={onSend} />)

    const input = screen.getByRole('textbox', { name: 'Chat message input' })
    fireEvent.change(input, { target: { value: 'hello' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('hello', [])
  })
})
