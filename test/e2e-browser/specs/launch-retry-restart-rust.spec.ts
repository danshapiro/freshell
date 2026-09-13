import { test, expect } from '../helpers/fixtures.js'
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

async function selectShellIfPickerShowing(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch {
      continue
    }
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

  test('a create in flight when the server dies abruptly retries and lands instead of a permanent error', async ({ page }) => {
    const server = new RustServer({})
    const info = await server.start()
    try {
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await selectShellIfPickerShowing(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // Fire a second tab's creation and IMMEDIATELY SIGKILL the server so
      // the create/attach round races the death+revival window.
      await page.locator('[data-context="tab-add"]').click()
      await server.restartAbrupt()
      // If the new tab is still showing the PanePicker, pick a shell now —
      // the create then lands on the freshly-revived (possibly still
      // half-initializing) process. Both interleavings are valid samples of
      // the F9 race.
      await selectShellIfPickerShowing(page)

      await expect(async () => {
        const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 60_000 })

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
      }).toPass({ timeout: 90_000 })

      // No pane surface shows a terminal launch failure notice.
      const state = await harness.getState()
      for (const tab of state!.tabs.tabs) {
        await page.locator(`[data-context="tab"][data-tab-id="${tab.id}"]`).click()
        await page.waitForTimeout(300)
        const xtermContent = await page.locator('.xterm').first().textContent()
        expect(xtermContent).not.toContain('[Launch failed]')
        expect(xtermContent).not.toContain('[Restore failed]')
      }
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
