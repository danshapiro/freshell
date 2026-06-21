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
      ['serve', '--hostname', '127.0.0.1', '--port', '48123'],
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
})
