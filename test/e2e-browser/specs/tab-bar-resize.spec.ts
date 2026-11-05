import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'

/** Populate only the tab-strip geometry. Opening 19 real tabs one at a time
 * repeatedly mounts pickers and makes unrelated setup dominate this resize
 * test under load. Inactive picker tabs need no terminal or provider I/O. */
async function seedResizeTabs(page: Page, count: number): Promise<void> {
  await page.evaluate((total) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    if (!harness) throw new Error('Freshell test harness is unavailable')
    const initialCount = harness.getState().tabs.tabs.length
    for (let i = initialCount; i < total; i++) {
      const tabId = `resize-fixture-tab-${i}`
      harness.dispatch({
        type: 'tabs/addTab',
        payload: { id: tabId, title: `Resize tab ${i + 1}`, activate: false },
      })
      harness.dispatch({
        type: 'panes/initLayout',
        payload: { tabId, paneId: `resize-fixture-pane-${i}`, content: { kind: 'picker' } },
      })
    }
  }, count)
}

test.describe('Tab bar height resize', () => {
  test('defaults to 3 visible rows and drags to reveal more', async ({ freshellPage: page, harness }) => {
    // Create enough tabs to wrap into 3+ rows at any desktop viewport width
    // (20 tabs x >=150px basis is >= 3000px of tabs).
    await seedResizeTabs(page, 20)
    await harness.waitForTabCount(20)

    const tabStrip = page.getByTestId('tab-strip')
    await expect(tabStrip).toHaveClass(/flex-wrap/)
    // Default: exactly 3 rows visible — calc(6.25rem + 1px) = 101px at the default --ui-scale of 1.
    await expect(tabStrip).toHaveCSS('max-height', '101px')

    const handle = page.getByRole('separator', { name: 'Resize tab bar height' })
    await expect(handle).toBeVisible()

    const box = await handle.boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX, startY + 68, { steps: 4 }) // +2 rows at the default scale (row pitch 34px)
    await page.mouse.up()

    // 5 rows: calc(10.5rem + 1px) = 169px at the default scale.
    await expect(tabStrip).toHaveCSS('max-height', '169px')
  })

  test('keyboard arrows resize one row at a time (fewer than default)', async ({ freshellPage: page, harness }) => {
    await seedResizeTabs(page, 10)
    await harness.waitForTabCount(10)

    const tabStrip = page.getByTestId('tab-strip')
    await expect(tabStrip).toHaveCSS('max-height', '101px')

    const handle = page.getByRole('separator', { name: 'Resize tab bar height' })
    await expect(handle).toBeVisible()
    await handle.focus()
    await page.keyboard.press('ArrowUp')

    // 2 rows: calc(4.125rem + 1px) = 67px at the default scale.
    await expect(tabStrip).toHaveCSS('max-height', '67px')
  })

  test('persists the chosen row count across reloads', async ({ freshellPage: page }) => {
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { tabBarRows: 5 } },
      })
    })
    await expect(page.getByTestId('tab-strip')).toHaveCSS('max-height', '169px')

    // The browser-preferences middleware flushes on pagehide, so a reload persists it.
    await page.reload()
    await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('tab-strip')).toHaveCSS('max-height', '169px')
  })

  test('hides the resize handle when tabs fit in a single row', async ({ freshellPage: page }) => {
    await expect(page.getByTestId('tab-strip')).toBeVisible()
    await expect(page.getByTestId('tab-bar-resize-handle')).toHaveCount(0)
  })

  test('row heights track the UI scale (rem-based max-height)', async ({ freshellPage: page }) => {
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { uiScale: 1.25 },
      })
    })
    // --ui-scale becomes 1.25 => root font-size 20px => 3 rows = calc(6.25rem + 1px) = 126px.
    await expect(page.getByTestId('tab-strip')).toHaveCSS('max-height', '126px')
  })
})
