import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'

vi.mock('child_process')

import { getWslIp, parsePortProxyRules, type PortProxyRule } from '../../../server/wsl-port-forward.js'

describe('wsl-port-forward', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('getWslIp', () => {
    it('returns first IPv4 address from hostname -I', () => {
      vi.mocked(execSync).mockReturnValue('172.30.149.249 172.17.0.1 \n')

      const ip = getWslIp()

      expect(ip).toBe('172.30.149.249')
    })

    it('skips IPv6 addresses and returns first IPv4', () => {
      vi.mocked(execSync).mockReturnValue('fe80::1 2001:db8::1 172.30.149.249 10.0.0.5\n')

      const ip = getWslIp()

      expect(ip).toBe('172.30.149.249')
    })

    it('returns null when hostname -I fails', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('Command failed')
      })

      const ip = getWslIp()

      expect(ip).toBeNull()
    })

    it('returns null when no IPv4 addresses found', () => {
      vi.mocked(execSync).mockReturnValue('fe80::1 2001:db8::1\n')

      const ip = getWslIp()

      expect(ip).toBeNull()
    })

    it('returns null when output is empty', () => {
      vi.mocked(execSync).mockReturnValue('')

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
})
