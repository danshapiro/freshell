import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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
): { command: string; args: string[] } {
  // The managed Docker harness is Linux-only. Other platforms have no managed
  // feature variants competing with the ordinary browser server build.
  if (process.platform !== 'linux') return { command, args }
  const targetDirectory = runtimeCargoTargetDirectory(repoRoot, env)
  fs.mkdirSync(targetDirectory, { recursive: true })
  const lock = path.join(fs.realpathSync(targetDirectory), '.freshell-runtime-artifacts.lock')
  // The flock parent keeps ownership through the command (and snapshot copy),
  // while surviving Cargo descendants must not retain its lock descriptor.
  return { command: 'flock', args: ['--close', lock, command, ...args] }
}

export function runtimeCargoBuildAndCopy(
  repoRoot: string,
  command: string,
  args: string[],
  copies: CargoArtifactCopy[],
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs?: number,
): void {
  const worker = path.join(import.meta.dirname, 'runtime-cargo-artifacts-worker.mjs')
  const locked = runtimeCargoCommand(repoRoot, process.execPath, [worker, JSON.stringify({ command, args, copies, timeoutMs })], env)
  try {
    execFileSync(locked.command, locked.args, { cwd: repoRoot, env, stdio: ['inherit', 'inherit', 'inherit', 'pipe'] })
  } catch (error) {
    const report = (error as { output?: (Buffer | null)[] }).output?.[3]
    if (!report) throw error
    let failure: NodeJS.ErrnoException & { dest?: string }
    try { failure = JSON.parse(report.toString()) } catch { throw error }
    if (!failure || typeof failure.message !== 'string') throw error
    throw Object.assign(new Error(failure.message, { cause: error }), failure)
  }
}
