// @vitest-environment node
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  createOpencodeModelCatalogProvider,
  normalizeOpencodeEnabledModelCatalog,
} from '../../../../server/fresh-agent/adapters/opencode/model-catalog.js'

const SHARED_FIXTURE_DIR = path.join(__dirname, '../../../fixtures/fresh-agent-model-capabilities')

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
              variants: {
                high: { reasoningEffort: 'high' },
                max: { reasoningEffort: 'max' },
              },
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
        supportedEffortLevels: ['high', 'max'],
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
            'deepseek-v4-pro': {
              id: 'deepseek-v4-pro',
              name: 'DeepSeek V4 Pro',
              variants: { high: {}, max: {} },
            },
            'deepseek-v4-flash': {
              id: 'deepseek-v4-flash',
              name: 'DeepSeek V4 Flash',
              variants: { low: {}, high: {}, max: {} },
            },
          },
        },
        {
          id: 'opencode-go',
          name: 'opencode-go',
          models: {
            'glm-5.2': {
              id: 'glm-5.2',
              name: 'GLM 5.2',
              variants: { high: {}, max: {} },
            },
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
        supportedEffortLevels: ['low', 'high', 'max'],
        supportsAdaptiveThinking: true,
      },
      {
        id: 'deepseek/deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        provider: 'opencode',
        source: { id: 'deepseek', displayName: 'deepseek' },
        supportsEffort: true,
        supportedEffortLevels: ['high', 'max'],
        supportsAdaptiveThinking: true,
      },
      {
        id: 'opencode-go/glm-5.2',
        displayName: 'GLM 5.2',
        provider: 'opencode',
        source: { id: 'opencode-go', displayName: 'opencode-go' },
        supportsEffort: true,
        supportedEffortLevels: ['high', 'max'],
        supportsAdaptiveThinking: true,
      },
    ])
  })
})

describe('opencode model catalog thinking variants', () => {
  function normalizeSingleModel(model: Record<string, unknown>) {
    const models = normalizeOpencodeEnabledModelCatalog({
      providers: {
        'opencode-go': {
          id: 'opencode-go',
          name: 'OpenCode Go',
          models: { m: model },
        },
      },
    })
    expect(models).toHaveLength(1)
    return models[0]
  }

  it('derives supportedEffortLevels from the model variants map keys, ordered canonically', () => {
    // A model with off/minimal/low/medium/high/xhigh/max variants (opencode 1.18.18).
    const model = normalizeSingleModel({
      id: 'glm-5.2-vision',
      name: 'glm-5.2-vision',
      variants: {
        high: { reasoningEffort: 'high' },
        max: { reasoningEffort: 'max' },
        off: { reasoningEffort: 'none' },
        minimal: { reasoningEffort: 'minimal' },
        low: { reasoningEffort: 'low' },
        medium: { reasoningEffort: 'medium' },
        xhigh: { reasoningEffort: 'xhigh' },
      },
    })

    expect(model).toMatchObject({
      supportedEffortLevels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      supportsEffort: true,
      supportsAdaptiveThinking: true,
    })
  })

  it('keeps a single-variant model effort-capable', () => {
    // Real: opencode-go/kimi-k3 declares { max } only.
    const model = normalizeSingleModel({
      id: 'kimi-k3',
      name: 'Kimi K3',
      variants: { max: { reasoningEffort: 'max' } },
    })

    expect(model).toMatchObject({
      supportedEffortLevels: ['max'],
      supportsEffort: true,
      supportsAdaptiveThinking: true,
    })
  })

  it('ranks unknown variant ids after the known canonical levels', () => {
    // Real: opencode-go/minimax-m3 declares { none, thinking }.
    const model = normalizeSingleModel({
      id: 'minimax-m3',
      name: 'MiniMax-M3',
      variants: {
        none: { thinking: { type: 'disabled' } },
        thinking: { thinking: { type: 'adaptive' } },
      },
    })

    expect(model).toMatchObject({
      supportedEffortLevels: ['none', 'thinking'],
      supportsEffort: true,
      supportsAdaptiveThinking: true,
    })
  })

  it('drops blank variant ids', () => {
    const model = normalizeSingleModel({
      id: 'm',
      name: 'M',
      variants: { '': {}, '  ': {}, low: {}, high: {} },
    })

    expect(model.supportedEffortLevels).toEqual(['low', 'high'])
  })

  it('treats a model with no variants as having no selectable levels', () => {
    // The server does NOT invent levels for these — the client renders a single
    // "Default" row from an empty supportedEffortLevels list.
    const missingKey = normalizeSingleModel({ id: 'm', name: 'M' })
    const emptyObject = normalizeSingleModel({ id: 'm', name: 'M', variants: {} })

    for (const model of [missingKey, emptyObject]) {
      expect(model).toMatchObject({
        supportedEffortLevels: [],
        supportsEffort: false,
        supportsAdaptiveThinking: false,
      })
    }
  })

  it('ignores non-object variants payloads', () => {
    const asArray = normalizeSingleModel({ id: 'm', name: 'M', variants: ['low', 'high'] })
    const asString = normalizeSingleModel({ id: 'm', name: 'M', variants: 'low,high' })
    const asNumber = normalizeSingleModel({ id: 'm', name: 'M', variants: 3 })

    for (const model of [asArray, asString, asNumber]) {
      expect(model).toMatchObject({
        supportedEffortLevels: [],
        supportsEffort: false,
        supportsAdaptiveThinking: false,
      })
    }
  })

  it('matches the shared fixture the Rust normalizer also asserts against', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(SHARED_FIXTURE_DIR, 'opencode-config-providers.fixture.json'), 'utf8'),
    )
    const expected = JSON.parse(
      readFileSync(path.join(SHARED_FIXTURE_DIR, 'opencode-config-providers.normalized.json'), 'utf8'),
    )

    expect(normalizeOpencodeEnabledModelCatalog(fixture)).toEqual(expected)
  })
})
