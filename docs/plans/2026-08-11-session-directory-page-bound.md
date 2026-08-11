# Page-Bounded Session Directory Requests — Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Bound the per-request work of `GET /api/session-directory` to the page
being returned (default/max 50 items) instead of the full ~28,000-session corpus,
with ZERO observable behavior change (byte-identical JSON responses).

**Architecture:** The handler's five full-corpus passes (convert, overrides,
metadata, live-join, apply_query) are replaced — for no-query and title-tier-query
requests — by a lazy walk over the pre-sorted `SessionIndex` snapshot that applies
cheap, borrowed, allocation-free order/filter/search predicates per candidate row
and performs full decoration (String clones, override overlay, metadata join,
live-terminal join, search annotation) only on the ≤ `limit+1` rows that survive.
The legacy full-materialization pipeline is retained verbatim as `materialized_page`
— it stays the production path for the already-bounded `userMessages`/`fullText`
file-search tiers and serves as the differential-test oracle proving byte-identical
output.

**Tech Stack:** Rust (axum handler in `crates/freshell-server`), serde_json with
`preserve_order`, existing `freshell-sessions::SessionIndex` snapshot (untouched).

## Global Constraints

- **Zero observable behavior change.** Same items, same order, same search
  results, same `revision`, same `nextCursor`, same key presence/absence and key
  ordering, byte-for-byte. The TypeScript client (`src/lib/api.ts`
  `getSessionDirectoryPage`, `src/store/sessionsThunks.ts`) must need no changes.
- **Wire page shape (do not change):** `items` (array), `nextCursor`
  (string | null), `revision` (i64 ≥ 0), optional `partial: true`, optional
  `partialReason` (`"budget"` | `"io_error"`), optional `projectColors` (object,
  only when non-empty). No total counts, no hasMore, no offset exist on the wire.
- **Wire item key insertion order (do not change):** `sessionId`, `provider`,
  `projectPath`, `lastActivityAt`, `isRunning`, `archived`, then optionals in
  `DirItem::to_value` order (title, summary, firstUserMessage, createdAt, cwd,
  isSubagent, isNonInteractive, matchedIn, snippet, runningTerminalId,
  liveTerminalOnly, sessionType). `serde_json` has `preserve_order` enabled
  workspace-wide (root `Cargo.toml:33`), so insertion order IS wire order.
- **Scope:** only `crates/freshell-server/src/session_directory.rs` changes.
  Do NOT touch `crates/freshell-sessions/src/directory_index.rs` (TTL, sweeps,
  sorting), the TS client, polling behavior, or `.kata.toml`.
- **`MAX_DIRECTORY_PAGE_ITEMS = 50`** stays; `limit = q.limit.unwrap_or(50).min(50)`.
- **No new dependencies.** `rand`, `proptest`, `criterion` are NOT available in
  this workspace; deterministic test randomness uses a hand-rolled xorshift.
- **Toolchain / validation:** Rust 1.96.0. `cargo fmt --all` (no rustfmt.toml —
  defaults), `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test -p freshell-server --all-targets` (baseline on main:
  654 passed; 0 failed; 1 ignored).
- **Pre-existing failures:** 68 known workspace test failures in UNRELATED crates
  (`freshell-freshagent` missing a tsx dependency; `freshell-ws` integration
  timeouts) reproduce at the fork commit. Do not fix them; do not cause NEW
  failures. Validate with `-p freshell-server` scoping.
- Red-Green-Refactor TDD per `AGENTS.md`. Never skip the failing-test step.
- Do not create a PR, do not restart the port-3001 server, do not modify
  `.kata.toml`. `README.md` untouched (this plan file is a working/agent doc).

---

## Background: how the current pipeline works (verified on main @ fc8646477)

All line numbers refer to `crates/freshell-server/src/session_directory.rs`
unless stated otherwise.

The handler `session_directory` (381-455) runs, per request:

1. **406-414** — `state.session_index.snapshot().await` returns
   `Arc<Vec<IndexedSession>>`, **pre-sorted** `last_activity_at` DESC then
   `key()` (= `"{provider}:{session_id}"`) DESC. The sort happens once per index
   sweep (`crates/freshell-sessions/src/directory_index.rs:1418-1422`), pinned by
   the test `snapshot_is_sorted_last_activity_desc_then_key_desc`
   (`directory_index.rs:1776`). Every snapshot row is then converted via
   `dir_item_from_indexed` (560-583) — **9 heap clones per item × N ≈ 28,000**.
2. **415** — `apply_session_overrides` (740-778): O(N) filter_map keyed by
   `item.key()` (one String alloc per item). Removes `deleted: true` rows
   (749-751); overlays `title` (767, guarded), `summary` (771), `archived` (773).
3. **424** — `apply_session_metadata` (786-804): O(N), sets `session_type` only.
4. **430-431** — `state.identity.list()` (live terminals, small count T) then
   `join_live_terminals` (911-938): O(N·T) `find` per item setting
   `is_running`/`running_terminal_id`, plus an **N-entry `HashSet<String>`**
   (923-924) used only to dedupe ≤ T synthesized live-only rows, which are
   appended at the tail (935) and rely on the later sort to land in order.
5. **432** — `apply_query` (1175-1294): `revision` = max over ALL items'
   `last_activity_at` chained with all identities' `updated_at`, `.max(0)`
   (1196-1202, computed after the deleted-drop, before sort/filters/search);
   full O(N log N) re-sort (1207-1211, documented idempotent guard — the snapshot
   is already sorted by the identical comparator, and `key()` allocates twice per
   comparison); three retains — `!is_subagent` (1215), `!is_non_interactive`
   (1218), `is_running || title.trim() non-empty` (1221-1227); cursor retain
   (1231-1236); title-tier search `apply_title_search` (1374-1391 — recomputes
   `needle.to_lowercase()` per item, clones all 3 candidate fields eagerly, calls
   `.to_lowercase()` per field); file tiers go through `apply_file_search`
   (1317-1368) which is **already bounded** (`max_scan = limit * 10`, early
   break); finally `has_more = items.len() > limit`, `take(limit)`,
   `next_cursor = encode_cursor(items[limit-1])` (1267-1276).

Observed cost: 80-130 ms per request at ~25-35 requests/min.

### Which decorated fields feed ordering/filtering/search (the correctness traps)

Evidence table (proof line refs in parentheses):

| Consumer | Field | Mutable by decoration? |
|---|---|---|
| sort comparator (1207-1211) | `last_activity_at`, `provider`, `session_id` | **NO** — no decorator assigns any of them on an existing item (overrides touch only 767/771/773; metadata only 799; join only 854-859) |
| sort — set membership | — | **YES**: `deleted` overrides remove rows (749-751); `join_live_terminals` appends synthesized rows (926-936) whose `last_activity_at = identity.updated_at` (888) can sort anywhere |
| retain `!is_subagent` (1215) | `is_subagent` | NO for existing rows (synthesized rows carry their own, 894) |
| retain `!is_non_interactive` (1218) | `is_non_interactive` | NO (synthesized = false, 895) |
| retain empty-filter (1221-1227) | `is_running` | **YES** (854/858; synthesized true at 896) |
| retain empty-filter | `title` | **YES** (override 767, guarded; synthesized 885) |
| title search (1374-1391) | `title`, `summary` | **YES** (767, 771) — pinned by test `title_tier_search_matches_a_renamed_sessions_override_title` (3308) |
| title search | `first_user_message` | NO |
| revision (1196-1202) | `last_activity_at` of all post-override items + all `identities[].updated_at` | set membership only (deleted rows already dropped; synthesized rows' timestamps are identity `updated_at`, already in the chain) |
| `archived` (773), `session_type` (799), `running_terminal_id` (855/859), `matchedIn`/`snippet` | — | serialization-only — safe to apply page-only |

**Consequences the design must honor (trap 1):**
1. `deleted` overrides must be skipped **during** the walk or the page under-fills.
2. `titleOverride` can make an untitled row visible under the default empty
   filter, and can change what a title-tier search matches (it REPLACES the
   title — the original text must stop matching).
3. The live join can flip `is_running` (making an empty row visible) and can add
   wholly new synthesized rows that must be **merged in sorted position**, not
   appended.
4. Because the sort keys are decoration-immutable and the snapshot is pre-sorted
   by the identical comparator, the per-request sort can be dropped for existing
   rows — only the ≤ T synthesized rows need order-merging.

**Trap 2 (search):** when `query` is present the match decision must still
consider every candidate row (in sorted order) until `limit+1` matches are
found — worst case O(N), but with borrowed, allocation-free comparisons.
Stopping at `limit+1` matches is output-identical: matches beyond that cannot
change `items`, `nextCursor` (derived from match `limit-1`), or the
has-more decision (`len > limit`).

**Trap 3 (revision):** legacy revision = `max(0, max last_activity_at over
non-deleted rows ∪ synthesized rows, max identities.updated_at)`. Synthesized
rows' timestamps equal their identity's `updated_at`, which the identities chain
already covers; the snapshot is sorted DESC by `last_activity_at`, so the items'
max is the **first non-deleted row**. Fast-path formula:
`max(0, first-non-deleted-row.last_activity_at (if any), max identities.updated_at)`
— an O(deleted-prefix) head scan, not a full pass.

**Trap 4 (synthesized-row dedupe):** legacy dedupes synthesized rows against the
key set of **non-deleted** rows (the HashSet at 923-924 is built after the
deleted-drop). So a deleted session with a live terminal DOES get a synthesized
replacement row. Also note dedupe compares full `"{provider}:{session_id}"`
**strings** — the fast path replicates string comparison (via `key_cmp`) rather
than tuple comparison so that even pathological colon-containing IDs behave
identically.

### File-search tiers stay on the legacy path

`userMessages`/`fullText` tiers already bound their transcript scanning
(`max_scan = limit*10`, early break, `partial: "budget"`). They keep using the
retained legacy pipeline (`materialized_page`) unchanged — same code, so
behavior is identical by construction. The hot paths this plan bounds are the
sidebar snapshot (no query) and title-tier search, which are the 25-35×/min
requests.

---

## File Structure

Only one production file changes. The repo convention is large single-file
modules with `#[cfg(test)]` child modules (this file is already 3,354 lines);
follow it — do not split the file.

- **Modify:** `crates/freshell-server/src/session_directory.rs`
  - Handler `session_directory` (381-455): delegate the pipeline to
    `build_directory_page` (Task 1).
  - New private fns (production): `build_directory_page` (dispatch),
    `materialized_page` (legacy pipeline, extracted verbatim — file tiers +
    test oracle), `fast_path_page` (the page-bounded walk, Tasks 5-6),
    `synthesized_candidates`, `is_deleted`, `effective_title`,
    `effective_summary`, `title_tier_matches`, `contains_ci`, `key_cmp`.
  - New `#[cfg(test)]` thread-local `DIR_ITEM_CONVERSIONS` counter incremented
    in `dir_item_from_indexed` (Task 5).
  - New `#[cfg(test)] mod page_bound_tests` (after the existing `mod tests`):
    helpers + characterization + trap-1 + differential + perf-evidence tests.
- **Untouched:** `crates/freshell-sessions/src/directory_index.rs`,
  `src/lib/api.ts`, `src/store/sessionsThunks.ts`, `shared/read-models.ts`,
  `.kata.toml`, all other crates.

Existing private helpers reachable from child test modules via `use super::*;`:
`DirItem`, `DirQuery`, `Tier`, `apply_query`, `apply_session_overrides`,
`apply_session_metadata`, `join_live_terminals`, `join_running_state`,
`build_live_terminal_session_item`, `dir_item_from_indexed`, `encode_cursor`,
`decode_cursor`, `apply_title_search`, `provider_display_name`.

Key struct facts test code relies on (verified):
- `IndexedSession` (`directory_index.rs:52-117`): all 15 fields `pub`, no
  `Default` — literals name every field. Fields: `session_id: String`,
  `provider: String`, `project_path: String`, `title: Option<String>`,
  `title_provider_generated: bool`, `summary: Option<String>`,
  `first_user_message: Option<String>`, `title_source: Option<String>`,
  `last_activity_at: i64`, `created_at: Option<i64>`, `cwd: Option<String>`,
  `git_branch: Option<String>`, `is_subagent: bool`, `is_non_interactive: bool`,
  `source_file: Option<PathBuf>`.
- `TerminalIdentity` (`crates/freshell-ws/src/identity.rs:30-66`) has a PRIVATE
  field — **struct literals do not compile** from freshell-server. Build via
  `TerminalIdentityRegistry::new()` →
  `reg.upsert(terminal_id, Some(provider), Some(session_id), cwd, updated_at)` →
  `reg.list()`; mutate public fields (e.g. `is_subagent`) on the returned clones.
  `list()` excludes retired entries; its order is HashMap order
  (non-deterministic) — tests must not depend on multi-identity ordering.
- Pure in-memory tests must NOT take `HOME_ENV_TEST_LOCK` (it only guards env
  mutation; `mod join_tests` precedent).

## Requirement → Task coverage map

| Spec requirement | Covered by |
|---|---|
| Characterization tests first, green on OLD code | Tasks 1-3 (written against the extracted-but-legacy `build_directory_page`) |
| Page-boundary regression test encoding trap 1 | Task 3 |
| Bound no-query request work to the page | Task 5 (walk + counter-bounded RED test) |
| Search covers entire corpus with reduced constant cost | Task 6 (`contains_ci` from Task 4; hoisted needle; conversions bounded by matches) |
| `revision` + wire format byte-compatible | Task 1 byte-shape test; Task 2 revision tests; Task 7 byte-wise differential vs legacy oracle |
| No TTL/sweep/client changes | Global Constraints (no task touches them) |
| Non-flaky perf evidence | Task 5/6 deterministic conversion-counter tests + Task 7 `#[ignore]` timing test (prints, doesn't assert wall-clock) |
| fmt + clippy -D warnings + crate tests green | Every task's final steps + Task 7 validation sweep |

---

### Task 1: Extract `build_directory_page` seam from the handler

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs` (handler at 381-455;
  new fns after `dir_item_from_indexed`, i.e. after line ~583; new test module
  at end of file)

**Interfaces:**
- Consumes: existing private fns `dir_item_from_indexed`,
  `apply_session_overrides`, `apply_session_metadata`, `join_live_terminals`,
  `apply_query`; `SessionDirectoryState` fields.
- Produces (later tasks rely on these exact signatures):
  ```rust
  fn build_directory_page(
      indexed: &[IndexedSession],
      overrides: &Map<String, Value>,
      metadata: &std::collections::HashMap<String, Value>,
      identities: &[freshell_ws::identity::TerminalIdentity],
      q: &DirQuery,
  ) -> Result<Value, String>

  fn materialized_page(
      indexed: &[IndexedSession],
      overrides: &Map<String, Value>,
      metadata: &std::collections::HashMap<String, Value>,
      identities: &[freshell_ws::identity::TerminalIdentity],
      q: &DirQuery,
  ) -> Result<Value, String>
  ```
  Test module `page_bound_tests` with helpers:
  `idx(provider: &str, sid: &str, last: i64, title: Option<&str>) -> IndexedSession`,
  `ov_map(entries: &[(&str, Value)]) -> Map<String, Value>`,
  `no_meta() -> std::collections::HashMap<String, Value>`,
  `no_idents() -> Vec<freshell_ws::identity::TerminalIdentity>`,
  `page(...) -> Value` (expect-wrapper over `build_directory_page`),
  `item_ids(page: &Value) -> Vec<String>`.

- [ ] **Step 1: Write the failing test**

Add at the very end of `crates/freshell-server/src/session_directory.rs`
(after the closing brace of `mod tests`, i.e. after the current last line):

```rust
#[cfg(test)]
mod page_bound_tests {
    use super::*;
    use freshell_ws::identity::TerminalIdentityRegistry;
    use std::collections::HashMap;

    /// In-memory `IndexedSession` with the shape the index sweep produces:
    /// titled, interactive, non-subagent. Tests mutate fields per case.
    fn idx(provider: &str, sid: &str, last: i64, title: Option<&str>) -> IndexedSession {
        IndexedSession {
            session_id: sid.to_string(),
            provider: provider.to_string(),
            project_path: "/repo".to_string(),
            title: title.map(str::to_string),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            title_source: None,
            last_activity_at: last,
            created_at: Some(last),
            cwd: Some("/repo".to_string()),
            git_branch: None,
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    fn ov_map(entries: &[(&str, Value)]) -> Map<String, Value> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect()
    }

    fn no_meta() -> HashMap<String, Value> {
        HashMap::new()
    }

    fn no_idents() -> Vec<freshell_ws::identity::TerminalIdentity> {
        Vec::new()
    }

    fn page(
        indexed: &[IndexedSession],
        overrides: &Map<String, Value>,
        metadata: &HashMap<String, Value>,
        identities: &[freshell_ws::identity::TerminalIdentity],
        q: &DirQuery,
    ) -> Value {
        build_directory_page(indexed, overrides, metadata, identities, q).expect("valid page")
    }

    fn item_ids(page: &Value) -> Vec<String> {
        page["items"]
            .as_array()
            .expect("items array")
            .iter()
            .map(|i| i["sessionId"].as_str().expect("sessionId").to_string())
            .collect()
    }

    /// The seam must reproduce the handler pipeline byte-for-byte:
    /// convert -> overrides -> metadata -> live-join -> apply_query.
    /// (serde_json has preserve_order on, so to_string pins key order.)
    #[test]
    fn build_directory_page_mirrors_the_handler_pipeline_bytewise() {
        let indexed = vec![
            idx("claude", "s-1", 2_000, Some("Newest")),
            idx("claude", "s-0", 1_000, None),
        ];
        let overrides = ov_map(&[("claude:s-0", json!({ "titleOverride": "Renamed" }))]);
        let meta = no_meta();
        let idents = no_idents();
        let q = DirQuery::default();
        let got = build_directory_page(&indexed, &overrides, &meta, &idents, &q).expect("page");
        let expected = json!({
            "items": [
                {
                    "sessionId": "s-1",
                    "provider": "claude",
                    "projectPath": "/repo",
                    "lastActivityAt": 2000,
                    "isRunning": false,
                    "archived": false,
                    "title": "Newest",
                    "createdAt": 2000,
                    "cwd": "/repo"
                },
                {
                    "sessionId": "s-0",
                    "provider": "claude",
                    "projectPath": "/repo",
                    "lastActivityAt": 1000,
                    "isRunning": false,
                    "archived": false,
                    "title": "Renamed",
                    "createdAt": 1000,
                    "cwd": "/repo"
                }
            ],
            "nextCursor": null,
            "revision": 2000,
        });
        assert_eq!(
            serde_json::to_string(&got).unwrap(),
            serde_json::to_string(&expected).unwrap(),
            "byte-identical wire shape"
        );
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/session-directory-page-bound
cargo test -p freshell-server page_bound_tests 2>&1 | tail -20
```
Expected: FAIL to compile with `error[E0425]: cannot find function
'build_directory_page' in this scope`.

- [ ] **Step 3: Write minimal implementation**

Insert immediately after the closing brace of `dir_item_from_indexed`
(search for `fn dir_item_from_indexed`; its body ends `}` after
`source_file: idx.source_file.clone(),` + two lines):

```rust
/// The full session-directory page derivation: everything between reading the
/// snapshot and attaching `projectColors`. One entry point so tests can pin
/// the exact wire bytes and the fast path (kata 0gdd slice 1) can be swapped
/// in behind it.
fn build_directory_page(
    indexed: &[IndexedSession],
    overrides: &Map<String, Value>,
    metadata: &std::collections::HashMap<String, Value>,
    identities: &[freshell_ws::identity::TerminalIdentity],
    q: &DirQuery,
) -> Result<Value, String> {
    materialized_page(indexed, overrides, metadata, identities, q)
}

/// The original full-materialization pipeline (handler lines 406-432 before
/// this refactor), kept verbatim: still the production path for the
/// `userMessages`/`fullText` file-search tiers (already bounded by
/// `apply_file_search`'s `max_scan`) and the byte-identity oracle for the
/// page-bound fast path's differential tests.
fn materialized_page(
    indexed: &[IndexedSession],
    overrides: &Map<String, Value>,
    metadata: &std::collections::HashMap<String, Value>,
    identities: &[freshell_ws::identity::TerminalIdentity],
    q: &DirQuery,
) -> Result<Value, String> {
    let items: Vec<DirItem> = indexed.iter().map(dir_item_from_indexed).collect();
    let items = apply_session_overrides(items, overrides);
    // Task 20: `sessionType` read-join, ordered after the overrides overlay
    // and before the live-terminal join (see the original handler comments).
    let items = apply_session_metadata(items, metadata);
    let items = join_live_terminals(items, identities);
    apply_query(items, q, identities)
}
```

Then replace the handler body between the `validate_query` match (ends at line
~400) and the `match apply_query(...)` arm. The current code:

```rust
    let items: Vec<DirItem> = match &state.session_index {
        Some(index) => index
            .snapshot()
            .await
            .iter()
            .map(dir_item_from_indexed)
            .collect(),
        None => Vec::new(),
    };
    let items = apply_session_overrides(items, &state.settings.session_overrides());
    let items = apply_session_metadata(items, &state.metadata.get_all().await);
    let identities = state.identity.list();
    let items = join_live_terminals(items, &identities);
    match apply_query(items, &query, &identities) {
```

becomes (keep the existing explanatory comments at 401-405/416-423/425-429 by
moving them onto `materialized_page`/these lines as appropriate):

```rust
    // Batch B: read the cached, pre-sorted snapshot instead of re-walking +
    // re-parsing every provider transcript on every request.
    let snapshot = match &state.session_index {
        Some(index) => Some(index.snapshot().await),
        None => None,
    };
    let indexed: &[IndexedSession] = snapshot.as_deref().map(|v| v.as_slice()).unwrap_or(&[]);
    let overrides = state.settings.session_overrides();
    let metadata = state.metadata.get_all().await;
    let identities = state.identity.list();
    match build_directory_page(indexed, &overrides, &metadata, &identities, &query) {
```

The `Ok(mut page) => { ... projectColors ... }` and `Err(msg) => ...400...`
arms stay exactly as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cargo test -p freshell-server session_directory 2>&1 | tail -5
```
Expected: PASS — all pre-existing `session_directory` tests (including the 9
`#[tokio::test]` router E2Es) plus the new byte-shape test; `0 failed`.

- [ ] **Step 5: Run the full crate suite**

Run: `cargo test -p freshell-server --all-targets 2>&1 | tail -5`
Expected: `0 failed` (655+ passed).

- [ ] **Step 6: Format and commit**

```bash
cargo fmt --all
git add crates/freshell-server/src/session_directory.rs
git commit -m "refactor(session-directory): extract build_directory_page seam from handler"
```

---

### Task 2: Characterization suite pinning current pipeline behavior

These tests pin OLD behavior through the seam (which currently runs the legacy
pipeline). All of them must pass BEFORE any restructuring and stay green
afterward.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
  (inside `mod page_bound_tests`)

**Interfaces:**
- Consumes: Task 1 helpers (`idx`, `ov_map`, `no_meta`, `no_idents`, `page`,
  `item_ids`), `build_directory_page`, `TerminalIdentityRegistry`.
- Produces: test helper `corpus(count: usize) -> Vec<IndexedSession>` used by
  Tasks 3, 5, 6, 7.

- [ ] **Step 1: Add the corpus helper and the characterization tests**

Add inside `mod page_bound_tests` (after `item_ids`):

```rust
    /// `count` titled claude sessions, newest first: `s-000` is the newest
    /// (last_activity_at = 100_000), each subsequent one 10 older. Produced
    /// PRE-SORTED because the production snapshot is guaranteed sorted
    /// (directory_index.rs sorts once per sweep, pinned by
    /// `snapshot_is_sorted_last_activity_desc_then_key_desc`).
    fn corpus(count: usize) -> Vec<IndexedSession> {
        (0..count)
            .map(|n| {
                idx(
                    "claude",
                    &format!("s-{n:03}"),
                    100_000 - (n as i64) * 10,
                    Some(&format!("Session {n}")),
                )
            })
            .collect()
    }

    /// revision = max(lastActivityAt over post-override rows, identities'
    /// updated_at, 0). Deleted rows are dropped BEFORE revision is computed,
    /// so a deleted newest row must not contribute.
    #[test]
    fn revision_excludes_deleted_head_and_includes_identity_updates() {
        let indexed = vec![
            idx("claude", "s-new", 5_000, Some("Newest")),
            idx("claude", "s-old", 4_000, Some("Older")),
        ];
        let overrides = ov_map(&[("claude:s-new", json!({ "deleted": true }))]);
        let p = page(&indexed, &overrides, &no_meta(), &no_idents(), &DirQuery::default());
        assert_eq!(p["revision"], json!(4_000));

        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t1", Some("claude"), Some("s-old"), None, 9_000);
        let p = page(&indexed, &overrides, &no_meta(), &reg.list(), &DirQuery::default());
        assert_eq!(p["revision"], json!(9_000));
    }

    #[test]
    fn revision_is_zero_for_an_empty_directory() {
        let p = page(&[], &Map::new(), &no_meta(), &no_idents(), &DirQuery::default());
        assert_eq!(p["revision"], json!(0));
        assert_eq!(p["nextCursor"], Value::Null);
        assert_eq!(p["items"], json!([]));
    }

    #[test]
    fn default_filters_hide_subagent_non_interactive_and_untitled_rows() {
        let mut indexed = vec![
            idx("claude", "s-sub", 4_000, Some("Subagent")),
            idx("claude", "s-non", 3_000, Some("NonInteractive")),
            idx("claude", "s-untitled", 2_000, None),
            idx("claude", "s-plain", 1_000, Some("Plain")),
        ];
        indexed[0].is_subagent = true;
        indexed[1].is_non_interactive = true;

        let p = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &DirQuery::default());
        assert_eq!(item_ids(&p), vec!["s-plain"]);

        let all = DirQuery {
            include_subagents: true,
            include_non_interactive: true,
            include_empty: true,
            ..DirQuery::default()
        };
        let p = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &all);
        assert_eq!(item_ids(&p), vec!["s-sub", "s-non", "s-untitled", "s-plain"]);
    }

    /// Whitespace-only titles count as empty for the visibility filter.
    #[test]
    fn whitespace_title_counts_as_empty() {
        let indexed = vec![idx("claude", "s-ws", 1_000, Some("   "))];
        let p = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &DirQuery::default());
        assert!(item_ids(&p).is_empty());
    }

    /// Full cursor chain over a decorated 120-row corpus: pages are disjoint,
    /// the chain terminates, membership reflects every decoration effect.
    #[test]
    fn cursor_chain_paginates_decorated_corpus_without_dups_or_gaps() {
        let mut indexed = corpus(120);
        indexed[7].title = None; // filtered (never rescued)
        indexed[63].title = None; // filtered (page-2 territory)
        let overrides = ov_map(&[
            ("claude:s-011", json!({ "deleted": true })),
            ("claude:s-090", json!({ "titleOverride": "Rescue Ninety" })),
        ]);
        let reg = TerminalIdentityRegistry::new();
        // Live-only terminal -> synthesized row landing mid-corpus.
        reg.upsert("t-live", Some("codex"), Some("live-mid"), Some("/w"), 99_365);
        let identities = reg.list();

        let mut q = DirQuery { limit: Some(50), ..DirQuery::default() };
        let mut seen: Vec<String> = Vec::new();
        let mut hops = 0;
        loop {
            let p = page(&indexed, &overrides, &no_meta(), &identities, &q);
            for id in item_ids(&p) {
                assert!(!seen.contains(&id), "duplicate {id} across pages");
                seen.push(id);
            }
            hops += 1;
            match p["nextCursor"].as_str() {
                Some(c) => q.cursor = Some(c.to_string()),
                None => break,
            }
            assert!(hops < 10, "cursor chain must terminate");
        }
        // 120 - 2 untitled - 1 deleted + 1 synthesized = 118 rows in 3 pages.
        assert_eq!(seen.len(), 118);
        assert_eq!(hops, 3);
        assert!(seen.contains(&"live-mid".to_string()));
        assert!(seen.contains(&"s-090".to_string()));
        assert!(!seen.contains(&"s-011".to_string()));
        assert!(!seen.contains(&"s-007".to_string()));
        assert!(!seen.contains(&"s-063".to_string()));
    }

    /// The search sees the OVERRIDE title; the replaced original stops
    /// matching (composition-order pin, cf. test at line 3308).
    #[test]
    fn search_sees_override_title_and_not_the_replaced_original() {
        let indexed = vec![idx("claude", "s-1", 1_000, Some("alpha original"))];
        let overrides = ov_map(&[("claude:s-1", json!({ "titleOverride": "bravo renamed" }))]);

        let hit = DirQuery { query: Some("bravo".into()), ..DirQuery::default() };
        let p = page(&indexed, &overrides, &no_meta(), &no_idents(), &hit);
        assert_eq!(item_ids(&p), vec!["s-1"]);
        assert_eq!(p["items"][0]["matchedIn"], json!("title"));
        assert_eq!(p["items"][0]["snippet"], json!("bravo renamed"));
        assert_eq!(p["items"][0]["title"], json!("bravo renamed"));

        let miss = DirQuery { query: Some("alpha".into()), ..DirQuery::default() };
        let p = page(&indexed, &overrides, &no_meta(), &no_idents(), &miss);
        assert!(item_ids(&p).is_empty(), "replaced original title must not match");
    }

    /// A provider-generated title shadowed by a 'dir' override row keeps the
    /// ORIGINAL title for search and display (the 752-768 guard).
    #[test]
    fn provider_generated_shadow_guard_applies_to_search_and_display() {
        let mut it = idx("claude", "s-pg", 1_000, Some("Provider Title"));
        it.title_source = Some("provider-generated".to_string());
        let indexed = vec![it];
        let overrides = ov_map(&[(
            "claude:s-pg",
            json!({ "titleOverride": "dir-derived", "titleSource": "dir" }),
        )]);
        let q = DirQuery { query: Some("provider".into()), ..DirQuery::default() };
        let p = page(&indexed, &overrides, &no_meta(), &no_idents(), &q);
        assert_eq!(item_ids(&p), vec!["s-pg"]);
        assert_eq!(p["items"][0]["title"], json!("Provider Title"));

        let q = DirQuery { query: Some("dir-derived".into()), ..DirQuery::default() };
        let p = page(&indexed, &overrides, &no_meta(), &no_idents(), &q);
        assert!(item_ids(&p).is_empty(), "shadowed override text must not match");
    }

    #[test]
    fn search_precedence_title_summary_first_message_and_snippet_truncation() {
        let mut a = idx("claude", "s-a", 3_000, Some("shared needle title"));
        a.summary = Some("shared needle summary".to_string());
        let mut b = idx("claude", "s-b", 2_000, Some("no hit here"));
        b.summary = Some("shared needle summary".to_string());
        let mut c = idx("claude", "s-c", 1_000, Some("no hit either"));
        c.first_user_message = Some(format!("shared needle {}", "x".repeat(200)));
        let indexed = vec![a, b, c];

        let q = DirQuery { query: Some("shared needle".into()), ..DirQuery::default() };
        let p = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &q);
        let items = p["items"].as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["matchedIn"], json!("title"));
        assert_eq!(items[1]["matchedIn"], json!("summary"));
        assert_eq!(items[2]["matchedIn"], json!("firstUserMessage"));
        let snippet = items[2]["snippet"].as_str().unwrap();
        assert_eq!(
            snippet.chars().count(),
            140,
            "snippet is the matched field truncated to 140 chars"
        );
    }

    /// Case folding must keep exactly `str::to_lowercase` semantics --
    /// asserted against the oracle expression itself, including non-ASCII.
    #[test]
    fn search_case_insensitivity_matches_the_lowercase_oracle() {
        let titles = ["CAFÉ latte plans", "İstanbul trip", "ΟΔΟΣ ΣΟΦΙΑΣ", "plain ascii TITLE"];
        let queries = ["café", "CAFÉ", "İSTANBUL", "istanbul", "σοφιας", "title"];
        for (n, title) in titles.iter().enumerate() {
            let indexed = vec![idx("claude", &format!("s-{n}"), 1_000, Some(title))];
            for query in queries {
                let q = DirQuery { query: Some(query.to_string()), ..DirQuery::default() };
                let p = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &q);
                let expected = title.to_lowercase().contains(&query.to_lowercase());
                assert_eq!(
                    !item_ids(&p).is_empty(),
                    expected,
                    "title={title:?} query={query:?} must match the to_lowercase oracle"
                );
            }
        }
    }

    /// Trap 4: the synthesized-row dedupe set is built AFTER the deleted
    /// drop, so a deleted session with a live terminal gets a synthesized
    /// replacement row (title = provider display name, running).
    #[test]
    fn deleted_session_with_live_terminal_synthesizes_a_running_row() {
        let indexed = vec![idx("claude", "s-dead", 1_000, Some("Deleted but live"))];
        let overrides = ov_map(&[("claude:s-dead", json!({ "deleted": true }))]);
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("t-9", Some("claude"), Some("s-dead"), Some("/w"), 2_000);
        let p = page(&indexed, &overrides, &no_meta(), &reg.list(), &DirQuery::default());
        let items = p["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "live terminal synthesizes a replacement row");
        assert_eq!(items[0]["sessionId"], json!("s-dead"));
        assert_eq!(items[0]["title"], json!("Claude CLI"));
        assert_eq!(items[0]["isRunning"], json!(true));
        assert_eq!(items[0]["lastActivityAt"], json!(2_000));
        assert_eq!(p["revision"], json!(2_000));
    }

    /// Visibility filters run BEFORE the search: an untitled row whose
    /// firstUserMessage matches stays hidden without includeEmpty.
    #[test]
    fn empty_filter_runs_before_search_hiding_untitled_matches() {
        let mut untitled = idx("claude", "s-u", 2_000, None);
        untitled.first_user_message = Some("findable needle".to_string());
        let indexed = vec![untitled];

        let q = DirQuery { query: Some("findable".into()), ..DirQuery::default() };
        let p = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &q);
        assert!(item_ids(&p).is_empty(), "untitled rows are filtered before the search");

        let q = DirQuery {
            query: Some("findable".into()),
            include_empty: true,
            ..DirQuery::default()
        };
        let p = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &q);
        assert_eq!(item_ids(&p), vec!["s-u"]);
    }

    /// `query` is trimmed before use; whitespace-only means "no search".
    #[test]
    fn whitespace_only_query_is_not_a_search() {
        let indexed = vec![idx("claude", "s-1", 1_000, Some("Anything"))];
        let q = DirQuery { query: Some("   ".into()), ..DirQuery::default() };
        let p = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &q);
        assert_eq!(item_ids(&p), vec!["s-1"]);
        assert!(p["items"][0].get("matchedIn").is_none());
    }

    /// `archived` mirrors the override row (absent field resets to false) and
    /// is ALWAYS emitted; the title/no-query path never reports `partial`.
    #[test]
    fn archived_reflects_override_row_and_is_always_emitted() {
        let indexed = vec![
            idx("claude", "s-arch", 2_000, Some("Archived")),
            idx("claude", "s-row", 1_500, Some("Row without archived")),
            idx("claude", "s-none", 1_000, Some("No override")),
        ];
        let overrides = ov_map(&[
            ("claude:s-arch", json!({ "archived": true })),
            ("claude:s-row", json!({ "titleOverride": "Renamed row" })),
        ]);
        let p = page(&indexed, &overrides, &no_meta(), &no_idents(), &DirQuery::default());
        let items = p["items"].as_array().unwrap();
        assert_eq!(items[0]["archived"], json!(true));
        assert_eq!(
            items[1]["archived"],
            json!(false),
            "override row without archived resets to false"
        );
        assert_eq!(items[2]["archived"], json!(false));
        assert!(p.get("partial").is_none(), "title path never reports partial");
    }

    /// sessionType joins from the metadata store onto page items.
    #[test]
    fn session_type_joins_from_metadata_store() {
        let indexed = vec![idx("claude", "s-typed", 1_000, Some("Typed"))];
        let mut meta = no_meta();
        meta.insert(
            "claude:s-typed".to_string(),
            json!({ "sessionType": "worktree" }),
        );
        let p = page(&indexed, &Map::new(), &meta, &no_idents(), &DirQuery::default());
        assert_eq!(p["items"][0]["sessionType"], json!("worktree"));
    }
```

- [ ] **Step 2: Run the new tests — all must PASS against the legacy pipeline**

Run: `cargo test -p freshell-server page_bound_tests 2>&1 | tail -5`
Expected: PASS, `0 failed`. If any of these fail, the test encodes the CURRENT
behavior wrongly — fix the TEST (do not change production code in this task)
by checking the actual behavior of the legacy helpers.

- [ ] **Step 3: Run the full crate suite**

Run: `cargo test -p freshell-server --all-targets 2>&1 | tail -5`
Expected: `0 failed`.

- [ ] **Step 4: Format and commit**

```bash
cargo fmt --all
git add crates/freshell-server/src/session_directory.rs
git commit -m "test(session-directory): characterize pipeline behavior through build_directory_page"
```

---

### Task 3: Trap-1 page-boundary regression tests

Explicit encodings of the "decoration changes page membership at the boundary"
trap. Green against the legacy pipeline; they are the tripwire for the
restructure.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
  (inside `mod page_bound_tests`)

**Interfaces:**
- Consumes: `corpus`, `page`, `item_ids`, `ov_map`, `no_meta`, `no_idents`,
  `TerminalIdentityRegistry` (all defined in Tasks 1-2).
- Produces: nothing new.

- [ ] **Step 1: Add the three boundary tests**

```rust
    /// Kata 0gdd trap 1(a): a deleted row INSIDE the page pulls the row at
    /// pre-decoration position 51 into the page.
    #[test]
    fn trap1_deleted_override_pulls_boundary_item_into_page() {
        let indexed = corpus(60);
        let overrides = ov_map(&[("claude:s-010", json!({ "deleted": true }))]);
        let q = DirQuery::default(); // limit 50
        let p = page(&indexed, &overrides, &no_meta(), &no_idents(), &q);
        let ids = item_ids(&p);
        assert_eq!(ids.len(), 50);
        assert!(!ids.contains(&"s-010".to_string()), "deleted row must vanish");
        assert!(
            ids.contains(&"s-050".to_string()),
            "row at pre-decoration position 51 must slide into the page"
        );
        assert!(p["nextCursor"].as_str().is_some(), "59 survivors > limit");
    }

    /// Kata 0gdd trap 1(b): a titleOverride rescues an untitled row from the
    /// empty filter, shifting the page boundary back.
    #[test]
    fn trap1_title_override_rescues_untitled_row_into_page() {
        let mut indexed = corpus(60);
        indexed[20].title = None;
        let q = DirQuery::default();

        let without = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &q);
        let ids = item_ids(&without);
        assert!(!ids.contains(&"s-020".to_string()));
        assert!(
            ids.contains(&"s-050".to_string()),
            "50th slot backfilled from beyond the boundary"
        );

        let overrides = ov_map(&[("claude:s-020", json!({ "titleOverride": "Rescued" }))]);
        let with = page(&indexed, &overrides, &no_meta(), &no_idents(), &q);
        let ids = item_ids(&with);
        assert!(ids.contains(&"s-020".to_string()), "override title makes it visible");
        assert!(!ids.contains(&"s-050".to_string()), "page boundary shifts back");
        let rescued = with["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|i| i["sessionId"] == "s-020")
            .unwrap();
        assert_eq!(rescued["title"], json!("Rescued"));
    }

    /// Kata 0gdd trap 1(c): the live join rescues an untitled row via
    /// isRunning AND merges a synthesized live-only row in sorted position
    /// (NOT at the tail).
    #[test]
    fn trap1_live_join_rescues_untitled_row_and_merges_synthesized_row() {
        let mut indexed = corpus(60);
        indexed[30].title = None;
        let reg = TerminalIdentityRegistry::new();
        // Rescues the untitled row at position 31.
        reg.upsert("term-a", Some("claude"), Some("s-030"), None, 42);
        // No matching session row -> synthesized; updated_at places it
        // between s-004 (99_960) and s-005 (99_950).
        reg.upsert("term-b", Some("codex"), Some("live-only"), Some("/w"), 99_955);
        let identities = reg.list();
        let q = DirQuery::default();
        let p = page(&indexed, &Map::new(), &no_meta(), &identities, &q);
        let ids = item_ids(&p);
        assert_eq!(ids.len(), 50);
        assert!(ids.contains(&"s-030".to_string()), "running rescues the untitled row");
        let pos = ids
            .iter()
            .position(|s| s == "live-only")
            .expect("synthesized row present");
        assert_eq!(pos, 5, "synthesized row merges in sorted position, not at the tail");
        let synth = &p["items"].as_array().unwrap()[pos];
        assert_eq!(synth["isRunning"], json!(true));
        assert_eq!(synth["runningTerminalId"], json!("term-b"));
        assert_eq!(synth["title"], json!("Codex CLI"));
    }
```

- [ ] **Step 2: Run — all three must PASS against the legacy pipeline**

Run: `cargo test -p freshell-server trap1 2>&1 | tail -5`
Expected: PASS, `3 passed; 0 failed`.

- [ ] **Step 3: Commit**

```bash
cargo fmt --all
git add crates/freshell-server/src/session_directory.rs
git commit -m "test(session-directory): pin trap-1 page-boundary decoration regressions"
```

---

### Task 4: Zero-alloc comparison helpers (`contains_ci`, `key_cmp`)

Two pure helpers the walk needs, each proven equivalent to the exact expression
the legacy code computes.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
  (helpers next to `apply_title_search`; tests in `mod page_bound_tests`)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 5-6 rely on these exact signatures):
  ```rust
  fn contains_ci(haystack: &str, needle_lower: &str) -> bool
  fn key_cmp(provider: &str, session_id: &str, other: &str) -> std::cmp::Ordering
  ```

- [ ] **Step 1: Write the failing tests**

Add inside `mod page_bound_tests`:

```rust
    /// `contains_ci` must be byte-identical to the legacy expression
    /// `haystack.to_lowercase().contains(&needle_lower)` for every input,
    /// where `needle_lower` is the query's `to_lowercase()`.
    #[test]
    fn contains_ci_matches_the_lowercase_contains_oracle() {
        let cases: &[(&str, &str)] = &[
            ("Fix the Login Bug", "login"),
            ("Fix the Login Bug", "LOGIN"),
            ("Fix the Login Bug", "missing"),
            ("", "x"),
            ("anything", ""),
            ("CAFÉ latte", "café"),
            ("CAFÉ latte", "cafe"),
            ("İstanbul trip", "istanbul"),
            ("İstanbul trip", "İstanbul"),
            ("STRASSE", "straße"),
            ("große Straße", "GROSSE"),
            ("ΟΔΟΣ ΣΟΦΙΑΣ", "οδος"),
            ("ascii haystack", "café"),
            ("mixed CASE with ümlaut", "with ü"),
        ];
        for (haystack, query) in cases {
            let needle = query.to_lowercase();
            assert_eq!(
                contains_ci(haystack, &needle),
                haystack.to_lowercase().contains(&needle),
                "haystack={haystack:?} query={query:?}"
            );
        }
    }

    /// `key_cmp` must order exactly like the allocated
    /// `format!("{provider}:{session_id}")` string comparison the legacy
    /// cursor/sort code performs — including colon-ambiguous ids.
    #[test]
    fn key_cmp_matches_the_format_oracle() {
        let keys = ["claude:s-1", "codex:s-1", "claude:s-10", "a:b:c", "claude:", ":x", "zzz"];
        let pairs = [
            ("claude", "s-1"),
            ("codex", "s-1"),
            ("claude", "s-10"),
            ("a", "b:c"),
            ("a:b", "c"),
        ];
        for (p, s) in pairs {
            let implied = format!("{p}:{s}");
            for k in keys {
                assert_eq!(
                    key_cmp(p, s, k),
                    implied.as_str().cmp(k),
                    "p={p:?} s={s:?} k={k:?}"
                );
            }
        }
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-server page_bound_tests 2>&1 | tail -10`
Expected: FAIL to compile with `error[E0425]: cannot find function
'contains_ci'` (and `key_cmp`).

- [ ] **Step 3: Implement the helpers**

Insert immediately BEFORE `fn apply_title_search` (search for
`fn apply_title_search`):

```rust
/// Case-insensitive containment, byte-identical to the legacy expression
/// `haystack.to_lowercase().contains(needle_lower)`, where `needle_lower`
/// MUST be the `str::to_lowercase()` of the raw query (that output never
/// contains ASCII `A-Z`, which the ASCII fast path relies on).
///
/// Fast path: for a pure-ASCII haystack, `to_lowercase()` maps only `A-Z` to
/// `a-z`, so containment reduces to an ASCII case-insensitive window scan —
/// zero allocation. A needle containing any non-ASCII byte can never match an
/// ASCII haystack (lowercasing ASCII yields ASCII), and the window scan
/// agrees (a non-ASCII byte never equals an ASCII byte case-insensitively).
/// Slow path (non-ASCII haystack): literally the legacy computation.
fn contains_ci(haystack: &str, needle_lower: &str) -> bool {
    if haystack.is_ascii() {
        let h = haystack.as_bytes();
        let n = needle_lower.as_bytes();
        if n.is_empty() {
            return true;
        }
        if n.len() > h.len() {
            return false;
        }
        return h.windows(n.len()).any(|w| w.eq_ignore_ascii_case(n));
    }
    haystack.to_lowercase().contains(needle_lower)
}

/// Compare the implied `"{provider}:{session_id}"` key against `other`
/// exactly like `format!("{provider}:{session_id}").as_str().cmp(other)`
/// (str::cmp is byte-lexicographic) — without allocating. By-value byte
/// iterators, so no borrow-of-temporary issues.
fn key_cmp(provider: &str, session_id: &str, other: &str) -> std::cmp::Ordering {
    provider
        .bytes()
        .chain(std::iter::once(b':'))
        .chain(session_id.bytes())
        .cmp(other.bytes())
}
```

Note: until Task 5 wires them in, `cargo build` (non-test) would flag them as
dead code under `-D warnings`. Prevent that transient failure by adding
`#[cfg_attr(not(test), allow(dead_code))]` on BOTH functions now, and REMOVE
those attributes in Task 5 Step 4 when production code starts calling them.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p freshell-server page_bound_tests 2>&1 | tail -5`
Expected: PASS, `0 failed`.

- [ ] **Step 5: Lint, format, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/session_directory.rs
git commit -m "feat(session-directory): zero-alloc case-insensitive and key comparison helpers"
```

---

### Task 5: Page-bounded fast path for no-query requests

The core restructure. RED test: a deterministic work counter proves DirItem
conversion is bounded by the page, which the legacy pipeline fails (it converts
the whole corpus). GREEN: implement the lazy walk and route no-query requests
to it. Every Task 1-3 test must stay green unchanged.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**
- Consumes: `contains_ci`/`key_cmp` (Task 4 — `key_cmp` used here;
  `contains_ci` used from Task 6), `dir_item_from_indexed`,
  `apply_session_overrides`, `apply_session_metadata`, `join_running_state`,
  `build_live_terminal_session_item`, `encode_cursor`, `decode_cursor`,
  `IndexedSession::key()`, `DirItem::key()`, `MAX_DIRECTORY_PAGE_ITEMS`.
- Produces (Task 6/7 rely on these exact signatures):
  ```rust
  fn fast_path_page(
      indexed: &[IndexedSession],
      overrides: &Map<String, Value>,
      metadata: &std::collections::HashMap<String, Value>,
      identities: &[freshell_ws::identity::TerminalIdentity],
      q: &DirQuery,
  ) -> Result<Value, String>

  fn is_deleted(overrides: &Map<String, Value>, key: &str) -> bool
  fn effective_title<'a>(idx: &'a IndexedSession, ov: Option<&'a Map<String, Value>>) -> Option<&'a str>
  fn synthesized_candidates(
      indexed: &[IndexedSession],
      overrides: &Map<String, Value>,
      identities: &[freshell_ws::identity::TerminalIdentity],
  ) -> Vec<DirItem>
  ```
  Test-only: `thread_local! DIR_ITEM_CONVERSIONS: Cell<usize>` plus test helpers
  `reset_conversions()` / `conversions()` in `mod page_bound_tests`.

- [ ] **Step 1: Add the conversion counter (test-only instrumentation)**

Immediately above `fn dir_item_from_indexed`:

```rust
#[cfg(test)]
thread_local! {
    /// Test-only ledger: how many snapshot rows were converted to `DirItem`
    /// on this thread. The page-bound fast path must keep this bounded by
    /// the page size — never O(corpus). Thread-local so parallel test
    /// threads don't pollute each other.
    pub(crate) static DIR_ITEM_CONVERSIONS: std::cell::Cell<usize> =
        const { std::cell::Cell::new(0) };
}
```

And as the first statement inside `dir_item_from_indexed`'s body:

```rust
    #[cfg(test)]
    DIR_ITEM_CONVERSIONS.with(|c| c.set(c.get() + 1));
```

In `mod page_bound_tests`, add the helpers:

```rust
    fn reset_conversions() {
        DIR_ITEM_CONVERSIONS.with(|c| c.set(0));
    }

    fn conversions() -> usize {
        DIR_ITEM_CONVERSIONS.with(|c| c.get())
    }
```

- [ ] **Step 2: Write the failing (RED) bounded-work test**

```rust
    /// Kata 0gdd slice 1, the actual requirement: with no query, expensive
    /// per-item work (DirItem conversion = 9 heap clones each) must be
    /// bounded by the page, not the corpus. Deterministic — no wall clocks.
    #[test]
    fn no_query_decoration_work_is_bounded_by_the_page() {
        let indexed = corpus(400);
        reset_conversions();
        let q = DirQuery::default();
        let p = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &q);
        assert_eq!(item_ids(&p).len(), 50);
        assert!(p["nextCursor"].as_str().is_some());
        let converted = conversions();
        assert!(
            converted <= 52,
            "expected page-bounded DirItem conversion, got {converted} for a 400-row corpus"
        );
    }
```

- [ ] **Step 3: Run to verify RED**

Run: `cargo test -p freshell-server no_query_decoration_work 2>&1 | tail -10`
Expected: FAIL with the assertion message reporting `got 400` (the legacy
pipeline converts every row).

- [ ] **Step 4: Implement the fast path**

Remove the `#[cfg_attr(not(test), allow(dead_code))]` attributes added in
Task 4. Insert the following AFTER `materialized_page`:

```rust
/// `sessionOverrides[key].deleted == true` — the row-removal check
/// (`apply_session_overrides` lines 749-751), usable without a `DirItem`.
fn is_deleted(overrides: &Map<String, Value>, key: &str) -> bool {
    overrides
        .get(key)
        .and_then(Value::as_object)
        .and_then(|ov| ov.get("deleted"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// The title the visibility filter and title-tier search observe AFTER
/// `apply_session_overrides` would run — MUST mirror its title arm
/// (752-768) exactly, including the provider-generated shadow guard.
fn effective_title<'a>(
    idx: &'a IndexedSession,
    ov: Option<&'a Map<String, Value>>,
) -> Option<&'a str> {
    if let Some(ov) = ov {
        if let Some(t) = ov.get("titleOverride").and_then(Value::as_str) {
            let row_source = ov.get("titleSource").and_then(Value::as_str);
            let provider_generated_shadow = idx.title_source.as_deref()
                == Some("provider-generated")
                && matches!(row_source, Some("dir") | Some("first-message"));
            if !t.is_empty() && !provider_generated_shadow {
                return Some(t);
            }
        }
    }
    idx.title.as_deref()
}

/// The summary the title-tier search observes after the overrides overlay
/// (mirror of `apply_session_overrides` line 770-772: unconditional replace).
fn effective_summary<'a>(
    idx: &'a IndexedSession,
    ov: Option<&'a Map<String, Value>>,
) -> Option<&'a str> {
    if let Some(ov) = ov {
        if let Some(s) = ov.get("summaryOverride").and_then(Value::as_str) {
            return Some(s);
        }
    }
    idx.summary.as_deref()
}

/// The synthesized live-terminal rows `join_live_terminals` (911-938) would
/// append: one per live identity with a provider, deduped first-wins among
/// themselves, minus candidates whose key string already matches a
/// NON-DELETED snapshot row (the legacy dedupe set is built after the
/// deleted-drop). Key comparison is on the full `provider:sessionId` STRING
/// (via `key_cmp`) to match the legacy `HashSet<String>` exactly.
/// Cost: O(candidates) alloc + one cheap early-exit scan of the snapshot.
fn synthesized_candidates(
    indexed: &[IndexedSession],
    overrides: &Map<String, Value>,
    identities: &[freshell_ws::identity::TerminalIdentity],
) -> Vec<DirItem> {
    let mut candidates: Vec<DirItem> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for identity in identities {
        let Some(candidate) = build_live_terminal_session_item(identity) else {
            continue;
        };
        let key = candidate.key();
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        candidates.push(candidate);
    }
    if candidates.is_empty() {
        return candidates;
    }
    let keys: Vec<String> = candidates.iter().map(DirItem::key).collect();
    let mut suppressed = vec![false; candidates.len()];
    let mut remaining = candidates.len();
    'scan: for idx in indexed {
        for (i, key) in keys.iter().enumerate() {
            if !suppressed[i]
                && key_cmp(&idx.provider, &idx.session_id, key) == std::cmp::Ordering::Equal
                && !is_deleted(overrides, key)
            {
                suppressed[i] = true;
                remaining -= 1;
                if remaining == 0 {
                    break 'scan;
                }
            }
        }
    }
    candidates
        .into_iter()
        .zip(suppressed)
        .filter_map(|(c, s)| (!s).then_some(c))
        .collect()
}

/// Kata 0gdd slice 1: the page-bounded derivation for no-query and
/// title-tier-query requests. Output is byte-identical to
/// `materialized_page` (proven by the differential suite):
/// - sort keys (`last_activity_at`, `provider`, `session_id`) are immutable
///   under decoration, and the snapshot arrives pre-sorted by the identical
///   comparator, so no per-request sort is needed for existing rows;
/// - deleted-skip, visibility filters, and the search predicate run per
///   candidate on BORROWED data during the walk (decoration effects that
///   change page membership are honored row-by-row);
/// - synthesized live-only rows are merged in sorted position;
/// - full decoration (String clones, override/metadata overlay, live join,
///   search annotation) runs only on the <= limit surviving page rows,
///   via the SAME functions the materialized path uses.
fn fast_path_page(
    indexed: &[IndexedSession],
    overrides: &Map<String, Value>,
    metadata: &std::collections::HashMap<String, Value>,
    identities: &[freshell_ws::identity::TerminalIdentity],
    q: &DirQuery,
) -> Result<Value, String> {
    debug_assert!(
        indexed.windows(2).all(|w| {
            match w[1].last_activity_at.cmp(&w[0].last_activity_at) {
                std::cmp::Ordering::Less => true,
                std::cmp::Ordering::Equal => {
                    key_cmp(&w[1].provider, &w[1].session_id, &w[0].key())
                        != std::cmp::Ordering::Greater
                }
                std::cmp::Ordering::Greater => false,
            }
        }),
        "fast path requires the index's sorted snapshot (lastActivityAt DESC, key DESC)"
    );

    let limit = q
        .limit
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS);
    let cursor = match &q.cursor {
        Some(c) => Some(decode_cursor(c)?),
        None => None,
    };

    // revision (legacy 1196-1202): max over every post-override row's
    // last_activity_at chained with every identity's updated_at, min 0.
    // The snapshot is sorted DESC, so the rows' max is the FIRST non-deleted
    // row; synthesized rows carry identity.updated_at, which the identities
    // chain already covers.
    let head_activity = indexed
        .iter()
        .find(|idx| !is_deleted(overrides, &idx.key()))
        .map(|idx| idx.last_activity_at);
    let revision = head_activity
        .into_iter()
        .chain(identities.iter().map(|i| i.updated_at))
        .max()
        .unwrap_or(0)
        .max(0);

    let query_trimmed = q.query.as_deref().map(str::trim).filter(|s| !s.is_empty());
    let needle_lower = query_trimmed.map(str::to_lowercase);

    // Live-identity existence for the empty filter (`is_running` half).
    // Existence is order-independent; the page decoration re-derives the
    // matched terminal via `join_running_state`'s own first-match `find`.
    let live: std::collections::HashSet<(&str, &str)> = identities
        .iter()
        .filter_map(|i| Some((i.provider.as_deref()?, i.session_id.as_deref()?)))
        .collect();

    // Synthesized rows, ordered and pre-filtered by the SAME predicates the
    // legacy pipeline applies to them (retain #1/#2, cursor, search; the
    // empty filter always passes: they are running with a display title).
    let mut synth = synthesized_candidates(indexed, overrides, identities);
    synth.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| b.key().cmp(&a.key()))
    });
    let synth_survivors: Vec<DirItem> = synth
        .into_iter()
        .filter(|c| q.include_subagents || !c.is_subagent)
        .filter(|c| q.include_non_interactive || !c.is_non_interactive)
        .filter(|c| match &cursor {
            Some((c_last, c_key)) => {
                c.last_activity_at < *c_last
                    || (c.last_activity_at == *c_last && c.key().as_str() < c_key.as_str())
            }
            None => true,
        })
        .filter(|c| match needle_lower.as_deref() {
            Some(needle) => [
                c.title.as_deref(),
                c.summary.as_deref(),
                c.first_user_message.as_deref(),
            ]
            .into_iter()
            .flatten()
            .any(|v| contains_ci(v, needle)),
            None => true,
        })
        .collect();

    // Cursor skip: strictly-after-cursor rows form a contiguous suffix of
    // the pre-sorted snapshot — binary search replaces the O(N) retain.
    let start = match &cursor {
        Some((c_last, c_key)) => indexed.partition_point(|idx| {
            idx.last_activity_at > *c_last
                || (idx.last_activity_at == *c_last
                    && key_cmp(&idx.provider, &idx.session_id, c_key)
                        != std::cmp::Ordering::Less)
        }),
        None => 0,
    };

    enum Survivor<'a> {
        Indexed(&'a IndexedSession),
        Synth(DirItem),
    }

    // The lazy walk: merge snapshot rows (from `start`) with synthesized
    // rows by (last_activity_at DESC, key DESC), applying the borrowed
    // predicate pipeline, until limit+1 survivors exist (the +1 answers
    // has_more without decorating anything beyond the page).
    let mut survivors: Vec<Survivor> = Vec::with_capacity(limit + 1);
    let mut synth_iter = synth_survivors.into_iter().peekable();
    let mut i = start;
    while survivors.len() <= limit {
        let take_synth = match (synth_iter.peek(), indexed.get(i)) {
            (Some(s), Some(idx)) => {
                s.last_activity_at > idx.last_activity_at
                    || (s.last_activity_at == idx.last_activity_at
                        && key_cmp(&idx.provider, &idx.session_id, &s.key())
                            == std::cmp::Ordering::Less)
            }
            (Some(_), None) => true,
            (None, _) => false,
        };
        if take_synth {
            survivors.push(Survivor::Synth(synth_iter.next().expect("peeked")));
            continue;
        }
        let Some(idx) = indexed.get(i) else {
            break;
        };
        i += 1;
        let key = idx.key();
        let ov = overrides.get(&key).and_then(Value::as_object);
        if ov
            .and_then(|o| o.get("deleted"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        if !q.include_subagents && idx.is_subagent {
            continue;
        }
        if !q.include_non_interactive && idx.is_non_interactive {
            continue;
        }
        if !q.include_empty {
            let running = live.contains(&(idx.provider.as_str(), idx.session_id.as_str()));
            let titled = effective_title(idx, ov)
                .map(str::trim)
                .is_some_and(|t| !t.is_empty());
            if !running && !titled {
                continue;
            }
        }
        if let Some(needle) = needle_lower.as_deref() {
            if !title_tier_matches(idx, ov, needle) {
                continue;
            }
        }
        survivors.push(Survivor::Indexed(idx));
    }

    let has_more = survivors.len() > limit;
    let next_cursor = if has_more {
        survivors
            .get(limit - 1)
            .map(|s| match s {
                Survivor::Indexed(idx) => {
                    Value::String(encode_cursor(idx.last_activity_at, &idx.key()))
                }
                Survivor::Synth(item) => {
                    Value::String(encode_cursor(item.last_activity_at, &item.key()))
                }
            })
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };

    // Page-only full decoration, via the SAME functions the materialized
    // path runs over the whole corpus. Synthesized rows are used as built:
    // the legacy pipeline appends them AFTER overrides/metadata, so they
    // never receive either overlay.
    let mut page_items: Vec<Value> = Vec::with_capacity(survivors.len().min(limit));
    for survivor in survivors.into_iter().take(limit) {
        let item = match survivor {
            Survivor::Synth(item) => item,
            Survivor::Indexed(idx) => {
                let converted = dir_item_from_indexed(idx);
                let overlaid = apply_session_overrides(vec![converted], overrides)
                    .pop()
                    .expect("walk already skipped deleted rows");
                let with_meta = apply_session_metadata(vec![overlaid], metadata)
                    .pop()
                    .expect("metadata overlay preserves the item");
                join_running_state(with_meta, identities)
            }
        };
        let item = match query_trimmed {
            // Annotate matchedIn/snippet with the legacy function itself; the
            // walk matched on identical effective fields, so this is Some.
            // Defensive skip (not panic) if they ever diverged — the
            // differential suite would catch such a bug.
            Some(query_text) => match apply_title_search(item, query_text) {
                Some(annotated) => annotated,
                None => {
                    debug_assert!(false, "walk match must agree with apply_title_search");
                    continue;
                }
            },
            None => item,
        };
        page_items.push(item.to_value());
    }

    // `partial`/`partialReason` never occur on this path (legacy sets them
    // only in the file-search tiers).
    Ok(json!({
        "items": page_items,
        "nextCursor": next_cursor,
        "revision": revision,
    }))
}

/// Walk-side equivalent of `apply_title_search`'s match decision (field
/// precedence title -> summary -> firstUserMessage) on borrowed,
/// override-effective fields.
fn title_tier_matches(
    idx: &IndexedSession,
    ov: Option<&Map<String, Value>>,
    needle_lower: &str,
) -> bool {
    if let Some(t) = effective_title(idx, ov) {
        if contains_ci(t, needle_lower) {
            return true;
        }
    }
    if let Some(s) = effective_summary(idx, ov) {
        if contains_ci(s, needle_lower) {
            return true;
        }
    }
    if let Some(f) = idx.first_user_message.as_deref() {
        if contains_ci(f, needle_lower) {
            return true;
        }
    }
    false
}
```

Then change `build_directory_page` to dispatch (no-query → fast path; ANY query
still goes to the legacy path until Task 6):

```rust
fn build_directory_page(
    indexed: &[IndexedSession],
    overrides: &Map<String, Value>,
    metadata: &std::collections::HashMap<String, Value>,
    identities: &[freshell_ws::identity::TerminalIdentity],
    q: &DirQuery,
) -> Result<Value, String> {
    let has_query = q
        .query
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    if has_query {
        return materialized_page(indexed, overrides, metadata, identities, q);
    }
    fast_path_page(indexed, overrides, metadata, identities, q)
}
```

Notes for the implementer:
- Do NOT change `apply_query`, `apply_session_overrides`,
  `apply_session_metadata`, `join_live_terminals`, or `apply_title_search` —
  they remain the file-tier production path and the oracle.
- `limit >= 1` is guaranteed by `validate_limit` (like the legacy code, the
  `limit - 1` index assumes it; do not "fix" this).
- The `while survivors.len() <= limit` loop terminates: every iteration either
  consumes a synthesized row, advances `i`, or breaks.

- [ ] **Step 5: Run to verify GREEN, including every earlier suite**

Run:
```bash
cargo test -p freshell-server no_query_decoration_work 2>&1 | tail -5
cargo test -p freshell-server session_directory 2>&1 | tail -5
```
Expected: both PASS, `0 failed`. The characterization and trap-1 tests now
exercise the fast path for no-query requests and must be untouched and green.

- [ ] **Step 6: Add the fully-filtered-corpus bound test (green immediately)**

```rust
    /// Worst case for the walk: everything is filtered. The page is empty,
    /// the chain ends, and STILL no DirItem is built (predicates run on
    /// borrowed data only).
    #[test]
    fn fully_filtered_corpus_yields_empty_page_with_zero_conversions() {
        let mut indexed = corpus(300);
        for it in &mut indexed {
            it.is_subagent = true;
        }
        reset_conversions();
        let p = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &DirQuery::default());
        assert!(item_ids(&p).is_empty());
        assert_eq!(p["nextCursor"], Value::Null);
        assert_eq!(conversions(), 0, "no DirItem may be built for filtered rows");
    }
```

Run: `cargo test -p freshell-server fully_filtered_corpus 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 7: Full crate suite, lint, format, commit**

```bash
cargo test -p freshell-server --all-targets 2>&1 | tail -5
cargo fmt --all
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/session_directory.rs
git commit -m "perf(session-directory): page-bounded fast path for no-query directory requests"
```

---

### Task 6: Extend the fast path to title-tier search

Search still examines every candidate row (in sorted order, until `limit+1`
matches) but with borrowed, mostly allocation-free comparisons; expensive
decoration stays bounded by the page.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`

**Interfaces:**
- Consumes: everything from Task 5 (`fast_path_page` already contains the
  search plumbing: `needle_lower`, `title_tier_matches`, synth search filter,
  `apply_title_search` page annotation — it was unreachable for queries only
  because of the Task 5 dispatch).
- Produces: final dispatch — file tiers with a query go to `materialized_page`;
  everything else goes to `fast_path_page`.

- [ ] **Step 1: Write the failing (RED) bounded-search test**

```rust
    /// Trap 2: search must consider the whole corpus (matches anywhere in
    /// the 400 rows are found) while DirItem conversion stays bounded by
    /// the matches that reach the page — never the corpus.
    #[test]
    fn title_query_work_is_bounded_by_matches_not_corpus() {
        let mut indexed = corpus(400);
        for n in 0..10 {
            indexed[n * 37].title = Some(format!("zebra target {n}"));
        }
        reset_conversions();
        let q = DirQuery { query: Some("zebra".into()), ..DirQuery::default() };
        let p = page(&indexed, &Map::new(), &no_meta(), &no_idents(), &q);
        assert_eq!(item_ids(&p).len(), 10, "matches from the ENTIRE corpus are found");
        assert_eq!(p["nextCursor"], Value::Null);
        let converted = conversions();
        assert!(
            converted <= 12,
            "search must not materialize the corpus, got {converted}"
        );
    }
```

- [ ] **Step 2: Run to verify RED**

Run: `cargo test -p freshell-server title_query_work 2>&1 | tail -10`
Expected: FAIL with `got 400` (queries currently dispatch to
`materialized_page`).

- [ ] **Step 3: Flip the dispatch**

Replace `build_directory_page`'s body with the final dispatch:

```rust
fn build_directory_page(
    indexed: &[IndexedSession],
    overrides: &Map<String, Value>,
    metadata: &std::collections::HashMap<String, Value>,
    identities: &[freshell_ws::identity::TerminalIdentity],
    q: &DirQuery,
) -> Result<Value, String> {
    let has_query = q
        .query
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    // The transcript-scanning tiers keep the legacy materialization: their
    // per-item cost is already bounded by `apply_file_search`'s `max_scan`,
    // and they set `partial`/`partialReason`, which the fast path never does.
    if has_query && matches!(q.tier, Tier::UserMessages | Tier::FullText) {
        return materialized_page(indexed, overrides, metadata, identities, q);
    }
    fast_path_page(indexed, overrides, metadata, identities, q)
}
```

- [ ] **Step 4: Run to verify GREEN plus all earlier suites**

Run:
```bash
cargo test -p freshell-server title_query_work 2>&1 | tail -5
cargo test -p freshell-server session_directory 2>&1 | tail -5
```
Expected: both PASS, `0 failed`. Note the pre-existing search tests
(`title_search_matches_and_annotates`, `tier_search_is_case_insensitive`,
`title_tier_search_matches_a_renamed_sessions_override_title`,
`tier_search_combined_with_cursor_pagination`, the tier E2Es) now cover the
fast path's title tier and MUST pass unchanged — they pin `matchedIn`,
`snippet`, override composition, and cursor+search paging. The file-tier tests
(`tier_user_messages_matches_only_the_user_turn`,
`tier_full_text_matches_assistant_turn_too`,
`tier_search_reports_partial_budget_when_scan_budget_exceeded`) still hit the
legacy path.

- [ ] **Step 5: Full crate suite, lint, format, commit**

```bash
cargo test -p freshell-server --all-targets 2>&1 | tail -5
cargo fmt --all
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/session_directory.rs
git commit -m "perf(session-directory): route title-tier search through the page-bounded walk"
```

---

### Task 7: Differential suite, perf evidence, and validation sweep

Byte-wise differential proof (fast path vs legacy oracle) across seeded random
corpora, cursor chains, flags, and query shapes; a deterministic `#[ignore]`d
perf-evidence test; final repo-standard validation.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
  (inside `mod page_bound_tests`)

**Interfaces:**
- Consumes: `fast_path_page`, `materialized_page` (called directly, bypassing
  dispatch, so the comparison holds even where dispatch would agree), Task 1-2
  helpers, `reset_conversions`/`conversions`.
- Produces: nothing new.

- [ ] **Step 1: Add the deterministic generator + differential test**

```rust
    /// xorshift64* — deterministic corpus/query variation without a `rand`
    /// dependency (none is available in this workspace).
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn pick(&mut self, n: usize) -> usize {
            (self.next() % n.max(1) as u64) as usize
        }
        fn chance(&mut self, pct: u64) -> bool {
            self.next() % 100 < pct
        }
    }

    fn differential_corpus(rng: &mut Rng, size: usize) -> Vec<IndexedSession> {
        let providers = ["claude", "codex", "opencode"];
        let mut items: Vec<IndexedSession> = (0..size)
            .map(|n| {
                let provider = providers[rng.pick(providers.len())];
                // Coarse timestamps force (lastActivityAt, key) ties.
                let last = 50_000 + (rng.pick(size / 2 + 1) as i64) * 10;
                let mut it = idx(provider, &format!("d-{n:04}"), last, None);
                it.title = match rng.pick(5) {
                    0 => None,
                    1 => Some("   ".to_string()),
                    2 => Some(format!("Session needle {n}")),
                    3 => Some(format!("CAFÉ Σοφία {n}")),
                    _ => Some(format!("Untitled work {n}")),
                };
                if rng.chance(20) {
                    it.summary = Some(format!("summary needle {n}"));
                }
                if rng.chance(20) {
                    it.first_user_message = Some(format!("first message needle {n}"));
                }
                if rng.chance(15) {
                    it.title_source = Some("provider-generated".to_string());
                }
                it.is_subagent = rng.chance(20);
                it.is_non_interactive = rng.chance(20);
                it
            })
            .collect();
        // The production snapshot arrives pre-sorted (directory_index.rs
        // sorts once per sweep); the fast path relies on that invariant.
        items.sort_by(|a, b| {
            b.last_activity_at
                .cmp(&a.last_activity_at)
                .then_with(|| b.key().cmp(&a.key()))
        });
        items
    }

    fn differential_overrides(rng: &mut Rng, items: &[IndexedSession]) -> Map<String, Value> {
        let mut map = Map::new();
        for it in items {
            if !rng.chance(15) {
                continue;
            }
            let mut row = Map::new();
            match rng.pick(6) {
                0 => {
                    row.insert("deleted".into(), json!(true));
                }
                1 => {
                    row.insert(
                        "titleOverride".into(),
                        json!(format!("renamed {}", it.session_id)),
                    );
                }
                2 => {
                    // Exercises the provider-generated shadow guard.
                    row.insert("titleOverride".into(), json!("override needle"));
                    row.insert("titleSource".into(), json!("dir"));
                }
                3 => {
                    // Empty override never applies.
                    row.insert("titleOverride".into(), json!(""));
                }
                4 => {
                    row.insert("summaryOverride".into(), json!("override needle summary"));
                    row.insert("archived".into(), json!(true));
                }
                _ => {
                    row.insert("archived".into(), json!(true));
                }
            }
            map.insert(it.key(), Value::Object(row));
        }
        map
    }

    fn differential_identities(
        rng: &mut Rng,
        items: &[IndexedSession],
    ) -> Vec<freshell_ws::identity::TerminalIdentity> {
        let reg = TerminalIdentityRegistry::new();
        let mut n = 0;
        for it in items {
            if rng.chance(8) {
                reg.upsert(
                    &format!("term-{n}"),
                    Some(&it.provider),
                    Some(&it.session_id),
                    Some("/live"),
                    60_000 + rng.pick(1_000) as i64,
                );
                n += 1;
            }
        }
        // Live-only terminals (synthesized rows), a providerless shell
        // (never synthesized), and a retired terminal (excluded by list()).
        reg.upsert(
            "term-live-a",
            Some("codex"),
            Some("live-only-a"),
            Some("/w"),
            70_000 + rng.pick(1_000) as i64,
        );
        reg.upsert("term-live-b", Some("claude"), None, Some("/w"), 70_500);
        reg.upsert("term-shell", None, None, Some("/w"), 71_000);
        reg.upsert("term-gone", Some("claude"), Some("gone"), None, 72_000);
        reg.retire("term-gone");
        reg.list()
    }

    fn differential_metadata(
        rng: &mut Rng,
        items: &[IndexedSession],
    ) -> HashMap<String, Value> {
        let mut meta = HashMap::new();
        for it in items {
            if rng.chance(10) {
                meta.insert(it.key(), json!({ "sessionType": "worktree" }));
            }
        }
        meta
    }

    /// THE zero-behavior-change proof: for seeded corpora × query shapes ×
    /// flags × limits × cursor chains, the fast path's serialized JSON must
    /// equal the legacy pipeline's byte-for-byte (preserve_order makes
    /// serialization deterministic). Both paths receive the identical
    /// identities Vec, so even order-sensitive corners compare fairly.
    #[test]
    fn differential_fast_path_matches_materialized_oracle_bytewise() {
        let queries: &[Option<&str>] = &[
            None,
            Some("needle"),
            Some("NEEDLE"),
            Some("café"),
            Some("   "),
            Some("zzz-no-match"),
        ];
        for seed in 1..=12u64 {
            for &size in &[0usize, 1, 3, 57, 120] {
                let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) + size as u64 + 1);
                let items = differential_corpus(&mut rng, size);
                let overrides = differential_overrides(&mut rng, &items);
                let identities = differential_identities(&mut rng, &items);
                let meta = differential_metadata(&mut rng, &items);
                for &query in queries {
                    for &(inc_s, inc_n, inc_e) in
                        &[(false, false, false), (true, true, true)]
                    {
                        for &limit in &[1usize, 50] {
                            let mut q = DirQuery {
                                query: query.map(str::to_string),
                                limit: Some(limit),
                                include_subagents: inc_s,
                                include_non_interactive: inc_n,
                                include_empty: inc_e,
                                ..DirQuery::default()
                            };
                            for _hop in 0..4 {
                                let fast =
                                    fast_path_page(&items, &overrides, &meta, &identities, &q)
                                        .expect("fast page");
                                let oracle =
                                    materialized_page(&items, &overrides, &meta, &identities, &q)
                                        .expect("oracle page");
                                assert_eq!(
                                    serde_json::to_string(&fast).unwrap(),
                                    serde_json::to_string(&oracle).unwrap(),
                                    "seed={seed} size={size} query={query:?} \
                                     flags=({inc_s},{inc_n},{inc_e}) limit={limit}"
                                );
                                match fast["nextCursor"].as_str() {
                                    Some(c) => q.cursor = Some(c.to_string()),
                                    None => break,
                                }
                            }
                        }
                    }
                }
            }
        }
    }
```

- [ ] **Step 2: Run the differential test**

Run: `cargo test -p freshell-server differential_fast_path 2>&1 | tail -5`
Expected: PASS. Any failure message names the exact seed/size/query/flags/limit
— reproduce by hardcoding those values, then fix `fast_path_page` (never the
oracle) until byte-equal.

- [ ] **Step 3: Add the perf-evidence test (`#[ignore]`, deterministic assertion only)**

```rust
    /// Evidence for kata 0gdd slice 1. Timing is PRINTED (never asserted —
    /// wall clocks flake); the enforced bound is the deterministic
    /// conversion counter. Run manually:
    /// `cargo test -p freshell-server --release perf_evidence_28k -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn perf_evidence_28k_corpus_no_query_page() {
        let indexed = corpus(28_000);
        let meta = no_meta();
        let idents = no_idents();
        let q = DirQuery::default();
        let p = page(&indexed, &Map::new(), &meta, &idents, &q);
        assert_eq!(item_ids(&p).len(), 50);
        reset_conversions();
        let started = std::time::Instant::now();
        for _ in 0..100 {
            build_directory_page(&indexed, &Map::new(), &meta, &idents, &q).expect("page");
        }
        let elapsed = started.elapsed();
        eprintln!(
            "100 no-query pages over 28k rows: {elapsed:?} ({:?}/request)",
            elapsed / 100
        );
        assert!(
            conversions() <= 100 * 52,
            "decoration must stay page-bounded across requests"
        );
    }
```

Run once to record evidence:
```bash
cargo test -p freshell-server --release perf_evidence_28k -- --ignored --nocapture 2>&1 | tail -5
```
Expected: PASS, with an eprintln line showing the per-request time (expected
well under a millisecond, vs the 80-130 ms baseline).

- [ ] **Step 4: Final validation sweep (repo standards)**

```bash
cargo fmt --all
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p freshell-server --all-targets 2>&1 | tail -5
cargo test -p freshell-sessions 2>&1 | tail -5
```
Expected: fmt check clean; clippy clean; freshell-server `0 failed`;
freshell-sessions `0 failed` (untouched — sanity only). Do NOT run the full
workspace test suite: `freshell-freshagent` and `freshell-ws` integration
failures are pre-existing environment issues at the fork commit and are out of
scope.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-server/src/session_directory.rs
git commit -m "test(session-directory): byte-wise differential suite and perf evidence for page-bounded requests"
```

---

## Done criteria

- All Task 1-3 characterization/trap tests written BEFORE the restructure pass
  both before and after it, unchanged.
- `no_query_decoration_work_is_bounded_by_the_page` and
  `title_query_work_is_bounded_by_matches_not_corpus` each went RED against the
  legacy pipeline and GREEN after their task.
- The byte-wise differential suite passes across all seeds.
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`,
  and `cargo test -p freshell-server --all-targets` are clean; no NEW failures
  anywhere; freshell-sessions untouched.
- No wire-format, TTL, sweep, client, or `.kata.toml` changes.
