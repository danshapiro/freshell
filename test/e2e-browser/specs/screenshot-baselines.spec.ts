import { test, expect } from '../helpers/fixtures.js'

test.describe('Screenshot Baselines', () => {
  test('default app layout', async ({ freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Wait for layout to stabilize
    await page.waitForTimeout(1000)

    await expect(page).toHaveScreenshot('default-layout.png', {
      maxDiffPixelRatio: 0.05,
    })
  })

  test('settings view', async ({ freshellPage, page }) => {
    // Navigate to settings via sidebar button (title contains "Settings")
    const settingsButton = page.getByRole('button', { name: /settings/i })
    await settingsButton.click()
    // Wait for settings sections to render
    await expect(page.getByText('Terminal').first()).toBeVisible({ timeout: 5_000 })
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('settings-view.png', {
      maxDiffPixelRatio: 0.05,
    })
  })

  test('multiple tabs', async ({ freshellPage, page, harness }) => {
    const addButton = page.getByRole('button', { name: /new tab|add tab/i })
    await addButton.click()
    await addButton.click()
    await harness.waitForTabCount(3)
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('multiple-tabs.png', {
      maxDiffPixelRatio: 0.05,
    })
  })

  test('auth modal', async ({ page, serverInfo }) => {
    await page.goto(serverInfo.baseUrl)
    const modal = page.getByRole('dialog')
    await expect(modal).toBeVisible({ timeout: 10_000 })
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('auth-modal.png', {
      maxDiffPixelRatio: 0.05,
    })
  })

  test('sidebar collapsed', async ({ freshellPage, page }) => {
    // "Hide sidebar" button (aria-label="Hide sidebar")
    const collapseButton = page.getByRole('button', { name: /hide sidebar/i })
    await expect(collapseButton).toBeVisible()
    await collapseButton.click()
    await page.waitForTimeout(500)

    await expect(page).toHaveScreenshot('sidebar-collapsed.png', {
      maxDiffPixelRatio: 0.05,
    })
  })

  test('mobile layout', async ({ page, serverInfo }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)

    await page.waitForFunction(() => !!window.__FRESHELL_TEST_HARNESS__)
    await page.waitForTimeout(1000)

    await expect(page).toHaveScreenshot('mobile-layout.png', {
      maxDiffPixelRatio: 0.05,
    })
  })
})
