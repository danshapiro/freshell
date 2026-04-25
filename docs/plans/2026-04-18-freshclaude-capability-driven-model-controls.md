# Freshclaude Capability-Driven Model Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Freshclaude’s stale hardcoded Claude model and thinking controls with capability-driven tracked selections that automatically pick up new Anthropic model improvements without breaking persisted settings, pane restore, or tab sync.

**Architecture:** Treat live Claude runtime capabilities as the only source of truth for the live model catalog and effort levels. Persist provider settings and pane state as selection strategies: provider-default means Freshell’s stable `opus` track, tracked selections store opaque model IDs chosen from the live capability catalog, and legacy dated IDs migrate into explicit exact selections. If a persisted tracked or exact selection later disappears from the live catalog, render a synthetic saved/unavailable row so the UI preserves the current value instead of silently healing it. Add a refreshable server-side capability registry with a typed HTTP route. The registry must obtain capabilities by creating a short-lived Claude SDK query with the same sanitized environment and Claude executable settings that `server/sdk-bridge.ts` uses for real sessions, calling `query.supportedModels()`, normalizing the result, and immediately closing that probe query. Use the registry for UI/options/validation, and require the client to revalidate stale cached capabilities when the settings UI opens or when create-time validation needs fresh data. Keep create-time resolution simple: provider-default resolves to `opus`, tracked catalog IDs can launch directly, while explicit effort overrides and unavailable exact selections are validated against the live catalog before Freshell sends them.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, Claude Agent SDK, Zod, Vitest, Playwright

---

## User-Visible Behavior

Freshclaude and Kilroy must default to Freshell’s provider-default model track, which resolves to the Claude SDK alias `opus`. New Opus releases should take effect for new sessions without changing Freshell code again.

The settings UI must show:
- a provider-default option that clearly means “track latest Opus”
- live model options from Claude runtime capabilities
- a synthetic saved-selection row when the currently persisted tracked selection is missing from the latest capability catalog
- effort options from the currently selected model capability only
- migrated legacy exact model IDs as unavailable rows when they no longer exist in the live capability catalog

Freshell must not render stale hardcoded dated Claude model IDs or a fixed `[low, medium, high, max]` effort table anywhere in the UI, shared schema, pane validation, or WebSocket contract.

Freshclaude/Kilroy must stop hardcoding a provider-default effort override. When the user has not explicitly chosen an effort, Freshell should omit `effort` and let the selected model use its own default behavior.

`sdk.create` must send `model: 'opus'` for provider-default Freshclaude/Kilroy behavior. It must not omit `model`, because omission would delegate to Claude’s global default rather than Freshell’s “latest Opus” product contract.

Tracked model IDs chosen from the live capability catalog may be sent directly to `sdk.create` and `sdk.set-model`. Today those catalog IDs are alias-style values such as `opus`, `opus[1m]`, `haiku`, or `default`, but Freshell must treat them as opaque runtime data rather than a second hardcoded allowlist. Capability fetch is required for rendering options and validating explicit effort overrides or unavailable exact selections, not for blocking a plain tracked catalog ID that Freshell already persisted from the live catalog.

Opening the settings UI must revalidate stale cached capabilities instead of treating the first fetched catalog as session-lifetime truth. Automatic model improvements should appear after TTL expiry without requiring a page reload or server restart.

If a selected model does not support effort, Freshell must clear any stale explicit effort override and omit `effort` from `sdk.create`. When the stale effort still matches the current provider defaults that seed new panes, Freshell must also clear the persisted provider setting; when the stale effort only exists on a restored pane snapshot that no longer matches current provider defaults, Freshell must clear only pane state.

Because persisted legacy settings do not record whether a saved `defaultEffort` came from an old Freshclaude default or from an explicit user choice, migration must preserve any stored legacy effort value as an explicit override string. Removing provider-default effort applies only to new unsaved defaults, not to already-persisted user config.

Legacy saved exact model IDs such as `claude-opus-4-6` must remain visible and clearly marked unavailable when they are absent from the live capability catalog. Freshell must not silently rewrite them to `opus`, `default`, or a “closest” live option.

If capability discovery fails, the settings UI must show an explicit error with retry. Create-time behavior must only block when Freshell cannot safely validate what it is about to send, for example an unavailable exact selection or an explicit effort override whose support is unknown.

## Contracts And Invariants

- Runtime-selectable model IDs and effort levels come only from normalized Claude runtime capabilities. Synthetic saved/unavailable rows exist only to faithfully represent persisted selections that are absent from the current catalog; they are not a second model catalog.
- Freshell’s product default is a stable track alias, not a dated model ID. For this feature, Freshclaude and Kilroy both default to `opus`.
- Provider defaults and pane state distinguish selection from resolution:
  - no stored selection means provider default track
  - tracked selection means an opaque model string chosen from the live capability catalog; Freshell does not maintain its own hardcoded allowlist of alias names
  - exact selection means an explicit preserved model string that is not currently represented by the live capability catalog, used first for migrated legacy values and unavailable pins
- If a tracked selection is persisted but absent from the current capability catalog, Freshell keeps treating it as a tracked opaque ID for create/set-model, and the settings UI renders a synthetic “Saved selection” row so the value does not disappear or get silently rewritten.
- Pane state must carry selection strategy, not just a resolved string. Persisted layouts, tab snapshots, and restore flows must survive reload and cross-device sync with the new shape.
- `sdk.create` and `sdk.set-model` operate on resolved strings. Provider-default resolves to `opus` for both create-time and mid-session model changes; tracked selections resolve to themselves; exact selections resolve to themselves only when still available.
- `opus` is the only model ID Freshell hardcodes on purpose, because it is the product-defined provider-default track. Every other selectable model ID must come from the live capability catalog.
- Explicit effort overrides are free-form non-empty strings at the storage/protocol layer and are validated only against the selected model’s live `supportedEffortLevels`. The Claude SDK currently types those levels as a closed union, so Freshell must re-declare the shared/storage schema as `string`, then narrow or cast only at the final SDK call boundary after capability validation. Do not hardcode the current level names into shared Zod schemas, pane validation, TypeScript unions, or transport payloads.
- Capability discovery is an explicit probe, not an ambient side effect: the registry creates a short-lived SDK query, calls `supportedModels()`, caches only successful normalized results for a bounded TTL, and serializes concurrent refreshes onto a single in-flight probe.
- The capability cache must be refreshable. Do not cache the catalog for the entire server lifetime with no invalidation path.
- Client capability state must also honor staleness. Opening settings or performing validation with stale cached capabilities must trigger a refresh instead of trusting the stale client snapshot indefinitely.
- No code path silently “heals” an unavailable exact selection to a tracked alias.
- Clearing a saved override that still matches current provider defaults must remove it from persisted settings after the round trip; in-memory `undefined` alone is not sufficient. Cleanup for a stale pane-local snapshot that no longer matches provider defaults must not rewrite provider settings.

## File Structure

### Create

- `shared/agent-chat-capabilities.ts`
  Shared Zod schemas and TypeScript types for normalized Claude capabilities, tracked/exact selection strategies, capability fetch responses, and capability fetch errors.
- `server/agent-chat-capability-registry.ts`
  Server-side capability probe/cache abstraction around Claude SDK capability discovery, including the short-lived probe-query mechanism, normalization, in-flight refresh coalescing, TTL/refresh behavior, and explicit errors.
- `server/agent-chat-capabilities-router.ts`
  Typed HTTP route for reading and refreshing capabilities.
- `src/lib/agent-chat-capabilities.ts`
  Client helpers for provider-default resolution, tracked/exact selection handling, effort derivation, create-time validation, and UI option building.
- `test/unit/server/agent-chat-capability-registry.test.ts`
  Unit tests for normalization, refresh behavior, TTL caching, and failure handling.
- `test/integration/server/agent-chat-capabilities-router.test.ts`
  Contract coverage for the capability route.
- `test/unit/client/lib/agent-chat-capabilities.test.ts`
  Unit tests for selection resolution, effort derivation, and unavailable exact modeling.
- `test/e2e/agent-chat-capability-settings-flow.test.tsx`
  High-fidelity jsdom flow for capability fetch, settings rendering, persistence, and create preflight behavior.

### Modify

- `shared/settings.ts`
  Persist model-selection strategies and explicit effort overrides instead of raw `defaultModel` plus fixed effort enums.
- `shared/ws-protocol.ts`
  Remove the obsolete `sdk.models` server message and stop hardcoding effort levels in SDK message schemas.
- `server/config-store.ts`
  Preserve the new settings shape through load/save/migration.
- `server/index.ts`
  Mount the capability router.
- `server/settings-router.ts`
  Normalize explicit clear sentinels for agent-chat selection/effort patches on the HTTP boundary.
- `server/sdk-bridge.ts`
  Remove session-scoped `sdk.models` broadcast ownership and accept non-enum effort strings.
- `server/ws-handler.ts`
  Keep create/set-model behavior aligned with resolved string semantics.
- `src/lib/api.ts`
  Add typed capability fetch and refresh helpers.
- `src/lib/agent-chat-types.ts`
  Change provider config from hardcoded `defaultModel`/`defaultEffort` to provider-default track metadata plus settings visibility.
- `src/lib/agent-chat-utils.ts`
  Express Freshclaude/Kilroy provider intent as “track `opus`” with no baked-in effort override.
- `src/lib/session-type-utils.ts`
  Resume/new-pane constructors must carry model-selection strategies and optional explicit effort overrides.
- `src/lib/tab-registry-snapshot.ts`
  Serialize the new selection-strategy pane payload for tab sync.
- `src/lib/sdk-message-handler.ts`
  Remove the obsolete `sdk.models` reducer path.
- `src/store/agentChatTypes.ts`
  Replace flat `availableModels` with provider-scoped capability state and selection types.
- `src/store/agentChatSlice.ts`
  Store capabilities, fetch status, and capability errors by provider.
- `src/store/agentChatThunks.ts`
  Fetch/retry capabilities through the new HTTP route.
- `src/store/settingsThunks.ts`
  Preserve explicit clear operations for model selection and effort overrides through serialization.
- `src/store/persistedState.ts`
  Version and migrate persisted pane payloads into the new selection-strategy shape.
- `src/store/persistMiddleware.ts`
  Persist the new pane payload shape with the updated schema version.
- `src/store/paneTypes.ts`
  Replace pane-local raw `model?: string` assumptions with selection-strategy semantics plus an optional explicit effort override string.
- `src/store/panesSlice.ts`
  Normalize/hydrate the new agent-chat pane shape.
- `src/store/paneTreeValidation.ts`
  Accept the new persisted pane-content shape without hardcoded effort enums.
- `src/store/types.ts`
  Remove the stale shared `AgentChatEffort` dependency from app-wide settings typings.
- `src/components/panes/PaneContainer.tsx`
  New agent-chat panes should inherit provider-default track or saved overrides, not inject dated model IDs or a hardcoded effort.
- `src/components/TabsView.tsx`
  Rehydrate agent-chat panes from registry snapshots using the new selection-strategy payload.
- `src/components/agent-chat/AgentChatSettings.tsx`
  Render provider-default track, live capabilities, unavailable exact selections, and capability-derived effort controls.
- `src/components/agent-chat/AgentChatView.tsx`
  Resolve create/model-change payloads correctly, fetch capabilities when validation is required, clear invalid effort overrides, and persist strategy changes.
- `docs/index.html`
  Update the mock if the visible Freshclaude settings affordances materially change.

### Modify Tests

- `test/unit/shared/settings.test.ts`
- `test/integration/server/settings-api.test.ts`
- `test/unit/server/config-store.test.ts`
- `test/unit/server/sdk-bridge.test.ts`
- `test/unit/server/sdk-bridge-types.test.ts`
- `test/unit/server/ws-handler-sdk.test.ts`
- `test/unit/client/agentChatSlice.test.ts`
- `test/unit/client/store/persistedState.test.ts`
- `test/unit/client/store/panesPersistence.test.ts`
- `test/unit/client/store/agentChatThunks.test.ts`
- `test/unit/client/store/settingsThunks.test.ts`
- `test/unit/client/sdk-message-handler.test.ts`
- `test/unit/client/lib/agent-chat-utils.test.ts`
- `test/unit/client/lib/session-type-utils.test.ts`
- `test/unit/client/lib/tab-registry-snapshot.test.ts`
- `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
- `test/unit/client/components/panes/PaneContainer.test.tsx`
- `test/unit/client/components/TabsView.test.tsx`
- `test/unit/client/components/agent-chat/AgentChatSettings.test.tsx`
- `test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx`
- `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`
- `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- `test/e2e/agent-chat-capability-settings-flow.test.tsx`
- `test/e2e/pane-header-runtime-meta-flow.test.tsx`
- `test/e2e/pane-activity-indicator-flow.test.tsx`
- `test/e2e-browser/specs/agent-chat.spec.ts`
- `test/e2e-browser/specs/settings.spec.ts`
- `test/e2e-browser/specs/settings-persistence-split.spec.ts`

## Strategy Gate

The previous plan had seven real failure modes:

1. It removed hardcoded effort choices from the UI but still left hardcoded effort enums in `shared/settings.ts`, `shared/ws-protocol.ts`, pane validation, and multiple client/server types. That would still break automatic adoption if Anthropic adds or renames effort levels.
2. It used `defaultEffort` wording inside the new settings contract even though the intended behavior is “no provider-default effort; only explicit per-user overrides.” That naming would push the implementation back toward the stale design we are replacing.
3. It changed settings persistence semantics without explicitly covering the existing `/api/settings` integration tests and client-side patch normalization that are responsible for null-sentinel clears.
4. It removed `sdk.models` transport behavior without updating the dedicated schema tests that currently encode the old message and effort enum assumptions.
5. It blocked exact effort-level future-proofing because the plan still let several transport/storage boundaries assume `'low' | 'medium' | 'high' | 'max'`.
6. It was otherwise on the right architectural path, so the correct response is a focused rewrite, not a directional reset.
7. It changed pane payload semantics without explicitly updating persisted-layout schema/versioning and migration coverage, which would make reload/localStorage restoration the likeliest silent regression path.

The correct direction is:

1. Persist tracked/exact/default selection strategy, not dated model IDs.
2. Treat effort overrides as dynamic strings validated against live capabilities, not as a hardcoded enum.
3. Use a refreshable capability probe as the source of truth for UI and validation.
4. Keep provider-default and tracked aliases launchable without unnecessary capability fetch blocking.
5. Remove hardcoded provider-default effort so thinking behavior can evolve with the selected model.

## Task 1: Define Shared Selection, Dynamic Effort, And Settings Contracts

**Files:**
- Create: `shared/agent-chat-capabilities.ts`
- Modify: `shared/settings.ts`
- Modify: `server/settings-router.ts`
- Modify: `test/unit/shared/settings.test.ts`
- Modify: `test/integration/server/settings-api.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Add shared-contract and settings-API tests that prove:
- agent-chat provider settings can store no selection, a tracked selection, or an exact selection
- explicit effort override is optional and separate from model selection
- effort overrides are stored as non-empty strings, not a fixed enum
- settings patches can explicitly clear model selection and effort override through the `/api/settings` contract
- the HTTP settings boundary normalizes null/empty clear sentinels for agent-chat selection and effort before patching config
- legacy `defaultModel` values migrate into exact selections without coercion to `opus`

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/integration/server/settings-api.test.ts
```

Expected: FAIL because the shared selection schema, dynamic effort contract, and clear semantics do not exist yet.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/integration/server/settings-api.test.ts
```

Expected: FAIL with stale `defaultModel` and fixed-effort assumptions.

- [ ] **Step 3: Write the minimal implementation**

Implement:
- `shared/agent-chat-capabilities.ts` with normalized capability schemas/types and tracked/exact selection schemas/types
- `shared/settings.ts` storing `modelSelection` plus optional explicit `effort` override as a validated non-empty string
- `server/settings-router.ts` normalization for explicit null/empty clear sentinels on agent-chat provider patches
- migration from legacy `defaultModel` to exact selection without silent alias rewrite
- `/api/settings` patch acceptance for explicit null clears of the new fields

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/integration/server/settings-api.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/integration/server/settings-api.test.ts test/unit/server/config-store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/agent-chat-capabilities.ts shared/settings.ts server/settings-router.ts test/unit/shared/settings.test.ts test/integration/server/settings-api.test.ts test/unit/server/config-store.test.ts
git commit -m "feat: add dynamic agent chat selection contracts"
```

## Task 2: Build A Refreshable Claude Capability Registry And HTTP Contract

**Files:**
- Create: `server/agent-chat-capability-registry.ts`
- Create: `server/agent-chat-capabilities-router.ts`
- Modify: `server/index.ts`
- Modify: `server/sdk-bridge.ts`
- Modify: `shared/ws-protocol.ts`
- Create: `test/unit/server/agent-chat-capability-registry.test.ts`
- Create: `test/integration/server/agent-chat-capabilities-router.test.ts`
- Modify: `test/unit/server/sdk-bridge.test.ts`
- Modify: `test/unit/server/sdk-bridge-types.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Add server tests that prove:
- capability discovery normalizes full model info including effort/adaptive-thinking flags
- capability discovery creates a short-lived SDK query probe, closes it after `supportedModels()`, and reuses one in-flight probe for concurrent refreshes
- the registry caches successful results only for a bounded TTL and supports explicit refresh
- malformed or incomplete SDK payloads fail clearly
- the capability route returns a typed error payload on probe failure
- websocket flows no longer depend on `sdk.models`
- SDK transport/input schemas accept dynamic effort strings instead of a fixed enum

Run:

```bash
npm run test:vitest -- test/unit/server/agent-chat-capability-registry.test.ts test/integration/server/agent-chat-capabilities-router.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/ws-handler-sdk.test.ts
```

Expected: FAIL because the registry, route, websocket cleanup, and dynamic effort transport contract do not exist yet.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/agent-chat-capability-registry.test.ts test/integration/server/agent-chat-capabilities-router.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/ws-handler-sdk.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

Implement the server capability path:
- build the probe abstraction around a short-lived Claude SDK query created solely for capability discovery; share the same env sanitization, `pathToClaudeCodeExecutable`, and MCP wiring rules that `server/sdk-bridge.ts` uses, then call `supportedModels()` and immediately close the probe query
- coalesce concurrent refresh requests onto one in-flight probe and cache only successful normalized results; do not let a failed refresh poison the last known-good catalog
- normalize and validate the SDK capability payload against shared schemas
- expose GET and refresh semantics through the HTTP route
- remove session-scoped `sdk.models` broadcast behavior
- stop hardcoding current effort strings in `shared/ws-protocol.ts` and `server/sdk-bridge.ts`

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/server/agent-chat-capability-registry.test.ts test/integration/server/agent-chat-capabilities-router.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/ws-handler-sdk.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- test/unit/server/agent-chat-capability-registry.test.ts test/integration/server/agent-chat-capabilities-router.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/config-store.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/agent-chat-capability-registry.ts server/agent-chat-capabilities-router.ts server/index.ts server/sdk-bridge.ts shared/ws-protocol.ts test/unit/server/agent-chat-capability-registry.test.ts test/integration/server/agent-chat-capabilities-router.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/server/config-store.test.ts
git commit -m "feat: add refreshable claude capability registry"
```

## Task 3: Migrate Settings, Pane State, And Sync Payloads To Selection Strategies

**Files:**
- Modify: `server/config-store.ts`
- Modify: `src/store/settingsThunks.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/lib/agent-chat-types.ts`
- Modify: `src/lib/agent-chat-utils.ts`
- Modify: `src/lib/session-type-utils.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/paneTreeValidation.ts`
- Modify: `src/store/types.ts`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `test/unit/server/config-store.test.ts`
- Modify: `test/unit/client/store/persistedState.test.ts`
- Modify: `test/unit/client/store/panesPersistence.test.ts`
- Modify: `test/unit/client/store/settingsThunks.test.ts`
- Modify: `test/unit/client/lib/agent-chat-utils.test.ts`
- Modify: `test/unit/client/lib/session-type-utils.test.ts`
- Modify: `test/unit/client/lib/tab-registry-snapshot.test.ts`
- Modify: `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/components/TabsView.test.tsx`

- [ ] **Step 1: Identify or write the failing tests**

Extend tests so they prove:
- Freshclaude/Kilroy provider config expresses provider-default track `opus` with no baked-in effort override
- settings thunk normalization sends null sentinels for cleared selection and cleared effort override
- settings clears actually remove stored model selection and explicit effort override
- persisted legacy `defaultEffort` values migrate into explicit overrides because their provenance is unknowable
- persisted layout parsing and persistence migrate legacy `model`/`effort` pane fields into selection strategy plus optional explicit effort override
- pane-schema versioning changes are explicit and old localStorage payloads still load into the new shape
- pane creation, layout hydration, tab snapshot serialization, and TabsView rehydration preserve selection strategy
- no path injects `claude-opus-4-6` or a hardcoded effort into new agent-chat panes
- pane validation accepts any non-empty effort override string and rejects empty ones

Run:

```bash
npm run test:vitest -- test/unit/server/config-store.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/settingsThunks.test.ts test/unit/client/lib/agent-chat-utils.test.ts test/unit/client/lib/session-type-utils.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabsView.test.tsx
```

Expected: FAIL because provider config and pane payloads still assume raw model strings and fixed effort semantics.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/config-store.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/settingsThunks.test.ts test/unit/client/lib/agent-chat-utils.test.ts test/unit/client/lib/session-type-utils.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabsView.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

Implement the strategy cutover across:
- settings persistence and clear serialization
- migration that preserves any persisted legacy `defaultEffort` as an explicit override while removing provider-level hardcoded defaults for new panes
- persisted-layout schema/version bump plus legacy pane migration in localStorage
- provider metadata
- pane types and pane normalization
- persisted pane-tree validation
- tab snapshot serialization and rehydration

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/server/config-store.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/settingsThunks.test.ts test/unit/client/lib/agent-chat-utils.test.ts test/unit/client/lib/session-type-utils.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabsView.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/integration/server/settings-api.test.ts test/unit/server/config-store.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/settingsThunks.test.ts test/unit/client/lib/agent-chat-utils.test.ts test/unit/client/lib/session-type-utils.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabsView.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/config-store.ts src/store/settingsThunks.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/lib/agent-chat-types.ts src/lib/agent-chat-utils.ts src/lib/session-type-utils.ts src/lib/tab-registry-snapshot.ts src/store/paneTypes.ts src/store/panesSlice.ts src/store/paneTreeValidation.ts src/store/types.ts src/components/panes/PaneContainer.tsx src/components/TabsView.tsx test/unit/server/config-store.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/settingsThunks.test.ts test/unit/client/lib/agent-chat-utils.test.ts test/unit/client/lib/session-type-utils.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabsView.test.tsx
git commit -m "refactor: persist agent chat selections as strategies"
```

## Task 4: Add Client Capability State, Fetch Lifecycle, And Resolution Helpers

**Files:**
- Create: `src/lib/agent-chat-capabilities.ts`
- Modify: `src/lib/api.ts`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/store/agentChatThunks.ts`
- Modify: `src/lib/sdk-message-handler.ts`
- Modify: `test/unit/client/lib/agent-chat-capabilities.test.ts`
- Modify: `test/unit/client/agentChatSlice.test.ts`
- Modify: `test/unit/client/store/agentChatThunks.test.ts`
- Modify: `test/unit/client/sdk-message-handler.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Add client tests that prove:
- capabilities are stored per provider with `idle/loading/succeeded/failed` status
- provider-default resolves to tracked alias `opus`
- tracked aliases resolve without dated-ID remapping
- exact legacy selections become explicit unavailable state when absent from the live catalog
- effort options come only from the resolved capability
- the client never assumes a fixed set of effort strings
- `sdk.models` reducer handling is gone

Run:

```bash
npm run test:vitest -- test/unit/client/lib/agent-chat-capabilities.test.ts test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts
```

Expected: FAIL because the client still stores one flat `availableModels` array.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/agent-chat-capabilities.test.ts test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

Implement:
- typed capability fetch helpers
- provider-scoped capability state and retry behavior
- shared selection-resolution and effort-validation helpers
- removal of websocket `sdk.models`

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/agent-chat-capabilities.test.ts test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/agent-chat-capabilities.test.ts test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/agent-chat-capabilities.ts src/lib/api.ts src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/store/agentChatThunks.ts src/lib/sdk-message-handler.ts test/unit/client/lib/agent-chat-capabilities.test.ts test/unit/client/agentChatSlice.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
git commit -m "feat: add capability-driven agent chat client state"
```

## Task 5: Resolve Create-Time And Mid-Session Model Changes Correctly

**Files:**
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `server/ws-handler.ts`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`
- Modify: `test/e2e/pane-activity-indicator-flow.test.tsx`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`

- [ ] **Step 1: Identify or write the failing tests**

Add tests that prove:
- provider-default Freshclaude/Kilroy create sends `model: 'opus'`
- tracked aliases can create without a blocking capability fetch when no effort validation is needed
- explicit effort overrides wait for capability validation and are cleared when unsupported
- unavailable exact selections block create with a clear error
- mid-session model changes send resolved strings and clear invalid effort overrides from persisted defaults only when the pane still matches current provider defaults
- create-time and passive cleanup drop unsupported pane-local effort snapshots without rewriting provider defaults when the pane no longer matches current defaults
- create and set-model paths pass through non-enum effort strings when the live capability list allows them

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/unit/server/ws-handler-sdk.test.ts
```

Expected: FAIL because create/model-change flow still assumes raw pane `model` strings and hardcoded defaults.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/unit/server/ws-handler-sdk.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

Implement runtime resolution in `AgentChatView`:
- send provider-default/tracked aliases directly when safe
- fetch capabilities when required for effort validation or unavailable exact detection
- omit `effort` when no explicit override is active
- when invalid effort is cleared, compare the pane’s current selection/effort against current provider settings before deciding whether to persist a settings clear
- keep `sdk.create` and `sdk.set-model` payloads consistent with resolved strings

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/unit/server/ws-handler-sdk.test.ts
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/unit/server/ws-handler-sdk.test.ts test/unit/client/lib/agent-chat-capabilities.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-chat/AgentChatView.tsx server/ws-handler.ts test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/unit/server/ws-handler-sdk.test.ts test/unit/client/lib/agent-chat-capabilities.test.ts
git commit -m "feat: resolve freshclaude creates from tracked selections"
```

## Task 6: Rebuild The Settings UI Around Live Capabilities

**Files:**
- Modify: `src/components/agent-chat/AgentChatSettings.tsx`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/lib/agent-chat-capabilities.ts`
- Modify: `test/unit/client/components/agent-chat/AgentChatSettings.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx`
- Modify: `test/e2e/agent-chat-capability-settings-flow.test.tsx`

- [ ] **Step 1: Identify or write the failing tests**

Add UI tests that prove:
- the model control shows provider-default track plus live capability rows, and adds a synthetic saved-selection row only when the currently selected tracked model is missing from the latest catalog
- provider-default explains “track latest Opus”
- opening settings revalidates stale cached capabilities instead of treating them as session-lifetime truth
- a migrated unavailable exact model renders clearly and stays selected until the user changes it
- effort options come from `supportedEffortLevels`
- choosing a model without effort support hides/disables effort and clears any stale saved override
- loading and error states are explicit and accessible on desktop and mobile
- the rendered effort choices are whatever the capability payload says, not a locally defined canonical list

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatSettings.test.tsx test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx test/e2e/agent-chat-capability-settings-flow.test.tsx
```

Expected: FAIL because the UI still renders hardcoded dated models and static effort options.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatSettings.test.tsx test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx test/e2e/agent-chat-capability-settings-flow.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

Rebuild the settings UI so it renders:
- provider-default track row
- live capability rows
- synthetic saved-selection row when the selected tracked model is missing from the latest catalog
- unavailable exact row when needed
- effort UI only from the selected capability
- stale-cache refresh on settings open
- explicit retryable load/error states

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatSettings.test.tsx test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx test/e2e/agent-chat-capability-settings-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Refactor and verify**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatSettings.test.tsx test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx test/e2e/agent-chat-capability-settings-flow.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-chat/AgentChatSettings.tsx src/components/agent-chat/AgentChatView.tsx src/lib/agent-chat-capabilities.ts test/unit/client/components/agent-chat/AgentChatSettings.test.tsx test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx test/e2e/agent-chat-capability-settings-flow.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
git commit -m "feat: render freshclaude settings from live capabilities"
```

## Task 7: Browser Coverage, Docs, And Final Verification

**Files:**
- Modify: `test/e2e-browser/specs/agent-chat.spec.ts`
- Modify: `test/e2e-browser/specs/settings.spec.ts`
- Modify: `test/e2e-browser/specs/settings-persistence-split.spec.ts`
- Modify: `docs/index.html`
- Modify: any touched files if final cleanup is required

- [ ] **Step 1: Identify or write the failing browser tests**

Extend browser coverage to prove:
- a new Freshclaude pane defaults to provider-default latest-Opus tracking
- default create sends `model: 'opus'`
- switching to another tracked live model persists and survives reload
- switching a saved override back to provider-default clears persistence and survives reload
- a saved tracked selection that disappears from the latest catalog remains visible as a saved row instead of being silently rewritten
- a saved legacy exact model is surfaced clearly after reload instead of being silently migrated
- opening settings after the client-side capability cache goes stale refreshes and shows the latest catalog
- capability fetch failure shows a visible settings error and only blocks create when validation is actually required
- a capability payload with unfamiliar effort strings still renders and round-trips correctly

Run:

```bash
npm run test:e2e -- test/e2e-browser/specs/agent-chat.spec.ts test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/settings-persistence-split.spec.ts
```

Expected: FAIL because browser fixtures still assume hardcoded model tables, raw `defaultModel`, or fixed effort strings. `npm run test:e2e` is the correct Playwright runner for `test/e2e-browser/specs/*` in this repo.

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:e2e -- test/e2e-browser/specs/agent-chat.spec.ts test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/settings-persistence-split.spec.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the minimal implementation**

Finish the cutover:
- update browser fixtures/mocks to use the capability HTTP route
- update `docs/index.html` if the mock includes Freshclaude settings

- [ ] **Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:e2e -- test/e2e-browser/specs/agent-chat.spec.ts test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/settings-persistence-split.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Run the full required verification**

Run:

```bash
FRESHELL_TEST_SUMMARY="freshclaude capability tracks targeted" npm run test:vitest -- test/unit/shared/settings.test.ts test/integration/server/settings-api.test.ts test/unit/server/agent-chat-capability-registry.test.ts test/integration/server/agent-chat-capabilities-router.test.ts test/unit/server/config-store.test.ts test/unit/server/sdk-bridge.test.ts test/unit/server/sdk-bridge-types.test.ts test/unit/server/ws-handler-sdk.test.ts test/unit/client/lib/agent-chat-capabilities.test.ts test/unit/client/lib/agent-chat-utils.test.ts test/unit/client/lib/session-type-utils.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/unit/client/agentChatSlice.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/agentChatThunks.test.ts test/unit/client/store/settingsThunks.test.ts test/unit/client/sdk-message-handler.test.ts test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/components/agent-chat/AgentChatSettings.test.tsx test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/agent-chat-capability-settings-flow.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx
npm run typecheck
npm run lint
npm run test:e2e -- test/e2e-browser/specs/agent-chat.spec.ts test/e2e-browser/specs/settings.spec.ts test/e2e-browser/specs/settings-persistence-split.spec.ts
FRESHELL_TEST_SUMMARY="freshclaude capability tracks full suite" npm test
```

Expected: all PASS.

- [ ] **Step 6: Final refactor pass**

Remove dead code:
- stale hardcoded model and effort arrays
- websocket `sdk.models` types, mocks, and reducers
- comments that still describe omission-based or dated-ID defaults
- any remaining fixed effort unions or validators

Re-run the smallest relevant checks if cleanup changes behavior.

- [ ] **Step 7: Commit**

```bash
git status --short
# Review the touched list, then stage explicit paths rather than using git add -A.
# At minimum this task should stage the updated browser specs, docs/index.html if touched,
# and any final cleanup edits from previously-touched Freshclaude capability files.
git commit -m "chore: finalize capability-driven freshclaude model controls"
```

## Notes For Execution

- Use only the implementation worktree: `/home/user/code/freshell/.worktrees/trycycle-freshclaude-capabilities`.
- Keep commits small and aligned with the tasks above.
- Do not reintroduce stale dated model tables, fixed effort option tables, or “closest model” migration heuristics.
- Do not hardcode a provider-default effort override; explicit effort should remain opt-in and capability-validated.
- Do not invent a second hardcoded alias allowlist. Aside from the deliberate provider-default `opus` contract, tracked model IDs must flow from the runtime capability catalog as opaque strings.
- Do not silently drop or rewrite a tracked selection that is absent from the current catalog; represent it as a saved selection row and keep treating it as an opaque tracked ID unless validation specifically requires a live capability.
- Do not hardcode the current effort level names into shared schemas, pane validators, or TypeScript unions; future upstream effort strings must round-trip without another Freshell code change.
- Keep capability fetches refreshable and retryable; a server restart must not be the only way to see new capability metadata.
- When invalid effort cleanup runs, rewrite provider defaults only if the pane still matches the current provider settings; stale pane-local snapshots should be sanitized locally without clobbering global defaults.
- Do not block provider-default or tracked-alias creates unless Freshell genuinely lacks the information required to validate an explicit override.
