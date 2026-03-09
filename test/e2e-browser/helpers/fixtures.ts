import { test as base, type Page } from '@playwright/test'
import { TestServer, type TestServerInfo } from './test-server.js'
import { TestHarness } from './test-harness.js'
import { TerminalHelper } from './terminal-helpers.js'

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

    await use(page)

    // Cleanup: Kill all terminals to prevent PTY accumulation across tests.
    // The server is worker-scoped (shared across tests in a spec file),
    // so terminals from previous tests would otherwise pile up.
    await harness.killAllTerminals(serverInfo)
  },
})

export { expect } from '@playwright/test'
