import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFile, execSync } from 'child_process'

vi.mock('child_process')
vi.mock('../../../server/platform.js', () => ({
  isWSL2: vi.fn(() => false),
}))

import { isWSL2 } from '../../../server/platform.js'

import {
  computeWslPortForwardingPlan,
  computeWslPortForwardingPlanAsync,
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
  buildPortForwardingTeardownScript,
  computeWslPortForwardingTeardownPlan,
  computeWslPortForwardingTeardownPlanAsync,
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

  describe('computeWslPortForwardingPlan', () => {
    it('returns not-wsl2 when not running in WSL2', () => {
      vi.mocked(isWSL2).mockReturnValue(false)

      expect(computeWslPortForwardingPlan([3001])).toEqual({ status: 'not-wsl2' })
    })

    it('returns error when WSL IP cannot be detected', () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command failed')
      })

      expect(computeWslPortForwardingPlan([3001])).toEqual({
        status: 'error',
        message: 'Failed to detect WSL2 IP address',
      })
    })

    it('returns noop when port forwarding and firewall are already correct', () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n')
        .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`)
        .mockReturnValueOnce(`Rule Name: FreshellLANAccess\nLocalPort: 3001\n`)

      expect(computeWslPortForwardingPlan([3001])).toEqual({
        status: 'noop',
        wslIp: '172.30.149.249',
      })
    })

    it('returns a firewall-only repair plan when only the firewall drifted', () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n')
        .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`)
        .mockReturnValueOnce(`Rule Name: FreshellLANAccess\nLocalPort: 3011\n`)

      expect(computeWslPortForwardingPlan([3001])).toEqual({
        status: 'ready',
        wslIp: '172.30.149.249',
        scriptKind: 'firewall-only',
        script: expect.stringContaining('FreshellLANAccess'),
      })
    })

    it('returns a full repair plan when portproxy rules are missing', () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n')
        .mockReturnValueOnce('')
        .mockReturnValueOnce(`Rule Name: FreshellLANAccess\nLocalPort: 3001\n`)

      expect(computeWslPortForwardingPlan([3001])).toEqual({
        status: 'ready',
        wslIp: '172.30.149.249',
        scriptKind: 'full',
        script: expect.stringContaining('portproxy add'),
      })
    })

    it('returns a full repair plan when portproxy rules point at the wrong IP or port', () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n')
        .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.250  4000
`)
        .mockReturnValueOnce(`Rule Name: FreshellLANAccess\nLocalPort: 3001\n`)

      expect(computeWslPortForwardingPlan([3001])).toEqual({
        status: 'ready',
        wslIp: '172.30.149.249',
        scriptKind: 'full',
        script: expect.stringContaining('connectaddress=172.30.149.249 connectport=3001'),
      })
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

  describe('computeWslPortForwardingTeardownPlan', () => {
    it('returns not-wsl2 when not running in WSL2', () => {
      vi.mocked(isWSL2).mockReturnValue(false)

      expect(computeWslPortForwardingTeardownPlan([3001])).toEqual({ status: 'not-wsl2' })
    })

    it('returns noop when no relevant Windows exposure remains', () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execSync)
        .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
`)
        .mockImplementationOnce(() => {
          throw new Error('rule not found')
        })

      expect(computeWslPortForwardingTeardownPlan([3001])).toEqual({ status: 'noop' })
    })

    it('returns a teardown script when Freshell portproxy or firewall exposure still exists', () => {
      vi.mocked(isWSL2).mockReturnValue(true)
      vi.mocked(execSync)
        .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
`)
        .mockReturnValueOnce(`
Rule Name:                            FreshellLANAccess
LocalPort:                            3001
`)

      expect(computeWslPortForwardingTeardownPlan([3001])).toEqual({
        status: 'ready',
        script: buildPortForwardingTeardownScript([3001]).replace(/\\\$/g, '$'),
      })
    })
  })

  describe('computeWslPortForwardingTeardownPlanAsync', () => {
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

        cb?.(
          Object.assign(new Error('rule not found'), {
            code: 1,
            stdout: 'No rules match the specified criteria.\r\n',
            stderr: '',
          }),
          '',
          '',
        )
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

        cb?.(
          Object.assign(new Error('rule not found'), {
            code: 1,
            stdout: 'No rules match the specified criteria.\r\n',
            stderr: '',
          }),
          '',
          '',
        )
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
})
