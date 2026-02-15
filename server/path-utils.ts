import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import { logger } from './logger.js'

export function resolveUserPath(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return trimmed
  if (trimmed === '~') {
    return os.homedir()
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2))
  }
  return path.resolve(trimmed)
}

export function isReachableDirectorySync(input: string): { ok: boolean; resolvedPath: string } {
  const resolvedPath = resolveUserPath(input)
  try {
    const stat = fs.statSync(resolvedPath)
    return { ok: stat.isDirectory(), resolvedPath }
  } catch {
    return { ok: false, resolvedPath }
  }
}

export async function isReachableDirectory(input: string): Promise<{ ok: boolean; resolvedPath: string }> {
  const resolvedPath = resolveUserPath(input)
  try {
    const stat = await fsp.stat(resolvedPath)
    return { ok: stat.isDirectory(), resolvedPath }
  } catch {
    return { ok: false, resolvedPath }
  }
}

/**
 * Normalize a path by resolving it to an absolute path and removing trailing slashes.
 * Handles `~` expansion via resolveUserPath.
 */
export function normalizePath(input: string): string {
  const resolved = resolveUserPath(input)
  return path.normalize(resolved)
}

/**
 * Check whether a target path falls within one of the allowed root directories.
 * Returns true if sandboxing is disabled (allowedRoots is undefined or empty).
 * When enabled, resolves symlinks via fs.realpathSync to prevent symlink escapes.
 */
export function isPathAllowed(targetPath: string, allowedRoots: string[] | undefined): boolean {
  if (!allowedRoots || allowedRoots.length === 0) {
    return true
  }

  const resolved = path.resolve(targetPath)

  // Try to resolve symlinks; fall back to resolved path if file doesn't exist yet
  let realTarget: string
  try {
    realTarget = fs.realpathSync(resolved)
  } catch {
    realTarget = resolved
  }

  const normalizedTarget = path.normalize(realTarget)

  for (const root of allowedRoots) {
    const normalizedRoot = path.normalize(path.resolve(root))
    // Ensure prefix match is at a directory boundary
    if (
      normalizedTarget === normalizedRoot ||
      normalizedTarget.startsWith(normalizedRoot + path.sep)
    ) {
      return true
    }
  }

  logger.warn(
    { targetPath: normalizedTarget, allowedRoots },
    'Path access denied by sandbox policy',
  )
  return false
}
