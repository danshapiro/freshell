import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Page } from '@playwright/test'
import { expect } from './fixtures.js'
import type { TestHarness } from './test-harness.js'

// Shared reads for the name-reliability specs that check where a tab or pane
// name is STORED, not only what the tab bar shows: the Redux state, this
// window's persisted layout, the server's layout mirror (GET /api/tabs) and
// the server's persisted tabs-registry generations.

export const CLIENT_INSTANCE_ID_KEY = 'freshell.tabs.client-instance-id.v1'
export const LAYOUT_WINDOW_ID_KEY = 'freshell.layout-window-id.v1'

export type StoredTabTitle = { title?: string; titleSetByUser?: boolean }

export type RegistryRecord = {
  tabId?: string
  tabName?: string
  titleSetByUser?: boolean
  panes?: Array<{ paneId?: string; title?: string; titleSetByUser?: boolean }>
}

type LayoutNode = { type: 'leaf'; id: string; content?: { kind?: string; terminalId?: unknown } }
  | { type: 'split'; children: [LayoutNode, LayoutNode] }

/** The tab's stored title and rename flag in the Redux store. */
export async function reduxTab(harness: TestHarness, tabId: string): Promise<StoredTabTitle | null> {
  const state = await harness.getState()
  const tab = (state?.tabs?.tabs ?? []).find((candidate: { id: string }) => candidate.id === tabId)
  return tab ? { title: tab.title, titleSetByUser: tab.titleSetByUser } : null
}

/** The tab's stored title and rename flag in this window's persisted layout. */
export async function persistedTab(page: Page, tabId: string): Promise<StoredTabTitle | null> {
  return page.evaluate(({ id, windowIdKey }) => {
    const windowId = sessionStorage.getItem(windowIdKey)
    const raw = windowId ? localStorage.getItem(`freshell.layout.v3.${windowId}`) : null
    if (!raw) return null
    const layout = JSON.parse(raw) as { tabs?: { tabs?: Array<{ id: string; title?: string; titleSetByUser?: boolean }> } }
    const tab = layout.tabs?.tabs?.find((candidate) => candidate.id === id)
    return tab ? { title: tab.title, titleSetByUser: tab.titleSetByUser } : null
  }, { id: tabId, windowIdKey: LAYOUT_WINDOW_ID_KEY })
}

/** The tab title the server's layout mirror reports (GET /api/tabs). */
export async function serverTabTitle(serverInfo: { baseUrl: string; token: string }, tabId: string): Promise<string | null> {
  const response = await fetch(`${serverInfo.baseUrl}/api/tabs`, {
    headers: { 'x-auth-token': serverInfo.token },
  })
  if (!response.ok) return null
  const payload = await response.json() as { data?: { tabs?: Array<{ id: string; title?: string }> }; tabs?: Array<{ id: string; title?: string }> }
  const tabs = payload.data?.tabs ?? payload.tabs ?? []
  return tabs.find((tab) => tab.id === tabId)?.title ?? null
}

export async function clientInstanceIdOf(page: Page): Promise<string> {
  const id = await page.evaluate((key) => sessionStorage.getItem(key), CLIENT_INSTANCE_ID_KEY)
  expect(id, 'the page claimed a tabs-registry clientInstanceId').toBeTruthy()
  return id!
}

/**
 * Wait until the NEWEST persisted tabs-snapshot generation of
 * `clientInstanceId` satisfies `predicate` (pushes fire on change and every
 * 5 s, so the generation files lag the UI; reading them proves what the
 * server durably holds). With `capturedSince`, only a generation the server
 * captured at or after that time counts, so an older generation can never
 * satisfy the check by itself.
 */
export async function waitForPersistedRecords(
  homeDir: string,
  clientInstanceId: string,
  predicate: (records: RegistryRecord[]) => boolean,
  opts: { timeoutMs?: number; capturedSince?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000
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
        if (!newest || capturedAt > newest.capturedAt
          || (capturedAt === newest.capturedAt && revision > newest.revision)) {
          newest = { revision, capturedAt, records: Array.isArray(doc.records) ? doc.records : [] }
        }
      }
      if (newest && newest.capturedAt >= (opts.capturedSince ?? Number.NEGATIVE_INFINITY)) {
        lastObserved = JSON.stringify(newest.records.map((record) => ({
          tabId: record.tabId,
          tabName: record.tabName,
          titleSetByUser: record.titleSetByUser,
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

function findLeaf(node: LayoutNode | undefined, paneId: string): Extract<LayoutNode, { type: 'leaf' }> | undefined {
  if (!node) return undefined
  if (node.type === 'leaf') return node.id === paneId ? node : undefined
  return findLeaf(node.children[0], paneId) ?? findLeaf(node.children[1], paneId)
}

/** The tab's pane ids, depth-first left to right. */
export function leafIds(node: LayoutNode | undefined): string[] {
  if (!node) return []
  if (node.type === 'leaf') return [node.id]
  return [...leafIds(node.children[0]), ...leafIds(node.children[1])]
}

/** Wait until pane `paneId` of `tabId` is attached to a terminal. */
export async function terminalIdOf(harness: TestHarness, tabId: string, paneId: string): Promise<string> {
  let terminalId = ''
  await expect.poll(async () => {
    const state = await harness.getState()
    const content = findLeaf(state?.panes?.layouts?.[tabId], paneId)?.content
    terminalId = content?.kind === 'terminal' && typeof content.terminalId === 'string' ? content.terminalId : ''
    return terminalId.length > 0
  }, { timeout: 30_000, message: `pane ${paneId} has a terminal` }).toBe(true)
  return terminalId
}

/** Type a command that sets the window title (OSC 0) to `title` into pane
 * `paneId`, then wait for its computed marker (the marker text never appears
 * in the typed command, so seeing it proves the printf already ran). */
export async function sendWindowTitle(
  page: Page,
  harness: TestHarness,
  target: { tabId: string; paneId: string; title: string; marker: number },
): Promise<void> {
  const { tabId, paneId, title, marker } = target
  const terminalId = await terminalIdOf(harness, tabId, paneId)
  await page.locator(`[data-context="tab"][data-tab-id="${tabId}"]`).click()
  // TerminalView ignores title changes less than 2 s after the previous one
  // (spinner throttle); let any earlier title settle first.
  await page.waitForTimeout(2_500)
  await page.locator(`[data-context="pane"][data-pane-id="${paneId}"] .xterm`).first().click()
  await page.keyboard.type(`printf '\\033]0;${title}\\007'; echo osc-$((${marker}+1))-done`)
  await page.keyboard.press('Enter')
  const expected = `osc-${marker + 1}-done`
  await expect.poll(async () => (await harness.getTerminalBuffer(terminalId)) ?? '', {
    timeout: 20_000,
    message: `the shell in pane ${paneId} ran the title command`,
  }).toContain(expected)
}
