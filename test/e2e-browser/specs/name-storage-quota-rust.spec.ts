import fs from 'node:fs/promises'
import path from 'node:path'
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
//
// A capture that fails on quota is logged as `legacy_name_capture_failed`.
// The capture runs before the client starts forwarding its logs, so the
// client replays that error once forwarding is on; the second case checks
// the error lands in the server's own log.

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

const LEGACY_LAYOUT_KEY = 'freshell.layout.v3'

/** A genuine pre-names legacy layout (no saved-name fields), so the boot
 * capture copies it. */
function legacyShellLayout(): string {
  return JSON.stringify({
    version: 4,
    persistedAt: 1,
    tabs: { activeTabId: 'legacy-tab', tabs: [{ id: 'legacy-tab', title: 'Legacy shell' }] },
    panes: {
      version: 7,
      layouts: { 'legacy-tab': { type: 'leaf', id: 'legacy-pane', content: { kind: 'terminal', mode: 'shell', createRequestId: 'legacy-req' } } },
      paneTitles: {},
      paneTitleSetByUser: {},
    },
  })
}

/** Runs in the page before any app script: seeds the genuine legacy layout
 * once, and makes every migration-envelope write fail as a full storage
 * does (every other write still succeeds). */
function failEnvelopeWrites(opts: { origin: string; prefix: string; legacyKey: string; legacyRaw: string }): void {
  if (window.location.origin !== opts.origin) return
  if (localStorage.getItem(opts.legacyKey) === null) localStorage.setItem(opts.legacyKey, opts.legacyRaw)
  const realSetItem = Storage.prototype.setItem
  Storage.prototype.setItem = function setItem(this: Storage, key: string, value: string): void {
    if (key.startsWith(opts.prefix)) {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    }
    realSetItem.call(this, key, value)
  }
}

/** Every browser log entry the server accepted from `/api/logs/client`,
 * as that entry's arguments: the server writes each one to its JSONL log
 * (`rust-server.jsonl`) as a `client_log` event whose `args` field holds
 * the arguments as JSON text. */
async function serverClientLogArgs(logsDir: string): Promise<unknown[][]> {
  const raw = await fs.readFile(path.join(logsDir, 'rust-server.jsonl'), 'utf8').catch(() => '')
  const entries: unknown[][] = []
  for (const line of raw.split('\n')) {
    if (!line.includes('client_log')) continue
    try {
      const event = JSON.parse(line) as { event?: unknown; args?: unknown }
      if (event.event !== 'client_log') continue
      const args = typeof event.args === 'string' ? JSON.parse(event.args) as unknown : event.args
      if (Array.isArray(args)) entries.push(args)
    } catch {
      // A line still being written.
    }
  }
  return entries
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

  test('a boot capture that fails on quota reports its error to the server log', async ({ browser }) => {
    const server = await bootUnifiedNamesServer()
    try {
      const context = await browser.newContext()
      await context.addInitScript(failEnvelopeWrites, {
        origin: new URL(server.info.baseUrl).origin,
        prefix: MIGRATION_PREFIX,
        legacyKey: LEGACY_LAYOUT_KEY,
        legacyRaw: legacyShellLayout(),
      })
      // The failed capture blocks nothing: the page boots and connects. (No
      // terminal is created here, so the picker bootstrap is skipped.)
      const { page } = await connectUnifiedPage({ browser, info: server.info, context, skipPicker: true })

      // The browser forwards its log entries in order, so once a marker
      // logged now is in the server log, everything the boot replayed is too.
      const marker = `e2e-forwarding-marker-${Date.now()}`
      await page.evaluate((text) => console.warn(text), marker)
      await expect.poll(async () => (
        (await serverClientLogArgs(server.info.logsDir)).some((args) => args.includes(marker))
      ), { message: 'the forwarding marker never reached the server log', timeout: 30_000 }).toBe(true)

      const captureEntries = (await serverClientLogArgs(server.info.logsDir))
        .filter((args) => args.some((arg) => typeof arg === 'string' && arg.includes('LegacyNameCapture')))
      const failures = captureEntries
        .filter((args) => args.includes('legacy_name_capture_failed'))
        .flatMap((args) => args.filter((arg) => typeof arg === 'object' && arg !== null))
      expect(failures, `capture entries in the server log: ${JSON.stringify(captureEntries)}`)
        .toContainEqual({ storageKey: LEGACY_LAYOUT_KEY, reason: 'QuotaExceededError', replayed: true })
      expect(await migrationKeys(page)).toEqual([])
      await context.close()
    } finally {
      await server.stop()
    }
  })
})
