//! DIAG-04: live debug/perf logging toggles and process sampling -- the Rust
//! port of `server/perf-logger.ts`.
//!
//! ## What this ports
//!
//!   - [`PerfConfig`] -- mirrors `resolvePerfConfig` (`perf-logger.ts:33-49`):
//!     every `PERF_*` env var with Node's exact defaults. `enabled` =
//!     `parseBoolean(PERF_LOGGING) || parseBoolean(PERF_DEBUG)`.
//!   - [`PerfLogger::set_enabled`] -- `setPerfLoggingEnabled(enabled, source)`
//!     (`perf-logger.ts:68-90`): flipping on emits `perf_logging_enabled` (with
//!     the resolved config, Node ordering: enabled event BEFORE the toggled
//!     event) and starts the interval sampler; flipping off aborts the sampler
//!     task; either flip emits `perf_logging_toggled` -- ALL WITHOUT a restart.
//!     A same-value toggle is a no-op (Node's `perfConfig.enabled === enabled`
//!     early return).
//!   - [`PerfLogger::should_log`] -- the per-key epoch-millis rate limiter
//!     (`perf-logger.ts:92-99`): disabled or inside the interval => false;
//!     otherwise records and returns true.
//!   - [`PerfLogger::log_perf_event`] -- `logPerfEvent(event, context, level)`
//!     (`perf-logger.ts:121-128`): disabled => drop; otherwise emit merged
//!     `{event, ...context}`, adding `perfSeverity: <level>` when warn/error
//!     and the caller didn't set one (`withPerfSeverity`, :114-119).
//!   - The periodic `perf_system` sampler (`perf-logger.ts:185-221`): every
//!     `process_sample_ms` emit `uptimeSec`, `intervalSec`, `cpuUserMs`,
//!     `cpuSystemMs`, `rssBytes` -- deltas from `/proc/self/stat` utime/stime
//!     (ticks -> ms, USER_HZ=100) and `/proc/self/status` `VmRSS:` kB.
//!
//! ## Deliberate divergences (documented, not parity claims)
//!
//!   - **No event-loop histogram / heap fields.** `eventLoop` percentiles come
//!     from `perf_hooks.monitorEventLoopDelay` and `heapUsedBytes` /
//!     `heapTotalBytes` / `externalBytes` / `arrayBuffersBytes` from V8 -- both
//!     are Node-runtime concepts with no Rust analog. The DIAG-04 spec lists
//!     exactly the five `perf_system` fields implemented above as the parity
//!     set; the rest are omitted per spec.
//!   - **Log-level flip has no analog.** Legacy's `applyDebugLogging`
//!     (`server/index.ts:701-706`) also calls `setLogLevel` so Node's debug
//!     lines appear only while the toggle is on. The Rust JSONL pipeline's
//!     level filter (`RUST_LOG`, `logging.rs`) is fixed at boot, so THIS
//!     module gates at the source instead (everything below checks
//!     `is_enabled()` before emitting) and perf events are emitted at `info`
//!     so they appear in `rust-server.jsonl` exactly during the enabled
//!     interval under the default `info` filter -- the observable legacy
//!     contract ("perf entries only during the enabled interval") is
//!     preserved, just enforced on the emission side.
//!   - **Env is boot-authoritative.** Legacy's boot-time
//!     `applyDebugLogging(!!settings.logging?.debug, 'settings')`
//!     (`server/index.ts:708`) runs AFTER `initPerfLogging()` and would
//!     DISABLE an env-enabled perf logger whenever the persisted
//!     `logging.debug` is false (the default) -- defeating `PERF_LOGGING=1`
//!     on every ordinary boot. The DIAG-04 spec pins the opposite contract
//!     ("startup must honor PERF_LOGGING/PERF_DEBUG env"), so `main.rs`
//!     applies the persisted setting only in the ENABLING direction at boot
//!     (`set_enabled` with the same value is a no-op either way).
//!   - **`log_perf_event` context is carried under one `payload` field.**
//!     pino flattens `{event, ...context}` onto the log line; `tracing` field
//!     names are compile-time constants, so the merged object is emitted as a
//!     JSON string under `payload` instead of spread onto the line. The
//!     DIAG-04 observable events (`perf_system`, `perf_logging_toggled`,
//!     `perf_logging_enabled`) emit typed top-level fields with the EXACT
//!     Node field names and are unaffected by this.
//!   - **Linux-only sampler substrate.** `/proc/self/stat` + `/proc/self/statm`
//!     are read on every tick; on any other OS every sample read is a no-op
//!     `None` (the interval still runs, nothing is emitted) -- per spec.
//!
//! ## Wiring
//!
//! Constructed once in `main.rs` ([`PerfLogger::new`] + [`PerfLogger::init`]),
//! then shared (cheap `Arc` clone) into `DiagState` (POST /api/perf, source
//! `"api"`), `SettingsRouterState` (PATCH/PUT /api/settings, source
//! `"settings"`), and `BootState` (bootstrap's `perf.logging`, the legacy
//! `getPerfLogging()` live read, `server/index.ts:230`).


use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;

/// The `tracing` target for every perf event -- the analog of Node's
/// `logger.child({ component: 'perf' })` (`perf-logger.ts:52`).
const PERF_TARGET: &str = "freshell_server::perf";

/// Linux `USER_HZ` -- `/proc/self/stat` utime/stime are expressed in these
/// ticks. Fixed at 100 on every Linux ABI freshell targets (x86_64/aarch64),
/// so ticks -> ms is `ticks * 10`.
const TICK_MS: u64 = 10;

/// `PerfConfig` (`perf-logger.ts:4-18`). Field names serialize camelCase so
/// the `perf_logging_enabled` event's `config` payload uses Node's exact key
/// names (`processSampleMs`, `rateLimitMs`, ...).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfConfig {
    pub enabled: bool,
    pub http_slow_ms: u64,
    pub ws_slow_ms: u64,
    pub ws_backpressure_bytes: u64,
    pub ws_payload_warn_bytes: u64,
    pub terminal_sample_ms: u64,
    pub process_sample_ms: u64,
    pub event_loop_resolution_ms: u64,
    pub slow_session_refresh_ms: u64,
    pub slow_ai_summary_ms: u64,
    pub slow_terminal_create_ms: u64,
    pub terminal_input_lag_ms: u64,
    pub rate_limit_ms: u64,
}

impl Default for PerfConfig {
    /// The exact `resolvePerfConfig` fallback values (`perf-logger.ts:36-47`).
    fn default() -> Self {
        Self {
            enabled: false,
            http_slow_ms: 500,
            ws_slow_ms: 50,
            ws_backpressure_bytes: 2 * 1024 * 1024,
            ws_payload_warn_bytes: 50 * 1024,
            terminal_sample_ms: 5_000,
            process_sample_ms: 10_000,
            event_loop_resolution_ms: 20,
            slow_session_refresh_ms: 500,
            slow_ai_summary_ms: 750,
            slow_terminal_create_ms: 200,
            terminal_input_lag_ms: 200,
            rate_limit_ms: 5_000,
        }
    }
}

/// `parseBoolean` (`perf-logger.ts:20-24`): trimmed, lowercased membership in
/// {1, true, yes, on}; anything else (including unset) is false.
fn parse_boolean(value: Option<&str>) -> bool {
    match value {
        None => false,
        Some(raw) => matches!(raw.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
    }
}

/// `readNumber` (`perf-logger.ts:26-31`): unset/empty -> fallback; parsed
/// values must be finite AND > 0 or the fallback wins (Node's
/// `Number.isFinite(parsed) && parsed > 0`).
fn read_number(value: Option<&str>, fallback: u64) -> u64 {
    match value {
        None => fallback,
        Some(raw) if raw.is_empty() => fallback,
        Some(raw) => match raw.trim().parse::<f64>() {
            Ok(v) if v.is_finite() && v > 0.0 => v as u64,
            _ => fallback,
        },
    }
}

impl PerfConfig {
    /// `resolvePerfConfig(env)` (`perf-logger.ts:33-49`) with an injected
    /// lookup for hermetic tests (production passes `|k| std::env::var(k).ok()`).
    pub fn from_env(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let d = Self::default();
        let get = |k: &str| lookup(k);
        Self {
            enabled: parse_boolean(get("PERF_LOGGING").as_deref())
                || parse_boolean(get("PERF_DEBUG").as_deref()),
            http_slow_ms: read_number(get("PERF_HTTP_SLOW_MS").as_deref(), d.http_slow_ms),
            ws_slow_ms: read_number(get("PERF_WS_SLOW_MS").as_deref(), d.ws_slow_ms),
            ws_backpressure_bytes: read_number(
                get("PERF_WS_BACKPRESSURE_BYTES").as_deref(),
                d.ws_backpressure_bytes,
            ),
            ws_payload_warn_bytes: read_number(
                get("PERF_WS_PAYLOAD_WARN_BYTES").as_deref(),
                d.ws_payload_warn_bytes,
            ),
            terminal_sample_ms: read_number(
                get("PERF_TERMINAL_SAMPLE_MS").as_deref(),
                d.terminal_sample_ms,
            ),
            process_sample_ms: read_number(
                get("PERF_PROCESS_SAMPLE_MS").as_deref(),
                d.process_sample_ms,
            ),
            event_loop_resolution_ms: read_number(
                get("PERF_EVENT_LOOP_RESOLUTION_MS").as_deref(),
                d.event_loop_resolution_ms,
            ),
            slow_session_refresh_ms: read_number(
                get("PERF_SESSION_REFRESH_SLOW_MS").as_deref(),
                d.slow_session_refresh_ms,
            ),
            slow_ai_summary_ms: read_number(
                get("PERF_AI_SUMMARY_SLOW_MS").as_deref(),
                d.slow_ai_summary_ms,
            ),
            slow_terminal_create_ms: read_number(
                get("PERF_TERMINAL_CREATE_SLOW_MS").as_deref(),
                d.slow_terminal_create_ms,
            ),
            terminal_input_lag_ms: read_number(
                get("PERF_TERMINAL_INPUT_LAG_MS").as_deref(),
                d.terminal_input_lag_ms,
            ),
            rate_limit_ms: read_number(get("PERF_RATE_LIMIT_MS").as_deref(), d.rate_limit_ms),
        }
    }
}

/// One reading of the process counters used by the `perf_system` sample.
#[derive(Debug, Clone, Copy, PartialEq)]
struct ProcSample {
    utime_ticks: u64,
    stime_ticks: u64,
    rss_bytes: u64,
}

/// Parse `/proc/self/stat` content: utime is overall field 14, stime 15.
/// `comm` (field 2) may contain spaces/parens, so split after the LAST `)`.
fn parse_proc_stat(stat: &str) -> Option<(u64, u64)> {
    let after = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = after.split_whitespace().collect();
    // fields[0] is overall field 3 (state); utime = overall 14 -> index 11.
    let utime = fields.get(11)?.parse().ok()?;
    let stime = fields.get(12)?.parse().ok()?;
    Some((utime, stime))
}

/// Parse `/proc/self/status` content: the `VmRSS:` line, in kB.
fn parse_proc_status_rss(status: &str) -> Option<u64> {
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb: u64 = rest.trim().trim_end_matches("kB").trim().parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn read_proc_sample() -> Option<ProcSample> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let (utime_ticks, stime_ticks) = parse_proc_stat(&stat)?;
    let rss_bytes = parse_proc_status_rss(&status)?;
    Some(ProcSample { utime_ticks, stime_ticks, rss_bytes })
}

#[cfg(not(target_os = "linux"))]
fn read_proc_sample() -> Option<ProcSample> {
    None
}

/// Live debug/perf logging toggle + process sampler (see module docs).
/// Cheaply shareable: wrap in an `Arc` and clone into every consumer.
pub struct PerfLogger {
    config: PerfConfig,
    enabled: AtomicBool,
    boot: Instant,
    last_log_by_key: Mutex<HashMap<String, Instant>>,
    sampler: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Total `perf_system` ticks taken since construction -- observability
    /// for tests (and harmless in production).
    sample_ticks: AtomicU64,
}

impl PerfLogger {
    pub fn new(config: PerfConfig) -> Self {
        Self {
            config,
            enabled: AtomicBool::new(false),
            boot: Instant::now(),
            last_log_by_key: Mutex::new(HashMap::new()),
            sampler: Mutex::new(None),
            sample_ticks: AtomicU64::new(0),
        }
    }

    pub fn config(&self) -> &PerfConfig {
        &self.config
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn sample_ticks(&self) -> u64 {
        self.sample_ticks.load(Ordering::SeqCst)
    }

    /// `setPerfLoggingEnabled(enabled, source)` (`perf-logger.ts:68-90`):
    /// same-value flips are no-ops; enabling emits `perf_logging_enabled`
    /// (with the resolved config, Node ordering) then starts the sampler;
    /// disabling aborts the sampler and clears rate-limiter state. Either
    /// real flip emits `perf_logging_toggled` -- all WITHOUT a restart.
    pub fn set_enabled(self: &Arc<Self>, enabled: bool, source: &str) {
        if self
            .enabled
            .compare_exchange(!enabled, enabled, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return; // same-value no-op (Node's early return)
        }

        if enabled {
            let config_json =
                serde_json::to_string(&self.config).unwrap_or_else(|_| "{}".to_string());
            tracing::info!(
                target: PERF_TARGET,
                event = "perf_logging_enabled",
                config = %config_json,
                "Perf logging enabled"
            );
            let me = Arc::clone(self);
            let handle = tokio::spawn(async move { me.sampler_loop().await });
            let mut slot = self.sampler.lock().expect("sampler lock");
            if let Some(old) = slot.replace(handle) {
                old.abort();
            }
        } else {
            if let Some(handle) = self.sampler.lock().expect("sampler lock").take() {
                handle.abort();
            }
            self.last_log_by_key.lock().expect("rate lock").clear();
        }
        tracing::info!(
            target: PERF_TARGET,
            event = "perf_logging_toggled",
            enabled,
            source,
            "Perf logging toggled"
        );
    }

    /// `shouldLog(key, intervalMs)` (`perf-logger.ts:92-99`).
    pub fn should_log(&self, key: &str, interval_ms: u64) -> bool {
        if !self.is_enabled() {
            return false;
        }
        let now = Instant::now();
        let mut map = self.last_log_by_key.lock().expect("rate lock");
        match map.get(key) {
            Some(last) if now.duration_since(*last) < Duration::from_millis(interval_ms) => false,
            _ => {
                map.insert(key.to_string(), now);
                true
            }
        }
    }

    /// `logPerfEvent(event, context, level)` (`perf-logger.ts:121-128`) with
    /// `withPerfSeverity` (:114-119): warn/error get `perfSeverity` unless the
    /// caller already set one. Context is emitted as a JSON string under
    /// `payload` (see module docs on tracing's compile-time field names).
    pub fn log_perf_event(
        &self,
        event: &str,
        mut context: serde_json::Map<String, serde_json::Value>,
        level: &str,
    ) {
        if !self.is_enabled() {
            return;
        }
        if matches!(level, "warn" | "error") && !context.contains_key("perfSeverity") {
            context.insert("perfSeverity".into(), serde_json::Value::String(level.into()));
        }
        let payload = serde_json::Value::Object(context).to_string();
        tracing::info!(target: PERF_TARGET, event = %event, payload = %payload, "Perf event");
    }

    /// The `perf_system` interval body (`perf-logger.ts:185-221`).
    async fn sampler_loop(self: Arc<Self>) {
        let period = Duration::from_millis(self.config.process_sample_ms.max(1));
        let mut interval = tokio::time::interval(period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick of `tokio::time::interval` fires immediately; consume
        // it as the baseline so emission cadence matches Node's setInterval.
        interval.tick().await;
        let mut prev = read_proc_sample();
        let mut prev_at = Instant::now();
        loop {
            interval.tick().await;
            self.sample_ticks.fetch_add(1, Ordering::SeqCst);
            let cur = read_proc_sample();
            let now = Instant::now();
            if let (Some(p), Some(c)) = (prev, cur) {
                let interval_sec = now.duration_since(prev_at).as_secs_f64();
                let uptime_sec = self.boot.elapsed().as_secs_f64();
                let cpu_user_ms = c.utime_ticks.saturating_sub(p.utime_ticks) * TICK_MS;
                let cpu_system_ms = c.stime_ticks.saturating_sub(p.stime_ticks) * TICK_MS;
                tracing::info!(
                    target: PERF_TARGET,
                    event = "perf_system",
                    uptimeSec = format!("{uptime_sec:.1}").parse::<f64>().unwrap_or(uptime_sec),
                    intervalSec = format!("{interval_sec:.1}").parse::<f64>().unwrap_or(interval_sec),
                    cpuUserMs = cpu_user_ms,
                    cpuSystemMs = cpu_system_ms,
                    rssBytes = c.rss_bytes,
                    "Perf system sample"
                );
            }
            prev = cur;
            prev_at = now;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |k| {
            pairs
                .iter()
                .find(|(key, _)| *key == k)
                .map(|(_, v)| v.to_string())
        }
    }

    #[test]
    fn from_env_defaults_match_node_fallbacks() {
        let cfg = PerfConfig::from_env(|_| None);
        assert_eq!(cfg, PerfConfig::default());
        assert!(!cfg.enabled);
        assert_eq!(cfg.process_sample_ms, 10_000);
        assert_eq!(cfg.rate_limit_ms, 5_000);
        assert_eq!(cfg.ws_backpressure_bytes, 2 * 1024 * 1024);
    }

    #[test]
    fn from_env_overrides_and_enable_variants() {
        // PERF_LOGGING enables; so does PERF_DEBUG; JS-strict falsy strings don't.
        assert!(PerfConfig::from_env(env(&[("PERF_LOGGING", "1")])).enabled);
        assert!(PerfConfig::from_env(env(&[("PERF_DEBUG", "  TRUE ")])).enabled);
        assert!(PerfConfig::from_env(env(&[("PERF_LOGGING", "yes")])).enabled);
        assert!(PerfConfig::from_env(env(&[("PERF_LOGGING", "on")])).enabled);
        assert!(!PerfConfig::from_env(env(&[("PERF_LOGGING", "0")])).enabled);
        assert!(!PerfConfig::from_env(env(&[("PERF_LOGGING", "enabled")])).enabled);

        let cfg = PerfConfig::from_env(env(&[
            ("PERF_PROCESS_SAMPLE_MS", "2500"),
            ("PERF_RATE_LIMIT_MS", "9000"),
        ]));
        assert_eq!(cfg.process_sample_ms, 2_500);
        assert_eq!(cfg.rate_limit_ms, 9_000);
    }

    #[test]
    fn from_env_invalid_numbers_fall_back() {
        // Node: `Number.isFinite(parsed) && parsed > 0` else fallback.
        for bad in ["abc", "-5", "0", "NaN", "Infinity", ""] {
            let cfg = PerfConfig::from_env(env(&[("PERF_HTTP_SLOW_MS", bad)]));
            assert_eq!(cfg.http_slow_ms, 500, "input {bad:?} must fall back");
        }
    }

    #[test]
    fn proc_stat_parser_handles_parens_in_comm() {
        // comm with spaces AND a closing paren -- split must use the LAST ')'.
        let stat = "12345 (a weird) name) R 1 12345 12345 0 -1 4194304 100 0 0 0 777 333 0 0 20 0 8 0 12345678 100000000 5000 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";
        let (utime, stime) = parse_proc_stat(stat).expect("parses");
        assert_eq!(utime, 777);
        assert_eq!(stime, 333);
    }

    #[test]
    fn proc_status_rss_parser_reads_kb() {
        let status = "Name:\tfreshell-server\nVmPeak:\t 1000 kB\nVmRSS:\t  482016 kB\nThreads:\t9\n";
        assert_eq!(parse_proc_status_rss(status), Some(482_016 * 1024));
        assert_eq!(parse_proc_status_rss("Name: x\n"), None);
    }

    #[test]
    fn should_log_rate_limits_per_key() {
        let logger = Arc::new(PerfLogger::new(PerfConfig::default()));
        logger.enabled.store(true, Ordering::SeqCst); // direct: no runtime here
        assert!(logger.should_log("k", 40), "first call allowed");
        assert!(!logger.should_log("k", 40), "inside interval suppressed");
        assert!(logger.should_log("other", 40), "independent keys");
        std::thread::sleep(Duration::from_millis(50));
        assert!(logger.should_log("k", 40), "allowed again after interval");
        logger.enabled.store(false, Ordering::SeqCst);
        assert!(!logger.should_log("k2", 0), "disabled => always false");
    }

    #[tokio::test]
    async fn set_enabled_starts_and_stops_the_sampler() {
        let cfg = PerfConfig { process_sample_ms: 10, ..PerfConfig::default() };
        let logger = Arc::new(PerfLogger::new(cfg));
        assert!(!logger.is_enabled());

        logger.set_enabled(true, "test");
        assert!(logger.is_enabled());
        // Same-value flip is a no-op (must not restart the sampler task).
        logger.set_enabled(true, "test");

        let mut waited = 0;
        while logger.sample_ticks() < 2 && waited < 2_000 {
            tokio::time::sleep(Duration::from_millis(10)).await;
            waited += 10;
        }
        assert!(logger.sample_ticks() >= 2, "sampler must tick while enabled");

        logger.set_enabled(false, "test");
        assert!(!logger.is_enabled());
        tokio::time::sleep(Duration::from_millis(30)).await;
        let frozen = logger.sample_ticks();
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert_eq!(logger.sample_ticks(), frozen, "sampler must stop when disabled");
    }

    #[tokio::test]
    async fn log_perf_event_gates_on_enabled_and_tags_severity() {
        let logger = Arc::new(PerfLogger::new(PerfConfig::default()));
        // Disabled: silently dropped (no panic, no state change).
        logger.log_perf_event("x", serde_json::Map::new(), "warn");
        logger.set_enabled(true, "test");
        let mut ctx = serde_json::Map::new();
        ctx.insert("durationMs".into(), serde_json::json!(12));
        logger.log_perf_event("terminal_stream_gap", ctx, "warn");
        logger.set_enabled(false, "test");
    }
}
