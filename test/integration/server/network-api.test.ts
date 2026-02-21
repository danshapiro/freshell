// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import request from 'supertest'
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
  default: vi.fn().mockResolvedValue(true),
}))
vi.mock('../../../server/wsl-port-forward.js', () => ({
  getWslIp: vi.fn().mockReturnValue('172.24.0.2'),
  buildPortForwardingScript: vi.fn().mockReturnValue('$null # mock script'),
  setupWslPortForwarding: vi.fn(),
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

    it('returns wsl2 method for wsl2 platform', async () => {
      vi.mocked(detectFirewall).mockResolvedValue({
        platform: 'wsl2',
        active: true,
      })
      networkManager.resetFirewallCache()
      const cp = await import('node:child_process')
      vi.mocked(cp.execFile).mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
        // Don't call cb — leave firewall in configuring state for this test
        return { on: vi.fn() } as any
      })
      const wslModule = await import('../../../server/wsl-port-forward.js')
      vi.mocked(wslModule.getWslIp).mockReturnValue('172.24.0.2')
      vi.mocked(wslModule.buildPortForwardingScript).mockReturnValue('$null # mock script')

      const res = await request(app)
        .post('/api/network/configure-firewall')
        .set('x-auth-token', token)
      expect(res.status).toBe(200)
      expect(res.body.method).toBe('wsl2')
      expect(res.body.status).toBe('started')

      // Clean up configuring state (callback was not called in the mock)
      networkManager.setFirewallConfiguring(false)
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
