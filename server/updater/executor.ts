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
}

export async function executeUpdate(
  onProgress: (progress: UpdateProgress) => void,
  execAsync: ExecAsyncFn = defaultExecAsync,
  options: ExecuteUpdateOptions = {}
): Promise<UpdateResult> {
  const projectRoot = options.projectRoot ?? findProjectRoot()

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
      let errorMsg: string
      if (err instanceof Error) {
        // ExecException from child_process includes stderr in the error
        const execErr = err as Error & { stderr?: string }
        errorMsg = execErr.stderr ? `${err.message}\n${execErr.stderr}` : err.message
      } else {
        errorMsg = String(err)
      }
      onProgress({ step, status: 'error', error: errorMsg })
      return { success: false, error: errorMsg }
    }
  }

  return { success: true }
}
