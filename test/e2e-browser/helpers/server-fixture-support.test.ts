import { describe, expect, it } from 'vitest'
import {
  applyIsolatedHomeEnvironment,
  findFreePort,
} from './server-fixture-support.js'

describe('server fixture support', () => {
  it('isolates every provider home under the supplied owned home', () => {
    const env = applyIsolatedHomeEnvironment({ HOME: '/real-home', CLAUDE_CONFIG_DIR: '/ambient' }, '/tmp/owned-home')
    expect(env.HOME).toBe('/tmp/owned-home')
    expect(env.FRESHELL_HOME).toBe('/tmp/owned-home')
    expect(env.CLAUDE_HOME).toBe('/tmp/owned-home/.claude')
    expect(env.CODEX_HOME).toBe('/tmp/owned-home/.codex')
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('does not return a recently issued port to another immediate caller', async () => {
    const candidates = [41231, 41231, 41232]
    const port = await findFreePort(async () => candidates.shift() ?? 41233)
    const second = await findFreePort(async () => candidates.shift() ?? 41233)
    expect([port, second]).toEqual([41231, 41232])
  })
})
