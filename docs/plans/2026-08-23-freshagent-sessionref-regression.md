# 2026-08-23 — fresh-agent sessionRef regression guard + Rust REST resume

## User Request

### Requested result
Fix the root cause of a Freshell regression where a client state push (tabs.sync/persist pipeline, observed ~2026-08-23 20:53 UTC) overwrote fresh-agent OpenCode panes' materialized sessionRef (`ses_…`) with re-derived placeholders (`freshopencode-<requestId>`), leaving blank/unrecoverable panes. Two adopted katas:

1. Guard so the persist/tabs.sync pipeline can never regress a materialized sessionRef back to a placeholder (keyed on provider+createRequestId continuity, with a deliberate-reset exemption).
2. Add fresh-agent resume support on the Rust REST `create_tab` path, honoring `sessionRef` including placeholder→durable resolution via the pane-identity ledger, so placeholder-keyed panes can be restored in situ.

### Explicit constraints
- Red-green-refactor TDD for every change; both unit and e2e coverage of new behavior.
- Resume failures are LOUD: 4xx on provider mismatch, malformed sessionRef, unknown session, and unresolvable placeholders. No silent placeholder substitution on resume.
- Bounded resume probe with an env-tunable timeout knob (match the WS resume door's `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS`, default 10_000).
- Settings precedence on resume: ledger-persisted settings > serve directory > body, with explicit request values winning (`model`/`effort` from the body beat the ledger). CWD precedence: ledger > serve directory > body.
- The Node server is the frozen parity reference; Rust may exceed it with site comments documenting the divergence.
- Frozen behavioral text: `LEGACY_RESUME_IDENTITY_REFUSAL` is not reworded.
- Deliberate resets (new createRequestId / fork) must NOT be clamped by the guard.
- No backfill/repair of already-persisted placeholder state in registries or snapshots; forward-looking only.

### Accepted tradeoffs and residuals
- No backfill or repair of already-persisted placeholder sessionRefs (forward-looking only; the two incident panes were repaired out-of-band as terminal-mode opencode panes, not fresh-agent transcript panes).
- D8 leases / TerminalLivenessProbe on `FreshAgentState` are explicitly OUT of scope (documented as divergence).
- Base-gate pause rule bypassed by explicit user directive: three pre-existing flakes at base `0910d8b05801636fe7480cfb0b8a8513cc0c7cdc` (receipts `reports/base-gate-run1.log`, `reports/base-gate-run2.log`): (1) `test/integration/real/coding-cli-session-contract.test.ts` env-probe >5s, (2) `test/integration/server/test-coordinator.test.ts` gate-queue timeout, (3) `test/unit/server/coding-cli/amplifier-session-locator.test.ts` jitter-tolerance timeout. Not ours to fix.
- Pre-existing cloud e2e failures at origin/main (verified 2026-08-24 by load-bearing validator on clean tag `6333a1e80468`, docs-only diff vs base): `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts:1724` opencode compact — deterministic cloud failure (3/3 attempts, identical model-identity assertion diff; fixture served the requests), and `:866` claude questions — cloud-resource-sensitive flake (passed on retry #1). Not ours to fix; Task 6's gate deliberately excludes that spec file.

## Goal

A fresh-agent OpenCode pane, once materialized to a durable `ses_…` session, can never be silently regressed to a `freshopencode-<requestId>` placeholder by the persist/tabs.sync pipeline — and any pane that still carries a placeholder sessionRef can be restored in place via the Rust REST `create_tab` resume path.

## Architecture

- **Client:** React 18 + Redux Toolkit. Pane/hydration normalization in `src/store/panesSlice.ts` (`normalizePaneContent`, `mergeTerminalState`, `hydratePanes`, `updatePaneContent`). Shared pure helpers in `shared/session-flavor.ts` and `shared/fresh-agent.ts`.
- **Rust registry:** `crates/freshell-ws/src/tabs.rs` (push pipeline: `prepare_push` pre-lock → `derive_push_next` with `current: &CompactState`), `crates/freshell-ws/src/tabs_store_model.rs` (canonical session-id classifiers, `sanitize_session_ref`, payload normalization).
- **Ledger:** `crates/freshell-freshagent/src/identity_sink.rs` (`PaneIdentitySink` trait, `FakeIdentitySink`), adapter `crates/freshell-server/src/identity_sink.rs` (`LedgerIdentitySink`), store `crates/freshell-ws/src/pane_ledger.rs` (`PaneLedger::lookup_by_create_request_id`).
- **REST resume:** `crates/freshell-freshagent/src/lib.rs` (`create_tab`, materialization binding), `crates/freshell-freshagent/src/opencode_ws.rs` (WS resume door donor pattern, placeholder mint, pending write, broken binding).
- **MCP shorthand drop:** `server/mcp/freshell-tool.ts` (Node file; frozen parity surface — the fix only restores forwarding of what the Rust server already supports).

## Tech Stack

TypeScript/React/Redux Toolkit/Vitest (client + Node server), Rust (freshell-ws, freshell-freshagent, freshell-server crates; cargo test / clippy), Playwright e2e (cloud backend), Zod schemas.

## Global Constraints

- All edits in worktree `/home/dan/code/freshell/.worktrees/freshagent-sessionref-regression` on branch `the-usual/freshagent-sessionref-regression`; base `0910d8b05801636fe7480cfb0b8a8513cc0c7cdc`. Never mutate local `main`; no PR creation without explicit user approval.
- NEVER restart/touch the live self-hosted server on port 3001 (no "APPROVED" given and none needed — we will not touch it).
- TDD: failing test first (run → FAIL), then implement (run → PASS), then refactor. No behavior change without a test that would fail without it.
- Focused runs during tasks; coordinated broad gate via `npm run test:status` first, set `FRESHELL_TEST_SUMMARY`, and use repo-owned `npm run test:vitest -- run <paths>`. Backends: `FRESHELL_VITEST_BACKEND=cloud`, `FRESHELL_E2E_BACKEND=cloud`.
- Rust quality bar: `cargo test --workspace --locked` and `cargo clippy --workspace --all-targets -- -D warnings` green before completion.
- ESM: relative imports in `server/` include `.js` extensions.
- Frozen text: `LEGACY_RESUME_IDENTITY_REFUSAL` message is byte-identical.
- New code paths log via `tracing::info!` (Rust) / structured logs (TS).
- Worktree has no `node_modules`: run `npm ci` first thing in Task 1.
- `docs/index.html` is unchanged (no user-UI-facing change).
- The three enumerated base flakes are pre-existing and out of scope (see Accepted tradeoffs).
- Coverage reading (load-bearing stage decision): with the Task 2 server clamp enabled, a placeholder record never reaches a subscribed client, so a stack-level e2e cannot distinguish which guard layer fired. Task 1's client fold guard is covered at unit level by design; Task 6's full-stack e2e asserts the user-visible invariant (registry winner keeps durable sessionRef against a placeholder push). Task 5 is a Node-side forwarding fix covered by unit tests of the tool handler; its server-side acceptance is covered by Tasks 4/6.
- Execution order (review-required TDD sequencing): Task 1 → Task 6 Phase A (author + register + commit RED e2e) → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 Phase B (GREEN + full gate). Each implementation task still runs its own unit RED→GREEN internally.

## Task 1 — Client identity guard (panes normalize + merge)

**Feature:** A pane whose current state holds a durable sessionRef for provider+createRequestId keeps that durable identity when an incoming payload (hydrate, tabs.sync merge, or `updatePaneContent` fold) tries to overwrite it with a placeholder for the same provider+createRequestId.

**Files:**
- Test: `test/unit/shared/session-flavor.test.ts` (extend)
- Test: `test/unit/client/store/panesSlice.test.ts` (hydratePanes describe ~:2027; PanesState fixture shape :2029-2065)
- Modify: `shared/session-flavor.ts` (add `isPlaceholderProviderSessionId` next to `isDurableProviderSessionId` :65-77)
- Modify: `shared/fresh-agent.ts` (add `preservedDurableFreshAgentIdentity` next to `migrateLegacyFreshAgentDurableState` :140-188)
- Modify: `src/store/panesSlice.ts` — `normalizePaneContent` fresh-agent arm main return :184-220; `mergeTerminalState` same-createRequestId fresh-agent block :864 (before fallthrough :903). hydratePanes already routes through both (:1721 merge, :1724 normalize with previous); `updatePaneContent` passes `node.content` as previous at :1461.

**Interface:**
```ts
// shared/session-flavor.ts — provider type is FreshAgentRuntimeProvider (shared/fresh-agent.ts:11;
// there is NO `FreshAgentProvider` type). Match isDurableProviderSessionId's existing param type.
export function isPlaceholderProviderSessionId(provider: FreshAgentRuntimeProvider, sessionId: string | undefined | null): boolean
// claude: non-empty && !canonical-uuid; codex: startsWith('freshcodex-'); opencode: non-empty && !startsWith('ses_')
// (mirror of isDurableProviderSessionId; returns false for empty/undefined and unknown providers)

// shared/fresh-agent.ts — DEPENDENCY DIRECTION: shared/ never imports src/store/paneTypes.ts
// (paneTypes imports shared, not vice versa). shared/fresh-agent.ts already imports SessionRef /
// sanitizeSessionRef from './session-contract.js' (:1-7) and already declares structural
// `unknown`-field shapes (FreshAgentCompatibilityShape :23-40) — follow that pattern.
// NOTE: pane sessionRef is a SessionRef OBJECT `{ provider, sessionId }` (session-contract.ts
// SessionRefSchema :3-8; paneTypes.ts:191-200) — NEVER a string; sanitizeSessionRef
// (session-contract.ts:90-97) discards anything else.
export type FreshAgentIdentityFold = {
  provider?: FreshAgentRuntimeProvider
  createRequestId?: string
  sessionRef?: SessionRef
  sessionId?: string
  resumeSessionId?: string
}
export function preservedDurableFreshAgentIdentity(
  previous: FreshAgentIdentityFold | undefined,
  incoming: FreshAgentIdentityFold,
): Pick<FreshAgentIdentityFold, 'sessionRef' | 'sessionId' | 'resumeSessionId'> | undefined
// Fires iff: previous exists; previous.provider === incoming.provider (pane-level continuity,
// and the sessionRef LOCATORS' provider must agree with the pane provider); both createRequestIds
// defined and equal; previous.sessionRef exists (object shape) and its sessionId is
// NON-placeholder for its provider; incoming.sessionRef exists and its sessionId IS placeholder.
// Returns previous's durable identity tuple — the sessionRef OBJECT preserved verbatim (never
// coerced to a string, or sanitizeSessionRef would discard it downstream), plus sessionId and
// resumeSessionId — for the caller to spread over incoming. Undefined otherwise (deliberate
// reset with new createRequestId naturally exempt; different provider naturally exempt).
```

**Steps:**
1. `npm ci` in the worktree (one time).
2. RED: extend `test/unit/shared/session-flavor.test.ts` with `isPlaceholderProviderSessionId` cases per provider (placeholder true; durable false; empty false). Run → FAIL (not exported).
3. GREEN: implement in `shared/session-flavor.ts`. Run → PASS.
4. RED: add tests to `test/unit/client/store/panesSlice.test.ts`:
   - Seed a pane with durable sessionRef via `hydratePanes` (twice: second hydrate carries placeholder sessionRef for same provider+createRequestId) → pane keeps durable sessionRef/sessionId/resumeSessionId.
   - `updatePaneContent` fold: same scenario through the update path.
   - Exemption: incoming payload with a NEW createRequestId + placeholder replaces cleanly (deliberate reset not clamped).
   - Continuity-key negative: SAME createRequestId but DIFFERENT provider (previous durable opencode, incoming placeholder codex) → NOT clamped (provider+createRequestId is the key; provider-only or crid-only matching is a defect).
   - `preservedDurableFreshAgentIdentity` direct unit cases (fire / no-durable-previous / different-createRequestId / different-provider / incoming-sessionRef-as-string is discarded by sanitize, never matched).
   Run → FAIL.
5. GREEN: implement `preservedDurableFreshAgentIdentity` in `shared/fresh-agent.ts`; wire into `normalizePaneContent`'s fresh-agent arm main return and `mergeTerminalState`'s same-createRequestId block. Run → PASS.
6. REFACTOR: keep the picker in one place (helper), call sites thin.
7. Impacted runs: `npm run test:vitest -- run test/unit/shared/session-flavor.test.ts test/unit/client/store/panesSlice.test.ts`; then broader client pane suite (`npm run test:vitest -- run test/unit/client/store/panesSlice.test.ts test/unit/client/store/tab*.test.ts`) if quick.
8. Commit: `fix(client): preserve durable fresh-agent sessionRef across hydrate/merge for same createRequestId`.

## Task 2 — Rust registry clamp (tabs.sync push path)

**Feature:** Server-side backstop: when a tabs.sync push carries a fresh-agent pane payload whose sessionRef is a placeholder, and ANY current registry snapshot (any device/client) holds a durable sessionRef for the same tabKey+paneId+provider+createRequestId, the pushed record's sessionRef/sessionId/resumeSessionId are substituted with the durable values before insertion. Deliberate resets (different createRequestId) pass through.

**Files:**
- Test: `crates/freshell-ws/src/tabs_tests.rs` (harness: `open_record(tab_key, name, updated_at)` :13-26, `replace_client_snapshot("srv-1","dev-a","Label","client-a1",rev,vec![r]) -> PushAck{accepted,..}`, `query(...)` -> remoteOpen)
- Modify: `crates/freshell-ws/src/tabs_store_model.rs` — make `sanitize_session_ref` (:414-419) `pub(crate)`; add `pub(crate) fn is_placeholder_provider_session_id(provider, id)` mirroring shared rules (reuse `is_canonical_claude_session_id` :399-410; codex `freshcodex-` prefix; opencode `!starts_with("ses_")` && non-empty)
- Modify: `crates/freshell-ws/src/tabs.rs` — new pure fn `clamp_placeholder_session_refs(open_records: &mut Vec<...>, current: &CompactState)` called inside `derive_push_next` (:611+) on `prepared.open_records.clone()` BEFORE the insert at :679. (`prepare_push` :492 is pre-lock and has no `current` — clamp CANNOT live there; `derive_push_next` has `current.open_snapshots_by_client`; tombstone loops :653-678 unaffected.)
- HASH CORRECTNESS (review-verified twice, do not deviate): `tabs_store.rs:804-816` rebuilds `open_snapshot_payload_hash` from the STORED records on compact-state reopen and rejects a mismatch as corruption (fatal at server startup). Therefore: after clamping, REBUILD the open-snapshot payload hash from the CLAMPED records and store THAT hash with the snapshot. The hash function already exists as `pub fn build_snapshot_payload_hash` at **`tabs_store_model.rs:211`** (NOT tabs_store.rs) and is ALREADY imported by tabs.rs (:42; used at :582/:589 in prepare_push) — no visibility change; reuse the existing import with the same identity inputs (device_id, device_label, client_instance_id, snapshot_revision) used at prepare time (extend `PreparedPush` to carry those identity fields if it does not already). The whole-push `last_push_payload_hash`/`push_hash` remains computed on the RAW push payload — it is the retry-identity key, so a retry after a clamped store still dedupes. NEVER store records whose content differs from what `open_snapshot_payload_hash` describes.
- Guard-rail (implementation check, pin with a test if a consumer exists): audit every consumer of the open-snapshot hash (PushAck fields, any client-side comparison) — retry/idempotency flows must key on the raw whole-push hash ONLY; nothing may compare the open-snapshot hash against a client-side RAW-payload recomputation.
- PERSIST-GENERATION CONSISTENCY (review-verified at tabs.rs:224-250): after a mutating push, `tabs_persist::persist_generation(dir, …, &prepared.open_records, now)` snaps the RAW prepared records — rolling recovery generations and the recovery-inventory endpoints would carry the placeholder even when the compact state was clamped, violating the forward-looking "registries or snapshots" invariant. The clamped records must be the SINGLE source for both consumers: persist the COMMITTED (clamped) open records — read them back from the committed snapshot in `next` for this device/client key (consistency by construction), or have `derive_push_next` return the clamped records — never from `prepared.open_records`. Recovery generations reflect registry truth, not raw client push payloads.

**Interface:**
```rust
// tabs.rs — records are raw JSON (`PreparedPush.open_records: Vec<serde_json::Value>`); there is
// no `OpenRecord` type. Work directly on serde_json::Value.
fn clamp_placeholder_session_refs(records: &mut [serde_json::Value], current: &CompactState)
// For each record's panes: pane obj has `paneId` (src/lib/tab-registry-snapshot.ts:86), `kind`, `payload`
// (payload has NO `kind` key after normalize_registry_pane_kinds :611-641 strips it; kind lives on the pane object).
// If payload sessionRef classifies as placeholder for its provider, scan ALL clients' current open
// snapshots for same (tabKey, paneId, provider, createRequestId) with durable sessionRef; newest
// `updatedAt` wins; substitute sessionRef + sessionId + resumeSessionId into the pushed payload;
// tracing::info!("clamped placeholder sessionRef …") with tab/pane/provider.
```

**Steps:**
1. RED: tests in `tabs_tests.rs`:
   - Cross-client clamp: client-A snapshot has durable sessionRef for pane (tabKey T, paneId P, opencode, crid C); client-B pushes placeholder for same T/P/C → stored record carries durable ref.
   - Negative: different createRequestId → placeholder passes through unchanged.
   - Negative: SAME tabKey/paneId/createRequestId but DIFFERENT provider (durable opencode on A, placeholder codex push from B) → NOT clamped.
   - Negative: no durable anywhere → placeholder passes through unchanged.
   - HASH/reopen round-trip: after a clamped push, persist the compact state and re-run the reopen/validation path (`tabs_store.rs` snapshot validation) → PASSes (fails before the clamped-content hash rebuild exists, because the stored records no longer match a raw-payload hash).
   - Retry idempotency: re-push the identical RAW payload after a clamped store → deduped via raw whole-push hash, no double-apply, snapshot still valid on reopen.
   - Persist-generation consistency: placeholder push that gets clamped → the rolling generation persisted under a temp persist_dir carries the DURABLE identity (read the persisted generation back / query the recovery-inventory surface), never the placeholder.
   Run `cargo test -p freshell-ws` → FAIL.
2. GREEN: implement classifier in `tabs_store_model.rs`, `clamp_placeholder_session_refs` + clamped-content open-snapshot hash rebuild in `tabs.rs` (pub(crate) `build_snapshot_payload_hash` from tabs_store.rs), call site in `derive_push_next` before insert. Run → PASS.
3. REFACTOR: extraction/hygiene.
4. Impacted runs: `cargo test -p freshell-ws`; `cargo clippy -p freshell-ws --all-targets -- -D warnings`.
5. Commit: `fix(registry): clamp placeholder fresh-agent sessionRefs in tabs.sync pushes against current snapshots`.

## Task 3 — Ledger lineage (bindings carry create requestId; lookup-by-createRequestId on sink)

**Feature:** The pane-identity ledger can resolve a placeholder `freshopencode-<createRequestId>` to its durable `ses_…` session, because (a) binding rows record the CREATE requestId (not the SEND requestId — the current WS bug / REST `None`), (b) EVERY materialization records identity lineage unconditionally — today the REST site skips the binding ENTIRELY when body model/effort/cwd are all absent (`lib.rs:1936-1944` `has_recordable_settings` gate), while the WS site always writes (even blank settings) — the two sites are inconsistent in opposite directions, and (c) the `PaneIdentitySink` trait exposes a synchronous lookup by createRequestId usable from the REST resume path. Lineage recording must be INDEPENDENT of settings recordability, without reintroducing the false SETTINGS_RESET the REST gate was built to avoid (see semantics change below).

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` — make `OPENCODE_PLACEHOLDER_PREFIX` (:150) `pub(crate)`; REST materialization binding :1944-1978 — REMOVE the `has_recordable_settings` write-gate (update the no-laundering comment at :1932-1937 to point at the new `was_recorded` keying): always write the binding with lineage columns, `create_request_id` derived from `pane.placeholder_id` via `strip_prefix` (born-durable strip→None), settings payload included as today (blank tuple allowed — the false-RESET hazard moves to the `was_recorded` keying, below); add `record_pending` at REST create_tab after PaneEntry insert, mirroring `opencode_ws.rs:441-456` (LEDGER_WRITE_FAILED broadcast, never blocks create).
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs:704` — binding bug fix: `create_request_id: request_id.clone()` (SEND's id) → `session.placeholder_id.strip_prefix(crate::OPENCODE_PLACEHOLDER_PREFIX).map(str::to_string)` (placeholder minted at :421 as `format!("freshopencode-{request_id}")` where request_id is the CREATE id). WS write stays ungated (it already is, :700-715).
- Modify: `crates/freshell-freshagent/src/identity_sink.rs` — trait `PaneIdentitySink` (:46-54, sync-style methods returning `SinkWrite` :38 where async):
  - ADD `fn lookup_by_create_request_id(&self, provider: &str, create_request_id: &str) -> Option<String>`.
  - SEMANTICS CHANGE, documented on the trait: `was_recorded(provider, session_id)` answers "was a SETTINGS-BEARING record persisted for this session" — a lineage-only row (blank settings) must NOT make `was_recorded` true. This is what keeps the false SETTINGS_RESET disarmed while lineage is unconditional. `load_settings` unchanged (returns None for lineage-only rows).
  - `FakeIdentitySink` (:63-71 pub fields + `seed` :76): implement lookup via `bindings` scan; `was_recorded` keys off the `settings` map (a binding with blank settings does NOT enter `recorded`); seed helper inserts into `bindings` and conditionally `recorded` only when settings non-blank. `FreshAgentBindingUpsert` fields :23-33 unchanged.
- Modify: `crates/freshell-server/src/identity_sink.rs` — `LedgerIdentitySink`: delegate lookup to `PaneLedger::lookup_by_create_request_id(provider, crid) -> Option<BindingRow>` (`crates/freshell-ws/src/pane_ledger.rs:730-744`; Bound or GcExpired, newest by updated_at) mapping to `Some(session_id)`; rekey its `was_recorded` delegation to settings-bearing rows (pane_ledger query: a settings column/JSON non-blank predicate — implementation detail settled by RED tests; keep schema-compatible, no migration of historical rows: forward-looking only per Accepted tradeoffs, historical blank rows may flip `was_recorded` false — acceptable and noted).
- Test: `crates/freshell-freshagent/src/identity_sink.rs` cfg(test) mod (or existing tests) + WS/REST materialization tests in `opencode_ws.rs`/`lib.rs` asserting the binding row's `create_request_id` equals the CREATE requestId (existing tests asserting the buggy value must have expectations updated — with a comment noting the corrected semantics).

**Steps:**
1. RED: trait method + semantics tests: ledger lookup returns durable ses for a seeded binding keyed by create requestId; **lineage-unconditional test**: default REST create (body with NO model/effort/cwd) + materialize → binding row EXISTS with create_request_id == create crid AND was_recorded == false AND a subsequent resume (Task 4 door; here: direct sink calls) does NOT arm SETTINGS_RESET; blank-settings binding → `load_settings` None while lineage lookup hits; WS materialization binding test asserts `create_request_id == create requestId` (fails today: equals send requestId); REST materialization binding test asserts derived-from-placeholder. Run `cargo test -p freshell-freshagent` → FAIL.
2. GREEN: implement trait method + was_recorded rekeying on Fake + LedgerIdentitySink (+ pane_ledger predicate); fix `:704`; ungate REST `:1944` write with derived create_request_id; add REST `record_pending`; update expectation-flipped legacy tests with comments. Run → PASS.
3. REFACTOR.
4. Impacted runs: `cargo test -p freshell-freshagent -p freshell-server -p freshell-ws`; clippy on touched crates.
5. Commit: `fix(freshagent): record pane-identity lineage unconditionally, keyed by create requestId`.

## Task 4 — Rust REST create_tab resume honoring sessionRef (opencode)

**Feature:** `POST /api/tabs` with `agent: "opencode"` + `sessionRef` resumes the referenced session: durable `ses_…` directly; placeholder `freshopencode-<crid>` resolved through the ledger (Task 3); failures are loud 4xx/5xx; resumed pane is born-durable with a fresh createRequestId and merged settings.

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` — `create_tab` :1620-1748. Insert the resume branch AFTER the agent gate (:1647-1652); the legacy `resumeSessionId` door (:1633-1638, LEGACY_RESUME_IDENTITY_REFUSAL 400, text frozen) stays BEFORE the agent gate — a dual carrier (resumeSessionId + sessionRef) hits the frozen 400. Materialization binding :1920-1978 unchanged except Task 3's derivation; `ensure_manager()` :747; `set_manager_for_test` :766 pub(crate) cfg(test); `identity_sink()` :444; `broadcast()` :733.
- Reuse pattern donor: `crates/freshell-freshagent/src/opencode_ws.rs:1421-1593` (resume door, probe :1478-1505 with `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS` default 10_000, SETTINGS_RESET :1506-1541).
- Test: `crates/freshell-freshagent/src/pane_ops_tab_tests.rs` (harness `state_with_registry()`/`app()`/`post` from `pane_ops_tests.rs:13,19`) with a local small fake HTTP serving a fixed session (mirror module-private `FixedSessionHttp`/`state_with_fixed_session_http` :2949-2970 / `NotFoundHttp` :3050 / `CreateCapableHttp` :3072 in `lib.rs` tests — they are NOT accessible cross-module; do NOT move resume tests into `lib.rs` to avoid churn).

**Interface (resume branch inside create_tab):**
1. `body.get("sessionRef")` → `serde_json::from_value::<SessionLocator>(…)`; malformed → 400.
2. `locator.provider != "opencode"` → 400 (loud provider mismatch).
3. `ses_…` → direct; `freshopencode-<crid>` → `state.identity_sink().lookup_by_create_request_id("opencode", crid)` → hit resume / miss-or-no-sink → 404 (message names the placeholder); any other shape → 400.
4. LEDGER BEFORE PROBE (ordering is load-bearing, verified): `get_session(&id, &route)` applies `route.directory` as the `?directory=` query param (serve.rs:201, :634, Route.directory :335) and a route-sensitive serve can reject a wrong directory — so the ledger must be consulted FIRST. Order: load ledger settings via `state.identity_sink()` (`load_settings`, and `was_recorded` for the SETTINGS_RESET edge — lineage-only rows must NOT arm it, per Task 3 semantics) → construct the probe Route with `directory = ledger.cwd` when the ledger has one, else `None` (never body cwd — body is last in precedence and a wrong directory can fail the probe of a legitimate session) → THEN probe `manager.get_session(&id, &route)` bounded by `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS` (default 10_000; reuse the WS door's knob parse) → NotFound 404 / timeout 504 / other 502.
5. Merge AFTER probe: model/effort = body > ledger; cwd = ledger > serve-directory-from-probe > body; `was_recorded && load fails` → SETTINGS_RESET broadcast (mirror opencode_ws.rs:1506-1541).
6. Born-durable PaneEntry (placeholder_id = the durable ses id itself; durable_id: Some — no placeholder-prefixed id is ever minted for a resumed pane, so the pane behaves as any already-materialized durable pane from creation; the snapshot/serve path sees a normal `ses_*` id); NEW uuid createRequestId; paneContent sessionId/sessionRef durable, status "connected"; `ui.command` `tab.create` broadcast; response `{ tabId, paneId, sessionId, sessionRef }` + "fresh-agent pane resumed"; NO materialized frame, NO sessions.changed, NO pending write (Task 3's pending write is create-only), NO binding writes (ledger read-only on resume).
7. Site comment documenting divergence from frozen Node parity.

**Steps:**
1. RED: `pane_ops_tab_tests.rs` tests (the matrix pins EVERY explicit resume behavior of this new code path — existing `opencode_ws.rs` tests cover the WS donor only, never this REST copy):
   - happy `ses_` resume; placeholder-resolution (seeded Fake binding) resume; no-binding placeholder → 404 (message names the placeholder); unknown `ses_` → 404; provider mismatch (claude/kimi/etc.) → 400; dual-carrier → 400 with exact frozen LEGACY text; malformed sessionRef → 400.
   - Bounded probe: fake HTTP that never answers + a TINY timeout → 504 (asserts the knob is honored AND the probe is bounded — never wait the real 10s in a test). TIMEOUT INJECTION: do NOT mutate the process-global `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS` in tests — an existing opencode_ws.rs test already sets/removes it unsynchronized and parallel tokio tests would race. Inject the timeout through test state instead (cfg(test) override on FreshAgentState alongside `set_manager_for_test` :766, consulted before the env parse). Probe error other than NotFound/timeout → 502.
   - Route-sensitive probe: fake HTTP that ASSERTS the observed `?directory=` query → with a ledger-cwd-bearing record, the probe route carries the ledger cwd; without ledger cwd, the probe carries NO directory (never body cwd). Failing probe on wrong-directory proves the ordering.
   - Settings precedence ladder: ledger model/effort apply when body omits them; body model beats ledger model; body effort beats ledger effort.
   - CWD precedence ladder (full lattice): ledger cwd wins over serve-directory-from-probe; serve-directory wins over body cwd; AND with NO ledger record and NO probe-serve-directory, body cwd is USED (final fallback — an implementation that drops body cwd entirely must fail this); ledger > serve dir > body.
   - SETTINGS_RESET edge: settings-bearing record + unrecoverable `load_settings` → SETTINGS_RESET broadcast and resume proceeds (mirror opencode_ws.rs:1506-1541); complement (Task 3 semantics): lineage-only binding → resume proceeds with NO SETTINGS_RESET.
   Run `cargo test -p freshell-freshagent` → FAIL (currently 400/ignored).
2. GREEN: implement branch. Run → PASS.
3. REFACTOR.
4. Impacted runs: `cargo test -p freshell-freshagent`; clippy.
5. Commit: `feat(freshagent): support sessionRef resume on REST create_tab for opencode panes`.

## Task 5 — MCP new-tab shorthand stops dropping resume (agent path)

**Feature:** `freshell` MCP `new-tab` with `agent: "opencode"` (no `mode`) + `resume`/`resumeSessionId` forwards a synthesized `sessionRef {provider:"opencode", sessionId}` to the server instead of silently dropping the resume fields — making the Task 4 endpoint reachable from the primary agent surface. Scope is DELIBERATELY narrow (review-narrowed): only `opencode` is synthesized, because the Rust REST resume honors only opencode (Task 4), Node's `createFreshAgentPane` ignores `sessionRef`, and kilroy is not an accepted REST agent. Explicit `sessionRef` is already forwarded for any provider and stays untouched. Split-pane unchanged (Rust split already loudly 400s agent splits at `pane_ops.rs:168-175`).

**Files:**
- Modify: `server/mcp/freshell-tool.ts` (:641-663 new-tab case; `resume`/`resumeSessionId` destructured out of `...rest` :641 area; `legacyResume` :648; `rejectRawCodexResume(mode, …)` :649; synthesis :651-653 mode-keyed; `agent` flows via `...rest`). Help text: resume sugar is honored for `agent: "opencode"` only — say exactly that, do NOT advertise a general "resume-via-agent".
- Modify: `AGENTS.md` Fresh-Agent Orchestration line — one sentence: new-tab resume sugar is honored for opencode agents; other providers must pass an explicit `sessionRef`.
- Test: `test/unit/server/mcp/freshell-tool.test.ts`.

**Interface:**
```ts
// Maps opencode→'opencode' (synthesize) and codex→'codex' (so the existing
// rejectRawCodexResume fires with parity to mode=codex); returns undefined for everything else
// (claude/kilroy/unknown). undefined means: no synthesis, fields keep their CURRENT behavior
// (dropped for agent-only calls) — acceptable because explicit sessionRef forwarding already
// exists, and the docs updated here say so.
// SIGNATURE: routeAction args are Record<string, unknown>, so rest.agent is `unknown` — the
// helper must accept unknown and narrow internally (typeof agent === 'string' ? … : undefined),
// or the call site fails typecheck.
function agentResumeProvider(agent: unknown): 'codex' | 'opencode' | undefined
// In new-tab: const resumeProvider = mode ?? agentResumeProvider(rest.agent)
// resumeProvider === 'opencode' → synthesize sessionRef; === 'codex' → rejectRawCodexResume fires.
```

**Steps:**
1. RED: tests: `agent: "opencode"` + `resume: "ses_…"` → POST body contains synthesized `sessionRef {provider:"opencode", sessionId}`; explicit `sessionRef` beats synthesized; `agent: "codex"` + raw resume → same rejection error as mode=codex; `agent: "claude"`/`kilroy` + resume → NO synthesis and NO sessionRef in POST body (behavior unchanged; docs carry the truth). Run `npm run test:vitest -- run test/unit/server/mcp/freshell-tool.test.ts` → FAIL.
2. GREEN: implement. Run → PASS.
3. REFACTOR; update help text + AGENTS.md (opencode-only wording).
4. Impacted runs: the same spec + `npm run lint` for a11y-adjacent cleanliness (no UI change; cheap).
5. Commit: `fix(mcp): forward resume as sessionRef on opencode agent new-tab shorthand`.

## Task 6 — E2E coverage + final gate

**Feature:** End-to-end proof on the Rust server: (a) REST create→send-turn→durable-id→restart→REST resume with sessionRef restores transcript; (b) registry winner keeps a durable sessionRef against a placeholder push.

**Files:**
- New: `test/e2e-browser/specs/fresh-agent-rest-resume-rust.spec.ts` — modeled on `test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts:380-428` (rust server boot harness, audit log `readJsonl` for the `prompt_async` ses id, `server.restartAbrupt`, `enableFreshAgent`, `WsCapture`) — PROVEN 4/4 green on the cloud backend by the load-bearing validator (sqlite/fake-opencode harness works on the cloud image) — with only the `sendOpencodeTurn` helper pattern borrowed from `fresh-agent-control-rust.spec.ts:1674` (that spec FILE is excluded from the gate: pre-existing deterministic failure at its :1724 compact test + flake at :866, both pre-existing at origin/main — see Accepted tradeoffs).
- Extend or model on: `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts` — two WS clients / tabs.sync push: client-B pushes placeholder for a pane client-A has durable; assert registry winner keeps durable ref.
- REGISTER the new spec so it cannot silently match zero tests: add it to BOTH explicit lists in `test/e2e-browser/playwright.config.ts` — `RUST_ONLY_SPECS` (~:245/:283) and `rust-chromium.testMatch` (~:472/:530). The lists are explicit regex literals; no glob exists. Verified by negative control: an unregistered filename matches 0 tests ("Error: No tests found."). Donor specs were verified absent from `CLOUD_SKIP_SPECS` (`test/e2e-browser/playwright.cloud.config.ts`) at base; assert the same for the new spec.
- Filtered cloud runs: run at shards=1 (or otherwise avoid the silent full-suite glob-fallback trap in the cloud entrypoint at shards≥2 when a filter matches nothing) and verify run attribution: entrypoint echo lists the intended spec files and the line reporter shows their real test titles.

**Steps:**
0. Journeys in `fresh-agent-rest-resume-rust.spec.ts` (BOTH required — request-level coverage):
   - (a) Durable-id resume: REST create opencode pane → send turn → materialize → read durable `ses_…` from the audit log (`prompt_async`) → `restartAbrupt` → `POST /api/tabs` with sessionRef `{provider:"opencode", sessionId: <ses_…>}` → 200 with durable sessionId + transcript.
   - (b) PLACEHOLDER-resolution resume through a NATURALLY-written binding (no seeded fixtures — this is kata 2's headline behavior and depends on Task 3's unconditional lineage): REST create with DEFAULT body (no model/effort/cwd) → capture the pane's placeholder `sessionId` (== `freshopencode-<createRequestId>`) from the create response / `tab.create` broadcast pane payload (those carry `sessionId` and `createRequestId` but NO sessionRef object — the test CONSTRUCTS the locator `{ provider: 'opencode', sessionId: <captured placeholder sessionId> }` itself; no API change) → send turn → materialize (natural lineage binding written despite blank settings) → obtain durable ses id from the audit log → `restartAbrupt` → `POST /api/tabs` with the constructed placeholder sessionRef → 200, response sessionId == the materialized durable id, transcript restored.
   - (c) Registry clamp journey in `sidebar-registry-sync-rust.spec.ts` (or the new spec — pick the harness that already boots two WS clients): client-B pushes a placeholder payload for a tab/pane client-A holds durable → registry winner keeps durable sessionRef.
1. RED-FIRST SEQUENCING (review-required; the e2e RED is impossible once Tasks 2–4 have landed): this task runs in TWO phases.
   - Phase A (executed IMMEDIATELY AFTER Task 1, BEFORE Tasks 2–5): author the spec + journeys (a)/(b)/(c), register it in both explicit lists, boot the worktree Rust server on a scratch port, and OBSERVE ALL JOURNEYS FAILING against the unchanged implementation ((a)/(b) fail at the 400/loud door; (c) fails because the placeholder push wins) — record the failing output in the run ledger, commit the red spec: `test(e2e): red specs for REST fresh-agent resume + registry placeholder clamp`.
   - Phase B (after Tasks 2–5 land): the same spec must now go GREEN against the worktree-built Rust server on a scratch port (NOT 3001) — capture the transition RED→GREEN in the ledger.
2. (Phase B, continued) GREEN evidence as above.
3. Full gate: `npm run test:status` → coordinate → `npm run check` (typecheck + coordinated full suite); `cargo test --workspace --locked`; `cargo clippy --workspace --all-targets -- -D warnings`; affected e2e specs on the configured cloud backend: `npm run test:e2e:cloud -- --project=rust-chromium <exact paths to the touched specs>` = the new `fresh-agent-rest-resume-rust.spec.ts` and the extended `sidebar-registry-sync-rust.spec.ts`, at shards=1 with the attribution checks above. Do NOT include `fresh-agent-control-rust.spec.ts` (pre-existing cloud failure, see Accepted tradeoffs).
4. Update run-state execution counts; commit: `test(e2e): cover Rust REST fresh-agent resume and registry placeholder clamp`.

## Self-review (writing-plans checklist)

- [x] Verbatim User Request block re-authored by the dispatcher (original was never persisted to disk; content reconstructed from the dispatch context and recorded here verbatim as authored). PRESERVED UNCHANGED through all remediation.
- [x] Goal / Architecture / Tech Stack present.
- [x] Global Constraints section present (worktree isolation, no-PR rule, live-server rule, TDD, coordinated testing, clippy, ESM, frozen text, flake ledger).
- [x] 6 tasks, each with Files (exact paths + line anchors verified against source), Interfaces (signatures), Steps (RED run-fails → GREEN run-passes → REFACTOR → impacted runs → commit message).
- [x] No task mutates `main`, port 3001, or frozen text; deliberate-reset exemption and forward-looking tradeoffs encoded in tasks 1/2 acceptance.
- [x] Anchor risks flagged where code may drift (anchors verified 2026-08-23; remediation evidence re-verified 2026-08-24).
- [x] Plan-review round 1 remediations re-reviewed (2026-08-24): Task 1 interface is object-shaped per paneTypes.ts:191-200 + session-contract.ts:3-8 (verified); Task 2 clamped-content hash rebuild satisfies tabs_store.rs:804-816 reopen validation (verified) with raw whole-push retry identity preserved; Task 3 unconditional lineage + settings-bearing `was_recorded` keying resolves the REST gate hole (lib.rs:1936-1944 verified) without re-arming false SETTINGS_RESET; Task 4 RED matrix pins every explicit resume behavior; Task 5 narrowed to opencode-only (no misleading advertising; explicit sessionRef path documented); Task 6 journey (b) covers natural placeholder→ledger→durable resolution e2e.
- [x] Plan-review round 2 remediations re-reviewed (2026-08-24): provider type is `FreshAgentRuntimeProvider` (shared/fresh-agent.ts:11, verified) with structural `FreshAgentIdentityFold` preserving shared→client dependency direction; `build_snapshot_payload_hash` cited correctly (pub at tabs_store_model.rs:211, already imported tabs.rs:42, verified — no visibility change); clamp signature on `serde_json::Value` (no phantom `OpenRecord`); resume probe reordered LEDGER-before-PROBE with route-sensitive test (serve.rs:201/:634 directory-param routing verified); Task 6 e2e constructs the locator from captured fields (no API change) and runs RED-FIRST in a two-phase sequencing recorded in Global Constraints; probe timeout injected via cfg(test) state override (no env-var race); Task 5 codex-refusal comment contradiction fixed.
