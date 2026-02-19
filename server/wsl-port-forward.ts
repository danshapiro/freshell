import { execSync } from 'child_process'
import { isWSL2 } from './platform.js'

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const NETSH_PATH = '/mnt/c/Windows/System32/netsh.exe'
const POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
const DEFAULT_PORT = 3001

export type PortProxyRule = {
  connectAddress: string
  connectPort: number
}

/**
 * Parse netsh interface portproxy show v4tov4 output.
 * Returns a Map of listenPort -> { connectAddress, connectPort } for rules listening on 0.0.0.0.
 */
export function parsePortProxyRules(output: string): Map<number, PortProxyRule> {
  const rules = new Map<number, PortProxyRule>()

  for (const line of output.split('\n')) {
    // Match lines like: 0.0.0.0         3001        172.30.149.249  3001
    const match = line.match(/^([\d.]+)\s+(\d+)\s+([\d.]+)\s+(\d+)/)
    if (match) {
      const [, listenAddr, listenPort, connectAddr, connectPort] = match
      if (listenAddr === '0.0.0.0') {
        rules.set(parseInt(listenPort, 10), {
          connectAddress: connectAddr,
          connectPort: parseInt(connectPort, 10),
        })
      }
    }
  }

  return rules
}

/**
 * Get the current WSL2 IPv4 address.
 *
 * Strategy:
 * 1. Try to get IP from eth0 (WSL2's primary interface)
 * 2. Fall back to hostname -I (first non-Docker IPv4)
 *
 * This avoids selecting Docker bridge or VPN interfaces.
 */
export function getWslIp(): string | null {
  // Try eth0 first - this is WSL2's primary interface
  try {
    const eth0Output = execSync('ip -4 addr show eth0 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5000,
    })
    const eth0Match = eth0Output.match(/inet\s+([\d.]+)/)
    if (eth0Match && IPV4_REGEX.test(eth0Match[1])) {
      return eth0Match[1]
    }
  } catch {
    // eth0 not available, fall through to hostname -I
  }

  // Fallback: use hostname -I, skipping Docker bridge (172.17.x.x)
  try {
    const output = execSync('hostname -I', { encoding: 'utf-8', timeout: 5000 })
    const addresses = output.trim().split(/\s+/).filter(Boolean)

    // Find first IPv4 address (skip IPv6 and Docker bridge 172.17.x.x)
    for (const addr of addresses) {
      if (IPV4_REGEX.test(addr) && !addr.startsWith('172.17.')) {
        return addr
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Query existing Windows port proxy rules.
 * Returns a Map of listenPort -> { connectAddress, connectPort }.
 */
export function getExistingPortProxyRules(): Map<number, PortProxyRule> {
  try {
    const output = execSync(
      `${NETSH_PATH} interface portproxy show v4tov4`,
      { encoding: 'utf-8', timeout: 10000 }
    )
    return parsePortProxyRules(output)
  } catch {
    return new Map()
  }
}

/**
 * Get the list of ports that need forwarding.
 * Uses PORT from environment (or default 3001).
 * Includes dev port 5173 unless NODE_ENV is 'production'.
 * Validates port and deduplicates to avoid invalid/duplicate netsh commands.
 */
export function getRequiredPorts(devPort?: number): number[] {
  const portEnv = process.env.PORT
  const serverPort = portEnv ? parseInt(portEnv, 10) : DEFAULT_PORT

  // Validate parsed port (NaN check, valid range)
  const validServerPort = Number.isNaN(serverPort) || serverPort < 1 || serverPort > 65535
    ? DEFAULT_PORT
    : serverPort

  const ports = new Set<number>([validServerPort])

  // Include dev server port unless in production.
  // Validate range — invalid devPort could generate invalid netsh commands.
  if (process.env.NODE_ENV !== 'production' && devPort) {
    if (Number.isInteger(devPort) && devPort >= 1 && devPort <= 65535) {
      ports.add(devPort)
    }
  }

  return Array.from(ports)
}

/**
 * Parse netsh advfirewall firewall show rule output to extract allowed ports.
 * Returns a Set of port numbers from the LocalPort field.
 */
export function parseFirewallRulePorts(output: string): Set<number> {
  const ports = new Set<number>()
  for (const line of output.split('\n')) {
    const match = line.match(/LocalPort:\s*(.+)/i)
    if (match) {
      for (const p of match[1].trim().split(',')) {
        const num = parseInt(p.trim(), 10)
        if (!Number.isNaN(num)) {
          ports.add(num)
        }
      }
    }
  }
  return ports
}

/**
 * Query the existing FreshellLANAccess Windows Firewall rule.
 * Returns a Set of port numbers allowed by the rule, or empty set if the rule doesn't exist.
 */
export function getExistingFirewallPorts(): Set<number> {
  try {
    const output = execSync(
      `${NETSH_PATH} advfirewall firewall show rule name=FreshellLANAccess`,
      { encoding: 'utf-8', timeout: 10000 }
    )
    return parseFirewallRulePorts(output)
  } catch {
    return new Set()
  }
}

/**
 * Check if the firewall rule needs to be updated.
 * Returns true if any required port is missing from the existing firewall rule.
 * Extra ports in the existing rule are tolerated (avoids unnecessary UAC prompts
 * when switching between dev and production modes).
 */
export function needsFirewallUpdate(requiredPorts: number[], existingPorts: Set<number>): boolean {
  for (const port of requiredPorts) {
    if (!existingPorts.has(port)) return true
  }
  return false
}

/**
 * Build PowerShell script to update only the firewall rule (no port forwarding).
 * Used when port proxy rules are correct but the firewall rule has drifted.
 */
export function buildFirewallOnlyScript(ports: number[]): string {
  const commands: string[] = []
  commands.push(`netsh advfirewall firewall delete rule name=FreshellLANAccess 2>\\$null`)
  commands.push(
    `netsh advfirewall firewall add rule name=FreshellLANAccess dir=in action=allow protocol=tcp localport=${ports.join(',')} profile=private`
  )
  return commands.join('; ')
}

/**
 * Check if port forwarding rules need to be updated.
 * Returns true if any required port is missing, points to wrong IP, or wrong connect port.
 */
export function needsPortForwardingUpdate(
  wslIp: string,
  requiredPorts: number[],
  existingRules: Map<number, PortProxyRule>
): boolean {
  for (const port of requiredPorts) {
    const rule = existingRules.get(port)
    if (!rule) {
      return true
    }
    if (rule.connectAddress !== wslIp || rule.connectPort !== port) {
      return true
    }
  }
  return false
}

/**
 * Build PowerShell script to configure port forwarding and firewall.
 * Uses \$null escaping to prevent shell variable expansion.
 * Firewall rule restricted to private profile for security.
 */
export function buildPortForwardingScript(wslIp: string, ports: number[]): string {
  const commands: string[] = []

  // Delete existing rules for 0.0.0.0 (the address we use for listening)
  // Use \$null to prevent sh from expanding $null
  for (const port of ports) {
    commands.push(
      `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${port} 2>\\$null`
    )
  }

  // Add new rules
  for (const port of ports) {
    commands.push(
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${port} connectaddress=${wslIp} connectport=${port}`
    )
  }

  // Firewall rule (delete then add for idempotency)
  // SECURITY: profile=private restricts to private networks only (not public Wi-Fi)
  // Note: Using name without spaces to avoid quote escaping issues in nested PowerShell
  commands.push(`netsh advfirewall firewall delete rule name=FreshellLANAccess 2>\\$null`)
  commands.push(
    `netsh advfirewall firewall add rule name=FreshellLANAccess dir=in action=allow protocol=tcp localport=${ports.join(',')} profile=private`
  )

  return commands.join('; ')
}

export type SetupResult = 'success' | 'skipped' | 'failed' | 'not-wsl2'

/**
 * Set up Windows port forwarding for WSL2 LAN access.
 *
 * - Detects if running in WSL2
 * - Gets required ports from environment
 * - Checks existing port proxy rules
 * - Launches elevated PowerShell to add/update rules if needed
 * - Verifies rules were actually applied
 *
 * Returns:
 * - 'not-wsl2': Not running in WSL2, no action needed
 * - 'skipped': Rules already configured correctly
 * - 'success': Rules were added/updated and verified
 * - 'failed': Failed to configure (UAC dismissed, error, or verification failed)
 */
export function setupWslPortForwarding(devPort?: number): SetupResult {
  if (!isWSL2()) {
    return 'not-wsl2'
  }

  const wslIp = getWslIp()
  if (!wslIp) {
    console.error('[wsl-port-forward] Failed to detect WSL2 IP address')
    return 'failed'
  }

  const requiredPorts = getRequiredPorts(devPort)
  const existingRules = getExistingPortProxyRules()
  const existingFirewallPorts = getExistingFirewallPorts()

  const portsNeedUpdate = needsPortForwardingUpdate(wslIp, requiredPorts, existingRules)
  const firewallNeedsUpdate = needsFirewallUpdate(requiredPorts, existingFirewallPorts)

  if (!portsNeedUpdate && !firewallNeedsUpdate) {
    console.log(`[wsl-port-forward] Rules up to date for ${wslIp}`)
    return 'skipped'
  }

  // Choose the appropriate script: full (port forwarding + firewall) or firewall-only.
  // When only the firewall drifted, skip port forwarding commands to avoid
  // brief connection interruptions from deleting/re-adding proxy rules.
  const script = portsNeedUpdate
    ? buildPortForwardingScript(wslIp, requiredPorts)
    : buildFirewallOnlyScript(requiredPorts)

  const label = portsNeedUpdate ? 'port forwarding + firewall' : 'firewall'
  console.log(`[wsl-port-forward] Configuring ${label} for ${wslIp}...`)
  console.log('[wsl-port-forward] UAC prompt required - please approve to enable LAN access')

  try {
    // Escape single quotes for PowerShell ArgumentList
    const escapedScript = script.replace(/'/g, "''")

    execSync(
      `${POWERSHELL_PATH} -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command', '${escapedScript}'"`,
      { encoding: 'utf-8', timeout: 60000, stdio: 'inherit' }
    )

    // Verify port forwarding rules if they were updated
    if (portsNeedUpdate) {
      const verifyRules = getExistingPortProxyRules()
      if (needsPortForwardingUpdate(wslIp, requiredPorts, verifyRules)) {
        console.error('[wsl-port-forward] Port forwarding rules were not applied - UAC may have been cancelled')
        return 'failed'
      }
    }

    // Always verify firewall (updated in both full and firewall-only scripts)
    const verifyFirewall = getExistingFirewallPorts()
    if (needsFirewallUpdate(requiredPorts, verifyFirewall)) {
      console.error('[wsl-port-forward] Firewall rule was not applied - UAC may have been cancelled')
      return 'failed'
    }

    console.log(`[wsl-port-forward] ${portsNeedUpdate ? 'Port forwarding' : 'Firewall'} configured successfully`)
    return 'success'
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[wsl-port-forward] Failed to configure: ${message}`)
    return 'failed'
  }
}
