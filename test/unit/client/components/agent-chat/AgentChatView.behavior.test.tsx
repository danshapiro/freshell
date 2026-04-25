import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup, within, act, fireEvent, waitFor } from '@testing-library/react'
import { configureStore } from '@reduxjs/toolkit'
import { Provider } from 'react-redux'
import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer, {
  capabilityFetchSucceeded,
  sessionCreated,
  addUserMessage,
  addAssistantMessage,
  appendStreamDelta,
  setStreaming,
  setSessionStatus,
} from '@/store/agentChatSlice'
import panesReducer from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import type { AgentChatPaneContent } from '@/store/paneTypes'
import type { ChatContentBlock } from '@/store/agentChatTypes'

// jsdom doesn't implement scrollIntoView
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const wsSendSpy = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsSendSpy,
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

const saveServerSettingsPatchSpy = vi.hoisted(() => vi.fn((patch: unknown) => ({
  type: 'settings/saveServerSettingsPatch',
  payload: patch,
})))

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
}))

function makeStore(settingsOverrides?: Record<string, unknown>) {
  return configureStore({
    reducer: {
      agentChat: agentChatReducer,
      panes: panesReducer,
      settings: settingsReducer,
    },
    preloadedState: {
      settings: {
        settings: {
          ...defaultSettings,
          ...(settingsOverrides || {}),
        } as any,
        loaded: true,
        lastSavedAt: 0,
      },
    },
  })
}

afterEach(() => {
  wsSendSpy.mockClear()
  saveServerSettingsPatchSpy.mockClear()
})

const BASE_PANE: AgentChatPaneContent = {
  kind: 'agent-chat', provider: 'freshclaude',
  createRequestId: 'req-1',
  sessionId: 'sess-1',
  status: 'idle',
}

/** Add N user→assistant turn pairs to a session in the store. */
function addTurns(
  store: ReturnType<typeof makeStore>,
  count: number,
  toolsPerTurn = 0,
) {
  for (let i = 0; i < count; i++) {
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: `Question ${i + 1}` }))
    const content: ChatContentBlock[] = [{ type: 'text', text: `Answer ${i + 1}` }]
    for (let t = 0; t < toolsPerTurn; t++) {
      const toolId = `tool-${i}-${t}`
      content.push({
        type: 'tool_use',
        id: toolId,
        name: 'Bash',
        input: { command: `echo ${t}` },
      })
      content.push({
        type: 'tool_result',
        tool_use_id: toolId,
        content: `output ${t}`,
      })
    }
    store.dispatch(addAssistantMessage({ sessionId: 'sess-1', content }))
  }
  // Reset to idle (addAssistantMessage sets to 'running')
  store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))
}

describe('AgentChatView turn collapsing', () => {
  afterEach(cleanup)

  it('shows all turns expanded when total turns <= RECENT_TURNS_FULL (3)', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    addTurns(store, 3)

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // All 3 answers should be visible as expanded MessageBubbles
    expect(screen.getByText('Answer 1')).toBeInTheDocument()
    expect(screen.getByText('Answer 2')).toBeInTheDocument()
    expect(screen.getByText('Answer 3')).toBeInTheDocument()
    // No collapsed turn summaries should appear
    expect(screen.queryByLabelText('Expand turn')).not.toBeInTheDocument()
  })

  it('collapses old turns when total turns > RECENT_TURNS_FULL', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    addTurns(store, 5)

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // The 2 oldest turns should be collapsed (5 - 3 = 2)
    const expandButtons = screen.getAllByLabelText('Expand turn')
    expect(expandButtons).toHaveLength(2)

    // The 3 most recent turns should show their full content
    expect(screen.getByText('Answer 3')).toBeInTheDocument()
    expect(screen.getByText('Answer 4')).toBeInTheDocument()
    expect(screen.getByText('Answer 5')).toBeInTheDocument()
  })
})

describe('AgentChatView thinking indicator', () => {
  afterEach(cleanup)

  it('shows thinking indicator when running + no streaming + last message is user', () => {
    vi.useFakeTimers()
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Do something' }))
    // addUserMessage sets status to 'running'

    const pane: AgentChatPaneContent = { ...BASE_PANE, status: 'running' }
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // ThinkingIndicator has a 200ms debounce
    expect(screen.queryByLabelText('Claude is thinking')).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.getByLabelText('Claude is thinking')).toBeInTheDocument()

    vi.useRealTimers()
  })

  it('does not show thinking indicator when last message is assistant', () => {
    vi.useFakeTimers()
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Hello' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Hi there' }],
    }))
    // Status is running, but last message is assistant

    const pane: AgentChatPaneContent = { ...BASE_PANE, status: 'running' }
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    act(() => { vi.advanceTimersByTime(250) })
    expect(screen.queryByLabelText('Claude is thinking')).not.toBeInTheDocument()

    vi.useRealTimers()
  })
})

describe('AgentChatView streaming preview lifecycle', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('removes the stale streaming preview once the final assistant message is committed', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(setStreaming({ sessionId: 'sess-1', active: true }))
    store.dispatch(appendStreamDelta({ sessionId: 'sess-1', text: 'partial reply' }))
    store.dispatch(setStreaming({ sessionId: 'sess-1', active: false }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'final reply' }],
    }))

    const pane: AgentChatPaneContent = { ...BASE_PANE, status: 'running' }
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    expect(screen.getByText('final reply')).toBeInTheDocument()
    expect(screen.queryByText('partial reply')).not.toBeInTheDocument()
  })
})

describe('AgentChatView density', () => {
  afterEach(cleanup)

  it('uses tighter status and message area spacing', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Hello' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Hi there' }],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    const { container } = render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    const statusBar = screen.getByText('Ready').closest('div') as HTMLElement
    expect(statusBar.className).toContain('py-1')

    const scrollArea = container.querySelector('[data-context="agent-chat"]') as HTMLElement
    expect(scrollArea.className).toContain('px-3')
    expect(scrollArea.className).toContain('py-3')
    expect(scrollArea.className).toContain('space-y-2')
  })
})

describe('AgentChatView turn-pairing edge cases', () => {
  afterEach(cleanup)

  it('handles consecutive user messages without assistant in between', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    // Dispatch: user1, user2, assistant1, user3, assistant2
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'First question' }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Second question' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Reply to second' }],
    }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Third question' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'Reply to third' }],
    }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'idle' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // user1 is standalone (no adjacent assistant), user2+assistant1 paired, user3+assistant2 paired.
    // All messages should be visible since there are only 2 turns (< RECENT_TURNS_FULL).
    expect(screen.getByText('First question')).toBeInTheDocument()
    expect(screen.getByText('Second question')).toBeInTheDocument()
    expect(screen.getByText('Reply to second')).toBeInTheDocument()
    expect(screen.getByText('Third question')).toBeInTheDocument()
    expect(screen.getByText('Reply to third')).toBeInTheDocument()

    // Verify ordering: "First question" appears before "Second question" in DOM
    const allMessages = screen.getAllByRole('article')
    const firstIdx = allMessages.findIndex(el => el.textContent?.includes('First question'))
    const secondIdx = allMessages.findIndex(el => el.textContent?.includes('Second question'))
    expect(firstIdx).toBeLessThan(secondIdx)
  })

  it('renders trailing unpaired user message after completed turns', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    // Dispatch: user1, assistant1, user2 (no reply yet)
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Answered question' }))
    store.dispatch(addAssistantMessage({
      sessionId: 'sess-1',
      content: [{ type: 'text', text: 'The answer' }],
    }))
    store.dispatch(addUserMessage({ sessionId: 'sess-1', text: 'Waiting for reply' }))
    store.dispatch(setSessionStatus({ sessionId: 'sess-1', status: 'running' }))

    const pane: AgentChatPaneContent = { ...BASE_PANE, status: 'running' }
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // All three messages should be visible
    expect(screen.getByText('Answered question')).toBeInTheDocument()
    expect(screen.getByText('The answer')).toBeInTheDocument()
    expect(screen.getByText('Waiting for reply')).toBeInTheDocument()

    // Trailing user message should appear after the completed turn
    const allMessages = screen.getAllByRole('article')
    const answerIdx = allMessages.findIndex(el => el.textContent?.includes('The answer'))
    const waitingIdx = allMessages.findIndex(el => el.textContent?.includes('Waiting for reply'))
    expect(waitingIdx).toBeGreaterThan(answerIdx)
  })
})

describe('AgentChatView tool blocks expanded by default', () => {
  afterEach(() => {
    cleanup()
  })

  it('all tool blocks start expanded when showTools is true', () => {
    const store = makeStore({ agentChat: { ...defaultSettings.agentChat, showTools: true } })
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    // Create a turn with 5 completed tools
    addTurns(store, 1, 5)

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    // With showTools=true (default), all tools should start expanded
    const toolButtons = screen.getAllByRole('button', { name: /tool call/i })
    expect(toolButtons).toHaveLength(5)

    // All tools should be expanded (aria-expanded=true)
    expect(toolButtons[0]).toHaveAttribute('aria-expanded', 'true')
    expect(toolButtons[1]).toHaveAttribute('aria-expanded', 'true')
    expect(toolButtons[2]).toHaveAttribute('aria-expanded', 'true')
    expect(toolButtons[3]).toHaveAttribute('aria-expanded', 'true')
    expect(toolButtons[4]).toHaveAttribute('aria-expanded', 'true')
  })
})

describe('AgentChatView composer focus', () => {
  afterEach(cleanup)

  it('auto-focuses composer on mount when settings are already dismissed', () => {
    vi.useFakeTimers()
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    const pane: AgentChatPaneContent = { ...BASE_PANE, settingsDismissed: true }
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={pane} />
      </Provider>,
    )

    // ChatComposer's autoFocus useEffect uses a 50ms delay
    act(() => { vi.advanceTimersByTime(60) })
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).toHaveFocus()
    vi.useRealTimers()
  })

  it('does not auto-focus composer when settings panel is open', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    // settingsDismissed is undefined/false, so settings panel opens
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    expect(screen.getByRole('textbox', { name: 'Chat message input' })).not.toHaveFocus()
  })
})

describe('AgentChatView settings auto-open (#110)', () => {
  afterEach(cleanup)

  it('opens settings on first-ever launch (no global flag, no pane flag)', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    expect(screen.getByRole('dialog', { name: 'Agent chat settings' })).toBeInTheDocument()
  })

  it('does not open settings on new pane when global initialSetupDone is true', () => {
    const store = makeStore({ agentChat: { ...defaultSettings.agentChat, initialSetupDone: true, providers: {} } })
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    // Fresh pane (no settingsDismissed), but global flag is set
    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    expect(screen.queryByRole('dialog', { name: 'Agent chat settings' })).not.toBeInTheDocument()
  })

  it('does not open settings while global settings are still loading', () => {
    const store = configureStore({
      reducer: {
        agentChat: agentChatReducer,
        panes: panesReducer,
        settings: settingsReducer,
      },
      preloadedState: {
        settings: {
          settings: { ...defaultSettings } as any,
          loaded: false,
          lastSavedAt: 0,
        },
      },
    })
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    expect(screen.queryByRole('dialog', { name: 'Agent chat settings' })).not.toBeInTheDocument()
  })

  it('auto-focuses composer when global initialSetupDone skips settings', () => {
    vi.useFakeTimers()
    const store = makeStore({ agentChat: { ...defaultSettings.agentChat, initialSetupDone: true, providers: {} } })
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    act(() => { vi.advanceTimersByTime(60) })
    expect(screen.getByRole('textbox', { name: 'Chat message input' })).toHaveFocus()
    vi.useRealTimers()
  })

  it('persists provider defaults through saveServerSettingsPatch when settings change', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(capabilityFetchSucceeded({
      provider: 'freshclaude',
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: Date.now(),
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Latest Opus track',
            supportsEffort: true,
            supportedEffortLevels: ['low', 'medium', 'high'],
            supportsAdaptiveThinking: true,
          },
          {
            id: 'claude-sonnet-4-6',
            displayName: 'Claude Sonnet 4.6',
            description: 'Balanced path',
            supportsEffort: true,
            supportedEffortLevels: ['medium', 'high'],
            supportsAdaptiveThinking: true,
          },
        ],
      },
    }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Agent chat settings' })
    const modelSelect = within(dialog).getByLabelText('Model') as HTMLSelectElement
    const sonnetValue = Array.from(modelSelect.options).find(
      (option) => option.text === 'Claude Sonnet 4.6',
    )?.value
    fireEvent.change(modelSelect, { target: { value: sonnetValue } })
    fireEvent.change(within(dialog).getByLabelText('Permissions'), { target: { value: 'default' } })
    fireEvent.change(within(dialog).getByLabelText('Effort'), { target: { value: 'medium' } })

    expect(wsSendSpy).toHaveBeenCalledWith({
      type: 'sdk.set-model',
      sessionId: 'sess-1',
      model: 'claude-sonnet-4-6',
    })
    expect(saveServerSettingsPatchSpy).toHaveBeenNthCalledWith(1, {
      agentChat: { providers: { freshclaude: { modelSelection: { kind: 'tracked', modelId: 'claude-sonnet-4-6' } } } },
    })
    expect(saveServerSettingsPatchSpy).toHaveBeenNthCalledWith(2, {
      agentChat: { providers: { freshclaude: { defaultPermissionMode: 'default' } } },
    })
    expect(saveServerSettingsPatchSpy).toHaveBeenNthCalledWith(3, {
      agentChat: { providers: { freshclaude: { effort: 'medium' } } },
    })
  })

  it('clears unsupported effort overrides from pane state and persisted defaults when switching to a model that does not support them', async () => {
    const store = makeStore({
      agentChat: {
        ...defaultSettings.agentChat,
        providers: {
          freshclaude: {
            modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
            effort: 'turbo',
          },
        },
      },
    })
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(capabilityFetchSucceeded({
      provider: 'freshclaude',
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: Date.now(),
        models: [
          {
            id: 'opus[1m]',
            displayName: 'Opus 1M',
            description: 'Long context',
            supportsEffort: true,
            supportedEffortLevels: ['turbo'],
            supportsAdaptiveThinking: true,
          },
          {
            id: 'claude-haiku-4-5-20251001',
            displayName: 'Haiku 4.5',
            description: 'Fast path',
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAdaptiveThinking: false,
          },
        ],
      },
    }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            ...BASE_PANE,
            modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
            effort: 'turbo',
          }}
        />
      </Provider>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Agent chat settings' })
    const modelSelect = within(dialog).getByLabelText('Model') as HTMLSelectElement
    const haikuValue = Array.from(modelSelect.options).find(
      (option) => option.text === 'Haiku 4.5',
    )?.value
    fireEvent.change(modelSelect, { target: { value: haikuValue } })

    await waitFor(() => {
      expect(wsSendSpy).toHaveBeenCalledWith({
        type: 'sdk.set-model',
        sessionId: 'sess-1',
        model: 'claude-haiku-4-5-20251001',
      })
    })
    await waitFor(() => {
      expect(saveServerSettingsPatchSpy).toHaveBeenCalledTimes(2)
    })
    expect(saveServerSettingsPatchSpy).toHaveBeenNthCalledWith(1, {
      agentChat: { providers: { freshclaude: { modelSelection: { kind: 'tracked', modelId: 'claude-haiku-4-5-20251001' } } } },
    })
    expect(saveServerSettingsPatchSpy).toHaveBeenNthCalledWith(2, {
      agentChat: { providers: { freshclaude: { effort: undefined } } },
    })
  })

  it('does not clear persisted defaults when a stale pane snapshot switches to a model that does not support its local effort', async () => {
    const store = makeStore({
      agentChat: {
        ...defaultSettings.agentChat,
        providers: {
          freshclaude: {
            effort: 'turbo',
          },
        },
      },
    })
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(capabilityFetchSucceeded({
      provider: 'freshclaude',
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: Date.now(),
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Latest Opus track',
            supportsEffort: true,
            supportedEffortLevels: ['turbo'],
            supportsAdaptiveThinking: true,
          },
          {
            id: 'opus[1m]',
            displayName: 'Opus 1M',
            description: 'Long context',
            supportsEffort: true,
            supportedEffortLevels: ['turbo'],
            supportsAdaptiveThinking: true,
          },
          {
            id: 'haiku',
            displayName: 'Haiku',
            description: 'Fast path',
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAdaptiveThinking: false,
          },
        ],
      },
    }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            ...BASE_PANE,
            modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
            effort: 'turbo',
          }}
        />
      </Provider>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Agent chat settings' })
    const modelSelect = within(dialog).getByLabelText('Model') as HTMLSelectElement
    const haikuValue = Array.from(modelSelect.options).find(
      (option) => option.text === 'Haiku',
    )?.value
    fireEvent.change(modelSelect, { target: { value: haikuValue } })

    await waitFor(() => {
      expect(wsSendSpy).toHaveBeenCalledWith({
        type: 'sdk.set-model',
        sessionId: 'sess-1',
        model: 'haiku',
      })
    })
    await waitFor(() => {
      expect(saveServerSettingsPatchSpy).toHaveBeenCalledTimes(1)
    })
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      agentChat: { providers: { freshclaude: { modelSelection: { kind: 'tracked', modelId: 'haiku' } } } },
    })
  })

  it('clears persisted provider defaults when create-time cleanup drops an unsupported provider-default effort', async () => {
    const store = makeStore({
      agentChat: {
        ...defaultSettings.agentChat,
        providers: {
          freshclaude: {
            effort: 'turbo',
          },
        },
      },
    })
    store.dispatch(capabilityFetchSucceeded({
      provider: 'freshclaude',
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: Date.now(),
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Latest Opus track',
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAdaptiveThinking: true,
          },
        ],
      },
    }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            ...BASE_PANE,
            createRequestId: 'req-create-default-effort',
            sessionId: undefined,
            status: 'creating',
            effort: 'turbo',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(wsSendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'sdk.create',
        requestId: 'req-create-default-effort',
        model: 'opus',
      }))
    })
    await waitFor(() => {
      expect(saveServerSettingsPatchSpy).toHaveBeenCalledTimes(1)
    })
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      agentChat: { providers: { freshclaude: { effort: undefined } } },
    })
  })

  it('does not rewrite provider defaults when create-time cleanup drops an unsupported pane-local effort', async () => {
    const store = makeStore({
      agentChat: {
        ...defaultSettings.agentChat,
        providers: {
          freshclaude: {
            effort: 'turbo',
          },
        },
      },
    })
    store.dispatch(capabilityFetchSucceeded({
      provider: 'freshclaude',
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: Date.now(),
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Latest Opus track',
            supportsEffort: true,
            supportedEffortLevels: ['turbo'],
            supportsAdaptiveThinking: true,
          },
          {
            id: 'haiku',
            displayName: 'Haiku',
            description: 'Fast path',
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAdaptiveThinking: false,
          },
        ],
      },
    }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            ...BASE_PANE,
            createRequestId: 'req-create-unsupported-effort',
            sessionId: undefined,
            status: 'creating',
            modelSelection: { kind: 'tracked', modelId: 'haiku' },
            effort: 'turbo',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(wsSendSpy).toHaveBeenCalledWith(expect.objectContaining({
        type: 'sdk.create',
        requestId: 'req-create-unsupported-effort',
        model: 'haiku',
      }))
    })
    expect(saveServerSettingsPatchSpy).not.toHaveBeenCalled()
  })

  it('clears persisted defaults when passive cleanup drops an unsupported provider-default effort', async () => {
    const store = makeStore({
      agentChat: {
        ...defaultSettings.agentChat,
        providers: {
          freshclaude: {
            effort: 'turbo',
          },
        },
      },
    })
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(capabilityFetchSucceeded({
      provider: 'freshclaude',
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: Date.now(),
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Latest Opus track',
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAdaptiveThinking: true,
          },
        ],
      },
    }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            ...BASE_PANE,
            sessionId: 'sess-1',
            status: 'running',
            effort: 'turbo',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(saveServerSettingsPatchSpy).toHaveBeenCalledTimes(1)
    })
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      agentChat: { providers: { freshclaude: { effort: undefined } } },
    })
  })

  it('does not rewrite provider defaults when passive cleanup drops an unsupported pane-local effort', () => {
    const store = makeStore({
      agentChat: {
        ...defaultSettings.agentChat,
        providers: {
          freshclaude: {
            effort: 'turbo',
          },
        },
      },
    })
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))
    store.dispatch(capabilityFetchSucceeded({
      provider: 'freshclaude',
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: Date.now(),
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Latest Opus track',
            supportsEffort: true,
            supportedEffortLevels: ['turbo'],
            supportsAdaptiveThinking: true,
          },
          {
            id: 'haiku',
            displayName: 'Haiku',
            description: 'Fast path',
            supportsEffort: false,
            supportedEffortLevels: [],
            supportsAdaptiveThinking: false,
          },
        ],
      },
    }))

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            ...BASE_PANE,
            sessionId: 'sess-1',
            status: 'running',
            modelSelection: { kind: 'tracked', modelId: 'haiku' },
            effort: 'turbo',
          }}
        />
      </Provider>,
    )

    expect(saveServerSettingsPatchSpy).not.toHaveBeenCalled()
  })

  it('persists initial setup completion through saveServerSettingsPatch when settings are dismissed', () => {
    const store = makeStore()
    store.dispatch(sessionCreated({ requestId: 'req-1', sessionId: 'sess-1' }))

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      agentChat: { initialSetupDone: true },
    })
    expect(screen.queryByRole('dialog', { name: 'Agent chat settings' })).not.toBeInTheDocument()
  })
})
