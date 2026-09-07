/**
 * f0ef pinning coverage: the Limits tile surfaces the cgroup-scope pids pair.
 *
 * Unlike service.test.ts, this file does NOT mock the readers module: the real
 * readers run against the committed test/fixtures/host-stats tree, pinning the
 * readLimitsSection wiring itself (service.ts "pids constraint" branch):
 *   - threaded case: procmini carries 7 numeric top-level dirs (non-leader
 *     threads have no top-level /proc dir) while the cgroup counts 42 tasks;
 *     the tile must show the cgroup-scoped 42, never the /proc walk's 7.
 *   - namespace-divergence case: outside a PID namespace a top-level /proc
 *     walk also sees UNRELATED cgroups' processes; a synthetic 30-dir overlay
 *     inflates the legacy count while the cgroup-scoped pids.current is
 *     unaffected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HostStatsService } from '../../../../server/host-stats/service.js'
import { readPidCount } from '../../../../server/host-stats/readers.js'

// Silence structured logging (same child-logger shape as service.test.ts).
vi.mock('../../../../server/logger.js', () => {
  const child = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() }
  return { logger: { child: () => child }, __childLogger: child }
})

// Same fake-monitor pattern as service.test.ts (event-loop section contract
// is out of scope here; the real monitor would still work).
vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: vi.fn(() => ({
    enable: vi.fn(), disable: vi.fn(), reset: vi.fn(), percentile: vi.fn(() => 3_200_000),
  })),
}))

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, '../../../fixtures/host-stats')
const PROMINI = path.join(FIXTURES, 'procmini') // 7 numeric dirs + self/cgroup
const SYS = path.join(FIXTURES, 'sys') // …/fs/cgroup/…/freshell-rust.service/{pids.current=42, pids.max=10854}

let services: HostStatsService[] = []
let tmpDirs: string[] = []

function makeWiredService(procRoot: string): HostStatsService {
  const service = new HostStatsService({ procRoot, sysRoot: SYS, fastMs: 2000, slowMs: 5000 })
  services.push(service)
  return service
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  for (const service of services) service.stop()
  services = []
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
  vi.useRealTimers()
})

describe('limits tile: cgroup-scoped pids pair through the real readers', () => {
  it('surfaces pids.current=42 from the committed threaded fixture, not the 7-dir /proc count', () => {
    // Threaded divergence the kata names: group accounting counts TIDs (42),
    // top-level /proc iteration sees only thread leaders (7).
    expect(readPidCount(PROMINI)).toBe(7)
    const service = makeWiredService(PROMINI)
    service.start()
    vi.advanceTimersByTime(5000) // first slow tick populates limits
    expect(service.getSnapshot().live.limits).toEqual({
      available: true,
      fdsUsed: null,
      fdsMax: null,
      pidsUsed: 42,
      pidsMax: 10854,
      timeWait: null,
      ephemeralPorts: null,
    })
  })

  it('stays cgroup-scoped when unrelated processes inflate the /proc walk (30 dirs)', () => {
    // Namespace-divergence the kata names: outside a PID namespace the legacy
    // count includes OTHER cgroups' processes; pids.current does not.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'freshell-f0ef-pids-'))
    tmpDirs.push(tmp)
    const tmpProc = path.join(tmp, 'proc')
    fs.mkdirSync(path.join(tmpProc, 'self'), { recursive: true })
    fs.copyFileSync(path.join(PROMINI, 'self', 'cgroup'), path.join(tmpProc, 'self', 'cgroup'))
    for (let pid = 9000; pid < 9030; pid += 1) fs.mkdirSync(path.join(tmpProc, String(pid)))
    expect(readPidCount(tmpProc)).toBe(30)
    const service = makeWiredService(tmpProc)
    service.start()
    vi.advanceTimersByTime(5000)
    expect(service.getSnapshot().live.limits.pidsUsed).toBe(42)
    expect(service.getSnapshot().live.limits.pidsMax).toBe(10854)
  })
})
