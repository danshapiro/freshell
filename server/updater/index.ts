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
    'verify-tag': 'Verifying release signature',
    'git-pull': 'Pulling latest changes',
    'npm-install': 'Installing dependencies',
    'build': 'Building application',
    'rollback': 'Rolling back to previous version'
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

  const targetTag = `v${checkResult.latestVersion}`
  const requireGpgVerification = process.env.REQUIRE_GPG_VERIFICATION === 'true'

  const updateResult = await executeUpdate(printProgress, undefined, {
    targetTag,
    requireGpgVerification
  })

  if (!updateResult.success) {
    const rollbackStatus = updateResult.rolledBack === true
      ? ' Rolled back to previous version.'
      : updateResult.rolledBack === false
        ? ' Rollback failed — manual recovery may be needed.'
        : ''
    console.log(`\n\x1b[31mUpdate failed!\x1b[0m${rollbackStatus} Please try updating manually.\n`)
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
 *
 * Does NOT skip based on NODE_ENV because that may be set persistently
 * in dev environments even when running 'npm run serve'.
 */
export interface SkipCheckOptions {
  argv?: string[]
  env?: NodeJS.ProcessEnv
}

export function shouldSkipUpdateCheck(options: SkipCheckOptions = {}): boolean {
  const argv = options.argv ?? process.argv
  const env = options.env ?? process.env

  if (argv.includes('--skip-update-check')) return true
  if (env.SKIP_UPDATE_CHECK === 'true') return true
  if (env.npm_lifecycle_event === 'predev') return true

  return false
}

// Re-export for convenience
export { checkForUpdate } from './version-checker.js'
export { executeUpdate } from './executor.js'
export type { UpdateProgress } from './executor.js'
