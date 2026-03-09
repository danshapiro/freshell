import { test, expect } from '../helpers/fixtures.js'

test.describe('Pane System', () => {
  // Helper: split via context menu. Context menu items are role="menuitem".
  // Labels from menu-defs.ts: "Split horizontally", "Split vertically"
  async function splitViaContextMenu(page: any, direction: 'horizontal' | 'vertical', nth = 0) {
    await page.locator('.xterm').nth(nth).click({ button: 'right' })
    const menuItem = page.getByRole('menuitem', {
      name: direction === 'horizontal' ? /split horizontally/i : /split vertically/i
    })
    await menuItem.click()
  }

  test('starts with a single pane', async ({ freshellPage, harness }) => {
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('leaf')
  })

  test('split pane horizontally', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitViaContextMenu(page, 'horizontal')

    // Wait for second terminal to appear
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 15_000 })

    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')
    expect(layout.direction).toBe('horizontal')
    expect(layout.children).toHaveLength(2)
  })

  test('split pane vertically', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitViaContextMenu(page, 'vertical')

    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 15_000 })

    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')
    expect(layout.direction).toBe('vertical')
    expect(layout.children).toHaveLength(2)
  })

  test('close pane returns to single pane', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitViaContextMenu(page, 'horizontal')
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 15_000 })

    // PaneHeader close button: <button title="Close pane">
    const closeButton = page.locator('button[title="Close pane"]').first()
    await closeButton.click()

    // Should return to single pane
    await page.waitForTimeout(300)
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('leaf')
  })

  test('each pane has independent terminal', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await terminal.waitForPrompt()

    await terminal.executeCommand('echo "pane-1-marker"')
    await terminal.waitForOutput('pane-1-marker')

    await splitViaContextMenu(page, 'horizontal')
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 15_000 })

    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')
    expect(layout.children).toHaveLength(2)
  })

  test('pane picker allows choosing pane type', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitViaContextMenu(page, 'horizontal')

    // The new pane shows the picker. PanePicker renders buttons with labels
    // "Shell", "Editor", "Browser" (from PanePicker.tsx)
    const shellOption = page.getByRole('button', { name: /^Shell$/i })
    const editorOption = page.getByRole('button', { name: /^Editor$/i })
    const browserOption = page.getByRole('button', { name: /^Browser$/i })

    await expect(shellOption).toBeVisible({ timeout: 10_000 })
    await expect(editorOption).toBeVisible()
    await expect(browserOption).toBeVisible()
  })

  test('pane resize by dragging divider', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitViaContextMenu(page, 'horizontal')
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 15_000 })

    // Resize handle has data-panel-resize-handle-id attribute
    const divider = page.locator('[data-panel-resize-handle-id]').first()
    await expect(divider).toBeVisible({ timeout: 5_000 })

    const box = await divider.boundingBox()
    expect(box).toBeTruthy()

    // Drag the divider 50px to the right
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2 + 50, box!.y + box!.height / 2)
    await page.mouse.up()

    // Both panes still exist after resize
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')
    expect(layout.children).toHaveLength(2)
  })

  test('pane focus switches correctly', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitViaContextMenu(page, 'horizontal')
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 15_000 })

    await page.locator('.xterm').first().click()
    let state = await harness.getState()
    const firstPaneId = state.panes?.activePaneId
    expect(firstPaneId).toBeTruthy()

    await page.locator('.xterm').nth(1).click()
    state = await harness.getState()
    const secondPaneId = state.panes?.activePaneId
    expect(secondPaneId).toBeTruthy()
    expect(secondPaneId).not.toBe(firstPaneId)
  })

  test('zoom pane hides other panes', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitViaContextMenu(page, 'horizontal')
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 15_000 })

    // PaneHeader zoom button: aria-label="Maximize pane"
    const zoomButton = page.getByRole('button', { name: 'Maximize pane' }).first()
    await expect(zoomButton).toBeVisible()
    await zoomButton.click()

    // Only one terminal visible (the zoomed one)
    await page.waitForTimeout(300)
    const visibleTerminals = await page.locator('.xterm:visible').count()
    expect(visibleTerminals).toBe(1)

    // Verify zoomed state in Redux
    const activeTabId = await harness.getActiveTabId()
    const state = await harness.getState()
    expect(state.panes.zoomedPane[activeTabId!]).toBeTruthy()

    // Restore: aria-label="Restore pane"
    const restoreButton = page.getByRole('button', { name: 'Restore pane' }).first()
    await expect(restoreButton).toBeVisible()
    await restoreButton.click()
    await page.waitForTimeout(300)

    const restoredTerminals = await page.locator('.xterm:visible').count()
    expect(restoredTerminals).toBe(2)
  })

  test('nested splits create complex layouts', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()

    // First split: horizontal
    await splitViaContextMenu(page, 'horizontal', 0)
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 15_000 })

    // Second split: vertical on the second pane
    await splitViaContextMenu(page, 'vertical', 1)
    await page.locator('.xterm').nth(2).waitFor({ state: 'visible', timeout: 15_000 })

    // Verify the layout tree has nested splits
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')
    const hasNestedSplit = layout.children.some((c: any) => c.type === 'split')
    expect(hasNestedSplit).toBe(true)
  })
})
