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
// shared/session-flavor.ts
export function isPlaceholderProviderSessionId(provider: FreshAgentProvider, sessionId: string | undefined | null): boolean
// claude: non-empty && !canonical-uuid; codex: startsWith('freshcodex-'); opencode: non-empty && !startsWith('ses_')
// (mirror of isDurableProviderSessionId; returns false for empty/undefined and unknown providers)

// shared/fresh-agent.ts
export function preservedDurableFreshAgentIdentity(
  previous: { provider?: string; createRequestId?: string; sessionRef?: string; sessionId?: string; resumeSessionId?: string } | undefined,
  incoming: { provider?: string; createRequestId?: string; sessionRef?: string; sessionId?: string; resumeSessionId?: string },
): { sessionRef: string; sessionId: string; resumeSessionId: string } | undefined
// Fires iff: same provider, both createRequestIds defined and equal, previous.sessionRef durable, incoming.sessionRef placeholder.
// Returns previous durable tuple picked into incoming shape; undefined otherwise (deliberate reset with new createRequestId naturally exempt).
```

**Steps:**
1. `npm ci` in the worktree (one time).
2. RED: extend `test/unit/shared/session-flavor.test.ts` with `isPlaceholderProviderSessionId` cases per provider (placeholder true; durable false; empty false). Run → FAIL (not exported).
3. GREEN: implement in `shared/session-flavor.ts`. Run → PASS.
4. RED: add tests to `test/unit/client/store/panesSlice.test.ts`:
   - Seed a pane with durable sessionRef via `hydratePanes` (twice: second hydrate carries placeholder sessionRef for same provider+createRequestId) → pane keeps durable sessionRef/sessionId/resumeSessionId.
   - `updatePaneContent` fold: same scenario through the update path.
   - Exemption: incoming payload with a NEW createRequestId + placeholder replaces cleanly (deliberate reset not clamped).
   - `preservedDurableFreshAgentIdentity` direct unit cases (fire / no-durable-previous / different-createRequestId).
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
- Modify: `crates/freshell-ws/src/tabs.rs` — new pure fn `clamp_placeholder_refs(open_records: &mut Vec<...>, current: &CompactState)` called inside `derive_push_next` (:611+) on `prepared.open_records.clone()` BEFORE the insert at :679. (`prepare_push` :492 is pre-lock and has no `current` — clamp CANNOT live there; `derive_push_next` has `current.open_snapshots_by_client`. Hashes stay computed on the RAW payload so retry idempotency is preserved; tombstone loops :653-678 unaffected.)

**Interface:**
```rust
// tabs.rs
fn clamp_placeholder_session_refs(records: &mut [OpenRecord], current: &CompactState)
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
   - Negative: no durable anywhere → placeholder passes through unchanged.
   Run `cargo test -p freshell-ws` → FAIL.
2. GREEN: implement classifier in `tabs_store_model.rs`, `clamp_placeholder_session_refs` in `tabs.rs`, call site in `derive_push_next` before insert. Run → PASS.
3. REFACTOR: extraction/hygiene.
4. Impacted runs: `cargo test -p freshell-ws`; `cargo clippy -p freshell-ws --all-targets -- -D warnings`.
5. Commit: `fix(registry): clamp placeholder fresh-agent sessionRefs in tabs.sync pushes against current snapshots`.

## Task 3 — Ledger lineage (bindings carry create requestId; lookup-by-createRequestId on sink)

**Feature:** The pane-identity ledger can resolve a placeholder `freshopencode-<createRequestId>` to its durable `ses_…` session, because (a) binding rows record the CREATE requestId (not the SEND requestId — the current bug), and (b) the `PaneIdentitySink` trait exposes a synchronous lookup by createRequestId usable from the REST resume path.

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` — make `OPENCODE_PLACEHOLDER_PREFIX` (:150) `pub(crate)`; REST materialization binding :1950 (`create_request_id: None` → derive from `pane.placeholder_id` via `strip_prefix`; born-durable strip→None); add `record_pending` at REST create_tab after PaneEntry insert, mirroring `opencode_ws.rs:441-456` (LEDGER_WRITE_FAILED broadcast, never blocks create).
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs:704` — binding bug fix: `create_request_id: request_id.clone()` (SEND's id) → `session.placeholder_id.strip_prefix(crate::OPENCODE_PLACEHOLDER_PREFIX).map(str::to_string)` (placeholder minted at :421 as `format!("freshopencode-{request_id}")` where request_id is the CREATE id).
- Modify: `crates/freshell-freshagent/src/identity_sink.rs` — trait `PaneIdentitySink` (:46-54, sync-style methods returning `SinkWrite` :38 where async) ADD `fn lookup_by_create_request_id(&self, provider: &str, create_request_id: &str) -> Option<String>`; `FakeIdentitySink` (:63-71 pub fields + `seed` :76) implements via `bindings` scan; seed helper inserts into both `bindings` and `recorded`. `FreshAgentBindingUpsert` fields :23-33 unchanged.
- Modify: `crates/freshell-server/src/identity_sink.rs` — `LedgerIdentitySink` delegates to `PaneLedger::lookup_by_create_request_id(provider, crid) -> Option<BindingRow>` (`crates/freshell-ws/src/pane_ledger.rs:730-744`; Bound or GcExpired, newest by updated_at) mapping to `Some(session_id)`.
- Test: `crates/freshell-freshagent/src/identity_sink.rs` cfg(test) mod (or existing tests) + WS/REST materialization tests in `opencode_ws.rs`/`lib.rs` asserting the binding row's `create_request_id` equals the CREATE requestId (existing tests asserting the buggy value must have expectations updated — with a comment noting the corrected semantics).

**Steps:**
1. RED: trait method + Fake implementation signature; tests: ledger lookup returns durable ses for a seeded binding keyed by create requestId; WS materialization binding test asserts `create_request_id == create requestId` (fails today: equals send requestId); REST materialization binding test asserts derived-from-placeholder. Run `cargo test -p freshell-freshagent` → FAIL.
2. GREEN: implement trait method on Fake + LedgerIdentitySink; fix `:704`; fix REST `:1950`; add REST `record_pending`; update expectation-flipped legacy tests with comments. Run → PASS.
3. REFACTOR.
4. Impacted runs: `cargo test -p freshell-freshagent -p freshell-server -p freshell-ws`; clippy on touched crates.
5. Commit: `fix(freshagent): key pane-identity bindings by create requestId and expose lookup_by_create_request_id`.

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
4. Probe `manager.get_session(&id, &route)` bounded by `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS` (default 10_000; reuse the WS door's knob parse) → NotFound 404 / timeout 504 / other 502.
5. Settings: body model/effort > ledger `load_settings`; `was_recorded && load fails` → SETTINGS_RESET broadcast (mirror opencode_ws.rs:1506-1541). CWD: ledger > serve directory from probe > body.
6. Born-durable PaneEntry (placeholder_id = the durable ses id itself; durable_id: Some — no placeholder-prefixed id is ever minted for a resumed pane, so the pane behaves as any already-materialized durable pane from creation; the snapshot/serve path sees a normal `ses_*` id); NEW uuid createRequestId; paneContent sessionId/sessionRef durable, status "connected"; `ui.command` `tab.create` broadcast; response `{ tabId, paneId, sessionId, sessionRef }` + "fresh-agent pane resumed"; NO materialized frame, NO sessions.changed, NO pending write (Task 3's pending write is create-only), NO binding writes (ledger read-only on resume).
7. Site comment documenting divergence from frozen Node parity.

**Steps:**
1. RED: `pane_ops_tab_tests.rs` tests: happy `ses_` resume; placeholder-resolution (seeded Fake binding) resume; no-binding placeholder → 404; unknown `ses_` → 404; provider mismatch (claude/kimi/etc.) → 400; dual-carrier → 400 with exact frozen LEGACY text; malformed sessionRef → 400; body model beats ledger model in spawned settings. Run `cargo test -p freshell-freshagent` → FAIL (currently 400/ignored).
2. GREEN: implement branch. Run → PASS.
3. REFACTOR.
4. Impacted runs: `cargo test -p freshell-freshagent`; clippy.
5. Commit: `feat(freshagent): support sessionRef resume on REST create_tab for opencode panes`.

## Task 5 — MCP new-tab shorthand stops dropping resume (agent path)

**Feature:** `freshell` MCP `new-tab` with `agent` (no `mode`) + `resume`/`resumeSessionId` forwards a synthesized `sessionRef` to the Rust server instead of silently dropping the resume fields. Split-pane unchanged (Rust split already loudly 400s agent splits at `pane_ops.rs:168-175`, so no client-side gate is needed to stay honest).

**Files:**
- Modify: `server/mcp/freshell-tool.ts` (:641-663 new-tab case; `resume`/`resumeSessionId` destructured out of `...rest` :641 area; `legacyResume` :648; `rejectRawCodexResume(mode, …)` :649; synthesis :651-653 mode-keyed; `agent` flows via `...rest`). Update the tool's parameter help text to say resume works with `agent` too.
- Modify: `AGENTS.md` Fresh-Agent Orchestration line — note resume-via-agent supported.
- Test: `test/unit/server/mcp/freshell-tool.test.ts`.

**Interface:**
```ts
function agentResumeProvider(agent: string | undefined): 'claude' | 'codex' | 'opencode' | undefined
// opencode→opencode, claude|kilroy→claude, codex→codex, else undefined
// In new-tab: const resumeProvider = mode ?? agentResumeProvider(rest.agent)
// feed resumeProvider into the existing rejectRawCodexResume + sessionRef synthesis path.
// Unknown agent → undefined → fields forward untouched → server 400s loudly (no silent drop).
```

**Steps:**
1. RED: tests: `agent: "opencode"` + `resume: "ses_…"` → POST body contains synthesized `sessionRef {provider:"opencode", sessionId}`; explicit `sessionRef` beats synthesized; `agent: "codex"` + raw resume → same rejection error as mode=codex; unknown agent leaves forwarding intact. Run `npm run test:vitest -- run test/unit/server/mcp/freshell-tool.test.ts` → FAIL.
2. GREEN: implement. Run → PASS.
3. REFACTOR; update help text + AGENTS.md.
4. Impacted runs: the same spec + `npm run lint` for a11y-adjacent cleanliness (no UI change; cheap).
5. Commit: `fix(mcp): forward resume as sessionRef on agent new-tab shorthand`.

## Task 6 — E2E coverage + final gate

**Feature:** End-to-end proof on the Rust server: (a) REST create→send-turn→durable-id→restart→REST resume with sessionRef restores transcript; (b) registry winner keeps a durable sessionRef against a placeholder push.

**Files:**
- New: `test/e2e-browser/specs/fresh-agent-rest-resume-rust.spec.ts` — modeled on `test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts:380-428` (rust server boot harness, audit log `readJsonl` for the `prompt_async` ses id, `server.restartAbrupt`, `enableFreshAgent`, `WsCapture`) — PROVEN 4/4 green on the cloud backend by the load-bearing validator (sqlite/fake-opencode harness works on the cloud image) — with only the `sendOpencodeTurn` helper pattern borrowed from `fresh-agent-control-rust.spec.ts:1674` (that spec FILE is excluded from the gate: pre-existing deterministic failure at its :1724 compact test + flake at :866, both pre-existing at origin/main — see Accepted tradeoffs).
- Extend or model on: `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts` — two WS clients / tabs.sync push: client-B pushes placeholder for a pane client-A has durable; assert registry winner keeps durable ref.
- REGISTER the new spec so it cannot silently match zero tests: add it to BOTH explicit lists in `test/e2e-browser/playwright.config.ts` — `RUST_ONLY_SPECS` (~:245/:283) and `rust-chromium.testMatch` (~:472/:530). The lists are explicit regex literals; no glob exists. Verified by negative control: an unregistered filename matches 0 tests ("Error: No tests found."). Donor specs were verified absent from `CLOUD_SKIP_SPECS` (`test/e2e-browser/playwright.cloud.config.ts`) at base; assert the same for the new spec.
- Filtered cloud runs: run at shards=1 (or otherwise avoid the silent full-suite glob-fallback trap in the cloud entrypoint at shards≥2 when a filter matches nothing) and verify run attribution: entrypoint echo lists the intended spec files and the line reporter shows their real test titles.

**Steps:**
1. RED: new spec fails (resume endpoint currently 400s / guard absent).
2. GREEN: passes against worktree-built Rust server on a scratch port (NOT 3001).
3. Full gate: `npm run test:status` → coordinate → `npm run check` (typecheck + coordinated full suite); `cargo test --workspace --locked`; `cargo clippy --workspace --all-targets -- -D warnings`; affected e2e specs on the configured cloud backend: `npm run test:e2e:cloud -- --project=rust-chromium <exact paths to the touched specs>` = the new `fresh-agent-rest-resume-rust.spec.ts` and the extended `sidebar-registry-sync-rust.spec.ts`, at shards=1 with the attribution checks above. Do NOT include `fresh-agent-control-rust.spec.ts` (pre-existing cloud failure, see Accepted tradeoffs).
4. Update run-state execution counts; commit: `test(e2e): cover Rust REST fresh-agent resume and registry placeholder clamp`.

## Self-review (writing-plans checklist)

- [x] Verbatim User Request block re-authored by the dispatcher (original was never persisted to disk; content reconstructed from the dispatch context and recorded here verbatim as authored).
- [x] Goal / Architecture / Tech Stack present.
- [x] Global Constraints section present (worktree isolation, no-PR rule, live-server rule, TDD, coordinated testing, clippy, ESM, frozen text, flake ledger).
- [x] 6 tasks, each with Files (exact paths + line anchors verified against source this session), Interfaces (signatures), Steps (RED run-fails → GREEN run-passes → REFACTOR → impacted runs → commit message).
- [x] No task mutates `main`, port 3001, or frozen text; deliberate-reset exemption and forward-looking tradeoffs encoded in tasks 1/2 acceptance.
- [x] Anchor risks flagged where code may drift (all anchors re-verified 2026-08-23 immediately before writing).
