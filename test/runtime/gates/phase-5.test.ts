import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  newRequest,
  newSoul,
  RuntimeGateBlockedError,
  RuntimeHarness,
  type SupervisorInstance,
} from '../../../scripts/testing/runtime-sandbox.js'
import {
  SOAK_MAX_RUNTIME_LOG_BYTES,
  SOAK_MAX_TERMINAL_SPOOL_BYTES,
} from '../../../scripts/testing/runtime-soak-evidence.js'
import { validateFreshAgentIngressInventory } from '../../../scripts/testing/fresh-agent-ingress-inventory.js'

export const PHASE5_CASE_IDS = [
  'P5-G01', 'P5-G02', 'P5-G03', 'P5-G04', 'P5-G05', 'P5-G06',
  'P5-G07', 'P5-G08', 'P5-G09', 'P5-G11', 'P5-G12',
] as const

type Blocked = { caseId: string; message: string; evidence?: unknown }
export type Phase5RunResult = { executed: string[]; blocked: Blocked[] }

type NativeSoul = {
  soulId: string
  sessionId?: string
  incarnationId: string
  containerId: string
  workerPid: number
  view: any
}

export async function runPhase5Gate(
  h: RuntimeHarness,
  onCasePassed: (caseId: string) => void = () => {},
  only?: ReadonlySet<string>,
): Promise<Phase5RunResult> {
  validateFreshAgentIngressInventory(h.repoRoot)
  const executed: string[] = []
  const blocked: Blocked[] = []
  const cases = [
    ['P5-G01', gate01RecoverableProvidersAreNotLoss],
    ['P5-G02', gate02GenuineLossCertificateAndCleanup],
    ['P5-G03', gate03EveryRecoverableAlternativeWins],
    ['P5-G04', gate04UnknownAndTransientEvidenceBlocks],
    ['P5-G05', gate05ForeignObjectsAreNeverCleanupTargets],
    ['P5-G06', gate06CleanupAndExportFailuresStayHonest],
    ['P5-G07', gate07CrashMatrixIsIdempotent],
    ['P5-G08', gate08RedactionRotationAndForensics],
    ['P5-G09', gate09RestartAndFailureStorm],
    ['P5-G11', gate11MigrationBackupAndRollback],
    ['P5-G12', gate12ReleaseAndFullMatrix],
  ] as const

  for (const [caseId, run] of cases) {
    if (only && !only.has(caseId)) continue
    h.recordLifecycle('gate.case.started', { caseId })
    try {
      await run(h)
      executed.push(caseId)
      onCasePassed(caseId)
      h.recordLifecycle('gate.case.passed', { caseId })
    } catch (error) {
      if (error instanceof RuntimeGateBlockedError) {
        const row = { caseId, message: error.message, evidence: error.evidence }
        blocked.push(row)
        h.writeIncident(`${caseId}-blocked`, row)
        h.recordLifecycle('gate.case.blocked', row)
        continue
      }
      h.writeIncident(`${caseId}-failure`, {
        error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error),
      })
      h.recordLifecycle('gate.case.failed', { caseId, error: String(error) })
      throw error
    }
  }
  validatePhase5Coverage(PHASE5_CASE_IDS.filter(id => !only || only.has(id)), executed, blocked.map((row) => row.caseId))
  return { executed, blocked }
}

export function validatePhase5Coverage(
  required: readonly string[],
  executed: readonly string[],
  blocked: readonly string[],
): void {
  const all = [...executed, ...blocked]
  const accounted = new Set(all)
  const missing = required.filter((id) => !accounted.has(id))
  const duplicate = all.filter((id, index) => all.indexOf(id) !== index)
  const extra = [...accounted].filter((id) => !required.includes(id))
  if (missing.length || duplicate.length || extra.length) {
    throw new Error(`phase5 accounting incomplete: missing=[${missing}] duplicate=[${duplicate}] extra=[${extra}]`)
  }
}

async function gate01RecoverableProvidersAreNotLoss(h: RuntimeHarness): Promise<void> {
  const caseId = 'P5-G01'
  const supervisor = await h.startSupervisor({ scenarioId: unique('p5-g01') })
  await enableManagedOptIn(h, supervisor)
  const soul = await launchNativeSoul(h, supervisor, caseId, 'recoverable', true)
  await h.nativeFixtureCall(supervisor, soul.incarnationId, {
    method: 'remember', key: 'p5_g01', value: 'state-preserved',
  })
  await captureResume(h, supervisor, soul, caseId)
  h.killOwnedRuntimeExact(soul.containerId)
  const result = dataOf(await h.adminOk(
    supervisor,
    h.recoverBody(soul.soulId, 'host_unreachable', await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'recovery')
  h.assert(caseId, result.outcome === 'replaced', 'preserved native state replaces the unusable old runtime', result)
  h.assert(caseId, result.outcome !== 'lost' && !result.incidentId, 'recoverable provider is never classified lost', result)
  h.assert(caseId, result.view.nativeSessionId === soul.sessionId, 'native session identity survives recovery', result.view)
  h.assert(caseId, !h.isContainerRunning(soul.containerId), 'old exact enclosure is empty before replacement remains active')
  const recalled = await h.nativeFixtureCall(supervisor, result.view.incarnationId, {
    method: 'recall', key: 'p5_g01',
  })
  h.assert(caseId, recalled.value === 'state-preserved', 'follow-up reads state from the recovered conversation', recalled)
  h.assert(caseId, (await pendingNotices(h, supervisor)).length === 0, 'successful native recovery emits no lost notice')

}

async function gate02GenuineLossCertificateAndCleanup(h: RuntimeHarness): Promise<void> {
  const caseId = 'P5-G02'
  const supervisor = await h.startSupervisor({ scenarioId: unique('p5-g02') })
  await enableManagedOptIn(h, supervisor)
  const soul = await launchNativeSoul(h, supervisor, caseId, 'genuine-loss', true)
  await h.nativeFixtureCall(supervisor, soul.incarnationId, {
    method: 'remember', key: 'diagnostic_marker', value: 'non-secret-diagnostic',
  })
  await captureResume(h, supervisor, soul, caseId)
  const beforeIncarnations = (await inventorySnapshot(h, supervisor)).souls
    .filter((row: any) => row.soulId === soul.soulId).length
  removeEveryFixtureRecoveryCopy(h, soul)
  const recovery = dataOf(await h.adminOk(
    supervisor,
    h.recoverBody(soul.soulId, 'provider_exit', await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'recovery')
  h.assert(caseId, recovery.outcome === 'lost' && typeof recovery.incidentId === 'string', 'loss appears only after all registered paths are definitive negatives', recovery)
  h.assert(caseId, recovery.view.recoveryState === 'lost' && recovery.view.desiredState === 'stopped', 'loss and stop intent commit atomically', recovery.view)
  h.assert(caseId, recovery.view.cleanupState === 'verified_empty', 'the exact owned enclosure is positively empty', recovery.view)
  h.assert(caseId, recovery.view.nativeSessionId === soul.sessionId, 'ended view retains the former native identity for history', recovery.view)
  h.assert(caseId, recovery.view.incidentId === recovery.incidentId, 'ended view links the durable incident', recovery.view)
  h.assert(caseId, !h.isContainerRunning(soul.containerId), 'only the recorded enclosure was reaped')
  const afterIncarnations = (await inventorySnapshot(h, supervisor)).souls
    .filter((row: any) => row.soulId === soul.soulId).length
  h.assert(caseId, afterIncarnations === beforeIncarnations, 'genuine loss never creates a blank replacement incarnation', { beforeIncarnations, afterIncarnations })

  const incident = await incidentSummary(h, supervisor, recovery.incidentId)
  h.assert(caseId, incident.state === 'closed' && incident.cleanup.verifiedEmpty === true, 'incident persists complete cleanup evidence', incident)
  h.assert(caseId, incident.cleanup.foreignObjectsTouched === 0, 'incident explicitly records zero foreign objects touched', incident)
  h.assert(caseId, /all_applicable_recovery_paths/.test(incident.reasonCode), 'incident records the complete decision reason', incident)
  const notices = await pendingNotices(h, supervisor)
  h.assert(caseId, notices.length === 1 && notices[0].incidentIds.includes(recovery.incidentId), 'exactly one durable brief notice references the incident', notices)
  h.assert(caseId, notices[0].message.includes('Reference:'), 'notice is brief and includes an operator reference', notices[0])
  const metrics = await metricsSnapshot(h, supervisor)
  h.assert(caseId, counter(metrics, 'recovery_outcome', 'lost') === 1, 'loss metric increments once', metrics)
  h.assert(caseId, counter(metrics, 'cleanup_outcome', 'verified_empty') === 1, 'verified cleanup metric increments once', metrics)
  h.writeArtifact('runtime-metrics.json', { caseId, metrics })
  const incidentFiles = listIncidentFiles(h, supervisor, recovery.incidentId)
  h.assert(caseId, incidentFiles.some((file) => file.endsWith('.closed.json')), 'redacted closed incident artifact survives cleanup', incidentFiles)

}

async function gate03EveryRecoverableAlternativeWins(h: RuntimeHarness): Promise<void> {
  const caseId = 'P5-G03'
  const supervisor = await h.startSupervisor({ scenarioId: unique('p5-g03') })
  await enableManagedOptIn(h, supervisor)

  const live = await launchNativeSoul(h, supervisor, caseId, 'live-last-copy', true)
  await captureResume(h, supervisor, live, caseId)
  h.execOwnedContainerExact(live.containerId, ['rm', '-f', '/home/freshell/provider/native-session-state.json'])
  const reattached = dataOf(await h.adminOk(
    supervisor,
    h.recoverBody(live.soulId, 'provider_exit', await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'recovery')
  h.assert(caseId, reattached.outcome === 'reattached' && reattached.view.incarnationId === live.incarnationId, 'healthy last-copy host wins over missing disk state', reattached)
  h.assert(caseId, h.isContainerRunning(live.containerId), 'live last-copy host is not destroyed for a missing checkpoint')

  const checkpoint = await launchNativeSoul(h, supervisor, caseId, 'checkpoint', true)
  await h.nativeFixtureCall(supervisor, checkpoint.incarnationId, {
    method: 'remember', key: 'checkpoint_marker', value: 'older-copy',
  })
  const checkpointResult = await h.nativeFixtureCall(supervisor, checkpoint.incarnationId, { method: 'checkpoint' })
  h.assert(caseId, checkpointResult.ok === true, 'fixture produces a verified provider-compatible checkpoint', checkpointResult)
  await captureResume(h, supervisor, checkpoint, caseId)
  h.execOwnedContainerExact(checkpoint.containerId, ['rm', '-f', '/home/freshell/provider/native-session-state.json'])
  h.killOwnedRuntimeExact(checkpoint.containerId)
  const restored = dataOf(await h.adminOk(
    supervisor,
    h.recoverBody(checkpoint.soulId, 'provider_exit', await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'recovery')
  h.assert(caseId, restored.outcome === 'replaced' && restored.probe?.kind === 'resume_ready', 'verified older checkpoint restores instead of loss', restored)
  h.assert(caseId, restored.view.nativeSessionId === checkpoint.sessionId, 'checkpoint restore retains exact identity', restored.view)
  const recall = await h.nativeFixtureCall(supervisor, restored.view.incarnationId, { method: 'recall', key: 'checkpoint_marker' })
  h.assert(caseId, recall.value === 'older-copy', 'checkpoint restoration preserves conversation state', recall)

  const pristine = await launchNativeSoul(h, supervisor, caseId, 'pristine', false)
  h.killOwnedRuntimeExact(pristine.containerId)
  const reseeded = dataOf(await h.adminOk(
    supervisor,
    h.recoverBody(pristine.soulId, 'provider_exit', await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'recovery')
  h.assert(caseId, reseeded.outcome === 'replaced' && reseeded.probe?.kind === 'pristine_seed_ready', 'proven never-dispatched seed wins over loss', reseeded)
  h.assert(caseId, reseeded.view.soulId === pristine.soulId, 'pristine recovery keeps the logical soul')
  h.assert(caseId, (await pendingNotices(h, supervisor)).length === 0, 'all recoverable alternatives emit zero loss notices')
}

async function gate04UnknownAndTransientEvidenceBlocks(h: RuntimeHarness): Promise<void> {
  const caseId = 'P5-G04'
  const supervisor = await h.startSupervisor({ scenarioId: unique('p5-g04') })
  await enableManagedOptIn(h, supervisor)
  const soul = await launchNativeSoul(h, supervisor, caseId, 'unreadable', true)
  await captureResume(h, supervisor, soul, caseId)
  h.execOwnedContainerExact(soul.containerId, ['chmod', '000', '/home/freshell/provider/native-session-state.json'])
  h.killOwnedRuntimePidExact(soul.containerId, soul.workerPid, ['worker', '--fixture', 'native_session'])
  const blocked = dataOf(await h.adminOk(
    supervisor,
    h.recoverBody(soul.soulId, 'provider_exit', await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'recovery')
  h.assert(caseId, blocked.outcome === 'blocked' && blocked.outcome !== 'lost', 'unreadable provider state blocks rather than certifying loss', blocked)
  h.assert(caseId, !blocked.incidentId, 'blocked recovery has no loss incident')
  h.assert(caseId, h.isContainerRunning(soul.containerId), 'unknown evidence does not authorize cleanup')
  h.execOwnedContainerExact(soul.containerId, ['chmod', '600', '/home/freshell/provider/native-session-state.json'])
  const repaired = dataOf(await h.adminOk(
    supervisor,
    h.recoverBody(soul.soulId, 'manual_retry', await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'recovery')
  h.assert(caseId, ['replaced', 'reattached'].includes(repaired.outcome), 'repair restores the same soul', repaired)
  h.assert(caseId, repaired.view.nativeSessionId === soul.sessionId, 'repair preserves native identity', repaired.view)
  h.assert(caseId, (await pendingNotices(h, supervisor)).length === 0, 'transient blockers emit no loss notice')
  runRust(h, 'freshell-supervisor', 'unknown_or_unreadable_path_can_never_construct_loss')
  runRust(h, 'freshell-agent-runtime', 'transient_failures_map_to_blocked_reasons')
  runRust(h, 'freshell-runtime-protocol', 'frame_rejects_oversized_payload_before_allocation')
}

async function gate05ForeignObjectsAreNeverCleanupTargets(h: RuntimeHarness): Promise<void> {
  const caseId = 'P5-G05'
  const scenarioId = unique('p5-g05')
  const supervisor = await h.startSupervisor({ scenarioId })
  await enableManagedOptIn(h, supervisor)
  const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
  const foreign = h.createForeignSentinel({
    scenarioId,
    installationId: health.installationId,
  })
  const soul = await launchNativeSoul(h, supervisor, caseId, 'foreign-guard', true)
  await captureResume(h, supervisor, soul, caseId)
  removeEveryFixtureRecoveryCopy(h, soul)
  const result = dataOf(await h.adminOk(
    supervisor,
    h.recoverBody(soul.soulId, 'provider_exit', await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'recovery')
  h.assert(caseId, result.outcome === 'lost', 'genuine owned loss still completes in the presence of a matching foreign sentinel', result)
  h.assert(caseId, h.isContainerRunning(foreign), 'foreign sentinel remains running after loss cleanup')
  h.assert(caseId, h.brokerEventsFor(foreign).length === 0, 'restricted broker observed no destructive request for the foreign sentinel', h.brokerEventsFor(foreign))
  const incident = await incidentSummary(h, supervisor, result.incidentId)
  h.assert(caseId, incident.cleanup.foreignObjectsTouched === 0, 'incident records zero foreign objects touched', incident)
  const unsafe = h.broker.unsafeAttempts()
  h.assert(caseId, unsafe.length === 0, 'no partial ID, label, environment tag, or daemon mismatch cleanup authority was attempted', unsafe)
  runRust(h, 'freshell-supervisor', 'unknown_or_unreadable_path_can_never_construct_loss')
}

async function gate06CleanupAndExportFailuresStayHonest(h: RuntimeHarness): Promise<void> {
  const caseId = 'P5-G06'
  const scenarioId = unique('p5-g06')
  let supervisor = await h.startSupervisor({
    scenarioId,
    env: {
      FRESHELL_RUNTIME_LOSS_CLEANUP_FAILPOINT: 'termination_unconfirmed',
      FRESHELL_RUNTIME_INCIDENT_EXPORT_FAIL: '1',
    },
  })
  await enableManagedOptIn(h, supervisor)
  const soul = await launchNativeSoul(h, supervisor, caseId, 'cleanup-failure', true)
  await captureResume(h, supervisor, soul, caseId)
  removeEveryFixtureRecoveryCopy(h, soul)
  const firstReply = await h.adminRaw(
    supervisor,
    h.recoverBody(soul.soulId, 'provider_exit', await epoch(h, supervisor)),
    { requestId: newRequest() },
  )
  h.assert(caseId, firstReply.result?.Ok?.kind === 'recovery', 'secondary export failure does not veto the durable cleanup attempt', firstReply)
  const pendingView = latestSoul((await inventorySnapshot(h, supervisor)).souls, soul.soulId)
  const incidentId = pendingView?.incidentId
  h.assert(caseId, typeof incidentId === 'string' && incidentId.startsWith('incident-'), 'durable registry exposes the exact pending incident identity after export failure', pendingView)
  h.assert(caseId, pendingView.cleanupState === 'termination_unconfirmed', 'cleanup failure remains independently visible despite export failure', pendingView)
  h.assert(caseId, h.isContainerRunning(soul.containerId), 'injected backend failure leaves the owned enclosure running')
  const pendingIncident = await incidentSummary(h, supervisor, incidentId)
  h.assert(caseId, pendingIncident.state === 'cleanup_failed' && !pendingIncident.cleanup.verifiedEmpty, 'database retains truthful cleanup failure while secondary export is pending', pendingIncident)
  h.assert(caseId, (await pendingNotices(h, supervisor)).every((notice: any) => notice.kind === 'cleanup_failed'), 'export failure never suppresses a truthful failure notice or fabricates success')
  const pendingExportBefore = listIncidentFiles(h, supervisor, incidentId)
  h.assert(caseId, pendingExportBefore.length === 0, 'injected export failure leaves filesystem artifact pending rather than fabricating one', pendingExportBefore)

  h.stopSupervisorExact(supervisor)
  h.removeContainerExact(supervisor.containerId)
  supervisor = await h.startSupervisor({
    scenarioId,
    volumeName: supervisor.volumeName,
    reuseSecret: true,
    env: { FRESHELL_RUNTIME_LOSS_CLEANUP_FAILPOINT: 'termination_unconfirmed' },
  })
  const failedIncident = await waitFor(async () => {
    const summary = await incidentSummary(h, supervisor, incidentId)
    return summary.state === 'cleanup_failed' ? summary : null
  }, 30_000)
  h.assert(caseId, failedIncident.state === 'cleanup_failed' && !failedIncident.cleanup.verifiedEmpty, 'incident truthfully records cleanup failure', failedIncident)
  const firstNotices = await pendingNotices(h, supervisor)
  h.assert(caseId, firstNotices.length === 1 && firstNotices[0].kind === 'cleanup_failed', 'only a cleanup-failed notice is deliverable before verification', firstNotices)
  h.assert(caseId, !firstNotices[0].message.includes('cleaned up'), 'failure notice never says cleanup succeeded', firstNotices[0])
  h.assert(caseId, h.isContainerRunning(soul.containerId), 'injected cleanup failure never claims a running enclosure was removed')

  h.stopSupervisorExact(supervisor)
  h.removeContainerExact(supervisor.containerId)
  supervisor = await h.startSupervisor({
    scenarioId,
    volumeName: supervisor.volumeName,
    reuseSecret: true,
  })
  const finalIncident = await waitFor(async () => {
    const summary = await incidentSummary(h, supervisor, incidentId)
    return summary.state === 'closed' ? summary : null
  }, 30_000)
  h.assert(caseId, finalIncident.cleanup.verifiedEmpty === true, 'startup resumes exact pending cleanup and positively verifies emptiness', finalIncident)
  h.assert(caseId, !h.isContainerRunning(soul.containerId), 'eventual cleanup removes only the exact prior enclosure')
  const notices = await pendingNotices(h, supervisor)
  h.assert(caseId, notices.length === 1 && notices[0].kind === 'cleanup_succeeded', 'verified retry supersedes the temporary failure notice with one final success', notices)
  const exported = listIncidentFiles(h, supervisor, incidentId)
  h.assert(caseId, exported.some((file) => file.endsWith('.closed.json')), 'pending incident export is retried successfully after restart', exported)
  h.assert(caseId, h.broker.unsafeAttempts().length === 0, 'cleanup/export failures never broaden kill authority')
}

async function gate07CrashMatrixIsIdempotent(h: RuntimeHarness): Promise<void> {
  const caseId = 'P5-G07'
  for (const crashPoint of [
    'after_loss_incident_commit',
    'after_loss_cleanup_before_finalize',
    'after_loss_finalize_before_export',
  ]) {
    const scenarioId = unique(`p5-g07-${crashPoint}`)
    // The failpoint is dormant during launch/capture and fires only when the
    // genuine-loss transaction reaches its named boundary. Avoid a controller
    // replacement during setup: that would change liveness-evidence timing and
    // test startup probing instead of crash consistency.
    let supervisor = await h.startSupervisor({ scenarioId, crashPoint })
    await enableManagedOptIn(h, supervisor)
    const soul = await launchNativeSoul(h, supervisor, caseId, crashPoint, true)
    await captureResume(h, supervisor, soul, caseId)
    removeEveryFixtureRecoveryCopy(h, soul)
    try {
      await h.adminOk(
        supervisor,
        h.recoverBody(soul.soulId, 'provider_exit', await epoch(h, supervisor)),
        { requestId: newRequest() },
      )
    } catch {
      // Named failpoint intentionally terminates the exact test controller.
    }
    await h.waitForContainerExit(supervisor.containerId, 15_000)
    h.removeContainerExact(supervisor.containerId)
    supervisor = await h.startSupervisor({
      scenarioId,
      volumeName: supervisor.volumeName,
      reuseSecret: true,
    })
    const snapshot = await waitFor(async () => {
      const value = await inventorySnapshot(h, supervisor)
      const row = latestSoul(value.souls, soul.soulId)
      return row?.recoveryState === 'lost' && row?.cleanupState === 'verified_empty'
        ? value
        : null
    }, 30_000)
    const row = latestSoul(snapshot.souls, soul.soulId)
    h.assert(caseId, typeof row.incidentId === 'string', `${crashPoint} leaves a durable incident link`, row)
    const incident = await incidentSummary(h, supervisor, row.incidentId)
    h.assert(caseId, incident.state === 'closed' && incident.cleanup.verifiedEmpty, `${crashPoint} converges to one closed incident`, incident)
    const notices = await pendingNotices(h, supervisor)
    h.assert(caseId, notices.filter((notice: any) => notice.incidentIds.includes(row.incidentId)).length === 1, `${crashPoint} queues one deliverable notice`, notices)
    const metrics = await metricsSnapshot(h, supervisor)
    h.assert(caseId, counter(metrics, 'recovery_outcome', 'lost') === 1, `${crashPoint} increments loss metric exactly once`, metrics)
    h.assert(caseId, snapshot.souls.filter((candidate: any) => candidate.soulId === soul.soulId).length === 1, `${crashPoint} never mints a replacement incarnation`, snapshot.souls)
  }
  h.runFocusedVitest('test/unit/client/components/ManagedRuntimeNotices.test.tsx')
}

async function gate08RedactionRotationAndForensics(h: RuntimeHarness): Promise<void> {
  const caseId = 'P5-G08'
  runRust(h, 'freshell-runtime-observability', 'scrub_removes_exact_and_schema_named_secrets')
  runRust(h, 'freshell-runtime-observability', 'rotation_and_atomic_documents_are_private_and_bounded')
  runRust(h, 'freshell-supervisor', 'incident_export_redacts_and_never_evicts_open_reports')

  const supervisor = await h.startSupervisor({ scenarioId: unique('p5-g08') })
  await enableManagedOptIn(h, supervisor)
  const soul = await launchNativeSoul(h, supervisor, caseId, 'forensics', true)
  await captureResume(h, supervisor, soul, caseId)
  removeEveryFixtureRecoveryCopy(h, soul)
  const result = dataOf(await h.adminOk(
    supervisor,
    h.recoverBody(soul.soulId, 'provider_exit', await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'recovery')
  const files = listIncidentFiles(h, supervisor, result.incidentId)
  h.assert(caseId, files.length >= 1, 'loss leaves a reconstructable redacted artifact after cleanup', files)
  const incidentRoot = path.join('/var/lib/freshell-supervisor', 'incidents')
  const artifactName = files.includes(`${result.incidentId}.closed.json`)
    ? `${result.incidentId}.closed.json`
    : `${result.incidentId}.open.json`
  const artifact = h.runCommand('docker', [
    'exec', supervisor.containerId, 'cat', path.join(incidentRoot, artifactName),
  ])
  for (const field of ['observedCause', 'recoveryPaths', 'cleanupTarget', 'cleanup']) {
    h.assert(caseId, artifact.includes(`"${field}"`), `incident artifact retains observed ${field}`, artifact)
  }
  const report = JSON.parse(artifact)
  const analysis = (report.certificate ?? report).analysis
  h.assert(caseId, analysis.observedCause === 'all_applicable_recovery_paths_definitively_unavailable'
    && !analysis.regressionCase && !(analysis.hypotheses?.length),
  'loss records actual observations without manufacturing a postmortem or regression claim', analysis)
  const syntheticSecret = supervisor.controlSecret
  const allEvidence = collectTextFiles(h.evidenceDir)
  h.assert(caseId, !allEvidence.includes(syntheticSecret), 'runtime evidence is redacted from the first persistent byte')
  h.assert(caseId, !artifact.includes(syntheticSecret), 'incident artifact contains no control secret')
}

async function gate09RestartAndFailureStorm(h: RuntimeHarness): Promise<void> {
  const caseId = 'P5-G09'
  const scenarioId = unique('p5-g09')
  let supervisor = await h.startSupervisor({ scenarioId })
  await enableManagedOptIn(h, supervisor)
  const souls: NativeSoul[] = []
  for (let index = 0; index < 3; index += 1) {
    const soul = await launchNativeSoul(h, supervisor, caseId, `storm-${index}`, true)
    await captureResume(h, supervisor, soul, caseId)
    souls.push(soul)
  }
  for (let cycle = 1; cycle <= 20; cycle += 1) {
    h.stopSupervisorExact(supervisor)
    h.removeContainerExact(supervisor.containerId)
    supervisor = await h.startSupervisor({
      scenarioId,
      volumeName: supervisor.volumeName,
      reuseSecret: true,
    })
    const snapshot = await inventorySnapshot(h, supervisor)
    for (const soul of souls) {
      assertOneWriter(h, caseId, snapshot.souls, soul.soulId)
      h.assert(caseId, latestSoul(snapshot.souls, soul.soulId)?.nativeSessionId === soul.sessionId, `supervisor restart ${cycle} preserves ${soul.soulId}`, snapshot.souls)
    }
  }
  for (let cycle = 0; cycle < 100; cycle += 1) {
    const soul = souls[cycle % souls.length]
    const recovery = dataOf(await h.adminOk(
      supervisor,
      h.recoverBody(soul.soulId, 'explicit_request', await epoch(h, supervisor)),
      { requestId: newRequest() },
    ), 'recovery')
    h.assert(caseId, recovery.outcome === 'reattached', `failure/reconnect cycle ${cycle + 1} reattaches without replacement`, recovery)
  }
  h.assert(caseId, (await pendingNotices(h, supervisor)).length === 0, 'restart/failure storm produces no false loss notice')
}

async function gate11MigrationBackupAndRollback(h: RuntimeHarness): Promise<void> {
  const caseId = 'P5-G11'
  const scenarioId = unique('p5-g11')
  const legacyFile = path.join(h.testRoot, 'legacy-metadata.jsonl')
  fs.writeFileSync(legacyFile, '{"session":"legacy-one"}\n{"session":"legacy-two"}\n')
  const beforeLegacy = fs.readFileSync(legacyFile)
  const backupDir = path.join(h.testRoot, 'registry-backups')
  let supervisor = await h.startSupervisor({ scenarioId })
  const dryRun = dataOf(await h.adminOk(
    supervisor,
    h.migrationPlanBody({
      requestedMode: 'managed-default',
      apply: false,
      backupPath: backupDir,
      legacyMetadataPath: legacyFile,
      expectedControlEpoch: await epoch(h, supervisor),
    }),
    { requestId: newRequest() },
  ), 'migration_plan')
  h.assert(caseId, dryRun.dryRun === true && dryRun.legacyMetadataCount === 2, 'migration dry-run inventories legacy metadata without mutation', dryRun)
  h.assert(caseId, Buffer.compare(beforeLegacy, fs.readFileSync(legacyFile)) === 0, 'legacy metadata remains byte-identical after dry-run')

  const optIn = dataOf(await h.adminOk(
    supervisor,
    h.migrationPlanBody({
      requestedMode: 'managed-opt-in',
      apply: true,
      legacyMetadataPath: legacyFile,
      expectedControlEpoch: await epoch(h, supervisor),
    }),
    { requestId: newRequest() },
  ), 'migration_plan')
  h.assert(caseId, optIn.currentMode === 'managed-opt-in' && optIn.blockers.length === 0, 'managed opt-in applies without disturbing legacy metadata', optIn)
  const soul = await launchNativeSoul(h, supervisor, caseId, 'rollout-soul', true)
  await captureResume(h, supervisor, soul, caseId)
  const beforeManagedDefault = await inventorySnapshot(h, supervisor)
  const managedDefault = dataOf(await h.adminOk(
    supervisor,
    h.migrationPlanBody({
      requestedMode: 'managed-default',
      apply: true,
      backupPath: backupDir,
      legacyMetadataPath: legacyFile,
      expectedControlEpoch: await epoch(h, supervisor),
    }),
    { requestId: newRequest() },
  ), 'migration_plan')
  h.assert(caseId, managedDefault.currentMode === 'managed-default' && managedDefault.registryBackupVerified === true, 'managed-default requires and verifies a consistent registry backup', managedDefault)
  h.assert(caseId, fs.existsSync(managedDefault.registryBackupPath), 'verified registry backup exists at the explicit path', managedDefault)
  const backupStat = fs.lstatSync(managedDefault.registryBackupPath)
  const backupSha256 = createHash('sha256').update(fs.readFileSync(managedDefault.registryBackupPath)).digest('hex')
  const backupDb = new DatabaseSync(managedDefault.registryBackupPath, { readOnly: true })
  const backupSchema = (backupDb.prepare('SELECT schema_version AS version FROM installation WHERE singleton=1').get() as { version: number }).version
  const backupIntegrity = (backupDb.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check
  backupDb.close()
  h.assert(caseId, backupStat.isFile() && !backupStat.isSymbolicLink() && (backupStat.mode & 0o077) === 0, 'registry backup is a private regular file', { mode: backupStat.mode & 0o777 })
  h.assert(caseId, managedDefault.registryBackupSha256 === backupSha256, 'migration receipt binds the exact verified backup digest', { expected: managedDefault.registryBackupSha256, actual: backupSha256 })
  h.assert(caseId, backupIntegrity === 'ok' && managedDefault.registryBackupSchemaVersion === backupSchema, 'migration verifies the exact supported registry schema before apply', { backupIntegrity, backupSchema, planSchema: managedDefault.registryBackupSchemaVersion })
  const afterManagedDefault = await inventorySnapshot(h, supervisor)
  h.assert(caseId, JSON.stringify(afterManagedDefault.souls) === JSON.stringify(beforeManagedDefault.souls), 'managed-default apply preserves exact soul/intent data', { before: beforeManagedDefault.souls, after: afterManagedDefault.souls })
  h.assert(caseId, JSON.stringify(afterManagedDefault.viewIntents) === JSON.stringify(beforeManagedDefault.viewIntents), 'managed-default apply preserves exact view data', { before: beforeManagedDefault.viewIntents, after: afterManagedDefault.viewIntents })
  h.assert(caseId, Buffer.compare(beforeLegacy, fs.readFileSync(legacyFile)) === 0, 'apply remains read-only toward legacy metadata')

  const foreign = h.createForeignSentinel({ scenarioId })
  const rollback = dataOf(await h.adminOk(
    supervisor,
    h.migrationPlanBody({
      requestedMode: 'legacy',
      apply: true,
      expectedControlEpoch: await epoch(h, supervisor),
    }),
    { requestId: newRequest() },
  ), 'migration_plan')
  h.assert(caseId, rollback.currentMode === 'legacy', 'rollback changes only routing policy', rollback)
  h.assert(caseId, h.isContainerRunning(soul.containerId), 'rollback does not mass-stop an existing managed soul')
  h.assert(caseId, h.isContainerRunning(foreign), 'rollback leaves unrelated runtime sentinel untouched')
  const snapshot = await inventorySnapshot(h, supervisor)
  h.assert(caseId, JSON.stringify(snapshot.souls) === JSON.stringify(beforeManagedDefault.souls), 'rollback restores exact soul/intent data', { before: beforeManagedDefault.souls, after: snapshot.souls })
  h.assert(caseId, JSON.stringify(snapshot.viewIntents) === JSON.stringify(beforeManagedDefault.viewIntents), 'rollback restores exact view data', { before: beforeManagedDefault.viewIntents, after: snapshot.viewIntents })
  h.assert(caseId, latestSoul(snapshot.souls, soul.soulId)?.nativeSessionId === soul.sessionId, 'rollback preserves registry and native identity', snapshot)
  const beforeRepair = JSON.stringify(snapshot)
  const repair = dataOf(await h.adminOk(
    supervisor,
    h.repairAuditBody(false, await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'repair_audit')
  h.assert(caseId, repair.registryIntegrity === 'ok' && repair.mutationPerformed === false, 'read-only repair reports integrity without guessed mutations', repair)
  h.assert(caseId, repair.unknownOwnershipCount === 0, 'repair finds no unknown ownership authority', repair)
  h.assert(caseId, JSON.stringify(await inventorySnapshot(h, supervisor)) === beforeRepair, 'read-only repair leaves registry-visible soul/intent/view data byte-equivalent', repair)
  h.assert(caseId, h.broker.unsafeAttempts().length === 0, 'migration and rollback issue no unsafe destructive requests')

  // The manifest requires migration and repair evidence in the run itself, not
  // only in the assertion log: an operator reviewing a landing must be able to
  // read the exact plan that ran and the exact integrity audit that followed.
  h.writeArtifact('migration-plan.json', { caseId, dryRun, optIn, managedDefault, rollback })
  h.writeArtifact('repair-audit.json', { caseId, repair })
}

async function gate12ReleaseAndFullMatrix(h: RuntimeHarness): Promise<void> {
  const caseId = 'P5-G12'
  runRust(h, 'freshell-runtime-protocol', 'phase5_loss_and_notice_contract_round_trips_without_raw_native_identity')
  runRust(h, 'freshell-agent-runtime', 'checked_in_capability_manifest_matches_runtime_inventory')
  runRust(h, 'freshell-supervisor', 'stable_notice_identity_is_order_independent')
  h.runFocusedVitest('test/unit/port/managed-runtime-contract-freeze.test.ts')

  const supervisor = await h.startSupervisor({
    scenarioId: unique('p5-g12-release'),
    binaryKind: 'release',
    crashPoint: 'after_loss_incident_commit',
    env: {
      FRESHELL_RUNTIME_LOSS_CLEANUP_FAILPOINT: 'termination_unconfirmed',
      FRESHELL_RUNTIME_INCIDENT_EXPORT_FAIL: '1',
    },
  })
  await enableManagedOptIn(h, supervisor)
  const soul = await launchNativeSoul(h, supervisor, caseId, 'release-no-faults', true)
  await captureResume(h, supervisor, soul, caseId)
  removeEveryFixtureRecoveryCopy(h, soul)
  const result = dataOf(await h.adminOk(
    supervisor,
    h.recoverBody(soul.soulId, 'provider_exit', await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'recovery')
  h.assert(caseId, result.outcome === 'lost' && result.view.cleanupState === 'verified_empty', 'non-fault release build ignores test failpoint environment and completes exact cleanup', result)
  h.assert(caseId, h.isContainerRunning(supervisor.containerId), 'release supervisor did not execute compiled-out crash hooks')

}

async function launchNativeSoul(
  h: RuntimeHarness,
  supervisor: SupervisorInstance,
  caseId: string,
  label: string,
  materialize: boolean,
): Promise<NativeSoul> {
  const soulId = newSoul()
  const launch = dataOf(await h.adminOk(
    supervisor,
    h.launchBody({
      soulId,
      provider: 'native-session-fixture',
      providerStoreId: `store-${label}-${randomUUID()}`,
      creationSeedRef: `seed-${label}-${randomUUID()}`,
      fixture: 'native_session',
      projectKey: `workspace-${label}`,
      expectedControlEpoch: await epoch(h, supervisor),
      viewIntent: {
        ownerId: 'phase5-gate',
        workspaceId: `workspace-${label}`,
        kind: 'automatic_primary',
        preferredTabId: `tab-${label}`,
        preferredPaneId: `pane-${label}`,
        title: `Recovered ${label}`,
        placementGroup: 'Recovered agents',
        visibility: 'visible',
      },
    }),
    { requestId: newRequest() },
  ), 'launch')
  h.assert(caseId, launch.workerLaunchCount === 1, `${label} starts exactly one writer`, launch)
  let sessionId: string | undefined
  if (materialize) {
    const created = await h.nativeFixtureCall(supervisor, launch.view.incarnationId, { method: 'create' })
    h.assert(caseId, created.ok === true && typeof created.sessionId === 'string', `${label} materializes one native identity`, created)
    sessionId = created.sessionId
  }
  return {
    soulId,
    sessionId,
    incarnationId: launch.view.incarnationId,
    containerId: launch.view.containerId,
    workerPid: launch.workerPid,
    view: launch.view,
  }
}

async function captureResume(
  h: RuntimeHarness,
  supervisor: SupervisorInstance,
  soul: NativeSoul,
  caseId: string,
): Promise<void> {
  const probe = dataOf(await h.adminOk(
    supervisor,
    h.probeRecoveryBody(soul.soulId, await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'recovery_probe')
  h.assert(caseId, probe.kind === 'reattach_ready', 'live provider captures recovery evidence without replacement', probe)
  const view = latestSoul((await inventorySnapshot(h, supervisor)).souls, soul.soulId)
  if (soul.sessionId) {
    h.assert(caseId, view.nativeSessionId === soul.sessionId, 'registry captured the exact native identity', view)
    h.assert(caseId, ['resume_captured', 'checkpoint_captured'].includes(view.durabilityState), 'registry captured durable recovery evidence', view)
  }
}

function removeEveryFixtureRecoveryCopy(h: RuntimeHarness, soul: NativeSoul): void {
  h.killOwnedRuntimePidExact(soul.containerId, soul.workerPid, ['worker', '--fixture', 'native_session'])
  h.execOwnedContainerExact(soul.containerId, [
    'node', '-e', String.raw`
const fs = require('node:fs');
const path = require('node:path');
const state = '/home/freshell/provider/native-session-state.json';
try { fs.unlinkSync(state); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const checkpointDir = '/home/freshell/provider/.freshell/checkpoints/native-session';
let entries = [];
try { entries = fs.readdirSync(checkpointDir, { withFileTypes: true }); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const entry of entries) {
  if (!entry.isFile() || !/^\d+\.json$/.test(entry.name)) {
    throw new Error('unknown checkpoint object blocks exact loss fixture cleanup');
  }
  fs.unlinkSync(path.join(checkpointDir, entry.name));
}
`,
  ])
}

async function enableManagedOptIn(h: RuntimeHarness, supervisor: SupervisorInstance): Promise<void> {
  const result = dataOf(await h.adminOk(
    supervisor,
    h.migrationPlanBody({
      requestedMode: 'managed-opt-in',
      apply: true,
      expectedControlEpoch: await epoch(h, supervisor),
    }),
    { requestId: newRequest() },
  ), 'migration_plan')
  if (result.currentMode !== 'managed-opt-in' || result.blockers.length !== 0) {
    throw new Error(`managed opt-in failed: ${JSON.stringify(result)}`)
  }
}

async function inventorySnapshot(h: RuntimeHarness, supervisor: SupervisorInstance): Promise<any> {
  return dataOf(await h.adminOk(supervisor, h.inventorySnapshotBody()), 'inventory_snapshot')
}

async function pendingNotices(h: RuntimeHarness, supervisor: SupervisorInstance): Promise<any[]> {
  return dataOf(await h.adminOk(
    supervisor,
    h.pendingNoticesBody('profile:phase5-gate', 100, await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'pending_notices')
}

async function incidentSummary(h: RuntimeHarness, supervisor: SupervisorInstance, incidentId: string): Promise<any> {
  return dataOf(await h.adminOk(
    supervisor,
    h.incidentSummaryBody(incidentId, await epoch(h, supervisor)),
    { requestId: newRequest() },
  ), 'incident_summary')
}

async function metricsSnapshot(h: RuntimeHarness, supervisor: SupervisorInstance): Promise<any> {
  return dataOf(await h.adminOk(supervisor, h.runtimeMetricsSnapshotBody(), { requestId: newRequest() }), 'metrics_snapshot')
}

async function epoch(h: RuntimeHarness, supervisor: SupervisorInstance): Promise<number> {
  const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
  return health.controlEpoch ?? health.control_epoch
}

function latestSoul(rows: any[], soulId: string): any {
  return rows.filter((row) => row.soulId === soulId).at(-1)
}

function assertOneWriter(h: RuntimeHarness, caseId: string, rows: any[], soulId: string): void {
  const running = rows.filter((row) => row.soulId === soulId && row.launchState === 'running')
  h.assert(caseId, running.length === 1, `soul ${soulId} has exactly one running writer`, running)
}

function counter(snapshot: any, name: string, label: string): number {
  return snapshot.counters.find((row: any) => row.name === name && row.label === label)?.value ?? 0
}

function listIncidentFiles(h: RuntimeHarness, supervisor: SupervisorInstance, incidentId: string): string[] {
  if (!/^incident-[A-Za-z0-9-]+$/.test(incidentId)) throw new Error('unsafe incident id')
  const root = '/var/lib/freshell-supervisor/incidents'
  const names = [`${incidentId}.open.json`, `${incidentId}.closed.json`]
  return names.filter((name) => {
    try {
      h.runCommand('docker', ['exec', supervisor.containerId, 'test', '-f', path.join(root, name)])
      return true
    } catch {
      return false
    }
  })
}

function collectTextFiles(root: string): string {
  const chunks: string[] = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()!
    if (!fs.existsSync(current)) continue
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current)) stack.push(path.join(current, name))
      continue
    }
    if (stat.size <= 16 * 1024 * 1024) {
      try { chunks.push(fs.readFileSync(current, 'utf8')) } catch {}
    }
  }
  return chunks.join('\n')
}

function runRust(h: RuntimeHarness, packageName: string, filter: string): void {
  const output = h.runCommand(path.join(os.homedir(), '.local', 'bin', 'mise'), [
    'exec', 'rust@1.96', '--', 'cargo', 'test', '-p', packageName, filter,
    '--all-features', '--', '--nocapture',
  ])
  if (!/test result: ok\. [1-9]\d* passed;/.test(output)) {
    throw new Error(`focused Rust test ${packageName}:${filter} did not execute successfully\n${output}`)
  }
}


function unique(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value !== null) return value
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`timed out waiting for condition: ${String(lastError)}`)
}

function dataOf(result: any, expectedKind: string): any {
  if (!result || result.kind !== expectedKind) {
    throw new Error(`expected ${expectedKind}, received ${JSON.stringify(result)}`)
  }
  return result.data
}
