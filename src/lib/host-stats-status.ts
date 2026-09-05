import type { HostStatsLive } from '@shared/ws-protocol'

/**
 * Pure status-word mapping for host-stat tiles (docs/plans/2026-08-25-host-pressure-pane.md
 * "Pane/component contract"). All threshold logic lives here; components never embed it.
 *
 * Severity mapping (frozen per this module): ok → ok; busy/tight/swapping/slow/errors/lagging
 * → warn; maxed/full/thrashing/stalled/blocked → bad. Every function degrades to
 * 'unknown' (ok-grey) when its section is !available.
 */

export type StatusWord = 'ok' | 'busy' | 'maxed' | 'tight' | 'full' | 'swapping' | 'thrashing' | 'stalled' | 'slow'
  | 'errors' | 'lagging' | 'blocked' | 'unknown'
export type Severity = 'ok' | 'warn' | 'bad'
export interface TileStatus { severity: Severity; word: string } // word is the DISPLAY word (uppercased at render)

const UNKNOWN: TileStatus = { severity: 'ok', word: 'unknown' }
const OK: TileStatus = { severity: 'ok', word: 'ok' }

export const HOST_STATS_THRESHOLDS = {
  cpuBusyPct: 80,
  cpuMaxedPct: 95,
  memoryTightPct: 85,
  memoryFullPct: 97,
  pagingThrashingKbps: 5000,
  psiStalledFull10: 1.0,
  diskIoSlowAwaitMs: 20,
  diskIoStalledAwaitMs: 100,
  limitsTightPct: 70,
  limitsFullPct: 90,
  freshellLaggingMs: 50,
  freshellBlockedMs: 500,
} as const

export function cpuStatus(l: HostStatsLive): TileStatus {
  if (!l.cpu.available) return UNKNOWN
  const pct = l.cpu.usagePct
  if (pct >= HOST_STATS_THRESHOLDS.cpuMaxedPct) return { severity: 'bad', word: 'maxed' }
  if (pct >= HOST_STATS_THRESHOLDS.cpuBusyPct) return { severity: 'warn', word: 'busy' }
  return OK
}

export function memoryStatus(l: HostStatsLive): TileStatus {
  if (!l.memory.available) return UNKNOWN
  // totalBytes is the EFFECTIVE limit: the service reports the cgroup leaf limit
  // as totalBytes whenever one applies (a cgroup current is never mixed with a
  // host total), so no client-side cgroup special-casing.
  if (l.memory.totalBytes <= 0) return OK
  const pct = (l.memory.usedBytes / l.memory.totalBytes) * 100
  if (pct >= HOST_STATS_THRESHOLDS.memoryFullPct) return { severity: 'bad', word: 'full' }
  if (pct >= HOST_STATS_THRESHOLDS.memoryTightPct) return { severity: 'warn', word: 'tight' }
  return OK
}

export function pagingStatus(l: HostStatsLive): TileStatus {
  if (!l.paging.available) return UNKNOWN
  // Single-snapshot semantics: the rate is already smoothed over the 2s fast
  // interval — there is deliberately NO 2-tick carry/cross-tick memory.
  const combinedKbps = l.paging.swapInKbps + l.paging.swapOutKbps
  if (combinedKbps > HOST_STATS_THRESHOLDS.pagingThrashingKbps) return { severity: 'bad', word: 'thrashing' }
  if (combinedKbps > 0) return { severity: 'warn', word: 'swapping' }
  return OK
}

export function psiStatus(l: HostStatsLive): TileStatus {
  if (!l.psi.available) return UNKNOWN
  // Only full10 stalls (all tasks blocked); some10 is never a stall. psistall is
  // strict > 1.0. Null full10 values are skipped.
  const fulls = [l.psi.memFull10, l.psi.ioFull10]
  if (fulls.some((v) => v !== null && v > HOST_STATS_THRESHOLDS.psiStalledFull10)) {
    return { severity: 'bad', word: 'stalled' }
  }
  return OK
}

export function diskIoStatus(l: HostStatsLive): TileStatus {
  if (!l.diskIo.available) return UNKNOWN
  // The service already aggregates worst-device-wins (max utilPct device also
  // provides the weighted await); this only maps the aggregated field. null = no
  // ios in the sampling window.
  if (l.diskIo.weightedAwaitMs === null) return OK
  if (l.diskIo.weightedAwaitMs > HOST_STATS_THRESHOLDS.diskIoStalledAwaitMs) return { severity: 'bad', word: 'stalled' }
  if (l.diskIo.weightedAwaitMs > HOST_STATS_THRESHOLDS.diskIoSlowAwaitMs) return { severity: 'warn', word: 'slow' }
  return OK
}

export function networkStatus(l: HostStatsLive): TileStatus {
  if (!l.network.available) return UNKNOWN
  const errorDelta = l.network.rxErrorsDelta + l.network.txErrorsDelta
    + l.network.rxDroppedDelta + l.network.txDroppedDelta
  if (errorDelta > 0) return { severity: 'warn', word: 'errors' }
  return OK
}

export function limitsStatus(l: HostStatsLive): TileStatus {
  if (!l.limits.available) return UNKNOWN
  // Per sub-limit (fds, pids, timeWait-share-of-ephemeral), worst drives the tile.
  const pcts: number[] = []
  if (l.limits.fdsUsed !== null && l.limits.fdsMax !== null && l.limits.fdsMax > 0) {
    pcts.push((l.limits.fdsUsed / l.limits.fdsMax) * 100)
  }
  if (l.limits.pidsUsed !== null && l.limits.pidsMax !== null && l.limits.pidsMax > 0) {
    pcts.push((l.limits.pidsUsed / l.limits.pidsMax) * 100)
  }
  if (l.limits.timeWait !== null && l.limits.ephemeralPorts !== null && l.limits.ephemeralPorts > 0) {
    pcts.push((l.limits.timeWait / l.limits.ephemeralPorts) * 100)
  }
  const worst = pcts.length > 0 ? Math.max(...pcts) : 0
  if (worst >= HOST_STATS_THRESHOLDS.limitsFullPct) return { severity: 'bad', word: 'full' }
  if (worst >= HOST_STATS_THRESHOLDS.limitsTightPct) return { severity: 'warn', word: 'tight' }
  return OK
}

export function freshellStatus(l: HostStatsLive): TileStatus {
  if (!l.freshell.available) return UNKNOWN
  // Node: monitorEventLoopDelay p99; Rust: scheduler drift p99 — both mean
  // "how late the runtime was to run its own timer". null = unmeasurable.
  const lag = l.freshell.eventLoopLagP99Ms
  if (lag === null) return OK
  if (lag > HOST_STATS_THRESHOLDS.freshellBlockedMs) return { severity: 'bad', word: 'blocked' }
  if (lag > HOST_STATS_THRESHOLDS.freshellLaggingMs) return { severity: 'warn', word: 'lagging' }
  return OK
}

const VERDICT_TILE_ORDER: Array<{ name: string; status: (l: HostStatsLive) => TileStatus }> = [
  { name: 'CPU', status: cpuStatus },
  { name: 'MEMORY', status: memoryStatus },
  { name: 'PAGING', status: pagingStatus },
  { name: 'PSI', status: psiStatus },
  { name: 'DISK I/O', status: diskIoStatus },
  { name: 'NETWORK', status: networkStatus },
  { name: 'LIMITS', status: limitsStatus },
  { name: 'FRESHELL', status: freshellStatus },
]

/**
 * Verdict strip: ALL GOOD (green) / ELEVATED (amber) / TROUBLE (red). Offenders
 * use the per-tile status words (uppercased), bad tiles first, then warn, each
 * in fixed tile order. Unavailable ('unknown') sections are ok-grey and never
 * offend. A null snapshot means nothing is known-bad yet → ALL GOOD.
 */
export function overallVerdict(l: HostStatsLive | null): { severity: Severity; label: string; offenders: string[] } {
  if (!l) return { severity: 'ok', label: 'ALL GOOD', offenders: [] }
  const tiles = VERDICT_TILE_ORDER.map((tile) => ({ name: tile.name, status: tile.status(l) }))
  const bad = tiles.filter((t) => t.status.severity === 'bad')
  const warn = tiles.filter((t) => t.status.severity === 'warn')
  const offenders = [...bad, ...warn].map((t) => `${t.name} ${t.status.word.toUpperCase()}`)
  if (bad.length > 0) return { severity: 'bad', label: 'TROUBLE', offenders }
  if (warn.length > 0) return { severity: 'warn', label: 'ELEVATED', offenders }
  return { severity: 'ok', label: 'ALL GOOD', offenders: [] }
}
