import { describe, expect, it } from 'vitest'
import {
  applyIsolatedHomeEnvironment,
  applyServerHomeEnvironment,
  findFreePort,
  homeIsolationConflicts,
} from './server-fixture-support.js'

describe('server fixture support', () => {
  it('strips the ambient managed-runtime opt-in from a hand-rolled server spawn env', () => {
    // Hand-rolled spawns (cfg01/cfg03's spawnServerAgainstHome) cannot
    // reuse the RustServer fixture's env scrub; the helper they share
    // must strip the ambient opt-in itself — the self-hosted machine
    // exports it into every spawned shell, and a non-feature-built
    // freshell-server refuses to boot with it (main.rs
    // managed_runtime_feature_error).
    const env = applyServerHomeEnvironment({
      HOME: '/real-home',
      FRESHELL_MANAGED_RUNTIME_V1: '1',
      KEEP: 'x',
    }, '/tmp/owned-home', 'isolated')
    expect(env.FRESHELL_MANAGED_RUNTIME_V1).toBeUndefined()
    expect(env.KEEP).toBe('x')
  })

  it('isolates every provider home under the supplied owned home', () => {
    const env = applyIsolatedHomeEnvironment({ HOME: '/real-home', CLAUDE_CONFIG_DIR: '/ambient' }, '/tmp/owned-home')
    expect(env.HOME).toBe('/tmp/owned-home')
    expect(env.FRESHELL_HOME).toBe('/tmp/owned-home')
    expect(env.CLAUDE_HOME).toBe('/tmp/owned-home/.claude')
    expect(env.CODEX_HOME).toBe('/tmp/owned-home/.codex')
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  it('names every caller env key the owned-home isolation would replace or delete', () => {
    expect(homeIsolationConflicts({
      CODEX_HOME: '/tmp/somewhere-else/codex-home',
      CLAUDE_CONFIG_DIR: '/tmp/somewhere-else/claude',
      HOME: '/home/someone',
      FAKE_CODEX_APP_SERVER_BEHAVIOR: '{}',
    }, '/tmp/owned-home')).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME'])
  })

  it('accepts caller env keys that already agree with the owned-home isolation', () => {
    expect(homeIsolationConflicts({
      CODEX_HOME: '/tmp/owned-home/.codex',
      FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES: '1',
      CODEX_CMD: '/tmp/bin/fake-codex',
    }, '/tmp/owned-home')).toEqual([])
  })

  it('does not return a recently issued port to another immediate caller', async () => {
    const candidates = [41231, 41231, 41232]
    const port = await findFreePort(async () => candidates.shift() ?? 41233)
    const second = await findFreePort(async () => candidates.shift() ?? 41233)
    expect([port, second]).toEqual([41231, 41232])
  })
})
