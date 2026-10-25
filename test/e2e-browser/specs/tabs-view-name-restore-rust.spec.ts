import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import type { TestHarness } from '../helpers/test-harness.js'
import { renameThroughPaneHeader, renameThroughTabEdit } from '../helpers/unified-agent-names.js'
import { leafIds, reduxTab, sendWindowTitle, terminalIdOf } from '../helpers/stored-names.js'

// NAME RELIABILITY (plan Task 14; Task 9 receipt, open concern 3) — the Tabs
// view opens a tabs-registry record as a new tab: clicking a closed tab's
// card reopens it, and the card's menu opens one of its panes in a tab of its
// own. Before the fix both dropped every pane title and every "user renamed"
// flag (and the reopened tab's own flag): a renamed shell pane came back with
// its default label, unprotected, so the shell's next window title (OSC 0/2)
// replaced it. They now restore names exactly as the Task 9 new-window
// rebuild does.
//
// Each case renames the FIRST pane of a split shell tab ("KeepMePane") and
// the tab ("MyShellTab") through the UI, closes the tab, and opens it again
// from the Tabs view's "Recently closed" section. The unrenamed second pane
// is the control: it takes the OSC title, so the protected name means
// something.
//
// Cloud-legal: plain shells only.

const TAB_NAME = 'MyShellTab'
const PANE_NAME = 'KeepMePane'
const INTRUDER = 'intruder'

type Renamed = { tabId: string; renamedPaneId: string; plainPaneId: string }

/** Split the active shell tab into two shell panes, rename the tab and its
 * first pane through the UI inline editors, and keep a second tab open so
 * closing this one leaves the workspace non-empty. */
async function renameSplitShellTab(page: Page, harness: TestHarness): Promise<Renamed> {
  const tabId = (await harness.getActiveTabId())!
  const layout = await harness.getPaneLayout(tabId)
  expect(layout?.type, `tab ${tabId} starts as a single pane`).toBe('leaf')
  const renamedPaneId = layout.id as string
  const plainPaneId = `${tabId}-plain`
  await page.evaluate(({ tabId, plainPaneId }) => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'panes/addPane',
      payload: { tabId, newPaneId: plainPaneId, newContent: { kind: 'terminal', mode: 'shell' } },
    })
  }, { tabId, plainPaneId })
  await terminalIdOf(harness, tabId, plainPaneId)

  await renameThroughTabEdit(page, tabId, TAB_NAME)
  // The first visible pane header is the original (left) pane's.
  await renameThroughPaneHeader(page, PANE_NAME)
  const state = await harness.getState()
  expect(state.panes.paneTitles?.[tabId]?.[renamedPaneId]).toBe(PANE_NAME)
  expect(state.panes.paneTitleSetByUser?.[tabId]?.[renamedPaneId]).toBe(true)
  expect(await reduxTab(harness, tabId)).toEqual({ title: TAB_NAME, titleSetByUser: true })

  await page.evaluate(() => {
    window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'tabs/addTab',
      payload: { id: 'tab-keeper', mode: 'shell', activate: false },
    })
    window.__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'panes/initLayout',
      payload: { tabId: 'tab-keeper', paneId: 'pane-keeper', content: { kind: 'terminal', mode: 'shell' } },
    })
  })
  return { tabId, renamedPaneId, plainPaneId }
}

/** Close `tabId` from its tab-bar close button, then show its card in the
 * Tabs view's "Recently closed" section. */
async function closeAndFindClosedCard(page: Page, harness: TestHarness, tabId: string) {
  await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).getByRole('button', { name: /close/i }).click()
  await expect.poll(async () => (await harness.getState()).tabs.tabs.some((tab: { id: string }) => tab.id === tabId), {
    timeout: 10_000,
    message: 'the tab closed',
  }).toBe(false)

  await page.getByRole('button', { name: 'Tabs (Ctrl+B A)' }).click()
  const expand = page.getByRole('button', { name: 'Expand Recently closed' })
  await expect(expand).toBeVisible({ timeout: 15_000 })
  await expand.click()
  const card = page.locator(`[data-context="tabs-card"][data-tab-status="closed"][data-tab-key$=":${tabId}"]`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  return card
}

/** The tab an open created: the one tab that was not there before. */
async function openedTabId(harness: TestHarness, before: string[]): Promise<string> {
  let opened = ''
  await expect.poll(async () => {
    const ids = ((await harness.getState()).tabs.tabs as Array<{ id: string }>).map((tab) => tab.id)
    opened = ids.find((id) => !before.includes(id)) ?? ''
    return opened
  }, { timeout: 15_000, message: 'the Tabs view opened a new tab' }).not.toBe('')
  return opened
}

async function tabIds(harness: TestHarness): Promise<string[]> {
  return ((await harness.getState()).tabs.tabs as Array<{ id: string }>).map((tab) => tab.id)
}

function paneHeader(page: Page, paneId: string) {
  return page.locator(`[data-context="pane-header"][data-pane-id="${paneId}"]`)
}

test.describe('Tabs-view opens keep pane names', () => {
  test.setTimeout(240_000)

  test('a renamed pane reopened from the Tabs view keeps its name and rename protection', async ({ freshellPage: page, harness }) => {
    const { tabId } = await renameSplitShellTab(page, harness)
    const card = await closeAndFindClosedCard(page, harness, tabId)
    const before = await tabIds(harness)

    await card.click()

    const reopenedTabId = await openedTabId(harness, before)
    const state = await harness.getState()
    const [renamedPaneId, plainPaneId] = leafIds(state.panes.layouts[reopenedTabId])
    expect(plainPaneId, 'the reopened tab has both panes').toBeTruthy()
    expect(await reduxTab(harness, reopenedTabId)).toEqual({ title: TAB_NAME, titleSetByUser: true })
    expect(state.panes.paneTitles?.[reopenedTabId]?.[renamedPaneId]).toBe(PANE_NAME)
    expect(state.panes.paneTitleSetByUser?.[reopenedTabId]?.[renamedPaneId]).toBe(true)
    expect(state.panes.paneTitleSetByUser?.[reopenedTabId]?.[plainPaneId]).toBeFalsy()
    await expect(paneHeader(page, renamedPaneId)).toContainText(PANE_NAME, { timeout: 15_000 })

    await sendWindowTitle(page, harness, { tabId: reopenedTabId, paneId: renamedPaneId, title: INTRUDER, marker: 60 })
    await sendWindowTitle(page, harness, { tabId: reopenedTabId, paneId: plainPaneId, title: INTRUDER, marker: 70 })
    await expect(paneHeader(page, plainPaneId), 'control: the unrenamed pane takes the OSC title')
      .toContainText(INTRUDER, { timeout: 15_000 })
    await expect(paneHeader(page, renamedPaneId)).toContainText(PANE_NAME)
    await expect(paneHeader(page, renamedPaneId)).not.toContainText(INTRUDER)
    const tab = page.locator(`[data-context="tab"][data-tab-id="${reopenedTabId}"]`)
    await expect(tab).toContainText(TAB_NAME)
    await expect(tab).not.toContainText(INTRUDER)
    const after = await harness.getState()
    expect(after.panes.paneTitles?.[reopenedTabId]?.[renamedPaneId]).toBe(PANE_NAME)
  })

  test('a renamed pane opened in its own tab from the Tabs view keeps its name and rename protection', async ({ freshellPage: page, harness }) => {
    const { tabId } = await renameSplitShellTab(page, harness)
    const card = await closeAndFindClosedCard(page, harness, tabId)
    const before = await tabIds(harness)

    await card.click({ button: 'right' })
    await page.getByRole('menuitem', { name: `Open ${PANE_NAME} in new tab` }).click()

    const openedId = await openedTabId(harness, before)
    const state = await harness.getState()
    const panes = leafIds(state.panes.layouts[openedId])
    expect(panes, 'one pane in its own tab').toHaveLength(1)
    const [paneId] = panes
    expect(state.panes.paneTitles?.[openedId]?.[paneId]).toBe(PANE_NAME)
    expect(state.panes.paneTitleSetByUser?.[openedId]?.[paneId]).toBe(true)
    await expect(paneHeader(page, paneId)).toContainText(PANE_NAME, { timeout: 15_000 })
    const tab = page.locator(`[data-context="tab"][data-tab-id="${openedId}"]`)
    await expect(tab).toContainText(PANE_NAME)

    await sendWindowTitle(page, harness, { tabId: openedId, paneId, title: INTRUDER, marker: 80 })
    // Control: the new tab's own stored title is not protected (a new tab
    // has no rename flag), so it takes the OSC title — this window does
    // apply OSC titles, and the pane name below held against one.
    await expect.poll(async () => (await reduxTab(harness, openedId))?.title, {
      timeout: 15_000,
      message: 'control: the unprotected tab title takes the OSC title',
    }).toBe(INTRUDER)
    await expect(paneHeader(page, paneId)).toContainText(PANE_NAME)
    await expect(paneHeader(page, paneId)).not.toContainText(INTRUDER)
    await expect(tab).toContainText(PANE_NAME)
    await expect(tab).not.toContainText(INTRUDER)
    expect((await harness.getState()).panes.paneTitles?.[openedId]?.[paneId]).toBe(PANE_NAME)
  })
})
