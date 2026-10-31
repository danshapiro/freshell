import { configureStore } from '@reduxjs/toolkit'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FreshAgentModelDialog } from '@/components/fresh-agent/FreshAgentModelDialog'
import { useAppSelector } from '@/store/hooks'
import panesReducer, { initLayout, mergePaneContent } from '@/store/panesSlice'
import settingsReducer from '@/store/settingsSlice'
import freshAgentReducer, { applyRuntimeOwner } from '@/store/freshAgentSlice'
import type { FreshAgentPaneContent } from '@/store/paneTypes'
import type { FreshAgentSettingScopes } from '@shared/fresh-agent-contract'

const saveServerSettingsPatchSpy = vi.hoisted(() => vi.fn((patch: unknown) => ({
  type: 'settings/saveServerSettingsPatch',
  payload: patch,
})))

const getFreshAgentModelCapabilitiesSpy = vi.hoisted(() => vi.fn())
const wsSendSpy = vi.hoisted(() => vi.fn())

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: wsSendSpy }),
}))

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

const CATALOG_MODELS = [
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
    id: 'opencode-go/glm-5.2-vision',
    displayName: 'GLM 5.2 Vision',
    provider: 'opencode' as const,
    source: { id: 'opencode-go', displayName: 'OpenCode Go' },
    supportsEffort: true,
    supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'off'],
    supportsAdaptiveThinking: true,
  },
  {
    id: 'kimi-for-coding/kimi-k3',
    displayName: 'Kimi K3',
    provider: 'opencode' as const,
    source: { id: 'kimi-for-coding', displayName: 'Kimi For Coding' },
    supportsEffort: true,
    supportedEffortLevels: ['max'],
    supportsAdaptiveThinking: true,
  },
  {
    id: 'deepseek/deepseek-chat',
    displayName: 'DeepSeek Chat',
    provider: 'opencode' as const,
    source: { id: 'deepseek', displayName: 'DeepSeek' },
    supportsEffort: false,
    supportedEffortLevels: [],
    supportsAdaptiveThinking: false,
  },
]

const catalogResponse = {
  ok: true as const,
  sessionType: 'freshopencode' as const,
  runtimeProvider: 'opencode' as const,
  status: 'fresh' as const,
  fetchedAt: 1_234,
  models: CATALOG_MODELS,
}

// Mirrors the settings-popover suite's claude catalog: a probed row re-using
// the static id (must dedupe into the static row) and an alias-only row.
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
      freshAgent: freshAgentReducer,
    },
  })
}

function seedPane(
  store: ReturnType<typeof createStore>,
  content: Partial<FreshAgentPaneContent> & Pick<FreshAgentPaneContent, 'sessionType' | 'provider'>,
) {
  store.dispatch(initLayout({
    tabId: 'tab-1',
    paneId: 'pane-1',
    content: {
      kind: 'fresh-agent',
      createRequestId: 'req-dialog',
      sessionId: 'thread-dialog',
      status: 'idle',
      initialCwd: '/repo/project-a',
      ...content,
    } as FreshAgentPaneContent,
  }))
}

function seedFreshopencodePane(
  store: ReturnType<typeof createStore>,
  overrides: Partial<FreshAgentPaneContent> = {},
) {
  seedPane(store, {
    sessionType: 'freshopencode',
    provider: 'opencode',
    model: 'opencode-go/glm-5.2',
    effort: 'max',
    ...overrides,
  })
}

function seedFreshcodexPane(
  store: ReturnType<typeof createStore>,
  overrides: Partial<FreshAgentPaneContent> = {},
) {
  seedPane(store, {
    sessionType: 'freshcodex',
    provider: 'codex',
    model: 'gpt-6-astra',
    effort: 'max',
    ...overrides,
  })
}

function seedFreshclaudePane(
  store: ReturnType<typeof createStore>,
  overrides: Partial<FreshAgentPaneContent> = {},
) {
  seedPane(store, {
    sessionType: 'freshclaude',
    provider: 'claude',
    model: 'opus[1m]',
    effort: 'high',
    ...overrides,
  })
}

function seedKilroyPane(
  store: ReturnType<typeof createStore>,
  overrides: Partial<FreshAgentPaneContent> = {},
) {
  seedPane(store, {
    sessionType: 'kilroy',
    provider: 'claude',
    model: 'opus[1m]',
    effort: 'high',
    ...overrides,
  })
}

function StoreBackedDialog(props: { open: boolean; onClose?: () => void; onCatalogUnavailable?: () => void; settingScopes?: FreshAgentSettingScopes }) {
  const paneContent = useAppSelector((state) => {
    const layout = state.panes.layouts['tab-1']
    if (!layout || layout.type !== 'leaf' || layout.id !== 'pane-1' || layout.content.kind !== 'fresh-agent') {
      throw new Error('Missing fresh-agent pane pane-1')
    }
    return layout.content
  })
  return (
    <FreshAgentModelDialog
      tabId="tab-1"
      paneId="pane-1"
      paneContent={paneContent}
      open={props.open}
      onClose={props.onClose ?? (() => {})}
      {...(props.onCatalogUnavailable ? { onCatalogUnavailable: props.onCatalogUnavailable } : {})}
      settingScopes={props.settingScopes}
    />
  )
}

function renderDialog(store: ReturnType<typeof createStore>, props: Parameters<typeof StoreBackedDialog>[0]) {
  return render(
    <Provider store={store}>
      <StoreBackedDialog {...props} />
    </Provider>,
  )
}

function paneContent(store: ReturnType<typeof createStore>): FreshAgentPaneContent {
  const layout = store.getState().panes.layouts['tab-1']
  if (!layout || layout.type !== 'leaf' || layout.content.kind !== 'fresh-agent') {
    throw new Error('Missing fresh-agent pane')
  }
  return layout.content
}

function seedLevelMru(entries: Array<{ modelId: string; level: string; cwdKey: string; lastUsedAt: number }>, provider = 'freshopencode') {
  window.localStorage.setItem(`${provider}.modelLevelMru.v1`, JSON.stringify(entries))
}

beforeEach(() => {
  saveServerSettingsPatchSpy.mockClear()
  wsSendSpy.mockClear()
  getFreshAgentModelCapabilitiesSpy.mockReset()
  getFreshAgentModelCapabilitiesSpy.mockResolvedValue(catalogResponse)
  window.localStorage.removeItem('freshopencode.modelMru.v2')
  window.localStorage.removeItem('freshcodex.modelMru.v2')
  window.localStorage.removeItem('freshopencode.modelLevelMru.v1')
  window.localStorage.removeItem('freshcodex.modelLevelMru.v1')
  window.localStorage.removeItem('freshclaude.modelMru.v2')
  window.localStorage.removeItem('freshclaude.modelLevelMru.v1')
  window.localStorage.removeItem('kilroy.modelMru.v2')
  window.localStorage.removeItem('kilroy.modelLevelMru.v1')
})

afterEach(() => {
  cleanup()
})

describe('FreshAgentModelDialog (freshopencode)', () => {
  it('renders nothing when closed', () => {
    const store = createStore()
    seedFreshopencodePane(store)

    renderDialog(store, { open: false })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(getFreshAgentModelCapabilitiesSpy).not.toHaveBeenCalled()
  })

  it('focuses the search box once the catalog probe resolves (it is disabled while probing)', async () => {
    // Regression: the open-time focus timer fires while capabilities are still
    // undefined for freshopencode, and focus() on a DISABLED input is a no-op —
    // focus used to stay on whatever opened the dialog (e.g. the popover's
    // Change… button) forever.
    const store = createStore()
    seedFreshopencodePane(store)

    let resolveProbe: ((value: typeof catalogResponse) => void) | undefined
    getFreshAgentModelCapabilitiesSpy.mockReturnValueOnce(
      new Promise((resolve) => { resolveProbe = resolve }),
    )

    renderDialog(store, { open: true })

    const search = await screen.findByRole('searchbox', { name: 'Filter models' })
    expect(search).toBeDisabled()

    resolveProbe!(catalogResponse)

    await waitFor(() => expect(search).toBeEnabled())
    await waitFor(() => expect(search).toHaveFocus())
  })

  it('fetches the cwd-scoped catalog on open and lists provider groups with the current model marked', async () => {
    const store = createStore()
    seedFreshopencodePane(store)

    renderDialog(store, { open: true })

    const dialog = await screen.findByRole('dialog', { name: 'Model and thinking level' })
    expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('freshopencode', expect.objectContaining({ cwd: '/repo/project-a' }))
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Filter models' })).toHaveFocus())

    const modelsList = screen.getByRole('listbox', { name: 'Models' })
    expect(modelsList).toHaveTextContent('OpenCode Go')
    expect(modelsList).toHaveTextContent('Kimi For Coding')
    expect(modelsList).toHaveTextContent('DeepSeek')
    // the current model is marked everywhere it appears (Recent + its group)
    expect(screen.getAllByRole('option', { name: /GLM 5\.2.*current/ }).length).toBeGreaterThanOrEqual(1)
    expect(dialog).toHaveTextContent('applies from your next message · becomes your default')
  })

  it('shows a Recent group sourced from the cwd-scoped MRU with source names', async () => {
    window.localStorage.setItem('freshopencode.modelMru.v2', JSON.stringify([
      {
        id: 'kimi-for-coding/kimi-k3',
        displayName: 'Kimi K3',
        source: { id: 'kimi-for-coding', displayName: 'Kimi For Coding' },
        cwdKey: '/repo/project-a',
        lastVerifiedAt: Date.now(),
      },
      {
        id: 'opencode-go/glm-5.2',
        displayName: 'GLM 5.2',
        source: { id: 'opencode-go', displayName: 'OpenCode Go' },
        cwdKey: '/repo/project-a',
        lastVerifiedAt: Date.now(),
      },
      {
        id: 'deepseek/deepseek-chat',
        displayName: 'DeepSeek Chat',
        source: { id: 'deepseek', displayName: 'DeepSeek' },
        cwdKey: '/repo/other',
        lastVerifiedAt: Date.now(),
      },
    ]))
    const store = createStore()
    seedFreshopencodePane(store)

    renderDialog(store, { open: true })

    const modelsList = await screen.findByRole('listbox', { name: 'Models' })
    await waitFor(() => expect(modelsList).toHaveTextContent('Recent'))
    const recentOptions = Array.from(modelsList.querySelectorAll('[data-group="recent"]'))
    const recentTexts = recentOptions.map((el) => el.textContent ?? '')
    // current model is boosted to the front of Recent, other-cwd entries excluded
    expect(recentTexts.map((text) => text.replace(/current|●/g, '').trim())).toEqual([
      'GLM 5.2 · OpenCode Go',
      'Kimi K3 · Kimi For Coding',
    ])
    expect(recentTexts.join(' ')).not.toContain('DeepSeek Chat')
  })

  it('filters both Recent and provider groups as the search query changes', async () => {
    const store = createStore()
    seedFreshopencodePane(store)

    renderDialog(store, { open: true })

    const search = await screen.findByRole('searchbox', { name: 'Filter models' })
    await screen.findAllByRole('option', { name: /GLM/ })
    fireEvent.change(search, { target: { value: 'kimi' } })

    expect(screen.getByRole('option', { name: /Kimi K3/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /GLM/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /DeepSeek Chat/ })).not.toBeInTheDocument()
  })

  it('shows the highlighted model’s real levels canonically ordered, marks the current level, and preselects the highest without MRU', async () => {
    const store = createStore()
    seedFreshopencodePane(store)

    renderDialog(store, { open: true })

    const levelsList = await screen.findByRole('listbox', { name: 'Thinking levels for GLM 5.2' })
    const levelNames = Array.from(levelsList.querySelectorAll('[role="option"]')).map((el) => el.textContent)
    expect(levelNames.map((name) => name?.replace(/last used|highest|current|●/g, '').trim())).toEqual(['low', 'high', 'max'])

    // Preselection = highest level → OK button reflects it. The pane's current
    // level is max, which is ALSO the highest: per "don't double-annotate",
    // only the current marker shows.
    expect(screen.getByRole('button', { name: 'Use GLM 5.2 · max' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /max current/ })).toBeInTheDocument()
    expect(levelsList).not.toHaveTextContent('highest')
    expect(screen.queryByText('last used')).not.toBeInTheDocument()

    // On a non-current model the current marker disappears and the canonical
    // highest level is annotated.
    fireEvent.click(screen.getByRole('option', { name: /Kimi K3/ }))
    expect(screen.getByRole('option', { name: /max highest/ })).toBeInTheDocument()
  })

  it('preselects the model’s last-used level from the per-model level store', async () => {
    seedLevelMru([{ modelId: 'opencode-go/glm-5.2', level: 'high', cwdKey: '/repo/project-a', lastUsedAt: 1_000 }])
    const store = createStore()
    seedFreshopencodePane(store, { model: 'kimi-for-coding/kimi-k3' })

    renderDialog(store, { open: true })

    fireEvent.click(await screen.findByRole('option', { name: /^GLM 5.2$/ }))

    expect(await screen.findByRole('button', { name: 'Use GLM 5.2 · high' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /high last used/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /max highest/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /max.*current/ })).not.toBeInTheDocument()
  })

  it('renders exactly one Default row for a model with no declared levels', async () => {
    const store = createStore()
    seedFreshopencodePane(store, { model: 'deepseek/deepseek-chat' })

    renderDialog(store, { open: true })

    const levelsList = await screen.findByRole('listbox', { name: 'Thinking levels for DeepSeek Chat' })
    const options = levelsList.querySelectorAll('[role="option"]')
    expect(options).toHaveLength(1)
    expect(options[0]).toHaveTextContent('Default')
    expect(screen.getByRole('button', { name: 'Use DeepSeek Chat · Default' })).toBeInTheDocument()
  })

  it('commits the highlighted model + level to the pane, the provider defaults, and the MRU stores', async () => {
    const onClose = vi.fn()
    const store = createStore()
    seedFreshopencodePane(store)

    renderDialog(store, { open: true, onClose })

    // highlight Kimi K3 (single level: max)
    fireEvent.click(await screen.findByRole('option', { name: /Kimi K3/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Kimi K3 · max' }))

    expect(onClose).toHaveBeenCalled()
    const content = paneContent(store)
    expect(content.model).toBe('kimi-for-coding/kimi-k3')
    expect(content.modelSelection).toEqual({ kind: 'exact', modelId: 'kimi-for-coding/kimi-k3' })
    expect(content.effort).toBe('max')

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshopencode: {
            modelSelection: { kind: 'exact', modelId: 'kimi-for-coding/kimi-k3' },
            effort: 'max',
          },
        },
      },
    })

    const modelMru = JSON.parse(window.localStorage.getItem('freshopencode.modelMru.v2') ?? '[]')
    expect(modelMru[0]).toMatchObject({ id: 'kimi-for-coding/kimi-k3' })
    const levelMru = JSON.parse(window.localStorage.getItem('freshopencode.modelLevelMru.v1') ?? '[]')
    expect(levelMru).toEqual([expect.objectContaining({ modelId: 'kimi-for-coding/kimi-k3', level: 'max', cwdKey: '/repo/project-a' })])

    // The commit ALSO applies the pick to the LIVE session: the
    // freshAgent.configure frame carries the picked model + level so the
    // server's metadata broadcast converges the chip (and every other
    // device's surfaces) immediately.
    expect(wsSendSpy).toHaveBeenCalledTimes(1)
    const configure = wsSendSpy.mock.calls[0][0]
    expect(configure.type).toBe('freshAgent.configure')
    expect(configure.sessionId).toBe('thread-dialog')
    expect(configure.sessionType).toBe('freshopencode')
    expect(configure.provider).toBe('opencode')
    expect(configure.settings).toEqual({ model: 'kimi-for-coding/kimi-k3', effort: 'max' })
  })

  it('commits the Default row as no effort: clears pane effort and provider default effort, and records no level', async () => {
    const onClose = vi.fn()
    const store = createStore()
    seedFreshopencodePane(store, { model: 'deepseek/deepseek-chat' })

    renderDialog(store, { open: true, onClose })

    fireEvent.click(await screen.findByRole('button', { name: 'Use DeepSeek Chat · Default' }))

    expect(onClose).toHaveBeenCalled()
    const content = paneContent(store)
    expect(content.model).toBe('deepseek/deepseek-chat')
    expect(content.effort).toBeUndefined()

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshopencode: {
            modelSelection: { kind: 'exact', modelId: 'deepseek/deepseek-chat' },
            effort: undefined,
          },
        },
      },
    })
    expect(window.localStorage.getItem('freshopencode.modelLevelMru.v1')).toBeNull()
    const modelMru = JSON.parse(window.localStorage.getItem('freshopencode.modelMru.v2') ?? '[]')
    expect(modelMru[0]).toMatchObject({ id: 'deepseek/deepseek-chat' })

    // The Default commit's configure carries NO effort key — the explicit
    // "no variant" statement opencode resolves as a clear.
    expect(wsSendSpy).toHaveBeenCalledTimes(1)
    const configure = wsSendSpy.mock.calls[0][0]
    expect(configure.type).toBe('freshAgent.configure')
    expect(configure.settings).toEqual({ model: 'deepseek/deepseek-chat' })
  })


  it('sends no freshAgent.configure for a pre-create pane (no live session yet)', async () => {
    const store = createStore()
    seedFreshopencodePane(store, { sessionId: undefined, status: 'creating' })

    renderDialog(store, { open: true, onClose: () => {} })

    fireEvent.click(await screen.findByRole('option', { name: /Kimi K3/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Kimi K3 · max' }))

    // Staging + the next send's settings still carry the pick; the live-apply
    // lane has nothing to apply to and stays silent.
    expect(paneContent(store).model).toBe('kimi-for-coding/kimi-k3')
    expect(wsSendSpy).not.toHaveBeenCalled()
  })

  it('drives highlight with keyboard: arrows move in-column, ←→ switch columns, Enter commits, Escape cancels', async () => {
    const onClose = vi.fn()
    const store = createStore()
    seedFreshopencodePane(store)

    renderDialog(store, { open: true, onClose })

    const search = await screen.findByRole('searchbox', { name: 'Filter models' })
    await screen.findByRole('button', { name: 'Use GLM 5.2 · max' })

    // ↑↓ move within the models column (Recent-boosted current is first; the
    // next row is the first provider-grouped model)
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(screen.getByRole('button', { name: 'Use DeepSeek Chat · Default' })).toBeInTheDocument()
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(screen.getByRole('button', { name: 'Use GLM 5.2 · max' })).toBeInTheDocument()

    // Filter to a single model and move into the levels column
    fireEvent.change(search, { target: { value: 'vision' } })
    expect(screen.getByRole('listbox', { name: 'Thinking levels for GLM 5.2 Vision' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use GLM 5.2 Vision · max' })).toBeInTheDocument()

    // Switch to the levels column and move within it (max → xhigh)
    fireEvent.keyDown(search, { key: 'ArrowRight' })
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(screen.getByRole('button', { name: 'Use GLM 5.2 Vision · xhigh' })).toBeInTheDocument()

    // Enter commits the highlighted choice
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onClose).toHaveBeenCalled()
    expect(paneContent(store).model).toBe('opencode-go/glm-5.2-vision')
    expect(paneContent(store).effort).toBe('xhigh')
  })

  it('Escape cancels without touching pane or provider defaults', async () => {
    const onClose = vi.fn()
    const store = createStore()
    seedFreshopencodePane(store)

    renderDialog(store, { open: true, onClose })

    await screen.findByRole('dialog', { name: 'Model and thinking level' })
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalled()
    expect(paneContent(store).model).toBe('opencode-go/glm-5.2')
    expect(saveServerSettingsPatchSpy).not.toHaveBeenCalled()
  })

  it('closes without a dialog and reports unavailability when the catalog probe fails', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ok: false,
      sessionType: 'freshopencode',
      runtimeProvider: 'opencode',
      status: 'unavailable',
      fetchedAt: 1_234,
      models: [],
      error: { code: 'CAPABILITY_PROBE_FAILED', message: 'nope' },
    })
    const onClose = vi.fn()
    const onCatalogUnavailable = vi.fn()
    const store = createStore()
    seedFreshopencodePane(store)

    renderDialog(store, { open: true, onClose, onCatalogUnavailable })

    await waitFor(() => expect(onCatalogUnavailable).toHaveBeenCalled())
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByRole('dialog', { name: 'Model and thinking level' })).not.toBeInTheDocument()
  })
})

describe('FreshAgentModelDialog (freshcodex)', () => {
  beforeEach(() => getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
    ok:true,sessionType:'freshcodex',runtimeProvider:'codex',status:'fresh',fetchedAt:1234,
    models:[['gpt-6-astra','GPT-6 Astra'],['gpt-5.6-luna','GPT-5.6 Luna'],['gpt-5.6-sol','GPT-5.6 Sol']].map(([id,displayName]) => ({
      id,displayName,provider:'codex',supportsEffort:true,supportedEffortLevels:['low','medium','high','xhigh','max'],defaultEffort:'max',supportsAdaptiveThinking:false,
    })),
  }))

  const nativeCatalog = {
    ok: true as const, sessionType: 'freshcodex' as const, runtimeProvider: 'codex' as const,
    status: 'fresh' as const, fetchedAt: 1234,
    models: [{ id: 'provider-current', displayName: 'Provider Current', provider: 'codex' as const,
      supportsEffort: true, supportedEffortLevels: ['none', 'ultra'], defaultEffort: 'ultra',
      inputModalities: ['text', 'image'], supportsAdaptiveThinking: false }],
  }

  it('offers Codex Default as an explicit effort clear through the real pane, configure and saved defaults', async () => {
    const store = createStore()
    seedFreshcodexPane(store, { model: 'provider-current', effort: 'ultra' })
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue(nativeCatalog)
    renderDialog(store, { open: true })
    await screen.findByRole('listbox', { name: 'Thinking levels for Provider Current' })
    await screen.findByRole('option', { name: /^ultra\b/ })
    fireEvent.click(screen.getByRole('option', { name: 'Default', exact: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Provider Current · Default' }))
    expect(paneContent(store).effort).toBeUndefined()
    expect(paneContent(store).effortIsNativeDefault).toBe(true)
    expect(wsSendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.configure', settings: { model: 'provider-current', effort: null } }))
    // The established settings thunk encodes an own undefined as JSON null.
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({ freshAgent: { providers: { freshcodex: { modelSelection: { kind: 'exact', modelId: 'provider-current' }, effort: undefined } } } })
  })

  it('keeps a custom model and effort staged before create acknowledgement when the later catalog omits them', async () => {
    const store = createStore()
    seedFreshcodexPane(store, { sessionId: undefined, status: 'creating' })
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({ ...nativeCatalog, models: [] })
    renderDialog(store, { open: true })
    fireEvent.change(screen.getByRole('textbox', { name: 'Exact model ID' }), { target: { value: 'unlisted-custom' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Reasoning effort' }), { target: { value: 'ultra' } })
    expect(paneContent(store).model).toBe('gpt-6-astra')
    store.dispatch(mergePaneContent({ tabId:'tab-1',paneId:'pane-1',updates:{sessionId:'ack-custom',status:'idle'} }))
    await waitFor(() => expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name:'Use unlisted-custom · ultra' }))
    expect(paneContent(store)).toMatchObject({model:'unlisted-custom',effort:'ultra'})
  })

  it('automatically probes the acknowledged runtime without erasing pre-create search or the saved exact choice', async () => {
    const store = createStore()
    seedFreshcodexPane(store, { sessionId: undefined, status: 'creating', model: 'saved-custom', effort: 'xhigh' })
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue(nativeCatalog)
    renderDialog(store, { open: true })
    expect(getFreshAgentModelCapabilitiesSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('status')).toHaveTextContent(/waiting.*runtime/i)
    const search = screen.getByRole('searchbox')
    fireEvent.change(search, { target: { value: 'provider' } })
    store.dispatch(mergePaneContent({ tabId: 'tab-1', paneId: 'pane-1', updates: { sessionId: 'bound-native', status: 'idle' } }))
    await waitFor(() => expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('freshcodex', expect.objectContaining({
      codexContext: expect.objectContaining({ sessionId: 'bound-native', cwd: '/repo/project-a' }),
    })))
    fireEvent.click(await screen.findByRole('option', { name: 'Provider Current' }))
    expect(search).toHaveValue('provider')
    fireEvent.click(screen.getByRole('button', { name: 'Use Provider Current · ultra' }))
    expect(paneContent(store)).toMatchObject({ model: 'provider-current', effort: 'ultra' })
    expect(wsSendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'freshAgent.configure', settings: { model: 'provider-current', effort: 'ultra' } }))
  })

  it('keeps the bound catalog stable when the same session reference is rematerialized', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const store = createStore()
      const owner = { type: 'session.runtimeOwner' as const, provider: 'codex', sessionId: 'thread-dialog',
        epoch: 7, generation: 3, ownerKind: 'fresh-agent' as const, operationId: 'catalog-owner',
        transition: 'handoff-committed' as const }
      store.dispatch(applyRuntimeOwner(owner))
      seedFreshcodexPane(store, { sessionRef: { provider: 'codex', sessionId: 'thread-dialog' } })
      getFreshAgentModelCapabilitiesSpy.mockResolvedValue(nativeCatalog)
      renderDialog(store, { open: true })
      fireEvent.click(await screen.findByRole('option', { name: 'Provider Current' }))
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'provider' } })
      fireEvent.click(screen.getByRole('option', { name: 'none', exact: true }))
      expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(1)
      await act(async () => {
        store.dispatch(mergePaneContent({ tabId: 'tab-1', paneId: 'pane-1', updates: {
          sessionRef: { provider: 'codex', sessionId: 'thread-dialog' },
        } }))
      })
      expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(1)
      now.mockReturnValue(1_001)
      await act(async () => { store.dispatch(applyRuntimeOwner(owner)) })
      expect(getFreshAgentModelCapabilitiesSpy, JSON.stringify(getFreshAgentModelCapabilitiesSpy.mock.calls)).toHaveBeenCalledTimes(1)
      // A real owner transition at the same fence remains a new source.
      await act(async () => { store.dispatch(applyRuntimeOwner({ ...owner, transition: 'handoff-started' })) })
      expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(2)
      expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenLastCalledWith('freshcodex', expect.objectContaining({
        codexContext: expect.objectContaining({ observedEpoch: 7, observedGeneration: 3 }),
      }))
      expect(screen.getByRole('searchbox')).toHaveValue('provider')
      expect(screen.getByRole('button', { name: 'Use Provider Current · none' })).toBeEnabled()
    } finally {
      now.mockRestore()
    }
  })

  it('keeps the exact current model and xhigh visible when catalog fails or omits it', async () => {
    const store = createStore()
    seedFreshcodexPane(store, { model: 'saved-custom', effort: 'xhigh' })
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({ ...nativeCatalog, ok: false, status: 'unavailable', models: [], error: { code: 'CAPABILITY_PROBE_FAILED', message: 'offline' } })
    renderDialog(store, { open: true })
    await waitFor(() => expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: /Use saved-custom.*xhigh/ })).toBeEnabled()
    expect(screen.queryByRole('option', { name: /GPT-6 Astra/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Use saved-custom.*xhigh/ }))
    expect(paneContent(store)).toMatchObject({ model: 'saved-custom', effort: 'xhigh' })
  })

  it('rejects a delayed old-context catalog after rebind while preserving search and staged selection', async () => {
    const store = createStore()
    seedFreshcodexPane(store, { model: 'saved-custom', effort: 'xhigh' })
    let release!: (v: typeof nativeCatalog) => void
    getFreshAgentModelCapabilitiesSpy.mockReturnValueOnce(new Promise((r) => { release = r })).mockResolvedValue(nativeCatalog)
    renderDialog(store, { open: true })
    await waitFor(() => expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'provider' } })
    store.dispatch(mergePaneContent({ tabId: 'tab-1', paneId: 'pane-1', updates: { sessionId: 'replacement-native' } }))
    fireEvent.click(await screen.findByRole('option', { name: 'Provider Current' }))
    release({ ...nativeCatalog, models: [{ ...nativeCatalog.models[0], id: 'stale-model', displayName: 'Stale Provider' }] })
    await waitFor(() => expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('searchbox')).toHaveValue('provider')
    expect(screen.queryByRole('option', { name: 'Stale Provider' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use Provider Current · ultra' })).toBeEnabled()
  })

  it('shows unavailable after failed ordinary creation without creating a catalog runtime', () => {
    const store = createStore()
    seedFreshcodexPane(store, { sessionId: undefined, status: 'create-failed', model: 'saved-custom', effort: 'ultra' })
    renderDialog(store, { open: true })
    expect(screen.getByRole('status')).toHaveTextContent(/catalog unavailable/i)
    expect(getFreshAgentModelCapabilitiesSpy).not.toHaveBeenCalled()
    expect(wsSendSpy).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /Use saved-custom.*ultra/ })).toBeEnabled()
  })
  it('preserves the current thinking level when confirming an unchanged model', () => {
    const store = createStore()
    seedFreshcodexPane(store, { effort: 'low' })
    renderDialog(store, { open: true })
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-6 Astra · low' }))
    expect(paneContent(store).effort).toBe('low')
  })

  it('discards a cancelled model selection when the dialog reopens', async () => {
    const store = createStore()
    seedFreshcodexPane(store)
    const view = renderDialog(store, { open: true })
    fireEvent.click(await screen.findByRole('option', { name: /GPT-5\.6 Luna/ }))
    view.rerender(<Provider store={store}><StoreBackedDialog open={false} /></Provider>)
    view.rerender(<Provider store={store}><StoreBackedDialog open /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-6 Astra · max' }))
    expect(paneContent(store).model).toBe('gpt-6-astra')
  })
  it('commits a freshcodex model + level under the freshcodex provider defaults and MRU scope', async () => {
    const onClose = vi.fn()
    const store = createStore()
    seedFreshcodexPane(store)

    renderDialog(store, { open: true, onClose })

    fireEvent.click(await screen.findByRole('option', { name: /GPT-5\.6 Luna/ }))
    const levelsList = screen.getByRole('listbox', { name: 'Thinking levels for GPT-5.6 Luna' })
    fireEvent.click(Array.from(levelsList.querySelectorAll('[role="option"]')).find((el) => el.textContent?.includes('low'))!)
    fireEvent.click(screen.getByRole('button', { name: 'Use GPT-5.6 Luna · low' }))

    expect(onClose).toHaveBeenCalled()
    const content = paneContent(store)
    expect(content.model).toBe('gpt-5.6-luna')
    expect(content.effort).toBe('low')

    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshcodex: {
            modelSelection: { kind: 'exact', modelId: 'gpt-5.6-luna' },
            effort: 'low',
          },
        },
      },
    })
    const levelMru = JSON.parse(window.localStorage.getItem('freshcodex.modelLevelMru.v1') ?? '[]')
    expect(levelMru).toEqual([expect.objectContaining({ modelId: 'gpt-5.6-luna', level: 'low' })])
  })

  it('uses the bound native catalog while preserving the current row, advertised models and thinking levels', async () => {
    const store = createStore()
    seedFreshcodexPane(store)
    renderDialog(store, {open:true})
    await screen.findByRole('option', {name:/GPT-5\.6 Luna/})
    expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('freshcodex',expect.objectContaining({
      codexContext:expect.objectContaining({sessionId:'thread-dialog',cwd:'/repo/project-a'}),
    }))
    expect(screen.getAllByRole('option',{name:/GPT-6 Astra.*current/}).length).toBeGreaterThanOrEqual(1)
    await waitFor(() => {
      const levels = screen.getByRole('listbox', { name: 'Thinking levels for GPT-6 Astra' })
      const names = Array.from(levels.querySelectorAll('[role="option"]'))
        .map(el => el.textContent?.replace(/last used|highest|current|●/g, '').trim())
      expect(names).toEqual(['Default', 'low', 'medium', 'high', 'xhigh', 'max'])
    })
    fireEvent.click(screen.getByRole('button',{name:'Use GPT-6 Astra · max'}))
    expect(paneContent(store)).toMatchObject({model:'gpt-6-astra',effort:'max'})
  })
})

describe('FreshAgentModelDialog (freshclaude)', () => {
  it('does not prune another project’s recent models with the previous project’s catalog', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValueOnce({
      ...CLAUDE_CATALOG_RESPONSE,
      models: [{ ...CLAUDE_CATALOG_RESPONSE.models[1], id: 'old-model', displayName: 'Old model' }],
    }).mockReturnValueOnce(new Promise(() => {}))
    window.localStorage.setItem('freshclaude.modelMru.v2', JSON.stringify([{
      id: 'sonnet', displayName: 'Sonnet', source: { id: 'claude', displayName: 'Claude' },
      cwdKey: '/repo/project-b', lastVerifiedAt: Date.now(),
    }]))
    const store = createStore()
    seedFreshclaudePane(store)
    renderDialog(store, { open: true })
    await screen.findByRole('option', { name: /^Old model$/ })
    store.dispatch(mergePaneContent({ tabId: 'tab-1', paneId: 'pane-1', updates: { initialCwd: '/repo/project-b' } }))
    await waitFor(() => expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(2))
    expect(JSON.parse(window.localStorage.getItem('freshclaude.modelMru.v2') ?? '[]')).toContainEqual(
      expect.objectContaining({ id: 'sonnet', cwdKey: '/repo/project-b' }),
    )
    expect(screen.queryByRole('option', { name: /^Old model$/ })).not.toBeInTheDocument()
  })
  it('keeps typed search text when the live catalog arrives', async () => {
    let resolveProbe!: (value: typeof CLAUDE_CATALOG_RESPONSE) => void
    getFreshAgentModelCapabilitiesSpy.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve }))
    const store = createStore()
    seedFreshclaudePane(store)
    renderDialog(store, { open: true })
    const search = screen.getByRole('searchbox', { name: 'Filter models' })
    fireEvent.change(search, { target: { value: 'sonnet' } })
    resolveProbe(CLAUDE_CATALOG_RESPONSE)
    await screen.findByRole('option', { name: /^Sonnet$/ })
    expect(search).toHaveValue('sonnet')
    expect(screen.queryByRole('option', { name: /Opus/ })).not.toBeInTheDocument()
  })

  it('remembers Claude models and thinking choices across dialog sessions', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue(CLAUDE_CATALOG_RESPONSE)
    const store = createStore()
    seedFreshclaudePane(store)
    const view = renderDialog(store, { open: true })
    fireEvent.click(await screen.findByRole('option', { name: /^Sonnet$/ }))
    fireEvent.click(screen.getByRole('option', { name: /^low$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Sonnet · low' }))
    view.unmount()
    const nextStore = createStore()
    seedFreshclaudePane(nextStore)
    renderDialog(nextStore, { open: true })
    await waitFor(() => expect(screen.getByRole('listbox', { name: 'Models' })).toHaveTextContent('Recent'))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Filter models' }), { target: { value: 'Sonnet' } })
    fireEvent.click((await screen.findAllByRole('option', { name: /^Sonnet$/ }))[0])
    fireEvent.click(screen.getByRole('button', { name: 'Use Sonnet · low' }))
    expect(paneContent(nextStore)).toMatchObject({ model: 'sonnet', effort: 'low' })
  })
  it('renders the static claude row immediately and merges the probed claude catalog static-wins', async () => {
    // Deferred probe: statics render instantly (no loading gate), exactly like
    // the settings popover's claude path.
    let resolveProbe: ((value: typeof CLAUDE_CATALOG_RESPONSE) => void) | undefined
    getFreshAgentModelCapabilitiesSpy.mockReturnValueOnce(
      new Promise((resolve) => { resolveProbe = resolve }),
    )
    const store = createStore()
    seedFreshclaudePane(store)

    renderDialog(store, { open: true })

    const modelsList = await screen.findByRole('listbox', { name: 'Models' })
    expect(modelsList).toHaveTextContent('Claude Opus 5 (1M context)')
    expect(screen.getByRole('option', { name: /Claude Opus 5 \(1M context\).*current/ })).toBeInTheDocument()
    expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('freshclaude', expect.objectContaining({ cwd: '/repo/project-a' }))

    resolveProbe!(CLAUDE_CATALOG_RESPONSE)

    // probed alias rows surface; the probed opus[1m] row dedupes into the
    // static row (static label wins)
    await screen.findByRole('option', { name: /^Sonnet$/ })
    expect(screen.getAllByRole('option', { name: /Opus/ })).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Claude Opus 5 \(1M context\)/ })).toBeInTheDocument()
  })

  it('commits a probed-only claude model: stores the selection, stamps modelEffortLevels (popover semantics), persists provider defaults', async () => {
    const onClose = vi.fn()
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue(CLAUDE_CATALOG_RESPONSE)
    const store = createStore()
    seedFreshclaudePane(store)

    renderDialog(store, { open: true, onClose })

    fireEvent.click(await screen.findByRole('option', { name: /^Sonnet$/ }))
    const levelsList = screen.getByRole('listbox', { name: 'Thinking levels for Sonnet' })
    fireEvent.click(Array.from(levelsList.querySelectorAll('[role="option"]')).find((el) => el.textContent?.includes('low'))!)
    fireEvent.click(screen.getByRole('button', { name: 'Use Sonnet · low' }))

    expect(onClose).toHaveBeenCalled()
    const content = paneContent(store)
    expect(content.model).toBe('sonnet')
    expect(content.modelSelection).toEqual({ kind: 'exact', modelId: 'sonnet' })
    expect(content.effort).toBe('low')
    // the stamp the settings popover writes for the same probed row, so later
    // effort normalization clamps against THESE levels, never the static
    // table's default-model fallback
    expect(content.modelEffortLevels).toEqual(['low', 'medium', 'high'])
    // the pick-time display label for the status-strip chip (catalog-only ids
    // would otherwise render their raw id until a probe resolves)
    expect(content.modelLabel).toEqual({ modelId: 'sonnet', label: 'Sonnet' })

    // The levels travel with the saved default, paired with their model, so
    // a new pane on this default clamps effort against them too.
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshclaude: {
            modelSelection: { kind: 'exact', modelId: 'sonnet' },
            effort: 'low',
            modelEffortLevels: { modelId: 'sonnet', levels: ['low', 'medium', 'high'] },
          },
        },
      },
    })
  })

  it('commits the static claude row with its static levels stamped (popover parity for static rows)', async () => {
    const onClose = vi.fn()
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue(CLAUDE_CATALOG_RESPONSE)
    const store = createStore()
    seedFreshclaudePane(store)

    renderDialog(store, { open: true, onClose })

    fireEvent.click(await screen.findByRole('option', { name: /Claude Opus 5 \(1M context\)/ }))
    fireEvent.click(screen.getByRole('option', { name: /^max highest$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Claude Opus 5 (1M context) · max' }))

    expect(onClose).toHaveBeenCalled()
    const content = paneContent(store)
    expect(content.model).toBe('opus[1m]')
    expect(content.effort).toBe('max')
    expect(content.modelEffortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('commits a probed claude row that declares no effort levels with an empty-levels stamp (never the static fallback)', async () => {
    const onClose = vi.fn()
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ...CLAUDE_CATALOG_RESPONSE,
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
    seedFreshclaudePane(store)

    renderDialog(store, { open: true, onClose })

    fireEvent.click(await screen.findByRole('option', { name: /^Haiku$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Use Haiku · Default' }))

    expect(onClose).toHaveBeenCalled()
    const content = paneContent(store)
    expect(content.model).toBe('haiku')
    expect(content.effort).toBeUndefined()
    expect(content.modelEffortLevels).toEqual([])
    expect(saveServerSettingsPatchSpy).toHaveBeenCalledWith({
      freshAgent: {
        providers: {
          freshclaude: {
            modelSelection: { kind: 'exact', modelId: 'haiku' },
            effort: undefined,
            modelEffortLevels: { modelId: 'haiku', levels: [] },
          },
        },
      },
    })
  })

  it('degrades to the static claude rows when the claude catalog probe fails (dialog stays open, no unavailable notice)', async () => {
    getFreshAgentModelCapabilitiesSpy.mockRejectedValue(new Error('probe down'))
    const onClose = vi.fn()
    const onCatalogUnavailable = vi.fn()
    const store = createStore()
    seedFreshclaudePane(store)

    renderDialog(store, { open: true, onClose, onCatalogUnavailable })

    expect(await screen.findByRole('option', { name: /Claude Opus 5 \(1M context\)/ })).toBeInTheDocument()
    await waitFor(() => expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledTimes(1))
    expect(onCatalogUnavailable).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('stamps no modelLabel when the picked row\'s displayName echoes its raw id (raw ids are tooltip-only)', async () => {
    const onClose = vi.fn()
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ...CLAUDE_CATALOG_RESPONSE,
      models: [
        {
          // e.g. opencode's no-name fallback: the catalog itself has no real
          // display name, so displayName === id. Stamping it would put a raw
          // id on the status-strip chip.
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
    seedFreshclaudePane(store)

    renderDialog(store, { open: true, onClose })

    fireEvent.click(await screen.findByRole('option', { name: /^claude-ish\/unnamed-7$/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Use claude-ish/unnamed-7 · Default' }))

    expect(onClose).toHaveBeenCalled()
    const content = paneContent(store)
    expect(content.model).toBe('claude-ish/unnamed-7')
    expect(content.modelLabel).toBeUndefined()
  })
})

describe('FreshAgentModelDialog (kilroy)', () => {
  it('renders the kilroy static claude row and probes with the kilroy session type', async () => {
    getFreshAgentModelCapabilitiesSpy.mockResolvedValue({
      ...CLAUDE_CATALOG_RESPONSE,
      sessionType: 'kilroy' as const,
    })
    const store = createStore()
    seedKilroyPane(store)

    renderDialog(store, { open: true })

    await screen.findByRole('dialog', { name: 'Model and thinking level' })
    expect(screen.getByRole('option', { name: /Claude Opus 5 \(1M context\)/ })).toBeInTheDocument()
    expect(getFreshAgentModelCapabilitiesSpy).toHaveBeenCalledWith('kilroy', expect.objectContaining({ cwd: '/repo/project-a' }))
  })
})

describe('FreshAgentModelDialog (scope-driven footer)', () => {
  it('renders the create-only footer copy when settingScopes marks model and effort create-only', async () => {
    const store = createStore()
    seedFreshopencodePane(store)

    renderDialog(store, {
      open: true,
      settingScopes: { model: 'create-only', effort: 'create-only' },
    })

    const dialog = await screen.findByRole('dialog', { name: 'Model and thinking level' })
    expect(dialog).toHaveTextContent('applies at session start · becomes your default')
    expect(dialog).not.toHaveTextContent('applies from your next message')
  })

  it('renders the per-send footer copy when settingScopes marks model and effort per-send', async () => {
    const store = createStore()
    seedFreshopencodePane(store)

    renderDialog(store, {
      open: true,
      settingScopes: { model: 'per-send', effort: 'per-send' },
    })

    const dialog = await screen.findByRole('dialog', { name: 'Model and thinking level' })
    expect(dialog).toHaveTextContent('applies from your next message · becomes your default')
    expect(dialog).not.toHaveTextContent('applies at session start')
  })
})
