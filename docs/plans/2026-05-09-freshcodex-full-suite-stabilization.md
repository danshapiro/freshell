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

- `fresh-agent` is the canonical production pane kind for rich Claude/Codex panes. Legacy `agent-chat` records are compatibility input only and are normalized at reducer, persistence, localStorage, cross-tab, tab-registry, remote rehydration, and session-opening boundaries.
- Treat identity as a three-part contract:
  - `sessionRef` is the only portable durable identity and is the only identity published across devices or persisted as a restore target.
  - `sessionId`, `resumeSessionId`, and `serverInstanceId` are same-server/runtime handles. They can be used for live same-server attach/resume, but must be stripped from persisted/cross-server payloads unless the source server matches.
  - `restoreError` is an explicit durable-restore failure, not a lifecycle status. It suppresses automatic create and is rendered through a user-facing reason mapper because `RestoreError` currently has `{ code, reason }`, not a `message` field.
- Apply the identity contract by boundary, not by individual field names:
  - Local reducer and same-server live UI state may retain runtime handles for the current process while a durable identity is still being discovered.
  - Durable cross-server publication, tab-registry snapshots, and remote/cross-server copies must not retain `sessionId`, `resumeSessionId`, or `serverInstanceId`; they keep only `sessionRef` or an explicit `restoreError`.
  - Same-server localStorage/cross-tab payloads may retain runtime handles only when they are tagged with the current `serverInstanceId` and no durable `sessionRef` exists yet. Once `sessionRef` exists, persisted/cross-tab writeback strips runtime handles and keeps `sessionRef`.
  - `ui.layout.sync` is a live same-server signal, not durable storage. It must advertise canonical `fresh-agent.sessionRef` when available and may include same-server runtime handles for runtime-only Claude panes so server-side open-session tracking does not lose live sessions before durable metadata arrives.
  - A pane must not contain both a valid `sessionRef` and `restoreError`. Creating or discovering a valid durable `sessionRef` clears stale `restoreError`; validation rejects persisted/cross-tab payloads that contain both.
- Portable identity rules apply symmetrically at every boundary that publishes, stores, opens, copies, validates, or creates rich-agent panes: tab-registry snapshots, tab fallback identity, sidebar fallback rows, session-opening helpers, pane reducers, pane-tree validation, persisted-state parsers, persist writeback, localStorage migration, remote rehydration, and fresh-agent create/recovery.
- Named Claude resume aliases are not portable durable identities. A named alias may remain a same-server `resumeSessionId` for live/local fallback, but it must not become `sessionRef` and must not automatically become `restoreError` in same-server reducer paths. Remote/cross-server copies with only a named alias must receive `restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'missing_canonical_identity' }`.
- Claude durable identity must be based on trusted durable metadata, not on a UUID-only helper. A value from `sessionRef`, `cliSessionId`, or `timelineSessionId` is a candidate portable Claude identity; a value from bare `resumeSessionId` is portable only if it satisfies the shared canonical Claude durable-ID predicate. Align `shared/session-contract.ts` and `src/lib/claude-session-id.ts` so tests do not depend on contradictory grammars.
- `freshAgent.created` must not blindly persist the runtime `sessionId` as a Claude `sessionRef`. Codex-created thread ids are durable and should be returned/persisted as `sessionRef: { provider: 'codex', sessionId }`; Claude-created sessions should persist `sessionRef` only when the server/adaptor has a trusted canonical durable id from SDK history/timeline metadata. If the server cannot prove a Claude durable id at create time, keep the runtime `sessionId` as a same-server handle only.
- `freshAgent.created` idempotency caches and reconnect replay responses must preserve the same durable `sessionRef` as the original create result. A duplicate create request must not replay only the runtime `sessionId` and thereby lose portable identity.
- Multiple create locators must be validated before any precedence rule is applied. A provider mismatch is always an error. Conflicting durable ids are an error. Codex thread IDs are durable, so `sessionRef: { provider: 'codex', sessionId: A }` plus `resumeSessionId: B` is a conflict when `A !== B`; do not treat Codex `resumeSessionId` as a non-canonical alias. For Claude only, a non-canonical same-server `resumeSessionId` may coexist with a matching-provider `sessionRef` for live attach, but persistence keeps `sessionRef` and attach uses the runtime handle only for the current server.
- Remote copied tabs containing any rich-agent pane should have `mode: 'shell'`; do not leave copied `fresh-agent` tabs classified as terminal/CLI `claude`. Whole-tab copy mode must be derived from sanitized content across the pane tree, not only from the raw first pane, and `openPaneInNewTab()` must derive mode from the sanitized clicked pane.
- Fresh-agent create messages must carry `sessionRef`, Claude `modelSelection`, and opaque Claude effort strings. Runtime adapters validate provider-specific fields; shared WS schemas and persisted pane validators must not reject valid Claude values such as `turbo`.
- The Claude fresh-agent adapter owns resolution of transported `modelSelection` into the SDK `model` value. The client should not pre-resolve Claude model aliases before sending `freshAgent.create`.
- Codex panes keep Codex runtime fields (`model`, `sandbox`, Codex effort/settings) and must not gain Claude-shaped `modelSelection` from migration helpers. Claude-backed panes migrate legacy `model` to `modelSelection` and then remove stale `model` at every canonicalization boundary, including new-pane creation.
- Settings API patches must not contain own properties with `undefined` at any depth. Clear operations use explicit `null` sentinels where the API supports clearing. This must be proven through both thunk tests and `/api/settings` route integration tests.
- Storage migration must be idempotent for users who already ran the broken branch once. Bump the local storage version and run a targeted v2-key repair for stamped clients.
- `FreshAgentView` async effects must use targeted merges or fresh refs. `freshAgent.created`, create failure, snapshot refresh, retry, and lost-session recovery must not overwrite newer pane fields from captured stale `paneContent`.
- Persisted/cross-tab fresh-agent payloads should strip same-server `sessionId` and `resumeSessionId` once durable `sessionRef` exists, and should always strip them for remote/cross-server payloads. A restored pane with only `sessionRef` must reattach/resume through `freshAgent.create` using that `sessionRef`; a restored pane with neither `sessionRef` nor trusted same-server handles must display `restoreError` and must not auto-create an unrelated new session.
- Legacy `AgentChatView` tests may mount the legacy component directly, but test wrappers must remain faithful to settings/retry updates after reducer canonicalization. The harness must keep the component mounted without freezing the prop so stale settings cannot hide the behavior being tested.
- Plan snippets must use fixture model identifiers, not real current model names. If an implementation task needs to discuss or assert a real current provider model name, the executor must first perform and record the user's required current-model lookup; this stabilization plan should not require that lookup because it only tests pass-through and migration behavior.

Do not weaken, delete, or dilute valid tests to obtain green. When a test is obsolete, replace it with a stronger assertion for the accepted canonical contract.

## File Structure

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/TabsView.tsx`
  - Owns remote tab card copy/rehydration. It should convert legacy `agent-chat` snapshots into canonical `fresh-agent` content, preserve only portable durable identity across servers, preserve native Freshcodex fields, and choose copied tab mode from sanitized content.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/tab-registry-snapshot.ts`
  - Owns publishing local tab/pane records for other devices. It must publish only portable durable identity, must not synthesize `sessionRef` from named aliases or same-server-only handles, and must preserve provider-specific settings such as Claude `modelSelection` and Codex runtime `model`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/session-type-utils.ts`
  - Owns programmatic session-opening content such as history/sidebar/context-menu resume flows. It should create `sessionRef` only for canonical durable IDs and leave named aliases as same-server `resumeSessionId`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/session-utils.ts`
  - Owns client-side open-session locator derivation used by app/sidebar focus and dedupe flows. It must advertise canonical `fresh-agent.sessionRef` before any runtime handle and must not expose `fresh-agent.resumeSessionId` as portable identity when a durable `sessionRef` exists.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/session-contract.ts`
  - Owns portable session-reference, restore-error, and legacy durable-state migration contracts. It should distinguish context-sensitive same-server aliases from cross-server restore failures, expose a single Claude durable-ID predicate, and keep `RestoreError` as `{ code, reason }`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/claude-session-id.ts`
  - Owns client-side Claude durable-ID checks. It must delegate to or exactly match the shared durable-ID predicate so recovery, reducer migration, and tests do not disagree about valid Claude identities.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/panesSlice.ts`
  - Owns reducer-boundary pane normalization. It should normalize legacy `agent-chat` to `fresh-agent`, derive canonical `sessionRef` only from valid durable Claude IDs, and strip provider-inappropriate model fields.

- Modify or create `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/pane-content.ts`
  - Optional shared client helper for pane-content canonicalization used by `panesSlice.ts` and `persistMiddleware.ts` if that avoids duplicated model/session cleanup logic.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/paneTreeValidation.ts`
  - Owns persisted and hydrated pane shape validation. It must validate `fresh-agent.sessionRef`, `fresh-agent.restoreError`, `fresh-agent.modelSelection`, and opaque non-empty Claude effort strings without accepting malformed provider-specific fields.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/tabsSlice.ts`
  - Owns tab-level session identity when opening/copying tabs. It must set tab fallback identity from canonical `fresh-agent.sessionRef`, not only from legacy `agent-chat` content.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/tab-fallback-identity.ts`
  - Owns derived fallback tab/session identity. It must understand `fresh-agent.sessionRef` after persisted payloads strip runtime handles.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/selectors/sidebarSelectors.ts`
  - Owns sidebar fallback session rows. It must use `fresh-agent.sessionRef` when `resumeSessionId` has correctly been stripped from persisted or cross-tab payloads.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistMiddleware.ts`
  - Owns persisted pane migration/writeback. It should strip stale Claude `model`, preserve Codex runtime `model`, and preserve canonical `sessionRef` while removing same-server-only runtime fields from persisted/cross-tab payloads.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistedState.ts`
  - Owns persisted layout parsing used by localStorage load, storage migration, and cross-tab sync. It must run the same provider-specific pane canonicalization as reducers and persist middleware.

- Modify if needed `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/layoutMirrorMiddleware.ts`
  - Owns live `ui.layout.sync` payload dispatch. It should continue sending live pane state while server-side locator extraction handles canonical `fresh-agent` identity and same-server runtime handles correctly.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/storage-migration.ts`
  - Owns one-time localStorage version repair. It should migrate or salvage v2 tab/pane keys into `freshell.layout.v3`, remove v2 keys after safe migration, and rerun for already-stamped broken branch clients.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/ws-protocol.ts`
  - Owns fresh-agent WS message schemas. `freshAgent.create` should accept `sessionRef`, `modelSelection`, and opaque non-empty effort strings.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/runtime-adapter.ts`
  - Owns runtime adapter request types. It should match the provider-specific create payload accepted by WS, including optional `sessionRef` and Claude `modelSelection`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/runtime-manager.ts`
  - Owns fresh-agent create/resume routing. It should validate every supplied locator for provider/id consistency before choosing live attach precedence, prefer same-provider `sessionRef.sessionId` when no same-server runtime handle exists, reject mismatched locators clearly, and pass provider-specific settings through to adapters.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/adapters/claude/adapter.ts`
  - Owns translating Claude fresh-agent create input into SDK bridge input. It must resolve `modelSelection` into the actual SDK `model` value and must preserve opaque Claude effort values.

- Modify if needed `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/adapters/codex/adapter.ts`
  - Owns Codex create response identity. It should return a durable Codex `sessionRef` for newly created/resumed thread ids so the client does not infer provider durability from raw runtime handles.

- Modify if needed `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/ws-handler.ts`
  - Owns WS create validation, created replay/idempotency, `ui.layout.sync` session-locator extraction, and error responses. It should surface clear create failures for mismatched locators or invalid provider-specific create settings, preserve `sessionRef` in cached `freshAgent.created` replay, and keep live same-server FreshAgent panes visible to server-side open-session tracking.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/settings.ts`
  - Owns server settings sanitization/merge. It should normalize legacy `defaultModel` / `defaultEffort` into canonical `modelSelection` / `effort` for both `freshAgent` and `agentChat` aliases.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/config-store.ts` only if real `ConfigStore.load()` compatibility tests expose a gap that cannot be fixed in `shared/settings.ts`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/settingsThunks.ts`
  - Owns client API patch normalization. It should normalize provider clear sentinels for all present aliases and prune/convert own `undefined` fields before calling `/api/settings`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/settings-router.ts`
  - Owns `/api/settings` patch normalization. It must accept and clear `freshAgent.providers.*` sentinels through the same route-level behavior already covered for legacy `agentChat`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/panes/PaneContainer.tsx`
  - Owns user-visible new-pane creation. It must create Claude-backed `fresh-agent` panes with `modelSelection` rather than runtime `model`, while keeping Freshcodex runtime `model` fields provider-specific.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistControl.ts`
  - Owns reusable durable identity helpers. Add a fresh-agent identity update helper here if `FreshAgentView` needs the same persisted identity/flush behavior already used by legacy `AgentChatView`.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/fresh-agent/FreshAgentView.tsx`
  - Owns fresh-agent client lifecycle. It should send provider-specific create settings, recover with the freshest canonical durable ID, persist/flush canonical `sessionRef`, and use stale-update-safe targeted merges.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/context-menu/ContextMenuProvider.tsx`
  - Owns context menu selectors. It should use stable module-level empty fallback objects/arrays.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/TabsView.test.tsx`
  - Assert remote legacy `agent-chat` rehydrates as canonical `fresh-agent`, copied tab mode is `shell`, named aliases are not portable, and remote same-server-only handles are dropped.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/TabsView.fresh-agent.test.tsx`
  - Assert native Freshcodex remote snapshots preserve `sessionRef` and Codex runtime fields while dropping remote `resumeSessionId` / `sessionId`, and reject `resumeSessionId`-only remote snapshots as non-portable.

- Modify or create `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/paneTreeValidation.test.ts`
  - Assert well-formed `fresh-agent` panes accept opaque Claude effort strings plus either valid `sessionRef` or valid `restoreError`, and reject malformed variants or `sessionRef` plus `restoreError` together.

- Modify or create `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/tab-fallback-identity.test.ts`
  - Assert fallback tab identity is derived from `fresh-agent.sessionRef` after same-server runtime handles are removed.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/session-utils.test.ts`
  - Assert open-session locators prefer `fresh-agent.sessionRef`, omit stale `resumeSessionId` when durable identity exists, and keep same-server runtime-only Claude handles only for live local flows.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/shared/session-contract.test.ts`
  - Assert the shared Claude durable-ID predicate, context-aware durable-state migration, and `sessionRef` / `restoreError` mutual exclusion.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/claude-session-id.test.ts`
  - Assert the client Claude durable-ID predicate exactly matches or delegates to the shared predicate.

- Modify or extend `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/selectors/sidebarSelectors.test.ts`
  - Assert sidebar fallback session rows include sessionRef-only `fresh-agent` panes and do not depend on stripped `resumeSessionId`.

- Modify or create `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/tab-registry-snapshot.test.ts`
  - Assert local tab-registry publication preserves only portable identities and provider-specific settings for legacy agent-chat and fresh-agent panes.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/session-type-utils.test.ts`
  - Assert `buildResumeContent()` does not create invalid portable Claude identities from named aliases and still preserves canonical durable IDs.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesSlice.test.ts`
  - Replace obsolete raw `agent-chat` expectations with reducer-boundary canonicalization coverage, including valid canonical IDs and named-alias non-portability.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesPersistence.test.ts`
  - Assert Claude-backed migrated panes drop stale `model`, Codex panes keep runtime `model` without gaining `modelSelection`, and persisted parser/cross-tab paths cannot bypass the canonicalization.

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

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/integration/server/settings-api.test.ts`
  - Assert `/api/settings` accepts and clears `freshAgent.providers.*` model/effort sentinels without undefined properties and mirrors compatibility aliases correctly.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
  - Assert new FreshClaude/FreshAgent panes use Claude `modelSelection` / opaque effort fields while Freshcodex panes keep runtime `model` / Codex settings.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx`
  - Assert canonical durable recovery beats named aliases, named fallback still works when no canonical durable ID exists, and canonical identity is persisted.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
  - Align persisted FreshAgent reload expectations with the sessionRef-driven create/resume contract instead of the old direct attach-from-runtime-handle contract.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
  - Align refresh/split-pane restore expectations with the sessionRef-driven create/resume contract and same-server handle boundary.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
  - Add stale-update regression coverage for created/create-failed/snapshot/retry/recovery paths.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/fresh-agent-ws.test.ts`
  - Assert fresh-agent create cancellation and late-create behavior still work with the expanded create payload.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/fresh-agent/runtime-manager.test.ts`
  - Assert create/resume locator precedence, mismatch errors, and provider-specific create payload handling.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/fresh-agent/claude-adapter.test.ts`
  - Assert Claude adapter resolves transported `modelSelection` into the SDK bridge `model` field and preserves opaque effort values.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/ws-handler-fresh-agent.test.ts`
  - Assert WS create accepts valid Claude dynamic effort/modelSelection, rejects mismatched locators clearly, preserves Freshcodex create settings, preserves `sessionRef` in idempotent `freshAgent.created` replay, and extracts live fresh-agent locators from `ui.layout.sync`.

- Modify if needed `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/server/ws-tabs-registry.test.ts`
  - Add an integration-level guard for live `ui.layout.sync` open-session tracking if `ws-handler-fresh-agent.test.ts` cannot cover that boundary faithfully.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/e2e/agent-chat-capability-settings-flow.test.tsx`
  - Repair the legacy component harness so it keeps `AgentChatView` mounted after reducer canonicalization while still feeding it updated settings/retry state.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/ContextMenuProvider.test.tsx`
  - Add or extend a warning regression test for stable selector fallbacks.

- Modify `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/e2e-browser/specs/fresh-agent-mobile.spec.ts`
  - Include the existing mobile restored FreshAgent browser smoke in final verification because this plan changes restored pane identity and lifecycle behavior.

## Known Red Checks

These known failures are in scope and must be green before the work is complete. Do not run paths marked `Modify or create` until the task step has created those files; the red phase should fail on product behavior, not on "file not found".

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/lib/tab-registry-snapshot.test.ts \
  test/unit/client/lib/tab-fallback-identity.test.ts \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/shared/session-contract.test.ts \
  test/unit/client/lib/claude-session-id.test.ts \
  test/unit/client/lib/session-type-utils.test.ts \
  test/unit/client/store/paneTreeValidation.test.ts \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/client/store/storage-migration.test.ts \
  test/unit/client/components/panes/PaneContainer.createContent.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/e2e/agent-chat-capability-settings-flow.test.tsx \
  test/unit/client/components/ContextMenuProvider.test.tsx
```

```bash
npm run test:server -- --run \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/server/config-store.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts \
  test/integration/server/settings-api.test.ts
```

Final verification must also include:

```bash
npm run typecheck
npm run lint
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts
FRESHELL_TEST_SUMMARY="freshcodex full-suite blocker closure" npm run check
git diff --check
```

If coordinated `npm run check` reports additional failures touching fresh-agent, freshcodex, legacy agent-chat compatibility, settings, pane persistence, storage migration, remote tab rehydration, or the context menu warning fixed here, continue fixing them in this same implementation cycle. If it reports genuinely unrelated pre-existing failures, stop with exact paths, logs, and evidence; do not silently declare success.

### Task 1: Lock Canonical Pane Identity And Remote Rehydration

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/TabsView.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/tab-registry-snapshot.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/session-type-utils.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/session-contract.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/claude-session-id.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/panesSlice.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/tabsSlice.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/tab-fallback-identity.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/selectors/sidebarSelectors.ts`
- Modify or create: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/pane-content.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/TabsView.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/TabsView.fresh-agent.test.tsx`
- Modify or create: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/tab-registry-snapshot.test.ts`
- Modify or create: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/tab-fallback-identity.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/session-type-utils.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesSlice.test.ts`

- [ ] **Step 1: Identify the failing tests**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/lib/tab-registry-snapshot.test.ts \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/shared/session-contract.test.ts \
  test/unit/client/lib/claude-session-id.test.ts \
  test/unit/client/lib/session-type-utils.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/store/panesSlice.test.ts
```

Expected before changes: remote legacy `agent-chat` snapshots either remain `agent-chat`, keep stale `tab.mode: 'claude'`, synthesize non-portable resume aliases, publish invalid portable identities, or fail to preserve native Freshcodex durable identity correctly.

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
  modelSelection: { kind: 'tracked', modelId: 'tracked-fixture-claude-model' },
  permissionMode: 'plan',
  effort: 'turbo',
  plugins: ['planner'],
})
expect(copiedLayout.content.serverInstanceId).toBeUndefined()
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

Add a negative native `fresh-agent` remote snapshot test where the payload has only `resumeSessionId: 'codex-runtime-handle'` and no `sessionRef`. Assert the copied pane has no `sessionRef`, no remote `resumeSessionId`, and a visible `restoreError`. This covers the canonical `fresh-agent` steady-state case, not only legacy `agent-chat` snapshots.

Add a multi-pane context-menu test for `openPaneInNewTab()`: make the remote record's first pane a terminal or legacy agent pane, open a later sanitized rich-agent pane in its own tab, and assert the new tab uses `mode: 'shell'` derived from the clicked pane's sanitized content rather than `deriveModeFromRecord(record)`.

Add a whole-tab multi-pane copy test where the first raw pane is terminal/CLI-like and a later pane sanitizes to `fresh-agent`. Assert the copied tab uses `mode: 'shell'` because the sanitized tree contains a rich-agent pane anywhere in the copied layout.

In `test/unit/client/lib/tab-registry-snapshot.test.ts`, add publication tests for `buildOpenTabRegistryRecord()` / `collectPaneSnapshots()`:

- legacy `agent-chat` with a canonical Claude durable ID publishes canonical `kind: 'fresh-agent'`, `sessionRef`, and `modelSelection`, and does not publish `sessionId`, `resumeSessionId`, or `serverInstanceId`;
- legacy `agent-chat` with `resumeSessionId: 'named-resume'` does not publish `sessionRef`;
- native `fresh-agent` Codex publishes canonical `kind: 'fresh-agent'`, explicit `sessionRef`, Codex `model`, and Codex runtime fields, and does not publish same-server runtime handles;
- native `fresh-agent` with only `resumeSessionId` does not synthesize a portable `sessionRef`.

In `test/unit/client/lib/session-type-utils.test.ts`, add `buildResumeContent()` coverage:

- `freshclaude` / `kilroy` with a canonical Claude durable ID include `sessionRef`;
- `freshclaude` / `kilroy` with a named alias keep `resumeSessionId` but omit `sessionRef`;
- `freshcodex` with a Codex durable thread ID includes `sessionRef`;
- provider-specific defaults remain provider-specific (`modelSelection` for Claude-backed sessions, runtime `model` for Codex).

In `test/unit/client/lib/session-utils.test.ts`, add open-session locator coverage:

- a `fresh-agent` pane with `sessionRef` and `resumeSessionId` yields a single durable locator based on `sessionRef`, not a duplicate/stale `resumeSessionId` locator;
- a `fresh-agent` pane with only a same-server Claude runtime `resumeSessionId` yields a live local locator but is not marked portable;
- a Freshcodex pane with conflicting `sessionRef` and `resumeSessionId` is treated as invalid/ambiguous by any helper that would otherwise advertise it.

In `test/unit/shared/session-contract.test.ts` and `test/unit/client/lib/claude-session-id.test.ts`, add direct predicate coverage so the shared and client Claude durable-ID checks accept and reject the same fixture IDs.

In `test/unit/client/lib/tab-fallback-identity.test.ts`, add coverage that a single-pane tab containing `fresh-agent.sessionRef` yields a stable fallback identity even when `sessionId` and `resumeSessionId` are absent.

In `test/unit/client/store/selectors/sidebarSelectors.test.ts`, add coverage that sessionRef-only `fresh-agent` panes still appear in sidebar fallback session rows after persisted/cross-tab sanitization has stripped `resumeSessionId`.

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
  test/unit/client/lib/tab-registry-snapshot.test.ts \
  test/unit/client/lib/tab-fallback-identity.test.ts \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/shared/session-contract.test.ts \
  test/unit/client/lib/claude-session-id.test.ts \
  test/unit/client/lib/session-type-utils.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/store/panesSlice.test.ts
```

Expected: failures point to missing remote conversion, stale tab mode, invalid publisher/session-helper identity synthesis, missing native Freshcodex assertions, or reducer sessionRef derivation.

- [ ] **Step 4: Implement canonicalization at reducer and remote snapshot boundaries**

In `shared/session-contract.ts`, first make the durable-state helper context-aware. The helper should separate "same-server local normalization" from "remote/cross-server portable restore":

- In local reducer/session-opening contexts, a named Claude `resumeSessionId` remains a same-server runtime alias and does not become `restoreError`.
- In remote/cross-server contexts, a named Claude alias is not portable and becomes `restoreError: buildRestoreError('missing_canonical_identity')`.
- Trusted `sessionRef`, `cliSessionId`, and `timelineSessionId` values are accepted through the shared Claude durable-ID predicate; a bare `resumeSessionId` is promoted only if it satisfies that predicate.

Update `src/lib/claude-session-id.ts` to delegate to or exactly match the shared predicate so client recovery tests and shared migration agree.

In `src/store/panesSlice.ts`, canonicalize `agent-chat` through that context-aware durable-state helper rather than ad hoc string checks:

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

For native `snapshot.kind === 'fresh-agent'`, preserve explicit `sessionRef`, preserve Freshcodex runtime fields, and drop remote `resumeSessionId` / `sessionId` unless `sameServer` is true. Do not use `resumeSessionId` as a `sessionRef` fallback for remote native fresh-agent snapshots; if no portable identity remains, set `restoreError`.

Update copied tab mode derivation so mode is based on sanitized content. A copied tab with any sanitized `fresh-agent` pane anywhere in the copied tree must be `mode: 'shell'`, even if the remote registry snapshot was legacy `agent-chat` or the first raw pane was terminal-like. Apply the same rule in `openPaneInNewTab()`: derive mode from the sanitized clicked pane, not from the whole remote record's first pane.

In `src/lib/tab-registry-snapshot.ts`, use the same durable-state helper to publish portable identity. Never synthesize `sessionRef` from a named alias or a same-server-only handle. Preserve `modelSelection` for Claude-backed panes and Codex runtime `model` / `sandbox` / settings for Codex panes.

Publish canonical `fresh-agent` snapshot content for rich-agent panes. Do not publish legacy `agent-chat` `kind`, `sessionId`, `resumeSessionId`, or `serverInstanceId` across devices. Same-server-only handles are local runtime implementation details, not tab-registry data.

In `src/lib/session-type-utils.ts`, update `buildResumeContent()` so explicit `sessionRef` is created only when `opts.sessionId` is a canonical durable ID for the runtime provider. Non-canonical Claude aliases remain `resumeSessionId` only.

In `src/store/tabsSlice.ts` and `src/lib/tab-fallback-identity.ts`, teach tab-level identity derivation about canonical `fresh-agent.sessionRef`. This prevents a correctly sanitized rich-agent pane from losing tab identity just because it no longer has legacy `agent-chat` content or runtime handles.

In `src/store/selectors/sidebarSelectors.ts`, read `fresh-agent.sessionRef` before same-server `resumeSessionId` for fallback session rows. SessionRef-only panes must remain visible after persistence strips runtime handles.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/lib/tab-registry-snapshot.test.ts \
  test/unit/client/lib/tab-fallback-identity.test.ts \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/shared/session-contract.test.ts \
  test/unit/client/lib/claude-session-id.test.ts \
  test/unit/client/lib/session-type-utils.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/store/panesSlice.test.ts
```

Expected: all selected tests pass for the canonical identity contract.

- [ ] **Step 6: Commit**

```bash
git add \
  src/components/TabsView.tsx \
  src/lib/tab-registry-snapshot.ts \
  src/lib/session-type-utils.ts \
  src/lib/session-utils.ts \
  shared/session-contract.ts \
  src/lib/claude-session-id.ts \
  src/store/panesSlice.ts \
  src/store/tabsSlice.ts \
  src/lib/tab-fallback-identity.ts \
  src/store/selectors/sidebarSelectors.ts \
  src/lib/pane-content.ts \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/components/TabsView.fresh-agent.test.tsx \
  test/unit/client/lib/tab-registry-snapshot.test.ts \
  test/unit/client/lib/tab-fallback-identity.test.ts \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/shared/session-contract.test.ts \
  test/unit/client/lib/claude-session-id.test.ts \
  test/unit/client/lib/session-type-utils.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/store/panesSlice.test.ts
git commit -m "Canonicalize fresh-agent pane identity"
```

If `src/lib/pane-content.ts` was not created, omit it from `git add`.

### Task 2: Make Fresh-Agent Create Payloads Provider-Aware

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/ws-protocol.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/runtime-adapter.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/runtime-manager.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/adapters/claude/adapter.ts`
- Modify if needed: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/fresh-agent/adapters/codex/adapter.ts`
- Modify if needed: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/ws-handler.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/panes/PaneContainer.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/fresh-agent-ws.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/fresh-agent/claude-adapter.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/fresh-agent/runtime-manager.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/ws-handler-fresh-agent.test.ts`

- [ ] **Step 1: Identify or write failing protocol tests**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/unit/client/components/panes/PaneContainer.createContent.test.tsx
npm run test:server -- --run \
  test/unit/server/fresh-agent/claude-adapter.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts
```

Expected before changes: fresh-agent create does not support enough provider-specific fields, adapter settings resolution, or locator semantics to resume remote copied Freshcodex/FreshClaude panes safely.

- [ ] **Step 2: Add tests for provider-aware create payloads**

In `test/unit/server/ws-handler-fresh-agent.test.ts`, add coverage that `freshAgent.create` accepts:

```ts
{
  type: 'freshAgent.create',
  requestId: 'req-1',
  sessionType: 'freshclaude',
  provider: 'claude',
  sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
  modelSelection: { kind: 'tracked', modelId: 'tracked-fixture-claude-model' },
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

Add an idempotent replay case: send a `freshAgent.create` request that succeeds with `sessionRef`, resend the same `requestId` after reconnect, and assert the cached `freshAgent.created` replay includes the original `sessionRef` as well as the runtime `sessionId`.

Add a live layout-sync case: send `ui.layout.sync` containing a `fresh-agent` pane with `sessionRef` and assert server-side open-session tracking records the canonical locator. Add a second case for a current-server runtime-only Claude-backed `fresh-agent` pane with `resumeSessionId` / `sessionId` and matching `serverInstanceId`, and assert the live same-server locator remains tracked. If `ws-handler-fresh-agent.test.ts` cannot exercise this integration faithfully, add the case to `test/server/ws-tabs-registry.test.ts`.

In `test/unit/server/fresh-agent/runtime-manager.test.ts`, assert create/resume precedence:

- provider mismatch in any supplied locator fails before resume/create precedence is applied;
- two conflicting canonical durable locators fail clearly instead of silently choosing one;
- Freshcodex `sessionRef: { provider: 'codex', sessionId: 'codex-thread-a' }` plus `resumeSessionId: 'codex-thread-b'` fails clearly because Codex thread IDs are durable and cannot be treated as same-server aliases;
- `resumeSessionId` wins for same-server live resumes only after locator consistency has passed;
- a non-canonical same-server Claude `resumeSessionId` may coexist with matching-provider `sessionRef` for live attach, and persistence still keeps only `sessionRef`;
- `sessionRef.sessionId` is used when `resumeSessionId` is absent and `sessionRef.provider` matches the runtime provider.
- Codex create preserves `model`, `sandbox`, and Codex effort/settings.
- Claude create preserves `modelSelection` and opaque effort strings.

Add created-identity tests:

- Codex create/resume returns a `sessionRef` in the created payload because Codex thread ids are durable.
- Claude create does not synthesize `sessionRef` from the SDK bridge runtime `sessionId` alone; it returns/persists `sessionRef` only when the adapter has trusted canonical SDK/timeline history metadata.

In `test/unit/server/fresh-agent/claude-adapter.test.ts`, assert the Claude adapter resolves `modelSelection` into the actual `sdkBridge.createSession({ model })` value:

- `{ kind: 'exact', modelId: 'fixture-claude-model' }` becomes `model: 'fixture-claude-model'`;
- tracked/alias model selections are resolved by the same helper used by legacy AgentChat where possible, or by a small shared resolver if the legacy helper is client-only;
- no `modelSelection` means the adapter uses the existing provider default behavior;
- opaque effort strings such as `turbo` are passed through without the shared transport rejecting them.

In `test/unit/client/lib/fresh-agent-ws.test.ts`, assert create cancellation/late-created handling still works when create messages include `sessionRef` and `modelSelection`.

In `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`, assert user-visible new-pane creation keeps provider fields separate:

- FreshClaude/FreshAgent panes use `modelSelection` and opaque Claude effort fields and do not get a runtime `model`.
- Freshcodex panes keep runtime `model`, `sandbox`, and Codex settings and do not get Claude `modelSelection`.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/unit/client/components/panes/PaneContainer.createContent.test.tsx
npm run test:server -- --run \
  test/unit/server/fresh-agent/claude-adapter.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts
```

Expected: validation/type/runtime gaps are red.

- [ ] **Step 4: Implement provider-aware create contract**

In `shared/ws-protocol.ts`, extend `FreshAgentCreateSchema`:

- Add `sessionRef: SessionLocatorSchema.optional()`.
- Add `modelSelection: AgentChatModelSelectionSchema.optional()` or the local shared equivalent already used for pane settings.
- Change `effort` from a fixed Codex enum to a trimmed non-empty string. Provider adapters can reject unsupported values later, but the shared fresh-agent transport must not reject Claude dynamic efforts.
- Add optional `sessionRef` to `freshAgent.created` responses if it is not already present, but only as an explicitly supplied durable identity from the runtime manager/adapter. Do not require clients to infer portability from raw `sessionId`.

Update exported `FreshAgentCreateRequest` types in `server/fresh-agent/runtime-adapter.ts` to match.

In `src/components/fresh-agent/FreshAgentView.tsx`, include `sessionRef` and `modelSelection` in `buildCreateMessage()`. Keep `model` for Codex runtime model selection.

In `src/components/panes/PaneContainer.tsx`, update new-pane content creation so Claude-backed `fresh-agent` panes are initialized with `modelSelection` / opaque `effort` and no runtime `model`; Freshcodex panes keep runtime `model` / `sandbox` fields and no Claude `modelSelection`.

In `server/fresh-agent/runtime-manager.ts`, validate locators before resolving create identity:

1. If any supplied `sessionRef.provider` differs from the runtime provider, throw a clear typed error for the WS handler.
2. If `sessionRef.provider === 'codex'`, treat any supplied `resumeSessionId` as a durable Codex thread ID; if it differs from `sessionRef.sessionId`, throw a clear conflicting-locator error.
3. If `sessionRef.provider === 'claude'` and `resumeSessionId` is a canonical durable id that differs from `sessionRef.sessionId`, throw a clear conflicting-locator error.
4. If `resumeSessionId` is a non-canonical same-server Claude alias and `sessionRef` is present, allow live attach with `resumeSessionId` but keep `sessionRef` as the durable identity.
5. If `resumeSessionId` is present and locator consistency passed, use it for same-server live resume.
6. Else if `sessionRef` is present, use `sessionRef.sessionId`.
7. Else create a new session.

Do not silently ignore mismatched locators.

In `server/ws-handler.ts`, extend the pending create/cache record so it stores and replays the durable `sessionRef` from the original create result. The idempotent duplicate-request path must not reconstruct `freshAgent.created` from only `sessionId`, `sessionType`, and `runtimeProvider`.

Also update `ui.layout.sync` session extraction so canonical `fresh-agent.sessionRef` is advertised first, and same-server runtime handles are used only for live local tracking when no durable identity exists. This boundary must not publish or dedupe remote sessions by stale `fresh-agent.resumeSessionId` when a `sessionRef` is present.

In `server/fresh-agent/adapters/claude/adapter.ts`, resolve `input.modelSelection` before calling the SDK bridge. Prefer an existing shared resolver if one exists; otherwise extract a server-safe helper whose contract is covered by `claude-adapter.test.ts`. The adapter, not `FreshAgentView`, owns converting `modelSelection` to the SDK `model` field so FreshClaude/FreshAgent behavior stays consistent across REST/WS callers.

In the adapter/runtime-manager create result, distinguish runtime handle from portable identity. Codex adapter results should carry `sessionRef: { provider: 'codex', sessionId: threadId }`; Claude adapter results should carry `sessionRef` only when canonical CLI/timeline history metadata is available, never from the SDK bridge's generated runtime handle.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/unit/client/components/panes/PaneContainer.createContent.test.tsx
npm run test:server -- --run \
  test/unit/server/fresh-agent/claude-adapter.test.ts \
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
  server/fresh-agent/adapters/claude/adapter.ts \
  server/fresh-agent/adapters/codex/adapter.ts \
  server/ws-handler.ts \
  test/server/ws-tabs-registry.test.ts \
  src/components/panes/PaneContainer.tsx \
  src/components/fresh-agent/FreshAgentView.tsx \
  test/unit/client/components/panes/PaneContainer.createContent.test.tsx \
  test/unit/client/lib/fresh-agent-ws.test.ts \
  test/unit/server/fresh-agent/claude-adapter.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts
git commit -m "Support provider-aware fresh-agent create"
```

Omit `server/ws-handler.ts`, `server/fresh-agent/adapters/codex/adapter.ts`, and `test/server/ws-tabs-registry.test.ts` if they did not change.

### Task 3: Fix Persisted Pane And Storage-Key Migration

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistMiddleware.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistedState.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/storage-migration.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/paneTreeValidation.ts`
- Modify or create: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/pane-content.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/panesPersistence.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/storage-migration.test.ts`
- Modify or create: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/paneTreeValidation.test.ts`

- [ ] **Step 1: Identify the failing tests**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.test.ts
```

If `test/unit/client/store/paneTreeValidation.test.ts` already exists when execution starts, include it in this red run. If it does not exist, create it in Step 2 before adding it to Step 3; the red phase must fail on validation behavior, not on a missing test module.

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
  modelId: 'fixture-claude-model',
})
```

Add a sibling Codex regression:

```ts
expect(content.kind).toBe('fresh-agent')
expect(content.provider).toBe('codex')
expect(content.model).toBe('codex-model')
expect(content.modelSelection).toBeUndefined()
```

Add or extend cross-tab/persisted hydration coverage so `parsePersistedLayoutRaw()` / `parsePersistedPanesRaw()` / `hydratePanes()` cannot keep stale Claude `model` via a path that bypasses `loadPersistedPanes()`. This must cover `src/store/persistedState.ts`, because storage migration and cross-tab sync use that parser boundary directly.

Add persisted runtime-handle coverage:

- A fresh-agent pane with `sessionRef` plus `sessionId` / `resumeSessionId` persists with `sessionRef` and without same-server runtime handles.
- A same-server runtime-only Claude-backed fresh-agent pane with current `serverInstanceId` and no `sessionRef` remains locally resumable instead of being converted to `restoreError`.
- The same runtime-only pane copied/published as a remote/cross-server payload drops runtime handles and receives `restoreError`.
- A restored persisted pane with only `sessionRef` remains in a lifecycle state that will resume through `freshAgent.create` rather than being treated as already connected.
- A rich-agent pane with neither `sessionRef` nor same-server handles gets a `restoreError` and does not become a new-session create on reload.

In `test/unit/client/store/paneTreeValidation.test.ts`, assert `isWellFormedPaneTree()` accepts a fresh-agent Claude pane with a valid durable identity:

```ts
{
  kind: 'fresh-agent',
  sessionType: 'freshclaude',
  provider: 'claude',
  createRequestId: 'req-1',
  status: 'idle',
  effort: 'turbo',
  modelSelection: { kind: 'tracked', modelId: 'tracked-fixture-claude-model' },
  sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
}
```

Assert it separately accepts an un-restorable pane with only `restoreError`:

```ts
{
  kind: 'fresh-agent',
  sessionType: 'freshclaude',
  provider: 'claude',
  createRequestId: 'req-1',
  status: 'create-failed',
  restoreError: { code: 'RESTORE_UNAVAILABLE', reason: 'missing_canonical_identity' },
}
```

Also assert malformed `sessionRef`, malformed `restoreError`, malformed `modelSelection`, non-string `effort`, and the invalid combination of `sessionRef` plus `restoreError` are rejected.

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
  test/unit/client/store/storage-migration.test.ts \
  test/unit/client/store/paneTreeValidation.test.ts
```

Expected: failures point to stale provider model cleanup and storage repair gaps.

- [ ] **Step 4: Implement provider-specific pane persistence migration**

In `persistMiddleware.ts` and `persistedState.ts`, use the same provider-specific model normalization contract as `panesSlice.ts`:

- `agent-chat`: migrate `model` into `modelSelection`, omit `model`.
- `fresh-agent` with `provider === 'claude'`: migrate `model` into `modelSelection`, omit `model`.
- `fresh-agent` with `provider === 'codex'`: preserve runtime `model`, omit stale `modelSelection`, preserve valid Codex runtime fields.

Update `stripTransientSessionFields()` so fresh-agent persisted/cross-tab payloads keep `sessionRef` but strip same-server-only `resumeSessionId` when a durable `sessionRef` exists or when the payload is crossing a server boundary. Do not strip portable `sessionRef`.

Also strip same-server `sessionId` for persisted/cross-tab fresh-agent payloads when a durable `sessionRef` exists or the source server does not match the current server. For a current-server runtime-only Claude pane that has no `sessionRef` yet, keep the runtime handle and `serverInstanceId` only in local same-server storage/cross-tab state so reloads during the same server lifetime can attach; never publish those fields to tab-registry/remote copies.

In `persistedState.ts`, normalize parsed pane content before it is returned to callers. The invariant is that any persisted, cross-tab, or migrated rich-agent payload leaving this parser is already canonical: legacy `agent-chat` has become `fresh-agent`, Claude `model` has been migrated to `modelSelection` and removed, Codex runtime `model` is preserved, and invalid provider/session fields are stripped.

In `paneTreeValidation.ts`, align validation with the canonical content shape:

- validate `fresh-agent.sessionRef` and `fresh-agent.restoreError` using the same shape checks as terminal/legacy agent-chat panes;
- reject `fresh-agent` content that contains both a valid `sessionRef` and `restoreError`; a valid durable identity clears the stale restore error before persistence;
- validate `fresh-agent.modelSelection` with `isAgentChatModelSelection`;
- accept opaque non-empty string `effort` values for Claude-backed panes while still rejecting non-string effort values;
- keep Codex `sandbox` enum validation.

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
  test/unit/client/store/storage-migration.test.ts \
  test/unit/client/store/paneTreeValidation.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  src/store/persistMiddleware.ts \
  src/store/persistedState.ts \
  src/store/storage-migration.ts \
  src/store/paneTreeValidation.ts \
  src/lib/pane-content.ts \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/storage-migration.test.ts \
  test/unit/client/store/paneTreeValidation.test.ts
git commit -m "Repair fresh-agent persistence migrations"
```

Omit `src/lib/pane-content.ts` if it was not created.

### Task 4: Normalize Fresh-Agent Settings Aliases And Clear Sentinels

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/shared/settings.ts`
- Modify if needed: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/config-store.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/server/settings-router.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/settingsThunks.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/store/settingsThunks.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/config-store.fresh-agent-settings.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/server/config-store.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/integration/server/settings-api.test.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/shared/settings.test.ts`

- [ ] **Step 1: Identify the failing tests**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/shared/settings.test.ts
npm run test:server -- --run \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/server/config-store.test.ts \
  test/integration/server/settings-api.test.ts
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
  modelSelection: { kind: 'exact', modelId: 'fixture-claude-model' },
  effort: 'high',
})
expect(settings.agentChat.providers.freshclaude).toEqual({
  modelSelection: { kind: 'exact', modelId: 'fixture-claude-model' },
  effort: 'high',
})
```

In `test/unit/server/config-store.test.ts`, add or strengthen a real `ConfigStore.load()` legacy-config test. Persist a version-1 config with legacy `agentChat.providers.freshclaude.defaultModel/defaultEffort` and assert the loaded config has canonical mirrored `settings.freshAgent` and `settings.agentChat`. This is required because direct `mergeServerSettings()` tests do not prove file-load compatibility.

Add two more `ConfigStore.load()` compatibility cases:

- a legacy config that contains only `freshAgent.providers.freshclaude.defaultModel/defaultEffort` also loads into canonical mirrored `freshAgent` and `agentChat` settings;
- a conflict config containing both aliases uses the explicitly documented precedence from `shared/settings.ts` and proves the lower-precedence alias does not overwrite a newer canonical `modelSelection` / `effort`.

In `test/integration/server/settings-api.test.ts`, add route-level coverage for `PATCH /api/settings` that sends `freshAgent.providers.freshclaude.modelSelection: null` and `effort: null`. Assert the route accepts the patch, clears the provider defaults, mirrors compatibility aliases as intended, and does not reintroduce `undefined` provider keys. Keep the existing legacy `agentChat` clear-sentinel test green.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/shared/settings.test.ts
npm run test:server -- --run \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/server/config-store.test.ts \
  test/integration/server/settings-api.test.ts
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

After alias-specific normalization, run a general recursive sanitizer over the outgoing API patch:

- remove own properties whose value is `undefined` when the key has no defined clear sentinel;
- convert known clearable agent-provider fields such as `modelSelection`, `effort`, and provider default fields to `null`;
- recurse through nested objects and arrays without mutating the caller's input;
- never create a top-level `freshAgent` or `agentChat` sibling just to hold `undefined` children.

Preserve existing clear behavior for coding CLI provider fields. The final payload passed to `api.patch()` must satisfy `expectNoUndefinedOwnProperties()` at every depth, not only inside `freshAgent.providers`.

In `server/settings-router.ts`, route-level normalization must handle `freshAgent.providers.*` clear sentinels in addition to the legacy `agentChat` alias. The HTTP route is part of the contract; do not rely solely on lower-level `shared/settings.ts` unit tests.

- [ ] **Step 5: Verify shared/server settings migration**

In `shared/settings.ts`, ensure the existing sanitization/merge path maps:

- `defaultModel` to `modelSelection: { kind: 'exact', modelId }`
- `defaultEffort` to `effort`
- legacy `agentChat` input to mirrored `freshAgent` and `agentChat`
- legacy `freshAgent` input to mirrored `freshAgent` and `agentChat`
- both aliases present with conflicting provider defaults to the same documented precedence covered by `ConfigStore.load()` tests

Prefer fixing `shared/settings.ts` over patching `server/config-store.ts`; `ConfigStore.load()` should become green by using the shared contract.

- [ ] **Step 6: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/shared/settings.test.ts
npm run test:server -- --run \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/server/config-store.test.ts \
  test/integration/server/settings-api.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  shared/settings.ts \
  server/config-store.ts \
  server/settings-router.ts \
  src/store/settingsThunks.ts \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/server/config-store.fresh-agent-settings.test.ts \
  test/unit/server/config-store.test.ts \
  test/integration/server/settings-api.test.ts \
  test/unit/shared/settings.test.ts
git commit -m "Normalize fresh-agent settings compatibility"
```

Omit `server/config-store.ts` if it did not change.

### Task 5: Make Fresh-Agent Recovery Stale-Update Safe

**Files:**
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/components/fresh-agent/FreshAgentView.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/lib/fresh-agent-ws.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/src/store/persistControl.ts`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Modify: `/home/user/code/freshell/.worktrees/freshcodex-contract-foundation/test/unit/client/lib/fresh-agent-ws.test.ts`

- [ ] **Step 1: Identify the failing tests**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/lib/fresh-agent-ws.test.ts
```

Expected before changes: lost-session recovery can use `named-resume` instead of the canonical durable ID, stale async updates can overwrite newer pane fields, remote restore errors can still auto-create a replacement session, and sessionRef-only resumes may not hydrate history correctly.

- [ ] **Step 2: Strengthen recovery and stale-update tests**

In `AgentChatView.session-lost.test.tsx`, keep the existing canonical assertion and add:

```ts
expect(wsMock.send).not.toHaveBeenCalledWith(expect.objectContaining({
  type: 'freshAgent.create',
  resumeSessionId: 'named-resume',
}))
```

Add a fallback test where no valid `timelineSessionId` or `cliSessionId` exists and assert `named-resume` is still used. The fix must not break legitimate non-canonical same-server resumes.

In `AgentChatView.reload.test.tsx` and `AgentChatView.split-pane.test.tsx`, replace old assertions that a persisted FreshAgent pane sends `freshAgent.attach` from stripped runtime handles. Assert a pane with only `sessionRef` resumes through the idempotent `freshAgent.create` path, while a current-server runtime-only pane with matching `serverInstanceId` can still use the live same-server handle.

In `FreshAgentView.test.tsx`, add stale-update coverage for these cases:

- `paneContent.restoreError` is rendered as a clear user-facing error and suppresses automatic `freshAgent.create`;
- `freshAgent.created` merges `sessionId`, `status`, and `createError` without clobbering a newer `model`, `modelSelection`, `permissionMode`, `plugins`, `sessionRef`, or `settingsDismissed`.
- `freshAgent.created` for a newly created durable Freshcodex session writes `sessionRef: { provider: 'codex', sessionId: message.sessionId }` before the pane can be persisted without `resumeSessionId`.
- `freshAgent.created` for a Claude-backed pane does not write `sessionRef` from `message.sessionId` unless the message contains an explicit trusted `sessionRef` or canonical history metadata.
- `freshAgent.create.failed` merges `status` and `createError` without clobbering newer fields.
- snapshot refresh merges `status` / canonical resume identity without clobbering newer pane settings.
- retry/recovery resets lifecycle fields but preserves current provider-specific settings and writes canonical `sessionRef`.
- when a canonical Claude durable ID appears after a named resume, the pane gets `sessionRef: { provider: 'claude', sessionId }`, clears or deprioritizes the named resume for durable persistence as appropriate, and dispatches `flushPersistedLayoutNow()`.
- a Freshcodex pane with `sessionRef` and no `resumeSessionId` recovers using `paneContentRef.current.sessionRef.sessionId` rather than falling through to a stale named alias or failing to resume.
- a pane that gains a valid `sessionRef` clears any stale `restoreError` in the same merge so the error does not suppress the next legitimate recovery.

In `fresh-agent-ws.test.ts`, add a sessionRef-only restore case:

```ts
registerFreshAgentCreate(dispatch, 'req-1', {
  sessionType: 'freshcodex',
  provider: 'codex',
  sessionRef: { provider: 'codex', sessionId: 'codex-thread-123' },
})
```

Assert pending-create state is marked as expecting history hydration even though `resumeSessionId` is absent. This prevents remote copied panes that intentionally drop runtime handles from being treated as new empty sessions.

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/lib/fresh-agent-ws.test.ts
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
  (paneContentRef.current.sessionRef?.provider === paneContentRef.current.provider
    ? paneContentRef.current.sessionRef.sessionId
    : undefined)
  ?? preferredResumeSessionIdRef.current
  ?? getPreferredResumeSessionId(claudeSessionRef.current)
  ?? paneContentRef.current.resumeSessionId
```

When `recoveryResumeSessionId` comes from `sessionRef`, keep that existing provider-specific durable identity. When the fallback recovery ID is a valid canonical Claude ID, also set:

```ts
sessionRef: { provider: 'claude', sessionId: recoveryResumeSessionId }
```

Use `mergePaneContent()` for targeted recovery updates unless a full replacement is genuinely required. Do not send a direct ad hoc `freshAgent.create` from recovery; recovery should continue to flow through pane state and the existing idempotent create effect.

At the create effect boundary, add an explicit guard:

```ts
if (paneContent.restoreError) return
```

Render `paneContent.restoreError` through a local helper such as `formatRestoreError(reason)` in the same visible error area as create/load/restore failures. Do not expect a message property; the shared `RestoreError` contract is `{ code, reason }`. A pane copied from another device with no portable identity is a restore failure, not a request to start a fresh unrelated session.

- [ ] **Step 5: Implement persisted identity and no-clobber lifecycle updates**

If needed, add a `buildFreshAgentPersistedIdentityUpdate()` helper in `persistControl.ts`, analogous to `buildAgentChatPersistedIdentityUpdate()`, for Claude-backed `fresh-agent` panes.

In `FreshAgentView.tsx`:

- Replace async `updatePaneContent({ content: { ...paneContent, ... } })` calls from `freshAgent.created`, `freshAgent.create.failed`, and snapshot refresh with `mergePaneContent()` targeted updates or with a freshly-read `paneContentRef.current`.
- When canonical durable identity changes, merge `sessionRef`, clear stale `restoreError`, and dispatch `flushPersistedLayoutNow()`.
- When `freshAgent.created` arrives and there is no current `sessionRef`, persist a `sessionRef` only from `message.sessionRef` or from a provider contract that explicitly declares the created id durable. Codex thread ids are durable; Claude SDK bridge runtime ids are not. This is required for new Freshcodex threads before `resumeSessionId` is stripped from persisted payloads without corrupting FreshClaude portable identity.
- Preserve current provider-specific settings on retry/recovery.
- Keep create idempotency and reconnect behavior intact.

In `fresh-agent-ws.ts`, extend `registerFreshAgentCreate()` options to accept `sessionRef`. Set `expectsHistoryHydration` when either `resumeSessionId` exists or `sessionRef` exists. Do not weaken late-create cancellation behavior.

- [ ] **Step 6: Refactor and verify**

Run:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/lib/fresh-agent-ws.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add \
  src/components/fresh-agent/FreshAgentView.tsx \
  src/lib/fresh-agent-ws.ts \
  src/store/persistControl.ts \
  test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/client/lib/fresh-agent-ws.test.ts
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
- Render `AgentChatView` through a test-only adapter that always keeps the component mounted.
- Keep the prop live, not frozen: initialize from the raw legacy content, then update a local/ref-backed `AgentChatPaneContent` from store changes or reducer-dispatched pane updates by converting canonical `fresh-agent` fields back into the legacy prop shape expected by `AgentChatView`.
- Use Redux store state for dependencies and dispatch effects.
- If a test needs to inspect reducer effects, inspect `store.getState()` separately. Do not gate component rendering on `state.panes.layouts.t1.content.kind === 'agent-chat'` after the first reducer update.
- Preserve settings/retry fidelity: after a test changes model/effort settings, the next Retry click must use the updated pane settings from the reducer-backed state rather than the initial raw prop.
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

Also run the smallest known order-sensitive batch that previously exposed the empty-DOM symptom:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/store/panesSlice.test.ts \
  test/e2e/agent-chat-capability-settings-flow.test.tsx
```

Expected: harness/warning gaps are red or reproduce. If the standalone file is green but the combined batch fails, keep the combined batch as the red check for this task.

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

Run the combined order-sensitive batch again:

```bash
npm run test:vitest -- --run \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/store/panesSlice.test.ts \
  test/e2e/agent-chat-capability-settings-flow.test.tsx
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
  test/unit/client/lib/tab-registry-snapshot.test.ts \
  test/unit/client/lib/tab-fallback-identity.test.ts \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/shared/session-contract.test.ts \
  test/unit/client/lib/claude-session-id.test.ts \
  test/unit/client/lib/session-type-utils.test.ts \
  test/unit/client/store/paneTreeValidation.test.ts \
  test/unit/client/store/panesPersistence.test.ts \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/client/store/selectors/sidebarSelectors.test.ts \
  test/unit/client/store/settingsThunks.test.ts \
  test/unit/client/store/storage-migration.test.ts \
  test/unit/client/components/panes/PaneContainer.createContent.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx \
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
  test/unit/server/fresh-agent/claude-adapter.test.ts \
  test/unit/server/fresh-agent/runtime-manager.test.ts \
  test/unit/server/ws-handler-fresh-agent.test.ts \
  test/integration/server/settings-api.test.ts \
  test/server/ws-tabs-registry.test.ts
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
npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent-mobile.spec.ts
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
