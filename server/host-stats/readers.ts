/**
 * Host-stats /proc + /sys reader layer (plan: docs/plans/2026-08-25-host-pressure-pane.md,
 * Task 2 contract). Pure, path-injected, synchronous readers (scanProcessTable is the only
 * async/subprocess-capable exception). Every reader NEVER throws on read/parse failure — it
 * returns null instead. The single sanctioned throw is DeadlineExceeded from scanProcessTable
 * (cooperative section budget; the service in Task 3 catches it and degrades the section).
 *
 * Platform notes: /proc readers are Linux-only — on darwin the files do not exist and the
 * readers return null; the caller (service) then uses os.* equivalents (loadavg/memory) or
 * marks the section available:false. The lone subprocess of the whole feature is `ps` inside
 * scanProcessTable's darwin branch, reachable only via the on-request refresh.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { HostStatsMachine } from '../../shared/ws-protocol.js'

const PROC_ROOT = '/proc'
const SYS_ROOT = '/sys'
const CGROUP_ROOT = '/sys/fs/cgroup'

/**
 * USER_HZ=100 is the documented ABI exposure of /proc/<pid>/stat tick fields on every Linux
 * architecture this project targets, so ticks -> seconds is a plain /100. Documented
 * assumption (plan Task 2); computed cpuPct is also clamped defensively.
 */
const USER_HZ = 100

const PROC_STAT_READ_MAX_BYTES = 4096
const PROC_SCAN_CAP = 100_000
const FD_COUNT_CAP = 1_048_576
const PID_COUNT_CAP = 10_000_000
const INOTIFY_FD_SCAN_CAP = 4096
const TOP_PROCESS_COUNT = 12
const PS_TIMEOUT_MS = 2000
/** cgroup v1 reports "unlimited" as a huge sentinel (varies by kernel); >= 2^60 is garbage. */
const CGROUP_V1_GARBAGE_LIMIT = 2 ** 60

/** Thrown by scanProcessTable when the caller's absolute epoch-ms budget is exceeded. */
export class DeadlineExceeded extends Error {
  constructor(message = 'host-stats section deadline exceeded') {
    super(message)
    this.name = 'DeadlineExceeded'
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Read a whole file as utf8; null on any failure. */
function safeRead(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/** Non-empty, right-trimmed lines of a text file's contents. */
function splitLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim().length > 0)
}

/** Parse a file whose entire payload is a single number (e.g. threads-max). */
function readNumberFile(filePath: string): number | null {
  const text = safeRead(filePath)
  if (text === null) return null
  const value = Number(text.trim())
  return Number.isFinite(value) ? value : null
}

/** List a directory; null instead of throwing. */
function safeReaddir(dirPath: string): string[] | null {
  try {
    return fs.readdirSync(dirPath)
  } catch {
    return null
  }
}

/**
 * Resolve THIS process's cgroup leaf from <procRoot>/self/cgroup. The cgroup fs root has NO
 * limit files by design, so callers must always resolve the leaf and never read the fs root.
 */
type CgroupLeaf = { version: 'v1' | 'v2'; path: string } | null

function resolveCgroupLeaf(procRoot: string, v1Controller: string): CgroupLeaf {
  const text = safeRead(path.join(procRoot, 'self', 'cgroup'))
  if (text === null) return null
  const lines = splitLines(text)
  // v2 unified hierarchy: a single "0::/path" line.
  const v2 = lines.find((line) => line.startsWith('0::'))
  if (v2) {
    const leaf = v2.slice('0::'.length).replace(/^\/+/, '')
    if (leaf === '') return null // process sits at the cgroup2 root: no limit files there
    return { version: 'v2', path: leaf }
  }
  // v1: "<hierarchy>:<controller[,controller...]>:/path"
  for (const line of lines) {
    const parts = line.split(':')
    if (parts.length !== 3) continue
    if (!parts[1].split(',').includes(v1Controller)) continue
    const leaf = parts[2].replace(/^\/+/, '')
    if (leaf === '') return null
    return { version: 'v1', path: leaf }
  }
  return null
}

/** 'max' / unreadable / non-finite cgroup limit -> null (unlimited). */
function parseCgroupLimit(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed === 'max') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return value
}

// ---------------------------------------------------------------------------
// CPU / load / memory
// ---------------------------------------------------------------------------

export type CpuTimes = {
  total: number
  busy: number
  steal: number
  perCore: { total: number; busy: number }[]
}

function parseProcStatCpuFields(fields: number[]): { total: number; busy: number; steal: number } | null {
  // user nice system idle iowait irq softirq steal [guest guest_nice]
  if (fields.length < 8 || fields.some((f) => !Number.isFinite(f))) return null
  const total = fields.reduce((sum, value) => sum + value, 0)
  const busy = total - fields[3] - fields[4] // idle + iowait
  return { total, busy, steal: fields[7] }
}

/** '/proc/stat' aggregated + per-core totals; steal jiffies. */
export function readCpuTimes(procRoot: string = PROC_ROOT): CpuTimes | null {
  const text = safeRead(path.join(procRoot, 'stat'))
  if (text === null) return null
  let aggregate: { total: number; busy: number; steal: number } | null = null
  const perCore: { total: number; busy: number }[] = []
  for (const line of splitLines(text)) {
    const match = line.match(/^cpu(\d*)\s+(.*)$/)
    if (!match) continue
    const parsed = parseProcStatCpuFields(match[2].trim().split(/\s+/).map(Number))
    if (!parsed) continue
    if (match[1] === '') {
      aggregate = parsed
    } else {
      perCore[Number(match[1])] = { total: parsed.total, busy: parsed.busy }
    }
  }
  if (!aggregate) return null
  return { total: aggregate.total, busy: aggregate.busy, steal: aggregate.steal, perCore }
}

/** '/proc/loadavg'. On darwin the file does not exist -> null (caller uses os.loadavg()). */
export function readLoadavg(
  procRoot: string = PROC_ROOT,
): { load1: number; load5: number; load15: number } | null {
  const text = safeRead(path.join(procRoot, 'loadavg'))
  if (text === null) return null
  const fields = text.trim().split(/\s+/).map(Number)
  if (fields.length < 3 || fields.slice(0, 3).some((f) => !Number.isFinite(f))) return null
  return { load1: fields[0], load5: fields[1], load15: fields[2] }
}

/** '/proc/meminfo'. Returns null on darwin (file absent); the caller uses os.totalmem()/freemem(). */
export function readMeminfo(
  procRoot: string = PROC_ROOT,
): { totalKB: number; availKB: number; swapTotalKB: number; swapFreeKB: number } | null {
  const text = safeRead(path.join(procRoot, 'meminfo'))
  if (text === null) return null
  const values = new Map<string, number>()
  for (const line of splitLines(text)) {
    const match = line.match(/^([^:]+):\s+(\d+)/)
    if (match) values.set(match[1], Number(match[2]))
  }
  const totalKB = values.get('MemTotal')
  const availKB = values.get('MemAvailable')
  if (totalKB === undefined || availKB === undefined) return null
  return {
    totalKB,
    availKB,
    swapTotalKB: values.get('SwapTotal') ?? 0,
    swapFreeKB: values.get('SwapFree') ?? 0,
  }
}

/**
 * Resolves THIS process's cgroup leaf from <procRoot>/self/cgroup and reads its memory files.
 * v2: '0::/path' -> <cgroupRoot>/path/memory.current + memory.max ('max' -> null limit).
 * v1: 'memory' controller line -> <cgroupRoot>/memory/path/usage_in_bytes + limit_in_bytes
 * (garbage limit >= 2^60 -> null). The cgroup fs root has NO limit files by design, so the
 * leaf is always resolved; never read the fs root. None/unreadable -> null.
 *
 * NOTE (frozen contract): parameter order here is (cgroupRoot, procRoot) — the opposite of
 * readPidsLimit(procRoot, cgroupRoot). Callers: read the signatures, do not assume.
 */
export function readCgroupMemory(
  cgroupRoot: string = CGROUP_ROOT,
  procRoot: string = PROC_ROOT,
): { limitBytes: number | null; currentBytes: number } | null {
  try {
    const leaf = resolveCgroupLeaf(procRoot, 'memory')
    if (!leaf) return null
    if (leaf.version === 'v2') {
      const dir = path.join(cgroupRoot, leaf.path)
      const currentBytes = readNumberFile(path.join(dir, 'memory.current'))
      if (currentBytes === null) return null
      const maxText = safeRead(path.join(dir, 'memory.max'))
      return { limitBytes: maxText === null ? null : parseCgroupLimit(maxText), currentBytes }
    }
    const dir = path.join(cgroupRoot, 'memory', leaf.path)
    const currentBytes = readNumberFile(path.join(dir, 'memory.usage_in_bytes'))
    if (currentBytes === null) return null
    const rawLimit = readNumberFile(path.join(dir, 'memory.limit_in_bytes'))
    // v1 "unlimited" is a huge sentinel value (>= 2^60 depending on kernel) -> null
    const limitBytes = rawLimit === null || rawLimit >= CGROUP_V1_GARBAGE_LIMIT ? null : rawLimit
    return { limitBytes, currentBytes }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Paging / PSI
// ---------------------------------------------------------------------------

/** '/proc/vmstat' paging counters. oomKill is null when the kernel omits the oom_kill line. */
export function readVmstat(
  procRoot: string = PROC_ROOT,
): { pswpin: number; pswpout: number; pgmajfault: number; oomKill: number | null } | null {
  const text = safeRead(path.join(procRoot, 'vmstat'))
  if (text === null) return null
  const values = new Map<string, number>()
  for (const line of splitLines(text)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length === 2) values.set(parts[0], Number(parts[1]))
  }
  const pswpin = values.get('pswpin')
  const pswpout = values.get('pswpout')
  const pgmajfault = values.get('pgmajfault')
  if (pswpin === undefined || pswpout === undefined || pgmajfault === undefined) return null
  if (![pswpin, pswpout, pgmajfault].every((v) => Number.isFinite(v))) return null
  const oomKill = values.get('oom_kill')
  return { pswpin, pswpout, pgmajfault, oomKill: oomKill !== undefined && Number.isFinite(oomKill) ? oomKill : null }
}

/** '/proc/pressure/{cpu,memory,io}' avg10 values; null per-file when unreadable, null overall
 *  when the PSI directory is missing entirely. */
export function readPsi(
  procRoot: string = PROC_ROOT,
): {
  cpuSome10: number | null
  memSome10: number | null
  memFull10: number | null
  ioSome10: number | null
  ioFull10: number | null
} | null {
  const pressureDir = path.join(procRoot, 'pressure')
  const cpu = safeRead(path.join(pressureDir, 'cpu'))
  const memory = safeRead(path.join(pressureDir, 'memory'))
  const io = safeRead(path.join(pressureDir, 'io'))
  if (cpu === null && memory === null && io === null) return null
  return {
    cpuSome10: cpu === null ? null : parsePsiAvg10(cpu, 'some'),
    memSome10: memory === null ? null : parsePsiAvg10(memory, 'some'),
    memFull10: memory === null ? null : parsePsiAvg10(memory, 'full'),
    ioSome10: io === null ? null : parsePsiAvg10(io, 'some'),
    ioFull10: io === null ? null : parsePsiAvg10(io, 'full'),
  }
}

function parsePsiAvg10(text: string, lineKind: 'some' | 'full'): number | null {
  for (const line of splitLines(text)) {
    const match = line.match(/^(some|full)\s+.*?\bavg10=([\d.]+)/)
    if (match && match[1] === lineKind) {
      const value = Number(match[2])
      return Number.isFinite(value) ? value : null
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Disk / network
// ---------------------------------------------------------------------------

type DiskCounters = {
  readsCompleted: number
  readMs: number
  writesCompleted: number
  writeMs: number
  readSectors: number
  writtenSectors: number
  timeDoingIosMs: number
}

/**
 * Whole-device name filter for /proc/diskstats: partitions (sda1, nvme0n1p1, mmcblk0p1),
 * loop and ram devices are excluded; everything else (whole disks, dm-*, drbd, …) is kept —
 * fail-open so an unrecognized whole device is still shown.
 */
function isWholeDevice(name: string): boolean {
  if (/^(?:loop|ram)\d+/.test(name)) return false
  if (/^nvme\d+n\d+p\d+$/.test(name)) return false
  if (/^mmcblk\d+p\d+$/.test(name)) return false
  if (/^(?:sd|vd|xvd|hd)[a-z]+\d+$/.test(name)) return false
  return true
}

/**
 * '/proc/diskstats' keyed by whole-device name. Column mapping (1-indexed per the kernel
 * iostats doc, counted after the device name): readsCompleted=1, readMs=4, writesCompleted=5,
 * writeMs=8, readSectors=3, writtenSectors=7, timeDoingIosMs=10.
 */
export function readDiskStats(procRoot: string = PROC_ROOT): Map<string, DiskCounters> | null {
  const text = safeRead(path.join(procRoot, 'diskstats'))
  if (text === null) return null
  const devices = new Map<string, DiskCounters>()
  for (const line of splitLines(text)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 14) continue
    const name = cols[2]
    if (!isWholeDevice(name)) continue
    const numbers = cols.slice(3).map(Number)
    if (numbers.some((n) => !Number.isFinite(n))) continue
    devices.set(name, {
      readsCompleted: numbers[0], // doc field 1
      readMs: numbers[3], // doc field 4
      writesCompleted: numbers[4], // doc field 5
      writeMs: numbers[7], // doc field 8
      readSectors: numbers[2], // doc field 3
      writtenSectors: numbers[6], // doc field 7
      timeDoingIosMs: numbers[9], // doc field 10
    })
  }
  return devices
}

/**
 * '/proc/net/dev' summed across interfaces, EXCLUDING loopback (lo): loopback traffic is not
 * network pressure on the host. Virtual interfaces (docker0, veth, …) are kept — name-based
 * virtual filtering is more fragile than the small double-count it would avoid.
 */
export function readNetDev(
  procRoot: string = PROC_ROOT,
): { rxBytes: number; txBytes: number; rxErr: number; txErr: number; rxDrop: number; txDrop: number } | null {
  const text = safeRead(path.join(procRoot, 'net', 'dev'))
  if (text === null) return null
  const totals = { rxBytes: 0, txBytes: 0, rxErr: 0, txErr: 0, rxDrop: 0, txDrop: 0 }
  for (const line of splitLines(text)) {
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const name = line.slice(0, colon).trim()
    if (name === 'lo') continue
    const numbers = line
      .slice(colon + 1)
      .trim()
      .split(/\s+/)
      .map(Number)
    if (numbers.length < 16 || numbers.some((n) => !Number.isFinite(n))) continue
    totals.rxBytes += numbers[0]
    totals.rxErr += numbers[2]
    totals.rxDrop += numbers[3]
    totals.txBytes += numbers[8]
    totals.txErr += numbers[10]
    totals.txDrop += numbers[11]
  }
  return totals
}

/** TIME_WAIT (state '06') connection count across '/proc/net/tcp' + '/proc/net/tcp6'. */
export function readTcpStateCounts(procRoot: string = PROC_ROOT): { timeWait: number } | null {
  const tcp = safeRead(path.join(procRoot, 'net', 'tcp'))
  const tcp6 = safeRead(path.join(procRoot, 'net', 'tcp6'))
  if (tcp === null && tcp6 === null) return null
  let timeWait = 0
  for (const text of [tcp, tcp6]) {
    if (text === null) continue
    for (const line of splitLines(text)) {
      const tokens = line.trim().split(/\s+/)
      if (tokens.length < 4 || !/^\d+:$/.test(tokens[0])) continue
      if (tokens[3] === '06') timeWait++
    }
  }
  return { timeWait }
}

/** '/proc/sys/net/ipv4/ip_local_port_range'. */
export function readEphemeralPortRange(procRoot: string = PROC_ROOT): { start: number; end: number } | null {
  const text = safeRead(path.join(procRoot, 'sys', 'net', 'ipv4', 'ip_local_port_range'))
  if (text === null) return null
  const fields = text.trim().split(/\s+/).map(Number)
  if (fields.length < 2 || !Number.isInteger(fields[0]) || !Number.isInteger(fields[1])) return null
  return { start: fields[0], end: fields[1] }
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Count of entries in '/proc/self/fd', capped at 1_048_576. */
export function readSelfFdCount(procRoot: string = PROC_ROOT): number | null {
  const entries = safeReaddir(path.join(procRoot, 'self', 'fd'))
  if (entries === null) return null
  return Math.min(entries.length, FD_COUNT_CAP)
}

/** Count of numeric '/proc' entries (processes), capped at 10_000_000. */
export function readPidCount(procRoot: string = PROC_ROOT): number | null {
  const entries = safeReaddir(procRoot)
  if (entries === null) return null
  let count = 0
  for (const entry of entries) {
    if (/^\d+$/.test(entry)) count++
  }
  return Math.min(count, PID_COUNT_CAP)
}

/**
 * The BINDING process cap: cgroup v2 leaf pids.max ('max' -> unlimited -> fall back), else
 * cgroup v1 pids.max, else '/proc/sys/kernel/threads-max'.
 * '/proc/sys/kernel/pid_max' is a PID-number wrap boundary, NOT a creatable-process cap, and
 * is deliberately never used (validated R3M2).
 *
 * NOTE (frozen contract): parameter order here is (procRoot, cgroupRoot) — the opposite of
 * readCgroupMemory(cgroupRoot, procRoot). Callers: read the signatures, do not assume.
 */
export function readPidsLimit(procRoot: string = PROC_ROOT, cgroupRoot: string = CGROUP_ROOT): number | null {
  try {
    const leaf = resolveCgroupLeaf(procRoot, 'pids')
    if (leaf) {
      const dir = leaf.version === 'v2' ? path.join(cgroupRoot, leaf.path) : path.join(cgroupRoot, 'pids', leaf.path)
      const text = safeRead(path.join(dir, 'pids.max'))
      if (text !== null) {
        const limit = parseCgroupLimit(text)
        if (limit !== null && limit > 0) return limit
        // 'max'/garbage: cgroup says unlimited -> the binding cap is the host limit below
      }
    }
    return readNumberFile(path.join(procRoot, 'sys', 'kernel', 'threads-max'))
  } catch {
    return null
  }
}

/** 'Max open files' SOFT limit from '/proc/self/limits' ('unlimited' -> null). */
export function readSelfLimitsFdsMax(procRoot: string = PROC_ROOT): number | null {
  const text = safeRead(path.join(procRoot, 'self', 'limits'))
  if (text === null) return null
  for (const line of splitLines(text)) {
    const match = line.match(/^Max open files\s+(\S+)/)
    if (!match) continue
    const value = Number(match[1])
    return Number.isInteger(value) && value >= 0 ? value : null
  }
  return null
}

/**
 * inotify usage of THIS process: bounded scan (cap 4096 fds) of /proc/self/fd where the
 * readlink target starts with 'anon_inode:inotify' counts instances; '/proc/self/fdinfo/<fd>'
 * lines starting with 'inotify' count watches.
 */
export function readSelfInotifyStats(procRoot: string = PROC_ROOT): { instances: number; watches: number } | null {
  const entries = safeReaddir(path.join(procRoot, 'self', 'fd'))
  if (entries === null) return null
  let instances = 0
  let watches = 0
  for (const fd of entries.slice(0, INOTIFY_FD_SCAN_CAP)) {
    let target: string
    try {
      target = fs.readlinkSync(path.join(procRoot, 'self', 'fd', fd))
    } catch {
      continue // fd vanished mid-scan
    }
    if (!target.startsWith('anon_inode:inotify')) continue
    instances++
    const fdinfo = safeRead(path.join(procRoot, 'self', 'fdinfo', fd))
    if (fdinfo === null) continue
    for (const line of splitLines(fdinfo)) {
      if (line.startsWith('inotify')) watches++
    }
  }
  return { instances, watches }
}

/** '/proc/sys/fs/inotify/max_user_{watches,instances}'; null when both are unreadable. */
export function readInotifyLimits(
  procRoot: string = PROC_ROOT,
): { maxUserWatches: number | null; maxUserInstances: number | null } | null {
  const maxUserWatches = readNumberFile(path.join(procRoot, 'sys', 'fs', 'inotify', 'max_user_watches'))
  const maxUserInstances = readNumberFile(path.join(procRoot, 'sys', 'fs', 'inotify', 'max_user_instances'))
  if (maxUserWatches === null && maxUserInstances === null) return null
  return { maxUserWatches, maxUserInstances }
}

// ---------------------------------------------------------------------------
// Sysfs sensors / machine info
// ---------------------------------------------------------------------------

/** Mean of '/sys/devices/system/cpu/cpuN/cpufreq/scaling_cur_freq' (kHz -> MHz). */
export function readCpuFreqMHz(sysRoot: string = SYS_ROOT): number | null {
  const cpuDir = path.join(sysRoot, 'devices', 'system', 'cpu')
  const entries = safeReaddir(cpuDir)
  if (entries === null) return null
  const freqs: number[] = []
  for (const entry of entries) {
    if (!/^cpu\d+$/.test(entry)) continue
    const kHz = readNumberFile(path.join(cpuDir, entry, 'cpufreq', 'scaling_cur_freq'))
    if (kHz !== null && kHz > 0) freqs.push(kHz)
  }
  if (freqs.length === 0) return null
  return freqs.reduce((sum, value) => sum + value, 0) / freqs.length / 1000
}

function probePsiReadable(procRoot: string): boolean {
  try {
    return fs.statSync(path.join(procRoot, 'pressure')).isDirectory()
  } catch {
    return false
  }
}

function probeCgroupVersion(procRoot: string): 'v1' | 'v2' | 'none' {
  const text = safeRead(path.join(procRoot, 'self', 'cgroup'))
  if (text === null || text.trim().length === 0) return 'none'
  return splitLines(text).some((line) => line.startsWith('0::')) ? 'v2' : 'v1'
}

function listThermalZones(sysRoot: string): string[] | null {
  const entries = safeReaddir(path.join(sysRoot, 'class', 'thermal'))
  if (entries === null) return null
  return entries
    .filter((entry) => /^thermal_zone\d+$/.test(entry))
    .sort((a, b) => Number(a.slice('thermal_zone'.length)) - Number(b.slice('thermal_zone'.length)))
}

function listBatteryEntries(sysRoot: string): string[] | null {
  const entries = safeReaddir(path.join(sysRoot, 'class', 'power_supply'))
  if (entries === null) return null
  return entries.filter((entry) => {
    const type = safeRead(path.join(sysRoot, 'class', 'power_supply', entry, 'type'))?.trim()
    return type === 'Battery' || (type === undefined && /^bat/i.test(entry))
  })
}

/** Kernel release; prefers the injected procRoot's osrelease, falls back to the live kernel. */
function readKernelRelease(procRoot: string): string {
  const fixtureRelease = safeRead(path.join(procRoot, 'sys', 'kernel', 'osrelease'))?.trim()
  return fixtureRelease !== undefined && fixtureRelease.length > 0 ? fixtureRelease : os.release()
}

/** Machine identity + capability snapshot (cheap probes only — dir listings, no scans). */
export function readMachineInfo(procRoot: string = PROC_ROOT, sysRoot: string = SYS_ROOT): HostStatsMachine {
  const release = readKernelRelease(procRoot)
  const thermalZones = listThermalZones(sysRoot)
  const batteries = listBatteryEntries(sysRoot)
  return {
    cores: os.cpus().length || 1,
    memTotalBytes: os.totalmem(),
    platform: process.platform,
    wsl: /microsoft|wsl/i.test(release),
    kernel: release || null,
    hostname: os.hostname() || null,
    psi: probePsiReadable(procRoot),
    cgroup: probeCgroupVersion(procRoot),
    thermalCount: thermalZones?.length ?? 0,
    batteryPresent: (batteries?.length ?? 0) > 0,
    gpu: 'none', // GPU detection is out of scope by design (renders 'n/a' truthfully)
  }
}

/** fs.statfs on a mount; freeBytes is the unprivileged view (bavail). */
export function statfsInfo(mount: string): {
  totalBytes: number
  freeBytes: number
  usedPct: number
  inodesTotal: number | null
  inodesFree: number | null
} | null {
  try {
    const stats = fs.statfsSync(mount)
    const totalBytes = stats.bsize * stats.blocks
    const freeBytes = stats.bsize * stats.bavail
    const usedPct = stats.blocks > 0 ? (1 - stats.bavail / stats.blocks) * 100 : 0
    // inodes from files/ffree; some filesystems report 0/0 -> null
    const inodesTotal = stats.files > 0 ? stats.files : null
    const inodesFree = stats.files > 0 ? stats.ffree : null
    return { totalBytes, freeBytes, usedPct, inodesTotal, inodesFree }
  } catch {
    return null
  }
}

/** Thermal zones (max 16), millidegree -> celsius; null when the thermal class dir is missing. */
export function readThermals(sysRoot: string = SYS_ROOT): { label: string; celsius: number }[] | null {
  const zones = listThermalZones(sysRoot)
  if (zones === null) return null
  const results: { label: string; celsius: number }[] = []
  for (const zone of zones.slice(0, 16)) {
    const milli = readNumberFile(path.join(sysRoot, 'class', 'thermal', zone, 'temp'))
    if (milli === null) continue
    const label = safeRead(path.join(sysRoot, 'class', 'thermal', zone, 'type'))?.trim() ?? zone
    results.push({ label, celsius: milli / 1000 })
  }
  return results
}

/** First battery under '/sys/class/power_supply' (capacity % + status string); null if none. */
export function readBattery(sysRoot: string = SYS_ROOT): { pct: number; status: string } | null {
  const batteries = listBatteryEntries(sysRoot)
  if (batteries === null || batteries.length === 0) return null
  const entry = batteries[0]
  const dir = path.join(sysRoot, 'class', 'power_supply', entry)
  const pct = readNumberFile(path.join(dir, 'capacity'))
  if (pct === null) return null
  const status = safeRead(path.join(dir, 'status'))?.trim() ?? 'Unknown'
  return { pct: Math.min(Math.max(pct, 0), 100), status }
}

// ---------------------------------------------------------------------------
// On-request process table scan (two samples + dwell; the ONLY async reader)
// ---------------------------------------------------------------------------

export type ProcessSample = { pid: number; name: string; cpuPct: number; rssBytes: number; state: string }

export type ProcessTableScan = { top: ProcessSample[]; zombies: number; dState: number; total: number }

/** jiffies delta over dwellMs -> cpu percent, clamped to [0, 100 * cores]. */
function computeCpuPct(deltaJiffies: number, dwellMs: number): number {
  if (!Number.isFinite(deltaJiffies) || !(dwellMs > 0)) return 0
  const cores = os.cpus().length || 1
  const pct = (deltaJiffies / USER_HZ / (dwellMs / 1000)) * 100
  return Math.min(Math.max(pct, 0), 100 * cores)
}

/**
 * Parse the darwin `ps -Aceo pid,pcpu,rss,stat,comm` output.
 * rss is KB -> bytes; zombies = STAT contains 'Z'; dState = STAT contains 'U' or 'D'.
 */
function parsePsOutput(text: string): ProcessTableScan {
  const rows: ProcessSample[] = []
  let zombies = 0
  let dState = 0
  let total = 0
  for (const line of splitLines(text)) {
    const match = line.match(/^\s*(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/)
    if (!match) continue // header / malformed line
    total++
    const stat = match[4]
    if (stat.includes('Z')) zombies++
    if (stat.includes('U') || stat.includes('D')) dState++
    rows.push({
      pid: Number(match[1]),
      name: match[5],
      cpuPct: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      state: stat,
    })
  }
  rows.sort((a, b) => b.cpuPct - a.cpuPct)
  return { top: rows.slice(0, TOP_PROCESS_COUNT), zombies, dState, total }
}

/**
 * pid (comm) state ... — comm may contain spaces AND parens, so fields are counted after the
 * LAST ')' (precedent: server/coding-cli/codex-child-registry.ts). After the close paren,
 * zero-indexed fields: [0] state, [11] utime, [12] stime.
 */
function parseProcPidStat(text: string): { name: string; state: string; busyJiffies: number } | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open === -1 || close === -1 || open > close) return null
  const fields = text.slice(close + 1).trim().split(/\s+/)
  if (fields.length < 13) return null
  const state = fields[0]
  const utime = Number(fields[11])
  const stime = Number(fields[12])
  if (!state || !Number.isFinite(utime) || !Number.isFinite(stime)) return null
  return { name: text.slice(open + 1, close), state, busyJiffies: utime + stime }
}

/** '/proc/<pid>/status' VmRSS in kB. Preferred over stat rss pages x 4096: page size is NOT
 *  4096 on every target (aarch64 16K/64K pages would silently inflate RSS 16x). */
function parseStatusVmRssKB(text: string): number | null {
  const match = text.match(/^VmRSS:\s+(\d+)\s*kB/m)
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

async function readTextFileBounded(filePath: string, maxBytes: number): Promise<string | null> {
  try {
    const handle = await fsp.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes)
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0)
      return buffer.toString('utf8', 0, bytesRead)
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const execFileAsync = promisify(execFile)

/** The ONLY subprocess of the entire feature: darwin's process table via ps (on-request only). */
async function scanDarwinProcessTable(): Promise<ProcessTableScan | null> {
  try {
    const { stdout } = await execFileAsync('ps', ['-Aceo', 'pid,pcpu,rss,stat,comm'], {
      timeout: PS_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    return parsePsOutput(stdout)
  } catch {
    return null
  }
}

async function scanLinuxProcessTable(
  procRoot: string,
  dwellMs: number,
  deadlineMs: number,
): Promise<ProcessTableScan | null> {
  const entries = safeReaddir(procRoot)
  if (entries === null) return null
  const pids: number[] = []
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    pids.push(Number(entry))
    if (pids.length >= PROC_SCAN_CAP) break
  }
  // total = numeric /proc entries discovered (enumeration truth), independent of per-pid
  // parse health; zombies/dState/top below can only use successfully parsed pids.
  const total = pids.length

  type SampleA = { name: string; state: string; busyJiffies: number }
  const sampleA = new Map<number, SampleA>()
  let zombies = 0
  let dState = 0
  for (const pid of pids) {
    if (Date.now() > deadlineMs) throw new DeadlineExceeded()
    const text = await readTextFileBounded(path.join(procRoot, String(pid), 'stat'), PROC_STAT_READ_MAX_BYTES)
    if (text === null) continue // truncated/vanished -> process skipped, never thrown
    const parsed = parseProcPidStat(text)
    if (parsed === null) continue
    sampleA.set(pid, parsed)
    if (parsed.state === 'Z') zombies++
    if (parsed.state === 'D') dState++
  }

  await sleep(dwellMs)

  const top: ProcessSample[] = []
  for (const [pid, before] of sampleA) {
    if (Date.now() > deadlineMs) throw new DeadlineExceeded()
    const statText = await readTextFileBounded(path.join(procRoot, String(pid), 'stat'), PROC_STAT_READ_MAX_BYTES)
    if (statText === null) continue
    const after = parseProcPidStat(statText)
    if (after === null) continue
    const statusText = await readTextFileBounded(path.join(procRoot, String(pid), 'status'), PROC_STAT_READ_MAX_BYTES)
    const rssKB = statusText === null ? null : parseStatusVmRssKB(statusText)
    top.push({
      pid,
      name: after.name,
      cpuPct: computeCpuPct(after.busyJiffies - before.busyJiffies, dwellMs),
      rssBytes: rssKB === null ? 0 : rssKB * 1024,
      state: after.state,
    })
  }
  top.sort((a, b) => b.cpuPct - a.cpuPct)
  return { top: top.slice(0, TOP_PROCESS_COUNT), zombies, dState, total }
}

/**
 * On-request process table scan. Linux/WSL: enumerate numeric /proc dirs (cap 100k), sample
 * utime+stime (A), dwell, sample again (B), cpuPct from the jiffy delta. darwin (procRoot
 * null): the single allowed `ps` subprocess with a 2000ms hard timeout.
 *
 * deadlineMs is an ABSOLUTE epoch-ms budget from the caller (service section budget): checked
 * BEFORE each pid's unit of work; on expiry this throws DeadlineExceeded (the readers' only
 * sanctioned throw). All other failures return null.
 */
export async function scanProcessTable(
  procRoot: string | null,
  dwellMs: number,
  deadlineMs: number,
): Promise<ProcessTableScan | null> {
  try {
    if (procRoot === null) return await scanDarwinProcessTable()
    return await scanLinuxProcessTable(procRoot, dwellMs, deadlineMs)
  } catch (err) {
    if (err instanceof DeadlineExceeded) throw err
    return null
  }
}

/** Test-only seam for pure helpers (keeps readers' public surface minimal). */
export const __testInternals: {
  computeCpuPct: (deltaJiffies: number, dwellMs: number) => number
  parsePsOutput: (text: string) => ProcessTableScan
  isWholeDevice: (name: string) => boolean
} = { computeCpuPct, parsePsOutput, isWholeDevice }
