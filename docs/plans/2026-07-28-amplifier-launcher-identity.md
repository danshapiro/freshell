# Launcher-Assigned Amplifier Session Identity Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** At amplifier terminal-create time (both WS `terminal.create` and REST `POST /api/tabs`/split), the Rust broker mints a UUID, pre-creates the session stub on disk under `~/.amplifier/projects/<cwd-slug>/sessions/<uuid>/`, and spawns `amplifier resume <uuid>` — identity is known before spawn, and the entire fragile post-spawn correlation-window path (amplifier locator + association) is deleted.

**Architecture:** A new `freshell-sessions::amplifier_stub` module owns the amplifier on-disk contract writers (cwd→slug, home resolution, stub writer with ensure-exists semantics, never-used GC predicate, boot-time layout canary). Both create paths call the same helpers. Setting `resume_session_id` before spawn makes ALL existing plumbing (argv `amplifier resume <uuid>` via the manifest `resumeArgs` template, `registry.set_meta`, identity upsert, `terminal.created.sessionRef`, pane-ledger binding, activity events-lane attach) work with zero client changes. `crates/freshell-sessions/src/amplifier_locator.rs` and `crates/freshell-ws/src/amplifier_association.rs` are deleted with all their plumbing; the `terminal_identity_unresolved` invariant alarm is re-homed onto its own sweep interval.

**Tech Stack:** Rust (crates `freshell-sessions`, `freshell-terminal`, `freshell-ws`, `freshell-freshagent`, `freshell-server`, `freshell-platform`), serde_json, chrono, uuid; TypeScript/vitest for the opt-in real-CLI contract test; Playwright for e2e.

**Reference material (read, don't rebase):** the retired branch worktree at `/home/dan/code/freshell/.worktrees/amplifier-session-identity` (branch `feat/amplifier-session-identity`) contains the fully-designed prior implementation: plan doc `docs/plans/2026-07-24-amplifier-session-identity.md`, module `crates/freshell-sessions/src/amplifier_stub.rs`, and contract test `test/integration/real/amplifier-stub-adoption-contract.test.ts`. Its DESIGN is validated; its Rust integration code is STALE against current main. Code blocks in this plan were extracted from that branch and adapted to current main's anchors — trust this plan's text over the retired branch when they differ.

**Stage-2 load-bearing validation (2026-07-28):** the external contracts this plan rests on were re-verified against the INSTALLED CLI (build `51194ef`) and current code: stub adoption, unknown-id rejection, zero-turn never-used signature, the `turn_count` write path (8793/8793 real-corpus metadata files carry it), the `prompt:submit` veto (synchronous emission verified in code + a live SIGHUP-kill test; 8490/8512 corpus prevalence), no-SIGHUP-persistence (static audit + 10s post-mortem write watch), downstream resume plumbing (all consumers fresh-vs-resume-indifferent), create-funnel atomicity, and a fresh 8961-session slug census (0 mismatches) — all VERIFIED. Two assumptions were FALSIFIED and the fixes are folded into this plan text: **A7** (e2e `AMPLIFIER_HOME` consumers — Task 14 now migrates the lane-resilience spec's 4 env pins + BOTH fake-CLI fixtures) and **A10** (effective-cwd corners — windows-like-arm reject + REST `resolve_unix_shell_cwd`, Tasks 8/11 + Global Constraints). Full evidence: `.worktrees/.the-usual-logs/amplifier-launcher-identity/load-bearing-ledger.md`.

## Global Constraints

Every task's requirements implicitly include this section.

- **Slug algorithm is an external contract** (amplifier_app_cli `project_utils.py:22-30`): `slug = str(Path.cwd().resolve()).replace("/", "-").replace("\\", "-").replace(":", "")`, prefixed with `-` if not already starting with one. E.g. `/home/dan/code/pedal` → `-home-dan-code-pedal`; dots and underscores preserved. Must byte-match; a mismatch fails SILENTLY in production.
- **Amplifier home resolution is a VALIDATED external contract (V1):** the real CLI stores sessions ONLY under `$HOME/.amplifier` (`session_store.py:96-98` hardcodes `Path.home()`); the CLI honors `AMPLIFIER_HOME` ONLY for bundle/module caches + `registry.json`. The broker uses ONE resolution — `$FRESHELL_AMPLIFIER_HOME` (freshell-specific test/dev override, used as-is, no `.amplifier` appended) else `$HOME/.amplifier` — shared by the stub writer AND the pre-existing `freshell_sessions::amplifier::amplifier_home()` (session index + activity events-path resolver). `AMPLIFIER_HOME` must appear NOWHERE on the broker side.
- **Stub shape (designed path, not accidental tolerances):** `metadata.json` with `session_id`, `created` (RFC-3339 UTC, millisecond precision, `Z` suffix), `working_dir` (resolved cwd), custom `freshell_terminal_id`; NO `bundle` key (so the user's default bundle resolves); plus an empty `transcript.jsonl` AND an empty `events.jsonl` (the latter is load-bearing: the activity events-lane resolver attaches at create time only if `events.jsonl` already `is_file()`).
- **ORDERING IS LOAD-BEARING:** the stub — including `events.jsonl` — MUST be written BEFORE `registry.create`, because the activity events-lane resolver attaches at create time (`ActivityEvent::Created`) and requires `events.jsonl` to already exist.
- **Keep `LaunchIntent::Resume` for amplifier.** The amplifier manifest (`extensions/amplifier/freshell.json`) has `resumeArgs: ["resume", "{{sessionId}}"]` only; `LaunchIntent::Start` without `createSessionArgs` is a hard `StartIntentUnsupported` error (`crates/freshell-platform/src/cli_launch.rs:431-445`). No argv/manifest changes.
- **GC never-used signature (validated F3/V4):** `metadata.json` lacks `turn_count` AND `transcript.jsonl` is empty/absent AND `events.jsonl` (if present) contains NO `prompt:submit` event (raw-BYTE scan — survives SIGHUP-truncated invalid UTF-8). Conservative on I/O errors: any error other than `NotFound` on transcript/events means the never-used signature cannot be PROVEN — keep. Missing/unparseable `metadata.json` ⇒ never deletable. GC only dirs the broker itself created (`created == true`).
- **cwd is part of the identity contract (HARD INVARIANT):** `amplifier resume <id>` only searches the current cwd's project slug. One `effective_cwd` — computed once, existence-validated, taken AFTER any launch-cwd transformation the spawn spec applies — feeds BOTH the stub slug AND the PTY spawn spec. Resumes of sessions found under a different slug spawn at the session's own `working_dir` or reject loudly. Two validated corners (falsified A10) both doors MUST close: (a) reject amplifier creates that would route to the windows-like spawn arm (`is_windows(host_os) || (is_wsl && effective_shell != System)` — a client-supplied `shell` reaches it, and its cwd handling is a DIFFERENT transformation than the one the stub slug is computed from); (b) run the effective cwd through `resolve_unix_shell_cwd` and reject `None` (REST's `is_dir` check admits RELATIVE paths, which the spawn layer resolves to `None` → the PTY inherits the broker's own cwd — silent divergence).
- **Preserve PR #540 / #554 / #559 semantics exactly:** the cross-mode D7 liveness guard, the create-dedupe machinery, and the server-wide spawn gate (REST gates every create; WS restore-only per user decision c3268185) all live in the same create-path regions. Compose new amplifier guards as SEQUENTIAL, complementary blocks; never reorder or weaken theirs.
- **Line anchors:** all `file:line` anchors in this plan were verified against `origin/main` @ `523d1e76`. Concurrent agents are active on this repo — re-verify each anchor (search for the quoted code) before editing, and check `git log` for surprises.
- **Test isolation (validated F7/V9):** every broker test that can reach an amplifier create must set `FRESHELL_AMPLIFIER_HOME` at a choke point BEFORE any create runs (Tasks 8 and 11 add these). The workspace is edition 2021, so `std::env::set_var`-based helpers compile as safe fns.
- **TDD throughout** (Red-Green-Refactor; never skip tests). Rust checks: `cargo test -p freshell-sessions -p freshell-ws -p freshell-terminal -p freshell-freshagent`.
- **Commits:** focused and atomic; every commit carries the footer `Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>`.
- **NEVER restart or kill the running self-hosted server (port 3002)** or use broad kill patterns.
- **DO NOT PUSH OR CREATE A PR.** All work stays committed in this worktree (`.worktrees/amplifier-launcher-identity`, branch `feat/amplifier-launcher-identity`). Landing is deferred to the council review gate that follows this workflow.
- **Scope clarifications (deliberate, from the kata — not silent deferrals):**
  - The frozen legacy Node tree (`server/coding-cli/amplifier-session-locator.ts`, `amplifier-session-controller.ts`, their unit tests, `server/index.ts:617`) is OUT of scope: the kata scopes deletion to the two Rust files. The legacy tree is frozen and does not compile-depend on the Rust code.
  - Legacy persisted panes with NO resume id and `restore: true` spawn a fresh identity-less amplifier (no preallocation on restore) — same accepted behavior as the retired design; the re-homed invariant sweep will WARN for them once, which is the designed loud signal.
  - Accepted residuals (recorded in the retired design's self-review, re-accepted here): (a) broker crash before terminal exit leaks a never-used stub (recovered by ensure-after-GC on the next open); (b) `pty.rs` cwd-less spawn retry can inherit the broker's cwd in the tiny validate→spawn window (loud in-terminal); (c) the exit-hook GC's `has_other_live_resume` guard cannot see a concurrent re-resume that passed `ensure_session` but has not yet inserted its registry row (loud, one-click-recoverable, sub-second race); (d) the GC's `prompt:submit` veto is supplied by the hooks-logging MODULE — mounted by the default `anchors` bundle and the user's `foundation` bundle (validated live + 8490/8512 real-corpus prevalence), emitted synchronously before any provider call — so an exotic custom bundle that unmounts it, overrides its config, or denies `prompt:submit` via a higher-priority hook weakens the veto; accepted (the transcript-non-empty and `turn_count` vetoes still apply).

---

### Task 1: Real-CLI stub-adoption contract test (contract-first)

**Files:**
- Create: `test/integration/real/amplifier-stub-adoption-contract.test.ts`

**Interfaces:**
- Consumes: nothing from this repo's Rust code (tests the REAL amplifier CLI's on-disk contract).
- Produces: the TS reference implementations `cwdSlug(resolvedCwd: string): string` and `writeStub(home, resolvedCwd, sessionId): Promise<string>` that Task 2/3's Rust must byte-match.

This test pins the two external contracts the whole feature rests on, against the real CLI: (1) `amplifier resume <id>` of a broker-shaped pre-created stub is ADOPTED (not rejected like an unknown id); (2) amplifier's own sessions land under exactly our computed slug, with `turn_count` (the GC "used" signature).

- [ ] **Step 1: Port the test file from the retired branch**

```bash
cp /home/dan/code/freshell/.worktrees/amplifier-session-identity/test/integration/real/amplifier-stub-adoption-contract.test.ts \
   test/integration/real/amplifier-stub-adoption-contract.test.ts
```

Then open it and verify it still matches the conventions of the current `test/integration/real/` directory (compare against `test/integration/real/amplifier-launch-smoke.test.ts`): per-file userland gating via `process.env.FRESHELL_RUN_REAL_PROVIDER_CONTRACTS === '1'` → `it`/`it.skip` constants, `// @vitest-environment node` for the top-level `await` on-PATH probe. The file's load-bearing pieces (must be present verbatim):

```ts
// The slug contract (amplifier_app_cli project_utils.py:22-30). The Rust
// twin is freshell_sessions::amplifier_stub::cwd_slug — keep byte-identical.
function cwdSlug(resolvedCwd: string): string {
  const slug = resolvedCwd.replaceAll('/', '-').replaceAll('\\', '-').replaceAll(':', '')
  return slug.startsWith('-') ? slug : `-${slug}`
}
```

```ts
async function writeStub(home: string, resolvedCwd: string, sessionId: string): Promise<string> {
  const dir = path.join(home, '.amplifier', 'projects', cwdSlug(resolvedCwd), 'sessions', sessionId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'metadata.json'), JSON.stringify({
    session_id: sessionId,
    created: new Date().toISOString(),
    working_dir: resolvedCwd,
    freshell_terminal_id: 'contract-test-terminal',
  }))
  await fs.writeFile(path.join(dir, 'transcript.jsonl'), '')
  await fs.writeFile(path.join(dir, 'events.jsonl'), '')
  return dir
}
```

Test 1 (`adopts a broker-shaped pre-created stub under the cwd slug`, 120s): two self-calibrating negative probes with random UUIDs (after UUID normalization via `/[0-9a-fA-F]{8}-…{12}/g` → `<ID>`, the two rejection outputs must be EQUAL and both must self-exit before the timeout), then write a stub and assert the stub resume's normalized output differs from the calibrated rejection signature AND stays interactive until OUR SIGTERM (`exitedBeforeTimeout === false`), then re-read `metadata.json`: `session_id` intact, `freshell_terminal_id === 'contract-test-terminal'`, `turn_count` undefined. Isolation is `HOME=<tmpdir>` in the spawned env (`AMPLIFIER_HOME` would isolate nothing but caches) plus `PROMPT_TOOLKIT_NO_CPR: '1'`.

Test 2 (`creates its own session dirs under exactly our computed slug, with turn_count`, 240s, additionally provider-key gated): run `amplifier run --output-format json 'Reply with exactly: contract-ok'` in the sandbox HOME, then assert `projects/` contains exactly `cwdSlug(cwd)`, the session's `metadata.json` has `turn_count` defined and `working_dir === cwd`.

- [ ] **Step 2: Typecheck / lint the new file**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep amplifier-stub-adoption || echo TS-OK`
Expected: `TS-OK` (no type errors mentioning the new file). If the repo uses a different typecheck entry (check `package.json` scripts), use that.

- [ ] **Step 3: Verify the gated default is skip (no env)**

Run: `npm run test:vitest -- run test/integration/real/amplifier-stub-adoption-contract.test.ts --config config/vitest/vitest.server.config.ts`
Expected: tests reported as skipped (gate env not set). Must NOT fail — CI never sets the gate.

- [ ] **Step 4: Run the contract test for real (amplifier is installed on this machine)**

Run:
```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- \
  run test/integration/real/amplifier-stub-adoption-contract.test.ts \
  --config config/vitest/vitest.server.config.ts
```
Expected: Test 1 PASSES (first run in a fresh HOME does network bundle-prepare clones, ~30s — timeouts are sized for it). Test 2 passes if a provider key is exported, else skips. If Test 1 FAILS, STOP — the external contract has drifted and the whole design needs re-validation; report the failure loudly instead of proceeding.

- [ ] **Step 5: Commit**

```bash
git add test/integration/real/amplifier-stub-adoption-contract.test.ts
git commit -m "$(cat <<'EOF'
test(amplifier): real-CLI contract pin for stub adoption and cwd-slug algorithm

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 2: `amplifier_stub` module scaffold — slug + ONE shared home resolution

**Files:**
- Create: `crates/freshell-sessions/src/amplifier_stub.rs`
- Modify: `crates/freshell-sessions/src/lib.rs` (module list at `:17-27` — add `pub mod amplifier_stub;` alphabetically between `amplifier` and `amplifier_locator`)
- Modify: `crates/freshell-sessions/src/amplifier.rs:44-55` (`amplifier_home` retarget)

**Interfaces:**
- Consumes: nothing new.
- Produces: `pub fn cwd_slug(resolved_cwd: &str) -> String`, `pub fn canonical_cwd(cwd: &str) -> PathBuf`, `pub fn resolve_amplifier_home() -> Option<PathBuf>` in `freshell_sessions::amplifier_stub`; retargeted `pub fn amplifier_home(home: &Path) -> PathBuf` in `freshell_sessions::amplifier` (same signature, new env rule).

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-sessions/src/amplifier_stub.rs` with only a module doc, the `use` line, and the test module (functions not yet written):

```rust
//! Launcher-assigned amplifier session identity: pre-create ("stub") session
//! dirs on disk so the broker can spawn `amplifier resume <id>` with an
//! identity it minted itself — no post-spawn correlation.
//!
//! Unlike [`crate::amplifier`] (read-only indexing; "never mutates provider
//! data"), this module deliberately WRITES into the amplifier home. The
//! on-disk layout and the cwd→slug algorithm are EXTERNAL contracts owned by
//! the amplifier CLI (amplifier_app_cli `project_utils.py:22-30`); they are
//! pinned by `test/integration/real/amplifier-stub-adoption-contract.test.ts`
//! and re-checked at broker start by `verify_amplifier_layout_contract`.

use std::path::{Path, PathBuf};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_slug_matches_amplifiers_algorithm_exactly() {
        // project_utils.py:22-30: replace / \ : then ensure a leading '-'.
        assert_eq!(cwd_slug("/home/dan/code/pedal"), "-home-dan-code-pedal");
        // Dots and underscores are PRESERVED.
        assert_eq!(cwd_slug("/home/dan/my.project_x"), "-home-dan-my.project_x");
        // Root: "/" -> "-".
        assert_eq!(cwd_slug("/"), "-");
        // Windows-shaped input: backslashes -> '-', drive colon stripped,
        // and the result gains a leading '-' because it doesn't start with one.
        assert_eq!(cwd_slug("C:\\Users\\dan"), "-C-Users-dan");
        // Already-leading '-' is not doubled.
        assert_eq!(cwd_slug("-already"), "-already");
    }

    #[test]
    fn canonical_cwd_resolves_symlinks_and_falls_back_on_missing_dirs() {
        let tmp = std::env::temp_dir();
        assert_eq!(
            canonical_cwd(tmp.to_str().unwrap()),
            std::fs::canonicalize(&tmp).unwrap()
        );
        // A vanished path falls back to the raw path (the spawn itself
        // surfaces the error).
        assert_eq!(
            canonical_cwd("/definitely/not/a/dir/xyz"),
            PathBuf::from("/definitely/not/a/dir/xyz")
        );
    }

    #[test]
    fn resolve_amplifier_home_prefers_freshell_override_then_home_dot_amplifier() {
        // NOTE: env is process-global; this test is the only one in this
        // crate that sets FRESHELL_AMPLIFIER_HOME, and it restores the prior
        // value.
        let prior = std::env::var("FRESHELL_AMPLIFIER_HOME").ok();
        std::env::set_var("FRESHELL_AMPLIFIER_HOME", "/custom/amp/home");
        // The override IS the amplifier home ROOT, used as-is (callers join
        // `projects/...` onto it) — no `.amplifier` appended.
        assert_eq!(
            resolve_amplifier_home(),
            Some(std::path::PathBuf::from("/custom/amp/home"))
        );
        // Reconciliation (F1): the pre-existing index/resolver resolution
        // (`crate::amplifier::amplifier_home`, retargeted from AMPLIFIER_HOME
        // in this task) must AGREE with resolve_amplifier_home() under both
        // env states — otherwise the create-time events-lane attach would
        // look in a different home than the stub writer wrote into.
        assert_eq!(
            crate::amplifier::amplifier_home(std::path::Path::new("/fake/home")),
            std::path::PathBuf::from("/custom/amp/home")
        );
        // Fallback: `$HOME/.amplifier` — the `.amplifier` segment IS
        // appended here, mirroring the CLI's hardcoded
        // `Path.home()/.amplifier` (session_store.py:96-98).
        std::env::remove_var("FRESHELL_AMPLIFIER_HOME");
        if let Ok(home) = std::env::var("HOME") {
            assert_eq!(
                resolve_amplifier_home(),
                Some(std::path::PathBuf::from(home).join(".amplifier"))
            );
        }
        assert_eq!(
            crate::amplifier::amplifier_home(std::path::Path::new("/fake/home")),
            std::path::PathBuf::from("/fake/home/.amplifier")
        );
        match prior {
            Some(v) => std::env::set_var("FRESHELL_AMPLIFIER_HOME", v),
            None => std::env::remove_var("FRESHELL_AMPLIFIER_HOME"),
        }
    }
}
```

Add `pub mod amplifier_stub;` to `crates/freshell-sessions/src/lib.rs` between `pub mod amplifier;` and `pub mod amplifier_locator;`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-sessions amplifier_stub`
Expected: COMPILE ERROR — `cwd_slug`, `canonical_cwd`, `resolve_amplifier_home` not found.

- [ ] **Step 3: Implement the three functions**

Insert above the test module in `amplifier_stub.rs`:

```rust
/// amplifier's cwd→project-slug algorithm (amplifier_app_cli
/// `project_utils.py:22-30`), byte-exact:
/// `str(Path.cwd().resolve()).replace("/", "-").replace("\\", "-").replace(":", "")`,
/// then prefix `-` unless it already starts with one. Dots/underscores
/// preserved. Input must already be RESOLVED — callers use [`canonical_cwd`],
/// mirroring Python's `Path.cwd().resolve()` (symlinks resolved).
/// A slug mismatch fails SILENTLY in production (our stub dir and
/// amplifier's own dir diverge), which is why the exact-match contract test
/// (`amplifier-stub-adoption-contract.test.ts`) and the boot canary exist.
pub fn cwd_slug(resolved_cwd: &str) -> String {
    let slug = resolved_cwd
        .replace('/', "-")
        .replace('\\', "-")
        .replace(':', "");
    if slug.starts_with('-') {
        slug
    } else {
        format!("-{slug}")
    }
}

/// `Path.cwd().resolve()` equivalent for the slug contract: canonicalize,
/// falling back to the raw path when canonicalization fails (dir vanished
/// between validation and spawn — the spawn itself surfaces that error).
pub fn canonical_cwd(cwd: &str) -> PathBuf {
    std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd))
}

/// The amplifier home ROOT (the dir containing `projects/`):
/// `$FRESHELL_AMPLIFIER_HOME` (freshell-specific test/dev override, used
/// as-is) if set and non-empty, else `$HOME/.amplifier` (real `HOME` only —
/// deliberately NOT `FRESHELL_HOME`). `None` when neither resolves (callers
/// surface a create error).
///
/// VALIDATED divergence — do NOT "fix" this to read `AMPLIFIER_HOME`: the
/// real CLI hardcodes `Path.home()/.amplifier` for session storage
/// (`session_store.py:96-98`) and honors `AMPLIFIER_HOME` ONLY for
/// bundle/module caches + `registry.json`. A user setting `AMPLIFIER_HOME`
/// moves caches, NOT sessions — consulting it here would place stubs where
/// the CLI never looks (silent identity divergence).
///
/// ONE broker-side resolution: [`crate::amplifier::amplifier_home`] (session
/// index + activity events-path resolver) is retargeted in this same task to
/// the identical `FRESHELL_AMPLIFIER_HOME`-else-`<home>/.amplifier` rule, so
/// the resolver that attaches the events lane at create time always looks in
/// the SAME home this module writes stubs into (pinned by the env test).
pub fn resolve_amplifier_home() -> Option<PathBuf> {
    match std::env::var("FRESHELL_AMPLIFIER_HOME") {
        Ok(v) if !v.is_empty() => Some(PathBuf::from(v)),
        _ => std::env::var("HOME")
            .ok()
            .filter(|v| !v.is_empty())
            .map(|h| PathBuf::from(h).join(".amplifier")),
    }
}
```

Then retarget `crates/freshell-sessions/src/amplifier.rs` — replace the current body (which consults `AMPLIFIER_HOME` first, `amplifier.rs:44-55`) with:

```rust
/// Broker-side amplifier home ROOT — the SAME resolution as
/// `amplifier_stub::resolve_amplifier_home` (ONE resolution shared by the
/// stub writer, the session index, and the activity events-path resolver,
/// so the create-time events-lane attach always finds the stub):
/// `FRESHELL_AMPLIFIER_HOME` (freshell test/dev override, used as-is) else
/// `<home>/.amplifier`. Deliberately RETARGETED away from the Node
/// provider's `AMPLIFIER_HOME` mirror (`providers/amplifier.ts:12-14`): the
/// real CLI stores sessions ONLY under `$HOME/.amplifier`
/// (`session_store.py:96-98`) and honors `AMPLIFIER_HOME` for
/// caches/`registry.json` only, so consulting it here scanned a dir
/// sessions never live in whenever a user exported it.
pub fn amplifier_home(home: &Path) -> PathBuf {
    match std::env::var("FRESHELL_AMPLIFIER_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => home.join(".amplifier"),
    }
}
```

Accepted behavior change (validated): for users who export `AMPLIFIER_HOME`, the index/resolver now correctly scan `$HOME/.amplifier` (where sessions actually are). If existing tests in `amplifier.rs` set `AMPLIFIER_HOME` to isolate, update them to set `FRESHELL_AMPLIFIER_HOME` instead. (Validated: no Rust unit test sets `AMPLIFIER_HOME` today.) NOTE (falsified A7): two e2e consumers DO pin `AMPLIFIER_HOME` for sandbox isolation — `test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts` (4 env pins) and `test/e2e-browser/fixtures/fake-amplifier-activity-cli.mjs:31` — Task 14 migrates them to `FRESHELL_AMPLIFIER_HOME`. Between this task and Task 14 that spec would be red if run manually; no plan step runs it earlier.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-sessions`
Expected: PASS (all three new tests, plus the whole crate — the `amplifier_home` retarget must not break existing amplifier index tests; fix any that pinned the `AMPLIFIER_HOME` behavior by retargeting their env var).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/amplifier_stub.rs crates/freshell-sessions/src/lib.rs crates/freshell-sessions/src/amplifier.rs
git commit -m "$(cat <<'EOF'
feat(sessions): amplifier cwd-slug contract + ONE shared home resolution (FRESHELL_AMPLIFIER_HOME)

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 3: Stub writer with ensure-exists semantics

**Files:**
- Modify: `crates/freshell-sessions/src/amplifier_stub.rs`

**Interfaces:**
- Consumes: `cwd_slug`, `canonical_cwd` (Task 2).
- Produces:
  ```rust
  #[derive(Debug, Clone)]
  pub struct EnsuredSession {
      pub session_dir: PathBuf,
      pub created: bool,
      pub found_under_divergent_slug: bool,
      pub working_dir_of_existing: Option<String>,
  }
  pub fn ensure_session(amplifier_home: &Path, session_id: &str, cwd: &str, terminal_id: &str)
      -> std::io::Result<EnsuredSession>;
  ```
- Note: `freshell-sessions` needs `chrono` and `serde_json` as dependencies; check `crates/freshell-sessions/Cargo.toml` and add `chrono = { workspace = true }` / `serde_json = { workspace = true }` if missing (match the workspace's dependency style).

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module (and a shared helper):

```rust
    /// pid+nanos-unique temp dir so parallel tests never collide.
    fn unique_temp_home(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "amp-stub-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ensure_session_writes_the_designed_stub_shape() {
        let home = unique_temp_home("shape");
        let cwd_dir = home.join("workdir");
        std::fs::create_dir_all(&cwd_dir).unwrap();
        let canonical = std::fs::canonicalize(&cwd_dir).unwrap();

        let ensured = ensure_session(
            &home,
            "11111111-2222-3333-4444-555555555555",
            cwd_dir.to_str().unwrap(),
            "term-1",
        )
        .unwrap();
        assert!(ensured.created);
        assert!(!ensured.found_under_divergent_slug);
        assert!(ensured.working_dir_of_existing.is_none());

        let expected_dir = home
            .join("projects")
            .join(cwd_slug(&canonical.to_string_lossy()))
            .join("sessions")
            .join("11111111-2222-3333-4444-555555555555");
        assert_eq!(ensured.session_dir, expected_dir);

        let meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(expected_dir.join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta["session_id"], "11111111-2222-3333-4444-555555555555");
        assert_eq!(meta["working_dir"], canonical.to_str().unwrap());
        assert_eq!(meta["freshell_terminal_id"], "term-1");
        // ISO-8601 with tz — must parse through the crate's own parser.
        assert!(crate::time::parse_timestamp_ms(&meta["created"]).is_some());
        // Omit `bundle` so the user's default bundle resolves.
        assert!(meta.get("bundle").is_none());
        // No turn_count on a fresh stub (the GC "unused" signature).
        assert!(meta.get("turn_count").is_none());
        // Empty transcript + empty events (events.jsonl is load-bearing for
        // the create-time activity events-lane attach).
        assert_eq!(std::fs::metadata(expected_dir.join("transcript.jsonl")).unwrap().len(), 0);
        assert_eq!(std::fs::metadata(expected_dir.join("events.jsonl")).unwrap().len(), 0);

        // Ensure-exists: a second call FINDS the dir, does not recreate.
        let again = ensure_session(
            &home,
            "11111111-2222-3333-4444-555555555555",
            cwd_dir.to_str().unwrap(),
            "term-2",
        )
        .unwrap();
        assert!(!again.created);
        // metadata untouched (still term-1).
        let meta2: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(expected_dir.join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta2["freshell_terminal_id"], "term-1");
    }

    #[test]
    fn ensure_session_finds_an_existing_dir_under_any_slug_and_does_not_touch_it() {
        let home = unique_temp_home("divergent");
        // A real session written by amplifier under some OTHER slug.
        let existing = home
            .join("projects")
            .join("-some-other-slug")
            .join("sessions")
            .join("sess-1");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(
            existing.join("metadata.json"),
            r#"{"session_id":"sess-1","working_dir":"/x","turn_count":3}"#,
        )
        .unwrap();

        let cwd_dir = home.join("elsewhere");
        std::fs::create_dir_all(&cwd_dir).unwrap();
        let ensured =
            ensure_session(&home, "sess-1", cwd_dir.to_str().unwrap(), "term-9").unwrap();
        assert!(!ensured.created);
        assert!(ensured.found_under_divergent_slug);
        assert_eq!(ensured.working_dir_of_existing.as_deref(), Some("/x"));
        assert_eq!(ensured.session_dir, existing);
        // Untouched: turn_count kept, no freshell_terminal_id injected.
        let meta: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(existing.join("metadata.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(meta["turn_count"], 3);
        assert!(meta.get("freshell_terminal_id").is_none());
    }

    #[test]
    fn ensure_session_rejects_ids_that_are_not_a_single_path_segment() {
        let home = unique_temp_home("pathsafety");
        let cwd = std::env::temp_dir();
        for bad in ["", ".", "..", "../../../etc/passwd", "a/b", "a\\b", "x\0y"] {
            let err =
                ensure_session(&home, bad, cwd.to_str().unwrap(), "t").unwrap_err();
            assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput, "id {bad:?}");
        }
        // Rejected BEFORE touching disk: projects/ never appears.
        assert!(!home.join("projects").exists());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-sessions amplifier_stub`
Expected: COMPILE ERROR — `EnsuredSession` / `ensure_session` not found.

- [ ] **Step 3: Implement `EnsuredSession` + `ensure_session`**

```rust
/// The outcome of [`ensure_session`]: where the session dir is, whether
/// THIS call created it (`created` gates the exit-hook GC — the broker only
/// ever deletes litter it wrote itself), and — for FOUND sessions — slug
/// provenance (validated fix F4/V6): whether the dir lives under a project
/// slug DIFFERENT from slug(canonical cwd), plus that session's own
/// metadata `working_dir`. On a divergent find the caller MUST override the
/// spawn cwd with `working_dir_of_existing` (if it exists and is a dir) or
/// reject the create — `amplifier resume` only searches the spawn cwd's
/// slug, so spawning at the requested cwd would silently find nothing.
#[derive(Debug, Clone)]
pub struct EnsuredSession {
    pub session_dir: PathBuf,
    pub created: bool,
    pub found_under_divergent_slug: bool,
    pub working_dir_of_existing: Option<String>,
}

/// Make `amplifier resume <session_id>` guaranteed-resumable from `cwd`
/// BEFORE spawn. If the session dir already exists under ANY project slug
/// (a real session, or a stub from a previous run), it is found and left
/// untouched — with slug provenance reported (see [`EnsuredSession`]).
/// Otherwise a stub is written under the slug of the CANONICAL cwd
/// (HARD INVARIANT: amplifier only searches the current cwd's slug — the
/// caller must spawn the PTY with this same cwd).
///
/// Stub shape (validated against the real CLI; see the Tier-1 contract
/// test): `metadata.json` with `session_id`, `created` (ISO-8601 UTC),
/// `working_dir` (canonical cwd), custom `freshell_terminal_id` (best-effort
/// durable-linkage bonus — validation observed a real turn's save REWRITE
/// metadata.json and add `*.backup` files, so the field may not survive use;
/// Freshell's own registry stays primary and nothing keys off it), NO `bundle`; plus empty `transcript.jsonl` and empty
/// `events.jsonl` (the latter so the activity hub's create-time resolver
/// attach finds a file — see the module design note).
pub fn ensure_session(
    amplifier_home: &Path,
    session_id: &str,
    cwd: &str,
    terminal_id: &str,
) -> std::io::Result<EnsuredSession> {
    // Path-safety gate (defense in depth): the id is joined into
    // filesystem paths (`projects/<slug>/sessions/<session_id>`) that this
    // function creates and writes, and that the exit-hook GC later
    // `remove_dir_all`s. Reject anything that is not a plain single path
    // segment BEFORE touching disk — an id containing `/`, `\`, or a bare
    // `.`/`..` would escape the amplifier home (client-supplied via WS
    // sessionRef, the REST body, or poisoned persisted state). Enforcing
    // it HERE covers every caller and the GC's delete path (the GC only
    // ever deletes dirs this function returned with `created: true`).
    if session_id.is_empty()
        || session_id == "."
        || session_id == ".."
        || session_id.contains(['/', '\\', '\0'])
    {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("amplifier session id {session_id:?} is not a valid single path segment"),
        ));
    }

    let resolved = canonical_cwd(cwd);
    let expected_slug = cwd_slug(&resolved.to_string_lossy());
    let projects = amplifier_home.join("projects");
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let candidate = entry.path().join("sessions").join(session_id);
            if candidate.is_dir() {
                let found_slug = entry.file_name().to_string_lossy().to_string();
                let divergent = found_slug != expected_slug;
                // On a divergent find, surface the session's own recorded
                // working_dir so the caller can spawn there (F4).
                let working_dir_of_existing = if divergent {
                    std::fs::read_to_string(candidate.join("metadata.json"))
                        .ok()
                        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                        .and_then(|meta| {
                            meta.get("working_dir")
                                .and_then(|v| v.as_str())
                                .map(str::to_string)
                        })
                } else {
                    None
                };
                return Ok(EnsuredSession {
                    session_dir: candidate,
                    created: false,
                    found_under_divergent_slug: divergent,
                    working_dir_of_existing,
                });
            }
        }
    }

    let dir = projects.join(expected_slug).join("sessions").join(session_id);
    std::fs::create_dir_all(&dir)?;
    let metadata = serde_json::json!({
        "session_id": session_id,
        "created": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "working_dir": resolved.to_string_lossy(),
        "freshell_terminal_id": terminal_id,
    });
    std::fs::write(
        dir.join("metadata.json"),
        serde_json::to_string_pretty(&metadata)?,
    )?;
    std::fs::write(dir.join("transcript.jsonl"), "")?;
    std::fs::write(dir.join("events.jsonl"), "")?;
    Ok(EnsuredSession {
        session_dir: dir,
        created: true,
        found_under_divergent_slug: false,
        working_dir_of_existing: None,
    })
}
```

If `crate::time::parse_timestamp_ms` does not exist with that exact name, find the crate's timestamp parser in `crates/freshell-sessions/src/time.rs` and use its real name in the test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-sessions amplifier_stub`
Expected: PASS (6 tests total in the module so far).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/amplifier_stub.rs crates/freshell-sessions/Cargo.toml
git commit -m "$(cat <<'EOF'
feat(sessions): amplifier stub writer with ensure-exists semantics

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 4: Never-used stub GC predicate and remover

**Files:**
- Modify: `crates/freshell-sessions/src/amplifier_stub.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `pub fn stub_is_unused(session_dir: &Path) -> bool`, `pub fn gc_stub_if_unused(session_dir: &Path) -> bool`.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module:

```rust
    fn write_gc_fixture(
        home: &Path,
        id: &str,
        metadata: &str,
        transcript: Option<&str>,
    ) -> PathBuf {
        let dir = home.join("projects").join("-p").join("sessions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("metadata.json"), metadata).unwrap();
        if let Some(t) = transcript {
            std::fs::write(dir.join("transcript.jsonl"), t).unwrap();
        }
        dir
    }

    #[test]
    fn stub_is_unused_recognizes_only_the_never_used_signature() {
        let home = unique_temp_home("gc-pred");
        let meta_unused = r#"{"session_id":"x","working_dir":"/w"}"#;
        let meta_used = r#"{"session_id":"x","working_dir":"/w","turn_count":2}"#;

        // Never used: no turn_count + empty transcript.                 -> true
        let a = write_gc_fixture(&home, "a", meta_unused, Some(""));
        assert!(stub_is_unused(&a));
        // Never used: no turn_count + transcript ABSENT.                -> true
        let b = write_gc_fixture(&home, "b", meta_unused, None);
        assert!(stub_is_unused(&b));
        // Used: turn_count present.                                     -> false
        let c = write_gc_fixture(&home, "c", meta_used, Some(""));
        assert!(!stub_is_unused(&c));
        // Used: non-empty transcript (even without turn_count).         -> false
        let d = write_gc_fixture(&home, "d", meta_unused, Some("{\"role\":\"user\"}\n"));
        assert!(!stub_is_unused(&d));
        // A zero-turn resume may create a small events.jsonl of session
        // LIFECYCLE events — tolerated (still unused).                  -> true
        let e = write_gc_fixture(&home, "e", meta_unused, Some(""));
        std::fs::write(e.join("events.jsonl"), "{\"event\":\"session:start\"}\n").unwrap();
        assert!(stub_is_unused(&e));
        // VALIDATED data-loss guard (F3/V4): an events.jsonl holding a
        // `prompt:submit` event means the user TYPED a prompt — a SIGHUP
        // mid-first-turn persists nothing to metadata/transcript, so this is
        // the ONLY trace of their content. NOT unused.                  -> false
        let f = write_gc_fixture(&home, "f", meta_unused, Some(""));
        std::fs::write(f.join("events.jsonl"), "{\"event\":\"prompt:submit\"}\n").unwrap();
        assert!(!stub_is_unused(&f));
        // Conservative byte-scan: a SIGHUP kill can truncate events.jsonl
        // mid multi-byte codepoint, making it invalid UTF-8 — the
        // `prompt:submit` veto must still fire on raw bytes.            -> false
        let h = write_gc_fixture(&home, "h", meta_unused, Some(""));
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend_from_slice(b"{\"event\":\"prompt:submit\"}\n");
        bytes.push(0xFF); // trailing truncated codepoint
        std::fs::write(h.join("events.jsonl"), bytes).unwrap();
        assert!(!stub_is_unused(&h));
        // Unparseable (present but invalid JSON) metadata.json: NOT
        // recognizably a stub — never delete.                           -> false
        let i = write_gc_fixture(&home, "i", "not json {", Some(""));
        assert!(!stub_is_unused(&i));
        // Missing metadata.json: NOT recognizably a stub — never delete. -> false
        let j = home.join("projects").join("-p").join("sessions").join("j");
        std::fs::create_dir_all(&j).unwrap();
        assert!(!stub_is_unused(&j));
    }

    #[test]
    fn gc_stub_if_unused_deletes_only_unused_dirs() {
        let home = unique_temp_home("gc-rm");
        let unused = write_gc_fixture(
            &home, "u", r#"{"session_id":"u","working_dir":"/w"}"#, Some(""),
        );
        let used = write_gc_fixture(
            &home, "v", r#"{"session_id":"v","working_dir":"/w","turn_count":1}"#, Some(""),
        );
        assert!(gc_stub_if_unused(&unused));
        assert!(!unused.exists());
        assert!(!gc_stub_if_unused(&used));
        assert!(used.exists());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-sessions amplifier_stub`
Expected: COMPILE ERROR — `stub_is_unused` / `gc_stub_if_unused` not found.

- [ ] **Step 3: Implement (I/O-error-conservative, raw-byte scan)**

```rust
/// The verified-unambiguous "never used" signature (validated fix F3/V4):
/// `metadata.json` lacks `turn_count` AND `transcript.jsonl` is empty or
/// absent AND `events.jsonl` (if present) contains NO `prompt:submit`
/// event. A lifecycle-only `events.jsonl` of any size is tolerated
/// (zero-turn resumes leave metadata byte-identical but may write a small
/// events file). The `prompt:submit` clause is a data-loss guard: the CLI
/// handles only SIGINT, a PTY close is SIGHUP, and a kill mid-FIRST-turn
/// persists nothing to metadata/transcript — but the user's typed prompt is
/// already in events.jsonl; deleting the dir would destroy it. (Saves are
/// otherwise per-turn synchronous + atomic tmp+rename, so no transient
/// mid-write windows exist and synchronous exit-hook GC is safe with this
/// predicate.) A dir without parseable metadata is NOT recognizably a stub
/// — never touched. Conservative on I/O errors: any error other than
/// NotFound on transcript.jsonl or events.jsonl means we cannot PROVE the
/// never-used signature — keep.
pub fn stub_is_unused(session_dir: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(session_dir.join("metadata.json")) else {
        return false;
    };
    let Ok(meta) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    if meta.get("turn_count").is_some() {
        return false;
    }
    match std::fs::metadata(session_dir.join("transcript.jsonl")) {
        Ok(m) if m.len() > 0 => return false,
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        // Cannot prove the transcript is empty — keep.
        Err(_) => return false,
    }
    // Substring scan over raw BYTES is deliberate: the event line shape is
    // the CLI's own (hooks-logging module), and any `"prompt:submit"` hit —
    // parseable or not — must veto deletion. Bytes (not read_to_string)
    // because the exact kill-mid-first-turn scenario this guard exists for
    // can truncate events.jsonl mid multi-byte codepoint, making it invalid
    // UTF-8; a decode failure must not skip the veto.
    const PROMPT_SUBMIT: &[u8] = b"\"prompt:submit\"";
    match std::fs::read(session_dir.join("events.jsonl")) {
        Ok(events) => {
            if events
                .windows(PROMPT_SUBMIT.len())
                .any(|w| w == PROMPT_SUBMIT)
            {
                return false;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        // Cannot prove the absence of a prompt:submit trace — keep.
        Err(_) => return false,
    }
    true
}

/// Delete a broker-created stub iff it is still unused ("own our litter" —
/// without this, every never-typed-in terminal becomes a permanent '0 msgs'
/// row in the user's `amplifier session list`). Returns whether the dir was
/// removed. Best-effort: IO errors just leave the dir in place.
pub fn gc_stub_if_unused(session_dir: &Path) -> bool {
    if !stub_is_unused(session_dir) {
        return false;
    }
    std::fs::remove_dir_all(session_dir).is_ok()
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-sessions amplifier_stub`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/amplifier_stub.rs
git commit -m "$(cat <<'EOF'
feat(sessions): never-used amplifier stub GC predicate and remover, conservative on I/O errors

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 5: On-disk layout canary (slug contract self-test)

**Files:**
- Modify: `crates/freshell-sessions/src/amplifier_stub.rs`

**Interfaces:**
- Consumes: `cwd_slug` (Task 2).
- Produces:
  ```rust
  #[derive(Debug, Clone, PartialEq, Eq)]
  pub enum CanaryOutcome {
      Pass { sessions_checked: usize },
      NothingToCheck,
      Broken { detail: String },
  }
  pub fn verify_amplifier_layout_contract(amplifier_home: &Path) -> CanaryOutcome;
  ```

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn canary_passes_when_real_session_dirs_match_our_slug() {
        let home = unique_temp_home("canary-pass");
        let dir = home
            .join("projects")
            .join(cwd_slug("/home/user/proj"))
            .join("sessions")
            .join("s1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            r#"{"session_id":"s1","working_dir":"/home/user/proj"}"#,
        )
        .unwrap();
        assert_eq!(
            verify_amplifier_layout_contract(&home),
            CanaryOutcome::Pass { sessions_checked: 1 }
        );
    }

    #[test]
    fn canary_reports_broken_on_slug_divergence() {
        let home = unique_temp_home("canary-broken");
        // A hypothetical NEW upstream scheme (underscores instead of dashes).
        let dir = home
            .join("projects")
            .join("home_user_repos_app")
            .join("sessions")
            .join("s1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            r#"{"session_id":"s1","working_dir":"/home/user/repos/app"}"#,
        )
        .unwrap();
        assert!(matches!(
            verify_amplifier_layout_contract(&home),
            CanaryOutcome::Broken { .. }
        ));
    }

    #[test]
    fn canary_has_nothing_to_check_on_an_empty_or_missing_home() {
        let empty = unique_temp_home("canary-empty");
        assert_eq!(
            verify_amplifier_layout_contract(&empty),
            CanaryOutcome::NothingToCheck
        );
        assert_eq!(
            verify_amplifier_layout_contract(Path::new("/definitely/not/a/home")),
            CanaryOutcome::NothingToCheck
        );
    }

    #[test]
    fn canary_skips_validated_real_world_shapes_without_false_alarms() {
        let home = unique_temp_home("canary-skips");
        // (a) session dir with no metadata.json (events.jsonl-only, 2.4% of
        // the validated corpus) — skipped, not Broken.
        let no_meta = home.join("projects").join("-p1").join("sessions").join("s1");
        std::fs::create_dir_all(&no_meta).unwrap();
        // (b) a projects/ entry with no sessions/ subdir (a literal
        // `{project}` template dir exists in real data) — skipped.
        std::fs::create_dir_all(home.join("projects").join("{project}")).unwrap();
        // One qualifying session still yields Pass{1}.
        let good = home
            .join("projects")
            .join(cwd_slug("/home/user/ok"))
            .join("sessions")
            .join("s2");
        std::fs::create_dir_all(&good).unwrap();
        std::fs::write(
            good.join("metadata.json"),
            r#"{"session_id":"s2","working_dir":"/home/user/ok"}"#,
        )
        .unwrap();
        assert_eq!(
            verify_amplifier_layout_contract(&home),
            CanaryOutcome::Pass { sessions_checked: 1 }
        );
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-sessions amplifier_stub`
Expected: COMPILE ERROR — `CanaryOutcome` / `verify_amplifier_layout_contract` not found.

- [ ] **Step 3: Implement**

```rust
/// Outcome of the boot-time layout canary ([`verify_amplifier_layout_contract`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanaryOutcome {
    Pass {
        sessions_checked: usize,
    },
    /// No amplifier home / no sessions with a `working_dir` — nothing to
    /// verify (amplifier unused or brand new). Not an error.
    NothingToCheck,
    Broken {
        detail: String,
    },
}

/// Cheap, re-runnable self-test of the on-disk contract this whole feature
/// rests on (undocumented upstream; microsoft/amplifier#315/#316 track a
/// `--session-id` flag that would collapse this layer into a flag): for a
/// bounded sample of sessions AMPLIFIER ITSELF wrote, verify the project dir
/// name equals [`cwd_slug`] of the session's own `working_dir`. A mismatch
/// means amplifier changed its slug/layout and our pre-created stubs would
/// silently diverge — callers log ERROR loudly but MUST NOT block broker
/// start.
///
/// VALIDATED skip classes (F6/V5 full-corpus census: 5216/5216 parseable
/// sessions match; 0 mismatches) — these are real shapes in real data, NOT
/// violations, and must be skipped rather than reported Broken: (a) session
/// dirs with no/unparseable `metadata.json` or no `working_dir`; (b)
/// `projects/` entries with no `sessions/` subdir (a literal `{project}`
/// template dir exists in real data).
pub fn verify_amplifier_layout_contract(amplifier_home: &Path) -> CanaryOutcome {
    const MAX_SESSIONS: usize = 20;
    let projects = amplifier_home.join("projects");
    let Ok(project_dirs) = std::fs::read_dir(&projects) else {
        return CanaryOutcome::NothingToCheck;
    };
    let mut checked = 0usize;
    for project in project_dirs.flatten() {
        let Some(project_name) = project.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(sessions) = std::fs::read_dir(project.path().join("sessions")) else {
            continue;
        };
        for session in sessions.flatten() {
            if checked >= MAX_SESSIONS {
                return CanaryOutcome::Pass {
                    sessions_checked: checked,
                };
            }
            let Ok(raw) = std::fs::read_to_string(session.path().join("metadata.json")) else {
                continue;
            };
            let Ok(meta) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let Some(working_dir) = meta.get("working_dir").and_then(|v| v.as_str()) else {
                continue;
            };
            // `working_dir` was written RESOLVED by amplifier — slug it
            // directly (no canonicalize: the dir may no longer exist).
            let expected = cwd_slug(working_dir);
            if expected != project_name {
                return CanaryOutcome::Broken {
                    detail: format!(
                        "session {} has working_dir {working_dir} → expected project slug {expected}, but lives under {project_name}",
                        session.path().display()
                    ),
                };
            }
            checked += 1;
        }
    }
    if checked == 0 {
        CanaryOutcome::NothingToCheck
    } else {
        CanaryOutcome::Pass {
            sessions_checked: checked,
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-sessions amplifier_stub`
Expected: PASS (12 tests in the module).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/amplifier_stub.rs
git commit -m "$(cat <<'EOF'
feat(sessions): amplifier on-disk layout canary (slug contract self-test)

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 6: G-A4 argv golden — Resume intent is load-bearing for amplifier

**Files:**
- Modify: `crates/freshell-platform/src/cli_launch_goldens.rs` (amplifier goldens G-A1/A2/A3 live at `:690-742`; add G-A4 beside them)

**Interfaces:**
- Consumes: the existing golden-test helpers in `cli_launch_goldens.rs` (spec constructors `s(...)`, the resolver entry `resolve_coding_cli_command` or whatever helper the sibling goldens use — copy the exact call shape from G-A1 at `:690`).
- Produces: a pinned regression test other tasks rely on as documentation: amplifier pre-create MUST use `LaunchIntent::Resume`.

- [ ] **Step 1: Write the failing-or-passing pin**

Open `crates/freshell-platform/src/cli_launch_goldens.rs`, find the amplifier golden block (`:690-742`, tests named like `g_a1_...`). Add, using the SAME helper shape as the adjacent goldens (adapt constructor names to what G-A1 actually uses — the assertion payload below is the contract):

```rust
    /// G-A4 (launcher-assigned amplifier identity): the amplifier spec has
    /// resumeArgs ONLY — `LaunchIntent::Start` with a preallocated session id
    /// is a hard StartIntentUnsupported error. The WS/REST pre-create paths
    /// therefore keep `LaunchIntent::Resume` for fresh amplifier panes
    /// (`amplifier resume <uuid>` of the pre-created stub IS the fresh
    /// launch). This golden pins that requirement so a future "make amplifier
    /// look like claude" refactor fails loudly here instead of at runtime.
    #[test]
    fn g_a4_amplifier_start_intent_without_create_session_args_is_rejected() {
        let err = resolve_amplifier_golden_with_intent(
            LaunchIntent::Start,
            Some("11111111-2222-3333-4444-555555555555"),
        )
        .unwrap_err();
        assert!(
            format!("{err:?}").contains("StartIntentUnsupported")
                || format!("{err}").contains("createSessionArgs"),
            "expected StartIntentUnsupported, got: {err:?}"
        );
    }

    /// G-A4b: with Resume intent the SAME inputs resolve to
    /// `amplifier resume <id>` (the manifest resumeArgs template).
    #[test]
    fn g_a4b_amplifier_resume_intent_with_preallocated_id_resolves_resume_argv() {
        let cli = resolve_amplifier_golden_with_intent(
            LaunchIntent::Resume,
            Some("11111111-2222-3333-4444-555555555555"),
        )
        .unwrap();
        assert_eq!(
            cli.args,
            vec!["resume", "11111111-2222-3333-4444-555555555555"]
        );
    }
```

`resolve_amplifier_golden_with_intent` is a small local helper you extract from what G-A1/G-A2 already do (build the amplifier spec + `CliLaunchInputs` with the given `launch_intent`/`resume_session_id`, call the resolver). If G-A2 already covers the resume argv (`amplifier resume <id>`), keep G-A4b anyway — its subject is the *preallocated-fresh* id, and the doc comment is the point.

- [ ] **Step 2: Run to verify**

Run: `cargo test -p freshell-platform g_a4`
Expected: PASS (this pins EXISTING resolver behavior — `cli_launch.rs:431-445` already rejects Start-without-createSessionArgs; if it fails, the resolver has drifted and Task 8's design premise is broken — STOP and report).

- [ ] **Step 3: Run the whole goldens file**

Run: `cargo test -p freshell-platform cli_launch`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-platform/src/cli_launch_goldens.rs
git commit -m "$(cat <<'EOF'
test(platform): G-A4 golden pins Resume-intent requirement for amplifier pre-create

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 7: Same-id double-resume guard — predicates + atomic in-create enforcement

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (predicates near the private session-ref helpers at `:2134-2180`; enforcement inside `create` at `:861` region; tests in the file's existing `#[cfg(test)]` module)

**Interfaces:**
- Consumes: `IdentityProbeRow` and `TerminalRunStatus` (already public in this crate — verify exact paths; `identity_probe_rows()` exists at `registry.rs:1510` region), the keyed-create reservation machinery (`keyed_create_inflight`, documented at `registry.rs:446-452` — verify the current begin/end method names before use).
- Produces:
  ```rust
  pub fn has_live_resume(rows: &[IdentityProbeRow], mode: &str, session_id: &str) -> bool;
  pub fn has_other_live_resume(rows: &[IdentityProbeRow], mode: &str, session_id: &str, excluding_terminal_id: &str) -> bool;
  ```
  (free functions in `freshell_terminal::registry`), plus: `TerminalRegistry::create` returns `io::ErrorKind::AlreadyExists` when an amplifier create carries a `resume_session_id` already held by a live amplifier terminal.

- [ ] **Step 1: Write the failing predicate tests**

In `registry.rs`'s `#[cfg(test)]` module (reuse its existing row-construction helpers if present; otherwise build `IdentityProbeRow` literals):

```rust
    #[test]
    fn has_live_resume_matches_only_running_same_mode_same_id() {
        let rows = vec![
            probe_row("t1", "amplifier", TerminalRunStatus::Running, Some("sid-1")),
            probe_row("t2", "amplifier", TerminalRunStatus::Exited, Some("sid-2")),
            probe_row("t3", "codex", TerminalRunStatus::Running, Some("sid-3")),
        ];
        assert!(has_live_resume(&rows, "amplifier", "sid-1"));
        assert!(!has_live_resume(&rows, "amplifier", "sid-2")); // exited
        assert!(!has_live_resume(&rows, "amplifier", "sid-3")); // other mode
        assert!(!has_live_resume(&rows, "amplifier", "sid-9")); // unknown
    }

    #[test]
    fn has_other_live_resume_excludes_the_named_terminal() {
        let rows = vec![
            probe_row("t1", "amplifier", TerminalRunStatus::Running, Some("sid-1")),
        ];
        assert!(!has_other_live_resume(&rows, "amplifier", "sid-1", "t1")); // only me
        assert!(has_other_live_resume(&rows, "amplifier", "sid-1", "t9")); // someone else
    }
```

`probe_row` is a tiny local helper constructing an `IdentityProbeRow` with the given terminal_id/mode/status/resume id (fill remaining fields with defaults — copy the struct's field list from its definition).

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-terminal has_live_resume`
Expected: COMPILE ERROR — functions not found.

- [ ] **Step 3: Implement the predicates**

Add near the private session-ref helpers (around `registry.rs:2130`):

```rust
/// Same-id double-resume guard (launcher-assigned amplifier identity plan):
/// does any RUNNING terminal of `mode` already carry `session_id` as its
/// resume id? Amplifier has no upstream concurrency guard — two live PTYs
/// resuming one session id would interleave writes into one session dir.
/// Shared here so both the WS create path (`freshell-ws`) and the REST
/// create path (`freshell-freshagent`) apply the identical predicate.
/// NOTE: this is the friendly PRE-CHECK only — the race-free enforcement
/// lives inside [`TerminalRegistry::create`] (validated fix F5).
pub fn has_live_resume(rows: &[IdentityProbeRow], mode: &str, session_id: &str) -> bool {
    rows.iter().any(|row| {
        row.mode == mode
            && row.status == TerminalRunStatus::Running
            && row.resume_session_id.as_deref() == Some(session_id)
    })
}

/// [`has_live_resume`] EXCLUDING one terminal id — the exit-hook stub-GC
/// guard (validated fix F5/V7's GC-vs-second-resume race): "is another live
/// terminal (not me) currently resuming this session id?" Used by both
/// exit hooks before deleting a never-used stub.
pub fn has_other_live_resume(
    rows: &[IdentityProbeRow],
    mode: &str,
    session_id: &str,
    excluding_terminal_id: &str,
) -> bool {
    rows.iter().any(|row| {
        row.terminal_id != excluding_terminal_id
            && row.mode == mode
            && row.status == TerminalRunStatus::Running
            && row.resume_session_id.as_deref() == Some(session_id)
    })
}
```

Adjust visibility paths so `freshell_terminal::registry::has_live_resume` resolves from other crates (re-export from the crate root if the crate's convention is `freshell_terminal::has_live_resume` — mirror how `live_session_owner`'s neighbors are exposed).

- [ ] **Step 4: Write the failing in-create enforcement test**

```rust
    #[test]
    fn amplifier_create_with_duplicate_live_resume_returns_already_exists() {
        // Use the file's existing create-test harness (a registry + a spec
        // that spawns a short-lived command — copy the shape of the nearest
        // existing `create`-path test in this module).
        let registry = test_registry();
        let spec = sleeper_spawn_spec(); // long-lived: stays Running
        registry
            .create(&spec, &test_env(), "term-a".into(), "stream-a".into(),
                    "amplifier", Some("sid-dup"), Some("req-a"), None, None)
            .expect("first create succeeds");
        let err = registry
            .create(&spec, &test_env(), "term-b".into(), "stream-b".into(),
                    "amplifier", Some("sid-dup"), Some("req-b"), None, None)
            .expect_err("second live resume of the same amplifier session must fail");
        assert_eq!(err.kind(), std::io::ErrorKind::AlreadyExists);
    }
```

IMPORTANT: `registry.create`'s real signature is at `registry.rs:861` — copy the exact parameter list and the module's existing test helpers (`test_registry`, spawn-spec builders) rather than the sketch above; the CONTRACT is: two creates, same mode `"amplifier"`, same `resume_session_id`, first still Running ⇒ second returns `ErrorKind::AlreadyExists`.

- [ ] **Step 5: Run to verify failure**

Run: `cargo test -p freshell-terminal amplifier_create_with_duplicate`
Expected: FAIL — second create currently succeeds.

- [ ] **Step 6: Implement the atomic enforcement inside `create`**

Inside `TerminalRegistry::create`, BEFORE the spawn work begins (right after arguments are available), add the block below. IMPORTANT (validated V7 wrinkle — do NOT share the set): WS `handle_create` already claims client-supplied `createRequestId`s in the `keyed_create_inflight` `HashSet` itself (`terminal.rs:1355`), so a client could send a requestId shaped `resume:amplifier:<sid>` and collide with the guard's keys. Add a SIBLING field (`resume_create_inflight: Arc<Mutex<HashSet<String>>>`) with tiny `begin_resume_create`/`end_resume_create` helpers that mirror the `begin_keyed_create`/`end_keyed_create` semantics (`registry.rs:1789`/`:1798`; TOCTOU doc at `:446-452` applies identically):

```rust
        // Duplicate-live-resume enforcement (amplifier identity plan,
        // validated fix F5/V7): the callers' `has_live_resume` pre-check is
        // check-then-act and can race across WS/REST tasks — this registry's
        // own §5.4 doc (keyed_create_inflight) names the exact TOCTOU. Claim
        // a resume-scoped reservation BEFORE the spawn and re-check live
        // rows under it; the row itself is inserted before the reservation
        // is released, so no observable gap remains. Scoped to amplifier:
        // other modes keep their existing create semantics.
        let resume_guard_key = if mode == "amplifier" {
            resume_session_id.map(|sid| format!("resume:{mode}:{sid}"))
        } else {
            None
        };
        if let Some(key) = &resume_guard_key {
            let claimed = self.begin_resume_create(key);
            let duplicate_live = self.identity_probe_rows().iter().any(|row| {
                row.mode == mode
                    && row.status == TerminalRunStatus::Running
                    && row.resume_session_id.as_deref() == resume_session_id
            });
            if !claimed || duplicate_live {
                if claimed {
                    self.end_resume_create(key);
                }
                // Distinguishable error contract consumed by the WS/REST
                // handlers: ErrorKind::AlreadyExists ⇒ "session already
                // open" reject.
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    format!(
                        "duplicate live resume: {mode} session {} is already open in a live terminal",
                        resume_session_id.unwrap_or_default()
                    ),
                ));
            }
        }
```

And release the reservation on BOTH exits: after the row insert succeeds, and on the spawn-failure path:

```rust
        if let Some(key) = &resume_guard_key {
            self.end_resume_create(key);
        }
```

(one copy after the successful insert, one in the error branch that returns the spawn failure). The semantics (claim → re-check → insert row → release; release on failure) are the contract; V7 verified the row insert (`registry.rs:908-917`) strictly precedes any release point in this shape, leaving no observable gap, and that `create`'s existing error space (`io::Result`, OS spawn errors) cannot already produce `AlreadyExists` — the signal is unambiguous. NOTE: `identity_probe_rows()` can include HEADLESS rows (`register_headless` at `registry.rs:1624`, used by `reconcile.rs:405` / `identity.rs:336`); if such a row were ever Running+amplifier+resume-id the guard would reject — conservative (never admits a duplicate), loud, one-click-recoverable. Do not special-case it.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cargo test -p freshell-terminal`
Expected: PASS (new tests + no regressions in the crate).

- [ ] **Step 8: Commit**

```bash
git add crates/freshell-terminal/src/registry.rs
git commit -m "$(cat <<'EOF'
feat(terminal): same-id double-resume guard — predicates + atomic in-create enforcement

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 8: WS launcher-assigned identity — preallocate UUID + pre-create stub before spawn

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (resume derivation block `:1511-1588`; new pre-create block between the argv construction and `registry.create` — see Step 4 for exact placement)
- Modify: `crates/freshell-ws/tests/common/mod.rs` (test-harness `FRESHELL_AMPLIFIER_HOME` isolation)
- Create: `crates/freshell-ws/tests/amplifier_launcher_identity.rs`

**Interfaces:**
- Consumes: `freshell_sessions::amplifier_stub::{resolve_amplifier_home, ensure_session, EnsuredSession}` (Tasks 2-3); `resolve_unix_shell_cwd` from `freshell-platform` path handling (the SAME transformation `build_cli_spawn_spec` applies internally — find its import path via the existing usage in the codebase; it lives in `freshell-platform`'s `path` module, anchor `path.rs:642-665`).
- Produces: fresh WS amplifier creates carry `resume_session_id = Some(<uuid>)` into `registry.create`, `set_meta`, identity upsert, and `terminal.created.sessionRef`; a stub dir exists on disk BEFORE `registry.create`; the local variable `amplifier_stub: Option<EnsuredSession>` that Tasks 9-10 consume in the same function.

- [ ] **Step 1: Isolate the WS test harness**

In `crates/freshell-ws/tests/common/mod.rs`, in `spawn_server_with_specs` (the constructor `spawn_server` delegates to, used by `session_identity_frames.rs` — validation V7 verified every EXISTING amplifier-creating ws test flows through it), add BEFORE anything can reach an amplifier create. CAVEAT (V7): common/mod.rs has several sibling constructors and 17 ws test files build `WsState` inline — none creates amplifier terminals today, but a future one would silently bypass this isolation. Therefore the new test file (Step 2) must ALSO set the var in its own setup (defense in depth), and new amplifier tests must use the common constructors:

```rust
    // Launcher-assigned amplifier identity (F7/V9): tests that create
    // amplifier terminals now WRITE stub dirs into the amplifier home.
    // Isolate eagerly at this choke point so no test ever touches the real
    // ~/.amplifier. set_var is process-global: use ONE shared value per
    // test process.
    let amp_home = std::env::temp_dir().join(format!("freshell-ws-amp-home-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&amp_home);
    std::env::set_var("FRESHELL_AMPLIFIER_HOME", &amp_home);
```

- [ ] **Step 2: Write the failing integration test**

Create `crates/freshell-ws/tests/amplifier_launcher_identity.rs`. Model the harness usage on `crates/freshell-ws/tests/session_identity_frames.rs` (which already spawns amplifier terminals via `common::sleeper_cli_spec("amplifier")` at `common/mod.rs:42,79-91`) — copy its setup/connect/create/read-frame helpers exactly, then assert the NEW contract:

```rust
// Launcher-assigned amplifier identity (kata qmpk): a FRESH amplifier
// terminal.create must (1) mint a server-side session UUID before spawn,
// (2) pre-create the stub dir (metadata.json + empty transcript.jsonl +
// empty events.jsonl) under FRESHELL_AMPLIFIER_HOME/projects/<slug>/sessions/<id>,
// and (3) surface the identity on terminal.created.sessionRef with
// provider "amplifier" — all with zero client-supplied identity.

mod common;

#[tokio::test]
async fn fresh_amplifier_create_carries_launcher_assigned_session_ref_and_stub() {
    // ... harness setup copied from session_identity_frames.rs ...
    // Send terminal.create { mode: "amplifier", cwd: <tmp dir> } with NO
    // sessionRef and NO resumeSessionId.
    // Read the terminal.created frame.

    let session_ref = created["sessionRef"].clone();
    assert_eq!(session_ref["provider"], "amplifier");
    let sid = session_ref["sessionId"].as_str().expect("sessionId set");
    // Server-minted UUID, not a client value.
    assert!(uuid::Uuid::parse_str(sid).is_ok());

    // The stub exists on disk, under the slug of the create cwd.
    let amp_home = std::path::PathBuf::from(std::env::var("FRESHELL_AMPLIFIER_HOME").unwrap());
    let canonical = std::fs::canonicalize(&cwd).unwrap();
    let stub_dir = amp_home
        .join("projects")
        .join(freshell_sessions::amplifier_stub::cwd_slug(&canonical.to_string_lossy()))
        .join("sessions")
        .join(sid);
    assert!(stub_dir.join("metadata.json").is_file());
    assert_eq!(std::fs::metadata(stub_dir.join("transcript.jsonl")).unwrap().len(), 0);
    assert_eq!(std::fs::metadata(stub_dir.join("events.jsonl")).unwrap().len(), 0);
    let meta: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(stub_dir.join("metadata.json")).unwrap(),
    ).unwrap();
    assert_eq!(meta["session_id"], sid);
    assert!(meta.get("bundle").is_none());
}
```

Fill the elided harness plumbing from the sibling test file — the assertions above are the contract. Add `uuid` to `freshell-ws`'s dev-dependencies if not already available (it is a normal dependency of the crate — check `Cargo.toml`).

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p freshell-ws --test amplifier_launcher_identity`
Expected: FAIL — `terminal.created` has no `sessionRef` for a fresh amplifier pane (today identity arrives only post-spawn via the locator).

- [ ] **Step 4: Implement — preallocation + effective-cwd + stub pre-create**

**(a) Preallocation** — in the resume-derivation block (`terminal.rs:1511-1588`), directly after the fresh-claude branch (`:1519-1532`), extend the ladder:

```rust
        // Launcher-assigned amplifier identity (kata qmpk), the fresh-claude
        // preallocation's sibling: a FRESH amplifier pane gets a
        // server-minted session id, and (below, once `terminal_id` exists)
        // a pre-created stub dir — `amplifier resume <uuid>` of that stub
        // IS the fresh launch. CRITICAL: `launch_intent` STAYS `Resume` —
        // amplifier's manifest has resumeArgs only; `Start` without
        // createSessionArgs is a hard StartIntentUnsupported error
        // (cli_launch.rs:431-445; pinned by golden G-A4).
        let should_preallocate_fresh_amplifier = mode == "amplifier"
            && create.restore != Some(true)
            && create.session_ref.is_none()
            && create
                .resume_session_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .is_none();
```

and in the if/else chain:

```rust
        } else if should_preallocate_fresh_amplifier {
            resume_session_id = Some(Uuid::new_v4().to_string());
        } else {
```

(Do NOT touch `launch_intent` — it stays `LaunchIntent::Resume` from its initializer.)

**(b) Effective-cwd + stub pre-create** — insert a new block AFTER the D7 liveness guard region (`:1590-1657`) and BEFORE the `CliLaunchInputs` construction (`:1747-1760`), i.e. before any spawn-spec/env work consumes the cwd, and definitely before `registry.create` (`:1868-1884`). The block computes ONE effective cwd, validates it, ensures the stub, and assigns the cwd back into the variable the spawn-spec construction reads (the cwd variable feeding `build_cli_spawn_spec` — at this anchor it is the result of `resolve_create_cwd` at `:1501-1509`; call it `resolved_cwd` below and adapt to the real variable name):

```rust
    // Amplifier pre-create (kata qmpk): make `amplifier resume <id>`
    // guaranteed-resumable BEFORE spawn. Fresh creates get a brand-new stub;
    // requested resumes whose dir is gone (e.g. a GC'd never-used stub from
    // a previous run) are re-stubbed under the SAME id so restore keeps
    // working; existing sessions are found and left untouched.
    // ORDERING IS LOAD-BEARING: the stub — including events.jsonl — must be
    // written BEFORE registry.create, because the activity events-lane
    // resolver attaches at create time and requires events.jsonl to exist.
    // HARD INVARIANT (validated fix F4): ONE effective spawn cwd. The stub
    // slug is computed from the SAME final value the spawn spec receives —
    // run through the SAME launch-cwd transformation build_cli_spawn_spec
    // applies internally (resolve_unix_shell_cwd: e.g. on WSL a
    // Windows-shaped `C:\...` cwd becomes `/mnt/c/...`; slugging the raw
    // pre-conversion value would place the stub where the CLI never looks),
    // existence-validated, then assigned back so the spawn-spec construction
    // below uses it (re-resolution is idempotent: an absolute unix path
    // passes through resolve_unix_shell_cwd unchanged).
    let mut amplifier_stub: Option<freshell_sessions::amplifier_stub::EnsuredSession> = None;
    if mode == "amplifier" {
        // A10/B1 guard (validated falsification — see the ledger): a
        // client-supplied `shell` can route the spawn to
        // build_windows_cli_spawn_spec (the `is_windows(host_os) || (is_wsl
        // && effective_shell != System)` branch this file evaluates at the
        // spawn-spec construction below — mirror that EXACT predicate and
        // its variable names here), whose cwd handling is a DIFFERENT
        // transformation than the one the stub slug is computed from.
        // Reject that arm for amplifier instead of pre-creating a stub the
        // spawn would silently diverge from. (Native-Windows amplifier was
        // already unsupported on this path: resolve_amplifier_home() is
        // HOME-based and the CLI stores sessions under a unix home.)
        if would_take_windows_cli_arm {
            return send_create_error(
                ws_tx,
                ErrorCode::PtySpawnFailed,
                "Amplifier terminals require the default system shell on a unix host (cwd is part of the session identity contract).".to_string(),
                &create.request_id,
            )
            .await;
        }
        if let Some(session_id) = resume_session_id.as_deref() {
            let Some(mut effective_cwd) =
                resolve_unix_shell_cwd(resolved_cwd.as_deref(), &RealEnv, is_wsl)
            else {
                return send_create_error(
                    ws_tx,
                    ErrorCode::PtySpawnFailed,
                    "Amplifier requires a resolvable working directory (cwd is part of the session identity contract).".to_string(),
                    &create.request_id,
                )
                .await;
            };
            if !std::path::Path::new(&effective_cwd).is_dir() {
                // Reject a vanished/bogus dir instead of letting
                // canonical_cwd fall back to the raw path — a stub under
                // slug(<gone dir>) plus the PTY layer's cwd-less spawn retry
                // (inherits the BROKER's cwd) is a silently doomed resume.
                return send_create_error(
                    ws_tx,
                    ErrorCode::PtySpawnFailed,
                    format!("Amplifier working directory '{effective_cwd}' does not exist."),
                    &create.request_id,
                )
                .await;
            }
            let ensured = freshell_sessions::amplifier_stub::resolve_amplifier_home()
                .ok_or_else(|| "amplifier home unresolvable (no FRESHELL_AMPLIFIER_HOME and no HOME)".to_string())
                .and_then(|amp_home| {
                    freshell_sessions::amplifier_stub::ensure_session(
                        &amp_home,
                        session_id,
                        &effective_cwd,
                        &terminal_id,
                    )
                    .map_err(|e| e.to_string())
                });
            match ensured {
                Ok(ensured) => {
                    // Requested resume FOUND under a different slug than
                    // slug(effective_cwd) (F4): cwd is part of amplifier's
                    // identity contract — resuming from elsewhere finds
                    // nothing. Spawn at the session's own working_dir, or
                    // reject loudly if it no longer exists.
                    if ensured.found_under_divergent_slug {
                        match ensured
                            .working_dir_of_existing
                            .as_deref()
                            .filter(|d| std::path::Path::new(d).is_dir())
                        {
                            Some(existing_dir) => effective_cwd = existing_dir.to_string(),
                            None => {
                                return send_create_error(
                                    ws_tx,
                                    ErrorCode::PtySpawnFailed,
                                    format!(
                                        "Amplifier session {session_id} was created in {}, which no longer exists.",
                                        ensured
                                            .working_dir_of_existing
                                            .as_deref()
                                            .unwrap_or("an unknown directory")
                                    ),
                                    &create.request_id,
                                )
                                .await;
                            }
                        }
                    }
                    // CRITICAL (F4): hand the SAME value to the spawn spec.
                    resolved_cwd = Some(effective_cwd);
                    amplifier_stub = Some(ensured);
                }
                Err(detail) => {
                    // Fail LOUD: spawning `amplifier resume <id>` without a
                    // resumable dir would hang a doomed CLI (the exact
                    // failure mode this feature deletes).
                    return send_create_error(
                        ws_tx,
                        ErrorCode::PtySpawnFailed,
                        format!("Failed to pre-create amplifier session {session_id}: {detail}"),
                        &create.request_id,
                    )
                    .await;
                }
            }
        }
    }
```

Placement notes (verify against the live file):
- `terminal_id` must already be minted at this point (it is — the exit-hook construction at `:1828` uses it; if the id is minted later than the D7 region, place this block right after the mint instead — the only hard ordering constraints are: after the final `resume_session_id` derivation, before `CliLaunchInputs`/spawn-spec cwd consumption, before `registry.create`).
- `resolve_unix_shell_cwd`, `RealEnv`, `is_wsl`: mirror the exact import/usage pattern the spawn-spec construction in this file already uses (search the file for `resolve_unix_shell_cwd` or `build_cli_spawn_spec`'s cwd handling); if `handle_create` has no `is_wsl` local, hoist the same expression `build_cli_spawn_spec` uses.
- `would_take_windows_cli_arm` is a stand-in: reuse the SAME branch condition the spawn-spec construction evaluates (around `terminal.rs:1789`/`:1794`, `is_windows(host_os) || (is_wsl && effective_shell != …System…)`) — hoist it into a local evaluated once and use that local in BOTH places so the guard and the spawn can never disagree.
- Ledger sanity check: with `resume_session_id` now `Some(...)` for fresh amplifier panes, the create's pane-ledger branch (`:2054-2106`) must take the `record_binding` path, not the `MARKER_MODES` `record_pending` path (`:2091-2106`). Read that branch: the binding path is selected by `terminal_meta_record_for_create(...)` returning `Some` (it receives `resume_session_id`, `:2032-2038`), so this holds by construction — confirm, don't change `MARKER_MODES`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p freshell-ws --test amplifier_launcher_identity && cargo test -p freshell-ws`
Expected: new test PASSES; whole crate green. Existing tests that spawn fresh amplifier panes (`claude_restore_unavailable.rs:124`, `restore_spawn_gate.rs:123`, `session_identity_frames.rs:40,56`) now exercise the new path — if any assert "no sessionRef for fresh amplifier", update THOSE assertions to the new contract (sessionRef present).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/
git commit -m "$(cat <<'EOF'
feat(ws): launcher-assigned amplifier session identity — preallocate uuid + pre-create stub before spawn

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 9: WS guards — reject `terminal:` placeholder refs + same-id double resume

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (inside the Task-8 amplifier block region; plus the `registry.create` error handling at `:1868-1892`)
- Modify: `crates/freshell-ws/tests/amplifier_launcher_identity.rs`

**Interfaces:**
- Consumes: `freshell_terminal::registry::has_live_resume` (Task 7); the `ErrorKind::AlreadyExists` contract from `TerminalRegistry::create` (Task 7); `amplifier_stub` local from Task 8.
- Produces: two loud WS create rejections (both via the existing `send_create_error` + `ErrorCode::PtySpawnFailed` plumbing).

- [ ] **Step 1: Write the failing tests**

Add to `crates/freshell-ws/tests/amplifier_launcher_identity.rs` (same harness as Task 8):

```rust
#[tokio::test]
async fn amplifier_create_rejects_synthetic_terminal_placeholder_refs() {
    // terminal.create { mode: "amplifier", sessionRef: { provider: "amplifier",
    //   sessionId: "terminal:abc123" } }
    // Expect an error frame (not terminal.created) whose message contains
    // "synthetic terminal placeholder".
}

#[tokio::test]
async fn amplifier_create_rejects_second_live_resume_of_same_session() {
    // 1) Fresh amplifier create → read sessionRef.sessionId (sid).
    // 2) Second create { mode: "amplifier", sessionRef: { provider:
    //    "amplifier", sessionId: sid } } while the first is still running.
    // Expect an error frame whose message contains "already open in a live
    // terminal".
}
```

Fill in the frame plumbing from the Task-8 test.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-ws --test amplifier_launcher_identity`
Expected: the two new tests FAIL (both creates currently succeed / spawn).

- [ ] **Step 3: Implement the guards**

At the TOP of the Task-8 `if mode == "amplifier"` block (before the effective-cwd work), evaluated on the FINAL derived resume id so both `sessionRef` and legacy `resumeSessionId` carriers are covered:

```rust
    // Amplifier identity hardening (kata qmpk) — sequential, complementary
    // to the cross-mode D7 liveness guard above (PR #540): D7 rejects
    // cross-terminal session theft generically; these two are
    // amplifier-specific input hygiene.
    if mode == "amplifier" {
        if resume_session_id
            .as_deref()
            .is_some_and(|s| s.starts_with("terminal:"))
        {
            // Defense-in-depth against the old correlation bug's poisoned
            // persisted tab state: `terminal:<id>` is Freshell's own
            // synthetic sidebar placeholder, never a resumable amplifier
            // session — a resume of it hangs forever.
            let poisoned = resume_session_id.clone().unwrap_or_default();
            return send_create_error(
                ws_tx,
                ErrorCode::PtySpawnFailed,
                format!(
                    "Invalid amplifier sessionRef '{poisoned}': synthetic terminal placeholder ids are not resumable sessions."
                ),
                &create.request_id,
            )
            .await;
        }
        if let Some(requested) = resume_session_id.as_deref() {
            // Same-id double-resume guard: amplifier has no upstream
            // concurrency guard — never spawn two live PTYs resuming one
            // session id. (Preallocated fresh UUIDs never collide.)
            // Friendly fast-path only; race-free enforcement lives inside
            // TerminalRegistry::create (Task 7).
            if freshell_terminal::registry::has_live_resume(
                &state.registry.identity_probe_rows(),
                "amplifier",
                requested,
            ) {
                return send_create_error(
                    ws_tx,
                    ErrorCode::PtySpawnFailed,
                    format!("Amplifier session {requested} is already open in a live terminal."),
                    &create.request_id,
                )
                .await;
            }
        }
    }
```

Then in the `registry.create` error branch (`:1868-1892`, where `create_result`'s `Err(err)` is handled), add FIRST in that branch (before any other failure handling — ordering is load-bearing for Task 10's GC):

```rust
        // Task 7's race-free duplicate-live-resume enforcement inside
        // registry.create (F5/V7): the pre-check above is a friendly fast
        // path only — concurrent WS/REST creates can both pass it. Map the
        // registry's distinguishable error to the SAME user-facing reject.
        // ORDER IS LOAD-BEARING: this early-return must precede the stub GC
        // in this failure branch (Task 10). `ensure_session` itself is not
        // serialized, so two truly concurrent creates of one id can BOTH
        // observe "no dir yet" and race the mkdir — the LOSER here can hold
        // `created == true` while the WINNER's live terminal is already
        // using the dir; GC'ing it here would delete the winner's session
        // out from under it.
        if err.kind() == std::io::ErrorKind::AlreadyExists {
            return send_create_error(
                ws_tx,
                ErrorCode::PtySpawnFailed,
                format!(
                    "Amplifier session {} is already open in a live terminal.",
                    resume_session_id.as_deref().unwrap_or_default()
                ),
                &create.request_id,
            )
            .await;
        }
```

Check the dedupe contract: every early-return added in Tasks 8-9 sits on a non-settled exit path — confirm the dispatcher-level `clear_if_in_flight()` (`terminal.rs:598`) covers returns from `handle_create` (it does — it wraps the handler; do not add per-return dedupe calls).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws --test amplifier_launcher_identity && cargo test -p freshell-ws`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/amplifier_launcher_identity.rs
git commit -m "$(cat <<'EOF'
feat(ws): reject terminal:-poisoned amplifier refs and guard same-id double resume

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 10: GC never-used stubs — through the shared exit-hook contract at BOTH call sites, plus spawn-failure cleanup and respawn ensure

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (`ExitHookDeps` `:1208-1237`; `build_pty_exit_hook` `:1239-1303`; call site 1 `:1828-1844`; call site 2 in `respawn_agent_terminal` `:2391-2406`; spawn-failure branch `:1868-1892`)
- Modify: `crates/freshell-ws/tests/amplifier_launcher_identity.rs`

**Interfaces:**
- Consumes: `gc_stub_if_unused` (Task 4), `ensure_session` (Task 3), `has_other_live_resume` (Task 7), `amplifier_stub` local (Task 8).
- Produces: new `ExitHookDeps` field:
  ```rust
  pub(crate) struct AmplifierStubGc {
      pub session_dir: std::path::PathBuf,
      pub session_id: String,
  }
  // on ExitHookDeps:
  pub amplifier_stub_gc: Option<AmplifierStubGc>,
  ```
  populated at BOTH call sites; GC-on-exit, GC-on-spawn-failure, and ensure-on-respawn behavior.

- [ ] **Step 1: Write the failing tests**

Add to `crates/freshell-ws/tests/amplifier_launcher_identity.rs`:

```rust
#[tokio::test]
async fn never_used_stub_is_gcd_when_the_terminal_exits() {
    // 1) Fresh amplifier create (fake CLI from common harness exits quickly,
    //    or kill the terminal via the existing kill/close message the
    //    harness supports) → capture sid + stub_dir (as in Task 8's test).
    // 2) Terminate the terminal; wait for terminal.exit.
    // 3) Poll (bounded, e.g. 2s) until the stub dir is GONE.
    // assert!(!stub_dir.exists());
}

#[tokio::test]
async fn used_stub_survives_terminal_exit() {
    // Same as above, but before terminating, write a prompt:submit line into
    // the stub's events.jsonl (simulating "the user typed"):
    // std::fs::write(stub_dir.join("events.jsonl"), "{\"event\":\"prompt:submit\"}\n")
    // After exit, the dir must STILL exist.
}

#[tokio::test]
async fn resume_of_a_gcd_stub_is_restubbed_under_the_same_id() {
    // Ensure-after-GC (restore keeps working): create → exit → stub GC'd,
    // then create AGAIN with sessionRef {provider:"amplifier", sessionId: sid}.
    // Expect terminal.created with the SAME sid and the stub dir re-created.
}
```

Fill plumbing from the Task-8 test; the assertions are the contract.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-ws --test amplifier_launcher_identity`
Expected: `never_used_stub_is_gcd_when_the_terminal_exits` FAILS (dir survives); `resume_of_a_gcd_stub_is_restubbed...` may already pass via Task 8's ensure — keep it as the pin.

- [ ] **Step 3: Implement**

**(a)** Add the struct + field to `ExitHookDeps` (`:1208-1237`):

```rust
/// Launcher-assigned amplifier identity: the stub this terminal's create
/// pre-wrote (only when `EnsuredSession.created == true` — the broker only
/// GCs litter it wrote itself). Threaded through the SHARED exit-hook
/// contract so handle_create AND the auto-resume respawn seam behave
/// identically (kata qmpk).
pub(crate) struct AmplifierStubGc {
    pub session_dir: std::path::PathBuf,
    pub session_id: String,
}
```

and on `ExitHookDeps`: `pub amplifier_stub_gc: Option<AmplifierStubGc>,`.

**(b)** In `build_pty_exit_hook`'s closure (after the locator disarms at `:1601-1609` — or wherever they are after Task 12; position within the hook is not order-sensitive relative to the disarms, but MUST run after `finish_pty_exit` so our own row is no longer Running):

```rust
        if let Some(gc) = &deps.amplifier_stub_gc {
            // GC-vs-second-resume race (validated fix F5/V7): by the time
            // this hook runs, our own row is already Exited (or removed by
            // kill) — a NEW terminal may already be live on this same resume
            // id, and deleting the dir out from under it would doom its
            // resume. Skip GC in that case; the new terminal's own exit hook
            // is not responsible either (`created == false` for it), which
            // is correct: the dir is in use.
            // ACCEPTED RESIDUAL: this guard reads registry rows, so a
            // concurrent re-resume that has already passed `ensure_session`
            // (found our stub) but has NOT yet inserted its registry row is
            // invisible here — its dir can be GC'd in that sub-second window
            // and its `amplifier resume <id>` then fails LOUDLY in-terminal;
            // reopening the pane re-stubs the same id (ensure-after-GC).
            if freshell_terminal::registry::has_other_live_resume(
                &deps.registry.identity_probe_rows(),
                "amplifier",
                &gc.session_id,
                &terminal_id,
            ) {
                tracing::debug!(
                    terminal_id = %terminal_id,
                    session_id = %gc.session_id,
                    "amplifier_stub_gc: skipped — another live terminal holds this resume id"
                );
            } else if freshell_sessions::amplifier_stub::gc_stub_if_unused(&gc.session_dir) {
                tracing::debug!(
                    terminal_id = %terminal_id,
                    dir = %gc.session_dir.display(),
                    "amplifier_stub_gc: removed never-used pre-created session"
                );
            }
        }
```

**(c)** Call site 1 (`handle_create`, `:1828-1844`): populate from Task 8's local —

```rust
            amplifier_stub_gc: amplifier_stub
                .as_ref()
                .filter(|s| s.created)
                .zip(resume_session_id.as_ref())
                .map(|(s, sid)| AmplifierStubGc {
                    session_dir: s.session_dir.clone(),
                    session_id: sid.clone(),
                }),
```

**(d)** Call site 2 (`respawn_agent_terminal`, `:2391-2406`): the respawn seam resumes `req.session_id` unconditionally (`:2278-2279`). Before building the exit hook / spawn spec, ensure the session dir (ensure-after-GC for respawn: a crashed never-used pane's stub may have been GC'd by its own exit hook a moment before auto-resume fires):

```rust
    // Launcher-assigned amplifier identity: a respawn resumes req.session_id
    // unconditionally — make that resume guaranteed-resumable first
    // (ensure-after-GC; existing/used sessions are found and left
    // untouched). Best-effort: a failure here must not veto the respawn —
    // the CLI itself will fail loudly in-terminal if the dir is truly gone.
    let mut respawn_amplifier_stub_gc: Option<AmplifierStubGc> = None;
    if req.mode == "amplifier" {
        if let (Some(amp_home), Some(cwd)) = (
            freshell_sessions::amplifier_stub::resolve_amplifier_home(),
            req.cwd.as_deref().filter(|c| std::path::Path::new(c).is_dir()),
        ) {
            match freshell_sessions::amplifier_stub::ensure_session(
                &amp_home,
                &req.session_id,
                cwd,
                &terminal_id,
            ) {
                Ok(ensured) if ensured.created => {
                    respawn_amplifier_stub_gc = Some(AmplifierStubGc {
                        session_dir: ensured.session_dir,
                        session_id: req.session_id.clone(),
                    });
                }
                Ok(_) => {}
                Err(err) => tracing::warn!(
                    terminal_id = %terminal_id,
                    session_id = %req.session_id,
                    error = %err,
                    "amplifier respawn ensure_session failed; respawning anyway"
                ),
            }
        }
    }
```

and set `amplifier_stub_gc: respawn_amplifier_stub_gc,` in that call site's `ExitHookDeps`.

**(e)** Spawn-failure cleanup — in `handle_create`'s `registry.create` `Err` branch, AFTER Task 9's `AlreadyExists` early-return (ordering load-bearing, see Task 9's comment):

```rust
        // A stub written for a spawn that never happened is pure litter.
        if let Some(stub) = amplifier_stub.as_ref().filter(|s| s.created) {
            let _ = freshell_sessions::amplifier_stub::gc_stub_if_unused(&stub.session_dir);
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws --test amplifier_launcher_identity && cargo test -p freshell-ws`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/amplifier_launcher_identity.rs
git commit -m "$(cat <<'EOF'
feat(ws): GC never-used amplifier stubs via the shared exit-hook contract at both call sites

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 11: REST + split share the launcher-assigned pre-create

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (`spawn_terminal_pane` `:673-895`; `settle_gated_create` `:924-1409`; the REST exit hook `:1149-1180`; test module `:1886+`, incl. rewriting `create_amplifier_tab_fresh_spawns_recorded_argv_with_no_resume_and_arms_locator` at `:2775`)

**Interfaces:**
- Consumes: everything Tasks 2-4 + 7 produce; `derive_resume_identity` (`:493`); `fail_json`, `StatusCode` (existing in the file).
- Produces: REST `POST /api/tabs`, `POST /api/panes/:id/split`, and `/respawn` (all funnel through `spawn_terminal_pane`) mint + pre-create amplifier identity; REST guards return 400 (placeholder ref / bad cwd) and 409 (double resume); REST exit hook GCs never-used stubs.

- [ ] **Step 1: Isolate the freshagent test harness**

In the test module's shared state constructor (`state_with_registry()` — anchor `:1886+`), add the same `FRESHELL_AMPLIFIER_HOME` isolation as Task 8 Step 1 (temp dir + `set_var`), so every REST test that can reach an amplifier create is sandboxed.

- [ ] **Step 2: Write the failing tests**

In the test module, REWRITE `create_amplifier_tab_fresh_spawns_recorded_argv_with_no_resume_and_arms_locator` (`:2775` — its whole point was the locator arm) into the new contract, and add guard tests:

```rust
    #[tokio::test]
    async fn create_amplifier_tab_fresh_mints_identity_prestubs_and_spawns_resume_argv() {
        // Same harness as the old test (recorded-argv registry), body
        // { mode: "amplifier", cwd: <tmp dir> } with no sessionRef.
        // Assert:
        // 1) recorded argv == ["amplifier", "resume", <uuid>] (parse the
        //    third element as a Uuid).
        // 2) the stub dir exists under
        //    $FRESHELL_AMPLIFIER_HOME/projects/<cwd_slug(canonical cwd)>/sessions/<uuid>
        //    with metadata.json + empty transcript.jsonl + empty events.jsonl.
        // 3) the response paneContent carries
        //    sessionRef == { provider: "amplifier", sessionId: <uuid> }
        //    (the EDEV-07 promotion at :1380-1389 — uuids pass
        //    plausible_resume_session_id for amplifier).
    }

    #[tokio::test]
    async fn create_amplifier_tab_rejects_terminal_placeholder_ref_with_400() {
        // body sessionRef { provider: "amplifier", sessionId: "terminal:abc" }
        // → StatusCode::BAD_REQUEST, message contains "synthetic terminal placeholder".
    }

    #[tokio::test]
    async fn create_amplifier_tab_rejects_duplicate_live_resume_with_409() {
        // First create (fresh) → sid; second create with sessionRef
        // { provider: "amplifier", sessionId: sid } while the first pane's
        // recorded terminal is Running → StatusCode::CONFLICT, message
        // contains "already open in a live terminal".
    }

    #[tokio::test]
    async fn create_amplifier_tab_with_no_cwd_stubs_under_home_slug() {
        // F4 falsified-path fix: body with NO cwd. Assert the stub lands
        // under cwd_slug(canonical($HOME)) — never under the broker's own
        // cwd — and the registry row's cwd is $HOME (not None).
    }
```

Copy harness details (request builder, recorded-argv assertions) from the OLD test before deleting its body — it shows exactly how this module fakes spawns.

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p freshell-freshagent amplifier`
Expected: the four tests FAIL (no identity is minted on REST today).

- [ ] **Step 4: Implement**

All inside `spawn_terminal_pane` / `settle_gated_create`, composed with the existing order (mode allowlist → registry wired → body read → createRequestId → cwd `is_dir` check `:727-734` → `derive_resume_identity` `:736` → D7 `:738-775` → D8 lease `:777-825` → spawn gate `:827-856` → detach). Insert the amplifier block between `derive_resume_identity` and the D7 guard:

```rust
    // Launcher-assigned amplifier identity (kata qmpk) — REST twin of the WS
    // block in freshell-ws/src/terminal.rs. Sequential with (not replacing)
    // the D7 liveness guard below and the PR #559 spawn gate.
    let mut amplifier_stub: Option<freshell_sessions::amplifier_stub::EnsuredSession> = None;
    let mut amplifier_effective_cwd: Option<String> = None;
    if mode == "amplifier" {
        // A10/B1 guard — REST twin of the WS windows-arm reject: mirror the
        // EXACT branch condition this file's spawn-spec construction
        // evaluates (around terminal_tabs.rs:1111/:1116) via a hoisted local
        // so guard and spawn can never disagree.
        if would_take_windows_cli_arm {
            return Err(fail_json(
                StatusCode::BAD_REQUEST,
                "Amplifier terminals require the default system shell on a unix host (cwd is part of the session identity contract).".to_string(),
            ));
        }
        if resume_session_id
            .as_deref()
            .is_some_and(|s| s.starts_with("terminal:"))
        {
            return Err(fail_json(
                StatusCode::BAD_REQUEST,
                format!(
                    "Invalid amplifier sessionRef '{}': synthetic terminal placeholder ids are not resumable sessions.",
                    resume_session_id.as_deref().unwrap_or_default()
                ),
            ));
        }
        let is_restore = body.get("restore").and_then(Value::as_bool) == Some(true);
        if resume_session_id.as_deref().filter(|s| !s.is_empty()).is_none() && !is_restore {
            resume_session_id = Some(Uuid::new_v4().to_string());
        }
        if let Some(requested) = resume_session_id.as_deref() {
            // Friendly pre-check; race-free enforcement is inside
            // TerminalRegistry::create (Task 7) and mapped to 409 below.
            if freshell_terminal::registry::has_live_resume(
                &state.registry_or_bail()?.identity_probe_rows(),
                "amplifier",
                requested,
            ) {
                return Err(fail_json(
                    StatusCode::CONFLICT,
                    format!("Amplifier session {requested} is already open in a live terminal."),
                ));
            }
            // ONE effective spawn cwd (F4). The falsified path this closes:
            // cwd=None used to flow into build_cli_spawn_spec → spec.cwd =
            // None → the PTY inherited the BROKER's own cwd while the stub
            // sat under slug($HOME) — silent divergence. Compute the
            // effective cwd ONCE (explicit validated cwd, else $HOME),
            // verify it is a dir, slug the stub from it, and assign it back
            // so the spawn plumbing receives the SAME value.
            let raw_effective_cwd = match cwd
                .clone()
                .or_else(|| std::env::var("HOME").ok().filter(|v| !v.is_empty()))
            {
                Some(c) => c,
                None => {
                    return Err(fail_json(
                        StatusCode::BAD_REQUEST,
                        "Amplifier requires a resolvable working directory (cwd is part of the session identity contract).".to_string(),
                    ));
                }
            };
            // A10/B2 guard (validated falsification): REST's is_dir check
            // ADMITS relative paths, but build_cli_spawn_spec resolves a
            // relative cwd to None (resolve_unix_shell_cwd) and the PTY then
            // inherits the BROKER's cwd while the stub slugs the
            // canonicalized path — silent divergence. Run the SAME
            // transformation the spawn layer applies (idempotent for
            // absolute unix paths) and reject what it cannot represent.
            let Some(mut effective_cwd) =
                resolve_unix_shell_cwd(Some(raw_effective_cwd.as_str()), &RealEnv, is_wsl)
            else {
                return Err(fail_json(
                    StatusCode::BAD_REQUEST,
                    format!(
                        "Amplifier working directory \"{raw_effective_cwd}\" must be an absolute path."
                    ),
                ));
            };
            if !std::path::Path::new(&effective_cwd).is_dir() {
                return Err(fail_json(
                    StatusCode::BAD_REQUEST,
                    format!("Amplifier working directory \"{effective_cwd}\" does not exist."),
                ));
            }
            let ensured = freshell_sessions::amplifier_stub::resolve_amplifier_home()
                .ok_or_else(|| "amplifier home unresolvable (no FRESHELL_AMPLIFIER_HOME and no HOME)".to_string())
                .and_then(|amp_home| {
                    freshell_sessions::amplifier_stub::ensure_session(
                        &amp_home,
                        requested,
                        &effective_cwd,
                        // terminal_id is minted later in settle_gated_create
                        // (:946); the stub's freshell_terminal_id is a
                        // durable-linkage bonus, not a key — record the
                        // createRequestId instead.
                        &create_request_id,
                    )
                    .map_err(|e| e.to_string())
                });
            match ensured {
                Ok(ensured) => {
                    if ensured.found_under_divergent_slug {
                        match ensured
                            .working_dir_of_existing
                            .as_deref()
                            .filter(|d| std::path::Path::new(d).is_dir())
                        {
                            Some(existing_dir) => effective_cwd = existing_dir.to_string(),
                            None => {
                                return Err(fail_json(
                                    StatusCode::BAD_REQUEST,
                                    format!(
                                        "Amplifier session {requested} was created in {}, which no longer exists.",
                                        ensured.working_dir_of_existing.as_deref().unwrap_or("an unknown directory")
                                    ),
                                ));
                            }
                        }
                    }
                    // CRITICAL (F4): the registry row and build_cli_spawn_spec
                    // must receive the effective cwd, never None.
                    cwd = Some(effective_cwd.clone());
                    amplifier_effective_cwd = Some(effective_cwd);
                    amplifier_stub = Some(ensured);
                }
                Err(detail) => {
                    return Err(fail_json(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        format!("Failed to pre-create amplifier session {requested}: {detail}"),
                    ));
                }
            }
        }
    }
```

Adaptation notes (the implementer MUST reconcile with the live code, not paste blind):
- The exact variable names (`cwd`, `resume_session_id`, `create_request_id`, `state.registry...`) come from the surrounding function — reuse them. `registry_or_bail()` stands for however this function already accesses the registry (it checks "registry wired?" at `:698-703`).
- `would_take_windows_cli_arm` / `resolve_unix_shell_cwd` / `RealEnv` / `is_wsl`: hoist the SAME expressions this file's spawn-spec construction already evaluates (`is_wsl` around `:960`/`:981`; the windows-arm branch condition around `:1111`/`:1116`) into locals computed once, and use those locals in both the guard and the spawn — mirroring Task 8's WS pattern.
- Ordering trade-off (deliberate): the stub is written BEFORE the spawn gate acquire (`:827-856`). A gate rejection therefore leaves a fresh stub — add to the gate's `Err` branch, right before `return Err(spawn_gate_error_response(err))`:
  ```rust
              if let Some(stub) = amplifier_stub.as_ref().filter(|s| s.created) {
                  // A stub written for a spawn that never happened is litter.
                  let _ = freshell_sessions::amplifier_stub::gc_stub_if_unused(&stub.session_dir);
              }
  ```
  (Placing the stub write before the detach point keeps all client-visible 4xx synchronous; the alternative — writing inside `settle_gated_create` — cannot return clean 400s.)
- Thread `amplifier_stub` (the `EnsuredSession`) into `GatedSettleInputs` (`:901`) so `settle_gated_create` can (a) GC it on spawn failure — same two lines as above, placed AFTER an `ErrorKind::AlreadyExists` check that maps the registry error to the pane-failure surface this detached path already uses (mirror how it reports other spawn errors; ordering per Task 9's comment) — and (b) build the REST exit hook.
- REST exit hook (`:1149-1180`): add the same GC block as Task 10 Step 3(b) (guarded by `has_other_live_resume`, keyed on the settled `terminal_id`), driven by an `Option<(PathBuf, String)>` captured from `amplifier_stub.filter(created) + resume_session_id`.
- Split path: `pane_ops.rs:89 split_pane` calls `spawn_terminal_pane` (`pane_ops.rs:155-160`) — it inherits everything for free. Do NOT add anything to `pane_ops.rs`.
- The old locator arm at `settle_gated_create` `:1299-1305` / `arm_locators_for_fresh_pane` `:460-479` still exists until Task 12; with a resume id now always present for fresh amplifier panes, `AmplifierLocator::arm` returns `false` by its own gate (`amplifier_locator.rs:238-240`) — leave it alone here.
- The `tab_create_missing_session_identity` WARN (`:1489-1502`) fires only when neither sessionRef nor resumeSessionId is in the payload; verify whether the payload echoed to `ui.command` now carries the minted identity (via the EDEV-07 promotion) — if the WARN still fires for fresh amplifier creates in the new test's logs, thread the minted sessionRef into that payload the same way the promotion does.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p freshell-freshagent`
Expected: PASS (4 new/rewritten tests; no regressions).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "$(cat <<'EOF'
feat(freshagent): REST/split amplifier creates share launcher-assigned identity pre-create

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 12: Delete the correlation-window path; re-home the identity invariant sweep

**Files:**
- Delete: `crates/freshell-sessions/src/amplifier_locator.rs` (1047 lines)
- Delete: `crates/freshell-ws/src/amplifier_association.rs` (539 lines)
- Modify: `crates/freshell-sessions/src/lib.rs` (drop `pub mod amplifier_locator;` at `:18`)
- Modify: `crates/freshell-ws/src/lib.rs` (drop `pub mod amplifier_association;` at `:24`; drop `amplifier_locator` field at `:245-246` and literal at `:810`)
- Modify: `crates/freshell-ws/src/invariants.rs` (`:33-51` constant; new sweep spawner)
- Modify: `crates/freshell-ws/src/terminal.rs` (ExitHookDeps field + disarm `:1220-1225`/`:1276-1278`; `maybe_arm` calls `:1963`, `:2510`; `note_possible_submit` `:640-644`; both ExitHookDeps literals)
- Modify: `crates/freshell-ws/src/activity.rs` (`attach_amplifier_association` `:230-241` → `#[cfg(test)]`)
- Modify: `crates/freshell-server/src/main.rs` (`:380-392` construction, `:421` builder, `:561` WsState field, `:792-801` sweep spawn, `:1536-1542` constants region)
- Modify: `crates/freshell-freshagent/src/lib.rs` (`:190-201` field, `:286` literal, `:418-429` `with_amplifier_locator`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (`arm_locators_for_fresh_pane`'s amplifier arm `:460-479`; REST exit-hook disarm `:1165`/`:1176`; send-keys feed `:1688-1704`; test helper `state_with_amplifier_locator` `:2739-2743`)
- Modify: 31 `amplifier_locator: None` literals across `crates/freshell-ws/src/*` and `crates/freshell-ws/tests/*` (mechanical field removals; the explorer inventory lists the files — re-derive with `grep -rn 'amplifier_locator' crates/`)

**Interfaces:**
- Consumes: Tasks 8-11 (the replacement identity path must already be live — this task only removes the dead one).
- Produces: `pub(crate) fn spawn_identity_invariant_sweep(state: crate::WsState, interval: std::time::Duration)` in `crates/freshell-ws/src/invariants.rs` — wait: it is called from `freshell-server`, so it must be `pub`; plus standalone `IDENTITY_RESOLUTION_GRACE_MS`.

- [ ] **Step 1: Write the failing invariant-sweep test**

In `crates/freshell-ws/src/invariants.rs`'s existing test module (tests at `:238-364` already exercise `warn_unresolved_terminal_identities` arithmetic), add:

```rust
    #[test]
    fn identity_resolution_grace_is_a_standalone_constant() {
        // Re-homed from 5 * AMPLIFIER_DIR_APPEAR_WINDOW_MS when the amplifier
        // correlation-window locator was deleted (kata qmpk). 10s: generous
        // for every provider's identity to land at create time (identity is
        // launcher-assigned for claude and amplifier; codex/opencode locators
        // resolve within their own ~2s windows).
        assert_eq!(IDENTITY_RESOLUTION_GRACE_MS, 10_000);
    }
```

- [ ] **Step 2: Run to verify current state**

Run: `cargo test -p freshell-ws invariants`
Expected: the new test PASSES numerically already (5 × 2000 = 10_000) but the POINT of this task is the deletion — proceed; this test pins the value across the constant swap.

- [ ] **Step 3: Re-home the invariant sweep**

In `invariants.rs`, replace the derived constant (`:50-51`) with a standalone literal and rewrite its doc comment (the current one reasons from the locator windows):

```rust
/// How long a non-shell coding-CLI terminal may run without a resolvable
/// session identity before the invariant alarm fires once. 10s: identity is
/// launcher-assigned at create time for claude and amplifier; the codex and
/// opencode locators resolve within their own ~2s correlation windows, so
/// anything unresolved after 10s is a real defect, not a race.
/// (Previously derived from the deleted amplifier locator's
/// AMPLIFIER_DIR_APPEAR_WINDOW_MS; the alarm also previously rode the
/// amplifier locator sweep's 150ms ticker and silently never ran when no
/// provider home existed — it now owns its sweep unconditionally.)
pub(crate) const IDENTITY_RESOLUTION_GRACE_MS: i64 = 10_000;
```

Add the spawner (in `invariants.rs`; `pub` because `freshell-server` calls it):

```rust
/// Own sweep for the terminal_identity_unresolved alarm (re-homed off the
/// deleted amplifier locator sweep, kata qmpk). Spawned UNCONDITIONALLY at
/// boot — the old home only ran `if amplifier_locator.is_some()`, so a
/// missing provider home silently disabled the alarm for every provider.
pub fn spawn_identity_invariant_sweep(state: crate::WsState, interval: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        // Once-per-terminal bound, sweep-task-lifetime scoped.
        let mut identity_warned = std::collections::HashSet::new();
        loop {
            ticker.tick().await;
            warn_unresolved_terminal_identities(
                &state.registry.identity_probe_rows(),
                &state.identity,
                &mut identity_warned,
                crate::now_ms(),
            );
        }
    });
}
```

(`now_ms` — use whatever clock helper `amplifier_association.rs:233-252` used; move the import.)

In `crates/freshell-server/src/main.rs:792-801`, replace the conditional amplifier sweep spawn with:

```rust
    // Identity invariant alarm — its own sweep, unconditional (kata qmpk:
    // previously rode the amplifier locator sweep and died silently when
    // provider_home() was None).
    freshell_ws::invariants::spawn_identity_invariant_sweep(
        ws_state.clone(),
        IDENTITY_INVARIANT_SWEEP_INTERVAL,
    );
```

with, near the other interval constants (`:1536-1542`):

```rust
/// 2s cadence against a 10s grace: prompt enough to warn within ~12s of
/// create, cheap enough to never matter. (The deleted amplifier locator
/// ticked at 150ms because it was correlating filesystem events; the alarm
/// has no such need.)
const IDENTITY_INVARIANT_SWEEP_INTERVAL: std::time::Duration =
    std::time::Duration::from_secs(2);
```

Keep `AMPLIFIER_LOCATOR_SWEEP_INTERVAL` if (and only if) the opencode/codex sweeps still use it (`main.rs:806-815`) — rename it `LOCATOR_SWEEP_INTERVAL` if the compiler or clippy flags the now-wrong name, updating its two users.

- [ ] **Step 4: Delete the two files and ALL plumbing**

```bash
git rm crates/freshell-sessions/src/amplifier_locator.rs crates/freshell-ws/src/amplifier_association.rs
```

Then chase every compile error; the complete reference inventory (re-verify with `grep -rn 'amplifier_locator\|amplifier_association' crates/ --include='*.rs'`):
- `freshell-sessions/src/lib.rs:18` mod decl.
- `freshell-ws/src/lib.rs:24` mod decl; WsState field `:245-246` + default literal `:810`.
- `freshell-ws/src/terminal.rs`: `ExitHookDeps.amplifier_locator` field (`:1220-1225`) + hook disarm (`:1276-1278`) + both ExitHookDeps literals; `maybe_arm` calls (`:1963`, `:2510`); `note_possible_submit` on terminal.input (`:640-644`).
- `freshell-server/src/main.rs`: construction `:380-392`, `.with_amplifier_locator` `:421`, WsState wiring `:561`, and the old sweep-spawn block (replaced in Step 3).
- `freshell-freshagent/src/lib.rs`: field `:190-201`, literal `:286`, `with_amplifier_locator` builder `:418-429`.
- `freshell-freshagent/src/terminal_tabs.rs`: the amplifier arm inside `arm_locators_for_fresh_pane` (`:460-479` — keep the opencode/codex arms), REST exit-hook clone/disarm (`:1165`, `:1176`), send-keys `note_submit` feed (`:1688-1704` — keep `is_submit_input` if the codex/opencode feeds still use the local duplicate at `:1706-1712`), test helper `state_with_amplifier_locator` (`:2739-2743`) and the note at `:2752-2763`.
- 31 `amplifier_locator: None` literals in WsState constructions across `freshell-ws` src + tests — mechanical field removals.
- `crates/freshell-ws/src/activity.rs`: `attach_amplifier_association` (`:230-241`) loses its only production caller. Move it into the test-only surface — mark `#[cfg(test)]` (its six remaining callers are unit tests in the same file at `:1556, 1683, 1787, 1888, 1954, 1987`, which pin real lane behavior worth keeping) and adjust its doc comment to say it models what the create-time resolver attach does.
- Doc-comment references in `opencode_locator.rs`/`codex_locator.rs`/`opencode_association.rs`/`codex_association.rs`/`activity.rs`/`terminal.rs:83` — update prose only where it names the deleted items as live code (e.g. "mirrors amplifier_association" → "mirrors the deleted amplifier association (see kata qmpk)"), no behavior changes.

- [ ] **Step 5: Full workspace check**

Run: `cargo test -p freshell-sessions -p freshell-ws -p freshell-terminal -p freshell-freshagent && cargo build -p freshell-server`
Expected: PASS / clean build. The deleted tests (14 locator + 5 association + the old REST arm test rewritten in Task 11) are gone; `cargo test -p freshell-ws --test amplifier_launcher_identity` still green (the replacement contract).

- [ ] **Step 6: Clippy + fmt**

Run: `cargo clippy -p freshell-sessions -p freshell-ws -p freshell-terminal -p freshell-freshagent -p freshell-server -- -D warnings && cargo fmt --all -- --check`
Expected: clean (fix or `cargo fmt --all` as needed).

- [ ] **Step 7: Commit**

```bash
git add -A crates/
git commit -m "$(cat <<'EOF'
refactor(rust)!: delete amplifier correlation-window locator/association path; re-home identity invariant sweep

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 13: Boot-time layout canary wiring (loud, non-blocking)

**Files:**
- Modify: `crates/freshell-server/src/main.rs` (near the other boot-time spawns, e.g. right after the invariant sweep spawn from Task 12)

**Interfaces:**
- Consumes: `verify_amplifier_layout_contract`, `resolve_amplifier_home`, `CanaryOutcome` (Task 5).
- Produces: an ERROR-level `amplifier_layout_contract_broken` log on upstream drift; nothing else observable.

- [ ] **Step 1: Wire it**

```rust
    // Version canary (kata qmpk): the pre-create path rests on amplifier's
    // undocumented on-disk layout (upstream microsoft/amplifier#315/#316
    // track a --session-id flag that would collapse this layer into a
    // flag). Verify our slug/layout assumptions against sessions amplifier
    // ITSELF wrote — loud on breakage, never blocking broker start.
    tokio::task::spawn_blocking(|| {
        use freshell_sessions::amplifier_stub::{
            resolve_amplifier_home, verify_amplifier_layout_contract, CanaryOutcome,
        };
        let Some(amp_home) = resolve_amplifier_home() else {
            return;
        };
        match verify_amplifier_layout_contract(&amp_home) {
            CanaryOutcome::Broken { detail } => tracing::error!(
                target: "freshell_ws::invariants",
                %detail,
                "amplifier_layout_contract_broken: amplifier's on-disk session layout no \
                 longer matches the broker's stub pre-create assumptions — pre-created \
                 identities may silently diverge from the CLI's own sessions"
            ),
            outcome => tracing::debug!(?outcome, "amplifier layout canary"),
        }
    });
```

- [ ] **Step 2: Verify build + behavior**

Run: `cargo build -p freshell-server && cargo test -p freshell-sessions amplifier_stub::tests::canary -- --nocapture 2>/dev/null || cargo test -p freshell-sessions canary`
Expected: clean build; canary unit tests (Task 5) still green. (The wiring itself is covered by Task 5's unit tests + the e2e run in Task 14; a `main.rs` boot side-effect has no unit seam — this is the same wiring pattern as the other boot spawns.)

- [ ] **Step 3: Commit**

```bash
git add crates/freshell-server/src/main.rs
git commit -m "$(cat <<'EOF'
feat(server): boot-time amplifier layout canary (loud, non-blocking)

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 14: E2E migration — restore-across-restart on launcher-assigned identity

**Files:**
- Modify: `test/e2e-browser/fixtures/fake-amplifier-cli.mjs`
- Modify: `test/e2e-browser/fixtures/fake-amplifier-activity-cli.mjs` (falsified A7: this is the fixture lane-resilience actually launches — spec `:28` — and it resolves `AMPLIFIER_HOME` first at `:31`; retarget like its sibling, and fix the stale `$AMPLIFIER_HOME` doc comment at `:9`)
- Modify: `test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts` (falsified A7 — was wrongly listed verify-only: its 4 env pins `AMPLIFIER_HOME:` at `:254`, `:339`, `:467`, `:471` must become `FRESHELL_AMPLIFIER_HOME:`; the spec's own comment at `:244-245` documents the shared-root invariant — "both the server and the fake CLI resolve the same root" — that Task 2's retarget breaks unless server env pin AND fixture move together; refresh that comment and the one near `:192`)
- Modify: `test/e2e-browser/specs/amplifier-restore-rust.spec.ts` (rewrite, not delete — the SCENARIO is the feature's acceptance test)
- Verify-only (must stay green, no edits expected): `compound-restart-rust.spec.ts:37,320,419` + `codex-terminal-bounce-rust.spec.ts:34,268,279` (`not.toContain('terminal_identity_unresolved')` pins over the re-homed sweep)

**Interfaces:**
- Consumes: the whole feature (Tasks 8-13); the retired branch's reference versions of both files at `/home/dan/code/freshell/.worktrees/amplifier-session-identity/test/e2e-browser/{fixtures/fake-amplifier-cli.mjs,specs/amplifier-restore-rust.spec.ts}` (commits `2403faa8`, `6c0f33f0` there) — port their DESIGN onto the current files.
- Produces: e2e proof of the end-user story: an amplifier pane restores across a server restart via `amplifier resume <id>`, and a never-submitted pane's stub is GC'd (restores fresh).

- [ ] **Step 1: Retarget BOTH fake CLIs' home resolution + the lane-resilience spec's env pins (falsified A7)**

In `test/e2e-browser/fixtures/fake-amplifier-cli.mjs` AND `test/e2e-browser/fixtures/fake-amplifier-activity-cli.mjs` (`amplifierHome()` at `:31`; the activity fixture is what lane-resilience launches via `FAKE_AMPLIFIER_CLI`, spec `:28`), make the fixtures resolve the SAME home as the broker (both consult `AMPLIFIER_HOME` first today — that must go):

```js
function amplifierHome() {
  // Mirror the Rust broker's resolve_amplifier_home() (validated F1):
  // FRESHELL_AMPLIFIER_HOME override else $HOME/.amplifier. The real CLI's
  // AMPLIFIER_HOME is caches-only and must NOT be consulted here either —
  // server and fake CLI must resolve the SAME home.
  if (process.env.FRESHELL_AMPLIFIER_HOME) return process.env.FRESHELL_AMPLIFIER_HOME
  const home = process.env.HOME || process.env.USERPROFILE || '.'
  return path.join(home, '.amplifier')
}
```

Then migrate the lane-resilience spec's server env pins in `test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts`: `AMPLIFIER_HOME:` → `FRESHELL_AMPLIFIER_HOME:` at `:254` (truncation-recovery), `:339` (abrupt-restart re-attach), `:467`/`:471` (dual-server homeA/homeB), and refresh the shared-root comments (`:192`, `:244-245`). No other spec pins `AMPLIFIER_HOME` (validated inventory: everything else sets only `AMPLIFIER_CMD` and relies on the isolated `$HOME` fallback, which resolves identically before and after the retarget).

And teach the fixture the launcher-assigned flow: `fake-amplifier resume <id>` must FIND the pre-created stub dir under `amplifierHome()/projects/*/sessions/<id>` and run against it (appending to its `events.jsonl` on simulated prompt submits, writing `turn_count` into `metadata.json` on a completed turn) instead of creating its own session dir on first submit. Compare against the retired branch's version of this file and port the diff, reconciling with any changes the current file has grown (it also serves the lane-resilience spec — keep those behaviors).

- [ ] **Step 2: Rewrite the restore spec**

Rewrite `test/e2e-browser/specs/amplifier-restore-rust.spec.ts` (header `:10-33` currently names the locator as the mechanism under test) around the new mechanism, porting the retired branch's rewritten version onto the current harness. The scenario contract:

1. Open an amplifier pane → the pane has a sessionRef IMMEDIATELY at create (assert the sidebar/session identity WITHOUT typing anything — the payoff assertion the old mechanism could never make).
2. Type a prompt (fake CLI records `prompt:submit` in the stub's events.jsonl and marks a turn) → restart the server (harness restart helper, NOT the self-hosted 3002 server) → the pane restores and the fake CLI is relaunched with `resume <same-id>` (assert on the fixture's recorded argv).
3. Negative pane: open a second amplifier pane, type NOTHING, close it → its stub dir is GC'd from disk; after restart it restores fresh (new id) rather than resuming a ghost.
4. `expect(serverLogs).not.toContain('terminal_identity_unresolved')` and `not.toContain('amplifier_layout_contract_broken')`.

- [ ] **Step 3: Run the amplifier e2e specs**

Run: `npx playwright test test/e2e-browser/specs/amplifier-restore-rust.spec.ts test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts --project=rust 2>&1 | tail -20`
(Adjust the `--project` name to what `playwright.config.ts` defines for the Rust server — check `testMatch` there.)
Expected: PASS (both specs).

- [ ] **Step 4: Run the invariant-pin specs**

Run: `npx playwright test test/e2e-browser/specs/compound-restart-rust.spec.ts test/e2e-browser/specs/codex-terminal-bounce-rust.spec.ts --project=rust 2>&1 | tail -20`
Expected: PASS — proves the re-homed sweep neither spams nor goes silent. (This run is the DESIGNED first check of deferred assumption A14 — the unconditional-sweep regime has never run anywhere before this task. If `terminal_identity_unresolved` shows up, do NOT edit the pins: tune the re-home instead — per-provider grace or arm-on-create bookkeeping — per the ledger's recorded contingency.)

- [ ] **Step 5: Commit**

```bash
git add test/e2e-browser/
git commit -m "$(cat <<'EOF'
test(e2e): amplifier restore-across-restart on launcher-assigned identity (create-time sessionRef, GC re-stub)

Co-authored-by: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
EOF
)"
```

---

### Task 15: Final verification (no push — council gate follows)

**Files:** none new (fixes only if something fails).

- [ ] **Step 1: Fresh-eyes anchor re-check**

Run: `git log --oneline origin/main..HEAD` and `git fetch origin && git log --oneline HEAD..origin/main | head`
Expected: our task commits present; if origin/main moved during the work, re-verify the touched regions (concurrent agents are active) — rebase onto origin/main ONLY if new commits touch our files, and re-run the crate tests after.

- [ ] **Step 2: Full Rust suite**

Run: `cargo test -p freshell-sessions -p freshell-ws -p freshell-terminal -p freshell-freshagent && cargo clippy --workspace -- -D warnings && cargo fmt --all -- --check`
Expected: PASS. If fmt rewrites plan-verbatim long lines, commit the tidy as `style(rust): cargo fmt`.

- [ ] **Step 3: Opt-in real-CLI contract test (once, locally)**

Run:
```bash
FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- \
  run test/integration/real/amplifier-stub-adoption-contract.test.ts \
  --config config/vitest/vitest.server.config.ts
```
Expected: adoption test PASS (Task 1 already proved it; this re-run proves nothing regressed the contract shape). Not required by CI.

- [ ] **Step 4: Coordinated full suite**

Run: `FRESHELL_TEST_SUMMARY="qmpk launcher-assigned amplifier identity" npm test`
Expected: PASS. Wait for the coordinator gate if another run holds it; NEVER kill a foreign holder. This is the long pole — budget for it (`timeout` accordingly; the coordinator reads `FRESHELL_TEST_SUMMARY` at `scripts/testing/test-coordinator.ts:585-586`).

- [ ] **Step 5: Commit any straggler fixes; STOP**

```bash
git status --short   # must be clean (or commit focused fixes)
```

**DO NOT PUSH. DO NOT CREATE A PR.** The branch stays local in `.worktrees/amplifier-launcher-identity`; the council review gate that follows this workflow decides landing. (This is the plan's only deliberately deferred step, per the workflow's explicit instruction.)

---

## Self-Review (performed at authoring time)

**1. Spec coverage** — kata requirement → task:
- Mint UUID pre-spawn, both doors: Task 8 (WS), Task 11 (REST `POST /api/tabs` + split + respawn via `spawn_terminal_pane`).
- Stub on disk (metadata.json with the four keys, no bundle, empty transcript + events): Task 3; ordering-before-`registry.create`: Tasks 8, 11.
- Spawn `amplifier resume <uuid>` with zero downstream changes: existing manifest resumeArgs + `cli_launch.rs` generic block, pinned by Task 6; set_meta/sessionRef/events-lane confirmed by Task 8's test + Task 14 e2e.
- Delete locator + association entirely: Task 12.
- Re-home `terminal_identity_unresolved` onto its own interval (incl. fixing the silent-death-when-no-provider-home coupling): Task 12.
- `amplifier_stub` module (slug byte-match, ONE home resolution never-AMPLIFIER_HOME, ensure-exists writer, conservative GC predicate, boot canary): Tasks 2-5, canary wiring Task 13.
- Guards (`terminal:` reject, same-id double-resume with atomic enforcement): Tasks 7, 9 (WS), 11 (REST).
- Effective-cwd discipline (one validated cwd, divergent-slug resume handling, REST cwd=None → $HOME): Tasks 8, 11.
- Exit-hook GC through the shared `build_pty_exit_hook`/`ExitHookDeps` contract at BOTH call sites: Task 10; REST exit hook: Task 11.
- Preserve D7/PR #540, dedupe/PR #554, spawn-gate/PR #559 semantics: composition constraints written into Tasks 8, 9, 11 (sequential blocks; no reordering; gate-rejection stub GC).
- Contract test ported + run locally, opt-in only: Tasks 1, 15.
- Full coordinated suite: Task 15.
- No push/PR: Task 15 (explicitly deferred to the council gate — the one permitted deferral, mandated by the workflow).

**1b. No silent deferrals:** every user-facing behavior lands in production code within this plan and is proven by a non-stub test: real-CLI adoption (Task 1, real binary), WS/REST identity + guards (integration tests against the real handlers, Tasks 8-11), deletion safety (Task 12 keeps the whole workspace green), end-user restore story (Task 14 e2e through a real server + browser; the fake amplifier CLI there is the repo's PRE-EXISTING e2e fixture pattern, and the REAL-CLI behavior it simulates is separately pinned by Task 1's contract test against the actual binary). Scope clarifications (legacy Node tree untouched; restore-without-id spawns fresh; three accepted residuals) are deliberate kata-derived decisions recorded in Global Constraints, not deferrals of required behavior.

**2. Placeholder scan:** the elided bodies in Tasks 9/10/11/14 test sketches are harness plumbing explicitly sourced from named sibling files (`session_identity_frames.rs`, the old REST arm test, the retired branch's spec) with the assertions — the actual contract — given in full; every production code block is complete. No TBD/TODO remains.

**3. Type consistency:** `EnsuredSession{session_dir, created, found_under_divergent_slug, working_dir_of_existing}` used identically in Tasks 3/8/10/11; `has_live_resume(rows, mode, sid)` / `has_other_live_resume(rows, mode, sid, excluding)` defined Task 7, consumed Tasks 9/10/11; `AmplifierStubGc{session_dir, session_id}` defined and consumed in Task 10 and mirrored (as a tuple) in Task 11's REST hook; `CanaryOutcome` defined Task 5, consumed Task 13; `resolve_amplifier_home() -> Option<PathBuf>` consistent across Tasks 2/8/10/11/13. `registry.create`'s exact signature is deliberately deferred to the live file (Task 7 Step 4 note) — the AlreadyExists contract is what Tasks 9/11 consume.

**4. Stage-2 load-bearing validation addendum (2026-07-28)** — re-review of the tasks edited after validation (ledger: `.worktrees/.the-usual-logs/amplifier-launcher-identity/load-bearing-ledger.md`):
- Falsified A7 folded in: Task 14 now Modifies `amplifier-lane-resilience-rust.spec.ts` (4 env pins) + BOTH fake-CLI fixtures; Task 2 cross-references the interim redness (no plan step runs that spec before Task 14). Coverage table row "restore-across-restart e2e" unchanged; lane-resilience remains proven by its own (now-migrated) spec run in Task 14 Step 3.
- Falsified A10 folded in: Global Constraints gains the two cwd corners; Task 8 (WS) and Task 11 (REST) both gain the windows-arm reject, and Task 11's REST block now runs the effective cwd through `resolve_unix_shell_cwd` with a loud 400 on `None`. `would_take_windows_cli_arm` is a named stand-in with explicit hoist instructions (same convention as `registry_or_bail()`), not a placeholder to fill later.
- Verified-with-wrinkle A11: Task 7 now uses a SEPARATE `resume_create_inflight` reservation set (client-controlled `createRequestId`s share the old namespace) and documents the headless-row conservatism. The claim→re-check→insert→release contract is unchanged; Tasks 9/11's AlreadyExists consumption is unaffected.
- Verified-with-caveat A12: Task 8 Step 1 names the REAL choke point (`spawn_server_with_specs`) and adds defense-in-depth isolation in the new test file.
- Deferred A14 recorded: Task 14 Step 4 is the designed first check of the re-homed unconditional sweep, with the contingency (per-provider grace / arm-on-create) named so a red pin is tuned, not papered over.
- No silent deferrals introduced: every new guard lands in production code within Tasks 7-11 and is covered by the tasks' existing failing-test steps (the windows-arm reject and REST relative-cwd reject surface through the same error plumbing those tasks already test; implementers add assertions alongside the existing guard tests where natural).
