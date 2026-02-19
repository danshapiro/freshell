import os from 'os'
import fs from 'fs'

export type ShellType = 'system' | 'cmd' | 'powershell' | 'wsl'

export function isWindows(): boolean {
  return process.platform === 'win32'
}

/**
 * Detect if running inside Windows Subsystem for Linux.
 * Uses environment variables set by WSL.
 */
export function isWsl(): boolean {
  return process.platform === 'linux' && (
    !!process.env.WSL_DISTRO_NAME ||
    !!process.env.WSL_INTEROP ||
    !!process.env.WSLENV
  )
}

/**
 * Returns true if Windows shells (cmd, powershell) are available.
 * This is true on native Windows and in WSL (via interop).
 */
export function isWindowsLike(): boolean {
  return isWindows() || isWsl()
}

/**
 * Get the executable path for cmd.exe or powershell.exe.
 * On native Windows, uses the simple name (relies on PATH).
 * On WSL, uses full paths since Windows executables may not be on PATH.
 */
export function getWindowsExe(exe: 'cmd' | 'powershell'): string {
  if (isWindows()) {
    return exe === 'cmd' ? 'cmd.exe' : (process.env.POWERSHELL_EXE || 'powershell.exe')
  }
  // On WSL, use explicit paths since Windows PATH may not be available
  const systemRoot = process.env.WSL_WINDOWS_SYS32 || '/mnt/c/Windows/System32'
  if (exe === 'cmd') {
    return `${systemRoot}/cmd.exe`
  }
  return process.env.POWERSHELL_EXE || `${systemRoot}/WindowsPowerShell/v1.0/powershell.exe`
}

/**
 * Get the WSL mount prefix for Windows drives.
 * Derives from WSL_WINDOWS_SYS32 (e.g., /mnt/c/Windows/System32 → /mnt)
 * or defaults to /mnt for standard WSL configurations.
 *
 * Handles various mount configurations:
 * - /mnt/c/... → /mnt (standard)
 * - /c/... → '' (drives at root)
 * - /win/c/... → /win (custom prefix)
 */
export function getWslMountPrefix(): string {
  const sys32 = process.env.WSL_WINDOWS_SYS32
  if (sys32) {
    // Extract mount prefix from path like /mnt/c/Windows/System32
    // The drive letter is a single char followed by /
    const match = sys32.match(/^(.*)\/[a-zA-Z]\//)
    if (match) {
      return match[1]
    }
  }
  return '/mnt'
}

/**
 * Get a sensible default working directory for Windows shells.
 * On native Windows: user's home directory (C:\Users\<username>)
 * In WSL: Windows user profile converted to WSL path, falling back to C:\
 *
 * This avoids UNC paths (\\wsl.localhost\...) which cmd.exe doesn't support.
 * Respects custom WSL mount configurations via WSL_WINDOWS_SYS32.
 */
export function getWindowsDefaultCwd(): string {
  if (isWindows()) {
    return os.homedir()
  }
  // In WSL, we need a Windows-accessible path
  const mountPrefix = getWslMountPrefix()

  // Try USERPROFILE if it's shared via WSLENV, convert to WSL mount path
  const userProfile = process.env.USERPROFILE
  if (userProfile) {
    // Convert Windows path (C:\Users\name) to WSL path (/mnt/c/Users/name)
    const match = userProfile.match(/^([A-Za-z]):\\(.*)$/)
    if (match) {
      const drive = match[1].toLowerCase()
      const rest = match[2].replace(/\\/g, '/')
      return `${mountPrefix}/${drive}/${rest}`
    }
  }
  // Fallback: use C:\ root
  return `${mountPrefix}/c`
}

/**
 * Resolve the effective shell based on platform and requested shell type.
 * - Windows/WSL: 'system' → platform default, others pass through
 * - macOS/Linux (non-WSL): always normalize to 'system' (use $SHELL or fallback)
 */
export function resolveShell(requested: ShellType): ShellType {
  if (isWindows()) {
    // On native Windows, 'system' maps to cmd (or ComSpec)
    return requested === 'system' ? 'cmd' : requested
  }
  if (isWsl()) {
    // On WSL, 'system' and 'wsl' both use the Linux shell
    // 'cmd' and 'powershell' use Windows executables via interop
    if (requested === 'system' || requested === 'wsl') {
      return 'system'
    }
    return requested // 'cmd' or 'powershell' pass through
  }
  // On macOS/Linux (non-WSL), always use 'system' shell
  // Windows-specific options are normalized to system
  return 'system'
}

/**
 * Get the system shell for macOS/Linux.
 * Priority: $SHELL (if exists) → platform fallback (if exists) → /bin/sh
 */
export function getSystemShell(): string {
  const shell = process.env.SHELL
  // Check if SHELL is set, non-empty, non-whitespace, and exists
  if (shell && shell.trim() && fs.existsSync(shell)) {
    return shell
  }

  if (process.platform === 'darwin') {
    // macOS: prefer zsh (default since Catalina), then bash, then sh
    if (fs.existsSync('/bin/zsh')) return '/bin/zsh'
    if (fs.existsSync('/bin/bash')) return '/bin/bash'
  } else {
    // Linux: prefer bash, then sh
    if (fs.existsSync('/bin/bash')) return '/bin/bash'
  }

  // Ultimate fallback - /bin/sh should always exist on Unix systems
  return '/bin/sh'
}

export function isLinuxPath(p: unknown): boolean {
  // Detect Linux/WSL paths that won't work on native Windows
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//')
}
