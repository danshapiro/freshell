#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { constants as osConstants } from 'node:os'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..')

function log(severity: 'info' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const stream = severity === 'error' ? process.stderr : process.stdout
  stream.write(`${JSON.stringify({ severity, event, timestamp: new Date().toISOString(), ...fields })}\n`)
}

function runChild(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    log('info', 'rust_test_phase_started', { command, args })
    let settled = false
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        cwd: PROJECT_ROOT,
        env,
        stdio: 'inherit',
        windowsHide: true,
      })
    } catch (error) {
      log('error', 'rust_test_phase_spawn_failed', {
        command,
        args,
        error: error instanceof Error ? error.message : String(error),
      })
      resolve(1)
      return
    }

    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
    const forwardSignal = (signal: typeof signals[number]) => {
      if (child.exitCode === null && !child.killed) child.kill(signal)
    }
    for (const signal of signals) process.once(signal, forwardSignal)

    const finish = (code: number, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      for (const forwardedSignal of signals) process.off(forwardedSignal, forwardSignal)
      if (code !== 0 || signal) {
        log('error', 'rust_test_phase_failed', { command, args, code, signal })
      } else {
        log('info', 'rust_test_phase_finished', { command, args, code })
      }
      resolve(code)
    }

    child.once('error', (error) => {
      log('error', 'rust_test_phase_spawn_failed', {
        command,
        args,
        error: error.message,
      })
      finish(1, null)
    })
    child.once('exit', (code, signal) => {
      const exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 1) : 1)
      finish(exitCode, signal)
    })
  })
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const binary = path.join(PROJECT_ROOT, 'target', 'debug', `freshell-server${process.platform === 'win32' ? '.exe' : ''}`)
  const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const buildExitCode = await runChild(cargo, ['build', '-p', 'freshell-server', '--locked'], process.env)
  if (buildExitCode !== 0) return buildExitCode

  const forwarded = argv[0] === '--' ? argv.slice(1) : argv
  const env = {
    ...process.env,
    FRESHELL_SERVER_BIN: binary,
  }
  return runChild(cargo, ['test', '--workspace', '--locked', ...forwarded], env)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().then((code) => {
    process.exitCode = code
  }).catch((error: unknown) => {
    log('error', 'rust_test_phase_unhandled_error', {
      error: error instanceof Error ? error.message : String(error),
    })
    process.exitCode = 1
  })
}
