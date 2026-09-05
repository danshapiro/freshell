# OpenCode Identity Invariant Re-Gate (issue #702) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix the defect confirmed by the investigation of GitHub issue danshapiro/freshell#702: in the Freshell Rust server, the `terminal_identity_unresolved` invariant (crates/freshell-ws/src/invariants.rs, `IDENTITY_RESOLUTION_GRACE_MS = 10_000`) false-fires on fresh OpenCode terminal panes — it fired for 12 of 12 opencode terminals in one day's production log — because OpenCode terminal-pane session identity is answer-triggered: the `ses_*` session row in opencode.db (and therefore any resolvable identity) provably does not exist until the user submits the first prompt. Re-gate the invariant so it alarms only when an identity is genuinely resolvable but unresolved, keeping the alarm armed for real correlation failures.

### Explicit constraints
- Work only in the dedicated worktree /home/dan/code/freshell/.worktrees/opencode-identity-invariant on branch the-usual/opencode-identity-invariant, created from origin/main (5b3851322).
- Do not change the by-design arbitration where the TUI-plugin signal outranks the locator (`opencode_association_rejected: terminal_already_bound`) or its pinned tests (e.g. `signal_bound_terminal_rejects_a_later_located_event`).
- Keep the invariant armed for genuinely resolvable-but-unresolved opencode terminals and keep behavior unchanged for non-opencode modes.
- Use red/green/refactor TDD for all code changes; do not reduce or weaken existing test coverage.
- Do not create a pull request.
- Do not restart or deploy the production Freshell server (port 3001).

### Accepted tradeoffs and residuals
- The `terminal_already_bound` WARN that follows a successful TUI-signal first bind is designed behavior and remains as-is.

**Goal:** `terminal_identity_unresolved` never fires for an opencode terminal pane while no correlatable session row exists for it (the #702 false-fire), and still fires when candidate evidence existed but no identity ever bound.

**Architecture (as built — the Execution-time amendments section below tracks the drift from the planning-time interfaces):** One re-gate across two crates. `freshell-sessions`' `OpencodeLocator` carries a per-terminal *candidate-evidence latch* — the first ms an evaluated correlation window ended in an **ambiguous or contested refusal** (the window had correlatable rows that could provably not be attributed) — exposed as `identity_resolvable_since(terminal_id)`; a sole-candidate emission never latches, and neither does a drain-side refusal of one (`session_bound_elsewhere` / `freshagent_*` — a FOREIGN session, not this pane's evidence; plan-review R2). The plan-review R1 hole (rows that materialized after a closed window, or a window zeroed by a transient DB error, with a lost TUI signal) is closed by a SPLIT probe pair: `probe_candidates(terminal_id)` — ONE bounded `list_sessions_since(arm_ms − pre_epsilon)` read, issued only for an armed, ever-submitted (`first_submit_ms.is_some()`) terminal, throttled to at most one read per 60s per terminal, applying the same candidate filters as `resolve_windows` minus the deadline (`deadline: None`), returning candidate ids while performing NO latch and NO availability exclusions — and `note_resolvable_evidence(terminal_id, at_ms)`, the first-evidence-wins latch write, dropped when the pane disarmed mid-flight. `freshell-ws`'s `warn_unresolved_terminal_identities` is a PURE-DECISION pass (no SQLite reads): for `mode == "opencode"` rows it warns only when latched evidence is older than the grace, and otherwise returns the probe-wanted queue — opencode rows that are running, identity-unbound, past the create-age grace, and latch-miss (delta r4 additionally requires `probe_eligible`, so never-submitted panes never enter the queue at all). The sweep offloads the pass to `tokio::task::spawn_blocking` (the `drain_and_associate` precedent) and then, in the SAME sweep tick, runs the async `opencode_probe_phase`: per queued pane it runs the locator's bounded read on the blocking pool and applies the FULL availability exclusion set against CURRENT async state AFTER the read — the identity registry (retired-inclusive), fresh-agent pane-ledger rows, and LIVE fresh-opencode sessions via the injected per-candidate `has_live_session` check — latching any survivor as evidence (first-wins); evidence older than the grace alarms on a later pass. When the locator is unavailable at boot, opencode keeps the create-age tripwire so a broken topology still alarms. Non-opencode modes are byte-identical in behavior. A fresh opencode pane that never ARMS (create carried no resolvable cwd) stays alarm-silent by design while the locator is present — a documented residual: no row can ever be attributed to it and the TUI signal lane covers its identity. A scoped end-to-end pin on the existing never-submitted negative-control pane in `opencode-terminal-restore-rust.spec.ts` proves the #702 idle class silent end-to-end. Accepted residuals: a same-cwd sibling in a genuinely broken state (submitted, row created, bound nowhere) latches evidence on an idle-but-submitted pane via the probe — collateral alarm noise only in an already-broken world; a DB read error AT the probe defers detection to the next throttle interval (self-healing); a late row is discovered at most one probe-throttle interval (60s) late.

**Tech Stack:** Rust workspace (`freshell-sessions`, `freshell-ws`), rusqlite-seeded temp-DB unit tests (existing in-file patterns), Playwright e2e (`rust-chromium` project, fake-opencode fixture).

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/opencode-identity-invariant`; base_ref `5b3851322e0ddc60d6c6c10d9b05a27c490ada2e`.
- Keep the WARN's leading grep token `terminal_identity_unresolved` byte-identical; dashboards and e2e pins grep it. Message body may stay unchanged.
- The invariant's `age_ms` structured field keeps meaning "ms since terminal create".
- `OpencodeLocator` must stay zero-DB-read on construction and on `tick` while unarmed (pinned by `tick_while_unarmed_performs_zero_db_scans`); the new accessor performs no I/O.
- Do NOT touch: the signal-outranks-locator arbitration (`opencode_association.rs` `terminal_already_bound` reject + `signal_bound_terminal_rejects_a_later_located_event`), the `opencode_rebind_heartbeat_missing` sibling alarm (its 120s hello grace is pre-submit-safe by design), the codex locator/association lanes.
- Non-opencode invariant behavior must not change; the existing five `invariants.rs` tests plus the e2e absence pins (`compound-restart-rust.spec.ts`, `codex-terminal-bounce-rust.spec.ts`, `amplifier-restore-rust.spec.ts`) are the guard rail.
- TDD per repo rule: red test first, observe the intended failure, minimal implementation, green, refactor while green. For NEW Rust API surface, the RED observation is a compile failure (test references a not-yet-existing method); state that explicitly when observing it.
- Focused test commands only during tasks: `cargo test -p freshell-sessions ...`, `cargo test -p freshell-ws ...`. The broad coordinated npm suite (`npm run check`) runs once at the end via the run-level gate, NOT inside tasks. On THIS host, any vitest run must be prefixed `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy` (ambient proxy env leaks Node's EnvHttpProxyAgent experimental warning into spawned CLI children's stderr and fails two unrelated suites — pre-existing host issue, reproduction receipts in run-state.md).
- Run the involved e2e specs with `npm run test:e2e:local -- ...`. `opencode-terminal-restore-rust`, `codex-terminal-bounce-rust`, and `amplifier-restore-rust` are in `CLOUD_SKIP_SPECS` — local runs are their ONLY coverage; `compound-restart-rust` and `opencode-rebind-rust` additionally run under the cloud backend, which this run does not exercise. First e2e run pays a one-time `cargo build --release -p freshell-server` inside the harness.
- Commits use the repo's conventional style (see `git log`); never alter git identity config; no PR.
- `docs/plans/` files are historical — never edit an old plan doc. No `AGENTS.md`/`README.md`/`docs/index.html` change is needed (internal observability + test-only change; AGENTS.md does not name this invariant).

## Execution-time amendments

Interface drift since the plan was written, in chronological order — one line each (atomic history, not prose re-litigation). Code blocks in the tasks below are the pre-amendment design; this section and the source tree take precedence wherever they disagree.

- **Plan r1** (`6b9850773`): the probe hole-closing design added — for ever-submitted panes whose windows never latched evidence, an alarm-time probe closes the signal-lost / late-row hole the window latch cannot see.
- **Plan r2** (`40ba30908`): the latch narrowed to ambiguous/contested refusals only; the probe gained the create-age gate + the 60s per-terminal throttle; the e2e pin gained its positive control.
- **Delta r3** (`dc060c79a`; RED-dance hardening `6c0a5d3b1`; substitution variant `8ce626993`): the probe additionally excludes LIVE fresh-opencode sessions (not just ledgered/claimed ones); the e2e RED dance became a non-destructive git-apply pair, then base-content substitution so later same-file commits cannot kill it.
- **Focused r2** (`788194821`): the in-line probe split into read/latch — `probe_resolvable` became `probe_candidates` (bounded read, blocking pool) + `note_resolvable_evidence` (first-wins latch, disarm-dropped); `warn_unresolved_terminal_identities` became a pure-decision pass returning the probe-wanted queue, and the availability exclusions moved into the sweep's new async `opencode_probe_phase`, applied against post-read CURRENT state.
- **Focused r3** (`aeb878351`): the phase's live fresh-session check was injected per candidate, so the post-read per-candidate check ORDER is a directly pinned, discriminating contract of the phase itself.
- **Delta r4** (this repair's code commit, SHA recorded in `usual-sdd/delta-repair-4-report.md`): the `probe_eligible(terminal_id, now_ms)` queue gate — the pass queues only probe-eligible panes (armed, unlatched, ever-submitted, outside the 60s throttle), so never-submitted panes never enter the probe-wanted queue (no per-sweep spawn_blocking churn).

---

### Task 1: Locator candidate-evidence latch (`identity_resolvable_since`)

**Note:** Code blocks below are the pre-amendment design captured at planning time; the as-built interfaces in the Execution-time amendments section and the source tree take precedence.

**Files:**
- Modify: `crates/freshell-sessions/src/opencode_locator.rs` (state struct `Inner` ~:122-125, `resolve_windows` ~:367-373, `disarm` ~:240-242, new accessor next to `armed_count` ~:174-176; tests in `mod tests` at end of same file)

**Interfaces:**
- Consumes: nothing new (pure in-memory latches inside the existing `Mutex<Inner>`; the probe reuses `query_candidates` and the `resolve_windows` candidate filters).
- Produces:
  - `pub fn identity_resolvable_since(&self, terminal_id: &str) -> Option<i64>` — first ms an evaluated window ended in an ambiguous or contested refusal (a correlatable in-window row existed that could not be attributed); `None` = nothing resolvable has ever existed for this terminal. Sole-candidate emissions never latch.
  - `pub fn probe_resolvable(&self, terminal_id: &str, now_ms: i64, is_unavailable: &dyn Fn(&str) -> bool) -> Option<i64>` — for an ARMED terminal with no latched evidence that has ever submitted (`first_submit_ms.is_some()`): at most one bounded `list_sessions_since(arm_ms − pre_epsilon)` read per `PROBE_THROTTLE_MS` (60s) per terminal; locator-side candidate filters (cwd match, `parent_id` null, 3-views unmarked, not in `known_ids`, `time_created >= arm_ms − pre_epsilon`; NO deadline), minus any id the predicate rejects (already-claimed or fresh-agent); non-empty result latches and returns `Some(now_ms)`. Returns latched evidence unchanged when already present; `None` — with ZERO DB reads — when throttled, not armed, never submitted, or the probe is empty.

- [ ] **Step 1: Write the failing behavioral tests**

Append these tests to `mod tests` in `crates/freshell-sessions/src/opencode_locator.rs` (helpers `unique_temp_dir`, `open_seed_db`, `insert_session` already exist in that module; match their style):

```rust
    // -- 17. resolvable-evidence latch (issue #702): the invariant gate's
    // "a correlatable row provably existed" signal. --

    #[test]
    fn no_candidate_ever_seen_reports_no_evidence() {
        // The #702 false-fire class: a fresh pane whose user has not
        // submitted a prompt has NO session row anywhere (opencode writes it
        // lazily at first prompt) -- neither the empty spawn-anchored
        // evaluation nor a later empty Enter is resolvable identity.
        let home = unique_temp_dir("evidence-none");
        open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1_000));
        // Spawn-anchored window closes with zero candidates.
        assert!(locator.tick(1_000 + OPENCODE_WINDOW_MS + 1).is_empty());
        assert_eq!(locator.identity_resolvable_since("t1"), None);

        // An empty Enter (no row created) also yields no evidence.
        let enter_at = 10_000;
        assert!(locator.note_submit("t1", enter_at));
        assert!(locator.tick(enter_at + OPENCODE_WINDOW_MS + 1).is_empty());
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        assert_eq!(locator.identity_resolvable_since("never-armed"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn ambiguous_candidates_latch_resolvable_evidence() {
        let home = unique_temp_dir("evidence-ambiguous");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        insert_session(&db, "ses_a", "/proj", 150, None, None);
        insert_session(&db, "ses_b", "/proj", 160, None, None);

        let evidence_at = 100 + OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(evidence_at).is_empty(), "still refused");
        assert_eq!(locator.identity_resolvable_since("t1"), Some(evidence_at));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn contested_cwd_latches_evidence_for_every_contender() {
        let home = unique_temp_dir("evidence-contested");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.arm("t2", "opencode", true, None, Some("/proj"), 10));
        assert!(locator.note_submit("t1", 100));
        assert!(locator.note_submit("t2", 150));
        insert_session(&db, "ses_contested", "/proj", 200, None, None);

        let evidence_at = 150 + OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(evidence_at).is_empty(), "contested: binds nobody");
        assert_eq!(locator.identity_resolvable_since("t1"), Some(evidence_at));
        assert_eq!(locator.identity_resolvable_since("t2"), Some(evidence_at));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn located_emission_never_latches_evidence() {
        // Plan-review R2, finding 1: a sole-candidate emission is NOT this
        // pane's resolvable-identity evidence. The healthy bind discharges
        // via the identity row; a drain-side refusal of a sole candidate
        // (`session_bound_elsewhere`, `freshagent_*`) is a FOREIGN session —
        // latching it would false-alarm 10s later on a pane whose own row
        // may never have existed. Ambiguity/contested refusals are the only
        // window-latch producers.
        let home = unique_temp_dir("evidence-no-emission");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1_000));
        assert!(locator.note_submit("t1", 1_100));
        insert_session(&db, "ses_emitted", "/proj", 1_150, None, None);

        let located = locator.tick(1_100 + OPENCODE_WINDOW_MS + 1);
        assert_eq!(located.len(), 1);
        assert_eq!(locator.armed_count(), 0, "emission disarms");
        assert_eq!(
            locator.identity_resolvable_since("t1"),
            None,
            "a sole-candidate emission must never count as evidence"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn disarm_clears_resolvable_evidence() {
        let home = unique_temp_dir("evidence-disarm");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        insert_session(&db, "ses_a", "/proj", 150, None, None);
        insert_session(&db, "ses_b", "/proj", 160, None, None); // ambiguous: stays armed, evidence latched
        let evidence_at = 100 + OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(evidence_at).is_empty());
        assert_eq!(locator.identity_resolvable_since("t1"), Some(evidence_at));

        locator.disarm("t1");
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn resolvable_evidence_keeps_the_first_observation_time() {
        let home = unique_temp_dir("evidence-first-wins");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        insert_session(&db, "ses_a", "/proj", 150, None, None);
        insert_session(&db, "ses_b", "/proj", 160, None, None); // ambiguous
        let first_at = 100 + OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(first_at).is_empty());

        // A later re-opened window also sees candidates; the FIRST time wins.
        insert_session(&db, "ses_c", "/proj", first_at + 10, None, None);
        assert!(locator.note_submit("t1", first_at + 50));
        let second_at = first_at + 50 + OPENCODE_WINDOW_MS + 1;
        let _ = locator.tick(second_at);
        assert_eq!(locator.identity_resolvable_since("t1"), Some(first_at));
        let _ = std::fs::remove_dir_all(&home);
    }

    // -- 18. probe_resolvable: closes the signal-lost / late-row hole the
    // window-latch cannot see (plan review R1). Never probes a
    // never-submitted pane; never reads the DB for unarmed/never-submitted
    // terminals. --

    #[test]
    fn probe_never_reads_for_unarmed_or_never_submitted_terminals() {
        let home = unique_temp_dir("probe-noread");
        let db = open_seed_db(&home);
        insert_session(&db, "ses_neighbor", "/proj", 150, None, None);
        let locator = OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-idle", "opencode", true, None, Some("/proj"), 100));

        // arm() performs its own one-shot snapshot read; baseline AFTER it.
        let scans = locator.db_scan_count();
        // Never submitted => no probe, no DB read, no evidence (the #702
        // idle-neighbor case: a pane whose user typed nothing has no session
        // of its own, so nothing may be attributed to it).
        assert_eq!(
            locator.probe_resolvable("t-idle", 50_000, &|_| false),
            None
        );
        assert_eq!(
            locator.probe_resolvable("never-armed", 50_000, &|_| false),
            None
        );
        assert_eq!(
            locator.db_scan_count(),
            scans,
            "never-submitted/unarmed probes must perform zero DB reads"
        );
        assert_eq!(locator.identity_resolvable_since("t-idle"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn probe_latches_evidence_for_a_submitted_pane_with_an_unclaimed_row() {
        let home = unique_temp_dir("probe-latch");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1_000));
        assert!(locator.note_submit("t1", 1_100));
        // Window closed EMPTY (row not yet visible), then the row lands LATE —
        // after the 2s Enter-anchored deadline — with no further Enter (the
        // plan-review R1 hole).
        let closed_at = 1_100 + OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(closed_at).is_empty());
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        insert_session(&db, "ses_late", "/proj", closed_at + 500, None, None);

        let probe_at = closed_at + 60_000;
        assert_eq!(
            locator.probe_resolvable("t1", probe_at, &|_| false),
            Some(probe_at),
            "late row + submitted pane + no bind = resolvable evidence"
        );
        assert_eq!(locator.identity_resolvable_since("t1"), Some(probe_at));
        // Idempotent: a later probe keeps the FIRST probe time.
        assert_eq!(
            locator.probe_resolvable("t1", probe_at + 5_000, &|_| false),
            Some(probe_at)
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn probe_excludes_unavailable_sessions_claimed_or_freshagent() {
        let home = unique_temp_dir("probe-excluded");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100));
        // Seeded AFTER arm so it is NOT in the arm-time known_ids snapshot —
        // the ws predicate rejection is what the test isolates.
        insert_session(&db, "ses_foreign", "/proj", 150, None, None);

        // The ws predicate rejects every id (claimed by another terminal or a
        // fresh-agent row): no evidence, no latch.
        assert_eq!(locator.probe_resolvable("t1", 50_000, &|_| true), None);
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn probe_respects_locator_side_candidate_filters() {
        let home = unique_temp_dir("probe-filters");
        let db = open_seed_db(&home);
        insert_session(&db, "ses_pre_arm", "/proj", 50, None, None); // snapshotted at arm
        insert_session(&db, "ses_wrong_cwd", "/other", 60_000, None, None);
        insert_session(&db, "ses_child", "/proj", 60_001, Some("ses_pre_arm"), None);
        insert_session(&db, "ses_archived", "/proj", 60_002, None, Some(60_003));
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 100));
        assert!(locator.note_submit("t1", 120));

        // Every row above is excluded locator-side (known-at-arm snapshot,
        // foreign cwd, subagent parent, archived), so the probe finds nothing.
        assert_eq!(locator.probe_resolvable("t1", 60_004, &|_| false), None);
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn probe_after_empty_enter_finds_nothing_and_reprobe_is_throttled() {
        // Plan-review R2, finding 2: a bare Enter on an empty prompt creates
        // no row. The first probe may read (bounded) and finds nothing; a
        // re-probe inside the throttle interval performs ZERO DB reads, so an
        // empty-Enter pane never degrades into a permanent 2s read loop.
        let home = unique_temp_dir("probe-throttle");
        open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t1", 100)); // bare Enter: window resolves empty
        assert!(locator.tick(100 + OPENCODE_WINDOW_MS + 1).is_empty());

        let scans_after_tick = locator.db_scan_count();
        assert_eq!(locator.probe_resolvable("t1", 50_000, &|_| false), None);
        let scans_after_first_probe = locator.db_scan_count();
        assert!(
            scans_after_first_probe > scans_after_tick,
            "the first probe is allowed exactly one bounded read"
        );
        assert_eq!(locator.probe_resolvable("t1", 51_000, &|_| false), None);
        assert_eq!(
            locator.db_scan_count(),
            scans_after_first_probe,
            "re-probe within the throttle interval performs no DB read"
        );
        assert_eq!(locator.identity_resolvable_since("t1"), None);
        let _ = std::fs::remove_dir_all(&home);
    }
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-sessions opencode_locator::tests:: -- --nocapture`

Expected: FAIL — compile error `no method named identity_resolvable_since` / `no method named probe_resolvable` (NEW-API red; intended failure is the missing latch + accessor + probe, not a setup accident). All pre-existing tests in the module still compile and are unaffected.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-sessions/src/opencode_locator.rs`:

(a) Extend `Inner` (~line 122):

```rust
#[derive(Default)]
struct Inner {
    armed: HashMap<String, Armed>,
    /// First ms an evaluated window ended in an ambiguous or contested
    /// refusal for this terminal — the moment identity became RESOLVABLE
    /// but provably unattributable. Sole-candidate emissions never latch
    /// (a drain-side refusal of one is a FOREIGN session; plan-review R2).
    /// Cleared only by [`OpencodeLocator::disarm`].
    resolvable_evidence_ms: HashMap<String, i64>,
    /// Last `probe_resolvable` read time per terminal (throttle); cleared by
    /// `disarm` alongside the other per-terminal state.
    last_probe_ms: HashMap<String, i64>,
}

/// Per-terminal probe throttle: at most one bounded candidate read this
/// often for an ever-submitted pane whose windows never latched evidence
/// (plan-review R2, finding 2 — an empty-Enter pane must never become a
/// permanent 2s read loop; the invariant sweep runs every 2s).
const PROBE_THROTTLE_MS: i64 = 60_000;
```

(b) In `resolve_windows`, latch evidence in EXACTLY the two refusal branches — never for the sole-candidate emission path. After each of the two `tracing::warn!` calls (the `matches.len() > 1` ambiguous branch and the contested-cwd census branch), immediately before their `continue`:

```rust
            // Candidate-evidence latch: this refusal provably observed a
            // correlatable row it could not attribute. First evidence wins.
            inner
                .resolvable_evidence_ms
                .entry(terminal_id.clone())
                .or_insert(now_ms);
```

(c) `disarm` clears all three maps:

```rust
    pub fn disarm(&self, terminal_id: &str) {
        let mut inner = self.lock();
        inner.armed.remove(terminal_id);
        inner.resolvable_evidence_ms.remove(terminal_id);
        inner.last_probe_ms.remove(terminal_id);
    }
```

(d) New accessor next to `armed_count` (~line 176):

```rust
    /// The first time an evaluated correlation window for this terminal
    /// ended in an ambiguous or contested refusal — a correlatable
    /// cwd-confirmed row existed and could not be attributed — plus any
    /// [`OpencodeLocator::probe_resolvable`] latch: the moment the pane's
    /// identity became RESOLVABLE (danshapiro/freshell#702 gate input).
    /// `None` means nothing resolvable has ever existed for the pane
    /// (opencode writes its `session` row lazily at the first prompt, so
    /// pre-prompt panes are never evidence). Sole-candidate emissions are
    /// deliberately NOT evidence: the healthy bind discharges via the
    /// identity row, and a drain-side refusal of one
    /// (`session_bound_elsewhere` / `freshagent_*`) is a FOREIGN session.
    /// Cleared by [`OpencodeLocator::disarm`] (terminal exit). No I/O.
    pub fn identity_resolvable_since(&self, terminal_id: &str) -> Option<i64> {
        self.lock().resolvable_evidence_ms.get(terminal_id).copied()
    }
```

(e) `first_submit_ms` latch: add `first_submit_ms: Option<i64>` to `Armed` (init `None` in `arm`); in `note_submit`, set it once before/around the existing `enter_ms` update:

```rust
        if armed.first_submit_ms.is_none() {
            armed.first_submit_ms = Some(at_ms);
        }
```

Field doc: the FIRST Enter ever observed for this pane — never cleared while armed; distinguishes "the pane provably has (or soon will have) a session of its own" from "idle pane typed nothing" for [`probe_resolvable`]. (It is NOT the correlation-window driver — `enter_ms` keeps that role, including mid-turn re-open suppression.)

(f) `probe_resolvable` — the plan-review-R1 hole closure. A terminal the window-latch cannot see (row landed after the Enter deadline with no later Enter, or the window's read hit a transient DB error that `query_candidates` swallows to empty) still reaches resolvability detection here. Add near `classify_resume_target`:

```rust
    /// Probe-based resolvability for an ARMED terminal that has ever
    /// submitted but holds no latched evidence: at most ONE bounded
    /// `list_sessions_since(arm_ms − pre_epsilon)` read per
    /// `PROBE_THROTTLE_MS`, with the same candidate filters
    /// `resolve_windows` applies (cwd match, no `parent_id` rows,
    /// no 3-views-marked rows, not in the arm-time `known_ids`,
    /// `time_created >= arm_ms − pre_epsilon`), with NO deadline — plus the
    /// caller's `is_unavailable` predicate (ws-side: session already claimed
    /// by any live-or-retired terminal, or carries a fresh-agent ledger row).
    /// Any survivor means an unbound correlatable row provably exists:
    /// latch + return `Some(now_ms)`. Returns the latched evidence unchanged
    /// when already present; returns `None` with ZERO DB reads when
    /// throttled, not armed, or never submitted (the #702 idle
    /// never-typed class has no session of its own — nothing is
    /// attributable).
    pub fn probe_resolvable(
        &self,
        terminal_id: &str,
        now_ms: i64,
        is_unavailable: &dyn Fn(&str) -> bool,
    ) -> Option<i64> {
        let (armed, latched, throttled) = {
            let inner = self.lock();
            (
                inner.armed.get(terminal_id).cloned(),
                inner.resolvable_evidence_ms.get(terminal_id).copied(),
                inner
                    .last_probe_ms
                    .get(terminal_id)
                    .is_some_and(|t| now_ms - t < PROBE_THROTTLE_MS),
            )
        };
        if latched.is_some() {
            return latched;
        }
        if throttled {
            return None; // throttle before ANY DB read (R2 finding 2)
        }
        let armed = armed?;
        if armed.first_submit_ms.is_none() {
            return None; // never typed: no session of its own exists — no read
        }
        let lower_bound = armed.arm_ms - self.pre_epsilon_ms;
        let any = self
            .query_candidates(lower_bound) // OFF the lock: bounded read
            .into_iter()
            .any(|row| {
                !armed.known_ids.contains(&row.session_id)
                    && row
                        .cwd
                        .as_deref()
                        .is_some_and(|cwd| normalize_cwd(cwd) == armed.cwd_normalized)
                    && row.created_at.is_some_and(|created| created >= lower_bound)
                    && row.has_three_views_marker != Some(1)
                    && !is_unavailable(&row.session_id)
            });
        {
            let mut inner = self.lock();
            if inner.armed.contains_key(terminal_id) {
                inner.last_probe_ms.insert(terminal_id.to_string(), now_ms);
                if any {
                    inner
                        .resolvable_evidence_ms
                        .entry(terminal_id.to_string())
                        .or_insert(now_ms);
                    return Some(now_ms);
                }
                return None;
            }
        }
        None // disarmed mid-probe: the pane is gone — drop, never resurrect
    }
```

Whether the filter's field accesses match `OpencodeSessionRow` one-for-one with `resolve_windows`' match-filter is settled by the Step 5 refactor: extract the shared per-row candidate predicate into a private helper (`fn row_is_candidate(row, lower_bound, deadline: Option<i64>, known_ids, cwd_normalized) -> bool`) used by both `resolve_windows` and `probe_resolvable`; the probe passes `deadline: None`. If extraction proves fussy under the borrow rules, `probe_resolvable` may keep its own copy with a comment noting the deliberate duplication (repo norm: duplication over premature sharing) — the paired tests pin identical behavior either way.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-sessions opencode_locator::tests:: -- --nocapture`

Expected: PASS — all new latch tests plus every pre-existing locator test.

- [ ] **Step 5: Refactor while green**

No structural refactor expected — the latch is one map, three write sites, one read. Verify the `Inner` doc and accessor doc read cleanly together; re-run `cargo test -p freshell-sessions`.

- [ ] **Step 6: Run impacted-test verification**

The only consumers of `OpencodeLocator` internals are `freshell-ws` (`opencode_association.rs`, `opencode_signal.rs` classification path) and the ws test fixtures; the latch adds state but changes no existing behavior (`tick` output, arm/disarm visibility, note_submit are untouched).

Run: `cargo test -p freshell-sessions && cargo test -p freshell-ws`

Expected: PASS for both crates, zero previously-passing test broken.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/opencode_locator.rs
git commit -m "feat(freshell-sessions): opencode locator candidate-evidence latch (identity_resolvable_since) for #702"
```

---

### Task 2: Re-gate the invariant on locator evidence for opencode rows

**Note:** Code blocks below are the pre-amendment design captured at planning time; the as-built interfaces in the Execution-time amendments section and the source tree take precedence.

**Files:**
- Modify: `crates/freshell-ws/src/invariants.rs` (doc header, `IDENTITY_RESOLUTION_GRACE_MS` comment, `spawn_identity_invariant_sweep` :48-63, `warn_unresolved_terminal_identities` :65-102, tests :217-387)

**Interfaces:**
- Consumes: `freshell_sessions::opencode_locator::OpencodeLocator::{identity_resolvable_since, probe_resolvable}` (Task 1); `WsState.opencode_locator` and `WsState.pane_ledger` (already fields; the sweep's `spawn_identity_invariant_sweep(state, interval)` call site in `crates/freshell-server/src/main.rs:1383` needs NO change); `crate::identity::TerminalIdentityRegistry::find_by_session_including_retired` (already used by `opencode_association.rs`); `crate::pane_ledger::PaneLedger::lookup_by_session`.
- Produces: same WARN on `freshell_ws::invariants` target with the same leading token; for opencode rows it now fires only when evidence is stale (window-latched OR probe-latched; or, locator absent, on create-age as today).

- [ ] **Step 1: Write the failing behavioral tests**

In `crates/freshell-ws/src/invariants.rs` `mod tests`:

(a) Update the five existing direct calls of `warn_unresolved_terminal_identities` (test lines :274, :276, :303, :323, :383) to the new 7-argument signature: trailing `None` locator argument and a shared `&crate::pane_ledger::PaneLedger::disabled()` ledger reference (their amplifier/shell rows are unaffected by the gate). Add one small helper-local binding `let ledger = crate::pane_ledger::PaneLedger::disabled();` per test that needs it.

(b) Add a small duplicated seed helper in this module (the repo duplicates rather than shares test scaffolds — see the identical helpers in `opencode_association.rs` tests):

```rust
    fn seed_opencode_db(data_home: &std::path::Path) -> rusqlite::Connection {
        std::fs::create_dir_all(data_home).unwrap();
        let conn = rusqlite::Connection::open(data_home.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                parent_id TEXT,
                slug TEXT NOT NULL,
                directory TEXT NOT NULL,
                title TEXT NOT NULL,
                version TEXT NOT NULL,
                time_created INTEGER NOT NULL,
                time_updated INTEGER NOT NULL,
                time_archived INTEGER
             );",
        )
        .unwrap();
        conn
    }

    fn insert_opencode_session(conn: &rusqlite::Connection, id: &str, cwd: &str, time_created: i64) {
        conn.execute(
            "INSERT INTO project (id, worktree) VALUES (?1, ?2)",
            rusqlite::params![format!("proj-{id}"), cwd],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session
                (id, project_id, parent_id, slug, directory, title, version,
                 time_created, time_updated, time_archived)
             VALUES (?1, ?2, NULL, ?1, ?3, ?1, 'test', ?4, ?4, NULL)",
            rusqlite::params![id, format!("proj-{id}"), cwd, time_created],
        )
        .unwrap();
    }

    /// This module + the next test share a temp-dir discipline identical to
    /// opencode_association.rs's `unique_temp_dir`.
    fn unique_opencode_home(label: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "freshell-invariants-opencode-test-{label}-{}-{n}",
            std::process::id()
        ))
    }
```

(c) The new tests (each constructs its own disabled `PaneLedger` unless stated):

```rust
    #[test]
    fn opencode_pane_idle_beyond_the_create_age_grace_is_not_unresolved() {
        // danshapiro/freshell#702: a fresh opencode pane whose user has not
        // submitted a prompt has NO session row anywhere (opencode creates it
        // lazily at first prompt) -- nothing is resolvable, and the old
        // create-age gate false-fired on 100% of real usage (61s+ to first
        // prompt in the incident timeline). With a live locator holding no
        // candidate evidence, age alone must never warn.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("idle");
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        // The production shape: create+arm, NO submit, spawn window closes empty.
        assert!(locator.arm("t-idle", "opencode", true, None, Some("/proj"), 10_000));
        let _ = locator.tick(10_000 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 500);
        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-idle",
            "opencode",
            TerminalRunStatus::Running,
            10_000,
            None,
        )];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            10_000 + 61_000, // +61s: the incident's first-prompt delay
            Some(&locator),
            &ledger,
        );

        assert!(
            unresolved_warnings(&events.lock().unwrap()).is_empty(),
            "no evidence == nothing resolvable == no alarm (#702)"
        );
        assert!(warned.is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_pane_with_stale_candidate_evidence_still_warns() {
        // The real defect class stays armed: a window SAW correlatable rows
        // but no bind landed (ambiguous locator refusal here; contested
        // refusals latch the same way — R2: sole-candidate emissions and
        // drain-side guard refusals deliberately do NOT, they are foreign
        // sessions) and identity is still absent past the grace.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("stale-evidence");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-ev", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-ev", 100));
        insert_opencode_session(&db, "ses_a", "/proj", 150);
        insert_opencode_session(&db, "ses_b", "/proj", 160); // ambiguous refusal
        let evidence_at = 100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(evidence_at).is_empty());

        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row("t-ev", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            evidence_at + IDENTITY_RESOLUTION_GRACE_MS + 1,
            Some(&locator),
            &ledger,
        );

        let warnings = unresolved_warnings(&events.lock().unwrap());
        assert_eq!(warnings.len(), 1, "resolvable-but-unbound must warn");
        assert_eq!(
            warnings[0].fields.get("terminal_id").map(String::as_str),
            Some("t-ev")
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_pane_with_fresh_candidate_evidence_does_not_warn_yet() {
        // Evidence observed < grace ago: the 150ms locator sweep binds within
        // a tick or two in the healthy path, but the alarm must not outrun
        // the binding lanes.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("fresh-evidence");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-ev", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-ev", 100));
        insert_opencode_session(&db, "ses_a", "/proj", 150);
        insert_opencode_session(&db, "ses_b", "/proj", 160);
        let evidence_at = 100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(evidence_at).is_empty());

        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row("t-ev", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            evidence_at + IDENTITY_RESOLUTION_GRACE_MS, // boundary: not yet overdue
            Some(&locator),
            &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_pane_with_evidence_but_resolved_identity_never_warns() {
        // The issue-702 HAPPY path must stay silent even though evidence was
        // latched: the signal lane (or locator lane) bound the identity, so
        // the identity check discharges the row before the evidence gate
        // matters (the `terminal_already_bound` arbitration case).
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("resolved-after-evidence");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-bound", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-bound", 100));
        insert_opencode_session(&db, "ses_a", "/proj", 150);
        insert_opencode_session(&db, "ses_b", "/proj", 160);
        let evidence_at = 100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(evidence_at).is_empty());

        let identity = TerminalIdentityRegistry::new();
        identity.upsert("t-bound", Some("opencode"), Some("ses_a"), Some("/proj"), 1);
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row("t-bound", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            Some(&locator),
            &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_pane_warns_on_create_age_when_locator_unavailable() {
        // A boot with an unresolvable opencode data home (WsState.
        // opencode_locator == None) keeps the create-age tripwire: the
        // topology itself is broken and must stay loud.
        let (events, _guard) = capture::capture();
        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row("t-noloc", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(&rows, &identity, &mut warned, i64::MAX, None, &ledger);

        let warnings = unresolved_warnings(&events.lock().unwrap());
        assert_eq!(warnings.len(), 1);
    }

    #[test]
    fn opencode_row_with_resume_identity_still_skips_with_locator_present() {
        // The resume_session_id skip rule is unchanged by the new gate.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("resume-skip");
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-resume",
            "opencode",
            TerminalRunStatus::Running,
            0,
            Some("ses_existing"),
        )];

        super::warn_unresolved_terminal_identities(&rows, &identity, &mut warned, i64::MAX, Some(&locator), &ledger);

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_probe_closes_the_late_row_and_db_error_hole() {
        // Plan-review R1 hole: the pane DID submit; its Enter-anchored window
        // closed empty; the row then landed LATE (or the window's read hit a
        // transient DB error that query_candidates swallows to empty) and the
        // TUI signal was lost (the rebind plugin marks `lastEmitted` BEFORE
        // its possibly-throwing write, so a lost signal never retries). The
        // probe must find the row per se: first pass past the create-age
        // grace LATCHES evidence (too fresh to warn); once the evidence ages
        // past the grace the alarm fires.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("late-row-hole");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-late", "opencode", true, None, Some("/proj"), 10_000));
        assert!(locator.note_submit("t-late", 10_100));
        let window_closed = 10_100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(window_closed).is_empty(), "window saw nothing");
        insert_opencode_session(&db, "ses_late", "/proj", window_closed + 500);

        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row("t-late", "opencode", TerminalRunStatus::Running, 10_000, None)];

        let probe_at = 10_000 + 61_000;
        super::warn_unresolved_terminal_identities(
            &rows, &identity, &mut warned, probe_at, Some(&locator), &ledger,
        );
        assert!(
            unresolved_warnings(&events.lock().unwrap()).is_empty(),
            "evidence JUST latched: inside the grace, no warn yet"
        );
        assert_eq!(locator.identity_resolvable_since("t-late"), Some(probe_at));

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            probe_at + IDENTITY_RESOLUTION_GRACE_MS + 1,
            Some(&locator),
            &ledger,
        );
        let warnings = unresolved_warnings(&events.lock().unwrap());
        assert_eq!(warnings.len(), 1, "resolvable-but-unbound must warn (R1 hole)");
        assert_eq!(
            warnings[0].fields.get("terminal_id").map(String::as_str),
            Some("t-late")
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_probe_waits_for_the_create_age_grace_before_reading() {
        // Plan-review R2, finding 2: a pane still inside the create-age
        // grace never triggers the probe's DB read — rows that young are the
        // binding lanes' business; evidence arrives via the window latch.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("young-no-probe");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-young", "opencode", true, None, Some("/proj"), 10_000));
        assert!(locator.note_submit("t-young", 10_100));
        let window_closed = 10_100 + freshell_sessions::opencode_locator::OPENCODE_WINDOW_MS + 1;
        assert!(locator.tick(window_closed).is_empty());
        insert_opencode_session(&db, "ses_late", "/proj", window_closed + 500);
        let scans_before = locator.db_scan_count();

        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row("t-young", "opencode", TerminalRunStatus::Running, 10_000, None)];

        // Exactly AT the create-age boundary: not yet `> grace`, so no probe.
        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            10_000 + IDENTITY_RESOLUTION_GRACE_MS,
            Some(&locator),
            &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        assert_eq!(locator.identity_resolvable_since("t-young"), None);
        assert_eq!(
            locator.db_scan_count(),
            scans_before,
            "inside the create-age grace the sweep must not probe the DB"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_idle_pane_stays_silent_with_a_foreign_row_in_cwd() {
        // Never-submitted pane; somebody ELSE's unclaimed row exists in the
        // same cwd. The probe's never-submitted short-circuit runs BEFORE
        // any read: an idle pane has no session of its own, so nothing may
        // be attributed to it -- no evidence, no alarm, no DB read.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("idle-foreign-row");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-idle", "opencode", true, None, Some("/proj"), 0));
        insert_opencode_session(&db, "ses_foreign", "/proj", 5_000);

        let identity = TerminalIdentityRegistry::new();
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row("t-idle", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(
            &rows, &identity, &mut warned, i64::MAX, Some(&locator), &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        assert_eq!(locator.identity_resolvable_since("t-idle"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_probe_never_latches_a_session_claimed_by_another_terminal() {
        // Two panes share a cwd; the row already belongs to the sibling.
        // The ws-side claim exclusion (identity registry, retired-inclusive)
        // must keep the probe from inventing evidence for this pane.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("claimed-row");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-pending", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-pending", 100));
        insert_opencode_session(&db, "ses_sibling", "/proj", 150);

        let identity = TerminalIdentityRegistry::new();
        identity.upsert("t-sibling", Some("opencode"), Some("ses_sibling"), Some("/proj"), 1);
        let ledger = crate::pane_ledger::PaneLedger::disabled();
        let mut warned = HashSet::new();
        let rows = vec![row("t-pending", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(
            &rows, &identity, &mut warned, i64::MAX, Some(&locator), &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        assert_eq!(locator.identity_resolvable_since("t-pending"), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn opencode_probe_never_latches_a_freshagent_session() {
        // fresh-agent `opencode serve` rows land in the same opencode.db;
        // the kind:fresh-agent ledger row excludes them (mirrors the
        // association guards' `freshagent_ledger_row` refusal).
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("freshagent-row");
        let ledger_home = unique_opencode_home("freshagent-ledger");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-pending", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-pending", 100));
        insert_opencode_session(&db, "ses_freshagent", "/proj", 150);

        std::fs::create_dir_all(&ledger_home).unwrap();
        let ledger = crate::pane_ledger::PaneLedger::new(Some(ledger_home.clone()));
        ledger
            .record_fresh_agent_binding(&crate::pane_ledger::FreshAgentBindingWrite {
                provider: "opencode",
                session_id: "ses_freshagent",
                mode: "freshopencode",
                cwd: Some("/proj"),
                create_request_id: None,
                model: None,
                sandbox: None,
                permission_mode: None,
                effort: None,
                supersedes: None,
                now_ms: 1,
            })
            .expect("seed fresh-agent ledger row");

        let identity = TerminalIdentityRegistry::new();
        let mut warned = HashSet::new();
        let rows = vec![row("t-pending", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(
            &rows, &identity, &mut warned, i64::MAX, Some(&locator), &ledger,
        );

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        assert_eq!(locator.identity_resolvable_since("t-pending"), None);
        let _ = std::fs::remove_dir_all(&home);
        let _ = std::fs::remove_dir_all(&ledger_home);
    }
```

If `PaneLedger::disabled()` or `FreshAgentBindingWrite`'s exact field set has drifted from what these snippets assume, adapt the snippet to the real signatures in `crates/freshell-ws/src/pane_ledger.rs` — the ASSERTIONS (no latch / no warn) are the contract, the fixture plumbing is filler.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws invariants:: -- --nocapture`

Expected: FAIL — compile error on the new sixth parameter (Task 1's `identity_resolvable_since` must already exist; do not start this task before Task 1 is green and committed). NEW-SIGNATURE red: intended failure is the missing gate, not a setup accident.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-ws/src/invariants.rs`:

(a) Replace the `IDENTITY_RESOLUTION_GRACE_MS` doc comment (:33-42, keep the `pub(crate) const` line and value unchanged):

```rust
/// How long a non-shell coding-CLI terminal may run without a resolvable
/// session identity before the invariant alarm fires once. For claude and
/// amplifier identity is launcher-assigned at create time, and the codex
/// locator correlates within its own ~2s window, so for those modes the
/// grace is measured from CREATE. opencode terminal panes are
/// ANSWER-triggered: opencode writes its `session` row lazily at the first
/// prompt, so before that moment nothing is resolvable and any create-age
/// alarm is pure noise (danshapiro/freshell#702 — 12/12 real panes fired the
/// old gate). For opencode rows the grace therefore runs from the locator's
/// first CANDIDATE EVIDENCE (`identity_resolvable_since`), whether it came
/// from an evaluated correlation window or from the alarm-time
/// `probe_resolvable` read for ever-submitted panes (the late-row /
/// swallowed-DB-error hole): the moment an in-cwd correlatable row provably
/// existed yet never bound. When the locator is unavailable at boot,
/// opencode keeps the create-age tripwire so a broken topology still alarms.
/// (Previously derived from the deleted amplifier locator's
/// AMPLIFIER_DIR_APPEAR_WINDOW_MS; the alarm also previously rode the
/// amplifier locator sweep's 150ms ticker and silently never ran when no
/// provider home existed — it now owns its sweep unconditionally.)
```

(b) In `spawn_identity_invariant_sweep`, the pass can now issue ONE bounded SQLite read per rare submitted-but-unbound opencode row (the Task-1 probe). Move the pass into `tokio::task::spawn_blocking` (the `drain_and_associate` precedent at `opencode_association.rs:91`) and add the new forwards. On a `JoinError` (a pass panicked — a bug, not a routine condition), log a named event and continue with a FRESH warned set (bounded re-warn noise beats silently losing the sweep; mirrors the locator tick panic handling):

```rust
pub fn spawn_identity_invariant_sweep(state: crate::WsState, interval: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // Once-per-terminal bound, sweep-task-lifetime scoped.
        let mut identity_warned = std::collections::HashSet::new();
        loop {
            ticker.tick().await;
            let state = state.clone(); // WsState: Clone; Arc-backed fields
            let mut warned = std::mem::take(&mut identity_warned);
            identity_warned = match tokio::task::spawn_blocking(move || {
                warn_unresolved_terminal_identities(
                    &state.registry.identity_probe_rows(),
                    &state.identity,
                    &mut warned,
                    crate::terminal::now_ms(),
                    state.opencode_locator.as_deref(),
                    &state.pane_ledger,
                );
                warned
            })
            .await
            {
                Ok(warned) => warned,
                Err(join_error) => {
                    tracing::warn!(
                        error = %join_error,
                        "identity_invariant_sweep_pass_panicked: skip this cycle; warned-set reset \
                         (terminals may re-warn once)"
                    );
                    std::collections::HashSet::new()
                }
            };
        }
    });
}
```

(c) Re-shape `warn_unresolved_terminal_identities` (:65-102): two new trailing parameters — `opencode_locator: Option<&freshell_sessions::opencode_locator::OpencodeLocator>` and `pane_ledger: &crate::pane_ledger::PaneLedger`; move the identity check ahead of the overdue computation; per-mode overdue definition. The opencode arm consults the latch first and falls back to the Task-1 probe (latch-miss only), with the ws-side claim/fresh-agent predicate. The warn body, fields, and message are untouched except that `age_ms` is computed at warn time from `row.created_at`:

```rust
/// One sweep pass: WARN (once per terminal, tracked in `warned`) for every
/// RUNNING non-shell terminal whose identity is past its provider's overdue
/// window with no resolvable identity in either identity home. Exited
/// terminals are skipped (their identity story is over); shell terminals
/// never carry session identity by design. opencode rows are gated on
/// locator RESOLVABILITY evidence (see the grace-constant doc): window-latch
/// first, probe fallback for the late-row/DB-error hole (plan-review R1);
/// a pane with neither has nothing resolvable and is never alarmed
/// (issue #702). The probe's `is_unavailable` predicate keeps sessions
/// already claimed by any live-or-retired terminal and fresh-agent ledger
/// rows from ever counting as evidence.
pub(crate) fn warn_unresolved_terminal_identities(
    rows: &[IdentityProbeRow],
    identity: &TerminalIdentityRegistry,
    warned: &mut HashSet<String>,
    now_ms: i64,
    opencode_locator: Option<&freshell_sessions::opencode_locator::OpencodeLocator>,
    pane_ledger: &crate::pane_ledger::PaneLedger,
) {
    for row in rows {
        if row.mode == "shell"
            || row.status != TerminalRunStatus::Running
            || row.resume_session_id.is_some()
            || warned.contains(&row.terminal_id)
        {
            continue;
        }
        if identity.session_ref_for(&row.terminal_id).is_some() {
            continue;
        }
        let overdue_ms = match row.mode.as_str() {
            "opencode" => match opencode_locator {
                Some(locator) => {
                    let latched = locator.identity_resolvable_since(&row.terminal_id);
                    let since = match latched {
                        Some(t) => Some(t),
                        // Latch miss: probe only once the pane is past the
                        // create-age grace (R2 finding 2 — young panes are the
                        // binding lanes' business; never probe them).
                        None if now_ms - row.created_at > IDENTITY_RESOLUTION_GRACE_MS => {
                            locator.probe_resolvable(&row.terminal_id, now_ms, &|session_id| {
                                identity
                                    .find_by_session_including_retired("opencode", session_id)
                                    .is_some()
                                    || pane_ledger
                                        .lookup_by_session("opencode", session_id)
                                        .is_some_and(|r| {
                                            r.row.pane_kind.as_deref() == Some("fresh-agent")
                                        })
                            })
                        }
                        None => None,
                    };
                    match since {
                        Some(since_ms) => now_ms - since_ms,
                        None => continue, // nothing resolvable exists for this pane
                    }
                }
                None => now_ms - row.created_at,
            },
            _ => now_ms - row.created_at,
        };
        if overdue_ms <= IDENTITY_RESOLUTION_GRACE_MS {
            continue;
        }
        warned.insert(row.terminal_id.clone());
        tracing::warn!(
            target: "freshell_ws::invariants",
            terminal_id = %row.terminal_id,
            mode = %row.mode,
            age_ms = now_ms - row.created_at,
            "terminal_identity_unresolved: non-shell coding-CLI terminal has no resolvable \
             session identity after the locator window; its panes cannot be matched to a \
             session (sidebar grey / duplicate tabs / no restore identity)"
        );
    }
}
```

(d) Update the module doc header (:1-24): extend the "Resolvable identity" section to reflect the opencode re-gate — for `mode == "opencode"` the alarm additionally requires stale locator resolvability evidence (window latch or the ever-submitted probe; issue #702), since fresh opencode panes provably have no session row before the first prompt.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws invariants:: -- --nocapture`

Expected: PASS — the eleven new opencode tests plus all updated pre-existing tests.

- [ ] **Step 5: Refactor while green**

No structural refactor expected. Confirm the existing non-opencode tests read identically in intent with their new trailing args, and the module doc / constant doc / fn doc tell one consistent story. Re-run `cargo test -p freshell-ws invariants::`.

- [ ] **Step 6: Run impacted-test verification**

Direct callers of the changed function: this module only (verified by grep — no `tests/` usage). Same-crate users of the invariants `capture` helper: `opencode_signal.rs` tests. The sibling opencode lanes must be untouched behaviorally; the arbitration test pair proves it.

Run: `cargo test -p freshell-ws`

Expected: PASS (the whole crate, since the sweep wiring lives here).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/invariants.rs
git commit -m "fix(freshell-ws): gate terminal_identity_unresolved on opencode candidate evidence (#702)"
```

---

### Task 3: E2E regression pin on the never-submitted pane

**Files:**
- Modify: `test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts` (add `readServerLogs` helper ~:60 area; pin block at the end of the never-submitted assertions ~:365-370)

**Interfaces:**
- Consumes: `info.logsDir` from `server.start()` (same field `compound-restart-rust.spec.ts:318,417` reads); `restoredNeverSubmittedTerminalId` already in scope at :362-364; Task 2's server-side behavior.
- Produces: a scoped absence pin proving issue #702 stays fixed end-to-end on the Rust server.

- [ ] **Step 1: Write the failing pin**

(a) Add the log helper (verbatim copy of the pattern from `compound-restart-rust.spec.ts:91-99`) after `selectShellIfPickerShowing`:

```ts
/** Concatenated content of every server log file in the fixture's logs dir. */
async function readServerLogs(logsDir: string): Promise<string> {
  const names = await fs.readdir(logsDir).catch(() => [] as string[])
  let combined = ''
  for (const name of names) {
    combined += await fs.readFile(path.join(logsDir, name), 'utf8').catch(() => '')
  }
  return combined
}
```

(b) At the end of the test body (after the final `expect.poll(... 'opencode> ' ...)` block, currently :365-370), before the closing braces of the inner `try`:

```ts
        // -------------------------------------------------------------
        // Issue #702 pin: the never-submitted pane must not trip
        // `terminal_identity_unresolved`. Identity for an opencode terminal
        // pane is answer-triggered (opencode writes its `session` row lazily
        // at the first prompt), so this pane has NOTHING resolvable to
        // correlate; the old create-age gate warned at +10s regardless —
        // 12/12 panes in one day of production logs. The restored fresh
        // pane's terminal was created no later than the moment the client
        // learned its id above, so a fixed 12s wait from here provably
        // outlasts the invariant's 10s grace plus one 2s sweep — regardless
        // of how long the earlier polls happened to take. Then scope the
        // absence pin to THIS restored terminal id so pre-restart history
        // and the other (submitted) pane cannot pollute it.
        // -------------------------------------------------------------
        await page.waitForTimeout(12_000)
        const serverLogs = await readServerLogs(info.logsDir)
        // Positive control (plan-review R2, finding 3): the log feed must
        // actually be populated and mention this pane — an un-readable or
        // empty log must fail loudly, never pass vacuously green.
        expect(serverLogs).toContain(restoredNeverSubmittedTerminalId!)
        const unresolvedForRestoredPane = serverLogs
          .split('\n')
          .filter((line) => line.includes('terminal_identity_unresolved'))
          .filter((line) => line.includes(restoredNeverSubmittedTerminalId!))
        expect(unresolvedForRestoredPane).toEqual([])
```

(c) Save the pin as a patch and unapply it, returning the tree to committed HEAD — the RED observation in Step 2 needs the tree at base crate behavior. The whole dance uses NO revert command, NO reset, NO checkout — HEAD never moves and no destructive git op is used at any point (repo etiquette forbids destructive git ops): the pin moves with `git apply`, and Step 2's gate restoration uses base-content substitution from named revisions:

```bash
git diff -- test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts > /tmp/702-pin.patch
git apply -R /tmp/702-pin.patch               # pin unapplied: tree clean; HEAD untouched
test -s /tmp/702-pin.patch   # non-empty
```

- [ ] **Step 2: Run the spec and verify the intended failure (RED)**

The fix from Tasks 1-2 is already committed, so observe RED against worktree files with the gate temporarily restored to base content and the pin re-applied. The mechanism that survives ANY later commit touching the same file (focused-round-1 repair: a reverse-applied old-commit patch dies the moment a later commit edits its context lines) is base-content substitution — plain file copies from named revisions, no patch context dependency, no revert/reset/checkout, HEAD never moves:

```bash
git show 5b3851322e0ddc60d6c6c10d9b05a27c490ada2e:crates/freshell-ws/src/invariants.rs > /tmp/702-base-invariants.rs
cp /tmp/702-base-invariants.rs crates/freshell-ws/src/invariants.rs   # base gate behavior in the worktree; HEAD untouched
cargo build --release -p freshell-server    # e2e harness runs the worktree-built binary
git apply /tmp/702-pin.patch                  # pin now sits atop base-behavior server
npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts
```

Expected: FAIL — the pin's final assertion name-checks one or more `terminal_identity_unresolved` log lines carrying the restored never-submitted terminal id (base behavior fires at +10s create-age). A failure for any OTHER reason is spec-authoring drift: fix the pin mechanics before proceeding; do not weaken the assertion's target.

(Only `invariants.rs` needs the substitution: the base version never references the locator's new API, so the current `opencode_locator.rs` sits compatibly dormant. This assumes no later change moved `invariants.rs`'s intra-crate surface — true at authoring; if a future run's build breaks here, re-derive the base substitution the same way.) 

Restore the fixed gate afterwards, IN ORDER (content restore first, then unapply the pin):

```bash
git show HEAD:crates/freshell-ws/src/invariants.rs > crates/freshell-ws/src/invariants.rs
git apply -R /tmp/702-pin.patch
```

- [ ] **Step 3: No production implementation needed**

The pin is test-only; Tasks 1-2 are the production behavior.

- [ ] **Step 4: Run the spec GREEN**

```bash
git apply /tmp/702-pin.patch
cargo build --release -p freshell-server
npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts
```

Expected: PASS — the whole acceptance scenario (restore + fresh restore + pin) is green.

- [ ] **Step 5: Refactor while green**

None expected — the pin is scoped, self-documenting, and reuses the established `readServerLogs` idiom. If the `12_000` deadline is meaningfully overshot by the natural spec runtime (the preceding polls routinely consume >12s), the `waitForTimeout` no-ops; keep it (it makes the deadline explicit rather than incidental).

- [ ] **Step 6: Run impacted-test verification**

The other invariant-pinning specs must stay green (they are codex/amplifier flows whose behavior did not change), plus the sibling opencode spec that exercises the signal lane:

```bash
npm run test:e2e:local -- --project=rust-chromium \
  test/e2e-browser/specs/compound-restart-rust.spec.ts \
  test/e2e-browser/specs/codex-terminal-bounce-rust.spec.ts \
  test/e2e-browser/specs/amplifier-restore-rust.spec.ts \
  test/e2e-browser/specs/opencode-rebind-rust.spec.ts
```

Expected: PASS for all four specs (including their `not.toContain('terminal_identity_unresolved')` pins).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts
git commit -m "test(e2e): pin terminal_identity_unresolved silence for the never-submitted opencode pane (#702)"
```

---

### Task 4: Rust gates and final focused verification

**Files:**
- None (verification-only task)

**Interfaces:**
- Consumes: Tasks 1-3.

- [ ] **Step 1: Rust test gate for both touched crates**

Run: `cargo test -p freshell-sessions && cargo test -p freshell-ws`

Expected: PASS (all tests in both crates, unit + integration).

- [ ] **Step 2: Format gate (CI parity)**

Run: `cargo fmt --all --check`

Expected: exit 0, no diff.

- [ ] **Step 3: Clippy gate for the touched crates (CI parity lane)**

Run: `cargo clippy -p freshell-ws -p freshell-sessions --all-targets -- -D warnings`

Expected: PASS with zero warnings.

- [ ] **Step 4: Confirm no stray diff and commit**

Run: `git status --short`

Expected: clean worktree (all work committed in Tasks 1-3). Nothing to commit.

---

## Run-level verification (owned by the executing stage, not a plan task)

1. Full coordinated suite once on final HEAD: `env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy npm run check` (host proxy-env workaround; pass criterion: green excluding the two pre-existing proxy-pollution suites documented in the baseline ledger — update-flow and visible-first-audit-gate must pass under the clean-env prefix).
2. The four e2e specs above already ran on the local backend in Task 3. The three CLOUD_SKIP_SPECS members among them (`opencode-terminal-restore-rust`, `codex-terminal-bounce-rust`, `amplifier-restore-rust`) are covered ONLY by these local runs; `compound-restart-rust` and `opencode-rebind-rust` also exist in cloud e2e when a cloud e2e run happens, which this run does not perform (no PR).
3. Evidence for the recap: issue timeline re-verified unnecessary; the e2e pin + unit lattice are the durable proof.
