import { test, expect } from '../helpers/fixtures.js'

test.describe('Settings', () => {
  // Helper: navigate to the settings view.
  // Sidebar nav buttons have title="Settings (Ctrl+B ,)" which Playwright
  // matches via getByRole with name /settings/i (title is used as accessible name).
  async function openSettings(page: any) {
    const settingsButton = page.getByRole('button', { name: /settings/i })
    await settingsButton.click()
    await expect(page.getByRole('tab', { name: /^Appearance$/i })).toBeVisible({ timeout: 5_000 })
  }

  async function openSettingsSection(page: any, name: string) {
    await page.getByRole('tab', { name: new RegExp(`^${name}$`, 'i') }).click()
    await expect(page.getByRole('tabpanel', { name: new RegExp(`${name} settings`, 'i') })).toBeVisible({
      timeout: 5_000,
    })
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

  async function patchServerSettings(page: any, serverInfo: any, patch: Record<string, unknown>) {
    const response = await page.evaluate(async ({ baseUrl, token, patchPayload }) => {
      const result = await fetch(`${baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-auth-token': token,
        },
        body: JSON.stringify(patchPayload),
      })
      return { ok: result.ok, status: result.status }
    }, {
      baseUrl: serverInfo.baseUrl,
      token: serverInfo.token,
      patchPayload: patch,
    })

    expect(response.ok).toBe(true)
  }

  test('settings view is accessible from sidebar', async ({ freshellPage, page }) => {
    await openSettings(page)

    await expect(page.getByRole('tab', { name: /^Appearance$/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Workspace$/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^AI$/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Safety$/i })).toBeVisible()
    await expect(page.getByRole('tab', { name: /^Advanced$/i })).toBeVisible()
  })

  test('terminal font size slider changes setting', async ({ freshellPage, page, harness }) => {
    await openSettings(page)

    // SettingsRow label="Font size" renders as <span> text, not <label>.
    // The control is a RangeSlider which renders <input type="range">.
    // Find the "Font size" row, then locate its range input.
    const fontSizeRow = page.getByText('Font size')
    await expect(fontSizeRow).toBeVisible()

    // The range input is within the same SettingsRow container.
    // Use the row's parent to scope the range input.
    const fontSizeSlider = fontSizeRow.locator('..').locator('input[type="range"]')
    await expect(fontSizeSlider).toBeVisible()

    // Change the slider value via JavaScript (range inputs are hard to drag in Playwright)
    const settingsBefore = await harness.getSettings()
    const fontSizeBefore = settingsBefore.terminal.fontSize

    await fontSizeSlider.fill('20')
    // Trigger the pointerup event to commit the value
    await fontSizeSlider.dispatchEvent('pointerup')
    await page.waitForTimeout(500)

    const settingsAfter = await harness.getSettings()
    expect(settingsAfter.terminal.fontSize).toBe(20)
    expect(settingsAfter.terminal.fontSize).not.toBe(fontSizeBefore)
  })

  test('terminal color scheme selection', async ({ freshellPage, page, harness }) => {
    await openSettings(page)

    // SettingsRow label="Color scheme" contains a <select> element.
    // Find the Color scheme row, then the select within it.
    const colorSchemeRow = page.getByText('Color scheme')
    await expect(colorSchemeRow).toBeVisible()

    const colorSelect = colorSchemeRow.locator('..').locator('select')
    await expect(colorSelect).toBeVisible()

    // Change to "dracula" theme
    await colorSelect.selectOption('dracula')
    await page.waitForTimeout(500)

    const settings = await harness.getSettings()
    expect(settings.terminal.theme).toBe('dracula')
  })

  test('settings persist after reload', async ({ freshellPage, page, harness, serverInfo }) => {
    await openSettings(page)

    // Change a setting: toggle cursor blink
    const cursorBlinkRow = page.getByText('Cursor blink')
    await expect(cursorBlinkRow).toBeVisible()

    // Toggle uses role="switch" within the row
    const toggle = cursorBlinkRow.locator('..').getByRole('switch')
    await expect(toggle).toBeVisible()

    const settingsBefore = await harness.getSettings()
    const blinkBefore = settingsBefore.terminal.cursorBlink

    await toggle.click()
    await page.waitForTimeout(500)

    // Verify changed
    const settingsAfterToggle = await harness.getSettings()
    expect(settingsAfterToggle.terminal.cursorBlink).toBe(!blinkBefore)

    // Reload the page
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Settings should be loaded from server and persist
    const settingsAfterReload = await harness.getSettings()
    expect(settingsAfterReload.terminal.cursorBlink).toBe(!blinkBefore)
  })

  test('cursor blink toggle works', async ({ freshellPage, page, harness }) => {
    await openSettings(page)

    // Find "Cursor blink" row, then its Toggle (role="switch")
    const cursorBlinkRow = page.getByText('Cursor blink')
    await expect(cursorBlinkRow).toBeVisible()

    const toggle = cursorBlinkRow.locator('..').getByRole('switch')
    await expect(toggle).toBeVisible()

    const settingsBefore = await harness.getSettings()
    const blinkBefore = settingsBefore.terminal.cursorBlink

    await toggle.click()
    await page.waitForTimeout(500)

    const settingsAfter = await harness.getSettings()
    expect(settingsAfter.terminal.cursorBlink).toBe(!blinkBefore)
  })

  test('scrollback lines slider changes setting', async ({ freshellPage, page, harness }) => {
    await openSettings(page)
    await openSettingsSection(page, 'Advanced')

    // "Scrollback lines" row with RangeSlider
    const scrollbackRow = page.getByText('Scrollback lines')
    await expect(scrollbackRow).toBeVisible()

    const scrollbackSlider = scrollbackRow.locator('..').locator('input[type="range"]')
    await expect(scrollbackSlider).toBeVisible()

    await scrollbackSlider.fill('5000')
    await scrollbackSlider.dispatchEvent('pointerup')
    await page.waitForTimeout(500)

    const settings = await harness.getSettings()
    expect(settings.terminal.scrollback).toBe(5000)
  })

  test('debug logging toggle', async ({ freshellPage, page, harness }) => {
    await openSettings(page)
    await openSettingsSection(page, 'Advanced')

    // Scroll down to "Debugging" section, find "Debug logging" row
    const debugLoggingRow = page.getByText('Debug logging')
    await expect(debugLoggingRow).toBeVisible()

    // Toggle within the row (role="switch")
    const toggle = debugLoggingRow.locator('..').getByRole('switch')
    await expect(toggle).toBeVisible()

    const settingsBefore = await harness.getSettings()
    const debugBefore = settingsBefore.logging?.debug ?? false

    await toggle.click()
    await page.waitForTimeout(500)

    const settingsAfter = await harness.getSettings()
    expect(settingsAfter.logging?.debug).toBe(!debugBefore)
  })

  test('appearance section has theme controls', async ({ freshellPage, page }) => {
    await openSettings(page)

    // The Appearance section has theme controls (SegmentedControl for system/light/dark)
    await expect(page.getByText('Appearance').first()).toBeVisible()
    // Verify at least one theme mode button is present
    await expect(
      page.getByRole('button', { name: /system|light|dark/i }).first()
    ).toBeVisible()
  })

  test('freshclaude settings show an explicit capability error while provider-default create remains safe', async ({ freshellPage: _freshellPage, page, harness, serverInfo, terminal }) => {
    await terminal.waitForTerminal()
    await enableFreshclaude(page)

    await page.route('**/api/agent-chat/capabilities/freshclaude', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: {
            code: 'CAPABILITY_PROBE_FAILED',
            message: 'Probe failed upstream',
            retryable: true,
          },
        }),
      })
    })

    let refreshed = false
    await page.route('**/api/agent-chat/capabilities/freshclaude/refresh', async (route) => {
      refreshed = true
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
                supportedEffortLevels: ['turbo'],
                supportsAdaptiveThinking: true,
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
      const create = sent.find((message: any) => message?.type === 'sdk.create')
      return create
        ? {
            model: create.model ?? null,
            effort: Object.prototype.hasOwnProperty.call(create, 'effort') ? create.effort : null,
          }
        : null
    }).toEqual({
      model: 'opus',
      effort: null,
    })

    const dialog = await openFreshclaudeSettings(page)
    await expect(dialog.getByRole('alert')).toContainText('Probe failed upstream')

    await dialog.getByRole('button', { name: 'Retry model load' }).click()

    await expect.poll(() => refreshed).toBe(true)
    await expect(dialog.getByText('Tracks latest Opus automatically.')).toBeVisible()
  })

  test('freshclaude capability failures block validation-dependent create until retry succeeds', async ({ freshellPage: _freshellPage, page, harness, serverInfo, terminal }) => {
    await terminal.waitForTerminal()

    await page.route('**/api/agent-chat/capabilities/freshclaude', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: {
            code: 'CAPABILITY_PROBE_FAILED',
            message: 'Probe failed upstream',
            retryable: true,
          },
        }),
      })
    })

    let refreshed = false
    await page.route('**/api/agent-chat/capabilities/freshclaude/refresh', async (route) => {
      refreshed = true
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
                supportedEffortLevels: ['turbo'],
                supportsAdaptiveThinking: true,
              },
            ],
          },
        }),
      })
    })

    await patchServerSettings(page, serverInfo, {
      agentChat: {
        providers: {
          freshclaude: {
            effort: 'turbo',
          },
        },
      },
    })

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await terminal.waitForTerminal()
    await enableFreshclaude(page)

    await harness.clearSentWsMessages()
    const picker = await openPanePicker(page)
    await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
    await confirmFreshclaudeDirectory(page, serverInfo.homeDir)

    const createFailedAlert = page.getByRole('alert').filter({ hasText: 'Session start failed' })
    await expect(createFailedAlert).toBeVisible()
    await expect(createFailedAlert).toContainText('Probe failed upstream')
    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      return sent.filter((message: any) => message?.type === 'sdk.create').length
    }).toBe(0)

    const dialog = await openFreshclaudeSettings(page)
    await expect(dialog.getByRole('alert')).toContainText('Probe failed upstream')
    await dialog.getByRole('button', { name: 'Retry model load' }).click()

    await expect.poll(() => refreshed).toBe(true)
    await expect(dialog.getByText('Tracks latest Opus automatically.')).toBeVisible()
    await page.getByRole('button', { name: 'Retry', exact: true }).click()

    await expect.poll(async () => {
      const sent = await harness.getSentWsMessages()
      const create = sent.find((message: any) => message?.type === 'sdk.create')
      return create
        ? {
            model: create.model ?? null,
            effort: Object.prototype.hasOwnProperty.call(create, 'effort') ? create.effort : null,
          }
        : null
    }).toEqual({
      model: 'opus',
      effort: 'turbo',
    })
  })
})
