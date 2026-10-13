import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { resolvePairedExternalFixture } from '../../../scripts/testing/e2e-external-target.js'
import { test, expect } from '../helpers/fixtures.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TestHarness } from '../helpers/test-harness.js'

const paired = resolvePairedExternalFixture(process.env, true)
if (paired?.kind !== 'code-checkpoint') throw new Error('Code checkpoint acceptance requires its paired owned target')
const fixture = paired.fixture
const headers = { 'x-auth-token': paired.targetToken }
const checkpointRoot = '/tmp/freshell-checkpoint-fixture'
const controlRequestPath = `${checkpointRoot}/control/request.json`

type FixtureTurn = {
  id: string
  items: Array<{ type?: string; id?: string; content?: Array<{ text?: string }> }>
}

type CheckpointOutcome = {
  requestId: string
  conversationRequestId?: string
  displayTurnId?: string
  nativeTurnId?: string
  status: 'available' | 'unavailable'
  checkpointId?: string
  workspace?: { path: string; provenance: string }
  code?: string
  reason?: string
}

async function currentFreshAgent(page: import('@playwright/test').Page): Promise<{
  tabId: string
  paneId: string
  content: any
}> {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__!.getState()
    const tabId = state.tabs.activeTabId
    if (!tabId) throw new Error('There is no active tab')
    const root = state.panes.layouts[tabId]
    const find = (node: any, found: any[] = []): any[] => {
      if (!node) return found
      if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') found.push(node)
      if (node.type === 'split') for (const child of node.children ?? []) find(child, found)
      return found
    }
    const candidates = find(root)
    if (candidates.length !== 1) throw new Error(`Expected one fresh-agent pane; found ${candidates.length}`)
    const leaf = candidates[0]
    return { tabId, paneId: leaf.id, content: leaf.content }
  })
}

async function targetRead(page: import('@playwright/test').Page, selected: string): Promise<string | undefined> {
  const response = await page.request.get(`${paired!.targetUrl}/api/files/read?path=${encodeURIComponent(selected)}`,
    { headers, timeout: 30_000 })
  if (response.status() === 404) return undefined
  expect(response.ok(), `Reading synthetic target file failed with HTTP ${response.status()}`).toBe(true)
  const body = await response.json() as { content?: unknown }
  expect(typeof body.content).toBe('string')
  return body.content as string
}

async function targetWrite(page: import('@playwright/test').Page, selected: string, content: string): Promise<void> {
  const response = await page.request.post(`${paired!.targetUrl}/api/files/write`, {
    headers,
    timeout: 30_000,
    data: { path: selected, content },
  })
  expect(response.ok(), `Writing synthetic target file failed with HTTP ${response.status()}`).toBe(true)
}

async function targetJson<T>(page: import('@playwright/test').Page, selected: string): Promise<T | undefined> {
  const content = await targetRead(page, selected)
  return content === undefined ? undefined : JSON.parse(content) as T
}

async function verifyTarget(page: import('@playwright/test').Page): Promise<void> {
  const response = await page.request.get(`${paired!.targetUrl}/api/server-info`, { headers, timeout: 30_000 })
  expect(response.ok()).toBe(true)
  const info = await response.json() as { runtime?: unknown; commit?: unknown; buildDirty?: unknown }
  expect(info).toMatchObject({ runtime: 'rust', commit: fixture.candidateSha, buildDirty: false })

  const platformResponse = await page.request.get(`${paired!.targetUrl}/api/platform`, { headers, timeout: 30_000 })
  expect(platformResponse.ok()).toBe(true)
  const platform = await platformResponse.json() as { availableClis?: Record<string, boolean> }
  expect(platform.availableClis?.codex,
    'The synthetic target must expose Codex so Freshcodex is selectable in the pane picker').toBe(true)

  const extensionsResponse = await page.request.get(`${paired!.targetUrl}/api/extensions`, { headers, timeout: 30_000 })
  expect(extensionsResponse.ok()).toBe(true)
  const extensions = await extensionsResponse.json() as Array<{ name?: unknown; category?: unknown }>
  expect(extensions).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'codex', category: 'cli' }),
  ]))
}

async function launchCodex(page: import('@playwright/test').Page, workspace: string) {
  await page.goto(`${paired!.targetUrl}/?token=${encodeURIComponent(paired!.targetToken)}&e2e=1`, { timeout: 60_000 })
  const harness = new TestHarness(page)
  await harness.waitForHarness(60_000)
  await harness.waitForConnection(120_000)
  await verifyTarget(page)

  const picker = await openPanePicker(page)
  const freshcodex = picker.getByRole('button', { name: /^Freshcodex$/i })
  await expect(freshcodex,
    'The enabled Codex runtime must have a visible Freshcodex option before launch').toBeVisible({ timeout: 10_000 })
  await freshcodex.click({ force: true })
  const directoryInput = page.getByRole('combobox', { name: 'Starting directory for Freshcodex' })
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(workspace)
  await directoryInput.press('Enter')

  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  await expect(paneRoot).toBeVisible({ timeout: 30_000 })
  await expect.poll(async () => (await currentFreshAgent(page)).content.initialCwd, { timeout: 30_000 }).toBe(workspace)
  await expect.poll(async () => (await currentFreshAgent(page)).content.status, { timeout: 120_000 }).toBe('idle')
  await expect.poll(async () => {
    const content = (await currentFreshAgent(page)).content
    return content.sessionRef?.sessionId ?? content.sessionId
  }, { timeout: 120_000 }).toBeTruthy()
  return { paneRoot, harness, ...(await currentFreshAgent(page)) }
}

async function sendThroughComposer(
  page: import('@playwright/test').Page,
  paneRoot: import('@playwright/test').Locator,
  text: string,
  expectedWorkspace: { path: string; provenance: 'directory-picker' | 'resolved-project' } | undefined,
) {
  await expect.poll(async () => (await currentFreshAgent(page)).content.status, { timeout: 60_000 }).toBe('idle')
  const baseline = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.().length ?? 0)
  await paneRoot.getByRole('textbox', { name: 'Chat message input' }).fill(text)
  await paneRoot.getByRole('button', { name: 'Send' }).click()

  let sent: any
  await expect.poll(async () => {
    const frames = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getSentWsMessages?.() ?? []) as any[]
    sent = frames.slice(baseline).find(frame => frame.type === 'freshAgent.send' && frame.text === text)
    return sent
  }, { timeout: 30_000 }).toBeTruthy()
  expect(sent.requestId).toEqual(expect.any(String))
  expect(sent.checkpointIntent).toMatchObject({ logicalAttemptId: expect.any(String) })
  if (expectedWorkspace) {
    expect(sent.checkpointIntent.workspace).toEqual(expectedWorkspace)
  } else {
    expect(sent.checkpointIntent).not.toHaveProperty('workspace')
  }

  let accepted: any
  await expect.poll(async () => {
    const frames = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getReceivedWsMessages?.() ?? []) as any[]
    accepted = frames.find(frame => frame.type === 'freshAgent.send.accepted' && frame.requestId === sent.requestId)
    return accepted
  }, { timeout: 120_000 }).toBeTruthy()
  expect(accepted.submittedTurnId).toEqual(expect.any(String))

  let outcome: CheckpointOutcome | undefined
  await expect.poll(async () => {
    const content = (await currentFreshAgent(page)).content
    outcome = content.checkpointOutcomes?.find((entry: CheckpointOutcome) => entry.requestId === sent.requestId)
    // The send barrier's first outcome is deliberately pre-forward and may
    // not yet know Codex's persisted user row. Require the later updated
    // native-linked projection before treating the per-turn result as ready.
    return outcome !== undefined
      && outcome.nativeTurnId === accepted.submittedTurnId
      && outcome.displayTurnId === `${accepted.submittedTurnId}:row-0`
  }, { timeout: 120_000 }).toBe(true)
  expect(outcome!.requestId).toBe(sent.requestId)
  expect(outcome!.conversationRequestId).toBe((await currentFreshAgent(page)).content.createRequestId)
  expect(outcome!.displayTurnId).toBe(`${accepted.submittedTurnId}:row-0`)
  expect(outcome!.nativeTurnId).toBe(accepted.submittedTurnId)
  expect(JSON.stringify((await currentFreshAgent(page)).content.checkpointOutcomes)).not.toContain(text)

  // Repeated prompts are intentional in this acceptance case. The freshly
  // accepted turn is the newest matching user row; requiring the locator to
  // be unique would make the second send fail before its identity assertions.
  const row = paneRoot.locator('article[data-turn-role="user"]', { hasText: text }).last()
  await expect(row).toBeVisible({ timeout: 30_000 })
  return { sent, accepted, outcome: outcome!, row }
}

async function assertNativeUserIdentity(
  page: import('@playwright/test').Page,
  outcome: CheckpointOutcome,
  acceptedTurnId: string,
  text: string,
): Promise<FixtureTurn> {
  const content = (await currentFreshAgent(page)).content
  const sessionId = content.sessionRef?.sessionId ?? content.sessionId
  expect(sessionId).toEqual(expect.any(String))
  let turns: FixtureTurn[] | undefined
  const selected = `${fixture.syntheticHomePath}/.codex/fake-turns/${sessionId}.json`
  await expect.poll(async () => {
    turns = await targetJson<FixtureTurn[]>(page, selected)
    return turns?.find(turn => turn.id === acceptedTurnId)
  }, { timeout: 60_000 }).toBeTruthy()
  const turn = turns!.find(candidate => candidate.id === acceptedTurnId)!
  const user = turn.items.find(item => item.type === 'userMessage'
    && item.content?.some(part => part.text === text))
  expect(user?.id).toBe(`${acceptedTurnId}:user`)
  // The persisted checkpoint outcome must point at the provider turn identity
  // and the projected user-row identity. The raw user-message item has its own
  // item id, which is not either checkpoint join key.
  expect(outcome.nativeTurnId).toBe(acceptedTurnId)
  expect(outcome.displayTurnId).toBe(`${acceptedTurnId}:row-0`)
  return turn
}

async function requestPrivateFileState(
  page: import('@playwright/test').Page,
  action: 'eligible' | 'ignored',
): Promise<void> {
  const requestId = randomUUID()
  const ackPath = `${checkpointRoot}/control/ack-${requestId}.json`
  await targetWrite(page, controlRequestPath, JSON.stringify({ action, expectedNonce: fixture.expectedNonce, requestId }))
  await expect.poll(() => targetJson(page, ackPath), { timeout: 30_000 }).toMatchObject({
    requestId,
    action,
    restrictedUid: fixture.restrictedUid,
    privateFileUid: 0,
    privateFileMode: '0600',
    privateFileDenied: true,
    effectiveCapabilities: '0000000000000000',
  })
}

async function flushLayoutAndReload(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.dispatch({ type: 'persist/flushNow' }))
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .filter(key => key.startsWith('freshell.layout.v3.'))
    .some(key => localStorage.getItem(key)?.includes('checkpointOutcomes') ?? false))).toBe(true)
  await page.reload({ timeout: 60_000 })
  const harness = new TestHarness(page)
  await harness.waitForHarness(60_000)
  await harness.waitForConnection(120_000)
  await expect(page.locator('[data-context="fresh-agent"]')).toBeVisible({ timeout: 30_000 })
}

async function openSessionFromHistory(
  page: import('@playwright/test').Page,
  paneRoot: import('@playwright/test').Locator,
  projectPath: string,
  sessionId: string,
  checkpointWorkspace: { path: string; provenance: 'directory-picker' },
) {
  await expect.poll(async () => {
    const response = await page.request.get(
      `${paired!.targetUrl}/api/session-directory?priority=visible&limit=50`,
      { headers },
    )
    expect(response.ok()).toBe(true)
    const payload = await response.json() as { items: Array<{
      sessionId: string
      projectPath: string
      checkpointWorkspace?: { path: string; provenance: string }
    }> }
    return payload.items.find((item) => item.sessionId === sessionId)
  }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toMatchObject({
    projectPath,
    checkpointWorkspace,
  })

  // Closing the seed pane makes History restore from its directory projection,
  // which proves the explicit workspace provenance survived session metadata.
  await paneRoot.getByRole('button', { name: 'Close pane' }).click()
  await expect(page.locator('[data-context="fresh-agent"]')).toHaveCount(0, { timeout: 30_000 })
  await page.locator('button[title="Projects (Ctrl+B P)"]').click()
  const projectHeader = page.locator(`[data-project-path="${projectPath}"]`)
  await expect(projectHeader).toBeVisible({ timeout: 30_000 })
  await projectHeader.click()
  const historyRow = page.locator(`[data-context="history-session"][data-session-id="${sessionId}"]`)
  await expect(historyRow).toBeVisible({ timeout: 30_000 })
  await historyRow.getByRole('button', { name: 'Open session' }).click()

  const reopenedPane = page.locator('[data-context="fresh-agent"]').last()
  await expect.poll(async () => (await currentFreshAgent(page)).content.checkpointWorkspace)
    .toEqual(checkpointWorkspace)
  return reopenedPane
}

async function verifyPickerWorkspaceReopensForRewind(
  page: import('@playwright/test').Page,
  workspacePath: string,
  fileName: string,
  label: string,
): Promise<void> {
  await verifyTarget(page)
  const selectedWorkspace = { path: workspacePath, provenance: 'directory-picker' as const }
  const file = `${workspacePath}/${fileName}`
  await targetWrite(page, file, `${label} before first turn\n`)
  const { paneRoot } = await launchCodex(page, workspacePath)
  const initial = await currentFreshAgent(page)
  const sessionId = initial.content.sessionRef?.sessionId ?? initial.content.sessionId
  expect(sessionId).toEqual(expect.any(String))
  const initialTurn = await sendThroughComposer(page, paneRoot, `${label} seed ${fixture.expectedNonce}`, selectedWorkspace)
  expect(initialTurn.outcome.status).toBe('available')

  const reopenedPane = await openSessionFromHistory(
    page, paneRoot, workspacePath, sessionId, selectedWorkspace,
  )
  const beforeTurn = `${label} before reopened turn\n`
  await targetWrite(page, file, beforeTurn)
  const turn = await sendThroughComposer(page, reopenedPane, `${label} reopened ${fixture.expectedNonce}`, selectedWorkspace)
  expect(turn.outcome).toMatchObject({ status: 'available', workspace: selectedWorkspace })

  await targetWrite(page, file, `${label} changed after reopened turn\n`)
  await turn.row.hover()
  const rewind = turn.row.getByRole('button', { name: 'Rewind code to here' })
  await expect(rewind).toBeEnabled()
  const rewindNotice = expect(reopenedPane.getByRole('alert').filter({ hasText: /Code rewound to before:/ }))
    .toContainText('Automatic pre-turn snapshot', { timeout: 30_000 })
  const dialogAccepted = page.waitForEvent('dialog').then((dialog) => dialog.accept())
  await rewind.click()
  await Promise.all([dialogAccepted, rewindNotice])
  await expect.poll(() => targetRead(page, file)).toBe(beforeTurn)
}

test('Git workspace sends retain per-turn success and failure, then restore the exact successful row', async ({ page }) => {
  test.setTimeout(360_000)
  await verifyTarget(page)
  // Cloud retries reuse the owned synthetic target. Restore the mutable code
  // and the private file's ignored state so every attempt starts from the
  // same readable checkpoint fixture even if a prior attempt failed midway.
  await targetWrite(page, `${fixture.syntheticWorkspacePath}/main.rs`, 'main before checkpoint\n')
  await targetWrite(page, `${fixture.syntheticWorkspacePath}/notes.txt`, 'notes before checkpoint\n')
  await requestPrivateFileState(page, 'ignored')
  const { paneRoot } = await launchCodex(page, fixture.syntheticWorkspacePath)
  const before = await currentFreshAgent(page)
  expect(before.content.checkpointWorkspace).toEqual({ path: fixture.syntheticWorkspacePath, provenance: 'directory-picker' })
  const originalSessionId = before.content.sessionRef?.sessionId ?? before.content.sessionId
  const originalModel = before.content.model
  expect(originalSessionId).toBeTruthy()

  const samePrompt = `checkpoint same prompt ${fixture.expectedNonce}`
  const first = await sendThroughComposer(page, paneRoot, samePrompt,
    { path: fixture.syntheticWorkspacePath, provenance: 'directory-picker' })
  expect(first.outcome).toMatchObject({ status: 'available', workspace: {
    path: fixture.syntheticWorkspacePath, provenance: 'directory-picker',
  } })
  expect(first.outcome.checkpointId).toMatch(/^[a-f0-9]{40}$/)
  await expect(first.row.getByRole('status', { name: 'Code rewind available for this message' }))
    .toContainText('Code rewind is available for this message.')
  await first.row.hover()
  await expect(first.row.getByRole('button', { name: 'Rewind code to here' })).toBeEnabled()
  await assertNativeUserIdentity(page, first.outcome, first.accepted.submittedTurnId, samePrompt)

  await targetWrite(page, `${fixture.syntheticWorkspacePath}/main.rs`, 'main changed after first send\n')
  await targetWrite(page, `${fixture.syntheticWorkspacePath}/notes.txt`, 'notes changed after first send\n')
  await requestPrivateFileState(page, 'eligible')
  const second = await sendThroughComposer(page, paneRoot, samePrompt,
    { path: fixture.syntheticWorkspacePath, provenance: 'directory-picker' })
  expect(second.sent.checkpointIntent.logicalAttemptId).not.toBe(first.sent.checkpointIntent.logicalAttemptId)
  expect(second.accepted.requestId).not.toBe(first.accepted.requestId)
  expect(second.outcome).toMatchObject({ status: 'unavailable', code: 'checkpoint_path_unreadable' })
  expect(second.outcome.reason).toContain('A selected project file could not be read')
  await expect.poll(async () => paneRoot.locator('article[data-turn-role="user"]', { hasText: samePrompt }).count())
    .toBe(2)
  const firstRow = paneRoot.locator('article[data-turn-role="user"]', { hasText: samePrompt }).nth(0)
  const secondRow = paneRoot.locator('article[data-turn-role="user"]', { hasText: samePrompt }).nth(1)
  await expect(firstRow.getByRole('status', { name: 'Code rewind available for this message' })).toBeVisible()
  await expect(secondRow.getByRole('note', { name: 'Code rewind unavailable for this message' }))
    .toContainText('A selected project file could not be read')
  await secondRow.hover()
  await expect(secondRow.getByRole('button', { name: 'Rewind unavailable for this message' })).toBeDisabled()
  await assertNativeUserIdentity(page, second.outcome, second.accepted.submittedTurnId, samePrompt)
  await requestPrivateFileState(page, 'ignored')

  const beforeReloadOutcomes = (await currentFreshAgent(page)).content.checkpointOutcomes as CheckpointOutcome[]
  expect(beforeReloadOutcomes).toEqual(expect.arrayContaining([
    expect.objectContaining({ requestId: first.sent.requestId, nativeTurnId: first.outcome.nativeTurnId,
      status: 'available', checkpointId: first.outcome.checkpointId }),
    expect.objectContaining({ requestId: second.sent.requestId, nativeTurnId: second.outcome.nativeTurnId,
      status: 'unavailable', code: 'checkpoint_path_unreadable' }),
  ]))
  await flushLayoutAndReload(page)
  const afterReload = await currentFreshAgent(page)
  expect(afterReload.content.checkpointOutcomes).toEqual(expect.arrayContaining([
    expect.objectContaining({ requestId: first.sent.requestId, nativeTurnId: first.outcome.nativeTurnId,
      status: 'available', checkpointId: first.outcome.checkpointId }),
    expect.objectContaining({ requestId: second.sent.requestId, nativeTurnId: second.outcome.nativeTurnId,
      status: 'unavailable', code: 'checkpoint_path_unreadable' }),
  ]))
  expect(afterReload.content.sessionRef?.sessionId ?? afterReload.content.sessionId).toBe(originalSessionId)
  expect(afterReload.content.model).toBe(originalModel)

  const restoredPane = page.locator('[data-context="fresh-agent"]').last()
  const duplicateRows = restoredPane.locator('article[data-turn-role="user"]', { hasText: samePrompt })
  await expect(duplicateRows).toHaveCount(2, { timeout: 60_000 })
  await expect(duplicateRows.nth(0).getByRole('status', { name: 'Code rewind available for this message' })).toBeVisible()
  await expect(duplicateRows.nth(1).getByRole('note', { name: 'Code rewind unavailable for this message' })).toBeVisible()
  await duplicateRows.nth(0).hover()
  const rewind = duplicateRows.nth(0).getByRole('button', { name: 'Rewind code to here' })
  await expect(rewind).toBeEnabled()
  const rewindNotice = expect(restoredPane.getByRole('alert').filter({ hasText: /Code rewound to before:/ }))
    .toContainText('Automatic pre-turn snapshot', { timeout: 30_000 })
  const dialogAccepted = page.waitForEvent('dialog').then(dialog => dialog.accept())
  await rewind.click()
  await Promise.all([dialogAccepted, rewindNotice])
  await expect.poll(() => targetRead(page, `${fixture.syntheticWorkspacePath}/main.rs`)).toBe('main before checkpoint\n')
  await expect.poll(() => targetRead(page, `${fixture.syntheticWorkspacePath}/notes.txt`)).toBe('notes before checkpoint\n')
  await expect(duplicateRows).toHaveCount(2)
  const durable = await targetJson<FixtureTurn[]>(page,
    `${fixture.syntheticHomePath}/.codex/fake-turns/${originalSessionId}.json`)
  expect(durable).toHaveLength(2)
  // The provider-native turn ID is the durable turn's raw `id`. The nested
  // userMessage.id is a distinct item ID (`<turnId>:user`) and must never be
  // used as the checkpoint identity join key.
  expect(durable?.map(turn => turn.id))
    .toEqual([first.outcome.nativeTurnId, second.outcome.nativeTurnId])
  expect(durable?.map(turn => turn.items.find(item => item.type === 'userMessage')?.id))
    .toEqual(durable?.map(turn => `${turn.id}:user`))
})

test('opening a linked-worktree session from History rewinds its resolved checkout', async ({ page }) => {
  test.setTimeout(360_000)
  await verifyTarget(page)
  const checkout = fixture.linkedWorktreePath
  const launchDirectory = `${checkout}/nested`
  const sessionText = `linked-worktree history session ${fixture.expectedNonce}`
  await targetWrite(page, `${checkout}/main.rs`, 'main before history checkpoint\n')
  await targetWrite(page, `${launchDirectory}/rewind.txt`, 'nested before history checkpoint\n')

  const { paneRoot } = await launchCodex(page, launchDirectory)
  const initial = await currentFreshAgent(page)
  const sessionId = initial.content.sessionRef?.sessionId ?? initial.content.sessionId
  expect(initial.content.checkpointWorkspace).toEqual({ path: launchDirectory, provenance: 'directory-picker' })
  expect(sessionId).toEqual(expect.any(String))
  await sendThroughComposer(page, paneRoot, sessionText, {
    path: launchDirectory,
    provenance: 'directory-picker',
  })

  type DirectoryItem = {
    sessionId: string
    projectPath: string
    checkoutPath?: string
    cwd?: string
  }
  let directoryItem: DirectoryItem | undefined
  await expect.poll(async () => {
    const response = await page.request.get(
      `${paired!.targetUrl}/api/session-directory?priority=visible&limit=50`,
      { headers },
    )
    expect(response.ok()).toBe(true)
    const payload = await response.json() as { items: DirectoryItem[] }
    directoryItem = payload.items.find((item) => item.sessionId === sessionId)
    return directoryItem
  }, { timeout: 60_000, intervals: [500, 1000, 2000] }).toBeTruthy()
  expect(directoryItem).toMatchObject({
    projectPath: fixture.syntheticWorkspacePath,
    checkoutPath: checkout,
    cwd: launchDirectory,
  })

  // History must open from its directory projection; keeping the seed pane
  // open would exercise the already-open-pane path and preserve its explicit
  // picker scope instead of testing ordinary session restoration.
  await paneRoot.getByRole('button', { name: 'Close pane' }).click()
  await expect(page.locator('[data-context="fresh-agent"]')).toHaveCount(0, { timeout: 30_000 })
  await page.locator('button[title="Projects (Ctrl+B P)"]').click()
  const projectHeader = page.locator(`[data-project-path="${fixture.syntheticWorkspacePath}"]`)
  await expect(projectHeader).toBeVisible({ timeout: 30_000 })
  await projectHeader.click()
  const historyRow = page.locator(`[data-context="history-session"][data-session-id="${sessionId}"]`)
  await expect(historyRow).toBeVisible({ timeout: 30_000 })
  await historyRow.getByRole('button', { name: 'Open session' }).click()

  await expect.poll(async () => (await currentFreshAgent(page)).content.checkpointWorkspace)
    .toEqual({ path: checkout, provenance: 'resolved-project' })
  const reopenedPane = page.locator('[data-context="fresh-agent"]').last()
  const beforeMain = 'main before linked-worktree rewind\n'
  const beforeNested = 'nested before linked-worktree rewind\n'
  await targetWrite(page, `${checkout}/main.rs`, beforeMain)
  await targetWrite(page, `${launchDirectory}/rewind.txt`, beforeNested)

  const turnText = `linked-worktree resolved-scope rewind ${fixture.expectedNonce}`
  const turn = await sendThroughComposer(page, reopenedPane, turnText, {
    path: checkout,
    provenance: 'resolved-project',
  })
  expect(turn.outcome).toMatchObject({
    status: 'available',
    workspace: { path: checkout, provenance: 'resolved-project' },
  })
  expect(turn.outcome.checkpointId).toMatch(/^[a-f0-9]{40}$/)

  await targetWrite(page, `${checkout}/main.rs`, 'main changed after linked-worktree turn\n')
  await targetWrite(page, `${launchDirectory}/rewind.txt`, 'nested changed after linked-worktree turn\n')
  await turn.row.hover()
  const rewind = turn.row.getByRole('button', { name: 'Rewind code to here' })
  await expect(rewind).toBeEnabled()
  const rewindNotice = expect(reopenedPane.getByRole('alert').filter({ hasText: /Code rewound to before:/ }))
    .toContainText('Automatic pre-turn snapshot', { timeout: 30_000 })
  const dialogAccepted = page.waitForEvent('dialog').then((dialog) => dialog.accept())
  await rewind.click()
  await Promise.all([dialogAccepted, rewindNotice])
  await expect.poll(() => targetRead(page, `${checkout}/main.rs`)).toBe(beforeMain)
  await expect.poll(() => targetRead(page, `${launchDirectory}/rewind.txt`)).toBe(beforeNested)
})

test('picker-confirmed non-Git workspace captures and restores all selected files', async ({ page }) => {
  test.setTimeout(300_000)
  await verifyTarget(page)
  // As above, each Cloud retry starts from the original non-Git file bytes.
  await targetWrite(page, `${fixture.nonGitWorkspacePath}/one.txt`, 'one before checkpoint\n')
  await targetWrite(page, `${fixture.nonGitWorkspacePath}/two.txt`, 'two before checkpoint\n')
  const { paneRoot, content } = await launchCodex(page, fixture.nonGitWorkspacePath)
  expect(content.checkpointWorkspace).toEqual({ path: fixture.nonGitWorkspacePath, provenance: 'directory-picker' })
  const originalSessionId = content.sessionRef?.sessionId ?? content.sessionId
  const marker = `checkpoint non-git ${fixture.expectedNonce}`
  const turn = await sendThroughComposer(page, paneRoot, marker,
    { path: fixture.nonGitWorkspacePath, provenance: 'directory-picker' })
  expect(turn.outcome).toMatchObject({ status: 'available', workspace: {
    path: fixture.nonGitWorkspacePath, provenance: 'directory-picker',
  } })
  expect(turn.outcome.checkpointId).toMatch(/^[a-f0-9]{40}$/)
  await expect(turn.row.getByRole('status', { name: 'Code rewind available for this message' })).toBeVisible()
  await turn.row.hover()
  await expect(turn.row.getByRole('button', { name: 'Rewind code to here' })).toBeEnabled()
  await assertNativeUserIdentity(page, turn.outcome, turn.accepted.submittedTurnId, marker)

  await targetWrite(page, `${fixture.nonGitWorkspacePath}/one.txt`, 'one changed after send\n')
  await targetWrite(page, `${fixture.nonGitWorkspacePath}/two.txt`, 'two changed after send\n')
  await turn.row.hover()
  const rewindNotice = expect(paneRoot.getByRole('alert').filter({ hasText: /Code rewound to before:/ }))
    .toContainText('Automatic pre-turn snapshot', { timeout: 30_000 })
  const dialogAccepted = page.waitForEvent('dialog').then(dialog => dialog.accept())
  await turn.row.getByRole('button', { name: 'Rewind code to here' }).click()
  await Promise.all([dialogAccepted, rewindNotice])
  await expect.poll(() => targetRead(page, `${fixture.nonGitWorkspacePath}/one.txt`)).toBe('one before checkpoint\n')
  await expect.poll(() => targetRead(page, `${fixture.nonGitWorkspacePath}/two.txt`)).toBe('two before checkpoint\n')
  const afterRestore = await currentFreshAgent(page)
  expect(afterRestore.content.sessionRef?.sessionId ?? afterRestore.content.sessionId).toBe(originalSessionId)
  expect(afterRestore.content.checkpointWorkspace).toEqual({ path: fixture.nonGitWorkspacePath, provenance: 'directory-picker' })
})

test('History reopening preserves a non-Git picker workspace for later rewind', async ({ page }) => {
  test.setTimeout(360_000)
  await verifyPickerWorkspaceReopensForRewind(page, fixture.nonGitWorkspacePath, 'one.txt', 'non-Git')
})

test('History reopening preserves an explicitly selected HOME workspace for later rewind', async ({ page }) => {
  test.setTimeout(360_000)
  await verifyPickerWorkspaceReopensForRewind(page, fixture.syntheticHomePath, 'checkpoint-home-file.txt', 'HOME')
})

test('picker-confirmed HOME captures and restores a harmless home file', async ({ page }) => {
  test.setTimeout(240_000)
  await verifyTarget(page)
  const homeFile = `${fixture.syntheticHomePath}/checkpoint-home-file.txt`
  await targetWrite(page, homeFile, 'home file before checkpoint\n')
  const { paneRoot, content } = await launchCodex(page, fixture.syntheticHomePath)
  expect(content.initialCwd).toBe(fixture.syntheticHomePath)
  expect(content.checkpointWorkspace).toEqual({
    path: fixture.syntheticHomePath,
    provenance: 'directory-picker',
  })
  const marker = `checkpoint home ${fixture.expectedNonce}`
  const turn = await sendThroughComposer(page, paneRoot, marker,
    { path: fixture.syntheticHomePath, provenance: 'directory-picker' })
  expect(turn.outcome).toMatchObject({ status: 'available', workspace: {
    path: fixture.syntheticHomePath, provenance: 'directory-picker',
  } })
  expect(turn.outcome.checkpointId).toMatch(/^[a-f0-9]{40}$/)
  await expect(turn.row.getByRole('status', { name: 'Code rewind available for this message' }))
    .toBeVisible()
  await assertNativeUserIdentity(page, turn.outcome, turn.accepted.submittedTurnId, marker)

  const query = new URLSearchParams({
    cwd: fixture.syntheticHomePath,
    workspacePath: fixture.syntheticHomePath,
    workspaceProvenance: 'directory-picker',
  })
  const listUrl = `${paired!.targetUrl}/api/fresh-agent/checkpoints?${query}`
  const capturedList = await page.request.get(listUrl, { headers, timeout: 30_000 })
  expect(capturedList.ok()).toBe(true)
  expect(await capturedList.json()).toMatchObject({
    checkpoints: [expect.objectContaining({ id: turn.outcome.checkpointId })],
  })

  await targetWrite(page, homeFile, 'home file changed after send\n')
  await turn.row.hover()
  const rewindNotice = expect(paneRoot.getByRole('alert').filter({ hasText: /Code rewound to before:/ }))
    .toContainText('Automatic pre-turn snapshot', { timeout: 30_000 })
  const dialogAccepted = page.waitForEvent('dialog').then(dialog => dialog.accept())
  await turn.row.getByRole('button', { name: 'Rewind code to here' }).click()
  await Promise.all([dialogAccepted, rewindNotice])
  await expect.poll(() => targetRead(page, homeFile)).toBe('home file before checkpoint\n')

  const list = await page.request.get(listUrl, { headers, timeout: 30_000 })
  expect(list.ok()).toBe(true)
  expect(await list.json()).toMatchObject({ checkpoints: [expect.objectContaining({ id: turn.outcome.checkpointId })] })
  const workspaceKey = createHash('sha1').update(resolve(fixture.syntheticHomePath)).digest('hex').slice(0, 16)
  expect(await targetRead(page,
    `${fixture.syntheticHomePath}/.freshell/checkpoints/${workspaceKey}.git/HEAD`)).toBeTruthy()
})
