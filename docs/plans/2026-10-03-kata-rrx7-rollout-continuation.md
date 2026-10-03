# Codex Multi-File Session Continuations Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Identify the root cause of KataTracker item `rrx7` and repair the Codex multi-file session behavior so a valid same-ID continuation appears as one complete session while genuinely ambiguous duplicates remain quarantined.

### Explicit constraints
- Track and fix KataTracker item `rrx7`.
- Use a `gpt-6-sol` subagent with xhigh reasoning for root-cause investigation.
- Follow the “the-usual” workflow.
- Create and use a dedicated `.worktrees/` worktree from `origin/main`; the user authorized bypassing the earlier base-test gate to create it.
- Use red-green-refactor testing and do not weaken or skip tests.
- Do not create a PR without explicit approval or deploy/restart production.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** A Codex session continued across sequential rollout files with one session ID appears once in sidebar and history, includes all searchable turns and full timestamps, and produces no integrity alert; copied or otherwise ambiguous same-ID files remain quarantined and log only when their collision state changes.

**Architecture:** Preserve the path-keyed per-file cache, add provider evidence for each Codex rollout, and compose rows only at snapshot publication when identity, metadata, and non-overlapping event chronology all agree. Carry every accepted source path into directory search, retain quarantine for unresolved identities, deduplicate collision logs by the active full source-file signature, and make resume-time activity selection use the same verified chronology.

**Tech Stack:** Rust workspace (`freshell-sessions`, `freshell-server`, and `freshell-ws`), React/TypeScript client, Vitest, Rust tests, and Playwright browser tests.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/kata-rrx7-rollout-continuation` on `the-usual/kata-rrx7-rollout-continuation`, based on immutable `922a9241533d409cedfd323f1585eddf908848bd`.
- Keep the work focused on Codex rollout continuations. Keep provider files read-only; do not edit or move files under a real Codex home.
- Preserve the existing session-directory wire shape and its additive `integrityError` object. Do not expose on-disk paths to clients.
- Preserve quarantine for copied, overlapping, interleaved, forked, incomplete, or metadata-conflicting same-ID records. Never select a path based only on filename order or filename UUID suffix.
- Use JSONL structured logs with severity. Repeated polls for unchanged collisions must not produce repeated ERROR events; a changed collision or a recurrence after resolution must remain diagnosable.
- Use the repository's pinned pnpm 10.34.5, frozen dependency state, and coordinated test entrypoints. For broad agent-launched gates, set `GCLOUD_ROBOT_REQUIRE=1` and respect the shared test coordinator.
- Before browser verification, use the configured `FRESHELL_E2E_BACKEND`. If it is unset, ask the user to choose local or cloud as required by `AGENTS.md`; do not silently switch backends. Confirm the selected browser spec actually ran and was not cloud-skipped.
- Do not add prose/config hash tests. Tests must exercise session indexing, search, collision behavior, UI behavior, or activity selection.
- Do not create a PR, merge, push, deploy, restart the live server, or clean up this worktree.

---

### Task 1: Compose Only Verified Codex Continuation Segments

**Files:**
- Create: `crates/freshell-sessions/src/codex_segments.rs`
- Modify: `crates/freshell-sessions/src/lib.rs`
- Modify: `crates/freshell-sessions/src/parse/codex.rs`
- Modify: `crates/freshell-sessions/src/directory_index.rs`
- Create: `test/fixtures/coding-cli/codex/multi-file-continuation-older.sanitized.jsonl`
- Create: `test/fixtures/coding-cli/codex/multi-file-continuation-newer.sanitized.jsonl`
- Test: `crates/freshell-sessions/src/directory_index.rs` CodexSource and SessionIndex tests

**Interfaces:**
- Consumes: `parse_codex_session_content(&str) -> ParsedSessionMeta`; path-keyed `FileEntry` cache; `IndexedSession` snapshot rows.
- Produces: a serde-serialized `IndexedSession.codex_segment_evidence: Vec<CodexSegmentEvidence>` per cached rollout and a snapshot composition helper that keeps one `IndexedSession` for a verified continuation group. Retain the existing `source_file` as the deterministic latest-segment representative for compatibility, and retain all per-segment evidence and paths in chronological order for downstream consumers.

- [ ] **Step 1: Write the failing behavioral tests and sanitized fixtures**

Add `codex_source_merges_verified_same_id_continuation_segments` using two
fixture files with first-line `session_meta`, equal `payload.id` and
`payload.session_id`, matching `cwd` and `source`, no fork marker, and
strictly increasing substantive event-time ranges. Give the filenames
lexical order opposite to event order. Include user and assistant
`response_item/message` records in each segment and distinct token snapshots.
Build a `SessionIndex` over those files and assert one row, the stable ID,
earliest `created_at`, latest `last_activity_at`, earliest nonempty
`first_user_message`, latest nonempty title/summary and token snapshot, and
both source paths ordered by event time. Assert that `CodexSource::scan()`
uses the same composition policy.

Add `codex_source_keeps_ambiguous_same_id_files_separate` for copied files
(same event range and identical contents), overlapping/interleaved ranges,
missing substantive timestamps, non-first-line or inconsistent ownership,
conflicting cwd/source, and fork/subagent evidence. Assert that every such
file remains a separate same-ID row so the server can quarantine the whole
identity. Generate a 2,001-line copied transcript from the small sanitized
fixture in the test helper instead of checking in a needlessly large file.

Add `codex_continuation_composition_survives_refresh_and_cache_reload`:
after the first two files compose, append to the newest file, create a third
valid continuation, reload from the persisted cache, then delete one segment.
After every refresh assert one correctly ordered row and no stale source path.
Assert that a cache written with the old schema is discarded and reparsed.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run:

```bash
pnpm run test:integration -p freshell-sessions directory_index::tests::codex
```

Expected: the new continuation test fails because two same-ID file rows are
published instead of one; ambiguous cases and existing single-file tests
continue to demonstrate their current behavior.

- [ ] **Step 3: Add the minimal evidence and composition implementation**

In the new `codex_segments` module define a serde-compatible
`CodexSegmentEvidence` with the source path, first nonempty record ownership
(`session_meta` `payload.id` and `payload.session_id`), cwd, the exact parsed
JSON value of `source`, `thread_source`, fork/subagent evidence, and first/last
substantive event timestamps. Make the parser expose its recognized
semantic-record predicate to this module; compute the segment range from
those records while excluding `session_meta`, since a continuation header
may repeat the original session creation time. Keep filename-derived IDs as
a single-file fallback only; they are never continuation proof. Attach one
evidence value to every parsed Codex `IndexedSession` and preserve the full
vector when rows are composed. Composition runs after the complete per-file
cache has been reconciled, not over only the paths in a scoped watcher event.

For a multi-file group, merge only when every member has first-record
ownership with `payload.id == payload.session_id == IndexedSession.session_id`,
equal known cwd, the same present `source` JSON value, equal thread-source
metadata (including both being absent), no fork or subagent evidence, and a
substantive time range.
Sort by substantive time and require each previous end to be strictly earlier
than the next start. If any member conflicts or any evidence is missing,
publish all same-ID rows separately. Filename suffixes, mtime, and traversal
order never establish chronology. Do not partially merge a group if another
same-ID member contradicts it.

For an accepted group set `created_at` to the earliest segment, activity to
the latest segment, `first_user_message` to the earliest nonempty segment,
title/summary to the latest segment with substantive data, and token usage
to the newest snapshot without summing cumulative counters.
Preserve existing single-file results. Bump `CACHE_SCHEMA_VERSION` so cached
rows lacking evidence cannot remain unmerged indefinitely. Compose after each
full or scoped cache reconciliation and sort the final rows once as before.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
pnpm run test:integration -p freshell-sessions directory_index::tests::codex
```

Expected: all new grouping, refusal, chronology, and metadata assertions pass.

- [ ] **Step 5: Refactor while green**

Keep the grouping decision in one Codex-specific helper used by both
`CodexSource::scan()` and `SessionIndex` publication. Keep evidence parsing
separate from provider-agnostic `ParsedSessionMeta` behavior, and verify that
single-file Codex and non-Codex `IndexedSession` projections remain unchanged.

- [ ] **Step 6: Run impacted-test verification**

Run:

```bash
pnpm run test:integration -p freshell-sessions directory_index::tests
pnpm run test:integration -p freshell-sessions --test malformed_data_quarantine codex_
pnpm run test:integration -p freshell-sessions --test codex_fixture_parity
```

Expected: all Codex indexing, cache, malformed-input quarantine, and parser
parity tests pass.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/codex_segments.rs crates/freshell-sessions/src/lib.rs crates/freshell-sessions/src/parse/codex.rs crates/freshell-sessions/src/directory_index.rs test/fixtures/coding-cli/codex/multi-file-continuation-older.sanitized.jsonl test/fixtures/coding-cli/codex/multi-file-continuation-newer.sanitized.jsonl
git commit -m "fix(sessions): merge verified Codex continuations"
```

### Task 2: Preserve Full Search and Collision Behavior for Composed Rows

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/HistoryView.tsx`
- Test: `crates/freshell-server/src/session_directory.rs`
- Test: `test/unit/client/components/Sidebar.test.tsx`
- Test: `test/unit/client/components/HistoryView.a11y.test.tsx`

**Interfaces:**
- Consumes: `IndexedSession` with all Codex segment paths/evidence; existing `search_session_file` user/full-text tiers; existing `SessionDirectoryState` and `integrityError` response shape.
- Produces: private `DirItem` source-path collection; a bounded multi-file search that returns at most one logical row; a process-shared collision-signature gate that emits one structured event per newly observed full collision signature.

- [ ] **Step 1: Write failing route, logging, and UI behavior tests**

Add a real route test that seeds the sequential fixture through
`CodexSource`/`SessionIndex`, requests the session-directory endpoint, and
asserts one row, the full timestamp range, and no `integrityError`. Search
using a distinct user-message needle from each segment and an assistant
needle from each segment; each response must contain that same logical row
once with the correct tier and snippet. Search with a needle present in both
segments and assert one row. Include one unreadable segment plus a match in
the other segment and assert that the match remains while the result reports
`partialReason: "io_error"`. Exhaust the shared segment-scan budget midway
through a logical row and assert `partialReason: "budget"`.

Add a focused `apply_file_search` test with one missing segment path and one
readable matching segment to prove that search continues after the I/O
failure while preserving the partial result. Keep this unit seam separate
from the route test because the real index prunes deleted files when it
refreshes.

Add a production-index route test that copies the same 2,001-line Codex file
to a second path and asserts both persisted rows are absent, the existing
additive `integrityError` remains, healthy rows and matching live placeholders
remain, and pagination/filtering cannot hide the conflict.

Capture actual tracing events while issuing repeated identical requests,
performing an unchanged refresh, changing the conflicting source-file set,
resolving it, and reintroducing it. Assert one ERROR event for the initial
signature, none for polls/unchanged refresh, one for the changed signature,
none after resolution, and one on recurrence. Assert each event keeps the
full internal identity and bounded path sample; source paths never enter the
wire response.

Update both existing alert behavior tests to assert the alert remains
accessible and dismissible. Do not test exact prose. Replace the advice to
remove or rename provider files with a neutral instruction to check server
logs for the conflict details.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run:

```bash
pnpm run test:server session_directory::tests::codex_multi_file
pnpm run test:server session_directory::tests::persisted_identity_collision
pnpm run test:vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx --config config/vitest/vitest.config.ts
```

Expected: multi-file search cannot find the older segment, real Codex copied
rows do not yet exercise the production collision path, repeated requests
emit repeated collision events, and the new alert behavior expectations fail
until the route and copy are updated.

- [ ] **Step 3: Add multi-source search and collision-state logging**

Transfer all Codex segment paths to `DirItem`; keep the representative path
private and never serialize any path. Search sources in chronological order
using the existing user/full-text parser, stop after the first matching
segment, and return a logical row once. Count each file read against the
existing `limit * 10` scan ceiling so many segments cannot bypass the bound.
If a segment read fails, continue searching later segments; retain any match
and report `partialReason: "io_error"`. Preserve paging order, snippets, tier
semantics, and existing `partial` wire behavior.

Store the active set of full collision signatures in shared
`SessionDirectoryState` memory as an `Arc<Mutex<HashSet<CollisionSignature>>>`.
Log only signatures newly
present since the last observed request, remove cleared signatures, and
include the complete key/path set in the deduplication signature before
applying the existing bounded diagnostic sample. Update Sidebar and History
View alert copy to direct users to server logs without suggesting edits to
Codex-owned files. Keep the wire shape unchanged.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
pnpm run test:server session_directory::tests::codex_multi_file
pnpm run test:server session_directory::tests::persisted_identity_collision
pnpm run test:server session_directory::tests::tier_
pnpm run test:vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx --config config/vitest/vitest.config.ts
```

Expected: multi-source search, copied-file quarantine, actual bounded logging,
alert behavior, and existing tier/collision tests pass.

- [ ] **Step 5: Refactor while green**

Keep collision-signature construction separate from response sampling and
ensure the mutex protects the compare-and-replace operation as one unit.
Remove any obsolete singular-path search branch once all persisted rows use
the source-path collection.

- [ ] **Step 6: Run impacted-test verification**

Run:

```bash
pnpm run test:server session_directory::tests
pnpm run test:vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/shared/session-directory-schema.test.ts --config config/vitest/vitest.config.ts
```

Expected: the complete session-directory Rust module and both alert
components plus the unchanged wire-schema contract pass.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/session_directory.rs src/components/Sidebar.tsx src/components/HistoryView.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx
git commit -m "fix(session-directory): search Codex continuation segments"
```

### Task 3: Select the Current Owned Segment for Resumed Codex Activity

**Files:**
- Modify: `crates/freshell-sessions/src/codex_segments.rs`
- Modify: `crates/freshell-sessions/src/lib.rs`
- Modify: `crates/freshell-ws/src/codex_reconcile.rs`
- Test: `crates/freshell-ws/src/codex_reconcile.rs`

**Interfaces:**
- Consumes: same first-line ownership, chronology, fork, and metadata evidence used by Task 1; existing `locate_codex_rollout(&Path, &str) -> Option<PathBuf>` caller contract.
- Produces: `locate_codex_rollout` returns the deterministic newest segment only when every same-ID candidate forms one verified sequence; it returns `None` for ambiguous candidate sets.

- [ ] **Step 1: Write the failing locator regression**

Add `locate_chooses_latest_verified_same_id_segment_independent_of_walk_order`
with two first-line-owned same-ID files under different date directories,
lexical path order opposite to semantic event time, plus filename-matching
foreign-ID and same-ID overlapping decoys. Assert the returned path is the
newest verified segment, not the first path encountered, and that an
ambiguous-only candidate set returns `None`. Append a task event to the
selected current segment and exercise the existing tailer so the newest
activity is observed. Retain the current foreign-lineage ownership test.

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
pnpm run test:integration -p freshell-ws codex_reconcile::tests::locate_chooses_latest_verified_same_id_segment
```

Expected: the test fails because the locator currently stops at the first
filesystem-order owned file.

- [ ] **Step 3: Use the shared segment evidence and selector**

Expose `codex_segments::locate_current_rollout(sessions_root: &Path,
session_id: &str) -> Option<PathBuf>` from `freshell-sessions` and have
`freshell-ws::locate_codex_rollout` delegate to it. Preserve the existing
bounded recursive walk and filename prefilter. Validate first-line ownership
from file contents, require every same-ID candidate to satisfy the same
sequence policy as Task 1, and choose by substantive event time with a stable
path tie-breaker. Do not change the fresh-agent naming or history-mode
locators whose contracts only need evidence that an owned file exists.

- [ ] **Step 4: Run the focused test**

Run:

```bash
pnpm run test:integration -p freshell-ws codex_reconcile::tests
```

Expected: the new current-segment regression and existing ownership, tailer,
fork, and task-event tests pass.

- [ ] **Step 5: Refactor while green**

Remove duplicate chronology and ownership parsing from the WebSocket crate;
leave file watching and tailer IO on their existing bounded worker path.

- [ ] **Step 6: Run impacted-test verification**

Run:

```bash
pnpm run test:integration -p freshell-ws codex_reconcile::tests
pnpm run test:integration -p freshell-sessions directory_index::tests::codex
```

Expected: locator selection and the shared Codex segment evidence/composition
tests pass together.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-sessions/src/codex_segments.rs crates/freshell-sessions/src/lib.rs crates/freshell-ws/src/codex_reconcile.rs
git commit -m "fix(activity): select current Codex rollout segment"
```

### Task 4: Prove the Repaired Session Through the Browser

**Files:**
- Modify: `test/e2e-browser/helpers/session-corpus/codex.ts`
- Modify: `test/e2e-browser/specs/session-directory-matrix.spec.ts`

**Interfaces:**
- Consumes: the production index, directory route/search behavior, integrity alert, and activity selector from Tasks 1–3.
- Produces: one cloud-legal browser test seeded with sanitized continuation and copied-file data through the real test server and session index; no route response mocking.

- [ ] **Step 1: Write the failing browser regression**

Add a Codex corpus helper that writes both continuation files into the
isolated test home. Extend `session-directory-matrix.spec.ts` to seed the
continuation, a copied same-ID pair, and a healthy unrelated session. Assert
through the actual API and browser that the continuation appears once in
sidebar and History View with full time bounds, searching finds unique user
text from either segment, the copied pair remains hidden and raises the
existing integrity alert, and the healthy session remains visible. The
positive continuation must not raise the alert. Verify the alert on the
History View as well as the sidebar. Do not use an expected-failure marker or
a CLOUD_SKIP_SPECS exemption.

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e test/e2e-browser/specs/session-directory-matrix.spec.ts
```

Expected: the real API reports duplicate Codex identity rows and the
continuation is missing or duplicated in at least one user-facing view. The
selected backend must execute this named spec with a nonzero test count.

- [ ] **Step 3: Add only the browser fixture wiring required by production behavior**

Use the existing `createE2eServerHandle` isolated home and the Codex corpus
writer. Seed the continuation files before the server starts so this test
exercises full discovery, parsing, cache publication, and the real React
views. Keep the test hermetic; do not inspect or mutate the real Codex home,
and do not mock the directory API response.

- [ ] **Step 4: Run the focused browser test**

Run:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e test/e2e-browser/specs/session-directory-matrix.spec.ts
```

Expected: the named browser spec runs on the configured backend and passes
with one continuation row, no continuation alert, a visible copied-file
alert, intact healthy row, and successful search across both source files.

- [ ] **Step 5: Refactor while green**

Keep the existing single-file Codex corpus helper behavior intact; share only
small fixture-writing helpers that make session IDs and event ranges explicit.

- [ ] **Step 6: Run impacted-test verification**

Run:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e test/e2e-browser/specs/session-directory-matrix.spec.ts
```

Expected: the entire named matrix spec passes with this regression included;
the test runner reports executed tests rather than a skipped cloud spec or
empty filter.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/helpers/session-corpus/codex.ts test/e2e-browser/specs/session-directory-matrix.spec.ts
git commit -m "test(e2e): cover Codex multi-file continuations"
```

## Final Verification

After all four task commits and task reviews pass, run the repository's
coordinated full check once at final `HEAD`:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run check
```

Also rerun the named browser spec on the configured `FRESHELL_E2E_BACKEND`
after the last source change. If any browser run was part of the configured
full check, adopt that result only when it executed this exact spec at final
`HEAD`; otherwise run the named spec separately. Record exact commands,
commit SHA, test totals, configured backend, and any skipped scopes in the
progress ledger. Do not deploy or create a PR as part of this plan.
