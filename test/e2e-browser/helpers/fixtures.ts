import { test as base, type Page } from '@playwright/test'
import { TestServer, type TestServerInfo } from './test-server.js'
import { TestHarness } from './test-harness.js'
import { TerminalHelper } from './terminal-helpers.js'

/**
 * Select a shell from the PanePicker, handling the race condition where
 * buttons can be detached during the platform-info Redux update.
 *
 * Strategy: Use Playwright's built-in auto-retry by clicking with a
 * reasonable timeout. If the first candidate detaches, move to the next.
 * After clicking, wait for .xterm to confirm the terminal was created.
 */
async function selectShellFromPicker(page: Page): Promise<void> {
  // First check if a terminal is already visible (no picker needed)
  const xtermAlreadyVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermAlreadyVisible) return

  // Wait a moment for the PanePicker to stabilize after WS connection
  // (platform info arrives and may change the option set)
  await page.waitForTimeout(500)

  // Check again - maybe the terminal appeared during the wait
  const xtermNow = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermNow) return

  // Try each shell option. Use a short timeout per attempt since we want
  // to fall through to the next option quickly if one isn't present.
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
      // click({ timeout: 5000 }) uses Playwright's auto-retry, which handles
      // transient detachments by re-querying the locator
      await button.click({ timeout: 5000 })
      // Wait for .xterm to appear, confirming terminal was created
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
      return
    } catch {
      // This shell option wasn't available or click failed; try next
      continue
    }
  }

  // If none of the named buttons worked, the picker might not be showing
  // (or uses different labels). Fall through and let the test handle it.
}

/**
 * Extended Playwright test fixtures for Freshell E2E tests.
 *
 * Provides:
 * - testServer: An isolated Freshell server instance
 * - serverInfo: Connection info for the test server
 * - harness: TestHarness for Redux state assertions
 * - terminal: TerminalHelper for xterm.js interaction
 * - freshellPage: A page pre-navigated to Freshell with harness ready
 */
export const test = base.extend<{
  testServer: TestServer
  serverInfo: TestServerInfo
  harness: TestHarness
  terminal: TerminalHelper
  freshellPage: Page
}>({
  // TestServer is scoped per-test by default, but we use a worker-scoped
  // server for efficiency. Each test file shares one server.
  testServer: [async ({}, use) => {
    const server = new TestServer()
    await server.start()
    await use(server)
    await server.stop()
  }, { scope: 'worker' }],

  serverInfo: async ({ testServer }, use) => {
    await use(testServer.info)
  },

  harness: async ({ page }, use) => {
    await use(new TestHarness(page))
  },

  terminal: async ({ page }, use) => {
    await use(new TerminalHelper(page))
  },

  freshellPage: async ({ page, serverInfo, harness }, use) => {
    // Navigate to Freshell with auth token and test harness enabled
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    // Wait for the test harness to be installed
    await harness.waitForHarness()

    // Wait for WebSocket to connect
    await harness.waitForConnection()

    // If a PanePicker is showing (new tab without auto-created terminal),
    // select a shell to create a terminal. On WSL/Windows the picker shows
    // CMD/PowerShell/WSL instead of a generic "Shell".
    //
    // Race condition: The PanePicker options depend on `connection.platform`
    // from Redux. When the WS handshake completes, platform info arrives and
    // the options list may change (e.g., "Shell" → "CMD/PowerShell/WSL"),
    // detaching the old buttons mid-click. We handle this by:
    // 1. Waiting briefly for the PanePicker to stabilize after connection
    // 2. Using a retry loop with force-click to handle transient detachments
    await selectShellFromPicker(page)

    await use(page)

    // Cleanup: Kill all terminals to prevent PTY accumulation across tests.
    // The server is worker-scoped (shared across tests in a spec file),
    // so terminals from previous tests would otherwise pile up.
    await harness.killAllTerminals(serverInfo)
  },
})

export { expect } from '@playwright/test'
