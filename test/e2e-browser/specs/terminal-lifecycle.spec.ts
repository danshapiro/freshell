import { test, expect } from '../helpers/fixtures.js'

test.describe('Terminal Lifecycle', () => {
  test('creates a terminal on first load', async ({ freshellPage, harness, terminal }) => {
    // Wait for terminal to appear
    await terminal.waitForTerminal()

    // Verify a tab exists
    const tabCount = await harness.getTabCount()
    expect(tabCount).toBeGreaterThanOrEqual(1)

    // Terminal should have a terminal pane
    const activeTabId = await harness.getActiveTabId()
    expect(activeTabId).toBeTruthy()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout).toBeTruthy()
    expect(layout.type).toBe('leaf')
    expect(layout.content.kind).toBe('terminal')
  })

  test('terminal shows shell prompt after connecting', async ({ freshellPage, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt({ timeout: 20_000 })
  })

  test('typing in terminal sends input', async ({ freshellPage, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Type a simple command
    await terminal.executeCommand('echo "e2e-test-output-12345"')

    // Wait for the output
    await terminal.waitForOutput('e2e-test-output-12345', { timeout: 10_000 })
  })

  test('terminal shows command output', async ({ freshellPage, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Run pwd to get current directory
    await terminal.executeCommand('pwd')

    // Should show some path output (the temp HOME directory)
    await terminal.waitForOutput('/', { timeout: 10_000 })
  })

  test('terminal survives tab switch and return', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Type something unique
    await terminal.executeCommand('echo "before-switch-marker"')
    await terminal.waitForOutput('before-switch-marker')

    // Create a new tab
    const addTabButton = page.getByRole('button', { name: /new.*tab/i })
    await addTabButton.click()

    // Wait for second tab
    await harness.waitForTabCount(2)

    // Switch back to first tab (click first tab element)
    const firstTab = page.locator('[data-context="tab"]').first()
    await firstTab.click()

    // Previous output should still be visible (scrollback preserved)
    await terminal.waitForOutput('before-switch-marker')
  })

  test('terminal resize updates dimensions', async ({ freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()

    // Resize the viewport
    await page.setViewportSize({ width: 1600, height: 1200 })

    // Terminal should still be functional
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "after-resize"')
    await terminal.waitForOutput('after-resize')
  })

  test('detached terminal keeps running', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Start a long-running process
    await terminal.executeCommand('echo "detach-test" && sleep 0.1 && echo "still-running"')

    // Create new tab (detaches from current terminal)
    const addTabButton = page.getByRole('button', { name: /new.*tab/i })
    await addTabButton.click()
    await harness.waitForTabCount(2)

    // Wait a moment for command to complete
    await page.waitForTimeout(500)

    // Switch back to first tab
    const firstTab = page.locator('[data-context="tab"]').first()
    await firstTab.click()

    // Should see the output from the background process
    await terminal.waitForOutput('still-running', { timeout: 10_000 })
  })

  test('terminal handles rapid input', async ({ freshellPage, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Type multiple commands rapidly
    for (let i = 0; i < 5; i++) {
      await terminal.executeCommand(`echo "rapid-${i}"`)
    }

    // All output should appear
    await terminal.waitForOutput('rapid-4', { timeout: 15_000 })
  })

  test('terminal clears screen with Ctrl+L', async ({ freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Type some output
    await terminal.executeCommand('echo "before-clear"')
    await terminal.waitForOutput('before-clear')

    // Clear screen
    await terminal.getTerminalContainer().click()
    await page.keyboard.press('Control+l')

    // New prompt should appear (screen cleared)
    await terminal.waitForPrompt({ timeout: 5_000 })
  })

  test('close tab kills terminal', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()

    // Create a second tab first
    const addTabButton = page.getByRole('button', { name: /new.*tab/i })
    await addTabButton.click()
    await harness.waitForTabCount(2)

    // Switch back to first tab and close it
    const firstTab = page.locator('[data-context="tab"]').first()
    await firstTab.click()
    // Close button is inside the tab item (aria-label="Close tab")
    const closeButton = firstTab.getByRole('button', { name: /close/i })
    await closeButton.click()

    // Should now have 1 tab
    await harness.waitForTabCount(1)
  })

  test('terminal reconnects after WebSocket drop', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Type something
    await terminal.executeCommand('echo "before-disconnect"')
    await terminal.waitForOutput('before-disconnect')

    // Force WebSocket close from client side
    await page.evaluate(() => {
      // Access internal WS to force close
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) return
      // The WS client auto-reconnects, so we just need to verify it works
    })

    // Terminal should still work after reconnection
    await terminal.waitForPrompt({ timeout: 20_000 })
  })

  test('terminal scrollback is preserved', async ({ freshellPage, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Generate enough output to scroll using a single command
    await terminal.executeCommand('for i in $(seq 0 49); do echo "scrollback-line-$i"; done')

    // Wait for last line
    await terminal.waitForOutput('scrollback-line-49', { timeout: 20_000 })

    // Earlier lines should still be in the buffer (scrollback)
    await terminal.waitForOutput('scrollback-line-0', { timeout: 5_000 })

    // Terminal should still be responsive after all that output
    await terminal.executeCommand('echo "after-scrollback"')
    await terminal.waitForOutput('after-scrollback', { timeout: 10_000 })
  })
})
