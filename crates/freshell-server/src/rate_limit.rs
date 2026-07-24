//! SAFE-02: the global authenticated API rate limit (checklist:
//! `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:539` --
//! "Add the global authenticated API rate limit. Return 429 and `Retry-After`
//! with the intended client scope while leaving static UI/health available.")
//!
//! ## Legacy semantics (what this mirrors, and what it deliberately changes)
//!
//! The original mounts a single `express-rate-limit` instance at the `/api`
//! prefix, BEFORE `cookieParser`/`httpAuthMiddleware` (`server/index.ts:161-170`):
//!
//! ```ts
//! app.use(
//!   '/api',
//!   rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }),
//! )
//! ```
//!
//! * **Window/limit**: 60s window, 300 requests -- mirrored here as a token
//!   bucket with `capacity = 300.0`, `refill_per_sec = 5.0` (300/60s), which
//!   reproduces the same steady-state ceiling while refilling continuously
//!   instead of resetting on a hard window boundary (strictly more generous
//!   than legacy's reset-to-zero-then-refill-to-300 cliff).
//! * **Exempt path**: `/api/health` is handled by its own router mounted
//!   BEFORE the limiter (`server/index.ts:149` vs `:161`), so a health probe
//!   never reaches it -- a structural exemption via Express dispatch order,
//!   not an explicit skip list. `is_limited_path` below reproduces the same
//!   effect with an explicit check, since this port's `axum::middleware::from_fn`
//!   layer wraps every merged route uniformly regardless of mount order.
//! * **Response body**: legacy sends `express-rate-limit`'s default plain-text
//!   message, no JSON envelope. This port instead uses the `{ ok, error,
//!   message }` shape already established across the rest of this crate's
//!   error responses (see e.g. `terminals.rs`'s `{ "error": ..., "details":
//!   ... }` 400s) for consistency within the Rust surface.
//! * **`Retry-After`**: legacy's `standardHeaders: true` sets the `Retry-After`
//!   header on a 429 (seconds until the window resets); mirrored here as
//!   seconds until enough tokens have refilled for one more request.
//!
//! ## Deliberate scope deviation: global, not per-IP
//!
//! `express-rate-limit`'s default `keyGenerator` buckets by `req.ip`
//! (trust-proxy-aware, per `app.set('trust proxy', ...)` at
//! `server/index.ts:137`) -- i.e. legacy's limiter is per-client, not global.
//! The checklist item's OWN title, however, says "global": this port honors
//! that explicit word over legacy's default keying, using ONE process-wide
//! token bucket shared by every request regardless of source. For a
//! self-hosted, effectively single-tenant terminal multiplexer (the design
//! target here, not a public multi-tenant API), a global bucket sized well
//! above any real interactive workload (see `RateLimitConfig::default_api`'s
//! doc comment) gives the same abuse protection with far less state to
//! manage (no per-IP map, no per-IP cleanup/eviction policy needed).

#[cfg(test)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::{
    extract::Request,
    http::{HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;

/// Injectable time source so `RateLimiter` is deterministically testable
/// (no `sleep`s -- tests advance a fake clock instead of waiting on the
/// real one).
pub trait Clock: Send + Sync {
    /// Milliseconds elapsed since an arbitrary but fixed-per-instance
    /// reference point. Only relative deltas between calls matter --
    /// callers must never assume this aligns with wall-clock/UNIX time.
    fn now_ms(&self) -> u64;
}

/// Production clock: wraps a monotonic [`std::time::Instant`] captured at
/// construction, so `now_ms()` is `elapsed()` since boot of this limiter --
/// immune to system-clock adjustments (NTP steps, DST), matching the
/// monotonic guarantee `Instant` itself provides.
#[derive(Debug)]
pub struct SystemClock {
    start: std::time::Instant,
}

impl SystemClock {
    pub fn new() -> Self {
        Self {
            start: std::time::Instant::now(),
        }
    }
}

impl Default for SystemClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }
}

/// Deterministic clock for tests: starts at 0, advances only when
/// [`TestClock::advance_ms`] is called explicitly. No real time ever
/// elapses, so tests proving refill behavior never sleep. `#[cfg(test)]`
/// gated -- this has no legitimate production use, so it (and its `Clock`
/// impl) never ship in the compiled binary.
#[cfg(test)]
#[derive(Debug, Default)]
pub struct TestClock {
    now_ms: AtomicU64,
}

#[cfg(test)]
impl TestClock {
    pub fn new() -> Self {
        Self {
            now_ms: AtomicU64::new(0),
        }
    }

    pub fn advance_ms(&self, delta_ms: u64) {
        self.now_ms.fetch_add(delta_ms, Ordering::SeqCst);
    }
}

#[cfg(test)]
impl Clock for TestClock {
    fn now_ms(&self) -> u64 {
        self.now_ms.load(Ordering::SeqCst)
    }
}

/// Token-bucket tuning. See the module doc comment for the legacy-parity
/// derivation of the default numbers.
#[derive(Debug, Clone, Copy)]
pub struct RateLimitConfig {
    /// Maximum tokens the bucket can hold -- the size of an initial burst a
    /// client can spend instantly before the sustained rate below applies.
    pub capacity: f64,
    /// Tokens restored per second of elapsed time.
    pub refill_per_sec: f64,
}

impl RateLimitConfig {
    /// SAFE-02 default: `capacity = 300`, `refill_per_sec = 5` (300 per 60s),
    /// matching legacy's `windowMs: 60_000, max: 300`
    /// (`server/index.ts:165-166`). A single human driving the UI issues at
    /// most a handful of authenticated `/api/*` requests per second even
    /// during heavy interaction (opening panes, renaming sessions, toggling
    /// settings); this ceiling exists to blunt a runaway client (a buggy
    /// polling loop, a scripted abuse attempt), not to constrain normal use.
    pub const fn default_api() -> Self {
        Self {
            capacity: 300.0,
            refill_per_sec: 5.0,
        }
    }
}

/// Per-bucket mutable state, guarded by a single [`Mutex`] -- contention is
/// negligible at this request volume, and correctness (never handing out
/// more tokens than the capacity/refill math allows, even under concurrent
/// callers) matters far more than lock-free cleverness here.
struct BucketState {
    tokens: f64,
    last_refill_ms: u64,
    /// Whether the bucket is currently in an active rejection streak --
    /// gates the "first rejection per window" warn log (SAFE-02: "no
    /// flooding"). Cleared on the next successful acquire, so a fresh
    /// streak logs again.
    throttled: bool,
}

/// The global (process-wide) token-bucket rate limiter for authenticated
/// `/api/*` requests. Share ONE instance (behind an `Arc`) across every
/// request -- that shared state IS the "global" the checklist item names.
pub struct RateLimiter {
    clock: Box<dyn Clock>,
    config: RateLimitConfig,
    state: Mutex<BucketState>,
}

impl RateLimiter {
    /// Construct with an explicit clock (production: [`SystemClock`], tests:
    /// [`TestClock`]). The bucket starts FULL (`tokens = capacity`) so the
    /// very first requests after boot are never penalized for a cold start.
    pub fn new(clock: Box<dyn Clock>, config: RateLimitConfig) -> Self {
        let now = clock.now_ms();
        Self {
            state: Mutex::new(BucketState {
                tokens: config.capacity,
                last_refill_ms: now,
                throttled: false,
            }),
            clock,
            config,
        }
    }

    /// Production convenience constructor: a real [`SystemClock`] + the
    /// SAFE-02 default config, ready to share via `Arc`.
    pub fn new_system(config: RateLimitConfig) -> Arc<Self> {
        Arc::new(Self::new(Box::new(SystemClock::new()), config))
    }

    /// Attempt to consume one token. `Ok(())` means the caller may proceed;
    /// `Err(retry_after_secs)` means the bucket is empty, and the caller
    /// should surface a 429 with a `Retry-After` header of that many
    /// seconds (the time until enough tokens have refilled for one more
    /// request).
    pub fn try_acquire(&self) -> Result<(), u64> {
        let now = self.clock.now_ms();
        let mut state = self.state.lock().expect("rate limiter mutex poisoned");

        let elapsed_ms = now.saturating_sub(state.last_refill_ms);
        if elapsed_ms > 0 {
            if self.config.refill_per_sec > 0.0 {
                let refill = (elapsed_ms as f64 / 1000.0) * self.config.refill_per_sec;
                state.tokens = (state.tokens + refill).min(self.config.capacity);
            }
            state.last_refill_ms = now;
        }

        if state.tokens >= 1.0 {
            state.tokens -= 1.0;
            state.throttled = false;
            Ok(())
        } else {
            let should_log = !state.throttled;
            state.throttled = true;

            let tokens_needed = 1.0 - state.tokens;
            let retry_after_secs = if self.config.refill_per_sec > 0.0 {
                (tokens_needed / self.config.refill_per_sec).ceil().max(1.0) as u64
            } else {
                // A zero (or misconfigured negative) refill rate never
                // recovers on its own; report the largest sane wait rather
                // than dividing by zero.
                u64::MAX
            };

            if should_log {
                tracing::warn!(
                    event = "api_rate_limited",
                    retry_after_secs,
                    "authenticated API rate limit exceeded"
                );
            }

            Err(retry_after_secs)
        }
    }
}

/// Whether `path` is subject to the limiter: `/api/*` EXCLUDING
/// `/api/health`. Everything else (the `/ws` upgrade, the retained SPA's
/// static assets and any other non-`/api` path) never matches this prefix
/// and is therefore always exempt -- see the module doc comment for why
/// this reproduces legacy's structural health exemption explicitly.
fn is_limited_path(path: &str) -> bool {
    path.starts_with("/api/") && path != "/api/health"
}

/// The `axum::middleware::from_fn` body. Callers wire this via a capturing
/// closure (mirroring `serve_client`'s fallback-closure pattern in
/// `main.rs`), since `from_fn` itself has no built-in shared-state
/// extraction for a plain owned `Arc`:
///
/// ```ignore
/// let limiter = RateLimiter::new_system(RateLimitConfig::default_api());
/// app.layer(axum::middleware::from_fn(move |req, next| {
///     let limiter = Arc::clone(&limiter);
///     async move { rate_limit::enforce(limiter, req, next).await }
/// }))
/// ```
pub async fn enforce(limiter: Arc<RateLimiter>, req: Request, next: Next) -> Response {
    if !is_limited_path(req.uri().path()) {
        return next.run(req).await;
    }

    match limiter.try_acquire() {
        Ok(()) => next.run(req).await,
        Err(retry_after_secs) => rate_limited_response(retry_after_secs),
    }
}

/// The 429 body: `{ ok: false, error: "rate_limited", message: ... }` plus a
/// `Retry-After` header (seconds). See the module doc comment for why this
/// diverges from legacy's plain-text default message.
///
/// This middleware sits ABOVE (outside) `main.rs`'s `ensure_json_charset`
/// response-mapping layer in the wired app (a rejection here short-circuits
/// before that inner layer ever runs), so the `application/json;
/// charset=utf-8` content-type (S1 parity: matches Express's `res.json`
/// exactly) is set directly here rather than relying on that layer to catch
/// it -- this function is self-contained regardless of where a caller wires
/// it in a layer stack (also true of the standalone `probe_app` used in this
/// module's own tests below, which has no `ensure_json_charset` layer at all).
fn rate_limited_response(retry_after_secs: u64) -> Response {
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "ok": false,
            "error": "rate_limited",
            "message": "Too many requests. Please retry after some time.",
        })),
    )
        .into_response();

    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );

    let header_value = HeaderValue::from_str(&retry_after_secs.to_string())
        .unwrap_or_else(|_| HeaderValue::from_static("60"));
    response
        .headers_mut()
        .insert(axum::http::header::RETRY_AFTER, header_value);

    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request as HttpRequest, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    fn limiter_with(config: RateLimitConfig) -> (Arc<RateLimiter>, Arc<TestClock>) {
        let clock = Arc::new(TestClock::new());
        // `RateLimiter` owns its `Box<dyn Clock>`, so hand it a boxed clone
        // of the SAME underlying atomic via a thin forwarding wrapper --
        // simplest: wrap the shared `Arc<TestClock>` itself as the `Clock`
        // impl (blanket impl below), so the test keeps its own handle to
        // advance time after construction.
        let limiter = Arc::new(RateLimiter::new(Box::new(Arc::clone(&clock)), config));
        (limiter, clock)
    }

    // Allow an `Arc<TestClock>` to itself satisfy `Clock`, so the test can
    // keep a live handle (`Arc::clone`) to advance time AFTER the limiter
    // has taken ownership of its own boxed clock.
    impl Clock for Arc<TestClock> {
        fn now_ms(&self) -> u64 {
            TestClock::now_ms(self)
        }
    }

    #[test]
    fn under_limit_requests_pass_untouched() {
        let (limiter, _clock) = limiter_with(RateLimitConfig {
            capacity: 5.0,
            refill_per_sec: 1.0,
        });
        for i in 0..5 {
            assert!(
                limiter.try_acquire().is_ok(),
                "request {i} should be within capacity"
            );
        }
    }

    #[test]
    fn sustained_over_limit_returns_429_with_retry_after() {
        let (limiter, _clock) = limiter_with(RateLimitConfig {
            capacity: 3.0,
            refill_per_sec: 1.0,
        });
        for _ in 0..3 {
            assert!(limiter.try_acquire().is_ok());
        }
        // The bucket is now empty; the very next request must be rejected
        // with a positive retry-after in seconds.
        let retry_after = limiter.try_acquire().expect_err("should be rate limited");
        assert!(
            retry_after >= 1,
            "retry_after must be a positive count of seconds, got {retry_after}"
        );
    }

    #[test]
    fn refill_restores_service_after_synthetic_clock_advance() {
        let (limiter, clock) = limiter_with(RateLimitConfig {
            capacity: 2.0,
            refill_per_sec: 1.0,
        });
        assert!(limiter.try_acquire().is_ok());
        assert!(limiter.try_acquire().is_ok());
        assert!(limiter.try_acquire().is_err(), "bucket should be empty");

        // refill_per_sec = 1.0 -> 1000ms restores exactly one token, no
        // real sleep involved.
        clock.advance_ms(1000);
        assert!(
            limiter.try_acquire().is_ok(),
            "one token should have refilled after 1000ms"
        );
        assert!(
            limiter.try_acquire().is_err(),
            "only one token refilled; a second immediate request should still be rejected"
        );
    }

    #[test]
    fn concurrent_hammering_never_exceeds_capacity_and_never_panics() {
        // The clock never advances during this test, so with a nonzero
        // (but irrelevant, since elapsed_ms stays 0) refill rate the total
        // accepted count is deterministically bounded by `capacity`.
        let (limiter, _clock) = limiter_with(RateLimitConfig {
            capacity: 10.0,
            refill_per_sec: 5.0,
        });

        let mut handles = Vec::new();
        for _ in 0..50 {
            let limiter = Arc::clone(&limiter);
            handles.push(std::thread::spawn(move || limiter.try_acquire().is_ok()));
        }

        let successes = handles
            .into_iter()
            .map(|h| h.join().expect("worker thread must not panic"))
            .filter(|ok| *ok)
            .count();

        assert_eq!(
            successes, 10,
            "exactly `capacity` requests should succeed under concurrent hammering with a frozen clock"
        );
    }

    // --- axum middleware integration tests -------------------------------

    async fn probe_app(limiter: Arc<RateLimiter>) -> Router {
        Router::new()
            .route("/api/health", get(|| async { "health-ok" }))
            .route("/api/widgets", get(|| async { "widgets-ok" }))
            .route("/ws", get(|| async { "ws-ok" }))
            .layer(axum::middleware::from_fn(move |req, next| {
                let limiter = Arc::clone(&limiter);
                async move { enforce(limiter, req, next).await }
            }))
    }

    fn get_req(uri: &str) -> HttpRequest<Body> {
        HttpRequest::builder()
            .method("GET")
            .uri(uri)
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn health_path_is_exempt_even_when_bucket_is_exhausted() {
        let (limiter, _clock) = limiter_with(RateLimitConfig {
            capacity: 0.0,
            refill_per_sec: 0.0,
        });
        let app = probe_app(limiter).await;
        let resp = app.oneshot(get_req("/api/health")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn ws_path_is_exempt_even_when_bucket_is_exhausted() {
        let (limiter, _clock) = limiter_with(RateLimitConfig {
            capacity: 0.0,
            refill_per_sec: 0.0,
        });
        let app = probe_app(limiter).await;
        let resp = app.oneshot(get_req("/ws")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn exceeding_limit_on_an_api_route_returns_429_with_retry_after_and_envelope() {
        let (limiter, _clock) = limiter_with(RateLimitConfig {
            capacity: 1.0,
            refill_per_sec: 1.0,
        });
        let app = probe_app(limiter).await;

        let first = app.clone().oneshot(get_req("/api/widgets")).await.unwrap();
        assert_eq!(first.status(), StatusCode::OK);

        let second = app.oneshot(get_req("/api/widgets")).await.unwrap();
        assert_eq!(second.status(), StatusCode::TOO_MANY_REQUESTS);
        let retry_after = second
            .headers()
            .get(axum::http::header::RETRY_AFTER)
            .expect("Retry-After header must be present")
            .to_str()
            .unwrap()
            .parse::<u64>()
            .expect("Retry-After must be a plain integer count of seconds");
        assert!(retry_after >= 1);

        let body = axum::body::to_bytes(second.into_body(), usize::MAX)
            .await
            .unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["ok"], serde_json::json!(false));
        assert_eq!(json["error"], serde_json::json!("rate_limited"));
        assert!(json["message"].is_string());
    }

    #[tokio::test]
    async fn under_limit_requests_pass_through_untouched_via_middleware() {
        let (limiter, _clock) = limiter_with(RateLimitConfig {
            capacity: 5.0,
            refill_per_sec: 1.0,
        });
        let app = probe_app(limiter).await;
        let resp = app.oneshot(get_req("/api/widgets")).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"widgets-ok");
    }
}
