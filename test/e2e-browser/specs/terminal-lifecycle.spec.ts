import { test, expect } from '../helpers/fixtures.js'

test.describe('Terminal Lifecycle', () => {
  async function selectShellForActiveTab(page: any): Promise<void> {
    const deadline = Date.now() + 30_000
    const remaining = () => Math.max(1, deadline - Date.now())
    let tabId = ''
    await expect.poll(async () => {
      tabId = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState().tabs.activeTabId ?? '')
      return tabId
    }, { timeout: remaining() }).not.toBe('')
    const content = page.locator(`[data-tab-content-id="${tabId}"]`)
    const terminal = content.locator('.xterm').first()
    const picker = content.getByRole('toolbar', { name: /pane type picker/i })
    await expect.poll(async () => await terminal.isVisible() || await picker.isVisible(), {
      timeout: remaining(),
    }).toBe(true)
    if (!(await terminal.isVisible())) {
      await picker.getByRole('button', { name: /^(Shell|WSL|CMD|PowerShell|Bash)$/i })
        .first().press('Enter', { timeout: Math.min(5_000, remaining()) })
    }
    await terminal.waitFor({ state: 'visible', timeout: remaining() })
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

    await page.locator('[data-context="tab-add"]').click()
    await harness.waitForTabCount(3)
    await selectShellForActiveTab(page)
    const thirdTabId = await harness.getActiveTabId()
    const thirdLayout = await harness.getPaneLayout(thirdTabId!)
    const thirdTerminalId = getTerminalId(thirdLayout)
    expect(thirdTerminalId).toBeTruthy()
    await terminal.waitForPrompt({ timeout: 30_000, terminalId: thirdTerminalId! })
    await terminal.executeCommand('echo "tab-three-live"', 2)
    await terminal.waitForOutput('tab-three-live', { terminalId: thirdTerminalId! })

    const tabs = page.locator('[data-context="tab"]')
    await page.waitForTimeout(200)
    await harness.clearSentWsMessages()
    await tabs.nth(1).click()
    await terminal.waitForOutput('tab-two-live', { terminalId: secondTerminalId! })
    await tabs.nth(2).click()
    await terminal.waitForOutput('tab-three-live', { terminalId: thirdTerminalId! })
    await tabs.nth(1).click()
    await terminal.waitForOutput('tab-two-live', { terminalId: secondTerminalId! })

    const sent = await harness.getSentWsMessages()
    expect(sent.filter((msg: any) => msg?.type === 'terminal.attach')).toHaveLength(0)
    expect(sent.filter((msg: any) => msg?.type === 'terminal.resize')).toHaveLength(0)
  })

  test('terminal resize updates dimensions', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "before-resize-marker"')
    await terminal.waitForOutput('before-resize-marker')
    const firstTabId = await harness.getActiveTabId()
    const firstLayout = await harness.getPaneLayout(firstTabId!)
    const firstTerminalId = getTerminalId(firstLayout)
    expect(firstTerminalId).toBeTruthy()

    await page.locator('[data-context="tab-add"]').click()
    await harness.waitForTabCount(2)
    await selectShellForActiveTab(page)
    const secondTabId = await harness.getActiveTabId()
    // xterm can mount before terminal.created. Share the existing prompt
    // window with the exact new pane's acknowledged terminal identity.
    const secondReadyDeadline = Date.now() + 30_000
    const secondReadyRemaining = () => Math.max(1, secondReadyDeadline - Date.now())
    const secondLayout = await harness.getPaneLayout(secondTabId!)
    expect(secondLayout).toMatchObject({ type: 'leaf', content: { kind: 'terminal' } })
    const secondPaneId = secondLayout.id
    let secondTerminalId: string | null = null
    await expect.poll(async () => {
      const layout = await harness.getPaneLayout(secondTabId!)
      secondTerminalId = layout?.type === 'leaf' && layout.id === secondPaneId
        ? getTerminalId(layout)
        : null
      return secondTerminalId
    }, { timeout: secondReadyRemaining() }).toBeTruthy()
    await terminal.waitForPrompt({ timeout: secondReadyRemaining(), terminalId: secondTerminalId! })
    await terminal.executeCommand('echo "other-tab-marker"', 1)
    await terminal.waitForOutput('other-tab-marker', { terminalId: secondTerminalId! })

    const tabs = page.locator('[data-context="tab"]')
    await harness.clearSentWsMessages()

    await page.setViewportSize({ width: 1600, height: 1200 })
    // The second tab is active. Observe its actual ResizeObserver/layout
    // work before revealing the first tab; cached terminal text does not
    // acknowledge either geometry change. Each receipt shares the existing
    // marker-output window rather than adding another wait budget.
    const secondResizeDeadline = Date.now() + 10_000
    const secondResizeRemaining = () => Math.max(1, secondResizeDeadline - Date.now())
    await page.waitForFunction((terminalId) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((msg: any) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId)
    }, secondTerminalId!, { timeout: secondResizeRemaining() })
    await terminal.waitForOutput('other-tab-marker', {
      terminalId: secondTerminalId!, timeout: secondResizeRemaining(),
    })
    await tabs.first().click()
    const firstResizeDeadline = Date.now() + 10_000
    const firstResizeRemaining = () => Math.max(1, firstResizeDeadline - Date.now())
    await page.waitForFunction((terminalId) => {
      const sent = window.__FRESHELL_TEST_HARNESS__?.getSentWsMessages?.() ?? []
      return sent.some((msg: any) => msg?.type === 'terminal.resize' && msg?.terminalId === terminalId)
    }, firstTerminalId!, { timeout: firstResizeRemaining() })
    await terminal.waitForOutput('before-resize-marker', {
      terminalId: firstTerminalId!, timeout: firstResizeRemaining(),
    })

    // Input is sent after the resize on the same socket. Complete the
    // existing round trip before checking the complete wire observation.
    await terminal.waitForPrompt()
    await terminal.executeCommand('echo "after-resize"')
    await terminal.waitForOutput('after-resize', { terminalId: firstTerminalId! })

    const sent = await harness.getSentWsMessages()
    const attachMessages = sent.filter((msg: any) => msg?.type === 'terminal.attach')
    const firstTerminalResizeMessages = sent.filter(
      (msg: any) => msg?.type === 'terminal.resize' && msg?.terminalId === firstTerminalId,
    )
    expect(attachMessages).toHaveLength(0)
    expect(firstTerminalResizeMessages).toHaveLength(1)

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
