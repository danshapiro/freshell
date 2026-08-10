# Naming & Persistence Sweep (Rust Port) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make tab/pane/sidebar NAMING and PERSISTENCE work robustly on the Rust
server — automatic session auto-titling (dir → first-message → Gemini AI),
durable cross-device tabs-registry storage, a Node-parity automation REST
rename/layout surface, git branch/dirty badges, and guaranteed sidebar↔pane
title convergence — closing all known parity gaps in one sweep.

**Architecture:** Port Node's pure title logic (`server/auto-title.ts`) into a
new `freshell-server` module, driven by a background sweep modeled on the
existing `spawn_sessions_sweep`. Gemini calls go through a trait-injected
transport (no HTTP-mock crates; loopback test servers). The in-memory
`TabsRegistry` gains Node's caps/hashes/TTL semantics and is backed by a new
durable content-addressed store mirroring `~/.freshell/tabs-registry/v1/`.
A server-side `LayoutStore` (mirror of the SPA's `ui.layout.sync`, exactly like
Node's) backs the automation REST routes. Git enrichment is a new
`freshell-platform` helper + a `TerminalMetaRegistry` that finally emits
`terminal.meta.updated`. Three small, user-authorized client fixes close the
remaining sidebar↔pane desync paths.

**Tech Stack:** Rust (axum, tokio, serde, reqwest 0.13, sha2), existing Cargo
workspace under `crates/`; Vitest + Playwright (`legacy-chromium` /
`rust-chromium` projects) for TS/e2e proof.

## Global Constraints

Copied from the task spec, `port/AGENTS.md`, root `AGENTS.md`, and the parity
checklist. Every task's requirements implicitly include this section.

- **Worktree:** all work happens in `/home/dan/code/freshell/.worktrees/naming-persistence-sweep`
  on branch `feat/naming-persistence-sweep` (already created FROM
  `origin/feat/rust-tauri-port`, commit `f3e0cee4a`). All commands below run
  with this directory as cwd (or `git -C` it).
- **Delivery:** merge back into `feat/rust-tauri-port` and push that branch to
  origin. **DO NOT open a PR** (explicit campaign user directive). **Never push
  `main`.**
- **Purity invariant:** `git diff --name-only origin/feat/rust-tauri-port -- server/ shared/`
  MUST stay empty at all times. `shared/ws-protocol.ts` is immutable — no new
  WS message types (only already-declared ones like `terminal.title.updated`
  may gain emitters). `src/` is frozen EXCEPT the Task 19 client convergence
  fixes, which the task spec explicitly authorizes ("Fix any path where a
  rename or auto-title updates one surface but not the other (client or server
  side)"); each such change must be ledgered in `port/oracle/DEVIATIONS.md`
  (EDEV section) with a pinning test on BOTH Playwright projects.
- **Port equivalence:** behavior-equivalent to the Node reference except
  objectively defective behavior; any intentional divergence gets a
  `port/oracle/DEVIATIONS.md` entry (objective defect + fingerprint +
  pinning test + antagonist adjudication — never self-approved).
- **TDD:** Red-Green-Refactor for every non-trivial change. Structural limits:
  ≤1,000 lines per file, ≤10,000 LOC per crate — create NEW modules; do not
  grow `sessions.rs` (943 lines) or `main.rs` (1,618 lines) materially.
- **Process safety:** NEVER bind port 3001 (user's live server). Test servers
  use ephemeral ports (`findFreePort()` in e2e fixtures) or explicit unique
  high ports (e.g. 3499). Kill only PIDs you spawned.
- **Gemini is OUT of scope for live QA:** no live Gemini calls anywhere in the
  test suite. Test the Gemini path with the trait-injected fake transport and
  loopback HTTP servers only.
- **Test commands (canonical):**
  - Rust fast gate: `cargo test --workspace --exclude freshell-tauri`
  - Tauri (when touched): `cargo test -p freshell-tauri`
  - Focused crate: `cargo test -p freshell-server <filter>`
  - TS focused: `npm run test:vitest -- run <file>` (NEVER raw `npx vitest`)
  - TS broad (coordinator-gated): `npm test` / `npm run check`
  - e2e targeted: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/<spec>.spec.ts`
- **titleSource ladder (exact values):** `user`=5 > `ai`=4 > `first-message`=3
  > `legacy`=2 > `dir`=1 > absent=0. `user` always wins; any existing source ≠
  `dir` is *finalized* and frozen against automatic writers; otherwise strictly
  higher rank upgrades. Implemented at
  `crates/freshell-server/src/settings_store.rs:1193-1215` (`can_upgrade_title`).
  The ladder gate in `patch_session_override` applies ONLY when a patch carries
  BOTH `titleOverride` AND `titleSource` (`settings_store.rs:715-716`).
- **Naming constants (exact):** heuristic title cap **50** chars; AI title cap
  **80**; Gemini prompt message body cap **2000**; session-title
  `maxOutputTokens` **30**; terminal-summary input = last **20,000** chars of
  scrollback, `maxOutputTokens` **120**, output cap **240**; model
  `gemini-2.5-flash-lite`; dir placeholder = bare `basenameSegment(cwd)`.
- **Checklist evidence convention:** to CHECK a box you need a RED-then-GREEN
  `PW-RUST` Playwright proof against the real `target/release/freshell-server`
  with an isolated home, `legacy-chromium` control still green, lower-level
  tests green, evidence note naming spec path + quoted test title + projects +
  "Green 2x" timings + commit sha, and the spec regex added to `MATRIX_SPECS`
  (or the rust-only list) in `test/e2e-browser/playwright.config.ts`.
- Commit messages: conventional (`feat:`/`fix:`/`test:`/`docs:`), focused and
  atomic. Frequent commits (one per task step group as written below).

## Scope Check

The spec explicitly demands ONE sweep across six work items. The items are
decomposed below into six parts (A–F), each of which produces independently
testable, working software with its own test coverage, plus whole-system e2e
specs in Part F. Do not split into separate plans — the acceptance criteria
(esp. #6 cross-surface convergence and #7 single-delivery) couple them.

## Scope Decisions (read before implementing)

1. **`terminal.title.updated` is emitted ONLY from the auto-title sweep and its
   AI completion path** — exactly Node's two emit sites
   (`server/index.ts:907`, `:932`). REST rename endpoints do NOT emit it (Node
   doesn't either); REST renames converge via the sweep (≤2 s) plus the Task 19
   client fixes for immediate local convergence. This keeps the wire-frame
   inventory identical to Node.
2. **Multi-pane tab rename stays Redux-only** (Node parity: `titleSync.ts:86-87`
   bails). It renames the tab bar label only; it does not claim to rename any
   session, so sidebar↔pane never disagree *about a session title*. Documented,
   not fixed.
3. **Sticky `paneTitleSetByUser` policy:** local **user** renames initiated
   from the sidebar/history/terminal menus now pass `setByUser: true` into the
   pane mirror so they land and stay sticky (user intent beats an older user
   rename). Automatic titles keep `setByUser: false` (never clobber a user
   rename — ladder parity). Cross-browser sticky panes behave exactly as Node
   (the `terminal.title.updated` push is gated by the sticky flag there too).
4. **`POST /api/ai/terminals/:terminalId/summary`** is the real Node path (the
   router mounts at `/api/ai`, `server/index.ts:769`); the task spec's
   `POST /api/terminals/:terminalId/summary` is shorthand. Port the real path.
5. **Durable tabs store reads are Node-format-compatible** (same `v1/manifest.json`
   + `objects/<sha256>.json` layout, full 64-hex SHA-256 over raw file bytes on
   load); canonical serialization for *writing* uses byte-order (BTreeMap) key
   sorting. The earlier premise — "all registry JSON keys are lowercase-first
   camelCase ASCII, for which byte order and Node's `localeCompare` order
   agree" — is FALSE for MAP KEYS (validator-A2): `openSnapshotsByClient` /
   `clientRevisionsByClient` are keyed by base64url `deviceId:clientInstanceId`
   (mixed case `A-Za-z0-9-_`) and `closedByTabKey` by `uuid:nanoid` (mixed
   case) — a real-store scan found 59,041 objects whose sibling keys sort
   differently under byte order vs ICU `localeCompare` (e.g.
   `...:--0MNzJnmn...` vs `...:_fuUJwgE...`). Compatibility nevertheless holds
   because (i) object digests are verified against RAW stored bytes on load
   (writer-computed, collation-agnostic — each impl reads the other's
   objects), and (ii) the `openSnapshotPayloadHash` preimage ({deviceId,
   deviceLabel, clientInstanceId, snapshotRevision, records}) shows 0
   divergent key pairs across 11.96M real objects (all 43 observed payload
   keys are camelCase; the first-party client emits a closed camelCase set —
   only extension `props` is open). Do NOT port `localeCompare` (ICU root
   collation is version-unstable; Node is not self-consistent across
   upgrades). Known narrow residual (ledgered as A2-R1): exotic future
   extension-prop keys written by one impl could fail the other's payload-hash
   re-verification → loud boot refusal, recoverable (archive the manifest or
   run the writing server once); zero such keys exist in 2.6 GiB of production
   data. Cross-impl dedupe divergence for map-keyed component objects is
   benign (one-time object churn on impl switch; `objects/*` are never GC'd).
   Pinned by the Task 8 fixture tests.
6. **Gemini API key resolution** mirrors Node's `AI_CONFIG.applySettingsKey`
   exactly via an in-process cell: boot = env `GOOGLE_GENERATIVE_AI_API_KEY`
   wins over `settings.ai.geminiApiKey` (non-forcing, `server/index.ts:251`);
   every settings save re-applies the settings key with force
   (`server/settings-router.ts:139`); a blank settings key never clears.
7. **The generate-title REST route does NOT consult
   `settings.sidebar.autoGenerateTitles`** — it gates only on key presence.
   Only the background sweep honors the toggle. This asymmetry is real in Node
   (`server/index.ts:879` vs `sessions-router.ts:167-221`) and must be
   preserved.

## File Structure

New files (all inside the worktree):

| Path | Responsibility |
|---|---|
| `crates/freshell-server/src/auto_title.rs` | Pure port of `server/auto-title.ts` + `shared/path-basename.ts` + `isFinalizedTitleSource` |
| `crates/freshell-server/src/ai_title.rs` | Gemini prompts/constants, `strip_ansi`, `AiKeyCell`, `GeminiTransport` trait + `GeminiHttp` impl, `generate_ai_session_title` |
| `crates/freshell-server/src/auto_title_sweep.rs` | Background auto-name pass + one-shot AI guard + `terminal.title.updated` emission |
| `crates/freshell-server/src/ai_router.rs` | `POST /api/ai/terminals/{id}/summary` |
| `crates/freshell-ws/src/tabs_store_model.rs` | Durable-store state model, caps, canonical stringify, SHA-256, snapshot keys/hashes, maintenance + cap validation |
| `crates/freshell-ws/src/tabs_store.rs` | On-disk store: open/load/commit/publish/GC/corruption recovery |
| `crates/freshell-ws/src/tabs_store_migrate.rs` | Legacy `tabs-registry.jsonl` → v1 migration |
| `crates/freshell-freshagent/src/layout_store.rs` | Server-side `UiSnapshot` mirror (Node `layout-store.ts` port) |
| `crates/freshell-freshagent/src/layout_tree.rs` | `PaneNode` tree parsing + leaf collection + split lookup |
| `crates/freshell-freshagent/src/target_resolver.rs` | Node `target-resolver.ts` port |
| `crates/freshell-platform/src/git_meta.rs` | `resolve_git_repo_root` / `resolve_git_checkout_root` / `resolve_git_branch_and_dirty` / `derive_display_subdir` |
| `crates/freshell-ws/src/terminal_meta.rs` | `TerminalMetaRegistry` (commit-if-changed, retire TTL 1 h) |
| `test/e2e-browser/specs/auto-title-rust.spec.ts` | Item 1/2 + SESSION-04 evidence |
| `test/e2e-browser/specs/tabs-registry-persistence-rust.spec.ts` | CFG-08 + AUTO-15 evidence |
| `test/e2e-browser/specs/automation-layout-rust.spec.ts` | AUTO-01(partial)/03/06 evidence |
| `test/e2e-browser/specs/git-badges-rust.spec.ts` | Item 5 evidence |
| `test/e2e-browser/specs/title-sync-convergence.spec.ts` | Item 6 / acceptance #6 (matrix: both projects) |
| `test/e2e-browser/specs/settings-split-rust.spec.ts` | CFG-12 evidence |
| `test/unit/client/store/paneSessionTitleSync.test.ts` | Task 19 reducer/helper unit tests |

Modified files (main ones):

| Path | Change |
|---|---|
| `crates/freshell-server/src/main.rs` | `mod` lines; wire `AiKeyCell`, sweep, ai_router, durable tabs store open, layout store, terminal-meta registry |
| `crates/freshell-server/src/sessions.rs` | `generate_title`: provider-generated short-circuit, AI branch, `sessions.changed` broadcast (D11) |
| `crates/freshell-server/src/settings_store.rs` | none (used as-is) |
| `crates/freshell-server/src/settings.rs` + settings router state | apply forced AI key on settings save |
| `crates/freshell-server/src/session_directory.rs` | session-metadata read-join (Task 20) |
| `crates/freshell-sessions/src/directory_index.rs` | `IndexedSession` gains `first_user_message` / `title_source` (if absent) |
| `crates/freshell-ws/src/identity.rs` | `find_all_by_session(provider, session_id, cwd)` — 3-arg, cwd-scoped for claude (Task 3) |
| `crates/freshell-ws/src/tabs.rs` | Node-parity semantics (hashes, guards, TTLs, base64url keys) + durable-store backing |
| `crates/freshell-ws/src/terminal.rs` | tabs.sync handler updates; `ui.layout.sync` ingestion; create-time meta enrichment |
| `crates/freshell-ws/src/lib.rs` | `WsState` gains `layout` + `terminal_meta`; handshake ships real `terminal_meta` |
| `crates/freshell-freshagent/src/lib.rs` | `FreshAgentState` gains `layout`, `terminals_revision`, `rename_persistence`; `rename_pane` full behavior |
| `crates/freshell-freshagent/src/pane_ops.rs` | routes rebased onto `LayoutStore` (next/prev/resize un-deferred, swap titles, snapshot tree) |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | `list_tabs`/`list_panes` rebased onto `LayoutStore`; create/split also register in it |
| `src/store/titleSync.ts`, `src/store/paneTitleSync.ts`, `src/store/panesSlice.ts`, `src/components/context-menu/ContextMenuProvider.tsx`, `src/components/HistoryView.tsx`, `src/components/OverviewView.tsx` | Task 19 client convergence fixes (user-authorized src/ change) |
| `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` | evidence + checkboxes |
| `port/oracle/DEVIATIONS.md` | EDEV entries for client fixes; DEV-0008 closure note |
| `test/e2e-browser/playwright.config.ts` | new specs registered (matrix / rust-only lists) |

Interface notes for reviewers: `freshell-ws` depends on `freshell-freshagent`
(`crates/freshell-ws/Cargo.toml:37`), NOT vice versa — so the `LayoutStore`
lives in `freshell-freshagent` and `freshell-ws` imports it. `sha2 = "0.10"`
is already a `freshell-ws` dependency (`Cargo.toml:72`). `reqwest 0.13`
(rustls) is already a plain `freshell-server` dependency (`Cargo.toml:54`)
— but with `default-features = false, features = ["stream", "rustls"]`, so
reqwest's `json` feature is NOT enabled anywhere in the workspace: never use
`RequestBuilder::json(..)` / `Response::json::<T>()`; serialize/deserialize
manually with `serde_json` (already a direct dep, `Cargo.toml:44`) the way
`updater.rs:101-114` does (`.bytes()` + `serde_json::from_slice`).
For Task 16's rename cascade, NO new freshell-ws-side trait is needed: the
`freshell_terminal::TerminalRegistry` is ALREADY injected into
`FreshAgentState` (`crates/freshell-freshagent/src/lib.rs:111`, `:362`) and
is the terminal-metadata seam for provider/sessionId resolution
(validator-A10).

---

# PART A — Automatic auto-naming + AI titles (Items 1 & 2)

### Task 1: `auto_title.rs` — pure title-decision logic

**Files:**
- Create: `crates/freshell-server/src/auto_title.rs`
- Modify: `crates/freshell-server/src/main.rs` (add `mod auto_title;` next to the existing `mod` block near the top, ~line 32)

**Interfaces:**
- Consumes: `freshell_sessions::text::extract_title_from_message(content: &str, max_len: usize) -> String` (public, `crates/freshell-sessions/src/text.rs:58`).
- Produces (later tasks rely on these exact signatures):
  - `pub fn is_finalized_title_source(src: Option<&str>) -> bool`
  - `pub fn basename_segment(path: &str) -> Option<String>`
  - `pub struct AutoTitlePatch { pub title_override: String, pub title_source: &'static str }`
  - `pub fn compute_auto_title_patch(cwd: Option<&str>, first_user_message: Option<&str>, existing_title_override: Option<&str>, existing_title_source: Option<&str>, ai_will_auto_name: bool) -> Option<AutoTitlePatch>`
  - `pub struct SessionTerminal { pub terminal_id: String, pub title: Option<String> }`
  - `pub struct TitleSyncPlan { pub override_patch: Option<AutoTitlePatch>, pub canonical_title: Option<String>, pub terminal_ids_to_update: Vec<String>, pub should_generate_ai: bool }`
  - `pub fn compute_session_title_sync(session_title: Option<&str>, override_title: Option<&str>, override_source: Option<&str>, cwd: Option<&str>, first_user_message: Option<&str>, ai_will_auto_name: bool, parsed_title_source: Option<&str>, terminals: &[SessionTerminal]) -> TitleSyncPlan`

Node reference to port verbatim: `server/auto-title.ts:24-91`,
`shared/path-basename.ts:9-22`, `shared/title-source.ts:37`.

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-server/src/auto_title.rs` containing ONLY the test
module first (the functions do not exist yet, so it will not compile — that is
the red state):

```rust
//! Pure logic port of `server/auto-title.ts` (decision functions),
//! `shared/path-basename.ts::basenameSegment`, and
//! `shared/title-source.ts::isFinalizedTitleSource`.
//! No IO. See docs/plans/2026-08-08-naming-persistence-sweep.md Task 1.

#[cfg(test)]
mod tests {
    use super::*;

    // --- basename_segment (shared/path-basename.ts:9-22) ---
    #[test]
    fn basename_segment_plain_unix_path() {
        assert_eq!(basename_segment("/home/dan/code/freshell").as_deref(), Some("freshell"));
    }
    #[test]
    fn basename_segment_strips_trailing_slashes_both_kinds() {
        assert_eq!(basename_segment("/a/b///").as_deref(), Some("b"));
        assert_eq!(basename_segment("C:\\repo\\x\\\\").as_deref(), Some("x"));
    }
    #[test]
    fn basename_segment_unix_root_is_slash() {
        assert_eq!(basename_segment("/").as_deref(), Some("/"));
    }
    #[test]
    fn basename_segment_windows_drive_root_gets_backslash() {
        assert_eq!(basename_segment("C:").as_deref(), Some("C:\\"));
        assert_eq!(basename_segment("C:/").as_deref(), Some("C:\\"));
        assert_eq!(basename_segment("C:\\").as_deref(), Some("C:\\"));
    }
    #[test]
    fn basename_segment_empty_is_none() {
        assert_eq!(basename_segment(""), None);
    }

    // --- is_finalized_title_source (shared/title-source.ts:37) ---
    #[test]
    fn finalized_is_any_nonempty_source_except_dir() {
        assert!(!is_finalized_title_source(None));
        assert!(!is_finalized_title_source(Some("")));
        assert!(!is_finalized_title_source(Some("dir")));
        for s in ["user", "ai", "first-message", "legacy"] {
            assert!(is_finalized_title_source(Some(s)), "{s} must be finalized");
        }
    }

    // --- compute_auto_title_patch (server/auto-title.ts:24-46) ---
    #[test]
    fn finalized_existing_source_returns_none() {
        let p = compute_auto_title_patch(Some("/x/y"), Some("hello"), Some("Old"), Some("user"), false);
        assert!(p.is_none());
    }
    #[test]
    fn first_message_wins_when_ai_off_even_over_existing_dir_placeholder() {
        let p = compute_auto_title_patch(Some("/x/y"), Some("Fix the flux capacitor\nmore"), Some("y"), Some("dir"), false)
            .expect("patch");
        assert_eq!(p.title_override, "Fix the flux capacitor");
        assert_eq!(p.title_source, "first-message");
    }
    #[test]
    fn ai_on_holds_dir_placeholder_and_never_writes_first_message() {
        // aiWillAutoName=true: step 2 is skipped entirely (auto-title.ts:35).
        let p = compute_auto_title_patch(Some("/x/proj"), Some("Fix stuff"), None, None, true).expect("patch");
        assert_eq!(p.title_override, "proj");
        assert_eq!(p.title_source, "dir");
        // and with a dir placeholder already present -> nothing to do
        let p2 = compute_auto_title_patch(Some("/x/proj"), Some("Fix stuff"), Some("proj"), Some("dir"), true);
        assert!(p2.is_none());
    }
    #[test]
    fn dir_seed_requires_no_existing_override_string() {
        // auto-title.ts:40 checks existing?.titleOverride (the string), not the source.
        let p = compute_auto_title_patch(Some("/x/proj"), None, Some("anything"), None, false);
        assert!(p.is_none());
        let p2 = compute_auto_title_patch(Some("/x/proj"), None, None, None, false).expect("patch");
        assert_eq!(p2.title_override, "proj");
        assert_eq!(p2.title_source, "dir");
    }
    #[test]
    fn heuristic_title_is_capped_at_50() {
        let long = "a".repeat(80);
        let p = compute_auto_title_patch(None, Some(&long), None, None, false).expect("patch");
        assert_eq!(p.title_override.chars().count(), 50);
    }

    // --- compute_session_title_sync (server/auto-title.ts:61-91) ---
    fn term(id: &str, title: Option<&str>) -> SessionTerminal {
        SessionTerminal { terminal_id: id.to_string(), title: title.map(str::to_string) }
    }
    #[test]
    fn canonical_title_prefers_patch_then_session_title() {
        let plan = compute_session_title_sync(
            Some("Persisted"), Some("Persisted"), Some("user"),
            Some("/x/y"), Some("hi"), false, None,
            &[term("t1", Some("stale")), term("t2", Some("Persisted"))]);
        assert!(plan.override_patch.is_none()); // user is finalized
        assert_eq!(plan.canonical_title.as_deref(), Some("Persisted"));
        assert_eq!(plan.terminal_ids_to_update, vec!["t1".to_string()]);
        assert!(!plan.should_generate_ai);
    }
    #[test]
    fn should_generate_ai_requires_all_four_conditions() {
        // aiWillAutoName && first non-empty && !finalized && parsed != provider-generated
        let base = |ai: bool, first: Option<&str>, src: Option<&str>, parsed: Option<&str>| {
            compute_session_title_sync(None, None, src, Some("/x/y"), first, ai, parsed, &[])
                .should_generate_ai
        };
        assert!(base(true, Some("hi"), None, None));
        assert!(base(true, Some("hi"), Some("dir"), None));
        assert!(!base(false, Some("hi"), None, None));
        assert!(!base(true, None, None, None));
        assert!(!base(true, Some("   "), None, None));
        assert!(!base(true, Some("hi"), Some("first-message"), None));
        assert!(!base(true, Some("hi"), None, Some("provider-generated")));
    }
    #[test]
    fn no_canonical_title_means_no_terminal_pushes() {
        let plan = compute_session_title_sync(None, None, None, None, None, false, None,
            &[term("t1", Some("x"))]);
        assert!(plan.canonical_title.is_none());
        assert!(plan.terminal_ids_to_update.is_empty());
    }
    #[test]
    fn empty_session_title_is_treated_as_absent() {
        // JS: `canonicalTitle ? ... : []` — empty string is falsy.
        let plan = compute_session_title_sync(Some(""), None, None, None, None, false, None,
            &[term("t1", Some("x"))]);
        assert!(plan.terminal_ids_to_update.is_empty());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server auto_title 2>&1 | tail -20`
Expected: compile error — `cannot find function `basename_segment``, etc.
(Remember to add `mod auto_title;` to `main.rs` first or the module is not
compiled at all — the failure must come from missing functions, not a missing
module.)

- [ ] **Step 3: Write the implementation**

Add above the test module in `auto_title.rs`:

```rust
/// `shared/title-source.ts:37` — `!!src && src !== 'dir'`.
pub fn is_finalized_title_source(src: Option<&str>) -> bool {
    matches!(src, Some(s) if !s.is_empty() && s != "dir")
}

/// `shared/path-basename.ts:9-22`.
pub fn basename_segment(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return if path.starts_with('/') { Some("/".to_string()) } else { None };
    }
    let b = trimmed.as_bytes();
    if b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
        return Some(format!("{trimmed}\\"));
    }
    let last = trimmed.rsplit(['/', '\\']).next().unwrap_or("");
    if last.is_empty() { None } else { Some(last.to_string()) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoTitlePatch {
    pub title_override: String,
    pub title_source: &'static str,
}

/// `server/auto-title.ts:24-46`. `existing_title_override`/`existing_title_source`
/// are the current sessionOverrides row fields (None when absent).
pub fn compute_auto_title_patch(
    cwd: Option<&str>,
    first_user_message: Option<&str>,
    existing_title_override: Option<&str>,
    existing_title_source: Option<&str>,
    ai_will_auto_name: bool,
) -> Option<AutoTitlePatch> {
    if is_finalized_title_source(existing_title_source) {
        return None;
    }
    let first_nonempty = first_user_message.map(str::trim).is_some_and(|s| !s.is_empty());
    if first_nonempty && !ai_will_auto_name {
        // NOTE: pass the RAW message (extract trims internally) — auto-title.ts:36.
        let title = freshell_sessions::text::extract_title_from_message(
            first_user_message.unwrap_or(""),
            50,
        );
        if !title.is_empty() {
            return Some(AutoTitlePatch { title_override: title, title_source: "first-message" });
        }
    }
    let has_override = existing_title_override.is_some_and(|s| !s.is_empty());
    if !has_override {
        if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
            if let Some(segment) = basename_segment(cwd) {
                return Some(AutoTitlePatch { title_override: segment, title_source: "dir" });
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct SessionTerminal {
    pub terminal_id: String,
    pub title: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TitleSyncPlan {
    pub override_patch: Option<AutoTitlePatch>,
    pub canonical_title: Option<String>,
    pub terminal_ids_to_update: Vec<String>,
    pub should_generate_ai: bool,
}

/// `server/auto-title.ts:61-91`. `session_title` must already be the
/// override-applied session title (i.e. what `/api/session-directory` serves).
#[allow(clippy::too_many_arguments)]
pub fn compute_session_title_sync(
    session_title: Option<&str>,
    override_title: Option<&str>,
    override_source: Option<&str>,
    cwd: Option<&str>,
    first_user_message: Option<&str>,
    ai_will_auto_name: bool,
    parsed_title_source: Option<&str>,
    terminals: &[SessionTerminal],
) -> TitleSyncPlan {
    let override_patch = compute_auto_title_patch(
        cwd, first_user_message, override_title, override_source, ai_will_auto_name,
    );
    // JS `??` then truthiness: empty string collapses to "no canonical title".
    let canonical_title: Option<String> = override_patch
        .as_ref()
        .map(|p| p.title_override.clone())
        .or_else(|| session_title.map(str::to_string))
        .filter(|t| !t.is_empty());
    let terminal_ids_to_update = match &canonical_title {
        Some(canon) => terminals
            .iter()
            .filter(|t| t.title.as_deref() != Some(canon.as_str()))
            .map(|t| t.terminal_id.clone())
            .collect(),
        None => Vec::new(),
    };
    let should_generate_ai = ai_will_auto_name
        && first_user_message.map(str::trim).is_some_and(|s| !s.is_empty())
        && !is_finalized_title_source(override_source)
        && parsed_title_source != Some("provider-generated");
    TitleSyncPlan { override_patch, canonical_title, terminal_ids_to_update, should_generate_ai }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server auto_title 2>&1 | tail -5`
Expected: `test result: ok. 12 passed`

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-server/src/auto_title.rs crates/freshell-server/src/main.rs
git commit -m "feat(server): port auto-title pure logic (computeAutoTitlePatch/SessionTitleSync, basenameSegment)"
```

### Task 2: `ai_title.rs` — Gemini transport, prompts, key cell

**Files:**
- Create: `crates/freshell-server/src/ai_title.rs`
- Modify: `crates/freshell-server/src/main.rs` (add `mod ai_title;`; construct `AiKeyCell`; change `ai_enabled` feature flag to read the cell; construct the shared `GeminiHttp` transport)
- Modify: `crates/freshell-server/src/settings_store.rs` or the settings router wiring site in `main.rs` (forced key re-apply on settings save — see Step 5)
- Test: inline `#[cfg(test)]` in `ai_title.rs`

**Interfaces:**
- Consumes: `freshell_protocol::ServerSettings` (`settings.ai.gemini_api_key`, `settings.ai.title_prompt` — `crates/freshell-protocol/src/settings.rs:67-74`); `reqwest` (already a dep, `crates/freshell-server/Cargo.toml:54` — `default-features = false, features = ["stream", "rustls"]`; the `json` feature is NOT enabled, so the transport serializes the request body with `serde_json::to_vec` and decodes responses via `.bytes()` + `serde_json::from_slice`, matching `updater.rs:101-114`; no Cargo.toml change needed).
- Produces (later tasks use these exact items):
  - `pub const GEMINI_MODEL: &str = "gemini-2.5-flash-lite";`
  - `pub const GEMINI_DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";`
  - `pub const SESSION_TITLE_MAX_OUTPUT_TOKENS: u32 = 30;`
  - `pub const TERMINAL_SUMMARY_MAX_OUTPUT_TOKENS: u32 = 120;`
  - `pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;`
  - `pub trait GeminiTransport: Send + Sync { fn generate_content(&self, prompt: String, max_output_tokens: u32) -> BoxFuture<Result<String, String>>; }`
  - `pub struct GeminiHttp { ... }` + `impl GeminiHttp { pub fn new(client: reqwest::Client, key_cell: AiKeyCell, base_url: String) -> Self }` implementing `GeminiTransport`
  - `pub fn build_session_title_prompt(first_message: &str, custom_prompt: Option<&str>) -> String`
  - `pub fn build_terminal_summary_prompt(terminal_output: &str) -> String`
  - `pub fn strip_ansi(input: &str) -> String`
  - `pub async fn generate_ai_session_title(transport: &dyn GeminiTransport, first_message: &str, custom_prompt: Option<&str>) -> Result<Option<String>, String>` (trim + 80-char cap; empty → `Ok(None)`)
  - `#[derive(Clone, Default)] pub struct AiKeyCell(...)` with `pub fn init(env_key: Option<String>, settings_key: Option<String>) -> Self`, `pub fn apply_settings_key_forced(&self, key: Option<&str>)`, `pub fn get(&self) -> Option<String>`, `pub fn enabled(&self) -> bool`

Node reference: `server/ai-title.ts:10-27`, `server/ai-prompts.ts` (AI_CONFIG
`:13-23`, sessionTitle `:42-60`, terminalSummary `:27-41`, stripAnsi `:7-10`).
Exact HTTP wire contract — VERIFIED by live capture of the installed
`ai@6.0.240` + `@ai-sdk/google@3.0.103` (validator-A1):
`POST {base}/models/gemini-2.5-flash-lite:generateContent`; auth header
`x-goog-api-key: <key>` ONLY (never a `?key=` query param); request body
exactly
`{"generationConfig":{"maxOutputTokens":N},"contents":[{"role":"user","parts":[{"text":"<prompt>"}]}]}`;
default base `https://generativelanguage.googleapis.com/v1beta`, joined with
without-trailing-slash semantics (a base with or without a trailing slash must
yield the same URL). Response text = concatenation of
`candidates[0].content.parts[].text` EXCLUDING parts carrying
`"thought": true`; only `candidates[0]` is consulted. Node has NO env
base-URL override (the default is hardcoded) — `FRESHELL_GEMINI_BASE_URL` is
a Rust-only test seam, a deliberate documented superset (see Step 5).
Test-shape guidance: fake servers assert the REQUIRED fields (method, path,
header, the essential body fields above), not byte-exact bodies, so the tests
survive SDK version skew.

- [ ] **Step 1: Write the failing tests**

Create `ai_title.rs` with the test module (add `mod ai_title;` to `main.rs`):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_cell_boot_env_wins_over_settings_nonforcing() {
        let cell = AiKeyCell::init(Some("envkey".into()), Some("settingskey".into()));
        assert_eq!(cell.get().as_deref(), Some("envkey"));
        let cell2 = AiKeyCell::init(None, Some("settingskey".into()));
        assert_eq!(cell2.get().as_deref(), Some("settingskey"));
        assert!(!AiKeyCell::init(None, None).enabled());
    }
    #[test]
    fn key_cell_forced_apply_overwrites_but_blank_never_clears() {
        let cell = AiKeyCell::init(Some("envkey".into()), None);
        cell.apply_settings_key_forced(Some("newkey"));
        assert_eq!(cell.get().as_deref(), Some("newkey"));
        cell.apply_settings_key_forced(None);
        assert_eq!(cell.get().as_deref(), Some("newkey")); // `if (key)` guard, ai-prompts.ts:18
        cell.apply_settings_key_forced(Some(""));
        assert_eq!(cell.get().as_deref(), Some("newkey"));
    }
    #[test]
    fn session_title_prompt_uses_default_then_custom_and_caps_message_at_2000() {
        let long = "m".repeat(3000);
        let p = build_session_title_prompt(&long, None);
        assert!(p.starts_with("Generate a title for a tab"));
        assert!(p.contains("\n\nFirst message from the user:\n"));
        let body = p.rsplit('\n').next().unwrap();
        assert_eq!(body.chars().count(), 2000);
        let c = build_session_title_prompt("hi", Some("  Custom prompt  "));
        assert!(c.starts_with("Custom prompt"));
        // blank custom falls back to default (ai-prompts.ts build: customPrompt?.trim() || default)
        let d = build_session_title_prompt("hi", Some("   "));
        assert!(d.starts_with("Generate a title for a tab"));
    }
    #[test]
    fn strip_ansi_removes_csi_osc_and_charset_sequences() {
        let s = "a\u{1b}[31mred\u{1b}[0mb\u{1b}]0;title\u{07}c\u{1b}(Bd";
        assert_eq!(strip_ansi(s), "aredbcd");
    }

    struct FakeTransport(Result<String, String>);
    impl GeminiTransport for FakeTransport {
        fn generate_content(&self, _p: String, _m: u32) -> BoxFuture<Result<String, String>> {
            let r = self.0.clone();
            Box::pin(async move { r })
        }
    }
    #[tokio::test]
    async fn ai_title_trims_caps_at_80_and_empty_is_none() {
        let long = format!("  {}  ", "t".repeat(200));
        let t = generate_ai_session_title(&FakeTransport(Ok(long)), "hi", None).await.unwrap();
        assert_eq!(t.unwrap().chars().count(), 80);
        let none = generate_ai_session_title(&FakeTransport(Ok("   ".into())), "hi", None).await.unwrap();
        assert!(none.is_none());
        let err = generate_ai_session_title(&FakeTransport(Err("boom".into())), "hi", None).await;
        assert!(err.is_err());
    }

    /// Loopback HTTP test for GeminiHttp — no live Gemini, no mock crates:
    /// bind an axum server on 127.0.0.1:0 that asserts the wire contract
    /// (required fields only — method, path, header, essential body fields —
    /// not byte-exact bodies; validator-A1 test-shape guidance). The response
    /// includes a `"thought": true` part which MUST be excluded from the
    /// extracted text (validator-A1 live capture).
    #[tokio::test]
    async fn gemini_http_posts_expected_body_and_parses_candidates_excluding_thoughts() {
        use axum::{routing::post, Router, Json};
        let app = Router::new().route(
            "/v1beta/models/gemini-2.5-flash-lite:generateContent",
            post(|headers: axum::http::HeaderMap, Json(body): Json<serde_json::Value>| async move {
                assert_eq!(headers.get("x-goog-api-key").unwrap(), "tok-123");
                assert_eq!(body["generationConfig"]["maxOutputTokens"], 30);
                assert_eq!(body["contents"][0]["role"], "user");
                assert!(body["contents"][0]["parts"][0]["text"].as_str().unwrap().contains("hello world"));
                Json(serde_json::json!({
                    "candidates": [{ "content": { "parts": [
                        {"text": "internal reasoning", "thought": true},
                        {"text": "Flux "}, {"text": "repair"}
                    ] } }]
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let cell = AiKeyCell::init(Some("tok-123".into()), None);
        let http = GeminiHttp::new(reqwest::Client::new(), cell, format!("http://{addr}/v1beta"));
        let title = generate_ai_session_title(&http, "hello world", None).await.unwrap();
        assert_eq!(title.as_deref(), Some("Flux repair"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-server ai_title 2>&1 | tail -10`
Expected: compile errors (`AiKeyCell` not found, etc.).

- [ ] **Step 3: Write the implementation**

```rust
//! Gemini AI title/summary support. Port of `server/ai-title.ts` +
//! `server/ai-prompts.ts`. Transport is trait-injected (workspace convention:
//! no HTTP-mock crates; see crates/freshell-opencode for precedent).
use std::sync::{Arc, RwLock};

pub const GEMINI_MODEL: &str = "gemini-2.5-flash-lite";
pub const GEMINI_DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const SESSION_TITLE_MAX_OUTPUT_TOKENS: u32 = 30;
pub const TERMINAL_SUMMARY_MAX_OUTPUT_TOKENS: u32 = 120;
pub const SESSION_TITLE_CHAR_CAP: usize = 80;
pub const PROMPT_MESSAGE_CHAR_CAP: usize = 2000;

/// `ai-prompts.ts:42-60` defaultPrompt, joined with '\n'.
pub const SESSION_TITLE_DEFAULT_PROMPT: &str = concat!(
    "Generate a title for a tab that contains the coding agent for this conversation.\n",
    "Only the first word or two will show, so most specific and informative words first.\n",
    "E.g. if we're investigating a crash in freshell that happens when you mention sardines, ",
    "\"Sardine crash investigation\" because sardine is specific, crash is less specific, ",
    "and investigation is common to almost all tabs.\n",
    "Return ONLY the title text. No quotes, no markdown, no explanation.",
);

pub fn build_session_title_prompt(first_message: &str, custom_prompt: Option<&str>) -> String {
    let head = custom_prompt
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(SESSION_TITLE_DEFAULT_PROMPT);
    // NOTE: JS slices UTF-16 units; we count chars — same deliberate divergence
    // as the existing heuristic port (sessions.rs:291), consistent across surfaces.
    let body: String = first_message.chars().take(PROMPT_MESSAGE_CHAR_CAP).collect();
    format!("{head}\n\nFirst message from the user:\n{body}")
}

/// `ai-prompts.ts:27-41`.
pub fn build_terminal_summary_prompt(terminal_output: &str) -> String {
    format!(
        "You are summarizing a terminal session for an overview page.\n\
         Return a single short description (1-2 sentences, max 200 chars).\n\
         No markdown. No quotes.\n\n\
         Terminal output:\n{}",
        strip_ansi(terminal_output)
    )
}

/// `ai-prompts.ts:7-10` — CSI, OSC-to-BEL, and charset-select sequences.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut it = input.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('[') => {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() { break; }
                }
            }
            Some(']') => {
                it.next();
                for n in it.by_ref() {
                    if n == '\u{07}' { break; }
                }
            }
            Some('(') | Some(')') => {
                it.next();
                if matches!(it.peek(), Some('A' | 'B' | '0' | '1' | '2')) { it.next(); }
            }
            _ => {}
        }
    }
    out
}

/// Process-local mirror of Node's env-projected key (`AI_CONFIG`, ai-prompts.ts:13-23).
#[derive(Clone, Default)]
pub struct AiKeyCell(Arc<RwLock<Option<String>>>);

impl AiKeyCell {
    /// Boot semantics: env wins over settings (non-forcing apply, server/index.ts:251).
    pub fn init(env_key: Option<String>, settings_key: Option<String>) -> Self {
        let v = env_key.filter(|k| !k.is_empty()).or(settings_key.filter(|k| !k.is_empty()));
        Self(Arc::new(RwLock::new(v)))
    }
    /// Settings-save semantics: force overwrite; blank never clears (ai-prompts.ts:17-23).
    pub fn apply_settings_key_forced(&self, key: Option<&str>) {
        if let Some(k) = key.filter(|k| !k.is_empty()) {
            *self.0.write().expect("ai key cell lock") = Some(k.to_string());
        }
    }
    pub fn get(&self) -> Option<String> {
        self.0.read().expect("ai key cell lock").clone()
    }
    pub fn enabled(&self) -> bool {
        self.get().is_some_and(|k| !k.is_empty())
    }
}

pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;

pub trait GeminiTransport: Send + Sync {
    fn generate_content(&self, prompt: String, max_output_tokens: u32) -> BoxFuture<Result<String, String>>;
}

pub struct GeminiHttp {
    client: reqwest::Client,
    key_cell: AiKeyCell,
    base_url: String,
}

impl GeminiHttp {
    pub fn new(client: reqwest::Client, key_cell: AiKeyCell, base_url: String) -> Self {
        Self { client, key_cell, base_url }
    }
}

impl GeminiTransport for GeminiHttp {
    fn generate_content(&self, prompt: String, max_output_tokens: u32) -> BoxFuture<Result<String, String>> {
        let client = self.client.clone();
        let key = self.key_cell.get();
        let url = format!(
            "{}/models/{GEMINI_MODEL}:generateContent",
            self.base_url.trim_end_matches('/')
        );
        Box::pin(async move {
            let key = key.ok_or_else(|| "no gemini api key".to_string())?;
            let body = serde_json::json!({
                "generationConfig": { "maxOutputTokens": max_output_tokens },
                "contents": [ { "role": "user", "parts": [ { "text": prompt } ] } ]
            });
            // NOTE: reqwest is built with default-features = false,
            // features = ["stream", "rustls"] (Cargo.toml:54) — the `json`
            // feature is NOT enabled, so do NOT use .json(&body) or
            // resp.json::<T>(). Serialize/deserialize manually via
            // serde_json, matching the existing updater.rs:101-114 idiom.
            let body_bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
            let resp = client
                .post(&url)
                .header("x-goog-api-key", key)
                .header("content-type", "application/json")
                .body(body_bytes)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            if !status.is_success() {
                return Err(format!("gemini http {status}"));
            }
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            let v: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            // Only candidates[0] is consulted; parts with "thought": true are
            // reasoning output and MUST be excluded (validator-A1 live capture).
            let mut text = String::new();
            if let Some(parts) = v.pointer("/candidates/0/content/parts").and_then(|p| p.as_array()) {
                for part in parts {
                    if part.get("thought").and_then(|t| t.as_bool()) == Some(true) {
                        continue;
                    }
                    if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                        text.push_str(t);
                    }
                }
            }
            Ok(text)
        })
    }
}

/// `server/ai-title.ts:10-27`. Caller decides enablement; this function only
/// formats, calls, trims, caps at 80, and maps empty → None.
pub async fn generate_ai_session_title(
    transport: &dyn GeminiTransport,
    first_message: &str,
    custom_prompt: Option<&str>,
) -> Result<Option<String>, String> {
    let prompt = build_session_title_prompt(first_message, custom_prompt);
    let text = transport.generate_content(prompt, SESSION_TITLE_MAX_OUTPUT_TOKENS).await?;
    let title: String = text.trim().chars().take(SESSION_TITLE_CHAR_CAP).collect();
    Ok(if title.is_empty() { None } else { Some(title) })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server ai_title 2>&1 | tail -5`
Expected: `test result: ok. 6 passed`

- [ ] **Step 5: Wire the cell into boot + settings save + feature flag**

In `main.rs`:
1. Construct once, near where `SettingsStore::load` result is available:
   ```rust
   let boot_settings = settings.get().await;
   let ai_key = crate::ai_title::AiKeyCell::init(
       env.get("GOOGLE_GENERATIVE_AI_API_KEY").filter(|v| !v.is_empty()),
       boot_settings.ai.gemini_api_key.clone(),
   );
   let gemini_base_url = env
       .get("FRESHELL_GEMINI_BASE_URL")
       .filter(|v| !v.is_empty())
       .unwrap_or_else(|| crate::ai_title::GEMINI_DEFAULT_BASE_URL.to_string());
   let gemini: std::sync::Arc<dyn crate::ai_title::GeminiTransport> =
       std::sync::Arc::new(crate::ai_title::GeminiHttp::new(
           reqwest::Client::new(), ai_key.clone(), gemini_base_url,
       ));
   ```
   (Use the existing `freshell_platform::Env` handle the way `ai_enabled` at
   `main.rs:1064-1071` does; if `env.get` doesn't exist use the same accessor
   `ai_enabled` uses. `FRESHELL_GEMINI_BASE_URL` is a Rust-only test seam used
   by the e2e fake-Gemini server in Task 21 — Node has NO env base-URL
   override (its default is hardcoded), so this is a deliberate documented
   superset, not a ported behavior; validator-A1.)
2. Change the `featureFlags.aiEnabled` computation (`main.rs:1061`) to
   `ai_key.enabled()` and update the `ai_enabled` tests at `main.rs:1473-1505`
   to cover the settings-key case (env absent + settings key present → true).
3. Settings save hook: find where the settings router applies a successful
   PATCH/PUT (SettingsRouterState wiring, `settings_store.rs:1584/1601`); add
   an `ai_key: crate::ai_title::AiKeyCell` field to `SettingsRouterState` and,
   after a successful patch/put, call
   `state.ai_key.apply_settings_key_forced(updated.ai.gemini_api_key.as_deref())`.
   Add a test in the settings router test module: PATCH `{"ai":{"geminiApiKey":"k2"}}`
   → cell now returns `k2`.

Run: `cargo test -p freshell-server 2>&1 | tail -5` — expected all green.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-server/src/ai_title.rs crates/freshell-server/src/main.rs crates/freshell-server/src/settings_store.rs
git commit -m "feat(server): Gemini transport + prompts + AI key cell (settings-forced, env boot precedence)"
```

### Task 3: `TerminalIdentityRegistry::find_all_by_session`

**Files:**
- Modify: `crates/freshell-ws/src/identity.rs` (280 lines — room to grow)

**Interfaces:**
- Produces: `pub fn find_all_by_session(&self, provider: &str, session_id: &str, cwd: Option<&str>) -> Vec<TerminalIdentity>` — live (non-retired) terminals only, all matches, cwd-scoped for cwd-scoped session modes (Node's 3-arg `findTerminalsBySession` fans out to MANY terminals; the existing `find_by_session` at `identity.rs:160-165` returns at most one and stays untouched — 4 existing callers).

- [ ] **Step 1: Port the Node matcher semantics (validator-A4-A3 falsified
the "strict provider+sessionId" assumption).** Node's 3-arg
`findTerminalsBySession(provider, sessionId, cwd)`
(`server/terminal-registry.ts:4538`) matches via `matchesScopedSession`
(`:442-447`), which requires normalized-cwd EQUALITY whenever
`isCwdScopedSessionMode(mode)` — true precisely for `claude` (`:410-412`).
Normalization (`:414-431`): realpath (native preferred, lexical fallback on
error) → backslashes→`/` → strip trailing slashes → lowercase on win32.
Absent session cwd → the cwd check is skipped; a terminal WITHOUT a cwd while
the session cwd is present → excluded. Node's sweep passes `session.cwd`
(`server/index.ts:841`, `:884`). Record these cites in the function's doc
comment.

- [ ] **Step 2: Write the failing test** (append to the existing
`#[cfg(test)] mod tests` at `identity.rs:168`, following its style):

```rust
#[test]
fn find_all_by_session_scopes_claude_by_normalized_cwd_and_skips_retired() {
    let reg = TerminalIdentityRegistry::new();
    reg.upsert("t1", Some("claude"), Some("s1"), Some("/a"), 1);
    reg.upsert("t2", Some("claude"), Some("s1"), Some("/a/"), 2); // trailing slash normalizes equal
    reg.upsert("t3", Some("claude"), Some("s1"), Some("/b"), 3);  // different cwd -> excluded when scoped
    reg.upsert("t4", Some("claude"), Some("s1"), None, 4);        // no terminal cwd while session cwd present -> excluded
    reg.upsert("t5", Some("codex"), Some("s1"), Some("/a"), 5);   // provider mismatch for the claude query
    reg.upsert("t6", Some("claude"), Some("s2"), Some("/a"), 6);  // session mismatch
    reg.upsert("t7", Some("claude"), Some("s1"), Some("/a"), 7);
    reg.retire("t7");
    let mut ids: Vec<String> = reg
        .find_all_by_session("claude", "s1", Some("/a"))
        .into_iter()
        .map(|t| t.terminal_id)
        .collect();
    ids.sort();
    assert_eq!(ids, vec!["t1".to_string(), "t2".to_string()]);
    // absent session cwd -> the cwd check is skipped entirely
    let mut all: Vec<String> = reg
        .find_all_by_session("claude", "s1", None)
        .into_iter()
        .map(|t| t.terminal_id)
        .collect();
    all.sort();
    assert_eq!(all, vec!["t1".to_string(), "t2".to_string(), "t3".to_string(), "t4".to_string()]);
    // non-cwd-scoped provider (codex) ignores cwd even when both sides carry one
    let codex: Vec<String> = reg
        .find_all_by_session("codex", "s1", Some("/zzz"))
        .into_iter()
        .map(|t| t.terminal_id)
        .collect();
    assert_eq!(codex, vec!["t5".to_string()]);
}
```

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test -p freshell-ws find_all_by_session 2>&1 | tail -5`
Expected: compile error (method not found).

- [ ] **Step 4: Implement**

```rust
/// All LIVE terminals bound to (provider, session_id), cwd-scoped for
/// cwd-scoped session modes. Port of Node's 3-arg
/// `server/terminal-registry.ts::findTerminalsBySession` (:4538) +
/// `matchesScopedSession` (:442-447): when `isCwdScopedSessionMode(mode)` —
/// true precisely for `claude` (:410-412) — the terminal's normalized cwd
/// must equal the session's. Absent session cwd (`cwd == None`) skips the
/// cwd check; a terminal without a cwd while the session HAS one is
/// excluded. Callers pass `session.cwd` (server/index.ts:841, :884).
/// Unlike `find_by_session`, returns every match.
pub fn find_all_by_session(&self, provider: &str, session_id: &str, cwd: Option<&str>) -> Vec<TerminalIdentity> {
    // isCwdScopedSessionMode (terminal-registry.ts:410-412): claude only.
    let scoped = provider == "claude";
    let session_cwd = cwd.filter(|c| !c.is_empty()).map(normalize_scoped_cwd);
    self.list()
        .into_iter()
        .filter(|t| {
            if t.provider.as_deref() != Some(provider)
                || t.session_id.as_deref() != Some(session_id)
            {
                return false;
            }
            if !scoped {
                return true;
            }
            match &session_cwd {
                None => true, // absent session cwd -> cwd check skipped
                Some(want) => t
                    .cwd
                    .as_deref()
                    .map(normalize_scoped_cwd)
                    .is_some_and(|have| have == *want), // no terminal cwd -> excluded
            }
        })
        .collect()
}

/// `normalizeScopedSessionCwd` (terminal-registry.ts:414-431): realpath
/// (native preferred, lexical fallback on error) -> backslashes to `/` ->
/// strip trailing slashes -> lowercase on win32.
fn normalize_scoped_cwd(cwd: &str) -> String {
    let resolved = std::fs::canonicalize(cwd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| cwd.to_string());
    let mut s = resolved.replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    if cfg!(windows) { s.to_lowercase() } else { s }
}
```

- [ ] **Step 5: Run tests, commit**

Run: `cargo test -p freshell-ws identity 2>&1 | tail -3` — expected ok.

```bash
git add crates/freshell-ws/src/identity.rs
git commit -m "feat(ws): identity find_all_by_session (cwd-scoped) for auto-title fan-out"
```

### Task 4: `IndexedSession` carries `first_user_message` + `title_source`

**Files:**
- Modify: `crates/freshell-sessions/src/directory_index.rs` (`IndexedSession` at `:57-89`)
- Modify: the provider `SessionSource` implementations in `crates/freshell-sessions/src/` that build `IndexedSession` rows (locate them via `grep -rn "IndexedSession {" crates/freshell-sessions/src/`)
- Test: existing test modules alongside those files

**Interfaces:**
- Produces: `IndexedSession` gains
  - `pub first_user_message: Option<String>` (capped at **4000** chars — Node cap, `server/index.ts` background loop input)
  - `pub title_source: Option<String>` (values mirror Node's `ParsedSessionTitleSource`; the sweep only ever compares against `"provider-generated"`)
- Consumed by: Task 5 sweep and Task 6 route.

**Verified state of the code (validator-A4-A3 — read before writing any
code):** `IndexedSession.first_user_message` ALREADY exists
(`crates/freshell-sessions/src/directory_index.rs:64`), and the claude
(`parse/claude.rs:369-375`), codex (`parse/codex.rs:399-402`), and amplifier
(`amplifier.rs:230-271`, `:328`) parsers already extract it single-pass.
opencode has NO `firstUserMessage` in Node either (`opencode.ts:184-195`) —
Rust must preserve `None` for opencode (it can never hit the
first-message/AI-title rungs; that is parity, not a gap). The 4000-char cap
(Node `types.ts:192-199`, trim → `slice(0,4000)`) is already ported at
`crates/freshell-sessions/src/text.rs:14, 98-108`. What remains is
`title_source` plus the two ADDITIVE work items in Step 4. Re-verify with:

```bash
grep -n "first_user_message\|title_source" crates/freshell-sessions/src/directory_index.rs
```

For any field that already exists, skip its addition and only verify (with a
test) the population semantics below.

- [ ] **Step 1: Mirror-map the Node source of truth.** Read the Node side:

```bash
grep -rn "titleSource" server/coding-cli/ shared/ | grep -v node_modules | head -30
grep -rn "provider-generated" server/ shared/ | head -20
grep -rn "firstUserMessage" server/coding-cli/session-indexer.ts | head -10
```

Write down, per provider (claude/codex/opencode/amplifier), when Node assigns
`titleSource: 'provider-generated'` to a parsed session (typically: the title
came from a provider-authored record — e.g. OpenCode's own session title —
rather than being derived from the first user message). Put the resulting
mapping table in the doc comment of the new field.

- [ ] **Step 2: Write the failing tests.** In the test module of each provider
source you touch (follow the existing parser-test patterns in
`crates/freshell-sessions/src/parse/` and `directory_index.rs` tests), add one
test per provider asserting the new fields against an existing fixture, e.g.
for a provider whose fixture has a provider-authored title:

```rust
#[test]
fn indexed_session_carries_first_user_message_and_provider_generated_title_source() {
    // Build the source over the existing fixture dir the neighbouring tests use.
    let sessions = /* same harness as the existing listing test in this module */;
    let s = sessions.iter().find(|s| s.session_id == "<fixture session id>").expect("fixture session");
    assert!(s.first_user_message.as_deref().is_some_and(|m| !m.is_empty()));
    // Only for providers Node marks provider-generated:
    assert_eq!(s.title_source.as_deref(), Some("provider-generated"));
}
```

and for claude/codex (first-message-derived titles): assert
`s.title_source.as_deref() != Some("provider-generated")` and that
`first_user_message` is populated from the first user turn, capped:

```rust
assert!(s.first_user_message.as_ref().unwrap().chars().count() <= 4000);
```

Add two more required tests (validator-A4-A3): (a) a claude fixture carrying
a `type:'summary'` record → `title_source == Some("provider-generated")`
(Step 4 item (a)); (b) an opencode fixture →
`s.first_user_message.is_none()` (Node has no opencode firstUserMessage —
parity, `opencode.ts:184-195`).

- [ ] **Step 3: Run to verify failure**

Run: `cargo test -p freshell-sessions 2>&1 | tail -10` — expected compile
errors on the new fields (or assertion failures if fields exist but are never
populated).

- [ ] **Step 4: Implement.** Add to `IndexedSession`:

```rust
/// First user message of the session (heuristic/AI title input),
/// capped at 4000 chars (Node cap on `session.firstUserMessage`).
pub first_user_message: Option<String>,
/// Mirror of Node's ParsedSessionTitleSource for the parsed (pre-override)
/// title. The auto-title pipeline only compares against "provider-generated"
/// (server/auto-title.ts:88). Mapping per provider: <table from Step 1>.
pub title_source: Option<String>,
```

Populate both in each `SessionSource` implementation. The parsers already
extract titles and first user messages single-pass (verified: claude
`parse/claude.rs:369-375`, codex `parse/codex.rs:399-402`, amplifier
`amplifier.rs:230-271`, `:328`; opencode stays `None` — parity). Two ADDITIVE
work items are REQUIRED here (validator-A4-A3):

1. Port Node's claude `type:'summary'` generated-title extractor
   (`server/coding-cli/claude-title.ts` semantics; `claude.ts:421-426`,
   `:504-505`) so `title_source` can be `"provider-generated"` for claude
   sessions carrying a provider-authored summary title — without it the AI
   gate misfires (the sweep would Gemini-title sessions Node leaves alone).
   This is ~10 additive lines in the existing parse loop in
   `parse/claude.rs`.
2. Thread `title_source` the way Node does via the applyOverride cache path
   (`session-indexer.ts:204-219`, `:1012`) — i.e. surface it through the
   directory-index overlay/cache used for override-applied listings, not
   only at parse time, so consumers (Task 5 sweep, Task 6 route) see the
   parsed source on cached rows too.

- [ ] **Step 5: Run the crate suite, then the workspace fast gate**

```bash
cargo test -p freshell-sessions 2>&1 | tail -5
cargo test --workspace --exclude freshell-tauri 2>&1 | tail -5
```
Expected: all green (the second run catches downstream struct-literal breaks —
fix any `IndexedSession { .. }` constructions in other crates by adding the
two new fields).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-sessions/
git commit -m "feat(sessions): IndexedSession carries first_user_message + title_source for auto-titling"
```

### Task 5: `auto_title_sweep.rs` — the background auto-name pass

**Files:**
- Create: `crates/freshell-server/src/auto_title_sweep.rs`
- Modify: `crates/freshell-server/src/main.rs` (add `mod auto_title_sweep;`; spawn the sweep inside the existing `if let Some(index) = &session_index { ... }` block at `main.rs:502-507`, next to `spawn_sessions_sweep`)

**Interfaces:**
- Consumes: Task 1 (`compute_session_title_sync`, `SessionTerminal`), Task 2
  (`AiKeyCell`, `GeminiTransport`, `generate_ai_session_title`), Task 3
  (`find_all_by_session`), Task 4 (`IndexedSession.first_user_message` /
  `.title_source`), `SettingsStore::{get, session_overrides, patch_session_override}`,
  `TerminalRegistry::update_title` (`crates/freshell-terminal/src/registry.rs:1061`),
  `freshell_protocol::{ServerMessage, TerminalTitleUpdated}`
  (`server_messages.rs:114-116, 900-905`), the `SessionIndex` accessor used by
  `spawn_sessions_sweep` (`main.rs:1238-1257`) to obtain the session snapshot.
- Produces:
  - `pub struct AutoTitleSweepState { pub settings: SettingsStore, pub identity: freshell_ws::identity::TerminalIdentityRegistry, pub registry: freshell_terminal::TerminalRegistry, pub broadcast_tx: std::sync::Arc<tokio::sync::broadcast::Sender<String>>, pub sessions_revision: std::sync::Arc<std::sync::atomic::AtomicI64>, pub ai_key: crate::ai_title::AiKeyCell, pub gemini: std::sync::Arc<dyn crate::ai_title::GeminiTransport>, pub pending_ai_titles: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>> }`
  - `pub struct SweepSession { pub provider: String, pub session_id: String, pub cwd: Option<String>, pub title: Option<String>, pub first_user_message: Option<String>, pub title_source: Option<String> }` (decoupled from `IndexedSession` so tests can inject sessions without a real index)
  - `pub async fn run_auto_title_pass(state: &AutoTitleSweepState, sessions: &[SweepSession]) -> bool` (returns "anything changed")
  - `pub fn spawn_auto_title_sweep(state: AutoTitleSweepState, index: std::sync::Arc<freshell_sessions::SessionIndex>, interval: std::time::Duration) -> tokio::task::JoinHandle<()>`
  - `pub fn emit_terminal_title_updated(tx: &tokio::sync::broadcast::Sender<String>, terminal_id: &str, title: &str)`

Node reference (port the ordering exactly): `server/index.ts:868-950` — per
session: skip unless ≥1 live terminal matches; compute sync plan; persist
`overridePatch`; push canonical title to out-of-sync terminals via
`registry.updateTitle` + broadcast `terminal.title.updated`; fire ONE Gemini
call per session key guarded by the in-process `pendingAiTitles` set; on AI
success, persist `titleSource:'ai'`, push + broadcast again, and refresh the
sidebar. Every per-session failure logs a warning and continues. One
`sessions.changed` per pass when anything changed.

- [ ] **Step 1: Write the failing tests.** Inline `#[cfg(test)]` module. Test
harness pattern: copy `sessions.rs`'s test helpers (`state()` at
`sessions.rs:349` builds a `SettingsStore` over a tempdir;
`spawn_headless_terminal_for_test` at `sessions.rs:401` spawns
`/bin/sh -c "sleep 5"`). The spawn helper is synchronous and returns nothing —
`fn spawn_headless_terminal_for_test(registry: &freshell_terminal::TerminalRegistry, terminal_id: &str)`
— the caller picks the terminal id and pairs it with `identity.upsert`,
exactly as the existing call site does (`sessions.rs:451`). Subscribe to
`broadcast_tx` BEFORE the call and drain frames after.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sweep_state(dir: &std::path::Path, ai_key: Option<&str>) -> (AutoTitleSweepState, tokio::sync::broadcast::Receiver<String>) {
        let settings = crate::settings_store::SettingsStore::load(Some(dir), vec![]);
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
        let state = AutoTitleSweepState {
            settings,
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            registry: freshell_terminal::TerminalRegistry::new(),
            broadcast_tx: std::sync::Arc::new(tx),
            sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            ai_key: crate::ai_title::AiKeyCell::init(ai_key.map(str::to_string), None),
            gemini: std::sync::Arc::new(FakeGemini(Ok("AI Title".into()))),
            pending_ai_titles: Default::default(),
        };
        (state, rx)
    }
    struct FakeGemini(Result<String, String>);
    impl crate::ai_title::GeminiTransport for FakeGemini {
        fn generate_content(&self, _p: String, _m: u32) -> crate::ai_title::BoxFuture<Result<String, String>> {
            let r = self.0.clone();
            Box::pin(async move { r })
        }
    }
    fn session(provider: &str, id: &str, cwd: &str, first: Option<&str>) -> SweepSession {
        SweepSession {
            provider: provider.into(), session_id: id.into(),
            cwd: Some(cwd.into()), title: None,
            first_user_message: first.map(str::to_string), title_source: None,
        }
    }

    #[tokio::test]
    async fn session_without_live_terminal_is_skipped_entirely() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), None);
        let changed = run_auto_title_pass(&state, &[session("claude", "s1", "/x/proj", Some("hi"))]).await;
        assert!(!changed);
        assert!(state.settings.session_overrides().get("claude:s1").is_none());
    }

    #[tokio::test]
    async fn no_key_first_message_finalizes_and_pushes_terminal_title_with_broadcast() {
        let dir = tempfile::tempdir().unwrap();
        let (state, mut rx) = sweep_state(dir.path(), None);
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state.identity.upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        let changed = run_auto_title_pass(&state, &[session("claude", "s1", "/x/proj", Some("Fix the flux\nrest"))]).await;
        assert!(changed);
        let ov = state.settings.session_overrides();
        let row = ov.get("claude:s1").unwrap();
        assert_eq!(row["titleOverride"], "Fix the flux");
        assert_eq!(row["titleSource"], "first-message");
        // terminal push + broadcast frame
        let mut saw_title_updated = false;
        let mut saw_sessions_changed = false;
        while let Ok(frame) = rx.try_recv() {
            let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
            if v["type"] == "terminal.title.updated" {
                assert_eq!(v["terminalId"], json!(tid));
                assert_eq!(v["title"], "Fix the flux");
                saw_title_updated = true;
            }
            if v["type"] == "sessions.changed" { saw_sessions_changed = true; }
        }
        assert!(saw_title_updated && saw_sessions_changed);
    }

    #[tokio::test]
    async fn ai_enabled_holds_dir_then_finalizes_ai_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state.identity.upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        let s = [session("claude", "s1", "/x/proj", Some("Fix the flux"))];
        run_auto_title_pass(&state, &s).await;
        // pass 1: dir placeholder persisted (never first-message when AI on)
        let row = state.settings.session_overrides().get("claude:s1").cloned().unwrap();
        assert_eq!(row["titleSource"], "dir");
        // AI one-shot lands asynchronously; wait for it
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let row = state.settings.session_overrides().get("claude:s1").cloned().unwrap();
            if row["titleSource"] == "ai" { break; }
        }
        let row = state.settings.session_overrides().get("claude:s1").cloned().unwrap();
        assert_eq!(row["titleOverride"], "AI Title");
        assert_eq!(row["titleSource"], "ai");
        // a second pass with the AI title already finalized changes nothing
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn user_rename_is_never_clobbered_and_sweep_pushes_it_to_stale_terminals() {
        let dir = tempfile::tempdir().unwrap();
        let (state, mut rx) = sweep_state(dir.path(), None);
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state.identity.upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        state.settings.patch_session_override("claude:s1",
            &[("titleOverride", Some(json!("My Name"))), ("titleSource", Some(json!("user")))]).await;
        let mut s = session("claude", "s1", "/x/proj", Some("hi"));
        s.title = Some("My Name".into()); // override-applied session title
        run_auto_title_pass(&state, &[s]).await;
        let row = state.settings.session_overrides().get("claude:s1").cloned().unwrap();
        assert_eq!(row["titleOverride"], "My Name"); // untouched
        // canonical push to the stale terminal still happens
        let frames: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(frames.iter().any(|f| f.contains("terminal.title.updated") && f.contains("My Name")));
    }

    #[tokio::test]
    async fn autogenerate_titles_off_disables_ai_but_keeps_heuristics() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        state.settings.patch(&json!({"sidebar": {"autoGenerateTitles": false}})).await.unwrap();
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state.identity.upsert(tid, Some("claude"), Some("s1"), Some("/x/proj"), 1);
        run_auto_title_pass(&state, &[session("claude", "s1", "/x/proj", Some("Fix it"))]).await;
        let row = state.settings.session_overrides().get("claude:s1").cloned().unwrap();
        assert_eq!(row["titleSource"], "first-message"); // heuristic path, no Gemini
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
    }
}
```

(Copy `spawn_headless_terminal_for_test` from `sessions.rs:401` into this test
module — it is module-private there.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-server auto_title_sweep 2>&1 | tail -10`
Expected: compile errors.

- [ ] **Step 3: Implement.** Core pass (mirror `server/index.ts:877-950`):

```rust
pub fn emit_terminal_title_updated(
    tx: &tokio::sync::broadcast::Sender<String>,
    terminal_id: &str,
    title: &str,
) {
    use freshell_protocol::{ServerMessage, TerminalTitleUpdated};
    let msg = ServerMessage::TerminalTitleUpdated(TerminalTitleUpdated {
        terminal_id: terminal_id.to_string(),
        title: title.to_string(),
    });
    if let Ok(frame) = serde_json::to_string(&msg) {
        let _ = tx.send(frame);
    }
}

fn broadcast_sessions_changed(state: &AutoTitleSweepState) {
    // same shape sessions.rs:204-211 sends
    let rev = state.sessions_revision.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let _ = state.broadcast_tx.send(
        serde_json::json!({"type": "sessions.changed", "revision": rev}).to_string(),
    );
}

pub async fn run_auto_title_pass(state: &AutoTitleSweepState, sessions: &[SweepSession]) -> bool {
    use crate::auto_title::{compute_session_title_sync, SessionTerminal};
    let settings = state.settings.get().await; // hoisted, like server/index.ts:878
    let ai_will_auto_name = state.ai_key.enabled() && settings.sidebar.auto_generate_titles;
    let overrides = state.settings.session_overrides(); // freshness-reloading read
    let mut changed = false;

    for s in sessions {
        // BOUNDED to live terminals only (server/index.ts:885); Node passes
        // session.cwd for the cwd-scoped claude match (index.ts:884, Task 3).
        let matching = state.identity.find_all_by_session(&s.provider, &s.session_id, s.cwd.as_deref());
        if matching.is_empty() {
            continue;
        }
        let key = format!("{}:{}", s.provider, s.session_id);
        let row = overrides.get(&key).and_then(|v| v.as_object());
        let override_title = row.and_then(|r| r.get("titleOverride")).and_then(|v| v.as_str());
        let override_source = row.and_then(|r| r.get("titleSource")).and_then(|v| v.as_str());
        // current live titles come from the registry (DirectoryEntry.title)
        let terminals: Vec<SessionTerminal> = matching
            .iter()
            .map(|t| SessionTerminal {
                terminal_id: t.terminal_id.clone(),
                title: registry_title(&state.registry, &t.terminal_id),
            })
            .collect();
        let plan = compute_session_title_sync(
            s.title.as_deref(), override_title, override_source,
            s.cwd.as_deref(), s.first_user_message.as_deref(),
            ai_will_auto_name, s.title_source.as_deref(), &terminals,
        );
        if let Some(patch) = &plan.override_patch {
            let _ = state.settings.patch_session_override(&key, &[
                ("titleOverride", Some(serde_json::json!(patch.title_override))),
                ("titleSource", Some(serde_json::json!(patch.title_source))),
            ]).await;
            changed = true;
        }
        if let Some(canon) = &plan.canonical_title {
            for tid in &plan.terminal_ids_to_update {
                state.registry.update_title(tid, canon);
                emit_terminal_title_updated(&state.broadcast_tx, tid, canon);
                changed = true;
            }
        }
        if plan.should_generate_ai {
            if let Some(first) = s.first_user_message.clone() {
                let should_spawn = {
                    let mut pending = state.pending_ai_titles.lock().expect("pending lock");
                    pending.insert(key.clone()) // false when already in flight
                };
                if should_spawn {
                    spawn_ai_title_task(state, key.clone(), s.provider.clone(),
                        s.session_id.clone(), s.cwd.clone(), first,
                        settings.ai.title_prompt.clone());
                }
            }
        }
    }
    if changed {
        broadcast_sessions_changed(state);
    }
    changed
}
```

`registry_title` reads the live title off the terminal registry — use the same
accessor the directory listing uses (`DirectoryEntry.title`,
`crates/freshell-terminal/src/registry.rs:286-302`; if there is no single-id
getter, add `pub fn title_of(&self, terminal_id: &str) -> Option<String>` to
`TerminalRegistry` next to `update_title` at `registry.rs:1061`).

`spawn_ai_title_task` — the one-shot (port of `server/index.ts:914-938`):

```rust
fn spawn_ai_title_task(
    state: &AutoTitleSweepState,
    key: String,
    provider: String,
    session_id: String,
    cwd: Option<String>,
    first_message: String,
    title_prompt: Option<String>,
) {
    let settings = state.settings.clone();
    let identity = state.identity.clone();
    let registry = state.registry.clone();
    let broadcast_tx = state.broadcast_tx.clone();
    let sessions_revision = state.sessions_revision.clone();
    let gemini = state.gemini.clone();
    let pending = state.pending_ai_titles.clone();
    tokio::spawn(async move {
        let result = crate::ai_title::generate_ai_session_title(
            &*gemini, &first_message, title_prompt.as_deref(),
        ).await;
        match result {
            Ok(Some(title)) => {
                let _ = settings.patch_session_override(&key, &[
                    ("titleOverride", Some(serde_json::json!(title))),
                    ("titleSource", Some(serde_json::json!("ai"))),
                ]).await;
                // Node's AI completion re-fans-out with session.cwd too
                // (server/index.ts:914-938 uses the same cwd-scoped lookup).
                for term in identity.find_all_by_session(&provider, &session_id, cwd.as_deref()) {
                    registry.update_title(&term.terminal_id, &title);
                    emit_terminal_title_updated(&broadcast_tx, &term.terminal_id, &title);
                }
                // Node: codingCliIndexer.refresh() -> sessionsSync publish.
                let rev = sessions_revision.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                let _ = broadcast_tx.send(
                    serde_json::json!({"type": "sessions.changed", "revision": rev}).to_string(),
                );
            }
            Ok(None) => {}
            Err(e) => tracing::warn!(error = %e, key = %key, "Gemini auto-title failed"),
        }
        pending.lock().expect("pending lock").remove(&key);
    });
}
```

`spawn_auto_title_sweep` — same shape as `spawn_sessions_sweep`
(`main.rs:1243-1256`): `tokio::time::interval(interval)` with
`MissedTickBehavior::Skip`; per tick, snapshot the index with the SAME accessor
`spawn_sessions_sweep` uses, map `IndexedSession` → `SweepSession`
(`provider`, `session_id`, `cwd`, override-applied `title`,
`first_user_message`, `title_source`), then `run_auto_title_pass`. IMPORTANT:
the `title` passed in must be the override-applied title; apply the same
overlay `session_directory.rs:648-671` (`apply_session_overrides`) applies, or
simpler: pass the parsed title and rely on the fact that a session with a
persisted override has a finalized/existing `titleSource` so
`compute_auto_title_patch` won't fight it, and canonical pushes use
`overrides[key].titleOverride` when present — implement as:
`title = overrides.get(&key).and_then(row titleOverride).or(parsed title)`.

- [ ] **Step 4: Run tests**

Run: `cargo test -p freshell-server auto_title_sweep 2>&1 | tail -5`
Expected: `test result: ok. 5 passed`

- [ ] **Step 5: Wire in `main.rs`.** Inside the existing
`if let Some(index) = &session_index { ... }` block (`main.rs:502-507`):

```rust
auto_title_sweep::spawn_auto_title_sweep(
    auto_title_sweep::AutoTitleSweepState {
        settings: settings.clone(),
        identity: terminal_identity.clone(),
        registry: registry.clone(),
        broadcast_tx: broadcast_tx.clone(),
        sessions_revision: sessions_revision.clone(),
        ai_key: ai_key.clone(),
        gemini: gemini.clone(),
        pending_ai_titles: Default::default(),
    },
    index.clone(),
    SESSIONS_SWEEP_INTERVAL, // already a Duration const (2s), main.rs:1107
);
```

(Use the exact local variable names present at that site; they are all
constructed earlier in `main`.) Then run the full crate suite:
`cargo test -p freshell-server 2>&1 | tail -5` — green.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-server/src/auto_title_sweep.rs crates/freshell-server/src/main.rs
git commit -m "feat(server): background auto-title sweep (dir -> first-message -> Gemini) with terminal.title.updated pushes"
```

### Task 6: `generate_title` route — provider-generated short-circuit, AI branch, `sessions.changed`

**Files:**
- Modify: `crates/freshell-server/src/sessions.rs` (`SessionsState` at `:29-65`, `generate_title` at `:294-341`, tests `:343-943`)
- Modify: `crates/freshell-server/src/main.rs` (SessionsState construction at `:689-703` gains the new fields)

**Interfaces:**
- Consumes: Task 2 (`AiKeyCell`, `GeminiTransport`, `generate_ai_session_title`), Task 4 (`title_source` on indexed sessions), `SessionIndex` handle.
- Produces: `SessionsState` gains
  - `pub ai_key: crate::ai_title::AiKeyCell`
  - `pub gemini: std::sync::Arc<dyn crate::ai_title::GeminiTransport>`
  - `pub index: Option<std::sync::Arc<freshell_sessions::SessionIndex>>`
  (Task 21's e2e and Task 19's client rely on the response contract below.)

Node contract to match exactly (`server/sessions-router.ts:167-221`):
1. blank `firstMessage` → **400** `{"error":"firstMessage is required"}` (unchanged).
2. parsed session's `titleSource == "provider-generated"` → **200** `{"title": <parsed title or null>, "source": "provider-generated"}`, NO write.
3. AI disabled (no key): existing heuristic path (unchanged), but now ALSO broadcast `sessions.changed` after a write (Node gets this via `codingCliIndexer.refresh()`; this closes desync D11).
4. AI enabled: `generate_ai_session_title`; `Ok(None)` → `{"title":null,"source":"none"}` no write; `Ok(Some(t))` → `patch_session_override(key, titleOverride=t, titleSource="ai")`, broadcast `sessions.changed`, respond with the STORED (ladder-resolved) `{"title","source"}`; `Err(e)` → **200** `{"title":null,"source":"none","error":"<e>"}`.
5. NO `autoGenerateTitles` gate on this route (Scope Decision 7).

- [ ] **Step 1: Write the failing tests** (append to `sessions.rs` tests,
reusing the existing helpers `state()`, `body_json()`, `uuid_like()`):

```rust
#[tokio::test]
async fn generate_title_uses_gemini_when_key_present_and_broadcasts_sessions_changed() {
    let dir = tempfile::tempdir().unwrap();
    let mut st = state(dir.path());
    st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
    st.gemini = std::sync::Arc::new(FakeGemini(Ok("  Sardine crash investigation  ".into())));
    let mut rx = st.broadcast_tx.subscribe();
    let sid = uuid_like();
    let resp = post_generate_title(&st, &sid, "investigate the sardine crash").await;
    let body = body_json(resp).await;
    assert_eq!(body["title"], "Sardine crash investigation");
    assert_eq!(body["source"], "ai");
    let row = st.settings.session_overrides().get(&format!("claude:{sid}")).cloned().unwrap();
    assert_eq!(row["titleSource"], "ai");
    let frames: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
    assert!(frames.iter().any(|f| f.contains("sessions.changed")));
}

#[tokio::test]
async fn generate_title_gemini_error_returns_200_none_with_error_and_no_write() {
    let dir = tempfile::tempdir().unwrap();
    let mut st = state(dir.path());
    st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
    st.gemini = std::sync::Arc::new(FakeGemini(Err("boom".into())));
    let sid = uuid_like();
    let body = body_json(post_generate_title(&st, &sid, "hello").await).await;
    assert_eq!(body["title"], serde_json::Value::Null);
    assert_eq!(body["source"], "none");
    assert_eq!(body["error"], "boom");
    assert!(st.settings.session_overrides().get(&format!("claude:{sid}")).is_none());
}

#[tokio::test]
async fn generate_title_after_user_rename_is_still_ladder_blocked_for_ai() {
    // AI write attempted, ladder rejects, response echoes the user's stored title.
    let dir = tempfile::tempdir().unwrap();
    let mut st = state(dir.path());
    st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
    st.gemini = std::sync::Arc::new(FakeGemini(Ok("AI Title".into())));
    let sid = uuid_like();
    st.settings.patch_session_override(&format!("claude:{sid}"),
        &[("titleOverride", Some(serde_json::json!("Mine"))), ("titleSource", Some(serde_json::json!("user")))]).await;
    let body = body_json(post_generate_title(&st, &sid, "hello").await).await;
    assert_eq!(body["title"], "Mine");
    assert_eq!(body["source"], "user");
}

#[tokio::test]
async fn generate_title_provider_generated_short_circuits_without_write() {
    // Requires a SessionsState.index stub carrying one session with
    // title_source == "provider-generated". Build a SessionIndex over a
    // tempdir fixture the same way sessions.rs test
    // `patch_override_is_visible_through_session_directory_overlay` (:848)
    // does, seeding one opencode session file, then assert:
    //   resp == { "title": <parsed title>, "source": "provider-generated" }
    // and session_overrides() has no row for the key.
}
```

Also add a `FakeGemini` struct to this test module (same 4-line impl as Task
5's) and a small `post_generate_title(&SessionsState, sid, first)` helper that
oneshots `POST /api/sessions/{sid}/generate-title` with
`{"firstMessage": first}` and the auth header — copy the router-oneshot
pattern from the existing `generate_title_*` tests at `sessions.rs:731-846`.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-server generate_title 2>&1 | tail -10`
Expected: compile errors on the new `SessionsState` fields.

- [ ] **Step 3: Implement.** Extend `SessionsState` with the three new fields
(update `state()` in the test module and `main.rs:689-703` construction; pass
`index: session_index.clone()` — it is an `Option<Arc<SessionIndex>>` there).
Rewrite `generate_title`'s body after the 400 guard:

```rust
let key = composite_key(&raw_id, &provider_of(&q));
// 2. provider-generated short-circuit (sessions-router.ts:186-192)
if let Some(index) = &state.index {
    if let Some(parsed) = lookup_indexed_session(index, &key).await {
        if parsed.title_source.as_deref() == Some("provider-generated") {
            return json_ok(serde_json::json!({
                "title": parsed.title.clone().map(serde_json::Value::from).unwrap_or(serde_json::Value::Null),
                "source": "provider-generated",
            }));
        }
    }
}
if !state.ai_key.enabled() {
    // existing heuristic branch, unchanged, PLUS after a non-noop
    // patch_session_override: broadcast sessions.changed (copy the
    // revision+send block from patch_session, sessions.rs:204-211).
} else {
    match crate::ai_title::generate_ai_session_title(
        &*state.gemini, &first_message, state.settings.get().await.ai.title_prompt.as_deref(),
    ).await {
        Ok(None) => return json_ok(serde_json::json!({"title": null, "source": "none"})),
        Ok(Some(title)) => {
            let stored = state.settings.patch_session_override(&key, &[
                ("titleOverride", Some(serde_json::json!(title))),
                ("titleSource", Some(serde_json::json!("ai"))),
            ]).await;
            broadcast_sessions_changed_from(&state); // revision + send, as in patch_session
            return json_ok(serde_json::json!({
                "title": stored.get("titleOverride").cloned().unwrap_or(serde_json::Value::Null),
                "source": stored.get("titleSource").cloned().unwrap_or(serde_json::Value::Null),
            }));
        }
        Err(e) => return json_ok(serde_json::json!({"title": null, "source": "none", "error": e})),
    }
}
```

`lookup_indexed_session` snapshots the index (same accessor as Task 5) and
finds the session whose `format!("{}:{}", provider, session_id)` equals `key`.
`json_ok` = the module's existing 200-JSON response helper (reuse whatever
`generate_title` currently uses). Factor the revision+broadcast block from
`patch_session` (`sessions.rs:204-211`) into a private
`fn broadcast_sessions_changed_from(state: &SessionsState)` used by both.

- [ ] **Step 4: Run tests**

`cargo test -p freshell-server sessions 2>&1 | tail -5` — ALL existing
`generate_title_*` tests must still pass (heuristic behavior with no key is
unchanged apart from the new broadcast; the existing
`generate_title_no_key_uses_first_message_heuristic` test must remain green).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-server/src/sessions.rs crates/freshell-server/src/main.rs
git commit -m "feat(server): generate-title Gemini branch + provider-generated short-circuit + sessions.changed broadcast (D11)"
```

### Task 7: `POST /api/ai/terminals/{id}/summary`

**Files:**
- Create: `crates/freshell-server/src/ai_router.rs`
- Modify: `crates/freshell-server/src/main.rs` (add `mod ai_router;`, merge `ai_router::router(...)` into the app next to the other routers at ~`main.rs:688`)

**Interfaces:**
- Consumes: Task 2 (`AiKeyCell`, `GeminiTransport`, `build_terminal_summary_prompt`, `strip_ansi`, `TERMINAL_SUMMARY_MAX_OUTPUT_TOKENS`), `TerminalRegistry` scrollback snapshot (use the same accessor `terminal_tabs::maybe_capture` uses at `crates/freshell-freshagent/src/terminal_tabs.rs:1299-1358`), `boot::is_authed`.
- Produces:
  - `pub struct AiRouterState { pub auth_token: std::sync::Arc<String>, pub registry: freshell_terminal::TerminalRegistry, pub ai_key: crate::ai_title::AiKeyCell, pub gemini: std::sync::Arc<dyn crate::ai_title::GeminiTransport> }`
  - `pub fn router(state: AiRouterState) -> axum::Router` serving `POST /api/ai/terminals/{terminal_id}/summary`
  - `pub fn heuristic_summary(snapshot_tail: &str) -> String` (pure, unit-tested)

Node contract (`server/ai-router.ts:19-71`): no request body read; terminal
missing → **404** `{"error":"Terminal not found"}`; no key → **200**
`{"description": <heuristic>, "source": "heuristic"}`; Gemini ok → **200**
`{"description": <text.trim() capped 240, falling back to heuristic when empty>, "source": "ai"}`;
Gemini throws → **200** heuristic with `"source":"heuristic"`. Gemini input =
last **20,000** chars of the PTY scrollback through
`build_terminal_summary_prompt` (which ANSI-strips), `maxOutputTokens` 120.
Heuristic (`ai-router.ts:27-34`): strip ANSI, split lines, first two non-empty
lines joined `" - "`, cap 240, default `"Terminal session"`.

- [ ] **Step 1: Write the failing tests** (inline module; axum
`tower::ServiceExt::oneshot` pattern as in `pane_ops.rs:943-1025`):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heuristic_summary_first_two_lines_dash_joined_capped_240() {
        assert_eq!(heuristic_summary("\n\n  first line  \n second \n third"), "first line - second");
        assert_eq!(heuristic_summary(""), "Terminal session");
        assert_eq!(heuristic_summary("\u{1b}[31monly\u{1b}[0m"), "only");
        let long = format!("{}\n{}", "a".repeat(300), "b");
        assert_eq!(heuristic_summary(&long).chars().count(), 240);
    }

    #[tokio::test]
    async fn summary_404_when_terminal_unknown() { /* oneshot POST /api/ai/terminals/nope/summary with auth -> 404 {"error":"Terminal not found"} */ }

    #[tokio::test]
    async fn summary_heuristic_when_no_key_and_when_gemini_fails() {
        // spawn a real headless terminal (spawn_headless_terminal_for_test pattern),
        // no key -> 200 {"description": <heuristic>, "source": "heuristic"};
        // then with key + FakeGemini(Err) -> same shape, source "heuristic".
    }

    #[tokio::test]
    async fn summary_ai_path_caps_240_and_reports_source_ai() {
        // key + FakeGemini(Ok(long text)) -> 200, description.chars().count() == 240, source "ai"
    }

    #[tokio::test]
    async fn summary_requires_auth() { /* no x-auth-token -> 401 */ }
}
```

Write each stubbed comment above as full test code following the harness of
Task 6 (build `AiRouterState`, `ai_router::router(state)`, oneshot with
`x-auth-token`). This route uses the same auth style as the other
freshell-server routers (`boot::is_authed` on `HeaderMap` → 401
`unauthorized()`), matching Node's standard token middleware.

- [ ] **Step 2: Run to verify failure** — `cargo test -p freshell-server ai_router 2>&1 | tail -5` → compile errors.

- [ ] **Step 3: Implement**

```rust
pub fn heuristic_summary(snapshot_tail: &str) -> String {
    let cleaned = crate::ai_title::strip_ansi(snapshot_tail);
    let mut lines = cleaned.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next().unwrap_or("Terminal session");
    let second = lines.next().unwrap_or("");
    let joined = if second.is_empty() { first.to_string() } else { format!("{first} - {second}") };
    let capped: String = joined.chars().take(240).collect();
    if capped.is_empty() { "Terminal session".to_string() } else { capped }
}

async fn terminal_summary(
    State(state): State<AiRouterState>,
    AxumPath(terminal_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(snapshot) = registry_snapshot(&state.registry, &terminal_id) else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Terminal not found"}))).into_response();
    };
    // last 20_000 chars (server/ai-router.ts:39)
    let tail: String = {
        let chars: Vec<char> = snapshot.chars().collect();
        chars[chars.len().saturating_sub(20_000)..].iter().collect()
    };
    let heuristic = heuristic_summary(&tail);
    if !state.ai_key.enabled() {
        return json_200(serde_json::json!({"description": heuristic, "source": "heuristic"}));
    }
    let prompt = crate::ai_title::build_terminal_summary_prompt(&tail);
    match state.gemini.generate_content(prompt, crate::ai_title::TERMINAL_SUMMARY_MAX_OUTPUT_TOKENS).await {
        Ok(text) => {
            let desc: String = text.trim().chars().take(240).collect();
            let desc = if desc.is_empty() { heuristic } else { desc };
            json_200(serde_json::json!({"description": desc, "source": "ai"}))
        }
        Err(e) => {
            tracing::warn!(error = %e, terminal_id = %terminal_id, "AI summary failed; using heuristic");
            json_200(serde_json::json!({"description": heuristic, "source": "heuristic"}))
        }
    }
}
```

`registry_snapshot` uses the accessor found in Step 1's referenced
`maybe_capture` (`terminal_tabs.rs:1299-1358`); returns `None` for unknown
terminals. `json_200`/`unauthorized` mirror the helpers used by
`sessions.rs`. Router:

```rust
pub fn router(state: AiRouterState) -> Router {
    Router::new()
        .route("/api/ai/terminals/{terminal_id}/summary", axum::routing::post(terminal_summary))
        .with_state(state)
}
```

- [ ] **Step 4: Run tests** — `cargo test -p freshell-server ai_router 2>&1 | tail -5` → ok.

- [ ] **Step 5: Wire into `main.rs`** (merge next to the sessions router,
passing `auth_token`, `registry`, `ai_key`, `gemini`), run
`cargo test -p freshell-server 2>&1 | tail -3`, then commit:

```bash
git add crates/freshell-server/src/ai_router.rs crates/freshell-server/src/main.rs
git commit -m "feat(server): POST /api/ai/terminals/:id/summary with Gemini + heuristic fallback"
```

---

# PART B — Durable tabs registry (Item 3: CFG-08 + AUTO-15)

Node reference: `server/tabs-registry/store.ts` (1317 lines) + `types.ts`.
On-disk layout to reproduce (production root `~/.freshell/tabs-registry/`):

```
v1/manifest.json                        # commit point (tmp + rename)
v1/manifest.json.tmp                    # fixed-name transient
v1/manifest.json.invalid-YYYYMMDD-HHMMSS# archived unusable manifest
v1/objects/<sha256-hex-64>.json         # immutable content-addressed objects
v1/tmp/<sha256>.<pid>.<millis>.tmp      # transient object writes
tabs-registry.jsonl                     # LEGACY input (migrated then archived)
tabs-registry.jsonl.migrated-YYYYMMDD-HHMMSS
```

The existing `crates/freshell-ws/src/tabs_persist.rs` **snapshot-generation
store is unrelated and stays as-is** (recovery inventory; nothing reads it back
into the registry). The two stores coexist, exactly as scoped in the task spec.

### Task 8: `tabs_store_model.rs` — state model, caps, hashes, maintenance

**Files:**
- Create: `crates/freshell-ws/src/tabs_store_model.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (add `pub mod tabs_store_model;`)
- Create fixture: `crates/freshell-ws/tests/fixtures/node-tabs-registry-hash.json` (Step 1)

**Interfaces (produced; Tasks 9–11 rely on these exact items):**

```rust
pub const DAY_MS: i64 = 86_400_000;
pub const DEFAULT_CLOSED_RETENTION_DAYS: i64 = 30;
pub const DEFAULT_OPEN_SNAPSHOT_TTL_MINUTES: i64 = 30;
pub const DEFAULT_DEVICE_DISPLAY_TTL_DAYS: i64 = 7;

#[derive(Clone, Debug)]
pub struct TabsStoreCaps {
    pub max_records_per_push: usize,                       // 500
    pub max_open_records_per_client_snapshot: usize,       // 500
    pub max_closed_records_per_push: usize,                // 500
    pub max_panes_per_record: usize,                       // 20
    pub max_serialized_push_bytes: usize,                  // 1 MiB
    pub max_serialized_client_snapshot_object_bytes: usize,// 512 KiB
    pub max_serialized_manifest_bytes: usize,              // 256 KiB
    pub max_serialized_closed_tombstone_object_bytes: usize,// 2 MiB
    pub max_serialized_device_metadata_object_bytes: usize,// 256 KiB (devices AND clientRevisions)
    pub max_compact_state_bytes: usize,                    // 5 MiB
    pub max_client_snapshot_refs: usize,                   // 200
    pub max_client_revision_watermarks: usize,             // 200
    pub max_devices: usize,                                // 200
    pub max_closed_tombstones: usize,                      // 2000
    pub max_legacy_line_bytes: usize,                      // 256 KiB
    pub max_legacy_unique_tab_keys: usize,                 // 10_000
    pub max_migration_retained_bytes: usize,               // 5 MiB
}
pub fn default_caps() -> TabsStoreCaps

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientOpenSnapshot {
    pub device_id: String,
    pub device_label: String,
    pub client_instance_id: String,
    pub snapshot_revision: i64,
    pub last_push_payload_hash: String,     // 64-hex, ALL records
    pub open_snapshot_payload_hash: String, // 64-hex, open records only
    pub snapshot_received_at: i64,          // SERVER receipt time (TTL basis)
    pub records: Vec<serde_json::Value>,    // open records only, verbatim
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRevisionWatermark {
    pub device_id: String,
    pub client_instance_id: String,
    pub snapshot_revision: i64,
    pub last_seen_at: i64,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryDeviceEntry { pub device_id: String, pub device_label: String, pub last_seen_at: i64 }

#[derive(Clone, Debug, Default)]
pub struct CompactState {
    pub saved_at: i64,
    pub max_closed_retention_days: i64,   // 1..=30, default 30
    pub open_snapshots_by_client: std::collections::HashMap<String, ClientOpenSnapshot>,
    pub client_revisions_by_client: std::collections::HashMap<String, ClientRevisionWatermark>,
    pub closed_by_tab_key: std::collections::HashMap<String, serde_json::Value>,
    pub devices_by_id: std::collections::HashMap<String, RegistryDeviceEntry>,
}
pub fn empty_state(now: i64, max_closed_retention_days: i64) -> CompactState

pub fn canonical_stringify(v: &serde_json::Value) -> String  // recursive byte-order key sort (reuse the BTreeMap technique of tabs_persist::canonicalize, tabs_persist.rs:51-63)
pub fn sha256_hex_full(raw: &str) -> String                  // FULL 64-hex (sha2 crate; NOT tabs_persist's truncated digest)
pub fn base64url_no_pad(bytes: &[u8]) -> String
pub fn client_snapshot_key(device_id: &str, client_instance_id: &str) -> Result<String, String>
    // `${base64url(deviceId)}:${base64url(clientInstanceId)}`; Err on blank/whitespace ids (store.ts:371-377)
pub fn build_snapshot_payload_hash(device_id: &str, device_label: &str, client_instance_id: &str, snapshot_revision: i64, records: &[serde_json::Value]) -> String
    // sha256(canonical_stringify({deviceId, deviceLabel, clientInstanceId, snapshotRevision, records})) — store.ts:530-538
pub fn archive_timestamp(now_ms: i64) -> String              // local-time YYYYMMDD-HHMMSS (store.ts:596-607)

pub fn validate_registry_record(v: &serde_json::Value) -> Result<(), String>
    // TabRegistryRecordSchema port: non-empty tabKey/tabId/serverInstanceId/deviceId/deviceLabel/tabName;
    // status "open"|"closed"; closedAt REQUIRED (int>=0) when closed; revision/createdAt/updatedAt int>=0;
    // paneCount int>=0; titleSetByUser bool; panes array; per-pane non-empty paneId, kind in
    // {terminal,browser,editor,picker,claude-chat,fresh-agent,extension}, payload object.
pub fn normalize_registry_pane_kinds(record: &mut serde_json::Value)
    // record-level migration: pane kind "agent-chat" -> "fresh-agent" with payload rewrite
    // (types.ts:28-54; port shared/fresh-agent.ts::migrateLegacyFreshAgentContent — read it first).
pub fn validate_record_caps(records: &[serde_json::Value], caps: &TabsStoreCaps) -> Result<(), String>
    // count cap, DUPLICATE tabKey rejection, pane caps (checks BOTH panes.len() and paneCount) — store.ts:418-436
pub fn apply_queued_maintenance(state: &mut CompactState, now: i64, caps: &TabsStoreCaps)
    // store.ts:484-522: open snapshots TTL-filter ONLY (30 min on snapshot_received_at, NO count slice);
    // clientRevisions TTL(7d on last_seen_at) + LRU slice to max_client_revision_watermarks;
    // closed tombstones: retention filter (closedAt ?? updatedAt), sort closed-desc, slice to 2000;
    // devices: TTL(7d) + LRU slice to 200.
pub fn validate_state_caps(state: &CompactState, caps: &TabsStoreCaps) -> Result<(), String>
    // store.ts:439-467: snapshot-ref count, per-snapshot open-record count, watermark count,
    // tombstone count, device count, aggregate serialized state bytes <= 5 MiB.
// Ordering helpers shared with tabs.rs (move these two out of tabs.rs private scope or re-export):
pub fn compare_by_event_time(a: &serde_json::Value, b: &serde_json::Value) -> std::cmp::Ordering
pub fn pick_event_winner<'a>(a: &'a serde_json::Value, b: &'a serde_json::Value) -> &'a serde_json::Value
```

- [ ] **Step 1: Capture the Node hash fixtures (the Scope Decision 5 proof,
scoped per validator-A2).** Run this one-off inside the worktree to generate
the camelCase differential fixture with Node's own `stableStringify` + sha256
semantics — keep it as the CROSS-IMPL hash-compatibility proof for the
reachable (all-camelCase) payload-key inventory:

```bash
mkdir -p crates/freshell-ws/tests/fixtures  # dir does not exist yet; redirect below fails with ENOENT without this
node --input-type=module -e '
import { createHash } from "node:crypto";
const stableStringify = (v) => {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") {
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort((a,b) => a.localeCompare(b));
    return "{" + keys.map(k => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
};
const snapshot = { deviceId: "dev-1", deviceLabel: "Device One", clientInstanceId: "client-1",
  snapshotRevision: 3, records: [ { tabKey: "tk-1", tabId: "t1", serverInstanceId: "srv",
  deviceId: "dev-1", deviceLabel: "Device One", clientInstanceId: "client-1", tabName: "Tab",
  status: "open", revision: 2, createdAt: 100, updatedAt: 200, paneCount: 1,
  titleSetByUser: false, panes: [ { paneId: "p1", kind: "terminal", payload: { mode: "shell" } } ] } ] };
const raw = stableStringify(snapshot);
console.log(JSON.stringify({ input: snapshot, canonical: raw,
  sha256: createHash("sha256").update(raw, "utf8").digest("hex") }, null, 2));
' > crates/freshell-ws/tests/fixtures/node-tabs-registry-hash.json
cat crates/freshell-ws/tests/fixtures/node-tabs-registry-hash.json | head -5
```

Then extend the Node-generated fixture (or add a second fixture file) to
include map keys with DIVERGENT-order pairs — base64url snapshot keys with
mixed case and tabKeys like `<uuid>:--0MNzJnmn-oNjHjMXnPf` vs
`<uuid>:_fuUJwgE1XOONeyzvyZMk` (the real-store divergence class from
validator-A2) — used to assert Rust's SELF-consistent write/read roundtrip
and to pin Rust's byte-order output; cross-impl hash equality is NOT asserted
for these keys (ledger A2-R1). Note: golden Node MIGRATION outputs (snapshot
keys `ZGV2QQ:bGVnYWN5LW1pZ3JhdGlvbg` / `ZGV2Qg:bGVnYWN5LW1pZ3JhdGlvbg`, snapA
payload hash
`d7304a3a73d48d1417661e0cd3b1f696bf42ae6b065aa918ea99b1ebb86b865c`, snapB
`0fb29d631c8257861f60371576fc458dbd626817c135b888d508027a90e6dcbc`, fixed
clock 1_750_000_000_000) are preserved at
`.worktrees/.the-usual-logs/naming-persistence-sweep/artifacts/a8a9-harness/`
and can be regenerated by importing the real `store.ts` via `npx tsx`
(v4.23.5 available).

- [ ] **Step 2: Write the failing tests** (inline `#[cfg(test)]`):

```rust
#[test]
fn payload_hash_matches_node_stable_stringify_fixture() {
    let fx: serde_json::Value = serde_json::from_str(include_str!(
        "../tests/fixtures/node-tabs-registry-hash.json")).unwrap();
    let input = &fx["input"];
    let records: Vec<serde_json::Value> = input["records"].as_array().unwrap().clone();
    let hash = build_snapshot_payload_hash(
        input["deviceId"].as_str().unwrap(), input["deviceLabel"].as_str().unwrap(),
        input["clientInstanceId"].as_str().unwrap(), input["snapshotRevision"].as_i64().unwrap(),
        &records);
    assert_eq!(hash, fx["sha256"].as_str().unwrap());
}
#[test]
fn client_snapshot_key_is_base64url_and_rejects_blank() {
    let k = client_snapshot_key("dev:1", "cli:2").unwrap();
    assert!(!k[..k.rfind(':').unwrap()].contains("dev:1")); // encoded, ':' unambiguous
    assert_ne!(client_snapshot_key("a", "b:c").unwrap(), client_snapshot_key("a:b", "c").unwrap());
    assert!(client_snapshot_key("  ", "x").is_err());
}
#[test]
fn maintenance_expires_open_snapshots_after_30_minutes_but_keeps_watermarks_7_days() {
    let caps = default_caps();
    let mut st = empty_state(0, 30);
    st.open_snapshots_by_client.insert("k".into(), ClientOpenSnapshot {
        device_id: "d".into(), device_label: "D".into(), client_instance_id: "c".into(),
        snapshot_revision: 1, last_push_payload_hash: "0".repeat(64),
        open_snapshot_payload_hash: "0".repeat(64), snapshot_received_at: 0, records: vec![] });
    st.client_revisions_by_client.insert("k".into(), ClientRevisionWatermark {
        device_id: "d".into(), client_instance_id: "c".into(), snapshot_revision: 1, last_seen_at: 0 });
    apply_queued_maintenance(&mut st, 31 * 60_000, &caps);
    assert!(st.open_snapshots_by_client.is_empty());
    assert_eq!(st.client_revisions_by_client.len(), 1); // survives past open TTL (store.test.ts:418)
    apply_queued_maintenance(&mut st, 8 * DAY_MS, &caps);
    assert!(st.client_revisions_by_client.is_empty());
}
#[test]
fn state_caps_reject_snapshot_ref_overflow_instead_of_truncating() {
    let caps = TabsStoreCaps { max_client_snapshot_refs: 1, ..default_caps() };
    let mut st = empty_state(0, 30);
    for i in 0..2 {
        st.open_snapshots_by_client.insert(format!("k{i}"), /* snapshot as above */);
    }
    apply_queued_maintenance(&mut st, 1, &caps);
    assert_eq!(st.open_snapshots_by_client.len(), 2); // maintenance NEVER slices open snapshots
    assert!(validate_state_caps(&st, &caps).is_err());  // the push is REJECTED instead
}
#[test]
fn tombstones_prune_to_newest_closed_first_2000_cap() { /* build 3 tombstones with distinct closedAt, cap=2, assert the two newest survive */ }
#[test]
fn record_validation_rejects_duplicate_tab_keys_and_pane_cap() { /* two records same tabKey -> Err; 21 panes -> Err; paneCount=21 with 1 pane -> Err */ }
#[test]
fn record_validation_requires_closed_at_on_closed_records() { /* status closed without closedAt -> Err */ }
#[test]
fn agent_chat_pane_kind_migrates_to_fresh_agent() { /* record with pane kind "agent-chat" -> normalize -> kind "fresh-agent" */ }
#[test]
fn divergent_order_map_keys_roundtrip_self_consistently_in_byte_order() {
    // Load the divergent-map-keys fixture from Step 1 (mixed-case base64url
    // snapshot keys; tabKeys `<uuid>:--0MNzJnmn-oNjHjMXnPf` vs
    // `<uuid>:_fuUJwgE1XOONeyzvyZMk`). Assert canonical_stringify orders the
    // sibling keys in BYTE order ('-' 0x2D < 'A-Z' < '_' 0x5F < 'a-z') and
    // that re-parsing the canonical output and re-stringifying it is a fixed
    // point (Rust's self-consistent write/read roundtrip). Cross-impl hash
    // equality is deliberately NOT asserted here (validator-A2, ledger A2-R1).
}
#[test]
fn adversarial_payload_keys_pin_rust_byte_order_canonical_output() {
    // Cross-impl hash compatibility is NOT claimed for such keys — Node's
    // ICU localeCompare orders them differently (known divergence class,
    // ledger A2-R1); this pins Rust's deterministic byte-order output only.
    let v = serde_json::json!({"Zebra": 1, "a-b": 1, "a_b": 1, "é": 1});
    assert_eq!(canonical_stringify(&v), "{\"Zebra\":1,\"a-b\":1,\"a_b\":1,\"é\":1}");
}
```

Write the elided test bodies in full following the shapes above.

- [ ] **Step 3: Run to verify failure** — `cargo test -p freshell-ws tabs_store_model 2>&1 | tail -5` → compile errors.

- [ ] **Step 4: Implement** every item in the Interfaces block. Implementation
notes (each maps 1:1 to a cited Node behavior — follow them exactly):
- `canonical_stringify`: recursively rebuild objects into
  `serde_json::Map` via `BTreeMap<String, Value>` then `to_string()`. Do NOT
  drop `null`s (Node drops only `undefined`, which serde_json cannot represent).
- `base64url_no_pad`: hand-rolled 20-line encoder over the standard alphabet
  with `-`/`_` and no padding (no new crate deps).
- `apply_queued_maintenance` ordering: open TTL filter → watermark TTL+LRU →
  tombstone retention+sort+slice → device TTL+LRU (store.ts:484-522).
- `validate_state_caps` byte math: aggregate = sum of
  `canonical_stringify(component).len()` for the four components.
- Move/`pub(crate)`-export `compare_by_event_time` / `pick_event_winner` /
  `source_key` / `sort_by_updated_desc` / `sort_by_closed_desc` from `tabs.rs`
  (`tabs.rs:443-508`) into this module and re-import them in `tabs.rs` so both
  files share one implementation (keeps `tabs.rs` under 1K lines as it grows in
  Task 11).

- [ ] **Step 5: Run tests, commit**

`cargo test -p freshell-ws tabs_store 2>&1 | tail -5` → ok, and
`cargo test -p freshell-ws tabs 2>&1 | tail -5` (existing tabs.rs tests still
green after the helper move).

```bash
git add crates/freshell-ws/src/tabs_store_model.rs crates/freshell-ws/src/tabs.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/tests/fixtures/node-tabs-registry-hash.json
git commit -m "feat(ws): tabs registry durable-store model — caps, hashes, TTL maintenance, record validation"
```

### Task 9: `tabs_store.rs` — on-disk store (open/commit/recovery)

**Files:**
- Create: `crates/freshell-ws/src/tabs_store.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (add `pub mod tabs_store;`)

**Interfaces:**
- Consumes: Task 8 (everything in `tabs_store_model`), `tabs_persist::atomic_write_durable` (`tabs_persist.rs:706`, sibling-temp contract — used for the manifest only).
- Produces:
  - `pub enum TabsStoreOpenError { Corrupt(String), Io(std::io::Error) }` — `Corrupt` FAILS SERVER BOOT (Node parity: `open()` throws; `store.ts:676-690`).
  - `pub struct DurableTabsStore { /* root, state, manifest_revision, caps */ }`
  - `impl DurableTabsStore:`
    - `pub fn open(root: &std::path::Path, caps: TabsStoreCaps, now_ms: i64) -> Result<Self, TabsStoreOpenError>`
    - `pub fn state(&self) -> &CompactState`
    - `pub fn commit(&mut self, next: CompactState, now_ms: i64) -> std::io::Result<()>` — validates caps (as `io::Error` on violation), writes changed objects, publishes the manifest atomically, swaps in-memory state ONLY after publish, then best-effort clears `v1/tmp/`.
  - `pub(crate) fn write_object(root: &std::path::Path, value: &serde_json::Value, max_bytes: usize) -> std::io::Result<ObjectRef>`
  - `#[derive(serde::Serialize, serde::Deserialize)] #[serde(rename_all = "camelCase")] pub struct ObjectRef { pub path: String, pub sha256: String, pub bytes: u64 }`
  - Manifest types `ManifestV1` / `ManifestSettings` (serde camelCase; schema in the Task 8 preamble table; `version: 1` literal enforced on load; `settings.openSnapshotTtlMinutes` must equal 30 and `deviceDisplayTtlDays` must equal 7 on load — the ENFORCING Node `z.literal`s are `store.ts:219-223` (`:220-221`); `store.ts:116-119` is only the TS type, not the validator — validator-A8-A9).

Behavioral contract (each clause maps to a Node cite):
1. `open()`: `mkdir -p v1/objects v1/tmp`; if `v1/manifest.json` exists → load;
   else if `tabs-registry.jsonl` exists → migrate (Task 10 hook — until Task
   10 lands, return `Corrupt("legacy jsonl present; migration not yet ported")`
   so the gap is loud, and replace that arm in Task 10); else → empty state,
   `manifest_revision = 0`, NOTHING written until the first commit
   (`store.ts:668-710`).
2. Load defense-in-depth (`store.ts:724-851`): manifest stat-size cap → read →
   byte cap re-check → JSON parse → schema validate → per-ref pre-checks
   (ref-count cap, per-ref byte caps, aggregate referenced bytes ≤ 5 MiB, path
   regex `objects/[a-f0-9]{64}.json` with embedded digest == `sha256` field) —
   ALL before opening any object file → per object: stat size == `bytes` →
   read → byte length + `sha256_hex_full(raw)` match → schema/record
   validation → snapshot-key identity check + `openSnapshotPayloadHash`
   re-verification → `validate_state_caps`.
3. Corruption recovery — the ONLY self-heal (`store.ts:676-690`): an invalid
   state whose cause is a MISSING OBJECT FILE (`ENOENT`) archives the manifest
   to `manifest.json.invalid-<archive_timestamp>` , logs a structured warning
   (`tracing::warn!(event = "compact_manifest_archived_missing_object", ...)`),
   and falls through to the legacy/empty branch. EVERY other invalid state
   (bad JSON, schema violation, size/hash mismatch, cap violation) →
   `Err(Corrupt)` → server boot fails. Operational fs errors (EACCES etc.) →
   `Err(Io)`, never treated as corruption.
4. `write_object` (`store.ts:970-1001`): `raw = canonical_stringify(value)`;
   byte cap; `digest = sha256_hex_full(&raw)`; if `objects/<digest>.json`
   exists → re-read + verify byte length and digest (mismatch = corruption
   error), reuse ref WITHOUT writing; else write
   `v1/tmp/<digest>.<pid>.<now>.tmp`, fsync best-effort, rename into
   `objects/`, fsync dir best-effort; an `EEXIST`-style rename race reuses the
   existing object and removes the tmp file.
5. `commit` (`store.ts:1062-1083`): validate caps → write the four component
   objects (reuse previous `ObjectRef` when the component is structurally
   unchanged — compare `canonical_stringify` output against the cached
   previous canonical string; Node's component reuse is object identity +
   content-addressed dedupe, and this canonical-string comparison is
   observably equivalent — keep it, validator-A8-A9) → build
   `ManifestV1 { manifest_revision: prev+1,
   committed_at: now, ... }` → publish via
   `atomic_write_durable(v1/manifest.json, v1/manifest.json.tmp, bytes)` →
   swap `self.state`/`self.manifest_revision` → clear `v1/tmp/*` best-effort
   (GC never deletes `objects/*` — overlapping-restart safety,
   `store.test.ts:177`).

- [ ] **Step 1: Write the failing tests** (inline module, `tempfile::tempdir()`
per test, plain `#[test]` — the store is synchronous):

```rust
#[test]
fn fresh_open_writes_nothing_until_first_commit() { /* open empty dir; assert no v1/manifest.json; commit empty-ish state; assert manifest exists with manifestRevision 1 */ }
#[test]
fn commit_then_reopen_roundtrips_state() {
    // open; build CompactState with 1 open snapshot (2 records), 1 tombstone,
    // 1 watermark, 1 device; commit; drop; open again; assert deep equality
    // of all four maps and manifest_revision preserved.
}
#[test]
fn objects_are_content_addressed_and_deduped() { /* commit same state twice -> objects/ file count unchanged; filenames are 64-hex.json and match content sha */ }
#[test]
fn manifest_referencing_missing_object_archives_and_starts_empty() {
    // commit non-empty state; delete one objects/<sha>.json; reopen ->
    // Ok(empty state), v1/manifest.json gone, a manifest.json.invalid-* file exists.
}
#[test]
fn corrupt_object_bytes_fail_boot_loudly() {
    // commit; truncate one object file in place; reopen -> Err(Corrupt), manifest NOT archived.
}
#[test]
fn corrupt_manifest_json_fails_boot_loudly() { /* write garbage to v1/manifest.json; open -> Err(Corrupt) */ }
#[test]
fn partial_writes_are_invisible() { /* strew a v1/tmp/xx.tmp and an orphan objects/<other-sha>.json; open works; commit clears tmp, keeps orphan object */ }
#[test]
fn oversized_component_object_fails_commit_without_swapping_state() { /* caps with tiny max_serialized_client_snapshot_object_bytes; commit -> Err; store.state() still the old state; reopen still loads old manifest */ }
```

Write each comment as full test code (build snapshots with the Task 8 structs;
records via a small `open_record(tab_key, name, updated_at)` helper mirroring
`tabs.rs:546`, extended with the full required field set from
`validate_registry_record`).

- [ ] **Step 2: Run to verify failure** — `cargo test -p freshell-ws tabs_store:: 2>&1 | tail -5` → compile errors.

- [ ] **Step 3: Implement** per the behavioral contract above. Keep the file
under 1,000 lines: the model/validation logic already lives in Task 8's
module; this file holds only IO + orchestration.

- [ ] **Step 4: Run tests** — `cargo test -p freshell-ws tabs_store 2>&1 | tail -5` → ok (both modules).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/tabs_store.rs crates/freshell-ws/src/lib.rs
git commit -m "feat(ws): durable tabs-registry store — content-addressed objects, atomic manifest, Node-parity corruption recovery"
```

### Task 10: legacy `tabs-registry.jsonl` migration

**Files:**
- Create: `crates/freshell-ws/src/tabs_store_migrate.rs`
- Modify: `crates/freshell-ws/src/tabs_store.rs` (replace the loud legacy-arm stub in `open()` with the real migration)
- Modify: `crates/freshell-ws/src/lib.rs` (add `pub(crate) mod tabs_store_migrate;`)

**Interfaces:**
- Produces: `pub(crate) fn migrate_legacy_jsonl(legacy_path: &std::path::Path, migration_started_at: i64, caps: &TabsStoreCaps, max_closed_retention_days: i64) -> Result<CompactState, String>`
- Consumed by: `DurableTabsStore::open` — on success, `commit` the migrated
  state (publishing `manifestRevision: 1`), THEN rename the legacy file to
  `tabs-registry.jsonl.migrated-<archive_timestamp>` and fsync the root dir.
  **Archive strictly after publish** — a crash between them replays the
  migration harmlessly (`store.ts:697-698`, integration test
  `tabs-registry-store.persistence.test.ts:215`).

Node contract (`store.ts:853-949`):
1. Stream lines with a per-line byte cap (256 KiB → hard error), CRLF-tolerant,
   blank lines skipped.
2. Per line: `JSON.parse` failure → silently skip; record failing
   `validate_registry_record` → silently skip; valid records run
   `validate_record_caps`' pane checks (pane-cap violation → hard error).
3. Last-writer-wins per `tabKey` via `pick_event_winner`. Running
   retained-bytes accounting errors past 5 MiB; unique tab keys error past
   10,000.
4. Closed records older than `migration_started_at - retention*DAY_MS` are
   dropped; the rest become tombstones.
5. Open records group **by deviceId** into ONE synthetic snapshot per device:
   `client_instance_id = "legacy-migration"`, `snapshot_revision = 1`, every
   record's `deviceLabel` rewritten to the group's first label (or deviceId)
   and `clientInstanceId` set to `"legacy-migration"`; both payload hashes set
   to the open-records hash; a matching watermark written per device.
   Migration also enforces the snapshot-refs cap INSIDE this grouping loop
   (store.ts:912-914; hard error with a migration-specific message — same
   error class).
6. Migration ALSO populates `devices_by_id` (validator-A8-A9): one entry per
   device, `last_seen_at = migration_started_at`, and `device_label` = the
   LAST open record's label for that device (overwritten per record;
   store.ts:904-908) — which can DIFFER from the snapshot's first-label
   rewrite in clause 5 (golden proof: `devices.devB.deviceLabel ==
   "Device B RENAMED"` while `snapB.deviceLabel == "Device B"`).
7. `apply_queued_maintenance` + `validate_state_caps` before returning.

- [ ] **Step 1: Write the failing tests:**

```rust
#[test]
fn migrates_legacy_jsonl_lww_per_tab_key_and_archives_after_publish() {
    // Write a legacy file: 3 lines for tabKey "a" (updatedAt 1,3,2 -> winner updatedAt 3),
    // 1 malformed JSON line, 1 schema-invalid line, 1 closed record within retention,
    // 1 closed record older than retention. Two deviceIds; give devB TWO open
    // records whose labels differ ("Device B" then "Device B RENAMED").
    // open() -> state has: per-device synthetic snapshots (clientInstanceId
    // "legacy-migration", revision 1), winner record only for "a",
    // in-retention tombstone only; watermarks written; legacy file renamed
    // to tabs-registry.jsonl.migrated-*; v1/manifest.json manifestRevision == 1.
    // devices_by_id (contract clause 6, validator-A8-A9): one entry per
    // device, last_seen_at == migration_started_at, and LAST-label-wins:
    // devices["devB"].device_label == "Device B RENAMED" while the synthetic
    // snapshot's records carry the FIRST label rewrite ("Device B").
    // Golden Node outputs for exactly this shape live at
    // .worktrees/.the-usual-logs/naming-persistence-sweep/artifacts/a8a9-harness/
    // (see Task 8 Step 1; regenerate with `npx tsx` against the real store.ts).
}
#[test]
fn oversized_legacy_line_is_a_hard_error() { /* one 300 KiB line -> open() Err(Corrupt) */ }
#[test]
fn crash_between_publish_and_archive_replays_harmlessly() {
    // simulate: run migrate + commit manually, do NOT rename legacy; then open()
    // -> loads the manifest (manifest wins over legacy: open checks manifest FIRST).
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p freshell-ws tabs_store_migrate 2>&1 | tail -5`.

- [ ] **Step 3: Implement** (BufReader with manual bounded line reads —
`read_until(b'\n')` into a capped buffer; do not use `lines()` which has no
byte cap). Then wire the `open()` legacy arm.

- [ ] **Step 4: Run** `cargo test -p freshell-ws 2>&1 | tail -5` → all green.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/tabs_store_migrate.rs crates/freshell-ws/src/tabs_store.rs crates/freshell-ws/src/lib.rs
git commit -m "feat(ws): legacy tabs-registry.jsonl -> v1 migration with LWW, caps, archive-after-publish"
```

### Task 11: live `TabsRegistry` — Node-parity semantics + durable backing

**Files:**
- Modify: `crates/freshell-ws/src/tabs.rs` (781 lines; the moved ordering helpers from Task 8 bought headroom — if the file approaches 1,000 lines, split the inline tests into `crates/freshell-ws/src/tabs_tests.rs` with the `#[path]` include pattern `tabs_persist.rs:997-999` uses)
- Modify: `crates/freshell-ws/src/terminal.rs` (tabs.sync handlers: `validate_tabs_push` `:1801-1884`, `handle_tabs_query` `:2006-2024`, `handle_tabs_retire` `:2030-2043`)
- Modify: `crates/freshell-server/src/main.rs:287-292` (construction becomes a fallible durable open)
- Modify: `crates/freshell-server/src/boot.rs:627` (REST retire — now async-safe)

**Interfaces:**
- Consumes: Tasks 8–10.
- Produces (changed public surface of `TabsRegistry`):
  - `pub fn with_durable_store(store: crate::tabs_store::DurableTabsStore, persist_dir: Option<std::path::PathBuf>) -> Self` — hydrates the in-memory state from the store's `CompactState` and keeps the store handle for commits. `TabsRegistry::new()` stays (memory-only; all existing tests/callers keep working).
  - `replace_client_snapshot(...)` — same signature, upgraded semantics (below).
  - `pub fn retire_client_snapshot(&self, device_id: &str, client_instance_id: &str, snapshot_revision: i64) -> bool` — unchanged signature; now commits.
  - `pub fn query(&self, device_id: &str, client_instance_id: &str, closed_tab_retention_days: i64, now_ms: i64) -> Result<serde_json::Value, String>` — NEW retention param (validated int 1..=30 → `Err` on violation, `store.ts:411-416`) + TTL read-filters.

Semantics to implement (the AUTO-15 heart; every clause has a Node cite):
1. **In-memory state upgrade:** `ClientOpenSnapshot` (tabs.rs private struct)
   is replaced by the Task 8 serde struct; `client_revisions` values become
   `ClientRevisionWatermark`; keys switch from the collidable
   `"{device}::{client}"` join (`tabs.rs:422-424`) to
   `tabs_store_model::client_snapshot_key`.
2. **Push pre-checks** (pre-lock, `store.ts:1091-1107`): every record passes
   `validate_registry_record` + `normalize_registry_pane_kinds`;
   `validate_record_caps` (count, duplicate tabKey, pane caps);
   `canonical_stringify(input).len()` ≤ 1 MiB; ownership assert — every
   record's `deviceId`+`deviceLabel` must equal the envelope's
   (`store.ts:524-528`); canonicalize `clientInstanceId` onto every record;
   split open/closed with per-partition caps; compute `push_hash` (ALL
   records) and `open_hash` (open only).
3. **Revision semantics** (`store.ts:1136-1156`): stale (`< high_water`) →
   `Err("Stale snapshot revision rejected for tabs registry client snapshot")`
   (string-identical, already in place `tabs.rs:158-165`); same revision as
   live snapshot: `push_hash == current.last_push_payload_hash` → idempotent
   accept WITHOUT commit; hash mismatch →
   `Err("Duplicate snapshot revision has different tabs registry content")`
   — this closes the documented gap at `tabs.rs:166-176`; no live snapshot +
   watermark and `revision <= watermark` → stale error (non-resurrection).
4. **Closed-record folding gains the `findOpenWinnerForTab` guard**
   (`store.ts:556-568`, `:1153-1156`; missing at `tabs.rs:186-191`): skip a
   closed record when a newer open winner for that tabKey exists across ALL
   snapshots.
5. **Post-mutation:** `apply_queued_maintenance` + `validate_state_caps`
   (violation → `Err`, push rejected, state unchanged) — then, when a durable
   store is attached: build the next `CompactState`, `commit` it, and swap the
   in-memory state ONLY on commit success (commit error → `Err(<io error
   string>)` to the client, in-memory state unchanged — Node throws out of the
   mutation, `store.ts:1189`).
6. **Retire** (`store.ts:1194-1238`): both branches write/refresh the
   watermark (with `last_seen_at`), refresh the device from the STORED
   snapshot's label when removing a live snapshot, maintain + commit.
7. **Query read-filters** (`store.ts:1240-1296`): open snapshots older than 30
   min (by `snapshot_received_at`) excluded; tombstones filtered by BOTH the
   server retention and the per-query `closed_tab_retention_days`; `devices`
   list filtered by the 7-day display TTL (this also replaces the
   `diagnostic_counts`-only cutoff).
8. **WS handlers** (`terminal.rs`): `handle_tabs_query` reads
   `closedTabRetentionDays` from the envelope. The `tabs.sync.query` schema
   lives in `server/ws-handler.ts:452` (NOT `shared/ws-protocol.ts`):
   `closedTabRetentionDays` is REQUIRED there (int 1..=30). Mirror it as
   required — missing or invalid → `tabs_error_frame`.
   `handle_tabs_retire` currently runs blocking work
   on the async runtime (`terminal.rs:2030-2043` — flagged in the module doc);
   route the registry call through `tokio::task::spawn_blocking` like
   `process_tabs_push` does (`terminal.rs:1772`). The REST retire handler
   (`boot.rs:627`) gets the same treatment.
9. **Startup** (`main.rs:287-292`): open the durable store at
   `home.join(".freshell").join("tabs-registry")` (blocking is fine at boot —
   Node blocks too); `Corrupt` error → process exits with the error message
   (Node parity: corrupt store fails server boot); no home → memory-only
   `TabsRegistry::new()` as today.

- [ ] **Step 1: Write the failing tests** (extend `tabs.rs` tests, plus one
restart test):

```rust
#[test]
fn same_revision_push_with_different_content_is_rejected() {
    let reg = TabsRegistry::new();
    reg.replace_client_snapshot("srv", "d", "D", "c", 1, vec![open_record("a", "One", 10)]).unwrap();
    let err = reg.replace_client_snapshot("srv", "d", "D", "c", 1, vec![open_record("a", "CHANGED", 11)]).unwrap_err();
    assert_eq!(err, "Duplicate snapshot revision has different tabs registry content");
    // identical re-push is an idempotent accept
    assert!(reg.replace_client_snapshot("srv", "d", "D", "c", 1, vec![open_record("a", "One", 10)]).unwrap().accepted);
}
#[test]
fn closed_record_loses_to_newer_open_winner_elsewhere() {
    let reg = TabsRegistry::new();
    reg.replace_client_snapshot("srv", "d1", "D1", "c1", 1, vec![open_record("a", "Live", 100)]).unwrap();
    reg.replace_client_snapshot("srv", "d2", "D2", "c2", 1, vec![closed_record("a", "Old", 50, 50)]).unwrap();
    let q = reg.query("d3", "c3", 30, now_ms()).unwrap();
    assert_eq!(q["closed"].as_array().unwrap().len(), 0);
    assert_eq!(q["remoteOpen"].as_array().unwrap().len(), 1);
}
#[test]
fn duplicate_tab_keys_in_one_push_are_rejected() { /* two records same tabKey -> Err containing "duplicate" */ }
#[test]
fn record_ownership_mismatch_is_rejected() { /* record.deviceId != envelope deviceId -> Err */ }
#[test]
fn query_validates_retention_and_filters_expired_open_snapshots() {
    // retention 0 and 31 -> Err; push, backdate snapshot_received_at 31 min via
    // reg.inner (established backdating pattern, tabs.rs:761-772) -> query
    // localOpen empty; devices past 7d excluded from query()["devices"].
}
#[test]
fn durable_registry_survives_reconstruction() {
    let dir = tempfile::tempdir().unwrap();
    let open_store = || crate::tabs_store::DurableTabsStore::open(dir.path(), crate::tabs_store_model::default_caps(), 0).unwrap();
    let reg = TabsRegistry::with_durable_store(open_store(), None);
    reg.replace_client_snapshot("srv", "d", "D", "c", 3, vec![open_record("a", "One", 10), closed_record("b", "Two", 5, 5)]).unwrap();
    drop(reg);
    let reg2 = TabsRegistry::with_durable_store(open_store(), None);
    let q = reg2.query("d", "c", 30, now_ms()).unwrap();
    assert_eq!(q["localOpen"].as_array().unwrap().len(), 1);
    assert_eq!(q["closed"].as_array().unwrap().len(), 1);
    // stale push after restart still rejected (watermark persisted)
    assert!(reg2.replace_client_snapshot("srv", "d", "D", "c", 2, vec![]).is_err());
}
#[test]
fn commit_failure_leaves_memory_state_unchanged() { /* make the store root read-only (chmod 0o555) after open; push -> Err; query shows pre-push state */ }
#[test]
fn concurrent_distinct_client_pushes_both_survive_reopen() {
    // REQUIRED (validator-A6): durable-backed registry; two threads push for
    // DIFFERENT clients concurrently, in a loop (e.g. 20 rounds); every push
    // accepted; drop the registry; reopen from the same store root; BOTH
    // clients' records present. Under the old (falsified) discipline the
    // second commit could publish a manifest missing the first push's
    // accepted records (disk AND memory).
}
#[test]
fn push_retire_same_client_race_never_resurrects() {
    // REQUIRED (validator-A6): race push(rev N) against retire(rev N) in a
    // loop; after EACH round assert the invariant: no retired snapshot is
    // resurrected and the persisted watermark is monotone non-decreasing.
}
```

Update the two existing call sites of `query()` in tests and the handlers for
the new signature.

- [ ] **Step 2: Run to verify failure** — `cargo test -p freshell-ws tabs 2>&1 | tail -10`.

- [ ] **Step 3: Implement** clauses 1–7 in `tabs.rs`. Lock discipline
(REWRITTEN — validator-A6 falsified the previous one): in durable-backed
mode, EVERY mutation (push and retire, INCLUDING the idempotent-accept hash
fast path) executes under the durable-store mutex
(`Arc<std::sync::Mutex<DurableTabsStore>>`) held across the ENTIRE
read → derive → commit → swap sequence — the store mutex IS the mutation
lock. Node parity: `enqueueMutation` (store.ts:1085-1089) serializes the
whole read-clone-mutate-commit closure, not just the commit.
`std::sync::Mutex` is fine because all mutators already run in
`spawn_blocking`. The registry inner lock stays IO-free: take it briefly
inside the mutation section to read the current state, and again at the end
to swap — readers never block on FS IO (this preserves the actual intent of
the `tabs.rs:233` discipline). On commit error, do not swap. Why the old
"derive under the registry lock, release, commit, re-lock, swap" discipline
was wrong: two pushes could both derive from the same predecessor state, and
the second commit published a manifest missing the first's accepted records
(disk and memory) — see the validator-A6 interleaving.

- [ ] **Step 4: Implement clauses 8–9** (handlers + boot). Update
`crates/freshell-ws/tests/` WsState constructions if the type changed (it
should not — `TabsRegistry` stays `Clone + Default`).

- [ ] **Step 5: Run the full fast gate**

```bash
cargo test --workspace --exclude freshell-tauri 2>&1 | tail -5
```
Expected: green, including the existing `tabs_push_validation_tests`
(`terminal.rs:1886-2001`) and `tabs_snapshots` server tests.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-ws/ crates/freshell-server/src/main.rs crates/freshell-server/src/boot.rs
git commit -m "feat(ws): durable tabs registry — restart survival, content-hash idempotency, caps/TTLs, open-winner guard (CFG-08/AUTO-15)"
```

---

# PART C — Automation layout store + REST parity (Item 4: AUTO-01/03/06)

Node reference: `server/agent-api/layout-store.ts` (695 lines),
`layout-schema.ts`, `target-resolver.ts`, `router.ts:649-693` +
`:1396-1427`. Key architecture facts: the store is a LAST-WRITER-WINS MIRROR
of the SPA's Redux layout, populated ONLY by `ui.layout.sync` (debounced
1000 ms first / 200 ms after, `src/store/layoutMirrorMiddleware.ts:4-5`);
REST mutations write the mirror AND fan out `ui.command{...}` to all sockets;
with no client connected, reads return empty and most mutations return HTTP
200 `{message:'no layout snapshot'}` — `createTab`/`splitPane`/`selectTab`
lazily bootstrap via `ensureSnapshot()`. Crate placement: `freshell-ws`
depends on `freshell-freshagent` (`crates/freshell-ws/Cargo.toml:37`), so the
store lives in `freshell-freshagent` and `freshell-ws` imports it.

### Task 12: `layout_store.rs` + `layout_tree.rs` + `target_resolver.rs` (pure model)

**Files:**
- Create: `crates/freshell-freshagent/src/layout_tree.rs`
- Create: `crates/freshell-freshagent/src/layout_store.rs`
- Create: `crates/freshell-freshagent/src/target_resolver.rs`
- Modify: `crates/freshell-freshagent/src/lib.rs` (add the three `pub mod`s)

**Interfaces (produced; Tasks 13–16 + Task 21 e2e rely on these):**

```rust
// layout_tree.rs — port of layout-schema.ts:28-78 + layout-store.ts:219-315
#[derive(Clone, Debug, PartialEq)]
pub enum PaneNode {
    Leaf { id: String, content: serde_json::Value },
    Split { id: String, direction: String, sizes: [f64; 2], children: Box<[PaneNode; 2]> },
}
impl PaneNode {
    pub fn parse(v: &serde_json::Value) -> Option<PaneNode>;      // tolerant: unknown shape -> None
    pub fn to_value(&self) -> serde_json::Value;                   // exact Node JSON shape
    pub fn collect_leaves<'a>(&'a self, out: &mut Vec<&'a PaneNode>); // depth-first leaf order == Node leaf `index`
    pub fn find_leaf(&self, pane_id: &str) -> Option<&PaneNode>;
    pub fn find_split(&self, split_id: &str) -> Option<&PaneNode>;
    pub fn find_parent_split_id(&self, pane_id: &str) -> Option<String>;
    pub fn replace_leaf_content(&mut self, pane_id: &str, content: serde_json::Value) -> bool;
    pub fn set_split_sizes(&mut self, split_id: &str, sizes: [f64; 2]) -> bool;
}

// layout_store.rs
#[derive(Clone, Debug, Default)]
pub struct TabRow { pub id: String, pub title: Option<String>, pub fallback_session_ref: Option<serde_json::Value> }
#[derive(Clone, Debug, Default)]
pub struct UiSnapshot {
    pub tabs: Vec<TabRow>,                                             // ORDERED
    pub active_tab_id: Option<String>,
    pub layouts: std::collections::HashMap<String, PaneNode>,          // tabId -> root
    pub active_pane: std::collections::HashMap<String, String>,        // tabId -> paneId
    pub pane_titles: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    pub pane_title_set_by_user: std::collections::HashMap<String, std::collections::HashMap<String, bool>>,
    pub timestamp: Option<i64>,
}
#[derive(Clone, Default)]
pub struct LayoutStore { inner: std::sync::Arc<std::sync::Mutex<LayoutInner>> } // LayoutInner = { snapshot: Option<UiSnapshot>, source_connection_id: Option<String> }
pub struct RenameOutcome { pub tab_id: Option<String>, pub pane_id: Option<String>, pub message: Option<&'static str> } // message in {"tab not found","pane not found","no layout snapshot"}
pub struct PaneRow { pub id: String, pub index: usize, pub kind: Option<String>, pub terminal_id: Option<String>, pub title: Option<String> }
pub struct PaneSnapshot { pub tab_id: String, pub pane_id: String, pub kind: Option<String>, pub terminal_id: Option<String>, pub pane_content: Option<serde_json::Value> }

impl LayoutStore {
    pub fn update_from_ui(&self, sync: &freshell_protocol::UiLayoutSync, source_connection_id: &str); // REPLACES the snapshot; runs migrate + seed_pane_title per leaf (layout-store.ts:169-181)
    pub fn has_snapshot(&self) -> bool;
    pub fn get_normalized_snapshot(&self, tab_id: Option<&str>) -> serde_json::Value; // exact Node keys: tabs/activeTabId/layouts/activePane/paneTitles/paneTitleSetByUser/timestamp; empty snapshot when none (layout-store.ts:44-46, 191-210)
    pub fn list_tabs(&self) -> (Vec<serde_json::Value>, Option<String>);  // rows {id, title: <falls back to id>, activePaneId}; + activeTabId (layout-store.ts:327-339, 187-189)
    pub fn has_tab(&self, target: &str) -> bool;                          // id OR title (layout-store.ts:336-339)
    pub fn create_tab(&self, title: Option<&str>) -> (String, String);    // ensureSnapshot; returns (tabId, paneId); appends ordered tab + leaf layout + seeds title
    pub fn close_tab(&self, tab_id: &str) -> RenameOutcome;               // purges layouts/activePane/title maps (removeTabMetadata, layout-store.ts:87-91)
    pub fn select_tab(&self, tab_id: &str) -> RenameOutcome;              // ensureSnapshot; sets active_tab_id when the tab exists
    pub fn select_next_tab(&self) -> Option<String>;                      // ordered cycle modulo len (layout-store.ts:589-607)
    pub fn select_prev_tab(&self) -> Option<String>;
    pub fn rename_tab(&self, tab_id: &str, title: &str) -> RenameOutcome; // + single-pane mirror into pane_titles/set_by_user=true (layout-store.ts:542-556)
    pub fn rename_pane(&self, pane_id: &str, title: &str) -> RenameOutcome; // sets pane title sticky; single-pane tab mirrors onto tab.title (layout-store.ts:558-575)
    pub fn list_panes(&self, tab_id: Option<&str>) -> Result<Vec<PaneRow>, &'static str>; // default tab = active then first (layout-store.ts:341-355)
    pub fn get_pane_snapshot(&self, pane_id: &str) -> Option<PaneSnapshot>;
    pub fn split_pane(&self, pane_id: &str, direction: &str) -> Result<(String, String), &'static str>; // (tabId, newPaneId); binary split 50/50
    pub fn attach_pane_content(&self, tab_id: &str, pane_id: &str, content: serde_json::Value) -> RenameOutcome; // re-seeds derived title (non-sticky)
    pub fn close_pane(&self, pane_id: &str) -> Result<String, &'static str>; // Ok(tabId) | "pane not found" | "cannot close only pane" | "no layout snapshot"; pure tree mutation, never kills PTYs (layout-store.ts:501-516)
    pub fn select_pane(&self, tab_id: Option<&str>, pane_id: &str) -> Result<(String, String), &'static str>;
    pub fn swap_pane(&self, tab_id: Option<&str>, pane_id: &str, other_id: &str) -> Result<String, &'static str>; // swaps content AND both title-map entries (layout-store.ts:609-654)
    pub fn resolve_resize_target(&self, raw: &str, tab_id: Option<&str>) -> Result<(String, String, [f64;2]), &'static str>; // (tabId, splitId, current sizes); splitId-first then pane->parent-split (router.ts:621-647)
    pub fn resize_split(&self, tab_id: &str, split_id: &str, sizes: [f64; 2]) -> bool;
    pub fn get_single_pane_id(&self, tab_id: &str) -> Option<String>;      // root is a leaf (layout-store.ts:247-251)
    pub fn source_connection_id(&self) -> Option<String>;
}
pub fn derive_pane_title(content: &serde_json::Value) -> String;  // layout-store.ts:93-167: editor->basename|"Editor"; browser->hostname|"Browser"; fresh-agent by sessionType (Freshclaude|Freshcodex|OpenCode|Kilroy|"Fresh Agent"); extension->extensionName|"Extension"; terminal by mode (claude->"Claude CLI", codex->"Codex CLI", gemini->"Gemini", opencode->"OpenCode", kimi->"Kimi") else by shell (PowerShell|Command Prompt|WSL|"Shell")
pub fn normalize_pair_to_hundred(a: f64, b: f64) -> [f64; 2];      // router.ts:608-619
pub fn is_valid_percent(n: f64) -> bool;                            // 1..=99

// target_resolver.rs — port of target-resolver.ts:41-93
pub enum ResolvedTarget { Pane { tab_id: String, pane_id: String, message: Option<&'static str> }, Ambiguous(&'static str), NotFound(&'static str) }
pub fn resolve_target(store: &LayoutStore, raw: &str) -> ResolvedTarget
    // order: exact pane id -> exact tab id OR TAB TITLE (that tab's active pane, message "tab matched; active pane used")
    // -> "tab.pane" / "session:window.pane" index form -> bare numeric index into active tab
    // -> pane TITLE across all tabs (2+ matches -> Ambiguous("pane target is ambiguous; use pane id or tab.pane index"))
    // -> NotFound("target not resolved"); empty store -> NotFound("no layout snapshot")
```

`freshell_protocol::UiLayoutSync` already exists with camelCase serde
(`crates/freshell-protocol/src/client_messages.rs:288`; round-trip test
`freshell-protocol/tests/roundtrip.rs:331-356`) — parse its opaque
`layouts: Value` through `PaneNode::parse`.

- [ ] **Step 1: Write the failing tests.** Inline test modules per file; all
pure (no axum). Cover at minimum:

```rust
// layout_tree.rs tests
#[test] fn parse_and_reserialize_leaf_and_split_roundtrip() { /* build the Node JSON {type:leaf,...} and {type:split,direction,sizes,children:[..]}; parse; to_value == input */ }
#[test] fn collect_leaves_is_depth_first_left_to_right() { /* 3-pane nested split -> ids in order */ }
#[test] fn find_parent_split_and_set_sizes() { /* find parent of right leaf; set_split_sizes updates */ }

// layout_store.rs tests
#[test] fn update_from_ui_replaces_snapshot_and_seeds_nonsticky_titles() {
    /* sync with a terminal leaf (mode claude), no paneTitles -> pane title seeded "Claude CLI",
       set_by_user stays false; sync again with paneTitleSetByUser true + custom title -> preserved */
}
#[test] fn rename_pane_mirrors_to_tab_when_single_pane_and_reports_tab_renamed() { /* single-leaf tab: rename_pane sets tab.title; RenameOutcome carries tab_id */ }
#[test] fn rename_tab_mirrors_to_pane_only_when_single_pane() { /* single-pane mirrors sticky; two-pane does not touch pane_titles */ }
#[test] fn next_prev_cycle_ordered_tabs_modulo_len() { /* 3 tabs, active=t3 -> next=t1; prev from t1 -> t3; empty -> None */ }
#[test] fn mutations_without_snapshot_report_no_layout_snapshot_but_create_tab_bootstraps() { /* rename_tab -> message "no layout snapshot"; create_tab works and list_tabs shows it */ }
#[test] fn swap_pane_exchanges_content_and_title_maps() { }
#[test] fn close_pane_guards_only_pane_and_purges_metadata() { }
#[test] fn normalize_pair_to_hundred_and_percent_bounds() { /* (30,30)->[50,50]; (25,75) stays; is_valid_percent bounds 1..=99 */ }
#[test] fn derive_pane_title_full_matrix() { /* every branch listed in the signature comment */ }

// target_resolver.rs tests
#[test] fn resolves_pane_id_tab_id_tab_title_index_form_and_ambiguous_pane_title() { /* one test per rung incl. Ambiguous for duplicate pane titles */ }
```

Write every body in full (construct `UiLayoutSync` via
`serde_json::from_value` of a literal `json!` payload with camelCase keys —
that also pins the wire shapes).

- [ ] **Step 2: Run to verify failure** — `cargo test -p freshell-freshagent layout 2>&1 | tail -5` → compile errors.

- [ ] **Step 3: Implement** the three modules per the interface comments
(each comment carries its Node cite — port those functions faithfully). Keep
each file under 1,000 lines (tests included; if `layout_store.rs` grows past
it, move its tests to `layout_store_tests.rs` via `#[path]` include).

- [ ] **Step 4: Run** — `cargo test -p freshell-freshagent 2>&1 | tail -5` → ok.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/src/layout_tree.rs crates/freshell-freshagent/src/layout_store.rs crates/freshell-freshagent/src/target_resolver.rs crates/freshell-freshagent/src/lib.rs
git commit -m "feat(freshagent): server-side LayoutStore + pane tree + target resolver (Node layout-store port)"
```

### Task 13: `ui.layout.sync` ingestion (AUTO-01 spine)

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (`FreshAgentState` gains `pub layout: layout_store::LayoutStore`; constructor + `with_*` builder updated)
- Modify: `crates/freshell-ws/src/lib.rs` (`WsState` gains `pub layout: freshell_freshagent::layout_store::LayoutStore`)
- Modify: `crates/freshell-ws/src/terminal.rs` (message dispatch: add the `ClientMessage::UiLayoutSync` arm)
- Modify: `crates/freshell-server/src/main.rs` (construct ONE `LayoutStore`, clone into both states)
- Modify: every `WsState`/`FreshAgentState` literal in tests (`crates/freshell-ws/tests/*`, inline test modules) — add `layout: Default::default()`

**Interfaces:**
- Produces: on receipt of a `ui.layout.sync` client frame, the shared
  `LayoutStore` snapshot is replaced (`update_from_ui(msg, connection_id)`).
  No reply frame (Node sends none).

- [ ] **Step 1: Write the failing test.** In the WS integration-test style of
`crates/freshell-ws/tests/session_identity_frames.rs` (real `/ws` connection)
OR — cheaper and sufficient — an inline `#[tokio::test]` in `terminal.rs` next
to the existing handler tests that calls the message-dispatch function
directly with a `ui.layout.sync` JSON frame and asserts
`state.layout.has_snapshot()` and `list_tabs()` reflect the payload:

```rust
#[tokio::test]
async fn ui_layout_sync_frame_populates_the_shared_layout_store() {
    let state = test_ws_state(); // existing helper in this test module
    let frame = serde_json::json!({
        "type": "ui.layout.sync",
        "tabs": [{"id": "t1", "title": "Work"}],
        "activeTabId": "t1",
        "layouts": {"t1": {"type": "leaf", "id": "p1", "content": {"kind": "terminal", "mode": "shell", "createRequestId": "r1", "status": "running"}}},
        "activePane": {"t1": "p1"},
        "paneTitles": {}, "paneTitleSetByUser": {},
        "timestamp": 123
    });
    dispatch_client_frame(&state, frame, "conn-1").await; // the same entry the socket loop uses
    let (tabs, active) = state.layout.list_tabs();
    assert_eq!(tabs[0]["id"], "t1");
    assert_eq!(active.as_deref(), Some("t1"));
}
```

(Adapt the two helper names to whatever the module actually exposes — the
`tabs.sync.*` interception tests at `terminal.rs:1886-2001` show the real
entry points.)

- [ ] **Step 2: Run to verify failure**, **Step 3: implement** (the dispatch
arm is three lines: on parsed `ClientMessage::UiLayoutSync(sync)` →
`state.layout.update_from_ui(&sync, connection_id)`), **Step 4: run**
`cargo test --workspace --exclude freshell-tauri 2>&1 | tail -5` (fixing every
state-literal in tests), **Step 5: commit:**

```bash
git add crates/freshell-ws/ crates/freshell-freshagent/src/lib.rs crates/freshell-server/src/main.rs
git commit -m "feat(ws): ingest ui.layout.sync into the shared server-side LayoutStore (AUTO-01 spine)"
```

### Task 14: tab routes on the store (AUTO-03)

**Files:**
- Modify: `crates/freshell-freshagent/src/pane_ops.rs` (`select_tab :330-351`, `rename_tab :358-386`, `delete_tab :397-445`, `tabs_has :456-467`, `tabs_next`/`tabs_prev` `:489-513` — the honest-400 deferrals die here)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (`list_tabs :1129-1143`; `create_terminal_or_content_tab :208-266` also registers the tab/pane in the `LayoutStore`)

**Interfaces:**
- Consumes: Task 12/13 store.
- Produces Node-exact route behavior:
  - `GET /api/tabs` → 200 `ok({tabs: [{id, title /*falls back to id*/, activePaneId}], activeTabId})` — ordered, from the store.
  - `POST /api/tabs/:id/select` → store `select_tab` (persists `activeTabId`), broadcast `ui.command{tab.select,{id}}` UNCONDITIONALLY, 200 `ok({tabId}|{message:'tab not found'})`.
  - `PATCH /api/tabs/:id` → 400 `name required` on blank; store `rename_tab` (single-pane mirror included); broadcast `ui.command{tab.rename,{id,title}}` only when renamed; 200 `ok({tabId}|{message:'tab not found'|'no layout snapshot'})`. Keep updating the legacy `TabRecord.title` too (continuity/restore reads it).
  - `DELETE /api/tabs/:id` → store `close_tab` + existing owned-resource cleanup; unconditional broadcast `ui.command{tab.close,{id}}`.
  - `GET /api/tabs/has?target=` → store `has_tab` (id OR title; empty target → false).
  - `POST /api/tabs/next` / `prev` → store cycle; broadcast `ui.command{tab.select,{id}}` on resolve; 200 `ok({tabId})` or `ok({message:'no tabs'},'no tabs')`. **DELETE the `TAB_CYCLE_DEFERRAL_MESSAGE` tests** (`tabs_next_is_honest_400_deferral`, `pane_ops.rs:1522`) and replace with behavior tests.
  - `POST /api/tabs` (create): after the existing spawn pipeline, also
    `layout.create_tab(name)` + `layout.attach_pane_content(...)` with the same
    paneContent JSON it already broadcasts, so REST-created tabs are visible to
    the store exactly like Node's `ensureSnapshot()` bootstrap.

- [ ] **Step 1: Write the failing tests** (axum oneshot pattern already in
these files — `post/patch/get/delete` helpers at `pane_ops.rs:943-1025`).
One test per bullet above; seed layout state either via REST create or by
calling `state.layout.update_from_ui(...)` directly with a `json!` payload
(pattern from Task 12 tests). Also keep one test asserting that with NO
snapshot and NO REST-created tabs, `rename_tab` returns 200
`{message:'no layout snapshot'}` (Node parity for the no-client hole).

- [ ] **Step 2: Run to verify failure** — `cargo test -p freshell-freshagent 2>&1 | tail -10`.

- [ ] **Step 3: Implement**, replacing the flat-map reads with store reads.
Do NOT delete the legacy maps — split/close/respawn continuity still uses
them; they now shadow the store for bookkeeping only.

- [ ] **Step 4: Run** the crate suite; update any existing tests whose
asserted row shapes changed (`list_tabs` gains `activePaneId`, loses `paneId`/
`kind` — grep this crate's tests for `"paneId"` under `list_tabs`).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/
git commit -m "feat(freshagent): tab routes on the LayoutStore — order, selection, next/prev, title-aware has (AUTO-03)"
```

### Task 15: pane routes on the store (AUTO-06 + honest snapshot)

**Files:**
- Modify: `crates/freshell-freshagent/src/pane_ops.rs` (`layout_snapshot :533-613`, `resize_pane :799-818`, `swap_pane :838-933`, `select_pane :283-313`, `close_pane :210-273`, `split_pane :89-195`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (`list_panes :1165-1222`)

**Interfaces (Node-exact):**
- `GET /api/layout/snapshot?tabId=` → `ok(store.get_normalized_snapshot(tab_id))` — real `PaneNode` trees, `activeTabId`, `activePane`, `paneTitles`, `paneTitleSetByUser`; the `{"type":"unknown"}` marker dies.
- `GET /api/panes?tabId=` → rows `{id, index, kind?, terminalId?, title?}` in leaf order from `list_panes` (default tab = active, then first).
- `POST /api/panes/:id/resize` → full Node validation matrix (all **400**s, exact strings: `sizes must contain exactly two values`, `sizes values must be numeric`, `sizes values must be within 1..99`, `x must be numeric`, `x must be within 1..99`, same for `y`); `:id` may be a splitId or a paneId (message `'pane matched; resized parent split'`); fallbacks `x→[x,100-x]`, `y→[100-y,y]`, neither → current sizes; `normalize_pair_to_hundred`; `'split not found'` → 200 with that message; ambiguous target → 409; broadcast `ui.command{pane.resize,{tabId,splitId,sizes}}`. **DELETE `resize_pane_is_honest_400_deferral`** (`pane_ops.rs:1819`).
- `POST /api/panes/:id/swap` → store swap (content + BOTH title maps); unknown panes → 200 `ok({message:'panes not found'})` (fixing the current 404 divergence noted at survey B.4); broadcast unchanged.
- `POST /api/panes/:id/select` → store `select_pane` persists `activePane`.
- `POST /api/panes/:id/close` / `split` → keep existing PTY-side behavior, ALSO mutate the store (`close_pane`, `split_pane`+`attach_pane_content`); split responds/broadcasts exactly as today.
- Target resolution: route `:id` lookups go through `target_resolver::resolve_target` (pane id / tab id / tab title / `tab.pane` / numeric index / pane title), with 409 on `Ambiguous` and 404 on `NotFound` — Node's `resolvePaneTarget` + `rejectPaneTargetError` (`router.ts:530-538, 591-596`).

- [ ] **Step 1: Write the failing tests.** One test per bullet; for resize,
table-drive the validation matrix (8 cases). Seed the store via
`update_from_ui` with a two-pane split payload (exact `json!` from Task 12's
tree tests). Keep/extend the existing `*_requires_auth` tests.

- [ ] **Step 2: Run to verify failure.** **Step 3: Implement.**
**Step 4: Run** `cargo test -p freshell-freshagent 2>&1 | tail -5` → ok.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/
git commit -m "feat(freshagent): pane routes + authoritative layout snapshot on the LayoutStore (AUTO-06, AUTO-01 snapshot/rename slice)"
```

### Task 16: `PATCH /api/panes/:id` — real rename with cascade (kills D10)

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (`rename_pane` `:1395-1428`; `FreshAgentState` gains `pub(crate) rename_persistence: Option<std::sync::Arc<dyn RenamePersistence>>` and `pub(crate) terminals_revision: Option<std::sync::Arc<std::sync::atomic::AtomicI64>>` — the `Option`-until-wired convention `amplifier_locator` already uses, `lib.rs:167-172`; if the ALREADY-INJECTED `freshell_terminal::TerminalRegistry` (`lib.rs:111`, `:362`) does not yet expose provider/resume_session_id, add an accessor there — validator-A10)
- Modify: `crates/freshell-server/src/main.rs` (implement + inject the trait; share the existing `terminals_revision` counter)
- Modify: `port/oracle/DEVIATIONS.md` (sessionRef-superset note — see behavior clause 4)

**Interfaces:**
- Produces in `freshell-freshagent`:
  ```rust
  pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;
  pub trait RenamePersistence: Send + Sync {
      fn patch_terminal_override_title(&self, terminal_id: &str, title: &str) -> BoxFuture<()>;
      /// key = "provider:sessionId"; NO titleSource — bypasses the ladder on purpose
      /// (persistSyncableTerminalRename, router.ts:683: plain {titleOverride}).
      fn patch_session_override_title(&self, key: &str, title: &str) -> BoxFuture<()>;
  }
  pub const SYNCABLE_TERMINAL_MODES: [&str; 5] = ["claude", "codex", "opencode", "gemini", "kimi"];
  ```
- Produces in `freshell-server` (`main.rs`): `struct SettingsRenamePersistence(SettingsStore)` implementing the trait via `patch_terminal_override` / `patch_session_override` (`settings_store.rs:621/688`).

Node behavior to match (`router.ts:1396-1427` + `persistSyncableTerminalRename :649-693`):
1. blank name → 400 `name required`; > 500 chars → 400 `name must be 500 characters or fewer` (already present).
2. `pane_snapshot = layout.get_pane_snapshot(pane_id)` BEFORE the rename.
3. `outcome = layout.rename_pane(pane_id, name)`; no snapshot/pane → 200 `ok({message})` (Node's `{message:'pane not found'|'no layout snapshot'}` at 200 replaces today's unconditional fake ack).
4. On success: best-effort cascade — resolve mode from `pane_content.mode` → `terminal_registry.get(tid).mode` equivalent; if the mode ∈ `SYNCABLE_TERMINAL_MODES` and a `terminalId` exists: `patch_terminal_override_title` → `registry.update_title` → resolve provider+sessionId following Node's preference order (`router.ts:649-693`, esp. `:658-676`; validator-A10):
   1. **Terminal metadata first** — the session binding learned
      post-association, read via the ALREADY-INJECTED
      `freshell_terminal::TerminalRegistry` in `FreshAgentState`
      (`crates/freshell-freshagent/src/lib.rs:111`, `:362`); add an accessor
      there if provider/resume_session_id is not yet exposed.
   2. **Fallback:** paneContent `resumeSessionId`.

   Rationale for registry-first: agent-api-created claude tabs get
   server-attached paneContent with NO session fields (`router.ts:762-773`);
   association populates terminal metadata server-side with zero client
   involvement (`index.ts:817-833`;
   `session-association-broadcast.ts:202-206`); only the SPA writes
   `sessionRef` back (`App.tsx:968-1006` → `panesSlice.ts:1705-1708`, 200 ms
   debounced) and the SPA reconcile CLEARS `resumeSessionId`
   (`panesSlice.ts:1708`) — with no SPA connected, a paneContent-only
   resolution silently no-ops where Node cascades. This plan ALSO reads
   `paneContent.sessionRef` as an EXPLICIT intentional superset (Node never
   reads sessionRef: `router.ts:655`/`:676`) — since it can cascade where
   Node would not, ledger a `port/oracle/DEVIATIONS.md` note per the plan's
   port-equivalence discipline. (A10.1: if the Rust server today lacks a
   client-independent association path, the no-SPA case is currently
   unreachable in Rust — the seam still goes in NOW so the gap does not
   silently reopen when association parity lands.) Then
   `patch_session_override_title("provider:sessionId")` — all failures
   swallowed with a `tracing::warn!`; then broadcast `terminals.changed`
   (bump the shared revision + send, same shape as `terminals.rs:1057-1061`).
5. `tab_renamed = layout.list_panes(tab_id).len() == 1`; broadcast `ui.command{pane.rename,{tabId,paneId,title}}`; respond `ok({tabId, paneId, tabRenamed}, ...)`.

- [ ] **Step 1: Write the failing tests** (this file's oneshot helpers):
`rename_pane_renames_store_and_broadcasts_ui_command` (seed store via
`update_from_ui`; assert `pane.rename` frame + `tabRenamed:true` for a
single-pane tab + store title changed); `rename_pane_unknown_pane_is_200_with_message`;
`rename_pane_cascades_to_syncable_terminal_via_injected_persistence` (inject a
recording fake `RenamePersistence`; seed a terminal-pane content with
`mode:"claude"` + a real registry terminal + sessionRef; assert both fake
methods called with the right args, registry title updated, and a
`terminals.changed` frame); `rename_pane_shell_pane_never_cascades`;
`rename_pane_cascades_via_registry_session_binding_without_pane_content_session_fields`
(validator-A10: agent-api-created claude pane — paneContent carries NO
`sessionRef`/`resumeSessionId`; seed the session binding ONLY in the terminal
registry, simulating post-association metadata; assert the rename still
cascades to the session override via the registry-first resolution).

- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** (rewrite
`rename_pane`; delete its "validating no-op" doc block `lib.rs:1366-1394`;
add the sessionRef-superset DEVIATIONS.md note from behavior clause 4).
**Step 4:** `cargo test -p freshell-freshagent 2>&1 | tail -5` then
`cargo test --workspace --exclude freshell-tauri 2>&1 | tail -5` → green.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/ crates/freshell-server/src/main.rs port/oracle/DEVIATIONS.md
git commit -m "feat(freshagent): real PATCH /api/panes/:id — store rename, ui.command broadcast, syncable-terminal cascade (D10)"
```

---

# PART D — Git enrichment of terminal metadata (Item 5)

Node reference: `server/terminal-metadata-service.ts` (TerminalMeta `:19-31`,
`enrichFromCwd :260-286`, retire `:203-219` with `RETIRED_TTL_MS = 1h`) +
`server/coding-cli/utils.ts` (roots fs-walk `:35-71/169-257`, branch+dirty
subprocess `:93-116/151-167`, unbounded root caches `:24-26`). Wire type
`TerminalMetaRecord` is ALREADY fully ported with correct camelCase
(`crates/freshell-protocol/src/common.rs:187-212`) and round-trip-tested
(`freshell-protocol/tests/roundtrip.rs:235-244`) — only the producer is
missing. This closes the DEV-0008 documented gap.

### Task 17: `freshell-platform` git helpers

**Files:**
- Create: `crates/freshell-platform/src/git_meta.rs`
- Modify: `crates/freshell-platform/src/lib.rs` (add `pub mod git_meta;`)

**Interfaces (produced):**

```rust
/// `normalizeGitPathInput` (utils.ts:138-149): `~` -> $HOME-resolved; absolute
/// -> resolved; RELATIVE -> None (resolving against the server cwd would lie).
pub fn normalize_git_path_input(cwd: &str) -> Option<std::path::PathBuf>;
/// fs walk for `.git` (dir OR file). Worktree (`gitdir:` containing
/// `/.git/worktrees/`): repo mode follows `<gitdir>/commondir` up to the
/// PARENT repo root; checkout mode returns the dir holding the `.git` file.
/// Submodule (`/.git/modules/`): both modes return the dir holding `.git`.
/// Not a repo / any error -> the normalized cwd itself. Results cached
/// (process-lifetime, unbounded, keyed by normalized cwd — Node parity).
pub fn resolve_git_repo_root(cwd: &str) -> Option<String>;
pub fn resolve_git_checkout_root(cwd: &str) -> Option<String>;
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BranchAndDirty { pub branch: Option<String>, pub is_dirty: Option<bool> }
/// BLOCKING (spawns `git` twice) — call via tokio spawn_blocking.
/// `git -C <checkoutRoot> symbolic-ref --short HEAD` -> fallback
/// `rev-parse --abbrev-ref HEAD`;
/// `git -C <checkoutRoot> --no-optional-locks status --porcelain`.
/// EVERY spawned git command sets `GIT_OPTIONAL_LOCKS=0` (env) or passes
/// `--no-optional-locks` (validator-A7): Node uses plain
/// `git status --porcelain` (server/coding-cli/utils.ts:102) but is
/// event-driven; the Task 18 throttled polling without this would
/// continually rewrite .git/index.
/// "no branch AND clean" -> Default() (is_dirty stays None — utils.ts:105-107);
/// any error -> Default(). NOT cached (Node parity).
pub fn resolve_git_branch_and_dirty(cwd: &str) -> BranchAndDirty;
/// basename(checkoutRoot || cwd) after stripping trailing separators
/// (terminal-metadata-service.ts:43-53).
pub fn derive_display_subdir(cwd: Option<&str>, checkout_root: Option<&str>) -> Option<String>;
#[cfg(test)] pub fn clear_git_meta_caches();
```

- [ ] **Step 1: Write the failing tests** (inline module; `tempfile` +
`std::process::Command("git")` to build real fixtures — git is on this host):

```rust
fn git(dir: &std::path::Path, args: &[&str]) {
    let ok = std::process::Command::new("git").arg("-C").arg(dir).args(args)
        .env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t")
        .status().unwrap().success();
    assert!(ok, "git {args:?}");
}
fn init_repo(dir: &std::path::Path) {
    git(dir, &["init", "-b", "main"]);
    std::fs::write(dir.join("f.txt"), "x").unwrap();
    git(dir, &["add", "."]);
    git(dir, &["commit", "-m", "init"]);
}
#[test]
fn plain_repo_roots_and_branch_and_dirty() {
    clear_git_meta_caches();
    let t = tempfile::tempdir().unwrap();
    init_repo(t.path());
    let p = t.path().to_str().unwrap();
    assert_eq!(resolve_git_repo_root(p).as_deref(), t.path().canonicalize().unwrap().to_str());
    assert_eq!(resolve_git_checkout_root(p), resolve_git_repo_root(p));
    let bd = resolve_git_branch_and_dirty(p);
    assert_eq!(bd.branch.as_deref(), Some("main"));
    assert_eq!(bd.is_dirty, Some(false));
    std::fs::write(t.path().join("dirty.txt"), "y").unwrap();
    assert_eq!(resolve_git_branch_and_dirty(p).is_dirty, Some(true));
}
#[test]
fn worktree_checkout_stays_but_repo_collapses_to_parent() {
    clear_git_meta_caches();
    let t = tempfile::tempdir().unwrap();
    init_repo(t.path());
    let wt = t.path().join("wt");
    git(t.path(), &["worktree", "add", "-b", "feat-x", wt.to_str().unwrap()]);
    let wts = wt.to_str().unwrap();
    assert_eq!(resolve_git_checkout_root(wts).as_deref(), wt.canonicalize().unwrap().to_str());
    assert_eq!(resolve_git_repo_root(wts).as_deref(), t.path().canonicalize().unwrap().to_str());
    assert_eq!(resolve_git_branch_and_dirty(wts).branch.as_deref(), Some("feat-x"));
}
#[test]
fn non_repo_dir_returns_cwd_roots_and_empty_branch_dirty() {
    clear_git_meta_caches();
    let t = tempfile::tempdir().unwrap();
    let p = t.path().to_str().unwrap();
    assert_eq!(resolve_git_repo_root(p).as_deref(), t.path().canonicalize().unwrap().to_str());
    assert_eq!(resolve_git_branch_and_dirty(p), BranchAndDirty::default());
}
#[test]
fn relative_paths_are_refused() {
    assert_eq!(normalize_git_path_input("relative/dir"), None);
    assert_eq!(resolve_git_repo_root("relative/dir"), None);
}
#[test]
fn display_subdir_prefers_checkout_root_basename() {
    assert_eq!(derive_display_subdir(Some("/a/b/sub"), Some("/a/b/")).as_deref(), Some("b"));
    assert_eq!(derive_display_subdir(Some("/a/b/sub"), None).as_deref(), Some("sub"));
    assert_eq!(derive_display_subdir(None, None), None);
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p freshell-platform git_meta 2>&1 | tail -5`.

- [ ] **Step 3: Implement** per the interface doc comments (each carries its
Node cite). Detached-HEAD note: `rev-parse --abbrev-ref HEAD` prints `HEAD` —
return it verbatim (Node does). Cache error results too (`utils.ts:49`).

- [ ] **Step 4: Run tests, commit**

```bash
cargo test -p freshell-platform 2>&1 | tail -3
git add crates/freshell-platform/
git commit -m "feat(platform): git metadata helpers — repo/checkout roots (worktree-aware), branch+dirty, display subdir"
```

### Task 18: `TerminalMetaRegistry` + producers (badges live)

**Files:**
- Create: `crates/freshell-ws/src/terminal_meta.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (`WsState` gains `pub terminal_meta: terminal_meta::TerminalMetaRegistry`; `build_handshake` `:381-385` ships `terminal_meta: state.terminal_meta.list()` instead of `Vec::new()`)
- Modify: `crates/freshell-ws/src/terminal.rs` (`terminal_meta_record_for_create` `:1363-1387` relaxed; create path `:1270-1325` enriches async; exit hook `:1159` + kill `:1698` retire + broadcast remove)
- Modify: `crates/freshell-ws/src/amplifier_association.rs:184-195` and `opencode_association.rs:182-193` (association-time records enrich + commit through the registry)
- Modify: `crates/freshell-server/src/auto_title_sweep.rs` (per matched session terminal: refresh meta, change-gated)
- Modify: `crates/freshell-server/src/main.rs` (construct + fan out the registry)
- Modify: `port/oracle/DEVIATIONS.md` (DEV-0008 closure note — Step 6)

**Interfaces:**
- Consumes: Task 17 helpers; `freshell_protocol::common::TerminalMetaRecord`; `ServerMessage::TerminalMetaUpdated` (`{upsert:[], remove:[]}`, emit pattern `ws/terminal.rs:1394-1401`).
- Produces:
  ```rust
  pub const RETIRED_TTL_MS: i64 = 3_600_000; // 1h, terminal-metadata-service.ts:109
  #[derive(Clone, Default)]
  pub struct TerminalMetaRegistry { /* Arc<Mutex<HashMap<String, MetaEntry>>> */ }
  impl TerminalMetaRegistry {
      /// Compare ignoring updatedAt (terminalMetaEquals, :93-106); when changed,
      /// stamp updated_at = now, store, and return the record for broadcasting.
      pub fn commit_if_changed(&self, next: freshell_protocol::common::TerminalMetaRecord, now: i64) -> Option<freshell_protocol::common::TerminalMetaRecord>;
      /// Strip volatile fields (ALL git fields + tokenUsage), keep
      /// terminalId/cwd/provider/sessionId, mark retired (service :203-219).
      pub fn retire(&self, terminal_id: &str, now: i64) -> bool;
      pub fn list(&self, now: i64) -> Vec<freshell_protocol::common::TerminalMetaRecord>; // excludes retired; prunes retired entries older than RETIRED_TTL_MS
      pub fn get(&self, terminal_id: &str) -> Option<freshell_protocol::common::TerminalMetaRecord>; // includes retired
  }
  /// Fill checkout_root/repo_root/display_subdir/branch/is_dirty from cwd via
  /// spawn_blocking (enrichFromCwd, service :260-286): live git wins, existing
  /// values kept as fallback; falsy cwd clears the three root fields.
  pub async fn enrich_from_cwd(record: &mut freshell_protocol::common::TerminalMetaRecord);
  pub fn broadcast_terminal_meta_updated(tx: &tokio::sync::broadcast::Sender<String>, upsert: Vec<freshell_protocol::common::TerminalMetaRecord>, remove: Vec<String>);
  ```
- Behavior changes in `terminal.rs`:
  - `terminal_meta_record_for_create` DROPS both early returns (`mode == "shell"` → `None` and missing `resume_session_id` → `None`): Node's `seedFromTerminal` seeds EVERY terminal; `provider` is `None` for shells, `session_id` optional (`terminal-metadata-service.ts:138-146`).
  - After `terminal.created`, spawn a task: `enrich_from_cwd` → `commit_if_changed` → on `Some(rec)`, `broadcast_terminal_meta_updated(tx, vec![rec], vec![])`. (Enrichment is async so terminal creation latency is untouched.)
  - PTY exit + `terminal.kill`: `retire` → `broadcast_terminal_meta_updated(tx, vec![], vec![terminal_id])` (Node: `server/index.ts:657-665`).

- [ ] **Step 1: Write the failing tests:**

In `terminal_meta.rs` (inline):
```rust
#[test] fn commit_if_changed_suppresses_identical_records_ignoring_updated_at() { }
#[test] fn retire_strips_git_fields_keeps_identity_and_list_prunes_after_ttl() { }
#[tokio::test] async fn enrich_from_cwd_fills_all_five_fields_for_a_real_repo() {
    // init_repo(tempdir) as in Task 17; record with cwd = repo path;
    // after enrich: branch=="main", is_dirty==Some(false), display_subdir==basename,
    // checkout_root/repo_root == canonical repo path.
}
```
In `terminal.rs` (extend `mod terminal_meta_created_tests`, `:2441-2610` —
pure-builder + wire-shape pattern, no PTY):
```rust
#[test] fn shell_terminals_now_get_a_meta_record_without_provider() { }
#[test] fn coding_cli_record_without_resume_session_still_gets_a_record() { }
```
In `crates/freshell-ws/tests/session_identity_frames.rs`: extend the
`terminal.inventory` assertions (`:295`, `:369`) to assert `terminalMeta` is a
non-empty array whose row carries the created terminal's `terminalId` and a
`cwd` (this pins the handshake fix).

- [ ] **Step 2: Run to verify failure** — `cargo test -p freshell-ws terminal_meta 2>&1 | tail -5` and the two extended suites.

- [ ] **Step 3: Implement** registry + wiring per the Interfaces block. The
auto-title sweep hook (Node's `applySessionMetadata` analog) is REDESIGNED
after validator-A7 falsified per-tick trigger equivalence: enrichment runs
per UNIQUE normalized cwd (NOT per terminal), change-gated — run git for a
cwd only when (a) that cwd's terminal-set/cwd signature changed since its
last enrichment, or (b) its last git run is >= 30 s old (throttled refresh so
dirty-status drift still surfaces). Keep `spawn_blocking` for the git calls.
Then, per `matching` identity (the cwd-scoped
`find_all_by_session(provider, session_id, session.cwd)` fan-out from
Task 5): build the record from the identity + session (`cwd` =
`select_more_specific_cwd(identity.cwd, session.cwd)` — port the "more path
segments wins" chooser from `terminal-metadata-service.ts:63-76`), fold the
parsed session `git_branch` (`freshell-sessions/src/meta.rs:58`) as fallback
under the live git result, reuse that cwd's cached enrichment result,
`commit_if_changed`, broadcast (only when content changed).
Add field `terminal_meta: freshell_ws::terminal_meta::TerminalMetaRegistry`
to `AutoTitleSweepState`.

Record the trigger divergence honestly (validator-A7): Node runs its
metadata pass ONLY on indexer update events (`server/index.ts:873` onUpdate;
debounce 2 s, `session-indexer.ts:436`) — an idle Node spawns ZERO git
processes — and its pass is per-terminal and uncached (`utils.ts:93-116`,
with only repo roots cached `:24-26`). The Rust design keeps a throttled
per-cwd poll instead, with `GIT_OPTIONAL_LOCKS=0` / `--no-optional-locks` on
every spawned git (a 0.5 Hz poll without it would continually rewrite
`.git/index`). Measured local cost: 0.01 s per
`git --no-optional-locks status --porcelain` on this repo (validator-A7).
Residual: /mnt/c DrvFs cwds are 10-100x slower; the >= 30 s throttle bounds
the worst case to delayed badges.

- [ ] **Step 4: Run** `cargo test --workspace --exclude freshell-tauri 2>&1 | tail -5`
(update the 12 `WsState` literal constructions in `crates/freshell-ws/tests/`
with `terminal_meta: Default::default()`).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/ crates/freshell-server/
git commit -m "feat(ws): terminal metadata registry + git-enriched terminal.meta.updated/inventory (closes DEV-0008 gap)"
```

- [ ] **Step 6: Update the ledger.** In `port/oracle/DEVIATIONS.md`:
1. Append to the DEV-0008 entry (do NOT rewrite its history): a dated
   `closure_update` line stating the `terminal.meta.updated` producer +
   `TerminalMetadataService` equivalent is now ported (this plan, commit
   sha), the user-facing disclosure sentence no longer applies, and the
   pinning coverage is `crates/freshell-ws/src/terminal_meta.rs` tests +
   `tests/session_identity_frames.rs` + the Task 23 Playwright spec.
2. Add a NEW entry for the KEPT git-enrichment trigger divergence
   (validator-A7): throttled per-unique-cwd polling + optional-locks
   suppression vs Node's indexer-event-driven, per-terminal, uncached pass
   (`server/index.ts:873`; `session-indexer.ts:436`; `utils.ts:93-116`,
   `:24-26`). Include the fingerprint (trigger schedule + `git
   --no-optional-locks` invocations), the pinning test (Task 18/Task 23 git
   badge coverage), the measured 0.01 s local cost and the /mnt/c DrvFs
   residual, and antagonist adjudication — NEVER self-approved. Task 24
   references this entry.

Commit:

```bash
git add port/oracle/DEVIATIONS.md
git commit -m "docs(deviations): DEV-0008 closure + git-enrichment trigger-divergence entry"
```

---

# PART E — Sidebar ↔ pane title convergence (Item 6)

The Task 5 sweep heals divergence for LIVE syncable coding-CLI terminals
within one tick (canonical override → `registry.update_title` +
`terminal.title.updated`), exactly like Node — a BACKSTOP healer, not a
proven universal property. Acceptance #6 (convergence) is evidenced by: a
closed static writer inventory (all 12 `titleOverride` call sites audited —
validator-A5), the fixed client paths below, the title-sync-convergence e2e
rename journeys (Task 21, both projects), and the server sweep as backstop
for live syncable terminals; the accepted residual is ledgered as A5-R1. The
client desync paths are bugs that exist on BOTH backends: D3/D4/D7 (verified
by the audit in
`.the-usual-logs/naming-persistence-sweep/reports/client-title-sync.md`)
plus two paths validator-A5 found — the exited-terminal pane-rename drop
(D8) and the OverviewView inline-rename blind spot. The task spec explicitly
authorizes fixing them and requires DEVIATIONS ledgering. These are the ONLY
`src/` changes in this plan.

### Task 19: client convergence fixes (D3, D4, D7, D8, Overview) + ledger entries

**Files:**
- Modify: `src/store/panesSlice.ts` (new reducer `updatePaneTitleBySessionRef`)
- Modify: `src/store/paneTitleSync.ts` (`syncPaneTitleByTerminalId` gains optional `setByUser`)
- Modify: `src/store/titleSync.ts` (new exported helper `applySessionRenameCascade`; exited-terminal rename fallback — the `:35` bail is replaced with a `sessionRef` resolution, validator-A5)
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (`renameSession` `:470-491` uses the helper; `renameTerminal` `:700-729` also updates the pane title)
- Modify: `src/components/HistoryView.tsx:101-107` (switch to the shared helper)
- Modify: `src/components/OverviewView.tsx` (`:167-177`, `:224-230` — TerminalCard inline rename re-routed through the shared rename helper, validator-A5)
- Modify: `port/oracle/DEVIATIONS.md` (EDEV entry)
- Test: `test/unit/client/store/paneSessionTitleSync.test.ts` (new)

**Interfaces:**
- Produces:
  - `panesSlice`: `updatePaneTitleBySessionRef(state, action: PayloadAction<{ provider: string; sessionId: string; title: string; setByUser?: boolean }>)` — walks all `state.layouts` leaves; matches a pane whose `content.kind === 'fresh-agent'` with `content.provider === provider && content.sessionId === sessionId`, OR `content.kind === 'terminal'` with `content.sessionRef?.provider === provider && content.sessionRef?.sessionId === sessionId`; applies the same write/sticky logic as `updatePaneTitleByTerminalId` (`panesSlice.ts:1663-1684`), including the sticky skip when `setByUser === false`.
  - `paneTitleSync.ts`: `syncPaneTitleByTerminalId({ terminalId, title, setByUser }: { terminalId: string; title: string; setByUser?: boolean })` — passes `setByUser ?? false` through (default unchanged for the existing HistoryView caller semantics? NO — see below: HistoryView passes `true` now; the DEFAULT stays `false` so any other caller keeps old behavior).
  - `titleSync.ts`:
    ```ts
    export function applySessionRenameCascade(input: {
      dispatch: AppDispatch
      provider: string
      sessionId: string
      title: string
      cascadedTerminalId?: string | null
    }): void
    // 1. if cascadedTerminalId: dispatch(updatePaneTitleByTerminalId({terminalId, title, setByUser: true}))
    // 2. always: dispatch(updatePaneTitleBySessionRef({provider, sessionId, title, setByUser: true}))
    //    (covers SDK/fresh-agent panes that can never cascade server-side — D4)
    ```
  - `titleSync.ts` exited-terminal fix (D8, validator-A5): `titleSync.ts:35`
    currently bails when the coding-CLI terminal has exited
    (`TerminalView.tsx:3841`), so the user's pane rename intent never persists
    and the sweep cannot heal it (it only sees live terminals). Fix: when the
    terminal is gone, fall back to the pane's `sessionRef` to resolve
    `provider:sessionId` and PATCH the session override anyway.
  - `OverviewView.tsx` fix (validator-A5): the TerminalCard inline rename
    (`:167-177`, `:224-230`) PATCHes the terminal/session but never writes
    `paneTitles` — and the sweep is structurally blind post-PATCH
    (registry == override → no mismatch → no `terminal.title.updated` push).
    Fix: re-route it through the shared rename helper the other surfaces use
    (`applySessionRenameCascade` / `updatePaneTitleByTerminalId`) so the pane
    mirror updates too.
- Policy (Scope Decision 3): these are USER renames → `setByUser: true`, so
  they land even on previously user-renamed panes and stay sticky.

- [ ] **Step 1: Write the failing unit tests** in
`test/unit/client/store/paneSessionTitleSync.test.ts`, following the exact
idiom of `test/unit/client/store/codingAgentNaming.test.ts:1-25` (real
`configureStore` with `tabs`+`panes` reducers, `vi.mock('nanoid')`,
`vi.hoisted` api mock):

```ts
import { describe, it, expect, vi } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import tabsReducer, { addTab } from '@/store/tabsSlice'
import panesReducer, { initLayout, updatePaneTitle, updatePaneTitleBySessionRef } from '@/store/panesSlice'
import { applySessionRenameCascade } from '@/store/titleSync'

vi.mock('nanoid', () => { let n = 0; return { nanoid: vi.fn(() => `pane-${++n}`) } })

function freshAgentStore() {
  const store = configureStore({ reducer: { tabs: tabsReducer, panes: panesReducer } })
  store.dispatch(addTab({ title: 'freshell', mode: 'claude' }))
  const tabId = store.getState().tabs.tabs[0].id
  store.dispatch(initLayout({
    tabId,
    content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
               sessionId: 's1', createRequestId: 'r1', status: 'running' },
  }))
  const paneId = (store.getState().panes.layouts[tabId] as { id: string }).id
  return { store, tabId, paneId }
}

describe('updatePaneTitleBySessionRef', () => {
  it('writes the pane title for a matching fresh-agent pane', () => {
    const { store, tabId, paneId } = freshAgentStore()
    store.dispatch(updatePaneTitleBySessionRef({ provider: 'claude', sessionId: 's1', title: 'New', setByUser: true }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('New')
  })
  it('non-matching sessionRef leaves titles alone', () => {
    const { store, tabId, paneId } = freshAgentStore()
    store.dispatch(updatePaneTitleBySessionRef({ provider: 'codex', sessionId: 's1', title: 'New' }))
    expect(store.getState().panes.paneTitles[tabId]?.[paneId]).not.toBe('New')
  })
  it('setByUser:false respects the sticky flag; setByUser:true overrides it (D6 policy)', () => {
    const { store, tabId, paneId } = freshAgentStore()
    store.dispatch(updatePaneTitle({ tabId, paneId, title: 'Mine' })) // sticky
    store.dispatch(updatePaneTitleBySessionRef({ provider: 'claude', sessionId: 's1', title: 'Auto', setByUser: false }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Mine')
    store.dispatch(updatePaneTitleBySessionRef({ provider: 'claude', sessionId: 's1', title: 'UserWins', setByUser: true }))
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('UserWins')
  })
})

describe('applySessionRenameCascade', () => {
  it('mirrors a sidebar session rename into the pane by sessionRef (D3/D4)', () => {
    const { store, tabId, paneId } = freshAgentStore()
    applySessionRenameCascade({ dispatch: store.dispatch, provider: 'claude',
      sessionId: 's1', title: 'Renamed', cascadedTerminalId: null })
    expect(store.getState().panes.paneTitles[tabId][paneId]).toBe('Renamed')
  })
})
```

Add two more test groups to the same file (write them in full, same harness;
validator-A5):

```ts
// describe('exited-terminal pane rename (D8)'): seed a terminal pane whose
//   coding-CLI terminal has EXITED (no live terminalId in the registry mock)
//   but whose content carries sessionRef {provider:'claude', sessionId:'s1'};
//   invoke the titleSync pane-rename path (the code that today bails at
//   titleSync.ts:35) and assert the session-override PATCH is still issued
//   (api mock called with claude:s1 + titleOverride) — the rename intent
//   persists even though the terminal is gone.
// describe('OverviewView TerminalCard rename'): drive the extracted rename
//   handler OverviewView now shares with the other surfaces and assert it
//   dispatches the pane-title mirror (updatePaneTitleByTerminalId or
//   updatePaneTitleBySessionRef with setByUser: true) IN ADDITION to the
//   terminal/session PATCH — pinning that Overview renames update paneTitles.
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:vitest -- run test/unit/client/store/paneSessionTitleSync.test.ts 2>&1 | tail -10`
Expected: FAIL — `updatePaneTitleBySessionRef` is not exported.

- [ ] **Step 3: Implement the store changes.**
`updatePaneTitleBySessionRef` in `panesSlice.ts` — model it directly on
`updatePaneTitleByTerminalId` (`panesSlice.ts:1663-1684`), replacing the
terminal-id leaf match with the sessionRef match described in Interfaces (add
a `findPaneIdBySessionRef(layout, provider, sessionId)` helper next to the
existing `findPaneIdByTerminalId`). `applySessionRenameCascade` in
`titleSync.ts` exactly as specified. `syncPaneTitleByTerminalId` gains the
optional `setByUser` (default `false`).

- [ ] **Step 4: Run** the new test file (green) plus the neighbors:

```bash
npm run test:vitest -- run test/unit/client/store/paneSessionTitleSync.test.ts test/unit/client/store/titleSync.serverSync.test.ts test/unit/client/store/codingAgentNaming.test.ts 2>&1 | tail -5
```

- [ ] **Step 5: Wire the components.**
1. `ContextMenuProvider.renameSession` (`:470-491`): capture the PATCH result
   (`await api.patch<{ cascadedTerminalId?: string | null }>(...)` — the shape
   `HistoryView.tsx:104` already uses), then when a non-blank `titleOverride`
   was set call
   `applySessionRenameCascade({ dispatch, provider, sessionId, title, cascadedTerminalId: result.cascadedTerminalId })`
   BEFORE the existing `refreshActiveSessionWindow()` dispatch.
2. `ContextMenuProvider.renameTerminal` (`:700-729`): after the existing
   `updateTab` dispatch (`:722-725`), add
   `dispatch(updatePaneTitleByTerminalId({ terminalId, title, setByUser: true }))`
   (D7: pane header + `getTabDisplayTitle`'s pane-title preference both
   converge).
3. `HistoryView.tsx:104-106`: replace the bare `syncPaneTitleByTerminalId`
   dispatch with the same `applySessionRenameCascade` helper (gives history
   renames the D4 sessionRef mirror too).
4. `titleSync.ts:35` (D8, validator-A5): replace the exited-terminal bail
   with a fallback that resolves the pane's `sessionRef`
   (provider+sessionId) and PATCHes the session override even when the
   coding-CLI terminal is gone (`TerminalView.tsx:3841` is where the exited
   state originates) — the user's rename intent must persist; the sweep
   cannot heal exited terminals.
5. `OverviewView.tsx:167-177, :224-230` (validator-A5): re-route the
   TerminalCard inline rename through the shared rename helper so the pane
   mirror (`paneTitles`) updates alongside the terminal/session PATCH — the
   sweep is structurally blind post-PATCH (registry == override → no
   mismatch → no `terminal.title.updated` push), so the client MUST do the
   mirroring itself.
Typecheck: `npm run typecheck:client 2>&1 | tail -3` → clean.

- [ ] **Step 6: Ledger the client change.** Append to the EDEV section of
`port/oracle/DEVIATIONS.md`:

```markdown
### EDEV-08 — client title-convergence fixes (sidebar/history/terminal-menu/Overview renames now mirror into pane titles; exited-terminal renames persist)
- what_differs: `src/store/titleSync.ts` gains `applySessionRenameCascade` and replaces the
  exited-terminal bail (titleSync.ts:35) with a `sessionRef` fallback PATCH; `src/store/panesSlice.ts`
  gains `updatePaneTitleBySessionRef`; `ContextMenuProvider.renameSession`/`renameTerminal` and
  `HistoryView.renameSession` dispatch pane mirrors with `setByUser: true`;
  `src/components/OverviewView.tsx` TerminalCard inline rename is re-routed through the shared
  rename helper so `paneTitles` updates too. Applies identically to BOTH backends (shared client).
- why_intentional: explicit user directive in the naming-persistence-sweep task: "for the same
  underlying session/terminal, the sidebar item title and the pane title must never disagree";
  the pre-fix client dropped `cascadedTerminalId` (ContextMenuProvider.tsx:483-487), never
  mirrored session renames into SDK panes, silently dropped pane renames on exited coding-CLI
  terminals (titleSync.ts:35 / TerminalView.tsx:3841), and left Overview renames invisible to
  paneTitles while the sweep is structurally blind post-PATCH — defects on the original too
  (desync paths D3/D4/D7 audit: .the-usual-logs report client-title-sync.md; D8 + Overview:
  validator-A5).
- evidence: test/e2e-browser/specs/title-sync-convergence.spec.ts (both projects, incl. the
  Overview rename journey) + test/unit/client/store/paneSessionTitleSync.test.ts; commit <sha>.
- user_impact: renaming a session from the sidebar/history/terminal menus or the Overview page
  now updates the open pane header immediately on both servers, and renaming a pane whose
  coding-CLI terminal already exited still persists; previously the pane kept the stale name
  until a sidebar click (or the rename was silently lost).
```

(Fill `<sha>` after committing. The purity note: this src/ diff is authorized
by the task spec; the e2e matrix spec is its pinning test.)

- [ ] **Step 7: Commit**

```bash
git add src/store/panesSlice.ts src/store/titleSync.ts src/store/paneTitleSync.ts \
        src/components/context-menu/ContextMenuProvider.tsx src/components/HistoryView.tsx \
        src/components/OverviewView.tsx \
        test/unit/client/store/paneSessionTitleSync.test.ts port/oracle/DEVIATIONS.md
git commit -m "fix(client): converge sidebar/history/terminal-menu/Overview renames into pane titles (D3/D4/D7/D8, EDEV-08)"
```

---

# PART F — Cleanups, e2e proof, bookkeeping, delivery

### Task 20: session-metadata read-join (cheap cleanup)

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs` (item build path around `apply_session_overrides`, `:648-671`)
- Possibly modify: `crates/freshell-server/src/session_metadata.rs` (`SessionMetadataStore` `:69-256`)

**Interfaces:**
- Consumes: `SessionMetadataStore::get_all()` (exists, currently zero non-test callers — `session_metadata.rs:118-119` documents the unported read callers).
- Produces: session-directory items overlay `sessionType` from the metadata
  store, mirroring Node's read-join (`server/coding-cli/session-indexer.ts:956,
  :1254` are the Node read sites; SESSION-02's note assigns session type to
  "SESSION-06's separate metadata store").

- [ ] **Step 1: Precondition check.** Run:

```bash
grep -n "session_metadata\|sessionType" crates/freshell-server/src/session_directory.rs | head -20
```

If the join already exists, convert this task to a verification: add/point to
a test proving it, note evidence in the Task 24 checklist update, and skip to
Step 5's commit (docs-only). Otherwise continue.

- [ ] **Step 2: Write the failing test** in `session_directory.rs`'s test
module (mirror the harness of the existing overlay test referenced from
`sessions.rs:848` — `patch_override_is_visible_through_session_directory_overlay`):
write a metadata row via `SessionMetadataStore::set(<key>, <sessionType>)`
for a seeded session, GET `/api/session-directory`, assert the served item
carries `"sessionType": "<value>"`.

- [ ] **Step 3: Run to verify failure**, then implement: construct/lookup the
`SessionMetadataStore` in the session-directory state (same home dir), call
`get_all()` once per request, and overlay `sessionType` onto matching items
(key = `provider:sessionId`).

- [ ] **Step 4: Run** `cargo test -p freshell-server session_directory 2>&1 | tail -5` → ok.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-server/
git commit -m "feat(server): join session-metadata sessionType into /api/session-directory items"
```

### Task 21: Playwright — auto-title pipeline + title convergence + settings split

**Files:**
- Create: `test/e2e-browser/specs/auto-title-rust.spec.ts`
- Create: `test/e2e-browser/specs/title-sync-convergence.spec.ts`
- Create: `test/e2e-browser/specs/settings-split-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (register: `auto-title-rust` + `settings-split-rust` in the rust-only spec list of the `rust-chromium` project; `title-sync-convergence` in `MATRIX_SPECS` so it runs on BOTH projects)

**Interfaces:**
- Consumes: the e2e fixtures (`testServer` with `e2eServerKind: 'rust'`,
  isolated `HOME`, ephemeral port — `test/e2e-browser/helpers/rust-server.ts`);
  session seeding — copy the seeding approach of
  `test/e2e-browser/specs/session-directory-matrix.spec.ts` (writes provider
  session files under the isolated home); fake CLI —
  `test/e2e-browser/fixtures/fake-codex-cli.mjs` precedent; the
  `FRESHELL_GEMINI_BASE_URL` seam from Task 2 (the rust fixture passes env
  through — verify `helpers/rust-server.ts` `boot()` env assembly and extend it
  to forward this variable if it filters env).

- [ ] **Step 1: Write `auto-title-rust.spec.ts` (failing first).** Structure
(follow the imports/fixture usage of `session-directory-matrix.spec.ts`
verbatim; every `test()` below is real code to write, with the standard
`test.describe` + fixture boilerplate):

```ts
// Test 1: "background sweep auto-names a live session: dir placeholder then first-message"
//  - seed a claude session file (first user message "Repair the flux capacitor")
//    into the isolated home, with a cwd of <home>/projects/fluxrepair
//  - open the app, resume the session from the sidebar (or POST /api/tabs with
//    resumeSessionId via page.request — both count per checklist :80)
//  - poll GET /api/session-directory via page.request until the item's title
//    becomes "Repair the flux capacitor" (sweep interval 2s; timeout 15s)
//  - assert config.json sessionOverrides["claude:<id>"].titleSource === "first-message"
//    by reading <home>/.freshell/config.json from the test (isolated home)
//  - assert the sidebar row text shows the title (zero client action beyond opening)
//  - assert the PANE header converged too (terminal.title.updated push):
//    await expect(page.getByTestId(/pane-header|pane-title/).first()).toContainText("Repair the flux")
//    (use the same pane-header locator existing specs use — grep specs/ for the pane title locator)

// Test 2: "Gemini finalizes as ai when key + autoGenerateTitles are on (fake Gemini)"
//  - BEFORE booting the server, start a local fake Gemini: an http server on
//    127.0.0.1:0 answering POST /v1beta/models/gemini-2.5-flash-lite:generateContent
//    with {candidates:[{content:{parts:[{text:"Flux capacitor repair"}]}}]}
//    (plain node:http inside the spec; assert x-goog-api-key header arrives)
//  - boot the rust server with env FRESHELL_GEMINI_BASE_URL=http://127.0.0.1:<port>/v1beta
//    and seed settings ai.geminiApiKey via PATCH /api/settings (page.request)
//  - same seeding as Test 1; poll until the directory item title === "Flux capacitor repair"
//    and sessionOverrides titleSource === "ai"

// Test 3: "user rename is never clobbered by the sweep"
//  - after Test-1-style naming, PATCH /api/sessions/claude:<id> {titleOverride:"MINE"}
//  - wait 3 sweep ticks (7s), assert directory title still "MINE" and titleSource "user"

// Test 4: "generate-title endpoint uses fake Gemini and echoes ladder-resolved result"
//  - POST /api/sessions/claude:<id>/generate-title {firstMessage:"..."} via page.request
//  - assert {title:"Flux capacitor repair", source:"ai"} and that a subsequent
//    GET /api/session-directory reflects it (sessions.changed → refresh path)

// Test 5: "terminal summary endpoint returns heuristic without key and ai with fake key"
//  - create a shell tab; wait for prompt output; POST /api/ai/terminals/<id>/summary
//  - without key: {source:"heuristic", description: <non-empty>}
//  - with key+fake: {source:"ai", description:"..."}
```

RED first: run against the CURRENT binary before your server work is merged
into the local build? No — by this task the server work IS in the worktree;
instead make the spec RED by running it against `legacy-chromium`'s rust-less
sibling? Not applicable. The honest RED here: `git stash` is NOT required —
document RED by asserting the spec fails when the fake-Gemini env var is
withheld for Test 2 (title stays "fluxrepair") and by the pre-implementation
run in Task 24's evidence if you kept one. Practical rule: write the spec,
run it, and if it passes first try, deliberately flip one assertion to prove
the harness actually exercises the path, then restore it.

Build + run:
```bash
cargo build --release -p freshell-server
npm run build:client
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/auto-title-rust.spec.ts
```
Expected: all tests pass; run twice ("Green 2x") and record timings.

- [ ] **Step 2: Write `title-sync-convergence.spec.ts` (matrix — BOTH projects).**
Tests (each drives the UI, then asserts BOTH surfaces; `page.request` allowed
for the automation surface):

```ts
// Test 1 "pane header rename converges the sidebar":
//   create a coding-CLI tab (resume seeded session), rename via the pane header
//   inline editor (dblclick + type + Enter — copy the interaction from any
//   existing rename spec; grep specs/ for "rename"), then poll the sidebar row
//   until it shows the new name.
// Test 2 "sidebar context-menu rename converges the pane header" (pins EDEV-08):
//   right-click the sidebar row -> Rename -> type -> confirm; assert the pane
//   header text updates (no sidebar click needed).
// Test 3 "automation PATCH /api/panes/:id converges pane header + tab + sidebar":
//   page.request.patch(`/api/panes/${paneId}`, {data:{name:"Automation Name"}})
//   -> pane header shows it (ui.command pane.rename), tab title shows it
//   (single-pane mirror), and for a syncable coding-CLI pane the sidebar row
//   converges (cascade + terminals.changed refetch).
//   NOTE: on legacy-chromium this already works (Node behavior) — the matrix
//   run doubles as the regression control.
// Test 4 "history-view rename converges the pane":
//   open History, rename the session there, assert pane header converges.
// Test 5 "Overview inline rename converges pane + sidebar (pins the
//   OverviewView fix, validator-A5)":
//   open the Overview page, inline-rename a TerminalCard (OverviewView.tsx
//   editing affordance), assert the pane header AND the sidebar row converge.
//   Pre-fix, the PATCH left paneTitles stale and the sweep was structurally
//   blind post-PATCH (registry == override -> no mismatch -> no
//   terminal.title.updated push).
```

Register in `MATRIX_SPECS`. Run both projects:
```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --project=legacy-chromium test/e2e-browser/specs/title-sync-convergence.spec.ts
```
Expected: green on BOTH (legacy proves the client fixes didn't regress Node).

- [ ] **Step 3: Write `settings-split-rust.spec.ts` (CFG-12).**

```ts
// Two isolated browser contexts A and B against one rust server:
//  - in A: change a browser-local preference (theme / sidebar sort — grep the
//    settings UI for the theme toggle locator) and a server setting
//    (defaultCwd via the settings UI or PATCH /api/settings)
//  - assert B receives the server setting (poll GET /api/settings from B's
//    context; and/or B's UI reflects new default cwd on next tab create)
//    but B's local appearance (theme attribute on <html>/body) is unchanged
//  - reload both, restart the server (fixture restart()), assert the server
//    setting persisted and each context kept its own local appearance
```

Register as rust-only. Run and record.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/auto-title-rust.spec.ts test/e2e-browser/specs/title-sync-convergence.spec.ts test/e2e-browser/specs/settings-split-rust.spec.ts test/e2e-browser/playwright.config.ts test/e2e-browser/helpers/
git commit -m "test(e2e): auto-title pipeline, cross-surface title convergence (matrix), settings split (CFG-12)"
```

### Task 22: Playwright — durable tabs registry across restart

**Files:**
- Create: `test/e2e-browser/specs/tabs-registry-persistence-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (rust-only list)

**Interfaces:**
- Consumes: the WS tabs.sync helpers used by `test/e2e-browser/specs/tabs-client-retire.spec.ts` (raw WS client or `page.evaluate` push — copy its approach verbatim), the fixture's `restart()` (same home/port/token — `rust-server.ts`).

- [ ] **Step 1: Write the spec** (CFG-08 + AUTO-15 acceptance, mirroring the
checklist's validation wording):

```ts
// Test 1 "cross-device tab registry survives a server restart":
//  - context A pushes tabs.sync.push (deviceId dev-A, revision 1, one open record)
//  - context B pushes (deviceId dev-B, revision 1, open + closed records)
//  - close context A WITHOUT retiring
//  - RESTART the rust server (fixture restart())
//  - from a NEW context C (deviceId dev-C), send tabs.sync.query BEFORE A or B
//    republish; assert remoteOpen contains BOTH devices' open records verbatim
//    and closed contains B's tombstone
// Test 2 "idempotent retry, content conflict, stale rejection, retire non-resurrection":
//  - push rev 2 twice identically -> second ack accepted (idempotent)
//  - push rev 2 with DIFFERENT records -> error frame INVALID_MESSAGE
//    "Duplicate snapshot revision has different tabs registry content"
//  - push rev 1 -> error frame (stale)
//  - retire rev 3; push rev 3 -> error (<= watermark); RESTART; push rev 3
//    again -> still rejected (watermark persisted)
// Test 3 "corruption recovery matches Node semantics":
//  - stop server; delete one <home>/.freshell/tabs-registry/v1/objects/<sha>.json
//  - start server -> boots, tabs query returns EMPTY, and a
//    manifest.json.invalid-* archive exists (missing-object self-heal)
//  - IMPORTANT (validator-A8-A9): after the missing-object archive, open()
//    falls through to the LEGACY branch BEFORE empty (store.ts:692-709) —
//    ensure no stray legacy <home>/.freshell/tabs-registry.jsonl coexists in
//    the isolated home (or explicitly account for it) before asserting
//    archive => empty
//  - (Node-parity note recorded in the checklist: any OTHER corruption fails
//    boot; the checklist's "only that record is quarantined" wording is
//    superseded by Node's actual all-or-nothing behavior — see Task 24.)
```

- [ ] **Step 2: Run** (rust-only project), twice, record timings. Then commit:

```bash
git add test/e2e-browser/specs/tabs-registry-persistence-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): tabs registry restart survival, conflict/retire semantics, corruption self-heal (CFG-08/AUTO-15)"
```

### Task 23: Playwright — automation layout + git badges

**Files:**
- Create: `test/e2e-browser/specs/automation-layout-rust.spec.ts`
- Create: `test/e2e-browser/specs/git-badges-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (rust-only list)

- [ ] **Step 1: Write `automation-layout-rust.spec.ts`** (AUTO-03/06 + the
AUTO-01 snapshot/rename slice):

```ts
// Test 1 "tab routes: list/select/rename/delete/exists/next/prev via page.request":
//  - create three named tabs THROUGH THE UI (new-tab button; grep specs/ for the
//    new-tab interaction), wait for ui.layout.sync (poll GET /api/tabs until 3 rows)
//  - GET /api/tabs -> exact ids/order/titles + activeTabId
//  - POST /api/tabs/next -> response tabId is the next in order AND the UI
//    highlights that tab (locator assertion on the active tab)
//  - PATCH /api/tabs/:id {name:"Renamed"} -> UI tab shows "Renamed"
//  - GET /api/tabs/has?target=Renamed -> {exists:true} (title match)
//  - DELETE /api/tabs/:id -> tab gone from UI and from GET /api/tabs
// Test 2 "pane routes on a split layout":
//  - split a pane through the UI; GET /api/layout/snapshot -> real split node
//    with direction/sizes/two leaves; GET /api/panes -> index-ordered rows
//  - POST /api/panes/:id/resize {sizes:[30,70]} -> 200; snapshot sizes [30,70];
//    measured bounding boxes reflect ~30/70 (tolerance ±5%)
//  - POST /api/panes/:id/swap {target:<other>} -> contents exchanged in UI
//  - PATCH /api/panes/:id {name:"P1"} -> pane header shows "P1", tabRenamed
//    false on the two-pane tab
// Test 3 "no client connected -> Node's honest degradation":
//  - boot server, DO NOT open a page; page.request PATCH /api/tabs/x
//    -> 200 {data:{message:"no layout snapshot"}} (or top-level message —
//    match the Rust envelope exactly as Task 14 pinned it)
```

- [ ] **Step 2: Write `git-badges-rust.spec.ts`:**

```ts
// Test 1 "sidebar/pane badge shows branch + dirty star for a git cwd":
//  - inside the isolated home create <home>/projects/badgerepo; run
//    git init -b main / commit a file / then dirty it (child_process.execFileSync
//    from the spec — host git, isolated dir)
//  - create a shell tab with cwd=<home>/projects/badgerepo (POST /api/tabs
//    {cwd} via page.request, then open the app)
//  - expect the pane header meta label to contain "badgerepo (main*)"
//    (badge format: format-terminal-title-meta.ts:26-35; locator: the pane
//    meta label PaneContainer renders — grep src/components/panes/PaneContainer.tsx
//    for the label's testid/class and use that)
//  - reload the page; badge still present (handshake terminal_meta path)
```

- [ ] **Step 3: Run both specs** (rust-chromium), twice, record. Commit:

```bash
git add test/e2e-browser/specs/automation-layout-rust.spec.ts test/e2e-browser/specs/git-badges-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): automation tab/pane/layout parity + git branch/dirty badges on rust"
```

### Task 24: checklist + ledger bookkeeping

**Files:**
- Modify: `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`
- Modify: `port/oracle/DEVIATIONS.md` (only if any additional intentional divergence surfaced during Parts A–E; otherwise it already carries EDEV-08, the DEV-0008 closure, and the Task 18 git-enrichment trigger-divergence entry — verify the latter's antagonist adjudication is recorded, never self-approved)

- [ ] **Step 1: Update checklist items with evidence** (respect the exact
conventions at checklist `:8-22` and the evidence shape described in Global
Constraints). For each item below, add the evidence bullet(s) with spec path,
quoted test title, projects, "Green 2x" + timings, commit shas; check the box
ONLY where the full Definition of Done holds:

| Item (line) | Action |
|---|---|
| CFG-08 (`:107`) | CHECK `[x]` — Task 22 spec. Add a note: the "only that record is quarantined" wording is narrowed to Node's actual semantics (missing-object → archive+empty; other corruption → boot failure), per port-equivalence discipline. |
| AUTO-15 (`:428`) | CHECK `[x]` — Task 22 spec (conflict/idempotent/stale/retire/tombstone/caps) + Task 11 unit tests. Note: HARNESS-14 (controllable clock) still absent — TTL expiry is proven at the unit level (`tabs.rs`/`tabs_store_model.rs` tests), not e2e; record this narrowing explicitly. |
| AUTO-03 (`:389`) | CHECK `[x]` — Task 23 Test 1. |
| AUTO-06 (`:398`) | CHECK `[x]` — Task 23 Test 2 (rename/close/select/resize/swap/respawn all exercised across Tasks 15/16 unit + e2e). |
| AUTO-01 (`:382`) | PARTIAL note (task spec explicitly narrows AUTO-01 to snapshot+rename equivalence): `ui.layout.sync` now ingested and authoritative for snapshot/tabs/panes/renames (Tasks 12-16, Task 23); reorder-through-UI and full ratio assertions remain MISSING. Leave `[ ]`. |
| SESSION-04 (`:140`) | CHECK `[x]` if Task 21 covered the full ladder priority proof (dir/first-message/ai/user + no-key fallback + deterministic fake-AI + stable cold-restart — add the restart assertion to auto-title-rust.spec.ts if missing); otherwise PARTIAL with the exact missing clause. |
| SESSION-02 (`:134`) / SESSION-03 (`:137`) | PARTIAL evidence notes citing the existing Rust unit tests (sessions.rs `:343-943` table) + `session-directory-matrix.spec.ts` + Task 21 rename coverage; leave `[ ]` unless every validation clause (archive icon/order, hidden deletion, createdAt ordering, restart projection) is e2e-proven. |
| SESSION-01 (`:124`) | No new claim unless Task 21's resume flow closed a named MISSING clause; if it did (sidebar click-resume for claude), append a Narrowed note. |
| CFG-12 (`:119`) | CHECK `[x]` — Task 21 settings-split spec (it covers both persistence paths incl. restart). |

- [ ] **Step 2: Run the checklist-adjacent controls** and paste outputs into
the evidence notes where required:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=legacy-chromium test/e2e-browser/specs/title-sync-convergence.spec.ts
```
(legacy control for the matrix spec — must be green).

- [ ] **Step 3: Commit**

```bash
git add docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md port/oracle/DEVIATIONS.md
git commit -m "docs(parity): evidence + checkboxes for CFG-08/CFG-12/AUTO-03/AUTO-06/AUTO-15 (+AUTO-01/SESSION-02..04 narrowing)"
```

### Task 25: full gates, merge to `feat/rust-tauri-port`, push (NO PR)

**Files:** none new (gate + delivery).

- [ ] **Step 1: Purity + hygiene checks**

```bash
git diff --name-only origin/feat/rust-tauri-port -- server/ shared/
# EXPECTED: empty output. If not empty: STOP and revert those files.
git diff --name-only origin/feat/rust-tauri-port -- src/
# EXPECTED: exactly the Task 19 file set (panesSlice.ts, titleSync.ts,
# paneTitleSync.ts, ContextMenuProvider.tsx, HistoryView.tsx,
# components/OverviewView.tsx). Anything else: revert it.
```

- [ ] **Step 2: Full Rust gates**

```bash
cargo test --workspace --exclude freshell-tauri 2>&1 | tail -3   # expect 0 failed
cargo test -p freshell-tauri 2>&1 | tail -3                       # expect 0 failed
```

- [ ] **Step 3: Full TS gate (coordinator)**

```bash
npm run check 2>&1 | tail -15
```
Expected: typecheck clean + coordinated suite green. (Client unit tests from
Task 19 run inside this.)

- [ ] **Step 4: e2e matrix re-run (the new specs, both projects where registered)**

```bash
npm run build:client && cargo build --release -p freshell-server
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium \
  test/e2e-browser/specs/auto-title-rust.spec.ts \
  test/e2e-browser/specs/tabs-registry-persistence-rust.spec.ts \
  test/e2e-browser/specs/automation-layout-rust.spec.ts \
  test/e2e-browser/specs/git-badges-rust.spec.ts \
  test/e2e-browser/specs/settings-split-rust.spec.ts \
  test/e2e-browser/specs/title-sync-convergence.spec.ts
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium test/e2e-browser/specs/title-sync-convergence.spec.ts
```
Expected: all green.

- [ ] **Step 5: Sync with the campaign branch and deliver**

```bash
git fetch origin
git merge origin/feat/rust-tauri-port   # resolve conflicts if the branch advanced; re-run Step 2-4 gates if it did
git push origin HEAD:feat/rust-tauri-port
git push origin feat/naming-persistence-sweep   # keep the working branch too
```

**DO NOT run `gh pr create`. DO NOT push `main`.** If the
`HEAD:feat/rust-tauri-port` push is rejected (remote advanced between fetch
and push), repeat this step.

- [ ] **Step 6: Final worktree hygiene**

```bash
git status --short   # expect: clean (no stray artifacts, no untracked test homes)
```
Remove any stray temp dirs/logs the e2e runs left inside the worktree before
declaring done.

---

## Self-Review Record (author-run, per the plan-writing methodology)

**1. Spec coverage:**
- Item 1 (automatic auto-naming pipeline incl. `autoGenerateTitles` gate,
  ladder respect, live-terminal pushes, `terminal.title.updated`): Tasks 1, 3,
  4, 5; e2e Task 21.
- Item 2 (Gemini generate-title + terminal summary, wired into the loop, mocked
  in tests): Tasks 2, 5, 6, 7; e2e Task 21 (fake Gemini; no live calls).
- Item 3 (durable tab-registry: caps/hashes/TTLs/migration/corruption + AUTO-15
  conflict/retirement): Tasks 8–11; e2e Task 22.
- Item 4 (automation REST tabs/panes/layout parity): Tasks 12–16; e2e Task 23.
- Item 5 (git enrichment → sidebar badges): Tasks 17–18; e2e Task 23.
- Item 6 (sidebar↔pane always in sync, any-surface rename convergence, Node
  defects fixed + ledgered): Tasks 5 (sweep backstop healer), 6 (D11), 16
  (D10), 19 (D3/D4/D7 + exited-terminal D8 + OverviewView + EDEV-08); e2e
  Task 21 (`title-sync-convergence`, both projects, incl. the Overview rename
  journey). Convergence is evidenced by the closed static writer inventory
  (all 12 `titleOverride` call sites audited — validator-A5), the fixed
  paths, the e2e rename journeys, and the server sweep as backstop for live
  syncable terminals — NOT as a proven universal property (accepted residual
  ledgered as A5-R1).
- Minor cleanups: session-metadata read-join (Task 20); CFG-12 verification
  (Task 21 spec + Task 24 evidence); SESSION-01..04 verify-not-reimplement
  (Task 24 table).
- Delivery constraints (merge to feat/rust-tauri-port, no PR, checklist +
  DEVIATIONS, full suites): Tasks 24–25.

**1b. No silent deferrals:** Gemini live calls are excluded BY the task spec
(mocked transport is the required production seam test-side; the production
`GeminiHttp` transport IS the shipped implementation and its wire contract is
pinned by the loopback test in Task 2 and the fake-Gemini e2e in Task 21).
Two scope narrowings are explicit and user-authorized, not silent: AUTO-01 is
narrowed to snapshot+rename equivalence by the task spec itself (recorded as
PARTIAL in Task 24), and multi-pane tab rename (D5) is Node-parity behavior
documented in Scope Decisions. AUTO-15's TTL expiry is e2e-limited by the
missing HARNESS-14 clock harness; it is proven at unit level and the narrowing
is recorded in the checklist note (Task 24) rather than silently dropped.

**2. Placeholder scan:** the remaining "write each comment as full test code"
instructions all sit next to complete shapes/algorithms and exact Node
file:line cites; no TBD/TODO/"handle edge cases"/"similar to Task N" remain.

**3. Type consistency:** `AutoTitlePatch`/`SessionTerminal`/`TitleSyncPlan`
(Task 1) are consumed with the same names in Task 5; `AiKeyCell`/
`GeminiTransport`/`BoxFuture` (Task 2) in Tasks 5–7; the 3-arg
`find_all_by_session(provider, session_id, cwd)` (Task 3, cwd-scoped per
validator-A4-A3) is propagated through Tasks 5/6/18 — every call site and
test snippet passes the session's cwd, no 2-arg form remains; the Task 16
cascade resolves provider/sessionId through the registry-lookup seam (the
already-injected `freshell_terminal::TerminalRegistry` accessor,
validator-A10); `TabsStoreCaps`/`CompactState`/`ObjectRef`
(Task 8) in Tasks 9–11; `LayoutStore`/`PaneNode`/`RenameOutcome`/`PaneRow`
(Task 12) in Tasks 13–16; `RenamePersistence` defined and consumed in Task 16;
`TerminalMetaRegistry`/`enrich_from_cwd` (Task 18) consume Task 17's helpers;
`updatePaneTitleBySessionRef`/`applySessionRenameCascade` (Task 19) match
their test imports. `query()`'s signature change (Task 11) is propagated to
both WS handler call sites and the tests in the same task.

**4. Load-bearing validation pass:** this plan was revised against the
load-bearing-assumption validation ledger at
`.worktrees/.the-usual-logs/naming-persistence-sweep/load-bearing-ledger.md`:
A2/A3/A5/A6/A7/A10 were FALSIFIED and are planned around above (Scope
Decision 5 + Task 8 fixtures; Task 3/5/18 cwd scoping; Task 19/21 extra
convergence paths; Task 11 lock discipline; Task 17/18 git trigger redesign;
Task 16 registry-first resolution); A2-R1 and A5-R1 are the accepted,
ledgered residuals.
