import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile } from 'child_process'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'

vi.mock('child_process')
vi.mock('../../../server/platform.js', () => ({
  isWSL2: vi.fn(() => false),
}))

import { isWSL2 } from '../../../server/platform.js'

import {
  computeWslPortForwardingPlanAsync,
  parsePortProxyRules,
  getRequiredPorts,
  needsPortForwardingUpdate,
  buildPortForwardingScript,
  parseFirewallRulePorts,
  needsFirewallUpdate,
  buildFirewallOnlyScript,
  buildPortForwardingTeardownScript,
  computeWslPortForwardingTeardownPlanAsync,
  persistManagedWslRemoteAccessPorts,
  type PortProxyRule
} from '../../../server/wsl-port-forward.js'

describe('wsl-port-forward', () => {
  let originalHome: string | undefined
  let tempHome: string

  beforeEach(async () => {
    vi.clearAllMocks()
    originalHome = process.env.HOME
    tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-wsl-port-forward-'))
    process.env.HOME = tempHome
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome)
  })

  afterEach(async () => {
    vi.resetAllMocks()
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    await fsp.rm(tempHome, { recursive: true, force: true })
  })

  describe('parsePortProxyRules', () => {
    it('parses netsh portproxy output into map with full rule details', () => {
      const output = `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
0.0.0.0         5173        172.30.149.249  5173
`
      const rules = parsePortProxyRules(output)

      expect(rules.get(3001)).toEqual({ connectAddress: '172.30.149.249', connectPort: 3001 })
      expect(rules.get(5173)).toEqual({ connectAddress: '172.30.149.249', connectPort: 5173 })
    })

    it('captures rules where listen port differs from connect port', () => {
      const output = `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         8080        172.30.149.249  3001
`
      const rules = parsePortProxyRules(output)

      expect(rules.get(8080)).toEqual({ connectAddress: '172.30.149.249', connectPort: 3001 })
    })

    it('returns empty map for empty output', () => {
      const rules = parsePortProxyRules('')

      expect(rules.size).toBe(0)
    })

    it('ignores rules not listening on 0.0.0.0', () => {
      const output = `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
127.0.0.1       8080        172.30.149.249  8080
0.0.0.0         3001        172.30.149.249  3001
`
      const rules = parsePortProxyRules(output)

      expect(rules.has(8080)).toBe(false)
      expect(rules.get(3001)).toEqual({ connectAddress: '172.30.149.249', connectPort: 3001 })
    })
  })

  describe('getRequiredPorts', () => {
    const originalEnv = process.env

    beforeEach(() => {
      process.env = { ...originalEnv }
    })

    afterEach(() => {
      process.env = originalEnv
    })

    it('uses PORT from environment and includes the dev server port outside production', () => {
      process.env.PORT = '4000'
      delete process.env.NODE_ENV

      expect(getRequiredPorts(5173)).toEqual([4000, 5173])
    })

    it('deduplicates ports and falls back to the default when PORT is invalid', () => {
      process.env.PORT = 'not-a-number'
      delete process.env.NODE_ENV

      expect(getRequiredPorts(3001)).toEqual([3001])
    })
  })

  describe('needsPortForwardingUpdate', () => {
    it('returns true when no rules exist', () => {
      const rules = new Map<number, PortProxyRule>()

      const needs = needsPortForwardingUpdate('172.30.149.249', [3001, 5173], rules)

      expect(needs).toBe(true)
    })

    it('returns true when rules point to wrong IP', () => {
      const rules = new Map<number, PortProxyRule>([
        [3001, { connectAddress: '172.30.100.100', connectPort: 3001 }],
        [5173, { connectAddress: '172.30.100.100', connectPort: 5173 }],
      ])

      const needs = needsPortForwardingUpdate('172.30.149.249', [3001, 5173], rules)

      expect(needs).toBe(true)
    })

    it('returns true when rules point to wrong port', () => {
      const rules = new Map<number, PortProxyRule>([
        [3001, { connectAddress: '172.30.149.249', connectPort: 8080 }], // wrong connect port!
        [5173, { connectAddress: '172.30.149.249', connectPort: 5173 }],
      ])

      const needs = needsPortForwardingUpdate('172.30.149.249', [3001, 5173], rules)

      expect(needs).toBe(true)
    })

    it('returns true when only one port is configured', () => {
      const rules = new Map<number, PortProxyRule>([
        [3001, { connectAddress: '172.30.149.249', connectPort: 3001 }],
      ])

      const needs = needsPortForwardingUpdate('172.30.149.249', [3001, 5173], rules)

      expect(needs).toBe(true)
    })

    it('returns false when all ports point to correct IP and port', () => {
      const rules = new Map<number, PortProxyRule>([
        [3001, { connectAddress: '172.30.149.249', connectPort: 3001 }],
        [5173, { connectAddress: '172.30.149.249', connectPort: 5173 }],
      ])

      const needs = needsPortForwardingUpdate('172.30.149.249', [3001, 5173], rules)

      expect(needs).toBe(false)
    })
  })

  describe('buildPortForwardingScript', () => {
    it('generates PowerShell script with delete and add commands', () => {
      const script = buildPortForwardingScript('172.30.149.249', [3001, 5173])

      // Delete commands with explicit listenaddress=0.0.0.0 to match rules we create
      expect(script).toContain('netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=3001')
      expect(script).toContain('netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=5173')

      // Add commands
      expect(script).toContain('netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=3001 connectaddress=172.30.149.249 connectport=3001')
      expect(script).toContain('netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=5173 connectaddress=172.30.149.249 connectport=5173')
    })

    it('includes firewall rule with private profile restriction', () => {
      const script = buildPortForwardingScript('172.30.149.249', [3001, 5173])

      expect(script).toContain('netsh advfirewall firewall delete rule name=FreshellLANAccess')
      expect(script).toContain('netsh advfirewall firewall add rule name=FreshellLANAccess')
      expect(script).toContain('profile=private')
      expect(script).toContain('localport=3001,5173')
    })

    it('uses escaped $null for PowerShell error suppression', () => {
      const script = buildPortForwardingScript('172.30.149.249', [3001])

      // Must use \$null to prevent shell expansion
      expect(script).toContain('2>\\$null')
      expect(script).not.toContain('2>$null')
    })

    it('handles single port', () => {
      const script = buildPortForwardingScript('172.30.149.249', [4000])

      expect(script).toContain('listenport=4000')
      expect(script).toContain('connectport=4000')
      expect(script).toContain('localport=4000')
    })
  })

  describe('parseFirewallRulePorts', () => {
    it('parses ports from netsh firewall show rule output', () => {
      const output = `
Rule Name:                            FreshellLANAccess
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private
LocalPort:                            3001,5173
RemotePort:                           Any
Action:                               Allow
`
      const ports = parseFirewallRulePorts(output)

      expect(ports).toEqual(new Set([3001, 5173]))
    })

    it('parses single port', () => {
      const output = `
Rule Name:                            FreshellLANAccess
LocalPort:                            3001
Action:                               Allow
`
      const ports = parseFirewallRulePorts(output)

      expect(ports).toEqual(new Set([3001]))
    })

    it('returns empty set for empty output', () => {
      const ports = parseFirewallRulePorts('')

      expect(ports.size).toBe(0)
    })

    it('returns empty set when no LocalPort line exists', () => {
      const output = `
Rule Name:                            FreshellLANAccess
Enabled:                              Yes
`
      const ports = parseFirewallRulePorts(output)

      expect(ports.size).toBe(0)
    })

    it('handles ports with surrounding whitespace', () => {
      const output = `LocalPort:                            3001, 5173 , 3002`

      const ports = parseFirewallRulePorts(output)

      expect(ports).toEqual(new Set([3001, 5173, 3002]))
    })
  })

  describe('needsFirewallUpdate', () => {
    it('returns true when required port is missing from firewall', () => {
      const existing = new Set([5173])

      expect(needsFirewallUpdate([3001, 5173], existing)).toBe(true)
    })

    it('returns true when firewall has no ports', () => {
      const existing = new Set<number>()

      expect(needsFirewallUpdate([3001], existing)).toBe(true)
    })

    it('returns false when all required ports are present', () => {
      const existing = new Set([3001, 5173])

      expect(needsFirewallUpdate([3001], existing)).toBe(false)
    })

    it('returns false when firewall has extra ports beyond required', () => {
      const existing = new Set([3001, 5173, 3002])

      expect(needsFirewallUpdate([3001], existing)).toBe(false)
    })

    it('returns false when required and existing match exactly', () => {
      const existing = new Set([3001, 5173])

      expect(needsFirewallUpdate([3001, 5173], existing)).toBe(false)
    })
  })

  describe('buildFirewallOnlyScript', () => {
    it('generates script with delete and add firewall commands', () => {
      const script = buildFirewallOnlyScript([3001, 5173])

      expect(script).toContain('netsh advfirewall firewall delete rule name=FreshellLANAccess')
      expect(script).toContain('netsh advfirewall firewall add rule name=FreshellLANAccess')
      expect(script).toContain('localport=3001,5173')
      expect(script).toContain('profile=private')
    })

    it('does not include port forwarding commands', () => {
      const script = buildFirewallOnlyScript([3001])

      expect(script).not.toContain('portproxy')
    })

    it('uses escaped $null for error suppression', () => {
      const script = buildFirewallOnlyScript([3001])

      expect(script).toContain('2>\\$null')
    })
  })

  describe('buildPortForwardingTeardownScript', () => {
    it('removes relevant portproxy rules and the Freshell firewall rule', () => {
      const script = buildPortForwardingTeardownScript([3001, 5173])

      expect(script).toContain('netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=3001')
      expect(script).toContain('netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=5173')
      expect(script).toContain('netsh advfirewall firewall delete rule name=FreshellLANAccess')
      expect(script).toContain('2>\\$null')
    })
  })

  describe('computeWslPortForwardingTeardownPlanAsync', () => {
    it('returns not-wsl2 when not running in WSL2', async () => {
      vi.mocked(isWSL2).mockReturnValue(false)

      await expect(computeWslPortForwardingTeardownPlanAsync([3001])).resolves.toEqual({
        status: 'not-wsl2',
      })
    })

    it('tears down stale old forwarded ports retained in the Freshell firewall rule', async () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execFile).mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
        if (args[0] === 'interface') {
          cb?.(null, `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         5173        172.30.149.249  5173
`, '')
          return {} as any
        }

        cb?.(null, `
Rule Name:                            FreshellLANAccess
LocalPort:                            3001,5173
`, '')
        return {} as any
      })

      await expect(computeWslPortForwardingTeardownPlanAsync([3001])).resolves.toEqual({
        status: 'ready',
        script: expect.stringContaining('listenport=5173'),
      })
    })

    it('tears down stale owned portproxy-only drift without deleting unrelated Windows rules', async () => {
      await persistManagedWslRemoteAccessPorts([5173])
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execFile).mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
        if (args[0] === 'interface') {
          cb?.(null, `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         5173        172.30.149.249  5173
0.0.0.0         8080        10.0.0.8       8080
`, '')
          return {} as any
        }

        const missingRuleError = Object.assign(new Error('rule not found'), { code: 1 })
        cb?.(missingRuleError, 'Aucune regle ne correspond aux criteres specifies.\r\n', '')
        return {} as any
      })

      const plan = await computeWslPortForwardingTeardownPlanAsync([3001])
      expect(plan).toEqual({
        status: 'ready',
        script: expect.stringContaining('listenport=5173'),
      })
      if (plan.status === 'ready') {
        expect(plan.script).toContain('listenport=3001')
        expect(plan.script).not.toContain('listenport=8080')
      }
    })

    it('tears down stale legacy Freshell portproxy-only drift on internal ports without deleting unrelated Windows rules', async () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execFile).mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
        if (args[0] === 'interface') {
          cb?.(null, `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
0.0.0.0         8080        10.0.0.8       8080
`, '')
          return {} as any
        }

        const missingRuleError = Object.assign(new Error('rule not found'), { code: 1 })
        cb?.(missingRuleError, 'Aucune regle ne correspond aux criteres specifies.\r\n', '')
        return {} as any
      })

      const plan = await (computeWslPortForwardingTeardownPlanAsync as any)([5173], [3001, 5173])
      expect(plan).toEqual({
        status: 'ready',
        script: expect.stringContaining('listenport=3001'),
      })
      if (plan.status === 'ready') {
        expect(plan.script).toContain('listenport=3001')
        expect(plan.script).toContain('listenport=5173')
        expect(plan.script).not.toContain('listenport=8080')
      }
    })

    it('treats a missing Freshell firewall rule as normal absence instead of a fatal async error', async () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execFile).mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
        if (args[0] === 'interface') {
          cb?.(null, `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
`, '')
          return {} as any
        }

        const missingRuleError = Object.assign(new Error('rule not found'), { code: 1 })
        cb?.(missingRuleError, 'Aucune regle ne correspond aux criteres specifies.\r\n', '')
        return {} as any
      })

      await expect(computeWslPortForwardingTeardownPlanAsync([3001])).resolves.toEqual({
        status: 'noop',
      })
    })

    it('returns an error when async Windows exposure probes fail', async () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb?.(new Error('netsh failed'))
        return {} as any
      })

      await expect(computeWslPortForwardingTeardownPlanAsync([3001])).resolves.toEqual({
        status: 'error',
        message: 'Failed to query existing Windows remote access rules',
      })
    })
  })

  describe('computeWslPortForwardingPlanAsync', () => {
    it('returns not-wsl2 when not running in WSL2', async () => {
      vi.mocked(isWSL2).mockReturnValue(false)

      await expect(computeWslPortForwardingPlanAsync([3001])).resolves.toEqual({
        status: 'not-wsl2',
      })
    })

    it('returns an error when the WSL IP cannot be detected', async () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb?.(new Error('command failed'))
        return {} as any
      })

      await expect(computeWslPortForwardingPlanAsync([3001])).resolves.toEqual({
        status: 'error',
        message: 'Failed to detect WSL2 IP address',
      })
    })

    it('falls back to hostname -I and skips IPv6 and Docker bridge addresses', async () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execFile).mockImplementation((cmd: any, args: any, _opts: any, cb: any) => {
        if (cmd === 'ip') {
          cb?.(new Error('eth0 not found'))
          return {} as any
        }

        if (cmd === 'hostname') {
          cb?.(null, 'fe80::1 172.17.0.1 172.30.149.249 10.0.0.5\n', '')
          return {} as any
        }

        if (args[0] === 'interface') {
          cb?.(null, `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
`, '')
          return {} as any
        }

        const missingRuleError = Object.assign(new Error('rule not found'), { code: 1 })
        cb?.(missingRuleError, 'Aucune regle ne correspond aux criteres specifies.\r\n', '')
        return {} as any
      })

      await expect(computeWslPortForwardingPlanAsync([3001])).resolves.toEqual({
        status: 'ready',
        wslIp: '172.30.149.249',
        scriptKind: 'full',
        script: expect.stringContaining('connectaddress=172.30.149.249 connectport=3001'),
      })
    })

    it('returns noop when live Windows exposure is correct and only managed metadata is stale', async () => {
      await persistManagedWslRemoteAccessPorts([5173])
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execFile).mockImplementation((cmd: any, args: any, _opts: any, cb: any) => {
        if (cmd === 'ip') {
          cb?.(null, 'inet 172.30.149.249/20 scope global eth0\n', '')
          return {} as any
        }

        if (args[0] === 'interface') {
          cb?.(null, `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`, '')
          return {} as any
        }

        cb?.(null, 'Rule Name: FreshellLANAccess\nLocalPort: 3001\n', '')
        return {} as any
      })

      await expect(computeWslPortForwardingPlanAsync([3001], [3001])).resolves.toEqual({
        status: 'noop',
        wslIp: '172.30.149.249',
      })
    })

    it('still returns full when a stale managed port still has a live portproxy rule', async () => {
      await persistManagedWslRemoteAccessPorts([5173])
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execFile).mockImplementation((cmd: any, args: any, _opts: any, cb: any) => {
        if (cmd === 'ip') {
          cb?.(null, 'inet 172.30.149.249/20 scope global eth0\n', '')
          return {} as any
        }

        if (args[0] === 'interface') {
          cb?.(null, `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
0.0.0.0         5173        172.30.149.249  5173
`, '')
          return {} as any
        }

        cb?.(null, 'Rule Name: FreshellLANAccess\nLocalPort: 3001\n', '')
        return {} as any
      })

      const plan = await computeWslPortForwardingPlanAsync([3001], [3001])

      expect(plan).toEqual({
        status: 'ready',
        wslIp: '172.30.149.249',
        scriptKind: 'full',
        script: expect.stringContaining('listenport=5173'),
      })
    })

    it('treats a missing Freshell firewall rule as drift instead of a fatal async error', async () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execFile).mockImplementation((cmd: any, args: any, _opts: any, cb: any) => {
        if (cmd === 'ip') {
          cb?.(null, 'inet 172.30.149.249/20 scope global eth0\n', '')
          return {} as any
        }

        if (args[0] === 'interface') {
          cb?.(null, `
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`, '')
          return {} as any
        }

        const missingRuleError = Object.assign(new Error('rule not found'), { code: 1 })
        cb?.(missingRuleError, 'Aucune regle ne correspond aux criteres specifies.\r\n', '')
        return {} as any
      })

      await expect(computeWslPortForwardingPlanAsync([3001])).resolves.toEqual({
        status: 'ready',
        wslIp: '172.30.149.249',
        scriptKind: 'firewall-only',
        script: expect.stringContaining('FreshellLANAccess'),
      })
    })
  })

  describe('FRESHELL_DISABLE_WSL_PORT_FORWARD', () => {
    afterEach(() => {
      delete process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD
    })

    it('computeWslPortForwardingPlanAsync returns disabled when env var is "1"', async () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '1'

      const plan = await computeWslPortForwardingPlanAsync([3001])

      expect(plan).toEqual({ status: 'disabled' })
    })

    it('computeWslPortForwardingPlanAsync returns disabled when env var is "True" (case-insensitive)', async () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = 'True'

      const plan = await computeWslPortForwardingPlanAsync([3001])

      expect(plan).toEqual({ status: 'disabled' })
    })

    it('computeWslPortForwardingPlanAsync returns disabled when env var is "yes"', async () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = 'yes'

      const plan = await computeWslPortForwardingPlanAsync([3001])

      expect(plan).toEqual({ status: 'disabled' })
    })

    it('computeWslPortForwardingTeardownPlanAsync returns disabled when env var is set', async () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      process.env.FRESHELL_DISABLE_WSL_PORT_FORWARD = '1'

      const plan = await computeWslPortForwardingTeardownPlanAsync([3001])

      expect(plan).toEqual({ status: 'disabled' })
    })
  })
})
