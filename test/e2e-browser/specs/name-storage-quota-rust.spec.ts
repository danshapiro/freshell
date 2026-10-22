import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { TestHarness } from '../helpers/test-harness.js'
import {
  bootUnifiedNamesServer,
  connectUnifiedPage,
  renameThroughTabEdit,
} from '../helpers/unified-agent-names.js'

// NAME RELIABILITY (plan Task 2, RC10) — a browser whose storage is nearly
// full of old name-migration copies must still save layouts. Before the fix
// those copies were never deleted, and once a new copy could not be written
// the layout save itself was deferred, so a rename was lost on reload.
//
// Every page load here starts with the origin's localStorage full: an init
// script (re)writes 20 stale migration envelopes and acknowledgment markers,
// then fills the rest of the quota, leaving only a little room. The client
// must delete the stale copies, never block the layout save, and keep a
// renamed shell tab's name across reloads.

test.setTimeout(240_000)

const MIGRATION_PREFIX = 'freshell.session-names.migration.v1.'
/** Room left after the fill: enough for the boot's machine-id writes, far
 * less than one layout copy. */
const FREE_CHARS_AFTER_FILL = 1_024
/** The fill gives up past this many characters (an unbounded storage would
 * make this spec meaningless, and the test then fails on the capacity
 * check). */
const MAX_FILL_CHARS = 1 << 25

/** Runs in the page before any app script, on every navigation. */
function fillStorageWithStaleEnvelopes(opts: {
  origin: string
  prefix: string
  freeChars: number
  maxChars: number
}): void {
  if (window.location.origin !== opts.origin) return
  // Drop the previous load's filler first so the stale copies fit again.
  const fillerKey = 'e2e.storage-quota.filler'
  localStorage.removeItem(fillerKey)
  const shellLayout = (padding: string) => JSON.stringify({
    version: 4,
    persistedAt: 1,
    tabs: { activeTabId: 'old-tab', tabs: [{ id: 'old-tab', title: 'Old shell' }] },
    panes: {
      version: 7,
      layouts: { 'old-tab': { type: 'leaf', id: 'old-pane', content: { kind: 'terminal', mode: 'shell', createRequestId: 'old-req' } } },
      paneTitles: {},
      paneTitleSetByUser: {},
      padding,
    },
  })
  const padding = 'p'.repeat(40_000)
  for (let index = 0; index < 20; index += 1) {
    const importId = `stale-envelope-${index}`
    localStorage.setItem(`${opts.prefix}${importId}`, JSON.stringify({
      version: 1,
      importId,
      // Copies of other windows' live layouts, as the old client made them.
      storageKey: `freshell.layout.v3.layout-window-old-${index}`,
      raw: shellLayout(padding),
      capturedAt: 1,
    }))
    if (index % 2 === 0) localStorage.setItem(`${opts.prefix}ack.${importId}`, '1')
  }
  // Fill the remaining quota: find the largest filler that fits, then leave
  // `freeChars` of room.
  const fits = (length: number): boolean => {
    try {
      localStorage.setItem(fillerKey, 'f'.repeat(length))
      return true
    } catch {
      return false
    }
  }
  let low = 0
  let high = 1 << 16
  while (high <= opts.maxChars && fits(high)) {
    low = high
    high *= 2
  }
  while (high - low > 64) {
    const middle = Math.floor((low + high) / 2)
    if (fits(middle)) low = middle
    else high = middle
  }
  localStorage.removeItem(fillerKey)
  localStorage.setItem(fillerKey, 'f'.repeat(Math.max(0, low - opts.freeChars)))
  // The measured room, so the test can prove the quota was really reached.
  sessionStorage.setItem('e2e.storage-quota.capacity', String(low))
}

async function persistedTabTitle(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const windowId = sessionStorage.getItem('freshell.layout-window-id.v1')
    const raw = windowId ? localStorage.getItem(`freshell.layout.v3.${windowId}`) : null
    if (!raw) return null
    try {
      const layout = JSON.parse(raw) as { tabs?: { tabs?: Array<{ id: string; title?: string }> } }
      return layout.tabs?.tabs?.find((tab) => tab.id === id)?.title ?? null
    } catch {
      return null
    }
  }, tabId)
}

async function migrationKeys(page: Page): Promise<string[]> {
  return page.evaluate((prefix) => {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key?.startsWith(prefix)) keys.push(key)
    }
    return keys
  }, MIGRATION_PREFIX)
}

async function renameAndExpectSaved(page: Page, tabId: string, name: string): Promise<void> {
  await renameThroughTabEdit(page, tabId, name)
  await expect.poll(() => persistedTabTitle(page, tabId), {
    message: `the renamed tab "${name}" was never saved to the layout`,
    timeout: 15_000,
  }).toBe(name)
}

async function reloadAndExpectName(page: Page, tabId: string, name: string): Promise<void> {
  await page.reload()
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  await expect(page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)).toContainText(name, { timeout: 20_000 })
}

test.describe('name storage quota', () => {
  test('a nearly full storage never blocks saving a renamed shell tab, and stale migration copies are deleted', async ({ browser }) => {
    const server = await bootUnifiedNamesServer()
    try {
      const context = await browser.newContext()
      // Registered before the machine-identity script, so it runs first.
      await context.addInitScript(fillStorageWithStaleEnvelopes, {
        origin: new URL(server.info.baseUrl).origin,
        prefix: MIGRATION_PREFIX,
        freeChars: FREE_CHARS_AFTER_FILL,
        maxChars: MAX_FILL_CHARS,
      })
      const { page, harness } = await connectUnifiedPage({ browser, info: server.info, context })
      const tabId = (await harness.getActiveTabId())!
      expect(tabId).toBeTruthy()
      // The fill really reached the browser's quota.
      const capacity = Number(await page.evaluate(() => sessionStorage.getItem('e2e.storage-quota.capacity')))
      expect(capacity).toBeGreaterThan(0)
      expect(capacity).toBeLessThan(MAX_FILL_CHARS)

      await renameAndExpectSaved(page, tabId, 'Quota Survivor')
      expect(await migrationKeys(page)).toEqual([])

      await reloadAndExpectName(page, tabId, 'Quota Survivor')
      expect(await migrationKeys(page)).toEqual([])

      // A second rename after a boot that started full again.
      await renameAndExpectSaved(page, tabId, 'Quota Survivor Two')
      await reloadAndExpectName(page, tabId, 'Quota Survivor Two')
      expect(await migrationKeys(page)).toEqual([])
      await context.close()
    } finally {
      await server.stop()
    }
  })
})
