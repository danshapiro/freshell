import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle, type E2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { TestServerInfo } from '../helpers/test-server.js'

/**
 * AUTOMATION LAYOUT PARITY (Task 23, rust-only) -- e2e proof of the Rust
 * server's automation REST routes over the server-side LayoutStore fed by
 * `ui.layout.sync` (Tasks 12-16 / AUTO-03 + AUTO-06 + the AUTO-01
 * snapshot/rename slice):
 *
 *  - tab routes: `GET /api/tabs`, `POST /api/tabs/next`, `PATCH /api/tabs/:id`,
 *    `GET /api/tabs/has`, `DELETE /api/tabs/:id` (`pane_ops.rs` /
 *    `terminal_tabs.rs::list_tabs`);
 *  - pane routes on a REAL split layout: `GET /api/layout/snapshot`,
 *    `GET /api/panes`, `POST /api/panes/:id/resize` (`pane_resize.rs`),
 *    `POST /api/panes/:id/swap`, `PATCH /api/panes/:id`;
 *  - the no-client hole: with NO `ui.layout.sync` ever ingested the tab
 *    routes answer Node's honest `{message:'no layout snapshot'}` degradation
 *    at 200 exactly as Task 14 pinned it
 *    (`pane_ops_tab_tests.rs::rename_with_no_snapshot_reports_no_layout_snapshot`,
 *    `lib.rs::rename_without_layout_snapshot_is_200_with_message`).
 *
 * Envelopes are asserted EXACTLY (`{status,data,message}`, `response.ts`
 * parity via `ok_json`, `lib.rs:1273-1280`) -- these routes are the
 * automation/MCP surface, so their shapes are contracts, not incidentals.
 *
 * PER-TEST OWNED SERVERS (auto-title-rust.spec.ts / Task 21 precedent): each
 * test boots its own `RustServer` (isolated HOME, ephemeral port) via
 * `createE2eServerHandle({kind:'rust'})`. Test 1 needs a deterministic
 * 3-tab layout, Test 2 a deterministic 2-pane split, and Test 3 a server NO
 * browser page has EVER synced a layout into -- none of which can share a
 * worker-scoped server under `fullyParallel`. Registered rust-only in
 * `playwright.config.ts` (the LayoutStore-backed automation routes are this
 * sweep's Rust work; the frozen legacy `server/` tree is not under test).
 */

interface BootedServer {
  server: E2eServerHandle
  info: TestServerInfo
}

async function bootRustServer(): Promise<BootedServer> {
  const server = await createE2eServerHandle(process.env, { kind: 'rust' })
  const info = await server.start()
  return { server, info }
}

/** Navigate + wait for the harness's WS connection to reach `ready`. */
async function connect(page: Page, info: TestServerInfo): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

/** Select a shell in the initial PanePicker if it's showing
 *  (auto-title-rust.spec.ts's copy of the fixtures.ts helper). */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 30_000 })
      return
    } catch {
      continue
    }
  }
}

/** Split via the terminal context menu (pane-system.spec.ts helper). */
async function splitViaContextMenu(page: Page, direction: 'horizontal' | 'vertical', nth = 0): Promise<void> {
  await page.locator('.xterm').nth(nth).click({ button: 'right' })
  const menuItem = page.getByRole('menuitem', {
    name: direction === 'horizontal' ? /split horizontally/i : /split vertically/i,
  })
  await menuItem.click()
}

/** Split then choose a shell in the new pane's PanePicker (pane-system.spec.ts helper). */
async function splitAndSelectShell(page: Page, direction: 'horizontal' | 'vertical', nth = 0): Promise<void> {
  await splitViaContextMenu(page, direction, nth)
  const picker = page.locator('[data-context="pane-picker"]').last()
  await picker.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(500)
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      const button = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 5_000 })
        return
      }
    } catch {
      continue
    }
  }
}

/** `page.request` REST helpers (the brief pins page.request as the client). */
function api(page: Page, info: TestServerInfo) {
  const headers = { 'content-type': 'application/json', 'x-auth-token': info.token }
  return {
    async get(pathname: string): Promise<any> {
      const res = await page.request.get(`${info.baseUrl}${pathname}`, { headers })
      expect(res.status(), `GET ${pathname}`).toBe(200)
      return res.json()
    },
    async post(pathname: string, data?: unknown): Promise<{ status: number; body: any }> {
      const res = await page.request.post(`${info.baseUrl}${pathname}`, { headers, data: data ?? {} })
      return { status: res.status(), body: await res.json() }
    },
    async patch(pathname: string, data: unknown): Promise<{ status: number; body: any }> {
      const res = await page.request.patch(`${info.baseUrl}${pathname}`, { headers, data })
      return { status: res.status(), body: await res.json() }
    },
    async delete(pathname: string): Promise<{ status: number; body: any }> {
      const res = await page.request.delete(`${info.baseUrl}${pathname}`, { headers })
      return { status: res.status(), body: await res.json() }
    },
  }
}

test.describe('Automation layout parity (Rust only)', () => {
  test.setTimeout(180_000)

  test('tab routes: list/select/rename/delete/exists/next/prev via page.request', async ({ page }) => {
    const { server, info } = await bootRustServer()
    try {
      const harness = await connect(page, info)
      const rest = api(page, info)

      // Three tabs THROUGH THE UI: shell in the initial PanePicker tab, then
      // the tab strip's "New shell tab" + button twice (TabBar.tsx:535,
      // `addTab({mode:'shell'})` -- the new-tab interaction every tab spec uses).
      await selectShellIfPickerShowing(page)
      const newTabButton = page.getByRole('button', { name: 'New shell tab' })
      await newTabButton.click()
      await harness.waitForTabCount(2)
      await newTabButton.click()
      await harness.waitForTabCount(3)

      // Wait for ui.layout.sync to reach the server's LayoutStore: poll
      // GET /api/tabs until all 3 rows are there.
      await expect.poll(async () => (await rest.get('/api/tabs')).data.tabs.length, {
        timeout: 20_000,
      }).toBe(3)

      // GET /api/tabs -> exact ids/order/titles + activeTabId, matching the
      // client's own Redux tabs state (the layout-sync source of truth).
      const redux = await harness.getState()
      const expectedIds: string[] = redux.tabs.tabs.map((t: any) => t.id)
      const expectedTitles: string[] = redux.tabs.tabs.map((t: any) => t.title)
      expect(expectedIds).toHaveLength(3)

      const listBody = await rest.get('/api/tabs')
      expect(listBody.status).toBe('ok')
      expect(listBody.message).toBe('')
      expect(listBody.data.tabs.map((row: any) => row.id)).toEqual(expectedIds)
      expect(listBody.data.tabs.map((row: any) => row.title)).toEqual(expectedTitles)
      expect(listBody.data.activeTabId).toBe(redux.tabs.activeTabId)

      // POST /api/tabs/next -> the next tab in order (wrapping), AND the UI
      // highlights that tab. The third (last-created) tab is active, so next
      // wraps to the first.
      const activeIdx = expectedIds.indexOf(listBody.data.activeTabId)
      const expectedNextId = expectedIds[(activeIdx + 1) % expectedIds.length]
      const next = await rest.post('/api/tabs/next')
      expect(next.status).toBe(200)
      expect(next.body).toEqual({
        status: 'ok',
        data: { tabId: expectedNextId },
        message: 'tab selected',
      })
      // The broadcast `ui.command{tab.select}` folds into the client...
      await expect.poll(() => harness.getActiveTabId(), { timeout: 10_000 }).toBe(expectedNextId)
      // ...and the tab strip highlights the tab (TabItem.tsx active styling:
      // active = `bg-background text-foreground`, inactive = `bg-muted`).
      const activeTabEl = page.locator(`[data-context="tab"][data-tab-id="${expectedNextId}"]`)
      await expect(activeTabEl).toHaveClass(/bg-background/)
      // The persisted server-side activeTabId agrees.
      await expect.poll(async () => (await rest.get('/api/tabs')).data.activeTabId, {
        timeout: 10_000,
      }).toBe(expectedNextId)

      // PATCH /api/tabs/:id {name:"Renamed"} -> UI tab shows "Renamed".
      const renamed = await rest.patch(`/api/tabs/${expectedNextId}`, { name: 'Renamed' })
      expect(renamed.status).toBe(200)
      expect(renamed.body).toEqual({
        status: 'ok',
        data: { tabId: expectedNextId },
        message: 'tab renamed',
      })
      const tabStrip = page.locator('[data-testid="tab-strip"]')
      await expect(tabStrip.getByText('Renamed', { exact: true })).toBeVisible({ timeout: 10_000 })

      // GET /api/tabs/has?target=Renamed -> {exists:true} (TITLE match --
      // Task 14's `hasTab` matches id OR title, layout-store.ts:336-339 parity).
      const has = await rest.get('/api/tabs/has?target=Renamed')
      expect(has).toEqual({ status: 'ok', data: { exists: true }, message: '' })

      // DELETE /api/tabs/:id -> gone from the UI and from GET /api/tabs.
      const deleted = await rest.delete(`/api/tabs/${expectedNextId}`)
      expect(deleted.status).toBe(200)
      expect(deleted.body).toEqual({
        status: 'ok',
        data: { tabId: expectedNextId },
        message: 'tab closed',
      })
      await expect(page.locator(`[data-context="tab"][data-tab-id="${expectedNextId}"]`)).toHaveCount(0)
      await expect(tabStrip.getByText('Renamed', { exact: true })).toHaveCount(0)
      await expect.poll(async () => (await rest.get('/api/tabs')).data.tabs.map((row: any) => row.id), {
        timeout: 10_000,
      }).toEqual(expectedIds.filter((id) => id !== expectedNextId))
    } finally {
      await server.stop().catch(() => {})
    }
  })

  test('pane routes on a split layout: snapshot/list/resize/swap/rename', async ({ page }) => {
    const { server, info } = await bootRustServer()
    try {
      const harness = await connect(page, info)
      const rest = api(page, info)

      // A real two-pane split THROUGH THE UI (pane-system.spec.ts interaction:
      // right-click terminal -> "Split horizontally" -> pick a shell).
      await selectShellIfPickerShowing(page)
      await splitAndSelectShell(page, 'horizontal')
      await page.locator('.xterm').nth(1).waitFor({ state: 'visible', timeout: 30_000 })
      const tabId = (await harness.getActiveTabId())!
      expect(tabId).toBeTruthy()

      // GET /api/layout/snapshot -> a REAL split node (Tasks 12-14: the
      // `{type:'unknown'}` deferral marker is dead).
      await expect.poll(async () => {
        const snap = (await rest.get('/api/layout/snapshot')).data
        return snap.layouts?.[tabId]?.type
      }, { timeout: 20_000 }).toBe('split')

      const snapshotBody = await rest.get('/api/layout/snapshot')
      expect(snapshotBody.status).toBe('ok')
      const node = snapshotBody.data.layouts[tabId]
      expect(node.direction).toBe('horizontal')
      expect(node.sizes).toEqual([50, 50])
      expect(node.children).toHaveLength(2)
      expect(node.children.map((child: any) => child.type)).toEqual(['leaf', 'leaf'])
      expect(snapshotBody.data.activeTabId).toBe(tabId)

      const [paneA, paneB] = node.children.map((child: any) => child.id as string)

      // GET /api/panes -> index-ordered rows mirroring the leaves
      // (depth-first leaf order, Node-exact row shape `{id,index,kind,terminalId}`).
      // Poll until BOTH rows are terminal-kind AND have terminalId: the client syncs the split
      // twice (first with the new pane still a picker, then with the spawned
      // terminal attached), and only the second sync carries the terminal row.
      await expect.poll(async () => {
        const panes = (await rest.get(`/api/panes?tabId=${tabId}`)).data.panes
        return {
          kinds: panes.map((row: any) => row.kind),
          terminalIds: panes.map((row: any) => row.terminalId)
        }
      }, { timeout: 20_000 }).toEqual({ kinds: ['terminal', 'terminal'], terminalIds: [expect.any(String), expect.any(String)] })
      const panesBody = await rest.get(`/api/panes?tabId=${tabId}`)
      expect(panesBody.status).toBe('ok')
      const rows = panesBody.data.panes
      expect(rows.map((row: any) => row.id)).toEqual([paneA, paneB])
      expect(rows.map((row: any) => row.index)).toEqual([0, 1])
      expect(rows.map((row: any) => row.kind)).toEqual(['terminal', 'terminal'])
      const [terminalA, terminalB] = rows.map((row: any) => row.terminalId as string)
      expect(terminalA).toBeTruthy()
      expect(terminalB).toBeTruthy()

      // POST /api/panes/:id/resize {sizes:[30,70]} -> 200; targeting a PANE id
      // resizes its parent split with Node's advisory message
      // (`pane_resize.rs:62`, router.ts:637-641 parity).
      const resize = await rest.post(`/api/panes/${paneA}/resize`, { sizes: [30, 70] })
      expect(resize.status).toBe(200)
      expect(resize.body).toEqual({
        status: 'ok',
        data: { tabId },
        message: 'pane matched; resized parent split',
      })
      // The store snapshot carries [30,70]...
      await expect.poll(async () => {
        const snap = (await rest.get('/api/layout/snapshot')).data
        return snap.layouts?.[tabId]?.sizes
      }, { timeout: 10_000 }).toEqual([30, 70])
      // ...and the broadcast `ui.command{pane.resize}` folds into the client:
      // measured bounding boxes reflect ~30/70 (tolerance +/-5% -- the pane
      // divider takes a few px, so assert the FRACTION of the two panes' widths).
      const paneShellA = page.locator(`[data-context="pane"][data-pane-id="${paneA}"]`)
      const paneShellB = page.locator(`[data-context="pane"][data-pane-id="${paneB}"]`)
      await expect.poll(async () => {
        const boxA = await paneShellA.boundingBox()
        const boxB = await paneShellB.boundingBox()
        if (!boxA || !boxB) return null
        return boxA.width / (boxA.width + boxB.width)
      }, { timeout: 10_000 }).toBeLessThanOrEqual(0.35)
      const boxA = await paneShellA.boundingBox()
      const boxB = await paneShellB.boundingBox()
      expect(boxA).toBeTruthy()
      expect(boxB).toBeTruthy()
      const fraction = boxA!.width / (boxA!.width + boxB!.width)
      expect(fraction).toBeGreaterThanOrEqual(0.25)
      expect(fraction).toBeLessThanOrEqual(0.35)

      // POST /api/panes/:id/swap {target} -> contents exchanged: the store
      // rows flip terminalIds in place...
      const swap = await rest.post(`/api/panes/${paneA}/swap`, { target: paneB })
      expect(swap.status).toBe(200)
      expect(swap.body).toEqual({
        status: 'ok',
        data: { tabId },
        message: 'panes swapped',
      })
      await expect.poll(async () => {
        const panes = (await rest.get(`/api/panes?tabId=${tabId}`)).data.panes
        return panes.map((row: any) => `${row.id}:${row.terminalId}`)
      }, { timeout: 10_000 }).toEqual([`${paneA}:${terminalB}`, `${paneB}:${terminalA}`])
      // ...and the `ui.command{pane.swap}` broadcast folds into the client's
      // rendered layout (`ui-commands.ts` -> `swapPanes`): the SAME leaves now
      // render each other's terminal. (The xterm canvas has no per-terminal
      // DOM discriminator, so the client's layout tree -- what PaneContainer
      // renders from -- is the UI-side assertion surface.)
      await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabId)
        if (layout?.type !== 'split') return null
        return layout.children.map((child: any) => `${child.id}:${child.content?.terminalId}`)
      }, { timeout: 10_000 }).toEqual([`${paneA}:${terminalB}`, `${paneB}:${terminalA}`])

      // PATCH /api/panes/:id {name:"P1"} -> pane header shows "P1";
      // `tabRenamed` is FALSE on a two-pane tab (`lib.rs:1484-1488`).
      const rename = await rest.patch(`/api/panes/${paneA}`, { name: 'P1' })
      expect(rename.status).toBe(200)
      expect(rename.body).toEqual({
        status: 'ok',
        data: { tabId, paneId: paneA, tabRenamed: false },
        message: 'pane renamed',
      })
      await expect(paneShellA.getByText('P1', { exact: true })).toBeVisible({ timeout: 10_000 })
    } finally {
      await server.stop().catch(() => {})
    }
  })

  test('no client connected -> tab rename answers the honest no-layout-snapshot degradation', async ({ page }) => {
    // Boot a server and deliberately NEVER open a page against it: no
    // `ui.layout.sync` ever reaches the LayoutStore, so `renameTab` answers
    // Node's `renamePane`-shaped miss at 200 -- `ok({message:'no layout
    // snapshot'})`, the Rust envelope EXACTLY as Task 14/16 pinned it
    // (`pane_ops_tab_tests.rs:286-299`: data.message AND top-level message).
    const { server, info } = await bootRustServer()
    try {
      const res = await page.request.patch(`${info.baseUrl}/api/tabs/x`, {
        headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
        data: { name: 'X' },
      })
      expect(res.status()).toBe(200)
      expect(await res.json()).toEqual({
        status: 'ok',
        data: { message: 'no layout snapshot' },
        message: 'no layout snapshot',
      })
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
