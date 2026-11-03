import { createFreshE2ePage, test, expect } from '../helpers/fixtures.js'
import { ensureRustServerBuilt, RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'

/**
 * LOCAL-FIRST RELOAD (the-usual/pane-title-recovery, Choice B):
 *
 * 1. A reload of a window whose local layout is HEALTHY keeps the local
 *    workspace exactly — tab ids, order, titles, pane titles, active tab —
 *    with no server-side rebuild (no re-minting).
 * 2. A reload after the local envelope is CORRUPTED rebuilds from the
 *    machine-bootstrap inventory, which (upgrade 1) includes the window's
 *    own last pushed snapshot with PRESERVED tab and pane ids.
 * 3. Cross-window pane-title hydration is TITLE-ONLY (e3r1 finding 4):
 *    page1's flush delivers its NEWER pane titles to page2's matching
 *    panes over the real storage-event path, while page2's tab arrangement
 *    stays strictly its own (no tab/tree adoption — the divergence pin);
 *    an older staged envelope does not clobber newer local titles, and a
 *    user-set title survives everything. The received titles are also
 *    DURABLE (e3r3 finding 1): the receiver writes them into its OWN
 *    envelope, so a reload of the healthy receiver boots WITH them.
 *
 * Cloud-runnable by construction: editor panes (no PTY, no CLI binaries),
 * owned fresh RustServer (fresh FRESHELL_HOME auto-creates the machine —
 * never the chooser), explicit tab/pane ids dispatched through the harness.
 */
test.describe('local-first machine workspace', () => {
  test.describe.configure({ mode: 'default' })

  let server: RustServer
  let serverInfo: Awaited<ReturnType<RustServer['start']>>

  test.beforeAll(async () => {
    test.setTimeout(600_000) // first release build of freshell-server can take minutes
    ensureRustServerBuilt()
    server = new RustServer()
    serverInfo = await server.start()
  })
  test.afterAll(async () => { await server?.stop() })

  // Mango's pane title is automatic and Apple's is user-set. Rebuilds keep
  // the user flag (name reliability, Task 9), so Scenario 3's cross-window
  // step needs a pane whose title is automatic from the start (mango): a
  // user-set pane never takes an automatic title.
  const TABS = [
    { id: 'tab-mango', title: 'Mango', file: '/tmp/mango.md', pane: 'tab-mango-pane', paneTitle: 'Mango notes', userSet: false },
    { id: 'tab-apple', title: 'Apple', file: '/tmp/apple.md', pane: 'tab-apple-pane', paneTitle: 'Apple notes', userSet: true },
  ]

  /** Wait for this client's newest durable generation to contain the
   * complete intended open workspace. A count can match an intermediate
   * push (auto-tab plus Mango), and closed historical inventory must not
   * count as an extra open tab. Keep the existing 30 s bound and poll rate. */
  async function waitForNewestGenerationWorkspace(
    clientInstanceId: string,
    expectedTabs: typeof TABS,
    timeoutMs = 30_000,
  ): Promise<void> {
    const snapshotsDir = path.join(serverInfo.homeDir, '.freshell', 'tabs-snapshots')
    const expected = expectedTabs.map((tab) => ({
      tabId: tab.id,
      // A single pane's override title is the registry's displayed tab name.
      tabName: tab.paneTitle,
      panes: [{
        paneId: tab.pane,
        kind: 'editor',
        title: tab.paneTitle,
        titleSetByUser: tab.userSet,
        filePath: tab.file,
      }],
    })).sort((a, b) => a.tabId.localeCompare(b.tabId))
    const projectOpenWorkspace = (records: any[]) => records
      .filter((record) => record?.status === 'open')
      .map((record) => ({
        tabId: record.tabId,
        tabName: record.tabName,
        panes: (Array.isArray(record.panes) ? record.panes : []).map((pane: any) => ({
          paneId: pane.paneId,
          kind: pane.kind,
          title: pane.title,
          titleSetByUser: pane.titleSetByUser === true,
          filePath: pane.payload?.filePath,
        })).sort((a: any, b: any) => String(a.paneId).localeCompare(String(b.paneId))),
      }))
      .sort((a, b) => String(a.tabId).localeCompare(String(b.tabId)))
    const deadline = Date.now() + timeoutMs
    let lastObserved: unknown = null
    while (Date.now() < deadline) {
      let newest: { revision: number; capturedAt: number; records: any[] } | null = null
      const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
      for (const device of devices) {
        const deviceDir = path.join(snapshotsDir, device)
        const files = (await fs.readdir(deviceDir).catch(() => [] as string[]))
          .filter((f) => f.endsWith('.json'))
        for (const f of files) {
          const raw = await fs.readFile(path.join(deviceDir, f), 'utf8').catch(() => '')
          let doc: any = null
          try { doc = JSON.parse(raw) } catch { continue }
          if (doc?.clientInstanceId !== clientInstanceId) continue
          const revision = Number(doc?.snapshotRevision ?? 0)
          const capturedAt = Number(doc?.capturedAt ?? 0)
          if (!newest || revision > newest.revision || (revision === newest.revision && capturedAt > newest.capturedAt)) {
            newest = { revision, capturedAt, records: Array.isArray(doc.records) ? doc.records : [] }
          }
        }
      }
      if (newest) {
        const workspace = projectOpenWorkspace(newest.records)
        lastObserved = { revision: newest.revision, capturedAt: newest.capturedAt, workspace }
        if (JSON.stringify(workspace) === JSON.stringify(expected)) return
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(
      `No newest persisted generation for client ${clientInstanceId} matched the expected open workspace `
      + `within ${timeoutMs}ms (last observed: ${JSON.stringify(lastObserved)})`,
    )
  }

  test('reload keeps a healthy local workspace exactly; corrupt envelope rebuilds from own snapshot with preserved ids', async ({ page }) => {
    // NO addInitScript at all: a fresh Playwright context starts with EMPTY
    // storage, so there is nothing to clear — and any init script (even a
    // once-guarded clear) cannot survive a reload (each reload is a new
    // document), so it would run on every load and mint a fresh
    // clientInstanceId, letting Scenario 2 pass even if the
    // machine-bootstrap prefix regressed (the LB-08 false green). With no
    // init script the natural reload PRESERVES the clientInstanceId, which
    // makes the `machine-bootstrap:` prefix load-bearing for Scenario 2.
    // LB-07: `connect` is donor-spec-local — navigate directly instead.
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await page.waitForLoadState('load')
    await page.waitForTimeout(500)
    await harness.waitForHarness()
    await harness.waitForConnection()

    // Fresh home auto-created a machine AND an auto shell tab. Remove it
    // AFTER our own tabs exist: the App's ensure-at-least-one-tab effect
    // (App.tsx:1889) re-creates a tab whenever tabs.length hits 0, so
    // removing it first would mint a replacement auto tab (three tabs total
    // in the workspace and the envelope). tabs/removeTab takes the BARE
    // tab-id string (tabsSlice.ts:354-355, PayloadAction<string>) — not an
    // { id } object.
    await harness.waitForTabCount(1)
    const autoTabId = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs?.[0]?.id)

    for (const t of TABS) {
      await page.evaluate((t) => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: t.id, title: t.title } })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: t.id, paneId: t.pane,
            content: { kind: 'editor', filePath: t.file, language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true },
          },
        })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'panes/updatePaneTitle', payload: { tabId: t.id, paneId: t.pane, title: t.paneTitle, setByUser: t.userSet } })
      }, t)
    }
    await page.evaluate((id) => window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/setActiveTab', payload: id }), 'tab-mango')
    await page.evaluate((autoId) => {
      // Mirror the real close path: the closeTab thunk (tabsSlice.ts:703)
      // removes the tab AND its layout (panesSlice removeLayout clears
      // layouts/activePane/paneTitles for the tab). A bare tabs/removeTab
      // would leave an orphaned panes layout for the removed tab in the
      // flushed envelope — which the layout-health classifier correctly
      // flags corrupt, forcing the rebuild this scenario must NOT take.
      // tabs/removeTab takes the BARE tab-id string (tabsSlice.ts:354-355,
      // PayloadAction<string>) — not an { id } object.
      if (!autoId) return
      window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/removeTab', payload: autoId })
      window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'panes/removeLayout', payload: { tabId: autoId } })
    }, autoTabId)

    // Wait until the registry pushed generations AND the persisted envelope
    // carries the stamp + both tabs (fs-poll generation files under the
    // server home; localStorage poll for the page's per-window layout key).
    // The page's
    // clientInstanceId lives in sessionStorage (storage-keys.ts:20 — the
    // natural reload preserves it, which is what makes the
    // `machine-bootstrap:` prefix load-bearing in Scenario 2).
    const clientInstanceId = await page.evaluate(() => sessionStorage.getItem('freshell.tabs.client-instance-id.v1'))
    await waitForNewestGenerationWorkspace(clientInstanceId, TABS)
    await waitForPersistedEnvelope(page, (env) =>
      typeof env.machineId === 'string' && env.machineId.length > 0 && env.tabs?.tabs?.length === 2)

    // ── Scenario 1: healthy reload keeps everything ────────────────
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    const kept = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState())
    expect(kept.tabs.tabs.map((t: { id: string }) => t.id)).toEqual(['tab-mango', 'tab-apple'])
    expect(kept.tabs.tabs.map((t: { title: string }) => t.title)).toEqual(['Mango', 'Apple'])
    expect(kept.tabs.activeTabId).toBe('tab-mango')
    expect(kept.panes.paneTitles['tab-mango']['tab-mango-pane']).toBe('Mango notes')
    expect(kept.panes.paneTitles['tab-apple']['tab-apple-pane']).toBe('Apple notes')
    expect(kept.panes.paneTitleSetByUser['tab-apple']['tab-apple-pane']).toBe(true)
    expect(kept.panes.paneTitleSetByUser['tab-mango']?.['tab-mango-pane']).toBeFalsy()
    expect(JSON.stringify(kept.panes.layouts['tab-mango'])).toContain('tab-mango-pane')

    // ── Scenario 2: corrupt envelope → bootstrap rebuild, ids preserved ──
    // The corruption must land in storage at teardown, AFTER the live
    // page's own persist middleware flushes its healthy in-memory state:
    // the debounced flush and the pagehide/beforeunload flushNow both
    // rewrite the page's per-window layout key
    // (freshell.layout.v3.<layoutWindowId>), so corrupting from a live
    // page is always overwritten before the next boot reads it. Listeners
    // registered here run AFTER the middleware's own (attached at module
    // init), so the keys are corrupted last and no further write can
    // preceding the next boot. Both the primary envelope AND the window's
    // per-window fresh-agent backup key must go:
    // readRecoverablePersistedLayoutRaw (persistedState.ts) heals a
    // primary that does not parse from the backup, which every boot's
    // migration keeps fresh. The sessionStorage layout-window-id survives
    // the reload, so the derived key is stable across it.
    await page.evaluate(() => {
      const corrupt = () => {
        const layoutKey = `freshell.layout.v3.${sessionStorage.getItem('freshell.layout-window-id.v1')}`
        localStorage.setItem(layoutKey, '{corrupted-by-e2e')
        localStorage.setItem(`${layoutKey}.backup-before-fresh-agent-centralization`, '{corrupted-by-e2e')
      }
      window.addEventListener('beforeunload', corrupt)
      window.addEventListener('pagehide', corrupt)
    })
    await page.reload()
    await harness.waitForHarness()
    await harness.waitForConnection()
    const rebuilt = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState())
    expect(rebuilt.tabs.tabs.map((t: { id: string }) => t.id).sort()).toEqual(['tab-apple', 'tab-mango'])
    expect(rebuilt.tabs.tabs.map((t: { title: string }) => t.title).sort()).toEqual(['Apple notes', 'Mango notes'])
    expect(JSON.stringify(rebuilt.panes.layouts['tab-mango'])).toContain('tab-mango-pane')
    expect(JSON.stringify(rebuilt.panes.layouts['tab-apple'])).toContain('tab-apple-pane')
    // Name reliability (Task 9): the rebuild restores the pane titles with
    // their user flags (the user-set apple title stays protected; the
    // automatic mango title stays automatic).
    expect(rebuilt.panes.paneTitles['tab-mango']['tab-mango-pane']).toBe('Mango notes')
    expect(rebuilt.panes.paneTitles['tab-apple']['tab-apple-pane']).toBe('Apple notes')
    expect(rebuilt.panes.paneTitleSetByUser['tab-apple']?.['tab-apple-pane']).toBe(true)
    expect(rebuilt.panes.paneTitleSetByUser['tab-mango']?.['tab-mango-pane']).toBeFalsy()
  })

  test('cross-window pane-title hydration is title-only: newer titles deliver, older do not clobber, user-set survives, each window keeps its own arrangement, and received titles are durable across the receiver\u2019s reload', async ({ browser }) => {
    const { context, page } = await createFreshE2ePage(browser, serverInfo, { serviceWorkers: 'block' })
    try {
      await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await harness.waitForTabCount(1)

      // This scenario owns its machine and initial editor workspace. It
      // must be runnable by itself, without inheriting a prior test's
      // machine selection or persisted snapshot.
      await page.evaluate((tabs) => {
        const h = window.__FRESHELL_TEST_HARNESS__
        if (!h) throw new Error('Test harness is unavailable')
        const initialTabIds = h.getState().tabs.tabs.map((tab) => tab.id)
        for (const t of tabs) {
          h.dispatch({ type: 'tabs/addTab', payload: { id: t.id, title: t.title, activate: false } })
          h.dispatch({
            type: 'panes/initLayout',
            payload: {
              tabId: t.id, paneId: t.pane,
              content: { kind: 'editor', filePath: t.file, language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true },
            },
          })
          h.dispatch({ type: 'panes/updatePaneTitle', payload: { tabId: t.id, paneId: t.pane, title: t.paneTitle, setByUser: t.userSet } })
        }
        h.dispatch({ type: 'tabs/setActiveTab', payload: 'tab-mango' })
        for (const id of initialTabIds) {
          h.dispatch({ type: 'tabs/removeTab', payload: id })
          h.dispatch({ type: 'panes/removeLayout', payload: { tabId: id } })
        }
        h.dispatch({ type: 'persist/flushNow' })
      }, TABS)
      await harness.waitForTabCount(2)
      const clientInstanceId = await page.evaluate(() => sessionStorage.getItem('freshell.tabs.client-instance-id.v1'))
      if (!clientInstanceId) throw new Error('Workspace has no client instance id')
      // Page2 bootstraps these same pane ids from this test's own durable
      // generation, so its title-only delivery assertions have real peers.
      await waitForNewestGenerationWorkspace(clientInstanceId, TABS)
      await waitForPersistedEnvelope(page, (env) =>
        typeof env.machineId === 'string' && env.machineId.length > 0
        && env.tabs?.tabs?.length === 2)

      // Page2 shares this context's machine selection and localStorage,
      // while keeping its own client and layout-window identities.
      const page2 = await page.context().newPage()
      await page2.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
      const harness2 = new TestHarness(page2)
      await harness2.waitForHarness()
      await harness2.waitForConnection()
      await harness2.waitForTabCount(2)

      // Give page2 a LOCAL-ONLY tab so the two arrangements demonstrably
      // diverge before any cross-window event fires (the approved tradeoff:
      // two windows on the same machine may keep divergent arrangements).
      await page2.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: 'tab-page2-only', title: 'Page2 only' } })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: 'tab-page2-only', paneId: 'tab-page2-only-pane',
            content: { kind: 'editor', filePath: '/tmp/page2-only.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true },
          },
        })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      await waitForPersistedEnvelope(page2, (env) =>
        env.tabs?.tabs?.some((t: { id: string }) => t.id === 'tab-page2-only'))
      // Page2's arrangement as it stands before any page1 event (the rebuild's
      // tab order is the server inventory's, not the seeded order — pin the
      // arrangement's INVARIANCE below instead of assuming an order).
      const page2TabsBefore = await page2.evaluate(() =>
        (window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs ?? []).map((t: { id: string }) => t.id))

      // ── Step A: page1's flush delivers its NEWER pane title to page2's
      // matching pane through the title-only path — and nothing else.
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/updatePaneTitle',
          payload: { tabId: 'tab-mango', paneId: 'tab-mango-pane', title: 'Newer from page1', setByUser: false },
        })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: 'tab-page1-only', title: 'Page1 only' } })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/initLayout',
          payload: {
            tabId: 'tab-page1-only', paneId: 'tab-page1-only-pane',
            content: { kind: 'editor', filePath: '/tmp/page1-only.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true },
          },
        })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      const t1 = await waitForPersistedEnvelopeTitled(page, 'tab-mango', 'tab-mango-pane', 'Newer from page1')

      // The title-only delivery landed on page2 (a positive, pollable
      // control that page2 processed page1's flush event at all).
      await page2.waitForFunction(() =>
        window.__FRESHELL_TEST_HARNESS__?.getState()?.panes?.paneTitles?.['tab-mango']?.['tab-mango-pane'] === 'Newer from page1',
        undefined, { timeout: 15_000 })

      // The divergence pin: the SAME flush carried 'tab-page1-only' — page2's
      // arrangement must stay EXACTLY its own: same tabs, same order, no
      // adoption, no reordering.
      const page2After = await page2.evaluate(() => {
        const state = window.__FRESHELL_TEST_HARNESS__?.getState()
        return {
          tabIds: (state?.tabs?.tabs ?? []).map((t: { id: string }) => t.id),
          layoutTabIds: Object.keys(state?.panes?.layouts ?? {}).sort(),
        }
      })
      expect(page2After.tabIds).toEqual(page2TabsBefore)
      expect(page2After.tabIds, 'page1\u2019s local-only tab is not adopted cross-window').not.toContain('tab-page1-only')
      expect(page2After.layoutTabIds).toEqual(['tab-apple', 'tab-mango', 'tab-page2-only'])

      // Page1's own arrangement, settled after its Step A flush, for the
      // Step B invariance pin below.
      const page1TabsBefore = await page.evaluate(() =>
        (window.__FRESHELL_TEST_HARNESS__?.getState()?.tabs?.tabs ?? []).map((t: { id: string }) => t.id))

      // ── Step B: page2 sets a USER-SET title on the other shared pane and
      // flushes; page1's matching pane receives it (incoming user-set wins
      // per the Task-7 rules) — the positive control that page1 processed
      // page2's flush, so the non-adoption read below is causally grounded.
      await page2.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/updatePaneTitle',
          payload: { tabId: 'tab-apple', paneId: 'tab-apple-pane', title: 'User-set on page2', setByUser: true },
        })
        window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })
      const t2 = await waitForPersistedEnvelopeTitled(page2, 'tab-apple', 'tab-apple-pane', 'User-set on page2')
      expect(t2).toBeGreaterThan(t1)

      await page.waitForFunction(() =>
        window.__FRESHELL_TEST_HARNESS__?.getState()?.panes?.paneTitles?.['tab-apple']?.['tab-apple-pane'] === 'User-set on page2',
        undefined, { timeout: 15_000 })
      const page1After = await page.evaluate(() => {
        const state = window.__FRESHELL_TEST_HARNESS__?.getState()
        return {
          tabIds: (state?.tabs?.tabs ?? []).map((t: { id: string }) => t.id),
          appleTitleUserSet: !!state?.panes?.paneTitleSetByUser?.['tab-apple']?.['tab-apple-pane'],
        }
      })
      expect(page1After.tabIds, 'page1\u2019s arrangement stays exactly its own across page2\u2019s flush').toEqual(page1TabsBefore)
      expect(page1After.tabIds).not.toContain('tab-page2-only')
      expect(page1After.appleTitleUserSet, 'the incoming user-set flag propagates').toBe(true)

      // ── Step B-reload (e3r3 finding 1): the received title must be DURABLE.
      // page1 is the RECEIVER of a cross-window title (Step B's user-set
      // apple title, folded in through the title-only path). The durable
      // reconciliation writes the received title into page1's OWN envelope
      // (the debounced persist flush), so a refresh of the HEALTHY receiver
      // boots WITH it — the reviewer's exact durability case: a receiver
      // that reloads before any unrelated mutation flushes must not lose
      // the received title.
      await waitForPersistedEnvelopeTitled(page, 'tab-apple', 'tab-apple-pane', 'User-set on page2')
      await page.reload()
      await harness.waitForHarness()
      await harness.waitForConnection()
      const reloadedReceiver = await page.evaluate(() =>
        window.__FRESHELL_TEST_HARNESS__?.getState()?.panes)
      expect(reloadedReceiver?.paneTitles?.['tab-apple']?.['tab-apple-pane'], 'the received user-set title survives the receiver\u2019s healthy reload').toBe('User-set on page2')
      expect(reloadedReceiver?.paneTitleSetByUser?.['tab-apple']?.['tab-apple-pane'], 'the received user-set flag survives the reload too').toBe(true)
      expect(reloadedReceiver?.paneTitles?.['tab-mango']?.['tab-mango-pane'], 'the receiver\u2019s own Step A title also survives the reload').toBe('Newer from page1')

      // ── Step C: an OLDER staged envelope does not clobber newer local
      // titles, and the user-set title survives it. From page1, mutate PAGE2's
      // OWN per-window envelope in place — the shared pane titles reverted,
      // persistedAt 60s OLDER than page2's local stamp (t2). page1's
      // cross-document write fires a storage event on page2 carrying page2's
      // own key: the own-envelope replacement path, recency-guarded through
      // the same Task-7 merge rules (remoteLayoutPersistedAt <
      // localLayoutPersistedAt). The stale title (non-user) must lose to
      // page2's recency, and the stale apple title must lose to the
      // user-set flag outright.
      const page2LayoutWindowId = await page2.evaluate(() => sessionStorage.getItem('freshell.layout-window-id.v1'))
      expect(page2LayoutWindowId, 'page2 has a per-window layout-window id in sessionStorage').toBeTruthy()
      await page2.evaluate(({ layoutWindowId, persistedAt }) => {
        const observed = window as Window & { __staleEnvelopeDelivered?: boolean }
        observed.__staleEnvelopeDelivered = false
        const onStorage = (event: StorageEvent) => {
          if (event.storageArea !== localStorage
            || event.key !== `freshell.layout.v3.${layoutWindowId}`
            || !event.newValue) return
          const envelope = JSON.parse(event.newValue)
          if (envelope.persistedAt !== persistedAt) return
          window.removeEventListener('storage', onStorage)
          // The app's already-registered storage handler applies or rejects
          // the envelope synchronously before this later listener runs.
          observed.__staleEnvelopeDelivered = true
        }
        window.addEventListener('storage', onStorage)
      }, { layoutWindowId: page2LayoutWindowId, persistedAt: t2 - 60_000 })
      await page.evaluate(([t2, layoutWindowId]) => {
        const layoutKey = `freshell.layout.v3.${layoutWindowId}`
        const env = JSON.parse(localStorage.getItem(layoutKey) ?? '{}')
        env.panes.paneTitles['tab-mango']['tab-mango-pane'] = 'Stale from page1'
        env.panes.paneTitles['tab-apple']['tab-apple-pane'] = 'Stale apple from page1'
        env.persistedAt = t2 - 60_000
        localStorage.setItem(layoutKey, JSON.stringify(env))
      }, [t2, page2LayoutWindowId] as [number, string | null])

      // A negative assertion is meaningful only after the receiver has
      // processed the exact stale write; elapsed time does not prove that.
      await page2.waitForFunction(() =>
        (window as Window & { __staleEnvelopeDelivered?: boolean }).__staleEnvelopeDelivered === true)
      const kept = await page2.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState()?.panes)
      expect(kept?.paneTitles?.['tab-mango']?.['tab-mango-pane'], 'the newer local title wins against the older staged envelope').toBe('Newer from page1')
      expect(kept?.paneTitles?.['tab-apple']?.['tab-apple-pane'], 'the user-set title survives the older staged envelope').toBe('User-set on page2')
      expect(kept?.paneTitleSetByUser?.['tab-apple']?.['tab-apple-pane']).toBe(true)
    } finally {
      await context.close()
    }
  })
})

/** Bounded node-side poll for the persisted envelope to satisfy the
 * predicate: evaluate a plain JSON.parse read each round (no serialized
 * predicate, no `new Function`), assert the predicate in node, keep the
 * poll bounded (10s default) with a clear timeout error. Reads the page's
 * per-window layout key (freshell.layout.v3.<layoutWindowId>, derived from
 * the immutable sessionStorage layout-window-id — e3r1 finding 3). */
async function waitForPersistedEnvelope(
  page: Page,
  predicate: (env: Record<string, unknown>) => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last: Record<string, unknown> | null = null
  while (Date.now() < deadline) {
    const env = await page.evaluate(() => {
      const layoutKey = `freshell.layout.v3.${sessionStorage.getItem('freshell.layout-window-id.v1')}`
      try { return JSON.parse(localStorage.getItem(layoutKey) ?? 'null') } catch { return null }
    })
    if (env && predicate(env)) return
    last = env
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(
    `persisted envelope did not satisfy the predicate within ${timeoutMs}ms; `
    + `last observed: ${JSON.stringify(last)?.slice(0, 400)}`,
  )
}

/** Bounded poll until the page's envelope's pane title equals the given
 * value; resolves the envelope's persistedAt (the writer's stamp — the
 * tLocal anchor for the recency staging). Node-side predicate over one
 * plain JSON.parse read per round (same shape as
 * waitForPersistedEnvelope). */
async function waitForPersistedEnvelopeTitled(
  page: Page,
  tabId: string,
  paneId: string,
  expectedTitle: string,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const persistedAt = await page.evaluate(([tabId, paneId, title]) => {
      try {
        const layoutKey = `freshell.layout.v3.${sessionStorage.getItem('freshell.layout-window-id.v1')}`
        const env = JSON.parse(localStorage.getItem(layoutKey) ?? 'null')
        if (env?.panes?.paneTitles?.[tabId]?.[paneId] === title
          && typeof env.persistedAt === 'number') {
          return env.persistedAt
        }
        return null
      } catch { return null }
    }, [tabId, paneId, expectedTitle] as const)
    if (typeof persistedAt === 'number') return persistedAt
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`persisted envelope did not carry the pane title '${expectedTitle}' within ${timeoutMs}ms`)
}
