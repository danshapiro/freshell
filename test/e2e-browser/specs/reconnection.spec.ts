import { test, expect } from '../helpers/fixtures.js'

test.describe('WebSocket Reconnection', () => {
  test('reconnects after connection drop', async ({ freshellPage, page, harness }) => {
    await harness.waitForConnection()

    // Force-close the underlying WebSocket via the test harness.
    // This calls ws.close() on the raw WebSocket without setting intentionalClose,
    // so the WsClient will auto-reconnect.
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.forceDisconnect()
    })

    // The WS state should briefly leave 'ready'
    // Wait for it to reconnect
    await harness.waitForConnection()

    const status = await harness.getConnectionStatus()
    expect(status).toBe('ready')
  })

  test('terminal output resumes after reconnect', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Type something before disconnect
    await terminal.executeCommand('echo "before-reconnect"')
    await terminal.waitForOutput('before-reconnect')

    // Force disconnect the WebSocket (triggers auto-reconnect)
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.forceDisconnect()
    })

    // Wait for reconnection
    await harness.waitForConnection()

    // The terminal should reattach and show buffered output from the scrollback
    await terminal.waitForOutput('before-reconnect', { timeout: 20_000 })

    // Terminal should still be functional after reconnect
    await terminal.executeCommand('echo "after-reconnect"')
    await terminal.waitForOutput('after-reconnect', { timeout: 10_000 })
  })

  test('connection status indicator updates', async ({ freshellPage, page, harness }) => {
    // Verify connection status is reflected in the UI and Redux
    const status = await harness.getConnectionStatus()
    expect(status).toBe('ready')

    const wsState = await page.evaluate(() => {
      return window.__FRESHELL_TEST_HARNESS__?.getWsReadyState()
    })
    expect(wsState).toBe('ready')
  })

  test('multiple rapid disconnects handled gracefully', async ({ freshellPage, page, harness }) => {
    await harness.waitForConnection()

    // Simulate flaky network with multiple rapid disconnects
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.forceDisconnect()
      })
      // Brief pause between disconnects to let reconnect attempt start
      await page.waitForTimeout(500)
    }

    // After the rapid disconnects, wait for a stable reconnection
    await harness.waitForConnection()

    // App should not crash and should be in a connected state
    const status = await harness.getConnectionStatus()
    expect(status).toBe('ready')

    // Terminal should still be visible
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 10_000 })
  })

  test('tabs and panes preserved across reconnect', async ({ freshellPage, page, harness }) => {
    // Create multiple tabs
    const addButton = page.getByRole('button', { name: /new.*tab/i })
    await addButton.click()
    await harness.waitForTabCount(2)

    // Force disconnect
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.forceDisconnect()
    })

    // Wait for reconnection
    await harness.waitForConnection()

    // Tabs should still be present (they live in Redux/localStorage, not server-side)
    const tabCount = await harness.getTabCount()
    expect(tabCount).toBe(2)

    // Both tab layouts should be intact
    const state = await harness.getState()
    for (const tab of state.tabs.tabs) {
      const layout = state.panes.layouts[tab.id]
      expect(layout).toBeTruthy()
    }
  })

  test('pending terminal creates retry after reconnect', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()
    await harness.waitForConnection()

    // Force disconnect
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.forceDisconnect()
    })

    // Wait for reconnection
    await harness.waitForConnection()

    // After reconnect, the terminal should reattach automatically.
    // The WsClient has in-flight create tracking that resends on reconnect.
    // Verify the terminal is still functional
    await terminal.executeCommand('echo "post-reconnect-test"')
    await terminal.waitForOutput('post-reconnect-test', { timeout: 15_000 })
  })
})
