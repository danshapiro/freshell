//! DEV-0001 mandatory pinning test (`port/oracle/DEVIATIONS.md` DEV-0001).
//!
//! The reference opencode `serve` cold-start health probe is **un-timed**
//! (`serve-manager.ts:286`, `this.fetchFn('/global/health', {GET})`). A cold serve
//! accepts the TCP connection then withholds the response, so a single probe blocks well
//! past the `healthTimeoutMs` deadline and the `while (Date.now() < deadline)` loop never
//! re-checks — the asserted bound is defeated. The T2 differ tolerates the cold-start
//! diff, so THIS port-side pinning test is the sole guard that the fix is real.
//!
//! Required (DEV-0001 pinning_test): inject a `/global/health` that NEVER resolves, drive
//! `ensureStarted()`, and assert it SETTLES within the deadline (returns the bounded "did
//! not become healthy" error, i.e. the loop advanced) rather than hanging; plus a
//! companion where the probe stalls on the first N attempts then succeeds, asserting
//! `ensureStarted()` RESOLVES. Injected fakes + an outer timeout guard keep the test from
//! hanging even against the NAIVE (pre-fix) probe — so this file goes RED (guard trips)
//! before the bounded impl and GREEN after.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use freshell_opencode::serve::{
    Endpoint, EventSink, EventSource, EventStreamHandle, PortAllocator, ProcessSpawner, ServeConfig,
    ServeDeps, ServeError, ServeHttp, ServeHttpRequest, ServeHttpResponse, ServeProcess, SpawnRequest,
};

// ── injected fakes ───────────────────────────────────────────────────────────────

/// What the fake `/global/health` endpoint does.
#[derive(Clone, Copy)]
enum HealthScript {
    /// Every probe response NEVER resolves (the wedged cold serve).
    NeverResolves,
    /// The first `n` probes never resolve (stall), then healthy.
    StallThenHealthy(usize),
    /// Always healthy immediately.
    Healthy,
}

struct FakeHttp {
    script: HealthScript,
    health_calls: Arc<AtomicUsize>,
}

impl FakeHttp {
    fn new(script: HealthScript) -> (Arc<Self>, Arc<AtomicUsize>) {
        let health_calls = Arc::new(AtomicUsize::new(0));
        (Arc::new(Self { script, health_calls: health_calls.clone() }), health_calls)
    }
}

impl ServeHttp for FakeHttp {
    fn request<'a>(
        &'a self,
        req: ServeHttpRequest,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>> {
        if req.url.contains("/global/health") {
            let n = self.health_calls.fetch_add(1, Ordering::SeqCst) + 1;
            let stalls = match self.script {
                HealthScript::NeverResolves => usize::MAX,
                HealthScript::StallThenHealthy(k) => k,
                HealthScript::Healthy => 0,
            };
            if n <= stalls {
                // A genuine stall: the probe response NEVER resolves. Only the CORE's
                // per-probe bound can advance past this (that is the whole fix).
                return Box::pin(async {
                    std::future::pending::<()>().await;
                    unreachable!()
                });
            }
            return Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) });
        }
        // No other endpoints are exercised in these health tests.
        Box::pin(async { Ok(ServeHttpResponse::new(404, b"not found".to_vec())) })
    }
}

struct FakeAllocator;
impl PortAllocator for FakeAllocator {
    fn allocate(&self) -> Result<Endpoint, String> {
        Ok(Endpoint { hostname: "127.0.0.1".to_string(), port: 1 })
    }
}

/// A spawned serve that never exits and never reports a fatal stderr — so the ONLY thing
/// that can end the readiness wait is a healthy probe or the outer deadline (isolating
/// the DEV-0001 bound).
struct NeverExitsProcess {
    killed: Arc<AtomicUsize>,
}
impl ServeProcess for NeverExitsProcess {
    fn exited(&self) -> Option<i32> {
        None
    }
    fn take_fatal_startup_error(&self) -> Option<String> {
        None
    }
    fn kill(&self) {
        self.killed.fetch_add(1, Ordering::SeqCst);
    }
}

struct FakeSpawner {
    killed: Arc<AtomicUsize>,
}
impl ProcessSpawner for FakeSpawner {
    fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
        Ok(Box::new(NeverExitsProcess { killed: self.killed.clone() }))
    }
}

struct NoopEventHandle;
impl EventStreamHandle for NoopEventHandle {}

struct NoopEventSource;
impl EventSource for NoopEventSource {
    fn connect(&self, _url: String, _sink: EventSink) -> Box<dyn EventStreamHandle> {
        Box::new(NoopEventHandle)
    }
}

fn manager(
    script: HealthScript,
    config: ServeConfig,
) -> (freshell_opencode::OpencodeServeManager, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let (http, health_calls) = FakeHttp::new(script);
    let killed = Arc::new(AtomicUsize::new(0));
    let deps = ServeDeps {
        spawner: Arc::new(FakeSpawner { killed: killed.clone() }),
        http,
        ports: Arc::new(FakeAllocator),
        events: Arc::new(NoopEventSource),
    };
    (freshell_opencode::OpencodeServeManager::new(deps, config), health_calls, killed)
}

fn bounded_config(health_ms: u64, probe_ms: u64, retry_ms: u64) -> ServeConfig {
    ServeConfig {
        health_timeout: Duration::from_millis(health_ms),
        health_probe_timeout: Duration::from_millis(probe_ms),
        health_retry_interval: Duration::from_millis(retry_ms),
        ..ServeConfig::default()
    }
}

// ── the pinning tests ──────────────────────────────────────────────────────────────

/// THE DEV-0001 PIN: a `/global/health` that never resolves must not hang the readiness
/// wait. `ensure_started()` must SETTLE within the outer deadline with the bounded "did
/// not become healthy" error (proving the loop advanced through bounded probes), and it
/// must have waited ~the full deadline (proving it did not error instantly / did not mask
/// the wedge).
#[tokio::test]
async fn settles_within_deadline_when_health_never_resolves() {
    let health_ms = 300;
    let (mgr, health_calls, killed) = manager(HealthScript::NeverResolves, bounded_config(health_ms, 40, 10));

    let started = Instant::now();
    // The outer guard is what turns a genuine hang (the NAIVE probe) into a test FAILURE
    // instead of an infinite test — so this file is RED against the un-timed probe.
    let outcome = tokio::time::timeout(Duration::from_secs(5), mgr.ensure_started()).await;
    let elapsed = started.elapsed();

    let result = outcome.expect(
        "DEV-0001: the readiness wait HUNG on a never-resolving /global/health probe \
         (naive un-timed probe) — it must settle within the deadline, not block",
    );

    assert!(
        matches!(result, Err(ServeError::NotHealthy { .. })),
        "a wedged serve must fail as the bounded 'did not become healthy' error, got {result:?}"
    );
    // Proves the loop actually advanced through multiple bounded probes rather than
    // resolving instantly — the per-probe bound retried to the deadline.
    assert!(
        health_calls.load(Ordering::SeqCst) >= 2,
        "the loop must have issued multiple bounded probes, saw {}",
        health_calls.load(Ordering::SeqCst)
    );
    // Does NOT mask the wedge: it still waited the (unchanged) outer deadline.
    assert!(
        elapsed >= Duration::from_millis(health_ms) - Duration::from_millis(80),
        "should have waited ~the full {health_ms}ms deadline, waited {elapsed:?}"
    );
    // And it settled well within the guard (no hang).
    assert!(elapsed < Duration::from_secs(4), "settled far under the guard: {elapsed:?}");
    assert!(killed.load(Ordering::SeqCst) >= 1, "a serve that never became healthy is killed");
}

/// Companion: a probe that STALLS (never resolves) on the first N attempts then answers
/// healthy must let `ensure_started()` RESOLVE — the per-probe bound advances past each
/// stall and the retry loop reaches the healthy probe within the deadline.
#[tokio::test]
async fn resolves_when_probe_stalls_then_succeeds() {
    // 3 stalls * 40ms bound + retries ≈ 150ms << 3000ms deadline.
    let (mgr, health_calls, _killed) = manager(HealthScript::StallThenHealthy(3), bounded_config(3000, 40, 10));

    let outcome = tokio::time::timeout(Duration::from_secs(5), mgr.ensure_started())
        .await
        .expect("DEV-0001: stall-then-succeed must resolve within the guard, not hang");

    let base_url = outcome.expect("ensure_started resolves once the serve answers healthy");
    assert_eq!(base_url, "http://127.0.0.1:1");
    assert!(
        health_calls.load(Ordering::SeqCst) >= 4,
        "must have retried past the 3 stalls to the 4th (healthy) probe, saw {}",
        health_calls.load(Ordering::SeqCst)
    );
}

/// Sanity: a healthy serve starts quickly — the per-probe bound adds no latency to the
/// happy path (it only caps a stalled probe).
#[tokio::test]
async fn healthy_immediately_resolves_fast() {
    let (mgr, health_calls, _killed) = manager(HealthScript::Healthy, bounded_config(3000, 2000, 150));

    let started = Instant::now();
    let base_url = tokio::time::timeout(Duration::from_secs(5), mgr.ensure_started())
        .await
        .expect("no hang")
        .expect("healthy serve starts");
    assert_eq!(base_url, "http://127.0.0.1:1");
    assert_eq!(health_calls.load(Ordering::SeqCst), 1, "one probe, immediately healthy");
    assert!(started.elapsed() < Duration::from_millis(500), "healthy start is fast: {:?}", started.elapsed());
}
