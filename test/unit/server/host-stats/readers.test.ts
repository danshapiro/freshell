/**
 * Behavioral tests for the host-stats /proc + /sys reader layer
 * (docs/plans/2026-08-25-host-pressure-pane.md, Task 2 contract lines 323–410).
 *
 * All assertions are exact-value against the committed fixture tree under
 * test/fixtures/host-stats/. Rate computation (deltas over ticks) is the
 * service's job — readers return cumulative counters verbatim, so no
 * rate/delta assertions live here.
 *
 * Plan-mandated exceptions to committed fixtures (git cannot commit empty
 * dirs or dangling symlinks):
 *  - self/fd readlink fixtures are REAL symlinks created in os.tmpdir() at
 *    setup (fs.symlinkSync('anon_inode:inotify', ...)), never committed.
 *  - the "cgroup-absent empty dir" is created in os.tmpdir() at setup.
 *  - small cgroup variant trees (v2 finite limit, v2 pids 'max' fallback,
 *    v1 controllers, pid_max-only) are written into os.tmpdir() at setup,
 *    keeping the committed tree exactly as the plan enumerates.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DeadlineExceeded,
  __testInternals,
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
} from '../../../../server/host-stats/readers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(__dirname, '../../../fixtures/host-stats')
const PROC = path.join(FIXTURES, 'proc')
const PROMINI = path.join(FIXTURES, 'procmini')
const SYS = path.join(FIXTURES, 'sys')
const CGROUP = path.join(SYS, 'fs', 'cgroup')

// ---------------------------------------------------------------------------
// tmpdir fixture variants (built in beforeAll; see header comment)
// ---------------------------------------------------------------------------

let tmp: string
let missing: string
let fdProc: string
let scanProc: string
let emptyCgroupRoot: string
let v2LimitedProc: string
let v2LimitedCgroup: string
let v1Proc: string
let v1Cgroup: string
let pidMaxOnlyProc: string
let tcpOnlyProc: string
let noOomProc: string

function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content)
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-stats-readers-'))
  missing = path.join(tmp, 'never-existed')

  // fd readlink fixtures: real symlinks (never committed) + copies of the
  // committed fdinfo files, so <procRoot>/self/fd and <procRoot>/self/fdinfo
  // resolve under one tmp proc root.
  fdProc = path.join(tmp, 'fd-proc')
  fs.mkdirSync(path.join(fdProc, 'self', 'fd'), { recursive: true })
  fs.mkdirSync(path.join(fdProc, 'self', 'fdinfo'), { recursive: true })
  for (const fd of [3, 4, 5]) {
    fs.symlinkSync('anon_inode:inotify', path.join(fdProc, 'self', 'fd', String(fd)))
    fs.copyFileSync(
      path.join(PROC, 'self', 'fdinfo', String(fd)),
      path.join(fdProc, 'self', 'fdinfo', String(fd)),
    )
  }
  fs.symlinkSync('socket:[12345]', path.join(fdProc, 'self', 'fd', '6'))
  fs.symlinkSync('pipe:[67890]', path.join(fdProc, 'self', 'fd', '7'))
  fs.symlinkSync('/dev/null', path.join(fdProc, 'self', 'fd', '8'))

  // cgroup-absent empty dir: proving "exists but has no cgroup data" -> null.
  emptyCgroupRoot = path.join(tmp, 'empty-cgroup-root')
  fs.mkdirSync(emptyCgroupRoot, { recursive: true })

  // process-scan tree: committed procmini + one pid whose stat is truncated
  // (no closing paren) — must be skipped, never thrown.
  scanProc = path.join(tmp, 'scan-proc')
  fs.cpSync(PROMINI, scanProc, { recursive: true })
  writeFile(scanProc, '999/stat', '999 (broken')
  writeFile(scanProc, '999/status', 'Name:\tbroken\nVmRSS:\t       1234 kB\n')

  // cgroup v2 with a FINITE memory limit, and pids.max = 'max' (exercises the
  // unlimited -> threads-max fallback).
  v2LimitedProc = path.join(tmp, 'v2-limited', 'proc')
  v2LimitedCgroup = path.join(tmp, 'v2-limited', 'cgroup')
  writeFile(v2LimitedProc, 'self/cgroup', '0::/limited.slice/app.service\n')
  writeFile(v2LimitedProc, 'sys/kernel/threads-max', '999999\n')
  writeFile(v2LimitedCgroup, 'limited.slice/app.service/memory.current', '500000000\n')
  writeFile(v2LimitedCgroup, 'limited.slice/app.service/memory.max', '8000000000\n')
  writeFile(v2LimitedCgroup, 'limited.slice/app.service/pids.max', 'max\n')

  // cgroup v1 with memory + pids controllers; memory limit is the classic
  // "unlimited" garbage value (>= 2^60) which must be filtered to null.
  v1Proc = path.join(tmp, 'v1', 'proc')
  v1Cgroup = path.join(tmp, 'v1', 'cgroup')
  writeFile(
    v1Proc,
    'self/cgroup',
    '7:memory:/limited.slice/svc.service\n3:pids:/limited.slice/svc.service\n1:name=systemd:/limited.slice/svc.service\n',
  )
  writeFile(v1Proc, 'sys/kernel/threads-max', '888888\n')
  writeFile(v1Cgroup, 'memory/limited.slice/svc.service/memory.usage_in_bytes', '1000000\n')
  writeFile(v1Cgroup, 'memory/limited.slice/svc.service/memory.limit_in_bytes', '9223372036854771712\n')
  writeFile(v1Cgroup, 'pids/limited.slice/svc.service/pids.max', '777\n')

  // Only /proc/sys/kernel/pid_max exists: it is a PID-number wrap boundary,
  // NOT a creatable-process cap. readPidsLimit must never use it -> null.
  pidMaxOnlyProc = path.join(tmp, 'pid-max-only', 'proc')
  writeFile(pidMaxOnlyProc, 'sys/kernel/pid_max', '4194304\n')

  // tcp6 absent (IPv6 disabled hosts) — counts must come from tcp alone.
  tcpOnlyProc = path.join(tmp, 'tcp-only', 'proc')
  fs.mkdirSync(path.join(tcpOnlyProc, 'net'), { recursive: true })
  fs.copyFileSync(path.join(PROC, 'net', 'tcp'), path.join(tcpOnlyProc, 'net', 'tcp'))

  // vmstat without oom_kill (older kernels) -> oomKill null.
  noOomProc = path.join(tmp, 'no-oom', 'proc')
  writeFile(noOomProc, 'vmstat', 'pswpin 10\npswpout 20\npgmajfault 30\n')
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------

describe('readCpuTimes', () => {
  it('parses the aggregate line and all 16 per-core lines from proc/stat', () => {
    const times = readCpuTimes(PROC)
    expect(times).not.toBeNull()
    // aggregate: total = 4705+356+1622+164331+2020+80+345+777, busy = total - idle(164331) - iowait(2020)
    expect(times!.total).toBe(174236)
    expect(times!.busy).toBe(7885)
    expect(times!.steal).toBe(777) // steal>0 is a fixture requirement
    expect(times!.perCore).toHaveLength(16)
    expect(times!.perCore[0]).toEqual({ total: 10645, busy: 495 })
    expect(times!.perCore[15]).toEqual({ total: 9180, busy: 170 })
  })

  it('returns null when /proc/stat is missing', () => {
    expect(readCpuTimes(missing)).toBeNull()
  })
})

describe('readLoadavg', () => {
  it('parses load1/load5/load15', () => {
    expect(readLoadavg(PROC)).toEqual({ load1: 0.5, load5: 1, load15: 1.2 })
  })

  it('returns null when missing', () => {
    expect(readLoadavg(missing)).toBeNull()
  })
})

describe('readMeminfo', () => {
  it('parses total/available/swap from a 64GB + swap fixture', () => {
    expect(readMeminfo(PROC)).toEqual({
      totalKB: 67108864,
      availKB: 33554432,
      swapTotalKB: 8388608,
      swapFreeKB: 7340032,
    })
  })

  it('returns null when missing', () => {
    expect(readMeminfo(missing)).toBeNull()
  })
})

describe('readCgroupMemory', () => {
  it('resolves the v2 leaf from self/cgroup and reads memory.current/memory.max', () => {
    // committed leaf has memory.max = 'max' (the validated real-world case:
    // freshell itself runs in an unlimited cgroup) -> limitBytes null
    expect(readCgroupMemory(CGROUP, PROMINI)).toEqual({
      limitBytes: null,
      currentBytes: 17000000000,
    })
  })

  it('parses a finite v2 memory.max as the byte limit', () => {
    expect(readCgroupMemory(v2LimitedCgroup, v2LimitedProc)).toEqual({
      limitBytes: 8000000000,
      currentBytes: 500000000,
    })
  })

  it('reads v1 memory controller files and filters the >=2^60 garbage limit to null', () => {
    expect(readCgroupMemory(v1Cgroup, v1Proc)).toEqual({
      limitBytes: null,
      currentBytes: 1000000,
    })
  })

  it('returns null when self/cgroup is absent', () => {
    expect(readCgroupMemory(CGROUP, missing)).toBeNull()
    expect(readCgroupMemory(CGROUP, emptyCgroupRoot)).toBeNull()
  })

  it('returns null when the leaf files are absent (fs root has no limit files by design)', () => {
    // cgroupRoot exists but the leaf tree does not -> must NOT fall back to
    // reading the cgroup fs root.
    expect(readCgroupMemory(emptyCgroupRoot, PROMINI)).toBeNull()
  })
})

describe('readVmstat', () => {
  it('parses pswpin/pswpout/pgmajfault/oom_kill', () => {
    expect(readVmstat(PROC)).toEqual({ pswpin: 1234, pswpout: 5678, pgmajfault: 890, oomKill: 3 })
  })

  it('returns oomKill null when the oom_kill line is absent', () => {
    expect(readVmstat(noOomProc)).toEqual({ pswpin: 10, pswpout: 20, pgmajfault: 30, oomKill: null })
  })

  it('returns null when missing', () => {
    expect(readVmstat(missing)).toBeNull()
  })
})

describe('readPsi', () => {
  it('parses cpu/memory/io pressure some/full avg10 values', () => {
    expect(readPsi(PROC)).toEqual({
      cpuSome10: 1.23,
      memSome10: 0.5,
      memFull10: 0.3,
      ioSome10: 2.5,
      ioFull10: 1,
    })
  })

  it('returns null when the pressure directory is missing', () => {
    expect(readPsi(missing)).toBeNull()
  })
})

describe('readDiskStats', () => {
  it('keeps whole devices only and parses kernel iostats field positions', () => {
    const disks = readDiskStats(PROC)
    expect(disks).not.toBeNull()
    expect([...disks!.keys()].sort()).toEqual(['nvme0n1', 'sda'])
    expect(disks!.get('sda')).toEqual({
      readsCompleted: 5000,
      readMs: 6000,
      writesCompleted: 2000,
      writeMs: 3000,
      readSectors: 400000,
      writtenSectors: 200000,
      timeDoingIosMs: 4000,
    })
    expect(disks!.get('nvme0n1')).toEqual({
      readsCompleted: 9000,
      readMs: 8000,
      writesCompleted: 3000,
      writeMs: 4000,
      readSectors: 700000,
      writtenSectors: 300000,
      timeDoingIosMs: 5000,
    })
    // partitions and loop devices are filtered out
    expect(disks!.has('sda1')).toBe(false)
    expect(disks!.has('nvme0n1p1')).toBe(false)
    expect(disks!.has('loop0')).toBe(false)
  })

  it('returns null when missing', () => {
    expect(readDiskStats(missing)).toBeNull()
  })

  it('isWholeDevice classifies device names', () => {
    const { isWholeDevice } = __testInternals
    expect(isWholeDevice('sda')).toBe(true)
    expect(isWholeDevice('sda1')).toBe(false)
    expect(isWholeDevice('sdb')).toBe(true)
    expect(isWholeDevice('vda2')).toBe(false)
    expect(isWholeDevice('nvme0n1')).toBe(true)
    expect(isWholeDevice('nvme0n1p1')).toBe(false)
    expect(isWholeDevice('mmcblk0')).toBe(true)
    expect(isWholeDevice('mmcblk0p1')).toBe(false)
    expect(isWholeDevice('loop0')).toBe(false)
    expect(isWholeDevice('ram0')).toBe(false)
  })
})

describe('readNetDev', () => {
  it('sums rx/tx counters across non-loopback interfaces', () => {
    // fixture: lo (excluded) + eth0 + docker0
    expect(readNetDev(PROC)).toEqual({
      rxBytes: 7000000, // 5000000 + 2000000
      txBytes: 11000000, // 8000000 + 3000000
      rxErr: 9, // 7 + 2
      txErr: 16, // 11 + 5
      rxDrop: 4, // 3 + 1
      txDrop: 6, // 4 + 2
    })
  })

  it('returns null when missing', () => {
    expect(readNetDev(missing)).toBeNull()
  })
})

describe('readTcpStateCounts', () => {
  it('counts TIME_WAIT (state 06) across tcp + tcp6: exactly 3 in the fixture', () => {
    expect(readTcpStateCounts(PROC)).toEqual({ timeWait: 3 })
  })

  it('tolerates a missing tcp6 (IPv6 disabled)', () => {
    expect(readTcpStateCounts(tcpOnlyProc)).toEqual({ timeWait: 2 })
  })

  it('returns null when both tcp tables are missing', () => {
    expect(readTcpStateCounts(missing)).toBeNull()
  })
})

describe('readEphemeralPortRange', () => {
  it('parses ip_local_port_range', () => {
    expect(readEphemeralPortRange(PROC)).toEqual({ start: 32768, end: 60999 })
  })

  it('returns null when missing', () => {
    expect(readEphemeralPortRange(missing)).toBeNull()
  })
})

describe('readSelfFdCount', () => {
  it('counts entries in self/fd (6 fixture fds)', () => {
    expect(readSelfFdCount(fdProc)).toBe(6)
  })

  it('returns null when missing', () => {
    expect(readSelfFdCount(missing)).toBeNull()
  })
})

describe('readPidCount', () => {
  it('counts numeric /proc entries (7 fixture pids; self/ is not numeric)', () => {
    expect(readPidCount(PROMINI)).toBe(7)
  })

  it('returns null when missing', () => {
    expect(readPidCount(missing)).toBeNull()
  })
})

describe('readPidsLimit', () => {
  it('returns the cgroup v2 leaf pids.max when finite', () => {
    // procmini/self/cgroup -> committed leaf with pids.max 10854
    expect(readPidsLimit(PROMINI, CGROUP)).toBe(10854)
  })

  it('falls back to threads-max when the v2 leaf pids.max is "max"', () => {
    expect(readPidsLimit(v2LimitedProc, v2LimitedCgroup)).toBe(999999)
  })

  it('reads cgroup v1 pids controller pids.max', () => {
    expect(readPidsLimit(v1Proc, v1Cgroup)).toBe(777)
  })

  it('falls back to /proc/sys/kernel/threads-max when no cgroup data exists', () => {
    // committed proc/ fixture has no self/cgroup but does have threads-max
    expect(readPidsLimit(PROC, CGROUP)).toBe(123456)
  })

  it('never uses /proc/sys/kernel/pid_max (wrap boundary, not a process cap)', () => {
    expect(readPidsLimit(pidMaxOnlyProc, CGROUP)).toBeNull()
  })
})

describe('readSelfLimitsFdsMax', () => {
  it('returns the SOFT Max open files limit (soft 1024, hard 1048576)', () => {
    expect(readSelfLimitsFdsMax(PROC)).toBe(1024)
  })

  it('returns null when missing', () => {
    expect(readSelfLimitsFdsMax(missing)).toBeNull()
  })
})

describe('readSelfInotifyStats', () => {
  it('counts inotify instances via fd readlinks and watches via fdinfo lines', () => {
    // fd 3/4/5 are anon_inode:inotify symlinks (tmpdir real symlinks); their
    // fdinfo fixtures carry 2/3/1 inotify watch lines respectively.
    expect(readSelfInotifyStats(fdProc)).toEqual({ instances: 3, watches: 6 })
  })

  it('returns null when self/fd is missing', () => {
    expect(readSelfInotifyStats(missing)).toBeNull()
  })
})

describe('readInotifyLimits', () => {
  it('parses max_user_watches and max_user_instances', () => {
    expect(readInotifyLimits(PROC)).toEqual({ maxUserWatches: 1048576, maxUserInstances: 128 })
  })

  it('returns null when both limit files are missing', () => {
    expect(readInotifyLimits(missing)).toBeNull()
  })
})

describe('readCpuFreqMHz', () => {
  it('returns the mean scaling_cur_freq across cpus (kHz -> MHz)', () => {
    // fixture: cpu0 3400 MHz, cpu1 2800 MHz
    expect(readCpuFreqMHz(SYS)).toBe(3100)
  })

  it('returns null when no cpufreq data exists', () => {
    expect(readCpuFreqMHz(missing)).toBeNull()
  })
})

describe('readThermals', () => {
  it('parses thermal zones (millidegree -> celsius, type as label)', () => {
    expect(readThermals(SYS)).toEqual([{ label: 'x86_pkg_temp', celsius: 51.5 }])
  })

  it('returns null when the thermal class dir is missing', () => {
    expect(readThermals(missing)).toBeNull()
  })
})

describe('readBattery', () => {
  it('parses capacity and status from the first BAT* power_supply', () => {
    expect(readBattery(SYS)).toEqual({ pct: 87, status: 'Discharging' })
  })

  it('returns null when no battery exists', () => {
    expect(readBattery(missing)).toBeNull()
  })
})

describe('readMachineInfo', () => {
  it('probes capabilities from injected roots (v2 cgroup, no psi dir in procmini)', () => {
    const info = readMachineInfo(PROMINI, SYS)
    expect(info.platform).toBe(process.platform)
    expect(info.cores).toBe(os.cpus().length)
    expect(info.memTotalBytes).toBe(os.totalmem())
    expect(info.cgroup).toBe('v2')
    expect(info.psi).toBe(false) // procmini has no pressure/ dir
    expect(info.thermalCount).toBe(1)
    expect(info.batteryPresent).toBe(true)
    expect(info.gpu).toBe('none')
    expect(typeof info.kernel).toBe('string')
    expect(info.kernel).toBe(os.release())
    expect(typeof info.hostname).toBe('string')
    expect(info.wsl).toBe(/microsoft|wsl/i.test(os.release()))
  })

  it('reports psi readable and cgroup none for the full proc fixture (no self/cgroup)', () => {
    const info = readMachineInfo(PROC, SYS)
    expect(info.psi).toBe(true)
    expect(info.cgroup).toBe('none')
  })
})

describe('statfsInfo', () => {
  it('returns sane totals/free/usedPct for a real mount', () => {
    const info = statfsInfo('/')
    expect(info).not.toBeNull()
    expect(info!.totalBytes).toBeGreaterThan(0)
    expect(info!.freeBytes).toBeGreaterThanOrEqual(0)
    expect(info!.freeBytes).toBeLessThanOrEqual(info!.totalBytes)
    expect(info!.usedPct).toBeGreaterThanOrEqual(0)
    expect(info!.usedPct).toBeLessThanOrEqual(100)
    if (info!.inodesTotal !== null) {
      expect(info!.inodesTotal).toBeGreaterThan(0)
      expect(info!.inodesFree).toBeGreaterThanOrEqual(0)
    }
  })

  it('returns null for a nonexistent mount', () => {
    expect(statfsInfo(missing)).toBeNull()
  })
})

// ---------------------------------------------------------------------------

describe('scanProcessTable (linux /proc path)', () => {
  it('scans the fixture table: totals, zombies, D-state, names, VmRSS', async () => {
    const result = await scanProcessTable(scanProc, 50, Date.now() + 10_000)
    expect(result).not.toBeNull()
    // 8 numeric entries enumerated (7 committed + truncated 999)
    expect(result!.total).toBe(8)
    expect(result!.zombies).toBe(1)
    expect(result!.dState).toBe(1)
    // truncated-stat pid 999 is skipped, not fatal
    expect(result!.top).toHaveLength(7)
    const byPid = new Map(result!.top.map((p) => [p.pid, p]))
    expect(byPid.has(999)).toBe(false)
    // comm-with-parens splits after the LAST ')'
    expect(byPid.get(404)?.name).toBe('my (weird) proc')
    expect(byPid.get(404)?.state).toBe('D')
    expect(byPid.get(505)?.state).toBe('Z')
    // rssBytes comes from status VmRSS kB -> bytes, NOT stat rss pages
    expect(byPid.get(101)?.rssBytes).toBe(12345 * 1024)
    // static fixture: sample A == sample B -> zero deltas
    for (const row of result!.top) {
      expect(row.cpuPct).toBe(0)
    }
  })

  it('throws DeadlineExceeded when the budget is already expired', async () => {
    await expect(scanProcessTable(scanProc, 0, Date.now() - 1)).rejects.toThrow(DeadlineExceeded)
  })

  it('returns null when the proc root is missing', async () => {
    await expect(scanProcessTable(missing, 0, Date.now() + 10_000)).resolves.toBeNull()
  })
})

describe('__testInternals.computeCpuPct', () => {
  it('converts jiffy deltas over a dwell to percent (USER_HZ=100)', () => {
    // 30 jiffies over 300ms dwell: 30/100 Hz / 0.3s = 1 cpu-second per second
    // = one fully busy core = 100% (the dwell window holds 30 jiffies per core).
    expect(__testInternals.computeCpuPct(30, 300)).toBe(100)
    expect(__testInternals.computeCpuPct(15, 300)).toBe(50)
  })

  it('clamps to [0, 100 * cores]', () => {
    const cores = os.cpus().length
    expect(__testInternals.computeCpuPct(1e12, 1)).toBe(100 * cores)
    expect(__testInternals.computeCpuPct(-5, 300)).toBe(0)
  })

  it('returns 0 for a non-positive dwell instead of NaN/Infinity', () => {
    expect(__testInternals.computeCpuPct(50, 0)).toBe(0)
  })
})

describe('__testInternals.parsePsOutput (darwin path)', () => {
  // Representative `ps -Aceo pid,pcpu,rss,stat,comm` output: 15 processes,
  // one zombie (STAT contains Z), one uninterruptible wait (contains U),
  // a comm with spaces, and >12 rows to prove the top-12 cap.
  const PS_OUTPUT = `  PID %CPU     RSS STAT   COMM
    1 45.0   100000 Ss     /sbin/launchd
  201 42.0  2000000 S      /Applications/Safari.app/Contents/MacOS/Safari
  202 39.0    50000 Z      <defunct helper>
  203 36.0    60000 UE     /usr/sbin/coredaud
  204 33.0    70000 Ss     /usr/libexec/logd
  205 30.0    80000 Ss     /usr/sbin/syslogd
  206 27.0    90000 Ss     /usr/libexec/dasd
  207 24.0   100000 Ss     /usr/sbin/notifyd
  208 21.0   110000 Ss     /usr/sbin/distnoted
  209 18.0   120000 Ss     /usr/libexec/runningboardd
  210 15.0   130000 Ss     /usr/libexec/loginwindow
  211 12.0   140000 Ss     /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
  212  9.0   150000 Ss     /usr/libexec/dockd
  213  6.0   160000 Ss     /usr/sbin/coreaudiod
  214  3.0   170000 Ss     /usr/libexec/systemstatsd`

  it('parses rows, counts health states, caps top at 12 by pcpu desc', () => {
    const parsed = __testInternals.parsePsOutput(PS_OUTPUT)
    expect(parsed.total).toBe(15)
    expect(parsed.zombies).toBe(1)
    expect(parsed.dState).toBe(1)
    expect(parsed.top).toHaveLength(12)
    expect(parsed.top[0]).toEqual({
      pid: 1,
      name: '/sbin/launchd',
      cpuPct: 45,
      rssBytes: 100000 * 1024,
      state: 'Ss',
    })
    expect(parsed.top[11].pid).toBe(211)
    expect(parsed.top[11].cpuPct).toBe(12)
    const safari = parsed.top.find((p) => p.pid === 201)
    expect(safari?.name).toBe('/Applications/Safari.app/Contents/MacOS/Safari')
    expect(safari?.rssBytes).toBe(2000000 * 1024)
    const defunct = parsed.top.find((p) => p.pid === 202)
    expect(defunct?.name).toBe('<defunct helper>')
    expect(defunct?.state).toBe('Z')
  })

  it('returns an empty result for empty output', () => {
    const parsed = __testInternals.parsePsOutput('')
    expect(parsed).toEqual({ top: [], zombies: 0, dState: 0, total: 0 })
  })
})
