// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadEnv } from 'vite'
import { readFileSync } from 'node:fs'

vi.mock('node:fs')
// Mock dotenv to prevent .env file loading in tests. getNetworkHost()
// calls dotenv.config() at runtime, which would load any .env file from
// the test runner's working directory — making tests non-hermetic.
vi.mock('dotenv', () => ({
  default: { config: vi.fn() },
  config: vi.fn(),
}))

const TEST_TIMEOUT_MS = 20_000

describe('getNetworkHost', () => {
  const originalHost = process.env.HOST

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    delete process.env.HOST
  })

  afterEach(() => {
    if (originalHost !== undefined) process.env.HOST = originalHost
    else delete process.env.HOST
  })

  it('returns 127.0.0.1 when config file does not exist', async () => {
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
    const { getNetworkHost } = await import('../../server/get-network-host.js')
    expect(getNetworkHost()).toBe('127.0.0.1')
  })

  it('returns host from config when configured', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      settings: { network: { host: '0.0.0.0', configured: true } },
    }))
    const { getNetworkHost } = await import('../../server/get-network-host.js')
    expect(getNetworkHost()).toBe('0.0.0.0')
  })

  it('returns 127.0.0.1 when config has no network settings', async () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ settings: {} }))
    const { getNetworkHost } = await import('../../server/get-network-host.js')
    expect(getNetworkHost()).toBe('127.0.0.1')
  })

  it('honors HOST env override when unconfigured', async () => {
    process.env.HOST = '0.0.0.0'
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      settings: { network: { host: '127.0.0.1', configured: false } },
    }))
    const { getNetworkHost } = await import('../../server/get-network-host.js')
    expect(getNetworkHost()).toBe('0.0.0.0')
  })

  it('ignores HOST env when configured', async () => {
    process.env.HOST = '0.0.0.0'
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      settings: { network: { host: '127.0.0.1', configured: true } },
    }))
    const { getNetworkHost } = await import('../../server/get-network-host.js')
    expect(getNetworkHost()).toBe('127.0.0.1')
  })

  it('uses HOST env when no config file exists', async () => {
    process.env.HOST = '0.0.0.0'
    vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
    const { getNetworkHost } = await import('../../server/get-network-host.js')
    expect(getNetworkHost()).toBe('0.0.0.0')
  })

  it('always returns 0.0.0.0 on WSL2 regardless of config', async () => {
    vi.mocked(readFileSync).mockImplementation((path: any) => {
      if (String(path) === '/proc/version') return 'Linux version 5.15.167.4-microsoft-standard-WSL2'
      return JSON.stringify({
        settings: { network: { host: '127.0.0.1', configured: true } },
      })
    })
    const { getNetworkHost } = await import('../../server/get-network-host.js')
    expect(getNetworkHost()).toBe('0.0.0.0')
  })
})

describe('vite config', () => {
  it('uses ipv4 loopback for backend proxy by default', async () => {
    const originalBackendHost = process.env.VITE_BACKEND_HOST
    const originalAltHost = process.env.BACKEND_HOST
    const originalPort = process.env.PORT

    try {
      delete process.env.VITE_BACKEND_HOST
      delete process.env.BACKEND_HOST
      delete process.env.PORT

      const env = loadEnv('development', process.cwd(), '')
      const expectedHost = env.VITE_BACKEND_HOST || env.BACKEND_HOST || '127.0.0.1'
      const expectedPort = env.PORT || '3001'
      const expectedUrl = `http://${expectedHost}:${expectedPort}`

      const configModule = await import('../../vite.config.ts')
      const configFn = configModule.default
      const config = configFn({ mode: 'development', command: 'serve' })
      const proxy = config.server?.proxy as Record<string, string | { target?: string }>
      const apiProxy = proxy['/api']
      const wsProxy = proxy['/ws']
      const apiTarget = typeof apiProxy === 'string' ? apiProxy : apiProxy?.target
      const wsTarget = typeof wsProxy === 'string' ? wsProxy : wsProxy?.target

      expect(apiTarget).toBe(expectedUrl)
      expect(wsTarget).toBe(expectedUrl)
    } finally {
      if (originalBackendHost !== undefined) {
        process.env.VITE_BACKEND_HOST = originalBackendHost
      } else {
        delete process.env.VITE_BACKEND_HOST
      }
      if (originalAltHost !== undefined) {
        process.env.BACKEND_HOST = originalAltHost
      } else {
        delete process.env.BACKEND_HOST
      }
      if (originalPort !== undefined) {
        process.env.PORT = originalPort
      } else {
        delete process.env.PORT
      }
    }
  }, TEST_TIMEOUT_MS)
})
