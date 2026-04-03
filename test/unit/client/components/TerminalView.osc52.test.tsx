import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer from '@/store/tabsSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import connectionReducer from '@/store/connectionSlice'
import turnCompletionReducer from '@/store/turnCompletionSlice'
import type { PaneNode, TerminalPaneContent } from '@/store/paneTypes'
import {
  composeResolvedSettings,
  createDefaultServerSettings,
  resolveLocalSettings,
} from '@shared/settings'
import {
  OPEN_CODE_STARTUP_EXPECTED_CLEANED,
  OPEN_CODE_STARTUP_EXPECTED_REPLIES,
  OPEN_CODE_STARTUP_POST_REPLY_FRAMES,
  OPEN_CODE_STARTUP_PROBE_FRAME,
} from '@test/helpers/opencode-startup-probes'

const wsMocks = vi.hoisted(() => ({
  send: vi.fn(),
  connect: vi.fn().mockResolvedValue(undefined),
  onMessage: vi.fn(),
  onReconnect: vi.fn().mockReturnValue(() => {}),
}))

const clipboardMocks = vi.hoisted(() => ({
  copyText: vi.fn().mockResolvedValue(true),
  readText: vi.fn().mockResolvedValue(null),
}))

const apiMocks = vi.hoisted(() => ({
  patch: vi.fn().mockResolvedValue({}),
}))

const terminalTheme = {
  foreground: '#aabbcc',
  background: '#112233',
  cursor: '#ddeeff',
}

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsMocks.send,
    connect: wsMocks.connect,
    onMessage: wsMocks.onMessage,
    onReconnect: wsMocks.onReconnect,
  }),
}))

vi.mock('@/lib/clipboard', () => ({
  copyText: clipboardMocks.copyText,
  readText: clipboardMocks.readText,
}))

vi.mock('@/lib/api', () => ({
  api: {
    patch: apiMocks.patch,
  },
}))

vi.mock('@/lib/terminal-themes', () => ({
  getTerminalTheme: () => terminalTheme,
}))

vi.mock('@/components/terminal/terminal-runtime', () => ({
  createTerminalRuntime: () => ({
    attachAddons: vi.fn(),
    fit: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
    webglActive: vi.fn(() => false),
  }),
}))

vi.mock('lucide-react', () => ({
  Loader2: ({ className }: { className?: string }) => <svg data-testid="loader" className={className} />,
}))

const terminalInstances: any[] = []
const latestAttachRequestIdByTerminal = new Map<string, string>()
const ioEvents: Array<{ kind: 'send' | 'write', type?: string, data: string }> = []

function withCurrentAttachRequestId(msg: any) {
  if (
    msg?.attachRequestId
    || typeof msg?.terminalId !== 'string'
    || (msg?.type !== 'terminal.attach.ready' && msg?.type !== 'terminal.output' && msg?.type !== 'terminal.output.gap')
  ) {
    return msg
  }
  const attachRequestId = latestAttachRequestIdByTerminal.get(msg.terminalId)
  return attachRequestId ? { ...msg, attachRequestId } : msg
}

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    cols = 80
    rows = 24
    open = vi.fn()
    loadAddon = vi.fn()
    write = vi.fn((data: string) => {
      ioEvents.push({ kind: 'write', data: String(data) })
    })
    writeln = vi.fn()
    clear = vi.fn()
    dispose = vi.fn()
    onData = vi.fn()
    onTitleChange = vi.fn(() => ({ dispose: vi.fn() }))
    attachCustomKeyEventHandler = vi.fn()
    getSelection = vi.fn(() => '')
    focus = vi.fn()
    constructor() {
      terminalInstances.push(this)
    }
  }

  return { Terminal: MockTerminal }
})

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

import TerminalView from '@/components/TerminalView'

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
  unobserve = vi.fn()
}

const OSC52_COPY = '\u001b]52;c;Y29weQ==\u0007'

const defaultServerSettings = createDefaultServerSettings({
  loggingDebug: defaultSettings.logging.debug,
})

function createSettingsState(policy: 'ask' | 'always' | 'never') {
  const localSettings = resolveLocalSettings({
    terminal: {
      osc52Clipboard: policy,
    },
  })

  return {
    serverSettings: defaultServerSettings,
    localSettings,
    settings: composeResolvedSettings(defaultServerSettings, localSettings),
    loaded: true,
    lastSavedAt: undefined,
  }
}

function createStore(policy: 'ask' | 'always' | 'never') {
  const tabId = 'tab-osc52'
  const paneId = 'pane-osc52'
  const terminalId = 'term-osc52'

  const paneContent: TerminalPaneContent = {
    kind: 'terminal',
    createRequestId: 'req-osc52',
    status: 'running',
    mode: 'codex',
    shell: 'system',
    terminalId,
  }

  const root: PaneNode = { type: 'leaf', id: paneId, content: paneContent }

  const store = configureStore({
    reducer: {
      tabs: tabsReducer,
      panes: panesReducer,
      settings: settingsReducer,
      connection: connectionReducer,
      turnCompletion: turnCompletionReducer,
    },
    preloadedState: {
      tabs: {
        tabs: [{
          id: tabId,
          mode: 'codex',
          status: 'running',
          title: 'Codex',
          terminalId,
          createRequestId: 'req-osc52',
        }],
        activeTabId: tabId,
      },
      panes: {
        layouts: { [tabId]: root },
        activePane: { [tabId]: paneId },
        paneTitles: {},
      },
      settings: createSettingsState(policy),
      connection: { status: 'ready', error: null },
      turnCompletion: { seq: 0, lastEvent: null, pendingEvents: [], attentionByTab: {}, attentionByPane: {} },
    } as any,
  })

  return { store, tabId, paneId, paneContent, terminalId }
}

describe('TerminalView OSC52 policy handling', () => {
  let messageHandler: ((msg: any) => void) | null = null

  beforeEach(() => {
    terminalInstances.length = 0
    latestAttachRequestIdByTerminal.clear()
    ioEvents.length = 0
    wsMocks.send.mockClear()
    wsMocks.send.mockImplementation((msg: any) => {
      if (msg?.type === 'terminal.input' && typeof msg?.data === 'string') {
        ioEvents.push({ kind: 'send', type: msg.type, data: msg.data })
      }
      if (
        msg?.type === 'terminal.attach'
        && typeof msg?.terminalId === 'string'
        && typeof msg?.attachRequestId === 'string'
      ) {
        latestAttachRequestIdByTerminal.set(msg.terminalId, msg.attachRequestId)
      }
    })
    wsMocks.connect.mockClear()
    wsMocks.onMessage.mockImplementation((callback: (msg: any) => void) => {
      messageHandler = (msg: any) => callback(withCurrentAttachRequestId(msg))
      return () => { messageHandler = null }
    })
    clipboardMocks.copyText.mockClear()
    clipboardMocks.copyText.mockResolvedValue(true)
    apiMocks.patch.mockClear()
    vi.stubGlobal('ResizeObserver', MockResizeObserver)
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    messageHandler = null
  })

  async function renderView(policy: 'ask' | 'always' | 'never') {
    const { store, tabId, paneId, paneContent, terminalId } = createStore(policy)
    render(
      <Provider store={store}>
        <TerminalView tabId={tabId} paneId={paneId} paneContent={paneContent} />
      </Provider>,
    )
    await waitFor(() => {
      expect(messageHandler).not.toBeNull()
    })
    return { store, terminalId }
  }

  function writeEvents() {
    return ioEvents.filter((event) => event.kind === 'write')
  }

  function postReplySeqRange(index: number) {
    if (index === 0) {
      return { seqStart: 2, seqEnd: 4 }
    }
    const seq = index + 4
    return { seqStart: seq, seqEnd: seq }
  }

  it('always policy copies silently without prompt', async () => {
    const { terminalId } = await renderView('always')
    messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: `before${OSC52_COPY}after` })

    await waitFor(() => {
      expect(terminalInstances[0].write).toHaveBeenCalledWith('beforeafter', undefined)
    })
    expect(clipboardMocks.copyText).toHaveBeenCalledWith('copy')
    expect(screen.queryByRole('dialog', { name: 'Clipboard access request' })).not.toBeInTheDocument()
  })

  it('strips startup probes, sends replies before writing visible output, and preserves OSC52 handling', async () => {
    const { terminalId } = await renderView('always')
    wsMocks.send.mockClear()
    ioEvents.length = 0

    messageHandler!({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: OPEN_CODE_STARTUP_PROBE_FRAME,
    })

    expect(terminalInstances[0].write).not.toHaveBeenCalled()

    const probeInputMessages = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg?.type === 'terminal.input')
    expect(probeInputMessages).toEqual(
      OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({
        type: 'terminal.input',
        terminalId,
        data,
      })),
    )
    expect(ioEvents).toEqual([
      ...OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({ kind: 'send' as const, type: 'terminal.input', data })),
    ])

    OPEN_CODE_STARTUP_POST_REPLY_FRAMES.forEach((frame, index) => {
      const range = postReplySeqRange(index)
      messageHandler!({
        type: 'terminal.output',
        terminalId,
        seqStart: range.seqStart,
        seqEnd: range.seqEnd,
        data: `${frame}${index === OPEN_CODE_STARTUP_POST_REPLY_FRAMES.length - 1 ? OSC52_COPY : ''}`,
      })
    })

    await waitFor(() => {
      expect(writeEvents().map((event) => event.data).join('')).toBe(OPEN_CODE_STARTUP_EXPECTED_CLEANED)
    })

    expect(clipboardMocks.copyText).toHaveBeenCalledWith('copy')
    expect(screen.queryByRole('dialog', { name: 'Clipboard access request' })).not.toBeInTheDocument()

    const inputMessages = wsMocks.send.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg?.type === 'terminal.input')
    expect(inputMessages).toEqual(
      OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({
        type: 'terminal.input',
        terminalId,
        data,
      })),
    )

    expect(ioEvents).toEqual([
      ...OPEN_CODE_STARTUP_EXPECTED_REPLIES.map((data) => ({ kind: 'send' as const, type: 'terminal.input', data })),
      ...OPEN_CODE_STARTUP_POST_REPLY_FRAMES.map((data) => ({ kind: 'write' as const, data })),
    ])
  })

  it('never policy does not copy and does not prompt', async () => {
    const { terminalId } = await renderView('never')
    messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: `before${OSC52_COPY}after` })

    await waitFor(() => {
      expect(terminalInstances[0].write).toHaveBeenCalledWith('beforeafter', undefined)
    })
    expect(clipboardMocks.copyText).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Clipboard access request' })).not.toBeInTheDocument()
  })

  it('ask + Yes copies once and keeps ask policy', async () => {
    const { store, terminalId } = await renderView('ask')
    act(() => {
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: `before${OSC52_COPY}after` })
    })
    await screen.findByRole('button', { name: 'Yes' })

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))

    expect(clipboardMocks.copyText).toHaveBeenCalledWith('copy')
    expect(store.getState().settings.settings.terminal.osc52Clipboard).toBe('ask')
  })

  it('ask + No does not copy and keeps ask policy', async () => {
    const { store, terminalId } = await renderView('ask')
    act(() => {
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: `before${OSC52_COPY}after` })
    })
    await screen.findByRole('button', { name: 'No' })

    fireEvent.click(screen.getByRole('button', { name: 'No' }))

    expect(clipboardMocks.copyText).not.toHaveBeenCalled()
    expect(store.getState().settings.settings.terminal.osc52Clipboard).toBe('ask')
  })

  it('ask + Always copies and persists always policy locally', async () => {
    const { store, terminalId } = await renderView('ask')
    act(() => {
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: `before${OSC52_COPY}after` })
    })
    await screen.findByRole('button', { name: 'Always' })

    fireEvent.click(screen.getByRole('button', { name: 'Always' }))

    expect(clipboardMocks.copyText).toHaveBeenCalledWith('copy')
    expect(store.getState().settings.settings.terminal.osc52Clipboard).toBe('always')
    expect(store.getState().settings.localSettings.terminal.osc52Clipboard).toBe('always')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('ask + Never does not copy and persists never policy locally', async () => {
    const { store, terminalId } = await renderView('ask')
    act(() => {
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: `before${OSC52_COPY}after` })
    })
    await screen.findByRole('button', { name: 'Never' })

    fireEvent.click(screen.getByRole('button', { name: 'Never' }))

    expect(clipboardMocks.copyText).not.toHaveBeenCalled()
    expect(store.getState().settings.settings.terminal.osc52Clipboard).toBe('never')
    expect(store.getState().settings.localSettings.terminal.osc52Clipboard).toBe('never')
    expect(apiMocks.patch).not.toHaveBeenCalled()
  })

  it('swallows clipboard write rejection', async () => {
    clipboardMocks.copyText.mockRejectedValueOnce(new Error('clipboard blocked'))
    const { terminalId } = await renderView('ask')
    act(() => {
      messageHandler!({ type: 'terminal.output', terminalId, seqStart: 1, seqEnd: 1, data: `before${OSC52_COPY}after` })
    })
    await screen.findByRole('button', { name: 'Yes' })

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }))
    await act(async () => Promise.resolve())

    expect(screen.queryByRole('dialog', { name: 'Clipboard access request' })).not.toBeInTheDocument()
  })
})
