import { test, expect } from '../helpers/fixtures.js'

test.describe('Terminal Lifecycle', () => {
  async function selectShellForActiveTab(page: any): Promise<void> {
    const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
    for (const name of shellNames) {
      const button = page.locator(`button[aria-label="${name}"]`).first()
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 5000 })
        await page.locator('.xterm').last().waitFor({ state: 'visible', timeout: 30_000 })
        return
      }
    }
    throw new Error('No shell option available for the active tab')
  }

  function getTerminalId(layout: any): string | null {
    if (!layout) return null
    if (layout.type === 'leaf' && layout.content?.kind === 'terminal') {
      return typeof layout.content.terminalId === 'string' ? layout.content.terminalId : null
    }
    if (layout.type === 'split' && Array.isArray(layout.children)) {
      for (const child of layout.children) {
        const terminalId = getTerminalId(child)
        if (terminalId) return terminalId
      }
    }
    return null
  }

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
    const addTabButton = page.locator('[data-context="tab-add"]')
    await addTabButton.click()

    // Wait for second tab
    await harness.waitForTabCount(2)

    // Switch back to first tab (click first tab element)
    const firstTab = page.locator('[data-context="tab"]').first()
    await firstTab.click()

    // Previous output should still be visible (scrollback preserved)
    await terminal.waitForOutput('before-switch-marker')
  })

  test('already-live top-tab switches do not emit terminal.attach or terminal.resize when geometry is unchanged', async ({
    freshellPage,
    page,
    harness,
    terminal,
  }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    await terminal.executeCommand('echo "tab-one-live"')
    await terminal.waitForOutput('tab-one-live')
    const firstTabId = await harness.getActiveTabId()
    const firstLayout = await harness.getPaneLayout(firstTabId!)
    const firstTerminalId = getTerminalId(firstLayout)
    expect(firstTerminalId).toBeTruthy()

    await page.locator('[data-context="tab-add"]').click()
    await harness.waitForTabCount(2)

    await selectShellForActiveTab(page)
    const secondTabId = await harness.getActiveTabId()
    const secondLayout = await harness.getPaneLayout(secondTabId!)
    const secondTerminalId = getTerminalId(secondLayout)
    expect(secondTerminalId).toBeTruthy()
    await terminal.waitForPrompt({ timeout: 30_000, terminalId: secondTerminalId! })
    await terminal.executeCommand('echo "tab-two-live"', 1)
    await terminal.waitForOutput('tab-two-live', { terminalId: secondTerminalId! })

    const tabs = page.locator('[data-context="tab"]')
    await tabs.first().click()
    await terminal.waitForOutput('tab-one-live', { terminalId: firstTerminalId! })
    await tabs.last().click()
    await terminal.waitForOutput('tab-two-live', { terminalId: secondTerminalId! })

    await page.waitForTimeout(200)
    await harness.clearSentWsMessages()
    await tabs.first().click()
    await terminal.waitForOutput('tab-one-live', { terminalId: firstTerminalId! })
    await tabs.last().click()
    await terminal.waitForOutput('tab-two-live', { terminalId: secondTerminalId! })
    await tabs.first().click()
    await terminal.waitForOutput('tab-one-live', { terminalId: firstTerminalId! })

    const sent = await harness.getSentWsMessages()
    expect(sent.filter((msg: any) => msg?.type === 'terminal.attach')).toHaveLength(0)
    expect(sent.filter((msg: any) => msg?.type === 'terminal.resize')).toHaveLength(0)
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
    const addTabButton = page.locator('[data-context="tab-add"]')
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
    const addTabButton = page.locator('[data-context="tab-add"]')
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

    // Force WebSocket close from client side (without setting intentionalClose,
    // so the client will auto-reconnect)
    await harness.forceDisconnect()

    // Wait for auto-reconnection
    await harness.waitForConnection(20_000)

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
