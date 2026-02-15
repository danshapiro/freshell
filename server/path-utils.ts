import fs from 'fs'
import fsp from 'fs/promises'
import { execFile } from 'child_process'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { logger } from './logger.js'

const execFileAsync = promisify(execFile)

const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:([\\/]|$)/
const WINDOWS_UNC_PREFIX_RE = /^\\\\[^\\]+\\[^\\]+/
const WINDOWS_ROOTED_PREFIX_RE = /^\\(?!\\)/
const POSIX_ABSOLUTE_PREFIX_RE = /^\//
const WRAPPED_QUOTES_RE = /^(["'])(.*)\1$/
const WSL_PATH_TO_WINDOWS_CACHE_MAX_ENTRIES = 256

const wslPathToWindowsCache = new Map<string, Promise<string | undefined>>()

export type UserPathFlavor = 'windows' | 'posix' | 'native'

type PathModuleLike = Pick<typeof path.win32, 'basename' | 'dirname' | 'join' | 'normalize' | 'resolve'>

export function sanitizeUserPathInput(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) return ''
  const quoted = trimmed.match(WRAPPED_QUOTES_RE)
  if (!quoted) return trimmed
  return quoted[2].trim()
}

export function detectUserPathFlavor(input: string): UserPathFlavor {
  const cleaned = sanitizeUserPathInput(input)
  if (!cleaned) return 'native'
  if (
    WINDOWS_DRIVE_PREFIX_RE.test(cleaned) ||
    WINDOWS_UNC_PREFIX_RE.test(cleaned) ||
    WINDOWS_ROOTED_PREFIX_RE.test(cleaned)
  ) {
    return 'windows'
  }
  if (POSIX_ABSOLUTE_PREFIX_RE.test(cleaned)) {
    return 'posix'
  }
  return 'native'
}

export function getPathModuleForFlavor(flavor: UserPathFlavor): PathModuleLike {
  if (flavor === 'windows') return path.win32
  if (flavor === 'posix') return path.posix
  return path
}

export function normalizeUserPath(input: string): { normalizedPath: string; flavor: UserPathFlavor } {
  const cleaned = sanitizeUserPathInput(input)
  if (!cleaned) return { normalizedPath: '', flavor: 'native' }

  if (cleaned === '~') {
    return { normalizedPath: os.homedir(), flavor: 'native' }
  }
  if (cleaned.startsWith('~/') || cleaned.startsWith('~\\')) {
    return { normalizedPath: path.join(os.homedir(), cleaned.slice(2)), flavor: 'native' }
  }

  const flavor = detectUserPathFlavor(cleaned)
  if (flavor === 'windows') {
    return { normalizedPath: path.win32.resolve(cleaned), flavor }
  }
  if (flavor === 'posix') {
    return { normalizedPath: path.posix.resolve(cleaned), flavor }
  }
  return { normalizedPath: path.resolve(cleaned), flavor }
}

export function isWslEnvironment(): boolean {
  return process.platform === 'linux' && (
    !!process.env.WSL_DISTRO_NAME ||
    !!process.env.WSL_INTEROP ||
    !!process.env.WSLENV
  )
}

function getWslMountPrefix(): string {
  const sys32 = process.env.WSL_WINDOWS_SYS32
  if (sys32) {
    const normalized = sys32.replace(/\\/g, '/')
    const match = normalized.match(/^(.*?)\/[a-zA-Z]\//)
    if (match) return match[1]
  }
  return '/mnt'
}

function convertWslMountPathToWindows(posixPath: string): string | undefined {
  const match = posixPath.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/)
  if (!match) return undefined
  const drive = match[1].toUpperCase()
  const rest = match[2]
  if (!rest) return `${drive}:\\`
  return `${drive}:\\${rest.replace(/\//g, '\\')}`
}

export function convertWindowsPathToWslPath(input: string): string | undefined {
  const cleaned = sanitizeUserPathInput(input)
  if (!cleaned) return undefined
  const normalized = path.win32.resolve(cleaned)

  const driveMatch = normalized.match(/^([a-zA-Z]):(?:\\(.*))?$/)
  if (driveMatch) {
    const mountPrefix = getWslMountPrefix()
    const drive = driveMatch[1].toLowerCase()
    const rest = driveMatch[2]?.replace(/\\/g, '/')
    const root = mountPrefix ? `${mountPrefix}/${drive}` : `/${drive}`
    return rest ? `${root}/${rest}` : root
  }

  const wslUncMatch = normalized.match(/^\\\\wsl(?:\.localhost)?\\([^\\]+)(?:\\(.*))?$/i)
  if (wslUncMatch && isWslEnvironment()) {
    const requestedDistro = wslUncMatch[1]
    const currentDistro = process.env.WSL_DISTRO_NAME
    if (currentDistro && currentDistro.toLowerCase() !== requestedDistro.toLowerCase()) {
      return undefined
    }
    const rest = wslUncMatch[2]?.replace(/\\/g, '/')
    return rest ? `/${rest}` : '/'
  }

  return undefined
}

async function convertWslPathToWindows(posixPath: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  if (!posixPath.startsWith('/')) return undefined

  const mountMapped = convertWslMountPathToWindows(posixPath)
  if (mountMapped) return mountMapped

  const cached = wslPathToWindowsCache.get(posixPath)
  if (cached) return cached

  const pending = execFileAsync('wsl.exe', ['wslpath', '-w', posixPath], {
    windowsHide: true,
    timeout: 1500,
  })
    .then((result) => {
      const out = result.stdout.trim()
      return out ? path.win32.normalize(out) : undefined
    })
    .catch(() => undefined)

  wslPathToWindowsCache.set(posixPath, pending)
  if (wslPathToWindowsCache.size > WSL_PATH_TO_WINDOWS_CACHE_MAX_ENTRIES) {
    const oldestKey = wslPathToWindowsCache.keys().next().value
    if (oldestKey !== undefined) wslPathToWindowsCache.delete(oldestKey)
  }
  return pending
}

function resolveWindowsFlavorPath(resolvedPath: string): string {
  if (process.platform === 'win32') return path.win32.resolve(resolvedPath)
  if (isWslEnvironment()) {
    const converted = convertWindowsPathToWslPath(resolvedPath)
    if (converted) return converted
  }
  return path.win32.resolve(resolvedPath)
}

function resolvePosixFlavorPathSync(resolvedPath: string): string {
  if (process.platform === 'win32') {
    const converted = convertWslMountPathToWindows(resolvedPath)
    if (converted) return path.win32.resolve(converted)
    return path.win32.resolve(resolvedPath)
  }
  return path.posix.resolve(resolvedPath)
}

async function resolvePosixFlavorPathAsync(resolvedPath: string): Promise<string> {
  if (process.platform === 'win32') {
    const converted = await convertWslPathToWindows(resolvedPath)
    if (converted) return path.win32.resolve(converted)
    return path.win32.resolve(resolvedPath)
  }
  return path.posix.resolve(resolvedPath)
}

export function toFilesystemPathSync(resolvedPath: string, flavor: UserPathFlavor): string {
  if (flavor === 'windows') return resolveWindowsFlavorPath(resolvedPath)
  if (flavor === 'posix') return resolvePosixFlavorPathSync(resolvedPath)
  return path.resolve(resolvedPath)
}

export async function toFilesystemPath(resolvedPath: string, flavor: UserPathFlavor): Promise<string> {
  if (flavor === 'windows') return resolveWindowsFlavorPath(resolvedPath)
  if (flavor === 'posix') return resolvePosixFlavorPathAsync(resolvedPath)
  return path.resolve(resolvedPath)
}

export function resolveUserPath(input: string): string {
  return normalizeUserPath(input).normalizedPath
}

export function isReachableDirectorySync(input: string): { ok: boolean; resolvedPath: string } {
  const { normalizedPath, flavor } = normalizeUserPath(input)
  const fsPath = toFilesystemPathSync(normalizedPath, flavor)
  try {
    const stat = fs.statSync(fsPath)
    return { ok: stat.isDirectory(), resolvedPath: normalizedPath }
  } catch {
    return { ok: false, resolvedPath: normalizedPath }
  }
}

export async function isReachableDirectory(input: string): Promise<{ ok: boolean; resolvedPath: string }> {
  const { normalizedPath, flavor } = normalizeUserPath(input)
  const fsPath = await toFilesystemPath(normalizedPath, flavor)
  try {
    const stat = await fsp.stat(fsPath)
    return { ok: stat.isDirectory(), resolvedPath: normalizedPath }
  } catch {
    return { ok: false, resolvedPath: normalizedPath }
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

function trimTrailingSeparators(input: string): string {
  const normalized = path.normalize(input)
  const root = path.parse(normalized).root
  if (normalized === root) {
    return normalized
  }
  return normalized.replace(/[\\/]+$/u, '')
}

function resolvePathForSandboxComparison(input: string): string {
  const { normalizedPath, flavor } = normalizeUserPath(input)
  const fsPath = toFilesystemPathSync(normalizedPath, flavor)
  const resolved = path.resolve(fsPath)

  try {
    return trimTrailingSeparators(fs.realpathSync(resolved))
  } catch {
    return trimTrailingSeparators(resolved)
  }
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

  const normalizedTarget = resolvePathForSandboxComparison(targetPath)
  const compareTarget = process.platform === 'win32'
    ? normalizedTarget.toLowerCase()
    : normalizedTarget

  for (const root of allowedRoots) {
    const normalizedRoot = resolvePathForSandboxComparison(root)
    const compareRoot = process.platform === 'win32'
      ? normalizedRoot.toLowerCase()
      : normalizedRoot
    // Ensure prefix match is at a directory boundary
    if (
      compareTarget === compareRoot ||
      compareTarget.startsWith(compareRoot + path.sep)
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
