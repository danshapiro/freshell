// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  createOpencodeModelCatalogProvider,
  normalizeOpencodeEnabledModelCatalog,
} from '../../../../server/fresh-agent/adapters/opencode/model-catalog.js'

function fakeChild() {
  const child = new EventEmitter() as any
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 5555
  child.kill = vi.fn(() => { child.killed = true; queueMicrotask(() => child.emit('close', 0)); return true })
  return child
}

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return {
    ok: (init.status ?? 200) < 400,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any
}

describe('OpenCode model catalog provider', () => {
  it('starts an isolated short-lived serve process, fetches cwd-scoped /config/providers, and stops only that child', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => child)
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/global/health')) return jsonResponse({ healthy: true })
      if (url.endsWith('/config/providers')) {
        return jsonResponse({
          providers: {
            'opencode-go': {
              id: 'opencode-go',
              name: 'opencode-go',
              models: {
                'glm-5.2': { id: 'glm-5.2', name: 'GLM 5.2' },
              },
            },
          },
          default: { 'opencode-go': 'glm-5.2' },
        })
      }
      return jsonResponse({}, { status: 404 })
    })
    const provider = createOpencodeModelCatalogProvider({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: async () => ({ hostname: '127.0.0.1', port: 48123 }),
      healthTimeoutMs: 100,
      requestTimeoutMs: 100,
    })

    await expect(provider.getCatalog({ cwd: '/repo/project-a' })).resolves.toMatchObject({
      providers: expect.objectContaining({ 'opencode-go': expect.any(Object) }),
    })
    expect(spawnFn).toHaveBeenCalledWith(
      'opencode',
      ['serve', '--pure', '--hostname', '127.0.0.1', '--port', '48123'],
      expect.objectContaining({ cwd: '/repo/project-a' }),
    )
    expect(fetchFn).toHaveBeenCalledWith('http://127.0.0.1:48123/config/providers', expect.anything())
    expect(child.kill).toHaveBeenCalled()
  })

  it('sanitizes enabled provider models and does not copy credential-shaped fields or descriptions', () => {
    const models = normalizeOpencodeEnabledModelCatalog({
      providers: {
        deepseek: {
          id: 'deepseek',
          name: 'deepseek',
          apiKey: 'must-not-leak',
          models: {
            'deepseek-v4-pro': {
              id: 'deepseek-v4-pro',
              name: 'DeepSeek V4 Pro',
              description: 'must-not-leak-description',
              options: { apiKey: 'must-not-leak' },
              headers: { authorization: 'must-not-leak' },
            },
          },
        },
        'bad/source': {
          id: 'bad/source',
          models: { one: { id: 'one' } },
        },
      },
    })

    expect(models).toEqual([
      {
        id: 'deepseek/deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        provider: 'opencode',
        source: { id: 'deepseek', displayName: 'deepseek' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
    ])
    expect(JSON.stringify(models)).not.toMatch(/must-not-leak|authorization|apiKey|description/)
  })

  it('fast-fails when the serve child exits before becoming healthy (does not wait for the full timeout)', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 1))
      return child
    })
    const fetchFn = vi.fn(async () => jsonResponse({}, { status: 503 }))
    const provider = createOpencodeModelCatalogProvider({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: async () => ({ hostname: '127.0.0.1', port: 48124 }),
      healthTimeoutMs: 5000,
      requestTimeoutMs: 100,
    })

    const start = Date.now()
    await expect(provider.getCatalog({ cwd: '/repo/project-a' })).rejects.toThrow(/exited with code 1/)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(4000)
    expect(child.kill).toHaveBeenCalled()
  })

  it('fast-fails when the serve child emits an error (e.g. ENOENT) before becoming healthy', async () => {
    const child = fakeChild()
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' })))
      return child
    })
    const fetchFn = vi.fn(async () => jsonResponse({}, { status: 503 }))
    const provider = createOpencodeModelCatalogProvider({
      spawnFn: spawnFn as any,
      fetchFn: fetchFn as any,
      allocatePort: async () => ({ hostname: '127.0.0.1', port: 48125 }),
      healthTimeoutMs: 5000,
      requestTimeoutMs: 100,
    })

    const start = Date.now()
    await expect(provider.getCatalog({ cwd: '/repo/project-a' })).rejects.toThrow(/ENOENT/)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(4000)
    expect(child.kill).toHaveBeenCalled()
  })

  it('normalizes array-format providers from opencode 1.17.x /config/providers', () => {
    const models = normalizeOpencodeEnabledModelCatalog({
      providers: [
        {
          id: 'deepseek',
          name: 'deepseek',
          models: {
            'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
            'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
          },
        },
        {
          id: 'opencode-go',
          name: 'opencode-go',
          models: {
            'glm-5.2': { id: 'glm-5.2', name: 'GLM 5.2' },
          },
        },
      ],
      default: { 'opencode-go': 'glm-5.2' },
    })

    expect(models).toEqual([
      {
        id: 'deepseek/deepseek-v4-flash',
        displayName: 'DeepSeek V4 Flash',
        provider: 'opencode',
        source: { id: 'deepseek', displayName: 'deepseek' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
      {
        id: 'deepseek/deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        provider: 'opencode',
        source: { id: 'deepseek', displayName: 'deepseek' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
      {
        id: 'opencode-go/glm-5.2',
        displayName: 'GLM 5.2',
        provider: 'opencode',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        supportsEffort: true,
        supportedEffortLevels: ['minimal', 'low', 'medium', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
    ])
  })
})
