import { configureStore } from '@reduxjs/toolkit'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FreshAgentSettingsButton } from '@/components/fresh-agent/FreshAgentSettingsButton'
import { useAppSelector } from '@/store/hooks'
import panesReducer, { initLayout, mergePaneContent } from '@/store/panesSlice'
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

const CATALOG_RESPONSE = {
  ok: true as const,
  sessionType: 'freshopencode' as const,
  runtimeProvider: 'opencode' as const,
  status: 'fresh' as const,
  fetchedAt: 1_234,
  models: [
    {
      id: 'opencode-go/glm-5.2',
      displayName: 'GLM 5.2',
      provider: 'opencode' as const,
      source: { id: 'opencode-go', displayName: 'OpenCode Go' },
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high', 'max'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'deepseek/deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      provider: 'opencode' as const,
      source: { id: 'deepseek', displayName: 'DeepSeek' },
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
    },
  ],
}

const CLAUDE_CATALOG_RESPONSE = {
  ok: true as const,
  sessionType: 'freshclaude' as const,
  runtimeProvider: 'claude' as const,
  status: 'fresh' as const,
  fetchedAt: 1_234,
  models: [
    {
      id: 'opus[1m]',
      displayName: 'Opus (1M context)',
      provider: 'claude' as const,
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'sonnet',
      displayName: 'Sonnet',
      provider: 'claude' as const,
      supportsEffort: true,
      supportedEffortLevels: ['low', 'medium', 'high'],
      supportsAdaptiveThinking: false,
    },
  ],
}

function createStore() {
  return configureStore({
    reducer: {
      panes: panesReducer,
      settings: settingsReducer,
    },
  })
}

function readPaneContent(store: ReturnType<typeof createStore>) {
  const layout = store.getState().panes.layouts['tab-1']
  if (!layout || layout.type !== 'leaf' || layout.id !== 'pane-1' || layout.content.kind !== 'fresh-agent') {
    throw new Error('Missing fresh-agent pane pane-1')
  }
  return layout.content
}

function seedPane(
  store: ReturnType<typeof createStore>,
  content: Record<string, unknown>,
) {
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      createRequestId: 'req-settings',
      sessionId: 'thread-settings',
      status: 'idle',
      ...content,
    },
  }))
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

function renderButton(store: ReturnType<typeof createStore>) {
  return render(
    <Provider store={store}>
      <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
    </Provider>,
  )
}

beforeEach(() => {
  saveServerSettingsPatchSpy.mockClear()
  getFreshAgentModelCapabilitiesSpy.mockReset()
  getFreshAgentModelCapabilitiesSpy.mockResolvedValue(CATALOG_RESPONSE)
  window.localStorage.removeItem('freshopencode.modelMru.v2')
  window.localStorage.removeItem('freshcodex.modelMru.v2')
  window.localStorage.removeItem('freshopencode.modelLevelMru.v1')
  window.localStorage.removeItem('freshcodex.modelLevelMru.v1')
})

afterEach(() => {
  cleanup()
})

describe('FreshAgentSettingsButton', () => {
  it('offers valid Codex approval policies without implying sandbox access', () => {
    const store = createStore()
    seedPane(store, { sessionType: 'freshcodex', provider: 'codex', permissionMode: 'on-request', sandbox: 'read-only' })
    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    const permissions = screen.getByRole('combobox', { name: 'Permission mode' })
    fireEvent.change(permissions, { target: { value: 'untrusted' } })
    expect(readPaneContent(store).permissionMode).toBe('untrusted')
    expect(screen.getByRole('option', { name: 'Ask for untrusted commands' })).toBeInTheDocument()
    fireEvent.change(permissions, { target: { value: 'never' } })
    expect(readPaneContent(store).permissionMode).toBe('never')
    expect(readPaneContent(store).sandbox).toBe('read-only')
    expect(screen.getByRole('option', { name: 'Never ask' })).toBeInTheDocument()
  })
  it('keeps the simple model radio list and Thinking dropdown for freshclaude', () => {
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'opus[1m]',
      effort: 'high',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    expect(screen.getByRole('radio', { name: 'Claude Opus 5 (1M context)' })).toBeChecked()
    // a static model shows its static thinking levels (models in neither the
    // statics nor the probed catalog legitimately show no Thinking select)
    expect(screen.getByRole('combobox', { name: 'Thinking level' })).toBeInTheDocument()
    // the shared dialog path is not offered to freshclaude
    expect(screen.queryByRole('button', { name: /Change/ })).not.toBeInTheDocument()
  })

  it('merges the probed claude catalog (aliases included) into the freshclaude model radio list', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue(CLAUDE_CATALOG_RESPONSE)
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'opus[1m]',
      effort: 'high',
      initialCwd: '/repo/project-b',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    await waitFor(() => {
      expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(1)
    })
    expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('freshclaude', expect.objectContaining({ cwd: '/repo/project-b' }))

    // statics render instantly and stay first; probed rows swap in when the fetch resolves
    expect(screen.getByRole('radio', { name: 'Claude Opus 5 (1M context)' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Sonnet' })).toBeInTheDocument()

    // one row per unique id: the probed opus[1m] row dedupes into the static
    // row (static label wins), so 1 static + 1 remaining probed row
    expect(screen.getAllByRole('radio', { name: /Opus/ })).toHaveLength(1)
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    // the checked radio is the persisted static model
    expect(screen.getByRole('radio', { name: 'Claude Opus 5 (1M context)' })).toBeChecked()
  })

  it('fires exactly one capabilities fetch for a kilroy popover via its claude provider', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ...CLAUDE_CATALOG_RESPONSE,
      sessionType: 'kilroy',
    })
    const store = createStore()
    seedPane(store, {
      sessionType: 'kilroy',
      provider: 'claude',
      model: 'claude-opus-4-6',
      effort: 'high',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    await waitFor(() => {
      expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(1)
    })
    expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('kilroy', expect.anything())
    // probed rows surface; the probed opus[1m] row folds into the static row,
    // leaving the probed sonnet row as the appended entry
    expect(await screen.findByRole('radio', { name: 'Sonnet' })).toBeInTheDocument()
  })

  it('shows a compact Model row for freshcodex and retires the radio list and Thinking dropdown', () => {
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshcodex',
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'max',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    expect(screen.getByRole('button', { name: /GPT-5\.5 · max.*Change/ })).toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'GPT-5.4 Flash' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Thinking level' })).not.toBeInTheDocument()
  })

  it('opens the shared dialog from the freshcodex Change… button and persists the committed choice', async () => {
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshcodex',
      provider: 'codex',
      model: 'gpt-5.5',
      effort: 'max',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))
    fireEvent.click(screen.getByRole('button', { name: /Change/ }))

    await screen.findByRole('dialog', { name: 'Model and thinking level' })
    fireEvent.click(screen.getByRole('option', { name: /GPT-5\.4 Flash/ }))
    const levelsList = screen.getByRole('listbox', { name: 'Thinking levels for GPT-5.4 Flash' })
    const lowOption = Array.from(levelsList.querySelectorAll('[role="option"]')).find((el) => el.textContent?.includes('low'))
    expect(lowOption).toBeDefined()
    fireEvent.click(lowOption!)
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.4 Flash · low' }))

    await waitFor(() => {
      expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
        freshAgent: {
          providers: {
            freshcodex: {
              modelSelection: { kind: 'exact', modelId: 'gpt-5.4-flash' },
              effort: 'low',
            },
          },
        },
      })
    })
    expect(screen.queryByRole('dialog', { name: 'Model and thinking level' })).not.toBeInTheDocument()
  })

  it('shows a compact Model row for freshopencode fed by the live catalog, and opens the dialog from Change…', async () => {
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/glm-5.2',
      effort: 'max',
      initialCwd: '/repo/project-a',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    expect(await screen.findByRole('button', { name: /GLM 5\.2 · max.*Change/ })).toBeInTheDocument()
    expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('freshopencode', expect.objectContaining({ cwd: '/repo/project-a' }))
    // retired: recent-model tiles and the modal search entry point
    expect(screen.queryByRole('searchbox', { name: /Search enabled models/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Use model:/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Thinking level' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Change/ }))
    expect(await screen.findByRole('dialog', { name: 'Model and thinking level' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: 'Filter models' })).toBeInTheDocument()
  })

  it('replaces the freshopencode Model row with the unavailable notice when the catalog probe fails', async () => {
    getFreshAgentModelCapabilitiesSpy.mockRejectedValue(new Error('network down'))
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/glm-5.2',
      effort: 'max',
      initialCwd: '/repo/project-a',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    expect(await screen.findByText('Model catalog unavailable — try again')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Change/ })).not.toBeInTheDocument()
  })

  it('hides the Thinking select when the active model is a probed-only claude row without effort support', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ok: true as const,
      sessionType: 'freshclaude' as const,
      runtimeProvider: 'claude' as const,
      status: 'fresh' as const,
      fetchedAt: 1_234,
      models: [
        {
          id: 'haiku',
          displayName: 'Haiku',
          provider: 'claude' as const,
          supportsEffort: false,
          supportedEffortLevels: [],
          supportsAdaptiveThinking: false,
        },
      ],
    })
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'haiku',
      effort: 'high',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    // the probed row lands in the merged radio list as the active selection
    expect(await screen.findByRole('radio', { name: 'Haiku' })).toBeChecked()
    // haiku declares no effort levels — the static opus[1m] five-level menu
    // must NOT stand in for it
    expect(screen.queryByRole('combobox', { name: 'Thinking level' })).not.toBeInTheDocument()
  })

  it('renders the freshclaude popover with static rows only (and no opencode unavailable notice) when the catalog fetch rejects', async () => {
    getFreshAgentModelCapabilitiesSpy.mockRejectedValue(new Error('probe down'))
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'opus[1m]',
      effort: 'high',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    await waitFor(() => {
      expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(1)
    })
    // the rejected probe degrades to statics only — the popover must not crash
    expect(await screen.findByRole('radio', { name: 'Claude Opus 5 (1M context)' })).toBeChecked()
    expect(screen.getAllByRole('radio')).toHaveLength(1)
    // the opencode-style catalog-unavailable notice stays opencode-only
    expect(screen.queryByText('Model catalog unavailable — try again')).not.toBeInTheDocument()
  })

  it('clamps effort against the switched-to probed claude row’s own levels, not the static fallback', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ok: true as const,
      sessionType: 'freshclaude' as const,
      runtimeProvider: 'claude' as const,
      status: 'fresh' as const,
      fetchedAt: 1_234,
      models: [
        {
          id: 'sonnet',
          displayName: 'Sonnet',
          provider: 'claude' as const,
          supportsEffort: true,
          supportedEffortLevels: ['alpha', 'beta'],
          supportsAdaptiveThinking: true,
        },
      ],
    })
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'opus[1m]',
      effort: 'max',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    fireEvent.click(await screen.findByRole('radio', { name: 'Sonnet' }))

    const content = readPaneContent(store)
    expect(content.model).toBe('sonnet')
    // 'max' is valid for the static opus[1m] default but NOT for this probed
    // row: the clamp lands on the row’s first declared level, not the static
    // table’s fallback
    expect(content.effort).toBe('alpha')
    // the switched-to row's levels are stamped onto the pane so later effort
    // normalization (select value, send/create payloads) clamps against them
    // without re-deriving from the static table
    expect(content.modelEffortLevels).toEqual(['alpha', 'beta'])
    // the picked row's display label goes to the status-strip chip via the
    // id-paired stamp (catalog-only ids would otherwise flash their raw id)
    expect(content.modelLabel).toEqual({ modelId: 'sonnet', label: 'Sonnet' })
  })

  it('stamps no modelLabel when the switched-to probed row\'s label echoes its raw id', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ok: true as const,
      sessionType: 'freshclaude' as const,
      runtimeProvider: 'claude' as const,
      status: 'fresh' as const,
      fetchedAt: 1_234,
      models: [
        {
          // no-name catalog fallback (e.g. opencode normalize): the "display
          // name" IS the raw id — stamping it would put a raw id on the chip.
          id: 'claude-ish/unnamed-7',
          displayName: 'claude-ish/unnamed-7',
          provider: 'claude' as const,
          supportsEffort: false,
          supportedEffortLevels: [],
          supportsAdaptiveThinking: false,
        },
      ],
    })
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'opus[1m]',
      effort: 'max',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    fireEvent.click(await screen.findByRole('radio', { name: 'claude-ish/unnamed-7' }))

    const content = readPaneContent(store)
    expect(content.model).toBe('claude-ish/unnamed-7')
    expect(content.modelLabel).toBeUndefined()
  })

  it('clears the pane effort when switching to a probed claude row that declares no effort levels', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ok: true as const,
      sessionType: 'freshclaude' as const,
      runtimeProvider: 'claude' as const,
      status: 'fresh' as const,
      fetchedAt: 1_234,
      models: [
        {
          id: 'haiku',
          displayName: 'Haiku',
          provider: 'claude' as const,
          supportsEffort: false,
          supportedEffortLevels: [],
          supportsAdaptiveThinking: false,
        },
      ],
    })
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'opus[1m]',
      effort: 'max',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    fireEvent.click(await screen.findByRole('radio', { name: 'Haiku' }))

    const content = readPaneContent(store)
    expect(content.model).toBe('haiku')
    // the probed row declares NO levels — never fabricate a clamp from the
    // static default’s table (pre-fix kept 'max' because opus[1m] allows it)
    expect(content.effort).toBeUndefined()
    // the empty-levels stamp survives so normalization stays on the
    // "no levels" branch instead of falling back to the static table
    expect(content.modelEffortLevels).toEqual([])
  })

  it('keeps the existing static-table normalization when switching to the static opus[1m] row', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ok: true as const,
      sessionType: 'freshclaude' as const,
      runtimeProvider: 'claude' as const,
      status: 'fresh' as const,
      fetchedAt: 1_234,
      models: [
        {
          id: 'sonnet',
          displayName: 'Sonnet',
          provider: 'claude' as const,
          supportsEffort: true,
          supportedEffortLevels: ['alpha', 'beta'],
          supportsAdaptiveThinking: true,
        },
      ],
    })
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'sonnet',
      effort: 'alpha',
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    fireEvent.click(await screen.findByRole('radio', { name: 'Claude Opus 5 (1M context)' }))

    const content = readPaneContent(store)
    expect(content.model).toBe('opus[1m]')
    // regression witness: 'alpha' is unknown to the static opus[1m] row, so the
    // row’s declared defaultEffort ('high') stands in — exactly the pre-fix
    // normalizeFreshAgentEffort result
    expect(content.effort).toBe('high')
    // static rows stamp their static levels too (value identical to today’s
    // static table) so stamped semantics stay uniform for every switched model
    expect(content.modelEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('clears the stamped levels when a merge targets a model absent from the selector rows', () => {
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'sonnet',
      effort: 'alpha',
      modelEffortLevels: ['alpha', 'beta'],
    })

    // the stamp survives pane-content normalization (pre-fix it is dropped)
    expect(readPaneContent(store).modelEffortLevels).toEqual(['alpha', 'beta'])

    // the switch fallback branch (absent row) clears the stamp so the pane
    // returns to static-table normalization
    store.dispatch(mergePaneContent({
      tabId: 'tab-1',
      paneId: 'pane-1',
      updates: { model: 'claude-ghost', effort: 'high', modelEffortLevels: undefined },
    }))
    expect(readPaneContent(store).modelEffortLevels).toBeUndefined()
  })

  it('sources the Thinking select (options AND selected value) from the active probed claude row’s own levels', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ok: true as const,
      sessionType: 'freshclaude' as const,
      runtimeProvider: 'claude' as const,
      status: 'fresh' as const,
      fetchedAt: 1_234,
      models: [
        {
          id: 'sonnet',
          displayName: 'Sonnet',
          provider: 'claude' as const,
          supportsEffort: true,
          // 'high' deliberately included: the pre-fix static fallback resolves
          // the staged 'beta' to 'high', and 'high' IS an option here — so the
          // select observably lands on the WRONG value instead of jsdom's
          // first-option fallback masking an unmatched value
          supportedEffortLevels: ['high', 'beta'],
          supportsAdaptiveThinking: true,
        },
      ],
    })
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshclaude',
      provider: 'claude',
      model: 'sonnet',
      effort: 'beta',
      // a pane that went through the selector carries the switched-to row's
      // levels as a stamp so normalization can clamp against them
      modelEffortLevels: ['high', 'beta'],
    })

    renderButton(store)
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    expect(await screen.findByRole('radio', { name: 'Sonnet' })).toBeChecked()
    const thinking = await screen.findByRole('combobox', { name: 'Thinking level' })
    const levels = Array.from(thinking.querySelectorAll('option')).map((option) => option.value)
    // exactly the probed row's levels — not the static opus[1m] fallback's five
    expect(levels).toEqual(['high', 'beta'])
    // and the rendered SELECTED value is the staged 'beta' — never the static
    // table's re-clamped 'high'
    expect(thinking).toHaveValue('beta')
  })

  it('renders the open popover outside the overflow-hidden .pane-header stripe', () => {
    const store = createStore()
    seedPane(store, {
      sessionType: 'freshopencode',
      provider: 'opencode',
      model: 'opencode-go/glm-5.2',
    })

    render(
      <Provider store={store}>
        <div className="pane-header">
          <StoreBackedFreshAgentSettingsButton tabId="tab-1" paneId="pane-1" />
        </div>
      </Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Agent settings' }))

    const dialog = screen.getByRole('dialog', { name: 'Agent settings' })
    // .pane-header is an overflow-hidden clip container (index.css); a popover
    // rendered inline inside it is clipped to a sliver of the header stripe.
    // The popover must escape the header (portal to document.body).
    expect(dialog.closest('.pane-header')).toBeNull()
  })
})
