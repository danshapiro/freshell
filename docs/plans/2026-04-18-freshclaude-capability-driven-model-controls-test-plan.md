# Freshclaude Capability-Driven Model Controls Test Plan

Reconciliation result: the approved testing strategy still holds. The implementation plan and current worktree do not add paid services, external infrastructure, or a larger user-facing surface than the user already approved. The main adjustment is prioritization, not scope: the capability registry, HTTP route, client capability state, persistence migration path, and browser/jsdom harnesses already exist here, so the highest-value red checks are now the unresolved effort-provenance cleanup cases and the contract that tracked saved selections remain visible instead of being silently healed.

## Source-of-Truth Legend

- `SoT1`: the user request and approved trycycle strategy in the transcript. Freshclaude must stop hardcoding stale model and thinking options, pick up newer Anthropic improvements automatically, and avoid silent fallback or silent migration behavior.
- `SoT2`: the implementation plan at `docs/plans/2026-04-18-freshclaude-capability-driven-model-controls.md`, especially `User-Visible Behavior`, `Contracts And Invariants`, and Task 5/6. This is the authoritative contract for provider-default `opus`, tracked vs exact selections, dynamic effort strings, stale-capability refresh, saved-selection rows, unavailable exact rows, and provenance-sensitive effort cleanup.
- `SoT3`: the concrete shared and server contracts already present in this worktree: `shared/agent-chat-capabilities.ts`, `shared/settings.ts`, `shared/ws-protocol.ts`, `server/agent-chat-capability-registry.ts`, `server/agent-chat-capabilities-router.ts`, `server/settings-router.ts`, `server/config-store.ts`, and `server/ws-handler.ts`.
- `SoT4`: the current user-facing entry points and persistence surfaces already wired in this worktree: `src/components/agent-chat/AgentChatView.tsx`, `src/components/agent-chat/AgentChatSettings.tsx`, `src/components/panes/PaneContainer.tsx`, `src/components/TabsView.tsx`, `src/store/persistMiddleware.ts`, `src/store/persistedState.ts`, `src/lib/tab-registry-snapshot.ts`, `/api/settings`, `/api/agent-chat/capabilities/:provider`, and the pane picker flow used in Playwright.
- `SoT5`: the installed Claude SDK `supportedModels()` shape described in the approved strategy. This is a differential reference for a conditional non-CI contract probe only, not the primary acceptance gate.

## Harness Requirements

No new harnesses need to be built. The existing harnesses already cover the required proof surfaces:

1. **Direct API harness**
   What it does: exercises the real Express routers, shared schemas, config-store persistence, registry normalization, and websocket input validation.
   Exposes: `supertest`, isolated temp config directories, and real schema parsing.
   Estimated complexity: none beyond extending existing tests.
   Tests depending on it: 9, 10, 11.

2. **Programmatic state and jsdom interaction harness**
   What it does: mounts `AgentChatView`, `AgentChatSettings`, `PaneContainer`, and `TabsView` against the real Redux store so tests can inspect pane state, persisted settings intent, and sent websocket payloads without mocking the whole app.
   Exposes: `window.__FRESHELL_TEST_HARNESS__` in browser tests, store dispatch/state inspection in jsdom, mocked `ws.send`, and mocked API routes.
   Estimated complexity: none beyond extending existing tests.
   Tests depending on it: 2, 3, 12, 13, 14, 16.

3. **Browser interaction and artifact harness**
   What it does: runs the real UI through Playwright with route interception, sent-websocket capture, on-disk `config.json` inspection via `TestServerInfo.homeDir`, and screenshot assertions.
   Exposes: pane-picker interactions, reload and multi-page flows, sent `sdk.create` payload capture, capability-route interception, and screenshot comparison.
   Estimated complexity: none beyond extending existing tests.
   Tests depending on it: 1, 4, 5, 6, 7, 8, 15.

## Test Plan

1. **Name:** Unsupported provider-default effort is cleared from persisted Freshclaude settings after create-time validation
   **Type:** scenario
   **Disposition:** extend `test/e2e-browser/specs/settings-persistence-split.spec.ts`
   **Harness:** browser interaction + programmatic state + output capture
   **Preconditions:** Seed server settings with `agentChat.providers.freshclaude.effort = 'turbo'` and no `modelSelection`. Intercept `GET /api/agent-chat/capabilities/freshclaude` so provider-default `opus` no longer supports effort. Enable Freshclaude in the pane picker.
   **Actions:** Create a Freshclaude pane from the picker, allow the automatic `sdk.create`, inspect the sent websocket payload, inspect resolved settings and on-disk `config.json`, reload, and create a second Freshclaude pane.
   **Expected outcome:** The first create sends `model: 'opus'` and omits `effort`. The stale saved effort is cleared from resolved settings and from `config.json`, and the reloaded second pane also creates with `model: 'opus'` and no `effort`. Freshell does not silently substitute a different model or keep replaying the invalid effort on later panes. Sources: `SoT1`, `SoT2`, `SoT3`, `SoT4`.
   **Interactions:** pane picker, directory confirmation, capability GET, settings persistence, config-store write path, websocket `sdk.create`.

2. **Name:** Create-time cleanup drops an unsupported pane-local effort snapshot without rewriting provider defaults
   **Type:** regression
   **Disposition:** extend `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`
   **Harness:** programmatic state + jsdom interaction
   **Preconditions:** Seed provider settings with a still-valid saved default effort for Freshclaude. Render a creating agent-chat pane whose restored `modelSelection` and `effort` no longer match current provider defaults and whose selected model no longer supports effort.
   **Actions:** Mount `AgentChatView`, let the create path resolve and send `sdk.create`, then inspect pane state and saved-settings dispatches.
   **Expected outcome:** Pane state is sanitized so the outgoing `sdk.create` omits `effort`, but no `saveServerSettingsPatch` is dispatched to clear the provider default because the stale effort belonged only to the restored pane snapshot. Sources: `SoT2`, `SoT3`, `SoT4`.
   **Interactions:** create-time capability validation, pane-state mutation, settings save thunk, websocket `sdk.create`.

3. **Name:** Passive cleanup of a restored pane snapshot clears only pane state when provider defaults still remain valid
   **Type:** regression
   **Disposition:** extend `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`
   **Harness:** programmatic state + jsdom interaction
   **Preconditions:** Seed provider settings with a valid saved effort override for the current provider defaults. Render a running or restored agent-chat pane whose local snapshot carries an unsupported effort for a different selected model.
   **Actions:** Mount `AgentChatView` so the passive cleanup effect runs after capability resolution, then inspect pane state and saved-settings dispatches.
   **Expected outcome:** The pane-local `effort` is cleared from pane state, but provider settings remain untouched and no persisted-clear request is sent. This proves Freshell distinguishes pane-local cleanup from global-default cleanup. Sources: `SoT2`, `SoT3`, `SoT4`.
   **Interactions:** passive cleanup effect, capability resolution, pane merge/update flow, settings thunk.

4. **Name:** A saved tracked model that drops out of the catalog stays visible as a synthetic saved-selection row and still launches as that tracked id
   **Type:** scenario
   **Disposition:** extend `test/e2e-browser/specs/settings-persistence-split.spec.ts`
   **Harness:** browser interaction + programmatic state + output capture
   **Preconditions:** Persist `agentChat.providers.freshclaude.modelSelection = { kind: 'tracked', modelId: 'haiku' }`. Intercept capabilities so the live catalog excludes `haiku` and contains only other live rows. Enable Freshclaude.
   **Actions:** Reload, create a Freshclaude pane, open settings, inspect the selected model row, and inspect the sent `sdk.create` payload.
   **Expected outcome:** Settings show `haiku (Saved selection)` with the explanatory saved-selection message. Freshell does not rewrite the saved tracked selection to provider-default or the nearest live row, and `sdk.create` still uses `model: 'haiku'` when no extra validation is required. Sources: `SoT1`, `SoT2`, `SoT3`, `SoT4`.
   **Interactions:** settings rendering, pane creation, capability GET, websocket `sdk.create`, persisted provider settings.

5. **Name:** Provider-default tracking and tracked live-model overrides persist across reload, and switching back to provider-default clears the override
   **Type:** scenario
   **Disposition:** existing `test/e2e-browser/specs/settings-persistence-split.spec.ts`
   **Harness:** browser interaction + programmatic state + output capture
   **Preconditions:** Intercept capabilities with provider-default `opus` and at least one tracked live option such as `opus[1m]`. Enable Freshclaude.
   **Actions:** Create a Freshclaude pane, switch the model from provider-default to a tracked live option, reload, create a new pane, then switch back to `Provider default (track latest Opus)`, reload again, and create another pane.
   **Expected outcome:** The tracked selection persists across reload and the corresponding `sdk.create` uses the tracked model id. Switching back to provider-default removes the saved override and future creates send `model: 'opus'` with no persisted tracked selection left behind. Sources: `SoT1`, `SoT2`, `SoT4`.
   **Interactions:** model select, settings persistence, reload/rehydration, pane creation, websocket `sdk.create`.

6. **Name:** A migrated legacy exact model stays visible, blocks create, and never silently migrates to a live alias
   **Type:** scenario
   **Disposition:** existing `test/e2e-browser/specs/settings-persistence-split.spec.ts` plus existing `test/e2e/agent-chat-capability-settings-flow.test.tsx`
   **Harness:** browser interaction + programmatic state + output capture
   **Preconditions:** Persist `modelSelection = { kind: 'exact', modelId: 'claude-opus-4-6' }`. Intercept capabilities so that exact id is absent from the live catalog.
   **Actions:** Reload, create a Freshclaude pane, inspect the visible failure state, open settings, inspect the selected option, then switch to provider-default and retry.
   **Expected outcome:** Freshell surfaces the unavailable exact row and explanatory message, blocks create while the unavailable exact model remains selected, sends no `sdk.create`, and only proceeds after the user explicitly chooses a launchable selection. Sources: `SoT1`, `SoT2`, `SoT3`, `SoT4`.
   **Interactions:** create-time validation, settings UI, unavailable exact row rendering, retry flow, websocket `sdk.create`.

7. **Name:** Opening settings refreshes stale capability cache and updates visible live options instead of trusting a session-lifetime snapshot
   **Type:** scenario
   **Disposition:** extend `test/e2e-browser/specs/agent-chat.spec.ts` and keep `test/e2e/agent-chat-capability-settings-flow.test.tsx`
   **Harness:** browser interaction + output capture
   **Preconditions:** Seed stale cached capabilities in client state or via fixture, then intercept the next `GET /api/agent-chat/capabilities/freshclaude` with a newer catalog that changes model rows and effort levels.
   **Actions:** Open Freshclaude settings and wait for the refresh to complete, then inspect the visible model list, effort list, and screenshot artifact.
   **Expected outcome:** Freshell revalidates stale capabilities when settings open, updates the visible model and effort options from the new catalog, and the settings surface screenshot reflects provider-default plus current live rows only. Sources: `SoT1`, `SoT2`, `SoT3`, `SoT4`.
   **Interactions:** settings button, stale-capability freshness check, capability GET, screenshot baseline, settings model/effort rendering.

8. **Name:** Capability fetch failures show an explicit retryable settings error, allow safe tracked creates, and block validation-dependent creates until retry succeeds
   **Type:** scenario
   **Disposition:** existing `test/e2e-browser/specs/settings.spec.ts` plus existing `test/e2e/agent-chat-capability-settings-flow.test.tsx`
   **Harness:** browser interaction + programmatic state + output capture
   **Preconditions:** Intercept initial capability fetch to fail with a typed error, and intercept refresh to succeed. Prepare one pane that can launch safely with a tracked model id and another that requires capability validation because it has an explicit effort or exact selection.
   **Actions:** Open settings, inspect the alert and retry button, create the safe tracked pane, create the validation-dependent pane, retry the capability load, and retry the blocked create.
   **Expected outcome:** The settings surface shows an explicit retryable error. Safe tracked creates continue to send the tracked `model` without waiting for live validation. Validation-dependent creates are blocked until a successful refresh provides the required capability data, after which retry succeeds with the validated payload. Sources: `SoT1`, `SoT2`, `SoT3`, `SoT4`.
   **Interactions:** capability GET/refresh, error alert, retry button, create retry button, websocket `sdk.create`, capability-validation gate.

9. **Name:** Shared settings and settings API round-trip tracked and exact selections, dynamic effort strings, clear sentinels, and legacy migration without coercion
   **Type:** integration
   **Disposition:** existing `test/unit/shared/settings.test.ts` plus existing `test/integration/server/settings-api.test.ts`
   **Harness:** direct API harness
   **Preconditions:** Real settings schema, settings router, and temp config-store directory.
   **Actions:** Parse or patch representative tracked selections, exact selections, unfamiliar effort strings, `null` and empty-string clears, and legacy `defaultModel/defaultEffort` inputs.
   **Expected outcome:** The shared schema accepts tracked and exact selections and non-empty dynamic effort strings, the API accepts explicit clears, clears stored selection and effort when requested, and migrates legacy `defaultModel/defaultEffort` into `exact` plus explicit `effort` without rewriting to `opus`. Sources: `SoT1`, `SoT2`, `SoT3`.
   **Interactions:** shared Zod schemas, settings router normalization, config-store merge path, `/api/settings`.

10. **Name:** Capability registry and capability router normalize runtime payloads, coalesce refreshes, honor TTL, and keep the last good catalog after failure
    **Type:** integration
    **Disposition:** existing `test/unit/server/agent-chat-capability-registry.test.ts` plus existing `test/integration/server/agent-chat-capabilities-router.test.ts`
    **Harness:** direct API harness
    **Preconditions:** Mocked SDK query factory and the real registry/router code.
    **Actions:** Feed the registry mixed runtime payload shapes, concurrent refresh calls, stale-cache lookups, malformed payloads, timeout cases, and router GET/refresh requests.
    **Expected outcome:** Runtime capability payloads normalize into the shared contract, one in-flight probe services concurrent refreshes, cached successes are reused within TTL, failed refreshes do not poison the last good catalog, malformed payloads yield typed errors, and the router returns typed success or failure payloads on the documented endpoints. Sources: `SoT2`, `SoT3`, `SoT5`.
    **Interactions:** SDK probe query lifecycle, shared capability schema, registry cache, Express router, HTTP status mapping.

11. **Name:** WebSocket and SDK bridge accept unfamiliar effort strings, stop broadcasting `sdk.models`, and avoid session-init capability discovery
    **Type:** integration
    **Disposition:** existing `test/unit/server/sdk-bridge.test.ts`, existing `test/unit/server/sdk-bridge-types.test.ts`, and existing `test/unit/server/ws-handler-sdk.test.ts`
    **Harness:** direct API harness
    **Preconditions:** Real websocket schema parsing and mocked SDK bridge/session plumbing.
    **Actions:** Validate `sdk.create` with a non-enum effort string, route `sdk.create` and `sdk.set-model` through the websocket handler, and replay session-init flows.
    **Expected outcome:** `sdk.create` accepts any non-empty effort string at the transport boundary, the handler forwards unfamiliar strings unchanged to the SDK bridge, `sdk.set-model` passes tracked ids through unchanged, and no code path emits `sdk.models` or calls `supportedModels()` during session init. Sources: `SoT1`, `SoT2`, `SoT3`.
    **Interactions:** shared websocket schema, ws-handler ownership checks, sdk-bridge create/set-model, session-init replay.

12. **Name:** Persisted layouts, pane payloads, and tab snapshots migrate legacy `model` and `effort` fields into selection strategies without losing reload or sync behavior
    **Type:** integration
    **Disposition:** extend `test/unit/client/store/persistedState.test.ts`, `test/unit/client/store/panesPersistence.test.ts`, `test/unit/client/lib/tab-registry-snapshot.test.ts`, `test/unit/client/components/TabsView.test.tsx`, and `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
    **Harness:** programmatic state + jsdom interaction
    **Preconditions:** Seed legacy persisted pane payloads and tab snapshots that still contain raw `model` and `effort` fields, plus current provider settings for new pane creation.
    **Actions:** Load persisted panes, rehydrate tabs from snapshots, create a new Freshclaude pane from the pane container, and inspect normalized pane content after migration.
    **Expected outcome:** Legacy `model` fields become exact selections, legacy non-empty `effort` strings survive as explicit overrides, current new-pane creation uses provider-default or saved strategy fields instead of stale dated ids, and reload or cross-device sync continues to hydrate the new strategy shape. Sources: `SoT2`, `SoT3`, `SoT4`.
    **Interactions:** persisted layout parser, pane-tree validation, tab-registry snapshot serialization, TabsView rehydration, PaneContainer defaults.

13. **Name:** The settings surface renders only provider-default, live capability rows, saved tracked rows, unavailable exact rows, and capability-derived effort controls on desktop and mobile
    **Type:** scenario
    **Disposition:** existing `test/unit/client/components/agent-chat/AgentChatSettings.test.tsx`, existing `test/unit/client/components/agent-chat/AgentChatSettings.mobile.test.tsx`, and existing `test/e2e/agent-chat-capability-settings-flow.test.tsx`
    **Harness:** programmatic state + jsdom interaction + output capture
    **Preconditions:** Capability states covering success, stale cache, failure, saved tracked selection missing from catalog, and unavailable exact selection.
    **Actions:** Render the settings popover on desktop and mobile, open it, switch models between effort-supporting and non-effort-supporting capabilities, and trigger capability retry.
    **Expected outcome:** The surface shows provider-default plus live rows only, adds a synthetic saved tracked row only when needed, adds an unavailable exact row only when needed, derives effort options exclusively from `supportedEffortLevels`, hides or replaces effort UI when the selected model has no effort support, and exposes accessible loading/error states and retry controls on both layouts. Sources: `SoT1`, `SoT2`, `SoT4`.
    **Interactions:** AgentChatSettings rendering, AgentChatView on-open refresh, capability retry, responsive/mobile dialog layout.

14. **Name:** Freshclaude runtime metadata and activity indicators remain correct while provider-default creates and tracked mid-session model changes occur
    **Type:** regression
    **Disposition:** existing `test/e2e/pane-header-runtime-meta-flow.test.tsx` and existing `test/e2e/pane-activity-indicator-flow.test.tsx`
    **Harness:** programmatic state + jsdom interaction
    **Preconditions:** Seed runtime metadata, capability catalogs, and active Freshclaude panes with visible header and activity indicators.
    **Actions:** Let a provider-default Freshclaude pane create, then change the model mid-session to another tracked live model and inspect header/runtime metadata and tab activity styling.
    **Expected outcome:** Provider-default create still launches with `model: 'opus'`, tracked mid-session changes send `sdk.set-model` with the tracked id, and header/runtime metadata plus activity indicator styling stay correct while settings persistence updates only the intended provider defaults. Sources: `SoT2`, `SoT3`, `SoT4`.
    **Interactions:** AgentChatView, pane header/runtime metadata selectors, tab activity rendering, websocket `sdk.create`, websocket `sdk.set-model`.

15. **Name:** The Playwright settings surface snapshot stays stable while showing capability-driven Freshclaude controls
    **Type:** regression
    **Disposition:** existing `test/e2e-browser/specs/agent-chat.spec.ts`
    **Harness:** browser interaction + screenshot comparison
    **Preconditions:** Intercept a representative capability catalog for Freshclaude and enable the provider in the picker.
    **Actions:** Create a Freshclaude pane, open settings, and capture the existing screenshot baseline.
    **Expected outcome:** The screenshot still shows the capability-driven surface with provider-default, live model rows, and dynamic effort rows, catching accidental UI regressions while the behavior-focused assertions cover the semantics. Sources: `SoT1`, `SoT2`, `SoT4`.
    **Interactions:** pane picker, settings popover, screenshot baseline tooling.

16. **Name:** A conditional live SDK probe still fits Freshell’s normalization and validation contract
    **Type:** differential
    **Disposition:** new non-CI probe adjacent to `test/unit/server/agent-chat-capability-registry.test.ts`
    **Harness:** reference comparison harness
    **Preconditions:** The installed Claude SDK is available in the test environment and the probe is marked opt-in so it does not block normal CI.
    **Actions:** Invoke a short-lived live `supportedModels()` probe, pass the raw payload through the same normalization path the registry uses, and compare the result against Freshell’s shared capability schema and the helper assumptions used by the settings surface.
    **Expected outcome:** The current live SDK payload still parses into Freshell’s capability contract without needing a new hardcoded model or effort table. If it does not, the differential probe fails with the raw payload shape preserved for diagnosis. Sources: `SoT1`, `SoT2`, `SoT3`, `SoT5`.
    **Interactions:** live SDK query, capability normalization, shared schema parsing, optional diagnostics.

17. **Name:** Large capability catalogs remain buildable without catastrophic option-building regressions
    **Type:** invariant
    **Disposition:** existing `test/unit/client/lib/agent-chat-capabilities.test.ts`
    **Harness:** unit harness
    **Preconditions:** A synthetic capability catalog large enough to represent worst-case upstream growth.
    **Actions:** Build settings model options from the large catalog and measure the elapsed time with a generous threshold.
    **Expected outcome:** Option building stays comfortably under the loose threshold, so any failure indicates a severe regression rather than normal test variance. Sources: `SoT1`, `SoT2`, `SoT4`.
    **Interactions:** client capability helper logic, option-building path used by the settings surface.

## Coverage Summary

Covered action space:

- Opening Freshclaude settings from the pane header.
- Triggering stale-capability refresh on settings open.
- Clicking `Retry model load` after capability fetch failure.
- Selecting provider-default, tracked live, saved tracked, and unavailable exact model rows.
- Selecting and clearing effort overrides, including unfamiliar dynamic strings.
- Creating a Freshclaude pane from the pane picker and confirming the starting directory.
- Retrying a failed Freshclaude create after changing settings.
- Reloading the app and rehydrating persisted settings, pane payloads, and tab snapshots.
- Persisting and clearing `agentChat.providers.<provider>.modelSelection` and `effort` through `/api/settings`.
- Fetching and refreshing `/api/agent-chat/capabilities/:provider`.
- Sending `sdk.create` and `sdk.set-model` with resolved tracked or provider-default model ids.
- Preserving header metadata and activity indicators while the model-selection contract changes underneath.

Explicitly excluded per the approved strategy:

- No paid or external Anthropic API calls in the primary acceptance suite. Risk: upstream capability metadata could change in a way only the optional differential probe sees.
- No manual QA or human screenshot review. Risk: if a visual regression slips past the existing Playwright screenshot and DOM assertions, it will be caught later rather than by subjective inspection here.
- No broad agent-chat coverage unrelated to this feature, such as session-lost recovery, split-pane choreography, or resume-history hydration outside the touched settings and create/model-change paths. Risk: an unrelated agent-chat regression would be caught by adjacent suites, not by this feature plan’s primary gates.
