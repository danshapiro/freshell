# Session-directory page-bounded preparation

> This is the execution plan for the-usual. It is deliberately self-contained:
> each task names its files, its order, its measurable result, and its stop
> condition. A worker must not infer a missing policy from the old implementation.

**Goal:** Keep the complete session catalog, search coverage, ordering, cursors,
revision, flags, snippets, partial results, response fields, and response bytes
unchanged for fixed captured inputs and non-overlapping operations, while doing
full-row preparation and JSON serialization only for the returned page. Keep
candidate inspection over the full catalog where the current behavior requires
it, but retain no more than `limit + 1` selected descriptors and search
annotations and materialize/serialize no more than `limit` rows.

**Current amendment state:** `0/7 tasks completed; no application code changed.`
The amendment work changes this plan and creates external evidence helpers only.
It does not run Cargo, Playwright, Docker, Cloud Run, Vitest, `npm test`, or any
product/runtime workload.

## Architecture

Capture one independent value from each existing accessor in this order:

1. authentication and raw-query validation;
2. one awaited `SessionIndex::snapshot()`;
3. one overrides snapshot;
4. one awaited metadata snapshot;
5. one identity snapshot;
6. one synchronous derivation from those captured values;
7. release the index snapshot;
8. read whole-map project colors only after a successful page.

The four captures are sequential and independent. They are not one atomic
cross-store instant. A write overlapping the request has unspecified cross-store
visibility; do not add a race test that chooses one allowed interleaving. The
request revision remains full-catalog candidate/identity recency, not a
cross-store generation. Do not add a cache, a population total, or a new index
paging API.

The production path has exactly one borrowed candidate representation, one
ordering relation used by sorting and cursor continuation, one eligibility
predicate, one selector, one consuming materializer, and one serializer. There
is no runtime switch and no second production policy. The source edit is one
Rust file: `crates/freshell-server/src/session_directory.rs`.

## Global constraints

- Worktree: `/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep`.
- Frozen implementation base: `225a91db3e4d48d4b6a7e8bc0987afad8ff31917`.
- Branch: `the-usual/session-directory-lazy-page-prep`.
- The plan is the only pre-execution Git change. The application source must be
  byte-identical to the frozen base before Task 1 authorizes source work.
- Only this application/test source file may change:
  `crates/freshell-server/src/session_directory.rs`.
- Never change a `Cargo.toml`, `Cargo.lock`, `.kata.toml`, `package.json`,
  `package-lock.json`, TypeScript, JavaScript, browser fixture, coordinator,
  reusable script, or recipe state file.
- No new source file is allowed. All Rust tests and test-only counters remain
  inline in `session_directory.rs`.
- Do not change public route/state/query/wire interfaces, status codes,
  authentication, `SessionIndex::snapshot(&self) -> Arc<Vec<IndexedSession>>`,
  cursor encoding, response fields, optional-field omission, or object insertion
  order.
- Preserve current Rust behavior, not the Node behavior, for archive order,
  title-search fields, snippets, project paths, and `checkoutPath` omission:
  recency/full-key order; title, summary, first user message only; Rust `char`
  truncation to 140; and no `checkoutPath`.
- Keep deep-search check order exactly: lookahead count, scan budget, source
  path, supported provider, scan increment, file I/O. A later budget stop
  overwrites an earlier `io_error` reason.
- Preserve the current strict duplicate cursor gap, unordered supplied identity
  vector semantics, ignored request `revision` parameter, providerless identity
  contribution to page revision, and full-catalog revision calculation.
- The selector may inspect all shallow candidates, but it may retain at most
  `limit + 1` selected descriptors/annotations. It may materialize and serialize
  at most `limit` rows. This is a structural bound, not a latency, RSS, allocator,
  or CPU claim.
- The route tests in Tasks 2 and 3 must call the real authenticated Axum route
  through Tower `oneshot`, collect the complete response body, parse it, and
  compare literal expected values. They must not call a policy helper to produce
  their expected result.
- Expected comparator, order, cursor, visibility, page, revision, search,
  snippet, and partial outcomes are literal fixture values. Do not compute an
  expected result with the production ordering operators, a second selector, a
  copied eligibility predicate, a copied search function, a generated expected
  list, or a serializer call used as the expected byte string.
- The old whole-list helpers and their direct tests are temporary migration
  targets only. Task 5 performs one uninterrupted source edit that adds the
  single new policy, cuts over the handler, migrates every direct old-helper
  test, and deletes the old policy before the first compile/test after that edit.
- Task 4 contains types, lifetimes, and mechanical field accessors only. It does
  not contain ordering, eligibility, search, selector, page derivation,
  materialization, serialization, or handler cutover.
- No old/new comparison, seeded comparison, random comparison, compatibility
  policy, runtime feature flag, test-only copy of the old policy, or generated
  policy oracle may be added.
- Every command is self-contained, uses an absolute path or `git -C`, and does
  not rely on a persistent shell, inherited working directory, or unstated
  environment. Focused Cargo, browser, and sandbox commands do not carry a
  Vitest-backend setting. Only the two broad coordinator-owned `npm test` gates
  select the cloud Vitest backend and the reviewed external adapter.
- Every executable Python evidence block uses `python3 -I -` and explicit
  fail-closed checks that raise `SystemExit` with useful text. No evidence
  condition may use Python's runtime assertion statement; inherited Python
  environment settings and optimization must not weaken validation. Rust test
  assertion macros described elsewhere are unaffected.
- Broad JavaScript work must use the repository coordinator. Never use raw
  `npx vitest`. Destructive/all-target server work must use the repository
  sandbox. Wait for a foreign coordinator holder; never kill or bypass it.
- Task 1 and Task 7 do not open a pull request. The branch may be pushed so the
  cloud image is built from the exact clean SHA. Pull-request creation remains
  outside this plan and after the-usual finishes.
- Task 1 and Task 7 modify no tracked repository file content. Their declared
  external effects are: push the named branch, build/push a cloud image, create
  one unique job per attempt, execute it, delete that exact unique job, append
  an attempt record, and—only after `npm test` including local Electron exits
  zero—append its linked acceptance record. Retries preserve prior attempts.
- Do not run paid cloud work during this plan amendment. The adapter is syntax
  checked only now. A future Task 1 or Task 7 cloud run must stop if account
  refresh, project access, quota, image build, digest resolution, or job creation
  is unavailable.

## External evidence artifacts

These files are outside Git and are part of this amendment's evidence boundary:

- `$LOG_ROOT/reports/amendment-4-single-policy-cloud.md` — append-only report.
- `$LOG_ROOT/pinned-vitest-cloud-v1.sh` — reviewed adapter, SHA-256
  `4d65abf81f203293bc8045cffcb933cc4e0febfcad6859b1c7a494ada141bad3`.
- `$LOG_ROOT/pinned-cloud-runs.jsonl` — empty until a real cloud attempt occurs;
  each attempt is preserved as its own append-only record, and only a completed
  coordinator-owned `npm test` with local Electron success receives a linked
  acceptance record. No fabricated or deleted retry record is allowed.
- `$LOG_ROOT/load-bearing-ledger.md` — append-only amendment entries.
- `$LOG_ROOT/writing-plans-self-review.md` — append-only amendment entry.

Here `$LOG_ROOT` is
`/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep`.
The adapter is invoked only through:

```text
FRESHELL_VITEST_CLOUD_SCRIPT=/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep/pinned-vitest-cloud-v1.sh
```

The stock `scripts/vitest-cloud.sh` is not an accepted execution dependency.
The reviewed adapter requires phase, branch, expected full HEAD, reviewed
adapter hash, and a unique attempt handoff path. Before cloud work and again
after execution verification it requires a clean worktree and exact equality
among local HEAD, the expected HEAD, and `git ls-remote origin` for the named
branch. It builds through `scripts/e2e-cloud.sh`, resolves `@sha256:...`, creates
one lowercase length-checked unique job, describes that exact job and verifies
its stored image, captures and verifies the exact execution, deletes only that
unique job, then appends an immutable attempt record. It never selects a mutable
image tag, updates/reuses `freshell-vitest`, or chooses a latest execution.

A cloud attempt is not acceptance. The adapter's separate `accept ATTEMPT_ID`
operation runs only after the complete coordinator-owned `npm test` returns
zero, including local Electron. It links a distinct acceptance record to the
attempt ID after another clean local/remote HEAD check. Successful attempts must
have `failureStage=null`, `cleanupError=null`, `jobDeleted=true`, matching
created/execution immutable images, the expected success count, and zero failed.
Failed or superseded attempts remain in the JSONL; retries create additional
attempt records. Task 1 and Task 7 select the latest acceptance matching phase,
exact HEAD, and the attempt's exact digest rather than requiring one raw attempt.

The EXIT trap passes the triggering status explicitly (`trap 'on_exit "$?"'
EXIT`; handler `local status="$1"`). Any build/create/describe/execute/verify or
delete failure therefore remains nonzero in both process status and attempt
`exitCode`; cleanup failure turns an otherwise-zero status nonzero. The only
valid successful record clears failure/cleanup fields before evidence append.
An `attempt_record` failure stage is reserved for evidence-write failure.
No-cost mock gates cover execute status 17, delete failure, and successful
post-Electron acceptance before Task 1 may spend cloud resources.

## Current Rust policy facts to preserve

The following facts are load-bearing and come from the source and prior
explorer/architecture reports:

- `DirItem` currently owns the fully prepared row. The handler currently builds
  all rows, applies overrides and metadata, joins live identities, sorts,
  filters, searches, and only then cuts to `limit`.
- `SessionIndex::snapshot()` returns one immutable `Arc<Vec<IndexedSession>>`.
  Borrow that one generation through synchronous derivation; never re-read the
  index during a request.
- Overrides use full string keys. `deleted: true` removes an indexed row;
  non-empty title overrides apply except the provider-generated `dir` and
  `first-message` guard; string summary overrides apply; `archived` defaults to
  false.
- The first matching supplied identity wins for an indexed `(provider,
  session_id)`. Provider-bearing identities with no indexed row synthesize a
  row. Providerless identities are skipped as rows but still contribute their
  `updated_at` to revision. The first synthesized full-string-key collision
  wins in supplied identity order.
- A live indexed row keeps its indexed activity time. A synthesized row uses the
  identity update time. A missing session ID uses `terminal:<terminalId>` and
  sets `liveTerminalOnly`; a known session ID does not set that field.
- Title search checks `title`, `summary`, then `firstUserMessage`,
  case-insensitively, and annotates the first match. Project and cwd leaves are
  not title-search fields.
- Deep search reads only rows with a source file and provider `claude` or
  `codex`. User-message search ignores assistant-only hits; full-text search
  accepts them. Search is case-insensitive. Exhaustion without a limit or I/O
  failure does not invent a partial result; the exact budget and I/O cases below
  do.
- Revision is the maximum post-overlay candidate activity or live identity
  `updated_at`, clamped at zero. It is calculated before visibility, cursor, or
  search and remains the same across pages for fixed captured inputs.

## Literal behavior table

Every new or migrated test must use these fixed expected values. If the real
route produces anything else, stop and report the mismatch instead of deriving a
new expected value from the implementation.

### Order and cursor relation cases

The candidate is on the left of the relation and the cursor is on the right.
The expected values are literal and must be written directly in the test:

| Candidate activity | Candidate key | Cursor activity | Cursor key | Expected relation | After cursor |
|---:|---|---:|---|---|---|
| `20` | `claude:new` | `10` | `claude:old` | `Ordering::Less` | `false` |
| `10` | `claude:z` | `10` | `claude:a` | `Ordering::Less` | `false` |
| `10` | `a:b:c` | `10` | `a:b:c` | `Ordering::Equal` | `false` |
| `10` | `provider:prefix` | `10` | `provider:prefix-long` | `Ordering::Greater` | `true` |
| `10` | `λ:会話` | `10` | `λ:会話a` | `Ordering::Greater` | `true` |
| `i64::MAX` | `max:id` | `i64::MIN` | `min:id` | `Ordering::Less` | `false` |
| `i64::MIN` | `min:id` | `i64::MAX` | `max:id` | `Ordering::Greater` | `true` |

The test must not calculate these values from the production relation.

### Effective membership, order, and page cases

- Deleted-head backfill: indexed rows `raw-head@300`, `backfill@200`,
  `tail@100`; delete `claude:raw-head`; `limit=1` returns `[` `backfill` `]`,
  has a cursor, and has `revision=200`.
- Title promotion: delete `raw-head@300`; apply title override
  `override title` to `promoted@200`; `limit=1` returns `promoted`, title
  `override title`, a cursor, and `revision=200`.
- Running promotion: delete `raw-head@300`; identity
  `terminal-running` joins `claude:running@200`; `limit=1` returns `running`,
  `lastActivityAt=200`, `isRunning=true`, `runningTerminalId=terminal-running`,
  a cursor, and `revision=900`.
- New live-only row: identity `terminal-live` with provider `claude`, no
  session ID, cwd `/live`, update `300`; the first page is
  `terminal:terminal-live`, title `Claude CLI`, `isRunning=true`,
  `liveTerminalOnly=true`, `revision=300`; its cursor page returns `indexed`
  and has no next cursor.
- New known-session row: identity `terminal-unindexed` with `claude:unindexed`
  and update `300`; it returns `unindexed`, title `Claude CLI`, running terminal
  `terminal-unindexed`, no `liveTerminalOnly`, and the next page is `indexed`.
- Deleted indexed row re-synthesis: `deleted-live@200` is deleted and archived
  with title/summary overrides, then identity `terminal-deleted-live` updates
  it at `300`. The row is `deleted-live`, title `Claude CLI`,
  `lastActivityAt=300`, `createdAt=300`, `archived=false`,
  `sessionType=claude`, `isRunning=true`, running terminal
  `terminal-deleted-live`; it has no summary and no `liveTerminalOnly`, and no
  cursor is present.
- Equal activity/full-key order: rows `claude:a`, `codex:z`, `claude:z`, all at
  `500`; first `limit=2` keys are `["codex:z", "claude:z"]`, second cursor page
  is `["claude:a"]`, both revisions are `500`, and the second page has no cursor.
- Archived order: `newer-archived@300` remains before `older-active@200`; the
  first page says archived `true`, the second says archived `false`, and both
  revisions are `300`.
- Cursor chain: hidden `hidden-newest@900`, visible rows `s5@500` through
  `s1@100`, `limit=2`; three pages return exactly
  `["s5","s4","s3","s2","s1"]`, `revision=900` on each page, no duplicate
  IDs, and no `total`, `totalCount`, or `totalSessions` field.
- Lookahead boundaries are literal:
  `(count, limit, item_count, cursor) =
  (0,1,0,false), (1,1,1,false), (2,1,1,true),
  (50,50,50,false), (51,50,50,true)`.
- Eight visibility results use the following exact mapping, all with
  `revision=800` and the rows in listed order:

| includeSubagents | includeNonInteractive | includeEmpty | Expected IDs |
|---|---|---|---|
| `false` | `false` | `false` | `["visible", "running-empty"]` |
| `false` | `false` | `true` | `["visible", "idle-empty", "whitespace", "running-empty"]` |
| `false` | `true` | `false` | `["visible", "noninteractive", "running-empty"]` |
| `false` | `true` | `true` | `["visible", "noninteractive", "idle-empty", "whitespace", "running-empty"]` |
| `true` | `false` | `false` | `["visible", "subagent", "running-empty"]` |
| `true` | `false` | `true` | `["visible", "subagent", "idle-empty", "whitespace", "running-empty"]` |
| `true` | `true` | `false` | `["visible", "subagent", "noninteractive", "running-empty"]` |
| `true` | `true` | `true` | `["visible", "subagent", "noninteractive", "idle-empty", "whitespace", "running-empty"]` |

### Revision, cursor validation, and wire cases

- Providerless identity `updated_at=900` with no indexed rows returns empty
  `items`, `nextCursor=null`, and `revision=900`.
- `revision=999999999999` in the request produces the same page as omitting
  it; the returned revision for a `visible@500` row is `500`.
- Empty or malformed cursor cases all return the literal error
  `Invalid session-directory cursor`: invalid Base64, valid Base64 with
  `not-json`, JSON `null`, JSON `[]`, `{}`, missing `key`, missing
  `lastActivityAt`, string timestamp, fractional timestamp, out-of-i64
  timestamp `18446744073709551615`, non-string key, and empty key.
- Cursor payload
  `{"lastActivityAt":7,"key":"claude:session","extra":true}` is accepted;
  an empty page has `nextCursor=null` and `revision=0`.
- Authenticated route input `cursor=not-base64` returns status `400` and exact
  JSON `{"error":"Invalid session-directory cursor"}`.
- Exact response fixture has two items and no totals. Its raw bytes must equal:

```text
{"items":[{"sessionId":"terminal:terminal-fallback","provider":"claude","projectPath":"/live","lastActivityAt":300,"isRunning":true,"archived":false,"title":"Claude CLI","createdAt":300,"cwd":"/live","runningTerminalId":"terminal-fallback","liveTerminalOnly":true,"sessionType":"claude"},{"sessionId":"shape","provider":"claude","projectPath":"/project","lastActivityAt":200,"isRunning":true,"archived":true,"title":"effective title","summary":"effective summary","firstUserMessage":"first user","createdAt":150,"cwd":"/cwd","runningTerminalId":"terminal-indexed"}],"nextCursor":null,"revision":300}
```

The parsed object must have exactly the same fields and values, and each item
must omit `checkoutPath`, `titleSource`, and `sourceFile`.

### Search and partial cases

- Title precedence fixture returns IDs
  `["precedence", "summary", "first", "override-title", "override-summary"]`
  with `revision=2000`, no cursor, and these literal annotations:
  `title -> needle-abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabc`,
  `summary -> needle in summary`,
  `firstUserMessage -> needle in first message`,
  `title -> needle override title`,
  `summary -> needle override summary`.
  The first title snippet is exactly the 140-character literal shown above;
  do not compute it with `take`, `repeat`, or another policy expression.
- `query=needle&tier=title` does not match `project_path=/workspace/needle-project`
  or `cwd=/workspace/needle-cwd`; it returns empty items, null cursor,
  `revision=200`, and no partial fields.
- User-message fixture with user text `unique-search-term-alpha` and
  assistant-only text returns one item with `matchedIn=userMessage` and exact
  snippet `unique-search-term-alpha`; assistant-only query returns empty.
- Full-text fixture with assistant-only text `unique-fulltext-only-phrase`
  returns one item with `matchedIn=assistantMessage` and exact snippet
  `unique-fulltext-only-phrase`.
- Case-insensitive `MixedCase NeedleValue Here` matches query `needlevalue`.
- Exhausted no-match returns empty items, `nextCursor=null`, and omits both
  `partial` and `partialReason`.
- Missing source file returns empty items, `nextCursor=null`, `revision=100`,
  `partial=true`, `partialReason=io_error`.
- Ten nonmatching readable files after a missing file and a later eligible row
  return empty items, `nextCursor=null`, `revision=1000`, `partial=true`,
  `partialReason=budget`; budget replaces the earlier I/O reason.
- Ten readable files followed by a no-source row return empty items,
  `nextCursor=null`, `revision=1000`, `partial=true`,
  `partialReason=budget`; the budget check occurs before the no-source tail.
- Search cursor pages return the literal session order
  `["cccccccc-0000-4000-8000-000000000003",
  "cccccccc-0000-4000-8000-000000000002",
  "cccccccc-0000-4000-8000-000000000001"]`.

### Additional retained exact assertions

The migration must keep these existing fixture literals as well as the route
literals above:

- The real corrupted/healthy Claude fixture keeps the default empty page with
  `revision=1_769_753_759_234i64`; including non-interactive returns one
  `claude` item titled `Test Session 1`; including empty preserves the literal
  session ID `b7936c10-4935-441c-837c-c1f33cafec2d`; the cwd-less repair fixture
  remains empty with `revision=0` under all flags.
- The simple cursor split returns `b` first and `a` second, with a null cursor
  after the second page. The malformed cursor validation keeps the exact
  `Invalid session-directory cursor` text.
- Provider-display values remain `Claude CLI`, `Codex CLI`, `OpenCode`, and the
  raw fallback `amplifier`. A matched `claude:sess-1` row keeps activity `500`,
  running terminal `term-1`, and no running state when the identity is for a
  different session.
- A providerless live identity emits no row. A known `opencode` identity emits
  session `sess-77`, project `/home/dan/project`, title `OpenCode`, type
  `opencode`, terminal `term-9`, and activity `2000`. A codex identity without
  a session ID emits `terminal:term-5`, project `terminal:term-5`, title
  `Codex CLI`, and `liveTerminalOnly=true`.
- The pre-adoption Codex fixture keeps exactly two rows. The supplied identity
  vector keeps `exact-first` as the indexed winner and `synth-first` as the
  synthesized collision winner. An identity with `is_subagent=Some(true)` emits
  `isSubagent=true`; `None` omits the field.
- Overlay literals remain `Renamed`, `New sum`, and `archived=true`; provider
  generated rows suppress `dir` and `first-message` titles but accept `AI Title`,
  `My Rename`, `Legacy Rename`, and a missing source. Empty title overrides do
  not replace `Provider Title`; suppressed titles still apply summary `sum` and
  archive `true`; a renamed title matches `Renamed Special`.
- User-message search uses `unique-search-term-alpha` and rejects the
  assistant-only phrase; full-text accepts `unique-fulltext-only-phrase` as an
  `assistantMessage`; case-insensitive search matches `MixedCase NeedleValue Here`
  with `needlevalue`; an exhausted `zzz-absent-query-text` omits partial fields.
- The three-page search fixture returns session IDs in this literal order:
  `cccccccc-0000-4000-8000-000000000003`,
  `cccccccc-0000-4000-8000-000000000002`,
  `cccccccc-0000-4000-8000-000000000001`. The budget fixture has eleven rows,
  empty items, `partial=true`, and `partialReason=budget`.

## Old policy and direct-test deletion inventory

Task 5 must delete these exact legacy policy functions/types and must not leave a
wrapper under another name:

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
deep_search_dir_item
guard_item
overlaid_title
derive_eager_oracle_page
DifferentialFixture
DeterministicLcg
DIFFERENTIAL_SEEDS
seeded_differential_fixture
seeded_differential_fixture_variants
differential_visibility_cases
differential_query_cases
differential_limits
differential_cursors
fixed_deep_partial_cases
candidate_path_matches_eager_oracle_across_seeded_cross_product
```

The final output cleanup removes `DirItem::key`, the `Clone` derive on `DirItem`,
and the legacy-only `title_source` and `source_file` fields after all consumers
are migrated. It must replace the retained `Comparable::from(&DirItem)` use of
`i.key()` with `format!("{}:{}", i.provider, i.session_id)` and must not change
the separate `IndexedSession::key` method.

Every direct old-helper test must be migrated in the same Task 5 edit. The
complete retained-test list is:

```text
provider_display_name_matches_known_providers_and_falls_back_to_raw
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
supplied_identity_vector_preserves_first_exact_and_synthesized_winners
default_query_hides_non_interactive_fixtures
include_non_interactive_surfaces_titled_session
include_empty_surfaces_untitled_sessions_sorted_desc
r10b_cwdless_repair_fixture_never_surfaces_under_any_flags
title_search_matches_and_annotates
cursor_paging_splits_and_round_trips
invalid_cursor_is_rejected
cursor_with_required_fields_and_extra_json_field_remains_accepted
badcursor_still_400s_with_original_message_r9_parity_untouched
overrides_overlay_applies_title_summary_archived_and_filters_deleted
overlay_shape_unchanged_when_no_overrides_archived_always_present
provider_generated_session_suppresses_dir_override_row
provider_generated_session_suppresses_first_message_override_row
provider_generated_session_still_applies_ai_override_row
provider_generated_session_still_applies_user_override_row
provider_generated_session_still_applies_absent_source_override_row
empty_string_title_override_never_applies
non_provider_generated_session_still_applies_dir_override_row
suppressed_title_row_still_overlays_summary_and_archived
title_tier_search_matches_a_renamed_sessions_override_title
tier_user_messages_matches_only_the_user_turn
tier_full_text_matches_assistant_turn_too
tier_search_is_case_insensitive
tier_search_empty_no_match_returns_empty_items_without_partial
tier_search_combined_with_cursor_pagination
tier_search_reports_partial_budget_when_scan_budget_exceeded
tier_search_reports_io_error_for_missing_source_file
tier_search_budget_overwrites_prior_io_error
tier_search_budget_is_checked_before_no_source_tail
```

## Dependency order

```text
Task 1: publish the plan-only branch and prove the unchanged baseline
  -> Task 2: real-route rows/order/pages/bytes
    -> Task 3: real-route cursors/search/partial/edge cases
      -> Task 4: borrowed types and mechanical accessors only
        -> Task 5: one source edit, one policy, handler cutover, test migration, old-policy deletion
          -> Task 6: bounded retained work, output cleanup, work-limit proof
            -> Task 7: final checks and exact-final-HEAD pinned cloud suite
```

### Task 1: Publish the plan-only branch and prove the unchanged baseline

**Files and effects**

- Tracked repository file content modified by this task: none. It consumes and
  commits the already-amended plan; it does not edit application/test source.
- Read: `AGENTS.md`, the plan, manifests/lockfiles, coordinator sources,
  browser configuration/spec, `scripts/e2e-cloud.sh`, the adapter, and current
  `session_directory.rs`.
- External writes: one append-only cloud attempt record for every started cloud
  attempt, one linked acceptance record only after complete `npm test` success,
  and a temporary attempt-ID handoff file.
- Remote/cloud effects: push the named branch; build/push its image; create and
  execute one unique job per attempt; delete that exact unique job on success
  and best-effort on failure. Never create/update/delete `freshell-vitest`.

**Steps**

- [ ] Verify branch, frozen-base ancestry, clean status, and that
  `base..HEAD` changes only the committed plan. Prove that
  `crates/freshell-server/src/session_directory.rs` is unchanged from base.
- [ ] Commit the plan-only change with the configured identity and required
  Amplifier footer. Do not commit application source and do not open a pull
  request.
- [ ] Run the literal branch push and exact remote-HEAD check:

```bash
bash -c '
set -euo pipefail
root=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep
branch=the-usual/session-directory-lazy-page-prep
test "$(git -C "$root" branch --show-current)" = "$branch"
test -z "$(git -C "$root" status --porcelain=v1 --untracked-files=all)"
expected_head="$(git -C "$root" rev-parse HEAD)"
git -C "$root" push origin "HEAD:refs/heads/${branch}"
remote_line="$(git -C "$root" ls-remote --exit-code origin "refs/heads/${branch}")"
read -r remote_head remote_ref extra <<<"$remote_line"
test -z "${extra:-}"
test "$remote_ref" = "refs/heads/${branch}"
test "$remote_head" = "$expected_head"
'
```

  Expected: exit 0. The local branch, clean local HEAD, and exact remote branch
  HEAD are identical. This creates/updates only the named feature branch.
- [ ] Check cloud auth and project access without mutation. The project check
  must name the project both positionally and with explicit `--project`:

```bash
gcloud auth print-access-token --account=dan@danshapiro.com >/dev/null && \
gcloud projects describe misc-puttering-project \
  --account=dan@danshapiro.com \
  --project=misc-puttering-project >/dev/null
```

  If account refresh, IAM, or project access fails, stop before paid work.
- [ ] Run the focused unchanged Rust family from the target worktree with
  `cargo test --locked --manifest-path ... -p freshell-server --bin
  freshell-server session_directory -- --color=never --test-threads=1`.
  Require exit 0 and no failed test.
- [ ] Run the exact Rust-backed browser matrix from the target worktree with
  the pinned Playwright CLI, `FRESHELL_E2E_BACKEND=local`, project
  `rust-chromium`, one worker, and
  `test/e2e-browser/specs/session-directory-matrix.spec.ts`. Require every
  existing case to pass. Readiness is not pass evidence.
- [ ] Before paid work, run the adapter and extracted Task 1/7 evidence programs
  through the no-cost fake-Git/fake-gcloud harness twice: once with inherited
  `PYTHONOPTIMIZE` absent and once with `PYTHONOPTIMIZE=1`. Both runs must prove:
  execution status 17 remains a failed, unaccepted attempt; delete failure
  remains failed and unaccepted; a `cloud_failed` attempt cannot be accepted;
  equal baseline/final digests fail final selection; valid success plus
  post-Electron acceptance passes; and all executed evidence programs are
  isolated and contain no Python runtime assertion nodes.
- [ ] Run the complete coordinator-owned baseline, acceptance write, and latest
  accepted-record selection in one self-contained shell. The hash check occurs
  immediately before `npm test`; the adapter repeats it immediately before
  cloud work. `accept` runs only after `npm test` returns zero, therefore after
  local Electron succeeds:

```bash
bash <<'BASH'
set -euo pipefail
root=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep
branch=the-usual/session-directory-lazy-page-prep
logroot=/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep
adapter="${logroot}/pinned-vitest-cloud-v1.sh"
adapter_sha=4d65abf81f203293bc8045cffcb933cc4e0febfcad6859b1c7a494ada141bad3
records="${logroot}/pinned-cloud-runs.jsonl"
attempt_file="$(mktemp /tmp/freshell-baseline-attempt.XXXXXX)"
cleanup() { rm -f -- "$attempt_file"; }
trap cleanup EXIT

test "$(git -C "$root" branch --show-current)" = "$branch"
test -z "$(git -C "$root" status --porcelain=v1 --untracked-files=all)"
expected_head="$(git -C "$root" rev-parse HEAD)"
git -C "$root" push origin "HEAD:refs/heads/${branch}"
remote_line="$(git -C "$root" ls-remote --exit-code origin "refs/heads/${branch}")"
read -r remote_head remote_ref extra <<<"$remote_line"
test -z "${extra:-}"
test "$remote_ref" = "refs/heads/${branch}"
test "$remote_head" = "$expected_head"
test "$(sha256sum "$adapter" | awk '{print $1}')" = "$adapter_sha"

export FRESHELL_VITEST_BACKEND=cloud
export FRESHELL_VITEST_CLOUD_SCRIPT="$adapter"
export FRESHELL_PINNED_CLOUD_PHASE=baseline
export FRESHELL_PINNED_CLOUD_BRANCH="$branch"
export FRESHELL_PINNED_CLOUD_EXPECTED_HEAD="$expected_head"
export FRESHELL_PINNED_CLOUD_ADAPTER_SHA256="$adapter_sha"
export FRESHELL_PINNED_CLOUD_ATTEMPT_FILE="$attempt_file"
export FRESHELL_TEST_SUMMARY="session-directory lazy-page cloud baseline"

env --chdir="$root" INIT_CWD="$root" PWD="$root" \
  npm --prefix "$root" test

attempt_id="$(cat "$attempt_file")"
test -n "$attempt_id"
test -z "$(git -C "$root" status --porcelain=v1 --untracked-files=all)"
test "$(git -C "$root" rev-parse HEAD)" = "$expected_head"
remote_line="$(git -C "$root" ls-remote --exit-code origin "refs/heads/${branch}")"
read -r remote_head remote_ref extra <<<"$remote_line"
test -z "${extra:-}"
test "$remote_ref" = "refs/heads/${branch}"
test "$remote_head" = "$expected_head"
FRESHELL_PINNED_COORDINATOR_EXIT_CODE=0 \
  env --chdir="$root" "$adapter" accept "$attempt_id"

RECORDS="$records" PHASE=baseline HEAD_SHA="$expected_head" ATTEMPT_ID="$attempt_id" \
python3 -I - <<'PY'
import json
import os
from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


records = [json.loads(line) for line in Path(os.environ["RECORDS"]).read_text(encoding="utf-8").splitlines() if line]
attempt_id = os.environ["ATTEMPT_ID"]
attempts = [r for r in records if r.get("recordType") == "attempt" and r.get("attemptId") == attempt_id]
require(len(attempts) == 1, f"baseline selector requires one attempt {attempt_id}, found {len(attempts)}")
attempt = attempts[0]
target_digest = attempt.get("digest")
accepted = [r for r in records if r.get("recordType") == "acceptance" and r.get("phase") == os.environ["PHASE"] and r.get("expectedHead") == os.environ["HEAD_SHA"] and r.get("digest") == target_digest]
require(bool(accepted), f"no accepted baseline for HEAD {os.environ['HEAD_SHA']} and digest {target_digest!r}")
latest = accepted[-1]
require(latest.get("attemptId") == attempt_id, f"latest baseline acceptance links {latest.get('attemptId')!r}, expected {attempt_id}")
require(latest.get("coordinatorExitCode") == 0, f"baseline coordinator exit must be 0, got {latest.get('coordinatorExitCode')!r}")
require(attempt.get("outcome") == "cloud_succeeded", f"baseline attempt outcome is {attempt.get('outcome')!r}")
require(attempt.get("exitCode") == 0, f"baseline attempt exitCode is {attempt.get('exitCode')!r}")
require(attempt.get("createdJobImage") == attempt.get("image") == attempt.get("executionImage"), "baseline immutable image fields do not match")
require(attempt.get("jobCreated") is True and attempt.get("jobDeleted") is True, "baseline unique job was not created and deleted")
require(attempt.get("failureStage") is None and attempt.get("cleanupError") is None, "baseline successful attempt contains failure metadata")
require(attempt.get("succeededTasks") == 4 and attempt.get("failedTasks") == 0, "baseline task counts are not 4 succeeded and 0 failed")
print(f"latest accepted baseline: attempt={latest['attemptId']} digest={latest['digest']}")
PY
BASH
```

  A failed Electron or coordinator stage leaves the attempt record but creates
  no acceptance. A legitimate retry appends a new attempt; do not delete or
  rewrite earlier attempts merely to make counts look singular.
- [ ] Verify the latest accepted baseline record selected above links to an
  attempt with exact phase/branch/HEAD/digest, pre/post remote checks,
  `failureStage == null`, `cleanupError == null`,
  `createdJobImage == image == executionImage`, four successful/zero failed
  tasks, and successful unique-job deletion. Separately verify the persisted
  coordinator `test`/`full-suite` receipt has exact target paths, HEAD,
  environment-sourced summary, exit 0, and `isDirty=false`.
- [ ] If any baseline command fails, stop. Record command, status, and concise
  output; do not begin Task 2, call the failure pre-existing, or waive it.

**Task 1 success:** clean pushed plan-only HEAD; unchanged application source;
focused Rust/browser green; latest accepted baseline links a truthful successful
cloud attempt to a zero-exit coordinator run including Electron; prior failed
attempts, if any, remain preserved; no pull request opened.

### Task 2: Add authenticated real-route tests for rows, order, pages, and bytes

**Files**

- Modify/test only:
  `crates/freshell-server/src/session_directory.rs`.
- Read only: existing Rust contracts in `freshell-sessions`, `freshell-ws`,
  settings/metadata stores, fixtures, and current route tests.

**Steps**

- [ ] Add `#[cfg(test)] mod page_bound_tests` with Axum `Request`, `Body`,
  `StatusCode`, `Router`, `tower::ServiceExt`, `serde_json::{json, Value}`,
  `IndexedSession`, `SessionIndex`, and `SessionSource` imports.
- [ ] Add deterministic `StaticSessionSource` with fixed `direct_change_token`
  `Some(1)` and a cloned direct list. It must feed the real `SessionIndex`.
- [ ] Add `DirectoryRouteHarness` containing the real router, settings store,
  identity registry, metadata store, and temporary home. Use auth token `tok`.
- [ ] Add `indexed_row`, `provider_row`, `get_page_with_bytes`, `get_page`,
  `item_ids`, `item_keys`, and `page_cursor`. `get_page_with_bytes` must send
  `x-auth-token: tok`, require status `200`, collect the complete body, parse
  JSON, and return both the parsed value and original bytes.
- [ ] Add authenticated route tests for deleted-head backfill, title promotion,
  running promotion, live-only synthesis, known-session synthesis, deleted
  indexed re-synthesis, all eight visibility rows, cursor-chain traversal,
  five lookahead boundary tuples, full-key ties, archived recency order, and
  providerless revision. Each test must assert the literal table values above.
- [ ] Add the exact response-shape test. Compare the parsed object to the
  literal two-item object and the original body to the literal 599-byte body.
  Do not serialize an expected object to obtain expected bytes. Assert the
  absence of `total`, `totalCount`, `totalSessions`, `checkoutPath`,
  `titleSource`, and `sourceFile`.
- [ ] Add route tests for request revision ignored and all eight visibility
  combinations using eight literal expected arrays, not a loop that constructs
  expected values from the flag values.
- [ ] Run the new module and then the complete focused family. These are the
  first source tests and must be green against the unchanged route.
- [ ] Run `git diff --check` for the one Rust source file.
- [ ] Commit a normal source-only characterization checkpoint with the configured
  identity and required footer. Additional correction commits are allowed; no
  exact commit count is part of the plan.

**Task 2 success:** all row/order/page/byte assertions execute through the real
authenticated route, all existing applicable assertions remain, and the exact
literal result table is green before policy work begins.

### Task 3: Add authenticated real-route tests for cursors, search, partials, and edges

**Files**

- Modify/test only:
  `crates/freshell-server/src/session_directory.rs`.
- Read only: `freshell-sessions/src/search.rs`, existing fixtures, shared schema
  only for comparison, and current route/query tests.

**Steps**

- [ ] Add raw cursor payload fixtures for invalid Base64, invalid JSON, null,
  array, missing fields, wrong timestamp types, fractional/out-of-range values,
  wrong key type, and empty key. Every case must call the authenticated route,
  return status `400`, and compare the literal error body
  `{"error":"Invalid session-directory cursor"}`.
- [ ] Add the accepted extra-field cursor route case with literal payload
  `{"lastActivityAt":7,"key":"claude:session","extra":true}` and assert
  the empty page, `nextCursor=null`, and `revision=0`.
- [ ] Add real-route title tests for title/summary/first-user-message
  precedence, the exact 140-character snippet literal, title overrides, and
  the explicit negative project/cwd-leaf cases.
- [ ] Add real-route UserMessages and FullText fixtures with actual temporary
  transcript paths. Assert exact IDs, `matchedIn`, snippets, case-insensitivity,
  exhausted no-match omission of both partial fields, and cursor order.
- [ ] Add real-route missing-file, I/O-then-budget, and budget-before-no-source
  cases. Assert empty items, null cursor, revisions `100` or `1000`, exact
  `partial=true`, and exact `partialReason` values `io_error` or `budget`.
- [ ] Preserve every existing assertion that is still applicable. Replace a
  direct `apply_query` call with a route request and the same literal result,
  not with a new expected-value helper.
- [ ] Run exact cursor cases, all search/partial route cases, all page-bound
  route cases, and the complete focused family. Focused commands use only
  their Cargo arguments and absolute target paths.
- [ ] Run `git diff --check` and commit the green source-only characterization
  checkpoint. Do not publish a pull request.

**Task 3 success:** cursor, title search, deep search, partial precedence, and
edge results are fixed by literal authenticated-route observations, with no
production-equivalent expected-side logic.

### Task 4: Add borrowed types and mechanical accessors only

**Files**

- Modify/test only:
  `crates/freshell-server/src/session_directory.rs`.
- Read only: current `IndexedSession`, `TerminalIdentity`, search, settings, and
  metadata signatures.

**Allowed additions**

- [ ] Add the lifetime-bearing data types:
  `DirectoryInputs<'a>`, `IndexedOverlay<'a>`, `SynthesizedSessionId<'a>`,
  `DirectoryCandidateSource<'a>`, `DirectoryCandidate<'a>`,
  `DirectoryOrderKey<'a>`, `DecodedCursor`, `SearchAnnotation`,
  `SelectedCandidate<'a>`, and `CandidatePage<'a>`.
- [ ] Add only mechanical accessors that return already-captured fields:
  candidate activity/key fields, provider, effective title/summary/first user
  message, source path, subagent/non-interactive/running flags, and the source
  identity. Accessors may borrow and format a stable full key, but they must not
  compare, filter, search, select, materialize, serialize, or derive a page.
- [ ] Keep `DirectoryInputs` borrowing the one index slice, overrides map,
  metadata map, and identity slice. Do not clone the full corpus and do not add
  an owned fallback.
- [ ] Add no route change, no handler change, no comparator, no eligibility
  predicate, no search function, no selector, no page derivation, no
  materializer, no serializer, and no runtime switch.
- [ ] Run locked `cargo check` for `freshell-server` and locked inline-test
  compilation with `cargo test --no-run`. A failure stops and permits only a
  correction within this one-file type/lifetime scaffolding. It does not permit
  a second architecture, upstream API change, or manifest change.
- [ ] Run the unchanged focused family and commit only the type/scaffolding
  source change after it remains green.

**Task 4 success:** the borrowed type graph and mechanical accessors compile
against the locked APIs while the current route policy remains untouched.

### Task 5: Make one uninterrupted single-policy edit, cut over the handler, migrate every direct test, and delete the old policy

**Files**

- Modify/test only:
  `crates/freshell-server/src/session_directory.rs`.
- Read only: the Rust contracts, the literal Task 2/3 behavior table, fixtures,
  and current route tests.

**Mandatory edit boundary**

- [ ] Start from the clean Task 4 source checkpoint. Before the edit, record
  that the type scaffolding compiles. Then make one uninterrupted source edit.
  Do not compile or run tests between the first replacement and the completion
  of this edit. The edit must add the complete policy, cut over the real
  handler, migrate all direct tests listed above, remove the old policy
  inventory, and remove stale test helpers. Leave only the already-existing
  output representation needed to compile this single-policy checkpoint; Task
  6 performs the final output cleanup after its work-bound instrumentation is
  ready.

**Single policy to add in that one edit**

- [ ] Resolve each indexed row to a borrowed overlay. Preserve delete,
  title-source guard, empty-title fallback, summary, archive, metadata
  `sessionType`, and exact full-string key behavior.
- [ ] Build shallow candidates across the entire captured indexed slice and the
  supplied identity slice. Preserve indexed duplicates, first exact identity
  winner, first synthesized full-key winner, providerless skip, known-session
  and terminal-fallback IDs, live fields, and revision inputs.
- [ ] Decode the existing cursor format with the literal error
  `Invalid session-directory cursor`; accept required fields plus extra JSON
  fields; reject the exact invalid shapes in Task 3.
- [ ] Add the one ordering relation: descending `last_activity_at`, then
  descending full key. Use that same relation for sorting and strict cursor
  continuation. The implementation may contain the comparator; expected-side
  tests must contain the literal table values and no comparator expression.
- [ ] Add the one eligibility predicate for subagents, non-interactive rows,
  empty rows, running rows, and strict cursor continuation. No second predicate
  may be added in a test or compatibility wrapper.
- [ ] Add title search in the exact field order and exact literal snippet rules.
  Add deep search with the exact lookahead, budget, source, provider, increment,
  and I/O order and the exact partial precedence.
- [ ] Select in one pass after stable sorting. Retain at most `limit + 1`
  selected descriptors/annotations. Use the first `limit` only for consuming
  materialization and serialization. Derive `nextCursor` from the last returned
  row, never from a discarded row.
- [ ] Materialize only selected rows from the captured metadata map. Preserve
  every output field, omission, default, live field, and insertion order in the
  literal response fixture. Read project colors only after successful
  derivation, exactly where the old route did.
- [ ] Replace the handler body after auth/query validation with sequential
  captures: one awaited index snapshot, overrides, one awaited metadata map,
  identities, synchronous `derive_directory_page`, snapshot release, then
  success-only project colors. Preserve all early errors and status codes.

**Direct-test migration and deletion in the same edit**

- [ ] Migrate every test in the complete direct-test list above to indexed
  candidates or the authenticated route. The tests must retain their names and
  assertions unless the route assertion is stronger. Reuse only the single
  `encode_raw_cursor_payload`, `write_nonmatching_claude_transcript`, and
  `deep_search_query` helper definitions from Task 3; do not redefine them.
- [ ] Delete every symbol in the exact old-policy inventory. Delete
  `legacy_duplicate_items` and any other `DirItem`-literal helper that exists
  only to exercise the removed whole-list path. Delete `guard_item` and
  `overlaid_title` after their consumers use `IndexedSession` overlays.
- [ ] Keep the existing `DirItem` output representation only long enough for
  the single-policy checkpoint to compile. Do not add a compatibility policy or
  a second output path. Task 6 owns removal of legacy-only output fields,
  `DirItem::key`, and the final `Comparable` consumer.
- [ ] Ensure no old policy symbol is reintroduced under a new name and no
  test-only copy of the old policy exists. The only policy definitions left are
  the borrowed candidate policy and the existing transcript-search
  implementation in `freshell-sessions`.

**First checks after the uninterrupted edit**

- [ ] Run locked production `cargo check` and locked inline-test compilation.
  Stop on any failure; fix only this one-file design and rerun both checks.
- [ ] Run the complete focused `session_directory` family. Require all route
  characterizations and migrated tests green with the literal outcomes above.
- [ ] Run static residue checks against the source for every old-policy
  inventory name, old direct-helper call, and any second policy definition.
  Require all prohibited policy definitions absent. `DirItem::key` and the
  legacy-only output fields are intentionally checked and removed by Task 6,
  not by this checkpoint.
- [ ] Run `git diff --check`, commit the coherent source change with the
  configured identity/footer, and do not open a pull request.

**Task 5 success:** one compiled production policy is live; every direct old
helper test uses the new path or real route; the old whole-list policy and all
listed support symbols are deleted before the first post-edit compile/test; no
runtime switch or second policy exists.

### Task 6: Bound retained work, clean output, and prove the work limit

**Files**

- Modify/test only:
  `crates/freshell-server/src/session_directory.rs`.
- Read only: sandbox scripts/docs, Rust contracts, browser matrix, and the
  committed Task 5 source.

**Steps**

- [ ] Replace the complete legacy `DirItem` declaration with the final
  `#[derive(Debug)]` non-clone shape. Remove only the legacy-only
  `title_source` and `source_file` fields after static search proves no
  production or retained-test consumer remains.
- [ ] Replace the complete `impl DirItem` with one `to_value` serializer. Keep
  insertion order and optional-field omission exactly as characterized, start
  with `let mut object = Map::new();`, and place exactly one
  `record_preparation(|counts| counts.serializations += 1);` site in that
  serializer. Explicitly remove `DirItem::key`.
- [ ] Replace the final `Comparable::from(&DirItem)` projection with
  `format!("{}:{}", i.provider, i.session_id)`. Do not remove or alter the
  separate `IndexedSession::key` method or its consumer.
- [ ] Compile immediately after this output cleanup before adding counters or
  structural tests. A failure stops and permits only correction within the
  one-file design.
- [ ] Add test-only `PreparationCounts`, `PreparationScope`, and
  `record_preparation`. The scope is a request-level activation interval; it
  does not claim that index or metadata acquisition uses the same thread.
  Counters may be observed only after complete authenticated response-body
  collection.
- [ ] Instrument exactly one selector retained-peak site, one owned annotation
  site per annotation construction path, one indexed materializer site, one
  synthesized materializer site, and the single final serializer site.
- [ ] Add current-thread route tests that exercise every accepted limit
  `1..=MAX_DIRECTORY_PAGE_ITEMS` (`1..=50`) against oversized corpora of
  `MAX_DIRECTORY_PAGE_ITEMS + 2` rows for no-search, title, UserMessages, and
  FullText. Use literal response/page/cursor expectations; do not compare to a
  deleted path. Assert selected descriptors and owned annotations never exceed
  `limit + 1`, and full materializations/serializations never exceed `limit`.
- [ ] Include the exact boundary set
  `(0,1,0,false), (1,1,1,false), (2,1,1,true),
  (50,50,50,false), (51,50,50,true)` and an all-hidden case with empty items,
  no cursor, `revision=10000`, and zero materializations/serializations.
- [ ] Add the mandatory static post-capture locality/centrality proof. It must
  prove that index capture, overrides capture, metadata capture, and identity
  capture precede the one synchronous `derive_directory_page` call; that no
  await or recognized handoff occurs in the post-capture counted candidate
  subgraph, provider display helper, serializer, or transcript helper; that
  direct Tower/Axum polling and full-body completion precede counter snapshots;
  and that selector/materializer/serializer definitions and call sites exist
  exactly once. Acquisition-time offload before the boundary is allowed and is
  outside this proof.
- [ ] Run the runtime work-bound tests and the static proof. Both legs are
  mandatory; elapsed time, TLS alone, source spelling alone, allocator data,
  RSS, and latency are not substitutes.
- [ ] Run the full focused family after counter instrumentation. Require exact
  literal route bytes and all partial/search/visibility/cursor values unchanged.
- [ ] Run final locked production and inline-test compilation after all output
  cleanup. Run warnings-denied server and workspace Clippy, including the
  existing real-transport Codex/OpenCode targets.
- [ ] Run the destructive/all-target server package only through the repository
  sandbox. Use one self-contained tagless build with `--iidfile` from the target
  worktree, inspect that exact full image ID immediately, pass that ID through a
  command-scoped wrapper to the unchanged `scripts/sandbox-test.sh`, refuse its
  mutable-tag fallback build, postflight the same ID, propagate the test status,
  and remove only temporary filesystem wrappers/IID files. Do not delete images,
  tags, foreign processes, or containers. The command carries no Vitest-backend
  prefix.
- [ ] Run residue and exact-one-definition checks. Require no old-policy name,
  old field, `DirItem::key`, test-only second policy, alternate serializer,
  alternate materializer, or alternate selector.
- [ ] Commit the final source-only Task 6 checkpoint with the configured
  identity/footer. Do not open a pull request.

**Task 6 success:** the released single policy passes the exact route suite, the
runtime matrix and static locality proof establish the retained-work limits, the
output shape/bytes are unchanged, and the old path is absent.

### Task 7: Run final checks and the exact-final-HEAD pinned cloud suite

**Files and effects**

- Tracked repository file content modified by this task: none. Task 7 is
  validation-only for tracked files.
- Read: committed source/plan, Git state, external adapter/report/JSONL,
  manifests, browser config/spec, coordinator receipt, and sandbox evidence.
- External writes: append each final cloud attempt and, only after complete
  coordinator/Electron success, its linked acceptance record; write/remove a
  temporary attempt-ID handoff file.
- Remote/cloud effects: push the named final branch; build/push its image;
  create/execute one unique job per attempt; delete only that unique job on
  success and best-effort on failure. Never touch `freshell-vitest`.

**Steps**

- [ ] Prove the final source and plan are committed, the worktree is clean, the
  frozen base is an ancestor, and the only `base..HEAD` paths are the plan and
  `crates/freshell-server/src/session_directory.rs`. Prove all forbidden paths
  and old-policy definitions are absent from committed source.
- [ ] Run locked production and inline-test compilation, the complete focused
  Rust family, exact page-bound runtime/static tests, `cargo fmt --check`, and
  warnings-denied server/workspace/Codex/OpenCode Clippy. Focused commands use
  only absolute paths and their real tool arguments.
- [ ] Run the exact tagless immutable-ID sandbox package gate again from the
  final target worktree. Require the exact all-target workload to run against
  the image ID built from this final SHA.
- [ ] Run the exact Rust-backed browser matrix with the target worktree,
  `FRESHELL_E2E_BACKEND=local`, project `rust-chromium`, one worker, and the
  session-directory matrix spec. Require every case green.
- [ ] Check cloud auth/project access without mutation, using explicit
  `--project=misc-puttering-project`. Stop before paid work if refresh or access
  is unavailable.
- [ ] Run the literal final push, exact remote checks, adapter hash check,
  coordinator-owned `npm test`, post-run remote check, acceptance append, and
  latest accepted-record selection in one shell. `accept` is sequenced only
  after `npm test` exits zero, including local Electron:

```bash
bash <<'BASH'
set -euo pipefail
root=/home/dan/code/freshell/.worktrees/session-directory-lazy-page-prep
branch=the-usual/session-directory-lazy-page-prep
logroot=/home/dan/code/freshell/.worktrees/.the-usual-logs/session-directory-lazy-page-prep
adapter="${logroot}/pinned-vitest-cloud-v1.sh"
adapter_sha=4d65abf81f203293bc8045cffcb933cc4e0febfcad6859b1c7a494ada141bad3
records="${logroot}/pinned-cloud-runs.jsonl"
attempt_file="$(mktemp /tmp/freshell-final-attempt.XXXXXX)"
cleanup() { rm -f -- "$attempt_file"; }
trap cleanup EXIT

test "$(git -C "$root" branch --show-current)" = "$branch"
test -z "$(git -C "$root" status --porcelain=v1 --untracked-files=all)"
expected_head="$(git -C "$root" rev-parse HEAD)"
git -C "$root" push origin "HEAD:refs/heads/${branch}"
remote_line="$(git -C "$root" ls-remote --exit-code origin "refs/heads/${branch}")"
read -r remote_head remote_ref extra <<<"$remote_line"
test -z "${extra:-}"
test "$remote_ref" = "refs/heads/${branch}"
test "$remote_head" = "$expected_head"
test "$(sha256sum "$adapter" | awk '{print $1}')" = "$adapter_sha"

export FRESHELL_VITEST_BACKEND=cloud
export FRESHELL_VITEST_CLOUD_SCRIPT="$adapter"
export FRESHELL_PINNED_CLOUD_PHASE=final
export FRESHELL_PINNED_CLOUD_BRANCH="$branch"
export FRESHELL_PINNED_CLOUD_EXPECTED_HEAD="$expected_head"
export FRESHELL_PINNED_CLOUD_ADAPTER_SHA256="$adapter_sha"
export FRESHELL_PINNED_CLOUD_ATTEMPT_FILE="$attempt_file"
export FRESHELL_TEST_SUMMARY="session-directory lazy-page cloud final"

env --chdir="$root" INIT_CWD="$root" PWD="$root" \
  npm --prefix "$root" test

attempt_id="$(cat "$attempt_file")"
test -n "$attempt_id"
test -z "$(git -C "$root" status --porcelain=v1 --untracked-files=all)"
test "$(git -C "$root" rev-parse HEAD)" = "$expected_head"
remote_line="$(git -C "$root" ls-remote --exit-code origin "refs/heads/${branch}")"
read -r remote_head remote_ref extra <<<"$remote_line"
test -z "${extra:-}"
test "$remote_ref" = "refs/heads/${branch}"
test "$remote_head" = "$expected_head"
FRESHELL_PINNED_COORDINATOR_EXIT_CODE=0 \
  env --chdir="$root" "$adapter" accept "$attempt_id"

RECORDS="$records" HEAD_SHA="$expected_head" ATTEMPT_ID="$attempt_id" \
python3 -I - <<'PY'
import json
import os
from pathlib import Path


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


records = [json.loads(line) for line in Path(os.environ["RECORDS"]).read_text(encoding="utf-8").splitlines() if line]
attempt_id = os.environ["ATTEMPT_ID"]
attempts = [r for r in records if r.get("recordType") == "attempt" and r.get("attemptId") == attempt_id]
require(len(attempts) == 1, f"final selector requires one attempt {attempt_id}, found {len(attempts)}")
attempt = attempts[0]
target_digest = attempt.get("digest")
final_accepted = [r for r in records if r.get("recordType") == "acceptance" and r.get("phase") == "final" and r.get("expectedHead") == os.environ["HEAD_SHA"] and r.get("digest") == target_digest]
require(bool(final_accepted), f"no accepted final for HEAD {os.environ['HEAD_SHA']} and digest {target_digest!r}")
latest_final = final_accepted[-1]
require(latest_final.get("attemptId") == attempt_id, f"latest final acceptance links {latest_final.get('attemptId')!r}, expected {attempt_id}")
require(latest_final.get("coordinatorExitCode") == 0, f"final coordinator exit must be 0, got {latest_final.get('coordinatorExitCode')!r}")
require(attempt.get("outcome") == "cloud_succeeded", f"final attempt outcome is {attempt.get('outcome')!r}")
require(attempt.get("exitCode") == 0, f"final attempt exitCode is {attempt.get('exitCode')!r}")
require(attempt.get("createdJobImage") == attempt.get("image") == attempt.get("executionImage"), "final immutable image fields do not match")
require(attempt.get("jobCreated") is True and attempt.get("jobDeleted") is True, "final unique job was not created and deleted")
require(attempt.get("failureStage") is None and attempt.get("cleanupError") is None, "final successful attempt contains failure metadata")
require(attempt.get("succeededTasks") == 4 and attempt.get("failedTasks") == 0, "final task counts are not 4 succeeded and 0 failed")
baseline_accepted = [r for r in records if r.get("recordType") == "acceptance" and r.get("phase") == "baseline"]
require(bool(baseline_accepted), "no accepted baseline record exists")
latest_baseline = baseline_accepted[-1]
require(latest_baseline.get("expectedHead") != latest_final.get("expectedHead"), "baseline and final accepted records use the same HEAD")
require(latest_baseline.get("digest") != latest_final.get("digest"), "baseline and final accepted records use the same digest")
print(f"latest accepted final: attempt={latest_final['attemptId']} digest={latest_final['digest']}")
print(f"latest accepted baseline: attempt={latest_baseline['attemptId']} digest={latest_baseline['digest']}")
PY
BASH
```

  A failed coordinator or Electron stage preserves its cloud attempt without an
  acceptance. Retrying appends another attempt; never delete prior attempts to
  force a one-record count.
- [ ] Verify the latest accepted final selected above links to exact
  phase/branch/HEAD/digest, pre/post remote checks,
  `failureStage == null`, `cleanupError == null`,
  `createdJobImage == image == executionImage`, four successful/zero failed
  tasks, and successful unique-job deletion. Verify latest accepted baseline
  and final have different HEADs and digests. Separately verify the persisted
  coordinator receipt has `summarySource=env`, successful `test`/`full-suite`,
  exact `npm test` shape, target paths, final HEAD, and `isDirty=false`.
- [ ] Run `git diff --check`, final exact-scope/forbidden-file checks, and a
  clean-state check. Do not create a pull request or merge in this task.

**Task 7 success:** every focused, browser, sandbox, lint, compilation, static,
coordinator, cloud, Electron, provenance, and scope gate passes against the
exact final pushed SHA; latest accepted baseline/final evidence is distinct;
all retry attempts remain truthful; no pull request has been opened.

## Amendment self-review checklist

This section is a plan review, not an execution attestation:

- [ ] Exactly seven numbered Task headings exist, with the required lifecycle.
- [ ] Task 2 and Task 3 expected-result tests use the real authenticated route.
- [ ] All expected order/cursor/search/visibility/page/revision/snippet/partial
  values are literal fixture values.
- [ ] Task 4 contains only borrowed types, lifetimes, and mechanical accessors.
- [ ] Task 5 performs one uninterrupted policy/cutover/migration/deletion edit
  before the first post-edit compile/test.
- [ ] The exact old-policy deletion inventory and every direct test name are
  present.
- [ ] Task 6 has both runtime retained-work limits and static post-capture
  locality/centrality proof, without a deleted-path comparison.
- [ ] Task 1 and Task 7 broad suites use cloud plus the reviewed external
  adapter; focused commands do not select a fake local Vitest backend.
- [ ] The adapter body passes `bash -n` and ShellCheck and its recorded SHA is
  `4d65abf81f203293bc8045cffcb933cc4e0febfcad6859b1c7a494ada141bad3`.
- [ ] Task 1/7 include literal push and `ls-remote` checks, required branch and
  expected-HEAD inputs, immediate adapter-hash checks, exact created-job-image
  evidence, required unique-job deletion, post-run remote checks, retry-safe
  attempt preservation, and acceptance only after coordinator/Electron success.
- [ ] No plan step opens a pull request, merges, deploys, or restarts a server.
- [ ] No product/runtime command was run while making this amendment.

**Honest status at amendment return:** `0/7 tasks completed; no application code
changed; no paid cloud job run; no commit or push performed by this amendment
agent; recipe state untouched.`
