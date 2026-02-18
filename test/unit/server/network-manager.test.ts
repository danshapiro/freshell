import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { NetworkManager } from '../../../server/network-manager.js'
import { detectLanIps } from '../../../server/bootstrap.js'

// Mock external dependencies
vi.mock('../../../server/bootstrap.js', () => ({
  detectLanIps: vi.fn().mockReturnValue(['192.168.1.100']),
}))
vi.mock('is-port-reachable', () => ({
  default: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../../server/firewall.js', () => ({
  detectFirewall: vi.fn().mockResolvedValue({ platform: 'linux-none', active: false }),
  firewallCommands: vi.fn().mockReturnValue([]),
}))

describe('NetworkManager', () => {
  const testPort = 9876
  let server: http.Server
  let mockConfigStore: any
  let manager: NetworkManager

  /** Creates a mock config store that tracks state from patchSettings calls. */
  function createMockConfigStore(initial: any = {
    network: {
      host: '127.0.0.1',
      configured: false,
    },
  }) {
    let current = structuredClone(initial)
    return {
      getSettings: vi.fn(async () => structuredClone(current)),
      patchSettings: vi.fn(async (patch: any) => {
        if (patch.network) {
          current.network = { ...current.network, ...patch.network }
        }
        return structuredClone(current)
      }),
    }
  }

  let savedAllowedOrigins: string | undefined
  let savedExtraAllowedOrigins: string | undefined
  let savedAuthToken: string | undefined
  let savedHost: string | undefined

  beforeEach(() => {
    server = http.createServer()
    mockConfigStore = createMockConfigStore()
    savedAllowedOrigins = process.env.ALLOWED_ORIGINS
    savedExtraAllowedOrigins = process.env.EXTRA_ALLOWED_ORIGINS
    savedAuthToken = process.env.AUTH_TOKEN
    savedHost = process.env.HOST
    delete process.env.ALLOWED_ORIGINS
    delete process.env.EXTRA_ALLOWED_ORIGINS
    delete process.env.HOST
  })

  afterEach(async () => {
    if (manager) await manager.stop()
    if (server.listening) server.close()
    if (savedAllowedOrigins !== undefined) {
      process.env.ALLOWED_ORIGINS = savedAllowedOrigins
    } else {
      delete process.env.ALLOWED_ORIGINS
    }
    if (savedExtraAllowedOrigins !== undefined) {
      process.env.EXTRA_ALLOWED_ORIGINS = savedExtraAllowedOrigins
    } else {
      delete process.env.EXTRA_ALLOWED_ORIGINS
    }
    if (savedAuthToken !== undefined) {
      process.env.AUTH_TOKEN = savedAuthToken
    } else {
      delete process.env.AUTH_TOKEN
    }
    if (savedHost !== undefined) {
      process.env.HOST = savedHost
    } else {
      delete process.env.HOST
    }
  })

  it('starts with localhost binding by default', async () => {
    manager = new NetworkManager(server, mockConfigStore, 0)
    const status = await manager.getStatus()
    expect(status.host).toBe('127.0.0.1')
    expect(status.configured).toBe(false)
  })

  it('reports LAN IPs from detectLanIps()', async () => {
    manager = new NetworkManager(server, mockConfigStore, 0)
    const status = await manager.getStatus()
    expect(status.lanIps).toContain('192.168.1.100')
  })

  it('hot rebinds from localhost to 0.0.0.0', async () => {
    manager = new NetworkManager(server, mockConfigStore, 0)
    // Start listening on localhost
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const result = await manager.configure({
      host: '0.0.0.0',
      configured: true,
    })

    // configure() schedules rebind via setImmediate, does NOT block
    expect(result.rebindScheduled).toBe(true)
    expect(mockConfigStore.patchSettings).toHaveBeenCalledWith({
      network: {
        host: '0.0.0.0',
        configured: true,
      },
    })
  })

  it('does not schedule rebind when host unchanged', async () => {
    manager = new NetworkManager(server, mockConfigStore, 0)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const result = await manager.configure({
      host: '127.0.0.1',
      configured: true,
    })

    expect(result.rebindScheduled).toBe(false)
  })

  it('builds correct accessUrl with token and port', async () => {
    process.env.AUTH_TOKEN = 'test-token-1234567890'
    mockConfigStore = createMockConfigStore({
      network: {
        host: '0.0.0.0',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, testPort)
    const status = await manager.getStatus()
    expect(status.accessUrl).toContain('192.168.1.100')
    expect(status.accessUrl).toContain(`${testPort}`)
    expect(status.accessUrl).toContain('token=')
  })

  it('includes devMode ports', async () => {
    manager = new NetworkManager(server, mockConfigStore, 9876, true, 5173)
    const status = await manager.getStatus()
    expect(status.devMode).toBe(true)
  })

  it('preserves WsHandler across rebind via prepareForRebind/resumeAfterRebind', async () => {
    manager = new NetworkManager(server, mockConfigStore, 0)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const mockWsHandler = {
      prepareForRebind: vi.fn(),
      resumeAfterRebind: vi.fn(),
      broadcast: vi.fn(),
    }
    manager.setWsHandler(mockWsHandler)

    await manager.configure({
      host: '0.0.0.0',
      configured: true,
    })

    // Wait for setImmediate-scheduled rebind to complete
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.waitFor(() => {
      expect(mockWsHandler.resumeAfterRebind).toHaveBeenCalled()
    })

    expect(mockWsHandler.prepareForRebind).toHaveBeenCalledOnce()
    expect(mockWsHandler.resumeAfterRebind).toHaveBeenCalledOnce()
    // resumeAfterRebind must be called AFTER prepareForRebind
    const prepareOrder = mockWsHandler.prepareForRebind.mock.invocationCallOrder[0]
    const resumeOrder = mockWsHandler.resumeAfterRebind.mock.invocationCallOrder[0]
    expect(resumeOrder).toBeGreaterThan(prepareOrder)
  })

  it('calls resumeAfterRebind even when rebind fails', async () => {
    manager = new NetworkManager(server, mockConfigStore, 0)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const mockWsHandler = {
      prepareForRebind: vi.fn(),
      resumeAfterRebind: vi.fn(),
      broadcast: vi.fn(),
    }
    manager.setWsHandler(mockWsHandler)

    // Force server.close to fail
    const originalClose = server.close.bind(server)
    server.close = vi.fn((cb) => cb(new Error('close failed'))) as any

    await manager.configure({
      host: '0.0.0.0',
      configured: true,
    })

    // Wait for setImmediate-scheduled rebind
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setTimeout(resolve, 50))

    // prepareForRebind was called
    expect(mockWsHandler.prepareForRebind).toHaveBeenCalledOnce()
    // CRITICAL: resumeAfterRebind must still be called (via finally block)
    expect(mockWsHandler.resumeAfterRebind).toHaveBeenCalledOnce()

    // Restore
    server.close = originalClose
  })

  it('queues rapid rebinds and applies only the latest host', async () => {
    manager = new NetworkManager(server, mockConfigStore, 0)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const mockWsHandler = {
      prepareForRebind: vi.fn(),
      resumeAfterRebind: vi.fn(),
      broadcast: vi.fn(),
    }
    manager.setWsHandler(mockWsHandler)

    // First configure triggers a real rebind (to 0.0.0.0)
    await manager.configure({
      host: '0.0.0.0',
      configured: true,
    })

    // Wait for setImmediate to fire so rebind() is in progress
    await new Promise<void>((resolve) => setImmediate(resolve))

    // First rebind is now in progress. Queue a second one (back to localhost).
    await manager.configure({
      host: '127.0.0.1',
      configured: true,
    })

    // Wait for both rebinds to complete (first + queued)
    await vi.waitFor(() => {
      expect(mockWsHandler.resumeAfterRebind).toHaveBeenCalledTimes(2)
    }, { timeout: 2000 })

    // Verify the server ended up on the LAST requested host (127.0.0.1)
    const addr = server.address()
    const finalHost = (addr && typeof addr === 'object') ? addr.address : null
    expect(finalHost).toBe('127.0.0.1')

    // Verify config matches the listener (queued configure() re-persists)
    expect(mockConfigStore.patchSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({ host: '127.0.0.1' }),
      })
    )
  })

  describe('resetFirewallCache and setFirewallConfiguring', () => {
    it('resets firewall cache so next getStatus re-detects', async () => {
      const { detectFirewall } = await import('../../../server/firewall.js')
      vi.mocked(detectFirewall).mockResolvedValue({ platform: 'linux-ufw', active: true })

      manager = new NetworkManager(server, mockConfigStore, testPort)
      const status1 = await manager.getStatus()
      expect(status1.firewall.platform).toBe('linux-ufw')

      // Change mock
      vi.mocked(detectFirewall).mockResolvedValue({ platform: 'linux-none', active: false })

      // Without reset, cached value is still used
      const status2 = await manager.getStatus()
      expect(status2.firewall.platform).toBe('linux-ufw')

      // After reset, re-detects
      manager.resetFirewallCache()
      const status3 = await manager.getStatus()
      expect(status3.firewall.platform).toBe('linux-none')
    })

    it('tracks firewall configuring state', async () => {
      manager = new NetworkManager(server, mockConfigStore, testPort)
      const status1 = await manager.getStatus()
      expect(status1.firewall.configuring).toBe(false)

      manager.setFirewallConfiguring(true)
      const status2 = await manager.getStatus()
      expect(status2.firewall.configuring).toBe(true)

      manager.setFirewallConfiguring(false)
      const status3 = await manager.getStatus()
      expect(status3.firewall.configuring).toBe(false)
    })
  })

  describe('configureFirewall', () => {
    it('returns commands for the detected platform', async () => {
      const { detectFirewall, firewallCommands } = await import('../../../server/firewall.js')
      vi.mocked(detectFirewall).mockResolvedValue({ platform: 'linux-ufw', active: true })
      vi.mocked(firewallCommands).mockReturnValue([`sudo ufw allow ${testPort}/tcp`])

      manager = new NetworkManager(server, mockConfigStore, testPort)
      const status = await manager.getStatus()
      expect(status.firewall.commands).toEqual([`sudo ufw allow ${testPort}/tcp`])
    })
  })

  describe('initializeFromStartup', () => {
    it('rebuilds ALLOWED_ORIGINS without persisting to config', async () => {
      manager = new NetworkManager(server, mockConfigStore, testPort)

      const network = {
        host: '127.0.0.1' as const,
        configured: false,
      }

      await manager.initializeFromStartup('0.0.0.0', network)

      // Should NOT have called patchSettings — config.json untouched
      expect(mockConfigStore.patchSettings).not.toHaveBeenCalled()
    })

  })

  describe('buildAllowedOrigins (via rebuildAllowedOrigins)', () => {
    it('includes only port-qualified loopback origins on localhost', async () => {
      manager = new NetworkManager(server, mockConfigStore, testPort)
      await manager.initializeFromStartup('127.0.0.1', {
        host: '127.0.0.1',
        configured: true,
      })

      const origins = process.env.ALLOWED_ORIGINS?.split(',') ?? []
      expect(origins).toContain(`http://localhost:${testPort}`)
      expect(origins).toContain(`http://127.0.0.1:${testPort}`)
      // Must NOT include portless origins (security: broadens trust surface)
      expect(origins).not.toContain('http://localhost')
      expect(origins).not.toContain('http://127.0.0.1')
    })

    it('includes LAN IP origins when bound to 0.0.0.0', async () => {
      mockConfigStore = createMockConfigStore({
        network: {
          host: '0.0.0.0',
          configured: true,
        },
      })
      manager = new NetworkManager(server, mockConfigStore, testPort)
      vi.mocked(detectLanIps).mockReturnValue(['192.168.1.100'])

      await manager.initializeFromStartup('0.0.0.0', {
        host: '0.0.0.0',
        configured: true,
      })

      const origins = process.env.ALLOWED_ORIGINS?.split(',') ?? []
      expect(origins).toContain(`http://192.168.1.100:${testPort}`)
      expect(origins).toContain(`http://localhost:${testPort}`)
    })

    it('preserves EXTRA_ALLOWED_ORIGINS across rebuilds', async () => {
      process.env.EXTRA_ALLOWED_ORIGINS = 'https://myproxy.com'
      manager = new NetworkManager(server, mockConfigStore, testPort)
      await manager.initializeFromStartup('127.0.0.1', {
        host: '127.0.0.1',
        configured: true,
      })

      const origins = process.env.ALLOWED_ORIGINS?.split(',') ?? []
      expect(origins).toContain('https://myproxy.com')
    })

    it('includes dev port origins when devPort is set', async () => {
      manager = new NetworkManager(server, mockConfigStore, testPort, true, 5173)
      await manager.initializeFromStartup('127.0.0.1', {
        host: '127.0.0.1',
        configured: true,
      })

      const origins = process.env.ALLOWED_ORIGINS?.split(',') ?? []
      expect(origins).toContain(`http://localhost:${testPort}`)
      expect(origins).toContain('http://localhost:5173')
      expect(origins).toContain('http://127.0.0.1:5173')
    })

    it('rebuilds origins on configure()', async () => {
      mockConfigStore = createMockConfigStore({
        network: {
          host: '127.0.0.1',
          configured: false,
        },
      })
      manager = new NetworkManager(server, mockConfigStore, testPort)
      vi.mocked(detectLanIps).mockReturnValue(['192.168.1.100'])

      // Initially localhost — no LAN origins
      await manager.initializeFromStartup('127.0.0.1', {
        host: '127.0.0.1',
        configured: false,
      })
      let origins = process.env.ALLOWED_ORIGINS?.split(',') ?? []
      expect(origins).not.toContain(`http://192.168.1.100:${testPort}`)

      // Configure to 0.0.0.0 — should add LAN origins
      await manager.configure({
        host: '0.0.0.0',
        configured: true,
      })
      origins = process.env.ALLOWED_ORIGINS?.split(',') ?? []
      expect(origins).toContain(`http://192.168.1.100:${testPort}`)
    })

    it('deduplicates origins', async () => {
      process.env.EXTRA_ALLOWED_ORIGINS = `http://localhost:${testPort}`
      manager = new NetworkManager(server, mockConfigStore, testPort)
      await manager.initializeFromStartup('127.0.0.1', {
        host: '127.0.0.1',
        configured: true,
      })

      const origins = process.env.ALLOWED_ORIGINS?.split(',') ?? []
      const localhostCount = origins.filter(o => o === `http://localhost:${testPort}`).length
      expect(localhostCount).toBe(1)
    })
  })
})
