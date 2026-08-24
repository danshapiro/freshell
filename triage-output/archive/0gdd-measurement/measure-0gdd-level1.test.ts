// @vitest-environment node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AuthenticatedClient,
  BoundaryTracker,
  CleanupOwner,
  EventReader,
  FreshnessTimeoutError,
  JsonlTail,
  assertFreshRelease,
  assertSafePort,
  assertScratchListener,
  assertServerInfo,
  buildEnvironment,
  buildStageA,
  buildVariants,
  cacheSeenInBracket,
  checkpointOutput,
  copyRegularPrivate,
  cpuPercent,
  createRoots,
  finalizeOutput,
  freshnessFailure,
  freshnessRoute,
  isMaterial,
  isStable,
  parseProcIo,
  parseProcListeners,
  parseProcStat,
  parseProcStatus,
  reduceEvent,
  requireFingerprint,
  requireProductionState,
  runMeasurementSchedules,
  runOrchestration,
  validateRun,
  validateEvidence,
  withFreshnessCheckpoint,
  type ActiveRun,
  type Condition,
  type FreshnessFailure,
  type ListenerIdentity,
  type Summary,
} from '../../../scripts/measure-0gdd-level1.js'

const controls = { sweep: true, autoTitle: true, refresh: 'normal' as const, cacheWrites: true }
const temporary: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(temporary.splice(0).map((entry) => fsp.rm(entry, { recursive: true, force: true })))
})

describe('0gdd Level 1 measurement primitives', () => {
  it('parses proc aggregates, including command names with spaces and parentheses', () => {
    const fields = Array(49).fill('0')
    fields[10] = '20'; fields[11] = '7'; fields[18] = '12345'
    expect(parseProcStat(`42 (freshell (worker) one) S ${fields.join(' ')}`)).toEqual({ ticks: 27, startTime: '12345' })
    expect(parseProcStatus('VmRSS:\t10 kB\nVmHWM:\t14 kB\nThreads:\t8\n')).toEqual({ rssKb: 10, hwmKb: 14, threads: 8 })
    expect(parseProcIo('read_bytes: 3\nwrite_bytes: 5\nsyscr: 7\nsyscw: 11\n')).toEqual({ readBytes: 3, writeBytes: 5, syscr: 7, syscw: 11 })
    expect(cpuPercent(100, 150, 100, 5)).toBe(10)
  })

  it('uses a minimal child environment while retaining only provider-home variables', () => {
    const env = buildEnvironment({
      PATH: '/bin', HOME: '/real', CLAUDE_HOME: '/claude', CODEX_HOME: '/codex',
      FRESHELL_AMPLIFIER_HOME: '/amplifier', XDG_DATA_HOME: '/xdg',
      GOOGLE_GENERATIVE_AI_API_KEY: 'secret', AWS_SECRET_ACCESS_KEY: 'secret',
      FRESHELL_TEST_CONTROL: 'forbidden',
    }, '/private', 3456, 'token', { ...controls, sweep: false, refresh: '10s', cacheWrites: false })
    expect(env).toEqual(expect.objectContaining({
      PATH: '/bin', HOME: '/real', CLAUDE_HOME: '/claude', CODEX_HOME: '/codex',
      FRESHELL_AMPLIFIER_HOME: '/amplifier', XDG_DATA_HOME: '/xdg',
      FRESHELL_HOME: '/private', FRESHELL_BIND_HOST: '127.0.0.1', AUTH_TOKEN: 'token',
      FRESHELL_0GDD_LEVEL1: '1', FRESHELL_0GDD_SESSION_SWEEP: 'off',
      FRESHELL_0GDD_REFRESH_MODE: '10s', FRESHELL_0GDD_CACHE_WRITES: 'off',
    }))
    expect(env).not.toHaveProperty('GOOGLE_GENERATIVE_AI_API_KEY')
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(env).not.toHaveProperty('FRESHELL_TEST_CONTROL')
  })

  it('rejects unsafe ports and every changed process fingerprint field', () => {
    expect(() => assertSafePort(3001)).toThrow()
    expect(() => assertSafePort(3456)).not.toThrow()
    const expected = { pid: 4, startTime: '1', executable: '/bin/f', cwd: '/work', inode: '1:2' }
    expect(() => requireFingerprint(expected, expected)).not.toThrow()
    for (const [key, value] of Object.entries({ pid: 5, startTime: '2', executable: '/bin/x', cwd: '/x', inode: '3:4' })) {
      expect(() => requireFingerprint(expected, { ...expected, [key]: value })).toThrow(key)
    }
  })

  it('uses separate scratch and production listener policies', () => {
    const scratch: ListenerIdentity = { address: '127.0.0.1', port: 3456, pid: 42, inode: 'socket-1' }
    expect(assertScratchListener([scratch], 3456, 42)).toEqual(scratch)
    expect(() => assertScratchListener([], 3456, 42)).toThrow('missing')
    expect(() => assertScratchListener([{ ...scratch, address: '0.0.0.0' }], 3456, 42)).toThrow('loopback')
    expect(() => assertScratchListener([{ ...scratch, pid: 43 }], 3456, 42)).toThrow('ownership')
    expect(() => assertScratchListener([scratch, { ...scratch, inode: 'socket-2' }], 3456, 42)).toThrow('exactly one')

    const process = { pid: 7, startTime: '1', executable: '/bin/f', cwd: '/work', inode: '1:2' }
    const production = { process, listener: { address: '0.0.0.0', port: 3001, pid: 7, inode: 'prod-socket' } }
    expect(() => requireProductionState(production, production)).not.toThrow()
    expect(() => requireProductionState(production, { ...production, listener: { ...production.listener, pid: 8 } })).toThrow('pid')
    expect(() => requireProductionState(production, { ...production, listener: { ...production.listener, address: '127.0.0.1' } })).toThrow('address')
  })

  it('parses Linux proc TCP listeners without requiring ss', () => {
    const tcp = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0D80 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 12345 1',
      '   1: 00000000:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 67890 1',
    ].join('\n')
    expect(parseProcListeners(tcp)).toEqual([
      { address: '127.0.0.1', port: 3456, inode: '12345' },
      { address: '0.0.0.0', port: 3001, inode: '67890' },
    ])
  })

  it('requires fresh release provenance from the running Rust binary', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), '0gdd-provenance-')); temporary.push(root)
    const source = path.join(root, 'source.rs'); const binary = path.join(root, 'freshell-server')
    await fsp.writeFile(source, 'source'); await fsp.writeFile(binary, 'binary')
    const now = new Date(); await fsp.utimes(source, now, now); await fsp.utimes(binary, new Date(now.getTime() + 1000), new Date(now.getTime() + 1000))
    expect(() => assertFreshRelease(binary, [source])).not.toThrow()
    await fsp.utimes(source, new Date(now.getTime() + 2000), new Date(now.getTime() + 2000))
    expect(() => assertFreshRelease(binary, [source])).toThrow('stale')
    expect(() => assertServerInfo({ runtime: 'rust', commit: 'abc', buildDirty: true }, 'abc', true)).not.toThrow()
    expect(() => assertServerInfo({ runtime: 'node', commit: 'abc', buildDirty: true }, 'abc', true)).toThrow('runtime')
    expect(() => assertServerInfo({ runtime: 'rust', commit: 'def', buildDirty: true }, 'abc', true)).toThrow('commit')
    expect(() => assertServerInfo({ runtime: 'rust', commit: 'abc', buildDirty: false }, 'abc', true)).toThrow('dirty')
  })

  it('keeps redirects and complete response bodies inside the authenticated timeout', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/redirect') { response.writeHead(302, { location: '/elsewhere' }); response.end() }
      if (request.url === '/json') { response.setHeader('content-type', 'application/json'); response.end('{"ok":true}') }
      if (request.url === '/slow-body') { response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.write('partial') }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test listener missing')
    const before = { listenerVerifications: 0, authenticatedRequests: 0, authenticatedRequestsBeforeVerification: 0 }
    const unverified = new AuthenticatedClient(address.port, 'token', before)
    await expect(unverified.json('/json', 100)).rejects.toThrow('before listener verification')
    expect(before).toEqual({ listenerVerifications: 0, authenticatedRequests: 1, authenticatedRequestsBeforeVerification: 1 })
    const counters = { listenerVerifications: 0, authenticatedRequests: 0, authenticatedRequestsBeforeVerification: 0 }
    const client = new AuthenticatedClient(address.port, 'token', counters)
    client.verifyListener({ address: '127.0.0.1', port: address.port, pid: 42, inode: 'socket' })
    try {
      await expect(client.json('/json', 100)).resolves.toEqual({ ok: true })
      await expect(client.bytes('/redirect', 100)).rejects.toThrow('redirect')
      await expect(client.bytes('/slow-body', 20)).rejects.toThrow()
      expect(counters).toEqual({ listenerVerifications: 1, authenticatedRequests: 3, authenticatedRequestsBeforeVerification: 0 })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('copies only a regular non-symlink cache and makes the copy private', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), '0gdd-cache-')); temporary.push(root)
    const source = path.join(root, 'source'); const link = path.join(root, 'link'); const copy = path.join(root, 'copy')
    await fsp.writeFile(source, 'cache'); await fsp.symlink(source, link)
    await expect(copyRegularPrivate(link, copy)).rejects.toThrow('symlink')
    await copyRegularPrivate(source, copy)
    expect(await fsp.readFile(copy, 'utf8')).toBe('cache')
    expect((await fsp.stat(copy)).mode & 0o777).toBe(0o600)
  })

  it('tails complete JSONL records by byte offset and retains a partial trailing line', () => {
    const tail = new JsonlTail()
    expect(tail.push(Buffer.from('{"event":"one"}\n{"event":"tw'))).toEqual([{ event: 'one' }])
    expect(tail.offset).toBe(Buffer.byteLength('{"event":"one"}\n'))
    expect(tail.push(Buffer.from('o"}\n'))).toEqual([{ event: 'two' }])
    expect(() => tail.push(Buffer.from('{bad}\n'))).toThrow('invalid JSONL')
  })

  it('loops EventReader short reads and advances only by bytes actually read', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), '0gdd-short-read-')); temporary.push(root)
    const contents = Buffer.from('{"event":"one"}\n{"event":"two"}\n')
    await fsp.writeFile(path.join(root, 'events.jsonl'), contents)
    const reader = new EventReader(root, async () => ({
      read: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const bytesRead = Math.min(2, length, contents.length - position)
        if (bytesRead > 0) contents.copy(buffer, offset, position, position + bytesRead)
        return { bytesRead }
      },
      close: async () => {},
    }))
    await expect(reader.read()).resolves.toEqual([{ event: 'one' }, { event: 'two' }])
    await expect(reader.read()).resolves.toEqual([])
  })

  it('strictly balances refresh/save events and requires a stable clean interval', () => {
    const tracker = new BoundaryTracker()
    tracker.observe({ event: '0gdd.index_refresh_started', refresh_id: 2 }, 0)
    expect(() => tracker.observe({ event: '0gdd.index_refresh_started', refresh_id: 2 }, 1)).toThrow('duplicate')
    tracker.observe({ event: '0gdd.cache_save_started', save_id: 3 }, 2)
    tracker.observe({ event: '0gdd.index_refresh_finished', refresh_id: 2 }, 3)
    tracker.observe({ event: '0gdd.cache_save_finished', save_id: 3 }, 4)
    expect(tracker.stablyClean(1003, 1000)).toBe(false)
    expect(tracker.stablyClean(1004, 1000)).toBe(true)
    expect(() => tracker.observe({ event: '0gdd.cache_save_finished', save_id: 3 }, 5)).toThrow('unmatched')
  })

  it('cleans an active scratch run even when the production fingerprint changed', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), '0gdd-cleanup-'))
    const run = path.join(root, 'run'); await fsp.mkdir(run, { mode: 0o700 })
    const descriptor = fs.openSync(path.join(run, 'stdio.log'), 'w', 0o600)
    const expected = { pid: 4, startTime: '1', executable: '/bin/f', cwd: '/work', inode: '1:2' }
    const prod = { process: expected, listener: { address: '0.0.0.0', port: 3001, pid: 4, inode: 'prod' } }
    const owner = new CleanupOwner(root, null, prod, {
      readProduction: () => ({ ...prod, process: { ...expected, startTime: '2' } }),
      stopActive: async () => ({ kind: 'graceful' }),
    })
    owner.active = {
      child: {} as ActiveRun['child'], fp: expected, port: 3456, descriptor, dir: run,
      listener: { address: '127.0.0.1', port: 3456, pid: 4, inode: 'scratch' },
    }
    await expect(owner.cleanup()).rejects.toThrow('outer cleanup failed')
    expect(owner.active).toBeNull()
    expect(fs.existsSync(root)).toBe(false)
  })

  it.each([
    ['already-exited', { kind: 'already-exited' as const }, 1, 0],
    ['forced-kill', { kind: 'forced' as const }, 0, 1],
  ])('cleans private state after %s and marks the run invalid', async (_name, outcome, alreadyExited, forcedKills) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), '0gdd-stop-state-'))
    const run = path.join(root, 'run'); await fsp.mkdir(run, { mode: 0o700 })
    const descriptor = fs.openSync(path.join(run, 'stdio.log'), 'w', 0o600)
    const owner = new CleanupOwner(root, null, null, { stopActive: async () => outcome })
    owner.active = {
      child: {} as ActiveRun['child'],
      fp: { pid: 4, startTime: '1', executable: '/bin/f', cwd: '/work', inode: '1:2' },
      port: 3456, descriptor, dir: run,
      listener: { address: '127.0.0.1', port: 3456, pid: 4, inode: 'scratch' },
    }
    await owner.cleanup()
    expect(owner.active).toBeNull()
    expect(owner.invalidRuns).toBe(1)
    expect(owner.alreadyExited).toBe(alreadyExited)
    expect(owner.forcedKills).toBe(forcedKills)
    expect(fs.existsSync(root)).toBe(false)
    expect(() => fs.fstatSync(descriptor)).toThrow()
  })

  it('accepts actual diagnostic schemas and rejects malformed lifecycle records', () => {
    const events = [
      { event: '0gdd.index_refresh_started', refresh_id: 1 },
      { event: '0gdd.index_source', refresh_id: 1, provider: 'claude', duration_ms: 2, discovered: 3, parsed: 1, rows: 3, scan_failed: false },
      { event: '0gdd.cache_save_started', save_id: 4, entries: 3 },
      { event: '0gdd.index_refresh_finished', refresh_id: 1, duration_ms: 4, source_duration_ms: 2, rebuild_duration_ms: 1, sort_duration_ms: 1, discovered: 3, parsed: 1, rows: 3, changed: 1, scan_failure_count: 0, loaded_cache_entries: 2 },
      { event: '0gdd.cache_save_finished', save_id: 4, duration_ms: 1, bytes: 20, ok: true },
      { event: '0gdd.sessions_sweep', duration_ms: 2, rows: 3, identity_count: 0, changed: false },
      { event: '0gdd.auto_title_sweep', duration_ms: 2, rows: 3, identity_count: 0 },
    ]
    for (const event of events) expect(reduceEvent(event)).not.toBeNull()
    expect(() => reduceEvent({ event: '0gdd.index_refresh_started' })).toThrow('refresh_id')
    expect(reduceEvent({ event: 'unrelated', token: 'secret' })).toBeNull()
  })

  it('runs independent absolute schedules, skips missed GET slots, and awaits slow requests', async () => {
    vi.useFakeTimers()
    const samples: number[] = []; const gets: number[] = []
    const promise = runMeasurementSchedules({
      durationMs: 5000,
      now: Date.now,
      sample: async (at) => { samples.push(at) },
      get: async (at) => { gets.push(at); await new Promise((resolve) => setTimeout(resolve, 2500)) },
    })
    await vi.advanceTimersByTimeAsync(7000); await promise
    expect(samples).toEqual([0, 1000, 2000, 3000, 4000])
    expect(gets).toEqual([0, 4000])
    expect(gets.every((at, index) => index === 0 || at - gets[index - 1] >= 2000)).toBe(true)
  })

  it('supports the exact GET cadence and a zero-GET condition', async () => {
    vi.useFakeTimers()
    const gets: number[] = []
    const enabled = runMeasurementSchedules({ durationMs: 5000, now: Date.now, sample: async () => {}, get: async (at) => { gets.push(at) } })
    await vi.advanceTimersByTimeAsync(5000); await enabled
    expect(gets).toEqual([0, 2000, 4000])
    const disabled = runMeasurementSchedules({ durationMs: 3000, now: Date.now, sample: async () => {} })
    await vi.advanceTimersByTimeAsync(3000); await disabled
  })

  it('schedules exactly 150 samples and 75 requests in a fake 150-second run', async () => {
    vi.useFakeTimers()
    let samples = 0; let requests = 0
    const measurement = runMeasurementSchedules({
      durationMs: 150_000, now: Date.now,
      sample: async () => { samples++ },
      get: async () => { requests++ },
    })
    await vi.advanceTimersByTimeAsync(150_000)
    await measurement
    expect({ samples, requests }).toEqual({ samples: 150, requests: 75 })
  })

  it('keeps the measurement window open for its full monotonic duration', async () => {
    vi.useFakeTimers()
    let completed = false
    const measurement = runMeasurementSchedules({ durationMs: 5000, now: Date.now, sample: async () => {} }).then(() => { completed = true })
    await vi.advanceTimersByTimeAsync(4999)
    expect(completed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await measurement
    expect(completed).toBe(true)
  })

  it('covers decision-tree gates and exact stability/materiality thresholds', () => {
    expect(buildStageA().map((r) => r.name)).toEqual(['normal-1', 'quiet', 'normal-2'])
    expect(isStable(100, 115)).toBe(true)
    expect(isStable(100, 116.22)).toBe(false)
    expect(isMaterial(50, 45, 50)).toBe(true)
    expect(isMaterial(50, 45.01, 50)).toBe(false)
    expect(buildVariants(false, true, true)).toEqual([])
    const base = buildVariants(true, false, false).map((r) => r.name)
    expect(base).toEqual(['normal-1', 'warm-only', 'normal-2', 'auto-title-off', 'normal-3', 'session-sweep-off', 'normal-4', 'get-off', 'normal-5'])
    expect(buildVariants(true, true, true).map((r) => r.name)).toEqual([...base, 'cache-normal-1', 'cache-writes-off', 'cache-normal-2', 'refresh-normal-1', 'refresh-10s', 'refresh-normal-2', 'freshness'])
    expect(buildVariants(true, true, false).map((r) => r.name)).toEqual([...base, 'cache-normal-1', 'cache-writes-off', 'cache-normal-2'])
    expect(buildVariants(true, false, true).map((r) => r.name)).toEqual([...base, 'refresh-normal-1', 'refresh-10s', 'refresh-normal-2', 'freshness'])
    expect(cacheSeenInBracket({ cache_saves: 1 }, { cache_saves: 0 })).toBe(true)
    expect(cacheSeenInBracket({ cache_saves: 0 }, { cache_saves: 0 })).toBe(false)
  })

  it('executes the orchestration early-stop, retry, save, and freshness branches', async () => {
    const summary = (name: string, cpu: number, cache_saves = 0): Summary => ({ name, cpu, cache_saves, elapsed: 150, samples: 150, requests: 75 })
    const scripted = (values: Array<[number, number?]>) => {
      const names: string[] = []
      const run = async (condition: { name: string }) => {
        names.push(condition.name)
        const [cpu, saves = 0] = values.shift() ?? (() => { throw new Error('unexpected condition') })()
        return summary(condition.name, cpu, saves)
      }
      return { names, run }
    }

    const immaterial = scripted([[40], [38], [41]])
    await expect(runOrchestration(immaterial.run, immaterial.run)).resolves.toHaveLength(3)
    expect(immaterial.names).toEqual(['normal-1', 'quiet', 'normal-2'])

    const unstable = scripted([[100], [40], [130], [100], [40], [130]])
    await expect(runOrchestration(unstable.run, unstable.run)).rejects.toThrow('inconclusive unstable bracket')
    expect(unstable.names).toEqual([...buildStageA(), ...buildStageA()].map((condition) => condition.name))

    const materialNoSave = scripted([[50], [40], [50], [50], [49], [50], [50], [50], [50], [50], [50], [50]])
    await expect(runOrchestration(materialNoSave.run, materialNoSave.run)).resolves.toHaveLength(12)
    expect(materialNoSave.names).not.toContain('cache-writes-off')
    expect(materialNoSave.names).not.toContain('refresh-10s')

    const saveEnabled = scripted([[50, 1], [40], [50], [50], [49], [50], [50], [50], [50], [50], [50], [50], [50], [50], [50]])
    await expect(runOrchestration(saveEnabled.run, saveEnabled.run)).resolves.toHaveLength(15)
    expect(saveEnabled.names.slice(-3)).toEqual(['cache-normal-1', 'cache-writes-off', 'cache-normal-2'])

    const costly = scripted([
      [50], [40], [50],
      [50], [40], [50], [50], [50], [50], [50], [50], [50],
      [50], [40], [50],
    ])
    const freshnessNames: string[] = []
    const costlyResults = await runOrchestration(costly.run, async (condition) => {
      freshnessNames.push(condition.name)
      return { ...summary(condition.name, 0), requests: 0, samples: 0, elapsed: 0, freshness_delays: [1] }
    })
    expect(costlyResults).toHaveLength(17)
    expect(costly.names.slice(-3)).toEqual(['refresh-normal-1', 'refresh-10s', 'refresh-normal-2'])
    expect(freshnessNames).toEqual(['freshness-normal', 'freshness-10s'])
  })

  it('enforces exact long-run validity boundaries', () => {
    const valid: Summary = { name: 'normal', cpu: 50, elapsed: 145, samples: 145, requests: 73, cache_saves: 0 }
    expect(() => validateRun(valid, 150, true)).not.toThrow()
    expect(() => validateRun({ ...valid, elapsed: 180, samples: 151, requests: 76 }, 150, true)).not.toThrow()
    for (const invalid of [
      { ...valid, elapsed: 144.999 },
      { ...valid, elapsed: 180.001 },
      { ...valid, samples: 144 },
      { ...valid, samples: 152 },
      { ...valid, requests: 72 },
      { ...valid, requests: 77 },
    ]) expect(() => validateRun(invalid, 150, true)).toThrow('invalid run')
    expect(() => validateRun({ ...valid, requests: 0 }, 150, false)).not.toThrow()
    expect(() => validateRun({ ...valid, requests: 1 }, 150, false)).toThrow('invalid run')
    expect(() => validateRun({ ...valid, elapsed: 3, samples: 3, requests: 0 }, 3, false)).not.toThrow()
  })

  it('rejects embedded tokens, absolute paths, forbidden nested fields, and every retained event leak', () => {
    const token = '0123456789abcdef'
    expect(() => validateEvidence({ run: 'normal', rows: 1 }, token)).not.toThrow()
    for (const value of [
      { cwd: 'x' }, { nested: { headers: {} } }, { run: '/home/private' },
      { run: `prefix-${token}-suffix` }, { run: 'see /home/private/cache now' },
      { events: [{ body: 'x' }] },
    ]) expect(() => validateEvidence(value, token)).toThrow()
    const retained = [
      { event: '0gdd.index_refresh_started', refresh_id: 1 },
      { event: '0gdd.index_source', refresh_id: 1, provider: 'claude', duration_ms: 1, discovered: 2, parsed: 1, rows: 2, scan_failed: false, source_file: '/secret' },
      { event: '0gdd.index_refresh_finished', refresh_id: 1, duration_ms: 2, source_duration_ms: 1, rebuild_duration_ms: 0, sort_duration_ms: 0, discovered: 2, parsed: 1, rows: 2, changed: 1, scan_failure_count: 0, loaded_cache_entries: 1 },
      { event: '0gdd.cache_save_started', save_id: 1, entries: 2 },
      { event: '0gdd.cache_save_finished', save_id: 1, duration_ms: 1, bytes: 2, ok: true },
      { event: '0gdd.sessions_sweep', duration_ms: 1, rows: 2, identity_count: 0, changed: false },
      { event: '0gdd.auto_title_sweep', duration_ms: 1, rows: 2, identity_count: 0 },
    ].map((event) => reduceEvent(event)).filter(Boolean)
    expect(() => validateEvidence(retained, token)).not.toThrow()
    expect(JSON.stringify(retained)).not.toContain('/secret')
  })

  it('probes freshness with includeNonInteractive so single-message fixtures are visible', () => {
    expect(freshnessRoute()).toBe('/api/session-directory?priority=visible&limit=50&includeNonInteractive=1')
    expect(new URL(`http://127.0.0.1${freshnessRoute()}`).searchParams.get('includeNonInteractive')).toBe('1')
  })

  it('retains only fixed sanitized fields for an inconclusive freshness timeout', () => {
    const diagnostics = {
      mode: '10s' as const, fixtureOrdinal: 2, oldCount: 3, lastCount: 3, elapsedMs: 30_000.4,
      error: new Error('freshness timeout at /home/private/.claude'), token: '0123456789abcdef',
      route: '/api/session-directory?priority=visible', body: 'fixture 2',
    }
    const failure = freshnessFailure(diagnostics)
    expect(failure).toEqual({ status: 'inconclusive', mode: '10s', fixture_ordinal: 2, old_count: 3, last_count: 3, elapsed_ms: 30_000 })
    expect(Object.keys(failure).sort()).toEqual(['elapsed_ms', 'fixture_ordinal', 'last_count', 'mode', 'old_count', 'status'])
    expect(() => validateEvidence(failure, diagnostics.token)).not.toThrow()
    expect(() => validateEvidence({ ...failure, error: 'freshness timeout' }, diagnostics.token)).toThrow()
    expect(() => validateEvidence({ ...failure, detail: '/home/private/.claude' }, diagnostics.token)).toThrow()
    expect(() => validateEvidence({ ...failure, detail: diagnostics.token }, diagnostics.token)).toThrow()
  })

  it('reports the inconclusive freshness diagnostics in the thrown error message', () => {
    const token = '0123456789abcdef'
    const failure = freshnessFailure({ mode: '10s', fixtureOrdinal: 2, oldCount: 3, lastCount: 3, elapsedMs: 30_000.4 })
    const error = new FreshnessTimeoutError(failure)
    expect(error.message).toBe('freshness timeout: mode=10s fixture_ordinal=2 old_count=3 last_count=3 elapsed_ms=30000')
    expect(error.failure).toEqual(failure)
    // The message is a diagnostic only: it must carry nothing the evidence sanitizer would reject.
    expect(() => validateEvidence({ diagnostic: error.message }, token)).not.toThrow()
    expect(new FreshnessTimeoutError(freshnessFailure({ mode: 'warm-only', fixtureOrdinal: 1, oldCount: 0, lastCount: 0, elapsedMs: 12.6 })).message)
      .toBe('freshness timeout: mode=warm-only fixture_ordinal=1 old_count=0 last_count=0 elapsed_ms=13')
  })

  it('completes with inconclusive freshness on the typed timeout but still fails on unexpected errors', async () => {
    const cpuBracket = (): number[] => [50, 40, 50, 50, 40, 50, 50, 50, 50, 50, 50, 50, 50, 40, 50]
    const scriptedRun = (values: number[]) => async (condition: Condition): Promise<Summary> => {
      const cpu = values.shift()
      if (cpu === undefined) throw new Error('unexpected condition')
      return { name: condition.name, cpu, elapsed: 150, samples: 150, requests: 75, cache_saves: 0 }
    }
    const failure = freshnessFailure({ mode: 'normal', fixtureOrdinal: 1, oldCount: 1, lastCount: 1, elapsedMs: 30_000 })
    const recorded: FreshnessFailure[] = []
    const attempted: string[] = []
    const results = await runOrchestration(
      scriptedRun(cpuBracket()),
      async (condition) => { attempted.push(condition.name); throw new FreshnessTimeoutError(failure) },
      (entry) => recorded.push(entry),
    )
    expect(results).toHaveLength(15)
    expect(recorded).toEqual([failure])
    expect(attempted).toEqual(['freshness-normal'])

    await expect(runOrchestration(
      scriptedRun(cpuBracket()),
      async () => { throw new Error('scratch warm-up timeout') },
      (entry) => recorded.push(entry),
    )).rejects.toThrow('scratch warm-up timeout')
    expect(recorded).toHaveLength(1)
  })

  it('checkpoints CPU evidence exactly once before the first freshness run', async () => {
    const order: string[] = []
    const condition = (name: string) => ({ name, ...controls, get: true }) as Condition
    const runFreshness = withFreshnessCheckpoint(
      async () => { await Promise.resolve(); order.push('checkpoint') },
      async ({ name }) => { order.push(name); return { name, cpu: 0, elapsed: 0, samples: 0, requests: 0, cache_saves: 0, freshness_delays: [1] } },
    )
    await runFreshness(condition('freshness-normal'))
    await runFreshness(condition('freshness-10s'))
    expect(order).toEqual(['checkpoint', 'freshness-normal', 'freshness-10s'])
  })

  it('copies CPU evidence to a private output outside the raw root that survives cleanup', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), '0gdd-checkpoint-raw-')); temporary.push(root)
    const output = await fsp.mkdtemp(path.join(os.tmpdir(), '0gdd-checkpoint-out-')); temporary.push(output)
    const runs = path.join(root, 'output/runs')
    await fsp.mkdir(runs, { recursive: true, mode: 0o700 })
    await fsp.writeFile(path.join(runs, 'normal-1.summary.jsonl'), '{"name":"normal-1","cpu":50}\n', { mode: 0o600 })
    const copied = new Set<string>()
    const relative = path.join('runs', 'normal-1.summary.jsonl')
    await expect(checkpointOutput(path.join(root, 'output'), output, copied)).resolves.toEqual([relative])
    await expect(checkpointOutput(path.join(root, 'output'), output, copied)).resolves.toEqual([])
    expect((await fsp.stat(path.join(output, relative))).mode & 0o777).toBe(0o600)
    expect((await fsp.stat(path.join(output, 'runs'))).mode & 0o777).toBe(0o700)
    await new CleanupOwner(root, null, null).cleanup()
    expect(fs.existsSync(root)).toBe(false)
    expect(await fsp.readFile(path.join(output, relative), 'utf8')).toBe('{"name":"normal-1","cpu":50}\n')
  })

  it('removes a final output that holds no checkpoint evidence and keeps one that does', async () => {
    const empty = await fsp.mkdtemp(path.join(os.tmpdir(), '0gdd-final-empty-')); temporary.push(empty)
    await expect(finalizeOutput(empty)).resolves.toBe(false)
    expect(fs.existsSync(empty)).toBe(false)

    const skeleton = await fsp.mkdtemp(path.join(os.tmpdir(), '0gdd-final-skeleton-')); temporary.push(skeleton)
    await fsp.mkdir(path.join(skeleton, 'runs'), { recursive: true, mode: 0o700 })
    await expect(finalizeOutput(skeleton)).resolves.toBe(false)
    expect(fs.existsSync(skeleton)).toBe(false)

    await expect(finalizeOutput(path.join(empty, 'never-created'))).resolves.toBe(false)

    const kept = await fsp.mkdtemp(path.join(os.tmpdir(), '0gdd-final-kept-')); temporary.push(kept)
    await fsp.mkdir(path.join(kept, 'runs'), { recursive: true, mode: 0o700 })
    await fsp.writeFile(path.join(kept, 'runs/normal-1.summary.jsonl'), '{"name":"normal-1","cpu":50}\n', { mode: 0o600 })
    await expect(finalizeOutput(kept)).resolves.toBe(true)
    expect(await fsp.readFile(path.join(kept, 'runs/normal-1.summary.jsonl'), 'utf8')).toBe('{"name":"normal-1","cpu":50}\n')

    await fsp.chmod(path.join(kept, 'runs'), 0o755)
    await expect(finalizeOutput(kept)).rejects.toThrow('non-private')
    expect(fs.existsSync(path.join(kept, 'runs/normal-1.summary.jsonl'))).toBe(true)
  })

  it('never strands the raw root when the final output root cannot be created', async () => {
    const parent = await fsp.mkdtemp(path.join(os.tmpdir(), '0gdd-roots-')); temporary.push(parent)
    const makeRaw = async (name: string) => {
      const root = path.join(parent, name); await fsp.mkdir(root, { mode: 0o700 }); return root
    }
    await expect(createRoots(() => makeRaw('raw-ok'), async () => await makeRaw('output-ok')))
      .resolves.toEqual({ root: path.join(parent, 'raw-ok'), output: path.join(parent, 'output-ok') })

    await expect(createRoots(() => makeRaw('raw-orphan'), async () => { throw new Error('test output root already exists') }))
      .rejects.toThrow('test output root already exists')
    expect(fs.existsSync(path.join(parent, 'raw-orphan'))).toBe(false)

    await expect(createRoots(async () => { throw new Error('test root already exists') }, async () => await makeRaw('output-orphan')))
      .rejects.toThrow('test root already exists')
    expect(fs.existsSync(path.join(parent, 'output-orphan'))).toBe(false)
  })
})
