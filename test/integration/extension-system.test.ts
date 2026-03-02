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

vi.mock('../../server/logger', () => ({ logger: mockLogger }))

import { ExtensionManager } from '../../server/extension-manager.js'

// ── Helpers ──

/** A tiny HTTP server script that prints readyPattern on startup */
function makeServerScript(): string {
  return `
const http = require('http')
const port = process.env.PORT || 3000
const server = http.createServer((req, res) => res.end('ok'))
server.listen(port, () => {
  console.log('Listening on port ' + port)
})
process.on('SIGTERM', () => { server.close(); process.exit(0) })
`
}

/** Write a freshell.json manifest + optional server.js into a named extension dir */
async function writeExtension(
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

/** Make an HTTP GET request and return the response body */
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = ''
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve(data))
      })
      .on('error', reject)
  })
}

describe('Extension system integration', () => {
  let tempDir: string
  let extDir: string
  let mgr: ExtensionManager

  beforeEach(async () => {
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ext-integration-'))
    extDir = path.join(tempDir, 'extensions')
    await fsp.mkdir(extDir, { recursive: true })
    mgr = new ExtensionManager()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await mgr.stopAll()
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  it('discovers, starts, queries, and stops a server extension', async () => {
    // 1. Create fixture server extension
    await writeExtension(
      extDir,
      'test-server-ext',
      {
        name: 'test-server-ext',
        version: '0.1.0',
        label: 'Test Server Extension',
        description: 'A test extension',
        category: 'server',
        server: {
          command: 'node',
          args: ['server.js'],
          readyPattern: 'Listening on',
          readyTimeout: 10000,
          singleton: true,
          env: { PORT: '{{port}}' },
        },
      },
      makeServerScript(),
    )

    // 2. Scan discovers the extension
    mgr.scan([extDir])
    expect(mgr.getAll()).toHaveLength(1)

    const entry = mgr.get('test-server-ext')
    expect(entry).toBeDefined()
    expect(entry!.manifest.name).toBe('test-server-ext')
    expect(entry!.manifest.category).toBe('server')

    // 3. Before starting: not running, no port, client registry reflects this
    expect(mgr.isRunning('test-server-ext')).toBe(false)
    expect(mgr.getPort('test-server-ext')).toBeUndefined()

    let clientEntries = mgr.toClientRegistry()
    expect(clientEntries).toHaveLength(1)
    expect(clientEntries[0].serverRunning).toBe(false)
    expect(clientEntries[0].serverPort).toBeUndefined()

    // 4. Start the server
    const port = await mgr.startServer('test-server-ext')
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)

    // 5. After starting: running, port allocated, client registry reflects this
    expect(mgr.isRunning('test-server-ext')).toBe(true)
    expect(mgr.getPort('test-server-ext')).toBe(port)

    clientEntries = mgr.toClientRegistry()
    expect(clientEntries[0].serverRunning).toBe(true)
    expect(clientEntries[0].serverPort).toBe(port)

    // 6. Verify the server is actually serving HTTP requests
    const response = await httpGet(`http://127.0.0.1:${port}`)
    expect(response).toBe('ok')

    // 7. Stop the server
    await mgr.stopServer('test-server-ext')

    // 8. After stopping: not running, no port, client registry reflects this
    expect(mgr.isRunning('test-server-ext')).toBe(false)
    expect(mgr.getPort('test-server-ext')).toBeUndefined()

    clientEntries = mgr.toClientRegistry()
    expect(clientEntries[0].serverRunning).toBe(false)
    expect(clientEntries[0].serverPort).toBeUndefined()

    // 9. Verify the server is no longer listening
    await expect(httpGet(`http://127.0.0.1:${port}`)).rejects.toThrow()
  })

  it('discovers client extensions without starting servers', async () => {
    await writeExtension(extDir, 'my-client-ext', {
      name: 'my-client-ext',
      version: '1.0.0',
      label: 'My Client Extension',
      description: 'A client-only extension',
      category: 'client',
      client: { entry: './index.html' },
    })

    mgr.scan([extDir])

    expect(mgr.getAll()).toHaveLength(1)

    const entry = mgr.get('my-client-ext')
    expect(entry).toBeDefined()
    expect(entry!.manifest.category).toBe('client')
    expect(entry!.serverPort).toBeUndefined()

    // Client registry should show it as not running with no server port
    const clientEntries = mgr.toClientRegistry()
    expect(clientEntries).toHaveLength(1)
    expect(clientEntries[0].name).toBe('my-client-ext')
    expect(clientEntries[0].category).toBe('client')
    expect(clientEntries[0].serverRunning).toBe(false)
    expect(clientEntries[0].serverPort).toBeUndefined()

    // Attempting to start a client extension as a server should fail
    await expect(mgr.startServer('my-client-ext')).rejects.toThrow(/not.*server/i)
  })
})
