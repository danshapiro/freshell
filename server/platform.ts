import cp from 'child_process'
import { readFileSync } from 'fs'
import fsPromises from 'fs/promises'
import os from 'os'

/**
 * Check if running inside WSL2 (Windows Subsystem for Linux 2).
 * Uses synchronous /proc/version check for WSL2-specific markers.
 * WSL2 has "microsoft-standard" or "wsl2" in the version string.
 * WSL1 has "Microsoft" but not these patterns.
 */
export function isWSL2(): boolean {
  try {
    const version = readFileSync('/proc/version', 'utf-8').toLowerCase()
    return version.includes('wsl2') || version.includes('microsoft-standard')
  } catch {
    return false
  }
}

/**
 * Check if running inside any version of WSL (WSL1 or WSL2).
 * Uses synchronous /proc/version check for broad "microsoft" marker.
 */
export function isWSL(): boolean {
  try {
    const version = readFileSync('/proc/version', 'utf-8').toLowerCase()
    return version.includes('microsoft')
  } catch {
    return false
  }
}

/**
 * Detect the platform, including WSL detection.
 * Returns 'wsl' if running inside Windows Subsystem for Linux,
 * otherwise returns process.platform (e.g., 'win32', 'darwin', 'linux').
 */
export async function detectPlatform(): Promise<string> {
  if (process.platform !== 'linux') {
    return process.platform
  }

  // Check for WSL by reading /proc/version
  try {
    const procVersion = await fsPromises.readFile('/proc/version', 'utf-8')
    if (procVersion.toLowerCase().includes('microsoft') || procVersion.toLowerCase().includes('wsl')) {
      return 'wsl'
    }
  } catch {
    // /proc/version not readable, not WSL
  }

  return process.platform
}

async function detectWslWindowsHostName(): Promise<string | null> {
  return new Promise((resolve) => {
    cp.execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', '$env:COMPUTERNAME'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        const value = stdout.trim()
        resolve(value || null)
      },
    )
  })
}

export async function detectHostName(): Promise<string> {
  const platform = await detectPlatform()
  if (platform === 'wsl') {
    const windowsHostName = await detectWslWindowsHostName()
    if (windowsHostName) return windowsHostName
  }
  return os.hostname()
}

async function isCommandAvailable(command: string): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which'
  return new Promise((resolve) => {
    cp.execFile(finder, [command], { timeout: 3000 }, (err) => {
      resolve(!err)
    })
  })
}

export type AvailableClis = Record<string, boolean>

const CLI_COMMANDS = [
  { name: 'claude', envVar: 'CLAUDE_CMD', defaultCmd: 'claude' },
  { name: 'codex', envVar: 'CODEX_CMD', defaultCmd: 'codex' },
  { name: 'opencode', envVar: 'OPENCODE_CMD', defaultCmd: 'opencode' },
  { name: 'gemini', envVar: 'GEMINI_CMD', defaultCmd: 'gemini' },
  { name: 'kimi', envVar: 'KIMI_CMD', defaultCmd: 'kimi' },
] as const

export async function detectAvailableClis(): Promise<AvailableClis> {
  const results = await Promise.all(
    CLI_COMMANDS.map(async (cli) => {
      const cmd = process.env[cli.envVar] || cli.defaultCmd
      const available = await isCommandAvailable(cmd)
      return [cli.name, available] as const
    })
  )
  return Object.fromEntries(results)
}
