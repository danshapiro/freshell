# Fresh Agent Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Claude-shaped rich client with a shared fresh-agent platform, migrate `freshclaude` onto it, and ship `freshcodex` on the same foundation using the Codex app-server as the source of truth.

**Architecture:** Introduce a provider registry plus runtime adapter layer that owns thread lifecycle, event streaming, capabilities, and durable history for all rich agent clients. The server normalizes each provider into a shared thread read model with provider-native extension payloads preserved, and the client renders a shared shell driven by capabilities rather than provider-specific branches.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, WebSocket/Zod contracts, existing read-model lanes, Claude SDK bridge, Codex app-server, Vitest, Testing Library, Playwright-style e2e harnesses already in this repo.

---

## Steady-State Product Behavior

- `freshclaude` and `freshcodex` open the same shared rich-agent pane chrome, transcript layout, composer, review/diff surfaces, approval UI, child-thread tree, and mobile-responsive navigation.
- Session identity is explicit and stable:
  - `sessionType` remains the user-facing identity (`freshclaude`, `freshcodex`, later `freshopencode`).
  - `provider` remains the underlying runtime family (`claude`, `codex`, later `opencode`).
  - Runtime sessions are addressed by provider-aware thread locators, never inferred from terminal panes.
- Rich panes resume, reconnect, and recover from refresh using provider runtime state plus durable history; raw terminal mode remains a separate pane type, not a hidden fallback.
- Forking, diffs, review, approvals/questions, subagents/child threads, worktree operations, and token/context indicators are shared features surfaced when the adapter capability says they are supported.
- Errors are explicit and user-friendly. If a provider runtime is unavailable or misconfigured, the pane shows a rich-client error with actionable guidance; it does not silently degrade into terminal scraping.
- `freshopencode` is not shipped in this plan, but the registry, capability model, and normalized read model must admit it without another architecture reset.

## Contracts And Invariants

### Provider/runtime boundaries

- The provider registry is the single source of truth for rich-agent identities, labels, icons, default settings, and runtime adapter binding.
- Runtime adapters own lifecycle operations: `create`, `resume`, `fork`, `interrupt`, `send`, `answerQuestion`, `resolveApproval`, `listThreads`, `getThreadSnapshot`, `getTurnPage`, `getTurnBody`, `subscribe`, and capability-backed workspace actions.
- Terminal stdout is never the authoritative source for rich-agent transcript state.
- Adapters may expose provider-native extension payloads, but all shared UI reads from the normalized thread model first.

### Normalized thread model

- A normalized thread contains stable identifiers for thread, turn, item, approval, question, artifact, diff, child-thread, and worktree references.
- The model preserves provider-native detail in typed extension blobs instead of flattening every provider to the lowest common denominator.
- Read-model endpoints remain lane-aware (`critical`, `visible`, `background`) and revisioned; the client never mixes bodies from one revision with summaries from another.
- Durable history and live replay must merge into a single canonical thread view. The existing ledger strategy survives, but it moves behind the Claude runtime adapter rather than defining the platform contract.

### Cutover invariants

- By the end of the implementation, all rich-agent panes use the new `fresh-agent` runtime/read-model stack; the old `sdk.*` transport and `agentChatSlice` are removed or reduced to compatibility shims only where unavoidable inside the final architecture.
- Existing `freshclaude` sessions continue to appear in the sidebar as `sessionType: 'freshclaude'` and reopen into the shared rich pane.
- New `freshcodex` sessions persist as `sessionType: 'freshcodex'`, retain fork lineage/worktree metadata, and can be resumed from the sidebar/history surfaces.
- `freshopencode` support is represented in types/capabilities/registry design, but no user-visible OpenCode pane is shipped in this plan.

## File Structure

### Create

- `shared/fresh-agent.ts`
  - Shared Zod schemas and TypeScript types for runtime capabilities, thread locators, thread snapshots, turn items, review/diff refs, approvals, questions, child threads, worktrees, and WS message payloads.
- `server/fresh-agent/provider-registry.ts`
  - Server-side registry binding `sessionType` and runtime provider names to adapter factories and capability declarations.
- `server/fresh-agent/runtime-adapter.ts`
  - Core runtime adapter interfaces, operation/result types, and shared error taxonomy.
- `server/fresh-agent/runtime-manager.ts`
  - Orchestrates active runtime sessions, subscriptions, replay, recovery, and thread locator resolution across adapters.
- `server/fresh-agent/router.ts`
  - HTTP read-model routes for thread snapshot/turn pages/turn bodies and capability-backed actions that belong on REST.
- `server/fresh-agent/ws.ts`
  - Shared rich-agent WebSocket message handlers/events replacing the current `sdk.*` protocol.
- `server/fresh-agent/adapters/claude/adapter.ts`
  - Claude runtime adapter wrapping the existing SDK bridge and durable history ledger.
- `server/fresh-agent/adapters/claude/normalize.ts`
  - Claude event/history to normalized thread model mapping.
- `server/fresh-agent/adapters/codex/adapter.ts`
  - Codex runtime adapter built on the Codex app-server lifecycle, thread, fork, worktree, and review APIs.
- `server/fresh-agent/adapters/codex/client.ts`
  - Codex app-server client, request marshalling, stream subscription, and error mapping.
- `server/fresh-agent/adapters/codex/normalize.ts`
  - Codex protocol/thread history to normalized thread model mapping.
- `server/fresh-agent/adapters/shared/workspace.ts`
  - Shared workspace/repo helpers used by review, diff, and worktree capability actions across adapters.
- `src/lib/fresh-agent-registry.ts`
  - Client-side registry metadata for `freshclaude`, `freshcodex`, and future `freshopencode`.
- `src/lib/fresh-agent-capabilities.ts`
  - Selectors/helpers for capability-driven UI rendering.
- `src/lib/fresh-agent-ws.ts`
  - Client message handler for the new rich-agent WS protocol.
- `src/store/freshAgentTypes.ts`
  - Normalized client state types keyed by thread locator and revision.
- `src/store/freshAgentSlice.ts`
  - Redux slice for runtime session state, snapshot pages, streaming items, pending approvals/questions, and action errors.
- `src/store/freshAgentThunks.ts`
  - Async thunks for snapshot/page/body loading and capability-backed actions.
- `src/components/fresh-agent/FreshAgentView.tsx`
  - Shared top-level rich pane replacing `AgentChatView`.
- `src/components/fresh-agent/FreshAgentTranscript.tsx`
  - Virtualized turn/item list with lazy body hydration and mobile-friendly rendering.
- `src/components/fresh-agent/FreshAgentComposer.tsx`
  - Shared composer/action footer for send, interrupt, fork, and capability actions.
- `src/components/fresh-agent/FreshAgentSidebar.tsx`
  - Child-thread/worktree/review navigation inside the pane.
- `src/components/fresh-agent/FreshAgentApprovalBanner.tsx`
  - Shared approval UI.
- `src/components/fresh-agent/FreshAgentQuestionBanner.tsx`
  - Shared question UI.
- `src/components/fresh-agent/FreshAgentDiffPanel.tsx`
  - Shared diff/review presentation that supersedes the current Claude-only diff block.
- `src/components/fresh-agent/renderers/*`
  - Focused item renderers for text, reasoning, tool calls/results, diffs, approvals, and provider extension blocks.
- `test/fixtures/fresh-agent/claude/*`
  - Claude normalized fixture inputs/outputs for restore, approval, diff, and child-session flows.
- `test/fixtures/fresh-agent/codex/*`
  - Codex normalized fixture inputs/outputs for create, fork, worktree, review, and child-session flows.
- `test/unit/server/fresh-agent/*.test.ts`
  - Adapter contract tests, runtime manager tests, router tests, and protocol tests.
- `test/unit/client/fresh-agent/*.test.tsx`
  - Slice, thunk, renderer, and view tests.
- `test/e2e/fresh-agent-*.test.tsx`
  - Shared rich-agent flows covering both `freshclaude` and `freshcodex`.

### Modify

- `shared/ws-protocol.ts`
  - Replace `sdk.*` rich-agent messages with `freshAgent.*` create/attach/subscribe/action events and update shared schemas.
- `server/ws-handler.ts`
  - Route rich-agent WS traffic through `runtime-manager` instead of directly through `SdkBridge`.
- `server/index.ts`
  - Mount fresh-agent router/services and inject them into bootstrap/server startup.
- `server/agent-timeline/*`
  - Keep ledger/history logic, but narrow it to Claude adapter internals or move shared pieces behind adapter-agnostic names.
- `server/sdk-bridge.ts`
  - Retain only Claude SDK process concerns that remain under the Claude adapter; remove top-level platform assumptions.
- `server/sdk-bridge-types.ts`
  - Retire or rename Claude-specific transport types once their responsibilities move into `shared/fresh-agent.ts`.
- `server/sessions-router.ts`
  - Teach resume/session metadata surfaces about `freshcodex` and rich-thread locators.
- `server/session-directory/*`
  - Project normalized rich-thread metadata, fork lineage, child-thread hints, and capability badges into the sidebar/history directory.
- `server/coding-cli/providers/codex.ts`
  - Keep non-rich terminal session indexing only; remove pressure to serve as the future rich runtime API.
- `src/components/agent-chat/*`
  - Reuse narrowly useful pieces or retire them in favor of `src/components/fresh-agent/*`.
- `src/store/agentChatSlice.ts`
  - Remove rich-client ownership after migration or collapse it into a thin backward-compatibility layer before deletion.
- `src/store/agentChatThunks.ts`
  - Same as above; move read-model loading to `freshAgentThunks`.
- `src/components/panes/PaneContainer.tsx`
  - Swap rich-agent pane rendering and create/resume behavior to the shared `FreshAgentView`.
- `src/store/paneTypes.ts`
  - Add `freshcodex` and normalize rich pane type metadata for the new platform.
- `src/store/tabsSlice.ts`
  - Open/resume shared rich panes based on registry data and persisted thread locators.
- `src/lib/session-type-utils.ts`
  - Build resume content and labels for `freshcodex` using the shared registry.
- `src/lib/agent-chat-utils.ts`
  - Remove or reduce to compatibility exports after the registry cutover.
- `src/components/Sidebar.tsx`
  - Continue to use `sessionType` but source provider metadata and resume actions from the new registry/capability model.
- `docs/index.html`
  - Update the nonfunctional mock if the visible fresh-agent experience changes materially.

## Strategy Gate

The direct path is to build the steady-state platform now, then migrate both rich clients onto it during the same implementation. Extending the current `sdk.*` contract into a pseudo-generic shape would preserve the wrong abstraction boundary: the current contract bakes Claude session semantics, Claude durable history assumptions, and message-array rendering into the platform. Codex app-server and future OpenCode server APIs are runtime products in their own right; treating them as terminal cousins would force permanent provider branches, duplicated UI, and another rewrite later. This plan therefore lands the final runtime-adapter architecture directly, preserves the proven Claude ledger strategy as an adapter implementation detail, and keeps `freshopencode` in scope only as a design constraint.

### Task 1: Define the fresh-agent contract, registry, and capability model

**Files:**
- Create: `shared/fresh-agent.ts`
- Create: `server/fresh-agent/runtime-adapter.ts`
- Create: `server/fresh-agent/provider-registry.ts`
- Create: `src/lib/fresh-agent-registry.ts`
- Create: `src/lib/fresh-agent-capabilities.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `src/store/paneTypes.ts`
- Test: `test/unit/server/fresh-agent/provider-registry.test.ts`
- Test: `test/unit/shared/fresh-agent-contract.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Add contract tests that pin the final schema and registry semantics:

```ts
it('declares freshclaude and freshcodex as rich session types with explicit runtime providers', () => {
  expect(resolveFreshAgentType('freshclaude')).toMatchObject({ runtimeProvider: 'claude' })
  expect(resolveFreshAgentType('freshcodex')).toMatchObject({ runtimeProvider: 'codex' })
})

it('exposes capability flags without collapsing provider-specific extensions', () => {
  expect(FreshAgentThreadSnapshotSchema.parse(snapshotFixture).capabilities.review).toBe(true)
  expect(snapshotFixture.providerExtensions?.codex).toBeDefined()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/provider-registry.test.ts test/unit/shared/fresh-agent-contract.test.ts`
Expected: FAIL because the fresh-agent contract and registry do not exist yet.

- [ ] **Step 3: Write the minimal implementation**

Implement the shared `fresh-agent` schema and runtime adapter interface. Define:

- `FreshAgentSessionType = 'freshclaude' | 'freshcodex' | 'freshopencode'`
- `FreshAgentRuntimeProvider = 'claude' | 'codex' | 'opencode'`
- capability groups for transcript, approvals, questions, diffs/review, forking, worktrees, child threads, token budgets, and provider extension panels
- normalized thread locator, snapshot, turn page, turn body, item, approval, question, artifact, diff, child-thread, and worktree types
- registry entries for `freshclaude` and `freshcodex`, plus a disabled future-facing `freshopencode` config

Update pane types and WS protocol stubs so the rest of the migration has a stable contract to target.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/provider-registry.test.ts test/unit/shared/fresh-agent-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Refactor naming to make the boundary crisp:

- shared/provider-agnostic types live in `shared/fresh-agent.ts`
- server lifecycle abstractions live in `runtime-adapter.ts`
- registry carries only declarative metadata, not runtime logic

Run: `npm run test:vitest -- test/unit/server/fresh-agent/provider-registry.test.ts test/unit/shared/fresh-agent-contract.test.ts test/unit/server/ws-handler-sdk.test.ts`
Expected: PASS with no diluted assertions.

- [ ] **Step 6: Commit**

```bash
git add shared/fresh-agent.ts server/fresh-agent/runtime-adapter.ts server/fresh-agent/provider-registry.ts src/lib/fresh-agent-registry.ts src/lib/fresh-agent-capabilities.ts shared/ws-protocol.ts src/store/paneTypes.ts test/unit/server/fresh-agent/provider-registry.test.ts test/unit/shared/fresh-agent-contract.test.ts
git commit -m "feat: define fresh agent platform contracts"
```

### Task 2: Build the runtime manager and replace the top-level rich-agent transport

**Files:**
- Create: `server/fresh-agent/runtime-manager.ts`
- Create: `server/fresh-agent/ws.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Modify: `shared/ws-protocol.ts`
- Test: `test/unit/server/fresh-agent/runtime-manager.test.ts`
- Test: `test/unit/server/fresh-agent/ws.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Write tests that prove the server now routes rich-agent traffic through the new manager:

```ts
it('routes freshAgent.create to the adapter selected by sessionType', async () => {
  expect(adapter.createThread).toHaveBeenCalledWith(expect.objectContaining({ sessionType: 'freshcodex' }))
})

it('does not emit subscribed thread state when create cutover fails transactionally', async () => {
  expect(messages).toContainEqual(expect.objectContaining({ type: 'freshAgent.create.failed' }))
  expect(messages).not.toContainEqual(expect.objectContaining({ type: 'freshAgent.created' }))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/runtime-manager.test.ts test/unit/server/fresh-agent/ws.test.ts`
Expected: FAIL because the manager and protocol handler do not exist.

- [ ] **Step 3: Write the minimal implementation**

Implement `runtime-manager` with:

- adapter lookup from the provider registry
- create/attach/subscribe/send/interrupt/fork/action dispatch
- replay buffering and subscription sequencing analogous to the current `SdkBridge` guarantees
- a shared error taxonomy that maps provider failures to user-friendly transport errors

Update `server/ws-handler.ts` to hand rich-agent messages to `server/fresh-agent/ws.ts`. Keep terminal paths untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/runtime-manager.test.ts test/unit/server/fresh-agent/ws.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Refactor for one authoritative transport path. Remove any duplicated `sdk.*` routing code that would leave parallel rich-client stacks alive.

Run: `npm run test:vitest -- test/unit/server/fresh-agent/runtime-manager.test.ts test/unit/server/fresh-agent/ws.test.ts test/unit/server/ws-handler-sdk.test.ts`
Expected: PASS, with updated tests asserting `freshAgent.*` behavior instead of legacy `sdk.*` behavior where appropriate.

- [ ] **Step 6: Commit**

```bash
git add server/fresh-agent/runtime-manager.ts server/fresh-agent/ws.ts server/ws-handler.ts server/index.ts shared/ws-protocol.ts test/unit/server/fresh-agent/runtime-manager.test.ts test/unit/server/fresh-agent/ws.test.ts
git commit -m "feat: route rich agent sessions through runtime manager"
```

### Task 3: Migrate Claude runtime logic behind a Claude adapter and normalized read model

**Files:**
- Create: `server/fresh-agent/adapters/claude/adapter.ts`
- Create: `server/fresh-agent/adapters/claude/normalize.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `server/sdk-bridge-types.ts`
- Modify: `server/agent-timeline/ledger.ts`
- Modify: `server/agent-timeline/history-source.ts`
- Modify: `server/agent-timeline/service.ts`
- Modify: `server/agent-timeline/router.ts`
- Test: `test/unit/server/fresh-agent/claude-adapter.test.ts`
- Test: `test/unit/server/fresh-agent/claude-normalize.test.ts`
- Test: `test/unit/server/fresh-agent/claude-restore-contract.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Add adapter contract tests for the tricky Claude behaviors we cannot afford to regress:

- durable/live merge yields one canonical turn sequence
- attach/reconnect never fabricates a live-only snapshot when durable restore state is required
- approvals/questions/tokens normalize into shared item/state shapes
- session loss triggers recoverable runtime errors, not transcript corruption

```ts
it('maps ledger-backed restore state into a normalized thread snapshot', async () => {
  expect(snapshot.turns[0]?.items[0]?.kind).toBe('message')
  expect(snapshot.revision).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/fresh-agent/claude-normalize.test.ts test/unit/server/fresh-agent/claude-restore-contract.test.ts`
Expected: FAIL because the Claude adapter and normalized output do not exist.

- [ ] **Step 3: Write the minimal implementation**

Wrap the existing `SdkBridge` and ledger/history machinery inside the Claude adapter. The adapter should:

- keep the current replay and restore guarantees
- normalize Claude message blocks into shared turn items
- project approvals/questions/tool blocks/token summaries into capability-backed thread state
- treat ledger internals as Claude implementation details, not platform types

Keep user-visible behavior equivalent for `freshclaude`, except where the new normalized model enables the shared shell.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/fresh-agent/claude-normalize.test.ts test/unit/server/fresh-agent/claude-restore-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Delete or rename any leftover top-level Claude-specific abstractions that still pretend to be provider-generic. Keep shared reusable pieces only where the abstraction is real.

Run: `npm run test:vitest -- test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/ws-sdk-session-history-cache.test.ts test/unit/server/ws-handler-sdk.test.ts`
Expected: PASS after migrating those tests to the new adapter/transport model.

- [ ] **Step 6: Commit**

```bash
git add server/fresh-agent/adapters/claude/adapter.ts server/fresh-agent/adapters/claude/normalize.ts server/sdk-bridge.ts server/sdk-bridge-types.ts server/agent-timeline/ledger.ts server/agent-timeline/history-source.ts server/agent-timeline/service.ts server/agent-timeline/router.ts test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/fresh-agent/claude-normalize.test.ts test/unit/server/fresh-agent/claude-restore-contract.test.ts
git commit -m "refactor: move claude rich runtime behind adapter"
```

### Task 4: Implement the Codex adapter on the Codex app-server contract

**Files:**
- Create: `server/fresh-agent/adapters/codex/client.ts`
- Create: `server/fresh-agent/adapters/codex/adapter.ts`
- Create: `server/fresh-agent/adapters/codex/normalize.ts`
- Modify: `server/fresh-agent/provider-registry.ts`
- Modify: `server/coding-cli/providers/codex.ts`
- Test: `test/unit/server/fresh-agent/codex-client.test.ts`
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts`
- Test: `test/unit/server/fresh-agent/codex-normalize.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Write contract tests against recorded Codex fixtures that pin:

- thread create/resume
- fork lineage
- child thread/subagent refs
- review/diff/worktree projections
- token/context summaries
- approval/question style interactions if the app-server exposes them

```ts
it('normalizes codex review and fork metadata into shared snapshot structures', async () => {
  expect(snapshot.capabilities.review).toBe(true)
  expect(snapshot.diffRefs[0]?.baseThreadId).toBeDefined()
  expect(snapshot.childThreads[0]?.origin).toBe('subagent')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/codex-client.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/codex-normalize.test.ts`
Expected: FAIL because no Codex runtime adapter exists.

- [ ] **Step 3: Write the minimal implementation**

Implement a Codex app-server client and adapter that:

- uses app-server lifecycle/thread APIs as the source of truth
- streams updates into runtime-manager subscriptions
- normalizes Codex thread items, reviews, diffs, worktrees, and subagent metadata into the shared model
- maps provider-native details into `providerExtensions.codex`

Keep `server/coding-cli/providers/codex.ts` focused on terminal session indexing, not rich runtime behavior.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/codex-client.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/codex-normalize.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Refactor shared workspace/review helpers so Codex and Claude use the same final abstractions where the behavior is actually shared. Do not add fake generic wrappers around provider-native protocol payloads.

Run: `npm run test:vitest -- test/unit/server/fresh-agent/codex-client.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/codex-normalize.test.ts test/unit/server/fresh-agent/claude-adapter.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/fresh-agent/adapters/codex/client.ts server/fresh-agent/adapters/codex/adapter.ts server/fresh-agent/adapters/codex/normalize.ts server/fresh-agent/provider-registry.ts server/coding-cli/providers/codex.ts test/unit/server/fresh-agent/codex-client.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/codex-normalize.test.ts
git commit -m "feat: add codex fresh agent adapter"
```

### Task 5: Replace the rich read-model routes with thread snapshot/page/body endpoints

**Files:**
- Create: `server/fresh-agent/router.ts`
- Modify: `server/session-directory/projection.ts`
- Modify: `server/session-directory/service.ts`
- Modify: `server/session-directory/types.ts`
- Modify: `server/sessions-router.ts`
- Modify: `shared/read-models.ts`
- Test: `test/unit/server/fresh-agent/router.test.ts`
- Test: `test/unit/server/session-directory/fresh-agent-projection.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Add tests covering the final read-model contract:

- thread snapshot endpoint returns revisioned capability-aware snapshots
- turn page/body endpoints respect lane/revision constraints
- session directory includes `freshcodex` with stable title/sessionType/fork/subagent metadata
- router errors are explicit when a runtime is unavailable or a revision is stale

```ts
it('returns a stale-revision error instead of mixing thread revisions', async () => {
  expect(response.status).toBe(409)
  expect(response.body.code).toBe('STALE_THREAD_REVISION')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/router.test.ts test/unit/server/session-directory/fresh-agent-projection.test.ts`
Expected: FAIL because the new router and projection do not exist.

- [ ] **Step 3: Write the minimal implementation**

Implement REST routes for:

- `GET /api/fresh-agent/threads/:provider/:threadId`
- `GET /api/fresh-agent/threads/:provider/:threadId/turns`
- `GET /api/fresh-agent/threads/:provider/:threadId/turns/:turnId`
- action endpoints that belong on HTTP rather than WS when idempotent or lane-aware

Update directory projection to carry the rich metadata needed by the sidebar/history surfaces for both `freshclaude` and `freshcodex`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/router.test.ts test/unit/server/session-directory/fresh-agent-projection.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Remove obsolete `agent-timeline` route entry points once their responsibilities are fully subsumed by the new thread routes.

Run: `npm run test:vitest -- test/unit/server/fresh-agent/router.test.ts test/unit/server/session-directory/fresh-agent-projection.test.ts test/unit/visible-first/read-model-route-harness.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/fresh-agent/router.ts server/session-directory/projection.ts server/session-directory/service.ts server/session-directory/types.ts server/sessions-router.ts shared/read-models.ts test/unit/server/fresh-agent/router.test.ts test/unit/server/session-directory/fresh-agent-projection.test.ts
git commit -m "feat: add fresh agent thread read models"
```

### Task 6: Replace client rich-agent state with normalized fresh-agent Redux state

**Files:**
- Create: `src/store/freshAgentTypes.ts`
- Create: `src/store/freshAgentSlice.ts`
- Create: `src/store/freshAgentThunks.ts`
- Create: `src/lib/fresh-agent-ws.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `src/store/index.ts`
- Modify: `src/store/persistControl.ts`
- Modify: `src/store/tabsSlice.ts`
- Test: `test/unit/client/store/freshAgentSlice.test.ts`
- Test: `test/unit/client/store/freshAgentThunks.test.ts`
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Add tests for the final client state semantics:

- snapshot/page/body hydration is revision-safe
- live items merge into normalized turns without duplicate transcript blocks
- approvals/questions/action errors are stored in shared state, not provider slices
- `freshcodex` and `freshclaude` pending creates both resolve through the same path

```ts
it('stores pending approvals by thread locator independent of provider-specific payload shape', () => {
  expect(state.threads[key].pendingApprovals['req-1']).toMatchObject({ title: 'Run command?' })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/client/store/freshAgentSlice.test.ts test/unit/client/store/freshAgentThunks.test.ts test/unit/client/lib/fresh-agent-ws.test.ts`
Expected: FAIL because the new state layer does not exist.

- [ ] **Step 3: Write the minimal implementation**

Implement normalized client state keyed by thread locator. Replace the `sdk-message-handler` flow with `fresh-agent-ws` handling and move all read-model fetching into `freshAgentThunks`.

Persist only what is necessary for reconnect/resume:

- thread locator
- session type/runtime provider
- active revision cursor anchors where appropriate

Do not persist transient streaming or pending-action state.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/client/store/freshAgentSlice.test.ts test/unit/client/store/freshAgentThunks.test.ts test/unit/client/lib/fresh-agent-ws.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Remove provider-specific state duplication from `agentChatSlice` and thunks once the shared slice owns the rich client.

Run: `npm run test:vitest -- test/unit/client/store/freshAgentSlice.test.ts test/unit/client/store/freshAgentThunks.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/sdk-message-handler.test.ts`
Expected: PASS after converting legacy tests to the new path or deleting them when the old handler is gone.

- [ ] **Step 6: Commit**

```bash
git add src/store/freshAgentTypes.ts src/store/freshAgentSlice.ts src/store/freshAgentThunks.ts src/lib/fresh-agent-ws.ts src/lib/ws-client.ts src/lib/sdk-message-handler.ts src/store/index.ts src/store/persistControl.ts src/store/tabsSlice.ts test/unit/client/store/freshAgentSlice.test.ts test/unit/client/store/freshAgentThunks.test.ts test/unit/client/lib/fresh-agent-ws.test.ts
git commit -m "feat: add normalized fresh agent client state"
```

### Task 7: Build the shared fresh-agent UI shell and migrate freshclaude/freshcodex panes

**Files:**
- Create: `src/components/fresh-agent/FreshAgentView.tsx`
- Create: `src/components/fresh-agent/FreshAgentTranscript.tsx`
- Create: `src/components/fresh-agent/FreshAgentComposer.tsx`
- Create: `src/components/fresh-agent/FreshAgentSidebar.tsx`
- Create: `src/components/fresh-agent/FreshAgentApprovalBanner.tsx`
- Create: `src/components/fresh-agent/FreshAgentQuestionBanner.tsx`
- Create: `src/components/fresh-agent/FreshAgentDiffPanel.tsx`
- Create: `src/components/fresh-agent/renderers/*.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/lib/session-type-utils.ts`
- Modify: `src/lib/agent-chat-utils.ts`
- Modify: `src/components/icons/PaneIcon.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx`

- [ ] **Step 1: Identify or write the failing tests**

Add component tests that pin the final shared behavior:

- `freshclaude` and `freshcodex` render the same shell chrome
- transcript virtualization only hydrates visible turn bodies
- capability flags hide unsupported actions cleanly
- diff/review panel renders from normalized refs, not Claude-only tool blocks
- mobile layout moves secondary panes into drawers/sheets instead of crushing the transcript

```tsx
it('renders fork and worktree actions for freshcodex but not freshclaude when capabilities differ', () => {
  render(<FreshAgentView ... />)
  expect(screen.getByRole('button', { name: /fork/i })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx`
Expected: FAIL because the new shared UI does not exist.

- [ ] **Step 3: Write the minimal implementation**

Build the shared shell with:

- a virtualized transcript backed by normalized turn summaries/bodies
- reusable approval/question banners
- capability-driven action/footer rendering
- a diff/review panel that can be opened from either provider
- responsive layout for narrow/mobile widths with deferred hydration for heavy transcript sections

Switch `PaneContainer` and sidebar resume actions to the shared rich pane. `freshcodex` should appear anywhere `freshclaude` appears today.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Delete or fold old `src/components/agent-chat/*` pieces that are fully replaced. Keep only narrowly reusable presentational helpers if they still make sense under the new names.

Run: `npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
Expected: PASS after migrating or removing legacy tests with stronger coverage on the new shell.

- [ ] **Step 6: Commit**

```bash
git add src/components/fresh-agent src/components/panes/PaneContainer.tsx src/components/Sidebar.tsx src/lib/session-type-utils.ts src/lib/agent-chat-utils.ts src/components/icons/PaneIcon.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx
git commit -m "feat: ship shared fresh agent pane shell"
```

### Task 8: Wire end-to-end create/resume/fork/review flows and update docs/mocks

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `server/sessions-router.ts`
- Modify: `docs/index.html`
- Test: `test/e2e/fresh-agent-create-resume.test.tsx`
- Test: `test/e2e/fresh-agent-review-flow.test.tsx`
- Test: `test/e2e/fresh-agent-mobile-layout.test.tsx`

- [ ] **Step 1: Identify or write the failing tests**

Add e2e coverage for the user-visible flows that justify the architecture:

- create/resume `freshclaude`
- create/resume `freshcodex`
- fork a `freshcodex` thread and reopen it from the sidebar
- open a review/diff panel from both providers when supported
- mobile transcript remains usable while approvals/questions/diff panes are accessible

```ts
it('reopens a freshcodex fork from the sidebar with its lineage and worktree metadata intact', async () => {
  // assert sidebar entry, pane title, fork badge, and worktree action visibility
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/e2e/fresh-agent-create-resume.test.tsx test/e2e/fresh-agent-review-flow.test.tsx test/e2e/fresh-agent-mobile-layout.test.tsx`
Expected: FAIL because the end-to-end rich-agent cutover is incomplete.

- [ ] **Step 3: Write the minimal implementation**

Finish the wiring across sidebar/history/context-menu resume entry points, ensure metadata persistence stores `sessionType: 'freshcodex'`, and update `docs/index.html` to reflect the new shared shell where it materially differs from the previous Freshclaude-only experience.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/e2e/fresh-agent-create-resume.test.tsx test/e2e/fresh-agent-review-flow.test.tsx test/e2e/fresh-agent-mobile-layout.test.tsx`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Tighten naming and remove any leftover "agent chat" or Claude-only assumptions from user-facing resume/create paths. The shipped UI should read as one fresh-agent platform with two concrete clients.

Run: `npm run test:vitest -- test/e2e/fresh-agent-create-resume.test.tsx test/e2e/fresh-agent-review-flow.test.tsx test/e2e/fresh-agent-mobile-layout.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/tabsSlice.ts src/components/context-menu/ContextMenuProvider.tsx src/components/HistoryView.tsx src/store/selectors/sidebarSelectors.ts server/sessions-router.ts docs/index.html test/e2e/fresh-agent-create-resume.test.tsx test/e2e/fresh-agent-review-flow.test.tsx test/e2e/fresh-agent-mobile-layout.test.tsx
git commit -m "feat: complete fresh agent create resume and review flows"
```

### Task 9: Remove obsolete rich-agent paths and run the full verification gate

**Files:**
- Modify/Delete: `src/store/agentChatSlice.ts`
- Modify/Delete: `src/store/agentChatThunks.ts`
- Modify/Delete: `src/components/agent-chat/*`
- Modify/Delete: `server/sdk-bridge-types.ts`
- Modify/Delete: any other `sdk.*` rich-agent-only glue made obsolete by the final cutover
- Test: existing repo suites plus all new fresh-agent tests

- [ ] **Step 1: Identify or write the failing tests**

Use the existing repo checks as the red bar for dead-code removal. If any legacy tests only assert the old architecture, replace them with stronger fresh-agent coverage before deleting them.

- [ ] **Step 2: Run tests to verify current failures or stale references**

Run: `npm run test:vitest -- test/unit/client test/unit/server`
Expected: FAIL somewhere due to stale imports, dead files, or old `sdk.*` references after the cutover.

- [ ] **Step 3: Write the minimal implementation**

Delete obsolete files and imports, collapse compatibility shims that no longer carry real weight, and ensure the codebase has one rich-agent architecture instead of two.

- [ ] **Step 4: Run tests to verify targeted suites pass**

Run: `npm run test:vitest -- test/unit/client test/unit/server`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Run the full repository verification expected before finishing:

Run: `npm run lint`
Run: `npm run test:status`
Run: `FRESHELL_TEST_SUMMARY=\"fresh agent platform\" npm test`
Run: `npm run check`
Expected: all PASS

If any existing test fails, fix the defect rather than weakening the check.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove legacy rich agent architecture"
```

## OpenCode design constraint for later work

Do not implement `freshopencode` in this change. Do ensure the platform can support it without another contract reset:

- registry entry can exist as disabled/future-facing metadata
- normalized model already includes diff/review/worktree/child-thread concepts OpenCode will need
- runtime adapter interface permits server-driven event streams and explicit permission/command flows
- no client code assumes every provider has Claude-style block messages or Codex-style review objects

## Implementation notes for the executing agent

- Work directly in this worktree: `/home/user/code/freshell/.worktrees/fresh-agent-platform`
- Keep commits aligned to the tasks above; do not batch multiple tasks into one commit.
- Preserve unrelated changes if present.
- Do not add hidden terminal fallbacks. Show explicit rich-client errors when an adapter cannot operate.
- Prefer renaming/removing obsolete abstractions once stronger coverage exists rather than leaving long-lived compatibility layers.
