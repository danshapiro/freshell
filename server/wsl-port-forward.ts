import { execFile, execSync } from 'child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { isWSL2 } from './platform.js'

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/
const NETSH_PATH = '/mnt/c/Windows/System32/netsh.exe'
const DEFAULT_PORT = 3001
const MANAGED_WSL_PORTS_FILE = 'wsl-managed-remote-access-ports.json'

type ExecFileSettledResult = {
  error: Error | null
  stdout: string
  stderr: string
}

function execFileSettledAsync(
  command: string,
  args: string[],
  options: { encoding: 'utf-8'; timeout: number },
): Promise<ExecFileSettledResult> {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        error: error ?? null,
        stdout: toErrorText(stdout),
        stderr: toErrorText(stderr),
      })
    })
  })
}

function execFileAsync(command: string, args: string[], options: { encoding: 'utf-8'; timeout: number }) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    void execFileSettledAsync(command, args, options).then(({ error, stdout, stderr }) => {
      if (error) {
        reject(error)
        return
      }

      resolve({ stdout, stderr })
    })
  })
}

function toErrorText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf-8')
  }

  return ''
}

function getManagedWslPortsPath(): string {
  return path.join(os.homedir(), '.freshell', MANAGED_WSL_PORTS_FILE)
}

function normalizeManagedPorts(ports: number[]): number[] {
  return Array.from(new Set(
    ports.filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535),
  )).sort((a, b) => a - b)
}

function parseManagedWslPorts(raw: string): Set<number> {
  try {
    const parsed = JSON.parse(raw) as { ports?: unknown }
    if (!Array.isArray(parsed.ports)) {
      return new Set()
    }

    return new Set(normalizeManagedPorts(parsed.ports.filter((port): port is number => typeof port === 'number')))
  } catch {
    return new Set()
  }
}

function readManagedWslRemoteAccessPorts(): Set<number> {
  try {
    return parseManagedWslPorts(fs.readFileSync(getManagedWslPortsPath(), 'utf-8'))
  } catch {
    return new Set()
  }
}

async function readManagedWslRemoteAccessPortsAsync(): Promise<Set<number>> {
  try {
    return parseManagedWslPorts(await fsp.readFile(getManagedWslPortsPath(), 'utf-8'))
  } catch {
    return new Set()
  }
}

function getExecExitCode(error: Error | null): number | null {
  if (!error || typeof error !== 'object') {
    return null
  }

  const code = (error as { code?: unknown }).code
  if (typeof code === 'number') {
    return code
  }
  if (typeof code === 'string' && /^\d+$/.test(code)) {
    return Number.parseInt(code, 10)
  }

  return null
}

function isMissingFirewallRuleResult(error: Error | null, stdout: string, stderr: string): boolean {
  return getExecExitCode(error) === 1
    && toErrorText(stderr).trim().length === 0
    && parseFirewallRulePorts(stdout).size === 0
}

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

async function getWslIpAsync(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('ip', ['-4', 'addr', 'show', 'eth0'], {
      encoding: 'utf-8',
      timeout: 5000,
    })
    const eth0Match = stdout.match(/inet\s+([\d.]+)/)
    if (eth0Match && IPV4_REGEX.test(eth0Match[1])) {
      return eth0Match[1]
    }
  } catch {
    // eth0 not available, fall through to hostname -I
  }

  try {
    const { stdout } = await execFileAsync('hostname', ['-I'], {
      encoding: 'utf-8',
      timeout: 5000,
    })
    const addresses = stdout.trim().split(/\s+/).filter(Boolean)

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

export function getRequiredPorts(devPort?: number): number[] {
  const portEnv = process.env.PORT
  const parsedPort = portEnv ? Number.parseInt(portEnv, 10) : DEFAULT_PORT
  const serverPort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535
    ? parsedPort
    : DEFAULT_PORT
  const ports = new Set<number>([serverPort])

  if (
    process.env.NODE_ENV !== 'production'
    && Number.isInteger(devPort)
    && devPort !== undefined
    && devPort >= 1
    && devPort <= 65535
  ) {
    ports.add(devPort)
  }

  return Array.from(ports)
}

export async function persistManagedWslRemoteAccessPorts(ports: number[]): Promise<void> {
  const normalizedPorts = normalizeManagedPorts(ports)
  const managedPortsPath = getManagedWslPortsPath()

  if (normalizedPorts.length === 0) {
    await clearManagedWslRemoteAccessPorts()
    return
  }

  await fsp.mkdir(path.dirname(managedPortsPath), { recursive: true })
  await fsp.writeFile(
    managedPortsPath,
    JSON.stringify({ ports: normalizedPorts }, null, 2),
    'utf-8',
  )
}

export async function clearManagedWslRemoteAccessPorts(): Promise<void> {
  try {
    await fsp.unlink(getManagedWslPortsPath())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }
}

async function getExistingPortProxyRulesAsync(): Promise<Map<number, PortProxyRule> | null> {
  try {
    const { stdout } = await execFileAsync(
      NETSH_PATH,
      ['interface', 'portproxy', 'show', 'v4tov4'],
      { encoding: 'utf-8', timeout: 10000 }
    )
    return parsePortProxyRules(stdout)
  } catch {
    return null
  }
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

async function getExistingFirewallPortsAsync(): Promise<Set<number> | null> {
  const { error, stdout, stderr } = await execFileSettledAsync(
    NETSH_PATH,
    ['advfirewall', 'firewall', 'show', 'rule', 'name=FreshellLANAccess'],
    { encoding: 'utf-8', timeout: 10000 },
  )

  if (error) {
    if (isMissingFirewallRuleResult(error, stdout, stderr)) {
      return new Set()
    }

    return null
  }

  return parseFirewallRulePorts(stdout)
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
export function buildPortForwardingScript(wslIp: string, ports: number[], cleanupPorts: number[] = ports): string {
  const commands: string[] = []

  // Delete existing rules for 0.0.0.0 (the address we use for listening)
  // Use \$null to prevent sh from expanding $null
  for (const port of new Set(cleanupPorts)) {
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

/**
 * Build PowerShell script to remove Freshell's Windows portproxy and firewall exposure.
 * This keeps the server reachable from the Windows host while removing LAN access.
 */
export function buildPortForwardingTeardownScript(ports: number[]): string {
  const commands: string[] = []

  for (const port of new Set(ports)) {
    commands.push(
      `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${port} 2>\\$null`
    )
  }

  commands.push(`netsh advfirewall firewall delete rule name=FreshellLANAccess 2>\\$null`)

  return commands.join('; ')
}

function isWslPortForwardingDisabledByEnv(): boolean {
  const value = process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD
  if (!value) return false
  return ['1', 'true', 'yes'].includes(value.toLowerCase())
}

export type WslPortForwardingPlan =
  | { status: 'not-wsl2' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'noop'; wslIp: string }
  | {
    status: 'ready'
    wslIp: string
    scriptKind: 'full' | 'firewall-only'
    script: string
  }

export type WslPortForwardingTeardownPlan =
  | { status: 'not-wsl2' }
  | { status: 'disabled' }
  | { status: 'error'; message: string }
  | { status: 'noop' }
  | { status: 'ready'; script: string }

function normalizeScriptForElevatedPowerShell(script: string): string {
  return script.replace(/\\\$/g, '$')
}

function getLegacyOwnedPortProxyPorts(
  requiredPorts: number[],
  knownOwnedPorts: number[],
  existingRules: Map<number, PortProxyRule>,
): number[] {
  const requiredPortSet = new Set(requiredPorts)
  return normalizeManagedPorts(knownOwnedPorts)
    .filter((port) => !requiredPortSet.has(port) && existingRules.has(port))
}

function buildWslPortForwardingPlan(
  requiredPorts: number[],
  knownOwnedPorts: number[],
  wslIp: string,
  existingRules: Map<number, PortProxyRule>,
  existingFirewallPorts: Set<number>,
  managedPorts: Set<number>,
): WslPortForwardingPlan {
  const requiredPortSet = new Set(requiredPorts)
  const staleOwnedPorts = Array.from(new Set([...existingFirewallPorts, ...managedPorts]))
    .filter((port) => !requiredPortSet.has(port))
  const staleOwnedPortProxyPorts = Array.from(new Set([
    ...staleOwnedPorts.filter((port) => existingRules.has(port)),
    ...getLegacyOwnedPortProxyPorts(requiredPorts, knownOwnedPorts, existingRules),
  ]))
  const portsNeedUpdate = needsPortForwardingUpdate(wslIp, requiredPorts, existingRules)
    || staleOwnedPortProxyPorts.length > 0
  const firewallNeedsUpdate = needsFirewallUpdate(requiredPorts, existingFirewallPorts)
    || staleOwnedPorts.length > 0

  if (!portsNeedUpdate && !firewallNeedsUpdate) {
    return {
      status: 'noop',
      wslIp,
    }
  }

  const scriptKind = portsNeedUpdate ? 'full' : 'firewall-only'
  const cleanupPorts = Array.from(new Set([
    ...requiredPorts,
    ...managedPorts,
    ...existingFirewallPorts,
    ...staleOwnedPortProxyPorts,
  ]))
  const script = scriptKind === 'full'
    ? buildPortForwardingScript(wslIp, requiredPorts, cleanupPorts)
    : buildFirewallOnlyScript(requiredPorts)

  return {
    status: 'ready',
    wslIp,
    scriptKind,
    script: normalizeScriptForElevatedPowerShell(script),
  }
}

function buildWslPortForwardingTeardownPlan(
  requiredPorts: number[],
  knownOwnedPorts: number[],
  existingRules: Map<number, PortProxyRule>,
  existingFirewallPorts: Set<number>,
  managedPorts: Set<number>,
): WslPortForwardingTeardownPlan {
  const teardownPorts = Array.from(new Set([
    ...requiredPorts,
    ...existingFirewallPorts,
    ...managedPorts,
    ...getLegacyOwnedPortProxyPorts([], knownOwnedPorts, existingRules),
  ]))
  const hasRelevantPortProxyRules = teardownPorts.some((port) => existingRules.has(port))
  const hasFreshellFirewallRule = existingFirewallPorts.size > 0

  if (!hasRelevantPortProxyRules && !hasFreshellFirewallRule) {
    return { status: 'noop' }
  }

  return {
    status: 'ready',
    script: normalizeScriptForElevatedPowerShell(buildPortForwardingTeardownScript(teardownPorts)),
  }
}

export function computeWslPortForwardingPlan(
  requiredPorts: number[],
  knownOwnedPorts: number[] = requiredPorts,
): WslPortForwardingPlan {
  if (!isWSL2()) {
    return { status: 'not-wsl2' }
  }
  if (isWslPortForwardingDisabledByEnv()) {
    return { status: 'disabled' }
  }

  const wslIp = getWslIp()
  if (!wslIp) {
    return {
      status: 'error',
      message: 'Failed to detect WSL2 IP address',
    }
  }

  const existingRules = getExistingPortProxyRules()
  const existingFirewallPorts = getExistingFirewallPorts()
  const managedPorts = readManagedWslRemoteAccessPorts()

  return buildWslPortForwardingPlan(
    requiredPorts,
    knownOwnedPorts,
    wslIp,
    existingRules,
    existingFirewallPorts,
    managedPorts,
  )
}

export async function computeWslPortForwardingPlanAsync(
  requiredPorts: number[],
  knownOwnedPorts: number[] = requiredPorts,
): Promise<WslPortForwardingPlan> {
  if (!isWSL2()) {
    return { status: 'not-wsl2' }
  }
  if (isWslPortForwardingDisabledByEnv()) {
    return { status: 'disabled' }
  }

  const wslIp = await getWslIpAsync()
  if (!wslIp) {
    return {
      status: 'error',
      message: 'Failed to detect WSL2 IP address',
    }
  }

  const [existingRules, existingFirewallPorts] = await Promise.all([
    getExistingPortProxyRulesAsync(),
    getExistingFirewallPortsAsync(),
  ])
  const managedPorts = await readManagedWslRemoteAccessPortsAsync()

  if (existingRules === null || existingFirewallPorts === null) {
    return {
      status: 'error',
      message: 'Failed to query existing Windows remote access rules',
    }
  }

  return buildWslPortForwardingPlan(
    requiredPorts,
    knownOwnedPorts,
    wslIp,
    existingRules,
    existingFirewallPorts,
    managedPorts,
  )
}

export function computeWslPortForwardingTeardownPlan(
  requiredPorts: number[],
  knownOwnedPorts: number[] = requiredPorts,
): WslPortForwardingTeardownPlan {
  if (!isWSL2()) {
    return { status: 'not-wsl2' }
  }
  if (isWslPortForwardingDisabledByEnv()) {
    return { status: 'disabled' }
  }

  const existingRules = getExistingPortProxyRules()
  const existingFirewallPorts = getExistingFirewallPorts()
  const managedPorts = readManagedWslRemoteAccessPorts()

  return buildWslPortForwardingTeardownPlan(
    requiredPorts,
    knownOwnedPorts,
    existingRules,
    existingFirewallPorts,
    managedPorts,
  )
}

export async function computeWslPortForwardingTeardownPlanAsync(
  requiredPorts: number[],
  knownOwnedPorts: number[] = requiredPorts,
): Promise<WslPortForwardingTeardownPlan> {
  if (!isWSL2()) {
    return { status: 'not-wsl2' }
  }
  if (isWslPortForwardingDisabledByEnv()) {
    return { status: 'disabled' }
  }

  const [existingRules, existingFirewallPorts] = await Promise.all([
    getExistingPortProxyRulesAsync(),
    getExistingFirewallPortsAsync(),
  ])
  const managedPorts = await readManagedWslRemoteAccessPortsAsync()

  if (existingRules === null || existingFirewallPorts === null) {
    return {
      status: 'error',
      message: 'Failed to query existing Windows remote access rules',
    }
  }

  return buildWslPortForwardingTeardownPlan(
    requiredPorts,
    knownOwnedPorts,
    existingRules,
    existingFirewallPorts,
    managedPorts,
  )
}
