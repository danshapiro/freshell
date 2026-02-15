// server/updater/types.ts
// Note: GitHubRelease type is now defined in version-checker.ts via Zod schema
// and re-exported from there for validation purposes

export interface UpdateCheckResult {
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string | null
  releaseUrl: string | null
  error: string | null
}

// Executor types
export type UpdateStep = 'verify-tag' | 'git-pull' | 'npm-install' | 'build' | 'rollback'
export type UpdateStatus = 'running' | 'complete' | 'error'

export interface UpdateProgress {
  step: UpdateStep
  status: UpdateStatus
  error?: string
}

export interface UpdateResult {
  success: boolean
  error?: string
  snapshotSha?: string
  rolledBack?: boolean
}
