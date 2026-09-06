import { test, expect } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/**
 * HOST-STATS-PANE — React HostStatsPane e2e smoke
 * (docs/plans/2026-08-25-host-pressure-pane.md, Task 10 content block).
 *
 * Authored + standalone-committed in Task 7 with captured RED evidence: the
 * first test fails at the picker click because the 'Host Stats' picker option
 * does not exist until Task 7's GREEN phase lands (this is the only sequence
 * point where absence-RED is reachable). Task 10 registers this spec into
 * MATRIX_SPECS (test/e2e-browser/playwright.config.ts) and re-runs it GREEN
 * under BOTH legs (legacy-chromium + rust-chromium); Rust parity coverage is
 * therefore inherent — the refresh-resolve and em-dash placeholder contracts
 * are identical on both servers (degraded sections resolve with zero-shape).
 *
 * Selector notes: tile grouping is exposed via [data-host-stats-tile] /
 * [data-host-stats-value] data test contracts (permitted by the HARNESS-11
 * a11y-selector gate); interactive elements are addressed by role + name.
 */

type PaneNodeLike = {
  type: string
  content?: { kind?: string }
  children?: PaneNodeLike[]
}

function findLeafByKind(node: PaneNodeLike | null, kind: string): PaneNodeLike | null {
  if (!node) return null
  if (node.type === 'leaf') return node.content?.kind === kind ? node : null
  for (const child of node.children ?? []) {
    const hit = findLeafByKind(child, kind)
    if (hit) return hit
  }
  return null
}

test.describe('Host Stats pane', () => {
  async function openHostStatsPane(page: any) {
    await openPanePicker(page)
    const option = page.getByRole('button', { name: /^Host Stats$/ })
    await expect(option).toBeVisible({ timeout: 10_000 })
    await option.click()
    const section = page.getByRole('region', { name: 'Host stats' })
    await expect(section).toBeVisible({ timeout: 10_000 })
    return section
  }

  test('opens a Host Stats pane from the pane picker', async ({ freshellPage, page, harness }) => {
    await openHostStatsPane(page)

    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    const leaf = findLeafByKind(layout, 'host-stats')
    expect(leaf).not.toBeNull()
    expect(leaf?.content?.kind).toBe('host-stats')
  })

  test('renders verdict strip and live tiles from the subscription snapshot', async ({ freshellPage, page }) => {
    const section = await openHostStatsPane(page)

    // Verdict strip (distinct from the sr-only one-shot refresh announcer,
    // which is also role=status but never carries a verdict word).
    const verdictStrip = section
      .getByRole('status')
      .filter({ hasText: /ALL GOOD|ELEVATED|TROUBLE/ })
      .first()
    await expect(verdictStrip).toBeVisible({ timeout: 5_000 })
    expect((await verdictStrip.textContent())?.trim().length ?? 0).toBeGreaterThan(0)

    // CPU tile shows a measured percentage shortly after subscribe (the server
    // emits one snapshot immediately on the 0→1 subscribe transition).
    const cpuValue = section
      .locator('[data-host-stats-tile="cpu"]')
      .locator('[data-host-stats-value]')
    await expect(cpuValue).toHaveText(/\d+(\.\d+)?%/, { timeout: 5_000 })
  })

  test('on-request refresh resolves, re-enables the button, and updates the age label', async ({ freshellPage, page }) => {
    const section = await openHostStatsPane(page)

    const refreshButton = section.getByRole('button', { name: /refresh on-request measurements/i })
    await expect(refreshButton).toBeEnabled()
    await refreshButton.click()

    // (a) While awaiting the response the button shows the Collecting state.
    //     Always-true by design: the server-side refresh has a 300ms+ two-sample
    //     dwell, so the in-flight window is never zero-length.
    await expect(refreshButton).toBeDisabled()
    await expect(refreshButton).toContainText('Collecting…')

    // (b) The refresh always resolves (degraded sections still resolve with
    //     zero-shape, on both server implementations) and the button recovers.
    await expect(refreshButton).toBeEnabled({ timeout: 15_000 })
    await expect(refreshButton).toContainText('Refresh')

    // (c) The ON REQUEST age label reports the fresh measurement.
    await expect(section.getByText(/updated .*ago|just now/)).toBeVisible({ timeout: 5_000 })

    // Per-design fallback: the Disks tile value is a real percent OR the frozen
    // em-dash placeholder (gVisor/Cloud Run may lack the section) — never zeros.
    const diskValue = section
      .locator('[data-host-stats-tile="disks"]')
      .locator('[data-host-stats-value]')
      .first()
    await expect(diskValue).toHaveText(/\d+%|—/, { timeout: 5_000 })
  })

  test('live tiles survive a tab switch away and back', async ({ freshellPage, page, harness }) => {
    const section = await openHostStatsPane(page)
    const cpuValue = section
      .locator('[data-host-stats-tile="cpu"]')
      .locator('[data-host-stats-value]')
    await expect(cpuValue).toHaveText(/\d/, { timeout: 5_000 })

    // Switch to a new tab, then back to the first.
    await page.locator('[data-context="tab-add"]').click()
    await harness.waitForTabCount(2)
    await page.locator('[data-context="tab"]').first().click()

    const restored = page.getByRole('region', { name: 'Host stats' })
    await expect(restored).toBeVisible({ timeout: 5_000 })
    await expect(
      restored
        .locator('[data-host-stats-tile="cpu"]')
        .locator('[data-host-stats-value]'),
    ).toHaveText(/\d/, { timeout: 5_000 })

    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    expect(findLeafByKind(layout, 'host-stats')).not.toBeNull()
  })

  test('restores as host-stats after a full page reload', async ({ freshellPage, page, harness }) => {
    await openHostStatsPane(page)

    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()

    // paneTreeValidation must accept { kind: 'host-stats' } or the pane would
    // be dropped from the persisted layout on reload.
    const restored = page.getByRole('region', { name: 'Host stats' })
    await expect(restored).toBeVisible({ timeout: 10_000 })

    const activeTabId = await harness.getActiveTabId()
    const layout = await harness.getPaneLayout(activeTabId!)
    const leaf = findLeafByKind(layout, 'host-stats')
    expect(leaf).not.toBeNull()
    expect(leaf?.content?.kind).toBe('host-stats')
  })
})
