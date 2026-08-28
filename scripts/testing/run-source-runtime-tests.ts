#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..')
const REQUIRE = createRequire(path.join(PROJECT_ROOT, 'package.json'))

function log(severity: 'info' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const stream = severity === 'error' ? process.stderr : process.stdout
  stream.write(`${JSON.stringify({ severity, event, timestamp: new Date().toISOString(), ...fields })}\n`)
}

function npmCommand(): string {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function buildSourceRuntimePhases(npm = npmCommand()): Array<{ command: string; args: string[] }> {
  return [
    // build:client/build:tools write the artifacts served by Freshell. Run the
    // shared guard first so a direct source-runtime invocation is safe on a
    // normal checkout with the production Rust server running.
    { command: npm, args: ['run', 'prebuild'] },
    { command: npm, args: ['run', 'build:client'] },
    { command: npm, args: ['run', 'build:tools'] },
    { command: 'cargo', args: ['build', '--release', '-p', 'freshell-server', '--locked'] },
  ]
}

function runChild(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    log('info', 'source_runtime_phase_started', { command, args })
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        cwd: PROJECT_ROOT,
        env,
        stdio: 'inherit',
        windowsHide: true,
      })
    } catch (error) {
      log('error', 'source_runtime_phase_spawn_failed', {
        command,
        args,
        error: error instanceof Error ? error.message : String(error),
      })
      resolve(1)
      return
    }

    const forwardSignal = (signal: NodeJS.Signals) => {
      if (child.exitCode === null && !child.killed) child.kill(signal)
    }
    process.once('SIGINT', forwardSignal)
    process.once('SIGTERM', forwardSignal)
    process.once('SIGHUP', forwardSignal)

    const finish = (code: number, signal: NodeJS.Signals | null) => {
      process.off('SIGINT', forwardSignal)
      process.off('SIGTERM', forwardSignal)
      process.off('SIGHUP', forwardSignal)
      if (code !== 0 || signal) {
        log('error', 'source_runtime_phase_failed', { command, args, code, signal })
      } else {
        log('info', 'source_runtime_phase_finished', { command, args, code })
      }
      resolve(code)
    }

    child.once('error', (error) => {
      log('error', 'source_runtime_phase_child_error', {
        command,
        args,
        pid: child.pid,
        error: error.message,
      })
      finish(1, null)
    })
    child.once('exit', (code, signal) => finish(code ?? 1, signal))
  })
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const noTestsOverride = '--passWithNoTests'
  if (argv.some((arg) => arg === noTestsOverride || arg.startsWith(`${noTestsOverride}=`))) {
    log('error', 'source_runtime_vacuous_flag_rejected', {
      message: `The source-runtime lane must fail when its selector is empty; ${noTestsOverride} is not allowed.`,
    })
    return 2
  }

  for (const phase of buildSourceRuntimePhases()) {
    const exitCode = await runChild(phase.command, phase.args, process.env)
    if (exitCode !== 0) return exitCode
  }

  const vitest = REQUIRE.resolve('vitest/vitest.mjs')
  const config = path.join(PROJECT_ROOT, 'config', 'vitest', 'vitest.runtime.config.ts')
  return runChild(process.execPath, [vitest, 'run', '--config', config, ...argv], process.env)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error: unknown) => {
    log('error', 'source_runtime_phase_unhandled_error', {
      error: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
  })
}
