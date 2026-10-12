import type { Page } from '@playwright/test'
import { resolvePairedExternalFixture } from '../../../scripts/testing/e2e-external-target.js'
import { test, expect } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TestHarness } from '../helpers/test-harness.js'

const paired = resolvePairedExternalFixture(process.env, true)
if (paired?.kind !== 'managed-environment') throw new Error('Managed environment requires its paired owned target')
const fixture = paired.fixture
const headers = { 'x-auth-token': paired.targetToken }

async function json(page: Page, route: string) {
  const response = await page.request.get(`${paired!.targetUrl}${route}`, { headers, timeout: 30_000 })
  expect(response.ok()).toBe(true)
  return response.json()
}

async function readReceipt(page: Page, selected: string): Promise<any | null> {
  const response = await page.request.get(`${paired!.targetUrl}/api/files/read?path=${encodeURIComponent(selected)}`,
    { headers, timeout: 30_000 })
  if (response.status() === 404) return null
  expect(response.ok()).toBe(true)
  return JSON.parse((await response.json()).content)
}

async function activePane(page: Page) {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__!.getState()
    const root = state.panes.layouts[state.tabs.activeTabId!]
    if (root?.type !== 'leaf') throw new Error('Expected the real picker to have one leaf pane')
    return { tabId: state.tabs.activeTabId!, paneId: root.id, content: root.content }
  })
}

async function launch(page: Page, scenario: string) {
  await page.goto(`${paired!.targetUrl}/?token=${encodeURIComponent(paired!.targetToken)}&e2e=1`)
  await page.waitForFunction(() => Boolean(window.__FRESHELL_TEST_HARNESS__), undefined, { timeout: 60_000 })
  await new TestHarness(page).waitForConnection(120_000)
  const info = await json(page, '/api/server-info')
  expect(info.runtime).toBe('rust')
  expect(info.commit).toBe(fixture.candidateSha)
  expect(info.buildDirty).toBe(false)
  const readiness = await json(page, '/api/runtime/readiness')
  expect(readiness.readiness.initialScanState).toBe('complete')
  expect(await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getReceivedWsMessages?.()
    .some((message: any) => message.type === 'ready' && message.capabilities?.managedRuntimeV1 === true))).toBe(true)

  const add = page.locator('[data-context="tab-add"]')
  if (await add.isVisible()) await add.click()
  const picker = await openPanePicker(page)
  const before = await activePane(page)
  // Authorize the actual UI-generated request before its normal create effect runs.
  // The existing test harness suppresses effects only for this picker leaf.
  await page.evaluate(id => window.__FRESHELL_TEST_HARNESS__!.setTerminalNetworkEffectsSuppressed(id, true), before.paneId)
  await picker.getByRole('button', { name: /^OpenCode$/ }).click()
  const cwd = `${fixture.remoteWorkspacePath}/${scenario}`
  const directory = page.getByRole('combobox', { name: /Starting directory for OpenCode/i })
  await directory.fill(cwd)
  await directory.press('Enter')
  await expect.poll(async () => (await activePane(page)).content.kind).toBe('terminal')
  const selected = await activePane(page)
  if (selected.content.kind !== 'terminal') throw new Error('The OpenCode picker did not create terminal content')
  expect(selected.paneId).toBe(before.paneId)
  expect(selected.content.mode).toBe('opencode')
  expect(selected.content.createRequestId).toBeTruthy()
  const request = { ...fixture, scenario, createRequestId: selected.content.createRequestId, paneId: selected.paneId }
  const written = await page.request.post(`${paired!.targetUrl}/api/files/write`, { headers,
    data: { path: `${cwd}/.managed-fixture/request.json`, content: JSON.stringify(request) } })
  expect(written.ok()).toBe(true)
  await expect.poll(async () => readReceipt(page, `${cwd}/.managed-fixture/authorized.json`),
    { timeout: 120_000 }).toMatchObject({ candidateSha: fixture.candidateSha, runId: fixture.runId,
      expectedNonce: fixture.expectedNonce, createRequestId: selected.content.createRequestId })
  await page.evaluate(id => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    harness.setTerminalNetworkEffectsSuppressed(id, false)
    const state = harness.getState()
    const tabId = state.tabs.activeTabId!
    const root = state.panes.layouts[tabId]
    if (root?.type !== 'leaf' || root.id !== id) throw new Error('The selected picker leaf changed')
    harness.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId: id, content: { ...root.content } } })
  }, selected.paneId)
  await expect.poll(async () => {
    const pane = await activePane(page)
    return pane.content.kind === 'terminal' ? pane.content.terminalId : null
  }, { timeout: 120_000 }).toBeTruthy()
  return { ...(await activePane(page)), cwd, createRequestId: selected.content.createRequestId }
}

test('executes selected resources with Bun in both managed stages and retains identity on reconnect', async ({ page }) => {
  test.setTimeout(360_000)
  const pane = await launch(page, 'healthy')
  if (pane.content.kind !== 'terminal') throw new Error('Expected the real OpenCode terminal')
  const terminalId = pane.content.terminalId!
  const marker = `MANAGED_ENV_OUTPUT ${fixture.expectedNonce}`
  await expect.poll(() => page.evaluate(id => window.__FRESHELL_TEST_HARNESS__!.getTerminalBuffer(id), terminalId),
    { timeout: 120_000 }).toContain(marker)
  let receipt: any
  await expect.poll(async () => {
    receipt = await readReceipt(page, `${pane.cwd}/.managed-fixture/target-receipt.json`)
    return receipt
  }, { timeout: 120_000 }).toMatchObject({ candidateSha: fixture.candidateSha, runId: fixture.runId,
    expectedNonce: fixture.expectedNonce, terminalId, stage: { observed: true }, child: {
      terminalId, bun: true, dependency: fixture.expectedNonce, resource: fixture.expectedNonce,
      absoluteReference: fixture.expectedNonce, relativeReference: fixture.expectedNonce, executableMode: '0711',
    } })
  expect(receipt.soulId).toBeTruthy()
  expect(receipt.incarnationId).toBeTruthy()
  expect(receipt.nativeSessionId).toBeTruthy()
  const beforeCreates = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.()
    .filter((message: any) => message.type === 'terminal.create').length)
  await new TestHarness(page).forceDisconnect()
  await new TestHarness(page).waitForConnection(120_000)
  await expect.poll(async () => (await activePane(page)).content).toMatchObject({ terminalId,
    sessionRef: { provider: 'opencode', sessionId: receipt.nativeSessionId } })
  await expect.poll(() => page.evaluate(id => window.__FRESHELL_TEST_HARNESS__!.getTerminalBuffer(id), terminalId)).toContain(marker)
  expect(await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.()
    .filter((message: any) => message.type === 'terminal.create').length)).toBe(beforeCreates)
  const rows = await json(page, '/api/terminals')
  expect(rows.find((row: any) => row.terminalId === terminalId)).toMatchObject({ terminalId,
    soulId: receipt.soulId, incarnationId: receipt.incarnationId, runtimeStatus: 'running' })
})

for (const scenario of ['missing-reference', 'startup-before-identity']) {
  test(`${scenario} retains an actionable blocked result without a replacement conversation`, async ({ page }) => {
    test.setTimeout(300_000)
    const pane = await launch(page, scenario)
    if (pane.content.kind !== 'terminal') throw new Error('Expected the retained managed terminal')
    const terminalId = pane.content.terminalId!
    let row: any
    await expect.poll(async () => {
      row = (await json(page, '/api/terminals')).find((item: any) => item.terminalId === terminalId)
      return row
    }, { timeout: 120_000 }).toMatchObject({ terminalId, runtimeStatus: 'blocked', recoverySummary: { recoveryState: 'blocked' } })
    expect(row.recoverySummary.reason).toBeTruthy()
    expect(row.sessionRef).toBeUndefined()
    const diagnostic = page.locator('[data-testid="terminal-work-area"]')
    await expect(diagnostic).toContainText(/blocked|unable|failed/i)
    await expect(diagnostic).toContainText(scenario === 'missing-reference' ? /missing-selected/i : /startup-fixture/i)
    const creates = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.()
      .filter((message: any) => message.type === 'terminal.create').length)
    await new TestHarness(page).forceDisconnect()
    await new TestHarness(page).waitForConnection(120_000)
    expect((await activePane(page)).content).toMatchObject({ terminalId, status: 'error' })
    expect(await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.()
      .filter((message: any) => message.type === 'terminal.create').length)).toBe(creates)
    expect((await json(page, '/api/terminals')).filter((item: any) => item.cwd === pane.cwd)).toHaveLength(1)
  })
}
