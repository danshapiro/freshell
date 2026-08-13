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

**Architecture:** Task 0 establishes this one-way authority chain before any
production edit or structural split:

```text
Pinned parent commit/tree
  + exact append-only cfg(test) recorder
  + exact canonical 22-case manifest
  -> offline, network-namespace, in-process parent completed-response artifact
  -> mechanically embedded byte-identical artifact
  -> direct current-owner/FrozenOld/ExtractedMaterialized/final-route equality gates
```

Source/fixture blob hashes are provenance and reproducibility inputs, not
response bytes or response authority by themselves. Task 0 captures the artifact
from the unchanged pinned parent plus the exact recorder, then performs a
behavior-neutral focused module/test split, moves the recorder byte-for-byte,
mechanically installs the already captured artifact, and freezes the
artifact/recorder/current comparisons in the same Task-0 commit. Task 1 proves
that authority unchanged, extracts the Materialized strategy, and freezes that
second authority separately. Fast selection keeps indexed rows and live
identities as borrowed/lightweight descriptors through dedupe, filtering,
ordering, cursor handling, title matching, and a descriptor-only `limit + 1`;
only returned rows pass through mechanically inventoried and instrumented
full-row constructors. Nonempty `userMessages` and `fullText` queries remain
Materialized. G1 compatibility, compile-valid mutation sensitivity, exact debug
G2 work accounting, and finite instrumentation-free release G3 precede isolated
no-query and title selector commits. Task 0A remains the one additional
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
- The stronger parent operands are direct, never merely transitive:

  ```text
  current owner-backed full-app exchange sequences == embedded pinned-parent artifact
  FrozenOld completed exchange sequences           == embedded pinned-parent artifact
  ExtractedMaterialized exchange sequences          == embedded pinned-parent artifact
  final production route exchange sequences         == embedded pinned-parent artifact
  ```

  Each artifact case owns a nonempty ordered `exchanges` array. Ordinary cases
  contain one exchange; the existing cursor-page cases contain both ordered
  requests/responses and the cursor handoff. Raw bodies are base64-encoded only
  to preserve exact bytes and are decoded before comparison.
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

| File | Exact responsibility / permission |
|---|---|
| `shared/read-models.ts` | Task 0A's exact comment only. |
| `crates/freshell-server/src/main.rs` | Only `with_full_application_layers` and replacement of the inline production layer chain by one call. |
| `crates/freshell-server/src/session_directory.rs` | Stable facade: child declarations/private imports, `SessionDirectoryState`, validation/router/handler, provider-home helpers, and only small shared `#[cfg(test)]` helpers used by more than one existing-test child. Preserve externally consumed `session_directory::*` paths here. |
| `crates/freshell-server/src/session_directory_materialized.rs` | `DirItem`, `Tier`, `DirQuery`, manual Clone/producer markers, indexed construction, override/metadata/running/live decoration, cursor codec, legacy title/file query, and Task-1 Materialized implementation. |
| `crates/freshell-server/src/session_directory_tests.rs` | Existing join tests plus existing core/home/query-validation tests; declared as `mod tests` so the historical `session_directory::tests::invalid_utf8_transcript_is_indexed_lossily_like_node` path remains. |
| `crates/freshell-server/src/session_directory_route_tests.rs` | Existing override/index/metadata/colors/no-index/cache route tests. |
| `crates/freshell-server/src/session_directory_search_tests.rs` | Existing Codex/OpenCode and `userMessages`/`fullText` tests. |
| `crates/freshell-server/src/session_directory_inputs.rs` | `IndexCapture`/owned captures, accessor trace, response renderer, strategy seam/dispatch, and request-local work ledger. |
| `crates/freshell-server/src/session_directory_fast.rs` | Borrowed matching, descriptors, Fast selection/materialization, selector, exact Fast markers, and all 17 mutation anchors. |
| `crates/freshell-server/src/session_directory_page_bound_support.rs` | Shared deterministic capture/case builders and completed-response test harness; test-only. |
| `crates/freshell-server/src/session_directory_page_bound_authority_fixtures.rs` | Byte-stable pinned-parent recorder, canonical 22-case manifest/builders, embedded parent artifact, and FrozenOld authority; test-only and frozen by Task 0. No hand-copied raw-body table. |
| `crates/freshell-server/src/session_directory_page_bound_source_audit.rs` | Fail-closed Rust lexical/call-graph scanner; `cfg(all(test, debug_assertions))`. |
| `crates/freshell-server/src/session_directory_page_bound_authority_tests.rs` | Task-0 and Task-1 authority/capture/completed-response tests. |
| `crates/freshell-server/src/session_directory_page_bound_legacy_tests.rs` | Exact 33-test legacy inventory. |
| `crates/freshell-server/src/session_directory_page_bound_g1_tests.rs` | Exact 21-test G1 inventory, dispatch contract tests, and Task-9/10 selector tests. |
| `crates/freshell-server/src/session_directory_page_bound_g2_tests.rs` | Task-3 helper tests and exact 18-test G2 inventory; `cfg(all(test, debug_assertions))`. |
| `crates/freshell-server/src/session_directory_page_bound_g3_tests.rs` | Explicit release A/B manifest and ignored `adverse_release_ab_non_regression`. |
| `crates/freshell-sessions/src/search.rs` | Read/freeze only; never modify. |

These are ordinary sibling modules under the existing `mod session_directory;`;
no Cargo target or manifest edit is permitted.

The binding <=1,000-physical-UTF-8-line gate introduced by this plan applies
only to the session-directory facade
`crates/freshell-server/src/session_directory.rs` and the fourteen
responsibility-named `crates/freshell-server/src/session_directory_*.rs`
siblings listed above, after each file exists. The phased `SD_TASK*_FILES`
arrays are the complete mechanical enforcement set.

This task does not apply that new gate to the pre-existing
`crates/freshell-server/src/main.rs` or to the read-only external
`crates/freshell-sessions/src/search.rs`. Their existing sizes are unrelated to
Fresh Eyes blocker 5. Task 0 may still make only the already-authorized narrow
assembler/call edit in `main.rs`; it must not refactor that file for size.

If any facade/focused-sibling target in the applicable phase exceeds 1,000
lines, stop and amend the plan with one additional responsibility-named split;
never create a numbered spill file or waive the limit.

Task 0's uniquely owned detached pinned-parent worktree and Task 7's detached
mutation worktree are validation scratch only. The pinned parent's historical
monolith is named `PARENT_SESSION_MONOLITH` in preflight/provenance; future
siblings do not exist at the parent and are never added to its seven-blob list.
Task 0 never launches the production server binary, binds a listener, scans an
ambient provider root, reads live home/config, or has network access. Its one
exact ignored test harness executes `Router::oneshot` inside a new network
namespace to capture the immutable parent response artifact. Both scratch
families are removed non-forcibly only after their exact ownership and state are
revalidated. Do not change any `Cargo.toml`, dependency, feature, owner/index/TTL
or sweep API, polling, persistence, cursor/wire schema, Node implementation,
client logic, fixture/script/benchmark file, `.kata.toml`, or another document.
Do not create a PR or restart the live port-3001 server. Both final selector
commits are required and reversible; an undispatched candidate is incomplete.

Red-Green-Refactor applies to behavior tasks. Evidence/comment-only tasks do
not manufacture a false RED. A test-only gate that finds a production defect
returns to its owning behavior task and commit boundary.

---

## Current Pipeline and Structural Correctness Argument

Current source at parent `fc8646477dd34d92dc5647d158106431aa2e0380`
is the historical monolith. After Task 0's behavior-neutral split, cite the
pipeline by stable symbol/path:

1. facade validation/owner route:
   `session_directory.rs::{validate_query,router,session_directory}`;
2. materialized model/decorations:
   `session_directory_materialized.rs::{dir_item_from_indexed,apply_session_overrides,apply_session_metadata,join_running_state,build_live_terminal_session_item,join_live_terminals}`;
3. materialized ordering/search:
   `session_directory_materialized.rs::{apply_query,apply_title_search,apply_file_search}`;
4. external transcript search remains
   `crates/freshell-sessions/src/search.rs`.

The Fast architecture is valid only under one immutable capture whose index is
sorted by `(last_activity_at DESC, exact full key DESC)` and whose validated
limit is `1..=50`:

- Decoration cannot change existing-row sort keys. Stable filtering preserves
  exact duplicate source ordinals.
- Synth descriptors contain every membership/order datum, preserve identity
  vector first-winner order, suppress against every nondeleted indexed full key,
  stable-sort, and choose indexed on exact merge equality. Typed deletion is
  Indexed-only: a same-key live Synth is created after legacy indexed deletion,
  survives that deletion override, and receives no override decoration.
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

1. **Task-0 parent authority:** the canonical completed-response artifact
   captured from the pre-edit pinned commit/tree using the exact append-only
   recorder and canonical manifest. It records the seven critical blob IDs,
   recorder/manifest/input hashes, and exact ordered raw exchanges. Source and
   fixture hashes are provenance, not response authority. Task 0 also freezes
   the recorder, manifest/builders, actual owner executor, capture types,
   FrozenOld page, renderer, transitive legacy regions, whole external search,
   and full-layer assembler/production call.
2. **Task-1 extracted authority:** only `materialized_page` and
   `materialized_dispatch`, committed after ExtractedMaterialized compares
   directly with the embedded parent artifact.
3. **Exhaustive finite evidence:** FrozenOld/ExtractedMaterialized/Fast values
   and direct renderer bytes; no full middleware per exhaustive capture.
4. **Targeted completed evidence:** explicit fixed-capture strategy applications,
   including both A/B winner permutations, plus all 22 current owner exchanges
   through real full-application layers compared directly with the artifact.
   Requested owner iteration order is not part of the raw authority.
5. **G2:** exact successful-Fast work equations plus clone/constructor audits.
6. **Mutation evidence:** exact compile-valid source edits whose declared
   Fast/selector killer fails.
7. **Declared Node/Rust parity:** unchanged full normalized comparator; never a
   substitute for direct current-owner/FrozenOld/ExtractedMaterialized/final-route
   equality with the parent artifact.

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

Task 8 implements the following G3 support contract in
`session_directory_page_bound_support.rs`. Every item is `pub(super)` because
`page_bound_g3_tests` is a sibling module:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct G3Flags {
    pub(super) include_subagents: bool,
    pub(super) include_non_interactive: bool,
    pub(super) include_empty: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum G3QuerySpec {
    None,
    Title(&'static str),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum G3CursorSpec {
    None,
    IndexedOrdinal(usize),
    TitleMatchOrdinal(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum G3FixtureShape {
    Base,
    MixedHidden,
    AllHidden,
    DeletedHead(usize),
    AllDeleted,
    TitleDenseAscii,
    TitleDenseAsciiWithDenseValidAux,
    TitleLateSparse4000,
    TitleUnicodeMiss4000,
    TitleUnicodeCombiningHit,
    DuplicateEqualColonCollision,
    IdentityWinnerFallbackCollision,
    I64Boundaries,
    DenseValidAux,
    MalformedLongAux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum G3IdentityShape {
    Matched,
    UnsuppressedSynth,
    MatchedPlusOneSynth,
    AllFilteredSynth,
    FixtureDefined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum G3ColorShape {
    Empty,
    OrderedTwo,
    OrderedThree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct G3ExpectedPage {
    pub(super) item_count: usize,
    pub(super) has_next_cursor: bool,
    pub(super) title_annotations: bool,
    pub(super) color_count: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct G3CaseSpec {
    pub(super) name: &'static str,
    pub(super) indexed_rows: usize,
    pub(super) identities: usize,
    pub(super) limit: usize,
    pub(super) query: G3QuerySpec,
    pub(super) cursor: G3CursorSpec,
    pub(super) flags: G3Flags,
    pub(super) fixture: G3FixtureShape,
    pub(super) identity_shape: G3IdentityShape,
    pub(super) colors: G3ColorShape,
    pub(super) expected: G3ExpectedPage,
}

pub(super) struct G3ReleaseCase {
    pub(super) name: &'static str,
    pub(super) inputs: Arc<OwnedDirectoryInputs>,
    pub(super) query: Arc<DirQuery>,
    pub(super) project_colors: Arc<Map<String, Value>>,
    pub(super) expected_colors: &'static [(&'static str, &'static str)],
    pub(super) expected_revision: Option<i64>,
    pub(super) expected: G3ExpectedPage,
}

pub(super) fn build_g3_release_case(spec: G3CaseSpec) -> G3ReleaseCase;
pub(super) fn g3_release_cases() -> Vec<G3ReleaseCase>;
```

`g3_release_cases()` is an explicit 30-call vector in the same order as the
independent `EXPECTED_G3_CASE_NAMES` operand below. It never generates names
from dimensions, filters a larger table, derives the expected-name list from
itself, or hides a dimension behind `Default`.

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
fn candidate_is_deleted(
    candidate: CandidateRef<'_, '_>,
    overrides: &Map<String, Value>,
) -> bool;
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
  `let identities = inputs.identities;`, call
  `candidate_is_deleted(candidate, overrides)` first, then call
  `candidate_is_visible(candidate, q, overrides, identities)`. For Indexed,
  deletion consults `is_deleted(overrides, &indexed.key())`; for Synth it is
  always false because legacy deletion precedes live synthesis. A same-key Synth
  therefore survives and is never override-decorated. For Indexed,
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

## Focused Rust Module Boundary

Use direct `#[path]` children, never `include!`. Add each declaration only in the
task that creates the corresponding nonempty file. The final facade declarations
are:

```rust
#[path = "session_directory_materialized.rs"]
mod materialized;
#[path = "session_directory_inputs.rs"]
mod inputs;
#[path = "session_directory_fast.rs"]
mod fast;

#[cfg(test)]
#[path = "session_directory_tests.rs"]
mod tests;
#[cfg(test)]
#[path = "session_directory_route_tests.rs"]
mod route_tests;
#[cfg(test)]
#[path = "session_directory_search_tests.rs"]
mod search_tests;
#[cfg(test)]
#[path = "session_directory_page_bound_support.rs"]
mod page_bound_support;
#[cfg(test)]
#[path = "session_directory_page_bound_authority_fixtures.rs"]
mod page_bound_authority_fixtures;
#[cfg(test)]
#[path = "session_directory_page_bound_authority_tests.rs"]
mod page_bound_authority_tests;
#[cfg(test)]
#[path = "session_directory_page_bound_legacy_tests.rs"]
mod page_bound_legacy_tests;
#[cfg(test)]
#[path = "session_directory_page_bound_g1_tests.rs"]
mod page_bound_g1_tests;
#[cfg(all(test, debug_assertions))]
#[path = "session_directory_page_bound_source_audit.rs"]
mod page_bound_source_audit;
#[cfg(all(test, debug_assertions))]
#[path = "session_directory_page_bound_g2_tests.rs"]
mod page_bound_g2_tests;
#[cfg(test)]
#[path = "session_directory_page_bound_g3_tests.rs"]
mod page_bound_g3_tests;
```

Keep `SessionDirectoryState`, `router`, `provider_home`, `claude_home`,
`codex_home`, and `HOME_ENV_TEST_LOCK` physically in the facade. Moved internals
needed by sibling children use `pub(super)`, not public API; privately import
them into the facade where needed so existing crate-visible
`session_directory::*` paths remain stable. Put a test helper in the facade only
when at least two test children need it.

Task 0 performs the split after parent capture and before authority tests:

1. Move the model/materialized pipeline to
   `session_directory_materialized.rs`.
2. Move current `join_tests` and main tests through query validation (ending
   immediately before `// Task 2: sessionOverrides overlay`) to
   `session_directory_tests.rs`.
3. Move tests from that Task-2 anchor through the test immediately before
   `codex_exec_session_hidden_by_default_surfaced_with_flag` to
   `session_directory_route_tests.rs`.
4. Move that Codex test through the end of the current main test module to
   `session_directory_search_tests.rs`.
5. Create nonempty `inputs`, page-bound support, authority-fixtures, and
   authority-tests siblings. Move the recorder byte-for-byte into
   authority-fixtures.
6. Normalize only imports and `pub(super)` visibility. Run existing server tests,
   formatter, Clippy, and the line gate. This behavior-neutral refactor has the
   pre-split baseline as its before evidence and no manufactured RED.
7. Only after this GREEN add/freeze Task-0 markers and behavior tests.

Whole-file test children plus explicit declarations replace the former
monolithic page-bound test wrapper.

---

## Two Immutable Authorities and Rebaseline Rule

### Canonical pinned-parent completed-response authority

`PARENT_COMPLETED_RESPONSE_AUTHORITY_V1` is canonical sorted-key,
compact-separator UTF-8 JSON with exactly one trailing LF:

```text
schema:        freshell.session-directory.parent-responses.v1
parent_commit: fc8646477dd34d92dc5647d158106431aa2e0380
parent_tree:   b4ff70f7ff0d3aab312b61bad0a3a074d1bebf58
critical blobs:
  crates/freshell-server/src/session_directory.rs             843f98c896d30650c2fc8c3ccb77f4635272d984
  crates/freshell-server/src/main.rs                          346e7d96432f61c6699461d2c58f97406ae36bbe
  crates/freshell-sessions/src/search.rs                      8da06ea083e1ae651c61fea186f67dcef906d5a8
  crates/freshell-sessions/src/parse/opencode.rs              684003ab22ba10d6154e5fd11c95b5a885bfd1ce
  crates/freshell-sessions/src/amplifier.rs                   313ecf588daef15530e2048d66c5dbce1cf627ef
  test/fixtures/sessions/real-corrupted.jsonl                 c3ae6eb134e66303f2cf901bdbc895fc85d71b52
  test/fixtures/sessions/healthy.jsonl                        1e67a84c5acdf949c8953481280362a96bfbc453
```

Its logical schema is:

```text
{
  schema, parent_commit, parent_tree, source_blobs,
  recorder_sha256, manifest_sha256,
  cases: [{
    name, strategy_comparable, owner_input_sha256,
    exchanges: [{
      request: { method, uri, ordered_headers },
      status, content_type, body_base64
    }]
  }]
}
```

Case order is exactly `EXPECTED_PARENT_CASE_NAMES`; names are unique; total is
22. `strategy_comparable` is false only for
`invalid_priority_limit_and_tier`, so the comparable projection is exactly 21.
`owner_input_sha256` covers tagged `NoIndex` versus `Snapshot([])`, ordered
request/exchange sequence, indexed rows/source bytes, ordered
override/metadata/identity/color inputs, and all other owner state, and is unique
across the 22 cases. Bodies are captured as raw bytes before base64 encoding.
There is one artifact and no second manually maintained raw-body table.

### Task-0 frozen inventory

Use unique `/* SESSION_DIRECTORY_AUTHORITY_BEGIN:<name> */` / `END` markers
mapped after the split as follows:

- facade: `legacy-max-directory-page-items`,
  `legacy-session-directory-state-type`, `legacy-query-validation`, and
  `legacy-session-directory-router`;
- materialized: `legacy-dir-item-type-and-impl`,
  `legacy-tier-and-dir-query-types`, `legacy-indexed-constructor`,
  `legacy-overrides`, `legacy-metadata`, `legacy-provider-display`,
  `legacy-running-join`, `legacy-synth-constructor`, `legacy-live-join`,
  `legacy-cursor-codec`, `legacy-apply-query`,
  `legacy-file-search-outcome-type`, `legacy-file-search`, and
  `legacy-title-search`;
- inputs: `parent-authority-capture-types`,
  `parent-authority-response-renderer`, `parent-authority-accessor-trace`, and
  `parent-authority-work-ledger`;
- authority-fixtures: `parent-authority-pinned-recorder`,
  `parent-authority-case-manifest-builders`,
  `parent-authority-owner-route-executor`,
  `parent-authority-response-fixtures`, and
  `parent-authority-frozen-old-page`;
- main: `full-application-layer-assembler` and
  `full-application-layer-production-call`.

All legacy bumps remain within their frozen functions. Freeze the whole UTF-8
`crates/freshell-sessions/src/search.rs`. The pinned-parent monolith remains a
provenance blob only; freeze current sibling paths only after the split.

Task 0 wraps the complete accessor-trace type/state/reset/read/bump
implementation in exactly one region:

```rust
/* SESSION_DIRECTORY_AUTHORITY_BEGIN:parent-authority-accessor-trace */
/* complete accessor-trace implementation */
/* SESSION_DIRECTORY_AUTHORITY_END:parent-authority-accessor-trace */
```

The immutable Task-0 owner-backed/full-application case manifest is this exact
ordered list:

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

Each row records canonical owner input and one or more ordered exchanges.
Ordinary rows have one exchange; `user_messages_cursor_page` and
`full_text_cursor_page` have two. Any row whose winner is serialized contains
exactly one matching identity. Generated, embedded, and expected names compare
to the explicit slice; its derived length is 22 with no independent drifting
count.

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

### Parent-compatible recorder and embedded artifact

The Task-0 authority-fixtures file contains this byte-stable region:

```rust
/* SESSION_DIRECTORY_AUTHORITY_BEGIN:parent-authority-pinned-recorder */
/* SESSION_DIRECTORY_PINNED_PARENT_RECORDER_BEGIN */
#[cfg(test)]
mod pinned_parent_recorder {
    // Exact 22-case specs/builders, owned-temp-root owner executor, canonical
    // artifact records, and copied pinned-main full-layer assembler.
    pub(in crate::session_directory) async fn write_pinned_parent_completed_responses_from_env(
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>>;
}
/* SESSION_DIRECTORY_PINNED_PARENT_RECORDER_END */
/* SESSION_DIRECTORY_AUTHORITY_END:parent-authority-pinned-recorder */
```

The recorder is location-independent (`crate::session_directory::...`) and uses
only narrow `pub(in crate::session_directory)` visibility where sibling tests
must consume it. It has no dependency on `CapturedDirectoryInputs`, FrozenOld,
`directory_result_response`, or `with_full_application_layers`. It defines the
22-name sequence/digests, drives the real route through `Router::oneshot` under
owned roots, accepts an assembler callback, collects status/content-type/body
before parsing, and rejects ambient homes/config/provider paths, sockets,
non-owned files, duplicate/missing names, and raw winner cases with multiple
matching identities.

The exact inner marker region plus one LF is hashed as `recorder_sha256`. Before
capture it is the only active-source delta and is appended byte-for-byte to
`PARENT_SESSION_MONOLITH`; during the split the same bytes move to the final
sibling. A static verifier removes exactly this region and requires the remainder
to equal the pinned monolith, requires active `main.rs`, `search.rs`, and both
transcript fixtures to equal parent blobs, and normalizes/compares the recorder's
three `.layer(...)` calls with pinned `main.rs`.

The same fixture region embeds:

```rust
/* SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_BEGIN */
#[cfg(test)]
const PINNED_PARENT_COMPLETED_RESPONSE_AUTHORITY_B64: &str =
    "__SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_B64_PLACEHOLDER__";
#[cfg(test)]
const PINNED_PARENT_COMPLETED_RESPONSE_AUTHORITY_SHA256: &str =
    "__SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_SHA256_PLACEHOLDER__";
/* SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_END */
```

The installer validates canonical bytes and every fixed field, replaces one
explicit placeholder exactly once, wraps base64 at one fixed width, decodes the
new embedded constant to a second file, and `cmp`s it byte-for-byte with the
captured artifact. Review output never feeds expected bytes.

### Static and runtime authority guards

`run_task0_static_guard` combines the shared comment guard, path-aware Task-0
marker guard, and static embedded-artifact verifier.
`run_both_static_guards` does the same for both Task-0 and Task-1 markers.
`run_parent_authority_equality` runs the exact authority manifest, all-current-
owner, and FrozenOld direct artifact comparisons. `run_task0_guard` is static
plus parent equality. `run_both_guards` adds the direct
ExtractedMaterialized-artifact comparison. Every later guard call therefore
checks real parent equality, not only marker bytes. Task 10 additionally calls
`replay_pinned_parent_authority`.

### Rebaseline lifecycle (exceptional, fail closed)

Ordinary execution never edits either authority. Manifest expansion with
unchanged behavior replays the recorder against the previously approved
immutable baseline before production edits. A deliberate behavior change
requires a dedicated authority/test-only commit with the independently authored
and approved artifact diff, old/new hashes, delta ID, and review evidence before
production changes. Later FrozenOld/Materialized/Fast changes make the already
failing authority tests green. Changed owner, Materialized, or Fast code may
never emit its own expectation, and authority/candidate/selector changes never
share a commit.

---

## Fail-Closed Execution Harness

Run this harness in the task execution shell before Task 0A. If the shell is
replaced, rerun the complete harness. Shell replacement discards every
task-local value and every scratch ownership token. Task 7 may re-enter only at
a clean commit boundary by calling `load_validated_task6_mutation_base`; that
helper rehydrates only the Task-6 commit/base from the durable Git ledger. If
replacement occurs after any scratch creation and before its successful
ownership-aware clean removal, stop and preserve the scratch; never reconstruct
its ownership, restore it, remove it, reuse it, or create another scratch. The
harness is intentionally not persisted as a repository file. Every copied
multi-command block starts with `set -euo pipefail`.

### Exact test and broader-check helpers

```bash
set -euo pipefail
WT=/home/dan/code/freshell/.worktrees/session-directory-page-bound
MANIFEST="$WT/Cargo.toml"
TEST_AUTH='session_directory::page_bound_authority_tests'
TEST_LEGACY='session_directory::page_bound_legacy_tests'
TEST_G1='session_directory::page_bound_g1_tests'
TEST_G2='session_directory::page_bound_g2_tests'
TEST_G3='session_directory::page_bound_g3_tests'

cargo_server_test() {
  local mode="$1"
  shift
  local -a cargo_args=(
    --manifest-path "$MANIFEST"
    -p freshell-server
    --bin freshell-server
  )
  case "$mode" in
    debug) ;;
    release) cargo_args+=(--release) ;;
    *) printf 'invalid test mode: %s\n' "$mode" >&2; return 1 ;;
  esac
  CARGO_TERM_COLOR=never cargo test "${cargo_args[@]}" "$@"
}

list_selected_tests() {
  local mode="$1" selection="$2" match="$3" filter="$4" output line
  local -a harness_args=(--list --color=never)
  case "$selection" in
    all) harness_args+=(--include-ignored) ;;
    ignored) harness_args+=(--ignored) ;;
    *) printf 'invalid list selection: %s\n' "$selection" >&2; return 1 ;;
  esac
  case "$match" in
    exact) harness_args+=(--exact) ;;
    prefix) ;;
    *) printf 'invalid test match: %s\n' "$match" >&2; return 1 ;;
  esac
  output="$(cargo_server_test "$mode" "$filter" -- "${harness_args[@]}")" || return 1
  while IFS= read -r line; do
    case "$line" in *': test') printf '%s\n' "${line%: test}" || return 1 ;; esac
  done <<<"$output"
}

assert_one_selected_named_test() {
  local mode="$1" selection="$2" name="$3" all_names ignored_names
  all_names="$(list_selected_tests "$mode" all exact "$name")" || return 1
  ignored_names="$(list_selected_tests "$mode" ignored exact "$name")" || return 1
  python3 - "$mode" "$selection" "$name" "$all_names" "$ignored_names" <<'PY'
import sys
mode, selection, name, all_text, ignored_text = sys.argv[1:]
all_names = [line for line in all_text.splitlines() if line]
ignored_names = [line for line in ignored_text.splitlines() if line]
if all_names != [name]:
    raise SystemExit(
        f"expected exactly one {mode} declaration {name!r}; found {all_names!r}"
    )
expected_ignored = (
    [] if selection == "normal"
    else [name] if selection == "ignored"
    else None
)
if expected_ignored is None or ignored_names != expected_ignored:
    raise SystemExit(
        f"expected {name!r} to be {selection} in {mode}; "
        f"ignored selection found {ignored_names!r}"
    )
PY
}

assert_one_named_test() { assert_one_selected_named_test "$1" normal "$2"; }
assert_one_ignored_named_test() {
  assert_one_selected_named_test "$1" ignored "$2"
}

run_cargo_test_success() {
  local expected_count="$1" log
  shift
  log="$(mktemp)" || return 1
  if ! "$@" >"$log" 2>&1; then
    cat "$log" >&2 || true
    rm -f "$log"
    return 1
  fi
  if ! python3 - "$log" "$expected_count" <<'PY'
import pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
expected = int(sys.argv[2])
if expected <= 0:
    raise SystemExit(f"expected execution count must be positive; got {expected}")
pattern = re.compile(
    r"^test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored; "
    r"(\d+) measured; (\d+) filtered out; finished in [^\r\n]+$",
    re.MULTILINE,
)
summaries = [tuple(map(int, match)) for match in pattern.findall(text)]
if len(summaries) != 1:
    raise SystemExit(
        f"expected exactly one libtest success summary; found {summaries!r}"
    )
passed, failed, ignored, measured, _filtered = summaries[0]
if (passed, failed, ignored, measured) != (expected, 0, 0, 0):
    raise SystemExit(
        "unexpected execution cardinality: "
        f"passed={passed} failed={failed} ignored={ignored} measured={measured}; "
        f"expected passed={expected} and all other counts zero"
    )
PY
  then
    cat "$log" >&2 || true
    rm -f "$log"
    return 1
  fi
  cat "$log" || { rm -f "$log"; return 1; }
  rm -f "$log"
}

run_exact_debug() {
  local name="$1"
  assert_one_named_test debug "$name" || return 1
  run_cargo_test_success 1 cargo_server_test debug \
    "$name" -- --exact --color=never --test-threads=1
}

run_exact_debug_ignored() {
  local name="$1"
  assert_one_ignored_named_test debug "$name" || return 1
  run_cargo_test_success 1 cargo_server_test debug \
    "$name" -- --exact --ignored --nocapture --color=never --test-threads=1
}

run_exact_release_ignored() {
  local name="$1"
  assert_one_ignored_named_test release "$name" || return 1
  run_cargo_test_success 1 cargo_server_test release \
    "$name" -- --exact --ignored --nocapture --color=never --test-threads=1
}

verify_g3_release_output() {
  local log="$1"
  python3 - "$log" <<'PY'
from collections import Counter
import pathlib, re, sys

text = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
warmups = re.findall(
    r"^G3_WARMUP name=(\S+) equality=PASS status=200 body=page$",
    text,
    re.MULTILINE,
)
calibrations = re.findall(
    r"^G3_CALIBRATION name=(\S+) step=(\d+) repeats=(\d+) raw_ns=(\d+)$",
    text,
    re.MULTILINE,
)
pairs = re.findall(
    r"^G3_PAIR name=(\S+) phase=(discard|measure) pair=(\d+) "
    r"first=(materialized|fast) repeats=(\d+) "
    r"materialized_raw_ns=(\d+) fast_raw_ns=(\d+) "
    r"materialized_normalized_ns=(\d+) fast_normalized_ns=(\d+)$",
    text,
    re.MULTILINE,
)
summaries = re.findall(
    r"^G3_CASE_RESULT name=(\S+) repeats=(\d+) measured_pairs=50 "
    r"materialized_median_twice_ns=(\d+) materialized_p95_ns=(\d+) "
    r"fast_median_twice_ns=(\d+) fast_p95_ns=(\d+) "
    r"difference_median_twice_ns=(-?\d+) difference_p95_ns=(-?\d+) "
    r"ratio_median_twice_ppb=(\d+) ratio_p95_ppb=(\d+) "
    r"median_threshold_median_twice_ns=(\d+) p95_threshold_p95_ns=(\d+) "
    r"median_overage_twice_ns=(-?\d+) p95_overage_ns=(-?\d+) result=PASS$",
    text,
    re.MULTILINE,
)
finals = re.findall(
    r"^G3_MANIFEST_RESULT cases=30 measured_pairs_per_case=50 result=PASS$",
    text,
    re.MULTILINE,
)

names = [row[0] for row in summaries]
if len(names) != 30 or len(set(names)) != 30:
    raise SystemExit(f"expected 30 unique G3 case summaries, got {names!r}")
if warmups != names:
    raise SystemExit(f"warmup sequence differs from case summaries: {warmups!r} != {names!r}")
summary_repeats = {row[0]: int(row[1]) for row in summaries}

calibration_names = {name for name, *_ in calibrations}
if calibration_names != set(names):
    raise SystemExit(f"calibration names differ: {calibration_names!r}")
for name in names:
    rows = [row for row in calibrations if row[0] == name]
    if not 1 <= len(rows) <= 21:
        raise SystemExit(f"{name}: expected 1..=21 calibration attempts, got {len(rows)}")
    for expected_step, (_name, step, repeats, raw_ns) in enumerate(rows):
        if int(step) != expected_step or int(repeats) != 1 << expected_step:
            raise SystemExit(f"{name}: non-doubling calibration row {rows!r}")
        if int(repeats) > 1_048_576 or int(raw_ns) <= 0:
            raise SystemExit(f"{name}: invalid calibration bound/value {rows!r}")
        if expected_step + 1 < len(rows) and int(raw_ns) >= 100_000_000:
            raise SystemExit(f"{name}: calibration continued after reaching 100ms")
    if int(rows[-1][3]) < 100_000_000:
        raise SystemExit(f"{name}: calibration never reached 100ms")
    if summary_repeats[name] != int(rows[-1][2]):
        raise SystemExit(f"{name}: summary repeats differ from calibration")

if {name for name, *_ in pairs} != set(names) or len(pairs) != 30 * 60:
    raise SystemExit("pair names/count differ from the 30x60 protocol")
phase_counts = Counter((name, phase) for name, phase, *_ in pairs)
for name in names:
    rows = [row for row in pairs if row[0] == name]
    if phase_counts[(name, "discard")] != 10 or phase_counts[(name, "measure")] != 50:
        raise SystemExit(f"{name}: expected 10 discarded and 50 measured pairs")
    if len(rows) != 60:
        raise SystemExit(f"{name}: expected exactly 60 pair rows")
    for expected_pair, row in enumerate(rows):
        (_name, phase, pair, first, repeats, materialized_raw, fast_raw,
         materialized_normalized, fast_normalized) = row
        expected_phase = "discard" if expected_pair < 10 else "measure"
        expected_first = "materialized" if expected_pair % 2 == 0 else "fast"
        if int(pair) != expected_pair or phase != expected_phase or first != expected_first:
            raise SystemExit(f"{name}: bad pair order/phase/strategy at {row!r}")
        repeats = int(repeats)
        if repeats != summary_repeats[name]:
            raise SystemExit(f"{name}: pair repeats differ from calibration")
        for raw, normalized in (
            (int(materialized_raw), int(materialized_normalized)),
            (int(fast_raw), int(fast_normalized)),
        ):
            if raw <= 0 or normalized != (raw + repeats // 2) // repeats:
                raise SystemExit(f"{name}: invalid checked normalization in {row!r}")

if finals != ["G3_MANIFEST_RESULT cases=30 measured_pairs_per_case=50 result=PASS"]:
    raise SystemExit(f"missing/duplicate G3 manifest result: {finals!r}")
PY
}

run_g3_release_gate() {
  local log
  log="$(mktemp)" || return 1
  if ! run_exact_release_ignored \
      "$TEST_G3::adverse_release_ab_non_regression" >"$log" 2>&1; then
    cat "$log" >&2 || true
    rm -f "$log"
    return 1
  fi
  if ! verify_g3_release_output "$log"; then
    cat "$log" >&2 || true
    rm -f "$log"
    return 1
  fi
  cat "$log" || { rm -f "$log"; return 1; }
  rm -f "$log"
}

expect_debug_compile_failure() {
  local label="$1" diagnostic="$2" log
  log="$(mktemp)" || return 1
  if cargo test --manifest-path "$MANIFEST" -p freshell-server \
      --bin freshell-server --no-run >"$log" 2>&1; then
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
  if cargo_server_test debug "$name" -- \
      --exact --color=never --test-threads=1 >"$log" 2>&1; then
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
  local prefix="$1" expected_count="$2" tmp all_names ignored_names
  tmp="$(mktemp -d)" || return 1
  cat >"$tmp/expected" || { rm -rf "$tmp"; return 1; }
  all_names="$(list_selected_tests debug all prefix "$prefix")" || {
    rm -rf "$tmp"; return 1;
  }
  ignored_names="$(list_selected_tests debug ignored prefix "$prefix")" || {
    rm -rf "$tmp"; return 1;
  }
  printf '%s\n' "$all_names" >"$tmp/all" || { rm -rf "$tmp"; return 1; }
  printf '%s\n' "$ignored_names" >"$tmp/ignored" || { rm -rf "$tmp"; return 1; }
  if ! python3 - "$expected_count" "$tmp/expected" "$tmp/all" "$tmp/ignored" <<'PY'
import pathlib, sys
expected_count = int(sys.argv[1])
expected = sorted(pathlib.Path(sys.argv[2]).read_text(encoding="utf-8").splitlines())
actual = sorted(
    line
    for line in pathlib.Path(sys.argv[3]).read_text(encoding="utf-8").splitlines()
    if line
)
ignored = sorted(
    line
    for line in pathlib.Path(sys.argv[4]).read_text(encoding="utf-8").splitlines()
    if line
)
if not expected or any(not line for line in expected):
    raise SystemExit("expected inventory contains a blank line")
if len(expected) != expected_count or len(set(expected)) != expected_count:
    raise SystemExit(f"bad expected inventory: {len(expected)} lines/{len(set(expected))} unique")
if actual != expected:
    raise SystemExit(f"prefix inventory mismatch\nexpected={expected!r}\nactual={actual!r}")
if ignored:
    raise SystemExit(f"prefix inventory must be non-ignored; ignored={ignored!r}")
PY
  then
    rm -rf "$tmp"
    return 1
  fi
  if ! run_cargo_test_success "$expected_count" cargo_server_test debug \
      "$prefix" -- --color=never --test-threads=1; then
    rm -rf "$tmp"
    return 1
  fi
  rm -rf "$tmp"
}

assert_max_1000_lines() {
  python3 - "$WT" "$@" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
paths = sys.argv[2:]
if not paths or len(paths) != len(set(paths)):
    raise SystemExit("line-limit check requires a nonempty unique path list")
for rel in paths:
    path = root / rel
    if not path.is_file():
        raise SystemExit(f"missing line-limit target: {rel}")
    count = len(path.read_text(encoding="utf-8").splitlines())
    print(f"{count:4d} {rel}")
    if count > 1000:
        raise SystemExit(f"file exceeds 1000 lines: {rel} ({count})")
PY
}

SD_TASK0_FILES=(
  crates/freshell-server/src/session_directory.rs
  crates/freshell-server/src/session_directory_materialized.rs
  crates/freshell-server/src/session_directory_tests.rs
  crates/freshell-server/src/session_directory_route_tests.rs
  crates/freshell-server/src/session_directory_search_tests.rs
  crates/freshell-server/src/session_directory_inputs.rs
  crates/freshell-server/src/session_directory_page_bound_support.rs
  crates/freshell-server/src/session_directory_page_bound_authority_fixtures.rs
  crates/freshell-server/src/session_directory_page_bound_authority_tests.rs
)
SD_TASK2_FILES=(
  "${SD_TASK0_FILES[@]}"
  crates/freshell-server/src/session_directory_page_bound_legacy_tests.rs
)
SD_TASK3_FILES=(
  "${SD_TASK2_FILES[@]}"
  crates/freshell-server/src/session_directory_fast.rs
  crates/freshell-server/src/session_directory_page_bound_g2_tests.rs
)
SD_TASK4_FILES=(
  "${SD_TASK3_FILES[@]}"
  crates/freshell-server/src/session_directory_page_bound_source_audit.rs
  crates/freshell-server/src/session_directory_page_bound_g1_tests.rs
)
SD_TASK8_FILES=(
  "${SD_TASK4_FILES[@]}"
  crates/freshell-server/src/session_directory_page_bound_g3_tests.rs
)

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

assert_rest_parity_ports_free() {
  python3 - <<'PY'
import socket

for port in (17871, 17872, 17876, 17877):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.25)
    try:
        if sock.connect_ex(("127.0.0.1", port)) == 0:
            raise SystemExit(
                f"REST parity port {port} is already listening; "
                "do not collide with a foreign process or concurrent sweep"
            )
    finally:
        sock.close()
PY
}

run_rest_parity_gate() {
  local head evidence_root results_json sweep_log
  head="$(git -C "$WT" rev-parse --verify HEAD)" || return 1
  mkdir -p "$WT/.worktrees" || return 1
  evidence_root="$(mktemp -d "$WT/.worktrees/session-directory-rest-parity.${head}.XXXXXXXX")" || return 1
  results_json="$evidence_root/results.json"
  sweep_log="$evidence_root/sweep.log"

  npm --prefix "$WT" run build || return 1
  test -f "$WT/dist/server/index.js" || return 1
  test -d "$WT/dist/client" || return 1
  cargo build --manifest-path "$MANIFEST" --release -p freshell-server || return 1
  test -x "$WT/target/release/freshell-server" || return 1
  assert_rest_parity_ports_free || return 1

  printf 'REST parity evidence directory: %s\n' "$evidence_root"
  node "$WT/port/oracle/rest-parity/sweep.mjs" --out "$results_json" 2>&1 | tee "$sweep_log"

  python3 - "$results_json" "$evidence_root" <<'PY'
import json
import pathlib
import sys

results_path = pathlib.Path(sys.argv[1])
evidence_root = pathlib.Path(sys.argv[2])
payload = json.loads(results_path.read_text(encoding="utf-8"))
expected_summary = {"total": 187, "pass": 187, "divergence": 0, "deferred": 0}
if payload.get("summary") != expected_summary:
    raise SystemExit(
        f"unexpected REST parity summary: {payload.get('summary')!r}; "
        f"expected {expected_summary!r}"
    )

results = payload.get("results")
if not isinstance(results, list) or len(results) != 187:
    raise SystemExit(f"expected exactly 187 result records; got {type(results).__name__} {len(results) if isinstance(results, list) else ''}")
if any(result.get("verdict") != "PASS" for result in results):
    raise SystemExit("REST parity artifact contains a non-PASS verdict")

expected_session_directory_ids = {
    "sd.empty.happy",
    "sd.empty.background",
    "sd.nopriority",
    "sd.badlimit",
    "sd.badpriority",
    "sd.badcursor",
    "sd.no-auth",
    "sd.seeded.happy",
    "sd.seeded.query",
    "sd.seeded.query-nomatch",
    "sd.seeded.include-flags",
    "sd.seeded.limit",
}
observed_session_directory = [
    result for result in results if result.get("group") == "session-directory"
]
observed_ids = {result.get("id") for result in observed_session_directory}
if observed_ids != expected_session_directory_ids or len(observed_session_directory) != len(expected_session_directory_ids):
    raise SystemExit(
        "session-directory REST coverage drifted: "
        f"expected={sorted(expected_session_directory_ids)!r} "
        f"observed={sorted(observed_ids)!r}"
    )

# pgrepRust is intentionally not asserted: it may report the authorized live :3001
# server. The sweep's ss field is restricted to the :1787x ports it owns.
if payload.get("orphanCheck", {}).get("ssListeners") not in (None, ""):
    raise SystemExit(
        f"REST parity sweep left a :1787x listener: "
        f"{payload['orphanCheck']['ssListeners']!r}"
    )

print(
    "REST parity gate passed: 187/187 PASS; "
    "12/12 session-directory cases PASS; evidence=" + str(evidence_root)
)
PY
}
```

`run_fmt_check` is intentionally nonmutating. If it fails, edit only the current
task's allowlisted file and rerun; never run a broad mutating formatter over
foreign work.

Compile-fail RED is the sole test-list exception because a noncompiling crate
cannot list tests. Its diagnostic must occur exactly once; the same test must
later pass through `run_exact_debug`. Runtime REDs are listed first and require
an exact marker.

Before relying on the successful filtered-test helpers in implementation, run
shell-level negative acceptance probes (without adding Rust inventory names):
an ignored exact test passed to the normal runner fails annotation discovery; an
ordinary exact test passed to an ignored runner fails; any ignored prefix member
fails; an exit-zero `0 passed` transcript fails; an extra/malformed libtest
summary fails; and any nonzero failed/ignored/measured count fails closed while
printing captured output. Discovery and execution must use the same
profile/filter/exactness/ignored selection. Before either G3 invocation, exercise
`verify_g3_release_output` itself: reject an exit-zero one-passed transcript with
no `G3_*` markers, 29 case summaries, a missing Fast warmup/equality marker, 49
measured pairs for one case, a missing statistic, and a duplicate final marker.
The positive synthetic operand has 30 unique ordered warmups/summaries, 1..=21
doubling calibration rows per case, exactly 10 discarded plus 50 measured pairs
with alternating first strategy, every checked statistic, and one final marker.

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

TASK5_SUBJECT='perf(session-directory): add page-bounded title candidate'
TASK6_SUBJECT='test(session-directory): commit complete compatibility and mutation-killer gates'
TASK6_BASE_FILES=(
  crates/freshell-server/src/session_directory_page_bound_support.rs
  crates/freshell-server/src/session_directory_page_bound_g1_tests.rs
)
TASK6_TEST_FILES=(
  crates/freshell-server/src/session_directory_page_bound_g1_tests.rs
  crates/freshell-server/src/session_directory_page_bound_g2_tests.rs
  crates/freshell-server/src/session_directory_page_bound_support.rs
  crates/freshell-server/src/session_directory_page_bound_source_audit.rs
)
TASK6_PRODUCTION_FILES=(
  crates/freshell-server/src/session_directory.rs
  crates/freshell-server/src/session_directory_materialized.rs
  crates/freshell-server/src/session_directory_inputs.rs
  crates/freshell-server/src/session_directory_fast.rs
)

load_validated_task6_mutation_base() {
  local candidate confirmed status
  candidate="$(python3 - "$WT" "$TASK5_SUBJECT" "$TASK6_SUBJECT" \
    --required "${TASK6_BASE_FILES[@]}" \
    --allowed "${TASK6_TEST_FILES[@]}" <<'PY'
import os
import subprocess
import sys

wt, task5_subject, task6_subject, *args = sys.argv[1:]
if not args or args[0] != "--required" or "--allowed" not in args:
    raise SystemExit("invalid Task-6 identity arguments")
separator = args.index("--allowed")
required = args[1:separator]
allowed = args[separator + 1 :]
if (
    not required
    or not allowed
    or len(required) != len(set(required))
    or len(allowed) != len(set(allowed))
    or not set(required) <= set(allowed)
):
    raise SystemExit("invalid Task-6 required/allowed path sets")


def git(*items: str) -> bytes:
    return subprocess.check_output(["git", "-C", wt, *items])


def text(*items: str) -> str:
    return git(*items).decode("utf-8").rstrip("\n")


actual_top = os.path.realpath(text("rev-parse", "--show-toplevel"))
if actual_top != os.path.realpath(wt):
    raise SystemExit("Task-6 recovery worktree identity changed")
if git(
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "status", "--porcelain=v1", "-z", "--untracked-files=all",
):
    raise SystemExit("Task-6 recovery requires a clean active worktree")

head = text("rev-parse", "--verify", "HEAD^{commit}")
if text("show", "-s", "--format=%s", head) != task6_subject:
    raise SystemExit("active HEAD is not the Task-6 commit")

parent_row = text("rev-list", "--parents", "-n", "1", head).split()
if len(parent_row) != 2 or parent_row[0] != head:
    raise SystemExit("Task-6 commit must have exactly one parent")
parent = parent_row[1]
if text("show", "-s", "--format=%s", parent) != task5_subject:
    raise SystemExit("Task-6 parent is not the Task-5 commit")

raw = git(
    "diff-tree", "--root", "--no-commit-id", "--name-only", "-z",
    "-r", "--no-renames", head,
)
if raw and not raw.endswith(b"\0"):
    raise SystemExit("Task-6 path list is not NUL terminated")
paths = [] if not raw else [os.fsdecode(path) for path in raw[:-1].split(b"\0")]
if len(paths) != len(set(paths)):
    raise SystemExit(f"Task-6 path list contains duplicates: {paths!r}")
actual = set(paths)
missing = set(required) - actual
outside = actual - set(allowed)
if missing or outside:
    raise SystemExit(
        f"Task-6 scope differs: missing={sorted(missing)!r}, "
        f"outside={sorted(outside)!r}, actual={sorted(actual)!r}"
    )
print(head)
PY
  )" || return 1
  test -n "$candidate" || return 1

  confirmed="$(git -C "$WT" rev-parse --verify 'HEAD^{commit}')" || return 1
  test "$confirmed" = "$candidate" || {
    printf 'active HEAD changed during Task-6 recovery\n' >&2
    return 1
  }
  status="$(git -C "$WT" -c core.fsmonitor=false \
    -c core.untrackedCache=false status --porcelain=v1 \
    --untracked-files=all)" || return 1
  test -z "$status" || {
    printf 'active worktree changed during Task-6 recovery\n' >&2
    return 1
  }

  TASK6_COMMIT="$candidate"
  MUTATION_BASE="$candidate"
  export TASK6_COMMIT MUTATION_BASE
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
if mode not in {"working", "task0", "both"}:
    raise SystemExit(f"invalid mode: {mode}")
TASK0_SUBJECT = "test(session-directory): freeze parent response authority"
TASK1_SUBJECT = "refactor(session-directory): extract frozen materialized strategy"
FACADE = "crates/freshell-server/src/session_directory.rs"
MATERIALIZED = "crates/freshell-server/src/session_directory_materialized.rs"
INPUTS = "crates/freshell-server/src/session_directory_inputs.rs"
AUTHORITY_FIXTURES = (
    "crates/freshell-server/src/"
    "session_directory_page_bound_authority_fixtures.rs"
)
MAIN = "crates/freshell-server/src/main.rs"
SEARCH = "crates/freshell-sessions/src/search.rs"
TASK0 = {
    FACADE: [
        "legacy-max-directory-page-items", "legacy-session-directory-state-type",
        "legacy-query-validation", "legacy-session-directory-router",
    ],
    MATERIALIZED: [
        "legacy-dir-item-type-and-impl", "legacy-tier-and-dir-query-types",
        "legacy-indexed-constructor", "legacy-overrides", "legacy-metadata",
        "legacy-provider-display", "legacy-running-join", "legacy-synth-constructor",
        "legacy-live-join", "legacy-cursor-codec", "legacy-apply-query",
        "legacy-file-search-outcome-type", "legacy-file-search", "legacy-title-search",
    ],
    INPUTS: [
        "parent-authority-capture-types", "parent-authority-response-renderer",
        "parent-authority-accessor-trace",
        "parent-authority-work-ledger",
    ],
    AUTHORITY_FIXTURES: [
        "parent-authority-pinned-recorder", "parent-authority-case-manifest-builders",
        "parent-authority-owner-route-executor", "parent-authority-response-fixtures",
        "parent-authority-frozen-old-page",
    ],
    MAIN: ["full-application-layer-assembler", "full-application-layer-production-call"],
}
TASK1 = {
    MATERIALIZED: ["extracted-materialized-page"],
    INPUTS: ["extracted-materialized-dispatch"],
}

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

if mode == "working":
    for path, names in TASK0.items():
        text = current(path)
        for name in names:
            region(text, name)
    parent = "fc8646477dd34d92dc5647d158106431aa2e0380"
    if text_at(parent, SEARCH) != current(SEARCH):
        raise SystemExit("working external search authority changed")
    raise SystemExit(0)

task0 = exact_ancestor(TASK0_SUBJECT)
check(task0, TASK0, "task0")
if text_at(task0, SEARCH) != current(SEARCH):
    raise SystemExit("Task-0 external search authority changed")
if mode == "both":
    task1 = exact_ancestor(TASK1_SUBJECT)
    check(task1, TASK1, "task1")
PY
}
verify_embedded_parent_authority_static() {
  python3 - "$WT" <<'PY'
import base64, hashlib, pathlib, re, sys
path = pathlib.Path(sys.argv[1]) / (
    "crates/freshell-server/src/"
    "session_directory_page_bound_authority_fixtures.rs"
)
text = path.read_text(encoding="utf-8")
begin = "/* SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_BEGIN */"
end = "/* SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_END */"
if text.count(begin) != 1 or text.count(end) != 1:
    raise SystemExit("embedded parent artifact marker count differs")
region = text.split(begin, 1)[1].split(end, 1)[0]
b64_region = region.split(
    "const PINNED_PARENT_COMPLETED_RESPONSE_AUTHORITY_B64", 1
)[1].split(");", 1)[0]
parts = re.findall(r'"([A-Za-z0-9+/=]+)"', b64_region)
hashes = re.findall(r'[0-9a-f]{64}', region)
if not parts or len(hashes) != 1:
    raise SystemExit("embedded parent artifact or SHA-256 is absent/ambiguous")
raw = base64.b64decode("".join(parts), validate=True)
if hashlib.sha256(raw).hexdigest() != hashes[0]:
    raise SystemExit("embedded parent artifact SHA-256 mismatch")
if not raw.endswith(b"\n") or raw.endswith(b"\n\n"):
    raise SystemExit("parent artifact must have exactly one trailing LF")
PY
}

run_task0_static_guard() {
  run_shared_comment_guard &&
    run_authority_guard task0 &&
    verify_embedded_parent_authority_static
}
run_both_static_guards() {
  run_shared_comment_guard &&
    run_authority_guard both &&
    verify_embedded_parent_authority_static
}
run_parent_authority_equality() {
  run_exact_debug \
    "$TEST_AUTH::parent_authority_case_manifest_has_expected_names_and_count" &&
  run_exact_debug \
    "$TEST_AUTH::parent_raw_owner_backed_full_app_baseline_matches_reviewed_goldens" &&
  run_exact_debug \
    "$TEST_AUTH::frozen_old_reference_matches_parent_completed_responses"
}
run_task0_precommit_guard() {
  run_shared_comment_guard &&
    run_authority_guard working &&
    verify_embedded_parent_authority_static &&
    run_parent_authority_equality
}
run_task0_guard() {
  run_task0_static_guard && run_parent_authority_equality
}
run_both_guards() {
  run_both_static_guards &&
    run_parent_authority_equality &&
    run_exact_debug \
      "$TEST_AUTH::extracted_materialized_completed_responses_match_frozen_parent"
}
```

The authority operands are mechanically linked as follows:

| Direct operand | Exact gate | Phase |
|---|---|---|
| Embedded artifact schema/hash/name/input/exchange integrity | `parent_authority_case_manifest_has_expected_names_and_count` | Task-0 precommit and every later authority equality gate |
| Current owner-backed full-app 22-case exchange sequences == embedded artifact | `parent_raw_owner_backed_full_app_baseline_matches_reviewed_goldens` | Task-0 precommit/postcommit and every later `run_both_guards` |
| FrozenOld 21 comparable exchange sequences == embedded artifact | `frozen_old_reference_matches_parent_completed_responses` | Task-0 precommit/postcommit and every later `run_both_guards` |
| ExtractedMaterialized 21 comparable exchange sequences == embedded artifact | `extracted_materialized_completed_responses_match_frozen_parent` | Task 1 and every later `run_both_guards`; historical test name only, no transitive comparison |
| Final production owner route == embedded artifact | `g1_completed_full_app_route_matrix_matches_parent` plus `run_both_guards` | Tasks 6, 9, and 10 after the applicable selector state |
| Recorder reproducibility == decoded embedded artifact | `replay_pinned_parent_authority` | immediately after Task 0 and after Task 10 |

The three tests in `run_parent_authority_equality` perform the direct comparisons
above. No direct artifact operand may be replaced by equality to another
strategy.

The exceptional rebaseline protocol replaces these initial subject anchors with
its reviewed unique hash/subject; normal candidate work never edits this guard.

### Task-0 evidence, pinned-parent capture, and replay helpers

Load this fence in the execution harness before Task 0A. Every function is
defined before Task 0 begins; definitions may name future files, but no function
is called before its phase permits those files.

```bash
set -euo pipefail
PARENT=fc8646477dd34d92dc5647d158106431aa2e0380
PARENT_TREE=b4ff70f7ff0d3aab312b61bad0a3a074d1bebf58
PARENT_SESSION_MONOLITH=crates/freshell-server/src/session_directory.rs
PARENT_AUTHORITY_FIXTURE=crates/freshell-server/src/session_directory_page_bound_authority_fixtures.rs
PARENT_TEST='session_directory::pinned_parent_recorder_entrypoint::emit_pinned_parent_completed_responses'
TOOL_CARGO_HOME="${CARGO_HOME:-${HOME:?HOME is required}/.cargo}"
TOOL_RUSTUP_HOME="${RUSTUP_HOME:-${HOME:?HOME is required}/.rustup}"

canonical_path() {
  python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
}

path_identity() {
  python3 - "$1" <<'PY'
import os, sys
st = os.stat(sys.argv[1], follow_symlinks=True)
print(f"{st.st_dev}:{st.st_ino}")
PY
}

path_mode() {
  python3 - "$1" <<'PY'
import os, stat, sys
print(f"{stat.S_IMODE(os.stat(sys.argv[1], follow_symlinks=True).st_mode):03o}")
PY
}

TASK0_EVIDENCE_OWNED=0
TASK0_EVIDENCE_ROOT=
TASK0_EVIDENCE_ID=
PARENT_RECORDER_BYTES=
PARENT_ENTRYPOINT_BYTES=
PARENT_AUTHORITY_OUT=
PARENT_EMBEDDED_DECODED=
PRESPLIT_SERVER_TESTS=
PRESPLIT_TEST_MAP=
POSTSPLIT_SERVER_TESTS=

PARENT_WORKTREE_TMP=
PARENT_WORKTREE_TMP_ID=
PARENT_WORKTREE_TMP_OWNED=0
PARENT_WT=
PARENT_WT_EXPECTED=
PARENT_WT_ID=
PARENT_WT_GITDIR=
PARENT_WT_GITDIR_ID=
PARENT_WT_OWNED=0
PARENT_BUILD_TMP=
PARENT_BUILD_TMP_EXPECTED=
PARENT_BUILD_TMP_ID=
PARENT_BUILD_TMP_OWNED=0

assert_task0_evidence_owned() {
  test "${TASK0_EVIDENCE_OWNED:-0}" = 1 || return 1
  test -n "${TASK0_EVIDENCE_ROOT:-}" &&
    test -n "${TASK0_EVIDENCE_ID:-}" || return 1
  test "$(canonical_path "$TASK0_EVIDENCE_ROOT")" = "$TASK0_EVIDENCE_ROOT" ||
    return 1
  test "$(path_mode "$TASK0_EVIDENCE_ROOT")" = 700 || return 1
  test "$(path_identity "$TASK0_EVIDENCE_ROOT")" = "$TASK0_EVIDENCE_ID"
}

init_task0_evidence_root() {
  test "${TASK0_EVIDENCE_OWNED:-0}" = 0 || return 1
  TASK0_EVIDENCE_ROOT="$(
    mktemp -d /tmp/session-directory-task0-evidence.XXXXXXXX
  )" || return 1
  test "$(path_mode "$TASK0_EVIDENCE_ROOT")" = 700 || return 1
  TASK0_EVIDENCE_ROOT="$(canonical_path "$TASK0_EVIDENCE_ROOT")" || return 1
  TASK0_EVIDENCE_ID="$(path_identity "$TASK0_EVIDENCE_ROOT")" || return 1
  PARENT_RECORDER_BYTES="$TASK0_EVIDENCE_ROOT/pinned-parent-recorder.rs"
  PARENT_ENTRYPOINT_BYTES="$TASK0_EVIDENCE_ROOT/pinned-parent-entrypoint.rs"
  PARENT_AUTHORITY_OUT="$TASK0_EVIDENCE_ROOT/parent-completed-responses.json"
  PARENT_EMBEDDED_DECODED="$TASK0_EVIDENCE_ROOT/embedded-parent-completed-responses.json"
  PRESPLIT_SERVER_TESTS="$TASK0_EVIDENCE_ROOT/pre-split-server-tests.txt"
  PRESPLIT_TEST_MAP="$TASK0_EVIDENCE_ROOT/pre-split-test-map.json"
  POSTSPLIT_SERVER_TESTS="$TASK0_EVIDENCE_ROOT/post-split-server-tests.txt"
  local child
  for child in \
    "$PARENT_RECORDER_BYTES" "$PARENT_ENTRYPOINT_BYTES" \
    "$PARENT_AUTHORITY_OUT" "$PARENT_EMBEDDED_DECODED" \
    "$PRESPLIT_SERVER_TESTS" "$PRESPLIT_TEST_MAP" "$POSTSPLIT_SERVER_TESTS"
  do
    test ! -e "$child" || return 1
  done
  TASK0_EVIDENCE_OWNED=1
  assert_task0_evidence_owned
}

extract_active_parent_recorder() {
  assert_task0_evidence_owned || return 1
  test ! -e "$PARENT_RECORDER_BYTES" || return 1
  python3 - "$WT" "$PARENT" "$PARENT_SESSION_MONOLITH" \
    "$PARENT_RECORDER_BYTES" <<'PY'
import hashlib, pathlib, subprocess, sys
wt, parent, rel, output = sys.argv[1:]
path = pathlib.Path(wt) / rel
data = path.read_bytes()
outer_begin = (
    b"/* SESSION_DIRECTORY_AUTHORITY_BEGIN:"
    b"parent-authority-pinned-recorder */"
)
outer_end = (
    b"/* SESSION_DIRECTORY_AUTHORITY_END:"
    b"parent-authority-pinned-recorder */"
)
inner_begin = b"/* SESSION_DIRECTORY_PINNED_PARENT_RECORDER_BEGIN */"
inner_end = b"/* SESSION_DIRECTORY_PINNED_PARENT_RECORDER_END */"
for marker in (outer_begin, outer_end, inner_begin, inner_end):
    if data.count(marker) != 1:
        raise SystemExit(f"recorder marker count differs: {marker!r}")
start = data.index(outer_begin)
stop = data.index(outer_end, start) + len(outer_end)
if data[stop:stop + 1] != b"\n":
    raise SystemExit("outer recorder region lacks exactly one terminating LF")
stop += 1
region = data[start:stop]
pinned = subprocess.check_output(["git", "-C", wt, "show", f"{parent}:{rel}"])
if data[:start] + data[stop:] != pinned:
    raise SystemExit("removing active recorder does not yield pinned monolith")
for unchanged in (
    "crates/freshell-server/src/main.rs",
    "crates/freshell-sessions/src/search.rs",
    "test/fixtures/sessions/real-corrupted.jsonl",
    "test/fixtures/sessions/healthy.jsonl",
):
    active = (pathlib.Path(wt) / unchanged).read_bytes()
    expected = subprocess.check_output(
        ["git", "-C", wt, "show", f"{parent}:{unchanged}"]
    )
    if active != expected:
        raise SystemExit(f"active parent input changed: {unchanged}")

def rust_tokens(source: str, label: str) -> list[str]:
    tokens: list[str] = []
    i = 0
    while i < len(source):
        if source[i].isspace():
            i += 1
            continue
        if source.startswith("//", i):
            newline = source.find("\n", i + 2)
            i = len(source) if newline < 0 else newline + 1
            continue
        if source.startswith("/*", i):
            depth = 1
            i += 2
            while i < len(source) and depth:
                if source.startswith("/*", i):
                    depth += 1
                    i += 2
                elif source.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
            if depth:
                raise SystemExit(f"{label}: unterminated block comment")
            continue

        raw_end = None
        for prefix in ("br", "rb", "r"):
            if not source.startswith(prefix, i):
                continue
            cursor = i + len(prefix)
            hashes = 0
            while cursor < len(source) and source[cursor] == "#":
                hashes += 1
                cursor += 1
            if cursor < len(source) and source[cursor] == '"':
                closing = '"' + ("#" * hashes)
                stop = source.find(closing, cursor + 1)
                if stop < 0:
                    raise SystemExit(f"{label}: unterminated raw string")
                raw_end = stop + len(closing)
                break
        if raw_end is not None:
            tokens.append(source[i:raw_end])
            i = raw_end
            continue

        token_start = i
        quote_index = None
        if source.startswith('b"', i) or source.startswith("b'", i):
            quote_index = i + 1
        elif source[i] in {'"', "'"}:
            quote_index = i
        if quote_index is not None and source[quote_index] == "'":
            next_index = quote_index + 1
            if next_index < len(source) and (
                source[next_index].isalpha() or source[next_index] == "_"
            ):
                lifetime_end = next_index + 1
                while lifetime_end < len(source) and (
                    source[lifetime_end].isalnum() or source[lifetime_end] == "_"
                ):
                    lifetime_end += 1
                if lifetime_end >= len(source) or source[lifetime_end] != "'":
                    tokens.append(source[token_start:lifetime_end])
                    i = lifetime_end
                    continue
        if quote_index is not None:
            quote = source[quote_index]
            cursor = quote_index + 1
            while cursor < len(source):
                if source[cursor] == "\\":
                    cursor += 2
                    continue
                if source[cursor] == quote:
                    cursor += 1
                    tokens.append(source[token_start:cursor])
                    i = cursor
                    break
                cursor += 1
            else:
                raise SystemExit(f"{label}: unterminated quoted literal")
            continue

        if source[i].isalpha() or source[i] == "_":
            cursor = i + 1
            while cursor < len(source) and (
                source[cursor].isalnum() or source[cursor] == "_"
            ):
                cursor += 1
            tokens.append(source[i:cursor])
            i = cursor
            continue
        if source[i].isdigit():
            cursor = i + 1
            while cursor < len(source) and (
                source[cursor].isalnum() or source[cursor] in "_."
            ):
                cursor += 1
            tokens.append(source[i:cursor])
            i = cursor
            continue
        tokens.append(source[i])
        i += 1
    return tokens


def normalized_layer_calls(source: str, label: str) -> list[tuple[str, ...]]:
    tokens = rust_tokens(source, label)
    calls: list[tuple[str, ...]] = []
    i = 0
    while i + 2 < len(tokens):
        if tokens[i : i + 3] != [".", "layer", "("]:
            i += 1
            continue
        depth = 0
        for stop in range(i + 2, len(tokens)):
            if tokens[stop] == "(":
                depth += 1
            elif tokens[stop] == ")":
                depth -= 1
                if depth == 0:
                    calls.append(tuple(tokens[i : stop + 1]))
                    i = stop + 1
                    break
                if depth < 0:
                    raise SystemExit(f"{label}: malformed layer call")
        else:
            raise SystemExit(f"{label}: unterminated layer call")
    if len(calls) != 3:
        raise SystemExit(
            f"{label}: expected exactly three layer calls, found {len(calls)}"
        )
    return calls

pinned_main = subprocess.check_output(
    ["git", "-C", wt, "show", f"{parent}:crates/freshell-server/src/main.rs"]
).decode("utf-8")
recorder_layers = normalized_layer_calls(region.decode("utf-8"), "recorder")
main_layers = normalized_layer_calls(pinned_main, "pinned main.rs")
if recorder_layers != main_layers:
    raise SystemExit(
        "recorder full-application layer chain differs from pinned main.rs"
    )

inner_start = region.index(inner_begin)
inner_stop = region.index(inner_end, inner_start) + len(inner_end)
if region[inner_stop:inner_stop + 1] != b"\n":
    raise SystemExit("inner recorder hash region lacks one LF")
print("recorder_sha256=" + hashlib.sha256(
    region[inner_start:inner_stop + 1]
).hexdigest())
pathlib.Path(output).open("xb").write(region)
PY
  assert_task0_evidence_owned
}

validate_parent_provenance() {
  python3 - "$WT" "$PARENT" "$PARENT_TREE" <<'PY'
import json, subprocess, sys
wt, parent, tree = sys.argv[1:]
actual_tree = subprocess.check_output(
    ["git", "-C", wt, "show", "-s", "--format=%T", parent], text=True
).strip()
if actual_tree != tree:
    raise SystemExit(f"parent tree mismatch: {actual_tree} != {tree}")
expected = {
    "crates/freshell-server/src/session_directory.rs": "843f98c896d30650c2fc8c3ccb77f4635272d984",
    "crates/freshell-server/src/main.rs": "346e7d96432f61c6699461d2c58f97406ae36bbe",
    "crates/freshell-sessions/src/search.rs": "8da06ea083e1ae651c61fea186f67dcef906d5a8",
    "crates/freshell-sessions/src/parse/opencode.rs": "684003ab22ba10d6154e5fd11c95b5a885bfd1ce",
    "crates/freshell-sessions/src/amplifier.rs": "313ecf588daef15530e2048d66c5dbce1cf627ef",
    "test/fixtures/sessions/real-corrupted.jsonl": "c3ae6eb134e66303f2cf901bdbc895fc85d71b52",
    "test/fixtures/sessions/healthy.jsonl": "1e67a84c5acdf949c8953481280362a96bfbc453",
}
actual = {
    path: subprocess.check_output(
        ["git", "-C", wt, "rev-parse", f"{parent}:{path}"], text=True
    ).strip()
    for path in expected
}
if actual != expected:
    raise SystemExit(
        "pinned provenance mismatch: "
        + json.dumps({"expected": expected, "actual": actual}, sort_keys=True)
    )
def json_lines(path):
    raw = subprocess.check_output(["git", "-C", wt, "show", f"{parent}:{path}"])
    return [
        json.loads(line)
        for line in raw.decode("utf-8").splitlines()
        if line.strip()
    ]
corrupt = json_lines("test/fixtures/sessions/real-corrupted.jsonl")
healthy = json_lines("test/fixtures/sessions/healthy.jsonl")
visible_ids = sorted({
    row["sessionId"] for row in corrupt
    if isinstance(row, dict) and isinstance(row.get("sessionId"), str)
})
excluded_ids = sorted({
    row["session_id"] for row in healthy
    if isinstance(row, dict) and isinstance(row.get("session_id"), str)
})
if visible_ids != ["b7936c10-4935-441c-837c-c1f33cafec2d"]:
    raise SystemExit(f"unexpected visible fixture IDs: {visible_ids!r}")
if excluded_ids != ["healthy-session-id"]:
    raise SystemExit(f"unexpected cwd-less fixture IDs: {excluded_ids!r}")
PY
}

assert_parent_worktree_record() {
  local mode="$1"
  python3 - "$WT" "$PARENT_WT_EXPECTED" "$PARENT" "$mode" <<'PY'
import os, subprocess, sys
wt, expected, parent, mode = sys.argv[1:]
raw = subprocess.check_output(
    ["git", "-C", wt, "worktree", "list", "--porcelain", "-z"]
)
records = []
for block in raw.split(b"\0\0"):
    if not block:
        continue
    record, flags = {}, set()
    for field in block.split(b"\0"):
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
    record for record in records
    if os.path.realpath(record.get("worktree", "")) == expected
]
if mode == "absent":
    if matches:
        raise SystemExit(f"parent path already registered: {matches!r}")
elif mode == "owned":
    if len(matches) != 1:
        raise SystemExit(f"expected one parent registration: {matches!r}")
    record = matches[0]
    if record.get("HEAD") != parent or "detached" not in record["flags"]:
        raise SystemExit(f"parent registration identity changed: {record!r}")
    if {"locked", "prunable"} & (set(record) | record["flags"]):
        raise SystemExit(f"parent registration locked/prunable: {record!r}")
else:
    raise SystemExit(f"invalid parent registration mode: {mode}")
PY
}

assert_parent_build_root_owned() {
  test "${PARENT_BUILD_TMP_OWNED:-0}" = 1 || return 1
  test "$(canonical_path "$PARENT_BUILD_TMP")" = "$PARENT_BUILD_TMP_EXPECTED" ||
    return 1
  test "$(path_mode "$PARENT_BUILD_TMP")" = 700 || return 1
  test "$(path_identity "$PARENT_BUILD_TMP")" = "$PARENT_BUILD_TMP_ID" ||
    return 1
  local child
  for child in home tmp target; do
    test -d "$PARENT_BUILD_TMP/$child" &&
      test ! -L "$PARENT_BUILD_TMP/$child" || return 1
  done
}

assert_parent_worktree_identity() {
  test "${PARENT_WORKTREE_TMP_OWNED:-0}" = 1 || return 1
  test -n "${PARENT_WORKTREE_TMP:-}" &&
    test -n "${PARENT_WORKTREE_TMP_ID:-}" &&
    test -n "${PARENT_WT:-}" &&
    test -n "${PARENT_WT_EXPECTED:-}" &&
    test -n "${PARENT_WT_ID:-}" &&
    test -n "${PARENT_WT_GITDIR:-}" &&
    test -n "${PARENT_WT_GITDIR_ID:-}" || return 1
  test -d "$PARENT_WORKTREE_TMP" &&
    test ! -L "$PARENT_WORKTREE_TMP" || return 1
  test "$(canonical_path "$PARENT_WORKTREE_TMP")" = \
    "$PARENT_WORKTREE_TMP" || return 1
  test "$(path_mode "$PARENT_WORKTREE_TMP")" = 700 || return 1
  test "$(path_identity "$PARENT_WORKTREE_TMP")" = \
    "$PARENT_WORKTREE_TMP_ID" || return 1
  assert_parent_worktree_record owned || return 1
  test -d "$PARENT_WT" && test ! -L "$PARENT_WT" || return 1
  test "$(canonical_path "$PARENT_WT")" = "$PARENT_WT_EXPECTED" ||
    return 1
  test "$(path_identity "$PARENT_WT")" = "$PARENT_WT_ID" || return 1
  test "$(canonical_path \
    "$(git -C "$PARENT_WT" rev-parse --show-toplevel)")" = \
    "$PARENT_WT_EXPECTED" || return 1
  test "$(git -C "$PARENT_WT" rev-parse HEAD)" = "$PARENT" || return 1
  test "$(canonical_path \
    "$(git -C "$PARENT_WT" rev-parse --absolute-git-dir)")" = \
    "$PARENT_WT_GITDIR" || return 1
  test "$(path_identity "$PARENT_WT_GITDIR")" = \
    "$PARENT_WT_GITDIR_ID" || return 1
}

assert_parent_capture_identity() {
  assert_parent_worktree_identity || return 1
  assert_parent_build_root_owned
}

assert_parent_capture_owned() {
  test "${PARENT_WT_OWNED:-0}" = 1 || return 1
  assert_parent_capture_identity
}

create_parent_capture_scratch() {
  local clean_status
  test "${PARENT_WT_OWNED:-0}" = 0 || return 1
  test "${PARENT_BUILD_TMP_OWNED:-0}" = 0 || return 1
  PARENT_WORKTREE_TMP="$(
    mktemp -d /tmp/session-directory-parent-worktree.XXXXXXXX
  )" || return 1
  test "$(path_mode "$PARENT_WORKTREE_TMP")" = 700 || return 1
  PARENT_WORKTREE_TMP="$(canonical_path "$PARENT_WORKTREE_TMP")" || return 1
  PARENT_WORKTREE_TMP_ID="$(path_identity "$PARENT_WORKTREE_TMP")" || return 1
  PARENT_WORKTREE_TMP_OWNED=1
  PARENT_WT="$PARENT_WORKTREE_TMP/worktree"
  PARENT_WT_EXPECTED="$(canonical_path "$PARENT_WT")" || return 1
  test ! -e "$PARENT_WT" || return 1
  assert_parent_worktree_record absent || return 1
  if git -C "$WT" cat-file -e "$PARENT:.gitattributes" 2>/dev/null; then
    printf 'pinned parent has .gitattributes; refusing filtered checkout\n' >&2
    return 1
  fi
  local common_attributes
  common_attributes="$(git -C "$WT" rev-parse --git-path info/attributes)" ||
    return 1
  test ! -s "$common_attributes" || return 1

  PARENT_BUILD_TMP="$(
    mktemp -d /tmp/session-directory-parent-build.XXXXXXXX
  )" || return 1
  test "$(path_mode "$PARENT_BUILD_TMP")" = 700 || return 1
  PARENT_BUILD_TMP="$(canonical_path "$PARENT_BUILD_TMP")" || return 1
  PARENT_BUILD_TMP_EXPECTED="$PARENT_BUILD_TMP"
  PARENT_BUILD_TMP_ID="$(path_identity "$PARENT_BUILD_TMP")" || return 1
  mkdir "$PARENT_BUILD_TMP/home" "$PARENT_BUILD_TMP/tmp" \
    "$PARENT_BUILD_TMP/target" || return 1
  PARENT_BUILD_TMP_OWNED=1
  test -d "$TOOL_CARGO_HOME" && test "${TOOL_CARGO_HOME#/}" != \
    "$TOOL_CARGO_HOME" || return 1
  test -d "$TOOL_RUSTUP_HOME" && test "${TOOL_RUSTUP_HOME#/}" != \
    "$TOOL_RUSTUP_HOME" || return 1

  export GIT_CONFIG_GLOBAL=/dev/null
  export GIT_CONFIG_SYSTEM=/dev/null
  trap cleanup_parent_capture_scratch EXIT
  git -C "$WT" -c core.hooksPath=/dev/null -c core.fsmonitor=false \
    -c core.untrackedCache=false -c core.attributesFile=/dev/null \
    worktree add --detach "$PARENT_WT" "$PARENT" || return 1
  assert_parent_worktree_record owned || return 1
  test "$(canonical_path "$PARENT_WT")" = "$PARENT_WT_EXPECTED" ||
    return 1
  test "$(git -C "$PARENT_WT" rev-parse HEAD)" = "$PARENT" || return 1
  PARENT_WT_ID="$(path_identity "$PARENT_WT")" || return 1
  PARENT_WT_GITDIR="$(canonical_path \
    "$(git -C "$PARENT_WT" rev-parse --absolute-git-dir)")" || return 1
  PARENT_WT_GITDIR_ID="$(path_identity "$PARENT_WT_GITDIR")" || return 1

  # Ownership is still false. Verify every captured root/worktree/gitdir/build
  # identity once, read clean status with its exit status preserved, then repeat
  # the same complete identity predicate before setting ownership.
  assert_parent_capture_identity || return 1
  clean_status="$(git -C "$PARENT_WT" -c core.fsmonitor=false \
    -c core.untrackedCache=false status --porcelain=v1 \
    --untracked-files=all)" || return 1
  test -z "$clean_status" || return 1
  assert_parent_capture_identity || return 1
  PARENT_WT_OWNED=1
  assert_parent_capture_owned
}

write_exact_parent_entrypoint() {
  local root="$1" root_id="$2" path="$3"
  test "$(canonical_path "$root")" = "$root" || return 1
  test "$(path_mode "$root")" = 700 || return 1
  test "$(path_identity "$root")" = "$root_id" || return 1
  test "$(canonical_path "${path%/*}")" = "$root" || return 1
  test ! -e "$path" || return 1
  (umask 077; set -o noclobber; cat >"$path" <<'RS'
#[cfg(test)]
mod pinned_parent_recorder_entrypoint {
    #[tokio::test]
    #[ignore = "pinned-parent response recorder; run explicitly"]
    async fn emit_pinned_parent_completed_responses() {
        crate::session_directory::pinned_parent_recorder::
            write_pinned_parent_completed_responses_from_env()
            .await
            .expect("write canonical pinned-parent completed responses");
    }
}
RS
  )
}

assert_parent_append_only_delta() {
  local recorder="$1" entrypoint="$2"
  assert_parent_capture_owned || return 1
  python3 - "$PARENT_WT" "$PARENT" "$PARENT_SESSION_MONOLITH" \
    "$recorder" "$entrypoint" <<'PY'
import pathlib, subprocess, sys
wt, parent, rel, recorder, entrypoint = sys.argv[1:]
base = subprocess.check_output(["git", "-C", wt, "show", f"{parent}:{rel}"])
expected = base + pathlib.Path(recorder).read_bytes() + pathlib.Path(entrypoint).read_bytes()
if (pathlib.Path(wt) / rel).read_bytes() != expected:
    raise SystemExit("parent scratch is not exact append-only bytes")
status = subprocess.check_output([
    "git", "-C", wt, "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false", "status", "--porcelain=v1",
    "-z", "--untracked-files=all",
])
expected_status = b" M " + rel.encode() + b"\0"
if status != expected_status:
    raise SystemExit(f"parent scratch delta differs: {status!r}")
PY
  assert_parent_capture_owned
}

append_parent_recorder_suffix() {
  local recorder="$1" entrypoint="$2"
  assert_parent_capture_owned || return 1
  test -f "$recorder" && test ! -L "$recorder" || return 1
  test -f "$entrypoint" && test ! -L "$entrypoint" || return 1
  python3 - "$PARENT_WT" "$PARENT" "$PARENT_SESSION_MONOLITH" \
    "$recorder" "$entrypoint" <<'PY'
import pathlib, subprocess, sys
wt, parent, rel, recorder, entrypoint = sys.argv[1:]
path = pathlib.Path(wt) / rel
base = subprocess.check_output(["git", "-C", wt, "show", f"{parent}:{rel}"])
if path.read_bytes() != base:
    raise SystemExit("parent monolith changed before append")
path.write_bytes(base + pathlib.Path(recorder).read_bytes() + pathlib.Path(entrypoint).read_bytes())
PY
  assert_parent_append_only_delta "$recorder" "$entrypoint"
}

validate_parent_completed_response_artifact() {
  local artifact="$1" recorder="$2"
  python3 - "$artifact" "$recorder" "$PARENT" "$PARENT_TREE" <<'PY'
import base64, hashlib, json, pathlib, re, sys
artifact_path, recorder_path, parent, tree = sys.argv[1:]
raw = pathlib.Path(artifact_path).read_bytes()
if not raw.endswith(b"\n") or raw.endswith(b"\n\n"):
    raise SystemExit("artifact must have exactly one trailing LF")
value = json.loads(raw)
canonical = json.dumps(
    value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
).encode("utf-8") + b"\n"
if raw != canonical:
    raise SystemExit("artifact is not canonical JSON")
expected_names = [
    "no_index_no_query_empty_colors", "empty_snapshot_no_query_empty_colors",
    "no_query_composed_without_colors", "no_query_composed_with_ordered_colors",
    "title_annotation_cursor_with_ordered_colors", "title_snippet_139_scalars",
    "title_snippet_140_scalars", "title_snippet_141_scalars",
    "user_messages_success", "user_messages_cursor_page",
    "user_messages_budget_partial", "user_messages_io_partial",
    "full_text_success", "full_text_cursor_page", "full_text_budget_partial",
    "invalid_priority_limit_and_tier",
    "invalid_cursor_derivation_error_no_colors", "request_revision_is_ignored",
    "single_identity_running_join", "project_color_order_on_title_route",
    "project_color_order_on_user_messages_route",
    "project_color_order_on_full_text_route",
]
if value.get("schema") != "freshell.session-directory.parent-responses.v1":
    raise SystemExit("artifact schema mismatch")
if value.get("parent_commit") != parent or value.get("parent_tree") != tree:
    raise SystemExit("artifact parent identity mismatch")
if set(value) != {
    "schema", "parent_commit", "parent_tree", "source_blobs",
    "recorder_sha256", "manifest_sha256", "cases",
}:
    raise SystemExit("artifact top-level keys mismatch")
expected_blobs = {
    "crates/freshell-server/src/session_directory.rs": "843f98c896d30650c2fc8c3ccb77f4635272d984",
    "crates/freshell-server/src/main.rs": "346e7d96432f61c6699461d2c58f97406ae36bbe",
    "crates/freshell-sessions/src/search.rs": "8da06ea083e1ae651c61fea186f67dcef906d5a8",
    "crates/freshell-sessions/src/parse/opencode.rs": "684003ab22ba10d6154e5fd11c95b5a885bfd1ce",
    "crates/freshell-sessions/src/amplifier.rs": "313ecf588daef15530e2048d66c5dbce1cf627ef",
    "test/fixtures/sessions/real-corrupted.jsonl": "c3ae6eb134e66303f2cf901bdbc895fc85d71b52",
    "test/fixtures/sessions/healthy.jsonl": "1e67a84c5acdf949c8953481280362a96bfbc453",
}
if value.get("source_blobs") != expected_blobs:
    raise SystemExit("artifact source blob map mismatch")
cases = value.get("cases")
if not isinstance(cases, list) or [case.get("name") for case in cases] != expected_names:
    raise SystemExit("artifact case names/order mismatch")
comparable = [case["name"] for case in cases if case.get("strategy_comparable")]
if len(comparable) != 21 or "invalid_priority_limit_and_tier" in comparable:
    raise SystemExit("artifact comparable projection mismatch")
digests = [case.get("owner_input_sha256") for case in cases]
if len(set(digests)) != 22 or any(
    not isinstance(item, str) or not re.fullmatch(r"[0-9a-f]{64}", item)
    for item in digests
):
    raise SystemExit("owner input digests invalid/nonunique")
for case in cases:
    if set(case) != {
        "name", "strategy_comparable", "owner_input_sha256", "exchanges"
    }:
        raise SystemExit(f"case keys mismatch: {case.get('name')}")
    exchanges = case.get("exchanges")
    expected_count = 2 if case["name"] in {
        "user_messages_cursor_page", "full_text_cursor_page"
    } else 1
    if not isinstance(exchanges, list) or len(exchanges) != expected_count:
        raise SystemExit(f"exchange count mismatch: {case['name']}")
    for exchange in exchanges:
        if set(exchange) != {"request", "status", "content_type", "body_base64"}:
            raise SystemExit("exchange keys mismatch")
        request = exchange.get("request")
        if set(request or {}) != {"method", "uri", "ordered_headers"}:
            raise SystemExit("request shape mismatch")
        if request["method"] != "GET" or not isinstance(request["ordered_headers"], list):
            raise SystemExit("request method/header order mismatch")
        expected_status = 400 if case["name"] in {
            "invalid_priority_limit_and_tier",
            "invalid_cursor_derivation_error_no_colors",
        } else 200
        if exchange.get("status") != expected_status:
            raise SystemExit(f"status mismatch: {case['name']}")
        if exchange.get("content_type") != "application/json; charset=utf-8":
            raise SystemExit("content type mismatch")
        body = base64.b64decode(exchange.get("body_base64", ""), validate=True)
        if not body:
            raise SystemExit("empty response body")
recorder = pathlib.Path(recorder_path).read_bytes()
inner_begin = b"/* SESSION_DIRECTORY_PINNED_PARENT_RECORDER_BEGIN */"
inner_end = b"/* SESSION_DIRECTORY_PINNED_PARENT_RECORDER_END */"
start = recorder.index(inner_begin)
stop = recorder.index(inner_end, start) + len(inner_end) + 1
if value.get("recorder_sha256") != hashlib.sha256(recorder[start:stop]).hexdigest():
    raise SystemExit("recorder hash mismatch")
projection = [
    {
        "name": case["name"],
        "strategy_comparable": case["strategy_comparable"],
        "owner_input_sha256": case["owner_input_sha256"],
        "requests": [exchange["request"] for exchange in case["exchanges"]],
    }
    for case in cases
]
manifest = json.dumps(
    projection, sort_keys=True, separators=(",", ":"), ensure_ascii=False
).encode("utf-8")
if value.get("manifest_sha256") != hashlib.sha256(manifest).hexdigest():
    raise SystemExit("manifest hash mismatch")
print("artifact_sha256=" + hashlib.sha256(raw).hexdigest())
PY
}

run_parent_recorder_exact() {
  local output="$1" recorder="$2"
  assert_parent_capture_owned || return 1
  assert_parent_append_only_delta "$recorder" "$PARENT_ENTRYPOINT_BYTES" ||
    return 1
  assert_parent_build_root_owned || return 1
  test ! -e "$output" || return 1
  command -v unshare >/dev/null || return 1
  command -v timeout >/dev/null || return 1
  run_cargo_test_success 1 \
    timeout --signal=TERM --kill-after=10s 20m \
    unshare --user --map-root-user --net \
    env -i \
      PATH="$PATH" \
      HOME="$PARENT_BUILD_TMP/home" \
      TMPDIR="$PARENT_BUILD_TMP/tmp" \
      CARGO_HOME="$TOOL_CARGO_HOME" \
      RUSTUP_HOME="$TOOL_RUSTUP_HOME" \
      CARGO_TARGET_DIR="$PARENT_BUILD_TMP/target" \
      CARGO_TERM_COLOR=never \
      CARGO_NET_OFFLINE=true \
      CLAUDE_HOME="$PARENT_BUILD_TMP/home/no-claude" \
      CODEX_HOME="$PARENT_BUILD_TMP/home/no-codex" \
      XDG_DATA_HOME="$PARENT_BUILD_TMP/home/no-xdg" \
      LOCALAPPDATA="$PARENT_BUILD_TMP/home/no-localappdata" \
      FRESHELL_AMPLIFIER_HOME="$PARENT_BUILD_TMP/home/no-amplifier" \
      FRESHELL_HOME="$PARENT_BUILD_TMP/home/freshell" \
      FRESHELL_PARENT_AUTHORITY_OUT="$output" \
      cargo test --offline --color=never \
        --manifest-path "$PARENT_WT/Cargo.toml" \
        -p freshell-server --bin freshell-server "$PARENT_TEST" -- \
        --exact --ignored --nocapture --color=never --test-threads=1
  assert_parent_capture_owned || return 1
  assert_parent_append_only_delta "$recorder" "$PARENT_ENTRYPOINT_BYTES" ||
    return 1
  assert_parent_build_root_owned || return 1
  test -s "$output" || return 1
  validate_parent_completed_response_artifact "$output" "$recorder"
}

restore_parent_append_only_suffix() {
  local recorder="$1" entrypoint="$2"
  assert_parent_append_only_delta "$recorder" "$entrypoint" || return 1
  python3 - "$PARENT_WT" "$PARENT" "$PARENT_SESSION_MONOLITH" \
    "$recorder" "$entrypoint" <<'PY'
import pathlib, subprocess, sys
wt, parent, rel, recorder, entrypoint = sys.argv[1:]
path = pathlib.Path(wt) / rel
base = subprocess.check_output(["git", "-C", wt, "show", f"{parent}:{rel}"])
suffix = pathlib.Path(recorder).read_bytes() + pathlib.Path(entrypoint).read_bytes()
data = path.read_bytes()
if data != base + suffix:
    raise SystemExit("refusing non-exact parent suffix removal")
path.write_bytes(base)
PY
  assert_parent_capture_owned || return 1
  test -z "$(git -C "$PARENT_WT" -c core.fsmonitor=false \
    -c core.untrackedCache=false status --porcelain=v1 --untracked-files=all)"
}

assert_parent_build_root_after_clean() {
  test "${PARENT_BUILD_TMP_OWNED:-0}" = 1 || return 1
  test -d "$PARENT_BUILD_TMP" && test ! -L "$PARENT_BUILD_TMP" ||
    return 1
  test "$(canonical_path "$PARENT_BUILD_TMP")" = \
    "$PARENT_BUILD_TMP_EXPECTED" || return 1
  test "$(path_mode "$PARENT_BUILD_TMP")" = 700 || return 1
  test "$(path_identity "$PARENT_BUILD_TMP")" = \
    "$PARENT_BUILD_TMP_ID" || return 1
  test ! -e "$PARENT_BUILD_TMP/target" || return 1
  python3 - "$PARENT_BUILD_TMP" <<'PY'
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
entries = list(os.scandir(root))
if {entry.name for entry in entries} != {"home", "tmp"}:
    raise SystemExit("post-clean build root has unexpected entries")
for entry in entries:
    if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
        raise SystemExit(f"post-clean child type changed: {entry.name}")
    with os.scandir(entry.path) as children:
        if next(children, None) is not None:
            raise SystemExit(f"post-clean child is not empty: {entry.name}")
PY
}

cleanup_parent_capture_scratch() {
  local original_status="$?" cleanup_status=0 status
  trap - EXIT

  if test "${PARENT_WT_OWNED:-0}" != 1 ||
     test "${PARENT_WORKTREE_TMP_OWNED:-0}" != 1 ||
     test "${PARENT_BUILD_TMP_OWNED:-0}" != 1; then
    printf 'partial/unowned parent capture state preserved\n' >&2
    test "$original_status" -ne 0 && return "$original_status"
    return 1
  fi

  # No destructive transition is reachable unless full ownership, a successful
  # clean-status command, an empty status, and a second full ownership check pass.
  if ! assert_parent_capture_owned; then
    cleanup_status=1
  elif ! status="$(git -C "$PARENT_WT" -c core.fsmonitor=false \
      -c core.untrackedCache=false status --porcelain=v1 \
      --untracked-files=all)"; then
    cleanup_status=1
  elif test -n "$status"; then
    cleanup_status=1
  elif ! assert_parent_capture_owned; then
    cleanup_status=1
  fi

  if test "$cleanup_status" = 0; then
    assert_parent_build_root_owned || cleanup_status=1
  fi
  if test "$cleanup_status" = 0; then
    cargo clean --manifest-path "$PARENT_WT/Cargo.toml" \
      --target-dir "$PARENT_BUILD_TMP/target" || cleanup_status=1
  fi
  if test "$cleanup_status" = 0; then
    # No-package cargo clean removes the complete target directory. Prove that
    # transition and exact emptiness of the two remaining known children.
    assert_parent_build_root_after_clean || cleanup_status=1
  fi
  if test "$cleanup_status" = 0; then
    rmdir "$PARENT_BUILD_TMP/tmp" || cleanup_status=1
  fi
  if test "$cleanup_status" = 0; then
    rmdir "$PARENT_BUILD_TMP/home" || cleanup_status=1
  fi

  # Build children are now gone, so use the worktree-only identity predicate.
  # Recheck it around a fresh clean-status read immediately before removal.
  if test "$cleanup_status" = 0; then
    assert_parent_worktree_identity || cleanup_status=1
  fi
  if test "$cleanup_status" = 0; then
    if ! status="$(git -C "$PARENT_WT" -c core.fsmonitor=false \
        -c core.untrackedCache=false status --porcelain=v1 \
        --untracked-files=all)"; then
      cleanup_status=1
    elif test -n "$status"; then
      cleanup_status=1
    fi
  fi
  if test "$cleanup_status" = 0; then
    assert_parent_worktree_identity || cleanup_status=1
  fi
  if test "$cleanup_status" = 0; then
    git -C "$WT" worktree remove "$PARENT_WT" || cleanup_status=1
  fi
  if test "$cleanup_status" = 0; then
    if test ! -e "$PARENT_WT" &&
       assert_parent_worktree_record absent &&
       test ! -e "$PARENT_WT_GITDIR"; then
      PARENT_WT_OWNED=0
    else
      cleanup_status=1
    fi
  fi

  # Clear each root flag only after that exact captured root was revalidated,
  # removed with rmdir, and proven absent. Every later removal remains gated on
  # all earlier checks/transitions succeeding.
  if test "$cleanup_status" = 0; then
    if test -d "$PARENT_WORKTREE_TMP" &&
       test ! -L "$PARENT_WORKTREE_TMP" &&
       test "$(canonical_path "$PARENT_WORKTREE_TMP")" = \
         "$PARENT_WORKTREE_TMP" &&
       test "$(path_mode "$PARENT_WORKTREE_TMP")" = 700 &&
       test "$(path_identity "$PARENT_WORKTREE_TMP")" = \
         "$PARENT_WORKTREE_TMP_ID" &&
       rmdir "$PARENT_WORKTREE_TMP" &&
       test ! -e "$PARENT_WORKTREE_TMP"; then
      PARENT_WORKTREE_TMP_OWNED=0
    else
      cleanup_status=1
    fi
  fi
  if test "$cleanup_status" = 0; then
    if test -d "$PARENT_BUILD_TMP" &&
       test ! -L "$PARENT_BUILD_TMP" &&
       test "$(canonical_path "$PARENT_BUILD_TMP")" = \
         "$PARENT_BUILD_TMP_EXPECTED" &&
       test "$(path_mode "$PARENT_BUILD_TMP")" = 700 &&
       test "$(path_identity "$PARENT_BUILD_TMP")" = \
         "$PARENT_BUILD_TMP_ID" &&
       rmdir "$PARENT_BUILD_TMP" &&
       test ! -e "$PARENT_BUILD_TMP"; then
      PARENT_BUILD_TMP_OWNED=0
    else
      cleanup_status=1
    fi
  fi

  if test "$cleanup_status" != 0; then
    printf 'parent capture cleanup stopped; ambiguous state preserved\n' >&2
  fi
  test "$original_status" -eq 0 || return "$original_status"
  return "$cleanup_status"
}

capture_parent_artifact_from_recorder() {
  local recorder="$1" output="$2" entrypoint="$3"
  local evidence_root="$4" evidence_root_id="$5" run_status=0
  test "$(canonical_path "$evidence_root")" = "$evidence_root" || return 1
  test "$(path_mode "$evidence_root")" = 700 || return 1
  test "$(path_identity "$evidence_root")" = "$evidence_root_id" || return 1
  test "$(canonical_path "${recorder%/*}")" = "$evidence_root" || return 1
  test "$(canonical_path "${output%/*}")" = "$evidence_root" || return 1
  test "$(canonical_path "${entrypoint%/*}")" = "$evidence_root" || return 1
  test -f "$recorder" && test ! -L "$recorder" || return 1
  test ! -e "$output" && test ! -e "$entrypoint" || return 1
  PARENT_ENTRYPOINT_BYTES="$entrypoint"
  write_exact_parent_entrypoint \
    "$evidence_root" "$evidence_root_id" "$entrypoint" || return 1
  create_parent_capture_scratch || return 1
  append_parent_recorder_suffix "$recorder" "$entrypoint" || return 1
  assert_parent_append_only_delta "$recorder" "$entrypoint" || return 1
  run_parent_recorder_exact "$output" "$recorder" || run_status=$?
  restore_parent_append_only_suffix "$recorder" "$entrypoint" || return 1
  cleanup_parent_capture_scratch || return 1
  test -f "$entrypoint" && test ! -L "$entrypoint" || return 1
  rm -- "$entrypoint" || return 1
  test "$run_status" -eq 0 || return "$run_status"
  validate_parent_completed_response_artifact "$output" "$recorder"
}

capture_pinned_parent_authority() {
  assert_task0_evidence_owned || return 1
  validate_parent_provenance || return 1
  capture_parent_artifact_from_recorder \
    "$PARENT_RECORDER_BYTES" \
    "$PARENT_AUTHORITY_OUT" \
    "$PARENT_ENTRYPOINT_BYTES" \
    "$TASK0_EVIDENCE_ROOT" \
    "$TASK0_EVIDENCE_ID"
}

install_captured_parent_authority() {
  assert_task0_evidence_owned || return 1
  validate_parent_completed_response_artifact \
    "$PARENT_AUTHORITY_OUT" "$PARENT_RECORDER_BYTES" || return 1
  python3 - "$WT/$PARENT_AUTHORITY_FIXTURE" "$PARENT_AUTHORITY_OUT" \
    "$PARENT_EMBEDDED_DECODED" <<'PY'
import base64, hashlib, pathlib, re, sys, textwrap
source_path, artifact_path, decoded_path = map(pathlib.Path, sys.argv[1:])
source = source_path.read_text(encoding="utf-8")
artifact = artifact_path.read_bytes()
begin = "/* SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_BEGIN */"
end = "/* SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_END */"
if source.count(begin) != 1 or source.count(end) != 1:
    raise SystemExit("artifact placeholder marker count differs")
old = source[source.index(begin):source.index(end) + len(end)]
if old.count("__SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_B64_PLACEHOLDER__") != 1:
    raise SystemExit("base64 placeholder count differs")
if old.count("__SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_SHA256_PLACEHOLDER__") != 1:
    raise SystemExit("hash placeholder count differs")
chunks = textwrap.wrap(base64.b64encode(artifact).decode("ascii"), 76)
sha = hashlib.sha256(artifact).hexdigest()
lines = "\n".join(f'    "{chunk}",' for chunk in chunks)
new = f'''{begin}
#[cfg(test)]
const PINNED_PARENT_COMPLETED_RESPONSE_AUTHORITY_B64: &str = concat!(
{lines}
);
#[cfg(test)]
const PINNED_PARENT_COMPLETED_RESPONSE_AUTHORITY_SHA256: &str = "{sha}";
{end}'''
source_path.write_text(source.replace(old, new, 1), encoding="utf-8")
written = source_path.read_text(encoding="utf-8")
region = written.split(begin, 1)[1].split(end, 1)[0]
b64_region = region.split("concat!(", 1)[1].split(");", 1)[0]
parts = re.findall(r'"([A-Za-z0-9+/=]+)"', b64_region)
decoded = base64.b64decode("".join(parts), validate=True)
if hashlib.sha256(decoded).hexdigest() != sha:
    raise SystemExit("embedded artifact hash mismatch")
pathlib.Path(decoded_path).open("xb").write(decoded)
PY
  cmp -- "$PARENT_AUTHORITY_OUT" "$PARENT_EMBEDDED_DECODED" || return 1
  verify_embedded_parent_authority_static
}

extract_task0_frozen_recorder_and_artifact() {
  local recorder_output="$1" artifact_output="$2"
  python3 - "$WT" "$PARENT_AUTHORITY_FIXTURE" \
    "$recorder_output" "$artifact_output" <<'PY'
import base64, hashlib, json, pathlib, re, subprocess, sys
wt, rel, recorder_output, artifact_output = sys.argv[1:]
subject = "test(session-directory): freeze parent response authority"
fields = subprocess.check_output(
    ["git", "-C", wt, "log", "-z", "HEAD", "--format=%H%x00%s"]
).decode().split("\0")
matches = [h for h, s in zip(fields[0::2], fields[1::2]) if s == subject]
if len(matches) != 1:
    raise SystemExit(f"expected one Task-0 ancestor: {matches!r}")
text = subprocess.check_output(
    ["git", "-C", wt, "show", f"{matches[0]}:{rel}"], text=True
)
rb = "/* SESSION_DIRECTORY_AUTHORITY_BEGIN:parent-authority-pinned-recorder */"
re_ = "/* SESSION_DIRECTORY_AUTHORITY_END:parent-authority-pinned-recorder */"
ab = "/* SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_BEGIN */"
ae = "/* SESSION_DIRECTORY_PINNED_PARENT_ARTIFACT_END */"
for marker in (rb, re_, ab, ae):
    if text.count(marker) != 1:
        raise SystemExit(f"frozen marker count differs: {marker}")
recorder = text[text.index(rb):text.index(re_) + len(re_)] + "\n"
artifact_region = text[text.index(ab):text.index(ae) + len(ae)]
b64_region = artifact_region.split("concat!(", 1)[1].split(");", 1)[0]
parts = re.findall(r'"([A-Za-z0-9+/=]+)"', b64_region)
artifact = base64.b64decode("".join(parts), validate=True)
hashes = re.findall(r'"([0-9a-f]{64})"', artifact_region)
if len(hashes) != 1 or hashlib.sha256(artifact).hexdigest() != hashes[0]:
    raise SystemExit("frozen embedded artifact hash mismatch")
artifact_value = json.loads(artifact)
inner_begin = "/* SESSION_DIRECTORY_PINNED_PARENT_RECORDER_BEGIN */"
inner_end = "/* SESSION_DIRECTORY_PINNED_PARENT_RECORDER_END */"
inner = recorder[
    recorder.index(inner_begin):recorder.index(inner_end) + len(inner_end)
] + "\n"
if artifact_value.get("recorder_sha256") != hashlib.sha256(
    inner.encode()
).hexdigest():
    raise SystemExit("frozen recorder/artifact hash mismatch")
pathlib.Path(recorder_output).open("xb").write(recorder.encode())
pathlib.Path(artifact_output).open("xb").write(artifact)
PY
}

replay_pinned_parent_authority() {
  local replay_root replay_root_id replay_recorder replay_entrypoint
  local replay_expected replay_actual
  replay_root="$(mktemp -d /tmp/session-directory-parent-replay.XXXXXXXX)" ||
    return 1
  test "$(path_mode "$replay_root")" = 700 || return 1
  replay_root="$(canonical_path "$replay_root")" || return 1
  replay_root_id="$(path_identity "$replay_root")" || return 1
  replay_recorder="$replay_root/pinned-parent-recorder.rs"
  replay_entrypoint="$replay_root/pinned-parent-entrypoint.rs"
  replay_expected="$replay_root/embedded-parent-completed-responses.json"
  replay_actual="$replay_root/replayed-parent-completed-responses.json"
  extract_task0_frozen_recorder_and_artifact \
    "$replay_recorder" "$replay_expected" || return 1
  validate_parent_completed_response_artifact \
    "$replay_expected" "$replay_recorder" || return 1
  capture_parent_artifact_from_recorder \
    "$replay_recorder" "$replay_actual" "$replay_entrypoint" \
    "$replay_root" "$replay_root_id" || return 1
  cmp -- "$replay_expected" "$replay_actual" || return 1
  test "$(canonical_path "$replay_root")" = "$replay_root" || return 1
  test "$(path_identity "$replay_root")" = "$replay_root_id" || return 1
  test ! -e "$replay_entrypoint" || return 1
  rm -- "$replay_actual" "$replay_expected" "$replay_recorder" || return 1
  rmdir "$replay_root"
}

finalize_task0_evidence_after_replay() {
  assert_task0_evidence_owned || return 1
  python3 - "$TASK0_EVIDENCE_ROOT" \
    "$PARENT_RECORDER_BYTES" "$PARENT_AUTHORITY_OUT" \
    "$PARENT_EMBEDDED_DECODED" "$PRESPLIT_SERVER_TESTS" \
    "$POSTSPLIT_SERVER_TESTS" "$PRESPLIT_TEST_MAP" <<'PY'
import os
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
expected = [pathlib.Path(value) for value in sys.argv[2:]]
if len(expected) != 6 or len(set(expected)) != 6:
    raise SystemExit("final evidence allowlist must contain six unique paths")
if any(path.parent != root for path in expected):
    raise SystemExit("final evidence path escaped the owned root")
entries = list(os.scandir(root))
actual_names = [entry.name for entry in entries]
expected_names = [path.name for path in expected]
if len(actual_names) != 6 or set(actual_names) != set(expected_names):
    raise SystemExit(
        f"final evidence root differs: actual={sorted(actual_names)!r} "
        f"expected={sorted(expected_names)!r}"
    )
for entry in entries:
    if entry.is_symlink() or not entry.is_file(follow_symlinks=False):
        raise SystemExit(
            f"final evidence entry is not a regular file: {entry.name}"
        )
PY
  assert_task0_evidence_owned || return 1
  rm -- \
    "$PARENT_RECORDER_BYTES" "$PARENT_AUTHORITY_OUT" \
    "$PARENT_EMBEDDED_DECODED" "$PRESPLIT_SERVER_TESTS" \
    "$POSTSPLIT_SERVER_TESTS" "$PRESPLIT_TEST_MAP" || return 1
  rmdir "$TASK0_EVIDENCE_ROOT" || return 1
  test ! -e "$TASK0_EVIDENCE_ROOT" || return 1
  TASK0_EVIDENCE_OWNED=0
}
```

`extract_active_parent_recorder` additionally requires active `main.rs`,
external `search.rs`, and both transcript fixtures to equal pinned bytes and
normalizes the recorder's three `.layer(...)` calls against pinned `main.rs`.
`validate_parent_provenance` retains the committed-fixture semantic checks.
`create_parent_capture_scratch` also rejects repository/common attributes and
disables hooks, fsmonitor, untracked cache, system/global config, and checkout
filters. These checks are mandatory additions to the shown executable bodies,
not alternative prose-only helpers.

### Complete pre/post-split server-test inventory helpers

The split proves complete compiled binary declaration retention and static
retention of all 68 donor tests, including cfg-gated tests absent on the
implementation host. The exact map is:

```text
session_directory::join_tests::<name> -> session_directory::tests::<name>
session_directory::tests::<core name> -> session_directory::tests::<core name>
session_directory::tests::<route name> -> session_directory::route_tests::<name>
session_directory::tests::<search name> -> session_directory::search_tests::<name>
every non-session-directory binary test -> unchanged
```

The harness definitions are:

```bash
list_all_server_binary_test_declarations() {
  local output line name count=0
  output="$(cargo_server_test debug -- \
    --list --include-ignored --color=never)" || return 1
  while IFS= read -r line; do
    case "$line" in
      *': test')
        name="${line%: test}"
        test -n "$name" || return 1
        printf '%s\n' "$name" || return 1
        count=$((count + 1))
        ;;
    esac
  done <<<"$output"
  test "$count" -gt 0
}

capture_presplit_server_test_inventory() {
  assert_task0_evidence_owned || return 1
  test ! -e "$PRESPLIT_SERVER_TESTS" &&
    test ! -e "$PRESPLIT_TEST_MAP" || return 1
  local declarations
  declarations="$(list_all_server_binary_test_declarations)" || return 1
  printf '%s\n' "$declarations" >"$PRESPLIT_SERVER_TESTS" || return 1
  python3 - "$WT" "$PARENT_SESSION_MONOLITH" \
    "$PRESPLIT_SERVER_TESTS" "$PRESPLIT_TEST_MAP" <<'PY'
import hashlib, json, pathlib, re, sys
wt, monolith_rel, inventory_path, map_path = sys.argv[1:]
monolith = (pathlib.Path(wt) / monolith_rel).read_text(encoding="utf-8")
if monolith.count("mod join_tests") != 1 or monolith.count("mod tests") != 1:
    raise SystemExit("pre-split test modules are absent/ambiguous")
join = [
    "provider_display_name_matches_known_providers_and_falls_back_to_raw",
    "join_running_state_matches_live_terminal_and_sets_running_fields",
    "join_running_state_no_match_leaves_not_running",
    "build_live_terminal_session_item_none_without_a_provider",
    "build_live_terminal_session_item_with_session_id_is_not_live_terminal_only",
    "live_terminal_item_mirrors_identity_subagent_flag",
    "build_live_terminal_session_item_without_session_id_is_live_terminal_only",
    "join_live_terminals_matched_session_yields_one_running_item",
    "join_live_terminals_unmatched_terminal_synthesizes_one_live_only_item",
    "join_live_terminals_matched_terminal_is_never_double_emitted",
    "codex_fresh_terminal_pre_adoption_duplicate_is_transient_pending_locator_adoption",
]
core = [
    "provider_home_ignores_freshell_home_uses_real_home",
    "provider_home_unix_uses_passwd_entry_when_home_and_userprofile_unset",
    "provider_home_unix_ignores_userprofile_when_home_unset",
    "provider_home_unix_treats_empty_home_as_unset_using_passwd_entry",
    "provider_home_unix_prefers_home_and_never_consults_userprofile",
    "provider_home_windows_uses_userprofile_never_home",
    "item_from_meta_maps_fields_and_fallback_session_id",
    "no_uuid_item_falls_back_to_file_basename",
    "invalid_utf8_transcript_is_indexed_lossily_like_node",
    "default_query_hides_non_interactive_fixtures",
    "include_non_interactive_surfaces_titled_session",
    "include_empty_surfaces_untitled_sessions_sorted_desc",
    "r10b_cwdless_repair_fixture_never_surfaces_under_any_flags",
    "title_search_matches_and_annotates",
    "cursor_paging_splits_and_round_trips",
    "invalid_cursor_is_rejected",
    "missing_home_projects_yields_empty_list",
    "missing_priority_is_400_invalid_value",
    "bogus_priority_is_400_same_shape_as_missing",
    "valid_priorities_are_accepted",
    "non_numeric_limit_is_400_invalid_type_nan",
    "empty_limit_string_js_coerces_to_zero_then_too_small",
    "zero_and_negative_limit_are_too_small",
    "oversize_limit_is_too_big",
    "fractional_limit_is_invalid_int",
    "boundary_limit_values_are_accepted",
    "multiple_violations_collect_into_one_details_array_priority_then_limit",
    "badcursor_still_400s_with_original_message_r9_parity_untouched",
]
route = [
    "overrides_overlay_applies_title_summary_archived_and_filters_deleted",
    "overlay_shape_unchanged_when_no_overrides_archived_always_present",
    "provider_generated_session_suppresses_dir_override_row",
    "provider_generated_session_suppresses_first_message_override_row",
    "provider_generated_session_still_applies_ai_override_row",
    "provider_generated_session_still_applies_user_override_row",
    "provider_generated_session_still_applies_absent_source_override_row",
    "empty_string_title_override_never_applies",
    "non_provider_generated_session_still_applies_dir_override_row",
    "suppressed_title_row_still_overlays_summary_and_archived",
    "b_t1_claude_source_matches_list_claude_sessions_reference_scan",
    "b_t7_router_get_session_directory_is_backed_by_the_session_index",
    "session_metadata_session_type_is_joined_onto_directory_items",
    "session_directory_page_embeds_config_project_colors",
    "session_directory_page_omits_project_colors_key_when_empty",
    "b_t8_no_session_index_yields_empty_page",
    "override_no_rebuild",
]
search = [
    "codex_exec_session_hidden_by_default_surfaced_with_flag",
    "session_override_applies_to_codex_and_opencode_keys",
    "global_project_session_reports_real_directory_as_project_path",
    "tier_user_messages_matches_only_the_user_turn",
    "tier_full_text_matches_assistant_turn_too",
    "tier_search_is_case_insensitive",
    "tier_search_empty_no_match_returns_empty_items_without_partial",
    "tier_search_combined_with_cursor_pagination",
    "tier_search_reports_partial_budget_when_scan_budget_exceeded",
    "invalid_tier_value_is_rejected_with_zod_like_400_shape",
    "absent_tier_defaults_to_title",
    "title_tier_search_matches_a_renamed_sessions_override_title",
]
sets = {"join": join, "core": core, "route": route, "search": search}
if [len(join), len(core), len(route), len(search)] != [11, 28, 17, 12]:
    raise SystemExit("static donor set counts differ")
flat = [name for values in sets.values() for name in values]
if len(flat) != 68 or len(set(flat)) != 68:
    raise SystemExit("static donor sets are not disjoint/complete")
def unique_anchor(source: str, anchor: str, label: str) -> int:
    if source.count(anchor) != 1:
        raise SystemExit(f"{label} anchor count differs")
    return source.index(anchor)


join_start = unique_anchor(
    monolith, "#[cfg(test)]\nmod join_tests {", "join start"
)
join_end = unique_anchor(
    monolith,
    "// ── Cursor (base64url of `{lastActivityAt, key}`)",
    "join end",
)
tests_start = unique_anchor(
    monolith, "#[cfg(test)]\nmod tests {", "tests start"
)
overlay_start = unique_anchor(
    monolith, "// ── Task 2: sessionOverrides overlay", "route start"
)
search_start = unique_anchor(
    monolith,
    "// -- Batch C: CodexSource + OpencodeSource wired into the same",
    "search start",
)
if not (join_start < join_end < tests_start < overlay_start < search_start):
    raise SystemExit("pre-split donor anchors are out of order")

donor_ranges = {
    "join": monolith[join_start:join_end],
    "core": monolith[tests_start:overlay_start],
    "route": monolith[overlay_start:search_start],
    "search": monolith[search_start:],
}
pattern = re.compile(
    r"#\s*\[\s*(?:tokio\s*::\s*)?test\s*\]"
    r"(?:\s*#\s*\[[^\]\n]+\]\s*)*\s*"
    r"(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\("
)
attribute_pattern = re.compile(
    r"#\s*\[\s*([A-Za-z_][A-Za-z0-9_:]*)"
)
top_level_macro_pattern = re.compile(
    r"(?m)^    (?:[A-Za-z_][A-Za-z0-9_]*::)*"
    r"[A-Za-z_][A-Za-z0-9_]*!\s*[({\[]"
)
for label, source in donor_ranges.items():
    allowed_attributes = {"cfg", "derive", "test", "tokio::test"}
    unsupported_attributes = [
        name
        for name in attribute_pattern.findall(source)
        if name not in allowed_attributes
    ]
    if unsupported_attributes:
        raise SystemExit(
            f"{label}: unsupported test attributes: {unsupported_attributes!r}"
        )
    top_level_macros = top_level_macro_pattern.findall(source)
    if top_level_macros:
        raise SystemExit(
            f"{label}: unsupported top-level test/macro invocation"
        )
    recognized = pattern.findall(source)
    if recognized != sets[label]:
        raise SystemExit(
            f"{label}: donor inventory differs: "
            f"actual={recognized!r} expected={sets[label]!r}"
        )
raw_declarations = pathlib.Path(inventory_path).read_text(
    encoding="utf-8"
).splitlines()
if (
    not raw_declarations
    or any(not name for name in raw_declarations)
    or len(raw_declarations) != len(set(raw_declarations))
):
    raise SystemExit("compiled pre-split inventory empty/blank/duplicate")
declarations = sorted(raw_declarations)
pathlib.Path(inventory_path).write_text(
    "\n".join(declarations) + "\n", encoding="utf-8"
)
route_set, search_set = set(route), set(search)
mapping = {}
for name in declarations:
    expected = name
    if name.startswith("session_directory::join_tests::"):
        expected = name.replace(
            "session_directory::join_tests::",
            "session_directory::tests::", 1
        )
    elif name.startswith("session_directory::tests::"):
        leaf = name.rsplit("::", 1)[1]
        if leaf in route_set:
            expected = f"session_directory::route_tests::{leaf}"
        elif leaf in search_set:
            expected = f"session_directory::search_tests::{leaf}"
    mapping[name] = expected
if len(set(mapping.values())) != len(mapping):
    raise SystemExit("post-split declaration map has duplicate destinations")
payload = {
    "mapping": mapping,
    "source_sets": sets,
    "pre_count": len(declarations),
    "pre_sha256": hashlib.sha256(
        ("\n".join(declarations) + "\n").encode()
    ).hexdigest(),
}
pathlib.Path(map_path).open("x", encoding="utf-8").write(
    json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n"
)
print(f"pre_count={len(declarations)} pre_sha256={payload['pre_sha256']}")
PY
  assert_task0_evidence_owned
}

verify_postsplit_server_test_inventory() {
  local mode="$1" declarations
  case "$mode" in split-only|task0) ;; *) return 1 ;; esac
  assert_task0_evidence_owned || return 1
  test ! -e "$POSTSPLIT_SERVER_TESTS.next" || return 1
  if test -e "$POSTSPLIT_SERVER_TESTS"; then
    test -f "$POSTSPLIT_SERVER_TESTS" &&
      test ! -L "$POSTSPLIT_SERVER_TESTS" || return 1
  fi
  declarations="$(list_all_server_binary_test_declarations)" || return 1
  printf '%s\n' "$declarations" >"$POSTSPLIT_SERVER_TESTS.next" || return 1
  python3 - "$WT" "$mode" "$PRESPLIT_TEST_MAP" \
    "$POSTSPLIT_SERVER_TESTS.next" <<'PY'
import hashlib, json, pathlib, re, sys
wt, mode, map_path, actual_path = sys.argv[1:]
root = pathlib.Path(wt)
files = {
    "tests": root / "crates/freshell-server/src/session_directory_tests.rs",
    "route": root / "crates/freshell-server/src/session_directory_route_tests.rs",
    "search": root / "crates/freshell-server/src/session_directory_search_tests.rs",
}
if any(not path.is_file() for path in files.values()):
    raise SystemExit("post-split test child missing")
facade = (root / "crates/freshell-server/src/session_directory.rs").read_text()
if "mod join_tests" in facade:
    raise SystemExit("pre-split join wrapper remains")
payload = json.loads(pathlib.Path(map_path).read_text(encoding="utf-8"))
pattern = re.compile(
    r"#\s*\[\s*(?:tokio\s*::\s*)?test\s*\]"
    r"(?:\s*#\s*\[[^\]\n]+\]\s*)*\s*"
    r"(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\("
)
attribute_pattern = re.compile(
    r"#\s*\[\s*([A-Za-z_][A-Za-z0-9_:]*)"
)
top_level_macro_pattern = re.compile(
    r"(?m)^(?:[A-Za-z_][A-Za-z0-9_]*::)*"
    r"[A-Za-z_][A-Za-z0-9_]*!\s*[({\[]"
)


def child_test_names(path: pathlib.Path, label: str) -> list[str]:
    source = path.read_text(encoding="utf-8")
    allowed_attributes = {"cfg", "derive", "test", "tokio::test"}
    unsupported_attributes = [
        name
        for name in attribute_pattern.findall(source)
        if name not in allowed_attributes
    ]
    if unsupported_attributes:
        raise SystemExit(
            f"{label}: unsupported test attributes: {unsupported_attributes!r}"
        )
    if top_level_macro_pattern.search(source):
        raise SystemExit(
            f"{label}: unsupported top-level test/macro invocation"
        )
    return pattern.findall(source)


actual_static = {
    key: child_test_names(path, key)
    for key, path in files.items()
}
expected_static = {
    "tests": payload["source_sets"]["join"] + payload["source_sets"]["core"],
    "route": payload["source_sets"]["route"],
    "search": payload["source_sets"]["search"],
}
for key in expected_static:
    if sorted(actual_static[key]) != sorted(expected_static[key]):
        raise SystemExit(f"post-split static inventory differs: {key}")
if [len(actual_static[k]) for k in ("tests", "route", "search")] != [39, 17, 12]:
    raise SystemExit("post-split static counts differ")
expected = sorted(payload["mapping"].values())
task0 = [
    "session_directory::page_bound_authority_tests::parent_full_application_layers_are_shared_with_production",
    "session_directory::page_bound_authority_tests::parent_authority_case_manifest_has_expected_names_and_count",
    "session_directory::page_bound_authority_tests::parent_raw_owner_backed_full_app_baseline_matches_reviewed_goldens",
    "session_directory::page_bound_authority_tests::task0_owner_full_app_matches_pinned_parent_fixture_authority",
    "session_directory::page_bound_authority_tests::frozen_old_reference_matches_parent_completed_responses",
    "session_directory::page_bound_authority_tests::parent_fixture_models_no_index_and_empty_snapshot_separately",
    "session_directory::page_bound_authority_tests::parent_success_reads_colors_after_derivation_and_error_reads_zero_colors",
    "session_directory::page_bound_authority_tests::parent_owner_identity_acquisition_matches_same_registry_list_first_winner",
    "session_directory::page_bound_authority_tests::task0_legacy_work_ledger_smoke",
]
if mode == "task0":
    expected = sorted(expected + task0)
raw_actual = pathlib.Path(actual_path).read_text(encoding="utf-8").splitlines()
if (
    not raw_actual
    or any(not name for name in raw_actual)
    or len(raw_actual) != len(set(raw_actual))
):
    raise SystemExit("compiled post-split inventory empty/blank/duplicate")
actual = sorted(raw_actual)
pathlib.Path(actual_path).write_text(
    "\n".join(actual) + "\n", encoding="utf-8"
)
if actual != expected:
    raise SystemExit("complete compiled post-split inventory differs")
expected_count = payload["pre_count"] + (9 if mode == "task0" else 0)
if len(actual) != expected_count:
    raise SystemExit("compiled post-split count differs")
print(
    f"post_count={len(actual)} post_sha256="
    + hashlib.sha256(("\n".join(actual) + "\n").encode()).hexdigest()
)
PY
  mv -- "$POSTSPLIT_SERVER_TESTS.next" "$POSTSPLIT_SERVER_TESTS"
  assert_task0_evidence_owned
}
```

The static parser recognizes only ordinary `#[test]` and `#[tokio::test]`
functions and fails on any unrecognized test attribute/macro in the donor
ranges. The Windows-only core test remains in the 68-name static set even when
absent from a Linux Cargo list. A broad green suite never substitutes for this
complete declaration proof.

### Exact audited test inventories

```bash
set -euo pipefail
run_legacy_aggregate() {
  run_audited_debug_prefix "$TEST_LEGACY::legacy_" 33 <<'EOF'
session_directory::page_bound_legacy_tests::legacy_all_eight_visibility_flag_combinations
session_directory::page_bound_legacy_tests::legacy_all_limits_and_cardinality_boundaries
session_directory::page_bound_legacy_tests::legacy_archived_and_metadata_serialization
session_directory::page_bound_legacy_tests::legacy_arbitrary_cursor_position_table
session_directory::page_bound_legacy_tests::legacy_broad_unicode_title_table
session_directory::page_bound_legacy_tests::legacy_cursor_chain_paginates_decorated_corpus
session_directory::page_bound_legacy_tests::legacy_deep_limit_one_chain_and_duplicate_tuple_gaps
session_directory::page_bound_legacy_tests::legacy_default_visibility_filters
session_directory::page_bound_legacy_tests::legacy_deleted_index_and_synth_equal_ties
session_directory::page_bound_legacy_tests::legacy_deleted_session_with_live_terminal_synthesizes
session_directory::page_bound_legacy_tests::legacy_duplicate_equal_tuples_preserve_source_order
session_directory::page_bound_legacy_tests::legacy_duplicate_rows_straddling_page_boundary
session_directory::page_bound_legacy_tests::legacy_empty_filter_precedes_search
session_directory::page_bound_legacy_tests::legacy_full_string_colon_collision_composes_all_joins
session_directory::page_bound_legacy_tests::legacy_identity_missing_components_terminal_fallback_and_collisions
session_directory::page_bound_legacy_tests::legacy_large_live_and_filtered_live_set_table
session_directory::page_bound_legacy_tests::legacy_long_deleted_and_filtered_prefixes
session_directory::page_bound_legacy_tests::legacy_malformed_cursor_table
session_directory::page_bound_legacy_tests::legacy_malformed_metadata_value_table
session_directory::page_bound_legacy_tests::legacy_malformed_override_value_table
session_directory::page_bound_legacy_tests::legacy_negative_and_i64_revision_boundaries
session_directory::page_bound_legacy_tests::legacy_no_index_empty_snapshot_and_color_read_table
session_directory::page_bound_legacy_tests::legacy_ordered_identity_permutations_choose_first_winner
session_directory::page_bound_legacy_tests::legacy_project_color_map_order_composes_with_all_tiers
session_directory::page_bound_legacy_tests::legacy_provider_generated_shadow_guard
session_directory::page_bound_legacy_tests::legacy_query_absent_blank_tier_without_query_and_invalid_request_table
session_directory::page_bound_legacy_tests::legacy_revision_empty_deleted_and_identity_sources
session_directory::page_bound_legacy_tests::legacy_search_override_replacement_and_precedence
session_directory::page_bound_legacy_tests::legacy_title_snippet_scalar_boundaries_139_140_141
session_directory::page_bound_legacy_tests::legacy_trap1_deleted_override_backfills_page
session_directory::page_bound_legacy_tests::legacy_trap1_live_join_rescues_and_merges_synth
session_directory::page_bound_legacy_tests::legacy_trap1_title_override_rescues_boundary_row
session_directory::page_bound_legacy_tests::legacy_whitespace_title_and_query_semantics
EOF
}

run_g1_aggregate() {
  run_audited_debug_prefix "$TEST_G1::g1_" 21 <<'EOF'
session_directory::page_bound_g1_tests::g1_all_eight_flags_old_materialized_fast
session_directory::page_bound_g1_tests::g1_all_limits_and_cardinalities_old_materialized_fast
session_directory::page_bound_g1_tests::g1_arbitrary_and_malformed_cursors_old_materialized_fast
session_directory::page_bound_g1_tests::g1_broad_unicode_and_long_text_old_materialized_fast
session_directory::page_bound_g1_tests::g1_completed_full_app_route_matrix_matches_parent
session_directory::page_bound_g1_tests::g1_completed_strategy_matrix_old_extracted_fast
session_directory::page_bound_g1_tests::g1_deep_limit_one_chain_old_materialized_fast
session_directory::page_bound_g1_tests::g1_deleted_synth_ties_old_materialized_fast
session_directory::page_bound_g1_tests::g1_duplicate_equal_and_colon_collision_old_materialized_fast
session_directory::page_bound_g1_tests::g1_exhaustive_small_state_old_materialized_fast
session_directory::page_bound_g1_tests::g1_fast_deleted_override_backfills_page_old_materialized_fast
session_directory::page_bound_g1_tests::g1_i64_revision_boundaries_old_materialized_fast
session_directory::page_bound_g1_tests::g1_identity_missing_components_terminal_fallback_old_materialized_fast
session_directory::page_bound_g1_tests::g1_large_live_sets_old_materialized_fast
session_directory::page_bound_g1_tests::g1_long_prefixes_old_materialized_fast
session_directory::page_bound_g1_tests::g1_malformed_override_metadata_old_materialized_fast
session_directory::page_bound_g1_tests::g1_noindex_empty_success_error_colors_old_materialized_fast
session_directory::page_bound_g1_tests::g1_ordered_identity_permutations_old_materialized_fast
session_directory::page_bound_g1_tests::g1_project_color_map_order_completed_routes
session_directory::page_bound_g1_tests::g1_query_absent_blank_and_tier_without_query_old_materialized_fast
session_directory::page_bound_g1_tests::g1_title_snippet_scalar_boundaries_old_materialized_fast
EOF
}

run_g2_aggregate() {
  run_audited_debug_prefix "$TEST_G2::g2_" 18 <<'EOF'
session_directory::page_bound_g2_tests::g2_candidate_source_has_no_direct_dir_item_literal
session_directory::page_bound_g2_tests::g2_fast_region_has_no_clone_or_indirect_full_row_construction
session_directory::page_bound_g2_tests::g2_full_row_constructor_inventory_is_exact_and_instrumented
session_directory::page_bound_g2_tests::g2_no_query_all_filtered_large_live_set_builds_zero_items
session_directory::page_bound_g2_tests::g2_no_query_duplicate_and_cursor_filtered_synths_build_only_returned_rows
session_directory::page_bound_g2_tests::g2_no_query_indexed_work_table_is_exact
session_directory::page_bound_g2_tests::g2_no_query_lookahead_descriptor_is_never_constructed
session_directory::page_bound_g2_tests::g2_no_query_mixed_indexed_and_synth_work_is_exact
session_directory::page_bound_g2_tests::g2_no_query_synth_work_table_is_exact
session_directory::page_bound_g2_tests::g2_one_returned_row_with_500_identities_has_zero_full_row_clones
session_directory::page_bound_g2_tests::g2_title_early_dense_matches_build_only_returned_rows
session_directory::page_bound_g2_tests::g2_title_late_sparse_matches_scan_but_build_only_returned_rows
session_directory::page_bound_g2_tests::g2_title_long_ascii_fields_are_exact
session_directory::page_bound_g2_tests::g2_title_mixed_indexed_and_synth_work_is_exact
session_directory::page_bound_g2_tests::g2_title_no_match_builds_zero_rows
session_directory::page_bound_g2_tests::g2_title_non_ascii_expansion_table_is_exact
session_directory::page_bound_g2_tests::g2_title_post_selection_has_no_rejection_path
session_directory::page_bound_g2_tests::g2_title_synth_matches_build_only_selected_rows
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
- Modify/split: `crates/freshell-server/src/session_directory.rs`,
  `session_directory_materialized.rs`, `session_directory_tests.rs`,
  `session_directory_route_tests.rs`, `session_directory_search_tests.rs`,
  `session_directory_inputs.rs`, `session_directory_page_bound_support.rs`,
  `session_directory_page_bound_authority_fixtures.rs`, and
  `session_directory_page_bound_authority_tests.rs`.
- Modify only the assembler/call: `crates/freshell-server/src/main.rs`.
- Read/freeze unchanged: `crates/freshell-sessions/src/search.rs`.

**Forbidden:** changing behavior while splitting, extracting the handler
derivation, changing capture order, adding Fast code/selector behavior, changing
shared source, or allowing changed code to generate expected parent bytes.

**Interfaces produced:** the pinned-parent recorder and canonical embedded
artifact; Task-0 capture/renderer/completed-response interfaces; manual
instrumented `DirItem::Clone`; immutable explicit manifest whose count derives
from `EXPECTED_PARENT_CASE_NAMES`; focused child modules; authority markers; and
`with_full_application_layers`.

The following ordering is load-bearing and supersedes any narrower wording in
the detailed substeps:

1. Run the pinned baseline.
2. Add only the exact append-only `#[cfg(test)]` recorder region to the active
   parent-compatible monolith; statically prove append-only compatibility and
   record recorder SHA-256, parent tree, and seven blob IDs.
3. In a fresh uniquely owned detached parent worktree, append that exact recorder
   and only the ignored
   `emit_pinned_parent_completed_responses` entrypoint. Prove no other tracked
   delta, then execute exactly one ignored binary test under `timeout`,
   `unshare --user --map-root-user --net`, `env -i`, `CARGO_NET_OFFLINE=true`,
   owned empty home/provider roots, and an owned target directory. The invocation
   must pass through `run_cargo_test_success 1`.
4. Canonicalize and validate
   `PARENT_COMPLETED_RESPONSE_AUTHORITY_V1`: exact schema, commit/tree/seven
   blobs, recorder/manifest hashes, 22 ordered names, exact 21-name comparable
   projection, unique input hashes, exchange arrays, statuses, exact normalized
   content type, base64 bodies, canonical bytes, and one trailing LF.
5. Remove the exact appended suffix by byte assertion, require the parent
   scratch clean, remove it non-forcibly, and retain the artifact/recorder under
   the owned evidence root until post-commit replay.
6. Perform the behavior-neutral module/test split in **Focused Rust Module
   Boundary**, moving recorder bytes without reformatting; run the existing
   server tests, formatter, Clippy, and
   `assert_max_1000_lines "${SD_TASK0_FILES[@]}"`.
7. Mechanically install the captured artifact in
   `session_directory_page_bound_authority_fixtures.rs`; decode the embedded
   constant and `cmp` it byte-for-byte with the capture.
8. Write the existing nine Task-0 tests against that artifact. Exactly one shared
   support wrapper references absent `crate::with_full_application_layers`, so
   the missing-assembler compile RED occurs exactly once.
9. Run that RED, then implement only the minimal
   assembler/renderer/FrozenOld/ledger machinery with handler derivation inline.
10. Run the nine-test GREEN, broader checks, path-aware static/runtime authority
    guards, and line gate.
11. Commit the exact ten-path Task-0 set plus `main.rs`.
12. Replay the frozen recorder from a fresh owned parent worktree, compare replay
    byte-for-byte with the decoded embedded artifact, record evidence, then
    remove only exact named evidence files and empty owned directories.

The complete binary-scoped recorder command, build-root lifecycle, validator,
suffix restoration, guarded cleanup, installation, and replay are defined once
in the pre-Task-0 execution harness. The task steps below invoke those helpers;
no free-standing command owns undefined state.

- [ ] **Step 1: Pin provenance and establish the scoped baseline**

```bash
set -euo pipefail
PARENT=fc8646477dd34d92dc5647d158106431aa2e0380
PARENT_SESSION_MONOLITH=crates/freshell-server/src/session_directory.rs

test "$(git -C "$WT" merge-base HEAD "$PARENT")" = "$PARENT"
git -C "$WT" diff --exit-code "$PARENT" -- \
  "$PARENT_SESSION_MONOLITH" \
  crates/freshell-server/src/main.rs \
  crates/freshell-sessions/src/search.rs
run_shared_comment_guard
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
init_task0_evidence_root
capture_presplit_server_test_inventory
```

Expected GREEN: pinned source equality, shared-comment immutability, the
existing broad baseline, and pre-split test-inventory capture return zero. No
future sibling is read and no Task-0 ancestor is looked up. If the baseline is
not green, stop before changing Rust and report the exact failing command/output;
do not redefine the baseline.

- [ ] **Step 2: Capture the canonical pinned-parent responses before any production edit or split**

```bash
set -euo pipefail
test "${TASK0_EVIDENCE_OWNED:-0}" = 1
assert_task0_evidence_owned

# Author only the exact append-only cfg(test) recorder region in the active
# parent-compatible monolith. No production/split/ledger/Clone/authority-test edit.
_assert_git_scope preflight "$PARENT_SESSION_MONOLITH"
extract_active_parent_recorder
capture_pinned_parent_authority

test -s "$PARENT_RECORDER_BYTES"
test -s "$PARENT_AUTHORITY_OUT"
validate_parent_completed_response_artifact \
  "$PARENT_AUTHORITY_OUT" "$PARENT_RECORDER_BYTES"
```

Expected GREEN: the active source differs from the pinned parent only by the
exact recorder region; a fresh parent scratch runs exactly one ignored test
offline in a new network namespace; `$PARENT_AUTHORITY_OUT` is the canonical
22-case/21-comparable raw-response artifact; the exact suffix is removed; the
parent scratch returns clean and is removed non-forcibly; and recorder/artifact
evidence remains owned for split, installation, replay, and finalization.

The exact Git blobs and committed fixture bytes are provenance and
reproducibility inputs only. The response authority is the canonical raw
completed-response artifact emitted by the one ignored in-process
`Router::oneshot` parent test in an offline network namespace. If any
provenance/fixture expectation changes, stop for re-review; never fall back to
launching the network-capable production binary.

Every reviewed owner raw result must be independent of registry iteration order;
where the selected winner is serialized, the fixture uses exactly one matching
identity. The A/B and B/A vectors belong only to fixed captures.

- [ ] **Step 3: Split mechanically, install the artifact, then write Task-0 tests**

Perform the exact focused split before adding Task-0 behavior. Move the recorder
bytes unchanged, run the structural GREEN and line gate, mechanically embed and
decode the already captured artifact, and require `cmp` equality. Whole-file
test children and direct `#[path]` declarations are the test boundary.

Immediately after imports/visibility normalization, before artifact
installation or new Task-0 tests, run:

```bash
set -euo pipefail
verify_postsplit_server_test_inventory split-only
run_exact_debug \
  'session_directory::tests::invalid_utf8_transcript_is_indexed_lossily_like_node'
run_server_all_targets
run_fmt_check
run_clippy
assert_max_1000_lines "${SD_TASK0_FILES[@]}"
```

This checkpoint is GREEN-only and is the first applicable line gate. It proves
complete declaration retention, the historical exact command path, broad
behavior, formatting/linting, and line compliance before new behavior machinery.
Then install only the already captured bytes:

```bash
install_captured_parent_authority
cmp -- "$PARENT_AUTHORITY_OUT" "$PARENT_EMBEDDED_DECODED"
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

One shared authority support wrapper calls
`crate::with_full_application_layers` exactly once, and all Task-0 tests call
that wrapper. The
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

`task0_owner_full_app_matches_pinned_parent_fixture_authority` verifies the
embedded artifact's commit/tree/blob/recorder/manifest/artifact hashes and
fixture semantics and locates the four fixture-derived cases in that same
artifact. `parent_raw_owner_backed_full_app_baseline_matches_reviewed_goldens`
retains its historical name, but `goldens` means the embedded pre-edit artifact:
execute all 22 current-owner cases through production layers and compare every
ordered exchange directly. FrozenOld executes the exact 21 comparable cases and
compares directly. No separate raw table or post-change response emitter exists.

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
    run_exact_debug "$TEST_AUTH::$name" || return 1
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
verify_postsplit_server_test_inventory task0
run_exact_debug \
  'session_directory::tests::invalid_utf8_transcript_is_indexed_lossily_like_node'
assert_max_1000_lines "${SD_TASK0_FILES[@]}"
run_task0_precommit_guard
```

Expected GREEN: all nine focused tests pass; the complete old-test declaration
map still matches; the retained historical exact test executes once; all broad
checks pass; all phase-0 files exist and meet the line gate; the embedded
artifact is structurally valid; and current owner plus FrozenOld compare
directly to it. No subject-anchored Task-0 freeze check runs before commit.

- [ ] **Step 8: Commit and freeze**

```bash
set -euo pipefail
commit_exact_scope \
  'test(session-directory): freeze parent response authority' \
  crates/freshell-server/src/session_directory.rs \
  crates/freshell-server/src/session_directory_materialized.rs \
  crates/freshell-server/src/session_directory_tests.rs \
  crates/freshell-server/src/session_directory_route_tests.rs \
  crates/freshell-server/src/session_directory_search_tests.rs \
  crates/freshell-server/src/session_directory_inputs.rs \
  crates/freshell-server/src/session_directory_page_bound_support.rs \
  crates/freshell-server/src/session_directory_page_bound_authority_fixtures.rs \
  crates/freshell-server/src/session_directory_page_bound_authority_tests.rs \
  crates/freshell-server/src/main.rs
run_task0_guard
replay_pinned_parent_authority
finalize_task0_evidence_after_replay
```

The replay uses a fresh owned parent worktree/build root, the frozen recorder
bytes, the same ignored entrypoint and isolated command, and the same canonical
validator. It must byte-compare replay with the decoded embedded artifact before
exact evidence cleanup.

### Task 1: Extract and separately freeze the Materialized strategy

**Files:**
- Modify: facade, `session_directory_inputs.rs`,
  `session_directory_materialized.rs`, and
  `session_directory_page_bound_authority_tests.rs`.

**Precondition:** clean worktree; `run_task0_guard` passes.

**Interfaces produced:** `OwnedIndexCapture`, `OwnedDirectoryInputs`,
`capture_directory_inputs`, `DirectoryStrategy`, `materialized_page`,
`materialized_dispatch`, and `build_directory_page` as declared above.

- [ ] **Step 1: Write the exact extraction/capture tests first**

Run full `run_task0_guard` before writing the compile-failing test. Once the
unresolved `materialized_page` reference exists, use only
`run_task0_static_guard` until the declared compile RED; full runtime guards
resume at GREEN/commit boundaries.

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
run_task0_static_guard
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
    run_exact_debug "$TEST_AUTH::$name" || return 1
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
run_exact_debug "$TEST_AUTH::parent_raw_owner_backed_full_app_baseline_matches_reviewed_goldens"
run_exact_debug "$TEST_AUTH::task0_owner_full_app_matches_pinned_parent_fixture_authority"
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_task0_guard
assert_max_1000_lines "${SD_TASK0_FILES[@]}"
```

Expected GREEN: the same focused tests, parent raw fixture, and all broader
commands return zero without changing Task-0 regions.

- [ ] **Step 6: Commit and freeze the second authority**

```bash
set -euo pipefail
commit_exact_scope \
  'refactor(session-directory): extract frozen materialized strategy' \
  crates/freshell-server/src/session_directory.rs \
  crates/freshell-server/src/session_directory_inputs.rs \
  crates/freshell-server/src/session_directory_materialized.rs \
  crates/freshell-server/src/session_directory_page_bound_authority_tests.rs
run_both_guards
```

### Task 2: Characterize every reusable legacy equivalence fixture

**Files:** facade, page-bound support, and
`session_directory_page_bound_legacy_tests.rs`.

**Interfaces produced:** deterministic fixture constructors reused by G1/G2/G3;
no production symbol.

This is evidence-only: add each `legacy_` test before changing its fixture
helper and run it exactly. If current behavior differs from an expectation,
record actual frozen legacy behavior; never change production or either
authority or artifact bytes here. Any discrepancy is a hard rebaseline stop.

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
run_exact_debug "$TEST_AUTH::parent_raw_owner_backed_full_app_baseline_matches_reviewed_goldens"
run_exact_debug "$TEST_AUTH::task0_owner_full_app_matches_pinned_parent_fixture_authority"
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_both_guards
assert_max_1000_lines "${SD_TASK2_FILES[@]}"
commit_exact_scope \
  'test(session-directory): characterize reusable legacy equivalence cases' \
  crates/freshell-server/src/session_directory.rs \
  crates/freshell-server/src/session_directory_page_bound_support.rs \
  crates/freshell-server/src/session_directory_page_bound_legacy_tests.rs
```

GREEN criteria: exact 33-test inventory passes and authorities are unchanged.

### Task 3: Add borrowed matching and carried title decisions

**Files:**
- Modify facade, `session_directory_fast.rs`, and
  `session_directory_page_bound_g2_tests.rs`.

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
    run_exact_debug "$TEST_G2::$name" || return 1
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
assert_max_1000_lines "${SD_TASK3_FILES[@]}"
commit_exact_scope \
  'feat(session-directory): add borrowed matching decisions' \
  crates/freshell-server/src/session_directory.rs \
  crates/freshell-server/src/session_directory_fast.rs \
  crates/freshell-server/src/session_directory_page_bound_g2_tests.rs
```

### Task 4: Add the no-query Fast candidate, still undispatched

**Files:** facade, inputs, fast, page-bound support, source-audit, G2-tests, and
G1-tests, all outside authorities.

**Interfaces produced:** descriptor/merge/materialization/forced-strategy
interfaces, `candidate_is_deleted`, and the all-Materialized selector exactly as
declared.

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
| `g2_no_query_mixed_indexed_and_synth_work_is_exact` | N=49 visible indexed `claude:idx-{timestamp}` rows, one for every even `last_activity_at` in the inclusive range 104..=200; two unsuppressed, provider-bearing, otherwise noncolliding synths `claude:synth-mid` at 151 and `claude:synth-tail` at 1; no query or cursor; T=2, limit 50, flags 111. Independently expect the descending indexed timestamps 200 through 152, then `claude:synth-mid` at ordinal 26, then descending indexed timestamps 150 through 104. Before generic equality/audit assertions, directly assert the complete expected key vector with `synth-mid` at ordinal 26 and `idx-104` last (therefore fixing the cursor) using `SESSION_DIRECTORY_MUTATION_KILL:defer-synth-on-greater`. Assert exact key order, the exact legacy cursor encoding of `(104, "claude:idx-104")`, revision 200, and `claude:synth-tail` as descriptor 51/lookahead only. Assert 49 indexed + 1 synth returned, 49 of each indexed stage, one synth constructor, 50 serializations, zero title/clones. |
| `g2_no_query_duplicate_and_cursor_filtered_synths_build_only_returned_rows` | N=2, ordered T=51 containing same-full-key first-winner duplicates, colon-colliding tuples, synths before/on/after an arbitrary cursor; limit 2. Assert exact two post-cursor winner keys/terminal IDs and construct only their independently known provenance; all duplicate/prefix/lookahead descriptors remain unconstructed. |
| `g2_no_query_lookahead_descriptor_is_never_constructed` | N=51 visible indexed rows, T=0, limit 50. Before broader equations, directly assert the exact returned-row work tuple—especially `indexed_full == 50` and `item_serialization == 50`—using `SESSION_DIRECTORY_MUTATION_KILL:construct-lookahead`. Assert 50 returned, nonnull cursor from row 50, and exactly 50 indexed constructions/decorations/serializations—not 51. |
| `g2_candidate_source_has_no_direct_dir_item_literal` | Call `let audit = audit_fast_dir_item_production_contract(FAST_AUDIT_SOURCES);`; require exact producer/helper sets and no violations. Before the generic empty-violations assertion, directly assert the focused direct-construction violation subset is empty using `SESSION_DIRECTORY_MUTATION_KILL:direct-dir-item-literal`. Specifically assert its tokenized Fast region reports zero direct construction tokens outside the two marked producer bodies reached through `materialize_selected_descriptor`. Ordinary `DirItem` references and the two allowed helper return declarations do not count as construction. |
| `g2_fast_region_has_no_clone_or_indirect_full_row_construction` | Call `let audit = audit_fast_dir_item_production_contract(FAST_AUDIT_SOURCES);`; require no clone token anywhere in the Fast/helper regions, no producer call outside `materialize_selected_descriptor`, no unknown `DirItem`-returning declaration/call, and a recursively closed helper graph of `materialize -> {indexed,synth}` and `annotate -> {}`. This is the sole interpretation of “indirect”; no adjacent broader return-type ban exists. |
| `g2_full_row_constructor_inventory_is_exact_and_instrumented` | Call `let audit = audit_fast_dir_item_production_contract(FAST_AUDIT_SOURCES);`; assert exactly the three producer markers, exactly the two helper markers, exactly one manual `impl Clone for DirItem`, and the matching bump helper in each producer. Before the generic complete-violations assertion, directly assert the focused `{unknown DirItem-returning helper, clone violation}` subset is empty using `SESSION_DIRECTORY_MUTATION_KILL:indirect-full-row-constructor`. The compile-valid unmarked `uninstrumented_full_row_copy` mutation returns `DirItem` and clones, so it necessarily appears as both an unknown returning helper and a clone violation and this exact test kills it. |
| `g2_one_returned_row_with_500_identities_has_zero_full_row_clones` | N=1 indexed row; T=500 ordered identities all exact-component-match that row; limit 50, flags 111. Before broader equations, directly assert `full_row_clone == 0` using `SESSION_DIRECTORY_MUTATION_KILL:clone-per-identity`. Assert one indexed row/first terminal winner, no synth, one of each indexed stage/serialization, and zero clones. The compile-valid mutation must leave response bytes unchanged while making `full_row_clone == 500`. |

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
pub(super) const FAST_AUDIT_SOURCES: &[(&str, &str)] = &[
    (
        "materialized",
        include_str!("session_directory_materialized.rs"),
    ),
    ("fast", include_str!("session_directory_fast.rs")),
];

#[cfg(all(test, debug_assertions))]
pub(super) fn audit_fast_dir_item_production_contract(
    sources: &[(&str, &str)],
) -> FastDirItemProductionAudit;
```

The implementation includes source names in every violation and requires marker
uniqueness across the bundle. It uses the
lexical/marker rules in the named-work contract,
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

Strengthen existing fixtures without adding/renaming tests:

- `legacy_deleted_session_with_live_terminal_synthesizes` uses indexed key `K`,
  typed deletion plus sentinel decorations, and a same-key live identity; it
  expects exactly one Synth-provenance running row with identity
  terminal/time/cwd, provider-display/default fields, and no override sentinels.
- `legacy_deleted_index_and_synth_equal_ties` deletes every duplicate exact-tuple
  indexed row and supplies a same-key equal-timestamp identity; it expects no
  Indexed rows and exactly one first-winner Synth.
- `g1_deleted_synth_ties_old_materialized_fast` reuses both fixtures, asserts
  independent item/provenance expectations and
  FrozenOld == ExtractedMaterialized == Fast values plus direct renderer bytes,
  for no-query and matching nonempty Title subcases in the same top-level test.

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
if candidate_is_deleted(candidate, overrides) {
    continue;
}
```

Implement `candidate_is_deleted` exactly once in
`session_directory_fast.rs`: Indexed delegates to
`is_deleted(overrides, &indexed.key())`; Synth returns false. FrozenOld deletes
indexed rows before live synthesis, so a same-key live Synth survives and
receives no override decoration. Suppression still uses every nondeleted
indexed full key.

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
  run_exact_debug "$TEST_G2::g2_no_query_indexed_work_table_is_exact" || return 1
  run_exact_debug "$TEST_G2::g2_no_query_synth_work_table_is_exact" || return 1
  run_exact_debug "$TEST_G2::g2_no_query_all_filtered_large_live_set_builds_zero_items" || return 1
  run_exact_debug "$TEST_G2::g2_no_query_mixed_indexed_and_synth_work_is_exact" || return 1
  run_exact_debug "$TEST_G2::g2_no_query_duplicate_and_cursor_filtered_synths_build_only_returned_rows" || return 1
  run_exact_debug "$TEST_G2::g2_no_query_lookahead_descriptor_is_never_constructed" || return 1
  run_exact_debug "$TEST_G2::g2_candidate_source_has_no_direct_dir_item_literal" || return 1
  run_exact_debug "$TEST_G2::g2_fast_region_has_no_clone_or_indirect_full_row_construction" || return 1
  run_exact_debug "$TEST_G2::g2_full_row_constructor_inventory_is_exact_and_instrumented" || return 1
  run_exact_debug "$TEST_G2::g2_one_returned_row_with_500_identities_has_zero_full_row_clones" || return 1
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
run_exact_debug "$TEST_G1::dispatch_all_shapes_are_materialized_before_gates"
assert_max_1000_lines "${SD_TASK4_FILES[@]}"
commit_exact_scope \
  'perf(session-directory): add page-bounded no-query candidate' \
  crates/freshell-server/src/session_directory.rs \
  crates/freshell-server/src/session_directory_inputs.rs \
  crates/freshell-server/src/session_directory_fast.rs \
  crates/freshell-server/src/session_directory_page_bound_support.rs \
  crates/freshell-server/src/session_directory_page_bound_source_audit.rs \
  crates/freshell-server/src/session_directory_page_bound_g2_tests.rs \
  crates/freshell-server/src/session_directory_page_bound_g1_tests.rs
```

Expected GREEN: the same focused and broader checks pass and production remains
all Materialized.

### Task 5: Add the title Fast candidate, still undispatched

**Files:** fast, page-bound support, source-audit, and G2-tests.

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
| `g2_title_post_selection_has_no_rejection_path` | N=51 with selected matches distributed across title/summary/first-message and one descriptor lookahead; limit 50. Assert exactly 50 rows and a cursor fixed by row 50. Before any generic audit assertion, directly assert that the post-selection materialization region contains no `apply_title_search` call and no rejecting `continue`/filter path using `SESSION_DIRECTORY_MUTATION_KILL:recompute-title-and-skip`; the same assertion may retain `RED_TITLE_FAST_PATH_MUST_USE_CARRIED_DECISION` before Task-5 implementation. Source-audit the materialization region: carried `TitleMatchField` annotation exists exactly once and no `apply_title_search`, `filter`, `filter_map`, rejecting `match`, or `continue` occurs after selection. |

The late-sparse override-only matches are mandatory dataflow evidence that Title
selection receives `inputs.overrides`; they complement Task 4's override-effective
nonempty visibility cases.

- [ ] **Step 2: Verify RED**

```bash
set -euo pipefail
expect_exact_debug_failure \
  "$TEST_G2::g2_title_post_selection_has_no_rejection_path" \
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
  run_exact_debug "$TEST_G2::g2_title_post_selection_has_no_rejection_path" || return 1
  run_exact_debug "$TEST_G2::g2_title_early_dense_matches_build_only_returned_rows" || return 1
  run_exact_debug "$TEST_G2::g2_title_late_sparse_matches_scan_but_build_only_returned_rows" || return 1
  run_exact_debug "$TEST_G2::g2_title_no_match_builds_zero_rows" || return 1
  run_exact_debug "$TEST_G2::g2_title_long_ascii_fields_are_exact" || return 1
  run_exact_debug "$TEST_G2::g2_title_non_ascii_expansion_table_is_exact" || return 1
  run_exact_debug "$TEST_G2::g2_title_mixed_indexed_and_synth_work_is_exact" || return 1
  run_exact_debug "$TEST_G2::g2_title_synth_matches_build_only_selected_rows" || return 1
  run_exact_debug "$TEST_G2::post_selection_title_field_drift_fails_closed" || return 1
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
run_exact_debug "$TEST_G1::dispatch_all_shapes_are_materialized_before_gates"
assert_max_1000_lines "${SD_TASK4_FILES[@]}"
commit_exact_scope \
  'perf(session-directory): add page-bounded title candidate' \
  crates/freshell-server/src/session_directory_fast.rs \
  crates/freshell-server/src/session_directory_page_bound_support.rs \
  crates/freshell-server/src/session_directory_page_bound_source_audit.rs \
  crates/freshell-server/src/session_directory_page_bound_g2_tests.rs
```

### Task 6: Commit complete G1 and compile-valid mutation killers

**Files:** page-bound support and G1-tests only.

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
comparing every current-owner exchange sequence directly with the embedded
artifact. The fixed A/B and B/A subcases are not in
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

The G1 and selector killers place mutation-specific direct observations before
generic three-strategy/completed-response equality:

- `g1_duplicate_equal_and_colon_collision_old_materialized_fast` has independent
  equal-time and colon-composition subcases. They directly assert Fast's
  descending full-key vector with
  `SESSION_DIRECTORY_MUTATION_KILL:reverse-full-key-order`, and the legacy
  full-string-collision membership/winner vector with
  `SESSION_DIRECTORY_MUTATION_KILL:tuple-dedupe`.
- `g1_arbitrary_and_malformed_cursors_old_materialized_fast` directly asserts
  the strict exact-on-row/equal-timestamp post-cursor suffix using
  `SESSION_DIRECTORY_MUTATION_KILL:cursor-inclusive`.
- `g1_fast_deleted_override_backfills_page_old_materialized_fast` directly
  asserts the exact backfilled Fast page after head/middle/tail deletion using
  `SESSION_DIRECTORY_MUTATION_KILL:deletion-after-selection`.
- `g1_ordered_identity_permutations_old_materialized_fast` consolidates the two
  Fast winners and directly asserts `["terminal-a", "terminal-b"]` for A→B and
  B→A using `SESSION_DIRECTORY_MUTATION_KILL:choose-last-identity`.
- `g1_i64_revision_boundaries_old_materialized_fast` has independent
  identity-maximum and deleted-head subcases. They directly assert the exact
  revision using `SESSION_DIRECTORY_MUTATION_KILL:omit-identity-revision` and
  `SESSION_DIRECTORY_MUTATION_KILL:use-deleted-index-head-revision`.
- `g1_all_eight_flags_old_materialized_fast` has three
  classification-isolated sentinels and directly asserts inclusion vectors
  across each false/true flag using
  `SESSION_DIRECTORY_MUTATION_KILL:invert-subagent-filter`,
  `SESSION_DIRECTORY_MUTATION_KILL:invert-noninteractive-filter`, and
  `SESSION_DIRECTORY_MUTATION_KILL:invert-empty-filter`.
- `dispatch_nonempty_user_messages_and_full_text_are_materialized` consolidates
  both nonempty file-tier results and directly asserts
  `[Materialized, Materialized]` using
  `SESSION_DIRECTORY_MUTATION_KILL:route-file-tier-fast`.

Each exact marker is the custom message on one direct assertion, appears in no
fixture or diagnostic print, and is emitted before a generic assertion that the
same mutant could trip.

```bash
set -euo pipefail
run_g1_aggregate
run_legacy_aggregate
run_exact_debug "$TEST_G1::dispatch_nonempty_user_messages_and_full_text_are_materialized"
run_exact_debug "$TEST_G1::dispatch_tier_without_query_is_no_query_branch"
run_exact_debug "$TEST_G1::dispatch_blank_query_is_no_query_branch"
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_both_guards
assert_max_1000_lines "${SD_TASK4_FILES[@]}"
commit_exact_scope \
  'test(session-directory): commit complete compatibility and mutation-killer gates' \
  crates/freshell-server/src/session_directory_page_bound_support.rs \
  crates/freshell-server/src/session_directory_page_bound_g1_tests.rs
load_validated_task6_mutation_base
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
(3) list its exact killer once, (4) make Cargo exit exactly 101 with the selected
test as the sole failed test, the mutation-specific marker exactly once inside
that test's failure-detail block and globally, an exact one-name failure list,
and exactly one strict `0 passed; 1 failed; 0 ignored; 0 measured` libtest
summary, and (5) restore only the disposable scratch file to the committed
scratch base. Compilation failure, an unrelated panic, or an arbitrary nonzero
exit is invalid setup, never a kill.

Each scratch lives under a fresh private mode-`0700` temp root. Ownership becomes
true only after exact NUL-safe registration/path/detached-HEAD/clean/root/
worktree/gitdir identity checks. Mutation, Cargo, every status read and restore,
and non-forced removal revalidate that captured identity. Partial, dirty,
replaced, reused, locked/prunable, or otherwise ambiguous state is preserved and
fails closed; HEAD equality alone never proves ownership.

A surviving mutation permits a test-only Task-6 amendment through the exact
amend guard below, followed by recreation and a full mutation rerun. A real
candidate defect returns to Task 4/5 and replays subsequent commits.

### Task 8: Audit G2 and run finite release G3 before routing

**Files:** facade, page-bound support, and G3-tests.

The 18 G2 tests already exist from Tasks 4/5. Add only the explicit G3 manifest
and `adverse_release_ab_non_regression`; do not change production. A G2/G3
production defect returns to Task 4/5.

The G3 declaration is exactly:

```rust
#[test]
#[ignore = "finite full-app release A/B gate; run explicitly in release"]
fn adverse_release_ab_non_regression() {
    assert!(
        !cfg!(debug_assertions),
        "G3_RELEASE_PROFILE_REQUIRED: run the ignored gate with --release",
    );
    assert_g3_integer_statistics_contract();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build G3 Tokio runtime");

    runtime.block_on(async {
        let expected_names = EXPECTED_G3_CASE_NAMES;
        let cases = g3_release_cases();
        let actual_names: Vec<_> = cases.iter().map(|case| case.name).collect();
        assert_eq!(
            actual_names.as_slice(),
            expected_names,
            "G3 generated manifest must equal the explicit ordered name manifest",
        );

        for case in &cases {
            run_g3_release_case(case).await;
        }

        println!(
            "G3_MANIFEST_RESULT cases={} measured_pairs_per_case={} result=PASS",
            expected_names.len(),
            MEASURED_PAIRS,
        );
    });
}
```

The ignore is load-bearing: broad debug compiles but skips G3; explicit release
calls use `--ignored` and require exactly one passed Rust test.

```bash
set -euo pipefail
run_g2_aggregate
run_g1_aggregate
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_both_guards
run_g3_release_gate
assert_max_1000_lines "${SD_TASK8_FILES[@]}"
commit_exact_scope \
  'test(session-directory): add exact work and finite adverse release gates' \
  crates/freshell-server/src/session_directory.rs \
  crates/freshell-server/src/session_directory_page_bound_support.rs \
  crates/freshell-server/src/session_directory_page_bound_g3_tests.rs
```

This is the only pre-switch full G3. Its exact manifest/statistics are below.

### Task 9: Switch no-query in one selector-only commit

**Files:** selector only in fast and its dedicated test only in G1-tests.

- [ ] **Step 1: Write the production selector test first**

`production_dispatch_routes_no_query_fast` must fail with marker
`RED_NO_QUERY_SELECTOR_STILL_MATERIALIZED` before the selector edit.

```bash
set -euo pipefail
expect_exact_debug_failure \
  "$TEST_G1::production_dispatch_routes_no_query_fast" \
  RED_NO_QUERY_SELECTOR_STILL_MATERIALIZED
```

- [ ] **Step 2: Minimal GREEN**

Change only `(false, _)` to Fast. Nonempty Title and both file tiers remain
Materialized.

```bash
set -euo pipefail
run_exact_debug "$TEST_G1::production_dispatch_routes_no_query_fast"
```

- [ ] **Step 3: Refactor selector expression only, rerun, and commit**

```bash
set -euo pipefail
run_exact_debug "$TEST_G1::production_dispatch_routes_no_query_fast"
run_exact_debug "$TEST_G1::g1_completed_full_app_route_matrix_matches_parent"
run_exact_debug "$TEST_G1::dispatch_nonempty_user_messages_and_full_text_are_materialized"
run_g1_aggregate
run_g2_aggregate
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_both_guards
assert_max_1000_lines "${SD_TASK8_FILES[@]}"
commit_exact_scope \
  'perf(session-directory): route no-query requests through the fast path' \
  crates/freshell-server/src/session_directory_fast.rs \
  crates/freshell-server/src/session_directory_page_bound_g1_tests.rs
```

Do not rerun G3 here: it forces both strategies and Task 8 just ran the full
manifest. This commit contains only selector/test changes.

### Task 10: Switch nonempty Title in the second selector-only commit

**Files:** selector only in fast and its dedicated test only in G1-tests.

- [ ] **Step 1: Write the final selector test first**

```bash
set -euo pipefail
expect_exact_debug_failure \
  "$TEST_G1::production_dispatch_routes_nonempty_title_fast_and_retains_file_tiers" \
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
run_exact_debug "$TEST_G1::production_dispatch_routes_nonempty_title_fast_and_retains_file_tiers"
```

- [ ] **Step 3: Refactor selector only, perform final checks, and commit**

```bash
set -euo pipefail
run_exact_debug "$TEST_G1::production_dispatch_routes_nonempty_title_fast_and_retains_file_tiers"
run_exact_debug "$TEST_G1::g1_completed_full_app_route_matrix_matches_parent"
run_exact_debug "$TEST_G1::dispatch_nonempty_user_messages_and_full_text_are_materialized"
run_g1_aggregate
run_g2_aggregate
run_server_all_targets
run_sessions_sanity
run_fmt_check
run_clippy
run_shared_typecheck
run_both_guards
run_g3_release_gate
assert_max_1000_lines "${SD_TASK8_FILES[@]}"
commit_exact_scope \
  'perf(session-directory): route title search through the fast path' \
  crates/freshell-server/src/session_directory_fast.rs \
  crates/freshell-server/src/session_directory_page_bound_g1_tests.rs
replay_pinned_parent_authority
run_rest_parity_gate
```

This is the sole post-switch whole G3. Completion requires both Fast selectors,
retained Materialized file tiers, and the compiled/tested Materialized rollback
path.

After the Task-10 commit and pinned-parent replay, `run_rest_parity_gate` is the
mandatory cross-process Node/Rust REST completion gate. Rust-local raw-byte,
G1/G2/G3, and parent-artifact checks do not substitute for its declared
normalized external comparator.

---

## Scratch Mutation Protocol

### Setup and fail-closed helpers

```bash
set -euo pipefail
run_both_guards
load_validated_task6_mutation_base
assert_mutation_worktree_record() {
  local mode="$1"
  python3 - "$WT" "$MUT_WT_EXPECTED" "$MUT_WT_HEAD" "$mode" <<'PY'
import os, subprocess, sys
wt, expected_path, expected_head, mode = sys.argv[1:]
expected_path = os.path.normpath(os.path.abspath(expected_path))
raw = subprocess.check_output(
    ["git", "-C", wt, "worktree", "list", "--porcelain", "-z"]
)
records = []
for block in raw.split(b"\0\0"):
    if not block:
        continue
    record, flags = {}, set()
    for field in block.split(b"\0"):
        if not field:
            continue
        if b" " in field:
            key, value = field.split(b" ", 1)
            record[key.decode()] = os.fsdecode(value)
        else:
            flags.add(field.decode())
    record["flags"] = flags
    records.append(record)
def lexical(path):
    return os.path.normpath(os.path.abspath(path))
matches = [
    record for record in records
    if lexical(record.get("worktree", "")) == expected_path
    or os.path.realpath(record.get("worktree", "")) == expected_path
]
if mode == "absent":
    if matches:
        raise SystemExit(f"scratch path already registered; preserving it: {matches!r}")
elif mode in {"owned", "locked", "prunable"}:
    if len(matches) != 1:
        raise SystemExit(f"expected one scratch registration, found {matches!r}")
    record = matches[0]
    flags = record["flags"]
    if record.get("HEAD") != expected_head or "detached" not in flags:
        raise SystemExit(f"scratch registration identity changed: {record!r}")
    markers = set(record) | flags
    if mode == "owned" and {"locked", "prunable"} & markers:
        raise SystemExit(f"scratch registration is locked/prunable: {record!r}")
    if mode == "locked" and (
        "locked" not in markers or "prunable" in markers
    ):
        raise SystemExit(f"scratch registration is not exactly locked: {record!r}")
    if mode == "prunable" and "prunable" not in markers:
        raise SystemExit(f"scratch registration is not prunable: {record!r}")
else:
    raise SystemExit(f"unknown scratch worktree-check mode: {mode}")
PY
}

assert_mutation_worktree_identity() {
  local actual actual_top actual_head actual_gitdir
  test -n "${MUT_TMP_ID:-}" &&
    test -n "${MUT_WT_ID:-}" &&
    test -n "${MUT_WT_GITDIR:-}" &&
    test -n "${MUT_WT_GITDIR_ID:-}" || return 1
  actual="$(path_identity "$MUT_TMP")" || return 1
  test "$actual" = "$MUT_TMP_ID" || return 1
  assert_mutation_worktree_record owned || return 1
  test "$(canonical_path "$MUT_WT")" = "$MUT_WT_EXPECTED" || return 1
  test "$(path_identity "$MUT_WT")" = "$MUT_WT_ID" || return 1
  actual_top="$(git -C "$MUT_WT" rev-parse --show-toplevel)" || return 1
  test "$(canonical_path "$actual_top")" = "$MUT_WT_EXPECTED" || return 1
  actual_head="$(git -C "$MUT_WT" rev-parse HEAD)" || return 1
  test "$actual_head" = "$MUT_WT_HEAD" || return 1
  actual_gitdir="$(git -C "$MUT_WT" rev-parse --absolute-git-dir)" || return 1
  actual_gitdir="$(canonical_path "$actual_gitdir")" || return 1
  test "$actual_gitdir" = "$MUT_WT_GITDIR" || return 1
  test "$(path_identity "$actual_gitdir")" = "$MUT_WT_GITDIR_ID" || return 1
}

assert_mutation_worktree_owned() {
  test "${MUT_WT_OWNED:-0}" = 1 || {
    printf 'mutation worktree ownership was never established\n' >&2
    return 1
  }
  assert_mutation_worktree_identity
}

scratch_status() {
  local status
  assert_mutation_worktree_owned || return 1
  status="$(git -C "$MUT_WT" -c core.fsmonitor=false \
    -c core.untrackedCache=false status --porcelain=v1 \
    --untracked-files=all)" || return 1
  assert_mutation_worktree_owned || return 1
  printf '%s' "$status"
}

scratch_assert_clean() {
  local status
  status="$(scratch_status)" || return 1
  test -z "$status" || {
    printf 'owned mutation worktree is dirty; preserving it:\n%s\n' "$status" >&2
    return 1
  }
}

cleanup_mutation_scratch() {
  local original_status="$?" cleanup_status=0 status actual
  trap - EXIT
  if test "${MUT_WT_OWNED:-0}" = 1; then
    if ! assert_mutation_worktree_owned ||
       ! status="$(scratch_status)" ||
       test -n "$status" ||
       ! assert_mutation_worktree_owned; then
      printf 'mutation scratch is ambiguous; preserving it\n' >&2
      cleanup_status=1
    elif git -C "$WT" -c core.fsmonitor=false -c core.untrackedCache=false \
        worktree remove "$MUT_WT"; then
      MUT_WT_OWNED=0
      test ! -e "$MUT_WT" || cleanup_status=1
      assert_mutation_worktree_record absent || cleanup_status=1
      test ! -e "$MUT_WT_GITDIR" || cleanup_status=1
    else
      printf 'non-forced mutation removal failed; preserving it\n' >&2
      cleanup_status=1
    fi
  fi
  if test "${MUT_TMP_OWNED:-0}" = 1; then
    actual="$(path_identity "$MUT_TMP")" || cleanup_status=1
    if test "$cleanup_status" = 0 &&
       test "$actual" = "$MUT_TMP_ID" &&
       test "${MUT_WT_OWNED:-0}" = 0 &&
       test ! -e "$MUT_WT" &&
       assert_mutation_worktree_record absent &&
       rmdir "$MUT_TMP"; then
      MUT_TMP_OWNED=0
    else
      printf 'mutation temp root retained; ownership is ambiguous\n' >&2
      cleanup_status=1
    fi
  fi
  test "$original_status" -eq 0 || return "$original_status"
  return "$cleanup_status"
}

create_mutation_scratch() {
  local expected_head="$1"
  test "${MUT_WT_OWNED:-0}" = 0 || return 1
  test "${MUT_TMP_OWNED:-0}" = 0 || return 1
  MUT_WT_HEAD="$expected_head"
  MUT_TMP="$(mktemp -d \
    /home/dan/code/freshell/.worktrees/.session-directory-page-bound-mutation.XXXXXXXX)" ||
    return 1
  MUT_TMP_OWNED=0
  test "$(path_mode "$MUT_TMP")" = 700 || return 1
  MUT_TMP_ID="$(path_identity "$MUT_TMP")" || return 1
  MUT_TMP_OWNED=1
  MUT_RUN_ID="${MUT_TMP##*.}"
  MUT_WT="$MUT_TMP/worktree-$MUT_RUN_ID"
  MUT_WT_EXPECTED="$(canonical_path "$MUT_WT")" || return 1
  MUT_WT_OWNED=0
  MUT_WT_ID=
  MUT_WT_GITDIR=
  MUT_WT_GITDIR_ID=
  test ! -e "$MUT_WT" || return 1
  assert_mutation_worktree_record absent || return 1
  trap cleanup_mutation_scratch EXIT
  git -C "$WT" -c core.hooksPath=/dev/null -c core.fsmonitor=false \
    -c core.untrackedCache=false worktree add --detach \
    "$MUT_WT" "$MUT_WT_HEAD" || return 1
  assert_mutation_worktree_record owned
  test "$(canonical_path "$MUT_WT")" = "$MUT_WT_EXPECTED"
  test "$(canonical_path "$(git -C "$MUT_WT" rev-parse --show-toplevel)")" = \
    "$MUT_WT_EXPECTED"
  test "$(git -C "$MUT_WT" rev-parse HEAD)" = "$MUT_WT_HEAD"
  MUT_WT_ID="$(path_identity "$MUT_WT")"
  MUT_WT_GITDIR="$(canonical_path \
    "$(git -C "$MUT_WT" rev-parse --absolute-git-dir)")"
  MUT_WT_GITDIR_ID="$(path_identity "$MUT_WT_GITDIR")"
  assert_mutation_worktree_identity
  test -z "$(git -C "$MUT_WT" -c core.fsmonitor=false \
    -c core.untrackedCache=false status --porcelain=v1 --untracked-files=all)"
  assert_mutation_worktree_identity
  MUT_WT_OWNED=1
  assert_mutation_worktree_owned
  scratch_assert_clean
}

scratch_list_tests() {
  local output line cargo_status
  assert_mutation_worktree_owned || return 1
  if output="$(CARGO_TERM_COLOR=never cargo test \
      --manifest-path "$MUT_WT/Cargo.toml" \
      -p freshell-server --bin freshell-server -- --list --color=never)"; then
    cargo_status=0
  else
    cargo_status=$?
  fi
  assert_mutation_worktree_owned || return 1
  test "$cargo_status" -eq 0 || return "$cargo_status"
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
  local cargo_status
  assert_mutation_worktree_owned || return 1
  if CARGO_TERM_COLOR=never cargo test \
      --manifest-path "$MUT_WT/Cargo.toml" \
      -p freshell-server --bin freshell-server --no-run --color=never; then
    cargo_status=0
  else
    cargo_status=$?
  fi
  assert_mutation_worktree_owned || return 1
  test "$cargo_status" -eq 0 || {
    printf 'INVALID MUTATION SETUP: mutated tree does not compile\n' >&2
    return 1
  }
}

assert_exact_mutation_kill_log() {
  local cargo_status="$1" log="$2" name="$3" marker="$4"
  python3 - "$cargo_status" "$log" "$name" "$marker" <<'PY'
import pathlib
import re
import sys

cargo_status_text, log_path, name, marker = sys.argv[1:]
try:
    cargo_status = int(cargo_status_text)
except ValueError as exc:
    raise SystemExit(f"invalid Cargo status: {cargo_status_text!r}") from exc
if cargo_status != 101:
    raise SystemExit(
        f"Cargo status was {cargo_status}; expected mutation-test failure status 101"
    )
if not marker or "\n" in marker or "\r" in marker:
    raise SystemExit(f"invalid mutation marker: {marker!r}")

text = pathlib.Path(log_path).read_text(encoding="utf-8")
lines = text.splitlines()
expected_status = f"test {name} ... FAILED"
status_lines = [
    line for line in lines
    if line.startswith("test ") and " ... " in line
]
if status_lines != [expected_status]:
    raise SystemExit(
        f"selected-test status lines differ: {status_lines!r} != {[expected_status]!r}"
    )

detail = f"---- {name} stdout ----"
if lines.count(detail) != 1:
    raise SystemExit("selected-test failure detail is absent or duplicated")
detail_at = lines.index(detail)
failure_headers = [i for i, line in enumerate(lines) if line == "failures:"]
result_indices = [
    i for i, line in enumerate(lines) if line.startswith("test result:")
]
if len(failure_headers) != 2 or len(result_indices) != 1:
    raise SystemExit(
        "expected exactly two libtest failure headers and one result line; "
        f"found failures={failure_headers!r}, results={result_indices!r}"
    )
result_at = result_indices[0]
if not (failure_headers[0] < detail_at < failure_headers[1] < result_at):
    raise SystemExit("libtest failure sections are malformed or out of order")
listed = [
    line for line in lines[failure_headers[1] + 1 : result_at] if line
]
if listed != [f"    {name}"]:
    raise SystemExit(f"failure list differs from selected test: {listed!r}")
summary = re.compile(
    r"test result: FAILED\. 0 passed; 1 failed; 0 ignored; "
    r"0 measured; [0-9]+ filtered out; finished in [^\r\n]+"
)
if summary.fullmatch(lines[result_at]) is None:
    raise SystemExit(f"unexpected libtest failure summary: {lines[result_at]!r}")
detail_text = "\n".join(lines[detail_at + 1 : failure_headers[1]])
if detail_text.count(marker) != 1 or text.count(marker) != 1:
    raise SystemExit(
        "mutation marker was not emitted exactly once inside selected-test detail: "
        f"{marker!r}"
    )
PY
}

scratch_require_killed() {
  local mutation="$1" name="$2" log marker cargo_status
  marker="SESSION_DIRECTORY_MUTATION_KILL:$mutation"
  scratch_assert_one "$name" || return 1
  log="$(mktemp)" || return 1
  assert_mutation_worktree_owned || { rm -f "$log"; return 1; }
  if CARGO_TERM_COLOR=never cargo test \
      --manifest-path "$MUT_WT/Cargo.toml" \
      -p freshell-server --bin freshell-server \
      "$name" -- --exact --color=never --test-threads=1 >"$log" 2>&1; then
    cargo_status=0
  else
    cargo_status=$?
  fi
  if ! assert_mutation_worktree_owned; then
    cat "$log" >&2 || true
    rm -f "$log"
    return 1
  fi
  if test "$cargo_status" -eq 0; then
    printf 'SURVIVED: %s (%s)\n' "$mutation" "$name" >&2
    cat "$log" >&2 || true
    rm -f "$log"
    return 1
  fi
  if ! assert_exact_mutation_kill_log \
      "$cargo_status" "$log" "$name" "$marker"; then
    cat "$log" >&2 || true
    rm -f "$log"
    return 1
  fi
  cat "$log" || { rm -f "$log"; return 1; }
  rm -f "$log"
}

scratch_restore() {
  local file=crates/freshell-server/src/session_directory_fast.rs status
  assert_mutation_worktree_owned || return 1
  status="$(scratch_status)" || return 1
  case "$status" in
    ''|" M $file") ;;
    *) printf 'unexpected mutation scratch state; refusing restore:\n%s\n' \
         "$status" >&2; return 1 ;;
  esac
  assert_mutation_worktree_owned || return 1
  git -C "$MUT_WT" restore --source="$MUT_WT_HEAD" --worktree -- \
    "$file" || return 1
  assert_mutation_worktree_owned || return 1
  scratch_assert_clean
}
```

The restore targets only the disposable scratch file. It is never run in the
active or foreign worktree.

### Deterministic mutation-ownership negative probes

Run these shell-level probes before creating the real mutation scratch. Each
probe receives a fresh random root/identities, proves that the guarded action
marker is never reached, restores only known probe state, and completes ordinary
guarded cleanup before the next probe.

```bash
guarded_mutation_probe_action() {
  assert_mutation_worktree_owned || return 1
  test ! -e "$MUT_PROBE_REACHED" || return 1
  printf 'reached\n' >"$MUT_PROBE_REACHED" || return 1
  assert_mutation_worktree_owned || return 1
}

expect_mutation_probe_blocked() {
  local label="$1"
  if guarded_mutation_probe_action; then
    printf 'ownership probe unexpectedly reached action: %s\n' "$label" >&2
    return 1
  fi
  test ! -e "$MUT_PROBE_REACHED" || {
    printf 'ownership probe action marker exists: %s\n' "$label" >&2
    return 1
  }
}

assert_exact_probe_line() {
  local path="$1" expected="$2"
  python3 - "$path" "$expected" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
expected = sys.argv[2].encode("utf-8") + b"\n"
if path.read_bytes() != expected:
    raise SystemExit(f"probe bytes differ: {path}")
PY
}

begin_mutation_ownership_probe() {
  MUT_TMP_OWNED=0
  MUT_WT_OWNED=0
  create_mutation_scratch "$MUTATION_BASE" || return 1
  MUT_PROBE_REACHED="$MUT_TMP/probe-action-reached"
  test ! -e "$MUT_PROBE_REACHED" || return 1
}

finish_mutation_ownership_probe() {
  scratch_assert_clean || return 1
  cleanup_mutation_scratch || return 1
  trap - EXIT
  test "${MUT_WT_OWNED:-0}" = 0 || return 1
  test "${MUT_TMP_OWNED:-0}" = 0 || return 1
  test ! -e "$MUT_WT" || return 1
  assert_mutation_worktree_record absent
}

probe_a_ownership_flag_absent() {
  local saved_owned
  begin_mutation_ownership_probe || return 1
  saved_owned="$MUT_WT_OWNED"
  MUT_WT_OWNED=0
  expect_mutation_probe_blocked ownership-flag-absent || return 1
  assert_mutation_worktree_identity || return 1
  MUT_WT_OWNED="$saved_owned"
  assert_mutation_worktree_owned || return 1
  finish_mutation_ownership_probe
}

probe_b_identity_token_mismatches() {
  local token saved
  for token in MUT_TMP_ID MUT_WT_ID MUT_WT_GITDIR_ID; do
    begin_mutation_ownership_probe || return 1
    saved="${!token}"
    printf -v "$token" '%s.mismatch' "$saved"
    expect_mutation_probe_blocked "$token" || return 1
    printf -v "$token" '%s' "$saved"
    assert_mutation_worktree_owned || return 1
    finish_mutation_ownership_probe || return 1
  done
}

probe_c_locked_registration() {
  begin_mutation_ownership_probe || return 1
  assert_mutation_worktree_owned || return 1
  git -C "$WT" worktree lock \
    --reason session-directory-ownership-negative-probe "$MUT_WT" || return 1
  assert_mutation_worktree_record locked || return 1
  expect_mutation_probe_blocked locked-registration || return 1
  assert_mutation_worktree_record locked || return 1
  git -C "$WT" worktree unlock "$MUT_WT" || return 1
  assert_mutation_worktree_owned || return 1
  finish_mutation_ownership_probe
}

probe_d_prunable_registration() {
  local moved
  begin_mutation_ownership_probe || return 1
  moved="$MUT_TMP/prunable-$MUT_RUN_ID"
  assert_mutation_worktree_owned || return 1
  test ! -e "$moved" || return 1
  mv -- "$MUT_WT" "$moved" || return 1
  test "$(path_identity "$moved")" = "$MUT_WT_ID" || return 1
  assert_mutation_worktree_record prunable || return 1
  expect_mutation_probe_blocked prunable-registration || return 1
  assert_mutation_worktree_record prunable || return 1
  mv -- "$moved" "$MUT_WT" || return 1
  assert_mutation_worktree_owned || return 1
  finish_mutation_ownership_probe
}

probe_e_untracked_restore_refusal() {
  local probe
  begin_mutation_ownership_probe || return 1
  probe="$MUT_WT/mutation-untracked-probe"
  assert_mutation_worktree_owned || return 1
  printf 'untracked-probe\n' >"$probe" || return 1
  assert_mutation_worktree_owned || return 1
  if scratch_restore; then
    printf 'restore accepted untracked probe\n' >&2
    return 1
  fi
  test ! -e "$MUT_PROBE_REACHED" || return 1
  assert_mutation_worktree_owned || return 1
  assert_exact_probe_line "$probe" untracked-probe || return 1
  assert_mutation_worktree_owned || return 1
  rm -- "$probe" || return 1
  assert_mutation_worktree_owned || return 1
  finish_mutation_ownership_probe
}

probe_f_staged_restore_refusal() {
  local probe_rel=mutation-staged-probe probe
  begin_mutation_ownership_probe || return 1
  probe="$MUT_WT/$probe_rel"
  assert_mutation_worktree_owned || return 1
  printf 'staged-probe\n' >"$probe" || return 1
  git -C "$MUT_WT" add -- "$probe_rel" || return 1
  test "$(git -C "$MUT_WT" diff --cached --name-only)" = "$probe_rel" ||
    return 1
  assert_mutation_worktree_owned || return 1
  if scratch_restore; then
    printf 'restore accepted staged probe\n' >&2
    return 1
  fi
  test ! -e "$MUT_PROBE_REACHED" || return 1
  assert_mutation_worktree_owned || return 1
  test -f "$probe" || return 1
  assert_exact_probe_line "$probe" staged-probe || return 1
  test "$(git -C "$MUT_WT" diff --cached --name-only)" = "$probe_rel" ||
    return 1
  assert_mutation_worktree_owned || return 1
  git -C "$MUT_WT" rm --cached -- "$probe_rel" || return 1
  rm -- "$probe" || return 1
  assert_mutation_worktree_owned || return 1
  finish_mutation_ownership_probe
}

probe_g_extra_tracked_restore_refusal() {
  local rel=crates/freshell-server/Cargo.toml path saved expected suffix
  begin_mutation_ownership_probe || return 1
  path="$MUT_WT/$rel"
  saved="$MUT_TMP/Cargo.toml.base"
  expected="$MUT_TMP/Cargo.toml.expected"
  suffix="# session-directory mutation ownership probe $MUT_RUN_ID"
  assert_mutation_worktree_owned || return 1
  test ! -e "$saved" && test ! -e "$expected" || return 1
  cp -- "$path" "$saved" || return 1
  python3 - "$path" "$saved" "$expected" "$suffix" <<'PY'
import pathlib
import sys

path, saved, expected = map(pathlib.Path, sys.argv[1:4])
suffix = b"\n" + sys.argv[4].encode("utf-8") + b"\n"
base = saved.read_bytes()
if path.read_bytes() != base:
    raise SystemExit("Probe G base changed before append")
expected.open("xb").write(base + suffix)
path.write_bytes(base + suffix)
if path.read_bytes() != expected.read_bytes():
    raise SystemExit("Probe G append is not exact")
PY
  assert_mutation_worktree_owned || return 1
  cmp -- "$path" "$expected" || return 1
  test "$(scratch_status)" = " M $rel" || return 1
  if scratch_restore; then
    printf 'restore accepted extra tracked modification\n' >&2
    return 1
  fi
  test ! -e "$MUT_PROBE_REACHED" || return 1
  assert_mutation_worktree_owned || return 1
  cmp -- "$path" "$expected" || return 1

  # Restore only after one process proves exact length, exact base prefix, and
  # exact approved suffix. Any interior/extra/raced byte preserves the probe.
  python3 - "$path" "$saved" "$suffix" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
saved = pathlib.Path(sys.argv[2])
base = saved.read_bytes()
suffix = b"\n" + sys.argv[3].encode("utf-8") + b"\n"
current = path.read_bytes()
if len(current) != len(base) + len(suffix):
    raise SystemExit("Probe G modified length differs")
if current[: len(base)] != base or current[len(base) :] != suffix:
    raise SystemExit("Probe G is not exact base plus approved suffix")
path.write_bytes(base)
PY
  cmp -- "$path" "$saved" || return 1
  rm -- "$expected" "$saved" || return 1
  assert_mutation_worktree_owned || return 1
  finish_mutation_ownership_probe
}

probe_h_dirty_cleanup_preservation() {
  local probe
  begin_mutation_ownership_probe || return 1
  probe="$MUT_WT/mutation-dirty-cleanup-probe"
  assert_mutation_worktree_owned || return 1
  printf 'dirty-cleanup-probe\n' >"$probe" || return 1
  if cleanup_mutation_scratch; then
    printf 'cleanup accepted dirty scratch\n' >&2
    return 1
  fi
  trap cleanup_mutation_scratch EXIT
  test "$MUT_WT_OWNED" = 1 && test "$MUT_TMP_OWNED" = 1 || return 1
  assert_mutation_worktree_owned || return 1
  assert_mutation_worktree_record owned || return 1
  test -d "$MUT_WT" &&
    assert_exact_probe_line "$probe" dirty-cleanup-probe ||
    return 1
  test ! -e "$MUT_PROBE_REACHED" || return 1
  rm -- "$probe" || return 1
  assert_mutation_worktree_owned || return 1
  finish_mutation_ownership_probe
}

run_mutation_ownership_probes() {
  probe_a_ownership_flag_absent &&
    probe_b_identity_token_mismatches &&
    probe_c_locked_registration &&
    probe_d_prunable_registration &&
    probe_e_untracked_restore_refusal &&
    probe_f_staged_restore_refusal &&
    probe_g_extra_tracked_restore_refusal &&
    probe_h_dirty_cleanup_preservation
}

expect_mutation_kill_probe_rejected() {
  local status="$1" log="$2" name="$3" marker="$4"
  if assert_exact_mutation_kill_log "$status" "$log" "$name" "$marker"; then
    printf 'mutation-kill parser accepted negative probe: %s\n' "$log" >&2
    return 1
  fi
}

run_mutation_kill_parser_probes() {
  local root name marker
  root="$(mktemp -d)" || return 1
  name='session_directory::page_bound_g2_tests::mutation_parser_probe'
  marker='SESSION_DIRECTORY_MUTATION_KILL:mutation-parser-probe'
  python3 - "$root" "$name" "$marker" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
name, marker = sys.argv[2:]


def transcript(
    *,
    test_name=name,
    detail=marker,
    listed=name,
    summary="test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 99 filtered out; finished in 0.01s",
    prefix="",
    extra_status="",
    suffix="",
):
    return (
        f"{prefix}running 1 test\n"
        f"test {test_name} ... FAILED\n"
        f"{extra_status}\n"
        "failures:\n\n"
        f"---- {test_name} stdout ----\n"
        f"{detail}\n\n"
        "failures:\n"
        f"    {listed}\n\n"
        f"{summary}\n"
        f"{suffix}"
    )


logs = {
    "valid": transcript(),
    "unrelated": transcript(detail="unrelated setup panic"),
    "environment": f"error: linker failed\ntest {name} ... FAILED\n",
    "wrong-test": transcript(test_name=f"{name}_other", listed=f"{name}_other"),
    "extra-status": transcript(extra_status=f"test {name}_other ... ok"),
    "marker-outside": transcript(prefix=f"{marker}\n", detail="unrelated panic"),
    "duplicate-marker": transcript(detail=f"{marker}\n{marker}"),
    "malformed-summary": transcript(summary="test result: FAILED. 0 passed; 1 failed"),
    "extra-summary": transcript(suffix="test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 99 filtered out; finished in 0.01s\n"),
    "passed-count": transcript(summary="test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 99 filtered out; finished in 0.01s"),
    "second-failed": transcript(summary="test result: FAILED. 0 passed; 2 failed; 0 ignored; 0 measured; 99 filtered out; finished in 0.01s"),
    "ignored-count": transcript(summary="test result: FAILED. 0 passed; 1 failed; 1 ignored; 0 measured; 99 filtered out; finished in 0.01s"),
    "measured-count": transcript(summary="test result: FAILED. 0 passed; 1 failed; 0 ignored; 1 measured; 99 filtered out; finished in 0.01s"),
    "wrong-list": transcript(listed=f"{name}_other"),
}
for label, text in logs.items():
    (root / label).write_text(text, encoding="utf-8")
PY

  assert_exact_mutation_kill_log 101 "$root/valid" "$name" "$marker" || return 1
  expect_mutation_kill_probe_rejected 0 "$root/valid" "$name" "$marker" || return 1
  expect_mutation_kill_probe_rejected 1 "$root/valid" "$name" "$marker" || return 1
  for label in unrelated environment wrong-test extra-status marker-outside \
      duplicate-marker malformed-summary extra-summary passed-count second-failed \
      ignored-count measured-count wrong-list; do
    expect_mutation_kill_probe_rejected \
      101 "$root/$label" "$name" "$marker" || return 1
  done
  rm -- \
    "$root/valid" "$root/unrelated" "$root/environment" "$root/wrong-test" \
    "$root/extra-status" "$root/marker-outside" "$root/duplicate-marker" \
    "$root/malformed-summary" "$root/extra-summary" "$root/passed-count" \
    "$root/second-failed" "$root/ignored-count" "$root/measured-count" \
    "$root/wrong-list" || return 1
  rmdir "$root"
}

run_mutation_ownership_probes
run_mutation_kill_parser_probes
MUT_TMP_OWNED=0
MUT_WT_OWNED=0
create_mutation_scratch "$MUTATION_BASE"
```

If an expected failure reaches `MUT_PROBE_REACHED`, stop and preserve the
scratch. Never run `git worktree prune`. Each refusal preserves exact
path/registration/state; only the known probe token or bytes are restored.
These probes add no Rust test or mutation ID.

### Exact mutation engine

Tasks 4/5 retain the canonical snippets used below through Task 7. Every
pre-edit old count must be one/new zero; every post-edit old count must be
zero/new one.

```bash
set -euo pipefail
apply_exact_mutation() {
  local mutation="$1"
  local file="$MUT_WT/crates/freshell-server/src/session_directory_fast.rs"
  local mutation_status
  assert_mutation_worktree_owned || return 1
  if python3 - "$file" "$mutation" <<'PY'
from __future__ import annotations
import pathlib, sys
path = pathlib.Path(sys.argv[1])
name = sys.argv[2]
M = {
"reverse-full-key-order": [(".then_with(|| candidate_full_key(right).cmp(&candidate_full_key(left)))", ".then_with(|| candidate_full_key(left).cmp(&candidate_full_key(right)))")],
"defer-synth-on-greater": [("Ordering::Greater => MergeSide::Synth,", "Ordering::Greater => MergeSide::Indexed,")],
"cursor-inclusive": [("last_activity_at < cursor_last", "last_activity_at <= cursor_last")],
"deletion-after-selection": [
    ("if candidate_is_deleted(candidate, overrides) {\n            continue;\n        }", "if false && candidate_is_deleted(candidate, overrides) {\n            continue;\n        }"),
    ("let mut item = materialize_selected_descriptor(selected, inputs);", "if candidate_is_deleted(selected.candidate, inputs.overrides) {\n            continue;\n        }\n        let mut item = {\n            materialize_selected_descriptor(selected, inputs)\n        };")
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
  then
    mutation_status=0
  else
    mutation_status=$?
  fi
  assert_mutation_worktree_owned || return 1
  return "$mutation_status"
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

| Mutation | Exact mandatory killer | Exact marker | Direct expected failure observation |
|---|---|---|---|
| `reverse-full-key-order` | `g1_duplicate_equal_and_colon_collision_old_materialized_fast` | `SESSION_DIRECTORY_MUTATION_KILL:reverse-full-key-order` | Distinct equal-time subcase's exact descending Fast full-key vector. |
| `defer-synth-on-greater` | `g2_no_query_mixed_indexed_and_synth_work_is_exact` | `SESSION_DIRECTORY_MUTATION_KILL:defer-synth-on-greater` | Complete key vector with `synth-mid` at ordinal 26 and `idx-104` last, fixing the cursor. |
| `cursor-inclusive` | `g1_arbitrary_and_malformed_cursors_old_materialized_fast` | `SESSION_DIRECTORY_MUTATION_KILL:cursor-inclusive` | Exact-on-row/equal-time strict post-cursor suffix. |
| `deletion-after-selection` | `g1_fast_deleted_override_backfills_page_old_materialized_fast` | `SESSION_DIRECTORY_MUTATION_KILL:deletion-after-selection` | Exact full backfilled Fast page after deleted head/middle/tail rows. |
| `choose-last-identity` | `g1_ordered_identity_permutations_old_materialized_fast` | `SESSION_DIRECTORY_MUTATION_KILL:choose-last-identity` | Consolidated Fast winners `["terminal-a","terminal-b"]` for A→B and B→A. |
| `tuple-dedupe` | `g1_duplicate_equal_and_colon_collision_old_materialized_fast` | `SESSION_DIRECTORY_MUTATION_KILL:tuple-dedupe` | Separate colon-composition subcase's exact legacy full-string-collision result/winner vector. |
| `omit-identity-revision` | `g1_i64_revision_boundaries_old_materialized_fast` | `SESSION_DIRECTORY_MUTATION_KILL:omit-identity-revision` | Isolated identity-maximum case's exact Fast revision. |
| `use-deleted-index-head-revision` | `g1_i64_revision_boundaries_old_materialized_fast` | `SESSION_DIRECTORY_MUTATION_KILL:use-deleted-index-head-revision` | Distinct deleted-head case's revision from valid sources. |
| `invert-subagent-filter` | `g1_all_eight_flags_old_materialized_fast` | `SESSION_DIRECTORY_MUTATION_KILL:invert-subagent-filter` | Classification-isolated subagent inclusion vector for false/true. |
| `invert-noninteractive-filter` | `g1_all_eight_flags_old_materialized_fast` | `SESSION_DIRECTORY_MUTATION_KILL:invert-noninteractive-filter` | Classification-isolated noninteractive inclusion vector for false/true. |
| `invert-empty-filter` | `g1_all_eight_flags_old_materialized_fast` | `SESSION_DIRECTORY_MUTATION_KILL:invert-empty-filter` | Override-effective empty-only inclusion vector for false/true. |
| `construct-lookahead` | `g2_no_query_lookahead_descriptor_is_never_constructed` | `SESSION_DIRECTORY_MUTATION_KILL:construct-lookahead` | Exact returned-row work tuple, especially `indexed_full == 50` and `item_serialization == 50`. |
| `direct-dir-item-literal` | `g2_candidate_source_has_no_direct_dir_item_literal` | `SESSION_DIRECTORY_MUTATION_KILL:direct-dir-item-literal` | Focused direct-construction violation subset is empty before generic audit equality. |
| `clone-per-identity` | `g2_one_returned_row_with_500_identities_has_zero_full_row_clones` | `SESSION_DIRECTORY_MUTATION_KILL:clone-per-identity` | `full_row_clone == 0` before broader equations. |
| `indirect-full-row-constructor` | `g2_full_row_constructor_inventory_is_exact_and_instrumented` | `SESSION_DIRECTORY_MUTATION_KILL:indirect-full-row-constructor` | Focused unknown-returning-helper/clone violation subset is empty. |
| `recompute-title-and-skip` | `g2_title_post_selection_has_no_rejection_path` | `SESSION_DIRECTORY_MUTATION_KILL:recompute-title-and-skip` | Post-selection region has no `apply_title_search` or rejecting continuation/filter. |
| `route-file-tier-fast` | `dispatch_nonempty_user_messages_and_full_text_are_materialized` | `SESSION_DIRECTORY_MUTATION_KILL:route-file-tier-fast` | Both nonempty file-tier selectors equal `[Materialized, Materialized]`. |

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
  scratch_require_killed "$mutation" "$killer" || { scratch_restore; return 1; }
  scratch_restore || return 1
}
run_one_mutation reverse-full-key-order "$TEST_G1::g1_duplicate_equal_and_colon_collision_old_materialized_fast"
run_one_mutation defer-synth-on-greater "$TEST_G2::g2_no_query_mixed_indexed_and_synth_work_is_exact"
run_one_mutation cursor-inclusive "$TEST_G1::g1_arbitrary_and_malformed_cursors_old_materialized_fast"
run_one_mutation deletion-after-selection "$TEST_G1::g1_fast_deleted_override_backfills_page_old_materialized_fast"
run_one_mutation choose-last-identity "$TEST_G1::g1_ordered_identity_permutations_old_materialized_fast"
run_one_mutation tuple-dedupe "$TEST_G1::g1_duplicate_equal_and_colon_collision_old_materialized_fast"
run_one_mutation omit-identity-revision "$TEST_G1::g1_i64_revision_boundaries_old_materialized_fast"
run_one_mutation use-deleted-index-head-revision "$TEST_G1::g1_i64_revision_boundaries_old_materialized_fast"
run_one_mutation invert-subagent-filter "$TEST_G1::g1_all_eight_flags_old_materialized_fast"
run_one_mutation invert-noninteractive-filter "$TEST_G1::g1_all_eight_flags_old_materialized_fast"
run_one_mutation invert-empty-filter "$TEST_G1::g1_all_eight_flags_old_materialized_fast"
run_one_mutation construct-lookahead "$TEST_G2::g2_no_query_lookahead_descriptor_is_never_constructed"
run_one_mutation direct-dir-item-literal "$TEST_G2::g2_candidate_source_has_no_direct_dir_item_literal"
run_one_mutation clone-per-identity "$TEST_G2::g2_one_returned_row_with_500_identities_has_zero_full_row_clones"
run_one_mutation indirect-full-row-constructor "$TEST_G2::g2_full_row_constructor_inventory_is_exact_and_instrumented"
run_one_mutation recompute-title-and-skip "$TEST_G2::g2_title_post_selection_has_no_rejection_path"
run_one_mutation route-file-tier-fast "$TEST_G1::dispatch_nonempty_user_messages_and_full_text_are_materialized"
```

Run the whole literal sequence serially. Prior kills do not count after any
Task-6 amendment or candidate rebuild. In the future scratch run,
`defer-synth-on-greater` must compile and
`g2_no_query_mixed_indexed_and_synth_work_is_exact` must be the exact single
failing test, with
`SESSION_DIRECTORY_MUTATION_KILL:defer-synth-on-greater` emitted exactly once in
its failure detail and the strict one-failure summary, and with its order/cursor
assertion observing the Greater-arm defect. No such candidate compilation or
kill has happened at plan-edit time.

### Surviving mutation and cleanup rules

A test-only amendment accepts an explicit nonempty unique changed-path list,
proves every path is in the amendment-eligible test set, preserves Task-6
subject/parent and exact baseline-union scope, and keeps all production files
byte-identical. Neither helper performs destructive recovery:

```bash
set -euo pipefail
assert_task6_amend_is_test_only() {
  local baseline="$1"
  shift
  python3 - "$WT" "$baseline" \
    --tests "${TASK6_TEST_FILES[@]}" \
    --production "${TASK6_PRODUCTION_FILES[@]}" \
    --changed "$@" <<'PY'
import json, os, pathlib, subprocess, sys
wt, baseline, *args = sys.argv[1:]
def split(flag, next_flag=None):
    start = args.index(flag) + 1
    stop = args.index(next_flag) if next_flag else len(args)
    return args[start:stop]
tests = split("--tests", "--production")
production = split("--production", "--changed")
changed = split("--changed")
if not changed or len(changed) != len(set(changed)):
    raise SystemExit("changed amendment paths must be nonempty and unique")
if not set(changed) <= set(tests):
    raise SystemExit(f"non-test amendment path: {set(changed) - set(tests)}")
def git(*items):
    return subprocess.check_output(["git", "-C", wt, *items])
def nul(raw, label):
    if raw and not raw.endswith(b"\0"):
        raise SystemExit(f"{label} is not NUL terminated")
    return [] if not raw else [os.fsdecode(p) for p in raw[:-1].split(b"\0")]
status = git("status", "--porcelain=v1", "-z", "--untracked-files=all")
status_paths = []
offset = 0
while offset < len(status):
    end = status.index(b"\0", offset)
    entry = status[offset:end]
    offset = end + 1
    if len(entry) < 4:
        raise SystemExit("malformed status record")
    status_paths.append(os.fsdecode(entry[3:]))
    if b"R" in entry[:2] or b"C" in entry[:2]:
        end = status.index(b"\0", offset)
        status_paths.append(os.fsdecode(status[offset:end]))
        offset = end + 1
if set(status_paths) != set(changed):
    raise SystemExit(f"status paths differ: {status_paths!r} != {changed!r}")
cached = nul(git("diff", "--cached", "--name-only", "-z", "HEAD", "--"), "cached")
if cached:
    raise SystemExit(f"pre-existing cached paths: {cached!r}")
baseline_paths = nul(
    git("diff-tree", "--root", "--no-commit-id", "--name-only", "-z",
        "-r", "--no-renames", baseline),
    "baseline paths",
)
if not set(baseline_paths) <= set(tests):
    raise SystemExit(f"baseline contains non-test paths: {baseline_paths!r}")
for rel in production:
    if git("show", f"{baseline}:{rel}") != (pathlib.Path(wt) / rel).read_bytes():
        raise SystemExit(f"production path changed: {rel}")
print(json.dumps(sorted(set(baseline_paths) | set(changed)), separators=(",", ":")))
PY
}

amend_task6_tests_exact_scope() {
  local baseline current_head current_subject old_parent new_head new_parent expected
  local -a changed
  local subject='test(session-directory): commit complete compatibility and mutation-killer gates'
  if test "$#" -lt 2; then
    printf 'usage: amend_task6_tests_exact_scope MUTATION_BASE PATH...\n' >&2
    return 1
  fi
  baseline="$1"
  shift
  changed=("$@")
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
  expected="$(assert_task6_amend_is_test_only "$baseline" "${changed[@]}")" ||
    return 1
  _assert_git_scope preflight "${changed[@]}" || return 1
  assert_max_1000_lines "${SD_TASK4_FILES[@]}" || return 1
  git -C "$WT" add -- "${changed[@]}" || return 1
  _assert_git_scope cached "${changed[@]}" || return 1
  git -C "$WT" diff --cached --check || return 1
  git -C "$WT" commit --amend --only --no-edit -- "${changed[@]}" || return 1
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
  python3 - "$WT" "$expected" <<'PY'
import json, os, subprocess, sys
wt, expected_raw = sys.argv[1:]
expected = json.loads(expected_raw)
if not isinstance(expected, list) or not expected or any(
    not isinstance(path, str) or not path for path in expected
):
    raise SystemExit("invalid expected amended path union")
raw = subprocess.check_output([
    "git", "-C", wt, "diff-tree", "--root", "--no-commit-id",
    "--name-only", "-z", "-r", "--no-renames", "HEAD",
])
actual = sorted(os.fsdecode(p) for p in raw[:-1].split(b"\0")) if raw else []
if actual != expected:
    raise SystemExit(f"amended path union differs: {actual!r} != {expected!r}")
PY
  test -z "$(git -C "$WT" status --porcelain=v1 --untracked-files=all)"
}
```

If a compiling mutation survives:

1. Stop the table, restore only the scratch file, prove scratch clean, and use
   the non-forced cleanup below.
2. Strengthen only an explicit nonempty subset of `TASK6_TEST_FILES`; authority
   fixtures and every production path are ineligible.
3. Run `run_g1_aggregate`, `run_legacy_aggregate`, all three exact dispatch
   tests from Task 6, `run_server_all_targets`, `run_sessions_sanity`,
   `run_fmt_check`, `run_clippy`, and `run_both_guards`.
4. Run `amend_task6_tests_exact_scope "$MUTATION_BASE" "${changed_paths[@]}"`;
   then run `load_validated_task6_mutation_base`, call
   `create_mutation_scratch "$MUTATION_BASE"` to obtain a new random root and new
   root/worktree/gitdir identities, and rerun the entire mutation sequence from
   the first row. Never reuse the old path or identity tokens; prior kills do not
   count.

If investigation finds a production defect, never amend Task 6. Remove scratch
safely, return to Task 4 or 5, add an exact RED regression, repair/refactor/run
that task's GREEN and broader checks, rebuild the owning candidate commit, replay
all later tasks/commits, create a fresh Task-6 hash, and rerun every mutation.

Clean removal is non-forced and delegated only to the ownership-aware cleanup:

```bash
scratch_assert_clean
cleanup_mutation_scratch
trap - EXIT
test "${MUT_WT_OWNED:-0}" = 0
test "${MUT_TMP_OWNED:-0}" = 0
test ! -e "$MUT_WT"
assert_mutation_worktree_record absent
test -z "$(git -C "$WT" status --short)"
run_both_guards
```

Every mutation write, Cargo command, status read, restore, and removal rechecks
the captured identity before and after as applicable. Partial, dirty, replaced,
reused, locked/prunable, or otherwise ambiguous state is preserved and returns
nonzero. Never use pathname grep, reset, clean, forced removal, recursive
scratch deletion, or restore on active/foreign work.

`load_validated_task6_mutation_base` recovers only the committed mutation base.
It never establishes scratch ownership. If the shell is replaced after
`create_mutation_scratch` begins and before the clean-removal block completes,
stop and preserve the scratch: no fresh shell may call `scratch_restore`,
`cleanup_mutation_scratch`, or create another mutation scratch from
reconstructed path or identity values. Re-entry runs from the first ownership
probe only after an uninterrupted shell has reached a documented clean Task-7
boundary.

---

## G3: Explicit Finite Full-App Release A/B Manifest

The sole G3 Rust test is declared exactly as follows in
`session_directory_page_bound_g3_tests.rs`:

```rust
#[test]
#[ignore = "finite full-app release A/B gate; run explicitly in release"]
fn adverse_release_ab_non_regression() {
    assert!(
        !cfg!(debug_assertions),
        "G3_RELEASE_PROFILE_REQUIRED: run the ignored gate with --release",
    );
    assert_g3_integer_statistics_contract();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build G3 Tokio runtime");

    runtime.block_on(async {
        let expected_names = EXPECTED_G3_CASE_NAMES;
        let cases = g3_release_cases();
        let actual_names: Vec<_> = cases.iter().map(|case| case.name).collect();
        assert_eq!(
            actual_names.as_slice(),
            expected_names,
            "G3 generated manifest must equal the explicit ordered name manifest",
        );

        for case in &cases {
            run_g3_release_case(case).await;
        }

        println!(
            "G3_MANIFEST_RESULT cases={} measured_pairs_per_case={} result=PASS",
            expected_names.len(),
            MEASURED_PAIRS,
        );
    });
}
```

The ignore is load-bearing. Broad debug tests compile but skip this test. Both
explicit G3 invocations use `run_g3_release_gate`, which positively discovers
this exact ignored declaration, requires exactly one passed Rust test, and then
validates the complete marker transcript. No debug substitute or second G3 test
is permitted. This repeated quotation is the same source declaration, not a
second source test.

The G3 test owns this independent nonempty name operand:

```rust
const EXPECTED_G3_CASE_NAMES: &[&str] = &[
    "n0_t0_no_query_l50_none_empty",
    "n1_t0_no_query_l1_none",
    "n49_t1_no_query_l2_first_cursor",
    "n50_t50_no_query_l25_none",
    "n51_t0_no_query_l49_none",
    "n51_t0_no_query_l50_none",
    "n400_t1_no_query_l1_deep_cursor",
    "n28000_t0_no_query_l50_none",
    "n28000_t50_mixed_hidden_l25",
    "n28000_t1_all_hidden_l49",
    "n28000_t0_long_deleted_head_l50",
    "n28000_t0_all_deleted_l2",
    "title_early_dense_ascii_l1",
    "title_early_dense_ascii_l25_first_cursor",
    "title_late_sparse_4000_l2_deep",
    "title_no_match_ascii_l50",
    "title_no_match_unicode_expansion_l49",
    "title_combining_expansion_t50_l25",
    "t1_all_matched_l50",
    "t50_all_matched_l50",
    "t51_unsuppressed_synth_l50",
    "t500_all_matched_l50",
    "t500_unsuppressed_synth_l50",
    "t500_all_filtered_synth_l50",
    "duplicate_equal_colon_collision_l2",
    "identity_winner_fallback_collision_l25",
    "i64_boundaries_l49",
    "dense_valid_aux_t50_l50",
    "malformed_long_aux_t51_l25_colors",
    "title_colors_order_t1_l2_first_cursor",
];
```

The support module's concrete generated manifest is:

```rust
use self::G3ColorShape::{Empty, OrderedThree, OrderedTwo};
use self::G3CursorSpec::{IndexedOrdinal, TitleMatchOrdinal};
use self::G3FixtureShape::{
    AllDeleted, AllHidden, Base, DeletedHead, DenseValidAux,
    DuplicateEqualColonCollision, I64Boundaries, IdentityWinnerFallbackCollision,
    MalformedLongAux, MixedHidden, TitleDenseAscii, TitleLateSparse4000,
    TitleDenseAsciiWithDenseValidAux, TitleUnicodeCombiningHit,
    TitleUnicodeMiss4000,
};
use self::G3IdentityShape::{
    AllFilteredSynth, FixtureDefined, Matched, MatchedPlusOneSynth,
    UnsuppressedSynth,
};
use self::G3QuerySpec::Title;

const F000: G3Flags = G3Flags {
    include_subagents: false,
    include_non_interactive: false,
    include_empty: false,
};
const F101: G3Flags = G3Flags {
    include_subagents: true,
    include_non_interactive: false,
    include_empty: true,
};
const F111: G3Flags = G3Flags {
    include_subagents: true,
    include_non_interactive: true,
    include_empty: true,
};

const fn expected(
    item_count: usize,
    has_next_cursor: bool,
    title_annotations: bool,
    color_count: usize,
) -> G3ExpectedPage {
    G3ExpectedPage {
        item_count,
        has_next_cursor,
        title_annotations,
        color_count,
    }
}

fn case(
    name: &'static str,
    indexed_rows: usize,
    identities: usize,
    limit: usize,
    query: G3QuerySpec,
    cursor: G3CursorSpec,
    flags: G3Flags,
    fixture: G3FixtureShape,
    identity_shape: G3IdentityShape,
    colors: G3ColorShape,
    expected: G3ExpectedPage,
) -> G3ReleaseCase {
    build_g3_release_case(G3CaseSpec {
        name,
        indexed_rows,
        identities,
        limit,
        query,
        cursor,
        flags,
        fixture,
        identity_shape,
        colors,
        expected,
    })
}

pub(super) fn g3_release_cases() -> Vec<G3ReleaseCase> {
    vec![
        case("n0_t0_no_query_l50_none_empty", 0, 0, 50, G3QuerySpec::None, G3CursorSpec::None, F000, Base, Matched, Empty, expected(0, false, false, 0)),
        case("n1_t0_no_query_l1_none", 1, 0, 1, G3QuerySpec::None, G3CursorSpec::None, F000, Base, Matched, Empty, expected(1, false, false, 0)),
        case("n49_t1_no_query_l2_first_cursor", 49, 1, 2, G3QuerySpec::None, IndexedOrdinal(0), F000, Base, Matched, Empty, expected(2, true, false, 0)),
        case("n50_t50_no_query_l25_none", 50, 50, 25, G3QuerySpec::None, G3CursorSpec::None, F111, Base, Matched, Empty, expected(25, true, false, 0)),
        case("n51_t0_no_query_l49_none", 51, 0, 49, G3QuerySpec::None, G3CursorSpec::None, F000, Base, Matched, Empty, expected(49, true, false, 0)),
        case("n51_t0_no_query_l50_none", 51, 0, 50, G3QuerySpec::None, G3CursorSpec::None, F000, Base, Matched, Empty, expected(50, true, false, 0)),
        case("n400_t1_no_query_l1_deep_cursor", 400, 1, 1, G3QuerySpec::None, IndexedOrdinal(199), F000, Base, Matched, Empty, expected(1, true, false, 0)),
        case("n28000_t0_no_query_l50_none", 28_000, 0, 50, G3QuerySpec::None, G3CursorSpec::None, F000, Base, Matched, Empty, expected(50, true, false, 0)),
        case("n28000_t50_mixed_hidden_l25", 28_000, 50, 25, G3QuerySpec::None, G3CursorSpec::None, F101, MixedHidden, Matched, Empty, expected(25, true, false, 0)),
        case("n28000_t1_all_hidden_l49", 28_000, 1, 49, G3QuerySpec::None, G3CursorSpec::None, F000, AllHidden, Matched, Empty, expected(0, false, false, 0)),
        case("n28000_t0_long_deleted_head_l50", 28_000, 0, 50, G3QuerySpec::None, G3CursorSpec::None, F000, DeletedHead(20_000), Matched, Empty, expected(50, true, false, 0)),
        case("n28000_t0_all_deleted_l2", 28_000, 0, 2, G3QuerySpec::None, G3CursorSpec::None, F000, AllDeleted, Matched, Empty, expected(0, false, false, 0)),
        case("title_early_dense_ascii_l1", 28_000, 0, 1, Title("needle"), G3CursorSpec::None, F000, TitleDenseAscii, Matched, Empty, expected(1, true, true, 0)),
        case("title_early_dense_ascii_l25_first_cursor", 28_000, 1, 25, Title("needle"), TitleMatchOrdinal(0), F111, TitleDenseAscii, Matched, Empty, expected(25, true, true, 0)),
        case("title_late_sparse_4000_l2_deep", 28_000, 1, 2, Title("late-needle"), TitleMatchOrdinal(19), F000, TitleLateSparse4000, Matched, Empty, expected(2, true, true, 0)),
        case("title_no_match_ascii_l50", 28_000, 0, 50, Title("absent-ascii"), G3CursorSpec::None, F111, Base, Matched, Empty, expected(0, false, false, 0)),
        case("title_no_match_unicode_expansion_l49", 28_000, 0, 49, Title("absent-ω"), G3CursorSpec::None, F111, TitleUnicodeMiss4000, Matched, Empty, expected(0, false, false, 0)),
        case("title_combining_expansion_t50_l25", 400, 50, 25, Title("i\u{307}stanbul e\u{301}"), G3CursorSpec::None, F111, TitleUnicodeCombiningHit, Matched, Empty, expected(25, true, true, 0)),
        case("t1_all_matched_l50", 400, 1, 50, G3QuerySpec::None, G3CursorSpec::None, F111, Base, Matched, Empty, expected(50, true, false, 0)),
        case("t50_all_matched_l50", 400, 50, 50, G3QuerySpec::None, G3CursorSpec::None, F111, Base, Matched, Empty, expected(50, true, false, 0)),
        case("t51_unsuppressed_synth_l50", 0, 51, 50, G3QuerySpec::None, G3CursorSpec::None, F111, Base, UnsuppressedSynth, Empty, expected(50, true, false, 0)),
        case("t500_all_matched_l50", 500, 500, 50, G3QuerySpec::None, G3CursorSpec::None, F111, Base, Matched, Empty, expected(50, true, false, 0)),
        case("t500_unsuppressed_synth_l50", 0, 500, 50, G3QuerySpec::None, G3CursorSpec::None, F111, Base, UnsuppressedSynth, Empty, expected(50, true, false, 0)),
        case("t500_all_filtered_synth_l50", 0, 500, 50, G3QuerySpec::None, G3CursorSpec::None, F000, Base, AllFilteredSynth, Empty, expected(0, false, false, 0)),
        case("duplicate_equal_colon_collision_l2", 51, 50, 2, G3QuerySpec::None, G3CursorSpec::None, F111, DuplicateEqualColonCollision, FixtureDefined, Empty, expected(2, true, false, 0)),
        case("identity_winner_fallback_collision_l25", 49, 50, 25, G3QuerySpec::None, G3CursorSpec::None, F111, IdentityWinnerFallbackCollision, FixtureDefined, Empty, expected(25, true, false, 0)),
        case("i64_boundaries_l49", 51, 1, 49, G3QuerySpec::None, G3CursorSpec::None, F111, I64Boundaries, Matched, Empty, expected(49, true, false, 0)),
        case("dense_valid_aux_t50_l50", 28_000, 50, 50, G3QuerySpec::None, G3CursorSpec::None, F111, DenseValidAux, Matched, Empty, expected(50, true, false, 0)),
        case("malformed_long_aux_t51_l25_colors", 28_000, 51, 25, G3QuerySpec::None, G3CursorSpec::None, F111, MalformedLongAux, MatchedPlusOneSynth, OrderedTwo, expected(25, true, false, 2)),
        case("title_colors_order_t1_l2_first_cursor", 400, 1, 2, Title("needle"), TitleMatchOrdinal(0), F111, TitleDenseAsciiWithDenseValidAux, Matched, OrderedThree, expected(2, true, true, 3)),
    ]
}
```

`case(...)` is only concise notation for the complete `G3CaseSpec` literal:
every argument is explicit and no `..Default::default()` is permitted. The
literal expected-name list and literal case calls must compare exactly in the
sole test; shell transcript validation independently requires all 30 cases.

`build_g3_release_case` completes all deterministic setup before any
`Instant::now()`:

1. Base ordinals `i in 0..N` produce descending `IndexedSession` rows with
   provider `claude`, session `idx-{i:05}`, project/cwd `/g3/project`, title
   `visible-{i:05}`, absent remaining optionals, false flags, and
   `last_activity_at = 1_000_000_000i64 - i as i64`. Assert length and adjacent
   `(last_activity_at DESC, full key DESC)` order.
2. `g3_identity(terminal_id, provider, session_id, cwd, updated_at, is_subagent)`
   creates a fresh one-entry `TerminalIdentityRegistry`, calls `upsert`, calls
   `set_is_subagent` when non-`None`, and returns `get(terminal_id).unwrap()`.
   Build identity vectors in explicit loop order; never use `list()`.
3. `Matched` identities use `term-{i:05}`, the exact indexed provider/session,
   and row timestamp. `UnsuppressedSynth` uses `claude:synth-{i:05}`,
   `/g3/synth`, `2_000_000_000-i`, and no subagent classification.
   `MatchedPlusOneSynth` uses `T-1` matches plus one synth.
   `AllFilteredSynth` marks every synth as a subagent.
4. `MixedHidden` cycles deleted override, noninteractive, subagent, and
   `title=None` rows; flags 101 admit subagent/empty but reject the other two.
   `AllHidden` makes every indexed row subagent+untitled and its matching
   identity subagent-classified under flags 000.
5. `DeletedHead(20_000)` deletes exact rows `0..20_000`; `AllDeleted` deletes
   every exact indexed key.
6. `TitleDenseAscii` puts `needle` in every title.
   `TitleDenseAsciiWithDenseValidAux` applies that exact title behavior and also
   applies the complete `DenseValidAux` override/metadata behavior from rule 11;
   the composite is selected explicitly by the final manifest call rather than
   inferred from the case name or color variant.
   `TitleLateSparse4000` uses 4,000-character ASCII titles with exactly 100
   `late-needle` matches at ordinals 27,900..28,000; match ordinal 19 means
   independently known indexed ordinal 27,919.
7. `TitleUnicodeMiss4000` cycles 4,000-character dotted-I, sharp-s, sigma,
   combining, astral, and broad-Unicode fields while the query is absent.
   `TitleUnicodeCombiningHit` puts `İSTANBUL e\u{301}` in every title, matching
   Rust-lowercased `i\u{307}stanbul e\u{301}`.
8. `DuplicateEqualColonCollision` starts with explicit equal-time duplicates
   and both `("a","b:c")`/`("a:b","c")` component pairs, then appends base rows
   to exactly 51 and explicit first-winner identities to exactly 50. Assert both
   counts and the intended colliding full strings.
9. `IdentityWinnerFallbackCollision` has exactly 49 base rows and 50 explicitly
   ordered identities covering same-component duplicates, missing provider,
   missing/empty session IDs, and provider/session versus
   `terminal:<terminal_id>` synthesized-key collision. Assert component
   distinctions and full-key collisions.
10. `I64Boundaries` deletes row 0 at `i64::MAX`; every remaining row/identity is
    `<=0`, including `i64::MIN` and `-1`. Its expected revision is `Some(0)`;
    every other fixture uses `None`.
11. `DenseValidAux` gives every indexed key valid `titleOverride`,
    `summaryOverride`, alternating `archived`, valid `titleSource`, and metadata
    `sessionType:"kilroy"`. `MalformedLongAux` cycles nonobject/null/array,
    wrong-typed/empty fields, and 4,000-character values without setting
    `deleted:true`.
12. `OrderedTwo` inserts `/g3/z:#112233` then `/g3/a:#445566`;
    `OrderedThree` appends `/g3/m:#778899`. The expected static slices retain
    exact iteration order; `Empty` uses `&[]`.
13. Build `DirQuery` directly with `tier=Title`, `limit=Some(limit)`, all three
    explicit flags, exact optional query, and a cursor encoded by frozen
    `encode_cursor` from the independently selected indexed row—never by calling
    either strategy first.
14. Before return, assert exact N/T counts, `1<=limit<=50`, flags/query/cursor
    shape, fixture auxiliary/color cardinalities, and zero strategy calls during
    setup.

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

The G3 test performs and consumes real in-process full-app requests:

```rust
async fn completed_g3_request(app: &axum::Router) -> CompletedJsonResponse {
    use tower::ServiceExt as _;

    let response = app
        .clone()
        .oneshot(
            axum::http::Request::builder()
                .method(axum::http::Method::GET)
                .uri("/api/session-directory")
                .header("x-auth-token", "g3")
                .body(axum::body::Body::empty())
                .expect("build G3 request"),
        )
        .await
        .expect("execute G3 request");
    collect_completed_json_response(response).await
}

fn assert_g3_expected_page(case: &G3ReleaseCase, response: &CompletedJsonResponse) {
    assert_eq!(response.status, axum::http::StatusCode::OK, "{}", case.name);
    assert_ne!(response.status, axum::http::StatusCode::TOO_MANY_REQUESTS, "{}", case.name);
    assert_eq!(response.content_type, "application/json; charset=utf-8", "{}", case.name);

    let page: serde_json::Value =
        serde_json::from_slice(&response.body).expect("G3 response is JSON");
    let object = page.as_object().expect("G3 response is a page object");
    assert!(object.contains_key("items"), "{}", case.name);
    assert!(object.contains_key("nextCursor"), "{}", case.name);
    assert!(object.contains_key("revision"), "{}", case.name);
    let items = page["items"].as_array().expect("G3 items array");
    assert_eq!(items.len(), case.expected.item_count, "{}", case.name);
    assert_eq!(
        !page["nextCursor"].is_null(),
        case.expected.has_next_cursor,
        "{}",
        case.name,
    );
    if let Some(expected_revision) = case.expected_revision {
        assert_eq!(page["revision"].as_i64(), Some(expected_revision), "{}", case.name);
    }

    if case.expected.title_annotations {
        assert!(!items.is_empty(), "annotated G3 case must return an item");
        assert!(items.iter().all(|item| item.get("matchedIn").is_some()));
        assert!(items.iter().all(|item| item.get("snippet").is_some()));
    } else {
        assert!(items.iter().all(|item| item.get("matchedIn").is_none()));
        assert!(items.iter().all(|item| item.get("snippet").is_none()));
    }

    let actual_colors: Vec<_> = page
        .get("projectColors")
        .and_then(serde_json::Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(key, value)| {
                    (
                        key.as_str(),
                        value.as_str().expect("G3 project color must be a string"),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    assert_eq!(actual_colors.len(), case.expected.color_count, "{}", case.name);
    assert_eq!(actual_colors.as_slice(), case.expected_colors, "{}", case.name);
}
```

The finite protocol constants, checked helpers, and sample type are module
items used by the sole ignored test and its exact runner:

```rust
const TARGET_BASELINE_BATCH: Duration = Duration::from_millis(100);
const MAX_CALIBRATION_STEPS: usize = 21;
const MAX_REPEATS: usize = 1_048_576;
const DISCARDED_PAIRED_BATCHES: usize = 10;
const MEASURED_PAIRS: usize = 50;
const NS_PER_US: u128 = 1_000;
const RATIO_SCALE_PPB: u128 = 1_000_000_000;

#[derive(Debug, Clone, Copy)]
struct G3PairSample {
    baseline_ns: u128,
    fast_ns: u128,
    difference_ns: i128,
    ratio_ppb: u128,
    median_threshold_ns: u128,
    p95_threshold_ns: u128,
    median_overage_ns: i128,
    p95_overage_ns: i128,
}
```

```rust
fn round_div(n: u128, d: u128) -> Option<u128> {
    (d != 0).then_some(())?;
    n.checked_add(d / 2)?.checked_div(d)
}

fn ceil_ratio(n: u128, numerator: u128, denominator: u128) -> Option<u128> {
    (denominator != 0).then_some(())?;
    let product = n.checked_mul(numerator)?;
    product
        .checked_add(denominator - 1)?
        .checked_div(denominator)
}

fn checked_i128(value: u128) -> Option<i128> {
    i128::try_from(value).ok()
}

fn normalized_ns(raw_ns: u128, repeats: usize) -> Option<u128> {
    round_div(raw_ns, u128::try_from(repeats).ok()?)
}

fn ratio_ppb(fast_ns: u128, baseline_ns: u128) -> Option<u128> {
    (baseline_ns != 0).then_some(())?;
    round_div(fast_ns.checked_mul(RATIO_SCALE_PPB)?, baseline_ns)
}

fn median_twice_u128(sorted: &[u128]) -> Option<u128> {
    (sorted.len() == MEASURED_PAIRS).then_some(())?;
    sorted[24].checked_add(sorted[25])
}

fn median_twice_i128(sorted: &[i128]) -> Option<i128> {
    (sorted.len() == MEASURED_PAIRS).then_some(())?;
    sorted[24].checked_add(sorted[25])
}

fn assert_g3_integer_statistics_contract() {
    assert_eq!(round_div(5, 2), Some(3));
    assert_eq!(round_div(4, 3), Some(1));
    assert_eq!(ceil_ratio(101, 105, 100), Some(107));
    assert_eq!(round_div(1, 0), None);
    assert_eq!(ceil_ratio(1, 1, 0), None);
    assert_eq!(round_div(u128::MAX, 2), None);
    assert_eq!(ceil_ratio(u128::MAX, 2, 1), None);
    let sorted: Vec<u128> = (0..50).collect();
    assert_eq!(median_twice_u128(&sorted), Some(49));
    assert_eq!(sorted[47], 47);
}

async fn measure_g3_batch(app: &axum::Router, repeats: usize) -> u128 {
    assert!((1..=MAX_REPEATS).contains(&repeats));
    let started = std::time::Instant::now();
    for _ in 0..repeats {
        let response = completed_g3_request(app).await;
        std::hint::black_box(response);
    }
    started.elapsed().as_nanos()
}
```

The exact runner has no early-success path or selective retry. Its one body
contains, in order, warmup/equality, Materialized-only calibration, the complete
60-pair loop, and summary/assertions:

```rust
async fn run_g3_release_case(case: &G3ReleaseCase) {
let materialized_app = completed_strategy_app(
    ComparisonStrategy::ExtractedMaterialized,
    Arc::clone(&case.inputs),
    Arc::clone(&case.query),
    Arc::clone(&case.project_colors),
);
let fast_app = completed_strategy_app(
    ComparisonStrategy::Fast,
    Arc::clone(&case.inputs),
    Arc::clone(&case.query),
    Arc::clone(&case.project_colors),
);
let materialized_warm = completed_g3_request(&materialized_app).await;
let fast_warm = completed_g3_request(&fast_app).await;
assert_g3_expected_page(case, &materialized_warm);
assert_eq!(fast_warm, materialized_warm, "{} A/B completed response", case.name);
println!(
    "G3_WARMUP name={} equality=PASS status=200 body=page",
    case.name,
);
let mut repeats = 1usize;
let mut calibrated = false;
for step in 0..MAX_CALIBRATION_STEPS {
    let raw_ns = measure_g3_batch(&materialized_app, repeats).await;
    println!(
        "G3_CALIBRATION name={} step={} repeats={} raw_ns={}",
        case.name, step, repeats, raw_ns,
    );
    if raw_ns >= TARGET_BASELINE_BATCH.as_nanos() {
        calibrated = true;
        break;
    }
    repeats = repeats
        .checked_mul(2)
        .filter(|next| *next <= MAX_REPEATS)
        .unwrap_or_else(|| panic!("{} calibration did not reach 100ms", case.name));
}
assert!(calibrated, "{} calibration did not reach 100ms", case.name);

let mut samples = Vec::with_capacity(MEASURED_PAIRS);
for pair in 0..(DISCARDED_PAIRED_BATCHES + MEASURED_PAIRS) {
    let (first, materialized_raw_ns, fast_raw_ns) = if pair % 2 == 0 {
        let materialized = measure_g3_batch(&materialized_app, repeats).await;
        let fast = measure_g3_batch(&fast_app, repeats).await;
        ("materialized", materialized, fast)
    } else {
        let fast = measure_g3_batch(&fast_app, repeats).await;
        let materialized = measure_g3_batch(&materialized_app, repeats).await;
        ("fast", materialized, fast)
    };
    let baseline_ns = normalized_ns(materialized_raw_ns, repeats)
        .unwrap_or_else(|| panic!("{} invalid Materialized normalization", case.name));
    let fast_ns = normalized_ns(fast_raw_ns, repeats)
        .unwrap_or_else(|| panic!("{} invalid Fast normalization", case.name));
    let phase = if pair < DISCARDED_PAIRED_BATCHES {
        "discard"
    } else {
        "measure"
    };
    println!(
        "G3_PAIR name={} phase={} pair={} first={} repeats={} \
         materialized_raw_ns={} fast_raw_ns={} \
         materialized_normalized_ns={} fast_normalized_ns={}",
        case.name,
        phase,
        pair,
        first,
        repeats,
        materialized_raw_ns,
        fast_raw_ns,
        baseline_ns,
        fast_ns,
    );
    if phase == "discard" {
        continue;
    }

    let baseline_i = checked_i128(baseline_ns)
        .unwrap_or_else(|| panic!("{} baseline exceeds i128", case.name));
    let fast_i = checked_i128(fast_ns)
        .unwrap_or_else(|| panic!("{} Fast sample exceeds i128", case.name));
    let median_threshold = std::cmp::max(
        ceil_ratio(baseline_ns, 105, 100).expect("checked median ratio"),
        baseline_ns
            .checked_add(5 * NS_PER_US)
            .expect("checked median floor"),
    );
    let p95_threshold = std::cmp::max(
        ceil_ratio(baseline_ns, 110, 100).expect("checked p95 ratio"),
        baseline_ns
            .checked_add(10 * NS_PER_US)
            .expect("checked p95 floor"),
    );
    samples.push(G3PairSample {
        baseline_ns,
        fast_ns,
        difference_ns: fast_i.checked_sub(baseline_i).expect("checked difference"),
        ratio_ppb: ratio_ppb(fast_ns, baseline_ns)
            .unwrap_or_else(|| panic!("{} zero/overflow baseline ratio", case.name)),
        median_threshold_ns: median_threshold,
        p95_threshold_ns: p95_threshold,
        median_overage_ns: fast_i
            .checked_sub(checked_i128(median_threshold).expect("median threshold i128"))
            .expect("checked median overage"),
        p95_overage_ns: fast_i
            .checked_sub(checked_i128(p95_threshold).expect("p95 threshold i128"))
            .expect("checked p95 overage"),
    });
}
assert_eq!(samples.len(), MEASURED_PAIRS, "{}", case.name);
let mut materialized: Vec<_> = samples.iter().map(|s| s.baseline_ns).collect();
let mut fast: Vec<_> = samples.iter().map(|s| s.fast_ns).collect();
let mut differences: Vec<_> = samples.iter().map(|s| s.difference_ns).collect();
let mut ratios: Vec<_> = samples.iter().map(|s| s.ratio_ppb).collect();
let mut median_thresholds: Vec<_> =
    samples.iter().map(|s| s.median_threshold_ns).collect();
let mut p95_thresholds: Vec<_> =
    samples.iter().map(|s| s.p95_threshold_ns).collect();
let mut median_overages: Vec<_> =
    samples.iter().map(|s| s.median_overage_ns).collect();
let mut p95_overages: Vec<_> =
    samples.iter().map(|s| s.p95_overage_ns).collect();
materialized.sort_unstable();
fast.sort_unstable();
differences.sort_unstable();
ratios.sort_unstable();
median_thresholds.sort_unstable();
p95_thresholds.sort_unstable();
median_overages.sort_unstable();
p95_overages.sort_unstable();
for len in [
    materialized.len(),
    fast.len(),
    differences.len(),
    ratios.len(),
    median_thresholds.len(),
    p95_thresholds.len(),
    median_overages.len(),
    p95_overages.len(),
] {
    assert_eq!(len, MEASURED_PAIRS, "{} summary sample count", case.name);
}

let materialized_median_twice =
    median_twice_u128(&materialized).expect("Materialized median");
let fast_median_twice = median_twice_u128(&fast).expect("Fast median");
let difference_median_twice =
    median_twice_i128(&differences).expect("difference median");
let ratio_median_twice = median_twice_u128(&ratios).expect("ratio median");
let median_threshold_median_twice =
    median_twice_u128(&median_thresholds).expect("median threshold summary");
let median_overage_twice =
    median_twice_i128(&median_overages).expect("median overage");
let materialized_p95 = materialized[47];
let fast_p95 = fast[47];
let difference_p95 = differences[47];
let ratio_p95 = ratios[47];
let p95_threshold = p95_thresholds[47];
let p95_overage = p95_overages[47];
assert!(
    median_overage_twice <= 0,
    "{} median non-regression failed: overage_twice={median_overage_twice}",
    case.name,
);
assert!(
    p95_overage <= 0,
    "{} p95 non-regression failed: overage={p95_overage}",
    case.name,
);
println!(
    "G3_CASE_RESULT name={} repeats={} measured_pairs={} \
     materialized_median_twice_ns={} materialized_p95_ns={} \
     fast_median_twice_ns={} fast_p95_ns={} \
     difference_median_twice_ns={} difference_p95_ns={} \
     ratio_median_twice_ppb={} ratio_p95_ppb={} \
     median_threshold_median_twice_ns={} p95_threshold_p95_ns={} \
     median_overage_twice_ns={} p95_overage_ns={} result=PASS",
    case.name,
    repeats,
    MEASURED_PAIRS,
    materialized_median_twice,
    materialized_p95,
    fast_median_twice,
    fast_p95,
    difference_median_twice,
    difference_p95,
    ratio_median_twice,
    ratio_p95,
    median_threshold_median_twice,
    p95_threshold,
    median_overage_twice,
    p95_overage,
);
}
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
  `max(ceil(105 * baseline / 100), baseline + 5 * NS_PER_US)`; p95 threshold is
  `max(ceil(110 * baseline / 100), baseline + 10 * NS_PER_US)`, with
  `NS_PER_US = 1_000ns`. Equality passes.
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
| 7 | Deleted indexed row plus same-key live Synth replacement | typed deletion applies only to Indexed; same-key Synth survives with no override decoration; exact legacy replacement plus no-query/Title G1 ties |
| 8 | Deleted/Synth equal timestamp/key tie and duplicate deleted rows | every duplicate/equal Indexed candidate is skipped while exactly one first-winner Synth survives; equal-side preference is output-inert because only Indexed is deleted |
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
| 28 | Item/page key presence, insertion order, escaping, bytes | embedded pre-edit parent artifact plus direct current-owner/FrozenOld/ExtractedMaterialized equality; fixed-capture completed strategy bytes include A/B+B/A |
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
   (facade, materialized, three existing-test children, inputs, page-bound
   support, authority-fixtures, authority-tests, and narrow `main.rs`).
3. Task 1 — `refactor(session-directory): extract frozen materialized strategy`
   (facade, inputs, materialized, authority-tests).
4. Task 2 — `test(session-directory): characterize reusable legacy equivalence cases`
   (facade, page-bound support, legacy-tests).
5. Task 3 — `feat(session-directory): add borrowed matching decisions`
   (facade, fast, G2-tests).
6. Task 4 — `perf(session-directory): add page-bounded no-query candidate`
   (facade, inputs, fast, page-bound support, source-audit, G2-tests, G1-tests).
7. Task 5 — `perf(session-directory): add page-bounded title candidate`
   (fast, page-bound support, source-audit, G2-tests).
8. Task 6 — `test(session-directory): commit complete compatibility and mutation-killer gates`
   (page-bound support, G1-tests).
9. Task 7 — no new commit; only mechanically test-only strengthening may replace
   Task 6. Production defects rebuild Task 4/5 and replay.
10. Task 8 — `test(session-directory): add exact work and finite adverse release gates`
    (facade, page-bound support, G3-tests).
11. Task 9 — `perf(session-directory): route no-query requests through the fast path`
    (fast selector and G1 test only).
12. Task 10 — `perf(session-directory): route title search through the fast path`
    (fast selector and G1 test only).

There are eleven implementation commits because Task 7 is no-commit and Task 0A
is the independently required shared comment task. Materialized code remains
compiled and tested. A regression after release can roll back Task 10 and/or
Task 9 without state migration; do not edit either authority during rollback.
No persisted-state, client-query, cursor, or wire rollback is needed.

---

## Done Criteria

- Task 0 captures the canonical completed-response artifact from the unchanged
  pinned parent plus exact append-only recorder before any production edit or
  split; mechanically embeds/decodes/compares it; and replays from a fresh
  parent worktree after Task-0 commit and again at Task 10. Current owner,
  FrozenOld, ExtractedMaterialized, and final production route compare directly
  with that artifact. Changed code never emits expected parent bytes.
- The facade plus fourteen focused siblings stay at most 1,000 physical UTF-8
  lines after they exist. Pre-existing `main.rs` and read-only external
  `search.rs` are outside this blocker's new line gate. Every task scope, commit allowlist, authority
  map, audit source, test namespace, mutation target/amendment set, ledger entry,
  and line phase list uses the focused paths. `main.rs` still declares only
  `mod session_directory;`; Cargo and public API remain unchanged.
- Task 0A is the exact schema-adjacent comment and the sole shared/client-area
  change; its execution block runs the exact `git -C "$WT"` shared-file
  `diff --check` command and typecheck before commit. It introduces no Node
  behavior or wire-schema change.
- Task 0 pins `fc8646477dd34d92dc5647d158106431aa2e0380`, treats exact
  source/committed-fixture blobs only as provenance, and captures canonical raw
  completed responses through one ignored `Router::oneshot` parent test in a
  uniquely owned offline/network-isolated worktree. It never launches the
  network-capable production binary. Collision checks precede trap
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
  exact G2/G1 evidence. Typed deletion is Indexed-only:
  `candidate_is_deleted` returns false for Synth, both strengthened legacy
  fixtures preserve exactly one same-key first-winner Synth without override
  decoration, and G1 compares no-query plus Title across all three strategies.
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
  future scratch candidate, and then fails its exact Fast/selector killer under
  the strict mutation parser: Cargo status 101, sole exact failed test, its own
  `SESSION_DIRECTORY_MUTATION_KILL:<mutation-id>` marker exactly once in that
  test's failure detail and globally, exact one-name failure list, and one strict
  `0 passed; 1 failed; 0 ignored; 0 measured` summary. Compile failure,
  unrelated panic, environment error, arbitrary nonzero status, or malformed
  transcript is invalid setup. `defer-synth-on-greater` is observed by the mixed
  G2 fixture's forced Greater comparison and exact order/cursor assertions.
  `choose-last-identity` is observed by fixed A/B+B/A captures, never an owner
  iteration-order assumption. Scratch base equals the Task-6 commit rehydrated
  from validated active Git HEAD, including after a test-only amendment.
  Validation requires clean stable HEAD, exact Task-6 subject, a single direct
  Task-5 parent, both baseline Task-6 paths, and no path outside the
  amendment-eligible test set before assigning/exporting identical
  `TASK6_COMMIT` and `MUTATION_BASE` values. Fresh-shell recovery never
  reconstructs scratch ownership. Scratch operations never alter foreign work.
  Each mutation run uses a fresh private temp root and gains ownership only
  after exact NUL-safe registration/path/detached-HEAD/clean/root/worktree/gitdir
  identity checks. Mutation, Cargo, status, Fast-file-only restore, and
  non-forced removal revalidate that identity; ambiguous state is preserved.
  Before the real 17-mutation run, dedicated fresh-scratch probes A-H prove
  fail-closed absent ownership; root/worktree/gitdir token mismatch;
  locked/prunable registration; staged/untracked/extra restore refusal; and
  dirty-cleanup path/registration preservation without adding Rust tests.
- G3 is explicitly ignored in source and each explicit release invocation
  discovers that ignored declaration, requires exactly one passed Rust test, and
  validates the non-vacuous marker transcript. The sole body compares its
  explicit independent 30-name operand to 30 explicit generated case calls,
  constructs deterministic fixtures, executes and consumes Materialized/Fast
  full-app requests, asserts warmup response equality/expected pages, performs
  bounded calibration plus 10 discarded/50 measured alternating pairs, checks
  integer median/p95 thresholds, and emits every required statistic plus one
  final manifest marker. A comment-only body cannot pass. It remains
  synthetic/non-production.
- Tasks 9/10 each show exact test-first RED, minimal GREEN, refactor/rerun,
  broader checks, and isolated selector-only commits. Nonempty file tiers remain
  Materialized and rollback-ready.
- Exact/list/prefix/debug/release/scratch wrappers propagate failures, verify
  annotation mode and binary-scoped discovery, and require exactly one libtest
  summary with the expected positive passed count and zero
  failed/ignored/measured. Zero executed tests cannot pass. NUL-safe Git helpers
  reject foreign staged/unstaged/
  untracked work and never destructively recover it.
- Completion requires actual recorded successful future output from exact tests,
  `run_server_all_targets`, `run_sessions_sanity`, `run_fmt_check`, `run_clippy`,
  `run_shared_typecheck`, authority guards, mutations, G3, and
  `run_rest_parity_gate`. The final REST gate must retain its ignored
  `results.json` and `sweep.log`, report exactly `187 total / 187 pass / 0
  divergence / 0 deferred`, show all twelve named `session-directory` cases as
  `PASS`, and leave no `:1787x` listener. This plan does not claim those future
  results already exist.

---

## Writing-Plans Self-Review Record for This Rendered Plan

This record evaluates the corrected plan text only, not future implementation,
build, test, mutation, selector, or release-gate results.

### 1. Spec coverage: map every requirement to a task and list gaps.

**Result: PASS for corrected plan text.**

| Requirement | Corrected tasks/sections |
|---|---|
| LB-01 three scopes, schema-adjacent shared wording, NoIndex, observable fixed-capture identity order, owner acquisition without requested registry order, success-only colors, completed full-app bytes, accessor semantics | Global Constraints; Task 0A; Tasks 0–2/6; deterministic single-identity owner raw manifest; same-unchanged-registry owner assertion; fixed A/B+B/A completed evidence |
| LB-02 independent pre-extraction provenance, transitive Task-0 freeze, separate Task-1 freeze, same-delta rebaseline | Task 0's independently captured pinned-parent completed-response artifact, with source/fixture blobs retained only as provenance, plus order-insensitive/single-identity owner/full-layer manifest and relational same-registry acquisition; Two Authorities; Task 1; Rebaseline lifecycle |
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
- The plan never launches the network-capable production parent binary. Exact
  Git blobs and committed fixture bytes are provenance and reproducibility
  inputs only. The response authority is the canonical raw completed-response
  artifact emitted by the one ignored, in-process `Router::oneshot` parent test
  inside an offline network namespace, then mechanically embedded and replayed.
- One lexical/call-graph helper defines the exact three producer and two
  non-producing helper sets for all static G2 tests and rejects every uncounted
  direct, clone, or recursively indirect Fast production path.

Gaps found and corrected in this historical review were the behavior-inert merge
mutation and nondeterministic ordered-owner raw promises above. The earlier
two-correction review did not adjudicate the later five-blocker Fresh Eyes round.
Its conclusions are historical only; five-blocker closure is determined solely
by the dated corrective round-2 rerun below.

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
- The earlier two-correction review did not adjudicate the later five-blocker
  Fresh Eyes round. Its conclusions are historical only; the corrective round-2
  rerun below determines scoped closure.

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
- `load_validated_task6_mutation_base` validates clean stable active HEAD against
  the Task-6 subject/single Task-5 parent/required-and-allowed path contract
  before assigning and exporting identical `TASK6_COMMIT`/`MUTATION_BASE`
  values. It runs after the Task-6 producer, unconditionally at every Task-7
  entry or re-entry, and after a guarded test-only amendment. It recovers only
  the commit boundary and never reconstructs scratch ownership after shell
  replacement.
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
  scratch cleanup are fail closed and non-destructive to foreign work. Exact
  parent blobs are provenance; one ignored parent test executes in an offline
  network namespace through the positive-cardinality parser.

The earlier review remains historical context for its two corrections. The
bounded Fresh Eyes iteration 1 rerun below is authoritative for the five newly
authorized blockers. No future build, test, parent capture/replay, mutation
compile/kill, G1, G2, G3, selector, line-count, or release result is claimed.

### Fresh Eyes iteration 1 five-blocker rerun — 2026-08-12

Scope: only edited tasks and every transitive consumer of changed paths,
namespaces, artifact definitions, mutation identities, counts, and commands.
This rerun was skill-free and static; no Cargo/npm test, compilation, worktree
operation, recorder, mutation, G3, server, or runtime gate was executed.

#### Pass 1 — requirement coverage and scope

**Result: FAIL — superseded by corrective round 2.**

Concrete misses in this first-round render:

- Task-0 Step 1 invoked future-file and subject-anchored post-commit gates;
- detailed Step 2 emitted provenance only instead of canonical raw responses;
- parent build/output/tool-home lifecycle and replay implementation were
  undefined, and the exact parent-recorder declaration was absent;
- accessor trace was missing from the frozen marker map;
- one source-audit call still read the monolith and no exact source constant
  connected all three consumers;
- mutation ownership lacked the second post-clean identity check and had no
  deterministic negative probes;
- the split had no complete 68-source/pre-post-binary inventory proof or
  retained historical exact-command execution;
- line-limit wording accidentally included pre-existing `main.rs`;
- the G3 section lacked the repeated exact ignored declaration; and
- stale source/fixture-authority and global-gap wording remained.

- Task 7 now uses a fresh mode-`0700` root per run; exact NUL-safe registration,
  canonical path, detached HEAD, clean state, root/worktree/gitdir filesystem
  identities, ownership pre/post checks, Fast-file-only unstaged restore, and
  one non-forced removal. Ambiguous state is retained. Amendment recreation
  captures entirely new identities.
- Task 4 defines Indexed-only `candidate_is_deleted`; Synth is false, remains
  undecorated, and reappears for a deleted same-key indexed row. Both legacy
  fixtures and the no-query/Title G1 comparison preserve the existing 33/21/18
  inventories and 17-mutation set.
- Exact/prefix/release runners use the `freshell-server` binary, identical
  discovery/execution selection, annotation checks, one libtest summary, and
  positive passed cardinality. The release G3 source declaration is explicitly
  ignored and each explicit invocation requires one passed test.
- The parent artifact is captured before the split/production edits from the
  pinned parent plus exact recorder/manifest in an offline network namespace,
  embedded mechanically, decoded/compared, consumed directly by current owner,
  FrozenOld, ExtractedMaterialized, and final route, and replayed from fresh
  parent worktrees after Task 0 and Task 10.
- The focused facade plus 14 responsibility-named siblings obey the binding
  `<=1000` physical-line rule. Module declarations, phased line lists, task
  scopes, commit path sets, authority map, source audit, test namespaces,
  mutation target, amendment allowlists, ledger, matrix, and Done Criteria use
  those paths.

Static scope evidence: Git status/diff named only
`docs/plans/2026-08-11-session-directory-page-bound.md`; diff-check returned
zero. Counts remained parent `22/21`, Task-0 `9`, Task-1 `6`, legacy/G1/G2
`33/21/18`, G3 `30`, mutations `17`, matrix `35`, exhaustive
`37,120/111,360`, and implementation commits `11` (12 ledger rows including
no-commit Task 7).

#### Pass 2 — placeholder, stale-token, and lifecycle scan

**Result: FAIL — superseded by corrective round 2.**

- The stale-token scan returned zero for the old combined test namespace,
  predictable mutation path, post-change parent emitter, source/fixture response
  authority constant, generic Fast candidate deletion, staged restore,
  pathname-grep cleanup, and old no-new-file claim.
- All 14 future sibling paths occur in exactly one responsibility row; each is
  introduced only by the task that creates a nonempty file. Five phased line
  arrays are uniquely defined. Current donor paths and all seven pinned-parent
  blobs exist.
- Artifact flow is producer-before-consumer:
  recorder -> parent capture -> clean parent removal -> split -> mechanical
  embed/decode/cmp -> Task-0 commit -> fresh replay -> exact evidence cleanup.
  Changed code cannot emit expected parent bytes.
- Mutation flow is producer-before-consumer and fail closed:
  Task-6 commit -> fresh ownership capture -> mutation/Cargo/kill -> Fast-only
  restore -> guarded cleanup; amendment requires explicit test-only paths and
  creates a fresh scratch identity before all 17 rerun.

Fresh-shell `TASK6_COMMIT` persistence was out of scope for iteration 1. For
issue 4, that iteration-1 non-adjudication is superseded by the Fresh Eyes
iteration-2 validated-HEAD loader and explicit no-scratch-reconstruction
boundary. Broad-test coordinator and e2e disposition remain outside the
iteration-1 review scope.

#### Pass 3 — names, types, paths, inventories, and semantic observability

**Result: FAIL — superseded by corrective round 2.**

- Five test namespace constants align all exact/prefix calls and the exact
  33/21/18 inventories; normal prefixes require no ignored members.
- Mutation dictionary, `EXPECTED_MUTATIONS`, killer table (including expanded
  three `invert-*` IDs), and literal run sequence are the same 17 unique IDs.
  `deletion-after-selection` uses `candidate_is_deleted` before and after
  selection, preserving Synth exemption and exact `1/0 -> 0/1` anchor checks.
- The explicit parent names remain 22 with exactly 21 strategy-comparable cases;
  cursor cases retain ordered two-exchange evidence. Tree, seven blobs,
  recorder/manifest/input hashes, base64 raw bodies, and direct four-operand
  equality are all required.
- The explicit G3 table remains 30 rows, behavior matrix remains 35 rows, and
  selector state remains all Materialized through Task 8, no-query Fast in Task
  9, Title Fast in Task 10, and nonempty file tiers Materialized.
- TOML inspection confirmed `crates/freshell-server/Cargo.toml` declares the
  `freshell-server` binary required by `--bin freshell-server`.

#### Pass 4 — command executability, RED/GREEN order, and downstream gates

**Result: FAIL — superseded by corrective round 2; runtime evidence remains
future.**

- `bash -n` passed all 40 Bash fences. Python `compile()` passed all 18 Python
  heredocs. Every Bash Git command uses `git -C`; every Cargo command has an
  absolute manifest directly or through `cargo_server_test`.
- Parent capture precedes the behavior-neutral split; that split uses baseline
  and broader GREEN rather than a fake RED. Task-0 missing-assembler RED and
  Task-1 missing-Materialized RED retain exactly one unresolved reference at the
  declared point. Deletion expectations precede Fast implementation.
- Identical focused tests rerun for GREEN/refactor. All-Materialized-through-
  Task-8 and Task-9/10 selector RED/GREEN ordering are unchanged.
- Successful exact tests require one pass, prefixes require exactly 33/21/18
  passes, and parent-recorder/G3 ignored runs require exactly one pass. Exit-zero
  with zero executed tests, wrong annotation mode, ignored prefix members,
  malformed/extra summaries, or nonzero failed/ignored/measured counts fail
  closed.
- Diff inspection confirmed only the authorized plan changed; no implementation,
  support, Cargo, dependency, `.kata.toml`, client, Node, oracle, fixture,
  benchmark, PR, or live-server action occurred.

**Round-1 conclusion: FAIL.** The first edit closed substantial parts of the five
authorized blockers but did not produce an executable Task-0 authority/split
sequence and missed the transitive checks listed above. This record is retained
for audit history and is superseded only by a passing corrective round-2 static
rerun. No implementation/runtime result is claimed.

### Fresh Eyes iteration 1 corrective round 2 rerun — 2026-08-12

This is the full static Self-Review over both edit rounds. It reviews plan text,
not future implementation. No Cargo/npm test, Rust compilation, worktree
creation/removal, parent recorder, mutation, G3, server, or runtime feature
command was executed.

#### 1. Scope, syntax, and command executability

**Result: PASS.**

- Path-prefixed Git status/diff named only
  `docs/plans/2026-08-11-session-directory-page-bound.md`; `diff --check`
  returned zero.
- Static parsing passed all 44 Bash fences with `bash -n` and all 27 Python
  heredocs with `compile()`; there are zero standalone Python fences.
- Every Bash-fence Git command uses `git -C`. Every Cargo command carries an
  absolute manifest directly or through the defined `cargo_server_test` wrapper.
- Five current donor/manifest paths and all seven pinned-parent blobs exist.
  TOML inspection confirms the `freshell-server` binary target.

#### 2. Definitions, lifecycle, and Task-0 phase ordering

**Result: FAIL — superseded by the final corrective addendum.** Parent ownership
preceded a complete second identity check, and cleanup was not fully fail closed.

- Definition/call counts are exact:
  `capture_pinned_parent_authority=1/1`,
  `install_captured_parent_authority=1/1`,
  `replay_pinned_parent_authority=1/2`,
  `init_task0_evidence_root=1/1`,
  `capture_presplit_server_test_inventory=1/1`, and
  `verify_postsplit_server_test_inventory=1/2`.
- `canonical_path`, `path_identity`, and `path_mode` each have one shared
  definition before Task-0 and mutation use.
  `assert_parent_build_root_owned` and
  `capture_parent_artifact_from_recorder` each have one definition and at least
  two consumers.
- Task-0 ordering statically resolves as:
  preflight/shared guard/pre-split inventory -> canonical parent capture ->
  mechanical split/complete inventory/historical exact path/first line gate ->
  one-way artifact installation -> focused RED/GREEN ->
  complete precommit inventory/line/working authority guard ->
  exact commit -> subject-anchored guard -> fresh replay -> evidence finalization.
- Step 1 contains no future-file line gate and no `run_task0_guard`; the first
  subject-anchored Task-0 guard is after `commit_exact_scope`.

#### 3. Independent parent authority and direct operands

**Result: FAIL — superseded by the final corrective addendum.** The three-layer
comparison and exact evidence-root enumeration were prose-only, and no-package
`cargo clean` made the unconditional target `rmdir` fail.

- The harness defines every required capture/install/replay/cleanup API and all
  parent/evidence/build/worktree variables before use.
- The exact temporary recorder API and ignored entrypoint annotation are
  present. The command passes `FRESHELL_PARENT_AUTHORITY_OUT`, uses offline
  `env -i` plus a network namespace, and passes through
  `run_cargo_test_success 1`.
- The validator requires canonical JSON, exact parent/tree/seven blobs,
  recorder/manifest hashes, ordered 22/21 cases, unique owner-input hashes,
  exact one/two-exchange shapes, statuses/content type, and strict raw-body
  base64.
- Installation is captured bytes -> fixed-width base64 -> embedded strict
  decode -> SHA-256 -> `cmp`. Task-0 and Task-10 replay each allocate a fresh
  root and compare against the frozen Task-0 artifact.
- `parent-authority-accessor-trace` occurs once in the prose inventory and once
  in the executable map. Working/precommit and subject-anchored guards link the
  exact current-owner, FrozenOld, ExtractedMaterialized, final-route, and replay
  operands directly to the artifact.

#### 4. Module split, inventories, audit, and line scope

**Result: FAIL — superseded by the final corrective addendum.** Blank inventory
and unsupported test forms could be omitted.

- The static donor manifest is exactly join/core/route/search
  `11/28/17/12 = 68` unique names; every name occurs exactly once in the pinned
  parent source.
- Complete pre/post compiled binary inventory functions are defined and called
  in `split-only` and `task0` modes. The historical
  `session_directory::tests::invalid_utf8_transcript_is_indexed_lossily_like_node`
  path is explicitly executed both after the split and precommit.
- `FAST_AUDIT_SOURCES` has one definition, one materialized include, one Fast
  include, exactly three consumers, and zero old-monolith consumers.
- The phased arrays contain exactly the facade plus fourteen focused siblings
  (15 unique paths). `main.rs` and external `search.rs` occur zero times in
  those arrays and are explicitly outside this blocker's new line gate.

#### 5. Mutation ownership and Indexed-only deletion

**Result: FAIL only for Probe G's unsafe restoration — superseded by the final
corrective addendum. Indexed-only deletion remains PASS.**

- Acquisition order is identity -> clean read -> identity -> `MUT_WT_OWNED=1`.
- Fresh-scratch probes A-H cover absent ownership; each root/worktree/gitdir
  identity-token mismatch; locked/prunable registration; untracked/staged/extra
  restore refusal; and dirty-cleanup path/registration preservation. The real
  mutation scratch is created only after all probes.
- No force/reset/Git-clean/recursive deletion/pathname-grep recovery was added.
- Dictionary, expected set, killer table, and literal sequence remain the same
  17 IDs. `candidate_is_deleted` and the corrected
  `deletion-after-selection` anchor preserve Indexed-only deletion and Synth
  reappearance.

#### 6. G3, stale claims, and preserved counts

**Result: PASS.**

- The exact G3 ignore annotation occurs twice in plan contracts—Task 8 and the
  G3 section—while the source contract remains one test and both invocations
  require one passed ignored release test.
- Round 1 is marked FAIL/superseded. Stale provenance-only response authority,
  old monolith audit, post-change emitter, and global remaining-gaps-none claims
  have zero active occurrences.
- Preserved counts are exact: parent `22/21`, Task-0 `9`, Task-1 `6`,
  legacy/G1/G2 `33/21/18`, G3 rows `30`, mutations `17`, matrix rows `35`,
  exhaustive `37,120/111,360`, and 11 implementation commits (12 ledger rows
  including no-commit Task 7).

**Corrective round-2 conclusion: FAIL — superseded by the final corrective
addendum.** The edit closed the earlier sequencing/path/count gaps but left the
four executable failures above. Implementation/runtime evidence remains future;
unrelated pre-existing conditions were not adjudicated.

### Fresh Eyes iteration 1 final corrective addendum rerun — 2026-08-12

This bounded writing-plans Self-Review covers all three edit rounds. Round 1 and
corrective round 2 remain historical FAIL records above. This final rerun is
static only: no Cargo/npm test, Rust compilation, worktree operation, parent
capture/replay, mutation, G3, server, or runtime feature command was executed.

#### 1. Parent pre-ownership identity ordering

**Result: PASS.**

- `assert_parent_worktree_identity`,
  `assert_parent_capture_identity`, and `assert_parent_capture_owned` each have
  exactly one definition before use.
- The acquisition checker found exact order:
  captured tokens -> complete capture identity -> successful clean-status
  assignment/empty check -> complete capture identity ->
  `PARENT_WT_OWNED=1` -> owned assertion.
- The complete predicate covers temp-root canonical path/mode/inode,
  registration, worktree path/inode/top-level/HEAD, gitdir path/inode, and the
  owned build root. The ownership flag is false through both checks.

#### 2. Parent cleanup gating, Cargo target transition, and flag clearing

**Result: PASS.**

- Static command-order validation found one guarded `cargo clean`, zero
  `rmdir "$PARENT_BUILD_TMP/target"`, one explicit target-absence check, and one
  non-forced worktree removal.
- Every destructive command is dominated by `cleanup_status == 0`; negative
  early-ownership, restored-target-rmdir, and removed-gate fixtures all failed
  the checker.
- The post-clean predicate requires target absence plus exactly empty `home` and
  `tmp`. Worktree removal has identity -> successful empty status -> identity
  ordering.
- Worktree/build/temp ownership flags clear only after the corresponding path,
  registration/gitdir where applicable, `rmdir`, and absence proof.

#### 3. Executable three-layer comparison

**Result: PASS.**

- `extract_active_parent_recorder` contains one
  `normalized_layer_calls` definition, exactly one recorder invocation, exactly
  one pinned-main invocation, an exact-three check, and hard inequality failure.
- Unit-level copied-normalizer samples passed comment/whitespace equivalence and
  rejected reordered, changed, two-call, four-call, unterminated-comment, and
  unterminated-literal inputs.

#### 4. Exact six-file evidence enumeration before deletion

**Result: PASS.**

- Finalization requires a six-path unique direct-child allowlist, enumerates the
  root with `os.scandir` before `rm --`, rejects symlink/non-regular entries, and
  requires actual names equal expected names.
- `TASK0_EVIDENCE_OWNED=0` follows root `rmdir` and absence proof.
- Temporary-directory samples accepted exactly six regular files and rejected an
  extra file, missing file, symlink, and directory before deletion.

#### 5. Nonblank, exact-range, unsupported-form inventory enforcement

**Result: PASS.**

- The shell declaration lister ends with `count > 0`; pre/post readers reject
  empty, blank, and duplicate declarations.
- All five stable range anchors occur once and in order. The pinned donor source
  matches exact ordered `11/28/17/12` lists (68 unique names).
- Unsupported test-like attributes and module-level macros fail closed.
  Temporary copied-source samples rejected blank inventory, an extra test,
  `#[rstest]`, `generate_tests!()`, and a renamed expected donor.
- Complete compiled mapping/count/SHA checks, split-only equality, Task-0
  `pre_count + 9`, and the historical exact-path execution remain present.

#### 6. Probe E/F/G/H byte-exact preservation and restoration

**Result: PASS.**

- `assert_exact_probe_line` has one definition before use. Probes E, F, and H
  use it before removing their known files, preserving trailing LF.
- Probe G constructs complete expected bytes from base plus the unique suffix,
  compares failed-restore bytes to that expected file, checks exact total length,
  base prefix, and suffix, rewrites only after all checks, and compares the
  result with the saved base.
- Old tail-only, inequality-only, and unconditional `cat` restoration paths have
  zero occurrences. A temporary same-final-line/interior-byte mutation failed
  the copied exact restoration predicate.

#### 7. Syntax, scope, preserved counts, and stale-token closure

**Result: PASS.**

- `bash -n` passed all 44 Bash fences; `compile()` passed all 32 Python
  heredocs; there are zero standalone Python fences.
- Git status/diff names only
  `docs/plans/2026-08-11-session-directory-page-bound.md`; `diff --check`
  returned zero. Every Bash Git command uses `git -C`, and Cargo commands retain
  absolute manifests directly or through defined wrappers.
- Preserved counts remain parent `22/21`, Task-0/Task-1 `9/6`,
  legacy/G1/G2 `33/21/18`, G3 rows `30`, mutations `17`, matrix `35`,
  exhaustive `37,120/111,360`, and 11 implementation commits. Line phases remain
  `9/10/12/14/15`; `FAST_AUDIT_SOURCES` remains one definition/three consumers;
  both selector commits remain mandatory and reversible.
- The current round-2 closure is historical FAIL. Global remaining-gaps-none
  language is absent, and this is the sole final three-sentence closure.

The five authorized Fresh Eyes iteration 1 blockers are closed in plan text
after corrective round 2. Implementation/runtime evidence remains future.
Unrelated pre-existing conditions were not adjudicated.

### Fresh Eyes iteration 2 corrective Self-Review — 2026-08-12

This appended review retains the historical PASS/FAIL conclusions above while
making the two explicitly required issue-4 lifecycle clarifications in their
original review locations. It supersedes only the four iteration-2 blocker
conclusions. It is a skill-free static review of the rendered plan. No Cargo
build/test, G3 release run, REST sweep, server launch, production restart,
mutation worktree, or implementation command was executed; all such runtime
evidence remains future.

#### 1. Mandatory final Node/Rust REST parity gate

**Result: PASS for plan text; future sweep evidence remains open.**

- The fail-closed harness defines one `run_rest_parity_gate`. It builds the Node
  client/server and Rust release server, verifies all expected artifacts,
  refuses occupied ports 17871/17872/17876/17877, stores `results.json` and
  `sweep.log` under the ignored worktree `.worktrees/` directory, and runs the
  existing unmodified `port/oracle/rest-parity/sweep.mjs`.
- The artifact predicate requires exactly 187 records, summary
  `187/187/0/0`, every verdict `PASS`, the exact twelve session-directory IDs,
  and empty `orphanCheck.ssListeners`. It intentionally does not reject
  `pgrepRust`, which may see the authorized live service on port 3001.
- Task 10 invokes the gate exactly once after its selector-only commit and
  pinned-parent replay. Done Criteria names the gate and retained evidence, so
  Rust-local authority/G1/G2/G3 checks cannot substitute for the declared
  external comparator.
- Static execution of the extracted artifact validator against the committed
  baseline printed: `REST parity gate passed: 187/187 PASS; 12/12
  session-directory cases PASS; evidence=/tmp/static-rest-parity-evidence`.
  This validates only the predicate and historical artifact, not the future
  final candidate or sweep runtime.
- Extracted-validator probes produced `valid=ACCEPT`; `bad-summary`,
  `short-results`, `non-pass`, `session-id-drift`, and `listener-left` all
  produced `REJECT`.

#### 2. Non-vacuous sole G3 release protocol

**Result: PASS for plan text; future release execution remains open.**

- Both plan presentations quote the same executable ignored source body;
  comment-only bodies are absent. There remains one source test in the existing
  G3 module and no dependency, feature, target, fixture file, listener, or
  second test.
- The independent name operand has 30 unique names. The support vector has 30
  explicit complete case calls in the identical order and no default-hidden
  dimension. Deterministic fixture rules cover indexed rows, registry-built
  identities, hidden/deleted/title/Unicode/collision/i64/auxiliary/color/cursor
  shapes before timing.
- The final row explicitly selects
  `TitleDenseAsciiWithDenseValidAux`; its construction applies both dense
  `needle` titles and the complete dense-valid override/metadata contract.
  Neither the row name nor `OrderedThree` hides that auxiliary behavior.
- Every case constructs Materialized and Fast full-app routers, executes and
  consumes requests, validates the expected Materialized page and exact A/B
  completed response, calibrates Materialized, runs 10 discarded plus 50
  measured alternating pairs, performs checked normalization/ratio/median/p95
  assertions, and emits complete warmup/calibration/pair/case/final markers.
- There is exactly one async `run_g3_release_case` declaration with the required
  `&G3ReleaseCase` parameter and exactly two calls from the byte-identical test
  quotations. One connected Rust fence contains warmup, calibration, the
  60-pair loop, and summary/assertions in that order; it has no
  return/early-success or retry path. `rustfmt` parsed the extracted runner
  successfully.
- Rust-fence symbol scanning found one `NS_PER_US` declaration and two code
  uses, in the exact `5 * NS_PER_US` and `10 * NS_PER_US` threshold floors. An
  isolated `rustc -D warnings` probe using those exact expressions returned
  zero, closing the prior dead-constant defect without claiming a future crate
  build or clippy result.
- Both required Task-8/Task-10 sites invoke `run_g3_release_gate`. Its verifier
  requires 30 unique ordered warmups/summaries, bounded doubling calibration,
  exactly 30×60 ordered pairs, complete statistics, and one final marker.
- Extracted-verifier probes produced:
  `valid=ACCEPT`, while `comment-only`, `29-summaries`, `missing-warmup`,
  `49-measured`, `missing-statistic`, and `duplicate-final` all produced
  `REJECT`.
- Minimal report-snippet correction: the concise `case(...)` wrapper is an
  ordinary Rust function, not a `const fn`, because it calls the specified
  non-const `build_g3_release_case`; every operand remains explicit and the
  report's no-hidden-dimension invariant is unchanged.

#### 3. Mutation-specific kill proof

**Result: PASS for plan text; future 17-mutation execution remains open.**

- The mutation dictionary and all 17 literal invocations are byte-for-byte
  unchanged from `HEAD`. The expanded 17-row killer table has the same ordered
  IDs and one mechanically derived
  `SESSION_DIRECTORY_MUTATION_KILL:<mutation-id>` marker per row.
- Task 4/5/6 contracts place each marker on its direct named semantic
  observation before generic equality/audit assertions, with independent
  subcases for shared killers. No test is added or renamed.
- `scratch_require_killed` now receives `"$mutation" "$killer"` and accepts only
  Cargo status 101, one exact selected FAILED status, one selected failure
  detail containing the exact marker once and globally once, one exact failure
  list name, and one strict `0/1/0/0` summary.
- The actual extracted parser accepted the valid synthetic transcript and
  rejected status 0, status 1, unrelated panic, environment error plus forged
  status, wrong test, extra status, marker outside detail, duplicate marker,
  malformed summary, extra summary, passed/second-failed/ignored/measured
  counts, and wrong failure-list name.

#### 4. Clean-boundary Task-6 recovery

**Result: PASS for plan text; future Task-6/Task-7 execution remains open.**

- `TASK6_BASE_FILES`, `TASK6_TEST_FILES`, and `TASK6_PRODUCTION_FILES` each have
  one definition before first use. The loader reads neither destination before
  assignment and is called unconditionally after Task 6 and at Task-7 entry;
  amendment instructions call it again before creating fresh scratch.
- The stale earlier self-review summary now states the validated-HEAD flow at
  the Task-6 producer, every Task-7 entry/re-entry, and post-amendment. The
  iteration-1 historical note now records that fresh-shell persistence was then
  out of scope and is superseded for issue 4 by this iteration-2 loader and
  no-scratch-reconstruction boundary.
- Extracted-loader probes accepted valid initial and amended synthetic Task-6
  histories with both exported variables equal to active HEAD. They rejected
  wrong Task-6 subject, wrong direct-parent subject, merge HEAD, missing baseline
  path, outside path, dirty status, Task-5 HEAD, Task-8 HEAD, changed second HEAD,
  and changed second status.
- Fresh-shell scanning found no direct nounset-guard dependency on the old
  Task-6 shell variable and no mutation-base assignment from that old value. No
  scratch path, inode, Git-dir, run-ID, or ownership token is persisted or
  reconstructed. Shell replacement
  after scratch creation requires stop-and-preserve, never restore/removal/reuse
  or another scratch.

#### 5. Full writing-plans static rerun

**Result: PASS.**

- Mechanical Markdown extraction found 84 total fences. All 44 Bash fences
  passed `bash -n`; all 40 embedded Python heredocs compiled; standalone Python
  fences remain zero.
- `rustfmt --edition 2021 --emit stdout` parsed all nine edited G3 Rust fences:
  the support contract, both identical test quotations, expected names,
  manifest, request/page helpers, constants/sample type, checked helpers, and
  the connected runner. This is static syntax/format plausibility only, not a
  future crate build.
- Affected invariants passed: two identical executable G3 body quotations; one
  runner declaration/two calls with ordered connected blocks; one 30-name
  operand equals one ordered 30-call vector; the final composite fixture is
  explicit; `NS_PER_US` has two threshold uses; two G3 gate invocations; one
  final REST invocation after replay; twelve REST session-directory IDs; 17
  unchanged literal mutation invocations equal the 17-row marker table; one
  definition of each Task-6 path set; two shell loader calls plus the amendment
  consumer; both required historical review replacements; and no stale direct
  Task-7 `TASK6_COMMIT` read.
- `git diff --check` returned zero. Path-qualified status/diff named only
  `docs/plans/2026-08-11-session-directory-page-bound.md`.

The four Fresh Eyes iteration-2 blockers are closed as executable plan behavior.
Actual Cargo, mutation, G3, and final REST success remain required future
completion evidence and are not claimed by this static correction.
