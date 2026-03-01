import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'fs/promises'
import path from 'path'
import os from 'os'
import http from 'http'

// Mock logger to avoid pino setup in test
const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('../../../server/logger', () => ({ logger: mockLogger }))

import { ExtensionManager } from '../../../server/extension-manager.js'

// ── Helpers ──

/** Write a tiny HTTP server script that prints readyPattern on startup */
function makeServerScript(): string {
  return `
const http = require('http')
const port = process.env.PORT || 3000
const server = http.createServer((req, res) => res.end('ok'))
server.listen(port, () => {
  console.log('Listening on port ' + port)
})
// Keep process alive
process.on('SIGTERM', () => { server.close(); process.exit(0) })
`
}

/** Write a script that never prints a ready pattern (for timeout testing) */
function makeHangingScript(): string {
  return `
// This script never prints anything matching the ready pattern
setInterval(() => {}, 1000)
`
}

/** Write a freshell.json manifest + optional server.js into a named extension dir */
async function writeServerExtension(
  parentDir: string,
  dirName: string,
  manifest: Record<string, unknown>,
  serverScript?: string,
): Promise<string> {
  const extDir = path.join(parentDir, dirName)
  await fsp.mkdir(extDir, { recursive: true })
  await fsp.writeFile(
    path.join(extDir, 'freshell.json'),
    JSON.stringify(manifest, null, 2),
  )
  if (serverScript) {
    await fsp.writeFile(path.join(extDir, 'server.js'), serverScript)
  }
  return extDir
}

/** Minimal valid server extension manifest */
function serverManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-server',
    version: '1.0.0',
    label: 'Test Server',
    description: 'A test server extension',
    category: 'server',
    server: {
      command: 'node',
      args: ['server.js'],
      env: { PORT: '{{port}}' },
      readyPattern: 'Listening on port',
      readyTimeout: 5000,
    },
    ...overrides,
  }
}

/** Minimal valid client extension manifest */
function clientManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-client',
    version: '2.0.0',
    label: 'Test Client',
    description: 'A test client extension',
    category: 'client',
    client: { entry: './index.html' },
    ...overrides,
  }
}

describe('ExtensionManager — Server Process Lifecycle', () => {
  let tempDir: string
  let extDir: string
  let mgr: ExtensionManager

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ext-lifecycle-test-'))
    extDir = path.join(tempDir, 'extensions')
    await fsp.mkdir(extDir, { recursive: true })
    mgr = new ExtensionManager()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    // Clean up any running servers
    await mgr.stopAll()
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  // ── startServer() ──

  describe('startServer()', () => {
    it('spawns a process and resolves with port when readyPattern matches', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      const port = await mgr.startServer('test-server')

      expect(port).toBeGreaterThan(0)
      expect(port).toBeLessThan(65536)
      expect(mgr.isRunning('test-server')).toBe(true)
      expect(mgr.getPort('test-server')).toBe(port)

      // Verify the server is actually listening
      const response = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}`, (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => resolve(data))
        }).on('error', reject)
      })
      expect(response).toBe('ok')
    })

    it('returns existing port if already running (no double-spawn)', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      const port1 = await mgr.startServer('test-server')
      const port2 = await mgr.startServer('test-server')

      expect(port1).toBe(port2)
      expect(mgr.isRunning('test-server')).toBe(true)
    })

    it('rejects if extension not found', async () => {
      mgr.scan([extDir])

      await expect(mgr.startServer('nonexistent')).rejects.toThrow(
        /extension.*not found/i,
      )
    })

    it('rejects if category is not server', async () => {
      await writeServerExtension(extDir, 'my-client', clientManifest())
      mgr.scan([extDir])

      await expect(mgr.startServer('test-client')).rejects.toThrow(
        /not.*server/i,
      )
    })

    it('rejects if readyPattern not matched within timeout', async () => {
      const manifest = serverManifest({
        name: 'hang-server',
        server: {
          command: 'node',
          args: ['server.js'],
          readyPattern: 'Listening on port',
          readyTimeout: 500, // Very short timeout
        },
      })
      await writeServerExtension(extDir, 'hang-server', manifest, makeHangingScript())
      mgr.scan([extDir])

      await expect(mgr.startServer('hang-server')).rejects.toThrow(
        /timeout|ready/i,
      )
      expect(mgr.isRunning('hang-server')).toBe(false)
    })

    it('sets serverPort on the registry entry', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      const port = await mgr.startServer('test-server')
      const entry = mgr.get('test-server')

      expect(entry?.serverPort).toBe(port)
    })

    it('interpolates {{port}} in env vars', async () => {
      const manifest = serverManifest({
        name: 'env-server',
        server: {
          command: 'node',
          args: ['server.js'],
          env: { PORT: '{{port}}', EXTRA: 'fixed-value' },
          readyPattern: 'Listening on port',
          readyTimeout: 5000,
        },
      })
      // The server script reads PORT from env, so if interpolation works it will listen correctly
      await writeServerExtension(extDir, 'env-server', manifest, makeServerScript())
      mgr.scan([extDir])

      const port = await mgr.startServer('env-server')

      expect(port).toBeGreaterThan(0)
      expect(mgr.isRunning('env-server')).toBe(true)

      // Verify the server is accessible on the allocated port
      const response = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}`, (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => resolve(data))
        }).on('error', reject)
      })
      expect(response).toBe('ok')
    })

    it('interpolates contentSchema defaults into env vars', async () => {
      // This server script outputs its env vars so we can verify interpolation
      const script = `
const http = require('http')
const port = process.env.PORT || 3000
const server = http.createServer((req, res) => {
  res.end(JSON.stringify({ apiKey: process.env.API_KEY, mode: process.env.MODE }))
})
server.listen(port, () => {
  console.log('Listening on port ' + port)
})
process.on('SIGTERM', () => { server.close(); process.exit(0) })
`
      const manifest = serverManifest({
        name: 'schema-server',
        contentSchema: {
          apiKey: { type: 'string', label: 'API Key', default: 'default-key-123' },
          mode: { type: 'string', label: 'Mode', default: 'development' },
        },
        server: {
          command: 'node',
          args: ['server.js'],
          env: { PORT: '{{port}}', API_KEY: '{{apiKey}}', MODE: '{{mode}}' },
          readyPattern: 'Listening on port',
          readyTimeout: 5000,
        },
      })
      await writeServerExtension(extDir, 'schema-server', manifest, script)
      mgr.scan([extDir])

      const port = await mgr.startServer('schema-server')

      const response = await new Promise<string>((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}`, (res) => {
          let data = ''
          res.on('data', (chunk) => (data += chunk))
          res.on('end', () => resolve(data))
        }).on('error', reject)
      })
      const env = JSON.parse(response)
      expect(env.apiKey).toBe('default-key-123')
      expect(env.mode).toBe('development')
    })
  })

  // ── stopServer() ──

  describe('stopServer()', () => {
    it('sends SIGTERM and cleans up', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      const port = await mgr.startServer('test-server')
      expect(mgr.isRunning('test-server')).toBe(true)

      await mgr.stopServer('test-server')

      expect(mgr.isRunning('test-server')).toBe(false)
      expect(mgr.getPort('test-server')).toBeUndefined()

      // Verify port is no longer in the registry entry
      const entry = mgr.get('test-server')
      expect(entry?.serverPort).toBeUndefined()

      // Verify the server is no longer listening
      await expect(
        new Promise((resolve, reject) => {
          http
            .get(`http://127.0.0.1:${port}`, resolve)
            .on('error', reject)
        }),
      ).rejects.toThrow()
    })

    it('is a no-op if not running', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      // Should not throw
      await expect(mgr.stopServer('test-server')).resolves.toBeUndefined()
    })

    it('is a no-op for unknown extensions', async () => {
      mgr.scan([extDir])

      // Should not throw
      await expect(mgr.stopServer('nonexistent')).resolves.toBeUndefined()
    })
  })

  // ── stopAll() ──

  describe('stopAll()', () => {
    it('stops all running servers', async () => {
      await writeServerExtension(
        extDir,
        'server-a',
        serverManifest({ name: 'server-a' }),
        makeServerScript(),
      )
      await writeServerExtension(
        extDir,
        'server-b',
        serverManifest({ name: 'server-b' }),
        makeServerScript(),
      )
      mgr.scan([extDir])

      await mgr.startServer('server-a')
      await mgr.startServer('server-b')

      expect(mgr.isRunning('server-a')).toBe(true)
      expect(mgr.isRunning('server-b')).toBe(true)

      await mgr.stopAll()

      expect(mgr.isRunning('server-a')).toBe(false)
      expect(mgr.isRunning('server-b')).toBe(false)
    })

    it('is a no-op when nothing is running', async () => {
      mgr.scan([extDir])

      await expect(mgr.stopAll()).resolves.toBeUndefined()
    })
  })

  // ── isRunning() and getPort() ──

  describe('isRunning() and getPort()', () => {
    it('isRunning returns false for unknown extensions', () => {
      expect(mgr.isRunning('nonexistent')).toBe(false)
    })

    it('isRunning returns false before starting', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      expect(mgr.isRunning('test-server')).toBe(false)
    })

    it('getPort returns undefined for unknown extensions', () => {
      expect(mgr.getPort('nonexistent')).toBeUndefined()
    })

    it('getPort returns undefined before starting', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      expect(mgr.getPort('test-server')).toBeUndefined()
    })

    it('isRunning and getPort reflect running state', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      const port = await mgr.startServer('test-server')

      expect(mgr.isRunning('test-server')).toBe(true)
      expect(mgr.getPort('test-server')).toBe(port)

      await mgr.stopServer('test-server')

      expect(mgr.isRunning('test-server')).toBe(false)
      expect(mgr.getPort('test-server')).toBeUndefined()
    })
  })

  // ── toClientRegistry integration ──

  describe('toClientRegistry() with running servers', () => {
    it('reflects serverRunning and serverPort for running extensions', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      // Before starting
      let entries = mgr.toClientRegistry()
      expect(entries[0].serverRunning).toBe(false)
      expect(entries[0].serverPort).toBeUndefined()

      // After starting
      const port = await mgr.startServer('test-server')
      entries = mgr.toClientRegistry()
      expect(entries[0].serverRunning).toBe(true)
      expect(entries[0].serverPort).toBe(port)

      // After stopping
      await mgr.stopServer('test-server')
      entries = mgr.toClientRegistry()
      expect(entries[0].serverRunning).toBe(false)
      expect(entries[0].serverPort).toBeUndefined()
    })
  })

  // ── EventEmitter lifecycle events ──

  describe('EventEmitter lifecycle events', () => {
    it('emits server.starting before server.ready', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      const eventOrder: string[] = []
      mgr.on('server.starting', () => eventOrder.push('starting'))
      mgr.on('server.ready', () => eventOrder.push('ready'))

      await mgr.startServer('test-server')

      expect(eventOrder).toEqual(['starting', 'ready'])
    })

    it('emits server.ready after successful startServer', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      const events: Array<{ name: string; port: number }> = []
      mgr.on('server.ready', (payload) => events.push(payload))

      const port = await mgr.startServer('test-server')

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ name: 'test-server', port })
    })

    it('emits server.error when waitForReady fails (timeout)', async () => {
      const manifest = serverManifest({
        name: 'hang-server',
        server: {
          command: 'node',
          args: ['server.js'],
          readyPattern: 'Listening on port',
          readyTimeout: 500, // Very short timeout
        },
      })
      await writeServerExtension(extDir, 'hang-server', manifest, makeHangingScript())
      mgr.scan([extDir])

      const errors: Array<{ name: string; error: string }> = []
      mgr.on('server.error', (payload) => errors.push(payload))

      await expect(mgr.startServer('hang-server')).rejects.toThrow()

      expect(errors).toHaveLength(1)
      expect(errors[0].name).toBe('hang-server')
      expect(errors[0].error).toMatch(/timeout|ready/i)
    })

    it('emits server.stopped on stopServer', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      await mgr.startServer('test-server')

      const stops: Array<{ name: string }> = []
      mgr.on('server.stopped', (payload) => stops.push(payload))

      await mgr.stopServer('test-server')

      expect(stops).toHaveLength(1)
      expect(stops[0]).toEqual({ name: 'test-server' })
    })

    it('emits server.stopped on unexpected process exit', async () => {
      // Use a script that exits immediately after the ready pattern
      const script = `
const http = require('http')
const port = process.env.PORT || 3000
const server = http.createServer((req, res) => res.end('ok'))
server.listen(port, () => {
  console.log('Listening on port ' + port)
  // Exit after a short delay to simulate unexpected crash
  setTimeout(() => process.exit(1), 200)
})
`
      await writeServerExtension(extDir, 'my-server', serverManifest(), script)
      mgr.scan([extDir])

      await mgr.startServer('test-server')

      const stops: Array<{ name: string }> = []
      mgr.on('server.stopped', (payload) => stops.push(payload))

      // Wait for the process to exit on its own
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!mgr.isRunning('test-server')) {
            clearInterval(check)
            resolve()
          }
        }, 50)
        // Safety timeout
        setTimeout(() => {
          clearInterval(check)
          resolve()
        }, 5000)
      })

      expect(stops).toHaveLength(1)
      expect(stops[0]).toEqual({ name: 'test-server' })
    })

    it('does not emit server.ready when returning existing port (already running)', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      await mgr.startServer('test-server')

      const events: Array<{ name: string; port: number }> = []
      mgr.on('server.ready', (payload) => events.push(payload))

      // Call startServer again — should return existing port, no event
      await mgr.startServer('test-server')

      expect(events).toHaveLength(0)
    })

    it('does not emit server.stopped when stopServer is a no-op', async () => {
      await writeServerExtension(extDir, 'my-server', serverManifest(), makeServerScript())
      mgr.scan([extDir])

      const stops: Array<{ name: string }> = []
      mgr.on('server.stopped', (payload) => stops.push(payload))

      // Not running — should be a no-op, no event
      await mgr.stopServer('test-server')

      expect(stops).toHaveLength(0)
    })
  })
})
