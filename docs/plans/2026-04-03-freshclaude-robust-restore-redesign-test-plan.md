# FreshClaude Robust Restore Redesign Test Plan

The existing testing strategy still holds after reconciling it against the April 3 implementation plan. The redesign expands the server contract, but it does not introduce new paid APIs, external infrastructure, or any test dependency beyond the repo's existing in-process React/Redux, WebSocket, Express, and Vitest harnesses. The main adjustment is emphasis: because the implementation plan makes restore authoritative at the server ledger boundary, the acceptance gates must be led by the real user-visible restore surfaces in this order: `sdk.create` / `sdk.attach`, `sdk.session.snapshot`, `/api/agent-sessions/.../timeline`, `/api/agent-sessions/.../turns/:turnId`, pane retry UI, and cross-tab persisted-layout hydration. Unit tests stay subordinate and only pin identity, revision, and merge invariants that are hard to diagnose from the higher-fidelity surfaces alone.

## Harness requirements

No brand-new harnesses are required, but the plan depends on the following existing harnesses being used deliberately:

- `component-scenario-rtl`
  What it does: renders `AgentChatView` with the real Redux reducers, pane/tab slices, mocked WS client, and mocked HTTP helpers.
  Exposes: rendered DOM, pane/tab persisted state, outbound WS messages, thunk-driven API calls.
  Estimated complexity: existing.
  Tests depending on it: 1, 2, 3, 4, 8.

- `rendered-app-e2e`
  What it does: renders the real app shell and pane container with realistic store bootstrapping.
  Exposes: visible pane chrome, retry/error states, restored transcript rendering, tab/pane metadata.
  Estimated complexity: existing.
  Tests depending on it: 1, 2, 8.

- `server-ws-integration`
  What it does: runs `WsHandler` on an in-process HTTP/WebSocket server with mocked `SdkBridge` and injected restore dependencies.
  Exposes: ordered outbound WS messages, request-scoped failures, attach/create behavior, replay ordering.
  Estimated complexity: existing, but it must be extended to drive replay-gate watermarks and create-time failure cases.
  Tests depending on it: 3, 4.

- `server-route-integration`
  What it does: mounts the real Express router with the real timeline service via `supertest`.
  Exposes: HTTP status codes, JSON payloads, revision-bearing query/cursor behavior.
  Estimated complexity: existing.
  Tests depending on it: 5.

- `client-store-unit`
  What it does: exercises `api.ts`, thunks, reducers, and SDK message dispatch without DOM rendering.
  Exposes: serialized request URLs, retry bookkeeping, request-scoped failure state, immediate-flush dispatch.
  Estimated complexity: existing.
  Tests depending on it: 6, 7, 10, 11.

- `server-ledger-unit`
  What it does: directly exercises the ledger/history-source/loader contract with deterministic fixtures.
  Exposes: typed restore outcomes, durable-id synthesis, alias teardown, id-first merge, revision monotonicity.
  Estimated complexity: existing unit-test style plus the new ledger file.
  Tests depending on it: 9, 10, 11.

## Test plan

1. **Name:** Reloading a live FreshClaude pane restores one coherent transcript and in-progress reply without a blank running gap
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** `rendered-app-e2e`
   - **Preconditions:** A persisted FreshClaude pane exists with `sessionId` and a stale or named `resumeSessionId`; the server returns `sdk.session.snapshot` with canonical `timelineSessionId`, `revision`, `latestTurnId`, `status: running`, and partial stream preview; the first visible timeline page returns inline bodies.
   - **Actions:** Render the restored pane; deliver `sdk.session.snapshot`; let the first visible `/api/agent-sessions/:sessionId/timeline` read complete; observe the rendered transcript, pane status text, and API call log.
   - **Expected outcome:** Per the implementation plan sections `User-Visible Behavior`, `Revision-pinned restore hydration`, and `Immediate canonical durable-id persistence`, the UI shows the partial assistant preview immediately, replaces the restoring placeholder with the restored newest turn body from the first visible page, does not issue a redundant newest-turn body fetch, persists the canonical durable id into pane and tab fallback state, and never shows a blank "Running..." state between snapshot receipt and timeline hydration.
   - **Interactions:** `sdk.attach`, `sdk.session.snapshot`, visible timeline fetch, pane/tab persistence, streaming preview rendering.

2. **Name:** Resuming from a named session upgrades in place to the canonical durable id without split-brain history
   - **Type:** scenario
   - **Disposition:** extend
   - **Harness:** `rendered-app-e2e`
   - **Preconditions:** A FreshClaude pane starts with `resumeSessionId` set to a named resume token; `sdk.create` succeeds; the initial restore state is `live_only`; a later snapshot/timeline response exposes the canonical durable Claude UUID and durable backlog.
   - **Actions:** Render the pane; allow it to send `sdk.create`; deliver `sdk.created`; deliver the first `sdk.session.snapshot`; complete the first visible timeline read; then deliver the durable-id upgrade path.
   - **Expected outcome:** Per `User-Visible Behavior`, `One authoritative restore ledger`, and `Immediate canonical durable-id persistence`, the user sees one transcript containing durable backlog plus live delta in correct order, the pane never swaps to a second visible session id, subsequent HTTP reads target the canonical durable id, and the persisted fallback identity upgrades once in place rather than creating a second restore branch.
   - **Interactions:** `sdk.create`, `sdk.created`, `sdk.session.snapshot`, timeline hydration, pane/tab metadata updates.

3. **Name:** `sdk.create` is transactional: create-time restore failure never exposes a usable session and leaves a retryable pane error
   - **Type:** regression
   - **Disposition:** new
   - **Harness:** `server-ws-integration` plus `component-scenario-rtl`
   - **Preconditions:** The WS server can create a tentative SDK session, but the authoritative restore resolution for that request returns a fatal result before the client becomes ready.
   - **Actions:** Send `sdk.create`; capture outbound WS messages; render the pane-side client path that receives `sdk.create.failed`; inspect pane state and visible retry UI.
   - **Expected outcome:** Per `Transactional sdk.create` and `Explicit restore failure semantics`, the server does not emit `sdk.created`, kills the tentative session, tears down tentative aliasing/replay state, emits request-scoped `sdk.create.failed`, and the pane transitions to visible `create-failed` state with no fabricated `sessionId`, no lost-session impersonation, and no automatic retry.
   - **Interactions:** `sdk.create`, replay gate setup/teardown, request-scoped failure routing, pane-local retry UI ownership.

4. **Name:** Transactional create replays only post-snapshot events and converts buffered raw init into metadata refresh
   - **Type:** integration
   - **Disposition:** new
   - **Harness:** `server-ws-integration`
   - **Preconditions:** The bridge buffers early SDK events for a newly created session, including raw `system/init`, status changes, and stream deltas that straddle the snapshot watermark.
   - **Actions:** Send `sdk.create`; freeze the replay gate at a deterministic watermark; capture all outbound server messages in order.
   - **Expected outcome:** Per `Transactional sdk.create`, the ordered user-visible sequence is `sdk.created`, `sdk.session.snapshot`, synthesized `sdk.session.init`, then replayed post-watermark events, with raw early `system/init` surfaced only as `sdk.session.metadata`; any event already folded into the snapshot is not replayed a second time.
   - **Interactions:** bridge replay drain API, WS protocol ordering, metadata refresh semantics, snapshot watermark handling.

5. **Name:** Revision-pinned timeline and turn-body reads reject drift instead of serving mixed restore state
   - **Type:** integration
   - **Disposition:** new
   - **Harness:** `server-route-integration`
   - **Preconditions:** The ledger holds revision `N`; a client requests timeline and turn-body data using revision `N-1`; the route stack is mounted with the real timeline service.
   - **Actions:** Call `/api/agent-sessions/:sessionId/timeline?...&revision=<stale>`; call `/api/agent-sessions/:sessionId/turns/:turnId?revision=<stale>`; then call both again with the current revision and a cursor derived from that revision.
   - **Expected outcome:** Per `Revision-pinned restore hydration` and the revised read-model contract, stale requests return `409` with `RESTORE_STALE_REVISION`, current-revision requests succeed, and pagination cursors preserve the same revision rather than drifting onto newer state.
   - **Interactions:** router query parsing, timeline service revision enforcement, cursor encoding, HTTP error translation.

6. **Name:** A stale revision restarts restore exactly once, then fails visibly on the second stale response
   - **Type:** scenario
   - **Disposition:** new
   - **Harness:** `component-scenario-rtl`
   - **Preconditions:** A restored pane has a snapshot-pinned revision; the first visible timeline fetch returns `RESTORE_STALE_REVISION`; either the next retry succeeds or the second retry also returns stale.
   - **Actions:** Mount the pane and deliver the snapshot; force the first visible timeline request to reject stale; observe retry behavior; in the second variant, reject stale again.
   - **Expected outcome:** Per `Revision-pinned restore hydration`, the client reacquires a fresh snapshot and restarts hydration once after the first stale response, never mixes the stale page into the rendered transcript, and after a second stale response surfaces a visible restore failure instead of looping or relying on timeout recovery.
   - **Interactions:** snapshot ingestion, timeline thunk retry path, pane restore UI, HTTP stale-revision errors.

7. **Name:** Snapshot-pinned restore requests always carry the revision on both timeline-page and turn-body calls
   - **Type:** invariant
   - **Disposition:** new
   - **Harness:** `client-store-unit`
   - **Preconditions:** Store state contains a restored session with `timelineSessionId`, `restoreRevision`, and a visible timeline page whose newest turn may or may not have an inline body.
   - **Actions:** Dispatch `loadAgentTimelineWindow`; if needed dispatch `loadAgentTurnBody`; inspect serialized API calls.
   - **Expected outcome:** Per `Revision-pinned restore hydration` and `shared/read-models.ts`, every restore-time timeline and turn-body request includes the pinned revision, and first-page `includeBodies=true` behavior remains intact.
   - **Interactions:** `api.ts`, thunk serialization, reducer restore state.

8. **Name:** Canonical durable-id upgrade forces an immediate persistence flush and blocks stale cross-tab overwrite on both identity surfaces
   - **Type:** scenario
   - **Disposition:** new
   - **Harness:** `component-scenario-rtl` plus `client-store-unit`
   - **Preconditions:** A pane begins from a named or live-only identity; a later snapshot upgrades it to a canonical durable Claude id; a remote persisted-layout payload arrives afterward with an older named identity but newer or older unrelated tab fields.
   - **Actions:** Deliver the canonical upgrade; assert the targeted flush dispatch; inject cross-tab storage/broadcast payloads that attempt to regress pane `resumeSessionId` and tab fallback metadata.
   - **Expected outcome:** Per `Immediate canonical durable-id persistence`, the canonical upgrade triggers the targeted immediate flush, stale cross-tab payloads cannot overwrite either the pane `resumeSessionId` or tab fallback `resumeSessionId` / `sessionMetadataByKey`, and a genuinely newer non-conflicting remote change can still merge without regressing identity.
   - **Interactions:** snapshot handling, persist middleware, cross-tab sync, tabs merge path, browser storage/broadcast.

9. **Name:** Ledger resolution returns typed restore outcomes and tears down live aliases so stale in-memory authority cannot outlive the session
   - **Type:** invariant
   - **Disposition:** new
   - **Harness:** `server-ledger-unit`
   - **Preconditions:** The ledger manager sees live-only, durable-only, merged, missing, and unrecoverable teardown cases, including named resume aliases and later durable-id upgrades.
   - **Actions:** Resolve histories by live SDK id, named resume id, and canonical durable id; append live turns; promote durable backlog; tear down live authority as recoverable and unrecoverable.
   - **Expected outcome:** Per `One authoritative restore ledger`, the resolver returns explicit typed outcomes instead of null-or-throw ambiguity, upgrades aliases in place when the canonical durable id arrives, and removes unrecoverable live aliases so later reads rebuild from durable state or return `missing` rather than serving stale in-memory history.
   - **Interactions:** ledger alias manager, history-source seam, live-session teardown, durable rebuild path.

10. **Name:** Durable message identity is stable across equivalent JSONL rewrites and preserves authoritative upstream ids when present
   - **Type:** boundary
   - **Disposition:** new
   - **Harness:** `server-ledger-unit`
   - **Preconditions:** JSONL fixtures cover idless durable sessions, equivalent rewrites with formatting differences only, and sessions whose records already carry upstream ids.
   - **Actions:** Parse the fixtures through the loader/ledger identity path; compare the resulting canonical message ids.
   - **Expected outcome:** Per `Stable identity before transport`, equivalent semantic rewrites yield the same synthesized durable ids, upstream durable ids are preserved exactly when present, and only material conversation changes create different identities.
   - **Interactions:** session-history loader, canonical fingerprint helper, ledger merge inputs.

11. **Name:** Legacy idless durable sessions still restore coherently through the narrow compatibility path
   - **Type:** regression
   - **Disposition:** extend
   - **Harness:** `server-ledger-unit`
   - **Preconditions:** Durable history exists without stable upstream ids and overlaps with live state in ways that require compatibility merging.
   - **Actions:** Resolve restore for durable-only, fresh live, resumed live-delta, and ambiguous-overlap cases using legacy idless fixtures.
   - **Expected outcome:** Per `Stable identity before transport` and `Execution Notes`, the compatibility path remains narrow but correct: it restores the full durable backlog plus live delta where appropriate, does not use array index as externally visible canonical identity, and logs or classifies divergence instead of silently inventing alternate history.
   - **Interactions:** compatibility merge path, divergence reporting, restore resolution typing.

## Coverage summary

- Covered action space:
  `sdk.create`; `sdk.attach`; `sdk.session.snapshot`; request-scoped `sdk.create.failed`; synthesized `sdk.session.init`; `sdk.session.metadata`; first visible `/api/agent-sessions/:sessionId/timeline` reads; `/api/agent-sessions/:sessionId/turns/:turnId` reads; stale-revision retry/failure behavior; pane retry action after pre-session failure; canonical durable-id persistence; cross-tab layout hydration after identity upgrade; durable/live/named ledger resolution.

- Explicitly excluded per strategy:
  Real Anthropic subprocesses, real Claude JSONL files produced by a live CLI process during browser automation, and multi-process browser reconnect timing outside the repo's in-process WS/RTL/supertest harnesses.

- Exclusion risks:
  There can still be true process-timing or filesystem-flush races that only appear with a real SDK subprocess or real browser reconnect transport. This plan intentionally treats those as a separate environment-risk class because the implementation plan's source of truth is the restore contract, not OS-level timing behavior. If those regressions appear later, the next increment should be a dedicated process-level or browser-level harness, not weaker unit-only coverage here.
