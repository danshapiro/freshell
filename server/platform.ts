import cp from 'child_process'
import fsPromises from 'fs/promises'
import os from 'os'

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
