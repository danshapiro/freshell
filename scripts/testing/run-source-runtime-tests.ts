#!/usr/bin/env node

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { constants as osConstants } from 'node:os'
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

function runChild(command: string, args: string[], env: NodeJS.ProcessEnv, viaShell = false, phase = 'runtime-suite'): Promise<number> {
  return new Promise((resolve) => {
    // Selectors may contain caller text. Log counts and identities, never
    // the shell payload or forwarded arguments.
    const metadata = { phase, argumentCount: args.length }
    log('info', 'source_runtime_phase_started', metadata)
    let settled = false
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        cwd: PROJECT_ROOT,
        env,
        stdio: 'inherit',
        windowsHide: true,
        shell: viaShell,
      })
      log('info', 'source_runtime_child_started', { ...metadata, pid: child.pid })
    } catch (error) {
      log('error', 'source_runtime_phase_spawn_failed', {
        ...metadata,
        error: error instanceof Error ? error.message : String(error),
      })
      resolve(1)
      return
    }

    const handlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map(signal => {
      // Node signal listeners have no argument; capture the actual signal.
      const handler = () => { if (child.exitCode === null) child.kill(signal) }
      process.on(signal, handler)
      return { signal, handler }
    })

    const finish = (code: number, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      for (const { signal: forwarded, handler } of handlers) process.off(forwarded, handler)
      if (code !== 0 || signal) {
        log('error', 'source_runtime_phase_failed', { ...metadata, pid: child.pid, code, signal })
      } else {
        log('info', 'source_runtime_phase_finished', { ...metadata, pid: child.pid, code })
      }
      resolve(code)
    }

    child.once('error', (error) => {
      log('error', 'source_runtime_phase_child_error', {
        ...metadata,
        pid: child.pid,
        error: error.message,
      })
      finish(1, null)
    })
    // Join closed stdio as well as process exit before starting another phase.
    child.once('close', (code, signal) => finish(code ?? (signal ? 128 + (osConstants.signals[signal] ?? 1) : 1), signal))
  })
}

export async function runSourceRuntimeSuite(argv: string[]): Promise<number> {
  const vitest = resolveVitestCommand(PROJECT_ROOT)
  const config = path.join(PROJECT_ROOT, 'config', 'vitest', 'vitest.runtime.config.ts')
  return runChild(vitest.command, [...vitest.args, 'run', '--config', config, ...argv], process.env)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function sandboxCommand(argv: string[], commit: string): string {
  return `set -e
owned_tmp="$(mktemp -d /freshell-test-artifacts/.freshell-source-runtime-XXXXXXXX)"
runner_pid=
cleanup() {
  status=$?
  trap - EXIT
  if rm -rf -- "$owned_tmp" && [ ! -e "$owned_tmp" ]; then
    printf '{"severity":"info","event":"source_runtime_temp_settled","directory":"%s","code":%s}\\n' "$owned_tmp" "$status"
  else
    status=1
    printf '{"severity":"error","event":"source_runtime_temp_cleanup_failed","directory":"%s","code":1}\\n' "$owned_tmp"
  fi
  exit "$status"
}
interrupt() {
  trap '' INT TERM HUP
  if [ -n "$runner_pid" ]; then
    kill -s "$1" "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" || true
  fi
  exit "$2"
}
trap cleanup EXIT
trap 'interrupt INT 130' INT
trap 'interrupt TERM 143' TERM
trap 'interrupt HUP 129' HUP
export TMPDIR="$owned_tmp" FRESHELL_TEST_EXECUTABLE_TMP_DIR="$owned_tmp" FRESHELL_RUST_TEST_SANDBOX=0 CARGO_BUILD_JOBS=3 FRESHELL_BUILD_COMMIT=${shellQuote(commit)}
printf '{"severity":"info","event":"source_runtime_temp_created","directory":"%s"}\\n' "$owned_tmp"
# Native client/tools preparation has already completed. Only the container
# target is hidden by the sandbox volume, so prepare its current server there.
cargo build --release -p freshell-server --locked &
runner_pid=$!
wait "$runner_pid"
node --import tsx --input-type=module -e 'import { runSourceRuntimeSuite } from "/workspace/scripts/testing/run-source-runtime-tests.ts"; process.exitCode = await runSourceRuntimeSuite(process.argv.slice(1))' -- ${argv.map(shellQuote).join(' ')} &
runner_pid=$!
wait "$runner_pid"`
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const forwarded = argv[0] === '--' ? argv.slice(1) : argv
  const noTestsOverride = '--passWithNoTests'
  if (forwarded.some((arg) => arg === noTestsOverride || arg.startsWith(`${noTestsOverride}=`))) {
    log('error', 'source_runtime_vacuous_flag_rejected', {
      message: `The source-runtime lane must fail when its selector is empty; ${noTestsOverride} is not allowed.`,
    })
    return 2
  }

  const phaseNames = ['prebuild', 'build-client', 'build-tools', 'build-release']
  for (const [index, phase] of buildSourceRuntimePhases().entries()) {
    const exitCode = await runChild(phase.command, phase.args, process.env, phase.viaShell ?? false, phaseNames[index])
    if (exitCode !== 0) return exitCode
  }

  if (process.env.FRESHELL_RUST_TEST_SANDBOX === '1') {
    // Linked-worktree Git metadata is outside the bind mount. Transport only
    // the validated commit identity, never the host Git directory or binary.
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: PROJECT_ROOT, encoding: 'utf8' }).trim()
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Cannot identify the source-runtime build commit.')
    log('info', 'source_runtime_sandbox_route_selected', { mode: 'runtime-suite', forwardedArgumentCount: forwarded.length, commit })
    const { FRESHELL_SERVER_BIN: _hostBinary, ...env } = process.env
    return runChild(path.join(PROJECT_ROOT, 'scripts/sandbox-test.sh'), ['--runtime-suite', sandboxCommand(forwarded, commit)], env, false, 'sandbox')
  }
  return runSourceRuntimeSuite(forwarded)
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
