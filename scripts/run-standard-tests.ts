#!/usr/bin/env tsx

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { availableParallelism, constants as osConstants, setPriority } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..')
const REQUIRE = createRequire(resolve(PROJECT_ROOT, 'package.json'))
const VITEST_ENTRYPOINT = REQUIRE.resolve('vitest/vitest.mjs')
const DEFAULT_VITEST_CONFIG = 'config/vitest/vitest.config.ts'
const ELECTRON_VITEST_CONFIG = 'config/vitest/vitest.electron.config.ts'
const ELECTRON_RUNTIME_VITEST_CONFIG = 'config/vitest/vitest.electron-runtime.config.ts'

export type StandardTestMode = 'desktop' | 'aggressive'
export type SuiteName = 'client' | 'source-runtime' | 'rust' | 'electron' | 'electron-runtime'
export type RunPriority = 'normal' | 'background'

export interface StandardTestRun {
  name: SuiteName
  runner: 'vitest' | 'npm'
  configPath?: string
  script?: 'test:source-runtime' | 'test:rust'
  maxWorkers?: string
  priority: RunPriority
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
  return ['client', 'source-runtime', 'rust', 'electron', 'electron-runtime']
    .filter((suite): suite is SuiteName => suites.has(suite))
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
  // wrapper begins with npm run prebuild, so the broad check/verify path keeps
  // the same live-server build guard as a direct source-runtime invocation.
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

function resolveNpmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function startRun(run: StandardTestRun, forwardedArgs: string[]): ChildProcess {
  let command: string
  let args: string[]
  if (run.runner === 'vitest') {
    command = process.execPath
    args = [VITEST_ENTRYPOINT, ...buildVitestArgs({
      configPath: run.configPath,
      maxWorkers: run.maxWorkers,
      forwardedArgs,
    })]
  } else {
    command = resolveNpmCommand()
    args = ['run', run.script!]
    if (run.name === 'source-runtime' && forwardedArgs.length > 0) args.push('--', ...forwardedArgs)
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
      log('info', 'Dispatching default Vitest phase to cloud', { cloudScript, forwardedArgs })
      try {
        execFileSync(cloudScript, ['run', '--cloud', '--config=default', ...forwardedArgs], {
          stdio: 'inherit',
          cwd: PROJECT_ROOT,
          env: process.env,
        })
      } catch {
        return 1
      }

      const plan = createStandardTestPlan({
        availableParallelism: availableParallelism(),
        ci: process.env.CI === 'true' || process.env.CI === '1',
        mode,
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
