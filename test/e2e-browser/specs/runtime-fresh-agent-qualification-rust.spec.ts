/**
 * Explicit, paid-provider fresh-agent qualification. This file never runs in
 * the default campaign and never selects a fixture transport. The exact mode
 * allowlist is parsed before the RuntimeHarness (and therefore Docker) exists.
 */
import { randomBytes } from 'node:crypto'

import { expect, type Page } from '@playwright/test'

import type { FreshAgentQualificationRow } from '../../../scripts/testing/fresh-agent-qualification-receipt.js'
import {
  FRESH_AGENT_QUALIFICATION_MODES_ENV,
  parseFreshAgentQualificationModes,
  type QualifiableFreshAgentMode,
} from '../../../scripts/testing/fresh-agent-qualification-selection.js'
import { FRESH_AGENT_QUALIFICATION_LIVE_ENV } from '../../../scripts/testing/runtime-fresh-agent-qualification.js'
import { findFreshAgentCreateOutcome } from '../../../scripts/testing/fresh-agent-create-result.js'
import { test } from '../helpers/fixtures.js'
import { createManagedRuntimeBrowserRig, openFreshHistorySession, splitFreshBrowserPane, observeFreshMcpIngress, type ManagedRuntimeView, type ManagedFixtureRig } from '../helpers/managed-runtime.js'
import { observeOwnedFreshBrowserPane, stageOwnedFreshBrowserProfile } from '../../../scripts/testing/runtime-external-browser.js'
import { TestHarness } from '../helpers/test-harness.js'

type Definition = {
  mode: QualifiableFreshAgentMode
  agent: 'claude' | 'kilroy' | 'codex' | 'opencode'
  provider: 'claude' | 'codex' | 'opencode'
  version: string
  model: string
  effort: string
  versionCommand: string[]
  processPattern: RegExp
  pendingApproval: boolean
}

const DEFINITIONS: Record<QualifiableFreshAgentMode, Definition> = {
  // These Claude-backed modes use SDK 0.3.237's actual default native child
  // 2.1.237. The ordinary terminal's global 2.1.263 pin is a separate process.
  // Pending continuity is qualified only for the native solo Bash defer
  // checkpoint, with a current same-operation callback and observed effect.
  freshclaude: { mode: 'freshclaude', agent: 'claude', provider: 'claude', version: '2.1.237', model: 'haiku', effort: 'low', versionCommand: ['/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude', '--version'], processPattern: /(?:^|\s)\/opt\/freshell-claude-sidecar\/node_modules\/@anthropic-ai\/claude-agent-sdk-linux-x64\/claude(?:$|\s)/m, pendingApproval: true },
  kilroy: { mode: 'kilroy', agent: 'kilroy', provider: 'claude', version: '2.1.237', model: 'haiku', effort: 'low', versionCommand: ['/opt/freshell-claude-sidecar/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude', '--version'], processPattern: /(?:^|\s)\/opt\/freshell-claude-sidecar\/node_modules\/@anthropic-ai\/claude-agent-sdk-linux-x64\/claude(?:$|\s)/m, pendingApproval: true },
  freshcodex: { mode: 'freshcodex', agent: 'codex', provider: 'codex', version: '0.147.0', model: 'gpt-5.6-luna', effort: 'low', versionCommand: ['codex', '--version'], processPattern: /codex.*app-server|app-server.*codex/m, pendingApproval: false },
  freshopencode: { mode: 'freshopencode', agent: 'opencode', provider: 'opencode', version: '1.18.21', model: 'opencode/big-pickle', effort: 'provider-default', versionCommand: ['opencode', '--version'], processPattern: /opencode.*serve/m, pendingApproval: false },
}

function selectedDefinitions(): Definition[] {
  const raw = process.env[FRESH_AGENT_QUALIFICATION_MODES_ENV]
  if (raw === undefined) throw new Error(`${FRESH_AGENT_QUALIFICATION_MODES_ENV} must explicitly select modes`)
  return parseFreshAgentQualificationModes(raw).map((mode) => DEFINITIONS[mode])
}

async function waitFor<T>(description: string, probe: () => Promise<T | null> | T | null, timeout = 240_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for ${description}`)
}

function dataOf(result: any): any {
  return result?.data?.data ?? result?.data ?? result
}

async function sendBrowserNoToolTurn(page: Page, paneId: string, instruction: string): Promise<void> {
  const composer = page.locator('[data-pane-id="' + paneId + '"]').getByRole('textbox', { name: 'Chat message input' })
  await expect(composer).toBeEnabled({ timeout: 60_000 })
  await composer.fill(instruction)
  await composer.press('Enter')
}

export async function replacement(rig: ManagedFixtureRig, created: { reply: { sessionId: string } }, prior: string): Promise<ManagedRuntimeView> {
  return waitFor('replacement incarnation', async () => {
    // The pane materializes to native identity; runtime inventory retains the
    // presentation identity from this exact create reply across recovery.
    const view = await rig.runningViewForFreshSession(created.reply.sessionId)
    return view?.containerId && view.incarnationId !== prior ? view : null
  })
}

export async function aliasActivation(rig: ManagedFixtureRig, created: { reply: { sessionId: string }; view: ManagedRuntimeView }, reply: { sessionId: string }): Promise<ManagedRuntimeView> {
  if (!created.view.nativeSessionId || reply.sessionId !== created.view.nativeSessionId) throw new Error('actual alias reply differs from the original native root')
  return waitFor('actual alias activation', async () => {
    const view = await rig.runningViewForFreshSession(created.reply.sessionId)
    if (!view?.containerId) return null
    if (['soulId', 'nativeSessionId', 'provider', 'freshAgentSessionType', 'incarnationId', 'containerId', 'hostBootId'].some(field =>
      view[field as keyof ManagedRuntimeView] !== created.view[field as keyof ManagedRuntimeView])) throw new Error('actual alias activation differs from the original allocation')
    return view
  })
}

type WireObservations = { sent: any[]; received: any[] }
function observeBrowserWire(page: Page): WireObservations {
  const observed: WireObservations = { sent: [], received: [] }
  page.on('websocket', socket => {
    socket.on('framesent', frame => { try { observed.sent.push(JSON.parse(String(frame.payload))) } catch { /* non-JSON frame */ } })
    socket.on('framereceived', frame => { try { observed.received.push(JSON.parse(String(frame.payload))) } catch { /* non-JSON frame */ } })
  })
  return observed
}

function ordinaryFreshAgentEventFacts(frames: readonly any[]) {
  const counts = { created: 0, createFailed: 0, assistant: 0, stream: 0, error: 0,
    snapshot: 0, changed: 0, turnComplete: 0, result: 0 }
  const turnOutcomes: Record<string, number> = {}
  const createFailureCodes = new Set<string>()
  let errorCodePresent = false
  let errorMessagePresent = false
  let assistantTextCharacters = 0
  let streamedTextCharacters = 0
  for (const frame of frames) {
    if (frame?.type === 'freshAgent.created') counts.created++
    if (frame?.type === 'freshAgent.create.failed') {
      counts.createFailed++
      if (typeof frame.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(frame.code)) createFailureCodes.add(frame.code)
    }
    if (frame?.type !== 'freshAgent.event' || !frame.event || typeof frame.event !== 'object') continue
    const event = frame.event as Record<string, any>
    switch (event.type) {
      case 'freshAgent.assistant':
        counts.assistant++
        if (Array.isArray(event.content)) {
          assistantTextCharacters += event.content.reduce((total: number, item: any) =>
            total + (item?.type === 'text' && typeof item.text === 'string' ? item.text.length : 0), 0)
        }
        break
      case 'freshAgent.stream': {
        counts.stream++
        const stream = event.event
        const delta = stream?.type === 'content_block_delta' ? stream.delta : undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') streamedTextCharacters += delta.text.length
        break
      }
      case 'freshAgent.error':
        counts.error++
        errorCodePresent ||= typeof event.code === 'string'
        errorMessagePresent ||= typeof event.message === 'string'
        break
      case 'freshAgent.session.snapshot': counts.snapshot++; break
      case 'freshAgent.session.changed': counts.changed++; break
      case 'freshAgent.turn.complete': {
        counts.turnComplete++
        if (typeof event.outcome === 'string' && /^[a-z_]{1,32}$/.test(event.outcome)) {
          turnOutcomes[event.outcome] = (turnOutcomes[event.outcome] ?? 0) + 1
        }
        break
      }
      case 'freshAgent.result': counts.result++; break
    }
  }
  return { counts, createFailureCodes: [...createFailureCodes].sort(), errorCodePresent, errorMessagePresent,
    assistantTextCharacters, streamedTextCharacters, turnOutcomes }
}

async function paneFor(page: Page, observation: Parameters<typeof observeOwnedFreshBrowserPane>[0]) {
  return waitFor('actual fresh pane', () => page.evaluate(observeOwnedFreshBrowserPane, observation))
}

async function actualCreate(page: Page, rig: ManagedFixtureRig, definition: Definition, wire: WireObservations, splitPaneId?: string) {
  const cursor = wire.sent.length
  const beforeSouls = (await rig.inventory()).map(view => view.soulId).sort()
  // The existing harness holds network effects only while the real picker
  // stages its pane. Profile setup precedes the first actual create; the
  // picker interaction and its subsequently observed wire request remain real.
  await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.setSuppressAllFreshAgentNetworkEffects(true))
  try {
    if (splitPaneId) await splitFreshBrowserPane(page, splitPaneId)
    else await page.keyboard.press('Alt+t')
    const label = { freshclaude: 'Freshclaude', kilroy: 'Kilroy', freshcodex: 'Freshcodex', freshopencode: 'Freshopencode' }[definition.mode]
    const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: new RegExp('^' + label + '$', 'i') }).click()
    const cwd = page.getByLabel('Starting directory for ' + label)
    await expect(cwd).toBeVisible()
    await cwd.fill(rig.repoRoot)
    await cwd.press('Enter')
    expect(wire.sent.slice(cursor).filter(frame => frame.type === 'freshAgent.create')).toHaveLength(0)
    expect((await rig.inventory()).map(view => view.soulId).sort()).toEqual(beforeSouls)
    const staged = await waitFor('picker-staged fresh pane', () => page.evaluate(stageOwnedFreshBrowserProfile,
      { mode: definition.mode, model: definition.model, effort: definition.effort }))
    const request = await waitFor('actual UI fresh create request', () => wire.sent.slice(cursor).find(frame => frame.type === 'freshAgent.create' && frame.sessionType === definition.mode) ?? null)
    expect(request.requestId).toBe(staged.createRequestId)
    const reply = await waitFor('actual UI fresh create result', () => {
      const outcome = findFreshAgentCreateOutcome(wire.received, request.requestId)
      if (outcome?.kind === 'failed') throw new Error(`fresh-agent create failed (${outcome.code})`)
      return outcome?.kind === 'created' ? outcome.reply : null
    })
    const view = await waitFor('actual supervised UI native allocation', async () => {
      const value = await rig.runningViewForFreshSession(reply.sessionId)
      return value?.nativeSessionId && value.containerId ? value : null
    })
    const paneObservation = {
      ...staged, sessionType: definition.mode, provider: definition.provider,
      createdSessionId: reply.sessionId, nativeSessionId: view.nativeSessionId!,
    }
    const pane = await paneFor(page, paneObservation)
    return { request, reply, view, ...pane, paneObservation }
  } finally { await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.setSuppressAllFreshAgentNetworkEffects(false)) }
}

async function reloadOwnedBrowser(page: Page, rig: ManagedFixtureRig) {
  await page.goto(rig.info.baseUrl + '/?token=' + rig.info.token + '&e2e=1')
  await new TestHarness(page).waitForConnection()
}

async function qualify(page: Page, rig: ManagedFixtureRig, definition: Definition, wire: WireObservations): Promise<FreshAgentQualificationRow> {
  const initial = await actualCreate(page, rig, definition, wire)
  let main = initial.view
  const collection = await rig.registerFreshNativeCollection(rig.exactRuntimeHandle(main), 'codename-' + randomBytes(16).toString('hex'))
  const id = collection.collectionId
  await rig.observeFreshBrowserIngress(rig.exactRuntimeHandle(main), id, { ingress: 'browser-picker', request: initial.request, reply: initial.reply })
  await rig.observeFreshBrowserIngress(rig.exactRuntimeHandle(main), id, { ingress: 'ws-create', request: initial.request, reply: initial.reply })
  await rig.captureFreshNativeStage(rig.exactRuntimeHandle(main), id)

  const auxiliary = await actualCreate(page, rig, definition, wire, initial.paneId)
  let other = auxiliary.view
  await rig.observeFreshBrowserIngress(rig.exactRuntimeHandle(other), id, { ingress: 'browser-split', request: auxiliary.request, reply: auxiliary.reply })
  const ui = await rig.registerFreshBrowserTurn(rig.exactRuntimeHandle(other), id)
  const sendCursor = wire.sent.length
  await sendBrowserNoToolTurn(page, auxiliary.paneId, ui.prompt!)
  const sentPane = await paneFor(page, auxiliary.paneObservation)
  const send = await waitFor('browser composer send', () => wire.sent.slice(sendCursor).find(frame => frame.type === 'freshAgent.send' && frame.sessionId === sentPane.sessionId) ?? null)
  const accepted = await waitFor('browser composer accepted', () => wire.received.find(frame => frame.type === 'freshAgent.send.accepted' && frame.requestId === send.requestId) ?? null)
  await rig.finishFreshBrowserTurn(rig.exactRuntimeHandle(other), ui.challengeId, send, accepted)

  // Each alias doorway is invoked separately against the existing root. It needs no additional model call.
  const params = { agent: definition.agent, cwd: rig.repoRoot, model: definition.model,
    effort: definition.effort === 'provider-default' ? undefined : definition.effort,
    permissionMode: 'default', sessionRef: { provider: definition.provider, sessionId: main.nativeSessionId } }
  for (const [ingress, action] of [['mcp-new-tab', 'new-tab'], ['mcp-split', 'split-pane']] as const) {
    const observed = await observeFreshMcpIngress(action, { ...params, ...(action === 'split-pane' ? { target: auxiliary.paneId, direction: 'horizontal' } : {}) })
    const view = await aliasActivation(rig, initial, observed.reply)
    await rig.observeFreshBrowserIngress(rig.exactRuntimeHandle(view), id, { ingress, ...observed })
  }
  for (const [ingress, route] of [['rest-tab', '/api/tabs'], ['rest-split', '/api/panes/' + auxiliary.paneId + '/split']] as const) {
    const body = { ...params, ...(ingress === 'rest-split' ? { direction: 'horizontal' } : {}) }
    const response = await page.request.post(rig.info.baseUrl + route, { headers: { 'X-Auth-Token': rig.info.token }, data: body })
    expect(response.ok()).toBe(true)
    const reply = dataOf(await response.json())
    const view = await aliasActivation(rig, initial, reply)
    await rig.observeFreshBrowserIngress(rig.exactRuntimeHandle(view), id, { ingress, request: { method: 'POST', path: route, body }, reply })
  }

  const historyCursor = wire.sent.length
  await openFreshHistorySession(page, { repoRoot: rig.repoRoot, provider: definition.provider, nativeSessionId: main.nativeSessionId! })
  const historyPane = await paneFor(page, initial.paneObservation)
  const historyRequest = await waitFor('actual history resume route', () => wire.sent.slice(historyCursor).find(frame =>
    frame.type === 'freshAgent.create' && frame.sessionRef?.sessionId === main.nativeSessionId
    || frame.type === 'freshAgent.attach' && frame.sessionId === historyPane.sessionId) ?? null)
  const historyReply = historyRequest.type === 'freshAgent.create' ? await waitFor('actual history create reply',
    () => wire.received.find(frame => frame.type === 'freshAgent.created' && frame.requestId === historyRequest.requestId) ?? null) : undefined
  await rig.observeFreshBrowserIngress(rig.exactRuntimeHandle(main), id, { ingress: 'history-resume', request: historyRequest, ...(historyReply ? { reply: historyReply } : {}) })

  const attachCursor = wire.sent.length
  await rig.crashAndRestartWeb()
  await reloadOwnedBrowser(page, rig)
  const reconnectedPane = await paneFor(page, initial.paneObservation)
  const attach = await waitFor('actual reconnect attach', () => wire.sent.slice(attachCursor).find(frame => frame.type === 'freshAgent.attach' && frame.sessionId === reconnectedPane.sessionId) ?? null)
  await rig.observeFreshBrowserIngress(rig.exactRuntimeHandle(main), id, { ingress: 'ws-attach', request: attach })
  await rig.restartSupervisor()
  await rig.crashRuntimeHost(rig.exactRuntimeHandle(main))
  main = await replacement(rig, initial, main.incarnationId)
  await rig.captureFreshNativeStage(rig.exactRuntimeHandle(main), id)
  await rig.crashProviderWorker(rig.exactRuntimeHandle(main))
  main = await replacement(rig, initial, main.incarnationId)
  await rig.captureFreshNativeStage(rig.exactRuntimeHandle(main), id)

  if (definition.pendingApproval) {
    for (const recovery of ['web', 'host', 'provider'] as const) for (const allowed of [true, false]) {
      const challenge = await rig.registerFreshApproval(rig.exactRuntimeHandle(other), allowed, recovery)
      const { paneId } = await paneFor(page, auxiliary.paneObservation)
      const composer = page.locator('[data-pane-id="' + paneId + '"]').getByRole('textbox', { name: 'Chat message input' })
      await expect(composer).toBeEnabled()
      await composer.fill(challenge.prompt!)
      await composer.press('Enter')
      await rig.captureFreshApprovalCheckpoint(rig.exactRuntimeHandle(other), challenge.challengeId)
      if (recovery === 'web') { await rig.crashAndRestartWeb(); await reloadOwnedBrowser(page, rig) }
      else {
        const prior = other.incarnationId
        if (recovery === 'host') await rig.crashRuntimeHost(rig.exactRuntimeHandle(other))
        else await rig.crashProviderWorker(rig.exactRuntimeHandle(other))
        other = await replacement(rig, auxiliary, prior)
      }
      const current = await rig.captureFreshApprovalCheckpoint(rig.exactRuntimeHandle(other), challenge.challengeId)
      const decisionCursor = wire.sent.length
      const decisionPane = page.locator('[data-pane-id="' + (await paneFor(page, auxiliary.paneObservation)).paneId + '"]')
      await decisionPane.getByRole('button', { name: allowed ? 'Allow tool use' : 'Deny tool use', exact: true }).click()
      const decision = await waitFor('actual current browser approval response', () => wire.sent.slice(decisionCursor).find(frame =>
        frame.type === 'freshAgent.approval.respond' && String(frame.requestId) === current.decisionId) ?? null)
      await rig.finishFreshApproval(rig.exactRuntimeHandle(other), challenge.challengeId, decision)
    }
  }
  const row = await rig.captureFreshBrowserRow(rig.exactRuntimeHandle(main), id)
  const finished = await rig.finishFreshNativeCollection(rig.exactRuntimeHandle(main), id)
  expect(finished.completedNativeTurns).toEqual(row.completedNativeTurns)
  expect(finished.providerStoreId).toBe(row.providerStoreId)
  return row
}

test.describe.serial('authentic fresh-agent qualification', () => {
  test('qualifies only explicitly selected modes with production transports', async ({ page }) => {
    test.skip(process.env[FRESH_AGENT_QUALIFICATION_LIVE_ENV] !== '1', `set ${FRESH_AGENT_QUALIFICATION_LIVE_ENV}=1 explicitly`)
    test.setTimeout(3_600_000)
    const definitions = selectedDefinitions()
    const rig = createManagedRuntimeBrowserRig(process.cwd(), 5, {}, {
      FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '750',
    }, 'release', {
      enabledProviders: [],
      freshAgentModes: definitions.map(({ mode }) => mode),
      providerSettings: Object.fromEntries(definitions.map((row) => [row.mode, {
        model: row.model, modelSelection: { kind: 'exact', modelId: row.model }, defaultPermissionMode: 'default', effort: row.effort === 'provider-default' ? undefined : row.effort,
      }])),
    })
    await rig.validateFreshAgentIngressInventory()
    const rows: FreshAgentQualificationRow[] = []
    const wire = observeBrowserWire(page)
    try {
      const info = await rig.start()
      process.env.FRESHELL_URL = info.baseUrl
      process.env.FRESHELL_TOKEN = info.token
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      await new TestHarness(page).waitForConnection()
      for (const definition of definitions) rows.push(await qualify(page, rig, definition, wire))
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
    const finalized = await rig.publishFreshAgentQualification(rows)
    expect(finalized.rowCount).toBe(definitions.length)
    console.log(`[fresh-agent-qualification] receipts: ${finalized.artifactRefs.join(', ')}`)
  })
})

test.describe.serial('ordinary fresh-agent use', () => {
  test('each selected fresh-agent mode completes one ordinary turn', async ({ page }) => {
    test.skip(
      process.env[FRESH_AGENT_QUALIFICATION_LIVE_ENV] !== '1',
      `set ${FRESH_AGENT_QUALIFICATION_LIVE_ENV}=1 explicitly for an ordinary live-provider smoke`,
    )
    test.setTimeout(3_600_000)
    const definitions = selectedDefinitions()
    const rig = createManagedRuntimeBrowserRig(process.cwd(), 5, {}, {
      FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '750',
    }, 'release', {
      enabledProviders: [],
      freshAgentModes: definitions.map(({ mode }) => mode),
      providerSettings: Object.fromEntries(definitions.map((row) => [row.mode, {
        model: row.model,
        modelSelection: { kind: 'exact', modelId: row.model },
        defaultPermissionMode: 'default',
        effort: row.effort === 'provider-default' ? undefined : row.effort,
      }])),
    })
    const wire = observeBrowserWire(page)
    const expectedMarkers = new Set<string>()
    const snapshotResponses: Array<{
      status: number
      turnCount: number | null
      userTurnCount: number | null
      assistantTurnCount: number | null
      assistantErrorCount: number | null
      markerPresent: boolean | null
    }> = []
    const snapshotResponseTasks: Promise<void>[] = []
    page.on('response', response => {
      let pathname: string
      try { pathname = new URL(response.url()).pathname } catch { return }
      if (!pathname.startsWith('/api/fresh-agent/threads/freshopencode/opencode/')) return
      snapshotResponseTasks.push((async () => {
        const status = response.status()
        try {
          const body = await response.json() as { turns?: unknown }
          const turns = Array.isArray(body.turns) ? body.turns.filter((turn): turn is Record<string, unknown> => (
            Boolean(turn) && typeof turn === 'object' && !Array.isArray(turn)
          )) : null
          const assistantTurns = turns?.filter(turn => turn.role === 'assistant') ?? []
          const markerPresent = [...expectedMarkers].some(marker => assistantTurns.some(turn => (
            (typeof turn.summary === 'string' && turn.summary.includes(marker))
            || (Array.isArray(turn.items) && turn.items.some(item => (
              Boolean(item) && typeof item === 'object' && item.kind === 'text'
              && typeof item.text === 'string' && item.text.includes(marker)
            )))
          )))
          snapshotResponses.push({ status, turnCount: turns?.length ?? null,
            userTurnCount: turns?.filter(turn => turn.role === 'user').length ?? null,
            assistantTurnCount: assistantTurns.length,
            assistantErrorCount: assistantTurns.filter(turn => Boolean(turn.error)).length,
            markerPresent })
        } catch {
          snapshotResponses.push({ status, turnCount: null, userTurnCount: null,
            assistantTurnCount: null, assistantErrorCount: null, markerPresent: null })
        }
      })())
    })
    try {
      const info = await rig.start()
      process.env.FRESHELL_URL = info.baseUrl
      process.env.FRESHELL_TOKEN = info.token
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      await new TestHarness(page).waitForConnection()

      const failedModes: string[] = []
      for (const definition of definitions) {
        const receivedCursor = wire.received.length
        let paneId: string | undefined
        const progress = {
          createCompleted: false,
          composerSubmitted: false,
          sendObserved: false,
          turnCompleteObserved: false,
          markerVisible: false,
        }
        try {
          const created = await actualCreate(page, rig, definition, wire)
          paneId = created.paneId
          progress.createCompleted = true
          const marker = `FRESHELL-${randomBytes(12).toString('hex')}`
          expectedMarkers.add(marker)
          const allocationSessionIds = new Set([
            created.reply.sessionId,
            created.sessionId,
            created.view.nativeSessionId,
          ])
          const sendCursor = wire.sent.length
          await sendBrowserNoToolTurn(
            page,
            created.paneId,
            `Without using tools, reply with exactly this text and no other words: ${marker}`,
          )
          progress.composerSubmitted = true
          const sent = await waitFor('actual fresh-agent composer send', () => wire.sent
            .slice(sendCursor)
            .find((frame) => frame.type === 'freshAgent.send' && allocationSessionIds.has(frame.sessionId)) ?? null)
          progress.sendObserved = true
          if (!allocationSessionIds.has(sent.sessionId)) {
            throw new Error('fresh-agent send was not associated with the selected allocation')
          }
          await waitFor(`${definition.mode} completed answer`, async () => {
            const completed = wire.received.slice(receivedCursor).some((frame) => (
              frame.type === 'freshAgent.event'
              && allocationSessionIds.has(frame.sessionId)
              && frame.event?.type === 'freshAgent.turn.complete'
            ))
            if (completed) progress.turnCompleteObserved = true
            const visibleAnswer = await page.locator(`[data-pane-id="${created.paneId}"] [data-turn-role="assistant"]`)
              .evaluateAll((turns, expectedMarker) => turns.some((turn) => turn.textContent?.includes(expectedMarker)), marker)
            if (visibleAnswer) progress.markerVisible = true
            return completed && visibleAnswer ? true : null
          }, 240_000)
          console.info(JSON.stringify({ severity: 'info', event: 'durable_souls.ordinary_turn_completed',
            lane: 'fresh-agent', mode: definition.mode }))
        } catch (error) {
          failedModes.push(definition.mode)
          await Promise.allSettled(snapshotResponseTasks)
          let assistantDom = { available: false, rows: 0, textCharacters: 0 }
          if (paneId) {
            try {
              assistantDom = await page.locator(`[data-pane-id="${paneId}"] [data-turn-role="assistant"]`)
                .evaluateAll((turns) => ({ available: true, rows: turns.length,
                  textCharacters: turns.reduce((total, turn) => total + (turn.textContent?.length ?? 0), 0) }))
            } catch { /* preserve the ordinary-turn failure */ }
          }
          console.error(JSON.stringify({ severity: 'error', event: 'durable_souls.ordinary_turn_failed',
            lane: 'fresh-agent', mode: definition.mode,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            providerEvents: ordinaryFreshAgentEventFacts(wire.received.slice(receivedCursor)), assistantDom,
            opencodeSnapshotResponses: { count: snapshotResponses.length, tail: snapshotResponses.slice(-8) },
            ...progress }))
        }
      }
      expect(failedModes, `ordinary fresh-agent turn failed for: ${failedModes.join(', ')}`).toEqual([])
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
  })
})
