import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Mock fs and os modules before importing the module under test
vi.mock('fs')
vi.mock('os')

// Import the module under test after mocking
import {
  detectLanIps,
  generateAuthToken,
  buildAllowedOrigins,
  readConfigHost,
  parseEnvFile,
  checkNeedsAuthToken,
  ensureEnvFile,
  type BootstrapResult,
} from '../../../server/bootstrap'

describe('bootstrap module', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  describe('detectLanIps', () => {
    it('returns IPv4 non-loopback addresses', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({
        eth0: [
          { address: '192.168.1.100', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo,
          { address: 'fe80::1', family: 'IPv6', internal: false } as os.NetworkInterfaceInfo,
        ],
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
      })

      const ips = detectLanIps()

      expect(ips).toEqual(['192.168.1.100'])
    })

    it('excludes loopback addresses', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as os.NetworkInterfaceInfo],
        eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
      })

      const ips = detectLanIps()

      expect(ips).not.toContain('127.0.0.1')
      expect(ips).toContain('10.0.0.5')
    })

    it('excludes IPv6 addresses', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({
        eth0: [
          { address: '192.168.1.50', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo,
          { address: '2001:db8::1', family: 'IPv6', internal: false } as os.NetworkInterfaceInfo,
        ],
      })

      const ips = detectLanIps()

      expect(ips).toEqual(['192.168.1.50'])
      expect(ips).not.toContain('2001:db8::1')
    })

    it('returns multiple IPs from different interfaces', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({
        eth0: [{ address: '192.168.1.100', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
        wlan0: [{ address: '192.168.1.101', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
      })

      const ips = detectLanIps()

      expect(ips).toEqual(['192.168.1.100', '192.168.1.101'])
    })

    it('returns empty array when no network interfaces', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({})

      const ips = detectLanIps()

      expect(ips).toEqual([])
    })

    it('handles undefined interface entries', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({
        eth0: undefined,
        wlan0: [{ address: '192.168.1.50', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
      })

      const ips = detectLanIps()

      expect(ips).toEqual(['192.168.1.50'])
    })
  })

  describe('generateAuthToken', () => {
    it('generates a 64-character hex string', () => {
      const token = generateAuthToken()

      expect(token).toHaveLength(64)
      expect(/^[a-f0-9]+$/.test(token)).toBe(true)
    })

    it('generates unique tokens on each call', () => {
      const token1 = generateAuthToken()
      const token2 = generateAuthToken()

      expect(token1).not.toBe(token2)
    })

    it('generates cryptographically random tokens', () => {
      // Generate many tokens and check for uniqueness
      const tokens = new Set<string>()
      for (let i = 0; i < 100; i++) {
        tokens.add(generateAuthToken())
      }

      expect(tokens.size).toBe(100)
    })
  })

  describe('buildAllowedOrigins', () => {
    it('includes localhost origins for dev and prod ports', () => {
      const origins = buildAllowedOrigins([])

      expect(origins).toContain('http://localhost:5173')
      expect(origins).toContain('http://localhost:3001')
      expect(origins).toContain('http://127.0.0.1:5173')
      expect(origins).toContain('http://127.0.0.1:3001')
    })

    it('includes LAN IP origins for both ports', () => {
      const origins = buildAllowedOrigins(['192.168.1.100'])

      expect(origins).toContain('http://192.168.1.100:5173')
      expect(origins).toContain('http://192.168.1.100:3001')
    })

    it('includes multiple LAN IPs', () => {
      const origins = buildAllowedOrigins(['192.168.1.100', '10.0.0.5'])

      expect(origins).toContain('http://192.168.1.100:5173')
      expect(origins).toContain('http://192.168.1.100:3001')
      expect(origins).toContain('http://10.0.0.5:5173')
      expect(origins).toContain('http://10.0.0.5:3001')
    })

    it('returns comma-separated string format', () => {
      const origins = buildAllowedOrigins(['192.168.1.100'])

      // Should be a comma-separated string
      expect(typeof origins).toBe('string')
      expect(origins.includes(',')).toBe(true)
    })
  })

  describe('readConfigHost', () => {
    it('returns 0.0.0.0 when config.json has remote access configured', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser')
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ settings: { network: { host: '0.0.0.0' } } })
      )

      expect(readConfigHost()).toBe('0.0.0.0')
    })

    it('returns 127.0.0.1 when config.json has localhost', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser')
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ settings: { network: { host: '127.0.0.1' } } })
      )

      expect(readConfigHost()).toBe('127.0.0.1')
    })

    it('returns 127.0.0.1 when config.json does not exist', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser')
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT')
      })

      expect(readConfigHost()).toBe('127.0.0.1')
    })

    it('returns 127.0.0.1 when config has invalid host value', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser')
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ settings: { network: { host: '10.0.0.1' } } })
      )

      expect(readConfigHost()).toBe('127.0.0.1')
    })

    it('returns 127.0.0.1 when config has no network settings', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser')
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ settings: {} }))

      expect(readConfigHost()).toBe('127.0.0.1')
    })
  })

  describe('parseEnvFile', () => {
    it('parses key=value pairs', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('AUTH_TOKEN=abc123\nPORT=3001')

      const env = parseEnvFile('/path/.env')

      expect(env).toEqual({ AUTH_TOKEN: 'abc123', PORT: '3001' })
    })

    it('ignores comment lines', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('# This is a comment\nAUTH_TOKEN=secret\n# Another comment')

      const env = parseEnvFile('/path/.env')

      expect(env).toEqual({ AUTH_TOKEN: 'secret' })
    })

    it('ignores empty lines', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('AUTH_TOKEN=secret\n\n\nPORT=3001')

      const env = parseEnvFile('/path/.env')

      expect(env).toEqual({ AUTH_TOKEN: 'secret', PORT: '3001' })
    })

    it('returns empty object when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const env = parseEnvFile('/path/.env')

      expect(env).toEqual({})
    })

    it('handles values with equals signs', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('API_KEY=abc=def=ghi')

      const env = parseEnvFile('/path/.env')

      expect(env).toEqual({ API_KEY: 'abc=def=ghi' })
    })

    it('handles quoted values', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('VALUE="hello world"\nOTHER=\'single quoted\'')

      const env = parseEnvFile('/path/.env')

      expect(env.VALUE).toBe('hello world')
      expect(env.OTHER).toBe('single quoted')
    })

    it('trims whitespace from keys and values', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('  AUTH_TOKEN  =  abc123  ')

      const env = parseEnvFile('/path/.env')

      expect(env).toEqual({ AUTH_TOKEN: 'abc123' })
    })
  })

  describe('checkNeedsAuthToken', () => {
    it('returns true when AUTH_TOKEN is missing', () => {
      const needs = checkNeedsAuthToken({})

      expect(needs).toBe(true)
    })

    it('returns true when AUTH_TOKEN is empty', () => {
      const needs = checkNeedsAuthToken({ AUTH_TOKEN: '' })

      expect(needs).toBe(true)
    })

    it('returns true when AUTH_TOKEN is whitespace only', () => {
      const needs = checkNeedsAuthToken({ AUTH_TOKEN: '   ' })

      expect(needs).toBe(true)
    })

    it('returns true when AUTH_TOKEN is a placeholder value', () => {
      const placeholders = [
        'replace-with-a-long-random-token',
        'your-token-here',
        'changeme',
        'CHANGEME',
      ]

      for (const placeholder of placeholders) {
        const needs = checkNeedsAuthToken({ AUTH_TOKEN: placeholder })
        expect(needs).toBe(true)
      }
    })

    it('returns false when AUTH_TOKEN is set to a real value', () => {
      const needs = checkNeedsAuthToken({ AUTH_TOKEN: 'abc123def456' })

      expect(needs).toBe(false)
    })
  })

  describe('ensureEnvFile', () => {
    const mockEnvPath = '/project/.env'

    beforeEach(() => {
      // Default mock: no network interfaces
      vi.mocked(os.networkInterfaces).mockReturnValue({
        eth0: [{ address: '192.168.1.100', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo],
      })
    })

    it('creates .env when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      const result = ensureEnvFile(mockEnvPath)

      expect(result.action).toBe('created')
      expect(fs.writeFileSync).toHaveBeenCalled()
      expect(result.token).toHaveLength(64)
    })

    it('patches .env when AUTH_TOKEN is missing', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('PORT=3001')
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      const result = ensureEnvFile(mockEnvPath)

      expect(result.action).toBe('patched')
      expect(fs.writeFileSync).toHaveBeenCalled()
    })

    it('patches .env when AUTH_TOKEN is a placeholder', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('AUTH_TOKEN=replace-with-a-long-random-token\nPORT=3001')
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      const result = ensureEnvFile(mockEnvPath)

      expect(result.action).toBe('patched')
    })

    it('skips when .env has valid AUTH_TOKEN', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('AUTH_TOKEN=abc123def456ghi789\nPORT=3001')

      const result = ensureEnvFile(mockEnvPath)

      expect(result.action).toBe('skipped')
      expect(fs.writeFileSync).not.toHaveBeenCalled()
    })

    it('preserves existing env content when patching', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('# My config\nPORT=4000\nGOOGLE_API_KEY=secret')
      let writtenContent = ''
      vi.mocked(fs.writeFileSync).mockImplementation((_, data) => {
        writtenContent = data as string
      })

      ensureEnvFile(mockEnvPath)

      expect(writtenContent).toContain('PORT=4000')
      expect(writtenContent).toContain('GOOGLE_API_KEY=secret')
      expect(writtenContent).toContain('AUTH_TOKEN=')
    })

    it('generated .env includes ALLOWED_ORIGINS with LAN IPs when config host is 0.0.0.0', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser')
      vi.mocked(fs.existsSync).mockReturnValue(false)
      // readConfigHost reads config.json, ensureEnvFile reads .env (but existsSync is false)
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ settings: { network: { host: '0.0.0.0' } } })
      )
      let writtenContent = ''
      vi.mocked(fs.writeFileSync).mockImplementation((_, data) => {
        writtenContent = data as string
      })

      ensureEnvFile(mockEnvPath)

      expect(writtenContent).toContain('ALLOWED_ORIGINS=')
      expect(writtenContent).toContain('192.168.1.100')
    })

    it('generated .env includes only localhost origins when config host is 127.0.0.1', () => {
      vi.mocked(os.homedir).mockReturnValue('/home/testuser')
      vi.mocked(fs.existsSync).mockReturnValue(false)
      // readConfigHost throws (no config.json) → defaults to 127.0.0.1
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('ENOENT')
      })
      let writtenContent = ''
      vi.mocked(fs.writeFileSync).mockImplementation((_, data) => {
        writtenContent = data as string
      })

      ensureEnvFile(mockEnvPath)

      expect(writtenContent).toContain('ALLOWED_ORIGINS=')
      expect(writtenContent).toContain('localhost')
      expect(writtenContent).not.toContain('192.168.1.100')
    })

    it('generated .env includes PORT default', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      let writtenContent = ''
      vi.mocked(fs.writeFileSync).mockImplementation((_, data) => {
        writtenContent = data as string
      })

      ensureEnvFile(mockEnvPath)

      expect(writtenContent).toContain('PORT=3001')
    })

    it('returns generated token in result', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      vi.mocked(fs.writeFileSync).mockImplementation(() => {})

      const result = ensureEnvFile(mockEnvPath)

      expect(result.token).toBeDefined()
      expect(result.token).toHaveLength(64)
    })

    it('handles localhost-only when no LAN interfaces', () => {
      vi.mocked(os.networkInterfaces).mockReturnValue({})
      vi.mocked(os.homedir).mockReturnValue('/home/testuser')
      vi.mocked(fs.existsSync).mockReturnValue(false)
      // readConfigHost returns 0.0.0.0, but no LAN IPs available
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({ settings: { network: { host: '0.0.0.0' } } })
      )
      let writtenContent = ''
      vi.mocked(fs.writeFileSync).mockImplementation((_, data) => {
        writtenContent = data as string
      })

      const result = ensureEnvFile(mockEnvPath)

      expect(result.action).toBe('created')
      expect(writtenContent).toContain('ALLOWED_ORIGINS=')
      expect(writtenContent).toContain('localhost')
    })

    it('handles write errors gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      vi.mocked(fs.writeFileSync).mockImplementation(() => {
        throw new Error('Permission denied')
      })

      const result = ensureEnvFile(mockEnvPath)

      expect(result.action).toBe('error')
      expect(result.error).toContain('Permission denied')
    })
  })
})
