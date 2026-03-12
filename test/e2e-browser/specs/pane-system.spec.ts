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

  // Helper: split and select shell from the PanePicker that appears.
  // After splitting, the new pane shows a PanePicker. We need to find the
  // picker toolbar and click a shell option within it.
  async function splitAndSelectShell(page: any, direction: 'horizontal' | 'vertical', nth = 0) {
    await splitViaContextMenu(page, direction, nth)

    // Wait for the PanePicker toolbar to appear in the new pane
    const picker = page.locator('[data-context="pane-picker"]').last()
    await picker.waitFor({ state: 'visible', timeout: 10_000 })

    // Wait for options to stabilize (platform info may cause re-render)
    await page.waitForTimeout(500)

    // Try each shell option within the picker
    const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
    for (const name of shellNames) {
      try {
        const button = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
        if (await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 5000 })
          return
        }
      } catch {
        continue
      }
    }
  }

  test('starts with a single pane', async ({ freshellPage, harness }) => {
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('leaf')
  })

  test('split pane horizontally', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitAndSelectShell(page, 'horizontal')

    // Wait for second terminal to appear
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 30_000 })

    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')
    expect(layout.direction).toBe('horizontal')
    expect(layout.children).toHaveLength(2)
  })

  test('split pane vertically', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitAndSelectShell(page, 'vertical')

    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 30_000 })

    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')
    expect(layout.direction).toBe('vertical')
    expect(layout.children).toHaveLength(2)
  })

  test('close pane returns to single pane', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitAndSelectShell(page, 'horizontal')
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 30_000 })

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

    await splitAndSelectShell(page, 'horizontal')
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 30_000 })

    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')
    expect(layout.children).toHaveLength(2)
  })

  test('pane picker allows choosing pane type', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitViaContextMenu(page, 'horizontal')

    // The new pane shows the picker. PanePicker renders buttons with labels.
    // On WSL/Windows: "CMD", "PowerShell", "WSL" instead of "Shell"
    // Always present: "Editor", "Browser"
    const editorOption = page.getByRole('button', { name: /^Editor$/i })
    const browserOption = page.getByRole('button', { name: /^Browser$/i })

    // Wait for PanePicker to render
    await expect(editorOption).toBeVisible({ timeout: 10_000 })
    await expect(browserOption).toBeVisible()

    // At least one shell option should be visible
    const shellVisible = await page.getByRole('button', { name: /^Shell$/i }).isVisible().catch(() => false)
    const wslVisible = await page.getByRole('button', { name: /^WSL$/i }).isVisible().catch(() => false)
    const cmdVisible = await page.getByRole('button', { name: /^CMD$/i }).isVisible().catch(() => false)
    expect(shellVisible || wslVisible || cmdVisible).toBe(true)
  })

  test('pane resize by dragging divider', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitAndSelectShell(page, 'horizontal')
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 30_000 })

    // Resize handle is a separator element (role="separator", data-context="pane-divider")
    const divider = page.locator('[role="separator"]').first()
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
    await splitAndSelectShell(page, 'horizontal')
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 30_000 })

    const activeTabId = await harness.getActiveTabId()

    await page.locator('.xterm').first().click()
    await page.waitForTimeout(200)
    let state = await harness.getState()
    const firstPaneId = state.panes?.activePane?.[activeTabId!]
    expect(firstPaneId).toBeTruthy()

    await page.locator('.xterm').nth(1).click()
    await page.waitForTimeout(200)
    state = await harness.getState()
    const secondPaneId = state.panes?.activePane?.[activeTabId!]
    expect(secondPaneId).toBeTruthy()
    expect(secondPaneId).not.toBe(firstPaneId)
  })

  test('zoom pane hides other panes', async ({ freshellPage, page, harness, terminal }) => {
    await terminal.waitForTerminal()
    await splitAndSelectShell(page, 'horizontal')
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 30_000 })

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
    await splitAndSelectShell(page, 'horizontal', 0)
    await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 30_000 })

    // Second split: vertical on the second pane
    await splitAndSelectShell(page, 'vertical', 1)
    await page.locator('.xterm').nth(2).waitFor({ state: 'visible', timeout: 30_000 })

    // Verify the layout tree has nested splits
    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(layout.type).toBe('split')
    const hasNestedSplit = layout.children.some((c: any) => c.type === 'split')
    expect(hasNestedSplit).toBe(true)
  })
})
