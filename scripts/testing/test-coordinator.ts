import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { constants as osConstants, hostname, userInfo } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import {
  resolveGitBranchAndDirty,
  resolveGitCheckoutRoot,
  resolveGitCommonDir,
  resolveGitRepoRoot,
  resolveInvocationCwd,
} from './repo-context.js'
import {
  classifyCommand,
  COMMAND_KEYS,
  type CommandDisposition,
  type CommandKey,
  isCommandKey,
  type UpstreamPhase,
} from './coordinator-command-matrix.js'
import { buildCoordinatorEndpoint, tryListen, type ListeningServer } from './coordinator-endpoint.js'
import { logCoordinatorEvent } from './coordinator-log.js'
import {
  buildReusableSuccessKey,
  type HolderRecord,
  type LatestRunRecord,
  type ReusableSuccessRecord,
} from './coordinator-schema.js'
import {
  clearHolderIfRunIdMatches,
  getCoordinatorStoreDir,
  recordCommandResult,
  recordReusableSuccess,
  recordSuiteResult,
  writeHolder,
} from './coordinator-store.js'
import { buildStatusView, renderStatusView } from './coordinator-status.js'
import { RunControl, UngatedPhaseSet, type UngatedRunIdentity } from './coordinator-ungated-phases.js'
import {
  assertNoCoordinatorRecursion,
  describeUpstreamPhase,
  runUpstreamPhase,
  startUpstreamPhase,
  type RunningPhase,
} from './coordinator-upstream.js'

const execFileAsync = promisify(execFile)
const DEFAULT_POLL_MS = 60_000
const DEFAULT_MAX_WAIT_MS = 24 * 60 * 60 * 1000
const DEFAULT_STOP_GRACE_MS = 20_000
const STOP_SIGNALS: NodeJS.Signals[] = process.platform === 'win32'
  ? ['SIGINT', 'SIGTERM']
  : ['SIGINT', 'SIGTERM', 'SIGHUP']

type ParsedRunArgs = {
  commandKey: CommandKey
  forwardedArgs: string[]
  summary?: string
}

type RepoContext = {
  invocationCwd?: string
  checkoutRoot: string
  repoRoot: string
  commonDir: string
  worktreePath: string
  branch?: string
  commit?: string
  isDirty?: boolean
}

type SummaryContext = {
  summary: string
  summarySource: 'flag' | 'env' | 'fallback'
}

type RuntimeContext = {
  nodeVersion: string
  platform: string
  arch: string
}

type CoordinatedRunContext = {
  commandKey: CommandKey
  forwardedArgs: string[]
  disposition: Extract<CommandDisposition, { kind: 'coordinated' }>
  repo: RepoContext
  runtime: RuntimeContext
  summary: SummaryContext
  commandDisplay: string
  runId: string
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const [subcommand, ...rest] = argv

  if (subcommand === 'run') {
    assertNoCoordinatorRecursion(process.env)
    const parsed = parseRunArgs(rest)
    return runCommand(parsed)
  }

  if (subcommand === 'status') {
    return printStatus()
  }

  console.error('Usage: tsx scripts/testing/test-coordinator.ts <run|status> ...')
  return 1
}

async function runCommand(parsed: ParsedRunArgs): Promise<number> {
  const disposition = classifyCommand({
    commandKey: parsed.commandKey,
    forwardedArgs: parsed.forwardedArgs,
    env: process.env,
  })

  if (disposition.kind === 'rejected') {
    console.error(disposition.reason)
    return 1
  }

  const runtime = runtimeContext()
  const summary = summarizeCommand(parsed.commandKey, parsed.forwardedArgs, parsed.summary)
  const commandDisplay = publicCommandDisplay(parsed.commandKey, parsed.forwardedArgs)
  const startedAt = new Date().toISOString()

  if (disposition.kind === 'coordinated') {
    const repo = await resolveRepoContext()
    if (!repo) {
      throw new Error('A coordinated command could not resolve repo metadata.')
    }

    const coordinatedContext: CoordinatedRunContext = {
      commandKey: parsed.commandKey,
      forwardedArgs: parsed.forwardedArgs,
      disposition,
      repo,
      runtime,
      summary,
      commandDisplay,
      runId: randomUUID(),
    }

    return runCoordinatedCommand(coordinatedContext)
  }

  const shouldPersistDelegatedResult = shouldPersistDelegatedCommandResult(parsed.commandKey, parsed.forwardedArgs)
  const repo = shouldPersistDelegatedResult ? await resolveRepoContext() : undefined
  const prePhaseResult = await runPrePhasesIfNeeded({
    commandKey: parsed.commandKey,
    forwardedArgs: parsed.forwardedArgs,
    commandDisplay,
    disposition,
    repo,
    runtime,
    summary,
    startedAt,
  })
  if (prePhaseResult !== undefined) {
    return prePhaseResult
  }

  if (disposition.kind === 'delegated' || disposition.kind === 'passthrough') {
    const exitCode = await runPhases(disposition.phases)
    if (repo) {
      const refreshedRepo = await refreshRepoContext(repo).catch(() => repo)
      await recordCommandResult(getCoordinatorStoreDir(refreshedRepo.commonDir), buildLatestRunRecord({
        runId: randomUUID(),
        commandKey: parsed.commandKey,
        suiteKey: undefined,
        summary,
        commandDisplay,
        forwardedArgs: parsed.forwardedArgs,
        repo: refreshedRepo,
        runtime,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode,
      }))
    }
    return exitCode
  }
  throw new Error('Unsupported coordinator disposition.')
}

async function printStatus(): Promise<number> {
  const repo = await resolveRepoContext()
  const statusView = await buildStatusView({
    commonDir: repo.commonDir,
    commandKey: undefined,
    commit: repo.commit,
    isDirty: repo.isDirty,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  })
  console.log(renderStatusView(statusView))
  return 0
}

function parseRunArgs(args: string[]): ParsedRunArgs {
  const [commandKeyRaw, ...forwarded] = args
  if (!commandKeyRaw) {
    throw new Error('Missing command key for coordinator run mode.')
  }

  if (!isCommandKey(commandKeyRaw)) {
    throw new Error(`Unknown command key "${commandKeyRaw}". Valid command keys: ${COMMAND_KEYS.join(', ')}`)
  }

  const commandKey = commandKeyRaw as CommandKey
  const normalizedForwarded = stripLeadingArgSeparator(forwarded)
  const forwardedArgs: string[] = []
  let summary: string | undefined

  for (let index = 0; index < normalizedForwarded.length; index += 1) {
    const arg = normalizedForwarded[index]
    if (arg === '--summary') {
      summary = normalizedForwarded[index + 1]
      if (!summary) {
        throw new Error('Missing value for --summary.')
      }
      index += 1
      continue
    }
    forwardedArgs.push(arg)
  }

  return {
    commandKey,
    forwardedArgs,
    summary,
  }
}

async function runPrePhasesIfNeeded(
  input: {
    commandKey: CommandKey
    forwardedArgs: string[]
    commandDisplay: string
    disposition: CommandDisposition
    repo: RepoContext | undefined
    runtime: RuntimeContext
    summary: SummaryContext
    startedAt: string
  },
): Promise<number | undefined> {
  if (hasHelpOrVersion(input.forwardedArgs)) {
    return undefined
  }

  const prePhases = prePhasesForCommand(input.commandKey)
  if (prePhases.length === 0) {
    return undefined
  }

  for (const phase of prePhases) {
    const exitCode = await runUpstreamPhase(phase, process.env)
    if (exitCode !== 0) {
      if (input.repo) {
        const refreshedRepo = await refreshRepoContext(input.repo)
        await recordCommandResult(getCoordinatorStoreDir(refreshedRepo.commonDir), buildLatestRunRecord({
          runId: randomUUID(),
          commandKey: input.commandKey,
          suiteKey: input.disposition.kind === 'coordinated' ? input.disposition.suiteKey : undefined,
          summary: input.summary,
          commandDisplay: input.commandDisplay,
          forwardedArgs: input.forwardedArgs,
          repo: refreshedRepo,
          runtime: input.runtime,
          startedAt: input.startedAt,
          finishedAt: new Date().toISOString(),
          exitCode,
        }))
      }
      return exitCode
    }
  }

  return undefined
}

/**
 * Run a coordinated command. Ungated phases (the cloud client Vitest lane)
 * start immediately and run outside the gate for the whole run; the gate is
 * held only while local phases run and is released as soon as they finish.
 * The first failure, interrupt, or gate timeout on either side stops the
 * other, and the run succeeds only if every phase passed.
 */
async function runCoordinatedCommand(context: CoordinatedRunContext): Promise<number> {
  const endpoint = buildCoordinatorEndpoint(context.repo.commonDir)
  const storeDir = endpoint.storeDir
  const pollMs = parseNumberEnv('FRESHELL_TEST_COORDINATOR_POLL_MS', DEFAULT_POLL_MS)
  const maxWaitMs = parseNumberEnv('FRESHELL_TEST_COORDINATOR_MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS)
  const stopGraceMs = parseNumberEnv('FRESHELL_TEST_COORDINATOR_STOP_GRACE_MS', DEFAULT_STOP_GRACE_MS)
  const queuedAt = new Date().toISOString()
  const waitStarted = Date.now()

  const control = new RunControl()
  const removeSignalHandlers = onStopSignals((signal) => {
    if (control.stop({ kind: 'signal', signal, exitCode: signalExitCode(signal) })) {
      logCoordinatorEvent('warn', 'run_interrupted', { signal })
    }
  })
  const ungated = new UngatedPhaseSet(storeDir, buildUngatedRunIdentity(context, queuedAt), control)

  let listener: ListeningServer | undefined
  let gateAcquiredAtMs: number | undefined
  let activeRepo = context.repo
  let suiteStarted = false
  let localPhase: RunningPhase | undefined

  const releaseGate = async (): Promise<void> => {
    if (!listener) return
    await clearHolderIfRunIdMatches(storeDir, context.runId)
    await listener.close()
    listener = undefined
    await ungated.setGate('released')
    logCoordinatorEvent('info', 'gate_released', { heldMs: Date.now() - (gateAcquiredAtMs ?? Date.now()) })
  }

  const recordOutcome = async (exitCode: number, recordSuite: boolean): Promise<void> => {
    const repo = await refreshRepoContext(activeRepo).catch(() => activeRepo)
    const startedAt = ungated.isEmpty && gateAcquiredAtMs !== undefined
      ? new Date(gateAcquiredAtMs).toISOString()
      : queuedAt
    const latest = buildLatestRunRecord({
      runId: context.runId,
      commandKey: context.commandKey,
      suiteKey: context.disposition.suiteKey,
      summary: context.summary,
      commandDisplay: context.commandDisplay,
      forwardedArgs: context.forwardedArgs,
      repo,
      runtime: context.runtime,
      startedAt,
      finishedAt: new Date().toISOString(),
      exitCode,
    })

    await recordCommandResult(storeDir, latest)
    if (recordSuite) {
      await recordSuiteResult(storeDir, latest)
    }
    if (exitCode === 0 && repo.commit && repo.isDirty === false && latest.entrypoint.suiteKey) {
      await recordReusableSuccess(storeDir, buildReusableSuccessRecord(latest))
    }
  }

  try {
    await ungated.start(context.disposition.ungatedPhases ?? [], process.env)

    while (!control.isStopped()) {
      const attempt = await tryListen(endpoint)
      if (attempt.kind === 'listening') {
        listener = attempt
        break
      }

      await printQueuedStatus(context)
      if (Date.now() - waitStarted >= maxWaitMs) {
        console.error(`${new Date().toISOString()} queued intentionally but timed out waiting for the coordinated run gate.`)
        control.stop({ kind: 'gate-timeout', exitCode: 124 })
        break
      }
      await waitForStopOrDelay(control, pollMs)
    }

    if (listener && !control.isStopped()) {
      gateAcquiredAtMs = Date.now()
      activeRepo = await refreshRepoContext(context.repo).catch(() => context.repo)
      await writeHolder(storeDir, buildHolderRecord(context, activeRepo, new Date(gateAcquiredAtMs).toISOString()))
      await ungated.setGate('holding')
      logCoordinatorEvent('info', 'gate_acquired', { waitedMs: gateAcquiredAtMs - waitStarted })

      if (process.env.FRESHELL_TEST_COORDINATOR_THROW_AFTER_HOLDER === '1') {
        throw new Error('Injected failure after holder write.')
      }

      const gatedPhases = [
        ...prePhasesForCommand(context.commandKey).map((phase) => ({ phase, suite: false })),
        ...context.disposition.phases.map((phase) => ({ phase, suite: true })),
      ]
      for (const { phase, suite } of gatedPhases) {
        if (control.isStopped()) break
        suiteStarted ||= suite
        const selector = describeUpstreamPhase(phase)
        logCoordinatorEvent('info', 'gated_phase_started', { phase: selector })
        localPhase = startUpstreamPhase(phase, process.env)
        const exitCode = await waitForPhaseOrStop(localPhase, control)
        if (exitCode === undefined) {
          await localPhase.stop(control.stopSignal, stopGraceMs)
          logCoordinatorEvent('warn', 'gated_phase_stopped', { phase: selector, reason: control.cause?.kind })
          break
        }
        logCoordinatorEvent(exitCode === 0 ? 'info' : 'error', 'gated_phase_finished', { phase: selector, exitCode })
        if (exitCode !== 0) {
          control.stop({ kind: 'phase-failed', phase: selector, ungated: false, exitCode })
        }
      }
      localPhase = undefined
    }

    await releaseGate()
    await ungated.settle(stopGraceMs)

    const cause = control.cause
    const exitCode = cause?.exitCode ?? 0
    // Suite results are verdicts on the suite, so skip them when the run
    // stopped before any suite phase ran or failed: a failing pre-phase, a
    // gate timeout, or an interrupt while queued.
    const suiteVerdict = !cause || suiteStarted || (cause.kind === 'phase-failed' && cause.ungated)
    await recordOutcome(exitCode, suiteVerdict)
    logCoordinatorEvent(exitCode === 0 ? 'info' : 'error', 'run_finished', { exitCode, cause })
    return exitCode
  } catch (error) {
    const message = (error as Error).message
    control.stop({ kind: 'error', message, exitCode: 1 })
    await localPhase?.stop('SIGTERM', stopGraceMs)
    await ungated.stopAll(stopGraceMs)
    await recordOutcome(1, suiteStarted)
    console.error(message)
    return 1
  } finally {
    removeSignalHandlers()
    await clearHolderIfRunIdMatches(storeDir, context.runId)
    if (listener) {
      await listener.close()
    }
    await ungated.clear()
  }
}

async function runPhases(phases: UpstreamPhase[]): Promise<number> {
  for (const phase of phases) {
    const exitCode = await runUpstreamPhase(phase, process.env)
    if (exitCode !== 0) {
      return exitCode
    }
  }
  return 0
}

/** Resolves with the phase's exit code, or undefined if the run was stopped first. */
async function waitForPhaseOrStop(phase: RunningPhase, control: RunControl): Promise<number | undefined> {
  const outcome = await Promise.race([
    phase.exitCode.then((exitCode) => ({ exitCode }), (error: unknown) => ({ error })),
    control.stopped.then(() => undefined),
  ])
  if (outcome && 'error' in outcome) throw outcome.error
  return outcome?.exitCode
}

async function waitForStopOrDelay(control: RunControl, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    control.stopped,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms)
    }),
  ])
  clearTimeout(timer)
}

function onStopSignals(handler: (signal: NodeJS.Signals) => void): () => void {
  const listener = (signal: NodeJS.Signals): void => handler(signal)
  for (const signal of STOP_SIGNALS) process.on(signal, listener)
  return () => {
    for (const signal of STOP_SIGNALS) process.off(signal, listener)
  }
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal as keyof typeof osConstants.signals] ?? 1)
}

async function printQueuedStatus(context: CoordinatedRunContext): Promise<void> {
  const repo = await refreshRepoContext(context.repo).catch(() => context.repo)
  const statusView = await buildStatusView({
    commonDir: repo.commonDir,
    commandKey: context.commandKey,
    suiteKey: context.disposition.suiteKey,
    commit: repo.commit,
    isDirty: repo.isDirty,
    nodeVersion: context.runtime.nodeVersion,
    platform: context.runtime.platform,
    arch: context.runtime.arch,
  })
  console.log(`${new Date().toISOString()} queued intentionally; waiting for the coordinated run gate.`)
  console.log(renderStatusView(statusView))
}

function buildUngatedRunIdentity(context: CoordinatedRunContext, queuedAt: string): UngatedRunIdentity {
  return {
    schemaVersion: 1,
    runId: context.runId,
    summary: context.summary.summary,
    summarySource: context.summary.summarySource,
    pid: process.pid,
    hostname: hostname(),
    queuedAt,
    entrypoint: {
      commandKey: context.commandKey,
      suiteKey: context.disposition.suiteKey,
    },
    command: {
      display: context.commandDisplay,
      argv: [context.commandKey, ...context.forwardedArgs],
    },
    repo: repoRecord(context.repo),
    agent: readAgentMetadata(),
  }
}

function buildHolderRecord(context: CoordinatedRunContext, repo: RepoContext, startedAt: string): HolderRecord {
  return {
    schemaVersion: 1,
    runId: context.runId,
    summary: context.summary.summary,
    summarySource: context.summary.summarySource,
    startedAt,
    pid: process.pid,
    hostname: hostname(),
    username: safeUsername(),
    entrypoint: {
      commandKey: context.commandKey,
      suiteKey: context.disposition.suiteKey,
    },
    command: {
      display: context.commandDisplay,
      argv: [context.commandKey, ...context.forwardedArgs],
    },
    repo: repoRecord(repo),
    runtime: context.runtime,
    agent: readAgentMetadata(),
  }
}

function buildLatestRunRecord(input: {
  runId: string
  commandKey: string
  suiteKey?: string
  summary: SummaryContext
  commandDisplay: string
  forwardedArgs: string[]
  repo: RepoContext
  runtime: RuntimeContext
  startedAt: string
  finishedAt: string
  exitCode: number
}): LatestRunRecord {
  return {
    runId: input.runId,
    summary: input.summary.summary,
    summarySource: input.summary.summarySource,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: Math.max(0, Date.parse(input.finishedAt) - Date.parse(input.startedAt)),
    outcome: input.exitCode === 0 ? 'success' : 'failure',
    exitCode: input.exitCode,
    entrypoint: {
      commandKey: input.commandKey,
      suiteKey: input.suiteKey,
    },
    command: {
      display: input.commandDisplay,
      argv: [input.commandKey, ...input.forwardedArgs],
    },
    repo: repoRecord(input.repo),
    runtime: input.runtime,
    agent: readAgentMetadata(),
  }
}

function repoRecord(repo: RepoContext): HolderRecord['repo'] {
  return {
    invocationCwd: repo.invocationCwd,
    checkoutRoot: repo.checkoutRoot,
    repoRoot: repo.repoRoot,
    commonDir: repo.commonDir,
    worktreePath: repo.worktreePath,
    branch: repo.branch,
    commit: repo.commit,
    isDirty: repo.isDirty,
  }
}

function buildReusableSuccessRecord(latest: LatestRunRecord): ReusableSuccessRecord {
  if (!latest.entrypoint.suiteKey) {
    throw new Error('Reusable success records require an exact suite key.')
  }

  return {
    ...latest,
    reusableKey: buildReusableSuccessKey({
      suiteKey: latest.entrypoint.suiteKey,
      commit: latest.repo.commit,
      isDirty: latest.repo.isDirty,
      nodeVersion: latest.runtime.nodeVersion,
      platform: latest.runtime.platform,
      arch: latest.runtime.arch,
    }),
  }
}

async function resolveRepoContext(): Promise<RepoContext> {
  const invocationCwd = await resolveRepoInvocationCwd(process.env)
  const [checkoutRoot, repoRoot, commonDir, branchDirty] = await Promise.all([
    resolveGitCheckoutRoot(invocationCwd),
    resolveGitRepoRoot(invocationCwd),
    resolveGitCommonDir(invocationCwd),
    resolveGitBranchAndDirty(invocationCwd),
  ])

  if (!commonDir) {
    throw new Error('The test coordinator requires a git repository checkout.')
  }

  return {
    invocationCwd,
    checkoutRoot,
    repoRoot,
    commonDir,
    worktreePath: checkoutRoot,
    branch: branchDirty.branch,
    commit: await resolveGitCommit(checkoutRoot),
    isDirty: branchDirty.isDirty,
  }
}

async function resolveRepoInvocationCwd(envVars: NodeJS.ProcessEnv = process.env): Promise<string> {
  const primary = resolveInvocationCwd(envVars)
  const candidates = uniqueDefinedStrings([
    primary,
    envVars.PWD,
    process.cwd(),
  ])

  for (const candidate of candidates) {
    if (await resolveGitCommonDir(candidate)) {
      return candidate
    }
  }

  return primary ?? process.cwd()
}

async function refreshRepoContext(previous: RepoContext): Promise<RepoContext> {
  const branchDirty = await resolveGitBranchAndDirty(previous.checkoutRoot)
  return {
    ...previous,
    branch: branchDirty.branch,
    commit: await resolveGitCommit(previous.checkoutRoot),
    isDirty: branchDirty.isDirty,
  }
}

async function resolveGitCommit(cwd: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, 'rev-parse', 'HEAD'])
    const commit = result.stdout.trim()
    return commit || undefined
  } catch {
    return undefined
  }
}

function summarizeCommand(commandKey: CommandKey, forwardedArgs: string[], summaryFlag?: string): SummaryContext {
  if (summaryFlag) {
    return { summary: summaryFlag, summarySource: 'flag' }
  }
  if (process.env.FRESHELL_TEST_SUMMARY) {
    return { summary: process.env.FRESHELL_TEST_SUMMARY, summarySource: 'env' }
  }
  return {
    summary: publicCommandDisplay(commandKey, forwardedArgs),
    summarySource: 'fallback',
  }
}

function publicCommandDisplay(commandKey: CommandKey, forwardedArgs: string[]): string {
  const base = commandKey === 'test' ? 'npm test' : `npm run ${commandKey}`
  return forwardedArgs.length > 0 ? `${base} -- ${forwardedArgs.join(' ')}` : base
}

function stripLeadingArgSeparator(args: string[]): string[] {
  if (args[0] === '--') {
    return args.slice(1)
  }
  return [...args]
}

function prePhasesForCommand(commandKey: CommandKey): UpstreamPhase[] {
  if (commandKey === 'check') {
    return [{ runner: 'npm', script: 'typecheck', args: [] }]
  }
  if (commandKey === 'verify') {
    return [{ runner: 'npm', script: 'build', args: [] }]
  }
  return []
}

function hasHelpOrVersion(args: string[]): boolean {
  return args.some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v')
}

function shouldPersistDelegatedCommandResult(commandKey: CommandKey, forwardedArgs: string[]): boolean {
  if (hasHelpOrVersion(forwardedArgs)) {
    return false
  }

  return commandKey === 'check' || commandKey === 'verify'
}

function runtimeContext(): RuntimeContext {
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
  }
}

function parseNumberEnv(key: string, defaultValue: number): number {
  const raw = process.env[key]
  if (!raw) return defaultValue
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue
}

function readAgentMetadata(): { kind?: string; sessionId?: string; threadId?: string } {
  return {
    kind: process.env.FRESHELL_AGENT_KIND,
    sessionId: process.env.FRESHELL_AGENT_SESSION_ID,
    threadId: process.env.FRESHELL_AGENT_THREAD_ID,
  }
}

function safeUsername(): string | undefined {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function uniqueDefinedStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error: unknown) => {
    console.error((error as Error).message)
    process.exitCode = 1
  })
}
