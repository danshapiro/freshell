import { test, expect } from '../helpers/fixtures.js'

test.describe('Mobile Viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } }) // iPhone 14 size

  test('sidebar is collapsed on mobile and can be toggled', async ({ freshellPage, page }) => {
    // On mobile viewport, there is a "Show sidebar" button in MobileTabStrip
    // (aria-label="Show sidebar" from MobileTabStrip.tsx line 45)
    const showButton = page.getByRole('button', { name: /show sidebar/i })
    await expect(showButton).toBeVisible({ timeout: 5_000 })

    // Click to show sidebar
    await showButton.click()
    await page.waitForTimeout(300)

    // Sidebar should now be visible with "Hide sidebar" button
    const hideButton = page.getByRole('button', { name: /hide sidebar/i })
    await expect(hideButton).toBeVisible({ timeout: 3_000 })

    // Hide it again
    await hideButton.click()
    await page.waitForTimeout(300)
    await expect(showButton).toBeVisible()
  })

  test('mobile tab strip shows navigation controls', async ({ freshellPage, page }) => {
    // MobileTabStrip renders specific buttons with aria-labels:
    // - "Previous tab" (MobileTabStrip.tsx line 54)
    // - "Open tab switcher" (line 62)
    // - "New tab" or "Next tab" (line 75 -- "New tab" when on last tab)
    // - "Show sidebar" (line 45)
    const showSidebar = page.getByRole('button', { name: /show sidebar/i })
    await expect(showSidebar).toBeVisible({ timeout: 5_000 })

    // The tab switcher button should be visible
    const tabSwitcher = page.getByRole('button', { name: /open tab switcher/i })
    await expect(tabSwitcher).toBeVisible()

    // New tab button should be visible (when there's only 1 tab)
    const newTabButton = page.getByRole('button', { name: /new tab/i })
    await expect(newTabButton).toBeVisible()
  })

  test('terminal is usable on mobile viewport', async ({ freshellPage, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Type and verify output works on mobile
    await terminal.executeCommand('echo "mobile-test"')
    await terminal.waitForOutput('mobile-test')
  })

  test('mobile new tab button creates tab', async ({ freshellPage, page, harness }) => {
    // "New tab" button on mobile (aria-label="New tab")
    const newTabButton = page.getByRole('button', { name: /new tab/i })
    await expect(newTabButton).toBeVisible({ timeout: 5_000 })
    await newTabButton.click()
    await harness.waitForTabCount(2)

    // After creating a second tab, the button may change to "Next tab"
    // and "Previous tab" should become available
    const prevTab = page.getByRole('button', { name: /previous tab/i })
    await expect(prevTab).toBeVisible({ timeout: 3_000 })
  })

  test('agent chat composer and region are visible on mobile viewport', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()

    // Get the active leaf pane
    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const paneId = layout.id as string

    // Suppress network effects and inject agent-chat pane content via Redux
    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(currentPaneId, true)
    }, paneId)

    const sessionId = 'sdk-e2e-mobile-chat'
    const cliSessionId = '44444444-4444-4444-8444-444444444444'

    await page.evaluate(({ currentTabId, currentPaneId, currentSessionId, currentCliSessionId }) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'agentChat/sessionCreated',
        payload: {
          requestId: 'req-e2e-mobile-chat',
          sessionId: currentSessionId,
        },
      })
      harness?.dispatch({
        type: 'agentChat/sessionInit',
        payload: {
          sessionId: currentSessionId,
          cliSessionId: currentCliSessionId,
        },
      })
      harness?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-e2e-mobile-chat',
            sessionId: currentSessionId,
            resumeSessionId: currentCliSessionId,
            status: 'idle',
          },
        },
      })
    }, {
      currentTabId: tabId!,
      currentPaneId: paneId,
      currentSessionId: sessionId,
      currentCliSessionId: cliSessionId,
    })

    // Verify the chat region is visible
    const region = page.getByRole('region', { name: /chat/i })
    await expect(region).toBeVisible({ timeout: 10_000 })

    // Verify the send button is visible and interactable
    const sendBtn = page.getByRole('button', { name: /send message/i })
    await expect(sendBtn).toBeVisible()

    // Verify the chat input is visible
    const input = page.getByRole('textbox', { name: /chat message input/i })
    await expect(input).toBeVisible()
  })

  test('permission banner buttons are visible and functional on mobile', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()

    // Get the active leaf pane
    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const paneId = layout.id as string

    // Suppress network effects
    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(currentPaneId, true)
    }, paneId)

    const sessionId = 'sdk-e2e-mobile-perm'
    const cliSessionId = '55555555-5555-4555-8555-555555555555'

    // Inject agent-chat pane with a pending permission request
    await page.evaluate(({ currentTabId, currentPaneId, currentSessionId, currentCliSessionId }) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'agentChat/sessionCreated',
        payload: {
          requestId: 'req-e2e-mobile-perm',
          sessionId: currentSessionId,
        },
      })
      harness?.dispatch({
        type: 'agentChat/sessionInit',
        payload: {
          sessionId: currentSessionId,
          cliSessionId: currentCliSessionId,
        },
      })
      harness?.dispatch({
        type: 'agentChat/addPermissionRequest',
        payload: {
          sessionId: currentSessionId,
          requestId: 'perm-e2e-mobile',
          subtype: 'can_use_tool',
          tool: {
            name: 'Bash',
            input: { command: 'echo mobile-permission-test' },
          },
        },
      })
      harness?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-e2e-mobile-perm',
            sessionId: currentSessionId,
            resumeSessionId: currentCliSessionId,
            status: 'running',
          },
        },
      })
    }, {
      currentTabId: tabId!,
      currentPaneId: paneId,
      currentSessionId: sessionId,
      currentCliSessionId: cliSessionId,
    })

    // Verify the permission banner is visible on mobile
    const banner = page.getByRole('alert', { name: /permission request for bash/i })
    await expect(banner).toBeVisible({ timeout: 10_000 })
    await expect(banner).toContainText('Permission requested: Bash')

    // Verify Allow and Deny buttons are visible and clickable on mobile
    const allowBtn = banner.getByRole('button', { name: /allow tool use/i })
    const denyBtn = banner.getByRole('button', { name: /deny tool use/i })
    await expect(allowBtn).toBeVisible()
    await expect(denyBtn).toBeVisible()

    // Click Allow and verify the sdk.permission.respond WS message is sent
    await harness.clearSentWsMessages()
    await allowBtn.click()

    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      return sent.find((msg: any) => msg?.type === 'sdk.permission.respond') ?? null
    }).toMatchObject({
      type: 'sdk.permission.respond',
      sessionId,
      requestId: 'perm-e2e-mobile',
      behavior: 'allow',
    })
  })

  test('mobile layout adapts to orientation change', async ({ freshellPage, page, terminal }) => {
    // Switch to landscape
    await page.setViewportSize({ width: 844, height: 390 })
    await terminal.waitForTerminal()

    // Terminal should still be visible in landscape
    await expect(page.locator('.xterm').first()).toBeVisible()

    // Switch back to portrait
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(300)

    // Terminal should still be visible in portrait
    await expect(page.locator('.xterm').first()).toBeVisible()
  })
})
