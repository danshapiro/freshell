import { test, expect } from '../helpers/fixtures.js'

test.describe('Settings', () => {
  // Helper: navigate to the settings view.
  // Sidebar nav buttons have title="Settings (Ctrl+B ,)" which Playwright
  // matches via getByRole with name /settings/i (title is used as accessible name).
  async function openSettings(page: any) {
    const settingsButton = page.getByRole('button', { name: /settings/i })
    await settingsButton.click()
    // Settings view renders SettingsSection headers like "Terminal", "Appearance", etc.
    await expect(page.getByText('Terminal').first()).toBeVisible({ timeout: 5_000 })
  }

  test('settings view is accessible from sidebar', async ({ freshellPage, page }) => {
    await openSettings(page)

    // Verify multiple settings sections are visible
    // SettingsSection titles: "Appearance", "Terminal", "Debugging" (from SettingsView.tsx)
    await expect(page.getByText('Appearance').first()).toBeVisible()
    await expect(page.getByText('Terminal').first()).toBeVisible()
    await expect(page.getByText('Debugging').first()).toBeVisible()
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
})
