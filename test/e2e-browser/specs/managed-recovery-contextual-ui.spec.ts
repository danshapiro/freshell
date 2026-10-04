import nativeCodexHistory from '../../fixtures/managed-native-history/codex.json' with { type: 'json' }
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@playwright/test'
import type { ManagedRuntimeNotice, ManagedRuntimeRecoverySummary } from '@shared/managed-runtime.js'
import { FRESHCODEX_DEFAULT_MODEL } from '@shared/fresh-agent-models.js'
import { test, expect } from '../helpers/fixtures.js'
import { RawWsClient } from '../helpers/raw-clients.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness, selectShellFromPicker } from '../helpers/test-harness.js'

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

async function installPane(page: Page, kind: PaneKind, recoveryState: RecoveryState, missingSoul = false, staleStatus?: 'running' | 'starting') {
  await page.route('**/api/runtime/notices?**', (route) => route.fulfill({ json: { notices: [] } }))
  if (!missingSoul) await page.route('**/api/fresh-agent/threads/**', (route) => route.fulfill({ json: {
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
  await page.evaluate(({ kind, summary, sessionId, soulId, revision, createRequestId, model, missingSoul, staleStatus }) => {
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
    harness.setTerminalNetworkEffectsSuppressed(paneId, summary.recoveryState === 'live')
    if (kind === 'fresh-agent' && staleStatus) {
      const locator = { sessionType: 'freshcodex', provider: 'codex', sessionId }
      harness.dispatch({ type: 'freshAgent/sessionInit', payload: locator })
      harness.dispatch({ type: 'freshAgent/setSessionStatus', payload: { ...locator, status: staleStatus } })
    }
    const managed = {
      soulId: missingSoul ? undefined : soulId, soulIntentRevision: revision, incarnationId: 'contextual-incarnation',
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
      ...(summary.recoveryState === 'lost' && !staleStatus ? {} : { sessionId }),
      ...identity, ...managed, status: staleStatus ?? (missingSoul ? 'error' : 'idle'), model, effort: 'low',
      ...(missingSoul ? { closeError: 'Previous close was not confirmed' } : {}),
      initialCwd: '/tmp', settingsDismissed: true,
    }
    harness.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId, content } })
    harness.clearSentWsMessages?.()
  }, {
    kind, summary: recoverySummary(recoveryState), sessionId: SESSION_ID, soulId: SOUL_ID,
    revision: INTENT_REVISION, createRequestId: CREATE_REQUEST_ID, model: FRESHCODEX_DEFAULT_MODEL, missingSoul, staleStatus,
  })
}

test('fresh-agent: a close started during verified start-new cleanup preserves the displayed conversation when close fails', async ({ page, serverInfo, harness, terminal }) => {
  let targetTabId: string | undefined
  let closeRequestId: string | undefined
  let closeStarted = false
  let failClose = () => {}
  let releaseStop!: () => void
  const heldStop = new Promise<void>((resolve) => { releaseStop = resolve })
  let finishStop!: () => void
  const stopFinished = new Promise<void>((resolve) => { finishStop = resolve })
  let stopRequests = 0
  let historyReads = 0
  const draft = 'Retained draft during refused Start new'
  const draftKey = `fresh-agent-draft:freshcodex:${CREATE_REQUEST_ID}`
  // A controlled refusal executes the real tab-close thunk without writing
  // a successful close record on the server for the still-displayed fixture.
  await page.routeWebSocket('**/ws', (socket) => {
    const upstream = socket.connectToServer()
    socket.onMessage((data) => {
      const message = JSON.parse(String(data)) as { type?: string; tabId?: string; requestId?: string }
      if (message.type === 'panes.closed' && message.tabId === targetTabId) {
        closeStarted = true
        closeRequestId = message.requestId
        return
      }
      upstream.send(data)
    })
    upstream.onMessage((data) => socket.send(data))
    failClose = () => {
      if (!closeRequestId) return
      socket.send(JSON.stringify({ type: 'panes.closed.result', requestId: closeRequestId, success: false }))
      closeRequestId = undefined
    }
  })
  page.on('request', (request) => {
    if (request.url().includes(`/api/runtime/souls/${SOUL_ID}/history`)) historyReads += 1
  })
  await page.route(`**/api/runtime/souls/${SOUL_ID}/stop`, async (route) => {
    stopRequests += 1
    try {
      expect(route.request().postDataJSON()).toEqual({ expectedIntentRevision: INTENT_REVISION, requestId: expect.any(String) })
      await heldStop
      await route.fulfill({ json: { outcome: 'verified_empty', soul: { soulId: SOUL_ID, intentRevision: INTENT_REVISION } } })
    } finally {
      finishStop()
    }
  })
  try {
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`, { timeout: 60_000 })
    await harness.waitForHarness(60_000)
    await harness.waitForConnection()
    await selectShellFromPicker(page)
    await terminal.waitForTerminal()
    targetTabId = (await harness.getState()).tabs.activeTabId!
    await page.locator('[data-context="tab-add"]').click()
    await harness.waitForTabCount(2)
    const originalTab = page.locator('[data-context="tab"]').first()
    await originalTab.click()
    await page.evaluate(({ key, text }) => sessionStorage.setItem(key, text), { key: draftKey, text: draft })
    await installPane(page, 'fresh-agent', 'lost')
    await expect(page.getByText(SAVED_HISTORY_TEXT, { exact: true })).toBeVisible()
    const composer = page.getByRole('textbox', { name: 'Chat message input' })
    await expect(composer).toHaveValue(draft)
    const before = await paneContent(page)
    const settledReads = historyReads
    expect(settledReads).toBe(1)
    const card = page.getByTestId('managed-runtime-recovery-card')
    await card.getByRole('button', { name: 'Start new conversation', exact: true }).click()
    await expect.poll(() => stopRequests).toBe(1)
    await expect(card.getByRole('button', { name: 'Starting…', exact: true })).toBeDisabled()
    await originalTab.getByRole('button', { name: /close/i }).click()
    await expect.poll(() => closeRequestId).toBeTruthy()
    await expect.poll(async () => (await harness.getState()).panes.closingTabs?.[targetTabId!]).toBe(true)
    releaseStop()
    await stopFinished
    await expect(card.getByRole('button', { name: 'Start new conversation', exact: true })).toBeEnabled()
    const assertRetained = async (closeError: string | undefined) => {
      await expect(page.getByText(SAVED_HISTORY_TEXT, { exact: true })).toBeVisible()
      await expect(composer).toHaveValue(draft)
      expect(await page.evaluate((key) => sessionStorage.getItem(key), draftKey)).toBe(draft)
      expect(await paneContent(page)).toMatchObject({ ...before, closeError })
      expect(historyReads).toBe(settledReads)
      const messages = await harness.getSentWsMessages() as Array<{ type?: string }>
      expect(messages.filter((message) => ['freshAgent.create', 'freshAgent.attach', 'freshAgent.send', 'pane.reconcile.request'].includes(message.type ?? ''))).toEqual([])
    }
    // Prove retention BEFORE the close result; no refresh can rescue a clear.
    await assertRetained(undefined)
    expect(closeRequestId).toBeTruthy()
    failClose()
    await expect.poll(async () => (await harness.getState()).panes.closingTabs?.[targetTabId!]).toBeUndefined()
    await expect(page.getByText(/Close failed:/)).toBeVisible()
    await harness.waitForTabCount(2)
    await assertRetained('the pane close could not be recorded durably; the pane was left open')
    expect(stopRequests).toBe(1)
  } finally {
    releaseStop()
    if (stopRequests) await stopFinished
    failClose()
    try {
      if (closeStarted) await expect.poll(async () => (await harness.getState()).panes.closingTabs?.[targetTabId!]).toBeUndefined()
    } finally {
      await harness.killAllTerminals(serverInfo)
    }
  }
})

for (const recoveryState of ['blocked', 'lost'] as const) {
  for (const status of ['running', 'starting'] as const) {
    test(`fresh-agent: ${recoveryState} stale ${status} reads history once while awaiting intervention`, async ({ freshellPage, page, terminal, harness }) => {
      await terminal.waitForTerminal()
      let historyReads = 0
      page.on('request', (request) => {
        if (request.url().includes(`/api/runtime/souls/${SOUL_ID}/history`)) historyReads += 1
      })
      await installPane(page, 'fresh-agent', recoveryState, false, status)
      await expect(page.getByText(SAVED_HISTORY_TEXT, { exact: true })).toBeVisible()
      expect(historyReads).toBe(1)
      const before = await paneContent(page)
      await page.waitForTimeout(6_500)
      expect(historyReads).toBe(1)
      expect(await paneContent(page)).toEqual(before)
      await expect(page.getByTestId('managed-runtime-recovery-card')).toBeVisible()
      const messages = await harness.getSentWsMessages() as Array<{ type?: string }>
      expect(messages.filter((message) => ['freshAgent.create', 'freshAgent.attach', 'pane.reconcile.request'].includes(message.type ?? ''))).toEqual([])
    })
  }
}

test('background notices failure stays quiet and preserves an existing cleanup warning', async ({ freshellPage, page, terminal }) => {
  await terminal.waitForTerminal()
  let fail = true
  let failures = 0
  await page.route('**/api/runtime/notices?**', (route) => {
    if (fail) {
      failures += 1
      return route.fulfill({ status: 400, json: { message: 'Background notices refused' } })
    }
    return route.fulfill({ json: { notices: [{ noticeId: 'cleanup-failed', kind: 'cleanup_failed',
      message: 'Cleanup still needs a decision.', reference: 'FAIL0001', incidentIds: ['incident-one'],
      deliveryState: 'pending', createdAt: '2026-10-02T00:00:00.000Z' }] } })
  })
  await page.route('**/api/runtime/notices/*/receipt', (route) => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/runtime/incidents/incident-one/summary', (route) => route.fulfill({ json: {
    incidentId: 'incident-one', correlationId: 'correlation-one', soulId: SOUL_ID, provider: 'codex',
    state: 'cleanup_failed', reasonCode: 'cleanup_unconfirmed', observedCause: 'Saved actionable cleanup cause.',
    cleanup: { ownedHandleRef: 'registry://contextual-incarnation', ownershipVerified: false, gracefulAttempt: 'not_attempted', forcedAttempt: 'not_attempted', verifiedEmpty: false, foreignObjectsTouched: 0 },
    createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:01.000Z',
  } }))
  await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.dispatch({ type: 'managedRuntime/setManagedRuntimeAvailable', payload: true }))
  await expect.poll(() => failures).toBeGreaterThan(0)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const popup = page.getByRole('alert', { name: 'Managed runtime notice' })
  await expect(popup).toBeHidden()
  fail = false
  await expect(popup).toBeVisible()
  await popup.getByRole('button', { name: 'Details', exact: true }).click()
  await expect(popup).toContainText('Saved actionable cleanup cause.')
  fail = true
  const priorFailures = failures
  await expect.poll(() => failures).toBeGreaterThan(priorFailures)
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  await expect(popup).toContainText('Cleanup still needs a decision.')
  await expect(popup).toContainText('Saved actionable cleanup cause.')
  await expect(popup).not.toContainText('Background notices refused')
  await expect(popup.getByRole('button', { name: 'Details', exact: true })).toBeVisible()
  await expect(popup.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible()
})

test('fresh-agent: cold lost pane without a soul retains saved history and a close warning after refused start-new', async ({ freshellPage, page, terminal, harness, serverInfo }) => {
  await terminal.waitForTerminal()
  const sessions = path.join(serverInfo.homeDir, '.codex', 'sessions', '2026', '03', '01')
  await fs.mkdir(sessions, { recursive: true })
  const events = await fs.readFile('test/fixtures/coding-cli/codex/task-events.sanitized.jsonl', 'utf8')
  const tools = await fs.readFile('test/fixtures/managed-native-history/codex-tools.jsonl', 'utf8')
  const arrayAnswer = 'Latest saved array answer FRESHELL_NATIVE_HISTORY_OMITTED_SHA256:body'
  const recentParts = (kind: string, tail: string) => [
    ...Array.from({ length: 24 }, (_, index) => ({ type: kind, text: `Earlier array part ${index} ${'saved '.repeat(32_000)}` })),
    { type: kind, text: tail },
  ]
  const transcript = events.replace('session-activity', SESSION_ID)
    .replace('Sanitized completion', SAVED_HISTORY_TEXT) + tools.split('\n').slice(1).join('\n')
    + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'large-history-tool', name: 'exec_command', arguments: '{"cmd":"pwd"}' } })
    + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'large-history-tool', output: 'Saved large tool output '.repeat(800_000) } })
    + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'array-history-tool', name: 'echo', arguments: '{}' } })
    + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'array-history-tool', output: recentParts('input_text', 'Latest saved array tool output') } })
    + '\n' + JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'array-history-answer', role: 'assistant', content: recentParts('output_text', arrayAnswer) } })
  const rollout = path.join(sessions, `rollout-${SESSION_ID}.jsonl`)
  await fs.writeFile(rollout, transcript)
  expect(Buffer.byteLength(transcript)).toBeGreaterThan(16 * 1024 * 1024)
  const modified = (await fs.stat(rollout)).mtimeMs
  let stopRequests = 0
  await page.route('**/api/runtime/souls/*/stop', async (route) => {
    stopRequests += 1
    await route.fulfill({ status: 404, json: { message: 'No managed soul' } })
  })
  const historyRead = page.waitForResponse('**/api/fresh-agent/threads/**')
  await installPane(page, 'fresh-agent', 'lost', true)
  const response = await historyRead
  expect(response.request().method()).toBe('GET')
  expect(response.status()).toBe(200)
  const snapshot = await response.json()
  await expect(page.getByText('Sanitized prompt', { exact: true })).toBeVisible()
  await expect(page.getByText(SAVED_HISTORY_TEXT, { exact: true })).toBeVisible()
  await expect(page.getByText(arrayAnswer, { exact: false })).toBeVisible()
  expect(JSON.stringify(snapshot.turns)).toContain('Latest saved array tool output')
  expect(snapshot.extensions.codex.nativeHistoryAvailable).toBe(true)
  expect(snapshot.extensions.codex.nativeHistoryRetention.partial).toBe(true)
  expect(snapshot.turns.flatMap((turn: { items: Array<{ id: string }> }) => turn.items).some((item: { id: string }) => item.id === 'large-history-tool')).toBe(true)
  await expect(page.getByRole('note', { name: 'Retained conversation history' })).toContainText('The saved conversation has not been changed.')
  const closeWarning = page.getByText('Close failed: Previous close was not confirmed', { exact: true })
  await expect(closeWarning).toBeVisible()
  const before = await paneContent(page)
  expect(before).toMatchObject({ status: 'error', createRequestId: CREATE_REQUEST_ID,
    sessionRef: { provider: 'codex', sessionId: SESSION_ID } })
  expect(before.soulId).toBeUndefined()
  await expect(page.getByRole('textbox', { name: 'Chat message input' })).toBeDisabled()
  const card = page.getByTestId('managed-runtime-recovery-card')
  await card.getByRole('button', { name: 'Start new conversation', exact: true }).click()
  await expect(card.getByRole('status')).toContainText('Your conversation has been kept')
  await expect(page.getByText(SAVED_HISTORY_TEXT, { exact: true })).toBeVisible()
  await expect(closeWarning).toBeVisible()
  await expect(page.getByText(arrayAnswer, { exact: false })).toBeVisible()
  expect(await paneContent(page)).toEqual(before)
  expect(stopRequests).toBe(0)
  expect(await fs.readFile(rollout, 'utf8')).toBe(transcript)
  expect((await fs.stat(rollout)).mtimeMs).toBe(modified)
  const messages = await harness.getSentWsMessages() as Array<{ type?: string }>
  expect(messages.filter((message) => ['freshAgent.kill', 'freshAgent.create', 'freshAgent.attach', 'pane.reconcile.request'].includes(message.type ?? ''))).toEqual([])
})

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

for (const savedIdentity of [false, true]) {
  for (const status of ['running', 'creating'] as const) {
    test(`terminal: real rejected attach during automatic recovery retains identity (saved reference ${savedIdentity}, stale ${status})`, async ({ freshellPage, page, terminal, harness }) => {
      await terminal.waitForTerminal()
      const original = await paneContent(page)
      if (original.kind !== 'terminal' || !original.terminalId) throw new Error('Expected a live fixture terminal')
      const invalidTerminalId = `missing-automatic-${original.terminalId}`
      await page.evaluate(({ invalidTerminalId, savedIdentity, status, summary, sessionId, soulId }) => {
        const rig = window.__FRESHELL_TEST_HARNESS__!
        const state = rig.getState()
        const tabId = state.tabs.activeTabId!
        const root = state.panes.layouts[tabId]
        if (root.type !== 'leaf' || root.content.kind !== 'terminal') throw new Error('Expected a terminal')
        rig.setTerminalNetworkEffectsSuppressed(root.id, false)
        rig.clearSentWsMessages?.()
        rig.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId: root.id, content: {
          ...root.content, terminalId: invalidTerminalId, mode: 'codex', status,
          soulId, soulIntentRevision: 19, recoverySummary: summary,
          sessionRef: savedIdentity ? { provider: 'codex', sessionId } : undefined,
          resumeSessionId: savedIdentity ? sessionId : undefined,
        } } })
      }, { invalidTerminalId, savedIdentity, status, summary: recoverySummary('recovering'), sessionId: SESSION_ID, soulId: SOUL_ID })
      await expect.poll(async () => (await harness.getReceivedWsMessages() as Array<{ code?: string; terminalId?: string }>).some(
        (frame) => frame.code === 'INVALID_TERMINAL_ID' && frame.terminalId === invalidTerminalId,
      )).toBe(true)
      const sent = await harness.getSentWsMessages() as Array<{ type?: string; terminalId?: string; attachRequestId?: string }>
      const rejected = sent.find((frame) => frame.type === 'terminal.attach' && frame.terminalId === invalidTerminalId)
      expect(rejected?.attachRequestId).toEqual(expect.any(String))
      const received = await harness.getReceivedWsMessages() as Array<{ code?: string; requestId?: string; terminalId?: string }>
      expect(received).toContainEqual(expect.objectContaining({ code: 'INVALID_TERMINAL_ID', terminalId: invalidTerminalId,
        requestId: rejected!.attachRequestId }))
      expect(sent.filter((frame) => frame.type === 'terminal.create')).toEqual([])
      expect(await paneContent(page)).toMatchObject({ terminalId: invalidTerminalId,
        createRequestId: original.createRequestId, soulId: SOUL_ID })
      expect((await paneContent(page)).sessionRef).toEqual(savedIdentity ? { provider: 'codex', sessionId: SESSION_ID } : undefined)
      expect(await terminal.getVisibleText()).not.toMatch(/Reconnecting|Starting a new terminal/)
      await expect(page.getByTestId('managed-runtime-recovery-card')).toBeHidden()
      await expect(page.getByText('Starting terminal...', { exact: true })).toBeHidden()
      // The managed replacement frame rebinds to an owned live terminal, whose attach/stream is real.
      await harness.receiveWsMessage({ type: 'terminal.replaced', oldTerminalId: invalidTerminalId,
        newTerminalId: original.terminalId, exitCode: 137, attempt: 1, maxAttempts: 3 })
      await changeRecoveryState(page, 'live')
      await expect.poll(() => paneContent(page)).toMatchObject({ terminalId: original.terminalId,
        createRequestId: original.createRequestId, soulId: SOUL_ID })
      let replacementAttach: { attachRequestId?: string } | undefined
      await expect.poll(async () => {
        replacementAttach = (await harness.getSentWsMessages() as Array<{ type?: string; terminalId?: string; attachRequestId?: string }>).find(
          (frame) => frame.type === 'terminal.attach' && frame.terminalId === original.terminalId,
        )
        return replacementAttach?.attachRequestId
      }).toEqual(expect.any(String))
      await expect.poll(async () => (await harness.getReceivedWsMessages() as Array<{ type?: string; terminalId?: string; attachRequestId?: string }>).some(
        (frame) => frame.type === 'terminal.attach.ready' && frame.terminalId === original.terminalId
          && frame.attachRequestId === replacementAttach!.attachRequestId,
      )).toBe(true)
      await terminal.executeCommandInserted("printf 'AUTOMATIC_%s\\n' 'RECOVERY_RETAINED_OUTPUT'")
      await terminal.waitForOutput('AUTOMATIC_RECOVERY_RETAINED_OUTPUT', { terminalId: original.terminalId })
      expect((await paneContent(page)).sessionRef).toEqual(savedIdentity ? { provider: 'codex', sessionId: SESSION_ID } : undefined)
      expect(await terminal.getVisibleText(original.terminalId)).not.toMatch(/Reconnecting|Starting a new terminal/)
    })
  }
}

test('fresh-agent: automatic recovery reads actual saved Codex history without changing the conversation', async ({ freshellPage, page, terminal, harness, serverInfo }) => {
  await terminal.waitForTerminal()
  const sessions = path.join(serverInfo.homeDir, '.codex', 'sessions', '2026', '03', '01')
  await fs.mkdir(sessions, { recursive: true })
  const events = await fs.readFile('test/fixtures/coding-cli/codex/task-events.sanitized.jsonl', 'utf8')
  const transcript = events.replace('session-activity', SESSION_ID).replace('Sanitized completion', SAVED_HISTORY_TEXT)
  const rollout = path.join(sessions, `rollout-${SESSION_ID}.jsonl`)
  await fs.writeFile(rollout, transcript)
  const historyRead = page.waitForResponse('**/api/fresh-agent/threads/**')
  await installPane(page, 'fresh-agent', 'recovering', true)
  const response = await historyRead
  expect(response.request().method()).toBe('GET')
  expect(response.status()).toBe(200)
  expect((await response.json()).extensions.codex.nativeHistoryAvailable).toBe(true)
  await expect(page.getByText('Sanitized prompt', { exact: true })).toBeVisible()
  await expect(page.getByText(SAVED_HISTORY_TEXT, { exact: true })).toBeVisible()
  const content = await paneContent(page)
  expect(content).toMatchObject({ sessionId: SESSION_ID, sessionRef: { provider: 'codex', sessionId: SESSION_ID },
    resumeSessionId: SESSION_ID, createRequestId: CREATE_REQUEST_ID, recoverySummary: { recoveryState: 'recovering' } })
  await expect(page.getByTestId('managed-runtime-recovery-card')).toBeHidden()
  await expect(page.getByText('Restoring session...', { exact: true })).toBeHidden()
  await expect(page.getByText('Close failed: Previous close was not confirmed', { exact: true })).toBeVisible()
  const messages = await harness.getSentWsMessages() as Array<{ type?: string }>
  expect(messages.filter((frame) => ['freshAgent.create', 'freshAgent.attach', 'pane.reconcile.request'].includes(frame.type ?? ''))).toEqual([])
  expect(await fs.readFile(rollout, 'utf8')).toBe(transcript)
})

test('legacy provider fixture: injected managed projection preserves the conversation while real cold resume awaits its snapshot', async ({ page }) => {
  test.setTimeout(120_000)
  let rollout = ''
  let operations = ''
  let transcript = ''
  const fixtureEnv: Record<string, string> = {
    CODEX_CMD: `${process.execPath} ${path.resolve('test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs')}`,
  }
  const server = new RustServer({
    env: fixtureEnv,
    setupHome: async (homeDir) => {
      const freshellDir = path.join(homeDir, '.freshell')
      await fs.mkdir(freshellDir, { recursive: true })
      await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({ version: 1,
        settings: { codingCli: { enabledProviders: ['codex'] }, freshAgent: { enabled: true } } }))
      const sessions = path.join(homeDir, '.codex', 'sessions', '2026', '03', '01')
      await fs.mkdir(sessions, { recursive: true })
      rollout = path.join(sessions, `rollout-${SESSION_ID}.jsonl`)
      transcript = (await fs.readFile('test/fixtures/coding-cli/codex/task-events.sanitized.jsonl', 'utf8'))
        .replace('session-activity', SESSION_ID).replace('Sanitized completion', 'Fixture turn')
      await fs.writeFile(rollout, transcript)
      operations = path.join(homeDir, 'codex-operations.jsonl')
      // This is the existing provider protocol fixture, reached through the real Rust backend.
      fixtureEnv.FAKE_CODEX_APP_SERVER_BEHAVIOR = JSON.stringify({ threadStartThreadId: SESSION_ID,
        appendThreadOperationLogPath: operations })
    },
  })
  let client: RawWsClient | undefined
  try {
    const info = await server.start()
    client = await RawWsClient.connect(info.wsUrl)
    client.hello(info.token)
    await client.nextJsonMessage('ready', 10_000)
    client.sendJson({ type: 'freshAgent.create', requestId: CREATE_REQUEST_ID,
      sessionType: 'freshcodex', provider: 'codex', cwd: info.homeDir })
    const created = await client.nextJsonMessage<{ sessionId: string; sessionRef?: { provider: string; sessionId: string } }>('freshAgent.created', 20_000)
    const sent: Array<Record<string, any>> = []
    const received: Array<Record<string, any>> = []
    const held: Array<string | Buffer> = []
    let hold = false
    let release = () => {}
    await page.routeWebSocket('**/ws', (socket) => {
      const upstream = socket.connectToServer()
      socket.onMessage((data) => {
        sent.push(JSON.parse(String(data)))
        upstream.send(data)
      })
      upstream.onMessage((data) => {
        const frame = JSON.parse(String(data))
        received.push(frame)
        if (hold && frame.type === 'freshAgent.event' && frame.sessionId === created.sessionId) held.push(data)
        else socket.send(data)
      })
      release = () => { hold = false; for (const data of held.splice(0)) socket.send(data) }
    })
    await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    const harness = new TestHarness(page)
    await harness.waitForHarness()
    await harness.waitForConnection()
    await selectShellFromPicker(page)
    await page.evaluate(({ sessionId, sessionRef, requestId, soulId, summary, cwd }) => {
      const harness = window.__FRESHELL_TEST_HARNESS__!
      const state = harness.getState()
      const tabId = state.tabs.activeTabId!
      const paneId = state.panes.activePane[tabId]
      harness.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId, content: {
        kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex', sessionId,
        sessionRef, resumeSessionId: sessionRef?.sessionId ?? sessionId, createRequestId: requestId,
        soulId, soulIntentRevision: 7, recoverySummary: summary, initialCwd: cwd, status: 'idle', settingsDismissed: true,
      } } })
    }, { sessionId: created.sessionId, sessionRef: created.sessionRef ?? { provider: 'codex', sessionId: SESSION_ID },
      requestId: CREATE_REQUEST_ID, soulId: SOUL_ID, summary: recoverySummary('live'), cwd: info.homeDir })
    await expect(page.getByText('Fixture turn', { exact: true })).toBeVisible()
    const composer = page.getByRole('textbox', { name: 'Chat message input' })
    await expect(composer).toBeEnabled()
    await composer.fill('Draft retained while reattaching')
    hold = true
    await changeRecoveryState(page, 'recovering')
    const previousAttach = sent.findLast((frame) => frame.type === 'freshAgent.attach' && frame.sessionId === created.sessionId)
    expect(previousAttach).toBeDefined()
    // Stop only this fixture's provider using the supported conversation-preserving stop.
    // Its next attach must actually resume, so it produces new attachment truth.
    client.sendJson({ type: 'freshAgent.recovery.stop', requestId: 'contextual-test-provider-stop',
      sessionId: created.sessionId, sessionType: 'freshcodex', provider: 'codex',
      observedEpoch: previousAttach!.observedEpoch, observedGeneration: previousAttach!.observedGeneration })
    const stopped = await client.nextJsonMessage<{ requestId: string; success: boolean }>('freshAgent.recovery.stopped', 20_000)
    expect(stopped).toMatchObject({ requestId: 'contextual-test-provider-stop', success: true })
    await expect.poll(async () => (await harness.getReceivedWsMessages() as Array<{ type?: string; requestId?: string }>).some(
      (frame) => frame.type === 'freshAgent.recovery.stopped' && frame.requestId === 'contextual-test-provider-stop',
    )).toBe(true)
    await expect.poll(() => page.evaluate((sessionId) => {
      const owners = Object.values(window.__FRESHELL_TEST_HARNESS__!.getState().freshAgent.runtimeOwners) as Array<{ sessionId: string; ownerKind: string }>
      return owners.find((owner) => owner.sessionId === sessionId)?.ownerKind
    }, created.sessionId)).toBe('vacant')
    // The explicit stop clears the client's entry; seed the retained entry
    // that a supervisor loss leaves behind before delivering stale loss evidence.
    await page.evaluate((sessionId) => window.__FRESHELL_TEST_HARNESS__!.dispatch({ type: 'freshAgent/sessionInit',
      payload: { sessionId, sessionType: 'freshcodex', provider: 'codex' } }), created.sessionId)
    await harness.receiveWsMessage({ type: 'freshAgent.event', sessionId: created.sessionId,
      sessionType: 'freshcodex', provider: 'codex', event: { type: 'freshAgent.exit', code: 137 } })
    await harness.receiveWsMessage({ type: 'freshAgent.event', sessionId: created.sessionId,
      sessionType: 'freshcodex', provider: 'codex', event: { type: 'freshAgent.error', code: 'INVALID_SESSION_ID' } })
    const recovering = await paneContent(page)
    const firstSend = sent.length
    await changeRecoveryState(page, 'live')
    await expect.poll(() => sent.slice(firstSend).filter((frame) => frame.type === 'freshAgent.attach').length).toBe(1)
    await expect.poll(() => ({
      truth: held.map((data) => JSON.parse(String(data))).some((frame) => (
        frame.type === 'freshAgent.event' && frame.sessionId === created.sessionId && frame.event?.type === 'freshAgent.session.snapshot'
      )),
      sent: sent.slice(firstSend),
      received: received.slice(-6),
    })).toMatchObject({ truth: true })
    // The received truth frame is held at the actual socket boundary, not injected or fabricated.
    const attachments = sent.slice(firstSend).filter((frame) => frame.type === 'freshAgent.attach')
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({ sessionId: created.sessionId,
      sessionRef: recovering.sessionRef, sessionType: 'freshcodex', provider: 'codex' })
    expect(sent.slice(firstSend).filter((frame) => ['freshAgent.create', 'pane.reconcile.request'].includes(frame.type))).toEqual([])
    const beforeTruth = await paneContent(page)
    expect(beforeTruth).toEqual({ ...recovering, recoverySummary: recoverySummary('live') })
    await expect(composer).toBeDisabled()
    await expect(composer).toHaveValue('Draft retained while reattaching')
    await expect(page.getByText('Fixture turn', { exact: true })).toBeVisible()
    await expect(page.getByTestId('managed-runtime-recovery-card')).toBeHidden()
    await expect(page.getByRole('button', { name: 'Resume session', exact: true })).toBeHidden()
    await expect(page.getByRole('button', { name: 'Start new session', exact: true })).toBeHidden()
    const lost = () => page.evaluate((sessionId) => {
      const sessions = Object.values(window.__FRESHELL_TEST_HARNESS__!.getState().freshAgent.sessions) as Array<{ sessionId: string; lost?: boolean }>
      return sessions.find((session) => session.sessionId === sessionId)?.lost
    }, created.sessionId)
    expect(await lost()).toBe(true)
    release()
    await expect.poll(lost).toBe(false)
    await expect(composer).toBeEnabled()
    await expect(composer).toHaveValue('Draft retained while reattaching')
    await expect(page.getByText('Fixture turn', { exact: true })).toBeVisible()
    expect(await paneContent(page)).toMatchObject({ sessionId: created.sessionId, createRequestId: CREATE_REQUEST_ID,
      sessionRef: recovering.sessionRef, resumeSessionId: recovering.resumeSessionId, soulId: SOUL_ID })
    expect(sent.slice(firstSend).filter((frame) => ['freshAgent.create', 'pane.reconcile.request'].includes(frame.type))).toEqual([])
    const providerOperations = (await fs.readFile(operations, 'utf8')).trim().split('\n').map((row) => JSON.parse(row))
    expect(providerOperations.filter((operation) => operation.method === 'thread/start')).toHaveLength(1)
    const resumed = providerOperations.filter((operation) => operation.method === 'thread/resume')
    expect(resumed).toHaveLength(1)
    expect(resumed[0].params.threadId).toBe(recovering.resumeSessionId)
    expect(await fs.readFile(rollout, 'utf8')).toBe(transcript)
  } finally {
    await client?.dispose()
    await server.stop()
  }
})

test('managed terminal status and replacement events keep automatic recovery invisible', async ({ freshellPage, page, terminal, harness, serverInfo }) => {
  await terminal.waitForTerminal()
  const client = await RawWsClient.connect(serverInfo.wsUrl)
  let replacementId: string
  try {
    client.hello(serverInfo.token)
    await client.nextJsonMessage('ready', 10_000)
    client.sendJson({ type: 'terminal.create', requestId: 'contextual-replacement-shell', mode: 'shell', shell: 'system' })
    replacementId = (await client.nextJsonMessage<{ terminalId: string }>('terminal.created', 10_000)).terminalId
  } finally { await client.dispose() }
  await installPane(page, 'terminal', 'live')
  await page.evaluate(() => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    const state = harness.getState()
    const tabId = state.tabs.activeTabId!
    const paneId = state.panes.activePane[tabId]
    harness.setTerminalNetworkEffectsSuppressed(paneId, false)
    harness.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId, content: { ...state.panes.layouts[tabId].content } } })
  })
  await expect.poll(async () => (await harness.getSentWsMessages() as Array<{ type?: string }>).some((frame) => frame.type === 'terminal.attach')).toBe(true)
  const before = await paneContent(page)
  if (before.kind !== 'terminal' || !before.terminalId) throw new Error('Expected the retained terminal identity')
  await harness.receiveWsMessage({ type: 'terminal.status', terminalId: before.terminalId, status: 'recovering',
    attempt: 2, maxAttempts: 3, exitCode: 137 })
  await expect(page.getByText(/auto-resuming/)).toBeHidden()
  await changeRecoveryState(page, 'recovering')
  await harness.receiveWsMessage({ type: 'terminal.replaced', oldTerminalId: before.terminalId,
    newTerminalId: replacementId, exitCode: 137, attempt: 2, maxAttempts: 3 })
  await expect.poll(() => paneContent(page)).toMatchObject({ terminalId: replacementId,
    crashTrace: { exitCode: 137 }, sessionRef: before.sessionRef, soulId: before.soulId,
    createRequestId: before.createRequestId })
  await expect(page.getByTestId('terminal-xterm-container')).toBeVisible()
  await expect(page.getByTestId('crash-trace')).toBeHidden()
  await expect(page.getByText(/auto-resumed|auto-resuming|Recovering terminal output/)).toBeHidden()
  await expect(page.getByTestId('managed-runtime-recovery-card')).toBeHidden()
  await changeRecoveryState(page, 'blocked')
  await expect(page.getByTestId('managed-runtime-recovery-card')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry recovery', exact: true })).toBeVisible()
})

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
        : { json: { outcome: 'blocked', view: { soulId: SOUL_ID, intentRevision: INTENT_REVISION, recoveryReason: 'STORE_UNREADABLE' },
          probe: { kind: 'blocked', data: { reason: 'STORE_UNREADABLE', retry_hint: { manualRetry: true,
            repair: 'Restore read access to the saved conversation store, then retry recovery.' } } } } })
    })
    await page.route(/\/api\/runtime\/souls(?:\?.*)?$/, async (route) => {
      inventoryRefreshes += 1
      await route.fulfill({ json: { revision: 100, readiness, souls: [], viewIntents: [], pendingProjectionCount: 0 } })
    })
    const card = page.getByTestId('managed-runtime-recovery-card')
    await expect(card).toBeVisible()
    await expect(card).toContainText('This session needs attention before it can continue.')
    await expect(card).toContainText('The provider is unavailable. Check its availability, then retry recovery.')
    if (kind === 'fresh-agent') await expect(page.getByText(SAVED_HISTORY_TEXT, { exact: true })).toBeVisible()
    await card.getByRole('button', { name: 'Retry recovery', exact: true }).click()
    await expect(card.getByRole('status')).toHaveText('The provider is still unavailable. Try again.')
    await expect(page.getByRole('alert', { name: 'Managed runtime notice' })).toBeHidden()
    expect(inventoryRefreshes).toBe(0)
    await card.getByRole('button', { name: 'Retry recovery', exact: true }).click()
    await expect.poll(() => inventoryRefreshes).toBe(1)
    await expect(card.getByRole('status')).toHaveText('Restore read access to the saved conversation store, then retry recovery.')
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

  for (const deliveryOrder of (kind === 'fresh-agent' ? ['ack-first', 'inventory-first'] : ['ack-first'])) {
  test(`${kind}: lost identity remains until explicit start-new cleanup is verified (${deliveryOrder})`, async ({ freshellPage, page, terminal, harness }) => {
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
    if (replacement.kind === 'fresh-agent') {
      expect(replacement.sessionId).toBeUndefined()
      const tabsBeforeInventory = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getState().tabs.tabs.map((tab) => tab.id))
      const newSoulId = 'new-contextual-soul'
      const runtimeSessionId = 'new-runtime-session'
      const inventoryRevision = 101
      await page.route(/\/api\/runtime\/souls(?:\?.*)?$/, (route) => route.fulfill({ json: {
        revision: inventoryRevision, readiness: { ...readiness, inventoryRevision }, pendingProjectionCount: 0,
        souls: [{ soulId: newSoulId, incarnationId: 'new-incarnation', intentRevision: 1,
          executionGeneration: 1, launchState: 'running', cleanupState: 'none',
          desiredState: 'running', recoveryState: 'live', durabilityState: 'unknown', allocationState: 'allocated',
          provider: 'codex', freshAgentSessionId: runtimeSessionId, freshAgentSessionType: 'freshcodex',
          freshAgentCreateRequestId: replacement.createRequestId,
          evidenceRevision: 0, successfulRecoveriesInWindow: 0 }],
        viewIntents: [{ viewId: 'new-contextual-view', soulId: newSoulId, ownerId: 'fixture-owner', workspaceId: 'fixture-workspace',
          kind: 'automatic_primary', preferredTabId: 'new-preferred-tab', preferredPaneId: 'new-preferred-pane',
          title: 'New conversation', placementGroup: '', visibility: 'visible', revision: 1, soulIntentRevision: 1,
          createdAt: 1, updatedAt: 1 }],
      } }))
      const acknowledge = async () => {
        await harness.receiveWsMessage({ type: 'freshAgent.created', requestId: replacement.createRequestId,
          sessionId: runtimeSessionId, sessionType: 'freshcodex', provider: 'codex', runtimeProvider: 'codex' })
        await expect.poll(async () => {
          const content = await paneContent(page)
          return content.kind === 'fresh-agent' ? content.sessionId : undefined
        }).toBe(runtimeSessionId)
      }
      if (deliveryOrder === 'ack-first') await acknowledge()
      await harness.receiveWsMessage({ type: 'runtime.inventory.changed', revision: inventoryRevision,
        readiness: { ...readiness, inventoryRevision } })
      await expect.poll(async () => (await paneContent(page)).soulId).toBe(newSoulId)
      if (deliveryOrder === 'inventory-first') await acknowledge()
      expect(await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getState().tabs.tabs.map((tab) => tab.id))).toEqual(tabsBeforeInventory)
      expect(await paneContent(page)).toMatchObject({ kind: 'fresh-agent', sessionId: runtimeSessionId,
        createRequestId: replacement.createRequestId, viewIntentId: 'new-contextual-view' })
      const afterInventoryMessages = await harness.getSentWsMessages() as Array<{ type?: string }>
      expect(afterInventoryMessages.filter((message) => message.type === 'terminal.create')).toEqual([])
    }
  })
  }
}

test('shared Fresh session puts the recovery decision on its originating pane despite layout order', async ({ freshellPage, page, terminal, harness }) => {
  await terminal.waitForTerminal()
  await installPane(page, 'fresh-agent', 'live')
  const identity = await page.evaluate(({ sessionId, model }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__!
    const state = harness.getState()
    const tabId = state.tabs.activeTabId!
    const mirrorPaneId = state.panes.activePane[tabId]
    const originPaneId = 'shared-session-origin-pane'
    harness.setFreshAgentNetworkEffectsSuppressed(originPaneId, true)
    const content = (createRequestId: string) => ({ kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex',
      createRequestId, sessionId, sessionRef: { provider: 'codex', sessionId }, status: 'idle',
      initialCwd: '/tmp', settingsDismissed: true, model, effort: 'low' })
    harness.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId: mirrorPaneId, content: content('mirror-create') } })
    harness.dispatch({ type: 'panes/splitPane', payload: { tabId, paneId: mirrorPaneId, direction: 'horizontal',
      newPaneId: originPaneId, newContent: content('origin-create'), activate: false } })
    harness.clearSentWsMessages?.()
    return { tabId, mirrorPaneId, originPaneId, tabIds: state.tabs.tabs.map((tab) => tab.id) }
  }, { sessionId: SESSION_ID, model: FRESHCODEX_DEFAULT_MODEL })
  const inventoryRevision = 171
  await page.route(/\/api\/runtime\/souls(?:\?.*)?$/, (route) => route.fulfill({ json: {
    revision: inventoryRevision, readiness: { ...readiness, inventoryRevision }, pendingProjectionCount: 0,
    souls: [{ soulId: SOUL_ID, incarnationId: 'shared-incarnation', intentRevision: INTENT_REVISION,
      executionGeneration: 1, launchState: 'stopped', cleanupState: 'none', desiredState: 'stopped',
      recoveryState: 'lost', recoveryReason: 'provider_state_missing', durabilityState: 'resume_captured',
      allocationState: 'verified_durable', provider: 'codex', nativeSessionId: SESSION_ID,
      freshAgentSessionId: SESSION_ID, freshAgentSessionType: 'freshcodex', freshAgentCreateRequestId: 'origin-create',
      evidenceRevision: 1, successfulRecoveriesInWindow: 0 }],
    viewIntents: [{ viewId: 'shared-origin-view', soulId: SOUL_ID, ownerId: 'fixture-owner', workspaceId: 'fixture-workspace',
      kind: 'automatic_primary', preferredTabId: identity.tabId, preferredPaneId: identity.originPaneId,
      title: 'Retained conversation', placementGroup: '', visibility: 'visible', revision: 1,
      soulIntentRevision: INTENT_REVISION, createdAt: 1, updatedAt: 1 }],
  } }))
  await harness.receiveWsMessage({ type: 'runtime.inventory.changed', revision: inventoryRevision, readiness: { ...readiness, inventoryRevision } })
  const card = page.getByTestId('managed-runtime-recovery-card')
  await expect(card).toBeVisible()
  expect(await card.evaluate((element) => element.closest('[data-pane-id]')?.getAttribute('data-pane-id'))).toBe(identity.originPaneId)
  await expect(card.getByRole('button', { name: 'Start new conversation', exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'Retry recovery', exact: true })).toBeHidden()
  const panes = await page.evaluate((tabId) => {
    const root = window.__FRESHELL_TEST_HARNESS__!.getState().panes.layouts[tabId]
    if (root?.type !== 'split') throw new Error('Expected the original two panes')
    return root.children.map((node) => {
      if (node.type !== 'leaf') throw new Error('Expected a leaf')
      return { id: node.id, content: node.content }
    })
  }, identity.tabId)
  expect(panes[0]).toMatchObject({ id: identity.mirrorPaneId, content: { createRequestId: 'mirror-create' } })
  expect(panes[0].content.recoverySummary).toBeUndefined()
  expect(panes[1]).toMatchObject({ id: identity.originPaneId, content: { createRequestId: 'origin-create',
    viewIntentId: 'shared-origin-view', recoverySummary: { desiredState: 'stopped', recoveryState: 'lost' } } })
  expect(await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getState().tabs.tabs.map((tab) => tab.id))).toEqual(identity.tabIds)
})

for (const deliveryOrder of ['ack-first', 'inventory-first'] as const) {
  test(`concurrent Fresh launches preserve their panes with ${deliveryOrder} inventory delivery`, async ({ freshellPage, page, terminal, harness }) => {
    await terminal.waitForTerminal()
    await page.route('**/api/fresh-agent/threads/**', (route) => route.fulfill({ status: 404, json: { message: 'Conversation is not yet available' } }))
    const identity = await page.evaluate((model) => {
      const harness = window.__FRESHELL_TEST_HARNESS__!
      const state = harness.getState()
      const tabId = state.tabs.activeTabId!
      const paneId = state.panes.activePane[tabId]
      const secondPaneId = 'concurrent-second-pane'
      harness.setFreshAgentNetworkEffectsSuppressed(paneId, true)
      harness.setFreshAgentNetworkEffectsSuppressed(secondPaneId, true)
      const content = (createRequestId: string) => ({ kind: 'fresh-agent', sessionType: 'freshcodex', provider: 'codex',
        createRequestId, status: 'creating', initialCwd: '/tmp', settingsDismissed: true, model, effort: 'low' })
      harness.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId, content: content('concurrent-first-create') } })
      harness.dispatch({ type: 'panes/splitPane', payload: { tabId, paneId, direction: 'horizontal',
        newPaneId: secondPaneId, newContent: content('concurrent-second-create'), activate: false } })
      harness.clearSentWsMessages?.()
      return { tabId, paneIds: [paneId, secondPaneId], tabIds: state.tabs.tabs.map((tab) => tab.id) }
    }, FRESHCODEX_DEFAULT_MODEL)
    const inventoryRevision = 151
    const keys = ['first', 'second']
    await page.route(/\/api\/runtime\/souls(?:\?.*)?$/, (route) => route.fulfill({ json: {
      revision: inventoryRevision, readiness: { ...readiness, inventoryRevision }, pendingProjectionCount: 0,
      souls: [...keys].reverse().map((key) => ({ soulId: `concurrent-${key}-soul`, incarnationId: `concurrent-${key}-incarnation`,
        intentRevision: 1, executionGeneration: 1, launchState: 'running', cleanupState: 'none',
        desiredState: 'running', recoveryState: 'live', durabilityState: 'unknown', allocationState: 'allocated',
        provider: 'codex', freshAgentSessionId: `concurrent-${key}-runtime`, freshAgentSessionType: 'freshcodex',
        freshAgentCreateRequestId: `concurrent-${key}-create`, evidenceRevision: 0, successfulRecoveriesInWindow: 0 })),
      viewIntents: [...keys].reverse().map((key) => ({ viewId: `concurrent-${key}-view`, soulId: `concurrent-${key}-soul`,
        ownerId: 'fixture-owner', workspaceId: 'fixture-workspace', kind: 'automatic_primary',
        preferredTabId: identity.tabId, preferredPaneId: `concurrent-${key}-preferred-pane`, title: 'Concurrent conversation',
        placementGroup: '', visibility: 'visible', revision: 1, soulIntentRevision: 1, createdAt: 1, updatedAt: 1 })),
    } }))
    const readPanes = () => page.evaluate((tabId) => {
      const root = window.__FRESHELL_TEST_HARNESS__!.getState().panes.layouts[tabId]
      if (root?.type !== 'split') throw new Error('Expected two original panes')
      return root.children.map((node) => {
        if (node.type !== 'leaf') throw new Error('Expected original leaf')
        return { id: node.id, content: node.content }
      })
    }, identity.tabId)
    const acknowledge = async () => {
      for (const key of keys) await harness.receiveWsMessage({ type: 'freshAgent.created', requestId: `concurrent-${key}-create`,
        sessionId: `concurrent-${key}-runtime`, sessionType: 'freshcodex', provider: 'codex', runtimeProvider: 'codex' })
      await expect.poll(async () => (await readPanes()).map((pane) => pane.content.kind === 'fresh-agent' ? pane.content.sessionId : undefined))
        .toEqual(keys.map((key) => `concurrent-${key}-runtime`))
    }
    if (deliveryOrder === 'ack-first') await acknowledge()
    await harness.receiveWsMessage({ type: 'runtime.inventory.changed', revision: inventoryRevision, readiness: { ...readiness, inventoryRevision } })
    await expect.poll(async () => (await readPanes()).map((pane) => pane.content.soulId)).toEqual(keys.map((key) => `concurrent-${key}-soul`))
    if (deliveryOrder === 'inventory-first') await acknowledge()
    const panes = await readPanes()
    for (const [index, key] of keys.entries()) expect(panes[index]).toMatchObject({ id: identity.paneIds[index], content: {
      kind: 'fresh-agent', createRequestId: `concurrent-${key}-create`, sessionId: `concurrent-${key}-runtime`,
      soulId: `concurrent-${key}-soul`, viewIntentId: `concurrent-${key}-view`,
    } })
    expect(await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__!.getState().tabs.tabs.map((tab) => tab.id))).toEqual(identity.tabIds)
    const messages = await harness.getSentWsMessages() as Array<{ type?: string }>
    expect(messages.filter((message) => message.type === 'terminal.create')).toEqual([])
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
