# Crash Resilience for Coding-Agent Terminal Panes — Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** When a coding-agent terminal pane's CLI process (claude/codex/opencode/amplifier) crashes (non-zero exit), the server auto-resumes it up to 2 times with backoff and a visible notice; when it settles exited, the client shows a loud error bar with the exit code and a one-click Relaunch button — never a silent grey icon.

**Architecture:** A new server-side orchestrator (`crates/freshell-ws/src/auto_resume.rs`) receives crash events from the existing PTY exit hook (which structurally excludes user kills), applies a pure eligibility decision (agent mode, non-zero exit, resumable identity, respawn cap, bounded `[2s, 10s]` schedule), and respawns via a seam extracted from the WS create path — reusing the existing resume-argv machinery (`resolve_coding_cli_command`), the D7 live-session guard, and the sessionRef lease. The client learns of the replacement via a new broadcast frame `terminal.replaced` (contract addition) and interim notices via the already-frozen-but-unused `terminal.status{recovering}` frame (zero contract change); it folds the new terminalId into the pane with the existing `applyReconcileAttach` machinery. Exit codes and notices live in a new ephemeral client slice (never persisted — avoids the Lane-D4-owned persistence shapes).

**Tech Stack:** Rust (tokio, workspace crates `freshell-ws`, `freshell-terminal`, `freshell-protocol`), TypeScript/React/Redux-Toolkit client, Zod-backed frozen WS contract, vitest, Playwright e2e.

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/agent-crash-resilience`, branch `feat/agent-crash-resilience`, based on `origin/main` (`7508149b`).
- Base suite must be green before feature work; broad suites are coordinator-gated (3 sibling lanes run concurrently): check `npm run test:status` first, WAIT if held.
- JS test invocations: `FRESHELL_TEST_SUMMARY="<why>" env -u FRESHELL_BIND_HOST npm test` for the broad suite; focused runs via `npm run test:vitest -- run <path>`.
- If `node_modules/tsx` is missing after `npm ci`: `ln -s ../node_modules/tsx node_modules/tsx` (per repo quirk; adjust to the actual relative path that resolves).
- Rust gates (required CI): `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` (toolchain 1.96.0).
- Port-contract CI is required: after any `shared/ws-protocol.ts` change run `npm run contract:generate`, commit all three regenerated JSONs, keep `npm run test:port` and `cargo test -p freshell-protocol --locked` green.
- NEVER touch the user's live server: never bind, restart, or kill anything on ports 3001/3002; no broad kill patterns (`pkill -f node` etc. are forbidden). E2E specs boot their OWN `RustServer` on ephemeral ports.
- Scope fence (do NOT touch): `crates/freshell-freshagent` crates; spawn gate / rate-limit internals (Lane D2); reconcile verdict derivation (`crates/freshell-ws/src/reconcile.rs` verdict logic); `persistMiddleware`/`paneTypes` persistence shapes (Lane D4); Lane D3's flake files (`restore-contract-wall` double-restart test, `remote-proxy.test.ts`, sidebar case-a). New e2e specs = new files; `playwright.config.ts` gets minimal appends only.
- README.md stays untouched; this plan under `docs/plans/` is the only new doc.
- PR POLICY: NOT approved. Push the branch, STOP before `gh pr create`, report branch + red→green proof.
- Commits: focused, atomic, conventional (`feat:`/`test:`/`refactor:`/`docs:`).

---

## Design Notes (read before Task 1)

### D-1. Why server-driven (and why the campaign plan's §4.5 rejection does not apply)

`docs/plans/2026-07-24-restart-resilience-architecture-analysis.md` §4.5 rejects **boot-time proactive respawn** for two reasons: (i) ownership semantics, (ii) spawn storms with zero observers. This feature is a different case and must remain so:

- It is **crash-triggered, per-terminal, for an already-created pane** whose ownership is established (the terminal row has a `createRequestId`; the pane ledger holds its resume-invocation record). No boot-time sweep, no guessing which panes a user wants.
- It is **bounded twice over**: by its own 2-element retry schedule AND by the existing respawn-generation cap (`respawn_exhausted`, cap 3 in a 30s liveness window) — an instantly-re-crashing CLI converges to `exited` in ≤2 retries. No storm is possible.
- The zero-observer objection is the **motivating scenario** (yente 2026-07-27: overnight run stopped silently for 6 hours). §4.1 Principle 4 rules: "auto-resume, not offer it as a choice… Silently-wrong is worse than an honest error." Client-executed respawn would fail exactly when it matters (no client connected), so the server must spawn.

### D-2. Frame shapes (evaluated per spec)

- **Interim notice — reuse `terminal.status`** (`shared/ws-protocol.ts:771-777`): `{terminalId, status:'running'|'recovering', reason?: string, attempt?: number}`. It is already in the frozen inventory, already dispatched client-side (`TerminalView.tsx:4087-4099`), and **currently emitted by nobody** (verified: zero emitters repo-wide). We emit `{status:'recovering', reason:'claude crashed (exit 1) — auto-resuming, attempt 1/2', attempt: 1}` on the OLD terminalId before each backoff sleep. Zero contract change. The missing `maxAttempts` rides in `reason` text; the client also learns it from `terminal.replaced`.
- **Client-side frame matching (VERIFIED constraint — drives Task 6's data model):** TerminalView's `terminal.exit` handler deliberately CLEARS `terminalIdRef` and `paneContent.terminalId` (`TerminalView.tsx:4141-4148`, commented as load-bearing). So frames targeting the OLD terminalId (`terminal.status{recovering}`, `terminal.replaced{oldTerminalId}`) arriving after exit processing can NOT be matched via `paneContent.terminalId`. The lifecycle slice is therefore keyed by **paneId** and records `lastTerminalId` at exit time (the pane's own exit handler still receives its `terminal.exit` while the id is set, and dispatches the record BEFORE clearing). Old-id frames are matched against the pane's recorded `lastTerminalId`, and the banner selectors are keyed by paneId (always available on an exited pane).
- **Replacement — new frame `terminal.replaced`**: no server→client "your terminal was replaced" frame exists today (every respawn is client-initiated via `terminal.create`). Additive contract change per the documented Route-C procedure (Task 3): `{type:'terminal.replaced', oldTerminalId, newTerminalId, exitCode, attempt, maxAttempts}`. Broadcast on the `broadcast_tx` bus (same lane as `terminals.changed`).
- **Exhaustion — nothing new**: the final generation's `terminal.exit{exitCode}` (already carries the code) + settled `exited` status drive the client error bar.
- **Offline clients**: need no frame — on reconnect, `pane.reconcile` finds the live replacement and returns an attach verdict; the existing `applyReconcileAttach` folds it. (We do not touch verdict derivation.) VERIFIED by desk-check: two independent attach paths cover this input — the sessionRef claim path (rule 6, `reconcile.rs:224-242`, live-only lookup so the retired old identity can't shadow) and the `newest_live_by_create_request_id` row path (row 1, `reconcile.rs:245-256`) — and verdict derivation keys on NO creator/attach provenance. NOTE (corrected detail): the `corrected` flag fires only on a *differing* sessionRef (`reconcile.rs:85-94`); a nominal same-session replacement yields `corrected: None`. Harmless — the fold applies `terminalId` unconditionally — but do not key anything on `corrected:true`. Because this is a desk-checked novel composite input, Task 5's integration test MUST include the reconcile-after-replacement scenario (mandatory pin test). A client reconnecting *during* the backoff gap gets a `Respawn` verdict and may client-respawn — the sessionRef lease arbitrates that race (whoever claims first wins; the loser aborts), which is exactly the D-5 guard design.

### D-3. Clean-exit presentation (decision + justification)

**Code 0 keeps today's quiet presentation** (grey icon + one-shot xterm message), for agent panes too. Typing `exit` / quitting claude is a deliberate end; a loud red bar on a deliberate quit is noise and would train users to ignore the bar. The incident was a *crash* (exit 1); loud is reserved for non-zero. User kills never reach the crash path at all (VERIFIED structural: `kill_internal` removes the row under the registry mutex BEFORE signaling — `registry.rs:1294`→`:1350` — and `finish_pty_exit` has two independent false-guards at `:1423`/`:1427`; all 8 production kill paths, including idle reap and freshagent kills, route through `kill_internal`).

Exit-code encoding (verified against portable-pty 0.8.1 source): signal deaths (SIGKILL/OOM) map to exit code **1** (`.code()==None → 1`) — non-zero, so crashes-by-signal correctly go loud, though signal identity is lost (all → 1, not 128+n; keep banner wording generic, "process exited (code 1)"). A `wait()` error maps to 0 (rare fake-clean; acceptable residual). Scope: this trigger model is verified for unix/WSL (the deployment target); native-Windows wrapper shells (`cmd /K`) survive CLI death, so the feature is simply inert there — not wrong.

Post-reload edge: the ephemeral exit-code slice is empty, so a persisted `status:'exited'` agent pane briefly shows a codeless "process exited" bar with Relaunch until reconcile adjudicates it. This is acceptable (an actionable affordance, strictly better than the silent grey icon) and is pinned in a test.

### D-4. Status tracker / chime survival (investigated and pinned)

The respawned terminal gets a NEW terminalId (`Uuid::new_v4()` per create, `crates/freshell-ws/src/terminal.rs:1239`; continuity rides `createRequestId` + sessionRef). Pinned behavior:

- **Server activity hub** (keyed by terminalId): `ActivityEvent::Exit` removes the old record (no stale busy); the respawned terminal is created through the normal create machinery, so it is tapped like any agent terminal (`mode != "shell"`).
- **Client fold**: `terminal.replaced` → `applyReconcileAttach` (the ONE reducer that writes a server-supplied terminalId into a live pane, `panesSlice.ts:1886`) → `resolvePaneActivity` and `selectTabPaneByTerminalId` immediately resolve via the new id.
- **Chime dedupe** (`turnCompletionSlice.ts`, per-terminalId monotonic maps): the new terminalId starts fresh — no wedge; `terminal.idle` on the OLD id is dropped by the existing owner-lookup guard (`turnCompletionThunks.ts:25-26`) — no false chime. Task 8 pins all of this with tests, including that the old-id `terminal.detach` is suppressed via the skip list (`terminalDetachMiddleware.ts:14-28`).
- **Known, unchanged**: codex resume-busy seeding (`crates/freshell-ws/src/activity.rs:279-283`) can arm an unearned grace-gate chime on ANY codex resume — identical for today's client-driven respawn; not a regression of this feature and out of its scope. E2E uses the claude fake, unaffected.

### D-5. Retry budget semantics

- Schedule `AUTO_RESUME_DELAYS_MS = [2_000, 10_000]` (2 retries max), shaped after the repo's bounded-retry exemplar (`activity.rs:80-88` `lane_retry_delay_ms`: index = attempts-so-far, `None` = exhausted-and-loud). Env override `FRESHELL_AUTO_RESUME_DELAYS_MS="2000,10000"` (tests set `"50,100"`).
- Patience-window honesty (council 7w4h/xkhx follow-up): the total patience window is ~12s of backoff (2s + 10s) plus spawn time — outage-class causes (provider down, expired auth) will exhaust the budget and settle loudly. By design: auto-resume survives crashes, not outages.
- Attempts are counted per `createRequestId` in the orchestrator, **reset when the crashed generation lived ≥ 30s** (mirrors `DEFAULT_RESPAWN_LIVENESS_WINDOW_MS` — a healthy resume is not penalized; tomorrow's crash of an overnight pane starts at attempt 1).
- The registry's respawn-generation cap (`respawn_exhausted`, cap 3/30s — mutated by every natural exit in `finish_pty_exit`) is consulted as an **outer guard**, composing with client-driven reconcile respawns: whoever exhausts generations first, the pane converges to `exited`.
- Guards before each respawn (all post-sleep): D7 live-session (`registry.live_terminal_for_session_ref` — never a second `--resume <sid>` writer), sessionRef lease (`claim_session_ref` — never race a concurrent client create; VERIFIED: the lease is a registry-owned map keyed `provider\0sessionId`, connection-independent, and the identical object both the WS create ingress `terminal.rs:1149` and REST ingress contend on), and **binding-still-Bound** (re-check `pane_ledger.bound_session_ref_for_terminal` returns a live binding — a user who closed the pane during the backoff retires it via `retire_closed`, `terminal.rs:2716-2730`; if retired, settle `pane_closed`; this also bounds the crash-microseconds-before-kill race).
- A pane with **no resumable identity** (no sessionRef in identity registry/ledger) or **no createRequestId** settles `exited` immediately.
- **Per-provider identity provenance (VERIFIED — sets expectations for eligibility):** claude panes get a server-preallocated UUID passed as `--session-id` on the FIRST generation's argv, with identity + durable ledger binding written before create is answered (`terminal.rs:1280-1299`, `:1936-1964`) — resumable from a gen-1 crash. codex/opencode/amplifier session ids are discovered by locators only at the **first user prompt** — a crash before discovery has no identity and settles `no_resumable_identity` (loud banner + Relaunch: the correct degraded behavior, not a bug). E2E uses the claude fake, which matches the strongest (preallocated) provenance. **(2026-09-05: superseded — identity-grace is now the intended behavior: identity arriving inside the bounded grace converts the settle into a normal resume; `no_resumable_identity` settles only after grace exhaustion — kata kmbs, docs/plans/2026-09-05-auto-resume-hub-grace.md.)**
- **Cap facts (VERIFIED):** the generation counter's sole write site (`registry.rs:1450-1458`) increments only when the dying generation lived < 30s and RESETS the counter on a long-lived exit — an overnight-healthy pane starts its crash at a fresh cap. The counter is in-memory (resets at server restart) and counts fast clean exits too; both are acceptable for a bounding guard.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-ws/src/auto_resume.rs` | Create | Pure decision + schedule + orchestrator hub (all new server logic lives here) |
| `crates/freshell-ws/src/terminal.rs` | Modify | Extract shared exit-hook builder; add `respawn_agent_terminal` seam; send `CrashEvent` |
| `crates/freshell-ws/src/lib.rs` | Modify | `WsState.auto_resume_tx` field; export `auto_resume` module + spawn helper |
| `crates/freshell-server/src/main.rs` | Modify | Spawn the auto-resume hub (next to `spawn_idle_monitor` precedent, `:282`) |
| `crates/freshell-protocol/src/server_messages.rs` | Modify | `TerminalReplaced` variant; `[&str; 56]`→`57` |
| `crates/freshell-protocol/tests/inventory.rs` | Modify | Counts 56→57, 85→86; roundtrip test |
| `shared/ws-protocol.ts` | Modify | `TerminalReplacedMessage` type + union entry |
| `port/contract/*.json` (3 files) | Regenerate | `npm run contract:generate` output, committed |
| `src/store/terminalLifecycleSlice.ts` | Create | Ephemeral exit-code + auto-resume-notice state (never persisted) |
| `src/store/index.ts` (or wherever `panesSlice.reducer` is registered — locate with `grep -rn "panesSlice" src/store src/*.ts* | grep -i reducer`) | Modify | Register the new slice reducer |
| `src/components/TerminalExitBanner.tsx` | Create | Error bar + Relaunch button + notice strip (pure presentational) |
| `src/components/TerminalView.tsx` | Modify | Handle `terminal.exit`/`terminal.status`/`terminal.replaced` → slice + fold; render banner |
| `src/store/terminalDetachMiddleware.ts` | Modify (only if Task 8's test fails) | Skip-list entry for the fold action |
| `test/unit/client/store/terminalLifecycleSlice.test.ts` | Create | Slice unit tests |
| `test/unit/client/components/TerminalExitBanner.test.tsx` | Create | Banner/notice/a11y/click tests |
| `test/unit/client/components/TerminalView.exitBanner.test.tsx` | Create | Integration: banner + relaunch dispatch + fold + chime survival (next to the existing `test/unit/client/components/TerminalView.launchRetry.test.tsx` — VERIFIED repo convention: zero `*.test.*` files exist under `src/`; ALL client unit tests live in `test/unit/client/{store,components}/` and the vitest default include picks them up there) |
| `test/e2e-browser/fixtures/fake-crashing-claude-cli.mjs` | Create | Fake claude CLI: crash-once / crash-always / clean modes + argv JSONL log |
| `test/e2e-browser/specs/agent-crash-autoresume-rust.spec.ts` | Create | E2E: auto-resume, exhaustion banner, clean exit, relaunch |
| `test/e2e-browser/playwright.config.ts` | Modify | Two minimal regex appends (`RUST_ONLY_SPECS` + `rust-chromium` `testMatch`) |

Anything not in this table is out of scope for this lane.

---

### Task 0: Workspace verification + base suite green

**Files:** none created (verification only).

**Interfaces:**
- Consumes: worktree at `/home/dan/code/freshell/.worktrees/agent-crash-resilience` on `feat/agent-crash-resilience` @ `7508149b`.
- Produces: proven-green base for every later red→green claim.

- [ ] **Step 1: Verify worktree + branch + base**

Run (from the worktree root — ALL later tasks also run from the worktree root):
```bash
cd /home/dan/code/freshell/.worktrees/agent-crash-resilience
git status --short && git log --oneline -1
```
Expected: clean tree, `7508149b Merge pull request #548 …` (or newer origin/main if the workspace stage re-based).

- [ ] **Step 2: Install JS deps if needed**

```bash
[ -d node_modules ] || npm ci
node_modules/.bin/tsx --version 2>/dev/null || ln -s ../node_modules/tsx node_modules/tsx 2>/dev/null || true
```

- [ ] **Step 3: Check the coordinator gate, then run the base suites**

```bash
npm run test:status
```
If the gate is held by a sibling lane: WAIT and re-check (do not bypass). Then:
```bash
FRESHELL_TEST_SUMMARY="lane D1 base-green check before agent-crash-resilience work" env -u FRESHELL_BIND_HOST npm test
cargo test --workspace --locked
cargo clippy --workspace --all-targets -- -D warnings
```
Expected: all green. If the base is red in files owned by Lane D3 (its flake files), record the exact failing test names in the task notes and proceed ONLY if the failures are demonstrably pre-existing on `origin/main` (re-run the same test on a clean `origin/main` checkout to prove it). Any other base redness: STOP and report — do not build on a broken base.

- [ ] **Step 4: No commit** (nothing changed). Note the run results for the final report's baseline.

---

### Task 1: Auto-resume policy module (pure decision + schedule)

**Files:**
- Create: `crates/freshell-ws/src/auto_resume.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (add `pub mod auto_resume;` next to the existing module declarations)
- Test: in-file `#[cfg(test)] mod tests` (repo convention, cf. `registry.rs:2334`)

**Interfaces:**
- Consumes: nothing (pure).
- Produces (used by Tasks 2 & 5):
  - `pub(crate) const AUTO_RESUME_MODES: [&str; 4] = ["claude", "codex", "opencode", "amplifier"];`
  - `pub(crate) const AUTO_RESUME_DEFAULT_DELAYS_MS: [u64; 2] = [2_000, 10_000];`
  - `pub(crate) const AUTO_RESUME_HEALTHY_LIFETIME_MS: i64 = 30_000;`
  - `pub(crate) fn auto_resume_delays() -> Vec<u64>` (env-overridable)
  - `pub(crate) struct CrashContext<'a>` and `pub(crate) enum AutoResumeDecision` and `pub(crate) fn decide(ctx: &CrashContext, delays: &[u64]) -> AutoResumeDecision` — exactly as below.
  - `pub(crate) struct CrashEvent { pub terminal_id: String, pub exit_code: i64, pub mode: String, pub create_request_id: Option<String>, pub lifetime_ms: i64 }`

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-ws/src/auto_resume.rs` with ONLY the test module first (types referenced don't exist yet):

```rust
//! Bounded auto-resume for crashed coding-agent terminals (Lane D1).
//!
//! Policy: a coding-agent terminal (mode ∈ AUTO_RESUME_MODES) that exits
//! NON-ZERO is auto-resumed up to `delays.len()` times with backoff, from its
//! server-side identity (identity registry / pane ledger). Clean exits
//! (code 0) and user kills (structurally excluded upstream — `kill_internal`
//! removes the registry row so `finish_pty_exit` returns `false` and no
//! CrashEvent is ever sent) NEVER auto-resume. The registry's
//! respawn-generation cap is the outer loop bound (campaign plan §7.5).
//! Schedule shape mirrors the repo exemplar `activity.rs::lane_retry_delay_ms`.

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx<'a>() -> CrashContext<'a> {
        CrashContext {
            exit_code: 1,
            mode: "claude",
            create_request_id: Some("cr-1"),
            has_resumable_identity: true,
            lifetime_ms: 5_000,
            prior_attempts: 0,
            cap_exhausted: false,
        }
    }
    const DELAYS: [u64; 2] = [2_000, 10_000];

    #[test]
    fn nonzero_agent_exit_resumes_with_schedule() {
        assert_eq!(
            decide(&ctx(), &DELAYS),
            AutoResumeDecision::Resume { attempt: 1, delay_ms: 2_000 }
        );
        let c = CrashContext { prior_attempts: 1, ..ctx() };
        assert_eq!(
            decide(&c, &DELAYS),
            AutoResumeDecision::Resume { attempt: 2, delay_ms: 10_000 }
        );
    }

    #[test]
    fn clean_exit_never_resumes() {
        let c = CrashContext { exit_code: 0, ..ctx() };
        assert_eq!(decide(&c, &DELAYS), AutoResumeDecision::SettleExited { reason: "clean_exit" });
    }

    #[test]
    fn shell_mode_never_resumes() {
        let c = CrashContext { mode: "shell", ..ctx() };
        assert_eq!(decide(&c, &DELAYS), AutoResumeDecision::SettleExited { reason: "not_agent_mode" });
        // Unknown future modes are fail-safe too:
        let c = CrashContext { mode: "mystery", ..ctx() };
        assert_eq!(decide(&c, &DELAYS), AutoResumeDecision::SettleExited { reason: "not_agent_mode" });
    }

    #[test]
    fn all_four_agent_modes_are_eligible() {
        for mode in AUTO_RESUME_MODES {
            let c = CrashContext { mode, ..ctx() };
            assert!(matches!(decide(&c, &DELAYS), AutoResumeDecision::Resume { .. }), "mode {mode}");
        }
    }

    #[test]
    fn missing_identity_settles_exited_immediately() {
        let c = CrashContext { has_resumable_identity: false, ..ctx() };
        assert_eq!(decide(&c, &DELAYS), AutoResumeDecision::SettleExited { reason: "no_resumable_identity" });
        let c = CrashContext { create_request_id: None, ..ctx() };
        assert_eq!(decide(&c, &DELAYS), AutoResumeDecision::SettleExited { reason: "no_create_request_id" });
    }

    #[test]
    fn respawn_cap_exhaustion_settles_exited() {
        let c = CrashContext { cap_exhausted: true, ..ctx() };
        assert_eq!(decide(&c, &DELAYS), AutoResumeDecision::SettleExited { reason: "respawn_cap_exhausted" });
    }

    #[test]
    fn retries_are_bounded_and_exhaust_loudly() {
        let c = CrashContext { prior_attempts: 2, ..ctx() };
        assert_eq!(decide(&c, &DELAYS), AutoResumeDecision::SettleExited { reason: "retries_exhausted" });
    }

    #[test]
    fn healthy_lifetime_resets_the_attempt_counter() {
        // A generation that lived >= 30s means the previous resume was healthy:
        // this crash starts a fresh budget even with prior attempts recorded.
        let c = CrashContext { prior_attempts: 2, lifetime_ms: AUTO_RESUME_HEALTHY_LIFETIME_MS, ..ctx() };
        assert_eq!(
            decide(&c, &DELAYS),
            AutoResumeDecision::Resume { attempt: 1, delay_ms: 2_000 }
        );
    }

    #[test]
    fn delays_env_override_is_parsed_and_bad_values_fall_back() {
        assert_eq!(parse_delays_env("50,100"), Some(vec![50, 100]));
        assert_eq!(parse_delays_env("2000"), Some(vec![2000]));
        assert_eq!(parse_delays_env(""), None);
        assert_eq!(parse_delays_env("fast,slow"), None);
        assert_eq!(parse_delays_env("0"), None); // zero-delay loops are forbidden
    }
}
```

Add to `crates/freshell-ws/src/lib.rs`, next to the existing `pub mod`/`mod` declarations (e.g. beside `mod activity;`):
```rust
pub mod auto_resume;
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p freshell-ws auto_resume 2>&1 | tail -20
```
Expected: COMPILE ERROR — `CrashContext`, `decide`, etc. not found. That is the red state.

- [ ] **Step 3: Write the implementation (above the test module, same file)**

```rust
pub(crate) const AUTO_RESUME_MODES: [&str; 4] = ["claude", "codex", "opencode", "amplifier"];

/// Backoff before retry N (index = attempts already made). 2 retries max
/// per user ruling 2026-07-27. After the last entry: exhausted and LOUD.
pub(crate) const AUTO_RESUME_DEFAULT_DELAYS_MS: [u64; 2] = [2_000, 10_000];

/// A crashed generation that lived at least this long proves the previous
/// resume was healthy — the attempt counter resets (mirrors
/// `DEFAULT_RESPAWN_LIVENESS_WINDOW_MS` in freshell-terminal).
pub(crate) const AUTO_RESUME_HEALTHY_LIFETIME_MS: i64 = 30_000;

/// Crash notification from the PTY exit hook. Only sent for NATURAL exits
/// (`finish_pty_exit` returned `true`) — user kills never produce one.
#[derive(Debug, Clone)]
pub(crate) struct CrashEvent {
    pub terminal_id: String,
    pub exit_code: i64,
    pub mode: String,
    pub create_request_id: Option<String>,
    /// `now - created_at` of the generation that just died.
    pub lifetime_ms: i64,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct CrashContext<'a> {
    pub exit_code: i64,
    pub mode: &'a str,
    pub create_request_id: Option<&'a str>,
    pub has_resumable_identity: bool,
    pub lifetime_ms: i64,
    /// Consecutive auto-resume attempts already made for this createRequestId.
    pub prior_attempts: u32,
    /// `registry.respawn_exhausted(create_request_id)` — outer loop bound.
    pub cap_exhausted: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AutoResumeDecision {
    Resume { attempt: u32, delay_ms: u64 },
    SettleExited { reason: &'static str },
}

pub(crate) fn decide(ctx: &CrashContext<'_>, delays: &[u64]) -> AutoResumeDecision {
    use AutoResumeDecision::SettleExited;
    if ctx.exit_code == 0 {
        return SettleExited { reason: "clean_exit" };
    }
    if !AUTO_RESUME_MODES.contains(&ctx.mode) {
        return SettleExited { reason: "not_agent_mode" };
    }
    if ctx.create_request_id.is_none() {
        return SettleExited { reason: "no_create_request_id" };
    }
    if !ctx.has_resumable_identity {
        return SettleExited { reason: "no_resumable_identity" };
    }
    if ctx.cap_exhausted {
        return SettleExited { reason: "respawn_cap_exhausted" };
    }
    let effective_prior = if ctx.lifetime_ms >= AUTO_RESUME_HEALTHY_LIFETIME_MS {
        0
    } else {
        ctx.prior_attempts
    };
    match delays.get(effective_prior as usize).copied() {
        Some(delay_ms) => AutoResumeDecision::Resume { attempt: effective_prior + 1, delay_ms },
        None => SettleExited { reason: "retries_exhausted" },
    }
}

/// `FRESHELL_AUTO_RESUME_DELAYS_MS="2000,10000"` — e2e tests set tiny values.
pub(crate) fn parse_delays_env(raw: &str) -> Option<Vec<u64>> {
    let parsed: Option<Vec<u64>> = raw
        .split(',')
        .map(|s| s.trim().parse::<u64>().ok().filter(|v| *v > 0))
        .collect();
    parsed.filter(|v| !v.is_empty())
}

pub(crate) fn auto_resume_delays() -> Vec<u64> {
    std::env::var("FRESHELL_AUTO_RESUME_DELAYS_MS")
        .ok()
        .and_then(|raw| parse_delays_env(&raw))
        .unwrap_or_else(|| AUTO_RESUME_DEFAULT_DELAYS_MS.to_vec())
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-ws auto_resume
cargo clippy -p freshell-ws --all-targets -- -D warnings
```
Expected: all 9 tests PASS, clippy clean. (If `CrashEvent` triggers dead-code warnings before Task 2 wires it: add `#[allow(dead_code)]` on the struct with a `// consumed in Task 2` comment, and REMOVE it in Task 2.)

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/auto_resume.rs crates/freshell-ws/src/lib.rs
git commit -m "feat(ws): auto-resume policy — bounded schedule + crash eligibility decision"
```

---

### Task 2: Crash-event plumbing from the PTY exit hook

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (the `on_exit` closure built in `handle_create`, ~`:1641-1695`)
- Modify: `crates/freshell-ws/src/lib.rs` (`WsState` field)
- Test: `crates/freshell-ws/tests/auto_resume_events.rs` (new integration test, using the shared harness `crates/freshell-ws/tests/common/mod.rs`)

**Interfaces:**
- Consumes: `CrashEvent` from Task 1; `registry.finish_pty_exit -> bool` (true = genuine natural exit); `registry.probe(terminal_id) -> Option<IdentityProbeRow>` (has `created_at`, `mode`); `registry.probe_create_request_id(terminal_id)` (`registry.rs:1755`).
- Produces: `WsState.auto_resume_tx: tokio::sync::mpsc::UnboundedSender<CrashEvent>` — every genuine natural exit of any **WS-created** terminal sends one `CrashEvent` (filtering to agent modes happens in `decide()`, Task 5). Also: a shared exit-hook builder `pub(crate) fn build_pty_exit_hook(...) -> freshell_terminal::pty::ExitHook` that Task 4's respawn seam reuses, so respawned generations report their own crashes (this is load-bearing for retry #2).

**Scope note (VERIFIED, checkpoint finding):** a SECOND production exit-hook construction site exists in `crates/freshell-freshagent/src/terminal_tabs.rs:1009-1043` (REST-created agent panes; that crate is FENCED for this lane and its closure is deliberately divergent). REST/freshagent-created panes are therefore **out of scope for auto-resume in this lane** — they keep today's behavior. Do NOT touch that site. (Both hooks funnel through `finish_pty_exit`, so a future registry-layer observation could cover all paths; record as future work, not this lane.) Update the Task 1 module doc comment accordingly if it implies universal coverage.

- [ ] **Step 1: Write the failing integration test**

Create `crates/freshell-ws/tests/auto_resume_events.rs`. Follow the harness conventions of `crates/freshell-ws/tests/pane_reconcile.rs` (in-process axum server, ephemeral loopback port — read its head comment `:1-21` and `tests/common/mod.rs` for the builder; the harness must expose the state's `auto_resume_rx` — add a accessor/takeover method to the common builder if one doesn't exist). Test body sketch (adapt harness calls to `common/mod.rs` as it actually is):

```rust
//! CrashEvents are sent for natural exits only — never for user kills.
mod common;

use std::time::Duration;

#[tokio::test]
async fn natural_nonzero_exit_sends_crash_event_with_code_and_mode() {
    let mut h = common::Harness::start().await; // reuse the existing builder fn name
    let rx = h.take_auto_resume_rx();
    // Create a claude-mode terminal whose command exits 1 immediately.
    // Use the same fake-command override the ws tests use for CLI terminals
    // (CLAUDE_CMD env on the harness / spec list injection — mirror how
    // codex_session_ref_resume.rs boots a CLI terminal).
    let tid = h.create_agent_terminal("claude", "sh", &["-c", "exit 1"]).await;
    let ev = tokio::time::timeout(Duration::from_secs(10), rx_recv(rx)).await
        .expect("crash event within 10s");
    assert_eq!(ev.terminal_id, tid);
    assert_eq!(ev.exit_code, 1);
    assert_eq!(ev.mode, "claude");
    assert!(ev.create_request_id.is_some());
}

#[tokio::test]
async fn user_kill_sends_no_crash_event() {
    let mut h = common::Harness::start().await;
    let rx = h.take_auto_resume_rx();
    let tid = h.create_agent_terminal("claude", "sh", &["-c", "sleep 30"]).await;
    h.kill_terminal(&tid).await; // ws terminal.kill round-trip
    // The PTY EOF hook still runs, but finish_pty_exit returns false.
    assert!(tokio::time::timeout(Duration::from_secs(3), rx_recv(rx)).await.is_err(),
        "kill must not produce a CrashEvent");
}
```

Implementation note for the test author: if the existing `common::Harness` has no `create_agent_terminal`/`kill_terminal` helpers, build the test with the raw-WS message helpers that `pane_reconcile.rs` uses (`terminal.create` with `mode:"claude"` + a spec list whose claude command is overridden to `sh`; `terminal.kill`). Do NOT invent new production APIs for the test's convenience.

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test -p freshell-ws --test auto_resume_events 2>&1 | tail -20
```
Expected: COMPILE ERROR (`take_auto_resume_rx`, `auto_resume_tx` missing).

- [ ] **Step 3: Implement the plumbing**

3a. In `crates/freshell-ws/src/lib.rs`, add to `WsState` (near `broadcast_tx`, `:97`):

```rust
    /// Lane D1: natural-exit crash events for the auto-resume hub. The
    /// receiver half is consumed by `auto_resume::spawn_auto_resume_hub`
    /// (Task 5); until then tests drain it directly.
    pub auto_resume_tx: tokio::sync::mpsc::UnboundedSender<crate::auto_resume::CrashEvent>,
```
Create the channel where `WsState` is constructed; store `tx`; expose the `rx` to the caller (return it alongside the state, or park it in an `Option<Mutex<Option<Receiver>>>` field the server/main and tests take — pick whichever matches how `WsState` construction currently returns values, and keep it minimal). Update `tests/common/mod.rs` to expose `take_auto_resume_rx()`.

3b. In `crates/freshell-ws/src/terminal.rs`, extract the existing `on_exit` closure body (`:1641-1695`) into a named builder so Task 4 can reuse it verbatim:

```rust
/// Everything a PTY exit hook needs. Built once per spawned generation —
/// by handle_create AND by the auto-resume respawn seam (Task 4).
pub(crate) struct ExitHookDeps {
    pub registry: freshell_terminal::TerminalRegistry,
    pub identity: /* same type state.identity has */,
    pub pane_ledger: std::sync::Arc</* same type */>,
    pub amplifier_locator: Option</* same */>,
    pub opencode_locator: Option</* same */>,
    pub codex_locator: Option</* same */>,
    pub auto_resume_tx: tokio::sync::mpsc::UnboundedSender<crate::auto_resume::CrashEvent>,
}

pub(crate) fn build_pty_exit_hook(
    deps: ExitHookDeps,
    terminal_id: String,
    mode: String,
    mcp_cwd: Option<String>,
) -> freshell_terminal::pty::ExitHook {
    Box::new(move |exit_code: i64| {
        cleanup_mcp_config(&RealMcpRuntime, &terminal_id, &mode, mcp_cwd.as_deref());
        // Read identity/probe BEFORE finish/retire mutate state.
        let probe = deps.registry.probe(&terminal_id);
        let create_request_id = deps.registry.probe_create_request_id(&terminal_id);
        let finished = deps.registry.finish_pty_exit(&terminal_id, exit_code);
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
            .notify_terminal_exit(&terminal_id);
        deps.identity.retire(&terminal_id);
        if let Err(err) = deps.pane_ledger.delete_pending(&terminal_id) {
            /* keep the existing warn! from the current closure */
        }
        if let Some(l) = &deps.amplifier_locator { l.disarm(&terminal_id); }
        /* keep the existing opencode/codex disarm lines verbatim */
        // Lane D1: genuine natural exits only (kill removed the row → false).
        if finished {
            let lifetime_ms = probe
                .as_ref()
                .map(|p| crate::now_ms_helper() - p.created_at) // use the crate's existing now-ms helper (same one finish_pty_exit uses)
                .unwrap_or(i64::MAX);
            let _ = deps.auto_resume_tx.send(crate::auto_resume::CrashEvent {
                terminal_id: terminal_id.clone(),
                exit_code,
                mode: mode.clone(),
                create_request_id,
                lifetime_ms,
            });
        }
    })
}
```
**Fidelity rule:** the extraction is behavior-preserving — every line of the current closure (`terminal.rs:1641-1695`) must survive verbatim in the same order, with ONLY the `finished` capture and the `if finished { send }` block added. Field types in `ExitHookDeps` are copied from the current closure's captures (the exact types are visible at `:1680-1690`). `handle_create` now calls `build_pty_exit_hook(...)` instead of building the closure inline.

- [ ] **Step 4: Run to verify green (new tests + no regressions)**

```bash
cargo test -p freshell-ws --test auto_resume_events
cargo test -p freshell-ws
cargo clippy --workspace --all-targets -- -D warnings
```
Expected: both new tests PASS; the full `freshell-ws` suite stays green (extraction was behavior-preserving).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/tests/auto_resume_events.rs crates/freshell-ws/tests/common/mod.rs
git commit -m "feat(ws): send CrashEvent from PTY exit hook on genuine natural exits"
```

---

### Task 3: `terminal.replaced` protocol addition (frozen-contract procedure)

**Files:**
- Modify: `shared/ws-protocol.ts` (new outbound type + `ServerMessage` union entry; `WS_PROTOCOL_VERSION` stays 7 — additive frame)
- Regenerate: `port/contract/ws-protocol.schema.json`, `port/contract/ws-server-messages.schema.json`, `port/contract/ws-message-inventory.json`
- Modify: `crates/freshell-protocol/src/server_messages.rs` (variant + struct; `SERVER_MESSAGE_TYPES: [&str; 56]` → `57`, inserted sorted)
- Modify: `crates/freshell-protocol/tests/inventory.rs` (counts 56→57, 85→86; roundtrip test)
- Reference worked example: commits `eef9b344`, `cd98e695`, `490ad585` (`git show <sha> --stat`); procedure doc `port/contract/README.md`, `port/AGENTS.md:60-66`.

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (used by Tasks 5 & 6): wire frame
  `{ type: 'terminal.replaced', oldTerminalId: string, newTerminalId: string, exitCode: number, attempt: number, maxAttempts: number }`
  TS type name `TerminalReplacedMessage`; Rust `ServerMessage::TerminalReplaced(TerminalReplaced)` with snake_case fields + `#[serde(rename_all = "camelCase")]` (match the sibling `TerminalExit` struct's serde attributes exactly).

- [ ] **Step 1: Write the failing Rust roundtrip test**

In `crates/freshell-protocol/tests/inventory.rs`, add (pattern-match the existing roundtrip tests in `crates/freshell-ws/tests/pane_reconcile.rs` / sibling inventory tests):

```rust
#[test]
fn terminal_replaced_roundtrips_camel_case() {
    let json = r#"{"type":"terminal.replaced","oldTerminalId":"t-old","newTerminalId":"t-new","exitCode":1,"attempt":1,"maxAttempts":2}"#;
    let msg: freshell_protocol::ServerMessage = serde_json::from_str(json).expect("parse");
    let back = serde_json::to_string(&msg).expect("serialize");
    let v: serde_json::Value = serde_json::from_str(&back).unwrap();
    assert_eq!(v["type"], "terminal.replaced");
    assert_eq!(v["oldTerminalId"], "t-old");
    assert_eq!(v["newTerminalId"], "t-new");
    assert_eq!(v["exitCode"], 1);
    assert_eq!(v["maxAttempts"], 2);
}
```
Also bump the hardcoded count assertions in this file: server 56→57, total 85→86.

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test -p freshell-protocol --locked 2>&1 | tail -15
```
Expected: FAIL — unknown variant `terminal.replaced` + count assertions red.

- [ ] **Step 3: Implement both sides + regenerate**

3a. `shared/ws-protocol.ts` — next to the `terminal.status` outbound type (`:771-776`), add:

```ts
/** Lane D1: server-initiated crash auto-resume replaced a pane's terminal.
 * The client folds newTerminalId into the pane that owns oldTerminalId. */
export interface TerminalReplacedMessage {
  type: 'terminal.replaced'
  oldTerminalId: string
  newTerminalId: string
  exitCode: number
  attempt: number
  maxAttempts: number
}
```
Add `TerminalReplacedMessage` to the `ServerMessage` union (same list that contains the `terminal.status` message type).

3b. `crates/freshell-protocol/src/server_messages.rs` — add sorted variant + struct (mirror `TerminalExit` at `:961-966` for attribute style):

```rust
    #[serde(rename = "terminal.replaced")]
    TerminalReplaced(TerminalReplaced),
```
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReplaced {
    pub old_terminal_id: String,
    pub new_terminal_id: String,
    pub exit_code: i64,
    pub attempt: u32,
    pub max_attempts: u32,
}
```
Grow `SERVER_MESSAGE_TYPES: [&str; 56]` to `[&str; 57]`, inserting `"terminal.replaced"` in sorted position.

3c. Regenerate and self-check:
```bash
npm run contract:generate
git diff --stat port/contract   # exactly the 3 JSONs changed
npm run test:port
```

- [ ] **Step 4: Run to verify green**

```bash
cargo test -p freshell-protocol --locked
npm run test:port
npm run contract:generate && git diff --exit-code -- port/contract
```
Expected: all PASS; second `contract:generate` is a no-op (determinism check, mirrors the CI workflow `.github/workflows/port-contract.yml`).

- [ ] **Step 5: Commit (all contract artifacts in ONE commit — CI requires it)**

```bash
git add shared/ws-protocol.ts port/contract crates/freshell-protocol
git commit -m "feat(protocol): add terminal.replaced frame for server-driven crash auto-resume"
```

---

### Task 4: Respawn seam — `respawn_agent_terminal` in `terminal.rs`

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs`
- Test: `crates/freshell-ws/tests/auto_resume_respawn.rs` (new)

**Interfaces:**
- Consumes: `build_pty_exit_hook` + `ExitHookDeps` (Task 2); existing pieces: `resolve_coding_cli_command`/`CliLaunchInputs`/`LaunchIntent::Resume` (`crates/freshell-platform/src/cli_launch.rs:105-129`), `build_cli_spawn_spec` (call sites `terminal.rs:1601-1633`), `registry.create(...)` (`registry.rs:822-833`), `registry.set_meta`, `state.identity`, `state.pane_ledger.load_binding/record_binding` (`pane_ledger.rs:350,583`), `broadcast_terminals_changed` (`terminal.rs:2255`).
- Produces (used by Task 5):

```rust
pub(crate) struct AgentRespawnRequest {
    pub mode: String,                    // "claude" | "codex" | "opencode" | "amplifier"
    pub provider: String,                // sessionRef.provider (== mode for terminal panes)
    pub session_id: String,              // sessionRef.sessionId → --resume <id>
    pub create_request_id: String,       // SAME as the dead generation (cap continuity)
    pub cwd: Option<String>,
}

pub(crate) enum RespawnError {
    LaunchUnresolvable(String),   // no CLI spec / resume template for this mode
    Spawn(std::io::Error),
}

/// Spawns a replacement agent terminal from a server-side identity.
/// Returns the NEW terminal id. Does NOT guard/lease — the orchestrator does.
pub(crate) async fn respawn_agent_terminal(
    state: &WsState,
    req: &AgentRespawnRequest,
) -> Result<String, RespawnError>
```

- [ ] **Step 1: Write the failing integration test**

Create `crates/freshell-ws/tests/auto_resume_respawn.rs` (same harness as Task 2; override the claude CLI command to a recording shim so argv is assertable — mirror how the harness/spec list is configured in `codex_session_ref_resume.rs`):

```rust
//! respawn_agent_terminal spawns a resume-generation with the same
//! createRequestId and provider-native resume argv.
mod common;

#[tokio::test]
async fn respawn_spawns_resume_generation_with_same_create_request_id() {
    let h = common::Harness::start_with_fake_claude_recording_argv().await;
    // Arrange: a claude terminal exists and has crashed (exit 1), identity retired.
    let (old_tid, session_id, create_request_id) = h.create_crashed_claude_terminal().await;

    let new_tid = freshell_ws::terminal::respawn_agent_terminal(
        h.state(),
        &freshell_ws::terminal::AgentRespawnRequest {
            mode: "claude".into(),
            provider: "claude".into(),
            session_id: session_id.clone(),
            create_request_id: create_request_id.clone(),
            cwd: None,
        },
    )
    .await
    .expect("respawn");

    assert_ne!(new_tid, old_tid, "a respawn mints a new terminalId");
    // Registry row: same createRequestId, mode claude, resume id recorded.
    let probe = h.registry().probe(&new_tid).expect("row");
    assert_eq!(probe.mode, "claude");
    assert_eq!(probe.resume_session_id.as_deref(), Some(session_id.as_str()));
    assert_eq!(
        h.registry().probe_create_request_id(&new_tid),
        Some(create_request_id)
    );
    // Argv: the fake CLI recorded `--resume <session_id>`.
    let argv = h.recorded_argv().await;
    assert!(argv.windows(2).any(|w| w[0] == "--resume" && w[1] == session_id),
        "resume argv missing: {argv:?}");
}
```
(`respawn_agent_terminal`/`AgentRespawnRequest` must be `pub(crate)` + re-exported for the integration test — integration tests can only see `pub` items, so export them via a `#[doc(hidden)] pub` on the module path or move the assertion helpers into `tests/common`. Prefer `pub` with `#[doc(hidden)]`, matching how other internals are exposed to `tests/` in this crate — check how `tests/pane_reconcile.rs` reaches internals and copy that mechanism.)

- [ ] **Step 2: Run to verify it fails**

```bash
cargo test -p freshell-ws --test auto_resume_respawn 2>&1 | tail -15
```
Expected: COMPILE ERROR — `respawn_agent_terminal` not found.

- [ ] **Step 3: Implement the seam**

In `crates/freshell-ws/src/terminal.rs`, mirroring `handle_create`'s CLI branch step-for-step (`:1278-1354` resume derivation, `:1601-1633` spec→spawn, `:1641-1695` hook, registry insert + meta + identity + ledger). The seam is the same pipeline minus connection-bound concerns (no `ws_tx` replies, no client `requestId` correlation, no preallocation ladder — intent is always `Resume`):

```rust
pub(crate) async fn respawn_agent_terminal(
    state: &WsState,
    req: &AgentRespawnRequest,
) -> Result<String, RespawnError> {
    // 1. Resolve resume argv exactly like handle_create's CLI branch:
    //    CliLaunchInputs { mode, resume_session_id: Some(req.session_id),
    //    launch_intent: LaunchIntent::Resume, ... }.
    //    VERIFIED CORRECTION (do not use BindingRow launch fields): the pane
    //    ledger's record_binding hardcodes model/sandbox/permission_mode/effort
    //    to None for terminal-pane rows (pane_ledger.rs:405-408; only
    //    fresh-agent writes populate them). Derive launch params from
    //    state.settings EXACTLY as handle_create does (terminal.rs:1430-1445);
    //    take cwd from the binding/identity record (BindingRow.cwd / identity
    //    cwd — these ARE populated).
    //    Pass the SAME spec list + env + McpInjection handle_create passes to
    //    resolve_coding_cli_command (visible at the terminal.rs:1601-1633 call
    //    sites) — factor a small helper if those inputs are locals today.
    //    Child env: mirror handle_create's env construction via the same
    //    helper. Verification point: FRESHELL_TAB_ID / FRESHELL_PANE_ID come
    //    from the create request's wire fields and are NOT derivable from
    //    BindingRow — source them from the ledger binding if it carries
    //    tab/pane ids, else OMIT them for auto-resumed generations and record
    //    the deviation in task notes (do not invent values).
    // 2. Build the SpawnSpec via the same build_cli_spawn_spec /
    //    build_windows_cli_spawn_spec pair handle_create uses.
    // 2b. Acquire the server-wide spawn gate BEFORE spawning (VERIFIED
    //    in-path for all creates: SpawnGate 4-permit semaphore,
    //    spawn_gate.rs:51, acquired at terminal.rs:1700-1722 — public API,
    //    no fenced-internals modification). Mirror handle_create's acquire +
    //    rejection handling; on gate rejection return
    //    RespawnError::LaunchUnresolvable-style failure so the orchestrator
    //    settles "respawn_failed" and releases the lease. (The per-connection
    //    CreateRateLimiter is connection-loop-local and does not apply to
    //    this headless path.)
    // 3. Mint ids and insert:
    let terminal_id = uuid::Uuid::new_v4().simple().to_string();
    let stream_id = uuid::Uuid::new_v4().simple().to_string();
    //    on_exit = build_pty_exit_hook(ExitHookDeps { ...clones from state,
    //    auto_resume_tx: state.auto_resume_tx.clone() }, terminal_id.clone(),
    //    req.mode.clone(), cwd.clone());
    //    registry.create(&spec, &env, terminal_id.clone(), stream_id, &req.mode,
    //        Some(&req.session_id), Some(&req.create_request_id), None, Some(on_exit))
    //    — wrapped in tokio::task::spawn_blocking like handle_create does
    //    (terminal.rs:1734 precedent) — map io::Error → RespawnError::Spawn.
    // 4. Post-insert bookkeeping, same order as handle_create:
    //    registry.set_meta(...title: "<mode> (auto-resumed)"...),
    //    identity record for the new terminal (provider/session_id/cwd),
    //    pane_ledger.record_binding(BindingWrite { live_terminal_id:
    //        Some(new id), state: live, ...unchanged identity fields }) —
    //    ledger writes fsync: use spawn_blocking (pane_ledger.rs:363 doctrine),
    //    arm the provider locators the way handle_create does for this mode.
    // 5. broadcast_terminals_changed(state) so sidebars refresh.
    Ok(terminal_id)
}
```
**Fidelity rule:** every numbered block copies the corresponding `handle_create` lines — same call order, same error handling, same `spawn_blocking` boundaries. Where `handle_create` inlines locals (spec list, env, MCP injection), extract the smallest shared helper function rather than duplicating logic (DRY), and keep `handle_create`'s behavior bit-identical. If a mode needs create-machinery this seam cannot reach without touching fenced code (e.g. a codex sidecar adoption step buried in freshagent crates), keep claude/amplifier/opencode fully working, make the codex-specific step a shared helper *within freshell-ws* if it lives there, and record any true blocker in the task notes for the reviewer — do NOT silently skip bookkeeping steps.

- [ ] **Step 4: Run to verify green (+ no create-path regressions)**

```bash
cargo test -p freshell-ws --test auto_resume_respawn
cargo test -p freshell-ws
cargo clippy --workspace --all-targets -- -D warnings
```
Expected: new test PASS; the whole crate suite green.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/auto_resume_respawn.rs crates/freshell-ws/tests/common/mod.rs
git commit -m "feat(ws): respawn_agent_terminal seam — server-side resume generation spawn"
```

---

### Task 5: Auto-resume orchestrator (retries, guards, frames)

**Files:**
- Modify: `crates/freshell-ws/src/auto_resume.rs` (hub + driver trait + production driver)
- Modify: `crates/freshell-server/src/main.rs` (spawn the hub — next to the `spawn_idle_monitor` wiring, `:282`)
- Modify: `crates/freshell-ws/tests/common/mod.rs` (spawn the hub in the test harness)
- Test: in-file `#[cfg(test)]` (fake-driver unit tests, `tokio::time::pause`) + `crates/freshell-ws/tests/auto_resume_e2e.rs` (real registry integration)

**Interfaces:**
- Consumes: `decide`/`auto_resume_delays`/`CrashEvent` (Task 1); `respawn_agent_terminal` (Task 4); `TerminalReplaced` frame (Task 3); `TerminalStatus` frame (existing, `server_messages.rs` — search `terminal.status` for the struct/variant names); guards: `registry.respawn_exhausted` (`registry.rs:733`), `registry.live_terminal_for_session_ref` (`registry.rs:2152`); lease: `claim_session_ref(locator, holder_create_request_id, holder_conn, now_ms) -> SessionRefClaim` (`registry.rs:1812`; enum variants `Acquired`/`Held{retry_after_ms}`/`ExpiredNeedsKill{pid}`/`BoundElsewhere{terminal_id}`, `registry.rs:467-486`; locator type is `SessionLocator { provider, session_id }`, `freshell-protocol/src/common.rs:176-182`), `complete_session_ref_claim(locator, holder_create_request_id, terminal_id) -> bool` (`registry.rs:1964`), `fail_session_ref_claim(locator, holder_create_request_id)` (`registry.rs:2007`); identity: `state.identity.session_ref_for(&terminal_id)` (retired-inclusive) with ledger fallback `state.pane_ledger.bound_session_ref_for_terminal` (`pane_ledger.rs:652`).
- Produces: `pub fn spawn_auto_resume_hub(state: WsState, rx: UnboundedReceiver<CrashEvent>) -> tokio::task::JoinHandle<()>`; wire frames emitted on `broadcast_tx` (pre-serialized JSON, same as `terminals.changed`):
  - on each Resume decision, BEFORE the backoff sleep: `terminal.status { terminalId: <old>, status: "recovering", reason: "<mode> crashed (exit <code>) — auto-resuming, attempt <n>/<max>", attempt: <n> }`
  - after successful respawn: `terminal.replaced { oldTerminalId, newTerminalId, exitCode, attempt, maxAttempts }`
  - on settle: nothing (the already-sent `terminal.exit` + exited status are the loud signal; reason is logged via `tracing::info!(terminal_id, reason, "terminal.auto_resume.settled")`).

- [ ] **Step 1: Write the failing unit tests (fake driver, paused time)**

Append to `auto_resume.rs`'s test module. First define (in the impl section signature-only for now — tests drive the real bodies):

```rust
/// Orchestrator-facing effects, faked in unit tests.
///
/// LEASE-SHAPE NOTE (fresh-eyes fix): the trait mirrors the REAL registry
/// lease API, which is asymmetric — success binds the lease to the NEW
/// terminal via `complete_session_ref_claim(locator, holder_create_request_id,
/// terminal_id) -> bool` (registry.rs:1964), failure releases it via
/// `fail_session_ref_claim(locator, holder_create_request_id)` (registry.rs:2007).
/// A single symmetric `release_claim` cannot implement that discipline, so the
/// trait exposes `complete_claim` / `fail_claim` distinctly, and the claim call
/// carries the holder create-request-id the registry keys the lease by.
pub(crate) trait AutoResumeDriver: Send + 'static {
    fn cap_exhausted(&self, create_request_id: &str) -> bool;
    fn resumable_session_ref(&self, terminal_id: &str) -> Option<(String, String, Option<String>)>; // (provider, session_id, cwd)
    /// Post-backoff guard. Some(reason) aborts the resume and settles with that
    /// reason ("session_owned_live" when a live terminal already owns the
    /// session-ref; "pane_closed" when the pane's ledger binding was retired
    /// during the backoff). None = clear to claim.
    fn pre_respawn_guard(&self, provider: &str, session_id: &str, old_terminal_id: &str) -> Option<&'static str>;
    /// Acquire the session-ref lease for this holder; false = not acquirable → abort.
    /// The PRODUCTION impl runs the create ingress's full bounded claim
    /// discipline internally (Step 3 notes) — the hub only sees the outcome.
    fn claim_session(&self, provider: &str, session_id: &str, create_request_id: &str) -> bool;
    /// Bind the acquired lease to the freshly spawned terminal
    /// (complete_session_ref_claim). false = the binding raced away; the
    /// PRODUCTION impl has already killed its own orphan child before
    /// returning (mirror of the ingress complete==false path).
    fn complete_claim(&self, provider: &str, session_id: &str, create_request_id: &str, new_terminal_id: &str) -> bool;
    /// Release a claim whose respawn failed (fail_session_ref_claim).
    fn fail_claim(&self, provider: &str, session_id: &str, create_request_id: &str);
    fn respawn(
        &self,
        req: &RespawnSpec,
    ) -> impl std::future::Future<Output = Result<String, String>> + Send;
    fn emit_recovering(&self, terminal_id: &str, mode: &str, exit_code: i64, attempt: u32, max_attempts: u32);
    fn emit_replaced(&self, old: &str, new: &str, exit_code: i64, attempt: u32, max_attempts: u32);
    fn log_settled(&self, terminal_id: &str, reason: &str);
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RespawnSpec {
    pub mode: String,
    pub provider: String,
    pub session_id: String,
    pub create_request_id: String,
    pub cwd: Option<String>,
}
```

Tests (fake driver records calls in `Arc<Mutex<Vec<…>>>`; `#[tokio::test(start_paused = true)]`, advance with `tokio::time::advance`):

```rust
#[tokio::test(start_paused = true)]
async fn crash_resumes_after_first_backoff_and_emits_frames() {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let fake = FakeDriver::healthy(); // identity present, cap ok, claim ok, respawn -> Ok("t-new")
    let _hub = spawn_hub_with_driver(fake.clone(), rx, vec![2_000, 10_000]);
    tx.send(crash("t1", 1, "claude", Some("cr-1"), 5_000)).unwrap();
    tokio::task::yield_now().await;
    assert_eq!(fake.recovering_calls(), vec![("t1".into(), 1u32, 2u32)]);
    assert!(fake.respawn_calls().is_empty(), "must wait out the backoff");
    tokio::time::advance(std::time::Duration::from_millis(2_000)).await;
    tokio::task::yield_now().await;
    assert_eq!(fake.respawn_calls().len(), 1);
    assert_eq!(fake.replaced_calls(), vec![("t1".into(), "t-new".into(), 1u32)]);
}

#[tokio::test(start_paused = true)]
async fn second_crash_uses_second_delay_then_exhausts() {
    // crash cr-1 (lifetime 1s) -> attempt 1 @2s; crash again -> attempt 2 @10s;
    // crash again -> settled("retries_exhausted"), NO third respawn.
    /* drive three CrashEvents through, asserting delays via time::advance and
       that respawn_calls().len() == 2 && settled == [("retries_exhausted")] */
}

#[tokio::test(start_paused = true)]
async fn healthy_generation_resets_attempts() {
    // two crashes (attempts 1,2), then a crash with lifetime_ms = 60_000:
    // attempt resets to 1 with the first delay again.
}

#[tokio::test(start_paused = true)]
async fn live_session_owner_aborts_resume_silently() {
    // pre_respawn_guard -> Some("session_owned_live") (user already relaunched):
    // no respawn, no claim, settled("session_owned_live").
}

#[tokio::test(start_paused = true)]
async fn pane_closed_during_backoff_settles_pane_closed() {
    // pre_respawn_guard -> Some("pane_closed") (ledger binding retired during
    // the backoff): no respawn, no claim, settled("pane_closed").
}

#[tokio::test(start_paused = true)]
async fn lost_lease_claim_aborts_resume() {
    // claim_session -> false: no respawn, settled("session_lease_held").
}

#[tokio::test(start_paused = true)]
async fn failed_respawn_settles_loudly() {
    // respawn -> Err("spawn failed"): fail_claim called (NOT complete_claim),
    // settled("respawn_failed").
}

#[tokio::test(start_paused = true)]
async fn lost_lease_completion_settles_without_replaced_frame() {
    // respawn -> Ok("t-new") but complete_claim -> false (binding raced away;
    // production driver kills its own child before returning false):
    // NO terminal.replaced emitted, settled("lease_completion_lost").
}

#[tokio::test(start_paused = true)]
async fn cap_exhausted_and_no_identity_and_clean_and_shell_settle_without_respawn() {
    // four events: cap_exhausted=true / resumable_session_ref=None /
    // exit_code=0 / mode="shell" — zero respawn calls, zero recovering frames.
}
```
Write each `/* … */` body out fully in the actual test file — the sketches above name the exact scenario and assertions; no scenario may be dropped.

- [ ] **Step 2: Run to verify they fail**

```bash
cargo test -p freshell-ws auto_resume 2>&1 | tail -15
```
Expected: COMPILE ERROR (`spawn_hub_with_driver`, `FakeDriver` missing).

- [ ] **Step 3: Implement the hub**

```rust
pub(crate) fn spawn_hub_with_driver<D: AutoResumeDriver>(
    driver: D,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<CrashEvent>,
    delays: Vec<u64>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut attempts: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
        let max_attempts = delays.len() as u32;
        while let Some(ev) = rx.recv().await {
            let sref = driver.resumable_session_ref(&ev.terminal_id);
            let ctx = CrashContext {
                exit_code: ev.exit_code,
                mode: &ev.mode,
                create_request_id: ev.create_request_id.as_deref(),
                has_resumable_identity: sref.is_some(),
                lifetime_ms: ev.lifetime_ms,
                prior_attempts: ev.create_request_id.as_deref()
                    .and_then(|k| attempts.get(k).copied()).unwrap_or(0),
                cap_exhausted: ev.create_request_id.as_deref()
                    .map(|k| driver.cap_exhausted(k)).unwrap_or(true),
            };
            match decide(&ctx, &delays) {
                AutoResumeDecision::SettleExited { reason } => {
                    if ev.mode != "shell" {
                        driver.log_settled(&ev.terminal_id, reason);
                    }
                    if reason == "clean_exit" || ev.lifetime_ms >= AUTO_RESUME_HEALTHY_LIFETIME_MS {
                        if let Some(k) = &ev.create_request_id { attempts.remove(k); }
                    }
                }
                AutoResumeDecision::Resume { attempt, delay_ms } => {
                    let (provider, session_id, cwd) = sref.expect("checked by decide");
                    let key = ev.create_request_id.clone().expect("checked by decide");
                    attempts.insert(key.clone(), attempt);
                    driver.emit_recovering(&ev.terminal_id, &ev.mode, ev.exit_code, attempt, max_attempts);
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    // Guards AFTER the sleep — the world may have moved on.
                    if let Some(reason) = driver.pre_respawn_guard(&provider, &session_id, &ev.terminal_id) {
                        driver.log_settled(&ev.terminal_id, reason);
                        continue;
                    }
                    if !driver.claim_session(&provider, &session_id, &key) {
                        driver.log_settled(&ev.terminal_id, "session_lease_held");
                        continue;
                    }
                    let spec = RespawnSpec {
                        mode: ev.mode.clone(), provider: provider.clone(),
                        session_id: session_id.clone(), create_request_id: key.clone(), cwd,
                    };
                    match driver.respawn(&spec).await {
                        Ok(new_tid) => {
                            if driver.complete_claim(&provider, &session_id, &key, &new_tid) {
                                driver.emit_replaced(&ev.terminal_id, &new_tid, ev.exit_code, attempt, max_attempts);
                            } else {
                                // Binding raced away between claim and completion; the
                                // driver already killed its own orphan child. No
                                // terminal.replaced — the pane stays settled exited.
                                driver.log_settled(&ev.terminal_id, "lease_completion_lost");
                            }
                        }
                        Err(err) => {
                            driver.fail_claim(&provider, &session_id, &key);
                            tracing::warn!(terminal_id = %ev.terminal_id, error = %err, "terminal.auto_resume.respawn_failed");
                            driver.log_settled(&ev.terminal_id, "respawn_failed");
                        }
                    }
                }
            }
        }
    })
}
```
**Design note (serialization):** handling events sequentially in one task means a backoff sleep delays other panes' resumes by up to 10s worst-case. Acceptable at v1 (crashes are rare, budget tiny, and full serialization is the strongest anti-storm property — one respawn in flight, ever). Record this as a comment on the loop.

Production driver `WsAutoResumeDriver { state: WsState }` implements the trait by delegating:
- `cap_exhausted` → `state.registry.respawn_exhausted(key)`
- `resumable_session_ref` → `state.identity.session_ref_for(tid)` (retired-inclusive) with `state.pane_ledger.bound_session_ref_for_terminal(tid)` as fallback; map to `(provider, session_id, cwd)` (cwd from `BindingRow.cwd` / identity)
- `pre_respawn_guard` → returns `Some("session_owned_live")` when `state.registry.live_terminal_for_session_ref(&locator).is_some()`; otherwise re-checks the pane's ledger binding is still Bound (`bound_session_ref_for_terminal`) — a user who closed the pane during the backoff retires it (`retire_closed`, called from the `terminal.kill` path, terminal.rs:2714-2739) — and returns `Some("pane_closed")` if retired (this also bounds the crash-then-immediately-killed race — pinned by the `pane_closed_during_backoff_settles_pane_closed` unit scenario); returns `None` when clear to claim. Ledger-disabled caveat: `bound_session_ref_for_terminal` returns `None` both when retired and when the ledger is disabled — only treat a retired binding as `pane_closed` when the ledger is enabled; with the ledger disabled, skip that sub-check (the live-owner check and the lease still guard).
- `claim_session` → runs the create ingress's FULL bounded claim discipline headlessly, mirroring `terminal.rs:1147-1214` exactly: call `claim_session_ref(&SessionLocator{provider,session_id}, create_request_id, holder_conn, now_ms)` (registry.rs:1812) in the same bounded rounds (`for round in 0..2`); on `ExpiredNeedsKill{pid}` do the ingress's kill → confirm → `force_release_after_confirmed_kill` → retry round; treat `Held{..}`/`BoundElsewhere{..}` (and rounds exhausted) as `false`. VERIFIED: takes plain values — callable headlessly.
- `complete_claim` → `complete_session_ref_claim(&locator, create_request_id, new_terminal_id)` (registry.rs:1964). When it returns `false`, mirror the ingress complete==false path (terminal.rs:1986-2029): kill the just-spawned child terminal, then return `false` to the hub (which settles `lease_completion_lost` and emits no `terminal.replaced`).
- `fail_claim` → `fail_session_ref_claim(&locator, create_request_id)` (registry.rs:2007). NOTE: the WS ingress releases failed claims via the RAII `Drop for SessionRefLeaseGuard` (terminal.rs:1008-1016); the headless driver holds no guard, so this explicit call IS its failure-path release — do not also construct the guard.
- Two hard requirements from validation: (i) mint `holder_conn` via `registry.new_connection_id()` — NEVER a literal that could collide with a real WS connection id, or a client disconnect sweep (terminal.rs:446-458) could release the orchestrator's lease mid-respawn; a minted id is never swept, so (ii) the orchestrator OWNS the full release discipline on every path — success (`complete_claim`), respawn failure (`fail_claim`), and completion failure (`complete_claim == false` → kill own child); no connection-death safety net exists for this holder
- `respawn` → `respawn_agent_terminal(&state, &AgentRespawnRequest { … })`
- `emit_recovering` → build the existing `ServerMessage` for `terminal.status` (struct name at `server_messages.rs` — search `"terminal.status"`) with `status: "recovering"`, `reason: format!("{mode} crashed (exit {code}) — auto-resuming, attempt {n}/{max}")`, `attempt: Some(n)`; serialize with `serde_json::to_string` and send on `state.broadcast_tx` (same as `broadcast_terminals_changed`, `terminal.rs:2255`)
- `emit_replaced` → same bus, `ServerMessage::TerminalReplaced(…)`
- `log_settled` → `tracing::info!(terminal_id, reason, "terminal.auto_resume.settled")`

Public entry: `pub fn spawn_auto_resume_hub(state: WsState, rx: UnboundedReceiver<CrashEvent>) -> JoinHandle<()> { spawn_hub_with_driver(WsAutoResumeDriver { state }, rx, auto_resume_delays()) }`. Wire it in `crates/freshell-server/src/main.rs` next to the `spawn_idle_monitor` call (`:282` precedent) and in `tests/common/mod.rs` (harness gets a knob: hub ON for `auto_resume_e2e.rs`, OFF — rx taken by the test — for Task 2's event tests).

- [ ] **Step 4: Write + run the registry-integration test**

Create `crates/freshell-ws/tests/auto_resume_e2e.rs`: harness with hub ON, `FRESHELL_AUTO_RESUME_DELAYS_MS="50,100"` (set via the harness env, not global `std::env::set_var` — if the harness can't inject env, pass delays through the spawn helper instead and note it), fake claude command = a shell script that exits 1 always. Create a claude terminal → within ~5s assert: (a) 3 spawns happened (1 + 2 retries — count via the recording shim), (b) a broadcast `terminal.status{recovering, attempt:1}` and `terminal.replaced{attempt:1}` were observed on a subscribed ws client, (c) final newest terminal for the createRequestId is `exited` (`registry.newest_by_create_request_id`, `registry.rs:1703`) and no further spawns occur for 500ms, and (d) **MANDATORY reconcile-after-replacement pin (per D-2's verified-but-novel-input finding):** with a crash-once fake (first invocation exits 1, replacement survives), after `terminal.replaced` is observed, a SECOND ws client sends `pane.reconcile` presenting the OLD terminalId + the pane's sessionRef + createRequestId and receives an attach verdict whose `terminal_id` is the NEW live terminal (assert `corrected` is None/absent — same-session replacement does not set it, `reconcile.rs:85-94`).

```bash
cargo test -p freshell-ws auto_resume
cargo test -p freshell-ws --test auto_resume_e2e
cargo test --workspace --locked
cargo clippy --workspace --all-targets -- -D warnings
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/auto_resume.rs crates/freshell-ws/tests/auto_resume_e2e.rs crates/freshell-ws/tests/common/mod.rs crates/freshell-server/src/main.rs
git commit -m "feat(ws): auto-resume orchestrator — bounded retries, guards, recovering/replaced frames"
```

---

### Task 6: Client lifecycle slice + WS handlers (record exits, notices, fold replacement)

**Files:**
- Create: `src/store/terminalLifecycleSlice.ts`
- Modify: the store-assembly file registering `panesSlice.reducer` (locate: `grep -rn "panesSlice.reducer\|panes:" src/store src/*.ts*`)
- Modify: `src/components/TerminalView.tsx` (`terminal.exit` handler ~`:4101-4160`; `terminal.status` handler ~`:4087`; new `terminal.replaced` case beside them)
- Test: `test/unit/client/store/terminalLifecycleSlice.test.ts` (beside the existing `test/unit/client/store/turnCompletionSlice.test.ts` — the VERIFIED home of client store tests; the repo has no co-located `src/**` tests)

**Interfaces:**
- Consumes: `TerminalReplacedMessage` + `terminal.status` message types from `shared/ws-protocol.ts`; `applyReconcileAttach` + `selectTabPaneByTerminalId` (`src/store/panesSlice.ts:1886`, selector used by `turnCompletionThunks.ts:25`).
- Produces (used by Tasks 7–9):

**Keying (per the VERIFIED constraint in D-2): the slice is keyed by `paneId`, with a `lastTerminalId` mapping recorded at exit time** — because TerminalView clears `paneContent.terminalId` on `terminal.exit` (`TerminalView.tsx:4141-4148`), old-terminalId frames can only be matched via this recorded mapping, and banner selectors can only be keyed by paneId.

```ts
export const AUTO_RESUME_NOTICE_TTL_MS = 30_000

export interface TerminalExitRecord { exitCode: number; at: number }
export interface AutoResumeNotice {
  kind: 'recovering' | 'resumed'
  attempt: number
  maxAttempts: number
  exitCode: number
  at: number
}
export interface PaneLifecycleEntry {
  lastTerminalId?: string   // the id the pane owned when it last exited (frame-matching key)
  exit?: TerminalExitRecord
  notice?: AutoResumeNotice
}
// state: { byPaneId: Record<string, PaneLifecycleEntry> }
// actions:
recordTerminalExit({ paneId, terminalId, exitCode, at })          // sets exit + lastTerminalId; CLEARS any notice
recordAutoResumeRecovering({ paneId, attempt, maxAttempts, exitCode, at })
foldTerminalReplacement({ paneId, newTerminalId, exitCode, attempt, maxAttempts, at })
  // clears exit, sets a 'resumed' notice, advances lastTerminalId = newTerminalId
clearTerminalLifecycle({ paneId })
// selectors:
selectExitRecord(state, paneId): TerminalExitRecord | undefined
selectActiveNotice(state, paneId, now): AutoResumeNotice | undefined  // TTL-filtered
selectLastTerminalIdFrom(sliceState, paneId): string | undefined     // frame matching
```

- [ ] **Step 1: Write the failing slice tests**

`test/unit/client/store/terminalLifecycleSlice.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import reducer, {
  recordTerminalExit, recordAutoResumeRecovering, foldTerminalReplacement,
  clearTerminalLifecycle, selectExitRecordFrom, selectActiveNoticeFrom,
  selectLastTerminalIdFrom, AUTO_RESUME_NOTICE_TTL_MS,
} from '@/store/terminalLifecycleSlice'

const empty = reducer(undefined, { type: '@@init' })

describe('terminalLifecycleSlice', () => {
  it('records an exit code + lastTerminalId per paneId', () => {
    const s = reducer(empty, recordTerminalExit({ paneId: 'p1', terminalId: 't1', exitCode: 1, at: 1000 }))
    expect(selectExitRecordFrom(s, 'p1')).toEqual({ exitCode: 1, at: 1000 })
    expect(selectLastTerminalIdFrom(s, 'p1')).toBe('t1') // frame-matching key survives TerminalView clearing its own terminalId
  })

  it('records a recovering notice and expires it after the TTL', () => {
    const s = reducer(empty, recordAutoResumeRecovering({ paneId: 'p1', attempt: 1, maxAttempts: 2, exitCode: 1, at: 1000 }))
    expect(selectActiveNoticeFrom(s, 'p1', 1000 + AUTO_RESUME_NOTICE_TTL_MS - 1)?.kind).toBe('recovering')
    expect(selectActiveNoticeFrom(s, 'p1', 1000 + AUTO_RESUME_NOTICE_TTL_MS + 1)).toBeUndefined()
  })

  it('fold clears the exit record, sets a resumed notice, and advances lastTerminalId', () => {
    let s = reducer(empty, recordTerminalExit({ paneId: 'p1', terminalId: 't1', exitCode: 1, at: 1000 }))
    s = reducer(s, recordAutoResumeRecovering({ paneId: 'p1', attempt: 1, maxAttempts: 2, exitCode: 1, at: 1000 }))
    s = reducer(s, foldTerminalReplacement({ paneId: 'p1', newTerminalId: 't2', exitCode: 1, attempt: 1, maxAttempts: 2, at: 2000 }))
    expect(selectExitRecordFrom(s, 'p1')).toBeUndefined() // pane is alive again — no error bar
    expect(selectActiveNoticeFrom(s, 'p1', 2000)).toEqual({ kind: 'resumed', attempt: 1, maxAttempts: 2, exitCode: 1, at: 2000 })
    expect(selectLastTerminalIdFrom(s, 'p1')).toBe('t2')
  })

  it('a later exit clears any active notice (exhaustion must not be masked by a stale resumed strip)', () => {
    // fold sets a 'resumed' notice; the replacement then crashes and the hub
    // settles retries_exhausted WITHOUT emitting any frame — the exit record
    // must surface the alert immediately, not after the 30s TTL.
    let s = reducer(empty, foldTerminalReplacement({ paneId: 'p1', newTerminalId: 't2', exitCode: 1, attempt: 2, maxAttempts: 2, at: 1000 }))
    s = reducer(s, recordTerminalExit({ paneId: 'p1', terminalId: 't2', exitCode: 1, at: 2000 }))
    expect(selectActiveNoticeFrom(s, 'p1', 2000)).toBeUndefined()
    expect(selectExitRecordFrom(s, 'p1')).toEqual({ exitCode: 1, at: 2000 })
  })

  it('clearTerminalLifecycle wipes the pane entry', () => {
    let s = reducer(empty, recordTerminalExit({ paneId: 'p1', terminalId: 't1', exitCode: 7, at: 1 }))
    s = reducer(s, clearTerminalLifecycle({ paneId: 'p1' }))
    expect(selectExitRecordFrom(s, 'p1')).toBeUndefined()
    expect(selectLastTerminalIdFrom(s, 'p1')).toBeUndefined()
  })
})
```
(`selectExitRecordFrom(sliceState, paneId)` / `selectActiveNoticeFrom(sliceState, paneId, now)` / `selectLastTerminalIdFrom(sliceState, paneId)` operate on the slice state directly; also export root-state wrappers `selectExitRecord`/`selectActiveNotice` for components.)

- [ ] **Step 2: Run to verify red**

```bash
npm run test:vitest -- run test/unit/client/store/terminalLifecycleSlice.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the slice + register it**

```ts
// src/store/terminalLifecycleSlice.ts
// Ephemeral crash/auto-resume presentation state (Lane D1). Deliberately a
// separate slice: pane persistence shapes are owned by Lane D4 and the
// persistMiddleware strip is a denylist — a new pane field would persist by
// default. This slice is never persisted.
import { createSlice, type PayloadAction } from '@reduxjs/toolkit'

export const AUTO_RESUME_NOTICE_TTL_MS = 30_000

export interface TerminalExitRecord { exitCode: number; at: number }
export interface AutoResumeNotice {
  kind: 'recovering' | 'resumed'
  attempt: number
  maxAttempts: number
  exitCode: number
  at: number
}

export interface PaneLifecycleEntry {
  lastTerminalId?: string
  exit?: TerminalExitRecord
  notice?: AutoResumeNotice
}

interface TerminalLifecycleState {
  byPaneId: Record<string, PaneLifecycleEntry>
}

const initialState: TerminalLifecycleState = { byPaneId: {} }

const entry = (state: TerminalLifecycleState, paneId: string) =>
  (state.byPaneId[paneId] ??= {})

const slice = createSlice({
  name: 'terminalLifecycle',
  initialState,
  reducers: {
    // Dispatched by the pane's own terminal.exit handler BEFORE it clears
    // paneContent.terminalId (TerminalView.tsx:4141-4148) — this is the only
    // moment both paneId and the dying terminalId are simultaneously known.
    recordTerminalExit(state, a: PayloadAction<{ paneId: string; terminalId: string; exitCode: number; at: number }>) {
      const e = entry(state, a.payload.paneId)
      e.lastTerminalId = a.payload.terminalId
      e.exit = { exitCode: a.payload.exitCode, at: a.payload.at }
      // Fresh-eyes fix: an exit is always NEWER truth than any notice. Without
      // this, the exhaustion path (last crash -> settle, which emits no frame)
      // leaves the previous 'resumed' notice masking the role=alert error bar
      // for the 30s TTL — a success-toned banner on a dead pane. Clearing here
      // makes the alert show immediately on the final crash; a genuine
      // in-flight resume re-sets the notice when its `recovering` frame lands
      // (which always follows the exit, per Task 5's emit order).
      delete e.notice
    },
    recordAutoResumeRecovering(state, a: PayloadAction<{ paneId: string; attempt: number; maxAttempts: number; exitCode: number; at: number }>) {
      const { paneId, ...n } = a.payload
      entry(state, paneId).notice = { kind: 'recovering', ...n }
    },
    foldTerminalReplacement(state, a: PayloadAction<{ paneId: string; newTerminalId: string; exitCode: number; attempt: number; maxAttempts: number; at: number }>) {
      const { paneId, newTerminalId, exitCode, attempt, maxAttempts, at } = a.payload
      const e = entry(state, paneId)
      delete e.exit // pane is alive again — no error bar
      e.notice = { kind: 'resumed', attempt, maxAttempts, exitCode, at }
      e.lastTerminalId = newTerminalId
    },
    clearTerminalLifecycle(state, a: PayloadAction<{ paneId: string }>) {
      delete state.byPaneId[a.payload.paneId]
    },
  },
})

export const { recordTerminalExit, recordAutoResumeRecovering, foldTerminalReplacement, clearTerminalLifecycle } = slice.actions
export default slice.reducer

export const selectExitRecordFrom = (s: TerminalLifecycleState, paneId: string) => s.byPaneId[paneId]?.exit
export const selectLastTerminalIdFrom = (s: TerminalLifecycleState, paneId: string) => s.byPaneId[paneId]?.lastTerminalId
export const selectActiveNoticeFrom = (s: TerminalLifecycleState, paneId: string, now: number) => {
  const n = s.byPaneId[paneId]?.notice
  return n && now - n.at <= AUTO_RESUME_NOTICE_TTL_MS ? n : undefined
}
// Root-state wrappers — match the RootState typing convention of the sibling
// selectors in this directory (see turnCompletionSlice.ts for the pattern):
export const selectExitRecord = (root: { terminalLifecycle: TerminalLifecycleState }, paneId: string) =>
  selectExitRecordFrom(root.terminalLifecycle, paneId)
export const selectActiveNotice = (root: { terminalLifecycle: TerminalLifecycleState }, paneId: string, now: number) =>
  selectActiveNoticeFrom(root.terminalLifecycle, paneId, now)
```
Register `terminalLifecycle: terminalLifecycleReducer` in the store-assembly file (found in Step 3's grep). Verify it is NOT added to any persist allowlist (VERIFIED: persistence is an ALLOWLIST of four slices — tabs/panes, tabRecency, turnCompletion — `persistMiddleware.ts:589-621, :631-649, :652-659`; no path serializes unknown root slices, so this slice is unpersisted with zero middleware change; do not modify persistMiddleware).

- [ ] **Step 4: Wire the three WS handlers in TerminalView**

In `src/components/TerminalView.tsx`. **Matching rule (VERIFIED constraint, D-2):** the `terminal.exit` handler clears `paneContent.terminalId`/`terminalIdRef` (`:4141-4148` — do NOT change that behavior), so the `recovering`/`replaced` handlers must match old-id frames against the pane's recorded `lastTerminalId` from the lifecycle slice, never against `paneContent.terminalId`:

- In the existing `terminal.exit` handler (~`:4101-4160`), at the TOP of the matched-id path — immediately after the `msg.terminalId === tid` match, BEFORE the `pendingDurableReplacement` (`:4102-4106`) and `exitedDuringLaunch` (`:4108-4125`) early-return branches, and therefore before the tail's clearing of `terminalIdRef`/`terminalId` (`:4141-4148`) — add (for all modes — the render layer applies the agent/non-zero policy):
  ```ts
  dispatch(recordTerminalExit({ paneId, terminalId: msg.terminalId, exitCode: msg.exitCode, at: Date.now() }))
  ```
  **Crash-during-launch analysis (fresh-eyes fix — placement is load-bearing, not stylistic).** A fast-crashing agent CLI (the e2e fixture dies within milliseconds) very plausibly exits BEFORE the `terminal.attach.ready` flip (`:3936-3941`), so the handler takes the `exitedDuringLaunch` branch into `failLaunch` (`:3024-3052`), which sets pane status `'error'` (not `'exited'`) and clears `terminalIdRef` (`:3042`) — an early-return path that never reaches `:4141`. Dispatching at the top of the matched path guarantees `lastTerminalId` (the frame-matching key) and the exit record are captured on EVERY exit path, including this dominant one. Recording in the `pendingDurableReplacement`/`exitedDuringLaunch` branches is presentation-inert (Task 7's banner additionally gates on pane status) but load-bearing for matching: the subsequent `terminal.status{recovering}` / `terminal.replaced` frames match via `lastTerminalId`, and `applyReconcileAttach` has no reconcile-flow preconditions (`panesSlice.ts:1886-1923`), so the fold rebinds a pane that settled `'error'` just as well as one that settled `'exited'`. Two supporting server facts (VERIFIED): (1) `finish_pty_exit` fans `TerminalExit` only to `s.subscribers` (`registry.rs:1436-1443`) — but a client that attaches to an already-dead terminal receives a synthesized exit replay on attach (`registry.rs:1064-1071`), so the fold→attach sequence still delivers the exit for every fast-crashing retry generation; (2) the auto-resume hub consumes `CrashEvent` from the exit hook, not from WS subscriptions, so server-side resume proceeds regardless of whether any client observed the exit frame.
- In the existing `terminal.status` handler (~`:4087`), add (matching by live tid OR the recorded lastTerminalId, since the crash has usually already cleared tid by the time `recovering` arrives):
  ```ts
  const mine = msg.terminalId === terminalIdRef.current ||
    msg.terminalId === selectLastTerminalIdFrom(store.getState().terminalLifecycle, paneId)
  if (mine && msg.status === 'recovering' && typeof msg.attempt === 'number') {
    dispatch(recordAutoResumeRecovering({
      paneId,
      attempt: msg.attempt,
      // reason text carries "attempt n/max" — parse max defensively; default 2:
      maxAttempts: Number(msg.reason?.match(/attempt \d+\/(\d+)/)?.[1] ?? 2),
      exitCode: Number(msg.reason?.match(/exit (-?\d+)/)?.[1] ?? 1),
      at: Date.now(),
    }))
  }
  ```
  (Use whatever store-access idiom the surrounding handlers already use — a `useStore`/`getState` read or a selector snapshot; mirror the file's existing pattern.)
- New `terminal.replaced` case (beside the `terminal.status` case). This TerminalView instance handles it when the old id matches its recorded `lastTerminalId` (or, defensively, a still-set live tid):
  ```ts
  const mine = msg.oldTerminalId === terminalIdRef.current ||
    msg.oldTerminalId === selectLastTerminalIdFrom(store.getState().terminalLifecycle, paneId)
  if (mine) {
    dispatch(foldTerminalReplacement({
      paneId, newTerminalId: msg.newTerminalId, exitCode: msg.exitCode,
      attempt: msg.attempt, maxAttempts: msg.maxAttempts, at: Date.now(),
    }))
    // Fold the new terminalId into this pane using the ONE reducer built for
    // server-supplied rebinds. Copy the exact payload shape from the existing
    // dispatch site in src/lib/pane-reconcile.ts:428-436 (attach verdict fold;
    // NOTE corrected citation — not :289-297). Include EVERY field that site
    // passes: applyReconcileAttach unconditionally overwrites serverInstanceId
    // (panesSlice.ts:1904), so the fold must supply the current one too.
    dispatch(applyReconcileAttach({ tabId, paneId, terminalId: msg.newTerminalId /* + the other fields pane-reconcile.ts:428-436 passes — mirror them exactly, incl. serverInstanceId */ }))
  }
  ```
  The attach-gate rule: `applyReconcileAttach` must be dispatched BEFORE the attach effect runs (bind-before-attach, `TerminalView.tsx:2477-2484`) — dispatching from the message handler satisfies this because the create-or-attach effect re-fires on the epoch bump the reducer performs (VERIFIED: reducer has no reconcile-flow preconditions, panesSlice.ts:1886-1923; epoch is in the effect deps at :4771; pinned further by Task 8).

- [ ] **Step 5: Run green + lint + commit**

```bash
npm run test:vitest -- run test/unit/client/store/terminalLifecycleSlice.test.ts
npm run lint
git add src/store/terminalLifecycleSlice.ts test/unit/client/store/terminalLifecycleSlice.test.ts src/components/TerminalView.tsx
git add <store-assembly file from Step 3>
git commit -m "feat(client): terminal lifecycle slice + crash/replace/notice ws handling"
```

---

### Task 7: Exited error bar + Relaunch button

**Files:**
- Create: `src/components/TerminalExitBanner.tsx`
- Modify: `src/components/TerminalView.tsx` (render the banner in the JSX root, ~`:4838` onward)
- Test: `test/unit/client/components/TerminalExitBanner.test.tsx` + `test/unit/client/components/TerminalView.exitBanner.test.tsx` (mirror the harness of `TerminalView.launchRetry.test.tsx` — note its `lucide-react` mock; and the click-button-assert-dispatch template in `DeadSessionPanel.test.tsx`)

**Interfaces:**
- Consumes: `selectExitRecord`/`selectActiveNotice` (Task 6); `resetPaneForReconcileCreate({ tabId, paneId, intent, sessionRef })` (`panesSlice.ts:1930` — preserves `createRequestId`, sets `status:'creating'`, `pendingReconcile:'respawn'`, bumps `reconcileEpoch`, which re-fires the create effect); `paneContent.sessionRef`/`mode`/`status` (read-only — no paneTypes changes).
- Produces: `TerminalExitBanner` component:

```ts
export interface TerminalExitBannerProps {
  mode: string                       // 'claude' | 'codex' | ...
  exitCode: number | null            // null = unknown (post-reload)
  notice: AutoResumeNotice | null    // active (TTL-filtered) notice or null
  onRelaunch: () => void
}
```

- [ ] **Step 1: Write the failing component tests**

`test/unit/client/components/TerminalExitBanner.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { TerminalExitBanner } from '@/components/TerminalExitBanner'

describe('TerminalExitBanner', () => {
  it('renders a loud error bar with the exit code and an accessible relaunch button', () => {
    const onRelaunch = vi.fn()
    render(<TerminalExitBanner mode="claude" exitCode={1} notice={null} onRelaunch={onRelaunch} />)
    const bar = screen.getByRole('alert')
    expect(bar).toHaveTextContent('process exited (code 1)')
    const btn = screen.getByRole('button', { name: 'Relaunch claude session' })
    fireEvent.click(btn)
    expect(onRelaunch).toHaveBeenCalledTimes(1)
  })

  it('renders without a code when the exit code is unknown (post-reload)', () => {
    render(<TerminalExitBanner mode="codex" exitCode={null} notice={null} onRelaunch={() => {}} />)
    expect(screen.getByRole('alert')).toHaveTextContent('process exited')
    expect(screen.getByRole('alert')).not.toHaveTextContent('(code')
  })

  it('renders a recovering notice instead of the error bar while auto-resume is in flight', () => {
    render(<TerminalExitBanner mode="claude" exitCode={1}
      notice={{ kind: 'recovering', attempt: 1, maxAttempts: 2, exitCode: 1, at: Date.now() }}
      onRelaunch={() => {}} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('claude crashed (exit 1) — auto-resuming, attempt 1/2')
  })

  it('renders a resumed notice', () => {
    render(<TerminalExitBanner mode="claude" exitCode={null}
      notice={{ kind: 'resumed', attempt: 2, maxAttempts: 2, exitCode: 1, at: Date.now() }}
      onRelaunch={() => {}} />)
    expect(screen.getByRole('status')).toHaveTextContent('claude crashed (exit 1) — auto-resumed, attempt 2/2')
  })
})
```

- [ ] **Step 2: Run to verify red**

```bash
npm run test:vitest -- run test/unit/client/components/TerminalExitBanner.test.tsx
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the banner**

```tsx
// src/components/TerminalExitBanner.tsx
// Lane D1: loud exited-pane presentation for coding-agent terminals.
// - recovering/resumed notice (server-driven auto-resume in flight/succeeded)
// - error bar + Relaunch after the pane settles exited (non-zero exit).
import type { AutoResumeNotice } from '../store/terminalLifecycleSlice'

export interface TerminalExitBannerProps {
  mode: string
  exitCode: number | null
  notice: AutoResumeNotice | null
  onRelaunch: () => void
}

export function TerminalExitBanner({ mode, exitCode, notice, onRelaunch }: TerminalExitBannerProps) {
  if (notice) {
    const verb = notice.kind === 'recovering' ? 'auto-resuming' : 'auto-resumed'
    return (
      <div role="status" className="flex items-center gap-2 px-3 py-1.5 text-sm bg-amber-500/15 text-amber-600 dark:text-amber-400 border-t border-amber-500/30">
        <span>
          {mode} crashed (exit {notice.exitCode}) — {verb}, attempt {notice.attempt}/{notice.maxAttempts}
        </span>
      </div>
    )
  }
  return (
    <div role="alert" className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm bg-destructive/15 text-destructive border-t border-destructive/30">
      <span>process exited{exitCode !== null ? ` (code ${exitCode})` : ''}</span>
      <button
        type="button"
        aria-label={`Relaunch ${mode} session`}
        className="shrink-0 rounded border border-destructive/40 px-2 py-0.5 text-xs font-medium hover:bg-destructive/20"
        onClick={onRelaunch}
      >
        Relaunch
      </button>
    </div>
  )
}
```
(Class names: reuse the project's existing tailwind token vocabulary — check a sibling error surface, e.g. `FreshAgentView.tsx:2243-2254` session-ended card, and align; keep `role`/`aria-label` exactly as tested.)

- [ ] **Step 4: Write the failing TerminalView integration test, then wire the banner**

`test/unit/client/components/TerminalView.exitBanner.test.tsx` — copy the store+render harness from `TerminalView.launchRetry.test.tsx` (including its module mocks). Scenarios:

```tsx
// 1. Agent pane, status 'exited', exit record {code:1} in lifecycle slice:
//    → role='alert' visible with 'process exited (code 1)'.
// 2. Click 'Relaunch claude session' → store state shows the pane reset for
//    respawn: status 'creating', pendingReconcile 'respawn', SAME sessionRef
//    (assert panesSlice state — this is resetPaneForReconcileCreate's effect;
//    assert sessionRef.sessionId unchanged from the seeded pane).
// 3. Shell pane, status 'exited' → queryByRole('alert') is null (shells keep
//    today's quiet presentation).
// 4. Agent pane, status 'exited', exit record {code:0} → no alert (clean-exit
//    quiet rule, D-3).
// 5. Agent pane, status 'exited', NO exit record (post-reload) → alert without
//    a code, Relaunch present.
// 6. Agent pane, status 'error' (crash-before-attach-ready settled via
//    failLaunch), exit record {code:1} → alert visible with Relaunch (same
//    user situation as 1; see Task 6's crash-during-launch analysis). A
//    status-'error' pane with NO exit record → no alert (plain launch
//    failure keeps today's presentation).
```
Write all six out fully. Then wire in `TerminalView.tsx` near the JSX root (`:4838`ff), alongside the existing overlay/panel rendering:

```tsx
// Keyed by paneId (NOT terminalId — the exit handler clears paneContent.terminalId,
// TerminalView.tsx:4141-4148, so an exited pane has no terminal id to key by):
const exitRecord = useSelector((s: RootState) => selectExitRecord(s, paneId))
const activeNotice = useSelector((s: RootState) => selectActiveNotice(s, paneId, Date.now()))

const isAgentPane = paneContent.mode && paneContent.mode !== 'shell'
// Fresh-eyes fix: a crash BEFORE terminal.attach.ready settles the pane via
// failLaunch as status 'error', not 'exited' (TerminalView.tsx:4108-4125,
// :3024-3052) — the dominant timing for a fast-crashing CLI. An agent pane in
// 'error' WITH a recorded non-zero exit is the same user situation (agent
// process died) and must show the same alert + Relaunch. Plain launch
// failures (create rejected — no exit record) keep today's presentation.
const showExitBanner = Boolean(
  isAgentPane && (
    activeNotice ||
    (paneContent.status === 'exited' && (exitRecord ? exitRecord.exitCode !== 0 : true)) ||
    (paneContent.status === 'error' && exitRecord && exitRecord.exitCode !== 0)
  )
)
// … in the JSX, below the terminal surface:
{showExitBanner && (
  <TerminalExitBanner
    mode={paneContent.mode ?? 'agent'}
    exitCode={exitRecord?.exitCode ?? null}
    notice={activeNotice ?? null}
    onRelaunch={() => dispatch(resetPaneForReconcileCreate({
      tabId, paneId, intent: 'respawn', sessionRef: paneContent.sessionRef,
    }))}
  />
)}
```
(Use the exact `resetPaneForReconcileCreate` payload shape from `panesSlice.ts:1930` — if it differs from `{tabId, paneId, intent, sessionRef}`, mirror the reducer's actual contract; `sessionRef.provider === mode` is required for a resume, else the reducer degrades loudly to a fresh create — that existing behavior is the correct fallback for identity-less panes. The TTL selector uses `Date.now()` at render. Staleness handling (fresh-eyes fix — the previous note here wrongly claimed Task 5's frames force the degradation; the exhaustion settle emits NO frame): the exhaustion path needs no TTL at all, because Task 6's `recordTerminalExit` clears the notice on the final crash, so the alert shows immediately. The TTL is the backstop for a `recovering` notice orphaned by a SILENT settle (`respawn_failed` / `session_lease_held` / `session_owned_live` / `pane_closed` — none emits a frame), and since no state change is guaranteed to arrive on a dead pane, schedule one re-render when an active notice is present: `useEffect` with a `setTimeout` firing at `notice.at + AUTO_RESUME_NOTICE_TTL_MS - Date.now() + 1` that bumps a local `useState` counter (cleared on unmount/notice change). This makes the notice→alert degradation deterministic instead of "whenever something else re-renders".)

- [ ] **Step 5: Run green + lint + commit**

```bash
npm run test:vitest -- run test/unit/client/components/TerminalExitBanner.test.tsx test/unit/client/components/TerminalView.exitBanner.test.tsx
npm run lint
git add src/components/TerminalExitBanner.tsx test/unit/client/components/TerminalExitBanner.test.tsx src/components/TerminalView.tsx test/unit/client/components/TerminalView.exitBanner.test.tsx
git commit -m "feat(client): loud exited-pane error bar with one-click relaunch for agent panes"
```

---

### Task 8: Status-tracker + chime survival across replacement (pin with tests)

**Files:**
- Test: `test/unit/client/store/turnCompletion.replacement.test.ts` (new; beside — and mirroring the harness of — the existing `test/unit/client/store/turnCompletionSlice.test.ts`)
- Modify (only if a test fails): `src/store/terminalDetachMiddleware.ts:14-28` (skip-list entry), `src/lib/pane-activity.ts` (only if activity resolution fails — not expected)

**Interfaces:**
- Consumes: `applyReconcileAttach` fold (Task 6), `turnCompletionSlice` dedupe maps (`lastIdleAtByTerminalId`), `applyServerIdle` thunk (`turnCompletionThunks.ts`), `terminalDetachMiddleware` skip list, `resolvePaneActivity` (`src/lib/pane-activity.ts:109-197`).
- Produces: pinned guarantees (regression tests) — no wedge, no false chime, no spurious detach.

- [ ] **Step 1: Write the failing/pinning tests**

```ts
// test/unit/client/store/turnCompletion.replacement.test.ts
// Lane D1: the busy/idle tracker and turn-complete dedupe survive the
// terminal being replaced under the pane by server-driven auto-resume.
describe('turn completion across terminal.replaced fold', () => {
  // Harness: real store; seed one tab/pane bound to terminalId 't1'
  // (copy the seeding helpers from the existing turnCompletion tests).

  it('chimes exactly once for terminal.idle on the NEW terminalId after the fold', () => {
    // fold t1 -> t2 (dispatch applyReconcileAttach exactly as TerminalView does)
    // dispatch applyServerIdle({terminalId:'t2', at: 100}) -> chime fired once
    // dispatch applyServerIdle({terminalId:'t2', at: 100}) again -> deduped, still once
  })

  it('drops terminal.idle for the OLD terminalId after the fold (no false chime)', () => {
    // fold t1 -> t2, then applyServerIdle({terminalId:'t1', at: 200})
    // -> no chime (owner lookup finds no pane for t1: turnCompletionThunks.ts:25-26)
  })

  it('pane activity resolves via the NEW terminalId after the fold (no permanent wedge)', () => {
    // seed an activity record for t2; assert resolvePaneActivity for the pane
    // reads t2's record (pane-activity.ts joins on paneContent.terminalId).
  })

  it('the fold does not emit a terminal.detach for the old terminalId', () => {
    // run the store WITH terminalDetachMiddleware installed and a spy on the
    // ws send fn (mirror the middleware's own tests if present — glob
    // '**/terminalDetach*.test.*'); dispatch the fold; assert no detach
    // frame for 't1' was sent (applyReconcileAttach must be in the skip list,
    // terminalDetachMiddleware.ts:14-28).
  })
})
```
Write all bodies out fully against the actual harness helpers.

- [ ] **Step 2: Run to verify status**

```bash
npm run test:vitest -- run test/unit/client/store/turnCompletion.replacement.test.ts
```
Expected: tests 1–3 likely PASS immediately (they pin existing behavior — that is fine and intended); test 4 FAILS only if `applyReconcileAttach` is missing from the detach skip list.

- [ ] **Step 3: Fix anything red**

If test 4 is red: add the fold action to the skip list in `src/store/terminalDetachMiddleware.ts` (`:14-28`), with a comment `// Lane D1: terminal.replaced fold rebinds the pane; the old terminal is already exited — never detach-storm it.` No other production change is expected; if 1–3 are red, the fold wiring from Task 6 is wrong — fix it there (payload shape vs `pane-reconcile.ts:428-436`), not by weakening the tests.

- [ ] **Step 4: Run green**

```bash
npm run test:vitest -- run test/unit/client/store/turnCompletion.replacement.test.ts
npm run lint
```

- [ ] **Step 5: Commit**

```bash
git add test/unit/client/store/turnCompletion.replacement.test.ts src/store/terminalDetachMiddleware.ts
git commit -m "test(client): pin chime/status survival across server-driven terminal replacement"
```

---

### Task 9: E2E — fake crashing claude CLI, auto-resume, exhaustion banner, relaunch

**Files:**
- Create: `test/e2e-browser/fixtures/fake-crashing-claude-cli.mjs`
- Create: `test/e2e-browser/specs/agent-crash-autoresume-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (two regex appends: `RUST_ONLY_SPECS` list `:81-147` and the `rust-chromium` project `testMatch` `:200-321`, each with a one-line justification comment — this is the sanctioned "append minimal" pattern; sibling lanes append too, so keep each append to its own line to merge cleanly)

**Interfaces:**
- Consumes: `RustServer` helper (`test/e2e-browser/helpers/rust-server.ts:272` — `start()`, ephemeral `findFreePort()`, isolated HOME, health-poll); the fake-CLI convention: server resolves `command = env[CLAUDE_CMD] || default` (`cli_launch.rs:370-373`); `installFakeCli` helper + argv-log assertion pattern from `test/e2e-browser/specs/recover-my-panes-rust.spec.ts` (`:41` install, `:306-314` delta-past-checkpoint argv assertions); `FRESHELL_AUTO_RESUME_DELAYS_MS` env (Task 1).
- Produces: end-to-end proof of every user story.

- [ ] **Step 1: Write the fixture**

```js
#!/usr/bin/env node
// test/e2e-browser/fixtures/fake-crashing-claude-cli.mjs
// Fake claude CLI for crash-resilience e2e. Behavior selection:
//   FAKE_CRASH_UNTIL=N — crash (exit 1) while invocation <= N, then SURVIVE.
//                        Takes PRECEDENCE over FAKE_CRASH_MODE: when set, the
//                        mode checks are never reached, so the 'clean' default
//                        cannot make the surviving invocation exit 0.
//   FAKE_CRASH_MODE (only when FAKE_CRASH_UNTIL is unset):
//     once   — invocation #1 prints output then exits 1; later invocations stay alive
//     always — every invocation prints then exits 1 immediately
//     clean  — prints then exits 0 (the default when neither env is set)
// Every invocation appends {pid,t,argv} to FAKE_CLAUDE_ARGV_LOG (JSONL) and
// bumps the invocation counter in FAKE_CRASH_STATE_FILE.
import fs from 'node:fs'

const argv = process.argv.slice(2)
const logPath = process.env.FAKE_CLAUDE_ARGV_LOG
if (logPath) fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, t: Date.now(), argv }) + '\n')

let invocation = 1
const stateFile = process.env.FAKE_CRASH_STATE_FILE
if (stateFile) {
  try { invocation = (parseInt(fs.readFileSync(stateFile, 'utf8'), 10) || 0) + 1 } catch { /* first run */ }
  fs.writeFileSync(stateFile, String(invocation))
}

process.stdout.write(`fake-claude invocation ${invocation} argv=${argv.join(' ')}\r\n`)

const crashUntil = Number(process.env.FAKE_CRASH_UNTIL || 0)
if (crashUntil > 0) {
  if (invocation <= crashUntil) {
    process.stdout.write('fake-claude: simulated crash\r\n')
    process.exit(1)
  }
  // invocation > N: fall through to the survive branch below WITHOUT
  // consulting FAKE_CRASH_MODE (its 'clean' default would exit 0 and
  // vacuously satisfy liveness assertions on a dead pane).
} else {
  const mode = process.env.FAKE_CRASH_MODE || 'clean'
  if (mode === 'always' || (mode === 'once' && invocation === 1)) {
    process.stdout.write('fake-claude: simulated crash\r\n')
    process.exit(1)
  }
  if (mode === 'clean') {
    process.stdout.write('fake-claude: clean exit\r\n')
    process.exit(0)
  }
}
// Survive: behave like a long-running interactive CLI.
process.stdin.resume()
setInterval(() => {}, 60_000)
```

- [ ] **Step 2: Write the failing spec**

`test/e2e-browser/specs/agent-crash-autoresume-rust.spec.ts` — one `RustServer` per test (or per-mode `describe`), booted with:

```ts
const server = new RustServer({
  env: {
    CLAUDE_CMD: fakeCliPath,                    // installFakeCli(…'fake-crashing-claude-cli.mjs')
    FAKE_CLAUDE_ARGV_LOG: argvLogPath,
    FAKE_CRASH_STATE_FILE: stateFilePath,
    FAKE_CRASH_MODE: '<per test>',           // tests 1-3; test 4 sets FAKE_CRASH_UNTIL=3 instead (and no FAKE_CRASH_MODE)
    FRESHELL_AUTO_RESUME_DELAYS_MS: '100,200',  // fast retries for CI
  },
})
```
Reuse `recover-my-panes-rust.spec.ts`'s helpers for: installing the fake CLI, creating a claude pane through the UI, and reading argv-log deltas past a checkpoint. Tests (write each fully):

```ts
test('crash → bounded auto-resume with --resume <same id> and a visible notice', async ({ page }) => {
  // FAKE_CRASH_MODE=once. Create a claude pane via the UI.
  // Invocation 1 crashes (exit 1); the server auto-resumes after ~100ms.
  // Assert (poll the argv log): 2 invocations total; invocation 2's argv
  // contains adjacent ['--resume', <id>] where <id> is the session id the
  // server minted for invocation 1 (extract it from invocation 1's argv —
  // the claude fresh-create args carry it; see recover-my-panes helpers).
  // Assert UI: the notice text /auto-resum/ appears (role=status), and the
  // pane returns to a live terminal (no role=alert error bar).
})

test('instantly re-crashing CLI exhausts retries and settles with a loud banner', async ({ page }) => {
  // FAKE_CRASH_MODE=always. Create a claude pane.
  // Assert: argv log converges to EXACTLY 3 invocations (1 original + 2
  // retries) and stays there for 1s. Assert UI: role=alert bar visible with
  // 'process exited (code 1)' and a button named 'Relaunch claude session'.
})

test('clean exit (code 0) neither resumes nor alarms', async ({ page }) => {
  // FAKE_CRASH_MODE=clean. Create a claude pane.
  // Assert: argv log has exactly 1 invocation after a 1s grace; no
  // role=alert, no role=status auto-resume notice (quiet exited presentation).
})

test('Relaunch button drives a resume with the same session id', async ({ page }) => {
  // Boot THIS test's server with FAKE_CRASH_UNTIL=3 and NO FAKE_CRASH_MODE.
  // The fixture's FAKE_CRASH_UNTIL branch takes precedence over the mode
  // checks, so invocations 1..3 crash (exit 1) and invocation 4 SURVIVES as
  // a long-running process (it never reaches the 'clean' default, which
  // would exit 0 and make the liveness assertions below vacuous).
  // Create a claude pane → it settles exhausted after 3 invocations
  // (1 original + 2 retries) with the role=alert bar and the
  // 'Relaunch claude session' button. Click Relaunch. Assert:
  //  - invocation 4 appears in the argv log with adjacent
  //    ['--resume', <same id>];
  //  - the alert bar disappears;
  //  - the pane is genuinely LIVE: the argv log stays at EXACTLY 4
  //    invocations for >=1s (a clean exit-0 would re-settle the pane; a
  //    crash would append invocation 5), and no role=alert bar or
  //    role=status auto-resume notice reappears in that window.
})
```
(The 4th test's `FAKE_CRASH_UNTIL` mechanism is already part of Step 1's fixture code above — crash while `invocation <= N`, then survive, bypassing the mode checks entirely so the `'clean'` default cannot exit 0 on the surviving invocation.)

Append to `playwright.config.ts` (both lists):
```ts
  // Lane D1: agent crash auto-resume — rust-server-only spec.
  /agent-crash-autoresume-rust\.spec\.ts$/,
```

- [ ] **Step 3: Run to verify red→green**

First run (before any of Tasks 1–8 landed it would be fully red; at this point the feature exists, so the spec should pass — if any test is red, the FEATURE is wrong, fix the feature not the test):

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/agent-crash-autoresume-rust.spec.ts
```
Expected: 4 PASS. (First run pays a cold cargo release build — allow it. NEVER point these tests at ports 3001/3002.)

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/fixtures/fake-crashing-claude-cli.mjs test/e2e-browser/specs/agent-crash-autoresume-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): agent crash auto-resume, exhaustion banner, clean-exit quiet, relaunch"
```

---

### Task 10: Full gates, push, report (NO PR)

**Files:** none new.

**Interfaces:**
- Consumes: everything above.
- Produces: pushed branch + red→green proof for the lane report.

- [ ] **Step 1: Full Rust gates**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace --locked
```
Expected: clean. Fix anything red before proceeding (fmt via `cargo fmt --all`).

- [ ] **Step 2: Contract + lint + coordinated JS suite (gate-aware)**

```bash
npm run contract:generate && git diff --exit-code -- port/contract
npm run test:port
npm run lint
npm run test:status   # WAIT if a sibling lane holds the gate
FRESHELL_TEST_SUMMARY="lane D1 final: agent crash auto-resume + exited banner" env -u FRESHELL_BIND_HOST npm test
```
Expected: all green.

- [ ] **Step 3: E2E re-run (fresh, both new + neighbor smoke)**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/agent-crash-autoresume-rust.spec.ts specs/recover-my-panes-rust.spec.ts
```
Expected: green (the neighbor spec proves the create-path refactor didn't break client-driven respawn).

- [ ] **Step 4: Push and STOP (PR policy)**

```bash
git push -u origin feat/agent-crash-resilience
```
Do NOT run `gh pr create`. Produce the lane report: branch name, base sha, per-task red→green evidence (test names + the failing-then-passing commands from each task), the D-1…D-5 design decisions, and any deviations recorded in task notes.

---

## Self-Review (performed at plan time)

**1. Spec coverage.**
- Server bounded auto-resume, non-zero only, agent modes only → Tasks 1, 2, 5 (decision fn + hook gating + orchestrator).
- ~2 retries with backoff 2s/10s → Task 1 (`AUTO_RESUME_DEFAULT_DELAYS_MS`), Task 5 schedule tests.
- Respawn-cap machinery as loop bound → Task 1 `cap_exhausted` + Task 5 driver `respawn_exhausted` (first live consumer of the cap outside reconcile — reconcile itself untouched).
- Clean exit / user close never resume → Task 1 (`clean_exit`), Task 2 (kill → `finish_pty_exit == false` → no CrashEvent, integration-tested).
- No-identity settles exited immediately → Tasks 1 & 5.
- User-visible notice per attempt → Task 5 `terminal.status{recovering}` + Tasks 6/7 rendering; frame-shape evaluation documented in D-2 (reuse `terminal.status`, add `terminal.replaced`).
- Protocol addition updates frozen contract, `contract:generate`, both pins, `test:port` green → Task 3 (single-commit rule + determinism check).
- Client error bar "process exited (code N)" + Relaunch resuming from sessionRef → Task 7; plain shells keep current behavior (test 3); exited panes never auto-respawn client-side (relaunch is manual; auto-resume is server-driven — no client auto-create added anywhere).
- Notices rendered → Tasks 6/7.
- a11y real button + aria-label + lint clean → Task 7 tests + lint steps.
- Status interaction: no wedge/false chime, fold-vs-duplicate verified, reconcile/attach machinery for server-initiated replacement investigated and pinned → D-4 + Task 8 tests; offline-client fold rides existing reconcile attach verdicts (untouched).
- TDD server unit tests (all six spec-listed scenarios) → Tasks 1, 2, 5. Client tests (banner/relaunch/notices) → Tasks 6–8. E2E (own RustServer, ephemeral ports, fake claude crash-once / crash-always / clean / relaunch, argv `--resume <same id>` assertions) → Task 9.
- Clean-exit presentation decision + justification → D-3 (quiet, justified).
- Scope fence, repo rules, PR policy → Global Constraints + Task 0 + Task 10.

**1b. No silent deferrals.** Every user-facing requirement lands as production behavior proven by a non-mocked test: the auto-resume, banner, relaunch, and notices are all exercised end-to-end in Task 9 against a real server + real browser (the fake CLI substitutes only the third-party claude binary — the repo's established e2e convention for asserting provider argv, same as `recover-my-panes-rust.spec.ts`). Unit-level fakes (`FakeDriver`, headless terminals) are superseded by Task 5's registry-integration test and Task 9's e2e. No requirement was moved to known-limitations/future-work. Two explicitly-pinned known behaviors are *pre-existing and unchanged*, not deferrals: codex resume-busy seeding (D-4, shared with the existing client-driven respawn path) and the post-reload codeless banner (D-3, tested in Task 7 scenario 5).

**2. Placeholder scan.** Remaining prose-shaped steps are mirror-existing-code instructions with exact source anchors (Task 2's `ExitHookDeps` field types ← `terminal.rs:1680-1690`; Task 4's pipeline ← `handle_create` blocks with line ranges; Task 6's `applyReconcileAttach` payload ← `pane-reconcile.ts:428-436`) — each names its authoritative source and a fidelity rule, so the implementer copies rather than invents. Test sketches marked "write fully" enumerate their exact scenario and assertions. No TBD/TODO/"handle edge cases" remain.

**3. Type consistency.** `CrashEvent`/`CrashContext`/`decide` names match across Tasks 1/2/5; `RespawnSpec` (driver-level) vs `AgentRespawnRequest` (seam-level) are distinct on purpose (the driver adapts one to the other in Task 5's production impl); `terminal.replaced` field names match TS (`oldTerminalId`…) ↔ Rust camelCase serde across Tasks 3/5/6; slice action/selector names match across Tasks 6/7/8; banner roles/labels match between component and tests; `FRESHELL_AUTO_RESUME_DELAYS_MS` spelled identically in Tasks 1, 5, 9.

**Known verification points for reviewers (not gaps):** exact `WsState` field types in `ExitHookDeps`, the `terminal.status` Rust struct name, and the `resetPaneForReconcileCreate`/`applyReconcileAttach` payload shapes are mirrored from cited code at implementation time; the plan pins their behavior with tests rather than guessing their signatures.

---

## Stage-2 Load-Bearing Validation (addendum, 2026-07-27)

24 load-bearing assumptions were surfaced and 22 validated against the actual repo (evidence ledger: `.worktrees/.the-usual-logs/agent-crash-resilience/load-bearing-ledger.md` + `reports/V1.md`–`V8.md`). 18 verified; 4 falsified and FIXED in this plan revision:

1. **Exited panes do NOT retain `terminalId`** (TerminalView clears it at exit, `:4141-4148`) → the client lifecycle slice is keyed by **paneId** with a `lastTerminalId` mapping; `recovering`/`replaced` frames match via that mapping (D-2 note; Tasks 6/7 rewritten accordingly).
2. **A second exit-hook construction site exists** in fenced `freshell-freshagent/terminal_tabs.rs:1009-1043` → REST-created panes documented out of auto-resume scope this lane (Task 2 scope note).
3. **codex/opencode/amplifier session ids are discovered only at first prompt** (claude alone is preallocated at create) → per-provider provenance documented in D-5; pre-discovery crashes settle `no_resumable_identity` by design.
4. **Terminal-pane `BindingRow` launch fields are hardcoded `None`** (`pane_ledger.rs:405-408`) → Task 4 derives launch params from `state.settings` as `handle_create` does.

Verified-with-amendment items folded in: SpawnGate acquire added to the Task 4 seam (in-path for all creates); orchestrator lease discipline pinned (mint `holder_conn` via `new_connection_id()`, own every release path); binding-still-Bound pre-respawn guard added (bounds the crash-then-kill race); `corrected` flag semantics corrected in D-2 (None for same-session replacement) with a mandatory reconcile-after-replacement pin test in Task 5 step 4(d); `applyReconcileAttach` fold payload mirrors `pane-reconcile.ts:428-436` incl. `serverInstanceId`.

Self-review re-run over the edited tasks (incl. 1b): every user-facing requirement still lands as production behavior proven by non-mocked tests — the paneId re-keying changes only the client data model, not what is proven (Task 9's e2e assertions are unchanged and remain the end-to-end proof); the REST-pane scope exclusion is a documented boundary of a fenced subsystem, not a silent deferral (WS-created agent panes — the product surface this feature targets — are fully covered); no new TBDs introduced; type/name consistency between Tasks 6/7/8 sketches re-checked after re-keying (`paneId` payloads, `selectExitRecord(root, paneId)`, `selectLastTerminalIdFrom`).

---

## Fresh-Eyes Review Fixes (iteration 1 addendum, 2026-07-27)

An independent cross-model review found three blocking (major) executable defects; all three are fixed in this revision (evidence for the repo facts cited below: `.worktrees/.the-usual-logs/agent-crash-resilience/reports/fix-facts.md`):

1. **Stale notice masked the settled error bar (Tasks 6/7/9).** The exhaustion settle emits no frame, so the previous `resumed` notice (30s TTL) would hide the `role=alert` bar and Relaunch button on a dead pane, making Task 9 tests 2 and 4 unpassable. Fixed: `recordTerminalExit` now clears any notice (an exit is always newer truth; pinned by a new slice test), and Task 7's wiring note was corrected — the old claim that "Task 5's frames guarantee degradation within seconds" was false for silent settles, so a deterministic TTL-expiry re-render (`setTimeout` in a `useEffect`) is now mandated as the backstop for orphaned `recovering` notices (`respawn_failed`/lease/guard settles emit nothing).

2. **Crash-during-launch path was unanalyzed (Tasks 6/7).** A CLI that dies before `terminal.attach.ready` (the e2e fixture's dominant timing) takes the `exitedDuringLaunch` → `failLaunch` branch (status `'error'`, `terminalIdRef` cleared at `TerminalView.tsx:3042`) — an early return that never reached the previously-specified `recordTerminalExit` insertion point, orphaning the frame-matching key. Fixed: `recordTerminalExit` is dispatched at the TOP of the matched-id exit path (before the `pendingDurableReplacement`/`exitedDuringLaunch` early returns), with a written analysis of why that placement is load-bearing; `showExitBanner` now also covers agent panes settled `'error'` WITH a recorded non-zero exit (new Task 7 scenario 6); and the subscriber-only `TerminalExit` fan-out concern is closed by the verified synthesized-exit replay on attach (`registry.rs:1064-1071`) plus the hub consuming `CrashEvent` from the exit hook rather than WS subscriptions.

3. **Task 5 driver trait could not implement the mandated lease discipline.** The real registry API is asymmetric — `complete_session_ref_claim(locator, holder_create_request_id, terminal_id) -> bool` (`registry.rs:1964`) vs `fail_session_ref_claim(locator, holder_create_request_id)` (`registry.rs:2007`) — and the claim returns a four-variant `SessionRefClaim` (`registry.rs:467-486`), so the old symmetric `release_claim(provider, session_id)` / boolean-only `claim_session` trait was unimplementable and its pinned tests would have frozen the wrong shape. Fixed: the trait now exposes `claim_session(..., create_request_id)` (production impl runs the ingress's full bounded claim rounds, `terminal.rs:1147-1214`, headlessly), `complete_claim(..., new_terminal_id) -> bool` (complete==false → kill own child, mirroring `terminal.rs:1986-2029`), `fail_claim(...)` (explicit — the headless driver holds no RAII `SessionRefLeaseGuard`), and `pre_respawn_guard(...) -> Option<&'static str>` (distinguishes `session_owned_live` from `pane_closed`, with a ledger-disabled caveat); the hub sketch and unit-test list were updated accordingly (two new scenarios: `pane_closed` guard and `lease_completion_lost`).

Self-review re-run over the edited tasks (Tasks 5/6/7): no new placeholders; type/name consistency re-checked (`pre_respawn_guard`/`claim_session`/`complete_claim`/`fail_claim` names match across trait, hub sketch, test comments, and driver bullets; slice action behavior matches its tests and Task 7's wiring note); every user-facing requirement still lands as production behavior proven by non-mocked tests — Task 9's four e2e assertions are unchanged and are now achievable on both the post-attach (`'exited'`) and crash-during-launch (`'error'`) settle timings.

---

## Fresh-Eyes Review Fixes (iteration 2 addendum, 2026-07-27)

The second independent cross-model review found two blocking (major) executable defects; both are fixed in this revision (repo facts verified in `.worktrees/.the-usual-logs/agent-crash-resilience/reports/fix-facts-iter2.md`):

1. **Task 9 e2e test 4's fixture arrangement made the relaunched invocation exit 0 instead of survive.** The old instruction "boot with FAKE_CRASH_UNTIL=3, no FAKE_CRASH_MODE" combined with a fixture whose mode defaulted to `'clean'` meant invocation 4 printed and exited 0 immediately — the alert-disappears assertion would pass *vacuously* (banner is status-gated at Relaunch's `'creating'` reset; code-0 death is clean-exit-quiet) without proving the Relaunch restores a LIVE pane. An incoherent alternative ("FAKE_CRASH_MODE=once + pre-seed the state file so 1..3 crash") was also given (`once` crashes only invocation #1; pre-seeding *raises* invocation numbers). Fixed: `FAKE_CRASH_UNTIL` is now part of Step 1's fixture code with explicit precedence semantics — crash while `invocation <= N`, then SURVIVE, bypassing the mode checks entirely so the `'clean'` default cannot fire; test 4's comment now states the arrangement plainly and adds an explicit liveness assertion (argv log stays at exactly 4 invocations for >=1s, no alert/notice reappears); the incoherent alternative and the stale "one small fixture addition" note were removed.

2. **Client test paths contradicted the plan's own placement rules and the repo convention.** The File Structure table and every red/green/commit command in Tasks 6/7/8 hardcoded `src/store/**`/`src/components/**` test paths, while the plan's conditional placement rules (and the repo: VERIFIED zero `*.test.*` files under `src/`; all client unit tests under `test/unit/client/{store,components}/`; vitest default include + attested `npm run test:vitest -- run test/unit/client/...` invocation form) resolve to `test/unit/client/**`. Fixed: all 22 references across the File Structure table, Task 6 (slice tests, run/`git add` commands), Task 7 (banner + integration tests, run/`git add` commands), and Task 8 (turn-completion replacement test, run/`git add` commands) now use `test/unit/client/store/` / `test/unit/client/components/`, and the conditional hedges were replaced with the verified convention statement.

Self-review re-run over the edited tasks (File Structure table, Tasks 6/7/8 commands, Task 9 steps 1-2): fixture code, test-4 comment, the RustServer env sketch, and the post-spec note all agree on FAKE_CRASH_UNTIL precedence; tests 1-3 still exercise the unchanged `FAKE_CRASH_MODE` branch (`crashUntil=0` falls to the mode checks); every `npm run test:vitest -- run <path>` / `git add <path>` names a path the same task creates; no new TBDs or placeholders introduced; Task 9's four e2e assertions remain the end-to-end proof of every user story, with test 4 now proving liveness non-vacuously.

## Fresh-Eyes Review Fixes (iteration 3 addendum, 2026-07-27)

The third independent cross-model review found two blocking (major) executable defects — both residues of the iteration-2 path relocation; both are fixed in this revision:

1. **Task 6's fully-written slice test imported `./terminalLifecycleSlice` relative to its own file.** With the test at `test/unit/client/store/terminalLifecycleSlice.test.ts` and the module at `src/store/terminalLifecycleSlice.ts`, a relative `./` import can never resolve — the test fails with module-not-found both before AND after implementation, making Step 5's "run green" gate unachievable and the red state indistinguishable from the intended one. Fixed: the import is now `@/store/terminalLifecycleSlice`, matching the repo convention (VERIFIED: `tsconfig.json:25` maps `@/*`; sibling `test/unit/client/store/turnCompletionSlice.test.ts` imports `@/store/turnCompletionSlice`). Step 2's "Expected: FAIL — module not found" remains true pre-implementation (the alias target does not exist yet) and Step 5's green run becomes achievable once `src/store/terminalLifecycleSlice.ts` lands.

2. **Task 7's fully-written banner test imported `./TerminalExitBanner` relative to its own file.** Same defect: test at `test/unit/client/components/TerminalExitBanner.test.tsx`, component at `src/components/TerminalExitBanner.tsx`. Fixed: the import is now `@/components/TerminalExitBanner` (sibling component tests under `test/unit/client/components/` use the same `@/` alias form). Red/green semantics preserved as in fix 1.

Self-review re-run over the edited tasks (Task 6 Step 1, Task 7 Step 1): the only remaining relative import in plan code is `../store/terminalLifecycleSlice` inside the `src/components/TerminalExitBanner.tsx` implementation sketch (line ~1393), which is CORRECT — it resolves from `src/components/` to `src/store/`, matching how the component will actually import the slice; Task 8's test is a prose sketch with no import lines; Task 6's TerminalView wiring snippets reference slice symbols only; no run/`git add` command paths changed; no new TBDs or placeholders introduced.
