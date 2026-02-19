import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type FirewallPlatform =
  | 'linux-ufw'
  | 'linux-firewalld'
  | 'linux-none'
  | 'macos'
  | 'windows'
  | 'wsl2'

export interface FirewallInfo {
  platform: FirewallPlatform
  active: boolean
}

/** @internal Exposed for dependency injection in tests. */
export interface FirewallDeps {
  isWSL2: () => boolean
  tryExec: (cmd: string, args: string[]) => Promise<string | null>
}

function isWSL2(): boolean {
  // readFileSync is acceptable here — /proc/version is a virtual filesystem
  // that returns instantly (no disk I/O). This runs once and the result is
  // cached by NetworkManager.
  try {
    const version = readFileSync('/proc/version', 'utf-8').toLowerCase()
    // WSL2 has "microsoft-standard" or "wsl2" in the version string.
    // WSL1 has "Microsoft" but not these patterns.
    // This matches the detection logic in server/wsl-port-forward.ts:179-184.
    return version.includes('wsl2') || version.includes('microsoft-standard')
  } catch {
    return false
  }
}

/** Run a command asynchronously and return stdout, or null on failure. */
async function tryExec(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 })
    return stdout
  } catch {
    return null
  }
}

const defaultDeps: FirewallDeps = { isWSL2, tryExec }

async function detectLinuxFirewall(exec: FirewallDeps['tryExec']): Promise<FirewallInfo> {
  // Try ufw first (Ubuntu, Debian, Mint, Pop!_OS)
  const ufwOutput = await exec('ufw', ['status'])
  if (ufwOutput !== null) {
    const ufwActive = ufwOutput.includes('Status: active')
    // Only return ufw result if it's actually active. If ufw is installed
    // but inactive, fall through to check firewalld — some systems have
    // both installed but use firewalld as the active firewall.
    if (ufwActive) {
      return { platform: 'linux-ufw', active: true }
    }
  }

  // Try firewalld (Fedora, RHEL, CentOS)
  const firewalldOutput = await exec('firewall-cmd', ['--state'])
  if (firewalldOutput !== null) {
    const firewalldActive = firewalldOutput.trim() === 'running'
    if (firewalldActive) {
      return { platform: 'linux-firewalld', active: true }
    }
  }

  // If ufw exists but is inactive, report it (user may want to enable it)
  if (ufwOutput !== null) {
    return { platform: 'linux-ufw', active: false }
  }

  return { platform: 'linux-none', active: false }
}

async function detectMacFirewall(exec: FirewallDeps['tryExec']): Promise<FirewallInfo> {
  const output = await exec('defaults', [
    'read', '/Library/Preferences/com.apple.alf', 'globalstate',
  ])
  if (output !== null) {
    return {
      platform: 'macos',
      active: parseInt(output.trim(), 10) > 0,
    }
  }
  return { platform: 'macos', active: false }
}

async function detectWindowsFirewall(
  checkWSL2: FirewallDeps['isWSL2'],
  exec: FirewallDeps['tryExec'],
): Promise<FirewallInfo> {
  // Use full Windows path on WSL2 — bare 'netsh' is not reliably on PATH
  // in WSL2. This matches the existing NETSH_PATH in wsl-port-forward.ts:5.
  // On native Windows, 'netsh' works because it's in the system PATH.
  const netshCmd = checkWSL2()
    ? '/mnt/c/Windows/System32/netsh.exe'
    : 'netsh'
  const output = await exec(netshCmd, [
    'advfirewall', 'show', 'currentprofile', 'state',
  ])
  const firewallPlatform: FirewallPlatform = checkWSL2() ? 'wsl2' : 'windows'
  if (output !== null) {
    // netsh state values are always ON/OFF regardless of Windows locale
    // (the label "State" is localized but the value keyword is not).
    // Use case-insensitive word-boundary match for robustness.
    return {
      platform: firewallPlatform,
      active: /\bON\b/i.test(output),
    }
  }
  return { platform: firewallPlatform, active: false }
}

export async function detectFirewall(deps: FirewallDeps = defaultDeps): Promise<FirewallInfo> {
  const { isWSL2: checkWSL2, tryExec: exec } = deps
  const platform = process.platform

  if (platform === 'linux') {
    if (checkWSL2()) {
      return detectWindowsFirewall(checkWSL2, exec)
    }
    return detectLinuxFirewall(exec)
  }

  if (platform === 'darwin') {
    return detectMacFirewall(exec)
  }

  if (platform === 'win32') {
    return detectWindowsFirewall(checkWSL2, exec)
  }

  return { platform: 'linux-none', active: false }
}

export function firewallCommands(platform: FirewallPlatform, ports: number[]): string[] {
  switch (platform) {
    case 'linux-ufw':
      return ports.map((p) => `sudo ufw allow ${p}/tcp`)

    case 'linux-firewalld': {
      const portArgs = ports.map((p) => `--add-port=${p}/tcp`).join(' ')
      return [`sudo firewall-cmd ${portArgs} --permanent && sudo firewall-cmd --reload`]
    }

    case 'macos':
      // macOS Application Firewall (ALF) operates at the application level,
      // not the port level. There is no way to allow only specific ports —
      // --unblockapp allows ALL inbound connections to the Node binary.
      return [
        `sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add $(which node) && sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp $(which node)`,
      ]

    case 'windows':
      // Native Windows: netsh requires admin elevation. Return the commands
      // as data — the configure-firewall endpoint will spawn an elevated
      // PowerShell to execute them (same approach as WSL2).
      // SECURITY: profile=private restricts to private networks only.
      return ports.map(
        (p) => `netsh advfirewall firewall add rule name="Freshell (port ${p})" dir=in action=allow protocol=TCP localport=${p} profile=private`,
      )

    case 'wsl2':
      // WSL2 firewall + port proxy is handled by wsl-port-forward.ts via the
      // configure-firewall endpoint, which spawns elevated PowerShell async.
      return []

    case 'linux-none':
      return []
  }
}
