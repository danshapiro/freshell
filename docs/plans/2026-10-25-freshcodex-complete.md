# Complete Freshcodex Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Make Freshcodex a complete, reliable implementation of the Freshagent experience, as good as or better than Freshclaude and Freshopencode, with additional support where essential Codex features require it.

### Explicit constraints
- Inspect the existing implementation patterns and choose the strongest applicable ones.
- Use the-usual workflow.
- Prefer GLM 5.3 through OpenCode as the independent reviewer if available; otherwise use GPT 6.1 Sol at xhigh.
- Work in a dedicated Git worktree, preserve other agents' work, and use the pinned pnpm version.
- Use red/green/refactor development and meaningful unit, integration, and browser verification; do not weaken or skip tests to obtain a pass.
- Do not deploy or restart production as part of this implementation.

### Accepted tradeoffs and residuals
- None.

**Goal:** A Freshcodex conversation can be created, controlled, observed live, restored, and automated through the same Freshagent surfaces as the other providers, while faithfully exposing essential native Codex planning, models, permissions, questions, and child activity.

**Architecture:** Extend the existing `FreshCodexState` and app-server adapter below the local/managed-host split. Keep native thread identity, ownership, handoff, history reads, fork, compaction, rollback, naming, shared transcript, settings, and typed REST lane; add a focused incremental transcript projection, identity-owned turn accounting, retained attention, native catalog probing, and faithful control normalization. Use the shared renderer and live-state isolation for Codex output rather than creating another provider runtime or view.

**Tech Stack:** Rust/Axum/Tokio, existing Codex WebSocket JSON-RPC client, React 18/Redux Toolkit/Zod/TypeScript, Vitest, Cargo, Playwright, deterministic fake app-server, and existing Docker managed-runtime/sandbox fixtures.

## Global Constraints

1. Execute in `/home/dan/code/freshell/.worktrees/freshcodex-complete` on `the-usual/freshcodex-complete`, created from verified base `b5f86817ce3a9a1907e90eda8924927a55e669d6`. The clean-origin full baseline and frozen pnpm 10.34.5 install passed; the coordinator recorded them in `/home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/reports/workspace-receipt.md`. This committed source plan is canonical; the external draft is historical planning evidence. Implementation begins only after formal load-bearing validation and the requested independent plan review. Revalidate affected references if the approved base changes.
2. Node 22, pnpm **10.34.5**, Rust/Cargo 1.96.0; use locked Cargo commands. Relative TypeScript imports use `.js`. Supported essential native target is Codex **0.164.0**. Task 1 first proves that binary and then aligns the managed Codex pin in `docker/runtime/provider-versions.json` and `docker/runtime/Dockerfile` from 0.147.0 to 0.164.0 on this branch; other provider pins stay unchanged. This is build preparation, not deployment. Test artifact staging leaves root dependencies/lock/workspaces, root `.bin`, host production PATH and global installed CLI unchanged. Preserve unrelated branches/worktrees, especially the foreign Codex lifecycle worktree.
3. Configured Vitest and browser backends are both `cloud`. Use the supported entrypoints, `GCLOUD_ROBOT_REQUIRE=1`, and the configured robot identity; no fallback to a local backend to bypass infrastructure failures. `FRESHELL_RUST_TEST_SANDBOX=1` is mandatory on broad `check`/Rust/source-runtime runs. All focused Cargo checks below use the run-owned `run-focused-rust.py` helper, which invokes `scripts/sandbox-test.sh --runtime-suite` with owner guard, owned executable/runtime temp directories, the worktree-specific target path and bounded workers. `--build-server` rebuilds the correct test server before WS/server integration. Never kill a foreign coordinator holder. Follow `docs/development/test-sandbox.md` and `docs/development/pre-push-gate.md`.
4. No deployment, client build into main's `dist/client`, production restart, live-host mutation, global configuration edit, or real-home corpus mount. Feature tests use controlled provider fixtures; the requested independent reviews use the selected reviewer model. Scratch servers belong to the test fixtures and their owned temporary homes/ports. Keep the live port 3001 process untouched.
5. Every task follows red/green/refactor, runs the impacted behavior set, and makes a focused commit. Tests must execute the protected behavior. Do not skip/weaken tests or add source/prose/hash assertions. If an old static-copy assertion blocks an intentional behavior change, remove that assertion and replace its useful intent with behavior coverage.
6. Keep the native `thread/read { includeTurns:true }` full-history compatibility path for this change. Installed 0.164.0 still hydrates full turns; there is no demonstrated truncation requiring pagination. Preserve paginated **thread history mode** for native undo; that is a separate concern from fetching history in pages. Codex redo remains explicitly unsupported, and conversation undo does not edit files.
7. Preserve every existing ownership lease, epoch/generation fence, accepted-before-completion emission barrier, fork cleanup token, durable checkpoint boundary, crash-resume/supersession path, native saved-name authority, and side-effect-free untracked snapshot read. New snapshot/projection work must never spawn/resume a provider for GET.
8. Use structured tracing with provider/session/native-turn/native-item/request IDs and severity for protocol/recovery failures. Never log secret answer values, credentials, full control payloads containing secrets, or uploaded image data. Unsupported native subtypes get one explicit provider response plus a useful typed notice, never an indefinitely pending request.
9. New behavior stays on the feature branch. Commit and push are allowed; PR creation, merge, and worktree cleanup await this change's explicit user approval. Follow the requested independent-review provider selection; configured first choice is `lunaroute/glm-5.3` through the trusted OpenCode transport, with actual generation availability established by the review. The fallback is exactly `openai/gpt-6.1-sol` with reviewer `variant:xhigh`, not the workflow's older GPT default.

---

## Verified starting points and scope decisions

The original explorer reports plus `load-bearing-finder-preliminary.md`, `load-bearing-strategist-preliminary.md`, the parent preliminary ledger and `reports/native-artifact-metadata.md` are preliminary planning evidence, not executed native proof or formal-stage completion. The final explorer reports under `.worktrees/.the-usual-logs/freshcodex-complete/reports/` and bounded source reads are the evidence for this plan, including the separate existing-branch pattern check and official native-artifact metadata report. The installed experimental-inclusive native protocol is `/tmp/freshcodex-schema-simy2pdx`, Codex 0.164.0. The checked-in 0.129.0 inventory is stale evidence, not the runtime authority. Exact wire shapes should be represented by behavior fixtures and parsed in the adapter; do not generate a new all-RPC SDK for this task.

| Shared Freshagent surface | Freshcodex disposition and proof |
| --- | --- |
| Pane picker, create, saved-history resume, reload, recovery | Preserve current create dedup/native identity/ownership and prove two panes plus reload in Tasks 2, 4, 10. |
| Live answer, reasoning, tools, retry/error, usage, plan and diff | Repair native notification projection and snapshot convergence in Task 2. |
| `/new`, `/compact`, `/fork`, `/model`, `/undo` | Keep existing implementations; native compact takes only `threadId`, native fork/checkpoints remain intact; exercise in Tasks 7–10. |
| `/redo` and provider session-command menus | Keep honest Codex undo-only refusal and existing capability-filtered menu. Do not advertise arbitrary native RPCs as slash commands. |
| Model/thinking, approval policy, workspace/cwd | Native catalog and faithful values in Tasks 7–8. |
| Style/font and shared pane preferences | Existing provider-independent preferences remain; run the shared settings tests. |
| File access and planning | Add separate Codex File access and Work mode controls in Task 8. Plan/default is native `collaborationMode`, separate from approval and sandbox. |
| Approvals, questions, Stop, waiting/stuck, reconnect attention | Repair and extend the existing controls in Tasks 4–6, including genuinely blocking versus nonblocking questions. |
| Child activity and open-child action | Map current items and observe the exact child through its fenced parent provider context in Task 3; no child writer. |
| Images, shell escape, file checkpoints, names, handoff | Existing implementation retained and included in Task 10 regressions; image sending already exists. No new media-serving service. |
| CLI/MCP new/split/send/capture/wait/names | Implement Codex on existing `FreshAgentRestLane` in Task 9; preserve terminal `mode=codex` and its raw-resume validation. |
| Local and managed hosted provider | Same provider state remains below the split. All production paths receive the same behavior; hosted Docker proof is in Task 10. |
| Configured MCP elicitation | Ordinary flat primitive/enum form, `openai/form`/`openaiForm` equivalent flat schema, and URL confirmation are supported in Task 5. Complex forms and device-proof verification receive bounded explanatory refusal; no auth-proof impersonation or arbitrary form framework. |
| Audio/realtime, cloud-agent administration, remote environments, dynamic client tools, marketplace/account/auth administration | No existing shared Freshagent affordance requires these native APIs; not part of Freshagent parity. Native CLI owns its configured authentication. |

The Plan choice is included deliberately: Codex's native collaboration-mode contract is absent from today's start-turn adapter, and the shared Claude pane already exposes a planning workflow. A normal text instruction is insufficient to claim Codex Plan mode. Selecting Plan sends `{ mode:'plan', settings:{ model, reasoning_effort, developer_instructions:null } }`; selecting Build sends the corresponding `default` mode. Both use the actual selected model/effort, because native collaboration settings override the parallel fields. No claim that Plan itself enforces file permissions: the separate sandbox choice remains authoritative for that.

## File responsibilities and task interfaces

Line numbers below locate the inspected base; use symbol names after earlier tasks change offsets. New files are scoped helpers, not replacements for the existing runtime.

| Owner | Production files and one responsibility |
| --- | --- |
| Task 1 | New `scripts/testing/prepare-codex-contract.mjs`, `test/fixtures/coding-cli/codex-native-artifact.json`, `test/integration/providers/codex-local-provider.mjs`, `codex-cli-contract.mjs`, `codex-cli-contract.test.ts`: staged real-native evidence and early decision gates. `docker/cloud-run/Dockerfile`: test-only native artifact layer. `docker/runtime/provider-versions.json`, `docker/runtime/Dockerfile`, `scripts/testing/runtime-sandbox.ts`: managed Codex version alignment and truthful runtime receipts. |
| Task 2 | `crates/freshell-freshagent/src/codex/projection.rs` (new): current native turn/item projection and incremental patch production. `codex.rs:7532,7849,9214,9520`: consume/overlay through existing session/snapshot/mapper. `shared/fresh-agent-contract.ts`: additive normalized patch and measured usage contracts. `src/store/freshAgentLiveTypes.ts`, `src/store/freshAgentLiveSlice.ts`: isolated normalized live rows/patches. `src/lib/fresh-agent-ws.ts`, new `src/lib/fresh-agent-transcript-projection.ts`, `FreshAgentView.tsx`: validate/apply/reconcile/render shared rows. `FreshAgentSidebar.tsx` displays the latest native plan, and `FreshAgentDiffPanel.tsx` can render supplied native unified diffs. Existing context-usage helpers render observed usage. |
| Task 3 | New `codex/children.rs` and `FreshAgentChildObserver.tsx`: parent-scoped read-only child access. `codex.rs:9214`, `codex/metadata.rs`: current native item/child mapping. `shared/fresh-agent-contract.ts`: narrow item metadata additions if existing tool/delegation variants cannot represent a native fact. `FreshAgentItemCard.tsx`, `FreshAgentSidebar.tsx`, `FreshAgentView.tsx`: honest outcomes and provider-correct child action. |
| Task 4 | New `codex/turn_state.rs` plus `codex.rs:3348,3500,4039,10442`: identity-owned dispatch/turn/Stop transitions; keep existing reducer and emission fences. `FreshAgentView.tsx` send-failure restoration: correlate refused Codex sends and preserve composer text. |
| Task 5 | `codex/controls.rs`, its `tests.rs`, new `codex/elicitation.rs`: preserve native control meaning and normalize bounded MCP forms. `shared/fresh-agent-contract.ts`, `shared/ws-protocol.ts`, `crates/freshell-protocol/src/client_messages.rs`, `src/store/freshAgentTypes.ts`, `freshAgentSlice.ts`, `fresh-agent-ws.ts`: additive control metadata/answer values only where these existing contracts carry controls. `FreshAgentQuestionBanner.tsx`, `FreshAgentApprovalBanner.tsx`, `FreshAgentApprovalCard.tsx`, new `FreshAgentElicitationBanner.tsx`, `FreshAgentView.tsx`: accessible native decisions/questions/forms/URL confirmation. |
| Task 6 | `codex.rs`, `codex/controls.rs`, `crates/freshell-ws/src/lib.rs:659`, `providers/fresh_agent.rs`, `host_actor.rs`, gateway proxy and client reset handler: retain provider state before lossy bridge, independently drain after loss and combine replay marks. Reuse `attention_ledger.rs` unchanged unless a provider-neutral visibility adjustment is required. |
| Task 7 | `crates/freshell-codex/src/app_server.rs`, `model.rs`, new `catalog.rs`, its `lib.rs` exports; `crates/freshell-freshagent/src/model_capabilities.rs`; server/session-host catalog wiring; `shared/fresh-agent-models.ts`, `shared/fresh-agent-model-capabilities.ts`, `src/lib/fresh-agent-model-capabilities.ts`, registry, model dialog: installed catalog and faithful model/effort choices. |
| Task 8 | `StartTurnParams` and serializer, Rust fresh-agent create/send/configure types, `codex.rs` and new `codex/settings.rs`; `shared/fresh-agent-contract.ts`, `shared/settings.ts`, `shared/ws-protocol.ts`, `src/store/paneTypes.ts`, persistence normalizers, create-content helper, shared registry/settings button/view: apply/persist full settings and native Plan/default. |
| Task 9 | New `codex_rest_lane.rs`; `codex.rs` typed create/send outcomes and per-turn settlement subscription; `rest_lane.rs`, `lib.rs:2579`, `pane_ops.rs`, `crates/freshell-server/src/main.rs`; CLI/MCP capabilities and request parsers: adapter from existing automation into the same runtime. |
| Task 10 | Existing native fake fixture; Task 1 native harness for final regression; cloud-legal browser specs; managed-provider parity integration; `README.md` and `docs/index.html`: production proof and user-facing behavior documentation. No deployment runbook changes. |

The current provider event stream is intentionally provider-native below the shared event envelope; the patch protocol is an additive normalized rendering path, not a new provider runtime. Existing client state files are `src/store/freshAgentTypes.ts`, `freshAgentSlice.ts`, `freshAgentLiveTypes.ts`, and `freshAgentLiveSlice.ts`; approval files are `FreshAgentApprovalBanner.tsx` and `FreshAgentApprovalCard.tsx`. All new helper names/signatures below are defined by this plan.

## Source authority and early decision gates

Task 1 is a real native/runtime version deliverable, not scaffolding to postpone evidence. It must execute the decisive native captures before Tasks 2–9 depend on them. The preliminary reports ran no native turns, so their shape/configuration observations are not passes. If a required capture fails, inspect exact-version native source/configuration and sanitized native errors, fix the owned fixture or narrowly supported configuration, and rerun. Do not proceed with an assumption merely because application tests can inject the expected RPC frames. F1/F2/F3/F4/F6/F7 retain separately attributable receipts even when one capture supplies several results.

The following conservative projection design removes any dependency on a native-history/application-event shared watermark:

1. `CodexProjection` retains event-owned active/unlanded native items, latest usage, plan and turn diff inside the existing owned session incarnation. Native full history remains the source of historical bodies. Normalize both using `build_codex_turn_json`/`map_codex_item`; keep existing row IDs, role segmentation, unique user nativeTurnId and checkpoint rules.
2. `freshAgent.transcript.patch` remains the one additive shared event. `{sessionId,projectionId,historyGeneration,ops}` carries safe-integer **consumed-event revisions only**. Ops are `resetTurn {nativeTurnId,turns}`, `upsertItem {nativeTurnId,row,item}`, `appendItem {nativeTurnId,rowId,itemId,field:'text'|'output'|'summary'|'content',index?,text}`, `settleTurn {nativeTurnId}`. Each op has a revision. Appends are admitted only for an event-owned item opened under the current native turn/operation and source generation; a late item/turn event cannot open an arbitrary historical turn. `resetTurn` with no rows removes a live group after accepted history mutation.
3. Append operations contain O(delta) bytes and mutate retained strings in place. Coalesce adjacent same-item/field/index appends for at most 33 ms; flush before item replacement/lifecycle/control/notice/teardown. Only structural row changes and item starts/completions carry full normalized state. Compare emitted byte growth for 1,000/2,000 equal deltas and assert exact content plus approximately linear growth.
4. Projection incarnation authority remains the existing runtime-owner epoch/generation and client snapshot-request binding generation. Introduce projectionId through authoritative create/attach/init; do not adopt a new incarnation from an arbitrary patch or UUID ordering. Rebind/materialization uses current aliases. Capture source and historyGeneration when starting a read; recheck after return. A read begun before accepted undo/compaction or source replacement is rejected and retried through the existing bounded scheduler, even if its native response arrives later.
5. A tracked snapshot combines explicitly distinct sources. Historical/final native bodies replace complete rows **atomically**. The retained event-owned active body is included at its captured eventRevision. An independently read incomplete native body is never an append baseline: when no safe event baseline exists after recovery, show it as a nonappendable native preview until a demonstrated native full replacement or new item-start baseline arrives. Task 1 must prove this eventually converges. Full `item/completed` event bodies replace their items, never concatenate them with native reads. A native terminal body supersedes event-owned state only when it contains the final items/error, or retain the completed event body until native history agrees; terminal status alone cannot erase content.
6. Snapshot metadata is `extensions.codex.projection = {id,eventRevision,historyGeneration,eventOwnedTurnIds,nativePreviewTurnIds,nativeFinalTurnIds}` with completed-item identities scoped by native turn. eventRevision describes **only the event-owned portion** captured in that snapshot. Client replays newer event ops only against that portion; a complete native item/turn replacement fences appends for that exact identity even when those queued ops have larger revisions. No native body is stamped as if it consumed a known notification prefix. Final/history membership derives from retained exact history and the current operation/source generation, never an evictable eight-entry convenience set. The existing eight-ended-turn cache may still deduplicate attention; it does not establish transcript finality or mutation membership.
7. Undo uses existing serialized native revert/rollback-record membership; removed identities cannot be recreated by late output. Compaction fences reads and replaces exactly the history native actually supplies; do not assume it deletes historical transcript rows. Mutation invalidation lasts for that history/source generation and existing durable rollback membership, not until an unrelated larger eventRevision. Fork keeps the existing identity/ownership transition and distinct child incarnation.
8. `mergeFreshAgentTranscriptProjection(snapshot,live)` preserves chronological positions and other turns while replacing event-owned groups and applying only permitted newer operations. Final live content retires when its exact native final content lands. Retain an honest diagnostic final/preview state if settlement needs recovery; never silently drop unlanded visible output. Hidden panes keep isolated live state without focus changes/per-token polling; reveal uses the existing dirty scheduler. A patch gap, `freshAgent.host.backpressure`, or `freshAgent.host.journal.reset` marks the source dirty and coalesces a resnapshot of authoritative provider-retained state. Reconnect/reload use native history plus retained event state and silent attention seeding.

### Task 1: Prove the native 0.164 contract and align the managed Codex runtime

**Files:**
- Create: `scripts/testing/prepare-codex-contract.mjs`; `test/fixtures/coding-cli/codex-native-artifact.json`; `test/integration/providers/codex-local-provider.mjs`; `test/integration/providers/codex-cli-contract.mjs`; `test/integration/providers/codex-cli-contract.test.ts`.
- Modify: `docker/cloud-run/Dockerfile`; `docker/runtime/provider-versions.json`; `docker/runtime/Dockerfile`; `scripts/testing/runtime-sandbox.ts` (Codex version receipt reads the pin instead of stale literal).
- Test: new native contract test and standalone offline contract runner; actual managed image native receipt using the existing owned `RuntimeSandbox` image preparation in `scripts/testing/runtime-sandbox.ts`.

**Interfaces:**
- Produces: `prepare-codex-contract.mjs --output ABS` for connected verified artifact preparation and `--sandbox` to stage the completed artifact in the existing executable volume before any offline invocation. `--stage-prepared` copies only a verified prepared entry; it does not download. The helper writes `.runtime-build/codex-contract/staged.json` with the owned sandbox artifact path and integrity for the standalone runner. Cloud tests receive `FRESHELL_CODEX_CONTRACT_ROOT=/opt/freshell-test-providers/codex/0.164.0-linux-x64` from their test image. Neither runtime path fetches packages or falls back to PATH.
- Produces: `captureNativeScenario(name,options) -> Promise<NativeCapture>` in the native harness, with `{binary:{path,version,platform,integrity},threadId,requests,responses,notifications,reads,fixtureTraffic,observations}`. Scenario names are `text-history`, `active-input-stop`, `parent-child-read`, `plan-question-controls`, `mcp-form-url`, `model-effort-usage`; each has bounded deadlines and sanitized raw evidence. CLI `--scenario all --receipt-dir ABS` runs all; `--managed-runtime --receipt-dir ABS` prepares the existing run-owned managed image then runs the same real-native scenarios inside it with the image's intended `/usr/local/bin/codex`.
- Produces: claim-specific native receipts for F1/F2/F3/F4/F6/F7, selected actual feature/configuration flags/tool schemas and observed behavior used by later fixture expectations. No new universal protocol SDK, packaging framework, native lifecycle controller or production installation.

- [ ] **Step 1: Add the failing behavioral contract and minimal executable harness**

Use the existing Claude contract style as a fixture pattern, but implement Codex Responses/MCP exchanges from exact native evidence. Preserve raw request/response/native-ID ordering. A representative actual native contract assertion is:

```ts
it('retains the actual final answer through exact history and resume', async () => {
  const capture = await captureNativeScenario('text-history', { timeoutMs: 120_000 })
  expect(capture.binary.version).toBe('0.164.0')
  const text = capture.observations.finalAssistantText
  expect(text).toBe('First fragment and final fragment')
  expect(capture.observations.resumedAssistantText).toBe(text)
  expect(capture.notifications.some(frame => frame.method === 'item/agentMessage/delta')).toBe(true)
  expect(capture.fixtureTraffic.every(request => request.loopback === true)).toBe(true)
})
```

`finalAssistantText`/`resumedAssistantText` are derived from captured native thread/read bodies by native item ID, not injected normalized snapshots. Minimal fixture code and staging helper belong in this step so missing imports/prerequisites are fixed before the intended red run. Before changing the managed pin, run its actual binary receipt: the current runtime supplies 0.147.0, so the required 0.164.0 native-version assertion fails for the intended reason. No static version-string test substitutes for executing that runtime binary.

- [ ] **Step 2: Stage before offline entry and establish intended red evidence**

Known Linux x64 artifact metadata is exact: URL `https://registry.npmjs.org/@openai/codex/-/codex-0.164.0-linux-x64.tgz`, integrity `sha512-XLAoaWsGOT2khzl+P4FYDPTkzAr9W0VFXFaVkqlFdkM0soa1gH/4S0wSD57Ek3HHwkirAEGz2/Mwehseh+l5Mg==`, installed executable `vendor/x86_64-unknown-linux-musl/bin/codex`, unpacked package 444,349,626 bytes. Pin these in the test artifact JSON, verify downloaded bytes/manifest/actual layout and publish an atomic completed directory. Use a connected owned `.runtime-build/codex-contract` stage; the archive plus unpacked artifact must never occupy the 512 MiB `/tmp` or 256 MiB `.cache` runtime tmpfs together. `--sandbox` copies the verified artifact into a unique run/worktree subdirectory of the existing `freshell-sandbox-cargo-target` volume at `/freshell-test-artifacts`, using an owned container and the existing sandbox wrapper. Staging occurs before `--network none`; the offline harness only reads staged bytes and writes its owned home/receipts.

Run: `node scripts/testing/prepare-codex-contract.mjs --sandbox`.

Run: `node test/integration/providers/codex-cli-contract.mjs --managed-runtime --receipt-dir .runtime-build/codex-contract/managed-red`.

Expected: staging succeeds, with actual byte/integrity/layout receipt; managed required-version assertion FAILS on current 0.147.0. If staging/harness setup fails first, repair it and rerun so the red result is behavioral. These are future implementation actions after formal validation and independent plan review; no native execution occurred during plan publication.

- [ ] **Step 3: Prove the isolated native flows, then align the managed pin**

In `docker/cloud-run/Dockerfile`, after the connected node-builder copies source, run the preparer with `--output /opt/freshell-test-providers/codex/0.164.0-linux-x64`; copy that completed directory into the final test image and set the contract-root env above. In ordinary contract execution, missing/corrupt artifact is a loud prerequisite failure; never attempt a network package bootstrap inside offline runtime. Compare ambient `codex` resolution as a present-or-absent value before/after artifact preparation, not an assumption it exists in the cloud image. Root deps/lock/workspaces/.bin and host production CLI stay unchanged. Linux x64 is the required executing platform for these lanes; metadata for six published platforms is not execution proof. Add another platform receipt only when that actual compatible host executes the contract.

Run the real 0.164 binary with owned HOME/CODEX_HOME/XDG/workspace, no inherited credentials/proxies, an owned loopback Responses endpoint and a local configured MCP server. Inspect exact-version native source/configuration and advertised tools first; determine necessary initialization capabilities/feature flags from actual evidence. Never infer working Plan/MCP/collaboration setup from schema spelling alone. The fixture selects tool calls from the names/schema actually advertised by that binary. No external model endpoint is called.

**Hard early native gate, before dependent production implementation:**

1. F1: capture native active read while streaming, final item/turn and exact full-history read, plus same-thread resume of interrupted/active history. Establish eventual complete final bodies and a recovery policy that converges from a nonappendable native preview without guessing a delta offset. Record native read-ahead/behind observations; application revisions make no stronger native ordering claim.
2. F2: idle acceptance, active accepted input or explicit refusal, actual same native turn IDs for steering, response versus turn-terminal ordering, Stop while initial acceptance is pending, interrupt acknowledgement versus actual terminal/error/death evidence. If explicit `turn/steer expectedTurnId` is the demonstrated safer mechanism, select that narrow implementation and record it; do not invent an extra turn or replay ambiguity.
3. F3: create one actual native child and observe it through the parent's running context during activity and after completion. Record zero Freshell child-start/resume calls. Prove either exact parent-client read or exact provider-owned saved history with honest pending/saved status and final convergence. No child release is inferred from completed activity. If no supported observer source supplies that view, stop Task 3 implementation until the read mechanism is demonstrated.
4. F7: actual Plan setup/tool exposure, blocking/nonblocking questions and resolution/cancellation lifetime, command/network/stdin approval alternatives and request/response IDs, configured MCP flat form and URL elicitation, selected model/effort, and usage semantics. Capture final history and native responses for each. If last.totalTokens is not demonstrated current context occupancy, display it as Latest usage from the native last sample and leave context utilization unknown.
5. F6: execute the staged binary from both assembled cloud test image and offline sandbox, record its actual path/version/integrity and fixture-only traffic. Metadata or a local global CLI pass is insufficient.

Run: `scripts/sandbox-test.sh --runtime-suite "node test/integration/providers/codex-cli-contract.mjs --scenario all --receipt-dir /freshell-test-artifacts/codex-contract-early-receipts"`.

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/integration/providers/codex-cli-contract.test.ts --config config/vitest/vitest.config.ts`.

Expected: actual pinned-native captures PASS in both required environments. Shared executions may supply several receipts but retain separate F1/F2/F3/F6/F7 conclusions. If one fails, diagnose/fix the fixture using native source/errors or select a demonstrated supported configuration and rerun; a fake app-server frame, skipped scenario, silent backend change or unexecuted platform declaration cannot replace it. Unavailable necessary execution remains a failed early gate; dependent features do not proceed on an invented guarantee.

Only after that native gate, set Codex version to `0.164.0` in `docker/runtime/provider-versions.json` and `ARG CODEX_VERSION=0.164.0` in `docker/runtime/Dockerfile`. Preserve the existing install/version verification and every other provider pin. Make `scripts/testing/runtime-sandbox.ts` derive its Codex receipt version from the manifest instead of stale 0.147.0. Build the existing run-owned managed test image, execute its version and the essential native scenarios there, and retain separate F4 image/native receipts. No image is deployed and no live service is restarted.

- [ ] **Step 4: Confirm green native/runtime evidence**

Run: `node test/integration/providers/codex-cli-contract.mjs --managed-runtime --receipt-dir .runtime-build/codex-contract/managed-green`.

Run the exact sandbox and configured cloud native commands from Step 3. Expected: PASS; test artifact and managed runtime both actually execute Codex 0.164.0 with the essential captured contract. Reuse content-identical capture receipts instead of repeating expensive scenarios when nothing changed; changed pin/image must have its own actual binary receipt.

- [ ] **Step 5: Refactor while green**

Consolidate only the Codex fixture's owned process/deadline/cleanup and sanitized trace helpers. Keep artifact preparation outside offline execution and use one pinned metadata source. Do not move the wrapper into root dependencies or create a cross-platform package manager. Use real captured shapes to refine the existing fake fixture in each later feature task.

- [ ] **Step 6: Verify impacts**

Run: `pnpm run typecheck`.

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/integration/providers/codex-cli-contract.test.ts --config config/vitest/vitest.config.ts`.

Run: `node test/integration/providers/codex-cli-contract.mjs --managed-runtime --receipt-dir .runtime-build/codex-contract/managed-final`.

Expected: PASS with nonzero native scenarios and owned runtime-image receipts. Record image digest, executing architecture and exact provider versions. Final full-suite/hosted/browser evidence remains in Task 10; fixture parity alone does not prove the upgraded managed binary.

- [ ] **Step 7: Commit**

```bash
git add scripts/testing/prepare-codex-contract.mjs test/fixtures/coding-cli/codex-native-artifact.json test/integration/providers/codex-local-provider.mjs test/integration/providers/codex-cli-contract.mjs test/integration/providers/codex-cli-contract.test.ts docker/cloud-run/Dockerfile docker/runtime/provider-versions.json docker/runtime/Dockerfile scripts/testing/runtime-sandbox.ts
git commit -m "feat(codex): establish verified 0.164 native runtime contract"
```

### Task 2: Show native streaming, tool progress, usage, plan and diff without transcript duplication

**Files:**
- Create: `crates/freshell-freshagent/src/codex/projection.rs`.
- Create: `src/lib/fresh-agent-transcript-projection.ts`.
- Modify: `crates/freshell-freshagent/src/codex.rs:7532,7849,9520`.
- Modify: `shared/fresh-agent-contract.ts`; `src/store/freshAgentLiveTypes.ts`; `src/store/freshAgentLiveSlice.ts`; `src/lib/fresh-agent-ws.ts`; `src/components/fresh-agent/FreshAgentView.tsx`; `src/components/fresh-agent/FreshAgentSidebar.tsx`; `src/components/fresh-agent/FreshAgentDiffPanel.tsx`; `src/lib/fresh-agent-context-usage.ts`.
- Test: new `test/unit/client/lib/fresh-agent-transcript-projection.test.ts`; existing `test/unit/client/lib/fresh-agent-context-usage.test.ts`; existing Freshagent WS/live-slice/view tests; new `test/unit/client/components/fresh-agent/FreshAgentSidebar.test.tsx`; existing `test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx`; embedded `codex::projection::tests` and consumer tests.

**Interfaces:**
- Consumes: Task 1 actual native captures and source-authority decision; `CodexNotification::Other { method, params }`, existing mapper/builder and `FreshAgentEvent { provider,session_type,session_id,event }`. The Task 1 F1/F7 gate must pass before this production implementation.
- Produces: `CodexProjection::new(projection_id:String, thread_id:String)`, `apply(&mut self, method:&str, params:&Value) -> Result<Vec<Value>, ProjectionError>`, `begin_history_read(&self) -> SnapshotReadFence`, `accept_native_history(&mut self, raw:&Value, read_fence:&SnapshotReadFence) -> Result<ProjectionSnapshot,SnapshotStale>`; normalized incremental patch contract above. `SnapshotReadFence` carries projectionId, existing owner epoch/generation and historyGeneration. `ProjectionSnapshot` carries the chosen raw bodies, eventRevision and explicit event-owned/native-preview/native-final memberships described above. `SnapshotStale` requests one bounded reread after source/mutation change. `ProjectionError` includes native method and IDs, never full secret-bearing payload.
- Produces: `FreshAgentTranscriptPatchSchema`; `applyFreshAgentTranscriptPatch(state,patch)` and `mergeFreshAgentTranscriptProjection(snapshot,live)` using existing `FreshAgentTurn`/item types. Live payload remains outside the general session slice.

- [ ] **Step 1: Write failing behavioral tests**

In the new Rust module's tests, use native frames, not already normalized output. This representative test defines the projection seam; `snapshot_rows()` is the helper returning `build_codex_turn_json` over the projection's raw turn, implemented in that module so it exercises the real mapper:

```rust
#[test]
fn native_text_delta_then_full_item_is_one_exact_item() {
    let mut p = CodexProjection::new("runtime-1".into(), "thread-1".into());
    p.apply("item/started", &json!({
        "threadId":"thread-1","turnId":"turn-1",
        "item":{"type":"agentMessage","id":"answer-1","text":""}
    })).unwrap();
    let ops = p.apply("item/agentMessage/delta", &json!({
        "threadId":"thread-1","turnId":"turn-1","itemId":"answer-1","delta":"Hel"
    })).unwrap();
    assert!(ops.iter().any(|op| op["text"] == "Hel"));
    p.apply("item/agentMessage/delta", &json!({
        "threadId":"thread-1","turnId":"turn-1","itemId":"answer-1","delta":"lo"
    })).unwrap();
    p.apply("item/completed", &json!({
        "threadId":"thread-1","turnId":"turn-1",
        "item":{"type":"agentMessage","id":"answer-1","text":"Hello"}
    })).unwrap();
    let rows = p.snapshot_rows("turn-1").unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["items"], json!([{"id":"answer-1","kind":"text","text":"Hello"}]));
    assert!(p.apply("item/agentMessage/delta", &json!({
        "threadId":"other","turnId":"turn-1","itemId":"answer-1","delta":"leak"
    })).unwrap().is_empty());
}
```

Also drive native frames through `insert_fake_session_with_real_consumer`, not only the pure helper. Before completion, assert the broadcast contains usable text and command-output appends. Send two interleaved threads, multiple items, reasoning summary/content indices, fragmented Unicode strings, patchUpdated file changes, MCP progress, a retry/error, and turn end. Assert final snapshot equals complete native history once, failures remain failures, and no old-turn event retires or overwrites the newer turn. Verify native usage `{ last,total,modelContextWindow }`: cumulative total is not last, cached/reasoning subsets are not counted twice, no fabricated money, and unavailable differs from measured zero. Plan/diff updates replace previous aggregate values.

Drive the real patch reducer and merge helper through both independent-reader schedules. Event start plus `Hel` is event-owned; a native active read ahead at `Hello` must not become its append baseline, and the later `lo` yields `Hello` once. A native active read behind at empty must not erase `Hel`. When native full final `Hello` arrives before a queued larger-revision `lo`, final replacement fences that append. After more than eight later turns, a delayed old delta still cannot reopen the final turn. Recovery partial `prefix` is a nonappendable native preview; full item replacement/new safe start converges using the mechanism Task 1 actually proved. Hold a read across accepted undo/compaction and source replacement: old response is rejected by its source/history generation, not accepted because a larger event counter exists. Repeat event-owned snapshot revision 1 versus later append revision 2, full-item completion before/after native read, row split, hidden/reveal, disconnect/refetch and host reset/backpressure. Render through `FreshAgentTranscript`, not object comparisons alone.

- [ ] **Step 2: Run and confirm intended failures**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py -p freshell-freshagent codex::projection`.

Run: `pnpm run test:vitest run test/unit/client/lib/fresh-agent-transcript-projection.test.ts --config config/vitest/vitest.config.ts`.

Expected: missing projection/event behavior, followed by explicit assertion failures when the minimal types exist; do not count an unresolved import as the final red receipt.

- [ ] **Step 3: Implement the projection and existing transport integration**

Add the module and session-owned state at all create/resume/recovery construction sites. `apply` validates thread/turn/item identity, updates only its owned raw records, and emits the incremental operations above. The core append operation is:

```rust
fn append_string(target: &mut Value, field: &str, delta: &str) {
    // The caller has validated the native item/field type. Mutate the owned
    // String so token arrival does not repeatedly copy the full answer.
    match target.get_mut(field) {
        Some(Value::String(text)) => text.push_str(delta),
        _ => target[field] = Value::String(delta.to_owned()),
    }
}
```

Use native-indexed arrays for reasoning, whole replacements for `turn/plan/updated`, `turn/diff/updated`, and file patches, and item replacement for `item/completed`. Do not append aggregate diffs or full final text. The emitted delta carries only `delta`, even though the retained raw item accumulates content; reserve item upsert/reset for boundaries. No unsupported native method should crash the consumer; log unknown method once per method/incarnation at debug severity, with no payload dumping. Project provider retry/error notices using existing `freshAgent.retry`/`freshAgent.notice`; terminal failed-turn status/error remains owned by existing lifecycle handling.

For usage, preserve raw native `last/total` and context window in `extensions.codex` and populate shared tokenUsage from native `total`. Add an optional shared `observed` boolean (absent remains backward compatible), set it only after an actual notification, and display unknown until then. Preserve native `last.totalTokens` as the measured native last sample without adding cached/reasoning subsets. Use it as current context occupancy only if Task 1 captured semantics establish that meaning; otherwise label it Latest usage and leave utilization unknown. Add optional shared `modelContextWindow`; enable a Codex model-window fallback in the existing context helper/view only for the demonstrated numerator meaning; label that denominator as model context limit, never as an invented compaction threshold. Preserve existing indexed compaction-threshold usage where actually measured, and leave unknown until both native numerator/denominator exist. Do not report cumulative lifetime input as current context. Latest plan steps and explanation live in `extensions.codex.plan` and render a small Plan section in the existing `FreshAgentSidebar` with pending/in-progress/completed statuses; there is no pre-existing generic plan panel to assume. Unified native turn diff is retained in projection and exposed as `FreshAgentDiffSummary.diff?:string` on a stable turn diff entry with title `Turn changes`. Extend the existing `FreshAgentDiffPanel` to display a supplied diff directly and use the current cwd/path fetch only when no provider diff was supplied; later native replacements update expanded content without appending or fetching an unrelated current git diff. Preserve native per-file change diff for approval previews. Tests expand actual supplied/updated diff content and verify no cwd/path fetch was needed.

The consumer applies projection before broadcasting, within the existing per-session ordering barrier, and flushes pending patch ops before lifecycle/control events. On tracked snapshot, capture source/history read fence before native RPC, recheck it after return, choose event-owned versus whole native bodies by the source-authority contract, and stamp only the captured event-owned revision/memberships; reuse current builders. Never initialize an appendable body from an independent active read. Client parses the additive event, applies it in `freshAgentLive`, and merges normalized rows into the existing transcript props. Reuse current snapshot scheduler/request-authority checks and hidden-pane dirty handling. Implement the source-authority eight-point contract above in these helpers; do not scatter revision logic across render branches.

- [ ] **Step 4: Run the focused tests**

Run the same two commands from Step 2. Expected: PASS with growing pre-completion content, exact final replacement, and linear emitted bytes.

- [ ] **Step 5: Refactor while green**

Centralize native ID checks, indexed reasoning append, and final-item replacement inside `projection.rs`. Keep existing mapper/role segmentation as the single normalized representation. Coalesce patches in one session-owned batcher; remove temporary duplicate mapper/usage branches introduced during green development. Re-run the focused tests.

- [ ] **Step 6: Run impacted verification**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py -p freshell-codex -p freshell-freshagent`.

Run: `pnpm run test:vitest run test/unit/shared/fresh-agent-contract.test.ts test/unit/client/lib/ test/unit/client/store/ test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`.

Expected: PASS. This shared live-state boundary affects all provider live rendering, so include the whole existing Freshagent client lib/store/component set, especially Claude stream landing, OpenCode projection and hidden-rebind/view tests. Retain the real browser pre-completion journey for Task 10.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/codex/projection.rs shared/fresh-agent-contract.ts src/store/freshAgentLiveTypes.ts src/store/freshAgentLiveSlice.ts src/lib/fresh-agent-ws.ts src/lib/fresh-agent-transcript-projection.ts src/lib/fresh-agent-context-usage.ts src/components/fresh-agent/FreshAgentView.tsx src/components/fresh-agent/FreshAgentSidebar.tsx src/components/fresh-agent/FreshAgentDiffPanel.tsx test/unit/shared/fresh-agent-contract.test.ts test/unit/client/lib/fresh-agent-transcript-projection.test.ts test/unit/client/lib/fresh-agent-context-usage.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/store/freshAgentLiveSlice.test.ts test/unit/client/components/fresh-agent/FreshAgentSidebar.test.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.stream-render.test.tsx
git commit -m "feat(codex): project native live transcript and usage"
```

### Task 3: Preserve native items and open child conversations as parent-scoped observers

**Files:**
- Create: `crates/freshell-freshagent/src/codex/children.rs`; `src/components/fresh-agent/FreshAgentChildObserver.tsx`; `test/unit/client/components/fresh-agent/FreshAgentChildObserver.test.tsx`.
- Modify: `crates/freshell-freshagent/src/snapshot.rs`; `crates/freshell-runtime-protocol/src/lib.rs`; `crates/freshell-runtime-client/src/lib.rs`; `crates/freshell-supervisor/src/service.rs`; `crates/freshell-session-host/src/main.rs`; `crates/freshell-session-host/src/providers/fresh_agent.rs`; `crates/freshell-agent-runtime/src/host_actor.rs`; `crates/freshell-server/src/fresh_agent_proxy_rest.rs`; `src/store/paneTypes.ts`; `src/store/persistedState.ts` for observer selection, not a child runtime.
- Modify: `crates/freshell-freshagent/src/codex.rs:9214,9365`; `crates/freshell-freshagent/src/codex/metadata.rs`; `shared/fresh-agent-contract.ts`; `src/components/fresh-agent/FreshAgentItemCard.tsx`; `FreshAgentSidebar.tsx`; `FreshAgentView.tsx:4401`; `src/components/fresh-agent/FreshAgentComposer.tsx` only for an observed native-image attachment display/serialization gap.
- Test: mapper tests in `codex.rs`; `test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx`; `FreshAgentTranscript.test.tsx`; shared contract tests; child callback/view tests.

**Interfaces:**
- Consumes: Task 1 F3 real-native parent/child read proof, Task 2 projection, existing `map_codex_item(item_id,&Value,item_type)`, metadata collector and shared transcript renderer. No independent child-resume/release guarantee is assumed.
- Produces: faithful normalized rows for `subAgentActivity`, `functionCallOutput`, `sleep`; parent-scoped child observation action. Existing `collab_agent` remains for multi-receiver native tool calls. New activity can reuse `task_delegation` with `childSessionId`, status/model fields added only if necessary; sleep can use a named tool row with duration. Function output becomes a visible tool-result with stable `toolUseId` based on its native ID, without requiring an absent preceding tool-use row.

- Produces: `FreshAgentChildRead { parentSessionId:string, childThreadId:string, observedEpoch?:number, observedGeneration?:number }` and `FreshAgentChildObservation { parentThreadId:string, childThreadId:string, status:'live'|'saved'|'pending', snapshot:FreshAgentSnapshot }`. HTTP `GET /api/fresh-agent/threads/freshcodex/codex/{parentSessionId}/children/{childThreadId}` carries the existing observed owner pair as query parameters. `FreshCodexState::read_child(parent_session_id:&str,child_thread_id:&str,observed_epoch:Option<u64>,observed_generation:Option<u64>) -> Result<Value,ChildReadError>` resolves the parent, verifies the native child relationship, and uses only the parent's proved read context.
- Produces: minimal managed `FreshAgentReadChildRequest {soul_id,child_thread_id,expected_control_epoch}` / `HostCommand::FreshAgentReadChild {incarnation_id,child_thread_id}` and corresponding `FreshAgentChildSnapshot(Value)` result through current typed client/supervisor/session-host dispatch. Gateway resolves the parent alias to its root soul, never resolves the child as a registered root. Recheck the existing same_snapshot_source tuple after read.
- Produces: `FreshAgentChildObserver({parent,childThreadId,onClose})` using `FreshAgentTranscript` in a read-only dialog/section. Parent includes its current provider/session/owner fence. Persist only `observedChildThreadId?:string` in parent pane content so reload can restore observation; no independent child pane/session lifecycle.

- [ ] **Step 1: Write failing behavioral tests**

Add to the existing item card suite:

```tsx
it('renders a declined command as declined rather than completed', () => {
  render(<FreshAgentItemCard item={{
    id: 'cmd-denied', kind: 'command', command: 'touch blocked',
    status: 'declined', output: 'User declined', exitCode: null,
  }} />)
  expect(screen.getByLabelText('declined')).toBeInTheDocument()
  expect(screen.queryByLabelText('complete')).not.toBeInTheDocument()
  expect(screen.getByText(/declined/i)).toBeInTheDocument()
})
```

Pair command/file-change running/completed/failed/declined cases through the real transcript; expand a failed command and assert actual exit code appears. Native mapper tests feed exact 0.164 shapes: subAgentActivity started/interacted/interrupted/completed with agentThreadId, functionCallOutput string and typed content array, sleep duration; assert visible normalized content and stable IDs. Multi-child collab tests retain distinct receiver result/error/status/model and clicking one child selects that exact Codex identity. Upload an actual small image/text file through the composer and verify attachment name/path remains in the user transcript after reload; native image/localImage history retains a meaningful image label/path rather than a bare `[type]` placeholder. Assert image output references remain inspectable after reload using existing authenticated file/link affordances; no new media server or thumbnail promise is necessary. Include missing/unknown native variant: structured diagnostic and graceful history, no empty assistant/user row.

- [ ] **Step 2: Confirm red**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --config config/vitest/vitest.config.ts`.

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py -p freshell-freshagent codex::`.

Expected: declined currently appears complete, new variants are dropped, child callback cannot select Codex.

- [ ] **Step 3: Implement faithful mappings and rendering**

Extend current mapper and role classifier; map native subagent activity to a task/delegation activity with child native identity and direct status mapping. Preserve function-call output plain text and content-item text/image references; unknown content items keep a readable type/result representation, not blank output. Map sleep to a visible tool activity with actual duration. Preserve optional agent-message phase/async choice metadata as optional item extensions used for a readable choice list; never infer completion merely from absent phase.

Extend `FreshAgentToolDisplay.status` with `'declined'` and preserve exitCode. In command and file-change adapters use:

```ts
const status = item.status === 'running' ? 'running'
  : item.status === 'declined' ? 'declined' : 'complete'
```

`FreshAgentToolBlock` renders declined with a neutral icon plus accessible label `declined`, completed with the existing success semantics, failed with existing error semantics, and exit status in expanded command details. Keep the tool renderer shared.

Keep the OpenCode resume action unchanged. Add a distinct Codex `observe-child` action carrying the parent reference/fence and selected child native ID. `FreshAgentChildObserver` fetches the new parent-scoped route and renders existing shared transcript components; it never mounts the ordinary create/attach FreshAgentView path or offers create/resume/send/stop/configure. No native child status, including completed, authorizes a writer claim. Deliberate user opening/closing the observer follows existing accessible focus return; background provider events do not change focus or replace the parent.

For local reads resolve the parent's current registered client, verify child membership in retained/native parent activity, and call exact child `thread/read(includeTurns:true)` through that same client using the Task 1 demonstrated mechanism. If Task 1 selected exact provider-owned saved history, use that source with honest saved/pending status and final convergence. Never consult an unrelated HOME or start a child sidecar. Capture/recheck parent source and history-generation fence across the read.

Managed reads add the minimal parent-root typed request described above, run in its provider volume, and return the child under an explicit observer response. The existing root snapshot route is not an arbitrary-child reader and must retain its root identity checks. The observer response stamps child capabilities nonmutating. Route tests use deliberately different gateway/provider child histories, verify the right result, reject an unrelated child and a replaced owner during a paused read, and count zero child-start/resume RPCs. Component/browser tests restore the observer after reload while parent identity/transcript/actions remain intact.

- [ ] **Step 4: Confirm green**

Run both Step 2 commands. Expected: PASS; all new variants render, declined is never success, parent-scoped child observation returns exact content without a child writer.

- [ ] **Step 5: Refactor while green**

Consolidate child-status/result formatting in one focused helper shared by collab/activity/sidebar. Reuse existing generic tool/delegation blocks and remove dead duplicated branches only if the task actively changed/read them. Preserve OpenCode callback behavior.

- [ ] **Step 6: Verify impacts**

Run: `pnpm run test:vitest run test/unit/shared/fresh-agent-contract.test.ts test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`.

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py -p freshell-freshagent codex::`.

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py --build-server -p freshell-freshagent -p freshell-server -p freshell-session-host -p freshell-runtime-client -p freshell-runtime-protocol -p freshell-supervisor child`.

Expected: PASS with nonzero parent/child route, serializer and source-fence tests, including existing OpenCode delegation and Claude tool rows. Task 10 supplies denied-tool/child/reload browser receipts.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/codex/metadata.rs shared/fresh-agent-contract.ts src/components/fresh-agent/FreshAgentItemCard.tsx src/components/fresh-agent/FreshAgentSidebar.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/shared/fresh-agent-contract.test.ts test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentSidebar.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git add crates/freshell-freshagent/src/codex/children.rs crates/freshell-freshagent/src/snapshot.rs crates/freshell-runtime-protocol/src/lib.rs crates/freshell-runtime-client/src/lib.rs crates/freshell-supervisor/src/service.rs crates/freshell-session-host/src/main.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-agent-runtime/src/host_actor.rs crates/freshell-server/src/fresh_agent_proxy_rest.rs src/store/paneTypes.ts src/store/persistedState.ts src/components/fresh-agent/FreshAgentChildObserver.tsx test/unit/client/components/fresh-agent/FreshAgentChildObserver.test.tsx
git commit -m "feat(codex): preserve native tool and child activity"
```

### Task 4: Keep owed turns and Stop correct across steering, rejection and response races

**Files:**
- Create: `crates/freshell-freshagent/src/codex/turn_state.rs`.
- Modify: `crates/freshell-freshagent/src/codex.rs:3348,3500,4039,10442`; `crates/freshell-codex/src/app_server.rs` and its `lib.rs` exports only if the Task 1 evidence selects explicit native turn/steer; `src/components/fresh-agent/FreshAgentView.tsx` send-refusal branch.
- Test: embedded Codex ChannelTransport tests; new turn-state tests; FreshAgentView queued-send/refusal tests.

**Interfaces:**
- Consumes: existing turn lock, event-emission gate, active/native turn IDs, dispatch request ID, user-interrupt marker, QuietDeadman, ownership fences.
- Produces: `CodexTurnState` with `begin_dispatch(request_id:&str)->DispatchToken`, `accept(token,turn_id:&str)->StopDisposition`, `reject(token)->bool`, `mark_ambiguous(token:DispatchToken)`, `request_stop()->StopDisposition`, `interrupt_ack(token:DispatchToken,turn_id:&str)`, `settle_native(turn_id:&str,evidence:NativeSettlement)->bool`, and `has_owed_work()->bool`. `NativeSettlement` is completed/interrupted/failed native terminal evidence or confirmed owned runtime exit, never interrupt acknowledgement/quiet-deadman attention. `DispatchToken` is monotonically session-local and equality-owned; `StopDisposition` is `None | Latched | Interrupt { dispatch:DispatchToken, turn_id:String }`. Keep compatibility latches mirrored from this one transition source until consumers can use it directly.
- Produces: identity-owned turn facts usable by Task 9 typed outcomes without inspecting the broadcast bus. Ordinary browser busy sends retain the existing client queue policy; server/API follow-up sends use the actual native start/expected-turn steering mechanism selected by Task 1 F2 proof. Do not replace supported native steering with a new server queue or paid retry.

- [ ] **Step 1: Add failing race tests**

The pure ownership test defines the intended transition behavior:

```rust
#[test]
fn rejected_steer_and_old_stop_cannot_retire_a_new_turn() {
    let mut turns = CodexTurnState::default();
    let first = turns.begin_dispatch("first");
    turns.accept(first, "old");
    let steer = turns.begin_dispatch("steer");
    turns.reject(steer);
    assert!(turns.has_owed_work());
    assert!(matches!(turns.request_stop(), StopDisposition::Interrupt { turn_id, .. } if turn_id == "old"));
    let next = turns.begin_dispatch("next");
    turns.accept(next, "new");
    turns.interrupt_ack(first, "old");
    assert!(turns.has_owed_work());
    assert!(!turns.settle_native("old", NativeSettlement::Interrupted));
    assert!(turns.has_owed_work());
    assert!(turns.settle_native("new", NativeSettlement::Completed));
    assert!(!turns.has_owed_work());
}
```

Also test Stop before native acceptance latches and dispatches once when the turn ID arrives; same-ID accepted steer is the same owed native turn; rejected initial dispatch leaves idle; rejected steer preserves the earlier owed turn; exit-induced dispatch error leaves death classification to the exit owner. ChannelTransport tests hold the old interrupt response, accept a new turn, release old response, and assert new busy/interrupt target survives. Hold successful interrupt acknowledgement without any terminal event and assert busy/REST waiter remain outstanding; then deliver matching terminal evidence and settle once. Same-ID steering creates two accepted dispatch facts but one native owed turn and one terminal settlement. Preserve accepted-before-immediate-completion and lifecycle-loss dedup tests. Inject ownership refusal during recovery and assert **both** pane-scoped SESSION_RESERVED and request-correlated send error are emitted; browser restores that refused prompt without overwriting a later typed draft.

- [ ] **Step 2: Confirm red**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py -p freshell-freshagent codex::`.

Run the existing FreshAgentView send/queue/refusal test files through `pnpm run test:vitest run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`.

Expected: old interruption clears new turn; rejected steer clears previous latch; pre-accept Stop fails; interrupt acknowledgement incorrectly retires work; refused Codex prompt is not restored.

- [ ] **Step 3: Implement identity-owned transitions**

Replace unconditional shared-latch retirement with matching dispatch/native-turn transitions. An interrupt captures its owned native turn/token before awaiting; response success records Stop acknowledgement/stopping only. It never retires owed work, settles a REST waiter or claims a terminal turn. Actual matching native terminal/confirmed-exit evidence retires that identity, while an old acknowledgement cannot alter a newer turn. Failed interrupt disarms only its own user-stop marker. Stop during an unresolved initial start sets a latch for that dispatch, then sends native interrupt once accepted; `turn/started` cannot erase a stop already latched for that dispatch. A newer accepted native turn cannot inherit an older marker. Retain compact's separate guarded native turn identity.

Task 1 F2 is a hard prerequisite. For the demonstrated native follow-up mechanism, keep acceptance distinct from settlement: acceptance may return the existing native turn; do not claim a new turn or duplicate completion. On explicit rejection remove only that request's pending dispatch; on transport timeout/uncertain acceptance use mark_ambiguous and retain the unresolved ownership fact until actual evidence resolves it, and derive busy/deadman state from all still-owed work. Do not automatically resend an ambiguous timeout/transport result: preserve existing recoverability/typed error semantics and native identity. If early native proof selected explicit `turn/steer`, add only its native client helper with required `expectedTurnId` and preserve its no-new-turn/no-overrides semantics; the browser keeps its current queued-send policy and needs no separate steering UI.

At main's SESSION_RESERVED recovery refusal, call existing `send_error(&request_id,...)` before pane error, retaining request and holder diagnostics. Expand the existing prompt-restoration branch to Codex request-correlated refusals and restore only when it will not destroy newer user input; keep the refused text recoverable through the existing notice/composer mechanism. No blanket retry.

- [ ] **Step 4: Confirm green**

Run Step 2 commands. Expected: PASS with deterministic barriers, no sleeps as race proof.

- [ ] **Step 5: Refactor while green**

Make all send/started/completed/interrupt/death/close paths call the same transition methods. Remove temporary duplicate owned-turn booleans only after all existing tests are green. Keep lock order rollback registry → turn lock → short state guard; never await while holding a standard mutex or take the turn lock from the consumer behind the existing emission gate.

- [ ] **Step 6: Verify impacts**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py --build-server -p freshell-codex -p freshell-freshagent -p freshell-ws`.

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/ test/unit/client/lib/ --config config/vitest/vitest.config.ts`.

Expected: PASS, including crash, compact, fork, rollback and stale-send fences. Process-fault tests remain in Docker.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/codex/turn_state.rs src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git add crates/freshell-codex/src/app_server.rs crates/freshell-codex/src/lib.rs crates/freshell-codex/tests/interrupt_rpc.rs
git commit -m "fix(codex): preserve turn ownership across send and stop races"
```

### Task 5: Make native approvals, questions and configured MCP prompts usable, and pause only for blocking input

**Files:**
- Modify: `crates/freshell-freshagent/src/codex/controls.rs`; `codex/controls/tests.rs`; `codex.rs` deadman arming/firing; shared question/pending-control schemas; existing client WS/store/banner/View files from the responsibility map; `crates/freshell-ws/src/terminal.rs`; `crates/freshell-ws/src/hosted_fresh_agent.rs`; `crates/freshell-server/src/fresh_agent_proxy.rs`; `crates/freshell-session-host/src/providers/fresh_agent.rs`.
- Create: `crates/freshell-freshagent/src/codex/elicitation.rs`; `src/components/fresh-agent/FreshAgentElicitationBanner.tsx`; `test/unit/client/components/fresh-agent/FreshAgentElicitationBanner.test.tsx`.
- Test: controls/elicitation/deadman tests; question/approval/elicitation component tests; shared response-contract tests.

**Interfaces:**
- Consumes: Task 1 actual native Plan/approval/question/MCP setup and lifetime proof; existing `normalize_request`, pending request registry/native JSON-RPC RequestId, approval/question respond messages, Task 4 owed-work state.
- Produces: per-question `isOther?:boolean`, `isSecret?:boolean`; pending-question `isBlocking?:boolean` (Codex always stamps installed value; absent legacy requests preserve existing blocking behavior). Approval public metadata carries kind, network host/protocol, offered decisions, and requested permission details without dropping the original method/ID.
- Produces: existing string-valued question answers preserved verbatim, wrapped as one native answer per native single-choice/free-entry question (no comma parsing or new cross-provider answer union), plus a separate narrow elicitation response `{requestId,action:'accept'|'decline'|'cancel',content:Record<string,string|number|boolean|string[]>|null}`. Add `FreshAgentElicitationRespond` / `freshAgent.elicitation.respond` through `ClientMessage`, the WS schema/export unions, `terminal.rs` dispatch, `HostedFreshAgentCommand::Elicitation`, gateway proxy and session-host provider dispatch. Hosted forwarding reuses the existing durable `resolve_permission(decision_id,Value)` operation with a tagged elicitation action/content payload; the Codex provider routes it to `handle_elicitation_respond`, while other providers return explicit unsupported. No new supervisor control opcode is needed; do not send it as model text. The request event `freshAgent.elicitation.request` must also join the existing `PermissionRequested`/actor `record_permission` durable pending-decision path; adding a response variant alone is insufficient. Extend the existing name-based conversion in `providers/fresh_agent.rs`, retain the public native request before broadcast, and expose pending controls through authoritative retained state for Task 6 loss reconciliation.
- Produces: session-owned atomic `blocking_control_count` synchronized by pending mutations, used in both deadman arm and fire validity. All approvals and ordinary supported MCP elicitations are blocking; Codex question uses native `isBlocking`.

- [ ] **Step 1: Write failing request→UI→response and deadman tests**

Extend existing controls `runtime()/event()/snapshot()` fixture. This representative assertion exercises a real native request:

```rust
#[tokio::test]
async fn codex_question_keeps_secret_other_and_blocking_flags_on_reload() {
    let (state, peer, mut rx) = runtime().await;
    peer.request_client(&RequestId::Int(51), "item/tool/requestUserInput", json!({
        "threadId":"thread-1","turnId":"turn-1","itemId":"ask-1","isBlocking":true,
        "questions":[{"id":"token","header":"Token","question":"Enter token",
            "options":null,"isOther":false,"isSecret":true}]
    }));
    let request = event(&mut rx).await;
    assert_eq!(request["questions"][0]["isSecret"], true);
    assert_eq!(request["isBlocking"], true);
    let pending = snapshot(&state, &peer).await;
    assert_eq!(pending["pendingQuestions"][0]["questions"][0]["isOther"], false);
    assert_eq!(pending["pendingQuestions"][0]["questions"][0]["isSecret"], true);
    peer.disconnect();
    state.shutdown().await;
}
```

Component tests type and submit a secret free-form answer containing commas and punctuation, assert input type=password, and assert exact question ID/value—not comma-split values—in native response. For native options plus `isOther:false`, Other is absent; options absent still provides the required free-form input. Legacy non-Codex questions retain their current Other behavior. Test multiple questions/controls, response failure retry, wrong/stale ID, native `serverRequest/resolved`, Stop/turn completion cancellation and reload exactly once.

Approval cases: command absent with network host/protocol; `writeStdin`; command/file decline; availableDecisions with cancel versus decline; session accept only when offered; permission `fileSystem.entries` and network grants. Display exactly what is requested. Test full native response—not a shared allow flag only—and ensure unsupported structured rule amendments are not falsely offered. Existing pane-scoped Always allow must not auto-grant a native decision outside the offered choices.

Hosted tests must observe an actual durable pending decision before clicking the elicitation answer, then reload/reconnect and prove the same request remains answerable. Retained native pending state is the recovery source if upstream broadcast loses the request before conversion; Task 6 must drain that state without waiting for another frame.

MCP cases: flat form with required string, integer/number, boolean and enum/string-array enum; `openai/form` and `openaiForm` aliases for the same representable flat shape; URL confirmation preserving url/elicitationId and action; decline and cancel; invalid required/type/range/enum answer; missing/wrong optional turn identity; secret-like/writeOnly field mask where schema advertises it; unsupported nested schema and `openai/userVerification` produce one explanatory native error/decline and no pending banner. URL opening alone never reports acceptance.

Use the existing short quiet-window seam: unanswered approval, blocking question and MCP prompt survive multiple windows without stuck/completion; nonblocking question permits ordinary deadman detection while the turn is genuinely silent; answering one of two blocking controls keeps it paused; draining the final blocking control rearms a fresh full quiet window; provider activity clears stuck; close/death cancels waiters. Recheck membership at deadline firing to cover an arrival racing an already armed timer.

- [ ] **Step 2: Confirm red**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py -p freshell-freshagent codex::`.

Run: `pnpm run test:vitest run test/unit/shared/fresh-agent-contract.test.ts test/unit/client/components/fresh-agent/ test/unit/client/lib/fresh-agent-ws.test.ts --config config/vitest/vitest.config.ts`.

Expected: native flags lost, wrong visible choices/plain text secret input, MCP rejected, and legitimate blocking input trips deadman.

- [ ] **Step 3: Extend the existing control path and bounded elicitation UI**

Normalize native fields into the existing public control records and live events identically. Keep RequestId string/integer identity through all serialization; request keys remain stable on reload. Managed `decision_id` is an opaque routing key using the existing unambiguous JSON/native-ID mapping; keep original native ID type in retained request data. Test integer 41 versus string "41" concurrently so hosted conversion cannot collapse them, and respond with the original native RequestId. Store original native params privately for exact validation/response and turn cancellation. Never restore secret entered values after reload, store them in pane persistence, or log them.

`FreshAgentQuestionBanner` passes flags through its current question props. Show Other only when native allows it; use free entry for questions with no options; mask secrets. Keep native single-choice/free-entry values verbatim. Respond native `{answers:{[questionId]:{answers:[...]}}}` without splitting human answer text. On response, check request still pending and belongs to the same turn/incarnation immediately before send; cancelled old request cannot consume a later question's answer.

Approval cards show a bounded plain-language description for command, stdin, network, file change and additional filesystem entries, then only supported offered choices. Continue existing simple Allow/Deny where valid, add Stop/cancel distinctly when offered, and validate requested decision against native `availableDecisions`. `decline` continues, `cancel` interrupts; do not translate both into the same decision. Permissions responses grant explicit requested subset or none with honest turn/session scope; no persistent policy editor is required.

After the early native gate has established actual elicitation setup/lifetimes, `elicitation.rs` accepts only representable flat object properties using primitive/enum rules, required membership, numeric/string bounds, and supported format hints. Normalize it into the new small banner, preserving title/message, field ID/type/default/allowed choices and secret hint. Use native `{action,content}`. For URL, show server name/message/link and explicit Continue/Decline/Cancel; open through the existing browser/link affordance and wait for user confirmation. A verified unrepresentable subtype receives the explicit unsupported result and a notice naming the subtype; do not leave the provider blocked or fabricate a successful form. Ensure turnless elicitation remains scoped to the owning native thread and is cleared on thread death/close.

Publish `blocking_control_count` before arming/draining transitions. The required deadman condition is:

```rust
let should_watch = turn_state.has_owed_work()
    && blocking_control_count.load(Ordering::SeqCst) == 0;
```

Apply it both when feeding/arming and when the timer validates its generation at firing. Draining the final blocker feeds current activity and rearms a full window; nonblocking questions do not fake idle/completion. Keep waiting attention and turn completion distinct.

- [ ] **Step 4: Confirm green**

Run Step 2 commands. Expected: PASS; exact native responses and retained metadata through snapshot/live path, no false deadman for blocking controls.

- [ ] **Step 5: Refactor while green**

Centralize pending insert/remove/drain transitions so every route updates count, cancellation event and waiting state once. Keep typed bounded form validation in `elicitation.rs`; do not embed JSON-schema interpretation in the main view. Keep provider-specific decision translation in Codex controls.

- [ ] **Step 6: Verify impacts**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py --build-server -p freshell-codex -p freshell-freshagent -p freshell-ws -p freshell-session-host`.

Run: `pnpm run test:vitest run test/unit/shared/ test/unit/client/components/fresh-agent/ test/unit/client/lib/ test/unit/client/store/ --config config/vitest/vitest.config.ts`.

Expected: PASS. The new typed response goes through ordinary and managed WS ingress, and old Claude/OpenCode approval/question flows remain intact.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/codex/controls.rs crates/freshell-freshagent/src/codex/controls/tests.rs crates/freshell-freshagent/src/codex/elicitation.rs crates/freshell-protocol/src/client_messages.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/hosted_fresh_agent.rs crates/freshell-server/src/fresh_agent_proxy.rs crates/freshell-session-host/src/providers/fresh_agent.rs shared/fresh-agent-contract.ts shared/ws-protocol.ts src/store/freshAgentTypes.ts src/store/freshAgentSlice.ts src/lib/fresh-agent-ws.ts src/components/fresh-agent/FreshAgentQuestionBanner.tsx src/components/fresh-agent/FreshAgentApprovalBanner.tsx src/components/fresh-agent/FreshAgentApprovalCard.tsx src/components/fresh-agent/FreshAgentElicitationBanner.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/shared/fresh-agent-contract.test.ts test/unit/client/components/fresh-agent/FreshAgentQuestionBanner.test.tsx test/unit/client/components/fresh-agent/FreshAgentApprovalBanner.test.tsx test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx test/unit/client/components/fresh-agent/FreshAgentElicitationBanner.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.approvals.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts
git commit -m "feat(codex): honor native controls and MCP elicitation"
```

### Task 6: Recover authoritative Codex state and attention through hosted event loss

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs`; `crates/freshell-freshagent/src/codex/projection.rs`; `codex/controls.rs`; `crates/freshell-ws/src/lib.rs:659`; `crates/freshell-session-host/src/providers/fresh_agent.rs`; `crates/freshell-agent-runtime/src/host_actor.rs`; `crates/freshell-server/src/fresh_agent_proxy.rs`; `src/lib/fresh-agent-ws.ts`; `src/components/fresh-agent/FreshAgentView.tsx` reset/backpressure snapshot triggers.
- Create: `crates/freshell-ws/tests/freshagent_codex_attention_replay.rs`.
- Test: new replay target; existing `freshagent_claude_attention_replay.rs`; Codex edge/death/controls tests; client attention replay tests.

**Interfaces:**
- Consumes: existing `AttentionLedger`, Codex monotonic completion/waiting clocks, current negotiated `freshAgentAttentionReplayV1`.
- Produces: `FreshCodexState::attention_marks() -> Vec<AttentionMark>` and retain-before-broadcast helpers; combined existing ready payload. The provider state, not what happened to reach the gateway, is authoritative.
- Produces: `FreshCodexState::retained_state(session_id:&str) -> Result<Value,RetainedStateError>` with existing source identity, event-owned projection/memberships, attention marks and pending public controls; `subscribe_retained_state(session_id:&str) -> watch::Receiver<u64>` is a coalesced wakeup for changes, not a new history clock/journal. Native facts update retained state before best-effort broadcast. Expose this through the existing provider transport/snapshot route; an optional default-unsupported trait method for non-Codex providers preserves their behavior.
- Produces: one owned bridge recovery worker that reacts to the coalesced wakeup/loss, awaits downstream channel capacity without holding provider locks, and drains the latest retained source. It sends current marks/projection resync in a properly routed `FreshAgentEvent` envelope using the existing `freshAgent.host.backpressure` recovery event with retained/source data, plus every retained pending control through its durable `PermissionRequested` conversion. The retained snapshot includes last exact native history plus event-owned active state and does not wait for another native RPC merely to recover a dropped frame. Gateway/client apply this fenced retained state immediately and request native history refresh separately through the bounded scheduler. It runs even when the dropped frame was the last frame; no later provider token is required. Gateway ready/reset reconciliation reads this retained source under the existing host/incarnation fence, rather than treating its lossy journal as complete history.

- [ ] **Step 1: Write red replay tests**

Mirror the real WS harness in the existing Claude replay target and drive Codex native completion/control facts through its actual state/consumer. After disconnect: complete/fail turn, reconnect negotiated client, compare exact retained timestamp and session type; request blocking question/approval, reconnect, see waiting once; answer last pending control, reconnect, waiting absent but completion retained. Unrequested death retains completion and clears dead controls, explicit close forgets all aliases, materialization maps both old and canonical identity, unnegotiated ready contains no replay. Also prove first load/reload silent seeding, same-page reconnect alerts once, no double ring after late duplicate completion. Saturate both the upstream broadcast and downstream provider-event channels, drop the final completion/waiting/control frame, then produce **no more provider frames**. Drain capacity and assert visible transcript/retained attention recover and the exact pending question/elicitation becomes a durable answerable decision. Repeat gateway journal reset and source replacement while recovery is paused; old-incarnation retained data is rejected. No attention/focus event from the other pane may leak.

The ledger acceptance used by provider tests is:

```rust
state.attention.record_turn_complete("thread-1", "freshcodex", 100);
state.attention.record_waiting("thread-1", "freshcodex", 101);
state.attention.clear_waiting("thread-1");
let marks = state.attention_marks();
assert_eq!(marks.len(), 1);
assert_eq!(marks[0].last_turn_complete_at, Some(100));
assert_eq!(marks[0].last_waiting_at, None);
```

This pure assertion supplements, rather than replaces, the consumer→WS ready tests.

- [ ] **Step 2: Confirm red**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py --build-server -p freshell-ws --test freshagent_codex_attention_replay`.

Expected: real Codex marks are absent from ready replay and the current bridge loses a final edge/control before journal without an independent drain. Add the compiling test harness first so the red receipt is behavioral.

- [ ] **Step 3: Integrate the existing ledger**

Add clone-shared `Arc<AttentionLedger>` to Codex state; observe sessions at admission. Completion and synthesized death/deadman edges record timestamp **before** broadcasting. Waiting transitions retain before broadcast; final pending drain clears waiting; explicit close forgets; materialization aliases; unrequested death keeps completion. Reuse existing clocks/dedup gates, never mint a second clock solely for replay. Combine `fresh_claude.attention_marks()` and `fresh_codex.attention_marks()` at the current capability-gated ready construction. For managed providers the existing arbitrary payload/extension forwarding already works; retain it. Repair the source-proven loss before journaling: `spawn_broadcast_bridge` currently ignores lagged broadcast records and `try_send` drops generic provider events, while its backpressure notice waits for a later frame. Retain Codex facts before that boundary and use the reliable coalesced worker above to publish latest state once capacity is available, even after a dropped last edge. Keep ordinary token patches best effort; on a gap/loss send one resync and read retained state rather than replaying an unbounded token journal. Pending elicitation/approval/question requests use the same existing durable actor conversion as Task 5, including requests missed by broadcast.

At the gateway, retain authoritative host marks for ready replay and refetch the provider-retained source on journal reset/backpressure; recheck current source tuple before applying it. Client `fresh-agent-ws`/View marks a patch gap, host backpressure or host journal reset dirty and schedules one coalesced snapshot; visible rows stay until authoritative replacement. Do not wait for a later provider frame to trigger recovery. A gateway-only ledger cannot reconstruct an edge lost before the journal, so it is not the sole source.

- [ ] **Step 4: Confirm green**

Run Step 2 command. Expected: PASS with exact timestamps and capability gating.

- [ ] **Step 5: Refactor while green**

Route all Codex attention edges through focused retain-and-broadcast helpers; consolidate only the touched bridge recovery paths and reuse existing durable pending-decision recording, without a new generic event journal; keep the generic ledger and Claude observer contract intact. Remove any duplicate controls waiting clock only if the same monotonic timeline is fully preserved and tests prove it.

- [ ] **Step 6: Verify impacts**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py --build-server -p freshell-freshagent -p freshell-ws -p freshell-session-host -p freshell-agent-runtime -p freshell-server`.

Run existing client attention/ready tests through `pnpm run test:vitest run test/unit/client/lib/ test/unit/client/store/ --config config/vitest/vitest.config.ts`.

Expected: PASS, including Claude/Kilroy silent seed and alias eviction behavior. Task 10 adds browser offline/hidden/two-pane proof.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/codex/controls.rs crates/freshell-ws/src/lib.rs crates/freshell-ws/tests/freshagent_codex_attention_replay.rs crates/freshell-server/src/fresh_agent_proxy.rs
git add crates/freshell-freshagent/src/codex/projection.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-agent-runtime/src/host_actor.rs src/lib/fresh-agent-ws.ts src/components/fresh-agent/FreshAgentView.tsx
git commit -m "fix(codex): recover retained state after hosted event loss"
```

### Task 7: Use installed model capabilities without changing the selected model or effort

**Files:**
- Create: `crates/freshell-codex/src/catalog.rs`.
- Modify: `crates/freshell-codex/src/app_server.rs`; `model.rs`; `lib.rs`; `crates/freshell-freshagent/src/model_capabilities.rs`; Codex create/send/configure/fork normalization; `crates/freshell-runtime-protocol/src/lib.rs`; `crates/freshell-runtime-client/src/lib.rs`; `crates/freshell-supervisor/src/service.rs`; `crates/freshell-session-host/src/main.rs`; `crates/freshell-session-host/src/providers/fresh_agent.rs`; `crates/freshell-agent-runtime/src/host_actor.rs`; `crates/freshell-server/src/fresh_agent_proxy.rs` for scoped hosted probe wiring; `crates/freshell-opencode/src/catalog.rs`; `shared/fresh-agent-models.ts`; `shared/fresh-agent-contract.ts:54`; shared capability definitions/registry/model dialog helpers and components.
- Test: new Codex catalog tests; existing model tests; model-capability Rust tests; `test/unit/shared/fresh-agent-models.test.ts`; existing model dialog/registry/create-content tests.

**Interfaces:**
- Consumes: Task 1 actual native catalog/model/effort evidence, current five-minute TTL/singleflight registry and the ordinary pane-create acknowledgement/current runtime owner. Reuse the actual initialized local/session-host app-server; no new conversation or gateway-global provider process is created for catalog discovery.
- Produces: `CodexAppServerClient::list_models(cursor:Option<&str>) -> Result<Value,CodexAppServerError>` and a parser in `catalog.rs`. Follow every nextCursor. Use native runnable `model` ID and displayName, supported/default efforts and input modalities. Optional `defaultEffort:string`/`inputModalities:string[]` extend shared/Rust capability rows; absent values preserve other providers. Internal model limits stay internal.
- Produces: `FreshAgentCodexCatalogContext {sessionId:string,sessionRef?:SessionLocator,cwd?:string,observedEpoch?:number,observedGeneration?:number}` on the existing capability HTTP request. Before ordinary creation binds that context, the picker is pending and preserves exact saved/staged/custom selections; it performs no hidden create or global probe. On create acknowledgement, automatically request the catalog through that bound context. The endpoint returns existing unavailable envelope with `RUNTIME_PENDING` if the runtime is not yet available; defaults-only screens show exact input/labeled defaults without claiming a native catalog.
- Produces: `FreshAgentModelCatalogRequest {soul_id,cwd,expected_control_epoch}` and `HostCommand::FreshAgentModelCatalog {incarnation_id,cwd}` plus `FreshAgentModelCatalog(Value)` responses through existing typed client/supervisor/session-host dispatch. Gateway resolves the conversation reference to the current parent/root runtime server-side; never trusts a stale frontend soul as authority. Local state resolves the same current registered client. Read `model/list` in that actual provider context and recheck the existing source tuple after reply.
- Produces: catalog cache key `{provider,currentSource,cwd}` where currentSource derives from existing native identity/owner epoch+generation or managed same_snapshot_source fields (host boot/incarnation/execution generation/provider volume). Rebind/restart/materialization invalidates the old key and in-flight client request; stale replies cannot overwrite a newer context or staged selection. Use the existing TTL/singleflight registry. Native model-list absence never rejects an explicit model/effort; exact values remain eligible for native validation.
- Produces: capability-aware selection validation shared by create/send/configure/fork; nonempty native effort strings preserved across wire/TS validation. No new fixed effort enum. `max` legacy alias maps to `xhigh` only where the installed selected model supports xhigh and does not advertise distinct max.

- [ ] **Step 1: Write red model/effort behavior tests**

Use the existing app-server ChannelPeer handshake helper to test list pagination; native result page 1 contains `gpt-6.1-sol` with `xhigh`, page 2 contains `provider-current` with effort `ultra` and no static menu entry. Assert exact request cursor and final mapped choice list. Probe failure/deadline returns typed unavailable and leaves previous same-source cache intact; it creates/closes no extra provider process. Distinct provider contexts and gateway HOME must yield distinct records and exact source routing.

Add the existing actual CLI/app-server drive test variant with chosen model `provider-current` and effort `ultra`: create/send/configure/resume/fork must put that exact pair in the next native request. Add this small normalization test after changing the function semantics:

```rust
#[test]
fn explicit_native_choices_are_never_replaced_by_static_defaults() {
    assert_eq!(normalize_freshcodex_model(Some("provider-current")), "provider-current");
    assert_eq!(to_codex_reasoning_effort(Some("ultra")).unwrap(), Some("ultra".into()));
    assert_eq!(to_codex_reasoning_effort(Some("none")).unwrap(), Some("none".into()));
}
```

The provider-drive test is necessary: a normalizer test alone cannot prove runtime acceptance. Current-model omitted from refresh stays visibly selected/unavailable, failed catalog does not switch to Astra, delayed refresh does not erase search or staged selection, committed xhigh survives configure→send→reload→send. Any native rejection of an explicit choice is a useful typed failure; catalog omission alone is never a rejection. Absent choice uses native/default chosen by existing defaults. Preserve a nonempty explicit model/effort for native validation whether catalog succeeds, is incomplete, or is unavailable. Open the picker before create acknowledgement, stage a new exact choice, acknowledge creation, and assert the auto-probe uses the newly bound context without erasing the choice or search. Fail creation and prove honest unavailable with no hidden runtime. Rebind during a held catalog response and prove the old source reply cannot commit.

- [ ] **Step 2: Confirm red**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py -p freshell-codex -p freshell-freshagent model`.

Run: `pnpm run test:vitest run test/unit/shared/fresh-agent-models.test.ts test/unit/client/lib/fresh-agent-model-capabilities.test.ts test/unit/client/lib/fresh-agent-create-content.test.ts test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx --config config/vitest/vitest.config.ts`.

Expected: static clamp substitutes Astra/max and Codex dialog never probes native.

- [ ] **Step 3: Implement native catalog and faithful selection**

`list_models` uses the existing bound client's initialized request path; request visible models, follow cursor to exhaustion and reject malformed/looping cursors with typed probe error. Preserve advertised fields and native defaults. The normal automatic pane create establishes the runtime with exact saved/default settings; a catalog request never creates a synthetic conversation or probes another HOME. While create is pending keep exact selection, show pending, and preserve any labeled defaults. After bind, fetch automatically using the current-context request above.

Replace FreshCodex's static fast path only for a bound context. Server resolves that session reference under existing ownership/inventory safety, executes the query in the owning local/managed provider, and rejects source changes. Cache by the actual current source generation and cwd; invalidate on rebind/restart, not just TTL. Missing/restarting managed runtime returns pending/unavailable, never falls back to gateway CLI. Existing arbitrary payload extensions already cross managed hosting; typed model-list request/routing is the new work.

Keep every nonempty explicit Codex model/effort through create/send/configure/resume/fork. The catalog populates menus and advertised choices; it is not proved exhaustive for custom providers, so successful list absence never rejects exact intent. Let native validate and return typed failure rather than silently substitute a model/effort. `FreshAgentSettingsSchema.effort` accepts nonempty native strings. Preserve xhigh exactly; migrate legacy max→xhigh only at the intended compatibility boundary where the selected native model advertises xhigh and no distinct max. Saved/custom values omitted by refresh stay visible as exact current selections. No new fixed effort enum or session-preparation/auth framework.

- [ ] **Step 4: Confirm green**

Run Step 2 commands plus `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py -p freshell-codex catalog`. Expected: PASS, exact current values reach native calls.

- [ ] **Step 5: Refactor while green**

Unify selection application across all Codex lifecycle paths, leaving shared provider-specific behavior intact. Delete obsolete Codex fixed-menu clamps and misleading 0.129 effort comments, retain deliberate fallback constants only for genuinely omitted choices. Keep native catalog mapping in `catalog.rs`, process lifecycle in the existing transport/launch seam, registry caching in the existing registry.

- [ ] **Step 6: Verify impacts**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py --build-server -p freshell-codex -p freshell-freshagent -p freshell-session-host -p freshell-runtime-protocol -p freshell-runtime-client -p freshell-supervisor`.

Run: `pnpm run test:vitest run test/unit/shared/ test/unit/client/lib/ test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`.

Expected: PASS; all providers' model choices and saved Codex defaults remain usable. Task 10 runs the Codex live-convergence browser leg absent today.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-codex/src/app_server.rs crates/freshell-codex/src/model.rs crates/freshell-codex/src/catalog.rs crates/freshell-codex/src/lib.rs crates/freshell-codex/tests/app_server_drive.rs crates/freshell-opencode/src/catalog.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/model_capabilities.rs crates/freshell-freshagent/src/model_capabilities_tests.rs crates/freshell-runtime-protocol/src/lib.rs crates/freshell-runtime-client/src/lib.rs crates/freshell-supervisor/src/service.rs crates/freshell-session-host/src/main.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-agent-runtime/src/host_actor.rs crates/freshell-server/src/fresh_agent_proxy.rs shared/fresh-agent-models.ts shared/fresh-agent-model-capabilities.ts shared/fresh-agent-contract.ts src/lib/fresh-agent-model-capabilities.ts src/lib/fresh-agent-registry.ts src/components/fresh-agent/FreshAgentModelDialog.tsx test/unit/shared/fresh-agent-models.test.ts test/unit/client/lib/fresh-agent-model-capabilities.test.ts test/unit/client/lib/fresh-agent-create-content.test.ts test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx
git commit -m "feat(codex): use native model and reasoning capabilities"
```

### Task 8: Apply, persist and expose Codex file access, cwd and native Plan mode

**Files:**
- Create: `crates/freshell-freshagent/src/codex/settings.rs`.
- Modify: `crates/freshell-codex/src/app_server.rs:182,461`; `crates/freshell-protocol/src/client_messages.rs`; `crates/freshell-freshagent/src/codex.rs:1958,3516,3923,7950`; `crates/freshell-runtime-protocol/src/lib.rs:2483`; `crates/freshell-agent-runtime/src/host_actor.rs`; `crates/freshell-agent-runtime/src/snapshot_projection.rs`; `crates/freshell-session-host/src/providers/fresh_agent.rs`; `crates/freshell-server/src/fresh_agent_proxy.rs`; `shared/fresh-agent-contract.ts`; `shared/settings.ts`; `shared/ws-protocol.ts`; `src/store/paneTypes.ts`; existing pane persistence normalizers; `src/lib/fresh-agent-create-content.ts`; registry; `FreshAgentSettingsButton.tsx`; `FreshAgentView.tsx`; managed create/send/configure serialization.
- Test: settings helper/native request tests; existing settings/create/resume/fork tests; `FreshAgentSettingsButton.test.tsx`; persistence/view tests.

**Interfaces:**
- Consumes: Task 7 selected native model/effort, existing `FreshAgentSendSettings`, sandbox/permission mappings, per-session turn lock, durable fenced settings persistence.
- Produces: `CodexEffectiveSettings { model:String, effort:Option<String>, cwd:Option<String>, sandbox:Option<String>, permission_mode:Option<String>, collaboration_mode:Option<CodexWorkMode> }`, with `CodexWorkMode::{Default,Plan}`. A pure `resolve(base,patch)` validates and merges; apply under existing serialization boundary; emit/persist complete effective settings. Wire create/send/configure/pane/default types add optional `collaborationMode:'default'|'plan'`; shared scopes add cwd/collaborationMode optional keys.
- Produces: `StartTurnParams.collaboration_mode:Option<Value>` serialized as native `collaborationMode` with selected model, reasoning_effort and developer_instructions:null. All existing Rust struct-literal callers add `None` or use `..Default::default()` deliberately; update native client drive tests accordingly.

- [ ] **Step 1: Write failing settings/order/Plan behavior tests**

Test native wire encoding independently:

```rust
#[test]
fn plan_mode_uses_selected_model_and_effort_without_changing_sandbox() {
    let settings = CodexEffectiveSettings {
        model: "provider-current".into(), effort: Some("xhigh".into()),
        cwd: Some("/work".into()), sandbox: Some("read-only".into()),
        permission_mode: Some("on-request".into()),
        collaboration_mode: Some(CodexWorkMode::Plan),
    };
    assert_eq!(settings.native_collaboration_mode(), Some(json!({
        "mode":"plan", "settings":{
            "model":"provider-current","reasoning_effort":"xhigh","developer_instructions":null
        }
    })));
    assert_eq!(settings.sandbox.as_deref(), Some("read-only"));
}
```

Drive configure cwd/sandbox/permission only, then send and snapshot: each value reaches native and returns unchanged. Hold an in-flight send response while a newer configure arrives; once both settle, the newer configure remains the default for the next send and reload. Make durable settings write fail: useful typed/logged refusal and no false durable success. Test configured model/effort and work mode survive create/resume/fork and native effective resume values override stale requested assumptions. Backward compatible panes lacking new fields stay Build/default.

Component tests use real store/settings callback: select File access Read only/Workspace write/Full access and Work mode Plan/Build, observe pane patch and configure payload. Read-only and approval Never ask remain distinct; create-only/unsupported scope shows honest hint/disabled action. Plan→native question→answer→Build is later proven in browser, not just by static label assertions.

- [ ] **Step 2: Confirm red**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py -p freshell-codex -p freshell-freshagent settings`.

Run: `pnpm run test:vitest run test/unit/client/lib/fresh-agent-create-content.test.ts test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`.

Expected: configure ignores cwd; snapshot omits sandbox/cwd; send overwrites newer configure; no native mode or file-access control.

- [ ] **Step 3: Implement one effective-settings path**

Use the existing turn lock for configure as for send/rollback, so a later configure applies after the older send completes rather than being overwritten by its response. Resolve all fields once; validate directory using the same existing cwd rules as create/send; honor native per-turn semantics. Persist only applied/accepted fields with captured ownership fence and handle errors explicitly. Configuration changes stage next-message defaults; they must not falsely claim the current native turn was reconfigured. Broadcast metadata for any changed field, including sandbox/permission/cwd/work mode, and snapshot all of them. Carry work mode through `FreshAgentTurnSettings`, host actor durable profiles/recovery, configure/send forwarding and session-host native `StartTurnParams`; extend hosted `snapshot_projection::valid_scopes` to allow cwd/collaborationMode, otherwise it currently drops the whole scope map. Extend client metadata adoption so older absent fields do not clear valid values.

Build native collaborationMode using resolved model and **wire-normalized** effort. Selecting Build explicitly switches native `mode:'default'`, not omission that might preserve Plan. Start/resume effective values, when native echoes them, are authoritative. Plan setting is capability/scoped and separate from approval policy. Extend the existing settings popover with plain-language File access and Work mode rows, persist defaults via current provider settings patch, and stage/commit through the same helper as model/permission. Snapshot capability `settingScopes` truthfully advertises per-send cwd/sandbox/model/effort/approval/work mode supported by installed Codex; no invented live-only reconfiguration.

- [ ] **Step 4: Confirm green**

Run Step 2 commands. Expected: PASS and exact Plan/default native fields with same model/effort and correct sandbox/cwd after reload.

- [ ] **Step 5: Refactor while green**

Replace four separate settings-normalization blocks with the focused helper and shared persistence/projection functions. Do not move identity/lease/fork machinery into settings. Keep mode/approval/sandbox distinct in names and UI copy.

- [ ] **Step 6: Verify impacts**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py -p freshell-codex -p freshell-freshagent -p freshell-protocol -p freshell-session-host`.

Run: `pnpm run test:vitest run test/unit/shared/ test/unit/client/lib/ test/unit/client/store/ test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`.

Expected: PASS including old saved panes, create defaults, hosted settings forwarding and cross-provider settings scope behavior.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-codex/src/app_server.rs crates/freshell-codex/tests/app_server_drive.rs crates/freshell-protocol/src/client_messages.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/codex/settings.rs crates/freshell-runtime-protocol/src/lib.rs crates/freshell-agent-runtime/src/host_actor.rs crates/freshell-agent-runtime/src/snapshot_projection.rs crates/freshell-session-host/src/providers/fresh_agent.rs crates/freshell-server/src/fresh_agent_proxy.rs shared/fresh-agent-contract.ts shared/settings.ts shared/ws-protocol.ts src/store/paneTypes.ts src/store/persistedState.ts src/lib/fresh-agent-create-content.ts src/lib/fresh-agent-registry.ts src/lib/fresh-agent-setting-scopes.ts src/components/fresh-agent/FreshAgentSettingsButton.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/client/lib/fresh-agent-create-content.test.ts test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "feat(codex): expose faithful settings and native plan mode"
```

### Task 9: Enable CLI/MCP and default REST automation through the existing Codex runtime

**Files:**
- Create: `crates/freshell-freshagent/src/codex_rest_lane.rs`.
- Modify: `crates/freshell-freshagent/src/codex.rs` typed outcomes/turn subscriptions; `lib.rs:2092,2579`; `rest_lane.rs`; `pane_ops.rs`; `crates/freshell-server/src/main.rs`; `tools/node-client-runtime/action-capabilities.ts`; `tools/freshell-cli/index.ts:120,159,461,582` create/split/resume body parser; `tools/freshell-mcp/freshell-tool.ts`.
- Test: `rest_lane_http_tests.rs`; new `codex_rest_lane` behavior tests; `test/unit/cli/action-capabilities.test.ts`; `commands.test.ts`; `test/unit/mcp/freshell-tool.test.ts` and existing MCP HTTP dispatcher tests.

**Interfaces:**
- Consumes: `FreshAgentRestLane::{create_agent,abandon_create,send_agent,capture,snapshot}`, exact `RestLaneCreate/Send/Capture` types, Task 4 identity-owned turn facts, current naming/ownership/fence/create cleanup contract.
- Produces: `CodexRestLane::new(state:FreshCodexState, enabled:Arc<dyn Fn()->bool+Send+Sync>)`; `FreshAgentState::set_codex_rest_lane(SharedFreshAgentRestLane)`; local provider selection `codex` after hosted gateway precedence. `CodexCreateOutcome` is `Created { session_id:String, session_ref:Option<SessionLocator>, cleanup_ownership_id:Option<String> } | Failed { code:String,message:String,retryable:Option<bool>,owner:Option<TerminalOwnerFields> }`. `CodexSendOutcome` is `Accepted { session_id:String, submitted_turn_id:String, incarnation_id:String } | Refused { code:String,message:String,retryable:Option<bool>,owner:Option<TerminalOwnerFields> } | Ambiguous { session_id:String,request_id:String,incarnation_id:String,code:String,message:String }`. Accepted means native acceptance only; it is not completed. Exact field responsibilities match the existing Claude typed outcomes. `CodexTurnEvent::Settled` carries native session/turn/incarnation, terminal outcome and actual evidence source; interrupt acknowledgement, quiet-deadman attention, arbitrary status snapshots and acceptance are not settlement events. Subscribe before dispatch and settle only matching native identity. Same-ID steering shares the existing native turn; ambiguous delivery remains incomplete/uncertain with no automatic replay.

- [ ] **Step 1: Add failing real dispatcher and HTTP/runtime tests**

Extend the existing actual CLI HTTP-recording parameterized test from Claude/Kilroy to Codex with provider-specific sessionRef. This complete representative MCP case exercises its real dispatcher:

```ts
it('creates a fresh Codex pane with canonical resume identity', async () => {
  mockClient.post.mockResolvedValue({ status: 'ok', data: { tabId: 't1', paneId: 'p1' } })
  await executeAction('new-tab', {
    agent: 'codex', model: 'provider-current', effort: 'xhigh', cwd: '/work',
    sessionRef: { provider: 'codex', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
  })
  expect(mockClient.post).toHaveBeenCalledWith('/api/tabs', expect.objectContaining({
    agent: 'codex', model: 'provider-current', effort: 'xhigh', cwd: '/work',
    sessionRef: { provider: 'codex', sessionId: '550e8400-e29b-41d4-a716-446655440000' },
  }))
})
```

Add the split equivalent with target lookup. The CLI test invokes the real `tools/freshell-cli/index.ts` child against an owned HTTP recording server; `--resume` maps to provider=codex canonical ref and never raw fresh resumeSessionId. Keep terminal mode=codex raw-resume rejection separate.

Rust HTTP tests construct default local server state with real Codex lane and ChannelTransport: headless new/split honors cwd/model/effort/approval/sandbox/defaults, initial prompt acceptance, canonical resume reuses writer/session, send-keys Enter-only no-op, send waits for actual native terminal evidence for its submitted turn (including same-ID steering and an acknowledged Stop held before terminal), capture matches normalized transcript with byte limit/truncated, wait-for sees actual output, rename reaches shared name authority. Failed create leaves no blank pane and only cleans newly owned runtime; adopting a live writer never kills it on layout rollback. Test ambiguous acceptance never auto-replays input and timeout reports incomplete truthfully.

- [ ] **Step 2: Confirm red**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py -p freshell-freshagent rest_lane`.

Run: `pnpm run test:vitest run test/unit/cli/action-capabilities.test.ts test/unit/cli/commands.test.ts test/unit/mcp/freshell-tool.test.ts --config config/vitest/vitest.config.ts`.

Expected: default local Codex create/split is unavailable and standalone clients refuse before HTTP.

- [ ] **Step 3: Adapt the existing runtime rather than duplicate it**

Refactor `handle_create`/`handle_send` to return typed outcomes while retaining current WebSocket broadcasts; callers that need no result may ignore it explicitly. Publish a private typed turn-settlement subscription from the same reducer/edge path, as Claude does, and subscribe **before** dispatch so fast turns cannot be missed. Correlate native turn, session incarnation, ownership identity and request; if turn/start steers into an existing turn, wait for that native turn without inventing another completion. Cancellation/death/close uses confirmed owned termination or actual native terminal evidence; a requested Stop or its RPC acknowledgement alone leaves the waiter pending. Ambiguous dispatch returns a truthful incomplete/uncertain result and retains same-owner history reconciliation, never resends input.

Implement CodexRestLane by translating existing RestLane request into `FreshAgentCreate/Send`, calling the same state and mapping typed failures. Capture uses side-effect-free exact snapshot and the shared existing transcript-to-text/byte-bound helper; do not scrape rendered DOM or spin up a second sidecar. Cleanup requires owned token identity and existing safe kill/confirm; adopted runtime has no cleanup token. Preserve observed epoch/generation fences.

Register local Codex lane at server construction beside local Claude; `rest_lane_for` retains hosted-gateway precedence and selects Codex locally when unmanaged. Existing split/new layout transaction continues to own rollback. Only once runtime behavior is green, extend the client capability guard and fresh-agent resume parser to Codex and update MCP parameter description. Remove the specific obsolete negative Codex refusal cases; retain all unrelated refusal cases and action counts. Do not add a new fresh-send command.

- [ ] **Step 4: Confirm green**

Run Step 2 commands. Expected: PASS with actual HTTP body and real lane behavior, no change to terminal-mode constraints.

- [ ] **Step 5: Refactor while green**

Reuse existing text capture, typed REST error and wait-deadline helpers; keep provider-specific outcome extraction in Codex. Avoid refactoring all providers into a new runtime trait. Remove temporary broadcast-message parsing used during green implementation.

- [ ] **Step 6: Verify impacts**

Run: `python3 /home/dan/code/freshell/.worktrees/.the-usual-logs/freshcodex-complete/run-focused-rust.py --build-server -p freshell-freshagent -p freshell-server`.

Run: `pnpm run test:vitest run test/unit/cli/ test/unit/mcp/ --config config/vitest/vitest.config.ts`.

Expected: PASS, including Claude automation, naming, focus contracts, split rollback and terminal command validation. Task 10 proves the real Rust/fake-native browser journey and hosted arrangement.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-freshagent/src/codex_rest_lane.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/rest_lane.rs crates/freshell-freshagent/src/rest_lane_http_tests.rs crates/freshell-freshagent/src/pane_ops.rs crates/freshell-server/src/main.rs tools/node-client-runtime/action-capabilities.ts tools/freshell-cli/index.ts tools/freshell-mcp/freshell-tool.ts test/unit/cli/action-capabilities.test.ts test/unit/cli/commands.test.ts test/unit/mcp/freshell-tool.test.ts
git commit -m "feat(codex): support REST CLI and MCP pane automation"
```

### Task 10: Prove complete local and hosted journeys and document the finished experience

**Files:**
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`; `test/fixtures/coding-cli/codex-app-server/schema-inventory.ts` and `schema-traceability.ts` only where needed for exercised 0.164 behaviors; `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`; `fresh-agent-attention-reconnect-rust.spec.ts`; `freshagent-live-model-convergence-rust.spec.ts`; `freshagent-settings-resume-rust.spec.ts`; `test/integration/server/fresh-agent-parity.test.ts`; `README.md`; `docs/index.html`.
- Create: `test/e2e-browser/specs/freshcodex-live-transcript-rust.spec.ts`; `test/e2e-browser/specs/fresh-agent-rest-codex-rust.spec.ts`.
- Modify: Task 1 native harness only for final adapter/hosted regression scenarios; it must already have executed the early native gates.
- Test: those specs plus existing rollback, names, crash/ownership/handoff/attachment/checkpoint regressions through supported lanes.

**Interfaces:**
- Consumes: all production interfaces from Tasks 2–9; existing `RustServer`, `TestHarness`, configured cloud Playwright runner and `ManagedRuntimeBrowserRig`.
- Produces: executed receipts for actual provider messages→Rust runtime→WS/REST→browser/CLI/MCP→native responses, with independent review and no production deployment.

- [ ] **Step 1: Add failing browser assertions before adjusting production behavior**

In early task work, add each applicable acceptance case before its production change. This final task owns their integrated fixture/journey completion; do not postpone all browser red evidence until after implementation. Extend the existing behavior-driven native fixture with opt-in current-schema frames, catalog pages, prompt-scripted control types and operation/response logs. Keep defaults unchanged for other specs. The fake is only the native executable boundary; run real Rust, request handlers, WebSocket transport, shared store and UI.

Use the existing spec-owned `bootWall`/`seedWallConfig`/`createFreshAgentPane` helpers from control spec in that spec; new specs copy the minimal owned-server idiom per repository convention. The core visible assertion in the new streaming journey is:

```ts
await composer.fill('STREAM_AND_WAIT')
await composer.press('Enter')
await expect(pane.getByText('First streamed fragment', { exact: true })).toBeVisible()
await expect(pane.getByRole('button', { name: /stop/i })).toBeEnabled()
expect((await readProviderLog()).some(entry => entry.method === 'turn/completed')).toBe(false)
await releaseNativeTurn()
await expect(pane.getByText('First streamed fragment and final fragment', { exact: true })).toHaveCount(1)
await page.reload()
await harness.waitForConnection()
await expect(page.getByText('First streamed fragment and final fragment', { exact: true })).toHaveCount(1)
```

`composer` and `pane` are actual locators from the created pane; `readProviderLog` reads the fixture's owned JSONL event/operation log; `releaseNativeTurn` writes the fixture's owned release file. Define these complete helpers in the new spec and add fixture behavior `waitForTurnReleasePath` to pause deterministically before native completion. File wait is test-only fake-provider behavior, never production logic. Use a generous bounded deadline with an error naming thread/turn; no unbounded polling or arbitrary sleep.

The Task 1 staged native harness and actual 0.164 receipts are prerequisites for these final regression journeys. Extend/reuse that harness here; do not bootstrap packages at runtime, restate metadata as a pass, or postpone the architecture-controlling native scenarios until this final task. The final actual managed-native pass complements deterministic provider-transport tests.

Required journeys and exact evidence:

1. **Streaming/transcript:** text/reasoning/tool output visible before completion; plan replacement and aggregate diff visible; usage nonzero with unknown cost; completion snapshots converge once; final error and declined rows remain truthful after reload. Hide one of two distinct Codex panes while it streams/awaits input, reveal, assert no transcript/control/model leak and no focus theft.
2. **Native controls/planning:** choose Plan and catalog-only model/xhigh; provider log has native collaborationMode with that pair. Receive blocking constrained question, reload, no Other, exact question IDs; secret question masks input and provider response retains punctuation; nonblocking question does not freeze running work. Network-without-command and stdin approvals show correct action; Deny produces declined row; Stop cancellation sends cancel without duplicate response. Flat MCP form and URL prompt succeed/cancel; unsupported complex/device-proof subtype yields visible bounded explanation and releases native request.
3. **Catalog/settings:** open picker before ordinary create acknowledgement and preserve an exact staged choice; after binding, probe only its actual provider context, ignore stale-source replies, and keep custom models omitted by a successful list eligible for native validation; install fixture model not in static menu and native effort not in old enum; configure/send/reload/send preserve exact pair. Change cwd/file access/approval/work mode and verify next native turn, snapshot and resumed defaults. Restore existing Codex leg in live-model-convergence spec; refresh failure preserves selection. Two browsers observing same session converge settings/name without changing native identity.
4. **Attention:** saturate hosted channels and drop the final control/completion frame with no later provider token; recover from retained state without focus theft, then disconnect only the browser WebSocket; complete/fail or raise input through independent native/WS driver; reconnect produces one correct completion/waiting indication. Reload stays silent, pending response drains waiting, hidden-pane reveal retains the card, no cross-pane edge. The spec's Codex cases must actually execute on cloud.
5. **Automation:** REST creates a headless background Codex pane while active pane/tab/focused element remain unchanged; initial prompt accepted; send/capture/wait see real native output; rename uses shared authority; reload sees the same durable ref; split and resume work. CLI/MCP dispatchers already have HTTP proof; invoke at least one actual standalone CLI and MCP dispatcher against the owned real server in supported integration coverage to prove end-to-end routing rather than recording-only proof.
6. **Preserved lifecycle:** parent-scoped child observer shows exact child transcript, stays read-only and restores its selected child after reload while issuing zero child create/resume/send/stop/configure RPCs; /new, native compact (no turn/start text), fork from a specific row/native boundary, conversation undo with no file change, honest redo refusal, image input reaches native and an uploaded image/text attachment remains meaningfully visible in its user transcript before/after reload, native image output path/result remains inspectable, file-checkpoint/rewind and `!command` cwd, saved-name precedence, same-thread reload/recovery, cross-mode handoff without duplicate writer, Stop in start-response window and rejected steer/late interrupt. Fault/kill/restart variants run only in disposable Docker; never bounce production or run destructive browser specs directly on host.
7. **Managed hosted:** extend `fresh-agent-parity.test.ts` existing rig for Codex same catalog/model/effort/settings/Plan, live transcript+usage, controls response, REST send/capture and reconnect attention. Assert provider operation log inside owned provider volume and gateway-visible state. Include one session-host restart/crash recovery in the existing isolated Docker rig if required by changed projection/replay forwarding; same native ref/settings/name survive, stale host patches cannot overwrite replacement incarnation. Do not replace this with a gateway-local fake state. Add a second actual-native Codex leg using the now-aligned managed image: omit freshcodex from fixtureFreshAgentModes, use the Task 1 loopback Responses/MCP fixture inside the owning provider container/namespace with synthetic config, and run the real Rust/gateway→session-host→actual Codex journey. Extend `codex-local-provider.mjs` with `startInManagedContext(rig,source) -> Promise<{baseUrl,stop,traffic}>` using the existing owned RuntimeSandbox/broker test mechanism, never a live host. The actual-native leg proves native version, streamed/landed text, Plan/control response, faithful settings and parent-scoped child observation through that production adapter; deterministic fake-native parity remains for forced channel/race cases. The Docker-backed local companion must discover and execute that leg, not silently select only the fake transport.

- [ ] **Step 2: Run affected cloud specs and confirm intended red evidence**

During each earlier implementation slice, select its new affected spec with `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/freshcodex-live-transcript-rust.spec.ts test/e2e-browser/specs/fresh-agent-rest-codex-rust.spec.ts` before/after production work; record nonzero discovered test count and failure reason. The concrete final selectors are in Step 4. Expected initial failures correspond to the missing user behavior, not fixture boot/setup failures. If fixture setup fails, fix setup and rerun before claiming red.

- [ ] **Step 3: Complete minimal integrated implementation and documentation**

Repair only production gaps revealed by the accepted journeys, within the earlier task intents. For schema fixture inventory update, represent 0.164 supported/unsupported classifications honestly and preserve unknown-type tolerance; do not add test assertions that merely require version/comment text. Keep native fake configured via existing behavior JSON, exact ID replacement, durable turn recording, and response/operation logs. Add opt-in prompt scripts and release barriers there, not production test seams.

Update README usage for installed Codex model selection, Work mode Plan/Build, file-access versus approval, native questions/MCP prompts, CLI/MCP create/split, native undo/no-redo. Keep it concise and user-facing. Update the nonfunctional `docs/index.html` default-experience mock for major new settings/control affordances using existing design patterns. Do not create another end-user Markdown guide.

- [ ] **Step 4: Run exact focused browser/hosted verification**

Run:

```bash
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/integration/providers/codex-cli-contract.test.ts --config config/vitest/vitest.config.ts
node test/integration/providers/codex-cli-contract.mjs --managed-runtime --receipt-dir .runtime-build/codex-contract/final-managed-native
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e --project=chromium test/e2e-browser/specs/freshcodex-live-transcript-rust.spec.ts test/e2e-browser/specs/fresh-agent-rest-codex-rust.spec.ts test/e2e-browser/specs/fresh-agent-control-rust.spec.ts test/e2e-browser/specs/fresh-agent-attention-reconnect-rust.spec.ts test/e2e-browser/specs/freshagent-live-model-convergence-rust.spec.ts test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts test/e2e-browser/specs/unified-agent-names-freshcodex.spec.ts
```

Expected: actual pinned-native contract and discovered/executed Codex browser cases PASS on configured cloud, including native version/loopback traffic receipts and unchanged production CLI resolution. Verify new specs are absent from cloud skip lists and no required case was filtered/skipped. Existing `codex-terminal-bounce-rust`, `codex-terminal-restore-rust`, `agent-checkpoint-rewind`, centralization mocks and local-only runtime qualification specs cannot count as this cloud receipt. For handoff/checkpoint preservation, use meaningful Cargo/standard-source-runtime isolated coverage plus a cloud-legal non-destructive journey in the new Codex spec when the old browser spec is excluded.

Managed parity remains in the real Docker-backed `test/integration/server` local companion. Use the broad supported run below, which automatically includes that excluded-from-cloud tree. Do not run a focused cloud selector and claim it executed the hosted rig. If a focused supported local companion invocation is needed, use its repository-owned selector documented by the harness, not an ad hoc local backend override; otherwise wait for the full check.

- [ ] **Step 5: Refactor while green**

Remove duplicate temporary fake scripts/helpers introduced by this work; keep per-spec ownership conventions. Consolidate repeated production projection/settings/control transitions only where the earlier tasks already own them. Check logging has diagnosable IDs/severity and no secret answers; verify instructions/copy describe actual behavior. Re-run only affected cases when this cleanup changes behavior.

- [ ] **Step 6: Run final broad gate and independent review**

Run `pnpm run typecheck` after all typed contract changes if it has not already run for the final tree. Run the required broad gate against the exact final tree; the ordinary focused task commit is Step 7. If the parent has already made a content-identical checkpoint for cloud image reuse, retain that checkpoint and record its SHA:

```bash
GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='Complete Freshcodex verification' pnpm run check
```

Expected: PASS for typecheck, client/cloud with local-only hosted companion, Rust sandbox and Electron; retain full phase results and no skipped required Codex behavior. `check` plus focused cloud browser receipts is the required final evidence; do not duplicate an entire green gate without a later change/failure concern. Run Rust fmt/clippy as required by existing filtered pre-push workflow and fix actual failures without bypassing hooks. A shared protocol/store surface changed, so the impacted set is the full supported suite.

The parent runs the specified fresh independent spec-plus-quality review against committed delta and the complete unchanged User Request. Use configured `lunaroute/glm-5.3` first through `/home/dan/.config/opencode/skills/darkforge/scripts/fresheyes/opencode-reviewer-transport.py` and the usual review supervisor. Only actual provider/auth/billing unavailability permits the explicit `openai/gpt-6.1-sol` reviewer `variant:xhigh` fallback. Resolve substantiated findings by the supplied usual scope dispositions, rerun affected tests after repairs and rerun the broad gate when a repaired shared boundary requires it. Do not silently substitute GLM 5.2 or bundled older GPT. No PR/deploy action occurs in this step.

- [ ] **Step 7: Commit and hand off the verified branch**

```bash
git add test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs test/fixtures/coding-cli/codex-app-server/schema-inventory.ts test/fixtures/coding-cli/codex-app-server/schema-traceability.ts test/e2e-browser/specs/freshcodex-live-transcript-rust.spec.ts test/e2e-browser/specs/fresh-agent-rest-codex-rust.spec.ts test/e2e-browser/specs/fresh-agent-control-rust.spec.ts test/e2e-browser/specs/fresh-agent-attention-reconnect-rust.spec.ts test/e2e-browser/specs/freshagent-live-model-convergence-rust.spec.ts test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts test/integration/providers/codex-local-provider.mjs test/integration/providers/codex-cli-contract.mjs test/integration/providers/codex-cli-contract.test.ts test/integration/server/fresh-agent-parity.test.ts README.md docs/index.html
git commit -m "test(codex): prove complete Freshagent workflows"
```

Commit any later review fixes separately. The file lists above are the exact intended task ownership; leave unchanged tracked entries unstaged, and if implementing a listed behavior necessarily modifies another already-read caller/constructor, record that exact path in the task receipt and stage it explicitly as well. Never stage unrelated work. Verify clean feature worktree, focused history and no unrelated files; push the feature branch using the existing hooks. Report what changed, native/local/hosted/browser evidence, commit/branch, and any real remaining finding disposition. Ask the user for the repository-required explicit approval to open/land a PR only after the result is concrete and reviewable. Do not create a PR in advance, merge, clean up the worktree, deploy, or restart production.

## Mandatory self-review of this implementation plan

1. **Current intent:** The complete dispatcher-authored User Request is unchanged exactly once. No obligation or accepted residual was rewritten. The ten tasks retain the complete original user-visible coverage.
2. **Early proof and version:** Task 1 is an independently testable actual-native/managed-runtime upgrade, with staged cloud/offline execution and hard native F1/F2/F3/F6/F7 gates before dependent implementation. Managed Codex 0.147→0.164 alignment follows that early proof, preserves other provider pins, and deploys nothing. Artifact metadata is not execution evidence; only actually executed platforms are claimed.
3. **Source authority:** Event revisions cover consumed application events only. Active bodies remain event-owned, independent partial reads are nonappendable previews, complete native/event bodies replace atomically, and generation/retained-history membership prevents late reads/deltas from recreating removed/final history. No eight-entry-cache finality dependency, shared native watermark or new generic clock/journal is assumed.
4. **Ownership and receipts:** Acceptance, same-ID steering, Stop acknowledgement, ambiguity and actual terminal settlement are separate. Child observation is explicitly parent-scoped and read-only locally and managed; no create/resume/release predicate is inferred from completed activity. Existing identity/handoff/fork/undo/names/cleanup fences remain authoritative.
5. **Host and catalogs:** Provider-retained projection/attention/pending state precedes lossy broadcast and a reliable coalesced worker recovers the last dropped frame without requiring another token. Elicitation joins durable pending-decision conversion. Existing payload extensions already forward; cwd/work-mode valid_scopes is a known Task 8 update. Pre-create catalog is pending, ordinary create binds context, only that current provider is probed, and source changes invalidate stale cache/replies. List omission never rejects exact custom intent.
6. **Outcome map:** Task 1 supplies actual native/runtime evidence and version alignment; 2 covers streaming/usage/plan/diff; 3 native items/declined outcomes/parent child view; 4 turn/Stop races; 5 native controls/MCP/deadman; 6 retained attention and hosted loss; 7 catalog/model/effort; 8 complete settings/Plan; 9 REST/CLI/MCP; 10 final actual-native/real-Rust/fake-native/browser/hosted/regression/documentation proof.
7. **Tests and interfaces:** Every task retains seven red/green/refactor/impact/commit steps. Deterministic barriers test both native-read/consumer schedules, old mutation reads, final bodies beyond cache eviction, real response IDs, same-ID steering and last-frame channel loss. Complete representative snippets exercise actual behavior. New symbols/paths are declared, exact focused helper/cloud commands remain, and required cloud cases must be discovered/executed. No missing-artifact/native scenario skip or cloud→local substitute is allowed.
8. **Operations and status:** Root dependencies/lock/workspaces/.bin, global configuration and host production CLI remain unchanged; managed pin change is branch-only. Secrets stay out of persistence/logs. Existing executable volume/test-image staging avoids offline downloads and undersized tmpfs. README/mock cover major changes. Plan publication is documentation-only; formal load-bearing validation, independent plan review and implementation remain separate required steps.

**Self-review result:** PASS for source-plan publication: ten tasks, seventy checkbox steps, the complete unchanged User Request exactly once, and explicit files/interfaces/commands. Native execution, image staging/pin behavior and resulting native claim verdicts remain mandatory early implementation gates; they are not claimed as verified by this documentation commit. The coordinator owns subsequent formal workflow transitions.
