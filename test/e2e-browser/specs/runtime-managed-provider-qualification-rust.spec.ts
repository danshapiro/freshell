/**
 * Opt-in live qualification for every managed terminal provider.
 *
 * The checked-in capability flags intentionally remain unchanged. Until a
 * provider is enabled on main, this spec is a dormant release surface: it is
 * listed by Playwright but runs only when the explicit live environment flag
 * is set. Once enabled, every row must traverse the real picker, real pinned
 * provider binary, and both destructive recovery paths. There are no fakes,
 * conditional assertions, or provider-specific skips below.
 */
import fs from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'

import { expect, type Page, type Browser } from '@playwright/test'

import { providerNativeProfileMatches, type ProviderQualificationRow } from '../../../scripts/testing/provider-qualification-receipt.js'
import { withOwnedCleanup } from '../../../scripts/testing/owned-cleanup.js'
import { requireAmplifierOnecliBootstrap } from '../../../scripts/testing/runtime-amplifier-onecli.js'
import {
  QUALIFICATION_PROVIDER_SELECTION_ENV,
  parseQualificationProviderSelection,
} from '../../../scripts/testing/provider-qualification-selection.js'
import { test, createFreshE2ePage } from '../helpers/fixtures.js'
import { ExternalServer } from '../helpers/external-target.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { installRecoveryOfferAutoDeclineOnContext } from '../helpers/recovery-offer.js'
import { RuntimeHarness, type AdminReply, type ManagedTerminalStartupFacts } from '../../../scripts/testing/runtime-sandbox.js'
import {
  runTask2RetainedFixture,
  type Task2RetainedBrowserContext,
  type Task2RetainedBrowserPhase,
} from '../../../scripts/testing/task002-config-legacy-fixtures.js'
import { ExternalManagedRuntimeRig, resolveManagedExternalDescriptor } from '../../../scripts/testing/runtime-external-browser.js'
import { projectManagedViewProbe } from '../../../scripts/testing/managed-view-probe.js'
import { projectPaneCreationProbe } from '../../../scripts/testing/pane-creation-probe.js'
import { task2RetainedPublicContext, type Task2RetainedPublicContext } from '../../../scripts/testing/task002-retained-fixture.js'
import { managedRecoveryBlockedMessage } from '../../../src/lib/managed-runtime-recovery-message.js'
import {
  createManagedRuntimeBrowserRig, completeManagedRuntimeStop, type ManagedFixtureRig,
  P2_OPENCODE_MODEL,
  P2_OPENCODE_VERSION,
  type ManagedRuntimeView,
} from '../helpers/managed-runtime.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import { TestHarness } from '../helpers/test-harness.js'
import { providerStageResponse, sampleProviderResponseBrowser, sequenceProviderResponse, waitForValue } from '../helpers/provider-response-sequencing.js'
import {
  buildTerminalOrdinaryTurnBrowserScript,
  TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL,
  waitForTerminalOrdinaryTurnBaseline,
  waitForTerminalOrdinaryTurn,
  terminalOrdinaryTurnRequest,
  type TerminalOrdinaryTurnBaseline,
  type TerminalOrdinaryTurnBrowserObservation,
  type TerminalOrdinaryTurnProvider,
} from '../../../scripts/testing/terminal-ordinary-turn.js'

const LIVE_ENV = 'FRESHELL_RUNTIME_MANAGED_PROVIDER_QUALIFICATION_LIVE'
const AMPLIFIER_MODEL = 'glm-5.3'
const AMPLIFIER_EFFORT = 'provider-default'
type OrdinaryTerminalSetupFailureStage = 'provider_definitions' | 'runtime_construction' | 'runtime_start'
  | 'browser_script' | 'page_navigation' | 'harness_ready' | 'connection_ready' | 'active_tab'

type ProviderDefinition = {
  provider: 'claude' | 'codex' | 'opencode' | 'amplifier'
  pickerName: RegExp
  directoryName: RegExp
  providerVersion: string
  model: string
  reasoningEffort: string
  versionCommand: string[]
  versionPattern: RegExp
  processBinary: string
  processIdentityNeedles: string[]
  nativeIdPattern: RegExp
}

type ProviderPaneSetupStage =
  | 'existing_panes'
  | 'picker_open'
  | 'provider_selection'
  | 'directory_dialog'
  | 'pane_creation'
  | 'terminal_visible'
  | 'managed_runtime_view'
  | 'ready'

function providerDefinitions(): ProviderDefinition[] {
  const rawSelection = process.env[QUALIFICATION_PROVIDER_SELECTION_ENV]?.trim()
  if (!rawSelection) {
    throw new Error(
      `${QUALIFICATION_PROVIDER_SELECTION_ENV} must explicitly select each live provider to qualify`,
    )
  }
  const selected = parseQualificationProviderSelection(rawSelection)
  const definitions: ProviderDefinition[] = [
    {
      provider: 'claude',
      pickerName: /^Claude CLI$/i,
      directoryName: /Starting directory for Claude/i,
      providerVersion: '2.1.263',
      model: 'haiku',
      reasoningEffort: 'low',
      versionCommand: ['claude', '--version'],
      versionPattern: /2\.1\.263/,
      processBinary: 'claude',
      processIdentityNeedles: ['haiku', 'low'],
      nativeIdPattern: /^[0-9a-f]{8}-[0-9a-f-]{27}$/i,
    },
    {
      provider: 'codex',
      pickerName: /^Codex CLI$/i,
      directoryName: /Starting directory for Codex CLI/i,
      providerVersion: '0.147.0',
      model: 'gpt-5.6-luna',
      reasoningEffort: 'low',
      versionCommand: ['codex', '--version'],
      versionPattern: /0\.147\.0/,
      processBinary: 'codex',
      processIdentityNeedles: ['gpt-5.6-luna', 'low'],
      nativeIdPattern: /^[0-9a-f]{8}-[0-9a-f-]{27}$/i,
    },
    {
      provider: 'opencode',
      pickerName: /^OpenCode$/i,
      directoryName: /Starting directory for OpenCode/i,
      providerVersion: P2_OPENCODE_VERSION,
      model: P2_OPENCODE_MODEL,
      reasoningEffort: 'provider-default',
      versionCommand: ['opencode', '--version'],
      versionPattern: new RegExp(`^${P2_OPENCODE_VERSION.replaceAll('.', '\\.')}\\s*$`),
      processBinary: 'opencode',
      processIdentityNeedles: [P2_OPENCODE_MODEL],
      nativeIdPattern: /^ses_/,
    },
  ]
  if (selected.includes('amplifier')) {
    if (!resolveManagedExternalDescriptor(process.env)) requireAmplifierOnecliBootstrap()
    definitions.push({
      provider: 'amplifier',
      pickerName: /^Amplifier$/i,
      directoryName: /Starting directory for Amplifier/i,
      providerVersion: '0.1.1',
      model: AMPLIFIER_MODEL,
      reasoningEffort: AMPLIFIER_EFFORT,
      versionCommand: [
        '/opt/amplifier-src/.venv/bin/python',
        '-c',
        'import importlib.metadata as m; print(m.version("amplifier-app-cli"))',
      ],
      versionPattern: /^0\.1\.1\s*$/,
      processBinary: 'amplifier',
      // Amplifier's resume command has no model/effort flags. Native
      // session:config evidence below is the provider-effective authority.
      processIdentityNeedles: [],
      nativeIdPattern: /^[A-Za-z0-9][A-Za-z0-9._-]+$/,
    })
  }
  const byProvider = new Map(definitions.map((definition) => [definition.provider, definition]))
  return selected.map((provider) => {
    const definition = byProvider.get(provider)
    if (!definition) throw new Error(`no qualification definition for ${provider}`)
    return definition
  })
}

function leavesByMode(node: any, mode: string): any[] {
  if (!node) return []
  if (node.type === 'leaf') return node.content?.mode === mode ? [node] : []
  return node.type === 'split'
    ? (node.children ?? []).flatMap((child: any) => leavesByMode(child, mode))
    : []
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function executeAndAwaitNonceOutput(
  page: Page,
  paneId: string,
  terminalId: string,
  provider: ProviderDefinition['provider'],
  nonce: string,
  stage: 'initial' | 'after_host' | 'after_provider',
  priorStreamId?: string,
  nativeSessionId?: string,
  timeoutMs = 240_000,
  requireSettledOutput = true,
): Promise<string> {
  const response = providerStageResponse(nonce, stage, randomBytes(8).toString('hex'), stage === 'initial')
  const terminal = page.locator(`[data-pane-id="${paneId}"] .xterm:visible`).last()
  let diagnostics: unknown = null
  return sequenceProviderResponse({
    provider, paneId, terminalId, response, priorStreamId, nativeSessionId, timeoutMs,
    requireSettledOutput,
    waitFor: waitForValue,
    read: async () => {
      const sampled = await page.evaluate(sampleProviderResponseBrowser, { id: terminalId, nonce, expected: response.expected })
      diagnostics = sampled.diagnostics
      return sampled.snapshot
    },
    prepare: async command => {
      await terminal.waitFor({ state: 'visible', timeout: 90_000 })
      await terminal.click()
      await page.keyboard.insertText(command)
    },
    submit: () => page.keyboard.press('Enter'),
    report: (phase, snapshot) => {
      const surface = snapshot && (({ text: _text, ...metadata }) => metadata)(snapshot)
      // Cloud stdout already survives owner cleanup. Keep one bounded, body-free
      // record at each boundary; neither record certifies native completion.
      console.log(JSON.stringify({ severity: phase === 'pre_send' ? 'info' : 'error',
        event: 'provider_browser.response_sequence', stage, phase, paneId, terminalId, surface, diagnostics }))
    },
  })
}

class OrdinaryTerminalTurnError extends Error {
  constructor(readonly stage: 'attach_ready' | 'turn_completion', readonly facts: TerminalOrdinaryTurnBrowserObservation | null, cause?: unknown) {
    super('ordinary terminal turn did not show a fresh rendered answer and completion for its native conversation', { cause })
    this.name = 'OrdinaryTerminalTurnError'
  }
}

async function executeAndAwaitOrdinaryTurn(
  page: Page,
  paneId: string,
  terminalId: string,
  provider: TerminalOrdinaryTurnProvider,
  nativeSessionId: string | undefined,
): Promise<TerminalOrdinaryTurnBrowserObservation> {
  if (!nativeSessionId) throw new OrdinaryTerminalTurnError('attach_ready', null, new Error('allocated native conversation is absent'))
  const terminal = page.locator(`[data-pane-id="${paneId}"] .xterm:visible`).last()
  await terminal.waitFor({ state: 'visible', timeout: 90_000 })
  await terminal.click()
  const { input: requestText, expectedAnswer } = terminalOrdinaryTurnRequest(`FRESHELL${randomBytes(8).toString('hex')}`)

  const baseline = await waitForTerminalOrdinaryTurnBaseline(() => page.evaluate(({ globalName, providerName, id, nativeId, answer }) => {
    const observer = (window as any)[globalName]
    return observer?.prepareBeforeSend(providerName, id, nativeId, answer) ?? null
  }, { globalName: TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL, providerName: provider, id: terminalId,
    nativeId: nativeSessionId, answer: expectedAnswer }) as Promise<TerminalOrdinaryTurnBaseline | null>)
  if (!baseline) throw new OrdinaryTerminalTurnError('attach_ready', null)
  await page.keyboard.insertText(requestText)

  await page.keyboard.press('Enter')
  let latestFacts: TerminalOrdinaryTurnBrowserObservation | null = null
  try {
    return await waitForTerminalOrdinaryTurn(async () => {
      latestFacts = await page.evaluate(({ globalName, currentBaseline, expectedInput }) => {
        const observer = (window as any)[globalName]
        return observer?.observeAfterSend(currentBaseline, expectedInput) ?? null
      }, { globalName: TERMINAL_ORDINARY_TURN_BROWSER_GLOBAL, currentBaseline: baseline, expectedInput: requestText }) as TerminalOrdinaryTurnBrowserObservation | null
      return latestFacts
    }, 240_000)
  } catch (error) {
    throw new OrdinaryTerminalTurnError('turn_completion', latestFacts, error)
  }
}

async function paneNativeId(
  harness: TestHarness,
  tabId: string,
  paneId: string,
  provider: string,
): Promise<string | null> {
  const content = leavesByMode(await harness.getPaneLayout(tabId), provider)
    .find((leaf) => leaf.id === paneId)?.content
  return typeof content?.sessionRef?.sessionId === 'string' ? content.sessionRef.sessionId : null
}

async function reportPaneCreationProbe(
  harness: TestHarness,
  rig: ManagedFixtureRig,
  target: { terminalId: string | null; createRequestId: string | null },
): Promise<void> {
  const [sentMessages, receivedMessages] = await Promise.all([
    harness.getSentWsMessages(), harness.getReceivedWsMessages(),
  ])
  let inventoryRead: 'ok' | 'failed' = 'failed'
  let inventory: unknown
  try {
    inventory = await rig.inventory()
    inventoryRead = 'ok'
  } catch { /* retain the request/reply observation when owner inventory is unavailable */ }
  const probe = projectPaneCreationProbe({ ...target, provider: 'codex',
    sentMessages, receivedMessages, inventoryRead, inventory })
  console.error(JSON.stringify({ severity: 'error', event: 'durable_souls.pane_creation_probe',
    lane: 'terminal', provider: 'codex', probe }))
}

async function createProviderPane(
  page: Page,
  harness: TestHarness,
  rig: ManagedFixtureRig,
  tabId: string,
  definition: ProviderDefinition,
  onStage?: (stage: ProviderPaneSetupStage) => void,
  onPaneCreationTimeout?: (target: { terminalId: string | null; createRequestId: string | null }) => Promise<void>,
  onManagedViewTimeout?: (target: { terminalId: string; createRequestId: string }) => Promise<void>,
): Promise<{ paneId: string; terminalId: string; view: ManagedRuntimeView }> {
  onStage?.('existing_panes')
  const priorPaneIds = new Set(
    leavesByMode(await harness.getPaneLayout(tabId), definition.provider).map((leaf) => leaf.id),
  )
  onStage?.('picker_open')
  const picker = await openPanePicker(page)
  onStage?.('provider_selection')
  await picker.getByRole('button', { name: definition.pickerName }).click({ force: true })
  onStage?.('directory_dialog')
  const directory = page.getByRole('combobox', { name: definition.directoryName })
  await expect(directory).toBeVisible({ timeout: 15_000 })
  await directory.fill(rig.repoRoot)
  await directory.press('Enter')

  onStage?.('pane_creation')
  let leaf: any
  try {
    leaf = await waitForValue(`${definition.provider} picker-created pane`, async () => (
      leavesByMode(await harness.getPaneLayout(tabId), definition.provider)
        .find((candidate) => !priorPaneIds.has(candidate.id) && candidate.content?.terminalId)
    ), 120_000)
  } catch (error) {
    if (onPaneCreationTimeout) {
      try {
        const pendingPane = leavesByMode(await harness.getPaneLayout(tabId), definition.provider)
          .find((candidate) => !priorPaneIds.has(candidate.id))
        await onPaneCreationTimeout({
          terminalId: typeof pendingPane?.content?.terminalId === 'string' && pendingPane.content.terminalId
            ? pendingPane.content.terminalId : null,
          createRequestId: typeof pendingPane?.content?.createRequestId === 'string' && pendingPane.content.createRequestId
            ? pendingPane.content.createRequestId : null,
        })
      } catch { /* diagnostic failures must preserve the pane-creation timeout */ }
    }
    throw error
  }
  onStage?.('terminal_visible')
  await page.locator(`[data-pane-id="${leaf.id}"] .xterm:visible`)
    .waitFor({ state: 'visible', timeout: 120_000 })
  onStage?.('managed_runtime_view')
  const terminalId = leaf.content.terminalId as string
  let view: ManagedRuntimeView
  try {
    view = await waitForValue(`${definition.provider} managed runtime view`, async () => {
      const candidate = await rig.runningViewForTerminal(terminalId)
      return candidate?.containerId ? candidate : null
    }, 120_000)
  } catch (error) {
    try {
      await onManagedViewTimeout?.({ terminalId,
        createRequestId: typeof leaf.content.createRequestId === 'string' ? leaf.content.createRequestId : '' })
    } catch { /* diagnostic failures must preserve the managed-view timeout */ }
    throw error
  }
  onStage?.('ready')
  return { paneId: leaf.id, terminalId, view }
}

function limitEvidence(view: ManagedRuntimeView, actual: ManagedTerminalStartupFacts['limits']): ProviderQualificationRow['limitEvidence'] {
  if (!view.containerId) throw new Error('managed runtime has no container for limit evidence')
  const expected = view.effectiveLimits
  if (!expected) throw new Error('managed runtime has no effective limits')
  expect(actual.cpuMax).toBe(`${expected.cpuMilli * 100} 100000`)
  expect(actual.memoryMax).toBe(String(expected.memoryBytes))
  expect(actual.swapMax).toBe(String(expected.swapBytes))
  expect(actual.pidsMax).toBe(String(expected.pidsMax))
  return actual
}

async function waitForReplacement(
  rig: ManagedFixtureRig,
  terminalId: string,
  priorIncarnationId: string,
): Promise<ManagedRuntimeView> {
  return waitForValue('replacement managed runtime', async () => {
    const view = await rig.runningViewForTerminal(terminalId)
    return view?.containerId && view.incarnationId !== priorIncarnationId ? view : null
  }, 300_000)
}

async function qualifyProvider(
  page: Page,
  harness: TestHarness,
  rig: ManagedFixtureRig,
  tabId: string,
  definition: ProviderDefinition,
): Promise<ProviderQualificationRow> {
  const created = await createProviderPane(page, harness, rig, tabId, definition)
  if (!created.view.containerId) throw new Error(`${definition.provider} view has no owned container`)

  const startup = await rig.managedTerminalStartupFacts(rig.runtimeEnclosureHandle(created.view))
  expect(startup.provider).toBe(definition.processBinary)
  expect(definition.versionPattern.test(startup.version)).toBe(true)
  expect(startup.providerProcessPresent).toBe(true)
  for (const identity of definition.processIdentityNeedles) {
    expect(startup.processIdentities).toContain(identity)
  }
  if (definition.reasoningEffort === 'provider-default') {
    expect(startup.reasoningFlagsAbsent).toBe(true)
  }
  const exactLimits = limitEvidence(created.view, startup.limits)
  expect(exactLimits.swapMax).toBe('0')

  const nonce = `codename-${randomBytes(16).toString('hex')}`
  const initialStreamId = await executeAndAwaitNonceOutput(
    page, created.paneId, created.terminalId, definition.provider, nonce, 'initial',
  )
  const nativeSessionId = await waitForValue('exact native session id', async () => (
    await paneNativeId(harness, tabId, created.paneId, definition.provider)
  ), 180_000)
  expect(nativeSessionId).toMatch(definition.nativeIdPattern)
  const initialCurrent = await waitForValue('inventory native session id', async () => {
    const current = await rig.runningViewForTerminal(created.terminalId)
    return current?.nativeSessionId ? current : null
  }, 120_000)
  expect(initialCurrent).toMatchObject({ nativeSessionId, soulId: created.view.soulId,
    containerId: created.view.containerId, incarnationId: created.view.incarnationId, hostBootId: created.view.hostBootId })
  const initialEnclosure = rig.runtimeEnclosureHandle(initialCurrent)
  await rig.crashRuntimeHost(rig.exactRuntimeHandle(initialCurrent))
  const afterHostLoss = await waitForReplacement(rig, created.terminalId, created.view.incarnationId)
  expect(afterHostLoss.soulId).toBe(created.view.soulId)
  expect(afterHostLoss.nativeSessionId).toBe(nativeSessionId)
  expect((await rig.ownedContainerState(initialEnclosure)).running).toBe(false)

  const hostStreamId = await executeAndAwaitNonceOutput(
    page, created.paneId, created.terminalId, definition.provider, nonce, 'after_host', initialStreamId, nativeSessionId,
  )

  if (!afterHostLoss.containerId) throw new Error('host-loss replacement has no owned container')
  const workerHandle = rig.exactRuntimeHandle(afterHostLoss)
  const hostLossEnclosure = rig.runtimeEnclosureHandle(afterHostLoss)
  const pid = (await rig.chaosHostFacts(workerHandle)).workerPid
  expect(pid).toBeGreaterThan(1)
  await rig.crashProviderWorker(workerHandle)
  const afterProviderLoss = await waitForReplacement(rig, created.terminalId, afterHostLoss.incarnationId)
  expect(afterProviderLoss.soulId).toBe(created.view.soulId)
  expect(afterProviderLoss.nativeSessionId).toBe(nativeSessionId)
  expect(afterProviderLoss.profile).toBe(created.view.profile)
  expect((await rig.ownedContainerState(hostLossEnclosure)).running).toBe(false)

  await executeAndAwaitNonceOutput(
    page, created.paneId, created.terminalId, definition.provider, nonce, 'after_provider', hostStreamId, nativeSessionId,
  )

  const snapshot = await rig.inventorySnapshot()
  const runningWriters = snapshot.souls.filter((row: any) => (
    row.soulId === created.view.soulId && row.launchState === 'running'
  ))
  expect(runningWriters).toHaveLength(1)
  const writerHandle = rig.exactRuntimeHandle(afterProviderLoss)
  const writerClaim = await rig.writerClaimFacts(writerHandle)
  expect(writerClaim.provider).toBe(definition.provider)
  expect(writerClaim.activeClaimCount).toBe(1)
  expect(writerClaim.globalConflictingClaimCount).toBe(0)
  const lostNoticeCount = await rig.managedProviderPendingNoticeCount(writerHandle)
  expect(lostNoticeCount).toBe(0)
  const { initial: initialStop, completion: stopped } = await completeManagedRuntimeStop(rig, created.view.soulId)
  console.info(JSON.stringify({ severity: 'info', event: 'provider_qualification.stop_completed',
    soulId: stopped.soulId, intentRevision: stopped.intentRevision, executionGeneration: stopped.executionGeneration,
    initialOutcome: initialStop.outcome, outcome: stopped.outcome }))
  expect(stopped.outcome).toBe('verified_empty')
  if (stopped.outcome !== 'verified_empty') throw new Error('provider qualification Stop did not verify empty')
  const claimAfterStop = await rig.writerClaimFacts(writerHandle)
  expect(claimAfterStop.activeClaimCount).toBe(0)
  expect(claimAfterStop.globalConflictingClaimCount).toBe(0)
  const oldContainerRunningAfterStop = (await rig.ownedContainerState(rig.runtimeEnclosureHandle(afterProviderLoss))).running
  expect(oldContainerRunningAfterStop).toBe(false)
  expect((await rig.ownershipFacts()).unsafeBrokerAttempts).toBe(0)
  const nativeTurnProofs = await rig.managedTerminalStoppedProofs(writerHandle, nonce)
  if (definition.provider === 'amplifier') {
    const evidence = nativeTurnProofs.map((proof) => proof.nativeEvidence)
    expect(evidence.every((value) => value.kind === 'append_only_record')).toBe(true)
    expect(new Set(evidence.map((value) => value.kind === 'append_only_record' ? value.recordSha256 : '')).size).toBe(3)
  } else {
    const evidence = nativeTurnProofs.map((proof) => proof.nativeEvidence)
    expect(evidence.every((value) => value.kind === 'identified_message')).toBe(true)
    expect(new Set(evidence.map((value) => value.kind === 'identified_message' ? value.messageId : '')).size).toBe(3)
    expect(new Set(evidence.map((value) => value.kind === 'identified_message' ? value.turnId : '')).size).toBe(3)
  }
  expect(nativeTurnProofs.every((proof) => proof.toolCallCount === 0)).toBe(true)

  return {
    provider: definition.provider,
    modes: [definition.provider],
    providerVersion: definition.providerVersion,
    model: definition.model,
    reasoningEffort: definition.reasoningEffort,
    nativeSessionId,
    nonceSha256: createHash('sha256').update(nonce).digest('hex'),
    nativeTurnProofs,
    actualProviderBinary: true,
    completedTurn: true,
    nativeStateCaptured: true,
    runtimeOwned: true,
    limitsVerified: true,
    swapMaxVerified: exactLimits.swapMax === '0',
    limitEvidence: exactLimits,
    automaticResume: true,
    profileVerified: nativeTurnProofs.every((proof) => providerNativeProfileMatches(definition, proof)),
    releaseBinary: (await rig.ownershipFacts()).supervisorBinaryKind === 'release',
    nativeRecovery: true,
    exactNativeRecovery: afterHostLoss.nativeSessionId === nativeSessionId
      && afterProviderLoss.nativeSessionId === nativeSessionId,
    sameNativeSession: afterProviderLoss.nativeSessionId === nativeSessionId,
    followUpCompleted: true,
    onlyOneWriter: runningWriters.length === 1,
    writerClaim,
    oldEnclosureVerifiedEmpty: !(await rig.ownedContainerState(initialEnclosure)).running
      && !(await rig.ownedContainerState(hostLossEnclosure)).running,
    verifiedEmptyOrdering: {
      stopOutcome: stopped.outcome,
      activeClaimCountAfterStop: claimAfterStop.activeClaimCount,
      globalConflictingClaimCountAfterStop: claimAfterStop.globalConflictingClaimCount,
      oldContainerRunningAfterStop,
    },
    lostNoticeCount,
    crashKinds: ['session_host', 'provider_process'],
    nonceRecovery: {
      sameSoul: afterHostLoss.soulId === created.view.soulId,
      sameNativeSession: afterHostLoss.nativeSessionId === nativeSessionId,
      newIncarnation: afterHostLoss.incarnationId !== created.view.incarnationId,
      oldEnclosureVerifiedEmpty: !(await rig.ownedContainerState(initialEnclosure)).running,
      recalledNonce: true,
      followUpCompleted: true,
      workspaceOrToolReadUsed: nativeTurnProofs.some((proof) => proof.toolCallCount > 0),
    },
    repairedSameSoul: afterProviderLoss.soulId === created.view.soulId,
    repairedSameNativeSession: afterProviderLoss.nativeSessionId === nativeSessionId,
  }
}

test.describe.serial('selectable managed-provider qualification', () => {
  test('each explicitly selected provider produces an independent evidence-bound live row', async ({ page }) => {
    test.skip(
      process.env[LIVE_ENV] !== '1',
      `set ${LIVE_ENV}=1 only for a live candidate-bound managed-provider campaign`,
    )
    test.setTimeout(3_600_000)
    const definitions = providerDefinitions()
    const rig = createManagedRuntimeBrowserRig(
      process.cwd(),
      5,
      {},
      { FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '750' },
      'release',
      {
        enabledProviders: definitions.map((definition) => definition.provider),
        providerSettings: Object.fromEntries(definitions.map((definition) => [
          definition.provider,
          { model: definition.model, effort: definition.reasoningEffort },
        ])),
      },
    )
    const providers: ProviderQualificationRow[] = []
    try {
      const info = await rig.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      const tabId = await harness.getActiveTabId()
      if (!tabId) throw new Error('managed-provider qualification has no active tab')
      for (const definition of definitions) {
        providers.push(await qualifyProvider(page, harness, rig, tabId, definition))
      }
      expect(providers.map((row) => row.provider)).toEqual(
        definitions.map((definition) => definition.provider),
      )
    } finally {
      const cleanup = await rig.stop()
      expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
    }
    const finalized = await rig.publishProviderQualification(providers)
    expect(finalized.schemaVersion).toBe(2)
    expect(finalized.rowCount).toBe(definitions.length)
    console.log(`[provider-qualification] selected-provider receipts: ${finalized.artifactRefs.join(', ')}`)
  })
})

test.describe.serial('ordinary managed-provider use', () => {
  test('each selected terminal provider completes one ordinary turn', async ({ page }) => {
    test.skip(
      process.env[LIVE_ENV] !== '1',
      `set ${LIVE_ENV}=1 explicitly for an ordinary live-provider smoke`,
    )
    test.setTimeout(3_600_000)
    let setupFailureStage: OrdinaryTerminalSetupFailureStage | null = 'provider_definitions'
    let rig: ReturnType<typeof createManagedRuntimeBrowserRig> | undefined
    await withOwnedCleanup(async () => {
      try {
        const definitions = providerDefinitions()
        setupFailureStage = 'runtime_construction'
        rig = createManagedRuntimeBrowserRig(
          process.cwd(),
          5,
          {},
          { FRESHELL_RUNTIME_OBSERVER_INTERVAL_MS: '750' },
          'release',
          {
            enabledProviders: definitions.map((definition) => definition.provider),
            providerSettings: Object.fromEntries(definitions.map((definition) => [
              definition.provider,
              { model: definition.model, effort: definition.reasoningEffort },
            ])),
          },
        )
        setupFailureStage = 'runtime_start'
        const info = await rig.start()
        setupFailureStage = 'browser_script'
        await page.addInitScript(buildTerminalOrdinaryTurnBrowserScript())
        setupFailureStage = 'page_navigation'
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        setupFailureStage = 'harness_ready'
        await harness.waitForHarness()
        setupFailureStage = 'connection_ready'
        await harness.waitForConnection()
        setupFailureStage = 'active_tab'
        const tabId = await harness.getActiveTabId()
        if (!tabId) throw new Error('ordinary provider smoke has no active tab')

        setupFailureStage = null
        for (const definition of definitions) {
          let created: Awaited<ReturnType<typeof createProviderPane>> | undefined
          let paneSetupStage: ProviderPaneSetupStage | null = null
          try {
            const onPaneCreationTimeout = definition.provider === 'codex'
              ? (target: { terminalId: string | null; createRequestId: string | null }) => (
                reportPaneCreationProbe(harness, rig!, target)
              )
              : undefined
            const onManagedViewTimeout = definition.provider === 'codex'
              ? async ({ terminalId, createRequestId }: { terminalId: string; createRequestId: string }) => {
                try {
                  const [sentMessages, receivedMessages] = await Promise.all([
                    harness.getSentWsMessages(), harness.getReceivedWsMessages(),
                  ])
                  let inventoryRead: 'ok' | 'failed' = 'failed'
                  let inventory: unknown
                  try {
                    inventory = await rig!.inventory()
                    inventoryRead = 'ok'
                  } catch { /* retain the create observation when owner inventory is unavailable */ }
                  const probe = projectManagedViewProbe({ terminalId, createRequestId, provider: 'codex',
                    sentMessages, receivedMessages, inventoryRead, inventory })
                  console.error(JSON.stringify({ severity: 'error', event: 'durable_souls.managed_view_probe',
                    lane: 'terminal', provider: 'codex', probe }))
                } catch { /* diagnostic failures must preserve the managed-view timeout */ }
              }
              : undefined
            created = await createProviderPane(page, harness, rig, tabId, definition,
              stage => { paneSetupStage = stage }, onPaneCreationTimeout, onManagedViewTimeout)
            if (definition.provider === 'amplifier') {
              throw new Error('Amplifier is excluded from the ordinary terminal smoke')
            }
            await executeAndAwaitOrdinaryTurn(page, created.paneId, created.terminalId, definition.provider, created.view.nativeSessionId)
            console.info(JSON.stringify({ severity: 'info', event: 'durable_souls.ordinary_turn_completed',
              lane: 'terminal', provider: definition.provider }))
          } catch (error) {
            let terminalFacts: { available: false } | {
              available: true; provider: string; providerProcessPresent: boolean; nativeSessionIdPresent: boolean
            } = { available: false }
            if (created?.view.containerId) {
              try {
                const startup = await rig.managedTerminalStartupFacts(rig.runtimeEnclosureHandle(created.view))
                terminalFacts = { available: true, provider: startup.provider,
                  providerProcessPresent: startup.providerProcessPresent, nativeSessionIdPresent: !!created.view.nativeSessionId }
              } catch { /* preserve the ordinary-turn failure */ }
            }
            console.error(JSON.stringify({ severity: 'error', event: 'durable_souls.ordinary_turn_failed',
              lane: 'terminal', provider: definition.provider,
              errorName: error instanceof Error ? error.name : 'UnknownError', terminalFacts,
              paneSetupFailureStage: created ? null : paneSetupStage,
              ordinaryTurnFailureStage: error instanceof OrdinaryTerminalTurnError ? error.stage : null,
              ordinaryTurnFacts: error instanceof OrdinaryTerminalTurnError ? error.facts : null }))
            throw error
          }
        }
      } catch (error) {
        if (setupFailureStage !== null) {
          console.info(JSON.stringify({ severity: 'error', event: 'durable_souls.ordinary_setup_failed',
            lane: 'terminal', stage: setupFailureStage }))
        }
        throw error
      }
    }, async () => {
      if (rig) {
        const cleanup = await rig.stop()
        if (!cleanup.ok) throw new Error(cleanup.errors.join('\n') || 'Owned runtime cleanup failed')
      }
    })
  })
})

// Append outside the live-provider describe. These cases exercise real owned
// publication/enclosure/store transactions with synthetic history and no prompts.
// They do not emit ProviderQualificationRow or certify provider-observed LIVE.
const SYNTHETIC_TASK2_ENV = 'FRESHELL_RUNTIME_SYNTHETIC_RESUME'
const TASK2_ARTIFACT_MANIFEST_ENV = 'FRESHELL_TASK002_FIXTURE_ARTIFACT_MANIFEST'

async function task2FixtureHarness(): Promise<RuntimeHarness> {
  if (process.env[SYNTHETIC_TASK2_ENV] !== '1') throw new Error('exact synthetic gate required')
  const file = process.env[TASK2_ARTIFACT_MANIFEST_ENV]
  if (!file || !path.isAbsolute(file) || fs.realpathSync(file) !== file) {
    throw new Error('exact Task2 artifact manifest required')
  }
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error('Task2 artifact manifest must be private and owned')
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!/^[a-f0-9]{40}$/.test(manifest.candidateSha)
    || !/^[a-f0-9-]{36}$/.test(manifest.runId)
    || manifest.repoRoot !== fs.realpathSync(process.cwd())) {
    throw new Error('exact Task2 candidate/run/worktree identity required')
  }
  // Each browser case owns a new run. Admission still hashes the same five
  // immutable binaries and uses a run-owned image built from the current candidate.
  const h = new RuntimeHarness(manifest.repoRoot, randomUUID(), 3)
  await h.prepareTask2FixtureArtifactsForCurrentCandidate(manifest)
  return h
}

async function task2Soul(page: Page, token: string, soulId: string): Promise<any> {
  return page.evaluate(async ({ token, soulId }) => {
    const response = await fetch(`/api/runtime/souls/${encodeURIComponent(soulId)}`, {
      headers: { 'x-auth-token': token },
    })
    if (!response.ok) throw new Error(`Task2 soul API HTTP ${response.status}`)
    return response.json()
  }, { token, soulId })
}

async function task2Pane(page: Page, context: Task2RetainedPublicContext): Promise<any> {
  const state = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getState())
  return leavesByMode(state?.panes?.layouts?.[context.preferredTabId], 'opencode')
    .find(leaf => leaf.id === context.preferredPaneId)
}

async function task2SelectProjectedPane(page: Page, context: Task2RetainedPublicContext): Promise<void> {
  const tab = page.getByRole('tab', { name: new RegExp(regexEscape(context.title)) })
  await expect(tab).toBeVisible({ timeout: 60_000 })
  await tab.click()
  await expect.poll(async () => (await task2Pane(page, context))?.content?.soulId, {
    timeout: 60_000,
  }).toBe(context.soulId)
}

async function task2ClickRetry(
  page: Page, context: Task2RetainedPublicContext,
): Promise<AdminReply> {
  const detail = await task2Soul(page, context.info.token, context.soulId)
  await expect.poll(async () => (await task2Pane(page, context))?.content?.soulIntentRevision, {
    timeout: 60_000,
  }).toBe(detail.soul.intentRevision)
  const route = `/api/runtime/souls/${encodeURIComponent(context.soulId)}/retry`
  const responsePromise = page.waitForResponse(response => (
    new URL(response.url()).pathname === route && response.request().method() === 'POST'
  ), { timeout: 300_000 })
  const retry = page.getByRole('alert').filter({ hasText: 'This session needs attention' })
    .getByRole('button', { name: 'Retry recovery', exact: true })
  await expect(retry).toBeEnabled({ timeout: 60_000 })
  await retry.click()
  const response = await responsePromise
  const sent = response.request().postDataJSON()
  expect(sent.expectedIntentRevision).toBe(detail.soul.intentRevision)
  expect(sent.requestId).toMatch(/^request-runtime-ui-/)
  if (!response.ok()) {
    // A transport/auth/revision refusal is a failure, never config coverage.
    throw new Error(`owned synthetic retry API HTTP ${response.status()}`)
  }
  const result = await response.json()
  expect(result.view.soulId).toBe(context.soulId)
  return { requestId: sent.requestId, result: { Ok: { kind: 'recovery', data: result } } }
}

async function exerciseTask2Browser(browser: Browser, legacy: boolean): Promise<void> {
  const descriptor = resolveManagedExternalDescriptor(process.env)
  const h = descriptor ? undefined : await task2FixtureHarness()
  const external = descriptor ? new ExternalManagedRuntimeRig(descriptor) : undefined
  let ownedPage: Awaited<ReturnType<typeof createFreshE2ePage>> | undefined
  let localInfo: E2eServerInfo | undefined
  const observed: Task2RetainedBrowserPhase[] = []
  await withOwnedCleanup(async () => {
    const observe = async (context: Task2RetainedPublicContext, phase: Task2RetainedBrowserPhase): Promise<void> => {
      if (!ownedPage) {
        const info = descriptor ? await new ExternalServer(process.env).start() : localInfo
        if (!info) throw new Error('owned retained browser connection is missing')
        ownedPage = await createFreshE2ePage(browser, info)
        installRecoveryOfferAutoDeclineOnContext(ownedPage.context)
        await ownedPage.page.goto(`${context.info.baseUrl}/?token=${context.info.token}&e2e=1`, {
          timeout: 60_000,
        })
        const harness = new TestHarness(ownedPage.page)
        await harness.waitForHarness(60_000)
        await harness.waitForConnection()
      }
      const { page } = ownedPage
      await task2SelectProjectedPane(page, context)
      const detail = await task2Soul(page, context.info.token, context.soulId)
      expect(detail.soul.soulId).toBe(context.soulId)
      expect(detail.soul.nativeSessionId).toBe(context.rootSessionId)
      expect(detail.soul.incidentId).toBeUndefined()
      const intent = detail.viewIntents.find((view: any) => view.preferredPaneId === context.preferredPaneId)
      expect(intent).toMatchObject({ kind: 'automatic_primary', visibility: 'visible',
        preferredTabId: context.preferredTabId, soulId: context.soulId })
      const alert = page.getByRole('alert').filter({ hasText: 'This session needs attention' })
      if (phase === 'store_blocked') {
        expect(detail.soul.recoveryState).toBe('blocked')
        expect(detail.soul.recoveryReason).toBe('STORE_UNREADABLE')
        expect(detail.soul.containerId).toBe(context.oldContainerId)
        await expect(alert).toBeVisible()
        await expect(alert).toContainText('saved conversation store is readable')
        await expect(alert.getByRole('button', { name: 'Retry recovery', exact: true })).toBeEnabled()
        await expect(page.getByRole('button', { name: 'Start new conversation', exact: true })).toHaveCount(0)
      } else if (phase === 'config_blocked') {
        expect(context.configMode).toBe(0)
        expect(context.result?.result.Ok?.data.outcome).toBe('blocked')
        expect(context.result?.result.Ok?.data.probe).toMatchObject({ kind: 'blocked',
          data: { reason: 'CAPABILITY_PENDING' } })
        expect(context.result?.result.Ok?.data.probe.data.retry_hint?.repair)
          .toContain('provider configuration publication')
        expect(detail.soul.recoveryState).toBe('blocked')
        expect(detail.soul.recoveryReason).toBe('CAPABILITY_PENDING')
        await expect(alert).toBeVisible()
        // Assert the real persisted reason rendered by the production card.
        await expect(alert).toContainText(managedRecoveryBlockedMessage(detail.soul.recoveryReason))
        await expect(alert.getByRole('button', { name: 'Retry recovery', exact: true })).toBeEnabled()
      } else {
        expect(context.result?.result.Ok?.data.outcome).toBe('replaced')
        expect(detail.soul.containerId).not.toBe(context.oldContainerId)
        expect(detail.soul.incarnationId).not.toBe(context.oldIncarnationId)
        expect(detail.soul.launchState).toBe('running')
        await expect.poll(async () => (await task2Pane(page, context))?.content?.incarnationId, {
          timeout: 60_000,
        }).toBe(detail.soul.incarnationId)
        const pane = await task2Pane(page, context)
        expect(pane.content.soulId).toBe(context.soulId)
        expect(pane.content.sessionRef?.sessionId).toBe(context.rootSessionId)
        await expect(alert).toHaveCount(0)
        await page.screenshot({ path: h ? path.join(h.browserDir, legacy ? 'legacy-replaced.png' : 'config-replaced.png') : test.info().outputPath(legacy ? 'legacy-replaced.png' : 'config-replaced.png') })
      }
      observed.push(phase)
    }
    const retry = async (context: Task2RetainedPublicContext, phase: 'config_fault' | 'repaired'): Promise<AdminReply> => {
      if (!ownedPage) throw new Error('browser must observe the actual blocker before retry')
      await task2SelectProjectedPane(ownedPage.page, context)
      if (phase === 'repaired' && !legacy) expect(context.configMode).toBe(0o644)
      return task2ClickRetry(ownedPage.page, context)
    }
    if (external) {
      await external.start()
      await external.startRetainedFixture(legacy ? 'legacy' : 'config')
      let sequence = 0
      for (;;) {
        await expect.poll(async () => {
          const stage = await external.retainedFixtureStage()
          return stage.kind !== 'preparing' && stage.sequence > sequence
        }, { timeout: 300_000 }).toBe(true)
        const stage = await external.retainedFixtureStage()
        if (stage.kind === 'finished') {
          expect(stage.facts?.candidateSha).toBe(descriptor?.candidateSha)
          expect(stage.facts?.unsafeBrokerAttempts).toBe(0)
          expect(stage.facts?.fixtureRunId).toMatch(/^[a-f0-9-]{36}$/)
          expect(stage.facts?.imageDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
          break
        }
        if (stage.kind === 'failed') throw new Error('actual owner retained fixture failed; inspect its private evidence')
        if (stage.kind === 'preparing') throw new Error('owned retained stage changed unexpectedly')
        sequence = stage.sequence
        if (stage.kind === 'observe') {
          if (stage.phase !== 'store_blocked' && stage.phase !== 'config_blocked' && stage.phase !== 'replaced') throw new Error('invalid retained observation phase')
          await observe(stage.context, stage.phase)
          await external.observeRetainedFixture(sequence)
        } else if (stage.kind === 'retry') {
          if (stage.phase !== 'config_fault' && stage.phase !== 'repaired') throw new Error('invalid retained retry phase')
          await retry(stage.context, stage.phase)
        }
      }
    } else {
      if (!h) throw new Error('local retained owner missing')
      const publicContext = (context: Task2RetainedBrowserContext): Task2RetainedPublicContext => {
        localInfo = context.web.info
        return task2RetainedPublicContext(context)
      }
      await runTask2RetainedFixture(h, legacy, {
        observe: (context, phase) => observe(publicContext(context), phase),
        retry: (context, phase) => retry(publicContext(context), phase),
      })
    }
    expect(observed).toEqual(legacy ? ['store_blocked', 'replaced'] : ['store_blocked', 'config_blocked', 'replaced'])
    if (h) expect(h.broker.unsafeAttempts()).toHaveLength(0)
  }, async () => {
    await withOwnedCleanup(async () => { await ownedPage?.context.close() }, async () => {
      if (external) {
        const cleanup = await external.finishRetainedFixture()
        expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
      }
      if (h) {
        const receipts = h.broker.receipts(), ids = h.transferOwnedIds()
        const cleanup = await h.cleanup()
        h.verifyTransferCleanup({ containers: [...new Set([...ids.containers, ...receipts.map(row => row.containerId)])],
          volumes: [...new Set([...ids.volumes, ...receipts.flatMap(row => row.providerVolumeName ? [row.providerVolumeName] : [])])] })
        expect(cleanup.ok, cleanup.errors.join('\n')).toBe(true)
      }
    })
  })
  // These labels describe the fixture type; physical/DOM/API assertions above
  // carry the evidence. This artifact cannot qualify native identity/readiness.
  h?.writeArtifact(legacy ? 'task002-legacy-browser.json' : 'task002-config-browser.json', {
    kind: 'synthetic-task2-browser', nativeQualified: false,
    candidateSha: h.candidateSha, imageDigest: h.imageRef, observed,
  })
}

test.describe.serial('Task2 synthetic provider configuration and legacy retry', () => {
  test('synthetic config-blocked exact retry', async ({ browser }) => {
    test.skip(process.env[SYNTHETIC_TASK2_ENV] !== '1', `requires ${SYNTHETIC_TASK2_ENV}=1`)
    test.setTimeout(900_000)
    await exerciseTask2Browser(browser, false)
  })
  test('synthetic legacy retained-runtime exact retry', async ({ browser }) => {
    test.skip(process.env[SYNTHETIC_TASK2_ENV] !== '1', `requires ${SYNTHETIC_TASK2_ENV}=1`)
    test.setTimeout(900_000)
    await exerciseTask2Browser(browser, true)
  })
})
