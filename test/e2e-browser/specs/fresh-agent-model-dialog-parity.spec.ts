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
  const contexts: Record<string, string>[] = []
  await page.route('**/api/fresh-agent/model-capabilities/freshcodex**', async route => {
    contexts.push(Object.fromEntries(new URL(route.request().url()).searchParams))
    await route.fulfill({ json: codexCatalog })
  })
  const creates = () => page.evaluate(() =>
    (window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.() ?? [])
      .filter((frame: any) => frame?.type === 'freshAgent.create')
      .map((frame: any) => ({ requestId: frame.requestId, model: frame.model, effort: frame.effort })))
  const begin = (requestId: string) => installPane(page, 'codex', { requestId, model: 'saved-custom', effort: 'xhigh' })
  const open = async () => {
    await page.getByRole('button', { name: 'Agent settings', exact: true }).click()
    await page.getByRole('button', { name: /saved-custom.*Change/ }).click()
  }
  const firstRequest = 'model-dialog-codex-ack-create'
  await begin(firstRequest)
  await expect.poll(creates).toEqual([{ requestId: firstRequest, model: 'saved-custom', effort: 'xhigh' }])
  await open()
  const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
  await expect(dialog.getByRole('status')).toContainText(/waiting.*runtime/i)
  await dialog.getByRole('textbox', { name: 'Exact model ID' }).fill('staged-custom')
  await dialog.getByRole('textbox', { name: 'Reasoning effort' }).fill('ultra')
  await dialog.getByRole('searchbox').fill('provider')
  expect(contexts).toHaveLength(0)
  expect(await creates()).toHaveLength(1)
  await page.evaluate(requestId => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    if (!harness.receiveWsMessage) throw new Error('Public receive-message fixture is required')
    harness.receiveWsMessage({ type: 'freshAgent.created', requestId,
      sessionId: 'acknowledged-native', sessionRef: { provider: 'codex', sessionId: 'acknowledged-native' },
      sessionType: 'freshcodex', provider: 'codex', runtimeProvider: 'codex' })
  }, firstRequest)
  await expect(dialog.getByRole('option', { name: 'Provider Current', exact: true })).toBeVisible()
  await expect(dialog.getByRole('searchbox')).toHaveValue('provider')
  await expect(dialog.getByRole('button', { name: 'Use staged-custom · ultra' })).toBeEnabled()
  expect(contexts).toEqual([{ sessionId: 'acknowledged-native',
    sessionRef: JSON.stringify({ provider: 'codex', sessionId: 'acknowledged-native' }), cwd: '/tmp' }])
  expect(await creates()).toHaveLength(1)
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await page.keyboard.press('Escape')

  const failedRequest = 'model-dialog-codex-failed-create'
  await begin(failedRequest)
  await expect.poll(creates).toEqual([
    { requestId: firstRequest, model: 'saved-custom', effort: 'xhigh' },
    { requestId: failedRequest, model: 'saved-custom', effort: 'xhigh' },
  ])
  await open()
  await expect(dialog.getByRole('status')).toContainText(/waiting.*runtime/i)
  await dialog.getByRole('searchbox').fill('saved')
  await page.evaluate(requestId => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    if (!harness.receiveWsMessage) throw new Error('Public receive-message fixture is required')
    harness.receiveWsMessage({ type: 'freshAgent.create.failed', requestId,
      code: 'FRESH_AGENT_CREATE_FAILED', message: 'Controlled create failure', retryable: false })
  }, failedRequest)
  await expect(dialog.getByRole('status')).toContainText(/catalog unavailable/i)
  await expect(dialog.getByRole('searchbox')).toHaveValue('saved')
  await dialog.getByRole('searchbox').fill('')
  await expect(dialog.getByRole('button', { name: /Use saved-custom.*xhigh/ })).toBeEnabled()
  expect(contexts).toHaveLength(1)
  expect(await creates()).toHaveLength(2)
})

async function installPane(
  page: Page,
  provider: 'claude' | 'codex',
  creation?: { requestId: string; model: string; effort: string },
) {
  const sessionType = provider === 'claude' ? 'freshclaude' : 'freshcodex'
  const sessionId = creation ? undefined : 'd4430000-0000-4444-8444-000000000001'
  const model = creation?.model ?? (provider === 'claude' ? 'opus[1m]' : FRESHCODEX_DEFAULT_MODEL)
  const effort = creation?.effort ?? 'low'
  const createRequestId = creation?.requestId ?? `model-dialog-${provider}`
  await page.route('**/api/fresh-agent/threads/**', route => {
    const requestedSessionId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!)
    return route.fulfill({ json: {
      sessionType, provider, sessionId: requestedSessionId, threadId: requestedSessionId,
      revision: 1, latestTurnId: null, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
      settings: { model, effort },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      pendingApprovals: [], pendingQuestions: [], turns: [],
      extensions: provider === 'claude' ? { claude: { liveSessionId: requestedSessionId, cliSessionId: requestedSessionId } } : {},
    } })
  })
  await page.evaluate(({ sessionType, provider, sessionId, model, effort, createRequestId }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    const state = harness.getState()
    const tabId = state.tabs.activeTabId!
    const paneId = state.panes.activePane[tabId]
    harness.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    harness.dispatch({ type: 'panes/updatePaneContent', payload: {
      tabId, paneId, content: {
        kind: 'fresh-agent', sessionType, provider,
        ...(sessionId ? { sessionId, sessionRef: { provider, sessionId }, resumeSessionId: sessionId } : {}),
        createRequestId, status: sessionId ? 'idle' : 'creating',
        model, effort, initialCwd: '/tmp', settingsDismissed: true,
      },
    } })
  }, { sessionType, provider, sessionId, model, effort, createRequestId })
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
