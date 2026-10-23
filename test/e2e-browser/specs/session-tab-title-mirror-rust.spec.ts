import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { TestHarness } from '../helpers/test-harness.js'
import {
  connectUnifiedPage,
  createNamedAgent,
  renameThroughTabEdit,
  startFakeGemini,
  type NamedAgentHandle,
} from '../helpers/unified-agent-names.js'
import { bootJourney, type Journey } from '../helpers/unified-agent-names-modes.js'
import { withholdSavedNames } from '../helpers/withhold-saved-names.js'
import { clickFirstVisibleShellOption } from '../helpers/pane-picker.js'

// NAME RELIABILITY (plan Task 7, RC2) — a Claude/Codex/OpenCode tab's stored
// title is a mirror of the session's saved name. Before the fix nothing ever
// wrote the saved name into a session-owned tab's stored title: the tab bar
// showed the name only while the client's name cache held the record, and
// the persisted layout, the server's layout mirror (GET /api/tabs) and the
// tabs registry all carried the create-time label instead.
//
// Each case runs an OWNED Rust server (isolated HOME, ephemeral port) with
// the fake Claude CLI and a fake Gemini that answers 403, so no AI name ever
// lands; the only name is the user's rename.
//
// Isolating the mirror (plan Task 7 Step 1 — the implementer's pick): the
// reload case makes saved names unavailable to the page from the BROWSER
// side. The client's name cache is filled from three kinds of source: the
// `/api/session-names/read` route, `session.name.updated` WebSocket frames,
// and `sessionName` record projections riding on other HTTP responses and
// WebSocket frames (terminal and fresh-agent creation, terminal inventory,
// session-directory rows). Playwright routes every HTTP response and proxies
// the WebSocket, so the page sees all three withheld while the rest of the
// app (terminals, layout sync) keeps working. The case then asserts the tab
// label AND that the page's name cache holds no record, so the label can only
// come from the mirrored stored title. It also asserts the persisted layout
// before the reload.
//
// The last case covers the reverse: a tab whose Claude pane closes, leaving
// only a shell, no longer takes its name from that session. Before the fix
// its stored title kept the session's name, so the tab bar, the persisted
// layout and GET /api/tabs all called the plain shell tab by it.

test.setTimeout(300_000)

const SAVED_NAME = 'LotL'

async function bootForbiddenGeminiJourney(): Promise<Journey> {
  const gemini = await startFakeGemini('unused', {
    status: 403,
    body: { error: { code: 403, message: 'Permission denied.', status: 'PERMISSION_DENIED' } },
  })
  return bootJourney('claude', { gemini })
}

/** Create a Claude CLI tab through the picker (a session-owned tab) and give
 * it a saved name through the tab's inline rename editor. */
async function createRenamedClaudeTab(page: Page, harness: TestHarness, journey: Journey, savedName = SAVED_NAME): Promise<NamedAgentHandle> {
  const handle = await createNamedAgent(harness, 'claude', { entry: 'ui', page, server: journey.server })
  await renameThroughTabEdit(page, handle.tabId, savedName)
  return handle
}

/** The stored title of `tabId` in this window's own persisted layout. */
async function persistedTabTitle(page: Page, tabId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const windowId = sessionStorage.getItem('freshell.layout-window-id.v1')
    const raw = windowId ? localStorage.getItem(`freshell.layout.v3.${windowId}`) : null
    if (!raw) return null
    const layout = JSON.parse(raw) as { tabs?: { tabs?: Array<{ id: string; title?: string }> } }
    return layout.tabs?.tabs?.find((tab) => tab.id === id)?.title ?? null
  }, tabId)
}

/** The tab title the server's layout mirror reports for `tabId`. */
async function serverTabTitle(journey: Journey, tabId: string): Promise<string | null> {
  const response = await fetch(`${journey.server.info.baseUrl}/api/tabs`, {
    headers: { 'x-auth-token': journey.server.info.token },
  })
  if (!response.ok) return null
  const payload = await response.json() as { data?: { tabs?: Array<{ id: string; title?: string }> }; tabs?: Array<{ id: string; title?: string }> }
  const tabs = payload.data?.tabs ?? payload.tabs ?? []
  return tabs.find((tab) => tab.id === tabId)?.title ?? null
}

async function reloadAndConnect(page: Page): Promise<TestHarness> {
  await page.reload()
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

function tabLabel(page: Page, tabId: string) {
  return page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)
}

/** Split the active tab's terminal through its context menu and choose a
 * shell for the new pane. */
async function splitWithShell(page: Page): Promise<void> {
  await page.locator('.xterm:visible').first().click({ button: 'right' })
  await page.getByRole('menuitem', { name: /split horizontally/i }).click()
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  await expect(picker).toBeVisible({ timeout: 10_000 })
  await clickFirstVisibleShellOption(page)
}

type MirrorState = {
  tabs?: { tabs?: Array<{ id: string; title?: string; nameSource?: { kind: string } }> }
  panes?: { layouts?: Record<string, { type?: string; content?: { mode?: string } }> }
}

test.describe('session tab title mirror', () => {
  for (const savedName of [SAVED_NAME, 'Gemini']) {
    test(`a reload with names unavailable still shows the saved name ${savedName}`, async ({ browser }) => {
      const journey = await bootForbiddenGeminiJourney()
      try {
        const { context, page, harness } = await connectUnifiedPage({ browser, info: journey.server.info })
        const handle = await createRenamedClaudeTab(page, harness, journey, savedName)

        // The window's persisted layout carries the saved name as the tab's
        // stored title (before the fix: the create-time label).
        await expect.poll(() => persistedTabTitle(page, handle.tabId), { timeout: 30_000 }).toBe(savedName)

        const withholding = await withholdSavedNames(page)
        const reloaded = await reloadAndConnect(page)
        // Let the boot-time name reads, inventory frames and broadcasts land.
        await page.waitForTimeout(3_000)

        await expect(tabLabel(page, handle.tabId)).toContainText(savedName, { timeout: 30_000 })
        const state = await reloaded.getState() as {
          sessionNames?: { records?: Record<string, unknown> }
          tabs?: { tabs?: Array<{ id: string; title?: string }> }
        }
        // The label came from the stored title alone: the page's name cache
        // never received a record.
        expect(Object.keys(state.sessionNames?.records ?? {})).toEqual([])
        expect(state.tabs?.tabs?.find((tab) => tab.id === handle.tabId)?.title).toBe(savedName)
        await expect.poll(() => persistedTabTitle(page, handle.tabId), { timeout: 30_000 }).toBe(savedName)
        await expect.poll(() => serverTabTitle(journey, handle.tabId), { timeout: 30_000 }).toBe(savedName)
        console.log(`[session-tab-title-mirror] withheld ${withholding.withheld} saved-name projections`)
        await context.close()
      } finally {
        await journey.cleanup()
      }
    })
  }

  test('the server layout mirror carries the saved name', async ({ browser }) => {
    const journey = await bootForbiddenGeminiJourney()
    try {
      const { context, page, harness } = await connectUnifiedPage({ browser, info: journey.server.info })
      const handle = await createRenamedClaudeTab(page, harness, journey)

      // GET /api/tabs answers from the server's layout mirror, which stores
      // each tab's stored title as the client last synced it.
      await expect.poll(() => serverTabTitle(journey, handle.tabId), { timeout: 30_000 }).toBe(SAVED_NAME)
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })

  test('a reopened split tab follows its recorded naming pane after the panes were swapped', async ({ browser }) => {
    const journey = await bootForbiddenGeminiJourney()
    try {
      const { context, page, harness } = await connectUnifiedPage({ browser, info: journey.server.info })
      const handle = await createRenamedClaudeTab(page, harness, journey)
      await splitWithShell(page)
      const layout = await harness.getPaneLayout(handle.tabId)
      expect(layout.type).toBe('split')
      const otherId = layout.children[1].id as string
      await page.evaluate(({ tabId, paneId, otherId }) => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'panes/swapPanes', payload: { tabId, paneId, otherId },
        })
      }, { tabId: handle.tabId, paneId: handle.paneId, otherId })
      await expect.poll(async () => {
        const state = await harness.getState()
        return state.tabs.tabs.find((tab: { id: string }) => tab.id === handle.tabId)?.nameSource
      }).toEqual({ kind: 'session', paneId: otherId })

      await tabLabel(page, handle.tabId).getByRole('button', { name: /close/i }).click()
      await page.getByRole('button', { name: 'Tabs (Ctrl+B A)' }).click()
      const expand = page.getByRole('button', { name: 'Expand Recently closed' })
      await expect(expand).toBeVisible({ timeout: 15_000 })
      await expand.click()
      const card = page.locator(`[data-context="tabs-card"][data-tab-status="closed"][data-tab-key$=":${handle.tabId}"]`)
      await expect(card).toBeVisible({ timeout: 15_000 })
      const beforeIds = (await harness.getState()).tabs.tabs.map((tab: { id: string }) => tab.id) as string[]
      await card.click()
      let openedId = ''
      await expect.poll(async () => {
        const state = await harness.getState()
        openedId = state.tabs.tabs.find((tab: { id: string }) => !beforeIds.includes(tab.id))?.id ?? ''
        return openedId
      }).not.toBe('')
      const reopened = await harness.getPaneLayout(openedId)
      expect(reopened.type).toBe('split')
      const sourceId = reopened.children[1].id as string
      const state = await harness.getState()
      expect(state.tabs.tabs.find((tab: { id: string }) => tab.id === openedId)?.nameSource)
        .toEqual({ kind: 'session', paneId: sourceId })

      // An update to the shared saved name must still name the TAB, not
      // just its Claude pane. A prematurely downgraded legacy tab would
      // keep its recorded title forever.
      const renamed = await fetch(`${journey.server.info.baseUrl}/api/session-names`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', 'x-auth-token': journey.server.info.token },
        body: JSON.stringify({ target: handle.nameRef, name: 'Billing after reopen', nameIntent: 'user' }),
      })
      expect(renamed.ok, await renamed.text()).toBe(true)
      await expect(tabLabel(page, openedId)).toContainText('Billing after reopen', { timeout: 30_000 })
      await expect(page.locator(`[data-context="pane-header"][data-pane-id="${sourceId}"]`))
        .toContainText('Billing after reopen', { timeout: 30_000 })
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })

  test('a tab whose Claude pane closes stops carrying the session\'s name', async ({ browser }) => {
    const journey = await bootForbiddenGeminiJourney()
    try {
      const { context, page, harness } = await connectUnifiedPage({ browser, info: journey.server.info })
      const handle = await createRenamedClaudeTab(page, harness, journey)
      await expect.poll(() => serverTabTitle(journey, handle.tabId), { timeout: 30_000 }).toBe(SAVED_NAME)

      // [Claude | shell], then close the Claude pane from its header.
      await splitWithShell(page)
      await expect(page.locator('.xterm:visible')).toHaveCount(2, { timeout: 30_000 })
      await expect.poll(() => persistedTabTitle(page, handle.tabId), { timeout: 30_000 }).toBe(SAVED_NAME)
      // The next window has the stored session name but no cached record or
      // middleware memory. Closing the source still releases its title.
      await withholdSavedNames(page)
      const reloaded = await reloadAndConnect(page)
      await expect(tabLabel(page, handle.tabId)).toContainText(SAVED_NAME, { timeout: 30_000 })
      await page
        .locator(`[data-context="pane-header"][data-pane-id="${handle.paneId}"]`)
        .getByRole('button', { name: 'Close pane' })
        .click()

      // Only the shell is left, so the tab no longer takes its name from the
      // Claude session.
      await expect.poll(async () => {
        const state = await reloaded.getState() as MirrorState
        const tab = state.tabs?.tabs?.find((candidate) => candidate.id === handle.tabId)
        const layout = state.panes?.layouts?.[handle.tabId]
        return { nameSource: tab?.nameSource?.kind, layout: layout?.type, mode: layout?.content?.mode }
      }, { timeout: 30_000 }).toEqual({ nameSource: 'legacy', layout: 'leaf', mode: 'shell' })

      // Every copy of the tab drops the session's name: the tab bar, the
      // stored title, the persisted layout and the server's layout mirror.
      await expect(tabLabel(page, handle.tabId)).not.toContainText(SAVED_NAME, { timeout: 30_000 })
      const storedTitle = async () => {
        const state = await reloaded.getState() as MirrorState
        return state.tabs?.tabs?.find((candidate) => candidate.id === handle.tabId)?.title ?? null
      }
      await expect.poll(storedTitle, { timeout: 30_000 }).not.toBe(SAVED_NAME)
      await expect.poll(() => persistedTabTitle(page, handle.tabId), { timeout: 30_000 }).not.toBe(SAVED_NAME)
      await expect.poll(() => serverTabTitle(journey, handle.tabId), { timeout: 30_000 }).not.toBe(SAVED_NAME)
      await expect(tabLabel(page, handle.tabId)).not.toContainText(SAVED_NAME)
      await context.close()
    } finally {
      await journey.cleanup()
    }
  })
})
