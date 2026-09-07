import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  activateHostStats,
  deactivateHostStats,
  requestHostStatsRefresh,
} from '@/store/hostStatsSlice'
import {
  cpuStatus,
  diskIoStatus,
  freshellStatus,
  limitsStatus,
  memoryStatus,
  networkStatus,
  overallVerdict,
  pagingStatus,
  psiStatus,
  type Severity,
  type TileStatus,
} from '@/lib/host-stats-status'
import {
  formatBytes,
  formatBytesPerSec,
  formatMs,
  formatPercent,
  formatUptimeSec,
} from '@/lib/host-stats-format'
import type { HostStatsLive, HostStatsManual } from '@shared/ws-protocol'
import { cn } from '@/lib/utils'

/**
 * Host pressure dashboard pane (docs/plans/2026-08-25-host-pressure-pane.md,
 * Task 7 render contract). The pane is stateless: every value comes from the
 * connection-level hostStats slice (live: subscription snapshots; manual:
 * on-request refresh). All threshold logic lives in lib/host-stats-status —
 * this component only maps statuses to pixels.
 *
 * Placeholder rule (frozen): unavailable/degraded/never-measured values and
 * `*Max === 0` (the "no cap on this server implementation" convention, Rust
 * sends 0) render as an em dash, never a literal zero — a zero would lie.
 */

export type HostStatsPaneProps = { tabId: string; paneId: string }

const EM_DASH = '—'

// Desaturation ramp for the ON REQUEST group: full color for 30s, then a
// shared linear fade to fully grey at 5 minutes, computed against server-now
// (Date.now() - clockOffsetMs). Recomputed by a pane-local 1s interval.
const SATURATION_FULL_COLOR_MS = 30_000
const SATURATION_RAMP_MS = 300_000 - SATURATION_FULL_COLOR_MS

function manualSaturation(ageMs: number): number {
  if (ageMs <= SATURATION_FULL_COLOR_MS) return 1
  return Math.min(1, Math.max(0, 1 - (ageMs - SATURATION_FULL_COLOR_MS) / SATURATION_RAMP_MS))
}

/** Age label text — 'updated 12s ago' / 'just now'. */
function formatAgeLabel(ageMs: number): string {
  if (ageMs < 5_000) return 'just now'
  const s = Math.floor(ageMs / 1_000)
  if (s < 60) return `updated ${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `updated ${m}m ${s % 60}s ago`
  const h = Math.floor(m / 60)
  return `updated ${h}h ${m % 60}m ago`
}

const SEVERITY_CLASSES: Record<Severity, string> = {
  ok: 'bg-success/15 text-success',
  warn: 'bg-warning/15 text-warning',
  bad: 'bg-destructive/10 text-destructive',
}
const NEUTRAL_CLASSES = 'bg-muted text-muted-foreground'

function pillClasses(status: TileStatus): string {
  return cn(
    'rounded-full px-1.5 text-[10px] font-medium',
    status.word === 'unknown' ? NEUTRAL_CLASSES : SEVERITY_CLASSES[status.severity],
  )
}

/** 'unknown' (section unavailable) never claims OK — it shows the em dash. */
function pillWord(status: TileStatus): string {
  return status.word === 'unknown' ? EM_DASH : status.word.toUpperCase()
}

function orDash(value: number | null | undefined, format: (n: number) => string = String): string {
  return typeof value === 'number' && Number.isFinite(value) ? format(value) : EM_DASH
}

/** PSI avg10 values are percentages; nullable per pressure class. */
function psiPct(value: number | null): string {
  return orDash(value, (p) => `${p.toFixed(1)}%`)
}

/** `used / max` pairs; a null/0 max is the no-cap convention → em dash. */
function usedOfMax(used: number | null, max: number | null): string {
  if (used === null || max === null || max === 0) return EM_DASH
  return `${used} / ${max}`
}

function Tile({ tileId, title, status, value, rows }: {
  tileId: string
  title: string
  status?: TileStatus
  value: string
  rows?: ReactNode
}) {
  return (
    <div data-host-stats-tile={tileId} className="rounded-lg border border-border bg-card p-2">
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs text-muted-foreground">{title}</span>
        {status ? <span className={pillClasses(status)}>{pillWord(status)}</span> : null}
      </div>
      <div data-host-stats-value className="text-xl font-semibold tabular-nums">{value}</div>
      {rows ? <div className="mt-1 space-y-0.5 text-xs text-muted-foreground tabular-nums">{rows}</div> : null}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="truncate">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

const CORE_BAR_SLOTS = 12

function coreBarClass(pct: number | null): string {
  if (pct === null) return 'bg-muted'
  if (pct >= 95) return 'bg-destructive'
  if (pct >= 80) return 'bg-warning'
  return 'bg-success'
}

/** 12 tiny per-core bars — pure presentational, stride-sampled onto 12 slots. */
function PerCoreBars({ perCorePct }: { perCorePct: number[] }) {
  return (
    <div className="mt-1 flex items-end gap-0.5" aria-hidden="true">
      {Array.from({ length: CORE_BAR_SLOTS }, (_, slot) => {
        const pct = perCorePct.length > 0
          ? perCorePct[Math.min(perCorePct.length - 1, Math.floor((slot * perCorePct.length) / CORE_BAR_SLOTS))]
          : null
        return <span key={slot} className={cn('inline-block h-3 w-2 rounded-sm', coreBarClass(pct))} />
      })}
    </div>
  )
}

const SECTION_KEYS = ['cpu', 'memory', 'paging', 'psi', 'diskIo', 'network', 'limits', 'freshell'] as const

function MachineDetails({ live }: { live: HostStatsLive | null }) {
  const machine = live?.machine ?? null
  const degradedSections = live
    ? SECTION_KEYS.filter((section) => !live[section].available)
    : []
  return (
    <details className="mt-2">
      <summary className="text-xs text-muted-foreground">
        <span className="tabular-nums">
          {machine
            ? `${machine.cores} cores · ${Math.round(machine.memTotalBytes / 2 ** 30)} GiB RAM${machine.wsl ? ' · WSL2' : ''}`
            : EM_DASH}
        </span>
        {machine ? (
          <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
            <span className="rounded-full bg-muted px-2 text-xs">{machine.psi ? 'PSI' : 'no PSI'}</span>
            <span className="rounded-full bg-muted px-2 text-xs">
              {machine.cgroup === 'none' ? 'no cgroup' : `cgroup ${machine.cgroup}`}
            </span>
            <span className="rounded-full bg-muted px-2 text-xs">{`${machine.thermalCount} thermals`}</span>
            <span className="rounded-full bg-muted px-2 text-xs">{machine.batteryPresent ? 'battery' : 'no battery'}</span>
            <span className="rounded-full bg-muted px-2 text-xs">GPU n/a</span>
          </span>
        ) : null}
      </summary>
      <div className="mt-1 space-y-0.5 text-xs text-muted-foreground tabular-nums">
        <Row label="kernel" value={machine?.kernel ?? EM_DASH} />
        <Row label="hostname" value={machine?.hostname ?? EM_DASH} />
        <Row label="platform" value={machine?.platform ?? EM_DASH} />
        <Row label="cgroup" value={machine?.cgroup ?? EM_DASH} />
        <Row label="PSI readable" value={machine ? (machine.psi ? 'yes' : 'no') : EM_DASH} />
        <Row label="thermal zones" value={machine ? String(machine.thermalCount) : EM_DASH} />
        <Row label="battery" value={machine ? (machine.batteryPresent ? 'present' : 'none') : EM_DASH} />
        <Row label="degraded sections" value={live ? (degradedSections.length > 0 ? degradedSections.join(', ') : 'none') : EM_DASH} />
      </div>
    </details>
  )
}

export default function HostStatsPane(_props: HostStatsPaneProps) {
  const dispatch = useAppDispatch()
  const live = useAppSelector((s) => s.hostStats.live)
  const _liveAt = useAppSelector((s) => s.hostStats.liveAt)
  const manualAt = useAppSelector((s) => s.hostStats.manualAt)
  const manual = useAppSelector((s) => s.hostStats.manual)
  const refresh = useAppSelector((s) => s.hostStats.refresh)
  const clockOffsetMs = useAppSelector((s) => s.hostStats.clockOffsetMs)

  // Subscription refcount: N panes share one connection-level subscription;
  // the 0→1 / 1→0 transitions send hoststats.subscribe / .unsubscribe.
  useEffect(() => {
    dispatch(activateHostStats())
    return () => { dispatch(deactivateHostStats()) }
  }, [dispatch])

  // Pane-local 1s tick driving the desaturation ramp + age label (the label
  // is deliberately NOT aria-live — a 1s-updating live region would nag).
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [])

  // One-shot completion announcer: set when the refresh leaves inFlight
  // without an error (= hostStatsRefreshResolved folded), cleared next tick.
  const [announcement, setAnnouncement] = useState('')
  const previousRefresh = useRef(refresh)
  useEffect(() => {
    const previous = previousRefresh.current
    previousRefresh.current = refresh
    if (previous.inFlight && !refresh.inFlight && refresh.error === null) {
      setAnnouncement('Measurements refreshed')
      const clear = setTimeout(() => setAnnouncement(''), 0)
      return () => clearTimeout(clear)
    }
    return undefined
  }, [refresh])

  const serverNowMs = nowMs - (clockOffsetMs ?? 0)
  const manualAgeMs = manualAt === null ? null : Math.max(0, serverNowMs - manualAt)
  const sat = manualAgeMs === null ? 0 : manualSaturation(manualAgeMs)
  const ageText = manualAgeMs === null ? '' : formatAgeLabel(manualAgeMs)

  const verdict = overallVerdict(live)
  // Task 6 review composition: overallVerdict returns the bare word; ALL GOOD
  // appends the suffix, ELEVATED/TROUBLE append the offenders (bad first, in
  // fixed tile order). live === null stays neutral grey — pre-first-snapshot
  // the strip must not claim ALL GOOD.
  const verdictText = live === null
    ? EM_DASH
    : verdict.severity === 'ok'
      ? 'ALL GOOD — nothing needs attention'
      : `${verdict.label} — ${verdict.offenders.join(' · ')}`

  const cpu = live?.cpu ?? null
  const load = live?.load ?? null
  const memory = live?.memory ?? null
  const paging = live?.paging ?? null
  const psi = live?.psi ?? null
  const diskIo = live?.diskIo ?? null
  const network = live?.network ?? null
  const limits = live?.limits ?? null
  const freshell = live?.freshell ?? null

  const usedMemoryPct = memory?.available === true && memory.totalBytes > 0
    ? (memory.usedBytes / memory.totalBytes) * 100
    : null
  const psiFullValues = psi?.available === true
    ? [psi.memFull10, psi.ioFull10].filter((v): v is number => v !== null)
    : []

  return (
    <section aria-label="Host stats" className="flex h-full flex-col overflow-auto bg-background p-2">
      <div
        role="status"
        className={cn(
          'rounded-md px-2 py-1 text-sm font-medium',
          live === null ? NEUTRAL_CLASSES : SEVERITY_CLASSES[verdict.severity],
        )}
      >
        {verdictText}
      </div>

      <div className="@container">
        <MachineDetails live={live} />

        <div className="mt-2 text-xs text-muted-foreground uppercase tracking-wide">LIVE</div>
        <div className="mt-1 grid grid-cols-2 gap-2 @3xl:grid-cols-3">
          <Tile
            tileId="cpu"
            title="CPU"
            status={live ? cpuStatus(live) : undefined}
            value={cpu?.available === true ? formatPercent(cpu.usagePct) : EM_DASH}
            rows={cpu?.available === true ? (
              <>
                <PerCoreBars perCorePct={cpu.perCorePct} />
                {(cpu.stealPct ?? 0) > 1 ? <Row label="steal" value={formatPercent(cpu.stealPct ?? 0)} /> : null}
                <Row label="freq" value={orDash(cpu.freqMHz, (mhz) => `${Math.round(mhz)} MHz`)} />
              </>
            ) : (
              <PerCoreBars perCorePct={[]} />
            )}
          />
          <Tile
            tileId="load"
            title="Load"
            value={load?.available === true ? load.load1.toFixed(2) : EM_DASH}
            rows={load?.available === true ? (
              <>
                <Row label="5m / 15m" value={`${load.load5.toFixed(2)} / ${load.load15.toFixed(2)}`} />
                <Row label="cores" value={String(load.cores)} />
              </>
            ) : null}
          />
          <Tile
            tileId="memory"
            title="Memory"
            status={live ? memoryStatus(live) : undefined}
            value={usedMemoryPct === null ? EM_DASH : formatPercent(usedMemoryPct)}
            rows={memory?.available === true ? (
              <>
                <Row label="used" value={`${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`} />
                <Row label="source" value={memory.source === 'cgroup' ? 'VM limit' : memory.source} />
                {(memory.swapTotalBytes ?? 0) > 0 ? (
                  <Row label="swap" value={`${formatBytes(memory.swapUsedBytes ?? 0)} / ${formatBytes(memory.swapTotalBytes ?? 0)}`} />
                ) : null}
              </>
            ) : null}
          />
          <Tile
            tileId="paging"
            title="Paging"
            status={live ? pagingStatus(live) : undefined}
            value={paging?.available === true
              ? `${(paging.swapInKbps + paging.swapOutKbps).toFixed(1)} KB/s`
              : EM_DASH}
            rows={paging?.available === true ? (
              <>
                <Row label="swap in / out" value={`${paging.swapInKbps.toFixed(1)} / ${paging.swapOutKbps.toFixed(1)} KB/s`} />
                <Row label="majflt/s" value={String(paging.majFaultsPerSec)} />
                <Row label="oom kills" value={String(paging.oomKillsTotal)} />
              </>
            ) : null}
          />
          <Tile
            tileId="psi"
            title="Pressure (PSI)"
            status={live ? psiStatus(live) : undefined}
            value={psiFullValues.length > 0 ? formatPercent(Math.max(...psiFullValues)) : EM_DASH}
            rows={psi?.available === true ? (
              <>
                <Row label="cpu some10" value={psiPct(psi.cpuSome10)} />
                <Row label="mem some/full" value={`${psiPct(psi.memSome10)} / ${psiPct(psi.memFull10)}`} />
                <Row label="io some/full" value={`${psiPct(psi.ioSome10)} / ${psiPct(psi.ioFull10)}`} />
              </>
            ) : null}
          />
          <Tile
            tileId="disk-io"
            title="Disk I/O"
            status={live ? diskIoStatus(live) : undefined}
            value={diskIo?.available === true ? formatBytesPerSec(diskIo.readBps + diskIo.writeBps) : EM_DASH}
            rows={diskIo?.available === true ? (
              <>
                <Row label="read / write" value={`${formatBytesPerSec(diskIo.readBps)} / ${formatBytesPerSec(diskIo.writeBps)}`} />
                <Row label="util" value={orDash(diskIo.utilPct, (p) => `${p.toFixed(1)}%`)} />
                <Row label="await" value={orDash(diskIo.weightedAwaitMs, formatMs)} />
              </>
            ) : null}
          />
          <Tile
            tileId="network"
            title="Network"
            status={live ? networkStatus(live) : undefined}
            value={network?.available === true ? formatBytesPerSec(network.rxBps + network.txBps) : EM_DASH}
            rows={network?.available === true ? (
              <>
                <Row label="rx / tx" value={`${formatBytesPerSec(network.rxBps)} / ${formatBytesPerSec(network.txBps)}`} />
                <Row label="errors" value={String(network.rxErrorsTotal + network.txErrorsTotal)} />
                <Row label="dropped" value={String(network.rxDroppedTotal + network.txDroppedTotal)} />
              </>
            ) : null}
          />
          <Tile
            tileId="limits"
            title="Limits"
            status={live ? limitsStatus(live) : undefined}
            value={limits?.available === true ? limitsValue(limits) : EM_DASH}
            rows={limits?.available === true ? (
              <>
                <Row label="fds" value={usedOfMax(limits.fdsUsed, limits.fdsMax)} />
                <Row label="pids" value={usedOfMax(limits.pidsUsed, limits.pidsMax)} />
                <Row label="time_wait / ephemeral" value={`${orDash(limits.timeWait)} / ${orDash(limits.ephemeralPorts)}`} />
              </>
            ) : null}
          />
          <Tile
            tileId="freshell"
            title="Freshell Itself"
            status={live ? freshellStatus(live) : undefined}
            value={freshell?.available === true ? usedOfMax(freshell.ptysRunning, freshell.ptysMax) : EM_DASH}
            rows={freshell?.available === true ? (
              <>
                <Row label="ws clients" value={usedOfMax(freshell.wsClients, freshell.wsClientsMax)} />
                <Row label="lag p99" value={orDash(freshell.eventLoopLagP99Ms, formatMs)} />
                <Row label="rss" value={orDash(freshell.rssBytes, formatBytes)} />
                <Row label="uptime" value={formatUptimeSec(freshell.uptimeSec)} />
              </>
            ) : null}
          />
        </div>

        <div
          data-host-stats-on-request
          className="mt-3"
          style={{ filter: `saturate(${sat})` }}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground uppercase tracking-wide">ON REQUEST</span>
            <button
              type="button"
              aria-label="Refresh on-request measurements"
              disabled={refresh.inFlight}
              onClick={() => { dispatch(requestHostStatsRefresh()) }}
              className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-60"
            >
              {refresh.inFlight ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  <span>Collecting…</span>
                </>
              ) : (
                <>
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                  <span>Refresh</span>
                </>
              )}
            </button>
            <span data-host-stats-age className="text-xs text-muted-foreground tabular-nums">{ageText}</span>
            {refresh.error !== null ? (
              <div role="alert" className="text-xs text-destructive">{refresh.error}</div>
            ) : null}
          </div>

          <div className="mt-1 grid grid-cols-2 gap-2 @3xl:grid-cols-3">
            {renderManualTiles(manualAt === null ? null : manual)}
          </div>
        </div>
      </div>

      {/* One-shot completion announcement; the 1s-updating age label above is
          deliberately not a live region. */}
      <div role="status" className="sr-only">{announcement}</div>
    </section>
  )
}

/** Worst capped sub-limit as the Limits headline; all no-cap → em dash. */
function limitsValue(limits: HostStatsLive['limits']): string {
  const pcts: number[] = []
  if (limits.fdsUsed !== null && limits.fdsMax !== null && limits.fdsMax > 0) {
    pcts.push((limits.fdsUsed / limits.fdsMax) * 100)
  }
  if (limits.pidsUsed !== null && limits.pidsMax !== null && limits.pidsMax > 0) {
    pcts.push((limits.pidsUsed / limits.pidsMax) * 100)
  }
  if (limits.timeWait !== null && limits.ephemeralPorts !== null && limits.ephemeralPorts > 0) {
    pcts.push((limits.timeWait / limits.ephemeralPorts) * 100)
  }
  return pcts.length > 0 ? formatPercent(Math.max(...pcts)) : EM_DASH
}

/**
 * On-request tiles. A null manual is the never-measured state (manualAt ===
 * null): every tile renders '—' placeholders. A degraded section
 * (available:false inside a filled manual) renders '—' per value.
 */
function renderManualTiles(manual: HostStatsManual | null): ReactNode {
  const topProcesses = manual?.topProcesses.available === true ? manual.topProcesses : null
  const processHealth = manual?.processHealth.available === true ? manual.processHealth : null
  const inotify = manual?.inotify.available === true ? manual.inotify : null
  const disks = manual?.disks.available === true ? manual.disks : null
  const thermals = manual?.thermals.available === true ? manual.thermals : null

  return (
    <>
      <Tile
        tileId="top-processes"
        title="Top Processes"
        value={topProcesses ? String(topProcesses.list.length) : EM_DASH}
        rows={topProcesses ? topProcesses.list.slice(0, 5).map((proc) => (
          <div key={proc.pid} className="flex items-center justify-between gap-2">
            <span className="truncate">{proc.name}</span>
            <span>{formatPercent(proc.cpuPct)}</span>
            <span>{formatBytes(proc.rssBytes)}</span>
            <span className="rounded bg-muted px-1 text-[10px]">{proc.state}</span>
          </div>
        )) : null}
      />
      <Tile
        tileId="process-health"
        title="Process Health"
        value={processHealth ? String(processHealth.total) : EM_DASH}
        rows={processHealth ? (
          <>
            <Row label="zombies" value={String(processHealth.zombies)} />
            <Row label="D-state" value={String(processHealth.dState)} />
          </>
        ) : null}
      />
      <Tile
        tileId="inotify"
        title="Inotify"
        value={inotify ? usedOfMax(inotify.watches, inotify.maxUserWatches) : EM_DASH}
        rows={inotify ? (
          <Row label="instances" value={usedOfMax(inotify.instances, inotify.maxUserInstances)} />
        ) : null}
      />
      <Tile
        tileId="disks"
        title="Disks"
        value={disks && disks.list.length > 0
          ? formatPercent(Math.max(...disks.list.map((disk) => disk.usedPct)))
          : EM_DASH}
        rows={disks ? disks.list.map((disk) => (
          <Row
            key={disk.mount}
            label={disk.mount}
            value={disk.inodesFree !== null
              ? `${formatPercent(disk.usedPct)} · ${disk.inodesFree} inodes free`
              : formatPercent(disk.usedPct)}
          />
        )) : null}
      />
      <Tile
        tileId="thermals"
        title="Thermals & Battery"
        value={thermals && thermals.zones.length > 0
          ? `${Math.max(...thermals.zones.map((zone) => zone.celsius)).toFixed(1)}°C`
          : EM_DASH}
        rows={thermals ? (
          <>
            {thermals.zones.map((zone) => (
              <Row key={zone.label} label={zone.label} value={`${zone.celsius.toFixed(1)}°C`} />
            ))}
            <Row
              label="battery"
              value={thermals.battery ? `${thermals.battery.pct}% (${thermals.battery.status})` : 'none'}
            />
          </>
        ) : null}
      />
    </>
  )
}
