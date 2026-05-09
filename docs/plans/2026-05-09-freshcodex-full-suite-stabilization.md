# Freshcodex Full Suite Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation` pass the known Freshcodex/fresh-agent full-suite blockers by fixing the underlying migration, settings, recovery, and legacy test-harness contracts.

**Architecture:** `fresh-agent` is the canonical steady-state pane kind for rich Claude/Codex panes. Legacy `agent-chat` remains a compatibility input and a legacy component test target, but production pane creation, remote rehydration, persistence, and restore paths should normalize it into `fresh-agent` explicitly and preserve durable identity through canonical session locators. Settings migration uses `freshAgent` as the canonical settings shape while keeping the existing `agentChat` mirror for compatibility; API patches must never send `undefined` fields.

**Tech Stack:** React 18, Redux Toolkit, Vitest, Testing Library, coordinated Freshell test scripts, TypeScript/NodeNext, shared Zod-backed settings/session contracts.

---

## Strategy Gate

The right fix is not to preserve old `agent-chat` expectations. This branch intentionally moved rich Claude-style panes onto `fresh-agent`, and the failing tests are valuable because they expose places where the cutover is still implicit or incomplete.

Make the cutover explicit at ingress boundaries:

- Remote tab rehydration should construct `fresh-agent` pane content directly for legacy `agent-chat` snapshots.
- Pane initialization should continue normalizing legacy `agent-chat` inputs to `fresh-agent`.
- Persisted legacy `agent-chat` model fields should migrate into `modelSelection` and disappear from Claude-backed `fresh-agent` panes.
- Legacy `AgentChatView` tests may still exercise the component directly, but they must seed raw legacy pane state intentionally instead of depending on `initLayout`, because `initLayout` is now a canonicalization boundary.

The settings fix should not choose only one alias and break the other. Keep the compatibility mirror, but normalize both aliases identically and prune/convert `undefined` before sending patches to `/api/settings`.

The storage migration fix should do the actual v2-to-v3 localStorage migration before clearing v2 keys. Do not clear recoverable v2 data without writing the v3 layout.

The durable recovery fix should prefer the canonical Claude timeline/CLI session id over a named resume alias whenever the server has provided one, including the async lost-session recovery path.

## File Structure

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/TabsView.tsx`
  - Owns remote tab card copy/rehydration. It should turn remote legacy `agent-chat` snapshots into canonical `fresh-agent` pane content directly.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/panesSlice.ts`
  - Owns pane content normalization at reducer boundaries. It should preserve the intentional `agent-chat` to `fresh-agent` cutover and ensure tests assert that contract.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistMiddleware.ts`
  - Owns persisted pane migration and writeback. It should migrate legacy Claude `model` into `modelSelection` without persisting a stale `model` field for Claude-backed fresh-agent panes, while preserving Codex runtime `model` where it is semantically valid.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/storage-migration.ts`
  - Owns one-time localStorage version migration. It should migrate `freshell.tabs.v2` / `freshell.panes.v2` into `freshell.layout.v3` and remove v2 keys after migration.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/settings.ts`
  - Owns server settings sanitization/merge. It should keep legacy `defaultModel` migration to `modelSelection` and make the server-side expectations explicit.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/settingsThunks.ts`
  - Owns client API patch normalization. It should normalize provider clear sentinels for both `freshAgent` and `agentChat`, and avoid sending `undefined`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/fresh-agent/FreshAgentView.tsx`
  - Owns fresh-agent client lifecycle. Its lost-session recovery path should use the freshest canonical Claude durable session id, not a stale named resume alias.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/context-menu/ContextMenuProvider.tsx`
  - Owns context menu selectors. It should use stable empty fallback objects so React Redux does not warn about selectors returning fresh references.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/TabsView.test.tsx`
  - Assert remote legacy `agent-chat` rehydrates as canonical `fresh-agent` with `sessionType: 'freshclaude'`, `provider: 'claude'`, canonical `sessionRef`, and no same-server-only `resumeSessionId` for remote copies.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesPersistence.test.ts`
  - Assert legacy model migration strips stale `model` from Claude-backed migrated panes and preserves `modelSelection`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesSlice.test.ts`
  - Replace the obsolete "does not synthesize canonical sessionRef" assertion with the canonicalization contract: legacy `agent-chat/freshclaude` input becomes `fresh-agent/claude` and gets the durable `sessionRef` when the resume id is a valid Claude session id.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/settingsThunks.test.ts`
  - Assert clear sentinels are normalized for both aliases, or assert the canonical alias shape if the implementation removes duplicate alias payloads. In either case, assert no `undefined` fields reach `api.patch`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/storage-migration.test.ts`
  - Keep the recoverable v2 migration test and strengthen it to assert the v3 layout exists with the migrated pane, while v2 keys are removed.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx`
  - Keep the existing assertion that recovery uses `cli-session-abc-123`; add a regression assertion that a named resume alias does not overwrite the canonical durable id after the pane has been marked lost.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/config-store.fresh-agent-settings.test.ts`
  - Update the server migration expectation to canonical `modelSelection`, and add coverage for `defaultEffort` if missing.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/e2e/agent-chat-capability-settings-flow.test.tsx`
  - Repair the legacy component harness so store-backed `AgentChatView` tests seed raw legacy pane state deliberately instead of using `initLayout`, which now canonicalizes into `fresh-agent`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/ContextMenuProvider.test.tsx`
  - Add a focused regression test for the stable empty selector fallback, or extend an existing render test to fail on React Redux selector warnings.

## Known Red Checks

These known failures are in scope and must be green before the work is complete:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/client/store/storage-migration.test.ts \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/e2e/agent-chat-capability-settings-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx
```

```bash
npm run test:server -- --run \
  test/unit/server/config-store.fresh-agent-settings.test.ts
```

Final verification must also include:

```bash
npm run typecheck
npm run lint
npm run check
git diff --check
```

If coordinated `npm run check` reports additional Freshcodex/fresh-agent regressions, continue fixing them in this same implementation cycle. Do not declare success with a partially green suite.

### Task 1: Capture The Red Baseline And Lock The Compatibility Decision

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/TabsView.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesSlice.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/e2e/agent-chat-capability-settings-flow.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/TabsView.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/panesSlice.ts`

- [ ] **Step 1: Identify or write the failing tests**

Run the current red client subset first:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/store/panesSlice.test.ts \
  test/e2e/agent-chat-capability-settings-flow.test.tsx
```

Expected before changes: at least the remote `agent-chat` rehydration assertion, legacy pane normalization assertion, and store-backed agent-chat capability settings flow fail.

- [ ] **Step 2: Update tests to assert the steady-state contract**

In `test/unit/client/components/TabsView.test.tsx`, update `rehydrates remote agent-chat panes with selection strategies` so it expects copied content like:

```ts
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
```

In `test/unit/client/store/panesSlice.test.ts`, replace the obsolete `does not synthesize canonical sessionRef from raw agent-chat resumeSessionId` case with:

```ts
it('normalizes legacy agent-chat freshclaude input to canonical fresh-agent content', () => {
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
```

In `test/e2e/agent-chat-capability-settings-flow.test.tsx`, keep this file as legacy `AgentChatView` coverage. Change `renderStoreBackedPane()` so it seeds `preloadedState.panes.layouts` with raw `agent-chat` content instead of dispatching `initLayout()`. The helper should still render `AgentChatView` and still allow `updatePaneContent` reducer effects to be observed. Do not convert this test to `FreshAgentView`; its value is legacy component regression coverage.

- [ ] **Step 3: Run tests to verify they fail for the intended code gaps**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/store/panesSlice.test.ts \
  test/e2e/agent-chat-capability-settings-flow.test.tsx
```

Expected after test edits but before implementation: `TabsView` should still fail until remote `agent-chat` snapshots are explicitly converted to `fresh-agent`; `panesSlice` may already pass if the reducer behavior is correct; the capability settings flow should no longer produce an empty DOM.

- [ ] **Step 4: Implement explicit remote legacy conversion**

In `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/TabsView.tsx`, stop returning `kind: 'agent-chat'` from the remote snapshot path. For `snapshot.kind === 'agent-chat'`, build canonical `FreshAgentPaneContent` input directly:

```ts
const sessionType = ((payload.provider as string | undefined) || 'freshclaude') as FreshAgentSessionType
const provider = resolveFreshAgentRuntimeProvider(sessionType) ?? 'claude'
const sessionRef = resolveSessionRef({
  payload,
  fallbackProvider: provider,
  fallbackSessionId: typeof payload.resumeSessionId === 'string' ? payload.resumeSessionId : undefined,
})
return {
  kind: 'fresh-agent',
  sessionType,
  provider,
  sessionId: sameServer && typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
  resumeSessionId: sameServer && typeof payload.resumeSessionId === 'string' ? payload.resumeSessionId : undefined,
  ...(sessionRef ? { sessionRef } : {}),
  serverInstanceId: record.serverInstanceId,
  initialCwd: payload.initialCwd as string | undefined,
  modelSelection: normalizeAgentChatModelSelection(payload.modelSelection, payload.model),
  permissionMode: payload.permissionMode as string | undefined,
  effort: normalizeAgentChatEffortOverride(payload.effort),
  plugins: payload.plugins as string[] | undefined,
}
```

Use the existing helper/import style in the file. Preserve current `fresh-agent` snapshot handling for native fresh-agent records.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/store/panesSlice.test.ts \
  test/e2e/agent-chat-capability-settings-flow.test.tsx
```

Expected: all selected tests pass. If the capability flow still has empty DOM, inspect the rendered pane state and fix the harness; do not weaken the assertions around blocked creates, unavailable models, or settings buttons.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/TabsView.tsx \
  src/store/panesSlice.ts \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/store/panesSlice.test.ts \
  test/e2e/agent-chat-capability-settings-flow.test.tsx
git commit -m "Align legacy agent panes with fresh-agent cutover"
```

### Task 2: Fix Persisted Pane And Storage-Key Migration

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistMiddleware.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/storage-migration.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesPersistence.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/storage-migration.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.test.ts
```

Expected before changes: the legacy model migration test shows stale `model` surviving; the v2 storage migration test shows `freshell.tabs.v2` and/or `freshell.panes.v2` not being cleared after a successful migration.

- [ ] **Step 2: Strengthen tests before implementation**

In `test/unit/client/store/panesPersistence.test.ts`, extend the legacy model test so it covers the actual post-parse path that currently converts legacy `agent-chat` to `fresh-agent` before `persistMiddleware` migration. Assert:

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

Add a sibling test for a `fresh-agent` Codex pane with `provider: 'codex'` and `model: 'codex-model'` to prove the fix does not delete Codex runtime model selection:

```ts
expect(content.kind).toBe('fresh-agent')
expect(content.provider).toBe('codex')
expect(content.model).toBe('codex-model')
```

In `test/unit/client/store/storage-migration.test.ts`, keep the v2 cleanup assertions and add:

```ts
const migratedRaw = localStorage.getItem(LAYOUT_STORAGE_KEY)
expect(migratedRaw).not.toBeNull()
const migrated = parsePersistedLayoutRaw(migratedRaw!)
expect(migrated?.tabs.tabs.some((tab) => tab.id === 'tab-v2')).toBe(true)
expect((migrated?.panes.layouts['tab-v2'] as any)?.content.kind).toBe('terminal')
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.test.ts
```

Expected: failures point to stale Claude `model` cleanup and missing v2-to-v3 storage migration/cleanup.

- [ ] **Step 4: Implement pane persistence migration**

In `src/store/persistMiddleware.ts`, update `migratePaneContent()` so both legacy `agent-chat` and Claude-backed `fresh-agent` content migrate legacy `model` to `modelSelection` and omit `model` from the returned content.

Use a small local helper to keep this explicit:

```ts
function migrateAgentModelFields(content: any, options: { keepRuntimeModel: boolean }): any {
  const { model: legacyModel, ...rest } = content
  const next = {
    ...rest,
    modelSelection: normalizeAgentChatModelSelection(content.modelSelection, legacyModel),
    effort: normalizeAgentChatEffortOverride(content.effort),
  }
  if (options.keepRuntimeModel && typeof legacyModel === 'string') {
    next.model = legacyModel
  }
  return next
}
```

Apply it as:

- `agent-chat`: `keepRuntimeModel: false`
- `fresh-agent` with `provider === 'claude'`: `keepRuntimeModel: false`
- `fresh-agent` with `provider === 'codex'`: preserve runtime `model` and still normalize `effort`/`modelSelection` only if those fields apply

Do not move this helper to shared code; it depends on client pane persistence types and local migration helpers.

- [ ] **Step 5: Implement storage v2-to-v3 migration**

In `src/store/storage-migration.ts`:

- Import `TABS_STORAGE_KEY`, `PANES_STORAGE_KEY`, and `migrateV2ToV3` from the existing storage modules.
- When `LAYOUT_STORAGE_KEY` is absent and `TABS_STORAGE_KEY` is present, call `migrateV2ToV3()` before deleting legacy keys.
- If `LAYOUT_STORAGE_KEY` already exists, do not overwrite it from v2 keys; remove v2 keys as stale compatibility keys.
- Add `TABS_STORAGE_KEY` and `PANES_STORAGE_KEY` to the legacy removal list or remove them explicitly after the migration attempt.
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
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.test.ts
git commit -m "Fix fresh-agent persistence migrations"
```

### Task 3: Normalize Fresh-Agent Settings Aliases And Clear Sentinels

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/settings.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/settingsThunks.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/settingsThunks.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/config-store.fresh-agent-settings.test.ts`
- Modify if needed: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/shared/settings.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/settingsThunks.test.ts test/unit/shared/settings.test.ts
npm run test:server -- --run test/unit/server/config-store.fresh-agent-settings.test.ts
```

Expected before changes: client clear-sentinel payload includes `freshAgent.providers.freshclaude` with `undefined` fields; server config compatibility test expects obsolete `{ defaultModel: 'x' }`.

- [ ] **Step 2: Update tests to the canonical settings contract**

In `test/unit/server/config-store.fresh-agent-settings.test.ts`, replace the legacy expectation with:

```ts
expect(settings.freshAgent.defaultPlugins).toEqual(['/tmp/plugin'])
expect(settings.agentChat.defaultPlugins).toEqual(['/tmp/plugin'])
expect(settings.freshAgent.providers.freshclaude).toEqual({
  modelSelection: { kind: 'exact', modelId: 'x' },
})
expect(settings.agentChat.providers.freshclaude).toEqual({
  modelSelection: { kind: 'exact', modelId: 'x' },
})
```

Add a case for `defaultEffort`:

```ts
providers: {
  freshclaude: { defaultModel: 'x', defaultEffort: 'high' },
}
```

Expected normalized provider:

```ts
{
  modelSelection: { kind: 'exact', modelId: 'x' },
  effort: 'high',
}
```

In `test/unit/client/store/settingsThunks.test.ts`, update the clear-sentinel test to assert the API payload contains no `undefined` values. The preferred assertion is:

```ts
expect(apiPatch).toHaveBeenCalledWith('/api/settings', {
  freshAgent: {
    providers: {
      freshclaude: {
        modelSelection: null,
        effort: null,
      },
    },
  },
  agentChat: {
    providers: {
      freshclaude: {
        modelSelection: null,
        effort: null,
      },
    },
  },
})
expect(JSON.stringify(apiPatch.mock.calls[0][1])).not.toContain('undefined')
```

If the implementation intentionally sends only `freshAgent`, document that in a nearby comment and assert only the canonical alias. Do not leave `freshAgent` carrying `undefined` while `agentChat` carries `null`.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/settingsThunks.test.ts test/unit/shared/settings.test.ts
npm run test:server -- --run test/unit/server/config-store.fresh-agent-settings.test.ts
```

Expected: tests fail until API normalization and server compatibility expectations are aligned.

- [ ] **Step 4: Implement API patch normalization**

In `src/store/settingsThunks.ts`, apply `normalizeAgentChatProviderPatchForApi()` to both `normalizedPatch.freshAgent.providers` and `normalizedPatch.agentChat.providers`.

Extract a helper:

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

Then assign:

```ts
normalizedPatch.freshAgent = normalizeAgentProviderDefaultsPatchForApiSection(normalizedPatch.freshAgent)
normalizedPatch.agentChat = normalizeAgentProviderDefaultsPatchForApiSection(normalizedPatch.agentChat)
```

If a provider patch becomes an empty object only because all fields were local-only, preserve existing behavior. If a field is present with `undefined`, convert it to `null` for clear semantics.

- [ ] **Step 5: Verify shared server settings migration**

`shared/settings.ts` already contains `normalizeLegacyAgentChatProviderDefaultsInput()`. Confirm it maps `defaultModel` to `modelSelection` and `defaultEffort` to `effort` for both `freshAgent` and `agentChat` inputs. If a test exposes a gap, fix that function rather than patching `server/config-store.ts`.

- [ ] **Step 6: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/settingsThunks.test.ts test/unit/shared/settings.test.ts
npm run test:server -- --run test/unit/server/config-store.fresh-agent-settings.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  shared/settings.ts \
  src/store/settingsThunks.ts \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/shared/settings.test.ts
git commit -m "Normalize fresh-agent settings compatibility"
```

### Task 4: Fix FreshClaude Lost-Session Recovery Resume Identity

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx`
- Modify if needed: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistControl.ts`

- [ ] **Step 1: Identify or write the failing test**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx
```

Expected before changes: `recreates a lost freshclaude session with the canonical durable resume id` sends `resumeSessionId: 'named-resume'` instead of `resumeSessionId: 'cli-session-abc-123'`.

- [ ] **Step 2: Strengthen the regression test**

In `AgentChatView.session-lost.test.tsx`, keep the existing expected `freshAgent.create` assertion and add a negative assertion inside the same `waitFor()`:

```ts
expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({
  type: 'freshAgent.create',
  resumeSessionId: 'named-resume',
}))
```

If needed, add a second case where `timelineSessionId` is absent to prove named resume still works as fallback:

```ts
expect(wsMock.send).toHaveBeenCalledWith(expect.objectContaining({
  type: 'freshAgent.create',
  resumeSessionId: 'named-resume',
}))
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx
```

Expected: canonical id case fails until the recovery path uses the latest preferred id.

- [ ] **Step 4: Implement canonical resume lookup**

In `FreshAgentView.tsx`, avoid relying on a stale closure value for recovery. Add a ref that tracks the latest preferred resume id:

```ts
const preferredResumeSessionIdRef = useRef<string | undefined>(preferredResumeSessionId)
preferredResumeSessionIdRef.current = preferredResumeSessionId
```

Then update `triggerRecovery()` to use the ref first:

```ts
const recoveryResumeSessionId =
  preferredResumeSessionIdRef.current
  ?? getPreferredResumeSessionId(claudeSession)
  ?? paneContentRef.current.resumeSessionId
```

Use `recoveryResumeSessionId` in the `updatePaneContent()` payload.

Also review `buildCreateMessage()` and the create effect: the create message should use the pane content after the reducer update. Do not add a direct ad hoc `freshAgent.create` send from `triggerRecovery()`; recovery should continue to flow through pane state so reconnect/idempotency tracking remains centralized.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/fresh-agent/FreshAgentView.tsx \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  src/store/persistControl.ts
git commit -m "Prefer canonical resume id during fresh-agent recovery"
```

Only include `src/store/persistControl.ts` if it actually changed.

### Task 5: Remove Context Menu Selector Warnings

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/ContextMenuProvider.test.tsx`

- [ ] **Step 1: Identify or write the failing warning test**

Run the existing context menu tests:

```bash
npm run test:vitest -- --run test/unit/client/components/ContextMenuProvider.test.tsx
```

If no test fails, add a focused regression test that spies on `console.warn`, renders `ContextMenuProvider` with a store state where `connection.featureFlags` is absent, dispatches an unrelated action or rerenders, and asserts React Redux does not warn about selector result instability.

Suggested assertion:

```ts
expect(consoleWarnSpy.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain('Selector')
```

Keep the assertion narrow enough not to fail on unrelated warnings from other code.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected before implementation: the new warning regression test fails or reproduces the known warning.

- [ ] **Step 3: Implement stable selector fallbacks**

In `ContextMenuProvider.tsx`, add module-level constants:

```ts
const EMPTY_FEATURE_FLAGS: Record<string, boolean> = {}
```

Then replace:

```ts
const featureFlags = useAppSelector((s) => s.connection?.featureFlags ?? {})
```

with:

```ts
const featureFlags = useAppSelector((s) => s.connection?.featureFlags ?? EMPTY_FEATURE_FLAGS)
```

Review nearby selectors for other inline object/array fallbacks. Use existing constants like `EMPTY_EXTENSION_ENTRIES` where they already exist; add module-level constants only for fallbacks that currently allocate new references.

- [ ] **Step 4: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/ContextMenuProvider.test.tsx
```

Expected: all selected tests pass and no selector instability warning is emitted.

- [ ] **Step 5: Commit**

```bash
git add \
  src/components/context-menu/ContextMenuProvider.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "Stabilize context menu selector fallbacks"
```

### Task 6: Full Freshcodex/Fresh-Agent Regression Verification

**Files:**
- Modify only if failures expose real defects in already touched Freshcodex/fresh-agent code.

- [ ] **Step 1: Run the complete known-failure subset**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/client/store/storage-migration.test.ts \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/e2e/agent-chat-capability-settings-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx
```

Run:

```bash
npm run test:server -- --run \
  test/unit/server/config-store.fresh-agent-settings.test.ts
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

- If they touch fresh-agent, freshcodex, legacy agent-chat compatibility, settings, pane persistence, storage migration, or the context menu warning fixed here, continue fixing them in this plan.
- If they are genuinely unrelated pre-existing failures, do not ignore them silently. Record exact tests and evidence, then stop with a clear blocker report.

- [ ] **Step 6: Commit final verification fixes if needed**

If Step 5 required additional code/test changes, commit them:

```bash
git add <changed files>
git commit -m "Close freshcodex full-suite regressions"
```

If no files changed after the earlier task commits, do not create an empty commit.

### Task 7: Final Review Handoff

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
