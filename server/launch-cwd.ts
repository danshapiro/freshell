import path from 'node:path'
import {
  convertWindowsPathToWslPath,
  convertWslDrivePathToWindowsPath as convertWslDrivePathToWindowsPathFromUtils,
  isWslEnvironment,
  sanitizeUserPathInput,
} from './path-utils.js'

const WINDOWS_DRIVE_PREFIX_RE = /^[A-Za-z]:[\\/]/
const WINDOWS_DRIVE_RELATIVE_RE = /^[A-Za-z]:(?![\\/])/
const WINDOWS_UNC_PREFIX_RE = /^\\\\[^\\]+\\[^\\]+/
const WINDOWS_ROOTED_PREFIX_RE = /^\\(?!\\)/
const SLASH_FORM_WSL_UNC_PREFIX_RE = /^\/\/(?:wsl(?:\.localhost)?|wsl\$)\/[^/]+(?:\/|$)/i
const SLASH_FORM_UNC_PREFIX_RE = /^\/\/[^/]+\/[^/]+/
const POSIX_ABSOLUTE_PREFIX_RE = /^\//

export { convertWslDrivePathToWindowsPath } from './path-utils.js'

export type LaunchCwdTargetRuntime = 'linux-process' | 'windows-process'

export type LaunchCwdConversion =
  | 'none'
  | 'windows-drive-to-wsl-mount'
  | 'wsl-mount-to-windows-drive'

export type ResolvedLaunchCwd = {
  targetRuntime: LaunchCwdTargetRuntime
  inputCwd?: string
  displayCwd?: string
  launchCwd?: string
  conversion: LaunchCwdConversion
}

export function isWslRuntime(): boolean {
  return isWslEnvironment()
}

function isLinuxPath(input: string): boolean {
  return POSIX_ABSOLUTE_PREFIX_RE.test(input) && !input.startsWith('//')
}

function isWindowsDriveRelativePath(input: string): boolean {
  return WINDOWS_DRIVE_RELATIVE_RE.test(input)
}

function isWindowsAbsolutePath(input: string): boolean {
  return WINDOWS_DRIVE_PREFIX_RE.test(input)
    || WINDOWS_UNC_PREFIX_RE.test(input)
    || WINDOWS_ROOTED_PREFIX_RE.test(input)
}

function resolveLinuxProcessCwd(candidate: string): Pick<ResolvedLaunchCwd, 'launchCwd' | 'conversion'> {
  if (isWindowsDriveRelativePath(candidate)) {
    return { launchCwd: undefined, conversion: 'none' }
  }

  if (SLASH_FORM_WSL_UNC_PREFIX_RE.test(candidate)) {
    return { launchCwd: undefined, conversion: 'none' }
  }

  if (candidate.startsWith('//')) {
    return { launchCwd: candidate, conversion: 'none' }
  }

  if (isLinuxPath(candidate)) {
    return { launchCwd: candidate, conversion: 'none' }
  }

  if (WINDOWS_UNC_PREFIX_RE.test(candidate)) {
    return { launchCwd: undefined, conversion: 'none' }
  }

  if (WINDOWS_ROOTED_PREFIX_RE.test(candidate)) {
    return { launchCwd: undefined, conversion: 'none' }
  }

  if (isWindowsAbsolutePath(candidate) && isWslRuntime()) {
    const converted = convertWindowsPathToWslPath(candidate)
    if (converted) {
      return { launchCwd: converted, conversion: 'windows-drive-to-wsl-mount' }
    }
  }

  if (isWindowsAbsolutePath(candidate)) {
    return { launchCwd: undefined, conversion: 'none' }
  }

  return { launchCwd: undefined, conversion: 'none' }
}

function resolveWindowsProcessCwd(candidate: string): Pick<ResolvedLaunchCwd, 'launchCwd' | 'conversion'> {
  if (isWindowsDriveRelativePath(candidate)) {
    return { launchCwd: undefined, conversion: 'none' }
  }

  if (isLinuxPath(candidate)) {
    if (!isWslRuntime()) {
      return { launchCwd: undefined, conversion: 'none' }
    }

    const converted = convertWslDrivePathToWindowsPathFromUtils(candidate)
    if (converted) {
      return { launchCwd: converted, conversion: 'wsl-mount-to-windows-drive' }
    }
    return { launchCwd: undefined, conversion: 'none' }
  }

  if (WINDOWS_UNC_PREFIX_RE.test(candidate)) {
    return { launchCwd: undefined, conversion: 'none' }
  }

  if (SLASH_FORM_UNC_PREFIX_RE.test(candidate)) {
    return { launchCwd: undefined, conversion: 'none' }
  }

  if (WINDOWS_ROOTED_PREFIX_RE.test(candidate)) {
    return { launchCwd: undefined, conversion: 'none' }
  }

  if (WINDOWS_DRIVE_PREFIX_RE.test(candidate)) {
    return { launchCwd: path.win32.resolve(candidate), conversion: 'none' }
  }

  return { launchCwd: undefined, conversion: 'none' }
}

export function resolveLaunchCwd(
  rawCwd: string | undefined,
  options: { targetRuntime: LaunchCwdTargetRuntime },
): ResolvedLaunchCwd {
  const cleaned = typeof rawCwd === 'string' ? sanitizeUserPathInput(rawCwd) : ''
  if (!cleaned) {
    return {
      targetRuntime: options.targetRuntime,
      launchCwd: undefined,
      conversion: 'none',
    }
  }

  const resolved = options.targetRuntime === 'linux-process'
    ? resolveLinuxProcessCwd(cleaned)
    : resolveWindowsProcessCwd(cleaned)

  return {
    targetRuntime: options.targetRuntime,
    inputCwd: rawCwd,
    displayCwd: cleaned,
    launchCwd: resolved.launchCwd,
    conversion: resolved.conversion,
  }
}
