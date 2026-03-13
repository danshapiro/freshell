# Settings Persistence Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Split Freshell settings into a strict server-backed contract and a unified browser-local preference layer, move the approved UI/debugging settings to browser storage, keep the approved server-backed workflow settings replicated across surfaces, and land the migration without losing legacy user preferences.

**Architecture:** Replace the overloaded shared `AppSettings` model with one shared `ServerSettings` contract in `shared/settings.ts` and one browser-only `BrowserPreferences` module in `src/lib/browser-preferences.ts`. The client Redux settings slice should store both `serverSettings` and the resolved composed settings so bootstrap responses, websocket `settings.updated` messages, and local-storage sync can all converge deterministically without ad hoc per-field overlays.

**Tech Stack:** TypeScript, Zod, Express, React 18, Redux Toolkit, Vitest, Testing Library, Playwright

---

## Strategy Gate

The direct path is a clean cutover, not another round of per-field exceptions.

- Do **not** patch the current drift by sprinkling more `delete body.sidebar.*`, `applyLocalTerminalFontFamily()`, or one-off `localStorage` keys around the UI. That would keep the root problem: one type pretending to represent two persistence domains.
- Put the server contract, defaults, normalization, and migration helpers in one shared module so the server validator, server config store, and client resolved-settings model all derive from the same source of truth.
- Put browser-local preferences in one structured storage blob with targeted legacy-key migration. Keep device identity/aliases/dismissals in their existing dedicated keys because they are already browser-local and are not part of the settings split.
- Keep `sidebar.excludeFirstChatSubstrings` server-backed with `sidebar.excludeFirstChatMustStart`. The user explicitly approved the assumption that the first-chat exclusion rule replicates across surfaces, and the toggle is not meaningful without the substring list.
- Delete the dead duplicate route module `server/routes/settings.ts` so there is only one server settings router implementation after this change.

## Persistence Classification

These paths are the end-state contract. Do not improvise alternate classifications while implementing.

**Server-backed settings**

- `defaultCwd`
- `allowedFilePaths`
- `logging.debug`
- `safety.autoKillIdleMinutes`
- `terminal.scrollback`
- `panes.defaultNewPane`
- `sidebar.excludeFirstChatSubstrings`
- `sidebar.excludeFirstChatMustStart`
- `codingCli.enabledProviders`
- `codingCli.knownProviders`
- `codingCli.providers.*`
- `editor.*`
- `agentChat.initialSetupDone`
- `agentChat.defaultPlugins`
- `agentChat.providers.*`
- `network.*`

**Browser-local settings**

- `theme`
- `uiScale`
- `terminal.fontFamily`
- `terminal.fontSize`
- `terminal.lineHeight`
- `terminal.cursorBlink`
- `terminal.theme`
- `terminal.warnExternalLinks`
- `terminal.osc52Clipboard`
- `terminal.renderer`
- `panes.snapThreshold`
- `panes.iconsOnTabs`
- `panes.tabAttentionStyle`
- `panes.attentionDismiss`
- `sidebar.sortMode`
- `sidebar.showProjectBadges`
- `sidebar.showSubagents`
- `sidebar.ignoreCodexSubagents`
- `sidebar.showNoninteractiveSessions`
- `sidebar.hideEmptySessions`
- `sidebar.width`
- `sidebar.collapsed`
- `notifications.soundEnabled`

**Browser-local non-settings preferences that should join the same unified local-preference system**

- `toolStripExpanded`
- `tabs.searchRangeDays`

### Task 1: Define the shared server/local settings contract

**Files:**
- Create: `shared/settings.ts`
- Create: `test/unit/shared/settings.test.ts`
- Modify: `test/integration/server/settings-api.test.ts`
- Modify: `test/unit/server/config-store.test.ts`
- Modify: `test/unit/server/settings-migrate.test.ts`
- Delete: `server/routes/settings.ts`

**Step 1: Write the failing tests**

Add a pure shared-settings test suite that proves the new classification and merge rules:

- composing `ServerSettings + LocalSettings` yields the resolved client settings shape
- extracting a local-settings seed from legacy server config picks up the moved fields
- stripping local-only keys from legacy server config leaves only server-backed settings
- legacy local sort mode `'hybrid'` becomes `'activity'`
- `agentChat.defaultPlugins` is part of the server-backed contract

Extend the server API test so `/api/settings`:

- rejects representative moved local fields such as `theme`, `terminal.fontSize`, `sidebar.sortMode`, `sidebar.showSubagents`, `sidebar.width`, `notifications.soundEnabled`
- still accepts representative server-backed fields such as `defaultCwd`, `terminal.scrollback`, `sidebar.excludeFirstChatSubstrings`, `sidebar.excludeFirstChatMustStart`, and `agentChat.defaultPlugins`
- never returns moved local-only fields from `GET /api/settings` or `PATCH /api/settings`

Extend the config-store test so loading a legacy `config.json` containing both server-backed and newly-local fields produces:

- sanitized server settings in memory
- an extracted local-preference seed for the moved fields
- rewritten persisted config that no longer reintroduces local-only settings on `patchSettings()`

Remove the obsolete server sort-mode migration expectations from `test/unit/server/settings-migrate.test.ts`; keep only the still-valid `migrateLegacyDefaultEnabledProviders` coverage there.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/integration/server/settings-api.test.ts test/unit/server/config-store.test.ts test/unit/server/settings-migrate.test.ts
```

Expected: FAIL because `shared/settings.ts` does not exist, `/api/settings` still accepts and returns local-only fields, `ConfigStore` still treats local-only keys as server settings, and the server migration suite still assumes sort mode is server-backed.

**Step 3: Write the minimal implementation**

Create `shared/settings.ts` as the single contract module. It should export:

```ts
export const defaultServerSettings
export const defaultLocalSettings
export const ServerSettingsSchema
export const LocalSettingsSchema
export type ServerSettings
export type ServerSettingsPatch
export type LocalSettings
export type LocalSettingsPatch
export type ResolvedSettings
export function mergeServerSettings(...)
export function mergeLocalSettings(...)
export function composeResolvedSettings(...)
export function extractLegacyLocalSettingsSeed(...)
export function stripLocalSettings(...)
```

Implementation rules:

- Lift existing server-backed enums and defaults from `server/config-store.ts`; do not invent new values.
- Include `agentChat.defaultPlugins` in `ServerSettingsSchema`.
- Keep `terminal.fontFamily` and `sidebar.ignoreCodexSubagents` out of `ServerSettingsSchema`.
- Move the old client-only sort-mode migration into shared local-settings normalization.
- Delete `server/routes/settings.ts`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/integration/server/settings-api.test.ts test/unit/server/config-store.test.ts test/unit/server/settings-migrate.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add shared/settings.ts \
  test/unit/shared/settings.test.ts \
  test/integration/server/settings-api.test.ts \
  test/unit/server/config-store.test.ts \
  test/unit/server/settings-migrate.test.ts \
  server/routes/settings.ts
git commit -m "refactor(settings): define server and local contracts"
```

### Task 2: Cut the server over to `ServerSettings` and expose bootstrap migration seed

**Files:**
- Modify: `server/config-store.ts`
- Modify: `server/settings-router.ts`
- Modify: `server/settings-migrate.ts`
- Modify: `server/index.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `server/perf-router.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `shared/read-models.ts`
- Modify: `test/integration/server/bootstrap-router.test.ts`

**Step 1: Write the failing tests**

Add bootstrap router assertions that `/api/bootstrap` includes:

- sanitized `settings` containing only `ServerSettings`
- optional `localPreferenceSeed` when legacy moved fields were found in config
- no payload-budget regression beyond the existing bootstrap size guard

Add config-store assertions that:

- `UserConfig.settings` is stored as `ServerSettings`
- optional `localPreferenceSeed` is retained as migration metadata
- `patchSettings()` never writes local-only fields back into `settings`

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/integration/server/bootstrap-router.test.ts test/integration/server/settings-api.test.ts test/unit/server/config-store.test.ts
```

Expected: FAIL because bootstrap does not yet expose `localPreferenceSeed`, server runtime code still imports the old `AppSettings` shape, and settings updates still flow through the old contract.

**Step 3: Write the minimal implementation**

Server-side implementation rules:

- Rename the server type usage to `ServerSettings` everywhere server runtime depends on settings.
- `ConfigStore` should cache:

```ts
type UserConfig = {
  version: 1
  settings: ServerSettings
  localPreferenceSeed?: LocalSettingsPatch
  ...
}
```

- On load, read the raw legacy config once, extract the local seed with `extractLegacyLocalSettingsSeed()`, strip local settings out of `settings`, and keep the seed in `localPreferenceSeed`.
- `createSettingsRouter()` must validate patches with the shared `ServerSettingsSchema`-derived patch schema. Do not keep local-only fields in the router and do not keep the old `ignoreCodexSubagentSessions` workaround except as an optional legacy no-op delete before validation if still needed for compatibility.
- `createShellBootstrapRouter()` should accept a `getLocalPreferenceSeed` dependency and include `localPreferenceSeed` in the bootstrap payload only when defined.
- `TerminalRegistry`, `PerfRouter`, and websocket `settings.updated` broadcasts must operate on `ServerSettings`, not resolved client settings.
- `server/settings-migrate.ts` should only contain migrations that still belong to the server contract after the split.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/integration/server/bootstrap-router.test.ts test/integration/server/settings-api.test.ts test/unit/server/config-store.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add server/config-store.ts \
  server/settings-router.ts \
  server/settings-migrate.ts \
  server/index.ts \
  server/shell-bootstrap-router.ts \
  server/perf-router.ts \
  server/ws-handler.ts \
  server/terminal-registry.ts \
  shared/read-models.ts \
  test/integration/server/bootstrap-router.test.ts
git commit -m "refactor(settings): migrate server persistence and bootstrap"
```

### Task 3: Build the unified browser-preferences storage module and migrate legacy keys

**Files:**
- Create: `src/lib/browser-preferences.ts`
- Create: `test/unit/client/lib/browser-preferences.test.ts`
- Modify: `src/lib/terminal-fonts.ts`
- Modify: `src/store/storage-keys.ts`

**Step 1: Write the failing tests**

Add a browser-preferences unit suite that proves:

- the new storage key reads and writes a structured JSON blob
- malformed JSON falls back safely to defaults
- legacy keys are imported into the new blob exactly once:
  - `freshell.terminal.fontFamily.v1`
  - `freshell:toolStripExpanded`
- bootstrap `localPreferenceSeed` fills missing local settings but never overwrites an existing local value
- `tabs.searchRangeDays` persists in the same blob
- subscription notifies both same-document writes and cross-document `storage` events

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/browser-preferences.test.ts test/unit/client/lib/terminal-fonts.test.ts test/unit/client/components/agent-chat/ToolStrip.test.tsx test/e2e/tabs-view-search-range.test.tsx
```

Expected: FAIL because the unified browser-preferences module does not exist, terminal-font persistence still lives in `terminal-fonts.ts`, ToolStrip still uses the legacy key, and search-range persistence is still absent.

**Step 3: Write the minimal implementation**

Create `src/lib/browser-preferences.ts` with one storage key, one schema, and one subscription surface:

```ts
export const BROWSER_PREFERENCES_STORAGE_KEY = 'freshell.browser-preferences.v1'

export type BrowserPreferences = {
  settings: LocalSettings
  toolStrip: { expanded: boolean }
  tabs: { searchRangeDays: number }
}

export function loadBrowserPreferences(...)
export function saveBrowserPreferences(...)
export function patchBrowserPreferences(...)
export function seedBrowserPreferences(...)
export function subscribeBrowserPreferences(...)
export function getToolStripExpandedPreference(...)
export function setToolStripExpandedPreference(...)
export function getSearchRangeDaysPreference(...)
export function setSearchRangeDaysPreference(...)
```

Implementation rules:

- Keep `terminal-fonts.ts` focused on font-family resolution and font catalog only. Remove its storage helpers and update callers to use `browser-preferences.ts`.
- Add a constant for `BROWSER_PREFERENCES_STORAGE_KEY` to `src/store/storage-keys.ts`.
- Do **not** use the global wipe-based storage migration for this feature. Perform targeted migration inside `browser-preferences.ts` so tabs/panes/device state remain intact.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/browser-preferences.test.ts test/unit/client/lib/terminal-fonts.test.ts test/unit/client/components/agent-chat/ToolStrip.test.tsx test/e2e/tabs-view-search-range.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/browser-preferences.ts \
  test/unit/client/lib/browser-preferences.test.ts \
  src/lib/terminal-fonts.ts \
  src/store/storage-keys.ts
git commit -m "feat(settings): add unified browser preferences storage"
```

### Task 4: Recompose client settings from `serverSettings + localSettings`

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/settingsSlice.ts`
- Modify: `src/App.tsx`
- Modify: `test/unit/client/store/settingsSlice.test.ts`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/e2e/terminal-font-settings.test.tsx`
- Modify: `test/unit/client/components/settings-view-test-utils.tsx`

**Step 1: Write the failing tests**

Update the settings slice and bootstrap tests so they assert the new convergence model:

- the settings slice keeps `serverSettings` separately from resolved `settings`
- bootstrap composes resolved settings from sanitized server settings plus browser-local preferences
- bootstrap seeds empty local preferences from `localPreferenceSeed`
- websocket `settings.updated` recomposes from the current browser-local preferences instead of clobbering them
- a storage change in the browser-preference blob recomposes resolved settings without refetching `/api/settings`

Extend the terminal-font flow test into a broader local-settings migration proof:

- an empty browser seeds `terminal.fontFamily` from bootstrap `localPreferenceSeed`
- an existing local font still wins over bootstrap seed and over later websocket updates

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/settingsSlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: FAIL because the slice still stores only one mixed settings object, App still overlays only `fontFamily`, and bootstrap/ws paths do not know about `localPreferenceSeed` or the new browser-preference subscription.

**Step 3: Write the minimal implementation**

Refactor the settings slice into the steady-state model:

```ts
type SettingsState = {
  serverSettings: ServerSettings
  localSettings: LocalSettings
  settings: ResolvedSettings
  loaded: boolean
  lastSavedAt?: number
}
```

Add pure actions that keep the composition explicit:

- `setServerSettings(serverSettings)`
- `hydrateLocalSettings(localSettings)`
- `updateLocalSettings(localPatch)`
- `previewServerSettingsPatch(serverPatch)`
- `markSaved()`

`App.tsx` must:

- load browser preferences before applying bootstrap settings
- seed empty local preferences from `bootstrap.localPreferenceSeed`
- dispatch `setServerSettings()` for bootstrap and `settings.updated`
- subscribe to browser-preference changes and dispatch `hydrateLocalSettings()` / `setTabRegistrySearchRangeDays()` without extra network traffic
- remove the old `applyLocalTerminalFontFamily()` special case entirely

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/store/settingsSlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/store/types.ts \
  src/store/settingsSlice.ts \
  src/App.tsx \
  test/unit/client/store/settingsSlice.test.ts \
  test/unit/client/components/App.ws-bootstrap.test.tsx \
  test/e2e/terminal-font-settings.test.tsx \
  test/unit/client/components/settings-view-test-utils.tsx
git commit -m "refactor(settings): compose resolved settings from server and local state"
```

### Task 5: Split Settings UI, sidebar, and OSC52 writes by persistence layer

**Files:**
- Modify: `src/components/SettingsView.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/App.tsx`
- Modify: `test/unit/client/components/SettingsView.core.test.tsx`
- Modify: `test/unit/client/components/SettingsView.behavior.test.tsx`
- Modify: `test/unit/client/components/SettingsView.terminal-advanced.test.tsx`
- Modify: `test/unit/client/components/App.sidebar-resize.test.tsx`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
- Modify: `test/e2e/terminal-osc52-policy-flow.test.tsx`

**Step 1: Write the failing tests**

Rewrite the UI persistence tests around the new split:

- local controls update Redux plus browser-preference storage and do **not** call `/api/settings`
- server-backed controls still optimistically update Redux, debounce a server patch, and mark save time on success
- sidebar width/collapse is local-only, including mobile auto-collapse
- OSC52 policy is local-only in both SettingsView and TerminalView prompt flows

Use these representative assertions:

- local: `theme`, `uiScale`, `terminal.fontSize`, `terminal.cursorBlink`, `terminal.theme`, `terminal.warnExternalLinks`, `terminal.renderer`, `sidebar.sortMode`, `sidebar.showSubagents`, `sidebar.ignoreCodexSubagents`, `sidebar.showNoninteractiveSessions`, `sidebar.hideEmptySessions`, `sidebar.width`, `sidebar.collapsed`, `notifications.soundEnabled`
- server: `defaultCwd`, `terminal.scrollback`, `safety.autoKillIdleMinutes`, `sidebar.excludeFirstChatSubstrings`, `sidebar.excludeFirstChatMustStart`, `logging.debug`

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/TerminalView.osc52.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: FAIL because the current UI still routes almost every control through one debounced `/api/settings` writer and the sidebar / OSC52 paths still patch the server.

**Step 3: Write the minimal implementation**

Refactor `SettingsView` so it has two explicit write helpers instead of one generic `scheduleSave()`:

```ts
const applyLocalPreference = (patch: DeepPartial<LocalSettings>) => { ... }
const applyServerSetting = (patch: DeepPartial<ServerSettings>) => { ... }
```

Implementation rules:

- Local controls must call `updateLocalSettings()` and `patchBrowserPreferences({ settings: ... })` immediately.
- Server-backed controls must call `previewServerSettingsPatch()` and debounce only the server patch.
- `App.tsx` sidebar resize/collapse handlers must stop patching `/api/settings`.
- `TerminalView.tsx` `persistOsc52Policy()` must stop patching `/api/settings`.
- Do not keep any code path that submits a full mixed `sidebar` object to the server.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/TerminalView.osc52.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/SettingsView.tsx \
  src/components/TerminalView.tsx \
  src/App.tsx \
  test/unit/client/components/SettingsView.core.test.tsx \
  test/unit/client/components/SettingsView.behavior.test.tsx \
  test/unit/client/components/SettingsView.terminal-advanced.test.tsx \
  test/unit/client/components/App.sidebar-resize.test.tsx \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/terminal-osc52-policy-flow.test.tsx
git commit -m "fix(settings): split local and server write paths"
```

### Task 6: Fold tool-strip state, tab search range, and agent-chat defaults into the new model

**Files:**
- Modify: `src/components/agent-chat/ToolStrip.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `test/unit/client/components/agent-chat/ToolStrip.test.tsx`
- Modify: `test/unit/client/components/agent-chat/MessageBubble.test.tsx`
- Modify: `test/e2e/tabs-view-search-range.test.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/e2e/agent-chat-context-menu-flow.test.tsx`
- Modify: `test/e2e/agent-chat-polish-flow.test.tsx`

**Step 1: Write the failing tests**

Update the tool-strip and tabs tests so they assert:

- ToolStrip reads and writes its expanded state through `browser-preferences.ts`, not the legacy `freshell:toolStripExpanded` key
- `searchRangeDays` initializes from the browser-preference blob, persists on change, and survives rerender/reload
- `PaneContainer` still passes `settings.agentChat.defaultPlugins` into new agent-chat panes after the server contract change

Update the agent-chat flow tests that hard-code the legacy tool-strip key so they fail until the new browser-preference helper is in place.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/e2e/tabs-view-search-range.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: FAIL because ToolStrip still uses the legacy key, `searchRangeDays` still resets on reload, and the tests still reference the old storage behavior.

**Step 3: Write the minimal implementation**

Implementation rules:

- `ToolStrip.tsx` should use `subscribeBrowserPreferences()` and the dedicated getter/setter helpers for `toolStrip.expanded`.
- `tabRegistrySlice.ts` should read its initial `searchRangeDays` from `browser-preferences.ts`; `TabsView.tsx` should persist updates through `setSearchRangeDaysPreference()` whenever the user changes the range.
- Keep `searchRangeDays` inside the tab-registry Redux state because `tabRegistrySync.ts` already depends on it for outbound websocket queries.
- `PaneContainer.tsx` does not need a persistence refactor; it only needs to keep consuming the resolved settings object so `agentChat.defaultPlugins` continues to work after the server schema fix.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/e2e/tabs-view-search-range.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/agent-chat/ToolStrip.tsx \
  src/components/TabsView.tsx \
  src/store/tabRegistrySlice.ts \
  src/components/panes/PaneContainer.tsx \
  test/unit/client/components/agent-chat/ToolStrip.test.tsx \
  test/unit/client/components/agent-chat/MessageBubble.test.tsx \
  test/e2e/tabs-view-search-range.test.tsx \
  test/unit/client/components/panes/PaneContainer.test.tsx \
  test/e2e/agent-chat-context-menu-flow.test.tsx \
  test/e2e/agent-chat-polish-flow.test.tsx
git commit -m "fix(local-prefs): persist tool strip and tabs range"
```

### Task 7: Prove cross-surface semantics in Playwright and run the full verification gate

**Files:**
- Create: `test/e2e-browser/specs/settings-persistence-split.spec.ts`
- Modify: `test/e2e-browser/specs/multi-client.spec.ts`

**Step 1: Write the failing tests**

Add one dedicated Playwright spec that uses two separate browser contexts against the same isolated server and proves the user-facing guarantee:

- Context A writes a local-only preference into the browser-preference blob and reloads; the value persists in A.
- Context B starts clean against the same server; it does **not** inherit A’s local-only preference.
- Context A patches a server-backed setting through `/api/settings` and reloads.
- Context B reloads and **does** inherit the server-backed setting.
- The server `config.json` on disk never contains the local-only preference.

Update `multi-client.spec.ts` so its existing “settings change broadcasts to other clients” test stops using `terminal.fontSize` and uses a still-server-backed field such as `defaultCwd` instead.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:e2e -- test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
```

Expected: FAIL because local-only settings still replicate through the server contract, the old multi-client test still uses a now-local field, or the browser-preference sync path is incomplete.

**Step 3: Write the minimal implementation**

Keep the Playwright surface honest:

- Use direct `page.evaluate()` writes to the browser-preference blob for the local-only proof; the UI write paths are already covered in RTL/Vitest and this spec only needs to prove browser-vs-server scoping.
- Use `/api/settings` for the server-backed proof.
- Read `serverInfo.homeDir` / `serverInfo.configDir` in the test process to inspect the isolated `config.json` directly.

Do **not** add screenshots for this task. Structured Redux/storage/config assertions are the truthful surface.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:e2e -- test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
```

Expected: PASS

Run the final repo gate in this order:

```bash
npm run lint
npm run typecheck
FRESHELL_TEST_SUMMARY="settings persistence split final" npm test
npm run test:e2e -- test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
```

Expected: PASS

Do not update `docs/index.html` for this work. The visible UI is materially the same; the change is persistence architecture and behavior correctness.

**Step 5: Commit**

```bash
git add test/e2e-browser/specs/settings-persistence-split.spec.ts \
  test/e2e-browser/specs/multi-client.spec.ts
git commit -m "test(settings): prove local and server persistence split"
```
