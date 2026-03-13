# Settings Persistence Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Replace the mixed settings model with an explicit split between server-backed settings and browser-local preferences, move the approved sidebar/debugging/display settings to browser storage, keep the approved workflow settings server-backed, and preserve legacy values during the upgrade without restoring cross-surface live sync.

**Architecture:** Create one shared source of truth in `shared/settings.ts` for defaults, types, Zod schemas, normalization, and server/local composition. The server will persist only `ServerSettings` in `settings`, plus a bootstrap-only `legacyLocalSettingsSeed` outside `settings` so migrated browser-local values survive restarts without remaining part of the live server contract. The client will store `serverSettings`, `localSettings`, and resolved `settings` separately, with one browser-preferences module and middleware owning the versioned localStorage blob.

**Tech Stack:** TypeScript, Zod, Express, React 18, Redux Toolkit, Vitest, Testing Library, Playwright

---

## Strategy Gate

- The real bug is not one missing field. The real bug is that Freshell has no hard persistence boundary, so browser-local UI/debug settings drift into server storage and server-backed workflow settings drift out of it.
- The right fix is a hard split:
  - `shared/settings.ts` owns contracts, defaults, normalization, and compose/split helpers.
  - `server/config-store.ts` owns server-backed persistence only.
  - `src/lib/browser-preferences.ts` owns browser-local persistence only.
  - Components dispatch intent only. They do not write `localStorage` directly.
- Do not keep the current mixed `AppSettings` shape on the server and “overlay” local fields forever. That preserves the ambiguity that caused the current failures.
- Do not solve this with a one-shot in-memory migration seed. That would lose migrated values for browsers that upgrade later or after a restart.
- The durable migration compromise is deliberate:
  - store `legacyLocalSettingsSeed` as top-level migration metadata in `config.json`, not inside `settings`
  - expose it only from `/api/bootstrap`
  - never include it in `/api/settings` or `settings.updated`
  - have the client use it only when the browser-preferences blob does not already contain local settings
- That compromise is the cleanest direct path because Freshell has no browser identity or migration acknowledgment protocol. Persisting the seed outside `settings` avoids silent data loss without reintroducing live sync of local-only preferences.
- Keep `sidebar.excludeFirstChatSubstrings` and `sidebar.excludeFirstChatMustStart` server-backed together. The toggle is only meaningful with the list it qualifies.
- Keep config version `1`. This is a tolerant-read, sanitized-write migration, not a second persistent schema family.
- Do not widen this task into a cleanup of internal server-managed fields such as `allowedFilePaths`, `codingCli.knownProviders`, or `network.configured`. Keep them server-backed and functioning.

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

**Browser-local non-settings preferences in the same blob**

- `toolStripExpanded`
- `tabs.searchRangeDays`

## Execution Rules

- Execute red/green/refactor in order. Do not skip the red test.
- Keep each task self-contained. If later compile fallout appears, fix it in the task that owns that seam instead of adding compatibility shims.
- Before the final broad run, check the shared gate with `npm run test:status`. If another holder exists, wait rather than bypassing coordination.
- Commit after every task with the message listed in that task.

### Task 1: Create the shared settings contract

**Files:**
- Create: `shared/settings.ts`
- Create: `test/unit/shared/settings.test.ts`
- Modify: `test/integration/activity-sort.test.tsx`

**Step 1: Write the failing tests**

Add a pure unit suite that proves:

- `buildServerSettingsPatchSchema()` accepts representative server-backed fields and rejects representative local-only fields.
- `resolveLocalSettings({ sidebar: { sortMode: 'hybrid' } })` normalizes to `'activity'`.
- `resolveLocalSettings(undefined)` defaults missing or invalid sort mode to `'recency-pinned'`.
- `composeResolvedSettings(server, local)` produces a resolved client object that includes `terminal.fontFamily`.
- `extractLegacyLocalSettingsSeed(rawMixedSettings)` returns only moved local fields.
- `stripLocalSettings(rawMixedSettings)` removes moved local fields and preserves `agentChat.defaultPlugins`.

Replace the old integration test that asserts sort-mode migration inside `setSettings`. That migration no longer belongs in the mixed client/server path.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts test/integration/activity-sort.test.tsx
```

Expected: FAIL because `shared/settings.ts` does not exist and the old sort-mode ownership is still wrong.

**Step 3: Write the minimal implementation**

Create `shared/settings.ts` with one source of truth:

```ts
export const defaultServerSettings
export const defaultLocalSettings

export type ServerSettings
export type ServerSettingsPatch
export type LocalSettings
export type LocalSettingsPatch
export type ResolvedSettings

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

- `ServerSettings` includes `agentChat.defaultPlugins`.
- `ServerSettings` does not include `terminal.fontFamily`, `sidebar.sortMode`, or `sidebar.ignoreCodexSubagents`.
- `LocalSettingsPatch` is sparse.
- `defaultLocalSettings.sidebar.sortMode` is `'recency-pinned'`.
- Shared code must not import from `src/`.

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

### Task 2: Move server migrations to server-owned fields only

**Files:**
- Modify: `server/settings-migrate.ts`
- Modify: `test/unit/server/settings-migrate.test.ts`

**Step 1: Write the failing tests**

Update the migration tests so they prove:

- server migration no longer rewrites `sidebar.sortMode`
- server migration still preserves server-backed defaults and `codingCli.enabledProviders`
- migration helpers stay pure and do not mutate their inputs

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/settings-migrate.test.ts
```

Expected: FAIL because server migration still owns sort-mode cleanup.

**Step 3: Write the minimal implementation**

Refactor `server/settings-migrate.ts` so it only handles migrations that still belong to server-backed settings. Remove sort-mode migration from server code paths entirely; that normalization now belongs to `resolveLocalSettings()`.

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
- loading the same file produces a top-level `legacyLocalSettingsSeed`
- the seed is stored outside `settings`
- saving server-backed changes keeps the seed but does not reintroduce moved local fields
- `agentChat.defaultPlugins` remains preserved through load and patch

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

- On `load()`, capture the raw legacy `settings` object before normalization.
- Normalize live settings with `mergeServerSettings(defaultServerSettings, stripLocalSettings(rawSettings))`.
- If the file already has `legacyLocalSettingsSeed`, keep it.
- If the file does not have `legacyLocalSettingsSeed`, derive it from the raw mixed settings and persist it once at top level.
- Rewritten files must remove moved local fields from `settings`.
- Export a read-only accessor for bootstrap, not a consuming one-shot API.

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

### Task 4: Enforce the server-only settings API contract

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

- Keep `SettingsPatchSchema` exported from `server/settings-router.ts` if existing tests import that name, but make it a thin shared re-export.
- Preserve the current `defaultCwd: null | '' -> undefined` clear behavior.
- Remove all local-only nested fields from the server schema, including `sidebar.sortMode` and `sidebar.ignoreCodexSubagents`.
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

### Task 5: Type bootstrap payloads as server-only

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `server/index.ts`
- Modify: `test/integration/server/bootstrap-router.test.ts`

**Step 1: Write the failing tests**

Update the bootstrap tests so they prove:

- `/api/bootstrap` returns `settings: ServerSettings` plus optional `legacyLocalSettingsSeed`
- bootstrap still stays under `MAX_BOOTSTRAP_PAYLOAD_BYTES`

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
  ...
}
```

Implementation rules:

- `createShellBootstrapRouter()` should accept both `getSettings()` and `getLegacyLocalSettingsSeed()`.
- `/api/bootstrap` is the only route that may return the migration seed.
- Keep payload size assertions intact.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/integration/server/bootstrap-router.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add shared/read-models.ts server/shell-bootstrap-router.ts server/index.ts test/integration/server/bootstrap-router.test.ts
git commit -m "refactor(settings): make bootstrap payload server-only"
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
- the migration seed never appears in websocket broadcasts
- `TerminalRegistry` depends only on server-owned settings fields

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/integration/server/network-api.test.ts test/server/perf-api.test.ts test/server/ws-handshake-snapshot.test.ts test/unit/server/terminal-lifecycle.test.ts
```

Expected: FAIL because websocket messages and server consumers still use the mixed settings shape.

**Step 3: Write the minimal implementation**

Implementation rules:

- `SettingsUpdatedMessage` in `shared/ws-protocol.ts` must expose only `ServerSettings`.
- `settings.updated` broadcasts from `settings-router`, `perf-router`, `network-router`, and `network-manager` must never include local-only fields or migration metadata.
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

### Task 7: Build the browser-preferences module

**Files:**
- Create: `src/lib/browser-preferences.ts`
- Create: `test/unit/client/lib/browser-preferences.test.ts`
- Modify: `src/lib/terminal-fonts.ts`
- Modify: `test/unit/client/lib/terminal-fonts.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- browser preferences load from one versioned blob as a sparse record
- `patchBrowserPreferences({ settings: ... })` merges sparse local-setting patches
- `seedBrowserPreferences(seed)` fills only missing settings
- legacy keys `freshell.terminal.fontFamily.v1` and `freshell:toolStripExpanded` migrate into the new blob once
- same-document subscribers are notified after writes
- `src/lib/terminal-fonts.ts` becomes a thin adapter over the new module rather than owning storage directly

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/browser-preferences.test.ts test/unit/client/lib/terminal-fonts.test.ts
```

Expected: FAIL because the browser-preferences module does not exist.

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
export function patchBrowserPreferences(patch: BrowserPreferencesRecord): BrowserPreferencesRecord
export function seedBrowserPreferences(seed: LocalSettingsPatch): BrowserPreferencesRecord
export function resolveBrowserLocalSettings(record?: BrowserPreferencesRecord): LocalSettings
export function subscribeBrowserPreferences(listener: () => void): () => void
export function getToolStripExpandedPreference(): boolean
export function setToolStripExpandedPreference(expanded: boolean): void
export function getSearchRangeDaysPreference(): number
```

Implementation rules:

- Store only sparse local-setting patches in the blob.
- Migrate legacy font and tool-strip keys inside this module, not inside components.
- Keep `terminal-fonts.ts` as a compatibility wrapper for callers that still import it during the refactor.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/browser-preferences.test.ts test/unit/client/lib/terminal-fonts.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/browser-preferences.ts test/unit/client/lib/browser-preferences.test.ts src/lib/terminal-fonts.ts test/unit/client/lib/terminal-fonts.test.ts
git commit -m "feat(local-prefs): add browser preferences module"
```

### Task 8: Persist browser preferences through Redux middleware

**Files:**
- Create: `src/store/browserPreferencesPersistence.ts`
- Create: `test/unit/client/store/browserPreferencesPersistence.test.ts`
- Modify: `src/store/store.ts`
- Modify: `src/store/storage-keys.ts`
- Modify: `src/store/storage-migration.ts`
- Modify: `test/unit/client/store/storage-migration.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- the middleware persists `settings/updateSettingsLocal` and `tabRegistry/setTabRegistrySearchRangeDays`
- writes are debounced and flushed on `pagehide`, matching the existing persistence pattern
- the browser-preference blob survives repo-wide storage wipes
- storage migration preserves auth and the new browser-preferences blob while clearing other old `freshell.` keys

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/store/storage-migration.test.ts
```

Expected: FAIL because the middleware does not exist and storage migration still clears all `freshell.` keys except auth.

**Step 3: Write the minimal implementation**

Create a dedicated Redux middleware for browser-local persistence.

Implementation rules:

- Reuse the debounce and pagehide flush pattern from `persistMiddleware.ts`.
- Do not write localStorage directly from components.
- Do not put tabs/panes persistence into this new middleware; keep ownership separated by persisted data family.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/store/storage-migration.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/store/browserPreferencesPersistence.ts test/unit/client/store/browserPreferencesPersistence.test.ts src/store/store.ts src/store/storage-keys.ts src/store/storage-migration.ts test/unit/client/store/storage-migration.test.ts
git commit -m "feat(local-prefs): persist browser preferences through middleware"
```

### Task 9: Split client settings state into server, local, and resolved views

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/settingsSlice.ts`
- Modify: `test/unit/client/store/settingsSlice.test.ts`
- Modify: `test/unit/client/store/state-edge-cases.test.ts`

**Step 1: Write the failing tests**

Update the slice tests so they prove:

- state stores `serverSettings`, `localSettings`, and resolved `settings`
- `updateSettingsLocal` only accepts local-setting patches
- `previewServerSettingsPatch` only applies to server-backed fields
- local sort-mode migration lives in local resolution, not in server setters

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/settingsSlice.test.ts test/unit/client/store/state-edge-cases.test.ts
```

Expected: FAIL because the slice still stores one mixed settings object.

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

- `src/store/types.ts` should make client `AppSettings` an alias of `ResolvedSettings`.
- Keep resolved selectors reading `state.settings.settings` so component churn stays limited.
- Do not reintroduce a second handwritten settings interface in `src/store/types.ts`.

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

### Task 10: Hydrate client state from bootstrap, local storage, and websocket updates

**Files:**
- Modify: `src/App.tsx`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/e2e/terminal-font-settings.test.tsx`
- Modify: `test/helpers/visible-first/app-hydration-harness.tsx`
- Modify: `test/unit/client/components/settings-view-test-utils.tsx`

**Step 1: Write the failing tests**

Update the hydration tests so they prove:

- bootstrap composes `ServerSettings + LocalSettings`
- `legacyLocalSettingsSeed` fills missing browser-local settings when the blob is empty
- existing browser-local values win over the migration seed
- websocket `settings.updated` recomposes against local settings instead of clobbering them
- terminal font migration rides the general browser-preferences path

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: FAIL because `App.tsx` still treats terminal font as a one-off overlay and still assumes bootstrap returns the mixed settings object.

**Step 3: Write the minimal implementation**

Implementation rules:

- `App.tsx` should load browser preferences during startup and dispatch `setLocalSettings(resolveBrowserLocalSettings(...))`.
- Apply `legacyLocalSettingsSeed` only when the browser-preference blob lacks local settings.
- Subscribe to browser-preference changes so same-document and cross-document updates converge without full reload.
- Remove `applyLocalTerminalFontFamily()` from the bootstrap/websocket path.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/App.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx test/e2e/terminal-font-settings.test.tsx test/helpers/visible-first/app-hydration-harness.tsx test/unit/client/components/settings-view-test-utils.tsx
git commit -m "refactor(settings): hydrate client settings from server and local sources"
```

### Task 11: Split local-only controls in SettingsView

**Files:**
- Modify: `src/components/SettingsView.tsx`
- Modify: `test/unit/client/components/SettingsView.core.test.tsx`
- Modify: `test/unit/client/components/SettingsView.behavior.test.tsx`
- Modify: `test/unit/client/components/SettingsView.terminal-advanced.test.tsx`
- Modify: `test/unit/client/components/SettingsView.panes.test.tsx`

**Step 1: Write the failing tests**

Rewrite the local-control tests so they assert:

- local controls dispatch `updateSettingsLocal`
- local controls do not PATCH `/api/settings`
- local controls include `theme`, `uiScale`, local terminal display settings, local pane display settings, local sidebar sorting/filtering/visibility settings, and `notifications.soundEnabled`

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/SettingsView.panes.test.tsx
```

Expected: FAIL because `SettingsView` still routes many local-only controls through the server save path.

**Step 3: Write the minimal implementation**

Refactor `SettingsView.tsx` to use:

```ts
const applyLocalSetting = (patch: LocalSettingsPatch) => dispatch(updateSettingsLocal(patch))
```

Implementation rules:

- local-only controls must not call `patchBrowserPreferences()` directly
- local-only controls must not schedule `/api/settings` writes
- `sidebar.excludeFirstChatSubstrings` and `sidebar.excludeFirstChatMustStart` are not part of this task; they stay on the server path

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

### Task 12: Split server-backed controls in SettingsView

**Files:**
- Modify: `src/components/SettingsView.tsx`
- Modify: `test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx`
- Modify: `test/unit/client/components/SettingsView.editor.test.tsx`
- Modify: `test/unit/client/components/SettingsView.network-access.test.tsx`

**Step 1: Write the failing tests**

Rewrite the server-control tests so they assert:

- server-backed controls dispatch `previewServerSettingsPatch`
- server-backed controls debounce `/api/settings` and call `markSaved()` on success
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
  dispatch(previewServerSettingsPatch(patch))
  scheduleServerSave(patch)
}
```

Implementation rules:

- Preserve current validation-before-save flows for `defaultCwd` and coding-CLI provider `cwd`.
- Keep the exclusion rule pair on the server path together.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx test/unit/client/components/SettingsView.editor.test.tsx test/unit/client/components/SettingsView.network-access.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/SettingsView.tsx test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx test/unit/client/components/SettingsView.editor.test.tsx test/unit/client/components/SettingsView.network-access.test.tsx
git commit -m "fix(settings): keep server-backed settings view writes on api path"
```

### Task 13: Make sidebar geometry and OSC52 truly browser-local

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/App.sidebar-resize.test.tsx`
- Modify: `test/unit/client/components/App.mobile.test.tsx`
- Modify: `test/unit/client/components/App.mobile-landscape.test.tsx`
- Modify: `test/e2e/mobile-sidebar-fullwidth-flow.test.tsx`
- Modify: `test/unit/client/components/TerminalView.osc52.test.tsx`
- Modify: `test/e2e/terminal-osc52-policy-flow.test.tsx`

**Step 1: Write the failing tests**

Update the sidebar and OSC52 tests so they prove:

- sidebar width and collapsed state never PATCH `/api/settings`
- mobile auto-collapse still works, but only through local settings
- OSC52 policy changes are local-only in both SettingsView and TerminalView flows
- no code path submits the full `sidebar` object to the server anymore

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/unit/client/components/TerminalView.osc52.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: FAIL because sidebar handlers and OSC52 writes still touch the server path.

**Step 3: Write the minimal implementation**

Implementation rules:

- `App.tsx` sidebar resize and collapse handlers should dispatch `updateSettingsLocal({ sidebar: ... })` only.
- `TerminalView.tsx` should dispatch `updateSettingsLocal({ terminal: { osc52Clipboard: policy } })` only.
- Let the browser-preferences middleware persist these changes.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/unit/client/components/TerminalView.osc52.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/App.tsx src/components/TerminalView.tsx test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/unit/client/components/TerminalView.osc52.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
git commit -m "fix(local-prefs): keep sidebar geometry and osc52 browser-local"
```

### Task 14: Keep non-SettingsView writers on the server-backed path

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`

**Step 1: Write the failing tests**

Update the tests so they prove:

- `PaneContainer` still saves coding-CLI provider `cwd` as a server-backed setting through `previewServerSettingsPatch`
- `AgentChatView` still saves provider defaults and `agentChat.initialSetupDone` through the server-backed path
- these writes remain optimistic in Redux without mutating local settings

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
```

Expected: FAIL because these components still assume the mixed settings actions.

**Step 3: Write the minimal implementation**

Implementation rules:

- Replace mixed optimistic updates with `previewServerSettingsPatch(...)`.
- Keep pane creation reading `settings.agentChat.defaultPlugins` from the resolved settings view.
- Do not add special-case persistence code in these components.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/panes/PaneContainer.tsx src/components/agent-chat/AgentChatView.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
git commit -m "fix(settings): preserve server-backed writers outside settings view"
```

### Task 15: Move ToolStrip and tab search range into browser preferences

**Files:**
- Modify: `src/components/agent-chat/ToolStrip.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `test/unit/client/components/agent-chat/ToolStrip.test.tsx`
- Modify: `test/unit/client/components/agent-chat/MessageBubble.test.tsx`
- Modify: `test/unit/client/store/tabRegistrySlice.test.ts`
- Modify: `test/unit/client/store/tabRegistrySync.test.ts`
- Modify: `test/e2e/tabs-view-search-range.test.tsx`
- Modify: `test/e2e/agent-chat-context-menu-flow.test.tsx`
- Modify: `test/e2e/agent-chat-polish-flow.test.tsx`

**Step 1: Write the failing tests**

Update the tests so they assert:

- ToolStrip reads and writes its expanded state through `src/lib/browser-preferences.ts`, not `freshell:toolStripExpanded`
- `searchRangeDays` initializes from browser preferences, persists on change, and survives rerender or reload
- tests that seed the legacy tool-strip key fail until the migration helper is used

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/store/tabRegistrySlice.test.ts test/unit/client/store/tabRegistrySync.test.ts test/e2e/tabs-view-search-range.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: FAIL because ToolStrip still uses the legacy key and `searchRangeDays` still resets on reload.

**Step 3: Write the minimal implementation**

Implementation rules:

- `ToolStrip.tsx` should use `useSyncExternalStore(subscribeBrowserPreferences, getToolStripExpandedPreference, () => false)`.
- `tabRegistrySlice.ts` should initialize `searchRangeDays` from `getSearchRangeDaysPreference()`.
- `TabsView.tsx` should only dispatch `setTabRegistrySearchRangeDays`; the middleware persists it.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/store/tabRegistrySlice.test.ts test/unit/client/store/tabRegistrySync.test.ts test/e2e/tabs-view-search-range.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/agent-chat/ToolStrip.tsx src/components/TabsView.tsx src/store/tabRegistrySlice.ts test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/store/tabRegistrySlice.test.ts test/unit/client/store/tabRegistrySync.test.ts test/e2e/tabs-view-search-range.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
git commit -m "fix(local-prefs): move tool strip and tabs range into browser preferences"
```

### Task 16: Sweep bootstrap and local-storage fixtures

**Files:**
- Modify: `test/unit/client/components/App.ws-extensions.test.tsx`
- Modify: `test/unit/client/components/App.perf-audit-bootstrap.test.tsx`
- Modify: `test/unit/client/components/App.lazy-views.test.tsx`
- Modify: `test/e2e/auth-required-bootstrap-flow.test.tsx`
- Modify: `test/e2e/settings-devices-flow.test.tsx`

**Step 1: Write the failing tests**

Run the exact fixtures that are still likely to build the old mixed bootstrap payload or reference the legacy tool-strip key. Record each failure before editing production code.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/settings-devices-flow.test.tsx
```

Expected: at least one FAIL from stale bootstrap shapes, stale settings payloads, or stale local-storage keys.

**Step 3: Write the minimal implementation**

Update these fixtures to match the new contract:

- `/api/bootstrap` fixtures return server-only `settings` and optional `legacyLocalSettingsSeed`
- local seeds go through the browser-preference blob or migration helpers, not the old ad hoc keys

Do not add production compatibility code just to keep stale tests unchanged.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/settings-devices-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/settings-devices-flow.test.tsx
git commit -m "test(settings): update bootstrap and local-storage fixtures"
```

### Task 17: Sweep remaining mixed-settings fixtures

**Files:**
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/directory-picker-flow.test.tsx`
- Modify: `test/e2e/sidebar-busy-icon-flow.test.tsx`
- Modify: `test/e2e/sidebar-click-opens-pane.test.tsx`
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

**Step 1: Write the failing tests**

Run the remaining fixtures that still seed mixed settings or assume sidebar local settings are present in server payloads.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/directory-picker-flow.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected: at least one FAIL from stale mixed settings fixtures.

**Step 3: Write the minimal implementation**

Update these fixtures to match the new contract:

- bootstrap fixtures return server-only `settings` and optional `legacyLocalSettingsSeed`
- websocket `settings.updated` fixtures return server-only settings
- test-only local settings go through resolved client settings or browser-preference seeding, not server payloads

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
git commit -m "test(settings): update remaining mixed-settings fixtures"
```

### Task 18: Prove cross-surface semantics and run the final gate

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
npm run test:e2e -- test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
npm run lint
npm run typecheck
npm run test:status
FRESHELL_TEST_SUMMARY="settings persistence split final" npm test
```

Expected: PASS

**Step 5: Commit**

```bash
git add test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
git commit -m "test(settings): prove local and server persistence semantics"
```
