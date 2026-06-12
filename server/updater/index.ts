// server/updater/index.ts
import { checkForUpdate } from './version-checker.js'
import { promptForUpdate } from './prompt.js'
import { executeUpdate, type UpdateProgress } from './executor.js'

export type UpdateAction = 'none' | 'updated' | 'skipped' | 'error' | 'check-failed'

export interface UpdateCheckResult {
  action: UpdateAction
  error?: string
  newVersion?: string
}

function printProgress(progress: UpdateProgress): void {
  const labels: Record<string, string> = {
    'git-pull': 'Pulling latest changes',
    'npm-install': 'Installing dependencies',
    'build': 'Building application'
  }

  const label = labels[progress.step] || progress.step

  if (progress.status === 'running') {
    process.stdout.write(`  \u29bf ${label}...\r`)
  } else if (progress.status === 'complete') {
    console.log(`  \u2714 ${label}`)
  } else if (progress.status === 'error') {
    console.log(`  \u2718 ${label}: ${progress.error}`)
  }
}

export async function runUpdateCheck(currentVersion: string): Promise<UpdateCheckResult> {
  const checkResult = await checkForUpdate(currentVersion)

  if (checkResult.error) {
    return { action: 'check-failed', error: checkResult.error }
  }

  if (!checkResult.updateAvailable || !checkResult.latestVersion) {
    return { action: 'none' }
  }

  const shouldUpdate = await promptForUpdate(currentVersion, checkResult.latestVersion)

  if (!shouldUpdate) {
    console.log('Skipping update.\n')
    return { action: 'skipped' }
  }

  console.log('\nUpdating Freshell...\n')

  const updateResult = await executeUpdate(printProgress)

  if (!updateResult.success) {
    console.log('\n\x1b[31mUpdate failed!\x1b[0m Please try updating manually.\n')
    return { action: 'error', error: updateResult.error }
  }

  console.log('\n\x1b[32mUpdate complete!\x1b[0m Restarting...\n')
  return { action: 'updated', newVersion: checkResult.latestVersion }
}

/**
 * Determines if the update check should be skipped based on environment.
 *
 * Skips when:
 * - --skip-update-check CLI flag is present
 * - SKIP_UPDATE_CHECK env var is 'true'
 * - Running via 'npm run dev' (predev lifecycle event)
 * - Current branch is not main or cannot be determined
 *
 * Does NOT skip based on NODE_ENV because that may be set persistently
 * in dev environments even when running 'npm run serve'.
 */
export interface SkipCheckOptions {
  argv?: string[]
  env?: NodeJS.ProcessEnv
  branch?: string
}

function shouldSkipSourceUpdateForBranch(branch: string | undefined): boolean {
  const currentBranch = branch?.trim()
  if (!currentBranch) return true
  return currentBranch !== 'main'
}

export function shouldSkipUpdateCheck(options: SkipCheckOptions = {}): boolean {
  const argv = options.argv ?? process.argv
  const env = options.env ?? process.env

  if (argv.includes('--skip-update-check')) return true
  if (env.SKIP_UPDATE_CHECK === 'true') return true
  if (env.npm_lifecycle_event === 'predev') return true
  if (shouldSkipSourceUpdateForBranch(options.branch)) return true

  return false
}

// Re-export for convenience
export { checkForUpdate } from './version-checker.js'
export { executeUpdate } from './executor.js'
export type { UpdateProgress } from './executor.js'
