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
