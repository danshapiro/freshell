import fs from 'node:fs'
import path from 'node:path'

/**
 * HARNESS-12 — leak and resource measurements for the e2e-browser harness.
 *
 * Snapshot an OWNED server's process tree (the root PID plus every /proc
 * descendant — PTY shell/provider children keep PPID pointed at the server
 * even after they `setsid()`, so a ppid BFS finds them where a
 * `kill(-pgid)`-style group enumeration cannot, see rust-server.ts's class
 * doc comment) and capture, per process: open-fd handle count, RSS, thread
 * count, owned TCP LISTEN ports, and TCP socket rx/tx queue bytes; plus
 * tree-level totals the diff/bounds layer asserts against.
 *
 * Design rules:
 * - Synchronous and pure Node against an injectable `procRoot` (default
 *   `/proc`, fabricated in unit tests) — no `ps` subprocess. Unit tests
 *   therefore need no process spawning, and the collector itself is what the
 *   Playwright proof only has to wire up.
 * - Vanish-tolerant: any pid may exit between the directory listing and the
 *   individual file reads (stress loops reap PTYs constantly), so every
 *   per-pid read degrades to exclusion or `null` fields instead of throwing.
 * - Ownership-safe: we only ever READ /proc entries reachable from caller-
 *   supplied root pids (plus the read-only host-wide `net/tcp*` tables,
 *   whose rows are attributed strictly by socket-inode ↔ fd links of owned
 *   pids). Nothing is ever signaled or written here.
 * - TCP-only for listening ports: the Freshell servers only ever bind TCP
 *   listeners, and /proc's `net/udp*` has no LISTEN state, so UDP rows are
 *   out of scope by construction.
 *
 * Tauri note: the API is host-generic (callers pass arbitrary root PID sets;
 * a desktop lane would pass the app's process-tree roots). This /proc backend
 * is Linux; a Windows handle/port backend rides with the Windows-host
 * campaign — see docs/plans/df1-evidence/HARNESS-12.md.
 */

export interface CaptureOptions {
  /** Default `/proc`; tests point this at a fabricated proc tree. */
  procRoot?: string
}

export interface SocketQueueBytes {
  rxBytes: number
  txBytes: number
}

export interface ProcessSnapshot {
  pid: number
  ppid: number
  comm: string
  state: string
  rssBytes: number | null
  threads: number | null
  /** Open handle (fd) count; null when `<pid>/fd` is unreadable/gone. */
  fdCount: number | null
  /** Sorted, deduped TCP ports this pid LISTENs on. */
  listeningPorts: number[]
  /** Summed tx/rx queue bytes across this pid's sockets. */
  socketQueue: SocketQueueBytes
}

export interface ResourceSnapshot {
  capturedAt: string
  rootPids: number[]
  processCount: number
  totalRssBytes: number
  totalFdCount: number
  totalThreads: number
  totalSocketQueue: SocketQueueBytes
  /** Sorted, deduped union of all per-process LISTEN ports. */
  listeningPorts: number[]
  /** Sorted by pid. */
  processes: ProcessSnapshot[]
}

export interface SnapshotBounds {
  /** Default 256 MiB — a leak gate, not a perf gate. */
  maxRssGrowthBytes?: number
  /** Default 16. */
  maxFdGrowth?: number
  /** Default 0 (post-settle the tree must return to its baseline size). */
  maxProcessGrowth?: number
  /** Default 1 MiB, applied to the AFTER snapshot's summed socket queues. */
  maxTotalSocketQueueBytes?: number
  /** Ports allowed to appear in AFTER that were not in BEFORE. Default none. */
  allowedNewListeningPorts?: number[]
}

export interface SnapshotDiff {
  failures: string[]
  newListeningPorts: number[]
  lostListeningPorts: number[]
  rssGrowthBytes: number
  fdGrowth: number
  processGrowth: number
  processGrowthPids: number[]
}

const LISTEN_STATE = '0A'

function readTextIfPresent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    // Vanished mid-scan (or never existed) — tolerated per the module contract.
    return null
  }
}

/**
 * Parse `/proc/<pid>/stat`. `comm` may itself contain spaces AND parentheses
 * (e.g. `(bash (login))`), so split on the LAST ')' rather than the first.
 */
function parseStat(content: string): { ppid: number; comm: string; state: string } | null {
  const open = content.indexOf('(')
  const close = content.lastIndexOf(')')
  if (open < 0 || close <= open) return null
  const comm = content.slice(open + 1, close)
  const rest = content.slice(close + 1).trim().split(/\s+/)
  if (rest.length < 2) return null
  const state = rest[0]
  const ppid = Number.parseInt(rest[1], 10)
  if (!Number.isInteger(ppid) || ppid < 0) return null
  return { ppid, comm, state }
}

function parseStatus(content: string): { rssBytes: number | null; threads: number | null } {
  let rssBytes: number | null = null
  let threads: number | null = null
  for (const line of content.split('\n')) {
    if (line.startsWith('VmRSS:')) {
      const m = /^VmRSS:\s+(\d+)\s+kB/.exec(line)
      if (m) rssBytes = Number(m[1]) * 1024
    } else if (line.startsWith('Threads:')) {
      const m = /^Threads:\s+(\d+)/.exec(line)
      if (m) threads = Number(m[1])
    }
  }
  return { rssBytes, threads }
}

interface NetRow {
  inode: string
  localPort: number
  state: string
  txQueueBytes: number
  rxQueueBytes: number
}

/**
 * Parse a `/proc/net/tcp{,6}` table. Column layout (after the header):
 * ` sl local_address rem_address st tx_queue:rx_queue tr tm->when retrnsmt
 * uid timeout inode ...`, i.e. parts[1]=local, parts[3]=state,
 * parts[4]=tx:rx hex, parts[9]=inode.
 */
function parseNetTcp(content: string): NetRow[] {
  const rows: NetRow[] = []
  const lines = content.split('\n')
  for (const raw of lines.slice(1)) {
    const parts = raw.trim().split(/\s+/)
    if (parts.length < 10) continue
    const colon = parts[1].lastIndexOf(':')
    if (colon < 0) continue
    const localPort = Number.parseInt(parts[1].slice(colon + 1), 16)
    if (!Number.isInteger(localPort)) continue
    const [txHex = '0', rxHex = '0'] = parts[4].split(':')
    rows.push({
      inode: parts[9],
      localPort,
      state: parts[3],
      txQueueBytes: Number.parseInt(txHex, 16) || 0,
      rxQueueBytes: Number.parseInt(rxHex, 16) || 0,
    })
  }
  return rows
}

/** Host-wide socket table, keyed and deduped by socket inode. */
function readNetTables(procRoot: string): Map<string, NetRow> {
  const byInode = new Map<string, NetRow>()
  for (const table of ['tcp', 'tcp6']) {
    const content = readTextIfPresent(path.join(procRoot, 'net', table))
    if (content === null) continue
    for (const row of parseNetTcp(content)) {
      if (!byInode.has(row.inode)) byInode.set(row.inode, row)
    }
  }
  return byInode
}

/** Every live pid's stat, keyed by pid. Pids that vanish mid-scan are dropped. */
function listAliveStats(procRoot: string): Map<number, { ppid: number; comm: string; state: string }> {
  let entries: string[]
  try {
    entries = fs.readdirSync(procRoot)
  } catch {
    return new Map()
  }
  const stats = new Map<number, { ppid: number; comm: string; state: string }>()
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    const pid = Number(entry)
    const content = readTextIfPresent(path.join(procRoot, entry, 'stat'))
    if (content === null) continue
    const stat = parseStat(content)
    if (stat) stats.set(pid, stat)
  }
  return stats
}

/** Root pids (that are alive) plus every descendant via ppid chains. */
function collectOwnedPids(
  rootPids: number[],
  stats: Map<number, { ppid: number; comm: string; state: string }>,
): Set<number> {
  const owned = new Set<number>()
  for (const pid of rootPids) {
    if (stats.has(pid)) owned.add(pid)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, stat] of stats) {
      if (!owned.has(pid) && owned.has(stat.ppid)) {
        owned.add(pid)
        changed = true
      }
    }
  }
  return owned
}

/** Open-fd count plus socket inodes, via `<pid>/fd/` symlinks. */
function readFdInfo(procRoot: string, pid: number): { fdCount: number | null; socketInodes: string[] } {
  const fdDir = path.join(procRoot, String(pid), 'fd')
  let names: string[]
  try {
    names = fs.readdirSync(fdDir)
  } catch {
    // fd dir vanished (process exited mid-scan) or is unreadable.
    return { fdCount: null, socketInodes: [] }
  }
  const socketInodes: string[] = []
  for (const name of names) {
    let target: string
    try {
      target = fs.readlinkSync(path.join(fdDir, name))
    } catch {
      continue // fd closed mid-scan or not a link (regular fixture file)
    }
    const m = /^socket:\[(\d+)\]$/.exec(target)
    if (m) socketInodes.push(m[1])
  }
  return { fdCount: names.length, socketInodes }
}

/**
 * Snapshot the process trees rooted at `rootPids` (typically one owned server
 * PID from an owned Rust fixture's `info.pid`). Roots that are no
 * longer alive yield an empty snapshot rather than an error — callers compare
 * `processCount` against their own baseline.
 */
export function captureResourceSnapshot(rootPids: number[], opts: CaptureOptions = {}): ResourceSnapshot {
  const procRoot = opts.procRoot ?? '/proc'
  const stats = listAliveStats(procRoot)
  const owned = collectOwnedPids(rootPids, stats)
  const netByInode = readNetTables(procRoot)

  const processes: ProcessSnapshot[] = []
  for (const pid of [...owned].sort((a, b) => a - b)) {
    const stat = stats.get(pid)!
    const pidDir = path.join(procRoot, String(pid))
    const status = readTextIfPresent(path.join(pidDir, 'status'))
    const { rssBytes, threads } = status !== null
      ? parseStatus(status)
      : { rssBytes: null, threads: null }
    const { fdCount, socketInodes } = readFdInfo(procRoot, pid)

    const listeningPorts = new Set<number>()
    let rxBytes = 0
    let txBytes = 0
    for (const inode of socketInodes) {
      const row = netByInode.get(inode)
      if (!row) continue
      rxBytes += row.rxQueueBytes
      txBytes += row.txQueueBytes
      if (row.state === LISTEN_STATE) listeningPorts.add(row.localPort)
    }

    processes.push({
      pid,
      ppid: stat.ppid,
      comm: stat.comm,
      state: stat.state,
      rssBytes,
      threads,
      fdCount,
      listeningPorts: [...listeningPorts].sort((a, b) => a - b),
      socketQueue: { rxBytes, txBytes },
    })
  }

  const allPorts = new Set<number>()
  let totalRssBytes = 0
  let totalFdCount = 0
  let totalThreads = 0
  let totalRxBytes = 0
  let totalTxBytes = 0
  for (const p of processes) {
    for (const port of p.listeningPorts) allPorts.add(port)
    totalRssBytes += p.rssBytes ?? 0
    totalFdCount += p.fdCount ?? 0
    totalThreads += p.threads ?? 0
    totalRxBytes += p.socketQueue.rxBytes
    totalTxBytes += p.socketQueue.txBytes
  }

  return {
    capturedAt: new Date().toISOString(),
    rootPids: [...rootPids],
    processCount: processes.length,
    totalRssBytes,
    totalFdCount,
    totalThreads,
    totalSocketQueue: { rxBytes: totalRxBytes, txBytes: totalTxBytes },
    listeningPorts: [...allPorts].sort((a, b) => a - b),
    processes,
  }
}

export interface StableBaselineOptions {
  /**
   * Consecutive qualifying samples required before the tree is declared
   * steady. A sample qualifies iff it is zombie-free AND its live (non-Z)
   * pid set equals the previous qualifying sample's. Default 3, minimum 2
   * (a single sample can never be a fixed point).
   */
  stableSamples?: number
  /** Wait between samples. Default 250ms (a fixed point then spans ≥500ms). */
  intervalMs?: number
  /** Give up after this long; the error names the still-changing live set. Default 20s. */
  timeoutMs?: number
  /** Injectable for tests; default `captureResourceSnapshot`. */
  capture?: (rootPids: number[]) => ResourceSnapshot
  /** Injectable for tests; default setTimeout-based. */
  sleep?: (ms: number) => Promise<void>
  /** Injectable for tests; default Date.now. */
  nowMs?: () => number
}

/**
 * Capture a baseline ONLY at a fixed point of the process tree: the live
 * (non-zombie) pid set must be identical across `stableSamples` consecutive
 * zombie-free samples.
 *
 * Why not merely wait for zombies == 0 (gate B003, 2026-08-09): a baseline
 * captured the instant no zombie exists can still freeze a still-RUNNING
 * startup spawns `ipconfig.exe` (bootstrap.ts LAN-IP detection, awaited
 * pre-listen) and `netsh.exe` (firewall.ts detectFirewall via the
 * fire-and-forget startup getStatus() banner) in S-state around the
 * health-ok line. Such a transient holds no leak (it exits on its own), but
 * an equality-settle assertion calibrated to a baseline that contains it can
 * then never be satisfied ("expected 2 live, got 1", 15s timeout). The
 * fixed-point protocol derives the baseline from the server's ACTUAL steady
 * state on any host and any load — a zombie appearing mid-streak resets it,
 * so a zombie that never reaps still yields a (loud) timeout, never a
 * silently-unstable baseline.
 */
export async function captureStableBaseline(
  rootPids: number[],
  opts: StableBaselineOptions = {},
): Promise<ResourceSnapshot> {
  const stableSamples = opts.stableSamples ?? 3
  const intervalMs = opts.intervalMs ?? 250
  const timeoutMs = opts.timeoutMs ?? 20_000
  const capture = opts.capture ?? ((pids: number[]) => captureResourceSnapshot(pids))
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const nowMs = opts.nowMs ?? (() => Date.now())

  if (!Number.isInteger(stableSamples) || stableSamples < 2) {
    throw new RangeError(`captureStableBaseline: stableSamples must be an integer >= 2 (got ${stableSamples})`)
  }

  const start = nowMs()
  let streak = 0
  let prevLiveKey: string | null = null

  for (;;) {
    const snap = capture(rootPids)
    const live = snap.processes.filter((p) => p.state !== 'Z')
    const liveKey = live.map((p) => p.pid).sort((a, b) => a - b).join(',')
    const zombies = snap.processes.length - live.length

    if (zombies === 0 && liveKey === prevLiveKey) {
      streak += 1
    } else if (zombies === 0) {
      streak = 1
      prevLiveKey = liveKey
    } else {
      // A zombie window discards all earlier clean samples.
      streak = 0
      prevLiveKey = null
    }

    if (streak >= stableSamples) return snap

    if (nowMs() - start >= timeoutMs) {
      const describe = (p: ProcessSnapshot) => `${p.comm}:${p.pid}(ppid ${p.ppid}, ${p.state})`
      throw new Error(
        `captureStableBaseline: tree rooted at [${rootPids.join(', ')}] never reached a fixed point ` +
        `within ${timeoutMs}ms (last live set: ${live.map(describe).join(', ') || '(empty)'}; zombies: ${zombies})`,
      )
    }

    await sleep(intervalMs)
  }
}

/**
 * Every TCP LISTEN port on the (net-namespace) host, regardless of which
 * process owns it — used by teardown assertions of the form "the owned
 * server's port is gone", where the owning process itself no longer exists
 * to be snapshotted.
 */
export function captureHostListeningPorts(opts: CaptureOptions = {}): number[] {
  const procRoot = opts.procRoot ?? '/proc'
  const ports = new Set<number>()
  for (const row of readNetTables(procRoot).values()) {
    if (row.state === LISTEN_STATE) ports.add(row.localPort)
  }
  return [...ports].sort((a, b) => a - b)
}

/**
 * Diff an AFTER snapshot against the BEFORE baseline under bounded-growth
 * rules. Port LOSS is recorded (`lostListeningPorts`) but is not itself a
 * failure here — whether a port may disappear is a per-scenario assertion
 * (a restart keeps it; a stop must drop it), so this layer stays mechanical.
 */
export function diffSnapshots(
  before: ResourceSnapshot,
  after: ResourceSnapshot,
  bounds: SnapshotBounds = {},
): SnapshotDiff {
  const maxRssGrowthBytes = bounds.maxRssGrowthBytes ?? 256 * 1024 * 1024
  const maxFdGrowth = bounds.maxFdGrowth ?? 16
  const maxProcessGrowth = bounds.maxProcessGrowth ?? 0
  const maxTotalSocketQueueBytes = bounds.maxTotalSocketQueueBytes ?? 1024 * 1024
  const allowedNewListeningPorts = new Set(bounds.allowedNewListeningPorts ?? [])

  const beforePids = new Set(before.processes.map((p) => p.pid))
  const beforePorts = new Set(before.listeningPorts)
  const afterPorts = new Set(after.listeningPorts)

  const processGrowthPids = after.processes.map((p) => p.pid).filter((pid) => !beforePids.has(pid))
  const newListeningPorts = after.listeningPorts.filter((p) => !beforePorts.has(p))
  const lostListeningPorts = before.listeningPorts.filter((p) => !afterPorts.has(p))

  const rssGrowthBytes = after.totalRssBytes - before.totalRssBytes
  const fdGrowth = after.totalFdCount - before.totalFdCount
  const processGrowth = after.processCount - before.processCount
  const afterQueueBytes = after.totalSocketQueue.rxBytes + after.totalSocketQueue.txBytes

  const failures: string[] = []
  const disallowedPorts = newListeningPorts.filter((p) => !allowedNewListeningPorts.has(p))
  if (disallowedPorts.length > 0) {
    failures.push(`new listening ports [${disallowedPorts.join(', ')}] appeared after the stress loop (allowed: none)`)
  }
  if (rssGrowthBytes > maxRssGrowthBytes) {
    failures.push(`RSS grew by ${rssGrowthBytes} bytes (bound ${maxRssGrowthBytes})`)
  }
  if (fdGrowth > maxFdGrowth) {
    failures.push(`open-fd handle count grew by ${fdGrowth} (bound ${maxFdGrowth})`)
  }
  if (processGrowth > maxProcessGrowth) {
    failures.push(
      `process count grew by ${processGrowth} (bound ${maxProcessGrowth}); new pids [${processGrowthPids.join(', ')}]`,
    )
  }
  if (afterQueueBytes > maxTotalSocketQueueBytes) {
    failures.push(`post-settle socket queue bytes ${afterQueueBytes} exceed bound ${maxTotalSocketQueueBytes}`)
  }

  return {
    failures,
    newListeningPorts,
    lostListeningPorts,
    rssGrowthBytes,
    fdGrowth,
    processGrowth,
    processGrowthPids,
  }
}
