import { test, expect } from '../helpers/fixtures.js'

test.describe('Agent Chat', () => {
  // Note: Agent chat requires SDK provider bridges (Claude, Codex, etc.)
  // which may not be available in the isolated test environment.
  // These tests verify the UI flow for pane creation. Tests that require
  // a specific CLI provider use test.skip when it's not available.

  // Helper: open the pane picker by splitting a terminal pane.
  // Uses role="menuitem" for "Split horizontally" in the terminal context menu.
  async function openPanePicker(page: any) {
    const existingPicker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
    if (await existingPicker.isVisible().catch(() => false)) {
      return existingPicker
    }

    const termContainer = page.locator('.xterm').first()
    if (await termContainer.isVisible().catch(() => false)) {
      await termContainer.click({ button: 'right' })
      await page.getByRole('menuitem', { name: /split horizontally/i }).click()
    } else {
      await page.getByRole('button', { name: /add pane/i }).click()
    }
    const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
    await expect(picker).toBeVisible({ timeout: 10_000 })
    return picker
  }

  async function openFreshclaudeSettings(page: any) {
    const pane = page.getByRole('group', { name: /pane: freshclaude/i }).last()
    await expect(pane).toBeVisible({ timeout: 10_000 })

    const dialog = pane.getByRole('dialog', { name: 'Agent chat settings' })
    if (!await dialog.isVisible().catch(() => false)) {
      await pane.getByRole('button', { name: /^settings$/i }).click()
    }

    await expect(dialog).toBeVisible({ timeout: 10_000 })
    return dialog
  }

  async function confirmFreshclaudeDirectory(page: any, cwd: string) {
    const directoryInput = page.getByRole('combobox', { name: /starting directory for freshclaude/i }).last()
    const pickerAppeared = await directoryInput
      .waitFor({ state: 'visible', timeout: 2_000 })
      .then(() => true)
      .catch(() => false)
    if (!pickerAppeared) {
      return
    }

    const waitForDismissal = async (timeout: number) => {
      try {
        await directoryInput.waitFor({ state: 'hidden', timeout })
        return true
      } catch {
        return false
      }
    }

    const suggestionList = page.getByRole('listbox').last()
    if (await suggestionList.isVisible().catch(() => false)) {
      await suggestionList.getByRole('option').first().click({ force: true })
      if (await waitForDismissal(2_000)) {
        return
      }
    }

    await directoryInput.fill(cwd)
    await directoryInput.press('Enter')
    await directoryInput.waitFor({ state: 'hidden', timeout: 10_000 })
  }

  async function getActiveLeaf(harness: any) {
    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    return { tabId: tabId!, paneId: layout.id as string }
  }

  async function enableFreshclaude(page: any) {
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
    await enableFreshclaude(page)

    const picker = await openPanePicker(page)
    await expect(picker.getByRole('button', { name: /^Freshclaude$/i })).toBeVisible()
  })

  test('freshclaude settings render provider-default tracking and create with opus', async ({ freshellPage: _freshellPage, page, harness, serverInfo, terminal }) => {
    await terminal.waitForTerminal()
    await enableFreshclaude(page)

    await page.route('**/api/agent-chat/capabilities/freshclaude', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: 1_234,
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Latest Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['turbo', 'warp'],
                supportsAdaptiveThinking: true,
              },
              {
                id: 'opus[1m]',
                displayName: 'Opus 1M',
                description: 'Long context window',
                supportsEffort: true,
                supportedEffortLevels: ['warp'],
                supportsAdaptiveThinking: true,
              },
              {
                id: 'haiku',
                displayName: 'Haiku',
                description: 'Fast path',
                supportsEffort: false,
                supportedEffortLevels: [],
                supportsAdaptiveThinking: false,
              },
            ],
          },
        }),
      })
    })

    await harness.clearSentWsMessages()
    const picker = await openPanePicker(page)
    await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
    await confirmFreshclaudeDirectory(page, serverInfo.homeDir)

    const dialog = await openFreshclaudeSettings(page)

    const modelLabels = await dialog.getByRole('combobox', { name: /^Model$/i }).locator('option').evaluateAll(
      (options) => options.map((option) => option.textContent),
    )
    expect(modelLabels).toEqual([
      'Provider default (track latest Opus)',
      'Opus',
      'Opus 1M',
      'Haiku',
    ])
    await expect(dialog.getByText('Tracks latest Opus automatically.')).toBeVisible()

    const effortLabels = await dialog.getByRole('combobox', { name: /^Effort$/i }).locator('option').evaluateAll(
      (options) => options.map((option) => option.textContent),
    )
    expect(effortLabels).toEqual(['Model default', 'turbo', 'warp'])
    await expect(dialog).toHaveScreenshot('freshclaude-settings-surface.png')

    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      return sent.find((msg: any) => msg?.type === 'sdk.create') ?? null
    }).toMatchObject({
      type: 'sdk.create',
      model: 'opus',
    })
  })

  test('opening freshclaude settings refreshes stale cached capabilities before rendering live options', async ({ freshellPage: _freshellPage, page, harness, serverInfo, terminal }) => {
    await terminal.waitForTerminal()
    await enableFreshclaude(page)

    let capabilityRequests = 0
    await page.route('**/api/agent-chat/capabilities/freshclaude', async (route) => {
      capabilityRequests += 1
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: Date.now(),
            models: [
              {
                id: 'opus',
                displayName: 'Opus',
                description: 'Latest Opus track',
                supportsEffort: true,
                supportedEffortLevels: ['turbo', 'warp'],
                supportsAdaptiveThinking: true,
              },
              {
                id: 'haiku',
                displayName: 'Haiku',
                description: 'Fast path',
                supportsEffort: false,
                supportedEffortLevels: [],
                supportsAdaptiveThinking: false,
              },
            ],
          },
        }),
      })
    })

    await harness.clearSentWsMessages()
    const picker = await openPanePicker(page)
    await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
    await confirmFreshclaudeDirectory(page, serverInfo.homeDir)

    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      return sent.find((msg: any) => msg?.type === 'sdk.create') ?? null
    }).toMatchObject({
      type: 'sdk.create',
      model: 'opus',
    })

    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'agentChat/capabilityFetchSucceeded',
        payload: {
          provider: 'freshclaude',
          capabilities: {
            provider: 'freshclaude',
            fetchedAt: 0,
            models: [
              {
                id: 'legacy-default',
                displayName: 'Legacy Default',
                description: 'Old cached row',
                supportsEffort: true,
                supportedEffortLevels: ['old-effort'],
                supportsAdaptiveThinking: false,
              },
            ],
          },
        },
      })
    })

    const dialog = await openFreshclaudeSettings(page)
    await expect.poll(() => capabilityRequests > 0).toBe(true)

    await expect.poll(async () => (
      dialog.getByRole('combobox', { name: /^Model$/i }).locator('option').evaluateAll(
        (options) => options.map((option) => option.textContent),
      )
    )).toEqual([
      'Provider default (track latest Opus)',
      'Opus',
      'Haiku',
    ])
    await expect(dialog.getByText('Old cached row')).toHaveCount(0)

    await expect.poll(async () => (
      dialog.getByRole('combobox', { name: /^Effort$/i }).locator('option').evaluateAll(
        (options) => options.map((option) => option.textContent),
      )
    )).toEqual(['Model default', 'turbo', 'warp'])
    await expect(dialog).toHaveScreenshot('freshclaude-stale-capability-refresh.png')
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
