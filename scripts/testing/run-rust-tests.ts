#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { constants as osConstants } from 'node:os'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '../..')
const SANDBOX_CARGO_BUILD_JOBS = 3
const SANDBOX_RUST_TEST_THREADS = 4
const SANDBOX_TOKIO_WORKER_THREADS = 2
// All worktrees mount at /workspace; choose the namespace on the host first.
const SANDBOX_TARGET_DIRECTORY = `/freshell-test-artifacts/targets/${createHash('sha256').update(PROJECT_ROOT).digest('hex').slice(0, 12)}`

export function shouldRunProviderCrashRecoveryGate(platform: NodeJS.Platform, forwardedArgs: readonly string[]): boolean {
  return platform !== 'win32' && forwardedArgs.length === 0
}

function log(severity: 'info' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const stream = severity === 'error' ? process.stderr : process.stdout
  stream.write(`${JSON.stringify({ severity, event, timestamp: new Date().toISOString(), ...fields })}\n`)
}

function runChild(command: string, args: string[], env: NodeJS.ProcessEnv, sandbox = false): Promise<number> {
  return new Promise((resolve) => {
    const metadata = sandbox ? { command, mode: 'runtime-suite', argumentCount: args.length } : { command, args }
    log('info', 'rust_test_phase_started', metadata)
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
        ...metadata,
        error: error instanceof Error ? error.message : String(error),
      })
      resolve(1)
      return
    }

    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
    // Node signal listeners receive no argument. Capture each signal so the
    // sandbox wrapper receives the actual request and can settle its workload.
    const handlers = signals.map(signal => {
      const handler = () => { if (child.exitCode === null) child.kill(signal) }
      process.on(signal, handler)
      return { signal, handler }
    })

    const finish = (code: number, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      for (const { signal: forwardedSignal, handler } of handlers) process.off(forwardedSignal, handler)
      if (code !== 0 || signal) {
        log('error', 'rust_test_phase_failed', { ...metadata, code, signal })
      } else {
        log('info', 'rust_test_phase_finished', { ...metadata, code })
      }
      resolve(code)
    }

    child.once('error', (error) => {
      log('error', 'rust_test_phase_spawn_failed', {
        ...metadata,
        error: error.message,
      })
      finish(1, null)
    })
    child.once('close', (code, signal) => {
      const exitCode = code ?? (signal ? 128 + (osConstants.signals[signal] ?? 1) : 1)
      finish(exitCode, signal)
    })
  })
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function sandboxCommand(argv: string[]): string {
  // Fixed wrapper text owns only its two newly allocated temporary directories.
  // Arguments remain separately quoted words; none becomes shell code.
  return `set -e
owned_tmp="$(mktemp -d /freshell-test-artifacts/.freshell-rust-tests-XXXXXXXX)"
# Ordinary Rust fixtures append UUID-bearing Unix socket paths. Keep their
# actual root short; executable fixtures retain the separate artifact boundary.
owned_runtime_tmp="$owned_tmp"
runner_pid=
remove_owned_temps() {
  # Transfer fixtures deliberately seal ready directories. Restore only owner
  # directory writes within our two roots; never follow links to other data.
  for directory in "$owned_tmp" "$owned_runtime_tmp"; do
    # Signal cleanup can run before EXIT cleanup; an absent root is settled.
    if [ -d "$directory" ]; then
      find -P "$directory" -type d -uid "$(id -u)" -exec chmod u+w -- {} + || return 1
    fi
  done
  rm -rf -- "$owned_tmp" "$owned_runtime_tmp"
}
cleanup() {
  status=$?
  trap - EXIT
  remove_owned_temps || {
    printf '{"severity":"error","event":"rust_test_temp_cleanup_failed"}\\n' >&2
    [ "$status" -ne 0 ] || status=1
  }
  exit "$status"
}
interrupt() {
  trap '' INT TERM HUP
  if [ -n "$runner_pid" ]; then
    kill -s "$1" "$runner_pid" 2>/dev/null || true
    # A child may ignore termination. Remove our artifacts before waiting;
    # the sandbox owner separately settles all remaining container work.
    remove_owned_temps
    wait "$runner_pid" || true
  fi
  exit "$2"
}
trap cleanup EXIT
trap 'interrupt INT 130' INT
trap 'interrupt TERM 143' TERM
trap 'interrupt HUP 129' HUP
# Three random characters leave room for tempfile/runtime/incarnation UUIDs
# under Linux sun_path, while this existing volume permits fixture execution.
owned_runtime_tmp="$(mktemp -d /freshell-test-artifacts/XXX)"
printf '{"severity":"info","event":"rust_test_temp_created","directory":"%s","runtimeDirectory":"%s"}\\n' "$owned_tmp" "$owned_runtime_tmp"
# Preserve every test while bounding independent libtest/Tokio runtimes within
# the sandbox's existing PID budget. Runtime construction precedes fixture locks.
export CARGO_TARGET_DIR=${shellQuote(SANDBOX_TARGET_DIRECTORY)}
export TMPDIR="$owned_runtime_tmp" FRESHELL_TEST_EXECUTABLE_TMP_DIR="$owned_tmp" FRESHELL_RUST_TEST_SANDBOX=0 CARGO_BUILD_JOBS=${SANDBOX_CARGO_BUILD_JOBS} RUST_TEST_THREADS=${SANDBOX_RUST_TEST_THREADS} TOKIO_WORKER_THREADS=${SANDBOX_TOKIO_WORKER_THREADS}
node --import tsx /workspace/scripts/testing/run-rust-tests.ts ${argv.map(shellQuote).join(' ')} &
runner_pid=$!
wait "$runner_pid"`
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (process.env.FRESHELL_RUST_TEST_SANDBOX === '1') {
    log('info', 'rust_test_sandbox_route_selected', {
      mode: 'runtime-suite', cargoTargetDirectory: SANDBOX_TARGET_DIRECTORY, cargoBuildJobs: SANDBOX_CARGO_BUILD_JOBS,
      rustTestThreads: SANDBOX_RUST_TEST_THREADS, tokioWorkerThreads: SANDBOX_TOKIO_WORKER_THREADS,
      forwardedArgumentCount: argv.length,
    })
    // The inner runner selects the server it builds in the sandbox's
    // worktree-specific Cargo target directory.
    const { FRESHELL_SERVER_BIN: _hostBinary, ...env } = process.env
    return runChild(path.join(PROJECT_ROOT, 'scripts/sandbox-test.sh'), ['--runtime-suite', sandboxCommand(argv)], { ...env, FRESHELL_SANDBOX_OWNER_GUARD: '1' }, true)
  }
  const targetDirectory = path.resolve(PROJECT_ROOT, process.env.CARGO_TARGET_DIR || 'target')
  const binary = path.join(targetDirectory, 'debug', `freshell-server${process.platform === 'win32' ? '.exe' : ''}`)
  const cargo = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const buildExitCode = await runChild(cargo, ['build', '-p', 'freshell-server', '--locked'], process.env)
  if (buildExitCode !== 0) return buildExitCode

  const forwarded = argv[0] === '--' ? argv.slice(1) : argv
  const env = {
    ...process.env,
    FRESHELL_SERVER_BIN: binary,
  }
  const testExitCode = await runChild(cargo, ['test', '--workspace', '--locked', ...forwarded], env)
  if (testExitCode !== 0 || !shouldRunProviderCrashRecoveryGate(process.platform, forwarded)) return testExitCode

  // The destructive provider-recovery parents stay ignored in ordinary host
  // Cargo runs. Schedule their exact selector in the disposable runtime suite
  // after the full workspace run so the normal Rust gate covers crash recovery.
  if (process.env.FRESHELL_SANDBOX_MODE === 'runtime-suite') {
    return runChild(process.execPath, [
      '--import', 'tsx', path.join(PROJECT_ROOT, 'scripts/testing/provider-crash-recovery-tests.ts'),
    ], env)
  }
  return runChild('bash', [
    'scripts/sandbox-test.sh',
    '--runtime-suite',
    'pnpm exec tsx scripts/testing/provider-crash-recovery-tests.ts',
  ], env)
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
