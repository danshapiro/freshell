import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import { NetworkManager } from '../../../server/network-manager.js'

// Mock external dependencies
vi.mock('../../../server/bootstrap.js', () => ({
  detectLanIps: vi.fn().mockReturnValue(['192.168.1.100']),
}))
vi.mock('is-port-reachable', () => ({
  default: vi.fn().mockResolvedValue(true),
}))
vi.mock('bonjour-service', () => {
  const unpublishAll = vi.fn()
  const publish = vi.fn().mockReturnValue({ name: 'freshell' })
  const destroy = vi.fn()
  return {
    default: vi.fn().mockImplementation(() => ({ publish, unpublishAll, destroy })),
    Bonjour: vi.fn().mockImplementation(() => ({ publish, unpublishAll, destroy })),
  }
})
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
      mdns: { enabled: false, hostname: 'freshell' },
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

  beforeEach(() => {
    server = http.createServer()
    mockConfigStore = createMockConfigStore()
  })

  afterEach(async () => {
    if (manager) await manager.stop()
    if (server.listening) server.close()
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
      mdns: { enabled: false, hostname: 'freshell' },
    })

    // configure() schedules rebind via setImmediate, does NOT block
    expect(result.rebindScheduled).toBe(true)
    expect(mockConfigStore.patchSettings).toHaveBeenCalledWith({
      network: {
        host: '0.0.0.0',
        configured: true,
        mdns: { enabled: false, hostname: 'freshell' },
      },
    })
  })

  it('does not schedule rebind when host unchanged', async () => {
    manager = new NetworkManager(server, mockConfigStore, 0)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    const result = await manager.configure({
      host: '127.0.0.1',
      configured: true,
      mdns: { enabled: false, hostname: 'freshell' },
    })

    expect(result.rebindScheduled).toBe(false)
  })

  it('starts mDNS when enabled', async () => {
    const { Bonjour } = await import('bonjour-service')
    manager = new NetworkManager(server, mockConfigStore, 0)
    await manager.configure({
      host: '0.0.0.0',
      configured: true,
      mdns: { enabled: true, hostname: 'mybox' },
    })
    expect(Bonjour).toHaveBeenCalled()
  })

  it('builds correct accessUrl with token and port', async () => {
    process.env.AUTH_TOKEN = 'test-token-1234567890'
    mockConfigStore = createMockConfigStore({
      network: {
        host: '0.0.0.0',
        configured: true,
        mdns: { enabled: false, hostname: 'freshell' },
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
      mdns: { enabled: false, hostname: 'freshell' },
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
      mdns: { enabled: false, hostname: 'freshell' },
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
      mdns: { enabled: false, hostname: 'freshell' },
    })

    // Wait for setImmediate to fire so rebind() is in progress
    await new Promise<void>((resolve) => setImmediate(resolve))

    // First rebind is now in progress. Queue a second one (back to localhost).
    await manager.configure({
      host: '127.0.0.1',
      configured: true,
      mdns: { enabled: false, hostname: 'freshell' },
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
        mdns: { enabled: false, hostname: 'freshell' },
      }

      await manager.initializeFromStartup('0.0.0.0', network)

      // Should NOT have called patchSettings — config.json untouched
      expect(mockConfigStore.patchSettings).not.toHaveBeenCalled()
    })

    it('starts mDNS when remote access is enabled', async () => {
      // Config store must reflect the same state that initializeFromStartup sees
      mockConfigStore = createMockConfigStore({
        network: {
          host: '0.0.0.0',
          configured: true,
          mdns: { enabled: true, hostname: 'mybox' },
        },
      })
      manager = new NetworkManager(server, mockConfigStore, testPort)

      await manager.initializeFromStartup('0.0.0.0', {
        host: '0.0.0.0',
        configured: true,
        mdns: { enabled: true, hostname: 'mybox' },
      })

      const status = await manager.getStatus()
      expect(status.mdns).toEqual({ enabled: true, hostname: 'mybox' })
    })

    it('does not start mDNS when bound to localhost', async () => {
      mockConfigStore = createMockConfigStore({
        network: {
          host: '127.0.0.1',
          configured: true,
          mdns: { enabled: true, hostname: 'mybox' },
        },
      })
      manager = new NetworkManager(server, mockConfigStore, testPort)

      await manager.initializeFromStartup('127.0.0.1', {
        host: '127.0.0.1',
        configured: true,
        mdns: { enabled: true, hostname: 'mybox' },
      })

      const status = await manager.getStatus()
      expect(status.mdns).toBeNull()
    })
  })
})
