/**
 * AUTO-01 (docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md):
 * "Make `ui.layout.sync` authoritative. Replace the OpenCode-only shadow
 * layout with the real connected UI layout shared by browser, REST, CLI, and
 * MCP."
 *
 * Playwright validation (checklist text): create, rename, reorder, select,
 * split, resize, and close content ONLY through the visible UI, then fetch the
 * layout snapshot and assert exact tab IDs/order, pane tree/ratios, titles,
 * content, active tab, and active pane.
 *
 * Runs in BOTH matrix projects (`retired Node browser lane` parity control +
 * `Rust browser lane`): the legacy Node `LayoutStore` and the Rust layout store
 * (AUTO-01's port) must produce byte-identical read surfaces for the same
 * mirrored UI layout. Authored under the df1 deferred-Playwright policy
 * (probe-executable: run once per leg); see docs/plans/df1-evidence/AUTO-01.md.
 */
import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'

const LAYOUT_SYNC_DEBOUNCE_MS = 1000

type PaneNode = {
  type: 'leaf' | 'split'
  id: string
  direction?: string
  sizes?: number[]
  content?: Record<string, unknown>
  children?: PaneNode[]
}

type Snapshot = {
  tabs: Array<{ id: string; title?: string }>
  activeTabId?: string | null
  layouts: Record<string, PaneNode>
  activePane: Record<string, string>
  paneTitles?: Record<string, Record<string, string>>
  paneTitleSetByUser?: Record<string, Record<string, boolean>>
  timestamp?: number
}

async function fetchWithAuth(serverInfo: E2eServerInfo, path: string) {
  const response = await fetch(`${serverInfo.baseUrl}${path}`, {
    headers: { 'x-auth-token': serverInfo.token },
  })
  expect(response.status).toBe(200)
  const body = await response.json()
  return body?.data
}

async function fetchSnapshot(serverInfo: E2eServerInfo): Promise<Snapshot> {
  return (await fetchWithAuth(serverInfo, '/api/layout/snapshot')) as Snapshot
}

/** Split the terminal under the cursor via its context menu, then choose a
 * shell for the new picker pane. Uses `:visible` xterms — hidden terminals of
 * inactive/background tabs and panes must not be hit. */
async function splitAndSelectShell(page: Page, direction: 'horizontal' | 'vertical', nth = 0) {
  await page.locator('.xterm:visible').nth(nth).click({ button: 'right' })
  await page
    .getByRole('menuitem', { name: direction === 'horizontal' ? /split horizontally/i : /split vertically/i })
    .click()
  const picker = page.locator('[data-context="pane-picker"]').last()
  await picker.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(300)
  for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
    const button = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await button.isVisible().catch(() => false)) {
      await button.click({ timeout: 5000 })
      return
    }
  }
  throw new Error('no shell option in pane picker')
}

/** The shape the client mirror sends (the client state is the source of
 * truth; the server must echo it). Compares:
 *  - EXACTLY: tabs (id/title/order), layouts (full trees), activePane, activeTabId
 *  - client ⊑ server for paneTitles (server adds derived seeds) and
 *    paneTitleSetByUser (server may add EMPTY per-tab maps from seeding). */
function expectSnapshotMatchesClient(snapshot: Snapshot, client: any) {
  const clientTabs = client.tabs.tabs.map((t: any) => ({ id: t.id, title: t.title }))
  expect(snapshot.tabs).toEqual(clientTabs)
  expect(snapshot.activeTabId).toEqual(client.tabs.activeTabId)
  expect(snapshot.layouts).toEqual(client.panes.layouts)
  expect(snapshot.activePane).toEqual(client.panes.activePane)

  const clientTitles = client.panes.paneTitles ?? {}
  for (const [tabId, panes] of Object.entries(clientTitles)) {
    expect(snapshot.paneTitles?.[tabId]).toEqual(panes)
  }
  const clientSetByUser = client.panes.paneTitleSetByUser ?? {}
  for (const [tabId, panes] of Object.entries(clientSetByUser)) {
    expect(snapshot.paneTitleSetByUser?.[tabId]).toEqual(panes)
  }
  // Extra server-side setByUser entries (from seeding) must be EMPTY maps.
  for (const [tabId, panes] of Object.entries(snapshot.paneTitleSetByUser ?? {})) {
    if (!(tabId in clientSetByUser)) {
      expect(panes).toEqual({})
    }
  }
}

test.describe('AUTO-01 — ui.layout.sync is the authoritative layout', () => {
  test('REST snapshot exactly mirrors a visible-UI-driven layout', async ({ freshellPage: _freshellPage, page, harness, terminal, serverInfo }) => {
    test.setTimeout(120_000)
    await harness.waitForConnection()
    await terminal.waitForTerminal()

    // ── split (horizontal) + second shell ──
    await splitAndSelectShell(page, 'horizontal')
    await expect(page.locator('.xterm:visible')).toHaveCount(2, { timeout: 30_000 })

    // ── select first pane (click) ──
    await page.locator('.xterm').first().click()

    // ── resize by dragging the divider +50px ──
    const divider = page.locator('[role="separator"]').first()
    await expect(divider).toBeVisible({ timeout: 5_000 })
    const box = await divider.boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width / 2 + 50, box!.y + box!.height / 2, { steps: 5 })
    await page.mouse.up()

    // ── rename tab 1 (double-click) ──
    const tabsBar = page.locator('[data-context="tab"]')
    await tabsBar.first().dblclick()
    const renameInput = tabsBar.first().locator('input')
    await expect(renameInput).toBeVisible({ timeout: 5_000 })
    await renameInput.fill('Alpha')
    await renameInput.press('Enter')

    // ── create tab 2 (add button), give it a shell, rename it ──
    await page.locator('[data-context="tab-add"]').click()
    await harness.waitForTabCount(2)
    const picker = page.locator('[data-context="pane-picker"]').last()
    await picker.waitFor({ state: 'visible', timeout: 10_000 })
    await page.waitForTimeout(300)
    let shellChosen = false
    for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
      const button = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
      if (await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 5000 })
        shellChosen = true
        break
      }
    }
    expect(shellChosen).toBe(true)
    await page.locator('.xterm').last().waitFor({ state: 'visible', timeout: 30_000 })

    const secondTab = page.locator('[data-context="tab"]').nth(1)
    await secondTab.dblclick()
    const renameInput2 = secondTab.locator('input')
    await expect(renameInput2).toBeVisible({ timeout: 5_000 })
    await renameInput2.fill('Beta')
    await renameInput2.press('Enter')

    // ── split tab 2 vertically, then CLOSE that new pane via its header ──
    await splitAndSelectShell(page, 'vertical')
    await expect(page.locator('.xterm:visible')).toHaveCount(2, { timeout: 30_000 })
    let state = await harness.getState()
    const t2 = state.tabs.activeTabId
    expect(Object.keys(state.panes.layouts[t2] ? { [t2]: 1 } : {})).toEqual([t2])
    expect(state.panes.layouts[t2].type).toBe('split')
    await page.locator('button[title="Close pane"]').last().click()
    await expect
      .poll(async () => (await harness.getState()).panes.layouts[t2].type, { timeout: 10_000 })
      .toBe('leaf')

    // ── reorder tabs: drag "Beta" (second) onto "Alpha" (first) ──
    const first = page.locator('[data-context="tab"]').first()
    const second = page.locator('[data-context="tab"]').nth(1)
    const firstBox = await first.boundingBox()
    const secondBox = await second.boundingBox()
    expect(firstBox && secondBox).toBeTruthy()
    await page.mouse.move(secondBox!.x + secondBox!.width / 2, secondBox!.y + secondBox!.height / 2)
    await page.mouse.down()
    // Move in steps past the 5px activation constraint, onto the first tab.
    await page.mouse.move(secondBox!.x + secondBox!.width / 2 - 40, secondBox!.y + secondBox!.height / 2, { steps: 4 })
    await page.mouse.move(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(async () => (await harness.getState()).tabs.tabs[0].title, { timeout: 10_000 })
      .toBe('Beta')

    // ── select the "Alpha" tab by clicking it ──
    await page.locator('[data-context="tab"]').filter({ hasText: 'Alpha' }).first().click()
    await expect
      .poll(async () => (await harness.getState()).tabs.tabs.find((t: any) => t.title === 'Alpha')?.id, { timeout: 10_000 })
      .toBeTruthy()
    state = await harness.getState()
    const alphaId = state.tabs.tabs.find((t: any) => t.title === 'Alpha')?.id
    await expect.poll(async () => (await harness.getState()).tabs.activeTabId, { timeout: 10_000 }).toBe(alphaId)

    // ── the REST read surface must equal the client's real layout ──
    let lastSnapshot: Snapshot | undefined
    let lastClient: any
    await expect
      .poll(
        async () => {
          lastSnapshot = await fetchSnapshot(serverInfo)
          lastClient = await harness.getState()
          try {
            expectSnapshotMatchesClient(lastSnapshot, lastClient)
            return true
          } catch {
            return false
          }
        },
        { timeout: 15_000, intervals: [LAYOUT_SYNC_DEBOUNCE_MS, 500, 1000] },
      )
      .toBe(true)
    expectSnapshotMatchesClient(lastSnapshot!, lastClient)

    // Spot-pin details of the acceptance text: a two-value ratio pair is
    // reflected, the closed pane is gone from the snapshot, and both renamed
    // titles are echoed in order (Beta then Alpha after the drag reorder).
    // (The equality proof above is what makes the resize reflection exact; a
    // 50px drag leave-the-sizes-at-50/50 behavior of the divider is the
    // client's own, same as pane-system.spec.ts's drag test.)
    const alphaTree = lastSnapshot!.layouts[alphaId]
    expect(alphaTree.type).toBe('split')
    expect(alphaTree.direction).toBe('horizontal')
    expect(alphaTree.sizes).toHaveLength(2)
    expect(alphaTree.sizes![0] + alphaTree.sizes![1]).toBeCloseTo(100, 0)
    expect(lastSnapshot!.tabs.map((t) => t.title)).toEqual(['Beta', 'Alpha'])
    const betaTree = lastSnapshot!.layouts[lastSnapshot!.tabs[0].id]
    expect(betaTree.type).toBe('leaf')
  })

  test('ingested legacy agent-chat subtree is normalized server-side on read', async ({ freshellPage: _freshellPage, page, harness, serverInfo }) => {
    test.setTimeout(60_000)
    await harness.waitForConnection()

    const canonical = '11111111-1111-4111-8111-111111111111'
    // ui.layout.sync is whole-snapshot last-write-wins and the REAL client in
    // this page keeps emitting its own syncs (layoutMirrorMiddleware, 200ms
    // debounce) on every tabs/panes-affecting Redux action — e.g. the
    // terminal-spawn/boot burst after page load. Any such sync that lands
    // AFTER this injection REPLACES the store and erases tab-legacy-remote.
    // The poll below therefore re-asserts the injection on every iteration,
    // so the normalized read is observed from an iteration that is the last
    // writer (converges once the client's boot burst settles, deterministically).
    const injectLegacySync = () =>
      page.evaluate(
        ({ canonical }) => {
          window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
            type: 'ui.layout.sync',
            tabs: [{ id: 'tab-legacy-remote', title: 'Remote legacy' }],
            activeTabId: 'tab-legacy-remote',
            layouts: {
              'tab-legacy-remote': {
                type: 'split',
                id: 'split-legacy',
                direction: 'horizontal',
                sizes: [55, 45],
                children: [
                  {
                    type: 'leaf',
                    id: 'pane-legacy-agent',
                    content: {
                      kind: 'agent-chat',
                      provider: 'claude',
                      createRequestId: 'req-legacy-agent',
                      status: 'idle',
                      resumeSessionId: canonical,
                    },
                  },
                  {
                    type: 'leaf',
                    id: 'pane-legacy-editor',
                    content: { kind: 'editor', filePath: '/tmp/notes.md', language: null, readOnly: false, content: '', viewMode: 'source', wordWrap: true },
                  },
                ],
              },
            },
            activePane: { 'tab-legacy-remote': 'pane-legacy-agent' },
            paneTitles: {},
            paneTitleSetByUser: {},
            timestamp: Date.now(),
          })
        },
        { canonical },
      )
    await injectLegacySync()

    let snapshot!: Snapshot
    // Pane listing captured in the SAME poll iteration as the snapshot read —
    // a re-fetch after the poll could race a fresh client sync (same LWW stomp).
    let panes: any
    let debugLast: unknown
    const harnessHasSend = await page.evaluate(
      () => typeof window.__FRESHELL_TEST_HARNESS__?.sendWsMessage,
    )
    try {
      await expect
        .poll(
          async () => {
            await injectLegacySync()
            const data = await fetchWithAuth(
              serverInfo,
              `/api/layout/snapshot?tabId=${encodeURIComponent('tab-legacy-remote')}`,
            ).catch((err) => ({ fetchError: String(err) }))
            debugLast = data
            const layout = (data as Snapshot | null)?.layouts?.['tab-legacy-remote']
            if (!layout || JSON.stringify(layout).includes('"agent-chat"')) return false
            // The pane listing must be validated in the SAME stomp-free
            // iteration as the snapshot: a client sync landing BETWEEN the two
            // fetches would erase the injected tab and return [] here.
            const panesData: any = await fetchWithAuth(
              serverInfo,
              `/api/panes?tabId=${encodeURIComponent('tab-legacy-remote')}`,
            ).catch(() => null)
            const rows: any[] = panesData?.panes ?? []
            const panesOk =
              rows.length === 2
              && rows[0]?.id === 'pane-legacy-agent' && rows[0]?.index === 0
              && rows[0]?.kind === 'fresh-agent' && rows[0]?.title === 'Freshclaude'
              && rows[1]?.id === 'pane-legacy-editor' && rows[1]?.index === 1
              && rows[1]?.kind === 'editor' && rows[1]?.title === 'notes.md'
            if (!panesOk) { debugLast = { data, panesData }; return false }
            snapshot = data as Snapshot
            panes = panesData
            return true
          },
          { timeout: 15_000, intervals: [500, 1000, 2000] },
        )
        .toBe(true)
    } catch (err) {
      const tabsNow = await fetchWithAuth(serverInfo, '/api/tabs').catch((e) => String(e))
      throw new Error(
        `normalized layout never appeared over REST. sendWsMessage=${harnessHasSend} ` +
          `GET /api/tabs=${JSON.stringify(tabsNow)} last snapshot read=${JSON.stringify(debugLast)} ` +
          `cause=${err}`,
      )
    }

    // Byte-exact migrated content + derived seeded titles.
    const tree = snapshot.layouts['tab-legacy-remote']
    expect(tree.type).toBe('split')
    expect(tree.sizes).toEqual([55, 45])
    expect(tree.children![0].content).toMatchObject({
      kind: 'fresh-agent',
      sessionType: 'freshclaude',
      provider: 'claude',
      createRequestId: 'req-legacy-agent',
      sessionRef: { provider: 'claude', sessionId: canonical },
    })
    expect(tree.children![1].content).toMatchObject({ kind: 'editor', filePath: '/tmp/notes.md' })
    expect(snapshot.paneTitles?.['tab-legacy-remote']).toEqual({
      'pane-legacy-agent': 'Freshclaude',
      'pane-legacy-editor': 'notes.md',
    })
    expect(snapshot.activePane).toEqual({ 'tab-legacy-remote': 'pane-legacy-agent' })
    expect(snapshot.activeTabId).toBe('tab-legacy-remote')

    // The pane listing for the tab resolves the same (normalized) content.
    // (`panes` was captured alongside `snapshot` in the converged poll
    // iteration above — after the injection won the last-writer race.)
    expect(panes.panes).toEqual([
      expect.objectContaining({ id: 'pane-legacy-agent', index: 0, kind: 'fresh-agent', title: 'Freshclaude' }),
      expect.objectContaining({ id: 'pane-legacy-editor', index: 1, kind: 'editor', title: 'notes.md' }),
    ])
  })
})
