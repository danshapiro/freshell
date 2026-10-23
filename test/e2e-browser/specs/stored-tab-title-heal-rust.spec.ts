import type { Page } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import type { TestHarness } from '../helpers/test-harness.js'
import { renameThroughTabEdit } from '../helpers/unified-agent-names.js'
import {
  LAYOUT_WINDOW_ID_KEY,
  clientInstanceIdOf,
  persistedTab,
  reduxTab,
  sendWindowTitle,
  serverTabTitle,
  terminalIdOf,
  waitForPersistedRecords,
} from '../helpers/stored-names.js'

// NAME RELIABILITY (plan Task 14, Residual 23) — before Task 8 the
// managed-runtime refresh wrote its view titles ("Shell agent", "OpenCode
// agent", "Recovered Shell agent") over every unrenamed tab it matched. Task 8
// stopped new writes, but a title an earlier refresh already STORED stayed:
// a single-pane shell tab with no window title of its own kept showing "Shell
// agent", and the persisted layout, the server's layout mirror (GET
// /api/tabs) and the tabs registry kept carrying it.
//
// Such a stored title is not a name. The client heals it in one place (the
// store), so all four agree: the tab shows its derived label, the stored
// title becomes the unnamed placeholder ("Tab N"), and that lasts across
// reloads. A tab the user renamed keeps its name even when the name is the
// same text; a real window title from the shell still names the tab.
//
// The old label is seeded the way the old client left it: an init script
// rewrites this window's persisted layout once, before the app loads, giving
// the unrenamed tab the stored title "Shell agent" (no rename flag) and its
// pane the default pane title.
//
// Cloud-legal: plain shells only.

const OLD_LABEL = 'Shell agent'
const SEED_MARKER = 'e2e.task14.seeded-stored-title'

/** Runs in the page before any app script, on every navigation: the first
 * time only, store `title` on tab `tabId` without a rename flag, as the old
 * managed-runtime merge did, and give its single pane the default title. */
function seedStoredTitleOnce(opts: { tabId: string; paneId: string; title: string; marker: string; windowIdKey: string }): void {
  if (sessionStorage.getItem(opts.marker)) return
  const windowId = sessionStorage.getItem(opts.windowIdKey)
  if (!windowId) return
  const key = `freshell.layout.v3.${windowId}`
  const raw = localStorage.getItem(key)
  if (!raw) return
  const layout = JSON.parse(raw) as {
    tabs: { tabs: Array<{ id: string; title?: string; titleSetByUser?: boolean }> }
    panes: { paneTitles?: Record<string, Record<string, string>>; paneTitleSetByUser?: Record<string, Record<string, boolean>> }
  }
  const tab = layout.tabs.tabs.find((candidate) => candidate.id === opts.tabId)
  if (!tab) return
  tab.title = opts.title
  delete tab.titleSetByUser
  layout.panes.paneTitles = { ...(layout.panes.paneTitles ?? {}), [opts.tabId]: { [opts.paneId]: 'Shell' } }
  if (layout.panes.paneTitleSetByUser) delete layout.panes.paneTitleSetByUser[opts.tabId]
  localStorage.setItem(key, JSON.stringify(layout))
  sessionStorage.setItem(opts.marker, '1')
}

function tabLabel(page: Page, tabId: string) {
  return page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)
}

async function reloadApp(page: Page, harness: TestHarness): Promise<void> {
  await page.reload()
  await harness.waitForHarness()
  await harness.waitForConnection()
}

/** The first (single) pane id of `tabId`. */
async function singlePaneId(harness: TestHarness, tabId: string): Promise<string> {
  const layout = await harness.getPaneLayout(tabId)
  expect(layout?.type, `tab ${tabId} is a single pane`).toBe('leaf')
  return layout.id as string
}

/** Seed the old stored label on the unrenamed tab and reload into it. */
async function reloadWithOldStoredLabel(page: Page, harness: TestHarness, tabId: string, paneId: string): Promise<number> {
  await page.addInitScript(seedStoredTitleOnce, {
    tabId, paneId, title: OLD_LABEL, marker: SEED_MARKER, windowIdKey: LAYOUT_WINDOW_ID_KEY,
  })
  const reloadedAt = Date.now()
  await reloadApp(page, harness)
  expect(
    await page.evaluate((marker) => sessionStorage.getItem(marker), SEED_MARKER),
    'the old stored label was seeded before the app loaded',
  ).toBe('1')
  return reloadedAt
}

test.describe('stored provider-label tab titles heal', () => {
  test.setTimeout(240_000)

  test('an unrenamed "Shell agent" tab heals on load and stays healed across reload; a renamed one keeps its name', async ({ freshellPage: page, harness, serverInfo }) => {
    const plainTabId = (await harness.getActiveTabId())!
    const plainPaneId = await singlePaneId(harness, plainTabId)
    await terminalIdOf(harness, plainTabId, plainPaneId)

    // A second shell tab the user renames to the very same text.
    const renamedTabId = 'tab-renamed-shell-agent'
    const renamedPaneId = 'pane-renamed-shell-agent'
    await page.evaluate(({ tabId, paneId }) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: tabId, mode: 'shell' } })
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/initLayout',
        payload: { tabId, paneId, content: { kind: 'terminal', mode: 'shell' } },
      })
    }, { tabId: renamedTabId, paneId: renamedPaneId })
    await terminalIdOf(harness, renamedTabId, renamedPaneId)
    await renameThroughTabEdit(page, renamedTabId, OLD_LABEL)
    expect(await reduxTab(harness, renamedTabId)).toEqual({ title: OLD_LABEL, titleSetByUser: true })
    await expect.poll(() => persistedTab(page, renamedTabId), { timeout: 15_000 })
      .toEqual({ title: OLD_LABEL, titleSetByUser: true })

    const reloadedAt = await reloadWithOldStoredLabel(page, harness, plainTabId, plainPaneId)
    const clientInstanceId = await clientInstanceIdOf(page)

    const expectHealed = async (capturedSince: number, when: string) => {
      // The store: the unrenamed tab's stored title is the unnamed
      // placeholder (it is the first tab), never the old label.
      await expect.poll(() => reduxTab(harness, plainTabId), { timeout: 15_000, message: `${when}: stored title` })
        .toEqual({ title: 'Tab 1', titleSetByUser: undefined })
      expect(await reduxTab(harness, renamedTabId)).toEqual({ title: OLD_LABEL, titleSetByUser: true })
      // The tab bar.
      await expect(tabLabel(page, plainTabId)).not.toContainText(OLD_LABEL)
      await expect(tabLabel(page, renamedTabId)).toContainText(OLD_LABEL)
      // This window's persisted layout.
      await expect.poll(() => persistedTab(page, plainTabId), { timeout: 15_000, message: `${when}: persisted title` })
        .toEqual({ title: 'Tab 1' })
      expect(await persistedTab(page, renamedTabId)).toEqual({ title: OLD_LABEL, titleSetByUser: true })
      // The server's layout mirror.
      await expect.poll(() => serverTabTitle(serverInfo, plainTabId), { timeout: 30_000, message: `${when}: GET /api/tabs` })
        .toBe('Tab 1')
      expect(await serverTabTitle(serverInfo, renamedTabId)).toBe(OLD_LABEL)
      // The tabs registry the server persisted after this load.
      await waitForPersistedRecords(serverInfo.homeDir, clientInstanceId, (records) => {
        const plain = records.find((record) => record.tabId === plainTabId)
        const renamed = records.find((record) => record.tabId === renamedTabId)
        return !!plain && plain.tabName !== OLD_LABEL && plain.titleSetByUser !== true
          && renamed?.tabName === OLD_LABEL && renamed.titleSetByUser === true
      }, { capturedSince })
    }

    await expectHealed(reloadedAt, 'first load after the old label')

    const secondReloadAt = Date.now()
    await reloadApp(page, harness)
    await expectHealed(secondReloadAt, 'second reload')
  })

  test('a healed tab still takes the shell\'s own window title', async ({ freshellPage: page, harness, serverInfo }) => {
    const tabId = (await harness.getActiveTabId())!
    const paneId = await singlePaneId(harness, tabId)
    await terminalIdOf(harness, tabId, paneId)

    await reloadWithOldStoredLabel(page, harness, tabId, paneId)
    await expect.poll(() => reduxTab(harness, tabId), { timeout: 15_000, message: 'the old label healed' })
      .toEqual({ title: 'Tab 1', titleSetByUser: undefined })

    await sendWindowTitle(page, harness, { tabId, paneId, title: 'Build watcher', marker: 40 })

    await expect(tabLabel(page, tabId)).toContainText('Build watcher', { timeout: 15_000 })
    expect(await reduxTab(harness, tabId)).toEqual({ title: 'Build watcher', titleSetByUser: undefined })
    await expect.poll(() => serverTabTitle(serverInfo, tabId), { timeout: 30_000 }).toBe('Build watcher')

    // A real title is a name: a reload keeps it.
    await reloadApp(page, harness)
    await expect(tabLabel(page, tabId)).toContainText('Build watcher', { timeout: 15_000 })
    expect((await reduxTab(harness, tabId))?.title).toBe('Build watcher')
  })

  // The tab's first pane is a shell started in /tmp, and a browser pane beside
  // it gives the tab its label (example.com). A shell prompt that titles the
  // window with its folder name ("tmp") sets a live title, not a stored
  // default label, so it keeps naming the tab.
  test('a shell window title equal to its folder name keeps naming a split tab labeled from another pane', async ({ freshellPage: page, harness, serverInfo }) => {
    const tabId = 'tab-folder-window-title'
    const shellPaneId = 'pane-folder-shell'
    await page.evaluate(({ tabId, shellPaneId }) => {
      const testHarness = window.__FRESHELL_TEST_HARNESS__
      testHarness?.dispatch({ type: 'tabs/addTab', payload: { id: tabId, mode: 'shell' } })
      testHarness?.dispatch({
        type: 'panes/initLayout',
        payload: { tabId, paneId: shellPaneId, content: { kind: 'terminal', mode: 'shell', initialCwd: '/tmp' } },
      })
      testHarness?.dispatch({
        type: 'panes/splitPane',
        payload: {
          tabId,
          paneId: shellPaneId,
          direction: 'horizontal',
          newPaneId: 'pane-folder-browser',
          newContent: { kind: 'browser', url: 'https://example.com/docs', devToolsOpen: false },
        },
      })
    }, { tabId, shellPaneId })
    await terminalIdOf(harness, tabId, shellPaneId)
    await expect(tabLabel(page, tabId)).toContainText('example.com', { timeout: 15_000 })

    await sendWindowTitle(page, harness, { tabId, paneId: shellPaneId, title: 'tmp', marker: 60 })

    await expect(tabLabel(page, tabId)).toContainText('tmp', { timeout: 15_000 })
    expect(await reduxTab(harness, tabId)).toEqual({ title: 'tmp', titleSetByUser: undefined })
    await expect.poll(() => serverTabTitle(serverInfo, tabId), { timeout: 30_000 }).toBe('tmp')

    // Nothing heals it on the next load either.
    await reloadApp(page, harness)
    await expect(tabLabel(page, tabId)).toContainText('tmp', { timeout: 15_000 })
    expect(await reduxTab(harness, tabId)).toEqual({ title: 'tmp', titleSetByUser: undefined })
    expect(await persistedTab(page, tabId)).toEqual({ title: 'tmp' })
  })
})
