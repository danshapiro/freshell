// server/updater/version-checker.ts
import { z } from 'zod'
import type { UpdateCheckResult } from './types.js'

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/danshapiro/freshell/releases/latest'

/** Number of parts in a semantic version (major.minor.patch) */
const SEMVER_PARTS = 3
const MAJOR_INDEX = 0
const MINOR_INDEX = 1

function parseSemverParts(version: string): number[] {
  const parsePartSafe = (part: string | undefined): number => {
    const num = Number(part)
    return Number.isNaN(num) ? 0 : num
  }

  return version.split('.').map(parsePartSafe)
}

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
  const currentParts = parseSemverParts(current)
  const remoteParts = parseSemverParts(remote)

  for (let i = 0; i < SEMVER_PARTS; i++) {
    const c = currentParts[i] ?? 0
    const r = remoteParts[i] ?? 0
    if (r > c) return true
    if (r < c) return false
  }

  return false
}

/**
 * Returns true only when remote is at least a minor-version bump.
 * Patch-only increments (x.y.z -> x.y.z+1) are intentionally ignored.
 */
export function isMinorOrMajorNewer(current: string, remote: string): boolean {
  const currentParts = parseSemverParts(current)
  const remoteParts = parseSemverParts(remote)

  const currentMajor = currentParts[MAJOR_INDEX] ?? 0
  const remoteMajor = remoteParts[MAJOR_INDEX] ?? 0
  if (remoteMajor > currentMajor) return true
  if (remoteMajor < currentMajor) return false

  const currentMinor = currentParts[MINOR_INDEX] ?? 0
  const remoteMinor = remoteParts[MINOR_INDEX] ?? 0
  return remoteMinor > currentMinor
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
      updateAvailable: isMinorOrMajorNewer(currentVersion, latestVersion),
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
