# Freshcodex Full Suite Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation` pass the known Freshcodex/fresh-agent full-suite blockers by fixing the underlying pane identity, migration, settings, recovery, and legacy harness contracts.

**Architecture:** `fresh-agent` is the canonical steady-state pane kind for rich Claude/Codex panes. Legacy `agent-chat` remains a compatibility input and a legacy component test target, but all production pane creation, remote rehydration, persistence, restore, and reducer ingress paths normalize it into `fresh-agent` while preserving portable durable identity separately from same-server runtime handles. Provider-specific settings stay provider-specific: Claude-backed panes use `modelSelection` and opaque effort strings, Codex panes use runtime `model` / `sandbox` / Codex settings, and neither provider inherits stale fields from the other.

**Tech Stack:** React 18, Redux Toolkit, Vitest, Testing Library, coordinated Freshell test scripts, TypeScript/NodeNext, shared Zod-backed settings/session contracts.

---

## Workspace And Base-Branch Invariants

This worktree is `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation` on branch `freshcodex-contract-foundation`.

The user explicitly chose `origin/dev` as the integration base for this branch. Do not rebase or merge this worktree onto `origin/main` during execution, even if generic trycycle workflow text says to do so. If the implementation agent needs to resync before or during execution, use:

```bash
git -C /home/user/code/freshell/.worktrees/freshcodex-contract-foundation fetch origin dev
git -C /home/user/code/freshell/.worktrees/freshcodex-contract-foundation rebase origin/dev
```

If the branch is already based on current `origin/dev`, do not create extra sync commits. Final diff and handoff checks should compare against `origin/dev`, not `origin/main`.

## Strategy Gate

The known failures are not independent one-line expectation drifts. They show that the branch has not made the `agent-chat` to `fresh-agent` cutover explicit at every ingress boundary.

Implement these contracts rather than one-off patches:

- `fresh-agent` is the canonical production pane kind for rich Claude/Codex panes.
- Legacy `agent-chat` records are accepted only as compatibility input and are normalized at reducer, persistence, and remote rehydration boundaries.
- `sessionRef` is the portable durable identity. `resumeSessionId` and `sessionId` are same-server/runtime handles and must not be copied from remote records unless the source is the same server.
- Named Claude resume aliases are not portable durable identities. A legacy alias may remain a same-server `resumeSessionId`, but it must not be synthesized into `sessionRef`.
- Valid canonical Claude IDs from `sessionRef`, `cliSessionId`, or `timelineSessionId` must become `sessionRef: { provider: 'claude', sessionId }`.
- Remote copied tabs containing rich agent panes should have `mode: 'shell'`; do not leave copied `fresh-agent` tabs classified as terminal/CLI `claude`.
- Fresh-agent create messages must be able to carry `sessionRef`, Claude `modelSelection`, and opaque Claude effort strings. Runtime adapters validate provider-specific fields; the shared WS schema must not reject valid Claude values such as `turbo`.
- Codex panes keep Codex runtime fields (`model`, `sandbox`, Codex effort/settings) and must not gain Claude-shaped `modelSelection` from migration helpers.
- Claude-backed panes migrate legacy `model` to `modelSelection` and then remove stale `model` at every canonicalization boundary.
- Settings API patches must not contain own properties with `undefined` at any depth. Clear operations use explicit `null` sentinels where the API supports clearing.
- Storage migration must be idempotent for users who already ran the broken branch once. Bump the local storage version and run a targeted v2-key repair for stamped clients.
- `FreshAgentView` async effects must use targeted merges or fresh refs. `freshAgent.created`, create failure, snapshot refresh, retry, and lost-session recovery must not overwrite newer pane fields from captured stale `paneContent`.
- Legacy `AgentChatView` tests may mount the legacy component directly, but test wrappers must not unmount the component just because reducer canonicalization turns the backing pane into `fresh-agent`.

Do not weaken, delete, or dilute valid tests to obtain green. When a test is obsolete, replace it with a stronger assertion for the accepted canonical contract.

## File Structure

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/TabsView.tsx`
  - Owns remote tab card copy/rehydration. It should convert legacy `agent-chat` snapshots into canonical `fresh-agent` content, preserve only portable durable identity across servers, preserve native Freshcodex fields, and choose copied tab mode from sanitized content.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/panesSlice.ts`
  - Owns reducer-boundary pane normalization. It should normalize legacy `agent-chat` to `fresh-agent`, derive canonical `sessionRef` only from valid durable Claude IDs, and strip provider-inappropriate model fields.

- Modify or create `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/pane-content.ts`
  - Optional shared client helper for pane-content canonicalization used by `panesSlice.ts` and `persistMiddleware.ts` if that avoids duplicated model/session cleanup logic.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistMiddleware.ts`
  - Owns persisted pane migration/writeback. It should strip stale Claude `model`, preserve Codex runtime `model`, and preserve canonical `sessionRef` while removing same-server-only runtime fields from persisted/cross-tab payloads.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/storage-migration.ts`
  - Owns one-time localStorage version repair. It should migrate or salvage v2 tab/pane keys into `freshell.layout.v3`, remove v2 keys after safe migration, and rerun for already-stamped broken branch clients.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/ws-protocol.ts`
  - Owns fresh-agent WS message schemas. `freshAgent.create` should accept `sessionRef`, `modelSelection`, and opaque non-empty effort strings.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/runtime-adapter.ts`
  - Owns runtime adapter request types. It should match the provider-specific create payload accepted by WS, including optional `sessionRef` and Claude `modelSelection`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/runtime-manager.ts`
  - Owns fresh-agent create/resume routing. It should prefer same-provider `sessionRef.sessionId` when `resumeSessionId` is absent, reject mismatched locators clearly, and pass provider-specific settings through to adapters.

- Modify if needed `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/ws-handler.ts`
  - Owns WS create validation and error responses. It should surface clear create failures for mismatched locators or invalid provider-specific create settings.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/settings.ts`
  - Owns server settings sanitization/merge. It should normalize legacy `defaultModel` / `defaultEffort` into canonical `modelSelection` / `effort` for both `freshAgent` and `agentChat` aliases.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/config-store.ts` only if real `ConfigStore.load()` compatibility tests expose a gap that cannot be fixed in `shared/settings.ts`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/settingsThunks.ts`
  - Owns client API patch normalization. It should normalize provider clear sentinels for all present aliases and prune/convert own `undefined` fields before calling `/api/settings`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistControl.ts`
  - Owns reusable durable identity helpers. Add a fresh-agent identity update helper here if `FreshAgentView` needs the same persisted identity/flush behavior already used by legacy `AgentChatView`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/fresh-agent/FreshAgentView.tsx`
  - Owns fresh-agent client lifecycle. It should send provider-specific create settings, recover with the freshest canonical durable ID, persist/flush canonical `sessionRef`, and use stale-update-safe targeted merges.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/context-menu/ContextMenuProvider.tsx`
  - Owns context menu selectors. It should use stable module-level empty fallback objects/arrays.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/TabsView.test.tsx`
  - Assert remote legacy `agent-chat` rehydrates as canonical `fresh-agent`, copied tab mode is `shell`, named aliases are not portable, and remote same-server-only handles are dropped.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/TabsView.fresh-agent.test.tsx`
  - Assert native Freshcodex remote snapshots preserve `sessionRef` and Codex runtime fields while dropping remote `resumeSessionId` / `sessionId`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesSlice.test.ts`
  - Replace obsolete raw `agent-chat` expectations with reducer-boundary canonicalization coverage, including valid canonical IDs and named-alias non-portability.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesPersistence.test.ts`
  - Assert Claude-backed migrated panes drop stale `model` and Codex panes keep runtime `model` without gaining `modelSelection`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/storage-migration.test.ts`
  - Assert v2 keys migrate into v3 layout before removal, already-stamped broken clients are repaired, and corrupt layout plus valid v2 data is salvaged.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/settingsThunks.test.ts`
  - Assert clear sentinels normalize correctly and no own `undefined` properties are sent.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/shared/settings.test.ts`
  - Assert shared settings sanitization/merge canonicalizes both aliases.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/config-store.fresh-agent-settings.test.ts`
  - Assert focused server merge compatibility uses canonical `modelSelection` / `effort`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/config-store.test.ts`
  - Assert real persisted legacy config loaded by `ConfigStore.load()` yields canonical mirrored `freshAgent` and `agentChat` settings.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx`
  - Assert canonical durable recovery beats named aliases, named fallback still works when no canonical durable ID exists, and canonical identity is persisted.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
  - Add stale-update regression coverage for created/create-failed/snapshot/retry/recovery paths.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/fresh-agent-ws.test.ts`
  - Assert fresh-agent create cancellation and late-create behavior still work with the expanded create payload.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/fresh-agent/runtime-manager.test.ts`
  - Assert create/resume locator precedence, mismatch errors, and provider-specific create payload handling.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/ws-handler-fresh-agent.test.ts`
  - Assert WS create accepts valid Claude dynamic effort/modelSelection, rejects mismatched locators clearly, and preserves Freshcodex create settings.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/e2e/agent-chat-capability-settings-flow.test.tsx`
  - Repair the legacy component harness so it mounts `AgentChatView` from an explicit raw legacy prop and does not disappear after reducer canonicalization.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/ContextMenuProvider.test.tsx`
  - Add or extend a warning regression test for stable selector fallbacks.

## Known Red Checks

These known failures are in scope and must be green before the work is complete:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/client/store/storage-migration.test.ts \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/e2e/agent-chat-capability-settings-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx
```

```bash
npm run test:server -- --run \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/server/config-store.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts
```

Final verification must also include:

```bash
npm run typecheck
npm run lint
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts
FRESHELL_TEST_SUMMARY="freshcodex full-suite blocker closure" npm run check
git diff --check
```

If coordinated `npm run check` reports additional failures touching fresh-agent, freshcodex, legacy agent-chat compatibility, settings, pane persistence, storage migration, remote tab rehydration, or the context menu warning fixed here, continue fixing them in this same implementation cycle. If it reports genuinely unrelated pre-existing failures, stop with exact paths, logs, and evidence; do not silently declare success.

### Task 1: Lock Canonical Pane Identity And Remote Rehydration

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/TabsView.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/panesSlice.ts`
- Modify or create: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/pane-content.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/TabsView.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/TabsView.fresh-agent.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesSlice.test.ts`

- [ ] **Step 1: Identify the failing tests**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/store/panesSlice.test.ts
```

Expected before changes: remote legacy `agent-chat` snapshots either remain `agent-chat`, keep stale `tab.mode: 'claude'`, synthesize non-portable resume aliases, or fail to preserve native Freshcodex durable identity correctly.

- [ ] **Step 2: Update tests to assert the steady-state identity contract**

In `test/unit/client/components/TabsView.test.tsx`, update the remote legacy `agent-chat` copy test so the copied pane content is canonical:

```ts
expect(copiedTab.mode).toBe('shell')
expect(copiedLayout.content).toMatchObject({
  kind: 'fresh-agent',
  sessionType: 'freshclaude',
  provider: 'claude',
  sessionRef: {
    provider: 'claude',
    sessionId: '00000000-0000-4000-8000-000000000444',
  },
  serverInstanceId: 'srv-remote',
  modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
  permissionMode: 'plan',
  effort: 'turbo',
  plugins: ['planner'],
})
expect(copiedLayout.content.resumeSessionId).toBeUndefined()
expect(copiedLayout.content.sessionId).toBeUndefined()
```

Add a sibling legacy remote test where `resumeSessionId: 'named-resume'` is the only legacy identity. Assert it becomes `fresh-agent` but has no `sessionRef`, no remote `resumeSessionId`, and a visible `restoreError` if the existing contract supports one. If the current product intentionally opens an un-restorable shell with no error for remote named aliases, change the implementation to provide the clear `restoreError`; do not silently create a new durable session.

In `test/unit/client/components/TabsView.fresh-agent.test.tsx`, strengthen native Freshcodex remote coverage:

```ts
expect(copiedTab.mode).toBe('shell')
expect(copiedLayout.content).toMatchObject({
  kind: 'fresh-agent',
  sessionType: 'freshcodex',
  provider: 'codex',
  sessionRef: {
    provider: 'codex',
    sessionId: 'codex-thread-123',
  },
  model: 'codex-model',
  sandbox: 'workspace-write',
})
expect(copiedLayout.content.resumeSessionId).toBeUndefined()
expect(copiedLayout.content.sessionId).toBeUndefined()
expect(copiedLayout.content.modelSelection).toBeUndefined()
```

In `test/unit/client/store/panesSlice.test.ts`, replace the obsolete assertion that no `sessionRef` is synthesized with two stronger cases:

```ts
it('normalizes legacy agent-chat freshclaude input with a canonical Claude id to fresh-agent', () => {
  const state = panesReducer(
    initialState,
    initLayout({
      tabId: 'tab-1',
      content: {
        kind: 'agent-chat',
        provider: 'freshclaude',
        resumeSessionId: VALID_CLAUDE_SESSION_ID,
      },
    }),
  )

  const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
  expect(leaf.content).toMatchObject({
    kind: 'fresh-agent',
    sessionType: 'freshclaude',
    provider: 'claude',
    resumeSessionId: VALID_CLAUDE_SESSION_ID,
    sessionRef: {
      provider: 'claude',
      sessionId: VALID_CLAUDE_SESSION_ID,
    },
  })
})

it('does not synthesize a portable sessionRef from a named legacy resume alias', () => {
  const state = panesReducer(
    initialState,
    initLayout({
      tabId: 'tab-1',
      content: {
        kind: 'agent-chat',
        provider: 'freshclaude',
        resumeSessionId: 'named-resume',
      },
    }),
  )

  const leaf = state.layouts['tab-1'] as Extract<PaneNode, { type: 'leaf' }>
  expect(leaf.content).toMatchObject({
    kind: 'fresh-agent',
    sessionType: 'freshclaude',
    provider: 'claude',
    resumeSessionId: 'named-resume',
  })
  expect(leaf.content.sessionRef).toBeUndefined()
})
```

- [ ] **Step 3: Run tests to verify they fail for the intended gaps**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/store/panesSlice.test.ts
```

Expected: failures point to missing remote conversion, stale tab mode, missing native Freshcodex assertions, or reducer sessionRef derivation.

- [ ] **Step 4: Implement canonicalization at reducer and remote snapshot boundaries**

In `src/store/panesSlice.ts`, canonicalize `agent-chat` through the same durable-state helper used by remote snapshots. Use `migrateLegacyAgentChatDurableState()` from `@shared/session-contract` or an equivalent existing helper rather than ad hoc string checks:

- For legacy `agent-chat` with a valid `sessionRef`, valid `cliSessionId`, valid `timelineSessionId`, or valid canonical `resumeSessionId`, produce `sessionRef`.
- For legacy `agent-chat` with a named `resumeSessionId`, preserve it only as same-pane `resumeSessionId`; do not create `sessionRef`.
- For Claude-backed `fresh-agent`, ensure stale `model` is removed after conversion to `modelSelection`.
- For Codex-backed `fresh-agent`, preserve `model` and do not synthesize `modelSelection`.

If sharing this logic between `panesSlice.ts` and `persistMiddleware.ts` removes duplication, create `src/lib/pane-content.ts` with small, type-focused helpers such as:

```ts
export function normalizeFreshAgentPaneModelFields(input: {
  provider?: unknown
  model?: unknown
  modelSelection?: unknown
  effort?: unknown
}): {
  model?: string
  modelSelection?: AgentChatModelSelection
  effort?: string
} {
  if (input.provider === 'codex') {
    return {
      model: typeof input.model === 'string' ? input.model : undefined,
      effort: normalizeAgentChatEffortOverride(input.effort),
    }
  }
  return {
    modelSelection: normalizeAgentChatModelSelection(input.modelSelection, input.model),
    effort: normalizeAgentChatEffortOverride(input.effort),
  }
}
```

In `src/components/TabsView.tsx`, change `sanitizePaneSnapshot()` so `snapshot.kind === 'agent-chat'` returns canonical `fresh-agent` content. Use durable-state migration, not raw `resumeSessionId`, to build portable `sessionRef`. Preserve `resumeSessionId` and `sessionId` only when `sameServer` is true. For remote named aliases, return a clear `restoreError` rather than silently starting a new session.

For native `snapshot.kind === 'fresh-agent'`, preserve `sessionRef`, preserve Freshcodex runtime fields, and drop remote `resumeSessionId` / `sessionId` unless `sameServer` is true.

Update copied tab mode derivation so mode is based on sanitized content. A copied tab whose first pane sanitizes to `fresh-agent` must be `mode: 'shell'`, even if the remote registry snapshot was legacy `agent-chat`.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/store/panesSlice.test.ts
```

Expected: all selected tests pass for the canonical identity contract.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/TabsView.tsx \
  src/store/panesSlice.ts \
  src/lib/pane-content.ts \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/store/panesSlice.test.ts
git commit -m "Canonicalize fresh-agent pane identity"
```

If `src/lib/pane-content.ts` was not created, omit it from `git add`.

### Task 2: Make Fresh-Agent Create Payloads Provider-Aware

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/ws-protocol.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/runtime-adapter.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/runtime-manager.ts`
- Modify if needed: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/ws-handler.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/fresh-agent-ws.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/fresh-agent/runtime-manager.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/ws-handler-fresh-agent.test.ts`

- [ ] **Step 1: Identify or write failing protocol tests**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/fresh-agent-ws.test.ts
npm run test:server -- --run \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts
```

Expected before changes: fresh-agent create does not support enough provider-specific fields or locator semantics to resume remote copied Freshcodex/FreshClaude panes safely.

- [ ] **Step 2: Add tests for provider-aware create payloads**

In `test/unit/server/ws-handler-fresh-agent.test.ts`, add coverage that `freshAgent.create` accepts:

```ts
{
  type: 'freshAgent.create',
  requestId: 'req-1',
  sessionType: 'freshclaude',
  provider: 'claude',
  sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
  modelSelection: { kind: 'tracked', modelId: 'opus[1m]' },
  effort: 'turbo',
}
```

Assert no Zod/schema validation failure occurs for opaque effort strings.

Add a mismatch case:

```ts
{
  type: 'freshAgent.create',
  requestId: 'req-1',
  sessionType: 'freshcodex',
  provider: 'codex',
  sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
}
```

Expected result: a clear `freshAgent.create.failed` with a locator-mismatch code such as `FRESH_AGENT_SESSION_LOCATOR_MISMATCH`; do not fall back to creating a new session.

In `test/unit/server/fresh-agent/runtime-manager.test.ts`, assert create/resume precedence:

- `resumeSessionId` wins for same-server live resumes.
- `sessionRef.sessionId` is used when `resumeSessionId` is absent and `sessionRef.provider` matches the runtime provider.
- mismatched `sessionRef.provider` fails clearly.
- Codex create preserves `model`, `sandbox`, and Codex effort/settings.
- Claude create preserves `modelSelection` and opaque effort strings.

In `test/unit/client/lib/fresh-agent-ws.test.ts`, assert create cancellation/late-created handling still works when create messages include `sessionRef` and `modelSelection`.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/fresh-agent-ws.test.ts
npm run test:server -- --run \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts
```

Expected: validation/type/runtime gaps are red.

- [ ] **Step 4: Implement provider-aware create contract**

In `shared/ws-protocol.ts`, extend `FreshAgentCreateSchema`:

- Add `sessionRef: SessionLocatorSchema.optional()`.
- Add `modelSelection: AgentChatModelSelectionSchema.optional()` or the local shared equivalent already used for pane settings.
- Change `effort` from a fixed Codex enum to a trimmed non-empty string. Provider adapters can reject unsupported values later, but the shared fresh-agent transport must not reject Claude dynamic efforts.

Update exported `FreshAgentCreateRequest` types in `server/fresh-agent/runtime-adapter.ts` to match.

In `src/components/fresh-agent/FreshAgentView.tsx`, include `sessionRef` and `modelSelection` in `buildCreateMessage()`. Keep `model` for Codex runtime model selection.

In `server/fresh-agent/runtime-manager.ts`, resolve create identity as:

1. If `resumeSessionId` is present, use it.
2. Else if `sessionRef` is present and `sessionRef.provider === runtimeProvider`, use `sessionRef.sessionId`.
3. Else if `sessionRef` is present and provider mismatches, throw a clear typed error for the WS handler.
4. Else create a new session.

Do not silently ignore mismatched locators.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/fresh-agent-ws.test.ts
npm run test:server -- --run \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add \
  shared/ws-protocol.ts \
  server/fresh-agent/runtime-adapter.ts \
  server/fresh-agent/runtime-manager.ts \
  server/ws-handler.ts \
  src/components/fresh-agent/FreshAgentView.tsx \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts
git commit -m "Support provider-aware fresh-agent create"
```

Omit `server/ws-handler.ts` if it did not change.

### Task 3: Fix Persisted Pane And Storage-Key Migration

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistMiddleware.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/storage-migration.ts`
- Modify or create: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/pane-content.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesPersistence.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/storage-migration.test.ts`

- [ ] **Step 1: Identify the failing tests**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.test.ts
```

Expected before changes: stale Claude `model` survives migration and v2 storage keys are not safely migrated/cleared.

- [ ] **Step 2: Strengthen persistence tests**

In `test/unit/client/store/panesPersistence.test.ts`, extend the legacy model test so it covers the actual post-parse path that converts legacy `agent-chat` to `fresh-agent`. Assert:

```ts
expect(content.kind).toBe('fresh-agent')
expect(content.sessionType).toBe('freshclaude')
expect(content.provider).toBe('claude')
expect(content.model).toBeUndefined()
expect(content.modelSelection).toEqual({
  kind: 'exact',
  modelId: 'claude-opus-4-6',
})
```

Add a sibling Codex regression:

```ts
expect(content.kind).toBe('fresh-agent')
expect(content.provider).toBe('codex')
expect(content.model).toBe('codex-model')
expect(content.modelSelection).toBeUndefined()
```

Add or extend cross-tab/persisted hydration coverage if needed so `parsePersistedLayoutRaw()` / `hydratePanes()` cannot keep stale Claude `model` via a path that bypasses `loadPersistedPanes()`.

In `test/unit/client/store/storage-migration.test.ts`, strengthen v2 migration coverage:

- Old-version path: `freshell.tabs.v2` / `freshell.panes.v2` become `freshell.layout.v3`, and v2 keys are removed.
- Already-stamped broken path: `freshell_version` already equals the old branch version, stale v2 keys remain, and the repair still runs because `STORAGE_VERSION` is bumped.
- Corrupt-layout salvage path: an invalid `freshell.layout.v3` plus valid v2 keys writes a valid v3 layout before removing v2 keys.
- Valid-layout path: an existing valid v3 layout is not overwritten by stale v2 keys, and stale v2 keys are removed.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.test.ts
```

Expected: failures point to stale provider model cleanup and storage repair gaps.

- [ ] **Step 4: Implement provider-specific pane persistence migration**

In `persistMiddleware.ts`, use the same provider-specific model normalization contract as `panesSlice.ts`:

- `agent-chat`: migrate `model` into `modelSelection`, omit `model`.
- `fresh-agent` with `provider === 'claude'`: migrate `model` into `modelSelection`, omit `model`.
- `fresh-agent` with `provider === 'codex'`: preserve runtime `model`, omit stale `modelSelection`, preserve valid Codex runtime fields.

Update `stripTransientSessionFields()` so fresh-agent persisted/cross-tab payloads keep `sessionRef` but strip same-server-only `resumeSessionId` when appropriate. Do not strip portable `sessionRef`.

- [ ] **Step 5: Implement idempotent storage repair**

In `storage-migration.ts`:

- Bump `STORAGE_VERSION` so clients already stamped by the broken branch run the repair.
- Import `TABS_STORAGE_KEY`, `PANES_STORAGE_KEY`, and `migrateV2ToV3` from the existing storage modules.
- Attempt to parse/migrate existing `LAYOUT_STORAGE_KEY`.
- If the layout key is absent or corrupt and v2 tabs/panes are recoverable, call `migrateV2ToV3()` and write the v3 layout before deleting v2 keys.
- If the layout key is valid, do not overwrite it from stale v2 keys; remove v2 keys as stale compatibility keys.
- Remove v2 keys only after either a valid layout exists or v2 data is unrecoverable.
- Keep auth and browser-preference migration behavior unchanged.

The invariant is: recoverable v2 data is written to `freshell.layout.v3` before `freshell.tabs.v2` / `freshell.panes.v2` are removed.

- [ ] **Step 6: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  src/store/persistMiddleware.ts \
  src/store/storage-migration.ts \
  src/lib/pane-content.ts \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.test.ts
git commit -m "Repair fresh-agent persistence migrations"
```

Omit `src/lib/pane-content.ts` if it was not created.

### Task 4: Normalize Fresh-Agent Settings Aliases And Clear Sentinels

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/settings.ts`
- Modify if needed: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/config-store.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/settingsThunks.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/settingsThunks.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/config-store.fresh-agent-settings.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/config-store.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/shared/settings.test.ts`

- [ ] **Step 1: Identify the failing tests**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/shared/settings.test.ts
npm run test:server -- --run \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/server/config-store.test.ts
```

Expected before changes: client clear-sentinel payloads include own `undefined` fields or server tests still expect obsolete `{ defaultModel: 'x' }`.

- [ ] **Step 2: Update tests to the canonical settings contract**

In `test/unit/client/store/settingsThunks.test.ts`, add a recursive helper:

```ts
function expectNoUndefinedOwnProperties(value: unknown, path = 'payload'): void {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    expect(child, `${path}.${key}`).not.toBeUndefined()
    expectNoUndefinedOwnProperties(child, `${path}.${key}`)
  }
}
```

Use this helper on the exact payload passed to `api.patch`. Do not rely on `JSON.stringify()`, because JSON drops `undefined` object properties.

Assert clear sentinels use explicit `null` values:

```ts
expect(apiPatch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
  agentChat: {
    providers: {
      freshclaude: {
        modelSelection: null,
        effort: null,
      },
    },
  },
}))
expectNoUndefinedOwnProperties(apiPatch.mock.calls[0][1])
```

If the caller intentionally sends both `freshAgent` and `agentChat`, assert both aliases have the same normalized null sentinels. If the caller sends only one alias, assert the normalizer does not create a top-level sibling alias with value `undefined`.

In `test/unit/server/config-store.fresh-agent-settings.test.ts`, replace the legacy expectation with canonical mirrored settings:

```ts
expect(settings.freshAgent.defaultPlugins).toEqual(['/tmp/plugin'])
expect(settings.agentChat.defaultPlugins).toEqual(['/tmp/plugin'])
expect(settings.freshAgent.providers.freshclaude).toEqual({
  modelSelection: { kind: 'exact', modelId: 'x' },
  effort: 'high',
})
expect(settings.agentChat.providers.freshclaude).toEqual({
  modelSelection: { kind: 'exact', modelId: 'x' },
  effort: 'high',
})
```

In `test/unit/server/config-store.test.ts`, add or strengthen a real `ConfigStore.load()` legacy-config test. Persist a version-1 config with legacy `agentChat.providers.freshclaude.defaultModel/defaultEffort` and assert the loaded config has canonical mirrored `settings.freshAgent` and `settings.agentChat`. This is required because direct `mergeServerSettings()` tests do not prove file-load compatibility.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/shared/settings.test.ts
npm run test:server -- --run \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/server/config-store.test.ts
```

Expected: tests fail until client patch normalization and server load compatibility are aligned.

- [ ] **Step 4: Implement API patch normalization without top-level undefined pollution**

In `settingsThunks.ts`, normalize only sections that exist as records:

```ts
function normalizeAgentProviderDefaultsPatchForApiSection(section: unknown): unknown {
  if (!isRecord(section) || !isRecord(section.providers)) return section
  return {
    ...section,
    providers: Object.fromEntries(
      Object.entries(section.providers).map(([providerName, providerPatch]) => [
        providerName,
        isRecord(providerPatch) ? normalizeAgentChatProviderPatchForApi(providerPatch) : providerPatch,
      ]),
    ),
  }
}
```

Assign back only when the original key exists:

```ts
if (Object.prototype.hasOwnProperty.call(normalizedPatch, 'freshAgent')) {
  normalizedPatch.freshAgent = normalizeAgentProviderDefaultsPatchForApiSection(normalizedPatch.freshAgent)
}
if (Object.prototype.hasOwnProperty.call(normalizedPatch, 'agentChat')) {
  normalizedPatch.agentChat = normalizeAgentProviderDefaultsPatchForApiSection(normalizedPatch.agentChat)
}
```

If a provider patch has an own `modelSelection` or `effort` property with value `undefined`, convert it to `null`. Preserve existing clear behavior for coding CLI provider fields.

- [ ] **Step 5: Verify shared/server settings migration**

In `shared/settings.ts`, ensure the existing sanitization/merge path maps:

- `defaultModel` to `modelSelection: { kind: 'exact', modelId }`
- `defaultEffort` to `effort`
- legacy `agentChat` input to mirrored `freshAgent` and `agentChat`
- legacy `freshAgent` input to mirrored `freshAgent` and `agentChat`

Prefer fixing `shared/settings.ts` over patching `server/config-store.ts`; `ConfigStore.load()` should become green by using the shared contract.

- [ ] **Step 6: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/shared/settings.test.ts
npm run test:server -- --run \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/server/config-store.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  shared/settings.ts \
  server/config-store.ts \
  src/store/settingsThunks.ts \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/server/config-store.test.ts \
  test/unit/shared/settings.test.ts
git commit -m "Normalize fresh-agent settings compatibility"
```

Omit `server/config-store.ts` if it did not change.

### Task 5: Make Fresh-Agent Recovery Stale-Update Safe

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistControl.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

- [ ] **Step 1: Identify the failing tests**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected before changes: lost-session recovery can use `named-resume` instead of the canonical durable ID, and stale async updates can overwrite newer pane fields.

- [ ] **Step 2: Strengthen recovery and stale-update tests**

In `AgentChatView.session-lost.test.tsx`, keep the existing canonical assertion and add:

```ts
expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({
  type: 'freshAgent.create',
  resumeSessionId: 'named-resume',
}))
```

Add a fallback test where no valid `timelineSessionId` or `cliSessionId` exists and assert `named-resume` is still used. The fix must not break legitimate non-canonical same-server resumes.

In `FreshAgentView.test.tsx`, add stale-update coverage for these cases:

- `freshAgent.created` merges `sessionId`, `status`, and `createError` without clobbering a newer `model`, `modelSelection`, `permissionMode`, `plugins`, `sessionRef`, or `settingsDismissed`.
- `freshAgent.create.failed` merges `status` and `createError` without clobbering newer fields.
- snapshot refresh merges `status` / canonical resume identity without clobbering newer pane settings.
- retry/recovery resets lifecycle fields but preserves current provider-specific settings and writes canonical `sessionRef`.
- when a canonical Claude durable ID appears after a named resume, the pane gets `sessionRef: { provider: 'claude', sessionId }`, clears or deprioritizes the named resume for durable persistence as appropriate, and dispatches `flushPersistedLayoutNow()`.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected: tests fail until recovery uses fresh refs and async handlers stop dispatching whole captured pane objects.

- [ ] **Step 4: Implement canonical recovery identity**

In `FreshAgentView.tsx`, track the latest preferred resume ID in a ref:

```ts
const preferredResumeSessionIdRef = useRef<string | undefined>(preferredResumeSessionId)
preferredResumeSessionIdRef.current = preferredResumeSessionId
```

Update recovery to compute:

```ts
const recoveryResumeSessionId =
  preferredResumeSessionIdRef.current
  ?? getPreferredResumeSessionId(claudeSessionRef.current)
  ?? paneContentRef.current.resumeSessionId
```

When `recoveryResumeSessionId` is a valid canonical Claude ID, also set:

```ts
sessionRef: { provider: 'claude', sessionId: recoveryResumeSessionId }
```

Use `mergePaneContent()` for targeted recovery updates unless a full replacement is genuinely required. Do not send a direct ad hoc `freshAgent.create` from recovery; recovery should continue to flow through pane state and the existing idempotent create effect.

- [ ] **Step 5: Implement persisted identity and no-clobber lifecycle updates**

If needed, add a `buildFreshAgentPersistedIdentityUpdate()` helper in `persistControl.ts`, analogous to `buildAgentChatPersistedIdentityUpdate()`, for Claude-backed `fresh-agent` panes.

In `FreshAgentView.tsx`:

- Replace async `updatePaneContent({ content: { ...paneContent, ... } })` calls from `freshAgent.created`, `freshAgent.create.failed`, and snapshot refresh with `mergePaneContent()` targeted updates or with a freshly-read `paneContentRef.current`.
- When canonical durable identity changes, merge `sessionRef` and dispatch `flushPersistedLayoutNow()`.
- Preserve current provider-specific settings on retry/recovery.
- Keep create idempotency and reconnect behavior intact.

- [ ] **Step 6: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  src/components/fresh-agent/FreshAgentView.tsx \
  src/store/persistControl.ts \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "Harden fresh-agent recovery identity"
```

Omit `src/store/persistControl.ts` if it did not change.

### Task 6: Repair Legacy AgentChat Harness And Context Menu Selectors

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/e2e/agent-chat-capability-settings-flow.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/ContextMenuProvider.test.tsx`

- [ ] **Step 1: Identify the failing/warning tests**

Run:

```bash
npm run test:vitest -- --run \
  test/e2e/agent-chat-capability-settings-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected before changes: the capability settings flow can render an empty DOM in full-suite conditions, and context menu selectors can emit React Redux stability warnings.

- [ ] **Step 2: Repair the legacy AgentChatView harness**

In `test/e2e/agent-chat-capability-settings-flow.test.tsx`, keep this file as legacy `AgentChatView` coverage. Do not convert it to `FreshAgentView`.

Change `renderStoreBackedPane()` so the legacy component is mounted from an explicit raw `AgentChatPaneContent` prop and does not disappear when reducer effects canonicalize the backing store to `fresh-agent`.

The harness should:

- Seed `preloadedState.panes.layouts` with raw legacy `agent-chat` state directly, not via `initLayout()`.
- Render `AgentChatView` with an explicit raw legacy prop or stable local/ref-backed prop.
- Use Redux store state for dependencies and dispatch effects.
- If a test needs to inspect reducer effects, inspect `store.getState()` separately. Do not gate component rendering on `state.panes.layouts.t1.content.kind === 'agent-chat'` after the first reducer update.
- Preserve the existing user-visible assertions around provider capability rows, unavailable models, settings buttons, and create failure messages.

This fixes the empty-DOM symptom at the correct level: the legacy component test harness should not use a production canonicalization boundary as its render predicate.

- [ ] **Step 3: Add context menu warning regression coverage**

In `ContextMenuProvider.test.tsx`, spy on `console.warn`, render `ContextMenuProvider` with a store state where optional selector sources such as `connection.featureFlags` are absent, dispatch an unrelated action or rerender, and assert no React Redux selector instability warning appears.

Use a narrow assertion:

```ts
expect(consoleWarnSpy.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('Selector')
```

- [ ] **Step 4: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/e2e/agent-chat-capability-settings-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: harness/warning gaps are red or reproduce.

- [ ] **Step 5: Implement stable selector fallbacks**

In `ContextMenuProvider.tsx`, replace inline object/array fallbacks in `useAppSelector()` with module-level constants:

```ts
const EMPTY_FEATURE_FLAGS: Record<string, boolean> = {}
const EMPTY_ARRAY: readonly unknown[] = []
```

Use specific typed constants instead of allocating `{}` or `[]` inside selectors. Review nearby selectors and fix every inline fallback that can return a new reference on each selector call.

- [ ] **Step 6: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run \
  test/e2e/agent-chat-capability-settings-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: all selected tests pass and no selector instability warning is emitted.

- [ ] **Step 7: Commit**

```bash
git add \
  test/e2e/agent-chat-capability-settings-flow.test.tsx \
  src/components/context-menu/ContextMenuProvider.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "Stabilize legacy agent-chat harness"
```

### Task 7: Full Freshcodex/Fresh-Agent Regression Verification

**Files:**
- Modify only if failures expose real defects in already touched Freshcodex/fresh-agent code.

- [ ] **Step 1: Run the complete known-failure subset**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/client/store/storage-migration.test.ts \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/e2e/agent-chat-capability-settings-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx
```

Run:

```bash
npm run test:server -- --run \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/server/config-store.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run adjacent Freshcodex/fresh-agent regression suites**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/unit/client/sdk-message-handler.test.ts \
  test/unit/client/ws-client-sdk.test.ts \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/components/panes/PaneContainer.test.tsx
```

Run:

```bash
npm run test:server -- --run \
  test/unit/server/fresh-agent/codex-adapter.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts \
  test/unit/server/coding-cli/codex-app-server/client.test.ts \
  test/unit/server/coding-cli/codex-app-server/runtime.test.ts
```

Expected: all pass. If any fail, fix the real defect or update obsolete expectations only when the new assertion is stronger and matches the fresh-agent contract.

- [ ] **Step 3: Run browser Fresh Agent smoke**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts
```

Expected: all tests pass.

- [ ] **Step 4: Run typecheck, lint, and diff hygiene**

Run:

```bash
npm run typecheck
npm run lint
git diff --check
```

Expected: all pass.

- [ ] **Step 5: Run the full coordinated suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="freshcodex full-suite blocker closure" npm run check
```

Expected: all pass. If failures are reported, classify them:

- If they touch fresh-agent, freshcodex, legacy agent-chat compatibility, settings, pane persistence, storage migration, remote tab rehydration, or context menu warnings, continue fixing them in this plan.
- If they are genuinely unrelated pre-existing failures, do not ignore them silently. Record exact tests and evidence, then stop with a clear blocker report.

- [ ] **Step 6: Commit final verification fixes if needed**

If Step 5 required additional code/test changes, commit them:

```bash
git add <changed files>
git commit -m "Close freshcodex full-suite regressions"
```

If no files changed after the earlier task commits, do not create an empty commit.

### Task 8: Final Review Handoff

**Files:**
- No required file changes.

- [ ] **Step 1: Inspect final diff**

Run:

```bash
git status --short
git diff --check
git log --oneline --max-count=8
git diff --stat origin/dev...HEAD
```

Expected: worktree clean except intentionally uncommitted user work if any appears during execution; no whitespace errors.

- [ ] **Step 2: Summarize resolved issues**

Prepare the implementation report with:

- Current `HEAD`
- Each known blocker and the file/test that now proves it fixed
- Exact commands run and pass/fail status
- Any residual failures or explicitly unrelated blockers, with paths and evidence

- [ ] **Step 3: Do not land to dev/main automatically**

Stop after implementation and verification. The conductor/user will decide whether to run another review loop, squash, or integrate into `dev`.
