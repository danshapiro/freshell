// server/updater/executor.ts
import { exec as nodeExec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import type { UpdateProgress, UpdateResult, UpdateStep, UpdateStatus } from './types.js'

const defaultExecAsync = promisify(nodeExec)

// Re-export types for convenience
export type { UpdateProgress, UpdateResult, UpdateStep, UpdateStatus }

export type ExecAsyncFn = (command: string, options: { cwd: string }) => Promise<{ stdout: string; stderr: string }>

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Find the project root by searching upward from the current directory
 * for a package.json file. This works whether running from source or dist.
 */
function findProjectRoot(startDir: string = __dirname): string {
  let currentDir = startDir
  while (currentDir !== path.parse(currentDir).root) {
    if (fs.existsSync(path.join(currentDir, 'package.json'))) {
      return currentDir
    }
    currentDir = path.dirname(currentDir)
  }
  // Fallback to relative path from __dirname if package.json not found
  return path.resolve(__dirname, '../..')
}

export interface ExecuteUpdateOptions {
  projectRoot?: string
  targetTag?: string
  requireGpgVerification?: boolean
}

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const execErr = err as Error & { stderr?: string }
    return execErr.stderr ? `${err.message}\n${execErr.stderr}` : err.message
  }
  return String(err)
}

/**
 * Attempt to roll back to a previous commit SHA after a failed update.
 * Runs git reset --hard to restore code, then npm ci to restore dependencies.
 */
async function rollback(
  snapshotSha: string,
  projectRoot: string,
  onProgress: (progress: UpdateProgress) => void,
  execAsync: ExecAsyncFn
): Promise<boolean> {
  onProgress({ step: 'rollback', status: 'running' })
  try {
    await execAsync(`git reset --hard ${snapshotSha}`, { cwd: projectRoot })
    await execAsync('npm ci', { cwd: projectRoot })
    onProgress({ step: 'rollback', status: 'complete' })
    return true
  } catch (rollbackErr: unknown) {
    const rollbackMsg = extractErrorMessage(rollbackErr)
    onProgress({ step: 'rollback', status: 'error', error: rollbackMsg })
    return false
  }
}

export async function executeUpdate(
  onProgress: (progress: UpdateProgress) => void,
  execAsync: ExecAsyncFn = defaultExecAsync,
  options: ExecuteUpdateOptions = {}
): Promise<UpdateResult> {
  const projectRoot = options.projectRoot ?? findProjectRoot()

  // Snapshot current HEAD for rollback
  let snapshotSha: string | undefined
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', { cwd: projectRoot })
    snapshotSha = stdout.trim()
  } catch {
    // If we can't get the SHA, we can't rollback — continue without it
  }

  // GPG tag verification (optional)
  if (options.targetTag) {
    onProgress({ step: 'verify-tag', status: 'running' })

    // Fetch the tag first so git verify-tag can find it
    try {
      await execAsync(`git fetch origin tag ${options.targetTag}`, { cwd: projectRoot })
    } catch {
      // Tag fetch failed — verification will also fail, handled below
    }

    try {
      await execAsync(`git verify-tag ${options.targetTag}`, { cwd: projectRoot })
      onProgress({ step: 'verify-tag', status: 'complete' })
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err)
      if (options.requireGpgVerification) {
        onProgress({ step: 'verify-tag', status: 'error', error: errorMsg })
        return { success: false, error: errorMsg, snapshotSha }
      }
      // Permissive mode: warn but continue
      onProgress({ step: 'verify-tag', status: 'error', error: errorMsg })
    }
  }

  // Core update steps
  const steps: { step: UpdateStep; command: string }[] = [
    { step: 'git-pull', command: 'git pull' },
    { step: 'npm-install', command: 'npm ci' },
    { step: 'build', command: 'npm run build' }
  ]

  for (const { step, command } of steps) {
    onProgress({ step, status: 'running' })

    try {
      await execAsync(command, { cwd: projectRoot })
      onProgress({ step, status: 'complete' })
    } catch (err: unknown) {
      const errorMsg = extractErrorMessage(err)
      onProgress({ step, status: 'error', error: errorMsg })

      // Rollback if we have a snapshot and this isn't the git-pull step
      // (git-pull failure means code hasn't changed yet, no rollback needed)
      if (snapshotSha && step !== 'git-pull') {
        const rolledBack = await rollback(snapshotSha, projectRoot, onProgress, execAsync)
        return { success: false, error: errorMsg, snapshotSha, rolledBack }
      }

      return { success: false, error: errorMsg, snapshotSha }
    }
  }

  return { success: true, snapshotSha }
}
