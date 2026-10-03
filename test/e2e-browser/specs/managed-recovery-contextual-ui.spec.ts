import nativeCodexHistory from '../../fixtures/managed-native-history/codex.json' with { type: 'json' }
import type { Page } from '@playwright/test'
import type { ManagedRuntimeNotice, ManagedRuntimeRecoverySummary } from '@shared/managed-runtime.js'
import { FRESHCODEX_DEFAULT_MODEL } from '@shared/fresh-agent-models.js'
import { test, expect } from '../helpers/fixtures.js'

type PaneKind = 'terminal' | 'fresh-agent'
type RecoveryState = ManagedRuntimeRecoverySummary['recoveryState']

const SESSION_ID = 'd4430000-0000-4444-8444-000000000091'
const SOUL_ID = 'contextual-recovery-soul'
const INTENT_REVISION = 19
const CREATE_REQUEST_ID = 'contextual-recovery-create'
const SAVED_HISTORY_TEXT = 'Saved conversation before recovery'
const readiness = {
  inventoryRevision: 100,
  initialScanState: 'complete',
  blockedSubsystems: [],
  startupRecoveryConcurrencyLimit: 4,
  startupRecoveryPeak: 0,
}

function recoverySummary(recoveryState: RecoveryState): ManagedRuntimeRecoverySummary {
  return {
    desiredState: recoveryState === 'lost' ? 'stopped' : 'running',
    recoveryState,
    reason: 'provider_unavailable',
    durabilityState: 'resume_captured',
    allocationState: 'verified_durable',
  }
}

async function paneContent(page: Page) {
  return page.evaluate(() => {
    const state = window.__FRESHELL_TEST_HARNESS__!.getState()
    const tabId = state.tabs.activeTabId!
    const root = state.panes.layouts[tabId]
    if (root?.type !== 'leaf') throw new Error('Expected the fixture to have one pane')
    return root.content
  })
}

async function installPane(page: Page, kind: PaneKind, recoveryState: RecoveryState) {
  await page.route('**/api/runtime/notices?**', (route) => route.fulfill({ json: { notices: [] } }))
  await page.route('**/api/fresh-agent/threads/**', (route) => route.fulfill({ json: {
    sessionType: 'freshcodex', provider: 'codex', sessionId: SESSION_ID, threadId: SESSION_ID,
    revision: 1, latestTurnId: null, status: 'idle',
    capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
    settings: { model: FRESHCODEX_DEFAULT_MODEL, effort: 'low' },
    tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    pendingApprovals: [], pendingQuestions: [],
    turns: [{ id: 'saved-turn', turnId: 'saved-turn', source: 'durable', role: 'assistant', summary: '',
      items: [{ id: 'saved-text', kind: 'text', text: SAVED_HISTORY_TEXT }] }],
    extensions: {},
  } }))
  await page.route(`**/api/runtime/souls/${SOUL_ID}/history`, (route) => route.fulfill({ json: {
    ...nativeCodexHistory, threadId: SESSION_ID,
    turns: nativeCodexHistory.turns.map((turn) => ({ ...turn, items: turn.items.map((item) => (
      turn.role === 'assistant' && item.kind === 'text' ? { ...item, text: SAVED_HISTORY_TEXT } : item
    )) })),
  } }))
  await page.evaluate(({ kind, summary, sessionId, soulId, revision, createRequestId, model }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    const state = harness.getState()
    const tabId = state.tabs.activeTabId!
    const paneId = state.panes.activePane[tabId]
    const root = state.panes.layouts[tabId]
    if (root?.type !== 'leaf' || root.content.kind !== 'terminal') {
      throw new Error('Expected the fixture terminal')
    }
    // Fresh suppression records attempted sends without starting a sidecar.
    // Terminal decision tests leave the real lifecycle effect enabled: its
    // production managed-recovery guard must stop creates and attaches.
    harness.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    harness.setTerminalNetworkEffectsSuppressed(paneId, summary.recoveryState === 'live' || summary.recoveryState === 'recovering')
    const managed = {
      soulId, soulIntentRevision: revision, incarnationId: 'contextual-incarnation',
      viewIntentId: 'contextual-view', viewIntentRevision: 4,
      resourceSummary: { configured: { cpuMilli: 1000, memoryBytes: 1024 ** 3, swapBytes: 0, pidsMax: 128 } },
      recoverySummary: summary,
    }
    const identity = {
      sessionRef: { provider: 'codex', sessionId }, resumeSessionId: sessionId, createRequestId,
    }
    const content = kind === 'terminal' ? {
      ...root.content, ...identity, ...managed, mode: 'codex',
      status: summary.recoveryState === 'live' ? 'running' : 'error',
    } : {
      kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex',
      ...(summary.recoveryState === 'lost' ? {} : { sessionId }),
      ...identity, ...managed, status: 'idle', model, effort: 'low',
      initialCwd: '/tmp', settingsDismissed: true,
    }
    harness.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId, content } })
    harness.clearSentWsMessages?.()
  }, {
    kind, summary: recoverySummary(recoveryState), sessionId: SESSION_ID, soulId: SOUL_ID,
    revision: INTENT_REVISION, createRequestId: CREATE_REQUEST_ID, model: FRESHCODEX_DEFAULT_MODEL,
  })
}

async function changeRecoveryState(page: Page, recoveryState: RecoveryState) {
  await page.evaluate((summary) => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    const state = harness.getState()
    const tabId = state.tabs.activeTabId!
    const root = state.panes.layouts[tabId]
    if (root?.type !== 'leaf') throw new Error('Expected one pane')
    harness.dispatch({ type: 'panes/updatePaneContent', payload: {
      tabId, paneId: root.id, content: { ...root.content, recoverySummary: summary },
    } })
  }, recoverySummary(recoveryState))
}

for (const kind of ['terminal', 'fresh-agent'] as const) {
  test(`${kind}: healthy and recovering managed panes leave routine recovery chrome hidden`, async ({ freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    await installPane(page, kind, 'live')
    if (kind === 'terminal') {
      await expect(page.getByTestId('terminal-xterm-container')).toBeVisible()
    } else {
      await expect(page.getByRole('textbox', { name: 'Chat message input' })).toBeVisible()
    }
    for (const state of ['live', 'recovering'] as const) {
      await changeRecoveryState(page, state)
      await expect(page.getByTestId('managed-runtime-recovery-card')).toBeHidden()
      await expect(page.getByRole('alert', { name: 'Managed runtime notice' })).toBeHidden()
      await expect(page.getByText('Resource limits and usage', { exact: true })).toBeHidden()
      await expect(page.getByText(SOUL_ID, { exact: true })).toBeHidden()
      await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).toBeHidden()
    }
  })

  test(`${kind}: blocked retry preserves its soul revision and shows failure inside the pane`, async ({ freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    const historyRead = kind === 'fresh-agent' ? page.waitForRequest(`**/api/runtime/souls/${SOUL_ID}/history`) : null
    await installPane(page, kind, 'blocked')
    if (historyRead) expect((await historyRead).method()).toBe('GET')
    const retries: Array<{ requestId: string; expectedIntentRevision: number }> = []
    let inventoryRefreshes = 0
    await page.route(`**/api/runtime/souls/${SOUL_ID}/retry`, async (route) => {
      expect(route.request().method()).toBe('POST')
      retries.push(route.request().postDataJSON())
      await route.fulfill(retries.length === 1
        ? { status: 409, json: { message: 'The provider is still unavailable. Try again.' } }
        : { json: { ok: true } })
    })
    await page.route(/\/api\/runtime\/souls(?:\?.*)?$/, async (route) => {
      inventoryRefreshes += 1
      await route.fulfill({ json: { revision: 100, readiness, souls: [], viewIntents: [], pendingProjectionCount: 0 } })
    })
    const card = page.getByTestId('managed-runtime-recovery-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('This session needs attention before it can continue.')
    if (kind === 'fresh-agent') await expect(page.getByText(SAVED_HISTORY_TEXT, { exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Retry recovery', exact: true }).click()
    await expect(card.getByRole('status')).toHaveText('The provider is still unavailable. Try again.')
    await expect(page.getByRole('alert', { name: 'Managed runtime notice' })).toBeHidden()
    expect(inventoryRefreshes).toBe(0)
    await card.getByRole('button', { name: 'Retry recovery', exact: true }).click()
    await expect.poll(() => inventoryRefreshes).toBe(1)
    await expect(card.getByRole('status')).toBeHidden()
    expect(retries).toHaveLength(2)
    for (const retry of retries) {
      expect(retry.expectedIntentRevision).toBe(INTENT_REVISION)
      expect(retry.requestId).toEqual(expect.any(String))
      expect(retry.requestId.length).toBeGreaterThan(0)
    }
    expect(await paneContent(page)).toMatchObject({
      soulId: SOUL_ID, soulIntentRevision: INTENT_REVISION,
      createRequestId: CREATE_REQUEST_ID, sessionRef: { provider: 'codex', sessionId: SESSION_ID },
    })
  })

  test(`${kind}: lost identity remains until explicit start-new cleanup is verified`, async ({ freshellPage, page, terminal, harness }) => {
    await terminal.waitForTerminal()
    const historyRead = kind === 'fresh-agent' ? page.waitForRequest(`**/api/runtime/souls/${SOUL_ID}/history`) : null
    await installPane(page, kind, 'lost')
    if (historyRead) expect((await historyRead).method()).toBe('GET')
    const before = await paneContent(page)
    const stopRequests: Array<{ expectedIntentRevision: number; requestId: string }> = []
    let releaseVerifiedStop!: () => void
    const verifiedStop = new Promise<void>((resolve) => { releaseVerifiedStop = resolve })
    await page.route(`**/api/runtime/souls/${SOUL_ID}/stop`, async (route) => {
      stopRequests.push(route.request().postDataJSON())
      if (stopRequests.length === 1) {
        await route.fulfill({ json: { outcome: 'termination_unconfirmed', soul: { soulId: SOUL_ID, intentRevision: INTENT_REVISION } } })
      } else {
        await verifiedStop
        await route.fulfill({ json: { outcome: 'verified_empty', soul: { soulId: SOUL_ID, intentRevision: INTENT_REVISION, freshAgentSessionId: SESSION_ID } } })
      }
    })
    const card = page.getByTestId('managed-runtime-recovery-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('This session could not be recovered.')
    await expect(card.getByRole('button', { name: 'Retry recovery', exact: true })).toBeHidden()
    if (kind === 'fresh-agent') {
      await expect(page.getByText(SAVED_HISTORY_TEXT, { exact: true })).toBeVisible()
      await expect(page.getByRole('textbox', { name: 'Chat message input' })).toBeDisabled()
      await harness.receiveWsMessage({
        type: 'freshAgent.event', sessionId: SESSION_ID, sessionType: 'freshcodex', provider: 'codex',
        event: { type: 'freshAgent.error', code: 'INVALID_SESSION_ID', message: 'Session is gone' },
      })
    } else {
      await harness.receiveWsMessage({
        type: 'error', code: 'INVALID_TERMINAL_ID',
        terminalId: before.kind === 'terminal' ? before.terminalId : undefined,
        message: 'Terminal is gone',
      })
    }
    // Give frame handlers and their deferred recovery callbacks a browser turn.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await paneContent(page)).toMatchObject({
      createRequestId: CREATE_REQUEST_ID, soulId: SOUL_ID, soulIntentRevision: INTENT_REVISION,
      sessionRef: { provider: 'codex', sessionId: SESSION_ID }, resumeSessionId: SESSION_ID,
    })
    const beforeChoice = await harness.getSentWsMessages() as Array<{ type?: string }>
    expect(beforeChoice.filter((message) => ['terminal.create', 'terminal.attach', 'freshAgent.create', 'freshAgent.attach', 'pane.reconcile.request'].includes(message.type ?? ''))).toEqual([])
    await card.getByRole('button', { name: 'Start new conversation', exact: true }).click()
    await expect(card.getByRole('status')).toContainText('Your conversation has been kept')
    if (kind === 'fresh-agent') await expect(page.getByText(SAVED_HISTORY_TEXT, { exact: true })).toBeVisible()
    expect(await paneContent(page)).toMatchObject({ createRequestId: CREATE_REQUEST_ID, soulId: SOUL_ID, sessionRef: before.sessionRef })
    await card.getByRole('button', { name: 'Start new conversation', exact: true }).click()
    try {
      await expect(card.getByRole('button', { name: 'Starting…', exact: true })).toBeDisabled()
      await expect.poll(() => stopRequests.length).toBe(2)
      expect(stopRequests).toEqual([
        { expectedIntentRevision: INTENT_REVISION, requestId: expect.any(String) },
        { expectedIntentRevision: INTENT_REVISION, requestId: expect.any(String) },
      ])
      expect((await paneContent(page)).createRequestId).toBe(CREATE_REQUEST_ID)
      const pendingMessages = await harness.getSentWsMessages() as Array<{ type?: string }>
      expect(pendingMessages.filter((message) => ['freshAgent.kill', 'freshAgent.create', 'terminal.create'].includes(message.type ?? ''))).toEqual([])
    } finally {
      releaseVerifiedStop()
    }
    await expect(card).toBeHidden()
    await expect.poll(async () => (await paneContent(page)).createRequestId).not.toBe(CREATE_REQUEST_ID)
    const replacement = await paneContent(page)
    expect(replacement).toMatchObject({ kind })
    for (const field of ['soulId', 'incarnationId', 'soulIntentRevision', 'viewIntentId', 'recoverySummary', 'resourceSummary', 'sessionRef', 'resumeSessionId']) {
      expect(replacement[field as keyof typeof replacement]).toBeUndefined()
    }
    if (replacement.kind === 'fresh-agent') expect(replacement.sessionId).toBeUndefined()
  })
}

test('routine notices stay silent while cleanup failure is a yellow actionable popup', async ({ freshellPage, page, terminal }) => {
  await terminal.waitForTerminal()
  const notices: ManagedRuntimeNotice[] = [
    { noticeId: 'routine-cleanup', kind: 'cleanup_succeeded', message: 'Found and cleaned up 1 lost agent process.', reference: 'SUCCESS1', incidentIds: [], deliveryState: 'pending', createdAt: '2026-10-02T00:00:00.000Z' },
    { noticeId: 'routine-ended', kind: 'ended_without_process', message: 'The managed agent ended without a running process.', reference: 'ENDED001', incidentIds: [], deliveryState: 'pending', createdAt: '2026-10-02T00:00:01.000Z' },
  ]
  const receipts: Array<{ noticeId: string; state: string; profileId: string }> = []
  await page.route('**/api/runtime/notices?**', (route) => route.fulfill({ json: { notices } }))
  await page.route('**/api/runtime/notices/*/receipt', async (route) => {
    const noticeId = route.request().url().split('/').at(-2)!
    const body = route.request().postDataJSON()
    receipts.push({ noticeId, state: body.state, profileId: body.profileId })
    const notice = notices.find((item) => item.noticeId === noticeId)
    if (notice) notice.deliveryState = body.state
    if (body.state === 'dismissed') notices.splice(notices.findIndex((item) => item.noticeId === noticeId), 1)
    await route.fulfill({ json: { ok: true } })
  })
  await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.dispatch({ type: 'managedRuntime/setManagedRuntimeAvailable', payload: true }))
  await expect.poll(() => receipts.filter((receipt) => receipt.state === 'acknowledged').map((receipt) => receipt.noticeId).sort()).toEqual(['routine-cleanup', 'routine-ended'])
  const popup = page.getByRole('alert', { name: 'Managed runtime notice' })
  await expect(popup).toBeHidden()
  notices.push({ noticeId: 'cleanup-failed', kind: 'cleanup_failed', message: 'Cleanup could not be verified. No unrelated process was touched. Reference: FAIL0001.', reference: 'FAIL0001', incidentIds: ['incident-one'], deliveryState: 'pending', createdAt: '2026-10-02T00:00:02.000Z' })
  await page.route('**/api/runtime/incidents/incident-one/summary', (route) => route.fulfill({ json: {
    incidentId: 'incident-one', correlationId: 'correlation-one', soulId: SOUL_ID, provider: 'codex',
    state: 'cleanup_failed', reasonCode: 'cleanup_unconfirmed', observedCause: 'Provider process ownership could not be confirmed.',
    cleanup: { ownedHandleRef: 'registry://contextual-incarnation', ownershipVerified: false, gracefulAttempt: 'not_attempted', forcedAttempt: 'not_attempted', verifiedEmpty: false, foreignObjectsTouched: 0 },
    createdAt: '2026-10-02T00:00:02.000Z', updatedAt: '2026-10-02T00:00:03.000Z',
  } }))
  await expect(popup).toBeVisible()
  await expect(popup).toContainText('Runtime cleanup needs attention')
  await expect(popup).toContainText('No unrelated process was touched')
  await expect.poll(() => receipts.some((receipt) => receipt.noticeId === 'cleanup-failed' && receipt.state === 'rendered')).toBe(true)
  expect(receipts.filter((receipt) => receipt.noticeId === 'cleanup-failed' && receipt.state === 'acknowledged')).toEqual([])
  // The visible warning has the same yellow tone as the contextual pane card.
  expect(await popup.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgba(245, 158, 11, 0.1)')
  await popup.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(popup).toContainText('Provider process ownership could not be confirmed.')
  await popup.getByRole('button', { name: 'Dismiss', exact: true }).click()
  await expect(popup).toBeHidden()
  expect(receipts.some((receipt) => receipt.noticeId === 'cleanup-failed' && receipt.state === 'dismissed')).toBe(true)
  expect(receipts.every((receipt) => receipt.profileId.startsWith('profile:'))).toBe(true)
})
