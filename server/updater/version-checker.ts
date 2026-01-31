// server/updater/version-checker.ts
import { z } from 'zod'
import type { UpdateCheckResult } from './types.js'

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/danshapiro/freshell/releases/latest'

/** Number of parts in a semantic version (major.minor.patch) */
const SEMVER_PARTS = 3

/** Zod schema for validating GitHub release API response */
export const GitHubReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string().url(),
  published_at: z.string(),
  body: z.string()
})

export type GitHubRelease = z.infer<typeof GitHubReleaseSchema>

export function parseVersion(version: string): string {
  return version.startsWith('v') ? version.slice(1) : version
}

/**
 * Compares two semantic version strings.
 * Returns true if remote is newer than current.
 *
 * Behavior notes:
 * - Supports two-part versions (e.g., "1.0" is treated as "1.0.0")
 * - Non-numeric parts (e.g., "1.x.0") are treated as 0
 * - Malformed versions are handled gracefully by treating invalid parts as 0
 */
export function isNewerVersion(current: string, remote: string): boolean {
  const parsePartSafe = (part: string | undefined): number => {
    const num = Number(part)
    return Number.isNaN(num) ? 0 : num
  }

  const currentParts = current.split('.').map(parsePartSafe)
  const remoteParts = remote.split('.').map(parsePartSafe)

  for (let i = 0; i < SEMVER_PARTS; i++) {
    const c = currentParts[i] ?? 0
    const r = remoteParts[i] ?? 0
    if (r > c) return true
    if (r < c) return false
  }

  return false
}

export async function checkForUpdate(currentVersion: string): Promise<UpdateCheckResult> {
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Freshell-Updater'
      }
    })

    if (!response.ok) {
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion: null,
        releaseUrl: null,
        error: `GitHub API returned ${response.status}`
      }
    }

    const json: unknown = await response.json()
    const parseResult = GitHubReleaseSchema.safeParse(json)

    if (!parseResult.success) {
      return {
        updateAvailable: false,
        currentVersion,
        latestVersion: null,
        releaseUrl: null,
        error: `Invalid GitHub API response: ${parseResult.error.message}`
      }
    }

    const release = parseResult.data
    const latestVersion = parseVersion(release.tag_name)

    return {
      updateAvailable: isNewerVersion(currentVersion, latestVersion),
      currentVersion,
      latestVersion,
      releaseUrl: release.html_url,
      error: null
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      updateAvailable: false,
      currentVersion,
      latestVersion: null,
      releaseUrl: null,
      error: message
    }
  }
}
