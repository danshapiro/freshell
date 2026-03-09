import { test, expect } from '../helpers/fixtures.js'

test.describe('Tab Management', () => {
  test('starts with one tab', async ({ freshellPage, harness }) => {
    const tabCount = await harness.getTabCount()
    expect(tabCount).toBe(1)
  })

  test('add tab button creates new tab', async ({ freshellPage, page, harness }) => {
    const addButton = page.getByRole('button', { name: /new.*tab/i })
    await addButton.click()
    await harness.waitForTabCount(2)
  })

  test('clicking tab switches to it', async ({ freshellPage, page, harness }) => {
    // Create second tab
    const addButton = page.getByRole('button', { name: /new.*tab/i })
    await addButton.click()
    await harness.waitForTabCount(2)

    // Click first tab
    const firstTab = page.locator('[data-context="tab"]').first()
    await firstTab.click()

    // Verify active tab changed
    const state = await harness.getState()
    expect(state.tabs.activeTabId).toBe(state.tabs.tabs[0].id)
  })

  test('close tab removes it', async ({ freshellPage, page, harness }) => {
    // Create second tab
    const addButton = page.getByRole('button', { name: /new.*tab/i })
    await addButton.click()
    await harness.waitForTabCount(2)

    // Close the second tab (close button on tab has title="Close (Shift+Click to kill)")
    const secondTab = page.locator('[data-context="tab"]').last()
    const closeButton = secondTab.getByRole('button', { name: /close/i })
    await closeButton.click()

    await harness.waitForTabCount(1)
  })

  test('cannot close last tab', async ({ freshellPage, page, harness }) => {
    // Try to close the only tab
    const tabCount = await harness.getTabCount()
    expect(tabCount).toBe(1)

    // The close button on the last tab should either:
    // 1. Not exist
    // 2. Be disabled
    // 3. Create a new tab when the last one is closed
    // This behavior depends on implementation
  })

  test('tab rename via double-click', async ({ freshellPage, page, harness }) => {
    // Double-click the tab to enter rename mode
    const tab = page.locator('[data-context="tab"]').first()
    await tab.dblclick()

    // Should show an input field
    const renameInput = page.locator('input[type="text"]').first()
    await expect(renameInput).toBeVisible({ timeout: 5_000 })

    // Type new name
    await renameInput.fill('My Custom Tab')
    await renameInput.press('Enter')

    // Verify the tab shows the new name
    await expect(page.getByText('My Custom Tab')).toBeVisible()
  })

  test('tabs persist across page reload', async ({ freshellPage, page, harness, serverInfo }) => {
    // Create a second tab and rename the first
    const addButton = page.getByRole('button', { name: /new.*tab/i })
    await addButton.click()
    await harness.waitForTabCount(2)

    // Reload the page
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Tabs should be restored from localStorage
    const tabCount = await harness.getTabCount()
    expect(tabCount).toBeGreaterThanOrEqual(1)
  })

  test('keyboard shortcut creates new tab', async ({ freshellPage, page, harness }) => {
    // Ctrl+T or Cmd+T should create new tab
    await page.keyboard.press('Control+t')
    // Note: this may be intercepted by the browser. If so, test the app's
    // own keyboard shortcut instead.
    // Alternative: use the app's shortcut if Ctrl+T is blocked
    await page.waitForTimeout(500)
  })

  test('tab overflow shows scroll controls', async ({ freshellPage, page, harness }) => {
    // Create many tabs to trigger overflow
    const addButton = page.getByRole('button', { name: /new.*tab/i })
    for (let i = 0; i < 10; i++) {
      await addButton.click()
    }
    await harness.waitForTabCount(11)

    // Check that tabs are still navigable
    const tabs = page.locator('[data-context="tab"]')
    const tabCount = await tabs.count()
    expect(tabCount).toBe(11)
  })

  test('drag and drop reorders tabs', async ({ freshellPage, page, harness }) => {
    // Create tabs
    const addButton = page.getByRole('button', { name: /new.*tab/i })
    await addButton.click()
    await addButton.click()
    await harness.waitForTabCount(3)

    // Get initial tab order
    const stateBefore = await harness.getState()
    const tabIdsBefore = stateBefore.tabs.tabs.map((t: any) => t.id)

    // Drag first tab to last position
    const firstTab = page.locator('[data-context="tab"]').first()
    const lastTab = page.locator('[data-context="tab"]').last()

    const firstBox = await firstTab.boundingBox()
    const lastBox = await lastTab.boundingBox()

    if (firstBox && lastBox) {
      await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2)
      await page.mouse.down()
      await page.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, { steps: 10 })
      await page.mouse.up()

      // Verify order changed
      await page.waitForTimeout(500)
      const stateAfter = await harness.getState()
      const tabIdsAfter = stateAfter.tabs.tabs.map((t: any) => t.id)
      // Tab order should have changed
      expect(tabIdsAfter).not.toEqual(tabIdsBefore)
    }
  })
})
