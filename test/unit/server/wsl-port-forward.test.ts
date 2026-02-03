import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import fs from 'fs'

vi.mock('child_process')
vi.mock('fs')

import {
  getWslIp,
  parsePortProxyRules,
  getExistingPortProxyRules,
  getRequiredPorts,
  needsPortForwardingUpdate,
  buildPortForwardingScript,
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

    it('includes dev port 5173 when not in production', () => {
      delete process.env.NODE_ENV
      delete process.env.PORT

      const ports = getRequiredPorts()

      expect(ports).toContain(5173)
    })

    it('excludes dev port 5173 in production', () => {
      process.env.NODE_ENV = 'production'

      const ports = getRequiredPorts()

      expect(ports).not.toContain(5173)
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

    it('deduplicates when PORT equals dev port', () => {
      process.env.PORT = '5173'
      delete process.env.NODE_ENV

      const ports = getRequiredPorts()

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

  describe('setupWslPortForwarding', () => {
    const originalEnv = process.env

    beforeEach(() => {
      vi.clearAllMocks()
      process.env = { ...originalEnv }
      // Default: not WSL2
      vi.mocked(fs.readFileSync).mockReturnValue('Linux version 5.10.0')
    })

    afterEach(() => {
      vi.resetAllMocks()
      process.env = originalEnv
    })

    it('returns not-wsl2 when not running in WSL2', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('Linux version 5.10.0-generic')

      const result = setupWslPortForwarding()

      expect(result).toBe('not-wsl2')
    })

    it('returns skipped when rules are already correct', () => {
      // Mock WSL2 detection
      vi.mocked(fs.readFileSync).mockReturnValue('Linux version 5.15.0-microsoft-standard-WSL2')

      // Mock execSync calls in order
      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n') // ip -4 addr show eth0 (getWslIp)
        .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
0.0.0.0         5173        172.30.149.249  5173
`) // netsh show (getExistingPortProxyRules)

      const result = setupWslPortForwarding()

      expect(result).toBe('skipped')
    })

    it('returns failed when WSL IP cannot be detected', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('Linux version 5.15.0-microsoft-standard-WSL2')
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command failed')
      })

      const result = setupWslPortForwarding()

      expect(result).toBe('failed')
    })

    it('returns success when rules are applied and verified', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('Linux version 5.15.0-microsoft-standard-WSL2')

      // Mock execSync calls in order
      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n') // ip -4 addr show eth0 (getWslIp)
        .mockReturnValueOnce('') // netsh show - no existing rules
        .mockReturnValueOnce('') // PowerShell elevation
        .mockReturnValueOnce(`
Listen on ipv4:             Connect to ipv4:

Address         Port        Address         Port
--------------- ----------  --------------- ----------
0.0.0.0         3001        172.30.149.249  3001
0.0.0.0         5173        172.30.149.249  5173
`) // netsh show - verification after elevation

      const result = setupWslPortForwarding()

      expect(result).toBe('success')
      // Verify PowerShell was called with absolute path
      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'),
        expect.anything()
      )
    })

    it('returns failed when rules not applied after elevation (UAC cancelled)', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('Linux version 5.15.0-microsoft-standard-WSL2')

      // Mock execSync calls in order
      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n') // ip -4 addr show eth0
        .mockReturnValueOnce('') // netsh show - no existing rules
        .mockReturnValueOnce('') // PowerShell (UAC cancelled, no error thrown)
        .mockReturnValueOnce('') // netsh show - still no rules (verification fails)

      const result = setupWslPortForwarding()

      expect(result).toBe('failed')
    })

    it('returns failed when PowerShell execution throws an error', () => {
      vi.mocked(fs.readFileSync).mockReturnValue('Linux version 5.15.0-microsoft-standard-WSL2')

      vi.mocked(execSync)
        .mockReturnValueOnce('inet 172.30.149.249/20 scope global eth0\n') // ip -4 addr show eth0
        .mockReturnValueOnce('') // netsh show - no existing rules
        .mockImplementationOnce(() => {
          // PowerShell throws (e.g., timeout, command not found)
          throw new Error('Command timed out')
        })

      const result = setupWslPortForwarding()

      expect(result).toBe('failed')
    })

    it('returns not-wsl2 for WSL1 (which has Microsoft but not WSL2 pattern)', () => {
      // WSL1 has "Microsoft" in version but not "wsl2" or "microsoft-standard"
      vi.mocked(fs.readFileSync).mockReturnValue('Linux version 4.4.0-18362-Microsoft')

      const result = setupWslPortForwarding()

      expect(result).toBe('not-wsl2')
    })
  })
})
