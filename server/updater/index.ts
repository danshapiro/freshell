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

// Re-export for convenience
export { checkForUpdate } from './version-checker.js'
export { executeUpdate } from './executor.js'
export type { UpdateProgress } from './executor.js'
