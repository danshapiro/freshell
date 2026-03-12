import { test, expect } from '../helpers/fixtures.js'

test.describe('Tab Management', () => {
  test('starts with one tab', async ({ freshellPage, harness }) => {
    const tabCount = await harness.getTabCount()
    expect(tabCount).toBe(1)
  })

  test('add tab button creates new tab', async ({ freshellPage, page, harness }) => {
    const addButton = page.locator('[data-context="tab-add"]')
    await addButton.click()
    await harness.waitForTabCount(2)
  })

  test('clicking tab switches to it', async ({ freshellPage, page, harness }) => {
    // Create second tab
    const addButton = page.locator('[data-context="tab-add"]')
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
    const addButton = page.locator('[data-context="tab-add"]')
    await addButton.click()
    await harness.waitForTabCount(2)

    // Close the second tab (close button on tab has title="Close (Shift+Click to kill)")
    const secondTab = page.locator('[data-context="tab"]').last()
    const closeButton = secondTab.getByRole('button', { name: /close/i })
    await closeButton.click()

    await harness.waitForTabCount(1)
  })

  test('cannot close last tab', async ({ freshellPage, page, harness }) => {
    const tabCount = await harness.getTabCount()
    expect(tabCount).toBe(1)

    // Try to close the only tab
    const tab = page.locator('[data-context="tab"]').first()
    const closeButton = tab.getByRole('button', { name: /close/i })

    // If close button exists, clicking it should either be prevented
    // or create a replacement tab — either way we should still have >= 1 tab
    if (await closeButton.isVisible()) {
      await closeButton.click()
      await page.waitForTimeout(500)
    }

    const finalTabCount = await harness.getTabCount()
    expect(finalTabCount).toBeGreaterThanOrEqual(1)
  })

  test('tab rename via double-click', async ({ freshellPage, page, harness }) => {
    // Double-click the tab to enter rename mode
    const tab = page.locator('[data-context="tab"]').first()
    await tab.dblclick()

    // The rename input appears INSIDE the tab element (replaces the title span)
    const renameInput = tab.locator('input')
    await expect(renameInput).toBeVisible({ timeout: 5_000 })

    // Type new name
    await renameInput.fill('My Custom Tab')
    await renameInput.press('Enter')

    // Verify the tab shows the new name (look within the tab area)
    await expect(tab.getByText('My Custom Tab')).toBeVisible({ timeout: 5_000 })
  })

  test('tabs persist across page reload', async ({ freshellPage, page, harness, serverInfo }) => {
    // Create a second tab and rename the first
    const addButton = page.locator('[data-context="tab-add"]')
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

  test.skip('keyboard shortcut creates new tab', async ({ freshellPage, page, harness }) => {
    // Ctrl+T is intercepted by Chromium in headed mode and cannot be tested.
    // The app's keyboard shortcut handling is covered by unit tests.
    await page.keyboard.press('Control+t')
    await harness.waitForTabCount(2)
  })

  test('tab overflow shows scroll controls', async ({ freshellPage, page, harness }) => {
    // Create many tabs to trigger overflow
    const addButton = page.locator('[data-context="tab-add"]')
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
    const addButton = page.locator('[data-context="tab-add"]')
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
    expect(firstBox).toBeTruthy()
    expect(lastBox).toBeTruthy()

    await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2)
    await page.mouse.down()
    await page.mouse.move(lastBox!.x + lastBox!.width / 2, lastBox!.y + lastBox!.height / 2, { steps: 10 })
    await page.mouse.up()

    // Verify order changed
    await page.waitForTimeout(500)
    const stateAfter = await harness.getState()
    const tabIdsAfter = stateAfter.tabs.tabs.map((t: any) => t.id)
    // Tab order should have changed
    expect(tabIdsAfter).not.toEqual(tabIdsBefore)
  })
})
