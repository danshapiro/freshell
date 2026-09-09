import { test, expect } from '../helpers/fixtures.js'
import type { Page } from '@playwright/test'

async function setSidebarSearchLoading(page: Page, loading: boolean): Promise<void> {
  await page.evaluate((nextLoading) => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'sessions/setSessionWindowLoading',
      payload: {
        surface: 'sidebar',
        loading: nextLoading,
        loadingKind: nextLoading ? 'search' : undefined,
        query: 'test',
        searchTier: 'title',
      },
    })
  }, loading)
}

function measureVisibleInputContentWidth(element: HTMLInputElement): number {
  const row = element.parentElement
  if (!row) return 0
  const styles = getComputedStyle(element)
  const paddingLeft = parseFloat(styles.paddingLeft) || 0
  const paddingRight = parseFloat(styles.paddingRight) || 0
  const borderLeft = parseFloat(styles.borderLeftWidth) || 0
  const borderRight = parseFloat(styles.borderRightWidth) || 0
  const inputRect = element.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  const contentLeft = inputRect.left + paddingLeft + borderLeft
  const contentRight = inputRect.right - paddingRight - borderRight
  const visibleLeft = Math.max(contentLeft, rowRect.left)
  const visibleRight = Math.min(contentRight, rowRect.right)
  return Math.max(0, visibleRight - visibleLeft)
}

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

  test('sidebar reopen button stays fixed when overflowing tabs are scrolled', async ({ freshellPage, page }) => {
    // This test is single-row-specific: opt out of the multirow default explicitly.
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { multirowTabs: false } },
      })
    })

    await page.setViewportSize({ width: 900, height: 700 })
    await page.evaluate(() => {
      const harness = window.__FRESHELL_TEST_HARNESS__
      if (!harness) throw new Error('Freshell test harness is not installed')
      for (let i = 0; i < 18; i += 1) {
        harness.dispatch({
          type: 'tabs/addTab',
          payload: {
            id: `overflow-tab-${i}`,
            createRequestId: `overflow-tab-${i}`,
            title: `Overflow tab ${i}`,
            mode: 'shell',
            shell: 'system',
            status: 'running',
          },
        })
      }
    })
    await page.waitForFunction(() => (
      window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs?.length ?? 0
    ) >= 18)

    const collapseButton = page.getByRole('button', { name: /hide sidebar/i })
    await collapseButton.click()

    const showButton = page.getByRole('button', { name: /show sidebar/i })
    await expect(showButton).toBeVisible({ timeout: 3_000 })

    const tabBar = page.locator('[data-context="global"]').filter({
      has: page.getByRole('button', { name: /new shell tab/i }),
    }).first()
    const tabScroller = tabBar.locator('.overflow-x-auto').first()
    await expect(tabScroller).toBeVisible()
    await expect.poll(async () => tabScroller.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)

    const before = await showButton.boundingBox()
    expect(before).not.toBeNull()

    const scrollLeft = await tabScroller.evaluate((element) => {
      element.scrollLeft = element.scrollWidth
      element.dispatchEvent(new Event('scroll', { bubbles: true }))
      return element.scrollLeft
    })
    expect(scrollLeft).toBeGreaterThan(0)

    const after = await showButton.boundingBox()
    const scrollerBox = await tabScroller.boundingBox()
    expect(after).not.toBeNull()
    expect(scrollerBox).not.toBeNull()
    expect(after!.x).toBeCloseTo(before!.x, 0)
    expect(after!.x).toBeGreaterThanOrEqual(0)
    expect(after!.x + after!.width).toBeLessThanOrEqual(scrollerBox!.x)
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

  test('search input and controls remain visible and contained with pending search at high scale', async ({ freshellPage, page }) => {
    // terminalFontSize=32 → --ui-scale=2.0 (all rem-based sizes double).
    // sidebar=200px is the minimum (SIDEBAR_MIN_WIDTH). At scale 2.0 the
    // old pr-36 (9rem = 288px) exceeded the input width and collapsed the
    // text area to ~1 char. The flex layout must guarantee usable text space
    // even with the loading indicator and clear button visible.
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: {
          terminal: { fontSize: 32 },
          sidebar: { width: 200, collapsed: false },
        },
      })
    })

    await page.waitForFunction(() => {
      const scale = getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')
      return parseFloat(scale) >= 2.0
    })

    const searchInput = page.getByPlaceholder('Search...')
    await expect(searchInput).toBeVisible()

    // Measure the input's visible content width. This catches the original bug
    // where right padding consumed the text area while the input box stayed wide.
    const emptyWidth = await searchInput.evaluate(measureVisibleInputContentWidth)
    const inputFontSize = await searchInput.evaluate((el: HTMLInputElement) => {
      return parseFloat(getComputedStyle(el).fontSize)
    })
    expect(emptyWidth).toBeGreaterThan(inputFontSize)

    await searchInput.fill('test')
    await setSidebarSearchLoading(page, true)

    // Assert the loading indicator is visible (search is pending).
    const loadingIndicator = page.getByTestId('search-loading')
    await expect(loadingIndicator).toBeVisible({ timeout: 3_000 })

    // At 200px sidebar with px-based padding, the row is ~176px, which
    // activates the container query. Verify the loading text is visually
    // hidden but remains accessible.
    const loadingTextStyles = await loadingIndicator.evaluate((el) => {
      const text = el.querySelector('.sidebar-search-loading-text')
      if (!text) return null
      const cs = getComputedStyle(text)
      return {
        position: cs.position,
        width: cs.width,
        clip: cs.clip,
      }
    })
    expect(loadingTextStyles).not.toBeNull()
    expect(loadingTextStyles!.position).toBe('absolute')
    expect(loadingTextStyles!.width).toBe('1px')

    // Scope this assertion because dnd-kit mounts another role="status".
    await expect(loadingIndicator).toHaveAttribute('role', 'status')
    const a11ySnapshot = await loadingIndicator.ariaSnapshot()
    expect(a11ySnapshot).toContain('Searching')

    const pendingWidth = await searchInput.evaluate(measureVisibleInputContentWidth)
    expect(pendingWidth).toBeGreaterThan(inputFontSize)

    const clearButton = page.getByRole('button', { name: /clear search/i })
    await expect(clearButton).toBeVisible()
    const rowBox = await searchInput.evaluate((el: HTMLInputElement) => {
      const row = el.parentElement
      if (!row) return null
      const rect = row.getBoundingClientRect()
      return { left: rect.left, right: rect.right }
    })
    const clearBox = await clearButton.boundingBox()
    expect(rowBox).not.toBeNull()
    expect(clearBox).not.toBeNull()
    expect(clearBox!.x + clearBox!.width).toBeLessThanOrEqual(rowBox!.right + 1)

    await setSidebarSearchLoading(page, false)
    await expect(loadingIndicator).not.toBeVisible({ timeout: 5_000 })
    await expect(searchInput).toHaveAttribute('aria-busy', 'false')

    // After loading completes, the input content width should still be usable.
    const settledWidth = await searchInput.evaluate(measureVisibleInputContentWidth)
    expect(settledWidth).toBeGreaterThan(inputFontSize)
  })

  test('search input keeps usable width at high scale with default sidebar (above container query cutoff)', async ({ freshellPage, page }) => {
    // At scale 2.0 with 288px sidebar, the row is ~264px and has room for the
    // full loading label while retaining usable input space.
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: {
          terminal: { fontSize: 32 },
          sidebar: { width: 288, collapsed: false },
        },
      })
    })

    await page.waitForFunction(() => {
      const scale = getComputedStyle(document.documentElement).getPropertyValue('--ui-scale')
      return parseFloat(scale) >= 2.0
    })

    const searchInput = page.getByPlaceholder('Search...')
    const inputFontSize = await searchInput.evaluate((el: HTMLInputElement) => {
      return parseFloat(getComputedStyle(el).fontSize)
    })

    await searchInput.fill('test')
    await setSidebarSearchLoading(page, true)

    const loadingIndicator = page.getByTestId('search-loading')
    await expect(loadingIndicator).toBeVisible({ timeout: 3_000 })

    const loadingText = loadingIndicator.locator('.sidebar-search-loading-text')
    await expect(loadingText).toBeVisible()
    const loadingTextWidths = await loadingText.evaluate((el) => ({
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }))
    expect(loadingTextWidths.clientWidth).toBeGreaterThan(10)
    expect(loadingTextWidths.scrollWidth).toBeLessThanOrEqual(loadingTextWidths.clientWidth + 1)

    const pendingWidth = await searchInput.evaluate(measureVisibleInputContentWidth)
    expect(pendingWidth).toBeGreaterThan(inputFontSize)
  })

  test('search row contains the full mobile clear-button touch target', async ({ freshellPage, page }) => {
    // On mobile, the search row itself must contain the clear button's full
    // 44px touch target; relying on overflow makes the outer edges untappable.
    await page.setViewportSize({ width: 400, height: 700 })

    // On mobile, the sidebar auto-collapses; open it first
    const showButton = page.getByRole('button', { name: /show sidebar/i })
    await expect(showButton).toBeVisible({ timeout: 5_000 })
    await showButton.click()
    await page.waitForTimeout(300)

    const searchInput = page.getByPlaceholder('Search...')
    await expect(searchInput).toBeVisible({ timeout: 3_000 })
    await searchInput.fill('test')
    await page.waitForTimeout(200)

    const clearButton = page.getByRole('button', { name: /clear search/i })
    await expect(clearButton).toBeVisible()

    // The button's layout height should be at least 44px (min-h-[44px]).
    const buttonHeight = await clearButton.evaluate((el: HTMLButtonElement) => {
      return el.getBoundingClientRect().height
    })
    expect(buttonHeight).toBeGreaterThanOrEqual(44)

    // The button's layout width should also be at least 44px (min-w-[44px]).
    const buttonWidth = await clearButton.evaluate((el: HTMLButtonElement) => {
      return el.getBoundingClientRect().width
    })
    expect(buttonWidth).toBeGreaterThanOrEqual(44)

    const rowBox = await searchInput.evaluate((el: HTMLInputElement) => {
      const row = el.parentElement
      if (!row) return null
      const rect = row.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, height: rect.height }
    })
    const buttonBox = await clearButton.boundingBox()
    expect(rowBox).not.toBeNull()
    expect(buttonBox).not.toBeNull()
    expect(rowBox!.height).toBeGreaterThanOrEqual(44)
    expect(buttonBox!.y).toBeGreaterThanOrEqual(rowBox!.top)
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(rowBox!.bottom)

    // Click the formerly clipped top edge, not Playwright's default center.
    await page.mouse.click(buttonBox!.x + buttonBox!.width / 2, buttonBox!.y + 2)
    await expect(searchInput).toHaveValue('')

    // The input itself should fill the row height on mobile so the entire
    // row is tappable (not just the input's intrinsic font-size height).
    await searchInput.fill('test')
    const inputHeight = await searchInput.evaluate((el: HTMLInputElement) => {
      return el.getBoundingClientRect().height
    })
    expect(inputHeight).toBeGreaterThanOrEqual(40)
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
