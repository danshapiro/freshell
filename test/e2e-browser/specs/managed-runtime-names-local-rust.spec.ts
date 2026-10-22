/**
 * NAME RELIABILITY (plan Task 8, RC4/D6) — local-only receipts on the REAL
 * managed runtime: real Chromium, a feature-enabled Rust web server, the real
 * supervisor over its authenticated socket, Docker and the session host.
 * Registered in LOCAL_ONLY_SPECS (`local-only-docker-supervisor`); every case
 * boots its own rig and must run alone (Global Constraints, V3).
 *
 * Before the fix the managed-runtime refresh that follows every WebSocket
 * ready wrote the supervisor view's title ("Shell agent", "OpenCode agent")
 * into the matched tab's STORED title and bumped its `updatedAt`. A tab the
 * user renamed was skipped, and a session-owned tab displays its cached saved
 * name, so the visible label alone can survive on the unfixed code (LB-B3):
 * these cases assert the stored state — the Redux tab's `title`/`updatedAt`
 * and the persisted layout — on an UNRENAMED shell tab and on a
 * session-owned OpenCode tab.
 *
 * Only the WebSocket is dropped (`harness.forceDisconnect()`); the web server
 * is never restarted, which avoids the pre-existing managed reattach failure
 * after a web restart (out-of-scope finding, P2-G01).
 *
 * Run one case at a time, with the OneCLI grant files removed from the
 * environment so a managed OpenCode case can never spend real model turns:
 *   env -u FRESHELL_MANAGED_OPENCODE_ONECLI_AUTH_FILE -u FRESHELL_MANAGED_OPENCODE_ONECLI_CA_FILE \
 *     -u FRESHELL_MANAGED_OPENCODE_ONECLI_ENV_FILE pnpm run test:e2e:local --project=chromium \
 *     test/e2e-browser/specs/managed-runtime-names-local-rust.spec.ts --grep '<exact case name>'
 */
import { expect, type Page } from '@playwright/test'

import { test } from '../helpers/fixtures.js'
import { ManagedRuntimeBrowserRig, type ManagedRuntimeView } from '../helpers/managed-runtime.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { renameThroughTabEdit } from '../helpers/unified-agent-names.js'

type TerminalIdentity = { tabId: string; paneId: string; terminalId: string; createRequestId: string }
type StoredTab = { title?: string; titleSetByUser?: boolean; updatedAt?: number }

async function waitForValue<T>(
  description: string,
  probe: () => T | null | undefined | Promise<T | null | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== null && value !== undefined) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const suffix = lastError instanceof Error ? `; last error: ${lastError.message}` : ''
  throw new Error(`timed out waiting for ${description}${suffix}`)
}

async function ensureShell(page: Page, terminal: TerminalHelper): Promise<void> {
  if (await page.locator('.xterm').first().isVisible().catch(() => false)) return
  for (const name of ['Shell', 'Bash', 'WSL', 'CMD', 'PowerShell']) {
    const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).first()
    if (await button.isVisible().catch(() => false)) {
      await button.click()
      await terminal.waitForTerminal(0, 30_000)
      return
    }
  }
  throw new Error('could not select a shell from the real pane picker')
}

/** The tab's single terminal leaf once the server has created its terminal. */
async function waitForTerminalLeaf(harness: TestHarness, tabId: string, timeoutMs = 90_000): Promise<TerminalIdentity> {
  return waitForValue(`a created terminal in tab ${tabId}`, async () => {
    const layout = await harness.getPaneLayout(tabId)
    if (layout?.type !== 'leaf' || layout.content?.kind !== 'terminal') return null
    const { terminalId, createRequestId } = layout.content
    if (typeof terminalId !== 'string' || typeof createRequestId !== 'string') return null
    return { tabId, paneId: layout.id as string, terminalId, createRequestId }
  }, timeoutMs)
}

async function storedTab(harness: TestHarness, tabId: string): Promise<StoredTab> {
  const state = await harness.getState() as { tabs: { tabs: Array<StoredTab & { id: string }> } }
  const tab = state.tabs.tabs.find((candidate) => candidate.id === tabId)
  if (!tab) throw new Error(`no tab ${tabId}`)
  return { title: tab.title, titleSetByUser: tab.titleSetByUser, updatedAt: tab.updatedAt }
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

/** Wait until the client has merged the managed soul into the pane. */
async function waitForMergedSoul(harness: TestHarness, pane: TerminalIdentity, view: ManagedRuntimeView): Promise<void> {
  await waitForValue(`the managed soul ${view.soulId} merged into pane ${pane.paneId}`, async () => {
    const layout = await harness.getPaneLayout(pane.tabId)
    return layout?.type === 'leaf' && layout.content?.soulId === view.soulId ? true : null
  }, 90_000)
}

type ManagedRefreshMark = { lastRefreshAt: number }

async function managedRefreshMark(harness: TestHarness): Promise<ManagedRefreshMark> {
  const state = await harness.getState() as { managedRuntime: { lastRefreshAt?: number } }
  return { lastRefreshAt: state.managedRuntime.lastRefreshAt ?? 0 }
}

/** Drop ONLY the WebSocket, then wait for the reconnect's ready and the
 * managed-runtime refresh every ready triggers. */
async function dropWebSocketAndRefresh(harness: TestHarness): Promise<void> {
  const before = await managedRefreshMark(harness)
  const previousLastReadyAt = await harness.getLastReadyAt()
  await harness.forceDisconnect()
  await harness.waitForConnectionAfter(previousLastReadyAt, 90_000)
  await waitForValue('the managed-runtime refresh after the reconnect', async () => {
    const state = await harness.getState() as { managedRuntime: { status: string; lastRefreshAt?: number } }
    return state.managedRuntime.status === 'ready' && (state.managedRuntime.lastRefreshAt ?? 0) > before.lastRefreshAt
      ? true
      : null
  }, 90_000)
}

async function terminalCreatesSent(harness: TestHarness): Promise<number> {
  const messages = await harness.getSentWsMessages() as Array<{ type?: string }>
  return messages.filter((message) => message.type === 'terminal.create').length
}

test.describe('managed runtime names (local Docker supervisor)', () => {
  test('an unrenamed managed shell tab keeps its stored title after a dropped WebSocket', async ({ page }) => {
    test.setTimeout(1_200_000)
    const rig = new ManagedRuntimeBrowserRig()
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)
      await terminal.waitForPrompt({ timeout: 90_000 })

      const tabId = (await harness.getActiveTabId())!
      const pane = await waitForTerminalLeaf(harness, tabId)
      const view = await waitForValue('the running managed view', () => rig.runningViewForTerminal(pane.terminalId), 90_000)
      await waitForMergedSoul(harness, pane, view)

      // The merge that adopted the soul named nothing.
      const before = await storedTab(harness, tabId)
      expect(before.titleSetByUser).toBeFalsy()
      expect(before.title).not.toBe('Shell agent')
      await expect.poll(() => persistedTabTitle(page, tabId), { timeout: 30_000 }).toBe(before.title)
      const soulsBefore = (await rig.inventory()).length
      await harness.clearSentWsMessages()

      await dropWebSocketAndRefresh(harness)

      // The same managed terminal came back, and the refresh changed neither
      // the stored title nor the tab's recency.
      expect((await waitForTerminalLeaf(harness, tabId)).terminalId).toBe(pane.terminalId)
      expect(await storedTab(harness, tabId)).toEqual(before)
      await expect.poll(() => persistedTabTitle(page, tabId), { timeout: 30_000 }).toBe(before.title)
      expect(await persistedTabTitle(page, tabId)).not.toBe('Shell agent')
      expect(await terminalCreatesSent(harness)).toBe(0)
      expect((await rig.inventory()).length).toBe(soulsBefore)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })

  test('a managed OpenCode tab keeps its stored title after a dropped WebSocket', async ({ page }) => {
    test.setTimeout(1_200_000)
    const savedName = 'Billing bug'
    const rig = new ManagedRuntimeBrowserRig()
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      const terminal = new TerminalHelper(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await ensureShell(page, terminal)
      await terminal.waitForPrompt({ timeout: 90_000 })

      // A NEW tab whose first content is OpenCode: a session-owned tab.
      await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.dispatch({
        type: 'connection/setAvailableClis',
        payload: { opencode: true },
      }))
      const tabsBefore = await harness.getTabCount()
      await page.locator('[data-context="tab-add"]').click()
      await harness.waitForTabCount(tabsBefore + 1)
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^OpenCode$/i }).click({ force: true })
      const directory = page.getByRole('combobox', { name: /Starting directory for OpenCode/i })
      await expect(directory).toBeVisible({ timeout: 15_000 })
      await directory.fill(rig.repoRoot)
      await directory.press('Enter')

      const tabId = (await harness.getActiveTabId())!
      const pane = await waitForTerminalLeaf(harness, tabId)
      const view = await waitForValue('the running managed OpenCode view', () => rig.runningViewForTerminal(pane.terminalId), 120_000)
      await waitForMergedSoul(harness, pane, view)
      expect((await harness.getState() as { tabs: { tabs: Array<{ id: string; nameSource?: unknown }> } })
        .tabs.tabs.find((tab) => tab.id === tabId)?.nameSource).toEqual({ kind: 'session', paneId: pane.paneId })

      await renameThroughTabEdit(page, tabId, savedName)
      // The saved-name mirror holds the name as the stored title.
      await expect.poll(async () => (await storedTab(harness, tabId)).title, { timeout: 30_000 }).toBe(savedName)
      // Let the rename's own broadcasts and any refresh they trigger settle.
      await page.waitForTimeout(2_000)
      const before = await storedTab(harness, tabId)
      await expect.poll(() => persistedTabTitle(page, tabId), { timeout: 30_000 }).toBe(savedName)
      const soulsBefore = (await rig.inventory()).length
      await harness.clearSentWsMessages()

      await dropWebSocketAndRefresh(harness)

      expect((await waitForTerminalLeaf(harness, tabId)).terminalId).toBe(pane.terminalId)
      expect(await storedTab(harness, tabId)).toEqual(before)
      await expect(page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)).toContainText(savedName)
      await expect.poll(() => persistedTabTitle(page, tabId), { timeout: 30_000 }).toBe(savedName)
      expect(await terminalCreatesSent(harness)).toBe(0)
      expect((await rig.inventory()).length).toBe(soulsBefore)
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})
