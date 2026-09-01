/**
 * Behavioral tests for HostStatsService
 * (docs/plans/2026-08-25-host-pressure-pane.md, Task 3 contract lines 411–490).
 *
 * The readers module is a full-module mock (one vi.fn() per reader): these tests assert
 * the SERVICE contract — two-tier cadence, delta-rate math over cumulative counters,
 * cgroup-aware memory precedence, darwin branching without /proc reads, refresh
 * single-flight + post-completion cooldown + cooperative section budgets + overall
 * watchdog. vi.useFakeTimers() drives both the intervals and Date.now() (the dt basis).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import { HostStatsLiveSchema, HostStatsManualSchema } from '../../../../shared/ws-protocol.js'
import * as readersMock from '../../../../server/host-stats/readers.js'
import * as loggerModule from '../../../../server/logger.js'
import { HostStatsService, type HostStatsServiceDeps } from '../../../../server/host-stats/service.js'

vi.mock('../../../../server/host-stats/readers.js', () => {
  class DeadlineExceeded extends Error {
    constructor(message = 'host-stats section deadline exceeded') {
      super(message)
      this.name = 'DeadlineExceeded'
    }
  }
  return {
    DeadlineExceeded,
    readCpuTimes: vi.fn(),
    readLoadavg: vi.fn(),
    readMeminfo: vi.fn(),
    readCgroupMemory: vi.fn(),
    readVmstat: vi.fn(),
    readPsi: vi.fn(),
    readDiskStats: vi.fn(),
    readNetDev: vi.fn(),
    readTcpStateCounts: vi.fn(),
    readEphemeralPortRange: vi.fn(),
    readSelfFdCount: vi.fn(),
    readSelfLimitsFdsMax: vi.fn(),
    readPidCount: vi.fn(),
    readPidsLimit: vi.fn(),
    readCpuFreqMHz: vi.fn(),
    readMachineInfo: vi.fn(),
    readSelfInotifyStats: vi.fn(),
    readInotifyLimits: vi.fn(),
    readThermals: vi.fn(),
    readBattery: vi.fn(),
    statfsInfo: vi.fn(),
    scanProcessTable: vi.fn(),
  }
})

vi.mock('../../../../server/logger.js', () => {
  const child = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() }
  return { logger: { child: () => child }, __childLogger: child }
})

// Contract point 3 (enable / p99-drain+reset per fast tick / disable+null at stop) is
// pinned against this fake; 3_200_000ns → 3.2ms also exercises the ns→ms conversion.
const fakeHistogram = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  reset: vi.fn(),
  percentile: vi.fn(() => 3_200_000),
}))

vi.mock('node:perf_hooks', () => ({
  monitorEventLoopDelay: vi.fn(() => fakeHistogram),
}))

const mockLog = (loggerModule as unknown as { __childLogger: { warn: ReturnType<typeof vi.fn> } }).__childLogger

// ---------------------------------------------------------------------------
// Fixtures (service-level values; reader mocks return cumulative counters)
// ---------------------------------------------------------------------------

const PROC = '/fake/proc'
const SYS = '/fake/sys'
const CGROUP = '/fake/sys/fs/cgroup'

const MACHINE = {
  cores: 12,
  memTotalBytes: 34_000_000_000,
  platform: 'linux',
  wsl: false,
  kernel: '6.6.0',
  hostname: 'testbox',
  psi: true,
  cgroup: 'v2' as const,
  thermalCount: 1,
  batteryPresent: false,
  gpu: 'none' as const,
}

const CPU_T0 = {
  total: 1000,
  busy: 100,
  steal: 0,
  perCore: [
    { total: 250, busy: 25 },
    { total: 250, busy: 25 },
    { total: 250, busy: 25 },
    { total: 250, busy: 25 },
  ],
}
const CPU_T1 = {
  total: 2000,
  busy: 300,
  steal: 20,
  perCore: [
    { total: 500, busy: 100 },
    { total: 500, busy: 100 },
    { total: 500, busy: 100 },
    { total: 500, busy: 100 },
  ],
}
const VMSTAT_T0 = { pswpin: 100, pswpout: 40, pgmajfault: 50, oomKill: 2 }
const VMSTAT_T1 = { pswpin: 108, pswpout: 44, pgmajfault: 70, oomKill: 5 }
const MEMINFO = { totalKB: 64_000_000, availKB: 32_000_000, swapTotalKB: 8_000_000, swapFreeKB: 8_000_000 }
const PSI = { cpuSome10: 0.11, memSome10: 0.02, memFull10: 0.01, ioSome10: 0.3, ioFull10: 0.05 }

const DISK_T0 = new Map([
  ['sda', { readsCompleted: 1000, readMs: 4000, writesCompleted: 2000, writeMs: 8000, readSectors: 100_000, writtenSectors: 400_000, timeDoingIosMs: 500 }],
])
const DISK_T1 = new Map([
  ['sda', { readsCompleted: 1100, readMs: 6000, writesCompleted: 2400, writeMs: 10_000, readSectors: 151_200, writtenSectors: 502_400, timeDoingIosMs: 1500 }],
])
const NET_T0 = { rxBytes: 1_000_000, txBytes: 500_000, rxErr: 3, txErr: 1, rxDrop: 2, txDrop: 4 }
const NET_T1 = { rxBytes: 1_500_000, txBytes: 600_000, rxErr: 5, txErr: 3, rxDrop: 3, txDrop: 5 }

const TABLE = {
  top: [{ pid: 5, name: 'node', cpuPct: 12.3, rssBytes: 1e6, state: 'S' }],
  zombies: 1,
  dState: 2,
  total: 900,
}

const FAST_READERS = [
  'readCpuTimes',
  'readLoadavg',
  'readMeminfo',
  'readCgroupMemory',
  'readVmstat',
  'readPsi',
] as const
const SLOW_READERS = [
  'readDiskStats',
  'readNetDev',
  'readTcpStateCounts',
  'readEphemeralPortRange',
  'readSelfFdCount',
  'readSelfLimitsFdsMax',
  'readPidCount',
  'readPidsLimit',
  'readCpuFreqMHz',
] as const

let services: HostStatsService[] = []

function makeService(deps: HostStatsServiceDeps = {}): HostStatsService {
  const service = new HostStatsService({ procRoot: PROC, sysRoot: SYS, fastMs: 2000, slowMs: 5000, ...deps })
  services.push(service)
  return service
}

function readerFn(name: (typeof FAST_READERS)[number] | (typeof SLOW_READERS)[number]) {
  return vi.mocked(readersMock[name])
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  services = []

  vi.mocked(readersMock.readMachineInfo).mockReturnValue(MACHINE)
  vi.mocked(readersMock.readCpuTimes).mockReturnValue(CPU_T0)
  vi.mocked(readersMock.readLoadavg).mockReturnValue({ load1: 0.5, load5: 1, load15: 1.25 })
  vi.mocked(readersMock.readMeminfo).mockReturnValue(MEMINFO)
  vi.mocked(readersMock.readCgroupMemory).mockReturnValue({ limitBytes: null, currentBytes: 1_000_000_000 })
  vi.mocked(readersMock.readVmstat).mockReturnValue(VMSTAT_T0)
  vi.mocked(readersMock.readPsi).mockReturnValue(PSI)
  vi.mocked(readersMock.readDiskStats).mockReturnValue(DISK_T0)
  vi.mocked(readersMock.readNetDev).mockReturnValue(NET_T0)
  vi.mocked(readersMock.readTcpStateCounts).mockReturnValue({ timeWait: 42 })
  vi.mocked(readersMock.readEphemeralPortRange).mockReturnValue({ start: 32768, end: 60999 })
  vi.mocked(readersMock.readSelfFdCount).mockReturnValue(128)
  vi.mocked(readersMock.readSelfLimitsFdsMax).mockReturnValue(1_048_576)
  vi.mocked(readersMock.readPidCount).mockReturnValue(900)
  vi.mocked(readersMock.readPidsLimit).mockReturnValue(4_194_304)
  vi.mocked(readersMock.readCpuFreqMHz).mockReturnValue(3400)
  vi.mocked(readersMock.readSelfInotifyStats).mockReturnValue({ instances: 3, watches: 420 })
  vi.mocked(readersMock.readInotifyLimits).mockReturnValue({ maxUserWatches: 1_048_576, maxUserInstances: 128 })
  vi.mocked(readersMock.readThermals).mockReturnValue([{ label: 'cpu', celsius: 51.5 }])
  vi.mocked(readersMock.readBattery).mockReturnValue(null)
  vi.mocked(readersMock.statfsInfo).mockImplementation((mount: string) =>
    mount === '/'
      ? { totalBytes: 1e12, freeBytes: 5e11, usedPct: 50, inodesTotal: 1e8, inodesFree: 9e7 }
      : { totalBytes: 1e10, freeBytes: 9e9, usedPct: 10, inodesTotal: null, inodesFree: null },
  )
  vi.mocked(readersMock.scanProcessTable).mockResolvedValue(TABLE)
})

afterEach(() => {
  for (const service of services) service.stop()
  services = []
  restorePlatform?.()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

let restorePlatform: (() => void) | null = null

function stubPlatform(value: string): void {
  restorePlatform?.()
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...original, value })
  restorePlatform = () => {
    Object.defineProperty(process, 'platform', original)
    restorePlatform = null
  }
}

function cpuInfo(user: number, nice: number, sys: number, idle: number): os.CpuInfo {
  return { model: 'fake', speed: 2400, times: { user, nice, sys, idle, irq: 0 } }
}

// ---------------------------------------------------------------------------
// Snapshot shape / lifecycle
// ---------------------------------------------------------------------------

describe('getSnapshot pre-start (contract point 8)', () => {
  it('returns a structurally valid snapshot with machine filled and every section unavailable', () => {
    const service = makeService()
    const snap = service.getSnapshot()
    expect(HostStatsLiveSchema.safeParse(snap.live).success).toBe(true)
    expect(snap.live.machine).toEqual(MACHINE)
    expect(snap.manualAt).toBeNull()
    expect(snap.manual).toBeNull()
    for (const key of ['cpu', 'load', 'memory', 'paging', 'psi', 'diskIo', 'network', 'limits', 'freshell'] as const) {
      expect(snap.live[key].available, `section ${key}`).toBe(false)
    }
    // Nothing collected before start (only the constructor's one-time machine probe ran).
    for (const name of [...FAST_READERS, ...SLOW_READERS]) {
      expect(readerFn(name), name).not.toHaveBeenCalled()
    }
  })
})

describe('start/stop (contract points 1, 5)', () => {
  it('start runs one immediate fast tick with null-safe zero rates; slow readers untouched', () => {
    const service = makeService()
    expect(service.isRunning()).toBe(false)
    service.start()
    expect(service.isRunning()).toBe(true)

    const snap = service.getSnapshot()
    expect(HostStatsLiveSchema.safeParse(snap.live).success).toBe(true)
    const { cpu, load, memory, paging, psi, diskIo, network, limits, freshell } = snap.live

    expect(cpu).toEqual({ available: true, usagePct: 0, stealPct: 0, perCorePct: [0, 0, 0, 0], freqMHz: null })
    expect(load).toEqual({ available: true, load1: 0.5, load5: 1, load15: 1.25, cores: 12 })
    expect(memory).toEqual({
      available: true,
      source: 'host',
      totalBytes: 64_000_000 * 1024,
      usedBytes: 32_000_000 * 1024,
      availableBytes: 32_000_000 * 1024,
      cgroupLimitBytes: null,
      swapTotalBytes: 8_000_000 * 1024,
      swapUsedBytes: 0,
    })
    expect(paging).toEqual({ available: true, swapInKbps: 0, swapOutKbps: 0, majFaultsPerSec: 0, oomKillsDelta: 0, oomKillsTotal: 2 })
    expect(psi).toEqual({ available: true, cpuSome10: 0.11, memSome10: 0.02, memFull10: 0.01, ioSome10: 0.3, ioFull10: 0.05 })
    expect(diskIo).toEqual({ available: false, readBps: 0, writeBps: 0, utilPct: null, weightedAwaitMs: null })
    expect(network.available).toBe(false)
    expect(limits.available).toBe(false)
    expect(freshell.available).toBe(true)
    expect(freshell.source).toBe('node')
    expect(freshell.rssBytes).toEqual(expect.any(Number))
    expect(freshell.eventLoopLagP99Ms === null || Number.isFinite(freshell.eventLoopLagP99Ms)).toBe(true)

    for (const name of FAST_READERS) expect(readerFn(name), name).toHaveBeenCalledTimes(1)
    for (const name of SLOW_READERS) expect(readerFn(name), name).not.toHaveBeenCalled()
    // Injected roots reach the readers (note the frozen arg-order asymmetry).
    expect(readerFn('readCpuTimes')).toHaveBeenCalledWith(PROC)
    expect(readerFn('readCgroupMemory')).toHaveBeenCalledWith(CGROUP, PROC)
  })

  it('installs the two-tier cadence: fast ticks every 2s, slow every 5s', () => {
    const service = makeService()
    service.start()
    vi.advanceTimersByTime(2000)
    expect(readerFn('readCpuTimes')).toHaveBeenCalledTimes(2)
    for (const name of SLOW_READERS) expect(readerFn(name), name).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000)
    expect(readerFn('readCpuTimes')).toHaveBeenCalledTimes(3)
    expect(readerFn('readDiskStats')).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2000) // t=6000: one more fast tick + first slow tick at 5000
    expect(readerFn('readCpuTimes')).toHaveBeenCalledTimes(4)
    for (const name of SLOW_READERS) expect(readerFn(name), name).toHaveBeenCalledTimes(1)
    expect(readerFn('readDiskStats')).toHaveBeenCalledWith(PROC)
    expect(readerFn('readCpuFreqMHz')).toHaveBeenCalledWith(SYS)
    expect(readerFn('readPidsLimit')).toHaveBeenCalledWith(PROC, CGROUP)
    vi.advanceTimersByTime(10000) // t=16000: fast at 8/10/12/14/16, slow at 10/15
    expect(readerFn('readCpuTimes')).toHaveBeenCalledTimes(9)
    expect(readerFn('readDiskStats')).toHaveBeenCalledTimes(3)
  })

  it('calling start twice does not double-install intervals', () => {
    const service = makeService()
    service.start()
    service.start()
    vi.advanceTimersByTime(2000)
    expect(readerFn('readCpuTimes')).toHaveBeenCalledTimes(2) // 1 immediate + 1 interval tick
    expect(readerFn('readDiskStats')).not.toHaveBeenCalled()
  })

  it('stop halts all collection and is idempotent; a restart resumes ticking', () => {
    const service = makeService()
    service.start()
    service.stop()
    service.stop() // idempotent
    expect(service.isRunning()).toBe(false)
    vi.clearAllMocks()
    vi.advanceTimersByTime(20000)
    for (const name of [...FAST_READERS, ...SLOW_READERS]) {
      expect(readerFn(name), name).not.toHaveBeenCalled()
    }
    service.start()
    expect(service.isRunning()).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(readerFn('readCpuTimes')).toHaveBeenCalledTimes(2)
  })
})

describe('event-loop lag histogram lifecycle (contract point 3)', () => {
  it('enables at start; drains p99 and resets per fast tick (never slow ticks); disables once at stop', () => {
    const service = makeService()
    service.start()
    expect(fakeHistogram.enable).toHaveBeenCalledTimes(1)
    // start() runs one immediate fast tick → one p99 read at the 99th percentile + one reset.
    expect(fakeHistogram.percentile).toHaveBeenCalledTimes(1)
    expect(fakeHistogram.percentile).toHaveBeenCalledWith(99)
    expect(fakeHistogram.reset).toHaveBeenCalledTimes(1)

    // The drained value reaches the snapshot in ms (3_200_000ns → 3.2ms).
    expect(service.getSnapshot().live.freshell.eventLoopLagP99Ms).toBe(3.2)

    vi.advanceTimersByTime(4000) // fast ticks at t=2s,4s
    expect(fakeHistogram.percentile).toHaveBeenCalledTimes(3)
    expect(fakeHistogram.reset).toHaveBeenCalledTimes(3)
    vi.advanceTimersByTime(1000) // t=5s: slow tick only — histogram is a fast-tier instrument
    expect(fakeHistogram.percentile).toHaveBeenCalledTimes(3)
    expect(fakeHistogram.reset).toHaveBeenCalledTimes(3)

    service.stop()
    expect(fakeHistogram.disable).toHaveBeenCalledTimes(1)
    service.stop() // idempotent: no second disable
    expect(fakeHistogram.disable).toHaveBeenCalledTimes(1)
  })

  it('collects no lag samples while stopped (cache retains last tick), then resumes per-tick on restart', () => {
    const service = makeService()
    service.start()
    service.stop()
    fakeHistogram.percentile.mockClear()
    fakeHistogram.reset.mockClear()
    vi.advanceTimersByTime(6000)
    expect(fakeHistogram.percentile).not.toHaveBeenCalled()
    expect(fakeHistogram.reset).not.toHaveBeenCalled()
    service.start()
    expect(fakeHistogram.reset).toHaveBeenCalledTimes(1) // immediate fast tick drains again
    expect(service.getSnapshot().live.freshell.eventLoopLagP99Ms).toBe(3.2)
  })
})

// ---------------------------------------------------------------------------
// Rates + memory precedence
// ---------------------------------------------------------------------------

describe('delta-rate computation (contract point 1)', () => {
  it('computes cpu/paging/disk/network rates from cumulative deltas over dt', () => {
    vi.mocked(readersMock.readCpuTimes).mockReturnValueOnce(CPU_T0).mockReturnValue(CPU_T1)
    vi.mocked(readersMock.readVmstat).mockReturnValueOnce(VMSTAT_T0).mockReturnValue(VMSTAT_T1)
    vi.mocked(readersMock.readDiskStats).mockReturnValueOnce(DISK_T0).mockReturnValue(DISK_T1)
    vi.mocked(readersMock.readNetDev).mockReturnValueOnce(NET_T0).mockReturnValue(NET_T1)

    const service = makeService()
    service.start()
    vi.advanceTimersByTime(2000) // second fast tick: first real deltas, dt = 2000ms
    const fast = service.getSnapshot().live
    // cpu: dBusy 200 / dTotal 1000 = 20%; steal 20/1000 = 2%; per-core 75/250 = 30%
    expect(fast.cpu).toEqual({ available: true, usagePct: 20, stealPct: 2, perCorePct: [30, 30, 30, 30], freqMHz: null })
    // paging: 8 pages*4KB/2s = 16 KB/s in; 4*4/2 = 8 KB/s out; 20/2 = 10 majfaults/s; oom 2->5
    expect(fast.paging).toEqual({ available: true, swapInKbps: 16, swapOutKbps: 8, majFaultsPerSec: 10, oomKillsDelta: 3, oomKillsTotal: 5 })

    vi.advanceTimersByTime(3000) // t=5000: first slow tick → first slow-tier sample (no delta yet)
    const firstSlow = service.getSnapshot().live
    expect(firstSlow.diskIo).toEqual({ available: true, readBps: 0, writeBps: 0, utilPct: null, weightedAwaitMs: null })
    expect(firstSlow.network).toEqual({
      available: true, rxBps: 0, txBps: 0,
      rxErrorsTotal: 3, txErrorsTotal: 1, rxDroppedTotal: 2, txDroppedTotal: 4,
      rxErrorsDelta: 0, txErrorsDelta: 0, rxDroppedDelta: 0, txDroppedDelta: 0,
    })
    expect(firstSlow.cpu.freqMHz).toBe(3400)
    expect(firstSlow.limits).toEqual({
      available: true,
      fdsUsed: 128, fdsMax: 1_048_576,
      pidsUsed: 900, pidsMax: 4_194_304,
      timeWait: 42, ephemeralPorts: 28232, // 60999 - 32768 + 1
    })

    vi.advanceTimersByTime(5000) // t=10000: second slow tick, dt = 5000ms
    const live = service.getSnapshot().live
    // disk: dRead 51200 sectors*512 = 26,214,400 B / 5s = 5,242,880 B/s; dWrite 102400*512/5 = 10,485,760 B/s
    // util = 1000ms busy / 5000ms = 20%; await = (2000+2000)/(100+400) = 8ms
    expect(live.diskIo).toEqual({ available: true, readBps: 5_242_880, writeBps: 10_485_760, utilPct: 20, weightedAwaitMs: 8 })
    // net: dRx 500000/5 = 100000 B/s; dTx 100000/5 = 20000 B/s; err/drop deltas 2/2/1/1
    expect(live.network).toEqual({
      available: true, rxBps: 100_000, txBps: 20_000,
      rxErrorsTotal: 5, txErrorsTotal: 3, rxDroppedTotal: 3, txDroppedTotal: 5,
      rxErrorsDelta: 2, txErrorsDelta: 2, rxDroppedDelta: 1, txDroppedDelta: 1,
    })
  })
})

describe('memory precedence (contract point 2)', () => {
  it('finite cgroup limit → source cgroup, all numbers from the cgroup leaf', () => {
    vi.mocked(readersMock.readCgroupMemory).mockReturnValue({ limitBytes: 8_000_000_000, currentBytes: 500_000_000 })
    const service = makeService()
    service.start()
    expect(service.getSnapshot().live.memory).toEqual({
      available: true,
      source: 'cgroup',
      totalBytes: 8_000_000_000,
      usedBytes: 500_000_000,
      availableBytes: 7_500_000_000,
      cgroupLimitBytes: 8_000_000_000,
      // Swap is host-scoped context (cgroup swap accounting is not collected).
      swapTotalBytes: 8_000_000 * 1024,
      swapUsedBytes: 0,
    })
  })

  it('unlimited (memory.max = max) or absent cgroup → source host, all totals from meminfo', () => {
    for (const cgroup of [
      { limitBytes: null, currentBytes: 16_000_000_000 }, // unlimited, like the self-hosted freshell
      null, // absent
    ]) {
      vi.mocked(readersMock.readCgroupMemory).mockReturnValue(cgroup)
      const service = makeService()
      service.start()
      expect(service.getSnapshot().live.memory).toEqual({
        available: true,
        source: 'host',
        totalBytes: 64_000_000 * 1024,
        usedBytes: 32_000_000 * 1024,
        availableBytes: 32_000_000 * 1024,
        cgroupLimitBytes: null,
        swapTotalBytes: 8_000_000 * 1024,
        swapUsedBytes: 0,
      })
      service.stop()
    }
  })

  it('cgroup unlimited AND meminfo unreadable → memory section degraded', () => {
    vi.mocked(readersMock.readCgroupMemory).mockReturnValue(null)
    vi.mocked(readersMock.readMeminfo).mockReturnValue(null)
    const service = makeService()
    service.start()
    expect(service.getSnapshot().live.memory).toEqual({
      available: false,
      source: 'host',
      totalBytes: 0,
      usedBytes: 0,
      availableBytes: 0,
      cgroupLimitBytes: null,
      swapTotalBytes: null,
      swapUsedBytes: null,
    })
  })
})

describe('onSnapshot (Task 4 wiring seam; plan interface block)', () => {
  it('fires after every fast tick (not slow), single listener slot, null clears', () => {
    const service = makeService()
    const snaps: { at: number }[] = []
    service.onSnapshot((s) => snaps.push(s))
    service.start() // immediate fast tick
    vi.advanceTimersByTime(2000) // fast
    vi.advanceTimersByTime(3000) // fast at t=4000 + slow at t=5000 (no fire)
    expect(snaps).toHaveLength(3)

    const other: { at: number }[] = []
    service.onSnapshot((s) => other.push(s)) // replace the single slot
    vi.advanceTimersByTime(2000)
    expect(snaps).toHaveLength(3)
    expect(other).toHaveLength(1)

    service.onSnapshot(null)
    vi.advanceTimersByTime(2000)
    expect(other).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// darwin (contract points 1, 2, 7)
// ---------------------------------------------------------------------------

describe('darwin platform branch', () => {
  it('fast tier uses os.cpus()/os.loadavg()/os.totalmem() and never attempts /proc readers', () => {
    stubPlatform('darwin')
    vi.spyOn(os, 'cpus')
      .mockReturnValueOnce([cpuInfo(10, 0, 10, 80), cpuInfo(10, 0, 10, 80), cpuInfo(10, 0, 10, 80), cpuInfo(10, 0, 10, 80)])
      .mockReturnValue([cpuInfo(30, 5, 25, 140), cpuInfo(30, 5, 25, 140), cpuInfo(30, 5, 25, 140), cpuInfo(30, 5, 25, 140)])
    vi.spyOn(os, 'loadavg').mockReturnValue([0.5, 1.0, 1.5])
    vi.spyOn(os, 'totalmem').mockReturnValue(16_000_000_000)
    vi.spyOn(os, 'freemem').mockReturnValue(8_000_000_000)

    const service = makeService({ procRoot: undefined }) // darwin default: procRoot null
    service.start()
    vi.advanceTimersByTime(2000) // second fast tick: darwin deltas (per core dBusy 40 / dTotal 100)

    const live = service.getSnapshot().live
    expect(HostStatsLiveSchema.safeParse(live).success).toBe(true)
    expect(live.cpu).toEqual({ available: true, usagePct: 40, stealPct: null, perCorePct: [40, 40, 40, 40], freqMHz: null })
    expect(live.load).toEqual({ available: true, load1: 0.5, load5: 1.0, load15: 1.5, cores: 12 })
    expect(live.memory).toEqual({
      available: true,
      source: 'host',
      totalBytes: 16_000_000_000,
      usedBytes: 8_000_000_000,
      availableBytes: 8_000_000_000,
      cgroupLimitBytes: null,
      swapTotalBytes: null,
      swapUsedBytes: null,
    })
    // /proc-dependent sections stay full zero-shape; readers never attempted on darwin.
    expect(live.paging).toEqual({ available: false, swapInKbps: 0, swapOutKbps: 0, majFaultsPerSec: 0, oomKillsDelta: 0, oomKillsTotal: 0 })
    expect(live.psi.available).toBe(false)
    for (const name of ['readCpuTimes', 'readVmstat', 'readPsi', 'readMeminfo', 'readCgroupMemory', 'readLoadavg'] as const) {
      expect(readerFn(name), name).not.toHaveBeenCalled()
    }

    vi.advanceTimersByTime(3000) // t=5000: slow tier is entirely /proc+/sys-based → no-op on darwin
    const after = service.getSnapshot().live
    expect(after.diskIo.available).toBe(false)
    expect(after.network.available).toBe(false)
    expect(after.limits.available).toBe(false)
    for (const name of SLOW_READERS) expect(readerFn(name), name).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// refresh()
// ---------------------------------------------------------------------------

describe('refresh (contract points 6, 7, 9)', () => {
  it('a successful refresh fills every manual section, caches it, and fires the merged snapshot', async () => {
    const service = makeService()
    const snaps: Array<{ at: number; manualAt: number | null; manual: unknown }> = []
    service.onSnapshot((s) => snaps.push(s))

    const t0 = Date.now()
    const { at, manual } = await service.refresh()
    expect(at).toBe(t0)
    expect(HostStatsManualSchema.safeParse(manual).success).toBe(true)
    expect(manual).toEqual({
      topProcesses: { available: true, dwellMs: 300, list: TABLE.top },
      processHealth: { available: true, zombies: 1, dState: 2, total: 900 },
      inotify: { available: true, instances: 3, watches: 420, maxUserWatches: 1_048_576, maxUserInstances: 128 },
      disks: {
        available: true,
        list: [
          { mount: '/', totalBytes: 1e12, freeBytes: 5e11, usedPct: 50, inodesTotal: 1e8, inodesFree: 9e7 },
          { mount: '/dev/shm', totalBytes: 1e10, freeBytes: 9e9, usedPct: 10, inodesTotal: null, inodesFree: null },
        ],
      },
      thermals: { available: true, zones: [{ label: 'cpu', celsius: 51.5 }], battery: null },
      sectionErrors: {},
    })
    // Cooperative section budget: absolute deadline = refresh start + sectionBudgetMs.
    expect(vi.mocked(readersMock.scanProcessTable)).toHaveBeenCalledWith(PROC, 300, t0 + 2000)
    expect(mockLog.warn).not.toHaveBeenCalled()

    // Merged snapshot fired immediately (live cache untouched — service never started).
    expect(snaps).toHaveLength(1)
    expect(snaps[0].at).toBe(t0)
    expect(snaps[0].manualAt).toBe(t0)
    expect(snaps[0].manual).toEqual(manual)

    // Cached across subsequent live ticks.
    service.start()
    vi.advanceTimersByTime(2000)
    const snap = service.getSnapshot()
    expect(snap.manualAt).toBe(t0)
    expect(snap.manual).toEqual(manual)
  })

  it('is single-flight: concurrent calls return the same promise', async () => {
    const service = makeService()
    let resolveScan: ((value: typeof TABLE) => void) | undefined
    vi.mocked(readersMock.scanProcessTable).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve
        }),
    )
    const p1 = service.refresh()
    const p2 = service.refresh()
    expect(p2).toBe(p1)
    expect(vi.mocked(readersMock.scanProcessTable)).toHaveBeenCalledTimes(1)

    resolveScan!({ ...TABLE, total: 901 })
    const { manual } = await p1
    expect(manual.processHealth.total).toBe(901)
  })

  it('enforces the 1s post-completion cooldown (rate_limited), then allows again', async () => {
    const service = makeService()
    await service.refresh()
    await expect(service.refresh()).rejects.toThrow('rate_limited')
    vi.advanceTimersByTime(999)
    await expect(service.refresh()).rejects.toThrow('rate_limited')
    vi.advanceTimersByTime(1)
    await expect(service.refresh()).resolves.toBeDefined()
    expect(vi.mocked(readersMock.scanProcessTable)).toHaveBeenCalledTimes(2)
  })

  it('a rejected refresh keeps the prior manual in the snapshot', async () => {
    const service = makeService()
    const first = await service.refresh()
    await expect(service.refresh()).rejects.toThrow('rate_limited')
    const snap = service.getSnapshot()
    expect(snap.manualAt).toBe(first.at)
    expect(snap.manual).toEqual(first.manual)
  })

  it('a section deadline degrades only that section (errors entry + warn), others complete', async () => {
    vi.mocked(readersMock.scanProcessTable).mockRejectedValue(new readersMock.DeadlineExceeded())
    const service = makeService()
    const { manual } = await service.refresh()
    expect(HostStatsManualSchema.safeParse(manual).success).toBe(true)
    expect(manual.topProcesses).toEqual({ available: false, dwellMs: 0, list: [] })
    expect(manual.processHealth).toEqual({ available: false, zombies: 0, dState: 0, total: 0 })
    expect(manual.sectionErrors.topProcesses).toEqual(expect.any(String))
    expect(manual.sectionErrors.processHealth).toEqual(expect.any(String))
    expect(manual.disks.available).toBe(true)
    expect(manual.thermals.available).toBe(true)
    expect(manual.inotify.available).toBe(true)
    expect(manual.sectionErrors.disks).toBeUndefined()
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'host_stats_section_timeout', section: 'topProcesses', budgetMs: 2000 }),
      expect.any(String),
    )
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'host_stats_section_timeout', section: 'processHealth', budgetMs: 2000 }),
      expect.any(String),
    )
  })

  it('the overall watchdog marks still-running sections failed and is cleared in finally', async () => {
    const service = makeService({ overallBudgetMs: 400 })
    vi.mocked(readersMock.scanProcessTable).mockReturnValue(new Promise(() => {})) // never resolves
    const pending = service.refresh()
    await vi.advanceTimersByTimeAsync(400)
    const { manual } = await pending
    expect(manual.topProcesses.available).toBe(false)
    expect(manual.processHealth.available).toBe(false)
    expect(manual.sectionErrors.topProcesses).toEqual(expect.any(String))
    expect(manual.disks.available).toBe(true)

    // Watchdog was cleared: a later refresh (post-cooldown) behaves normally.
    vi.advanceTimersByTime(1000)
    vi.mocked(readersMock.scanProcessTable).mockResolvedValue(TABLE)
    await expect(service.refresh()).resolves.toBeDefined()
  })

  it('on darwin, the process scan goes through the ps path (procRoot null) and /proc sections are skipped', async () => {
    stubPlatform('darwin')
    const service = makeService({ procRoot: undefined }) // darwin default: procRoot null
    const t0 = Date.now()
    const { manual } = await service.refresh()
    expect(vi.mocked(readersMock.scanProcessTable)).toHaveBeenCalledWith(null, 300, t0 + 2000)
    expect(manual.topProcesses.available).toBe(true)
    expect(manual.inotify).toEqual({ available: false, instances: null, watches: null, maxUserWatches: null, maxUserInstances: null })
    expect(readerFn('readSelfInotifyStats')).not.toHaveBeenCalled()
    expect(readerFn('readInotifyLimits')).not.toHaveBeenCalled()
    // / only — /dev/shm is skipped on darwin.
    expect(vi.mocked(readersMock.statfsInfo).mock.calls.map((c) => c[0])).toEqual(['/'])
    expect(manual.disks).toEqual({
      available: true,
      list: [{ mount: '/', totalBytes: 1e12, freeBytes: 5e11, usedPct: 50, inodesTotal: 1e8, inodesFree: 9e7 }],
    })
    expect(manual.thermals.available).toBe(true)
    expect(manual.sectionErrors).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// freshell sources + env-configured cadence
// ---------------------------------------------------------------------------

describe('freshell section sources (contract point 4)', () => {
  it('constructor seeds are used until setSources overrides them', () => {
    const service = makeService({ getPtyCounts: () => ({ running: 7, max: 50 }) })
    service.start()
    let freshell = service.getSnapshot().live.freshell
    expect(freshell).toMatchObject({ available: true, source: 'node', ptysRunning: 7, ptysMax: 50, wsClients: 0, wsClientsMax: 0 })

    service.setSources({
      getPtyCounts: () => ({ running: 9, max: 50 }),
      getWsClientCounts: () => ({ clients: 3, max: 50 }),
    })
    vi.advanceTimersByTime(2000)
    freshell = service.getSnapshot().live.freshell
    expect(freshell).toMatchObject({ ptysRunning: 9, ptysMax: 50, wsClients: 3, wsClientsMax: 50 })
  })
})

describe('default cadence configuration (contract point 1)', () => {
  const FAST_ENV = 'FRESHELL_HOST_STATS_FAST_MS'
  const SLOW_ENV = 'FRESHELL_HOST_STATS_SLOW_MS'
  let savedFast: string | undefined
  let savedSlow: string | undefined

  beforeEach(() => {
    savedFast = process.env[FAST_ENV]
    savedSlow = process.env[SLOW_ENV]
  })
  afterEach(() => {
    if (savedFast === undefined) delete process.env[FAST_ENV]
    else process.env[FAST_ENV] = savedFast
    if (savedSlow === undefined) delete process.env[SLOW_ENV]
    else process.env[SLOW_ENV] = savedSlow
  })

  it('defaults to 2000ms fast / 5000ms slow when the env vars are absent', () => {
    delete process.env[FAST_ENV]
    delete process.env[SLOW_ENV]
    const service = new HostStatsService({ procRoot: PROC, sysRoot: SYS }) // no fastMs/slowMs
    services.push(service)
    service.start()
    vi.advanceTimersByTime(1999)
    expect(readerFn('readCpuTimes')).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1) // t=2000
    expect(readerFn('readCpuTimes')).toHaveBeenCalledTimes(2)
    expect(readerFn('readDiskStats')).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2999) // t=4999
    expect(readerFn('readDiskStats')).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1) // t=5000
    expect(readerFn('readDiskStats')).toHaveBeenCalledTimes(1)
  })

  it('honors FRESHELL_HOST_STATS_FAST_MS / FRESHELL_HOST_STATS_SLOW_MS', () => {
    process.env[FAST_ENV] = '500'
    process.env[SLOW_ENV] = '1250'
    const service = new HostStatsService({ procRoot: PROC, sysRoot: SYS })
    services.push(service)
    service.start()
    vi.advanceTimersByTime(500)
    expect(readerFn('readCpuTimes')).toHaveBeenCalledTimes(2)
    expect(readerFn('readDiskStats')).not.toHaveBeenCalled()
    vi.advanceTimersByTime(750) // t=1250 (fast at 1000 too)
    expect(readerFn('readCpuTimes')).toHaveBeenCalledTimes(3)
    expect(readerFn('readDiskStats')).toHaveBeenCalledTimes(1)
  })
})
