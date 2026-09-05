import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'path'
import { createRequire } from 'node:module'
import { AMBIENT_ENV_POISONS, stripAmbientEnvPoisons } from '../../../config/vitest/sanitize-test-env.js'

const require = createRequire(import.meta.url)
const execFileAsync = promisify(execFile)
const tsxCli = require.resolve('tsx/cli')
const fixture = path.resolve(process.cwd(), 'test/unit/config/fixtures/sanitize-env-child.ts')

// The failure shape under test: AMBIENT shell env + proxy vars. Mechanism
// facts, each pinned by executed probes on 2026-09-02 on this host's repo Node
// (nvm v22.21.1):
//  1. The `[UNDICI-EHPA]` warning is emitted lazily at the FIRST undici
//     dispatch activation (one fetch()), not at process start — the
//     fixture's inner child therefore performs one fetch('data:...').
//  2. Env-proxy honoring differs across supported Node builds (executed:
//     /usr/bin/node on this host does NOT warn at all; nvm v22.21.1 warns
//     ONLY when proxies are set). The negative-control warning assertion is
//     therefore capability-gated on the documented release lines — 22.21.0+
//     on the 22.x line or any 24.x+; Node 23.x never shipped
//     NODE_USE_ENV_PROXY, so `major > 22` must NOT mean "supported"
//     (delta-review r6). The universal
//     control is var-inheritance (deterministic at any version/behavior).
//  3. The fixture's inner child env pins the knobs explicitly — proxies set,
//     NODE_OPTIONS cleared, NODE_USE_ENV_PROXY=1 — so ambient suppression
//     flags can never make the control unfalsifiable.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
const ENV_PROXY_SUPPORTED = (nodeMajor === 22 && nodeMinor >= 21) || nodeMajor >= 24

const POISONED_ENV = {
  HTTP_PROXY: 'http://127.0.0.1:9',
  HTTPS_PROXY: 'http://127.0.0.1:9',
  http_proxy: 'http://127.0.0.1:9',
  https_proxy: 'http://127.0.0.1:9',
  FRESHELL_BIND_HOST: '0.0.0.0',
}

async function runFixture(mode: 'plain' | 'clean', env: NodeJS.ProcessEnv) {
  const spawnEnv = { ...process.env, ...env }
  // The behavioral suite must not inherit a global flag whose whole point is
  // to BEND the sanitizer for a different lane (the opt-in real-provider
  // contract tests) — under a broad `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`
  // run the fixture's 'clean' mode would keep the proxies and contradict its
  // own empty-stderr expectation.
  delete spawnEnv.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS
  const { stdout } = await execFileAsync(process.execPath, [tsxCli, fixture, mode], { env: spawnEnv, maxBuffer: 1024 * 1024 })
  return JSON.parse(stdout) as { innerStderr: string; envReport: Record<string, string | undefined> }
}

describe('stripAmbientEnvPoisons (pure function)', () => {
  it('removes every poison key and returns the removed names', () => {
    const env: NodeJS.ProcessEnv = { ...POISONED_ENV, KEEP_ME: 'yes' }
    const removed = stripAmbientEnvPoisons(env)
    for (const key of AMBIENT_ENV_POISONS) expect(env[key]).toBeUndefined()
    expect(env.KEEP_ME).toBe('yes')
    expect(new Set(removed)).toEqual(new Set(Object.keys(POISONED_ENV)))
  })

  it('keeps proxies but still strips FRESHELL_BIND_HOST when the real-provider escape hatch is exactly "1"', () => {
    const env: NodeJS.ProcessEnv = { ...POISONED_ENV, FRESHELL_RUN_REAL_PROVIDER_CONTRACTS: '1' }
    const removed = stripAmbientEnvPoisons(env)
    expect(removed).not.toContain('HTTPS_PROXY')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:9')
    // The hatch exists only for proxy egress: FRESHELL_BIND_HOST is ALWAYS stripped.
    expect(env.FRESHELL_BIND_HOST).toBeUndefined()
    expect(removed).toContain('FRESHELL_BIND_HOST')
  })

  it('treats any non-"1" value (e.g. "0") as unset — matching the real-provider gate convention', () => {
    const env: NodeJS.ProcessEnv = { ...POISONED_ENV, FRESHELL_RUN_REAL_PROVIDER_CONTRACTS: '0' }
    stripAmbientEnvPoisons(env)
    for (const key of AMBIENT_ENV_POISONS) expect(env[key]).toBeUndefined()
  })
})

describe('sanitize-test-env prelude (behavioral, via spawned node children)', () => {
  it('WITHOUT the prelude, the spawned child inherits the poisoned vars (and, on env-proxy-capable Node, warns)', async () => {
    const { innerStderr, envReport } = await runFixture('plain', POISONED_ENV)
    // Universal control: without the sanitize, children inherit the vars.
    for (const key of Object.keys(POISONED_ENV)) expect(envReport[key]).toBe(POISONED_ENV[key as keyof typeof POISONED_ENV])
    // Mechanism pin where the RUNNER's Node honors env proxies (>= 22.21.0
    // observed default-on; inner env also pins NODE_USE_ENV_PROXY=1 and
    // clears NODE_OPTIONS, so neither ambient suppression nor ambient
    // flags can make this unfalsifiable).
    if (ENV_PROXY_SUPPORTED) expect(innerStderr).toContain('[UNDICI-EHPA]')
  })

  it('WITH the prelude loaded, the spawned node child has no poisoned vars and no stderr noise', async () => {
    const { innerStderr, envReport } = await runFixture('clean', POISONED_ENV)
    expect(innerStderr).toBe('')
    for (const key of AMBIENT_ENV_POISONS) expect(envReport[key]).toBeUndefined()
  })
})
