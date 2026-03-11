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
}))
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, execFile: vi.fn() }
})

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
    vi.clearAllMocks()
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

    it('returns confirmation-required for WSL2 until the caller confirms elevation', async () => {
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

      expect(res.status).toBe(200)
      expect(res.body).toEqual({
        method: 'confirmation-required',
        title: 'Administrator approval required',
        body: 'To complete this, you will need to accept the Windows administrator prompt on the next screen.',
        confirmLabel: 'Continue',
      })
      expect(wslModule.computeWslPortForwardingPlan).not.toHaveBeenCalled()
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('returns none for WSL2 on the first click when the port is already reachable', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable).mockResolvedValueOnce(true)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      const cp = await import('node:child_process')

      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({})

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'none', message: 'No configuration changes required' })
      expect(wslModule.computeWslPortForwardingPlan).not.toHaveBeenCalled()
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('returns none for WSL2 when the confirmed retry recomputes to noop', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable).mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlan).mockReturnValue({
        status: 'noop',
        wslIp: '172.24.0.2',
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
        .send({ confirmElevation: true })

      expect(confirmedRes.status).toBe(200)
      expect(confirmedRes.body).toEqual({ method: 'none', message: 'No configuration changes required' })
      expect(wslModule.computeWslPortForwardingPlan).toHaveBeenCalledTimes(1)
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('starts WSL2 repair after explicit confirmation', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      vi.mocked(isPortReachable).mockResolvedValueOnce(false)

      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.computeWslPortForwardingPlan).mockReturnValue({
        status: 'ready',
        wslIp: '172.24.0.2',
        scriptKind: 'full',
        script: '$null # mock script',
      })

      const cp = await import('node:child_process')
      vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, _cb: any) => {
        return { on: vi.fn() } as any
      })

      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({ confirmElevation: true })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'wsl2', status: 'started' })

      networkManager.setFirewallConfiguring(false)
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
      expect(res.body.method).toBe('confirmation-required')
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
        .send({ confirmElevation: true })

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
        .send({ confirmElevation: true })

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

      const confirmedRes = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({ confirmElevation: true })

      expect(confirmedRes.status).toBe(200)
      expect(confirmedRes.body).toEqual({ method: 'none', message: 'No firewall detected' })
      expect(cp.execFile).not.toHaveBeenCalled()
    })

    it('starts native Windows repair after explicit confirmation', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'windows',
        active: true,
      })
      networkManager.resetFirewallCache()

      const cp = await import('node:child_process')
      vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, _cb: any) => {
        return { on: vi.fn() } as any
      })

      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({ confirmElevation: true })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ method: 'windows-elevated', status: 'started' })

      networkManager.setFirewallConfiguring(false)
    })

    it('rejects malformed confirmation payloads', async () => {
      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
        .send({ confirmElevation: false })

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('Invalid request')
    })

    it('rejects concurrent firewall configuration (in-flight guard)', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.setFirewallConfiguring(true)

      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
      expect(res.status).toBe(409)
      expect(res.body.error).toContain('already in progress')

      networkManager.setFirewallConfiguring(false)
    })
  })
})
