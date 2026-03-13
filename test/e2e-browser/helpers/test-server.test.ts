import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  applyIsolatedHomeEnvironment,
  applyTestServerHomeEnvironment,
  requireBuiltServerEntry,
  TestServer,
} from './test-server.js'

function resolveProjectRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
}

describe('TestServer', () => {
  let server: TestServer | undefined

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = undefined
    }
  })

  it('starts a server on an ephemeral port', async () => {
    server = new TestServer()
    const info = await server.start()
    const projectRoot = resolveProjectRoot()
    expect(info.port).toBeGreaterThan(0)
    expect(info.port).not.toBe(3001)
    expect(info.port).not.toBe(3002)
    expect(info.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(info.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/ws$/)
    expect(info.token).toBeTruthy()
    expect(info.token.length).toBeGreaterThanOrEqual(16)
    expect(info.runtimeRoot).toBe(projectRoot)
  })

  it('health check returns ok', async () => {
    server = new TestServer()
    const info = await server.start()
    const res = await fetch(`${info.baseUrl}/api/health`)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('auth is enforced', async () => {
    server = new TestServer()
    const info = await server.start()
    const res = await fetch(`${info.baseUrl}/api/settings`)
    expect(res.status).toBe(401)
  })

  it('auth succeeds with correct token', async () => {
    server = new TestServer()
    const info = await server.start()
    const res = await fetch(`${info.baseUrl}/api/settings`, {
      headers: { 'x-auth-token': info.token },
    })
    expect(res.status).toBe(200)
  })

  it('rejects bootstrap auth against the project runtime root', () => {
    expect(() => new TestServer({
      authStrategy: 'bootstrap',
    })).toThrow(/requires runtimeRootMode "isolated"/)
  })

  it('overrides Windows home env vars when isolating the server HOME', () => {
    const env = applyIsolatedHomeEnvironment({
      HOME: '/real/home',
      USERPROFILE: 'C:\\Users\\real-user',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\real-user',
      CLAUDE_HOME: '/real/.claude',
      CODEX_HOME: '/real/.codex',
      XDG_DATA_HOME: '/real/.local/share',
      LOCALAPPDATA: 'C:\\Users\\real-user\\AppData\\Local',
    }, '/tmp/freshell-e2e-home')

    expect(env.HOME).toBe('/tmp/freshell-e2e-home')
    expect(env.USERPROFILE).toBe('/tmp/freshell-e2e-home')
    expect('HOMEDRIVE' in env).toBe(false)
    expect('HOMEPATH' in env).toBe(false)
    expect(env.CLAUDE_HOME).toBe('/tmp/freshell-e2e-home/.claude')
    expect(env.CODEX_HOME).toBe('/tmp/freshell-e2e-home/.codex')
    expect(env.XDG_DATA_HOME).toBe('/tmp/freshell-e2e-home/.local/share')
    expect(env.LOCALAPPDATA).toBe('/tmp/freshell-e2e-home/AppData/Local')
  })

  it('derives Windows drive-based home vars for native Windows isolated homes', () => {
    const env = applyIsolatedHomeEnvironment({}, 'D:\\Temp\\freshell-e2e-home')

    expect(env.HOME).toBe('D:\\Temp\\freshell-e2e-home')
    expect(env.USERPROFILE).toBe('D:\\Temp\\freshell-e2e-home')
    expect(env.HOMEDRIVE).toBe('D:')
    expect(env.HOMEPATH).toBe('\\Temp\\freshell-e2e-home')
    expect(env.CLAUDE_HOME).toBe('D:\\Temp\\freshell-e2e-home\\.claude')
    expect(env.CODEX_HOME).toBe('D:\\Temp\\freshell-e2e-home\\.codex')
    expect(env.XDG_DATA_HOME).toBe('D:\\Temp\\freshell-e2e-home\\.local\\share')
    expect(env.LOCALAPPDATA).toBe('D:\\Temp\\freshell-e2e-home\\AppData\\Local')
  })

  it('preserves inherited Windows shell env vars for project-root starts', () => {
    const env = applyTestServerHomeEnvironment({
      HOME: '/real/home',
      USERPROFILE: 'C:\\Users\\real-user',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\real-user',
      CLAUDE_HOME: '/real/.claude',
      CODEX_HOME: '/real/.codex',
      XDG_DATA_HOME: '/real/.local/share',
      LOCALAPPDATA: 'C:\\Users\\real-user\\AppData\\Local',
    }, '/tmp/freshell-e2e-home')

    expect(env.HOME).toBe('/tmp/freshell-e2e-home')
    expect(env.USERPROFILE).toBe('C:\\Users\\real-user')
    expect(env.HOMEDRIVE).toBe('C:')
    expect(env.HOMEPATH).toBe('\\Users\\real-user')
    expect(env.CLAUDE_HOME).toBe('/real/.claude')
    expect(env.CODEX_HOME).toBe('/real/.codex')
    expect(env.XDG_DATA_HOME).toBe('/real/.local/share')
    expect(env.LOCALAPPDATA).toBe('C:\\Users\\real-user\\AppData\\Local')
  })

  it('reports the build-first guidance before isolated staging when the compiled server is missing', () => {
    expect(() => requireBuiltServerEntry('/repo', () => false)).toThrow(
      'Built server not found at /repo/dist/server/index.js. Run "npm run build" first, or let the Playwright globalSetup handle it.',
    )
  })

  it('bootstraps AUTH_TOKEN into the isolated runtime root for a compiled cold start', async () => {
    server = new TestServer({
      authStrategy: 'bootstrap',
      runtimeRootMode: 'isolated',
    })

    const info = await server.start()
    expect(info.runtimeRoot).toContain(path.join(resolveProjectRoot(), '.worktrees', 'test-server-runtime-'))

    const envText = await fs.readFile(path.join(info.runtimeRoot, '.env'), 'utf8')
    expect(envText).toMatch(/^AUTH_TOKEN=[a-f0-9]{64}$/m)
    await expect(fs.stat(path.join(info.runtimeRoot, 'dist', '.env'))).rejects.toThrow()

    const res = await fetch(`${info.baseUrl}/api/settings`, {
      headers: { 'x-auth-token': info.token },
    })
    expect(res.status).toBe(200)
  })

  it('removes isolated runtime roots on stop', async () => {
    server = new TestServer({
      authStrategy: 'bootstrap',
      runtimeRootMode: 'isolated',
      preserveHomeOnStop: true,
    })

    const info = await server.start()
    await expect(fs.stat(info.runtimeRoot)).resolves.toBeDefined()
    await expect(fs.stat(info.homeDir)).resolves.toBeDefined()

    await server.stop()
    server = undefined

    await expect(fs.stat(info.runtimeRoot)).rejects.toThrow()
    await expect(fs.stat(info.homeDir)).resolves.toBeDefined()
    await expect(fs.stat(path.join(resolveProjectRoot(), 'package.json'))).resolves.toBeDefined()
  })

  it('starts isolated compiled startup without copied extension or skill directories', async () => {
    server = new TestServer({
      authStrategy: 'bootstrap',
      runtimeRootMode: 'isolated',
    })

    const info = await server.start()

    await expect(fs.stat(path.join(info.runtimeRoot, 'extensions'))).rejects.toThrow()
    await expect(fs.stat(path.join(info.runtimeRoot, '.freshell', 'extensions'))).rejects.toThrow()
    await expect(fs.stat(path.join(info.runtimeRoot, '.claude'))).rejects.toThrow()

    const healthRes = await fetch(`${info.baseUrl}/api/health`)
    expect(healthRes.status).toBe(200)
    await expect(healthRes.json()).resolves.toMatchObject({ ok: true })

    const settingsRes = await fetch(`${info.baseUrl}/api/settings`, {
      headers: { 'x-auth-token': info.token },
    })
    expect(settingsRes.status).toBe(200)
  })

  it('keeps the same bootstrap and auth contract for default and isolated compiled startup', async () => {
    const defaultServer = new TestServer()
    const isolatedServer = new TestServer({
      authStrategy: 'bootstrap',
      runtimeRootMode: 'isolated',
    })

    try {
      const defaultInfo = await defaultServer.start()
      const isolatedInfo = await isolatedServer.start()

      const defaultHealthRes = await fetch(`${defaultInfo.baseUrl}/api/health`)
      const isolatedHealthRes = await fetch(`${isolatedInfo.baseUrl}/api/health`)
      expect(defaultHealthRes.status).toBe(200)
      expect(isolatedHealthRes.status).toBe(200)
      await expect(defaultHealthRes.json()).resolves.toMatchObject({ ok: true })
      await expect(isolatedHealthRes.json()).resolves.toMatchObject({ ok: true })

      const defaultUnauthedRes = await fetch(`${defaultInfo.baseUrl}/api/settings`)
      const isolatedUnauthedRes = await fetch(`${isolatedInfo.baseUrl}/api/settings`)
      expect(defaultUnauthedRes.status).toBe(401)
      expect(isolatedUnauthedRes.status).toBe(401)

      const defaultAuthedRes = await fetch(`${defaultInfo.baseUrl}/api/settings`, {
        headers: { 'x-auth-token': defaultInfo.token },
      })
      const isolatedAuthedRes = await fetch(`${isolatedInfo.baseUrl}/api/settings`, {
        headers: { 'x-auth-token': isolatedInfo.token },
      })
      expect(defaultAuthedRes.status).toBe(200)
      expect(isolatedAuthedRes.status).toBe(200)
    } finally {
      await isolatedServer.stop()
      await defaultServer.stop()
    }
  })

  it('cleans up temp HOME and isolated runtime roots when isolated staging fails', async () => {
    let failedHomeDir: string | undefined
    let failedRuntimeRoot: string | undefined
    const originalMkdtemp = fs.mkdtemp.bind(fs)
    const mkdtempSpy = vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix, options) => {
      const created = await originalMkdtemp(prefix, options)
      if (String(prefix).includes('test-server-runtime-')) {
        failedRuntimeRoot = created
      }
      return created
    })
    const copySpy = vi.spyOn(fs, 'cp').mockRejectedValue(new Error('Injected isolated runtime staging failure'))

    try {
      server = new TestServer({
        authStrategy: 'bootstrap',
        runtimeRootMode: 'isolated',
        setupHome: async (homeDir) => {
          failedHomeDir = homeDir
        },
      })

      await expect(server.start()).rejects.toThrow('Injected isolated runtime staging failure')
    } finally {
      mkdtempSpy.mockRestore()
      copySpy.mockRestore()
    }

    await server.stop()
    server = undefined

    expect(failedRuntimeRoot).toBeTruthy()
    await expect(fs.stat(failedRuntimeRoot!)).rejects.toThrow()
    await expect(fs.stat(failedHomeDir!)).rejects.toThrow()
  })

  it('starts isolated compiled bootstrap mode within the existing helper timeout budget', async () => {
    server = new TestServer({
      authStrategy: 'bootstrap',
      runtimeRootMode: 'isolated',
      startTimeoutMs: 30_000,
    })

    const startedAt = performance.now()
    await server.start()
    expect(performance.now() - startedAt).toBeLessThan(30_000)
  })

  it('stops cleanly', async () => {
    server = new TestServer()
    const info = await server.start()
    await server.stop()
    server = undefined
    // Server should be unreachable after stop
    await expect(fetch(`${info.baseUrl}/api/health`)).rejects.toThrow()
  })

  it('uses isolated config directory', async () => {
    server = new TestServer()
    const info = await server.start()
    expect(info.configDir).toContain('freshell-e2e-')
    expect(info.configDir).not.toContain('.freshell')
  })

  it('exposes HOME, logs, and debug-log paths and can preserve them for audit collection', async () => {
    server = new TestServer({
      preserveHomeOnStop: true,
      setupHome: async (homeDir) => {
        await fs.mkdir(path.join(homeDir, '.claude', 'projects', 'perf'), { recursive: true })
      },
    })

    const info = await server.start()
    expect(info.homeDir).toContain('freshell-e2e-')
    expect(info.logsDir).toContain(path.join('.freshell', 'logs'))
    expect(info.debugLogPath).toContain('.jsonl')
    expect(await fs.stat(path.join(info.homeDir, '.claude', 'projects', 'perf'))).toBeDefined()
    await server.stop()
    server = undefined
    await expect(fs.stat(info.homeDir)).resolves.toBeDefined()

    server = new TestServer()
    const defaultInfo = await server.start()
    const defaultHomeDir = defaultInfo.homeDir
    await server.stop()
    server = undefined
    await expect(fs.stat(defaultHomeDir)).rejects.toThrow()
  })
})
