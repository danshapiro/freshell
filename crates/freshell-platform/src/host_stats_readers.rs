//! Host-stats `/proc` + `/sys` reader layer — the Rust port of
//! `server/host-stats/readers.ts` (plan: `docs/plans/2026-08-25-host-pressure-pane.md`,
//! Task 9 contract lines 874–933; reader semantics frozen by Task 2).
//!
//! Pure, path-injected, synchronous readers mirroring the Node layer one for
//! one: every reader NEVER panics on a read/parse failure — it returns `None`
//! instead. The ONLY async piece of the Node layer (`scanProcessTable`'s
//! two-sample dwell) is not here: this crate is deliberately tokio-free (see
//! `lib.rs`), so the dwell + deadline loop lives in `freshell-server`'s
//! concrete collector (`host_stats.rs`); the pure pieces it needs
//! ([`parse_proc_pid_stat`], [`parse_status_vm_rss_kb`], [`list_numeric_pids`],
//! [`read_pid_file_bounded`], [`compute_cpu_pct`]) are exported here.
//!
//! Platform notes: `/proc` readers are Linux-only — on darwin/Windows the
//! files do not exist and the readers return `None`; the caller (the
//! collector) then degrades the section to its zero-shape
//! (`available: false`). Unlike Node there is NO darwin `ps` subprocess path
//! (frozen Task 9 note: the Rust collector on darwin reports
//! `cpu.available:false`; `/proc`-dependent sections are zero-shaped).
//!
//! Known intentional divergence from `readers.ts`: Node's
//! `readNumberFile`/`parseCgroupLimit` lean on `Number('') === 0`, so an
//! EMPTY limit file reads as 0 there; here an unparsable payload is `None`
//! (degraded). Kernel `/proc`+`/sys` files are never empty when present, so
//! the divergence is unreachable on a real host.

use std::collections::BTreeMap;
use std::path::Path;

/// USER_HZ=100 is the documented ABI exposure of `/proc/<pid>/stat` tick
/// fields on every Linux architecture this project targets, so ticks ->
/// seconds is a plain /100 (Task 2 documented assumption; computed cpuPct is
/// also clamped defensively).
pub const USER_HZ: u64 = 100;

/// Cap on numeric `/proc` entries enumerated by [`list_numeric_pids`]
/// (mirrors Node's `PROC_SCAN_CAP`).
pub const PROC_SCAN_CAP: usize = 100_000;
/// Cap on [`read_self_fd_count`] (mirrors Node's `FD_COUNT_CAP`).
pub const FD_COUNT_CAP: u64 = 1_048_576;
/// Cap on [`read_pid_count`] (mirrors Node's `PID_COUNT_CAP`).
pub const PID_COUNT_CAP: u64 = 10_000_000;
/// Bounded scan cap for the inotify fd sweep (mirrors Node's
/// `INOTIFY_FD_SCAN_CAP`).
pub const INOTIFY_FD_SCAN_CAP: usize = 4096;
/// cgroup v1 reports "unlimited" as a huge sentinel (varies by kernel);
/// >= 2^60 is garbage.
pub const CGROUP_V1_GARBAGE_LIMIT: u64 = 1 << 60;
/// Bounded `/proc/<pid>` file read (mirrors Node's
/// `PROC_STAT_READ_MAX_BYTES`).
pub const PROC_PID_FILE_MAX_BYTES: usize = 4096;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Read a whole file as utf8 (lossy); `None` on any failure.
fn safe_read(file_path: &Path) -> Option<String> {
    std::fs::read_to_string(file_path).ok()
}

/// Non-empty, right-trimmed lines of a text file's contents.
fn non_empty_lines(text: &str) -> impl Iterator<Item = &str> {
    text.lines().filter(|line| !line.trim().is_empty())
}

/// Parse a file whose entire payload is a single number (e.g. threads-max).
fn read_number_file(file_path: &Path) -> Option<u64> {
    safe_read(file_path)?.trim().parse::<u64>().ok()
}

/// List a directory's entry NAMES; `None` instead of throwing.
fn safe_read_dir(dir_path: &Path) -> Option<Vec<String>> {
    let rd = std::fs::read_dir(dir_path).ok()?;
    Some(
        rd.filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect(),
    )
}

/// Resolve THIS process's cgroup leaf from `<proc_root>/self/cgroup`. The
/// cgroup fs root has NO limit files by design, so callers must always
/// resolve the leaf and never read the fs root.
enum CgroupLeaf {
    V1(String),
    V2(String),
}

fn resolve_cgroup_leaf(proc_root: &Path, v1_controller: &str) -> Option<CgroupLeaf> {
    let text = safe_read(&proc_root.join("self").join("cgroup"))?;
    let lines: Vec<&str> = non_empty_lines(&text).collect();
    // v2 unified hierarchy: a single "0::/path" line.
    for line in &lines {
        if let Some(rest) = line.strip_prefix("0::") {
            let leaf = rest.trim_start_matches('/');
            if leaf.is_empty() {
                // process sits at the cgroup2 root: no limit files there
                return None;
            }
            return Some(CgroupLeaf::V2(leaf.to_string()));
        }
    }
    // v1: "<hierarchy>:<controller[,controller...]>:/path"
    for line in lines {
        let parts: Vec<&str> = line.split(':').collect();
        if parts.len() != 3 {
            continue;
        }
        if !parts[1].split(',').any(|c| c == v1_controller) {
            continue;
        }
        let leaf = parts[2].trim_start_matches('/');
        if leaf.is_empty() {
            return None;
        }
        return Some(CgroupLeaf::V1(leaf.to_string()));
    }
    None
}

/// 'max' / unreadable / non-finite cgroup limit -> `None` (unlimited).
fn parse_cgroup_limit(text: &str) -> Option<u64> {
    let trimmed = text.trim();
    if trimmed == "max" || trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<u64>().ok()
}

// ---------------------------------------------------------------------------
// CPU / load / memory
// ---------------------------------------------------------------------------

/// One `cpuN` line's cumulative counters (jiffies).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CpuCoreTimes {
    pub total: f64,
    pub busy: f64,
}

/// `/proc/stat` aggregated + per-core totals; steal jiffies (Node
/// `readCpuTimes`).
#[derive(Debug, Clone, PartialEq)]
pub struct CpuTimes {
    pub total: f64,
    pub busy: f64,
    pub steal: f64,
    pub per_core: Vec<CpuCoreTimes>,
}

fn parse_proc_stat_cpu_fields(fields: &[f64]) -> Option<(f64, f64, f64)> {
    // user nice system idle iowait irq softirq steal [guest guest_nice]
    if fields.len() < 8 || fields.iter().any(|f| !f.is_finite()) {
        return None;
    }
    let total: f64 = fields.iter().sum();
    let busy = total - fields[3] - fields[4]; // idle + iowait
    Some((total, busy, fields[7]))
}

/// `/proc/stat` aggregated + per-core totals; steal jiffies.
pub fn read_cpu_times(proc_root: &Path) -> Option<CpuTimes> {
    let text = safe_read(&proc_root.join("stat"))?;
    let mut aggregate: Option<(f64, f64, f64)> = None;
    let mut per_core: Vec<CpuCoreTimes> = Vec::new();
    for line in non_empty_lines(&text) {
        // /^cpu(\d*)\s+(.*)$/
        let Some(after_cpu) = line.strip_prefix("cpu") else {
            continue;
        };
        let Some(idx_end) = after_cpu.find(char::is_whitespace) else {
            continue;
        };
        let idx_str = &after_cpu[..idx_end];
        if !idx_str.is_empty() && !idx_str.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let fields: Vec<f64> = after_cpu[idx_end..]
            .split_whitespace()
            .map(|tok| tok.parse::<f64>().unwrap_or(f64::NAN))
            .collect();
        let Some((total, busy, steal)) = parse_proc_stat_cpu_fields(&fields) else {
            continue;
        };
        if idx_str.is_empty() {
            aggregate = Some((total, busy, steal));
        } else {
            let idx: usize = idx_str.parse().ok()?;
            if per_core.len() <= idx {
                per_core.resize(
                    idx + 1,
                    CpuCoreTimes {
                        total: 0.0,
                        busy: 0.0,
                    },
                );
            }
            per_core[idx] = CpuCoreTimes { total, busy };
        }
    }
    let (total, busy, steal) = aggregate?;
    Some(CpuTimes {
        total,
        busy,
        steal,
        per_core,
    })
}

/// `/proc/loadavg` (Node `readLoadavg`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LoadAvg {
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
}

/// `/proc/loadavg`. On darwin the file does not exist -> `None`.
pub fn read_loadavg(proc_root: &Path) -> Option<LoadAvg> {
    let text = safe_read(&proc_root.join("loadavg"))?;
    let fields: Vec<f64> = text
        .split_whitespace()
        .map(|tok| tok.parse::<f64>().unwrap_or(f64::NAN))
        .collect();
    if fields.len() < 3 || fields[..3].iter().any(|f| !f.is_finite()) {
        return None;
    }
    Some(LoadAvg {
        load1: fields[0],
        load5: fields[1],
        load15: fields[2],
    })
}

/// `/proc/meminfo` kB values (Node `readMeminfo`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MeminfoKb {
    pub total_kb: u64,
    pub avail_kb: u64,
    pub swap_total_kb: u64,
    pub swap_free_kb: u64,
}

/// `/proc/meminfo`. Returns `None` when the file is absent or the two
/// mandatory keys (`MemTotal`/`MemAvailable`) are missing.
pub fn read_meminfo(proc_root: &Path) -> Option<MeminfoKb> {
    let text = safe_read(&proc_root.join("meminfo"))?;
    let mut values: BTreeMap<String, u64> = BTreeMap::new();
    for line in non_empty_lines(&text) {
        // /^([^:]+):\s+(\d+)/
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let Some(value_tok) = rest.split_whitespace().next() else {
            continue;
        };
        if let Ok(value) = value_tok.parse::<u64>() {
            values.insert(key.to_string(), value);
        }
    }
    Some(MeminfoKb {
        total_kb: *values.get("MemTotal")?,
        avail_kb: *values.get("MemAvailable")?,
        swap_total_kb: values.get("SwapTotal").copied().unwrap_or(0),
        swap_free_kb: values.get("SwapFree").copied().unwrap_or(0),
    })
}

/// This process's cgroup memory view (Node `readCgroupMemory`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CgroupMemory {
    /// `None` = unlimited ('max' / v1 garbage sentinel / unreadable).
    pub limit_bytes: Option<u64>,
    pub current_bytes: u64,
}

/// Resolves THIS process's cgroup leaf from `<proc_root>/self/cgroup` and
/// reads its memory files. v2: `0::/path` -> `<cgroup_root>/path/
/// memory.current` + `memory.max` ('max' -> `None` limit). v1: `memory`
/// controller line -> `<cgroup_root>/memory/path/usage_in_bytes` +
/// `limit_in_bytes` (garbage limit >= 2^60 -> `None`). The cgroup fs root has
/// NO limit files by design, so the leaf is always resolved; the fs root is
/// never read.
///
/// NOTE (frozen contract): parameter order here is (cgroup_root, proc_root)
/// — the opposite of [`read_pids_limit`]. Callers: read the signatures, do
/// not assume.
pub fn read_cgroup_memory(cgroup_root: &Path, proc_root: &Path) -> Option<CgroupMemory> {
    let leaf = resolve_cgroup_leaf(proc_root, "memory")?;
    match leaf {
        CgroupLeaf::V2(leaf) => {
            let dir = cgroup_root.join(leaf);
            let current_bytes = read_number_file(&dir.join("memory.current"))?;
            let limit_bytes = safe_read(&dir.join("memory.max"))
                .as_deref()
                .and_then(parse_cgroup_limit);
            Some(CgroupMemory {
                limit_bytes,
                current_bytes,
            })
        }
        CgroupLeaf::V1(leaf) => {
            let dir = cgroup_root.join("memory").join(leaf);
            let current_bytes = read_number_file(&dir.join("memory.usage_in_bytes"))?;
            let raw = read_number_file(&dir.join("memory.limit_in_bytes"));
            // v1 "unlimited" is a huge sentinel value (>= 2^60 depending on
            // kernel) -> None
            let limit_bytes = raw.filter(|v| *v < CGROUP_V1_GARBAGE_LIMIT);
            Some(CgroupMemory {
                limit_bytes,
                current_bytes,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Paging / PSI
// ---------------------------------------------------------------------------

/// `/proc/vmstat` paging counters (Node `readVmstat`). `oom_kill` is `None`
/// when the kernel omits the `oom_kill` line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Vmstat {
    pub pswpin: u64,
    pub pswpout: u64,
    pub pgmajfault: u64,
    pub oom_kill: Option<u64>,
}

/// `/proc/vmstat` paging counters.
pub fn read_vmstat(proc_root: &Path) -> Option<Vmstat> {
    let text = safe_read(&proc_root.join("vmstat"))?;
    let mut values: BTreeMap<String, u64> = BTreeMap::new();
    for line in non_empty_lines(&text) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() == 2 {
            if let Ok(value) = parts[1].parse::<u64>() {
                values.insert(parts[0].to_string(), value);
            }
        }
    }
    Some(Vmstat {
        pswpin: *values.get("pswpin")?,
        pswpout: *values.get("pswpout")?,
        pgmajfault: *values.get("pgmajfault")?,
        oom_kill: values.get("oom_kill").copied(),
    })
}

/// `/proc/pressure/{cpu,memory,io}` avg10 values (Node `readPsi`); `None`
/// per-file when unreadable, `None` overall when the PSI directory is missing
/// entirely.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PsiSnapshot {
    pub cpu_some10: Option<f64>,
    pub mem_some10: Option<f64>,
    pub mem_full10: Option<f64>,
    pub io_some10: Option<f64>,
    pub io_full10: Option<f64>,
}

/// `/proc/pressure/{cpu,memory,io}` avg10 values.
pub fn read_psi(proc_root: &Path) -> Option<PsiSnapshot> {
    let pressure_dir = proc_root.join("pressure");
    let cpu = safe_read(&pressure_dir.join("cpu"));
    let memory = safe_read(&pressure_dir.join("memory"));
    let io = safe_read(&pressure_dir.join("io"));
    if cpu.is_none() && memory.is_none() && io.is_none() {
        return None;
    }
    Some(PsiSnapshot {
        cpu_some10: cpu.as_deref().and_then(|t| parse_psi_avg10(t, "some")),
        mem_some10: memory.as_deref().and_then(|t| parse_psi_avg10(t, "some")),
        mem_full10: memory.as_deref().and_then(|t| parse_psi_avg10(t, "full")),
        io_some10: io.as_deref().and_then(|t| parse_psi_avg10(t, "some")),
        io_full10: io.as_deref().and_then(|t| parse_psi_avg10(t, "full")),
    })
}

fn parse_psi_avg10(text: &str, line_kind: &str) -> Option<f64> {
    // /^(some|full)\s+.*?\bavg10=([\d.]+)/
    for line in non_empty_lines(text) {
        let mut tokens = line.split_whitespace();
        if tokens.next() != Some(line_kind) {
            continue;
        }
        for token in tokens {
            if let Some(rest) = token.strip_prefix("avg10=") {
                if let Ok(value) = rest.parse::<f64>() {
                    return value.is_finite().then_some(value);
                }
                // Malformed avg10 on the matching line: Node's regex simply
                // fails this line and the search continues.
                break;
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Disk / network
// ---------------------------------------------------------------------------

/// One whole-device row of `/proc/diskstats` (Node `DiskCounters`). Field
/// mapping per the kernel iostats doc (1-indexed after the device name).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskCounters {
    pub reads_completed: u64,
    pub read_ms: u64,
    pub writes_completed: u64,
    pub write_ms: u64,
    pub read_sectors: u64,
    pub written_sectors: u64,
    pub time_doing_ios_ms: u64,
}

/// Whole-device name filter for `/proc/diskstats`: partitions (`sda1`,
/// `nvme0n1p1`, `mmcblk0p1`), loop and ram devices are excluded; everything
/// else (whole disks, `dm-*`, `drbd`, ...) is kept — fail-open so an
/// unrecognized whole device is still shown.
pub fn is_whole_device(name: &str) -> bool {
    // /^(?:loop|ram)\d+/ (prefix match)
    for prefix in ["loop", "ram"] {
        if let Some(rest) = name.strip_prefix(prefix) {
            if rest.chars().next().is_some_and(|c| c.is_ascii_digit()) {
                return false;
            }
        }
    }
    // /^nvme\d+n\d+p\d+$/
    if let Some(rest) = name.strip_prefix("nvme") {
        if let Some((bus, tail)) = rest.split_once('n') {
            if let Some((inst, part)) = tail.split_once('p') {
                if !bus.is_empty()
                    && bus.bytes().all(|b| b.is_ascii_digit())
                    && !inst.is_empty()
                    && inst.bytes().all(|b| b.is_ascii_digit())
                    && !part.is_empty()
                    && part.bytes().all(|b| b.is_ascii_digit())
                {
                    return false;
                }
            }
        }
    }
    // /^mmcblk\d+p\d+$/
    if let Some(rest) = name.strip_prefix("mmcblk") {
        if let Some((idx, part)) = rest.split_once('p') {
            if !idx.is_empty()
                && idx.bytes().all(|b| b.is_ascii_digit())
                && !part.is_empty()
                && part.bytes().all(|b| b.is_ascii_digit())
            {
                return false;
            }
        }
    }
    // /^(?:sd|vd|xvd|hd)[a-z]+\d+$/
    for prefix in ["sd", "vd", "xvd", "hd"] {
        if let Some(rest) = name.strip_prefix(prefix) {
            // Longest-first prefix order matters (vd before d-shadowing);
            // "xvd" must be tried before "vd" would also match after 'x' is
            // consumed — strip_prefix is anchored, so only exact prefixes fire.
            let letters: usize = rest.chars().take_while(|c| c.is_ascii_lowercase()).count();
            if letters == 0 {
                continue;
            }
            let (alpha, digits) = rest.split_at(letters);
            if !alpha.is_empty()
                && alpha.bytes().all(|b| b.is_ascii_lowercase())
                && !digits.is_empty()
                && digits.bytes().all(|b| b.is_ascii_digit())
            {
                return false;
            }
        }
    }
    true
}

/// `/proc/diskstats` keyed by whole-device name.
pub fn read_disk_stats(proc_root: &Path) -> Option<BTreeMap<String, DiskCounters>> {
    let text = safe_read(&proc_root.join("diskstats"))?;
    let mut devices = BTreeMap::new();
    for line in non_empty_lines(&text) {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 14 {
            continue;
        }
        let name = cols[2];
        if !is_whole_device(name) {
            continue;
        }
        // Node: `numbers.some((n) => !Number.isFinite(n))` skips the LINE,
        // never the file.
        let mut numbers: Vec<u64> = Vec::with_capacity(cols.len() - 3);
        let mut unparsable = false;
        for tok in &cols[3..] {
            match tok.parse::<u64>() {
                Ok(v) => numbers.push(v),
                Err(_) => {
                    unparsable = true;
                    break;
                }
            }
        }
        if unparsable {
            continue;
        }
        // doc field 1 = readsCompleted, 3 = readSectors, 4 = readMs,
        // 5 = writesCompleted, 7 = writtenSectors, 8 = writeMs,
        // 10 = timeDoingIosMs.
        devices.insert(
            name.to_string(),
            DiskCounters {
                reads_completed: numbers[0],
                read_ms: numbers[3],
                writes_completed: numbers[4],
                write_ms: numbers[7],
                read_sectors: numbers[2],
                written_sectors: numbers[6],
                time_doing_ios_ms: numbers[9],
            },
        );
    }
    Some(devices)
}

/// `/proc/net/dev` summed across interfaces, EXCLUDING loopback (`lo`)
/// (Node `readNetDev`; virtual interfaces are kept).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetDevTotals {
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_err: u64,
    pub tx_err: u64,
    pub rx_drop: u64,
    pub tx_drop: u64,
}

/// `/proc/net/dev` interface totals.
pub fn read_net_dev(proc_root: &Path) -> Option<NetDevTotals> {
    let text = safe_read(&proc_root.join("net").join("dev"))?;
    let mut totals = NetDevTotals {
        rx_bytes: 0,
        tx_bytes: 0,
        rx_err: 0,
        tx_err: 0,
        rx_drop: 0,
        tx_drop: 0,
    };
    for line in non_empty_lines(&text) {
        let Some(colon) = line.find(':') else {
            continue;
        };
        let name = line[..colon].trim();
        if name == "lo" {
            continue;
        }
        let numbers: Vec<u64> = line[colon + 1..]
            .split_whitespace()
            .map(|tok| tok.parse::<u64>().unwrap_or(u64::MAX))
            .collect();
        if numbers.len() < 16 || numbers.contains(&u64::MAX) {
            continue;
        }
        totals.rx_bytes += numbers[0];
        totals.rx_err += numbers[2];
        totals.rx_drop += numbers[3];
        totals.tx_bytes += numbers[8];
        totals.tx_err += numbers[10];
        totals.tx_drop += numbers[11];
    }
    Some(totals)
}

/// TIME_WAIT (state `06`) count across `tcp` + `tcp6` (Node
/// `readTcpStateCounts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TcpStateCounts {
    pub time_wait: u64,
}

/// TIME_WAIT connection count across `/proc/net/tcp` + `/proc/net/tcp6`.
pub fn read_tcp_state_counts(proc_root: &Path) -> Option<TcpStateCounts> {
    let tcp = safe_read(&proc_root.join("net").join("tcp"));
    let tcp6 = safe_read(&proc_root.join("net").join("tcp6"));
    if tcp.is_none() && tcp6.is_none() {
        return None;
    }
    let mut time_wait = 0u64;
    for text in [tcp, tcp6].into_iter().flatten() {
        for line in non_empty_lines(&text) {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if tokens.len() < 4 {
                continue;
            }
            // /^\d+:$/
            let Some(sl) = tokens[0].strip_suffix(':') else {
                continue;
            };
            if sl.is_empty() || !sl.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            if tokens[3] == "06" {
                time_wait += 1;
            }
        }
    }
    Some(TcpStateCounts { time_wait })
}

/// `/proc/sys/net/ipv4/ip_local_port_range` (Node `readEphemeralPortRange`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PortRange {
    pub start: u64,
    pub end: u64,
}

/// `/proc/sys/net/ipv4/ip_local_port_range`.
pub fn read_ephemeral_port_range(proc_root: &Path) -> Option<PortRange> {
    let text = safe_read(
        &proc_root
            .join("sys")
            .join("net")
            .join("ipv4")
            .join("ip_local_port_range"),
    )?;
    let fields: Vec<u64> = text
        .split_whitespace()
        .map(|tok| tok.parse::<u64>().unwrap_or(u64::MAX))
        .collect();
    if fields.len() < 2 || fields[..2].contains(&u64::MAX) {
        return None;
    }
    Some(PortRange {
        start: fields[0],
        end: fields[1],
    })
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/// Count of entries in `<proc_root>/self/fd`, capped at [`FD_COUNT_CAP`]
/// (Node `readSelfFdCount`).
pub fn read_self_fd_count(proc_root: &Path) -> Option<u64> {
    let entries = safe_read_dir(&proc_root.join("self").join("fd"))?;
    Some((entries.len() as u64).min(FD_COUNT_CAP))
}

/// Count of numeric `<proc_root>` entries (processes), capped at
/// [`PID_COUNT_CAP`] (Node `readPidCount`).
pub fn read_pid_count(proc_root: &Path) -> Option<u64> {
    let entries = safe_read_dir(proc_root)?;
    let mut count = 0u64;
    for entry in entries {
        if !entry.is_empty() && entry.bytes().all(|b| b.is_ascii_digit()) {
            count += 1;
        }
    }
    Some(count.min(PID_COUNT_CAP))
}

/// The BINDING process cap: cgroup v2 leaf `pids.max` ('max' -> unlimited ->
/// fall back), else cgroup v1 `pids.max`, else
/// `/proc/sys/kernel/threads-max`. `/proc/sys/kernel/pid_max` is a PID-number
/// wrap boundary, NOT a creatable-process cap, and is deliberately never used
/// (validated R3M2).
///
/// NOTE (frozen contract): parameter order here is (proc_root, cgroup_root)
/// — the opposite of [`read_cgroup_memory`]. Callers: read the signatures,
/// do not assume.
pub fn read_pids_limit(proc_root: &Path, cgroup_root: &Path) -> Option<u64> {
    if let Some(leaf) = resolve_cgroup_leaf(proc_root, "pids") {
        let dir = match &leaf {
            CgroupLeaf::V2(leaf) => cgroup_root.join(leaf),
            CgroupLeaf::V1(leaf) => cgroup_root.join("pids").join(leaf),
        };
        if let Some(text) = safe_read(&dir.join("pids.max")) {
            if let Some(limit) = parse_cgroup_limit(&text) {
                if limit > 0 {
                    return Some(limit);
                }
            }
            // 'max'/garbage: cgroup says unlimited -> the binding cap is the
            // host limit below
        }
    }
    read_number_file(&proc_root.join("sys").join("kernel").join("threads-max"))
}

/// `Max open files` SOFT limit from `/proc/self/limits` ('unlimited' ->
/// `None`) (Node `readSelfLimitsFdsMax`).
pub fn read_self_limits_fds_max(proc_root: &Path) -> Option<u64> {
    let text = safe_read(&proc_root.join("self").join("limits"))?;
    for line in non_empty_lines(&text) {
        // /^Max open files\s+(\S+)/
        let Some(rest) = line.strip_prefix("Max open files") else {
            continue;
        };
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let soft = rest.split_whitespace().next()?;
        return soft.parse::<u64>().ok();
    }
    None
}

/// This process's inotify usage (Node `readSelfInotifyStats`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InotifyUsage {
    pub instances: u64,
    pub watches: u64,
}

/// inotify usage of THIS process: bounded scan (cap
/// [`INOTIFY_FD_SCAN_CAP`] fds) of `/proc/self/fd` where the readlink target
/// starts with `anon_inode:inotify` counts instances;
/// `/proc/self/fdinfo/<fd>` lines starting with `inotify` count watches.
pub fn read_self_inotify_stats(proc_root: &Path) -> Option<InotifyUsage> {
    let fd_dir = proc_root.join("self").join("fd");
    let entries = safe_read_dir(&fd_dir)?;
    let mut instances = 0u64;
    let mut watches = 0u64;
    for fd in entries.iter().take(INOTIFY_FD_SCAN_CAP) {
        let Ok(target) = std::fs::read_link(fd_dir.join(fd)) else {
            continue; // fd vanished mid-scan
        };
        if !target.to_string_lossy().starts_with("anon_inode:inotify") {
            continue;
        }
        instances += 1;
        if let Some(fdinfo) = safe_read(&proc_root.join("self").join("fdinfo").join(fd)) {
            for line in non_empty_lines(&fdinfo) {
                if line.starts_with("inotify") {
                    watches += 1;
                }
            }
        }
    }
    Some(InotifyUsage { instances, watches })
}

/// `/proc/sys/fs/inotify/max_user_{watches,instances}` (Node
/// `readInotifyLimits`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InotifyLimits {
    pub max_user_watches: Option<u64>,
    pub max_user_instances: Option<u64>,
}

/// inotify sysctls; `None` when BOTH limit files are unreadable.
pub fn read_inotify_limits(proc_root: &Path) -> Option<InotifyLimits> {
    let base = proc_root.join("sys").join("fs").join("inotify");
    let max_user_watches = read_number_file(&base.join("max_user_watches"));
    let max_user_instances = read_number_file(&base.join("max_user_instances"));
    if max_user_watches.is_none() && max_user_instances.is_none() {
        return None;
    }
    Some(InotifyLimits {
        max_user_watches,
        max_user_instances,
    })
}

// ---------------------------------------------------------------------------
// Sysfs sensors / machine info
// ---------------------------------------------------------------------------

/// Mean of `/sys/devices/system/cpu/cpuN/cpufreq/scaling_cur_freq`
/// (kHz -> MHz) (Node `readCpuFreqMHz`).
pub fn read_cpu_freq_mhz(sys_root: &Path) -> Option<f64> {
    let cpu_dir = sys_root.join("devices").join("system").join("cpu");
    let entries = safe_read_dir(&cpu_dir)?;
    let mut freqs: Vec<f64> = Vec::new();
    for entry in entries {
        // /^cpu\d+$/
        let Some(rest) = entry.strip_prefix("cpu") else {
            continue;
        };
        if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if let Some(khz) = read_number_file(
            &cpu_dir
                .join(&entry)
                .join("cpufreq")
                .join("scaling_cur_freq"),
        ) {
            if khz > 0 {
                freqs.push(khz as f64);
            }
        }
    }
    if freqs.is_empty() {
        return None;
    }
    Some(freqs.iter().sum::<f64>() / freqs.len() as f64 / 1000.0)
}

fn probe_psi_readable(proc_root: &Path) -> bool {
    proc_root.join("pressure").is_dir()
}

fn probe_cgroup_version(proc_root: &Path) -> &'static str {
    let Some(text) = safe_read(&proc_root.join("self").join("cgroup")) else {
        return "none";
    };
    if text.trim().is_empty() {
        return "none";
    }
    if non_empty_lines(&text).any(|line| line.starts_with("0::")) {
        "v2"
    } else {
        "v1"
    }
}

fn list_thermal_zones(sys_root: &Path) -> Option<Vec<String>> {
    let entries = safe_read_dir(&sys_root.join("class").join("thermal"))?;
    let mut zones: Vec<(u64, String)> = entries
        .into_iter()
        .filter_map(|entry| {
            let rest = entry.strip_prefix("thermal_zone")?;
            if rest.is_empty() || !rest.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            Some((rest.parse::<u64>().ok()?, entry))
        })
        .collect();
    zones.sort_by_key(|(idx, _)| *idx);
    Some(zones.into_iter().map(|(_, name)| name).collect())
}

fn list_battery_entries(sys_root: &Path) -> Option<Vec<String>> {
    let power_supply = sys_root.join("class").join("power_supply");
    let entries = safe_read_dir(&power_supply)?;
    Some(
        entries
            .into_iter()
            .filter(|entry| {
                match safe_read(&power_supply.join(entry).join("type")) {
                    Some(kind) => kind.trim() == "Battery",
                    // No type file: fall back to the /^bat/i name heuristic
                    // (Node parity).
                    None => {
                        let lower = entry.to_ascii_lowercase();
                        lower.starts_with("bat")
                    }
                }
            })
            .collect(),
    )
}

/// Kernel release from the injected root; `None` when absent (there is no
/// `os.release()` fallback on this Rust path — the payload field is nullable
/// by contract).
fn read_kernel_release(proc_root: &Path) -> Option<String> {
    let release = safe_read(&proc_root.join("sys").join("kernel").join("osrelease"))?;
    let release = release.trim();
    (!release.is_empty()).then(|| release.to_string())
}

/// Hostname from the injected root (`/proc/sys/kernel/hostname`); `None`
/// when absent (there is no `os.hostname()` fallback on this Rust path — the
/// payload field is nullable by contract).
fn read_hostname(proc_root: &Path) -> Option<String> {
    let hostname = safe_read(&proc_root.join("sys").join("kernel").join("hostname"))?;
    let hostname = hostname.trim();
    (!hostname.is_empty()).then(|| hostname.to_string())
}

/// First battery under `/sys/class/power_supply` (capacity % + status
/// string) (Node `readBattery`).
#[derive(Debug, Clone, PartialEq)]
pub struct Battery {
    pub pct: f64,
    pub status: String,
}

/// First battery under `/sys/class/power_supply`; `None` if none.
pub fn read_battery(sys_root: &Path) -> Option<Battery> {
    let batteries = list_battery_entries(sys_root)?;
    let entry = batteries.first()?;
    let dir = sys_root.join("class").join("power_supply").join(entry);
    let pct = read_number_file(&dir.join("capacity"))?;
    let status = safe_read(&dir.join("status"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Unknown".to_string());
    Some(Battery {
        pct: (pct as f64).clamp(0.0, 100.0),
        status,
    })
}

/// One thermal zone (millidegree -> celsius, `type` as label).
#[derive(Debug, Clone, PartialEq)]
pub struct ThermalZone {
    pub label: String,
    pub celsius: f64,
}

/// Thermal zones (max 16); `None` when the thermal class dir is missing
/// (Node `readThermals`).
pub fn read_thermals(sys_root: &Path) -> Option<Vec<ThermalZone>> {
    let zones = list_thermal_zones(sys_root)?;
    let base = sys_root.join("class").join("thermal");
    let mut results = Vec::new();
    for zone in zones.iter().take(16) {
        let Some(milli) = read_number_file(&base.join(zone).join("temp")) else {
            continue;
        };
        let label = safe_read(&base.join(zone).join("type"))
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| zone.clone());
        results.push(ThermalZone {
            label,
            celsius: milli as f64 / 1000.0,
        });
    }
    Some(results)
}

/// Machine identity + capability snapshot (Node `readMachineInfo`, cheap
/// probes only — dir listings, no scans). `cgroup` is the exact `'v1' |
/// 'v2' | 'none'` vocabulary of the Node payload.
#[derive(Debug, Clone, PartialEq)]
pub struct MachineInfo {
    pub cores: u64,
    pub mem_total_bytes: u64,
    pub platform: String,
    pub wsl: bool,
    pub kernel: Option<String>,
    pub hostname: Option<String>,
    pub psi: bool,
    pub cgroup: String,
    pub thermal_count: u64,
    pub battery_present: bool,
    pub gpu: String,
}

/// Machine identity + capability snapshot. There is no `os.cpus()`/
/// `os.totalmem()`/`os.hostname()` equivalent on this Rust path: cores come
/// from [`std::thread::available_parallelism`], `mem_total_bytes` from the
/// injected meminfo (0 when absent), kernel/hostname from the injected
/// `<proc_root>/sys/kernel/{osrelease,hostname}` (`None` when absent — both
/// payload fields are nullable by contract).
pub fn read_machine_info(proc_root: &Path, sys_root: &Path) -> MachineInfo {
    let release = read_kernel_release(proc_root);
    let thermal_zones = list_thermal_zones(sys_root);
    let batteries = list_battery_entries(sys_root);
    let release_lower = release.as_deref().unwrap_or("").to_ascii_lowercase();
    MachineInfo {
        cores: std::thread::available_parallelism()
            .map(|n| n.get() as u64)
            .unwrap_or(1),
        mem_total_bytes: read_meminfo(proc_root)
            .map(|m| m.total_kb.saturating_mul(1024))
            .unwrap_or(0),
        platform: if cfg!(target_os = "windows") {
            "win32".to_string()
        } else if cfg!(target_os = "macos") {
            "darwin".to_string()
        } else {
            "linux".to_string()
        },
        // /microsoft|wsl/i
        wsl: release_lower.contains("microsoft") || release_lower.contains("wsl"),
        kernel: release,
        hostname: read_hostname(proc_root),
        psi: probe_psi_readable(proc_root),
        cgroup: probe_cgroup_version(proc_root).to_string(),
        thermal_count: thermal_zones.as_ref().map(|z| z.len() as u64).unwrap_or(0),
        battery_present: batteries.as_ref().map(|b| !b.is_empty()).unwrap_or(false),
        // GPU detection is out of scope by design (renders 'n/a' truthfully).
        gpu: "none".to_string(),
    }
}

// ---------------------------------------------------------------------------
// Process-table scan pure pieces (the async dwell loop lives in
// freshell-server::host_stats — this crate is tokio-free)
// ---------------------------------------------------------------------------

/// Parsed `/proc/<pid>/stat`: comm (after the LAST ')'), state, utime+stime
/// busy jiffies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcPidStat {
    pub name: String,
    pub state: String,
    pub busy_jiffies: u64,
}

/// `pid (comm) state ...` — comm may contain spaces AND parens, so fields
/// are counted after the LAST ')' (precedent:
/// `server/coding-cli/codex-child-registry.ts`, mirrored by
/// `freshell-server`'s `shutdown_forensics`). After the close paren,
/// zero-indexed fields: [0] state, [11] utime, [12] stime.
pub fn parse_proc_pid_stat(text: &str) -> Option<ProcPidStat> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    if open > close {
        return None;
    }
    let fields: Vec<&str> = text[close + 1..].split_whitespace().collect();
    if fields.len() < 13 {
        return None;
    }
    let state = fields[0];
    if state.is_empty() {
        return None;
    }
    let utime = fields[11].trim().parse::<u64>().ok()?;
    let stime = fields[12].trim().parse::<u64>().ok()?;
    Some(ProcPidStat {
        name: text[open + 1..close].to_string(),
        state: state.to_string(),
        busy_jiffies: utime + stime,
    })
}

/// `/proc/<pid>/status` VmRSS in kB. Preferred over stat rss pages x 4096:
/// page size is NOT 4096 on every target (aarch64 16K/64K pages would
/// silently inflate RSS 16x).
pub fn parse_status_vm_rss_kb(text: &str) -> Option<u64> {
    // /^VmRSS:\s+(\d+)\s*kB/m
    for line in text.lines() {
        let Some(rest) = line.strip_prefix("VmRSS:") else {
            continue;
        };
        let tokens: Vec<&str> = rest.split_whitespace().collect();
        if tokens.len() < 2 || tokens[1] != "kB" {
            return None;
        }
        return tokens[0].parse::<u64>().ok();
    }
    None
}

/// Numeric `/proc` entries (pids), capped at [`PROC_SCAN_CAP`]; `None` when
/// the root is unreadable.
pub fn list_numeric_pids(proc_root: &Path) -> Option<Vec<u64>> {
    let entries = safe_read_dir(proc_root)?;
    let mut pids = Vec::new();
    for entry in entries {
        if entry.is_empty() || !entry.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        if let Ok(pid) = entry.parse::<u64>() {
            pids.push(pid);
            if pids.len() >= PROC_SCAN_CAP {
                break;
            }
        }
    }
    pids.sort_unstable();
    Some(pids)
}

/// Bounded read of one `/proc/<pid>` file (mirrors Node's
/// `readTextFileBounded(path, 4096)`); `None` on any failure.
pub fn read_pid_file_bounded(proc_root: &Path, pid: u64, name: &str) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(proc_root.join(pid.to_string()).join(name)).ok()?;
    let mut buffer = Vec::with_capacity(PROC_PID_FILE_MAX_BYTES);
    file.take(PROC_PID_FILE_MAX_BYTES as u64)
        .read_to_end(&mut buffer)
        .ok()?;
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

/// jiffies delta over `dwell_ms` -> cpu percent, clamped to
/// `[0, 100 * cores]` (Node `computeCpuPct`; USER_HZ=100). A non-positive
/// dwell returns 0 (never NaN/Infinity).
pub fn compute_cpu_pct(delta_jiffies: f64, dwell_ms: u64, cores: u64) -> f64 {
    if !delta_jiffies.is_finite() || dwell_ms == 0 {
        return 0.0;
    }
    let cores = cores.max(1);
    let pct = (delta_jiffies / USER_HZ as f64 / (dwell_ms as f64 / 1000.0)) * 100.0;
    pct.clamp(0.0, 100.0 * cores as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_stats_readers_is_whole_device_classifies_names() {
        assert!(is_whole_device("sda"));
        assert!(is_whole_device("nvme0n1"));
        assert!(is_whole_device("mmcblk0"));
        assert!(is_whole_device("dm-0"));
        assert!(!is_whole_device("sda1"));
        assert!(!is_whole_device("vda2"));
        assert!(!is_whole_device("nvme0n1p1"));
        assert!(!is_whole_device("mmcblk0p1"));
        assert!(!is_whole_device("loop0"));
        assert!(!is_whole_device("ram0"));
    }

    #[test]
    fn host_stats_readers_compute_cpu_pct_jiffy_math() {
        // 30 jiffies over a 300ms dwell = 100% of one core (USER_HZ=100).
        assert_eq!(compute_cpu_pct(30.0, 300, 4), 100.0);
        assert_eq!(compute_cpu_pct(15.0, 300, 4), 50.0);
        // Clamped to [0, 100 * cores]; non-positive dwell -> 0.
        assert_eq!(compute_cpu_pct(1e12, 1, 4), 400.0);
        assert_eq!(compute_cpu_pct(-5.0, 300, 4), 0.0);
        assert_eq!(compute_cpu_pct(50.0, 0, 4), 0.0);
    }

    #[test]
    fn host_stats_readers_parse_proc_pid_stat_comm_with_parens() {
        // The procmini fixture's pid 404 line: comm contains parens AND
        // spaces — the split must happen after the LAST ')'.
        let text = "404 (my (weird) proc) D 1 404 404 0 -1 4194304 200 0 5 0 999 111 0 0 20 0 2 0 8000 300000000 6000\n";
        let parsed = parse_proc_pid_stat(text).expect("valid stat line");
        assert_eq!(parsed.name, "my (weird) proc");
        assert_eq!(parsed.state, "D");
        assert_eq!(parsed.busy_jiffies, 999 + 111);
        assert!(parse_proc_pid_stat("999 (broken").is_none());
    }

    #[test]
    fn host_stats_readers_parse_status_vm_rss_kb() {
        let text = "Name:\tsystemd\nVmRSS:\t   12345 kB\nThreads:\t1\n";
        assert_eq!(parse_status_vm_rss_kb(text), Some(12345));
        assert_eq!(parse_status_vm_rss_kb("Name:\tx\n"), None);
    }
}
