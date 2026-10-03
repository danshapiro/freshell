import nativeCodexHistory from '../../fixtures/managed-native-history/codex.json' with { type: 'json' }
import fs from 'node:fs/promises'
import path from 'node:path'
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

async function installPane(page: Page, kind: PaneKind, recoveryState: RecoveryState, missingSoul = false) {
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
  await page.evaluate(({ kind, summary, sessionId, soulId, revision, createRequestId, model, missingSoul }) => {
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
      ...(summary.recoveryState === 'lost' ? {} : { sessionId }),
      ...identity, ...managed, status: missingSoul ? 'error' : 'idle', model, effort: 'low',
      ...(missingSoul ? { closeError: 'Previous close was not confirmed' } : {}),
      initialCwd: '/tmp', settingsDismissed: true,
    }
    harness.dispatch({ type: 'panes/updatePaneContent', payload: { tabId, paneId, content } })
    harness.clearSentWsMessages?.()
  }, {
    kind, summary: recoverySummary(recoveryState), sessionId: SESSION_ID, soulId: SOUL_ID,
    revision: INTENT_REVISION, createRequestId: CREATE_REQUEST_ID, model: FRESHCODEX_DEFAULT_MODEL, missingSoul,
  })
}

test('fresh-agent: cold lost pane without a soul retains saved history and a close warning after refused start-new', async ({ freshellPage, page, terminal, harness, serverInfo }) => {
  await terminal.waitForTerminal()
  const sessions = path.join(serverInfo.homeDir, '.codex', 'sessions', '2026', '03', '01')
  await fs.mkdir(sessions, { recursive: true })
  const events = await fs.readFile('test/fixtures/coding-cli/codex/task-events.sanitized.jsonl', 'utf8')
  const tools = await fs.readFile('test/fixtures/managed-native-history/codex-tools.jsonl', 'utf8')
  const transcript = events.replace('session-activity', SESSION_ID)
    .replace('Sanitized completion', SAVED_HISTORY_TEXT) + tools.split('\n').slice(1).join('\n')
  const rollout = path.join(sessions, `rollout-${SESSION_ID}.jsonl`)
  await fs.writeFile(rollout, transcript)
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
  expect(snapshot.extensions.codex.nativeHistoryAvailable).toBe(true)
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
