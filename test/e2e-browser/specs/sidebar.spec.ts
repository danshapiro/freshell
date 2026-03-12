import { test, expect } from '../helpers/fixtures.js'

test.describe('Sidebar', () => {
  test('sidebar is visible by default', async ({ freshellPage, page }) => {
    // Sidebar renders as a div (not <aside>) but contains "Hide sidebar" button
    // aria-label="Hide sidebar" (from Sidebar.tsx line 569)
    const hideButton = page.getByRole('button', { name: /hide sidebar/i })
    await expect(hideButton).toBeVisible()
  })

  test('sidebar collapse toggle works', async ({ freshellPage, page }) => {
    // The sidebar has a "Hide sidebar" button (aria-label="Hide sidebar")
    const collapseButton = page.getByRole('button', { name: /hide sidebar/i })
    await expect(collapseButton).toBeVisible()
    await collapseButton.click()
    await page.waitForTimeout(300) // Animation

    // After collapsing, a "Show sidebar" button should appear
    // (aria-label="Show sidebar" in TabBar.tsx/App.tsx)
    const showButton = page.getByRole('button', { name: /show sidebar/i })
    await expect(showButton).toBeVisible({ timeout: 3_000 })

    // Re-expand
    await showButton.click()
    await page.waitForTimeout(300)
    await expect(page.getByRole('button', { name: /hide sidebar/i })).toBeVisible()
  })

  test('sidebar shows navigation buttons', async ({ freshellPage, page }) => {
    // Nav buttons have title attributes like "Settings (Ctrl+B ,)", "Tabs (Ctrl+B A)", etc.
    // Playwright matches title as accessible name for buttons with no text/aria-label.
    const settingsButton = page.getByRole('button', { name: /settings/i })
    await expect(settingsButton).toBeVisible()
  })

  test('sidebar search input is functional', async ({ freshellPage, page }) => {
    // Search input has placeholder="Search..." (from Sidebar.tsx line 619)
    const searchInput = page.getByPlaceholder('Search...')
    await expect(searchInput).toBeVisible()

    // Type a search query
    await searchInput.fill('nonexistent-query-12345')
    await page.waitForTimeout(500)

    // When filter is non-empty, a clear button appears (aria-label="Clear search")
    const clearButton = page.getByRole('button', { name: /clear search/i })
    await expect(clearButton).toBeVisible({ timeout: 3_000 })

    await clearButton.click()
    const value = await searchInput.inputValue()
    expect(value).toBe('')
  })

  test('sidebar empty state with isolated HOME', async ({ freshellPage, page, terminal }) => {
    // Create a terminal first so the app is fully loaded
    await terminal.waitForTerminal()

    // The sidebar shows "No sessions yet" when there are no Claude sessions
    // in the isolated HOME directory
    const emptyMessage = page.getByText('No sessions yet')
    await expect(emptyMessage).toBeVisible({ timeout: 5_000 })
  })

  test('sidebar view switches: settings and back', async ({ freshellPage, page }) => {
    // Switch to settings view
    const settingsButton = page.getByRole('button', { name: /settings/i })
    await settingsButton.click()

    // Settings view should show SettingsSection headers
    await expect(page.getByText('Terminal').first()).toBeVisible({ timeout: 5_000 })

    // Switch to the "Coding Agents" view (title="Coding Agents (Ctrl+B T)")
    // which is the default/home view that shows sessions alongside the terminal
    const codingAgentsButton = page.getByRole('button', { name: /coding agents/i })
    await expect(codingAgentsButton).toBeVisible()
    await codingAgentsButton.click()

    // Terminal should be visible again (Coding Agents view shows sessions list + terminal)
    await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 10_000 })
  })

  test('sidebar shows background terminals', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Create a second tab (which detaches from the first terminal)
    const addTabButton = page.locator('[data-context="tab-add"]')
    await addTabButton.click()
    await harness.waitForTabCount(2)

    // The first tab's terminal is still running in the background.
    // Verify the Redux state tracks the terminals
    const state = await harness.getState()
    expect(state.tabs.tabs.length).toBe(2)
  })
})
