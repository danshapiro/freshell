#!/usr/bin/env tsx

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { availableParallelism, constants as osConstants, setPriority } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  buildRunScriptArgs,
  detectProjectManager,
  resolveManagerCommand,
  type PackageManagerKind,
} from './lib/package-manager.js'
import { resolveVitestCommand } from './testing/coordinator-upstream.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..')
const VITEST_ENTRYPOINT = resolveVitestCommand(PROJECT_ROOT).args[0]
const DEFAULT_VITEST_CONFIG = 'config/vitest/vitest.config.ts'
const ELECTRON_VITEST_CONFIG = 'config/vitest/vitest.electron.config.ts'
const ELECTRON_RUNTIME_VITEST_CONFIG = 'config/vitest/vitest.electron-runtime.config.ts'

export type StandardTestMode = 'desktop' | 'aggressive'
export type SuiteName = 'client' | 'client-local-only' | 'source-runtime' | 'rust' | 'electron' | 'electron-runtime'
export type RunPriority = 'normal' | 'background'

export interface StandardTestRun {
  name: SuiteName
  runner: 'vitest' | 'npm'
  configPath?: string
  script?: 'test:source-runtime' | 'test:rust'
  maxWorkers?: string
  priority: RunPriority
  /**
   * When set, these path selectors replace the forwarded CLI args for this
   * vitest run. Used by the cloud backend's local companion phase so it runs
   * exactly the tests the Cloud Run image excludes, regardless of what the
   * caller forwarded to the cloud shards.
   */
  pathFilters?: string[]
}

export interface StandardTestPlan {
  mode: StandardTestMode
  stages: StandardTestRun[][]
}

interface CreatePlanInput {
  availableParallelism: number
  ci: boolean
  mode?: StandardTestMode
  forwardedArgs: string[]
}

interface DesktopWorkerPlan {
  clientWorkers: string
  rustWorkers: string
}

interface VitestArgsInput {
  configPath?: string
  maxWorkers?: string
  forwardedArgs: string[]
}

function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level,
    severity: level,
    time: new Date().toISOString(),
    component: 'standard-test-runner',
    msg,
    ...fields,
  })
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout
  stream.write(`${line}\n`)
}

export function resolveDesktopWorkerPlan(cpuCount: number): DesktopWorkerPlan {
  const safeCpuCount = Number.isFinite(cpuCount) ? Math.max(2, Math.floor(cpuCount)) : 4
  const totalWorkers = Math.min(8, Math.max(4, Math.floor(safeCpuCount / 4)))
  const rustWorkers = totalWorkers >= 8 ? 3 : 2
  const clientWorkers = Math.max(2, totalWorkers - rustWorkers)
  return {
    clientWorkers: String(clientWorkers),
    rustWorkers: String(rustWorkers),
  }
}

export function resolvePriorityValue(priority: RunPriority, platform: NodeJS.Platform = process.platform): number {
  if (priority === 'normal') return 0
  return platform === 'win32' ? osConstants.priority.PRIORITY_BELOW_NORMAL : 10
}

export function buildVitestArgs({ configPath, maxWorkers, forwardedArgs }: VitestArgsInput): string[] {
  const args = ['run']
  if (configPath) args.push('--config', configPath)
  if (maxWorkers) args.push('--maxWorkers', maxWorkers)
  return [...args, ...forwardedArgs]
}

/**
 * Parse .dockerignore content into the list of test directories that are
 * deliberately excluded from the Cloud Run vitest image (and therefore never
 * run by the cloud shards). Only plain `test/…` directory exclusions are
 * tracked; comments, `!` re-includes, and glob patterns are ignored — a glob
 * exclusion cannot be mapped to a runnable directory and must be handled
 * manually. First-seen order is preserved.
 */
export function parseLocalOnlyTestDirs(dockerignoreText: string): string[] {
  const dirs: string[] = []
  for (const rawLine of dockerignoreText.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    if (line.includes('*')) continue
    const match = /^\/?(test\/[^\s*?]+?)\/?$/.exec(line)
    if (!match) continue
    const dir = match[1]
    if (!dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

/**
 * Decide which of the cloud-excluded test paths the local companion should
 * run for this invocation. A broad run (no path selectors) runs every
 * excluded directory; a focused run runs only the selectors that actually
 * fall under an excluded directory, and skips the companion entirely when
 * nothing intersects (the run never claimed that coverage).
 */
export function resolveCloudCompanionScope(forwardedArgs: string[], localOnlyDirs: string[]): string[] {
  const pathArgs = forwardedArgs.filter((arg) => !arg.startsWith('-'))
  if (pathArgs.length === 0) return [...localOnlyDirs]
  const scope: string[] = []
  for (const raw of pathArgs) {
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    for (const dir of localOnlyDirs) {
      if (normalized === dir || normalized.startsWith(`${dir}/`)) {
        if (!scope.includes(normalized)) scope.push(normalized)
        break
      }
    }
  }
  return scope
}

export function buildCloudCompanionRun({
  mode,
  clientWorkers,
  scope,
}: {
  mode: StandardTestMode
  clientWorkers: string
  scope: string[]
}): StandardTestRun {
  return {
    name: 'client-local-only',
    runner: 'vitest',
    configPath: DEFAULT_VITEST_CONFIG,
    maxWorkers: clientWorkers,
    priority: mode === 'aggressive' ? 'normal' : 'background',
    pathFilters: scope,
  }
}

export function resolveScriptPhaseCommand(
  run: StandardTestRun,
  forwardedArgs: string[],
  manager: PackageManagerKind,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[]; viaShell?: boolean } {
  const forwarded = run.name === 'source-runtime' ? forwardedArgs : []
  const scriptArgs = buildRunScriptArgs(manager, run.script!, forwarded)
  return resolveManagerCommand({ manager, args: scriptArgs, env })
}

function classifySuitePath(token: string): SuiteName | null {
  if (token.startsWith('-')) return null
  const normalizedToken = token.replace(/\\/g, '/')

  if (
    normalizedToken.startsWith('test/unit/electron/')
    || normalizedToken.includes('/test/unit/electron/')
  ) {
    return 'electron'
  }
  if (
    normalizedToken.startsWith('test/integration/tooling/')
    || normalizedToken.includes('/test/integration/tooling/')
  ) {
    return 'source-runtime'
  }
  if (
    normalizedToken.startsWith('test/integration/electron/')
    || normalizedToken.includes('/test/integration/electron/')
  ) {
    return 'electron-runtime'
  }
  if (
    normalizedToken.startsWith('test/server/')
    || normalizedToken.startsWith('test/unit/server/')
    || normalizedToken.startsWith('test/integration/server/')
    || normalizedToken.startsWith('crates/')
    || normalizedToken.includes('/test/server/')
    || normalizedToken.includes('/test/unit/server/')
    || normalizedToken.includes('/test/integration/server/')
    || normalizedToken.includes('/crates/')
  ) {
    return 'rust'
  }
  if (normalizedToken.startsWith('test/') || normalizedToken.includes('/test/')) return 'client'
  return null
}

function detectRequestedSuites(forwardedArgs: string[]): SuiteName[] | null {
  const suites = new Set<SuiteName>()
  for (const token of forwardedArgs) {
    const suite = classifySuitePath(token)
    if (suite) suites.add(suite)
  }
  if (suites.size === 0) return null
  const suiteOrder: SuiteName[] = ['client', 'source-runtime', 'rust', 'electron', 'electron-runtime']
  return suiteOrder.filter((suite) => suites.has(suite))
}

function buildRuns(
  mode: StandardTestMode,
  workers: DesktopWorkerPlan,
  includeElectronRuntime: boolean,
): StandardTestRun[] {
  const priority: RunPriority = mode === 'aggressive' ? 'normal' : 'background'
  const runs: StandardTestRun[] = [
    {
      name: 'client',
      runner: 'vitest',
      configPath: DEFAULT_VITEST_CONFIG,
      maxWorkers: mode === 'aggressive' ? '50%' : workers.clientWorkers,
      priority,
    },
    {
      name: 'source-runtime',
      runner: 'npm',
      script: 'test:source-runtime',
      priority,
    },
    {
      name: 'rust',
      runner: 'npm',
      script: 'test:rust',
      priority,
    },
    {
      name: 'electron',
      runner: 'vitest',
      configPath: ELECTRON_VITEST_CONFIG,
      priority,
    },
  ]
  if (includeElectronRuntime) {
    runs.push({
      name: 'electron-runtime',
      runner: 'vitest',
      configPath: ELECTRON_RUNTIME_VITEST_CONFIG,
      priority,
    })
  }
  return runs
}

export function createStandardTestPlan({
  availableParallelism: cpuCount,
  ci,
  mode,
  forwardedArgs,
}: CreatePlanInput): StandardTestPlan {
  const resolvedMode = mode ?? (ci ? 'aggressive' : 'desktop')
  const requestedSuites = detectRequestedSuites(forwardedArgs)
  const workers = resolveDesktopWorkerPlan(cpuCount)
  const runs = buildRuns(resolvedMode, workers, requestedSuites?.includes('electron-runtime') ?? false)
  const selectedRuns = requestedSuites
    ? runs.filter((run) => requestedSuites.includes(run.name))
    : runs

  // Each phase owns its prerequisites and artifacts. The source-runtime
  // wrapper begins with the prebuild script run through the detected project
  // manager, so the broad check/verify path keeps the same live-server build
  // guard as a direct source-runtime invocation.
  // Keeping the phases in order also prevents a source-runtime build and Cargo
  // from racing over the same target/dist directories while retaining one
  // coordinator gate for the full suite.
  return {
    mode: resolvedMode,
    stages: selectedRuns.map((run) => [run]),
  }
}

function applyPriority(run: StandardTestRun, child: ChildProcess): void {
  if (!child.pid || run.priority === 'normal') return
  try {
    setPriority(child.pid, resolvePriorityValue(run.priority))
  } catch (error) {
    log('warn', 'Failed to lower test runner priority', {
      suite: run.name,
      pid: child.pid,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function startRun(run: StandardTestRun, forwardedArgs: string[]): ChildProcess {
  let command: string
  let args: string[]
  let viaShell = false
  if (run.runner === 'vitest') {
    const vitestArgs = buildVitestArgs({
      configPath: run.configPath,
      maxWorkers: run.maxWorkers,
      forwardedArgs: run.pathFilters ?? forwardedArgs,
    })
    // Test seam mirroring FRESHELL_VITEST_CLOUD_SCRIPT: lets the process-level
    // integration test observe the companion without spawning real vitest
    // (and its cargo/Docker builds).
    const companionScript = run.name === 'client-local-only'
      ? process.env.FRESHELL_VITEST_COMPANION_SCRIPT
      : undefined
    command = companionScript ?? process.execPath
    args = companionScript ? vitestArgs : [VITEST_ENTRYPOINT, ...vitestArgs]
  } else {
    const manager = detectProjectManager(PROJECT_ROOT).manager
    const resolved = resolveScriptPhaseCommand(run, forwardedArgs, manager)
    command = resolved.command
    args = resolved.args
    viaShell = resolved.viaShell === true
  }

  log('info', 'Starting test phase', {
    suite: run.name,
    runner: run.runner,
    priority: run.priority,
    args,
  })
  const child = spawn(command, args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
    ...(viaShell ? { shell: true } : {}),
  })
  applyPriority(run, child)
  return child
}

async function runStage(stage: StandardTestRun[], forwardedArgs: string[]): Promise<void> {
  if (stage.length === 0) return

  await new Promise<void>((resolveStage, rejectStage) => {
    const children = stage.map((run) => ({ run, child: startRun(run, forwardedArgs) }))
    let finished = 0
    let settled = false

    const terminateOthers = (originSuite: SuiteName): void => {
      for (const entry of children) {
        if (entry.run.name === originSuite) continue
        if (entry.child.exitCode === null && !entry.child.killed) entry.child.kill('SIGTERM')
      }
    }

    for (const entry of children) {
      entry.child.once('error', (error) => {
        if (settled) return
        settled = true
        terminateOthers(entry.run.name)
        rejectStage(error)
      })

      entry.child.once('exit', (code, signal) => {
        const exitCode = code ?? (signal ? 1 : 0)
        log(exitCode === 0 ? 'info' : 'error', 'Test phase exited', {
          suite: entry.run.name,
          code: exitCode,
          signal,
        })
        if (settled) return
        if (exitCode !== 0) {
          settled = true
          terminateOthers(entry.run.name)
          rejectStage(new Error(`${entry.run.name} phase exited with code ${exitCode}`))
          return
        }
        finished += 1
        if (finished === children.length) {
          settled = true
          resolveStage()
        }
      })
    }
  })
}

function selectedSuites(forwardedArgs: string[]): Set<SuiteName> | null {
  const requested = detectRequestedSuites(forwardedArgs)
  return requested ? new Set(requested) : null
}

function isLocalCompanionDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.FRESHELL_VITEST_LOCAL_COMPANION
  return raw !== undefined && ['0', 'off', 'false', 'no'].includes(raw.toLowerCase())
}

function resolveExistingLocalOnlyDirs(): string[] {
  try {
    const dockerignoreText = readFileSync(resolve(PROJECT_ROOT, '.dockerignore'), 'utf8')
    return parseLocalOnlyTestDirs(dockerignoreText)
      .filter((dir) => existsSync(resolve(PROJECT_ROOT, dir)))
  } catch {
    return []
  }
}

function dispatchCloudVitest(cloudScript: string, forwardedArgs: string[]): Promise<void> {
  return new Promise((resolveDispatch, rejectDispatch) => {
    execFile(
      cloudScript,
      ['run', '--cloud', '--config=default', ...forwardedArgs],
      { stdio: 'inherit', cwd: PROJECT_ROOT, env: process.env },
      (error) => {
        if (error) rejectDispatch(error)
        else resolveDispatch()
      },
    )
  })
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { mode, forwardedArgs } = parseCliArgs(argv)
  const requested = selectedSuites(forwardedArgs)

  // Cloud Vitest owns only the retained default client/tooling lane. The
  // source-runtime and Cargo phases still run locally because they need the
  // built Rust artifact and a real process filesystem.
  if (process.env.FRESHELL_VITEST_BACKEND === 'cloud' && (!requested || requested.has('client'))) {
    const hasGitDependentArgs = forwardedArgs.some((arg) => arg === '--changed' || arg.startsWith('--changed='))
    if (hasGitDependentArgs) {
      log('warn', 'Git-dependent selectors detected; running all phases locally', { forwardedArgs })
    } else {
      const cloudScript = process.env.FRESHELL_VITEST_CLOUD_SCRIPT || resolve(PROJECT_ROOT, 'scripts/vitest-cloud.sh')
      const resolvedMode = mode ?? (process.env.CI === 'true' || process.env.CI === '1' ? 'aggressive' : 'desktop')
      const localOnlyDirs = resolveExistingLocalOnlyDirs()
      const companionScope = resolveCloudCompanionScope(forwardedArgs, localOnlyDirs)

      // The cloud image deliberately excludes some test directories (see
      // .dockerignore) because their tests need a Docker daemon and a locally
      // built server. A cloud-only green would silently not cover them, so a
      // local companion runs exactly those excluded paths and folds into the
      // verdict. Set FRESHELL_VITEST_LOCAL_COMPANION=off to skip it (loudly).
      let companionRun: StandardTestRun | null = null
      if (isLocalCompanionDisabled()) {
        if (companionScope.length > 0) {
          log('warn', 'Local companion disabled via FRESHELL_VITEST_LOCAL_COMPANION; a green run does NOT cover the cloud-excluded tests', {
            skippedScope: companionScope,
          })
        }
      } else if (companionScope.length === 0) {
        log('info', 'Local companion skipped: no requested selectors intersect the cloud-excluded tests', { localOnlyDirs })
      } else {
        const workers = resolveDesktopWorkerPlan(availableParallelism())
        companionRun = buildCloudCompanionRun({
          mode: resolvedMode,
          clientWorkers: workers.clientWorkers,
          scope: companionScope,
        })
        log('info', 'Starting local companion for cloud-excluded tests (runs in parallel with the cloud shards)', {
          suite: companionRun.name,
          scope: companionScope,
        })
      }

      log('info', 'Dispatching default Vitest phase to cloud', { cloudScript, forwardedArgs })
      // The companion is the only local phase running while the cloud shards
      // execute, so the sequential artifact-owning phase order below is
      // preserved (nothing else touches target/ or dist/ concurrently).
      const [cloudResult, companionResult] = await Promise.allSettled([
        dispatchCloudVitest(cloudScript, forwardedArgs),
        companionRun ? runStage([companionRun], []) : Promise.resolve(),
      ])

      let failed = false
      if (cloudResult.status === 'rejected') {
        failed = true
        log('error', 'Cloud Vitest phase failed', {
          error: cloudResult.reason instanceof Error ? cloudResult.reason.message : String(cloudResult.reason),
        })
      }
      if (companionResult.status === 'rejected') {
        failed = true
        log('error', 'Local companion phase failed; a green cloud run does NOT cover the cloud-excluded tests', {
          scope: companionScope,
          error: companionResult.reason instanceof Error ? companionResult.reason.message : String(companionResult.reason),
        })
      }
      if (failed) return 1

      const plan = createStandardTestPlan({
        availableParallelism: availableParallelism(),
        ci: process.env.CI === 'true' || process.env.CI === '1',
        mode: resolvedMode,
        forwardedArgs,
      })
      const localStages = plan.stages.filter((entry) => entry[0]?.name !== 'client')
      log('info', 'Cloud default phase complete; running local phases', {
        phases: localStages.map((stage) => stage[0]?.name).filter((name): name is SuiteName => Boolean(name)),
      })
      try {
        for (const stage of localStages) {
          await runStage(stage, forwardedArgs)
        }
        return 0
      } catch (error) {
        log('error', 'Standard test run failed', { error: error instanceof Error ? error.message : String(error) })
        return 1
      }
    }
  }

  const plan = createStandardTestPlan({
    availableParallelism: availableParallelism(),
    ci: process.env.CI === 'true' || process.env.CI === '1',
    mode,
    forwardedArgs,
  })
  log('info', 'Resolved standard test plan', {
    mode: plan.mode,
    availableParallelism: availableParallelism(),
    stages: plan.stages,
    forwardedArgs,
  })

  try {
    for (const stage of plan.stages) await runStage(stage, forwardedArgs)
    return 0
  } catch (error) {
    log('error', 'Standard test run failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return 1
  }
}

function parseCliArgs(argv: string[]): { mode?: StandardTestMode; forwardedArgs: string[] } {
  const forwardedArgs: string[] = []
  let mode: StandardTestMode | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--mode') {
      const next = argv[index + 1]
      if (next === 'desktop' || next === 'aggressive') {
        mode = next
        index += 1
        continue
      }
    }
    if (arg.startsWith('--mode=')) {
      const value = arg.slice('--mode='.length)
      if (value === 'desktop' || value === 'aggressive') {
        mode = value
        continue
      }
    }
    forwardedArgs.push(arg)
  }
  return { mode, forwardedArgs }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code
  })
}
