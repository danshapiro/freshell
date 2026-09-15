import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import path from 'node:path'

import { resolveCloudVitestCommand } from './cloud-vitest-lane.js'
import type { UpstreamPhase } from './coordinator-command-matrix.js'
import { createLinePrefixer } from './prefixed-output.js'
import { isProcessRunning, signalProcessTree } from './process-tree.js'

const ACTIVE_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_ACTIVE'
const FAKE_UPSTREAM_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_FAKE_UPSTREAM'
const REPO_ROOT_ENV_KEY = 'FRESHELL_TEST_COORDINATOR_REPO_ROOT'
const OUTPUT_DRAIN_MS = 2_000
const STOP_POLL_MS = 50

export type RunningPhase = {
  readonly pid: number | undefined
  /**
   * The phase's exit code (128+n when killed by signal n), resolved once its
   * output is flushed. Rejects when the phase could not be spawned.
   */
  readonly exitCode: Promise<number>
  /**
   * Signal the phase's whole process tree, then SIGKILL anything from that
   * tree still alive after `graceMs`. Resolves with the phase's exit code.
   */
  stop: (signal: NodeJS.Signals, graceMs: number) => Promise<number>
}

export type StartPhaseOptions = {
  /**
   * Run the phase concurrently with phases that own the terminal: its output
   * is line-prefixed, it gets no stdin, and on POSIX it runs in its own
   * session so a terminal interrupt reaches it once, through the coordinator.
   */
  outputPrefix?: string
}

export function assertNoCoordinatorRecursion(envVars: NodeJS.ProcessEnv = process.env): void {
  if (envVars[ACTIVE_ENV_KEY] === '1') {
    throw new Error('Recursive coordinator entry is not allowed while FRESHELL_TEST_COORDINATOR_ACTIVE=1.')
  }
}

export function resolveVitestCommand(repoRoot: string): { command: string; args: string[] } {
  const require = createRequire(path.join(repoRoot, 'package.json'))
  return {
    command: process.execPath,
    args: [require.resolve('vitest/vitest.mjs')],
  }
}

export function resolveNpmCommand(
  args: string[],
  envVars: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const npmExecPath = envVars.npm_execpath
  if (npmExecPath && npmExecPath.endsWith('.js')) {
    return {
      command: process.execPath,
      args: [npmExecPath, ...args],
    }
  }

  return {
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args,
  }
}

export function resolveCargoCommand(): { command: string; args: string[] } {
  return {
    command: process.platform === 'win32' ? 'cargo.exe' : 'cargo',
    args: [],
  }
}

/** A stable, human-readable name for a phase, used in logs, status, and fake-upstream behavior maps. */
export function describeUpstreamPhase(phase: UpstreamPhase): string {
  switch (phase.runner) {
    case 'npm':
      return `npm:${phase.script}${phase.args.length > 0 ? ` ${phase.args.join(' ')}` : ''}`
    case 'cargo':
      return `cargo:${phase.args.join(' ')}`.trimEnd()
    case 'cloud-vitest':
      return `cloud-vitest:default${phase.args.length > 0 ? ` ${phase.args.join(' ')}` : ''}`
    case 'vitest':
      return `vitest:${phase.config}:${phase.args.join(' ')}`.trimEnd()
  }
}

export function startUpstreamPhase(
  phase: UpstreamPhase,
  envVars: NodeJS.ProcessEnv = process.env,
  options: StartPhaseOptions = {},
): RunningPhase {
  const childEnv: NodeJS.ProcessEnv = {
    ...envVars,
    [ACTIVE_ENV_KEY]: '1',
  }
  const spawnSpec = resolveSpawnSpec(phase, childEnv)

  const fakeUpstreamPath = childEnv[FAKE_UPSTREAM_ENV_KEY]
  if (fakeUpstreamPath) {
    return startProcess(
      process.execPath,
      [
        fakeUpstreamPath,
        JSON.stringify({
          selector: describeUpstreamPhase(phase),
          command: spawnSpec.command,
          args: spawnSpec.args,
        }),
      ],
      childEnv,
      options,
    )
  }

  return startProcess(spawnSpec.command, spawnSpec.args, childEnv, options)
}

export async function runUpstreamPhase(
  phase: UpstreamPhase,
  envVars: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return startUpstreamPhase(phase, envVars).exitCode
}

function resolveSpawnSpec(phase: UpstreamPhase, envVars: NodeJS.ProcessEnv): { command: string; args: string[] } {
  if (phase.runner === 'npm') {
    const forwardedArgs = phase.args.length > 0 ? ['--', ...phase.args] : []
    return resolveNpmCommand(['run', phase.script, ...forwardedArgs], envVars)
  }

  if (phase.runner === 'cargo') {
    const cargo = resolveCargoCommand()
    return {
      command: cargo.command,
      args: [...cargo.args, ...phase.args],
    }
  }

  if (phase.runner === 'cloud-vitest') {
    return resolveCloudVitestCommand(phase.args, envVars)
  }

  const repoRoot = envVars[REPO_ROOT_ENV_KEY] ?? process.cwd()
  const vitest = resolveVitestCommand(repoRoot)
  return {
    command: vitest.command,
    args: [...vitest.args, ...phase.args],
  }
}

function startProcess(
  command: string,
  args: string[],
  envVars: NodeJS.ProcessEnv,
  options: StartPhaseOptions,
): RunningPhase {
  const { outputPrefix } = options
  const concurrent = outputPrefix !== undefined
  const child = spawn(command, args, {
    env: envVars,
    stdio: concurrent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    detached: concurrent && process.platform !== 'win32',
    windowsHide: true,
  })
  let exited = false

  const exitCode = new Promise<number>((resolve, reject) => {
    let settled = false
    let drainTimer: NodeJS.Timeout | undefined
    const settle = (action: () => void): void => {
      if (settled) return
      settled = true
      if (drainTimer) clearTimeout(drainTimer)
      action()
    }

    child.once('error', (error) => {
      exited = true
      settle(() => reject(error))
    })

    if (outputPrefix === undefined) {
      child.once('exit', (code, signal) => {
        exited = true
        settle(() => resolve(exitCodeFor(code, signal)))
      })
      return
    }

    const stdout = createLinePrefixer(outputPrefix, (text) => process.stdout.write(text))
    const stderr = createLinePrefixer(outputPrefix, (text) => process.stderr.write(text))
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk))
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => settle(() => {
      stdout.flush()
      stderr.flush()
      resolve(exitCodeFor(code, signal))
    })

    child.once('close', finish)
    child.once('exit', (code, signal) => {
      exited = true
      // A descendant that inherited the pipes can hold them open after the
      // phase itself exits; report the phase's exit instead of waiting on it.
      drainTimer = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        finish(code, signal)
      }, OUTPUT_DRAIN_MS)
    })
  })

  const stop = async (signal: NodeJS.Signals, graceMs: number): Promise<number> => {
    if (!exited && child.pid !== undefined) {
      const signalled = signalProcessTree(child.pid, signal)
      const deadline = Date.now() + graceMs
      while (Date.now() < deadline && (!exited || signalled.some((pid) => isProcessRunning(pid)))) {
        await delay(STOP_POLL_MS)
      }
      for (const pid of signalled) {
        if (!isProcessRunning(pid)) continue
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Exited between the check and the kill.
        }
      }
    }
    return exitCode.catch(() => 1)
  }

  return { pid: child.pid, exitCode, stop }
}

function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === 'number') return code
  if (signal) return 128 + (osConstants.signals[signal as keyof typeof osConstants.signals] ?? 1)
  return 1
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
