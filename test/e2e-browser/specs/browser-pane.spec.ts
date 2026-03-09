import { test, expect } from '../helpers/fixtures.js'

test.describe('Browser Pane', () => {
  // Helper: create a browser pane via context menu split + picker.
  // Context menu on terminal: "Split horizontally" (role="menuitem").
  // PanePicker: "Browser" button (aria-label="Browser").
  // BrowserPane renders a URL input with placeholder="Enter URL..."
  async function createBrowserPane(page: any) {
    const termContainer = page.locator('.xterm').first()
    await termContainer.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /split horizontally/i }).click()

    // Click "Browser" in the picker (aria-label="Browser")
    const browserButton = page.getByRole('button', { name: /^Browser$/i })
    await expect(browserButton).toBeVisible({ timeout: 10_000 })
    await browserButton.click()

    // Wait for the browser pane URL input (placeholder="Enter URL...")
    await expect(page.getByPlaceholder('Enter URL...')).toBeVisible({ timeout: 10_000 })
  }

  test('browser pane has URL input and navigation buttons', async ({ freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    await createBrowserPane(page)

    // URL input: placeholder="Enter URL..."
    const urlInput = page.getByPlaceholder('Enter URL...')
    await expect(urlInput).toBeVisible()

    // Navigation buttons: title="Back", title="Forward", title="Refresh"/"Stop"
    const backButton = page.locator('button[title="Back"]')
    const forwardButton = page.locator('button[title="Forward"]')
    await expect(backButton).toBeVisible()
    await expect(forwardButton).toBeVisible()

    // DevTools button: title="Developer Tools"
    const devtoolsButton = page.locator('button[title="Developer Tools"]')
    await expect(devtoolsButton).toBeVisible()
  })

  test('browser pane loads URL', async ({ freshellPage, page, serverInfo, terminal }) => {
    await terminal.waitForTerminal()
    await createBrowserPane(page)

    // Enter a URL (use the test server's own health endpoint)
    const urlInput = page.getByPlaceholder('Enter URL...')
    await urlInput.fill(`${serverInfo.baseUrl}/api/health`)
    await urlInput.press('Enter')

    // Wait for iframe to load (title="Browser content")
    const iframe = page.locator('iframe[title="Browser content"]')
    await iframe.waitFor({ state: 'attached', timeout: 10_000 })
    const src = await iframe.getAttribute('src')
    expect(src).toContain('/api/health')
  })

  test('browser pane URL bar updates on navigation', async ({ freshellPage, page, serverInfo, terminal }) => {
    await terminal.waitForTerminal()
    await createBrowserPane(page)

    const urlInput = page.getByPlaceholder('Enter URL...')
    await urlInput.fill(`${serverInfo.baseUrl}/api/health`)
    await urlInput.press('Enter')
    await page.waitForTimeout(1000)

    // The URL input should reflect the current URL
    const currentValue = await urlInput.inputValue()
    expect(currentValue).toContain('/api/health')
  })

  test('browser pane devtools toggle', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await createBrowserPane(page)

    // DevTools button: title="Developer Tools"
    const devtoolsButton = page.locator('button[title="Developer Tools"]')
    await expect(devtoolsButton).toBeVisible()
    await devtoolsButton.click()

    // After toggling, the devtools panel should appear (text "Developer Tools" heading)
    await expect(page.getByText('Developer Tools').last()).toBeVisible({ timeout: 3_000 })

    // Verify Redux state reflects devToolsOpen
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    const browserPane = layout.children?.find((c: any) => c.content?.kind === 'browser')
    expect(browserPane?.content?.devToolsOpen).toBe(true)
  })

  test('browser pane preserves URL across tab switches', async ({ freshellPage, page, harness, serverInfo, terminal }) => {
    await terminal.waitForTerminal()
    await createBrowserPane(page)

    const urlInput = page.getByPlaceholder('Enter URL...')
    const targetUrl = `${serverInfo.baseUrl}/api/health`
    await urlInput.fill(targetUrl)
    await urlInput.press('Enter')

    // Wait for iframe to load
    const iframe = page.locator('iframe[title="Browser content"]')
    await iframe.waitFor({ state: 'attached', timeout: 10_000 })

    // Switch to a new tab
    const addTabButton = page.getByRole('button', { name: /new.*tab/i })
    await addTabButton.click()
    await harness.waitForTabCount(2)

    // Switch back to the first tab
    await page.locator('[data-context="tab"]').first().click()
    await page.waitForTimeout(500)

    // Iframe should still have the health URL
    const restoredIframe = page.locator('iframe[title="Browser content"]')
    await restoredIframe.waitFor({ state: 'attached', timeout: 5_000 })
    const src = await restoredIframe.getAttribute('src')
    expect(src).toContain('/api/health')
  })
})
