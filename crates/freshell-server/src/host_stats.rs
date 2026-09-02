//! HostStatsCollectorService — the Rust port of the subscriber-gated two-tier
//! host pressure collector `server/host-stats/service.ts`
//! (`docs/plans/2026-08-25-host-pressure-pane.md` Task 9 contract lines
//! 874–933). Implements [`freshell_ws::host_stats_collector::HostStatsCollector`]
//! over the pure path-injected readers in
//! [`freshell_platform::host_stats_readers`] (themselves the port of
//! `server/host-stats/readers.ts`); `freshell-ws` owns the trait +
//! interest registry + dispatch and never touches `/proc` or timers.
//!
//! Tiers: FAST (default `FRESHELL_HOST_STATS_FAST_MS` || 2000) reads
//! cpu/load/memory (cgroup-aware)/paging/psi + freshell internals; SLOW
//! (default `FRESHELL_HOST_STATS_SLOW_MS` || 5000) reads
//! diskstats/netdev/tcp/limits/cpufreq. Rates (cpu%, paging KB/s, disk/net
//! B/s) come from CUMULATIVE reader counters delta'd over dt; the previous
//! sample of each counter family lives in the shared cache. The first tick of
//! each family has no window, so it reports null-safe zeros (rates 0,
//! nullable windows null).
//!
//! `set_active(true)` runs ONE immediate fast tick (a fresh subscriber gets a
//! shaped snapshot at once); the slow tier only ticks on its own interval.
//! `set_active(false)` aborts ALL collection tasks (true zero cost).
//! `snapshot()` never blocks on I/O — ticks write caches, snapshots read
//! caches.
//!
//! `refresh()` (on-request manual data — process table, disks, inotify,
//! thermals/battery) is single-flight with a 1s post-completion cooldown
//! (connection-agnostic, R3M6). Section budgets are COOPERATIVE: every
//! section gets a shared absolute deadline (start + section_budget; the
//! process-table scan's per-pid deadline check exists for this) and an
//! overall_budget watchdog marks any still-running section failed. A failed
//! section keeps the full zero-shape + `available:false` + a sectionErrors
//! entry; other sections complete.
//!
//! Platform: `/proc` + `/sys` readers are Linux-only. Unlike Node there is NO
//! darwin fallback (`os.cpus()/os.loadavg()/os.totalmem()` scraped objects
//! and the `ps` subprocess are Node-only): on darwin/Windows the files simply
//! do not exist, so every `/proc`-dependent section degrades to its
//! zero-shape (`available:false`) and `cpu.available` is `false` (frozen
//! Task 9 note).
//!
//! Delivery (frozen contract): snapshots flow ONLY to subscribed connections
//! — the cadence iterates the interest registry's per-connection senders
//! (captured by `terminal.rs` at subscribe time); the shared `broadcast_tx`
//! fan-out bus is NEVER used (non-watchers get zero traffic).

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
#[cfg(test)]
use std::sync::atomic::AtomicBool;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use freshell_platform::host_stats_readers as readers;
use freshell_protocol::{
    HostStatsBattery, HostStatsCpu, HostStatsDisk, HostStatsDiskIo, HostStatsDisks,
    HostStatsFreshell, HostStatsInotify, HostStatsLimits, HostStatsLive, HostStatsLoad,
    HostStatsMachine, HostStatsManual, HostStatsMemory, HostStatsNetwork, HostStatsPaging,
    HostStatsProcessHealth, HostStatsPsi, HostStatsSnapshot, HostStatsThermalZone,
    HostStatsThermals, HostStatsTopProcess, HostStatsTopProcesses,
};
use freshell_ws::host_stats_collector::{
    HostStatsCollector, HostStatsRefreshFuture, HostStatsRefreshOk,
};
use freshell_ws::host_stats_interest::HostStatsInterestRegistry;

const DEFAULT_FAST: Duration = Duration::from_millis(2000);
const DEFAULT_SLOW: Duration = Duration::from_millis(5000);
const DEFAULT_OVERALL_BUDGET: Duration = Duration::from_millis(4000);
/// No re-start stampede: refresh() rejects <1s after the previous refresh
/// COMPLETED (connection-agnostic, mirrors Node's REFRESH_MIN_INTERVAL_MS).
const DEFAULT_REFRESH_COOLDOWN: Duration = Duration::from_millis(1000);
/// Scheduler-drift sampler cadence while active (the Rust stand-in for
/// Node's `monitorEventLoopDelay` histogram; samples land in a per-fast-tick
/// window whose p99 becomes `eventLoopLagP99Ms`).
const DEFAULT_DRIFT_SAMPLE_INTERVAL: Duration = Duration::from_millis(100);
/// On-request process-table dwell (two `/proc` samples + dwell → per-process
/// cpuPct). Mirrors Node's PROC_SCAN_DWELL_MS.
const PROC_SCAN_DWELL: Duration = Duration::from_millis(300);
const TOP_PROCESS_COUNT: usize = 12;
const DISK_SECTOR_BYTES: u64 = 512;
/// `/proc/vmstat` pswpin/pswpout count PAGES; 4KB pages on every production
/// target (documented Node assumption, mirrored).
const VMSTAT_PAGE_KB: u64 = 4;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn env_positive_ms(name: &str, fallback: Duration) -> Duration {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|v| *v > 0)
        .map(Duration::from_millis)
        .unwrap_or(fallback)
}

fn clamp_pct(value: f64) -> f64 {
    value.clamp(0.0, 100.0)
}

/// Tunables + injected filesystem roots. `Default` is the production
/// contract; tests inject the committed fixture tree + fast cadences (no
/// tokio time control — real short cadences, deterministic count
/// assertions).
#[derive(Debug, Clone)]
pub struct HostStatsCollectorConfig {
    /// Default `/proc` (the machine probe + every reader root).
    pub proc_root: PathBuf,
    /// Default `/sys` (cgroup root = `<sys_root>/fs/cgroup`, cpufreq,
    /// thermal, power_supply).
    pub sys_root: PathBuf,
    pub fast: Duration,
    pub slow: Duration,
    /// Watchdog for a refresh section still running past the cooperative
    /// per-section budget (the trait's `deadline` argument is that budget).
    pub overall_budget: Duration,
    pub refresh_cooldown: Duration,
    pub drift_sample_interval: Duration,
}

impl Default for HostStatsCollectorConfig {
    fn default() -> Self {
        Self {
            proc_root: PathBuf::from("/proc"),
            sys_root: PathBuf::from("/sys"),
            fast: DEFAULT_FAST,
            slow: DEFAULT_SLOW,
            overall_budget: DEFAULT_OVERALL_BUDGET,
            refresh_cooldown: DEFAULT_REFRESH_COOLDOWN,
            drift_sample_interval: DEFAULT_DRIFT_SAMPLE_INTERVAL,
        }
    }
}

impl HostStatsCollectorConfig {
    /// Production wiring: defaults with the two cadence env overrides
    /// (`FRESHELL_HOST_STATS_FAST_MS`/`_SLOW_MS`, positive ms only — Node
    /// `envPositiveMs` parity).
    pub fn from_env() -> Self {
        Self {
            fast: env_positive_ms("FRESHELL_HOST_STATS_FAST_MS", DEFAULT_FAST),
            slow: env_positive_ms("FRESHELL_HOST_STATS_SLOW_MS", DEFAULT_SLOW),
            ..Default::default()
        }
    }

    fn cgroup_root(&self) -> PathBuf {
        self.sys_root.join("fs").join("cgroup")
    }
}

/// The in-flight wire one refresh clones to every waiter (single-flight).
type RefreshWire = Result<HostStatsRefreshOk, String>;

/// The mutable collection state, shared by the collector handle and its
/// spawned cadence tasks. All guards are std Mutexes: locks are never held
/// across an await (ticks are sync reader calls; refresh awaits only the
/// dwell sleep / watch channel).
struct Share {
    live: Mutex<HostStatsLive>,
    manual: Mutex<Option<(u64, HostStatsManual)>>,
    prev_cpu: Mutex<Option<(u64, readers::CpuTimes)>>,
    prev_vmstat: Mutex<Option<(u64, readers::Vmstat)>>,
    prev_disks: Mutex<Option<(u64, BTreeMap<String, readers::DiskCounters>)>>,
    prev_net: Mutex<Option<(u64, readers::NetDevTotals)>>,
    /// Scheduler-drift samples (ms) since the previous fast tick; drained per
    /// fast tick into `freshell.eventLoopLagP99Ms`.
    lag_samples: Mutex<Vec<f64>>,
    cadence: Mutex<Option<CadenceHandles>>,
    /// Single-flight: while Some, a refresh is in flight and later callers
    /// clone this receiver and await the SAME wire (Node returns the same
    /// in-flight promise). The run itself is the COLLECTOR's own spawned
    /// task — never the requesting caller's future — so a caller teardown
    /// cancels nothing for anyone else (Node service-owned pendingRefresh).
    refresh_flight: Mutex<Option<tokio::sync::watch::Receiver<Option<RefreshWire>>>>,
    last_refresh_completed: Mutex<Option<Instant>>,
}

struct CadenceHandles {
    fast: tokio::task::JoinHandle<()>,
    slow: tokio::task::JoinHandle<()>,
    drift: tokio::task::JoinHandle<()>,
}

/// Everything the cadence tasks + refresh path need, Arc-shared.
struct CollectorCtx {
    cfg: HostStatsCollectorConfig,
    registry: freshell_terminal::TerminalRegistry,
    interest: HostStatsInterestRegistry,
    boot_anchor: Instant,
    machine: HostStatsMachine,
    scan_runs: AtomicUsize,
    /// Test-only fault-injection seam (never in production builds): a run
    /// that consumes a `true` here dies mid-scan, unwinding the
    /// collector's spawned run task — the "run vanished without
    /// completing" fault the flight-slot guard cleans up after. One-shot,
    /// so a recovery refresh runs healthily.
    #[cfg(test)]
    test_run_panic: AtomicBool,
    share: Share,
}

/// The concrete Task 9 collector. Construct + `Arc<dyn HostStatsCollector>`
/// it in `main.rs` next to the terminal-registry construction; NO task spawns
/// here — the interest-transition callback (`set_active`) owns spawn/abort.
pub struct HostStatsCollectorService {
    ctx: Arc<CollectorCtx>,
}

impl HostStatsCollectorService {
    pub fn new(
        cfg: HostStatsCollectorConfig,
        registry: freshell_terminal::TerminalRegistry,
        interest: HostStatsInterestRegistry,
        boot_anchor: Instant,
    ) -> Self {
        let machine_info = readers::read_machine_info(&cfg.proc_root, &cfg.sys_root);
        let machine = HostStatsMachine {
            cores: machine_info.cores,
            mem_total_bytes: machine_info.mem_total_bytes,
            platform: machine_info.platform,
            wsl: machine_info.wsl,
            kernel: machine_info.kernel,
            hostname: machine_info.hostname,
            psi: machine_info.psi,
            cgroup: machine_info.cgroup,
            thermal_count: machine_info.thermal_count,
            battery_present: machine_info.battery_present,
            gpu: machine_info.gpu,
        };
        Self {
            ctx: Arc::new(CollectorCtx {
                share: Share {
                    live: Mutex::new(zero_live(&machine)),
                    manual: Mutex::new(None),
                    prev_cpu: Mutex::new(None),
                    prev_vmstat: Mutex::new(None),
                    prev_disks: Mutex::new(None),
                    prev_net: Mutex::new(None),
                    lag_samples: Mutex::new(Vec::new()),
                    cadence: Mutex::new(None),
                    refresh_flight: Mutex::new(None),
                    last_refresh_completed: Mutex::new(None),
                },
                cfg,
                registry,
                interest,
                boot_anchor,
                machine,
                scan_runs: AtomicUsize::new(0),
                #[cfg(test)]
                test_run_panic: AtomicBool::new(false),
            }),
        }
    }

    /// Test-visible cadence state: true while the two-tier cadence + drift
    /// sampler JoinHandles are owned (between `set_active(true)` and
    /// `set_active(false)`). Only test code reads this (the binary crate's
    /// non-test build has no other consumer, hence the allow).
    #[allow(dead_code)]
    pub fn is_running(&self) -> bool {
        self.ctx.share.cadence.lock().unwrap().is_some()
    }

    /// Test-support instrumentation: how many process-table scans the
    /// refresh path has run (single-flight proof).
    #[allow(dead_code)]
    pub fn scan_run_count(&self) -> usize {
        self.ctx.scan_runs.load(Ordering::SeqCst)
    }
}

// ---------------------------------------------------------------------------
// Cadence internals
// ---------------------------------------------------------------------------

impl CollectorCtx {
    /// The merge view `snapshot()` publishes (ticks write caches; snapshots
    /// read caches — never blocks on fresh I/O).
    fn snapshot_payload(&self) -> HostStatsSnapshot {
        let live = self.share.live.lock().unwrap().clone();
        let manual = self.share.manual.lock().unwrap().clone();
        HostStatsSnapshot {
            at: now_ms(),
            live,
            manual_at: manual.as_ref().map(|(at, _)| *at),
            manual: manual.map(|(_, m)| m),
        }
    }

    /// Push the current snapshot to SUBSCRIBED connections only (the frozen
    /// Task 9 delivery contract: the per-connection senders captured at
    /// subscribe time; never `broadcast_tx`).
    fn deliver_snapshot(&self) {
        if !self.interest.any() {
            return;
        }
        let msg =
            freshell_protocol::ServerMessage::HostStatsSnapshot(Box::new(self.snapshot_payload()));
        for sink in self.interest.senders() {
            sink(msg.clone());
        }
    }

    /// FAST tier (Node `tickFast`): cpu/load/memory/paging/psi + freshell
    /// internals, then the snapshot fan-out (Node emits after fast ticks
    /// only; the slow tier is pull-side).
    fn tick_fast(&self) {
        let at = now_ms();
        let cpu = self.read_cpu_section(at);
        let load = self.read_load_section();
        let memory = self.read_memory_section();
        let paging = self.read_paging_section(at);
        let psi = self.read_psi_section();
        let freshell = self.read_freshell_section();
        {
            let mut live = self.share.live.lock().unwrap();
            live.cpu = cpu;
            live.load = load;
            live.memory = memory;
            live.paging = paging;
            live.psi = psi;
            live.freshell = freshell;
        }
        self.deliver_snapshot();
    }

    /// SLOW tier (Node `tickSlow`): cpufreq merges into the cached cpu
    /// section; diskstats/netdev/limits are delta'd here.
    fn tick_slow(&self) {
        let at = now_ms();
        let freq_m_hz = readers::read_cpu_freq_mhz(&self.cfg.sys_root);
        let disk_io = self.read_disk_io_section(at);
        let network = self.read_network_section(at);
        let limits = self.read_limits_section();
        let mut live = self.share.live.lock().unwrap();
        live.cpu.freq_m_hz = freq_m_hz;
        live.disk_io = disk_io;
        live.network = network;
        live.limits = limits;
    }

    // -----------------------------------------------------------------
    // Fast-tier sections
    // -----------------------------------------------------------------

    fn read_cpu_section(&self, at: u64) -> HostStatsCpu {
        let Some(sample) = readers::read_cpu_times(&self.cfg.proc_root) else {
            return zero_cpu();
        };
        let prev = self
            .share
            .prev_cpu
            .lock()
            .unwrap()
            .replace((at, sample.clone()));
        let freq_m_hz = self.share.live.lock().unwrap().cpu.freq_m_hz;
        let Some((prev_at, prev_v)) = prev else {
            // First tick: no window — null-safe zero rates.
            return HostStatsCpu {
                available: true,
                usage_pct: 0.0,
                steal_pct: Some(0.0),
                per_core_pct: sample.per_core.iter().map(|_| 0.0).collect(),
                freq_m_hz,
            };
        };
        if at <= prev_at || sample.total <= prev_v.total {
            return HostStatsCpu {
                available: true,
                usage_pct: 0.0,
                steal_pct: Some(0.0),
                per_core_pct: sample.per_core.iter().map(|_| 0.0).collect(),
                freq_m_hz,
            };
        }
        let d_total = sample.total - prev_v.total;
        HostStatsCpu {
            available: true,
            usage_pct: clamp_pct((sample.busy - prev_v.busy) / d_total * 100.0),
            steal_pct: Some(clamp_pct((sample.steal - prev_v.steal) / d_total * 100.0)),
            per_core_pct: sample
                .per_core
                .iter()
                .enumerate()
                .map(|(i, core)| {
                    let Some(before) = prev_v.per_core.get(i) else {
                        return 0.0;
                    };
                    let d_core_total = core.total - before.total;
                    if d_core_total <= 0.0 {
                        0.0
                    } else {
                        clamp_pct((core.busy - before.busy) / d_core_total * 100.0)
                    }
                })
                .collect(),
            freq_m_hz,
        }
    }

    fn read_load_section(&self) -> HostStatsLoad {
        let cores = self.machine.cores;
        let Some(load) = readers::read_loadavg(&self.cfg.proc_root) else {
            return zero_load(cores);
        };
        HostStatsLoad {
            available: true,
            load1: load.load1,
            load5: load.load5,
            load15: load.load15,
            cores,
        }
    }

    /// Memory precedence (contract point 2): a FINITE cgroup leaf limit wins
    /// outright (source 'cgroup'; total/used/available/limit all from the
    /// leaf). Unlimited or absent → host meminfo (source 'host'); a cgroup
    /// current is NEVER mixed with a host total. Swap stays host-scoped
    /// context either way (no cgroup swap accounting is collected).
    fn read_memory_section(&self) -> HostStatsMemory {
        let cgroup = readers::read_cgroup_memory(&self.cfg.cgroup_root(), &self.cfg.proc_root);
        let meminfo = readers::read_meminfo(&self.cfg.proc_root);
        let swap_total_bytes = meminfo.map(|m| m.swap_total_kb * 1024);
        let swap_used_bytes = meminfo.map(|m| (m.swap_total_kb - m.swap_free_kb) * 1024);
        if let Some(cg) = cgroup {
            if let Some(limit) = cg.limit_bytes {
                return HostStatsMemory {
                    available: true,
                    source: "cgroup".to_string(),
                    total_bytes: limit,
                    used_bytes: cg.current_bytes,
                    available_bytes: limit.saturating_sub(cg.current_bytes),
                    cgroup_limit_bytes: Some(limit),
                    swap_total_bytes,
                    swap_used_bytes,
                };
            }
        }
        if let Some(mem) = meminfo {
            let total_bytes = mem.total_kb * 1024;
            let available_bytes = mem.avail_kb * 1024;
            return HostStatsMemory {
                available: true,
                source: "host".to_string(),
                total_bytes,
                used_bytes: total_bytes.saturating_sub(available_bytes),
                available_bytes,
                cgroup_limit_bytes: None,
                swap_total_bytes,
                swap_used_bytes,
            };
        }
        zero_memory()
    }

    fn read_paging_section(&self, at: u64) -> HostStatsPaging {
        let Some(vm) = readers::read_vmstat(&self.cfg.proc_root) else {
            return zero_paging();
        };
        let prev = self.share.prev_vmstat.lock().unwrap().replace((at, vm));
        let oom_kills_total = vm.oom_kill.unwrap_or(0);
        let Some((prev_at, prev_v)) = prev else {
            return HostStatsPaging {
                available: true,
                swap_in_kbps: 0.0,
                swap_out_kbps: 0.0,
                maj_faults_per_sec: 0.0,
                oom_kills_delta: 0,
                oom_kills_total,
            };
        };
        if at <= prev_at {
            return HostStatsPaging {
                available: true,
                swap_in_kbps: 0.0,
                swap_out_kbps: 0.0,
                maj_faults_per_sec: 0.0,
                oom_kills_delta: 0,
                oom_kills_total,
            };
        }
        let dt_sec = (at - prev_at) as f64 / 1000.0;
        HostStatsPaging {
            available: true,
            swap_in_kbps: (vm.pswpin.saturating_sub(prev_v.pswpin) * VMSTAT_PAGE_KB) as f64
                / dt_sec,
            swap_out_kbps: (vm.pswpout.saturating_sub(prev_v.pswpout) * VMSTAT_PAGE_KB) as f64
                / dt_sec,
            maj_faults_per_sec: vm.pgmajfault.saturating_sub(prev_v.pgmajfault) as f64 / dt_sec,
            oom_kills_delta: match (vm.oom_kill, prev_v.oom_kill) {
                (Some(cur), Some(before)) => cur.saturating_sub(before),
                _ => 0,
            },
            oom_kills_total,
        }
    }

    fn read_psi_section(&self) -> HostStatsPsi {
        let Some(psi) = readers::read_psi(&self.cfg.proc_root) else {
            return zero_psi();
        };
        HostStatsPsi {
            available: true,
            cpu_some10: psi.cpu_some10,
            mem_some10: psi.mem_some10,
            mem_full10: psi.mem_full10,
            io_some10: psi.io_some10,
            io_full10: psi.io_full10,
        }
    }

    fn read_freshell_section(&self) -> HostStatsFreshell {
        HostStatsFreshell {
            available: true,
            source: "rust".to_string(),
            // The diag.rs access pattern: the live inventory length.
            ptys_running: self.registry.inventory().len() as u64,
            ptys_max: 0,
            ws_clients: self.registry.connection_count() as u64,
            ws_clients_max: 0,
            event_loop_lag_p99_ms: self.drain_lag_p99_ms(),
            rss_bytes: read_self_rss_bytes(),
            uptime_sec: self.boot_anchor.elapsed().as_secs_f64(),
        }
    }

    /// p99 scheduler drift (ms) collected since the previous fast tick;
    /// None when unmeasurable (Node histogram parity: drain + reset per fast
    /// tick).
    fn drain_lag_p99_ms(&self) -> Option<f64> {
        let mut guard = self.share.lag_samples.lock().unwrap();
        if guard.is_empty() {
            return None;
        }
        let mut samples = std::mem::take(&mut *guard);
        drop(guard);
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        // nearest-rank p99
        let rank = ((0.99 * samples.len() as f64).ceil() as usize).clamp(1, samples.len());
        let value = samples[rank - 1];
        (value.is_finite() && value >= 0.0).then_some(value)
    }

    // -----------------------------------------------------------------
    // Slow-tier sections
    // -----------------------------------------------------------------

    fn read_disk_io_section(&self, at: u64) -> HostStatsDiskIo {
        let Some(devs) = readers::read_disk_stats(&self.cfg.proc_root) else {
            return zero_disk_io();
        };
        let prev = self
            .share
            .prev_disks
            .lock()
            .unwrap()
            .replace((at, devs.clone()));
        let Some((prev_at, prev_v)) = prev else {
            return HostStatsDiskIo {
                available: true,
                read_bps: 0.0,
                write_bps: 0.0,
                util_pct: None,
                weighted_await_ms: None,
            };
        };
        if at <= prev_at {
            return HostStatsDiskIo {
                available: true,
                read_bps: 0.0,
                write_bps: 0.0,
                util_pct: None,
                weighted_await_ms: None,
            };
        }
        let dt_ms = (at - prev_at) as f64;
        let dt_sec = dt_ms / 1000.0;
        let mut read_bytes = 0u64;
        let mut write_bytes = 0u64;
        let mut util_pct: Option<f64> = None;
        let mut weighted_await_ms: Option<f64> = None;
        for (name, cur) in &devs {
            let Some(before) = prev_v.get(name) else {
                continue;
            };
            read_bytes += cur.read_sectors.saturating_sub(before.read_sectors) * DISK_SECTOR_BYTES;
            write_bytes +=
                cur.written_sectors.saturating_sub(before.written_sectors) * DISK_SECTOR_BYTES;
            // Multi-device rule (plan thresholds): worst device wins; util
            // can never exceed 100.
            let util = clamp_pct(
                (cur.time_doing_ios_ms
                    .saturating_sub(before.time_doing_ios_ms)) as f64
                    / dt_ms
                    * 100.0,
            );
            if util_pct.is_none_or(|best| util > best) {
                util_pct = Some(util);
                let ios = cur.reads_completed.saturating_sub(before.reads_completed)
                    + cur.writes_completed.saturating_sub(before.writes_completed);
                let io_ms = cur.read_ms.saturating_sub(before.read_ms)
                    + cur.write_ms.saturating_sub(before.write_ms);
                weighted_await_ms = if ios > 0 {
                    Some(io_ms as f64 / ios as f64)
                } else {
                    None
                };
            }
        }
        HostStatsDiskIo {
            available: true,
            read_bps: read_bytes as f64 / dt_sec,
            write_bps: write_bytes as f64 / dt_sec,
            util_pct,
            weighted_await_ms,
        }
    }

    fn read_network_section(&self, at: u64) -> HostStatsNetwork {
        let Some(net) = readers::read_net_dev(&self.cfg.proc_root) else {
            return zero_network();
        };
        let prev = self.share.prev_net.lock().unwrap().replace((at, net));
        let totals = |rx_bps: f64, tx_bps: f64, deltas: (u64, u64, u64, u64)| HostStatsNetwork {
            available: true,
            rx_bps,
            tx_bps,
            rx_errors_total: net.rx_err,
            tx_errors_total: net.tx_err,
            rx_dropped_total: net.rx_drop,
            tx_dropped_total: net.tx_drop,
            rx_errors_delta: deltas.0,
            tx_errors_delta: deltas.1,
            rx_dropped_delta: deltas.2,
            tx_dropped_delta: deltas.3,
        };
        let Some((prev_at, prev_v)) = prev else {
            return totals(0.0, 0.0, (0, 0, 0, 0));
        };
        if at <= prev_at {
            return totals(0.0, 0.0, (0, 0, 0, 0));
        }
        let dt_sec = (at - prev_at) as f64 / 1000.0;
        totals(
            net.rx_bytes.saturating_sub(prev_v.rx_bytes) as f64 / dt_sec,
            net.tx_bytes.saturating_sub(prev_v.tx_bytes) as f64 / dt_sec,
            (
                net.rx_err.saturating_sub(prev_v.rx_err),
                net.tx_err.saturating_sub(prev_v.tx_err),
                net.rx_drop.saturating_sub(prev_v.rx_drop),
                net.tx_drop.saturating_sub(prev_v.tx_drop),
            ),
        )
    }

    fn read_limits_section(&self) -> HostStatsLimits {
        let proc_root = &self.cfg.proc_root;
        let fds_used = readers::read_self_fd_count(proc_root);
        let fds_max = readers::read_self_limits_fds_max(proc_root);
        let pids_used = readers::read_pid_count(proc_root);
        let pids_max = readers::read_pids_limit(proc_root, &self.cfg.cgroup_root());
        let time_wait = readers::read_tcp_state_counts(proc_root).map(|t| t.time_wait);
        let ephemeral_ports =
            readers::read_ephemeral_port_range(proc_root).map(|r| r.end - r.start + 1);
        if fds_used.is_none()
            && fds_max.is_none()
            && pids_used.is_none()
            && pids_max.is_none()
            && time_wait.is_none()
            && ephemeral_ports.is_none()
        {
            return zero_limits();
        }
        HostStatsLimits {
            available: true,
            fds_used,
            fds_max,
            pids_used,
            pids_max,
            time_wait,
            ephemeral_ports,
        }
    }
}

/// `/proc/self/statm` resident pages × page size (Node
/// `process.memoryUsage().rss`). A REAL self-read independent of the injected
/// proc root (same as Node's).
#[cfg(unix)]
fn read_self_rss_bytes() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/self/statm").ok()?;
    let resident_pages: u64 = text.split_whitespace().nth(1)?.parse().ok()?;
    let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if page_size <= 0 {
        return None;
    }
    Some(resident_pages.saturating_mul(page_size as u64))
}

/// Non-unix: no RSS source on this Rust path (nullable by contract).
#[cfg(not(unix))]
fn read_self_rss_bytes() -> Option<u64> {
    None
}

impl HostStatsCollector for HostStatsCollectorService {
    fn snapshot(&self) -> HostStatsSnapshot {
        self.ctx.snapshot_payload()
    }

    fn refresh(&self, deadline: Duration) -> HostStatsRefreshFuture<'_> {
        let ctx = Arc::clone(&self.ctx);
        Box::pin(async move {
            // Connection-AGNOSTIC post-completion cooldown (Node
            // REFRESH_MIN_INTERVAL_MS — separate from terminal.rs's
            // per-connection floor).
            {
                let last = ctx.share.last_refresh_completed.lock().unwrap();
                if let Some(t) = *last {
                    if t.elapsed() < ctx.cfg.refresh_cooldown {
                        return Err("rate_limited".to_string());
                    }
                }
            }
            let mut rx = {
                let mut flight = ctx.share.refresh_flight.lock().unwrap();
                if let Some(rx) = flight.clone() {
                    rx
                } else {
                    let (tx, rx) = tokio::sync::watch::channel(None);
                    *flight = Some(rx.clone());
                    // The COLLECTOR owns the run (Node parity: the service owns
                    // pendingRefresh independent of any requesting socket): the
                    // refresh runs as the collector's own spawned task, and
                    // every caller — the leader included — merely awaits a
                    // receiver. A leader connection tearing down mid-flight
                    // cancels NOTHING: the run still completes, the completion
                    // stamps land unconditionally, and every waiter gets the
                    // wire.
                    //
                    // Stamp the cooldown + free the flight slot BEFORE waking
                    // the waiters: a waiter whose next move is an immediate
                    // re-refresh must see the cooldown and never re-run.
                    let run_ctx = Arc::clone(&ctx);
                    tokio::spawn(async move {
                        // Declared first so a panic anywhere below unwinds
                        // through this guard (its Drop frees the flight
                        // slot); locals drop before the moved-in `tx`, so
                        // waiters only wake AFTER the slot is free again.
                        let mut guard = RefreshFlightGuard::new(&run_ctx.share);
                        let result = run_refresh(&run_ctx, deadline).await;
                        *run_ctx.share.last_refresh_completed.lock().unwrap() =
                            Some(Instant::now());
                        *run_ctx.share.refresh_flight.lock().unwrap() = None;
                        guard.disarm();
                        let _ = tx.send(Some(result));
                    });
                    rx
                }
            };
            loop {
                if let Some(wire) = rx.borrow().clone() {
                    return wire;
                }
                if rx.changed().await.is_err() {
                    // Only reachable if the collector's own run task vanished
                    // without completing (runtime teardown/panic — run_refresh
                    // never fails for data reasons).
                    return Err("refresh run vanished".to_string());
                }
            }
        })
    }

    fn set_active(&self, active: bool) {
        let mut cadence = self.ctx.share.cadence.lock().unwrap();
        if active {
            if cadence.is_some() {
                return; // idempotent
            }
            // ONE immediate fast tick (Node start() parity: a fresh
            // subscriber gets a shaped snapshot at once). Sync reader calls;
            // holding the cadence lock across them is safe (disjoint mutexes).
            self.ctx.tick_fast();
            let fast_ctx = Arc::clone(&self.ctx);
            let fast = tokio::spawn(async move {
                let mut ticker = tokio::time::interval(fast_ctx.cfg.fast);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                // setInterval never fires at t=0; the inline tick already ran.
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    fast_ctx.tick_fast();
                }
            });
            let slow_ctx = Arc::clone(&self.ctx);
            let slow = tokio::spawn(async move {
                let mut ticker = tokio::time::interval(slow_ctx.cfg.slow);
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    slow_ctx.tick_slow();
                }
            });
            let drift_ctx = Arc::clone(&self.ctx);
            let drift = tokio::spawn(async move {
                let interval = drift_ctx.cfg.drift_sample_interval;
                let mut last = Instant::now();
                loop {
                    tokio::time::sleep(interval).await;
                    let now = Instant::now();
                    let drift_ms = now.duration_since(last).as_secs_f64() * 1000.0
                        - interval.as_secs_f64() * 1000.0;
                    last = now;
                    if drift_ms.is_finite() && drift_ms > 0.0 {
                        drift_ctx.share.lag_samples.lock().unwrap().push(drift_ms);
                    }
                }
            });
            *cadence = Some(CadenceHandles { fast, slow, drift });
        } else if let Some(handles) = cadence.take() {
            handles.fast.abort();
            handles.slow.abort();
            handles.drift.abort();
        }
    }
}

// ---------------------------------------------------------------------------
// On-request refresh (manual sections)
// ---------------------------------------------------------------------------

/// Panic-safety for the collector-owned refresh run (Node parity: `service.ts`
/// wraps `runRefresh()` in `.finally(() => { pendingRefresh = null;
/// lastRefreshCompletedAt = nowFn() })`, which runs even when the run
/// THROWS). Constructed as the first statement of the spawned run — the
/// earliest point after the flight slot is occupied. If the run dies without
/// completing (a panic unwinds the spawned task), Drop frees the flight slot
/// and stamps the cooldown, so every later refresh() starts a FRESH run
/// instead of joining a dead channel forever. The manual cache is NEVER
/// touched here — a run that did not complete has no data to cache. A normal
/// completion stamps + clears explicitly (in the stamp-then-clear-then-send
/// order waiters rely on) and then disarms the guard.
struct RefreshFlightGuard<'a> {
    share: &'a Share,
    armed: bool,
}

impl<'a> RefreshFlightGuard<'a> {
    fn new(share: &'a Share) -> Self {
        Self { share, armed: true }
    }

    /// The run completed and already performed the finalize itself.
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RefreshFlightGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            // The run died mid-flight (panic-unwind): Node .finally parity —
            // free the slot AND stamp the cooldown. Never the manual cache.
            *self.share.last_refresh_completed.lock().unwrap() = Some(Instant::now());
            *self.share.refresh_flight.lock().unwrap() = None;
        }
    }
}

/// `(total_bytes, free_bytes, used_pct, inodes_total, inodes_free)`.
/// `free_bytes` is the unprivileged view (`bavail`); inodes are None when the
/// filesystem reports 0 total (some report 0/0 by design).
type StatfsInfo = (u64, u64, f64, Option<u64>, Option<u64>);

/// `fs.statfs` on a mount. Node `statfsInfo` parity; unix-only on this Rust path.
#[cfg(unix)]
fn statfs_info(mount: &str) -> Option<StatfsInfo> {
    let c_path = std::ffi::CString::new(mount).ok()?;
    let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(c_path.as_ptr(), &mut stats) } != 0 {
        return None;
    }
    let bsize = stats.f_bsize as u64;
    let blocks = stats.f_blocks as u64;
    let bavail = stats.f_bavail as u64;
    let files = stats.f_files as u64;
    let ffree = stats.f_ffree as u64;
    let total_bytes = bsize * blocks;
    let free_bytes = bsize * bavail;
    let used_pct = if blocks > 0 {
        (1.0 - bavail as f64 / blocks as f64) * 100.0
    } else {
        0.0
    };
    // inodes from files/ffree; some filesystems report 0/0 -> None
    let inodes_total = (files > 0).then_some(files);
    let inodes_free = (files > 0).then_some(ffree);
    Some((total_bytes, free_bytes, used_pct, inodes_total, inodes_free))
}

#[cfg(not(unix))]
fn statfs_info(_mount: &str) -> Option<StatfsInfo> {
    None
}

/// How the scan arm resolves (drives BOTH `topProcesses` and
/// `processHealth`, mirroring the Node sections' shared scan promise).
enum ScanOutcome {
    Completed(Option<ProcessTableScan>),
    /// Cooperative per-pid deadline tripped (Node DeadlineExceeded).
    SectionDeadline,
    /// Overall watchdog preempted a still-running scan.
    Watchdog,
}

/// Node's overall-watchdog section-error payload (the `DeadlineExceeded`
/// message in `service.ts` runRefresh's watchdog promise).
const REFRESH_WATCHDOG_MSG: &str = "host-stats refresh overall budget exceeded";

/// The overall-watchdog verdict for a non-scan refresh section arm (Node
/// `Promise.race([section.run(), watchdog])` settling with the watchdog):
/// the section keeps its zero-shape and gains the watchdog sectionErrors
/// entry. The entry check and a mid-flight timeout are the same race.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SectionWatchdogFired;

/// Race one refresh section arm against the overall watchdog. Sync-reader
/// arms never yield, so a plain `timeout_at` wrapper's immediately-ready
/// inner future would win the race even against an ALREADY-exhausted
/// deadline (tokio observes an expired timer on a driver turn, which an
/// instant section beats). Check the clock at arm ENTRY: a section whose
/// turn comes after the watchdog fired (its first poll was delayed past the
/// budget, e.g. by an earlier arm's sync work on the same executor task)
/// degrades WITHOUT running its reads — exactly how a section's race
/// settles in Node when the watchdog promise has already rejected. The
/// `timeout_at` wrapper still covers a section that runs past the budget.
async fn race_section_watchdog<T>(
    overall_deadline: tokio::time::Instant,
    work: impl std::future::Future<Output = T>,
) -> Result<T, SectionWatchdogFired> {
    match tokio::time::timeout_at(overall_deadline, async {
        if tokio::time::Instant::now() >= overall_deadline {
            None
        } else {
            Some(work.await)
        }
    })
    .await
    {
        Ok(Some(value)) => Ok(value),
        Ok(None) | Err(_) => Err(SectionWatchdogFired),
    }
}

/// One refresh run: sections race under a shared absolute cooperative
/// deadline (`started + deadline`, the trait argument — Node
/// `sectionBudgetMs`) and EVERY section arm races the overall watchdog
/// (`started + overall_budget`, Node `overallBudgetMs`). Never fails for
/// data reasons.
async fn run_refresh(ctx: &Arc<CollectorCtx>, deadline: Duration) -> RefreshWire {
    let started = Instant::now();
    let section_deadline = started + deadline;
    let overall_deadline = tokio::time::Instant::from_std(started + ctx.cfg.overall_budget);

    let scan_ctx = Arc::clone(ctx);
    let scan_fut = async move {
        scan_ctx.scan_runs.fetch_add(1, Ordering::SeqCst);
        #[cfg(test)]
        if scan_ctx.test_run_panic.swap(false, Ordering::SeqCst) {
            // Test-injected run death: the run task unwinds from here —
            // no completion stamp, no slot clear, no cache write, no send.
            panic!("test-injected refresh run death");
        }
        match tokio::time::timeout_at(
            overall_deadline,
            scan_process_table(&scan_ctx.cfg.proc_root, PROC_SCAN_DWELL, section_deadline),
        )
        .await
        {
            Ok(Ok(scan)) => ScanOutcome::Completed(scan),
            Ok(Err(ScanError::DeadlineExceeded)) => ScanOutcome::SectionDeadline,
            Err(_elapsed) => ScanOutcome::Watchdog,
        }
    };
    let inotify_ctx = Arc::clone(ctx);
    let inotify_fut = async move {
        let work = async move {
            let usage = readers::read_self_inotify_stats(&inotify_ctx.cfg.proc_root);
            let limits = readers::read_inotify_limits(&inotify_ctx.cfg.proc_root);
            (usage, limits)
        };
        race_section_watchdog(overall_deadline, work).await
    };
    let disks_fut = async move {
        let work = async move {
            // Node: darwin mounts ['/'], else ['/', '/dev/shm'].
            let mounts: &[&str] = if cfg!(target_os = "macos") {
                &["/"]
            } else if cfg!(target_os = "windows") {
                &[]
            } else {
                &["/", "/dev/shm"]
            };
            let mut list = Vec::new();
            for mount in mounts {
                if let Some((total_bytes, free_bytes, used_pct, inodes_total, inodes_free)) =
                    statfs_info(mount)
                {
                    list.push(HostStatsDisk {
                        mount: mount.to_string(),
                        total_bytes,
                        free_bytes,
                        used_pct,
                        inodes_total,
                        inodes_free,
                    });
                }
            }
            list
        };
        race_section_watchdog(overall_deadline, work).await
    };
    let thermals_ctx = Arc::clone(ctx);
    let thermals_fut = async move {
        let work = async move {
            let zones = readers::read_thermals(&thermals_ctx.cfg.sys_root);
            let battery = readers::read_battery(&thermals_ctx.cfg.sys_root);
            (zones, battery)
        };
        race_section_watchdog(overall_deadline, work).await
    };

    let (scan_out, inotify_out, disks_out, thermals_out) =
        tokio::join!(scan_fut, inotify_fut, disks_fut, thermals_fut);

    let mut manual = zero_manual();
    let mut section_errors = HashMap::new();

    match scan_out {
        ScanOutcome::Completed(Some(scan)) => {
            manual.top_processes = HostStatsTopProcesses {
                available: true,
                dwell_ms: PROC_SCAN_DWELL.as_millis() as u64,
                list: scan
                    .top
                    .into_iter()
                    .map(|p| HostStatsTopProcess {
                        pid: p.pid,
                        name: p.name,
                        cpu_pct: p.cpu_pct,
                        rss_bytes: p.rss_bytes,
                        state: p.state,
                    })
                    .collect(),
            };
            manual.process_health = HostStatsProcessHealth {
                available: true,
                zombies: scan.zombies,
                d_state: scan.d_state,
                total: scan.total,
            };
        }
        ScanOutcome::Completed(None) => {
            // Missing proc root: degraded WITHOUT an error entry (Node parity:
            // `if (!table) return zeroManualSection(key)`).
        }
        ScanOutcome::SectionDeadline => {
            section_errors.insert(
                "topProcesses".to_string(),
                ScanError::DeadlineExceeded.message().to_string(),
            );
            section_errors.insert(
                "processHealth".to_string(),
                ScanError::DeadlineExceeded.message().to_string(),
            );
        }
        ScanOutcome::Watchdog => {
            let msg = REFRESH_WATCHDOG_MSG.to_string();
            section_errors.insert("topProcesses".to_string(), msg.clone());
            section_errors.insert("processHealth".to_string(), msg);
        }
    }

    // A watchdog-losing non-scan section keeps the zero-shape already in
    // place (zero_manual) and adds ONLY the sectionErrors entry — the same
    // degradation Node's race produces for that key.
    match inotify_out {
        Ok((usage, limits)) => {
            if usage.is_some() || limits.is_some() {
                manual.inotify = HostStatsInotify {
                    available: true,
                    instances: usage.map(|u| u.instances),
                    watches: usage.map(|u| u.watches),
                    max_user_watches: limits.and_then(|l| l.max_user_watches),
                    max_user_instances: limits.and_then(|l| l.max_user_instances),
                };
            }
        }
        Err(SectionWatchdogFired) => {
            section_errors.insert("inotify".to_string(), REFRESH_WATCHDOG_MSG.to_string());
        }
    }

    match disks_out {
        Ok(disk_list) => {
            if !disk_list.is_empty() {
                manual.disks = HostStatsDisks {
                    available: true,
                    list: disk_list,
                };
            }
        }
        Err(SectionWatchdogFired) => {
            section_errors.insert("disks".to_string(), REFRESH_WATCHDOG_MSG.to_string());
        }
    }

    match thermals_out {
        Ok((zones, battery)) => {
            if let Some(zones) = zones {
                manual.thermals = HostStatsThermals {
                    available: true,
                    zones: zones
                        .into_iter()
                        .map(|z| HostStatsThermalZone {
                            label: z.label,
                            celsius: z.celsius,
                        })
                        .collect(),
                    battery: battery.map(|b| HostStatsBattery {
                        pct: b.pct,
                        status: b.status,
                    }),
                };
            }
        }
        Err(SectionWatchdogFired) => {
            section_errors.insert("thermals".to_string(), REFRESH_WATCHDOG_MSG.to_string());
        }
    }

    manual.section_errors = section_errors;
    let at = now_ms();
    *ctx.share.manual.lock().unwrap() = Some((at, manual.clone()));
    // Merged snapshot: live may be one tick stale, manual/manualAt are fresh
    // (contract point 9) — and subscribers see it (Node emitSnapshot).
    ctx.deliver_snapshot();
    Ok(HostStatsRefreshOk { at, manual })
}

// ---------------------------------------------------------------------------
// On-request process-table scan (the ONLY async reader family; the dwell is
// why the pure `/proc/<pid>` parsers live in freshell-platform but this loop
// lives here — freshell-platform is deliberately tokio-free)
// ---------------------------------------------------------------------------

/// A scanned process row (mirrors Node's `ProcessSample`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessSampleR {
    pub pid: u64,
    pub name: String,
    pub cpu_pct: f64,
    pub rss_bytes: u64,
    pub state: String,
}

/// The scan outcome (mirrors Node's `ProcessTableScan`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProcessTableScan {
    pub top: Vec<ProcessSampleR>,
    pub zombies: u64,
    pub d_state: u64,
    pub total: u64,
}

/// The scan's only sanctioned failure (Node `DeadlineExceeded`): the shared
/// absolute section budget was exhausted mid-scan. All other failures
/// (missing root, vanished pid, truncated stat) degrade to `Ok(None)` /
/// per-pid skips.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScanError {
    DeadlineExceeded,
}

impl ScanError {
    /// The exact Node `DeadlineExceeded` section-error message
    /// (`sectionErrors[key]` payload parity).
    pub fn message(&self) -> &'static str {
        "host-stats section deadline exceeded"
    }
}

/// On-request process table scan: enumerate numeric `<proc_root>` dirs (cap
/// 100k), sample utime+stime (A), dwell, sample again (B) + status VmRSS;
/// cpuPct from the jiffy delta. `deadline` is an ABSOLUTE monotonic budget
/// (the section's cooperative deadline), checked BEFORE each pid's unit of
/// work; on expiry this returns `Err(ScanError::DeadlineExceeded)`.
async fn scan_process_table(
    proc_root: &std::path::Path,
    dwell: Duration,
    deadline: Instant,
) -> Result<Option<ProcessTableScan>, ScanError> {
    let Some(pids) = readers::list_numeric_pids(proc_root) else {
        return Ok(None);
    };
    // total = numeric /proc entries discovered (enumeration truth),
    // independent of per-pid parse health.
    let total = pids.len() as u64;
    let mut sample_a: HashMap<u64, readers::ProcPidStat> = HashMap::new();
    let mut zombies = 0u64;
    let mut d_state = 0u64;
    for pid in &pids {
        if Instant::now() > deadline {
            return Err(ScanError::DeadlineExceeded);
        }
        // truncated/vanished -> process skipped, never thrown
        let Some(text) = readers::read_pid_file_bounded(proc_root, *pid, "stat") else {
            continue;
        };
        let Some(parsed) = readers::parse_proc_pid_stat(&text) else {
            continue;
        };
        if parsed.state == "Z" {
            zombies += 1;
        }
        if parsed.state == "D" {
            d_state += 1;
        }
        sample_a.insert(*pid, parsed);
    }

    tokio::time::sleep(dwell).await;

    let cores = std::thread::available_parallelism()
        .map(|n| n.get() as u64)
        .unwrap_or(1);
    let mut top: Vec<ProcessSampleR> = Vec::new();
    for (pid, before) in &sample_a {
        if Instant::now() > deadline {
            return Err(ScanError::DeadlineExceeded);
        }
        let Some(stat_text) = readers::read_pid_file_bounded(proc_root, *pid, "stat") else {
            continue;
        };
        let Some(after) = readers::parse_proc_pid_stat(&stat_text) else {
            continue;
        };
        let rss_kb = readers::read_pid_file_bounded(proc_root, *pid, "status")
            .and_then(|text| readers::parse_status_vm_rss_kb(&text));
        top.push(ProcessSampleR {
            pid: *pid,
            name: after.name,
            cpu_pct: readers::compute_cpu_pct(
                after.busy_jiffies as f64 - before.busy_jiffies as f64,
                dwell.as_millis() as u64,
                cores,
            ),
            rss_bytes: rss_kb.unwrap_or(0) * 1024,
            state: after.state,
        });
    }
    top.sort_by(|a, b| {
        b.cpu_pct
            .partial_cmp(&a.cpu_pct)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    top.truncate(TOP_PROCESS_COUNT);
    Ok(Some(ProcessTableScan {
        top,
        zombies,
        d_state,
        total,
    }))
}

// ---------------------------------------------------------------------------
// Zero shapes (mirror of the Node LIVE_SECTION_ZERO / zeroManualSection tree;
// every degraded section reports `available:false` with the SAME otherwise-
// zero payload, so the client renders the em-dash family)
// ---------------------------------------------------------------------------

fn zero_cpu() -> HostStatsCpu {
    HostStatsCpu {
        available: false,
        usage_pct: 0.0,
        steal_pct: None,
        per_core_pct: Vec::new(),
        freq_m_hz: None,
    }
}

fn zero_load(cores: u64) -> HostStatsLoad {
    HostStatsLoad {
        available: false,
        load1: 0.0,
        load5: 0.0,
        load15: 0.0,
        cores,
    }
}

fn zero_memory() -> HostStatsMemory {
    HostStatsMemory {
        available: false,
        source: "host".to_string(),
        total_bytes: 0,
        used_bytes: 0,
        available_bytes: 0,
        cgroup_limit_bytes: None,
        swap_total_bytes: None,
        swap_used_bytes: None,
    }
}

fn zero_paging() -> HostStatsPaging {
    HostStatsPaging {
        available: false,
        swap_in_kbps: 0.0,
        swap_out_kbps: 0.0,
        maj_faults_per_sec: 0.0,
        oom_kills_delta: 0,
        oom_kills_total: 0,
    }
}

fn zero_psi() -> HostStatsPsi {
    HostStatsPsi {
        available: false,
        cpu_some10: None,
        mem_some10: None,
        mem_full10: None,
        io_some10: None,
        io_full10: None,
    }
}

fn zero_disk_io() -> HostStatsDiskIo {
    HostStatsDiskIo {
        available: false,
        read_bps: 0.0,
        write_bps: 0.0,
        util_pct: None,
        weighted_await_ms: None,
    }
}

fn zero_network() -> HostStatsNetwork {
    HostStatsNetwork {
        available: false,
        rx_bps: 0.0,
        tx_bps: 0.0,
        rx_errors_total: 0,
        tx_errors_total: 0,
        rx_dropped_total: 0,
        tx_dropped_total: 0,
        rx_errors_delta: 0,
        tx_errors_delta: 0,
        rx_dropped_delta: 0,
        tx_dropped_delta: 0,
    }
}

fn zero_limits() -> HostStatsLimits {
    HostStatsLimits {
        available: false,
        fds_used: None,
        fds_max: None,
        pids_used: None,
        pids_max: None,
        time_wait: None,
        ephemeral_ports: None,
    }
}

fn zero_freshell() -> HostStatsFreshell {
    HostStatsFreshell {
        available: false,
        source: "rust".to_string(),
        ptys_running: 0,
        // LB9 (frozen): freshell-ws has NO connection cap and the Rust spawn
        // gate is a concurrency gate, not a PTY-count cap — both maxes are 0
        // (client renders '—').
        ptys_max: 0,
        ws_clients: 0,
        ws_clients_max: 0,
        event_loop_lag_p99_ms: None,
        rss_bytes: None,
        uptime_sec: 0.0,
    }
}

fn zero_live(machine: &HostStatsMachine) -> HostStatsLive {
    HostStatsLive {
        machine: machine.clone(),
        cpu: zero_cpu(),
        load: zero_load(machine.cores),
        memory: zero_memory(),
        paging: zero_paging(),
        psi: zero_psi(),
        disk_io: zero_disk_io(),
        network: zero_network(),
        limits: zero_limits(),
        freshell: zero_freshell(),
    }
}

fn zero_manual() -> HostStatsManual {
    HostStatsManual {
        top_processes: HostStatsTopProcesses {
            available: false,
            dwell_ms: 0,
            list: Vec::new(),
        },
        process_health: HostStatsProcessHealth {
            available: false,
            zombies: 0,
            d_state: 0,
            total: 0,
        },
        inotify: HostStatsInotify {
            available: false,
            instances: None,
            watches: None,
            max_user_watches: None,
            max_user_instances: None,
        },
        disks: HostStatsDisks {
            available: false,
            list: Vec::new(),
        },
        thermals: HostStatsThermals {
            available: false,
            zones: Vec::new(),
            battery: None,
        },
        section_errors: HashMap::new(),
    }
}

// ===========================================================================
// Task 9 behavioral tests. These call the REAL production surface (they were
// authored RED-first against the compiling skeleton — runtime assertion
// failures/`unimplemented!()` panics, never compile errors). Fixture bytes are
// the intentional duplication of `test/fixtures/host-stats/` (plan step 5:
// ports drift independently).
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use freshell_platform::host_stats_readers as readers;
    use freshell_protocol::{HostStatsBattery, ServerMessage};
    use freshell_terminal::FrameSink;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex as StdMutex;

    fn fixtures() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/host-stats")
    }
    fn proc_fixture() -> PathBuf {
        fixtures().join("proc")
    }
    fn procmini_fixture() -> PathBuf {
        fixtures().join("procmini")
    }
    fn sys_fixture() -> PathBuf {
        fixtures().join("sys")
    }
    fn cgroup_fixture() -> PathBuf {
        sys_fixture().join("fs").join("cgroup")
    }
    fn missing() -> PathBuf {
        fixtures().join("never-existed")
    }

    fn test_config(proc_root: PathBuf, sys_root: PathBuf) -> HostStatsCollectorConfig {
        HostStatsCollectorConfig {
            proc_root,
            sys_root,
            fast: Duration::from_millis(25),
            slow: Duration::from_millis(50),
            ..Default::default()
        }
    }

    fn test_collector(
        proc_root: PathBuf,
        sys_root: PathBuf,
        interest: &HostStatsInterestRegistry,
    ) -> HostStatsCollectorService {
        HostStatsCollectorService::new(
            test_config(proc_root, sys_root),
            freshell_terminal::TerminalRegistry::new(),
            interest.clone(),
            Instant::now(),
        )
    }

    async fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) -> bool {
        let start = Instant::now();
        loop {
            if predicate() {
                return true;
            }
            if start.elapsed() >= timeout {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Copy a fixture tree into a fresh tmpdir (the process-scan overlay then
    /// adds a truncated-stat pid). Mirrors the Node suite's beforeAll tmp
    /// overlays (symlinks/empty dirs cannot be committed to git).
    fn copy_tree(src: &Path, dst: &Path) {
        std::fs::create_dir_all(dst).unwrap();
        for entry in std::fs::read_dir(src).unwrap() {
            let entry = entry.unwrap();
            let to = dst.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy_tree(&entry.path(), &to);
            } else {
                std::fs::copy(entry.path(), &to).unwrap();
            }
        }
    }

    fn scan_proc_overlay(tmp: &Path) -> PathBuf {
        let scan = tmp.join("scan-proc");
        copy_tree(&procmini_fixture(), &scan);
        let broken = scan.join("999");
        std::fs::create_dir_all(&broken).unwrap();
        std::fs::write(broken.join("stat"), "999 (broken").unwrap();
        std::fs::write(
            broken.join("status"),
            "Name:\tbroken\nVmRSS:\t       1234 kB\n",
        )
        .unwrap();
        scan
    }

    // -----------------------------------------------------------------
    // Fixture readers (Task 2 semantics pinned against the duplicated
    // fixture bytes — Node suite: test/unit/server/host-stats/readers.test.ts)
    // -----------------------------------------------------------------

    #[test]
    fn host_stats_fixture_cpu_times_parse_exact() {
        let times = readers::read_cpu_times(&proc_fixture()).expect("fixture stat parses");
        assert_eq!(times.total, 174236.0);
        assert_eq!(times.busy, 7885.0);
        assert_eq!(times.steal, 777.0); // steal>0 is a fixture requirement
        assert_eq!(times.per_core.len(), 16);
        assert_eq!(
            times.per_core[0],
            readers::CpuCoreTimes {
                total: 10645.0,
                busy: 495.0
            }
        );
        assert!(readers::read_cpu_times(&missing()).is_none());
    }

    #[test]
    fn host_stats_fixture_load_meminfo_vmstat_psi_parse_exact() {
        let load = readers::read_loadavg(&proc_fixture()).expect("loadavg");
        assert_eq!(
            load,
            readers::LoadAvg {
                load1: 0.5,
                load5: 1.0,
                load15: 1.2
            }
        );
        let mem = readers::read_meminfo(&proc_fixture()).expect("meminfo");
        assert_eq!(
            mem,
            readers::MeminfoKb {
                total_kb: 67108864,
                avail_kb: 33554432,
                swap_total_kb: 8388608,
                swap_free_kb: 7340032,
            }
        );
        let vm = readers::read_vmstat(&proc_fixture()).expect("vmstat");
        assert_eq!(vm.pswpin, 1234);
        assert_eq!(vm.pswpout, 5678);
        assert_eq!(vm.pgmajfault, 890);
        assert_eq!(vm.oom_kill, Some(3));
        let psi = readers::read_psi(&proc_fixture()).expect("psi");
        assert_eq!(psi.cpu_some10, Some(1.23));
        assert_eq!(psi.mem_some10, Some(0.5));
        assert_eq!(psi.mem_full10, Some(0.3));
        assert_eq!(psi.io_some10, Some(2.5));
        assert_eq!(psi.io_full10, Some(1.0));
        // procmini has no pressure/ dir -> PSI absent (not per-file nulls).
        assert!(readers::read_psi(&procmini_fixture()).is_none());
    }

    #[test]
    fn host_stats_fixture_cgroup_memory_leaf_resolution() {
        // Committed v2 leaf: memory.max = 'max' (freshell itself runs in an
        // unlimited cgroup) -> limit None.
        let leaf = readers::read_cgroup_memory(&cgroup_fixture(), &procmini_fixture())
            .expect("v2 leaf resolves");
        assert_eq!(leaf.limit_bytes, None);
        assert_eq!(leaf.current_bytes, 17000000000);
        // The cgroup fs root has NO limit files by design: a cgroup root that
        // lacks the leaf tree must NOT fall back to reading the fs root.
        let empty = tempfile::tempdir().unwrap();
        assert!(readers::read_cgroup_memory(empty.path(), &procmini_fixture()).is_none());
        // self/cgroup absent -> None (never a panic).
        assert!(readers::read_cgroup_memory(&cgroup_fixture(), &missing()).is_none());
    }

    #[test]
    fn host_stats_fixture_pids_limit_cgroup_then_threads_max() {
        // v2 leaf pids.max wins outright.
        assert_eq!(
            readers::read_pids_limit(&procmini_fixture(), &cgroup_fixture()),
            Some(10854)
        );
        // No self/cgroup (full proc fixture) -> threads-max fallback.
        assert_eq!(
            readers::read_pids_limit(&proc_fixture(), &cgroup_fixture()),
            Some(123456)
        );
        // pid_max is a wrap boundary, NEVER the cap.
        let tmp = tempfile::tempdir().unwrap();
        let pid_max_only = tmp.path().join("pid-max-only").join("proc");
        std::fs::create_dir_all(pid_max_only.join("sys/kernel")).unwrap();
        std::fs::write(pid_max_only.join("sys/kernel/pid_max"), "4194304\n").unwrap();
        assert_eq!(
            readers::read_pids_limit(&pid_max_only, &cgroup_fixture()),
            None
        );
    }

    #[test]
    fn host_stats_fixture_disk_net_tcp_limits_parse_exact() {
        let disks = readers::read_disk_stats(&proc_fixture()).expect("diskstats");
        // Whole devices only: partitions and loop devices are filtered out.
        assert!(disks.contains_key("sda"));
        assert!(disks.contains_key("nvme0n1"));
        assert!(!disks.contains_key("sda1"));
        assert!(!disks.contains_key("nvme0n1p1"));
        assert!(!disks.contains_key("loop0"));
        let sda = disks.get("sda").unwrap();
        assert_eq!(
            *sda,
            readers::DiskCounters {
                reads_completed: 5000,
                read_ms: 6000,
                writes_completed: 2000,
                write_ms: 3000,
                read_sectors: 400000,
                written_sectors: 200000,
                time_doing_ios_ms: 4000,
            }
        );
        let net = readers::read_net_dev(&proc_fixture()).expect("net/dev");
        assert_eq!(
            net,
            readers::NetDevTotals {
                rx_bytes: 7000000,
                tx_bytes: 11000000,
                rx_err: 9,
                tx_err: 16,
                rx_drop: 4,
                tx_drop: 6,
            }
        );
        let tcp = readers::read_tcp_state_counts(&proc_fixture()).expect("tcp counts");
        assert_eq!(tcp.time_wait, 3);
        let ports = readers::read_ephemeral_port_range(&proc_fixture()).expect("port range");
        assert_eq!((ports.start, ports.end), (32768, 60999));
        assert_eq!(
            readers::read_self_limits_fds_max(&proc_fixture()),
            Some(1024)
        );
        let inotify = readers::read_inotify_limits(&proc_fixture()).expect("inotify limits");
        assert_eq!(inotify.max_user_watches, Some(1048576));
        assert_eq!(inotify.max_user_instances, Some(128));
        assert_eq!(readers::read_pid_count(&procmini_fixture()), Some(7));
    }

    #[test]
    fn host_stats_fixture_sysfs_sensors_parse_exact() {
        assert_eq!(readers::read_cpu_freq_mhz(&sys_fixture()), Some(3100.0));
        let zones = readers::read_thermals(&sys_fixture()).expect("thermal zones");
        assert_eq!(zones.len(), 1);
        assert_eq!(zones[0].label, "x86_pkg_temp");
        assert_eq!(zones[0].celsius, 51.5);
        let battery = readers::read_battery(&sys_fixture()).expect("battery");
        assert_eq!(battery.pct, 87.0);
        assert_eq!(battery.status, "Discharging");
        assert!(readers::read_thermals(&missing()).is_none());
        assert!(readers::read_battery(&missing()).is_none());
    }

    #[test]
    fn host_stats_fixture_machine_info_probes() {
        let info = readers::read_machine_info(&procmini_fixture(), &sys_fixture());
        assert_eq!(info.cgroup, "v2");
        assert!(!info.psi); // procmini has no pressure/ dir
        assert_eq!(info.thermal_count, 1);
        assert!(info.battery_present);
        assert_eq!(info.gpu, "none");
        assert!(info.cores >= 1);
        // Full proc fixture: psi readable, no self/cgroup -> 'none'.
        let full = readers::read_machine_info(&proc_fixture(), &sys_fixture());
        assert!(full.psi);
        assert_eq!(full.cgroup, "none");
    }

    #[cfg(unix)]
    #[test]
    fn host_stats_fixture_inotify_self_stats_readlink_counting() {
        // fd readlink fixtures are REAL symlinks built in tmpdir (git cannot
        // commit dangling symlinks) — the Node suite's exact overlay.
        let tmp = tempfile::tempdir().unwrap();
        let fd_proc = tmp.path().join("fd-proc");
        std::fs::create_dir_all(fd_proc.join("self/fd")).unwrap();
        std::fs::create_dir_all(fd_proc.join("self/fdinfo")).unwrap();
        for fd in [3, 4, 5] {
            std::os::unix::fs::symlink(
                "anon_inode:inotify",
                fd_proc.join("self/fd").join(fd.to_string()),
            )
            .unwrap();
            std::fs::copy(
                proc_fixture().join("self/fdinfo").join(fd.to_string()),
                fd_proc.join("self/fdinfo").join(fd.to_string()),
            )
            .unwrap();
        }
        std::os::unix::fs::symlink("socket:[12345]", fd_proc.join("self/fd/6")).unwrap();
        std::os::unix::fs::symlink("pipe:[67890]", fd_proc.join("self/fd/7")).unwrap();
        std::os::unix::fs::symlink("/dev/null", fd_proc.join("self/fd/8")).unwrap();
        assert_eq!(readers::read_self_fd_count(&fd_proc), Some(6));
        let usage = readers::read_self_inotify_stats(&fd_proc).expect("inotify usage");
        assert_eq!(usage.instances, 3);
        assert_eq!(usage.watches, 6); // fdinfo 3/4/5 carry 2/3/1 inotify lines
    }

    // -----------------------------------------------------------------
    // Process-table scan (the collector-owned two-sample + dwell loop over
    // the platform's pure pieces)
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn host_stats_scan_fixture_table_counts_and_names() {
        let tmp = tempfile::tempdir().unwrap();
        let scan_root = scan_proc_overlay(tmp.path());
        let scan = scan_process_table(
            &scan_root,
            Duration::from_millis(50),
            Instant::now() + Duration::from_secs(10),
        )
        .await
        .expect("fixture scan resolves")
        .expect("no deadline");
        // 8 numeric entries enumerated (7 committed + truncated 999).
        assert_eq!(scan.total, 8);
        assert_eq!(scan.zombies, 1);
        assert_eq!(scan.d_state, 1);
        // truncated-stat pid 999 is skipped, never fatal.
        assert_eq!(scan.top.len(), 7);
        assert!(scan.top.iter().all(|p| p.pid != 999));
        let by_pid: HashMap<u64, &ProcessSampleR> = scan.top.iter().map(|p| (p.pid, p)).collect();
        // comm-with-parens splits after the LAST ')'.
        assert_eq!(by_pid[&404].name, "my (weird) proc");
        assert_eq!(by_pid[&404].state, "D");
        assert_eq!(by_pid[&505].state, "Z");
        // rssBytes from status VmRSS kB -> bytes, NOT stat rss pages.
        assert_eq!(by_pid[&101].rss_bytes, 12345 * 1024);
        // static fixture: sample A == sample B -> zero cpu deltas.
        assert!(scan.top.iter().all(|p| p.cpu_pct == 0.0));
    }

    #[tokio::test]
    async fn host_stats_scan_deadline_exceeded_is_an_error_never_a_panic() {
        let tmp = tempfile::tempdir().unwrap();
        let scan_root = scan_proc_overlay(tmp.path());
        let result = scan_process_table(
            &scan_root,
            Duration::ZERO,
            Instant::now() - Duration::from_secs(1),
        )
        .await;
        assert!(matches!(result, Err(ScanError::DeadlineExceeded)));
        // Missing proc root -> None (degraded), never an error.
        let missing_result = scan_process_table(
            &missing(),
            Duration::ZERO,
            Instant::now() + Duration::from_secs(10),
        )
        .await;
        assert!(matches!(missing_result, Ok(None)));
    }

    // -----------------------------------------------------------------
    // Lifecycle (parity test 1): set_active spawns/aborts the cadence
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn host_stats_set_active_spawn_abort_lifecycle() {
        let interest = HostStatsInterestRegistry::default();
        let collector = test_collector(proc_fixture(), sys_fixture(), &interest);
        assert!(
            !collector.is_running(),
            "zero-cost idle before first interest"
        );
        collector.set_active(true);
        assert!(collector.is_running(), "0->1 interest spawns the cadence");
        collector.set_active(true);
        assert!(collector.is_running(), "idempotent re-activate is harmless");
        collector.set_active(false);
        assert!(!collector.is_running(), "1->0 interest aborts the cadence");
        collector.set_active(false);
        assert!(!collector.is_running(), "idempotent deactivate is harmless");
        // Restart resumes ticking.
        collector.set_active(true);
        assert!(collector.is_running());
        collector.set_active(false);
    }

    #[test]
    fn host_stats_snapshot_zero_shape_before_first_tick() {
        let interest = HostStatsInterestRegistry::default();
        let collector = test_collector(proc_fixture(), sys_fixture(), &interest);
        let snap = collector.snapshot();
        assert!(snap.at > 0);
        assert!(snap.manual_at.is_none());
        assert!(snap.manual.is_none());
        // machine filled from cheap probes, every section unavailable.
        assert_eq!(snap.live.machine.thermal_count, 1);
        assert!(!snap.live.cpu.available);
        assert!(!snap.live.load.available);
        assert!(!snap.live.memory.available);
        assert!(!snap.live.paging.available);
        assert!(!snap.live.psi.available);
        assert!(!snap.live.disk_io.available);
        assert!(!snap.live.network.available);
        assert!(!snap.live.limits.available);
        assert!(!snap.live.freshell.available);
        // LB9 frozen: no caps exist on the Rust side — 0 renders '—'.
        assert_eq!(snap.live.freshell.ws_clients_max, 0);
        assert_eq!(snap.live.freshell.ptys_max, 0);
    }

    #[tokio::test]
    async fn host_stats_set_active_runs_one_immediate_fast_tick() {
        // A fresh subscriber gets a SHAPED snapshot at once (Node start()
        // parity): after set_active(true) returns, the live cache holds the
        // first tick's null-safe zeros — no wall-clock wait needed.
        let interest = HostStatsInterestRegistry::default();
        let collector = test_collector(proc_fixture(), sys_fixture(), &interest);
        collector.set_active(true);
        let live = &collector.snapshot().live;
        assert!(live.cpu.available, "first fast tick ran inline");
        assert_eq!(live.cpu.usage_pct, 0.0, "first tick has no delta window");
        assert_eq!(live.cpu.per_core_pct.len(), 16);
        assert!(live.load.available);
        assert_eq!(live.load.load1, 0.5);
        // Memory precedence: no cgroup for the full proc fixture -> host.
        assert!(live.memory.available);
        assert_eq!(live.memory.source, "host");
        assert_eq!(live.memory.total_bytes, 67108864 * 1024);
        assert!(live.paging.available);
        assert_eq!(live.paging.oom_kills_total, 3);
        assert!(live.psi.available);
        assert_eq!(live.psi.cpu_some10, Some(1.23));
        // freshell internals on the first fast tick.
        assert!(live.freshell.available);
        assert_eq!(live.freshell.source, "rust");
        assert_eq!(live.freshell.ws_clients_max, 0);
        assert_eq!(live.freshell.ptys_max, 0);
        assert!(live.freshell.uptime_sec >= 0.0);
        // Slow-tier sections are STILL zero: the slow tier only ticks on its
        // own interval (Node parity).
        assert!(!live.disk_io.available);
        assert!(!live.limits.available);
        collector.set_active(false);
    }

    #[tokio::test]
    async fn host_stats_cadence_delivers_to_subscribed_conns_only() {
        // Frozen delivery contract: snapshots flow ONLY to subscribed
        // connections via their per-connection senders — never broadcast_tx.
        let interest = HostStatsInterestRegistry::default();
        let delivered = Arc::new(StdMutex::new(Vec::<ServerMessage>::new()));
        let not_watching = Arc::new(StdMutex::new(Vec::<ServerMessage>::new()));
        let watcher_sink: FrameSink = {
            let delivered = Arc::clone(&delivered);
            Arc::new(move |msg| delivered.lock().unwrap().push(msg))
        };
        let bystander_sink: FrameSink = {
            let not_watching = Arc::clone(&not_watching);
            Arc::new(move |msg| not_watching.lock().unwrap().push(msg))
        };
        let collector = test_collector(proc_fixture(), sys_fixture(), &interest);
        assert_eq!(
            interest.set(1, Some(watcher_sink)),
            freshell_ws::host_stats_interest::InterestTransition::BecameActive
        );
        collector.set_active(true);
        let got = wait_until(Duration::from_millis(500), || {
            !delivered.lock().unwrap().is_empty()
        })
        .await;
        collector.set_active(false);
        assert!(got, "a subscribed connection receives cadence snapshots");
        {
            let frames = delivered.lock().unwrap();
            let first = serde_json::to_value(&frames[0]).unwrap();
            assert_eq!(first["type"], "hoststats.snapshot");
            assert_eq!(first["live"]["freshell"]["source"], "rust");
            assert_eq!(first["live"]["freshell"]["wsClientsMax"], 0);
            assert_eq!(first["live"]["freshell"]["ptysMax"], 0);
            assert_eq!(first["live"]["memory"]["source"], "host");
        }
        // A connection that never subscribed is never touched. (The sink is
        // kept alive so the assertion above isn't vacuous.)
        let _ = bystander_sink;
        assert!(
            not_watching.lock().unwrap().is_empty(),
            "non-watchers get zero traffic"
        );
        // After ->0 interest (abort), no further snapshots arrive.
        let count_at_stop = delivered.lock().unwrap().len();
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(delivered.lock().unwrap().len(), count_at_stop);
    }

    // -----------------------------------------------------------------
    // refresh(): single-flight, post-completion cooldown, cooperative budget
    // -----------------------------------------------------------------

    #[tokio::test]
    async fn host_stats_refresh_is_single_flight() {
        let tmp = tempfile::tempdir().unwrap();
        let scan_root = scan_proc_overlay(tmp.path());
        let interest = HostStatsInterestRegistry::default();
        let collector = test_collector(scan_root, sys_fixture(), &interest);
        let (one, two) = tokio::join!(
            collector.refresh(Duration::from_millis(2000)),
            collector.refresh(Duration::from_millis(2000))
        );
        let one = one.expect("leader refresh succeeds");
        let two = two.expect("joiner refresh succeeds");
        assert_eq!(
            collector.scan_run_count(),
            1,
            "one scan serves both callers"
        );
        assert_eq!(one, two, "the joiner gets the leader's exact result");
        // The fixture scan powered both process sections.
        assert!(one.manual.top_processes.available);
        assert_eq!(one.manual.top_processes.list.len(), 7);
        assert!(one.manual.process_health.available);
        assert_eq!(one.manual.process_health.zombies, 1);
        assert_eq!(one.manual.process_health.d_state, 1);
        assert_eq!(one.manual.process_health.total, 8);
        // thermals from the injected sys root.
        assert!(one.manual.thermals.available);
        assert_eq!(one.manual.thermals.zones[0].label, "x86_pkg_temp");
        assert_eq!(
            one.manual.thermals.battery,
            Some(HostStatsBattery {
                pct: 87.0,
                status: "Discharging".to_string()
            })
        );
        // Empty success: no section failed (procmini has no inotify sysctls,
        // so that section is zero WITHOUT an error entry — Node parity).
        assert!(one.manual.section_errors.is_empty());
        assert!(!one.manual.inotify.available);
        // The merged snapshot now carries the manual cache.
        let snap = collector.snapshot();
        assert_eq!(snap.manual_at, Some(one.at));
        assert_eq!(snap.manual, Some(one.manual));
    }

    #[tokio::test]
    async fn host_stats_refresh_post_completion_cooldown_rate_limited() {
        // Parity test 2: the connection-AGNOSTIC 1s post-completion cooldown
        // (Instant-controlled; test shortens the cooldown and proves the floor
        // + the allow-again sides with short real sleeps).
        let tmp = tempfile::tempdir().unwrap();
        let scan_root = scan_proc_overlay(tmp.path());
        let interest = HostStatsInterestRegistry::default();
        let mut cfg = test_config(scan_root, sys_fixture());
        cfg.refresh_cooldown = Duration::from_millis(150);
        let collector = HostStatsCollectorService::new(
            cfg,
            freshell_terminal::TerminalRegistry::new(),
            interest,
            Instant::now(),
        );
        assert!(collector.refresh(Duration::from_millis(2000)).await.is_ok());
        let limited = collector.refresh(Duration::from_millis(2000)).await;
        assert_eq!(limited, Err("rate_limited".to_string()));
        // Single-flight is NOT the cooldown: the first completed already.
        assert_eq!(collector.scan_run_count(), 1);
        tokio::time::sleep(Duration::from_millis(250)).await;
        let again = collector.refresh(Duration::from_millis(2000)).await;
        assert!(again.is_ok(), "the floor lifts after the cooldown window");
        assert_eq!(collector.scan_run_count(), 2);
    }

    #[tokio::test]
    async fn host_stats_refresh_section_budget_degrades_scan_sections_only() {
        // Cooperative budget: an already-exhausted shared absolute deadline
        // marks ONLY the scan sections failed (zero-shape + sectionErrors);
        // the file-reading sections still complete.
        let tmp = tempfile::tempdir().unwrap();
        let scan_root = scan_proc_overlay(tmp.path());
        let interest = HostStatsInterestRegistry::default();
        let collector = test_collector(scan_root, sys_fixture(), &interest);
        let result = collector
            .refresh(Duration::ZERO)
            .await
            .expect("budget exhaustion degrades sections, never rejects");
        assert!(!result.manual.top_processes.available);
        assert!(!result.manual.process_health.available);
        assert_eq!(
            result
                .manual
                .section_errors
                .get("topProcesses")
                .map(String::as_str),
            Some("host-stats section deadline exceeded")
        );
        assert_eq!(
            result
                .manual
                .section_errors
                .get("processHealth")
                .map(String::as_str),
            Some("host-stats section deadline exceeded")
        );
        // Non-scan sections complete under the same refresh.
        assert!(result.manual.disks.available);
        assert!(!result.manual.disks.list.is_empty());
        assert!(result.manual.thermals.available);
        assert!(!result.manual.section_errors.contains_key("disks"));
    }

    #[tokio::test]
    async fn host_stats_refresh_leader_teardown_joiner_and_cache_survive() {
        // Parity regression (service.ts:321-331): the in-flight refresh run is
        // owned by the COLLECTOR (Node's service-owned pendingRefresh), never
        // by the requesting caller's future. If the "leader" caller is torn
        // down mid-flight (its connection dies), the run still completes:
        // the next caller joins the SAME collector-owned run and receives its
        // result, and the manual cache is updated unconditionally.
        let tmp = tempfile::tempdir().unwrap();
        let scan_root = scan_proc_overlay(tmp.path());
        let interest = HostStatsInterestRegistry::default();
        let collector = Arc::new(test_collector(scan_root, sys_fixture(), &interest));
        // The leader drives refresh() from its own task, then tears down
        // mid-flight (the abort drops the future mid-dwell).
        let leader = {
            let leader_collector = Arc::clone(&collector);
            tokio::spawn(async move { leader_collector.refresh(Duration::from_millis(2000)).await })
        };
        let in_flight =
            wait_until(Duration::from_secs(2), || collector.scan_run_count() == 1).await;
        assert!(in_flight, "the leader's run started (scan in flight)");
        leader.abort();
        let outcome = leader.await;
        let cancelled = matches!(&outcome, Err(e) if e.is_cancelled());
        assert!(
            cancelled,
            "the leader task was aborted mid-flight: {outcome:?}"
        );
        // The NEXT caller joins the collector-owned run (never a "refresh
        // leader vanished" error, never a poisoned flight slot).
        let joined = collector
            .refresh(Duration::from_millis(2000))
            .await
            .expect("the collector-owned run completes for every caller");
        assert_eq!(
            collector.scan_run_count(),
            1,
            "no re-run: the surviving run serves the joiner"
        );
        assert!(joined.manual.top_processes.available);
        assert_eq!(joined.manual.top_processes.list.len(), 7);
        assert!(joined.manual.process_health.available);
        assert_eq!(joined.manual.process_health.zombies, 1);
        assert_eq!(joined.manual.process_health.d_state, 1);
        assert_eq!(joined.manual.process_health.total, 8);
        assert!(joined.manual.disks.available);
        assert!(joined.manual.thermals.available);
        assert!(joined.manual.section_errors.is_empty());
        // The manual cache was written by the collector at completion.
        let snap = collector.snapshot();
        assert_eq!(snap.manual_at, Some(joined.at));
        assert_eq!(snap.manual, Some(joined.manual));
    }

    #[tokio::test]
    async fn host_stats_refresh_overall_watchdog_covers_every_section() {
        // Parity regression (service.ts:744): EVERY section arm races the
        // overall watchdog — not only the process-scan arm. An overall budget
        // that is already exhausted must degrade EVERY section to its full
        // zero-shape (available:false + the watchdog sectionErrors entry)
        // while the refresh still resolves Ok and the manual cache updates.
        // (Healthy-path completion under the same wrapper is pinned by the
        // single-flight + cooperative-budget tests above.)
        let tmp = tempfile::tempdir().unwrap();
        let scan_root = scan_proc_overlay(tmp.path());
        // Give the overlay readable inotify sysctls so an UNGUARDED inotify
        // arm would complete as available:true (pre-fix discrimination).
        let inotify_dir = scan_root.join("sys").join("fs").join("inotify");
        std::fs::create_dir_all(&inotify_dir).unwrap();
        std::fs::write(inotify_dir.join("max_user_watches"), "1048576\n").unwrap();
        std::fs::write(inotify_dir.join("max_user_instances"), "128\n").unwrap();
        let interest = HostStatsInterestRegistry::default();
        let mut cfg = test_config(scan_root, sys_fixture());
        // The watchdog fires at the first per-section preemption point.
        cfg.overall_budget = Duration::ZERO;
        let collector = HostStatsCollectorService::new(
            cfg,
            freshell_terminal::TerminalRegistry::new(),
            interest,
            Instant::now(),
        );
        // A HEALTHY cooperative budget: only the overall-watchdog path is
        // under test here (the per-pid cooperative deadline never trips).
        let result = collector
            .refresh(Duration::from_millis(2000))
            .await
            .expect("watchdog preemption degrades sections, never rejects");
        let manual = &result.manual;
        assert!(!manual.top_processes.available);
        assert!(!manual.process_health.available);
        assert!(
            !manual.inotify.available,
            "the watchdog must preempt the inotify arm"
        );
        assert!(
            !manual.disks.available,
            "the watchdog must preempt the disks arm"
        );
        assert!(
            !manual.thermals.available,
            "the watchdog must preempt the thermals arm"
        );
        for key in [
            "topProcesses",
            "processHealth",
            "inotify",
            "disks",
            "thermals",
        ] {
            assert_eq!(
                manual.section_errors.get(key).map(String::as_str),
                Some("host-stats refresh overall budget exceeded"),
                "section {key} carries the watchdog error"
            );
        }
        assert_eq!(manual.section_errors.len(), 5);
        assert_eq!(collector.scan_run_count(), 1);
        // The refresh still resolved and the manual cache holds the degraded
        // shape (Node: manualCache is written after Promise.all, errors or not).
        let snap = collector.snapshot();
        assert_eq!(snap.manual_at, Some(result.at));
        assert_eq!(snap.manual, Some(result.manual.clone()));
    }

    #[tokio::test]
    async fn host_stats_refresh_dead_run_frees_flight_slot_and_never_caches() {
        // Parity regression (service.ts:326-329 — Node wraps runRefresh() in
        // `.finally(() => { pendingRefresh = null; lastRefreshCompletedAt =
        // nowFn() })`, which runs even when the run THROWS): a refresh run
        // that dies without completing (a panic unwinds the collector's
        // spawned run task) must not brick the path. Without the drop-guard
        // the flight slot stays occupied forever and every later refresh()
        // joins the dead channel ("refresh run vanished"); with it, the next
        // refresh() starts a FRESH run. The dead run NEVER writes the manual
        // cache (Node's manualCache is only written by a completed run) but
        // DOES stamp the cooldown (Node's .finally stamps even on a throw).
        let tmp = tempfile::tempdir().unwrap();
        let scan_root = scan_proc_overlay(tmp.path());
        let interest = HostStatsInterestRegistry::default();
        let mut cfg = test_config(scan_root, sys_fixture());
        // The cooldown stamp has its own dedicated test; here it must not
        // gate the recovery refresh.
        cfg.refresh_cooldown = Duration::ZERO;
        let collector = HostStatsCollectorService::new(
            cfg,
            freshell_terminal::TerminalRegistry::new(),
            interest,
            Instant::now(),
        );
        // Arm the one-shot seam: the FIRST refresh run dies mid-scan.
        collector.ctx.test_run_panic.store(true, Ordering::SeqCst);
        let dead = collector.refresh(Duration::from_millis(2000)).await;
        assert_eq!(
            dead,
            Err("refresh run vanished".to_string()),
            "a caller attached to the dead run gets the vanished-run error"
        );
        assert_eq!(
            collector.scan_run_count(),
            1,
            "the dead run started (and died in flight)"
        );
        // Node's .finally runs even on a throw: the flight slot is freed and
        // the cooldown stamped...
        assert!(
            collector.ctx.share.refresh_flight.lock().unwrap().is_none(),
            "a dead run frees the flight slot (Node .finally clears pendingRefresh)"
        );
        assert!(
            collector
                .ctx
                .share
                .last_refresh_completed
                .lock()
                .unwrap()
                .is_some(),
            "a dead run still stamps the cooldown (Node .finally stamps lastRefreshCompletedAt)"
        );
        // ...but the manual cache is NEVER updated by a failed run.
        let snap = collector.snapshot();
        assert!(
            snap.manual_at.is_none() && snap.manual.is_none(),
            "the dead run never wrote the manual cache"
        );
        // The next refresh() recovers: a FRESH run serves it.
        let recovered = collector
            .refresh(Duration::from_millis(2000))
            .await
            .expect("a dead run must not brick the refresh path");
        assert_eq!(
            collector.scan_run_count(),
            2,
            "a FRESH run served the recovery refresh"
        );
        assert!(recovered.manual.top_processes.available);
        assert_eq!(recovered.manual.top_processes.list.len(), 7);
        assert!(recovered.manual.section_errors.is_empty());
        let snap = collector.snapshot();
        assert_eq!(snap.manual_at, Some(recovered.at));
        assert_eq!(snap.manual, Some(recovered.manual));
    }
}
