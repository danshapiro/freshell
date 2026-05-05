import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import { Provider, useSelector } from 'react-redux'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import AgentChatView from '@/components/agent-chat/AgentChatView'
import agentChatReducer from '@/store/agentChatSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer, { defaultSettings } from '@/store/settingsSlice'
import type { AgentChatPaneContent } from '@/store/paneTypes'
import {
  AGENT_CHAT_CAPABILITY_CACHE_TTL_MS,
  AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE,
  parseAgentChatSettingsModelValue,
} from '@/lib/agent-chat-capabilities'

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

const wsSend = vi.fn()
const refreshAgentChatCapabilities = vi.fn()
const getAgentChatCapabilities = vi.fn()
const setSessionMetadata = vi.fn(() => Promise.resolve(undefined))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: wsSend,
    onReconnect: vi.fn(() => vi.fn()),
  }),
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getAgentChatCapabilities: (...args: unknown[]) => getAgentChatCapabilities(...args),
    refreshAgentChatCapabilities: (...args: unknown[]) => refreshAgentChatCapabilities(...args),
    setSessionMetadata: (...args: unknown[]) => setSessionMetadata(...args),
  }
})

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => ({
    type: 'settings/saveServerSettingsPatch',
    payload: patch,
  }),
}))

function makeStore(preloadedAgentChat: Record<string, unknown> = {}) {
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
          agentChat: {
            ...defaultSettings.agentChat,
            initialSetupDone: true,
          },
        },
        loaded: true,
        lastSavedAt: 0,
      },
      agentChat: {
        sessions: {},
        pendingCreates: {},
        pendingCreateFailures: {},
        capabilitiesByProvider: {},
        ...preloadedAgentChat,
      },
    },
  })
}

const BASE_PANE: AgentChatPaneContent = {
  kind: 'agent-chat',
  provider: 'freshclaude',
  createRequestId: 'req-1',
  sessionId: 'sess-1',
  status: 'idle',
}

function renderStoreBackedPane(
  paneContent: AgentChatPaneContent,
  preloadedAgentChat: Record<string, unknown> = {},
) {
  const store = makeStore(preloadedAgentChat)
  store.dispatch(initLayout({ tabId: 't1', paneId: 'p1', content: paneContent }))

  function Wrapper() {
    const root = useSelector((state: ReturnType<typeof store.getState>) => state.panes.layouts.t1)
    const content = root?.type === 'leaf' && root.content.kind === 'agent-chat'
      ? root.content
      : undefined
    if (!content) return null
    return <AgentChatView tabId="t1" paneId="p1" paneContent={content} />
  }

  render(
    <Provider store={store}>
      <Wrapper />
    </Provider>,
  )

  return store
}

function getRenderedPaneContent(store: ReturnType<typeof makeStore>): AgentChatPaneContent {
  const root = store.getState().panes.layouts.t1
  if (root?.type !== 'leaf' || root.content.kind !== 'agent-chat') {
    throw new Error('Expected an agent chat pane at t1/p1')
  }
  return root.content
}

function freshFetchedAt(): number {
  return Date.now()
}

function makeFreshOpusCapabilities(fetchedAt: number = freshFetchedAt()) {
  return {
    ok: true as const,
    capabilities: {
      provider: 'freshclaude',
      fetchedAt,
      models: [
        {
          id: 'opus',
          displayName: 'Opus',
          description: 'Latest Opus track',
          supportsEffort: true,
          supportedEffortLevels: ['turbo'],
          supportsAdaptiveThinking: true,
        },
      ],
    },
  }
}

describe('agent chat capability settings flow', () => {
  beforeEach(() => {
    getAgentChatCapabilities.mockResolvedValue(makeFreshOpusCapabilities())
    refreshAgentChatCapabilities.mockResolvedValue(makeFreshOpusCapabilities())
  })

  afterEach(() => {
    cleanup()
    wsSend.mockClear()
    refreshAgentChatCapabilities.mockReset()
    getAgentChatCapabilities.mockReset()
    setSessionMetadata.mockClear()
  })

  it('shows provider-default tracking plus live capability rows only, with dynamic effort options', () => {
    const store = makeStore({
      capabilitiesByProvider: {
        freshclaude: {
          status: 'succeeded',
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: freshFetchedAt(),
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Latest Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['turbo', 'warp'],
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
        },
      },
    })

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    const modelSelect = screen.getByLabelText('Model')
    const modelLabels = Array.from(modelSelect.querySelectorAll('option')).map((option) => option.textContent)
    expect(modelLabels).toEqual([
      'Provider default (track latest Opus)',
      'Opus',
      'Haiku',
    ])
    expect(screen.getByText('Tracks latest Opus automatically.')).toBeInTheDocument()

    const effortSelect = screen.getByLabelText('Effort')
    const effortLabels = Array.from(effortSelect.querySelectorAll('option')).map((option) => option.textContent)
    expect(effortLabels).toEqual(['Model default', 'turbo', 'warp'])
    expect(screen.queryByRole('option', { name: 'High' })).not.toBeInTheDocument()
  })

  it('keeps an unavailable exact model visible and selected until the user changes it', () => {
    const store = makeStore({
      capabilitiesByProvider: {
        freshclaude: {
          status: 'succeeded',
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: freshFetchedAt(),
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Latest Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['turbo'],
                supportsAdaptiveThinking: true,
              },
            ],
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            ...BASE_PANE,
            modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
          }}
        />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    const modelSelect = screen.getByLabelText('Model') as HTMLSelectElement
    expect(parseAgentChatSettingsModelValue(modelSelect.value)).toEqual({
      kind: 'exact',
      modelId: 'claude-opus-4-6',
    })
    expect(screen.getByRole('option', { name: 'claude-opus-4-6 (Unavailable)' })).toBeInTheDocument()
    expect(screen.getByText('Saved legacy model is no longer available.')).toBeInTheDocument()
  })

  it('blocks unavailable exact create until the user switches to provider-default and retries', async () => {
    const store = renderStoreBackedPane({
      ...BASE_PANE,
      sessionId: undefined,
      createRequestId: 'req-unavailable-exact',
      status: 'creating',
      modelSelection: { kind: 'exact', modelId: 'claude-opus-4-6' },
    }, {
      capabilitiesByProvider: {
        freshclaude: {
          status: 'succeeded',
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: freshFetchedAt(),
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Latest Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['turbo'],
                supportsAdaptiveThinking: true,
              },
            ],
          },
        },
      },
    })

    expect(await screen.findByText('Session start failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const modelSelect = screen.getByLabelText('Model') as HTMLSelectElement
    expect(parseAgentChatSettingsModelValue(modelSelect.value)).toEqual({
      kind: 'exact',
      modelId: 'claude-opus-4-6',
    })
    expect(screen.getByRole('option', { name: 'claude-opus-4-6 (Unavailable)' })).toBeInTheDocument()
    expect(screen.getByText('Saved legacy model is no longer available.')).toBeInTheDocument()
    expect(screen.getByText('Selected model claude-opus-4-6 is no longer available.')).toBeInTheDocument()
    expect(wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.create')).toHaveLength(0)
    expect(getRenderedPaneContent(store)).toEqual(expect.objectContaining({
      status: 'create-failed',
      createError: expect.objectContaining({
        code: 'MODEL_UNAVAILABLE',
      }),
    }))

    fireEvent.change(modelSelect, {
      target: { value: AGENT_CHAT_PROVIDER_DEFAULT_OPTION_VALUE },
    })
    expect(getRenderedPaneContent(store).modelSelection).toBeUndefined()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
        type: 'sdk.create',
        model: 'opus',
      }))
    })
  })

  it('shows a retryable capability error and keeps a persisted tracked selection visible after retry', async () => {
    refreshAgentChatCapabilities.mockResolvedValue({
      ok: true,
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: freshFetchedAt(),
        models: [
          {
            id: 'opus',
            displayName: 'Opus',
            description: 'Latest Opus track',
            supportsEffort: true,
            supportedEffortLevels: ['turbo'],
            supportsAdaptiveThinking: true,
          },
        ],
      },
    })

    const store = makeStore({
      capabilitiesByProvider: {
        freshclaude: {
          status: 'failed',
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: freshFetchedAt(),
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Latest Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['turbo'],
                supportsAdaptiveThinking: true,
              },
            ],
          },
          error: {
            code: 'CAPABILITY_FETCH_FAILED',
            message: 'Capability request failed',
            retryable: true,
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <AgentChatView
          tabId="t1"
          paneId="p1"
          paneContent={{
            ...BASE_PANE,
            modelSelection: { kind: 'tracked', modelId: 'haiku' },
            effort: 'turbo',
          }}
        />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    expect(screen.getByRole('alert')).toHaveTextContent('Capability request failed')
    expect(screen.queryByLabelText('Model')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Effort')).not.toBeInTheDocument()
    expect(screen.queryByText('Latest Opus track')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry model load' }))

    expect(refreshAgentChatCapabilities).toHaveBeenCalledWith('freshclaude', {})
    expect(await screen.findByText('Provider default (track latest Opus)')).toBeInTheDocument()
    const modelSelect = screen.getByLabelText('Model') as HTMLSelectElement
    expect(parseAgentChatSettingsModelValue(modelSelect.value)).toEqual({
      kind: 'tracked',
      modelId: 'haiku',
    })
    expect(screen.getByRole('option', { name: 'haiku (Saved selection)' })).toBeInTheDocument()
    expect(screen.getByText('Saved tracked model is not in the latest capability catalog.')).toBeInTheDocument()
  })

  it('revalidates stale cached capabilities when settings open instead of treating them as session-lifetime truth', async () => {
    getAgentChatCapabilities.mockResolvedValue({
      ok: true,
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
    })

    const staleFetchedAt = Date.now() - AGENT_CHAT_CAPABILITY_CACHE_TTL_MS - 1
    const store = makeStore({
      capabilitiesByProvider: {
        freshclaude: {
          status: 'succeeded',
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: staleFetchedAt,
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Old Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['old-effort'],
                supportsAdaptiveThinking: true,
              },
            ],
          },
        },
      },
    })

    render(
      <Provider store={store}>
        <AgentChatView tabId="t1" paneId="p1" paneContent={BASE_PANE} />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))

    await waitFor(() => {
      expect(getAgentChatCapabilities).toHaveBeenCalledWith('freshclaude', {})
    })
    expect(await screen.findByRole('option', { name: 'Haiku' })).toBeInTheDocument()
    expect(screen.queryByText('Old Opus track')).not.toBeInTheDocument()
  })

  it('revalidates stale cached capabilities before validation-dependent create instead of trusting expired data', async () => {
    const capabilityError = {
      code: 'CAPABILITY_FETCH_FAILED',
      message: 'Capability request failed',
      retryable: true,
    } as const
    getAgentChatCapabilities.mockResolvedValue({
      ok: false,
      error: capabilityError,
    })

    const staleFetchedAt = Date.now() - AGENT_CHAT_CAPABILITY_CACHE_TTL_MS - 1
    const store = renderStoreBackedPane({
      ...BASE_PANE,
      sessionId: undefined,
      createRequestId: 'req-stale-validation',
      status: 'creating',
      effort: 'turbo',
    }, {
      capabilitiesByProvider: {
        freshclaude: {
          status: 'succeeded',
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: staleFetchedAt,
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Old Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['turbo'],
                supportsAdaptiveThinking: true,
              },
            ],
          },
        },
      },
    })

    expect(await screen.findByText('Session start failed')).toBeInTheDocument()
    expect(getAgentChatCapabilities).toHaveBeenCalledWith('freshclaude', {})
    expect(wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.create')).toHaveLength(0)
    expect(getRenderedPaneContent(store)).toEqual(expect.objectContaining({
      status: 'create-failed',
      createError: expect.objectContaining({
        code: 'CAPABILITY_FETCH_FAILED',
      }),
    }))
  })

  it('lets safe tracked creates proceed during capability failure but blocks validation-dependent create until retry succeeds', async () => {
    const capabilityError = {
      code: 'CAPABILITY_FETCH_FAILED',
      message: 'Capability request failed',
      retryable: true,
    } as const

    refreshAgentChatCapabilities.mockResolvedValue({
      ok: true,
      capabilities: {
        provider: 'freshclaude',
        fetchedAt: freshFetchedAt(),
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
    })

    const safeStore = renderStoreBackedPane({
      ...BASE_PANE,
      sessionId: undefined,
      createRequestId: 'req-safe-tracked',
      status: 'creating',
      modelSelection: { kind: 'tracked', modelId: 'haiku' },
    }, {
      capabilitiesByProvider: {
        freshclaude: {
          status: 'failed',
          error: capabilityError,
        },
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Capability request failed')
    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
        type: 'sdk.create',
        model: 'haiku',
      }))
    })
    expect(getAgentChatCapabilities).not.toHaveBeenCalled()
    expect(getRenderedPaneContent(safeStore)).toEqual(expect.objectContaining({
      status: 'starting',
    }))

    cleanup()
    wsSend.mockClear()
    getAgentChatCapabilities.mockReset()

    getAgentChatCapabilities.mockResolvedValue({
      ok: false,
      error: capabilityError,
    })

    const blockedStore = renderStoreBackedPane({
      ...BASE_PANE,
      sessionId: undefined,
      createRequestId: 'req-blocked-validation',
      status: 'creating',
      effort: 'turbo',
    }, {
      capabilitiesByProvider: {
        freshclaude: {
          status: 'failed',
          error: capabilityError,
        },
      },
    })

    expect(await screen.findByText('Session start failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.getAllByText('Capability request failed').length).toBeGreaterThan(0)
    expect(getAgentChatCapabilities).toHaveBeenCalledWith('freshclaude', {})
    expect(wsSend.mock.calls.filter((call) => call[0]?.type === 'sdk.create')).toHaveLength(0)
    expect(getRenderedPaneContent(blockedStore)).toEqual(expect.objectContaining({
      status: 'create-failed',
      createError: expect.objectContaining({
        code: 'CAPABILITY_FETCH_FAILED',
      }),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Retry model load' }))
    expect(refreshAgentChatCapabilities).toHaveBeenCalledWith('freshclaude', {})
    expect(await screen.findByText('Opus')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitFor(() => {
      expect(wsSend).toHaveBeenCalledWith(expect.objectContaining({
        type: 'sdk.create',
        model: 'opus',
        effort: 'turbo',
      }))
    })
  })
})
