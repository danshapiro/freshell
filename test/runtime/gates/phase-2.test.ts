import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import {
  newRequest,
  newSoul,
  RuntimeGateBlockedError,
  RuntimeHarness,
  type RuntimeLimits,
  type SupervisorInstance,
} from '../../../scripts/testing/runtime-sandbox.js'

export const PHASE2_CASE_IDS = [
  'P2-G02', 'P2-G03', 'P2-G05', 'P2-G06',
  'P2-G07', 'P2-G08', 'P2-G09', 'P2-G10', 'P2-G11',
] as const

export const PHASE2_TEST_LIMITS: RuntimeLimits = {
  cpuMilli: 500,
  memoryBytes: 256 * 1024 * 1024,
  swapBytes: 0,
  pidsMax: 64,
}

export type Phase2BlockedCase = {
  caseId: string
  message: string
  evidence?: unknown
}

export type Phase2RunResult = {
  executed: string[]
  blocked: Phase2BlockedCase[]
}

/** Deterministic runtime behavior; real browser/provider tests run separately. */
export async function runPhase2Gate(
  harness: RuntimeHarness,
  onCasePassed: (caseId: string) => void = () => {},
  only?: ReadonlySet<string>,
): Promise<Phase2RunResult> {
  const executed: string[] = []
  const blocked: Phase2BlockedCase[] = []
  const cases = [
    ['P2-G02', gate02BoundedReplayWhileWebAbsent],
    ['P2-G03', gate03SupervisorRestartAdoptsHost],
    ['P2-G05', gate05CpuQuota],
    ['P2-G06', gate06MemoryOomChildOnly],
    ['P2-G07', gate07PidCeilingAndSetsid],
    ['P2-G08', gate08TransactionalAdmissionAndSecondView],
    ['P2-G09', gate09GitWorktreeProviderPersistence],
    ['P2-G10', gate10DroppedAckDedupeAndStopWins],
    ['P2-G11', gate11NamedControllerRestartAndHostRecreation],
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
  validatePhase2Coverage(PHASE2_CASE_IDS.filter(id => !only || only.has(id)), executed, blocked.map((row) => row.caseId))
  return { executed, blocked }
}

export function validatePhase2Coverage(
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
      `phase2 gate accounting incomplete: missing=[${missing}] duplicates=[${duplicates}] extra=[${extra}]`,
    )
  }
}

async function gate02BoundedReplayWhileWebAbsent(h: RuntimeHarness): Promise<void> {
  const caseId = 'P2-G02'
  const ringBytes = 128 * 1024
  const spoolBytes = 512 * 1024
  const supervisor = await h.startSupervisor({
    scenarioId: 'p2-g02-replay',
    env: {
      FRESHELL_RUNTIME_OUTPUT_RING_BYTES: String(ringBytes),
      FRESHELL_RUNTIME_OUTPUT_SPOOL_BYTES: String(spoolBytes),
    },
  })
  const epoch = await controlEpoch(h, supervisor)
  const shell = await launchShell(h, supervisor, { caseId, epoch, projectKey: 'p2-replay' })
  const web = h.startWebLifetimeSentinel('p2-g02-replay')
  const command = `python3 -c 'import sys; [sys.stdout.write("P2R%06d %s\\n" % (i, "x"*100)) for i in range(16000)]; sys.stdout.flush()'\n`
  await h.adminOk(supervisor, h.terminalInputBody(shell.soulId, command, epoch), { requestId: newRequest() })
  h.stopTrackedContainerExact(web)

  // Required offline window: no web/browser projection reads the spool for 60s.
  await sleep(60_000)
  h.assert(caseId, h.isContainerRunning(shell.containerId), 'worker remains alive after sixty seconds with no web/browser', shell)

  let expired: any | undefined
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const batch = dataOf(await h.adminOk(supervisor, h.terminalReadOutputBody(shell.soulId, 0, 64 * 1024, epoch)), 'terminal_output')
    if (batch.resetRequired) {
      expired = batch
      break
    }
    await sleep(150)
  }
  h.assert(caseId, expired?.resetRequired === true, 'cursor older than retained spool returns an explicit reset', expired)
  h.assert(caseId, expired.truncated === true, 'expired-cursor batch is marked truncated', expired)
  assertOrderedUniqueFrames(h, caseId, expired.frames)

  const replayA = dataOf(await h.adminOk(
    supervisor,
    h.terminalReadOutputBody(shell.soulId, expired.retainedFromSeq - 1, 64 * 1024, epoch),
  ), 'terminal_output')
  const replayB = dataOf(await h.adminOk(
    supervisor,
    h.terminalReadOutputBody(shell.soulId, expired.retainedFromSeq - 1, 64 * 1024, epoch),
  ), 'terminal_output')
  h.assert(caseId, JSON.stringify(replayA.frames) === JSON.stringify(replayB.frames), 'same cursor replay is deterministic and dedupable', { replayA, replayB })
  assertOrderedUniqueFrames(h, caseId, replayA.frames)

  const runtimeDir = h.runtimeDir(supervisor, shell.incarnationId)
  const spoolPaths = ['terminal-spool-previous.jsonl', 'terminal-spool-current.jsonl'].map((name) => path.join(runtimeDir, name))
  const actualSpoolBytes = spoolPaths.reduce((sum, file) => sum + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0)
  h.assert(
    caseId,
    actualSpoolBytes <= spoolBytes + 2 * 64 * 1024,
    'rotating spool remains within configured bound plus at most one transport frame per segment',
    { actualSpoolBytes, spoolBytes, spoolPaths },
  )
  const hostEnv = h.execOwnedContainerExact(shell.containerId, ['sh', '-lc', 'printf "%s %s" "$FRESHELL_RUNTIME_OUTPUT_RING_BYTES" "$FRESHELL_RUNTIME_OUTPUT_SPOOL_BYTES"'])
  h.assert(caseId, hostEnv.trim() === `${ringBytes} ${spoolBytes}`, 'session host received explicit replay bounds', hostEnv)
  const stop = dataOf(await h.adminOk(supervisor, h.stopBody(shell.soulId, epoch)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty', 'bounded replay soul stops cleanly')
}

async function gate03SupervisorRestartAdoptsHost(h: RuntimeHarness): Promise<void> {
  const caseId = 'P2-G03'
  const first = await h.startSupervisor({ scenarioId: 'p2-g03-adopt' })
  const epoch1 = await controlEpoch(h, first)
  const requestId = newRequest()
  const terminal = terminalSpec(h, { caseId, projectKey: 'p2-adopt' })
  const soulId = newSoul()
  const launchBody1 = h.launchBody({
    soulId,
    limits: PHASE2_TEST_LIMITS,
    profile: 'test_fixture',
    projectKey: 'p2-adopt',
    provider: 'shell',
    terminal,
    expectedControlEpoch: epoch1,
  })
  const launch1 = dataOf(await h.adminOk(first, launchBody1, { requestId }), 'launch')
  await h.adminOk(first, h.terminalInputBody(soulId, "sleep 120 & printf 'CHILD=%s\\n' $!\n", epoch1), { requestId: newRequest() })
  const childText = await waitForOutput(h, first, soulId, epoch1, /CHILD=(\d+)/)
  const childPid = Number(childText.match(/CHILD=(\d+)/)?.[1])
  h.assert(caseId, childPid > 0, 'long child started before supervisor restart', childText)

  h.stopSupervisorExact(first)
  h.removeContainerExact(first.containerId)
  h.assert(caseId, h.isContainerRunning(launch1.view.containerId), 'runtime survives graceful supervisor stop', launch1)
  const second = await h.startSupervisor({ scenarioId: 'p2-g03-adopt', volumeName: first.volumeName })
  const epoch2 = await controlEpoch(h, second)
  h.assert(caseId, epoch2 > epoch1, 'new supervisor advances durable control epoch', { epoch1, epoch2 })
  const launchBody2 = h.launchBody({
    soulId,
    limits: PHASE2_TEST_LIMITS,
    profile: 'test_fixture',
    projectKey: 'p2-adopt',
    provider: 'shell',
    terminal,
    expectedControlEpoch: epoch2,
  })
  const launch2 = dataOf(await h.adminOk(second, launchBody2, { requestId }), 'launch')
  h.assert(caseId, launch2.view.incarnationId === launch1.view.incarnationId, 'same incarnation adopted after supervisor restart', { launch1, launch2 })
  h.assert(caseId, launch2.view.containerId === launch1.view.containerId, 'same container adopted after supervisor restart', { launch1, launch2 })
  h.assert(caseId, launch2.hostBootId === launch1.hostBootId && launch2.workerPid === launch1.workerPid, 'same host boot and PTY child survive supervisor restart', { launch1, launch2 })
  h.assert(caseId, launch2.workerLaunchCount === 1, 'supervisor adoption did not launch a replacement provider', launch2)

  const stale = await h.adminRaw(second, h.terminalInputBody(soulId, "echo SHOULD_NOT_RUN\n", epoch1), { requestId: newRequest() })
  h.assert(caseId, stale.result.Err?.code === 'STALE_CONTROL_EPOCH', 'old control epoch is rejected before terminal input', stale)

  // Abrupt controller death: remove exactly the owned supervisor container
  // without its graceful stop path, then adopt the same live host once more.
  h.removeContainerExact(second.containerId)
  h.assert(caseId, h.isContainerRunning(launch1.view.containerId), 'runtime survives abrupt supervisor removal', launch1)
  const childAliveAfterCrash = h.execOwnedContainerExact(launch1.view.containerId, [
    'sh', '-lc', `if test -d /proc/${childPid}; then printf alive; fi`,
  ]).trim()
  h.assert(caseId, childAliveAfterCrash === 'alive', 'long child PID survives abrupt supervisor removal', { childPid, childAliveAfterCrash })

  const third = await h.startSupervisor({ scenarioId: 'p2-g03-adopt', volumeName: first.volumeName })
  const epoch3 = await controlEpoch(h, third)
  h.assert(caseId, epoch3 > epoch2, 'post-crash supervisor advances the durable control epoch again', { epoch1, epoch2, epoch3 })
  const launch3 = dataOf(await h.adminOk(third, h.launchBody({
    soulId,
    limits: PHASE2_TEST_LIMITS,
    profile: 'test_fixture',
    projectKey: 'p2-adopt',
    provider: 'shell',
    terminal,
    expectedControlEpoch: epoch3,
  }), { requestId: newRequest() }), 'launch')
  h.assert(caseId, launch3.view.incarnationId === launch1.view.incarnationId, 'same incarnation adopted after abrupt supervisor restart', { launch1, launch3 })
  h.assert(caseId, launch3.view.containerId === launch1.view.containerId, 'same container adopted after abrupt supervisor restart', { launch1, launch3 })
  h.assert(caseId, launch3.hostBootId === launch1.hostBootId && launch3.workerPid === launch1.workerPid, 'same host boot and PTY child survive abrupt supervisor restart', { launch1, launch3 })
  h.assert(caseId, launch3.workerLaunchCount === 1, 'abrupt supervisor recovery did not launch a replacement provider', launch3)

  const staleAfterCrash = await h.adminRaw(third, h.terminalInputBody(soulId, "echo SHOULD_NOT_RUN_AFTER_CRASH\n", epoch2), { requestId: newRequest() })
  h.assert(caseId, staleAfterCrash.result.Err?.code === 'STALE_CONTROL_EPOCH', 'pre-crash control epoch is rejected before terminal input', staleAfterCrash)
  await h.adminOk(third, h.terminalInputBody(soulId, "echo P2_G03_CURRENT\n", epoch3), { requestId: newRequest() })
  const output = await waitForOutput(h, third, soulId, epoch3, /P2_G03_CURRENT/)
  h.assert(caseId, !output.includes('SHOULD_NOT_RUN'), 'stale control produced no terminal side effect across either restart', output)
  const stop = dataOf(await h.adminOk(third, h.stopBody(soulId, epoch3)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty', 'twice-adopted runtime remains authoritatively stoppable')
}

async function gate05CpuQuota(h: RuntimeHarness): Promise<void> {
  const caseId = 'P2-G05'
  const supervisor = await h.startSupervisor({ scenarioId: 'p2-g05-cpu' })
  const sentinel = h.startWebLifetimeSentinel('p2-g05-cpu-sentinel')
  const epoch = await controlEpoch(h, supervisor)
  const soulId = newSoul()
  const launch = dataOf(await h.adminOk(supervisor, h.launchBody({
    soulId,
    limits: PHASE2_TEST_LIMITS,
    profile: 'test_fixture',
    projectKey: 'p2-cpu',
    fixture: 'cpu_burner',
    expectedControlEpoch: epoch,
  })), 'launch')
  const cpuMax = h.execOwnedContainerExact(launch.view.containerId, ['cat', '/sys/fs/cgroup/cpu.max']).trim()
  const [quota, period] = cpuMax.split(/\s+/).map(Number)
  h.assert(caseId, Number.isFinite(quota) && Number.isFinite(period) && Math.round((quota / period) * 1000) === 500, 'effective cpu.max is 500 milliCPU', { cpuMax, launch })
  await sleep(3_000)
  const before = dataOf(await h.adminOk(supervisor, h.runtimeMetricsBody(soulId, epoch)), 'runtime_metrics')
  const started = Date.now()
  await sleep(30_000)
  const elapsedSec = (Date.now() - started) / 1000
  const after = dataOf(await h.adminOk(supervisor, h.runtimeMetricsBody(soulId, epoch)), 'runtime_metrics')
  const cpuUsec = after.cpuUsageUsec - before.cpuUsageUsec
  const cpuSecondsPerSecond = cpuUsec / 1_000_000 / elapsedSec
  h.assert(caseId, cpuSecondsPerSecond <= 0.60, 'aggregate cgroup CPU stays at or below 0.60 CPU-seconds/second', { before, after, elapsedSec, cpuSecondsPerSecond })
  if (after.cpuNrThrottled <= before.cpuNrThrottled) {
    throw new RuntimeGateBlockedError(caseId, 'host did not expose a schedulable throttling increase during the 30s burn window', { before, after, elapsedSec })
  }
  h.assert(caseId, after.cpuThrottledUsec >= before.cpuThrottledUsec, 'throttled CPU accounting is monotonic', { before, after })
  h.execOwnedContainerExact(sentinel, ['true'])
  h.assert(caseId, h.isContainerRunning(sentinel), 'independent sentinel remains responsive during CPU saturation')
  const stop = dataOf(await h.adminOk(supervisor, h.stopBody(soulId, epoch)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty', 'CPU-burner enclosure cleans up completely')
}

async function gate06MemoryOomChildOnly(h: RuntimeHarness): Promise<void> {
  const caseId = 'P2-G06'
  const supervisor = await h.startSupervisor({ scenarioId: 'p2-g06-oom' })
  const sentinel = h.startWebLifetimeSentinel('p2-g06-oom-sentinel')
  const epoch = await controlEpoch(h, supervisor)
  const shell = await launchShell(h, supervisor, { caseId, epoch, projectKey: 'p2-oom' })
  const memoryMax = h.execOwnedContainerExact(shell.containerId, ['cat', '/sys/fs/cgroup/memory.max']).trim()
  const swapMax = h.execOwnedContainerExact(shell.containerId, ['cat', '/sys/fs/cgroup/memory.swap.max']).trim()
  h.assert(caseId, Number(memoryMax) === PHASE2_TEST_LIMITS.memoryBytes && Number(swapMax) === 0, 'effective memory and swap bounds match the fixture profile', { memoryMax, swapMax })
  const before = dataOf(await h.adminOk(supervisor, h.runtimeMetricsBody(shell.soulId, epoch)), 'runtime_metrics')
  const command = `node --max-old-space-size=1024 -e "const a=[]; setInterval(()=>a.push(Buffer.alloc(16*1024*1024,1)),5)"; printf 'OOM_CHILD_EXIT=%s\\n' $?\n`
  await h.adminOk(supervisor, h.terminalInputBody(shell.soulId, command, epoch), { requestId: newRequest() })
  let after: any = before
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await sleep(250)
    after = dataOf(await h.adminOk(supervisor, h.runtimeMetricsBody(shell.soulId, epoch)), 'runtime_metrics')
    if (after.memoryOomKill > before.memoryOomKill) break
  }
  h.assert(caseId, after.memoryOomKill > before.memoryOomKill, 'cgroup records a real OOM kill beyond the 256 MiB cap', { before, after })
  h.assert(caseId, h.isContainerRunning(shell.containerId), 'child-only OOM does not kill the session host/container')
  h.execOwnedContainerExact(sentinel, ['true'])
  h.assert(caseId, h.isContainerRunning(sentinel), 'unrelated sentinel survives the OOM')
  await h.adminOk(supervisor, h.terminalInputBody(shell.soulId, "echo AFTER_OOM_HOST_ALIVE\n", epoch), { requestId: newRequest() })
  const output = await waitForOutput(h, supervisor, shell.soulId, epoch, /AFTER_OOM_HOST_ALIVE/, 20_000)
  h.assert(caseId, /OOM_CHILD_EXIT|Killed|AFTER_OOM_HOST_ALIVE/.test(output), 'host reports provider-child exit and remains usable', output.slice(-8000))
  const replay = dataOf(await h.adminOk(supervisor, h.launchBody({
    soulId: shell.soulId,
    limits: PHASE2_TEST_LIMITS,
    profile: 'test_fixture',
    projectKey: 'p2-oom',
    provider: 'shell',
    terminal: shell.terminal,
    expectedControlEpoch: epoch,
  }), { requestId: shell.launchRequestId }), 'launch')
  h.assert(caseId, replay.view.launchState === 'running' && replay.view.containerId === shell.containerId, 'child OOM is not misclassified as a lost/replaced soul', replay)
  const stop = dataOf(await h.adminOk(supervisor, h.stopBody(shell.soulId, epoch)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty', 'OOM-tested runtime still cleans up by exact enclosure')

  // Provider-root OOM: the PTY child itself dies while the trusted session
  // host remains alive. This is the green-zombie shape Phase 2 must surface.
  const rootSoul = newSoul()
  const rootTerminal = terminalSpec(h, {
    caseId,
    projectKey: 'p2-root-oom',
    program: '/usr/local/bin/node',
    args: [
      '--max-old-space-size=1024',
      '-e',
      'const a=[]; setInterval(()=>a.push(Buffer.alloc(16*1024*1024,1)),5)',
    ],
  })
  const rootLaunch = dataOf(await h.adminOk(supervisor, h.launchBody({
    soulId: rootSoul,
    limits: PHASE2_TEST_LIMITS,
    profile: 'test_fixture',
    projectKey: 'p2-root-oom',
    provider: 'shell',
    terminal: rootTerminal,
    expectedControlEpoch: epoch,
  }), { requestId: newRequest() }), 'launch')
  const rootBefore = dataOf(await h.adminOk(supervisor, h.runtimeMetricsBody(rootSoul, epoch)), 'runtime_metrics')
  let rootMetrics: any = rootBefore
  let rootOutput: any = null
  const rootDeadline = Date.now() + 30_000
  while (Date.now() < rootDeadline) {
    await sleep(250)
    rootMetrics = dataOf(await h.adminOk(supervisor, h.runtimeMetricsBody(rootSoul, epoch)), 'runtime_metrics')
    rootOutput = dataOf(await h.adminOk(supervisor, h.terminalReadOutputBody(rootSoul, 0, 64 * 1024, epoch)), 'terminal_output')
    if (rootMetrics.memoryOomKill > rootBefore.memoryOomKill && rootOutput.exited) break
  }
  h.assert(caseId, rootMetrics.memoryOomKill > rootBefore.memoryOomKill, 'provider-root allocation is OOM-killed by the same 256 MiB cgroup', { rootBefore, rootMetrics })
  h.assert(caseId, rootOutput?.exited === true && typeof rootOutput?.exitCode === 'number' && rootOutput.exitCode !== 0, 'host reports PTY-root exit and nonzero exit code through terminal output status', rootOutput)
  h.assert(caseId, h.isContainerRunning(rootLaunch.view.containerId), 'session host/container survives provider-root OOM long enough to report it')
  const rootStop = dataOf(await h.adminOk(supervisor, h.stopBody(rootSoul, epoch)), 'stop')
  h.assert(caseId, rootStop.outcome === 'verified_empty', 'dead provider enclosure is still authoritatively stopped and released')
}

export async function gate07PidCeilingAndSetsid(h: RuntimeHarness): Promise<void> {
  const caseId = 'P2-G07'
  const supervisor = await h.startSupervisor({ scenarioId: 'p2-g07-pids' })
  const epoch = await controlEpoch(h, supervisor)
  const shell = await launchShell(h, supervisor, { caseId, epoch, projectKey: 'p2-pids' })
  const pressureProgram = `import os,time\np=os.fork()\nif p==0:\n os.setsid()\n q=os.fork()\n if q==0: time.sleep(120)\n os._exit(0)\ncount=0\nerr=0\nwhile count < 200:\n try:\n  p=os.fork()\n  if p==0:\n   time.sleep(120); os._exit(0)\n  count += 1\n except OSError as e:\n  err=e.errno; break\nprint(f'PID_RESULT count={count} errno={err}', flush=True)\n`
  const encoded = Buffer.from(pressureProgram).toString('base64')
  const script = `python3 -c "import base64;exec(base64.b64decode('${encoded}'))"\n`
  await h.adminOk(supervisor, h.terminalInputBody(shell.soulId, script, epoch), { requestId: newRequest() })
  const output = await waitForOutput(h, supervisor, shell.soulId, epoch, /PID_RESULT count=\d+ errno=\d+/, 30_000)
  h.assert(caseId, /PID_RESULT count=\d+ errno=11/.test(output), 'cgroup PID ceiling rejects additional forks with EAGAIN', output.slice(-8000))
  const metrics = dataOf(await h.adminOk(supervisor, h.runtimeMetricsBody(shell.soulId, epoch)), 'runtime_metrics')
  h.assert(caseId, metrics.pidsMax === 64 && metrics.pidsCurrent <= 64, 'effective pids.max is enforced for whole workload', metrics)
  const top = h.topOwnedContainerExact(shell.containerId)
  const processRows = top.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(1)
  const sessionLeaders = processRows.filter((line) => {
    const fields = line.split(/\s+/)
    return fields.length >= 3 && fields[0] === fields[2]
  })
  h.assert(caseId, processRows.length > 1 && processRows.length <= 64, 'all visible descendants remain inside the one receipt-owned container', { processRows: processRows.slice(0, 80), metrics })
  h.assert(caseId, sessionLeaders.length >= 2, 'setsid descendant created an additional session leader without escaping the container', sessionLeaders)
  const stop = dataOf(await h.adminOk(supervisor, h.stopBody(shell.soulId, epoch)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty' && !h.isContainerRunning(shell.containerId), 'all bounded descendants are cleaned with the enclosure')
}

export async function gate08TransactionalAdmissionAndSecondView(h: RuntimeHarness): Promise<void> {
  const caseId = 'P2-G08'
  const supervisor = await h.startSupervisor({
    scenarioId: 'p2-g08-admission',
    projectBudget: PHASE2_TEST_LIMITS,
    installationBudget: { cpuMilli: 4_000, memoryBytes: 2 * 1024 * 1024 * 1024, swapBytes: 0, pidsMax: 1_024 },
  })
  const epoch = await controlEpoch(h, supervisor)
  const projectKey = 'p2-one-slot'
  const soulA = newSoul()
  const soulB = newSoul()
  const receiptsBefore = h.broker.receipts().length
  const a = h.adminRaw(supervisor, h.launchBody({ soulId: soulA, limits: PHASE2_TEST_LIMITS, profile: 'test_fixture', projectKey, fixture: 'heartbeat', expectedControlEpoch: epoch }), { requestId: newRequest() })
  const b = h.adminRaw(supervisor, h.launchBody({ soulId: soulB, limits: PHASE2_TEST_LIMITS, profile: 'test_fixture', projectKey, fixture: 'heartbeat', expectedControlEpoch: epoch }), { requestId: newRequest() })
  const replies = await Promise.all([a, b])
  const successes = replies.filter((reply) => reply.result.Ok?.kind === 'launch')
  const blocked = replies.filter((reply) => reply.result.Err?.code === 'BLOCKED_RESOURCE')
  h.assert(caseId, successes.length === 1 && blocked.length === 1, 'concurrent one-slot project admission commits exactly one reservation', replies)
  h.assert(caseId, h.broker.receipts().length === receiptsBefore + 1, 'blocked launch creates no Docker enclosure', h.broker.receipts())
  const winner = dataOf(successes[0].result.Ok, 'launch')
  const winnerSoul = winner.view.soulId as string
  const receiptsBeforeViews = h.broker.receipts().length
  await Promise.all([
    h.adminOk(supervisor, h.runtimeMetricsBody(winnerSoul, epoch)),
    h.adminOk(supervisor, h.runtimeMetricsBody(winnerSoul, epoch)),
  ])
  h.assert(caseId, h.broker.receipts().length === receiptsBeforeViews, 'second view/read of one soul consumes no worker or reservation', h.broker.receipts())
  const inventory = dataOf(await h.adminOk(supervisor, { method: 'inventory' }), 'inventory')
  const active = inventory.filter((row: any) => row.launchState === 'running')
  h.assert(caseId, active.length === 1 && active[0].containerId === winner.view.containerId, 'aggregate admitted set remains exactly one active runtime', inventory)
  const stop = dataOf(await h.adminOk(supervisor, h.stopBody(winnerSoul, epoch)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty', 'reservation is released only after verified stop')
}

export async function gate09GitWorktreeProviderPersistence(h: RuntimeHarness): Promise<void> {
  const caseId = 'P2-G09'
  const worktree = path.join(h.testRoot, 'p2-g09-worktree')
  h.runCommand('git', ['worktree', 'add', '--detach', worktree, 'HEAD'], { cwd: h.repoRoot })
  try {
    const supervisor = await h.startSupervisor({ scenarioId: 'p2-g09-git' })
    const epoch = await controlEpoch(h, supervisor)
    const common = canonicalGitCommon(h, worktree)
    const soulId = newSoul()
    const projectKey = 'p2-git-worktree'
    const launchRequestId = newRequest()
    const terminal = terminalSpec(h, { caseId, projectKey, workspace: worktree, cwd: worktree, gitCommonDir: common })
    const launch = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId, limits: PHASE2_TEST_LIMITS, profile: 'test_fixture', projectKey, provider: 'shell', terminal, expectedControlEpoch: epoch }), { requestId: launchRequestId }), 'launch')
    const containerId = launch.view.containerId as string
    const webA = h.startWebLifetimeSentinel('p2-g09-web-a')
    const cmd = `printf '\nphase2-managed-edit\n' >> README.md; git status --short README.md; node --version; printf 'provider-state\n' > "$HOME/provider-marker"; printf 'P2_G09_DONE:%s\n' "$PWD"\n`
    await h.adminOk(supervisor, h.terminalInputBody(soulId, cmd, epoch), { requestId: newRequest() })
    const donePattern = new RegExp(`P2_G09_DONE:${escapeRegExp(worktree)}`)
    const output = await waitForOutput(h, supervisor, soulId, epoch, donePattern, 30_000)
    const cleanOutput = stripAnsi(output)
    h.assert(caseId, / M README\.md/.test(cleanOutput) && cleanOutput.includes('v22.23.2') && donePattern.test(cleanOutput), 'real worktree edit, git status, and pinned Node build tool work inside runtime', output.slice(-8000))
    h.assert(caseId, fs.readFileSync(path.join(worktree, 'README.md'), 'utf8').includes('phase2-managed-edit'), 'workspace edit persists on host worktree')
    await h.adminOk(supervisor, h.terminalInputBody(soulId, `cat "$HOME/provider-marker"; echo PROVIDER_MARKER_READ_1\n`, epoch), { requestId: newRequest() })
    const providerRead1 = stripAnsi(await waitForOutput(h, supervisor, soulId, epoch, /PROVIDER_MARKER_READ_1/, 20_000))
    h.assert(caseId, providerRead1.includes('provider-state'), 'per-soul provider state volume is writable/readable by the provider identity', providerRead1.slice(-4000))
    const securityProgram = `import os,socket,re\nsecret=os.access('/run/freshell/secret',os.R_OK)\nconnected=False\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)\ntry:\n s.connect('/run/freshell/host.sock'); connected=True\nexcept OSError:\n pass\nfinally:\n s.close()\nstatus=open('/proc/self/status').read()\ncap=re.search(r'^CapEff:\\s*([0-9a-fA-F]+)',status,re.M).group(1)\nprint(f'SECURITY_RESULT uid={os.getuid()} gid={os.getgid()} capeff={cap} secret={int(secret)} connected={int(connected)}',flush=True)\n`
    const securityEncoded = Buffer.from(securityProgram).toString('base64')
    await h.adminOk(supervisor, h.terminalInputBody(soulId, `python3 -c "import base64;exec(base64.b64decode('${securityEncoded}'))"\n`, epoch), { requestId: newRequest() })
    const securityOutput = stripAnsi(await waitForOutput(h, supervisor, soulId, epoch, /SECURITY_RESULT uid=65534 gid=0 capeff=0+ secret=0 connected=0/, 20_000))
    h.assert(caseId, /SECURITY_RESULT uid=65534 gid=0 capeff=0+ secret=0 connected=0/.test(securityOutput), 'provider PTY is unprivileged and cannot read or connect to host control authority', securityOutput.slice(-4000))
    const safety = h.execOwnedContainerExact(containerId, ['sh', '-lc', 'test ! -S /var/run/docker.sock && test ! -S /run/freshell-supervisor/supervisor.sock && test ! -e /var/lib/freshell-supervisor/runtime.sqlite3 && echo SAFE']).trim()
    h.assert(caseId, safety === 'SAFE', 'workload cannot see Docker socket, supervisor control, or registry')

    h.stopTrackedContainerExact(webA)
    h.removeContainerExact(webA)
    const webB = h.startWebLifetimeSentinel('p2-g09-web-b')
    h.assert(caseId, h.isContainerRunning(containerId) && h.isContainerRunning(webB), 'recreating only web leaves the runtime container unchanged')
    const replay = dataOf(await h.adminOk(supervisor, h.launchBody({ soulId, limits: PHASE2_TEST_LIMITS, profile: 'test_fixture', projectKey, provider: 'shell', terminal, expectedControlEpoch: epoch }), { requestId: launchRequestId }), 'launch')
    h.assert(caseId, replay.view.containerId === containerId && replay.hostBootId === launch.hostBootId, 'saved cwd/provider runtime survives web recreation without replacement', { launch, replay })
    await h.adminOk(supervisor, h.terminalInputBody(soulId, `cat "$HOME/provider-marker"; echo PROVIDER_MARKER_READ_2\n`, epoch), { requestId: newRequest() })
    const providerRead2 = stripAnsi(await waitForOutput(h, supervisor, soulId, epoch, /PROVIDER_MARKER_READ_2/, 20_000))
    h.assert(caseId, providerRead2.includes('provider-state'), 'provider volume persists through web recreation', providerRead2.slice(-4000))
    const stop = dataOf(await h.adminOk(supervisor, h.stopBody(soulId, epoch)), 'stop')
    h.assert(caseId, stop.outcome === 'verified_empty', 'git-worktree soul stops cleanly')
  } finally {
    h.runCommand('git', ['worktree', 'remove', '--force', worktree], { cwd: h.repoRoot })
  }
}

export async function gate10DroppedAckDedupeAndStopWins(h: RuntimeHarness): Promise<void> {
  const caseId = 'P2-G10'
  const supervisor = await h.startSupervisor({ scenarioId: 'p2-g10-dedupe' })
  const epoch = await controlEpoch(h, supervisor)
  const shell = await launchShell(h, supervisor, { caseId, epoch, projectKey: 'p2-dedupe' })
  const inputRequestId = newRequest()
  const marker = `DROP_ACK_${randomUUID().replaceAll('-', '')}`
  const body = h.terminalInputBody(shell.soulId, `echo ${marker}\n`, epoch)
  await h.adminSendAndDrop(supervisor, body, { requestId: inputRequestId })
  await sleep(300)
  const replay = dataOf(await h.adminOk(supervisor, body, { requestId: inputRequestId }), 'terminal_input')
  h.assert(caseId, replay.state === 'completed', 'retry after lost web acknowledgment returns durable completed state', replay)
  const conflict = await h.adminRaw(supervisor, h.terminalInputBody(shell.soulId, `echo CONFLICT_${marker}\n`, epoch), { requestId: inputRequestId })
  h.assert(caseId, conflict.result.Err?.code === 'REQUEST_ID_CONFLICT', 'same input request id with changed payload is rejected', conflict)
  const output = await waitForOutput(h, supervisor, shell.soulId, epoch, new RegExp(marker), 20_000)
  const occurrences = output.split(marker).length - 1
  // PTY echo + command output can each include the marker. The durable dispatch
  // count is therefore pinned by comparing against one normal shell command's
  // two appearances, not by assuming the PTY has echo disabled.
  h.assert(caseId, occurrences >= 1 && occurrences <= 2, 'lost-ack retry did not dispatch the command twice', { occurrences, output: output.slice(-8000) })
  h.assert(caseId, !output.includes(`CONFLICT_${marker}`), 'conflicting retry produced no PTY side effect', output.slice(-8000))

  const receipts = h.broker.receipts().length
  await h.adminSendAndDrop(supervisor, h.terminalInputBody(shell.soulId, "sleep 30 & echo STOP_RACE_STARTED\n", epoch), { requestId: newRequest() })
  const stop = dataOf(await h.adminOk(supervisor, h.stopBody(shell.soulId, epoch)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty', 'durable user stop wins while an input acknowledgment is absent', stop)
  await sleep(500)
  h.assert(caseId, h.broker.receipts().length === receipts && !h.isContainerRunning(shell.containerId), 'web/input callback creates no replacement after stop', h.broker.receipts())
}

export async function gate11NamedControllerRestartAndHostRecreation(h: RuntimeHarness): Promise<void> {
  const caseId = 'P2-G11'
  const first = await h.startSupervisor({ scenarioId: 'p2-g11-host' })
  const epoch1 = await controlEpoch(h, first)
  const requestId = newRequest()
  const terminal = terminalSpec(h, { caseId, projectKey: 'p2-host-recreate' })
  const soulId = newSoul()
  const launch = dataOf(await h.adminOk(first, h.launchBody({ soulId, limits: PHASE2_TEST_LIMITS, profile: 'test_fixture', projectKey: 'p2-host-recreate', provider: 'shell', terminal, expectedControlEpoch: epoch1 }), { requestId }), 'launch')
  const runtimeDir = h.runtimeDir(first, launch.view.incarnationId)
  const statePath = path.join(runtimeDir, 'host-state.json')
  const beforeState = JSON.parse(fs.readFileSync(statePath, 'utf8'))

  // Named controller restart: only the supervisor container is replaced.
  h.stopSupervisorExact(first)
  h.removeContainerExact(first.containerId)
  const second = await h.startSupervisor({ scenarioId: 'p2-g11-host', volumeName: first.volumeName })
  const epoch2 = await controlEpoch(h, second)
  h.assert(caseId, h.isContainerRunning(launch.view.containerId), 'named supervisor restart preserves session host')
  const adopted = dataOf(await h.adminOk(second, h.launchBody({ soulId, limits: PHASE2_TEST_LIMITS, profile: 'test_fixture', projectKey: 'p2-host-recreate', provider: 'shell', terminal, expectedControlEpoch: epoch2 }), { requestId }), 'launch')
  h.assert(caseId, adopted.hostBootId === launch.hostBootId && adopted.workerPid === launch.workerPid, 'controller restart preserves host boot and provider process')

  // Intentionally recreate exactly the owned runtime container. This is NOT an
  // ordinary web/supervisor restart and is receipt-gated by the harness.
  h.restartOwnedRuntimeExact(launch.view.containerId)
  const changed = await waitForHostBootChange(statePath, beforeState.hostBootId, 15_000)
  h.assert(caseId, changed.hostBootId !== beforeState.hostBootId, 'intentional host recreation changes hostBootId', { beforeState, changed })
  const receiptsBefore = h.broker.receipts().length
  const retry = await h.adminRaw(second, h.launchBody({ soulId, limits: PHASE2_TEST_LIMITS, profile: 'test_fixture', projectKey: 'p2-host-recreate', provider: 'shell', terminal, expectedControlEpoch: epoch2 }), { requestId })
  h.assert(caseId, retry.result.Err?.code === 'HOST_UNREACHABLE', 'recreated host cannot silently execute the old grant or fabricate a running worker', retry)
  h.assert(caseId, h.broker.receipts().length === receiptsBefore, 'host recreation does not create an unregistered second provider/runtime', h.broker.receipts())

  const mise = path.join(os.homedir(), '.local', 'bin', 'mise')
  const unit = h.runCommand(mise, ['exec', 'rust@1.96', '--', 'cargo', 'test', '-p', 'freshell-session-host', 'grant_from_another_host_boot_is_rejected_before_consumption', '--', '--nocapture'])
  h.assert(caseId, /grant_from_another_host_boot_is_rejected_before_consumption \.\.\. ok/.test(unit), 'old host-boot grant rejection is pinned by the host control test', unit.slice(-4000))

  const compose = fs.readFileSync(path.join(h.repoRoot, 'docker/runtime/compose.yaml'), 'utf8')
  h.assert(caseId, /services:\s*\n\s*supervisor:/.test(compose) && /\n\s*web:/.test(compose), 'deployment topology names web and supervisor services', compose)
  h.assert(caseId, !/session-host:|runtime-host:/.test(compose), 'dynamic hosts are not Compose-owned services', compose)
  const stop = dataOf(await h.adminOk(second, h.stopBody(soulId, epoch2)), 'stop')
  h.assert(caseId, stop.outcome === 'verified_empty', 'intentionally recreated owned host remains authoritatively stoppable')
}

type LaunchedShell = {
  soulId: string
  containerId: string
  incarnationId: string
  hostBootId: string
  workerPid: number
  terminal: Record<string, unknown>
  launchRequestId: string
}

async function launchShell(
  h: RuntimeHarness,
  supervisor: SupervisorInstance,
  options: { caseId: string; epoch: number; projectKey: string; workspace?: string; cwd?: string },
): Promise<LaunchedShell> {
  const soulId = newSoul()
  const launchRequestId = newRequest()
  const terminal = terminalSpec(h, {
    caseId: options.caseId,
    projectKey: options.projectKey,
    workspace: options.workspace,
    cwd: options.cwd,
  })
  const launch = dataOf(await h.adminOk(supervisor, h.launchBody({
    soulId,
    limits: PHASE2_TEST_LIMITS,
    profile: 'test_fixture',
    projectKey: options.projectKey,
    provider: 'shell',
    terminal,
    expectedControlEpoch: options.epoch,
  }), { requestId: launchRequestId }), 'launch')
  h.assert(options.caseId, launch.effectiveLimits.cpuMilli === 500 && launch.effectiveLimits.memoryBytes === PHASE2_TEST_LIMITS.memoryBytes && launch.effectiveLimits.pidsMax === 64, 'test_fixture effective limits match the named profile', launch)
  return {
    soulId,
    containerId: launch.view.containerId,
    incarnationId: launch.view.incarnationId,
    hostBootId: launch.hostBootId,
    workerPid: launch.workerPid,
    terminal,
    launchRequestId,
  }
}

function terminalSpec(
  h: RuntimeHarness,
  options: {
    caseId: string
    projectKey: string
    workspace?: string
    cwd?: string
    gitCommonDir?: string
    mode?: string
    program?: string
    args?: string[]
    env?: Record<string, string>
  },
): Record<string, unknown> {
  const workspace = fs.realpathSync(options.workspace ?? h.repoRoot)
  const cwd = fs.realpathSync(options.cwd ?? workspace)
  const gitCommonDir = options.gitCommonDir ?? canonicalGitCommon(h, workspace)
  return {
    terminalId: `terminal-${options.caseId.toLowerCase()}-${randomUUID()}`,
    streamId: `stream-${randomUUID()}`,
    mode: options.mode ?? 'shell',
    program: options.program ?? '/bin/bash',
    args: options.args ?? ['--noprofile', '--norc'],
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      HOME: '/home/freshell/provider',
      ...options.env,
    },
    cwd,
    runAsUid: 65_534,
    runAsGid: 0,
    cols: 100,
    rows: 30,
    projectKey: options.projectKey,
    workspacePath: workspace,
    gitCommonDir,
    createRequestId: `create-${options.caseId.toLowerCase()}-${randomUUID()}`,
  }
}

function canonicalGitCommon(h: RuntimeHarness, cwd: string): string {
  const raw = h.runCommand('git', ['rev-parse', '--git-common-dir'], { cwd }).trim()
  return fs.realpathSync(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw))
}

async function controlEpoch(h: RuntimeHarness, supervisor: SupervisorInstance): Promise<number> {
  const health = dataOf(await h.adminOk(supervisor, { method: 'health' }), 'health')
  return numericField(health, 'control_epoch', 'controlEpoch')
}

async function waitForOutput(
  h: RuntimeHarness,
  supervisor: SupervisorInstance,
  soulId: string,
  epoch: number,
  pattern: RegExp,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let cursor = 0
  let output = ''
  while (Date.now() < deadline) {
    const batch = dataOf(await h.adminOk(supervisor, h.terminalReadOutputBody(soulId, cursor, 64 * 1024, epoch)), 'terminal_output')
    assertOrderedUniqueFrames(h, 'output-helper', batch.frames)
    for (const frame of batch.frames ?? []) {
      output += frame.data
      cursor = Math.max(cursor, frame.seqEnd ?? frame.seq_end ?? 0)
    }
    if (pattern.test(output)) return output
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${pattern} in terminal output; tail=${output.slice(-8000)}`)
}

function assertOrderedUniqueFrames(h: RuntimeHarness, caseId: string, frames: any[]): void {
  const seqs = (frames ?? []).map((frame) => numericField(frame, 'seqStart', 'seq_start'))
  const ordered = seqs.every((seq, index) => index === 0 || seq > seqs[index - 1])
  h.assert(caseId, ordered && new Set(seqs).size === seqs.length, 'output frames are strictly ordered and unique by sequence', seqs)
}

async function waitForHostBootChange(file: string, previous: string, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let last: any
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (last.hostBootId && last.hostBootId !== previous) return last
    } catch {}
    await sleep(100)
  }
  throw new Error(`host boot id did not change within ${timeoutMs}ms; last=${JSON.stringify(last)}`)
}

function dataOf(result: any, expectedKind: string): any {
  if (!result || result.kind !== expectedKind) throw new Error(`expected ${expectedKind} result, got ${JSON.stringify(result)}`)
  return result.data
}

function numericField(value: any, ...keys: string[]): number {
  for (const key of keys) if (typeof value?.[key] === 'number') return value[key]
  throw new Error(`missing numeric field ${keys.join('/')} in ${JSON.stringify(value)}`)
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
