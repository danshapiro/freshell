import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOpencodeActivityIntegration } from '../../../../server/coding-cli/opencode-activity-integration.js'

function makeRegistry() {
  const registry = new EventEmitter() as any
  registry.list = vi.fn(() => [])
  registry.get = vi.fn(() => undefined)
  registry.bindSession = vi.fn(() => ({ ok: true }))
  registry.rebindSession = vi.fn(() => ({ ok: true }))
  return registry
}

describe('opencode activity integration (resolver regression pin, docs/plans/2026-05-09-fix-opencode-ambiguous-ownership.md)', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('injects the provider resolver — construction survives production mode (no identity-resolver fallback)', () => {
    // Outside tests the tracker constructor THROWS unless a real resolver is
    // injected (opencode-activity-tracker.ts:242-246). If index-style wiring
    // ever loses the provider resolver again, this pin goes red.
    vi.stubEnv('NODE_ENV', 'production')
    const resolveOpencodeSessionRoots = vi.fn(async (ids: readonly string[]) => ({
      rootsBySessionId: new Map(ids.map((id) => [id, id])),
      unresolvedSessionIds: new Set<string>(),
    }))
    const integration = createOpencodeActivityIntegration({
      registry: makeRegistry(),
      opencodeProvider: { resolveOpencodeSessionRoots },
    })
    expect(integration.tracker).toBeDefined()
    integration.dispose()
  })
})
