import type { Browser, BrowserContext, Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { TestHarness } from '../helpers/test-harness.js'
import {
  connectUnifiedPage,
  createNamedAgent,
  refreshHandle,
  sendFirstMessage,
  startFakeGemini,
  type NamedAgentHandle,
} from '../helpers/unified-agent-names.js'
import {
  bootJourney,
  resolveSessionId,
  type Journey,
} from '../helpers/unified-agent-names-modes.js'
import type { SessionNameRef } from '../../../shared/session-names.js'

// NAME RELIABILITY (plan Task 2, RC1) — the browser no longer sends its live
// tab and pane titles to the server as "legacy" name evidence. Before the
// fix every reload, every new window and every sibling-window layout write
// copied the current layout into a migration envelope and POSTed it to
// /api/session-names/import, where a session-owned tab's stored title (for
// example "Tab 6") replaced the session's saved name.
//
// Each case runs an OWNED Rust server (isolated HOME, ephemeral port) with
// the fake Claude CLI and a fake Gemini that answers 403, so no AI name ever
// lands and the saved name is the folder or first-message name. The
// server's record (name + revision) is the truth. One counter per browser
// context sees every page's import POSTs, attached before the first page
// navigates: the old client sent its import on the connection-ready edge of
// every boot, so a counter attached after a page connected would miss it.

test.setTimeout(360_000)

const IMPORT_PATH = '/api/session-names/import'
const FIRST_MESSAGE = 'Repair the sardine factory line'

type ImportCounter = {
  /** Every import POST the context's pages sent. */
  readonly count: number
  /** The import POSTs one page sent (across its reloads). */
  countFor(page: Page): number
}

/** Count `POST /api/session-names/import` requests from every page of
 * `context`. Call it before the context's first navigation. */
function countImportPosts(context: BrowserContext): ImportCounter {
  let total = 0
  const byPage = new Map<Page, number>()
  context.on('request', (request) => {
    if (request.method() !== 'POST') return
    let pathname: string
    try {
      pathname = new URL(request.url()).pathname
    } catch {
      return
    }
    if (pathname !== IMPORT_PATH) return
    total += 1
    let page: Page | null = null
    try {
      page = request.frame().page()
    } catch {
      // A service-worker request has no frame; it still counts in the total.
    }
    if (page) byPage.set(page, (byPage.get(page) ?? 0) + 1)
  })
  return {
    get count() { return total },
    countFor: (page) => byPage.get(page) ?? 0,
  }
}

/** A new browser context whose import POSTs are counted from its first
 * request, and its first connected page. */
async function connectCountedPage(
  browser: Browser,
  journey: Journey,
): Promise<{ context: BrowserContext; page: Page; harness: TestHarness; imports: ImportCounter }> {
  const context = await browser.newContext()
  const imports = countImportPosts(context)
  const { page, harness } = await connectUnifiedPage({ browser, info: journey.server.info, context })
  return { context, page, harness, imports }
}

async function bootForbiddenGeminiJourney(): Promise<Journey> {
  const gemini = await startFakeGemini('unused', {
    status: 403,
    body: { error: { code: 403, message: 'Permission denied.', status: 'PERMISSION_DENIED' } },
  })
  return bootJourney('claude', { gemini })
}

/** Create a Claude CLI pane through the picker, send its first message, and
 * return its durable naming ref once the session has materialized. */
async function createClaudeSession(
  journey: Journey,
  page: Page,
  harness: TestHarness,
): Promise<{ handle: NamedAgentHandle; ref: SessionNameRef; sessionId: string }> {
  let handle = await createNamedAgent(harness, 'claude', { entry: 'ui', page, server: journey.server })
  await sendFirstMessage(page, harness, handle, 'claude', FIRST_MESSAGE)
  handle = await refreshHandle(harness, handle, 'claude')
  const sessionId = await resolveSessionId(journey, handle)
  return { handle, sessionId, ref: { kind: 'session', provider: 'claude', sessionId } }
}

type NameRecord = { name: string; source: string; revision: number }

/** The server's saved record for `ref`, or null while none exists (a pane
 * can learn its session id before the server binds the name to it). A
 * rate-limited read (shared API bucket) is retried a bounded few times. */
async function readNameRecord(journey: Journey, ref: SessionNameRef): Promise<NameRecord | null> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${journey.server.info.baseUrl}/api/session-names/read`, {
      method: 'POST',
      headers: { 'x-auth-token': journey.server.info.token, 'content-type': 'application/json' },
      body: JSON.stringify({ refs: [ref] }),
    })
    if (response.ok) {
      const payload = await response.json() as { names: Array<{ record: NameRecord }> }
      const record = payload.names[0]?.record
      return record ? { name: record.name, source: record.source, revision: record.revision } : null
    }
    if (response.status !== 429 || attempt >= 5) {
      throw new Error(`session-names read failed (${response.status})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
}

/** Wait until the server holds a record for `ref` and it stops moving
 * (same name and revision across several sweep passes), then return it. */
async function settledRecord(journey: Journey, ref: SessionNameRef): Promise<NameRecord> {
  const stableForMs = 15_000
  // The pending-to-session bind can take a minute or two on a cold cloud
  // filesystem.
  const deadline = Date.now() + 240_000
  let last: NameRecord | null = null
  let stableSince = Date.now()
  while (Date.now() < deadline) {
    const next = await readNameRecord(journey, ref)
    if (!next || !last || next.name !== last.name || next.revision !== last.revision) {
      last = next
      stableSince = Date.now()
    } else if (Date.now() - stableSince >= stableForMs) {
      return last
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error(`the record for ${JSON.stringify(ref)} never settled (last: ${JSON.stringify(last)})`)
}

/** Reload a page and wait until its WebSocket is ready again. */
async function reloadAndConnect(page: Page): Promise<TestHarness> {
  await page.reload()
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

/** Open another window (same context, so shared localStorage and a fresh
 * sessionStorage window id) against the server. */
async function openWindow(context: BrowserContext, journey: Journey): Promise<{ page: Page; harness: TestHarness }> {
  const page = await context.newPage()
  await page.goto(`${journey.server.info.baseUrl}/?token=${journey.server.info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { page, harness }
}

/** Give a just-connected page the time in which the old client posted its
 * import (it fired on the connection-ready edge) and the server applied it. */
async function quietPeriod(page: Page): Promise<void> {
  await page.waitForTimeout(3_000)
}

/** The tab (in this page) that holds the session's pane: the same tab id
 * when the page kept it, else the tab whose pane carries the session or its
 * terminal. */
async function tabIdOfSession(harness: TestHarness, handle: NamedAgentHandle, sessionId: string): Promise<string> {
  let found: string | null = null
  await expect.poll(async () => {
    const state = await harness.getState() as {
      tabs?: { tabs?: Array<{ id: string }> }
      panes?: { layouts?: Record<string, unknown> }
    }
    const holds = (node: unknown): boolean => {
      if (!node || typeof node !== 'object') return false
      const n = node as {
        type?: string
        content?: { sessionRef?: { sessionId?: string }; terminalId?: string }
        children?: unknown[]
      }
      if (n.type === 'leaf') {
        return n.content?.sessionRef?.sessionId === sessionId
          || (handle.terminalId !== undefined && n.content?.terminalId === handle.terminalId)
      }
      return (n.children ?? []).some(holds)
    }
    const tabs = state.tabs?.tabs ?? []
    found = tabs.find((tab) => tab.id === handle.tabId)?.id
      ?? tabs.find((tab) => holds(state.panes?.layouts?.[tab.id]))?.id
      ?? null
    return found
  }, { timeout: 30_000 }).not.toBeNull()
  return found!
}

async function expectTabLabel(page: Page, tabId: string, name: string): Promise<void> {
  await expect(page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)).toContainText(name, { timeout: 30_000 })
}

test.describe('name import shutdown', () => {
  test('reload keeps the saved name and sends no import', async ({ browser }) => {
    const journey = await bootForbiddenGeminiJourney()
    try {
      const { context, page, harness, imports } = await connectCountedPage(browser, journey)
      const { handle, ref } = await createClaudeSession(journey, page, harness)
      const before = await settledRecord(journey, ref)
      await expectTabLabel(page, handle.tabId, before.name)

      await reloadAndConnect(page)
      await quietPeriod(page)

      expect(imports.count).toBe(0)
      expect(await readNameRecord(journey, ref)).toMatchObject(before)
      await expectTabLabel(page, handle.tabId, before.name)
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })

  test('a second window keeps the saved name', async ({ browser }) => {
    const journey = await bootForbiddenGeminiJourney()
    try {
      const { context, page, harness, imports } = await connectCountedPage(browser, journey)
      const { handle, ref, sessionId } = await createClaudeSession(journey, page, harness)
      const before = await settledRecord(journey, ref)
      await expectTabLabel(page, handle.tabId, before.name)

      // A new page in the same context: shared localStorage, a fresh
      // sessionStorage, so a new window id that rebuilds from the server.
      const second = await openWindow(context, journey)
      await quietPeriod(second.page)

      // Per window (the second one's boot included), then the whole context.
      expect([imports.countFor(page), imports.countFor(second.page)]).toEqual([0, 0])
      expect(imports.count).toBe(0)
      expect(await readNameRecord(journey, ref)).toMatchObject(before)
      await expectTabLabel(page, handle.tabId, before.name)
      await expectTabLabel(second.page, await tabIdOfSession(second.harness, handle, sessionId), before.name)
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })

  test('two windows with different stale tab titles never change the name', async ({ browser }) => {
    const journey = await bootForbiddenGeminiJourney()
    try {
      const { context, page, harness, imports } = await connectCountedPage(browser, journey)
      const { ref, sessionId } = await createClaudeSession(journey, page, harness)
      const before = await settledRecord(journey, ref)

      // Two per-window layout copies (as other windows of this device would
      // have saved them) whose session-owned tab carries a stale title:
      // the default "Tab 23" and a real-looking "ms-people-summit".
      const staleWindows = ['layout-window-stale-a', 'layout-window-stale-b']
      const staleTitles = ['Tab 23', 'ms-people-summit']
      await page.evaluate(({ sessionId, staleWindows, staleTitles }) => {
        const windowId = sessionStorage.getItem('freshell.layout-window-id.v1')
        const raw = windowId ? localStorage.getItem(`freshell.layout.v3.${windowId}`) : null
        if (!raw) throw new Error('the first window has not saved its layout yet')
        const holds = (node: any): boolean => node?.type === 'leaf'
          ? node.content?.sessionRef?.sessionId === sessionId
          : (node?.children ?? []).some(holds)
        staleWindows.forEach((staleWindow, index) => {
          const layout = JSON.parse(raw)
          const tab = layout.tabs.tabs.find((candidate: any) => holds(layout.panes.layouts[candidate.id]))
          if (!tab) throw new Error('the session tab is missing from the saved layout')
          tab.title = staleTitles[index]
          localStorage.setItem(`freshell.layout.v3.${staleWindow}`, JSON.stringify(layout))
        })
      }, { sessionId, staleWindows, staleTitles })

      // Each new page claims one of the stale window ids, so it loads that
      // window's layout (a reload keeps its claim through sessionStorage).
      await context.addInitScript(({ staleWindows }) => {
        try {
          if (sessionStorage.getItem('freshell.layout-window-id.v1')) return
          const claimKey = 'e2e.name-import-shutdown.claims'
          const claimed = Number(localStorage.getItem(claimKey) ?? '0')
          if (claimed >= staleWindows.length) return
          sessionStorage.setItem('freshell.layout-window-id.v1', staleWindows[claimed])
          localStorage.setItem(claimKey, String(claimed + 1))
        } catch {
          // Storage unavailable: the page mints its own window id.
        }
      }, { staleWindows })

      const windows = [await openWindow(context, journey), await openWindow(context, journey)]
      const perWindow = () => [page, ...windows.map((win) => win.page)].map((each) => imports.countFor(each))
      for (const win of windows) await quietPeriod(win.page)
      // Every window's first boot is counted, then every reload.
      expect(perWindow()).toEqual([0, 0, 0])
      expect(imports.count).toBe(0)
      expect(await readNameRecord(journey, ref)).toMatchObject(before)

      for (let round = 1; round <= 3; round += 1) {
        for (const win of windows) {
          await reloadAndConnect(win.page)
          await quietPeriod(win.page)
          expect(perWindow(), `reload round ${round}`).toEqual([0, 0, 0])
          expect(imports.count, `reload round ${round}`).toBe(0)
          expect(await readNameRecord(journey, ref), `reload round ${round}`).toMatchObject(before)
        }
      }
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })
})
