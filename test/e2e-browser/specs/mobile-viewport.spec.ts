import { test, expect } from '../helpers/fixtures.js'

async function routeFreshClaudeSnapshot(page: any, sessionId: string, overrides: Record<string, unknown> = {}) {
  await page.route(`**/api/fresh-agent/threads/freshclaude/claude/${sessionId}*`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionType: 'freshclaude',
        provider: 'claude',
        threadId: sessionId,
        sessionId,
        revision: 1,
        latestTurnId: null,
        status: 'idle',
        capabilities: {
          send: true,
          interrupt: true,
          approvals: true,
          questions: true,
          fork: false,
        },
        settings: {
          model: 'claude-opus-4-6',
          permissionMode: 'default',
          plugins: [],
        },
        tokenUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
        pendingApprovals: [],
        pendingQuestions: [],
        turns: [],
        extensions: {
          claude: {
            liveSessionId: sessionId,
            cliSessionId: sessionId,
          },
        },
        ...overrides,
      }),
    })
  })
}

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

  test('fresh-agent composer and region are visible on mobile viewport', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()

    // Get the active leaf pane
    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const paneId = layout.id as string

    // Suppress network effects and inject fresh-agent pane content via Redux
    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(currentPaneId, true)
    }, paneId)

    const sessionId = '44444444-4444-4444-8444-444444444444'
    await routeFreshClaudeSnapshot(page, sessionId, {
      summary: 'Mobile fresh-agent overflow check',
      turns: [{
        id: 'turn-mobile-layout',
        turnId: 'turn-mobile-layout',
        role: 'assistant',
        summary: 'mobile layout',
        items: [{
          id: 'item-mobile-layout',
          kind: 'text',
          text: 'Fresh client transcript text should wrap on a phone without creating a horizontal scrollbar, even when the message contains src/components/fresh-agent/FreshAgentView.tsx.',
        }],
      }],
    })

    await page.evaluate(({ currentTabId, currentPaneId, currentSessionId }) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-e2e-mobile-chat',
            sessionId: currentSessionId,
            sessionRef: { provider: 'claude', sessionId: currentSessionId },
            resumeSessionId: currentSessionId,
            status: 'idle',
            settingsDismissed: true,
          },
        },
      })
    }, {
      currentTabId: tabId!,
      currentPaneId: paneId,
      currentSessionId: sessionId,
    })

    // Verify the fresh-agent pane is visible
    const pane = page.getByRole('group', { name: /pane: freshclaude/i }).last()
    await expect(pane).toBeVisible({ timeout: 10_000 })

    // Verify the send button is visible and interactable
    const sendBtn = pane.getByRole('button', { name: /^send$/i })
    await expect(sendBtn).toBeVisible()

    // Verify the chat input is visible
    const input = pane.getByRole('textbox', { name: /chat message input/i })
    await expect(input).toBeVisible()

    const paneRoot = page.locator('[data-context="fresh-agent"]')
    const transcript = paneRoot.locator('[data-context="fresh-agent-transcript"]')
    await expect.poll(async () => paneRoot.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)
    await expect.poll(async () => transcript.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)

    const addPaneButton = page.getByRole('button', { name: /^add pane$/i })
    await expect(addPaneButton).toBeVisible()
    const sendBox = await sendBtn.boundingBox()
    const addPaneBox = await addPaneButton.boundingBox()
    expect(sendBox).not.toBeNull()
    expect(addPaneBox).not.toBeNull()
    expect(sendBox!.x + sendBox!.width).toBeLessThanOrEqual(addPaneBox!.x - 4)
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

    const sessionId = '55555555-5555-4555-8555-555555555555'
    await routeFreshClaudeSnapshot(page, sessionId, {
      status: 'running',
      pendingApprovals: [{
        requestId: 'perm-e2e-mobile',
        toolName: 'Bash',
        input: { command: 'echo mobile-permission-test' },
      }],
    })

    // Inject fresh-agent pane with a pending permission request from its snapshot
    await page.evaluate(({ currentTabId, currentPaneId, currentSessionId }) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: currentTabId,
          paneId: currentPaneId,
          content: {
            kind: 'fresh-agent',
            sessionType: 'freshclaude',
            provider: 'claude',
            createRequestId: 'req-e2e-mobile-perm',
            sessionId: currentSessionId,
            sessionRef: { provider: 'claude', sessionId: currentSessionId },
            resumeSessionId: currentSessionId,
            status: 'running',
            settingsDismissed: true,
          },
        },
      })
    }, {
      currentTabId: tabId!,
      currentPaneId: paneId,
      currentSessionId: sessionId,
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

    // Click Allow and verify the fresh-agent approval response WS message is sent
    await harness.clearSentWsMessages()
    await allowBtn.click()

    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      return sent.find((msg: any) => msg?.type === 'freshAgent.approval.respond') ?? null
    }).toMatchObject({
      type: 'freshAgent.approval.respond',
      sessionId,
      sessionType: 'freshclaude',
      provider: 'claude',
      requestId: 'perm-e2e-mobile',
      decision: {
        behavior: 'allow',
      },
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
