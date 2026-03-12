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

  test('agent chat provider appears when CLI is available', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()

    // Check if any agent chat provider is available via Redux state
    const state = await harness.getState()
    const availableClis = state.connection?.availableClis ?? {}
    const enabledProviders = state.settings?.settings?.codingCli?.enabledProviders ?? []

    // Find a provider that is both available and enabled
    const hasProvider = Object.keys(availableClis).some(
      (cli) => availableClis[cli] && enabledProviders.includes(cli)
    )

    if (!hasProvider) {
      // No CLI providers available in the isolated test env -- skip
      test.skip()
      return
    }

    await openPanePicker(page)

    // The picker should show more than just Shell/Editor/Browser
    const pickerOptions = page.locator('[data-testid="pane-picker-options"] button')
    const count = await pickerOptions.count()
    expect(count).toBeGreaterThan(3)
  })

  test.skip('agent chat permission banners appear', async ({ freshellPage, page }) => {
    // This test requires a live SDK session to trigger permission requests.
    // In the isolated test environment, no SDK session is available.
    // Skipping until a mock SDK bridge is implemented.
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
