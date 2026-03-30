import { test, expect } from '../helpers/fixtures.js'

test.describe('Agent Chat', () => {
  // Note: Agent chat requires SDK provider bridges (Claude, Codex, etc.)
  // which may not be available in the isolated test environment.
  // These tests verify the UI flow for pane creation. Tests that require
  // a specific CLI provider use test.skip when it's not available.

  // Helper: open the pane picker by splitting a terminal pane.
  // Uses role="menuitem" for "Split horizontally" in the terminal context menu.
  async function openPanePicker(page: any) {
    const termContainer = page.locator('.xterm').first()
    await termContainer.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /split horizontally/i }).click()
    // Wait for picker to appear (role="toolbar" aria-label="Pane type picker")
    await expect(page.getByRole('toolbar', { name: /pane type picker/i }))
      .toBeVisible({ timeout: 10_000 })
  }

  async function getActiveLeaf(harness: any) {
    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    return { tabId: tabId!, paneId: layout.id as string }
  }

  test('pane picker shows base pane types', async ({ freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    await openPanePicker(page)

    // The picker always shows Editor and Browser.
    // Shell options depend on platform: "Shell" on Linux/Mac, "CMD"/"PowerShell"/"WSL" on Windows/WSL.
    const editorButton = page.getByRole('button', { name: /^Editor$/i })
    const browserButton = page.getByRole('button', { name: /^Browser$/i })

    await expect(editorButton).toBeVisible()
    await expect(browserButton).toBeVisible()

    // At least one shell option should be present
    const shellVisible = await page.getByRole('button', { name: /^Shell$/i }).isVisible().catch(() => false)
    const wslVisible = await page.getByRole('button', { name: /^WSL$/i }).isVisible().catch(() => false)
    const cmdVisible = await page.getByRole('button', { name: /^CMD$/i }).isVisible().catch(() => false)
    const psVisible = await page.getByRole('button', { name: /^PowerShell$/i }).isVisible().catch(() => false)
    expect(shellVisible || wslVisible || cmdVisible || psVisible).toBe(true)
  })

  test('agent chat provider appears when the Claude CLI is available and enabled', async ({ freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    await page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'connection/setAvailableClis',
        payload: { claude: true },
      })
      harness?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: {
          codingCli: {
            enabledProviders: ['claude'],
          },
        },
      })
    })

    await openPanePicker(page)
    await expect(page.getByRole('button', { name: /^Freshclaude$/i })).toBeVisible()
  })

  test('agent chat permission banners appear and allow sends a response', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    const { tabId, paneId } = await getActiveLeaf(harness)
    const sessionId = 'sdk-e2e-permission'
    const cliSessionId = '33333333-3333-4333-8333-333333333333'

    await page.evaluate((currentPaneId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(currentPaneId, true)
    }, paneId)

    await page.evaluate(({ currentTabId, currentPaneId, currentSessionId, currentCliSessionId }) => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      harness?.dispatch({
        type: 'agentChat/sessionCreated',
        payload: {
          requestId: 'req-e2e-permission',
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
          requestId: 'perm-e2e',
          subtype: 'can_use_tool',
          tool: {
            name: 'Bash',
            input: { command: 'echo hello-from-permission-banner' },
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
            createRequestId: 'req-e2e-permission',
            sessionId: currentSessionId,
            resumeSessionId: currentCliSessionId,
            status: 'running',
          },
        },
      })
    }, {
      currentTabId: tabId,
      currentPaneId: paneId,
      currentSessionId: sessionId,
      currentCliSessionId: cliSessionId,
    })

    const banner = page.getByRole('alert', { name: /permission request for bash/i })
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Permission requested: Bash')
    await expect(banner).toContainText('$ echo hello-from-permission-banner')

    await harness.clearSentWsMessages()
    await banner.getByRole('button', { name: /allow tool use/i }).click()

    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      return sent.find((msg: any) => msg?.type === 'sdk.permission.respond') ?? null
    }).toMatchObject({
      type: 'sdk.permission.respond',
      sessionId,
      requestId: 'perm-e2e',
      behavior: 'allow',
    })
  })

  test('picker creates shell pane when shell is selected', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await openPanePicker(page)

    // Click a shell option (platform-dependent: Shell on Linux, CMD/PowerShell/WSL on Windows/WSL)
    const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
    for (const name of shellNames) {
      try {
        const btn = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
        if (await btn.isVisible().catch(() => false)) {
          await btn.click({ timeout: 5000 })
          break
        }
      } catch { continue }
    }

    // Wait for second terminal to appear
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 15_000 })

    // Verify the layout has 2 panes
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')
    expect(layout.children).toHaveLength(2)

    // Close the second pane via close button (title="Close pane")
    const closeButton = page.locator('button[title="Close pane"]').last()
    await closeButton.click()
    await page.waitForTimeout(500)

    // Should return to a single pane layout
    const layoutAfter = await harness.getPaneLayout(activeTabId!)
    expect(layoutAfter.type).toBe('leaf')
  })
})
