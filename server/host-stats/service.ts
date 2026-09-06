/**
 * HostStatsService — subscriber-gated, two-tier host pressure collector
 * (docs/plans/2026-08-25-host-pressure-pane.md, Task 3 contract lines 411–490).
 *
 * Tiers: FAST (default FRESHELL_HOST_STATS_FAST_MS || 2000) reads cpu/load/memory
 * (cgroup-aware)/paging/psi + freshell internals; SLOW (default FRESHELL_HOST_STATS_SLOW_MS
 * || 5000) reads diskstats/netdev/tcp/limits/cpufreq. Rates (cpu%, paging KB/s, disk/net
 * B/s) come from CUMULATIVE reader counters delta'd over dt — the readers stay pure; the
 * previous sample of each counter family lives here. The first tick of each family has no
 * window, so it reports null-safe zeros (rates 0, nullable windows null).
 *
 * start() runs ONE immediate fast tick (a fresh subscriber gets a shaped snapshot at once);
 * the slow tier only ticks on its own interval. stop() halts ALL collection (true zero
 * cost). getSnapshot() never blocks on I/O — ticks write caches, snapshots read caches.
 *
 * refresh() (on-request manual data — process table, disks, inotify, thermals/battery) is
 * single-flight with a 1s post-completion cooldown (connection-agnostic, R3M6). Section
 * budgets are COOPERATIVE: every section gets a shared absolute deadline
 * (start + sectionBudgetMs; scanProcessTable's deadlineMs param exists for this) and an
 * overallBudgetMs watchdog marks any still-running section failed. A failed section keeps
 * the full zero-shape + available:false + a sectionErrors entry; other sections complete.
 *
 * Platform: /proc + /sys readers are Linux-only. On darwin the fast tier branches to
 * os.cpus()/os.loadavg()/os.totalmem() (no subprocess in the service; the single `ps`
 * subprocess lives inside scanProcessTable's darwin path) and /proc- or /sys-dependent
 * sections are skipped entirely (full zero-shape, available:false, no reader calls).
 */
import os from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { HostStatsLive, HostStatsMachine, HostStatsManual } from '../../shared/ws-protocol.js'
import { logger } from '../logger.js'
import {
  DeadlineExceeded,
  readBattery,
  readCgroupMemory,
  readCpuFreqMHz,
  readCpuTimes,
  readDiskStats,
  readEphemeralPortRange,
  readInotifyLimits,
  readLoadavg,
  readMachineInfo,
  readMeminfo,
  readNetDev,
  readPidCount,
  readPidsLimit,
  readPsi,
  readSelfFdCount,
  readSelfInotifyStats,
  readSelfLimitsFdsMax,
  readTcpStateCounts,
  readThermals,
  readVmstat,
  scanProcessTable,
  statfsInfo,
  type CpuTimes,
} from './readers.js'

const log = logger.child({ component: 'host-stats' })

const DEFAULT_FAST_MS = 2000
const DEFAULT_SLOW_MS = 5000
const DEFAULT_SECTION_BUDGET_MS = 2000
const DEFAULT_OVERALL_BUDGET_MS = 4000
/** No re-start stampede: refresh() rejects <1s after the previous refresh COMPLETED. */
const REFRESH_MIN_INTERVAL_MS = 1000
/** On-request process-table dwell (two /proc samples + dwell → per-process cpuPct). */
const PROC_SCAN_DWELL_MS = 300
const DISK_SECTOR_BYTES = 512
/**
 * /proc/vmstat pswpin/pswpout count PAGES; 4KB pages on every production target.
 * Documented assumption (aarch64 16K/64K pages would mis-scale the rate, not the shape).
 */
const VMSTAT_PAGE_KB = 4

export interface HostStatsServiceDeps {
  procRoot?: string // test injection; default '/proc' (null on darwin → scan's ps path)
  sysRoot?: string
  fastMs?: number // default env FRESHELL_HOST_STATS_FAST_MS || 2000
  slowMs?: number // default env FRESHELL_HOST_STATS_SLOW_MS || 5000
  sectionBudgetMs?: number // default 2000
  overallBudgetMs?: number // default 4000
  getPtyCounts?: () => { running: number; max: number } // OPTIONAL seed; real wiring via setSources
  getWsClientCounts?: () => { clients: number; max: number } // OPTIONAL seed; same
  now?: () => number // test injection
}

export type HostStatsSnapshot = {
  at: number
  live: HostStatsLive
  manualAt: number | null
  manual: HostStatsManual | null
}

type IntervalTimer = ReturnType<typeof setInterval>
type Histogram = ReturnType<typeof monitorEventLoopDelay>
type PrevSample<T> = { at: number; value: T }

type ManualSectionKey = 'topProcesses' | 'processHealth' | 'inotify' | 'disks' | 'thermals'
type ManualSectionValue = HostStatsManual[ManualSectionKey]

const LIVE_SECTION_ZERO: {
  cpu: () => HostStatsLive['cpu']
  load: (cores: number) => HostStatsLive['load']
  memory: () => HostStatsLive['memory']
  paging: () => HostStatsLive['paging']
  psi: () => HostStatsLive['psi']
  diskIo: () => HostStatsLive['diskIo']
  network: () => HostStatsLive['network']
  limits: () => HostStatsLive['limits']
  freshell: () => HostStatsLive['freshell']
} = {
  cpu: () => ({ available: false, usagePct: 0, stealPct: null, perCorePct: [], freqMHz: null }),
  load: (cores) => ({ available: false, load1: 0, load5: 0, load15: 0, cores }),
  memory: () => ({
    available: false,
    source: 'host',
    totalBytes: 0,
    usedBytes: 0,
    availableBytes: 0,
    cgroupLimitBytes: null,
    swapTotalBytes: null,
    swapUsedBytes: null,
  }),
  paging: () => ({ available: false, swapInKbps: 0, swapOutKbps: 0, majFaultsPerSec: 0, oomKillsDelta: 0, oomKillsTotal: 0 }),
  psi: () => ({ available: false, cpuSome10: null, memSome10: null, memFull10: null, ioSome10: null, ioFull10: null }),
  diskIo: () => ({ available: false, readBps: 0, writeBps: 0, utilPct: null, weightedAwaitMs: null }),
  network: () => ({
    available: false,
    rxBps: 0,
    txBps: 0,
    rxErrorsTotal: 0,
    txErrorsTotal: 0,
    rxDroppedTotal: 0,
    txDroppedTotal: 0,
    rxErrorsDelta: 0,
    txErrorsDelta: 0,
    rxDroppedDelta: 0,
    txDroppedDelta: 0,
  }),
  limits: () => ({ available: false, fdsUsed: null, fdsMax: null, pidsUsed: null, pidsMax: null, timeWait: null, ephemeralPorts: null }),
  freshell: () => ({
    available: false,
    source: 'node',
    ptysRunning: 0,
    ptysMax: 0,
    wsClients: 0,
    wsClientsMax: 0,
    eventLoopLagP99Ms: null,
    rssBytes: null,
    uptimeSec: 0,
  }),
}

function zeroManualSection(key: ManualSectionKey): ManualSectionValue {
  switch (key) {
    case 'topProcesses':
      return { available: false, dwellMs: 0, list: [] }
    case 'processHealth':
      return { available: false, zombies: 0, dState: 0, total: 0 }
    case 'inotify':
      return { available: false, instances: null, watches: null, maxUserWatches: null, maxUserInstances: null }
    case 'disks':
      return { available: false, list: [] }
    case 'thermals':
      return { available: false, zones: [], battery: null }
  }
}

function zeroManual(): HostStatsManual {
  return {
    topProcesses: zeroManualSection('topProcesses') as HostStatsManual['topProcesses'],
    processHealth: zeroManualSection('processHealth') as HostStatsManual['processHealth'],
    inotify: zeroManualSection('inotify') as HostStatsManual['inotify'],
    disks: zeroManualSection('disks') as HostStatsManual['disks'],
    thermals: zeroManualSection('thermals') as HostStatsManual['thermals'],
    sectionErrors: {},
  }
}

function zeroLive(machine: HostStatsMachine): HostStatsLive {
  return {
    machine,
    cpu: LIVE_SECTION_ZERO.cpu(),
    load: LIVE_SECTION_ZERO.load(machine.cores),
    memory: LIVE_SECTION_ZERO.memory(),
    paging: LIVE_SECTION_ZERO.paging(),
    psi: LIVE_SECTION_ZERO.psi(),
    diskIo: LIVE_SECTION_ZERO.diskIo(),
    network: LIVE_SECTION_ZERO.network(),
    limits: LIVE_SECTION_ZERO.limits(),
    freshell: LIVE_SECTION_ZERO.freshell(),
  }
}

function envPositiveMs(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function clampPct(value: number): number {
  return Math.min(Math.max(value, 0), 100)
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

export class HostStatsService {
  private readonly platform: NodeJS.Platform
  private readonly procRoot: string | null
  private readonly sysRoot: string
  private readonly cgroupRoot: string
  private readonly fastMs: number
  private readonly slowMs: number
  private readonly sectionBudgetMs: number
  private readonly overallBudgetMs: number
  private readonly nowFn: () => number
  private getPtyCounts: () => { running: number; max: number }
  private getWsClientCounts: () => { clients: number; max: number }

  private readonly machine: HostStatsMachine
  private liveCache: HostStatsLive
  private manualCache: HostStatsManual | null = null
  private manualAt: number | null = null

  private running = false
  private fastTimer: IntervalTimer | undefined
  private slowTimer: IntervalTimer | undefined
  private histogram: Histogram | null = null
  private snapshotListener: ((snap: HostStatsSnapshot) => void) | null = null

  private prevCpu: PrevSample<CpuTimes> | null = null
  private prevDarwinCpu: PrevSample<{ total: number; busy: number }[]> | null = null
  private prevVmstat: PrevSample<NonNullable<ReturnType<typeof readVmstat>>> | null = null
  private prevDisks: PrevSample<NonNullable<ReturnType<typeof readDiskStats>>> | null = null
  private prevNet: PrevSample<NonNullable<ReturnType<typeof readNetDev>>> | null = null

  private pendingRefresh: Promise<{ at: number; manual: HostStatsManual }> | null = null
  private lastRefreshCompletedAt: number | null = null

  constructor(deps: HostStatsServiceDeps = {}) {
    this.platform = process.platform
    this.procRoot = deps.procRoot ?? (this.platform === 'darwin' ? null : '/proc')
    this.sysRoot = deps.sysRoot ?? '/sys'
    this.cgroupRoot = `${this.sysRoot}/fs/cgroup`
    this.fastMs = deps.fastMs ?? envPositiveMs('FRESHELL_HOST_STATS_FAST_MS', DEFAULT_FAST_MS)
    this.slowMs = deps.slowMs ?? envPositiveMs('FRESHELL_HOST_STATS_SLOW_MS', DEFAULT_SLOW_MS)
    this.sectionBudgetMs = deps.sectionBudgetMs ?? DEFAULT_SECTION_BUDGET_MS
    this.overallBudgetMs = deps.overallBudgetMs ?? DEFAULT_OVERALL_BUDGET_MS
    this.nowFn = deps.now ?? (() => Date.now())
    this.getPtyCounts = deps.getPtyCounts ?? (() => ({ running: 0, max: 0 }))
    this.getWsClientCounts = deps.getWsClientCounts ?? (() => ({ clients: 0, max: 0 }))
    // One cheap capability probe at construction (dir listings only, degraded-safe). The
    // machine probe is not a /proc-dependent tick SECTION, so it also runs on darwin.
    this.machine = readMachineInfo(this.procRoot ?? '/proc', this.sysRoot)
    this.liveCache = zeroLive(this.machine)
  }

  /** Real provider wiring lands after the WsHandler exists (chicken-egg fix in index.ts). */
  setSources(src: {
    getPtyCounts?: () => { running: number; max: number }
    getWsClientCounts?: () => { clients: number; max: number }
  }): void {
    if (src.getPtyCounts) this.getPtyCounts = src.getPtyCounts
    if (src.getWsClientCounts) this.getWsClientCounts = src.getWsClientCounts
  }

  start(): void {
    if (this.running) return
    this.running = true
    let histogram: Histogram | null = null
    try {
      histogram = monitorEventLoopDelay()
      histogram.enable()
    } catch (err) {
      histogram = null
      log.warn({ err }, 'event-loop lag histogram unavailable; eventLoopLagP99Ms will be null')
    }
    this.histogram = histogram
    this.tickFast() // one immediate fast tick: first-tick null-safe zeros for new subscribers
    this.fastTimer = setInterval(() => this.tickFast(), this.fastMs)
    this.slowTimer = setInterval(() => this.tickSlow(), this.slowMs)
    this.fastTimer.unref?.()
    this.slowTimer.unref?.()
  }

  stop(): void {
    if (!this.running) return // idempotent
    this.running = false
    if (this.fastTimer) clearInterval(this.fastTimer)
    this.fastTimer = undefined
    if (this.slowTimer) clearInterval(this.slowTimer)
    this.slowTimer = undefined
    this.histogram?.disable()
    this.histogram = null
  }

  isRunning(): boolean {
    return this.running
  }

  /** Cache read only — NEVER waits on I/O newer than the last tick (ticks write caches). */
  getSnapshot(): HostStatsSnapshot {
    return { at: this.nowFn(), live: this.liveCache, manualAt: this.manualAt, manual: this.manualCache }
  }

  /** Single-listener slot; cb fires after every fast tick and after a successful refresh. */
  onSnapshot(cb: ((snap: HostStatsSnapshot) => void) | null): void {
    this.snapshotListener = cb
  }

  /**
   * On-request manual data. Single-flight (concurrent callers share ONE in-flight promise)
   * plus a connection-agnostic 1s post-completion cooldown ('rate_limited'). Never rejects
   * for data reasons: a failed section degrades to its zero-shape while the others complete.
   */
  refresh(): Promise<{ at: number; manual: HostStatsManual }> {
    if (this.pendingRefresh) return this.pendingRefresh
    const lastCompleted = this.lastRefreshCompletedAt
    if (lastCompleted !== null && this.nowFn() - lastCompleted < REFRESH_MIN_INTERVAL_MS) {
      return Promise.reject(new Error('rate_limited'))
    }
    const tracked = this.runRefresh().finally(() => {
      this.pendingRefresh = null
      this.lastRefreshCompletedAt = this.nowFn()
    })
    this.pendingRefresh = tracked
    return tracked
  }

  // ---------------------------------------------------------------------------
  // Ticks
  // ---------------------------------------------------------------------------

  private tickFast(): void {
    const at = this.nowFn()
    this.liveCache = {
      ...this.liveCache,
      cpu: this.readCpuSection(at),
      load: this.readLoadSection(),
      memory: this.readMemorySection(),
      paging: this.readPagingSection(at),
      psi: this.readPsiSection(),
      freshell: this.readFreshellSection(),
    }
    this.emitSnapshot()
  }

  private tickSlow(): void {
    // Every slow-tier reader is /proc- or /sys-based → nothing to collect on darwin.
    if (this.platform === 'darwin') return
    const at = this.nowFn()
    this.liveCache = {
      ...this.liveCache,
      cpu: { ...this.liveCache.cpu, freqMHz: readCpuFreqMHz(this.sysRoot) },
      diskIo: this.readDiskIoSection(at),
      network: this.readNetworkSection(at),
      limits: this.readLimitsSection(),
    }
  }

  private emitSnapshot(): void {
    if (!this.snapshotListener) return
    try {
      this.snapshotListener(this.getSnapshot())
    } catch (err) {
      log.warn({ err }, 'host-stats snapshot listener threw')
    }
  }

  // ---------------------------------------------------------------------------
  // Fast-tier sections
  // ---------------------------------------------------------------------------

  private readCpuSection(at: number): HostStatsLive['cpu'] {
    if (this.platform === 'darwin') return this.readDarwinCpuSection(at)
    const sample = readCpuTimes(this.procRoot ?? '/proc')
    if (!sample) return LIVE_SECTION_ZERO.cpu()
    const prev = this.prevCpu
    this.prevCpu = { at, value: sample }
    const freqMHz = this.liveCache.cpu.freqMHz
    if (!prev || at <= prev.at || sample.total <= prev.value.total) {
      return { available: true, usagePct: 0, stealPct: 0, perCorePct: sample.perCore.map(() => 0), freqMHz }
    }
    const dTotal = sample.total - prev.value.total
    return {
      available: true,
      usagePct: clampPct(((sample.busy - prev.value.busy) / dTotal) * 100),
      stealPct: clampPct(((sample.steal - prev.value.steal) / dTotal) * 100),
      perCorePct: sample.perCore.map((core, i) => {
        const before = prev.value.perCore[i]
        if (!before) return 0
        const dCoreTotal = core.total - before.total
        return dCoreTotal <= 0 ? 0 : clampPct(((core.busy - before.busy) / dCoreTotal) * 100)
      }),
      freqMHz,
    }
  }

  /** darwin CPU: [user+nice+sys] / total per core from os.cpus() deltas; steal always null. */
  private readDarwinCpuSection(at: number): HostStatsLive['cpu'] {
    const cores = os.cpus().map((cpu) => {
      const t = cpu.times
      return { total: t.user + t.nice + t.sys + t.idle + t.irq, busy: t.user + t.nice + t.sys }
    })
    const prev = this.prevDarwinCpu
    this.prevDarwinCpu = { at, value: cores }
    if (!prev || at <= prev.at || cores.length !== prev.value.length) {
      return { available: true, usagePct: 0, stealPct: null, perCorePct: cores.map(() => 0), freqMHz: null }
    }
    let dTotal = 0
    let dBusy = 0
    const perCorePct = cores.map((core, i) => {
      const dt = core.total - prev.value[i].total
      const db = core.busy - prev.value[i].busy
      dTotal += dt
      dBusy += db
      return dt <= 0 ? 0 : clampPct((db / dt) * 100)
    })
    return {
      available: true,
      usagePct: dTotal <= 0 ? 0 : clampPct((dBusy / dTotal) * 100),
      stealPct: null,
      perCorePct,
      freqMHz: null,
    }
  }

  private readLoadSection(): HostStatsLive['load'] {
    const cores = this.machine.cores
    if (this.platform === 'darwin') {
      const [load1, load5, load15] = os.loadavg()
      return { available: true, load1, load5, load15, cores }
    }
    const load = readLoadavg(this.procRoot ?? '/proc')
    if (!load) return LIVE_SECTION_ZERO.load(cores)
    return { available: true, load1: load.load1, load5: load.load5, load15: load.load15, cores }
  }

  /**
   * Memory precedence (contract point 2): a FINITE cgroup leaf limit wins outright
   * (source 'cgroup'; total/used/available/limit all from the leaf). Unlimited or absent →
   * host meminfo (source 'host'); a cgroup current is NEVER mixed with a host total.
   * Swap stays host-scoped context either way (no cgroup swap accounting is collected).
   */
  private readMemorySection(): HostStatsLive['memory'] {
    if (this.platform === 'darwin') {
      const totalBytes = os.totalmem()
      const availableBytes = os.freemem()
      return {
        available: true,
        source: 'host',
        totalBytes,
        usedBytes: Math.max(0, totalBytes - availableBytes),
        availableBytes,
        cgroupLimitBytes: null,
        swapTotalBytes: null,
        swapUsedBytes: null,
      }
    }
    const procRoot = this.procRoot ?? '/proc'
    const cgroup = readCgroupMemory(this.cgroupRoot, procRoot)
    const meminfo = readMeminfo(procRoot)
    const swapTotalBytes = meminfo ? meminfo.swapTotalKB * 1024 : null
    const swapUsedBytes = meminfo ? (meminfo.swapTotalKB - meminfo.swapFreeKB) * 1024 : null
    if (cgroup && cgroup.limitBytes !== null) {
      return {
        available: true,
        source: 'cgroup',
        totalBytes: cgroup.limitBytes,
        usedBytes: cgroup.currentBytes,
        availableBytes: Math.max(0, cgroup.limitBytes - cgroup.currentBytes),
        cgroupLimitBytes: cgroup.limitBytes,
        swapTotalBytes,
        swapUsedBytes,
      }
    }
    if (meminfo) {
      const totalBytes = meminfo.totalKB * 1024
      const availableBytes = meminfo.availKB * 1024
      return {
        available: true,
        source: 'host',
        totalBytes,
        usedBytes: Math.max(0, totalBytes - availableBytes),
        availableBytes,
        cgroupLimitBytes: null,
        swapTotalBytes,
        swapUsedBytes,
      }
    }
    return LIVE_SECTION_ZERO.memory()
  }

  private readPagingSection(at: number): HostStatsLive['paging'] {
    if (this.platform === 'darwin') return LIVE_SECTION_ZERO.paging()
    const vm = readVmstat(this.procRoot ?? '/proc')
    if (!vm) return LIVE_SECTION_ZERO.paging()
    const prev = this.prevVmstat
    this.prevVmstat = { at, value: vm }
    const oomKillsTotal = vm.oomKill ?? 0
    if (!prev || at <= prev.at) {
      return { available: true, swapInKbps: 0, swapOutKbps: 0, majFaultsPerSec: 0, oomKillsDelta: 0, oomKillsTotal }
    }
    const dtSec = (at - prev.at) / 1000
    const prevOom = prev.value.oomKill
    return {
      available: true,
      swapInKbps: (Math.max(vm.pswpin - prev.value.pswpin, 0) * VMSTAT_PAGE_KB) / dtSec,
      swapOutKbps: (Math.max(vm.pswpout - prev.value.pswpout, 0) * VMSTAT_PAGE_KB) / dtSec,
      majFaultsPerSec: Math.max(vm.pgmajfault - prev.value.pgmajfault, 0) / dtSec,
      oomKillsDelta: vm.oomKill !== null && prevOom !== null ? Math.max(vm.oomKill - prevOom, 0) : 0,
      oomKillsTotal,
    }
  }

  private readPsiSection(): HostStatsLive['psi'] {
    if (this.platform === 'darwin') return LIVE_SECTION_ZERO.psi()
    const psi = readPsi(this.procRoot ?? '/proc')
    if (!psi) return LIVE_SECTION_ZERO.psi()
    return {
      available: true,
      cpuSome10: psi.cpuSome10,
      memSome10: psi.memSome10,
      memFull10: psi.memFull10,
      ioSome10: psi.ioSome10,
      ioFull10: psi.ioFull10,
    }
  }

  private readFreshellSection(): HostStatsLive['freshell'] {
    const ptys = this.safeCallCounts(this.getPtyCounts, { running: 0, max: 0 })
    const ws = this.safeCallCounts(this.getWsClientCounts, { clients: 0, max: 0 })
    return {
      available: true,
      source: 'node',
      ptysRunning: toCount(ptys.running),
      ptysMax: toCount(ptys.max),
      wsClients: toCount(ws.clients),
      wsClientsMax: toCount(ws.max),
      eventLoopLagP99Ms: this.drainLagP99Ms(),
      rssBytes: process.memoryUsage().rss,
      uptimeSec: process.uptime(),
    }
  }

  private safeCallCounts<T>(fn: () => T, fallback: T): T {
    try {
      return fn()
    } catch (err) {
      log.warn({ err }, 'host-stats counts provider threw; reporting zeros')
      return fallback
    }
  }

  /** p99 scheduler delay in ms collected since the previous fast tick; null when off/unmeasurable. */
  private drainLagP99Ms(): number | null {
    if (!this.histogram) return null
    const ns = this.histogram.percentile(99)
    this.histogram.reset()
    return typeof ns === 'number' && Number.isFinite(ns) && ns >= 0 ? ns / 1e6 : null
  }

  // ---------------------------------------------------------------------------
  // Slow-tier sections
  // ---------------------------------------------------------------------------

  private readDiskIoSection(at: number): HostStatsLive['diskIo'] {
    const devs = readDiskStats(this.procRoot ?? '/proc')
    if (!devs) return LIVE_SECTION_ZERO.diskIo()
    const prev = this.prevDisks
    this.prevDisks = { at, value: devs }
    if (!prev || at <= prev.at) return { available: true, readBps: 0, writeBps: 0, utilPct: null, weightedAwaitMs: null }
    const dtMs = at - prev.at
    const dtSec = dtMs / 1000
    let readBytes = 0
    let writeBytes = 0
    let utilPct: number | null = null
    let weightedAwaitMs: number | null = null
    for (const [name, cur] of devs) {
      const before = prev.value.get(name)
      if (!before) continue
      readBytes += Math.max(cur.readSectors - before.readSectors, 0) * DISK_SECTOR_BYTES
      writeBytes += Math.max(cur.writtenSectors - before.writtenSectors, 0) * DISK_SECTOR_BYTES
      // Multi-device rule (plan thresholds): worst device wins; util can never exceed 100.
      const util = clampPct((Math.max(cur.timeDoingIosMs - before.timeDoingIosMs, 0) / dtMs) * 100)
      if (utilPct === null || util > utilPct) {
        utilPct = util
        const ios = Math.max(cur.readsCompleted - before.readsCompleted, 0) + Math.max(cur.writesCompleted - before.writesCompleted, 0)
        const ioMs = Math.max(cur.readMs - before.readMs, 0) + Math.max(cur.writeMs - before.writeMs, 0)
        weightedAwaitMs = ios > 0 ? ioMs / ios : null
      }
    }
    return { available: true, readBps: readBytes / dtSec, writeBps: writeBytes / dtSec, utilPct, weightedAwaitMs }
  }

  private readNetworkSection(at: number): HostStatsLive['network'] {
    const net = readNetDev(this.procRoot ?? '/proc')
    if (!net) return LIVE_SECTION_ZERO.network()
    const prev = this.prevNet
    this.prevNet = { at, value: net }
    const totals = {
      rxErrorsTotal: Math.max(net.rxErr, 0),
      txErrorsTotal: Math.max(net.txErr, 0),
      rxDroppedTotal: Math.max(net.rxDrop, 0),
      txDroppedTotal: Math.max(net.txDrop, 0),
    }
    if (!prev || at <= prev.at) {
      return { available: true, rxBps: 0, txBps: 0, ...totals, rxErrorsDelta: 0, txErrorsDelta: 0, rxDroppedDelta: 0, txDroppedDelta: 0 }
    }
    const dtSec = (at - prev.at) / 1000
    return {
      available: true,
      rxBps: Math.max(net.rxBytes - prev.value.rxBytes, 0) / dtSec,
      txBps: Math.max(net.txBytes - prev.value.txBytes, 0) / dtSec,
      ...totals,
      rxErrorsDelta: Math.max(net.rxErr - prev.value.rxErr, 0),
      txErrorsDelta: Math.max(net.txErr - prev.value.txErr, 0),
      rxDroppedDelta: Math.max(net.rxDrop - prev.value.rxDrop, 0),
      txDroppedDelta: Math.max(net.txDrop - prev.value.txDrop, 0),
    }
  }

  private readLimitsSection(): HostStatsLive['limits'] {
    const procRoot = this.procRoot ?? '/proc'
    const fdsUsed = readSelfFdCount(procRoot)
    const fdsMax = readSelfLimitsFdsMax(procRoot)
    const pidsUsed = readPidCount(procRoot)
    const pidsMax = readPidsLimit(procRoot, this.cgroupRoot)
    const tcp = readTcpStateCounts(procRoot)
    const ports = readEphemeralPortRange(procRoot)
    const timeWait = tcp ? tcp.timeWait : null
    const ephemeralPorts = ports ? ports.end - ports.start + 1 : null
    const any = fdsUsed ?? fdsMax ?? pidsUsed ?? pidsMax ?? timeWait ?? ephemeralPorts
    if (any === null) return LIVE_SECTION_ZERO.limits()
    return { available: true, fdsUsed, fdsMax, pidsUsed, pidsMax, timeWait, ephemeralPorts }
  }

  // ---------------------------------------------------------------------------
  // On-request refresh: data-driven section list (Task 9's Rust port mirrors this list)
  // ---------------------------------------------------------------------------

  private refreshSections(deadlineMs: number): { key: ManualSectionKey; run: () => Promise<ManualSectionValue> }[] {
    // topProcesses + processHealth come from ONE process-table scan (two samples + dwell);
    // both sections share the scan promise, so one scan failure degrades both.
    let scanPromise: ReturnType<typeof scanProcessTable> | undefined
    const scan = () => (scanPromise ??= scanProcessTable(this.procRoot, PROC_SCAN_DWELL_MS, deadlineMs))
    return [
      {
        key: 'topProcesses',
        run: async () => {
          const table = await scan()
          if (!table) return zeroManualSection('topProcesses')
          return { available: true, dwellMs: PROC_SCAN_DWELL_MS, list: table.top }
        },
      },
      {
        key: 'processHealth',
        run: async () => {
          const table = await scan()
          if (!table) return zeroManualSection('processHealth')
          return { available: true, zombies: table.zombies, dState: table.dState, total: table.total }
        },
      },
      {
        key: 'inotify',
        run: async () => {
          if (this.platform === 'darwin' || this.procRoot === null) return zeroManualSection('inotify')
          const self = readSelfInotifyStats(this.procRoot)
          const limits = readInotifyLimits(this.procRoot)
          if (!self && !limits) return zeroManualSection('inotify')
          return {
            available: true,
            instances: self?.instances ?? null,
            watches: self?.watches ?? null,
            maxUserWatches: limits?.maxUserWatches ?? null,
            maxUserInstances: limits?.maxUserInstances ?? null,
          }
        },
      },
      {
        key: 'disks',
        run: async () => {
          const mounts = this.platform === 'darwin' ? ['/'] : ['/', '/dev/shm']
          const list: HostStatsManual['disks']['list'] = []
          for (const mount of mounts) {
            const info = statfsInfo(mount)
            if (info) list.push({ mount, ...info })
          }
          return list.length > 0 ? { available: true, list } : zeroManualSection('disks')
        },
      },
      {
        key: 'thermals',
        run: async () => {
          const zones = readThermals(this.sysRoot)
          if (!zones) return zeroManualSection('thermals')
          const battery = readBattery(this.sysRoot)
          return { available: true, zones, battery }
        },
      },
    ]
  }

  private async runRefresh(): Promise<{ at: number; manual: HostStatsManual }> {
    const startedAt = this.nowFn()
    const deadlineMs = startedAt + this.sectionBudgetMs
    const manual = zeroManual()
    const sectionErrors: Record<string, string> = {}
    const assign = (key: ManualSectionKey, value: ManualSectionValue) => {
      ;(manual as Record<ManualSectionKey, ManualSectionValue>)[key] = value
    }

    let watchdogTimer: ReturnType<typeof setTimeout> | undefined
    const watchdog = new Promise<never>((_, reject) => {
      watchdogTimer = setTimeout(
        () => reject(new DeadlineExceeded('host-stats refresh overall budget exceeded')),
        this.overallBudgetMs,
      )
    })
    // If the timer ever fires with no section still racing, its rejection has a handler.
    watchdog.catch(() => {})

    try {
      await Promise.all(
        this.refreshSections(deadlineMs).map(async ({ key, run }) => {
          let failed = false
          const fail = (err: unknown) => {
            if (failed) return
            failed = true
            assign(key, zeroManualSection(key))
            sectionErrors[key] = err instanceof Error ? err.message : String(err)
            log.warn(
              { event: 'host_stats_section_timeout', section: key, budgetMs: this.sectionBudgetMs, err },
              'host-stats refresh section failed',
            )
          }
          try {
            // Sections are cooperatively deadline'd; the watchdog only preempts a section
            // that is STILL running past the overall budget.
            const value = await Promise.race([run(), watchdog])
            if (!failed) assign(key, value) // a section that lost the watchdog race is not revived
          } catch (err) {
            fail(err)
          }
        }),
      )
    } finally {
      if (watchdogTimer) clearTimeout(watchdogTimer)
    }

    manual.sectionErrors = sectionErrors
    const at = this.nowFn()
    this.manualCache = manual
    this.manualAt = at
    // Merged snapshot: live may be one tick stale, manual/manualAt are fresh (contract 9).
    this.emitSnapshot()
    return { at, manual }
  }
}
