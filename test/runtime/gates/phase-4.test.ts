import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  newRequest,
  newSoul,
  RuntimeGateBlockedError,
  RuntimeHarness,
  type RuntimeLimits,
  type SupervisorInstance,
} from '../../../scripts/testing/runtime-sandbox.js'

export const PHASE4_CASE_IDS = [
  'P4-G01', 'P4-G02', 'P4-G03', 'P4-G04', 'P4-G05', 'P4-G06',
  'P4-G07', 'P4-G09', 'P4-G10', 'P4-G11',
] as const

export type Phase4BlockedCase = {
  caseId: string
  message: string
  evidence?: unknown
}

export type Phase4RunResult = {
  executed: string[]
  blocked: Phase4BlockedCase[]
}

type NativeSoul = {
  soulId: string
  sessionId: string
  incarnationId: string
  containerId: string
  workerPid: number
  view: any
}

export async function runPhase4Gate(
  harness: RuntimeHarness,
  onCasePassed: (caseId: string) => void = () => {},
  only?: ReadonlySet<string>,
): Promise<Phase4RunResult> {
  const executed: string[] = []
  const blocked: Phase4BlockedCase[] = []
  const cases = [
    ['P4-G01', gate01ControllerFirstColdStart],
    ['P4-G02', gate02DurableViewIntentProjection],
    ['P4-G03', gate03RestartIdempotence],
    ['P4-G04', gate04SavedLayoutMerge],
    ['P4-G05', gate05StoppedHistoryRetained],
    ['P4-G06', gate06StatusAndAccessibility],
    ['P4-G07', gate07ResourceLimits],
    ['P4-G09', gate09StartupBoundsAndDatabaseHealth],
    ['P4-G10', gate10CloseStopCrossDeviceAndCompatibility],
    ['P4-G11', gate11LegacyRegressionAndContractFreeze],
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

  validatePhase4Coverage(PHASE4_CASE_IDS.filter(id => !only || only.has(id)), executed, blocked.map((row) => row.caseId))
  return { executed, blocked }
}

export function validatePhase4Coverage(
  required: readonly string[],
  executed: readonly string[],
  blocked: readonly string[],
): void {
  const accounted = new Set([...executed, ...blocked])
  const missing = required.filter((id) => !accounted.has(id))
  const duplicates = [...executed, ...blocked]
    .filter((id, index, all) => all.indexOf(id) !== index)
  const extra = [...accounted].filter((id) => !required.includes(id))
  if (missing.length || duplicates.length || extra.length) {
    throw new Error(
      `phase4 gate accounting incomplete: missing=[${missing}] duplicates=[${duplicates}] extra=[${extra}]`,
    )
  }
}

async function gate01ControllerFirstColdStart(h: RuntimeHarness): Promise<void> {
  const caseId = 'P4-G01'
  const scenarioId = `p4-g01-${randomUUID().slice(0, 8)}`
  let supervisor = await h.startSupervisor({ scenarioId })
  const souls: NativeSoul[] = []
  for (let index = 0; index < 8; index += 1) {
    const native = await launchMaterializedNativeSoul(h, supervisor, caseId, `cold-${index}`)
    await captureResumeSpec(h, supervisor, native, caseId)
    souls.push(native)
  }

  // The controller is gone before failures are injected. Replacement can
  // therefore happen only in the next supervisor's pre-socket startup scan.
  h.stopSupervisorExact(supervisor)
  h.removeContainerExact(supervisor.containerId)
  for (const [index, soul] of souls.entries()) {
    if (index % 2 === 0) h.killOwnedRuntimeExact(soul.containerId)
  }

  const startedAt = Date.now()
  supervisor = await h.startSupervisor({
    scenarioId,
    volumeName: supervisor.volumeName,
    reuseSecret: true,
  })
  const startupElapsedMs = Date.now() - startedAt
  const snapshot = await inventorySnapshot(h, supervisor)
  h.assert(caseId, snapshot.readiness.initialScanState === 'complete', 'control socket opens only after startup reconciliation completes', snapshot.readiness)
  h.assert(caseId, snapshot.readiness.initialScanStartedAt > 0 && snapshot.readiness.initialScanFinishedAt >= snapshot.readiness.initialScanStartedAt, 'readiness records a bounded scan interval', snapshot.readiness)
  h.assert(caseId, snapshot.readiness.startupRecoveryPeak <= snapshot.readiness.startupRecoveryConcurrencyLimit, 'startup recovery respects its declared concurrency ceiling', snapshot.readiness)
  h.assert(caseId, snapshot.readiness.startupRecoveryPeak > 1, 'multi-soul cold start actually exercised concurrent recovery', snapshot.readiness)
  h.assert(caseId, startupElapsedMs < 180_000, 'cold-start convergence remains under the explicit per-soul startup bound', { startupElapsedMs, readiness: snapshot.readiness })

  for (const soul of souls) {
    const rows = snapshot.souls.filter((view: any) => view.soulId === soul.soulId)
    assertSingleRunningWriter(h, caseId, rows, soul.soulId)
    const latest = rows.at(-1)
    h.assert(caseId, latest?.nativeSessionId === soul.sessionId, 'startup convergence preserves the exact native conversation', { soul, latest })
    h.assert(caseId, latest?.desiredState === 'running' && latest?.recoveryState === 'live', 'startup convergence reaches a live desired-running state', latest)
  }
  h.assert(caseId, snapshot.viewIntents.length === souls.length, 'every managed soul has one durable automatic primary view intent', snapshot.viewIntents)
}

async function gate02DurableViewIntentProjection(h: RuntimeHarness): Promise<void> {
  const caseId = 'P4-G02'
  const scenarioId = `p4-g02-${randomUUID().slice(0, 8)}`
  let supervisor = await h.startSupervisor({ scenarioId })
  const first = await launchMaterializedNativeSoul(h, supervisor, caseId, 'views-a')
  const second = await launchMaterializedNativeSoul(h, supervisor, caseId, 'views-b')
  await captureResumeSpec(h, supervisor, first, caseId)
  await captureResumeSpec(h, supervisor, second, caseId)

  const before = await inventorySnapshot(h, supervisor)
  const placements = before.viewIntents.map((view: any) => ({
    viewId: view.viewId,
    soulId: view.soulId,
    tabId: view.preferredTabId,
    paneId: view.preferredPaneId,
    title: view.title,
    group: view.placementGroup,
  }))
  h.assert(caseId, new Set(placements.map((row: any) => row.viewId)).size === 2, 'automatic view identities are unique and deterministic per soul', placements)
  h.assert(caseId, placements.every((row: any) => row.group === 'Recovered agents'), 'automatic placement uses the dedicated Recovered agents group', placements)

  const events = await pendingProjections(h, supervisor)
  h.assert(caseId, events.length === 2, 'launch transaction commits one projection event per automatic primary view', events)
  for (const event of events) {
    await h.adminOk(
      supervisor,
      h.acknowledgeViewProjectionBody(event.eventId, await controlEpoch(h, supervisor)),
      { requestId: newRequest() },
    )
  }
  h.assert(caseId, (await pendingProjections(h, supervisor)).length === 0, 'projection acknowledgement drains the durable outbox', events)

  h.stopSupervisorExact(supervisor)
  h.removeContainerExact(supervisor.containerId)
  supervisor = await h.startSupervisor({
    scenarioId,
    volumeName: supervisor.volumeName,
    reuseSecret: true,
  })
  const after = await inventorySnapshot(h, supervisor)
  const afterPlacements = after.viewIntents.map((view: any) => ({
    viewId: view.viewId,
    soulId: view.soulId,
    tabId: view.preferredTabId,
    paneId: view.preferredPaneId,
    title: view.title,
    group: view.placementGroup,
  }))
  h.assert(caseId, JSON.stringify(afterPlacements) === JSON.stringify(placements), 'controller restart preserves exact placement and identity without duplicates', { placements, afterPlacements })
  h.assert(caseId, after.pendingProjectionCount === 0, 'restart does not regenerate already-acknowledged unchanged projection events', after)
}

async function gate03RestartIdempotence(h: RuntimeHarness): Promise<void> {
  const caseId = 'P4-G03'
  const scenarioId = `p4-g03-${randomUUID().slice(0, 8)}`
  let supervisor = await h.startSupervisor({ scenarioId })
  const native = await launchMaterializedNativeSoul(h, supervisor, caseId, 'restart-loop')
  await captureResumeSpec(h, supervisor, native, caseId)
  const initial = await inventorySnapshot(h, supervisor)
  const initialView = initial.viewIntents.find((view: any) => view.soulId === native.soulId)
  h.assert(caseId, Boolean(initialView), 'restart-loop soul has an automatic view', initial)

  for (let cycle = 1; cycle <= 4; cycle += 1) {
    h.stopSupervisorExact(supervisor)
    h.removeContainerExact(supervisor.containerId)
    supervisor = await h.startSupervisor({
      scenarioId,
      volumeName: supervisor.volumeName,
      reuseSecret: true,
    })
    const snapshot = await inventorySnapshot(h, supervisor)
    const views = snapshot.viewIntents.filter((view: any) => view.soulId === native.soulId)
    h.assert(caseId, views.length === 1, `controller restart ${cycle} keeps exactly one automatic view`, views)
    h.assert(caseId, views[0].viewId === initialView.viewId && views[0].preferredTabId === initialView.preferredTabId, `controller restart ${cycle} keeps deterministic IDs`, { initialView, current: views[0] })
    assertSingleRunningWriter(h, caseId, snapshot.souls, native.soulId)
    h.assert(caseId, snapshot.souls.filter((view: any) => view.soulId === native.soulId).at(-1)?.nativeSessionId === native.sessionId, `controller restart ${cycle} keeps the native identity`, snapshot.souls)
  }
}

async function gate04SavedLayoutMerge(h: RuntimeHarness): Promise<void> {
  const caseId = 'P4-G04'
  h.runFocusedVitest('test/unit/lib/managed-runtime-recovery.test.ts')
  const source = fs.readFileSync(
    path.join(h.repoRoot, 'src/lib/recovery/managed-runtime-recovery.ts'),
    'utf8',
  )
  h.assert(caseId, source.includes('activate: false'), 'recovered tabs never steal focus from an existing layout')
  h.assert(caseId, source.includes('updateExistingContent') && source.includes('only creates missing visible'), 'authoritative views merge into saved panes instead of replacing the layout')
  h.assert(caseId, source.includes("view.kind === 'explicit'"), 'explicit multi-view intent is keyed by view identity rather than collapsing by soul')
}

async function gate05StoppedHistoryRetained(h: RuntimeHarness): Promise<void> {
  const caseId = 'P4-G05'
  const supervisor = await h.startSupervisor({ scenarioId: `p4-g05-${randomUUID().slice(0, 8)}` })
  const native = await launchMaterializedNativeSoul(h, supervisor, caseId, 'history')
  await h.nativeFixtureCall(supervisor, native.incarnationId, {
    method: 'remember',
    key: 'history_marker',
    value: 'retained-without-runtime',
  })
  await captureResumeSpec(h, supervisor, native, caseId)
  const before = latestSoulView((await inventorySnapshot(h, supervisor)).souls, native.soulId)
  const stop = dataOf(
    await h.adminOk(
      supervisor,
      h.stopBody(native.soulId, await controlEpoch(h, supervisor), before.intentRevision),
      { requestId: newRequest() },
    ),
    'stop',
  )
  h.assert(caseId, stop.outcome === 'verified_empty', 'explicit stop proves the live runtime is absent', stop)

  const snapshot = await inventorySnapshot(h, supervisor)
  const retained = latestSoulView(snapshot.souls, native.soulId)
  const view = snapshot.viewIntents.find((candidate: any) => candidate.soulId === native.soulId)
  h.assert(caseId, retained?.desiredState === 'stopped' && retained?.nativeSessionId === native.sessionId, 'stopped soul retains historical native identity without a live process', retained)
  h.assert(caseId, view?.visibility === 'hidden' && view?.soulIntentRevision === retained.intentRevision, 'stop tombstone hides automatic recreation in the same revision', { retained, view })

  const receipt = h.broker.receipts().find((candidate) => candidate.containerId === native.containerId)
  h.assert(caseId, typeof receipt?.providerVolumeName === 'string', 'stopped soul retains its scoped provider volume', receipt)
  const providerState = h.runCommand('docker', [
    'run', '--rm', '--network', 'none',
    '-v', `${receipt!.providerVolumeName}:/provider:ro`,
    h.imageRef,
    'cat', '/provider/native-session-state.json',
  ])
  h.assert(caseId, providerState.includes(native.sessionId) && providerState.includes('history_marker'), 'conversation history remains readable from durable provider state after runtime removal', providerState)
}

async function gate06StatusAndAccessibility(h: RuntimeHarness): Promise<void> {
  const caseId = 'P4-G06'
  h.runFocusedVitest('test/unit/client/components/ManagedAgentRecoveryStatus.test.tsx')
  const source = fs.readFileSync(
    path.join(h.repoRoot, 'src/components/ManagedAgentRecoveryStatus.tsx'),
    'utf8',
  )
  for (const label of ['Reconnecting', 'Restarting agent', 'Recovery blocked', 'Ready', 'Stopped']) {
    h.assert(caseId, source.includes(`'${label}'`), `UI has distinct ${label} state`, label)
  }
  h.assert(caseId, source.includes('aria-label="Managed agent recovery"') && source.includes('role="alert"'), 'recovery surface exposes semantic labels and assertive errors')
  h.assert(caseId, source.includes('Retry recovery') && source.includes('Close view') && source.includes('Stop agent'), 'recovery actions are keyboard-native buttons with distinct labels')
}

async function gate07ResourceLimits(h: RuntimeHarness): Promise<void> {
  const caseId = 'P4-G07'
  const supervisor = await h.startSupervisor({ scenarioId: `p4-g07-${randomUUID().slice(0, 8)}` })
  const native = await launchMaterializedNativeSoul(h, supervisor, caseId, 'limits')
  await captureResumeSpec(h, supervisor, native, caseId)
  const before = latestSoulView((await inventorySnapshot(h, supervisor)).souls, native.soulId)
  const configured: RuntimeLimits = {
    cpuMilli: 750,
    memoryBytes: 192 * 1024 * 1024,
    swapBytes: 0,
    pidsMax: 96,
  }
  const updated = dataOf(
    await h.adminOk(
      supervisor,
      h.updateLimitsBody({
        soulId: native.soulId,
        limits: configured,
        expectedIntentRevision: before.intentRevision,
        expectedControlEpoch: await controlEpoch(h, supervisor),
      }),
      { requestId: newRequest() },
    ),
    'update_limits',
  )
  h.assert(caseId, updated.application === 'next_incarnation', 'limit edit declares next-incarnation application instead of claiming an in-place update', updated)
  h.assert(caseId, JSON.stringify(updated.configuredLimits) === JSON.stringify(configured), 'configured limit projection updates after supervisor success', updated)
  h.assert(caseId, JSON.stringify(updated.effectiveLimits) !== JSON.stringify(configured), 'effective limits remain the running incarnation values until replacement', updated)

  h.killOwnedRuntimeExact(native.containerId)
  const recovered = dataOf(
    await h.adminOk(
      supervisor,
      h.recoverBody(native.soulId, 'provider_exit', await controlEpoch(h, supervisor), updated.view.intentRevision),
      { requestId: newRequest() },
    ),
    'recovery',
  )
  h.assert(caseId, recovered.outcome === 'replaced', 'next incarnation is created through the normal exact recovery transaction', recovered)
  h.assert(caseId, JSON.stringify(recovered.view.effectiveLimits) === JSON.stringify(configured), 'replacement applies configured CPU/memory/PID limits exactly', recovered.view)
  h.assert(caseId, JSON.stringify(recovered.view.configuredLimits) === JSON.stringify(configured), 'inventory distinguishes configured and effective values after application', recovered.view)

  const invalid = await h.adminRaw(supervisor, h.updateLimitsBody({
    soulId: native.soulId,
    limits: { ...configured, memoryBytes: 1 },
    expectedIntentRevision: recovered.view.intentRevision,
    expectedControlEpoch: await controlEpoch(h, supervisor),
  }), { requestId: newRequest() })
  h.assert(caseId, invalid.result?.Err?.code === 'INVALID_RUNTIME_LIMITS', 'invalid edits fail before the UI may update its projection', invalid)
}

async function gate09StartupBoundsAndDatabaseHealth(h: RuntimeHarness): Promise<void> {
  const caseId = 'P4-G09'
  const scenarioId = `p4-g09-${randomUUID().slice(0, 8)}`
  let supervisor = await h.startSupervisor({ scenarioId })
  const soulIds: string[] = []
  for (let index = 0; index < 10; index += 1) {
    const soulId = newSoul()
    const launch = dataOf(await h.adminOk(supervisor, h.launchBody({
      soulId,
      fixture: 'heartbeat',
      provider: 'phase1-fixture',
      projectKey: `storm-workspace-${index}`,
      viewIntent: automaticView(`storm-${index}`, `storm-workspace-${index}`),
      expectedControlEpoch: await controlEpoch(h, supervisor),
    }), { requestId: newRequest() }), 'launch')
    h.assert(caseId, launch.workerLaunchCount === 1, `startup storm fixture ${index} has one writer`, launch)
    soulIds.push(soulId)
  }

  h.stopSupervisorExact(supervisor)
  h.removeContainerExact(supervisor.containerId)
  const start = Date.now()
  supervisor = await h.startSupervisor({
    scenarioId,
    volumeName: supervisor.volumeName,
    reuseSecret: true,
  })
  const elapsedMs = Date.now() - start
  const snapshot = await inventorySnapshot(h, supervisor)
  h.assert(caseId, snapshot.readiness.startupRecoveryPeak <= 4, 'startup storm never exceeds the default concurrency cap of four', snapshot.readiness)
  h.assert(caseId, snapshot.readiness.initialScanDurationMs <= elapsedMs && elapsedMs < 120_000, 'startup latency and readiness duration remain bounded', { elapsedMs, readiness: snapshot.readiness })
  h.assert(caseId, snapshot.souls.filter((view: any) => soulIds.includes(view.soulId) && view.launchState === 'running').length === soulIds.length, 'all storm souls reattach without duplicate writers', snapshot.souls)
  const secondRead = await inventorySnapshot(h, supervisor)
  h.assert(caseId, secondRead.revision === snapshot.revision && secondRead.viewIntents.length === snapshot.viewIntents.length, 'repeated inventory reads are stable and database-backed', { snapshot, secondRead })
  runFocusedRustTest(h, 'freshell-supervisor', 'schema_four_migration_preserves_existing_rows_and_backfills_views')
}

async function gate10CloseStopCrossDeviceAndCompatibility(h: RuntimeHarness): Promise<void> {
  const caseId = 'P4-G10'
  const supervisor = await h.startSupervisor({ scenarioId: `p4-g10-${randomUUID().slice(0, 8)}` })
  const native = await launchMaterializedNativeSoul(h, supervisor, caseId, 'close-stop')
  await captureResumeSpec(h, supervisor, native, caseId)
  let snapshot = await inventorySnapshot(h, supervisor)
  const primary = snapshot.viewIntents.find((view: any) => view.soulId === native.soulId)
  const soul = latestSoulView(snapshot.souls, native.soulId)

  const detached = dataOf(await h.adminOk(
    supervisor,
    h.updateViewVisibilityBody({
      viewId: primary.viewId,
      visibility: 'detached',
      expectedRevision: primary.revision,
      expectedSoulIntentRevision: soul.intentRevision,
      expectedControlEpoch: await controlEpoch(h, supervisor),
    }),
    { requestId: newRequest() },
  ), 'view_intent')
  h.assert(caseId, detached.visibility === 'detached', 'Close view mutates only durable view intent', detached)
  snapshot = await inventorySnapshot(h, supervisor)
  assertSingleRunningWriter(h, caseId, snapshot.souls, native.soulId)
  h.assert(caseId, nativeFixtureWorkerAlive(h, native.containerId, native.workerPid), 'Close view leaves the agent process alive', native)

  const explicit = dataOf(await h.adminOk(
    supervisor,
    h.upsertViewIntentBody({
      soulId: native.soulId,
      intent: {
        ownerId: 'device-two',
        workspaceId: 'workspace-close-stop',
        kind: 'explicit',
        preferredTabId: 'device-two-tab',
        preferredPaneId: 'device-two-pane',
        title: 'Second device view',
        placementGroup: 'Recovered agents',
        visibility: 'visible',
      },
      expectedSoulIntentRevision: soul.intentRevision,
      expectedControlEpoch: await controlEpoch(h, supervisor),
    }),
    { requestId: newRequest() },
  ), 'view_intent')
  snapshot = await inventorySnapshot(h, supervisor)
  h.assert(caseId, snapshot.viewIntents.filter((view: any) => view.soulId === native.soulId).length === 2, 'cross-device open creates a second view intent over the same soul', snapshot.viewIntents)
  assertSingleRunningWriter(h, caseId, snapshot.souls, native.soulId)
  h.assert(caseId, explicit.ownerId === 'device-two', 'explicit view retains cross-device ownership attribution', explicit)

  const stopped = dataOf(await h.adminOk(
    supervisor,
    h.stopBody(native.soulId, await controlEpoch(h, supervisor), soul.intentRevision),
    { requestId: newRequest() },
  ), 'stop')
  h.assert(caseId, stopped.outcome === 'verified_empty' && stopped.view.desiredState === 'stopped', 'Stop agent commits intent and terminates the exact owned runtime', stopped)
  h.assert(caseId, !nativeFixtureWorkerAlive(h, native.containerId, native.workerPid), 'Stop agent removes the writer rather than merely closing a view', native)

  const stale = await h.adminRaw(supervisor, h.updateViewVisibilityBody({
    viewId: primary.viewId,
    visibility: 'visible',
    expectedRevision: primary.revision,
    expectedSoulIntentRevision: soul.intentRevision,
    expectedControlEpoch: await controlEpoch(h, supervisor),
  }), { requestId: newRequest() })
  h.assert(caseId, stale.result?.Err?.code === 'STALE_INTENT_REVISION', 'stale pre-stop view mutation cannot recreate a stopped runtime', stale)
  runFocusedRustTest(h, 'freshell-ws', 'legacy_capability_replay_adopts_existing_managed_terminal_without_launch')
  h.runFocusedVitest('test/unit/lib/managed-runtime-recovery.test.ts')
}

async function gate11LegacyRegressionAndContractFreeze(h: RuntimeHarness): Promise<void> {
  const caseId = 'P4-G11'
  h.runFocusedVitest('test/unit/port/managed-runtime-contract-freeze.test.ts')
  runFocusedRustTest(h, 'freshell-ws', 'managed_ids_are_retry_stable_and_domain_separated')
  const output = runMise(h, 'rust@1.96', [
    'cargo', 'test', '-p', 'freshell-ws', '--test', 'unknown_terminal_reply', '--all-features', '--', '--nocapture',
  ])
  h.assert(caseId, /test result: ok\./.test(output), 'non-managed unknown-terminal wire behavior remains green', output)
  const schema = JSON.parse(fs.readFileSync(
    path.join(h.repoRoot, 'port/contract/managed-runtime.schema.json'),
    'utf8',
  ))
  h.assert(caseId, schema.schemaCount >= 20, 'generated public runtime contract includes the Phase 4 REST/projection surface', schema)
  const nodeServer = fs.readFileSync(path.join(h.repoRoot, 'server/index.ts'), 'utf8')
  h.assert(caseId, !nodeServer.includes('managedRuntimeV1: true'), 'legacy Node server does not make a managed ownership claim')
}

async function launchMaterializedNativeSoul(
  h: RuntimeHarness,
  supervisor: SupervisorInstance,
  caseId: string,
  label: string,
): Promise<NativeSoul> {
  const soulId = newSoul()
  const workspaceId = `workspace-${label}`
  const launch = dataOf(await h.adminOk(supervisor, h.launchBody({
    soulId,
    fixture: 'native_session',
    provider: 'native-session-fixture',
    providerStoreId: `store-${label}-${randomUUID()}`,
    creationSeedRef: `seed-${label}-${randomUUID()}`,
    projectKey: workspaceId,
    viewIntent: automaticView(label, workspaceId),
    expectedControlEpoch: await controlEpoch(h, supervisor),
  }), { requestId: newRequest() }), 'launch')
  h.assert(caseId, launch.workerLaunchCount === 1, `${label} starts one fixture provider writer`, launch)
  const created = await h.nativeFixtureCall(supervisor, launch.view.incarnationId, { method: 'create' })
  h.assert(caseId, created.ok === true && typeof created.sessionId === 'string', `${label} materializes an exact native identity`, created)
  return {
    soulId,
    sessionId: created.sessionId,
    incarnationId: launch.view.incarnationId,
    containerId: launch.view.containerId,
    workerPid: launch.workerPid,
    view: launch.view,
  }
}

function automaticView(label: string, workspaceId: string): Record<string, unknown> {
  return {
    ownerId: 'runtime-gate-owner',
    workspaceId,
    kind: 'automatic_primary',
    preferredTabId: `tab-${label}`,
    preferredPaneId: `pane-${label}`,
    title: `Recovered ${label}`,
    placementGroup: 'Recovered agents',
    visibility: 'visible',
  }
}

async function captureResumeSpec(
  h: RuntimeHarness,
  supervisor: SupervisorInstance,
  native: NativeSoul,
  caseId: string,
): Promise<void> {
  const probe = dataOf(await h.adminOk(supervisor, h.probeRecoveryBody(native.soulId)), 'recovery_probe')
  h.assert(caseId, probe.kind === 'reattach_ready', 'live provider captures exact recovery evidence', probe)
  const view = latestSoulView((await inventorySnapshot(h, supervisor)).souls, native.soulId)
  h.assert(caseId, view?.nativeSessionId === native.sessionId, 'registry persists exact native identity', view)
  h.assert(caseId, ['resume_captured', 'checkpoint_captured'].includes(view?.durabilityState), 'registry persists durable resume evidence', view)
}

async function inventorySnapshot(h: RuntimeHarness, supervisor: SupervisorInstance): Promise<any> {
  return dataOf(await h.adminOk(supervisor, h.inventorySnapshotBody()), 'inventory_snapshot')
}

async function pendingProjections(h: RuntimeHarness, supervisor: SupervisorInstance): Promise<any[]> {
  return dataOf(
    await h.adminOk(
      supervisor,
      h.pendingViewProjectionsBody(100, await controlEpoch(h, supervisor)),
      { requestId: newRequest() },
    ),
    'pending_view_projections',
  )
}

async function controlEpoch(h: RuntimeHarness, supervisor: SupervisorInstance): Promise<number> {
  const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
  return health.controlEpoch ?? health.control_epoch ?? 0
}

function latestSoulView(views: any[], soulId: string): any | undefined {
  return views.filter((view) => view.soulId === soulId).at(-1)
}

function assertSingleRunningWriter(
  h: RuntimeHarness,
  caseId: string,
  views: any[],
  soulId: string,
): void {
  const running = views.filter((view) => view.soulId === soulId && view.launchState === 'running')
  h.assert(caseId, running.length === 1, `soul ${soulId} has exactly one running writer`, running)
}

function nativeFixtureWorkerAlive(h: RuntimeHarness, containerId: string, pid: number): boolean {
  try {
    h.execOwnedContainerExact(containerId, [
      'sh', '-lc',
      `test -r /proc/${pid}/cmdline && tr '\\0' ' ' < /proc/${pid}/cmdline | grep -Fq -- 'worker --fixture native_session'`,
    ])
    return true
  } catch {
    return false
  }
}

function runFocusedRustTest(h: RuntimeHarness, packageName: string, filter: string): void {
  const output = runMise(h, 'rust@1.96', [
    'cargo', 'test', '-p', packageName, filter, '--all-features', '--', '--nocapture',
  ])
  if (!/test result: ok\. [1-9]\d* passed;/.test(output)) {
    throw new Error(`focused Rust test ${packageName}:${filter} ran no matching test or did not report success\n${output}`)
  }
}


function runMise(h: RuntimeHarness, tool: string, args: string[]): string {
  return h.runCommand(path.join(os.homedir(), '.local', 'bin', 'mise'), [
    'exec', tool, '--', ...args,
  ])
}

function dataOf(result: any, expectedKind: string): any {
  if (!result || result.kind !== expectedKind) {
    throw new Error(`expected admin result kind ${expectedKind}, received ${JSON.stringify(result)}`)
  }
  return result.data
}
