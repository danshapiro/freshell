import { test, expect } from '../helpers/fixtures.js'

test.describe('Reopen Closed Tab (Alt+H)', () => {
  test('reopens the most recently closed tab with Alt+H in LIFO order', async ({ freshellPage, page, harness }) => {
    // Start with one tab (shell, created by freshellPage fixture)
    await harness.waitForTabCount(1)

    // Create a second tab via Alt+T
    await page.keyboard.press('Alt+t')
    await harness.waitForTabCount(2)

    // Create a third tab via Alt+T
    await page.keyboard.press('Alt+t')
    await harness.waitForTabCount(3)

    // Get tab titles for verification
    const state1 = await harness.getState()
    const tab2Title = state1.tabs.tabs[1].title
    const tab3Title = state1.tabs.tabs[2].title

    // Close tab 3 (active)
    await page.keyboard.press('Alt+w')
    await harness.waitForTabCount(2)

    // Close tab 2 (now active)
    await page.keyboard.press('Alt+w')
    await harness.waitForTabCount(1)

    // Reopen — should get tab 2 back (LIFO)
    await page.keyboard.press('Alt+h')
    await harness.waitForTabCount(2)

    const state2 = await harness.getState()
    expect(state2.tabs.tabs[1].title).toBe(tab2Title)
    expect(state2.tabs.activeTabId).toBe(state2.tabs.tabs[1].id)

    // Reopen again — should get tab 3 back
    await page.keyboard.press('Alt+h')
    await harness.waitForTabCount(3)

    const state3 = await harness.getState()
    expect(state3.tabs.tabs[2].title).toBe(tab3Title)
  })

  test('Alt+H with empty reopen stack does nothing', async ({ freshellPage, page, harness }) => {
    await harness.waitForTabCount(1)

    // Press Alt+H when nothing has been closed
    await page.keyboard.press('Alt+h')
    // Should still have 1 tab
    const state = await harness.getState()
    expect(state.tabs.tabs).toHaveLength(1)
  })

  test('reopens tab with browser pane and preserves split layout', async ({ freshellPage, page, harness, terminal }) => {
    // Wait for the initial terminal
    await terminal.waitForTerminal()

    // Create a browser pane via context menu split
    const termContainer = page.locator('.xterm').first()
    await termContainer.click({ button: 'right' })
    await page.getByRole('menuitem', { name: /split horizontally/i }).click()
    const browserButton = page.getByRole('button', { name: /^Browser$/i })
    await expect(browserButton).toBeVisible({ timeout: 10_000 })
    await browserButton.click()
    await expect(page.getByPlaceholder('Enter URL...')).toBeVisible({ timeout: 10_000 })

    // Verify split layout with terminal + browser before close
    const state1 = await harness.getState()
    const tabId = state1.tabs.activeTabId
    const layoutBefore = state1.panes.layouts[tabId]
    expect(layoutBefore.type).toBe('split')
    const hasBrowser = layoutBefore.children.some((c: any) =>
      c.type === 'leaf' && c.content?.kind === 'browser'
    )
    expect(hasBrowser).toBe(true)

    // Create a second tab (so closing the first doesn't leave zero tabs)
    await page.keyboard.press('Alt+t')
    await harness.waitForTabCount(2)

    // Switch back to first tab and close it
    const firstTabLocator = page.locator('[data-context="tab"]').first()
    await firstTabLocator.click()
    await page.keyboard.press('Alt+w')
    await harness.waitForTabCount(1)

    // Reopen — the tab with the split layout should return
    await page.keyboard.press('Alt+h')
    await harness.waitForTabCount(2)

    const state2 = await harness.getState()
    const reopenedTabId = state2.tabs.activeTabId
    const layoutAfter = state2.panes.layouts[reopenedTabId]
    expect(layoutAfter.type).toBe('split')
    const hasBrowserAfter = layoutAfter.children.some((c: any) =>
      c.type === 'leaf' && c.content?.kind === 'browser'
    )
    expect(hasBrowserAfter).toBe(true)
    // Terminal pane should have fresh IDs (stale ones stripped)
    const termPane = layoutAfter.children.find((c: any) =>
      c.type === 'leaf' && c.content?.kind === 'terminal'
    )
    expect(termPane).toBeDefined()
    expect(termPane.content.status).toBe('creating')
  })
})
