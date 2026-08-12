# Page-Bounded Session Directory Requests — Hardened Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `subagent-driven-development`
> (recommended) or `executing-plans` to implement this plan task-by-task. Use a
> fresh reviewer gate after each commit. Steps use checkbox (`- [ ]`) syntax.

**Goal:** For no-query and title-tier Rust session-directory requests, preserve
completed full-application Axum responses for the same validated request and
identical captured Rust inputs—exact status, normalized `content-type`, and raw
JSON body bytes—while constructing and performing the named full-row decoration
stages on exactly the returned indexed/synthesized rows
(`returned_items <= effective_limit <= 50`). Both production selectors must use
the corrected Fast strategy before completion. This plan makes no numeric
production-latency claim.

**Architecture:** Task 0 first records an ownership-safe, no-process authority
from exact pinned-parent source/fixture blobs, then proves its behavior-neutral
seams through deterministic in-process owner/full-layer raw fixtures and freezes
an independently reviewable pre-extraction
parent authority while the handler derivation is still inline. Task 1 proves that
authority unchanged, extracts the Materialized strategy, and freezes that second
authority in a separate commit. Fast selection keeps indexed rows and live
identities as borrowed/lightweight descriptors through dedupe, filtering,
ordering, cursor handling, title matching, and a descriptor-only `limit + 1`;
only returned rows pass through mechanically inventoried and instrumented
full-row constructors. Nonempty `userMessages` and `fullText` queries remain
Materialized. G1 compatibility, compile-valid mutation sensitivity, exact debug
G2 work accounting, and finite instrumentation-free release G3 precede isolated
no-query and title selector commits. Task 0A is the one additional
comment/API-documentation-only task required by the shared contract decision.

**Tech Stack:** Rust 1.96 workspace MSRV, Axum, existing
`serde_json`/`SessionIndex`, TypeScript/Zod shared API source, debug-only test
ledgers, Cargo debug/release tests, and strict marker-aware/NUL-safe Git guards.
No dependency or Cargo-feature addition.

---

## Global Constraints

### Shared Node/Rust compatibility contract (scope 1)

- Preserve the complete declared Node/Rust REST parity comparator: status;
  headers of interest (`content-type`, `cache-control`, `x-frame-options`,
  `content-security-policy`, `content-security-policy-report-only`,
  `x-qa-marker`); and body equality under the existing normalized
  semantic/deviation rules (`port/oracle/rest-parity/sweep.mjs:420-427,447-500`;
  `port/HANDOFF.md:453-470,542-560,674-680`).
- The sole new shared statement is behavior-neutral documentation near
  `SessionDirectoryPageSchema` in `shared/read-models.ts`: independent state
  owners are not one atomic or linearizable snapshot, and wall-clock capture
  timing is not guaranteed under concurrent writes.
- That comment is the only permitted shared/client-area change. It changes no
  Zod expression, TypeScript type, request/response field, Node route, client
  logic, owner behavior, or wire schema. The implementation plan is not the
  sole documentation location.
- Do not introduce canonical Node/Rust JSON key order or cross-server raw-body
  equality. The tracked parity result already permits different object-key
  insertion order (`port/oracle/rest-parity/results-2026-07-12.json:4213-4277`).
- Response `revision` remains a potentially decreasing maximum of captured
  activity timestamps. It is not a generation, monotonic version, or pin.
  Request `revision` gains no snapshot-selection or pinning meaning.

### Rust-local completed-response proof (scope 2)

- For one validated request and identical
  `(IndexCapture::{NoIndex, Snapshot(rows)}, overrides, metadata,
  ordered_identities)`, FrozenOld, ExtractedMaterialized, and Fast must produce
  the same Rust status, normalized `content-type`, and raw JSON body bytes.
- `NoIndex` and `Snapshot(&[])` are distinct captures. Identity vector order is
  observable: current joins choose the first exact identity and synth dedupe
  chooses the first full-key winner.
- Explicit A-then-B and B-then-A winner permutations are fixed-capture evidence
  only: tests construct those exact identity vectors in
  `CapturedDirectoryInputs`/`OwnedDirectoryInputs` and force FrozenOld,
  ExtractedMaterialized, and Fast. The concrete owner-backed route makes no
  requested `TerminalIdentityRegistry::list()` order claim. Its reviewed raw
  winner case contains one matching identity; a separate relational owner
  assertion derives the expected first winner from `list()` on the same
  unchanged registry. Do not add a production sort, owner seam/fake, or retry.
- Project colors are acquired and injected only after successful derivation.
  Derivation errors assert zero color reads. Query-shape validation failures
  remain before the strategy seam and are proven by owner-backed raw-route
  fixtures, not mislabeled as strategy differentials.
- Targeted completed-response tests use the same
  `with_full_application_layers` function as production, after charset,
  rate-limit, and request-logging middleware and before Hyper/transport
  framing. Compare the stable header set exactly as
  `{content-type: application/json; charset=utf-8}`. Exclude `date`, `server`,
  `content-length`, `transfer-encoding`, `connection`, and other
  transport/dynamic headers.
- Rust exact raw bytes are an old/extracted/Fast invariant only. They neither
  replace nor strengthen the declared Node/Rust normalized comparator.

### Rust accessor-order guard (scope 3)

- After query validation: record `NoIndex` without calling `snapshot()`, or
  await and retain the exact index snapshot; then clone/read overrides,
  metadata, and ordered identities in that order
  (`I-or-NoIndex -> O -> M -> L`). Read colors only after successful page
  derivation (`-> P`).
- This is accessor invocation and returned-value order, not disk-observation or
  wall-clock timing. `maybe_reload_overrides()` timing is not promised.
  Builders read no mutable owner. Do not add sleeps, conversion padding,
  duplicate reads, retries for a newer snapshot, or timing imitation.

### Wire and selection behavior that may not change

- Keep `MAX_DIRECTORY_PAGE_ITEMS = 50`; effective limit remains
  `q.limit.unwrap_or(50).min(50)` after validation guarantees `1..=50`.
- Keep page keys and presence rules: `items`, `nextCursor`, `revision`, optional
  `partial: true`, optional `partialReason` (`budget` or `io_error`), and
  optional nonempty `projectColors`.
- Keep item insertion order from `DirItem::to_value`: `sessionId`, `provider`,
  `projectPath`, `lastActivityAt`, `isRunning`, `archived`, then existing
  optionals in current order. Workspace `serde_json` uses `preserve_order`.
- Keep exact cursor format, strict suffix comparison, error strings, stable
  duplicate ordering, full-string `provider:sessionId` semantics (including
  colon collisions), first identity winner, visibility ordering, title field
  precedence, 140-Unicode-scalar snippet truncation, revision formula, and
  partial file-search behavior.
- A missing or blank query follows the no-query selector regardless of tier.
  Only a **nonempty** `userMessages` or `fullText` query remains Materialized.

### Exact named-work contract (successful Fast responses only)

For every successful Fast response, tests independently label returned fixture
rows by provenance and assert:

```text
returned_items = returned_indexed + returned_synth
indexed_full        == returned_indexed
synthesized_full    == returned_synth
override_decoration == returned_indexed
metadata_decoration == returned_indexed
running_decoration  == returned_indexed
item_serialization  == returned_indexed + returned_synth
title_annotation    == returned_items for a nonempty Title query, otherwise 0
full_row_clone      == 0
returned_items      <= effective_limit <= 50
```

- The first seven named stages have exact equality and no slack. The additional
  `full_row_clone == 0` closes the independent Clone construction path.
- Error responses use separate zero/partial-operation assertions; they never
  masquerade as successful-page equations.
- The `limit + 1` lookahead is always a descriptor. It is never constructed,
  decorated, annotated, cloned, or serialized as a `DirItem`.
- Replace `DirItem`'s derived `Clone` with a manual, behavior-equivalent
  `Clone` implementation whose debug-only bump makes every full-row clone
  observable. Fast code must not clone a `DirItem`; legacy tests may still use
  the instrumented implementation.
- Define the Fast full-row audit once and reuse it in every static G2 test.
  Its exact counted producer allowlist is
  `dir_item_from_indexed`, `build_live_terminal_session_item`, and the manual
  `impl Clone for DirItem`; mark them with unique
  `SESSION_DIRECTORY_FULL_ROW_PRODUCER_BEGIN/END:<indexed|synth|clone>` regions.
  The first two are the only constructors Fast may reach; manual Clone remains
  globally instrumented but is forbidden from every Fast call chain.
- The exact non-producing/delegating `DirItem` helper allowlist is
  `materialize_selected_descriptor` and `annotate_selected_title_match`, marked
  with unique
  `SESSION_DIRECTORY_FAST_DIR_ITEM_HELPER_BEGIN/END:<materialize|annotate>`
  regions. `materialize_selected_descriptor` may delegate directly to exactly
  one of the indexed/synth producers and contains no literal or clone token.
  `annotate_selected_title_match` consumes and returns the same by-value item,
  may call neither a producer nor another `DirItem`-returning helper, and
  contains no literal or clone token. An ordinary `DirItem` parameter, local,
  enum payload, field access, or declared return type is not production by
  itself and is allowed inside these audited helpers.
- Enclose Fast code in exactly one
  `SESSION_DIRECTORY_FAST_PATH_BEGIN/END` region. A test-only fail-closed Rust
  lexical scanner strips comments and string/character/raw-string literals,
  rejects malformed/unterminated input or duplicate/missing markers, and emits
  identifier/punctuation tokens. From those tokens it enforces one rule set:
  direct `DirItem {`/`Self {` construction is legal only in the matching marked
  producer; `DirItem::clone`, `Clone::clone`, `.clone()`/`.clone_from()`,
  iterator `.cloned()`, and `ToOwned::to_owned` are legal only inside the marked
  manual Clone producer and are forbidden in the Fast region and both helper
  regions; every Fast-local function declaring `DirItem`/`Option<DirItem>` as a
  return and every call to such a function must resolve to the exact producer or
  helper allowlist; producer calls are legal only from
  `materialize_selected_descriptor`; and the recursively resolved helper call
  graph may reach only the indexed/synth producers through that delegator.
  Any unmarked or unknown `DirItem`-returning function/call, indirect
  constructor, clone path, function pointer, macro invocation producing a row,
  or unresolved local call fails closed. This permits required non-producing
  returns while rejecting every uncounted full-row production path.
- The one-returned-indexed-row/500-identity countermodel must compile under the
  mutation harness, produce unchanged response bytes, record 500 extra clones,
  and fail the exact zero-clone/static-constructor G2 test. Returned-row and
  serialization counts remain exact with no tolerance.
- Ledger type/state, bump helpers and calls, smoke/G2 tests, and reset/read
  helpers use `#[cfg(all(test, debug_assertions))]`. Release G3 contains no
  ledger symbol or runtime instrumentation flag.

### Honest performance scope

Unverified motivation only: an observed 80–130 ms/request figure has no linked
commit, build, host, warm/cold state, request mix, sample count, or percentile
provenance. This plan neither attributes it to this handler nor promises a
numeric production improvement.

Residual work remains corpus-, live-set-, map-, or byte-dependent:

- index acquisition and cold refresh;
- complete override, metadata, identity, and color snapshots/clones;
- metadata flattening and canonical-key creation/allocation;
- deleted/filtered/title scans over indexed rows;
- synth descriptor/key creation, first-winner dedupe, suppression, and sort;
- ASCII byte scans and non-ASCII lowercase/text-byte allocation/work;
- page-row identity lookup;
- project-color serialization; and
- retained Materialized file-tier construction and transcript search.

Only the all-ASCII `contains_ci` branch may be described as avoiding lowercase
allocation. G3 is a finite synthetic relative non-regression check, not
telemetry, a production workload distribution, a speedup claim, or an SLA.
Optional production profiling may motivate a separate plan; it is neither a
hidden blocker nor deferred completion work here.

### File and process scope

Allowed implementation files are exactly:

| File | Allowed change |
|---|---|
| `shared/read-models.ts` | Task 0A's exact comment immediately above `SessionDirectoryPageSchema`; no executable/schema edit. This is the only shared/client-area change. |
| `crates/freshell-server/src/session_directory.rs` | Authorities, captures, response renderer, accessor trace, manual instrumented `DirItem::Clone`, legacy fixtures, borrowed candidate, ledgers, G1/G2/G3, mutation anchors/tests, selectors. |
| `crates/freshell-server/src/main.rs` | Exactly one behavior-neutral `with_full_application_layers` assembler and replacement of the existing inline production layer chain by one call. No route/state/policy movement. |

No new tracked file. Task 0's uniquely owned detached pinned-parent worktree and
Task 7's detached mutation worktree are validation scratch only. Task 0 runs no
binary/build/provider scan, reads only committed blobs, tracks ownership with an
explicit post-add flag, and removes the worktree non-forcibly only after exact
path/HEAD/registration/clean checks. Both scratch worktrees must remain
source-clean and be removed non-forcibly after their evidence is recorded. Do not change any `Cargo.toml`, dependency,
feature, owner/index/TTL or sweep API, polling, persistence, cursor/wire schema,
Node implementation,
client logic, fixture/script/benchmark file, `.kata.toml`, or another document.
Do not create a PR or restart the live port-3001 server. Both final selector
commits are required and reversible; an undispatched candidate is incomplete.

Red-Green-Refactor applies to behavior tasks. Evidence/comment-only tasks do
not manufacture a false RED. A test-only gate that finds a production defect
returns to its owning behavior task and commit boundary.

---

## Current Pipeline and Structural Correctness Argument

Current source at parent `fc8646477dd34d92dc5647d158106431aa2e0380`:

1. `crates/freshell-server/src/session_directory.rs:381-455` validates, snapshots
   the already sorted index, and converts every indexed row.
2. `apply_session_overrides` (`:740-778`) removes typed `deleted:true` rows and
   overlays title/summary/archive; `apply_session_metadata` (`:786-804`) joins
   `sessionType`.
3. `join_running_state`, `build_live_terminal_session_item`, and
   `join_live_terminals` (`:844-938`) join the first ordered identity, construct
   live-only rows, first-winner dedupe by full key, and append synth rows.
4. `apply_query` (`:1175-1294`) computes revision, stable-sorts timestamp DESC
   then full key DESC, applies flags/cursor/search, and pages.
5. `apply_title_search` (`:1374-1391`) selects title/summary/first message and
   truncates the chosen field to 140 Unicode scalars. File tiers use
   `apply_file_search` (`:1317-1368`) and
   `crates/freshell-sessions/src/search.rs`.

The Fast architecture is valid only under one immutable capture whose index is
sorted by `(last_activity_at DESC, exact full key DESC)` and whose validated
limit is `1..=50`:

- Decoration cannot change existing-row sort keys. Stable filtering preserves
  exact duplicate source ordinals.
- Synth descriptors contain every membership/order datum, preserve identity
  vector first-winner order, suppress against nondeleted indexed full keys,
  stable-sort, and choose indexed on exact merge equality.
- The strict cursor predicate is a suffix of the descending stream, including
  arbitrary valid cursors and duplicate-tuple legacy gaps.
- Visibility and title match are row-local when they use override-effective
  borrowed fields and exact component-pair running membership.
- Revision is exactly
  `max(0, first nondeleted indexed timestamp, every identity.updated_at)`.
- After `limit + 1` selected descriptors, the first `limit`, `has_more`, and
  cursor are fixed. A carried `TitleMatchField` allows annotation without a
  second rejecting search. Materialization must therefore have no normal
  post-selection rejection branch.

Finite tests instantiate this argument; they do not turn finite sampling into a
universal proof.

---

## Compatibility Proof Taxonomy

1. **Task-0 parent authority:** ownership-safe pinned-parent source/fixture blob
   authority with a mandatory no-process/no-network fallback, deterministic
   order-insensitive/single-identity in-process owner/full-layer raw literals
   plus a same-unchanged-registry relational owner-acquisition assertion,
   immutable case manifest/builders, actual owner-backed route executor, capture
   types, FrozenOld page, response renderer, all local transitive legacy
   constants/types/helpers/ledger sites, whole external file search, and the
   full-layer assembler/production call.
2. **Task-1 extracted authority:** only `materialized_page` and
   `materialized_dispatch`, committed after unchanged Task-0 evidence.
3. **Exhaustive finite evidence:** FrozenOld/ExtractedMaterialized/Fast values
   and direct renderer bytes; no full middleware per exhaustive capture.
4. **Targeted completed evidence:** explicit fixed-capture strategy applications,
   including both A/B winner permutations, plus deterministic actual
   owner-backed routes through real full-application layers. Requested owner
   iteration order is not part of the raw authority.
5. **G2:** exact successful-Fast work equations plus clone/constructor audits.
6. **Mutation evidence:** exact compile-valid source edits whose declared
   Fast/selector killer fails.
7. **Declared Node/Rust parity:** unchanged full normalized comparator; never a
   substitute for Rust raw bytes.

---

## Exact Interfaces and Ownership

### Parent capture, renderer, and completed response

```rust
#[derive(Clone, Copy)]
enum IndexCapture<'a> {
    NoIndex,
    Snapshot(&'a [IndexedSession]),
}

impl<'a> IndexCapture<'a> {
    fn rows(self) -> &'a [IndexedSession] {
        match self {
            Self::NoIndex => &[],
            Self::Snapshot(rows) => rows,
        }
    }
}

#[derive(Clone, Copy)]
struct CapturedDirectoryInputs<'a> {
    index: IndexCapture<'a>,
    overrides: &'a Map<String, Value>,
    metadata: &'a std::collections::HashMap<String, Value>,
    identities: &'a [freshell_ws::identity::TerminalIdentity],
}

fn directory_result_response<F>(
    result: Result<Value, String>,
    project_colors: F,
) -> Response
where
    F: FnOnce() -> Map<String, Value>;

#[cfg(test)]
fn frozen_pre_extraction_page(
    inputs: CapturedDirectoryInputs<'_>,
    q: &DirQuery,
) -> Result<Value, String>;

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
struct CompletedJsonResponse {
    status: axum::http::StatusCode,
    content_type: String,
    body: Vec<u8>,
}

#[cfg(test)]
async fn collect_completed_json_response(response: Response) -> CompletedJsonResponse;
```

`directory_result_response` calls the color closure only in `Ok`, inserts a
nonempty map in current order, and preserves current success/error serialization.
Query validation remains outside it.

The only `main.rs` seam is:

```rust
pub(crate) fn with_full_application_layers(
    app: Router,
    rate_limiter: Arc<rate_limit::RateLimiter>,
) -> Router;

#[cfg(test)]
fn non_throttling_test_limiter() -> Arc<rate_limit::RateLimiter>;
```

The test helper uses the real limiter with `rate_limit::TestClock` and
`RateLimitConfig { capacity: 1_000_000_000_000.0, refill_per_sec: 0.0 }`.
No middleware mock replaces charset, limiter, or logging.

### Extracted capture and strategy seam

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DirectoryStrategy {
    Materialized,
    Fast,
}

enum OwnedIndexCapture {
    NoIndex,
    Snapshot(Arc<Vec<IndexedSession>>),
}

struct OwnedDirectoryInputs {
    index: OwnedIndexCapture,
    overrides: Map<String, Value>,
    metadata: std::collections::HashMap<String, Value>,
    identities: Vec<freshell_ws::identity::TerminalIdentity>,
}

impl OwnedDirectoryInputs {
    fn as_borrowed(&self) -> CapturedDirectoryInputs<'_>;
}

async fn capture_directory_inputs(state: &SessionDirectoryState) -> OwnedDirectoryInputs;

fn materialized_page(
    inputs: CapturedDirectoryInputs<'_>,
    q: &DirQuery,
) -> Result<Value, String>;

fn materialized_dispatch(
    inputs: CapturedDirectoryInputs<'_>,
    q: &DirQuery,
) -> Result<Value, String>;

fn build_directory_page(
    inputs: CapturedDirectoryInputs<'_>,
    q: &DirQuery,
) -> Result<Value, String>;
```

`materialized_dispatch` is one line and freezes with `materialized_page`.
`build_directory_page`, owner capture, selector, and Fast code are not part of
the Task-1 authority.

Comparison-only interfaces force a strategy independently of production selector
state:

```rust
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ComparisonStrategy {
    FrozenOld,
    ExtractedMaterialized,
    Fast,
}

#[cfg(test)]
fn completed_strategy_app(
    strategy: ComparisonStrategy,
    inputs: Arc<OwnedDirectoryInputs>,
    q: Arc<DirQuery>,
    project_colors: Arc<Map<String, Value>>,
) -> Router;
```

It uses `directory_result_response` and `with_full_application_layers`, reads no
owner, and is complemented by Task 0's actual owner-backed
`session_directory::router(state)` executor.

The shared fixed identity-permutation table owns exact `[A, B]` and `[B, A]`
vectors. `g1_completed_strategy_matrix_old_extracted_fast` runs both through
`completed_strategy_app`; no registry participates in those completed-byte cases.

### Borrowed title and candidate interfaces

```rust
fn contains_ci(haystack: &str, needle_lower: &str) -> bool;

fn key_cmp(
    provider: &str,
    session_id: &str,
    other_full_key: &str,
) -> std::cmp::Ordering;

fn canonical_identity_key(provider: &str, session_id: &str) -> String;
fn is_deleted(overrides: &Map<String, Value>, full_key: &str) -> bool;

fn effective_title<'a>(
    indexed: &'a IndexedSession,
    override_row: Option<&'a Map<String, Value>>,
) -> Option<&'a str>;

fn effective_summary<'a>(
    indexed: &'a IndexedSession,
    override_row: Option<&'a Map<String, Value>>,
) -> Option<&'a str>;

fn provider_display_name_borrowed(provider: &str) -> &str;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TitleMatchField {
    Title,
    Summary,
    FirstUserMessage,
}

fn title_match_field(
    title: Option<&str>,
    summary: Option<&str>,
    first_user_message: Option<&str>,
    needle_lower: &str,
) -> Option<TitleMatchField>;

fn annotate_selected_title_match(item: DirItem, field: TitleMatchField) -> DirItem;

struct SynthDescriptor<'identity> {
    identity: &'identity freshell_ws::identity::TerminalIdentity,
    full_key: String,
}

#[derive(Clone, Copy)]
enum CandidateRef<'rows, 'identity> {
    Indexed(&'rows IndexedSession),
    Synth(&'rows SynthDescriptor<'identity>),
}

#[derive(Clone, Copy)]
struct SelectedDescriptor<'rows, 'identity> {
    candidate: CandidateRef<'rows, 'identity>,
    title_match: Option<TitleMatchField>,
}

struct DescriptorPage<'rows, 'identity> {
    rows_with_lookahead: Vec<SelectedDescriptor<'rows, 'identity>>,
    revision: i64,
    limit: usize,
}

fn synthesized_descriptors<'identity>(
    indexed: &[IndexedSession],
    overrides: &Map<String, Value>,
    identities: &'identity [freshell_ws::identity::TerminalIdentity],
) -> Vec<SynthDescriptor<'identity>>;

fn candidate_full_key(candidate: CandidateRef<'_, '_>) -> String;
fn candidate_last_activity(candidate: CandidateRef<'_, '_>) -> i64;
fn candidate_order(
    left: CandidateRef<'_, '_>,
    right: CandidateRef<'_, '_>,
) -> std::cmp::Ordering;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MergeSide {
    Indexed,
    Synth,
}

fn choose_merge_side(
    indexed: CandidateRef<'_, '_>,
    synthesized: CandidateRef<'_, '_>,
) -> MergeSide;

fn cursor_allows_candidate(
    candidate: CandidateRef<'_, '_>,
    cursor: Option<&(i64, String)>,
) -> bool;
fn candidate_is_subagent(candidate: CandidateRef<'_, '_>) -> bool;
fn candidate_is_non_interactive(candidate: CandidateRef<'_, '_>) -> bool;
fn candidate_is_nonempty(
    candidate: CandidateRef<'_, '_>,
    overrides: &Map<String, Value>,
    identities: &[freshell_ws::identity::TerminalIdentity],
) -> bool;
fn candidate_is_visible(
    candidate: CandidateRef<'_, '_>,
    q: &DirQuery,
    overrides: &Map<String, Value>,
    identities: &[freshell_ws::identity::TerminalIdentity],
) -> bool;
fn fast_revision(
    indexed: &[IndexedSession],
    overrides: &Map<String, Value>,
    identities: &[freshell_ws::identity::TerminalIdentity],
) -> i64;
fn matching_identity<'a>(
    identities: &'a [freshell_ws::identity::TerminalIdentity],
    provider: &str,
    session_id: &str,
) -> Option<&'a freshell_ws::identity::TerminalIdentity>;

fn merge_page_descriptors<'rows, 'identity>(
    indexed: &'rows [IndexedSession],
    synthesized: &'rows [SynthDescriptor<'identity>],
    inputs: CapturedDirectoryInputs<'_>,
    q: &DirQuery,
) -> Result<DescriptorPage<'rows, 'identity>, String>;

fn materialize_selected_descriptor(
    selected: SelectedDescriptor<'_, '_>,
    inputs: CapturedDirectoryInputs<'_>,
) -> DirItem;

fn materialize_fast_page(
    descriptor_page: DescriptorPage<'_, '_>,
    inputs: CapturedDirectoryInputs<'_>,
    title_query: Option<&str>,
) -> Value;

fn fast_path_page(
    inputs: CapturedDirectoryInputs<'_>,
    q: &DirQuery,
) -> Result<Value, String>;
fn derive_directory_page(
    strategy: DirectoryStrategy,
    inputs: CapturedDirectoryInputs<'_>,
    q: &DirQuery,
) -> Result<Value, String>;
fn select_directory_strategy(q: &DirQuery) -> DirectoryStrategy;
```

Ownership and algorithm rules:

- `Vec<SynthDescriptor>` owns only canonical full-key strings and borrows the
  ordered identity capture. It chooses the first identity per full key before
  suppression against every nondeleted indexed full key.
- `CandidateRef` and `SelectedDescriptor` borrow indexed rows or synth
  descriptors. `DescriptorPage` owns at most `limit + 1` references plus
  scalars. No reference escapes `fast_path_page`.
- Indexed order is the captured snapshot order. Synth order is stable under the
  legacy comparator. `choose_merge_side` chooses Indexed for Less or Equal and
  Synth only for Greater under the canonical comparator.
- Decode the cursor before descriptor construction/selection. In
  `merge_page_descriptors`, bind `let overrides = inputs.overrides;` and
  `let identities = inputs.identities;`, reject typed deletion first, then call
  `candidate_is_visible(candidate, q, overrides, identities)`. For Indexed,
  `candidate_is_nonempty` looks up the exact full-key override object and uses
  `effective_title(indexed, override_row)` plus exact-component running
  membership; for Synth it returns true because every synth descriptor denotes
  a running row and synth rows never receive override decoration. Then apply the
  strict cursor suffix and optional override-effective Title match before
  pushing a descriptor. No visibility helper may inspect only the raw indexed
  title or omit the captured override view.
- Store the first matching `TitleMatchField` on selection. Materialization calls
  only the two named constructors for `.take(limit)`, decorates each returned
  indexed row exactly once, annotates from the carried field, serializes once,
  and cannot `continue`, filter, or otherwise reject a selected row.
- `contains_ci` receives an already-lowercased needle. For non-ASCII haystacks it
  executes legacy lowercase semantics; only the all-ASCII branch avoids
  lowercase allocation.
- `candidate_full_key` may allocate; that cost is explicitly residual. It must
  compare conceptual `format!("{provider}:{session_id}")` bytes exactly.

Task 4 introduces this all-Materialized selector and leaves it unchanged until
Tasks 9 and 10:

```rust
fn select_directory_strategy(q: &DirQuery) -> DirectoryStrategy {
    let has_query = q
        .query
        .as_deref()
        .map(str::trim)
        .is_some_and(|query| !query.is_empty());
    match (has_query, q.tier) {
        (false, _) => DirectoryStrategy::Materialized,
        (true, Tier::Title) => DirectoryStrategy::Materialized,
        (true, Tier::UserMessages | Tier::FullText) => DirectoryStrategy::Materialized,
    }
}
```

Task 9 changes only `(false, _)`; Task 10 changes only nonempty Title. The file
line remains the exact mutation anchor.

### Debug work ledger and clone closure

```rust
#[cfg(all(test, debug_assertions))]
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct DirectoryWorkLedger {
    indexed_full: usize,
    synthesized_full: usize,
    override_decoration: usize,
    metadata_decoration: usize,
    running_decoration: usize,
    title_annotation: usize,
    item_serialization: usize,
    full_row_clone: usize,
}

#[cfg(all(test, debug_assertions))]
impl DirectoryWorkLedger {
    const ZERO: Self = Self {
        indexed_full: 0,
        synthesized_full: 0,
        override_decoration: 0,
        metadata_decoration: 0,
        running_decoration: 0,
        title_annotation: 0,
        item_serialization: 0,
        full_row_clone: 0,
    };
}

#[cfg(all(test, debug_assertions))]
std::thread_local! {
    static DIRECTORY_WORK_LEDGER: std::cell::Cell<DirectoryWorkLedger> =
        const { std::cell::Cell::new(DirectoryWorkLedger::ZERO) };
    static DIRECTORY_WORK_SCOPE_ACTIVE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

#[cfg(all(test, debug_assertions))]
fn reset_directory_work_ledger_for_current_thread() {
    DIRECTORY_WORK_LEDGER.set(DirectoryWorkLedger::ZERO);
}

#[cfg(all(test, debug_assertions))]
fn read_directory_work_ledger_for_current_thread() -> DirectoryWorkLedger {
    DIRECTORY_WORK_LEDGER.get()
}

#[cfg(all(test, debug_assertions))]
fn update_active_directory_work_ledger(
    update: impl FnOnce(&mut DirectoryWorkLedger),
) {
    if !DIRECTORY_WORK_SCOPE_ACTIVE.get() {
        return;
    }
    DIRECTORY_WORK_LEDGER.with(|slot| {
        let mut ledger = slot.get();
        update(&mut ledger);
        slot.set(ledger);
    });
}

#[cfg(all(test, debug_assertions))]
fn bump_directory_indexed_full() {
    update_active_directory_work_ledger(|ledger| ledger.indexed_full += 1);
}
#[cfg(all(test, debug_assertions))]
fn bump_directory_synthesized_full() {
    update_active_directory_work_ledger(|ledger| ledger.synthesized_full += 1);
}
#[cfg(all(test, debug_assertions))]
fn bump_directory_override_decoration() {
    update_active_directory_work_ledger(|ledger| ledger.override_decoration += 1);
}
#[cfg(all(test, debug_assertions))]
fn bump_directory_metadata_decoration() {
    update_active_directory_work_ledger(|ledger| ledger.metadata_decoration += 1);
}
#[cfg(all(test, debug_assertions))]
fn bump_directory_running_decoration() {
    update_active_directory_work_ledger(|ledger| ledger.running_decoration += 1);
}
#[cfg(all(test, debug_assertions))]
fn bump_directory_title_annotation() {
    update_active_directory_work_ledger(|ledger| ledger.title_annotation += 1);
}
#[cfg(all(test, debug_assertions))]
fn bump_directory_item_serialization() {
    update_active_directory_work_ledger(|ledger| ledger.item_serialization += 1);
}
#[cfg(all(test, debug_assertions))]
fn bump_directory_full_row_clone() {
    update_active_directory_work_ledger(|ledger| ledger.full_row_clone += 1);
}

#[cfg(all(test, debug_assertions))]
struct DirectoryWorkScope {
    finished: bool,
    _not_send_or_sync: std::marker::PhantomData<std::rc::Rc<()>>,
}

#[cfg(all(test, debug_assertions))]
fn begin_directory_work_scope() -> DirectoryWorkScope {
    DIRECTORY_WORK_SCOPE_ACTIVE.with(|active| {
        assert!(!active.replace(true), "nested directory work scope");
    });
    reset_directory_work_ledger_for_current_thread();
    DirectoryWorkScope {
        finished: false,
        _not_send_or_sync: std::marker::PhantomData,
    }
}

#[cfg(all(test, debug_assertions))]
impl DirectoryWorkScope {
    fn finish(mut self) -> DirectoryWorkLedger {
        let ledger = read_directory_work_ledger_for_current_thread();
        reset_directory_work_ledger_for_current_thread();
        DIRECTORY_WORK_SCOPE_ACTIVE.with(|active| {
            assert!(active.replace(false), "directory work scope was inactive");
        });
        self.finished = true;
        ledger
    }
}

#[cfg(all(test, debug_assertions))]
impl Drop for DirectoryWorkScope {
    fn drop(&mut self) {
        if !self.finished {
            reset_directory_work_ledger_for_current_thread();
            DIRECTORY_WORK_SCOPE_ACTIVE.set(false);
        }
    }
}

#[cfg(all(test, debug_assertions))]
fn successful_fast_page_with_ledger(
    inputs: CapturedDirectoryInputs<'_>,
    q: &DirQuery,
) -> (Value, DirectoryWorkLedger) {
    let scope = begin_directory_work_scope();
    let result = derive_directory_page(DirectoryStrategy::Fast, inputs, q);
    let ledger = scope.finish();
    (result.expect("successful Fast fixture"), ledger)
}

#[cfg(all(test, debug_assertions))]
fn failed_fast_page_with_ledger(
    inputs: CapturedDirectoryInputs<'_>,
    q: &DirQuery,
) -> (String, DirectoryWorkLedger) {
    let scope = begin_directory_work_scope();
    let result = derive_directory_page(DirectoryStrategy::Fast, inputs, q);
    let ledger = scope.finish();
    (result.expect_err("failing Fast fixture"), ledger)
}
```

Task 0 installs and freezes `bump_directory_indexed_full` in
`dir_item_from_indexed`, `bump_directory_synthesized_full` after
`build_live_terminal_session_item` succeeds,
`bump_directory_override_decoration` in the one-item override path,
`bump_directory_metadata_decoration` in the one-item metadata path,
`bump_directory_running_decoration` in `join_running_state`,
`bump_directory_title_annotation` in legacy annotation,
`bump_directory_item_serialization` in `DirItem::to_value`, and
`bump_directory_full_row_clone` at the start of manual `DirItem::clone`.
Task 3 uses the same `bump_directory_title_annotation` in carried Fast
annotation; no second helper name exists.

Ledger semantics are request/test local: every G2 test is a plain synchronous
`#[test]`; it calls exactly one of the two scope helpers and performs no `await`
or thread spawn between `begin_directory_work_scope` and `finish`. The
`Rc` phantom makes the guard non-Send/non-Sync, nested scopes fail closed, and
Drop clears state during panic unwinding. Bumps outside an active scope are
no-ops, so legacy/full-app tests cannot contaminate a G2 measurement. Thread-local
storage isolates concurrently running test-harness threads, making the default
parallel `run_server_all_targets` safe; focused G2 still runs with
`--test-threads=1`. Exact successful-page equations are asserted only on the
value returned by `successful_fast_page_with_ledger`. Error tests use
`failed_fast_page_with_ledger` and separate zero/partial-operation assertions.
Expected indexed/synth provenance always comes from fixture keys, never from the
ledger itself.

---

## Two Immutable Authorities and Rebaseline Rule

### Task-0 frozen inventory

Use unique
`/* SESSION_DIRECTORY_AUTHORITY_BEGIN:<name> */` / `END` markers around:

- `legacy-max-directory-page-items`;
- `legacy-session-directory-state-type`;
- `legacy-dir-item-type-and-impl` (including manual instrumented Clone);
- `legacy-tier-and-dir-query-types`;
- `legacy-query-validation` (`validate_query`, `js_number`, `validate_limit`);
- `legacy-session-directory-router` (not the handler derivation Task 1 extracts);
- `legacy-indexed-constructor`;
- `legacy-overrides`;
- `legacy-metadata`;
- `legacy-provider-display`;
- `legacy-running-join`;
- `legacy-synth-constructor`;
- `legacy-live-join`;
- `legacy-cursor-codec`;
- `legacy-apply-query`;
- `legacy-file-search-outcome-type`;
- `legacy-file-search`;
- `legacy-title-search`;
- `parent-authority-capture-types`;
- `parent-authority-case-manifest-builders`;
- `parent-authority-owner-route-executor`;
- `parent-authority-response-fixtures` (including the exact pinned source/fixture authority JSON and its deterministic raw literals);
- `parent-authority-frozen-old-page`;
- `parent-authority-response-renderer`;
- `parent-authority-work-ledger`.

All legacy bump calls are inside their frozen function regions. Freeze the whole
UTF-8 file `crates/freshell-sessions/src/search.rs`, including constants, parser,
search helpers, types, and tests. In `main.rs`, freeze
`full-application-layer-assembler` and
`full-application-layer-production-call`.

The immutable Task-0 owner-backed/full-application case manifest is this exact
ordered list; the manifest test compares exact names and derives its count from
this list rather than trusting a generator count:

```text
no_index_no_query_empty_colors
empty_snapshot_no_query_empty_colors
no_query_composed_without_colors
no_query_composed_with_ordered_colors
title_annotation_cursor_with_ordered_colors
title_snippet_139_scalars
title_snippet_140_scalars
title_snippet_141_scalars
user_messages_success
user_messages_cursor_page
user_messages_budget_partial
user_messages_io_partial
full_text_success
full_text_cursor_page
full_text_budget_partial
invalid_priority_limit_and_tier
invalid_cursor_derivation_error_no_colors
request_revision_is_ignored
single_identity_running_join
project_color_order_on_title_route
project_color_order_on_user_messages_route
project_color_order_on_full_text_route
```

Each row records request URI/headers, owner state, expected status, exact
normalized `content-type`, and a reviewed raw body literal that is independent
of `TerminalIdentityRegistry::list()` iteration order. Any raw row whose winner
is serialized contains exactly one matching identity. The manifest defines
`EXPECTED_PARENT_CASE_NAMES` as the explicit slice above and asserts ordered-name
equality plus `parent_cases.len() == EXPECTED_PARENT_CASE_NAMES.len()`. Its
current derived length is 22; no independent numeric constant or assertion can
drift from the slice.

`user_messages_cursor_page` and `full_text_cursor_page` each own three matching
source rows, issue `limit=1`, record the first raw response and emitted cursor,
then issue a second owner-backed request with that exact cursor and record a
nonduplicate second body. `full_text_success` matches assistant-only text.
`full_text_budget_partial` uses eleven searchable nonmatches at `limit=1` and
pins raw `partial:true`/`partialReason:"budget"` composition.
`project_color_order_on_full_text_route` sends a successful nonempty fullText
query with a three-entry insertion-ordered color map and pins the body bytes,
complementing the title and userMessages color rows. Success rows record colors
after derivation; error rows instrument and assert zero color reads.
`invalid_priority_limit_and_tier` is explicitly pre-seam. The two index cases
remain distinct even though both serialize an empty page.
`single_identity_running_join` owns one indexed row and exactly one live matching
identity, pins the resulting `runningTerminalId`, and exercises the actual owner
route without claiming owner iteration order. The two multi-identity winner
permutations are not raw-manifest rows; they are the fixed-capture cases declared
under Tasks 2 and 6.

### Task-1 frozen inventory

Task 1 adds only:

- `extracted-materialized-page`;
- `extracted-materialized-dispatch`.

Do not mark `build_directory_page`, owner capture, selector, comparison apps, or
Fast code as extracted authority.

### Rebaseline lifecycle (exceptional, fail closed)

Ordinary execution never edits either authority. If a deliberate behavior
contract change is approved later:

1. Stop candidate/selector work with a clean active worktree and passing current
   guards. Retain previous authority commits in history for audit.
2. Open a separately reviewed compatibility/rebaseline task. Give the contract
   delta an explicit ID and rationale; the failing Fast output cannot define the
   new expected behavior.
3. Generate replacement owner-backed full-app literals from the unchanged
   approved old/Materialized behavior for the same revised manifest. Review the
   per-case status/header/raw-body diff before accepting it.
4. In one dedicated rebaseline commit with a unique subject/hash, update the
   Task-0 manifest/builders/raw literals/FrozenOld authority and the Task-1
   ExtractedMaterialized authority for **the same delta**. Update affected
   transitive inventory/guards and shared comment only if the approved contract
   delta requires it. Include no candidate repair or selector change.
5. Re-anchor both guard maps to that reviewed commit, run owner-backed and fixed
   capture old/materialized/Fast completed matrices, both authority guards,
   relevant mutation killers, G2, and G3. Fast work resumes only after all are
   green.
6. A candidate fix, extraction edit, selector edit, or rollback may never modify
   an authority in the same commit. If the two authorities or manifest do not
   describe the identical deliberate delta, stop; do not weaken a guard.

---

## Fail-Closed Execution Harness

Run this harness in the task execution shell before Task 0A. If the shell is
replaced, rerun it. It is intentionally not persisted as a repository file.
Every copied multi-command block starts with `set -euo pipefail`.

### Exact test and broader-check helpers

```bash
set -euo pipefail
WT=/home/dan/code/freshell/.worktrees/session-directory-page-bound
MANIFEST="$WT/Cargo.toml"
TEST_MOD='session_directory::page_bound_tests'

list_tests() {
  local mode="$1" output line
  if test "$mode" = debug; then
    output="$(cargo test --manifest-path "$MANIFEST" -p freshell-server -- --list)" || return 1
  elif test "$mode" = release; then
    output="$(cargo test --manifest-path "$MANIFEST" -p freshell-server --release -- --list)" || return 1
  else
    printf 'invalid test mode: %s\n' "$mode" >&2
    return 1
  fi
  while IFS= read -r line; do
    case "$line" in
      *': test') printf '%s\n' "${line%: test}" || return 1 ;;
    esac
  done <<<"$output"
}

assert_one_named_test() {
  local mode="$1" name="$2" names line count=0
  names="$(list_tests "$mode")" || return 1
  while IFS= read -r line; do
    if test "$line" = "$name"; then count=$((count + 1)); fi
  done <<<"$names"
  if test "$count" -ne 1; then
    printf 'expected exactly one %s test %s; found %s\n' "$mode" "$name" "$count" >&2
    return 1
  fi
}

run_exact_debug() {
  local name="$1"
  assert_one_named_test debug "$name" || return 1
  cargo test --manifest-path "$MANIFEST" -p freshell-server \
    "$name" -- --exact --test-threads=1 || return 1
}

run_exact_debug_ignored() {
  local name="$1"
  assert_one_named_test debug "$name" || return 1
  cargo test --manifest-path "$MANIFEST" -p freshell-server \
    "$name" -- --exact --ignored --nocapture --test-threads=1 || return 1
}

run_exact_release_ignored() {
  local name="$1"
  assert_one_named_test release "$name" || return 1
  cargo test --manifest-path "$MANIFEST" -p freshell-server --release \
    "$name" -- --exact --ignored --nocapture --test-threads=1 || return 1
}

expect_debug_compile_failure() {
  local label="$1" diagnostic="$2" log
  log="$(mktemp)" || return 1
  if cargo test --manifest-path "$MANIFEST" -p freshell-server --no-run >"$log" 2>&1; then
    printf 'RED unexpectedly compiled: %s\n' "$label" >&2
    cat "$log" >&2 || true
    rm -f "$log"
    return 1
  fi
  python3 - "$log" "$diagnostic" <<'PY' || { cat "$log" >&2 || true; rm -f "$log"; return 1; }
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
needle = sys.argv[2]
if text.count(needle) != 1:
    raise SystemExit(f"expected diagnostic exactly once: {needle!r}; found {text.count(needle)}")
PY
  cat "$log" || { rm -f "$log"; return 1; }
  rm -f "$log"
}

expect_exact_debug_failure() {
  local name="$1" marker="$2" log
  assert_one_named_test debug "$name" || return 1
  log="$(mktemp)" || return 1
  if cargo test --manifest-path "$MANIFEST" -p freshell-server \
      "$name" -- --exact --test-threads=1 >"$log" 2>&1; then
    printf 'RED unexpectedly passed: %s\n' "$name" >&2
    cat "$log" >&2 || true
    rm -f "$log"
    return 1
  fi
  python3 - "$log" "$name" "$marker" <<'PY' || { cat "$log" >&2 || true; rm -f "$log"; return 1; }
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
name, marker = sys.argv[2], sys.argv[3]
if text.count(marker) != 1 or text.count(f"test {name} ... FAILED") != 1:
    raise SystemExit("failure was not the declared exact test/marker exactly once")
PY
  cat "$log" || { rm -f "$log"; return 1; }
  rm -f "$log"
}

run_audited_debug_prefix() {
  local prefix="$1" expected_count="$2" tmp names
  tmp="$(mktemp -d)" || return 1
  cat >"$tmp/expected" || { rm -rf "$tmp"; return 1; }
  names="$(list_tests debug)" || { rm -rf "$tmp"; return 1; }
  printf '%s\n' "$names" >"$tmp/all" || { rm -rf "$tmp"; return 1; }
  python3 - "$prefix" "$expected_count" "$tmp/expected" "$tmp/all" <<'PY' || { rm -rf "$tmp"; return 1; }
import pathlib, sys
prefix, expected_count = sys.argv[1], int(sys.argv[2])
expected = sorted(line for line in pathlib.Path(sys.argv[3]).read_text(encoding="utf-8").splitlines() if line)
actual = sorted(line for line in pathlib.Path(sys.argv[4]).read_text(encoding="utf-8").splitlines() if line.startswith(prefix))
if len(expected) != expected_count or len(set(expected)) != expected_count:
    raise SystemExit(f"bad expected inventory: {len(expected)} lines/{len(set(expected))} unique")
if actual != expected:
    raise SystemExit(f"prefix inventory mismatch\nexpected={expected!r}\nactual={actual!r}")
PY
  rm -rf "$tmp"
  cargo test --manifest-path "$MANIFEST" -p freshell-server \
    "$prefix" -- --test-threads=1 || return 1
}

run_server_all_targets() {
  cargo test --manifest-path "$MANIFEST" -p freshell-server --all-targets || return 1
}
run_sessions_sanity() {
  cargo test --manifest-path "$MANIFEST" -p freshell-sessions || return 1
}
run_fmt_check() {
  cargo fmt --manifest-path "$MANIFEST" --all --check || return 1
}
run_clippy() {
  cargo clippy --manifest-path "$MANIFEST" --workspace --all-targets --all-features -- -D warnings || return 1
}
run_shared_typecheck() {
  npm --prefix "$WT" run typecheck || return 1
}
```

`run_fmt_check` is intentionally nonmutating. If it fails, edit only the current
task's allowlisted file and rerun; never run a broad mutating formatter over
foreign work.

Compile-fail RED is the sole test-list exception because a noncompiling crate
cannot list tests. Its diagnostic must occur exactly once; the same test must
later pass through `run_exact_debug`. Runtime REDs are listed first and require
an exact marker.

### NUL-safe exact Git scope and commit helper

```bash
set -euo pipefail
_assert_git_scope() {
  local mode="$1"
  shift
  python3 - "$WT" "$mode" "$@" <<'PY'
from __future__ import annotations
import os, subprocess, sys
wt, mode, *raw_args = sys.argv[1:]

def git(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", wt, *args])

def path_bytes(values: list[str]) -> list[bytes]:
    paths = [os.fsencode(value) for value in values]
    if not paths or len(paths) != len(set(paths)):
        raise SystemExit("exact scope requires a nonempty unique allowlist")
    for path in paths:
        parts = path.split(b"/")
        if not path or path.startswith(b"/") or any(part in {b"", b".", b".."} for part in parts):
            raise SystemExit(f"invalid repository-relative allowlist path: {path!r}")
    return paths

def nul_paths(raw: bytes, label: str) -> list[bytes]:
    if not raw:
        return []
    if not raw.endswith(b"\0"):
        raise SystemExit(f"{label} is not NUL terminated")
    paths = raw[:-1].split(b"\0")
    if any(not path for path in paths):
        raise SystemExit(f"{label} contains an empty path")
    return paths

def status_records(raw: bytes) -> list[tuple[bytes, tuple[bytes, ...]]]:
    records = []
    offset = 0
    while offset < len(raw):
        end = raw.find(b"\0", offset)
        if end < 0:
            raise SystemExit("porcelain status record is not NUL terminated")
        entry = raw[offset:end]
        offset = end + 1
        if len(entry) < 4 or entry[2:3] != b" ":
            raise SystemExit(f"invalid porcelain v1 record: {entry!r}")
        xy, first = entry[:2], entry[3:]
        if not first:
            raise SystemExit("porcelain status contains an empty path")
        paths = [first]
        if b"R" in xy or b"C" in xy:
            end = raw.find(b"\0", offset)
            if end < 0:
                raise SystemExit("rename/copy source is not NUL terminated")
            second = raw[offset:end]
            offset = end + 1
            if not second:
                raise SystemExit("rename/copy source is empty")
            paths.append(second)
        records.append((xy, tuple(paths)))
    return records

def exact_set(actual: list[bytes], allowed: list[bytes], label: str) -> None:
    if len(actual) != len(set(actual)) or set(actual) != set(allowed):
        raise SystemExit(f"{label} differs from allowlist: actual={actual!r}, allowed={allowed!r}")

if mode == "committed":
    if len(raw_args) < 2:
        raise SystemExit("committed scope requires subject and allowlist")
    expected_subject, *values = raw_args
    allowed = path_bytes(values)
else:
    expected_subject = None
    allowed = path_bytes(raw_args)

if mode == "preflight":
    status = status_records(git("status", "--porcelain=v1", "-z", "--untracked-files=all"))
    staged = [(xy, paths) for xy, paths in status if xy[:1] not in {b" ", b"?"} or xy == b" A"]
    if staged:
        raise SystemExit(f"pre-existing staged entries are forbidden: {staged!r}")
    cached = nul_paths(git("diff", "--cached", "--name-only", "-z", "HEAD", "--"), "cached")
    if cached:
        raise SystemExit(f"pre-existing cached paths are forbidden: {cached!r}")
    changed = {path for _, paths in status for path in paths}
    outside = changed - set(allowed)
    if outside:
        raise SystemExit(f"changed path outside task allowlist: {sorted(outside)!r}")
elif mode == "cached":
    exact_set(nul_paths(git("diff", "--cached", "--name-only", "-z", "HEAD", "--"), "cached"), allowed, "cached")
elif mode == "committed":
    subject = git("show", "-s", "--format=%s", "HEAD").decode("utf-8").rstrip("\n")
    if subject != expected_subject:
        raise SystemExit(f"subject changed: {subject!r} != {expected_subject!r}")
    committed = nul_paths(git("diff-tree", "--root", "--no-commit-id", "--name-only", "-z", "-r", "--no-renames", "HEAD"), "committed")
    exact_set(committed, allowed, "committed")
    status = git("status", "--porcelain=v1", "-z", "--untracked-files=all")
    if status:
        raise SystemExit(f"post-commit repository is not clean: {status!r}")
else:
    raise SystemExit(f"unknown exact-scope mode: {mode!r}")
PY
}

commit_exact_scope() {
  local subject old_head new_head
  local -a allowlist
  if test "$#" -lt 2; then
    printf 'usage: commit_exact_scope SUBJECT PATH...\n' >&2
    return 1
  fi
  subject="$1"
  shift
  allowlist=("$@")
  _assert_git_scope preflight "${allowlist[@]}" || return 1
  git -C "$WT" add -- "${allowlist[@]}" || return 1
  _assert_git_scope cached "${allowlist[@]}" || return 1
  git -C "$WT" diff --cached --check || return 1
  old_head="$(git -C "$WT" rev-parse HEAD)" || return 1
  git -C "$WT" commit --only \
    -m "$subject" \
    -m '🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)' \
    -m 'Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>' \
    -- "${allowlist[@]}" || return 1
  new_head="$(git -C "$WT" rev-parse HEAD)" || return 1
  if test "$new_head" = "$old_head"; then return 1; fi
  _assert_git_scope committed "$subject" "${allowlist[@]}" || return 1
}
```

This helper rejects staged, unstaged, renamed/copied, and untracked paths outside
the allowlist; verifies the exact cached and committed path sets and subject; and
requires clean post-state. It never restores, resets, cleans, checks out, or
deletes foreign work. Stop if another agent owns a changed path.

### Authority guards

```bash
set -euo pipefail
run_shared_comment_guard() {
  python3 - "$WT" <<'PY'
import pathlib, subprocess, sys
wt = pathlib.Path(sys.argv[1])
subject = "docs(api): clarify session-directory snapshot consistency"
fields = subprocess.check_output(["git", "-C", str(wt), "log", "-z", "HEAD", "--format=%H%x00%s"]).decode().split("\0")
matches = [h for h, s in zip(fields[0::2], fields[1::2]) if s == subject]
if len(matches) != 1:
    raise SystemExit(f"expected one shared-comment ancestor, found {matches}")
path = "shared/read-models.ts"
before = subprocess.check_output(["git", "-C", str(wt), "show", f"{matches[0]}:{path}"]).decode("utf-8")
after = (wt / path).read_text(encoding="utf-8")
if before != after:
    raise SystemExit("shared API comment/source changed after Task 0A")
PY
}

run_authority_guard() {
  local mode="$1"
  python3 - "$WT" "$mode" <<'PY'
from __future__ import annotations
import difflib, pathlib, subprocess, sys
wt = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
if mode not in {"task0", "both"}:
    raise SystemExit(f"invalid mode: {mode}")
TASK0_SUBJECT = "test(session-directory): freeze parent response authority"
TASK1_SUBJECT = "refactor(session-directory): extract frozen materialized strategy"
SESSION = "crates/freshell-server/src/session_directory.rs"
MAIN = "crates/freshell-server/src/main.rs"
SEARCH = "crates/freshell-sessions/src/search.rs"
TASK0 = {
    SESSION: [
        "legacy-max-directory-page-items", "legacy-session-directory-state-type",
        "legacy-dir-item-type-and-impl", "legacy-tier-and-dir-query-types",
        "legacy-query-validation", "legacy-session-directory-router",
        "legacy-indexed-constructor", "legacy-overrides", "legacy-metadata",
        "legacy-provider-display", "legacy-running-join", "legacy-synth-constructor",
        "legacy-live-join", "legacy-cursor-codec", "legacy-apply-query",
        "legacy-file-search-outcome-type", "legacy-file-search", "legacy-title-search",
        "parent-authority-capture-types", "parent-authority-case-manifest-builders",
        "parent-authority-owner-route-executor", "parent-authority-response-fixtures",
        "parent-authority-frozen-old-page", "parent-authority-response-renderer",
        "parent-authority-work-ledger",
    ],
    MAIN: ["full-application-layer-assembler", "full-application-layer-production-call"],
}
TASK1 = {SESSION: ["extracted-materialized-page", "extracted-materialized-dispatch"]}

def git_bytes(*args: str) -> bytes:
    return subprocess.check_output(["git", "-C", str(wt), *args])

def exact_ancestor(subject: str) -> str:
    fields = git_bytes("log", "-z", "HEAD", "--format=%H%x00%s").decode("utf-8").split("\0")
    matches = [h for h, s in zip(fields[0::2], fields[1::2]) if s == subject]
    if len(matches) != 1:
        raise SystemExit(f"expected one ancestor subject {subject!r}; found {matches}")
    return matches[0]

def text_at(commit: str, path: str) -> str:
    return git_bytes("show", f"{commit}:{path}").decode("utf-8")

def current(path: str) -> str:
    return (wt / path).read_text(encoding="utf-8")

def region(text: str, name: str) -> list[str]:
    begin = f"/* SESSION_DIRECTORY_AUTHORITY_BEGIN:{name} */"
    end = f"/* SESSION_DIRECTORY_AUTHORITY_END:{name} */"
    if text.count(begin) != 1 or text.count(end) != 1:
        raise SystemExit(f"{name}: expected exactly one begin/end marker")
    start = text.index(begin)
    stop = text.index(end, start) + len(end)
    return text[start:stop].splitlines(keepends=True)

def check(commit: str, mapping: dict[str, list[str]], label: str) -> None:
    failed = False
    for path, names in mapping.items():
        before, after = text_at(commit, path), current(path)
        for name in names:
            old, new = region(before, name), region(after, name)
            if old != new:
                failed = True
                sys.stdout.writelines(difflib.unified_diff(old, new, fromfile=f"{label}/{name}", tofile=f"working/{name}"))
    if failed:
        raise SystemExit(f"{label} authority changed")

task0 = exact_ancestor(TASK0_SUBJECT)
check(task0, TASK0, "task0")
if text_at(task0, SEARCH) != current(SEARCH):
    raise SystemExit("Task-0 external search authority changed")
if mode == "both":
    task1 = exact_ancestor(TASK1_SUBJECT)
    check(task1, TASK1, "task1")
PY
}
run_task0_guard() { run_shared_comment_guard && run_authority_guard task0; }
run_both_guards() { run_shared_comment_guard && run_authority_guard both; }
```

The exceptional rebaseline protocol replaces these initial subject anchors with
its reviewed unique hash/subject; normal candidate work never edits this guard.

### Exact audited test inventories

```bash
set -euo pipefail
run_legacy_aggregate() {
  run_audited_debug_prefix "$TEST_MOD::legacy_" 33 <<'EOF'
session_directory::page_bound_tests::legacy_all_eight_visibility_flag_combinations
session_directory::page_bound_tests::legacy_all_limits_and_cardinality_boundaries
session_directory::page_bound_tests::legacy_archived_and_metadata_serialization
session_directory::page_bound_tests::legacy_arbitrary_cursor_position_table
session_directory::page_bound_tests::legacy_broad_unicode_title_table
session_directory::page_bound_tests::legacy_cursor_chain_paginates_decorated_corpus
session_directory::page_bound_tests::legacy_deep_limit_one_chain_and_duplicate_tuple_gaps
session_directory::page_bound_tests::legacy_default_visibility_filters
session_directory::page_bound_tests::legacy_deleted_index_and_synth_equal_ties
session_directory::page_bound_tests::legacy_deleted_session_with_live_terminal_synthesizes
session_directory::page_bound_tests::legacy_duplicate_equal_tuples_preserve_source_order
session_directory::page_bound_tests::legacy_duplicate_rows_straddling_page_boundary
session_directory::page_bound_tests::legacy_empty_filter_precedes_search
session_directory::page_bound_tests::legacy_full_string_colon_collision_composes_all_joins
session_directory::page_bound_tests::legacy_identity_missing_components_terminal_fallback_and_collisions
session_directory::page_bound_tests::legacy_large_live_and_filtered_live_set_table
session_directory::page_bound_tests::legacy_long_deleted_and_filtered_prefixes
session_directory::page_bound_tests::legacy_malformed_cursor_table
session_directory::page_bound_tests::legacy_malformed_metadata_value_table
session_directory::page_bound_tests::legacy_malformed_override_value_table
session_directory::page_bound_tests::legacy_negative_and_i64_revision_boundaries
session_directory::page_bound_tests::legacy_no_index_empty_snapshot_and_color_read_table
session_directory::page_bound_tests::legacy_ordered_identity_permutations_choose_first_winner
session_directory::page_bound_tests::legacy_project_color_map_order_composes_with_all_tiers
session_directory::page_bound_tests::legacy_provider_generated_shadow_guard
session_directory::page_bound_tests::legacy_query_absent_blank_tier_without_query_and_invalid_request_table
session_directory::page_bound_tests::legacy_revision_empty_deleted_and_identity_sources
session_directory::page_bound_tests::legacy_search_override_replacement_and_precedence
session_directory::page_bound_tests::legacy_title_snippet_scalar_boundaries_139_140_141
session_directory::page_bound_tests::legacy_trap1_deleted_override_backfills_page
session_directory::page_bound_tests::legacy_trap1_live_join_rescues_and_merges_synth
session_directory::page_bound_tests::legacy_trap1_title_override_rescues_boundary_row
session_directory::page_bound_tests::legacy_whitespace_title_and_query_semantics
EOF
}

run_g1_aggregate() {
  run_audited_debug_prefix "$TEST_MOD::g1_" 21 <<'EOF'
session_directory::page_bound_tests::g1_all_eight_flags_old_materialized_fast
session_directory::page_bound_tests::g1_all_limits_and_cardinalities_old_materialized_fast
session_directory::page_bound_tests::g1_arbitrary_and_malformed_cursors_old_materialized_fast
session_directory::page_bound_tests::g1_broad_unicode_and_long_text_old_materialized_fast
session_directory::page_bound_tests::g1_completed_full_app_route_matrix_matches_parent
session_directory::page_bound_tests::g1_completed_strategy_matrix_old_extracted_fast
session_directory::page_bound_tests::g1_deep_limit_one_chain_old_materialized_fast
session_directory::page_bound_tests::g1_deleted_synth_ties_old_materialized_fast
session_directory::page_bound_tests::g1_duplicate_equal_and_colon_collision_old_materialized_fast
session_directory::page_bound_tests::g1_exhaustive_small_state_old_materialized_fast
session_directory::page_bound_tests::g1_fast_deleted_override_backfills_page_old_materialized_fast
session_directory::page_bound_tests::g1_i64_revision_boundaries_old_materialized_fast
session_directory::page_bound_tests::g1_identity_missing_components_terminal_fallback_old_materialized_fast
session_directory::page_bound_tests::g1_large_live_sets_old_materialized_fast
session_directory::page_bound_tests::g1_long_prefixes_old_materialized_fast
session_directory::page_bound_tests::g1_malformed_override_metadata_old_materialized_fast
session_directory::page_bound_tests::g1_noindex_empty_success_error_colors_old_materialized_fast
session_directory::page_bound_tests::g1_ordered_identity_permutations_old_materialized_fast
session_directory::page_bound_tests::g1_project_color_map_order_completed_routes
session_directory::page_bound_tests::g1_query_absent_blank_and_tier_without_query_old_materialized_fast
session_directory::page_bound_tests::g1_title_snippet_scalar_boundaries_old_materialized_fast
EOF
}

run_g2_aggregate() {
  run_audited_debug_prefix "$TEST_MOD::g2_" 18 <<'EOF'
session_directory::page_bound_tests::g2_candidate_source_has_no_direct_dir_item_literal
session_directory::page_bound_tests::g2_fast_region_has_no_clone_or_indirect_full_row_construction
session_directory::page_bound_tests::g2_full_row_constructor_inventory_is_exact_and_instrumented
session_directory::page_bound_tests::g2_no_query_all_filtered_large_live_set_builds_zero_items
session_directory::page_bound_tests::g2_no_query_duplicate_and_cursor_filtered_synths_build_only_returned_rows
session_directory::page_bound_tests::g2_no_query_indexed_work_table_is_exact
session_directory::page_bound_tests::g2_no_query_lookahead_descriptor_is_never_constructed
session_directory::page_bound_tests::g2_no_query_mixed_indexed_and_synth_work_is_exact
session_directory::page_bound_tests::g2_no_query_synth_work_table_is_exact
session_directory::page_bound_tests::g2_one_returned_row_with_500_identities_has_zero_full_row_clones
session_directory::page_bound_tests::g2_title_early_dense_matches_build_only_returned_rows
session_directory::page_bound_tests::g2_title_late_sparse_matches_scan_but_build_only_returned_rows
session_directory::page_bound_tests::g2_title_long_ascii_fields_are_exact
session_directory::page_bound_tests::g2_title_mixed_indexed_and_synth_work_is_exact
session_directory::page_bound_tests::g2_title_no_match_builds_zero_rows
session_directory::page_bound_tests::g2_title_non_ascii_expansion_table_is_exact
session_directory::page_bound_tests::g2_title_post_selection_has_no_rejection_path
session_directory::page_bound_tests::g2_title_synth_matches_build_only_selected_rows
EOF
}
```

These wrappers first list all tests, require the exact unique inventory and
count, then run the prefix. A typo or zero-match filter fails.

---

## Task Sequence

### Task 0A: Put the neutral consistency contract beside the shared schema

**Files:**
- Modify comment only: `shared/read-models.ts:62` immediately above
  `SessionDirectoryPageSchema`.
- No test/source file.

**Interfaces:** No runtime interface. The Zod value and inferred
`SessionDirectoryPage` type must remain byte-for-byte unchanged after comments
are removed.

- [ ] **Step 1: Preflight and insert the exact comment**

Insert only:

```ts
// Session-directory consistency: independent state owners are not one atomic
// or linearizable snapshot. Wall-clock capture timing is not guaranteed under
// concurrent writes. `revision` remains an activity maximum, not a snapshot
// generation, monotonic version, or pin; request `revision` does not select a
// snapshot. This adds no canonical Node/Rust key-order or raw-body byte
// contract.
export const SessionDirectoryPageSchema = z.object({
```

- [ ] **Step 2: Prove the edit is exactly that comment insertion**

```bash
set -euo pipefail
_assert_git_scope preflight shared/read-models.ts
python3 - "$WT" <<'PY'
import pathlib, subprocess, sys
wt = pathlib.Path(sys.argv[1])
path = "shared/read-models.ts"
before = subprocess.check_output(["git", "-C", str(wt), "show", f"HEAD:{path}"]).decode("utf-8")
after = (wt / path).read_text(encoding="utf-8")
needle = "export const SessionDirectoryPageSchema = z.object({"
comment = """// Session-directory consistency: independent state owners are not one atomic
// or linearizable snapshot. Wall-clock capture timing is not guaranteed under
// concurrent writes. `revision` remains an activity maximum, not a snapshot
// generation, monotonic version, or pin; request `revision` does not select a
// snapshot. This adds no canonical Node/Rust key-order or raw-body byte
// contract.
"""
if before.count(needle) != 1:
    raise SystemExit("schema anchor count is not one")
if after != before.replace(needle, comment + needle, 1):
    raise SystemExit("shared edit is not the exact approved comment insertion")
PY
git -C "$WT" diff --check -- shared/read-models.ts
run_shared_typecheck
```

Expected GREEN: exact-insertion script, TypeScript client/server typecheck, and
`git diff --check -- shared/read-models.ts` return zero. This is documentation
only, so no artificial RED is required.

- [ ] **Step 3: Commit exact scope**

```bash
set -euo pipefail
commit_exact_scope \
  'docs(api): clarify session-directory snapshot consistency' \
  shared/read-models.ts
run_shared_comment_guard
```

### Task 0: Pin, record, and freeze the pre-extraction parent authority

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs`.
- Modify only the assembler/call: `crates/freshell-server/src/main.rs`.
- Read/freeze unchanged: `crates/freshell-sessions/src/search.rs`.

**Forbidden:** extracting the handler derivation, changing capture order,
adding Fast code/selector behavior, or changing shared source.

**Interfaces produced:** Task-0 capture/renderer/completed-response interfaces,
manual instrumented `DirItem::Clone`, the immutable explicit manifest whose
count is derived from `EXPECTED_PARENT_CASE_NAMES`, authority markers, and
`with_full_application_layers` exactly as defined above.

- [ ] **Step 1: Pin provenance and establish the scoped baseline**

```bash
set -euo pipefail
PARENT=fc8646477dd34d92dc5647d158106431aa2e0380
test "$(git -C "$WT" merge-base HEAD "$PARENT")" = "$PARENT"
git -C "$WT" diff --exit-code "$PARENT" -- \
  crates/freshell-server/src/session_directory.rs \
  crates/freshell-server/src/main.rs \
  crates/freshell-sessions/src/search.rs
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_shared_comment_guard
```

Expected GREEN: source equals the pinned parent and every command returns zero.
If the baseline is not green, stop before changing Rust and report the exact
failing command/output; do not redefine the baseline.

- [ ] **Step 2: Record the ownership-safe pinned-parent source/fixture authority before any Rust edit**

The pinned production binary constructs network-capable `reqwest` clients,
an update checker, and an OpenCode lane, and the pinned source exposes no
audited switch that guarantees all outbound I/O is disabled. Therefore this
plan **forbids launching that binary as the parent oracle**. Sanitizing provider
variables alone would not prove no network, and inheriting even one provider
root could read live sessions. The exact safe fallback authority is instead:

1. the pinned Git commit and exact blobs for the handler, layer chain, file
   search, provider-root resolvers, and two committed transcript fixtures;
2. the committed fixture semantics
   (`claude:b7936c10-4935-441c-837c-c1f33cafec2d` is visible;
   `healthy-session-id` is excluded because it has no `cwd`); and
3. Task 0's deterministic, in-process owner-backed/full-layer raw responses over
   those committed fixture bytes plus explicit synthetic owner maps.

No Cargo/npm command, server process, provider scan, external service, socket,
live config, real home, or ambient environment value participates in this
step. The detached worktree is only a read-only view of committed blobs.

```bash
set -euo pipefail
PARENT_TMP="$(mktemp -d /tmp/session-directory-parent-authority.XXXXXXXX)"
PARENT_TMP_OWNED=1
PARENT_WT="$PARENT_TMP/worktree"
PARENT_WT_CREATED=0
PARENT_WT_GITDIR=
# Ignore ambient system/global Git config. Repository-local object/worktree
# metadata remains available; hooks and fsmonitor are disabled at add time.
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null

assert_parent_worktree_record() {
  local mode="$1"
  python3 - "$WT" "$PARENT_WT" "$PARENT" "$mode" <<'PY'
import os, subprocess, sys
wt, expected_path, expected_head, mode = sys.argv[1:]
expected_path = os.path.realpath(expected_path)
raw = subprocess.check_output(
    ["git", "-C", wt, "worktree", "list", "--porcelain", "-z"]
)
records = []
for block in raw.split(b"\0\0"):
    if not block:
        continue
    fields = block.split(b"\0")
    record = {}
    flags = set()
    for field in fields:
        if not field:
            continue
        if b" " in field:
            key, value = field.split(b" ", 1)
            record[key.decode()] = os.fsdecode(value)
        else:
            flags.add(field.decode())
    record["flags"] = flags
    records.append(record)
matches = [
    record
    for record in records
    if os.path.realpath(record.get("worktree", "")) == expected_path
]
if mode == "absent":
    if matches:
        raise SystemExit(f"path already registered; preserving it: {matches!r}")
elif mode == "owned":
    if len(matches) != 1:
        raise SystemExit(f"expected one owned registration, found {matches!r}")
    record = matches[0]
    if record.get("HEAD") != expected_head or "detached" not in record["flags"]:
        raise SystemExit(f"owned registration identity changed: {record!r}")
else:
    raise SystemExit(f"unknown worktree-check mode: {mode}")
PY
}

cleanup_parent_fixture_authority() {
  local original_status="$?" cleanup_status=0 status
  trap - EXIT
  if test "${PARENT_WT_CREATED:-0}" = 1; then
    if ! assert_parent_worktree_record owned; then
      printf 'owned parent worktree identity changed; preserving it\n' >&2
      cleanup_status=1
    elif test "$(realpath "$PARENT_WT")" != \
        "$(git -C "$PARENT_WT" rev-parse --show-toplevel)"; then
      printf 'owned parent worktree top level changed; preserving it\n' >&2
      cleanup_status=1
    elif test "$(git -C "$PARENT_WT" rev-parse HEAD)" != "$PARENT"; then
      printf 'owned parent worktree HEAD changed; preserving it\n' >&2
      cleanup_status=1
    elif test -z "${PARENT_WT_GITDIR:-}" \
        || test "$(git -C "$PARENT_WT" rev-parse --absolute-git-dir)" != \
          "$PARENT_WT_GITDIR"; then
      printf 'owned parent worktree gitdir identity changed; preserving it\n' >&2
      cleanup_status=1
    else
      status="$(git -C "$PARENT_WT" -c core.fsmonitor=false \
        -c core.untrackedCache=false status --porcelain=v1 \
        --untracked-files=all)" || cleanup_status=1
      if test "$cleanup_status" = 0 && test -n "$status"; then
        printf 'owned parent worktree became dirty; preserving it\n' >&2
        cleanup_status=1
      elif test "$cleanup_status" = 0; then
        if git -C "$WT" -c core.fsmonitor=false \
            -c core.untrackedCache=false worktree remove "$PARENT_WT"; then
          PARENT_WT_CREATED=0
        else
          cleanup_status=1
        fi
      fi
    fi
  fi
  if test "${PARENT_TMP_OWNED:-0}" = 1; then
    if test "${PARENT_WT_CREATED:-0}" = 0 \
        && test ! -e "$PARENT_WT" \
        && assert_parent_worktree_record absent; then
      if rmdir "$PARENT_TMP"; then
        PARENT_TMP_OWNED=0
      else
        cleanup_status=1
      fi
    else
      printf 'parent authority temp root retained; ownership not removable\n' >&2
      cleanup_status=1
    fi
  fi
  if test "$original_status" -ne 0; then
    return "$original_status"
  fi
  return "$cleanup_status"
}

# These collision checks intentionally precede trap installation. A path or
# registration owned by another run is never handed to cleanup.
if test -e "$PARENT_WT"; then
  printf 'parent authority path already exists; leaving it untouched\n' >&2
  rmdir "$PARENT_TMP"
  exit 1
fi
if ! assert_parent_worktree_record absent; then
  rmdir "$PARENT_TMP"
  exit 1
fi
# A checkout may not invoke repository/global hooks or content filters.
if git -C "$WT" cat-file -e "$PARENT:.gitattributes" 2>/dev/null; then
  printf 'pinned parent has .gitattributes; static fallback needs re-review\n' >&2
  rmdir "$PARENT_TMP"
  exit 1
fi
COMMON_ATTRIBUTES="$(git -C "$WT" rev-parse --git-path info/attributes)"
if test -s "$COMMON_ATTRIBUTES"; then
  printf 'common Git info/attributes is nonempty; refusing filtered checkout\n' >&2
  rmdir "$PARENT_TMP"
  exit 1
fi
trap cleanup_parent_fixture_authority EXIT

if ! git -C "$WT" -c core.hooksPath=/dev/null -c core.fsmonitor=false \
    -c core.untrackedCache=false -c core.attributesFile=/dev/null \
    worktree add --detach "$PARENT_WT" "$PARENT"; then
  # A partial failed add is preserved: ownership remains false, so the trap may
  # retain the unique temp root but may not remove a path or registration.
  exit 1
fi
assert_parent_worktree_record owned
test "$(realpath "$PARENT_WT")" = \
  "$(git -C "$PARENT_WT" rev-parse --show-toplevel)"
test "$(git -C "$PARENT_WT" rev-parse HEAD)" = "$PARENT"
test -z "$(git -C "$PARENT_WT" -c core.fsmonitor=false \
  -c core.untrackedCache=false status --porcelain=v1 --untracked-files=all)"
PARENT_WT_GITDIR="$(git -C "$PARENT_WT" rev-parse --absolute-git-dir)"
test -n "$PARENT_WT_GITDIR"
# Positive ownership exists only after add plus path/registration/HEAD/clean/
# gitdir verification. Cleanup cannot remove anything before this assignment.
PARENT_WT_CREATED=1

PARENT_AUTHORITY_JSON="$(python3 - "$PARENT_WT" "$PARENT" <<'PY'
import json, pathlib, subprocess, sys
root, parent = pathlib.Path(sys.argv[1]), sys.argv[2]
paths = [
    "crates/freshell-server/src/session_directory.rs",
    "crates/freshell-server/src/main.rs",
    "crates/freshell-sessions/src/search.rs",
    "crates/freshell-sessions/src/parse/opencode.rs",
    "crates/freshell-sessions/src/amplifier.rs",
    "test/fixtures/sessions/real-corrupted.jsonl",
    "test/fixtures/sessions/healthy.jsonl",
]
blobs = {}
for relative in paths:
    expected = subprocess.check_output(
        ["git", "-C", str(root), "rev-parse", f"{parent}:{relative}"],
        text=True,
    ).strip()
    actual = subprocess.check_output(
        ["git", "-C", str(root), "hash-object", relative],
        text=True,
    ).strip()
    if actual != expected:
        raise SystemExit(f"committed blob mismatch for {relative}")
    blobs[relative] = expected

session_source = (root / paths[0]).read_text(encoding="utf-8")
main_source = (root / paths[1]).read_text(encoding="utf-8")
opencode_source = (root / paths[3]).read_text(encoding="utf-8")
amplifier_source = (root / paths[4]).read_text(encoding="utf-8")
for token, source in {
    "CLAUDE_HOME": session_source,
    "CODEX_HOME": session_source,
    "XDG_DATA_HOME": opencode_source,
    "LOCALAPPDATA": opencode_source,
    "FRESHELL_AMPLIFIER_HOME": amplifier_source,
    "reqwest::Client::new": main_source,
    "UpdateChecker::new": main_source,
    "ReqwestLaneHttp::new": main_source,
}.items():
    if token not in source:
        raise SystemExit(f"pinned-source safety token missing: {token}")

def json_lines(relative):
    return [
        json.loads(line)
        for line in (root / relative).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]

corrupt = json_lines(paths[5])
healthy = json_lines(paths[6])
visible_ids = sorted({
    row["sessionId"]
    for row in corrupt
    if isinstance(row, dict) and isinstance(row.get("sessionId"), str)
})
excluded_ids = sorted({
    row["session_id"]
    for row in healthy
    if isinstance(row, dict) and isinstance(row.get("session_id"), str)
})
if visible_ids != ["b7936c10-4935-441c-837c-c1f33cafec2d"]:
    raise SystemExit(f"unexpected visible fixture IDs: {visible_ids!r}")
if excluded_ids != ["healthy-session-id"]:
    raise SystemExit(f"unexpected cwd-less fixture IDs: {excluded_ids!r}")

print(json.dumps({
    "mode": "pinned-source-fixture-fallback-no-process",
    "parent": parent,
    "blobs": blobs,
    "expected_visible_keys": [
        "claude:b7936c10-4935-441c-837c-c1f33cafec2d"
    ],
    "expected_cwdless_exclusions": ["claude:healthy-session-id"],
}, sort_keys=True, separators=(",", ":")))
PY
)"
printf '%s\n' "$PARENT_AUTHORITY_JSON"
python3 -c '
import json, sys
authority = json.loads(sys.stdin.read())
assert authority["mode"] == "pinned-source-fixture-fallback-no-process"
assert len(authority["blobs"]) == 7
' <<<"$PARENT_AUTHORITY_JSON"
test -z "$(git -C "$PARENT_WT" -c core.fsmonitor=false \
  -c core.untrackedCache=false status --porcelain=v1 --untracked-files=all)"
cleanup_parent_fixture_authority
trap - EXIT
```

Review and retain the printed authority JSON in execution evidence. Task 0
copies it verbatim into `PINNED_PARENT_SOURCE_FIXTURE_AUTHORITY`. Its deterministic
fixture test parses only the two committed transcript byte strings, asserts the
one visible key and one cwd-less exclusion above, supplies explicit in-memory
overrides/metadata/identities/colors, and traverses the actual owner-backed route
plus `with_full_application_layers`. It then freezes reviewed status,
content-type, and raw-body literals for no-query, Title, pre-seam validation
error, and derivation error. The source/fixture blobs and mechanically copied
FrozenOld body—not an ambient production process—are the independent
pre-extraction authority. If any pinned safety token/blob/fixture expectation
changes, stop for re-review; never fall back to launching the network-capable
binary.

Every reviewed owner raw result must be independent of registry iteration order;
where the selected winner is serialized, the fixture uses exactly one matching
identity. The A/B and B/A vectors belong only to fixed captures.

- [ ] **Step 3: Write all Task-0 tests before production edits**

Create the final test boundary:

```rust
/* SESSION_DIRECTORY_PAGE_BOUND_TESTS_BEGIN */
#[cfg(test)]
mod page_bound_tests {
    // All tests introduced by this plan live here.
}
/* SESSION_DIRECTORY_PAGE_BOUND_TESTS_END */
```

Write these exact tests:

```text
parent_full_application_layers_are_shared_with_production
parent_authority_case_manifest_has_expected_names_and_count
parent_raw_owner_backed_full_app_baseline_matches_reviewed_goldens
task0_owner_full_app_matches_pinned_parent_fixture_authority
frozen_old_reference_matches_parent_completed_responses
parent_fixture_models_no_index_and_empty_snapshot_separately
parent_success_reads_colors_after_derivation_and_error_reads_zero_colors
parent_owner_identity_acquisition_matches_same_registry_list_first_winner
task0_legacy_work_ledger_smoke
```

The first test calls `crate::with_full_application_layers` exactly once. The
manifest test compares exact ordered names and derives its count from
`EXPECTED_PARENT_CASE_NAMES`. Owner-backed tests invoke the
actual router and real layer assembler. Fixture builders may use synthetic
stores and `TestClock`, but no mock handler or middleware.

`parent_owner_identity_acquisition_matches_same_registry_list_first_winner`
creates one real `TerminalIdentityRegistry`, one indexed
`claude:same-session` row, and no competing page row; upserts A and B as two live
identities with those same provider/session components; calls `list()` once to
derive the first matching terminal ID; and then leaves that registry unchanged
while executing the actual owner-backed route through
`with_full_application_layers`. It asserts the completed response is successful,
parses the already-captured body, and asserts its `runningTerminalId` equals the
ID derived from that same registry's list. It also asserts a post-route `list()`
equals the pre-route vector. It never asserts that A or B is globally first and
owns no reviewed raw literal.

- [ ] **Step 4: Verify the declared RED**

```bash
set -euo pipefail
expect_debug_compile_failure \
  task0-full-layer-assembler \
  'error[E0425]: cannot find function `with_full_application_layers` in the crate root'
```

Expected RED: that diagnostic exactly once.

- [ ] **Step 5: Add the minimal behavior-neutral authority machinery**

Move the existing charset, limiter, and logging layer chain statement-for-
statement into `with_full_application_layers`, replace the inline chain with one
call, and add only the declared capture/renderer/FrozenOld/manifest/ledger
machinery. Keep handler derivation inline.

Replace `#[derive(Debug, Clone)]` on `DirItem` with `#[derive(Debug)]` and a
field-for-field manual `impl Clone for DirItem`; call
`bump_directory_full_row_clone` under `#[cfg(all(test, debug_assertions))]`
before returning. Wrap indexed construction, synth construction, and manual
Clone in the exact three `SESSION_DIRECTORY_FULL_ROW_PRODUCER` marker pairs. Add
and freeze every other named ledger bump. `task0_legacy_work_ledger_smoke` begins one
`DirectoryWorkScope`, invokes one controlled instance of each named site on the
same thread, finishes the scope, and compares the exact eight-field struct; it
then performs an unscoped legacy call and proves the next fresh scope still
starts at ZERO. This proves every constructor, decoration, annotation,
serialization, and manual clone bump is individually observable without
cross-request residue.

Copy the reviewed Step-2 authority JSON verbatim into
`PINNED_PARENT_SOURCE_FIXTURE_AUTHORITY`. Implement
`task0_owner_full_app_matches_pinned_parent_fixture_authority` so it first
rechecks the embedded parent/blob IDs and parses the two committed fixture byte
strings with the unchanged parsers. Assert exactly visible key
`claude:b7936c10-4935-441c-837c-c1f33cafec2d` and cwd-less exclusion
`claude:healthy-session-id`; then inject that parsed snapshot and explicit empty,
single-identity, or otherwise output-order-insensitive in-memory owner state into
four cases (no-query, Title, pre-seam validation error, derivation error).
Traverse `with_full_application_layers` and compare exact status, normalized
content-type, and raw body bytes to a reviewed deterministic four-entry table.
The test may not call
`provider_home`, read an environment variable/config path, instantiate a live
provider source, open a socket, or use a network client. The authority/table/test
live inside `parent-authority-response-fixtures` and freeze with Task 0.

Add temporary ignored test `parent_authority_emit_raw_literals`. Run it through
the exact owner-backed full-app executor, review every status/content-type/body,
copy the exact bytes into the frozen table, then delete the emitter:

```bash
set -euo pipefail
run_exact_debug_ignored "$TEST_MOD::parent_authority_emit_raw_literals"
```

No generated literal is accepted without reviewing its request/state manifest
row. Do not parse JSON before capturing the body. The emitter must reject any
proposed fixed raw golden whose bytes select among multiple same-key identities
according to registry iteration order. The separate relational owner test is
intentionally not copied into the raw-literal table.

- [ ] **Step 6: Run the same attested minimal GREEN**

```bash
set -euo pipefail
run_task0_focused() {
  local name
  for name in \
    parent_full_application_layers_are_shared_with_production \
    parent_authority_case_manifest_has_expected_names_and_count \
    parent_raw_owner_backed_full_app_baseline_matches_reviewed_goldens \
    task0_owner_full_app_matches_pinned_parent_fixture_authority \
    frozen_old_reference_matches_parent_completed_responses \
    parent_fixture_models_no_index_and_empty_snapshot_separately \
    parent_success_reads_colors_after_derivation_and_error_reads_zero_colors \
    parent_owner_identity_acquisition_matches_same_registry_list_first_winner \
    task0_legacy_work_ledger_smoke
  do
    run_exact_debug "$TEST_MOD::$name" || return 1
  done
}
run_task0_focused
```

Expected GREEN: all nine exact tests return zero; the pinned source/fixture
identity and revised deterministic Task-0 raw name slice match reviewed literals;
no raw literal depends on registry iteration order; the same-unchanged-registry
relational owner assertion passes without pinning A or B; no test consults
ambient provider/config/network state; color reads are success-only; and handler
derivation remains inline.

- [ ] **Step 7: Refactor test support/assembler only, rerun focused, then broader checks**

Do not change a reviewed body literal, manifest meaning, layer order, handler
derivation, or marked legacy behavior while refactoring.

```bash
set -euo pipefail
run_task0_focused
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_shared_comment_guard
```

Expected GREEN: the same focused tests and every broader command return zero.

- [ ] **Step 8: Commit and freeze**

```bash
set -euo pipefail
commit_exact_scope \
  'test(session-directory): freeze parent response authority' \
  crates/freshell-server/src/session_directory.rs \
  crates/freshell-server/src/main.rs
run_task0_guard
```

### Task 1: Extract and separately freeze the Materialized strategy

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs` only.

**Precondition:** clean worktree; `run_task0_guard` passes.

**Interfaces produced:** `OwnedIndexCapture`, `OwnedDirectoryInputs`,
`capture_directory_inputs`, `DirectoryStrategy`, `materialized_page`,
`materialized_dispatch`, and `build_directory_page` as declared above.

- [ ] **Step 1: Write the exact extraction/capture tests first**

```text
extracted_materialized_completed_responses_match_frozen_parent
handler_capture_order_is_index_overrides_metadata_identities_then_colors
handler_no_index_order_skips_snapshot_but_preserves_the_rest
handler_derivation_error_never_reads_project_colors
revision_can_decrease_when_the_max_activity_source_disappears
request_revision_does_not_pin_the_index_capture
```

The primary helper contains exactly one call to absent `materialized_page`.

- [ ] **Step 2: Verify RED**

```bash
set -euo pipefail
run_task0_guard
expect_debug_compile_failure \
  task1-materialized-extraction \
  'error[E0425]: cannot find function `materialized_page` in this scope'
```

- [ ] **Step 3: Extract minimally**

Capture `NoIndex` or the exact awaited snapshot, then overrides, metadata, and
ordered identities. Move the legacy derivation statement-for-statement into
`materialized_page`; `materialized_dispatch` calls it; `build_directory_page`
initially calls Materialized. Use `directory_result_response` so colors remain
success-only. Mark only the two Task-1 authority regions. Do not edit/reformat
Task-0 regions.

- [ ] **Step 4: Run the same attested minimal GREEN**

```bash
set -euo pipefail
run_task1_focused() {
  local name
  for name in \
    extracted_materialized_completed_responses_match_frozen_parent \
    handler_capture_order_is_index_overrides_metadata_identities_then_colors \
    handler_no_index_order_skips_snapshot_but_preserves_the_rest \
    handler_derivation_error_never_reads_project_colors \
    revision_can_decrease_when_the_max_activity_source_disappears \
    request_revision_does_not_pin_the_index_capture
  do
    run_exact_debug "$TEST_MOD::$name" || return 1
  done
}
run_task1_focused
```

Expected GREEN: exact old/extracted completed responses match, both index states
and the identity vector order supplied by each capture are preserved without
asserting any requested concrete-registry order, trace is `I/O/M/L/P`, and errors
read no colors.

- [ ] **Step 5: Refactor outside both authorities, rerun focused, then broader checks**

```bash
set -euo pipefail
run_task1_focused
run_exact_debug "$TEST_MOD::parent_raw_owner_backed_full_app_baseline_matches_reviewed_goldens"
run_exact_debug "$TEST_MOD::task0_owner_full_app_matches_pinned_parent_fixture_authority"
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_task0_guard
```

Expected GREEN: the same focused tests, parent raw fixture, and all broader
commands return zero without changing Task-0 regions.

- [ ] **Step 6: Commit and freeze the second authority**

```bash
set -euo pipefail
commit_exact_scope \
  'refactor(session-directory): extract frozen materialized strategy' \
  crates/freshell-server/src/session_directory.rs
run_both_guards
```

### Task 2: Characterize every reusable legacy equivalence fixture

**Files:** test boundary only in
`crates/freshell-server/src/session_directory.rs`.

**Interfaces produced:** deterministic fixture constructors reused by G1/G2/G3;
no production symbol.

This is evidence-only: add each `legacy_` test before changing its fixture
helper and run it exactly. If current behavior differs from an expectation,
record actual frozen legacy behavior; never change production or either
authority here.

Required fixtures explicitly cover exact duplicate tuples/rows and boundary
straddles; full-key/colon collisions; deletion/synth ties; ordered identity
permutations and missing/empty component fallback collisions; arbitrary and
malformed cursors; deep limit-1 chains; every limit 1–50 and L-1/L/L+1; all
eight flags; malformed/wrong-typed override and metadata values; negative and
i64 boundaries; long deleted/filtered prefixes; T=0/1/50/51/500; broad Unicode,
case expansions, combining text, 4,000-character fields; exact 139/140/141
snippet boundaries; NoIndex/empty; success/error color reads and map order; and
retained file-tier partial behavior.

The identity-winner fixture table has exactly these two fixed-capture subcases:

```text
fixed_capture_identity_first_winner_a_then_b
fixed_capture_identity_first_winner_b_then_a
```

Each contains one indexed `claude:same-session` row and two exact matching
identities with equal non-order fields. The first case supplies the literal vector
`[terminal-a, terminal-b]` and expects `runningTerminalId == "terminal-a"`; the
second supplies `[terminal-b, terminal-a]` and expects
`runningTerminalId == "terminal-b"`. The fixture constructs
`OwnedDirectoryInputs`/`CapturedDirectoryInputs` directly and never calls
`TerminalIdentityRegistry::list()`.

`legacy_ordered_identity_permutations_choose_first_winner` freezes the two direct
FrozenOld outcomes.
`g1_ordered_identity_permutations_old_materialized_fast` compares FrozenOld,
ExtractedMaterialized, and Fast values plus direct renderer bytes for both fixed
cases and asserts the named expected winner.
`g1_completed_strategy_matrix_old_extracted_fast` runs those same two cases
through `completed_strategy_app` for all three `ComparisonStrategy` variants and
compares exact `CompletedJsonResponse` status, content type, and raw body bytes.
These remain subcases of the existing top-level tests; no aggregate count changes,
and any internal completed-strategy case count is derived from its explicit table.

```bash
set -euo pipefail
run_legacy_aggregate
run_exact_debug "$TEST_MOD::parent_raw_owner_backed_full_app_baseline_matches_reviewed_goldens"
run_exact_debug "$TEST_MOD::task0_owner_full_app_matches_pinned_parent_fixture_authority"
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_both_guards
commit_exact_scope \
  'test(session-directory): characterize reusable legacy equivalence cases' \
  crates/freshell-server/src/session_directory.rs
```

GREEN criteria: exact 33-test inventory passes and authorities are unchanged.

### Task 3: Add borrowed matching and carried title decisions

**Files:**
- Modify production/test regions outside authorities in
  `crates/freshell-server/src/session_directory.rs`.

**Interfaces produced:** `contains_ci`, `key_cmp`, `canonical_identity_key`,
`is_deleted`, effective field helpers, borrowed provider display,
`TitleMatchField`, `title_match_field`, and
`annotate_selected_title_match` exactly as declared.

- [ ] **Step 1: Write six focused tests first**

```text
contains_ci_matches_legacy_lowercase_table
key_cmp_matches_allocated_full_key_table_including_colon_collisions
provider_display_name_borrowed_matches_frozen_allocating_helper
title_match_field_matches_legacy_precedence_and_139_140_141_table
selected_title_annotation_uses_the_carried_field_without_retesting
post_selection_title_field_drift_fails_closed
```

- [ ] **Step 2: Verify RED**

```bash
set -euo pipefail
expect_debug_compile_failure \
  task3-borrowed-matchers \
  'error[E0425]: cannot find function `contains_ci` in this scope'
```

- [ ] **Step 3: Implement minimally**

Hoist one lowercased query. Match title, summary, then first message on borrowed
override-effective fields. Return `Option<TitleMatchField>`. Annotation reads
only the carried enum and corresponding already-decorated field; an impossible
missing field returns a fail-closed error/assertion in tests and cannot silently
skip a selected row. Call `bump_directory_title_annotation` exactly once for
each returned Fast Title row; do not define another counter helper.

- [ ] **Step 4: Run the same attested minimal GREEN**

```bash
set -euo pipefail
run_task3_focused() {
  local name
  for name in \
    contains_ci_matches_legacy_lowercase_table \
    key_cmp_matches_allocated_full_key_table_including_colon_collisions \
    provider_display_name_borrowed_matches_frozen_allocating_helper \
    title_match_field_matches_legacy_precedence_and_139_140_141_table \
    selected_title_annotation_uses_the_carried_field_without_retesting \
    post_selection_title_field_drift_fails_closed
  do
    run_exact_debug "$TEST_MOD::$name" || return 1
  done
}
run_task3_focused
```

Expected GREEN: all six exact tests return zero against the minimal helpers.

- [ ] **Step 5: Refactor helpers only, rerun focused, broader checks, then commit**

```bash
set -euo pipefail
run_task3_focused
run_legacy_aggregate
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_both_guards
commit_exact_scope \
  'feat(session-directory): add borrowed matching decisions' \
  crates/freshell-server/src/session_directory.rs
```

### Task 4: Add the no-query Fast candidate, still undispatched

**Files:** `crates/freshell-server/src/session_directory.rs` outside authorities.

**Interfaces produced:** descriptor/merge/materialization/forced-strategy
interfaces and the all-Materialized selector exactly as declared.

- [ ] **Step 1: Write all no-query G2 tests first**

Write the ten exact no-query/static/clone tests below plus
`dispatch_all_shapes_are_materialized_before_gates`. The shared forced-strategy
helper contains one call to absent `fast_path_page`. Every behavioral row builds
an explicit `CapturedDirectoryInputs`, calls
`successful_fast_page_with_ledger`, derives expected indexed/synth provenance
from fixture keys, asserts exact item keys/order/cursor/revision, then asserts all
successful-Fast equations and `full_row_clone == 0`.

| Exact test | Fixed fixture/call/assertions |
|---|---|
| `g2_no_query_indexed_work_table_is_exact` | Table `(N,limit)={(0,50),(1,50),(49,50),(50,50),(51,50)}`, T=0, no cursor, flags 000. Add two boundary compositions: raw untitled row + typed `titleOverride:"rescued"` must be visible/backfill; raw titled row + nonempty whitespace override must become effectively empty/hidden and backfill. Force Fast; assert independently listed returned keys, cursor iff a 51st visible descriptor exists, `indexed_full == returned_indexed`, each indexed decoration equals that count, serialization equals returned count, synth/clone zero. |
| `g2_no_query_synth_work_table_is_exact` | N=0; T in `{0,1,49,50,51,500}` distinct provider-bearing visible identities; limit 50, flags 111. Assert returned synth count `min(T,50)`, cursor iff `T>50`, synth/serialization exact, every indexed stage/title/clone zero. |
| `g2_no_query_all_filtered_large_live_set_builds_zero_items` | N=0, T=500 identities with `is_subagent=Some(true)`, flags 000, limit 50. Assert empty body/null cursor and every ledger field zero. |
| `g2_no_query_mixed_indexed_and_synth_work_is_exact` | N=49 visible indexed `claude:idx-{timestamp}` rows, one for every even `last_activity_at` in the inclusive range 104..=200; two unsuppressed, provider-bearing, otherwise noncolliding synths `claude:synth-mid` at 151 and `claude:synth-tail` at 1; no query or cursor; T=2, limit 50, flags 111. Independently expect the descending indexed timestamps 200 through 152, then `claude:synth-mid` at ordinal 26, then descending indexed timestamps 150 through 104. Assert exact key order, the exact legacy cursor encoding of `(104, "claude:idx-104")`, revision 200, and `claude:synth-tail` as descriptor 51/lookahead only. Assert 49 indexed + 1 synth returned, 49 of each indexed stage, one synth constructor, 50 serializations, zero title/clones. |
| `g2_no_query_duplicate_and_cursor_filtered_synths_build_only_returned_rows` | N=2, ordered T=51 containing same-full-key first-winner duplicates, colon-colliding tuples, synths before/on/after an arbitrary cursor; limit 2. Assert exact two post-cursor winner keys/terminal IDs and construct only their independently known provenance; all duplicate/prefix/lookahead descriptors remain unconstructed. |
| `g2_no_query_lookahead_descriptor_is_never_constructed` | N=51 visible indexed rows, T=0, limit 50. Assert 50 returned, nonnull cursor from row 50, and exactly 50 indexed constructions/decorations/serializations—not 51. |
| `g2_candidate_source_has_no_direct_dir_item_literal` | Call the shared `audit_fast_dir_item_production_contract(include_str!("session_directory.rs"))`; require exact producer/helper sets and no violations. Specifically assert its tokenized Fast region reports zero direct construction tokens outside the two marked producer bodies reached through `materialize_selected_descriptor`. Ordinary `DirItem` references and the two allowed helper return declarations do not count as construction. |
| `g2_fast_region_has_no_clone_or_indirect_full_row_construction` | Call the same audit helper and require no clone token anywhere in the Fast/helper regions, no producer call outside `materialize_selected_descriptor`, no unknown `DirItem`-returning declaration/call, and a recursively closed helper graph of `materialize -> {indexed,synth}` and `annotate -> {}`. This is the sole interpretation of “indirect”; no adjacent broader return-type ban exists. |
| `g2_full_row_constructor_inventory_is_exact_and_instrumented` | Call the same audit helper; assert exactly the three producer markers, exactly the two helper markers, exactly one manual `impl Clone for DirItem`, and the matching bump helper in each producer. Require the audit's complete violation list to be empty. The compile-valid unmarked `uninstrumented_full_row_copy` mutation returns `DirItem` and clones, so it necessarily appears as both an unknown returning helper and a clone violation and this exact test kills it. |
| `g2_one_returned_row_with_500_identities_has_zero_full_row_clones` | N=1 indexed row; T=500 ordered identities all exact-component-match that row; limit 50, flags 111. Assert one indexed row/first terminal winner, no synth, one of each indexed stage/serialization, and zero clones. The compile-valid mutation must leave response bytes unchanged while making `full_row_clone == 500`. |

Implement the one shared audit interface exactly once in the test boundary:

```rust
#[cfg(all(test, debug_assertions))]
#[derive(Debug, PartialEq, Eq)]
struct FastDirItemProductionAudit {
    producers: std::collections::BTreeSet<&'static str>,
    helpers: std::collections::BTreeSet<&'static str>,
    helper_edges: std::collections::BTreeSet<(&'static str, &'static str)>,
    violations: Vec<String>,
}

#[cfg(all(test, debug_assertions))]
fn audit_fast_dir_item_production_contract(source: &str) -> FastDirItemProductionAudit;
```

The implementation uses the lexical/marker rules in the named-work contract,
not three independent regex interpretations. Its exact accepted sets are
`{indexed,synth,clone}`, `{materialize,annotate}`, and
`{(materialize,indexed),(materialize,synth)}`. It sorts/deduplicates findings,
requires every marker exactly once and properly nested, and records any lexical
failure, direct construction, clone, unknown returning declaration/call,
illegal producer call site, macro/function-pointer escape, or unresolved helper
edge as a violation. Each of the three source-audit tests calls this helper and
then adds only its named focused assertion; none redefines what a producer,
pass-through return, or violation means.

`dispatch_all_shapes_are_materialized_before_gates` directly asserts no-query,
blank-query, nonempty Title, and both nonempty file tiers are still Materialized.
The two effective-title rows above are mandatory call-site evidence that
`candidate_is_visible(candidate, q, overrides, identities)` and
`candidate_is_nonempty(candidate, overrides, identities)` receive the captured
override view; a raw-title-only implementation cannot pass.

- [ ] **Step 2: Verify RED**

```bash
set -euo pipefail
expect_debug_compile_failure \
  task4-no-query-fast-path \
  'error[E0425]: cannot find function `fast_path_page` in this scope'
```

- [ ] **Step 3: Implement one coherent no-query descriptor path**

Use a canonical-key set/map for expected `O(N + T)` lookups plus key-byte cost;
do not perform O(N*T) synth suppression. Keep ordered first winners. Decode
cursor, compute revision globally, bind `overrides = inputs.overrides` and
`identities = inputs.identities`, merge borrowed indexed/synth descriptors, and
stop after `limit + 1` visible descriptors. Every visibility call is exactly
`candidate_is_visible(candidate, q, overrides, identities)`; its empty branch is
exactly:

```rust
if !q.include_empty && !candidate_is_nonempty(candidate, overrides, identities) {
    return false;
}
```

For Indexed that helper obtains the exact override object by full key and passes
it to `effective_title`; for Synth it returns true. Materialize `.take(limit)`
only.

Keep these canonical mutation anchors exactly through Task 7:

```rust
if is_deleted(overrides, &candidate_full_key(candidate)) {
    continue;
}
```

```rust
fn materialize_selected_descriptor(
```

```rust
Ordering::Less | Ordering::Equal => MergeSide::Indexed,
Ordering::Greater => MergeSide::Synth,
```

```rust
let mut item = materialize_selected_descriptor(selected, inputs);
```

```rust
rows_with_lookahead
    .into_iter()
    .take(limit)
```

Do not use any clone operation in the Fast region. The static tests extract the
marked region, reject every forbidden constructor/clone token, and compare the
transitive full-row producer inventory to the exact instrumented allowlist.
Every successful case asserts all equations including zero clones. The
all-filtered T=500 case constructs zero rows; T=51/T=500 visible synth cases
construct exactly returned rows; lookahead remains unconstructed.

- [ ] **Step 4: Run the same attested minimal GREEN**

```bash
set -euo pipefail
run_task4_focused() {
  run_exact_debug "$TEST_MOD::g2_no_query_indexed_work_table_is_exact" || return 1
  run_exact_debug "$TEST_MOD::g2_no_query_synth_work_table_is_exact" || return 1
  run_exact_debug "$TEST_MOD::g2_no_query_all_filtered_large_live_set_builds_zero_items" || return 1
  run_exact_debug "$TEST_MOD::g2_no_query_mixed_indexed_and_synth_work_is_exact" || return 1
  run_exact_debug "$TEST_MOD::g2_no_query_duplicate_and_cursor_filtered_synths_build_only_returned_rows" || return 1
  run_exact_debug "$TEST_MOD::g2_no_query_lookahead_descriptor_is_never_constructed" || return 1
  run_exact_debug "$TEST_MOD::g2_candidate_source_has_no_direct_dir_item_literal" || return 1
  run_exact_debug "$TEST_MOD::g2_fast_region_has_no_clone_or_indirect_full_row_construction" || return 1
  run_exact_debug "$TEST_MOD::g2_full_row_constructor_inventory_is_exact_and_instrumented" || return 1
  run_exact_debug "$TEST_MOD::g2_one_returned_row_with_500_identities_has_zero_full_row_clones" || return 1
}
run_task4_focused
```

Expected GREEN: exact counts, zero-clone equations, descriptor lookahead, and
static/transitive constructor audits pass against the minimal candidate. The
mixed fixture also returns `claude:synth-mid` at ordinal 26 and ends at
`claude:idx-104` with that row's exact cursor; counts alone are insufficient.

- [ ] **Step 5: Refactor Fast selection only, rerun focused/broader, then commit without routing**

```bash
set -euo pipefail
run_task4_focused
run_legacy_aggregate
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_both_guards
run_exact_debug "$TEST_MOD::dispatch_all_shapes_are_materialized_before_gates"
commit_exact_scope \
  'perf(session-directory): add page-bounded no-query candidate' \
  crates/freshell-server/src/session_directory.rs
```

Expected GREEN: the same focused and broader checks pass and production remains
all Materialized.

### Task 5: Add the title Fast candidate, still undispatched

**Files:** `crates/freshell-server/src/session_directory.rs` outside authorities.

**Interfaces consumed:** Task 3's carried title decision and Task 4 descriptors.
No new selector state.

- [ ] **Step 1: Write the eight title G2 tests; reuse Task 3's drift test**

Do not declare a second `post_selection_title_field_drift_fails_closed` symbol;
Task 5 reruns the one already created in Task 3. Each new behavioral test uses a
nonempty Title query, an explicit fixture, and
`successful_fast_page_with_ledger`; it derives expected provenance from fixture
keys and asserts exact page/cursor/revision plus all successful-Fast equations.

| Exact new test | Fixed fixture/call/assertions |
|---|---|
| `g2_title_early_dense_matches_build_only_returned_rows` | N=51, T=0, every title contains `needle`, limit 50, flags 111. Assert first 50 exact keys, cursor from key 50, 50 indexed constructions/decorations/annotations/serializations, zero synth/clones. |
| `g2_title_late_sparse_matches_scan_but_build_only_returned_rows` | N=400, T=0; exact matches only at source ordinals 350 and 399, with one match supplied solely by `titleOverride` and one solely by `summaryOverride`; limit 2. Assert both effective-field matches in stream order, null cursor, exactly two full indexed rows/stages/annotations/serializations despite the long scan. |
| `g2_title_no_match_builds_zero_rows` | N=400, T=0, query absent from raw and effective fields. Assert empty/null cursor and every ledger field zero. |
| `g2_title_long_ascii_fields_are_exact` | Three rows whose 4,000-byte title, summary, and first-message fields respectively contain a late ASCII match; limit 3. Assert field precedence, exact 140-scalar snippets, three indexed rows/stages/annotations/serializations, zero synth/clones. |
| `g2_title_non_ascii_expansion_table_is_exact` | Fixed table covering CAFÉ, dotted-I expansion, Straße, Greek sigma, and combining text in each match field. For each query, compare exact returned keys/`matchedIn`/snippet to the frozen legacy fixture and exact per-row ledger equations. |
| `g2_title_mixed_indexed_and_synth_work_is_exact` | N=49 matching indexed rows plus two unsuppressed provider-display synth matches ordered one in page/one lookahead, limit 50, flags 111. Assert 49 indexed + 1 synth, cursor, 49 indexed stages, one synth construction, 50 annotations/serializations, zero clones. |
| `g2_title_synth_matches_build_only_selected_rows` | N=0, T=51 provider-bearing identities whose borrowed display titles match `CLI`, limit 50, flags 111. Assert 50 exact first-winner synth keys, cursor, 50 synth constructions/annotations/serializations, all indexed stages/clone zero. |
| `g2_title_post_selection_has_no_rejection_path` | N=51 with selected matches distributed across title/summary/first-message and one descriptor lookahead; limit 50. Assert exactly 50 rows and a cursor fixed by row 50. Source-audit the materialization region: carried `TitleMatchField` annotation exists exactly once and no `apply_title_search`, `filter`, `filter_map`, rejecting `match`, or `continue` occurs after selection. Carries marker `RED_TITLE_FAST_PATH_MUST_USE_CARRIED_DECISION` before Task-5 implementation. |

The late-sparse override-only matches are mandatory dataflow evidence that Title
selection receives `inputs.overrides`; they complement Task 4's override-effective
nonempty visibility cases.

- [ ] **Step 2: Verify RED**

```bash
set -euo pipefail
expect_exact_debug_failure \
  "$TEST_MOD::g2_title_post_selection_has_no_rejection_path" \
  RED_TITLE_FAST_PATH_MUST_USE_CARRIED_DECISION
```

- [ ] **Step 3: Implement minimally**

For each Indexed descriptor, look up `inputs.overrides` by the exact full key,
pass that object to `effective_title`/`effective_summary`, evaluate
`title_match_field` on those borrowed effective fields during selection, and
store the result. Synth descriptors use borrowed provider display title and no
override row. Materialize only returned matches, decorate once, annotate
from that exact enum, and serialize once. There is no `apply_title_search`
re-search and no normal post-selection `continue`/filter. Sparse/late/no-match
queries may scan the corpus; full-row work remains exact returned-page work.

- [ ] **Step 4: Run the same attested minimal GREEN**

```bash
set -euo pipefail
run_task5_focused() {
  run_exact_debug "$TEST_MOD::g2_title_post_selection_has_no_rejection_path" || return 1
  run_exact_debug "$TEST_MOD::g2_title_early_dense_matches_build_only_returned_rows" || return 1
  run_exact_debug "$TEST_MOD::g2_title_late_sparse_matches_scan_but_build_only_returned_rows" || return 1
  run_exact_debug "$TEST_MOD::g2_title_no_match_builds_zero_rows" || return 1
  run_exact_debug "$TEST_MOD::g2_title_long_ascii_fields_are_exact" || return 1
  run_exact_debug "$TEST_MOD::g2_title_non_ascii_expansion_table_is_exact" || return 1
  run_exact_debug "$TEST_MOD::g2_title_mixed_indexed_and_synth_work_is_exact" || return 1
  run_exact_debug "$TEST_MOD::g2_title_synth_matches_build_only_selected_rows" || return 1
  run_exact_debug "$TEST_MOD::post_selection_title_field_drift_fails_closed" || return 1
}
run_task5_focused
```

Expected GREEN: carried title selection/annotation, no post-selection rejection,
and every exact title work equation pass against the minimal implementation.

- [ ] **Step 5: Refactor title selection only, rerun focused/broader, then commit undispatched**

```bash
set -euo pipefail
run_task5_focused
run_g2_aggregate
run_legacy_aggregate
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_both_guards
run_exact_debug "$TEST_MOD::dispatch_all_shapes_are_materialized_before_gates"
commit_exact_scope \
  'perf(session-directory): add page-bounded title candidate' \
  crates/freshell-server/src/session_directory.rs
```

### Task 6: Commit complete G1 and compile-valid mutation killers

**Files:** test boundary only in `session_directory.rs`.

**Interfaces produced:** `ComparisonStrategy`, `completed_strategy_app`, complete
G1 generators/tables, and mutation-addressable exact tests. No production
behavior; do not manufacture RED. If evidence reveals a production defect,
return to Task 4 or 5 and rebuild/replay rather than fixing production here.

The exhaustive counts are independently fixed:

- Membership/order: four fixed indexed rows give `2^4 = 16` masks. Four fixed
  identities give every ordered subset
  `P(4,0)+...+P(4,4) = 1+4+12+24+24 = 65`. Cross all eight flags, query modes
  `{none,title-hit}`, and limits `{1,4}`:
  `16 * 65 * 8 * 2 * 2 = 33,280` captures.
- Cursor/limit: four separately fixed four-row captures, each with an explicit
  ten-entry cursor table (`None`, before first, on each of four positions,
  three between positions, after last), limits `{1,2,3,4}`, query modes
  `{none,title-hit,title-miss}`, and all eight flags:
  `4 * 10 * 4 * 3 * 8 = 3,840` captures.
- Assert independent constants `37,120` captures and `111,360` strategy
  evaluations. Do not derive them from the generator under test. Large,
  malformed, Unicode, raw-route, and full limits 1–50 remain targeted.

Exhaustive cases compare three results and direct renderer bytes. Targeted fixed
strategy and actual owner route matrices traverse full layers.
`g1_completed_full_app_route_matrix_matches_parent` iterates the revised exact
`EXPECTED_PARENT_CASE_NAMES` slice—including `single_identity_running_join`, both
retained-tier cursor rows, fullText partial, and all three color-route rows—and
asserts its executed raw-name sequence and length equal that slice before
comparing status/content-type/raw body. The fixed A/B and B/A subcases are not in
that raw sequence. After the raw loop, the test reuses the frozen
same-unchanged-registry relational owner assertion; that assertion has no
raw-manifest name and does not contribute to the derived raw sequence length of
22. `g1_ordered_identity_permutations_old_materialized_fast` and
`g1_completed_strategy_matrix_old_extracted_fast` provide the fixed-vector value
and completed-byte evidence. Add the exact deletion backfill Fast killer before
mutations. Also add these exact selector-contract tests while the production
selector is still all Materialized:

```text
dispatch_nonempty_user_messages_and_full_text_are_materialized
dispatch_tier_without_query_is_no_query_branch
dispatch_blank_query_is_no_query_branch
```

```bash
set -euo pipefail
run_g1_aggregate
run_legacy_aggregate
run_exact_debug "$TEST_MOD::dispatch_nonempty_user_messages_and_full_text_are_materialized"
run_exact_debug "$TEST_MOD::dispatch_tier_without_query_is_no_query_branch"
run_exact_debug "$TEST_MOD::dispatch_blank_query_is_no_query_branch"
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_both_guards
commit_exact_scope \
  'test(session-directory): commit complete compatibility and mutation-killer gates' \
  crates/freshell-server/src/session_directory.rs
TASK6_COMMIT="$(git -C "$WT" rev-parse HEAD)"
export TASK6_COMMIT
```

GREEN criteria: exact 21 G1/33 legacy inventories, the revised deterministic raw
owner sequence, the relational same-registry owner acquisition assertion, both
fixed identity permutations, and retained dispatch tests return zero. Record
`TASK6_COMMIT`; scratch mutation begins only from this committed clean state.

### Task 7: Validate exact compiling mutations in a disposable scratch worktree

**Repository commit:** none. Scratch is detached at the committed Task-6 hash.
Never mutate or restore the active worktree.

Use the complete protocol in **Scratch mutation protocol** below. Every mutation
must (1) change each declared old snippet exactly once, (2) compile successfully,
(3) list its exact killer once, (4) fail that exact Fast/selector test once, and
(5) restore only the disposable scratch file to the committed scratch base.
Compilation failure is invalid setup, never a kill.

A surviving mutation permits a test-only Task-6 amendment through the exact
amend guard below, followed by recreation and a full mutation rerun. A real
candidate defect returns to Task 4/5 and replays subsequent commits.

### Task 8: Audit G2 and run finite release G3 before routing

**Files:** test boundary only in `session_directory.rs`.

The 18 G2 tests already exist from Tasks 4/5. Add only the explicit G3 manifest
and `adverse_release_ab_non_regression`; do not change production. A G2/G3
production defect returns to Task 4/5.

```bash
set -euo pipefail
run_g2_aggregate
run_g1_aggregate
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_both_guards
run_exact_release_ignored "$TEST_MOD::adverse_release_ab_non_regression"
commit_exact_scope \
  'test(session-directory): add exact work and finite adverse release gates' \
  crates/freshell-server/src/session_directory.rs
```

This is the only pre-switch full G3. Its exact manifest/statistics are below.

### Task 9: Switch no-query in one selector-only commit

**Files:** selector and its test only in `session_directory.rs`.

- [ ] **Step 1: Write the production selector test first**

`production_dispatch_routes_no_query_fast` must fail with marker
`RED_NO_QUERY_SELECTOR_STILL_MATERIALIZED` before the selector edit.

```bash
set -euo pipefail
expect_exact_debug_failure \
  "$TEST_MOD::production_dispatch_routes_no_query_fast" \
  RED_NO_QUERY_SELECTOR_STILL_MATERIALIZED
```

- [ ] **Step 2: Minimal GREEN**

Change only `(false, _)` to Fast. Nonempty Title and both file tiers remain
Materialized.

```bash
set -euo pipefail
run_exact_debug "$TEST_MOD::production_dispatch_routes_no_query_fast"
```

- [ ] **Step 3: Refactor selector expression only, rerun, and commit**

```bash
set -euo pipefail
run_exact_debug "$TEST_MOD::production_dispatch_routes_no_query_fast"
run_exact_debug "$TEST_MOD::g1_completed_full_app_route_matrix_matches_parent"
run_exact_debug "$TEST_MOD::dispatch_nonempty_user_messages_and_full_text_are_materialized"
run_g1_aggregate
run_g2_aggregate
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_both_guards
commit_exact_scope \
  'perf(session-directory): route no-query requests through the fast path' \
  crates/freshell-server/src/session_directory.rs
```

Do not rerun G3 here: it forces both strategies and Task 8 just ran the full
manifest. This commit contains only selector/test changes.

### Task 10: Switch nonempty Title in the second selector-only commit

**Files:** selector and its test only in `session_directory.rs`.

- [ ] **Step 1: Write the final selector test first**

```bash
set -euo pipefail
expect_exact_debug_failure \
  "$TEST_MOD::production_dispatch_routes_nonempty_title_fast_and_retains_file_tiers" \
  RED_TITLE_SELECTOR_STILL_MATERIALIZED
```

- [ ] **Step 2: Minimal GREEN**

Change only nonempty Title to Fast. Final table:

```text
no/blank query, any tier                  -> Fast
nonempty query + Title                    -> Fast
nonempty query + UserMessages or FullText -> Materialized
```

```bash
set -euo pipefail
run_exact_debug "$TEST_MOD::production_dispatch_routes_nonempty_title_fast_and_retains_file_tiers"
```

- [ ] **Step 3: Refactor selector only, perform final checks, and commit**

```bash
set -euo pipefail
run_exact_debug "$TEST_MOD::production_dispatch_routes_nonempty_title_fast_and_retains_file_tiers"
run_exact_debug "$TEST_MOD::g1_completed_full_app_route_matrix_matches_parent"
run_exact_debug "$TEST_MOD::dispatch_nonempty_user_messages_and_full_text_are_materialized"
run_g1_aggregate
run_g2_aggregate
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_shared_typecheck
run_both_guards
run_exact_release_ignored "$TEST_MOD::adverse_release_ab_non_regression"
commit_exact_scope \
  'perf(session-directory): route title search through the fast path' \
  crates/freshell-server/src/session_directory.rs
```

This is the sole post-switch whole G3. Completion requires both Fast selectors,
retained Materialized file tiers, and the compiled/tested Materialized rollback
path.

---

## Scratch Mutation Protocol

### Setup and fail-closed helpers

```bash
set -euo pipefail
run_both_guards
: "${TASK6_COMMIT:?Task 6 must export TASK6_COMMIT before scratch validation}"
test "$(git -C "$WT" rev-parse HEAD)" = "$TASK6_COMMIT"
MUTATION_BASE="$TASK6_COMMIT"
test "$(git -C "$WT" show -s --format=%s "$MUTATION_BASE")" = \
  'test(session-directory): commit complete compatibility and mutation-killer gates'
MUT_WT=/home/dan/code/freshell/.worktrees/session-directory-page-bound-mutation-scratch
test ! -e "$MUT_WT"
git -C "$WT" worktree add --detach "$MUT_WT" "$MUTATION_BASE"
test "$(git -C "$MUT_WT" rev-parse HEAD)" = "$MUTATION_BASE"
test -z "$(git -C "$MUT_WT" status --short)"

scratch_list_tests() {
  local output line
  output="$(cargo test --manifest-path "$MUT_WT/Cargo.toml" -p freshell-server -- --list)" || return 1
  while IFS= read -r line; do
    case "$line" in *': test') printf '%s\n' "${line%: test}" || return 1 ;; esac
  done <<<"$output"
}

scratch_assert_one() {
  local name="$1" names line count=0
  names="$(scratch_list_tests)" || return 1
  while IFS= read -r line; do
    if test "$line" = "$name"; then count=$((count + 1)); fi
  done <<<"$names"
  test "$count" -eq 1 || { printf 'expected one scratch test %s; found %s\n' "$name" "$count" >&2; return 1; }
}

scratch_compile_mutation() {
  cargo test --manifest-path "$MUT_WT/Cargo.toml" -p freshell-server --no-run || {
    printf 'INVALID MUTATION SETUP: mutated tree does not compile\n' >&2
    return 1
  }
}

scratch_require_killed() {
  local name="$1" log expected
  scratch_assert_one "$name" || return 1
  log="$(mktemp)" || return 1
  if cargo test --manifest-path "$MUT_WT/Cargo.toml" -p freshell-server \
      "$name" -- --exact --test-threads=1 >"$log" 2>&1; then
    printf 'SURVIVED: %s\n' "$name" >&2
    cat "$log" >&2 || true
    rm -f "$log"
    return 1
  fi
  expected="test $name ... FAILED"
  python3 - "$log" "$expected" <<'PY' || { cat "$log" >&2 || true; rm -f "$log"; return 1; }
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
if text.count(sys.argv[2]) != 1:
    raise SystemExit("failure was not the declared test exactly once")
PY
  cat "$log" || { rm -f "$log"; return 1; }
  rm -f "$log"
}

scratch_restore() {
  git -C "$MUT_WT" restore --source="$MUTATION_BASE" --staged --worktree -- \
    crates/freshell-server/src/session_directory.rs || return 1
  test -z "$(git -C "$MUT_WT" status --short)" || return 1
}
```

The restore targets only the disposable scratch file. It is never run in the
active or foreign worktree.

### Exact mutation engine

Tasks 4/5 retain the canonical snippets used below through Task 7. Every
pre-edit old count must be one/new zero; every post-edit old count must be
zero/new one.

```bash
set -euo pipefail
apply_exact_mutation() {
  local mutation="$1" file="$MUT_WT/crates/freshell-server/src/session_directory.rs"
  python3 - "$file" "$mutation" <<'PY'
from __future__ import annotations
import pathlib, sys
path = pathlib.Path(sys.argv[1])
name = sys.argv[2]
M = {
"reverse-full-key-order": [(".then_with(|| candidate_full_key(right).cmp(&candidate_full_key(left)))", ".then_with(|| candidate_full_key(left).cmp(&candidate_full_key(right)))")],
"defer-synth-on-greater": [("Ordering::Greater => MergeSide::Synth,", "Ordering::Greater => MergeSide::Indexed,")],
"cursor-inclusive": [("last_activity_at < cursor_last", "last_activity_at <= cursor_last")],
"deletion-after-selection": [
    ("if is_deleted(overrides, &candidate_full_key(candidate)) {\n            continue;\n        }", "if false && is_deleted(overrides, &candidate_full_key(candidate)) {\n            continue;\n        }"),
    ("let mut item = materialize_selected_descriptor(selected, inputs);", "if is_deleted(inputs.overrides, &candidate_full_key(selected.candidate)) {\n            continue;\n        }\n        let mut item = {\n            materialize_selected_descriptor(selected, inputs)\n        };")
],
"choose-last-identity": [("fn matching_identity<'a>(\n    identities: &'a [freshell_ws::identity::TerminalIdentity],\n    provider: &str,\n    session_id: &str,\n) -> Option<&'a freshell_ws::identity::TerminalIdentity> {\n    identities.iter().find(|identity| {", "fn matching_identity<'a>(\n    identities: &'a [freshell_ws::identity::TerminalIdentity],\n    provider: &str,\n    session_id: &str,\n) -> Option<&'a freshell_ws::identity::TerminalIdentity> {\n    identities.iter().rev().find(|identity| {")],
"tuple-dedupe": [("fn canonical_identity_key(provider: &str, session_id: &str) -> String {\n    format!(\"{provider}:{session_id}\")\n}", "fn canonical_identity_key(provider: &str, session_id: &str) -> String {\n    serde_json::to_string(&(provider, session_id)).expect(\"tuple serializes\")\n}")],
"omit-identity-revision": [(".chain(identities.iter().map(|identity| identity.updated_at))", ".chain(std::iter::empty::<i64>())")],
"use-deleted-index-head-revision": [("indexed.iter().find(|row| !is_deleted(overrides, &row.key()))", "indexed.iter().next()")],
"invert-subagent-filter": [("if !q.include_subagents && candidate_is_subagent(candidate) {", "if q.include_subagents && candidate_is_subagent(candidate) {")],
"invert-noninteractive-filter": [("if !q.include_non_interactive && candidate_is_non_interactive(candidate) {", "if q.include_non_interactive && candidate_is_non_interactive(candidate) {")],
"invert-empty-filter": [("if !q.include_empty && !candidate_is_nonempty(candidate, overrides, identities) {", "if q.include_empty && !candidate_is_nonempty(candidate, overrides, identities) {")],
"construct-lookahead": [("rows_with_lookahead\n        .into_iter()\n        .take(limit)", "rows_with_lookahead\n        .into_iter()\n        .take(limit + 1)")],
"direct-dir-item-literal": [("CandidateRef::Indexed(indexed) => dir_item_from_indexed(indexed),", "CandidateRef::Indexed(indexed) => DirItem { ..dir_item_from_indexed(indexed) },")],
"clone-per-identity": [("let mut item = materialize_selected_descriptor(selected, inputs);", "let mut item = {\n            let selected_item = materialize_selected_descriptor(selected, inputs);\n            let _clone_countermodel: Vec<DirItem> = inputs\n                .identities\n                .iter()\n                .map(|_| selected_item.clone())\n                .collect();\n            selected_item\n        };")],
"indirect-full-row-constructor": [
    ("fn materialize_selected_descriptor(", "fn uninstrumented_full_row_copy(item: &DirItem) -> DirItem {\n    item.clone()\n}\n\n#[inline]\nfn materialize_selected_descriptor\n("),
    ("let mut item = materialize_selected_descriptor(selected, inputs);", "let mut item = uninstrumented_full_row_copy(&materialize_selected_descriptor(selected, inputs));")
],
"recompute-title-and-skip": [("if let Some(field) = selected.title_match {\n            item = annotate_selected_title_match(item, field);\n        }", "if selected.title_match.is_some() {\n            let Some(filtered) = apply_title_search(item, title_query.expect(\"title query\")) else {\n                continue;\n            };\n            item = filtered;\n        }")],
"route-file-tier-fast": [("(true, Tier::UserMessages | Tier::FullText) => DirectoryStrategy::Materialized,", "(true, Tier::UserMessages | Tier::FullText) => DirectoryStrategy::Fast,")],
}
EXPECTED_MUTATIONS = {
    "reverse-full-key-order", "defer-synth-on-greater", "cursor-inclusive",
    "deletion-after-selection", "choose-last-identity", "tuple-dedupe",
    "omit-identity-revision", "use-deleted-index-head-revision",
    "invert-subagent-filter", "invert-noninteractive-filter",
    "invert-empty-filter", "construct-lookahead", "direct-dir-item-literal",
    "clone-per-identity", "indirect-full-row-constructor",
    "recompute-title-and-skip", "route-file-tier-fast",
}
if set(M) != EXPECTED_MUTATIONS:
    raise SystemExit(f"mutation dictionary mismatch: {set(M) ^ EXPECTED_MUTATIONS}")
for mutation_name, pairs in M.items():
    if not pairs:
        raise SystemExit(f"{mutation_name}: empty mutation")
    for index, (old, new) in enumerate(pairs):
        if not old or not new or old == new or old in new:
            raise SystemExit(f"{mutation_name}[{index}]: old must be nonempty and absent from new")
        for other_index, (other_old, _) in enumerate(pairs):
            if other_index != index and other_old in new:
                raise SystemExit(
                    f"{mutation_name}[{index}]: new embeds old anchor {other_index}"
                )
if name not in M:
    raise SystemExit(f"unknown mutation: {name}")
text = path.read_text(encoding="utf-8")
for old, new in M[name]:
    if text.count(old) != 1 or text.count(new) != 0:
        raise SystemExit(f"{name}: pre-edit old/new counts {text.count(old)}/{text.count(new)}")
    text = text.replace(old, new, 1)
for old, new in M[name]:
    if text.count(old) != 0 or text.count(new) != 1:
        raise SystemExit(f"{name}: post-edit old/new counts {text.count(old)}/{text.count(new)}")
path.write_text(text, encoding="utf-8")
PY
}
```

The dictionary-level audit runs for all 17 IDs before any selected edit and
rejects an empty pair, identity replacement, embedded own old text, or a new
string that embeds another old anchor from the same multi-pair mutation. The
actual source pre/post loops then enforce `old/new == 1/0` before and `0/1`
after every pair. `deletion-after-selection` uses a braced materialization so it
moves deletion after selection without retaining the old statement;
`clone-per-identity` rebinds through `selected_item` and creates one clone per
captured identity while preserving response bytes; and
`indirect-full-row-constructor` inserts a cloning helper and rewrites the target
function declaration across a newline so both edits remove their exact anchors
and compile as Rust. The tuple-dedupe anchor must be scoped to the exact
`canonical_identity_key` region before Task 7 so its old snippet occurs once;
otherwise the mutation is invalid setup. Manual Clone instrumentation makes the
clone countermodel visible; static producer inventory kills the transitive
helper.

`defer-synth-on-greater` is a one-token, compile-valid replacement: the match
patterns remain disjoint and exhaustive, and both result expressions remain
`MergeSide`. The fixed mixed G2 fixture necessarily reaches the changed Greater
arm when indexed timestamp 150 is compared with `synth-mid` timestamp 151.
Correct code emits `synth-mid` at ordinal 26 and ends the page at `idx-104`; the
mutant drains all 49 indexed rows first, moves `synth-mid` to ordinal 50, and
therefore changes exact order and cursor even though ledger counts stay equal.
Equal-side preference is intentionally not a mandatory mutation: synth
suppression means a surviving equal-key synth can tie only deleted indexed rows,
so choosing either side first is output-inert after deletion filtering.
Compilation and the exact killer failure remain mandatory future Task-7 scratch
evidence; this plan edit does not claim either has already run.

### Mutation-to-killer table and run

| Mutation | Exact mandatory killer |
|---|---|
| `reverse-full-key-order` | `g1_duplicate_equal_and_colon_collision_old_materialized_fast` |
| `defer-synth-on-greater` | `g2_no_query_mixed_indexed_and_synth_work_is_exact` |
| `cursor-inclusive` | `g1_arbitrary_and_malformed_cursors_old_materialized_fast` |
| `deletion-after-selection` | `g1_fast_deleted_override_backfills_page_old_materialized_fast` |
| `choose-last-identity` | `g1_ordered_identity_permutations_old_materialized_fast` |
| `tuple-dedupe` | `g1_duplicate_equal_and_colon_collision_old_materialized_fast` |
| `omit-identity-revision` | `g1_i64_revision_boundaries_old_materialized_fast` |
| `use-deleted-index-head-revision` | `g1_i64_revision_boundaries_old_materialized_fast` |
| each `invert-*` | `g1_all_eight_flags_old_materialized_fast` |
| `construct-lookahead` | `g2_no_query_lookahead_descriptor_is_never_constructed` |
| `direct-dir-item-literal` | `g2_candidate_source_has_no_direct_dir_item_literal` |
| `clone-per-identity` | `g2_one_returned_row_with_500_identities_has_zero_full_row_clones` |
| `indirect-full-row-constructor` | `g2_full_row_constructor_inventory_is_exact_and_instrumented` |
| `recompute-title-and-skip` | `g2_title_post_selection_has_no_rejection_path` |
| `route-file-tier-fast` | `dispatch_nonempty_user_messages_and_full_text_are_materialized` |

The `choose-last-identity` killer is the explicit fixed-capture A/B+B/A test. It
must fail because mutated Fast disagrees with FrozenOld/ExtractedMaterialized and
the named expected winner. No owner-backed raw literal or assumed registry order
participates in this kill.

```bash
set -euo pipefail
run_one_mutation() {
  local mutation="$1" killer="$2"
  apply_exact_mutation "$mutation" || { scratch_restore; return 1; }
  scratch_compile_mutation || { scratch_restore; return 1; }
  scratch_require_killed "$killer" || { scratch_restore; return 1; }
  scratch_restore || return 1
}
run_one_mutation reverse-full-key-order "$TEST_MOD::g1_duplicate_equal_and_colon_collision_old_materialized_fast"
run_one_mutation defer-synth-on-greater "$TEST_MOD::g2_no_query_mixed_indexed_and_synth_work_is_exact"
run_one_mutation cursor-inclusive "$TEST_MOD::g1_arbitrary_and_malformed_cursors_old_materialized_fast"
run_one_mutation deletion-after-selection "$TEST_MOD::g1_fast_deleted_override_backfills_page_old_materialized_fast"
run_one_mutation choose-last-identity "$TEST_MOD::g1_ordered_identity_permutations_old_materialized_fast"
run_one_mutation tuple-dedupe "$TEST_MOD::g1_duplicate_equal_and_colon_collision_old_materialized_fast"
run_one_mutation omit-identity-revision "$TEST_MOD::g1_i64_revision_boundaries_old_materialized_fast"
run_one_mutation use-deleted-index-head-revision "$TEST_MOD::g1_i64_revision_boundaries_old_materialized_fast"
run_one_mutation invert-subagent-filter "$TEST_MOD::g1_all_eight_flags_old_materialized_fast"
run_one_mutation invert-noninteractive-filter "$TEST_MOD::g1_all_eight_flags_old_materialized_fast"
run_one_mutation invert-empty-filter "$TEST_MOD::g1_all_eight_flags_old_materialized_fast"
run_one_mutation construct-lookahead "$TEST_MOD::g2_no_query_lookahead_descriptor_is_never_constructed"
run_one_mutation direct-dir-item-literal "$TEST_MOD::g2_candidate_source_has_no_direct_dir_item_literal"
run_one_mutation clone-per-identity "$TEST_MOD::g2_one_returned_row_with_500_identities_has_zero_full_row_clones"
run_one_mutation indirect-full-row-constructor "$TEST_MOD::g2_full_row_constructor_inventory_is_exact_and_instrumented"
run_one_mutation recompute-title-and-skip "$TEST_MOD::g2_title_post_selection_has_no_rejection_path"
run_one_mutation route-file-tier-fast "$TEST_MOD::dispatch_nonempty_user_messages_and_full_text_are_materialized"
```

Run the whole literal sequence serially. Prior kills do not count after any
Task-6 amendment or candidate rebuild. In the future scratch run,
`defer-synth-on-greater` must compile and
`g2_no_query_mixed_indexed_and_synth_work_is_exact` must be the exact single
failing test, with its order/cursor assertion observing the Greater-arm defect.
No such candidate compilation or kill has happened at plan-edit time.

### Surviving mutation and cleanup rules

A test-only amendment must prove only the marked test boundary changed, preserve
Task-6 subject/parent, exact one-file scope, and clean state. Use the complete
helpers below; neither performs destructive recovery on failure:

```bash
set -euo pipefail
assert_task6_amend_is_test_only() {
  local baseline="$1" file=crates/freshell-server/src/session_directory.rs
  python3 - "$WT" "$baseline" "$file" <<'PY'
import pathlib, subprocess, sys
wt, commit, rel = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
before = subprocess.check_output(
    ["git", "-C", str(wt), "show", f"{commit}:{rel}"]
).decode("utf-8")
after = (wt / rel).read_text(encoding="utf-8")
begin = "/* SESSION_DIRECTORY_PAGE_BOUND_TESTS_BEGIN */"
end = "/* SESSION_DIRECTORY_PAGE_BOUND_TESTS_END */"
def outside(text: str) -> tuple[str, str]:
    if text.count(begin) != 1 or text.count(end) != 1:
        raise SystemExit("expected exactly one page-bound test boundary")
    left, rest = text.split(begin, 1)
    _, right = rest.split(end, 1)
    return left, right
if outside(before) != outside(after):
    raise SystemExit("Task-6 amendment changed non-test source")
PY
}

amend_task6_tests_exact_scope() {
  local baseline current_head current_subject old_parent new_head new_parent
  local file=crates/freshell-server/src/session_directory.rs
  local subject='test(session-directory): commit complete compatibility and mutation-killer gates'
  if test "$#" -ne 1; then
    printf 'usage: amend_task6_tests_exact_scope MUTATION_BASE\n' >&2
    return 1
  fi
  baseline="$1"
  current_head="$(git -C "$WT" rev-parse HEAD)" || return 1
  if test "$current_head" != "$baseline"; then
    printf 'Task-6 amend requires HEAD == MUTATION_BASE\n' >&2
    return 1
  fi
  current_subject="$(git -C "$WT" show -s --format=%s HEAD)" || return 1
  if test "$current_subject" != "$subject"; then
    printf 'Task-6 subject is not the required unchanged subject\n' >&2
    return 1
  fi
  old_parent="$(git -C "$WT" rev-parse "${baseline}^")" || return 1
  assert_task6_amend_is_test_only "$baseline" || return 1
  _assert_git_scope preflight "$file" || return 1
  git -C "$WT" add -- "$file" || return 1
  _assert_git_scope cached "$file" || return 1
  git -C "$WT" diff --cached --check || return 1
  git -C "$WT" commit --amend --only --no-edit -- "$file" || return 1
  new_head="$(git -C "$WT" rev-parse HEAD)" || return 1
  if test "$new_head" = "$baseline"; then
    printf 'Task-6 amend did not replace the commit\n' >&2
    return 1
  fi
  new_parent="$(git -C "$WT" rev-parse HEAD^)" || return 1
  if test "$new_parent" != "$old_parent"; then
    printf 'Task-6 amend changed the commit parent\n' >&2
    return 1
  fi
  _assert_git_scope committed "$subject" "$file" || return 1
}
```

If a compiling mutation survives:

1. Stop the table, restore only the scratch file, prove scratch clean, and use
   the non-forced cleanup below.
2. Strengthen tests only inside the marked active Task-6 test boundary.
3. Run `run_g1_aggregate`, `run_legacy_aggregate`, all three exact dispatch
   tests from Task 6, `run_server_all_targets`, `run_sessions_sanity`,
   `run_fmt_check`, `run_clippy`, and `run_both_guards`.
4. Run `amend_task6_tests_exact_scope "$MUTATION_BASE"`; then set and export
   `TASK6_COMMIT="$(git -C "$WT" rev-parse HEAD)"`, set
   `MUTATION_BASE="$TASK6_COMMIT"`, recreate scratch only after proving active
   `HEAD == TASK6_COMMIT`, and rerun the entire mutation sequence from the first
   row. Prior kills do not count.

If investigation finds a production defect, never amend Task 6. Remove scratch
safely, return to Task 4 or 5, add an exact RED regression, repair/refactor/run
that task's GREEN and broader checks, rebuild the owning candidate commit, replay
all later tasks/commits, create a fresh Task-6 hash, and rerun every mutation.

Clean removal is non-forced so races surface:

```bash
set -euo pipefail
test -z "$(git -C "$MUT_WT" status --short)"
git -C "$WT" worktree remove "$MUT_WT"
test ! -e "$MUT_WT"
if git -C "$WT" worktree list --porcelain | grep -Fq "$MUT_WT"; then exit 1; fi
test -z "$(git -C "$WT" status --short)"
run_both_guards
```

Never use reset, clean, forced removal, or restore on active/foreign work.

---

## G3: Explicit Finite Full-App Release A/B Manifest

`adverse_release_ab_non_regression` forces Materialized and Fast through
`completed_strategy_app` with identical immutable captures and full application
layers. Setup is outside timing; debug ledgers are compiled out. Every row
explicitly declares all dimensions. Flag triples are
`(include_subagents, include_non_interactive, include_empty)`.

| Name | N | T | Limit | Query | Cursor | Flags | Auxiliary maps | Colors | Expected |
|---|---:|---:|---:|---|---|---|---|---|---|
| `n0_t0_no_query_l50_none_empty` | 0 | 0 | 50 | none | none | 000 | empty | empty | 200 empty page |
| `n1_t0_no_query_l1_none` | 1 | 0 | 1 | none | none | 000 | empty | empty | 200 one row |
| `n49_t1_no_query_l2_first_cursor` | 49 | 1 | 2 | none | after first survivor | 000 | empty | empty | 200 first-cursor page |
| `n50_t50_no_query_l25_none` | 50 | 50 | 25 | none | none | 111 | empty | empty | 200 full page |
| `n51_t0_no_query_l49_none` | 51 | 0 | 49 | none | none | 000 | empty | empty | 200 + cursor |
| `n51_t0_no_query_l50_none` | 51 | 0 | 50 | none | none | 000 | empty | empty | 200 + cursor |
| `n400_t1_no_query_l1_deep_cursor` | 400 | 1 | 1 | none | hop 200 | 000 | empty | empty | 200 deep page |
| `n28000_t0_no_query_l50_none` | 28,000 | 0 | 50 | none | none | 000 | empty | empty | 200 full page |
| `n28000_t50_mixed_hidden_l25` | 28,000 | 50 | 25 | none | none | 101 | mixed hidden causes | empty | 200 mixed page |
| `n28000_t1_all_hidden_l49` | 28,000 | 1 | 49 | none | none | 000 | all hidden | empty | 200 empty page |
| `n28000_t0_long_deleted_head_l50` | 28,000 | 0 | 50 | none | none | 000 | 20k deleted head | empty | 200 backfilled page |
| `n28000_t0_all_deleted_l2` | 28,000 | 0 | 2 | none | none | 000 | all deleted | empty | 200 empty page |
| `title_early_dense_ascii_l1` | 28,000 | 0 | 1 | `needle` | none | 000 | empty | empty | 200 title page |
| `title_early_dense_ascii_l25_first_cursor` | 28,000 | 1 | 25 | `needle` | after first match | 111 | empty | empty | 200 first-cursor page |
| `title_late_sparse_4000_l2_deep` | 28,000 | 1 | 2 | late ASCII | hop 20 | 000 | 4,000-char fields | empty | 200 sparse page |
| `title_no_match_ascii_l50` | 28,000 | 0 | 50 | absent ASCII | none | 111 | empty | empty | 200 empty page |
| `title_no_match_unicode_expansion_l49` | 28,000 | 0 | 49 | expansion miss | none | 111 | broad Unicode | empty | 200 empty page |
| `title_combining_expansion_t50_l25` | 400 | 50 | 25 | combining/expansion | none | 111 | broad Unicode | empty | 200 title page |
| `t1_all_matched_l50` | 400 | 1 | 50 | none | none | 111 | empty | empty | 200 indexed page |
| `t50_all_matched_l50` | 400 | 50 | 50 | none | none | 111 | empty | empty | 200 indexed page |
| `t51_unsuppressed_synth_l50` | 0 | 51 | 50 | none | none | 111 | empty | empty | 200 + cursor |
| `t500_all_matched_l50` | 500 | 500 | 50 | none | none | 111 | empty | empty | 200 indexed page |
| `t500_unsuppressed_synth_l50` | 0 | 500 | 50 | none | none | 111 | empty | empty | 200 synth page |
| `t500_all_filtered_synth_l50` | 0 | 500 | 50 | none | none | 000 | subagent identities | empty | 200 empty page |
| `duplicate_equal_colon_collision_l2` | 51 | 50 | 2 | none | none | 111 | duplicate/equal/colliding keys | empty | 200 ordered page |
| `identity_winner_fallback_collision_l25` | 49 | 50 | 25 | none | none | 111 | ordered duplicates, missing IDs, `terminal:` collision | empty | 200 ordered page |
| `i64_boundaries_l49` | 51 | 1 | 49 | none | none | 111 | i64 min/max/negative | empty | 200 clamped revision |
| `dense_valid_aux_t50_l50` | 28,000 | 50 | 50 | none | none | 111 | dense valid overrides/metadata | empty | 200 decorated page |
| `malformed_long_aux_t51_l25_colors` | 28,000 | 51 | 25 | none | none | 111 | malformed/wrong-typed/long | ordered 2-entry | 200 colored page |
| `title_colors_order_t1_l2_first_cursor` | 400 | 1 | 2 | `needle` | after first match | 111 | dense valid | ordered 3-entry | 200 colored title page |

The test owns this explicit name table and asserts the generated manifest's
ordered names equal it. The case count is `expected_names.len()`; do not preserve
a stale independent numeric count.

Finite protocol:

```rust
const TARGET_BASELINE_BATCH: Duration = Duration::from_millis(100);
const MAX_CALIBRATION_STEPS: usize = 21;
const MAX_REPEATS: usize = 1_048_576;
const DISCARDED_PAIRED_BATCHES: usize = 10;
const MEASURED_PAIRS: usize = 50;
const NS_PER_US: u128 = 1_000;
const RATIO_SCALE_PPB: u128 = 1_000_000_000;
```

Per case:

1. Run one unmeasured request per strategy; assert the expected non-429
   status/body class and exact A/B response equality.
2. Calibrate Materialized from repeat 1 with at most 21 doublings and maximum
   1,048,576 repeats. Raw elapsed `>= 100 ms` passes the floor. Otherwise fail
   closed and print every attempt.
3. Run ten discarded paired batches and fifty measured pairs at fixed repeats,
   alternating which strategy runs first.
4. Print order, raw elapsed, repeats, normalized integer values, and summaries.
5. Permit at most one **whole-manifest** rerun for a recorded external
   invalidator; preserve the first output. Never selectively rerun a case.

Exact statistics use checked integer arithmetic only:

- `round_div(n,d) = (n + d/2) / d` for positive `d`, ties upward.
- Normalized samples are `u128` nanoseconds; signed difference/overage converts
  checked to `i128`.
- Ratios are checked integer parts-per-billion; baseline zero fails closed.
- For 50 sorted samples, retain `median_twice = x[24] + x[25]`. Signed median
  passes iff `overage[24] + overage[25] <= 0`.
- Nearest-rank p95 is zero-based index 47.
- Per-pair median threshold is
  `max(ceil(105 * baseline / 100), baseline + 5_000ns)`; p95 threshold is
  `max(ceil(110 * baseline / 100), baseline + 10_000ns)`. Equality passes.
- Report strategy median/p95, paired difference median/p95, PPB ratios,
  thresholds, signed overages, and result as batch-normalized synthetic
  observations—not individual request latency or production evidence.

---

## Complete 35-Class Behavior-Equivalence Matrix

Every class from the independent semantic matrix is explicit. “G1” means
FrozenOld/ExtractedMaterialized/Fast; “raw” means completed full-app bytes before
JSON parsing. Targeted unbounded cases supplement, not inflate, the independently
counted exhaustive domain.

| # | Behavior-affecting partition | Mandatory evidence |
|---:|---|---|
| 1 | Empty, singleton, ordinary distinct rows | legacy limits table; G1 all limits; raw NoIndex/empty |
| 2 | Equal timestamp, different full keys | duplicate/equal legacy + G1 ordering |
| 3 | Exact equal `(timestamp, full key)` with different payload/source ordinals | `legacy_duplicate_equal_tuples_preserve_source_order`; G1 duplicate test |
| 4 | Duplicate indexed rows, including page-boundary straddle and later cursor gap | boundary/deep-chain legacy + G1 |
| 5 | `("a","b:c")` vs `("a:b","c")`, arbitrary Unicode/full-string collisions; component-exact running match | colon-composition legacy; G1; key/tuple mutations |
| 6 | Typed deletion at head/middle/tail | legacy deletion tables; dedicated Fast backfill G1; deletion mutation |
| 7 | Deleted indexed row plus same-key live synth replacement | legacy synth replacement; G1 ties |
| 8 | Deleted/synth equal timestamp/key tie and duplicate deleted rows | legacy deleted-ties; G1 response equivalence; equal-side preference is output-inert after synth suppression/deletion |
| 9 | Synth before/between/after indexed stream | live-merge legacy; G1 large live sets; exact mixed G2 interleave/order/cursor; `defer-synth-on-greater` mutation |
| 10 | Multiple exact identities for indexed row; both explicit winner permutations | fixed `CapturedDirectoryInputs` A/B+B/A legacy/G1 value and completed-strategy bytes; same-unchanged-registry relational owner acquisition; `choose-last-identity` mutation |
| 11 | Multiple synth identities with equal/colliding full key/payload; every permutation | identity permutation/collision fixtures and G1 |
| 12 | Missing/empty provider/session, providerless high revision, `terminal:<id>` fallback/collision | explicit legacy/G1 fallback tests; revision G1 |
| 13 | Cursor before first, exactly on rows, between rows, after last | explicit ten-position tables and G1 |
| 14 | Bad base64/JSON, missing/wrong fields, empty key, out-of-i64, extra/duplicate fields | malformed legacy/G1 plus raw 400/no-colors |
| 15 | Deep chains, limit 1, filtered pages, duplicate-tuple gaps | deep legacy/G1 targeted chain |
| 16 | Every limit 1–50 and cardinalities 0/L-1/L/L+1/>L | complete legacy/G1 table; G2 exact lookahead |
| 17 | Every one of eight inclusion-flag combinations and mixed hidden causes | legacy/G1 all-eight tests; three invert mutations |
| 18 | Untitled/whitespace, running rescue, title override rescue/replace/shadow | trap/default/search legacy + G1 |
| 19 | Override nonobject/null/array, wrong types, empty strings, combined fields | malformed legacy/G1 |
| 20 | Metadata nonobject/null/array, absent/wrong/empty/string `sessionType`, key collision | malformed/serialization legacy/G1 |
| 21 | Revision empty/all-deleted/long-prefix/providerless identity/negative/i64 boundaries and decreasing max | revision legacy/G1; two revision mutations; Task-1 decrease test |
| 22 | Query absent/empty/whitespace; title/file tier without nonempty query | legacy/G1 query table and exact dispatch tests |
| 23 | Title field precedence and exact 139/140/141 Unicode-scalar snippets | explicit legacy/G1 boundary tests; carried-field helper |
| 24 | ASCII/non-ASCII branch, lowercase expansion, combining marks, broad Unicode keys/text, 4,000-char fields | Unicode legacy/G1/G2/G3 |
| 25 | Borrowed predicate vs annotation drift | fail-closed helper + mandatory post-selection mutation killer |
| 26 | Long deleted/filtered prefixes; early dense, late sparse, no-match title | G1/G2/G3 targeted cases |
| 27 | T=0/1/50/51/500, matched/duplicate/synth-heavy/all-filtered | legacy/G1; exact G2 equations; G3 |
| 28 | Item/page key presence, insertion order, escaping, bytes | fixed-capture completed strategy bytes (including A/B+B/A); deterministic single-identity/order-insensitive frozen owner raw goldens |
| 29 | Colors absent/nonempty, map insertion order, success/errors, title and both retained tiers | Task-0 `project_color_order_on_{title,user_messages,full_text}_route` raw cases; explicit G1 raw color tests |
| 30 | No-query production dispatch with actual owner acquisition | Task 9 selector RED/GREEN plus revised owner-backed raw matrix and same-registry-list relational assertion |
| 31 | Title production dispatch and annotations | Task 10 selector RED/GREEN plus owner-backed raw matrix |
| 32 | Retained `userMessages`: matches, cursor, budget, I/O, partial fields | Task-0 `user_messages_{success,cursor_page,budget_partial,io_partial}` raw cases and retained-selector test/mutation |
| 33 | Retained `fullText`: assistant match, cursor/partial composition | Task-0 `full_text_{success,cursor_page,budget_partial}` raw cases, fullText color raw case, and retained-selector test/mutation |
| 34 | Invalid priority/limit/tier and cursor status/error mapping | parent raw validation/error cases and final route matrix |
| 35 | Exhaustive small compositions and mutation sensitivity | fixed 37,120/111,360 counts plus all compile-valid scratch mutations |

No full middleware run is required for all 37,120 captures; targeted fixed-capture
and owner-backed matrices provide completed evidence. Exact test names are
attested before every filtered run.

---

## Commit Ledger and Rollback

1. Task 0A — `docs(api): clarify session-directory snapshot consistency`
   (`shared/read-models.ts` comment only).
2. Task 0 — `test(session-directory): freeze parent response authority`
   (`session_directory.rs`, narrow `main.rs`).
3. Task 1 — `refactor(session-directory): extract frozen materialized strategy`.
4. Task 2 — `test(session-directory): characterize reusable legacy equivalence cases`.
5. Task 3 — `feat(session-directory): add borrowed matching decisions`.
6. Task 4 — `perf(session-directory): add page-bounded no-query candidate`.
7. Task 5 — `perf(session-directory): add page-bounded title candidate`.
8. Task 6 — `test(session-directory): commit complete compatibility and mutation-killer gates`.
9. Task 7 — no new commit; only mechanically test-only strengthening may replace
   Task 6. Production defects rebuild Task 4/5 and replay.
10. Task 8 — `test(session-directory): add exact work and finite adverse release gates`.
11. Task 9 — `perf(session-directory): route no-query requests through the fast path`
    (selector/test only).
12. Task 10 — `perf(session-directory): route title search through the fast path`
    (selector/test only).

There are eleven implementation commits because Task 7 is no-commit and Task 0A
is the independently required shared comment task. Materialized code remains
compiled and tested. A regression after release can roll back Task 10 and/or
Task 9 without state migration; do not edit either authority during rollback.
No persisted-state, client-query, cursor, or wire rollback is needed.

---

## Done Criteria

- Task 0A is the exact schema-adjacent comment and the sole shared/client-area
  change; its execution block runs the exact `git -C "$WT"` shared-file
  `diff --check` command and typecheck before commit. It introduces no Node
  behavior or wire-schema change.
- Task 0 pins `fc8646477dd34d92dc5647d158106431aa2e0380`, records exact source and
  committed-fixture blobs through a uniquely owned read-only worktree, and never
  launches the network-capable parent binary. Collision checks precede trap
  installation; the ownership flag is set only after add plus exact
  registration/path/HEAD/clean/gitdir verification, and cleanup rechecks every
  identity before non-forced removal. It then proves the behavior-neutral
  assembler/renderer through deterministic order-insensitive/single-identity
  in-process owner/full-layer raw fixtures plus a same-unchanged-registry
  relational owner-acquisition assertion, records the complete explicit manifest
  while derivation remains inline, and freezes the transitive parent inventory.
- Task 1 first proves Task 0 unchanged and separately freezes only
  Materialized page/dispatch. Every later task runs both authority guards.
- Any behavior-contract rebaseline follows the dedicated reviewed lifecycle,
  updates both authorities and manifest for one deliberate delta, and never
  shares a commit with candidate work.
- Three compatibility scopes, NoIndex distinction, explicit A/B and B/A order in
  fixed captures, same-registry-list relational owner acquisition, owner raw
  literals independent of registry iteration order, success-only colors,
  accessor order, revision semantics, full normalized parity, and completed Rust
  raw proof all hold.
- Borrowed indexed/synth descriptors, stable two-way merge, carried
  `TitleMatchField`, descriptor-only lookahead, and no post-selection rejection
  are implemented. Every nonempty visibility and Title decision receives the
  captured override view; override-rescued and override-hidden boundary rows are
  exact G2/G1 evidence.
- Every successful Fast page satisfies all exact equations inside a synchronous
  non-Send thread-local `DirectoryWorkScope`; reset/read/eight bump helpers are
  named, nested scopes fail closed, Drop clears panic state, and parallel broad
  tests cannot aggregate unrelated requests. Manual Clone is instrumented; Fast
  clone count is zero. All three static tests reuse one lexical/call-graph audit
  with exact producer `{indexed,synth,clone}` and non-producing helper
  `{materialize,annotate}` sets; ordinary references/returns are allowed, while
  every direct, clone, macro/function-pointer, unknown-returning, or recursively
  indirect Fast production path fails closed. The one-row/500-identity clone
  countermodel and unmarked indirect-copy mutation are killed.
- G1 asserts independent `37,120` captures/`111,360` evaluations plus all
  targeted/raw cases. The explicit raw manifest count is derived from its revised
  name slice, contains `single_identity_running_join`, includes userMessages/
  fullText cursor pages, fullText partial, and ordered colors on title plus both
  retained tiers, and contains no requested owner-order permutation. Both fixed
  identity permutations and the relational owner acquisition assertion are
  separately named evidence. All 35 behavior classes above have named evidence.
- The 17-entry mutation dictionary first rejects every embedded/cross-pair old
  anchor, then enforces exact 1/0 → 0/1 source counts. Every mutation is
  compile-valid and behavior-affecting under its named fixture, compiles in the
  future scratch candidate, and then fails its exact Fast/selector killer;
  compile failure is invalid setup. `defer-synth-on-greater` is observed by the
  mixed G2 fixture's forced Greater comparison and exact order/cursor assertions.
  `choose-last-identity` is observed by fixed A/B+B/A captures, never an owner
  iteration-order assumption. Scratch base equals exported `TASK6_COMMIT`,
  including after a test-only amendment. Scratch operations never alter foreign
  work.
- G3 uses the explicit manifest, limits 2/25/49, first-cursor pages, T=1/T=50,
  finite calibration/warmup/measurement, checked integer median/p95 arithmetic,
  and at most one whole-manifest rerun. It remains synthetic/non-production.
- Tasks 9/10 each show exact test-first RED, minimal GREEN, refactor/rerun,
  broader checks, and isolated selector-only commits. Nonempty file tiers remain
  Materialized and rollback-ready.
- Exact/list/prefix/debug/release/scratch wrappers propagate failures and reject
  zero/multiple matches. NUL-safe Git helpers reject foreign staged/unstaged/
  untracked work and never destructively recover it.
- Completion requires actual recorded successful future output from exact tests,
  `run_server_all_targets`, `run_sessions_sanity`, `run_fmt_check`,
  `run_clippy`, `run_shared_typecheck`, authority guards, mutations, and G3.
  This plan does not claim those future results already exist.

---

## Writing-Plans Self-Review Record for This Rendered Plan

This record evaluates the corrected plan text only, not future implementation,
build, test, mutation, selector, or release-gate results.

### 1. Spec coverage: map every requirement to a task and list gaps.

**Result: PASS for corrected plan text.**

| Requirement | Corrected tasks/sections |
|---|---|
| LB-01 three scopes, schema-adjacent shared wording, NoIndex, observable fixed-capture identity order, owner acquisition without requested registry order, success-only colors, completed full-app bytes, accessor semantics | Global Constraints; Task 0A; Tasks 0–2/6; deterministic single-identity owner raw manifest; same-unchanged-registry owner assertion; fixed A/B+B/A completed evidence |
| LB-02 independent pre-extraction provenance, transitive Task-0 freeze, separate Task-1 freeze, same-delta rebaseline | Task 0's ownership-safe pinned source/fixture authority, order-insensitive/single-identity owner/full-layer manifest, and relational same-registry acquisition; Two Authorities; Task 1; Rebaseline lifecycle |
| LB-03 borrowed stable merge, override-effective visibility/title, `TitleMatchField`, descriptor lookahead, no post-selection rejection | Exact candidate signatures/rules; Task 4 override and exact 200..104/151/1 interleave; Task 5 override-only title cases; G1; behavior-affecting merge mutation |
| LB-04 borrowed synths, exact successful-Fast equations, deterministic isolated ledger, unified producer/helper call-graph closure, 500-identity witness | Named-work contract's single lexical audit; complete ledger interfaces; Tasks 0/4/5/8; corrected mutations |
| LB-05 narrowed claim, complete residual work, finite full-app release A/B, mandatory reversible selectors | Honest performance scope; explicit G3; Tasks 8–10 |
| LB-06 all 35 classes, fixed exhaustive counts, targeted/raw/dispatch evidence, compile-valid behavior-affecting exact mutations, exact list attestation | Revised 22-name derived owner raw manifest with `single_identity_running_join`; fixed-capture identity permutations; relational owner acquisition; matrix; inventories; Tasks 2/4/6/7/9/10 |
| Retained Materialized file tiers and rollback | Selector table; exact retained-tier raw rows; Tasks 6/9/10; Commit/Rollback |
| Red-Green-Refactor and concrete test definitions | Every behavior task; Task 4/5 fixture/call/assertion tables; exact helpers/commands/subjects |
| NUL-safe exact scope and no destructive foreign-work handling | Execution harness; parent/scratch ownership checks; mutation/amend protocol |

Fresh-eyes blocker cross-check:

- The behavior-inert equal-side mandatory mutation gap was found and corrected:
  `defer-synth-on-greater` changes only the Greater arm, and the existing mixed G2
  fixture forces that arm and observes exact order/cursor divergence. Equal-side
  preference remains documented only as output-inert after suppression/deletion.
- The nondeterministic ordered-owner raw-fixture gap was found and corrected: the
  raw slice now owns `single_identity_running_join`; exact A/B and B/A order lives
  only in fixed captures/completed-strategy evidence; the concrete two-identity
  owner route is relational to `list()` on the same unchanged registry.
- The mutation dictionary, expected set, killer table, and literal invocations
  cover the same 17 unique IDs. The revised owner raw name slice, builders,
  goldens, and route loop share one source of truth whose derived length is 22.
- `candidate_is_nonempty` and `candidate_is_visible` both receive the captured
  override map, and exact G2 fixtures exercise rescue and hiding.
- Ledger storage, reset, read, eight bumps, success/error wrappers, nesting,
  panic cleanup, and thread isolation are concrete.
- The parent authority uses a unique temp-root worktree. Collision checks precede
  cleanup ownership; removal rechecks path, HEAD, registration, cleanliness, and
  gitdir. Failed, partial, or raced ownership is preserved rather than removed.
- Because the pinned production binary has network-capable components and no
  audited no-network switch, the plan never launches it. Exact Git blobs and
  committed fixture bytes form the safe fallback authority; deterministic owner
  cases read no environment, config, provider root, socket, or external service.
- One lexical/call-graph helper defines the exact three producer and two
  non-producing helper sets for all static G2 tests and rejects every uncounted
  direct, clone, or recursively indirect Fast production path.

Gaps found and corrected in this review: the behavior-inert merge mutation and
nondeterministic ordered-owner raw promises above. Remaining gaps in the two
correction specifications: none at plan-design level. LB-01's Stage-2 acceptable
decision is the completed normative adjudication for the prospective
A-triple-prime contract. No duplicate owner-approval/authorization gate remains,
future executors must not stop to seek one, and Task 0A still must implement the
exact prospective wording and planned static/compile/test evidence; no future implementation result is claimed now.

### 1b. No silent deferrals: no test stand-in replaces required production evidence; no hidden unresolved gap; future implementation/runtime proof remains honestly future.

**Result: PASS for corrected plan text; future gates remain open.**

- No-query and nonempty Title must route Fast before completion; a failed gate
  requires repair/replay, not completion on Materialized.
- Retained nonempty file tiers are the explicit final architecture, and all raw
  cursor/partial/color obligations for those tiers are present now.
- Synthetic captures, stores, `TestClock`, and the thread-local ledger are named
  test doubles. They are paired with exact pinned source/fixture blobs,
  mechanically guarded FrozenOld code, actual in-process owner-backed routes,
  real full-application layers/limiter, raw bytes, and production selector tests.
  The network-capable parent process is rejected rather than treated as isolated.
- Explicit A/B+B/A order cases are fixed test captures, not claims about the
  concrete registry. Actual owner raw authority uses one matching identity; the
  multi-identity owner check is relational to the same unchanged registry's
  `list()`. No future owner API, fake owner, production sort, or retry is deferred.
- The fixed captures do not stand in for owner evidence: the deterministic owner
  raw loop and same-registry relational route remain required. Conversely, the
  relational assertion owns no reviewed raw literal and cannot alter the
  22-name-derived raw sequence.
- Pure helper timing cannot substitute for G3 full-app A/B. A global or
  cross-request counter cannot substitute for the scoped eight-field ledger.
- The impossible equal-side kill was an unresolved proof gap and has been removed
  one-for-one. The replacement's future compile and exact G2 failure remain Task-7
  gates; this review establishes only exact text alignment and an observable
  specified counterexample.
- Exact reviewed `single_identity_running_join` bytes, same-registry relational
  passage, both fixed completed responses, all 17 mutation compiles/kills, and all
  broader tests remain future evidence and are not claimed as passing here.
- No stub, unfinished marker, mock handler, hidden profile, coherent snapshot,
  canonical cross-server raw bytes, or numeric SLA stands in for required behavior.
  Optional production profiling remains genuinely out of scope.
- Unresolved correction-plan-definition coverage gaps: none. LB-01's completed
  Stage-2 normative adjudication leaves no duplicate Task-0A owner-approval or
  authorization gate; future executors must not stop to seek one.

### 2. Placeholder and stale-instruction scan, including behavior-inert mandatory mutations and stale ordered-owner promises.

**Result: PASS for corrected plan text.**

- Task 4 and Task 5 fix every G2 fixture dimension, forced-strategy call,
  independently derived provenance, and assertion family rather than referring
  only to test names. The mixed no-query row fixes all 49 indexed timestamps,
  both synth timestamps, exact merge order, ordinal, lookahead, cursor, revision,
  and ledger observations.
- The behavior-inert equal-side mutation ID, active dictionary entry, killer row,
  and invocation are absent. Equal-side behavior remains only an explicit reason
  not to create a mandatory output mutation. `defer-synth-on-greater` is the sole
  replacement and names its exact observable Greater-arm defect.
- `EXPECTED_PARENT_CASE_NAMES` is the sole owner raw name/count source; it
  contains `single_identity_running_join`, contains neither removed ordered-owner
  case name, and has no independent numeric assertion. The two
  `fixed_capture_identity_first_winner_a_then_b` and
  `fixed_capture_identity_first_winner_b_then_a` belong only to the fixed table.
- `parent_owner_identity_acquisition_matches_same_registry_list_first_winner`
  appears consistently in the Task-0 declaration and focused loop. No instruction
  requests registry insertion order, retries until a desired hash order, or adds
  an owner seam, fake, or production sort.
- The Task-3 drift test is declared once; Task 5 explicitly reuses/reruns it.
- `TASK6_COMMIT` is exported, required by scratch setup, checked against active
  HEAD, and updated with `MUTATION_BASE` after a test-only amendment.
- Task 0A's command block runs the claimed `git -C "$WT" diff --check` before
  typecheck/commit. Reset/read/storage/scope and all eight bump helpers have exact
  signatures and call sites.
- The mutation engine has no embedded-old replacement and validates all IDs
  before touching scratch source. Parent-worktree collision checks precede trap
  installation; cleanup is gated by explicit ownership and exact identity.
- All three producer tests invoke one audit helper and one producer/helper
  taxonomy; the former “reject any returning call” versus “permit transform
  return” contradiction is absent.
- No TBD/TODO/“implement later,” unspecified test, obsolete eager-synth counter,
  slack equation, premature selector switch, helper-only speed promise,
  active-worktree mutation, compile-error-as-kill rule, stale ordered-owner
  promise, contradictory file prohibition, or broad cross-server raw-body
  promise remains.

### 3. Type/name/signature/test-filter/selector-state/command consistency, including exact name/set/table/invocation/count alignment and semantic observability.

**Result: PASS for corrected plan text.**

- `candidate_is_nonempty(candidate, overrides, identities)` and
  `candidate_is_visible(candidate, q, overrides, identities)` match the
  pseudocode, Task-4 call sites, override-effective fixtures, and
  `invert-empty-filter` mutation anchor. `effective_title`/`effective_summary`
  receive the same looked-up override row.
- `DirectoryWorkLedger`, ZERO, thread-local storage, active flag, reset/read,
  eight exact bump helpers, non-Send `DirectoryWorkScope`, success/error wrappers,
  and Task-0/Task-3 call sites use one naming/dataflow scheme. Exact equations
  apply only to `successful_fast_page_with_ledger`.
- The parent raw manifest's generated/builder/golden/executed names compare to the
  revised `EXPECTED_PARENT_CASE_NAMES`. Its derived length is 22, it contains
  `single_identity_running_join`, no removed ordered-owner name or independent
  numeric assertion remains, and the relational owner assertion is outside the
  raw-name sequence/count.
- The fixed-capture table has exactly
  `fixed_capture_identity_first_winner_a_then_b` and
  `fixed_capture_identity_first_winner_b_then_a`, supplies literal A/B and B/A
  vectors, and is reused by the unchanged legacy/G1 top-level tests and completed
  strategy matrix. Task 0 still has nine top-level tests; its exact declaration
  and focused loop both use
  `parent_owner_identity_acquisition_matches_same_registry_list_first_winner`.
- The mutation dictionary, `EXPECTED_MUTATIONS`, killer table, and literal
  `run_one_mutation` sequence have the same 17 unique IDs.
  `defer-synth-on-greater` has exactly the one-line
  `Ordering::Greater => MergeSide::Synth,` →
  `Ordering::Greater => MergeSide::Indexed,` anchor, uses
  `g2_no_query_mixed_indexed_and_synth_work_is_exact`, and obeys the engine's
  exact pre/post 1/0 → 0/1 conditions. The fixed fixture forces Greater at
  indexed 150 versus synth 151 and observes ordinal/order/cursor divergence, not
  merely equal ledger counts.
- `choose-last-identity` retains its source edit, expected-set member, killer
  `g1_ordered_identity_permutations_old_materialized_fast`, and exact invocation;
  its observability comes from fixed A/B+B/A vectors, not owner raw order.
- `deletion-after-selection`, `clone-per-identity`, and
  `indirect-full-row-constructor` remain text-distinct from their old anchors and
  preserve their intended compile-valid defects.
- Prefix inventories remain legacy 33, G1 21, and G2 18; the G3 manifest remains
  30 rows, the behavior-equivalence matrix remains 35 rows, and exhaustive
  constants remain 37,120 captures/111,360 strategy evaluations. Single tests use
  exact fully qualified names; compile RED remains the documented list exception.
- Selector state remains all Materialized through Task 8, no-query Fast after
  Task 9, and no-query plus Title Fast after Task 10; nonempty file tiers remain
  Materialized.
- G3 units, checked rounding, median indices 24/25, p95 index 47, thresholds,
  explicit strata, and rerun policy are unchanged and consistent.
- `FastDirItemProductionAudit` is the sole source of producer/helper sets,
  lexical token rules, recursive edges, and violations for all three G2 source
  tests. Required `DirItem` return declarations are allowed only in the exact
  marked helper set; unmarked indirect copy remains an exact violation/killer.
- Every Git command uses `git -C`; every Cargo command uses an absolute manifest.
  Task 0A's whitespace command, Task 0's pre-trap collision checks/post-add
  ownership flag/exact removal identity, `TASK6_COMMIT`, exact-scope helpers, and
  scratch cleanup are fail closed and non-destructive to foreign work. Task 0's
  fallback executes no Cargo/npm/server/provider/network command and reads only
  seven exact committed blobs.

This Self-Review found and corrected both requested plan gaps. No future build,
test, raw golden, mutation compile/kill, G1, G2, G3, selector, or release result is
claimed; those remain future implementation/runtime evidence.
