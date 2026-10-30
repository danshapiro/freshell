/**
 * Explicit, paid-provider fresh-agent qualification. This file never runs in
 * the default campaign and never selects a fixture transport. The exact mode
 * allowlist is parsed before the RuntimeHarness (and therefore Docker) exists.
 */
import { randomBytes } from 'node:crypto'
import { withOwnedCleanup } from '../../../scripts/testing/owned-cleanup.js'

import { expect, type Page } from '@playwright/test'

import type { FreshAgentQualificationRow } from '../../../scripts/testing/fresh-agent-qualification-receipt.js'
import {
  FRESH_AGENT_QUALIFICATION_MODES_ENV,
  parseFreshAgentQualificationModes,
  type QualifiableFreshAgentMode,
} from '../../../scripts/testing/fresh-agent-qualification-selection.js'
import { FRESH_AGENT_QUALIFICATION_LIVE_ENV } from '../../../scripts/testing/runtime-fresh-agent-qualification.js'
import {
  observeFreshAgentBrowserWire,
  type FreshAgentWireFrame,
  type FreshAgentWireObservations,
} from '../helpers/fresh-agent-browser-wire-observer.js'
import {
  freshAgentAssistantResponseDomFacts as assistantResponseDomFacts,
  freshAgentAssistantTextAppeared,
  freshAgentTurnCompletionStatus,
} from '../../../scripts/testing/fresh-agent-ordinary-turn.js'
import { test } from '../helpers/fixtures.js'
import { createManagedRuntimeBrowserRig, openFreshHistorySession, splitFreshBrowserPane, observeFreshMcpIngress, type ManagedRuntimeView, type ManagedFixtureRig } from '../helpers/managed-runtime.js'
import { observeOwnedFreshBrowserPane, stageOwnedFreshBrowserProfile } from '../../../scripts/testing/runtime-external-browser.js'
import { TestHarness } from '../helpers/test-harness.js'

type FreshAgentWireType = FreshAgentWireFrame['type']

function isWireFrameOfType<T extends FreshAgentWireType>(
  frame: FreshAgentWireFrame,
  type: T,
): frame is Extract<FreshAgentWireFrame, { type: T }> {
  return frame.type === type
}

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

async function sendBrowserNoToolTurn(page: Page, paneId: string, instruction: string, wire: FreshAgentWireObservations): Promise<void> {
  await wire.allowSendPrompt(instruction)
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

function ordinaryFreshAgentEventFacts(frames: readonly FreshAgentWireFrame[]) {
  const counts = { created: 0, createFailed: 0, assistant: 0, stream: 0, error: 0,
    snapshot: 0, changed: 0, turnComplete: 0, result: 0 }
  const turnOutcomes: Record<string, number> = {}
  const createFailureCodes = new Set<string>()
  const createFailureDiagnostics = new Set<string>()
  let errorCodePresent = false
  let errorMessagePresent = false
  for (const frame of frames) {
    if (frame?.type === 'freshAgent.created') counts.created++
    if (frame?.type === 'freshAgent.create.failed') {
      counts.createFailed++
      if (typeof frame.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(frame.code)) createFailureCodes.add(frame.code)
      if (typeof frame.startupDiagnostic === 'string') createFailureDiagnostics.add(frame.startupDiagnostic)
    }
    if (frame?.type !== 'freshAgent.event' || !frame.event || typeof frame.event !== 'object') continue
    const event = frame.event as Record<string, any>
    switch (event.type) {
      case 'freshAgent.assistant':
        counts.assistant++
        break
      case 'freshAgent.stream': counts.stream++; break
      case 'freshAgent.error':
        counts.error++
        errorCodePresent ||= event.codePresent === true
        errorMessagePresent ||= event.messagePresent === true
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
  return { counts, createFailureCodes: [...createFailureCodes].sort(),
    createFailureDiagnostics: [...createFailureDiagnostics].sort(), errorCodePresent, errorMessagePresent,
    turnOutcomes }
}

/**
 * A bounded failure-time view of the selected pane. This intentionally
 * projects only readiness booleans and fixed status enums; it never returns
 * session identifiers, errors, model settings, transcript text, or provider
 * output.
 */
function ordinaryFreshAgentReadinessFacts(input: { paneId: string; attachSessions: Array<{
  sessionId: string; sessionType?: string; provider?: string
}> }) {
  const { paneId, attachSessions } = input
  const harness = (window as any).__FRESHELL_TEST_HARNESS__
  const state = harness?.getState?.()
  const findPane = (node: any): any => node?.type === 'leaf'
    ? node.id === paneId ? node : null
    : node?.children?.map(findPane).find(Boolean) ?? null
  const pane = Object.values(state?.panes?.layouts ?? {}).map(findPane).find(Boolean) as any
  const content = pane?.content
  const sessionKey = content?.sessionId && content?.sessionType && content?.provider
    ? `${content.sessionType}:${content.provider}:${content.sessionId}`
    : undefined
  const session = sessionKey ? state?.freshAgent?.sessions?.[sessionKey] : undefined
  const paneRoot = Array.from(document.querySelectorAll<HTMLElement>('[data-pane-id]'))
    .find((element) => element.dataset.paneId === paneId)
  const composer = paneRoot?.querySelector<HTMLTextAreaElement>('[aria-label="Chat message input"]')
  const composerRect = composer?.getBoundingClientRect()
  const composerStyle = composer ? window.getComputedStyle(composer) : null
  const composerVisible = Boolean(composer && composerRect && composerRect.width > 0 && composerRect.height > 0
    && composerStyle?.display !== 'none' && composerStyle?.visibility !== 'hidden' && composerStyle?.opacity !== '0')
  const enumValue = (value: unknown, allowed: readonly string[]) => (
    typeof value === 'string' && allowed.includes(value) ? value : value == null ? 'missing' : 'other'
  )
  const recoveryState = content?.recoverySummary?.recoveryState
  const sessionStatus = session?.status ?? content?.status
  const paneSessionMatchesState = typeof content?.sessionId === 'string' && session?.sessionId === content.sessionId
  const matchingAttachCount = attachSessions.filter((attach) => attach.sessionId === content?.sessionId
    && attach.sessionType === content?.sessionType && attach.provider === content?.provider).length
  return {
    paneFound: Boolean(pane),
    paneStatus: enumValue(content?.status, ['idle', 'creating', 'starting', 'connected', 'running', 'busy', 'create-failed', 'exited', 'stuck']),
    paneSessionPresent: typeof content?.sessionId === 'string',
    sessionStatePresent: Boolean(session),
    paneSessionMatchesState,
    sessionStatus: enumValue(sessionStatus, ['creating', 'starting', 'connected', 'running', 'idle', 'compacting', 'exited', 'stuck', 'create-failed']),
    sessionEnded: sessionStatus === 'exited' || sessionStatus === 'create-failed',
    sessionLost: session?.lost === true,
    sessionHistoryLoaded: typeof session?.historyLoaded === 'boolean' ? session.historyLoaded : null,
    sessionHasLatestTurn: session?.latestTurnId !== undefined && session?.latestTurnId !== null,
    sessionRestoreFailurePresent: Boolean(session?.restoreFailureCode || session?.restoreFailureMessage),
    recoveryState: enumValue(recoveryState, ['live', 'recovering', 'blocked', 'lost', 'stopped', 'data_repair_complete']),
    recoveryDesiredState: enumValue(content?.recoverySummary?.desiredState, ['running', 'stopped']),
    attachCount: matchingAttachCount,
    attachTargetsPaneSession: matchingAttachCount > 0,
    composerPresent: Boolean(composer),
    composerDisabled: composer ? composer.disabled : null,
    composerVisible,
    composerFocused: Boolean(composer && document.activeElement === composer),
    composerHasInput: Boolean(composer?.value.trim()),
    connectionStatus: enumValue(state?.connection?.status, ['disconnected', 'connecting', 'connected', 'ready']),
    networkEffectsSuppressed: harness?.isAllFreshAgentNetworkEffectsSuppressed?.() === true
      || harness?.isFreshAgentNetworkEffectsSuppressed?.(paneId) === true,
  }
}

async function paneFor(page: Page, observation: Parameters<typeof observeOwnedFreshBrowserPane>[0]) {
  return waitFor('actual fresh pane', () => page.evaluate(observeOwnedFreshBrowserPane, observation))
}

async function actualCreate(page: Page, rig: ManagedFixtureRig, definition: Definition, wire: FreshAgentWireObservations, splitPaneId?: string) {
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
    const requestCandidate = await waitFor('actual UI fresh create request', () => wire.sent.slice(cursor).find((frame): frame is Extract<FreshAgentWireFrame, { type: 'freshAgent.create' }> => (
      isWireFrameOfType(frame, 'freshAgent.create') && frame.sessionType === definition.mode
    )) ?? null)
    if (typeof requestCandidate.requestId !== 'string') throw new Error('fresh-agent create request has no string request ID')
    const request = { ...requestCandidate, requestId: requestCandidate.requestId }
    expect(request.requestId).toBe(staged.createRequestId)
    const reply = await waitFor('actual UI fresh create result', () => {
      const failed = wire.received.find((frame): frame is Extract<FreshAgentWireFrame, { type: 'freshAgent.create.failed' }> => (
        isWireFrameOfType(frame, 'freshAgent.create.failed') && frame.requestId === request.requestId
      ))
      if (failed) throw new Error(`fresh-agent create failed (${failed.code ?? 'UNKNOWN'})`)
      return wire.received.find((frame): frame is Extract<FreshAgentWireFrame, { type: 'freshAgent.created' }> => (
        isWireFrameOfType(frame, 'freshAgent.created') && frame.requestId === request.requestId
      )) ?? null
    })
    if (reply.requestId !== request.requestId) throw new Error('fresh-agent create reply request ID differs')
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

async function qualify(page: Page, rig: ManagedFixtureRig, definition: Definition, wire: FreshAgentWireObservations): Promise<FreshAgentQualificationRow> {
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
  await sendBrowserNoToolTurn(page, auxiliary.paneId, ui.prompt!, wire)
  const sentPane = await paneFor(page, auxiliary.paneObservation)
  const send = await waitFor('browser composer send', () => wire.sent.slice(sendCursor).find((frame): frame is Extract<FreshAgentWireFrame, { type: 'freshAgent.send' }> => (
    isWireFrameOfType(frame, 'freshAgent.send') && frame.sessionId === sentPane.sessionId
  )) ?? null)
  const accepted = await waitFor('browser composer accepted', () => wire.received.find((frame): frame is Extract<FreshAgentWireFrame, { type: 'freshAgent.send.accepted' }> => (
    isWireFrameOfType(frame, 'freshAgent.send.accepted') && frame.requestId === send.requestId
  )) ?? null)
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
  const historyRequest = await waitFor('actual history resume route', () => wire.sent.slice(historyCursor).find((frame): frame is (
    Extract<FreshAgentWireFrame, { type: 'freshAgent.create' }> | Extract<FreshAgentWireFrame, { type: 'freshAgent.attach' }>
  ) => (
    isWireFrameOfType(frame, 'freshAgent.create') && frame.sessionRef?.sessionId === main.nativeSessionId
  ) || (
    isWireFrameOfType(frame, 'freshAgent.attach') && frame.sessionId === historyPane.sessionId
  )) ?? null)
  const historyReply = historyRequest.type === 'freshAgent.create' ? await waitFor('actual history create reply',
    () => wire.received.find((frame): frame is Extract<FreshAgentWireFrame, { type: 'freshAgent.created' }> => (
      isWireFrameOfType(frame, 'freshAgent.created') && frame.requestId === historyRequest.requestId
    )) ?? null) : undefined
  await rig.observeFreshBrowserIngress(rig.exactRuntimeHandle(main), id, { ingress: 'history-resume', request: historyRequest, ...(historyReply ? { reply: historyReply } : {}) })

  const attachCursor = wire.sent.length
  await rig.crashAndRestartWeb()
  await reloadOwnedBrowser(page, rig)
  const reconnectedPane = await paneFor(page, initial.paneObservation)
  const attach = await waitFor('actual reconnect attach', () => wire.sent.slice(attachCursor).find(frame => (
    isWireFrameOfType(frame, 'freshAgent.attach') && frame.sessionId === reconnectedPane.sessionId
  )) ?? null)
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
      if (!challenge.prompt) throw new Error('approval challenge has no controlled prompt')
      await wire.allowSendPrompt(challenge.prompt)
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
      const decision = await waitFor('actual current browser approval response', () => wire.sent.slice(decisionCursor).find(frame => (
        isWireFrameOfType(frame, 'freshAgent.approval.respond') && String(frame.requestId) === current.decisionId
      )) ?? null)
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
    const wire = await observeFreshAgentBrowserWire(page)
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
    await withOwnedCleanup(async () => {
      const wire = await observeFreshAgentBrowserWire(page)
      const info = await rig.start()
      process.env.FRESHELL_URL = info.baseUrl
      process.env.FRESHELL_TOKEN = info.token
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      await new TestHarness(page).waitForConnection()

      for (const definition of definitions) {
        const createReceivedCursor = wire.received.length
        const createSentCursor = wire.sent.length
        let turnReceivedCursor = createReceivedCursor
        let paneId: string | undefined
        const progress = {
          stage: 'creating',
          createCompleted: false,
          composerFilled: false,
          assistantBaselineCaptured: false,
          composerSubmitted: false,
          sendObserved: false,
          turnCompleteObserved: false,
          assistantTextDisplayed: false,
        }
        try {
          const created = await actualCreate(page, rig, definition, wire)
          paneId = created.paneId
          progress.createCompleted = true
          progress.stage = 'pane_created'
          const allocationSessionIds = new Set([
            created.reply.sessionId,
            created.sessionId,
            created.view.nativeSessionId,
          ])
          const composer = page.locator(`[data-pane-id="${created.paneId}"]`)
            .getByRole('textbox', { name: 'Chat message input' })
          progress.stage = 'waiting_for_composer'
          await expect(composer).toBeEnabled({ timeout: 60_000 })
          progress.stage = 'filling_composer'
          await composer.fill('Without using tools, briefly confirm you are ready.')
          progress.composerFilled = true
          const assistantTextBaseline = await assistantResponseDomFacts(page, created.paneId)
          progress.assistantBaselineCaptured = true
          turnReceivedCursor = wire.received.length
          const sendCursor = wire.sent.length
          progress.stage = 'pressing_enter'
          await composer.press('Enter')
          progress.composerSubmitted = true
          progress.stage = 'waiting_for_send_frame'
          const sent = await waitFor('actual fresh-agent composer send', () => wire.sent
            .slice(sendCursor)
            .find((frame): frame is Extract<FreshAgentWireFrame, { type: 'freshAgent.send' }> => (
              isWireFrameOfType(frame, 'freshAgent.send')
            )) ?? null)
          progress.sendObserved = true
          if (!allocationSessionIds.has(sent.sessionId)) {
            throw new Error('fresh-agent send was not associated with the selected allocation')
          }
          await waitFor(`${definition.mode} completed answer`, async () => {
            const turnFrames = wire.received.slice(turnReceivedCursor).filter((frame): frame is Extract<FreshAgentWireFrame, { type: 'freshAgent.event' }> => (
              isWireFrameOfType(frame, 'freshAgent.event') && frame.sessionId === sent.sessionId
            ))
            if (turnFrames.some((frame) => frame.event?.type === 'freshAgent.error')) {
              throw new Error('fresh-agent turn emitted a correlated provider error')
            }
            const completionStatus = freshAgentTurnCompletionStatus(turnFrames, definition.provider)
            if (completionStatus === 'failed') {
              throw new Error('fresh-agent turn completed with an unsuccessful provider outcome')
            }
            const completed = completionStatus === 'completed'
            if (completed) {
              progress.turnCompleteObserved = true
            }
            const currentAssistantText = await assistantResponseDomFacts(page, created.paneId)
            const assistantTextDisplayed = freshAgentAssistantTextAppeared(assistantTextBaseline, currentAssistantText)
            if (assistantTextDisplayed) progress.assistantTextDisplayed = true
            return completed && assistantTextDisplayed ? true : null
          }, 240_000)
          progress.stage = 'completed'
          console.info(JSON.stringify({ severity: 'info', event: 'durable_souls.ordinary_turn_completed',
            lane: 'fresh-agent', mode: definition.mode }))
        } catch (error) {
          let assistantDom = { available: false, rows: 0, textCharacters: 0 }
          if (paneId) {
            try {
              assistantDom = { available: true, ...await assistantResponseDomFacts(page, paneId) }
            } catch { /* preserve the ordinary-turn failure */ }
          }
          let readiness = null
          if (paneId) {
            const attachSessions = wire.sent.slice(createSentCursor)
              .filter((frame): frame is Extract<FreshAgentWireFrame, { type: 'freshAgent.attach' }> => (
                isWireFrameOfType(frame, 'freshAgent.attach')
              ))
              .map((frame) => ({ sessionId: frame.sessionId as string, sessionType: frame.sessionType, provider: frame.provider }))
            try { readiness = await page.evaluate(ordinaryFreshAgentReadinessFacts, { paneId, attachSessions }) } catch { /* preserve the ordinary-turn failure */ }
          }
          console.error(JSON.stringify({ severity: 'error', event: 'durable_souls.ordinary_turn_failed',
            lane: 'fresh-agent', mode: definition.mode,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            providerEvents: ordinaryFreshAgentEventFacts(wire.received.slice(createReceivedCursor)), assistantDom, readiness,
            ...progress }))
          throw error
        }
      }
    }, async () => {
      const cleanup = await rig.stop()
      if (!cleanup.ok) throw new Error(cleanup.errors.join('\n') || 'Owned runtime cleanup failed')
    })
  })
})
