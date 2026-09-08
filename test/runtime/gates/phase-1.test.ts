import fs from 'node:fs'
import path from 'node:path'

import {
  defaultLimits,
  newRequest,
  newSoul,
  RuntimeHarness,
} from '../../../scripts/testing/runtime-sandbox.js'

export const PHASE1_CASE_IDS = [
  'P1-G01', 'P1-G02', 'P1-G03', 'P1-G04', 'P1-G05',
  'P1-G06', 'P1-G07', 'P1-G08', 'P1-G09', 'P1-G10',
] as const

export async function runPhase1Gate(
  harness: RuntimeHarness,
  onCasePassed: (caseId: string) => void = () => {},
): Promise<string[]> {
  const executed: string[] = []
  for (const [caseId, run] of [
    ['P1-G01', gate01BasicManagedRuntime],
    ['P1-G02', gate02CrashTransactions],
    ['P1-G03', gate03RegistryFailpoints],
    ['P1-G04', gate04ForeignProcessSafety],
    ['P1-G05', gate05DescendantContainment],
    ['P1-G06', gate06UnconfirmedStopRetainsEvidence],
    ['P1-G07', gate07ControllerFencingAndRequestDedupe],
    ['P1-G08', gate08LegacySafetyRegressions],
    ['P1-G09', gate09RuntimeIsolation],
    ['P1-G10', gate10ReleaseFaultHooksAndCompleteness],
  ] as const) {
    harness.recordLifecycle('gate.case.started', { caseId })
    try {
      await run(harness)
      executed.push(caseId)
      onCasePassed(caseId)
      harness.recordLifecycle('gate.case.passed', { caseId })
    } catch (error) {
      harness.writeIncident(`${caseId}-failure`, { error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error) })
      harness.recordLifecycle('gate.case.failed', { caseId, error: String(error) })
      throw error
    }
  }
  return executed
}

export function validateRequiredCoverage(required: readonly string[], executed: readonly string[]): void {
  const executedSet = new Set(executed)
  const missing = required.filter((caseId) => !executedSet.has(caseId))
  const extra = executed.filter((caseId) => !required.includes(caseId))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`runtime gate coverage incomplete: missing=[${missing.join(',')}] extra=[${extra.join(',')}]`)
  }
}

async function gate01BasicManagedRuntime(h: RuntimeHarness): Promise<void> {
  const caseId = 'P1-G01'
  const supervisor = await h.startSupervisor({ scenarioId: 'g01-basic' })
  const webSentinel = h.startWebLifetimeSentinel('g01-basic')
  const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
  const epoch = numericField(health, 'control_epoch', 'controlEpoch')
  const soulId = newSoul()
  const result = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId, expectedControlEpoch: epoch })), 'launch')
  const view = result.view
  h.assert(caseId, result.workerLaunchCount === 1, 'host launched exactly one real heartbeat worker', result)
  h.assert(caseId, typeof view.containerId === 'string' && /^[0-9a-f]{64}$/.test(view.containerId), 'full container id committed before running', view)
  const receipt = h.broker.receipts().find((candidate) => candidate.containerId === view.containerId)
  h.assert(caseId, receipt !== undefined, 'broker has an exact independent create receipt', h.broker.receipts())
  const heartbeat = path.join(h.runtimeDir(supervisor, view.incarnationId), 'heartbeat.json')
  await h.waitForFile(heartbeat)
  const first = JSON.parse(fs.readFileSync(heartbeat, 'utf8'))
  h.stopTrackedContainerExact(webSentinel)
  await sleep(250)
  const second = JSON.parse(fs.readFileSync(heartbeat, 'utf8'))
  h.assert(caseId, second.at > first.at, 'stopping the sibling web-lifetime container does not stop the managed worker', { first, second })
  const inspect = h.inspectContainer(view.containerId)
  h.assert(caseId, inspect.HostConfig.NetworkMode === 'none' && inspect.HostConfig.PidMode !== 'host', 'runtime has private network/PID namespaces', inspect.HostConfig)
  h.assert(caseId, inspect.HostConfig.ReadonlyRootfs === true && inspect.HostConfig.Privileged !== true, 'runtime root is read-only and unprivileged', inspect.HostConfig)
  h.assert(caseId, inspect.Config.Labels?.project === 'freshell', 'project label is bookkeeping-only and present for operator visibility', inspect.Config.Labels)
  h.assert(caseId, !JSON.stringify(inspect.Mounts).includes('.freshell') && !JSON.stringify(inspect.Mounts).includes('.claude') && !JSON.stringify(inspect.Mounts).includes('.codex'), 'no production provider homes are mounted', inspect.Mounts)
  h.assert(caseId, Object.keys(inspect.HostConfig.PortBindings ?? {}).length === 0, 'runtime publishes no production ports')
  const limits = result.effectiveLimits
  const requested = defaultLimits()
  h.assert(caseId, limits.cpuMilli === requested.cpuMilli, 'CPU quota is effective inside the runtime', limits)
  h.assert(caseId, limits.memoryBytes === requested.memoryBytes, 'memory limit is effective inside the runtime', limits)
  h.assert(caseId, limits.pidsMax === requested.pidsMax, 'PID limit is effective inside the runtime', limits)
  const stop = dataOf(await h.adminOk(supervisor, h.stopBody(soulId, epoch)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty', 'basic runtime terminates with verified-empty outcome', stop)

  const cpuSoul = newSoul()
  const cpu = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId: cpuSoul, fixture: 'cpu_burner', expectedControlEpoch: epoch })), 'launch')
  const cpuEvidencePath = path.join(h.runtimeDir(supervisor, cpu.view.incarnationId), 'cpu-burner.json')
  await h.waitForFile(cpuEvidencePath)
  const cpuEvidence = JSON.parse(fs.readFileSync(cpuEvidencePath, 'utf8'))
  h.assert(caseId, Array.isArray(cpuEvidence.burnerPids) && cpuEvidence.burnerPids.length === 4, 'bounded CPU fixture launches exactly four workers', cpuEvidence)
  const cpuStop = dataOf(await h.adminOk(supervisor, h.stopBody(cpuSoul, epoch)), 'stop')
  h.assert(caseId, cpuStop.outcome === 'verified_empty', 'CPU fixture remains inside exact owned enclosure')

  const memorySoul = newSoul()
  const memory = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId: memorySoul, fixture: 'memory_allocator', expectedControlEpoch: epoch })), 'launch')
  const memoryEvidencePath = path.join(h.runtimeDir(supervisor, memory.view.incarnationId), 'memory-allocator.json')
  await h.waitForFile(memoryEvidencePath)
  const memoryEvidence = JSON.parse(fs.readFileSync(memoryEvidencePath, 'utf8'))
  h.assert(caseId, memoryEvidence.allocatedBytes === 32 * 1024 * 1024 && memoryEvidence.touched === true, 'bounded memory fixture allocates and touches a known finite payload', memoryEvidence)
  const memoryStop = dataOf(await h.adminOk(supervisor, h.stopBody(memorySoul, epoch)), 'stop')
  h.assert(caseId, memoryStop.outcome === 'verified_empty', 'memory fixture remains inside exact owned enclosure')

  const nativeSoul = newSoul()
  const native = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId: nativeSoul, fixture: 'native_session', expectedControlEpoch: epoch })), 'launch')
  const created = await h.nativeFixtureCall(supervisor, native.view.incarnationId, { method: 'create' })
  h.assert(caseId, created.ok === true && typeof created.sessionId === 'string', 'native-session fixture creates a deterministic durable identity', created)
  const wrong = await h.nativeFixtureCall(supervisor, native.view.incarnationId, { method: 'resume', session_id: 'wrong-session' })
  h.assert(caseId, wrong.ok === false, 'native-session fixture refuses the wrong resume identity', wrong)
  const resumed = await h.nativeFixtureCall(supervisor, native.view.incarnationId, { method: 'resume', session_id: created.sessionId })
  h.assert(caseId, resumed.ok === true && resumed.sessionId === created.sessionId, 'native-session fixture resumes only the exact identity', resumed)
  const history = await h.nativeFixtureCall(supervisor, native.view.incarnationId, { method: 'history' })
  h.assert(caseId, JSON.stringify(history.history) === JSON.stringify(['create', 'resume']), 'native-session fixture exposes persisted create/resume history', history)
  const nativeState = JSON.parse(h.execOwnedContainerExact(
    native.view.containerId,
    ['cat', '/home/freshell/provider/native-session-state.json'],
  ))
  h.assert(
    caseId,
    nativeState.sessionId === created.sessionId && JSON.stringify(nativeState.history) === JSON.stringify(['create', 'resume']),
    'native-session fixture stores exact provider identity/history in its soul-scoped provider volume',
    nativeState,
  )
  const nativeStop = dataOf(await h.adminOk(supervisor, h.stopBody(nativeSoul, epoch)), 'stop')
  h.assert(caseId, nativeStop.outcome === 'verified_empty', 'native-session fixture remains inside exact owned enclosure')
}

async function gate02CrashTransactions(h: RuntimeHarness): Promise<void> {
  const caseId = 'P1-G02'
  const crashPoints = [
    'after_prepare',
    'after_docker_create',
    'after_created_commit',
    'after_host_start',
    'before_grant_commit',
    'after_grant_commit',
    'after_grant_delivery',
  ]
  for (const crashPoint of crashPoints) {
    const scenarioId = `g02-${crashPoint}`
    const before = h.broker.receiptIds()
    const first = await h.startSupervisor({ scenarioId, crashPoint })
    const health1 = dataOf(await h.adminOk(first, { method: 'health' }), 'health')
    const epoch1 = numericField(health1, 'control_epoch', 'controlEpoch')
    const soulId = newSoul()
    const requestId = newRequest()
    let requestFailed = false
    try {
      await h.adminRaw(first, h.launchBody({ soulId, expectedControlEpoch: epoch1 }), { requestId })
    } catch {
      requestFailed = true
    }
    await h.waitForContainerExit(first.containerId)
    h.assert(caseId, requestFailed, `supervisor really crashed at ${crashPoint}`)
    const crashReceipts = h.brokerReceiptsSince(before)
    if (crashPoint === 'after_prepare') {
      h.assert(caseId, crashReceipts.length === 0, 'crash after PREPARED launches no container')
    }
    if (crashPoint === 'after_docker_create') {
      h.assert(caseId, crashReceipts.length === 1 && h.inspectContainer(crashReceipts[0].containerId).State.Running === false, 'unregistered create candidate remains stopped')
    }
    if (['after_host_start', 'before_grant_commit', 'after_grant_commit'].includes(crashPoint) && crashReceipts.length === 1) {
      const heartbeat = path.join(crashReceipts[0].runtimeDir, 'heartbeat.json')
      h.assert(caseId, !fs.existsSync(heartbeat), `${crashPoint} has not authorized a provider worker`)
    }

    const restarted = await h.startSupervisor({ scenarioId, volumeName: first.volumeName })
    const health2 = dataOf(await h.adminOk(restarted, { method: 'health' }), 'health')
    const epoch2 = numericField(health2, 'control_epoch', 'controlEpoch')
    h.assert(caseId, epoch2 > epoch1, 'restarted supervisor advances the control epoch', { crashPoint, epoch1, epoch2 })
    const recovered = dataOf(await h.adminOk(restarted, h.launchBody({ soulId, expectedControlEpoch: epoch2 }), { requestId }), 'launch')
    h.assert(caseId, recovered.workerLaunchCount === 1, `recovery at ${crashPoint} has exactly one authorized worker launch`, recovered)
    const allReceipts = h.brokerReceiptsSince(before)
    const running = allReceipts.filter((receipt) => h.isContainerRunning(receipt.containerId))
    h.assert(caseId, running.length === 1 && running[0].containerId === recovered.view.containerId, `recovery at ${crashPoint} leaves exactly one running managed enclosure`, { allReceipts, running })
    await h.waitForFile(path.join(h.runtimeDir(restarted, recovered.view.incarnationId), 'heartbeat.json'))
    const stop = dataOf(await h.adminOk(restarted, h.stopBody(soulId, epoch2)), 'stop')
    h.assert(caseId, stop.outcome === 'verified_empty', `recovered ${crashPoint} runtime stops cleanly`)
    h.writeIncident(`g02-${crashPoint}`, { crashPoint, crashReceipts, allReceipts, recovered })
  }
  h.assert(caseId, h.broker.unsafeAttempts().length === 0, 'crash recovery never widens authority to an unknown container', h.broker.unsafeAttempts())
}

async function gate03RegistryFailpoints(h: RuntimeHarness): Promise<void> {
  const caseId = 'P1-G03'
  const failpoints = ['prepare', 'commit_created', 'commit_grant'] as const
  for (const failpoint of failpoints) {
    const before = h.broker.receiptIds()
    const supervisor = await h.startSupervisor({ scenarioId: `g03-${failpoint}`, dbFailpoint: failpoint })
    const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
    const epoch = numericField(health, 'control_epoch', 'controlEpoch')
    const soulId = newSoul()
    const reply = await h.adminRaw(supervisor, h.launchBody({ soulId, expectedControlEpoch: epoch }), { requestId: newRequest() })
    h.assert(caseId, reply.result.Err?.code === 'FAULT_INJECTED', `${failpoint} is surfaced as a typed launch failure`, reply)
    const receipts = h.brokerReceiptsSince(before)
    if (failpoint === 'prepare') {
      h.assert(caseId, receipts.length === 0, 'PREPARED transaction failure creates no runtime')
    } else {
      h.assert(caseId, receipts.length === 1, `${failpoint} leaves exactly one broker receipt for cleanup`, receipts)
      const inspect = h.inspectContainer(receipts[0].containerId)
      if (failpoint === 'commit_created') h.assert(caseId, inspect.State.Running === false, 'container-id commit failure leaves the candidate stopped')
      if (failpoint === 'commit_grant') {
        h.assert(caseId, inspect.State.Running === true, 'grant-commit failure may leave only the trusted host alive')
        h.assert(caseId, !fs.existsSync(path.join(receipts[0].runtimeDir, 'heartbeat.json')), 'grant-commit failure launches no worker')
      }
      h.removeContainerExact(receipts[0].containerId)
    }
  }
  h.assert(caseId, h.broker.unsafeAttempts().length === 0, 'registry failures never produce unsafe cleanup requests', h.broker.unsafeAttempts())
}

async function gate04ForeignProcessSafety(h: RuntimeHarness): Promise<void> {
  const caseId = 'P1-G04'
  const supervisor = await h.startSupervisor({ scenarioId: 'g04-foreign' })
  const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
  const epoch = numericField(health, 'control_epoch', 'controlEpoch')
  const installationId = stringField(health, 'installation_id', 'installationId')
  const foreignId = h.createForeignSentinel({ scenarioId: 'g04-foreign', installationId })
  const soulId = newSoul()
  const launch = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId, expectedControlEpoch: epoch })), 'launch')
  const unknown = await h.adminRaw(supervisor, h.stopBody(newSoul(), epoch))
  h.assert(caseId, unknown.result.Err?.code === 'UNKNOWN_SOUL', 'unknown-soul stop is rejected before Docker mutation', unknown)
  h.assert(caseId, h.isContainerRunning(foreignId), 'foreign sentinel with matching labels/env/cwd remains alive')
  h.assert(caseId, h.brokerEventsFor(foreignId).length === 0, 'SUT issued no destructive request against the foreign sentinel', h.brokerEventsFor(foreignId))
  h.assert(caseId, h.broker.unsafeAttempts().length === 0, 'the broker did not need to save the test from an unsafe SUT request', h.broker.unsafeAttempts())
  const stop = dataOf(await h.adminOk(supervisor, h.stopBody(soulId, epoch)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty', 'known managed runtime still stops normally')
  h.assert(caseId, !h.isContainerRunning(launch.view.containerId) && h.isContainerRunning(foreignId), 'managed/foreign fate diverges exactly by ownership')
}

async function gate05DescendantContainment(h: RuntimeHarness): Promise<void> {
  const caseId = 'P1-G05'
  const supervisor = await h.startSupervisor({ scenarioId: 'g05-tree' })
  const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
  const epoch = numericField(health, 'control_epoch', 'controlEpoch')
  const foreignId = h.createForeignSentinel({ scenarioId: 'g05-tree' })
  const soulId = newSoul()
  const launch = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId, fixture: 'descendant_spawner', expectedControlEpoch: epoch })), 'launch')
  const runtimeDir = h.runtimeDir(supervisor, launch.view.incarnationId)
  await h.waitForFile(path.join(runtimeDir, 'descendants.json'))
  await h.waitForFile(path.join(runtimeDir, 'fixture-tree.json'))
  const top = h.runCommand('docker', ['top', launch.view.containerId, '-eo', 'pid,ppid,sid,comm'])
  const processLines = top.trim().split('\n').slice(1)
  h.assert(caseId, processLines.length >= 3, 'fixture really contains a worker plus setsid/detached descendants', top)
  const stopped = dataOf(await h.adminOk(supervisor, h.stopBody(soulId, epoch)), 'stop')
  h.assert(caseId, stopped.outcome === 'verified_empty', 'exact container stop proves descendant enclosure empty', stopped)
  h.assert(caseId, !h.isContainerRunning(launch.view.containerId), 'setsid descendants did not escape the owned container')
  h.assert(caseId, h.isContainerRunning(foreignId), 'foreign sentinel survives descendant cleanup')
}

async function gate06UnconfirmedStopRetainsEvidence(h: RuntimeHarness): Promise<void> {
  const caseId = 'P1-G06'
  const supervisor = await h.startSupervisor({ scenarioId: 'g06-stop-failure' })
  const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
  const epoch = numericField(health, 'control_epoch', 'controlEpoch')
  const soulId = newSoul()
  const launch = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId, expectedControlEpoch: epoch })), 'launch')
  h.broker.failNextStop()
  const first = dataOf(await h.adminOk(supervisor, h.stopBody(soulId, epoch)), 'stop')
  h.assert(caseId, first.outcome === 'termination_unconfirmed', 'injected Docker stop failure is not mislabeled empty', first)
  h.assert(caseId, first.view.launchState === 'stopping' && first.view.cleanupState === 'termination_unconfirmed', 'unconfirmed stop retains a stopping ownership record', first.view)
  const inventory = dataOf(await h.adminOk(supervisor, { method: 'inventory' }), 'inventory')
  const retained = (inventory as any[]).find((view) => view.incarnationId === launch.view.incarnationId)
  h.assert(caseId, retained?.containerId === launch.view.containerId && retained.cleanupState === 'termination_unconfirmed', 'inventory still carries exact container evidence after failed stop', retained)
  const second = dataOf(await h.adminOk(supervisor, h.stopBody(soulId, epoch)), 'stop')
  h.assert(caseId, second.outcome === 'verified_empty', 'retry with backend restored proves the same enclosure empty', second)
  h.assert(caseId, !h.isContainerRunning(launch.view.containerId), 'retry actually stopped the exact runtime')
}

async function gate07ControllerFencingAndRequestDedupe(h: RuntimeHarness): Promise<void> {
  const caseId = 'P1-G07'
  const first = await h.startSupervisor({ scenarioId: 'g07-fencing' })
  const health1 = dataOf(await h.adminOk(first, { method: 'health' }), 'health')
  const epoch1 = numericField(health1, 'control_epoch', 'controlEpoch')
  const second = await h.startSupervisor({ scenarioId: 'g07-fencing', volumeName: first.volumeName, waitForHealth: false })
  await h.waitForContainerExit(second.containerId)
  h.assert(caseId, /already owned|already locked|another supervisor|registry is already owned/i.test(h.containerLogs(second.containerId)), 'second supervisor on the same registry fails closed', h.containerLogs(second.containerId))

  const before = h.broker.receiptIds()
  const soulId = newSoul()
  const requestId = newRequest()
  const original = h.launchBody({ soulId, expectedControlEpoch: epoch1 })
  const launch1 = dataOf(await h.adminOk(first, original, { requestId }), 'launch')
  const changed = h.launchBody({ soulId, expectedControlEpoch: epoch1, limits: { ...defaultLimits(), memoryBytes: 160 * 1024 * 1024 } })
  const conflict = await h.adminRaw(first, changed, { requestId })
  h.assert(caseId, conflict.result.Err?.code === 'REQUEST_ID_CONFLICT', 'same request id with changed semantic payload is rejected', conflict)
  h.assert(caseId, h.brokerReceiptsSince(before).length === 1, 'request conflict created no duplicate enclosure')

  h.stopSupervisorExact(first)
  h.removeContainerExact(first.containerId)
  const third = await h.startSupervisor({ scenarioId: 'g07-fencing', volumeName: first.volumeName })
  const health3 = dataOf(await h.adminOk(third, { method: 'health' }), 'health')
  const epoch3 = numericField(health3, 'control_epoch', 'controlEpoch')
  h.assert(caseId, epoch3 > epoch1, 'new controller generation advances epoch')
  const stale = await h.adminRaw(third, original, { requestId })
  h.assert(caseId, stale.result.Err?.code === 'STALE_CONTROL_EPOCH', 'old controller epoch is fenced before runtime mutation', stale)
  const resumed = dataOf(await h.adminOk(third, h.launchBody({ soulId, expectedControlEpoch: epoch3 }), { requestId }), 'launch')
  h.assert(caseId, resumed.view.containerId === launch1.view.containerId && resumed.workerLaunchCount === 1, 'idempotent replay adopts the same live incarnation with one worker', { launch1, resumed })
  h.assert(caseId, h.brokerReceiptsSince(before).length === 1, 'controller restart did not create another runtime')
  const stop = dataOf(await h.adminOk(third, h.stopBody(soulId, epoch3)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty', 'fenced controller still allows current controller to stop exact runtime')
}

async function gate08LegacySafetyRegressions(h: RuntimeHarness): Promise<void> {
  const caseId = 'P1-G08'
  const sandboxSelftest = h.runCommand('bash', ['scripts/sandbox-selftest.sh'])
  h.assert(caseId, /PASS|passed|self-test/i.test(sandboxSelftest), 'repository destructive-test sandbox selftest passes', sandboxSelftest.slice(-4000))
  const command = [
    'cargo test -p freshell-codex --features real-transport durable_record_failure_terminates_exact_detached_child_and_refuses_success -- --nocapture',
    'cargo test -p freshell-codex --features real-transport sweep_preserves_record_and_reports_unconfirmed_when_kill_cannot_prove_empty -- --nocapture',
  ].join(' && ')
  const output = h.runSandboxed(command)
  h.assert(caseId, /durable_record_failure_terminates_exact_detached_child_and_refuses_success \.\.\. ok/.test(output), 'legacy detached-launch registration regression passed inside sandbox', output.slice(-8000))
  h.assert(caseId, /sweep_preserves_record_and_reports_unconfirmed_when_kill_cannot_prove_empty \.\.\. ok/.test(output), 'legacy sweep refusal regression passed inside sandbox', output.slice(-8000))
}

async function gate09RuntimeIsolation(h: RuntimeHarness): Promise<void> {
  const caseId = 'P1-G09'
  const supervisor = await h.startSupervisor({ scenarioId: 'g09-isolation' })
  const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
  const epoch = numericField(health, 'control_epoch', 'controlEpoch')
  const soulA = newSoul()
  const soulB = newSoul()
  const a = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId: soulA, fixture: 'security_probe', expectedControlEpoch: epoch })), 'launch')
  const b = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId: soulB, fixture: 'security_probe', expectedControlEpoch: epoch })), 'launch')
  for (const [label, result] of [['a', a], ['b', b]] as const) {
    const evidence = result.fixtureEvidence
    h.assert(caseId, evidence.dockerSocketVisible === false, `runtime ${label} cannot see a Docker management socket`, evidence)
    h.assert(caseId, evidence.registryVisible === false, `runtime ${label} cannot see supervisor registry`, evidence)
    h.assert(caseId, evidence.adminSocketVisible === false, `runtime ${label} cannot see supervisor admin IPC`, evidence)
    h.assert(caseId, evidence.ownSocketVisible === true, `runtime ${label} can see only its own host control socket`, evidence)
    h.assert(caseId, /freshell-session-host/.test(evidence.pidOne), `runtime ${label} has a private pid namespace with its host as pid 1`, evidence)
  }
  h.assert(caseId, a.view.containerId !== b.view.containerId, 'different souls receive distinct enclosures')

  const stopBody = h.stopBody(soulA, epoch)
  const destructiveBeforeProtocolAbuse = h.broker.eventsSnapshot().filter((event) => event.destructive).length
  const wrongRole = await h.adminEnvelopeRaw(supervisor, {
    protocolVersion: 1,
    requestId: newRequest(),
    role: 'supervisor',
    auth: supervisor.controlSecret,
    body: stopBody,
  })
  h.assert(caseId, wrongRole.result.Err?.code === 'UNAUTHORIZED_ROLE', 'wrong control role is typed and rejected before stop dispatch', wrongRole)
  h.assert(caseId, h.isContainerRunning(a.view.containerId), 'wrong-role stop request leaves the target runtime alive')

  const wrongProtocol = await h.adminEnvelopeRaw(supervisor, {
    protocolVersion: 999,
    requestId: newRequest(),
    role: 'web',
    auth: supervisor.controlSecret,
    body: stopBody,
  })
  h.assert(caseId, wrongProtocol.result.Err?.code === 'PROTOCOL_VERSION_MISMATCH', 'wrong protocol generation is typed and rejected before stop dispatch', wrongProtocol)
  h.assert(caseId, h.isContainerRunning(a.view.containerId), 'wrong-protocol stop request leaves the target runtime alive')

  const oversized = await h.adminOversizedFrame(supervisor)
  h.assert(caseId, oversized.result.Err?.code === 'FRAME_TOO_LARGE', 'oversized control frame receives a typed error without reading its body', oversized)
  h.assert(caseId, h.isContainerRunning(a.view.containerId), 'oversized frame cannot dispatch a stop')
  const destructiveAfterProtocolAbuse = h.broker.eventsSnapshot().filter((event) => event.destructive).length
  h.assert(caseId, destructiveAfterProtocolAbuse === destructiveBeforeProtocolAbuse, 'protocol abuse produced no destructive Docker request')

  h.assert(caseId, h.broker.unsafeAttempts().length === 0, 'isolation test produced no management-authority escape attempt', h.broker.unsafeAttempts())
  const stopA = dataOf(await h.adminOk(supervisor, h.stopBody(soulA, epoch)), 'stop')
  const stopB = dataOf(await h.adminOk(supervisor, h.stopBody(soulB, epoch)), 'stop')
  h.assert(caseId, stopA.outcome === 'verified_empty' && stopB.outcome === 'verified_empty', 'both isolated souls stop through their own capabilities')
}

async function gate10ReleaseFaultHooksAndCompleteness(h: RuntimeHarness): Promise<void> {
  const caseId = 'P1-G10'
  const supervisor = await h.startSupervisor({ scenarioId: 'g10-release', binaryKind: 'release', crashPoint: 'after_prepare', dbFailpoint: 'prepare' })
  const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
  const epoch = numericField(health, 'control_epoch', 'controlEpoch')
  const soulId = newSoul()
  const launch = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId, expectedControlEpoch: epoch })), 'launch')
  h.assert(caseId, launch.workerLaunchCount === 1 && h.isContainerRunning(launch.view.containerId), 'release binary ignores all runtime-test fault environment variables', launch)
  const stop = dataOf(await h.adminOk(supervisor, h.stopBody(soulId, epoch)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty', 'release-path runtime still cleans up normally')

  let checkerFailed = false
  try {
    validateRequiredCoverage(PHASE1_CASE_IDS, PHASE1_CASE_IDS.slice(0, -1))
  } catch {
    checkerFailed = true
  }
  h.assert(caseId, checkerFailed, 'gate completeness checker rejects a deliberately omitted required case')
}

function dataOf(result: any, expectedKind: string): any {
  if (!result || result.kind !== expectedKind) throw new Error(`expected ${expectedKind} result, got ${JSON.stringify(result)}`)
  return result.data
}

function numericField(value: any, ...keys: string[]): number {
  for (const key of keys) if (typeof value?.[key] === 'number') return value[key]
  throw new Error(`missing numeric field ${keys.join('/')} in ${JSON.stringify(value)}`)
}

function stringField(value: any, ...keys: string[]): string {
  for (const key of keys) if (typeof value?.[key] === 'string') return value[key]
  throw new Error(`missing string field ${keys.join('/')} in ${JSON.stringify(value)}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
