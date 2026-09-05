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

**Architecture:** One re-gate across two crates. `freshell-sessions`' `OpencodeLocator` gains a per-terminal *candidate-evidence latch* (first ms an evaluated correlation window observed ≥1 in-window cwd-confirmed row) exposed as `identity_resolvable_since(terminal_id)`. `freshell-ws`'s `warn_unresolved_terminal_identities` replaces the create-age gate for `mode == "opencode"` rows with an evidence-age gate when a locator is available (no evidence ⇒ nothing resolvable ⇒ no alarm; evidence older than the grace ⇒ alarm), and keeps today's create-age tripwire when the locator is unavailable. Non-opencode modes are byte-identical in behavior. A scoped end-to-end pin lands on the existing never-submitted negative-control pane in `opencode-terminal-restore-rust.spec.ts`.

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
- E2E specs involved here are in `CLOUD_SKIP_SPECS`; run them with `npm run test:e2e:local -- ...` (never cloud). First e2e run pays a one-time `cargo build --release -p freshell-server` inside the harness.
- Commits use the repo's conventional style (see `git log`); never alter git identity config; no PR.
- `docs/plans/` files are historical — never edit an old plan doc. No `AGENTS.md`/`README.md`/`docs/index.html` change is needed (internal observability + test-only change; AGENTS.md does not name this invariant).

---

### Task 1: Locator candidate-evidence latch (`identity_resolvable_since`)

**Files:**
- Modify: `crates/freshell-sessions/src/opencode_locator.rs` (state struct `Inner` ~:122-125, `resolve_windows` ~:367-373, `disarm` ~:240-242, new accessor next to `armed_count` ~:174-176; tests in `mod tests` at end of same file)

**Interfaces:**
- Consumes: nothing new (pure in-memory latch inside the existing `Mutex<Inner>`).
- Produces: `pub fn identity_resolvable_since(&self, terminal_id: &str) -> Option<i64>` — first ms an evaluated window saw ≥1 in-window cwd-confirmed candidate; `None` = nothing resolvable has ever existed for this terminal.

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
    fn located_emission_retains_resolvable_evidence_after_disarm() {
        let home = unique_temp_dir("evidence-emission");
        let db = open_seed_db(&home);
        let locator = OpencodeLocator::new(home.clone());

        assert!(locator.arm("t1", "opencode", true, None, Some("/proj"), 1_000));
        assert!(locator.note_submit("t1", 1_100));
        insert_session(&db, "ses_emitted", "/proj", 1_150, None, None);

        let evidence_at = 1_100 + OPENCODE_WINDOW_MS + 1;
        let located = locator.tick(evidence_at);
        assert_eq!(located.len(), 1);
        assert_eq!(locator.armed_count(), 0, "emission disarms");
        assert_eq!(
            locator.identity_resolvable_since("t1"),
            Some(evidence_at),
            "evidence must survive the emission disarm: a drain-side guard refusal is still evidence"
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
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-sessions opencode_locator::tests:: -- --nocapture`

Expected: FAIL — compile error `no method named identity_resolvable_since` (NEW-API red; intended failure is the missing latch + accessor, not a setup accident). All pre-existing tests in the module still compile and are unaffected.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-sessions/src/opencode_locator.rs`:

(a) Extend `Inner` (~line 122):

```rust
#[derive(Default)]
struct Inner {
    armed: HashMap<String, Armed>,
    /// First ms an evaluated window for this terminal observed >=1 in-window
    /// cwd-confirmed candidate row -- the moment identity became RESOLVABLE.
    /// Survives disarm-on-Located-emission (so a drain-side guard refusal
    /// still counts); cleared only by [`OpencodeLocator::disarm`].
    resolvable_evidence_ms: HashMap<String, i64>,
}
```

(b) In `resolve_windows`, immediately after the `matches` collect (after the `.collect()` ending ~line 367) and BEFORE the `resolved = true` mutation:

```rust
            // Candidate-evidence latch: this window provably contained a
            // correlatable row. Latched for EVERY outcome (ambiguous /
            // contested refusal / emission) so `identity_resolvable_since`
            // keeps answering after a Located disarm-on-emission; first
            // evidence wins.
            if !matches.is_empty() {
                inner
                    .resolvable_evidence_ms
                    .entry(terminal_id.clone())
                    .or_insert(now_ms);
            }
```

(c) `disarm` clears both maps:

```rust
    pub fn disarm(&self, terminal_id: &str) {
        let mut inner = self.lock();
        inner.armed.remove(terminal_id);
        inner.resolvable_evidence_ms.remove(terminal_id);
    }
```

(d) New accessor next to `armed_count` (~line 176):

```rust
    /// The first time an evaluated correlation window for this terminal
    /// observed >=1 in-window cwd-confirmed candidate session row -- the
    /// moment the pane's identity became RESOLVABLE (danshapiro/freshell#702
    /// gate input). `None` means no evaluation ever saw a candidate: the pane
    /// has nothing to correlate (opencode writes its `session` row lazily at
    /// the first prompt, so pre-prompt panes are never evidence). Survives
    /// the Located-emission disarm so a drain-side guard refusal
    /// (`opencode_association_rejected: session_bound_elsewhere` /
    /// `freshagent_*`) still reads as evidence; the signal-owned
    /// (`terminal_already_bound`) case is covered by the identity row itself.
    /// Cleared by [`OpencodeLocator::disarm`] (terminal exit). No I/O.
    pub fn identity_resolvable_since(&self, terminal_id: &str) -> Option<i64> {
        self.lock().resolvable_evidence_ms.get(terminal_id).copied()
    }
```

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

**Files:**
- Modify: `crates/freshell-ws/src/invariants.rs` (doc header, `IDENTITY_RESOLUTION_GRACE_MS` comment, `spawn_identity_invariant_sweep` :48-63, `warn_unresolved_terminal_identities` :65-102, tests :217-386)

**Interfaces:**
- Consumes: `freshell_sessions::opencode_locator::OpencodeLocator::identity_resolvable_since` (Task 1); `WsState.opencode_locator` (already a field; the sweep's `spawn_identity_invariant_sweep(state, interval)` call site in `crates/freshell-server/src/main.rs:1383` needs NO change).
- Produces: same WARN on `freshell_ws::invariants` target with the same leading token; for opencode rows it now fires only when evidence is stale (or, locator absent, on create-age as today).

- [ ] **Step 1: Write the failing behavioral tests**

In `crates/freshell-ws/src/invariants.rs` `mod tests`:

(a) Update the five existing direct calls of `warn_unresolved_terminal_identities` (test lines :274, :276, :303, :323, :383) with a trailing `None` locator argument (their amplifier/shell rows are unaffected by the gate).

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

(c) The new tests:

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
        let _ = locator.tick(10_000 + 2_500);
        let identity = TerminalIdentityRegistry::new();
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
        // but no bind landed (ambiguous locator refusal here; drain-side
        // guard refusals share the latch) and identity is still absent past
        // the grace.
        let (events, _guard) = capture::capture();
        let home = unique_opencode_home("stale-evidence");
        let db = seed_opencode_db(&home);
        let locator = freshell_sessions::opencode_locator::OpencodeLocator::new(home.clone());
        assert!(locator.arm("t-ev", "opencode", true, None, Some("/proj"), 0));
        assert!(locator.note_submit("t-ev", 100));
        insert_opencode_session(&db, "ses_a", "/proj", 150);
        insert_opencode_session(&db, "ses_b", "/proj", 160); // ambiguous refusal
        let evidence_at = 100 + 2_001;
        assert!(locator.tick(evidence_at).is_empty());

        let identity = TerminalIdentityRegistry::new();
        let mut warned = HashSet::new();
        let rows = vec![row("t-ev", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            evidence_at + IDENTITY_RESOLUTION_GRACE_MS + 1,
            Some(&locator),
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
        let evidence_at = 100 + 2_001;
        assert!(locator.tick(evidence_at).is_empty());

        let identity = TerminalIdentityRegistry::new();
        let mut warned = HashSet::new();
        let rows = vec![row("t-ev", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            evidence_at + IDENTITY_RESOLUTION_GRACE_MS, // boundary: not yet overdue
            Some(&locator),
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
        let evidence_at = 100 + 2_001;
        assert!(locator.tick(evidence_at).is_empty());

        let identity = TerminalIdentityRegistry::new();
        identity.upsert("t-bound", Some("opencode"), Some("ses_a"), Some("/proj"), 1);
        let mut warned = HashSet::new();
        let rows = vec![row("t-bound", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(
            &rows,
            &identity,
            &mut warned,
            i64::MAX,
            Some(&locator),
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
        let mut warned = HashSet::new();
        let rows = vec![row("t-noloc", "opencode", TerminalRunStatus::Running, 0, None)];

        super::warn_unresolved_terminal_identities(&rows, &identity, &mut warned, i64::MAX, None);

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
        let mut warned = HashSet::new();
        let rows = vec![row(
            "t-resume",
            "opencode",
            TerminalRunStatus::Running,
            0,
            Some("ses_existing"),
        )];

        super::warn_unresolved_terminal_identities(&rows, &identity, &mut warned, i64::MAX, Some(&locator));

        assert!(unresolved_warnings(&events.lock().unwrap()).is_empty());
        let _ = std::fs::remove_dir_all(&home);
    }
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-ws invariants:: -- --nocapture`

Expected: FAIL — compile error on the new sixth parameter (and `identity_resolvable_since` would be absent if Task 1 were skipped; it must not be). NEW-SIGNATURE red: intended failure is the missing gate, not a setup accident. Note: `opencode_pane_warns_on_create_age_when_locator_unavailable` would also fail behaviorally today if expressed against the old signature — keep it in this batch anyway.

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
/// first CANDIDATE EVIDENCE (`identity_resolvable_since`): the moment an
/// in-window cwd-confirmed row provably existed yet never bound. When the
/// locator is unavailable at boot, opencode keeps the create-age tripwire so
/// a broken topology still alarms.
/// (Previously derived from the deleted amplifier locator's
/// AMPLIFIER_DIR_APPEAR_WINDOW_MS; the alarm also previously rode the
/// amplifier locator sweep's 150ms ticker and silently never ran when no
/// provider home existed — it now owns its sweep unconditionally.)
```

(b) In `spawn_identity_invariant_sweep`, pass the locator through:

```rust
            warn_unresolved_terminal_identities(
                &state.registry.identity_probe_rows(),
                &state.identity,
                &mut identity_warned,
                crate::terminal::now_ms(),
                state.opencode_locator.as_deref(),
            );
```

(c) Re-shape `warn_unresolved_terminal_identities` (:65-102): new sixth parameter `opencode_locator: Option<&freshell_sessions::opencode_locator::OpencodeLocator>`; move the identity check ahead of the overdue computation; per-mode overdue definition. The warn body, fields, and message are untouched except that `age_ms` is computed at warn time from `row.created_at`:

```rust
/// One sweep pass: WARN (once per terminal, tracked in `warned`) for every
/// RUNNING non-shell terminal whose identity is past its provider's overdue
/// window with no resolvable identity in either identity home. Exited
/// terminals are skipped (their identity story is over); shell terminals
/// never carry session identity by design. opencode rows are gated on
/// locator candidate evidence (see the grace-constant doc): a pane with no
/// evidence has nothing resolvable and is never alarmed (issue #702).
pub(crate) fn warn_unresolved_terminal_identities(
    rows: &[IdentityProbeRow],
    identity: &TerminalIdentityRegistry,
    warned: &mut HashSet<String>,
    now_ms: i64,
    opencode_locator: Option<&freshell_sessions::opencode_locator::OpencodeLocator>,
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
                Some(locator) => match locator.identity_resolvable_since(&row.terminal_id) {
                    Some(since_ms) => now_ms - since_ms,
                    None => continue, // nothing resolvable has ever existed for this pane
                },
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

(d) Update the module doc header (:1-24): extend the "Resolvable identity" bullet list with one sentence noting that for `mode == "opencode"` the alarm additionally requires stale locator candidate evidence (issue #702), since fresh opencode panes provably have no session row before the first prompt.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-ws invariants:: -- --nocapture`

Expected: PASS — the six new opencode tests plus all updated pre-existing tests.

- [ ] **Step 5: Refactor while green**

No structural refactor expected. Confirm the four existing non-opencode tests read identically in intent with their new trailing `None`, and the module doc / constant doc / fn doc tell one consistent story. Re-run `cargo test -p freshell-ws invariants::`.

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
- Modify: `test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts` (add `readServerLogs` helper ~:60 area; timestamp anchor after the post-restart ready-poll ~:295-298; pin block at the end of the never-submitted assertions ~:365-370)

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

(b) Anchor the restore-ready timestamp. Immediately after the post-restart ready gate (the `await expect(async () => { ... getWsReadyState ... }).toPass({ timeout: 30_000 })` block, currently :295-298), add:

```ts
        // Wall-clock anchor for the issue-702 pin below: the restored fresh
        // pane's terminal is respawned by the reconnect this gate observes,
        // so the identity invariant's 10s grace for it expires ~10s from now.
        const restoreReadyAt = Date.now()
```

(c) At the end of the test body (after the final `expect.poll(... 'opencode> ' ...)` block, currently :365-370), before the closing braces of the inner `try`:

```ts
        // -------------------------------------------------------------
        // Issue #702 pin: the never-submitted pane must not trip
        // `terminal_identity_unresolved`. Identity for an opencode terminal
        // pane is answer-triggered (opencode writes its `session` row lazily
        // at the first prompt), so this pane has NOTHING resolvable to
        // correlate; the old create-age gate warned at +10s regardless —
        // 12/12 panes in one day of production logs. The restored fresh pane
        // was respawned at `restoreReadyAt`; wait out the invariant's 10s
        // grace plus sweep margin, then scope the absence pin to THIS
        // restored terminal id so pre-restart history and the other
        // (submitted) pane cannot pollute it.
        // -------------------------------------------------------------
        const invariantDeadlineAt = restoreReadyAt + 12_000
        const remainingMs = invariantDeadlineAt - Date.now()
        if (remainingMs > 0) await page.waitForTimeout(remainingMs)
        const serverLogs = await readServerLogs(info.logsDir)
        const unresolvedForRestoredPane = serverLogs
          .split('\n')
          .filter((line) => line.includes('terminal_identity_unresolved'))
          .filter((line) => line.includes(restoredNeverSubmittedTerminalId!))
        expect(unresolvedForRestoredPane).toEqual([])
```

- [ ] **Step 2: Run the spec and verify the intended failure (RED)**

The fix from Tasks 1-2 is already committed, so observe RED by temporarily reverting the crate changes in-place, running the spec, then restoring. Commands:

```bash
git revert --no-commit HEAD~1 HEAD          # reverses Task 2 then Task 1, worktree-only
cargo build --release -p freshell-server    # e2e harness needs the reversed build
npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts
```

Expected: FAIL — the pin's final assertion finds a `terminal_identity_unresolved` line carrying the restored never-submitted terminal id (base behavior fires at +10s create-age). If the spec fails for any OTHER reason first (fixture drift), fix the spec edit, not the assertion's target.

Then restore:

```bash
git reset --hard HEAD                       # restores the committed Tasks 1-2 (untracked node_modules/target untouched)
```

- [ ] **Step 3: No production implementation needed**

The pin is test-only; Tasks 1-2 are the production behavior.

- [ ] **Step 4: Run the spec GREEN**

```bash
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
2. The four e2e specs above already ran on the local backend in Task 3; they are in CLOUD_SKIP_SPECS, so local runs ARE the required coverage.
3. Evidence for the recap: issue timeline re-verified unnecessary; the e2e pin + unit lattice are the durable proof.
