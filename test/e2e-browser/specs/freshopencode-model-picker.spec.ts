import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * The shared two-column model + thinking selector (freshopencode leg).
 * Covers: gear-popover entry, /model entry, search filtering, keyboard
 * navigation, commit persistence, the Default row, and the
 * catalog-unavailable state. freshclaude/kilroy keep the old popover list.
 */

const CATALOG = {
  ok: true,
  sessionType: 'freshopencode',
  runtimeProvider: 'opencode',
  status: 'fresh' as const,
  fetchedAt: Date.now(),
  models: [
    {
      id: 'opencode-go/glm-5.2',
      displayName: 'GLM 5.2',
      provider: 'opencode',
      source: { id: 'opencode-go', displayName: 'OpenCode Go' },
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high', 'max'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'deepseek/deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      provider: 'opencode',
      source: { id: 'deepseek', displayName: 'DeepSeek' },
      supportsEffort: true,
      supportedEffortLevels: ['low', 'high'],
      supportsAdaptiveThinking: true,
    },
    {
      id: 'kimi-for-coding/kimi-k2.7',
      displayName: 'Kimi K2.7 Code',
      provider: 'opencode',
      source: { id: 'kimi-for-coding', displayName: 'Kimi For Coding' },
      supportsEffort: false,
      supportedEffortLevels: [],
      supportsAdaptiveThinking: false,
    },
  ],
}

const UNAVAILABLE_CATALOG = {
  ok: false,
  sessionType: 'freshopencode',
  runtimeProvider: 'opencode',
  status: 'unavailable',
  models: [],
  error: { code: 'CAPABILITY_PROBE_FAILED', message: 'probe failed' },
}

async function enableFreshClientsAndOpencode(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: true, opencode: true },
    })
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: {
        codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] },
        freshAgent: { enabled: true },
      },
    })
  })
}

function freshAgentSnapshot(sessionType: string, provider: string, threadId: string) {
  return {
    sessionType,
    provider,
    threadId,
    sessionId: threadId,
    revision: 1,
    latestTurnId: null,
    status: 'idle',
    capabilities: {
      send: true,
      interrupt: true,
      approvals: true,
      questions: true,
      fork: true,
    },
    settings: {
      model: 'opencode-go/glm-5.2',
      permissionMode: undefined,
      plugins: [],
    },
    tokenUsage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
    pendingApprovals: [],
    pendingQuestions: [],
    turns: [],
  }
}

async function routeCatalog(page: Page, catalog: unknown): Promise<void> {
  await page.route('**/api/fresh-agent/model-capabilities/freshopencode?**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(catalog),
    })
  })
}

async function routeThreads(page: Page): Promise<void> {
  await page.route('**/api/fresh-agent/threads/**', async (route) => {
    const url = new URL(route.request().url())
    const [, sessionType = 'freshopencode', provider = 'opencode', threadId = 'ses_e2e'] =
      url.pathname.match(/\/api\/fresh-agent\/threads\/([^/]+)\/([^/]+)\/([^/?]+)/) ?? []
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(freshAgentSnapshot(sessionType, provider, decodeURIComponent(threadId))),
    })
  })
}

async function routeFileApis(page: Page, cwd: string): Promise<void> {
  await page.route('**/api/files/candidate-dirs', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ directories: ['/tmp'] }),
    })
  })
  await page.route('**/api/files/validate-dir', async (route) => {
    const body = route.request().postDataJSON() as { path?: string }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, resolvedPath: body?.path ?? cwd }),
    })
  })
}

/** Create a freshopencode pane through the picker and hand it an idle session
 * id so the composer becomes usable. Sweeping caveat: the picker pane is
 * REPLACED by the real fresh-agent pane with a NEW pane id on selection, so
 * both the suppression flag and the idle-session handoff must target the
 * post-creation active pane (state.panes.activePane[tabId]), never an id
 * captured from the picker DOM (same pattern as fresh-agent.spec.ts).
 */
async function createFreshopencodePane(page: Page, cwd: string): Promise<void> {
  // Suppress ALL fresh-agent network effects BEFORE the pane exists: creation
  // fires its session-create effect immediately, and a per-pane flag set after
  // the fact races it — livelocked as "Fresh clients are disabled" (server
  // rejection of the unsuppressed request) followed by a stuck `ended` state.
  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.setSuppressAllFreshAgentNetworkEffects(true)
  })
  const picker = await openPanePicker(page)
  await expect(picker.getByRole('button', { name: /^Freshopencode$/i })).toBeVisible({ timeout: 10_000 })
  await picker.getByRole('button', { name: /^Freshopencode$/i }).click({ force: true })
  const directoryInput = page.getByLabel(/^Starting directory for Freshopencode$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 15_000 })

  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) return
    const state = harness.getState()
    const tabId = state.tabs.activeTabId as string | undefined
    if (!tabId) return
    // The tab may be a SPLIT (terminal + fresh pane), so the top layout node is
    // a 'split' — walk the tree for the fresh-agent leaf rather than assuming
    // the root is a leaf.
    type LayoutNode = { id: string; type: string; content?: { kind?: string }; children?: LayoutNode[] }
    const findFreshLeaf = (node: LayoutNode | undefined): LayoutNode | undefined => {
      if (!node) return undefined
      if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
      for (const child of node.children ?? []) {
        const found = findFreshLeaf(child)
        if (found) return found
      }
      return undefined
    }
    const leaf = findFreshLeaf(state.panes.layouts[tabId] as LayoutNode | undefined)
    if (!leaf) return
    harness.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId: leaf.id,
        content: { ...leaf.content, sessionId: 'ses_e2e', status: 'idle' },
      },
    })
  })
}

async function openFreshAgentSettings(page: Page) {
  const pane = page.getByRole('group').filter({
    // The pane banner badge renders the provider lowercase ("freshopencode");
    // fresh-agent.spec.ts's identical helper filters on providerName.toLowerCase().
    has: page.getByText('freshopencode', { exact: true }),
  }).last()
  await expect(pane).toBeVisible({ timeout: 10_000 })

  // The popover is portaled to document.body (it must escape the pane header's
  // overflow-hidden clip stripe), so scope the dialog to the page, not the pane.
  const dialog = page.getByRole('dialog', { name: 'Agent settings' })
  if (!(await dialog.isVisible().catch(() => false))) {
    await pane.getByRole('button', { name: /^agent settings$/i }).click()
  }

  await expect(dialog).toBeVisible({ timeout: 10_000 })
  await expectPopoverUnclipped(dialog)
  return dialog
}

/** A header-clipped popover keeps a non-zero bounding box (toBeVisible passes)
 * but its interior receives no pointer hits below the header stripe. Pin the
 * portal escape via a hit-test at the dialog's center. */
async function expectPopoverUnclipped(dialog: Locator): Promise<void> {
  const hitInside = await dialog.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const probe = document.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    )
    return probe !== null && (probe === el || el.contains(probe))
  })
  expect(hitInside).toBe(true)
}

test.describe('Freshopencode model + thinking selector', () => {
  test('gear popover shows a compact Model row that opens the dialog; commit persists the provider default', async ({
    freshellPage,
    page,
    harness,
    terminal,
  }) => {
    await terminal.waitForTerminal()
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-model-selector-'))

    let capturedUrl: string | undefined
    await page.route('**/api/fresh-agent/model-capabilities/freshopencode?**', async (route) => {
      capturedUrl = route.request().url()
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(CATALOG),
      })
    })
    await routeThreads(page)
    await routeFileApis(page, cwd)
    await enableFreshClientsAndOpencode(page)
    await createFreshopencodePane(page, cwd)

    const settings = await openFreshAgentSettings(page)

    // Compact row: current model · level + Change…; retired tiles/search entry.
    const modelRow = settings.getByRole('button', { name: /GLM 5\.2 · max.*Change/ })
    await expect(modelRow).toBeVisible({ timeout: 10_000 })
    await expect(settings.getByRole('searchbox', { name: /Search enabled models/i })).toHaveCount(0)
    await expect(settings.getByRole('searchbox', { name: 'Thinking level' })).toHaveCount(0)
    expect(capturedUrl).toContain('cwd=')

    await modelRow.click()
    const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })

    const search = dialog.getByRole('searchbox', { name: 'Filter models' })
    await expect(search).toBeFocused()

    // Provider groups + the current model marker
    const modelsList = dialog.getByRole('listbox', { name: 'Models' })
    await expect(modelsList).toContainText('DeepSeek')
    await expect(modelsList).toContainText('OpenCode Go')
    await expect(dialog.getByRole('option', { name: /GLM 5\.2 current/ }).first()).toBeVisible()

    // Real per-model levels for the current model, canonically ordered
    const levelsList = dialog.getByRole('listbox', { name: 'Thinking levels for GLM 5.2' })
    await expect(levelsList).toBeVisible()
    const levelTexts = (await levelsList.getByRole('option').allTextContents())
      .map((text) => text.replace(/last used|highest|current|●/g, '').trim())
    expect(levelTexts).toEqual(['low', 'high', 'max'])
    await expect(dialog.getByRole('button', { name: 'Use GLM 5.2 · max' })).toBeVisible()

    // Search filters the left column
    await search.fill('deepseek')
    await expect(dialog.getByRole('option', { name: /GLM 5\.2/ })).toHaveCount(0)
    const deepseekOption = dialog.getByRole('option', { name: /DeepSeek V4 Pro/ })
    await expect(deepseekOption).toBeVisible()
    await expect(dialog.getByRole('listbox', { name: 'Thinking levels for DeepSeek V4 Pro' })).toBeVisible()

    // Keyboard: switch to levels, move to low, Enter commits
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowUp')
    await expect(dialog.getByRole('button', { name: 'Use DeepSeek V4 Pro · low' })).toBeVisible()
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)

    await expect.poll(async () => {
      const settings = await harness.getSettings()
      return settings?.freshAgent?.providers?.freshopencode?.modelSelection?.modelId
    }).toBe('deepseek/deepseek-v4-pro')
    await expect.poll(async () => {
      const settings = await harness.getSettings()
      return settings?.freshAgent?.providers?.freshopencode?.effort
    }).toBe('low')

    // MRU stores recorded
    const levelMru = await page.evaluate(() => window.localStorage.getItem('freshopencode.modelLevelMru.v1'))
    expect(levelMru).toContain('deepseek/deepseek-v4-pro')
    expect(levelMru).toContain('"low"')
  })

  test('/model in the composer opens the same dialog', async ({
    freshellPage,
    page,
    terminal,
  }) => {
    await terminal.waitForTerminal()
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-model-selector-slash-'))

    await routeCatalog(page, CATALOG)
    await routeThreads(page)
    await routeFileApis(page, cwd)
    await enableFreshClientsAndOpencode(page)
    await createFreshopencodePane(page, cwd)

    const composer = page.getByRole('textbox', { name: 'Chat message input' })
    await expect(composer).toBeEnabled({ timeout: 15_000 })
    await composer.fill('/model')
    await composer.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await expect(dialog.getByRole('searchbox', { name: 'Filter models' })).toBeFocused()
    // the typed command is consumed, not sent to the agent
    await expect(page.getByRole('textbox', { name: 'Chat message input' })).toHaveValue('')

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  })

  test('a model with no declared levels shows exactly one Default row and commits no effort', async ({
    freshellPage,
    page,
    harness,
    terminal,
  }) => {
    await terminal.waitForTerminal()
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-model-selector-default-'))

    await routeCatalog(page, CATALOG)
    await routeThreads(page)
    await routeFileApis(page, cwd)
    await enableFreshClientsAndOpencode(page)
    await createFreshopencodePane(page, cwd)

    const settings = await openFreshAgentSettings(page)
    await settings.getByRole('button', { name: /Change/ }).click()

    const dialog = page.getByRole('dialog', { name: 'Model and thinking level' })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.getByRole('searchbox', { name: 'Filter models' }).fill('kimi')

    const levelsList = dialog.getByRole('listbox', { name: 'Thinking levels for Kimi K2.7 Code' })
    await expect(levelsList).toBeVisible()
    await expect(levelsList.getByRole('option')).toHaveCount(1)
    await expect(levelsList.getByRole('option').first()).toHaveText(/Default/)

    await dialog.getByRole('button', { name: 'Use Kimi K2.7 Code · Default' }).click()
    await expect(dialog).toHaveCount(0)

    await expect.poll(async () => {
      const settings = await harness.getSettings()
      return settings?.freshAgent?.providers?.freshopencode?.modelSelection?.modelId
    }).toBe('kimi-for-coding/kimi-k2.7')
    // the Default commit clears the provider effort default (no variant)
    await expect.poll(async () => {
      const settings = await harness.getSettings()
      return settings?.freshAgent?.providers?.freshopencode?.effort ?? null
    }).toBeNull()

    // the level store records nothing for Default
    const levelMru = await page.evaluate(() => window.localStorage.getItem('freshopencode.modelLevelMru.v1'))
    expect(levelMru === null || !levelMru.includes('kimi-for-coding/kimi-k2.7')).toBe(true)
  })

  test('catalog unavailability shows the shared notice in the popover and on /model, never an empty dialog', async ({
    freshellPage,
    page,
    terminal,
  }) => {
    await terminal.waitForTerminal()
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-model-selector-unavail-'))

    await routeCatalog(page, UNAVAILABLE_CATALOG)
    await routeThreads(page)
    await routeFileApis(page, cwd)
    await enableFreshClientsAndOpencode(page)
    await createFreshopencodePane(page, cwd)

    const settings = await openFreshAgentSettings(page)
    await expect(settings.getByText('Model catalog unavailable — try again')).toBeVisible({ timeout: 10_000 })
    await expect(settings.getByRole('button', { name: /Change/ })).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'Model and thinking level' })).toHaveCount(0)

    await page.keyboard.press('Escape')

    const composer = page.getByRole('textbox', { name: 'Chat message input' })
    await expect(composer).toBeEnabled({ timeout: 15_000 })
    await composer.fill('/model')
    await composer.press('Enter')
    await expect(page.getByRole('alert').filter({ hasText: 'Model catalog unavailable — try again' })).toBeVisible({ timeout: 10_000 })
    await expect(page.getByRole('dialog', { name: 'Model and thinking level' })).toHaveCount(0)
  })
})
