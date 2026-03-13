// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import request from 'supertest'
import isPortReachable from 'is-port-reachable'
import { NetworkManager } from '../../../server/network-manager.js'
import { createLocalFileRouter } from '../../../server/local-file-router.js'
import { createNetworkRouter } from '../../../server/network-router.js'
import { ConfigStore } from '../../../server/config-store.js'
import { httpAuthMiddleware } from '../../../server/auth.js'
import { detectFirewall } from '../../../server/firewall.js'
import * as wslModule from '../../../server/wsl-port-forward.js'

// Mock firewall detection to avoid real system calls
vi.mock('../../../server/firewall.js', async () => {
  const actual = await vi.importActual<typeof import('../../../server/firewall.js')>('../../../server/firewall.js')
  return { ...actual, detectFirewall: vi.fn().mockResolvedValue({ platform: 'linux-none', active: false }) }
})
vi.mock('../../../server/bootstrap.js', () => ({
  detectLanIps: vi.fn().mockReturnValue(['192.168.1.100']),
}))
vi.mock('is-port-reachable', () => ({
  default: vi.fn().mockResolvedValue(false),
}))
vi.mock('../../../server/wsl-port-forward.js', () => ({
  computeWslPortForwardingPlan: vi.fn().mockReturnValue({
    status: 'ready',
    wslIp: '172.24.0.2',
    scriptKind: 'full',
    script: '$null # mock script',
  }),
  computeWslPortForwardingPlanAsync: vi.fn().mockResolvedValue({
    status: 'ready',
    wslIp: '172.24.0.2',
    scriptKind: 'full',
    script: '$null # mock script',
  }),
  computeWslPortForwardingTeardownPlan: vi.fn().mockReturnValue({
    status: 'ready',
    script: '$null # mock teardown script',
  }),
  computeWslPortForwardingTeardownPlanAsync: vi.fn().mockResolvedValue({
    status: 'ready',
    script: '$null # mock teardown script',
  }),
}))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, execFile: vi.fn() }
})

function expectConfirmationRequired(body: any) {
  expect(body).toMatchObject({
    method: 'confirmation-required',
    title: 'Administrator approval required',
    body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
    confirmLabel: 'Continue',
  })
  expect(body.confirmationToken).toEqual(expect.any(String))
}

describe('Network API integration', () => {
  const token = 'test-token-for-network-api'
  let app: express.Express
  let server: http.Server
  let tmpDir: string
  let configStore: ConfigStore
  let networkManager: NetworkManager

  beforeAll(() => {
    process.env.AUTH_TOKEN = token
  })

  afterAll(() => {
    delete process.env.AUTH_TOKEN
  })

  beforeEach(async () => {
    const cp = await import('node:child_process')
    vi.mocked(cp.execFile).mockReset()
    vi.mocked(detectFirewall).mockReset()
    vi.mocked(isPortReachable).mockReset()
    vi.mocked(wslModule.computeWslPortForwardingPlan).mockReset()
    vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockReset()
    vi.mocked(wslModule.computeWslPortForwardingTeardownPlan).mockReset()
    vi.mocked(wslModule.computeWslPortForwardingTeardownPlanAsync).mockReset()
    delete process.env.HOST
    vi.mocked(detectFirewall).mockResolvedValue({ platform: 'linux-none', active: false })
    vi.mocked(isPortReachable).mockResolvedValue(false)
    vi.mocked(wslModule.computeWslPortForwardingPlan).mockReturnValue({
      status: 'ready',
      wslIp: '172.24.0.2',
      scriptKind: 'full',
      script: '$null # mock script',
    })
    vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockResolvedValue({
      status: 'ready',
      wslIp: '172.24.0.2',
      scriptKind: 'full',
      script: '$null # mock script',
    })
    vi.mocked(wslModule.computeWslPortForwardingTeardownPlan).mockReturnValue({
      status: 'ready',
      script: '$null # mock teardown script',
    })
    vi.mocked(wslModule.computeWslPortForwardingTeardownPlanAsync).mockResolvedValue({
      status: 'ready',
      script: '$null # mock teardown script',
    })
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-test-'))
    process.env.FRESHELL_HOME = tmpDir

    configStore = new ConfigStore()
    server = http.createServer()
    networkManager = new NetworkManager(server, configStore, 0)

    app = express()
    app.use(express.json())
    app.use('/api', httpAuthMiddleware)

    // Mount the network router
    app.use('/api', createNetworkRouter({
      networkManager,
      configStore,
      wsHandler: { broadcast: vi.fn() },
      detectLanIps: () => ['192.168.1.100'],
    }))

    // Mount the real local-file router
    app.use('/local-file', createLocalFileRouter())

    await configStore.patchSettings({
      network: {
        configured: true,
        host: '0.0.0.0',
      },
    })
  })

  afterEach(async () => {
    await networkManager.stop()
    if (server.listening) server.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
    delete process.env.FRESHELL_HOME
    delete process.env.HOST
  })

  describe('GET /api/network/status', () => {
    it('returns network status with expected shape', async () => {
      const res = await request(app)
        .get('/api/network/status')
        .set('x-auth-token', token)
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('configured')
      expect(res.body).toHaveProperty('host')
      expect(res.body).toHaveProperty('port')
      expect(res.body).toHaveProperty('lanIps')
      expect(res.body).toHaveProperty('firewall')
      expect(res.body).toHaveProperty('devMode')
      expect(res.body).toHaveProperty('accessUrl')
    })

    it('requires authentication', async () => {
      const res = await request(app).get('/api/network/status')
      expect(res.status).toBe(401)
    })
  })

  describe('POST /api/network/configure', () => {
    it('accepts valid network configuration', async () => {
      const res = await request(app)
        .post('/api/network/configure')
        .set('x-auth-token', token)
        .send({
          host: '0.0.0.0',
          configured: true,
        })
      expect(res.status).toBe(200)

      const configPath = path.join(tmpDir, '.freshell', 'config.json')
      const saved = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { settings?: { network?: { host?: string } } }
      expect(saved.settings?.network?.host).toBe('0.0.0.0')
    })

    it('rejects invalid host values', async () => {
      const res = await request(app)
        .post('/api/network/configure')
        .set('x-auth-token', token)
        .send({
          host: '10.0.0.1',
          configured: true,
        })
      expect(res.status).toBe(400)
    })

    it('keeps WSL bound to 0.0.0.0 when disabling remote access intent', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))

      const res = await request(app)
        .post('/api/network/configure')
        .set('x-auth-token', token)
        .send({
          host: '127.0.0.1',
          configured: true,
        })

      expect(res.status).toBe(200)
      expect(res.body.rebindScheduled).toBe(false)
      expect(res.body.host).toBe('0.0.0.0')
      expect(res.body.remoteAccessEnabled).toBe(false)

      const settings = await configStore.getSettings()
      expect(settings.network).toEqual(expect.objectContaining({
        host: '127.0.0.1',
        configured: true,
      }))

      const addr = server.address()
      expect(addr && typeof addr === 'object' ? addr.address : null).toBe('0.0.0.0')
    })

    it('keeps Windows firewall repair available in dev mode when only the Vite port is reachable', async () => {
      const devConfigStore = new ConfigStore()
      const devServer = http.createServer()
      const devNetworkManager = new NetworkManager(devServer, devConfigStore, 3001, true, 5173)
      const devApp = express()
      devApp.use(express.json())
      devApp.use('/api', httpAuthMiddleware)
      devApp.use('/api', createNetworkRouter({
        networkManager: devNetworkManager,
        configStore: devConfigStore,
        wsHandler: { broadcast: vi.fn() },
        detectLanIps: () => ['192.168.1.100'],
      }))

      await devConfigStore.patchSettings({
        network: {
          configured: true,
          host: '0.0.0.0',
        },
      })
      await new Promise<void>((resolve) => devServer.listen(0, '0.0.0.0', resolve))

      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'windows',
        active: true,
      })
      vi.mocked(isPortReachable).mockImplementation(async (port) => port === 5173)
      devNetworkManager.resetFirewallCache()

      try {
        const res = await request(devApp)
          .post('/api/network/configure-firewall')
          .set('x-auth-token', token)
          .send({})

        expect(res.status).toBe(200)
        expectConfirmationRequired(res.body)
      } finally {
        await devNetworkManager.stop()
        await new Promise<void>((resolve, reject) => {
          devServer.close((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      }
    })
  })

  describe('/local-file auth', () => {
    it('rejects requests without cookie or header', async () => {
      const res = await request(app).get('/local-file?path=/tmp/test-file.txt')
      expect(res.status).toBe(401)
    })

    it('accepts requests with valid cookie', async () => {
      const testFile = path.join(tmpDir, 'test-file.txt')
      fs.writeFileSync(testFile, 'hello')
      const res = await request(app)
        .get(`/local-file?path=${encodeURIComponent(testFile)}`)
        .set('Cookie', `freshell-auth=${token}`)
      expect(res.status).toBe(200)
    })

    it('accepts requests with valid header', async () => {
      const testFile = path.join(tmpDir, 'test-file.txt')
      fs.writeFileSync(testFile, 'hello')
      const res = await request(app)
        .get(`/local-file?path=${encodeURIComponent(testFile)}`)
        .set('x-auth-token', token)
      expect(res.status).toBe(200)
    })

    it('rejects requests with wrong cookie', async () => {
      const res = await request(app)
        .get('/local-file?path=/tmp/test-file.txt')
        .set('Cookie', 'freshell-auth=wrong-token-value')
      expect(res.status).toBe(401)
    })
  })

  describe('POST /api/network/configure-firewall', () => {
    it('requires auth', async () => {
      const res = await request(app)
        .post('/api/network/configure-firewall')
      expect(res.status).toBe(401)
    })

    it('returns method: none when no firewall detected', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'linux-none',
        active: false,
      })
      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
      expect(res.status).toBe(200)
      expect(res.body.method).toBe('none')
    })

    it('returns terminal commands for linux-ufw platform', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'linux-ufw',
        active: true,
      })
      // Need to clear the cached firewall info so it re-detects
      networkManager.resetFirewallCache()
      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
      expect(res.status).toBe(200)
      expect(res.body.method).toBe('terminal')
      expect(res.body.command).toContain('ufw allow')
    })

    it('returns terminal commands for macos without requiring confirmation', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'macos',
        active: true,
      })
      networkManager.resetFirewallCache()

      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)

      expect(res.status).toBe(200)
      expect(res.body.method).toBe('terminal')
      expect(res.body.command).toContain('socketfilterfw')
    })

    it('returns confirmation-required for WSL2 until the caller confirms elevation', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable).mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockResolvedValue({
        status: 'ready',
        wslIp: '172.24.0.2',
        scriptKind: 'full',
        script: '$null # mock script',
      })
      const cp = await import('node:child_process')

      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)

      expect(res.status).toBe(200)
      expectConfirmationRequired(res.body)
      expect(wslModule.computeWslPortForwardingPlanAsync).toHaveBeenCalledTimes(1)
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('re-prompts for WSL2 when the first call sends confirmElevation without a server token', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable).mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockResolvedValue({
        status: 'ready',
        wslIp: '172.24.0.2',
        scriptKind: 'full',
        script: '$null # mock script',
      })

      const cp = await import('node:child_process')
      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({ confirmElevation: true })

      expect(res.status).toBe(200)
      expectConfirmationRequired(res.body)
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('returns none for WSL2 on the first click when the recomputed plan is already noop', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable).mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockResolvedValue({
        status: 'noop',
        wslIp: '172.24.0.2',
      })
      const cp = await import('node:child_process')

      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'none', message: 'No configuration changes required' })
      expect(wslModule.computeWslPortForwardingPlanAsync).toHaveBeenCalledTimes(1)
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('consumes the WSL2 confirmation token when the confirmed retry recomputes to noop', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlanAsync)
        .mockResolvedValueOnce({
          status: 'ready',
          wslIp: '172.24.0.2',
          scriptKind: 'full',
          script: '$null # mock script',
        })
        .mockResolvedValueOnce({
          status: 'noop',
          wslIp: '172.24.0.2',
        })
        .mockResolvedValueOnce({
          status: 'ready',
          wslIp: '172.24.0.2',
          scriptKind: 'full',
          script: '$null # mock script',
        })

      const cp = await import('node:child_process')
      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(firstRes.status).toBe(200)
      expect(firstRes.body.method).toBe('confirmation-required')

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(confirmedRes.status).toBe(200)
      expect(confirmedRes.body).toEqual({ method: 'none', message: 'No configuration changes required' })
      expect(wslModule.computeWslPortForwardingPlanAsync).toHaveBeenCalledTimes(2)
      expect(cp.execFile).not.toHaveBeenCalled()

      const replayRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(replayRes.status).toBe(200)
      expectConfirmationRequired(replayRes.body)
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('starts WSL2 repair only after a confirmed retry with the issued token', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockResolvedValue({
        status: 'ready',
        wslIp: '172.24.0.2',
        scriptKind: 'full',
        script: '$null # mock script',
      })

      const cp = await import('node:child_process')
      vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, _cb: any) => {
        return { on: vi.fn() } as any
      })

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(firstRes.status).toBe(200)
      expectConfirmationRequired(firstRes.body)

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(confirmedRes.status).toBe(200)
      expect(confirmedRes.body).toEqual({ method: 'wsl2', status: 'started' })

      networkManager.setFirewallConfiguring(false)
    })

    it('consumes the WSL2 confirmation token when remote access is disabled before confirmed repair', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockResolvedValue({
        status: 'ready',
        wslIp: '172.24.0.2',
        scriptKind: 'full',
        script: '$null # mock script',
      })

      const cp = await import('node:child_process')

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(firstRes.status).toBe(200)
      expect(firstRes.body.method).toBe('confirmation-required')

      await configStore.patchSettings({
        network: {
          configured: true,
          host: '127.0.0.1',
        },
      })

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(confirmedRes.status).toBe(200)
      expect(confirmedRes.body).toEqual({ method: 'none', message: 'Remote access is not enabled' })
      expect(wslModule.computeWslPortForwardingPlanAsync).toHaveBeenCalledTimes(1)
      expect(cp.execFile).not.toHaveBeenCalled()

      await configStore.patchSettings({
        network: {
          configured: true,
          host: '0.0.0.0',
        },
      })

      const replayRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(replayRes.status).toBe(200)
      expectConfirmationRequired(replayRes.body)
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('returns none for local-only WSL2 before remote access is explicitly enabled', async () => {
      process.env.HOST = '0.0.0.0'
      await configStore.patchSettings({
        network: {
          configured: false,
          host: '127.0.0.1',
        },
      })

      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable).mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      const cp = await import('node:child_process')

      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'none', message: 'Remote access is not enabled' })
      expect(wslModule.computeWslPortForwardingPlanAsync).not.toHaveBeenCalled()
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('returns the concrete WSL planning error before confirmation', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockResolvedValue({
        status: 'error',
        message: 'Failed to detect WSL2 IP address',
      })

      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(res.status).toBe(500)
      expect(res.body).toEqual({ error: 'Failed to detect WSL2 IP address' })
    })

    it('returns the concrete WSL planning error after confirmation', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlanAsync)
        .mockResolvedValueOnce({
          status: 'ready',
          wslIp: '172.24.0.2',
          scriptKind: 'full',
          script: '$null # mock script',
        })
        .mockResolvedValueOnce({
          status: 'error',
          message: 'Failed to detect WSL2 IP address',
        })

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(firstRes.status).toBe(200)
      expectConfirmationRequired(firstRes.body)

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(confirmedRes.status).toBe(500)
      expect(confirmedRes.body).toEqual({ error: 'Failed to detect WSL2 IP address' })
    })

    it('returns confirmation-required for native Windows until the caller confirms elevation', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'windows',
        active: true,
      })
      networkManager.resetFirewallCache()

      const cp = await import('node:child_process')
      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(res.status).toBe(200)
      expectConfirmationRequired(res.body)
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('re-prompts for native Windows when the first call sends confirmElevation without a server token', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'windows',
        active: true,
      })
      networkManager.resetFirewallCache()

      const cp = await import('node:child_process')
      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({ confirmElevation: true })

      expect(res.status).toBe(200)
      expectConfirmationRequired(res.body)
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('returns none for native Windows when the port becomes reachable before confirmation', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'windows',
        active: true,
      })
      networkManager.resetFirewallCache()

      vi.mocked(isPortReachable)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)

      const cp = await import('node:child_process')

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(firstRes.status).toBe(200)
      expect(firstRes.body.method).toBe('confirmation-required')

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(confirmedRes.status).toBe(200)
      expect(confirmedRes.body).toEqual({ method: 'none', message: 'No configuration changes required' })
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('returns none when remote access is disabled before confirmed repair', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'windows',
        active: true,
      })
      networkManager.resetFirewallCache()

      const cp = await import('node:child_process')

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(firstRes.status).toBe(200)
      expect(firstRes.body.method).toBe('confirmation-required')

      await configStore.patchSettings({
        network: {
          configured: true,
          host: '127.0.0.1',
        },
      })

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(confirmedRes.status).toBe(200)
      expect(confirmedRes.body).toEqual({ method: 'none', message: 'Remote access is not enabled' })
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('returns none for inactive Windows firewall without prompting or elevating', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'windows',
        active: false,
      })
      networkManager.resetFirewallCache()

      const cp = await import('node:child_process')

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(firstRes.status).toBe(200)
      expect(firstRes.body).toEqual({ method: 'none', message: 'No firewall detected' })
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('starts native Windows repair only after a confirmed retry with the issued token', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'windows',
        active: true,
      })
      networkManager.resetFirewallCache()

      vi.mocked(isPortReachable)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)

      const cp = await import('node:child_process')
      vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, _cb: any) => {
        return { on: vi.fn() } as any
      })

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(firstRes.status).toBe(200)
      expectConfirmationRequired(firstRes.body)

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(confirmedRes.status).toBe(200)
      expect(confirmedRes.body).toEqual({ method: 'windows-elevated', status: 'started' })

      networkManager.setFirewallConfiguring(false)
    })

    it('re-prompts when a confirmation token is superseded', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'windows',
        active: true,
      })
      networkManager.resetFirewallCache()

      const cp = await import('node:child_process')

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      const secondRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expectConfirmationRequired(firstRes.body)
      expectConfirmationRequired(secondRes.body)

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(confirmedRes.status).toBe(200)
      expectConfirmationRequired(confirmedRes.body)
      expect(confirmedRes.body.confirmationToken).not.toBe(firstRes.body.confirmationToken)
      expect(confirmedRes.body.confirmationToken).not.toBe(secondRes.body.confirmationToken)
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('re-prompts when a confirmation token is replayed', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'windows',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)

      const cp = await import('node:child_process')
      vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb?.(null, '', '')
        return { on: vi.fn() } as any
      })

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expectConfirmationRequired(firstRes.body)

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(confirmedRes.status).toBe(200)
      expect(confirmedRes.body).toEqual({ method: 'windows-elevated', status: 'started' })

      networkManager.setFirewallConfiguring(false)

      const replayRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(replayRes.status).toBe(200)
      expectConfirmationRequired(replayRes.body)
    })

    it('revokes a confirmation token when the client cancels the approval modal', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'windows',
        active: true,
      })
      networkManager.resetFirewallCache()

      const cp = await import('node:child_process')

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expectConfirmationRequired(firstRes.body)

      const cancelRes = await request(app)
        .post('/api/network/cancel-firewall-confirmation')
        .set('x-auth-token', token)
        .send({ confirmationToken: firstRes.body.confirmationToken })

      expect(cancelRes.status).toBe(204)

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(confirmedRes.status).toBe(200)
      expectConfirmationRequired(confirmedRes.body)
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('re-prompts when a confirmation token is for the wrong platform', async () => {
      vi.mocked(detectFirewall)
        .mockResolvedValueOnce({
          platform: 'wsl2',
          active: true,
        })
        .mockResolvedValueOnce({
          platform: 'windows',
          active: true,
        })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockResolvedValue({
        status: 'ready',
        wslIp: '172.24.0.2',
        scriptKind: 'full',
        script: '$null # mock script',
      })

      const cp = await import('node:child_process')

      const wslRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expectConfirmationRequired(wslRes.body)

      networkManager.resetFirewallCache()

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: wslRes.body.confirmationToken,
        })

      expect(confirmedRes.status).toBe(200)
      expectConfirmationRequired(confirmedRes.body)
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('rejects malformed confirmation payloads', async () => {
      const confirmFalseRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({ confirmElevation: false })

      expect(confirmFalseRes.status).toBe(400)
      expect(confirmFalseRes.body.error).toBe('Invalid request')

      const badTokenRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({ confirmationToken: 7 })

      expect(badTokenRes.status).toBe(400)
      expect(badTokenRes.body.error).toBe('Invalid request')
    })

    it('returns 409 in-progress when two confirmed retries race for the same repair', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      let releasePlan!: () => void
      const planGate = new Promise<void>((resolve) => {
        releasePlan = resolve
      })
      let lockedRecomputeEntered!: () => void
      const lockedRecompute = new Promise<void>((resolve) => {
        lockedRecomputeEntered = resolve
      })

      vi.mocked(wslModule.computeWslPortForwardingPlanAsync)
        .mockResolvedValueOnce({
          status: 'ready',
          wslIp: '172.24.0.2',
          scriptKind: 'full',
          script: '$null # mock script',
        })
        .mockResolvedValueOnce({
          status: 'ready',
          wslIp: '172.24.0.2',
          scriptKind: 'full',
          script: '$null # mock script',
        })
        .mockImplementationOnce(async () => {
          lockedRecomputeEntered()
          await planGate
          return {
            status: 'ready',
            wslIp: '172.24.0.2',
            scriptKind: 'full',
            script: '$null # mock script',
          }
        })
        .mockResolvedValue({
          status: 'ready',
          wslIp: '172.24.0.2',
          scriptKind: 'full',
          script: '$null # mock script',
        })

      const cp = await import('node:child_process')
      vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        cb?.(null, '', '')
        return { on: vi.fn() } as any
      })

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expectConfirmationRequired(firstRes.body)

      const startedResPromise = request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })
        .then((res) => res)

      await lockedRecompute

      const inProgressRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(inProgressRes.status).toBe(409)
      expect(inProgressRes.body).toEqual({
        error: 'Firewall configuration already in progress',
        method: 'in-progress',
      })

      releasePlan()

      const startedRes = await startedResPromise
      expect(startedRes.status).toBe(200)
      expect(startedRes.body).toEqual({ method: 'wsl2', status: 'started' })

      networkManager.setFirewallConfiguring(false)
    })

    it('returns 409 in-progress for fresh and confirmed requests while a prior elevated repair is still running', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockResolvedValue({
        status: 'ready',
        wslIp: '172.24.0.2',
        scriptKind: 'full',
        script: '$null # mock script',
      })

      const cp = await import('node:child_process')
      let finishRepair: (() => void) | null = null
      vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        finishRepair = () => {
          cb?.(null, '', '')
        }
        return { on: vi.fn() } as any
      })

      const firstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expectConfirmationRequired(firstRes.body)

      const startedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(startedRes.status).toBe(200)
      expect(startedRes.body).toEqual({ method: 'wsl2', status: 'started' })

      const secondFirstRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(secondFirstRes.status).toBe(409)
      expect(secondFirstRes.body).toEqual({
        error: 'Firewall configuration already in progress',
        method: 'in-progress',
      })

      const confirmedRetryRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(confirmedRetryRes.status).toBe(409)
      expect(confirmedRetryRes.body).toEqual({
        error: 'Firewall configuration already in progress',
        method: 'in-progress',
      })

      finishRepair?.()
      networkManager.setFirewallConfiguring(false)
    })
  })

  describe('POST /api/network/disable-remote-access', () => {
    it('returns confirmation-required for WSL disable while Windows exposure is still active', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
      vi.mocked(isPortReachable).mockResolvedValue(true)

      const cp = await import('node:child_process')
      vi.mocked(wslModule.computeWslPortForwardingTeardownPlanAsync).mockResolvedValue({
        status: 'ready',
        script: '$null # mock teardown script',
      })

      const res = await request(app)
        .post('/api/network/disable-remote-access')
        .set('x-auth-token', token)
        .send({})

      expect(res.status).toBe(200)
      expectConfirmationRequired(res.body)
      expect(cp.execFile).not.toHaveBeenCalled()

      const settings = await configStore.getSettings()
      expect(settings.network).toEqual(expect.objectContaining({
        configured: true,
        host: '0.0.0.0',
      }))
    })

    it('disables WSL remote access immediately when no privileged teardown is needed', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(wslModule.computeWslPortForwardingTeardownPlanAsync).mockResolvedValue({
        status: 'noop',
      })

      const cp = await import('node:child_process')
      const res = await request(app)
        .post('/api/network/disable-remote-access')
        .set('x-auth-token', token)
        .send({})

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'none', message: 'Remote access disabled' })
      expect(cp.execFile).not.toHaveBeenCalled()

      const settings = await configStore.getSettings()
      expect(settings.network).toEqual(expect.objectContaining({
        configured: true,
        host: '127.0.0.1',
      }))
    })

    it('starts confirmed WSL disable and stops advertising a LAN URL after teardown completes', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
      vi.mocked(isPortReachable).mockResolvedValue(true)
      vi.mocked(wslModule.computeWslPortForwardingTeardownPlanAsync).mockResolvedValue({
        status: 'ready',
        script: '$null # mock teardown script',
      })

      const cp = await import('node:child_process')
      let finishDisable: ((error?: Error | null) => void) | null = null
      vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        finishDisable = (error = null) => {
          cb?.(error, '', '')
        }
        return { on: vi.fn() } as any
      })

      const firstRes = await request(app)
        .post('/api/network/disable-remote-access')
        .set('x-auth-token', token)
        .send({})

      expect(firstRes.status).toBe(200)
      expectConfirmationRequired(firstRes.body)

      const startedRes = await request(app)
        .post('/api/network/disable-remote-access')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: firstRes.body.confirmationToken,
        })

      expect(startedRes.status).toBe(200)
      expect(startedRes.body).toEqual({ method: 'wsl2', status: 'started' })

      vi.mocked(isPortReachable).mockResolvedValue(false)
      finishDisable?.()

      await vi.waitFor(async () => {
        const settings = await configStore.getSettings()
        expect(settings.network).toEqual(expect.objectContaining({
          configured: true,
          host: '127.0.0.1',
        }))
      })

      const statusRes = await request(app)
        .get('/api/network/status')
        .set('x-auth-token', token)

      expect(statusRes.status).toBe(200)
      expect(statusRes.body.remoteAccessEnabled).toBe(false)
      expect(statusRes.body.remoteAccessRequested).toBe(false)
      expect(statusRes.body.accessUrl).toContain('localhost')
      expect(statusRes.body.accessUrl).not.toContain('192.168.1.100')
    })

    it('returns 409 in-progress for disable requests while a confirmed WSL repair is still running', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
      vi.mocked(isPortReachable).mockResolvedValue(false)
      vi.mocked(wslModule.computeWslPortForwardingPlanAsync).mockResolvedValue({
        status: 'ready',
        wslIp: '172.24.0.2',
        scriptKind: 'full',
        script: '$null # mock script',
      })
      vi.mocked(wslModule.computeWslPortForwardingTeardownPlanAsync).mockResolvedValue({
        status: 'noop',
      })

      const cp = await import('node:child_process')
      let finishRepair: (() => void) | null = null
      vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        finishRepair = () => {
          cb?.(null, '', '')
        }
        return { on: vi.fn() } as any
      })

      const repairConfirmationRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(repairConfirmationRes.status).toBe(200)
      expectConfirmationRequired(repairConfirmationRes.body)

      const repairStartedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({
          confirmElevation: true,
          confirmationToken: repairConfirmationRes.body.confirmationToken,
        })

      expect(repairStartedRes.status).toBe(200)
      expect(repairStartedRes.body).toEqual({ method: 'wsl2', status: 'started' })

      const disableRes = await request(app)
        .post('/api/network/disable-remote-access')
        .set('x-auth-token', token)
        .send({})

      expect(disableRes.status).toBe(409)
      expect(disableRes.body).toEqual({
        error: 'Firewall configuration already in progress',
        method: 'in-progress',
      })

      const settings = await configStore.getSettings()
      expect(settings.network).toEqual(expect.objectContaining({
        configured: true,
        host: '0.0.0.0',
      }))

      finishRepair?.()
      networkManager.setFirewallConfiguring(false)
    })

    it('returns the teardown probe failure instead of treating it as a successful noop', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(wslModule.computeWslPortForwardingTeardownPlanAsync).mockResolvedValue({
        status: 'error',
        message: 'Failed to query existing Windows remote access rules',
      })

      const cp = await import('node:child_process')
      const res = await request(app)
        .post('/api/network/disable-remote-access')
        .set('x-auth-token', token)
        .send({})

      expect(res.status).toBe(500)
      expect(res.body).toEqual({ error: 'Failed to query existing Windows remote access rules' })
      expect(cp.execFile).not.toHaveBeenCalled()

      const settings = await configStore.getSettings()
      expect(settings.network).toEqual(expect.objectContaining({
        configured: true,
        host: '0.0.0.0',
      }))
    })
  })
})
