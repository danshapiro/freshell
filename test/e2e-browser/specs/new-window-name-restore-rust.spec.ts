import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { test, expect, createE2eBrowserContext } from '../helpers/fixtures.js'
import { TestHarness } from '../helpers/test-harness.js'
import { installRecoveryOfferAutoDeclineOnContext } from '../helpers/recovery-offer.js'
import { renameThroughPaneHeader, renameThroughTabEdit } from '../helpers/unified-agent-names.js'

// NAME RELIABILITY (plan Task 9, RC7) — opening Freshell in a new window
// rebuilds the window's workspace from the server's recovery inventory. Before
// the fix that rebuild dropped every pane title and every "user renamed" flag:
// the plan hard-coded `paneTitles: {}`, the inventory forwarded only the tab
// name, and the registry snapshot never carried a pane's flag. A renamed shell
// pane came back with its default label, and both the tab and the pane came
// back unprotected, so the shell's next window title (OSC 0/2) replaced them.
//
// Each case renames in window 1, waits until the server has PERSISTED the
// renamed snapshot (the generation files a new window's rebuild reads), then
// opens a window that has no layout of its own:
// - `context.newPage()` after window 1 closed: same browser, shared
//   localStorage, empty sessionStorage — a new window id, so no local layout
//   and the boot rebuilds from the server. Window 1 is closed first so its
//   later layout writes cannot hand pane titles to the new window through the
//   cross-window title path: the server rebuild is the only possible source.
// - `browser.newContext()`: a different browser profile with the same machine
//   selected (no shared storage at all).
//
// Cloud-legal: plain shells and a browser pane only, no coding-CLI binaries.

const TAB_NAME = 'MyShellTab'
const PANE_NAME = 'KeepMePane'
const BROWSER_PANE_NAME = 'Team docs'
const INTRUDER = 'intruder'
const CLIENT_INSTANCE_ID_KEY = 'freshell.tabs.client-instance-id.v1'

type RegistryRecord = {
  tabId?: string
  tabName?: string
  titleSetByUser?: boolean
  panes?: Array<{ paneId?: string; title?: string; titleSetByUser?: boolean }>
}

/**
 * Wait until the NEWEST persisted tabs-snapshot generation of `clientInstanceId`
 * satisfies `predicate` (the fs-poll idiom of machine-tab-order-rust.spec.ts:
 * pushes fire on change and every 5 s, so the generation files lag the UI;
 * reading them proves the server durably holds what the next window reads).
 */
async function waitForPersistedRecords(
  homeDir: string,
  clientInstanceId: string,
  predicate: (records: RegistryRecord[]) => boolean,
  timeoutMs = 30_000,
): Promise<void> {
  const snapshotsDir = path.join(homeDir, '.freshell', 'tabs-snapshots')
  const deadline = Date.now() + timeoutMs
  let lastObserved = 'none'
  while (Date.now() < deadline) {
    const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
    for (const device of devices) {
      const deviceDir = path.join(snapshotsDir, device)
      const files = (await fs.readdir(deviceDir).catch(() => [] as string[]))
        .filter((file) => file.endsWith('.json'))
      let newest: { revision: number; capturedAt: number; records: RegistryRecord[] } | null = null
      for (const file of files) {
        const raw = await fs.readFile(path.join(deviceDir, file), 'utf8').catch(() => '')
        let doc: { clientInstanceId?: string; snapshotRevision?: number; capturedAt?: number; records?: RegistryRecord[] } | null = null
        try {
          doc = JSON.parse(raw)
        } catch {
          continue
        }
        if (doc?.clientInstanceId !== clientInstanceId) continue
        const revision = Number(doc.snapshotRevision ?? 0)
        const capturedAt = Number(doc.capturedAt ?? 0)
        if (!newest || revision > newest.revision
          || (revision === newest.revision && capturedAt > newest.capturedAt)) {
          newest = { revision, capturedAt, records: Array.isArray(doc.records) ? doc.records : [] }
        }
      }
      if (newest) {
        lastObserved = JSON.stringify(newest.records.map((record) => ({
          tabId: record.tabId,
          tabName: record.tabName,
          panes: record.panes?.map((pane) => pane.title),
        })))
        if (predicate(newest.records)) return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(
    `The newest persisted generation for client ${clientInstanceId} never matched within ${timeoutMs}ms `
    + `(last observed: ${lastObserved})`,
  )
}

function hasPaneTitle(records: RegistryRecord[], tabId: string, paneId: string, title: string): boolean {
  const record = records.find((candidate) => candidate.tabId === tabId)
  return !!record?.panes?.some((pane) => pane.paneId === paneId && pane.title === title)
}

async function clientInstanceIdOf(page: Page): Promise<string> {
  const id = await page.evaluate((key) => sessionStorage.getItem(key), CLIENT_INSTANCE_ID_KEY)
  expect(id, 'the page claimed a tabs-registry clientInstanceId').toBeTruthy()
  return id!
}

/** Boot a Freshell window in `context` and wait until it holds `tabIds`. */
async function bootWindow(
  context: BrowserContext,
  serverInfo: { baseUrl: string; token: string },
  tabIds: string[],
): Promise<{ page: Page; harness: TestHarness }> {
  const page = await context.newPage()
  await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  await expect.poll(async () => {
    const state = await harness.getState()
    const ids = (state?.tabs?.tabs ?? []).map((tab: { id: string }) => tab.id)
    return tabIds.every((id) => ids.includes(id))
  }, { timeout: 30_000, message: `the new window rebuilt tabs ${tabIds.join(', ')}` }).toBe(true)
  return { page, harness }
}

/** The single leaf pane id of `tabId`. */
async function onlyPaneId(harness: TestHarness, tabId: string): Promise<string> {
  const state = await harness.getState()
  const layout = state?.panes?.layouts?.[tabId]
  expect(layout?.type, `tab ${tabId} is a single pane`).toBe('leaf')
  return layout.id as string
}

/** Wait until the pane of `tabId` is attached to a live terminal. */
async function terminalIdOf(harness: TestHarness, tabId: string): Promise<string> {
  let terminalId = ''
  await expect.poll(async () => {
    const state = await harness.getState()
    const content = state?.panes?.layouts?.[tabId]?.content
    terminalId = content?.kind === 'terminal' && typeof content.terminalId === 'string' ? content.terminalId : ''
    return terminalId.length > 0
  }, { timeout: 30_000, message: `tab ${tabId} has a terminal` }).toBe(true)
  return terminalId
}

/** Rename the active shell tab and its pane through the UI inline editors. */
async function renameShellTabAndPane(page: Page, harness: TestHarness, tabId: string): Promise<string> {
  const paneId = await onlyPaneId(harness, tabId)
  await renameThroughTabEdit(page, tabId, TAB_NAME)
  await renameThroughPaneHeader(page, PANE_NAME)
  const state = await harness.getState()
  expect(state.tabs.tabs.find((tab: { id: string }) => tab.id === tabId)?.titleSetByUser).toBe(true)
  expect(state.panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBe(true)
  return paneId
}

/** Type a command that sets the window title to INTRUDER, then wait for its
 * computed marker (the marker text never appears in the typed command, so
 * seeing it proves the printf already ran). */
async function sendIntruderTitle(page: Page, harness: TestHarness, tabId: string, terminalId: string, marker: number): Promise<void> {
  await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
  // TerminalView ignores title changes less than 2 s after the previous one
  // (spinner throttle); let any earlier title settle first.
  await page.waitForTimeout(2_500)
  await page.locator(`[data-context="pane"][data-tab-id="${tabId}"] .xterm`).first().click()
  await page.keyboard.type(`printf '\\033]0;${INTRUDER}\\007'; echo osc-$((${marker}+1))-done`)
  await page.keyboard.press('Enter')
  const expected = `osc-${marker + 1}-done`
  await expect.poll(async () => (await harness.getTerminalBuffer(terminalId)) ?? '', {
    timeout: 20_000,
    message: `the shell in ${tabId} ran the title command`,
  }).toContain(expected)
}

test.describe('new-window name restore', () => {
  test.setTimeout(240_000)

  test('a renamed shell tab and pane keep their names in a new window', async ({ freshellPage: page, harness, serverInfo, context }) => {
    const tabId = (await harness.getActiveTabId())!
    const paneId = await renameShellTabAndPane(page, harness, tabId)
    await waitForPersistedRecords(serverInfo.homeDir, await clientInstanceIdOf(page), (records) =>
      hasPaneTitle(records, tabId, paneId, PANE_NAME)
      && records.some((record) => record.tabId === tabId && record.tabName === TAB_NAME))

    await page.close()
    const { page: page2, harness: harness2 } = await bootWindow(context, serverInfo, [tabId])
    try {
      await expect(page2.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)).toContainText(TAB_NAME)
      await expect(page2.locator(`[data-context="pane-header"][data-pane-id="${paneId}"]`)).toContainText(PANE_NAME, { timeout: 15_000 })
      const state = await harness2.getState()
      expect(state.tabs.tabs.find((tab: { id: string }) => tab.id === tabId)?.titleSetByUser).toBe(true)
      expect(state.panes.paneTitles?.[tabId]?.[paneId]).toBe(PANE_NAME)
      expect(state.panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBe(true)
    } finally {
      await harness2.killAllTerminals(serverInfo)
    }
  })

  test('the restored names stay protected from OSC titles', async ({ freshellPage: page, harness, serverInfo, context }) => {
    const tabId = (await harness.getActiveTabId())!
    const paneId = await renameShellTabAndPane(page, harness, tabId)
    // A second shell tab nobody renamed: the control that proves this window
    // does apply OSC titles (so the protected tab's unchanged name means
    // something).
    const controlTabId = 'osc-control-tab'
    await page.evaluate((id) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id } })
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/initLayout',
        payload: { tabId: id, paneId: `${id}-pane`, content: { kind: 'terminal', mode: 'shell' } },
      })
    }, controlTabId)
    await terminalIdOf(harness, controlTabId)
    await waitForPersistedRecords(serverInfo.homeDir, await clientInstanceIdOf(page), (records) =>
      hasPaneTitle(records, tabId, paneId, PANE_NAME)
      && records.some((record) => record.tabId === controlTabId))

    await page.close()
    const { page: page2, harness: harness2 } = await bootWindow(context, serverInfo, [tabId, controlTabId])
    try {
      const terminalId = await terminalIdOf(harness2, tabId)
      const controlTerminalId = await terminalIdOf(harness2, controlTabId)

      await sendIntruderTitle(page2, harness2, tabId, terminalId, 40)
      await sendIntruderTitle(page2, harness2, controlTabId, controlTerminalId, 50)
      await expect(
        page2.locator(`[data-context="tab"][data-tab-id="${controlTabId}"]`),
        'control: an unprotected restored tab takes the OSC title',
      ).toContainText(INTRUDER, { timeout: 15_000 })

      await page2.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
      const tab = page2.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)
      await expect(tab).toContainText(TAB_NAME)
      await expect(tab).not.toContainText(INTRUDER)
      const header = page2.locator(`[data-context="pane-header"][data-pane-id="${paneId}"]`)
      await expect(header).toContainText(PANE_NAME)
      await expect(header).not.toContainText(INTRUDER)
      const state = await harness2.getState()
      const restoredTab = state.tabs.tabs.find((candidate: { id: string }) => candidate.id === tabId)
      expect(restoredTab?.title).toBe(TAB_NAME)
      expect(restoredTab?.titleSetByUser).toBe(true)
      expect(state.panes.paneTitles?.[tabId]?.[paneId]).toBe(PANE_NAME)
      expect(state.panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBe(true)
    } finally {
      await harness2.killAllTerminals(serverInfo)
    }
  })

  test('a browser pane title survives a new browser context', async ({ freshellPage: page, harness, serverInfo, browser, e2eMachineId }) => {
    const tabId = 'tab-docs'
    const paneId = 'pane-docs'
    await page.evaluate(({ tabId, paneId }) => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'tabs/addTab', payload: { id: tabId } })
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'panes/initLayout',
        payload: { tabId, paneId, content: { kind: 'browser', url: 'https://example.com/docs' } },
      })
    }, { tabId, paneId })
    await expect.poll(() => harness.getActiveTabId()).toBe(tabId)
    await renameThroughPaneHeader(page, BROWSER_PANE_NAME)
    expect((await harness.getState()).panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBe(true)
    await waitForPersistedRecords(serverInfo.homeDir, await clientInstanceIdOf(page), (records) =>
      hasPaneTitle(records, tabId, paneId, BROWSER_PANE_NAME))

    // A different browser profile: nothing shared with window 1 except the
    // selected machine.
    const otherContext = await createE2eBrowserContext(browser, serverInfo, e2eMachineId)
    installRecoveryOfferAutoDeclineOnContext(otherContext)
    try {
      const { page: page2, harness: harness2 } = await bootWindow(otherContext, serverInfo, [tabId])
      await page2.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
      await expect(page2.locator(`[data-context="pane-header"][data-pane-id="${paneId}"]`)).toContainText(BROWSER_PANE_NAME, { timeout: 15_000 })
      await expect(page2.locator(`[data-context="tab"][data-tab-id="${tabId}"]`)).toContainText(BROWSER_PANE_NAME)
      const state = await harness2.getState()
      expect(state.panes.paneTitles?.[tabId]?.[paneId]).toBe(BROWSER_PANE_NAME)
      expect(state.panes.paneTitleSetByUser?.[tabId]?.[paneId]).toBe(true)
    } finally {
      await otherContext.close().catch(() => {})
    }
  })
})
