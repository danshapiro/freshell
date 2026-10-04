# Codex Multi-File Session Continuations Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Identify the root cause of KataTracker item `rrx7` and repair the Codex multi-file session behavior so a valid same-ID continuation appears as one complete session while genuinely ambiguous duplicates remain quarantined. Correct The Usual Claude review launch so Fresh Eyes can use the Claude Code CLI successfully.

### Explicit constraints
- Track and fix KataTracker item `rrx7`.
- Use a `gpt-6-sol` subagent with xhigh reasoning for root-cause investigation.
- Follow the “the-usual” workflow.
- Launch Claude reviews through the Claude Code CLI from the command line; diagnose inherited authentication routing and do not call the Anthropic API directly.
- Deliberately update the installed The Usual copy along with its canonical repository.
- Do not add a recurring behavioral test for the The Usual auth fix; validate it with a test call.
- Create and use a dedicated `.worktrees/` worktree from `origin/main`; the user authorized bypassing the earlier base-test gate to create it.
- Use red-green-refactor testing and do not weaken or skip tests.
- Do not create a PR without explicit approval or deploy/restart production.

### Accepted tradeoffs and residuals
- None stated.

## Stage 2 Scope Decisions and Residuals
- Restore the existing Freshell resume action by publishing one row with the canonical Codex session ID. Do not change the separate resumed-activity file watcher in this repair; the Kata identifies row quarantine as the resume blocker, and the watcher can still attach to an older file or miss late materialization, with no proven causal link to that symptom.
- Use a conservative structural acceptance rule based on the exact reported pair. The pair's physical creation provenance is not present in file contents, so composition cannot prove that provenance from files alone. Do not claim universal classification of every possible same-ID file history.
- Codex's provider-indexed history for this exact session was not inspected. Keep resume by canonical ID and do not claim this repair verifies provider-side history reconstruction.
- Lifetime collision-signature suppression may suppress the same signature if it clears and recurs before process restart. Distinct source-file sets remain separately diagnosable.

**Goal:** The reported Codex session, continued across sequential rollout files with one session ID, appears once in sidebar and history, exposes all source files to bounded transcript search, carries the earliest creation and latest activity times, and produces no integrity alert. A copied or otherwise ambiguous same-ID group remains quarantined, including when a member cannot render because required metadata is missing, while unchanged collisions do not produce per-request ERROR logs.

**Architecture:** Preserve the path-keyed per-file cache, retain identity evidence independently of renderable rows, and compose rows at snapshot publication only when ownership, metadata, lineage markers, and complete persisted-record write intervals agree. Publish unresolved identity groups alongside rows in the same snapshot generation so the directory route can quarantine and log every known member, including files without a renderable row. Carry every accepted source path into bounded directory search, and suppress repeated collision logs by the full signature while including a stable full-signature identifier in each event. The visible row continues to resume through the canonical session ID.

**Tech Stack:** Rust workspace (`freshell-sessions`, `freshell-server`), React/TypeScript client, Vitest, Rust tests, and Playwright browser tests.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/kata-rrx7-rollout-continuation` on `the-usual/kata-rrx7-rollout-continuation`, based on fetched `origin/main` `a531d63b32ef6442b3d64340115d8d8c2561717d`.
- Keep the work focused on Codex rollout continuations. Keep provider files read-only; do not edit or move files under a real Codex home.
- Preserve the existing session-directory wire shape and its additive `integrityError` object. Do not expose on-disk paths to clients.
- Preserve quarantine for copied, overlapping, interleaved, forked, incomplete, or metadata-conflicting same-ID groups. Never select a path based only on filename order or filename UUID suffix.
- Use JSONL structured logs with severity. Repeated polls for an unchanged collision signature must not produce repeated ERROR events; a different full source-file set must have a different stable log identifier. Same-signature recurrence during one process lifetime may remain suppressed.
- Use the repository's pinned pnpm 10.34.5, frozen dependency state, and coordinated test entrypoints. For broad agent-launched gates, set `GCLOUD_ROBOT_REQUIRE=1` and respect the shared test coordinator.
- Before browser verification, use the configured `FRESHELL_E2E_BACKEND`. If it is unset, ask the user to choose local or cloud as required by `AGENTS.md`; do not silently switch backends. Confirm the selected browser spec actually ran and was not cloud-skipped.
- Do not add prose/config hash tests. Tests must exercise session indexing, search, collision behavior, UI behavior, and the canonical-ID resume action boundary.
- Do not create a PR, merge, push, deploy, restart the live server, or clean up this worktree.

---

**TDD order:** Before any production implementation, complete Task 3 Steps 1–2
as the browser-level red preflight. Then complete Task 1 and Task 2 in order,
writing and running each task's failing tests before its production changes.
Return to Task 3 Step 3 onward after Tasks 1–2 to refine and verify the green
browser regression. Do not treat a browser test run after the directory fix
as proof of the original red state.

### Task 1: Compose Only Structurally Supported Codex Continuation Segments

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
- Produces: serde-serialized per-file Codex identity/segment evidence in `FileEntry`, independent of `item: Option<IndexedSession>`, plus a same-generation unresolved-identity sidecar from `SessionIndex`. A snapshot composition helper keeps one `IndexedSession` for a structurally accepted continuation group. Retain the existing `source_file` as the deterministic latest-segment representative for compatibility, and retain all per-segment evidence and paths in chronological order for downstream consumers.

- [x] **Step 1: Write the failing behavioral tests and sanitized fixtures**

Add `codex_source_composes_the_reported_same_id_rollout_shape` using sanitized
fixture files that model the issue-listed pair without copying private
transcript text. Both have first-line `session_meta`, equal `payload.id` and
`payload.session_id`, matching known `cwd`, `source`, `thread_source`,
`cli_version`, `originator`, and paginated history mode; neither has fork,
parent, subagent, or referenced-prefix metadata. Give the filenames lexical
order opposite to event order. Include timestamped records from the Codex
0.156 persisted variants seen in the pair, including `compacted` and
inter-agent metadata, plus user/assistant messages and distinct token
snapshots. Include the observed within-file timestamp ties and a strict gap
between the complete persisted-record write intervals. Build a `SessionIndex`
over those files and assert one row, the stable canonical ID, earliest
`created_at`, latest `last_activity_at`, earliest nonempty
`first_user_message`, latest nonempty title/summary and token snapshot, and
both source paths ordered by persisted-record time. Assert `CodexSource::scan()`
uses the same composition policy.

Add `codex_source_keeps_ambiguous_same_id_files_separate` for byte-identical
copies, overlapping/interleaved ranges, equal cross-file boundaries,
malformed or unterminated JSONL, unknown top-level variants, missing/invalid
outer timestamps, timestamp regressions, invalid/regressing ordinals,
non-first-line or inconsistent ownership, later contradictory metadata,
conflicting required metadata, and fork/parent/subagent/history-base evidence.
Assert every renderable ambiguous member remains a separate same-ID row so
the server can quarantine the whole identity. Also assert that a file with a
known matching ID but missing `cwd` is retained as non-renderable identity
evidence, prevents partial composition, and appears in the snapshot's
unresolved-identity sidecar with its renderable sibling. Generate a
2,001-line copied transcript from the small sanitized fixture in the test
helper instead of checking in a needlessly large file.

Add `codex_continuation_composition_survives_refresh_and_cache_reload`:
after the first two files compose, append to the newest file, create a third
valid continuation, reload from the persisted cache, then delete one segment.
After every refresh assert one correctly ordered row and no stale source path.
Assert that a cache written with the old schema is discarded and reparsed.

- [x] **Step 2: Run the tests and verify the intended failure**

Run:

```bash
pnpm run test:integration -p freshell-sessions directory_index::tests::codex
```

Expected: the new continuation test fails because two same-ID file rows are
published instead of one; ambiguous cases and existing single-file tests
continue to demonstrate their current behavior.

- [x] **Step 3: Add the minimal evidence and composition implementation**

In the new `codex_segments` module define serde-compatible per-file identity
and interval evidence. Store that evidence on the path-keyed `FileEntry`
independently of `item`, so a known identity survives when the normal parser
returns no renderable row (for example, missing `cwd`). Keep the existing
single-file display parser's `Option<IndexedSession>` behavior. Require the
first line to be a valid `session_meta` and validate
`payload.id == payload.session_id` for multi-file composition. Retain exact
structured values for required matching metadata (`cwd`, `source`,
`thread_source`, `cli_version`, `originator`, and `history_mode`) and every
recognized fork, parent, subagent, fork-ordinal, and `history_base` marker.
Compare these fields explicitly; absent, unknown, conflicting, or
unsupported evidence prevents composition. Filename-derived IDs remain a
single-file fallback only and never prove a continuation.

Implement a dedicated full-record evidence scan separate from the tolerant
display parser. Validate every complete JSONL line against the known 0.156
top-level rollout variants, including `compacted` and inter-agent metadata;
require a valid outer timestamp on every post-header record; preserve parsed
timestamp precision; compute extrema; track physical order; and reject
malformed/truncated lines, unknown variants, missing/invalid timestamps,
timestamp regressions, contradictory later identity/lineage records, and
invalid or regressing ordinals when present. Within-file timestamp ties are
valid and physical order remains available; ordinal values restart per file
and do not order files. Define the range as the persisted-record write
interval, excluding only the first header timestamp. Do not flatten
compaction or checkpoint payloads into invented original-history timestamps.
Keep the existing tolerant display parsing behavior for single-file
projections.

For a multi-file group, compose only when every discovered member has
first-line ownership with `payload.id == payload.session_id == session_id`,
matching known required metadata, compatible version/originator/history-mode
metadata, no known fork, parent, subagent, fork-ordinal, or referenced-prefix
evidence, and a complete persisted-record write interval. This policy admits
the issue-listed structural case; it does not prove physical writer
provenance or every possible same-ID history. Sort by interval extrema and
require each previous end to be strictly earlier than the next start. If any
member conflicts, is non-renderable, or lacks complete evidence, publish no
partial composition: preserve all renderable same-ID rows for quarantine and
retain known-ID evidence for hidden members. Build an unresolved-identity
sidecar from the full file cache after each full or scoped reconciliation;
it must include all known member paths for every uncomposed same-ID group
with at least two members. Publish it atomically with the rows and scan
failures in `CachedSnapshot`, and expose it through a narrow `SessionIndex`
read method that preserves the existing stale-while-revalidate behavior.
Evidence-only additions, changes, and removals must advance refresh change
detection and persistence accounting. Persist the evidence with `FileEntry`
and bump `CACHE_SCHEMA_VERSION`. Filename suffixes, mtime, and traversal
order never establish chronology.

For an accepted group set `created_at` to the earliest segment, activity to
the latest segment, `first_user_message` to the earliest nonempty segment,
title/summary to the latest segment with substantive data, and token usage
to the newest snapshot without summing cumulative counters.
Preserve existing single-file results. Bump `CACHE_SCHEMA_VERSION` so cached
rows lacking evidence cannot remain unmerged indefinitely. Compose after each
full or scoped cache reconciliation and sort the final rows once as before.

- [x] **Step 4: Run the focused tests**

Run:

```bash
pnpm run test:integration -p freshell-sessions directory_index::tests::codex
```

Expected: all new grouping, refusal, chronology, and metadata assertions pass.

- [x] **Step 5: Refactor while green**

Keep the grouping decision in one Codex-specific helper used by both
`CodexSource::scan()` and `SessionIndex` publication. Keep evidence parsing
separate from provider-agnostic `ParsedSessionMeta` behavior, and verify that
single-file Codex and non-Codex `IndexedSession` projections remain unchanged.

- [x] **Step 6: Run impacted-test verification**

Run:

```bash
pnpm run test:integration -p freshell-sessions directory_index::tests
pnpm run test:integration -p freshell-sessions --test malformed_data_quarantine codex_
pnpm run test:integration -p freshell-sessions --test codex_fixture_parity
```

Expected: all Codex indexing, cache, malformed-input quarantine, and parser
parity tests pass.

- [x] **Step 7: Commit the task**

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
- Consumes: one coherent `SessionIndex` snapshot of rendered `IndexedSession` rows and unresolved same-ID groups; existing `search_session_file` user/full-text tiers; existing `SessionDirectoryState` and `integrityError` response shape.
- Produces: private `DirItem` source-path collection; a bounded multi-file search that returns at most one logical row; route quarantine/logging that unions rendered row paths with unresolved index evidence; a process-shared collision-signature gate that emits one structured event per newly observed full collision signature.

- [x] **Step 1: Write failing route, logging, and UI behavior tests**

Add a real route test that seeds the sequential fixture through
`CodexSource`/`SessionIndex`, requests the session-directory endpoint, and
asserts one row, earliest `createdAt`, latest `lastActivityAt`, and no
`integrityError`. Search
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

Add a second production-index route test with exactly one renderable Codex
row and one same-ID file whose first-line identity is valid but whose `cwd`
is missing. Assert the rendered row is quarantined, `integrityError` is
present, a healthy unrelated row remains, and neither the response nor its
items expose source paths. Capture the collision event and assert its full
signature includes both the renderable and hidden member paths. Remove the
hidden file and assert a refreshed request restores the row without stale
integrity evidence. Then move the hidden member to a different path and
reopen the persistent index cache; assert the same identity is still
quarantined and the refreshed full signature reflects the new path. This
covers evidence-only path changes through refresh, persistence, and cache
reload rather than only testing the pure collision helper.

Capture actual tracing events while issuing concurrent and repeated identical
requests, performing an unchanged refresh, and changing one colliding source
path to a different path beyond the diagnostic sample. Assert one ERROR event
per distinct full signature, none for repeated polls/unchanged refresh, and
different stable signature identifiers for the changed full path sets. Do
not require the same signature to log again after a clear interval in the
same process. Assert event samples stay bounded, the full signature controls
deduplication, and source paths never enter the wire response.

Update both existing alert behavior tests to assert the alert remains
accessible and dismissible. Do not test exact prose. Replace the advice to
remove or rename provider files with a neutral instruction to check server
logs for the conflict details.

Add a focused Sidebar open-action test showing that a composed row still
passes its canonical `sessionId` and provider into the existing session-open
flow. Use the existing command-construction unit test to cover
`codex resume <sessionId>`; do not launch Codex from the browser test.

- [x] **Step 2: Run the tests and verify the intended failure**

Run:

```bash
pnpm run test:server session_directory::tests::codex_multi_file
pnpm run test:server session_directory::tests::persisted_identity_collision
pnpm run test:vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx --config config/vitest/vitest.config.ts
```

Expected: route coverage already sees one composed row from Task 1, while
multi-file search cannot yet find the older segment, a renderable row plus
same-ID non-renderable evidence is not yet quarantined by the route, and
repeated requests still emit repeated collision events without a
full-signature identifier. The copied-file route should continue to
quarantine both rows.

- [x] **Step 3: Add multi-source search and collision-state logging**

Transfer all Codex segment paths to `DirItem`; keep the representative path
private and never serialize any path. Search sources in chronological order
using the existing user/full-text parser, stop after the first matching
segment, and return a logical row once. Count each file read against the
existing `limit * 10` scan ceiling so many segments cannot bypass the bound.
If a segment read fails, continue searching later segments; retain any match
and report `partialReason: "io_error"`. Preserve paging order, snippets, tier
semantics, and existing `partial` wire behavior.

Merge the same-generation unresolved identity groups from `SessionIndex`
with row-derived collisions before filtering. Treat their complete member
paths as persisted sources even when only one or none of those files has a
renderable row; quarantine every rendered row for that identity and include
the evidence-only members in the collision signature and diagnostic counts.
Do not synthesize a visible row solely to represent a non-renderable file.

Store process-lifetime full collision signatures in shared
`SessionDirectoryState` memory as an
`Arc<Mutex<HashSet<CollisionSignature>>>`. Atomically insert the complete
sorted signature and log only when insertion is new; do not reset the set
when a collision clears. Derive a stable collision identifier (for example,
a SHA-256 digest) from the full canonical signature, include it in the
structured ERROR event, and keep the existing bounded path sample. Different
full signatures must not become indistinguishable when they differ beyond
the sample. Update Sidebar and History View alert copy to direct users to
server logs without suggesting edits to Codex-owned files. Keep the wire
shape unchanged.

- [x] **Step 4: Run the focused tests**

Run:

```bash
pnpm run test:server session_directory::tests::codex_multi_file
pnpm run test:server session_directory::tests::persisted_identity_collision
pnpm run test:server session_directory::tests::tier_
pnpm run test:vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx --config config/vitest/vitest.config.ts
```

Expected: multi-source search, copied-file quarantine, distinct full-signature
logging, alert behavior, canonical-ID row opening, and existing tier/collision
tests pass.

- [x] **Step 5: Refactor while green**

Keep collision-signature construction separate from response sampling and
ensure the mutex protects the full-signature insert as one atomic operation.
Remove any obsolete singular-path search branch once all persisted rows use
the source-path collection.

- [x] **Step 6: Run impacted-test verification**

Run:

```bash
pnpm run test:server session_directory::tests
pnpm run test:vitest run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx test/unit/shared/session-directory-schema.test.ts --config config/vitest/vitest.config.ts
```

Expected: the complete session-directory Rust module and both alert
components plus the unchanged wire-schema contract pass.

- [x] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/session_directory.rs src/components/Sidebar.tsx src/components/HistoryView.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/HistoryView.a11y.test.tsx
git commit -m "fix(session-directory): search Codex continuation segments"
```

### Task 3: Prove the Repaired Session Through the Browser

**Files:**
- Modify: `test/e2e-browser/helpers/session-corpus/codex.ts`
- Modify: `test/e2e-browser/specs/session-directory-matrix.spec.ts`

**Interfaces:**
- Consumes: the production index, directory route/search behavior, integrity alert, and canonical-ID row-opening action from Tasks 1–2.
- Produces: cloud-legal browser coverage using isolated test homes and the real session-directory route; no route response mocking or provider launch.

- [x] **Step 1: Write the failing browser regression**

Add a Codex corpus helper that writes both continuation files into an
isolated test home. Write separate positive and collision browser cases. The
positive home contains only the continuation pair; assert through the actual
API that it appears once with earliest `createdAt`, latest `lastActivityAt`,
and no `integrityError`, then assert one visible row in Sidebar and History.
Use the Sidebar `userMessages` tier with distinct text from each segment to
prove older and newer transcript search. Do not require transcript search
from History View's local metadata filter.

The separate collision home contains only a copied same-ID pair plus one
healthy unrelated session. Assert the copied pair remains hidden, the
existing integrity alert is visible and dismissible in Sidebar and History,
and the healthy row remains visible. Do not use an expected-failure marker
or a `CLOUD_SKIP_SPECS` exemption. The resume action boundary is covered by
the focused Sidebar test in Task 2; do not launch Codex in the browser suite.
Seed both cases through `createE2eServerHandle`'s isolated home before the
server starts; do not mock the session-directory route.

- [x] **Step 2: Run the test and verify the intended failure**

Run:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e test/e2e-browser/specs/session-directory-matrix.spec.ts
```

Run this red preflight before any production edits. Expected: the current
index produces a response-wide collision alert and hides the positive
continuation row. The collision-only case should continue to show the
quarantine. The selected backend must execute the named spec with a nonzero
test count.

- [x] **Step 3: Run the focused browser test**

Run:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e test/e2e-browser/specs/session-directory-matrix.spec.ts
```

Expected: the named browser spec runs on the configured backend and passes
with one positive continuation row, no positive-case alert, successful
Sidebar transcript search across both source files, and a separate copied
file case with a visible alert and intact healthy row.

- [x] **Step 4: Refactor while green**

Keep the existing single-file Codex corpus helper behavior intact; share only
small fixture-writing helpers that make session IDs and event ranges explicit.

- [x] **Step 5: Run impacted-test verification**

Run:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e test/e2e-browser/specs/session-directory-matrix.spec.ts
```

Expected: the entire named matrix spec passes with this regression included;
the test runner reports executed tests rather than a skipped cloud spec or
empty filter.

- [x] **Step 6: Commit the task**

```bash
git add test/e2e-browser/helpers/session-corpus/codex.ts test/e2e-browser/specs/session-directory-matrix.spec.ts
git commit -m "test(e2e): cover Codex multi-file continuations"
```

## Final Verification

After all three task commits and task reviews pass, run the repository's
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
