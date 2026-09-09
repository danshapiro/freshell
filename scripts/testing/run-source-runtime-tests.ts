#!/usr/bin/env node

import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  buildRunScriptArgs,
  detectProjectManager,
  resolveManagerCommand,
} from '../lib/package-manager.js'
import { resolveVitestCommand } from './coordinator-upstream.js'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..')

function log(severity: 'info' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const stream = severity === 'error' ? process.stderr : process.stdout
  stream.write(`${JSON.stringify({ severity, event, timestamp: new Date().toISOString(), ...fields })}\n`)
}

export interface SourceRuntimePhase {
  command: string
  args: string[]
  viaShell?: boolean
}

export function buildSourceRuntimePhases(managerCommand?: string): SourceRuntimePhase[] {
  if (managerCommand !== undefined) {
    const runOverride = (script: string): SourceRuntimePhase => ({ command: managerCommand, args: ['run', script] })
    return [
      runOverride('prebuild'),
      runOverride('build:client'),
      runOverride('build:tools'),
      { command: 'cargo', args: ['build', '--release', '-p', 'freshell-server', '--locked'] },
    ]
  }
  const manager = detectProjectManager(PROJECT_ROOT).manager
  const runScript = (script: string): SourceRuntimePhase => {
    const resolved = resolveManagerCommand({
      manager,
      args: buildRunScriptArgs(manager, script, []),
      env: process.env,
    })
    return {
      command: resolved.command,
      args: resolved.args,
      ...(resolved.viaShell === true ? { viaShell: true } : {}),
    }
  }
  return [
    // build:client/build:tools write the artifacts served by Freshell. Run the
    // shared guard first so a direct source-runtime invocation is safe on a
    // normal checkout with the production Rust server running.
    runScript('prebuild'),
    runScript('build:client'),
    runScript('build:tools'),
    { command: 'cargo', args: ['build', '--release', '-p', 'freshell-server', '--locked'] },
  ]
}

function runChild(command: string, args: string[], env: NodeJS.ProcessEnv, viaShell = false): Promise<number> {
  return new Promise((resolve) => {
    log('info', 'source_runtime_phase_started', { command, args })
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        cwd: PROJECT_ROOT,
        env,
        stdio: 'inherit',
        windowsHide: true,
        shell: viaShell,
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
    const exitCode = await runChild(phase.command, phase.args, process.env, phase.viaShell ?? false)
    if (exitCode !== 0) return exitCode
  }

  const vitest = resolveVitestCommand(PROJECT_ROOT)
  const config = path.join(PROJECT_ROOT, 'config', 'vitest', 'vitest.runtime.config.ts')
  return runChild(vitest.command, [...vitest.args, 'run', '--config', config, ...argv], process.env)
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
