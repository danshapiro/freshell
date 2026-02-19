import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'

vi.mock('child_process')
vi.mock('../../../server/platform.js', () => ({
  isWSL2: vi.fn(() => false),
}))

import { isWSL2 } from '../../../server/platform.js'

import {
  getWslIp,
  parsePortProxyRules,
  getExistingPortProxyRules,
  getRequiredPorts,
  needsPortForwardingUpdate,
  buildPortForwardingScript,
  parseFirewallRulePorts,
  getExistingFirewallPorts,
  needsFirewallUpdate,
  buildFirewallOnlyScript,
  setupWslPortForwarding,
  type PortProxyRule
} from '../../../server/wsl-port-forward.js'

describe('wsl-port-forward', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('getWslIp', () => {
    it('returns IP from eth0 interface when available', () => {
      vi.mocked(execSync).mockReturnValueOnce(`
2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc mq state UP group default qlen 1000
    inet 172.30.149.249/20 brd 172.30.159.255 scope global eth0
       valid_lft forever preferred_lft forever
`)

      const ip = getWslIp()

      expect(ip).toBe('172.30.149.249')
      expect(execSync).toHaveBeenCalledWith('ip -4 addr show eth0 2>/dev/null', expect.anything())
    })

    it('falls back to hostname -I when eth0 fails', () => {
      vi.mocked(execSync)
        .mockImplementationOnce(() => { throw new Error('eth0 not found') })
        .mockReturnValueOnce('172.30.149.249 10.0.0.5 \n')

      const ip = getWslIp()

      expect(ip).toBe('172.30.149.249')
    })

    it('skips IPv6 addresses in fallback', () => {
      vi.mocked(execSync)
        .mockImplementationOnce(() => { throw new Error('eth0 not found') })
        .mockReturnValueOnce('fe80::1 2001:db8::1 172.30.149.249 10.0.0.5\n')

      const ip = getWslIp()

      expect(ip).toBe('172.30.149.249')
    })

    it('skips Docker bridge IP (172.17.x.x) in fallback', () => {
      vi.mocked(execSync)
        .mockImplementationOnce(() => { throw new Error('eth0 not found') })
        .mockReturnValueOnce('172.17.0.1 172.30.149.249\n')

      const ip = getWslIp()

      expect(ip).toBe('172.30.149.249')
    })

    it('returns null when both eth0 and hostname -I fail', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command failed')
      })

      const ip = getWslIp()

      expect(ip).toBeNull()
    })

    it('returns null when no IPv4 addresses found in fallback', () => {
      vi.mocked(execSync)
        .mockImplementationOnce(() => { throw new Error('eth0 not found') })
        .mockReturnValueOnce('fe80::1 2001:db8::1\n')

      const ip = getWslIp()

      expect(ip).toBeNull()
    })

    it('returns null when only Docker bridge IP found in fallback', () => {
      vi.mocked(execSync)
        .mockImplementationOnce(() => { throw new Error('eth0 not found') })
        .mockReturnValueOnce('172.17.0.1\n')

      const ip = getWslIp()

      expect(ip).toBeNull()
    })

    it('returns null when fallback output is empty', () => {
      vi.mocked(execSync)
        .mockImplementationOnce(() => { throw new Error('eth0 not found') })
        .mockReturnValueOnce('')

      const ip = getWslIp()

      expect(ip).toBeNull()
    })
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

  describe('getExistingPortProxyRules', () => {
    it('calls netsh with absolute path and parses output', () => {
      vi.mocked(execSync).mockReturnValue(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`)

      const rules = getExistingPortProxyRules()

      expect(execSync).toHaveBeenCalledWith(
        '/mnt/c/Windows/System32/netsh.exe interface portproxy show v4tov4',
        expect.objectContaining({ encoding: 'utf-8' })
      )
      expect(rules.get(3001)).toEqual({ connectAddress: '172.30.149.249', connectPort: 3001 })
    })

    it('returns empty map when netsh fails', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command failed')
      })

      const rules = getExistingPortProxyRules()

      expect(rules.size).toBe(0)
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

    it('returns default port 3001 when PORT not set', () => {
      delete process.env.PORT

      const ports = getRequiredPorts()

      expect(ports).toContain(3001)
    })

    it('uses PORT from environment', () => {
      process.env.PORT = '4000'

      const ports = getRequiredPorts()

      expect(ports).toContain(4000)
      expect(ports).not.toContain(3001)
    })

    it('includes provided devPort when not in production', () => {
      delete process.env.NODE_ENV
      delete process.env.PORT

      const ports = getRequiredPorts(5173)

      expect(ports).toContain(5173)
    })

    it('excludes devPort in production', () => {
      process.env.NODE_ENV = 'production'

      const ports = getRequiredPorts(5173)

      expect(ports).not.toContain(5173)
    })

    it('uses provided devPort instead of hardcoded 5173', () => {
      delete process.env.NODE_ENV
      delete process.env.PORT

      const ports = getRequiredPorts(4000)

      expect(ports).toContain(4000)
      expect(ports).not.toContain(5173)
    })

    it('does not include dev port when devPort is not provided', () => {
      delete process.env.NODE_ENV
      delete process.env.PORT

      const ports = getRequiredPorts()

      expect(ports).toEqual([3001])
    })

    it('falls back to default port when PORT is invalid (NaN)', () => {
      process.env.PORT = 'notanumber'

      const ports = getRequiredPorts()

      expect(ports).toContain(3001)
      expect(ports).not.toContain(NaN)
    })

    it('falls back to default port when PORT is out of range', () => {
      process.env.PORT = '99999'

      const ports = getRequiredPorts()

      expect(ports).toContain(3001)
      expect(ports).not.toContain(99999)
    })

    it('deduplicates when PORT equals devPort', () => {
      process.env.PORT = '5173'
      delete process.env.NODE_ENV

      const ports = getRequiredPorts(5173)

      // Should only contain 5173 once
      expect(ports).toEqual([5173])
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

  describe('getExistingFirewallPorts', () => {
    it('queries FreshellLANAccess rule and parses ports', () => {
      vi.mocked(execSync).mockReturnValue(`
Rule Name:                            FreshellLANAccess
LocalPort:                            3001,5173
Action:                               Allow
`)

      const ports = getExistingFirewallPorts()

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('advfirewall firewall show rule name=FreshellLANAccess'),
        expect.objectContaining({ encoding: 'utf-8' })
      )
      expect(ports).toEqual(new Set([3001, 5173]))
    })

    it('returns empty set when rule does not exist', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('No rules match the specified criteria')
      })

      const ports = getExistingFirewallPorts()

      expect(ports.size).toBe(0)
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

  describe('setupWslPortForwarding', () => {
    const originalEnv = process.env

    beforeEach(() => {
      vi.clearAllMocks()
      process.env = { ...originalEnv }
      // Ensure this suite is deterministic regardless of caller shell env.
      process.env.PORT = '3001'
      process.env.NODE_ENV = 'test'
      // Default: not WSL2
      vi.mocked(isWSL2).mockReturnValue(false)
    })

    afterEach(() => {
      vi.resetAllMocks()
      process.env = originalEnv
    })

    it('returns not-wsl2 when not running in WSL2', () => {
      vi.mocked(isWSL2).mockReturnValue(false)

      const result = setupWslPortForwarding()

      expect(result).toBe('not-wsl2')
    })

    it('returns skipped when port forwarding and firewall are already correct', () => {
      // Mock WSL2 detection
      vi.mocked(isWSL2).mockReturnValue(true)

      // Mock execSync calls in order
      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n') // ip -4 addr show eth0 (getWslIp)
        .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
0.0.0.0         5173        172.30.149.249  5173
`) // netsh portproxy show (getExistingPortProxyRules)
        .mockReturnValueOnce(`
Rule Name:                            FreshellLANAccess
LocalPort:                            3001
Action:                               Allow
`) // netsh firewall show (getExistingFirewallPorts)

      const result = setupWslPortForwarding()

      expect(result).toBe('skipped')
    })

    it('returns failed when WSL IP cannot be detected', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command failed')
      })

      const result = setupWslPortForwarding()

      expect(result).toBe('failed')
    })

    it('returns success when rules are applied and verified', () => {
      vi.mocked(isWSL2).mockReturnValue(true)

      // Mock execSync calls in order
      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n') // ip -4 addr show eth0 (getWslIp)
        .mockReturnValueOnce('') // netsh portproxy show - no existing rules
        .mockReturnValueOnce('') // netsh firewall show - no existing rule
        .mockReturnValueOnce('') // PowerShell elevation
        .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
0.0.0.0         5173        172.30.149.249  5173
`) // netsh portproxy show - verification
        .mockReturnValueOnce(`
Rule Name:                            FreshellLANAccess
LocalPort:                            3001
Action:                               Allow
`) // netsh firewall show - verification

      const result = setupWslPortForwarding()

      expect(result).toBe('success')
      // Verify PowerShell was called with absolute path
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'),
        expect.anything()
      )
    })

    it('returns failed when rules not applied after elevation (UAC cancelled)', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(isWSL2).mockReturnValue(true)

      // Mock execSync calls in order
      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n') // ip -4 addr show eth0
        .mockReturnValueOnce('') // netsh portproxy show - no existing rules
        .mockReturnValueOnce('') // netsh firewall show - no existing rule
        .mockReturnValueOnce('') // PowerShell (UAC cancelled, no error thrown)
        .mockReturnValueOnce('') // netsh portproxy show - still no rules (verification fails)

      const result = setupWslPortForwarding()

      expect(result).toBe('failed')
    })

    it('returns failed when PowerShell execution throws an error', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.mocked(isWSL2).mockReturnValue(true)

      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n') // ip -4 addr show eth0
        .mockReturnValueOnce('') // netsh portproxy show - no existing rules
        .mockReturnValueOnce('') // netsh firewall show - no existing rule
        .mockImplementationOnce(() => {
          // PowerShell throws (e.g., timeout, command not found)
          throw new Error('Command timed out')
        })

      const result = setupWslPortForwarding()

      expect(result).toBe('failed')
    })

    it('self-repairs when port forwarding is correct but firewall has stale ports', () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      vi.mocked(isWSL2).mockReturnValue(true)

      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n') // getWslIp
        .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`) // getExistingPortProxyRules — port forwarding is correct
        .mockReturnValueOnce(`
Rule Name:                            FreshellLANAccess
LocalPort:                            3011,5173
Action:                               Allow
`) // getExistingFirewallPorts — firewall is WRONG (missing 3001)
        .mockReturnValueOnce('') // PowerShell elevation (firewall-only script)
        .mockReturnValueOnce(`
Rule Name:                            FreshellLANAccess
LocalPort:                            3001
Action:                               Allow
`) // getExistingFirewallPorts — verification after update

      const result = setupWslPortForwarding()

      expect(result).toBe('success')
      // Should run firewall-only script, NOT port forwarding commands
      const psCall = vi.mocked(execSync).mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('powershell.exe')
      )
      expect(psCall).toBeDefined()
      const script = psCall![0] as string
      expect(script).not.toContain('portproxy')
      expect(script).toContain('FreshellLANAccess')
    })

    it('returns not-wsl2 for WSL1 (which has Microsoft but not WSL2 pattern)', () => {
      // WSL1 is not WSL2 — isWSL2() returns false
      vi.mocked(isWSL2).mockReturnValue(false)

      const result = setupWslPortForwarding()

      expect(result).toBe('not-wsl2')
    })
  })
})
