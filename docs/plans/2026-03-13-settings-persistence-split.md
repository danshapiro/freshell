# Settings Persistence Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Split Freshell settings into a strict server-backed contract and a unified browser-local preference layer, move the approved UI and debugging settings to browser storage, keep the approved workflow settings replicated through the server, and migrate existing users without silently losing moved preferences.

**Architecture:** Introduce one shared `ServerSettings` contract in `shared/settings.ts` and one unified browser-preference store in `src/lib/browser-preferences.ts`. Keep Redux storing both server and local settings plus a composed resolved view so most UI code can keep reading `state.settings.settings`, while all writes become explicitly local or explicitly server-backed.

**Tech Stack:** TypeScript, Zod, Express, React 18, Redux Toolkit, Vitest, Testing Library, Playwright

---

## Strategy Gate

The right fix is a clean persistence split, not more ad hoc exceptions.

- Do not keep the current mixed `AppSettings` model and paper over it with more one-off client overlays or `delete body.sidebar.foo` hacks.
- Do not add a second duplicate schema tree. Shared settings types, defaults, normalization, and Zod builders must live in one `shared/settings.ts` module so the server validator, config store, and client composition logic cannot drift again.
- Keep local browser preferences in one structured localStorage blob. Device identity, aliases, and dismissed-device state can stay in their existing dedicated browser keys because they are already local and are not part of the settings split.
- Use a migration-only `legacyLocalSettingsSeed` in server config/bootstrap so pre-split server-backed values can seed missing local settings after upgrade. This is intentionally one-way fallback metadata, not live shared state.
- Keep the local default `sidebar.sortMode` at `recency-pinned`. That matches the current client UX and removes the existing server/client default mismatch. Continue migrating legacy `'hybrid'` to `'activity'`.
- Keep `sidebar.excludeFirstChatSubstrings` server-backed with `sidebar.excludeFirstChatMustStart`. The user explicitly kept that rule replicated across surfaces, and the toggle is not meaningful without the substring list.
- Keep dynamic coding-CLI provider validation. `shared/settings.ts` must export schema builders that accept the runtime provider list; a static closed schema would regress extension/provider support.
- Any code path that broadcasts `settings.updated` or returns bootstrap settings must send `ServerSettings`, never a mixed resolved client object.
- Delete the dead duplicate server router in `server/routes/settings.ts` as part of the cutover so there is only one settings API implementation.

## Persistence Classification

These are the end-state buckets. Do not improvise alternate classifications during implementation.

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

**Browser-local non-settings preferences that should live in the same unified browser-preference blob**

- `toolStripExpanded`
- `tabs.searchRangeDays`

## Key Decisions

- `allowedFilePaths` remains server-backed and internal. Do not add new UI for it during this work.
- `defaultCwd` keeps its current PATCH API behavior where `null` clears the value. Preserve that explicitly in the server patch schema instead of accidentally removing it when deriving schemas from shared types.
- `legacyLocalSettingsSeed` is intentionally migration-only fallback. It may seed a brand-new browser profile once after upgrade, but once local preferences exist they win permanently and ongoing local changes never replicate through the server.
- Shared settings code must not import client-only types such as `AgentChatProviderName` from `src/`. In `shared/settings.ts`, use `string` keys for `agentChat.providers`.
- Keep `defaultSettings` exports in both `server/config-store.ts` and `src/store/settingsSlice.ts`, but change what they mean:
  - server `defaultSettings` becomes `defaultServerSettings`
  - client `defaultSettings` becomes `composeResolvedSettings(defaultServerSettings, defaultLocalSettings)`

### Task 1: Create the shared settings contract and normalization helpers

**Files:**
- Create: `shared/settings.ts`
- Create: `test/unit/shared/settings.test.ts`

**Step 1: Write the failing tests**

Add a new pure unit suite that proves:

- `buildServerSettingsPatchSchema()` accepts server-backed fields and rejects representative local-only fields.
- `composeResolvedSettings(server, local)` produces the resolved client shape, including `terminal.fontFamily`.
- `extractLegacyLocalSettingsSeed()` pulls moved fields out of a legacy mixed settings object.
- `stripLocalSettings()` removes moved fields while preserving server-backed fields.
- local sort-mode normalization keeps valid values, migrates `'hybrid'` to `'activity'`, and defaults invalid values to `'recency-pinned'`.
- `agentChat.defaultPlugins` is part of the server-backed contract.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts
```

Expected: FAIL because `shared/settings.ts` does not exist.

**Step 3: Write the minimal implementation**

Create `shared/settings.ts` as the single source of truth for settings contracts. It should export:

```ts
export const defaultServerSettings
export const defaultLocalSettings
export type ServerSettings
export type ServerSettingsPatch
export type LocalSettings
export type LocalSettingsPatch
export type ResolvedSettings
export function buildServerSettingsSchema(...)
export function buildServerSettingsPatchSchema(...)
export const LocalSettingsSchema
export function mergeServerSettings(...)
export function mergeLocalSettings(...)
export function composeResolvedSettings(...)
export function normalizeLocalSortMode(...)
export function extractLegacyLocalSettingsSeed(...)
export function stripLocalSettings(...)
```

Implementation rules:

- `buildServerSettingsSchema()` and `buildServerSettingsPatchSchema()` must accept the runtime coding-CLI provider list.
- Preserve the PATCH-only `defaultCwd: null` clearing behavior.
- Put `agentChat.defaultPlugins` in `ServerSettings`.
- Keep `terminal.fontFamily` and `sidebar.ignoreCodexSubagents` out of `ServerSettings`.
- Make `defaultLocalSettings.sidebar.sortMode` equal `'recency-pinned'`.
- Do not import any `src/` types into `shared/settings.ts`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add shared/settings.ts test/unit/shared/settings.test.ts
git commit -m "refactor(settings): add shared server and local contracts"
```

### Task 2: Cut the server config store and settings API over to `ServerSettings`

**Files:**
- Modify: `server/config-store.ts`
- Modify: `server/settings-router.ts`
- Modify: `server/settings-migrate.ts`
- Modify: `test/integration/server/settings-api.test.ts`
- Modify: `test/integration/server/api-edge-cases.test.ts`
- Modify: `test/unit/server/config-store.test.ts`
- Modify: `test/unit/server/settings-migrate.test.ts`
- Delete: `server/routes/settings.ts`

**Step 1: Write the failing tests**

Update the server contract tests so they assert:

- `GET /api/settings` and `PATCH /api/settings` return and accept only `ServerSettings`.
- representative moved local fields such as `theme`, `terminal.fontSize`, `terminal.renderer`, `sidebar.sortMode`, `sidebar.showSubagents`, `sidebar.ignoreCodexSubagents`, `sidebar.width`, `panes.snapThreshold`, and `notifications.soundEnabled` are rejected with `400`.
- representative server-backed fields such as `defaultCwd`, `terminal.scrollback`, `logging.debug`, `sidebar.excludeFirstChatSubstrings`, `sidebar.excludeFirstChatMustStart`, `codingCli.providers.codex.cwd`, and `agentChat.defaultPlugins` still round-trip.
- `PATCH /api/settings` still accepts `defaultCwd: null` and normalizes it to `undefined`.
- loading a legacy `config.json` with moved local fields produces sanitized server settings plus a `legacyLocalSettingsSeed`.
- `patchSettings()` never writes local-only fields back into `config.json`.
- `server/settings-migrate.ts` no longer owns sort-mode migration; only still-valid server migrations remain there.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/integration/server/settings-api.test.ts test/integration/server/api-edge-cases.test.ts test/unit/server/config-store.test.ts test/unit/server/settings-migrate.test.ts
```

Expected: FAIL because the server still persists and validates the old mixed settings shape.

**Step 3: Write the minimal implementation**

Server implementation rules:

- `server/config-store.ts` should persist:

```ts
export type UserConfig = {
  version: 1
  settings: ServerSettings
  legacyLocalSettingsSeed?: LocalSettingsPatch
  sessionOverrides: ...
  terminalOverrides: ...
  projectColors: ...
  recentDirectories?: string[]
}
```

- On load, read the raw legacy config, extract moved local fields into `legacyLocalSettingsSeed`, strip them from `settings`, and normalize the remaining server settings.
- Keep `legacyLocalSettingsSeed` as migration metadata only. It is not part of `ServerSettings`, and `patchSettings()` must never merge incoming patches into it.
- `server/settings-router.ts` should delegate schema building to `shared/settings.ts` and keep exporting `SettingsPatchSchema` for existing imports.
- Remove sort-mode migration from server settings flow. Sort-mode normalization now belongs to local settings only.
- Delete `server/routes/settings.ts`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/integration/server/settings-api.test.ts test/integration/server/api-edge-cases.test.ts test/unit/server/config-store.test.ts test/unit/server/settings-migrate.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add server/config-store.ts \
  server/settings-router.ts \
  server/settings-migrate.ts \
  test/integration/server/settings-api.test.ts \
  test/integration/server/api-edge-cases.test.ts \
  test/unit/server/config-store.test.ts \
  test/unit/server/settings-migrate.test.ts \
  server/routes/settings.ts
git commit -m "refactor(settings): move server persistence to server-only contract"
```

### Task 3: Return only server settings from bootstrap and all server broadcasts

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `server/index.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `server/perf-router.ts`
- Modify: `server/network-router.ts`
- Modify: `server/network-manager.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/integration/server/bootstrap-router.test.ts`
- Modify: `test/server/perf-api.test.ts`
- Modify: `test/integration/server/network-api.test.ts`

**Step 1: Write the failing tests**

Add or update tests so they prove:

- `/api/bootstrap` returns `settings: ServerSettings` and optional `legacyLocalSettingsSeed`, not a mixed resolved settings object.
- bootstrap still respects the existing payload budget.
- `POST /api/perf` broadcasts a `settings.updated` message containing only server-backed settings.
- `POST /api/network/configure` does the same.
- the server runtime types used by `TerminalRegistry` and websocket settings snapshots are `ServerSettings`.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/integration/server/bootstrap-router.test.ts test/server/perf-api.test.ts test/integration/server/network-api.test.ts
```

Expected: FAIL because bootstrap and server broadcasters still use the mixed settings object.

**Step 3: Write the minimal implementation**

Implementation rules:

- Extend `BootstrapPayload` in `shared/read-models.ts` to:

```ts
export type BootstrapPayload = {
  settings: ServerSettings
  legacyLocalSettingsSeed?: LocalSettingsPatch
  platform: unknown
  shell: ...
  perf?: ...
  configFallback?: ...
}
```

- `createShellBootstrapRouter()` should accept a `getLegacyLocalSettingsSeed` dependency and include it only when defined.
- `server/index.ts`, `server/perf-router.ts`, `server/network-router.ts`, `server/network-manager.ts`, and `server/ws-handler.ts` must all broadcast or hand off `ServerSettings`.
- `server/terminal-registry.ts` must accept `ServerSettings` because it only needs server-owned fields such as `defaultCwd`, `scrollback`, and idle-kill settings.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/integration/server/bootstrap-router.test.ts test/server/perf-api.test.ts test/integration/server/network-api.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add shared/read-models.ts \
  server/index.ts \
  server/shell-bootstrap-router.ts \
  server/perf-router.ts \
  server/network-router.ts \
  server/network-manager.ts \
  server/ws-handler.ts \
  server/terminal-registry.ts \
  test/integration/server/bootstrap-router.test.ts \
  test/server/perf-api.test.ts \
  test/integration/server/network-api.test.ts
git commit -m "refactor(settings): send only server settings over server surfaces"
```

### Task 4: Build the unified browser-preference store and targeted legacy-key migration

**Files:**
- Create: `src/lib/browser-preferences.ts`
- Create: `test/unit/client/lib/browser-preferences.test.ts`
- Modify: `src/lib/terminal-fonts.ts`
- Modify: `src/store/storage-keys.ts`
- Modify: `src/store/storage-migration.ts`
- Modify: `test/unit/client/lib/terminal-fonts.test.ts`
- Modify: `test/unit/client/store/storage-migration.test.ts`

**Step 1: Write the failing tests**

Add a browser-preference unit suite that proves:

- the new storage key reads and writes a structured blob.
- malformed JSON falls back safely.
- legacy keys are imported exactly once:
  - `freshell.terminal.fontFamily.v1`
  - `freshell:toolStripExpanded`
- `tabs.searchRangeDays` is stored in the same blob.
- same-document subscribers are notified without dispatching a fake `StorageEvent`.
- cross-document `storage` events also notify subscribers.
- seeding from `legacyLocalSettingsSeed` fills only missing values and never overwrites an existing local value.

Extend `terminal-fonts` tests so they prove `terminal-fonts.ts` no longer owns localStorage persistence.
Extend the storage-migration test so a general storage-version bump preserves the browser-preference blob.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/browser-preferences.test.ts test/unit/client/lib/terminal-fonts.test.ts test/unit/client/store/storage-migration.test.ts
```

Expected: FAIL because the unified browser-preference module does not exist.

**Step 3: Write the minimal implementation**

Create `src/lib/browser-preferences.ts` with one versioned key and one subscription surface:

```ts
export const BROWSER_PREFERENCES_STORAGE_KEY = 'freshell.browser-preferences.v1'
export const BROWSER_PREFERENCES_EVENT = 'freshell.browser-preferences.changed'

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

- Use a `CustomEvent` for same-document notifications and listen to real `storage` events for cross-tab updates.
- Keep `terminal-fonts.ts` focused on font catalog and font-family resolution only.
- Add `BROWSER_PREFERENCES_STORAGE_KEY` to `src/store/storage-keys.ts`.
- Update `src/store/storage-migration.ts` so repo-wide storage-version wipes preserve `BROWSER_PREFERENCES_STORAGE_KEY`. Browser preferences are independently versioned and should not be lost because tabs or panes changed schema.
- Do not use the global wipe-based `storage-migration.ts` for this feature.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/browser-preferences.test.ts test/unit/client/lib/terminal-fonts.test.ts test/unit/client/store/storage-migration.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/browser-preferences.ts \
  test/unit/client/lib/browser-preferences.test.ts \
  src/lib/terminal-fonts.ts \
  src/store/storage-keys.ts \
  src/store/storage-migration.ts \
  test/unit/client/lib/terminal-fonts.test.ts \
  test/unit/client/store/storage-migration.test.ts
git commit -m "feat(settings): add unified browser preferences store"
```

### Task 5: Hydrate the client settings slice from server settings plus local preferences

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/settingsSlice.ts`
- Modify: `src/App.tsx`
- Modify: `test/unit/client/store/settingsSlice.test.ts`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/e2e/terminal-font-settings.test.tsx`
- Modify: `test/unit/client/components/settings-view-test-utils.tsx`

**Step 1: Write the failing tests**

Update the client state tests so they prove:

- `SettingsState` holds `serverSettings`, `localSettings`, and composed `settings`.
- the slice initializes `localSettings` from `browser-preferences.ts` synchronously.
- bootstrap composes resolved settings from `settings + localSettings`.
- bootstrap seeds missing local values from `legacyLocalSettingsSeed`.
- websocket `settings.updated` recomposes against the current local settings instead of clobbering them.
- a browser-preference change recomposes settings without refetching `/api/settings`.
- terminal font migration still works, but now through the general local-settings path rather than a font-family special case.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/settingsSlice.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: FAIL because the slice still stores only one mixed settings object and `App.tsx` still hard-codes `applyLocalTerminalFontFamily()`.

**Step 3: Write the minimal implementation**

Refactor the settings slice into this steady-state shape:

```ts
type SettingsState = {
  serverSettings: ServerSettings
  localSettings: LocalSettings
  settings: ResolvedSettings
  loaded: boolean
  lastSavedAt?: number
}
```

Add pure actions:

- `hydrateServerSettings(serverSettings)`
- `hydrateLocalSettings(localSettings)`
- `updateLocalSettings(localPatch)`
- `previewServerSettingsPatch(serverPatch)`
- `markSaved()`

Implementation rules:

- `src/store/types.ts` should stop owning duplicate settings definitions and instead re-export the shared settings types needed by the client.
- `src/store/settingsSlice.ts` should export `defaultSettings = composeResolvedSettings(defaultServerSettings, defaultLocalSettings)` to minimize UI churn.
- `App.tsx` should:
  - load browser preferences before applying bootstrap data
  - seed missing local values from `bootstrap.legacyLocalSettingsSeed`
  - dispatch `hydrateServerSettings()` for bootstrap and websocket updates
  - subscribe to browser-preference changes and dispatch `hydrateLocalSettings()`
  - delete the `applyLocalTerminalFontFamily()` special case entirely

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
git commit -m "refactor(settings): compose client settings from server and local state"
```

### Task 6: Split SettingsView, sidebar, and OSC52 writes by persistence layer

**Files:**
- Modify: `src/components/SettingsView.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/SettingsView.core.test.tsx`
- Modify: `test/unit/client/components/SettingsView.behavior.test.tsx`
- Modify: `test/unit/client/components/SettingsView.terminal-advanced.test.tsx`
- Modify: `test/unit/client/components/App.sidebar-resize.test.tsx`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
- Modify: `test/e2e/terminal-osc52-policy-flow.test.tsx`

**Step 1: Write the failing tests**

Rewrite the UI persistence tests so they assert:

- local controls update Redux and the browser-preference blob immediately, and never call `/api/settings`.
- server-backed controls optimistically preview the server patch, debounce `/api/settings`, and mark save time on success.
- sidebar width and collapsed state are local-only, including responsive/mobile auto-collapse.
- OSC52 policy is local-only in both SettingsView and TerminalView prompt flows.

Use this exact local-vs-server split in assertions:

- local controls:
  - `theme`
  - `uiScale`
- `terminal.fontSize`
- `terminal.fontFamily`
- `terminal.lineHeight`
  - `terminal.cursorBlink`
  - `terminal.theme`
  - `terminal.warnExternalLinks`
  - `terminal.osc52Clipboard`
  - `terminal.renderer`
  - `sidebar.sortMode`
  - `sidebar.showProjectBadges`
  - `sidebar.showSubagents`
  - `sidebar.ignoreCodexSubagents`
  - `sidebar.showNoninteractiveSessions`
  - `sidebar.hideEmptySessions`
  - `sidebar.width`
  - `sidebar.collapsed`
  - `panes.snapThreshold`
  - `panes.iconsOnTabs`
  - `panes.tabAttentionStyle`
  - `panes.attentionDismiss`
  - `notifications.soundEnabled`
- server-backed controls:
  - `defaultCwd`
  - `terminal.scrollback`
  - `logging.debug`
  - `safety.autoKillIdleMinutes`
  - `panes.defaultNewPane`
  - `sidebar.excludeFirstChatSubstrings`
  - `sidebar.excludeFirstChatMustStart`
  - `editor.*`
  - `codingCli.enabledProviders`

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/TerminalView.osc52.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: FAIL because the current UI still routes almost everything through one debounced server patch helper.

**Step 3: Write the minimal implementation**

Refactor `SettingsView.tsx` to use two explicit write helpers:

```ts
const applyLocalPreference = (patch: DeepPartial<LocalSettings>) => { ... }
const applyServerSetting = (patch: DeepPartial<ServerSettings>) => { ... }
```

Implementation rules:

- Local controls must call `updateLocalSettings()` and `patchBrowserPreferences({ settings: ... })` immediately.
- Server-backed controls must call `previewServerSettingsPatch()` and debounce only the `/api/settings` call.
- `App.tsx` sidebar resize/collapse handlers must stop PATCHing `/api/settings`.
- `TerminalView.tsx` `persistOsc52Policy()` must stop PATCHing `/api/settings`.
- No code path may submit a mixed `sidebar` object to the server anymore.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/TerminalView.osc52.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/SettingsView.tsx \
  src/App.tsx \
  src/components/TerminalView.tsx \
  test/unit/client/components/SettingsView.core.test.tsx \
  test/unit/client/components/SettingsView.behavior.test.tsx \
  test/unit/client/components/SettingsView.terminal-advanced.test.tsx \
  test/unit/client/components/App.sidebar-resize.test.tsx \
  test/unit/client/components/TerminalView.osc52.test.tsx \
  test/e2e/terminal-osc52-policy-flow.test.tsx
git commit -m "fix(settings): split local and server settings writes in the UI"
```

### Task 7: Fix the remaining server-backed writers outside SettingsView

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`

**Step 1: Write the failing tests**

Add or update tests so they prove:

- `PaneContainer` still saves coding-CLI provider `cwd` as a server-backed setting, but now uses the server-preview path instead of `updateSettingsLocal()` with the mixed settings model.
- `AgentChatView` still saves:
  - `agentChat.providers.<provider>.defaultModel`
  - `agentChat.providers.<provider>.defaultPermissionMode`
  - `agentChat.providers.<provider>.defaultEffort`
  - `agentChat.initialSetupDone`
- those writes remain server-backed and keep optimistic UI behavior.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
```

Expected: FAIL because those components still rely on the old mixed settings actions.

**Step 3: Write the minimal implementation**

Implementation rules:

- `PaneContainer.tsx` should replace `updateSettingsLocal(patch)` with `previewServerSettingsPatch(patch)` before PATCHing `/api/settings`.
- `AgentChatView.tsx` should do the same for agent-chat provider defaults and `initialSetupDone`.
- Keep `settings.agentChat.defaultPlugins` flowing through resolved settings for pane creation. This task is about the write paths that the current plan previously missed.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/panes/PaneContainer.tsx \
  src/components/agent-chat/AgentChatView.tsx \
  test/unit/client/components/panes/PaneContainer.test.tsx \
  test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
git commit -m "fix(settings): keep non-SettingsView server writers working"
```

### Task 8: Move ToolStrip state and tab search range into the unified browser-preference store

**Files:**
- Modify: `src/components/agent-chat/ToolStrip.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `test/unit/client/components/agent-chat/ToolStrip.test.tsx`
- Modify: `test/unit/client/components/agent-chat/MessageBubble.test.tsx`
- Modify: `test/e2e/tabs-view-search-range.test.tsx`
- Modify: `test/e2e/agent-chat-context-menu-flow.test.tsx`
- Modify: `test/e2e/agent-chat-polish-flow.test.tsx`

**Step 1: Write the failing tests**

Update the tests so they assert:

- ToolStrip reads and writes its expanded state through `browser-preferences.ts`, not the legacy `freshell:toolStripExpanded` key.
- `searchRangeDays` initializes from browser preferences, persists on change, and survives rerender/reload.
- tests that hard-code the legacy tool-strip key fail until the new helper is in place.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/e2e/tabs-view-search-range.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: FAIL because ToolStrip still uses the legacy key and `searchRangeDays` still resets on reload.

**Step 3: Write the minimal implementation**

Implementation rules:

- `ToolStrip.tsx` should use:

```ts
const expanded = useSyncExternalStore(
  subscribeBrowserPreferences,
  getToolStripExpandedPreference,
  () => false,
)
```

- `tabRegistrySlice.ts` should initialize `searchRangeDays` from `getSearchRangeDaysPreference()`.
- `TabsView.tsx` should persist range changes through `setSearchRangeDaysPreference()`.
- Keep `searchRangeDays` in Redux because `tabRegistrySync.ts` depends on it for outbound websocket queries.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/e2e/tabs-view-search-range.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/agent-chat/ToolStrip.tsx \
  src/components/TabsView.tsx \
  src/store/tabRegistrySlice.ts \
  test/unit/client/components/agent-chat/ToolStrip.test.tsx \
  test/unit/client/components/agent-chat/MessageBubble.test.tsx \
  test/e2e/tabs-view-search-range.test.tsx \
  test/e2e/agent-chat-context-menu-flow.test.tsx \
  test/e2e/agent-chat-polish-flow.test.tsx
git commit -m "fix(local-prefs): move tool strip and tabs range into browser preferences"
```

### Task 9: Prove the cross-surface behavior and run the final verification gate

**Files:**
- Create: `test/e2e-browser/specs/settings-persistence-split.spec.ts`
- Modify: `test/e2e-browser/specs/multi-client.spec.ts`

**Step 1: Write the failing tests**

Add one dedicated Playwright spec that uses two browser contexts against the same isolated server and proves:

- Context A writes a local-only preference and reloads; the value persists in A.
- Context B starts clean against the same server; it does not inherit A’s local-only preference.
- Context A writes a server-backed setting through `/api/settings`.
- Context B reloads and does inherit the server-backed value.
- the isolated server `config.json` on disk never contains the local-only preference.

Update `multi-client.spec.ts` so its existing settings-broadcast proof uses a still-server-backed field such as `defaultCwd`, not a now-local field such as `terminal.fontSize`.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:e2e -- test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
```

Expected: FAIL because the browser-vs-server scoping is not fully implemented yet.

**Step 3: Write the minimal implementation**

Implementation rules:

- Use direct `page.evaluate()` access to the browser-preference blob for the local-only proof. This spec is about persistence scoping, not about re-testing SettingsView controls already covered in Vitest.
- Use `/api/settings` for the server-backed proof.
- Read the isolated server config file from the test process to prove local-only fields never hit disk.
- Do not add screenshots for this task.

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

Do not update `docs/index.html` for this work. The UI surface is materially the same; the change is persistence behavior and architecture.

**Step 5: Commit**

```bash
git add test/e2e-browser/specs/settings-persistence-split.spec.ts \
  test/e2e-browser/specs/multi-client.spec.ts
git commit -m "test(settings): prove local and server persistence semantics"
```
