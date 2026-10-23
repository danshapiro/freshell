import type { BrowserContext, Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { TestHarness } from '../helpers/test-harness.js'
import {
  connectUnifiedPage,
  createNamedAgent,
  renameThroughTabEdit,
  startFakeGemini,
} from '../helpers/unified-agent-names.js'
import { bootJourney, type Journey } from '../helpers/unified-agent-names-modes.js'

// NAME RELIABILITY (plan Task 8, RC4/D6) — a managed-runtime refresh merges
// runtime facts into the layout and never names a tab. Before the fix every
// refresh (each WebSocket ready, each runtime broadcast) wrote the view's
// title — "Shell agent", "OpenCode agent" — over the matched tab's stored
// title unless the user had renamed it, and bumped the tab's `updatedAt`
// (which tilts cross-window last-writer-wins).
//
// The supervisor inventory is served by the page's own route (the pattern of
// managed-recovery-contextual-ui.spec.ts): the owned server has no managed
// runtime, so the test turns the client's managed lane on, answers
// `/api/runtime/souls` with a view whose title is the old provider label, and
// delivers the `runtime.inventory.changed` broadcast through the harness.
// The terminals themselves are real panes on the owned server.

test.setTimeout(300_000)

const IMPORT_PATH = '/api/session-names/import'
const SOUL_ID = 'title-merge-soul'
const VIEW_ID = 'title-merge-view'

type PaneIdentity = {
  tabId: string
  paneId: string
  terminalId: string
  createRequestId: string
}

type StoredTab = { title?: string; titleSetByUser?: boolean; updatedAt?: number }

function readiness(inventoryRevision: number) {
  return {
    inventoryRevision,
    initialScanState: 'complete',
    blockedSubsystems: [],
    startupRecoveryConcurrencyLimit: 4,
    startupRecoveryPeak: 0,
  }
}

/** The single terminal pane of `tabId` once the server has created it. */
async function terminalPaneOf(harness: TestHarness, tabId: string): Promise<PaneIdentity> {
  let identity: PaneIdentity | null = null
  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    if (layout?.type !== 'leaf' || layout.content?.kind !== 'terminal') return null
    const { terminalId, createRequestId } = layout.content
    if (typeof terminalId !== 'string' || typeof createRequestId !== 'string') return null
    identity = { tabId, paneId: layout.id, terminalId, createRequestId }
    return terminalId
  }, { timeout: 45_000 }).not.toBeNull()
  return identity!
}

async function storedTab(harness: TestHarness, tabId: string): Promise<StoredTab> {
  const state = await harness.getState() as { tabs: { tabs: Array<StoredTab & { id: string }> } }
  const tab = state.tabs.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) throw new Error(`no tab ${tabId}`)
  return { title: tab.title, titleSetByUser: tab.titleSetByUser, updatedAt: tab.updatedAt }
}

/**
 * The stored tab once two reads `quietMs` apart agree. A shell's first prompt
 * may set an OSC window title, a legitimate legacy write that changes the
 * stored title and bumps `updatedAt`; a baseline recorded before it settles
 * would make the "refresh changed nothing" comparison fail without a bug.
 */
async function settledStoredTab(harness: TestHarness, tabId: string, quietMs = 1_000): Promise<StoredTab> {
  let previous: string | null = null
  let settled: StoredTab | null = null
  await expect.poll(async () => {
    const current = await storedTab(harness, tabId)
    const serialized = JSON.stringify(current)
    const stable = serialized === previous
    previous = serialized
    if (stable) settled = current
    return stable
  }, { timeout: 30_000, intervals: [quietMs] }).toBe(true)
  return settled!
}

async function paneSoulId(harness: TestHarness, tabId: string): Promise<string | null> {
  const layout = await harness.getPaneLayout(tabId)
  return layout?.type === 'leaf' ? (layout.content?.soulId ?? null) : null
}

/** The stored title of `tabId` in this window's own persisted layout. */
async function persistedTabTitle(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const windowId = sessionStorage.getItem('freshell.layout-window-id.v1')
    const raw = windowId ? localStorage.getItem(`freshell.layout.v3.${windowId}`) : null
    if (!raw) return null
    const layout = JSON.parse(raw) as { tabs?: { tabs?: Array<{ id: string; title?: string }> } }
    return layout.tabs?.tabs?.find((tab) => tab.id === id)?.title ?? null
  }, tabId)
}

function tabLabel(page: Page, tabId: string) {
  return page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)
}

/** A supervisor inventory with ONE managed soul over the pane's real
 * terminal and its automatic view, titled with the old provider label. */
function inventoryFor(pane: PaneIdentity, opts: {
  revision: number
  mode: 'shell' | 'opencode'
  viewTitle: string
  nativeSessionId?: string
}) {
  return {
    revision: opts.revision,
    readiness: readiness(opts.revision),
    pendingProjectionCount: 0,
    souls: [{
      soulId: SOUL_ID,
      incarnationId: 'title-merge-incarnation',
      intentRevision: 1,
      executionGeneration: 1,
      launchState: 'running',
      cleanupState: 'none',
      desiredState: 'running',
      recoveryState: 'live',
      durabilityState: 'unknown',
      allocationState: 'allocated',
      provider: opts.mode,
      terminalId: pane.terminalId,
      terminalMode: opts.mode,
      terminalCreateRequestId: pane.createRequestId,
      ...(opts.nativeSessionId ? { nativeSessionId: opts.nativeSessionId } : {}),
      evidenceRevision: 0,
      successfulRecoveriesInWindow: 0,
    }],
    viewIntents: [{
      viewId: VIEW_ID,
      soulId: SOUL_ID,
      ownerId: 'fixture-owner',
      workspaceId: 'fixture-workspace',
      kind: 'automatic_primary',
      preferredTabId: pane.tabId,
      preferredPaneId: pane.paneId,
      title: opts.viewTitle,
      placementGroup: '',
      visibility: 'visible',
      revision: 1,
      soulIntentRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    }],
  }
}

/**
 * Serve the routed inventory and expose `refresh()`, which delivers one
 * `runtime.inventory.changed` broadcast and waits for the client to fold the
 * resulting snapshot. Routes survive reloads; call `enable()` after each
 * navigation (the owned server does not advertise the managed runtime).
 */
async function routeManagedInventory(page: Page, build: (revision: number) => unknown) {
  let revision = 400
  await page.route('**/api/runtime/notices?**', (route) => route.fulfill({ json: { notices: [] } }))
  await page.route(/\/api\/runtime\/souls(?:\?.*)?$/, (route) => route.fulfill({ json: build(revision) }))
  return {
    async enable() {
      await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.dispatch({
        type: 'managedRuntime/setManagedRuntimeAvailable',
        payload: true,
      }))
    },
    async refresh(harness: TestHarness) {
      revision += 1
      const expected = revision
      await harness.receiveWsMessage({ type: 'runtime.inventory.changed', revision: expected, readiness: readiness(expected) })
      await expect.poll(async () => {
        const state = await harness.getState() as { managedRuntime: { revision: number; status: string } }
        return state.managedRuntime.status === 'ready' ? state.managedRuntime.revision : -1
      }, { timeout: 30_000 }).toBe(expected)
    },
  }
}

/** Count `POST /api/session-names/import` from every page of `context`. */
function countImportPosts(context: BrowserContext): { readonly count: number } {
  let count = 0
  context.on('request', (request) => {
    if (request.method() !== 'POST') return
    try {
      if (new URL(request.url()).pathname === IMPORT_PATH) count += 1
    } catch {
      // Not a URL this test cares about.
    }
  })
  return { get count() { return count } }
}

test.describe('managed runtime title merge', () => {
  test('a renamed shell tab keeps its name across runtime refreshes', async ({ freshellPage: page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const tabId = (await harness.getActiveTabId())!
    await renameThroughTabEdit(page, tabId, 'Build watcher')
    const pane = await terminalPaneOf(harness, tabId)
    const inventory = await routeManagedInventory(page, (revision) => inventoryFor(pane, {
      revision, mode: 'shell', viewTitle: 'Shell agent',
    }))
    const before = await storedTab(harness, tabId)
    expect(before).toMatchObject({ title: 'Build watcher', titleSetByUser: true })

    await inventory.enable()
    await inventory.refresh(harness)
    await expect.poll(() => paneSoulId(harness, tabId)).toBe(SOUL_ID)
    await inventory.refresh(harness)

    await expect(tabLabel(page, tabId)).toContainText('Build watcher')
    await expect(tabLabel(page, tabId)).not.toContainText('Shell agent')
    // The refreshes merged runtime facts only: the name and the tab's
    // recency are exactly what the user's rename left.
    expect(await storedTab(harness, tabId)).toEqual(before)
    await expect.poll(() => persistedTabTitle(page, tabId)).toBe('Build watcher')
  })

  test('an unrenamed shell tab never shows "Shell agent"', async ({ freshellPage: page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const tabId = (await harness.getActiveTabId())!
    const pane = await terminalPaneOf(harness, tabId)
    const inventory = await routeManagedInventory(page, (revision) => inventoryFor(pane, {
      revision, mode: 'shell', viewTitle: 'Shell agent',
    }))
    // Record the baseline only after the shell's start-up output (and any
    // OSC title its first prompt sets) has landed.
    await terminal.waitForPrompt({ timeout: 30_000, terminalId: pane.terminalId })
    const before = await settledStoredTab(harness, tabId)
    const label = (await tabLabel(page, tabId).innerText()).trim()
    expect(before.titleSetByUser).toBeFalsy()

    await inventory.enable()
    await inventory.refresh(harness)
    await expect.poll(() => paneSoulId(harness, tabId)).toBe(SOUL_ID)
    await inventory.refresh(harness)

    await expect(tabLabel(page, tabId)).not.toContainText('Shell agent')
    expect((await tabLabel(page, tabId).innerText()).trim()).toBe(label)
    expect(await storedTab(harness, tabId)).toEqual(before)
    await expect.poll(() => persistedTabTitle(page, tabId)).toBe(before.title)
  })

  test('an OpenCode tab keeps its saved name after refresh + reload and no import is sent', async ({ browser }) => {
    const savedName = 'Billing bug'
    const gemini = await startFakeGemini('unused', {
      status: 403,
      body: { error: { code: 403, message: 'Permission denied.', status: 'PERMISSION_DENIED' } },
    })
    const journey: Journey = await bootJourney('opencode', { gemini })
    try {
      const context = await browser.newContext()
      const imports = countImportPosts(context)
      const { page, harness } = await connectUnifiedPage({ browser, info: journey.server.info, context })
      const handle = await createNamedAgent(harness, 'opencode', { entry: 'ui', page, server: journey.server })
      await renameThroughTabEdit(page, handle.tabId, savedName)
      // The saved-name mirror (Task 7) holds the name as the stored title.
      await expect.poll(async () => (await storedTab(harness, handle.tabId)).title, { timeout: 30_000 }).toBe(savedName)
      const pane = await terminalPaneOf(harness, handle.tabId)
      const before = await storedTab(harness, handle.tabId)

      const inventory = await routeManagedInventory(page, (revision) => inventoryFor(pane, {
        revision, mode: 'opencode', viewTitle: 'OpenCode agent',
      }))
      await inventory.enable()
      await inventory.refresh(harness)
      await expect.poll(() => paneSoulId(harness, handle.tabId)).toBe(SOUL_ID)
      await inventory.refresh(harness)

      expect(await storedTab(harness, handle.tabId)).toEqual(before)
      await expect(tabLabel(page, handle.tabId)).toContainText(savedName)
      await expect.poll(() => persistedTabTitle(page, handle.tabId)).toBe(savedName)

      await page.reload()
      const reloaded = new TestHarness(page)
      await reloaded.waitForHarness()
      await reloaded.waitForConnection()
      await inventory.enable()
      await inventory.refresh(reloaded)

      await expect(tabLabel(page, handle.tabId)).toContainText(savedName, { timeout: 30_000 })
      await expect(tabLabel(page, handle.tabId)).not.toContainText('OpenCode agent')
      expect((await storedTab(reloaded, handle.tabId)).title).toBe(savedName)
      await expect.poll(() => persistedTabTitle(page, handle.tabId)).toBe(savedName)
      expect(imports.count).toBe(0)
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })
})
