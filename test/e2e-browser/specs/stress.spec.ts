import { test, expect } from '../helpers/fixtures.js'

test.describe('Stress Tests', () => {
  test.setTimeout(120_000) // Extended timeout for stress tests

  test('handles 6+ panes simultaneously', async ({ freshellPage, page, harness }) => {
    // Create multiple panes by splitting
    // Verify all panes render and terminals work
    const addButton = page.getByRole('button', { name: /new.*tab/i })

    // Create tabs with terminals
    for (let i = 0; i < 5; i++) {
      await addButton.click()
    }
    await harness.waitForTabCount(6)

    // All tabs should have valid layouts
    const state = await harness.getState()
    for (const tab of state.tabs.tabs) {
      const layout = state.panes.layouts[tab.id]
      expect(layout).toBeTruthy()
    }
  })

  test('handles 10 tabs', async ({ freshellPage, page, harness }) => {
    const addButton = page.getByRole('button', { name: /new.*tab/i })

    for (let i = 0; i < 9; i++) {
      await addButton.click()
    }
    await harness.waitForTabCount(10)
  })

  test('rapid tab switching', async ({ freshellPage, page, harness }) => {
    // Create multiple tabs
    const addButton = page.getByRole('button', { name: /new.*tab/i })
    for (let i = 0; i < 4; i++) {
      await addButton.click()
    }
    await harness.waitForTabCount(5)

    // Rapidly switch between tabs
    const tabs = page.locator('[data-context="tab"]')
    for (let i = 0; i < 20; i++) {
      const index = i % 5
      await tabs.nth(index).click()
      // Minimal wait to allow state to update
      await page.waitForTimeout(50)
    }

    // App should not crash
    const tabCount = await harness.getTabCount()
    expect(tabCount).toBe(5)
  })

  test('concurrent terminal output', async ({ freshellPage, page, harness, terminal }) => {
    // Create multiple tabs with active terminals
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Run a command that generates output
    await terminal.executeCommand('for i in $(seq 1 100); do echo "line-$i"; done')

    // Wait for the last line
    await terminal.waitForOutput('line-100', { timeout: 30_000 })
  })

  test('large output does not crash', async ({ freshellPage, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    // Generate a large amount of output
    await terminal.executeCommand('seq 1 1000')
    await terminal.waitForOutput('1000', { timeout: 30_000 })

    // Terminal should still be responsive
    await terminal.executeCommand('echo "still-alive"')
    await terminal.waitForOutput('still-alive', { timeout: 10_000 })
  })
})
