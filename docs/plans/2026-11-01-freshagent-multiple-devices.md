# Freshagent Multiple Devices Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Implement the three-stage Freshagent multi-device robustness proposal so one server-owned conversation can be used from multiple devices and each view reliably reconciles conversation events, settings, controls, and command outcomes. Continue the-usual workflow from the saved plan through implementation, independent review, and a final report.

### Explicit constraints
- Stage 1 separates view lifetime from shared agent lifetime and repairs stale durable bindings: closing or canceling one view detaches it; terminating the shared agent is explicit; historical dead-terminal bindings recover without compromising genuine live-writer exclusion.
- Stage 2 makes attachment and recovery shared and bounded: concurrent device opens join one startup/recovery, acknowledgments and attach failures are requester-scoped, recovery budgets count real failed launches, outdated ownership retries refresh authority, and refresh always settles even on unchanged authoritative state, errors, hangs, or superseded requests.
- Stage 3 provides complete event and command reconciliation: per-view catch-up with cursor/incarnation and snapshot watermark, harmless duplicates and outdated events, queryable stable command outcomes, authoritative command ordering, versioned settings with explicit edits, turn-targeted delayed controls, atomic shared approval decisions, and server acceptance/order of submitted follow-ups while unsent drafts remain local.
- Reuse existing ownership fences, Codex transcript revisions, managed-runtime journals, and send duplicate prevention; preserve provider-specific busy-send behavior and cover Codex, Claude/Kilroy, and OpenCode.
- Add independent desktop/mobile browser coverage and Rust/provider integration coverage for simultaneous cold open, streaming joins, view close/cancel/reload, suspension/reconnect, missed acknowledgments and replay gaps, concurrent sends and approvals, stale settings/interrupts/snapshots, dead bindings, shared startup budgets, one runtime, no duplicate native submissions or transcript rows, converged state, and bounded refresh.

### Accepted tradeoffs and residuals
- A single server authority is sufficient; no distributed collaboration or CRDT system is required.

**Goal:** Two independent devices can use the same Freshagent conversation, close or reconnect their own views, and converge on the server's conversation, settings, accepted commands, and controls without duplicate native actions.

**Architecture:** Keep the existing provider runtime and ownership registry as authority. Share the managed Freshagent actor's event/receipt bookkeeping with default provider session records, preserve Codex's inner transcript projection, and route bounded catch-up and command results to each requesting connection. View detachment changes delivery interest; explicit termination changes the shared runtime.

**Tech Stack:** Rust/Axum/Tokio/SQLite, existing native Codex/Claude/Kilroy/OpenCode adapters, TypeScript/React/Redux, Zod protocol generation, Cargo/Vitest/Playwright, pnpm 10.34.5.

**Preparation status:** The external draft and writer self-review were completed before the user resumed this run. The dedicated worktree is now `.worktrees/freshagent-multiple-devices` on `the-usual/freshagent-multiple-devices`, based at `6b1c961baf8301dc7ebf8d5fdca7105fbfca9cdb`. The base suite previously exited 1 because `managed-provider-qualification` could not compile `crates/freshell-server/src/managed_provider_bootstrap.rs` (`mcp_enabled` is undefined at lines 123/128; the Codex pattern at line 372 omits `approval_default`). The complete receipt remains in the baseline ledger. These errors affect every server build with `managed-runtime-v1`, including `managed-fresh-agent-fixtures`, not only the qualification lane. The user explicitly resumed after that failure was reported. The small bootstrap repair below is required setup for the requested managed coverage and is therefore in scope; preserve the original base failure rather than waive the managed acceptance rows. This committed plan is the implementation contract for the three stages below; source and review corrections supersede its code drafts once execution begins.

## Load-bearing outcome: viable plan; implementation and verification pending

Fresh Eyes round 1 found that the previous FAILED/non-converged conclusion imposed a provider-internal atomic cancellation guarantee beyond the requested single server authority. The corrected contract checks the device's captured source and owner turn under existing server submission serialization immediately before native adapter invocation. A delayed request for settled A is rejected when B is current, with zero native interrupt. Codex retains its native turnId; Claude/Kilroy reuse the turn ledger; OpenCode adds an owner activity generation to its existing drive/daemon lifecycle. Task 14 specifies those mappings and preserves ordinary Stop and provider busy-send behavior. Native work may change inside a provider after an admitted operation is sent; the existing provider API limitation remains, and the plan does not promise an atomic compare inside that provider.

Tasks 1–7 have no dependency on the Stage 3 turn-control design and can proceed in their stage order, including the required managed compile setup. Task 14 must establish the target and settlement evidence consumed by Task 15; accepted follow-ups remain tied to their captured target during bounded unknown settlement. A failure of either task leaves that required Stage 3 behavior incomplete and cannot be reported as full success. No implementation task has started (0/16); prepared dependencies, images and runtime files remain unverified. Earlier binding, snapshot, settings, receipt and send-fence corrections remain in force. The historical load-bearing reports retain their source observations; `reports/plan-remediation-astra-round-1.md` under `.worktrees/.the-usual-logs/freshagent-multiple-devices/` records the corrected scope and plan decisions.

## Global Constraints

1. Execute only in the verified dedicated worktree `.worktrees/freshagent-multiple-devices` on `the-usual/freshagent-multiple-devices`, with immutable base `6b1c961baf8301dc7ebf8d5fdca7105fbfca9cdb`. Preserve the recorded base-gate failure and any later same-base receipt; do not rewrite a failed baseline as green. Main and unrelated work remain untouched.
2. Continue the three stages in the task order below after plan review. Scope delayed-control safety to the serialized server dispatch boundary; keep any task-specific target/settlement failure local to Tasks 14–15, while requiring it to be resolved before full completion. Do not deploy, restart the live port-3001 server, create a PR, or merge. Repair the managed bootstrap compile defects because they prevent required managed verification; unrelated baseline failures stay documented separately and cannot waive an acceptance-matrix row.
3. Node >=22.5, Rust stable/workspace minimum 1.96, exactly pnpm 10.34.5; reuse installed dependencies and prepared runtime files. Use `pnpm install --frozen-lockfile` only when needed. NodeNext/ESM relative TypeScript imports end in `.js`.
4. Keep the default in-process Freshagent path and the optional managed Freshagent path working. Do not enable a managed feature flag to evade default-path work. Managed terminal support alone is not managed Freshagent support. Provider findings apply to the inspected repository pins, not an arbitrary CODEX_CMD, CLAUDE_CMD/SDK-module or OpenCode executable override; unknown capabilities need operation-specific handling and cannot be used to claim the pinned defaults are supported.
5. Preserve one native writer, owner epoch/generation, operation tickets, provider leases, terminal-liveness checks, handoff fences, send logical-attempt fences, and provider-native busy/attention behavior. Never use browser presence or a durable terminal ID as proof of process liveness.
6. Reuse `freshell-agent-runtime/src/host_actor.rs`, the managed **Freshagent** journal. `freshell-session-host/src/command_journal.rs` and `output_journal.rs` belong to PTYs and are outside this feature. `freshell-freshagent` already depends on `freshell-agent-runtime`, so provider-neutral bookkeeping can live there without a new ownership service. Extract the platform-aware atomic replacement contract to `freshell-platform` for the new default and managed state writes; add the direct dependency needed by `freshell-agent-runtime` and verify the crate graph remains acyclic.
7. Follow [test sandbox guidance](../development/test-sandbox.md), [pre-push gate](../development/pre-push-gate.md), [self-hosted launch runbook](../development/self-hosted-launch-runbook.md), and [Windows build instructions](../development/windows-electron-build.md) rather than duplicating operational procedures. Do not restart the live port-3001 server. No new deployment script or production migration command is needed.
8. Use red/green/refactor behavioral tests, including meaningful integration and independent-device browser evidence. Do not test prose, generated source text, hashes, or static configuration by string matching. Never weaken or skip a behavior test to obtain green.
9. The configured Vitest and browser backends are `cloud`; preserve them. Agent broad gates set `GCLOUD_ROBOT_REQUIRE=1` and `FRESHELL_RUST_TEST_SANDBOX=1`. A broken cloud lane must be repaired, not silently replaced by local. Required repository-classified local-only managed fixtures are a separate supplemental gate, not a fallback. Server managed proxy/bootstrap Cargo selectors explicitly enable `--features managed-runtime-v1`; record positive selected/executed counts for each required module/provider. A compile failure or zero-match run cannot satisfy a red behavioral regression or green acceptance gate.
10. Tests use their existing worktree and configured result paths. Disposable files go in `.test-tmp/`; retained diagnosis in `test-results/`. Stop only task-owned verified processes, record external temporary paths, and clean them after each run. No broad kill patterns, live provider session, or prior repaired conversation is test input.
11. End-user documentation belongs in `README.md`; update `docs/index.html` only for the resulting major UI actions. Agent documentation is this plan. Logs are structured JSONL with severity and request/source/order identifiers; never log prompt, draft, approval answer, or credential contents.

## Load-bearing decisions to validate before implementation

The stage-2 ledger and its independent validation reports govern these ten decisions. Source-backed corrections below are already applied: remove acceptance-time private settings restoration, make replay gaps explicit, describe receipt retention as new behavior rather than an existing actor facility, use platform-aware atomic replacement, and use the local Docker managed fixture route. Routine selector spelling and generic correctness of code not yet written are task verification, not additional assumptions.

1. Binding mutation uses exact-operation prepare/write/commit-or-repair for both Starting and Handoff. Persist the originating operation ID in the binding and repair fence, retain monotonic epoch/generation stale-write protection, and keep failed cleanup fenced. A restored prior owner can share the failed handoff's generation, so that pair alone cannot identify its row.
2. Codex, Claude/Kilroy and OpenCode need provider-specific stable identities and versions for one-time merging of live output with durable history during continuous output. For pinned OpenCode 1.18.21, continuous joins require the instance `/event` route and its `server.connected` readiness barrier, retaining part bases/deltas in the shared owner; missing delta prefixes, reconnects or local lag require an affected-part gap until a full replacement. This is an implementation contract, not evidence that a target-safe interrupt exists. See `reports/load-bearing-validator-LB-2-OpenCode-streaming.md` and `reports/load-bearing-strategist-lb2-opencode-assumptions.md`.
3. Managed capture must pair retained presentation with its real event watermark across provider-to-actor loss and coalescing, or return an explicit gap/reset.
4. Shared settings edits report evidence-backed effective fields separately from desired/staged values, with explicit partial or unknown outcomes after failure or lost response; preserve each provider's busy behavior.
5. Receipts must distinguish request write, provider acceptance, completion and possible delivery; controls that finish a turn must remain dispatchable, and uncertain sends must not be replayed.
6. A stable durable conversation/store identity must survive materialization aliases, rekey and restart while a true fork receives a new identity. Serialize alias resolve-or-create before admission/recovery; unreadable or conflicting identity is not Missing. Atomic replacement alone does not serialize competing reservations.
7. All send ingress must reference one durable send-effect fence; receipt/order storage may describe its outcome but must never grant a second native dispatch permit.
8. Expose source-scoped owner turns independently of one-to-one client commands. Reuse Codex native turn IDs, Claude/Kilroy ledger starts/results/idle and prestart membership, and OpenCode owner activity generations correlated with drive/daemon settlement. Task 14 defines zero-to-many membership, commandless activity, duplicate/trailing events and uncertain settlement. These are server-observed turn boundaries, not invented native IDs; Task 15 waits on the captured owner target and never retargets accepted work.
9. Under owner submission serialization, compare the captured source/turn after any server-side admission wait and before invoking the native interrupt adapter or mutating Stop state. Recheck server-controlled retries against the original target. Preserve the provider API and its existing behavior after dispatch; no provider-internal atomic cancellation guarantee or blanket Stop refusal is required.
10. Existing cloud-legal default and local Docker managed fixtures must provide positive independent desktop/mobile cases and native request audits for the required interleavings without live providers.

The ledger records each claim's evidence, method, fallback and status. Static-only findings are acceptable when the proposed behavior does not yet exist or execution would require unsafe setup; missing execution is recorded as a gap rather than inferred as proof.

## File responsibilities and interfaces

The map covers files introduced or materially modified. Existing nearby inline tests stay with their owner; generated files are outputs, not hand-edited authorities.

| Files | Responsibility |
| --- | --- |
| `shared/ws-protocol.ts`, `shared/fresh-agent-contract.ts` | Additive view/request, negotiated reconciliation, command, settings, target and queue contracts. |
| `crates/freshell-protocol/src/client_messages.rs`, `server_messages.rs` | Rust equivalents and validation; distinguish transport request IDs, command IDs, native control request IDs and event cursors. |
| `port/contract/ws-protocol.schema.json`, `ws-server-messages.schema.json`, `ws-message-inventory.json`, `managed-runtime.schema.json` | Tracked outputs of `pnpm run contract:generate` in tasks that change their sources. |
| `src/components/panes/PaneContainer.tsx`, `src/store/tabsSlice.ts`, `src/store/terminalDetachMiddleware.ts` | View close/replacement cleanup through existing durable pane/view acknowledgment paths. |
| `src/lib/fresh-agent-ws.ts`, new `src/lib/fresh-agent-view-attachment.ts` | One scoped detach helper, canceled-create handling, negotiated delivery gate before provider side effects. |
| `src/lib/ws-client.ts`, `src/lib/fresh-agent-stream-batcher.ts` | Run the canonical reconciliation gate before raw view subscribers and invalidate pending stream batches at source/snapshot boundaries. |
| New `src/lib/fresh-agent-pending-commands.ts` | Device-local bounded unresolved command IDs for receipt query after full reload; never server command authority or prompt storage. |
| `src/components/fresh-agent/FreshAgentView.tsx`, `src/lib/kill-ack.ts` | View switch/fork cleanup, explicit shared termination, correlated attach/retry, finite refresh and command-aware composer. Preserve kill acknowledgment semantics. |
| `crates/freshell-ownership/src/lib.rs` | Extend existing ticket authority with exact claimed binding commit; no second registry. |
| `crates/freshell-freshagent/src/identity_sink.rs`, `crates/freshell-server/src/identity_sink.rs`, `crates/freshell-ws/src/pane_ledger.rs` | Separate identity establishment from settings replacement; verify exact current claim at mutation and preserve cancellation repair. |
| New `crates/freshell-freshagent/src/session_recovery.rs`, provider modules `claude/recovery.rs`, `claude/attach.rs`, `codex.rs`, `opencode_ws.rs` | Existing provider ensure paths share one in-flight operation/result/budget per canonical session; requester attach results. |
| `crates/freshell-ws/src/reconcile_freshagent.rs`, `lib.rs`, `src/lib/pane-reconcile.ts`, `src/store/panesSlice.ts` | Pure per-view reconcile from canonical runtime/recovery facts; multiple same-session views retain their locator. |
| `src/lib/fresh-agent-snapshot-scheduler.ts`, `src/lib/fresh-agent-reveal-freshness.ts`, new `src/lib/fresh-agent-refresh.ts` | Scheduler-owned read timeout and per-view non-extendable refresh deadline. |
| New `crates/freshell-agent-runtime/src/reconciliation.rs`, `reconciliation_tests.rs`, existing `lib.rs`, `host_actor.rs` and `host_actor_tests.rs`; `crates/freshell-agent-runtime/Cargo.toml`; new `crates/freshell-platform/src/atomic_file.rs` and platform tests | Shared bounded event/receipt/settings/queue bookkeeping and atomic retained presentation; one platform-aware atomic replacement helper used by managed and default state writes. |
| New `crates/freshell-freshagent/src/session_reconciliation.rs`; `claude.rs`, `claude_edges.rs`, `claude_projection.rs`, `claude_snapshot.rs`, `codex.rs`, `codex/projection.rs`, `codex/controls.rs`, `opencode_ws.rs`, `snapshot.rs`, `lib.rs`; `crates/freshell-opencode/src/serve.rs`, `events.rs`, `transport.rs` | Default owners stamp canonical events and retain native-keyed overlays; durable command state; provider-native submission/target/decision integration; instance-stream readiness, payload and loss signaling. |
| `crates/freshell-server/src/main.rs` | Inject the existing isolated-home state root into default reconciliation owners; no production restart or launch change. |
| `crates/freshell-server/src/managed_provider_bootstrap.rs` | Required managed compile setup: reuse optional MCP capability preparation and preserve Codex approval defaults; exercise the existing feature-gated bootstrap tests. |
| `crates/freshell-freshagent/src/rest_lane.rs`, `rest_lane_sync.rs`, `claude_rest_lane.rs`, `codex_rest_lane.rs`, `crates/freshell-server/src/fresh_agent_proxy_rest.rs` | HTTP/CLI/MCP-facing ingress uses the same command admission and receipt authority as WebSocket ingress. |
| `crates/freshell-ws/src/terminal.rs`, `hosted_fresh_agent.rs`, `checkpoint_barrier.rs`; new `crates/freshell-ws/src/freshagent_delivery.rs` | Requester context, connection-scoped interest, bounded sync delivery and checkpoint linkage. |
| `crates/freshell-server/src/fresh_agent_proxy.rs`, `checkpoints.rs` | Managed gateway preserves source/sequence/watermark; existing logical-attempt checkpoint store stays authoritative. |
| `crates/freshell-runtime-protocol/src/lib.rs`, `fresh_agent_ops.rs`, `crates/freshell-runtime-client/src/lib.rs`, `crates/freshell-session-host/src/main.rs`, `providers/fresh_agent.rs`, `crates/freshell-supervisor/src/lib.rs`, `service.rs` | Existing host/admin operations carry atomic captures and command preconditions/results; supervisor lifecycle lock remains activation authority. |
| New `src/lib/fresh-agent-reconciliation.ts`; `src/store/freshAgentSlice.ts`, `freshAgentLiveSlice.ts`, `src/lib/fresh-agent-transcript-projection.ts` | Canonical per-browser session fold, contiguous cursors, bounded gap recovery and source adoption; preserve inner Codex revisions. |
| `src/lib/fresh-agent-configure.ts`, `fresh-agent-settings-convergence.ts` | Versioned explicit settings edits; legacy behavior remains behind negotiation. |
| New `test/e2e-browser/helpers/fresh-agent-multiple-devices.ts`, new `specs/fresh-agent-multiple-devices-rust.spec.ts` | Test-owned production server/adapters, independent desktop/mobile contexts, controlled native/network faults and native request/count evidence. |
| Existing provider fixtures `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`, `test/e2e-browser/fixtures/fake-opencode.cjs`, `helpers/claude-sim-lane.ts`, existing managed fixture spec/helpers | Deterministic native boot/turn/decision gates and request audits; do not replace adapters with browser-only fabricated frames. |
| New `crates/freshell-ws/tests/freshagent_multiple_devices.rs`, `tests/common/multiple_devices.rs`; existing `pane_reconcile.rs`, `cross_kind_liveness.rs`, Claude observer/checkpoint/control integration tests | Actual merged router, ownership, ledger and provider transport integration across two sockets. |
| Existing client pane/view/WS/reconcile/scheduler/projection tests, new refresh/reconciliation/attachment tests; provider/server/host inline tests | Behavioral red/green regressions for each task's production contract. |
| `README.md`, `docs/index.html` | Explain close, terminate, shared accepted follow-ups/settings, local drafts and finite recovery in user terms. |

### Shared contracts and runtime invariants

1. `ViewAttachment = {viewId, requestId, locator, observedEpoch?, observedGeneration?}`. The browser mints a view ID per pane attachment lifetime and a request ID per immutable attach decision. Transport retry keeps both; an authority refresh makes a new request ID/decision. Server interest is `(connection, viewId)`, never just session ID. View IDs are not owner claims and do not decide runtime lifetime. Existing machine/tab/pane provenance stays distinct.
2. `FreshAgentSource = {incarnation: string, ownerEpoch: number, ownerGeneration: number}` and `FreshAgentCursor = {source: FreshAgentSource, sequence: number}` use safe integer validation. A source identifies one runtime event producer. A durable locator, native materialization alias and Codex projection ID retain their existing meanings. Rekeying a native/presentation ID within a runtime preserves source/commands; replacing the runtime changes source but not durable command IDs.
3. `freshAgentReconciliationV1` is additive negotiated capability. New fields on existing messages are optional for old callers; modern envelopes/replies are sent only to negotiated connections. Without negotiation, preserve legacy payload parsing/provider-native semantics, with the requested close, safe binding, shared recovery and requester isolation fixes still active. One global event cannot be both an unwrapped legacy frame and a modern wrapped frame applied by the same connection.
4. Modern `freshAgent.attached` / `freshAgent.attach.failed` carry `requestId`, `viewId`, canonical locator and full current authority. Failure includes typed code, retryable, recovery operation ID and retry floor when relevant. Modern `freshAgent.detach` / `freshAgent.detached` remove/ack only that connection's view interest. Disconnect drops only that connection's interests. Shared termination remains the explicit existing Kill operation, later command-receipted in Task 12.
5. Shared `ReconciliationState` owns a bounded sequenced event window, retained presentation projection, settings revision, command lookup and accepted queue. Defaults reuse managed limits: 4096 events / 4 MiB. The modern replay window is always an honest contiguous suffix or carries explicit gap/reset metadata; pending decisions live in captured control state, not by preserving interior events in a false suffix. A committed presentation mutation and its event sequence are one synchronous owner-state mutation before publication. Do not sequence events by subsequently watching the global broadcast bus.
6. `capture_snapshot() -> SnapshotCapture` freezes presentation/settings/controls/queue/receipts and its exact cursor under that same short state lock. Native/durable reads happen outside it; validate their native/history generation when merging. Retain keyed live overlays until durable native IDs confirm inclusion. Copy immutable references/values without awaited RPC, filesystem or socket work inside the lock. Capture succeeds while output continues; neither repeated head sampling nor waiting for quiet establishes correctness. Serialize a captured snapshot in bounded pages; one active capture per view, replacing/disposal on new capture, detach or deadline. Existing provider history paging/retention limits remain in force; do not introduce an unbounded all-history copy.
7. `freshAgent.sync` takes `{requestId, viewId, locator, cursor?, maxEvents?, maxBytes?, commandIds?}`. Clamp page requests to 256 events / 256 KiB and receipt IDs to 128 using existing frame-size validation. Reply only to requester with source, retainedFrom/head, events, receipts, nextCursor, explicit gaps where sequences are unavailable, optional captured snapshot and its watermark/resetRequired. Snapshot chunks share an immutable capture ID/watermark and are applied only when complete; a partial/expired capture is retried or finitely failed, never displayed as complete. Register interest before capture; buffer live suffix through its head, then deliver only greater sequences. Advance a cursor only across returned events, explicitly irrelevant ranges or declared gaps. Overflow/eviction yields explicit gap/reset, never provider termination.
8. `CommandMeta = {commandId, expectedSource?}`; sends reuse `checkpointIntent.logicalAttemptId` and request aliases. `CommandReceipt = {commandId, payloadDigest, acceptedOrder, state, effectiveSettingsRevision?, submittedTurnId?, providerAckId?, result?}`. States distinguish queued/accepted, dispatching, provider-acknowledged, completed/cancelled, rejected and ambiguous. Missing, expired and store-unreadable lookup are distinct. Detailed receipt retention is bounded; compact dedup/expiry metadata is explicitly added where required to keep stable lookup, but is not a native send permit. The existing send-effect fence remains the only authority that may permit a send; receipt records reference its outcome. No lazy archive lookup is promised.
   Keep at most 4096 detailed settled receipts in active owner state and 128 unresolved admitted commands; refuse additional admission with typed backpressure before native effect rather than dropping unresolved state. Define and test the compact lookup/expiry representation alongside the single send-fence crash policy in Tasks 8–12. Do not evict or duplicate the existing send-effect fence merely to bound the in-memory receipt projection. Accepted queue payload has the separate Task 15 128-entry/4MiB cap.
9. Under existing owner submission serialization, admission checks source/fences/preconditions and same-ID digest, persists acceptance/order/payload before native effect, and invokes eligible commands in accepted order. The release boundary and receipt evidence are provider-specific: Codex correlated start/steer response, Claude correlated native queued/started lifecycle, and OpenCode bounded HTTP dispatch/response with no inferred native FIFO admission. Record actual dispatch order separately: a follow-up waiting for turn completion cannot block an interrupt or approval targeting that active turn. Streaming response duration does not hold the submission gate. Typed no-dispatch refusal may be retried only under its proven safe policy; possible native delivery is ambiguous and never automatically resent under the old or a newly minted ID. Provider acknowledgment requires correlated native acceptance, not checkpoint capture, a wire write or `dispatch_started`. Existing send checkpoint outcomes retain their separate rewind meaning.
10. `SettingsState` separates versioned desired values from effective values, per-field certainty and application scope (`current`, `next-turn`, `unknown`); explicit edits use `expectedSettingsRevision` and patch semantics (absent preserves, `effort: null` selects Default). Ordinary modern sends carry no cached settings and cannot restore stale view state over newer shared defaults. Report effective settings/revision only at a provider boundary that can establish them; represent partial or uncertain explicit edits honestly. `TurnTarget` uses a source-scoped owner turn identity with native identity when available, membership for zero-to-many associated commands, and explicit prestart/unknown states. Validate a delayed control's captured target under owner submission serialization immediately before native adapter invocation; never infer that one client command names every native turn. Provider-internal progress after dispatch remains subject to the existing native operation's semantics.
11. Native decisions claim Pending -> Dispatching atomically before awaiting a write; response digest/result and winning receipt persist. Opposite/duplicate losers get requester-scoped typed outcomes, not shared session errors. Unknown delivery stays ambiguous. Shared membership and resolution still broadcast. Unsupported provider features remain typed unsupported.
12. Unsent drafts stay in the local view. Pressing Send with follow-up intent immediately accepts a durable server command `delivery: 'after-current-turn'`; its queue is shared and survives reload/detach. Queued payload and accepted order persist; settings are resolved by shared authority at actual dispatch, not frozen by the submitting view. Normal `delivery: 'native'` preserves Codex steering, Claude native busy acceptance and OpenCode's compact-only FIFO and ordinary busy-send behavior. Cancellation succeeds only before Dispatching.

### Task order

Stage 1 is Tasks 1–3, Stage 2 is Tasks 4–7, and Stage 3 is Tasks 8–16. Execute in numeric order, completing the managed compile setup before the first managed gate; each task consumes the preceding committed interfaces. Tasks 1–7 are independent of Tasks 14–15, so later control/follow-up uncertainty does not stop their work. Task 15 specifically depends on Task 14's implemented and verified target/settlement mapping; full completion requires both. Task 8 is shared bookkeeping, not a switch to managed Freshagent. Each implementation stage earns actual two-device browser and Rust/provider evidence before the next stage; the final matrix ties the stages together. Plan code is a pre-implementation draft: once execution starts, source and review corrections supersede its code blocks; task intent and the User Request remain authoritative.

---

## Required setup: restore managed bootstrap compilation

**Files:** `crates/freshell-server/src/managed_provider_bootstrap.rs` and its existing inline tests. This is a prerequisite for the managed gates, not a new provider feature or a waiver of the recorded base failure.

- [ ] Preserve the baseline compile receipt and add behavioral coverage for Codex launch context with and without an MCP capability, plus preservation of an existing `approval_default` when attaching a capability. Reuse the existing managed Codex context test. Run `pnpm run test:sandbox "cargo test --locked -p freshell-server --features managed-runtime-v1 managed_provider_bootstrap"`; initially record the known compile failure separately from behavioral red/green results.
- [ ] Initialize Codex TUI/sidecar MCP arguments empty in the base preparation, as for the no-capability path. Use the existing final `with_managed_mcp_reference` call to populate them only when a capability is supplied. Make its Codex match preserve fields it does not change, including `approval_default`. Do not introduce another MCP-enabled flag or change grant selection.
- [ ] Repeat that focused command green with positive bootstrap test counts; also run `pnpm run test:sandbox "cargo test --locked -p freshell-server --features managed-runtime-v1 fresh_agent_proxy"` with positive counts. Refactor away only the duplicate/broken argument preparation. Commit the source and behavioral tests together with `git add crates/freshell-server/src/managed_provider_bootstrap.rs` and `git commit -m "fix(server): restore managed provider bootstrap compilation"`.

## Stage 1: Separate view lifetime and repair durable identity

### Task 1: Closing a view detaches it and explicit termination remains shared

**Files:**
- Create: `src/lib/fresh-agent-view-attachment.ts`, `test/unit/client/lib/fresh-agent-view-attachment.test.ts`, `test/e2e-browser/helpers/fresh-agent-multiple-devices.ts`, `test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts`.
- Modify: `shared/ws-protocol.ts`, `shared/fresh-agent-contract.ts`, `crates/freshell-protocol/src/client_messages.rs`, `server_messages.rs`, `crates/freshell-ws/src/terminal.rs`, `hosted_fresh_agent.rs`, `crates/freshell-server/src/fresh_agent_proxy.rs`, `src/components/panes/PaneContainer.tsx:379`, `src/store/tabsSlice.ts:1131`, `src/components/fresh-agent/FreshAgentView.tsx`, and the four generated `port/contract/` outputs listed above.
- Test: `test/unit/client/components/panes/PaneContainer.test.tsx`, `test/unit/client/lib/kill-ack.test.ts`, `crates/freshell-ws/src/hosted_fresh_agent_tests.rs`, `crates/freshell-server/src/fresh_agent_proxy_tests.rs`.

**Interfaces:**
- Consumes: existing `closePaneWithCleanup`, managed `detachManagedViews` and pane-close acknowledgment/compensation; existing `sendFreshAgentKillAndAwait` for explicit termination.
- Produces: `detachFreshAgentView(ws, attachment): Promise<void>`; optional `viewId` on attach/create routes; requester `freshAgent.detached`; explicit “Terminate agent” action. No runtime refcount or ownership registry.
- Produces test helper `withTwoDeviceSession(mode, body): Promise<void>` for the four modes, yielding `{desktop, mobile, native, session, frames, close}`. `desktop/mobile` contain separate contexts/pages, `native` exposes actual fixture audit rows and deterministic boot/turn release, `session` is the actual canonical durable locator. Extend this declared helper in later tasks rather than inventing separate rigs.

The helper covers freshclaude, kilroy, freshcodex and freshopencode. Its audit
records actual received native operations, source/owner, command identity when
carried, settings/options, decision digest, and affected native work when the
provider exposes it. Native turn IDs are optional evidence, not fixture-minted
substitutes for a provider capability it does not expose. Keep dispatch counts separate
from accepted/started/completed counts. Desktop/mobile each contain an
independent context/page; boot/turn holds and release hooks operate on the
native fixture, and cleanup owns only that fixture's resources.

- [x] **Step 1: Write the failing behavioral tests**

```text
PaneContainer test: close A while A and B reference the same running session.
Hold A's durable pane/view detach acknowledgment. Assert A remains displayed;
release it and assert only A is removed. Shared session entry and B remain;
freshAgent.kill and recovery-stop counts stay zero. Repeat sessionRef-only,
last-pane/tab cleanup and failed-detach compensation. Explicit Terminate agent
must still await the existing kill acknowledgment and stop the shared session.

fresh-agent-view-attachment.test.ts: exercise detachFreshAgentView with two
attachments to the same locator. Only an acknowledgment matching requestId and
viewId settles A; unrelated/old acknowledgments leave it pending and cannot
settle B. Duplicate matching acknowledgments are harmless. A typed failure,
disconnect or fixed timeout rejects and releases its listener/timer so pane
cleanup can compensate; none sends Kill or removes shared session state.

Browser helper: factor owned RustServer/machine-registration flow from
handoff-two-device-rust.spec.ts and provider fixtures from
fresh-agent-control-rust.spec.ts. Create independent contexts with desktop
{viewport:{width:1440,height:900},isMobile:false,hasTouch:false} and mobile
{viewport:{width:393,height:851},screen:{width:393,height:851},
 deviceScaleFactor:2.75,isMobile:true,hasTouch:true}. Assert distinct nonempty
freshell.device-id.v2 and independent localStorage. Use real server/adapters.

For every mode, test name starts 'stage1 close': hold native work, open the
same locator on both devices, close mobile's view, release that work, and assert
desktop receives its resulting output, runtime/native boot count=1, native
terminate count=0 and one transcript row per native message. Claude/Kilroy and
Codex can hold streaming output. For OpenCode use the existing
FAKE_OPENCODE_HOLD_PROMPT_GATE_PATH and FAKE_OPENCODE_DEFER_PROMPT_ROWS_TO_GATE=1:
observe the prompt_async audit/busy status, close mobile, release the gate, and
assert desktop receives the newly persisted rows/idle through the real adapter.
No OpenCode live delta support is needed here; Task 9 separately adds and tests
that fixture behavior. Reuse these gates for Task 2 close/cancel/switch coverage.
Then use explicit Terminate agent and assert one native stop and desktop stopped
state.
```

- [x] **Step 2: Run and verify the intended failure**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/panes/PaneContainer.test.tsx -t 'shared session' --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-view-attachment.test.ts --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage1 close'`

Expected: FAIL because closing A sends Kill/stops B; the new detach acknowledgment/explicit action behavior is absent. Assert nonzero selected counts; setup errors are not the intended red.

- [x] **Step 3: Apply the precise production patch**

```text
Add additive FreshAgentDetach{provider,sessionType,sessionId,sessionRef?,
viewId,requestId} and FreshAgentDetached{viewId,requestId,sessionRef} variants.
The outer WS router supplies requester FrameSink to direct/hosted routing.
Server removes only (connection,viewId) delivery interest and acknowledges
that requester; it never calls provider Kill, client.stop, ledger retire,
poller stop or desired-state stop. Repeated detach is acknowledged idempotently.

PaneContainer.handleClose: cancel pending view work if needed, await scoped
detach and existing closePaneWithCleanup, then remove only that pane. Preserve
managed revision checks, durable pane.closed evidence and failure compensation.
Remove shared freshAgent session deletion/kill from ordinary close. Disconnect
and final local view removal do not infer a runtime stop.

Add Terminate agent to the existing Freshagent action surface, using the
existing fenced kill acknowledgment helper. Its success folds shared killed
state for all views; normal composer Stop remains a turn interrupt. Keep the
existing process-only recovery-stop action distinct. Generate contracts with
pnpm run contract:generate; never hand-edit generated JSON.
```

- [x] **Step 4: Run the focused tests**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/panes/PaneContainer.test.tsx -t 'shared session' --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-view-attachment.test.ts --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage1 close'`

Expected PASS in all four selected browser modes.

- [x] **Step 5: Refactor while green**

Keep attachment identity and detach acknowledgment timeout in the new helper; remove only now-unused kill-on-close imports/comments. Reuse existing tab cleanup rather than introducing a parallel layout-removal path.

- [x] **Step 6: Run impacted verification**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/kill-ack.test.ts test/unit/client/lib/fresh-agent-view-attachment.test.ts --config config/vitest/vitest.config.ts`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --lib hosted_fresh_agent"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-server --features managed-runtime-v1 fresh_agent_proxy"`

Run the Step 2 browser command and `pnpm run typecheck`; expected PASS. Routing/protocol callers are included because every hosted command now receives requester context.

- [x] **Step 7: Commit**

```bash
git add shared/ws-protocol.ts shared/fresh-agent-contract.ts crates/freshell-protocol/src/client_messages.rs crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/hosted_fresh_agent.rs crates/freshell-ws/src/hosted_fresh_agent_tests.rs crates/freshell-server/src/fresh_agent_proxy.rs crates/freshell-server/src/fresh_agent_proxy_tests.rs src/lib/fresh-agent-view-attachment.ts src/components/panes/PaneContainer.tsx src/store/tabsSlice.ts src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/lib/fresh-agent-view-attachment.test.ts test/unit/client/lib/kill-ack.test.ts test/e2e-browser/helpers/fresh-agent-multiple-devices.ts test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts port/contract/ws-protocol.schema.json port/contract/ws-server-messages.schema.json port/contract/ws-message-inventory.json port/contract/managed-runtime.schema.json
git commit -m "fix(freshagent): detach closed views without terminating shared agents"
```

### Task 2: Cancellation and view switches preserve other devices' sessions

**Files:**
- Modify: `src/lib/fresh-agent-ws.ts:181`, `src/lib/fresh-agent-view-attachment.ts`, `src/components/fresh-agent/FreshAgentView.tsx:2338`, `src/store/tabsSlice.ts`, `src/store/terminalDetachMiddleware.ts`.
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts`, `test/unit/client/fresh-agent-ws.test.ts`, `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, `test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts`.

**Interfaces:**
- Consumes: Task 1 attachment/detach and existing canceled-create markers, parent-retired runtime signal, pane/view cleanup.
- Produces: late-create result consumption scoped by request/view identity; no cleanup Kill for a view cancellation, new conversation or non-retiring fork/repoint.

- [x] **Step 1: Add failing tests**

```text
Change existing canceled-create regressions to execute this behavior: cancel
A's create, let B join its server session, deliver A's late created result.
Assert A's pending route/marker is settled and only A's attachment released;
B's shared session/stream survives and Kill count=0. Repeat OpenCode cwd
route cleanup and an old late result after the same pane has a new viewId.

FreshAgentView: A starts a new conversation or forks/repoints while B streams
the parent. Assert only A detaches/rekeys and B continues. A runtime-reported
parentRetiredByRuntime still stops/converges parent state; client emits no
additional parent kill. Failure of local detach preserves current view/draft.

Browser 'stage1 cancellation': gate native create, cancel one device's view,
release startup while the other attaches, then reload surviving device and
assert one native runtime, zero cleanup stops, unique transcript rows.
Browser 'stage1 switches': new/fork A, verify B continues parent, including
provider-required parent retirement as an explicit distinct expected outcome.
The in-process fixture covers the non-retiring fork outcome. A separate
managed-runtime fixture seeds real parent state on both devices, then proves
the requester alone rekeys to the child while the sibling stays on its parent
view and sees that parent exit, with no client detach or kill.
```

- [x] **Step 2: Run and observe red**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t 'other view|late create|parent view' --config config/vitest/vitest.config.ts`

Expected FAIL: canceled late create/new-conversation/fork cleanup kills the shared parent or removes its session state.

- [x] **Step 3: Apply production patch**

```text
Carry viewId with pending creates/canceled markers. On late created/forked,
match the original request+view before modifying local route state. A canceled
view releases only that view and never removes canonical session state. Keep
result/identity available to another attached/requesting view. Stale replies
cannot attach themselves to a replacement view or clear its pending state.

Replace startNewConversation's shared stop and forked callback cleanup kill
with detachFreshAgentView. Leave provider-required parent retirement as
reported authoritative shared state; do not fabricate a second native writer.
Dropping a waiting view must not cancel a server-owned startup. Keep managed
visibility and pane.closed acknowledgment paths, including failed detach
compensation. Preserve explicit termination and explicit recovery-stop paths.
```

- [x] **Step 4: Green**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t 'other view|late create|parent view' --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage1 cancellation|stage1 switches'`

Expected PASS with four provider modes.

- [x] **Step 5: Refactor**

Centralize request/view result matching and scoped cleanup in the attachment helper; remove only obsolete cleanup-kill branches and keep shared termination acknowledgment tests intact.

- [x] **Step 6: Impacted verification**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx --config config/vitest/vitest.config.ts`

Run the Step 4 browser command; expected PASS. These cover canceled routes, kill folding, tab replacement and view-switch callers.

- [x] **Step 7: Commit**

```bash
git add src/lib/fresh-agent-ws.ts src/lib/fresh-agent-view-attachment.ts src/components/fresh-agent/FreshAgentView.tsx src/store/tabsSlice.ts src/store/terminalDetachMiddleware.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts
git commit -m "fix(freshagent): preserve shared sessions across view cancellation and switches"
```

### Task 3: Verified recovery claims heal dead terminal bindings without settings loss

**Files:**
- Modify: `crates/freshell-ownership/src/lib.rs`, `crates/freshell-freshagent/src/identity_sink.rs`, `codex.rs`, `claude.rs`, `opencode_ws.rs`, `session_handoff/tests.rs`, `crates/freshell-server/src/identity_sink.rs`, `crates/freshell-ws/src/pane_ledger.rs`, `pane_ledger_tests.rs`.
- Test: `crates/freshell-ws/tests/cross_kind_liveness.rs`, `test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts`, native fixture audit support in the shared browser helper.

**Interfaces:**
- Consumes: current `OperationTicket`, `begin_start`/handoff claims, terminal-liveness probe and production sink's revalidation/repair mechanism.
- Produces: `BindingClaim` containing exact operation identity/epoch/generation and allowed Starting/Handoff/Live-Freshagent claim kind; `SettingsUpdate::{Keep,Replace(FreshAgentSettings)}`. Identity-only writes never imply a settings record.
- Produces: binding-before-Live/answer invariant for every successful identity-establishing create/resume/adopt/fork/recovery, retaining separate semantics for post-acceptance settings refresh.

- [x] **Step 1: Add failing behavioral regressions**

```text
Ledger + production sink tests: seed unstamped and stamped historical Bound
terminal rows whose live process probe is false. Successful current Starting
Freshagent proof converts kind/provider/session and clears live_terminal_id,
preserving known settings; no-settings history remains identity-only and does
not trigger SETTINGS_RESET/default laundering. No proof, stale/equal refresh,
or genuinely Running terminal owner must refuse with zero native second starts.

Park production spawn_blocking sink before validation and after validation.
Cancel/supersede the exact ticket, install a newer terminal/agent binding and
release. Assert no old Bound resurrection/retirement of the newer row. Test
native resume failure, wrong native identity, ledger I/O error: close only the
partial runtime and never answer success/commit an unbound Live replacement.
Run both write/cancel orderings for Starting and Handoff, including a restored
prior Freshagent at the failed handoff's generation but a different ownership
ID. Its row and newer rows survive; only the failed operation's orphan is
retired. Hold/fail the repair write and assert the claim stays fenced with no
new launch or successful Live publication.

Codex regression resume_of_a_never_recorded_session_is_silent_and_writes_no_defaults_row
now asserts an identity row exists and no settings record/defaults exist.
Run both ordinary attach and under-ticket handoff without settings, and cover
Claude/Kilroy/OpenCode resume/adopt. Browser 'stage1 dead binding' seeds through
the test ledger fixture, opens on desktop+mobile and asserts one writer and
successful later send/configure. A live-terminal twin refuses both views.
```

- [x] **Step 2: Red**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-server identity_sink"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test cross_kind_liveness"`

Expected FAIL: legitimate dead-binding resume remains terminal-shaped/unfenced or no-settings identity is omitted. Existing strict live-writer and stale-write tests remain green.

- [x] **Step 3: Apply production patch**

```text
FreshAgentBindingUpsert: replace handoff-only authoritative bool with explicit
server-produced BindingClaim; settings is SettingsUpdate, not a default full
replacement. Derive claims only from the operation's captured ticket, never
from whichever owner happens to be current later. Ordinary settings refreshes
carry no takeover authority. Keep provenance tri-state/assertion-time rules.

Extend the existing transition repair rather than assume a synchronous registry
guard exists. Carry provider/key/operation ID/epoch/generation through the claim,
upsert, durable row and repair fence; the restored prior owner's ownership ID
must remain distinct even when its generation equals the failed handoff's.
Keep the exact Starting/Handoff claim fenced while its write is pending. Commit
Live only after the binding write succeeds and the exact claim still matches.
On cancellation or refused commit, install durable repair protection against
late writes and retire only that operation's row before releasing its claim.
A failed repair remains fenced and returns failure; it cannot become successful
Live or release another launch. Keep monotonic stale-write protection separately
from exact-operation retirement. Legacy rows without an operation ID are not
assumed to belong to the failed transition. Do not re-lock commit_live from
inside a registry guard or hold the global registry mutex across ledger I/O.
Preserve and extend the production parked-closure cancellation tests.

Only a valid current Freshagent Starting/Handoff claim may replace a terminal
row after existing liveness/ownership admission excludes a real live writer.
Clear historical live_terminal_id and stamp captured epoch/generation. Keep
strict stale/equal rejection for unfenced refreshes and active-terminal claims.

Codex ensure_session_resumable always establishes identity after verified
native resume and before Live/attach response, even with no recovered settings;
remove record_codex_binding's no-settings identity skip only for establishing
claims. Apply same contract to Claude/Kilroy/OpenCode. Audit resume-first crash
repair, create, fork and respawn separately. If binding persistence fails before
native acceptance, clean partial provider/claim and refuse. A settings refresh
failure after a native send was accepted is reported honestly without claiming
the send was refused or retrying it. load_settings/was_recorded retain their
settings-bearing semantics.
```

- [x] **Step 4: Green**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-server identity_sink"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test cross_kind_liveness"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-freshagent --lib attach_resume"`

Expected PASS with new identity-only assertions.

- [x] **Step 5: Refactor**

Centralize claim-to-upsert conversion and Keep/Replace mapping. Remove provider-specific guessed-default identity workarounds. Keep distinct establishment versus refresh call sites readable; do not make every write authoritative.

- [x] **Step 6: Impacted verification**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ownership"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --lib pane_ledger_tests"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-freshagent --lib session_handoff"`

Run Step 2 commands, then `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage1'`; expected PASS across close/switch/dead/live-binding cases and four modes. This is Stage 1's integrated gate.

- [x] **Step 7: Commit**

```bash
git add crates/freshell-ownership/src/lib.rs crates/freshell-freshagent/src/identity_sink.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-freshagent/src/session_handoff/tests.rs crates/freshell-server/src/identity_sink.rs crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/pane_ledger_tests.rs crates/freshell-ws/tests/cross_kind_liveness.rs test/e2e-browser/helpers/fresh-agent-multiple-devices.ts test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts
git commit -m "fix(freshagent): establish recovered identities under exact ownership claims"
```

## Stage 2: Share attachment and recovery, and make refresh finite

### Task 4: Every attach settles only its requester on default and managed paths

**Files:**
- Modify: `shared/ws-protocol.ts`, `shared/fresh-agent-contract.ts`, `src/lib/ws-client.ts`, `src/lib/fresh-agent-ws.ts`, `src/lib/fresh-agent-view-attachment.ts`, `src/components/fresh-agent/FreshAgentView.tsx`, `crates/freshell-protocol/src/client_messages.rs`, `crates/freshell-protocol/src/server_messages.rs`, `port/contract/ws-protocol.schema.json`, `port/contract/ws-server-messages.schema.json`, `port/contract/ws-message-inventory.json`, `port/contract/managed-runtime.schema.json`, `crates/freshell-ws/src/terminal.rs`, `crates/freshell-ws/src/hosted_fresh_agent.rs`, `crates/freshell-freshagent/src/claude/attach.rs`, `crates/freshell-freshagent/src/codex.rs:7388`, `crates/freshell-freshagent/src/opencode_ws.rs:7221`, `crates/freshell-server/src/fresh_agent_proxy.rs:249`.
- Create: `crates/freshell-ws/tests/freshagent_multiple_devices.rs`, `tests/common/multiple_devices.rs`.
- Test: `crates/freshell-ws/tests/freshagent_claude_observers.rs`, `src/hosted_fresh_agent_tests.rs`, `crates/freshell-server/src/fresh_agent_proxy_readiness_tests.rs`, `test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts`, `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`, `test/unit/client/lib/ws-client.test.ts`, `test/unit/client/lib/fresh-agent-ws.test.ts`.

**Interfaces:**
- Consumes: Task 1 requester FrameSink and attachment identity; Task 3 committed owner authority.
- Produces: `handle_attach(msg: FreshAgentAttach, reply: FrameSink)` for all default providers; typed `AttachOutcome` returned by inner helpers, and outer-only requester `attached`/`attach.failed` emission. Hosted gateway dispatch has the same requester context.
- Produces Rust test rig with two authenticated actual sockets and provider audit/release gates using `common::claude_rig` Sim/Cli plus existing Codex/OpenCode native fixtures. Its methods send parsed real protocol messages, await matching request replies, and count actual boot/submit/decision calls.

- [x] **Step 1: Add red tests**

```text
Rust test 'attach_requester_isolation': A streams; B attaches to the same
runtime with view/request IDs. B receives one correlated attached frame and
snapshot, A receives neither. Both get subsequent canonical live output.
Repeat running/idle/unknown/reserved/malformed-fence/failure and all four modes.
Delete the obsolete Codex no-frame expectation by replacing it with the actual
requester acknowledgment test, not by weakening assertions. Preserve Claude's
attaching_mid_turn_acknowledges_running_only_to_the_requester regression.

Hosted test: second attach uses its sink for replay/ack/error, keeps exactly one
poller, and does not replay into A's stream. Legacy attach without request ID
gets its previous shape on only the requester sink. Browser 'stage2 requester'
joins mobile during desktop output and checks no peer transcript reset/error.
Also verify modern attached/attach.failed frames are emitted only after
freshAgentReconciliationV1 negotiation; unnegotiated and request-ID-free
legacy callers keep their old event payload shape while receiving attach-only
frames on their own connection.
```

- [x] **Step 2: Red**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices attach_requester_isolation"`

Expected FAIL: Codex emits no acknowledgment, OpenCode/cold snapshots or errors broadcast, or hosted replay reaches A.

- [x] **Step 3: Production patch**

```text
Attach carries optional requestId/viewId; attached and attach.failed contain
full canonical locator, status, owner epoch/generation/kind and operation/retry
facts. Thread reply through Codex/OpenCode and hosted gateway; inner attach
helpers return typed outcomes instead of global errors. Claude retains its
correct live observer implementation and gains correlation/full refusal owner.

Negotiate freshAgentReconciliationV1 in hello/ready using the existing
capability machinery. The browser includes a stable requestId for each
immutable attach decision, reuses it across transport retry, and creates a new
one when the observed owner decision changes. The server emits the new
correlated attached/attach.failed frames only to negotiated clients; older or
unnegotiated clients retain legacy payload parsing and provider semantics.

Fresh_agent_proxy replay_once takes a requester sink and never global send;
start_poller remains one canonical live broadcaster. Runtime materialization,
status transitions and real stream events still broadcast. Already-running
attach always settles its requester. A typed obsolete-owner failure includes
the complete current pair/kind, preserving terminal divergence semantics.
```

- [x] **Step 4: Green**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices attach_requester_isolation"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage2 requester'`

Expected PASS for four modes.
Also pass the protocol/WS client negotiation tests and confirm a legacy
connection receives only the prior event shape on its own sink.

- [x] **Step 5: Refactor**

Use one outcome-to-requester adapter for default providers; keep provider-specific startup logic and ordinary broadcasts. Remove global attach-only error helpers only where converted.

- [x] **Step 6: Impacted verification**

Run: `pnpm run contract:generate`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_claude_observers"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-server --features managed-runtime-v1 fresh_agent_proxy"`

Run: `pnpm run test:vitest run test/unit/client/lib/ws-client.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Run: `pnpm run typecheck`; expected PASS, plus Step 4 browser selector. These cover all attach dispatch callers and managed gateway routing.

- [x] **Step 7: Commit**

```bash
git add shared/ws-protocol.ts shared/fresh-agent-contract.ts src/lib/ws-client.ts src/lib/fresh-agent-view-attachment.ts src/components/fresh-agent/FreshAgentView.tsx crates/freshell-protocol/src/client_messages.rs crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/hosted_fresh_agent.rs crates/freshell-ws/src/hosted_fresh_agent_tests.rs crates/freshell-freshagent/src/claude/attach.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-server/src/fresh_agent_proxy.rs crates/freshell-server/src/fresh_agent_proxy_readiness_tests.rs crates/freshell-ws/tests/freshagent_multiple_devices.rs crates/freshell-ws/tests/common/multiple_devices.rs crates/freshell-ws/tests/freshagent_claude_observers.rs test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/lib/ws-client.test.ts test/unit/client/lib/fresh-agent-ws.test.ts port/contract/ws-protocol.schema.json port/contract/ws-server-messages.schema.json port/contract/ws-message-inventory.json port/contract/managed-runtime.schema.json
git commit -m "fix(freshagent): scope attach completion and replay to the requesting view"
```

### Task 5: Concurrent recovery shares one operation, outcome and real-failure budget

**Files:**
- Create: `crates/freshell-freshagent/src/session_recovery.rs`.
- Modify: `crates/freshell-freshagent/src/lib.rs`, `claude/recovery.rs`, `claude/attach.rs`, `codex.rs`, `opencode_ws.rs`, `crates/freshell-ws/src/reconcile_freshagent.rs`, `lib.rs`, `crates/freshell-supervisor/src/service.rs`, `crates/freshell-supervisor/src/lib.rs`, `crates/freshell-runtime-protocol/src/lib.rs`, `crates/freshell-agent-runtime/src/lib.rs`, `crates/freshell-server/src/fresh_agent_proxy.rs`, `port/contract/managed-runtime.schema.json`, `src/lib/pane-reconcile.ts`, `src/store/panesSlice.ts`.
- Test: Rust two-socket rig, `crates/freshell-ws/tests/pane_reconcile.rs`, client `pane-reconcile.fresh-agent.test.ts`, `panesSlice.fresh-agent-reconcile.test.ts`, browser helper/spec and native fixture gates.

**Interfaces:**
- Consumes: canonical locator/alias resolution, existing provider flight locks, registry tickets/leases, supervisor `lifecycle_lock`, Task 4 typed attach outcome.
- Produces: `RecoveryStatus{operationId,inFlight,failedLaunches,retryAfterMs?,exhausted}` and one cloneable `Result<ReadySession,RecoveryFailure>` per operation. Budget cap remains three real failed launches per current recovery episode/source; successful establishment resets it. Status reads/reconcile never mutate it.
- Define the serializable `RecoveryStatus` in `freshell-runtime-protocol`, re-export it through `freshell-agent-runtime` for the existing default-provider dependency. Add optional defaulted `RuntimeView.fresh_agent_recovery` in the existing inventory/inspection result; supervisor populates it from its lifecycle entry, gateway maps it to attach/reconcile facts. No new RPC service or dependency edge is necessary.

- [x] **Step 1: Add red tests**

```text
Rust 'shared_recovery': gate first native launch, issue attach/create(sessionRef)
from A/B plus send/compact ensure for the same locator. Release success: one
launch, both attach replies share canonical identity/committed owner, dropped
waiter doesn't cancel work. Repeat transient launch failure: one failure and
one operationId for the whole cohort, including a late waiter inside retry floor.
Only a later allowed operation can start again. Three real failed launches
exhaust budget; 100 reconcile/GET/join/owner-refusal operations consume zero.
Success resets count; a genuine live terminal still prevents a native launch.

Reconcile test: two panes with the same canonical session retain their own
view/pane and locator and receive the same attach/recovery fact. Neither gets
duplicate_session_claim/create nor clears durable identity. Managed requests
join existing supervisor activation and do not start a local provider lane.

Browser 'stage2 cold open': independently boot desktop/mobile with saved same
locator, hold fixture boot, open simultaneously, release and audit exactly one
native boot/bridge and shared owner. Browser 'stage2 shared failure' verifies
one failed launch/cohort and budget unaffected by reconnecting the other view.
Add provider inline shared_recovery_tests and supervisor service inline
lifecycle_shared_recovery_tests with these launch/result/count assertions, so
the shared_recovery/lifecycle Cargo selectors execute actual behavior cases.
```

- [x] **Step 2: Red**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices shared_recovery"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test pane_reconcile"`

Expected FAIL: failure waiters serially relaunch, OpenCode gets Reserved, or repeated reconcile consumes budget/resets the duplicate view.

- [x] **Step 3: Production patch**

```text
session_recovery stores only operation/result/budget bookkeeping, not ownership.
Canonicalize aliases before lookup. Reuse/extend current provider flight holder
with a server-owned spawned operation and a watch/shared-result channel; retain
failure through a 1-second retry floor. Joining/dropping waiters never cancels
the operation. Operation acquires the existing owner ticket and lease once,
uses provider_startup bounds/cleanup, and publishes one result to all waiters.
Do not apply the 15-second view-read deadline to native startup (Claude create
45s/hosted wait 50s use existing platform constants).

Increment failedLaunches exactly once when a real spawn/resume attempt fails,
including spawn refusal after attempt admission. Do not increment for observed
status, join, stale owner, terminal conflict, stop supersession or reconcile.
Preserve Codex gone-thread negative caching and OpenCode's one shared daemon
with one per-session bridge. No budget change on pure build_snapshot.

Wire known-session create, attach and existing ensure/restart from send/compact
to this one provider operation. On success return winner's committed fence
rather than re-refusing the joiner's pre-start fence. Managed path joins the
supervisor lifecycle lock/outcome, never this local provider launch path. Extend
that existing per-soul lifecycle entry to retain operation/result/failure count
through the retry floor; don't create a parallel managed recovery map. Expose
read-only recovery facts through the existing supervisor inspection result so
gateway/reconcile answers cannot allocate attempts themselves.

Replace fresh_agent_respawn_counts answer counting with read-only recovery
facts. Deduplicate fact gathering, not same-session views. Each pane receives
its own attach/recovery verdict and unchanged locator; client folds never
remint/clear identity for a legal second view. Exhaustion is a finite typed
state, not a create loop or implicit new native session.
```

- [x] **Step 4: Green**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices shared_recovery"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test pane_reconcile"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage2 cold open|stage2 shared failure'`

Expected PASS across four modes.

- [x] **Step 5: Refactor**

Remove obsolete answer counters and duplicate per-provider result caches; keep provider-specific admission/start/cleanup in adapters to the shared result holder. Update all hand-built WsState fixtures to the read-only status source.

- [x] **Step 6: Impacted verification**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-freshagent --lib shared_recovery"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test pane_reconcile"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/pane-reconcile.fresh-agent.test.ts test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts --config config/vitest/vitest.config.ts`

Run: `pnpm run contract:generate`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-runtime-protocol -p freshell-supervisor"`

Run Step 4 browser selector; expected PASS. Provider existing resume/negative-cache and supervisor activation tests run with `pnpm run test:sandbox "cargo test --locked -p freshell-freshagent --lib recovery"` and `pnpm run test:sandbox "cargo test --locked -p freshell-supervisor --lib lifecycle"`; require nonzero matches.

- [x] **Step 7: Commit**

```bash
git add crates/freshell-freshagent/src/session_recovery.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/claude/recovery.rs crates/freshell-freshagent/src/claude/attach.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-ws/src/reconcile_freshagent.rs crates/freshell-ws/src/lib.rs crates/freshell-supervisor/src/service.rs crates/freshell-supervisor/src/lib.rs crates/freshell-runtime-protocol/src/lib.rs crates/freshell-agent-runtime/src/lib.rs crates/freshell-server/src/fresh_agent_proxy.rs port/contract/managed-runtime.schema.json src/lib/pane-reconcile.ts src/store/panesSlice.ts crates/freshell-ws/tests/freshagent_multiple_devices.rs crates/freshell-ws/tests/common/multiple_devices.rs crates/freshell-ws/tests/pane_reconcile.rs test/unit/client/lib/pane-reconcile.fresh-agent.test.ts test/unit/client/store/panesSlice.fresh-agent-reconcile.test.ts test/e2e-browser/helpers/fresh-agent-multiple-devices.ts test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts
git commit -m "fix(freshagent): share recovery outcomes and count actual failed launches"
```

### Task 6: Obsolete attachment retries refresh complete authority

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:2037`, `src/lib/fresh-agent-view-attachment.ts`, `src/lib/fresh-agent-ws.ts`.
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx`, `test/unit/client/lib/fresh-agent-view-attachment.test.ts`, browser spec/helper.

**Interfaces:**
- Consumes: Task 4 correlated complete refusal authority and Task 5 shared recovery outcomes; existing immutable attachment decision capture.
- Produces: one new immutable attempt after authority refresh, never in-place mutation/repeated resend of an obsolete epoch/generation.

- [ ] **Step 1: Add red tests**

```text
Start decision request A at epoch E/generation N. Deliver typed stale refusal
with E+1/N+1 Freshagent authority. Assert next actual WS attach has a new request
ID/decision, both new authority fields, same canonical locator/view. Deliver old
success/refusal and assert it cannot settle the new decision. Missing authority
triggers one read-only reconcile, not a stale resend loop. Terminal owner shows
existing divergence UI and sends no Freshagent restart. Superseded view does
not redrive. Browser 'stage2 stale authority' delays A until B's recovery wins
and verifies A joins the winner with one runtime and bounded requests.
```

- [ ] **Step 2: Red**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx -t 'authority|obsolete' --config config/vitest/vitest.config.ts`

Expected FAIL: `redriveAfterSessionReserved` repeats its captured obsolete fence or mixes refreshed generation with the old epoch.

- [ ] **Step 3: Production patch**

```text
Route modern attach replies by viewId/requestId first. For a current typed
obsolete-owner result, fold complete epoch/generation/kind only after verifying
locator/current view decision. If absent, await one read-only authority refresh.
Increment decision serial and capture one new attempt; never edit the old
attempt. Preserve original refresh deadline (Task 7 supplies its timer). Join
an in-flight shared recovery instead of repeated create. Terminal ownership
halts retry and uses existing divergence action. Exhausted/lost/nonretryable
states settle error. Stale results only settle their own transport bookkeeping.
Generalize OpenCode's 409 handling to this helper and retain full epoch.
```

- [ ] **Step 4: Green**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx -t 'authority|obsolete' --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage2 stale authority'`

Expected PASS.

- [ ] **Step 5: Refactor**

Replace repeated provider-specific owner-retry branches with one typed transition helper. Keep native provider errors and terminal divergence presentation intact.

- [ ] **Step 6: Impacted verification**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx test/unit/client/lib/fresh-agent-view-attachment.test.ts test/unit/client/lib/fresh-agent-ws.test.ts --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts test/e2e-browser/specs/freshopencode-snapshot-409-recovery.spec.ts --grep 'stage2 stale authority|409'`; expected PASS and nonzero matches for both files.

- [ ] **Step 7: Commit**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx src/lib/fresh-agent-view-attachment.ts src/lib/fresh-agent-ws.ts test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx test/unit/client/lib/fresh-agent-view-attachment.test.ts test/e2e-browser/helpers/fresh-agent-multiple-devices.ts test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts
git commit -m "fix(freshagent): refresh authority before retrying obsolete attachments"
```

### Task 7: Every visible refresh and shared read settles within a fixed deadline

**Files:**
- Create: `src/lib/fresh-agent-refresh.ts`, `test/unit/client/lib/fresh-agent-refresh.test.ts`.
- Modify: `src/lib/fresh-agent-snapshot-scheduler.ts`, `fresh-agent-reveal-freshness.ts`, `src/components/fresh-agent/FreshAgentView.tsx`.
- Test: `test/unit/client/lib/fresh-agent-snapshot-scheduler.test.ts`, `fresh-agent-reveal-freshness.test.ts`, `test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx`, browser helper/spec.

**Interfaces:**
- Consumes: Task 6 attachment decisions, existing required transcript/projection freshness, scheduler per-key sharing.
- Produces: `RefreshAttempt{identity,requestId,requiredWatermark?,startedAt,deadlineAt,state}`; `beginRefresh`/`settleRefresh` pure transitions and timer disposal; scheduler `run(signal: AbortSignal)` with generation fencing. Task 11 later supplies the negotiated outer watermark.

- [ ] **Step 1: Add red tests**

```text
Fake-clock tests hold a GET forever: 15s from entering visible pending, refresh
settles timeout with saved content/retry surface. Cover rejected stale response,
identity/projection rejection, errors, 409, 429, repeated supersession and
unchanged authoritative Codex/Claude/OpenCode content. Retries cannot extend
the original deadline; an old promise cannot settle a newer identity/attempt.
An unchanged verified current response advances successful serial and settles;
content equality alone doesn't prove freshness behind an observed watermark.

Scheduler: two waiters share one hung run; its own 15s bound rejects both,
aborts its signal, releases key even if promise ignores abort, next Retry runs,
late old completion is inert. Unmounting one waiter does not abort another.
Browser 'stage2 bounded refresh': suspend mobile (offline plus forced existing
socket disconnect), resume unchanged and converge; then hold/delay a real
snapshot response and assert finite error followed by successful Retry while
desktop streaming stays healthy. Cover all modes, no injected transcript.
```

- [ ] **Step 2: Red**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-refresh.test.ts test/unit/client/lib/fresh-agent-snapshot-scheduler.test.ts test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx --config config/vitest/vitest.config.ts`

Expected FAIL: pending/read key never settles on hang/discard, unchanged responses fail freshness, or retries extend the blocking overlay.

- [ ] **Step 3: Production patch**

```text
beginRefresh arms a separate 15,000ms timer immediately, before scheduling GET
or attach. Every success/error/timeout/dispose/supersede path settles exactly
its identity/request. Retry scheduling keeps deadlineAt; identity replacement
disposes prior attempt before starting a distinct attempt. Hidden views defer
blocking refresh. Error preserves last rendered content and explicit Retry.

Scheduler owns AbortController+deadline+generation per run. Promise.race its
deadline, settle all waiters and clear inFlight in finally; late resolution
checks generation and cannot publish/cache/clear a later run. Fetch uses the
scheduler signal. Individual view cleanup unsubscribes only that observer.

Record authoritative successful verification separately from display-object
change. Equal transcript revision may settle when the read's source/fence and
required freshness cover this attempt. Preserve existing Codex revision fences;
Task 11 strengthens this with the outer watermark. No blanket equality bypass.
```

- [ ] **Step 4: Green**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-refresh.test.ts test/unit/client/lib/fresh-agent-snapshot-scheduler.test.ts test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage2 bounded refresh'`

Expected PASS.

- [ ] **Step 5: Refactor**

Remove timer/deadline duplication from reveal branches, retaining one lifecycle helper and scheduler-run timer for their different responsibilities. Keep approval-only reveal nonblocking.

- [ ] **Step 6: Impacted verification**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-refresh.test.ts test/unit/client/lib/fresh-agent-snapshot-scheduler.test.ts test/unit/client/lib/fresh-agent-reveal-freshness.test.ts test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage1|stage2'`

Run Task 5's Rust two-socket and pane-reconcile commands; expected PASS. This is Stage 2's integrated gate, including cold opens, failure budget, requester isolation and finite refresh.

- [ ] **Step 7: Commit**

```bash
git add src/lib/fresh-agent-refresh.ts src/lib/fresh-agent-snapshot-scheduler.ts src/lib/fresh-agent-reveal-freshness.ts src/components/fresh-agent/FreshAgentView.tsx test/unit/client/lib/fresh-agent-refresh.test.ts test/unit/client/lib/fresh-agent-snapshot-scheduler.test.ts test/unit/client/lib/fresh-agent-reveal-freshness.test.ts test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx test/e2e-browser/helpers/fresh-agent-multiple-devices.ts test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts
git commit -m "fix(freshagent): bound visible refresh and shared snapshot reads"
```

## Stage 3: Reconcile events, commands, settings and controls

### Task 8: Share the existing actor's bookkeeping and make managed captures atomic

**Files:**
- Create: `crates/freshell-agent-runtime/src/reconciliation.rs`, `reconciliation_tests.rs`, `crates/freshell-platform/src/atomic_file.rs` and platform-specific atomic replacement tests.
- Modify: `crates/freshell-agent-runtime/Cargo.toml`, `crates/freshell-agent-runtime/src/lib.rs`, `host_actor.rs`, `host_actor_tests.rs`, `crates/freshell-platform/Cargo.toml`, `crates/freshell-platform/src/lib.rs`, `crates/freshell-runtime-protocol/src/lib.rs`, `fresh_agent_ops.rs`, `crates/freshell-server/src/checkpoints.rs`, `port/contract/managed-runtime.schema.json`.

**Interfaces:**
- Consumes: existing managed `PersistedActorState`, `AgentJournalEvent`, `AgentEventBatch`, protected payload storage and provider-native checked dispatch.
- Produces shared `ReconciliationState<P>` (P is the retained presentation), `Source`, `Cursor`, `SnapshotCapture<P>`, `CommandReceipt`, `SettingsState`, `AcceptedFollowup` and `ReceiptLookup::{Found,Missing,Expired,Unreadable}`. `record_event(event, mutate_projection)` and `capture_snapshot()` share one owner lock/commit boundary. Existing managed state stays the managed persistence owner; this adds bounded detailed receipts and compact lookup metadata required by the validated retention and send-fence policy, not another native send permit.
- Produces a reusable `freshell-platform::atomic_file::publish_durable(temp, destination, durability_root)` contract for already-staged, file-synced content. It atomically replaces the destination and applies platform-appropriate durability (sync the relevant parent-directory chain through `durability_root` on Unix; write-through replacement on Windows). The actor/default callers retain their staging-file permissions and sync policy; the checkpoint publisher reuses its existing durable root. This preserves rather than weakens each caller's current durability boundary.
- `CommandReceipt` additionally records optional `dispatchOrder` for the actual native boundary; `acceptedOrder` remains total admission order. Deferred follow-ups are ineligible until their captured turn boundary settles and do not block a later eligible interrupt/decision. Eligible native submissions use the existing serialization gate; queued follow-ups dispatch in accepted order.

- [ ] **Step 1: Add failing runtime tests**

```text
reconciliation::tests::capture_is_atomic_under_continuous_events: a producer
appends numbered native-keyed blocks without ever going idle. Capture at a
barrier between mutations, continue output, and assert captured presentation
contains exactly the effects through its cursor, never a later effect or a
missing earlier effect. Verify snapshot paging uses that same immutable capture
while later events append; no mutex is held across transport retained_state.

Other core tests: event 4096/4MiB eviction returns an honest contiguous suffix
or explicit exact gaps/reset; pending decisions remain in the captured control
projection without creating holes in that suffix. Same command ID+digest
returns its receipt, different digest conflicts; 100 concurrent admissions
have unique increasing acceptedOrder; native dispatch order is unique.
Persistence reopen at queued/dispatching/provider-acked states does not dispatch
twice and consults the existing send-effect fence rather than granting authority
from a receipt. Bounded detailed receipt expiry is distinguishable from Missing;
unreadable store is not Missing. Legacy persisted actor states migrate without
claiming new native acceptance, and old Dispatching becomes conservative
ambiguous on recovery. Platform tests verify atomic replacement on supported
native targets; do not copy POSIX parent-directory fsync into Windows code.

Managed host_actor test: hold transport.retained_state while a new event arrives.
Current read_events pairs an earlier head with later state; require the returned
capture's actual watermark and immutable retained projection to match instead.
```

- [ ] **Step 2: Red**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-agent-runtime --lib reconciliation"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-agent-runtime --lib host_actor"`

Expected FAIL because atomic capture/receipt query behavior is missing, or managed read pairs mismatched head/state. Compilation scaffolding must be established without changing the behavior before treating this as red evidence.

- [ ] **Step 3: Production patch**

```text
Move the actor's event, command digest/state, settings and pending decision
bookkeeping into reconciliation.rs; actor persistence embeds this state and
keeps its existing protected payload-file lifecycle. No second managed journal
and no PTY journal changes. Version persisted state additively with defaults
for old entries; preserve possible-native-delivery ambiguity. Add bounded
detailed receipt retention and compact expiry/dedup metadata according to the
validated stable-ID policy. For sends, receipt metadata is only a queryable
reference to the existing send-effect fence; it cannot create a second permit
or authorize a resend. Do not claim a generic actor tombstone/compaction or
lazy archive facility already exists.

Extract the platform-aware atomic replacement behavior into freshell-platform
as `publish_durable(temp, destination, durability_root)` and use it for these
state writes and the existing checkpoint publisher. Keep current file staging,
permissions and sync behavior; preserve Windows write-through replacement and
Unix parent-directory chain sync to the caller's durability root. Add the
required dependency/features and verify there is no crate cycle; no broad
migration of unrelated atomic writers is included.

record_event applies its projection mutation and allocates/appends sequence
under the same owner-state lock, then returns the sequenced event for publication
after release. capture_snapshot clones immutable retained presentation plus
settings/controls/queue/receipt projection and cursor under that lock. The actor's
existing provider-event ingestion updates retained projection before publishing.
`read_events` no longer drops the lock then samples a new `retained_state`
against an old head. If bridge loss or coalescing means the actor cannot prove
continuity, return an explicit gap/reset instead of assigning a later projection
to an earlier cursor. Tasks 9–10 extend provider retained capture to
Claude/Kilroy and OpenCode as well as Codex through this actor capture contract. A recovery capture must carry its actual provider
source/watermark and establish the provider-to-actor coverage boundary before
later deltas fold; discard already-covered input only from that proven boundary.
A delayed/coalesced recovery image cannot inherit the actor's earlier head.
Normal managed streaming joins must get complete retained state on all modes;
permanent None/gap responses are not acceptable normal-path coverage.
Prepare durable/native bases outside lock and commit validated native IDs/
history-generation plus overlay under lock. Capture tokens paginate the frozen
value; expire/dispose by view deadline without blocking new native events.

Expose AgentEventBatch's actual snapshot watermark/source separately from head.
Preserve existing managed event limits and native command states; add typed
receipt result, accepted/dispatch order and query distinctions with the new
bounded detailed/compact lookup policy. Store errors refuse new native effects.
Never interpret checkpoint success/dispatch_started as ProviderAcked. Generate
the managed schema from its authority.
```

- [ ] **Step 4: Green**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-agent-runtime --lib reconciliation"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-agent-runtime --lib host_actor"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-platform atomic_file"`

Expected PASS with continuous-stream interleaving and crash-reopen dispatch counts asserted.

- [ ] **Step 5: Refactor**

Delete actor-local duplicate ring/digest/query implementations now delegated to the shared state. Keep provider transport, native dispatch fencing and state-file ownership in the actor. No default provider runtime migration is part of this task.

- [ ] **Step 6: Impacted verification**

Run: `pnpm run contract:generate`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-agent-runtime"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-platform"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-runtime-protocol"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-session-host fresh_agent"`

Expected PASS. All actor/transport callers are impacted by snapshot and persistence changes; verify event/command query nonzero counts, not just compilation.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-agent-runtime/Cargo.toml crates/freshell-agent-runtime/src/reconciliation.rs crates/freshell-agent-runtime/src/reconciliation_tests.rs crates/freshell-agent-runtime/src/lib.rs crates/freshell-agent-runtime/src/host_actor.rs crates/freshell-agent-runtime/src/host_actor_tests.rs crates/freshell-platform/Cargo.toml crates/freshell-platform/src/lib.rs crates/freshell-platform/src/atomic_file.rs crates/freshell-platform/src/atomic_file_tests.rs crates/freshell-server/src/checkpoints.rs crates/freshell-runtime-protocol/src/lib.rs crates/freshell-runtime-protocol/src/fresh_agent_ops.rs port/contract/managed-runtime.schema.json
git commit -m "feat(freshagent): share reconciliation state and capture atomic actor snapshots"
```

### Task 9: Default providers retain sequenced presentation at the event boundary

**Files:**
- Create: `crates/freshell-freshagent/src/session_reconciliation.rs`.
- Modify: `crates/freshell-freshagent/src/lib.rs`, `claude.rs`, `claude_edges.rs`, `claude_projection.rs`, `claude_snapshot.rs`, `codex.rs`, `codex/projection.rs`, `opencode_ws.rs`, `snapshot.rs`, `crates/freshell-opencode/src/serve.rs`, `events.rs`, `transport.rs`, `crates/freshell-server/src/main.rs`, `crates/freshell-ws/tests/freshagent_multiple_devices.rs`, `tests/common/multiple_devices.rs`, and the existing OpenCode native event fixture.

**Interfaces:**
- Consumes: Task 8 generic reconciliation state and Task 3 durable session identity/owner claim; existing Codex transcript projection and Claude/OpenCode native event accumulators.
- Produces: owner-local `reconcile_snapshot(locator) -> Result<SnapshotCapture<FreshAgentPresentation>>`, `read_reconciliation(cursor, limits)`, and `publish_committed(event)` whose record is stamped before broadcasting. Default command persistence is scoped to the durable provider identity/alias record and its stable store ID, not a process/global or browser key.
- Produces: default `with_reconciliation_root(PathBuf)` initialization and `DefaultReconciliationStore::open(root, stableStoreId)`, reusing Task 8's platform-aware atomic replacement/protected-payload helpers. Resolve `stableStoreId` from a durable provider-scoped identity/alias record that survives pre/post-materialization aliases, rekey and restart while assigning true forks a distinct ID; never derive the store key from whichever locator arrived in the current request. Serialize resolve-or-create with existing ownership coordination before recovery or command admission, persist the selected alias mapping before publishing it, and reject unreadable/conflicting identity. Reopen a partially published reservation by its same stable ID; do not assume separate alias/state files commit atomically. Inject root from the server's existing isolated home. Managed actors retain their existing state directory/file. No new ownership lock or second send dispatch-fence store is introduced.
- OpenCode streaming contract for pinned 1.18.21: use one owner subscription to the instance `/event` route, bind it to the authoritative session directory/workspace and subscription generation, and await that generation's `server.connected` readiness before dispatch. Do not treat `/global/event` readiness as sufficient. Retain native per-part full bases, deltas, final replacements and removals in the same owner commit as the outer event watermark. Do not infer a total order across unrelated native producers. Reconnect, EOF, malformed relevant input, local broadcast loss, incompatible part identity, removal during active deltas, or an unknown lifecycle invalidates affected coverage; report a bounded source-scoped gap with unknown native extent until a trustworthy full replacement arrives. Native deltas have no replay cursor, so do not synthesize a precise missing native sequence.

- [ ] **Step 1: Add red provider integration tests**

```text
Rust 'streaming_capture': use real provider adapter with fixture continually
emitting native deltas and gate durable transcript flush. Read capture mid-turn;
its state includes every pre-watermark delta once although disk is behind.
After disk catches up, capture merges matching native message/block/part IDs
without duplicate text/rows. Producer continues through both reads; no quiet
window is permitted. Cover freshclaude, kilroy, freshcodex and freshopencode.

Also exercise store resolution: open concurrently by old/new materialization
aliases, persist a rekey, restart, query/admit through both aliases and observe
one store; fork and verify a separate store. The test must prove one owner/store
without treating a native terminal ID or current locator hash as stable identity.
Hold competing alias reservations and crash between alias/state publication;
prove reopen selects the same reserved store. Unreadable/conflicting maps refuse
admission rather than creating a second store. Exercise both default and managed
lookup through old/new aliases without changing the managed persistence owner.

Exercise status, settings, controls, errors, attention, materialization,
transcript invalidator, completion and queue/receipt event families. Every
canonical mutation obtains an outer source/sequence, including ClaudeEdgeHub
and consumer-local writes. A native-ID materialization rekeys the same source;
a new runtime changes source while durable command identity remains queryable.
Keep existing Codex projection revision/consumed-prefix tests unchanged.

For OpenCode, the fixture must emit actual native full-part starts, text/reasoning
deltas, final replacements, removals and reconnect/local-lag boundaries. Join a
second device during ongoing text and reasoning before any final full update and
prove it receives the retained base plus deltas exactly once. Hold `/event`
readiness and verify no owned turn dispatches until the matching subscription
generation is ready; wrong directory/workspace and stale ready frames are inert.
The current idle-only event fixture is not evidence for this case. Do not claim a
specific native lost sequence when a delta prefix is missing.
```

- [ ] **Step 2: Red**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices streaming_capture"`

Expected FAIL: no stamped default presentation/capture, disk lag loses live text, or snapshot watermark doesn't match actual event state.

- [ ] **Step 3: Production patch**

```text
Embed the shared reconciliation state in each existing default session owner.
Implement the stable store identity and durable alias/rekey behavior selected
under LB-6. It must survive concurrent open, restart and native materialization;
a true fork gets a new identity and store. Persist receipt/settings/accepted
payload state alongside durable session metadata; the bounded transient ring
belongs to this runtime source. Native replacement keeps stable command lookup
and accepted queue but creates a fresh event source.

At every producing boundary, first mutate retained presentation+append event
in one synchronous owner commit, release lock, then publish. Include direct
consumer sends and claude_edges, not only top-level broadcast helpers. Keep
the before-publication checkpoint observer hook, avoiding reentrant owner locks.

Codex retains projectionId/historyGeneration/revision/read fences as its inner
transcript authority. Claude/Kilroy overlay uses proven native message/block identity and full current
block values within the owner source. An unknown turn identity does not prevent
retaining a keyed live block. Do not retire a live row from mtime, display order
or same-kind positional matching alone; require an exact UUID/message/block
association. If legacy input lacks enough identity, return an explicit affected
coverage/reset state instead of displaying speculative duplicate rows. Exercise
repeated same-kind blocks and missing UUIDs alongside normal streaming joins.
OpenCode reduces one known per-part lifecycle: full start value, awaited deltas, then a final full replacement.
Exact message/part identities are mandatory; native timestamps and cross-source
ordering are not merge keys. A removal tombstones its part, and unknown fields,
incompatible identities or a delta after finalization invalidate that affected
continuity rather than recreating speculative text. On `/event` reconnect, EOF,
malformed relevant input or local `Lagged/Lost`, clear readiness and mark
affected active parts incomplete until a trustworthy full replacement arrives.
Represent this as a source-scoped outer discontinuity with unknown native extent;
the native stream has no sequence to narrow the missing interval. Durable reads
are prepared outside the lock; merge only source/history-compatible results, removing overlay entries only
when durable native IDs/versions prove inclusion. An active stream's overlay
is never discarded because disk is late. Snapshot reads copy current retained
base+overlay+metadata and cursor without awaiting disk or waiting for idle.

Use existing provider history windows/paging and immutable values for captures;
do not buffer an unbounded extra full conversation. Log store/capture/gap errors
with severity, source and bounds; no conversation content.
```

- [ ] **Step 4: Green**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices streaming_capture"`

Expected PASS with each provider continuously emitting across capture and durable-flush release.

- [ ] **Step 5: Refactor**

Factor source stamping/alias rekey and capture pagination into session_reconciliation; keep native projection merging in its provider module. Remove any bus-observer stamping prototype so there is one source boundary.

- [ ] **Step 6: Impacted verification**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-freshagent --lib projection"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-freshagent --lib snapshot"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_codex_attention_replay"`

Expected PASS; include all existing provider event/attention tests with `pnpm run test:sandbox "cargo test --locked -p freshell-freshagent --lib"` because the source event boundary spans every default provider event family.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-opencode/src/serve.rs crates/freshell-opencode/src/events.rs crates/freshell-opencode/src/transport.rs test/e2e-browser/fixtures/fake-opencode.cjs
git add crates/freshell-freshagent/src/session_reconciliation.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/claude_edges.rs crates/freshell-freshagent/src/claude_projection.rs crates/freshell-freshagent/src/claude_snapshot.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/codex/projection.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-freshagent/src/snapshot.rs crates/freshell-server/src/main.rs crates/freshell-ws/tests/freshagent_multiple_devices.rs crates/freshell-ws/tests/common/multiple_devices.rs
git commit -m "feat(freshagent): retain atomic sequenced state in default provider owners"
```

### Task 10: Deliver negotiated per-view catch-up without replay/live gaps

**Files:**
- Create: `crates/freshell-ws/src/freshagent_delivery.rs`.
- Modify: `shared/ws-protocol.ts`, `shared/fresh-agent-contract.ts`, `crates/freshell-protocol/src/client_messages.rs`, `crates/freshell-protocol/src/server_messages.rs`, `port/contract/ws-protocol.schema.json`, `port/contract/ws-server-messages.schema.json`, `port/contract/ws-message-inventory.json`, `port/contract/managed-runtime.schema.json`, `crates/freshell-ws/src/lib.rs`, `crates/freshell-ws/src/terminal.rs`, `crates/freshell-ws/src/hosted_fresh_agent.rs`, `crates/freshell-server/src/fresh_agent_proxy.rs`, `crates/freshell-runtime-protocol/src/lib.rs`, `crates/freshell-runtime-protocol/src/fresh_agent_ops.rs`, `crates/freshell-runtime-client/src/lib.rs`, `crates/freshell-session-host/src/main.rs`, `crates/freshell-session-host/src/providers/fresh_agent.rs`, `crates/freshell-supervisor/src/lib.rs`.
- Test: Rust two-socket rig, `crates/freshell-server/src/fresh_agent_proxy_tests.rs`, `crates/freshell-ws/src/hosted_fresh_agent_tests.rs`, runtime/host protocol tests.

**Interfaces:**
- Consumes: Tasks 8/9 atomic capture and read APIs, Task 4 requester context, Task 1 interests.
- Produces: negotiated `freshAgent.event` envelope `{source,sequence,event}`, `freshAgent.sync`/`freshAgent.sync.result` including immutable snapshot capture/chunks, precise gap/reset. Modern attach returns source/head; managed gateway preserves host cursor/watermark without resequencing.

- [ ] **Step 1: Add red wire tests**

```text
Rust 'sync_requester_gap': A streams, B registers interest and begins paged
catch-up. Insert output after subscription but before capture, between replay
pages and after final head. B gets every event exactly once in sequence; A gets
no replay/snapshot/attach-only frame. Evict retained prefix and overflow only
B's delivery queue: explicit bounded reset/gap, A and runtime remain healthy.
Detach B: only B interest/capture disappears. Reconnect from cursor gets suffix.

Managed proxy: original source/sequence and snapshotWatermark survive host,
supervisor and gateway; do not substitute batch.head for snapshot watermark.
Gateway reconnect/restart rereads journal safely without native dispatch.
Legacy client gets old payload shapes, modern gets envelopes only; neither
double-applies raw+wrapped frames. Oversized page/receipt requests clamp/reject
with typed requester result and no shared session error.
```

- [ ] **Step 2: Red**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices sync_requester_gap"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-server --features managed-runtime-v1 fresh_agent_proxy"`

Expected FAIL: attach replays globally, sequence is discarded, live/replay race loses/duplicates events, or capture head is misrepresented.

- [ ] **Step 3: Production patch**

```text
Reuse Task 4's freshAgentReconciliationV1 hello/ready negotiation; do not add
a second capability or handshake. Server chooses per-connection modern
envelope or legacy payload.
Store interests by connection/view, canonical locator and adopted source.
Register before snapshot capture and buffer a bounded live suffix. Capture head,
page through it on explicit sync requests, then drain strictly greater suffix;
never push unbounded history. Single global poller remains per managed soul.

Read clamp: maxEvents<=256, maxBytes<=256KiB, commandIds<=128; enforce existing
WS frame budget including envelope and snapshot chunks. Ring eviction/queue
overflow sets resetRequired with actual bounds. Snapshot chunks carry captureId,
watermark, part index/final marker; serialize from one immutable captured value.
At most one capture per view; dispose at completion/detach/15s deadline. Do not
hold owner locks while serializing/sending. Oversized unsupported snapshot parts
produce finite typed error, retaining saved client content, never false coverage.

Extend existing managed host/admin operation variants to sync/query/capture.
Complete the provider capture/recovery bridge contract from Tasks 8–9 for all
four modes, including held/lost/coalesced bridge input and later deltas. Actor
allocates source/order, gateway only relays. Poller forward_polled_event
keeps AgentJournalEvent.sequence/source instead of forwarding event.event alone.
Attach catch-up is requester-only; actual canonical live events remain shared.
Legacy raw dispatch still uses safe requester attach behavior from Stage 2.
```

- [ ] **Step 4: Green**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices sync_requester_gap"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-server --features managed-runtime-v1 fresh_agent_proxy"`

Expected PASS with explicit replay/live insertion barriers and source-preserving managed results.

- [ ] **Step 5: Refactor**

Put bounds, snapshot-token lifecycle and replay/live drain in freshagent_delivery. Remove zero-cursor global replay_once behavior now replaced by targeted sync; retain one poller and established gateway transport.

- [ ] **Step 6: Impacted verification**

Run: `pnpm run contract:generate`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-server --features managed-runtime-v1 fresh_agent_proxy"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-runtime-protocol -p freshell-runtime-client -p freshell-session-host -p freshell-supervisor"`

Run: `pnpm run typecheck`; expected PASS. Managed command/query propagation changes public crate interfaces, so run complete affected managed crates, not just a schema parsing test.

- [ ] **Step 7: Commit**

```bash
git add shared/ws-protocol.ts shared/fresh-agent-contract.ts crates/freshell-protocol/src/client_messages.rs crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/src/freshagent_delivery.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/hosted_fresh_agent.rs crates/freshell-ws/src/hosted_fresh_agent_tests.rs crates/freshell-server/src/fresh_agent_proxy.rs crates/freshell-server/src/fresh_agent_proxy_tests.rs crates/freshell-runtime-protocol/src/lib.rs crates/freshell-runtime-protocol/src/fresh_agent_ops.rs crates/freshell-runtime-client/src/lib.rs crates/freshell-session-host/src/main.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-supervisor/src/lib.rs crates/freshell-ws/tests/freshagent_multiple_devices.rs crates/freshell-ws/tests/common/multiple_devices.rs port/contract/ws-protocol.schema.json port/contract/ws-server-messages.schema.json port/contract/ws-message-inventory.json port/contract/managed-runtime.schema.json
git commit -m "feat(freshagent): add bounded requester-scoped event catch-up"
```

### Task 11: Browser state reconciles contiguous events before all side effects

**Files:**
- Create: `src/lib/fresh-agent-reconciliation.ts`, `test/unit/client/lib/fresh-agent-reconciliation.test.ts`.
- Modify: `src/lib/ws-client.ts`, `fresh-agent-ws.ts`, `fresh-agent-stream-batcher.ts`, `fresh-agent-reveal-freshness.ts`, `src/store/freshAgentSlice.ts`, `freshAgentLiveSlice.ts`, `src/lib/fresh-agent-transcript-projection.ts`, `src/components/fresh-agent/FreshAgentView.tsx`.
- Test: existing WS/store/projection/view tests, browser helper/spec.

**Interfaces:**
- Consumes: Task 10 envelope/sync, Task 7 refresh lifecycle, inner Codex projection guards.
- Produces: `reconcileEnvelope(state,envelope) -> Apply | Duplicate | OutdatedSource | Gap`; canonical per-session source/contiguous cursor/receipt/settings/queue state in Redux; authoritative attach/sync source adoption only.

- [ ] **Step 1: Add red tests**

```text
Reducer/WS behavior: deliver sequence 1,3,2,2; providers receive 1,2,3 once and
cursor never jumps 1->3. An old source or duplicate cannot append text, regress
status/settings/approval, clear draft/local echo, ring a bell or trigger refresh.
Snapshot below applied cursor or from obsolete source is ignored; complete
current capture installs its watermark, discards <=watermark buffer, drains
suffix. Unchanged transcript revision still reconciles metadata/queue/receipts
and settles current refresh. Buffer overflow requests bounded reset once.

Capture reset while stream batcher has pending deltas: stale batch cannot
append after snapshot. Keep Codex projection/consumed-prefix/native-only tests.
Attention: reconnect within page may recover missed attention; first open/reload
seeds state without historical bell; restoring approval membership isn't a new
waiting edge. Raw FreshAgentView subscribers must see only accepted events.

Browser 'stage3 streaming join' and 'stage3 gap reconnect': real desktop stream,
mobile joins mid-turn; test-owned WS wrapper drops/holds/reorders actual server
frames, never invents transcript data. Force offline+disconnect, reload,
retention gap and stale capture release. Assert both final transcript/controls/
cursor converge, exact native message row counts, one runtime/native submit.
```

- [ ] **Step 2: Red**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-reconciliation.test.ts test/unit/client/fresh-agent-ws.test.ts --config config/vitest/vitest.config.ts`

Expected FAIL: replay/delayed raw events bypass dedup/source guard or snapshot regresses state. New test names must select real reducer/subscriber execution, not mocked expected messages only.

- [ ] **Step 3: Production patch**

```ts
// Exact application order; use existing store/event dispatch entry points.
const folded = reconcileEnvelope(sessionState, envelope)
if (folded.kind === 'Duplicate' || folded.kind === 'OutdatedSource') return
if (folded.kind === 'Gap') {
  requestSyncOnce(folded.locator, folded.contiguousCursor)
  return
}
for (const event of folded.contiguousEvents) dispatchCanonicalFreshAgentEvent(event)
```

```text
Implement the named functions as one gate in ws-client/fresh-agent-ws before
Redux, per-view onMessage listeners, stream batching, bells and local echoes.
Subscribe views to accepted canonical events/state, not the raw modern frame.
One browser store shares a session cursor across its local panes; server delivery
interests remain per view. Adopt a source only from current attached/sync result
with matching request and authoritative fence; arbitrary new-source live frames
trigger query, never replace the current source themselves.

Bound out-of-order suffix to existing event/byte budgets, request reset on gap
or overflow. Assemble bounded snapshot chunks by captureId/watermark and apply
atomically only when complete. Flush/discard pre-reset stream batches before
installing snapshot. Keep native-keyed overlay and Codex inner projection logic.
Update refresh.requiredWatermark from observed events; authoritative unchanged
snapshot settles only if source/watermark covers it. Preserve pending local
command IDs across view remount; drafts remain view-local. Legacy path retains
old event shape/semantics behind negotiation, not duplicate modern processing.
```

- [ ] **Step 4: Green**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-reconciliation.test.ts test/unit/client/fresh-agent-ws.test.ts --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage3 streaming join|stage3 gap reconnect'`

Expected PASS for all four modes, continuous output and unique rows.

- [ ] **Step 5: Refactor**

Move envelope/source/buffer decisions into the pure reducer; keep provider display projection and attention policies in existing modules. Remove newly redundant view-local duplicate checks only after their original regressions remain green.

- [ ] **Step 6: Impacted verification**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-reconciliation.test.ts test/unit/client/fresh-agent-ws.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/store/freshAgentSlice.test.ts test/unit/client/store/freshAgentLiveSlice.test.ts test/unit/client/lib/fresh-agent-transcript-projection.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx --config config/vitest/vitest.config.ts`

Run Step 4 browser selector and Task 10 two-socket command; expected PASS. Browser delivery gating impacts every side-effect subscriber and both store slices, so include their complete existing suites.

- [ ] **Step 7: Commit**

```bash
git add src/lib/fresh-agent-reconciliation.ts src/lib/ws-client.ts src/lib/fresh-agent-ws.ts src/lib/fresh-agent-stream-batcher.ts src/lib/fresh-agent-reveal-freshness.ts src/store/freshAgentSlice.ts src/store/freshAgentLiveSlice.ts src/lib/fresh-agent-transcript-projection.ts src/components/fresh-agent/FreshAgentView.tsx test/unit/client/lib/fresh-agent-reconciliation.test.ts test/unit/client/fresh-agent-ws.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/store/freshAgentSlice.test.ts test/unit/client/store/freshAgentLiveSlice.test.ts test/unit/client/lib/fresh-agent-transcript-projection.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.hidden-rebind.test.tsx test/e2e-browser/helpers/fresh-agent-multiple-devices.ts test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts
git commit -m "feat(freshagent): reconcile browser events and atomic snapshot watermarks"
```

### Task 12: All command ingress shares durable outcomes and native ordering

**Files:**
- Modify: `shared/ws-protocol.ts`, `shared/fresh-agent-contract.ts`, `crates/freshell-protocol/src/client_messages.rs`, `crates/freshell-protocol/src/server_messages.rs`, `port/contract/ws-protocol.schema.json`, `port/contract/ws-server-messages.schema.json`, `port/contract/ws-message-inventory.json`, `port/contract/managed-runtime.schema.json`, `crates/freshell-agent-runtime/src/reconciliation.rs`, `crates/freshell-agent-runtime/src/host_actor.rs`, `crates/freshell-freshagent/src/session_reconciliation.rs`, `crates/freshell-freshagent/src/claude.rs`, `crates/freshell-freshagent/src/codex.rs`, `crates/freshell-freshagent/src/opencode_ws.rs`, `crates/freshell-freshagent/src/rest_lane.rs`, `crates/freshell-freshagent/src/rest_lane_sync.rs`, `crates/freshell-freshagent/src/claude_rest_lane.rs`, `crates/freshell-freshagent/src/codex_rest_lane.rs`, `crates/freshell-server/src/fresh_agent_proxy_rest.rs`, `crates/freshell-server/src/fresh_agent_proxy.rs`, `crates/freshell-server/src/checkpoints.rs`, `crates/freshell-ws/src/checkpoint_barrier.rs`, `crates/freshell-ws/src/terminal.rs`, `crates/freshell-runtime-protocol/src/lib.rs`, `crates/freshell-runtime-protocol/src/fresh_agent_ops.rs`, `crates/freshell-runtime-client/src/lib.rs`, `crates/freshell-session-host/src/main.rs`, `crates/freshell-session-host/src/providers/fresh_agent.rs`, `crates/freshell-supervisor/src/lib.rs`, `src/components/fresh-agent/FreshAgentView.tsx`, `src/lib/fresh-agent-ws.ts`, `src/store/freshAgentSlice.ts`.
- Modify tests: `crates/freshell-freshagent/src/rest_lane_http_tests.rs`, `rest_lane_publication_tests.rs`, `claude_rest_lane_tests.rs`, `codex_rest_lane_tests.rs` for cross-ingress command identity/order/native count assertions.
- Test: runtime core/actor, server checkpoint/proxy, provider REST lane and WS two-device tests, browser spec/helper.

**Interfaces:**
- Consumes: Tasks 8–11 receipt/source/state/query and existing send logicalAttemptId/checkpoint barrier.
- Produces `admit_command(meta,payload) -> ExistingReceipt | AcceptedReceipt | TypedRefusal`; `begin_dispatch(commandId) -> DispatchPermit | CurrentReceipt`; stable result query via `sync.commandIds`. Applies to send, interrupt, configure, compact, rollback/fork, kill/recovery-stop and native decisions, plus Task 15 queue cancellation. Provider-specific preconditions arrive in Tasks 13/14; their commands already pass this admission boundary.

- [ ] **Step 1: Add red tests**

```text
Rust 'command_outcomes': submit same logical send from A/B with distinct
transport request IDs, lose acceptance/result delivery, query command ID and
repeat exact ID. Assert native submit=1, receipt order/turn identity stable,
one transcript row; changed payload under that ID conflicts only to requester.
Repeat semantic operations with effect counters. Server admission/order includes
concurrent WS plus actual REST ingress, so headless calls cannot bypass it.

Crash/reopen at before acceptance persistence, after existing send-fence update
and before native RPC, after native delivery before receipt, and after persisted
provider acknowledgment before WS publication. Query gives Missing only before
persisted admission, otherwise known or ambiguous, never safe-to-resend. Expire
detailed receipt data and verify the compact lookup representation still routes
send retries through the existing send-effect fence; receipt storage never
grants dispatch permission. Store failure refuses before effect; unreadable
query is typed error. Explicitly cover absent barrier, durable read/write failure
and old/new native aliases across ordinary WS, checkpointed WS, REST and managed
host. Two request IDs for one logicalAttemptId invoke one native send. A sidecar
write alone and OpenCode 204 cannot promote a receipt to ProviderAcked. Same-ID compact/rollback/fork/decision/kill never effect twice.

Browser 'stage3 lost acknowledgment': drop real acceptance frame, reconnect,
query existing command ID, show pending/accepted/ambiguous outcome, no automatic
new-ID send and no duplicate transcript/native requests. Both views converge.
```

- [ ] **Step 2: Red**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices command_outcomes"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-server checkpoints"`

Expected FAIL: no queryable non-send outcome/order, checkpoint capture mislabeled accepted, or receipt loss causes duplicate native dispatch.

- [ ] **Step 3: Production patch**

Command admission first resolves the durable conversation and existing receipt,
checks the digest/source/preconditions, then persists new acceptance/order and
payload. Eligible dispatch separately consults the sole durable send-effect
authority; the queryable receipt and its Dispatching state never authorize a
native send by themselves. The following decisions define that boundary.

```text
Implement these operations in shared bookkeeping and owner adapters. Do not
hold the short state lock across provider await. Submission serialization uses
each provider's actual short boundary, never model completion. Codex may acknowledge start/steer with a native ID. Claude releases
on its correlated UUID queued/started lifecycle, not sidecar stdin completion.
OpenCode releases on the bounded HTTP dispatch/response path and records only
serve-response-observed for 204; detached prompt persistence/native scheduling
remain unproven until separate correlated evidence arrives. A timeout after
possible delivery stays Ambiguous with no redrive, and does not block controls
needed to settle the active turn. Do not promise native FIFO or one turn per
command where the provider absorbs or loosely handles busy input. acceptedOrder
is total server admission order; dispatchOrder records eligible native order.
Deferred queue entries do not block a target-valid interrupt/approval; their
later drain still respects accepted order. Native busy sends retain provider
admission rules instead of becoming implicit follow-ups.

Sends use logicalAttemptId as commandId and request-ID aliases. Bind one durable
send-effect authority to the resolved stable conversation identity: extend the
existing checkpoint dispatch fence for default routes and retain the managed
actor's durable dispatch fence for managed routes. All ingress for that owner
must consult the same authority; managed gateway/checkpoint bookkeeping and
queryable receipts reference its decision and cannot grant a separate permit.
Retain historical fences and aliases before admitting modern retries; a changed
wire locator or transport request ID must not create a new effect key. Do not
change which authority owns an existing conversation without preserving its
previous dispatched/ambiguous identities.

Replace void barrier-and-forward with a typed durable permit/outcome contract.
Ordinary WS and REST must use it as well as checkpointed sends. Remove optional
barrier fallthrough and process-local forwarding after durable read/write
failure from these paths: unavailable authority refuses before effect. Persist
admission, then obtain/persist the sole effect permit, then dispatch; a crash
between these writes does not make a receipt into a send permit. Managed actor
request-ID dedup must resolve the same logical command and digest before its
transport dispatch. Preserve its journal and protected payload storage.

The checkpoint before-publication hook can carry provider evidence, but capture
success, dispatch_started, a pipe write, and OpenCode 204 are not ProviderAcked.
Persist a native turn ID only when proven; leave it absent otherwise rather
than inventing one to publish an acknowledgment. Existing rewind/checkpoint
outcome stays separately visible.

Every mutating provider/REST/managed entry routes admission before effects.
Expose optional commandId in REST request contract; callers without it receive
one server-assigned ID in their response and cannot infer retry safety from a
lost response. Same supplied ID dedups across WS/REST. Reuse existing request
aliases for CLI/MCP ingress, which calls these APIs, without a second transport.
Managed host allocates order/state; gateway never independently accepts it.

On restart Dispatching without durable native acceptance is Ambiguous. Query
native transcript evidence to refine only when positively correlated; never
auto-resubmit an ambiguous operation or remint its logical attempt. UI retains
unknown local echo/receipt status, not composer text marked safely unsent.
Typed pre-dispatch rejection may retain the existing proven-no-delivery retry.
```

- [ ] **Step 4: Green**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices command_outcomes"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-server checkpoints"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage3 lost acknowledgment'`

Expected PASS with actual submit/effect counters.

- [ ] **Step 5: Refactor**

Use one admission/lookup adapter per owner; remove overlapping receipt state. Preserve the existing send-effect fence and managed payload persistence, and retain only the new bounded receipt/compact lookup representation selected by the shared retention policy. Keep typed result errors separate from shared session errors.

- [ ] **Step 6: Impacted verification**

Run: `pnpm run contract:generate`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-agent-runtime"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-freshagent --lib rest_lane"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_claude_checkpointed_send"`

Run Step 2 commands, Step 4 browser selector and `pnpm run typecheck`; expected PASS. Complete impacted crate interface tests from Task 10 are required because every managed mutating operation carries CommandMeta.

- [ ] **Step 7: Commit**

```bash
git add shared/ws-protocol.ts shared/fresh-agent-contract.ts crates/freshell-protocol/src/client_messages.rs crates/freshell-protocol/src/server_messages.rs crates/freshell-agent-runtime/src/reconciliation.rs crates/freshell-agent-runtime/src/reconciliation_tests.rs crates/freshell-agent-runtime/src/host_actor.rs crates/freshell-agent-runtime/src/host_actor_tests.rs crates/freshell-freshagent/src/session_reconciliation.rs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-freshagent/src/rest_lane.rs crates/freshell-freshagent/src/rest_lane_sync.rs crates/freshell-freshagent/src/claude_rest_lane.rs crates/freshell-freshagent/src/codex_rest_lane.rs crates/freshell-server/src/fresh_agent_proxy_rest.rs crates/freshell-server/src/fresh_agent_proxy.rs crates/freshell-server/src/checkpoints.rs crates/freshell-ws/src/checkpoint_barrier.rs crates/freshell-ws/src/terminal.rs crates/freshell-runtime-protocol/src/lib.rs crates/freshell-runtime-protocol/src/fresh_agent_ops.rs crates/freshell-runtime-client/src/lib.rs crates/freshell-session-host/src/main.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-supervisor/src/lib.rs src/components/fresh-agent/FreshAgentView.tsx src/lib/fresh-agent-ws.ts src/store/freshAgentSlice.ts crates/freshell-ws/tests/freshagent_multiple_devices.rs crates/freshell-ws/tests/common/multiple_devices.rs test/e2e-browser/helpers/fresh-agent-multiple-devices.ts test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts port/contract/ws-protocol.schema.json port/contract/ws-server-messages.schema.json port/contract/ws-message-inventory.json port/contract/managed-runtime.schema.json
git add crates/freshell-freshagent/src/rest_lane_http_tests.rs crates/freshell-freshagent/src/rest_lane_publication_tests.rs crates/freshell-freshagent/src/claude_rest_lane_tests.rs crates/freshell-freshagent/src/codex_rest_lane_tests.rs
git commit -m "feat(freshagent): persist ordered command outcomes across all ingress"
```

### Task 13: Settings edits are versioned and stale ordinary sends cannot revert them

**Files:**
- Modify: `shared/ws-protocol.ts`, `shared/fresh-agent-contract.ts`, `crates/freshell-protocol/src/client_messages.rs`, `server_messages.rs`, four generated contract outputs, `crates/freshell-agent-runtime/src/reconciliation.rs`, `host_actor.rs`, `crates/freshell-freshagent/src/session_reconciliation.rs`, `identity_sink.rs`, `claude.rs`, `codex.rs`, `opencode_ws.rs`, `crates/freshell-supervisor/src/lib.rs`, `crates/freshell-supervisor/src/service.rs`, `crates/freshell-runtime-protocol/src/fresh_agent_ops.rs`, `crates/freshell-runtime-client/src/lib.rs`, `crates/freshell-session-host/src/providers/fresh_agent.rs`, `src/lib/fresh-agent-configure.ts`, `fresh-agent-settings-convergence.ts`, `src/components/fresh-agent/FreshAgentView.tsx`, `src/store/freshAgentSlice.ts`.
- Test: runtime/provider owner tests, `crates/freshell-supervisor/src/fresh_agent_configure_tests.rs`, `test/unit/client/lib/fresh-agent-settings-convergence.test.ts`, view/store tests and two-device browser/Rust suites.

**Interfaces:**
- Consumes: Task 12 admission/source/order, durable identity settings Keep/Replace from Task 3.
- Produces: `Configure{commandId,expectedSettingsRevision,edits}`, authoritative settings with distinct desired values and effective values/certainty/scope, and typed `SettingsConflict` carrying the current revision and both projections. Explicit null Default effort remains distinct from absent. Modern normal Send omits cached full settings; all actual settings changes use the shared versioned edit operation.

- [ ] **Step 1: Add failing behavior tests**

```text
Rust 'settings_revision': start both devices at N. A submits supported explicit
edit; a fully applied edit commits N+1. B ordinary Send using its stale display
must use current server settings, not revert A. B edit with expected N returns
conflict/current N+1 only to B, native configure count unchanged. Duplicate A
command returns the same result/revision. Test a provider that applies one field
before refusing the next: the receipt and converged settings show the known
partial effect without claiming the whole patch succeeded. A lost/uncertain
native result is marked uncertain until a safe readback/reconcile; it does not
pretend that no field changed. Cover Claude busy refusal, Codex/OpenCode next-turn
staging and managed refusal retaining desired values. Readback absence settles
with uncertainty rather than hanging or claiming the desired patch took effect.
A delayed metadata/snapshot with N cannot
overwrite N+1. Test absent vs effort:null and each provider's supported/create-only fields.

Client settings tests execute actual emitted frames: ordinary modern send has
no settings cache, explicit editor change has expected revision and only edits;
conflict retains uncommitted local choice while header follows server values.
Legacy send semantics still work without negotiation. Browser 'stage3 settings'
uses real supported fixture catalog values, races desktop/mobile edit/send and
asserts actual native request options plus converged header/revision, unique row.
```

- [ ] **Step 2: Red**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices settings_revision"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-settings-convergence.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t 'settings revision|stale settings' --config config/vitest/vitest.config.ts`

Expected FAIL: no server revision conflict, full-cache ordinary send reverts settings, or stale metadata regresses committed display.

- [ ] **Step 3: Production patch**

```text
Persist desired settings and effective values/certainty/scope with one
monotonically versioned owner record. Initialize from genuinely recovered settings without inventing defaults for identity-only
rows; if no record exists use provider's real default snapshot as revision 0,
not a fabricated durable historical edit. Configure admission validates expected
committed revision and provider capabilities. Serialize native configure through the existing submission gate.
Claude preserves busy refusal and reports correlated partial setter values;
Codex/OpenCode success stages next-turn defaults without claiming to change the
current turn. Managed refusal may preserve desired settings for a later send
and must not imply no change. Advance the record revision when authoritative
intent, known effective fields or certainty changes, including partial/unknown
outcomes; duplicate commands and genuine no-ops do not advance it. A pending
configure reserves its base revision, so another edit returns conflict/pending.

After a lost native response, retain prior values only as last-known, mark the
affected effective fields unknown, and publish a bounded uncertain outcome.
A proven readback may reconcile it; do not assume one exists for every provider
or wait indefinitely. Dependent operations receive a typed bounded refusal if
they require unknown values; normal provider-native busy sends and independently
known fields retain their supported behavior. Recovery or a later proven setter
result may restore certainty. Never publish the whole requested patch as
applied after a partial failure, or add per-send private settings restoration.

On default-path resume, load existing reconciliation settings/revision first;
only a session with no modern record falls back to identity_sink.load_settings.
The modern owner record is the revision authority. Mirror its accepted values
to the existing identity ledger using Keep/Replace semantics without inventing
history defaults. If a post-commit mirror write fails, log/retry the mirror and
preserve the authoritative modern revision; a restart cannot reload stale mirror
values over that newer record. Managed profile/settings stay in its actor state.

Modern ordinary sends carry no cached settings, so stale device state cannot
revert newer shared values. Provider adapters retain their existing native busy
behavior and use the provider's actual effective settings at its proven native
dispatch boundary; report an effective revision only when that boundary can
establish it. Native request audits prove actual settings behavior; UI-only
convergence is insufficient. Never replay an old view's values through a send.
```

- [ ] **Step 4: Green**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices settings_revision"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage3 settings'`

Expected PASS across all modes; repeat Step 2 client command green.

- [ ] **Step 5: Refactor**

Keep explicit-edit conversion in fresh-agent-configure and version comparison in the canonical fold. Retire negotiated-path local Codex convergence heuristics that duplicate server authority; preserve their legacy path and provider-native capability validation.

- [ ] **Step 6: Impacted verification**

Run: `pnpm run contract:generate`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-supervisor --lib fresh_agent_configure"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-freshagent --lib settings"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-settings-convergence.test.ts test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Run Step 4 commands and `pnpm run typecheck`; expected PASS, preserving all existing provider model/effort/default-setting regressions and native busy options.

- [ ] **Step 7: Commit**

```bash
git add shared/ws-protocol.ts shared/fresh-agent-contract.ts crates/freshell-protocol/src/client_messages.rs crates/freshell-protocol/src/server_messages.rs crates/freshell-agent-runtime/src/reconciliation.rs crates/freshell-agent-runtime/src/reconciliation_tests.rs crates/freshell-agent-runtime/src/host_actor.rs crates/freshell-freshagent/src/session_reconciliation.rs crates/freshell-freshagent/src/identity_sink.rs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-supervisor/src/lib.rs crates/freshell-supervisor/src/service.rs crates/freshell-supervisor/src/fresh_agent_configure_tests.rs crates/freshell-runtime-protocol/src/fresh_agent_ops.rs crates/freshell-runtime-client/src/lib.rs crates/freshell-session-host/src/providers/fresh_agent.rs src/lib/fresh-agent-configure.ts src/lib/fresh-agent-settings-convergence.ts src/components/fresh-agent/FreshAgentView.tsx src/store/freshAgentSlice.ts test/unit/client/lib/fresh-agent-settings-convergence.test.ts test/unit/client/store/freshAgentSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx crates/freshell-ws/tests/freshagent_multiple_devices.rs test/e2e-browser/helpers/fresh-agent-multiple-devices.ts test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts port/contract/ws-protocol.schema.json port/contract/ws-server-messages.schema.json port/contract/ws-message-inventory.json port/contract/managed-runtime.schema.json
git commit -m "feat(freshagent): version settings edits and capture server send defaults"
```

### Task 14: Delayed controls target one turn and shared decisions resolve atomically

**Status: planned; depends on Tasks 9 and 12.** Implement server-owned turn targeting before native adapter invocation on both default and managed routes. Source-backed mappings below reuse existing provider lifecycle tracking. Positive current-target Stop and stale-target rejection are required for all four modes. Task 15 depends on this task's target/settlement evidence. Provider-internal progress after an admitted operation is dispatched remains an existing operation limitation; it is not an extra atomicity gate on Tasks 1–7 or this task.

**Files:**
- Modify: `shared/ws-protocol.ts`, `shared/fresh-agent-contract.ts`, `crates/freshell-protocol/src/client_messages.rs`, `server_messages.rs`, four generated outputs, `crates/freshell-agent-runtime/src/reconciliation.rs`, `host_actor.rs`, `crates/freshell-freshagent/src/claude.rs`, `claude_edges.rs`, `claude/stop.rs`, `claude_turns.rs`, `codex.rs`, `codex/controls.rs`, `opencode_ws.rs`, `crates/freshell-runtime-protocol/src/fresh_agent_ops.rs`, `crates/freshell-runtime-client/src/lib.rs`, `crates/freshell-session-host/src/providers/fresh_agent.rs`, `crates/freshell-supervisor/src/lib.rs`, `src/components/fresh-agent/FreshAgentView.tsx`.
- Test: `crates/freshell-freshagent/src/codex/controls/tests.rs`, managed actor tests, existing `crates/freshell-ws/tests/freshagent_claude_approvals.rs`, `freshagent_control_reply.rs`, two-device Rust/browser tests and view unit tests.

**Interfaces:**
- Consumes: Task 12 command receipt/source/dispatch boundary, Task 9 current native/dispatch turn projection, existing Claude checked native callback reservation/Codex control lock.
- Produces: `Interrupt{commandId,expectedSource,expectedTurn,source}` where `expectedTurn` is a source-scoped owner turn identity with optional native identity and explicit prestart/unknown state; decisions retain separate commandId, existing native requestId, expected native source/turn, response digest and winning receipt. Typed StaleTarget/AlreadyResolved/Ambiguous results and shared membership/resolution projection. A turn may have zero or multiple associated client commands.

- [ ] **Step 1: Add red regressions**

```text
Rust 'targeted_controls': capture turn A on mobile, delay its actual Interrupt
until A finishes and desktop starts B. Release: B is not interrupted; mobile
gets stale-target receipt. Also target accepted pre-start command A, hold native
acceptance, then cancel/settle A and start B: delayed stop still cannot hit B.
Current-target user Stop preserves silent attention policy/native target latch.
Hold the device frame before server delivery, then repeat with it waiting at
the server admission gate: let the owner observe A settled and B current before
releasing A's control. Assert zero adapter/native interrupt calls, a stable
requester stale-target receipt, and B continuing to completion. Cover commandless
B, absorbed commands, and duplicate/trailing A lifecycle events in the owner
mapping. Delay a Claude prestart reissue until its original target settles;
it must not reselect B. Run the same tests through gateway/host/provider and
verify expectedSource/expectedTurn survive every hop. Current-target Stop must
still invoke the provider's existing API and preserve its ordinary behavior;
fixtures must not invent an unsupported provider-native conditional interrupt.

Rust 'atomic_decisions': opposite A/B approval/question answers arrive while
first stdin/native RPC is held. Exactly one callback/native decision, one
winning response digest and receipt; loser gets AlreadyResolved containing
winner, no peer session error. Identical command retry returns same result.
Crash after Dispatching stays ambiguous instead of reopening Pending. Cover
Claude/Kilroy approval+question, Codex approval/question/elicitation and current
native source validation. OpenCode unsupported actions remain deterministic
unsupported with zero fabricated native callbacks.

Browser 'stage3 controls': independently click opposite answers then delay an
old interrupt. Audit native decisions/target IDs, both views' membership and
resolution, no duplicate tool response and no B stop or spurious attention bell.
```

- [ ] **Step 2: Red**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices targeted_controls"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices atomic_decisions"`

Expected FAIL: delayed interrupt chooses current turn B, Claude double-writes decisions, or Codex harmless loser broadcasts shared REQUEST_UNAVAILABLE.

- [ ] **Step 3: Production patch**

```text
Include current TurnTarget in retained presentation and events, using a
source-scoped owner turn generation, optional nativeTurnId, zero-to-many command
membership, and explicit prestart/unknown states. Allocate and settle under the
existing provider owner lock; reuse its lifecycle, not one turn per client send.

Codex: correlate the native turnId and completed-turn evidence already tracked by
the adapter/proxy. Preserve turn/interrupt{threadId,turnId} and its submission-only
acknowledgment; interruption acknowledgment alone is not turn settlement.
Claude/Kilroy: extend claude_turns' turn_open/command phases and Stop latch with
an owner generation. Opening Running/RequiresAction/TurnEvidence/content or a
Started/Replayed command establishes the active generation if none is open;
absorbed commands join it. A commandless CLI turn gets its own generation.
Result/Idle retire the current generation and Started membership as the ledger
already does, while Accepted/Queued commands retain stable prestart identities.
Promoting a prestart identity records its membership in the resulting generation,
so Stop and follow-ups can resolve that original target without retargeting.
Use the existing result/lifecycle/idle ordering and duplicate suppression; test
trailers after settlement and queued successors explicitly.
OpenCode: add a source-scoped monotonic activity generation to OpencodeSession.
Reserve it on idle-to-dispatch/prestart work, or on observed daemon running when
there is no active generation. Ordinary overlapping busy sends join its command
membership; replacing the latest turn_task handle does not replace the target.
Associate drive tasks, settlement callbacks and status-recovery attempts with
that generation. Reuse await_idle, observe_daemon_running and the session-locked
conclude_idle_observation activity checks to settle the captured generation;
preserve abort-in-flight/orphan guards and compact FIFO eligibility. Distinguish
target settlement from the existing quiescence gate on idle publication: queued
follow-ups waiting for that target must not prevent its settlement. Record the
target end before draining eligible entries; never require their queue empty
as proof that their prerequisite ended. An ordered
running-to-idle observation or bounded authoritative status recovery supplies
owner settlement evidence; ignore obsolete source/generation callbacks and
trailing idle that conflicts with current drive/activity. Do not label a prompt
message ID or overwritten task handle as a native turn ID. Lost/lagged lifecycle
evidence becomes Unknown until bounded refresh settles it, never a fabricated
completion. Tasks 9/14 test source replacement, overlapping sends, trailing idle
and commandless daemon activity. This maps the server-observed activity boundary;
it cannot distinguish an unobserved provider-internal successor atomically.

Composer captures the target and expected source when the user clicks Stop or
answers a decision. Carry both unchanged through server queues and managed
operations to the same provider owner used by the default route. Immediately
before native adapter invocation, under existing owner submission serialization,
compare source and target to current authoritative state and reserve dispatch.
Any persisted admission wait precedes this final comparison. A mismatch/settled
target gets a persisted requester StaleTarget receipt with zero native call and
no Stop latch/attention/permission mutation. Do not release the submission gate
between the final comparison and adapter invocation; retain short state locks
only for compare/reservation, not native I/O. Current matching targets use the
existing provider API. Known prestart targets retain provider-supported Stop
latching; unknown targets get finite resync/typed no-effect refusal rather than
blanket refusal for ordinary turns. Server-controlled delayed retries, including
Claude's existing prestart reissue, must revalidate the original source/target;
preserve that behavior when the same target remains eligible, never reselect B.
An already dispatched control with uncertain delivery is Ambiguous, not a claimed
no-effect refusal. Native execution may progress after invocation; preserve its
existing semantics without claiming an internal atomic compare or hiding this
residual behind a stronger fixture API.

Reuse Claude native_dispatches checked reservation: under session/control lock,
claim Pending->Dispatching and persist command/response digest before await.
Release lock during actual write; record correlated native outcome once.
Codex retains lock and native source validation but returns typed requester
AlreadyResolved for duplicate/loser. Managed host reuses its existing atomic
resolve_permission decision record. Pending controls stay shared, resolution
commits to projection/event and converges all views. An opposite decision cannot
replace a claimed winner; ambiguous native delivery never returns to Pending.
Separate native requestId from transport requestId and commandId throughout.
Preserve provider-native unsupported decisions and busy/attention semantics.
```

- [ ] **Step 4: Green**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices targeted_controls"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices atomic_decisions"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage3 controls'`

Expected PASS, with exact decision/interrupt native counters and submitted target IDs.

- [ ] **Step 5: Refactor**

Centralize source/turn precondition comparison and decision result mapping; retain each provider's checked native write and attention edge machinery. Remove only the converted generic shared losing-decision error branch.

- [ ] **Step 6: Impacted verification**

Run: `pnpm run contract:generate`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-freshagent --lib codex::controls"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_claude_approvals --test freshagent_control_reply --test freshagent_claude_turns"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-agent-runtime --lib host_actor"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts test/e2e-browser/specs/fresh-agent-control-rust.spec.ts test/e2e-browser/specs/fresh-agent-hidden-approval-reveal.spec.ts`

Expected PASS and nonzero modes/cases; include existing client view/reconciliation unit suites from Task 11 because controls and attention cross that gate.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-freshagent/src/claude/stop.rs crates/freshell-freshagent/src/claude_turns.rs
git add shared/ws-protocol.ts shared/fresh-agent-contract.ts crates/freshell-protocol/src/client_messages.rs crates/freshell-protocol/src/server_messages.rs crates/freshell-agent-runtime/src/reconciliation.rs crates/freshell-agent-runtime/src/reconciliation_tests.rs crates/freshell-agent-runtime/src/host_actor.rs crates/freshell-agent-runtime/src/host_actor_tests.rs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/claude_edges.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/codex/controls.rs crates/freshell-freshagent/src/codex/controls/tests.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-runtime-protocol/src/fresh_agent_ops.rs crates/freshell-runtime-client/src/lib.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-supervisor/src/lib.rs src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx crates/freshell-ws/tests/freshagent_multiple_devices.rs crates/freshell-ws/tests/freshagent_claude_approvals.rs crates/freshell-ws/tests/freshagent_control_reply.rs test/e2e-browser/helpers/fresh-agent-multiple-devices.ts test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts port/contract/ws-protocol.schema.json port/contract/ws-server-messages.schema.json port/contract/ws-message-inventory.json port/contract/managed-runtime.schema.json
git commit -m "feat(freshagent): fence delayed controls and atomically resolve shared decisions"
```

### Task 15: Submitted follow-ups are durable server-ordered commands

**Status: planned; depends on Task 14's verified owner target and settlement mapping**, as well as Tasks 12–13. If that mapping fails for a required route, this task remains incomplete with Task 14; it does not block independent Stage 1/2 work. Accepted follow-ups survive bounded unknown settlement without dropping or changing their captured target.

**Files:**
- Modify: `shared/ws-protocol.ts`, `shared/fresh-agent-contract.ts`, `crates/freshell-protocol/src/client_messages.rs`, `server_messages.rs`, four generated outputs, `crates/freshell-agent-runtime/src/reconciliation.rs`, `host_actor.rs`, `crates/freshell-freshagent/src/session_reconciliation.rs`, `claude.rs`, `codex.rs`, `opencode_ws.rs`, `crates/freshell-runtime-protocol/src/fresh_agent_ops.rs`, `crates/freshell-runtime-client/src/lib.rs`, `crates/freshell-session-host/src/providers/fresh_agent.rs`, `crates/freshell-supervisor/src/lib.rs`, `src/components/fresh-agent/FreshAgentView.tsx`, `src/store/freshAgentSlice.ts`.
- Test: core/actor/provider and WS two-device tests, FreshAgentView tests, browser helper/spec.

**Interfaces:**
- Consumes: Task 12 command admission/receipts, Task 13 shared settings authority and Task 14 source-scoped turn target.
- Produces: `Send.delivery: 'native' | 'after-current-turn'`; `AcceptedFollowup{commandId,acceptedOrder,afterTurn,payloadRef,state}`; conditional ordered `CancelQueued{commandId,targetCommandId}`. Accepted queue is authoritative shared state, drafts stay local; effective settings are resolved and reported only at the actual provider dispatch boundary when known.

- [ ] **Step 1: Add failing behavior tests**

```text
Rust 'accepted_followups': hold native turn A. Desktop submits Q1 then mobile
Q2 as after-current-turn. Both immediately see server receipts/queue order;
reload/close the submitter and reopen owner persistence before release. Exactly
one Q1 then Q2 native submission occurs after A, ordered by acceptedOrder.
Configure newer shared defaults before drain: each native request follows the
provider's existing busy-send/effective-settings behavior and neither view's
stale cached values may revert the committed settings. Receipts report the
effective revision only if provider evidence establishes it.

Cancel Q2 while queued: one cancelled receipt, no Q2 native call. Race cancel
after Dispatching: returns current receipt and never claims successful cancel.
Crash in dispatch keeps ambiguity with no automatic redrive. Queue admission
enforces <=128 accepted entries and <=4MiB retained payload per session, using
existing protected payload lifecycle; refusal keeps unsent text local. A stop
or approval can dispatch while an earlier follow-up is ineligible. Test stale
source/expected turn and owner replacement preserve settled command identities.
Lose A's settlement evidence after Q1 is accepted: bounded reconciliation ends
in visible waiting/unknown, preserving Q1's payload, order and afterTurn across
reload. An unrelated B idle cannot release or retarget Q1. Recover authoritative
settlement for A and drain Q1 once; timeout alone never means A completed.

Existing normal busy sends retain Codex native steer, Claude native acceptance,
OpenCode's compact-only FIFO and ordinary busy-send behavior. Browser
'stage3 followups' proves shared queue,
view-local unsent draft invisibility, order/settings/native-count after submitter
reload, conditional cancel and no duplicate transcript rows for all modes.
```

- [ ] **Step 2: Red**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices accepted_followups"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t 'accepted follow|local draft' --config config/vitest/vitest.config.ts`

Expected FAIL: queue belongs to React view, reload loses submitted work, devices choose conflicting order, or dispatch overwrites newer defaults.

- [ ] **Step 3: Production patch**

```text
When user chooses follow-up and presses Send, immediately send an admitted
command with after-current-turn, captured current TurnTarget and stable ID.
Persist its payload reference/order before acknowledgment; publish shared queue
event. Only then clear the submitted local composer. An admission refusal leaves
text as an unsent local draft; ambiguous effect never does.

Admission captures Task 14's current owner target, including a known prestart
identity and its later generation association. If the owner is already settled,
accept the follow-up as eligible under the same serialized check. An unknown
current target gets bounded reconciliation/explicit refusal with the unsent draft
intact; normal Claude/OpenCode activity uses the mapped target, not blanket
Unknown. After acceptance, retain the exact afterTurn across reconnect/recovery.
Owner drain selects entries by acceptedOrder after that target's settlement,
using Task 14's provider lifecycle/authoritative idle evidence. An uncorrelated
idle for another/unknown generation cannot release them. If evidence is missing,
retain accepted command/payload/order and expose waiting/unknown while bounded
reconciliation runs. Its timeout settles the refresh outcome, not the queued
command: keep it queryable and cancellable while awaiting evidence, never drop
or retarget it to whichever turn is current.
Atomically transition Queued->Dispatching and persist dispatch fence before invoking existing provider send. Do not redrive a Dispatching record on
restart unless existing native idempotency/correlated evidence proves safety;
otherwise keep Ambiguous and expose query. Reuse managed protected payload store
and default session metadata store; no browser drain leader or second queue.

Wire OpenCode pending_sends to these accepted entries so existing compact FIFO
drains them, not a parallel new queue. Native delivery mode continues provider
busy semantics; follow-up is explicit. Do not freeze settings at admission or
call Configure with old queued settings. Resolve provider settings at actual
dispatch under the shared settings authority; later settings changes do not
rewrite accepted payloads or move the committed revision backward.

CancelQueued is itself admitted/ordered and CASes target only while Queued;
otherwise returns target's current receipt. Release payload retention using the
new bounded receipt/compact lookup policy from Task 8, while retaining the
existing send-effect fence. Limit admission to 128 entries /
4MiB retained queued payload; typed backpressure before acceptance, no silent
drop/eviction. Render accepted queue from canonical store on all devices and
remove React queuedMessages auto-send effect. Keep unsent drafts per local view.
```

- [ ] **Step 4: Green**

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices accepted_followups"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage3 followups'`

Expected PASS with exact Q1/Q2 payload/order/native counts and provider-supported effective-settings evidence; queued work does not replay stale view values. Repeat Step 2 client command green.

- [ ] **Step 5: Refactor**

Delete the view-local submitted queue/drain and reuse canonical queue selectors. Keep local draft editing separate. Unify OpenCode/managed/default queue eligibility bookkeeping without changing native submission adapters.

- [ ] **Step 6: Impacted verification**

Run: `pnpm run contract:generate`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-agent-runtime"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-freshagent --lib"`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices"`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/store/freshAgentSlice.test.ts test/unit/client/lib/fresh-agent-reconciliation.test.ts --config config/vitest/vitest.config.ts`

Run Step 4 browser selector; expected PASS. Complete provider unit suites are impacted because queue drain shares busy-send/compact paths and settings admission.

- [ ] **Step 7: Commit**

```bash
git add shared/ws-protocol.ts shared/fresh-agent-contract.ts crates/freshell-protocol/src/client_messages.rs crates/freshell-protocol/src/server_messages.rs crates/freshell-agent-runtime/src/reconciliation.rs crates/freshell-agent-runtime/src/reconciliation_tests.rs crates/freshell-agent-runtime/src/host_actor.rs crates/freshell-agent-runtime/src/host_actor_tests.rs crates/freshell-freshagent/src/session_reconciliation.rs crates/freshell-freshagent/src/claude.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-runtime-protocol/src/fresh_agent_ops.rs crates/freshell-runtime-client/src/lib.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-supervisor/src/lib.rs src/components/fresh-agent/FreshAgentView.tsx src/store/freshAgentSlice.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/store/freshAgentSlice.test.ts test/unit/client/lib/fresh-agent-reconciliation.test.ts crates/freshell-ws/tests/freshagent_multiple_devices.rs test/e2e-browser/helpers/fresh-agent-multiple-devices.ts test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts port/contract/ws-protocol.schema.json port/contract/ws-server-messages.schema.json port/contract/ws-message-inventory.json port/contract/managed-runtime.schema.json
git commit -m "feat(freshagent): accept and order shared follow-ups on the server"
```

### Task 16: Recover unresolved commands after reload and prove the complete device matrix

**Files:**
- Create: `src/lib/fresh-agent-pending-commands.ts`, `test/unit/client/lib/fresh-agent-pending-commands.test.ts`.
- Modify: `src/components/fresh-agent/FreshAgentView.tsx`, `src/lib/fresh-agent-ws.ts`, `src/store/freshAgentSlice.ts`, `test/e2e-browser/helpers/fresh-agent-multiple-devices.ts`, `specs/fresh-agent-multiple-devices-rust.spec.ts`, `specs/runtime-fresh-agent-fixture-rust.spec.ts`, managed fixture helper `test/e2e-browser/helpers/managed-runtime.ts`, `scripts/testing/runtime-sandbox.ts`, `crates/freshell-session-host/src/providers/fresh_agent.rs`, `crates/freshell-server/src/fresh_agent_proxy_tests.rs`, `crates/freshell-ws/tests/freshagent_multiple_devices.rs`, `README.md`, `docs/index.html`.

**Interfaces:**
- Consumes: all prior tasks' negotiated receipts/sync/queue/settings/target state and the existing local Docker managed fixture route.
- Produces: bounded device-local unresolved-command ID recovery (no prompt content), startup query and honest unknown result presentation; combined default/managed acceptance evidence and user documentation.

- [ ] **Step 1: Add final failing behavior regressions**

```text
Client test: persist only {durableLocator,commandId,operationKind,createdAt}
before transmission, lose result and reload the browser store. It queries those
IDs after authoritative attach and shows recovered receipt or unknown/expired/
unreadable state without resending or restoring prompt as unsent. Different
native presentation alias resolves to same durable key. B's independent local
draft remains untouched. Pending ID limit is 128 per session; never evict an
unresolved ID silently to allow new work. Settled IDs are pruned, unknown IDs
are retained until explicit local dismissal, which never authorizes resend.

Browser 'stage3 reload outcomes': submit, drop real ack, fully reload/reopen
device context's persisted storage, catch up/query and assert exactly one native
submission, shared receipt/turn, no duplicate local echo/transcript row. Repeat
with concurrent followups/settings/approval resolution and suspension. Reset
runtime source through test-owned restart in Docker: old source events/snapshots
are inert, current receipts survive, no duplicate native action.

Extend managed fixture spec to the same independent desktop/mobile helper,
positive cases for all four modes: cold open/shared startup, streaming join,
detach/reload, missed ack/gap, settings conflict, turn target/decision winner
where supported, accepted queue/reload. Count host instances/native transport
effects and inspect source/order/watermark preservation. Extend the existing
FixtureNativeState/audit output beyond dispatch/completion totals to retain
correlated command/source/decision/interrupt evidence; never infer affected
native target from a browser frame or a fake's invented conditional operation.
Provider integration
tests also drive production native adapters: fixture-only UI agreement cannot
replace those. Add native transport count assertions to existing host/proxy
tests, not a second production test RPC. Complete all matrix rows below.
```

- [ ] **Step 2: Red**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-pending-commands.test.ts --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage3 reload outcomes'`

Expected FAIL: unresolved command IDs disappear on full reload, leaving no query/settlement and risking a fresh send. Managed combined cases must fail old source/behavior when run against base; do not manufacture a failure when earlier tasks already make a new acceptance test green.

- [ ] **Step 3: Production patch and user documentation**

```text
pending-commands helper stores only bounded unresolved IDs/kinds and durable
locator in the existing browser storage namespace, scoped to this device.
Persist ID before first transport send. Settled canonical receipts prune it;
unknown/expired/store-unreadable retain a visible outcome and never auto-resend.
On attach/reload query up to 128 retained IDs through sync, follow canonical
aliases, and hydrate command UI after source adoption. Local storage failure is
visible before dispatch and cannot masquerade as durable pending tracking.
No draft/prompt/approval text is added to this ID store. Unsent drafts remain
local; queued payloads already accepted by server are recovered from authority.

Use one helper for managed/default independent-context tests. Default matrix
remains cloud legal; don't add the new spec to CLOUD_SKIP_SPECS or LOCAL_ONLY.
Managed fixtures stay explicitly local-only and execute via their supported
script. Use real received-frame drop/delay in the test-owned WebSocket wrapper,
native simulator release gates and fixture request logs; do not inject fabricated
browser events or production-only test controls. Include native protocol Cli
Claude rig against its local fake Anthropic endpoint in Rust integration, plus
Sim speed and Codex/OpenCode fixture transport, without live-provider credentials.

README describes close vs Terminate agent, shared settings conflict/retry,
shared accepted follow-ups vs local unsent draft and visible pending/unknown
outcomes. docs/index.html reflects major action/queue surfaces using nonfunctional
mock data only. No deployment/repair runbook is duplicated or newly invented.
```

- [ ] **Step 4: Green**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/lib/fresh-agent-pending-commands.test.ts --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts --grep 'stage3 reload outcomes'`

Run: `pnpm run test:runtime:fresh-agent-fixtures`

Expected PASS and positively executed cases for every mode. The managed script intentionally selects its repository-classified local-only backend; it does not replace the cloud default-path run.

- [ ] **Step 5: Refactor**

Remove duplicate browser receipt-recovery calls in favor of one attach/reconnect hook and bounded ID helper. Keep server command authority distinct from device-local query bookkeeping. Consolidate only the shared native audit/context setup, leaving provider assertions explicit.

- [ ] **Step 6: Complete impacted and integrated verification**

Run: `pnpm run contract:generate`

Run: `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='Freshagent multiple-device complete acceptance' pnpm run check`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts test/e2e-browser/specs/handoff-two-device-rust.spec.ts test/e2e-browser/specs/fresh-agent-control-rust.spec.ts test/e2e-browser/specs/fresh-agent-hidden-approval-reveal.spec.ts test/e2e-browser/specs/freshopencode-snapshot-409-recovery.spec.ts`

Run: `pnpm run test:runtime:fresh-agent-fixtures`

Run: `pnpm run test:sandbox "cargo test --locked -p freshell-ws --test freshagent_multiple_devices --test freshagent_claude_checkpointed_send --test freshagent_claude_observers --test cross_kind_liveness --test pane_reconcile"`

Expected PASS with full matrix evidence. Broad check includes cloud-excluded `test/integration/server/` through the standard harness's local companion; direct cloud selectors alone do not cover those files. Verify companion ran and `FRESHELL_VITEST_LOCAL_COMPANION=off` is absent. Shared core/protocol/provider changes impact the entire application, so the full supported suite is warranted. Record executed counts, provider/flavor, first-failure evidence and native audits under `test-results/`; a skip, zero-match, or filtered managed fixture is not acceptance. Investigate and fix flakiness rather than accept retries as a substitute. No live-provider qualification, production restart, deployment or PR is performed by this plan.

- [ ] **Step 7: Commit**

```bash
git add scripts/testing/runtime-sandbox.ts
git add src/lib/fresh-agent-pending-commands.ts src/components/fresh-agent/FreshAgentView.tsx src/lib/fresh-agent-ws.ts src/store/freshAgentSlice.ts test/unit/client/lib/fresh-agent-pending-commands.test.ts test/e2e-browser/helpers/fresh-agent-multiple-devices.ts test/e2e-browser/specs/fresh-agent-multiple-devices-rust.spec.ts test/e2e-browser/specs/runtime-fresh-agent-fixture-rust.spec.ts test/e2e-browser/helpers/managed-runtime.ts crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-server/src/fresh_agent_proxy_tests.rs crates/freshell-ws/tests/freshagent_multiple_devices.rs README.md docs/index.html
git commit -m "feat(freshagent): recover pending outcomes and verify independent device flows"
```

## Complete acceptance matrix

Each browser row runs two independent device contexts against one test-owned server/session, with the desktop/mobile options from Task 1 and distinct device IDs. `D` means default production adapter; `M` means optional managed route through its actual host/supervisor. All four modes are required for D and M, except native decisions that a provider explicitly does not support; those have asserted typed unsupported/zero-native-effect coverage. Managed fixture browser cases need corresponding native-adapter Rust/provider evidence; no paid/live qualification is implied.

| Required result | Tasks | Browser scenario and actual evidence | Rust/provider safety evidence |
| --- | --- | --- | --- |
| One runtime on simultaneous cold open | 4–5,16 | `stage2 cold open`, D four modes + M fixture; one native boot/bridge/host, same locator/owner | Gate first launch, two real sockets, owner ticket/lease and native count; OpenCode one daemon plus one session bridge |
| Streaming join during continuous output | 8–11,16 | `stage3 streaming join`, two cursors and unique native message rows while output continues; OpenCode joins ongoing text/reasoning before final replacement through a ready instance `/event` subscription | Atomic capture under unending producer, disk-lag overlay, exact snapshot watermark; OpenCode per-part start/delta/final and explicit reconnect/lag gaps; managed head/state interleaving |
| Close/cancel/reload/new/fork preserve other view | 1–3,16 | `stage1 close/cancellation/switches`, `stage3 reload outcomes`; peer continues, zero cleanup stop; explicit termination one shared stop | Scoped detach, canceled-result identity, provider-reported parent retirement; actual stop/submission audit |
| Suspension/offline/reconnect and finite refresh | 6–7,11,16 | `stage2 bounded refresh`, `stage3 gap reconnect`; offline+forced disconnect, unchanged snapshot success, held request timeout/Retry | Scheduler generation/abort, 15s fixed view deadline, stale/error/hang/supersession paths |
| Attach acknowledgment/failure requester isolation | 4,10 | `stage2 requester`; peer stream/error unaffected and no global replay | Running/idle/cold/malformed/reserved/failure sink assertions, hosted one poller |
| Shared recovery budget and owner refresh | 5–7 | `stage2 shared failure/stale authority`; one attempt per cohort, legal second view retains identity | Three real failures exhaust; observer/reconcile zero cost; full new epoch/generation; canceled waiter survives |
| Dead historical terminal binding repair/live exclusion | 3,5 | `stage1 dead binding`; send/configure work after shared reopen; live twin refuses | Production sink parked cancellation, unstamped/stamped rows, identity-only Keep settings, true live terminal zero extra launch |
| Missed ack/query and possible native delivery | 12,16 | `stage3 lost acknowledgment/reload outcomes`; stable command receipt/turn, native submit=1 | Admission/dispatch/native/receipt crash boundaries, compact expired/unreadable distinction, no new-ID resend |
| Replay gaps/duplicates/stale source or snapshot | 8–11,16 | `stage3 gap reconnect`; actual dropped/reordered server frames, converged cursor/text/controls | Contiguous fold, bounded ring/page/reset, source adoption, immutable chunk watermark, Codex inner revisions retained |
| Concurrent native sends and ordered effects | 12–13,15 | `stage3 settings/followups`; exact audited native request order/options/rows | Same-ID dedup; cross-WS/REST total admission and eligible dispatch order; preserve provider busy send/compact FIFO |
| Stale settings never revert newer defaults | 13,15 | `stage3 settings/followups`; both headers N+1, old edit conflict, queued send does not carry stale values | Native partial/uncertain configure outcome, effort null/absent, provider-specific effective settings at dispatch |
| Device-delayed interrupt cannot stop the server's new turn | 14 | `stage3 controls`; hold A control until server observes A settled/B current, then release; B continues on default and managed routes, zero native interrupt | Source/owner target checked under submission serialization immediately before adapter invocation, including admission waits/reissues; Codex native ID, Claude ledger and OpenCode generation; prestart/unknown targets and silent attention behavior |
| Atomic approval/question/elicitation winner | 14,16 | `stage3 controls`; one native response, shared resolution, harmless losing view | Pending->Dispatching before await, response digest/result, ambiguous crash, native source validation; unsupported OpenCode asserted |
| Accepted follow-ups survive submitter removal | 15–16 | `stage3 followups/reload outcomes`; shared order, no duplicate native send, cancel race | Persisted payload/order/proven turn prerequisite, unknown-settlement retention, settings resolved at dispatch, CAS cancel, once-only drain, queued reopen, bounded backpressure |
| Unsent drafts remain local | 2,15–16 | Type on A without Send: B sees no draft/queue/native call; A draft survives unrelated peer update | No draft in server payload/receipt logs; unknown accepted send never restored as safely unsent |
| Both legacy/default and managed paths stay valid | 1–16 | Cloud D spec positively executes four modes; separate M fixture script positively executes four modes | Legacy unwrapped parse/behavior, direct owner adapters and existing managed journal/operations, native audits on each path |

## Execution evidence and completion boundary

1. For each task record red command/result, green command/result, refactor, impacted suites and focused commit in the usual execution record when execution is later authorized. A precise patch draft may be corrected during implementation; source becomes authoritative after execution begins. Do not rewrite this plan's code blocks to mirror fixes.
2. Preserve first-failure traces/native audit rows needed to diagnose a run, and counts showing all selected providers/flavors actually executed. Use the standard coordinator and existing configured outputs. Do not put dependency/worktree copies in results. Stop task-owned background processes and remove disposable files after each run.
3. The original load-bearing pass and independent recheck historically ended FAILED/non-converged before implementation. Fresh Eyes round 1 and this remediation correct their overstrict native-atomicity requirement: Tasks 14–15 use the server-owned source/turn and settlement boundaries above. This is a viable implementation plan, not executed proof; normal Stop, stale rejection and accepted follow-ups must earn all required default/managed evidence. Preserve the immutable base record and the earlier failed baseline receipt; the required managed bootstrap repair does not erase that failure. If a different base is ever needed, establish its provenance and baseline separately rather than rewriting this run's `base_ref`.
4. Implementation completion requires every acceptance-matrix row and its necessary gates genuinely green with positive executed counts, no unresolved substantiated review finding, and a clean focused branch. Unrelated suite failures reproduced and enumerated at the immutable base may be reported separately, but cannot waive requested managed/default coverage or any acceptance row. The managed bootstrap compile repair and feature-enabled proxy tests are mandatory. A push or PR is outside this workflow unless separately requested; repository rules require explicit approval before PR creation. No merge, deployment, production restart, or live repair is authorized.
