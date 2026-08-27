// Regression test for the findFreePort TOCTOU consumer race (kata f3wp):
// if the picked port is stolen before the spawned freshell-server binds it,
// start() must retry with a fresh port instead of failing the whole fixture.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import { RustServer, GEMINI_STRIP_ENV_PREFIXES } from './rust-server.js'
import { findFreePort } from './server-fixture-support.js'

describe('RustServer.start bind-race retry', () => {
  it('boots on a fresh port when the first picked port is occupied', async () => {
    // Occupy a port and hold it for the duration of the test. Track accepted
    // sockets: the health poll that hits the blocker gets aborted client-side,
    // but undici leaves the pooled TCP connection half-open (empirically: it
    // never closes), and net.Server.close() waits FOREVER for open
    // connections -- without destroying them, teardown hangs until the test
    // timeout (observed: 600 s).
    const blocker = net.createServer()
    const blockerSockets = new Set<net.Socket>()
    blocker.on('connection', (socket) => {
      blockerSockets.add(socket)
      socket.on('close', () => blockerSockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = blocker.address()
    if (!addr || typeof addr === 'string') throw new Error('no blocker port')
    const stolenPort = addr.port

    // Count picker invocations: vitest does NOT typecheck, so an unknown
    // `portPicker` option would be silently ignored pre-implementation and
    // start() would boot on a fresh findFreePort() port -- making the port
    // assertions below pass vacuously. The call-count assertion is what
    // makes this test genuinely RED before the seam exists (f3wp validated).
    let pickerCalls = 0
    const server = new RustServer({
      portPicker: async () => {
        pickerCalls++
        if (pickerCalls === 1) return stolenPort
        return findFreePort()
      },
    })
    try {
      const info = await server.start()
      expect(pickerCalls).toBeGreaterThanOrEqual(2) // seam consumed AND retried
      expect(info.port).not.toBe(stolenPort)
      expect(info.port).not.toBe(3001)
      expect(info.port).not.toBe(3002)
      const res = await fetch(`${info.baseUrl}/api/health`)
      expect(res.ok).toBe(true)
    } finally {
      await server.stop()
      // Destroy the lingering half-open connection (see comment above) so
      // blocker.close() can actually complete.
      for (const socket of blockerSockets) socket.destroy()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  }, 600_000)

  // Regression test for kata f3wp council round 2 (B6): a foreign server that
  // answers /api/health but STALLS on the /api/server-info identity check
  // must be retried like any other bind race, not hard-failed. Before the
  // fix, AbortSignal.timeout()'s TimeoutError didn't match the bindRace
  // classifier, so start() threw immediately with full teardown instead of
  // "failing fast into the next attempt" as its own comment promised.
  it('retries when a foreign server on the picked port stalls the identity check', async () => {
    // A real HTTP server that answers /api/health (so waitForHealth's poll
    // succeeds and boot() proceeds to the identity check) but NEVER responds
    // to /api/server-info -- the request just hangs until our 2s
    // AbortSignal.timeout fires, reproducing the stalled-identity shape.
    const blocker = http.createServer((req, res) => {
      if (req.url === '/api/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      // /api/server-info (or anything else): never respond, never end.
    })
    const blockerSockets = new Set<import('node:net').Socket>()
    blocker.on('connection', (socket) => {
      blockerSockets.add(socket)
      socket.on('close', () => blockerSockets.delete(socket))
    })
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = blocker.address()
    if (!addr || typeof addr === 'string') throw new Error('no blocker port')
    const stolenPort = addr.port

    let pickerCalls = 0
    const server = new RustServer({
      portPicker: async () => {
        pickerCalls++
        if (pickerCalls === 1) return stolenPort
        return findFreePort()
      },
    })
    try {
      const info = await server.start()
      // Retried past the stalled occupier onto a fresh port: proves the
      // TimeoutError was classified as a retryable bind race, not a hard
      // failure.
      expect(pickerCalls).toBeGreaterThanOrEqual(2)
      expect(info.port).not.toBe(stolenPort)
      const res = await fetch(`${info.baseUrl}/api/health`)
      expect(res.ok).toBe(true)
    } finally {
      await server.stop()
      for (const socket of blockerSockets) socket.destroy()
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  }, 600_000)
})

describe('RustServer stripEnvPrefixes', () => {
  // task-008-review M-3 + delta review round 4: the AGENT-24 kilroy lane must
  // prove independence from Gemini-summary availability STRUCTURALLY. The
  // Rust server consumes `GOOGLE_GENERATIVE_AI_API_KEY` (env wins over
  // settings.ai.geminiApiKey, crates/freshell-server/src/main.rs) and the
  // Rust-only `FRESHELL_GEMINI_BASE_URL` endpoint seam; a developer shell can
  // additionally carry `GEMINI_API_KEY` or any other `GEMINI_*` var. NONE may
  // leak into the spawned server — neither through boot()'s `...process.env`
  // spread (inherited keys; an options.env entry can only add/override, never
  // delete) nor through options.env (the scrub runs AFTER the merge).
  // Observed via the child's exec-time /proc/<pid>/environ (Linux). Genuinely
  // RED if GEMINI_STRIP_ENV_PREFIXES lacks any of these names: the probe keys
  // land in the child env.
  it('strips every Gemini credential name from the spawned server, inherited or option-set', async () => {
    expect(process.platform, 'relies on /proc/<pid>/environ').toBe('linux')
    // Exact names + one prefix probe, set as INHERITED keys on this process.
    const inheritedProbes = [
      'GOOGLE_GENERATIVE_AI_API_KEY',
      'GEMINI_API_KEY',
      'GEMINI_FOO', // prefix-strip probe
    ]
    const savedEnv = new Map<string, string | undefined>()
    for (const key of inheritedProbes) {
      savedEnv.set(key, process.env[key])
      process.env[key] = `strip-probe-inherited-${key}`
    }
    // The option-set path: the scrub runs AFTER options.env merges, so an
    // options.env credential must be stripped too. Deliberately NOT inherited
    // (any ambient value is saved and removed) so survival is attributable.
    savedEnv.set('FRESHELL_GEMINI_BASE_URL', process.env.FRESHELL_GEMINI_BASE_URL)
    delete process.env.FRESHELL_GEMINI_BASE_URL
    const server = new RustServer({
      stripEnvPrefixes: [...GEMINI_STRIP_ENV_PREFIXES],
      env: { FRESHELL_GEMINI_BASE_URL: 'strip-probe-option-set' },
    })
    try {
      const info = await server.start()
      const keys = fs
        .readFileSync(`/proc/${info.pid}/environ`, 'utf8')
        .split('\0')
        .map((kv) => kv.split('=', 1)[0])
        .filter(Boolean)
      for (const key of [
        'GOOGLE_GENERATIVE_AI_API_KEY',
        'GEMINI_API_KEY',
        'FRESHELL_GEMINI_BASE_URL',
      ]) {
        expect(keys, `${key} must not survive into the spawned server env`).not.toContain(key)
      }
      expect(
        keys.filter((k) => k.startsWith('GEMINI_')),
        'no GEMINI_* key may survive into the spawned server env',
      ).toEqual([])
    } finally {
      for (const [key, prior] of savedEnv) {
        if (prior === undefined) delete process.env[key]
        else process.env[key] = prior
      }
      await server.stop()
    }
  }, 600_000)
})
