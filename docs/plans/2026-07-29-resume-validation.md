# Resume Validation Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Before the Rust server constructs a coding-CLI resume command from a cached session id, validate that the session actually exists in the provider's on-disk store; when it is definitively absent, spawn the CLI fresh in the same cwd/mode, surface an operator-visible notice naming the stale id, and retire the stale ledger binding so it is not retried forever.

**Architecture:** A pure resume-gate policy function lives in `freshell-platform` (below both consumers). The existing tri-state disk-existence probe (`SessionExistenceProbe` / `IndexExistenceProbe`) gains by-id fallbacks for amplifier and codex so "Absent" is a trustworthy POSITIVE absence, then the gate is wired into the three spawn doors that call `resolve_coding_cli_command()`: WS `terminal.create` (restore path), headless auto-resume respawn, and the freshagent REST create pipeline. Validation only ever converts a resume into a fresh spawn on positive absence; `Unknown`/`ProviderUnavailable` always fail open (today's behavior preserved).

**Tech Stack:** Rust (axum/tokio workspace under `crates/`), serde-based WS protocol in `crates/freshell-protocol`, React/TypeScript client in `src/`, Vitest for client tests, `cargo test` for Rust.

## Global Constraints

- Work only inside the worktree `/home/dan/code/freshell/.worktrees/resume-validation` on branch `feat/resume-validation` (branched from `origin/main` at `ca1a60d3`).
- Do NOT open a PR, do NOT merge, do NOT restart or deploy any server. The live Rust server on port 3002 must not be touched.
- Red-Green-Refactor TDD for every task (root `AGENTS.md`): write the failing test first, watch it fail, make it pass, refactor. Never skip the refactor.
- Structural limits (`port/AGENTS.md`): ≤1K lines per file. New logic goes in new focused files, not appended to already-huge ones.
- Fail-open invariant (the spec's rule 3): validation must NEVER turn a working resume into a non-resume. Only a POSITIVE "store is readable and the session is definitively absent" may block a resume. `Unknown` and `ProviderUnavailable` always proceed unchanged.
- Providers validated: `claude`, `codex`, `opencode`, `amplifier` (the four the existence probe knows). `gemini`, `kimi`, and any unknown provider are never blocked (they are outside the probe's `KNOWN_PROVIDERS`, whose contract maps unknown providers to `Absent` — the gate must therefore check its own provider list BEFORE consulting the probe).
- Node server (`server/`) is deliberately NOT changed: root `AGENTS.md` states the live production server is the Rust server on port 3002 and the Node server is legacy; the validation substrate (the tri-state `IndexExistenceProbe`, opencode by-id sqlite check, claude `CLAUDE_CONFIG_DIR`-aware locator) exists only in Rust, so the port is not cheap or parallel. This is an explicit scope decision, not an oversight.
- Rust tests: plain `cargo test -p <crate>` (no coordinator gate for Rust). Client tests: `npm run test:unit` (coordinator-gated; wait for the gate, never kill a foreign holder). Raw `npx vitest` is not a coordinated workflow.
- Known pre-existing failure on main, unrelated: `terminal-font-settings.test.tsx` — note it if it appears in suite runs, do not chase it.
- `port/AGENTS.md` mandates a `port/oracle/DEVIATIONS.md` entry for deliberate behavior changes vs the Node original — this feature is one (Task 9).
- Protocol change is limited to ONE additive optional field (`notice` on `terminal.created`), mirrored in `crates/freshell-protocol` and the port contract schemas per repo convention. No new message types (the `SERVER_MESSAGE_TYPES` inventory is frozen).
- Amplifier existence is checked across ALL project slugs (`~/.amplifier/projects/*/sessions/<id>/`), not just the cwd-derived slug — a session may live under a different project slug than the current cwd if the tab moved. The index source already walks all projects; the new by-id fallback scans all project dirs too.

## Design Notes (read before Task 1)

**The incident:** after a Rust-server restart, freshell restored an Amplifier pane by resuming stored session id `8dab420a-f76b-407c-bcbe-dfb2a971c2e1`, which had no directory anywhere under `~/.amplifier/projects/*/sessions/`. The amplifier CLI silently created a brand-new empty session under that id. Root cause on the freshell side: the reconcile-time existence probe deliberately treats amplifier `Absent` as not-dead (`crates/freshell-ws/src/reconcile.rs:330-352`, because `ensure_session` re-stubs), and the spawn doors never consult the probe at all — the `restore:true` create re-trusts the client claim unvalidated.

**Key existing pieces (do not rebuild):**
- `crates/freshell-ws/src/existence.rs` — `SessionExistenceProbe` trait: `exists(provider, session_id) -> SessionExistence {Present|Absent|Unknown|ProviderUnavailable}`, plus `ever_observed(...)` and `ever_observed_on_disk(...)`. Reachable in WS handlers as `state.session_existence` (see `terminal.rs:3399`).
- `crates/freshell-server/src/existence.rs` — `IndexExistenceProbe` (production impl over `SessionIndex`), with by-id fallbacks today for claude (raw transcript file) and opencode (sqlite `session_exists_by_id`); constructed in `crates/freshell-server/src/main.rs` (probe construction region, see `existence.rs:112-141, 170-178`).
- `crates/freshell-platform/src/cli_launch.rs:400` — `resolve_coding_cli_command()`, the single pure argv resolver. It must stay pure; validation happens at its callers by feeding it `resume_session_id: None` (or a fresh id).
- The three spawn doors: `handle_create` (`crates/freshell-ws/src/terminal.rs:1412`, resolver call `:2089`), `respawn_agent_terminal` (`terminal.rs:2678`, resolver `:2789`), and the freshagent REST create pipeline (`crates/freshell-freshagent/src/terminal_tabs.rs:1355`).
- `crates/freshell-ws/src/pane_ledger.rs` — durable `BindingRow` per `(provider, sessionId)` with `RowState {Bound|Retired}` and `RetiredReason {Superseded|Closed|GcExpired}`; `retire_closed` at `:563` is the pattern to mirror.
- Client notice surfaces: `paneContent.reconcileNotice` is rendered as a chip (`src/.../FreshAgentView.tsx:2413`) and written into xterm (`src/.../TerminalView.tsx:4336`/`:5053`); the REST create path can inject `"reconcileNotice"` directly into `pane_content` (`terminal_tabs.rs:1657`). `terminal.status.reason` is NEVER displayed by the client — do not build the notice on it.

**Fresh-spawn fallback shape (mirrors how a genuinely fresh pane of each mode spawns today, per `terminal.rs:1617-1717`):**
- `claude` → mint a new UUID, `LaunchIntent::Start` (`--session-id <new>`), `claude_fresh_prealloc = true`.
- `amplifier` → mint a new UUID, keep `LaunchIntent::Resume` (fresh amplifier panes run `amplifier resume <new-uuid>` against a dir stubbed by `ensure_session` — identical to `should_preallocate_fresh_amplifier`).
- `codex` / `opencode` → `resume_session_id = None` (fresh panes of these modes don't preallocate).

**Carve-outs the gate must honor (fail-open bias):**
- claude zero-turn: a claude session created by freshell that never conversed has no `.jsonl` on disk yet. `Absent` + `!ever_observed_on_disk` → Proceed (mirrors `reconcile.rs:365-403`). This is deliberately MORE fail-open than reconcile (no ledger-bound requirement).
- Preallocated fresh ids (claude Start prealloc, amplifier fresh prealloc) are intentionally not on disk — the gate only runs on ids that came from the wire (sessionRef / legacy resumeSessionId / claude restore ladder), never on ids the server just minted.
- gemini/kimi: no `resumeArgs` at all and outside `KNOWN_PROVIDERS` — gate never consults the probe for them.

**Notice visibility per door:**
- Door 1 (WS create): new optional `notice` field on the `terminal.created` success frame; small client change renders it into the pane's xterm exactly like the reconcile notice.
- Door 2 (headless respawn): no `out` sink exists; broadcast the existing `terminal.status{Recovering, reason}` frame (precedent `auto_resume.rs:604-628`) + `tracing::warn!`. Reason prose is not client-rendered today; this is the best available channel on a headless crash-recovery path where `Absent` is near-impossible (the session was alive moments ago). Documented, deliberate.
- Door 3 (REST create): inject `reconcileNotice` into the returned `pane_content` (existing field, existing client rendering — no client change needed).

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-platform/src/resume_gate.rs` | Create | Pure gate policy: provider list, `ResumeExistence`, `evaluate_resume_gate`, shared probe-fn types for freshagent injection |
| `crates/freshell-platform/src/lib.rs` | Modify | `pub mod resume_gate;` |
| `crates/freshell-sessions/src/amplifier_stub.rs` | Modify | Read-only `session_on_disk()` existence scan across all project slugs |
| `crates/freshell-server/src/existence.rs` | Modify | Amplifier + codex by-id fallbacks on `IndexExistenceProbe` |
| `crates/freshell-server/src/main.rs` | Modify | Wire new locators into the probe; wire probe + retire callback into `FreshAgentState` |
| `crates/freshell-ws/src/pane_ledger.rs` | Modify | `RetiredReason::SessionMissing` + `retire_missing()` |
| `crates/freshell-ws/src/pane_ledger_tests.rs` | Modify | Tests for `retire_missing` |
| `crates/freshell-protocol/src/server_messages.rs` | Modify | Optional `notice` on `TerminalCreated` |
| `src/components/TerminalView.tsx` | Modify | Render `terminal.created` notice into xterm (locate the create-success handler near the `[Restore failed]` handling at `:4691`) |
| `crates/freshell-ws/src/resume_validation.rs` | Create | Wire-resume validation helper shared by doors 1 & 2 (probe → gate → fallback outcome) |
| `crates/freshell-ws/src/terminal.rs` | Modify | Doors 1 & 2 call the helper; retire + notice emission |
| `crates/freshell-ws/tests/resume_validation_gate.rs` | Create | Integration coverage for door 1 (and door 2 if the harness reaches it) |
| `crates/freshell-freshagent/src/lib.rs` | Modify | `FreshAgentState`: `with_resume_probe`, `with_on_stale_resume` builders |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | Modify | Door 3 gate + `reconcileNotice` injection |
| `port/oracle/DEVIATIONS.md` | Modify | Deviation ledger entry |

---

### Task 1: Pure resume-gate policy in `freshell-platform`

**Files:**
- Create: `crates/freshell-platform/src/resume_gate.rs`
- Modify: `crates/freshell-platform/src/lib.rs` (add `pub mod resume_gate;` alongside the existing ~10 `pub mod`s)
- Test: inline `#[cfg(test)]` in `crates/freshell-platform/src/resume_gate.rs`

**Interfaces:**
- Consumes: nothing (leaf module, pure).
- Produces (used by Tasks 6–8):
  - `pub const VALIDATED_PROVIDERS: [&str; 4]`
  - `pub fn provider_validated(provider: &str) -> bool`
  - `pub enum ResumeExistence { Present, Absent, Unknown }`
  - `pub enum ResumeGateDecision { Proceed, SpawnFresh }`
  - `pub fn evaluate_resume_gate(provider: &str, existence: ResumeExistence, ever_observed_on_disk: bool) -> ResumeGateDecision`
  - `pub struct ResumeProbeAnswer { pub existence: ResumeExistence, pub ever_observed_on_disk: bool }`
  - `pub type ResumeProbeFn = std::sync::Arc<dyn Fn(&str, &str) -> ResumeProbeAnswer + Send + Sync>`
  - `pub fn stale_resume_notice(provider: &str, stale_id: &str) -> String`

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-platform/src/resume_gate.rs` with ONLY the test module first (referencing the not-yet-written items), or write tests + a `todo!()`-free skeleton — the repo convention is inline tests, so create the file with the tests below and empty stubs that don't compile yet is NOT allowed; instead write the tests and run them against a minimal non-implementing body (e.g. `evaluate_resume_gate` returning `Proceed` unconditionally) so the Absent cases FAIL:

```rust
//! Pre-spawn resume validation policy (resume-validation feature).
//!
//! Pure decision logic: given a provider and a disk-existence answer, decide
//! whether a cached resume id may be passed to the CLI or the pane must spawn
//! fresh. IO-free by design (mirrors `cli_launch`'s purity rule); callers map
//! their probe answers into [`ResumeExistence`].
//!
//! FAIL-OPEN INVARIANT: only a POSITIVE "store readable, session definitively
//! absent" returns [`ResumeGateDecision::SpawnFresh`]. Unknown/unreadable
//! stores, unvalidated providers (gemini, kimi, third-party), and the claude
//! zero-turn carve-out all Proceed (today's behavior).

use std::sync::Arc;

/// Providers whose on-disk store the existence probe knows how to read.
/// MUST stay a subset of `freshell-server`'s `KNOWN_PROVIDERS`: the probe's
/// contract maps unknown providers to `Absent`, so callers must check this
/// list BEFORE consulting the probe.
pub const VALIDATED_PROVIDERS: [&str; 4] = ["claude", "codex", "opencode", "amplifier"];

pub fn provider_validated(provider: &str) -> bool {
    VALIDATED_PROVIDERS.contains(&provider)
}

/// Caller-mapped existence answer. `ProviderUnavailable` maps to `Unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeExistence {
    Present,
    Absent,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeGateDecision {
    /// Pass the resume id through unchanged (validated present, or fail-open).
    Proceed,
    /// Definitively absent: drop the resume, spawn fresh, notify, retire.
    SpawnFresh,
}

pub fn evaluate_resume_gate(
    provider: &str,
    existence: ResumeExistence,
    ever_observed_on_disk: bool,
) -> ResumeGateDecision {
    if !provider_validated(provider) {
        return ResumeGateDecision::Proceed;
    }
    match existence {
        ResumeExistence::Present | ResumeExistence::Unknown => ResumeGateDecision::Proceed,
        ResumeExistence::Absent => {
            // Zero-turn carve-out: a freshell-minted claude session that never
            // conversed has no transcript on disk yet (mirrors
            // freshell-ws/reconcile.rs claude carve-out, deliberately more
            // fail-open: no ledger-bound requirement).
            if provider == "claude" && !ever_observed_on_disk {
                ResumeGateDecision::Proceed
            } else {
                ResumeGateDecision::SpawnFresh
            }
        }
    }
}

/// The operator-visible notice line. MUST name the stale id (spec requirement).
pub fn stale_resume_notice(provider: &str, stale_id: &str) -> String {
    format!(
        "Saved {provider} session {stale_id} could not be found on disk — started a fresh session instead."
    )
}

/// Injection shape for crates that cannot depend on `freshell-ws`'s probe
/// trait (freshell-freshagent): one call answering both existence and
/// disk-history for `(provider, session_id)`.
pub struct ResumeProbeAnswer {
    pub existence: ResumeExistence,
    pub ever_observed_on_disk: bool,
}

pub type ResumeProbeFn = Arc<dyn Fn(&str, &str) -> ResumeProbeAnswer + Send + Sync>;

#[cfg(test)]
mod tests {
    use super::*;
    use ResumeExistence::*;
    use ResumeGateDecision::*;

    #[test]
    fn amplifier_absent_spawns_fresh() {
        // THE incident case: stale amplifier id with no session dir anywhere.
        assert_eq!(evaluate_resume_gate("amplifier", Absent, false), SpawnFresh);
        assert_eq!(evaluate_resume_gate("amplifier", Absent, true), SpawnFresh);
    }

    #[test]
    fn codex_and_opencode_absent_spawn_fresh() {
        assert_eq!(evaluate_resume_gate("codex", Absent, true), SpawnFresh);
        assert_eq!(evaluate_resume_gate("opencode", Absent, true), SpawnFresh);
        assert_eq!(evaluate_resume_gate("codex", Absent, false), SpawnFresh);
        assert_eq!(evaluate_resume_gate("opencode", Absent, false), SpawnFresh);
    }

    #[test]
    fn claude_zero_turn_carve_out_proceeds() {
        // Never observed on disk => could be a legit zero-turn session. Fail open.
        assert_eq!(evaluate_resume_gate("claude", Absent, false), Proceed);
    }

    #[test]
    fn claude_absent_but_previously_on_disk_spawns_fresh() {
        // Transcript existed once and is gone now: positive absence.
        assert_eq!(evaluate_resume_gate("claude", Absent, true), SpawnFresh);
    }

    #[test]
    fn present_and_unknown_always_proceed() {
        for p in VALIDATED_PROVIDERS {
            assert_eq!(evaluate_resume_gate(p, Present, false), Proceed);
            assert_eq!(evaluate_resume_gate(p, Unknown, false), Proceed);
            assert_eq!(evaluate_resume_gate(p, Present, true), Proceed);
            assert_eq!(evaluate_resume_gate(p, Unknown, true), Proceed);
        }
    }

    #[test]
    fn unvalidated_providers_never_blocked() {
        // gemini/kimi have no resumeArgs and are outside KNOWN_PROVIDERS;
        // the probe would answer Absent for them — the gate must not care.
        for p in ["gemini", "kimi", "some-third-party-ext", "shell"] {
            assert_eq!(evaluate_resume_gate(p, Absent, false), Proceed);
            assert!(!provider_validated(p));
        }
    }

    #[test]
    fn notice_names_the_stale_id() {
        let n = stale_resume_notice("amplifier", "8dab420a-f76b-407c-bcbe-dfb2a971c2e1");
        assert!(n.contains("amplifier"));
        assert!(n.contains("8dab420a-f76b-407c-bcbe-dfb2a971c2e1"));
        assert!(n.contains("could not be found"));
        assert!(n.contains("fresh session"));
    }
}
```

For the RED phase, temporarily make `evaluate_resume_gate` return `ResumeGateDecision::Proceed` unconditionally and `stale_resume_notice` return `String::new()`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-platform resume_gate -- --nocapture`
Expected: FAIL — `amplifier_absent_spawns_fresh`, `codex_and_opencode_absent_spawn_fresh`, `claude_absent_but_previously_on_disk_spawns_fresh`, `notice_names_the_stale_id` fail; the fail-open tests pass.

- [ ] **Step 3: Implement the real bodies**

Replace the stub bodies with the full implementations shown in Step 1 (the `match` in `evaluate_resume_gate` and the `format!` in `stale_resume_notice`). Add `pub mod resume_gate;` to `crates/freshell-platform/src/lib.rs`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-platform resume_gate`
Expected: PASS (all 7 tests). Also run `cargo clippy -p freshell-platform -- -D warnings` and `cargo fmt` — clean.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-platform/src/resume_gate.rs crates/freshell-platform/src/lib.rs
git commit -m "feat(resume-validation): pure resume-gate policy in freshell-platform"
```

---

### Task 2: Read-only amplifier session existence scan in `freshell-sessions`

**Files:**
- Modify: `crates/freshell-sessions/src/amplifier_stub.rs` (the existence scan already exists inside `ensure_session` at `:134-148` — extract a read-only variant beside it)
- Test: inline `#[cfg(test)]` in the same file (this crate has NO `tempfile` dep — use the hand-rolled unique-temp-dir style from `crates/freshell-sessions/src/opencode_locator.rs:393-401`)

**Interfaces:**
- Consumes: `resolve_amplifier_home()` (existing, same file) — `$FRESHELL_AMPLIFIER_HOME` override, else `$HOME/.amplifier`.
- Produces (used by Task 3):
  - `pub enum AmplifierSessionAnswer { Present, Absent, Unreadable }`
  - `pub fn session_on_disk(amplifier_home: &std::path::Path, session_id: &str) -> AmplifierSessionAnswer`

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod` in `amplifier_stub.rs` (create a helper mirroring the crate's existing unique-temp-dir pattern):

```rust
    use std::sync::atomic::{AtomicU64, Ordering as TestOrdering};

    static SCAN_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn scan_temp_home(label: &str) -> std::path::PathBuf {
        let n = SCAN_COUNTER.fetch_add(1, TestOrdering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-amplifier-scan-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn session_on_disk_present_under_cwd_slug() {
        let home = scan_temp_home("present");
        let sess = home.join("projects/-home-dan-proj/sessions/sid-1");
        std::fs::create_dir_all(&sess).unwrap();
        assert!(matches!(
            session_on_disk(&home, "sid-1"),
            AmplifierSessionAnswer::Present
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_on_disk_present_under_divergent_slug() {
        // The tab may have moved cwd; the session lives under ANOTHER project
        // slug. Scanning all project dirs must still find it (plan decision:
        // search all projects, documented in Global Constraints).
        let home = scan_temp_home("divergent");
        std::fs::create_dir_all(home.join("projects/-some-other-project/sessions/sid-2")).unwrap();
        std::fs::create_dir_all(home.join("projects/-home-dan-proj")).unwrap();
        assert!(matches!(
            session_on_disk(&home, "sid-2"),
            AmplifierSessionAnswer::Present
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_on_disk_absent_when_store_readable() {
        let home = scan_temp_home("absent");
        std::fs::create_dir_all(home.join("projects/-home-dan-proj/sessions/other-sid")).unwrap();
        assert!(matches!(
            session_on_disk(&home, "sid-3"),
            AmplifierSessionAnswer::Absent
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_on_disk_absent_when_projects_dir_missing() {
        // Store root exists but amplifier has never created projects/:
        // readable-and-empty => definitively absent.
        let home = scan_temp_home("noprojects");
        assert!(matches!(
            session_on_disk(&home, "sid-4"),
            AmplifierSessionAnswer::Absent
        ));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[cfg(unix)]
    #[test]
    fn session_on_disk_unreadable_projects_dir_fails_open() {
        use std::os::unix::fs::PermissionsExt;
        let home = scan_temp_home("unreadable");
        let projects = home.join("projects");
        std::fs::create_dir_all(&projects).unwrap();
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o000)).unwrap();
        let answer = session_on_disk(&home, "sid-5");
        // Restore perms before asserting so cleanup works even on failure.
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(matches!(answer, AmplifierSessionAnswer::Unreadable));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn session_on_disk_matches_a_file_only_as_absent() {
        // A stray FILE named like the session id is not a session dir.
        let home = scan_temp_home("file-not-dir");
        let sessions = home.join("projects/-p/sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("sid-6"), b"junk").unwrap();
        assert!(matches!(
            session_on_disk(&home, "sid-6"),
            AmplifierSessionAnswer::Absent
        ));
        let _ = std::fs::remove_dir_all(&home);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-sessions session_on_disk`
Expected: FAIL to compile — `session_on_disk` / `AmplifierSessionAnswer` not defined.

- [ ] **Step 3: Write the implementation**

Add beside `ensure_session` in `amplifier_stub.rs`:

```rust
/// Read-only disk-existence answer for one amplifier session id, scanning ALL
/// project slugs under `<amplifier_home>/projects/` (a session may live under
/// a different slug than the current cwd — see `ensure_session`'s divergent-
/// slug handling). Never creates anything.
///
/// Semantics (resume-validation feature):
/// * session dir found under any project => `Present`;
/// * `projects/` missing or scanned without a hit => `Absent`
///   (store readable, definitively absent);
/// * `projects/` unreadable (permissions, IO error) => `Unreadable`
///   (callers must fail OPEN — treat as unknown, never as absent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmplifierSessionAnswer {
    Present,
    Absent,
    Unreadable,
}

pub fn session_on_disk(
    amplifier_home: &std::path::Path,
    session_id: &str,
) -> AmplifierSessionAnswer {
    let projects = amplifier_home.join("projects");
    let entries = match std::fs::read_dir(&projects) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return AmplifierSessionAnswer::Absent;
        }
        Err(_) => return AmplifierSessionAnswer::Unreadable,
    };
    for entry in entries.flatten() {
        if entry.path().join("sessions").join(session_id).is_dir() {
            return AmplifierSessionAnswer::Present;
        }
    }
    AmplifierSessionAnswer::Absent
}
```

Refactor step: `ensure_session`'s internal scan loop (`:134-148`) and this function walk the same layout — if a shared private helper falls out naturally (e.g. `fn find_session_dir(projects: &Path, session_id: &str) -> Option<(String, PathBuf)>`), extract it; if the two loops need different data (ensure_session needs the found slug), leaving them separate is acceptable. Do not change `ensure_session` behavior.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-sessions session_on_disk`
Expected: PASS (6 tests; 5 on non-unix). Then `cargo test -p freshell-sessions` — full crate still green.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/amplifier_stub.rs
git commit -m "feat(resume-validation): read-only amplifier session_on_disk scan"
```

---

### Task 3: Amplifier + codex by-id fallbacks on `IndexExistenceProbe`

Why: the probe's warm snapshot can be STALE — a session created moments before a restart may be missing from the snapshot. The claude arm already has a raw-file fallback for exactly this; without equivalents, the gate could misjudge a brand-new amplifier/codex session as `Absent` and wrongly block a working resume (violating the fail-open invariant). After this task, `Absent` for all four validated providers means POSITIVE absence.

**Files:**
- Modify: `crates/freshell-server/src/existence.rs`
- Modify: `crates/freshell-server/src/main.rs` (probe construction site — where `IndexExistenceProbe::new(index, Some(pane_ledger), provider_roots)` is built and `.with_claude_transcript_locator(...)` / `.with_opencode_session_locator(opencode_db_locator(...))` are chained; codex sessions root resolution mirrors the `ActivityHub` wiring near `main.rs:474`)
- Test: inline `#[cfg(test)]` in `existence.rs` (mirror the existing hand-rolled temp-dir helpers at `existence.rs:307-318` and the existing fallback tests for claude/opencode)

**Interfaces:**
- Consumes: `freshell_sessions::amplifier_stub::{session_on_disk, AmplifierSessionAnswer}` (Task 2); `freshell_ws::codex_reconcile::locate_codex_rollout(sessions_root: &Path, session_id: &str) -> Option<PathBuf>` (existing, `codex_reconcile.rs:154`).
- Produces (wired in `main.rs`, consumed implicitly by every `probe.exists()` caller):
  - `pub enum ByIdAnswer { Present, Absent, Unreadable }` (one shared enum for both new locators; mirror `OpencodeDbAnswer`'s shape)
  - `pub type AmplifierSessionLocator = Arc<dyn Fn(&str) -> ByIdAnswer + Send + Sync>`
  - `pub type CodexRolloutExistenceLocator = Arc<dyn Fn(&str) -> ByIdAnswer + Send + Sync>`
  - `impl IndexExistenceProbe { pub fn with_amplifier_session_locator(self, l: AmplifierSessionLocator) -> Self; pub fn with_codex_rollout_locator(self, l: CodexRolloutExistenceLocator) -> Self }`
  - `pub fn amplifier_dir_locator(amplifier_home: PathBuf) -> AmplifierSessionLocator`
  - `pub fn codex_rollout_existence_locator(sessions_root: PathBuf) -> CodexRolloutExistenceLocator`

- [ ] **Step 1: Write the failing tests**

Add to the existing `#[cfg(test)] mod tests` in `existence.rs`, copying the construction pattern of the existing claude raw-file-fallback and opencode by-id tests in that module (same fake-index/temp-dir scaffolding; the module is `existence.rs:301-1293` — pick the nearest analogous test and clone its setup):

```rust
    #[test]
    fn amplifier_absent_snapshot_rescued_by_dir_locator() {
        // Warm snapshot says Absent, but the session dir exists on disk
        // (created after the snapshot). By-id fallback must answer Present.
        // Setup: probe with a warm snapshot NOT containing "amp-new",
        // chained .with_amplifier_session_locator(amplifier_dir_locator(home))
        // where home contains projects/-p/sessions/amp-new/.
        // Assert: probe.exists("amplifier", "amp-new") == SessionExistence::Present
    }

    #[test]
    fn amplifier_definitively_absent_stays_absent() {
        // Warm snapshot Absent + locator scans a readable store without the id.
        // Assert: probe.exists("amplifier", "amp-gone") == SessionExistence::Absent
    }

    #[test]
    fn amplifier_unreadable_store_answers_unknown() {
        // Locator returns Unreadable (e.g. permissions).
        // Wire a hand-rolled locator: Arc::new(|_| ByIdAnswer::Unreadable).
        // Assert: probe.exists("amplifier", "amp-x") == SessionExistence::Unknown
    }

    #[test]
    fn amplifier_without_locator_keeps_snapshot_answer() {
        // No locator chained (default) => today's behavior byte-for-byte.
        // Assert: warm snapshot Absent stays Absent.
    }

    #[test]
    fn codex_absent_snapshot_rescued_by_rollout_locator() {
        // Same shape as the amplifier rescue test, with a temp codex sessions
        // root containing sessions/2026/07/29/rollout-...-<id>.jsonl and
        // codex_rollout_existence_locator(root).
        // Assert Present.
    }

    #[test]
    fn codex_missing_sessions_root_is_absent_and_unreadable_is_unknown() {
        // sessions root NotFound => Absent (fresh install, store readable-empty);
        // locator returning Unreadable => probe answers Unknown.
    }
```

Write these as REAL tests (full setup + assertions) by cloning the neighboring claude/opencode fallback tests' scaffolding — the comments above define the required behavior of each; the scaffolding (fake index snapshot seeding, probe construction) must match what those existing tests already do in this module.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server existence`
Expected: FAIL to compile — `with_amplifier_session_locator` etc. not defined.

- [ ] **Step 3: Implement the locators and fallbacks**

In `existence.rs`:

```rust
/// By-id disk answer for the amplifier/codex fallbacks (mirrors OpencodeDbAnswer).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByIdAnswer {
    Present,
    Absent,
    Unreadable,
}

pub type AmplifierSessionLocator = Arc<dyn Fn(&str) -> ByIdAnswer + Send + Sync>;
pub type CodexRolloutExistenceLocator = Arc<dyn Fn(&str) -> ByIdAnswer + Send + Sync>;

pub fn amplifier_dir_locator(amplifier_home: std::path::PathBuf) -> AmplifierSessionLocator {
    Arc::new(move |session_id: &str| {
        match freshell_sessions::amplifier_stub::session_on_disk(&amplifier_home, session_id) {
            freshell_sessions::amplifier_stub::AmplifierSessionAnswer::Present => ByIdAnswer::Present,
            freshell_sessions::amplifier_stub::AmplifierSessionAnswer::Absent => ByIdAnswer::Absent,
            freshell_sessions::amplifier_stub::AmplifierSessionAnswer::Unreadable => ByIdAnswer::Unreadable,
        }
    })
}

pub fn codex_rollout_existence_locator(
    sessions_root: std::path::PathBuf,
) -> CodexRolloutExistenceLocator {
    Arc::new(move |session_id: &str| {
        match std::fs::metadata(&sessions_root) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return ByIdAnswer::Absent,
            Err(_) => return ByIdAnswer::Unreadable,
            Ok(meta) if !meta.is_dir() => return ByIdAnswer::Unreadable,
            Ok(_) => {}
        }
        match freshell_ws::codex_reconcile::locate_codex_rollout(&sessions_root, session_id) {
            Some(_) => ByIdAnswer::Present,
            None => ByIdAnswer::Absent,
        }
    })
}
```

Add two `Option<...>` fields to `IndexExistenceProbe` plus builder methods `with_amplifier_session_locator` / `with_codex_rollout_locator` (exactly mirroring `with_claude_transcript_locator` / `with_opencode_session_locator`). In the `exists()` body's warm-snapshot-Absent adjudication section (`existence.rs:181-277`, after the claude raw-file fallback at `:226` and the opencode by-id fallback at `:254`), add the same pattern for amplifier and codex:

```rust
        // amplifier/codex by-id fallbacks (resume-validation feature):
        // a stale warm snapshot must never adjudicate a real session absent.
        if provider == "amplifier" {
            if let Some(locator) = &self.amplifier_session_locator {
                return match locator(session_id) {
                    ByIdAnswer::Present => SessionExistence::Present,
                    ByIdAnswer::Unreadable => SessionExistence::Unknown,
                    ByIdAnswer::Absent => SessionExistence::Absent,
                };
            }
        }
        if provider == "codex" {
            if let Some(locator) = &self.codex_rollout_locator {
                return match locator(session_id) {
                    ByIdAnswer::Present => SessionExistence::Present,
                    ByIdAnswer::Unreadable => SessionExistence::Unknown,
                    ByIdAnswer::Absent => SessionExistence::Absent,
                };
            }
        }
```

(Place them at the same adjudication point as the existing fallbacks — only reached when the snapshot would otherwise answer `Absent`.)

In `main.rs`, at the probe construction site, chain the new builders:
- `with_amplifier_session_locator(amplifier_dir_locator(home))` where `home` comes from `freshell_sessions::amplifier_stub::resolve_amplifier_home()` (skip chaining when it returns `None` — probe then behaves as today for amplifier).
- `with_codex_rollout_locator(codex_rollout_existence_locator(codex_sessions_root))` where `codex_sessions_root` is resolved exactly like the `ActivityHub` wiring near `main.rs:474` (`$CODEX_HOME` else `$HOME/.codex`, joined with `sessions`). Reuse/extract that resolution rather than duplicating it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server existence`
Expected: PASS — all new tests plus the existing ~existing existence tests stay green.
Then: `cargo test -p freshell-server` and `cargo clippy -p freshell-server -- -D warnings`.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-server/src/existence.rs crates/freshell-server/src/main.rs
git commit -m "feat(resume-validation): amplifier + codex by-id existence fallbacks"
```

---

### Task 4: `RetiredReason::SessionMissing` + `PaneLedger::retire_missing`

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger.rs`
- Test: `crates/freshell-ws/src/pane_ledger_tests.rs` (existing `#[path]` test split)

**Interfaces:**
- Consumes: existing `BindingRow`, `RowState {Bound|Retired}`, `RetiredReason {Superseded|Closed|GcExpired}` (`pane_ledger.rs:77-88`), `retire_closed` (`:563`) as the implementation template, `load_binding` (`:617`).
- Produces (used by Tasks 6–8):
  - `RetiredReason::SessionMissing` (serde `snake_case` → `"session_missing"`; enum is `#[serde(rename_all = "snake_case")]`)
  - `pub fn retire_missing(&self, provider: &str, session_id: &str) -> bool` — retires a `Bound` row with `retired_reason = Some(SessionMissing)`; returns `true` iff a bound row was retired; no-op (`false`) when no row exists or the row is already `Retired`; durable atomic write like every other mutation in this module.

- [ ] **Step 1: Write the failing tests**

Add to `pane_ledger_tests.rs`, cloning the setup style of the existing `retire_closed` tests in that file:

```rust
#[test]
fn retire_missing_marks_bound_row_session_missing() {
    // Setup: a ledger with a Bound binding for ("amplifier", "stale-sid")
    // (create it exactly the way the neighboring retire_closed test does).
    // Act:
    //   let retired = ledger.retire_missing("amplifier", "stale-sid");
    // Assert:
    //   retired == true;
    //   let row = ledger.load_binding("amplifier", "stale-sid").unwrap();
    //   row.state == RowState::Retired;
    //   row.retired_reason == Some(RetiredReason::SessionMissing);
}

#[test]
fn retire_missing_is_noop_without_binding() {
    // Fresh ledger, no rows.
    // Assert: ledger.retire_missing("amplifier", "never-seen") == false
    // and no row was created (load_binding returns None).
}

#[test]
fn retire_missing_does_not_reretire() {
    // Bound row retired once => true; second call => false; reason stays
    // SessionMissing; updated_at from the first retire is not clobbered
    // by the failed second call.
}

#[test]
fn session_missing_serde_round_trips() {
    // serde_json::to_string(&RetiredReason::SessionMissing) == "\"session_missing\""
    // and it deserializes back.
}
```

Write these as REAL tests using the exact ledger-construction and row-seeding helpers the neighboring `retire_closed` tests in this file already use.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws pane_ledger`
Expected: FAIL to compile — `SessionMissing` / `retire_missing` not defined.

- [ ] **Step 3: Implement**

- Add `SessionMissing` to `RetiredReason`.
- Implement `retire_missing` by copying `retire_closed`'s body/pattern (`pane_ledger.rs:563`) with the reason swapped and the bound-row guard as specified. Keep the module's durability discipline (atomic temp+rename via the existing write path).
- Run `cargo check -p freshell-ws -p freshell-server` — the compiler will flag any exhaustive `match` on `RetiredReason` elsewhere; extend each arm conservatively (treat `SessionMissing` like `Closed` wherever a policy choice is needed, i.e. "not resumable, not superseded"). List every touched match site in the commit message body.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws pane_ledger`
Expected: PASS. Then `cargo test -p freshell-ws` — whole crate green.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/pane_ledger_tests.rs
git commit -m "feat(resume-validation): RetiredReason::SessionMissing + retire_missing"
```

---

### Task 5: `notice` field on `terminal.created` + client rendering

**Files:**
- Modify: `crates/freshell-protocol/src/server_messages.rs` (the `TerminalCreated` struct — locate `TerminalCreated` in the file)
- Modify: port contract schema for `terminal.created` (locate via `grep -rn "terminal.created" port/ server/ --include="*.ts" --include="*.json" -l` and update whichever schema/zod/JSON-schema file mirrors the frame's fields — repo convention: protocol fields are mirrored in `crates/freshell-protocol` AND the port contract schemas)
- Modify: `src/components/TerminalView.tsx` — the `terminal.created` success handler (it lives near the create-`error` handling that renders `[Restore failed]` at `TerminalView.tsx:4691`)
- Test: Rust serde test inline in `server_messages.rs` (or the protocol crate's existing test module for server messages); client test added to the existing test file that covers `[Restore failed]` rendering (find it: `grep -rln "Restore failed" test/`)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Task 6): `TerminalCreated { …existing fields…, notice: Option<String> }` serialized as `"notice"` only when present (`#[serde(skip_serializing_if = "Option::is_none")]`). Client behavior: when `msg.notice` is a non-empty string, write it into the pane's xterm as its own line, styled exactly like the reconcile-notice write at `TerminalView.tsx:4336`/`:5053`.

This is one additive optional field on an existing message type — the frozen `SERVER_MESSAGE_TYPES` inventory (57 entries) is unchanged. The Node server never sets the field; it is optional end-to-end.

- [ ] **Step 1: Write the failing Rust serde test**

In the protocol crate's server-message test module:

```rust
#[test]
fn terminal_created_notice_is_optional_and_additive() {
    // Absent => key omitted (wire-compatible with the frozen client).
    let created = /* construct TerminalCreated exactly as the neighboring
                     TerminalCreated tests in this module do */;
    let json = serde_json::to_value(&ServerMessage::TerminalCreated(created)).unwrap();
    assert!(json.get("notice").is_none());

    // Present => serialized verbatim.
    let mut with_notice = /* same constructor */;
    with_notice.notice = Some("Saved amplifier session X could not be found on disk — started a fresh session instead.".to_string());
    let json = serde_json::to_value(&ServerMessage::TerminalCreated(with_notice)).unwrap();
    assert_eq!(
        json["notice"],
        "Saved amplifier session X could not be found on disk — started a fresh session instead."
    );
}
```

(Use the construction helper/literal style of the existing `TerminalCreated` tests in that module.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-protocol terminal_created_notice`
Expected: FAIL to compile — no `notice` field.

- [ ] **Step 3: Add the field + schema mirror**

```rust
    /// Resume-validation feature: operator-visible notice set when the server
    /// dropped a stale resume id and spawned fresh. The client writes it into
    /// the pane's xterm. Optional/additive — Node never sets it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
```

Add `notice: None` at every existing `TerminalCreated { … }` construction site (`cargo check` will enumerate them). Update the port contract schema for `terminal.created` with the optional `notice` string field. Run `cargo test -p freshell-protocol --locked` (the CI contract invocation) — green.

- [ ] **Step 4: Write the failing client test, then render**

RED: In the existing test file covering `[Restore failed]` rendering, add a sibling test using that file's existing harness/mocks verbatim:

```typescript
it('writes the resume-validation notice into the terminal on terminal.created', () => {
  // Arrange exactly like the sibling "[Restore failed]" test (same mount,
  // same xterm mock, same WS message dispatch helper), then dispatch a
  // terminal.created message for this pane that includes:
  //   notice: 'Saved amplifier session 8dab420a-f76b-407c-bcbe-dfb2a971c2e1 could not be found on disk — started a fresh session instead.'
  // Assert the xterm write buffer received a line containing
  // 'Saved amplifier session 8dab420a-f76b-407c-bcbe-dfb2a971c2e1'.
});
```

Run it (`npm run test:vitest -- <that-file> --run`), watch it fail. GREEN: in `TerminalView.tsx`'s `terminal.created` handler, when `msg.notice` is a non-empty string, write it into the pane's xterm as its own line using the exact styling/write mechanism of the reconcile-notice write at `:4336`/`:5053`. Re-run the test — PASS. Also re-run the whole file to confirm no regressions.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-protocol/src/server_messages.rs src/ <port-contract-schema-file> test/
git commit -m "feat(resume-validation): optional notice on terminal.created, rendered in the pane"
```

---

### Task 6: Door 1 — gate the WS `terminal.create` restore path

**Files:**
- Create: `crates/freshell-ws/src/resume_validation.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (add `pub mod resume_validation;`)
- Modify: `crates/freshell-ws/src/terminal.rs` — `handle_create`, between the resume-id derivation block (ends `:1717`) and the amplifier pre-create block (starts `:1799`)
- Test: inline `#[cfg(test)]` in `resume_validation.rs`; integration: `crates/freshell-ws/tests/resume_validation_gate.rs`

**Interfaces:**
- Consumes: Task 1 (`resume_gate::*`), Task 4 (`retire_missing`), Task 5 (`notice` field), existing `SessionExistenceProbe` (`state.session_existence`), `LaunchIntent`, `uuid::Uuid`.
- Produces (also used by Task 7):

```rust
pub struct ResumeValidationOutcome {
    pub resume_session_id: Option<String>,
    pub launch_intent: LaunchIntent,
    /// True when the fallback minted a fresh claude Start id (caller must set
    /// its claude_fresh_prealloc flag so downstream identity stamping matches
    /// the genuine fresh-claude path).
    pub claude_fresh_prealloc: bool,
    /// Some(stale_id) iff the gate fired: caller retires the ledger row,
    /// emits the notice, and must NOT stamp the stale sessionRef.
    pub stale_session_id: Option<String>,
    pub notice: Option<String>,
}

pub fn validate_wire_resume(
    mode: &str,
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
    probe: &dyn SessionExistenceProbe,
) -> ResumeValidationOutcome
```

- [ ] **Step 1: Write the failing unit tests**

`crates/freshell-ws/src/resume_validation.rs` with a stub probe:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::existence::{SessionExistence, SessionExistenceProbe};
    use freshell_platform::cli_launch::LaunchIntent;

    struct FakeProbe {
        answer: SessionExistence,
        ever_on_disk: bool,
    }
    impl SessionExistenceProbe for FakeProbe {
        fn exists(&self, _p: &str, _s: &str) -> SessionExistence {
            self.answer
        }
        fn ever_observed(&self, _p: &str, _s: &str) -> bool {
            false
        }
        fn ever_observed_on_disk(&self, _p: &str, _s: &str) -> bool {
            self.ever_on_disk
        }
    }

    fn absent() -> FakeProbe {
        FakeProbe { answer: SessionExistence::Absent, ever_on_disk: true }
    }

    #[test]
    fn amplifier_absent_mints_fresh_uuid_and_reports_stale() {
        let out = validate_wire_resume(
            "amplifier",
            Some("stale-amp".into()),
            LaunchIntent::Resume,
            &absent(),
        );
        let fresh = out.resume_session_id.expect("fresh amplifier id preallocated");
        assert_ne!(fresh, "stale-amp");
        assert_eq!(out.launch_intent, LaunchIntent::Resume);
        assert!(!out.claude_fresh_prealloc);
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-amp"));
        let notice = out.notice.expect("notice set");
        assert!(notice.contains("stale-amp"));
    }

    #[test]
    fn claude_absent_previously_on_disk_falls_back_to_start_intent() {
        let out = validate_wire_resume(
            "claude",
            Some("stale-claude".into()),
            LaunchIntent::Resume,
            &absent(),
        );
        assert!(out.resume_session_id.is_some());
        assert_ne!(out.resume_session_id.as_deref(), Some("stale-claude"));
        assert_eq!(out.launch_intent, LaunchIntent::Start);
        assert!(out.claude_fresh_prealloc);
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-claude"));
    }

    #[test]
    fn claude_zero_turn_absent_proceeds_untouched() {
        let probe = FakeProbe { answer: SessionExistence::Absent, ever_on_disk: false };
        let out = validate_wire_resume(
            "claude",
            Some("zero-turn".into()),
            LaunchIntent::Resume,
            &probe,
        );
        assert_eq!(out.resume_session_id.as_deref(), Some("zero-turn"));
        assert_eq!(out.launch_intent, LaunchIntent::Resume);
        assert!(out.stale_session_id.is_none());
        assert!(out.notice.is_none());
    }

    #[test]
    fn codex_and_opencode_absent_drop_resume_entirely() {
        for mode in ["codex", "opencode"] {
            let out = validate_wire_resume(
                mode,
                Some("stale-x".into()),
                LaunchIntent::Resume,
                &absent(),
            );
            assert!(out.resume_session_id.is_none());
            assert_eq!(out.stale_session_id.as_deref(), Some("stale-x"));
            assert!(out.notice.is_some());
        }
    }

    #[test]
    fn unknown_and_provider_unavailable_fail_open() {
        for answer in [SessionExistence::Unknown, SessionExistence::ProviderUnavailable] {
            let probe = FakeProbe { answer, ever_on_disk: false };
            let out = validate_wire_resume(
                "amplifier",
                Some("maybe".into()),
                LaunchIntent::Resume,
                &probe,
            );
            assert_eq!(out.resume_session_id.as_deref(), Some("maybe"));
            assert!(out.stale_session_id.is_none());
            assert!(out.notice.is_none());
        }
    }

    #[test]
    fn present_passes_through_untouched() {
        let probe = FakeProbe { answer: SessionExistence::Present, ever_on_disk: true };
        let out = validate_wire_resume(
            "amplifier",
            Some("real".into()),
            LaunchIntent::Resume,
            &probe,
        );
        assert_eq!(out.resume_session_id.as_deref(), Some("real"));
        assert!(out.stale_session_id.is_none());
    }

    #[test]
    fn unvalidated_providers_and_empty_ids_never_consult_probe() {
        struct PanickingProbe;
        impl SessionExistenceProbe for PanickingProbe {
            fn exists(&self, _: &str, _: &str) -> SessionExistence {
                panic!("probe must not be consulted");
            }
            fn ever_observed(&self, _: &str, _: &str) -> bool {
                panic!("probe must not be consulted");
            }
            fn ever_observed_on_disk(&self, _: &str, _: &str) -> bool {
                panic!("probe must not be consulted");
            }
        }
        for mode in ["gemini", "kimi", "shell", "third-party"] {
            let out = validate_wire_resume(
                mode,
                Some("id".into()),
                LaunchIntent::Resume,
                &PanickingProbe,
            );
            assert_eq!(out.resume_session_id.as_deref(), Some("id"));
        }
        let out = validate_wire_resume("amplifier", None, LaunchIntent::Resume, &PanickingProbe);
        assert!(out.resume_session_id.is_none());
        assert!(out.stale_session_id.is_none());
    }
}
```

(If the real `SessionExistenceProbe` trait has different required-method spellings, match the trait exactly — it is defined in `crates/freshell-ws/src/existence.rs`; `ever_observed_on_disk` has a default impl, override it in the fakes.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-ws resume_validation`
Expected: FAIL to compile — module doesn't exist yet.

- [ ] **Step 3: Implement `validate_wire_resume`**

```rust
//! Spawn-door resume validation (resume-validation feature): before a cached
//! session id is turned into resume argv, ask the disk-existence probe. On
//! POSITIVE absence, fall back to the same shape a genuinely fresh pane of
//! that mode uses. Unknown/unavailable always fail open.
//!
//! Callers (the spawn doors in `crate::terminal`) apply the outcome: retire
//! the stale ledger row, emit the notice, and never stamp the stale ref.

use freshell_platform::cli_launch::LaunchIntent;
use freshell_platform::resume_gate::{
    evaluate_resume_gate, provider_validated, stale_resume_notice, ResumeExistence,
    ResumeGateDecision,
};

use crate::existence::{SessionExistence, SessionExistenceProbe};

pub struct ResumeValidationOutcome {
    pub resume_session_id: Option<String>,
    pub launch_intent: LaunchIntent,
    pub claude_fresh_prealloc: bool,
    pub stale_session_id: Option<String>,
    pub notice: Option<String>,
}

fn passthrough(
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
) -> ResumeValidationOutcome {
    ResumeValidationOutcome {
        resume_session_id,
        launch_intent,
        claude_fresh_prealloc: false,
        stale_session_id: None,
        notice: None,
    }
}

pub fn map_existence(e: SessionExistence) -> ResumeExistence {
    match e {
        SessionExistence::Present => ResumeExistence::Present,
        SessionExistence::Absent => ResumeExistence::Absent,
        SessionExistence::Unknown | SessionExistence::ProviderUnavailable => {
            ResumeExistence::Unknown
        }
    }
}

pub fn validate_wire_resume(
    mode: &str,
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
    probe: &dyn SessionExistenceProbe,
) -> ResumeValidationOutcome {
    let Some(sid) = resume_session_id.clone().filter(|s| !s.is_empty()) else {
        return passthrough(resume_session_id, launch_intent);
    };
    if !provider_validated(mode) {
        return passthrough(resume_session_id, launch_intent);
    }
    let existence = map_existence(probe.exists(mode, &sid));
    let ever_on_disk = probe.ever_observed_on_disk(mode, &sid);
    match evaluate_resume_gate(mode, existence, ever_on_disk) {
        ResumeGateDecision::Proceed => passthrough(resume_session_id, launch_intent),
        ResumeGateDecision::SpawnFresh => {
            let notice = stale_resume_notice(mode, &sid);
            let (fresh_id, intent, claude_prealloc) = match mode {
                // Mirror the genuine fresh-pane shapes in handle_create
                // (should_preallocate_fresh_claude / _amplifier).
                "claude" => (
                    Some(uuid::Uuid::new_v4().to_string()),
                    LaunchIntent::Start,
                    true,
                ),
                "amplifier" => (
                    Some(uuid::Uuid::new_v4().to_string()),
                    LaunchIntent::Resume,
                    false,
                ),
                _ => (None, LaunchIntent::Resume, false),
            };
            ResumeValidationOutcome {
                resume_session_id: fresh_id,
                launch_intent: intent,
                claude_fresh_prealloc: claude_prealloc,
                stale_session_id: Some(sid),
                notice: Some(notice),
            }
        }
    }
}
```

Run: `cargo test -p freshell-ws resume_validation` — PASS.

- [ ] **Step 4: Write the failing integration test (RED), then wire door 1 (GREEN)**

RED: create `crates/freshell-ws/tests/resume_validation_gate.rs`. Reuse the harness of `crates/freshell-ws/tests/restore_spawn_gate.rs` verbatim (same `common::*` helpers, same way it builds `WsState`, injects a probe/temp stores, sends a `terminal.create` and reads response frames). Cases to cover (each is one `#[tokio::test]`):

1. `restore_true_amplifier_absent_spawns_fresh_with_notice`: state whose existence probe answers `Absent` for `("amplifier", "stale-amp")` (inject a fake `SharedExistenceProbe` — the harness sets `state.session_existence`; use a fake, not a real index) + a pane ledger containing a `Bound` row for that ref. Send `terminal.create { mode: "amplifier", restore: true, session_ref: {provider:"amplifier", sessionId:"stale-amp"}, cwd: <tempdir> }` (plus `FRESHELL_AMPLIFIER_HOME` pointed at an empty temp home so `ensure_session` runs against the temp store). Assert: the create SUCCEEDS (a `terminal.created` frame arrives, not an `error`); the `terminal.created` frame's `notice` contains `"stale-amp"`; the spawned resume id is NOT `stale-amp` (assert via the ledger: `load_binding("amplifier", "stale-amp")` is `Retired` with reason `SessionMissing`, and no amplifier session dir named `stale-amp` was created under the temp amplifier home — the fresh UUID dir exists instead).
2. `restore_true_amplifier_present_resumes_unchanged`: probe answers `Present`; assert `terminal.created` has NO `notice` and the ledger row stays `Bound`.
3. `restore_true_unknown_fails_open`: probe answers `Unknown`; assert no `notice`, row stays `Bound` (today's behavior preserved).

Run: `cargo test -p freshell-ws --test resume_validation_gate` — tests fail (no gate wired; notice absent, row stays bound in case 1).

GREEN — wire `handle_create` (`terminal.rs`), inside the resume-id derivation region:

a. In the derivation block (`:1617-1717`), add a tracker so the gate only sees wire-derived ids — in the `else` branch (the non-prealloc arm that reads `requested_ref` / `create.resume_session_id` / the claude restore ladder), set a new local `let mut resume_id_from_wire = true;` (declared `false` above the block).

b. Immediately after the derivation block (before the D7 liveness guard at `:1739` and the amplifier pre-create at `:1799`), insert:

```rust
    // Resume validation (docs/plans/2026-07-29-resume-validation.md): never
    // hand the CLI a resume id that is definitively absent from the
    // provider's on-disk store. Fail open on Unknown/ProviderUnavailable.
    let mut resume_fallback_notice: Option<String> = None;
    if resume_id_from_wire {
        let outcome = crate::resume_validation::validate_wire_resume(
            &mode,
            resume_session_id.take(),
            launch_intent,
            state.session_existence.as_ref(),
        );
        resume_session_id = outcome.resume_session_id;
        launch_intent = outcome.launch_intent;
        if outcome.claude_fresh_prealloc {
            claude_fresh_prealloc = true;
        }
        if let Some(stale) = outcome.stale_session_id.as_deref() {
            tracing::warn!(
                mode = %mode,
                stale_session_id = %stale,
                "resume validation: cached session missing on disk; spawning fresh"
            );
            // Don't retry the stale id forever.
            // (Use the same state.pane_ledger access pattern the claude
            // restore ladder / binding writes in this file already use.)
            let _ = state.pane_ledger.retire_missing(&mode, stale);
            resume_fallback_notice = outcome.notice;
        }
    }
```

(Adapt the exact `state.pane_ledger` spelling to how `handle_create` already reaches the ledger — e.g. if it is an `Option`/`Arc`, follow the existing call sites in this file.)

c. Stale-ref stamping guard: from the gate insertion point onward, `handle_create` must not stamp the stale `create.session_ref` as the pane's identity. Grep every use of `create.session_ref` / `requested_ref` BELOW the insertion point in `handle_create`; for each one that records identity (ledger binding writes, identity registry, `terminal.created` session fields), switch it to a local `effective_session_ref` that is `None` when the gate fired (the fresh id — when one was minted — flows through `resume_session_id` exactly as the prealloc paths already do). The integration test's ledger assertions in case 1 pin this.

d. Notice emission: where `handle_create` constructs the `TerminalCreated` success frame, set `notice: resume_fallback_notice` (field from Task 5).

Run: `cargo test -p freshell-ws --test resume_validation_gate` — PASS. Then run the neighbors that pin this region's behavior: `cargo test -p freshell-ws --test restore_spawn_gate --test claude_restore_unavailable --test codex_session_ref_resume --test pane_reconcile` and `cargo test -p freshell-platform` (argv goldens) — all green.

- [ ] **Step 5: Refactor + full-crate run**

Refactor pass: keep `handle_create`'s addition to the ~25 lines above (all policy is in `resume_validation.rs` / `resume_gate.rs`). Run `cargo test -p freshell-ws` (whole crate) and `cargo clippy -p freshell-ws -- -D warnings`.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-ws/src/resume_validation.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/resume_validation_gate.rs
git commit -m "feat(resume-validation): gate WS terminal.create restore path on disk existence"
```

---

### Task 7: Door 2 — gate the headless auto-resume respawn

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` — `respawn_agent_terminal` (`:2678`), specifically the hardcoded block at `:2708-2710` (`let resume_session_id = Some(req.session_id.clone());`)
- Test: extend the existing respawn integration coverage — `crates/freshell-ws/tests/auto_resume_respawn.rs` (reuse its harness/state setup verbatim)

**Interfaces:**
- Consumes: `validate_wire_resume` (Task 6), `retire_missing` (Task 4), existing `AgentRespawnRequest {mode, provider, session_id, create_request_id, cwd}` and the `emit_recovering`-style broadcast precedent (`auto_resume.rs:604-628`).
- Produces: no new public API. Behavior contract: on positive absence the respawn proceeds WITHOUT resume args (fresh spawn, same cwd/mode), the stale ledger row is retired `SessionMissing`, a `terminal.status{Recovering, reason}` frame naming the stale id is broadcast, and a `tracing::warn!` is logged. On Present/Unknown, byte-for-byte today's behavior.

- [ ] **Step 1: Write the failing integration test**

Add to `crates/freshell-ws/tests/auto_resume_respawn.rs`, cloning the setup of the existing tests in that file (fake state, fake probe injection into `state.session_existence`, temp amplifier home via `FRESHELL_AMPLIFIER_HOME`):

```rust
#[tokio::test]
async fn respawn_with_absent_session_spawns_fresh_and_retires_binding() {
    // Setup: harness state exactly as the sibling respawn test builds it,
    // with: probe answering Absent for ("amplifier", "stale-amp");
    // pane ledger holding a Bound row for that ref;
    // FRESHELL_AMPLIFIER_HOME -> empty temp dir.
    // Act: respawn_agent_terminal(state, AgentRespawnRequest {
    //     mode: "amplifier", provider: "amplifier",
    //     session_id: "stale-amp", create_request_id: <same as sibling>,
    //     cwd: Some(<tempdir>) }).await
    // Assert:
    // 1. respawn returns Ok (the pane survives — fresh spawn, not an error);
    // 2. ledger row ("amplifier","stale-amp") is Retired/SessionMissing;
    // 3. NO amplifier stub dir for "stale-amp" was created under the temp
    //    home (ensure_session must not run for the stale id);
    // 4. a broadcast terminal.status frame with status "recovering" was sent
    //    whose reason contains "stale-amp" (subscribe to state.broadcast_tx
    //    before the call, the way sibling tests capture broadcasts).
}

#[tokio::test]
async fn respawn_with_unknown_existence_resumes_exactly_as_today() {
    // Probe answers Unknown. Assert the spawned command still carries the
    // resume id (observe via whatever the sibling test asserts on — spawn
    // record/ledger/binding), the row stays Bound, and no recovering-with-
    // stale-id broadcast is emitted.
}
```

Write these as REAL tests using the file's existing helpers. Run: `cargo test -p freshell-ws --test auto_resume_respawn` — the two new tests FAIL.

- [ ] **Step 2: Wire the gate into `respawn_agent_terminal`**

Replace the hardcoded assignment at `terminal.rs:2708-2710`:

```rust
    // Spawn-time resume identity: intent is ALWAYS `Resume` on this path.
    // Resume validation (docs/plans/2026-07-29-resume-validation.md): the
    // respawn id comes from the identity registry / pane ledger — cached
    // state — so it gets the same disk-existence gate as door 1.
    let mut launch_intent = LaunchIntent::Resume;
    let outcome = crate::resume_validation::validate_wire_resume(
        &req.mode,
        Some(req.session_id.clone()),
        launch_intent,
        state.session_existence.as_ref(),
    );
    let resume_session_id = outcome.resume_session_id;
    launch_intent = outcome.launch_intent;
    if let Some(stale) = outcome.stale_session_id.as_deref() {
        tracing::warn!(
            mode = %req.mode,
            stale_session_id = %stale,
            "resume validation (respawn): cached session missing on disk; respawning fresh"
        );
        let _ = state.pane_ledger.retire_missing(&req.provider, stale);
        // Headless path: no per-create `out` sink. Broadcast the existing
        // Recovering status frame (precedent: auto_resume.rs emit_recovering)
        // with the notice as reason. Reason prose is presentational-only per
        // the protocol doc; typed fields carry no data change here.
        let msg = freshell_protocol::ServerMessage::TerminalStatus(freshell_protocol::TerminalStatus {
            status: freshell_protocol::RuntimeStatus::Recovering,
            terminal_id: req.create_request_id.clone(),
            attempt: None,
            max_attempts: None,
            exit_code: None,
            reason: outcome.notice.clone(),
        });
        if let Ok(json) = serde_json::to_string(&msg) {
            let _ = state.broadcast_tx.send(json);
        }
    }
```

Adapt the `TerminalStatus` field spellings/terminal-id source to the exact struct at `server_messages.rs:1102-1117` and to how `respawn_agent_terminal` names the terminal it is respawning (the sibling `emit_recovering` in `auto_resume.rs:604-628` is the template — if the respawned terminal id is available in scope, prefer it over `create_request_id`). Note `claude_fresh_prealloc` is intentionally unused here — for claude the outcome's `Start` intent + fresh id are honored by the same `CliLaunchInputs`, and this headless path has no prealloc bookkeeping to update (verify: the sibling tests + `cargo check` will surface any claude-specific respawn bookkeeping; if some exists, mirror door 1's handling).

Downstream in this function, the amplifier `ensure_session` call (`:2846`) keys off `resume_session_id` — with the gate having replaced the stale id by a fresh UUID, it stubs the FRESH id, which is exactly the fresh-amplifier-pane shape. No further change needed there.

- [ ] **Step 3: Run tests to verify they pass**

Run: `cargo test -p freshell-ws --test auto_resume_respawn`
Expected: PASS (new + pre-existing tests). Also: `cargo test -p freshell-ws --test auto_resume_e2e`.

- [ ] **Step 4: Refactor + full-crate run**

Run `cargo test -p freshell-ws` and `cargo clippy -p freshell-ws -- -D warnings` — green.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/auto_resume_respawn.rs
git commit -m "feat(resume-validation): gate headless auto-resume respawn on disk existence"
```

---

### Task 8: Door 3 — gate the freshagent REST create pipeline

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` — `FreshAgentState` builders (`:406-475` region, beside `with_opencode_locator` / `with_codex_locator` / `with_session_identity`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` — after `derive_resume_identity` (`:491-509`) resolves the resume id and before `CliLaunchInputs` is built for the resolver call at `:1355`; `reconcileNotice` injection at the `pane_content` construction (`:1657` precedent)
- Modify: `crates/freshell-server/src/main.rs` — wire the two closures when building `FreshAgentState`
- Test: the existing `#[cfg(test)]` module(s) for `terminal_tabs.rs` (where `requested_resume_session_id_for_mode` / `plausible_resume_session_id` are tested)

**Interfaces:**
- Consumes: Task 1's `ResumeProbeFn` / `ResumeProbeAnswer` / `evaluate_resume_gate` / `provider_validated` / `stale_resume_notice` (freshell-freshagent depends on freshell-platform and must NOT depend on freshell-ws — its Cargo.toml documents the cycle).
- Produces:
  - `FreshAgentState::with_resume_probe(self, probe: freshell_platform::resume_gate::ResumeProbeFn) -> Self` (field `resume_probe: Option<ResumeProbeFn>`, default `None` = feature off = today's behavior)
  - `FreshAgentState::with_on_stale_resume(self, cb: Arc<dyn Fn(&str, &str) + Send + Sync>) -> Self` — called with `(provider, stale_session_id)` when the gate fires; main.rs implements it as ledger `retire_missing` + `tracing::warn!`
  - A module-private pure helper in `terminal_tabs.rs`:

```rust
struct RestResumeOutcome {
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
    stale_session_id: Option<String>,
    notice: Option<String>,
}

fn validate_rest_resume(
    mode: &str,
    resume_session_id: Option<String>,
    launch_intent: LaunchIntent,
    probe: Option<&freshell_platform::resume_gate::ResumeProbeFn>,
) -> RestResumeOutcome
```

  Behavior identical to `validate_wire_resume` (Task 6) including the per-provider fresh-fallback shapes (claude → new UUID + `Start`; amplifier → new UUID + `Resume`; codex/opencode → `None`), with one addition: `probe: None` (not wired) → passthrough.

- [ ] **Step 1: Write the failing unit tests**

Add to the existing `#[cfg(test)]` module in `terminal_tabs.rs` (or its test split), with a fake probe fn:

```rust
    fn probe_answering(
        existence: freshell_platform::resume_gate::ResumeExistence,
        ever_on_disk: bool,
    ) -> freshell_platform::resume_gate::ResumeProbeFn {
        std::sync::Arc::new(move |_provider: &str, _sid: &str| {
            freshell_platform::resume_gate::ResumeProbeAnswer {
                existence,
                ever_observed_on_disk: ever_on_disk,
            }
        })
    }

    #[test]
    fn rest_resume_amplifier_absent_mints_fresh_and_notices() {
        use freshell_platform::resume_gate::ResumeExistence;
        let probe = probe_answering(ResumeExistence::Absent, true);
        let out = validate_rest_resume(
            "amplifier",
            Some("stale-amp".into()),
            LaunchIntent::Resume,
            Some(&probe),
        );
        assert_ne!(out.resume_session_id.as_deref(), Some("stale-amp"));
        assert!(out.resume_session_id.is_some());
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-amp"));
        assert!(out.notice.as_deref().unwrap().contains("stale-amp"));
    }

    #[test]
    fn rest_resume_without_probe_is_passthrough() {
        let out = validate_rest_resume(
            "amplifier",
            Some("anything".into()),
            LaunchIntent::Resume,
            None,
        );
        assert_eq!(out.resume_session_id.as_deref(), Some("anything"));
        assert!(out.stale_session_id.is_none());
        assert!(out.notice.is_none());
    }

    #[test]
    fn rest_resume_unknown_and_present_fail_open() {
        use freshell_platform::resume_gate::ResumeExistence;
        for e in [ResumeExistence::Unknown, ResumeExistence::Present] {
            let probe = probe_answering(e, false);
            let out = validate_rest_resume(
                "opencode",
                Some("ses_x".into()),
                LaunchIntent::Resume,
                Some(&probe),
            );
            assert_eq!(out.resume_session_id.as_deref(), Some("ses_x"));
            assert!(out.notice.is_none());
        }
    }

    #[test]
    fn rest_resume_codex_absent_drops_resume() {
        use freshell_platform::resume_gate::ResumeExistence;
        let probe = probe_answering(ResumeExistence::Absent, true);
        let out = validate_rest_resume(
            "codex",
            Some("stale-cx".into()),
            LaunchIntent::Resume,
            Some(&probe),
        );
        assert!(out.resume_session_id.is_none());
        assert_eq!(out.stale_session_id.as_deref(), Some("stale-cx"));
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-freshagent rest_resume`
Expected: FAIL to compile — `validate_rest_resume` not defined.

- [ ] **Step 3: Implement helper + wiring**

Implement `validate_rest_resume` (same body shape as `validate_wire_resume`, using `ResumeProbeFn` instead of the trait; `None` probe → passthrough; reuse `evaluate_resume_gate`, `provider_validated`, `stale_resume_notice` from freshell-platform; mint UUIDs via the crate's existing uuid dependency — check `Cargo.toml`, add `uuid` with `v4` feature if absent, matching the workspace version).

Wire it in the create pipeline: immediately after the resume id is derived (`derive_resume_identity`, before the amplifier ensure at `:895` and the `CliLaunchInputs` construction feeding `:1355`):

```rust
    let rest_outcome = validate_rest_resume(
        &mode,
        resume_session_id.take(),
        launch_intent,
        state.resume_probe.as_ref(),
    );
    let resume_session_id = rest_outcome.resume_session_id;
    let launch_intent = rest_outcome.launch_intent;
    if let Some(stale) = rest_outcome.stale_session_id.as_deref() {
        if let Some(cb) = &state.on_stale_resume {
            cb(&mode, stale);
        }
    }
```

(Adapt local variable names/mutability to the surrounding pipeline code; the amplifier ensure at `:895` then keys off the fresh id, mirroring door 1. If this pipeline sets identity/binding from the requested session ref, apply the same stale-ref guard as Task 6 step 4c: when the gate fired, the stale ref must not be stamped.)

Notice: where the handler builds the response `pane_content` (the `reconcileNotice` injection precedent at `:1657`), when `rest_outcome.notice` is `Some`, insert it as `"reconcileNotice"` in the `pane_content` JSON so the existing client chip/xterm rendering shows it. Add/extend a unit test in the same module asserting the built `pane_content` carries the notice when the gate fires (clone the existing `:1657`-area test if one exists, otherwise assert on the handler's pane-content builder function directly).

Add the `FreshAgentState` fields + builders in `lib.rs` (copy the `with_opencode_locator` builder shape exactly).

In `crates/freshell-server/src/main.rs`, where `FreshAgentState` is built, chain:

```rust
        .with_resume_probe({
            let probe = existence_probe.clone(); // the Arc<IndexExistenceProbe> built earlier
            std::sync::Arc::new(move |provider: &str, session_id: &str| {
                use freshell_platform::resume_gate::{ResumeExistence, ResumeProbeAnswer};
                use freshell_ws::existence::{SessionExistence, SessionExistenceProbe};
                let existence = match probe.exists(provider, session_id) {
                    SessionExistence::Present => ResumeExistence::Present,
                    SessionExistence::Absent => ResumeExistence::Absent,
                    SessionExistence::Unknown | SessionExistence::ProviderUnavailable => {
                        ResumeExistence::Unknown
                    }
                };
                ResumeProbeAnswer {
                    existence,
                    ever_observed_on_disk: probe.ever_observed_on_disk(provider, session_id),
                }
            })
        })
        .with_on_stale_resume({
            let ledger = pane_ledger.clone(); // the Arc<PaneLedger> built earlier
            std::sync::Arc::new(move |provider: &str, stale_id: &str| {
                tracing::warn!(
                    provider = %provider,
                    stale_session_id = %stale_id,
                    "resume validation (REST): cached session missing on disk; spawning fresh"
                );
                let _ = ledger.retire_missing(provider, stale_id);
            })
        })
```

(Adapt the variable names to what `main.rs` actually calls the probe and ledger Arcs at that point.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-freshagent && cargo test -p freshell-server && cargo clippy -p freshell-freshagent -p freshell-server -- -D warnings`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-server/src/main.rs
git commit -m "feat(resume-validation): gate freshagent REST create pipeline on disk existence"
```

---

### Task 9: Deviation ledger entry + full verification sweep

**Files:**
- Modify: `port/oracle/DEVIATIONS.md` (follow the file's existing entry format)
- No other code changes — this task is documentation + verification.

**Interfaces:**
- Consumes: everything above.
- Produces: the deviation record `port/AGENTS.md` mandates for deliberate behavior changes vs the Node original, citing the pinning tests.

- [ ] **Step 1: Write the DEVIATIONS.md entry**

Append an entry in the file's existing format with this content (adapt heading/ID style to the neighboring entries):

```markdown
## Resume validation at the spawn doors (2026-07-29)

**Deviation:** The Node reference passes cached resume session ids straight to
the coding CLI (`server/terminal-registry.ts` `resolveCodingCliCommand`;
`normalizeResumeForSpawn` is the identity function — no on-disk existence
check exists in Node). The Rust server now validates the id against the
provider's on-disk session store before constructing resume argv, at all three
spawn doors (WS `terminal.create`, headless auto-resume respawn, freshagent
REST create). On POSITIVE absence (store readable, session definitively
absent) it spawns fresh in the same cwd/mode, surfaces an operator notice
naming the stale id, and retires the pane-ledger binding
(`RetiredReason::SessionMissing`). Unknown/unreadable stores fail OPEN
(resume attempted, byte-for-byte Node behavior). Providers validated:
claude (with a zero-turn carve-out: Absent + never observed on disk still
resumes), codex, opencode, amplifier. gemini/kimi/third-party are never
blocked. Additive protocol field: optional `notice` on `terminal.created`.

**Why:** Production incident 2026-07-29 — after a server restart, freshell
resumed stored amplifier session id 8dab420a-f76b-407c-bcbe-dfb2a971c2e1 which
existed nowhere under ~/.amplifier/projects/*/sessions/; the amplifier CLI
silently created a new empty session under that id and the user saw a broken
restore with no explanation.

**Pinning tests:** `freshell-platform` `resume_gate` unit tests;
`freshell-ws/tests/resume_validation_gate.rs`;
`freshell-ws/tests/auto_resume_respawn.rs`
(`respawn_with_absent_session_spawns_fresh_and_retires_binding`);
`freshell-freshagent` `rest_resume_*` unit tests;
`freshell-server` `existence.rs` amplifier/codex by-id fallback tests.
```

- [ ] **Step 2: Full Rust verification**

Run (long, use a generous timeout):
```bash
cargo fmt --all -- --check
cargo clippy -p freshell-platform -p freshell-sessions -p freshell-server -p freshell-ws -p freshell-freshagent -p freshell-protocol -- -D warnings
cargo test -p freshell-platform -p freshell-sessions -p freshell-protocol
cargo test -p freshell-server -p freshell-ws -p freshell-freshagent
```
Expected: all green. Fix anything that isn't before proceeding (no known Rust flakes in these crates).

- [ ] **Step 3: Client verification (coordinator-gated)**

Run: `npm run test:unit`
Expected: green EXCEPT the known pre-existing `terminal-font-settings.test.tsx` failure from main — if it appears, note it in the commit body and do not chase it. If the coordinator gate is held by another agent, wait (never kill a foreign holder); set `FRESHELL_TEST_SUMMARY="resume-validation final verification"` for holder visibility.

- [ ] **Step 4: Commit**

```bash
git add port/oracle/DEVIATIONS.md
git commit -m "docs(resume-validation): deviation ledger entry for spawn-door resume validation"
```

- [ ] **Step 5: Final state check**

`git status` — working tree clean; branch `feat/resume-validation` contains Tasks 1–9 commits. STOP HERE: no PR, no merge, no server restart/deploy.

---

## Self-Review Record

**1. Spec coverage:**
- "Validate before constructing the resume command" → Tasks 6 (WS create/restore), 7 (auto-resume respawn), 8 (REST create) — all three call sites of `resolve_coding_cli_command` are gated. ✅
- "If validation fails: don't pass the resume flag; spawn fresh in same cwd/mode" → fallback shapes in `validate_wire_resume`/`validate_rest_resume` mirror each mode's genuine fresh-pane spawn; cwd/mode inputs are untouched. ✅
- "Operator-visible notice naming the stale id" → Task 5 (`notice` on `terminal.created` + xterm rendering, door 1), Task 8 (`reconcileNotice` in `pane_content`, door 3); door 2 broadcasts `terminal.status{Recovering, reason}` + warn-log — documented as the best available channel on a headless path (deliberate, stated in Design Notes). ✅
- "Clear/mark the stale cached id so it isn't retried forever" → Task 4 `retire_missing` (`SessionMissing`), invoked at all three doors. ✅
- "Fail open on Unknown/unreadable" → gate policy (Task 1) + probe `Unreadable→Unknown` mappings (Tasks 2–3) + explicit fail-open tests at every layer. ✅
- "Amplifier MUST be covered; store = ~/.amplifier/projects/<slug>/sessions/<id>/; search all projects (documented)" → Tasks 2–3 + Global Constraints. ✅
- "Cover providers freshell already reads; fail open for others" → claude/codex/opencode/amplifier validated; gemini/kimi/third-party never blocked (tested). ✅
- "Rust server REQUIRED; Node only if cheap — if skipped, say so" → Node explicitly skipped with reasons (Global Constraints). ✅
- "Non-goals respected" → no amplifier-CLI changes; no indexing subsystem changes beyond two by-id fallbacks the validation needs; protocol change limited to one additive optional field, mirrored per convention. ✅
- "TDD, unit + e2e, coordinated test commands, worktree, no PR/deploy, known flaky test" → per-task RGR steps + Task 9 sweep + Global Constraints. ✅

**1b. No silent deferrals:** The production outcome that proves the feature: `resume_validation_gate.rs` case 1 drives the REAL `handle_create` restore path with a stale amplifier ref against a real (temp) amplifier store and asserts fresh spawn + notice + retired binding — no stub stands in for required behavior in production code paths. Test doubles used (fake `SessionExistenceProbe`/`ResumeProbeFn` in unit tests) are replaced in production by `IndexExistenceProbe`, whose own by-id fallback behavior is tested against real temp stores in Task 3; the `main.rs` wiring is exercised by `cargo test -p freshell-server` compile + probe tests and reviewed in Tasks 3/8. No requirement was moved to known-limitations/future-work. NO UNRESOLVED COVERAGE GAPS.

**2. Placeholder scan:** Steps that intentionally clone an existing harness (Task 3 fallback tests, Task 6/7 integration tests, Task 5 client test, Task 4 ledger tests) each name the exact sibling file/test whose scaffolding to copy and spell out the complete required assertions — the behavior contract is fully specified; only mechanical harness reuse is deferred to the named files. No TBD/TODO/"handle edge cases" remain.

**3. Type consistency check:** `ResumeExistence{Present,Absent,Unknown}` and `ResumeGateDecision{Proceed,SpawnFresh}` (Task 1) used identically in Tasks 6–8; `ResumeProbeAnswer{existence, ever_observed_on_disk}`/`ResumeProbeFn` (Task 1) match Task 8's fake and main.rs closure; `AmplifierSessionAnswer{Present,Absent,Unreadable}` (Task 2) matches Task 3's `amplifier_dir_locator` mapping; `ByIdAnswer` (Task 3) used by both locators; `retire_missing(&self, provider: &str, session_id: &str) -> bool` (Task 4) matches every call site in Tasks 6–8; `validate_wire_resume(mode, Option<String>, LaunchIntent, &dyn SessionExistenceProbe) -> ResumeValidationOutcome` (Task 6) matches Task 7's call; `notice: Option<String>` field name consistent across Tasks 5 and 6. ✅
