import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import {
  NetworkManager,
  persistManagedWindowsRemoteAccessPortsForServer,
} from '../../../server/network-manager.js'
import { detectLanIps } from '../../../server/bootstrap.js'
import { detectFirewall, firewallCommands } from '../../../server/firewall.js'
import { computeWslPortForwardingPlanAsync } from '../../../server/wsl-port-forward.js'

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
vi.mock('../../../server/wsl-port-forward.js', () => ({
  computeWslPortForwardingPlanAsync: vi.fn().mockResolvedValue({ status: 'noop', wslIp: '172.30.149.249' }),
}))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, execFile: vi.fn() }
})

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
  let savedFreshellHome: string | undefined
  let savedHost: string | undefined
  let tmpDir: string

  beforeEach(() => {
    server = http.createServer()
    mockConfigStore = createMockConfigStore()
    savedAllowedOrigins = process.env.ALLOWED_ORIGINS
    savedExtraAllowedOrigins = process.env.EXTRA_ALLOWED_ORIGINS
    savedAuthToken = process.env.AUTH_TOKEN
    savedFreshellHome = process.env.FRESHELL_HOME
    savedHost = process.env.HOST
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-windows-managed-'))
    delete process.env.ALLOWED_ORIGINS
    delete process.env.EXTRA_ALLOWED_ORIGINS
    delete process.env.HOST
    process.env.FRESHELL_HOME = tmpDir
    vi.mocked(detectFirewall).mockResolvedValue({ platform: 'linux-none', active: false })
    vi.mocked(computeWslPortForwardingPlanAsync).mockReset()
    vi.mocked(computeWslPortForwardingPlanAsync).mockResolvedValue({ status: 'noop', wslIp: '172.30.149.249' })
    vi.mocked(execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
      cb?.(Object.assign(new Error('rule not found'), { code: 1 }), '', '')
      return {} as any
    })
  })

  afterEach(async () => {
    if (manager) await manager.stop()
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    }
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
    if (savedFreshellHome !== undefined) {
      process.env.FRESHELL_HOME = savedFreshellHome
    } else {
      delete process.env.FRESHELL_HOME
    }
    if (savedHost !== undefined) {
      process.env.HOST = savedHost
    } else {
      delete process.env.HOST
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
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

  it('reports WSL remote access intent separately from the effective bind host', async () => {
    const firewallModule = await import('../../../server/firewall.js')
    const portReachable = await import('is-port-reachable')
    vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
      platform: 'wsl2',
      active: true,
    })
    vi.mocked(portReachable.default).mockResolvedValue(false)
    mockConfigStore = createMockConfigStore({
      network: {
        host: '127.0.0.1',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, 0)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))

    const status = await manager.getStatus()

    expect(status.host).toBe('0.0.0.0')
    expect(status.remoteAccessEnabled).toBe(false)
    expect((status as any).remoteAccessRequested).toBe(false)
  })

  it('reports requested-but-unrepaired WSL remote access as local-only with a repairable intent', async () => {
    const firewallModule = await import('../../../server/firewall.js')
    const portReachable = await import('is-port-reachable')
    vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
      platform: 'wsl2',
      active: true,
    })
    vi.mocked(portReachable.default).mockResolvedValue(false)
    mockConfigStore = createMockConfigStore({
      network: {
        host: '0.0.0.0',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, 0)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))

    const status = await manager.getStatus()

    expect(status.host).toBe('0.0.0.0')
    expect(status.remoteAccessEnabled).toBe(false)
    expect((status as any).remoteAccessRequested).toBe(true)
    expect((status as any).remoteAccessNeedsRepair).toBe(true)
    expect(status.accessUrl).toContain('localhost')
    expect(status.accessUrl).not.toContain('192.168.1.100')
  })

  it('keeps the LAN share URL when WSL reachability checks fail but remote access is still requested', async () => {
    const firewallModule = await import('../../../server/firewall.js')
    const portReachable = await import('is-port-reachable')
    vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
      platform: 'wsl2',
      active: true,
    })
    vi.mocked(portReachable.default).mockRejectedValue(new Error('probe failed'))
    mockConfigStore = createMockConfigStore({
      network: {
        host: '0.0.0.0',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, testPort)
    await new Promise<void>((resolve) => server.listen(testPort, '0.0.0.0', resolve))

    const status = await manager.getStatus()

    expect(status.host).toBe('0.0.0.0')
    expect(status.remoteAccessEnabled).toBe(false)
    expect((status as any).remoteAccessRequested).toBe(true)
    expect(status.firewall.portOpen).toBeNull()
    expect(status.accessUrl).toContain('192.168.1.100')
    expect(status.accessUrl).not.toContain('localhost')
  })

  it('reports stale WSL LAN exposure as still remotely accessible until teardown completes', async () => {
    const firewallModule = await import('../../../server/firewall.js')
    const portReachable = await import('is-port-reachable')
    vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
      platform: 'wsl2',
      active: true,
    })
    vi.mocked(portReachable.default).mockResolvedValue(true)
    mockConfigStore = createMockConfigStore({
      network: {
        host: '127.0.0.1',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, testPort)
    await new Promise<void>((resolve) => server.listen(testPort, '0.0.0.0', resolve))

    const status = await manager.getStatus()

    expect(status.host).toBe('0.0.0.0')
    expect(status.remoteAccessEnabled).toBe(true)
    expect((status as any).remoteAccessRequested).toBe(false)
    expect(status.accessUrl).toContain('192.168.1.100')
    expect(status.accessUrl).not.toContain('localhost')
  })

  it('reports blocked native Windows remote access as needing repair instead of disabled setup', async () => {
    const firewallModule = await import('../../../server/firewall.js')
    const portReachable = await import('is-port-reachable')
    vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
      platform: 'windows',
      active: true,
    })
    vi.mocked(portReachable.default).mockResolvedValue(false)
    mockConfigStore = createMockConfigStore({
      network: {
        host: '0.0.0.0',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, testPort)
    await new Promise<void>((resolve) => server.listen(testPort, '0.0.0.0', resolve))

    const status = await manager.getStatus()

    expect(status.host).toBe('0.0.0.0')
    expect(status.remoteAccessEnabled).toBe(false)
    expect((status as any).remoteAccessRequested).toBe(true)
    expect((status as any).remoteAccessNeedsRepair).toBe(true)
    expect(status.firewall.portOpen).toBe(false)
    expect(status.accessUrl).toContain('localhost')
    expect(status.accessUrl).not.toContain('192.168.1.100')
  })

  it('does not hot rebind WSL when only the saved remote-access intent changes', async () => {
    const firewallModule = await import('../../../server/firewall.js')
    vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
      platform: 'wsl2',
      active: true,
    })
    mockConfigStore = createMockConfigStore({
      network: {
        host: '0.0.0.0',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, 0)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))

    const result = await manager.configure({
      host: '127.0.0.1',
      configured: true,
    })

    expect(result.rebindScheduled).toBe(false)
    expect(mockConfigStore.patchSettings).toHaveBeenCalledWith({
      network: {
        host: '127.0.0.1',
        configured: true,
      },
    })

    const addr = server.address()
    expect(addr && typeof addr === 'object' ? addr.address : null).toBe('0.0.0.0')
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
    const portReachable = await import('is-port-reachable')
    vi.mocked(portReachable.default).mockResolvedValue(true)
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

  it('treats dev mode remote access as healthy when the advertised Vite port is reachable', async () => {
    const firewallModule = await import('../../../server/firewall.js')
    const portReachable = await import('is-port-reachable')
    vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
      platform: 'windows',
      active: true,
    })
    vi.mocked(firewallCommands).mockClear()
    vi.mocked(portReachable.default).mockClear()
    vi.mocked(portReachable.default).mockImplementation(async (port) => port === 5173)
    mockConfigStore = createMockConfigStore({
      network: {
        host: '0.0.0.0',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, 9876, true, 5173)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))

    const status = await manager.getStatus()

    expect(status.firewall.portOpen).toBe(true)
    const probedPorts = vi.mocked(portReachable.default).mock.calls.map(([port]) => port)
    expect(probedPorts).toEqual([5173])
    expect(vi.mocked(firewallCommands)).toHaveBeenCalledWith('windows', [5173])
  })

  it('flags stale dev-mode WSL exposure for cleanup while keeping the LAN URL active', async () => {
    const firewallModule = await import('../../../server/firewall.js')
    const portReachable = await import('is-port-reachable')
    const wslPortForward = await import('../../../server/wsl-port-forward.js')
    vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
      platform: 'wsl2',
      active: true,
    })
    vi.mocked(portReachable.default).mockImplementation(async (port) => port === 5173)
    vi.mocked(wslPortForward.computeWslPortForwardingPlanAsync).mockResolvedValue({
      status: 'ready',
      wslIp: '172.30.149.249',
      scriptKind: 'full',
      script: '$null # mock script',
    })
    mockConfigStore = createMockConfigStore({
      network: {
        host: '0.0.0.0',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, 9876, true, 5173)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))

    const status = await manager.getStatus()

    expect(status.remoteAccessEnabled).toBe(true)
    expect((status as any).remoteAccessNeedsRepair).toBe(true)
    expect(status.accessUrl).toContain('192.168.1.100:5173')
    expect(status.firewall.portOpen).toBe(false)
  })

  it('keeps remote access enabled while flagging stale native Windows dev-mode API-port rules for cleanup', async () => {
    const firewallModule = await import('../../../server/firewall.js')
    const portReachable = await import('is-port-reachable')
    vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
      platform: 'windows',
      active: true,
    })
    vi.mocked(portReachable.default).mockImplementation(async (port) => port === 5173)
    await persistManagedWindowsRemoteAccessPortsForServer(9876, [9876])
    vi.mocked(execFile).mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      const ruleNameArg = args.at(-1)
      if (ruleNameArg === 'name=Freshell (port 9876)') {
        cb?.(null, 'Rule Name: Freshell (port 9876)\n', '')
        return {} as any
      }
      cb?.(Object.assign(new Error('rule not found'), { code: 1 }), '', '')
      return {} as any
    })
    mockConfigStore = createMockConfigStore({
      network: {
        host: '0.0.0.0',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, 9876, true, 5173)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))

    const status = await manager.getStatus()

    expect(status.remoteAccessEnabled).toBe(true)
    expect((status as any).remoteAccessRequested).toBe(true)
    expect((status as any).remoteAccessNeedsRepair).toBe(true)
    expect(status.accessUrl).toContain('192.168.1.100:5173')
    expect(status.accessUrl).not.toContain('localhost')
    expect(status.firewall.portOpen).toBe(false)
    expect(status.firewall.commands).toContain(
      'netsh advfirewall firewall delete rule name="Freshell (port 9876)" 2>$null',
    )
    expect(status.firewall.commands).toContain(
      'netsh advfirewall firewall add rule name="Freshell (port 5173)" dir=in action=allow protocol=TCP localport=5173 profile=private',
    )
    expect(status.firewall.commands).not.toContain(
      'netsh advfirewall firewall add rule name="Freshell (port 9876)" dir=in action=allow protocol=TCP localport=9876 profile=private',
    )
  })

  it('builds cleanup commands for stale native Windows dev-mode API-port rules while reopening the advertised Vite port', async () => {
    const firewallModule = await import('../../../server/firewall.js')
    const portReachable = await import('is-port-reachable')
    vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
      platform: 'windows',
      active: true,
    })
    vi.mocked(portReachable.default).mockResolvedValue(false)
    await persistManagedWindowsRemoteAccessPortsForServer(9876, [9876])
    vi.mocked(execFile).mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      const ruleNameArg = args.at(-1)
      if (ruleNameArg === 'name=Freshell (port 9876)') {
        cb?.(null, 'Rule Name: Freshell (port 9876)\n', '')
        return {} as any
      }
      cb?.(Object.assign(new Error('rule not found'), { code: 1 }), '', '')
      return {} as any
    })
    mockConfigStore = createMockConfigStore({
      network: {
        host: '0.0.0.0',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, 9876, true, 5173)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))

    const status = await manager.getStatus()

    expect(status.remoteAccessEnabled).toBe(false)
    expect((status as any).remoteAccessRequested).toBe(true)
    expect(status.firewall.portOpen).toBe(false)
    expect(status.firewall.commands).toContain(
      'netsh advfirewall firewall delete rule name="Freshell (port 9876)" 2>$null',
    )
    expect(status.firewall.commands).toContain(
      'netsh advfirewall firewall add rule name="Freshell (port 5173)" dir=in action=allow protocol=TCP localport=5173 profile=private',
    )
    expect(status.firewall.commands).not.toContain(
      'netsh advfirewall firewall add rule name="Freshell (port 9876)" dir=in action=allow protocol=TCP localport=9876 profile=private',
    )
  })

  it('flags stale native Windows rules outside the current relevant ports for cleanup', async () => {
    const firewallModule = await import('../../../server/firewall.js')
    const portReachable = await import('is-port-reachable')
    vi.mocked(firewallModule.detectFirewall).mockResolvedValue({
      platform: 'windows',
      active: true,
    })
    vi.mocked(portReachable.default).mockImplementation(async (port) => port === 5173)
    await persistManagedWindowsRemoteAccessPortsForServer(9876, [4321])
    vi.mocked(execFile).mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
      const ruleNameArg = args.at(-1)
      if (ruleNameArg === 'name=Freshell (port 4321)') {
        cb?.(null, [
          'Rule Name: Freshell (port 4321)',
          'Rule Name: Some Other App',
        ].join('\n'), '')
        return {} as any
      }
      cb?.(Object.assign(new Error('rule not found'), { code: 1 }), '', '')
      return {} as any
    })
    mockConfigStore = createMockConfigStore({
      network: {
        host: '0.0.0.0',
        configured: true,
      },
    })
    manager = new NetworkManager(server, mockConfigStore, 9876, true, 5173)
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))

    const status = await manager.getStatus()

    expect(status.remoteAccessEnabled).toBe(true)
    expect((status as any).remoteAccessRequested).toBe(true)
    expect((status as any).remoteAccessNeedsRepair).toBe(true)
    expect(status.accessUrl).toContain('192.168.1.100:5173')
    expect(status.firewall.portOpen).toBe(false)
    expect(status.firewall.commands).toContain(
      'netsh advfirewall firewall delete rule name="Freshell (port 4321)" 2>$null',
    )
    expect(status.firewall.commands).not.toContain(
      'netsh advfirewall firewall add rule name="Freshell (port 4321)" dir=in action=allow protocol=TCP localport=4321 profile=private',
    )
    expect(status.firewall.commands).toContain(
      'netsh advfirewall firewall add rule name="Freshell (port 5173)" dir=in action=allow protocol=TCP localport=5173 profile=private',
    )
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
