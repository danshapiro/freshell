import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { FRESHCODEX_DEFAULT_MODEL } from '@shared/fresh-agent-models.js'

const codexCatalog = {
  ok: true, sessionType: 'freshcodex', runtimeProvider: 'codex', status: 'fresh', fetchedAt: 1234,
  models: [{ id: 'provider-current', displayName: 'Provider Current', provider: 'codex',
    supportsEffort: true, supportedEffortLevels: ['none', 'ultra'], defaultEffort: 'ultra',
    inputModalities: ['text', 'image'], supportsAdaptiveThinking: false }],
}

test('Codex discovers only the bound runtime and preserves search and exact settings across rebind', async ({ freshellPage, page, terminal }) => {
  await terminal.waitForTerminal()
  let releaseOld!: () => void
  const oldHeld = new Promise<void>((resolve) => { releaseOld = resolve })
  const contexts: URLSearchParams[] = []
  await page.route('**/api/fresh-agent/model-capabilities/freshcodex**', async (route) => {
    const query = new URL(route.request().url()).searchParams
    contexts.push(query)
    if (contexts.length === 1) {
      await oldHeld
      await route.fulfill({ json: { ...codexCatalog, models: [{ ...codexCatalog.models[0], id: 'stale-model', displayName: 'Stale Provider' }] } })
    } else await route.fulfill({ json: codexCatalog })
  })
  await installPane(page, 'codex')
  await page.getByRole('button', { name: /^Model:.*change model$/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
  await expect.poll(() => contexts.length).toBe(1)
  await dialog.getByRole('searchbox').fill('provider')
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    const state = harness.getState()
    const tabId = state.tabs.activeTabId!
    const paneId = state.panes.activePane[tabId]
    harness.dispatch({ type: 'panes/mergePaneContent', payload: { tabId, paneId,
      updates: { sessionId: 'replacement-native', sessionRef: { provider: 'codex', sessionId: 'replacement-native' } } } })
  })
  await dialog.getByRole('option', { name: 'Provider Current', exact: true }).click()
  releaseOld()
  await expect(dialog.getByRole('searchbox')).toHaveValue('provider')
  await expect(dialog.getByRole('option', { name: 'Stale Provider' })).toHaveCount(0)
  await expect.poll(() => contexts.length).toBe(2)
  expect(contexts[0].get('sessionId')).toBe('d4430000-0000-4444-8444-000000000001')
  expect(contexts[1].get('sessionId')).toBe('replacement-native')
  await dialog.getByRole('button', { name: 'Use Provider Current · ultra' }).click()
  await expect.poll(() => page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__!.getState()
    const layout = state.panes.layouts[state.tabs.activeTabId!]
    return layout?.type === 'leaf' ? { model: layout.content.model, effort: layout.content.effort } : null
  })).toEqual({ model: 'provider-current', effort: 'ultra' })
})

test('Codex picker waits for ordinary create and shows honest failure with exact saved input', async ({ freshellPage, page, terminal }) => {
  await terminal.waitForTerminal()
  let probes = 0
  await page.route('**/api/fresh-agent/model-capabilities/freshcodex**', async (route) => {
    probes++
    await route.fulfill({ json: codexCatalog })
  })
  await installPane(page, 'codex')
  const setStatus = async (status: string, sessionId?: string) => page.evaluate(({ status, sessionId }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    const state = harness.getState()
    const tabId = state.tabs.activeTabId!
    const paneId = state.panes.activePane[tabId]
    harness.dispatch({ type: 'panes/mergePaneContent', payload: { tabId, paneId, updates: {
      status, sessionId, sessionRef: undefined, resumeSessionId: undefined,
      model: 'saved-custom', modelSelection: { kind: 'exact', modelId: 'saved-custom' }, effort: 'xhigh',
    } } })
  }, { status, sessionId })
  await setStatus('creating')
  await page.getByRole('button', { name: /^Model:.*change model$/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
  await expect(dialog.getByRole('status')).toContainText(/waiting.*runtime/i)
  await dialog.getByRole('searchbox').fill('provider')
  expect(probes).toBe(0)
  await setStatus('idle', 'acknowledged-native')
  await expect(dialog.getByRole('option', { name: 'Provider Current' })).toBeVisible()
  await expect(dialog.getByRole('searchbox')).toHaveValue('provider')
  expect(probes).toBe(1)
  await setStatus('create-failed')
  await expect(dialog.getByRole('status')).toContainText(/catalog unavailable/i)
  await dialog.getByRole('searchbox').fill('')
  await expect(dialog.getByRole('button', { name: /Use saved-custom.*xhigh/ })).toBeEnabled()
  expect(probes).toBe(1)
})

async function installPane(page: Page, provider: 'claude' | 'codex') {
  const sessionType = provider === 'claude' ? 'freshclaude' : 'freshcodex'
  const sessionId = 'd4430000-0000-4444-8444-000000000001'
  const model = provider === 'claude' ? 'opus[1m]' : FRESHCODEX_DEFAULT_MODEL
  await page.route('**/api/fresh-agent/threads/**', (route) => route.fulfill({
    json: {
      sessionType, provider, sessionId, threadId: sessionId,
      revision: 1, latestTurnId: null, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
      settings: { model, effort: 'low' },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      pendingApprovals: [], pendingQuestions: [], turns: [],
      extensions: provider === 'claude' ? { claude: { liveSessionId: sessionId, cliSessionId: sessionId } } : {},
    },
  }))
  await page.evaluate(({ sessionType, provider, sessionId, model }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    const state = harness.getState()
    const tabId = state.tabs.activeTabId!
    const paneId = state.panes.activePane[tabId]
    harness.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    harness.dispatch({ type: 'panes/updatePaneContent', payload: {
      tabId, paneId, content: {
        kind: 'fresh-agent', sessionType, provider, sessionId,
        sessionRef: { provider, sessionId }, resumeSessionId: sessionId,
        createRequestId: `model-dialog-${provider}`, status: 'idle',
        model, effort: 'low', initialCwd: '/tmp', settingsDismissed: true,
      },
    } })
  }, { sessionType, provider, sessionId, model })
}

test('Claude model search survives catalog loading and remembers a selected thinking level', async ({ freshellPage, page, terminal }) => {
  await terminal.waitForTerminal()
  let releaseCatalog!: () => void
  const catalogReady = new Promise<void>((resolve) => { releaseCatalog = resolve })
  await page.route('**/api/fresh-agent/model-capabilities/freshclaude?**', async (route) => {
    await catalogReady
    await route.fulfill({ json: {
      ok: true, sessionType: 'freshclaude', runtimeProvider: 'claude', status: 'fresh', fetchedAt: Date.now(),
      models: [{ id: 'sonnet', displayName: 'Sonnet', provider: 'claude', supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high'], supportsAdaptiveThinking: false }],
    } })
  })
  await installPane(page, 'claude')
  await page.getByRole('button', { name: /^Model:.*change model$/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
  await expect(dialog.getByRole('button', { name: 'Use Claude Opus 5 (1M context) · low' })).toBeVisible()
  await dialog.getByRole('searchbox', { name: 'Filter models' }).fill('sonnet')
  releaseCatalog()
  await dialog.getByRole('option', { name: 'Sonnet', exact: true }).click()
  await expect(dialog.getByRole('searchbox')).toHaveValue('sonnet')
  await dialog.getByRole('option', { name: 'low', exact: true }).click()
  await dialog.getByRole('button', { name: 'Use Sonnet · low' }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: /^Model:.*change model$/ }).click()
  await expect(dialog.getByRole('listbox', { name: 'Models', exact: true })).toContainText('Recent')
  await expect(dialog.getByRole('button', { name: 'Use Sonnet · low' })).toBeVisible()
})

test('Codex cancels a staged model change and preserves its current thinking level', async ({ freshellPage, page, terminal }) => {
  await terminal.waitForTerminal()
  await page.route('**/api/fresh-agent/model-capabilities/freshcodex**',route=>route.fulfill({json:{...codexCatalog,models:[
    {id:FRESHCODEX_DEFAULT_MODEL,displayName:'GPT-6 Astra',provider:'codex',supportsEffort:true,supportedEffortLevels:['low','high','xhigh'],defaultEffort:'high',supportsAdaptiveThinking:false},
    ...codexCatalog.models,
  ]}}))
  await installPane(page, 'codex')
  const chip = page.getByRole('button', { name: /^Model:.*change model$/ })
  await chip.click()
  const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
  await expect(dialog.getByRole('button', { name: 'Use GPT-6 Astra · low' })).toBeVisible()
  await dialog.getByRole('option', { name: 'Provider Current', exact:true }).click()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await chip.click()
  await dialog.getByRole('button', { name: 'Use GPT-6 Astra · low' }).click()
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click()
  const permissions = page.getByRole('combobox', { name: 'Permission mode' })
  await permissions.selectOption('untrusted')
  await expect(permissions).toHaveValue('untrusted')
  await permissions.selectOption('never')
  await expect(permissions).toHaveValue('never')
  await expect(permissions.getByRole('option', { name: 'Never ask', exact: true })).toBeAttached()
})
