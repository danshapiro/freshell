import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'

async function installPane(page: Page, provider: 'claude' | 'codex') {
  const sessionType = provider === 'claude' ? 'freshclaude' : 'freshcodex'
  const sessionId = 'd4430000-0000-4444-8444-000000000001'
  const model = provider === 'claude' ? 'opus[1m]' : 'gpt-5.5'
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
  await installPane(page, 'codex')
  const chip = page.getByRole('button', { name: /^Model:.*change model$/ })
  await chip.click()
  const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
  await expect(dialog.getByRole('button', { name: 'Use GPT-5.5 · low' })).toBeVisible()
  await dialog.getByRole('option', { name: /GPT-5.4 Flash/ }).click()
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await chip.click()
  await dialog.getByRole('button', { name: 'Use GPT-5.5 · low' }).click()
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click()
  const permissions = page.getByRole('combobox', { name: 'Permission mode' })
  await permissions.selectOption('untrusted')
  await expect(permissions).toHaveValue('untrusted')
  await permissions.selectOption('never')
  await expect(permissions).toHaveValue('never')
  await expect(permissions.getByRole('option', { name: 'Never ask', exact: true })).toBeAttached()
})
