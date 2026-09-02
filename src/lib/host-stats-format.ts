/**
 * Pure display formatters for host-stat tiles. No threshold logic lives here
 * (thresholds are in host-stats-status.ts); these never return throws on
 * degenerate input — non-finite/negative values render as '—' so a tile can
 * never lie with a synthesized zero.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  const text = unit === 0 || value >= 100
    ? String(Math.round(value))
    : value >= 10 ? value.toFixed(1) : value.toFixed(2)
  return `${text} ${BYTE_UNITS[unit]}`
}

/** Bytes-per-second rates (diskIo.readBps/writeBps, network.rxBps/txBps). */
export function formatBytesPerSec(bytesPerSec: number): string {
  const rendered = formatBytes(bytesPerSec)
  return rendered === '—' ? rendered : `${rendered}/s`
}

export function formatPercent(pct: number): string {
  if (!Number.isFinite(pct)) return '—'
  return `${pct >= 100 ? Math.round(pct) : pct.toFixed(1)}%`
}

/** Sub-second millisecond values (disk await, event-loop lag p99). */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms >= 100) return `${Math.round(ms)} ms`
  if (ms >= 10) return `${ms.toFixed(1)} ms`
  return `${ms.toFixed(2)} ms`
}

/** Uptime-style durations: '45s', '12m', '3h 12m', '2d 5h'. */
export function formatUptimeSec(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—'
  const s = Math.floor(totalSeconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
