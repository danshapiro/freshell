import type { BrowserContext, Page } from '@playwright/test'
import { createFreshE2ePage, test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * LANE C / GAP F9: a terminal.create round in flight when the server dies
 * abruptly (SIGKILL, no clean WS close, revived on the same port/token) must
 * NOT strand the pane in a permanent status:'error' — every pane converges
 * to a live terminal. This is a whole-system CONVERGENCE regression pin over
 * the client recovery pipeline (ws-client create re-send + reconnect
 * re-drive + inventory census + the bounded launch retry as belt-and-braces).
 * It is NOT a discriminating proof of the launch retry: the rust server
 * surfaces lost terminals as silent attach no-ops (never launch-time
 * INVALID_TERMINAL_ID), so the retry's authoritative pin is its unit suite
 * (TerminalView.launchRetry.test.tsx). Rust-only: requires
 * RustServer.restartAbrupt().
 */

async function selectShellIfPickerShowing(page: Page): Promise<void> {
  const terminal = page.locator('.xterm').first()
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  await expect.poll(async () => await terminal.isVisible() || await picker.isVisible()).toBe(true)
  if (await terminal.isVisible()) return
  await picker.getByRole('button', { name: /^(Shell|WSL|CMD|PowerShell|Bash)$/i })
    .first().press('Enter')
  await expect(terminal).toBeVisible({ timeout: 15_000 })
}

type CreateFrame = { type: 'terminal.create'; requestId: string; tabId: string; paneId: string }

/** Keep one client create outstanding across the death boundary, then wait
 * for the CLIENT to resend it on a new connection before releasing it. A
 * fast server or a delayed test runner cannot move the create outside the
 * scenario, and the test cannot manufacture a retry the product omitted. */
async function installCreateGate(page: Page) {
  let targetTabId: string | null = null
  let connection = 0
  let first: { connection: number; frame: CreateFrame } | undefined
  let retry: { frame: CreateFrame; deliver: () => void } | undefined
  await page.routeWebSocket((url) => url.pathname === '/ws', (client) => {
    const currentConnection = ++connection
    const upstream = client.connectToServer()
    client.onMessage((raw) => {
      let frame: Partial<CreateFrame> | undefined
      try { frame = JSON.parse(String(raw)) } catch { /* Forward non-JSON frames unchanged. */ }
      if (targetTabId !== null && frame?.type === 'terminal.create'
        && frame.tabId === targetTabId && typeof frame.requestId === 'string') {
        if (!first) first = { connection: currentConnection, frame: frame as CreateFrame }
        if (frame.requestId === first.frame.requestId) {
          if (currentConnection > first.connection) {
            retry = { frame: frame as CreateFrame, deliver: () => upstream.send(raw) }
          }
          return
        }
      }
      upstream.send(raw)
    })
    upstream.onMessage((raw) => client.send(raw))
  })
  return {
    arm: (tabId: string) => { targetTabId = tabId },
    captured: () => first?.frame ?? null,
    resent: () => retry?.frame ?? null,
    release: () => {
      if (!retry) throw new Error('No create resend arrived on the replacement connection')
      targetTabId = null
      retry.deliver()
    },
  }
}

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

test.describe('Launch retry across abrupt restart (Rust only)', () => {
  test.setTimeout(180_000)

  test('a create in flight when the server dies abruptly retries and lands instead of a permanent error', async ({ browser }) => {
    const server = new RustServer({})
    let context: BrowserContext | undefined
    try {
      const info = await server.start()
      const owned = await createFreshE2ePage(browser, info, { serviceWorkers: 'block' })
      context = owned.context
      const { page } = owned
      const createGate = await installCreateGate(page)
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // Pin the setup state explicitly, then hold the new pane's create at
      // the transport boundary. The first request is provably outstanding
      // before SIGKILL, not a picker click that might never have sent one.
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'settings/updateSettingsLocal',
          payload: { panes: { defaultNewPane: 'ask' } },
        })
      })
      await page.getByRole('button', { name: 'New shell tab' }).click()
      await harness.waitForTabCount(2)
      const pendingTabId = await harness.getActiveTabId()
      if (!pendingTabId) throw new Error('The pending create has no active tab')
      const picker = page.locator(`[data-tab-content-id="${pendingTabId}"]`)
        .getByRole('toolbar', { name: /pane type picker/i })
      // A visible first xterm does not prove its create was already sent.
      // Arm only this known picker tab, immediately before its activation.
      createGate.arm(pendingTabId)
      await picker.getByRole('button', { name: /^(Shell|WSL|CMD|PowerShell|Bash)$/i })
        .first().press('Enter')
      await expect.poll(() => createGate.captured(), { timeout: 15_000 })
        .toMatchObject({ tabId: pendingTabId, type: 'terminal.create' })
      const originalCreate = createGate.captured()!
      await server.restartAbrupt()

      await expect(async () => {
        const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 60_000 })
      await expect.poll(() => createGate.resent(), { timeout: 15_000 })
        .toMatchObject({ requestId: originalCreate.requestId, tabId: pendingTabId })
      createGate.release()

      // EVERY terminal pane converges to a live terminal; none is stuck in
      // 'error'. 90s accommodates the full 38s retry budget plus recovery.
      await expect(async () => {
        const state = await harness.getState()
        for (const tab of state!.tabs.tabs) {
          for (const leaf of collectLeaves(state!.panes.layouts[tab.id])) {
            if (leaf?.content?.kind !== 'terminal') continue
            expect(leaf.content.status).not.toBe('error')
            expect(leaf.content.terminalId).toBeTruthy()
          }
        }
        expect(state!.tabs.tabs.length).toBe(2)
        const recovered = collectLeaves(state!.panes.layouts[pendingTabId!])
          .find((leaf) => leaf.id === originalCreate.paneId)
        expect(recovered?.content?.kind).toBe('terminal')
        expect(recovered?.content?.terminalId).toBeTruthy()
      }).toPass({ timeout: 90_000 })

      // No pane surface shows a terminal launch failure notice.
      const state = await harness.getState()
      for (const tab of state!.tabs.tabs) {
        await page.locator(`[data-context="tab"][data-tab-id="${tab.id}"]`).click()
        const terminal = page.locator(`[data-tab-content-id="${tab.id}"] .xterm`).first()
        await expect(terminal).toBeVisible()
        await expect(terminal).not.toContainText('[Launch failed]')
        await expect(terminal).not.toContainText('[Restore failed]')
      }
    } finally {
      await context?.close().catch(() => {})
      await server.stop().catch(() => {})
    }
  })
})
