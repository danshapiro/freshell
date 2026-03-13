# Settings Persistence Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Split Freshell settings into a real server-backed contract and a real browser-local contract, move the approved sidebar/debugging/display controls to browser storage, keep the approved workflow controls on the server, and migrate existing mixed settings without restoring cross-surface sync for local-only preferences.

**Architecture:** Put the settings contract in `shared/settings.ts`, with separate `ServerSettings`, `LocalSettings`, and `ResolvedSettings` types plus shared normalization and merge helpers. Persist only `ServerSettings` in `config.json`, persist only browser-local preferences in a versioned browser blob owned by `src/lib/browser-preferences.ts`, and keep the migration bridge as bootstrap-only `legacyLocalSettingsSeed` metadata outside the live server settings contract. On the client, hydrate local preferences synchronously in the settings slice initial state, update server-backed settings through one thunked save path, and keep resolved settings as the single shape components read; `src/lib/terminal-fonts.ts` ends as pure font-stack helpers only, not a persistence layer.

**Tech Stack:** TypeScript, Zod, Express, React 18, Redux Toolkit, Vitest, Testing Library, Playwright

---

## Strategy Gate

- The real problem is not a missing field in one schema. The real problem is that the app has no hard persistence boundary, so device-local display/debug settings leak into the server contract and server-backed workflow settings drift out of it.
- The direct fix is a hard split now, not another mixed shape with more exceptions:
  - `shared/settings.ts` owns settings types, defaults, validation, normalization, merge helpers, and migration extraction.
  - `server/config-store.ts` persists only `ServerSettings` plus top-level migration metadata.
  - `src/lib/browser-preferences.ts` persists only browser-local data.
  - Components stop calling `/api/settings` for local-only changes.
  - Components stop writing ad hoc `localStorage` keys for settings.
- Keep the migration bridge durable but narrow:
  - `legacyLocalSettingsSeed` lives at the top level of `config.json`, outside `settings`.
  - `/api/bootstrap` may return it.
  - `/api/settings` and `settings.updated` must never return it.
  - The client uses it only when the browser-local settings blob has no settings payload yet.
- Preserve current shipped behavior where the user did not ask for a behavior change:
  - `sidebar.sortMode` becomes local, but its default must be `activity`, because that is the current runtime default users actually receive from the server today.
  - Do not accidentally switch fresh browsers to `recency-pinned`.
- Keep `sidebar.excludeFirstChatSubstrings` and `sidebar.excludeFirstChatMustStart` server-backed together. The user explicitly approved the assumption that this exclusion rule remains replicated; the toggle is not useful without the list it qualifies.
- Do not keep temporary compatibility shims such as “mixed settings on the wire, then overlay forever.” The only allowed transitional mechanism is the bootstrap-only migration seed.
- Do not widen this task into unrelated config cleanup. `allowedFilePaths`, `codingCli.knownProviders`, and `network.configured` remain server-backed and working.

## Key Design Decisions

- `shared/settings.ts` should export pure structural defaults. Environment-specific defaults, specifically `logging.debug`, must be injected by callers instead of baking server or client environment logic into the shared module.
- The client settings slice should hydrate browser-local settings synchronously from localStorage during module initialization. This repo already hydrates other browser-local state synchronously in slice initial state; doing local settings later in `App.tsx` would create unnecessary first-render drift.
- Server-backed writes should go through one thunked save path, not repeated `api.patch('/api/settings')` calls spread across components. This makes the server/local split explicit in code and tests.
- The Redux slice may keep a denormalized `settings` read model for compatibility with the existing tree, but it must always be recomputed from `serverSettings` plus `localSettings`, and it must never be persisted or patched directly.
- `defaultSettings` should continue to exist in `src/store/settingsSlice.ts`, but as resolved settings built from shared defaults. That keeps the broad test suite stable while still removing the mixed persistence model.
- `src/lib/terminal-fonts.ts` should end this refactor with only font normalization / fallback helpers such as `resolveTerminalFontFamily()`. All browser storage reads, writes, migrations, and seed application for terminal font preferences belong in `src/lib/browser-preferences.ts`; do not keep `loadLocalTerminalFontFamily()`, `saveLocalTerminalFontFamily()`, or `applyLocalTerminalFontFamily()` as compatibility APIs.
- Any new relative imports used by server or shared code must include `.js` extensions for NodeNext/ESM compatibility.

## Persistence Classification

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

**Browser-local non-settings in the same blob**

- `toolStripExpanded`
- `tabs.searchRangeDays`

## Execution Rules

- Execute red, then green, then refactor. Do not skip the failing test.
- Land the final architecture directly. Do not add an interim mixed model “until later.”
- Keep `defaultSettings` exported from `src/store/settingsSlice.ts` as resolved settings to minimize unrelated churn.
- Keep each task small enough that the executing agent can finish it without inventing missing architecture.
- Before the final broad run, check `npm run test:status`. If another holder owns the coordinated run, wait.
- Commit after every task with the message listed in that task.

### Task 1: Create the shared settings contract

**Files:**
- Create: `shared/settings.ts`
- Create: `test/unit/shared/settings.test.ts`
- Modify: `test/integration/activity-sort.test.tsx`

**Step 1: Write the failing tests**

Add a pure unit suite that proves:

- `buildServerSettingsPatchSchema()` accepts representative server-backed fields such as `defaultCwd`, `terminal.scrollback`, and `agentChat.defaultPlugins`.
- `buildServerSettingsPatchSchema()` rejects representative local-only fields such as `theme`, `terminal.fontSize`, `sidebar.sortMode`, `sidebar.showSubagents`, `sidebar.ignoreCodexSubagents`, and `terminal.osc52Clipboard`.
- `resolveLocalSettings(undefined)` defaults `sidebar.sortMode` to `'activity'`.
- `resolveLocalSettings({ sidebar: { sortMode: 'hybrid' } })` migrates to `'activity'`.
- `composeResolvedSettings(server, local)` adds local-only fields such as `terminal.fontFamily` on top of server settings.
- `extractLegacyLocalSettingsSeed(rawMixedSettings)` returns only moved local fields.
- `stripLocalSettings(rawMixedSettings)` removes moved local fields but preserves server-backed fields such as `agentChat.defaultPlugins` and `sidebar.excludeFirstChatMustStart`.

Replace the old integration test that asserts sort-mode migration inside the client slice. That migration belongs in the shared local-settings resolver now.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/integration/activity-sort.test.tsx
```

Expected: FAIL because `shared/settings.ts` does not exist and sort-mode migration is still owned by the wrong layer.

**Step 3: Write the minimal implementation**

Create `shared/settings.ts` with the shared contract:

```ts
export type ServerSettings
export type ServerSettingsPatch
export type LocalSettings
export type LocalSettingsPatch
export type ResolvedSettings

export function createDefaultServerSettings(options?: { loggingDebug?: boolean }): ServerSettings
export const defaultLocalSettings: LocalSettings
export function createDefaultResolvedSettings(options?: { loggingDebug?: boolean }): ResolvedSettings

export function buildServerSettingsSchema(validCliProviders?: readonly string[])
export function buildServerSettingsPatchSchema(validCliProviders?: readonly string[])
export function mergeServerSettings(base: ServerSettings, patch: ServerSettingsPatch): ServerSettings
export function resolveLocalSettings(patch?: LocalSettingsPatch): LocalSettings
export function mergeLocalSettings(base: LocalSettingsPatch | undefined, patch: LocalSettingsPatch): LocalSettingsPatch
export function composeResolvedSettings(server: ServerSettings, local: LocalSettings): ResolvedSettings
export function extractLegacyLocalSettingsSeed(raw: Record<string, unknown> | null | undefined): LocalSettingsPatch | undefined
export function stripLocalSettings(raw: Record<string, unknown> | null | undefined): Record<string, unknown>
```

Implementation rules:

- `defaultLocalSettings.sidebar.sortMode` must be `'activity'`.
- `ServerSettings` includes `agentChat.defaultPlugins`.
- `ServerSettings` does not include `terminal.fontFamily`, `sidebar.sortMode`, or `sidebar.ignoreCodexSubagents`.
- Shared code must not import from `src/` or `server/`.
- Any new relative imports in `shared/` must use `.js` extensions.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/integration/activity-sort.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add shared/settings.ts test/unit/shared/settings.test.ts test/integration/activity-sort.test.tsx
git commit -m "refactor(settings): add shared server and local settings contract"
```

### Task 2: Keep server migrations server-owned only

**Files:**
- Modify: `server/settings-migrate.ts`
- Modify: `test/unit/server/settings-migrate.test.ts`

**Step 1: Write the failing tests**

Update the migration tests so they prove:

- server migration no longer rewrites `sidebar.sortMode`
- server migration still upgrades legacy default enabled providers correctly
- migration helpers stay pure and do not mutate their inputs

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/settings-migrate.test.ts
```

Expected: FAIL because server migration still owns sort-mode cleanup.

**Step 3: Write the minimal implementation**

Refactor `server/settings-migrate.ts` so it only owns migrations that still belong to server-backed settings. Remove sort-mode migration from server code paths entirely; local sort-mode normalization now lives in `resolveLocalSettings()`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/server/settings-migrate.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add server/settings-migrate.ts test/unit/server/settings-migrate.test.ts
git commit -m "refactor(settings): keep server migrations server-owned"
```

### Task 3: Persist only server settings in the config store

**Files:**
- Modify: `server/config-store.ts`
- Modify: `test/unit/server/config-store.test.ts`

**Step 1: Write the failing tests**

Update the config-store tests so they prove:

- loading a legacy mixed `config.json` returns sanitized `ServerSettings`
- loading the same file produces top-level `legacyLocalSettingsSeed`
- the seed is stored outside `settings`
- saving server-backed changes preserves the seed but does not reintroduce moved local fields
- `agentChat.defaultPlugins` survives load and patch

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/config-store.test.ts
```

Expected: FAIL because `ConfigStore` still reads and writes the mixed settings object.

**Step 3: Write the minimal implementation**

Refactor `server/config-store.ts` so `UserConfig` becomes:

```ts
type UserConfig = {
  version: 1
  settings: ServerSettings
  legacyLocalSettingsSeed?: LocalSettingsPatch
  sessionOverrides: ...
  terminalOverrides: ...
  projectColors: ...
  recentDirectories?: string[]
}
```

Implementation rules:

- Capture the raw legacy `settings` object before normalization.
- Build live settings with `mergeServerSettings(createDefaultServerSettings({ loggingDebug: resolveDefaultLoggingDebug(process.env) }), stripLocalSettings(rawSettings))`.
- If the file already has `legacyLocalSettingsSeed`, keep it.
- If the file does not have it, derive it once from the raw mixed settings and persist it at top level.
- Re-export `defaultSettings` from `config-store.ts` as server defaults for compatibility with existing server tests.
- Expose a read-only accessor for the seed so bootstrap can return it without a one-shot consume API.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/server/config-store.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add server/config-store.ts test/unit/server/config-store.test.ts
git commit -m "refactor(settings): persist server settings and migration seed"
```

### Task 4: Enforce the server-only `/api/settings` contract

**Files:**
- Modify: `server/settings-router.ts`
- Delete: `server/routes/settings.ts`
- Modify: `test/integration/server/settings-api.test.ts`
- Modify: `test/integration/server/api-edge-cases.test.ts`
- Modify: `test/unit/server/editor-settings.test.ts`

**Step 1: Write the failing tests**

Update the settings API tests so they assert:

- `GET /api/settings` returns only `ServerSettings`
- `PATCH /api/settings` rejects representative local-only fields with `400`
- `PATCH /api/settings` still accepts `defaultCwd: null` and clears it
- `PATCH /api/settings` still round-trips `terminal.scrollback`, `sidebar.excludeFirstChatSubstrings`, `sidebar.excludeFirstChatMustStart`, `codingCli.providers.codex.cwd`, and `agentChat.defaultPlugins`

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/integration/server/settings-api.test.ts test/integration/server/api-edge-cases.test.ts test/unit/server/editor-settings.test.ts
```

Expected: FAIL because the router still validates the mixed schema.

**Step 3: Write the minimal implementation**

Move the authoritative patch schema to `shared/settings.ts` and make `server/settings-router.ts` consume it.

Implementation rules:

- Keep `SettingsPatchSchema` exported from `server/settings-router.ts` if tests import that name, but make it a thin shared re-export.
- Preserve the current `defaultCwd: null | '' -> undefined` clear behavior.
- Remove all local-only nested fields from the server schema, including `sidebar.sortMode`, `sidebar.showSubagents`, `sidebar.hideEmptySessions`, `sidebar.width`, and `sidebar.ignoreCodexSubagents`.
- Delete the dead duplicate router in `server/routes/settings.ts`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/integration/server/settings-api.test.ts test/integration/server/api-edge-cases.test.ts test/unit/server/editor-settings.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add server/settings-router.ts server/routes/settings.ts test/integration/server/settings-api.test.ts test/integration/server/api-edge-cases.test.ts test/unit/server/editor-settings.test.ts
git commit -m "refactor(settings): enforce server-only settings api contract"
```

### Task 5: Type bootstrap as server settings plus migration seed

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `server/index.ts`
- Modify: `test/integration/server/bootstrap-router.test.ts`

**Step 1: Write the failing tests**

Update the bootstrap tests so they prove:

- `/api/bootstrap` returns `settings: ServerSettings`
- `/api/bootstrap` may return `legacyLocalSettingsSeed`
- the payload still stays under `MAX_BOOTSTRAP_PAYLOAD_BYTES`

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/integration/server/bootstrap-router.test.ts
```

Expected: FAIL because bootstrap still uses the mixed settings shape.

**Step 3: Write the minimal implementation**

Update the bootstrap contract:

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

Implementation rules:

- `createShellBootstrapRouter()` should accept both `getSettings()` and `getLegacyLocalSettingsSeed()`.
- `/api/bootstrap` is the only route allowed to return the migration seed.
- Keep payload budget assertions intact.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/integration/server/bootstrap-router.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add shared/read-models.ts server/shell-bootstrap-router.ts server/index.ts test/integration/server/bootstrap-router.test.ts
git commit -m "refactor(settings): make bootstrap server-only with migration seed"
```

### Task 6: Type websocket and server consumers as server-only

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `server/perf-router.ts`
- Modify: `server/network-router.ts`
- Modify: `server/network-manager.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/integration/server/network-api.test.ts`
- Modify: `test/server/perf-api.test.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/unit/server/terminal-lifecycle.test.ts`

**Step 1: Write the failing tests**

Update the websocket and server-consumer tests so they prove:

- `settings.updated` websocket messages contain only `ServerSettings`
- `legacyLocalSettingsSeed` never appears in websocket snapshots or broadcasts
- `TerminalRegistry` depends only on server-backed fields

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/integration/server/network-api.test.ts test/server/perf-api.test.ts test/server/ws-handshake-snapshot.test.ts test/unit/server/terminal-lifecycle.test.ts
```

Expected: FAIL because websocket messages and server consumers still use the mixed settings type.

**Step 3: Write the minimal implementation**

Implementation rules:

- `SettingsUpdatedMessage` in `shared/ws-protocol.ts` must expose `ServerSettings`, not `unknown`.
- `settings.updated` broadcasts from settings, perf, and network routes must never include local-only fields or migration metadata.
- `server/terminal-registry.ts` should stop importing the old mixed `AppSettings` type from `config-store.ts`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/integration/server/network-api.test.ts test/server/perf-api.test.ts test/server/ws-handshake-snapshot.test.ts test/unit/server/terminal-lifecycle.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add shared/ws-protocol.ts server/perf-router.ts server/network-router.ts server/network-manager.ts server/ws-handler.ts server/terminal-registry.ts test/integration/server/network-api.test.ts test/server/perf-api.test.ts test/server/ws-handshake-snapshot.test.ts test/unit/server/terminal-lifecycle.test.ts
git commit -m "refactor(settings): make websocket settings server-only"
```

### Task 7: Build the browser-preferences codec and migrate legacy local keys

**Files:**
- Create: `src/lib/browser-preferences.ts`
- Create: `test/unit/client/lib/browser-preferences.test.ts`
- Modify: `src/lib/terminal-fonts.ts`
- Modify: `src/store/storage-keys.ts`
- Modify: `src/store/storage-migration.ts`
- Modify: `test/unit/client/lib/terminal-fonts.test.ts`
- Modify: `test/unit/client/store/storage-migration.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- browser preferences load from one versioned blob as a sparse record
- legacy keys `freshell.terminal.fontFamily.v1` and `freshell:toolStripExpanded` migrate into the new blob once
- `seedBrowserPreferencesSettingsIfEmpty(seed)` fills only missing settings
- `getToolStripExpandedPreference()` and `getSearchRangeDaysPreference()` read from the new blob
- storage migration preserves auth and the new browser-preferences blob when clearing old `freshell.` keys
- `src/lib/terminal-fonts.ts` keeps only font-stack resolution helpers and no longer exports browser-storage helpers

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/browser-preferences.test.ts test/unit/client/lib/terminal-fonts.test.ts test/unit/client/store/storage-migration.test.ts
```

Expected: FAIL because the browser-preferences module does not exist and storage migration does not know about the new blob.

**Step 3: Write the minimal implementation**

Create `src/lib/browser-preferences.ts`:

```ts
export const BROWSER_PREFERENCES_STORAGE_KEY = 'freshell.browser-preferences.v1'

export type BrowserPreferencesRecord = {
  settings?: LocalSettingsPatch
  toolStrip?: { expanded?: boolean }
  tabs?: { searchRangeDays?: number }
}

export function loadBrowserPreferencesRecord(): BrowserPreferencesRecord
export function parseBrowserPreferencesRaw(raw: string): BrowserPreferencesRecord | null
export function patchBrowserPreferencesRecord(patch: BrowserPreferencesRecord): BrowserPreferencesRecord
export function seedBrowserPreferencesSettingsIfEmpty(seed: LocalSettingsPatch): BrowserPreferencesRecord
export function resolveBrowserPreferenceSettings(record?: BrowserPreferencesRecord): LocalSettings
export function getToolStripExpandedPreference(): boolean
export function setToolStripExpandedPreference(expanded: boolean): void
export function getSearchRangeDaysPreference(): number
export function subscribeToolStripPreference(listener: () => void): () => void
```

Implementation rules:

- Store only sparse settings patches in the blob.
- Migrate legacy font and tool-strip keys inside this module, not inside components.
- Reduce `terminal-fonts.ts` to pure font-stack helpers; remove browser storage reads/writes and move those responsibilities entirely into `browser-preferences.ts`.
- Do not bump `STORAGE_VERSION` for this task.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/browser-preferences.test.ts test/unit/client/lib/terminal-fonts.test.ts test/unit/client/store/storage-migration.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/browser-preferences.ts test/unit/client/lib/browser-preferences.test.ts src/lib/terminal-fonts.ts src/store/storage-keys.ts src/store/storage-migration.ts test/unit/client/lib/terminal-fonts.test.ts test/unit/client/store/storage-migration.test.ts
git commit -m "feat(local-prefs): add browser preferences codec and key migration"
```

### Task 8: Split the client settings slice by persistence layer

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/settingsSlice.ts`
- Modify: `test/unit/client/store/settingsSlice.test.ts`
- Modify: `test/unit/client/store/state-edge-cases.test.ts`

**Step 1: Write the failing tests**

Update the slice tests so they prove:

- the slice stores `serverSettings`, `localSettings`, and resolved `settings`
- initial local settings are loaded synchronously from `browser-preferences.ts`
- `defaultSettings` remains exported as resolved settings
- `previewServerSettingsPatch` only applies to server-backed fields
- `updateSettingsLocal` only applies to local fields

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/settingsSlice.test.ts test/unit/client/store/state-edge-cases.test.ts
```

Expected: FAIL because the slice still stores one mixed object.

**Step 3: Write the minimal implementation**

Refactor the slice to this shape:

```ts
type SettingsState = {
  serverSettings: ServerSettings
  localSettings: LocalSettings
  settings: ResolvedSettings
  loaded: boolean
  lastSavedAt?: number
}
```

Add actions:

```ts
setServerSettings(server: ServerSettings)
setLocalSettings(local: LocalSettings)
updateSettingsLocal(patch: LocalSettingsPatch)
previewServerSettingsPatch(patch: ServerSettingsPatch)
markSaved()
```

Implementation rules:

- `src/store/types.ts` should stop hand-writing the settings contract and instead re-export settings types from `@shared/settings`.
- Keep `mergeSettings()` exported as a resolved-settings helper for existing tests and utilities.
- `defaultSettings` should be `createDefaultResolvedSettings({ loggingDebug: import.meta.env.DEV })`.
- Remove the ambiguous client action name `setSettings`; use `setServerSettings` instead.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/store/settingsSlice.test.ts test/unit/client/store/state-edge-cases.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/store/types.ts src/store/settingsSlice.ts test/unit/client/store/settingsSlice.test.ts test/unit/client/store/state-edge-cases.test.ts
git commit -m "refactor(settings): split client settings state by persistence layer"
```

### Task 9: Create one server-backed settings save path

**Files:**
- Create: `src/store/settingsThunks.ts`
- Create: `test/unit/client/store/settingsThunks.test.ts`

**Step 1: Write the failing tests**

Add thunk tests that prove:

- `saveServerSettingsPatch(patch)` dispatches `previewServerSettingsPatch(patch)` before the API request
- it PATCHes `/api/settings` with only the provided server-backed patch
- it dispatches `markSaved()` on success
- it preserves the current clear behavior for `defaultCwd` by sending `''` when clearing

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/settingsThunks.test.ts
```

Expected: FAIL because there is no shared server settings save path.

**Step 3: Write the minimal implementation**

Create `src/store/settingsThunks.ts`:

```ts
export const saveServerSettingsPatch = createAsyncThunk(
  'settings/saveServerSettingsPatch',
  async (patch: ServerSettingsPatch, { dispatch }) => {
    dispatch(previewServerSettingsPatch(patch))
    await api.patch('/api/settings', normalizeServerSettingsPatchForApi(patch))
    dispatch(markSaved())
  },
)
```

Implementation rules:

- Do not add rollback behavior in this task; preserve current optimistic semantics.
- Keep the `defaultCwd` clear normalization in one place, not repeated in components.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/store/settingsThunks.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/store/settingsThunks.ts test/unit/client/store/settingsThunks.test.ts
git commit -m "feat(settings): add shared server settings save thunk"
```

### Task 10: Persist browser preferences through middleware and sync them across tabs

**Files:**
- Create: `src/store/browserPreferencesPersistence.ts`
- Create: `test/unit/client/store/browserPreferencesPersistence.test.ts`
- Modify: `src/store/store.ts`
- Modify: `src/store/crossTabSync.ts`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `test/unit/client/store/crossTabSync.test.ts`
- Modify: `test/unit/client/store/tabRegistrySlice.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- the middleware persists `settings/updateSettingsLocal`, `settings/setLocalSettings`, and `tabRegistry/setTabRegistrySearchRangeDays`
- writes are debounced and flushed on `pagehide`
- cross-tab sync hydrates browser-preference changes from storage and `BroadcastChannel`
- `searchRangeDays` initializes from browser preferences instead of resetting to `30` on every reload

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/tabRegistrySlice.test.ts
```

Expected: FAIL because the middleware does not exist and cross-tab sync ignores browser preferences.

**Step 3: Write the minimal implementation**

Create a dedicated Redux middleware for browser-local persistence.

Implementation rules:

- Reuse the debounce and `pagehide` flush pattern from `persistMiddleware.ts`.
- Persist the raw browser-preferences blob and broadcast it with `broadcastPersistedRaw(...)`.
- Extend `crossTabSync.ts` to route incoming browser-preferences raw to the settings slice and `tabRegistrySlice`.
- `tabRegistrySlice` should initialize `searchRangeDays` from `getSearchRangeDaysPreference()`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/tabRegistrySlice.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/store/browserPreferencesPersistence.ts src/store/store.ts src/store/crossTabSync.ts src/store/tabRegistrySlice.ts test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/tabRegistrySlice.test.ts
git commit -m "feat(local-prefs): persist and sync browser preferences"
```

### Task 11: Hydrate bootstrap and websocket settings without clobbering local preferences

**Files:**
- Modify: `src/App.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/e2e/terminal-font-settings.test.tsx`

**Step 1: Write the failing tests**

Update the hydration tests so they prove:

- bootstrap applies `setServerSettings(bootstrap.settings)` and recomposes against already-loaded local settings
- `legacyLocalSettingsSeed` is written into browser preferences only when the local settings blob has no settings payload
- existing browser-local values beat the migration seed
- `settings.updated` only replaces server settings and does not overwrite browser-local settings

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: FAIL because `App.tsx` still overlays terminal font locally and still assumes bootstrap returns mixed settings.

**Step 3: Write the minimal implementation**

Implementation rules:

- Delete the last `applyLocalTerminalFontFamily()` call sites; bootstrap and websocket hydration should recompose resolved settings from server plus browser-local state instead of using a mixed helper.
- When bootstrap includes `legacyLocalSettingsSeed`, call `seedBrowserPreferencesSettingsIfEmpty(...)`, then dispatch `setLocalSettings(...)` only if the seed actually changed the browser-preferences record.
- `settings.updated` should dispatch `setServerSettings(msg.settings)`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx test/e2e/terminal-font-settings.test.tsx
git commit -m "refactor(settings): hydrate server settings without clobbering local prefs"
```

### Task 12: Route local-only SettingsView controls to browser preferences

**Files:**
- Modify: `src/components/SettingsView.tsx`
- Modify: `test/unit/client/components/SettingsView.core.test.tsx`
- Modify: `test/unit/client/components/SettingsView.behavior.test.tsx`
- Modify: `test/unit/client/components/SettingsView.terminal-advanced.test.tsx`
- Modify: `test/unit/client/components/SettingsView.panes.test.tsx`

**Step 1: Write the failing tests**

Rewrite the local-control tests so they assert:

- local controls dispatch `updateSettingsLocal(...)`
- local controls do not dispatch `saveServerSettingsPatch(...)`
- local controls cover `theme`, `uiScale`, local terminal display settings, local pane display settings, local sidebar sorting/filtering/visibility settings, and `notifications.soundEnabled`

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/SettingsView.panes.test.tsx
```

Expected: FAIL because `SettingsView` still routes many local-only controls through the server save path.

**Step 3: Write the minimal implementation**

Refactor `SettingsView.tsx` to use:

```ts
const applyLocalSetting = (patch: LocalSettingsPatch) => {
  dispatch(updateSettingsLocal(patch))
}
```

Implementation rules:

- Local-only controls must not call `patchBrowserPreferencesRecord()` directly.
- Local-only controls must not schedule `/api/settings` writes.
- Keep `sidebar.sortMode` default and fallback handling consistent with `'activity'`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/SettingsView.panes.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/SettingsView.tsx test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/SettingsView.panes.test.tsx
git commit -m "fix(settings): route local settings view controls to browser prefs"
```

### Task 13: Route server-backed SettingsView controls through the shared save thunk

**Files:**
- Modify: `src/components/SettingsView.tsx`
- Modify: `test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx`
- Modify: `test/unit/client/components/SettingsView.editor.test.tsx`
- Modify: `test/unit/client/components/SettingsView.network-access.test.tsx`

**Step 1: Write the failing tests**

Rewrite the server-control tests so they assert:

- server-backed controls dispatch `saveServerSettingsPatch(...)`
- server-backed controls remain optimistic in Redux through `previewServerSettingsPatch(...)`
- server-backed controls include `defaultCwd`, `terminal.scrollback`, `logging.debug`, `safety.autoKillIdleMinutes`, `panes.defaultNewPane`, `sidebar.excludeFirstChatSubstrings`, `sidebar.excludeFirstChatMustStart`, `codingCli.*`, `editor.*`, and `network.*`

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx test/unit/client/components/SettingsView.editor.test.tsx test/unit/client/components/SettingsView.network-access.test.tsx
```

Expected: FAIL because the component still assumes a single mixed optimistic update path.

**Step 3: Write the minimal implementation**

Refactor `SettingsView.tsx` to use:

```ts
const applyServerSetting = (patch: ServerSettingsPatch) => {
  void dispatch(saveServerSettingsPatch(patch))
}
```

Implementation rules:

- Preserve the current validation-before-save flows for `defaultCwd` and coding-CLI provider `cwd`.
- Keep `sidebar.excludeFirstChatSubstrings` and `sidebar.excludeFirstChatMustStart` on the same server-backed path.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx test/unit/client/components/SettingsView.editor.test.tsx test/unit/client/components/SettingsView.network-access.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/SettingsView.tsx test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx test/unit/client/components/SettingsView.editor.test.tsx test/unit/client/components/SettingsView.network-access.test.tsx
git commit -m "fix(settings): route server settings view controls through thunk"
```

### Task 14: Make sidebar geometry and local filter defaults truly browser-local

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `test/unit/client/components/App.sidebar-resize.test.tsx`
- Modify: `test/unit/client/components/App.mobile.test.tsx`
- Modify: `test/unit/client/components/App.mobile-landscape.test.tsx`
- Modify: `test/e2e/mobile-sidebar-fullwidth-flow.test.tsx`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`

**Step 1: Write the failing tests**

Update the sidebar tests so they prove:

- sidebar width and collapsed state never dispatch `saveServerSettingsPatch(...)`
- mobile auto-collapse still works through local settings only
- sidebar selector fallbacks default `sortMode` to `'activity'`
- no code path submits the full `sidebar` object to the server anymore

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts
```

Expected: FAIL because `App.tsx` still saves sidebar geometry through `/api/settings` and selector fallbacks still assume the wrong default.

**Step 3: Write the minimal implementation**

Implementation rules:

- `App.tsx` sidebar resize and collapse handlers should dispatch `updateSettingsLocal({ sidebar: ... })` only.
- `sidebarSelectors.ts` fallback logic should use `'activity'`, not `'recency-pinned'`.
- Preserve current mobile haptics and auto-collapse behavior.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/App.tsx src/store/selectors/sidebarSelectors.ts test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts
git commit -m "fix(local-prefs): keep sidebar geometry and filters browser-local"
```

### Task 15: Make OSC52 policy truly browser-local

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
- Modify: `test/e2e/terminal-osc52-policy-flow.test.tsx`

**Step 1: Write the failing tests**

Update the OSC52 tests so they prove:

- OSC52 policy changes stay in local settings only
- `TerminalView` no longer dispatches `saveServerSettingsPatch(...)` or calls `/api/settings` for OSC52
- the SettingsView local-control coverage and TerminalView prompt flow agree on the same local-only behavior

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.osc52.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: FAIL because `TerminalView.tsx` still saves OSC52 policy through the server.

**Step 3: Write the minimal implementation**

Implementation rules:

- `persistOsc52Policy()` should dispatch `updateSettingsLocal({ terminal: { osc52Clipboard: policy } })` only.
- Let the browser-preferences middleware persist the change.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.osc52.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.osc52.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
git commit -m "fix(local-prefs): keep osc52 policy browser-local"
```

### Task 16: Keep server-backed writers outside SettingsView on the server path

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.createContent.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`

**Step 1: Write the failing tests**

Update the tests so they prove:

- `PaneContainer` saves coding-CLI provider `cwd` through `saveServerSettingsPatch(...)`
- pane creation still reads `settings.agentChat.defaultPlugins` from resolved settings
- `AgentChatView` persists provider defaults and `agentChat.initialSetupDone` through the server-backed path

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
```

Expected: FAIL because these components still use mixed optimistic updates and direct `api.patch()` calls.

**Step 3: Write the minimal implementation**

Implementation rules:

- Replace mixed optimistic updates with `saveServerSettingsPatch(...)`.
- Do not add new ad hoc persistence logic in these components.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/panes/PaneContainer.tsx src/components/agent-chat/AgentChatView.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
git commit -m "fix(settings): preserve server-backed writers outside settings view"
```

### Task 17: Move ToolStrip and tab search range into browser preferences

**Files:**
- Modify: `src/components/agent-chat/ToolStrip.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `test/unit/client/components/agent-chat/ToolStrip.test.tsx`
- Modify: `test/unit/client/components/agent-chat/MessageBubble.test.tsx`
- Modify: `test/unit/client/store/tabRegistrySync.test.ts`
- Modify: `test/e2e/agent-chat-context-menu-flow.test.tsx`
- Modify: `test/e2e/agent-chat-polish-flow.test.tsx`
- Modify: `test/e2e/tabs-view-search-range.test.tsx`

**Step 1: Write the failing tests**

Update the tests so they assert:

- ToolStrip reads and writes its expanded state through `browser-preferences.ts`, not `freshell:toolStripExpanded`
- `searchRangeDays` initializes from browser preferences, persists on change, and survives rerender or reload
- tests that seed the legacy tool-strip key only pass through the migration helper

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/store/tabRegistrySync.test.ts test/e2e/tabs-view-search-range.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: FAIL because ToolStrip still uses the legacy key and `searchRangeDays` still resets on reload.

**Step 3: Write the minimal implementation**

Implementation rules:

- `ToolStrip.tsx` should use `useSyncExternalStore(subscribeToolStripPreference, getToolStripExpandedPreference, () => false)`.
- `TabsView.tsx` should only dispatch `setTabRegistrySearchRangeDays(...)`.
- The browser-preferences middleware owns persistence for `searchRangeDays`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/store/tabRegistrySync.test.ts test/e2e/tabs-view-search-range.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/agent-chat/ToolStrip.tsx src/components/TabsView.tsx test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/store/tabRegistrySync.test.ts test/e2e/tabs-view-search-range.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
git commit -m "fix(local-prefs): move tool strip and tabs range into browser preferences"
```

### Task 18: Update bootstrap and test harness fixtures to the new contract

**Files:**
- Modify: `test/helpers/visible-first/app-hydration-harness.tsx`
- Modify: `test/unit/client/components/settings-view-test-utils.tsx`
- Modify: `test/unit/client/components/App.ws-extensions.test.tsx`
- Modify: `test/unit/client/components/App.perf-audit-bootstrap.test.tsx`
- Modify: `test/unit/client/components/App.lazy-views.test.tsx`
- Modify: `test/e2e/auth-required-bootstrap-flow.test.tsx`
- Modify: `test/e2e/settings-devices-flow.test.tsx`

**Step 1: Write the failing tests**

Run the exact helpers and fixtures that still build mixed bootstrap payloads or seed obsolete local-storage keys. Record each failure before editing production code.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/settings-devices-flow.test.tsx
```

Expected: FAIL because these helpers and fixtures still fabricate mixed bootstrap/settings payloads or still seed obsolete local-storage keys.

**Step 3: Write the minimal implementation**

Update these helpers to match the new contract:

- `/api/bootstrap` fixtures return server-only `settings` and optional `legacyLocalSettingsSeed`
- browser-local seeds go through the browser-preferences blob or the migration helpers, not the old ad hoc keys
- `settings-view-test-utils.tsx` should build resolved settings with the new slice helper instead of inventing a mixed shape

Do not add production compatibility code just to keep stale tests unchanged.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/settings-devices-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add test/helpers/visible-first/app-hydration-harness.tsx test/unit/client/components/settings-view-test-utils.tsx test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/settings-devices-flow.test.tsx
git commit -m "test(settings): update bootstrap helpers for split persistence"
```

### Task 19: Update mixed-settings scenario fixtures

**Files:**
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/directory-picker-flow.test.tsx`
- Modify: `test/e2e/sidebar-busy-icon-flow.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

**Step 1: Write the failing tests**

Run the remaining scenario fixtures that still seed mixed settings objects or assume sidebar local settings arrive from the server.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/directory-picker-flow.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected: FAIL because these scenario fixtures still seed local-only settings through server payloads or mixed `settings.updated` messages.

**Step 3: Write the minimal implementation**

Update these fixtures to match the final architecture:

- bootstrap fixtures return server-only `settings` and optional `legacyLocalSettingsSeed`
- websocket `settings.updated` fixtures return server-only settings
- test-only local settings go through resolved client defaults or browser-preference seeding, not server payloads

Do not add production compatibility code just to keep stale tests unchanged.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/directory-picker-flow.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/directory-picker-flow.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
git commit -m "test(settings): update scenario fixtures for split persistence"
```

### Task 20: Prove cross-surface semantics and run the final gate

**Files:**
- Create: `test/e2e-browser/specs/settings-persistence-split.spec.ts`
- Modify: `test/e2e-browser/specs/multi-client.spec.ts`

**Step 1: Write the failing tests**

Add a two-context Playwright spec that proves:

- Context A changes a local-only preference and reloads; it persists in A.
- Context B opens against the same server; it does not inherit A’s local-only change.
- Context A changes a server-backed setting through `/api/settings`.
- Context B reloads; it does inherit the server-backed change.
- the isolated server `config.json` contains server settings and the migration seed, but not live local-only settings.

Update `multi-client.spec.ts` so its broadcast assertion uses a server-backed field such as `defaultCwd`, not a local-only field.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:e2e -- test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
```

Expected: FAIL because local and server persistence semantics are not fully split yet.

**Step 3: Write the minimal implementation**

Implementation rules:

- Use `page.evaluate()` to inspect the browser-preferences blob for the local-only proof.
- Use `/api/settings` for the server-backed proof.
- Read the isolated server `config.json` from the test process to prove live local-only settings never hit `settings`.
- Do not add screenshot coverage or `docs/index.html` changes for this task.

**Step 4: Run the tests to verify they pass**

Run:

```bash
rg -n "applyLocalTerminalFontFamily|loadLocalTerminalFontFamily|saveLocalTerminalFontFamily|freshell:toolStripExpanded" src server shared
npm run test:e2e -- test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
npm run lint
npm run typecheck
npm run test:status
FRESHELL_TEST_SUMMARY="settings persistence split final" npm test
```

Expected:

- `rg` prints no results
- every command passes

**Step 5: Commit**

```bash
git add test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
git commit -m "test(settings): prove local and server persistence semantics"
```
