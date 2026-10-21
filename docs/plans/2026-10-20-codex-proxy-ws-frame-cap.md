# Plan: Raise the codex WebSocket transport frame caps (proxy 16 MiB frame-cap incident)

**Date:** 2026-10-20
**Branch:** `codex-proxy-ws-frame-cap` (from `origin/main` @ `dc666e73f`)
**Status:** final — one fresheyes review round commissioned (which failed the draft; findings were addressed), followed by a threat-model trim that removed the measurement apparatus the review loop had accumulated

## User Request

### Requested result
- Implement the committed plan at docs/plans/2026-10-20-codex-proxy-ws-frame-cap.md in full, via the-usual's execution stages: raise the codex proxy WebSocket frame caps to a 256 MiB policy with equality transport caps at all five production call sites, add the independent 64 MiB fresh-lane cap, the 32 MiB hub growth canary, the classified rate-limited Capacity-error triggers with generic-teardown suppression, and zero-copy relay writes, together with the full §5 TDD test list (items 1-11) and the dual-role e2e spec.

### Explicit constraints
- Skip the-usual Stages 1-3 (plan writing, load-bearing validation, plan review); the plan is already committed on main (PR #850) after its commissioned independent review round. Run Stage 0 (workspace + baseline), Stage 4 (task-by-task execution with per-task reviews), Stage 5 (delta Fresh Eyes, up to five rounds), and Stage 6 (recap).
- Red-green-refactor TDD for every behavior change; never skip the tests or the refactor step.
- Repo rules: branch the-usual/codex-proxy-ws-frame-cap from origin/main in .worktrees/; the pre-worktree green-base check runs via scripts/base-gate.sh test; broad tests go through the shared coordinator.
- The affected e2e specs must pass on the configured FRESHELL_E2E_BACKEND (cloud) before any PR is filed; a spec that matches no tests is not coverage.
- Do not restart or redeploy the live 3001 production server; deploy is out of scope and the change is inert until a user-approved deploy.
- Do not create a PR, merge, push finalization, or clean up the branch; PR creation requires explicit user approval — stop after the recap.

### Accepted tradeoffs and residuals
- The memory decision is stated arithmetic with no measurement apparatus (user-approved overbuild cut); the hub's unbounded channels are pre-existing and stay out of scope.
- Panes keep blinking until the user-approved production deploy; this change is inert until then.
- The plan's independent review loop ran once by user commission (verdict FAILED, both findings fixed); no further plan reviews run in this execution.

## 1. Problem

Since ~11:47 AM PDT on 2026-10-19, every Freshell-managed codex terminal pane blinks:
the codex TUI repaints ~1.5×/second and visibly flickers (worst right after a browser
refresh). Six concurrent panes were affected; app-servers pinned at ~100% CPU;
Freshell's server log flooded with ~30K `codex_proxy_repair_trigger` pairs per hour
("upstream connection errored" + "client connection errored").

### Root cause (verified end-to-end on the live system)

1. The codex TUI polls `plugin/list` (mention-autocomplete refresh, ~2×/sec while the
   composer is active).
2. `plugin/list`'s response now embeds the entire `openai-curated-remote` cloud
   catalog — **7,588 remote plugins, 17.8 MB** (measured; 0.164.0-alpha.7 is 16.97 MB,
   so upgrading codex does not fix it). The catalog crossed the threshold on Oct 19
   (on-disk growth: 5,997 plugins Oct 8 → 6,153 Oct 11 → 7,583 today).
3. Freshell's codex remote proxy dials the pane app-server with tokio-tungstenite
   **0.24 default `WebSocketConfig`: `max_frame_size = 16 MiB`** (`remote_proxy.rs` —
   bare `connect_async`/`accept_async`, no config passed). The 17.8 MB single-frame
   response exceeds the cap by ~1 MB.
4. The proxy's upstream read fails with a tungstenite **Capacity** error → stream
   errors → hub tears down both sides → TUI reconnects with its full startup sequence
   (including `thread/resume` of very large sessions) → `plugin/list` again → dies →
   infinite ~1.5 s loop.
5. Each cycle's `thread/resume`-then-teardown makes the app-server broadcast
   `thread/goal/cleared` to all clients; the pane's stable TUI connection repaints
   per broadcast → **the blink**.

Why only us: a direct TUI↔app-server user has no 16 MiB-capped reader in the middle.
Freshell is (essentially uniquely) a WS intermediary between codex TUIs and their
app-servers.

**Legacy-parity note (this was a port regression):** the retired Node proxy configured
its `ws` servers with `maxPayload: this.maxRawForwardBytes` — the transport cap was
deliberately tied to the app-level policy. The Rust port silently dropped to
tungstenite's 16 MiB default, *below* the policy it was supposed to sit under.

**Precedent, and where it doesn't apply:** `docs/plans/2026-07-03-codex-fork-oom.md`
established the 64 MiB raw-forward cap as a *measured memory-safety boundary* —
but that regime was a Node proxy under `--max-old-space-size=128` (a 128 MB heap,
where a 64 MiB frame genuinely OOMs). This Rust server runs on hosts with orders
of magnitude more RAM; the cap raise here is a capacity decision made by stated
arithmetic (§4.5), not by a measurement apparatus the threat model doesn't justify.

Evidence artifacts from the RCA (not part of this PR): repair-trigger cadence matched
goal-clear broadcasts 1:1 at +165 ms; codex's own sqlite log shows the first
`plugin/list` failure at 18:47:27 UTC Oct 19 with none in the prior 15 h; a fresh
app-server + direct (non-proxied) probe returns the full 17.8 MB response fine.

## 2. Goals

1. Codex TUIs behind the Freshell proxy survive large (multi-MB) app-server frames —
   today's 17.8 MB `plugin/list` and foreseeable growth (§4.4).
2. Every over-policy frame fails **closed, fast, and diagnosably**: the transport
   rejects an oversized single frame from its header (only a read-chunk of payload
   can slip ahead of the header — the full oversized frame is never buffered)
   with a distinctly classified repair trigger; no over-policy frame is ever
   relayed, and no generic mystery errors remain.
3. This failure class becomes diagnosable in one log line instead of a multi-hour RCA.
4. All production tokio-tungstenite call sites in `crates/freshell-codex` are
   normalized — not just the one that fired.
5. Catalog growth approaching the next threshold is *visible* before it becomes an
   incident, without recreating a log flood.

## 3. Non-goals

- **No semantic change to the hub's rejection code** (typed repair trigger +
  close), and it is retained as belt-and-suspenders — but its *reachability*
  changes at equality and that is stated up front: oversized frames in BOTH
  directions now fail at the transport (from the header, with the classified
  Capacity trigger) and never reach the hub, so the hub's JSON-RPC error replies
  for oversized frames become unreachable at production equality (kept and tested
  via injected asymmetry). Versus the OLD mixed-cap regime the net client-frame
  behavior is strictly better: 16–256 MiB client frames previously died silently
  at the 16 MiB transport and now flow; >256 MiB frames die with a DISTINCT
  classified trigger instead of a generic error. Its *value* rises 64 → 256 MiB
  (§4.1) because at current growth the old value re-triggers this same
  reconnect-loop incident in ~7 weeks (§4.4) — and the raise is re-measured per
  §4.5.
- **No change** to the browser-facing WS layer (`freshell-ws` axum upgrade +
  `ws_max_payload_bytes`, a deliberate configured policy for the SPA contract).
- **No backpressure rework.** The hub's unbounded channels are a pre-existing
  architectural property (§7); this PR does not claim to bound them.
- **No codex-side work** in this PR (upstream filing is immediate parallel work; §10).
- No env knobs/config surface for the new caps (threat model: good-faith users; a
  knob would still need a restart to take effect, saving only PR overhead — the
  one-constant derivation in §4.1 is the maintenance path).
- No pane/sidecar restart tooling changes — after the fixed server deploys, panes
  self-heal on the TUI's next reconnect.

## 4. Design

### 4.1 One base constant, derived caps, feature-gated config

**Constant placement (feature discipline):** `tokio-tungstenite` is an *optional,
default-off* dependency (`real-transport` feature), so the constants live in
always-compiled code — `remote_proxy_envelope.rs`, where `MAX_RAW_FORWARD_BYTES`
lives today — and only the `WebSocketConfig`-returning builders sit behind the
feature:

`crates/freshell-codex/src/remote_proxy_envelope.rs` (always compiled):

```rust
/// The single source of truth for the PROXIED raw-forward path: the per-frame
/// app-level policy. Hub policy = this value; proxy transport caps = THE SAME
/// value (equality — see below). Bump THIS ONE literal for proxy-cap
/// maintenance; every proxied limit derives from it and the invariant tests
/// revalidate.
pub const MAX_CODEX_FRAME_BYTES: usize = 256 * 1024 * 1024;

pub const MAX_WS_FRAME_BYTES: usize = MAX_CODEX_FRAME_BYTES;   // proxy transport
pub const MAX_WS_MESSAGE_BYTES: usize = MAX_CODEX_FRAME_BYTES; // proxy transport

/// Independent, conservative cap for the fresh-lane client. This lane
/// full-parses responses (`serde_json::Value`) and clones values, so its
/// memory cost amplifies ~3-4x per byte. Its large traffic is thread reads —
/// paginated in the normal reveal path, BUT snapshot/rollback issue
/// `thread/read` with `includeTurns: true` (full thread in one response;
/// `app_server.rs:530–545`, `freshell-freshagent/src/codex.rs:7854–7902`),
/// so a very large session can legitimately exceed this cap. 64 MiB is
/// legacy-parity (the Node proxy's maxPayload-tied policy), 4x the legacy
/// Rust behavior (tungstenite's 16 MiB default, under which those same
/// full-thread reads die SILENTLY today — `transport.rs` collapses recv
/// errors to `None`), and ~3.6x today's largest real frame. If a real
/// session's full-thread read exceeds it, the new production-visible error
/// (§4.3.1) says so; raising it is this one constant, same arithmetic.
/// Do NOT derive it from the proxy policy.
pub const MAX_LANE_FRAME_BYTES: usize = 64 * 1024 * 1024;       // fresh lane

pub const CANARY_BYTES: usize = 32 * 1024 * 1024;              // growth canary
```

`crates/freshell-codex/src/ws_config.rs` (`#[cfg(feature = "real-transport")]`):

```rust
// Verified against vendored sources: tungstenite 0.24's ROOT re-export list is
// `protocol::{Message, WebSocket}` only — WebSocketConfig is NOT at the root.
// tokio-tungstenite 0.24 re-exports the crate (`pub use tungstenite;`), so the
// path through this crate's existing deps is:
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;

pub fn proxy_ws_config() -> WebSocketConfig { ... }   // caps == policy
pub fn lane_ws_config() -> WebSocketConfig { ... }    // caps == lane constant
```

**Why equality (transport caps == policy), not a 2x window:** an earlier draft sat
the transport at 2x the policy so over-policy frames would reach the hub's typed
rejection. Two facts make equality strictly better: (1) tungstenite rejects a
single frame whose *header* declares a length over `max_frame_size` **before
buffering any payload** — a 2x window would fully buffer up to 512 MiB only to
have the hub throw it away, a self-inflicted memory worst case; (2) this plan
*classifies* transport Capacity errors into a distinct, diagnosable repair trigger
(§4.3.1), which is what the 2x window was trying to preserve. Equality is also
exact legacy parity (the Node proxy set `maxPayload == maxRawForwardBytes`). The
hub's own check remains unchanged as belt-and-suspenders (it still guards
rewritten/constructed frames and any asymmetry), but at equality the transport is
the boundary that fires in practice, and it fails closed with zero payload
buffering for single frames.

Both build states must keep compiling: `cargo check -p freshell-codex` (no
features) and `--features real-transport` are both part of the verification steps.

Call-site API notes (verified against the vendored 0.24 sources):

- `connect_async_with_config(request, Option<WebSocketConfig>, disable_nagle: bool)`
  — **three** arguments in 0.24. Pass `disable_nagle = false` (verify during
  implementation that bare `connect_async` passes `false`, so behavior is unchanged).
- `accept_async_with_config(stream, Option<WebSocketConfig>)`.
- `WebSocketConfig` values in tests are injected through `CodexRemoteProxyOptions`
  (mirroring the existing `max_raw_forward_bytes` option), so boundary tests run with
  small numbers instead of allocating hundreds of MiB.

`MAX_RAW_FORWARD_BYTES` in `remote_proxy_envelope.rs` becomes
`MAX_CODEX_FRAME_BYTES` (re-export or replace; grep for hardcoded 64 MiB references
in tests and docs and update).

### 4.2 Call-site inventory (production, `crates/freshell-codex`)

| Site | Role | Config |
|---|---|---|
| `remote_proxy.rs:549` `connect_async` | proxy → app-server dial (**the incident trigger**) | `proxy_ws_config()` |
| `remote_proxy.rs:465` `accept_async` | TUI → proxy accept | `proxy_ws_config()` |
| `transport.rs:39` `connect_async` | fresh-lane app-server client (`TungsteniteTransport`) | `lane_ws_config()` (§4.5) |
| `launch_lifecycle.rs:1245` `connect_async` | app-server spawn readiness probe | `lane_ws_config()` |
| `sidecar_reconcile.rs:511` `connect_async` | boot-time sidecar reconcile probe | `lane_ws_config()` |

Other test-only call sites stay as-is, **except** the new/extended tests this PR adds,
whose client/peer sides must use the shared configs — an unconfigured test client or
peer would reject the very frames the tests assert on.

### 4.3 Observability

1. **Capacity-error classification — proxy AND lane, with teardown suppression.**
   In `remote_proxy.rs`, both stream loops currently surface every transport
   error as a generic "connection errored" repair trigger. Match
   `tungstenite::Error::Capacity` and emit a distinct trigger whose message embeds
   the **actual** error text and the **configured** limit — verified: tungstenite
   0.24's `CapacityError::MessageTooLong { size, max_size }` renders as
   "Message too long: {size} > {max_size}", so the trigger records the oversized
   magnitude without any invented "frame over X" claim. Two flood controls make
   the promise real, because rate-limiting the classified line ALONE still
   leaves the generic teardown pair (upstream/client "connection errored") from
   the SAME connection flooding at ~2 lines/cycle — the incident's own signature:
   (a) the classified Capacity trigger gets its **own** rate limit — a separate
   last-warned `Instant` from the canary's (§4.3.2), same default interval. It
   must NOT share the canary's limiter: a growth sequence inherently fires the
   canary first (real traffic crosses 32 MiB before it crosses 256 MiB), and a
   shared limiter would then suppress the first Capacity line of the very next
   over-cap incident — re-creating the silent failure this plan exists to close.
   (b) a connection whose teardown follows a
   Capacity-classified error emits **no additional generic pair triggers** — the
   classified line IS the record for that connection. Net: a >cap reconnect loop
   logs ≤ 1 line per interval per proxy. The fresh lane's
   `TungsteniteTransport::recv` error arm gets the same classification as a
   production `tracing::warn!` (§5.4) — the diagnostic goal covers both
   transports.
2. **Growth canary — hub ingest, for the under-cap growth zone.** Warn with a
   named event when a frame exceeding `CANARY_BYTES = 32 MiB` reaches the hub —
   placed at the **ingest arms** of `handle_upstream_frame`/`handle_client_frame`,
   before the policy check. Scope, stated exactly: at equality an over-cap frame
   is rejected by the transport and **never reaches the hub**, so this canary
   covers the growth zone *below* the cap (32 MiB → 256 MiB) — the months of
   warning as real traffic grows. The over-cap zone is covered by the
   rate-limited Capacity trigger (§4.3.1). Emission is rate-limited **per proxy**
   (a last-warned `Instant` on the hub; default minimum interval 10 minutes,
   injectable via `CodexRemoteProxyOptions` for tests) — NOT per connection:
   per-connection emission would flood during a big-frame reconnect loop
   (~40/min/pane); a proxy-wide interval bounds it to one line per interval
   regardless of connection churn.
   nothing the operator needs — the warning repeats until the caps are bumped.
3. **Module docs.** `remote_proxy.rs`'s module documentation explicitly states "No
   protocol-level (tungstenite) frame-size cap is configured" — that line becomes
   false. Update it to document the configured caps, the equality invariant, the
   canary, and the legacy `maxPayload` parity note.

### 4.4 Growth horizon (honest math)

Measured catalog growth: 5,997 plugins (Oct 8) → 6,153 (Oct 11) → 7,583 (Oct 19/20):
+17.5%/week overall, +23% in the final 9-day window. Planning at ~20%/week, from
today's 17.8 MB largest frame:

- 256 MiB policy (and, at equality, the transport cap) reached in ~15 weeks
  (268 MB / 17.8 MB = 15.1x; ln 15.1 / ln 1.20 ≈ 14.9 weeks).

Why the hub policy must rise now (not "later"): at 20%/week the *old* 64 MiB policy is
crossed in ~7–8 weeks — and an over-policy `plugin/list` rejected by the hub closes
the connection exactly like the transport error did, restarting the same reconnect
loop in December. Deferring the raise schedules the incident; the canary (§4.3.2)
makes the next threshold visible months out.

Explicit growth response, so this is a monitored runway rather than a surprise:

1. The canary fires at 32 MiB — months of warning.
2. Future bumps are ONE-literal changes (`MAX_CODEX_FRAME_BYTES`); the derived caps
   and the invariant tests revalidate automatically (§5.5).
3. The durable fix is upstream (codex-side pagination/response budgets — the 0.164
   alphas contain related rework but do not yet shrink `plugin/list`); the upstream
   filing (§10.1) is immediate parallel work.

### 4.5 Memory decision: arithmetic, not apparatus

No VmHWM harnesses, self-spawning children, or memory-budget tests. The threat
model (good-faith peers, no hostile input) plus the deployment class (256 GB
hosts) means the cap raise is a capacity decision with stated arithmetic, not a
measured-safety claim. The numbers:

- **Over-cap single frames cost ~nothing:** tungstenite rejects a single frame
  whose *header* declares a length over `max_frame_size` before buffering the
  payload (equality makes this the over-policy path, §4.1).
- **Per-frame transient:** an accepted frame is fully read (plus tungstenite's
  retained read/write buffer capacity on live sockets) — ≈ 4× frame ≈ 1 GiB at
  the 256 MiB policy; ≈ 71 MiB at today's real 17.8 MB maximum. Six panes at the
  pathological cap simultaneously ≈ 6 GiB, on a 256 GB host. Small-host
  installs get the same constants with the same arithmetic visible here; the
  canary (§4.3.2) fires long before real traffic approaches the cap.
- **Not bounded, unchanged, out of scope:** total per-pane memory under a slow
  consumer (the hub's unbounded channels are pre-existing; a slow TUI can queue
  repeated accepted frames exactly as before this PR).
- **What the 2026-07-03 OOM plan's discipline DOES still mean here:** the
  raw-forward relay path stays parse-free (byte-level envelope scanner, `Vec<u8>`
  moved through channels, no `serde_json::parse` of large frames).

Two real changes remain in scope because they are cheap and load-bearing, not
because a gate demands them:

- **Eliminate the relay-write copy.** `to_ws_message`
  (`remote_proxy.rs:624–630`) converts every text frame with
  `String::from_utf8_lossy(&frame.data).into_owned()` — because it *borrows*
  `frame.data`, `into_owned()` allocates a full copy even for valid UTF-8 (and
  every relayed frame is valid UTF-8 by the invariant in its own comment).
  Replace with `String::from_utf8(frame.data)` — a partial move of the `Vec` out
  of the owned `OutFrame` (zero-copy) — falling back to the lossy path only via
  `FromUtf8Error::into_bytes()` when the invariant is actually violated.
  Pinned by a cheap unit test (§5.9): the returned `String`'s pointer equals the
  moved buffer's.
- **Fresh lane gets the smaller independent cap** (64 MiB, §4.1) because it
  full-parses responses (`parse_incoming_frame` builds a `serde_json::Value`
  tree and clones values — a byte costs several bytes there), its traffic is
  thread reads, never the catalog payloads (with the honest full-thread
  caveat and status-quo comparison stated in §4.1), and its over-cap errors
  become production-visible (§4.3.1). No lane memory harness either: a 64 MiB parse
  transiently costs a few hundred MiB — bounded by the cap, fine on this
  deployment class, same arithmetic standard.

## 5. TDD plan

Red → green → refactor, per repo rules. WS tests run behind the crate's
`real-transport` feature.

1. **Proxy relay of an oversized upstream frame (RED today).** Real peer app-server
   answers a request with a single 20 MiB text frame. `CodexRemoteProxy` (production
   configs via the options default) relays it; the **test client also connects with
   `proxy_ws_config()`** so its own read limit doesn't reject the frame. Assert
   byte-identical arrival. Proves the *dial* side. Today: red (`UpstreamErrored`).
2. **Proxy relay of an oversized CLIENT frame (proves the accept side).** The test
   client sends a 20 MiB request frame; the upstream peer receives it. Without the
   accept-side config this dies at the TUI-facing reader — this test is the one that
   fails if only the dial side is configured.
3. **Over-policy rejection, both layers — UPSTREAM direction (the incident
   direction).** Two sub-tests with injected small caps: (i) **at production
   equality** (transport == hub policy, e.g. both 1 MiB): a 2 MiB upstream
   response frame is rejected by the *transport* from its header — distinct
   classified Capacity trigger (§4.3.1, rate-limited), connection closed, **no
   JSON-RPC error reply** to the client. (Do NOT assert the *style* of close the
   peer observes: the existing teardown sends `WriterMsg::Close`, a proper WS
   close frame — that behavior is expressly unchanged.) (ii) **hub
   belt-and-suspenders** (injected asymmetry: transport 4 MiB > hub 1 MiB): the
   frame reaches the hub and produces the upstream-path rejection — trigger
   "rejected an unsafe upstream frame: raw_forward_cap_exceeded" + close + no
   JSON-RPC error reply — pinning the hub's guard semantics independently of the
   transport. The existing 256-byte-limit test covers the client→upstream path
   ("rejected a JSON-RPC frame because it is too large" + JSON-RPC error reply) —
   keep it; do not conflate the directions. Add the mirror of (i) for the
   CLIENT direction at production equality (injected equal small caps, oversized
   client frame → transport reject with the classified trigger, no JSON-RPC
   error reply) — the existing 256-byte test's lowered hub limit exercises only
   the injected-asymmetric case and cannot cover production equality.
4. **Fresh-lane transport.** `TungsteniteTransport` (with `lane_ws_config()`)
   round-trips a 20 MiB message; the test's fake app-server (accepting side) is
   configured the same way. **Over-cap causality — production-visible, not
   test-only:** `TungsteniteTransport::recv` currently collapses every read error
   to `None` (surfaced as `CodexAppServerError::Closed`); the change adds a
   production `tracing::warn!` carrying the actual transport error text and the
   configured limit in the error arm (so an over-cap response is diagnosable from
   the server log, per Goal 3), plus the error-preserving test seam. The test
   asserts the recorded cause is the *capacity* error from the configured size
   limit, not an unrelated disconnect.
5. **Config-propagation unit tests.** Assert `proxy_ws_config()`/`lane_ws_config()`
   return the expected field values, and that `CodexRemoteProxyOptions`'s defaults
   install them — not just the constants (a constant test passes while a socket still
   runs defaults). Together with tests 1–2 (which exercise both installed ends), the
   configured cap is established end-to-end.
6. **Invariant guard.** Unit test: `MAX_WS_FRAME_BYTES == MAX_CODEX_FRAME_BYTES`
   (and message — the equality design, §4.1) and
   `MAX_LANE_FRAME_BYTES < MAX_CODEX_FRAME_BYTES` (the lane cap is deliberately
   independent and conservative) — derivation integrity, so a future one-literal
   bump cannot leave the proxied limits coupled wrong.
7. **Canary + trigger boundedness (three assertions).** Injected small threshold and
   interval: (a) a simulated >cap reconnect loop (several connect/send-overcap/
   teardown cycles within the interval) yields at most one warning line per
   interval for the proxy — counting ALL `codex_proxy_repair_trigger` events,
   since the generic teardown pair is suppressed behind the classified Capacity
   trigger (§4.3.1b); (b) an over-cap frame produces the rate-limited Capacity
   trigger (not the hub canary — at equality the frame never reaches hub
   ingest, pinning the division of coverage between §4.3.2 and §4.3.1);
   (c) the growth-incident sequence: an under-cap frame over the canary
   threshold (canary warns), followed within the interval by an over-cap frame,
   still produces the Capacity trigger — the limiters are independent
   (§4.3.1a), so a canary warning must never suppress the first over-cap
   diagnostic.
8. **Capacity-trigger test.** Injected tiny transport cap forces a Capacity error;
   assert the distinct trigger text embeds the actual error and configured limit.
9. **Zero-copy unit test.** `to_ws_message` passes a `Vec` with known contents and
   the returned `String`'s pointer equals the moved buffer's (no second
   allocation) — the regression pin for the copy elimination (§4.5).
10. **Build-state tests.** `cargo check -p freshell-codex` (no features) and
    `--features real-transport` both compile — the constants are ungated and the
    config builders are gated (§4.1).
11. **CI wiring.** Confirm `.github/workflows/rust-tests.yml` runs `freshell-codex`
    with `real-transport`; wire it if not, so tests 1–9 run in the required
    `rust-gate`.

### E2E coverage (repo fixtures make it deterministic — with two fixture changes)

Managed codex terminal e2e tests use `installDualRoleCodexCli`
(`test/e2e-browser/fixtures/codex-dual-role.ts`), which launches
`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` — NOT the
`test/e2e-browser/fixtures/providers/fake-codex-app-server.mjs` fixture. And the
fake terminal (`fake-codex-terminal.mjs`) today connects, sends `initialize` +
`thread/start`, and closes — it never polls `plugin/list`, so the incident path
is unreachable without fixture work. The spec therefore requires BOTH:

- **Fake app-server** (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`):
  a behavior-flag-gated handler answers `plugin/list` with a deterministic 20 MiB
  response (existing specs unaffected; flag off by default).
- **Fake terminal** (`fake-codex-terminal.mjs`): a behavior-flag-gated mode that,
  after `initialize`, requests `plugin/list` **on the same persistent
  connection**, consumes the full response, then proves liveness with a follow-up
  request instead of closing (today's `ws.close()` at the end of the startup
  sequence is skipped in this mode).

New spec (e.g., `codex-terminal-large-frame-rust.spec.ts`), full sequence — the
fake terminal performs its managed handshake only after the first stdin Enter, so
the pane alone cannot reach the incident path:

1. Create a managed codex pane against the dual-role fixtures (both behavior flags
   on).
2. Send a first terminal submission (`send-keys` + Enter) — this triggers the
   fake terminal's `initialize` + `thread/start` handshake.
3. In the gated mode, the fake terminal then requests `plugin/list` **on the same
   persistent connection**, consumes the full 20 MiB response, and writes an
   observable marker (a line echoed to the PTY by the fixture) once consumption
   completes.
4. The spec asserts the marker via pane capture — the 20 MiB response was actually
   consumed — then a follow-up request on the same socket gets an observable
   response (asserted through pane capture; stdin alone wouldn't prove the
   socket lives), and the server log shows no repair-trigger churn for this
   terminal.

This is the incident's exact flow at end-to-end fidelity. Per AGENTS.md, the
affected e2e specs must pass on the configured `FRESHELL_E2E_BACKEND` before the
PR is filed (and a spec that matches no tests is not coverage).

## 6. Implementation steps

1. Re-verify vendored 0.24 details at the keyboard: the three-argument
   `connect_async_with_config`, bare `connect_async`'s `disable_nagle` value, and the
   `tokio_tungstenite::tungstenite::protocol::WebSocketConfig` path (compile check).
2. Add the constants to `remote_proxy_envelope.rs` (always compiled) and the
   feature-gated `ws_config.rs` config builders (unit tests §5.5–6); verify both
   build states compile.
3. Red: integration tests §5.1 and §5.2 — expect failures on current main.
4. Switch the five call sites; add config + canary-threshold/interval overrides to
   `CodexRemoteProxyOptions`; replace/raise `MAX_RAW_FORWARD_BYTES`; make
   `to_ws_message` zero-copy (§4.5); grep for hardcoded 64 MiB references in tests
   and docs and update.
5. Green: §5.1–2 pass; add §5.3–9.
6. Refactor: shared config helpers only; no hub-semantics changes beyond the constant.
7. Observability: Capacity classifier with dynamic message, canary with the
   **proxy-wide rate limit** (§4.3.2 — NOT per-connection emission); update the
   `remote_proxy.rs` module docs (§4.3.3).
8. `cargo fmt`, `cargo clippy` (workspace), targeted
   `cargo test -p freshell-codex --features real-transport`.
9. Commit; push branch; pre-push gate (pre-push-gate.md). PR after user approval;
   `rust-gate`.must pass.

## 7. Risks and mitigations (honest)

- **Memory.** The transport caps bound a *single frame's* read (over-cap single
  frames never buffer at all — header rejection); they do **not** bound total
  per-connection memory. The hub's channels are unbounded (pre-existing,
  unchanged): repeated large responses can accumulate while a client reads
  slowly — exactly as before this PR. The per-frame transient is ≈ 4× frame
  (tungstenite's retained read/write buffers plus the payload — the multiplier
  belongs to the library, the constant sets the absolute worst), so ≈ 1 GiB at
  the 256 MiB policy and ≈ 71 MiB at today's real 17.8 MB maximum (arithmetic
  and multi-host honesty in §4.5; deliberately NOT verified by a measurement
  apparatus — see §4.5). The fresh lane's parse amplification is capped at its
  independent 64 MiB constant. Under the good-faith threat model this is
  accepted and stated rather than papered over; backpressure rework is a
  non-goal.
- **API drift (tungstenite 0.24):** the three-argument signature, `disable_nagle`,
  and the protocol-path import are re-verified with a compile check in step 1.
- **Hub policy semantics:** only the constant changes (64 → 256 MiB); tests pin both
  rejection directions (§5.3 + the existing client-direction test).
- **Deploy requires the production restart** of the self-hosted 3001 server — only
  with explicit user approval ("APPROVED"). Until then the panes keep blinking; the
  change is inert until deploy.
- **Soul-backed panes restart separately.** For soul-backed codex panes the proxy
  runs inside `freshell-session-host`, and (per the self-hosted launch runbook)
  a running soul keeps its original session-host binary — a server-only restart
  does NOT change those panes' proxies; they keep hitting the old cap until
  their soul/session-host restarts (its own approval path). Today's incident
  panes were all server-hosted (verified during the RCA: every proxy listener
  was attributed to the freshell-server pid), so the server restart fixes the
  observed incident — but the runbook below verifies ownership rather than
  assuming it, and any pane still blinking after the server restart identifies
  itself as soul-backed.

## 8. Post-deploy verification (runbook)

1. Deploy the new build to the 3001 server (user-approved restart).
2. **Verify proxy ownership, don't assume it:** confirm the affected panes' proxy
   listeners are owned by the new freshell-server process (the same `ss`/`/proc`
   attribution used in the RCA). Any pane whose proxy listener still belongs to a
   `freshell-session-host` process is soul-backed and stays on the old binary
   until its soul restarts — surfaced to the user, not silently assumed fixed.
3. Watch fresh log tail: `codex_proxy_repair_trigger` rate drops from ~50–100/min/pane
   to ~0; pane TUIs stop blinking within one reconnect cycle (~1.5 s) — no pane
   restarts needed (for panes whose proxy the restart actually replaced).
4. App-server CPU normalizes; the `plugin/list failed` spam in `~/.codex/logs_2.sqlite`
   stops — verified by the failure-event rate, not by file size or mtime: count
   new `plugin/list failed` rows in codex's `logs_2.sqlite` over a 5-minute
   window before and after the deploy (the count is the signal; WAL size/mtime
   are not — SQLite can reuse a WAL without changing its size, and ordinary
   writes keep touching its mtime).
5. SQLite disk effects, stated precisely — "stops growing" and "space reclaimed"
   are different outcomes: once the write storm stops, the 911 MB
   `logs_2.sqlite-wal` **stops accumulating storm writes but is not reclaimed**
   (checkpoints reuse WAL pages rather than truncating the file), and the 5.2 GB
   `thread_history_1.sqlite` does not compact at all without an explicit
   `VACUUM`. The verification is the failure-event rate above. Reclamation, if
   wanted, is separate deliberate maintenance —
   `PRAGMA wal_checkpoint(TRUNCATE)` for the WAL, `VACUUM` for the database —
   explicitly NOT part of this PR and not a success criterion.
6. Growth canary is quiet (no frames > 32 MiB yet); revisit caps if it fires.

## 9. What this does not fix (honesty section)

- Upgrading codex (0.164.0-alpha.7 measured at 16.97 MB — over the old cap, far
  under the new ones).
- The upstream codex bugs that made the failure catastrophic rather than one failed
  request: unbounded plugin-list reconnect loop, `thread/goal/cleared` broadcast per
  cycle, and a 17.8 MB mention-autocomplete payload polled 2×/sec.
- Any latency/repaint behavior of the TUI itself.
- The unbounded hub queues (pre-existing; §7).

## 10. Follow-ups (separate work)

1. **File upstream with openai/codex immediately, in parallel with this PR** (RCA
   data + repro: plugin/list → connection reset ~1012 ms; unbounded reconnect loop;
   goal-clear broadcast per cycle; 17.8 MB autocomplete payload polled 2×/sec).
   Upstream pagination/response budgets are the durable fix for catalog growth.
2. When the §4.3.2 canary fires: bump `MAX_CODEX_FRAME_BYTES` (one literal; derived
   caps + invariant tests revalidate) and push the upstream issue.
3. Watch codex releases for response-budget/pagination landing on stable (0.164.0's
   #55301 work targets this area but does not yet shrink the response).
