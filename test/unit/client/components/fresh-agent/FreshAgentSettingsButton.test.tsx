import { configureStore } from '@reduxjs/toolkit'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FreshAgentSettingsButton } from '@/components/fresh-agent/FreshAgentSettingsButton'
import { useAppSelector } from '@/store/hooks'
import panesReducer, { initLayout } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'

const saveServerSettingsPatchSpy = vi.hoisted(() => vi.fn((patch: unknown) => ({
  type: 'settings/saveServerSettingsPatch',
  payload: patch,
})))

const getFreshAgentModelCapabilitiesSpy = vi.hoisted(() => vi.fn())

vi.mock('@/store/settingsThunks', () => ({
  saveServerSettingsPatch: (patch: unknown) => saveServerSettingsPatchSpy(patch),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getFreshAgentModelCapabilities: (...args: unknown[]) => getFreshAgentModelCapabilitiesSpy(...args),
  }
})

function createStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
    },
  })
}

function createFreshopencodeStoreWithModel(model: string) {
  const store = createStore()
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      sessionType: 'freshopencode',
      provider: 'opencode',
      createRequestId: 'req-opencode-settings',
      sessionId: 'thread-opencode-settings',
      status: 'idle',
      initialCwd: '/repo/project-a',
      model,
      effort: 'max',
    },
  }))
  return store
}

function StoreBackedFreshAgentSettingsButton({
  tabId,
  paneId,
}: {
  tabId: string
  paneId: string
}) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts[tabId]
    if (!layout || layout.type !== 'leaf' || layout.id !== paneId || layout.content.kind !== 'fresh-agent') {
      throw new Error(`Missing fresh-agent pane ${paneId}`)
    }
    return layout.content
  })
  return <FreshAgentSettingsButton tabId={tabId} paneId={paneId} paneContent={paneContent} />
}

beforeEach(() => {
  saveServerSettingsPatchSpy.mockClear()
  getFreshAgentModelCapabilitiesSpy.mockReset()
  window.localStorage.removeItem('freshopencode.modelMru.v2')
})

afterEach(() => {
  cleanup()
})

describe('FreshAgentSettingsButton', () => {
  it('persists model changes as fresh-agent provider model selections', async () => {
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshcodex',
        provider: 'codex',
        createRequestId: 'req-model-settings',
        sessionId: 'thread-model-settings',
        status: 'idle',
        model: 'gpt-5.5',
        effort: 'max',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    fireEvent.click(screen.getByRole('radio', { name: 'GPT-5.4 Flash' }))

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: 'GPT-5.4 Flash' })).toBeChecked()
    })

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshcodex: {
            modelSelection: { kind: 'exact', modelId: 'gpt-5.4-flash' },
            effort: 'high',
          },
        },
      },
    })
  })

  it('shows Freshopencode MRU in the settings popover and opens grouped search on focus', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ok: true,
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      status: 'fresh',
      fetchedAt: 1_234,
      models: [
        {
          id: 'opencode-go/glm-5.2',
          displayName: 'GLM 5.2',
          provider: 'opencode',
          source: { id: 'opencode-go', displayName: 'opencode-go' },
          supportsEffort: true,
          supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'opencode-go/deepseek-v4-flash',
          displayName: 'DeepSeek V4 Flash',
          provider: 'opencode',
          source: { id: 'opencode-go', displayName: 'opencode-go' },
          supportsEffort: true,
          supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'deepseek/deepseek-v4-pro',
          displayName: 'DeepSeek V4 Pro',
          provider: 'opencode',
          source: { id: 'deepseek', displayName: 'deepseek' },
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: true,
        },
      ],
    })
    window.localStorage.setItem('freshopencode.modelMru.v2', JSON.stringify([
      {
        id: 'opencode-go/deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        cwdKey: '/repo/project-a',
        lastVerifiedAt: Date.now(),
      },
      {
        id: 'deepseek/deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        source: { id: 'deepseek', displayName: 'deepseek' },
        cwdKey: '/repo/project-a',
        lastVerifiedAt: Date.now(),
      },
    ]))
    const store = createStore()
    store.dispatch(initLayout({
      tabId: 'tab-1',
      paneId: 'pane-1',
      content: {
        kind: 'fresh-agent',
        sessionType: 'freshopencode',
        provider: 'opencode',
        createRequestId: 'req-opencode-settings',
        sessionId: 'thread-opencode-settings',
        status: 'idle',
        initialCwd: '/repo/project-a',
        model: 'opencode-go/glm-5.2',
        effort: 'max',
      },
    }))

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    expect(screen.getByRole('button', { name: /DeepSeek V4 Flash/i })).toBeVisible()
    expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('freshopencode', expect.objectContaining({ cwd: '/repo/project-a' }))
    expect(await screen.findByRole('button', { name: /Current model: GLM 5\.2/i })).toBeVisible()
    expect(screen.getByRole('button', { name: /DeepSeek V4 Flash/i })).toBeVisible()
    expect(screen.queryByRole('button', { name: /DeepSeek V4 Pro/i })).toBeVisible()
    expect(screen.queryByRole('button', { name: /Refresh/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/Command|⌘K/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /Choose Freshopencode model/i })).not.toBeInTheDocument()

    fireEvent.focus(screen.getByRole('searchbox', { name: /Search enabled models/i }))

    expect(await screen.findByRole('dialog', { name: /Choose Freshopencode model/i })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'deepseek' })).toBeVisible()
    expect(screen.getByRole('heading', { name: 'opencode-go' })).toBeVisible()

    fireEvent.change(screen.getByRole('searchbox', { name: /Filter enabled models/i }), { target: { value: 'pro' } })
    expect(screen.getByRole('button', { name: /DeepSeek V4 Pro/i })).toBeVisible()
    expect(screen.queryByRole('button', { name: /GLM 5\.2/i })).not.toBeInTheDocument()
  })

  it('persists a Freshopencode modal selection as an exact provider-qualified model and updates MRU', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ok: true,
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      status: 'fresh',
      fetchedAt: 1_234,
      models: [
        {
          id: 'opencode-go/glm-5.2',
          displayName: 'GLM 5.2',
          provider: 'opencode',
          source: { id: 'opencode-go', displayName: 'opencode-go' },
          supportsEffort: true,
          supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'deepseek/deepseek-v4-pro',
          displayName: 'DeepSeek V4 Pro',
          provider: 'opencode',
          source: { id: 'deepseek', displayName: 'deepseek' },
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: true,
        },
      ],
    })
    const store = createFreshopencodeStoreWithModel('opencode-go/glm-5.2')

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    fireEvent.focus(await screen.findByRole('searchbox', { name: /Search enabled models/i }))
    fireEvent.click(await screen.findByRole('button', { name: /DeepSeek V4 Pro/i }))

    await waitFor(() => {
      expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
        freshAgent: {
          providers: {
            freshopencode: {
              modelSelection: { kind: 'exact', modelId: 'deepseek/deepseek-v4-pro' },
              effort: 'high',
            },
          },
        },
      })
    })
    expect(JSON.parse(window.localStorage.getItem('freshopencode.modelMru.v2') ?? '[]')[0]).toMatchObject({
      id: 'deepseek/deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
    })
  })

  it('shows stale cached Freshopencode MRU tiles as disabled when the catalog fetch fails', async () => {
    getFreshAgentModelCapabilitiesSpy.mockRejectedValue(new Error('Network down'))
    window.localStorage.setItem('freshopencode.modelMru.v2', JSON.stringify([
      {
        id: 'opencode-go/deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        cwdKey: '/repo/project-a',
        lastVerifiedAt: Date.now(),
      },
    ]))
    const store = createFreshopencodeStoreWithModel('opencode-go/glm-5.2')

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    const tile = await screen.findByRole('button', { name: /Use model: DeepSeek V4 Flash/i })
    expect(tile).toBeVisible()
    expect(tile).toBeDisabled()
    expect(screen.getByText(/Model catalog unavailable/i)).toBeInTheDocument()
    expect(screen.queryByRole('searchbox', { name: /Search enabled models/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog', { name: /Choose Freshopencode model/i })).not.toBeInTheDocument()
  })

  it('traps Tab focus in the Freshopencode model modal, closes on Escape, and restores focus', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ok: true,
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      status: 'fresh',
      fetchedAt: 1_234,
      models: [
        {
          id: 'opencode-go/glm-5.2',
          displayName: 'GLM 5.2',
          provider: 'opencode',
          source: { id: 'opencode-go', displayName: 'opencode-go' },
          supportsEffort: true,
          supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
          supportsAdaptiveThinking: true,
        },
        {
          id: 'deepseek/deepseek-v4-pro',
          displayName: 'DeepSeek V4 Pro',
          provider: 'opencode',
          source: { id: 'deepseek', displayName: 'deepseek' },
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          supportsAdaptiveThinking: true,
        },
      ],
    })
    const store = createFreshopencodeStoreWithModel('opencode-go/glm-5.2')

    render(
      <Provider store={store}>
        <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
      </Provider>,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    const entrySearch = await screen.findByRole('searchbox', { name: /Search enabled models/i })
    fireEvent.focus(entrySearch)

    const dialog = await screen.findByRole('dialog', { name: /Choose Freshopencode model/i })
    expect(dialog).toBeVisible()

    const filterInput = screen.getByRole('searchbox', { name: /Filter enabled models/i })
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>('button, input, [href], select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => !el.hasAttribute('disabled') && !el.getAttribute('aria-hidden'))
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    expect(first).toBe(filterInput)

    expect(filterInput).toHaveFocus()

    last.focus()
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(dialog, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    first.focus()
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /Choose Freshopencode model/i })).not.toBeInTheDocument()
    })
    expect(screen.getByRole('dialog', { name: 'Agent settings' })).toBeVisible()
  })
})
