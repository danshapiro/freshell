import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  newRequest,
  newSoul,
  RuntimeGateBlockedError,
  RuntimeHarness,
  type SupervisorInstance,
} from '../../../scripts/testing/runtime-sandbox.js'
import { validateFreshAgentIngressInventory } from '../../../scripts/testing/fresh-agent-ingress-inventory.js'

export const PHASE3_CASE_IDS = [
  'P3-G02', 'P3-G03', 'P3-G04', 'P3-G05', 'P3-G06',
  'P3-G07', 'P3-G08', 'P3-G09', 'P3-G11', 'P3-G12',
] as const

export type Phase3BlockedCase = {
  caseId: string
  message: string
  evidence?: unknown
}

export type Phase3RunResult = {
  executed: string[]
  blocked: Phase3BlockedCase[]
}

type NativeSoul = {
  soulId: string
  sessionId?: string
  incarnationId: string
  containerId: string
  workerPid: number
  view: any
}

/** Deterministic runtime recovery; live-provider checks run directly in Playwright. */
export async function runPhase3Gate(
  harness: RuntimeHarness,
  onCasePassed: (caseId: string) => void = () => {},
  only?: ReadonlySet<string>,
): Promise<Phase3RunResult> {
  validateFreshAgentIngressInventory(harness.repoRoot)
  const executed: string[] = []
  const blocked: Phase3BlockedCase[] = []
  const cases = [
    ['P3-G04', gate04ProviderCompatibleCheckpointRestore],
    ['P3-G06', gate06WrongIdentityAndNoFreshFallback],
    ['P3-G07', gate07ZeroTurnAndCommandJournal],
    ['P3-G08', gate08OneWriterStopAndControllerCrashRaces],
    ['P3-G11', gate11PersistedRetryAndManualRearm],
    ['P3-G12', gate12DoorwayAndSpawnSiteInventory],
    ['P3-G02', gate02NonceSurvivesHostAndControllerLoss],
    ['P3-G03', gate03ProviderAndHostCrashFamilies],
    ['P3-G05', gate05TypedBlockersAndRepair],
    ['P3-G09', gate09IndependentSoulsAndViews],
  ] as const

  for (const [caseId, run] of cases) {
    if (only && !only.has(caseId)) continue
    harness.recordLifecycle('gate.case.started', { caseId })
    try {
      await run(harness)
      executed.push(caseId)
      onCasePassed(caseId)
      harness.recordLifecycle('gate.case.passed', { caseId })
    } catch (error) {
      if (error instanceof RuntimeGateBlockedError) {
        const row = { caseId, message: error.message, evidence: error.evidence }
        blocked.push(row)
        harness.writeIncident(`${caseId}-blocked`, row)
        harness.recordLifecycle('gate.case.blocked', row)
        continue
      }
      harness.writeIncident(`${caseId}-failure`, {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      })
      harness.recordLifecycle('gate.case.failed', { caseId, error: String(error) })
      throw error
    }
  }

  validatePhase3Coverage(PHASE3_CASE_IDS.filter(id => !only || only.has(id)), executed, blocked.map((row) => row.caseId))
  return { executed, blocked }
}

export function validatePhase3Coverage(
  required: readonly string[],
  executed: readonly string[],
  blocked: readonly string[],
): void {
  const accounted = new Set([...executed, ...blocked])
  const missing = required.filter((id) => !accounted.has(id))
  const duplicates = [...executed, ...blocked].filter((id, index, all) => all.indexOf(id) !== index)
  const extra = [...accounted].filter((id) => !required.includes(id))
  if (missing.length || duplicates.length || extra.length) {
    throw new Error(
      `phase3 gate accounting incomplete: missing=[${missing}] duplicates=[${duplicates}] extra=[${extra}]`,
    )
  }
}

async function gate02NonceSurvivesHostAndControllerLoss(h: RuntimeHarness): Promise<void> {
  const caseId = 'P3-G02'
  const scenarioId = `p3-g02-${randomUUID().slice(0, 8)}`
  const first = await h.startSupervisor({ scenarioId })
  const nonce = randomUUID().replaceAll('-', '')
  const native = await launchMaterializedNativeSoul(h, first, caseId, `nonce-${nonce}`)
  const remembered = await h.nativeFixtureCall(first, native.incarnationId, {
    method: 'remember',
    key: 'gate_nonce',
    value: nonce,
  })
  h.assert(caseId, remembered.ok === true, 'synthetic provider completed and persisted the nonce turn', remembered)
  await captureResumeSpec(h, first, native, caseId)

  h.stopSupervisorExact(first)
  h.removeContainerExact(first.containerId)
  h.killOwnedRuntimeExact(native.containerId)

  const restarted = await h.startSupervisor({ scenarioId, volumeName: first.volumeName })
  // Supervisor readiness follows its startup scan. The desired-running soul is
  // therefore already recovered before a web/controller caller can redrive it.
  const startupView = latestSoulView(await inventory(h, restarted), native.soulId)
  assertExactReplacementView(h, caseId, native, startupView)

  const recovery = dataOf(
    await h.adminOk(restarted, h.recoverBody(native.soulId, 'host_unreachable')),
    'recovery',
  )
  h.assert(
    caseId,
    recovery.outcome === 'reattached'
      && recovery.view.incarnationId === startupView.incarnationId
      && recovery.view.nativeSessionId === native.sessionId,
    'a delayed web recovery request idempotently reattaches the startup replacement',
    recovery,
  )
  const recalled = await h.nativeFixtureCall(restarted, startupView.incarnationId, {
    method: 'recall',
    key: 'gate_nonce',
  })
  h.assert(caseId, recalled.ok === true && recalled.value === nonce, 'replacement recalls the prior nonce without receiving it in the follow-up', recalled)
  h.assert(caseId, !h.isContainerRunning(native.containerId), 'the prior enclosure is empty before the replacement remains active')

}

async function gate03ProviderAndHostCrashFamilies(h: RuntimeHarness): Promise<void> {
  const caseId = 'P3-G03'
  const supervisor = await h.startSupervisor({ scenarioId: `p3-g03-${randomUUID().slice(0, 8)}` })
  const native = await launchMaterializedNativeSoul(h, supervisor, caseId, 'provider-and-host-crash')
  await h.nativeFixtureCall(supervisor, native.incarnationId, {
    method: 'remember',
    key: 'crash_marker',
    value: 'survives-both',
  })
  await captureResumeSpec(h, supervisor, native, caseId)

  h.execOwnedContainerExact(native.containerId, ['kill', '-9', String(native.workerPid)])
  await waitUntil(() => !nativeFixtureWorkerAlive(h, native.containerId, native.workerPid), 8_000)
  const providerRecovery = await recoverExactOnce(
    h,
    supervisor,
    caseId,
    native,
    'provider_exit',
  )

  const afterProvider: NativeSoul = {
    ...native,
    incarnationId: providerRecovery.view.incarnationId,
    containerId: providerRecovery.view.containerId,
    workerPid: numericField(providerRecovery.view, 'workerPid', 'worker_pid') || 0,
    view: providerRecovery.view,
  }
  const inventoryAfterProvider = dataOf(await h.adminOk(supervisor, h.inventoryBody()), 'inventory')
  const providerView = inventoryAfterProvider.find((view: any) => view.incarnationId === providerRecovery.view.incarnationId)
  h.assert(caseId, providerView?.profile === native.view.profile, 'provider-process recovery keeps the resource profile', { before: native.view, after: providerView })

  h.killOwnedRuntimeExact(providerRecovery.view.containerId)
  const hostRecovery = await recoverExactOnce(
    h,
    supervisor,
    caseId,
    afterProvider,
    'host_unreachable',
    native.sessionId,
  )
  const recalled = await h.nativeFixtureCall(supervisor, hostRecovery.view.incarnationId, {
    method: 'recall',
    key: 'crash_marker',
  })
  h.assert(caseId, recalled.value === 'survives-both', 'state survives provider-process and host-enclosure crashes', recalled)
  assertSingleRunningWriter(h, caseId, await inventory(h, supervisor), native.soulId)

}

async function gate04ProviderCompatibleCheckpointRestore(h: RuntimeHarness): Promise<void> {
  const caseId = 'P3-G04'
  const supervisor = await h.startSupervisor({ scenarioId: `p3-g04-${randomUUID().slice(0, 8)}` })
  const native = await launchMaterializedNativeSoul(h, supervisor, caseId, 'checkpoint')
  const nonce = randomUUID().replaceAll('-', '')
  await h.nativeFixtureCall(supervisor, native.incarnationId, {
    method: 'remember', key: 'checkpoint_nonce', value: nonce,
  })
  const checkpoint = await h.nativeFixtureCall(supervisor, native.incarnationId, { method: 'checkpoint' })
  h.assert(caseId, checkpoint.ok === true && checkpoint.checkpointRevision === 1, 'fixture creates a provider-compatible verified checkpoint', checkpoint)
  await captureResumeSpec(h, supervisor, native, caseId)

  h.execOwnedContainerExact(native.containerId, ['rm', '-f', '/home/freshell/provider/native-session-state.json'])
  h.killOwnedRuntimeExact(native.containerId)
  const recovery = dataOf(
    await h.adminOk(supervisor, h.recoverBody(native.soulId, 'provider_exit')),
    'recovery',
  )
  assertExactReplacement(h, caseId, native, recovery)
  const recalled = await h.nativeFixtureCall(supervisor, recovery.view.incarnationId, {
    method: 'recall', key: 'checkpoint_nonce',
  })
  h.assert(caseId, recalled.value === nonce, 'backup restore recovers conversation memory before declaring loss', recalled)
  const history = await h.nativeFixtureCall(supervisor, recovery.view.incarnationId, { method: 'history' })
  h.assert(caseId, history.history.includes('checkpoint_restore:1'), 'history records that checkpoint recovery was attempted', history)
  const retained = h.execOwnedContainerExact(
    recovery.view.containerId,
    ['test', '-f', '/home/freshell/provider/.freshell/checkpoints/native-session/1.json'],
  )
  h.assert(caseId, retained === '', 'checkpoint source evidence remains retained after promotion')
  h.assert(caseId, recovery.expectedNativeSessionId === native.sessionId, 'checkpoint restore targets the original identity', recovery)
  h.assert(caseId, recovery.observedNativeSessionId === native.sessionId, 'checkpoint restore verifies the original identity', recovery)
}

async function gate05TypedBlockersAndRepair(h: RuntimeHarness): Promise<void> {
  const caseId = 'P3-G05'
  runFocusedRustTest(h, 'freshell-agent-runtime', 'transient_failures_map_to_blocked_reasons')

  const supervisor = await h.startSupervisor({ scenarioId: `p3-g05-${randomUUID().slice(0, 8)}` })
  const native = await launchMaterializedNativeSoul(h, supervisor, caseId, 'repair')
  const originalState = h.execOwnedContainerExact(native.containerId, ['cat', '/home/freshell/provider/native-session-state.json'])
  await captureResumeSpec(h, supervisor, native, caseId)
  h.execOwnedContainerExact(native.containerId, ['sh', '-lc', "printf '{not-json' > /home/freshell/provider/native-session-state.json"])
  const receipt = h.broker.receipts().find((candidate) => candidate.containerId === native.containerId)
  h.assert(caseId, typeof receipt?.providerVolumeName === 'string', 'broker receipt identifies the exact soul provider volume', receipt)
  h.killOwnedRuntimeExact(native.containerId)

  const blocked = dataOf(
    await h.adminOk(supervisor, h.recoverBody(native.soulId, 'provider_exit')),
    'recovery',
  )
  h.assert(caseId, blocked.outcome === 'blocked', 'corrupt/unreadable provider state is BLOCKED rather than lost', blocked)
  h.assert(caseId, blocked.outcome !== 'lost', 'transient provider failure is never promoted to loss', blocked)
  h.assert(caseId, blocked.expectedNativeSessionId === native.sessionId, 'blocked state retains the original native identity', blocked)

  restoreProviderVolume(h, receipt!.providerVolumeName!, originalState)
  const repaired = dataOf(
    await h.adminOk(supervisor, h.recoverBody(native.soulId, 'manual_retry')),
    'recovery',
  )
  assertExactReplacement(h, caseId, native, repaired, native.sessionId, blocked.view.incarnationId)
  const exhausted = dataOf(
    await h.adminOk(supervisor, h.recoverBody(native.soulId, 'retry_exhausted')),
    'recovery',
  )
  h.assert(caseId, exhausted.outcome === 'blocked' && exhausted.probe?.data?.reason === 'RETRY_BUDGET', 'retry exhaustion persists an explicit blocked verdict', exhausted)
  const rearmed = dataOf(
    await h.adminOk(supervisor, h.recoverBody(native.soulId, 'manual_retry')),
    'recovery',
  )
  h.assert(caseId, rearmed.outcome === 'reattached', 'manual repair/retry rearms the same live conversation', rearmed)
  h.assert(caseId, rearmed.view.nativeSessionId === native.sessionId, 'manual rearm preserves the native identity', rearmed)

}

async function gate06WrongIdentityAndNoFreshFallback(h: RuntimeHarness): Promise<void> {
  const caseId = 'P3-G06'
  const supervisor = await h.startSupervisor({ scenarioId: `p3-g06-${randomUUID().slice(0, 8)}` })
  const native = await launchMaterializedNativeSoul(h, supervisor, caseId, 'wrong-id')
  await captureResumeSpec(h, supervisor, native, caseId)
  const wrong = `fixture-native-wrong-${randomUUID()}`
  h.execOwnedContainerExact(native.containerId, [
    'sh', '-lc',
    `sed -i 's/${shellRegexEscape(native.sessionId!)}/${shellRegexEscape(wrong)}/g' /home/freshell/provider/native-session-state.json`,
  ])
  h.killOwnedRuntimeExact(native.containerId)
  const result = dataOf(
    await h.adminOk(supervisor, h.recoverBody(native.soulId, 'provider_exit')),
    'recovery',
  )
  h.assert(caseId, result.outcome === 'blocked', 'wrong resumed identity is rejected', result)
  h.assert(caseId, result.probe?.data?.reason === 'WRONG_NATIVE_IDENTITY', 'wrong identity has an explicit diagnostic reason', result)
  h.assert(caseId, result.expectedNativeSessionId === native.sessionId, 'the soul retains its original expected identity', result)
  const views = await inventory(h, supervisor)
  h.assert(caseId, !views.some((view: any) => view.soulId === native.soulId && view.launchState === 'running'), 'failed wrong-ID replacement is safely removed', views)

  const resumeGate = fs.readFileSync(path.join(h.repoRoot, 'crates/freshell-platform/src/resume_gate.rs'), 'utf8')
  const wsCaller = fs.readFileSync(path.join(h.repoRoot, 'crates/freshell-ws/src/resume_validation.rs'), 'utf8')
  const restCaller = fs.readFileSync(path.join(h.repoRoot, 'crates/freshell-freshagent/src/terminal_tabs.rs'), 'utf8')
  h.assert(caseId, resumeGate.includes('ManagedRecovery') && resumeGate.includes('BlockedRecovery'), 'resume gate models managed recovery explicitly')
  h.assert(caseId, wsCaller.includes('ResumeIntent::ManagedRecovery') && restCaller.includes('ResumeIntent::ManagedRecovery'), 'actual WS and REST callers select managed recovery intent')
  h.assert(caseId, !/ManagedRecovery[\s\S]{0,400}SpawnFresh/.test(resumeGate), 'managed recovery has no SpawnFresh policy branch')
  runFocusedRustTest(h, 'freshell-platform', 'managed_recovery')
}

async function gate07ZeroTurnAndCommandJournal(h: RuntimeHarness): Promise<void> {
  const caseId = 'P3-G07'
  const supervisor = await h.startSupervisor({ scenarioId: `p3-g07-${randomUUID().slice(0, 8)}` })
  const zero = await launchNativeSoul(h, supervisor, caseId, 'zero-turn', false)
  h.assert(caseId, zero.view.allocationState === 'allocated', 'zero-turn allocation is not advertised as durable', zero.view)
  h.killOwnedRuntimeExact(zero.containerId)
  const recovered = dataOf(
    await h.adminOk(supervisor, h.recoverBody(zero.soulId, 'provider_exit')),
    'recovery',
  )
  h.assert(caseId, recovered.outcome === 'replaced', 'proven never-dispatched seed can recreate the same soul', recovered)
  h.assert(caseId, recovered.probe?.kind === 'pristine_seed_ready', 'zero-turn recovery uses only a pristine-seed proof', recovered)
  h.assert(caseId, recovered.view.soulId === zero.soulId, 'pristine recovery does not mint a new soul', recovered)

  const created = await h.nativeFixtureCall(supervisor, recovered.view.incarnationId, { method: 'create' })
  h.assert(caseId, created.ok === true, 'recreated pristine soul can materialize once', created)
  runFocusedRustTest(h, 'freshell-supervisor', 'protected_command_journal_is_private_and_replays_only_queued_input')
}

async function gate08OneWriterStopAndControllerCrashRaces(h: RuntimeHarness): Promise<void> {
  const caseId = 'P3-G08'

  const concurrent = await h.startSupervisor({ scenarioId: `p3-g08-concurrent-${randomUUID().slice(0, 8)}` })
  const native = await launchMaterializedNativeSoul(h, concurrent, caseId, 'concurrent')
  await captureResumeSpec(h, concurrent, native, caseId)
  h.killOwnedRuntimeExact(native.containerId)
  const concurrentResults = await Promise.all([
    h.adminOk(concurrent, h.recoverBody(native.soulId, 'provider_exit')),
    h.adminOk(concurrent, h.recoverBody(native.soulId, 'provider_exit')),
  ])
  const recoveries = concurrentResults.map((reply) => dataOf(reply, 'recovery'))
  h.assert(caseId, recoveries.filter((result) => result.outcome === 'replaced').length === 1, 'concurrent recovery requests create exactly one replacement', recoveries)
  h.assert(caseId, recoveries.every((result) => ['replaced', 'reattached'].includes(result.outcome)), 'second recovery attaches instead of creating a second writer', recoveries)
  assertSingleRunningWriter(h, caseId, await inventory(h, concurrent), native.soulId)

  const stopRace = await h.startSupervisor({ scenarioId: `p3-g08-stop-${randomUUID().slice(0, 8)}` })
  const stopSoul = await launchMaterializedNativeSoul(h, stopRace, caseId, 'stop-race')
  await captureResumeSpec(h, stopRace, stopSoul, caseId)
  h.killOwnedRuntimeExact(stopSoul.containerId)
  const epoch = await controlEpoch(h, stopRace)
  await Promise.allSettled([
    h.adminOk(stopRace, h.recoverBody(stopSoul.soulId, 'provider_exit', epoch)),
    h.adminOk(stopRace, h.stopBody(stopSoul.soulId, epoch)),
  ])
  const stoppedViews = await inventory(h, stopRace)
  const latestStopped = latestSoulView(stoppedViews, stopSoul.soulId)
  h.assert(caseId, latestStopped?.desiredState === 'stopped', 'durable Stop intent wins the recovery race', latestStopped)
  h.assert(caseId, !stoppedViews.some((view: any) => view.soulId === stopSoul.soulId && view.launchState === 'running'), 'stop race leaves no active writer', stoppedViews)

  await exercisePhase3StartupReplacementCrash(h)
  runFocusedRustTest(h, 'freshell-supervisor', 'stop_intent_fences_a_recovery_attempt_before_replacement')
  runFocusedRustTest(h, 'freshell-supervisor', 'one_recovery_attempt_cannot_create_two_active_incarnations')
}

export type Phase3StartupCrashProof = {
  crashEvent: { event: 'supervisor.test_crash'; point: string }
  recoveryOutcome: string
  nativeSessionStable: boolean
  stopOutcome: string
}

/**
 * Exercise the startup-timed P3-G08 failure in isolation as well as from the
 * cumulative gate. Startup reconciliation begins before the control socket is
 * healthy, so the faulted instance must deliberately skip its health wait.
 */
export async function exercisePhase3StartupReplacementCrash(
  h: RuntimeHarness,
): Promise<Phase3StartupCrashProof> {
  const caseId = 'P3-G08'
  const crashPoint = 'after_docker_create'
  const crashScenario = `p3-g08-crash-${randomUUID().slice(0, 8)}`
  const beforeCrash = await h.startSupervisor({ scenarioId: crashScenario })
  const crashSoul = await launchMaterializedNativeSoul(h, beforeCrash, caseId, 'controller-crash')
  await captureResumeSpec(h, beforeCrash, crashSoul, caseId)
  h.stopSupervisorExact(beforeCrash)
  h.removeContainerExact(beforeCrash.containerId)
  h.killOwnedRuntimeExact(crashSoul.containerId)

  const receiptsBeforeCrash = h.broker.receiptIds()
  const crashing = await h.startSupervisor({
    scenarioId: crashScenario,
    volumeName: beforeCrash.volumeName,
    crashPoint,
    waitForHealth: false,
  })
  await h.waitForContainerExit(crashing.containerId, 8_000)
  const crashEvent = supervisorCrashEvent(h.containerLogs(crashing.containerId), crashPoint)
  h.assert(caseId, crashEvent !== null, `startup reconciliation emitted the exact named ${crashPoint} crash event`)
  const crashReceipts = h.brokerReceiptsSince(receiptsBeforeCrash)
  h.assert(
    caseId,
    crashReceipts.length === 1 && h.inspectContainer(crashReceipts[0].containerId).State.Running === false,
    'startup crash leaves exactly one stopped, receipt-owned replacement candidate',
    crashReceipts,
  )
  h.removeContainerExact(crashing.containerId)

  const reconciled = await h.startSupervisor({
    scenarioId: crashScenario,
    volumeName: beforeCrash.volumeName,
  })
  const final = dataOf(
    await h.adminOk(reconciled, h.recoverBody(crashSoul.soulId, 'startup_reconcile')),
    'recovery',
  )
  h.assert(caseId, ['replaced', 'reattached'].includes(final.outcome), 'restart reconciles a startup-timed mid-replacement crash', final)
  const views = await inventory(h, reconciled)
  assertSingleRunningWriter(h, caseId, views, crashSoul.soulId)
  const liveView = latestSoulView(views, crashSoul.soulId)
  const nativeSessionStable = liveView?.nativeSessionId === crashSoul.sessionId
  h.assert(caseId, nativeSessionStable, 'startup crash recovery preserves the exact provider-native identity', {
    expectedNativeSessionId: crashSoul.sessionId,
    liveView,
  })
  const history = await h.nativeFixtureCall(reconciled, liveView.incarnationId, { method: 'history' })
  h.assert(
    caseId,
    automaticResumeHistoryPreservesIdentity(history, crashSoul.sessionId!),
    'the replacement reconnects exactly once through automatic resume without a fresh create',
    history,
  )
  const stop = dataOf(
    await h.adminOk(reconciled, h.stopBody(crashSoul.soulId, await controlEpoch(h, reconciled))),
    'stop',
  )
  h.assert(caseId, stop.outcome === 'verified_empty', 'startup crash replacement terminates with verified-empty cleanup', stop)

  return {
    crashEvent,
    recoveryOutcome: final.outcome,
    nativeSessionStable,
    stopOutcome: stop.outcome,
  }
}

export function automaticResumeHistoryPreservesIdentity(
  history: unknown,
  expectedSessionId: string,
): boolean {
  if (!history || typeof history !== 'object') return false
  const candidate = history as { ok?: unknown; sessionId?: unknown; history?: unknown }
  return candidate.ok === true
    && candidate.sessionId === expectedSessionId
    && Array.isArray(candidate.history)
    && candidate.history.length === 2
    && candidate.history[0] === 'create'
    && candidate.history[1] === 'automatic_resume'
}

export function supervisorCrashEvent(
  logs: string,
  expectedPoint: string,
): { event: 'supervisor.test_crash'; point: string } | null {
  for (const line of logs.split(/\r?\n/)) {
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record && typeof record === 'object'
      && (record as any).event === 'supervisor.test_crash'
      && (record as any).point === expectedPoint) {
      return { event: 'supervisor.test_crash', point: expectedPoint }
    }
  }
  return null
}

async function gate09IndependentSoulsAndViews(h: RuntimeHarness): Promise<void> {
  const caseId = 'P3-G09'
  const supervisor = await h.startSupervisor({ scenarioId: `p3-g09-${randomUUID().slice(0, 8)}` })
  const first = await launchMaterializedNativeSoul(h, supervisor, caseId, 'first')
  const second = await launchMaterializedNativeSoul(h, supervisor, caseId, 'second')
  await h.nativeFixtureCall(supervisor, first.incarnationId, { method: 'remember', key: 'owner', value: 'first' })
  await h.nativeFixtureCall(supervisor, second.incarnationId, { method: 'remember', key: 'owner', value: 'second' })
  await captureResumeSpec(h, supervisor, first, caseId)
  await captureResumeSpec(h, supervisor, second, caseId)
  h.killOwnedRuntimeExact(first.containerId)
  const recovered = dataOf(
    await h.adminOk(supervisor, h.recoverBody(first.soulId, 'provider_exit')),
    'recovery',
  )
  assertExactReplacement(h, caseId, first, recovered)
  const secondRecall = await h.nativeFixtureCall(supervisor, second.incarnationId, { method: 'recall', key: 'owner' })
  h.assert(caseId, secondRecall.value === 'second', 'stress/recovery of one soul leaves the other provider state untouched', secondRecall)
  const views = await inventory(h, supervisor)
  const secondView = latestSoulView(views, second.soulId)
  h.assert(caseId, secondView?.incarnationId === second.incarnationId && secondView?.containerId === second.containerId, 'second soul retains its independent incarnation/writer', secondView)
  assertSingleRunningWriter(h, caseId, views, first.soulId)
  assertSingleRunningWriter(h, caseId, views, second.soulId)

}

async function gate11PersistedRetryAndManualRearm(h: RuntimeHarness): Promise<void> {
  const caseId = 'P3-G11'
  const scenarioId = `p3-g11-${randomUUID().slice(0, 8)}`
  let supervisor = await h.startSupervisor({ scenarioId })
  const native = await launchMaterializedNativeSoul(h, supervisor, caseId, 'flap')
  await captureResumeSpec(h, supervisor, native, caseId)
  let current = native
  for (let attempt = 0; attempt < 2; attempt += 1) {
    h.killOwnedRuntimeExact(current.containerId)
    const recovered = dataOf(
      await h.adminOk(supervisor, h.recoverBody(native.soulId, 'provider_exit')),
      'recovery',
    )
    assertExactReplacement(h, caseId, current, recovered, native.sessionId)
    current = {
      ...current,
      incarnationId: recovered.view.incarnationId,
      containerId: recovered.view.containerId,
      view: recovered.view,
    }
    h.stopSupervisorExact(supervisor)
    h.removeContainerExact(supervisor.containerId)
    supervisor = await h.startSupervisor({ scenarioId, volumeName: supervisor.volumeName })
  }

  const exhausted = dataOf(
    await h.adminOk(supervisor, h.recoverBody(native.soulId, 'retry_exhausted')),
    'recovery',
  )
  h.assert(caseId, exhausted.outcome === 'blocked', 'retry exhaustion pauses the resumable soul', exhausted)
  h.stopSupervisorExact(supervisor)
  h.removeContainerExact(supervisor.containerId)
  supervisor = await h.startSupervisor({ scenarioId, volumeName: supervisor.volumeName })
  const persisted = latestSoulView(await inventory(h, supervisor), native.soulId)
  h.assert(caseId, persisted?.recoveryState === 'blocked' && persisted?.recoveryReason?.includes('RETRY_BUDGET'), 'blocked flap state survives controller restart', persisted)
  const rearmed = dataOf(
    await h.adminOk(supervisor, h.recoverBody(native.soulId, 'manual_retry')),
    'recovery',
  )
  h.assert(caseId, rearmed.outcome === 'reattached', 'manual retry rearms rather than creating a blank conversation', rearmed)
  h.assert(caseId, rearmed.view.nativeSessionId === native.sessionId, 'manual rearm retains the exact native identity', rearmed)
  runFocusedRustTest(h, 'freshell-supervisor', 'retry_budget_is_persisted_and_manual_retry_rearms_without_identity_change')
}

async function gate12DoorwayAndSpawnSiteInventory(h: RuntimeHarness): Promise<void> {
  const caseId = 'P3-G12'
  const manifest = readCapabilityManifest(h)
  const allowedPolicies = new Set(['managed', 'blocked', 'legacy'])
  h.assert(caseId, Array.isArray(manifest.doorways) && manifest.doorways.length >= 6, 'capability manifest enumerates browser/API/restore/provider doorway classes', manifest.doorways)
  for (const doorway of manifest.doorways) {
    h.assert(caseId, typeof doorway.name === 'string' && doorway.name.length > 0, 'each doorway is named', doorway)
    h.assert(caseId, allowedPolicies.has(doorway.policy), `doorway ${doorway.name} has an explicit policy`, doorway)
    h.assert(caseId, Array.isArray(doorway.providers) && doorway.providers.length > 0, `doorway ${doorway.name} enumerates providers`, doorway)
  }
  const names = new Set(manifest.doorways.map((doorway: any) => doorway.name))
  for (const required of ['websocket-terminal-create-attach', 'rest-freshclaude', 'rest-freshopencode', 'startup-reconcile-and-exit-observer', 'legacy-history-import', 'extension-providers']) {
    h.assert(caseId, names.has(required), `doorway matrix includes ${required}`, manifest.doorways)
  }

  const managedRuntime = fs.readFileSync(path.join(h.repoRoot, 'crates/freshell-server/src/managed_runtime.rs'), 'utf8')
  const supervisorInventory = fs.readFileSync(path.join(h.repoRoot, 'crates/freshell-supervisor/src/inventory.rs'), 'utf8')
  const supervisorRecovery = fs.readFileSync(path.join(h.repoRoot, 'crates/freshell-supervisor/src/recovery.rs'), 'utf8')
  const wsResume = fs.readFileSync(path.join(h.repoRoot, 'crates/freshell-ws/src/resume_validation.rs'), 'utf8')
  const restResume = fs.readFileSync(path.join(h.repoRoot, 'crates/freshell-freshagent/src/terminal_tabs.rs'), 'utf8')
  h.assert(
    caseId,
    supervisorInventory.includes('RecoveryTrigger::StartupReconcile')
      && supervisorInventory.includes('RecoveryTrigger::ProviderExit')
      && /pub(?:\(crate\))?\s+async\s+fn\s+recover\s*\(/.test(supervisorRecovery)
      && /client\s*\.\s*recover\s*\(/.test(managedRuntime)
      && !managedRuntime.includes('prepare_replacement('),
    'startup, observer, and web-detected failures converge on the supervisor-owned recovery state machine',
  )
  h.assert(caseId, wsResume.includes('ResumeIntent::ManagedRecovery') && restResume.includes('ResumeIntent::ManagedRecovery'), 'WS and REST resume callers delegate managed recovery to the shared policy')
  h.assert(caseId, manifest.invariants.managedRecoveryMaySpawnFresh === false, 'manifest forbids fresh-session substitution')
  h.assert(caseId, manifest.invariants.automaticPromptReplay === false, 'manifest forbids ambiguous automatic prompt replay')
  h.assert(caseId, manifest.invariants.stopIntentWins === true, 'manifest records stop-wins fencing')

  const forbiddenManagedPatterns = [
    /ManagedRecovery[\s\S]{0,300}SpawnFresh/,
    /schedule_recovery[\s\S]{0,300}create.*new.*soul/i,
  ]
  for (const pattern of forbiddenManagedPatterns) {
    h.assert(caseId, !pattern.test(`${managedRuntime}\n${wsResume}\n${restResume}`), `managed callers avoid forbidden legacy behavior ${pattern}`)
  }
  runFocusedRustTest(h, 'freshell-agent-runtime', 'checked_in_capability_manifest_matches_runtime_inventory')
}

async function launchMaterializedNativeSoul(
  h: RuntimeHarness,
  supervisor: SupervisorInstance,
  caseId: string,
  label: string,
): Promise<NativeSoul> {
  return launchNativeSoul(h, supervisor, caseId, label, true)
}

async function launchNativeSoul(
  h: RuntimeHarness,
  supervisor: SupervisorInstance,
  caseId: string,
  label: string,
  materialize: boolean,
): Promise<NativeSoul> {
  const epoch = await controlEpoch(h, supervisor)
  const soulId = newSoul()
  const launch = dataOf(await h.adminOk(supervisor, h.launchBody({
    soulId,
    fixture: 'native_session',
    provider: 'native-session-fixture',
    providerStoreId: `store-${label}-${randomUUID()}`,
    creationSeedRef: `seed-${label}-${randomUUID()}`,
    expectedControlEpoch: epoch,
  })), 'launch')
  const native: NativeSoul = {
    soulId,
    incarnationId: launch.view.incarnationId,
    containerId: launch.view.containerId,
    workerPid: launch.workerPid,
    view: launch.view,
  }
  h.assert(caseId, launch.workerLaunchCount === 1, `${label} starts one fixture provider writer`, launch)
  if (!materialize) return native
  const created = await h.nativeFixtureCall(supervisor, native.incarnationId, { method: 'create' })
  h.assert(caseId, created.ok === true && typeof created.sessionId === 'string', `${label} materializes an exact native identity`, created)
  native.sessionId = created.sessionId
  return native
}

async function captureResumeSpec(
  h: RuntimeHarness,
  supervisor: SupervisorInstance,
  native: NativeSoul,
  caseId: string,
): Promise<void> {
  const probe = dataOf(
    await h.adminOk(supervisor, h.probeRecoveryBody(native.soulId)),
    'recovery_probe',
  )
  h.assert(caseId, probe.kind === 'reattach_ready', 'live provider is reattachable while exact recovery evidence is captured', probe)
  const view = latestSoulView(await inventory(h, supervisor), native.soulId)
  h.assert(caseId, view?.nativeSessionId === native.sessionId, 'registry persists the provider-observed native identity before recovery', view)
  h.assert(caseId, ['resume_captured', 'checkpoint_captured'].includes(view?.durabilityState), 'registry records verified durable recovery evidence', view)
  h.assert(caseId, view?.allocationState === 'verified_durable', 'materialization is separate from allocation and reaches VERIFIED_DURABLE', view)
}

async function recoverExactOnce(
  h: RuntimeHarness,
  supervisor: SupervisorInstance,
  caseId: string,
  before: NativeSoul,
  trigger: 'provider_exit' | 'host_unreachable',
  expectedSessionId = before.sessionId,
): Promise<any> {
  const recovery = dataOf(
    await h.adminOk(supervisor, h.recoverBody(before.soulId, trigger)),
    'recovery',
  )
  h.assert(
    caseId,
    recovery.outcome === 'replaced' || recovery.outcome === 'reattached',
    `${trigger} converges to an exact live replacement`,
    recovery,
  )
  assertExactReplacementView(
    h,
    caseId,
    before,
    recovery.view,
    expectedSessionId,
    before.incarnationId,
  )
  if (recovery.outcome === 'replaced') {
    h.assert(
      caseId,
      recovery.priorIncarnationId === before.incarnationId,
      'caller-driven recovery records its immediate old/new incarnation lineage',
      recovery,
    )
    h.assert(
      caseId,
      recovery.expectedNativeSessionId === expectedSessionId
        && recovery.observedNativeSessionId === expectedSessionId,
      'caller-driven recovery verifies the exact provider-native identity',
      recovery,
    )
  } else {
    h.assert(
      caseId,
      recovery.view.priorIncarnationId === before.incarnationId,
      'observer recovery ran exactly once before the delayed caller reattached',
      recovery,
    )
  }
  return recovery
}

function assertExactReplacement(
  h: RuntimeHarness,
  caseId: string,
  before: NativeSoul,
  recovery: any,
  expectedSessionId = before.sessionId,
  expectedPriorIncarnationId = before.incarnationId,
): void {
  h.assert(caseId, recovery.outcome === 'replaced', 'failed incarnation is replaced through the recovery transaction', recovery)
  assertExactReplacementView(
    h,
    caseId,
    before,
    recovery.view,
    expectedSessionId,
    expectedPriorIncarnationId,
  )
  h.assert(
    caseId,
    recovery.priorIncarnationId === expectedPriorIncarnationId,
    'recovery response records its immediate old/new incarnation lineage',
    recovery,
  )
  h.assert(caseId, recovery.expectedNativeSessionId === expectedSessionId, 'replacement resumes the recorded native identity', recovery)
  h.assert(caseId, recovery.observedNativeSessionId === expectedSessionId, 'replacement verifies the provider-returned native identity', recovery)
}

function assertExactReplacementView(
  h: RuntimeHarness,
  caseId: string,
  before: NativeSoul,
  view: any,
  expectedSessionId = before.sessionId,
  expectedPriorIncarnationId = before.incarnationId,
): void {
  h.assert(caseId, view?.soulId === before.soulId, 'replacement keeps the same soul', view)
  h.assert(caseId, view?.incarnationId !== before.incarnationId, 'replacement receives a new incarnation', view)
  h.assert(caseId, view?.launchState === 'running' && view?.recoveryState === 'live', 'replacement is live and running', view)
  h.assert(
    caseId,
    view?.priorIncarnationId === expectedPriorIncarnationId,
    'replacement view records its immediate old/new incarnation lineage',
    view,
  )
  h.assert(caseId, view?.nativeSessionId === expectedSessionId, 'committed binding remains the exact native conversation', view)
}

async function controlEpoch(h: RuntimeHarness, supervisor: SupervisorInstance): Promise<number> {
  const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
  return numericField(health, 'controlEpoch', 'control_epoch')
}

async function inventory(h: RuntimeHarness, supervisor: SupervisorInstance): Promise<any[]> {
  return dataOf(await h.adminOk(supervisor, h.inventoryBody()), 'inventory')
}

function latestSoulView(views: any[], soulId: string): any | undefined {
  return views.filter((view) => view.soulId === soulId).at(-1)
}

function assertSingleRunningWriter(h: RuntimeHarness, caseId: string, views: any[], soulId: string): void {
  const running = views.filter((view) => view.soulId === soulId && view.launchState === 'running')
  h.assert(caseId, running.length === 1, `soul ${soulId} has exactly one running writer`, running)
}

function nativeFixtureWorkerAlive(h: RuntimeHarness, containerId: string, pid: number): boolean {
  try {
    h.execOwnedContainerExact(containerId, [
      'sh', '-lc',
      `test -r /proc/${pid}/cmdline && tr '\0' ' ' < /proc/${pid}/cmdline | grep -Fq -- 'worker --fixture native_session'`,
    ])
    return true
  } catch {
    return false
  }
}

function restoreProviderVolume(h: RuntimeHarness, volumeName: string, state: string): void {
  const encoded = Buffer.from(state, 'utf8').toString('base64')
  h.runCommand('docker', [
    'run', '--rm', '--network', 'none',
    '-v', `${volumeName}:/provider:rw`,
    h.imageRef,
    'sh', '-lc',
    `printf %s '${encoded}' | base64 -d > /provider/native-session-state.json`,
  ])
}

function runFocusedRustTest(h: RuntimeHarness, packageName: string, filter: string): void {
  const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
  const output = h.runCommand(mise, [
    'exec', 'rust@1.96', '--', 'cargo', 'test', '-p', packageName, filter, '--', '--nocapture',
  ])
  if (!/test result: ok\. [1-9]\d* passed;/.test(output)) {
    throw new Error(`focused Rust test ${packageName}:${filter} ran no matching test or did not report success\n${output}`)
  }
}

function readCapabilityManifest(h: RuntimeHarness): any {
  return JSON.parse(fs.readFileSync(
    path.join(h.repoRoot, 'docs/development/runtime-provider-capabilities.json'),
    'utf8',
  ))
}

function dataOf(result: any, expectedKind: string): any {
  if (!result || result.kind !== expectedKind) {
    throw new Error(`expected admin result kind ${expectedKind}, received ${JSON.stringify(result)}`)
  }
  return result.data
}

function numericField(value: any, ...names: string[]): number {
  for (const name of names) {
    if (typeof value?.[name] === 'number') return value[name]
  }
  return 0
}

function shellRegexEscape(value: string): string {
  return value.replace(/[\\/.*+?[^\]$(){}=!<>|:-]/g, '\\$&')
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`)
}
