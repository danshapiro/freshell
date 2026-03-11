import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import {
  resolveGitBranchAndDirty,
  resolveGitCheckoutRoot,
  resolveGitCommonDir,
  resolveGitRepoRoot,
  resolveInvocationCwd,
} from '../../server/coding-cli/utils.js'
import {
  classifyCommand,
  type CommandDisposition,
  type CommandKey,
  type UpstreamPhase,
} from './coordinator-command-matrix.js'
import { buildCoordinatorEndpoint, tryListen, type ListeningServer } from './coordinator-endpoint.js'
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
import { assertNoCoordinatorRecursion, runUpstreamPhase } from './coordinator-upstream.js'

const execFileAsync = promisify(execFile)
const DEFAULT_POLL_MS = 60_000
const DEFAULT_MAX_WAIT_MS = 24 * 60 * 60 * 1000

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
  })

  if (disposition.kind === 'rejected') {
    console.error(disposition.reason)
    return 1
  }

  const repo = disposition.kind === 'coordinated' || parsed.commandKey === 'check' || parsed.commandKey === 'verify'
    ? await resolveRepoContext()
    : undefined
  const runtime = runtimeContext()
  const summary = summarizeCommand(parsed.commandKey, parsed.forwardedArgs, parsed.summary)
  const commandDisplay = publicCommandDisplay(parsed.commandKey, parsed.forwardedArgs)

  if (disposition.kind === 'coordinated') {
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

  const prePhaseResult = await runPrePhasesIfNeeded({
    commandKey: parsed.commandKey,
    forwardedArgs: parsed.forwardedArgs,
    commandDisplay,
    disposition,
    repo,
    runtime,
    summary,
  })
  if (prePhaseResult !== undefined) {
    return prePhaseResult
  }

  if (disposition.kind === 'delegated' || disposition.kind === 'passthrough') {
    return runPhases(disposition.phases)
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
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          exitCode,
        }))
      }
      return exitCode
    }
  }

  return undefined
}

async function runCoordinatedCommand(context: CoordinatedRunContext): Promise<number> {
  const endpoint = buildCoordinatorEndpoint(context.repo.commonDir)
  const pollMs = parseNumberEnv('FRESHELL_TEST_COORDINATOR_POLL_MS', DEFAULT_POLL_MS)
  const maxWaitMs = parseNumberEnv('FRESHELL_TEST_COORDINATOR_MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS)
  const queuedAt = new Date().toISOString()
  let startedAt = queuedAt
  const waitStarted = Date.now()

  let listener: ListeningServer | undefined
  let suiteStarted = false
  let activeRepo = context.repo

  try {
    while (!listener) {
      const attempt = await tryListen(endpoint)
      if (attempt.kind === 'listening') {
        listener = attempt
        break
      }

      await printQueuedStatus(context)
      if (Date.now() - waitStarted >= maxWaitMs) {
        const finishedAt = new Date().toISOString()
        const repo = await refreshRepoContext(context.repo).catch(() => context.repo)
        await recordCommandResult(getCoordinatorStoreDir(repo.commonDir), buildLatestRunRecord({
          runId: context.runId,
          commandKey: context.commandKey,
          suiteKey: context.disposition.suiteKey,
          summary: context.summary,
          commandDisplay: context.commandDisplay,
          forwardedArgs: context.forwardedArgs,
          repo,
          runtime: context.runtime,
          startedAt: queuedAt,
          finishedAt,
          exitCode: 124,
        }))
        console.error(`${new Date().toISOString()} queued intentionally but timed out waiting for the coordinated run gate.`)
        return 124
      }
      await delay(pollMs)
    }

    activeRepo = await refreshRepoContext(context.repo).catch(() => context.repo)
    startedAt = new Date().toISOString()
    const holder = buildHolderRecord(context, activeRepo, startedAt)
    await writeHolder(endpoint.storeDir, holder)

    if (process.env.FRESHELL_TEST_COORDINATOR_THROW_AFTER_HOLDER === '1') {
      throw new Error('Injected failure after holder write.')
    }

    const prePhaseResult = await runPrePhasesIfNeeded({
      commandKey: context.commandKey,
      forwardedArgs: context.forwardedArgs,
      commandDisplay: context.commandDisplay,
      disposition: context.disposition,
      repo: activeRepo,
      runtime: context.runtime,
      summary: context.summary,
    })
    if (prePhaseResult !== undefined) {
      return prePhaseResult
    }

    suiteStarted = true
    const exitCode = await runPhases(context.disposition.phases)
    const finishedAt = new Date().toISOString()
    const repo = await refreshRepoContext(activeRepo)
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
      finishedAt,
      exitCode,
    })
    const storeDir = getCoordinatorStoreDir(repo.commonDir)

    await recordCommandResult(storeDir, latest)
    await recordSuiteResult(storeDir, latest)

    if (exitCode === 0 && repo.commit && repo.isDirty === false) {
      await recordReusableSuccess(storeDir, buildReusableSuccessRecord(latest))
    }

    return exitCode
  } catch (error) {
    const finishedAt = new Date().toISOString()
    const repo = await refreshRepoContext(activeRepo).catch(() => activeRepo)
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
      finishedAt,
      exitCode: 1,
    })
    const storeDir = getCoordinatorStoreDir(repo.commonDir)
    await recordCommandResult(storeDir, latest)
    if (suiteStarted) {
      await recordSuiteResult(storeDir, latest)
    }
    console.error((error as Error).message)
    return 1
  } finally {
    await clearHolderIfRunIdMatches(endpoint.storeDir, context.runId)
    if (listener) {
      await listener.close()
    }
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
    repo: {
      invocationCwd: repo.invocationCwd,
      checkoutRoot: repo.checkoutRoot,
      repoRoot: repo.repoRoot,
      commonDir: repo.commonDir,
      worktreePath: repo.worktreePath,
      branch: repo.branch,
      commit: repo.commit,
      isDirty: repo.isDirty,
    },
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
    repo: {
      invocationCwd: input.repo.invocationCwd,
      checkoutRoot: input.repo.checkoutRoot,
      repoRoot: input.repo.repoRoot,
      commonDir: input.repo.commonDir,
      worktreePath: input.repo.worktreePath,
      branch: input.repo.branch,
      commit: input.repo.commit,
      isDirty: input.repo.isDirty,
    },
    runtime: input.runtime,
    agent: readAgentMetadata(),
  }
}

function buildReusableSuccessRecord(latest: LatestRunRecord): ReusableSuccessRecord {
  return {
    ...latest,
    reusableKey: buildReusableSuccessKey({
      suiteKey: latest.entrypoint.suiteKey ?? 'full-suite',
      commit: latest.repo.commit,
      isDirty: latest.repo.isDirty,
      nodeVersion: latest.runtime.nodeVersion,
      platform: latest.runtime.platform,
      arch: latest.runtime.arch,
    }),
  }
}

async function resolveRepoContext(): Promise<RepoContext> {
  const invocationCwd = resolveInvocationCwd(process.env) ?? process.cwd()
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error: unknown) => {
    console.error((error as Error).message)
    process.exitCode = 1
  })
}
