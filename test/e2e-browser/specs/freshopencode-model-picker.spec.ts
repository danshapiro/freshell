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
 * catalog-unavailable state.
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

/**
 * Serves the fresh-agent thread snapshot with optional overrides (e.g. a
 * stubbed `commands` catalog). Returns a hit-count getter so tests can gate
 * menu assertions on the stubbed snapshot having LANDED (freshopencode pane
 * state is a settled no-commands/catalog state, never a pre-fetch transient).
 */
async function routeThreads(page: Page, overrides?: Record<string, unknown>): Promise<() => number> {
  let hits = 0
  await page.route('**/api/fresh-agent/threads/**', async (route) => {
    const url = new URL(route.request().url())
    const [, sessionType = 'freshopencode', provider = 'opencode', threadId = 'ses_e2e'] =
      url.pathname.match(/\/api\/fresh-agent\/threads\/([^/]+)\/([^/]+)\/([^/?]+)/) ?? []
    hits += 1
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...freshAgentSnapshot(sessionType, provider, decodeURIComponent(threadId)),
        ...(overrides ?? {}),
      }),
    })
  })
  return () => hits
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
        content: {
          ...leaf.content, sessionId: 'ses_e2e', status: 'idle',
          // This selector scenario starts with a known selection. OpenCode's
          // unset effort means Default, not the catalog's highest level.
          model: 'opencode-go/glm-5.2',
          modelSelection: { kind: 'tracked', modelId: 'opencode-go/glm-5.2' },
          effort: 'max',
        },
      },
    })
  })
}

async function openFreshAgentSettings(page: Page) {
  const pane = page.getByRole('group').filter({
    // The pane header identifies a fresh-agent pane by its agent-icon tooltip
    // ("<Label> (<sessionType> pane)") — there is no session-type text label.
    has: page.getByTitle('OpenCode (freshopencode pane)'),
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

/**
 * Slash-command menu: provider-advertised session rows (freshopencode leg).
 * The view merges `snapshot.commands` (stubbed here through routeThreads)
 * into the composer menu as a second, labelled group that inserts verbatim
 * `/name ` text on select — never dispatching, never auto-sending. Statics
 * (Pane actions) are byte-identical when the catalog is absent.
 */
test.describe('Fresh-agent slash-command menu — stubbed provider catalog (freshopencode leg)', () => {
  const DEPLOY_COMMAND = { name: 'deploy', description: 'Deploy the thing', argumentHint: '<env>' }

  async function bootPaneWithSnapshot(page: Page, cwd: string, overrides?: Record<string, unknown>): Promise<() => number> {
    const hits = await routeThreads(page, overrides)
    await routeFileApis(page, cwd)
    await enableFreshClientsAndOpencode(page)
    await createFreshopencodePane(page, cwd)
    // Hold all menu assertions until the stubbed snapshot has LANDED, so the
    // observed menu is the settled state (never a pre-fetch transient).
    await expect.poll(() => hits(), { timeout: 10_000 }).toBeGreaterThan(0)
    const composer = page.getByRole('textbox', { name: 'Chat message input' })
    await expect(composer).toBeEnabled({ timeout: 15_000 })
    return hits
  }

  test('snapshot.commands renders as a grouped "Agent session" section beside the static "Pane actions"', async ({
    freshellPage,
    page,
    terminal,
  }) => {
    await terminal.waitForTerminal()
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-slash-catalog-'))
    await bootPaneWithSnapshot(page, cwd, { commands: [DEPLOY_COMMAND] })

    // Typed-prefix entry: '/d' matches /model (static) AND /deploy (catalog).
    const composer = page.getByRole('textbox', { name: 'Chat message input' })
    await composer.fill('/d')

    const menu = page.getByRole('menu', { name: 'Slash commands' })
    await expect(menu).toBeVisible({ timeout: 10_000 })

    const groups = menu.getByRole('group')
    await expect(groups).toHaveCount(2)
    await expect(groups.nth(0)).toContainText('Pane actions')
    await expect(groups.nth(1)).toContainText('Agent session')

    const paneActions = menu.getByRole('group', { name: 'Pane actions' })
    const agentSession = menu.getByRole('group', { name: 'Agent session' })
    await expect(paneActions.getByRole('menuitem', { name: /^\/model/ })).toHaveCount(1)
    // The catalog row carries its argumentHint and description verbatim.
    await expect(agentSession.getByRole('menuitem', { name: /\/deploy <env>\s*Deploy the thing/ })).toHaveCount(1)
    await expect(menu.getByRole('menuitem')).toHaveCount(2)
  })

  test('selecting a session row inserts /name into the composer and never sends', async ({
    freshellPage,
    page,
    harness,
    terminal,
  }) => {
    await terminal.waitForTerminal()
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-slash-insert-'))
    await bootPaneWithSnapshot(page, cwd, { commands: [DEPLOY_COMMAND] })
    await harness.clearSentWsMessages()

    const composer = page.getByRole('textbox', { name: 'Chat message input' })
    await composer.fill('/d')
    const menu = page.getByRole('menu', { name: 'Slash commands' })
    const deployRow = menu
      .getByRole('group', { name: 'Agent session' })
      .getByRole('menuitem', { name: /\/deploy/ })
    await expect(deployRow).toBeVisible({ timeout: 10_000 })
    await deployRow.click()

    // Insert-never-send: the canonical slash text lands in the input, the menu
    // closes, and NOTHING leaves the page on the wire.
    await expect(composer).toHaveValue('/deploy ')
    await expect(menu).toHaveCount(0)

    // Bounded negative window: poll the WS spy for the full window so even a
    // LATE send frame (retries/queued effects) would be caught.
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      const sent = (await harness.getSentWsMessages()) as Array<{ type?: string }>
      expect(
        sent.some((message) => message?.type === 'freshAgent.send'),
        'session-row selection must never emit a freshAgent.send frame',
      ).toBe(false)
      await page.waitForTimeout(150)
    }
  })

  test('snapshot without commands shows the static action list with no "Agent session" group', async ({
    freshellPage,
    page,
    terminal,
  }) => {
    await terminal.waitForTerminal()
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-slash-statics-'))
    await bootPaneWithSnapshot(page, cwd) // no overrides: the stub omits `commands`

    // Browse entry: the slash button lists every row regardless of filter.
    await page.getByRole('button', { name: 'Slash commands' }).click()
    const menu = page.getByRole('menu', { name: 'Slash commands' })
    await expect(menu).toBeVisible({ timeout: 10_000 })

    // All four statics (the freshopencode set, fork included via stubbed
    // capabilities.fork=true), and nothing else.
    await expect(menu.getByRole('menuitem', { name: /^\/new/ })).toHaveCount(1)
    await expect(menu.getByRole('menuitem', { name: /^\/compact/ })).toHaveCount(1)
    await expect(menu.getByRole('menuitem', { name: /^\/fork/ })).toHaveCount(1)
    await expect(menu.getByRole('menuitem', { name: /^\/model/ })).toHaveCount(1)
    await expect(menu.getByRole('menuitem')).toHaveCount(4)

    // Structure witness: no provider-catalog group, no catalog rows at all.
    await expect(menu.getByRole('group', { name: 'Agent session' })).toHaveCount(0)
    await expect(menu.getByRole('menuitem', { name: /\/deploy/ })).toHaveCount(0)
  })
})
