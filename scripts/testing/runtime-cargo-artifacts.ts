import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { SYNC_BUILD_TIMEOUT_MS } from './sync-subprocess.js'

export type CargoArtifactCopy = { source: string; target: string }

export function runtimeCargoTargetDirectory(repoRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(repoRoot, env.CARGO_TARGET_DIR || 'target')
}

/** Coordinate every host-side runtime harness Cargo producer, including tests.
 * Cargo releases its own build lock before a caller can snapshot the output.
 * Keep this separate lock until the run-private executable has been copied.
 */
export function runtimeCargoCommand(
  repoRoot: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = SYNC_BUILD_TIMEOUT_MS,
): { command: string; args: string[] } {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('runtime Cargo watchdog requires a positive finite millisecond budget')
  }
  // The managed Docker harness is Linux-only. Other platforms have no managed
  // feature variants competing with the ordinary browser server build.
  if (process.platform !== 'linux') return { command, args }
  const targetDirectory = runtimeCargoTargetDirectory(repoRoot, env)
  fs.mkdirSync(targetDirectory, { recursive: true })
  const lock = path.join(fs.realpathSync(targetDirectory), '.freshell-runtime-artifacts.lock')
  // Bound acquisition in flock itself. An outer exec timeout could kill the
  // lock owner while its worker was still building or copying an executable.
  // The flock parent retains ownership through the worker's completion.
  return { command: 'flock', args: ['--close', '--wait', String(timeoutMs / 1000), lock, command, ...args] }
}

export function runtimeCargoBuildAndCopy(
  repoRoot: string,
  command: string,
  args: string[],
  copies: CargoArtifactCopy[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = SYNC_BUILD_TIMEOUT_MS,
): void {
  const worker = path.join(import.meta.dirname, 'runtime-cargo-artifacts-worker.mjs')
  const locked = runtimeCargoCommand(repoRoot, process.execPath, [worker, JSON.stringify({ command, args, copies, timeoutMs })], env, timeoutMs)
  try {
    execFileSync(locked.command, locked.args, { cwd: repoRoot, env, stdio: ['inherit', 'inherit', 'inherit', 'pipe'] })
  } catch (error) {
    const report = (error as { output?: (Buffer | null)[] }).output?.[3]
    if (!report) throw error
    let failure: NodeJS.ErrnoException & { dest?: string; status?: number | null; signal?: NodeJS.Signals | null; pid?: number; killed?: boolean }
    try { failure = JSON.parse(report.toString()) } catch { throw error }
    if (!failure || typeof failure.message !== 'string') throw error
    throw Object.assign(new Error(failure.message, { cause: error }), failure)
  }
}
