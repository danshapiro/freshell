import { test as base, expect } from '../helpers/fixtures.js'
import { TestServer } from '../helpers/test-server.js'
import { TestHarness } from '../helpers/test-harness.js'

// Override the worker-scoped testServer so this spec manages its own lifecycle.
const test = base.extend({
  testServer: [async ({}, use) => {
    // Provide a dummy -- the test creates its own servers.
    const server = new TestServer()
    await server.start()
    await use(server)
    await server.stop()
  }, { scope: 'worker' }],
})

test.describe('Server Restart Recovery', () => {
  // This test starts two servers sequentially and waits for multi-pane recovery,
  // so it needs more time than the default 60s.
  test.setTimeout(120_000)

  test('all panes recover after server restart without rate limit errors', async ({ page }) => {
    const server1 = new TestServer()
    const info1 = await server1.start()

    try {
      await page.goto(`${info1.baseUrl}/?token=${info1.token}&e2e=1`)

      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()

      // Wait for the first terminal to be ready (PanePicker auto-selects on
      // some platforms, so wait for .xterm to appear)
      // First, try selecting a shell if the PanePicker is showing
      await page.waitForTimeout(500)
      const xtermAlready = await page.locator('.xterm').first().isVisible().catch(() => false)
      if (!xtermAlready) {
        const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
        for (const name of shellNames) {
          try {
            await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5000 })
            break
          } catch { continue }
        }
      }
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // Create 2 more tabs (total 3 panes).
      // Each new tab may show a PanePicker; select a shell for each.
      const addButton = page.locator('[data-context="tab-add"]')

      for (let i = 0; i < 2; i++) {
        await addButton.click()
        // Wait for the new tab to become active, then select a shell if needed
        await page.waitForTimeout(500)
        const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
        if (!xtermVisible) {
          const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
          for (const name of shellNames) {
            try {
              await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 3000 })
              await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
              break
            } catch { continue }
          }
        }
      }

      // Verify 3 tabs exist
      await expect(async () => {
        const tabCount = await page.evaluate(() =>
          window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs?.length
        )
        expect(tabCount).toBe(3)
      }).toPass({ timeout: 10_000 })

      // Wait for all terminals to have terminalIds (fully created)
      await expect(async () => {
        const state = await page.evaluate(() =>
          window.__FRESHELL_TEST_HARNESS__?.getState()
        )
        for (const tab of state!.tabs.tabs) {
          const layout = state!.panes.layouts[tab.id] as any
          expect(layout?.content?.terminalId).toBeTruthy()
        }
      }).toPass({ timeout: 20_000 })

      // Stop server1 (all PTYs and terminal state are lost)
      await server1.stop()

      // Start a fresh server on the SAME port with the SAME token.
      // This simulates a server restart. The client's WS auto-reconnect
      // will reach server2, authenticate with the original token, and
      // try to attach to terminals that no longer exist, triggering
      // INVALID_TERMINAL_ID -> recreate for each pane.
      const server2 = new TestServer({
        port: info1.port,
        token: info1.token,
      })
      await server2.start()

      try {
        // Wait for WS to reconnect and reach 'ready' state
        await expect(async () => {
          const status = await page.evaluate(() =>
            window.__FRESHELL_TEST_HARNESS__?.getWsReadyState()
          )
          expect(status).toBe('ready')
        }).toPass({ timeout: 30_000 })

        // Wait for all panes to get new terminalIds (INVALID_TERMINAL_ID ->
        // recreate with restore:true flow for each pane)
        await expect(async () => {
          const state = await page.evaluate(() =>
            window.__FRESHELL_TEST_HARNESS__?.getState()
          )
          for (const tab of state!.tabs.tabs) {
            const layout = state!.panes.layouts[tab.id] as any
            // Terminal should be running or creating -- NOT error
            expect(layout?.content?.status).not.toBe('error')
            // Must have a new terminalId (proof that recreation succeeded)
            expect(layout?.content?.terminalId).toBeTruthy()
          }
        }).toPass({ timeout: 30_000 })

        // Verify no rate limit errors appeared -- check terminal output
        // by switching to each tab and verifying no "[Error]" text
        const state = await page.evaluate(() =>
          window.__FRESHELL_TEST_HARNESS__?.getState()
        )
        for (const tab of state!.tabs.tabs) {
          await page.locator(`[data-context="tab"][data-tab-id="${tab.id}"]`).click()
          await page.waitForTimeout(500)
          const xtermContent = await page.locator('.xterm').first().textContent()
          expect(xtermContent).not.toContain('[Error]')
        }
      } finally {
        await server2.stop()
      }
    } finally {
      await server1.stop().catch(() => {})
    }
  })
})
