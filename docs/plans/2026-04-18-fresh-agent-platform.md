# Fresh Agent Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a shared `fresh-agent` platform that powers `freshclaude` and `freshcodex` from one architecture, preserves existing Freshclaude behavior and saved state, and leaves a clean adapter seam for `freshopencode` later without another rewrite.

**Architecture:** Cut over directly from the current `agent-chat` domain to a new `fresh-agent` domain that separates user-facing `sessionType` from runtime `provider`. Reuse Claude’s existing durable/live ledger stack and the existing Codex app-server runtime, normalize both into one read model plus one shared UI shell, and migrate every persistence/restore surface up front so current users keep their tabs, settings, history, and remote snapshots.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, WebSocket/Zod contracts, existing read-model scheduler, Claude SDK bridge, Codex app-server runtime/client, Vitest, Testing Library, Playwright browser e2e.

---

## Why The Previous Plan Would Fail

- It correctly chose the target architecture, but it did not fully cover the persistence and restore surfaces that still encode `agent-chat`. An executor following it would get partway through the cutover and then discover breakage in local storage versioning, remote tab snapshots, tab registry history, and sidebar resume behavior.
- It did not account for [`src/store/storage-migration.ts`](/home/user/code/freshell/.worktrees/fresh-agent-platform/src/store/storage-migration.ts:1), which currently hard-clears persisted browser state on incompatible version changes. A naive schema bump would erase exactly the saved Freshclaude tabs and settings the user asked to preserve.
- It did not include the remote snapshot and restore path through [`server/agent-api/layout-store.ts`](/home/user/code/freshell/.worktrees/fresh-agent-platform/server/agent-api/layout-store.ts:1), [`server/tabs-registry/types.ts`](/home/user/code/freshell/.worktrees/fresh-agent-platform/server/tabs-registry/types.ts:1), [`src/store/tabRegistryTypes.ts`](/home/user/code/freshell/.worktrees/fresh-agent-platform/src/store/tabRegistryTypes.ts:1), and [`src/components/TabsView.tsx`](/home/user/code/freshell/.worktrees/fresh-agent-platform/src/components/TabsView.tsx:1). Without those, reopened remote tabs would still serialize and hydrate `agent-chat`.
- It did not include the layout bootstrap path through [`src/components/TabContent.tsx`](/home/user/code/freshell/.worktrees/fresh-agent-platform/src/components/TabContent.tsx:1), [`src/lib/tab-directory-preference.ts`](/home/user/code/freshell/.worktrees/fresh-agent-platform/src/lib/tab-directory-preference.ts:1), and [`src/store/paneTreeValidation.ts`](/home/user/code/freshell/.worktrees/fresh-agent-platform/src/store/paneTreeValidation.ts:1). Those still special-case `agent-chat`.
- It sequenced the persistence cutover too early. If an executor migrates stored panes from `agent-chat` to `fresh-agent` before `PaneContainer`, `TabContent`, `crossTabSync`, pane-title helpers, and local snapshot parsing can read the new shape, the next reload or cross-tab hydrate will strand rich panes as unknown content.
- It did not call out [`src/store/selectors/sidebarSelectors.ts`](/home/user/code/freshell/.worktrees/fresh-agent-platform/src/store/selectors/sidebarSelectors.ts:1) and related session metadata helpers, which are where `provider` and `sessionType` semantics get merged for history/sidebar rendering. Missing them would reintroduce the wrong identity model after the store cutover.
- It did not call out [`server/coding-cli/session-indexer.ts`](/home/user/code/freshell/.worktrees/fresh-agent-platform/server/coding-cli/session-indexer.ts:1) and [`server/coding-cli/types.ts`](/home/user/code/freshell/.worktrees/fresh-agent-platform/server/coding-cli/types.ts:1), which are where stored session metadata, derived titles, and indexed Codex runtime metadata get merged before the session directory and sidebar consume them. Leaving that seam out would make the migration look complete in storage while the user-visible projections stayed wrong.
- It did not call out [`server/platform-router.ts`](/home/user/code/freshell/.worktrees/fresh-agent-platform/server/platform-router.ts:1), which is part of keeping hidden `kilroy` support wired through the platform feature flags.
- It did not include the existing browser specs, Vitest e2e flows, context-menu tests, visible-first perf fixtures, and MCP help text that still hard-code `agent-chat` or `sdk.*`. An executor could finish the product code, hit the repo-wide verification gate, and then discover a second migration hidden in the test/tooling surface.
- It was still too optimistic about “delete old `agent-chat` glue later”. Some of the old files are not merely legacy UI; they currently encode product-critical behavior that must be ported deliberately before deletion: restore hydration, question/approval state, plugin defaults, input history, and lost-session recovery.
- It still leaned too hard toward rebuilding the UI layer from scratch. The repo already contains reusable shared rendering pieces in `src/components/session/*` plus reusable diff and settings primitives. A plan that does not explicitly direct the executor to reuse and promote those pieces risks violating the user’s “reuse as much as possible” requirement and burning time on unnecessary rewrites.
- Its cleanup section was too deletion-oriented. Several files and tests listed as “modify/delete” are not dead weight; they are the current regression net for restore hydration, split-pane remounts, browser/mobile behavior, MCP tool help text, and visible-first performance contracts. Treating them as delete-first would cause avoidable backtracking and test dilution.

## Steady-State Product Behavior

- Rich panes use `kind: 'fresh-agent'`, not `kind: 'agent-chat'`.
- `freshclaude`, `freshcodex`, and hidden `kilroy` all come from one fresh-agent registry.
- `provider` means runtime family (`claude`, `codex`, later `opencode`).
- `sessionType` means user-facing identity (`freshclaude`, `freshcodex`, `kilroy`, later `freshopencode`).
- Existing Freshclaude sessions, settings, reopen entries, local layouts, remote tab snapshots, and sidebar/history items survive migration with no manual repair.
- Raw CLI terminals remain separate pane types. Rich panes never silently degrade into terminal scraping.
- Freshcodex rich panes use the Codex app-server as the source of truth and surface fork, diff/review, worktree, child-thread, and token/context metadata when the runtime exposes them.
- OpenCode is not shipped here, but the registry, adapter interface, and normalized model already admit it without Claude- or Codex-specific assumptions leaking into shared code.

## Contracts And Invariants

### Naming and persistence

- The final domain name is `fresh-agent`, not `agent-chat`.
- Persisted pane/layout data must migrate existing `agent-chat` leaves to `fresh-agent` leaves.
- Browser storage migration must preserve existing Freshell auth, layout, and settings data; do not solve this by clearing local storage.
- Server/local settings must migrate `agentChat` to `freshAgent` while continuing to read legacy input during rollout.
- Remote layout snapshots and tab registry records must serialize `fresh-agent`, not `agent-chat`.
- Session metadata remains keyed by `provider:sessionId`; updating `sessionType` must keep `derivedTitle`.

### Registry and adapters

- One declarative registry owns labels, icons, settings visibility/defaults, runtime provider, and feature flags for `freshclaude`, `freshcodex`, `kilroy`, and disabled `freshopencode`.
- Runtime adapters own `create`, `resume`, `subscribe`, `send`, `interrupt`, `fork`, `answerQuestion`, `resolveApproval`, `listThreads`, `getSnapshot`, `getTurnPage`, `getTurnBody`, and capability-backed workspace actions.
- Claude runtime implementation stays behind the adapter boundary; the ledger/history strategy is preserved, not discarded.
- Codex runtime reuses `server/coding-cli/codex-app-server/*`; extend that stack instead of duplicating it.

### Read model and UI

- All shared UI reads normalized fresh-agent data first and provider extensions second.
- Normalized entities have stable ids for thread, turn, item, approval, question, diff, artifact, child thread, and worktree references.
- Read-model routes stay revisioned and lane-aware and must never mix bodies from one revision with summaries from another.
- Existing Freshclaude UX stays intact unless the new shared shell makes it stronger.
- Mobile and sidebar behavior remain first-class requirements, not follow-up cleanup.
- During the migration tasks, runtime readers must accept both legacy `agent-chat` persisted data and the new `fresh-agent` shape until every local bootstrap, cross-tab hydrate, and remote snapshot path has been switched.

## File Structure

### Create

- `shared/fresh-agent.ts`
- `server/fresh-agent/runtime-adapter.ts`
- `server/fresh-agent/provider-registry.ts`
- `server/fresh-agent/runtime-manager.ts`
- `server/fresh-agent/router.ts`
- `server/fresh-agent/adapters/claude/adapter.ts`
- `server/fresh-agent/adapters/claude/normalize.ts`
- `server/fresh-agent/adapters/codex/adapter.ts`
- `server/fresh-agent/adapters/codex/normalize.ts`
- `src/lib/fresh-agent-registry.ts`
- `src/lib/fresh-agent-capabilities.ts`
- `src/lib/fresh-agent-ws.ts`
- `src/store/freshAgentTypes.ts`
- `src/store/freshAgentSlice.ts`
- `src/store/freshAgentThunks.ts`
- `src/components/fresh-agent/FreshAgentView.tsx`
- `src/components/fresh-agent/FreshAgentTranscript.tsx`
- `src/components/fresh-agent/FreshAgentComposer.tsx`
- `src/components/fresh-agent/FreshAgentSidebar.tsx`
- `src/components/fresh-agent/FreshAgentApprovalBanner.tsx`
- `src/components/fresh-agent/FreshAgentQuestionBanner.tsx`
- `src/components/fresh-agent/FreshAgentDiffPanel.tsx`
- `test/fixtures/fresh-agent/claude/*`
- `test/fixtures/fresh-agent/codex/*`
- `test/e2e-browser/specs/fresh-agent.spec.ts`
- `test/e2e-browser/specs/fresh-agent-mobile.spec.ts`

### Modify

- `shared/ws-protocol.ts`
- `shared/read-models.ts`
- `shared/settings.ts`
- `server/config-store.ts`
- `server/index.ts`
- `server/ws-handler.ts`
- `server/platform-router.ts`
- `server/sdk-bridge.ts`
- `server/sdk-bridge-types.ts`
- `server/agent-timeline/*`
- `server/coding-cli/codex-app-server/protocol.ts`
- `server/coding-cli/codex-app-server/client.ts`
- `server/coding-cli/codex-app-server/runtime.ts`
- `server/coding-cli/codex-app-server/launch-planner.ts`
- `server/coding-cli/providers/codex.ts`
- `server/session-directory/*`
- `server/sessions-router.ts`
- `server/session-metadata-store.ts`
- `server/agent-api/layout-store.ts`
- `server/tabs-registry/types.ts`
- `src/store/paneTypes.ts`
- `src/store/panesSlice.ts`
- `src/store/persistedState.ts`
- `src/store/persistMiddleware.ts`
- `src/store/crossTabSync.ts`
- `src/store/storage-migration.ts`
- `src/store/store.ts`
- `src/store/persistControl.ts`
- `src/store/tabsSlice.ts`
- `src/store/settingsSlice.ts`
- `src/store/settingsThunks.ts`
- `src/store/browserPreferencesPersistence.ts`
- `src/store/paneTreeValidation.ts`
- `src/store/tabRegistryTypes.ts`
- `src/store/selectors/sidebarSelectors.ts`
- `src/lib/session-type-utils.ts`
- `src/lib/derivePaneTitle.ts`
- `src/lib/pane-title.ts`
- `src/lib/pane-activity.ts`
- `src/lib/session-utils.ts`
- `src/lib/input-history-store.ts`
- `src/lib/tab-directory-preference.ts`
- `src/lib/tab-registry-snapshot.ts`
- `src/lib/ws-client.ts`
- `src/lib/api.ts`
- `src/lib/agent-chat-utils.ts`
- `src/lib/agent-chat-types.ts`
- `src/components/session/MessageBubble.tsx`
- `src/components/session/ToolCallBlock.tsx`
- `src/components/panes/PaneContainer.tsx`
- `src/components/panes/PanePicker.tsx`
- `src/components/Sidebar.tsx`
- `src/components/HistoryView.tsx`
- `src/components/TabContent.tsx`
- `src/components/TabsView.tsx`
- `src/components/context-menu/ContextMenuProvider.tsx`
- `src/components/context-menu/context-menu-constants.ts`
- `src/components/context-menu/context-menu-types.ts`
- `src/components/context-menu/context-menu-utils.ts`
- `src/components/context-menu/menu-defs.ts`
- `src/components/icons/PaneIcon.tsx`
- `src/components/TabBar.tsx`
- `src/components/TabSwitcher.tsx`
- `src/components/MobileTabStrip.tsx`
- `src/components/SettingsView.tsx`
- `src/components/settings/WorkspaceSettings.tsx`
- `src/components/agent-chat/DiffView.tsx`
- `server/mcp/freshell-tool.ts`
- `docs/index.html`
- `test/unit/client/store/panesPersistence.test.ts`
- `test/unit/server/agent-layout-schema.test.ts`
- `test/unit/server/tabs-registry/types.test.ts`
- `test/integration/server/settings-api.test.ts`
- `test/integration/server/tabs-registry-store.persistence.test.ts`
- `test/integration/server/session-directory-router.test.ts`

### Delete Only After Porting Behavior And Coverage

- `src/store/agentChatSlice.ts`
- `src/store/agentChatThunks.ts`
- `src/store/agentChatTypes.ts`
- `src/lib/sdk-message-handler.ts`
- legacy `src/components/agent-chat/*` files that are provably dead after their behavior has been moved into `src/components/fresh-agent/*` or promoted shared primitives
- renamed or superseded test files only after the replacement tests cover the same restore, split-pane, session-lost, input-history, mobile, context-menu, and perf behaviors
- any other `sdk.*` or `agent-chat` glue that no longer carries real behavior after the new transport, persistence, and coverage are all green

## Strategy Gate

The right path is a direct cutover to the final architecture, not another “genericize `sdk.*` later” detour. The repo already contains the two foundations this work must respect:

- Claude has durable/live merge and restore semantics in `server/sdk-bridge.ts` and `server/agent-timeline/*`.
- Codex already has a shared app-server runtime/client/planner in `server/coding-cli/codex-app-server/*`.
- The client already has reusable generalized rendering and event primitives in `src/components/session/*`, `src/components/agent-chat/DiffView.tsx`, `src/lib/input-history-store.ts`, and `src/lib/coding-cli-types.ts`.

The plan therefore reuses both, renames the product domain to `fresh-agent`, migrates persistence/settings/restore surfaces first, and then lands one transport, one read model, one store, and one UI shell. That is the cleanest route to the requested end state and the only route that avoids another rewrite when `freshopencode` arrives.

### Task 1: Rename the domain to `fresh-agent` and migrate local/server persistence without data loss

**Files:**
- Create: `shared/fresh-agent.ts`
- Create: `src/lib/fresh-agent-registry.ts`
- Create: `src/lib/fresh-agent-capabilities.ts`
- Modify: `shared/settings.ts`
- Modify: `server/config-store.ts`
- Modify: `server/platform-router.ts`
- Modify: `src/store/settingsSlice.ts`
- Modify: `src/store/settingsThunks.ts`
- Modify: `src/store/browserPreferencesPersistence.ts`
- Modify: `src/store/storage-migration.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/crossTabSync.ts`
- Modify: `src/store/paneTreeValidation.ts`
- Modify: `src/lib/agent-chat-utils.ts`
- Modify: `src/lib/agent-chat-types.ts`
- Modify: `src/lib/pane-title.ts`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/TabContent.tsx`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Test: `test/unit/shared/fresh-agent-registry.test.ts`
- Test: `test/unit/client/store/persisted-state.fresh-agent.test.ts`
- Test: `test/unit/client/store/storage-migration.fresh-agent.test.ts`
- Test: `test/unit/client/store/crossTabSync.test.ts`
- Test: `test/unit/client/store/panesPersistence.test.ts`
- Test: `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
- Test: `test/unit/server/config-store.fresh-agent-settings.test.ts`
- Test: `test/integration/server/settings-api.test.ts`
- Test: `test/unit/server/agent-layout-schema.test.ts`
- Test: `test/unit/client/store/tabsSlice.merge.test.ts`
- Test: `test/integration/server/platform-api.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Add tests that pin the migration and registry rules:

```ts
it('migrates persisted agent-chat panes to fresh-agent panes', () => {
  const parsed = parsePersistedPanesRaw(JSON.stringify({
    version: 6,
    layouts: {
      tab_1: {
        type: 'leaf',
        id: 'pane_1',
        content: { kind: 'agent-chat', provider: 'freshclaude', createRequestId: 'req-1', status: 'idle' },
      },
    },
  }))
  expect(findLeafContent(parsed!.layouts.tab_1)).toMatchObject({ kind: 'fresh-agent', sessionType: 'freshclaude' })
})

it('migrates legacy settings.agentChat to settings.freshAgent', () => {
  const settings = resolveServerSettings({
    agentChat: { defaultPlugins: ['/tmp/plugin'], providers: { freshclaude: { defaultModel: 'x' } } },
  } as any)
  expect(settings.freshAgent.defaultPlugins).toEqual(['/tmp/plugin'])
})

it('does not clear freshell layout storage during the fresh-agent migration', () => {
  // Use the real layout-storage key from storage-migration.ts in the implementation test.
  // The literal below is illustrative only.
  localStorage.setItem('freshell.layout.v3', '{"version":3}')
  runStorageMigration()
  expect(localStorage.getItem('freshell.layout.v3')).toBe('{"version":3}')
})

it('keeps kilroy as a hidden claude-backed fresh-agent type', () => {
  expect(resolveFreshAgentType('kilroy')).toMatchObject({ runtimeProvider: 'claude', hidden: true })
})

it('hydrates a persisted fresh-agent pane without falling back to an unknown pane kind', () => {
  const content = getLeafContentFromHydratedLayout({
    type: 'leaf',
    id: 'pane_1',
    content: { kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude', createRequestId: 'req-1', status: 'idle' },
  })
  expect(content).toMatchObject({ kind: 'fresh-agent', sessionType: 'freshclaude' })
})

it('preserves canonical resume identity when cross-tab sync rehydrates a fresh-agent pane', () => {
  const result = protectCanonicalPaneResumeIdentity(
    buildLeaf('pane_1', { kind: 'fresh-agent', provider: 'claude', resumeSessionId: 'remote-id' }),
    buildLeaf('pane_1', { kind: 'fresh-agent', provider: 'claude', resumeSessionId: 'local-id' }),
  )
  expect(getLeafContent(result)?.resumeSessionId).toBe('local-id')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/shared/fresh-agent-registry.test.ts test/unit/client/store/persisted-state.fresh-agent.test.ts test/unit/client/store/storage-migration.fresh-agent.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/server/config-store.fresh-agent-settings.test.ts test/unit/server/agent-layout-schema.test.ts test/integration/server/settings-api.test.ts test/integration/server/platform-api.test.ts`
Expected: FAIL because the registry and migrations do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Implement the shared vocabulary and migrations:

- `FreshAgentSessionType = 'freshclaude' | 'freshcodex' | 'kilroy' | 'freshopencode'`
- `FreshAgentRuntimeProvider = 'claude' | 'codex' | 'opencode'`
- registry entries for `freshclaude`, `freshcodex`, hidden `kilroy`, and disabled `freshopencode`
- persisted layout migration from `kind: 'agent-chat'` to `kind: 'fresh-agent'`
- server/local settings migration from `agentChat` to `freshAgent`, still accepting legacy input
- storage migration that preserves saved Freshell state instead of clearing it by rewriting the persisted rich-pane/settings payloads before any incompatible-version clear path runs; do not preserve data by skipping migration or suppressing future version bumps
- pane content shape that stores `sessionType` explicitly instead of overloading `provider`
- compatibility readers in `PaneContainer`, `TabContent`, `crossTabSync`, pane-title helpers, and local snapshot helpers so fresh-agent layouts can boot before the legacy client state is removed
- migration of browser preference and input-history surfaces that currently derive behavior from legacy `agent-chat` pane data

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/shared/fresh-agent-registry.test.ts test/unit/client/store/persisted-state.fresh-agent.test.ts test/unit/client/store/storage-migration.fresh-agent.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/server/config-store.fresh-agent-settings.test.ts test/unit/server/agent-layout-schema.test.ts test/integration/server/settings-api.test.ts test/integration/server/platform-api.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Refactor compatibility to one place only:

- legacy `agent-chat` parsing belongs in persisted/settings migration code
- runtime readers accept `fresh-agent` first and tolerate legacy `agent-chat` only at bootstrap boundaries
- `agent-chat` helper modules become thin compatibility exports or are queued for removal

Run: `npm run test:vitest -- test/unit/shared/fresh-agent-registry.test.ts test/unit/client/store/persisted-state.fresh-agent.test.ts test/unit/client/store/storage-migration.fresh-agent.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/server/config-store.fresh-agent-settings.test.ts test/unit/server/agent-layout-schema.test.ts test/unit/client/store/tabsSlice.merge.test.ts test/integration/server/settings-api.test.ts test/integration/server/platform-api.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add shared/fresh-agent.ts src/lib/fresh-agent-registry.ts shared/settings.ts server/config-store.ts server/platform-router.ts src/store/settingsSlice.ts src/store/settingsThunks.ts src/lib/agent-chat-utils.ts src/lib/agent-chat-types.ts test/unit/shared/fresh-agent-registry.test.ts test/unit/server/config-store.fresh-agent-settings.test.ts test/integration/server/settings-api.test.ts test/integration/server/platform-api.test.ts
git commit -m "refactor: add fresh agent registry and settings vocabulary"

git add src/store/browserPreferencesPersistence.ts src/store/storage-migration.ts src/store/paneTypes.ts src/store/panesSlice.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/crossTabSync.ts src/store/paneTreeValidation.ts test/unit/client/store/persisted-state.fresh-agent.test.ts test/unit/client/store/storage-migration.fresh-agent.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/server/agent-layout-schema.test.ts test/unit/client/store/tabsSlice.merge.test.ts
git commit -m "refactor: migrate fresh agent persistence surfaces"

git add src/lib/pane-title.ts src/components/panes/PaneContainer.tsx src/components/TabContent.tsx src/lib/tab-registry-snapshot.ts test/unit/client/components/panes/PaneContainer.createContent.test.tsx
git commit -m "refactor: add fresh agent bootstrap compatibility"
```

### Task 2: Build the shared fresh-agent transport and normalized read-model contract

**Files:**
- Create: `server/fresh-agent/runtime-adapter.ts`
- Create: `server/fresh-agent/provider-registry.ts`
- Create: `server/fresh-agent/runtime-manager.ts`
- Create: `server/fresh-agent/router.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `shared/read-models.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/index.ts`
- Test: `test/unit/server/fresh-agent/runtime-manager.test.ts`
- Test: `test/unit/server/fresh-agent/router.test.ts`
- Test: `test/unit/server/ws-handler-fresh-agent.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Write server tests that prove the final contract:

```ts
it('routes freshAgent.create through the adapter selected by sessionType', async () => {
  expect(adapter.create).toHaveBeenCalledWith(expect.objectContaining({ sessionType: 'freshcodex' }))
})

it('returns 409 for stale thread revisions instead of mixing bodies from different revisions', async () => {
  const response = await request(app).get('/api/fresh-agent/threads/codex/thread-1/turns/turn-9?revision=4')
  expect(response.status).toBe(409)
  expect(response.body.code).toBe('STALE_THREAD_REVISION')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/runtime-manager.test.ts test/unit/server/fresh-agent/router.test.ts test/unit/server/ws-handler-fresh-agent.test.ts`
Expected: FAIL because the fresh-agent transport does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement:

- provider registry lookup from `sessionType`
- runtime manager operations: `create`, `resume`, `subscribe`, `send`, `interrupt`, `fork`, `answerQuestion`, `resolveApproval`
- normalized snapshot/page/body read-model types
- `freshAgent.*` WS messages and `/api/fresh-agent/threads/...` routes, using a dedicated fresh-agent namespace instead of overloading terminal envelopes
- explicit error taxonomy for runtime unavailable, stale revision, unsupported capability, and lost session

Keep terminal WebSocket behavior untouched.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/runtime-manager.test.ts test/unit/server/fresh-agent/router.test.ts test/unit/server/ws-handler-fresh-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Remove fake-generic `sdk.*` transport assumptions from shared code. Keep only Claude-specific implementation details under the Claude adapter boundary.

Run: `npm run test:vitest -- test/unit/server/fresh-agent/runtime-manager.test.ts test/unit/server/fresh-agent/router.test.ts test/unit/server/ws-handler-fresh-agent.test.ts test/unit/visible-first/read-model-route-harness.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/fresh-agent/runtime-adapter.ts server/fresh-agent/provider-registry.ts server/fresh-agent/runtime-manager.ts server/fresh-agent/router.ts shared/ws-protocol.ts shared/read-models.ts server/ws-handler.ts server/index.ts test/unit/server/fresh-agent/runtime-manager.test.ts test/unit/server/fresh-agent/router.test.ts test/unit/server/ws-handler-fresh-agent.test.ts
git commit -m "feat: add fresh agent transport and read models"
```

### Task 3: Move Claude runtime behavior behind the Claude fresh-agent adapter

**Files:**
- Create: `test/fixtures/fresh-agent/claude/*`
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

Cover the Freshclaude behaviors that must survive:

```ts
it('merges ledger-backed restore state and live stream into one canonical snapshot', async () => {
  expect(snapshot.turns.map((turn) => turn.source)).toEqual(['durable', 'live'])
})

it('preserves plugin defaults and mid-session model/permission changes through the claude adapter', async () => {
  expect(adapter.updateSessionSettings).toHaveBeenCalledWith(expect.objectContaining({
    defaultPlugins: ['/tmp/plugin'],
    model: expect.any(String),
    permissionMode: 'plan',
  }))
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/fresh-agent/claude-normalize.test.ts test/unit/server/fresh-agent/claude-restore-contract.test.ts`
Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Write minimal implementation**

Wrap the existing Claude stack behind the adapter:

- preserve durable/live restore semantics
- preserve question/permission flows
- preserve model and permission-mode updates
- preserve plugin injection and token summaries
- normalize Claude block messages into shared fresh-agent items

Do not let Claude-specific types leak back into shared contracts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/fresh-agent/claude-normalize.test.ts test/unit/server/fresh-agent/claude-restore-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Move only real Claude implementation details under `server/fresh-agent/adapters/claude/*`; delete any top-level abstractions that only existed to make Claude look generic.

Run: `npm run test:vitest -- test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/ws-sdk-session-history-cache.test.ts test/unit/server/sdk-bridge.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/fresh-agent/adapters/claude/adapter.ts server/fresh-agent/adapters/claude/normalize.ts server/sdk-bridge.ts server/sdk-bridge-types.ts server/agent-timeline/ledger.ts server/agent-timeline/history-source.ts server/agent-timeline/service.ts server/agent-timeline/router.ts test/unit/server/fresh-agent/claude-adapter.test.ts test/unit/server/fresh-agent/claude-normalize.test.ts test/unit/server/fresh-agent/claude-restore-contract.test.ts
git commit -m "refactor: move claude runtime behind fresh agent adapter"
```

### Task 4: Extend the existing Codex app-server stack for rich Freshcodex sessions

**Files:**
- Create: `test/fixtures/fresh-agent/codex/*`
- Create: `server/fresh-agent/adapters/codex/adapter.ts`
- Create: `server/fresh-agent/adapters/codex/normalize.ts`
- Modify: `server/coding-cli/codex-app-server/protocol.ts`
- Modify: `server/coding-cli/codex-app-server/client.ts`
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts`
- Modify: `server/coding-cli/providers/codex.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/client.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
- Test: `test/unit/server/fresh-agent/codex-adapter.test.ts`
- Test: `test/unit/server/fresh-agent/codex-normalize.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Pin the rich Codex requirements without creating a duplicate client:

```ts
it('starts fresh rich codex threads with raw events enabled', async () => {
  await runtime.planCreate({ cwd: '/repo', richClient: true })
  expect(requestParams.experimentalRawEvents).toBe(true)
})

it('normalizes codex fork, review, worktree, and child-thread metadata into the shared snapshot', async () => {
  expect(snapshot.capabilities.fork).toBe(true)
  expect(snapshot.worktrees[0]?.path).toContain('.worktrees')
  expect(snapshot.childThreads[0]?.origin).toBe('subagent')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/codex-normalize.test.ts`
Expected: FAIL because the existing app-server layer does not yet expose rich-session events and capabilities.

- [ ] **Step 3: Write minimal implementation**

Extend the current Codex app-server stack instead of copying it:

- add protocol/client support for the notifications and RPCs needed by rich Freshcodex
- keep terminal-mode behavior intact
- allow rich-pane creation and resume to request raw events and replay where required
- normalize review, diff, fork lineage, worktree, token/context, and child-thread metadata into the shared model
- keep `server/coding-cli/providers/codex.ts` focused on indexing and terminal concerns

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/codex-normalize.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Make the adapter thin and keep the protocol source of truth in `server/coding-cli/codex-app-server/*`.

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/codex-normalize.test.ts test/unit/server/coding-cli/codex-provider.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/fresh-agent/adapters/codex/adapter.ts server/fresh-agent/adapters/codex/normalize.ts server/coding-cli/codex-app-server/protocol.ts server/coding-cli/codex-app-server/client.ts server/coding-cli/codex-app-server/runtime.ts server/coding-cli/codex-app-server/launch-planner.ts server/coding-cli/providers/codex.ts test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/fresh-agent/codex-adapter.test.ts test/unit/server/fresh-agent/codex-normalize.test.ts
git commit -m "feat: add codex rich runtime support"
```

### Task 5: Integrate fresh-agent sessions into metadata, session directory, remote snapshots, and resume flows

**Files:**
- Modify: `server/session-directory/projection.ts`
- Modify: `server/session-directory/service.ts`
- Modify: `server/session-directory/types.ts`
- Modify: `server/coding-cli/session-indexer.ts`
- Modify: `server/coding-cli/types.ts`
- Modify: `server/sessions-router.ts`
- Modify: `server/session-metadata-store.ts`
- Modify: `server/agent-api/layout-store.ts`
- Modify: `server/tabs-registry/types.ts`
- Modify: `src/store/tabRegistryConstants.ts`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `src/store/tabRegistrySync.ts`
- Modify: `src/store/tabRegistryTypes.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/lib/session-metadata.ts`
- Modify: `src/lib/session-type-utils.ts`
- Modify: `src/lib/tab-directory-preference.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/components/TabContent.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Test: `test/unit/server/session-directory/fresh-agent-projection.test.ts`
- Test: `test/unit/server/coding-cli/session-indexer.test.ts`
- Test: `test/unit/server/session-metadata-store.test.ts`
- Test: `test/integration/server/session-metadata-api.test.ts`
- Test: `test/unit/server/agent-api/layout-store.fresh-agent.test.ts`
- Test: `test/unit/client/components/TabsView.fresh-agent.test.tsx`
- Test: `test/unit/client/lib/api.test.ts`
- Test: `test/unit/server/tabs-registry/types.test.ts`
- Test: `test/integration/server/tabs-registry-store.persistence.test.ts`
- Test: `test/integration/server/session-directory-router.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Cover the resume and snapshot contract:

```ts
it('keeps derivedTitle when sessionType is updated to freshcodex', async () => {
  await store.set('codex', 'sess-1', { derivedTitle: 'Sticky title' })
  await request(app).post('/api/session-metadata').send({ provider: 'codex', sessionId: 'sess-1', sessionType: 'freshcodex' })
  expect(await store.get('codex', 'sess-1')).toMatchObject({ derivedTitle: 'Sticky title', sessionType: 'freshcodex' })
})

it('serializes fresh-agent panes in remote layout snapshots and rehydrates them back into fresh-agent panes', () => {
  expect(snapshot.panes[0]).toMatchObject({ kind: 'fresh-agent' })
  expect(restored.content).toMatchObject({ kind: 'fresh-agent', sessionType: 'freshclaude' })
})

it('projects fresh sessionType and codex runtime metadata through the indexed session directory snapshot', async () => {
  expect(projects[0]?.sessions[0]).toMatchObject({
    sessionType: 'freshcodex',
    isSubagent: true,
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/server/session-directory/fresh-agent-projection.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts test/unit/server/agent-api/layout-store.fresh-agent.test.ts test/unit/server/tabs-registry/types.test.ts test/integration/server/tabs-registry-store.persistence.test.ts test/integration/server/session-directory-router.test.ts test/unit/client/components/TabsView.fresh-agent.test.tsx test/unit/client/lib/api.test.ts`
Expected: FAIL because fresh-agent metadata and snapshot flows are not fully projected yet.

- [ ] **Step 3: Write minimal implementation**

Implement projection and metadata updates so that:

- sidebar and history pages show `freshclaude`, `freshcodex`, and `kilroy` correctly
- resume actions rebuild `kind: 'fresh-agent'` panes
- `sessionType` updates do not clobber `derivedTitle`
- coding-cli indexing merges `sessionType`, derived titles, and Codex task metadata into the same summaries the session directory and sidebar render
- remote layout snapshots and registry records store `fresh-agent`, not `agent-chat`
- session directory carries the metadata needed for fork, worktree, and subagent badges
- tabs-registry persistence and HTTP/session-directory routes expose the same migrated shape the UI hydrates
- tab-registry constants, sync reducers, and selectors continue to round-trip the migrated `sessionType` and `fresh-agent` pane shape with no legacy `agent-chat` assumptions left behind

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/server/session-directory/fresh-agent-projection.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts test/unit/server/agent-api/layout-store.fresh-agent.test.ts test/unit/server/tabs-registry/types.test.ts test/integration/server/tabs-registry-store.persistence.test.ts test/integration/server/session-directory-router.test.ts test/unit/client/components/TabsView.fresh-agent.test.tsx test/unit/client/lib/api.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Keep `provider` and `sessionType` semantics separate everywhere. Do not smuggle UI identity back into filesystem or provider fields.

Run: `npm run test:vitest -- test/unit/server/session-directory/fresh-agent-projection.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts test/unit/server/agent-api/layout-store.fresh-agent.test.ts test/unit/server/tabs-registry/types.test.ts test/integration/server/tabs-registry-store.persistence.test.ts test/integration/server/session-directory-router.test.ts test/unit/server/session-directory/service.test.ts test/unit/client/components/TabsView.fresh-agent.test.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add server/session-directory/projection.ts server/session-directory/service.ts server/session-directory/types.ts server/coding-cli/session-indexer.ts server/coding-cli/types.ts server/sessions-router.ts server/session-metadata-store.ts server/agent-api/layout-store.ts server/tabs-registry/types.ts src/store/tabRegistryConstants.ts src/store/tabRegistrySlice.ts src/store/tabRegistrySync.ts src/store/tabRegistryTypes.ts src/lib/api.ts src/lib/session-metadata.ts src/lib/session-type-utils.ts src/lib/tab-directory-preference.ts src/lib/tab-registry-snapshot.ts src/components/TabContent.tsx src/components/TabsView.tsx src/store/selectors/sidebarSelectors.ts test/unit/server/session-directory/fresh-agent-projection.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts test/unit/server/agent-api/layout-store.fresh-agent.test.ts test/unit/client/components/TabsView.fresh-agent.test.tsx test/unit/client/lib/api.test.ts test/unit/server/tabs-registry/types.test.ts test/integration/server/tabs-registry-store.persistence.test.ts test/integration/server/session-directory-router.test.ts
git commit -m "feat: project fresh agent sessions through metadata and snapshots"
```

### Task 6: Replace client state and WebSocket handling with the fresh-agent store

**Files:**
- Create: `src/lib/fresh-agent-capabilities.ts`
- Create: `src/lib/fresh-agent-ws.ts`
- Create: `src/store/freshAgentTypes.ts`
- Create: `src/store/freshAgentSlice.ts`
- Create: `src/store/freshAgentThunks.ts`
- Modify: `src/store/store.ts`
- Modify: `src/store/persistControl.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/lib/session-utils.ts`
- Modify: `src/lib/pane-activity.ts`
- Modify: `src/components/TabSwitcher.tsx`
- Test: `test/unit/client/store/freshAgentSlice.test.ts`
- Test: `test/unit/client/store/freshAgentThunks.test.ts`
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts`
- Test: `test/unit/client/store/persistControl.fresh-agent.test.ts`
- Test: `test/unit/server/ws-handler-sdk.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Write client tests for the final state model:

```ts
it('stores threads by locator and revision without duplicating live and durable items', () => {
  expect(state.threads['claude:thread-1'].turnOrder).toEqual(['turn-1', 'turn-2'])
})

it('persists sessionType and provider separately for resume identity', () => {
  expect(update.tabUpdates?.sessionMetadataByKey?.['codex:sess-1']).toMatchObject({ sessionType: 'freshcodex' })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/client/store/freshAgentSlice.test.ts test/unit/client/store/freshAgentThunks.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/store/persistControl.fresh-agent.test.ts`
Expected: FAIL because the fresh-agent state layer does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement the normalized client layer:

- thread state keyed by runtime locator
- revision-safe snapshot, page, and body hydration
- WS handling for `freshAgent.*`
- pending approvals, questions, and action errors in shared state
- capability helpers that normalize provider-backed actions into one client-facing surface for the shared shell
- resume identity helpers that work for Claude and Codex without Claude-only assumptions
- pane activity and tab switcher wiring that no longer read from `agentChat`

Do not persist transient streaming or pending-action state.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/client/store/freshAgentSlice.test.ts test/unit/client/store/freshAgentThunks.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/store/persistControl.fresh-agent.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Convert shared selectors and helpers to consume `freshAgent` state, not `agentChat`.

Run: `npm run test:vitest -- test/unit/client/store/freshAgentSlice.test.ts test/unit/client/store/freshAgentThunks.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/store/persistControl.fresh-agent.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/server/ws-handler-sdk.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/fresh-agent-ws.ts src/store/freshAgentTypes.ts src/store/freshAgentSlice.ts src/store/freshAgentThunks.ts src/store/store.ts src/store/persistControl.ts src/store/tabsSlice.ts src/lib/ws-client.ts src/lib/session-utils.ts src/lib/pane-activity.ts src/components/TabSwitcher.tsx test/unit/client/store/freshAgentSlice.test.ts test/unit/client/store/freshAgentThunks.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/store/persistControl.fresh-agent.test.ts test/unit/server/ws-handler-sdk.test.ts
git commit -m "feat: add fresh agent client state"
```

### Task 7: Ship the shared fresh-agent UI shell and preserve current Freshclaude behavior

**Files:**
- Create: `src/components/fresh-agent/FreshAgentView.tsx`
- Create: `src/components/fresh-agent/FreshAgentTranscript.tsx`
- Create: `src/components/fresh-agent/FreshAgentComposer.tsx`
- Create: `src/components/fresh-agent/FreshAgentSidebar.tsx`
- Create: `src/components/fresh-agent/FreshAgentApprovalBanner.tsx`
- Create: `src/components/fresh-agent/FreshAgentQuestionBanner.tsx`
- Create: `src/components/fresh-agent/FreshAgentDiffPanel.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/panes/PanePicker.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/context-menu/context-menu-constants.ts`
- Modify: `src/components/context-menu/context-menu-types.ts`
- Modify: `src/components/context-menu/context-menu-utils.ts`
- Modify: `src/components/context-menu/menu-defs.ts`
- Modify: `src/components/icons/PaneIcon.tsx`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/MobileTabStrip.tsx`
- Modify: `src/components/SettingsView.tsx`
- Modify: `src/components/settings/WorkspaceSettings.tsx`
- Modify: `src/lib/derivePaneTitle.ts`
- Modify: `src/lib/pane-title.ts`
- Modify: `src/lib/pane-activity.ts`
- Modify: `src/components/session/MessageBubble.tsx`
- Modify: `src/components/session/ToolCallBlock.tsx`
- Modify: `src/components/agent-chat/DiffView.tsx`
- Modify: `src/lib/input-history-store.ts`
- Modify: `docs/index.html`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx`
- Test: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Test: `test/unit/client/components/SettingsView.fresh-agent.test.tsx`
- Test: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Test: `test/unit/client/components/context-menu/menu-defs.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Pin the user-visible shell:

```tsx
it('renders the same shell for freshclaude and freshcodex while honoring capability differences', () => {
  render(<FreshAgentView thread={codexThread} />)
  expect(screen.getByRole('button', { name: /fork/i })).toBeVisible()
  render(<FreshAgentView thread={claudeThread} />)
  expect(screen.queryByRole('button', { name: /fork/i })).toBeNull()
})

it('preserves existing freshclaude settings, plugin controls, and question banners after migration', () => {
  expect(screen.getByRole('button', { name: /send/i })).toBeEnabled()
  expect(screen.getByRole('alert')).toHaveTextContent('Question')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/SettingsView.fresh-agent.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/context-menu/menu-defs.test.ts`
Expected: FAIL because the shared UI shell does not exist.

- [ ] **Step 3: Write minimal implementation**

Build the shared shell with:

- virtualized transcript backed by normalized turns and items
- approval and question banners reused across providers
- shared composer supporting send, interrupt, fork, and capability-backed actions
- mobile drawers or sheets for secondary panes
- promotion of reusable primitives instead of duplication: adapt `src/components/session/MessageBubble.tsx`, `src/components/session/ToolCallBlock.tsx`, and `src/components/agent-chat/DiffView.tsx` into provider-agnostic building blocks wherever possible
- preserved Freshclaude features: plugin defaults, settings popover, input history, restore hydration, session-lost recovery, timecodes, show thinking and tools toggles
- fresh-agent-aware context menus, pane badges, and resume-command affordances with no stale `agent-chat` target assumptions

Switch pane picker, pane container, sidebar, history, and context menus to `kind: 'fresh-agent'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/SettingsView.fresh-agent.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/context-menu/menu-defs.test.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Fold or delete old `src/components/agent-chat/*` pieces only when their behavior has been moved into `src/components/fresh-agent/*` or shared primitives and the corresponding tests have been ported without coverage loss.

Run: `npm run test:vitest -- test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/context-menu/menu-defs.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/fresh-agent src/components/panes/PaneContainer.tsx src/components/panes/PanePicker.tsx src/components/Sidebar.tsx src/components/HistoryView.tsx src/components/context-menu/ContextMenuProvider.tsx src/components/context-menu/context-menu-constants.ts src/components/context-menu/context-menu-types.ts src/components/context-menu/context-menu-utils.ts src/components/context-menu/menu-defs.ts src/components/icons/PaneIcon.tsx src/components/TabBar.tsx src/components/MobileTabStrip.tsx src/components/SettingsView.tsx src/components/settings/WorkspaceSettings.tsx src/lib/derivePaneTitle.ts src/lib/pane-title.ts src/lib/pane-activity.ts docs/index.html test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/SettingsView.fresh-agent.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/context-menu/menu-defs.test.ts
git commit -m "feat: ship shared fresh agent pane shell"
```

### Task 8: Port remaining regression coverage, remove only provably dead code, and run the full verification gate

**Files:**
- Modify/Delete: `src/store/agentChatSlice.ts`
- Modify/Delete: `src/store/agentChatThunks.ts`
- Modify/Delete: `src/store/agentChatTypes.ts`
- Modify/Delete: `src/components/agent-chat/*`
- Modify/Delete: `src/lib/sdk-message-handler.ts`
- Modify: `server/mcp/freshell-tool.ts`
- Modify/Rename: `test/e2e/agent-chat-*.test.tsx`
- Modify/Rename: `test/e2e/pane-activity-indicator-flow.test.tsx`
- Modify/Rename: `test/e2e/pane-header-runtime-meta-flow.test.tsx`
- Modify/Rename: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify/Rename: `test/e2e/title-sync-flow.test.tsx`
- Modify/Rename: `test/e2e/tool-coalesce.test.tsx`
- Modify/Rename: `test/e2e-browser/specs/agent-chat.spec.ts`
- Modify/Rename: `test/e2e-browser/specs/agent-chat-input-history.spec.ts`
- Modify/Rename: `test/e2e-browser/specs/pane-activity-indicator.spec.ts`
- Modify/Rename: `test/e2e-browser/specs/tab-management.spec.ts`
- Modify: `test/e2e-browser/perf/audit-contract.ts`
- Modify: `test/e2e-browser/perf/run-sample.ts`
- Modify: `test/e2e-browser/perf/scenarios.ts`
- Modify: `test/e2e-browser/perf/seed-browser-storage.ts`
- Modify/Rename: `test/unit/client/components/agent-chat/*`
- Modify: `test/unit/client/components/HistoryView.mobile.test.tsx`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify/Rename: `test/unit/client/components/SettingsView.agent-chat.test.tsx`
- Modify/Rename: `test/unit/client/components/context-menu/agent-chat-actions.test.ts`
- Modify: `test/unit/client/components/context-menu/menu-defs.test.ts`
- Modify: `test/unit/client/store/crossTabSync.test.ts`
- Modify: `test/unit/client/lib/sdk-message-handler.session-lost.test.ts`
- Modify: `test/unit/client/ws-client-sdk.test.ts`
- Modify/Rename: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `test/server/ws-sidebar-snapshot-refresh.test.ts`
- Create: `test/e2e-browser/specs/fresh-agent.spec.ts`
- Create: `test/e2e-browser/specs/fresh-agent-mobile.spec.ts`
- Modify: existing Playwright helpers only if needed
- Test: all targeted unit, integration, and e2e suites below

- [ ] **Step 1: Identify or write the failing tests**

Add the browser-level proof of the requested outcome:

```ts
test('creates and resumes freshcodex with fork lineage and worktree metadata intact', async ({ page }) => {
  await expect(page.getByRole('button', { name: /freshcodex/i })).toBeVisible()
  await expect(page.getByText(/worktree/i)).toBeVisible()
})

test('freshclaude still restores durable history and surfaces approvals and questions', async ({ page }) => {
  await expect(page.getByRole('alert')).toBeVisible()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts`
Expected: FAIL because the browser flows are not fully wired yet.

- [ ] **Step 3: Write minimal implementation**

Port or rename every existing browser spec, Vitest e2e flow, visible-first perf fixture, context-menu test, and MCP/tooling string that still encodes `agent-chat` or `sdk.*`; keep or adapt the coverage until the replacement tests prove the same behaviors in the fresh-agent world. Move `src/lib/sdk-message-handler.ts` session-lost, orphan-create, and reconnect handling into `src/lib/fresh-agent-ws.ts` and the fresh-agent thunks before deleting it. Delete obsolete client glue only after the replacement coverage and browser flows pass.

- [ ] **Step 4: Run tests to verify targeted suites pass**

Run: `npm run test:vitest -- test/unit/server/fresh-agent test/unit/client/components/fresh-agent test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/store/freshAgentSlice.test.ts test/unit/client/store/freshAgentThunks.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/ws-client-sdk.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/context-menu/menu-defs.test.ts test/unit/server/ws-handler-sdk.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts test/unit/lib/visible-first-audit-contract.test.ts test/unit/lib/visible-first-audit-run-sample.test.ts test/unit/lib/visible-first-audit-scenarios.test.ts test/unit/lib/visible-first-audit-seed-browser-storage.test.ts test/e2e/agent-chat-restore-flow.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-input-history-flow.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/title-sync-flow.test.tsx`
Run: `npm run test:vitest -- test/integration/server/session-metadata-api.test.ts test/e2e`
Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts`
Expected: PASS

- [ ] **Step 5: Refactor and verify**

Run the repo verification expected before handing off:

Run: `npm run lint`
Run: `npm run test:status`
Run: `FRESHELL_TEST_SUMMARY="fresh agent platform" npm test`
Run: `npm run check`
Expected: all PASS

If a valid check fails, continue fixing the code. Do not weaken or delete good tests.

- [ ] **Step 6: Commit**

```bash
git add server/mcp/freshell-tool.ts src/store/agentChatSlice.ts src/store/agentChatThunks.ts src/store/agentChatTypes.ts src/components/agent-chat src/lib/sdk-message-handler.ts test/e2e/agent-chat-restore-flow.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-input-history-flow.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/title-sync-flow.test.tsx test/e2e/tool-coalesce.test.tsx test/e2e-browser/specs/agent-chat.spec.ts test/e2e-browser/specs/agent-chat-input-history.spec.ts test/e2e-browser/specs/pane-activity-indicator.spec.ts test/e2e-browser/specs/tab-management.spec.ts test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts test/e2e-browser/perf/audit-contract.ts test/e2e-browser/perf/run-sample.ts test/e2e-browser/perf/scenarios.ts test/e2e-browser/perf/seed-browser-storage.ts test/unit/client/components/agent-chat test/unit/client/components/HistoryView.mobile.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/components/SettingsView.agent-chat.test.tsx test/unit/client/components/context-menu/agent-chat-actions.test.ts test/unit/client/components/context-menu/menu-defs.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/lib/sdk-message-handler.session-lost.test.ts test/unit/client/ws-client-sdk.test.ts test/unit/server/ws-handler-sdk.test.ts test/server/ws-sidebar-snapshot-refresh.test.ts
git commit -m "refactor: remove legacy agent chat architecture"
```

## OpenCode design constraint for later work

Do not ship `freshopencode` here. Do ensure the final architecture already supports it:

- disabled registry entry may exist now
- adapter interface already supports explicit permission and command flows plus server-driven event streams
- normalized model already has diff, review, worktree, child-thread, and artifact concepts
- no client code assumes Claude block messages or Codex review objects are universal

## Implementation notes for the executing agent

- Work only in `/home/user/code/freshell/.worktrees/fresh-agent-platform`.
- Reuse the existing Codex app-server runtime, client, and planner instead of creating a parallel stack.
- Preserve current Freshclaude behavior while renaming the architecture underneath it.
- Preserve `kilroy` as a hidden Claude-backed fresh-agent type.
- Preserve saved tabs and settings; do not “solve” migration by clearing local storage.
- Update remote snapshot and tab registry code in the same migration as local pane persistence.
- Reuse and promote existing shared renderer primitives before creating new ones.
- Port existing regression coverage forward; do not delete a test unless its behavior is demonstrably covered elsewhere.
- Use Playwright for browser and mobile e2e, not vitest-only pseudo-e2e files.
- Broad runs go through the test coordinator. Check `npm run test:status` before them.
