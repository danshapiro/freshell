import { describe, it, expect } from 'vitest'
import type { HostStatsLive } from '@shared/ws-protocol'
import {
  cpuStatus,
  memoryStatus,
  pagingStatus,
  psiStatus,
  diskIoStatus,
  networkStatus,
  limitsStatus,
  freshellStatus,
  overallVerdict,
} from '@/lib/host-stats-status'

// Full-shape "neutral" fixture: every section available with well-below-threshold
// values. Tests spread-override exactly the section under test.
function makeLive(): HostStatsLive {
  return {
    machine: {
      cores: 8, memTotalBytes: 34_000_000_000, platform: 'linux', wsl: false,
      kernel: '6.6', hostname: 'test', psi: true, cgroup: 'v2',
      thermalCount: 1, batteryPresent: false, gpu: 'none',
    },
    cpu: { available: true, usagePct: 10, stealPct: 0, perCorePct: [10], freqMHz: 3400 },
    load: { available: true, load1: 0.5, load5: 0.6, load15: 0.7, cores: 8 },
    memory: {
      available: true, source: 'host', totalBytes: 10_000, usedBytes: 1_000, availableBytes: 9_000,
      cgroupLimitBytes: null, swapTotalBytes: 0, swapUsedBytes: 0,
    },
    paging: { available: true, swapInKbps: 0, swapOutKbps: 0, majFaultsPerSec: 0, oomKillsDelta: 0, oomKillsTotal: 0 },
    psi: { available: true, cpuSome10: 0.1, memSome10: 0.2, memFull10: 0, ioSome10: 0.1, ioFull10: 0 },
    diskIo: { available: true, readBps: 0, writeBps: 0, utilPct: 1, weightedAwaitMs: 5 },
    network: {
      available: true, rxBps: 0, txBps: 0,
      rxErrorsTotal: 0, txErrorsTotal: 0, rxDroppedTotal: 0, txDroppedTotal: 0,
      rxErrorsDelta: 0, txErrorsDelta: 0, rxDroppedDelta: 0, txDroppedDelta: 0,
    },
    limits: { available: true, fdsUsed: 100, fdsMax: 1_048_576, pidsUsed: 100, pidsMax: 4_194_304, timeWait: 10, ephemeralPorts: 28_232 },
    freshell: {
      available: true, source: 'node', ptysRunning: 1, ptysMax: 50, wsClients: 1, wsClientsMax: 50,
      eventLoopLagP99Ms: 5, rssBytes: 1_000_000, uptimeSec: 60,
    },
  }
}

describe('cpuStatus', () => {
  it('is ok below 80%', () => {
    expect(cpuStatus(makeLive())).toEqual({ severity: 'ok', word: 'ok' })
    const l = makeLive()
    l.cpu.usagePct = 79.9
    expect(cpuStatus(l)).toEqual({ severity: 'ok', word: 'ok' })
  })
  it('is busy at exactly 80% and below 95%', () => {
    const l = makeLive()
    l.cpu.usagePct = 80
    expect(cpuStatus(l)).toEqual({ severity: 'warn', word: 'busy' })
    l.cpu.usagePct = 94.99
    expect(cpuStatus(l)).toEqual({ severity: 'warn', word: 'busy' })
  })
  it('is maxed at exactly 95%', () => {
    const l = makeLive()
    l.cpu.usagePct = 95
    expect(cpuStatus(l)).toEqual({ severity: 'bad', word: 'maxed' })
  })
  it('degrades to unknown/ok when unavailable', () => {
    const l = makeLive()
    l.cpu = { available: false, usagePct: 0, stealPct: null, perCorePct: [], freqMHz: null }
    expect(cpuStatus(l)).toEqual({ severity: 'ok', word: 'unknown' })
  })
})

describe('memoryStatus', () => {
  const withUsed = (usedBytes: number): HostStatsLive => {
    const l = makeLive()
    l.memory.usedBytes = usedBytes // totalBytes is 10_000 → pct is exact tenths
    return l
  }
  it('is ok below 85%', () => {
    expect(memoryStatus(withUsed(8_499))).toEqual({ severity: 'ok', word: 'ok' }) // 84.99%
  })
  it('is tight at exactly 85% and below 97%', () => {
    expect(memoryStatus(withUsed(8_500))).toEqual({ severity: 'warn', word: 'tight' }) // 85%
    expect(memoryStatus(withUsed(9_699))).toEqual({ severity: 'warn', word: 'tight' }) // 96.99%
  })
  it('is full at exactly 97%', () => {
    expect(memoryStatus(withUsed(9_700))).toEqual({ severity: 'bad', word: 'full' }) // 97%
  })
  it('uses totalBytes as the effective limit (cgroup limit is already folded in server-side)', () => {
    const l = makeLive()
    l.memory = {
      ...l.memory, source: 'cgroup', totalBytes: 10_000, usedBytes: 9_800,
      availableBytes: 200, cgroupLimitBytes: 10_000,
    }
    expect(memoryStatus(l)).toEqual({ severity: 'bad', word: 'full' })
  })
  it('degrades to unknown/ok when unavailable', () => {
    const l = makeLive()
    l.memory = {
      available: false, source: 'host', totalBytes: 0, usedBytes: 0, availableBytes: 0,
      cgroupLimitBytes: null, swapTotalBytes: null, swapUsedBytes: null,
    }
    expect(memoryStatus(l)).toEqual({ severity: 'ok', word: 'unknown' })
  })
})

describe('pagingStatus', () => {
  const withRates = (swapInKbps: number, swapOutKbps: number): HostStatsLive => {
    const l = makeLive()
    l.paging.swapInKbps = swapInKbps
    l.paging.swapOutKbps = swapOutKbps
    return l
  }
  it('is ok at zero combined rate', () => {
    expect(pagingStatus(withRates(0, 0))).toEqual({ severity: 'ok', word: 'ok' })
  })
  it('is swapping on ANY combined rate > 0 (single-snapshot, no 2-tick carry)', () => {
    expect(pagingStatus(withRates(1, 0))).toEqual({ severity: 'warn', word: 'swapping' })
    expect(pagingStatus(withRates(0, 0.5))).toEqual({ severity: 'warn', word: 'swapping' })
  })
  it('is still swapping at exactly 5000 KB/s combined (thrashing is strict >)', () => {
    expect(pagingStatus(withRates(2_500, 2_500))).toEqual({ severity: 'warn', word: 'swapping' })
  })
  it('is thrashing above 5000 KB/s combined', () => {
    expect(pagingStatus(withRates(2_500, 2_501))).toEqual({ severity: 'bad', word: 'thrashing' })
  })
  it('degrades to unknown/ok when unavailable', () => {
    const l = makeLive()
    l.paging = { available: false, swapInKbps: 0, swapOutKbps: 0, majFaultsPerSec: 0, oomKillsDelta: 0, oomKillsTotal: 0 }
    expect(pagingStatus(l)).toEqual({ severity: 'ok', word: 'unknown' })
  })
})

describe('psiStatus', () => {
  it('is ok when no full10 exceeds 1.0', () => {
    expect(psiStatus(makeLive())).toEqual({ severity: 'ok', word: 'ok' })
    const l = makeLive()
    l.psi.memFull10 = 1.0 // threshold is strict >
    expect(psiStatus(l)).toEqual({ severity: 'ok', word: 'ok' })
  })
  it('is stalled when memFull10 > 1.0', () => {
    const l = makeLive()
    l.psi.memFull10 = 1.01
    expect(psiStatus(l)).toEqual({ severity: 'bad', word: 'stalled' })
  })
  it('is stalled when ioFull10 > 1.0', () => {
    const l = makeLive()
    l.psi.ioFull10 = 1.5
    expect(psiStatus(l)).toEqual({ severity: 'bad', word: 'stalled' })
  })
  it('ignores some10 (only full10 stalls)', () => {
    const l = makeLive()
    l.psi.cpuSome10 = 99
    l.psi.memSome10 = 99
    l.psi.ioSome10 = 99
    expect(psiStatus(l)).toEqual({ severity: 'ok', word: 'ok' })
  })
  it('is ok with all-null full10 values', () => {
    const l = makeLive()
    l.psi.memFull10 = null
    l.psi.ioFull10 = null
    expect(psiStatus(l)).toEqual({ severity: 'ok', word: 'ok' })
  })
  it('degrades to unknown/ok when unavailable', () => {
    const l = makeLive()
    l.psi = { available: false, cpuSome10: null, memSome10: null, memFull10: null, ioSome10: null, ioFull10: null }
    expect(psiStatus(l)).toEqual({ severity: 'ok', word: 'unknown' })
  })
})

describe('diskIoStatus', () => {
  const withAwait = (weightedAwaitMs: number | null): HostStatsLive => {
    const l = makeLive()
    l.diskIo.weightedAwaitMs = weightedAwaitMs
    return l
  }
  it('is ok when weightedAwaitMs is null (no ios in window)', () => {
    expect(diskIoStatus(withAwait(null))).toEqual({ severity: 'ok', word: 'ok' })
  })
  it('is ok at exactly 20ms', () => {
    expect(diskIoStatus(withAwait(20))).toEqual({ severity: 'ok', word: 'ok' })
  })
  it('is slow above 20ms and up to exactly 100ms', () => {
    expect(diskIoStatus(withAwait(20.01))).toEqual({ severity: 'warn', word: 'slow' })
    expect(diskIoStatus(withAwait(100))).toEqual({ severity: 'warn', word: 'slow' })
  })
  it('is stalled above 100ms', () => {
    expect(diskIoStatus(withAwait(100.01))).toEqual({ severity: 'bad', word: 'stalled' })
  })
  it('degrades to unknown/ok when unavailable', () => {
    const l = makeLive()
    l.diskIo = { available: false, readBps: 0, writeBps: 0, utilPct: null, weightedAwaitMs: null }
    expect(diskIoStatus(l)).toEqual({ severity: 'ok', word: 'unknown' })
  })
})

describe('networkStatus', () => {
  it('is ok with zero last-tick error/drop deltas', () => {
    expect(networkStatus(makeLive())).toEqual({ severity: 'ok', word: 'ok' })
  })
  it('is errors when any last-tick delta is > 0 (totals are irrelevant)', () => {
    const l = makeLive()
    l.network.rxErrorsTotal = 1_000_000 // totals alone do NOT flip the tile
    l.network.rxDroppedDelta = 1
    expect(networkStatus(l)).toEqual({ severity: 'warn', word: 'errors' })
  })
  it('degrades to unknown/ok when unavailable', () => {
    const l = makeLive()
    l.network = {
      available: false, rxBps: 0, txBps: 0,
      rxErrorsTotal: 0, txErrorsTotal: 0, rxDroppedTotal: 0, txDroppedTotal: 0,
      rxErrorsDelta: 0, txErrorsDelta: 0, rxDroppedDelta: 0, txDroppedDelta: 0,
    }
    expect(networkStatus(l)).toEqual({ severity: 'ok', word: 'unknown' })
  })
})

describe('limitsStatus', () => {
  it('is ok below 70% on every sub-limit', () => {
    const l = makeLive()
    l.limits = { available: true, fdsUsed: 699, fdsMax: 1_000, pidsUsed: 69, pidsMax: 100, timeWait: 69, ephemeralPorts: 100 }
    expect(limitsStatus(l)).toEqual({ severity: 'ok', word: 'ok' }) // 69% across the board
  })
  it('is tight when any sub-limit reaches exactly 70%', () => {
    const l = makeLive()
    l.limits = { available: true, fdsUsed: 700, fdsMax: 1_000, pidsUsed: 69, pidsMax: 100, timeWait: 69, ephemeralPorts: 100 }
    expect(limitsStatus(l)).toEqual({ severity: 'warn', word: 'tight' })
  })
  it('is full when any sub-limit reaches exactly 90%', () => {
    const l = makeLive()
    l.limits = { available: true, fdsUsed: 69, fdsMax: 100, pidsUsed: 90, pidsMax: 100, timeWait: 69, ephemeralPorts: 100 }
    expect(limitsStatus(l)).toEqual({ severity: 'bad', word: 'full' })
  })
  it('worst sub-limit drives the tile', () => {
    const l = makeLive()
    l.limits = { available: true, fdsUsed: 70, fdsMax: 100, pidsUsed: 95, pidsMax: 100, timeWait: 50, ephemeralPorts: 100 }
    expect(limitsStatus(l)).toEqual({ severity: 'bad', word: 'full' })
  })
  it('skips null sub-limit pairs; all-null pairs with available:true is ok', () => {
    const l = makeLive()
    l.limits = { available: true, fdsUsed: null, fdsMax: null, pidsUsed: 95, pidsMax: 100, timeWait: null, ephemeralPorts: null }
    expect(limitsStatus(l)).toEqual({ severity: 'bad', word: 'full' })
    l.limits = { available: true, fdsUsed: null, fdsMax: null, pidsUsed: null, pidsMax: null, timeWait: null, ephemeralPorts: null }
    expect(limitsStatus(l)).toEqual({ severity: 'ok', word: 'ok' })
  })
  it('degrades to unknown/ok when unavailable', () => {
    const l = makeLive()
    l.limits = { available: false, fdsUsed: null, fdsMax: null, pidsUsed: null, pidsMax: null, timeWait: null, ephemeralPorts: null }
    expect(limitsStatus(l)).toEqual({ severity: 'ok', word: 'unknown' })
  })
})

describe('freshellStatus', () => {
  const withLag = (eventLoopLagP99Ms: number | null): HostStatsLive => {
    const l = makeLive()
    l.freshell.eventLoopLagP99Ms = eventLoopLagP99Ms
    return l
  }
  it('is ok when lag p99 is null (unmeasurable)', () => {
    expect(freshellStatus(withLag(null))).toEqual({ severity: 'ok', word: 'ok' })
  })
  it('is ok at exactly 50ms', () => {
    expect(freshellStatus(withLag(50))).toEqual({ severity: 'ok', word: 'ok' })
  })
  it('is lagging above 50ms and up to exactly 500ms', () => {
    expect(freshellStatus(withLag(50.01))).toEqual({ severity: 'warn', word: 'lagging' })
    expect(freshellStatus(withLag(500))).toEqual({ severity: 'warn', word: 'lagging' })
  })
  it('is blocked above 500ms', () => {
    expect(freshellStatus(withLag(500.01))).toEqual({ severity: 'bad', word: 'blocked' })
  })
  it('degrades to unknown/ok when unavailable', () => {
    const l = makeLive()
    l.freshell = {
      available: false, source: 'node', ptysRunning: 0, ptysMax: 0, wsClients: 0, wsClientsMax: 0,
      eventLoopLagP99Ms: null, rssBytes: null, uptimeSec: 0,
    }
    expect(freshellStatus(l)).toEqual({ severity: 'ok', word: 'unknown' })
  })
})

describe('overallVerdict', () => {
  it('null live → ok ALL GOOD with no offenders (nothing known-bad)', () => {
    expect(overallVerdict(null)).toEqual({ severity: 'ok', label: 'ALL GOOD', offenders: [] })
  })
  it('all-ok live → ALL GOOD', () => {
    expect(overallVerdict(makeLive())).toEqual({ severity: 'ok', label: 'ALL GOOD', offenders: [] })
  })
  it('a warn tile → ELEVATED naming the offender', () => {
    const l = makeLive()
    l.cpu.usagePct = 80
    expect(overallVerdict(l)).toEqual({ severity: 'warn', label: 'ELEVATED', offenders: ['CPU BUSY'] })
  })
  it('a bad tile → TROUBLE', () => {
    const l = makeLive()
    l.cpu.usagePct = 95
    expect(overallVerdict(l)).toEqual({ severity: 'bad', label: 'TROUBLE', offenders: ['CPU MAXED'] })
  })
  it('orders offenders bad-first then warn, tile order within a tier', () => {
    const l = makeLive()
    l.cpu.usagePct = 80 // warn (tile slot 0)
    l.memory.usedBytes = 8_500 // warn (tile slot 1)
    l.paging.swapOutKbps = 5_001 // bad (tile slot 2)
    expect(overallVerdict(l)).toEqual({
      severity: 'bad',
      label: 'TROUBLE',
      offenders: ['PAGING THRASHING', 'CPU BUSY', 'MEMORY TIGHT'],
    })
  })
  it('unavailable sections are not offenders and never elevate', () => {
    const l = makeLive()
    l.memory = {
      available: false, source: 'host', totalBytes: 0, usedBytes: 0, availableBytes: 0,
      cgroupLimitBytes: null, swapTotalBytes: null, swapUsedBytes: null,
    }
    expect(overallVerdict(l)).toEqual({ severity: 'ok', label: 'ALL GOOD', offenders: [] })
  })
})
