# Session Directory Page-Bounded Preparation Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Preserve the current Rust `GET /api/session-directory` contract while limiting full `DirItem` construction, output decoration, and serialization to rows actually returned by the page.

**Architecture:** Capture one `Arc<Vec<IndexedSession>>`, borrow its rows, combine them with request-local overrides and terminal identities into one compact effective-candidate corpus, and use that single corpus for every query tier's visibility, order, cursor, search, and page selection. Sort and inspect lightweight candidates across the full effective corpus, retain at most `limit + 1` descriptors, and materialize only the first `limit`; metadata and other output-only decorations remain selected-row work while deep search continues to call the existing bounded `search_session_file` implementation. Delete the old owned full-corpus policy rather than preserving it behind a strategy switch.

**Tech Stack:** Rust 1.96, Axum, Tokio, `freshell-sessions`, `freshell-ws`, Serde JSON, Cargo, Vitest/npm test coordinator.

## Global Constraints

- The only execution worktree is `/home/dan/code/freshell/.worktrees/session-directory-page-prep` on branch `the-usual/session-directory-page-prep`.
- The branch began at the exact reviewed `origin/main` commit `225a91db3e4d48d4b6a7e8bc0987afad8ff31917`. Preserve that SHA as `BASE_SHA` in every scope and unrelated-failure comparison.
- The execute stage begins after this plan has been committed. Gate 0 therefore requires a clean worktree, `BASE_SHA` as an ancestor of `HEAD`, application source identical to `BASE_SHA`, and exactly this committed plan as the sole `BASE_SHA..HEAD` path.
- `/home/dan/code/freshell/.worktrees/session-directory-page-bound` is reference-only. Never edit, format, build through, commit in, or generate evidence inside it.
- The only implementation file an implementation task may stage or commit is `crates/freshell-server/src/session_directory.rs`.
- Final `BASE_SHA..HEAD` scope must contain exactly two paths: this committed plan and `crates/freshell-server/src/session_directory.rs`.
- Do not modify any `Cargo.toml`, crate manifest, `.kata.toml`, dependency, feature, project setting, environment file, `crates/freshell-sessions/**`, `crates/freshell-ws/**`, `crates/freshell-server/src/main.rs`, Node/TypeScript/client/browser file, shared schema, fixture, index refresh/sweep path, session index/search implementation, or WebSocket behavior.
- Do not add a `SessionIndex` paging API. Call `snapshot().await` at most once per indexed request, retain its `Arc`, and borrow the resulting slice for the complete synchronous derivation.
- One production candidate pipeline owns override survival and effective fields, exact-pair live matching, full-key synth dedupe, live synthesis, visibility, stable HTTP ordering, strict cursor relation, title-match precedence, deep-search traversal, and page selection for every tier. Do not add `Fast`, `Materialized`, old/new, feature-flag, or rollback strategy selection.
- Preserve current Rust ordering exactly: `lastActivityAt` descending, then the complete formatted UTF-8 `provider:sessionId` key descending. `archived` stays output-only; unrelated Node archived-last behavior is outside this change.
- Preserve stable ordering for exact duplicate `(lastActivityAt, key)` tuples and the current strict-cursor gap for such duplicates.
- Preserve all current query validation, auth, accessor order, visibility flags, override/live interactions, response fields and omissions, whole-map project colors, strict cursor bytes, search budgets, I/O partial semantics, and revision max semantics.
- Preserve the exact current `DirItem::to_value` insertion order because workspace `serde_json` uses `preserve_order`; field cleanup and Task-7 ledger instrumentation must not reorder raw JSON object bytes.
- Preserve rejection of a syntactically valid cursor whose JSON `key` is empty.
- Preserve deep-search loop order after shared visibility and cursor handling: `rows.len() > limit`, then `scanned_files >= max_scan` with `budget`, then source-file presence, supported provider, increment, and I/O.
- Do not add `total`, `totalCount`, `totalSessions`, `checkoutPath`, or any response field. Exact corpus preservation is proved by all-page union tests.
- Missing, empty, and whitespace-only queries remain no-search requests for every tier. Nonblank title search remains title, summary, then first-user-message precedence with a 140-Unicode-scalar whole-field prefix. Nonblank `userMessages` and `fullText` keep `search_session_file`, `limit * 10`, provider/source eligibility, match roles, I/O handling, and `limit + 1` behavior.
- Full `DirItem` construction, override output decoration, metadata output decoration, running output decoration, and `DirItem::to_value` occur only for returned rows. The lookahead descriptor is never materialized.
- The deterministic work proof uses a request-scoped `#[cfg(test)]` thread-local `PreparationCounts` guard. Do not use timing, sleeps, an allocator, a process-global counter, source parse counts, or a release A/B benchmark.
- All new page-bound tests are colocated in `#[cfg(test)] mod page_bound_tests` in `session_directory.rs`. Use the real Axum route wherever policy composition is under test.
- All command logs and exit-code files go under `/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-page-prep/implementation`; no evidence file is written into the worktree.
- Relevant focused failures block implementation. An apparently unrelated broad-suite failure permits progress only after the identical command fails with the same signature on an unchanged detached `BASE_SHA` worktree under the same environment; never edit unrelated code.
- Final broad acceptance is either GREEN or exact recorded matching unchanged-`BASE_SHA` evidence for a genuinely unrelated failure. Focused session-directory failures never qualify for this exception.
- `README.md` is the only end-user Markdown documentation file. This optimization is behavior-neutral, so do not edit it or any other documentation file during implementation.
- Do not create a PR until the user explicitly approves PR creation. Local atomic task commits are required; stop after final local verification.

---

## File Structure Map

### Implementation target

- `crates/freshell-server/src/session_directory.rs:1-38` — module rustdoc; update stale provider/pipeline descriptions during atomic cutover.
- `crates/freshell-server/src/session_directory.rs:70-94` — `SessionDirectoryState` rustdoc and request inputs.
- `crates/freshell-server/src/session_directory.rs:96-207` — full selected-row `DirItem`, obsolete internal fields, obsolete `DirItem::key`, and sole wire serializer.
- `crates/freshell-server/src/session_directory.rs:210-371` — `Tier`, `DirQuery`, query validation, and limit coercion; behavior is frozen, rustdoc is updated.
- `crates/freshell-server/src/session_directory.rs:374-455` — authenticated route and eager capture/decorate/derive sequence; replace through the complete `match result` response handling.
- `crates/freshell-server/src/session_directory.rs:555-583` — eager indexed-row full constructor; remove after selected-only materialization exists.
- `crates/freshell-server/src/session_directory.rs:736-938` — full-item override, metadata, display, running, and live synthesis chain; replace with borrowed candidate normalization. Change the existing `provider_display_name` in place rather than adding a second helper.
- `crates/freshell-server/src/session_directory.rs:940-1147` — display/join tests and their `DirItem` fixture; migrate to `IndexedSession` and candidates.
- `crates/freshell-server/src/session_directory.rs:1149-1391` — cursor codec, revision/order/visibility/search/page policy, `FileSearchOutcome` struct, deep search, and title search; consolidate into the shared candidate pipeline.
- `crates/freshell-server/src/session_directory.rs:1392-3353` — existing fixtures and tests. Migrate every named direct-helper test, retain the parser/index oracle, and leave the nine named route tests unchanged.
- New colocated section in the same file: `#[cfg(test)] mod page_bound_tests`, containing the route harness and exactly 25 tests by Task 7.

### Read-only contracts

- `crates/freshell-server/Cargo.toml` — proves existing `tower` util and `tempfile` support; never edit.
- `crates/freshell-sessions/src/directory_index.rs` — `IndexedSession`, `SessionSource`, and `SessionIndex::snapshot() -> Arc<Vec<IndexedSession>>`; never edit.
- `crates/freshell-sessions/src/search.rs` — `search_session_file`, `FileSearchTier`, and `FileSearchMatch { matched_in: &'static str, snippet: String }`; never edit.
- `crates/freshell-ws/src/identity.rs` — `TerminalIdentity` and unordered `TerminalIdentityRegistry::list()`; never edit.
- `crates/freshell-server/src/settings_store.rs` — overrides and project colors; never edit.
- `crates/freshell-server/src/session_metadata.rs` — captured metadata map; never edit.
- `shared/read-models.ts` — wire contract confirming there is no total field; never edit.
- `server/session-directory/service.ts` — read-only reference for existing deep-search check order; never edit.

### Final internal flow

```text
validate request
-> capture one optional Arc<Vec<IndexedSession>>
-> capture overrides
-> capture metadata
-> capture identities
-> decode a nonempty-key cursor
-> build all shallow effective candidates
-> compute corpus revision
-> stable-sort shallow candidates by current Rust order
-> shared visibility
-> shared strict cursor relation
-> shared title or existing deep-search decision
-> retain at most limit + 1 descriptors
-> materialize and serialize only first limit descriptors
-> append project colors after successful derivation
```

## Command and Evidence Harness

Run this once in the implementation shell before Gate 0. It creates only external evidence directories and a shell function.

```bash
set -euo pipefail
WT=/home/dan/code/freshell/.worktrees/session-directory-page-prep
REFERENCE_ONLY=/home/dan/code/freshell/.worktrees/session-directory-page-bound
BASE_SHA=225a91db3e4d48d4b6a7e8bc0987afad8ff31917
MANIFEST="$WT/Cargo.toml"
STAGE_LOG_ROOT=/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-page-prep
LOG_ROOT="$STAGE_LOG_ROOT/implementation"
PLAN_REL=docs/plans/2026-08-13-session-directory-page-prep.md
SOURCE_REL=crates/freshell-server/src/session_directory.rs
mkdir -p "$LOG_ROOT"

run_logged() {
  local name=$1
  shift
  {
    printf 'cwd=%s\n' "$PWD"
    printf 'command='
    printf '%q ' "$@"
    printf '\n'
  } >"$LOG_ROOT/$name.command"

  set +e
  "$@" 2>&1 | tee "$LOG_ROOT/$name.log"
  local status=${PIPESTATUS[0]}
  set -e
  printf 'exit_code=%s\n' "$status" | tee "$LOG_ROOT/$name.exit"
  return "$status"
}
```

Every expected-GREEN command must return 0. Every intentional RED command must return nonzero and contain the stated failure marker. An exit-zero filtered run with zero executed tests is a failure.

### Gate 0: Prove Committed-Plan Identity and the Unchanged Application Baseline

**Files:**
- Modify: none
- Read only: repository metadata and test outputs
- Generated evidence: `$LOG_ROOT/**`

**Interfaces:**

```text
Worktree identity = canonical prep path + expected branch
Planning state = clean worktree with the plan already committed
Base relation = BASE_SHA is an ancestor of HEAD
Initial BASE_SHA..HEAD path set = committed plan only
Application baseline = session_directory.rs and all non-plan paths identical to BASE_SHA
```

- [ ] **Step 1: Prove the target and reference worktrees are distinct.**

Run:

```bash
test "$(realpath "$WT")" = /home/dan/code/freshell/.worktrees/session-directory-page-prep
test "$(realpath "$WT")" != "$(realpath "$REFERENCE_ONLY")"
test "$(git -C "$WT" rev-parse --show-toplevel)" = "$WT"
test "$(git -C "$WT" branch --show-current)" = the-usual/session-directory-page-prep
```

Expected: no output and exit 0.

- [ ] **Step 2: Prove the execute stage starts clean with the committed plan only.**

Run:

```bash
test -z "$(git -C "$WT" status --porcelain=v1 --untracked-files=all)"
git -C "$WT" merge-base --is-ancestor "$BASE_SHA" HEAD
printf '%s\n' "$PLAN_REL" >"$LOG_ROOT/expected-initial-paths.txt"
git -C "$WT" diff --name-only "$BASE_SHA" HEAD | sort \
  >"$LOG_ROOT/actual-initial-paths.txt"
diff -u "$LOG_ROOT/expected-initial-paths.txt" \
  "$LOG_ROOT/actual-initial-paths.txt"
git -C "$WT" diff --exit-code "$BASE_SHA" HEAD -- "$SOURCE_REL"
```

Expected: clean worktree, ancestor check exit 0, only the committed plan in `BASE_SHA..HEAD`, and no application-source diff.

- [ ] **Step 3: Record immutable baseline identity.**

Run:

```bash
{
  git -C "$WT" show -s --format='base_commit=%H%nbase_subject=%s%nbase_tree=%T' "$BASE_SHA"
  printf 'plan_head=%s\n' "$(git -C "$WT" rev-parse HEAD)"
  printf 'branch=%s\n' "$(git -C "$WT" branch --show-current)"
  printf 'worktree=%s\n' "$(realpath "$WT")"
} | tee "$LOG_ROOT/origin-main-identity.txt"
```

Expected: `base_commit=225a91db3e4d48d4b6a7e8bc0987afad8ff31917` and exit 0.

- [ ] **Step 4: Resolve Vitest backend policy before coordinated testing.**

Run:

```bash
if [[ -z "${FRESHELL_VITEST_BACKEND:-}" ]]; then
  printf '%s\n' 'STOP: ask the user to choose local/free or cloud/paid for FRESHELL_VITEST_BACKEND and persist the choice before continuing.'
  exit 1
fi
printf 'FRESHELL_VITEST_BACKEND=%s\n' "$FRESHELL_VITEST_BACKEND" \
  | tee "$LOG_ROOT/vitest-backend.txt"
```

Expected: a recorded nonempty backend. Do not silently select paid cloud execution.

- [ ] **Step 5: Inspect the coordinator and wait for any foreign holder.**

Run:

```bash
run_logged baseline-test-status npm --prefix "$WT" run test:status
```

Expected: exit 0. Wait rather than killing or bypassing another holder.

- [ ] **Step 6: Run the relevant focused Rust baseline.**

Run:

```bash
run_logged baseline-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Expected GREEN: exit 0; at least one test executes; every summary reports zero failures. Any failure here blocks implementation and cannot be waived as unrelated.

- [ ] **Step 7: Run the canonical broad baseline through the coordinator.**

Run:

```bash
set +e
FRESHELL_TEST_SUMMARY='session-directory page-bound committed-plan baseline' \
  npm --prefix "$WT" test 2>&1 | tee "$LOG_ROOT/baseline-npm-test.log"
BASELINE_NPM_STATUS=${PIPESTATUS[0]}
printf 'exit_code=%s\n' "$BASELINE_NPM_STATUS" \
  | tee "$LOG_ROOT/baseline-npm-test.exit"
set -e
run_logged baseline-test-status-after npm --prefix "$WT" run test:status
```

Expected normal result: client, server, and Electron exits are `code: 0`, positive test counts are printed, and status records success.

- [ ] **Step 8: Classify any broad-baseline failure before proceeding.**

If `BASELINE_NPM_STATUS` is nonzero, run the exact unchanged-base comparison in Gate 8's unrelated-failure protocol immediately. Proceed only if the identical command under the same backend/environment fails at detached `BASE_SHA` with the same test names and stable signature. Record `baseline_broad_disposition=matching_unrelated_BASE_SHA_failure` in `$LOG_ROOT/baseline-broad-disposition.txt`. Otherwise stop before Task 1. Never edit unrelated files to repair the baseline.

---

### Task 1: Add the Complete Route Harness and Five Boundary Characterizations

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
StaticSessionSource::new(rows) -> deterministic in-memory SessionSource
DirectoryRouteHarness = real Router + SettingsStore + TerminalIdentityRegistry + TempDir
indexed_row/provider_row = complete IndexedSession fixtures
get_page = authenticated real-route JSON helper
item_ids/page_cursor = response inspectors
```

- [ ] **Step 1: Add the complete route harness before any test that uses it.**

Append this module to `crates/freshell-server/src/session_directory.rs`:

```rust
#[cfg(test)]
mod page_bound_tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        Router,
    };
    use freshell_sessions::directory_index::{
        FileStat, IndexedSession, SessionIndex, SessionSource,
    };
    use serde_json::{json, Value};
    use std::{
        collections::HashSet,
        path::{Path, PathBuf},
        sync::Arc,
        time::Duration,
    };
    use tower::ServiceExt;

    struct StaticSessionSource {
        entries: Vec<(PathBuf, IndexedSession)>,
    }

    impl StaticSessionSource {
        fn new(rows: Vec<IndexedSession>) -> Self {
            Self {
                entries: rows
                    .into_iter()
                    .enumerate()
                    .map(|(index, row)| {
                        (PathBuf::from(format!("/synthetic/{index}.jsonl")), row)
                    })
                    .collect(),
            }
        }
    }

    impl SessionSource for StaticSessionSource {
        fn discover(&self) -> Vec<FileStat> {
            self.entries
                .iter()
                .map(|(path, _)| FileStat {
                    path: path.clone(),
                    mtime_ms: 1,
                    size: 1,
                })
                .collect()
        }

        fn parse(&self, path: &Path) -> Option<IndexedSession> {
            self.entries
                .iter()
                .find(|(candidate, _)| candidate == path)
                .map(|(_, row)| row.clone())
        }
    }

    struct DirectoryRouteHarness {
        app: Router,
        settings: crate::settings_store::SettingsStore,
        identity: freshell_ws::identity::TerminalIdentityRegistry,
        _home: tempfile::TempDir,
    }

    fn indexed_row(session_id: &str, at: i64, title: Option<&str>) -> IndexedSession {
        IndexedSession {
            session_id: session_id.to_string(),
            provider: "claude".to_string(),
            project_path: "/repo".to_string(),
            title: title.map(str::to_string),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            title_source: None,
            last_activity_at: at,
            created_at: Some(at),
            cwd: Some("/repo".to_string()),
            git_branch: None,
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    fn provider_row(
        provider: &str,
        session_id: &str,
        at: i64,
        title: Option<&str>,
    ) -> IndexedSession {
        let mut row = indexed_row(session_id, at, title);
        row.provider = provider.to_string();
        row
    }

    fn directory_route_harness(rows: Vec<IndexedSession>) -> DirectoryRouteHarness {
        let home = tempfile::tempdir().expect("temporary home");
        let settings = crate::settings_store::SettingsStore::load(
            Some(home.path()),
            vec!["claude".into(), "codex".into(), "opencode".into()],
        );
        let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(StaticSessionSource::new(rows)) as Arc<dyn SessionSource>],
            Duration::from_secs(60),
            None,
        ));
        let app = router(SessionDirectoryState {
            auth_token: Arc::new("tok".into()),
            settings: settings.clone(),
            session_index: Some(index),
            identity: identity.clone(),
            metadata: crate::session_metadata::SessionMetadataStore::new(
                home.path().join(".freshell"),
            ),
        });
        DirectoryRouteHarness {
            app,
            settings,
            identity,
            _home: home,
        }
    }

    async fn get_page(app: Router, suffix: &str) -> Value {
        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!(
                        "/api/session-directory?priority=visible{suffix}"
                    ))
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .expect("request"),
            )
            .await
            .expect("route response");
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("response body");
        serde_json::from_slice(&bytes).expect("JSON response")
    }

    fn item_ids(page: &Value) -> Vec<String> {
        page["items"]
            .as_array()
            .expect("items array")
            .iter()
            .map(|item| {
                item["sessionId"]
                    .as_str()
                    .expect("sessionId")
                    .to_string()
            })
            .collect()
    }

    fn page_cursor(page: &Value) -> Option<String> {
        page["nextCursor"].as_str().map(str::to_string)
    }
```

- [ ] **Step 2: Add five current-route boundary tests in the same module.**

```rust
    #[tokio::test]
    async fn no_search_deleted_head_backfills_page_before_cut() {
        let harness = directory_route_harness(vec![
            indexed_row("raw-head", 300, Some("head")),
            indexed_row("backfill", 200, Some("backfill")),
            indexed_row("tail", 100, Some("tail")),
        ]);
        harness
            .settings
            .patch_session_override(
                "claude:raw-head",
                &[("deleted", Some(json!(true)))],
            )
            .await;
        let page = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&page), vec!["backfill"]);
        assert!(page_cursor(&page).is_some());
        assert_eq!(page["revision"], json!(200));
    }

    #[tokio::test]
    async fn no_search_title_override_promotes_row_outside_raw_page() {
        let harness = directory_route_harness(vec![
            indexed_row("raw-head", 300, Some("head")),
            indexed_row("promoted", 200, None),
            indexed_row("tail", 100, Some("tail")),
        ]);
        harness
            .settings
            .patch_session_override(
                "claude:raw-head",
                &[("deleted", Some(json!(true)))],
            )
            .await;
        harness
            .settings
            .patch_session_override(
                "claude:promoted",
                &[
                    ("titleOverride", Some(json!("override title"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;
        let page = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&page), vec!["promoted"]);
        assert_eq!(page["items"][0]["title"], json!("override title"));
        assert!(page_cursor(&page).is_some());
    }

    #[tokio::test]
    async fn no_search_running_join_promotes_row_outside_raw_page() {
        let harness = directory_route_harness(vec![
            indexed_row("raw-head", 300, Some("head")),
            indexed_row("running", 200, None),
            indexed_row("tail", 100, Some("tail")),
        ]);
        harness
            .settings
            .patch_session_override(
                "claude:raw-head",
                &[("deleted", Some(json!(true)))],
            )
            .await;
        harness.identity.upsert(
            "terminal-running",
            Some("claude"),
            Some("running"),
            Some("/repo"),
            900,
        );
        let page = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&page), vec!["running"]);
        assert_eq!(page["items"][0]["lastActivityAt"], json!(200));
        assert_eq!(page["items"][0]["isRunning"], json!(true));
        assert_eq!(
            page["items"][0]["runningTerminalId"],
            json!("terminal-running")
        );
        assert_eq!(page["revision"], json!(900));
    }

    #[tokio::test]
    async fn no_search_newer_live_only_row_interleaves_and_drives_cursor() {
        let harness = directory_route_harness(vec![indexed_row(
            "indexed",
            200,
            Some("indexed"),
        )]);
        harness.identity.upsert(
            "terminal-live",
            Some("claude"),
            Some("live"),
            Some("/live"),
            300,
        );
        let first = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&first), vec!["live"]);
        assert_eq!(first["items"][0]["lastActivityAt"], json!(300));
        assert_eq!(first["items"][0]["title"], json!("Claude CLI"));
        let cursor = page_cursor(&first).expect("first-page cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=1&cursor={cursor}"),
        )
        .await;
        assert_eq!(item_ids(&second), vec!["indexed"]);
        assert!(page_cursor(&second).is_none());
    }

    #[tokio::test]
    async fn no_search_deleted_indexed_live_row_reappears_as_synthesized() {
        let harness = directory_route_harness(vec![indexed_row(
            "deleted-live",
            200,
            Some("indexed title"),
        )]);
        harness
            .settings
            .patch_session_override(
                "claude:deleted-live",
                &[
                    ("deleted", Some(json!(true))),
                    ("archived", Some(json!(true))),
                    ("titleOverride", Some(json!("must not survive"))),
                    ("summaryOverride", Some(json!("must not survive"))),
                ],
            )
            .await;
        harness.identity.upsert(
            "terminal-deleted-live",
            Some("claude"),
            Some("deleted-live"),
            Some("/live"),
            300,
        );
        let page = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&page), vec!["deleted-live"]);
        let item = &page["items"][0];
        assert_eq!(item["title"], json!("Claude CLI"));
        assert_eq!(item["archived"], json!(false));
        assert_eq!(item["sessionType"], json!("claude"));
        assert_eq!(item["isRunning"], json!(true));
        assert!(item.get("summary").is_none());
        assert!(item.get("liveTerminalOnly").is_none());
    }
}
```

- [ ] **Step 3: Run five current-GREEN tests and the complete focused family.**

```bash
run_logged task1-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
run_logged task1-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Expected GREEN: page-bound module reports `5 passed; 0 failed; 0 ignored; 0 measured`; the focused family has a positive count and zero failures.

- [ ] **Step 4: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "test(session-directory): characterize effective page boundaries" \
  -m "Add the real-route synthetic index harness and pin deletion, override, running, live synthesis, and deleted-live page interactions before restructuring production policy." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: Characterize Visibility, Cursor Union, Limits, Ordering, and Revision

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
Input = Task-1 real-route harness
Visibility matrix = all eight include-flag combinations
Pagination authority = opaque nextCursor chain and exact item union
Order authority = activity descending, complete formatted key descending
Revision authority = effective corpus and every identity, before filters/search
```

- [ ] **Step 1: Add six route tests inside `page_bound_tests`.**

Insert before the module's closing brace:

```rust
    #[tokio::test]
    async fn no_search_visibility_flags_restore_only_their_exclusion_class() {
        let mut subagent = indexed_row("subagent", 700, Some("subagent"));
        subagent.is_subagent = true;
        let mut noninteractive = indexed_row("noninteractive", 600, Some("noninteractive"));
        noninteractive.is_non_interactive = true;
        let harness = directory_route_harness(vec![
            indexed_row("visible", 800, Some("visible")),
            subagent,
            noninteractive,
            indexed_row("idle-empty", 500, None),
            indexed_row("whitespace", 400, Some("   ")),
            indexed_row("running-empty", 300, None),
        ]);
        harness.identity.upsert(
            "terminal-running-empty",
            Some("claude"),
            Some("running-empty"),
            Some("/repo"),
            350,
        );

        for include_subagents in [false, true] {
            for include_noninteractive in [false, true] {
                for include_empty in [false, true] {
                    let mut suffix = String::new();
                    if include_subagents {
                        suffix.push_str("&includeSubagents=1");
                    }
                    if include_noninteractive {
                        suffix.push_str("&includeNonInteractive=1");
                    }
                    if include_empty {
                        suffix.push_str("&includeEmpty=1");
                    }
                    let page = get_page(harness.app.clone(), &suffix).await;
                    let mut expected = vec!["visible"];
                    if include_subagents {
                        expected.push("subagent");
                    }
                    if include_noninteractive {
                        expected.push("noninteractive");
                    }
                    if include_empty {
                        expected.extend(["idle-empty", "whitespace"]);
                    }
                    expected.push("running-empty");
                    assert_eq!(item_ids(&page), expected, "suffix={suffix}");
                }
            }
        }
    }

    #[tokio::test]
    async fn no_search_cursor_chain_covers_effective_rows_exactly_once() {
        let mut hidden = indexed_row("hidden-newest", 900, Some("hidden"));
        hidden.is_subagent = true;
        let harness = directory_route_harness(vec![
            hidden,
            indexed_row("s5", 500, Some("five")),
            indexed_row("s4", 400, Some("four")),
            indexed_row("s3", 300, Some("three")),
            indexed_row("s2", 200, Some("two")),
            indexed_row("s1", 100, Some("one")),
        ]);
        let mut cursor = None;
        let mut seen = Vec::new();
        let mut page_count = 0usize;
        loop {
            page_count += 1;
            assert!(page_count <= 3);
            let suffix = match &cursor {
                Some(cursor) => format!("&limit=2&cursor={cursor}"),
                None => "&limit=2".to_string(),
            };
            let page = get_page(harness.app.clone(), &suffix).await;
            assert_eq!(page["revision"], json!(900));
            assert!(page.get("total").is_none());
            assert!(page.get("totalCount").is_none());
            assert!(page.get("totalSessions").is_none());
            seen.extend(item_ids(&page));
            cursor = page_cursor(&page);
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(seen, vec!["s5", "s4", "s3", "s2", "s1"]);
        let unique: HashSet<_> = seen.iter().collect();
        assert_eq!(unique.len(), seen.len());
    }

    #[tokio::test]
    async fn no_search_limit_boundary_emits_cursor_only_for_limit_plus_one() {
        for (count, limit, expected_len, expect_cursor) in [
            (0usize, 1usize, 0usize, false),
            (1, 1, 1, false),
            (2, 1, 1, true),
            (50, 50, 50, false),
            (51, 50, 50, true),
        ] {
            let rows = (0..count)
                .map(|index| {
                    indexed_row(
                        &format!("s-{index:03}"),
                        10_000 - index as i64,
                        Some("visible"),
                    )
                })
                .collect();
            let harness = directory_route_harness(rows);
            let page = get_page(harness.app.clone(), &format!("&limit={limit}")).await;
            assert_eq!(
                page["items"].as_array().expect("items").len(),
                expected_len,
                "count={count} limit={limit}"
            );
            assert_eq!(
                page_cursor(&page).is_some(),
                expect_cursor,
                "count={count} limit={limit}"
            );
        }
    }

    #[tokio::test]
    async fn no_search_equal_activity_uses_descending_full_key_for_order_and_cursor() {
        let harness = directory_route_harness(vec![
            provider_row("claude", "a", 500, Some("claude a")),
            provider_row("codex", "z", 500, Some("codex z")),
            provider_row("claude", "z", 500, Some("claude z")),
        ]);
        let first = get_page(harness.app.clone(), "&limit=2").await;
        let first_keys: Vec<String> = first["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| {
                format!(
                    "{}:{}",
                    item["provider"].as_str().expect("provider"),
                    item["sessionId"].as_str().expect("sessionId")
                )
            })
            .collect();
        assert_eq!(first_keys, vec!["codex:z", "claude:z"]);
        let cursor = page_cursor(&first).expect("cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=2&cursor={cursor}"),
        )
        .await;
        let second_keys: Vec<String> = second["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| {
                format!(
                    "{}:{}",
                    item["provider"].as_str().expect("provider"),
                    item["sessionId"].as_str().expect("sessionId")
                )
            })
            .collect();
        assert_eq!(second_keys, vec!["claude:a"]);
        assert!(page_cursor(&second).is_none());
    }

    #[tokio::test]
    async fn revision_is_equal_across_pages_flags_and_title_search() {
        let harness = directory_route_harness(vec![
            indexed_row("hidden-newest", 900, None),
            indexed_row("match", 800, Some("needle title")),
            indexed_row("other", 700, Some("other")),
        ]);
        let first = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(first["revision"], json!(900));
        let cursor = page_cursor(&first).expect("first cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=1&cursor={cursor}"),
        )
        .await;
        assert_eq!(second["revision"], json!(900));
        let including_empty =
            get_page(harness.app.clone(), "&limit=1&includeEmpty=1").await;
        assert_eq!(including_empty["revision"], json!(900));
        let title_search = get_page(
            harness.app.clone(),
            "&query=needle&tier=title&limit=1",
        )
        .await;
        assert_eq!(title_search["revision"], json!(900));
        assert_eq!(item_ids(&title_search), vec!["match"]);
    }

    #[tokio::test]
    async fn providerless_live_identity_changes_revision_without_creating_item() {
        let harness = directory_route_harness(Vec::new());
        harness.identity.upsert(
            "providerless",
            None,
            None,
            Some("/repo"),
            900,
        );
        let page = get_page(harness.app.clone(), "").await;
        assert!(item_ids(&page).is_empty());
        assert!(page_cursor(&page).is_none());
        assert_eq!(page["revision"], json!(900));
    }
```

- [ ] **Step 2: Run eleven current-GREEN tests and the focused family.**

```bash
run_logged task2-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
run_logged task2-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Expected GREEN: `11 passed; 0 failed; 0 ignored; 0 measured`; complete focused family positive and zero failures.

- [ ] **Step 3: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "test(session-directory): pin paging totals and revisions" \
  -m "Characterize every visibility flag combination, exact cursor-chain union, page limits, full-key ties, corpus-wide revision stability, and providerless identity revision behavior." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: Pin Empty Cursor Keys, Deep-Search Partials, and Deterministic Duplicate Semantics

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
Pre-refactor cursor authority = apply_query rejects invalid base64 and valid JSON with empty key
Pre-refactor deep authority = apply_query over ordered DirItem values with real transcript paths
Pre-refactor duplicate authority = apply_query over a caller-owned ordered Vec<DirItem>
Post-refactor migration target = derive_directory_page over ordered Vec<IndexedSession>
```

- [ ] **Step 1: Add complete pre-refactor test helpers before their tests.**

Inside `page_bound_tests`, add:

```rust
    fn test_query(
        query: Option<&str>,
        tier: Tier,
        cursor: Option<String>,
        limit: usize,
    ) -> DirQuery {
        DirQuery {
            query: query.map(str::to_string),
            tier,
            cursor,
            limit: Some(limit),
            include_subagents: false,
            include_non_interactive: false,
            include_empty: false,
        }
    }

    fn legacy_duplicate_items() -> Vec<DirItem> {
        [
            ("first", "/first"),
            ("second", "/second"),
        ]
        .into_iter()
        .map(|(title, project_path)| DirItem {
            session_id: "duplicate".to_string(),
            provider: "claude".to_string(),
            project_path: project_path.to_string(),
            title: Some(title.to_string()),
            summary: None,
            first_user_message: None,
            last_activity_at: 500,
            created_at: Some(500),
            cwd: Some(project_path.to_string()),
            is_subagent: false,
            is_non_interactive: false,
            is_running: false,
            archived: false,
            matched_in: None,
            snippet: None,
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file: None,
        })
        .collect()
    }
```

Inside the existing main `tests` module, before the deep-search tests, add:

```rust
    fn deep_search_dir_item(
        session_id: &str,
        at: i64,
        source_file: Option<PathBuf>,
    ) -> DirItem {
        DirItem {
            session_id: session_id.to_string(),
            provider: "claude".to_string(),
            project_path: "/repo".to_string(),
            title: Some("visible".to_string()),
            summary: None,
            first_user_message: None,
            last_activity_at: at,
            created_at: Some(at),
            cwd: Some("/repo".to_string()),
            is_subagent: false,
            is_non_interactive: false,
            is_running: false,
            archived: false,
            matched_in: None,
            snippet: None,
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file,
        }
    }

    fn write_nonmatching_claude_transcript(path: &Path) {
        std::fs::write(
            path,
            format!(
                "{}\n",
                json!({
                    "type": "user",
                    "message": {"content": "ordinary text"}
                })
            ),
        )
        .expect("write transcript");
    }

    fn deep_search_query() -> DirQuery {
        DirQuery {
            query: Some("needle".to_string()),
            tier: Tier::UserMessages,
            cursor: None,
            limit: Some(1),
            include_subagents: false,
            include_non_interactive: false,
            include_empty: false,
        }
    }
```

- [ ] **Step 2: Replace the nondeterministic route duplicate test with direct ordered-vector characterization.**

Add this as test 12 in `page_bound_tests`; do not route it through `SessionIndex`:

```rust
    #[test]
    fn duplicate_equal_order_tuples_preserve_stable_order_and_strict_cursor_gap() {
        let one_page = apply_query(
            legacy_duplicate_items(),
            &test_query(None, Tier::Title, None, 2),
            &[],
        )
        .expect("one page");
        let titles: Vec<&str> = one_page["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| item["title"].as_str().expect("title"))
            .collect();
        assert_eq!(titles, vec!["first", "second"]);
        assert!(one_page["nextCursor"].is_null());

        let first_page = apply_query(
            legacy_duplicate_items(),
            &test_query(None, Tier::Title, None, 1),
            &[],
        )
        .expect("first page");
        assert_eq!(first_page["items"][0]["title"], json!("first"));
        let cursor = first_page["nextCursor"]
            .as_str()
            .expect("duplicate cursor")
            .to_string();
        let second_page = apply_query(
            legacy_duplicate_items(),
            &test_query(None, Tier::Title, Some(cursor), 1),
            &[],
        )
        .expect("second page");
        assert!(second_page["items"].as_array().expect("items").is_empty());
        assert!(second_page["nextCursor"].is_null());
    }
```

This pins both stable sort over an explicitly ordered input vector and the current inability of a strict `{lastActivityAt,key}` cursor to distinguish the second exact duplicate.

- [ ] **Step 3: Extend `invalid_cursor_is_rejected` before changing the decoder.**

Replace its body with:

```rust
    #[test]
    fn invalid_cursor_is_rejected() {
        let empty_key_cursor = encode_cursor(1, "");
        for cursor in ["!!!not-base64!!!".to_string(), empty_key_cursor] {
            let query = DirQuery {
                query: None,
                tier: Tier::Title,
                cursor: Some(cursor),
                limit: Some(1),
                include_subagents: false,
                include_non_interactive: false,
                include_empty: false,
            };
            assert_eq!(
                apply_query(Vec::new(), &query, &[]).expect_err("invalid cursor"),
                "Invalid session-directory cursor"
            );
        }
    }
```

- [ ] **Step 4: Add three pre-refactor deep-search edge tests.**

Inside the existing deep-search test module, add:

```rust
    #[test]
    fn tier_search_reports_io_error_for_missing_source_file() {
        let home = tempfile::tempdir().expect("tempdir");
        let missing = home.path().join("missing.jsonl");
        let page = apply_query(
            vec![deep_search_dir_item("missing", 100, Some(missing))],
            &deep_search_query(),
            &[],
        )
        .expect("page");
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("io_error"));
    }

    #[test]
    fn tier_search_budget_overwrites_prior_io_error() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut items = vec![deep_search_dir_item(
            "missing",
            1_000,
            Some(home.path().join("missing.jsonl")),
        )];
        for index in 0..9 {
            let path = home.path().join(format!("valid-{index}.jsonl"));
            write_nonmatching_claude_transcript(&path);
            items.push(deep_search_dir_item(
                &format!("valid-{index}"),
                999 - index as i64,
                Some(path),
            ));
        }
        let tail = home.path().join("eligible-tail.jsonl");
        write_nonmatching_claude_transcript(&tail);
        items.push(deep_search_dir_item("eligible-tail", 900, Some(tail)));

        let page = apply_query(items, &deep_search_query(), &[]).expect("page");
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("budget"));
    }

    #[test]
    fn tier_search_budget_is_checked_before_no_source_tail() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut items = Vec::new();
        for index in 0..10 {
            let path = home.path().join(format!("valid-{index}.jsonl"));
            write_nonmatching_claude_transcript(&path);
            items.push(deep_search_dir_item(
                &format!("valid-{index}"),
                1_000 - index as i64,
                Some(path),
            ));
        }
        items.push(deep_search_dir_item("no-source-tail", 900, None));

        let page = apply_query(items, &deep_search_query(), &[]).expect("page");
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("budget"));
    }
```

- [ ] **Step 5: Run exact current-GREEN edge evidence.**

```bash
run_logged task3-duplicate \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::duplicate_equal_order_tuples_preserve_stable_order_and_strict_cursor_gap' -- \
    --exact --color=never --test-threads=1
run_logged task3-invalid-cursor \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::tests::invalid_cursor_is_rejected' -- \
    --exact --color=never --test-threads=1
for test_name in \
  tier_user_messages_matches_only_the_user_turn \
  tier_full_text_matches_assistant_turn_too \
  tier_search_is_case_insensitive \
  tier_search_empty_no_match_returns_empty_items_without_partial \
  tier_search_combined_with_cursor_pagination \
  tier_search_reports_partial_budget_when_scan_budget_exceeded \
  title_tier_search_matches_a_renamed_sessions_override_title \
  tier_search_reports_io_error_for_missing_source_file \
  tier_search_budget_overwrites_prior_io_error \
  tier_search_budget_is_checked_before_no_source_tail
do
  run_logged "task3-deep-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
run_logged task3-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
```

Expected GREEN: duplicate and invalid-cursor filters each report `1 passed`; each of the ten named deep/title exact filters reports `1 passed`; page-bound module reports `12 passed; 0 failed; 0 ignored; 0 measured`.

- [ ] **Step 6: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "test(session-directory): pin cursor and deep partial edges" \
  -m "Characterize empty cursor-key rejection, deterministic duplicate stability and cursor gaps, I/O partials, budget precedence, and budget checks before ineligible tails." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: Characterize Search, Wire Shape, and Archived Recency

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
Title route authority = effective title, effective summary, first user message, precedence, 140 scalars
Wire authority = exact item/page fields and omissions, no total, no checkoutPath
Archived authority = current Rust recency/key ordering and strict cursor continuation
```

- [ ] **Step 1: Add three final pre-refactor route tests.**

Insert before the `page_bound_tests` closing brace:

```rust
    #[tokio::test]
    async fn title_search_matches_effective_title_summary_and_first_message_beyond_raw_page() {
        let long_title = format!("needle{}", "λ".repeat(150));
        let mut rows: Vec<IndexedSession> = (0..105)
            .map(|index| {
                indexed_row(
                    &format!("nonmatch-{index:03}"),
                    2_000 - index as i64,
                    Some("visible nonmatch"),
                )
            })
            .collect();
        let mut precedence = indexed_row("precedence", 500, Some(&long_title));
        precedence.summary = Some("needle summary".to_string());
        precedence.first_user_message = Some("needle first".to_string());
        rows.push(precedence);
        let mut summary = indexed_row("summary", 400, Some("visible"));
        summary.summary = Some("needle in summary".to_string());
        rows.push(summary);
        let mut first = indexed_row("first", 300, Some("visible"));
        first.first_user_message = Some("needle in first message".to_string());
        rows.push(first);
        rows.push(indexed_row("override-title", 200, None));
        rows.push(indexed_row("override-summary", 100, Some("visible")));
        let harness = directory_route_harness(rows);
        harness
            .settings
            .patch_session_override(
                "claude:override-title",
                &[
                    ("titleOverride", Some(json!("needle override title"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;
        harness
            .settings
            .patch_session_override(
                "claude:override-summary",
                &[("summaryOverride", Some(json!("needle override summary")))],
            )
            .await;
        let page = get_page(
            harness.app.clone(),
            "&query=needle&tier=title&limit=5",
        )
        .await;
        assert_eq!(
            item_ids(&page),
            vec![
                "precedence",
                "summary",
                "first",
                "override-title",
                "override-summary",
            ]
        );
        assert!(page_cursor(&page).is_none());
        let items = page["items"].as_array().expect("items");
        assert_eq!(items[0]["matchedIn"], json!("title"));
        assert_eq!(
            items[0]["snippet"],
            json!(long_title.chars().take(140).collect::<String>())
        );
        assert_eq!(
            items[0]["snippet"]
                .as_str()
                .expect("snippet")
                .chars()
                .count(),
            140
        );
        assert_eq!(items[1]["matchedIn"], json!("summary"));
        assert_eq!(items[2]["matchedIn"], json!("firstUserMessage"));
        assert_eq!(items[3]["matchedIn"], json!("title"));
        assert_eq!(items[4]["matchedIn"], json!("summary"));
    }

    #[tokio::test]
    async fn no_search_exact_response_shape_preserves_all_fields_and_no_totals() {
        let mut indexed = indexed_row("shape", 200, Some("base title"));
        indexed.project_path = "/project".to_string();
        indexed.summary = Some("base summary".to_string());
        indexed.first_user_message = Some("first user".to_string());
        indexed.created_at = Some(150);
        indexed.cwd = Some("/cwd".to_string());
        indexed.title_source = Some("user".to_string());
        indexed.source_file = Some(PathBuf::from("/internal/source.jsonl"));
        let harness = directory_route_harness(vec![indexed]);
        harness
            .settings
            .patch_session_override(
                "claude:shape",
                &[
                    ("titleOverride", Some(json!("effective title"))),
                    ("summaryOverride", Some(json!("effective summary"))),
                    ("archived", Some(json!(true))),
                ],
            )
            .await;
        harness.identity.upsert(
            "terminal-indexed",
            Some("claude"),
            Some("shape"),
            Some("/cwd"),
            250,
        );
        harness.identity.upsert(
            "terminal-fallback",
            Some("claude"),
            None,
            Some("/live"),
            300,
        );
        let page = get_page(harness.app.clone(), "&limit=2").await;
        assert_eq!(
            page,
            json!({
                "items": [
                    {
                        "sessionId": "terminal:terminal-fallback",
                        "provider": "claude",
                        "projectPath": "/live",
                        "title": "Claude CLI",
                        "lastActivityAt": 300,
                        "createdAt": 300,
                        "cwd": "/live",
                        "isRunning": true,
                        "archived": false,
                        "runningTerminalId": "terminal-fallback",
                        "liveTerminalOnly": true,
                        "sessionType": "claude"
                    },
                    {
                        "sessionId": "shape",
                        "provider": "claude",
                        "projectPath": "/project",
                        "title": "effective title",
                        "summary": "effective summary",
                        "firstUserMessage": "first user",
                        "lastActivityAt": 200,
                        "createdAt": 150,
                        "cwd": "/cwd",
                        "isRunning": true,
                        "archived": true,
                        "runningTerminalId": "terminal-indexed"
                    }
                ],
                "nextCursor": null,
                "revision": 300
            })
        );
        for forbidden in ["total", "totalCount", "totalSessions"] {
            assert!(page.get(forbidden).is_none());
        }
        for item in page["items"].as_array().expect("items") {
            assert!(item.get("checkoutPath").is_none());
            assert!(item.get("titleSource").is_none());
            assert!(item.get("sourceFile").is_none());
        }
    }

    #[tokio::test]
    async fn rust_http_order_remains_recency_first_when_newer_row_is_archived() {
        let harness = directory_route_harness(vec![
            indexed_row("newer-archived", 300, Some("newer")),
            indexed_row("older-active", 200, Some("older")),
        ]);
        harness
            .settings
            .patch_session_override(
                "claude:newer-archived",
                &[("archived", Some(json!(true)))],
            )
            .await;
        let first = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&first), vec!["newer-archived"]);
        assert_eq!(first["items"][0]["archived"], json!(true));
        let cursor = page_cursor(&first).expect("cursor");
        let second = get_page(
            harness.app.clone(),
            &format!("&limit=1&cursor={cursor}"),
        )
        .await;
        assert_eq!(item_ids(&second), vec!["older-active"]);
        assert_eq!(second["items"][0]["archived"], json!(false));
        assert!(page_cursor(&second).is_none());
    }
```

- [ ] **Step 2: Run all 15 pre-refactor page-bound characterizations and the focused family.**

```bash
run_logged task4-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
run_logged task4-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Expected GREEN: `15 passed; 0 failed; 0 ignored; 0 measured`; focused family positive and zero failures. This is the final eager-policy authority.

- [ ] **Step 3: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "test(session-directory): freeze search and response semantics" \
  -m "Pin effective title-tier matching, exact wire fields and omissions, and current Rust archived recency behavior before replacing the eager policy." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: Normalize the Existing Provider Display Helper In Place

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
provider_display_name(provider: &str) -> &str
Existing eager synth caller converts the borrowed display name to String
Final candidate search and materialization reuse the same helper
No provider_display_name_borrowed symbol exists
```

- [ ] **Step 1: Change the existing helper and its current caller atomically.**

Replace the existing helper with:

```rust
fn provider_display_name(provider: &str) -> &str {
    match provider {
        "claude" => "Claude CLI",
        "codex" => "Codex CLI",
        "opencode" => "OpenCode",
        _ => provider,
    }
}
```

In the existing eager `build_live_terminal_session_item`, `provider` is an owned `String`; replace its title expression with:

```rust
        title: Some(provider_display_name(&provider).to_string()),
```

- [ ] **Step 2: Migrate the existing display-helper test to the borrowed return type.**

Replace its body with:

```rust
    #[test]
    fn provider_display_name_matches_known_providers_and_falls_back_to_raw() {
        assert_eq!(provider_display_name("claude"), "Claude CLI");
        assert_eq!(provider_display_name("codex"), "Codex CLI");
        assert_eq!(provider_display_name("opencode"), "OpenCode");
        assert_eq!(provider_display_name("amplifier"), "amplifier");
    }
```

- [ ] **Step 3: Run focused GREEN evidence and reject duplicate display policy.**

```bash
run_logged task5-display \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::join_tests::provider_display_name_matches_known_providers_and_falls_back_to_raw' -- \
    --exact --color=never --test-threads=1
run_logged task5-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
! grep -n 'provider_display_name_borrowed' "$WT/$SOURCE_REL"
test "$(grep -Ec '^fn provider_display_name\(' "$WT/$SOURCE_REL")" -eq 1
```

Expected GREEN: exact display test executes 1 and passes; focused family has zero failures; static checks exit 0.

- [ ] **Step 4: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "refactor(session-directory): borrow provider display names" \
  -m "Change the existing display policy in place so eager and candidate paths share one borrowed helper without a duplicate implementation." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 6: Atomically Replace the Old Policy and Migrate Every Semantic Consumer

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
DirectoryInputs<'a> = indexed + overrides + metadata + identities borrows
DirectoryCandidateSource<'a> = Indexed or Synthesized
DirectoryCandidate<'a> = one compact Arc<str> key plus borrowed source
DirectoryOrderKey<'a> = last_activity_at + full key
DecodedCursor = typed nonempty cursor data
SearchAnnotation = owned matched_in and snippet
CandidatePage<'a> = selected descriptors + partial state
One production entry = derive_directory_page(inputs, query)
One full constructor = materialize_selected_candidate(selected, metadata)
One serializer = DirItem::to_value
```

Do not commit or hand off the temporary midpoint where old and new policy functions coexist. Every non-RED checkpoint below must compile. The only intentional compile failure is the named shared-test RED before the new symbols are added.

- [ ] **Step 1: Add five shared-policy tests and record compile-RED.**

Inside `page_bound_tests`, add:

```rust
    #[test]
    fn shared_order_comparator_and_cursor_relation_are_exact_inverses() {
        let cases = [
            (20, "claude", "new", 10, "claude:old"),
            (10, "claude", "z", 10, "claude:a"),
            (10, "a", "b:c", 10, "a:b:c"),
            (10, "provider", "prefix", 10, "provider:prefix-long"),
            (10, "λ", "会話", 10, "λ:会話a"),
            (i64::MAX, "max", "id", i64::MIN, "min:id"),
            (i64::MIN, "min", "id", i64::MAX, "max:id"),
        ];
        for (left_at, provider, session_id, right_at, right_key) in cases {
            let row = provider_row(provider, session_id, left_at, Some("visible"));
            let overrides = Map::new();
            let identities = Vec::new();
            let mut candidates =
                build_directory_candidates(std::slice::from_ref(&row), &overrides, &identities);
            let candidate = candidates.pop().expect("candidate");
            let cursor = DecodedCursor {
                last_activity_at: right_at,
                key: right_key.to_string(),
            };
            let expected = right_at
                .cmp(&left_at)
                .then_with(|| right_key.cmp(candidate.key.as_ref()));
            assert_eq!(
                compare_directory_order(
                    candidate.order_key(),
                    DirectoryOrderKey {
                        last_activity_at: right_at,
                        key: right_key,
                    },
                ),
                expected
            );
            assert_eq!(
                candidate_is_strictly_after_cursor(&candidate, &cursor),
                expected == Ordering::Greater
            );
        }
    }

    #[test]
    fn shared_visibility_predicate_preserves_running_empty_exception() {
        let whitespace = indexed_row("whitespace", 100, Some("   "));
        let overrides = Map::new();
        let no_identities = Vec::new();
        let mut candidates = build_directory_candidates(
            std::slice::from_ref(&whitespace),
            &overrides,
            &no_identities,
        );
        let candidate = candidates.pop().expect("candidate");
        assert!(!candidate_is_visible(
            &candidate,
            &test_query(None, Tier::Title, None, 50)
        ));
        let mut include_empty = test_query(None, Tier::Title, None, 50);
        include_empty.include_empty = true;
        assert!(candidate_is_visible(&candidate, &include_empty));

        let running = indexed_row("running", 90, None);
        let registry = freshell_ws::identity::TerminalIdentityRegistry::new();
        registry.upsert(
            "terminal-running",
            Some("claude"),
            Some("running"),
            Some("/repo"),
            900,
        );
        let identities = registry.list();
        let mut running_candidates = build_directory_candidates(
            std::slice::from_ref(&running),
            &overrides,
            &identities,
        );
        assert!(candidate_is_visible(
            &running_candidates.pop().expect("running candidate"),
            &test_query(None, Tier::Title, None, 50)
        ));
    }

    #[test]
    fn shared_override_resolver_preserves_provider_generated_title_guard() {
        let mut row = indexed_row("overlay", 100, Some("base title"));
        row.summary = Some("base summary".to_string());
        row.title_source = Some("provider-generated".to_string());
        let accepted = json!({
            "titleOverride": "accepted",
            "titleSource": "user",
            "summaryOverride": "",
            "archived": true
        });
        let overlay =
            resolve_indexed_overlay(&row, Some(&accepted)).expect("accepted overlay");
        assert_eq!(overlay.effective_title, Some("accepted"));
        assert_eq!(overlay.effective_summary, Some(""));
        assert!(overlay.archived);
        for source in ["dir", "first-message"] {
            let suppressed = json!({
                "titleOverride": "suppressed",
                "titleSource": source
            });
            let overlay =
                resolve_indexed_overlay(&row, Some(&suppressed)).expect("overlay");
            assert_eq!(overlay.effective_title, Some("base title"));
            assert_eq!(overlay.effective_summary, Some("base summary"));
            assert!(!overlay.archived);
        }
        assert_eq!(
            resolve_indexed_overlay(&row, Some(&json!({"titleOverride": ""})))
                .expect("overlay")
                .effective_title,
            Some("base title")
        );
        assert!(resolve_indexed_overlay(&row, Some(&json!({"deleted": true}))).is_none());
    }

    #[test]
    fn candidate_normalization_preserves_exact_pair_and_full_key_first_winners() {
        let indexed = provider_row("claude", "same", 100, None);
        let registry = freshell_ws::identity::TerminalIdentityRegistry::new();
        registry.upsert(
            "01-running-first",
            Some("claude"),
            Some("same"),
            Some("/first"),
            401,
        );
        registry.upsert(
            "02-running-second",
            Some("claude"),
            Some("same"),
            Some("/second"),
            402,
        );
        registry.upsert(
            "03-collision-first",
            Some("a"),
            Some("b:c"),
            Some("/collision-first"),
            403,
        );
        registry.upsert(
            "04-collision-second",
            Some("a:b"),
            Some("c"),
            Some("/collision-second"),
            404,
        );
        let mut identities = registry.list();
        identities.sort_by(|left, right| left.terminal_id.cmp(&right.terminal_id));
        let overrides = Map::new();
        let candidates = build_directory_candidates(
            std::slice::from_ref(&indexed),
            &overrides,
            &identities,
        );
        assert_eq!(candidates.len(), 2);

        let indexed_candidate = candidates
            .iter()
            .position(|candidate| {
                matches!(&candidate.source, DirectoryCandidateSource::Indexed { .. })
            })
            .expect("indexed candidate");
        let synth_candidate = candidates
            .iter()
            .position(|candidate| {
                matches!(&candidate.source, DirectoryCandidateSource::Synthesized { .. })
            })
            .expect("synth candidate");
        assert!(candidates[indexed_candidate].is_running());
        assert_eq!(candidates[synth_candidate].key.as_ref(), "a:b:c");

        let mut candidates = candidates;
        let synth = candidates.swap_remove(synth_candidate);
        let indexed = candidates
            .into_iter()
            .find(|candidate| {
                matches!(&candidate.source, DirectoryCandidateSource::Indexed { .. })
            })
            .expect("indexed candidate");
        let indexed_item = materialize_selected_candidate(
            &SelectedCandidate {
                candidate: indexed,
                annotation: None,
            },
            &HashMap::new(),
        );
        let synth_item = materialize_selected_candidate(
            &SelectedCandidate {
                candidate: synth,
                annotation: None,
            },
            &HashMap::new(),
        );
        assert_eq!(
            indexed_item.running_terminal_id.as_deref(),
            Some("01-running-first")
        );
        assert_eq!(
            synth_item.running_terminal_id.as_deref(),
            Some("03-collision-first")
        );
        assert_eq!(synth_item.provider, "a");
        assert_eq!(synth_item.session_id, "b:c");
    }

    #[test]
    fn shared_title_match_preserves_field_precedence_and_140_scalar_snippet() {
        let mut row = indexed_row("precedence", 100, Some("needle title"));
        row.summary = Some("needle summary".to_string());
        row.first_user_message = Some("needle first".to_string());
        let overrides = Map::new();
        let identities = Vec::new();
        let mut candidates = build_directory_candidates(
            std::slice::from_ref(&row),
            &overrides,
            &identities,
        );
        let annotation = title_search_annotation(
            &candidates.pop().expect("candidate"),
            "needle",
        )
        .expect("title match");
        assert_eq!(annotation.matched_in, "title");
        assert_eq!(annotation.snippet, "needle title");
        for scalar_count in [139usize, 140, 141] {
            let field = format!("needle{}", "界".repeat(scalar_count - 6));
            let row = indexed_row("scalar", 90, Some(&field));
            let mut candidates = build_directory_candidates(
                std::slice::from_ref(&row),
                &overrides,
                &identities,
            );
            let annotation = title_search_annotation(
                &candidates.pop().expect("candidate"),
                "needle",
            )
            .expect("match");
            assert_eq!(annotation.snippet.chars().count(), scalar_count.min(140));
            assert_eq!(annotation.snippet, field.chars().take(140).collect::<String>());
        }

        let mut summary_row = indexed_row("summary", 80, Some("visible"));
        summary_row.summary = Some("needle summary".to_string());
        let mut summary_candidates = build_directory_candidates(
            std::slice::from_ref(&summary_row),
            &overrides,
            &identities,
        );
        assert_eq!(
            title_search_annotation(
                &summary_candidates.pop().expect("summary candidate"),
                "needle",
            )
            .expect("summary match")
            .matched_in,
            "summary"
        );

        let mut first_row = indexed_row("first", 70, Some("visible"));
        first_row.first_user_message = Some("needle first".to_string());
        let mut first_candidates = build_directory_candidates(
            std::slice::from_ref(&first_row),
            &overrides,
            &identities,
        );
        assert_eq!(
            title_search_annotation(
                &first_candidates.pop().expect("first candidate"),
                "needle",
            )
            .expect("first match")
            .matched_in,
            "firstUserMessage"
        );
    }
```

Run intentional RED:

```bash
set +e
env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::shared_' -- \
    --color=never --test-threads=1 \
  2>&1 | tee "$LOG_ROOT/task6-shared-red.log"
RED_STATUS=${PIPESTATUS[0]}
printf 'exit_code=%s\n' "$RED_STATUS" | tee "$LOG_ROOT/task6-shared-red.exit"
set -e
test "$RED_STATUS" -ne 0
grep -Eq 'cannot find (function|type|struct).*(compare_directory_order|resolve_indexed_overlay|build_directory_candidates|title_search_annotation)' \
  "$LOG_ROOT/task6-shared-red.log"
```

Expected RED: missing new candidate symbols, not malformed test syntax.

- [ ] **Step 2: Recover GREEN by adding the complete imports, candidate policy, selector, and materializer in one checkpoint.**

Complete both parts of Step 2 below before handing off or treating this checkbox as finished.

Replace the current top import region through the boot import with this complete block. It preserves every production import and the retained parser/oracle imports while adding the candidate-pipeline names:

```rust
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use freshell_sessions::{
    directory_index::{IndexedSession, SessionIndex},
    search::{search_session_file, FileSearchTier},
};
#[cfg(test)]
use freshell_sessions::meta::ParsedSessionMeta;
#[cfg(test)]
use freshell_sessions::{parse_session_content, ParseSessionOptions};
use freshell_ws::identity::TerminalIdentity;
use serde_json::{json, Map, Value};

use crate::boot::{is_authed, unauthorized};
```

This block explicitly preserves `PathBuf`, `SessionIndex`, `json`, `ParsedSessionMeta`, `parse_session_content`, `ParseSessionOptions`, and the boot imports while adding `Ordering`, `HashSet`, `IndexedSession`, and `TerminalIdentity`.

**Step 2, part A — Add candidate types and shared normalization/accessor policy.**

Add before the handler:

```rust
#[derive(Clone, Copy)]
struct DirectoryInputs<'a> {
    indexed: &'a [IndexedSession],
    overrides: &'a Map<String, Value>,
    metadata: &'a HashMap<String, Value>,
    identities: &'a [TerminalIdentity],
}

#[derive(Clone, Copy, Debug)]
struct IndexedOverlay<'a> {
    effective_title: Option<&'a str>,
    effective_summary: Option<&'a str>,
    archived: bool,
}

#[derive(Clone, Copy, Debug)]
enum SynthesizedSessionId<'a> {
    Existing(&'a str),
    TerminalFallback(&'a str),
}

#[derive(Debug)]
enum DirectoryCandidateSource<'a> {
    Indexed {
        row: &'a IndexedSession,
        overlay: IndexedOverlay<'a>,
        running_identity: Option<&'a TerminalIdentity>,
    },
    Synthesized {
        identity: &'a TerminalIdentity,
        provider: &'a str,
        session_id: SynthesizedSessionId<'a>,
    },
}

#[derive(Debug)]
struct DirectoryCandidate<'a> {
    key: Arc<str>,
    source: DirectoryCandidateSource<'a>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DirectoryOrderKey<'a> {
    last_activity_at: i64,
    key: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
struct DecodedCursor {
    last_activity_at: i64,
    key: String,
}

#[derive(Debug, PartialEq, Eq)]
struct SearchAnnotation {
    matched_in: String,
    snippet: String,
}

#[derive(Debug)]
struct SelectedCandidate<'a> {
    candidate: DirectoryCandidate<'a>,
    annotation: Option<SearchAnnotation>,
}

#[derive(Debug)]
struct CandidatePage<'a> {
    rows: Vec<SelectedCandidate<'a>>,
    partial: bool,
    partial_reason: Option<&'static str>,
}

fn resolve_indexed_overlay<'a>(
    row: &'a IndexedSession,
    override_value: Option<&'a Value>,
) -> Option<IndexedOverlay<'a>> {
    let Some(override_row) = override_value.and_then(Value::as_object) else {
        return Some(IndexedOverlay {
            effective_title: row.title.as_deref(),
            effective_summary: row.summary.as_deref(),
            archived: false,
        });
    };
    if override_row.get("deleted").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let suppress_title_override = row.title_source.as_deref() == Some("provider-generated")
        && matches!(
            override_row.get("titleSource").and_then(Value::as_str),
            Some("dir" | "first-message")
        );
    let effective_title = override_row
        .get("titleOverride")
        .and_then(Value::as_str)
        .filter(|title| !title.is_empty() && !suppress_title_override)
        .or(row.title.as_deref());
    let effective_summary = override_row
        .get("summaryOverride")
        .and_then(Value::as_str)
        .or(row.summary.as_deref());
    Some(IndexedOverlay {
        effective_title,
        effective_summary,
        archived: override_row
            .get("archived")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn first_identity_by_exact_session<'a>(
    identities: &'a [TerminalIdentity],
) -> HashMap<(&'a str, &'a str), usize> {
    let mut first = HashMap::new();
    for (index, identity) in identities.iter().enumerate() {
        if let (Some(provider), Some(session_id)) =
            (identity.provider.as_deref(), identity.session_id.as_deref())
        {
            first.entry((provider, session_id)).or_insert(index);
        }
    }
    first
}

fn build_directory_candidates<'a>(
    indexed: &'a [IndexedSession],
    overrides: &'a Map<String, Value>,
    identities: &'a [TerminalIdentity],
) -> Vec<DirectoryCandidate<'a>> {
    let first_live = first_identity_by_exact_session(identities);
    let mut existing_keys: HashSet<Arc<str>> = HashSet::new();
    let mut candidates = Vec::with_capacity(indexed.len() + identities.len());
    for row in indexed {
        let key: Arc<str> = Arc::from(
            format!("{}:{}", row.provider, row.session_id).into_boxed_str(),
        );
        let Some(overlay) = resolve_indexed_overlay(row, overrides.get(key.as_ref())) else {
            continue;
        };
        let running_identity = first_live
            .get(&(row.provider.as_str(), row.session_id.as_str()))
            .map(|index| &identities[*index]);
        existing_keys.insert(Arc::clone(&key));
        candidates.push(DirectoryCandidate {
            key,
            source: DirectoryCandidateSource::Indexed {
                row,
                overlay,
                running_identity,
            },
        });
    }
    for identity in identities {
        let Some(provider) = identity.provider.as_deref() else {
            continue;
        };
        let session_id = match identity.session_id.as_deref() {
            Some(session_id) => SynthesizedSessionId::Existing(session_id),
            None => SynthesizedSessionId::TerminalFallback(&identity.terminal_id),
        };
        let key: Arc<str> = Arc::from(match session_id {
            SynthesizedSessionId::Existing(session_id) => {
                format!("{provider}:{session_id}").into_boxed_str()
            }
            SynthesizedSessionId::TerminalFallback(terminal_id) => {
                format!("{provider}:terminal:{terminal_id}").into_boxed_str()
            }
        });
        if !existing_keys.insert(Arc::clone(&key)) {
            continue;
        }
        candidates.push(DirectoryCandidate {
            key,
            source: DirectoryCandidateSource::Synthesized {
                identity,
                provider,
                session_id,
            },
        });
    }
    candidates
}

impl DirectoryCandidate<'_> {
    fn order_key(&self) -> DirectoryOrderKey<'_> {
        DirectoryOrderKey {
            last_activity_at: match &self.source {
                DirectoryCandidateSource::Indexed { row, .. } => row.last_activity_at,
                DirectoryCandidateSource::Synthesized { identity, .. } => identity.updated_at,
            },
            key: &self.key,
        }
    }

    fn provider(&self) -> &str {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => &row.provider,
            DirectoryCandidateSource::Synthesized { provider, .. } => provider,
        }
    }

    fn effective_title(&self) -> Option<&str> {
        match &self.source {
            DirectoryCandidateSource::Indexed { overlay, .. } => overlay.effective_title,
            DirectoryCandidateSource::Synthesized { provider, .. } => {
                Some(provider_display_name(provider))
            }
        }
    }

    fn effective_summary(&self) -> Option<&str> {
        match &self.source {
            DirectoryCandidateSource::Indexed { overlay, .. } => overlay.effective_summary,
            DirectoryCandidateSource::Synthesized { .. } => None,
        }
    }

    fn first_user_message(&self) -> Option<&str> {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => row.first_user_message.as_deref(),
            DirectoryCandidateSource::Synthesized { .. } => None,
        }
    }

    fn is_subagent(&self) -> bool {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => row.is_subagent,
            DirectoryCandidateSource::Synthesized { identity, .. } => {
                identity.is_subagent.unwrap_or(false)
            }
        }
    }

    fn is_non_interactive(&self) -> bool {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => row.is_non_interactive,
            DirectoryCandidateSource::Synthesized { .. } => false,
        }
    }

    fn is_running(&self) -> bool {
        match &self.source {
            DirectoryCandidateSource::Indexed {
                running_identity, ..
            } => running_identity.is_some(),
            DirectoryCandidateSource::Synthesized { .. } => true,
        }
    }

    fn source_file(&self) -> Option<&Path> {
        match &self.source {
            DirectoryCandidateSource::Indexed { row, .. } => row.source_file.as_deref(),
            DirectoryCandidateSource::Synthesized { .. } => None,
        }
    }
}

fn compare_directory_order(
    left: DirectoryOrderKey<'_>,
    right: DirectoryOrderKey<'_>,
) -> Ordering {
    right
        .last_activity_at
        .cmp(&left.last_activity_at)
        .then_with(|| right.key.cmp(left.key))
}

fn candidate_is_strictly_after_cursor(
    candidate: &DirectoryCandidate<'_>,
    cursor: &DecodedCursor,
) -> bool {
    compare_directory_order(
        candidate.order_key(),
        DirectoryOrderKey {
            last_activity_at: cursor.last_activity_at,
            key: &cursor.key,
        },
    ) == Ordering::Greater
}

fn candidate_is_visible(candidate: &DirectoryCandidate<'_>, q: &DirQuery) -> bool {
    (q.include_subagents || !candidate.is_subagent())
        && (q.include_non_interactive || !candidate.is_non_interactive())
        && (q.include_empty
            || candidate.is_running()
            || candidate
                .effective_title()
                .map(str::trim)
                .is_some_and(|title| !title.is_empty()))
}

fn title_search_annotation(
    candidate: &DirectoryCandidate<'_>,
    lowercase_query: &str,
) -> Option<SearchAnnotation> {
    for (matched_in, field) in [
        ("title", candidate.effective_title()),
        ("summary", candidate.effective_summary()),
        ("firstUserMessage", candidate.first_user_message()),
    ] {
        let Some(field) = field else {
            continue;
        };
        if field.to_lowercase().contains(lowercase_query) {
            return Some(SearchAnnotation {
                matched_in: matched_in.to_string(),
                snippet: field.chars().take(140).collect(),
            });
        }
    }
    None
}

fn file_search_tier(tier: &Tier) -> Option<FileSearchTier> {
    match tier {
        Tier::Title => None,
        Tier::UserMessages => Some(FileSearchTier::UserMessages),
        Tier::FullText => Some(FileSearchTier::FullText),
    }
}
```

Continue directly to Step 2, part B without running or handing off; the shared tests also require the selector and materializer.

**Step 2, part B — Add the shared selector and sole full constructor, preserving deep-search order exactly.**

Add:

```rust
fn select_page_candidates<'a>(
    mut candidates: Vec<DirectoryCandidate<'a>>,
    q: &DirQuery,
    cursor: Option<&DecodedCursor>,
    limit: usize,
) -> CandidatePage<'a> {
    candidates.sort_by(|left, right| {
        compare_directory_order(left.order_key(), right.order_key())
    });
    let query = q
        .query
        .as_deref()
        .map(str::trim)
        .filter(|query| !query.is_empty());
    let lowercase_title_query = if query.is_some() && matches!(&q.tier, Tier::Title) {
        Some(query.expect("query exists").to_lowercase())
    } else {
        None
    };
    let mut rows = Vec::new();
    let mut partial = false;
    let mut partial_reason = None;
    let mut scanned_files = 0usize;
    let max_scan = limit * 10;

    for candidate in candidates {
        if !candidate_is_visible(&candidate, q) {
            continue;
        }
        if cursor.is_some_and(|cursor| {
            !candidate_is_strictly_after_cursor(&candidate, cursor)
        }) {
            continue;
        }

        let annotation = match (query, &q.tier) {
            (None, _) => None,
            (Some(_), Tier::Title) => {
                let Some(annotation) = title_search_annotation(
                    &candidate,
                    lowercase_title_query.as_deref().expect("lowercase title query"),
                ) else {
                    continue;
                };
                Some(annotation)
            }
            (Some(query), Tier::UserMessages | Tier::FullText) => {
                if rows.len() > limit {
                    break;
                }
                if scanned_files >= max_scan {
                    partial = true;
                    partial_reason = Some("budget");
                    break;
                }
                let Some(path) = candidate.source_file() else {
                    continue;
                };
                if !matches!(candidate.provider(), "claude" | "codex") {
                    continue;
                }
                scanned_files += 1;
                let tier = file_search_tier(&q.tier).expect("file search tier");
                match search_session_file(path, candidate.provider(), query, tier) {
                    Ok(Some(found)) => Some(SearchAnnotation {
                        matched_in: found.matched_in.to_string(),
                        snippet: found.snippet,
                    }),
                    Ok(None) => continue,
                    Err(_) => {
                        partial = true;
                        if partial_reason.is_none() {
                            partial_reason = Some("io_error");
                        }
                        continue;
                    }
                }
            }
        };
        rows.push(SelectedCandidate {
            candidate,
            annotation,
        });
    }

    CandidatePage {
        rows,
        partial,
        partial_reason,
    }
}

fn materialize_selected_candidate(
    selected: &SelectedCandidate<'_>,
    metadata: &HashMap<String, Value>,
) -> DirItem {
    match &selected.candidate.source {
        DirectoryCandidateSource::Indexed {
            row,
            overlay,
            running_identity,
        } => {
            let session_type = metadata
                .get(selected.candidate.key.as_ref())
                .and_then(Value::as_object)
                .and_then(|entry| entry.get("sessionType"))
                .and_then(Value::as_str)
                .filter(|session_type| !session_type.is_empty())
                .map(str::to_string);
            DirItem {
                session_id: row.session_id.clone(),
                provider: row.provider.clone(),
                project_path: row.project_path.clone(),
                title: overlay.effective_title.map(str::to_string),
                summary: overlay.effective_summary.map(str::to_string),
                first_user_message: row.first_user_message.clone(),
                last_activity_at: row.last_activity_at,
                created_at: row.created_at,
                cwd: row.cwd.clone(),
                is_subagent: row.is_subagent,
                is_non_interactive: row.is_non_interactive,
                is_running: running_identity.is_some(),
                archived: overlay.archived,
                matched_in: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.matched_in.clone()),
                snippet: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.snippet.clone()),
                running_terminal_id: running_identity
                    .map(|identity| identity.terminal_id.clone()),
                live_terminal_only: false,
                session_type,
                title_source: row.title_source.clone(),
                source_file: row.source_file.clone(),
            }
        }
        DirectoryCandidateSource::Synthesized {
            identity,
            provider,
            session_id,
        } => {
            let (session_id, live_terminal_only) = match session_id {
                SynthesizedSessionId::Existing(session_id) => {
                    ((*session_id).to_string(), false)
                }
                SynthesizedSessionId::TerminalFallback(terminal_id) => {
                    (format!("terminal:{terminal_id}"), true)
                }
            };
            let terminal_fallback = format!("terminal:{}", identity.terminal_id);
            DirItem {
                session_id,
                provider: (*provider).to_string(),
                project_path: identity
                    .cwd
                    .clone()
                    .unwrap_or_else(|| terminal_fallback.clone()),
                title: Some(provider_display_name(provider).to_string()),
                summary: None,
                first_user_message: None,
                last_activity_at: identity.updated_at,
                created_at: Some(identity.updated_at),
                cwd: identity.cwd.clone(),
                is_subagent: identity.is_subagent.unwrap_or(false),
                is_non_interactive: false,
                is_running: true,
                archived: false,
                matched_in: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.matched_in.clone()),
                snippet: selected
                    .annotation
                    .as_ref()
                    .map(|annotation| annotation.snippet.clone()),
                running_terminal_id: Some(identity.terminal_id.clone()),
                live_terminal_only,
                session_type: Some((*provider).to_string()),
                title_source: None,
                source_file: None,
            }
        }
    }
}
```

Task 6 intentionally leaves no-search/title descriptor retention unbounded so Task 7 can observe RED full-preparation counts. Deep search retains current `limit + 1` and budget behavior.

Finish Step 2 by running:

```bash
run_logged task6-shared-green \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::shared_' -- \
    --color=never --test-threads=1
run_logged task6-winner-green \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::candidate_normalization_preserves_exact_pair_and_full_key_first_winners' -- \
    --exact --color=never --test-threads=1
```

Expected GREEN: shared filter executes 4 tests; winner filter executes 1; both commands exit 0. Step 2 now ends compiling and GREEN.

- [ ] **Step 3: Add complete migration fixtures before changing existing tests.**

In `join_tests`, replace the `file_item` helper that returns `DirItem` with:

```rust
    fn indexed_file_item(provider: &str, session_id: &str, title: Option<&str>) -> IndexedSession {
        IndexedSession {
            session_id: session_id.to_string(),
            provider: provider.to_string(),
            project_path: "/repo".to_string(),
            title: title.map(str::to_string),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            title_source: None,
            last_activity_at: 100,
            created_at: Some(90),
            cwd: Some("/repo".to_string()),
            git_branch: None,
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    fn materialize_test_candidate(candidate: DirectoryCandidate<'_>) -> DirItem {
        materialize_selected_candidate(
            &SelectedCandidate {
                candidate,
                annotation: None,
            },
            &HashMap::new(),
        )
    }
```

In the main `tests` module, move the existing directory-index import to the module top and add the scanner/helpers before migrated page tests:

```rust
    use freshell_sessions::directory_index::{ClaudeSource, SessionIndex, SessionSource};

    fn scan_indexed_claude_sessions(home: &Path) -> Vec<IndexedSession> {
        ClaudeSource::new(claude_home(home)).scan()
    }

    fn indexed_test_item(session_id: &str, at: i64, title: Option<&str>) -> IndexedSession {
        IndexedSession {
            session_id: session_id.to_string(),
            provider: "claude".to_string(),
            project_path: "/repo".to_string(),
            title: title.map(str::to_string),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            title_source: None,
            last_activity_at: at,
            created_at: Some(at),
            cwd: Some("/repo".to_string()),
            git_branch: None,
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    fn deep_search_indexed_item(
        session_id: &str,
        at: i64,
        source_file: Option<PathBuf>,
    ) -> IndexedSession {
        let mut row = indexed_test_item(session_id, at, Some("visible"));
        row.source_file = source_file;
        row
    }

    fn guard_row(title_source: Option<&str>, title: Option<&str>) -> IndexedSession {
        let mut row = indexed_test_item("guard", 100, title);
        row.title_source = title_source.map(str::to_string);
        row
    }

    fn overlaid_title(row: IndexedSession, override_value: Value) -> Option<String> {
        resolve_indexed_overlay(&row, Some(&override_value))
            .and_then(|overlay| overlay.effective_title.map(str::to_string))
    }
```

Step 6 adds `derive_test_page` immediately after `derive_directory_page` exists. It is a thin call to the sole production derivation, not an old-policy or full-item adapter. `list_claude_sessions` and `item_from_meta` remain only for their parser/index oracle tests and are never fed into `derive_directory_page`.

Compile the newly added scanner and fixture helpers before migrating tests:

```bash
run_logged task6-fixtures-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
```

Expected GREEN: exit 0; `ClaudeSource`, parser/oracle imports, candidate fixtures, and existing tests all compile.

- [ ] **Step 4: Migrate the display/join batch with the exact candidate pattern.**

Use this concrete replacement pattern for running tests:

```rust
    let indexed = indexed_file_item("claude", "s1", None);
    let registry = freshell_ws::identity::TerminalIdentityRegistry::new();
    registry.upsert(
        "terminal-1",
        Some("claude"),
        Some("s1"),
        Some("/repo"),
        200,
    );
    let identities = registry.list();
    let overrides = Map::new();
    let mut candidates = build_directory_candidates(
        std::slice::from_ref(&indexed),
        &overrides,
        &identities,
    );
    assert_eq!(candidates.len(), 1);
    assert!(candidates[0].is_running());
    let item = materialize_test_candidate(candidates.pop().expect("candidate"));
    assert_eq!(item.running_terminal_id.as_deref(), Some("terminal-1"));
```

Use `TerminalIdentityRegistry::new()`, `upsert`, and `list` for registry-backed fixtures. Where a current test already constructs a `TerminalIdentity` value directly to set `is_subagent`, retain that compiling fixture verbatim and bind `let identities = vec![identity];`; do not invent a constructor or change its values.

For every synthesized-row test, replace the deleted helper call with this candidate/materializer sequence after the existing `identity` fixture:

```rust
    let identities = vec![identity];
    let overrides = Map::new();
    let mut candidates = build_directory_candidates(&[], &overrides, &identities);
    assert_eq!(candidates.len(), 1);
    let item = materialize_test_candidate(candidates.pop().expect("candidate"));
```

For a providerless identity, use the same first three lines and replace the last two lines with:

```rust
    assert!(candidates.is_empty());
```

Apply this exact per-test migration ledger; constructor arguments and existing field-level assertions remain byte-for-byte unchanged unless an assertion replacement is stated:

```text
join_running_state_matches_live_terminal_and_sets_running_fields
  Rename its Vec<DirItem> binding to `indexed`, change only `file_item` to
  `indexed_file_item`, and replace `join_running_state` with the complete
  indexed candidate block above. Retain the candidate `is_running()` and
  materialized `running_terminal_id == Some("terminal-1")` assertions.
join_running_state_no_match_leaves_not_running
  Make the same constructor/binding replacement, retain the existing
  nonmatching identity, build candidates once, assert one candidate,
  `!candidates[0].is_running()`, then materialize and assert
  `running_terminal_id.is_none()`.
build_live_terminal_session_item_none_without_a_provider
  Retain the existing providerless identity fixture and use the providerless
  sequence above; assert the candidate vector is empty.
build_live_terminal_session_item_with_session_id_is_not_live_terminal_only
  Retain the identity fixture and use the synthesized-row sequence above;
  keep every existing session id, provider, project path, title, activity,
  running-terminal id, live-terminal-only, and session-type assertion.
live_terminal_item_mirrors_identity_subagent_flag
  Run the synthesized-row sequence separately for the retained `Some(true)`
  and `None` identity fixtures; keep both existing `to_value()["isSubagent"]`
  assertions.
build_live_terminal_session_item_without_session_id_is_live_terminal_only
  Retain the no-session identity and use the synthesized-row sequence; keep
  the existing exact fallback session-id assertion, fallback project path,
  provider display title, running terminal id, `live_terminal_only`, and
  session type assertions.
join_live_terminals_matched_session_yields_one_running_item
  Rename its indexed vector and constructor as in the first migration, retain
  the exact matching identity, build once, assert one candidate, materialize,
  and keep all running field assertions.
join_live_terminals_unmatched_terminal_synthesizes_one_live_only_item
  Retain the identity, use empty indexed input and the synthesized-row
  sequence, then keep all synthesized/live-only field assertions.
join_live_terminals_matched_terminal_is_never_double_emitted
  Rename its indexed vector and constructor, retain the matching identity,
  call `build_directory_candidates`, and replace the old joined-vector count
  assertion with `assert_eq!(candidates.len(), 1)`.
codex_fresh_terminal_pre_adoption_duplicate_is_transient_pending_locator_adoption
  Rename its indexed vector and constructor, retaining provider `codex`; retain
  the no-session Codex identity, call `build_directory_candidates`, and replace
  the old joined-vector count assertion with `assert_eq!(candidates.len(), 2)`.
```

No migrated join test may call a compatibility wrapper that returns a full vector of `DirItem`; only the selected candidate under assertion is passed to `materialize_test_candidate`.

The display-helper test was already migrated in Task 5. After this batch, run:

```bash
run_logged task6-join-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
run_logged task6-join-batch \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::join_tests' -- \
    --color=never --test-threads=1
```

Expected GREEN: `--no-run` exits 0; the join module executes a positive count with zero failures.

- [ ] **Step 5: Migrate narrow override tests and all seven transitive guard tests.**

Use `resolve_indexed_overlay` directly for effective-field policy. For wire assertions, use `derive_test_page` after Step 6 adds `derive_directory_page`. Before Step 6, migrate and run only the direct resolver cases.

Exact resolver pattern:

```rust
    let row = guard_row(Some("provider-generated"), Some("provider title"));
    let override_value = json!({
        "titleOverride": "suppressed",
        "titleSource": "dir",
        "summaryOverride": "summary",
        "archived": true
    });
    let overlay =
        resolve_indexed_overlay(&row, Some(&override_value)).expect("surviving overlay");
    assert_eq!(overlay.effective_title, Some("provider title"));
    assert_eq!(overlay.effective_summary, Some("summary"));
    assert!(overlay.archived);
```

Migrate these direct override tests:

```text
overrides_overlay_applies_title_summary_archived_and_filters_deleted
  -> two IndexedSession rows; resolver asserts deletion/effective fields; Step 8 derives retained wire JSON
overlay_shape_unchanged_when_no_overrides_archived_always_present
  -> Step 8 derives one row and asserts archived:false plus title
suppressed_title_row_still_overlays_summary_and_archived
  -> resolver asserts effective title, summary, archived
title_tier_search_matches_a_renamed_sessions_override_title
  -> Step 8 derives with override map and title query; this is also apply_query obligation 15
```

Replace `guard_item` with `guard_row`, replace `overlaid_title` with the complete helper from Step 3, and migrate these seven transitive tests to construct `IndexedSession`:

```text
provider_generated_session_suppresses_dir_override_row
provider_generated_session_suppresses_first_message_override_row
provider_generated_session_still_applies_ai_override_row
provider_generated_session_still_applies_user_override_row
provider_generated_session_still_applies_absent_source_override_row
empty_string_title_override_never_applies
non_provider_generated_session_still_applies_dir_override_row
```

Compile the complete test target, then run the resolver/transitive batch exactly:

```bash
run_logged task6-resolver-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
for test_name in \
  suppressed_title_row_still_overlays_summary_and_archived \
  provider_generated_session_suppresses_dir_override_row \
  provider_generated_session_suppresses_first_message_override_row \
  provider_generated_session_still_applies_ai_override_row \
  provider_generated_session_still_applies_user_override_row \
  provider_generated_session_still_applies_absent_source_override_row \
  empty_string_title_override_never_applies \
  non_provider_generated_session_still_applies_dir_override_row
do
  run_logged "task6-resolver-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
```

Expected GREEN: `--no-run` exits 0 and each of the eight exact filters reports `1 passed`.

- [ ] **Step 6: Change the decoder return type, adapt its only tuple consumer, and add derivation in one compiling checkpoint.**

Replace `decode_cursor` in place with:

```rust
fn decode_cursor(cursor: &str) -> Result<DecodedCursor, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| "Invalid session-directory cursor".to_string())?;
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid session-directory cursor".to_string())?;
    let last_activity_at = value
        .get("lastActivityAt")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Invalid session-directory cursor".to_string())?;
    let key = value
        .get("key")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
        .ok_or_else(|| "Invalid session-directory cursor".to_string())?
        .to_string();
    Ok(DecodedCursor {
        last_activity_at,
        key,
    })
}
```

In the still-temporary old `apply_query`, atomically replace tuple destructuring with this compiling typed adaptation:

```rust
    if let Some(cursor) = cursor.as_ref() {
        items.retain(|item| {
            item.last_activity_at < cursor.last_activity_at
                || (item.last_activity_at == cursor.last_activity_at
                    && item.key().as_str() < cursor.key.as_str())
        });
    }
```

Add the behavior-equivalent, intentionally unbounded derivation:

```rust
fn derive_directory_page(
    inputs: DirectoryInputs<'_>,
    q: &DirQuery,
) -> Result<Value, String> {
    let limit = q
        .limit
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS);
    let cursor = q.cursor.as_deref().map(decode_cursor).transpose()?;
    let candidates = build_directory_candidates(
        inputs.indexed,
        inputs.overrides,
        inputs.identities,
    );
    let revision = candidates
        .iter()
        .map(|candidate| candidate.order_key().last_activity_at)
        .chain(inputs.identities.iter().map(|identity| identity.updated_at))
        .max()
        .unwrap_or(0)
        .max(0);
    let selected = select_page_candidates(candidates, q, cursor.as_ref(), limit);
    let materialized: Vec<DirItem> = selected
        .rows
        .iter()
        .map(|selected| materialize_selected_candidate(selected, inputs.metadata))
        .collect();
    let has_more = selected.rows.len() > limit;
    let next_cursor = has_more.then(|| {
        let tail = selected.rows[limit - 1].candidate.order_key();
        encode_cursor(tail.last_activity_at, tail.key)
    });
    let items = materialized
        .iter()
        .take(limit)
        .map(DirItem::to_value)
        .collect::<Vec<_>>();
    let mut page = json!({
        "items": items,
        "nextCursor": next_cursor,
        "revision": revision,
    });
    if selected.partial {
        page["partial"] = Value::Bool(true);
        if let Some(reason) = selected.partial_reason {
            page["partialReason"] = Value::String(reason.to_string());
        }
    }
    Ok(page)
}
```

Now add the derivation fixture before any migrated test uses it:

```rust
    fn derive_test_page(
        indexed: &[IndexedSession],
        overrides: &Map<String, Value>,
        identities: &[TerminalIdentity],
        query: &DirQuery,
    ) -> Value {
        let metadata = HashMap::new();
        derive_directory_page(
            DirectoryInputs {
                indexed,
                overrides,
                metadata: &metadata,
                identities,
            },
            query,
        )
        .expect("directory page")
    }
```

Compile the complete test target, not only the non-test binary:

```bash
run_logged task6-derive-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
```

Expected GREEN: exit 0. This checkpoint proves the decoder cutover, temporary tuple-consumer adaptation, parser/oracle imports, and new test helper all compile together.

- [ ] **Step 7: Migrate the ordinary `apply_query` tests, including the duplicate and cursor cases.**

The exact replacement call is:

```rust
    let metadata = HashMap::new();
    let page = derive_directory_page(
        DirectoryInputs {
            indexed: &indexed,
            overrides: &overrides,
            metadata: &metadata,
            identities: &identities,
        },
        &query,
    )
    .expect("page");
```

Convert the five parser-backed ordinary tests mechanically with `scan_indexed_claude_sessions`; never convert `Vec<DirItem>` back into indexed rows:

| Test | Exact fixture replacement | Assertions retained exactly |
|---|---|---|
| `default_query_hides_non_interactive_fixtures` | `let indexed = scan_indexed_claude_sessions(&home);` | indexed length 1; returned length 0; null cursor; revision `1_769_753_759_234`. |
| `include_non_interactive_surfaces_titled_session` | `let indexed = scan_indexed_claude_sessions(&home);` | returned length 1; title `Test Session 1`; provider `claude`. |
| `include_empty_surfaces_untitled_sessions_sorted_desc` | `let indexed = scan_indexed_claude_sessions(&home);` | returned length 1; session id `b7936c10-4935-441c-837c-c1f33cafec2d`. |
| `r10b_cwdless_repair_fixture_never_surfaces_under_any_flags` | `let indexed = scan_indexed_claude_sessions(&home);` over its custom home | `indexed.is_empty()`; returned length 0; revision 0. |
| `title_search_matches_and_annotates` | `let indexed = scan_indexed_claude_sessions(&home);` once, reused as `&indexed` for both derivations | hit length 1 with `matchedIn=title` and snippet `Test Session 1`; no-match length 0. |

Use this complete conversion for the first test:

```rust
#[test]
fn default_query_hides_non_interactive_fixtures() {
    let home = claude_home_with(&["real-corrupted.jsonl", "healthy.jsonl"]);
    let indexed = scan_indexed_claude_sessions(&home);
    assert_eq!(
        indexed.len(),
        1,
        "the cwd-less repair fixture is never indexed (R10b)"
    );

    let page = derive_test_page(&indexed, &Map::new(), &[], &default_query());
    assert_eq!(page["items"].as_array().unwrap().len(), 0);
    assert_eq!(page["nextCursor"], Value::Null);
    assert_eq!(page["revision"], json!(1_769_753_759_234i64));

    std::fs::remove_dir_all(&home).ok();
}
```

For the other four parser-backed tests, retain their current home construction, query mutations, cleanup, and assertions byte-for-byte; replace only `list_claude_sessions(&home)` with `scan_indexed_claude_sessions(&home)` and each `apply_query(items, &query, &[])` with `derive_test_page(&indexed, &Map::new(), &[], &query)`.

Migrate `cursor_paging_splits_and_round_trips`, `invalid_cursor_is_rejected`, and `badcursor_still_400s_with_original_message_r9_parity_untouched` by replacing their `Vec<DirItem>` fixtures with `Vec<IndexedSession>` built by `indexed_test_item` and replacing `apply_query` with `derive_directory_page`. Cursor round trips must consume encoded `nextCursor` and set `DirQuery.cursor`; both invalid-cursor tests must retain invalid base64 plus `encode_cursor(1, "")` and must not construct `DecodedCursor` directly.

Replace the Task-3 duplicate test and delete `legacy_duplicate_items` with:

```rust
    #[test]
    fn duplicate_equal_order_tuples_preserve_stable_order_and_strict_cursor_gap() {
        let mut first = indexed_row("duplicate", 500, Some("first"));
        first.project_path = "/first".to_string();
        let mut second = indexed_row("duplicate", 500, Some("second"));
        second.project_path = "/second".to_string();
        let indexed = vec![first, second];
        let overrides = Map::new();
        let metadata = HashMap::new();
        let identities = Vec::new();

        let one_page = derive_directory_page(
            DirectoryInputs {
                indexed: &indexed,
                overrides: &overrides,
                metadata: &metadata,
                identities: &identities,
            },
            &test_query(None, Tier::Title, None, 2),
        )
        .expect("one page");
        let titles: Vec<&str> = one_page["items"]
            .as_array()
            .expect("items")
            .iter()
            .map(|item| item["title"].as_str().expect("title"))
            .collect();
        assert_eq!(titles, vec!["first", "second"]);

        let first_page = derive_directory_page(
            DirectoryInputs {
                indexed: &indexed,
                overrides: &overrides,
                metadata: &metadata,
                identities: &identities,
            },
            &test_query(None, Tier::Title, None, 1),
        )
        .expect("first page");
        let cursor = first_page["nextCursor"]
            .as_str()
            .expect("cursor")
            .to_string();
        let second_page = derive_directory_page(
            DirectoryInputs {
                indexed: &indexed,
                overrides: &overrides,
                metadata: &metadata,
                identities: &identities,
            },
            &test_query(None, Tier::Title, Some(cursor), 1),
        )
        .expect("second page");
        assert!(second_page["items"].as_array().expect("items").is_empty());
        assert!(second_page["nextCursor"].is_null());
    }
```

Compile the complete test target, then run every migrated ordinary/cursor/duplicate test exactly:

```bash
run_logged task6-ordinary-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
for full_name in \
  session_directory::tests::default_query_hides_non_interactive_fixtures \
  session_directory::tests::include_non_interactive_surfaces_titled_session \
  session_directory::tests::include_empty_surfaces_untitled_sessions_sorted_desc \
  session_directory::tests::r10b_cwdless_repair_fixture_never_surfaces_under_any_flags \
  session_directory::tests::title_search_matches_and_annotates \
  session_directory::tests::cursor_paging_splits_and_round_trips \
  session_directory::tests::invalid_cursor_is_rejected \
  session_directory::tests::badcursor_still_400s_with_original_message_r9_parity_untouched \
  session_directory::page_bound_tests::duplicate_equal_order_tuples_preserve_stable_order_and_strict_cursor_gap
do
  run_logged "task6-ordinary-${full_name//::/-}" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "$full_name" -- --exact --color=never --test-threads=1
done
```

Expected GREEN: `--no-run` exits 0 and each of the nine exact filters reports `1 passed`.

- [ ] **Step 8: Complete override wire migrations and all seven transitive tests.**

Apply these mechanical edits to the two wire-shape tests:

```text
overrides_overlay_applies_title_summary_archived_and_filters_deleted:
  replace each DirItem fixture with indexed_test_item using the same session id,
  activity, and parsed title; copy the test's summary/title_source mutations to
  the corresponding IndexedSession; leave the existing override Map unchanged;
  replace apply_session_overrides plus per-item to_value with one
  derive_test_page(&indexed, &overrides, &[], &default_query()); retain every
  existing item-count, deleted-id absence, title, summary, and archived assertion.

overlay_shape_unchanged_when_no_overrides_archived_always_present:
  replace its DirItem fixture with indexed_test_item using the same values;
  derive with Map::new(), no identities, and default_query(); retain the exact
  title and archived:false JSON assertions.
```

Replace `title_tier_search_matches_a_renamed_sessions_override_title` completely with the appendix's code-ready body:

```rust
#[test]
fn title_tier_search_matches_a_renamed_sessions_override_title() {
    let indexed = vec![indexed_test_item(
        "s1",
        100,
        Some("original parsed title"),
    )];
    let overrides = Map::from_iter([(
        "claude:s1".to_string(),
        json!({"titleOverride": "My Renamed Special Project"}),
    )]);
    let query = DirQuery {
        query: Some("Renamed Special".into()),
        ..DirQuery::default()
    };

    let page = derive_test_page(&indexed, &overrides, &[], &query);
    let arr = page["items"].as_array().unwrap();
    assert_eq!(arr.len(), 1, "search must match the OVERRIDE title");
    assert_eq!(arr[0]["title"], json!("My Renamed Special Project"));
    assert_eq!(arr[0]["matchedIn"], json!("title"));
}
```

Compile the test target and run the complete resolver/override batch exactly:

```bash
run_logged task6-override-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
for test_name in \
  overrides_overlay_applies_title_summary_archived_and_filters_deleted \
  overlay_shape_unchanged_when_no_overrides_archived_always_present \
  suppressed_title_row_still_overlays_summary_and_archived \
  title_tier_search_matches_a_renamed_sessions_override_title \
  provider_generated_session_suppresses_dir_override_row \
  provider_generated_session_suppresses_first_message_override_row \
  provider_generated_session_still_applies_ai_override_row \
  provider_generated_session_still_applies_user_override_row \
  provider_generated_session_still_applies_absent_source_override_row \
  empty_string_title_override_never_applies \
  non_provider_generated_session_still_applies_dir_override_row
do
  run_logged "task6-override-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
```

Expected GREEN: `--no-run` exits 0 and each of the eleven exact filters reports `1 passed`.

- [ ] **Step 9: Migrate all deep-search tests to `IndexedSession` with real `source_file`.**

Convert the seven original deep/title tests with these exact fixture sources and retained assertions:

| Test | Exact indexed fixture | Assertions retained exactly |
|---|---|---|
| `tier_user_messages_matches_only_the_user_turn` | build `home` with `synthetic_claude_home_with_turns`, then `let indexed = scan_indexed_claude_sessions(&home);` once | indexed length 1; `source_file.is_some()`; user hit length 1, `matchedIn=userMessage`, exact snippet; assistant-only query length 0. |
| `tier_full_text_matches_assistant_turn_too` | `let indexed = scan_indexed_claude_sessions(&home);` over its existing synthetic home | result length 1; `matchedIn=assistantMessage`. |
| `tier_search_is_case_insensitive` | `let indexed = scan_indexed_claude_sessions(&home);` over its existing synthetic home | result length 1. |
| `tier_search_empty_no_match_returns_empty_items_without_partial` | `let indexed = scan_indexed_claude_sessions(&home);` over its existing synthetic home | items length 0; cursor null; `partial` omitted. |
| `tier_search_combined_with_cursor_pagination` | after building the existing custom three-file home, execute `let indexed = scan_indexed_claude_sessions(&home);` once before the loop and reuse `&indexed` | each page length 1; third cursor `None`; exact newest-first three-id vector. |
| `tier_search_reports_partial_budget_when_scan_budget_exceeded` | after building the existing custom eleven-file home, execute `let indexed = scan_indexed_claude_sessions(&home);` | indexed length 11; items length 0; `partial=true`; `partialReason=budget`. |
| `title_tier_search_matches_a_renamed_sessions_override_title` | `indexed_test_item("s1", 100, Some("original parsed title"))` plus the Step 8 override map | result length 1; effective title `My Renamed Special Project`; `matchedIn=title`. |

Replace `tier_user_messages_matches_only_the_user_turn` completely with the scanner-backed body:

```rust
#[test]
fn tier_user_messages_matches_only_the_user_turn() {
    let home = synthetic_claude_home_with_turns(
        "bbbbbbbb-0000-4000-8000-000000000001",
        "unique-search-term-alpha",
        "unique-search-term-alpha-assistant-only",
    );
    let indexed = scan_indexed_claude_sessions(&home);
    assert_eq!(indexed.len(), 1);
    assert!(
        indexed[0].source_file.is_some(),
        "a real session file must carry a source_file for tier search"
    );

    let q_user_hit = DirQuery {
        include_non_interactive: true,
        tier: Tier::UserMessages,
        query: Some("unique-search-term-alpha".into()),
        ..DirQuery::default()
    };
    let page = derive_test_page(&indexed, &Map::new(), &[], &q_user_hit);
    let arr = page["items"].as_array().unwrap();
    assert_eq!(arr.len(), 1, "userMessages tier must match the user turn");
    assert_eq!(arr[0]["matchedIn"], json!("userMessage"));
    assert_eq!(arr[0]["snippet"], json!("unique-search-term-alpha"));

    let q_assistant_only = DirQuery {
        include_non_interactive: true,
        tier: Tier::UserMessages,
        query: Some("assistant-only".into()),
        ..DirQuery::default()
    };
    let page2 = derive_test_page(&indexed, &Map::new(), &[], &q_assistant_only);
    assert_eq!(
        page2["items"].as_array().unwrap().len(),
        0,
        "userMessages tier must never match assistant-only text"
    );

    std::fs::remove_dir_all(&home).ok();
}
```

For `tier_full_text_matches_assistant_turn_too`, `tier_search_is_case_insensitive`, and `tier_search_empty_no_match_returns_empty_items_without_partial`, keep each current synthetic-home constructor, query, cleanup, and assertions; replace only `list_claude_sessions(&home)` with `scan_indexed_claude_sessions(&home)` and `apply_query` with `derive_test_page`.

For pagination, replace the per-iteration `list_claude_sessions(&home)` with one pre-loop `let indexed = scan_indexed_claude_sessions(&home);`, then call `derive_test_page(&indexed, &Map::new(), &[], &query)` in every loop iteration. For the budget test, replace `items` with `indexed`, retain `assert_eq!(indexed.len(), 11)`, and derive once. The renamed-title test is the 29th helper-to-test obligation and is replaced once by the complete Step 8 body.

Replace the three Task-3 edge tests with these `IndexedSession` calls:

```rust
    #[test]
    fn tier_search_reports_io_error_for_missing_source_file() {
        let home = tempfile::tempdir().expect("tempdir");
        let indexed = vec![deep_search_indexed_item(
            "missing",
            100,
            Some(home.path().join("missing.jsonl")),
        )];
        let page = derive_test_page(&indexed, &Map::new(), &[], &deep_search_query());
        assert!(page["items"].as_array().expect("items").is_empty());
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("io_error"));
    }

    #[test]
    fn tier_search_budget_overwrites_prior_io_error() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut indexed = vec![deep_search_indexed_item(
            "missing",
            1_000,
            Some(home.path().join("missing.jsonl")),
        )];
        for index in 0..9 {
            let path = home.path().join(format!("valid-{index}.jsonl"));
            write_nonmatching_claude_transcript(&path);
            indexed.push(deep_search_indexed_item(
                &format!("valid-{index}"),
                999 - index as i64,
                Some(path),
            ));
        }
        let tail = home.path().join("eligible-tail.jsonl");
        write_nonmatching_claude_transcript(&tail);
        indexed.push(deep_search_indexed_item("eligible-tail", 900, Some(tail)));
        let page = derive_test_page(&indexed, &Map::new(), &[], &deep_search_query());
        assert_eq!(page["partialReason"], json!("budget"));
    }

    #[test]
    fn tier_search_budget_is_checked_before_no_source_tail() {
        let home = tempfile::tempdir().expect("tempdir");
        let mut indexed = Vec::new();
        for index in 0..10 {
            let path = home.path().join(format!("valid-{index}.jsonl"));
            write_nonmatching_claude_transcript(&path);
            indexed.push(deep_search_indexed_item(
                &format!("valid-{index}"),
                1_000 - index as i64,
                Some(path),
            ));
        }
        indexed.push(deep_search_indexed_item("no-source-tail", 900, None));
        let page = derive_test_page(&indexed, &Map::new(), &[], &deep_search_query());
        assert_eq!(page["partialReason"], json!("budget"));
    }
```

Do not pass `list_claude_sessions()` output to `derive_directory_page`. Keep `list_claude_sessions` only for its separate parser/index differential tests. Delete `deep_search_dir_item` after all deep migrations.

Compile the complete test target and run all ten original/edge deep-title tests exactly:

```bash
run_logged task6-deep-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
for test_name in \
  tier_user_messages_matches_only_the_user_turn \
  tier_full_text_matches_assistant_turn_too \
  tier_search_is_case_insensitive \
  tier_search_empty_no_match_returns_empty_items_without_partial \
  tier_search_combined_with_cursor_pagination \
  tier_search_reports_partial_budget_when_scan_budget_exceeded \
  title_tier_search_matches_a_renamed_sessions_override_title \
  tier_search_reports_io_error_for_missing_source_file \
  tier_search_budget_overwrites_prior_io_error \
  tier_search_budget_is_checked_before_no_source_tail
do
  run_logged "task6-deep-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
```

Expected GREEN: `--no-run` exits 0 and each of the ten exact filters reports `1 passed`.

- [ ] **Step 10: Verify the complete 28-test/29-obligation migration ledger.**

The named ledger is:

```text
10 join direct-helper tests:
  join_running_state_matches_live_terminal_and_sets_running_fields
  join_running_state_no_match_leaves_not_running
  build_live_terminal_session_item_none_without_a_provider
  build_live_terminal_session_item_with_session_id_is_not_live_terminal_only
  live_terminal_item_mirrors_identity_subagent_flag
  build_live_terminal_session_item_without_session_id_is_live_terminal_only
  join_live_terminals_matched_session_yields_one_running_item
  join_live_terminals_unmatched_terminal_synthesizes_one_live_only_item
  join_live_terminals_matched_terminal_is_never_double_emitted
  codex_fresh_terminal_pre_adoption_duplicate_is_transient_pending_locator_adoption

4 override direct-helper tests:
  overrides_overlay_applies_title_summary_archived_and_filters_deleted
  overlay_shape_unchanged_when_no_overrides_archived_always_present
  suppressed_title_row_still_overlays_summary_and_archived
  title_tier_search_matches_a_renamed_sessions_override_title

15 apply_query direct-helper tests:
  default_query_hides_non_interactive_fixtures
  include_non_interactive_surfaces_titled_session
  include_empty_surfaces_untitled_sessions_sorted_desc
  r10b_cwdless_repair_fixture_never_surfaces_under_any_flags
  title_search_matches_and_annotates
  cursor_paging_splits_and_round_trips
  invalid_cursor_is_rejected
  badcursor_still_400s_with_original_message_r9_parity_untouched
  tier_user_messages_matches_only_the_user_turn
  tier_full_text_matches_assistant_turn_too
  tier_search_is_case_insensitive
  tier_search_empty_no_match_returns_empty_items_without_partial
  tier_search_combined_with_cursor_pagination
  tier_search_reports_partial_budget_when_scan_budget_exceeded
  title_tier_search_matches_a_renamed_sessions_override_title

Unique direct-helper tests = 10 + 4 + 15 - 1 overlap = 28
Helper-to-test obligations = 10 + 4 + 15 = 29

7 transitive overlaid_title tests:
  provider_generated_session_suppresses_dir_override_row
  provider_generated_session_suppresses_first_message_override_row
  provider_generated_session_still_applies_ai_override_row
  provider_generated_session_still_applies_user_override_row
  provider_generated_session_still_applies_absent_source_override_row
  empty_string_title_override_never_applies
  non_provider_generated_session_still_applies_dir_override_row

1 display-helper test migrated in Task 5:
  provider_display_name_matches_known_providers_and_falls_back_to_raw
```

Compile the complete test target one final time before deleting any old policy:

```bash
run_logged task6-predelete-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
```

Expected GREEN: exit 0 after every display/join, resolver, ordinary/cursor, override, and deep migration.

Run semantic residue search before deleting old definitions:

```bash
for symbol in \
  apply_session_overrides \
  join_running_state \
  build_live_terminal_session_item \
  join_live_terminals \
  apply_query
do
  grep -n "$symbol(" "$WT/$SOURCE_REL" \
    | tee "$LOG_ROOT/task6-predelete-$symbol.txt"
done
```

At this point, references must be only old production definitions/callers scheduled for Step 11, not tests. If any named test still appears, finish that migration before cutover.

- [ ] **Step 11: Perform the atomic handler cutover, old-policy deletion, `DirItem` cleanup, and rustdoc update.**

Replace the handler's eager acquisition through response handling with this complete code:

```rust
    let snapshot: Option<Arc<Vec<IndexedSession>>> = match &state.session_index {
        Some(index) => Some(index.snapshot().await),
        None => None,
    };
    let indexed: &[IndexedSession] = snapshot
        .as_deref()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let overrides = state.settings.session_overrides();
    let metadata = state.metadata.get_all().await;
    let identities = state.identity.list();
    let result = derive_directory_page(
        DirectoryInputs {
            indexed,
            overrides: &overrides,
            metadata: &metadata,
            identities: &identities,
        },
        &query,
    );

    match result {
        Ok(mut page) => {
            let project_colors = state.settings.project_colors();
            if !project_colors.is_empty() {
                page["projectColors"] = json!(project_colors);
            }
            Json(page).into_response()
        }
        Err(_) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "Invalid session-directory cursor"})),
        )
            .into_response(),
    }
```

Delete these old production definitions together:

```text
dir_item_from_indexed
apply_session_overrides
apply_session_metadata
join_running_state
build_live_terminal_session_item
join_live_terminals
apply_query
FileSearchOutcome
apply_file_search
apply_title_search
```

Retain `provider_display_name` with its Task-5 borrowed signature, retain `decode_cursor` with its new typed return, and retain `DirItem::to_value` as the sole serializer.

Remove only the obsolete `DirItem` fields and `DirItem::key`, then preserve the current `DirItem::to_value` insertion order/body exactly as shown below. Do not reorder the raw JSON object; Task 7 later inserts only ledger instrumentation as the first statement:

```rust
/// Fully materialized session-directory output row. Candidate-only policy data
/// remains borrowed in `DirectoryCandidate` and is never stored here.
#[derive(Debug, Clone)]
struct DirItem {
    session_id: String,
    provider: String,
    project_path: String,
    title: Option<String>,
    summary: Option<String>,
    first_user_message: Option<String>,
    last_activity_at: i64,
    created_at: Option<i64>,
    cwd: Option<String>,
    is_subagent: bool,
    is_non_interactive: bool,
    is_running: bool,
    archived: bool,
    matched_in: Option<String>,
    snippet: Option<String>,
    running_terminal_id: Option<String>,
    live_terminal_only: bool,
    session_type: Option<String>,
}

impl DirItem {
    fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("sessionId".into(), json!(self.session_id));
        o.insert("provider".into(), json!(self.provider));
        o.insert("projectPath".into(), json!(self.project_path));
        o.insert("lastActivityAt".into(), json!(self.last_activity_at));
        o.insert("isRunning".into(), json!(self.is_running));
        // R10a: the original always emits `archived` (a `SessionOverride` field
        // defaulted to `false`, `shared/read-models.ts:51`); overlaid from
        // `config.sessionOverrides` by `resolve_indexed_overlay`.
        o.insert("archived".into(), json!(self.archived));
        if let Some(v) = &self.title {
            o.insert("title".into(), json!(v));
        }
        if let Some(v) = &self.summary {
            o.insert("summary".into(), json!(v));
        }
        if let Some(v) = &self.first_user_message {
            o.insert("firstUserMessage".into(), json!(v));
        }
        if let Some(v) = self.created_at {
            o.insert("createdAt".into(), json!(v));
        }
        if let Some(v) = &self.cwd {
            o.insert("cwd".into(), json!(v));
        }
        if self.is_subagent {
            o.insert("isSubagent".into(), json!(true));
        }
        if self.is_non_interactive {
            o.insert("isNonInteractive".into(), json!(true));
        }
        if let Some(v) = &self.matched_in {
            o.insert("matchedIn".into(), json!(v));
        }
        if let Some(v) = &self.snippet {
            o.insert("snippet".into(), json!(v));
        }
        if let Some(v) = &self.running_terminal_id {
            o.insert("runningTerminalId".into(), json!(v));
        }
        if self.live_terminal_only {
            o.insert("liveTerminalOnly".into(), json!(true));
        }
        if let Some(v) = &self.session_type {
            o.insert("sessionType".into(), json!(v));
        }
        Value::Object(o)
    }
}
```

This removes `DirItem::key`, `DirItem.title_source`, and `DirItem.source_file`. Replace both remaining test-only `item.key()` assertions with `format!("{}:{}", item.provider, item.session_id)`; do not add a test-only key method. In the indexed materializer arm delete `title_source: row.title_source.clone()` and `source_file: row.source_file.clone()`; in the synthesized arm delete `title_source: None` and `source_file: None`. Remove the same two fields from every other remaining `DirItem` literal. Do not remove `IndexedSession.title_source` or `IndexedSession.source_file`.

Remove `item_from_meta`'s obsolete source-file parameter rather than leaving an unused warnings-denied argument. Replace its function header exactly; retain the existing body after the opening brace:

```text
fn item_from_meta(
    meta: &ParsedSessionMeta,
    provider: &str,
    fallback_session_id: &str,
    force_subagent: bool,
) -> DirItem {
```

In `parse_claude_file`, replace the call with:

```rust
Some(item_from_meta(
    &meta,
    "claude",
    &fallback,
    force_subagent,
))
```

Replace the two direct-test calls with:

```rust
let item = item_from_meta(&meta, "claude", "real-corrupted", false);
let item = item_from_meta(&meta, "claude", "healthy", false);
```

Inside `item_from_meta`'s `DirItem` literal, delete both `title_source: meta.title_source.clone()` and `source_file`. These are the only three call sites; do not retain an `_source_file` parameter. Deep-search source ownership now lives only on `IndexedSession.source_file`.

Replace stale source documentation with these exact blocks:

```rust
//! Rust implementation of `GET /api/session-directory`.
//!
//! Each request captures one index snapshot plus request-local override,
//! metadata, and terminal-identity snapshots. A shared borrowed-candidate
//! pipeline owns effective membership, ordering, visibility, cursor, and search
//! policy for every tier; only returned descriptors become `DirItem` values.
```

```rust
/// Request dependencies for the Rust session-directory route. `session_index`
/// may be absent; provider-bearing live identities can still synthesize rows.
```

```rust
/// Search tier. A nonblank query selects title metadata or transcript search;
/// a missing or blank query uses the same no-search candidate pipeline for all
/// tier values.
```

Update any field comments that claim metadata never decorates indexed rows or that `None` index always means an empty page. Remove rustdoc links to deleted helper names.

- [ ] **Step 12: Verify the nine route tests remain unchanged and GREEN.**

Do not edit these call sites:

```text
b_t7_router_get_session_directory_is_backed_by_the_session_index
session_metadata_session_type_is_joined_onto_directory_items
session_directory_page_embeds_config_project_colors
session_directory_page_omits_project_colors_key_when_empty
b_t8_no_session_index_yields_empty_page
override_no_rebuild
codex_exec_session_hidden_by_default_surfaced_with_flag
session_override_applies_to_codex_and_opencode_keys
global_project_session_reports_real_directory_as_project_path
```

Compile after destructive cutover, then run all nine route tests exactly:

```bash
run_logged task6-post-cutover-no-run \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server --no-run
for test_name in \
  b_t7_router_get_session_directory_is_backed_by_the_session_index \
  session_metadata_session_type_is_joined_onto_directory_items \
  session_directory_page_embeds_config_project_colors \
  session_directory_page_omits_project_colors_key_when_empty \
  b_t8_no_session_index_yields_empty_page \
  override_no_rebuild \
  codex_exec_session_hidden_by_default_surfaced_with_flag \
  session_override_applies_to_codex_and_opencode_keys \
  global_project_session_reports_real_directory_as_project_path
do
  run_logged "task6-route-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
```

Expected GREEN: `--no-run` exits 0 and each of the nine route filters reports `1 passed`.

- [ ] **Step 13: Run the four shared-prefixed tests, the winner test, all 20 page-bound tests, and the complete focused family.**

```bash
run_logged task6-shared-four \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::shared_' -- \
    --color=never --test-threads=1
run_logged task6-winner \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests::candidate_normalization_preserves_exact_pair_and_full_key_first_winners' -- \
    --exact --color=never --test-threads=1
run_logged task6-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
run_logged task6-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Expected GREEN: shared filter reports `4 passed`; winner exact filter reports `1 passed`; page-bound module reports `20 passed; 0 failed; 0 ignored; 0 measured`; focused family positive and zero failures.

- [ ] **Step 14: Run strengthened static residue checks.**

```bash
! grep -n 'provider_display_name_borrowed' "$WT/$SOURCE_REL"
test "$(grep -Ec '^fn provider_display_name\(' "$WT/$SOURCE_REL")" -eq 1
test "$(grep -Ec '^fn compare_directory_order\(' "$WT/$SOURCE_REL")" -eq 1
test "$(grep -Ec '^fn candidate_is_visible\(' "$WT/$SOURCE_REL")" -eq 1
test "$(grep -Ec '^fn resolve_indexed_overlay' "$WT/$SOURCE_REL")" -eq 1
test "$(grep -Ec '^fn derive_directory_page\(' "$WT/$SOURCE_REL")" -eq 1
test "$(grep -Ec '^fn materialize_selected_candidate\(' "$WT/$SOURCE_REL")" -eq 1
! grep -En '^fn (dir_item_from_indexed|apply_session_overrides|apply_session_metadata|join_running_state|build_live_terminal_session_item|join_live_terminals|apply_query|apply_file_search|apply_title_search)\(' \
  "$WT/$SOURCE_REL"
! grep -En '^struct FileSearchOutcome' "$WT/$SOURCE_REL"
! grep -En '^\s*fn key\(&self\)' "$WT/$SOURCE_REL"
! grep -En '(DirectoryStrategy|ComparisonStrategy|Materialized|FastPath|OldStrategy|NewStrategy)' \
  "$WT/$SOURCE_REL"
! sed -n '1,260p' "$WT/$SOURCE_REL" \
  | grep -E '(apply_query|apply_session_overrides|join_live_terminals|build_live_terminal_session_item)'
python3 - "$WT/$SOURCE_REL" <<'PY'
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
start = text.index('struct DirItem {')
end = text.index('\n}\n\nimpl DirItem', start)
body = text[start:end]
assert 'title_source' not in body
assert 'source_file' not in body

item_from_meta_start = text.index('fn item_from_meta(')
item_from_meta_signature_end = text.index(') -> DirItem', item_from_meta_start)
item_from_meta_signature = text[item_from_meta_start:item_from_meta_signature_end]
assert 'source_file' not in item_from_meta_signature
assert text.count('item_from_meta(') == 4

serializer_start = text.index('fn to_value(&self) -> Value {')
serializer_end = text.index('Value::Object(o)', serializer_start)
serializer = text[serializer_start:serializer_end]
ordered_fields = [
    '"sessionId"',
    '"provider"',
    '"projectPath"',
    '"lastActivityAt"',
    '"isRunning"',
    '"archived"',
    '"title"',
    '"summary"',
    '"firstUserMessage"',
    '"createdAt"',
    '"cwd"',
    '"isSubagent"',
    '"isNonInteractive"',
    '"matchedIn"',
    '"snippet"',
    '"runningTerminalId"',
    '"liveTerminalOnly"',
    '"sessionType"',
]
positions = [serializer.index(field) for field in ordered_fields]
assert positions == sorted(positions)

for marker in ['DirItem {']:
    cursor = 0
    while True:
        begin = text.find(marker, cursor)
        if begin < 0:
            break
        brace = text.find('{', begin)
        depth = 0
        finish = None
        for index in range(brace, len(text)):
            if text[index] == '{':
                depth += 1
            elif text[index] == '}':
                depth -= 1
                if depth == 0:
                    finish = index + 1
                    break
        assert finish is not None
        literal = text[begin:finish]
        assert 'title_source:' not in literal
        assert 'source_file:' not in literal
        cursor = finish
PY
```

Expected: no output and exit 0.

- [ ] **Step 15: Commit the atomic shared-policy replacement.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "refactor(session-directory): unify candidate selection policy" \
  -m "Replace the eager full-item chain with one borrowed candidate corpus, migrate every semantic consumer, preserve cursor and deep-search edge semantics, and remove obsolete full-item policy residue." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 7: Observe RED All-Corpus Preparation, Then Bound It to Returned Rows

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Test: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**

```text
PreparationCounts = indexed_full + synthesized_full + four decoration/serialization counts
PreparationScope = request-thread active guard with finish and panic cleanup
Instrumentation owner = materialize_selected_candidate and DirItem::to_value only
Final descriptor bound = rows.len() <= limit + 1
Final full-preparation bound = counts equal returned row provenance and never exceed limit
```

- [ ] **Step 1: Add the request-scoped ledger implementation.**

```rust
#[cfg(test)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct PreparationCounts {
    indexed_full: usize,
    synthesized_full: usize,
    override_decoration: usize,
    metadata_decoration: usize,
    running_decoration: usize,
    serialization: usize,
}

#[cfg(test)]
thread_local! {
    static PREPARATION_COUNTS: std::cell::Cell<PreparationCounts> =
        const { std::cell::Cell::new(PreparationCounts {
            indexed_full: 0,
            synthesized_full: 0,
            override_decoration: 0,
            metadata_decoration: 0,
            running_decoration: 0,
            serialization: 0,
        }) };
    static PREPARATION_SCOPE_ACTIVE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

#[cfg(test)]
struct PreparationScope {
    finished: bool,
}

#[cfg(test)]
fn begin_preparation_scope() -> PreparationScope {
    PREPARATION_SCOPE_ACTIVE.with(|active| {
        assert!(!active.get(), "nested preparation scopes are forbidden");
        active.set(true);
    });
    PREPARATION_COUNTS.with(|counts| counts.set(PreparationCounts::default()));
    PreparationScope { finished: false }
}

#[cfg(test)]
fn record_preparation(update: impl FnOnce(&mut PreparationCounts)) {
    PREPARATION_SCOPE_ACTIVE.with(|active| {
        if !active.get() {
            return;
        }
        PREPARATION_COUNTS.with(|cell| {
            let mut counts = cell.get();
            update(&mut counts);
            cell.set(counts);
        });
    });
}

#[cfg(test)]
impl PreparationScope {
    fn finish(mut self) -> PreparationCounts {
        PREPARATION_SCOPE_ACTIVE.with(|active| {
            assert!(active.get(), "preparation scope is not active");
            active.set(false);
        });
        let counts = PREPARATION_COUNTS.with(std::cell::Cell::get);
        PREPARATION_COUNTS.with(|cell| cell.set(PreparationCounts::default()));
        self.finished = true;
        counts
    }
}

#[cfg(test)]
impl Drop for PreparationScope {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        PREPARATION_SCOPE_ACTIVE.with(|active| active.set(false));
        PREPARATION_COUNTS.with(|cell| cell.set(PreparationCounts::default()));
    }
}
```

- [ ] **Step 2: Instrument the sole full constructor and serializer.**

Insert as the first statement of the indexed materializer arm:

```rust
            #[cfg(test)]
            record_preparation(|counts| {
                counts.indexed_full += 1;
                counts.override_decoration += 1;
                counts.metadata_decoration += 1;
                counts.running_decoration += 1;
            });
```

Insert as the first statement of the synthesized arm:

```rust
            #[cfg(test)]
            record_preparation(|counts| {
                counts.synthesized_full += 1;
            });
```

Insert as the first statement in `DirItem::to_value`, immediately before the unchanged `let mut o = Map::new();` line:

```rust
        #[cfg(test)]
        record_preparation(|counts| {
            counts.serialization += 1;
        });
```

No other function increments these counters.

- [ ] **Step 3: Add five deterministic work-bound route tests.**

Inside `page_bound_tests`, add:

```rust
    #[tokio::test(flavor = "current_thread")]
    async fn no_search_materializes_only_returned_indexed_rows_not_lookahead() {
        let rows = (0..100)
            .map(|index| {
                indexed_row(
                    &format!("s-{index:03}"),
                    10_000 - index as i64,
                    Some("visible"),
                )
            })
            .collect();
        let harness = directory_route_harness(rows);
        let scope = begin_preparation_scope();
        let page = get_page(harness.app.clone(), "&limit=2").await;
        let counts = scope.finish();
        assert_eq!(page["items"].as_array().expect("items").len(), 2);
        assert!(page_cursor(&page).is_some());
        assert_eq!(
            counts,
            PreparationCounts {
                indexed_full: 2,
                synthesized_full: 0,
                override_decoration: 2,
                metadata_decoration: 2,
                running_decoration: 2,
                serialization: 2,
            }
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_search_materializes_only_returned_synthesized_rows_not_lookahead() {
        let harness = directory_route_harness(Vec::new());
        for index in 0..100 {
            harness.identity.upsert(
                &format!("terminal-{index:03}"),
                Some("claude"),
                Some(&format!("live-{index:03}")),
                Some("/live"),
                10_000 - index as i64,
            );
        }
        let scope = begin_preparation_scope();
        let page = get_page(harness.app.clone(), "&limit=2").await;
        let counts = scope.finish();
        assert_eq!(page["items"].as_array().expect("items").len(), 2);
        assert!(page_cursor(&page).is_some());
        assert_eq!(
            counts,
            PreparationCounts {
                indexed_full: 0,
                synthesized_full: 2,
                override_decoration: 0,
                metadata_decoration: 0,
                running_decoration: 0,
                serialization: 2,
            }
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_search_long_deleted_and_hidden_prefix_materializes_only_backfilled_rows() {
        let mut rows = Vec::new();
        for index in 0..20 {
            rows.push(indexed_row(
                &format!("deleted-{index:02}"),
                5_000 - index as i64,
                Some("deleted"),
            ));
        }
        for index in 0..20 {
            let mut row = indexed_row(
                &format!("subagent-{index:02}"),
                4_000 - index as i64,
                Some("subagent"),
            );
            row.is_subagent = true;
            rows.push(row);
        }
        for index in 0..20 {
            let mut row = indexed_row(
                &format!("noninteractive-{index:02}"),
                3_000 - index as i64,
                Some("noninteractive"),
            );
            row.is_non_interactive = true;
            rows.push(row);
        }
        for index in 0..20 {
            rows.push(indexed_row(
                &format!("empty-{index:02}"),
                2_000 - index as i64,
                None,
            ));
        }
        for index in 0..12 {
            rows.push(indexed_row(
                &format!("visible-{index:02}"),
                1_000 - index as i64,
                Some("visible"),
            ));
        }
        let harness = directory_route_harness(rows);
        for index in 0..20 {
            harness
                .settings
                .patch_session_override(
                    &format!("claude:deleted-{index:02}"),
                    &[("deleted", Some(json!(true)))],
                )
                .await;
        }
        let first = get_page(harness.app.clone(), "&limit=1").await;
        assert_eq!(item_ids(&first), vec!["visible-00"]);
        let cursor = page_cursor(&first).expect("cursor");
        let scope = begin_preparation_scope();
        let page = get_page(
            harness.app.clone(),
            &format!("&limit=2&cursor={cursor}"),
        )
        .await;
        let counts = scope.finish();
        assert_eq!(item_ids(&page), vec!["visible-01", "visible-02"]);
        assert!(page_cursor(&page).is_some());
        assert_eq!(
            counts,
            PreparationCounts {
                indexed_full: 2,
                synthesized_full: 0,
                override_decoration: 2,
                metadata_decoration: 2,
                running_decoration: 2,
                serialization: 2,
            }
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn no_search_all_filtered_corpus_materializes_zero_rows() {
        let rows = (0..100)
            .map(|index| {
                let mut row = indexed_row(
                    &format!("hidden-{index:03}"),
                    10_000 - index as i64,
                    Some("hidden"),
                );
                row.is_subagent = true;
                row
            })
            .collect();
        let harness = directory_route_harness(rows);
        let scope = begin_preparation_scope();
        let page = get_page(harness.app.clone(), "&limit=2").await;
        let counts = scope.finish();
        assert!(item_ids(&page).is_empty());
        assert!(page_cursor(&page).is_none());
        assert_eq!(page["revision"], json!(10_000));
        assert_eq!(counts, PreparationCounts::default());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn title_search_scans_sparse_corpus_but_materializes_only_returned_rows() {
        let mut rows: Vec<IndexedSession> = (0..101)
            .map(|index| {
                indexed_row(
                    &format!("nonmatch-{index:03}"),
                    20_000 - index as i64,
                    Some("visible nonmatch"),
                )
            })
            .collect();
        for index in 0..3 {
            rows.push(indexed_row(
                &format!("match-{index:02}"),
                1_000 - index as i64,
                Some("sparse needle match"),
            ));
        }
        let harness = directory_route_harness(rows);
        let scope = begin_preparation_scope();
        let page = get_page(
            harness.app.clone(),
            "&query=needle&tier=title&limit=1",
        )
        .await;
        let counts = scope.finish();
        assert_eq!(item_ids(&page), vec!["match-00"]);
        assert!(page_cursor(&page).is_some());
        assert_eq!(
            counts,
            PreparationCounts {
                indexed_full: 1,
                synthesized_full: 0,
                override_decoration: 1,
                metadata_decoration: 1,
                running_decoration: 1,
                serialization: 1,
            }
        );
    }
```

- [ ] **Step 4: Record the required RED counts against Task 6.**

```bash
for test_name in \
  no_search_materializes_only_returned_indexed_rows_not_lookahead \
  no_search_materializes_only_returned_synthesized_rows_not_lookahead \
  no_search_long_deleted_and_hidden_prefix_materializes_only_backfilled_rows \
  title_search_scans_sparse_corpus_but_materializes_only_returned_rows
do
  set +e
  env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::page_bound_tests::$test_name" -- \
      --exact --color=never --test-threads=1 \
    2>&1 | tee "$LOG_ROOT/task7-red-$test_name.log"
  status=${PIPESTATUS[0]}
  printf 'exit_code=%s\n' "$status" \
    | tee "$LOG_ROOT/task7-red-$test_name.exit"
  set -e
  test "$status" -ne 0
done
```

Expected RED:

```text
indexed corpus: indexed_full is 100, expected 2
synthesized corpus: synthesized_full is 100, expected 2
long filtered/cursor corpus: indexed_full is 11, expected 2
sparse title search: indexed_full is 3, expected 1
```

The all-hidden test may already pass at zero because visibility precedes materialization.

- [ ] **Step 5: Bound retained descriptors for no-search and title while preserving deep loop order.**

After pushing a no-search or title match, add the descriptor bound; retain the deep branch's pre-source `rows.len() > limit` check exactly:

```rust
        rows.push(SelectedCandidate {
            candidate,
            annotation,
        });
        if !matches!(&q.tier, Tier::UserMessages | Tier::FullText) || query.is_none() {
            if rows.len() > limit {
                break;
            }
        }
```

The deep branch remains:

```rust
                if rows.len() > limit {
                    break;
                }
                if scanned_files >= max_scan {
                    partial = true;
                    partial_reason = Some("budget");
                    break;
                }
```

This avoids moving budget behind source/provider checks.

- [ ] **Step 6: Materialize only returned descriptors.**

Replace `derive_directory_page` with:

```rust
fn derive_directory_page(
    inputs: DirectoryInputs<'_>,
    q: &DirQuery,
) -> Result<Value, String> {
    let limit = q
        .limit
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS);
    let cursor = q.cursor.as_deref().map(decode_cursor).transpose()?;
    let candidates = build_directory_candidates(
        inputs.indexed,
        inputs.overrides,
        inputs.identities,
    );
    let revision = candidates
        .iter()
        .map(|candidate| candidate.order_key().last_activity_at)
        .chain(inputs.identities.iter().map(|identity| identity.updated_at))
        .max()
        .unwrap_or(0)
        .max(0);
    let selected = select_page_candidates(candidates, q, cursor.as_ref(), limit);
    let has_more = selected.rows.len() > limit;
    let next_cursor = has_more.then(|| {
        let tail = selected.rows[limit - 1].candidate.order_key();
        encode_cursor(tail.last_activity_at, tail.key)
    });
    let items = selected
        .rows
        .iter()
        .take(limit)
        .map(|selected| {
            materialize_selected_candidate(selected, inputs.metadata).to_value()
        })
        .collect::<Vec<_>>();
    let mut page = json!({
        "items": items,
        "nextCursor": next_cursor,
        "revision": revision,
    });
    if selected.partial {
        page["partial"] = Value::Bool(true);
        if let Some(reason) = selected.partial_reason {
            page["partialReason"] = Value::String(reason.to_string());
        }
    }
    Ok(page)
}
```

- [ ] **Step 7: Run 25 page-bound tests, deep edges, focused family, and server all-targets GREEN.**

```bash
run_logged task7-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
for test_name in \
  tier_user_messages_matches_only_the_user_turn \
  tier_full_text_matches_assistant_turn_too \
  tier_search_is_case_insensitive \
  tier_search_empty_no_match_returns_empty_items_without_partial \
  tier_search_combined_with_cursor_pagination \
  tier_search_reports_partial_budget_when_scan_budget_exceeded \
  title_tier_search_matches_a_renamed_sessions_override_title \
  tier_search_reports_io_error_for_missing_source_file \
  tier_search_budget_overwrites_prior_io_error \
  tier_search_budget_is_checked_before_no_source_tail
do
  run_logged "task7-deep-$test_name" \
    env CARGO_TERM_COLOR=never \
    cargo test --manifest-path "$MANIFEST" \
      -p freshell-server --bin freshell-server \
      "session_directory::tests::$test_name" -- \
      --exact --color=never --test-threads=1
done
run_logged task7-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
run_logged task7-server-all-targets \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --all-targets
```

Expected GREEN: page-bound module reports `25 passed; 0 failed; 0 ignored; 0 measured`; each of the ten named deep/title exact filters reports `1 passed`; focused and all-target suites have positive counts and zero failures.

- [ ] **Step 8: Commit only the source file.**

```bash
git -C "$WT" diff --check
git -C "$WT" add -- "$SOURCE_REL"
test "$(git -C "$WT" diff --cached --name-only)" = "$SOURCE_REL"
git -C "$WT" commit \
  -m "perf(session-directory): materialize only returned rows" \
  -m "Retain descriptor-only lookahead, materialize and decorate at most the returned limit, and prove exact indexed, synthesized, filtered, hidden, and sparse-search work." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)" \
  -m "Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Gate 8: Final Verification, Exact Scope, and Unrelated-Failure Evidence

**Files:**
- Modify: none
- Read only: repository, manifests, tests, and coordinator status
- Generated evidence: `$LOG_ROOT/**`

**Interfaces:**

```text
Relevant focused gate = must be GREEN
Broad gate = GREEN or exact matching unchanged-BASE_SHA evidence for unrelated failure
Final committed path set = plan + session_directory.rs
Final working state = clean
Manifest/config scope = no diff from BASE_SHA
```

- [ ] **Step 1: Run final focused tests.**

```bash
run_logged final-page-bound \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    'session_directory::page_bound_tests' -- \
    --color=never --test-threads=1
run_logged final-session-directory \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --bin freshell-server \
    session_directory -- --color=never --test-threads=1
```

Required GREEN: exactly 25 page-bound tests pass; focused family has positive count and zero failures. Stop on any failure.

- [ ] **Step 2: Run full server and read-only sessions sanity.**

```bash
run_logged final-server-all-targets \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-server --all-targets
run_logged final-sessions-read-only \
  env CARGO_TERM_COLOR=never \
  cargo test --manifest-path "$MANIFEST" \
    -p freshell-sessions
```

Expected GREEN: all summaries report zero failures. Never edit `freshell-sessions` to address a failure.

- [ ] **Step 3: Run formatting and all warnings-denied Clippy gates.**

```bash
run_logged final-fmt \
  cargo fmt --manifest-path "$MANIFEST" --all --check
run_logged final-clippy-workspace \
  cargo clippy --manifest-path "$MANIFEST" \
    --workspace --all-targets -- -D warnings
run_logged final-clippy-codex-real \
  cargo clippy --manifest-path "$MANIFEST" \
    -p freshell-codex --features real-transport --all-targets -- -D warnings
run_logged final-clippy-opencode-real \
  cargo clippy --manifest-path "$MANIFEST" \
    -p freshell-opencode --features real-transport --all-targets -- -D warnings
run_logged final-clippy-all-features \
  cargo clippy --manifest-path "$MANIFEST" \
    --workspace --all-targets --all-features -- -D warnings
```

Expected GREEN: every command exits 0 with no warning diagnostics. If a source-only formatting or lint correction is needed, return to the responsible TDD task, commit only `session_directory.rs`, and restart Gate 8.

- [ ] **Step 4: Run coordinator status and repository `check`.**

```bash
run_logged final-status-before-check npm --prefix "$WT" run test:status
set +e
FRESHELL_TEST_SUMMARY='session-directory page-bound npm check' \
  npm --prefix "$WT" run check 2>&1 | tee "$LOG_ROOT/final-npm-check.log"
FINAL_CHECK_STATUS=${PIPESTATUS[0]}
printf 'exit_code=%s\n' "$FINAL_CHECK_STATUS" \
  | tee "$LOG_ROOT/final-npm-check.exit"
set -e
```

Normal GREEN: typecheck and coordinated client/server/Electron suites succeed with positive counts.

- [ ] **Step 5: Run the canonical full `npm test` separately.**

```bash
run_logged final-status-before-test npm --prefix "$WT" run test:status
set +e
FRESHELL_TEST_SUMMARY='session-directory page-bound final validation' \
  npm --prefix "$WT" test 2>&1 | tee "$LOG_ROOT/final-npm-test.log"
FINAL_NPM_STATUS=${PIPESTATUS[0]}
printf 'exit_code=%s\n' "$FINAL_NPM_STATUS" \
  | tee "$LOG_ROOT/final-npm-test.exit"
set -e
run_logged final-status-after-test npm --prefix "$WT" run test:status
```

Normal GREEN: all suite exits are `code: 0`, test counts are positive, command exits 0, and final status records success.

- [ ] **Step 6: For any broad failure, execute exact unchanged-BASE_SHA comparison before classification.**

This protocol applies to a failing full server, read-only sessions, Clippy, `npm run check`, or canonical `npm test` only after relevant focused tests are GREEN. It never waives a focused session-directory failure.

```bash
BASE_WT=$(mktemp -d /tmp/freshell-session-directory-origin.XXXXXXXX)
git -C "$WT" worktree add --detach "$BASE_WT" "$BASE_SHA" \
  2>&1 | tee "$LOG_ROOT/unrelated-baseline-worktree-add.log"
test -z "$(git -C "$BASE_WT" status --porcelain=v1 --untracked-files=all)"
printf 'base_worktree=%s\n' "$BASE_WT" \
  | tee "$LOG_ROOT/unrelated-baseline-worktree.txt"
```

Rerun the exact failing command with the same toolchain, backend, environment, coordinator policy, and command arguments, changing only `$WT`/`$MANIFEST` to `$BASE_WT`/`$BASE_WT/Cargo.toml`. Use distinct external target directories for Rust comparisons. Capture command text, full stdout/stderr, actual command exit code, failing test names, and stable markers for both candidate and base.

Classification rules:

```text
BASE_SHA passes, candidate fails -> candidate regression; final acceptance fails
Both fail with different names/signatures -> not unrelated; final acceptance fails
Both fail identically -> record matching_unrelated_BASE_SHA_failure and do not edit unrelated code
Coordinator never executes tests -> infrastructure/coordination failure, not application evidence
```

After evidence:

```bash
test -z "$(git -C "$BASE_WT" status --porcelain=v1 --untracked-files=all)"
git -C "$WT" worktree remove "$BASE_WT"
```

- [ ] **Step 7: Prove no manifest or Kata drift.**

```bash
git -C "$WT" diff --exit-code "$BASE_SHA" HEAD -- \
  Cargo.toml .kata.toml 'crates/*/Cargo.toml'
```

Expected: no output and exit 0.

- [ ] **Step 8: Prove final committed scope is exactly plan plus implementation file.**

```bash
printf '%s\n' "$PLAN_REL" "$SOURCE_REL" | sort \
  >"$LOG_ROOT/expected-final-paths.txt"
git -C "$WT" diff --name-only "$BASE_SHA" HEAD | sort \
  >"$LOG_ROOT/actual-final-paths.txt"
diff -u "$LOG_ROOT/expected-final-paths.txt" \
  "$LOG_ROOT/actual-final-paths.txt"
```

Expected exact paths:

```text
crates/freshell-server/src/session_directory.rs
docs/plans/2026-08-13-session-directory-page-prep.md
```

- [ ] **Step 9: Prove the final worktree is clean and task commits staged only source.**

```bash
test -z "$(git -C "$WT" status --porcelain=v1 --untracked-files=all)"
git -C "$WT" log --format='%H %s' --reverse "$BASE_SHA"..HEAD \
  | tee "$LOG_ROOT/final-commits.txt"
```

Review every implementation commit with:

```bash
for commit in $(git -C "$WT" rev-list --reverse "$BASE_SHA"..HEAD); do
  subject=$(git -C "$WT" show -s --format=%s "$commit")
  if [[ "$subject" == test\(session-directory\):* \
     || "$subject" == refactor\(session-directory\):* \
     || "$subject" == perf\(session-directory\):* ]]; then
    test "$(git -C "$WT" diff-tree --no-commit-id --name-only -r "$commit")" = "$SOURCE_REL"
  fi
done
```

Expected: clean status and every implementation task commit contains only `session_directory.rs`.

## Completion Criteria

The branch is ready for user review only when all statements are evidenced:

1. Gate 0 began clean with the plan already committed, `BASE_SHA` ancestral, and no application change from `BASE_SHA`.
2. The 15 pre-refactor page-bound characterizations were GREEN before production restructuring.
3. Empty cursor keys, deep I/O errors, I/O-to-budget overwrite, budget-before-ineligible-tail, stable duplicate order, and strict duplicate cursor gap are explicitly pinned.
4. The final `page_bound_tests` inventory is exactly 25 passing tests.
5. One borrowed candidate pipeline serves no-search, title, user-message, and full-text tiers.
6. The old full-item override/metadata/live/query/search functions, `FileSearchOutcome`, `DirItem::key`, obsolete `DirItem` internal fields, duplicate display helper, and stale rustdoc are absent; `item_from_meta` has no obsolete source-file parameter and exactly three corrected calls.
7. The one surviving `provider_display_name(&str) -> &str` is used by candidate title search and synth materialization.
8. One captured `Arc<Vec<IndexedSession>>` remains alive while indexed rows are borrowed; no second snapshot is taken.
9. Shallow candidates cover the full post-override/post-live corpus and are stably sorted by current Rust recency/full-key order.
10. Exact-pair running winner and full-key collision synth winner are deterministic over an explicitly sorted captured identity vector.
11. Visibility, strict cursor handling, title precedence, and deep-search traversal have one implementation.
12. Deep search checks `rows > limit`, then budget, then source/provider, then increments and performs I/O; `matched_in` converts correctly to `String`.
13. Revision remains the max of post-override/post-live candidate activity and every captured identity update before visibility/cursor/search.
14. The page retains at most `limit + 1` descriptors and fully prepares at most `limit` returned rows.
15. Exact ledger counts pass for indexed, synthesized, long filtered/cursor, all-hidden, and sparse title-search corpora; lookahead has zero full-preparation cost.
16. All 28 unique direct-helper tests/29 obligations, seven transitive override tests, and the display-helper test are migrated without an old-policy or full-item adapter.
17. The nine named route tests remain unchanged and GREEN.
18. All-page union, limits, order ties, archived recency, response fields/omissions, exact `DirItem::to_value` insertion order, project colors, validation, metadata, no-index, override-refresh, and absence of totals match current Rust behavior.
19. Focused session-directory tests are GREEN. Every broad gate is GREEN or has exact matching unchanged-`BASE_SHA` evidence for a genuinely unrelated failure; unrelated code was not edited.
20. Final `BASE_SHA..HEAD` contains exactly the committed plan and `crates/freshell-server/src/session_directory.rs`; every implementation task commit stages only the source file; the worktree is clean.
21. No Cargo manifest, `.kata.toml`, README, schema, Node, client, browser, WS, sessions/index/search, refresh/sweep, fixture, or project-setting file changed.
22. No release A/B benchmark or temporary manifest edit was performed, and no PR was opened without user approval.
