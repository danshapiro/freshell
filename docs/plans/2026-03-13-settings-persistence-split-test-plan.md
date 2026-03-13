# Settings Persistence Split Test Plan

Reconciliation result: the approved medium-fidelity strategy still matches the implementation plan. The plan does not introduce paid services, external infrastructure, or a larger interaction surface than the agreed browser/server split, but it does make two seams explicit that the strategy only implied: browser-preferences cross-tab sync and server-only fixture/builders for bootstrap and websocket payloads. Both reuse existing Freshell harnesses and stay inside the approved cost envelope, so no new user approval is required.

## Source-of-Truth Legend

- `ST1`: the approved user direction in the trycycle transcript. This is the authoritative split between browser-local and server-backed settings, including the explicit exception that `sidebar.excludeFirstChatSubstrings` and `sidebar.excludeFirstChatMustStart` stay shared while short-term sidebar/debug filters do not.
- `ST2`: the implementation plan in `docs/plans/2026-03-13-settings-persistence-split.md`, especially `Architecture`, `Strategy Gate`, `Key Design Decisions`, and `Persistence Classification`. This is the authoritative contract for `ServerSettings`, `LocalSettings`, `ResolvedSettings`, `legacyLocalSettingsSeed`, the `browser-preferences` blob, and the `sidebar.sortMode = 'activity'` default.
- `ST3`: existing protocol and endpoint contracts that must remain true after the refactor: `server/settings-router.ts`, `server/config-store.ts`, `shared/read-models.ts`, `shared/ws-protocol.ts`, `server/perf-router.ts`, and `server/network-router.ts`.
- `ST4`: existing user-facing flows that the refactor must preserve while changing persistence boundaries: `src/App.tsx`, `src/components/SettingsView.tsx`, `src/components/TerminalView.tsx`, `src/components/agent-chat/ToolStrip.tsx`, `src/components/TabsView.tsx`, `src/components/panes/PaneContainer.tsx`, `src/components/agent-chat/AgentChatView.tsx`, and the current regression tests around bootstrap, terminal fonts, sidebar behavior, and OSC52 prompts.
- `ST5`: the current mixed-settings implementation, used only as a characterization source for upgrade inputs and pre-upgrade visible values. It is not an oracle for the new persistence semantics.

## Harness Requirements

1. **Browser preferences observation helper**
   What it does: centralizes test setup and inspection for the versioned browser-preferences blob, legacy local keys, storage events, `BroadcastChannel`, and `pagehide` flushes so scenario and integration tests can assert the user-visible local contract without duplicating storage plumbing.
   Exposes: helpers to seed/read the raw browser-preferences blob, seed legacy keys (`freshell.terminal.fontFamily.v1`, `freshell:toolStripExpanded`), dispatch storage or broadcast sync events, and force debounce/pagehide flushes.
   Estimated complexity: low to medium.
   Tests depending on it: 1, 2, 3, 4, 6, 11, 12, 13, 15, 17, 18.

2. **Server-only payload/fixture builders**
   What it does: provides one test-side source of truth for `ServerSettings`, optional `legacyLocalSettingsSeed`, bootstrap payloads, and `settings.updated` messages so tests stop fabricating mixed payloads after the split.
   Exposes: builders for `ServerSettings`, `LocalSettingsPatch`, bootstrap payloads, and websocket `settings.updated` messages.
   Estimated complexity: low.
   Tests depending on it: 1, 5, 6, 7, 8, 9, 10, 12, 14, 15, 16, 18.

3. **Frozen legacy upgrade fixture**
   What it does: captures one representative pre-split mixed `config.json` plus legacy browser keys and the corresponding visible settings values from the current implementation, so upgrade continuity can be checked mechanically after the refactor without running two apps in CI.
   Exposes: a legacy mixed config fixture, legacy local-key fixture, and expected first-boot resolved settings for the upgrading browser.
   Estimated complexity: low once captured.
   Tests depending on it: 8, 15, 17.

No new Playwright browser harness is required. The existing `test/e2e-browser/helpers/fixtures.ts`, `TestServerInfo.homeDir`, and `window.__FRESHELL_TEST_HARNESS__` already expose the state and on-disk artifacts needed for the browser-level proofs.

## Test Plan

1. **Name:** Browser-local settings stay in one browser while shared settings replicate across surfaces
   **Type:** scenario
   **Harness:** interaction + programmatic state + output capture (`Playwright` two-context test, `window.__FRESHELL_TEST_HARNESS__`, on-disk `config.json` inspection through `TestServerInfo.homeDir`)
   **Preconditions:** Start an isolated server with no browser-preferences blob. Open browser contexts `A` and `B` against the same server. Seed at least one sidebar-visible session so sidebar filter changes are observable.
   **Actions:** In `A`, change representative browser-local settings from the approved split, such as `sidebar.sortMode` and `sidebar.showSubagents`, through the Settings UI. Reload `A`. Inspect `A`’s resolved settings and browser-preferences blob. Without changing any local settings in `B`, inspect `B`’s resolved settings. Then change a server-backed setting that the user explicitly kept shared, such as `sidebar.excludeFirstChatMustStart`, through the shared save path, and reload or wait for broadcast in `B`.
   **Expected outcome:** `A` retains its local-only changes after reload in both resolved state and the browser-preferences blob. `B` does not inherit `A`’s local-only changes and stays on its own defaults until `B` changes them locally. The shared setting converges across both browsers, and the server `config.json` contains the shared field but not `A`’s live local-only values. Sources: `ST1`, `ST2`, `ST3`, `ST4`.
   **Interactions:** SettingsView, settings slice composition, browser-preferences persistence, `/api/settings`, websocket `settings.updated`, config store.

2. **Name:** Sidebar geometry and mobile auto-collapse remain browser-local
   **Type:** scenario
   **Harness:** interaction + programmatic state + output capture (`RTL` App scenario with mocked API calls and local storage inspection)
   **Preconditions:** Render `App` with settings loaded, desktop viewport first, then a mobile viewport path available. Start with default sidebar width and `collapsed = false`.
   **Actions:** Resize the sidebar on desktop, toggle collapse, reload, then switch to the mobile path that auto-collapses the sidebar and return to terminal view. Capture outbound settings requests during the whole flow and inspect the browser-preferences blob plus the resolved settings after each transition.
   **Expected outcome:** Width and collapsed state persist locally across reloads and mobile transitions. No code path sends the full `sidebar` object to `/api/settings`, so the old `ignoreCodexSubagents`-driven 400 failure path disappears. The server config remains unchanged for width and collapsed state. Sources: `ST1`, `ST2`, `ST4`.
   **Interactions:** App sidebar handlers, mobile layout logic, browser-preferences persistence, API transport.

3. **Name:** Tool strip expansion and closed-tab range survive reload and same-profile tab sync
   **Type:** scenario
   **Harness:** interaction + programmatic state + output capture (`Playwright` same-profile pages or `RTL` dual-store browser-sync scenario with raw blob inspection)
   **Preconditions:** Use one browser profile with two same-origin pages or stores, tool output available for `ToolStrip`, and tab history available for `TabsView`.
   **Actions:** In page `A`, expand the ToolStrip and change the closed-tab range from `30` to `90` or `365` days. Reload `A`. Open page `B` in the same browser profile and let storage/BroadcastChannel delivery occur. Inspect the raw browser-preferences blob and the `tabRegistry.searchRangeDays` state in both pages.
   **Expected outcome:** ToolStrip expansion and `searchRangeDays` persist in the versioned browser-preferences blob, survive reload in `A`, and converge in `B` through same-profile browser sync. No `/api/settings` call or server config write occurs for either value. Sources: `ST2`, `ST4`.
   **Interactions:** ToolStrip, TabsView, tabRegistry slice, browser-preferences middleware, cross-tab sync, browser storage APIs.

4. **Name:** OSC52 prompt choice persists locally and governs later clipboard events
   **Type:** scenario
   **Harness:** interaction + programmatic state + output capture (`TerminalView` scenario harness with mocked clipboard and API)
   **Preconditions:** Start a terminal pane with `osc52Clipboard = 'ask'`, an empty browser-preferences settings payload, and clipboard mocking enabled.
   **Actions:** Deliver an OSC52 clipboard event, choose `Always` or `Never` in the prompt, inspect resolved settings and the browser-preferences blob, then deliver a second OSC52 event and reload the pane.
   **Expected outcome:** The chosen policy is stored only in local settings and the browser-preferences blob. Subsequent OSC52 events honor the stored policy without server involvement. No `/api/settings` write occurs for OSC52 policy, and server-backed settings remain unchanged. Sources: `ST1`, `ST2`, `ST4`.
   **Interactions:** TerminalView OSC52 flow, clipboard helper, browser-preferences persistence, terminal prompt lifecycle.

5. **Name:** Agent-chat and pane-picker defaults stay shared across future panes
   **Type:** scenario
   **Harness:** interaction + programmatic state + output capture (`RTL` component scenario spanning `PaneContainer` and `AgentChatView` with mocked server saves)
   **Preconditions:** Start with server-backed settings that include `agentChat.defaultPlugins` and coding-CLI provider settings. No browser-local settings should be needed for this scenario.
   **Actions:** Create an agent-chat pane from the pane picker, choose a provider starting directory, change the agent-chat model, permission mode, and effort defaults, dismiss the initial setup panel, then create a second agent-chat pane or open the same server from another browser surface.
   **Expected outcome:** The provider `cwd`, agent-chat defaults, and `initialSetupDone` persist through the server-backed save path. New panes inherit `agentChat.defaultPlugins` and the updated provider defaults from resolved settings. Future panes and other browser surfaces skip the first-run setup panel once `initialSetupDone` is saved. Sources: `ST1`, `ST2`, `ST4`.
   **Interactions:** PaneContainer, DirectoryPicker, AgentChatView, shared settings save thunk or API path, resolved settings read model.

6. **Name:** Settings screen splits local and shared edits in one realistic editing session
   **Type:** scenario
   **Harness:** interaction + programmatic state + output capture (`RTL` SettingsView scenario with mocked API and browser-preferences helper)
   **Preconditions:** Render `SettingsView` with loaded settings, writable browser storage, and mockable `/api/settings` plus directory validation.
   **Actions:** In one session, edit representative local controls (`theme`, `uiScale`, `terminal.fontSize`, `terminal.warnExternalLinks`, `sidebar.sortMode`, `sidebar.showSubagents`, `notifications.soundEnabled`) and representative shared controls (`defaultCwd`, `terminal.scrollback`, `safety.autoKillIdleMinutes`, `sidebar.excludeFirstChatSubstrings`, `sidebar.excludeFirstChatMustStart`). Reload or remount after saves settle.
   **Expected outcome:** Local controls update resolved settings and the browser-preferences blob without calling `/api/settings`. Shared controls go through the shared save path, persist on the server, and survive remount. `sidebar.excludeFirstChatSubstrings` and `sidebar.excludeFirstChatMustStart` stay on the shared path together. Sources: `ST1`, `ST2`, `ST3`, `ST4`.
   **Interactions:** SettingsView, settings thunk, browser-preferences persistence, config store, directory validation API.

7. **Name:** `/api/settings` exposes only the server-backed contract
   **Type:** integration
   **Harness:** direct API + output capture (`supertest` with the real router and config store)
   **Preconditions:** Use an isolated config directory and the real settings router with auth.
   **Actions:** Call `GET /api/settings`, then `PATCH /api/settings` with representative server-backed fields (`defaultCwd`, `terminal.scrollback`, `sidebar.excludeFirstChatSubstrings`, `sidebar.excludeFirstChatMustStart`, `codingCli.providers.codex.cwd`, `agentChat.defaultPlugins`) and representative local-only fields (`theme`, `terminal.fontSize`, `terminal.osc52Clipboard`, `sidebar.sortMode`, `sidebar.showSubagents`, `sidebar.ignoreCodexSubagents`, `notifications.soundEnabled`).
   **Expected outcome:** `GET /api/settings` returns only `ServerSettings`. Server-backed patches round-trip successfully. Local-only fields and stray nested sidebar keys are rejected with `400`. Clearing `defaultCwd` still works through the existing normalization semantics. Sources: `ST1`, `ST2`, `ST3`.
   **Interactions:** shared server patch schema, settings router, config store, auth middleware.

8. **Name:** ConfigStore sanitizes mixed legacy config into server settings plus top-level seed
   **Type:** integration
   **Harness:** direct API + output capture (`ConfigStore` against a real temporary `config.json`)
   **Preconditions:** Write a legacy mixed `config.json` containing both server-backed and now-local settings, with no existing `legacyLocalSettingsSeed`.
   **Actions:** Call `load()`, inspect the returned config and the on-disk file, then call `patchSettings()` with a server-backed patch and inspect the file again.
   **Expected outcome:** Live `settings` contain only server-backed fields. Moved local fields are extracted once into top-level `legacyLocalSettingsSeed`. Later server-backed saves preserve the seed but do not reintroduce local-only keys. Server-backed fields such as `agentChat.defaultPlugins` survive load and patch. Sources: `ST2`, `ST3`, `ST5`.
   **Interactions:** config load/save, atomic write path, backup write path, shared strip/extract helpers.

9. **Name:** `/api/bootstrap` returns server settings plus optional migration seed under the existing budget
   **Type:** integration
   **Harness:** direct API + output capture (`supertest` against `createShellBootstrapRouter`)
   **Preconditions:** Bootstrap router wired with server settings, platform info, and optional `legacyLocalSettingsSeed`.
   **Actions:** Request `/api/bootstrap` with and without a seed and measure the response body size.
   **Expected outcome:** The payload contains server-only `settings`, optional `legacyLocalSettingsSeed`, and the existing shell/platform/perf/configFallback fields, and it remains under `MAX_BOOTSTRAP_PAYLOAD_BYTES`. No non-bootstrap route returns the migration seed. Sources: `ST2`, `ST3`.
   **Interactions:** shell bootstrap router, read-model scheduler, config store seed accessor.

10. **Name:** WebSocket, perf, and network settings broadcasts never leak local-only fields
    **Type:** integration
    **Harness:** direct API + programmatic state + output capture (`ws` handshake tests, `supertest`, broadcast spies)
    **Preconditions:** A websocket handshake snapshot provider, the perf router, and the network router or manager all wired to the same server-backed settings source.
    **Actions:** Open a websocket connection and capture the handshake snapshot. Then trigger settings changes through `/api/settings`, `/api/perf`, and `/api/network/configure`.
    **Expected outcome:** Every `settings.updated` payload contains only server-backed settings. `legacyLocalSettingsSeed` never appears in websocket snapshots or later broadcasts. Local-only fields never reappear through perf or network rebroadcast paths. Sources: `ST2`, `ST3`.
    **Interactions:** ws handler, perf router, network router, network manager rollback path, config store, terminal registry consumers.

11. **Name:** Browser-preferences blob migrates legacy local keys and only seeds missing values
    **Type:** integration
    **Harness:** programmatic state + output capture (pure `browser-preferences` module tests with real `localStorage`)
    **Preconditions:** Seed legacy keys for terminal font family and ToolStrip expansion. Do not seed the new browser-preferences blob yet.
    **Actions:** Load the browser-preferences module, patch the record, call the seed helper twice with different values, and read accessors for ToolStrip expansion and tab search range.
    **Expected outcome:** The module creates one versioned sparse blob, migrates legacy keys once, and keeps only sparse local settings patches inside it. `seedBrowserPreferencesSettingsIfEmpty` fills missing settings but never overwrites an existing local settings payload. ToolStrip and search-range accessors read from the blob instead of ad hoc keys. Sources: `ST2`, `ST4`, `ST5`.
    **Interactions:** browser-preferences module, localStorage, storage migration, ToolStrip, TabsView.

12. **Name:** App hydration recomposes server and local settings without clobbering local overrides
    **Type:** integration
    **Harness:** interaction + programmatic state + output capture (`RTL` App bootstrap tests with mocked bootstrap and websocket messages)
    **Preconditions:** Seed the browser-preferences blob with one local override. Prepare a bootstrap response with different server settings and an optional `legacyLocalSettingsSeed`, then a websocket `settings.updated` message with new server-backed values.
    **Actions:** Mount `App`, let bootstrap complete, then deliver `settings.updated`.
    **Expected outcome:** The settings slice keeps distinct server and local state and exposes a resolved read model. Bootstrap applies the migration seed only when the browser-preferences record has no settings payload yet. Existing local overrides survive both bootstrap and websocket updates. Fresh default local sort mode resolves to `activity`, not `recency-pinned`. Sources: `ST2`, `ST3`, `ST4`.
    **Interactions:** App bootstrap flow, settings slice, browser-preferences helper, websocket client.

13. **Name:** Browser-preferences persistence and same-profile sync keep tabs in one profile converged
    **Type:** integration
    **Harness:** programmatic state + output capture (store/middleware tests with storage and `BroadcastChannel` delivery)
    **Preconditions:** Two stores or pages in one browser profile, browser-preferences middleware installed, and `BroadcastChannel` available or emulated.
    **Actions:** Dispatch representative local settings updates and `setTabRegistrySearchRangeDays`, allow the debounce timer to elapse, trigger `pagehide`, then deliver the raw blob to the second store via storage and broadcast events.
    **Expected outcome:** The raw browser-preferences blob persists local settings and `tabs.searchRangeDays` on debounce or `pagehide`. The second same-profile tab hydrates those changes through storage or `BroadcastChannel`. `searchRangeDays` initializes from the blob instead of resetting to `30` on reload. Sources: `ST2`, `ST4`.
    **Interactions:** Redux middleware, crossTabSync, tabRegistry slice, browser storage events.

14. **Name:** Shared settings contract partitions fields correctly and composes the resolved read model
    **Type:** invariant
    **Harness:** direct API + output capture (pure `shared/settings.ts` tests)
    **Preconditions:** None beyond the shared settings module under test.
    **Actions:** Validate representative patches through `buildServerSettingsPatchSchema()`, call `resolveLocalSettings()`, `composeResolvedSettings()`, `extractLegacyLocalSettingsSeed()`, and `stripLocalSettings()`.
    **Expected outcome:** Server patch validation accepts representative server fields and rejects representative local fields. `resolveLocalSettings(undefined)` defaults `sidebar.sortMode` to `activity`. `composeResolvedSettings()` layers local-only fields such as `terminal.fontFamily` onto server settings. `extractLegacyLocalSettingsSeed()` and `stripLocalSettings()` form a lossless partition of local-vs-server fields. Sources: `ST1`, `ST2`, `ST3`.
    **Interactions:** shared settings contract, client settings slice consumers, server router schema.

15. **Name:** Upgrade from pre-split artifacts preserves the upgrading browser’s visible settings
    **Type:** differential
    **Harness:** reference comparison + interaction + output capture (frozen legacy fixture, App bootstrap, browser-preferences and config-file inspection)
    **Preconditions:** Use the frozen legacy mixed-config fixture captured from the pre-split app, with an empty browser-preferences blob for the upgrading browser.
    **Actions:** Boot the split implementation against that fixture, capture the first-boot resolved settings in the upgrading browser, then inspect the browser-preferences blob and on-disk `config.json`.
    **Expected outcome:** The upgrading browser sees the same visible values for moved local settings on first boot that the pre-split reference fixture recorded. After that boot, those values live in the browser-preferences blob, while the server file keeps only server settings plus the migration seed. Sources: `ST1`, `ST2`, `ST5`.
    **Interactions:** App bootstrap flow, config store migration, browser-preferences seeding, frozen legacy artifact.

16. **Name:** Sort-mode normalization and first-chat exclusions keep their post-split invariants
    **Type:** invariant
    **Harness:** direct API + programmatic state (`shared/settings.ts` plus sidebar selector tests)
    **Preconditions:** Sample sidebar session data that includes matching and non-matching first messages plus multiple sort-mode inputs.
    **Actions:** Supply missing or invalid sort modes, the legacy `hybrid` value, and first-chat exclusion lists with whitespace and duplicates, then run the resolver and selectors.
    **Expected outcome:** Missing or invalid local sort modes resolve to `activity`. `hybrid` migration happens in the local resolver rather than in server migration code. First-chat exclusion lists remain normalized, and `excludeFirstChatMustStart` still controls prefix-vs-substring behavior for shared filtering. Sources: `ST1`, `ST2`, `ST4`.
    **Interactions:** shared local resolver, sidebar selectors, filter normalization.

17. **Name:** Malformed browser storage fails safe without breaking bootstrap
    **Type:** boundary
    **Harness:** programmatic state + interaction (`browser-preferences` parser tests and App bootstrap smoke coverage)
    **Preconditions:** Seed `localStorage` with invalid JSON, bad enum values, partial blobs, or a corrupt current blob combined with stale legacy keys.
    **Actions:** Load the browser-preferences helper or mount `App`, then perform one valid local settings change.
    **Expected outcome:** The app still boots and bootstrap still completes. Invalid local blobs fall back to defaults or surviving valid fields instead of crashing. A valid existing local settings payload is not overwritten by a seed. The first successful local change rewrites a valid blob. Sources: `ST2`, `ST4`, `ST5`.
    **Interactions:** browser-preferences parser, App bootstrap, persistence middleware, storage migration.

18. **Name:** Clearing `defaultCwd` still works end to end without extra startup fetches
    **Type:** regression
    **Harness:** interaction + direct API + output capture (`SettingsView` or thunk tests plus bootstrap request log assertions)
    **Preconditions:** A settings store with `defaultCwd` set, mocked directory validation, and a request log for startup fetches.
    **Actions:** Save a default directory, clear it through the shared save path, inspect the outbound payload, reload the app, and inspect the startup request log.
    **Expected outcome:** The client sends the clear sentinel expected by the API, the server stores `defaultCwd` as absent or `undefined`, reload shows the setting cleared, and startup still relies on `/api/bootstrap` as the lone shell-critical settings fetch rather than reintroducing a second synchronization request. Sources: `ST2`, `ST3`, `ST4`.
    **Interactions:** SettingsView validation flow, shared save thunk, settings router normalization, App bootstrap loader.

## Coverage Summary

Covered action space:

- Local-versus-shared persistence semantics across two browser surfaces on the same server.
- Upgrade continuity from mixed legacy config and legacy local keys into the split model.
- Settings UI edits for both persistence classes.
- Sidebar geometry, collapse, and mobile auto-collapse behavior.
- ToolStrip expansion and Tabs closed-range persistence.
- OSC52 clipboard policy prompts and follow-up behavior.
- Pane picker, coding-CLI provider `cwd`, agent-chat defaults, and initial setup dismissal.
- `/api/settings`, `/api/bootstrap`, websocket `settings.updated`, perf logging, and network rebroadcast paths.
- Browser-preferences debounce, `pagehide` flush, storage events, and `BroadcastChannel` sync.
- Local sort-mode normalization, shared first-chat filtering rules, malformed browser storage, and `defaultCwd` clear semantics.

Explicitly excluded per the approved strategy:

- No screenshot or visual-baseline coverage. This refactor changes persistence and synchronization semantics rather than intentional visuals. Risk: a purely cosmetic regression in SettingsView or sidebar layout could slip through if it does not affect behavior.
- No Electron-specific coverage. The plan and touched files stay inside the shared web client and Node server contracts. Risk: an Electron-only persistence quirk would be caught later, not by this task’s primary suite.
- No exhaustive one-test-per-setting matrix at the scenario level. Instead, representative settings from each persistence class are covered in scenarios, and the full partition is enforced in shared-schema and API-contract tests. Risk: a single misclassified field could hide if it is omitted from both the representative scenario set and the contract partition tests.
- No standalone tests whose only purpose is “fixtures were updated.” Test helper and fixture churn is validated indirectly by the product-facing scenarios and integration tests above. Risk: stale helpers may cause noisy test failures during implementation, but they should not silently mask product regressions.
