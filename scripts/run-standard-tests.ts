#!/usr/bin/env tsx

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { availableParallelism, constants as osConstants, setPriority } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const require = createRequire(import.meta.url)
const vitestEntrypoint = require.resolve('vitest/vitest.mjs')

export type StandardTestMode = 'desktop' | 'aggressive'
export type SuiteName = 'client' | 'server' | 'electron'
export type RunPriority = 'normal' | 'background'

export interface StandardTestRun {
  name: SuiteName
  configPath?: string
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
  serverWorkers: string
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
  const serverWorkers = totalWorkers >= 8 ? 3 : 2
  const clientWorkers = Math.max(2, totalWorkers - serverWorkers)
  return {
    clientWorkers: String(clientWorkers),
    serverWorkers: String(serverWorkers),
  }
}

export function resolvePriorityValue(priority: RunPriority, platform: NodeJS.Platform = process.platform): number {
  if (priority === 'normal') {
    return 0
  }
  return platform === 'win32'
    ? osConstants.priority.PRIORITY_BELOW_NORMAL
    : 10
}

export function buildVitestArgs({
  configPath,
  maxWorkers,
  forwardedArgs,
}: VitestArgsInput): string[] {
  const args = ['run', '--passWithNoTests']
  if (configPath) {
    args.push('--config', configPath)
  }
  if (maxWorkers) {
    args.push('--maxWorkers', maxWorkers)
  }
  return [...args, ...forwardedArgs]
}

function classifySuitePath(token: string): SuiteName | null {
  if (token.startsWith('-')) {
    return null
  }
  const normalizedToken = token.replace(/\\/g, '/')
  if (
    normalizedToken.startsWith('test/unit/electron/')
    || normalizedToken.includes('/test/unit/electron/')
  ) {
    return 'electron'
  }
  if (
    normalizedToken.startsWith('test/server/')
    || normalizedToken.startsWith('test/unit/server/')
    || normalizedToken.startsWith('test/integration/server/')
    || normalizedToken.includes('/test/server/')
    || normalizedToken.includes('/test/unit/server/')
    || normalizedToken.includes('/test/integration/server/')
    || normalizedToken.endsWith('/test/integration/session-repair.test.ts')
    || normalizedToken.endsWith('/test/integration/session-search-e2e.test.ts')
    || normalizedToken.endsWith('/test/integration/extension-system.test.ts')
    || normalizedToken === 'test/integration/session-repair.test.ts'
    || normalizedToken === 'test/integration/session-search-e2e.test.ts'
    || normalizedToken === 'test/integration/extension-system.test.ts'
  ) {
    return 'server'
  }
  if (normalizedToken.startsWith('test/') || normalizedToken.includes('/test/')) {
    return 'client'
  }
  return null
}

function detectRequestedSuites(forwardedArgs: string[]): SuiteName[] | null {
  const suites = new Set<SuiteName>()
  for (const token of forwardedArgs) {
    const suite = classifySuitePath(token)
    if (suite) {
      suites.add(suite)
    }
  }
  if (suites.size === 0) {
    return null
  }
  return ['client', 'server', 'electron'].filter((suite): suite is SuiteName => suites.has(suite))
}

export function createStandardTestPlan({
  availableParallelism: cpuCount,
  ci,
  mode,
  forwardedArgs,
}: CreatePlanInput): StandardTestPlan {
  const resolvedMode = mode ?? (ci ? 'aggressive' : 'desktop')
  const requestedSuites = detectRequestedSuites(forwardedArgs)

  if (resolvedMode === 'aggressive') {
    const aggressiveRuns: StandardTestRun[] = [
      { name: 'client', maxWorkers: '50%', priority: 'normal' },
      { name: 'server', configPath: 'vitest.server.config.ts', maxWorkers: '50%', priority: 'normal' },
      { name: 'electron', configPath: 'vitest.electron.config.ts', priority: 'normal' },
    ]
    return {
      mode: resolvedMode,
      stages: [filterRuns(aggressiveRuns, requestedSuites)],
    }
  }

  const workers = resolveDesktopWorkerPlan(cpuCount)
  const initialStage = filterRuns([
    { name: 'client', maxWorkers: workers.clientWorkers, priority: 'background' },
    { name: 'server', configPath: 'vitest.server.config.ts', maxWorkers: workers.serverWorkers, priority: 'background' },
  ], requestedSuites)
  const electronStage = filterRuns([
    { name: 'electron', configPath: 'vitest.electron.config.ts', priority: 'background' },
  ], requestedSuites)

  const stages = [initialStage, electronStage].filter((stage) => stage.length > 0)
  return { mode: resolvedMode, stages }
}

function filterRuns(runs: StandardTestRun[], requestedSuites: SuiteName[] | null): StandardTestRun[] {
  if (!requestedSuites) {
    return runs
  }
  return runs.filter((run) => requestedSuites.includes(run.name))
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

function applyPriority(run: StandardTestRun, child: ChildProcess): void {
  if (!child.pid || run.priority === 'normal') {
    return
  }
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
  const args = buildVitestArgs({
    configPath: run.configPath,
    maxWorkers: run.maxWorkers,
    forwardedArgs,
  })
  log('info', 'Starting test suite', {
    suite: run.name,
    priority: run.priority,
    args,
  })
  const child = spawn(process.execPath, [vitestEntrypoint, ...args], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })
  applyPriority(run, child)
  return child
}

async function runStage(stage: StandardTestRun[], forwardedArgs: string[]): Promise<void> {
  if (stage.length === 0) {
    return
  }

  await new Promise<void>((resolveStage, rejectStage) => {
    const children = stage.map((run) => ({
      run,
      child: startRun(run, forwardedArgs),
    }))
    let finished = 0
    let settled = false

    const terminateOthers = (originSuite: SuiteName): void => {
      for (const entry of children) {
        if (entry.run.name === originSuite) {
          continue
        }
        if (entry.child.exitCode === null && !entry.child.killed) {
          entry.child.kill('SIGTERM')
        }
      }
    }

    for (const entry of children) {
      entry.child.once('error', (error) => {
        if (settled) {
          return
        }
        settled = true
        terminateOthers(entry.run.name)
        rejectStage(error)
      })

      entry.child.once('exit', (code, signal) => {
        const exitCode = code ?? (signal ? 1 : 0)
        log(exitCode === 0 ? 'info' : 'error', 'Test suite exited', {
          suite: entry.run.name,
          code: exitCode,
          signal,
        })

        if (settled) {
          return
        }
        if (exitCode !== 0) {
          settled = true
          terminateOthers(entry.run.name)
          rejectStage(new Error(`${entry.run.name} suite exited with code ${exitCode}`))
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { mode, forwardedArgs } = parseCliArgs(argv)
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
    for (const stage of plan.stages) {
      await runStage(stage, forwardedArgs)
    }
    return 0
  } catch (error) {
    log('error', 'Standard test run failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return 1
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().then((code) => {
    process.exitCode = code
  })
}
