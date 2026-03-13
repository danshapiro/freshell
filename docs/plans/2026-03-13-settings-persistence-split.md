# Settings Persistence Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Replace the mixed settings model with a strict `ServerSettings` contract plus browser-local preferences, move the approved sidebar/debugging/display settings to browser storage, keep the approved workflow settings server-backed, and preserve existing users' moved values during the upgrade without reintroducing cross-surface sync.

**Architecture:** Put all settings defaults, schemas, normalization, and compose/split helpers in `shared/settings.ts`. The server persists only `ServerSettings`; the client resolves `ServerSettings + LocalSettings -> ResolvedSettings`, while a dedicated browser-preferences module and persistence middleware own localStorage so components only dispatch Redux actions. Legacy mixed server config is migrated by extracting a one-shot `legacyLocalSettingsSeed` for bootstrap and immediately rewriting a sanitized server-only config; the seed is never written back to server config.

**Tech Stack:** TypeScript, Zod, Express, React 18, Redux Toolkit, Vitest, Testing Library, Playwright

---

## Strategy Gate

- The bug is not one missing schema field. The bug is that Freshell has no explicit persistence boundary, so local-only UI/debug knobs drift into server schemas and server-backed workflow settings drift out of them.
- The direct fix is a hard split with one owner per layer:
  - `shared/settings.ts` owns contracts, defaults, and normalization.
  - `server/config-store.ts` owns only server-backed persistence.
  - `src/lib/browser-preferences.ts` plus a dedicated middleware owns browser-local persistence.
  - UI components own intent only; they do not write localStorage themselves.
- Do not keep the current mixed `AppSettings` on the server and "overlay" local fields forever. That preserves the ambiguity that caused the current breakage.
- Do not persist migration-only local values back into `~/.freshell/config.json`. That would make the server keep storing local settings after the split.
- Keep the chat-type exclusion rule replicated as a pair: `sidebar.excludeFirstChatSubstrings` and `sidebar.excludeFirstChatMustStart` stay server-backed together. `excludeFirstChatMustStart` alone is meaningless without the list it qualifies.
- Keep config version `1`. This refactor is a structural migration that can be handled by tolerant reads plus sanitized rewrites; a version bump adds churn without better guarantees.
- Do not expand this task into a public-settings cleanup for internal server-managed fields such as `allowedFilePaths`, `codingCli.knownProviders`, or `network.configured`. Keep them server-backed and working; the persistence split is the goal here.

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

## Key Decisions

- Store browser-local settings as a sparse patch in localStorage, not a fully-expanded `LocalSettings` object. This is required so bootstrap migration can fill only missing values without overwriting a user who already has a local value.
- The browser-preference blob is versioned independently of the repo-wide storage wipe. Preserve it during `src/store/storage-migration.ts` clears.
- Keep `updateSettingsLocal` as the local-settings action name if that materially reduces churn. Add explicit server actions for server-backed optimistic updates. Clear naming matters, but avoiding gratuitous test churn matters too.
- Prefer importing defaults and types directly from `shared/settings.ts` in new code. Compatibility re-exports are acceptable only if they do not become a second source of truth.
- `legacyLocalSettingsSeed` is bootstrap-only migration data. It is derived from the pre-split config, exposed once through `/api/bootstrap`, and never written back into `config.json` or broadcast over websocket.

## Execution Notes

- Every task below is meant to be executed red/green/refactor in order.
- After each task commit, run the next task from a clean worktree state.
- If later tasks uncover compile fallout in additional fixtures or helpers, fix it in the task that owns that seam instead of creating a new ad hoc compatibility layer.

### Task 1: Create the shared settings contract

**Files:**
- Create: `shared/settings.ts`
- Create: `test/unit/shared/settings.test.ts`

**Step 1: Write the failing tests**

Add a pure unit suite that proves:

- `buildServerSettingsPatchSchema()` accepts server-backed fields and rejects representative local-only fields.
- `resolveLocalSettings({ sidebar: { sortMode: 'hybrid' } })` normalizes to `'activity'`.
- `resolveLocalSettings(undefined)` defaults invalid or missing sort mode to `'recency-pinned'`.
- `composeResolvedSettings(server, local)` produces a resolved client object with `terminal.fontFamily`.
- `extractLegacyLocalSettingsSeed(rawMixedSettings)` returns only moved local fields.
- `stripLocalSettings(rawMixedSettings)` removes moved local fields and preserves `agentChat.defaultPlugins`.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/shared/settings.test.ts
```

Expected: FAIL because `shared/settings.ts` does not exist.

**Step 3: Write the minimal implementation**

Create `shared/settings.ts` with one source of truth for settings contracts:

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
export function resolveLocalSettings(patch?: LocalSettingsPatch): LocalSettings
export function mergeServerSettings(base: ServerSettings, patch: ServerSettingsPatch): ServerSettings
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
npm run test:vitest -- test/unit/shared/settings.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add shared/settings.ts test/unit/shared/settings.test.ts
git commit -m "refactor(settings): add shared server and local settings contract"
```

### Task 2: Migrate the config store to server-only persistence

**Files:**
- Modify: `server/config-store.ts`
- Modify: `server/settings-migrate.ts`
- Modify: `test/unit/server/config-store.test.ts`
- Modify: `test/unit/server/settings-migrate.test.ts`

**Step 1: Write the failing tests**

Update the config-store tests so they prove:

- loading a legacy mixed `config.json` returns sanitized `ServerSettings`.
- the load path extracts a `legacyLocalSettingsSeed` from moved local fields.
- the seed is not written back into `config.json`.
- local-only fields are removed from rewritten or saved config.
- sort-mode migration no longer runs on server settings.
- `migrateLegacyDefaultEnabledProviders()` still works for server-backed CLI defaults.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/server/config-store.test.ts test/unit/server/settings-migrate.test.ts
```

Expected: FAIL because `ConfigStore` still reads and writes the mixed settings shape.

**Step 3: Write the minimal implementation**

Refactor `server/config-store.ts` so it caches and persists only `ServerSettings`:

```ts
type UserConfig = {
  version: 1
  settings: ServerSettings
  sessionOverrides: ...
  terminalOverrides: ...
  projectColors: ...
  recentDirectories?: string[]
}
```

Implementation rules:

- On `load()`, capture the raw mixed settings before normalization.
- Compute `const legacyLocalSettingsSeed = extractLegacyLocalSettingsSeed(rawSettings)`.
- Normalize `settings` from `mergeServerSettings(defaultServerSettings, stripLocalSettings(rawSettings))`.
- If legacy local fields were present, rewrite `config.json` once with sanitized server settings.
- Cache the migration seed in memory only, behind `consumeLegacyLocalSettingsSeed()` or an equivalent one-shot accessor.
- Remove sort-mode migration from server code paths; keep only migrations that still apply to server-backed fields.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/server/config-store.test.ts test/unit/server/settings-migrate.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add server/config-store.ts server/settings-migrate.ts test/unit/server/config-store.test.ts test/unit/server/settings-migrate.test.ts
git commit -m "refactor(settings): persist only server settings in config store"
```

### Task 3: Cut `/api/settings` over to the shared server contract

**Files:**
- Modify: `server/settings-router.ts`
- Delete: `server/routes/settings.ts`
- Modify: `test/integration/server/settings-api.test.ts`
- Modify: `test/integration/server/api-edge-cases.test.ts`
- Modify: `test/unit/server/editor-settings.test.ts`

**Step 1: Write the failing tests**

Update the settings API tests so they assert:

- `GET /api/settings` returns only `ServerSettings`.
- `PATCH /api/settings` rejects representative local-only fields with `400`.
- `PATCH /api/settings` still accepts `defaultCwd: null` and clears it.
- `PATCH /api/settings` still round-trips server-backed fields including `terminal.scrollback`, `sidebar.excludeFirstChatSubstrings`, `sidebar.excludeFirstChatMustStart`, `codingCli.providers.codex.cwd`, and `agentChat.defaultPlugins`.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/integration/server/settings-api.test.ts test/integration/server/api-edge-cases.test.ts test/unit/server/editor-settings.test.ts
```

Expected: FAIL because the router still validates the mixed settings shape.

**Step 3: Write the minimal implementation**

Move the server patch schema to `shared/settings.ts` and make `server/settings-router.ts` consume it.

Implementation rules:

- Keep `SettingsPatchSchema` exported from `server/settings-router.ts` if tests or imports rely on that name, but make it a thin re-export of the shared builder.
- `normalizeSettingsPatch()` must preserve the `defaultCwd: null | '' -> undefined` clear behavior.
- Remove local-only nested fields from the server schema entirely, including `sidebar.ignoreCodexSubagents`.
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

### Task 4: Type bootstrap and websocket settings as server-only

**Files:**
- Modify: `shared/read-models.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `server/shell-bootstrap-router.ts`
- Modify: `server/index.ts`
- Modify: `server/perf-router.ts`
- Modify: `server/network-router.ts`
- Modify: `server/network-manager.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/integration/server/bootstrap-router.test.ts`
- Modify: `test/integration/server/network-api.test.ts`
- Modify: `test/server/perf-api.test.ts`
- Modify: `test/server/ws-handshake-snapshot.test.ts`
- Modify: `test/unit/server/terminal-lifecycle.test.ts`

**Step 1: Write the failing tests**

Update server bootstrap and websocket tests so they prove:

- `/api/bootstrap` returns `settings: ServerSettings` plus optional `legacyLocalSettingsSeed`.
- the seed is bootstrap-only, not part of `settings.updated`.
- `settings.updated` websocket messages carry only server-backed settings.
- `TerminalRegistry` and handshake snapshot types no longer depend on the mixed `AppSettings` shape.
- bootstrap stays under `MAX_BOOTSTRAP_PAYLOAD_BYTES`.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/integration/server/bootstrap-router.test.ts test/integration/server/network-api.test.ts test/server/perf-api.test.ts test/server/ws-handshake-snapshot.test.ts test/unit/server/terminal-lifecycle.test.ts
```

Expected: FAIL because bootstrap and websocket snapshots still use the mixed settings object.

**Step 3: Write the minimal implementation**

Update the shared contracts and server broadcasters:

```ts
export type BootstrapPayload = {
  settings: ServerSettings
  legacyLocalSettingsSeed?: LocalSettingsPatch
  ...
}

export type SettingsUpdatedMessage = {
  type: 'settings.updated'
  settings: ServerSettings
}
```

Implementation rules:

- `createShellBootstrapRouter()` should accept a one-shot seed accessor from `ConfigStore`.
- `settings.updated` broadcasts from `settings-router`, `perf-router`, `network-router`, `network-manager`, and websocket handshake snapshots must never include local-only fields.
- `server/terminal-registry.ts` should depend on `ServerSettings` only.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/integration/server/bootstrap-router.test.ts test/integration/server/network-api.test.ts test/server/perf-api.test.ts test/server/ws-handshake-snapshot.test.ts test/unit/server/terminal-lifecycle.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add shared/read-models.ts shared/ws-protocol.ts server/shell-bootstrap-router.ts server/index.ts server/perf-router.ts server/network-router.ts server/network-manager.ts server/ws-handler.ts server/terminal-registry.ts test/integration/server/bootstrap-router.test.ts test/integration/server/network-api.test.ts test/server/perf-api.test.ts test/server/ws-handshake-snapshot.test.ts test/unit/server/terminal-lifecycle.test.ts
git commit -m "refactor(settings): make bootstrap and websocket settings server-only"
```

### Task 5: Build the browser-preferences store and persistence middleware

**Files:**
- Create: `src/lib/browser-preferences.ts`
- Create: `src/store/browserPreferencesPersistence.ts`
- Create: `test/unit/client/lib/browser-preferences.test.ts`
- Create: `test/unit/client/store/browserPreferencesPersistence.test.ts`
- Modify: `src/store/store.ts`
- Modify: `src/store/storage-keys.ts`
- Modify: `src/store/storage-migration.ts`
- Modify: `src/lib/terminal-fonts.ts`
- Modify: `test/unit/client/lib/terminal-fonts.test.ts`
- Modify: `test/unit/client/store/storage-migration.test.ts`

**Step 1: Write the failing tests**

Add tests that prove:

- browser preferences are stored under one versioned key as a sparse record.
- `patchBrowserPreferences({ settings: ... })` merges sparse local settings patches instead of expanding defaults.
- `seedBrowserPreferences(seed)` only fills missing fields.
- legacy keys `freshell.terminal.fontFamily.v1` and `freshell:toolStripExpanded` migrate into the new blob once.
- same-document subscribers are notified after writes.
- the middleware persists `settings/updateSettingsLocal` and `tabRegistry/setTabRegistrySearchRangeDays` without requiring components to call localStorage directly.
- the browser-preference blob survives repo-wide storage wipes.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/browser-preferences.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/lib/terminal-fonts.test.ts test/unit/client/store/storage-migration.test.ts
```

Expected: FAIL because the browser-preference module and middleware do not exist.

**Step 3: Write the minimal implementation**

Create one browser-local persistence layer:

```ts
export const BROWSER_PREFERENCES_STORAGE_KEY = 'freshell.browser-preferences.v1'

export type BrowserPreferencesRecord = {
  settings?: LocalSettingsPatch
  toolStrip?: { expanded?: boolean }
  tabs?: { searchRangeDays?: number }
}

export function loadBrowserPreferencesRecord(): BrowserPreferencesRecord
export function resolveBrowserLocalSettings(record?: BrowserPreferencesRecord): LocalSettings
export function patchBrowserPreferences(patch: BrowserPreferencesRecord): void
export function seedBrowserPreferences(seed: LocalSettingsPatch): BrowserPreferencesRecord
export function subscribeBrowserPreferences(listener: () => void): () => void
export function getToolStripExpandedPreference(): boolean
export function setToolStripExpandedPreference(expanded: boolean): void
export function getSearchRangeDaysPreference(): number
```

Implementation rules:

- `src/lib/terminal-fonts.ts` must stop owning localStorage persistence.
- `src/store/browserPreferencesPersistence.ts` owns Redux-to-localStorage writes for local settings and `searchRangeDays`.
- Reuse the existing debounce and pagehide flush pattern from `persistMiddleware`; do not write the sidebar width key on every drag event.
- Preserve the browser-preference blob during `src/store/storage-migration.ts` clears.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/browser-preferences.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/lib/terminal-fonts.test.ts test/unit/client/store/storage-migration.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/browser-preferences.ts src/store/browserPreferencesPersistence.ts test/unit/client/lib/browser-preferences.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts src/store/store.ts src/store/storage-keys.ts src/store/storage-migration.ts src/lib/terminal-fonts.ts test/unit/client/lib/terminal-fonts.test.ts test/unit/client/store/storage-migration.test.ts
git commit -m "feat(local-prefs): add browser preferences store and persistence middleware"
```

### Task 6: Refactor the settings slice and bootstrap hydration

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/settingsSlice.ts`
- Modify: `src/App.tsx`
- Modify: `test/unit/client/store/settingsSlice.test.ts`
- Modify: `test/unit/client/store/state-edge-cases.test.ts`
- Modify: `test/unit/client/components/App.ws-bootstrap.test.tsx`
- Modify: `test/unit/client/components/App.test.tsx`
- Modify: `test/e2e/terminal-font-settings.test.tsx`
- Modify: `test/helpers/visible-first/app-hydration-harness.tsx`
- Modify: `test/unit/client/components/settings-view-test-utils.tsx`

**Step 1: Write the failing tests**

Update the client state and bootstrap tests so they prove:

- the settings slice stores `serverSettings`, `localSettings`, and resolved `settings`.
- `updateSettingsLocal` only accepts local-setting patches.
- `previewServerSettingsPatch` updates the server-backed view optimistically.
- bootstrap composes `ServerSettings + resolved local settings`.
- bootstrap seeds missing browser-pref values from `legacyLocalSettingsSeed`.
- websocket `settings.updated` recomposes against local settings instead of clobbering them.
- the terminal font migration now rides the general browser-preference path.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/store/settingsSlice.test.ts test/unit/client/store/state-edge-cases.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: FAIL because the slice still stores one mixed settings object and `App.tsx` still applies `applyLocalTerminalFontFamily()` as a special case.

**Step 3: Write the minimal implementation**

Refactor the settings slice to this steady state:

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

- `src/store/types.ts` should make client `AppSettings` an alias of `ResolvedSettings`, not a second handwritten interface.
- `App.tsx` should stop using `applyLocalTerminalFontFamily()`.
- `App.tsx` should subscribe to browser-preference changes and hydrate local settings from the browser-preference module.
- Bootstrap mocks and visible-first harnesses must provide server-only `settings` objects plus optional `legacyLocalSettingsSeed`.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/store/settingsSlice.test.ts test/unit/client/store/state-edge-cases.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx test/e2e/terminal-font-settings.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/store/types.ts src/store/settingsSlice.ts src/App.tsx test/unit/client/store/settingsSlice.test.ts test/unit/client/store/state-edge-cases.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/components/App.test.tsx test/e2e/terminal-font-settings.test.tsx test/helpers/visible-first/app-hydration-harness.tsx test/unit/client/components/settings-view-test-utils.tsx
git commit -m "refactor(settings): compose client settings from server and local state"
```

### Task 7: Split SettingsView writes by persistence layer

**Files:**
- Modify: `src/components/SettingsView.tsx`
- Modify: `test/unit/client/components/SettingsView.core.test.tsx`
- Modify: `test/unit/client/components/SettingsView.behavior.test.tsx`
- Modify: `test/unit/client/components/SettingsView.terminal-advanced.test.tsx`
- Modify: `test/unit/client/components/SettingsView.panes.test.tsx`
- Modify: `test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx`
- Modify: `test/unit/client/components/SettingsView.editor.test.tsx`
- Modify: `test/unit/client/components/SettingsView.network-access.test.tsx`

**Step 1: Write the failing tests**

Rewrite the SettingsView tests so they assert:

- local controls dispatch `updateSettingsLocal` and do not PATCH `/api/settings`.
- server-backed controls dispatch `previewServerSettingsPatch`, debounce `/api/settings`, and mark save time on success.
- local controls include `theme`, `uiScale`, local terminal display settings, local pane display settings, local sidebar visibility and debugging settings, `sidebar.width`, `sidebar.collapsed`, and `notifications.soundEnabled`.
- server-backed controls include `defaultCwd`, `terminal.scrollback`, `logging.debug`, `safety.autoKillIdleMinutes`, `panes.defaultNewPane`, `sidebar.excludeFirstChatSubstrings`, `sidebar.excludeFirstChatMustStart`, `codingCli.enabledProviders`, `codingCli.providers.*.cwd`, `editor.*`, and network settings.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/SettingsView.panes.test.tsx test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx test/unit/client/components/SettingsView.editor.test.tsx test/unit/client/components/SettingsView.network-access.test.tsx
```

Expected: FAIL because `SettingsView` still routes almost every setting through the same mixed server patch helper.

**Step 3: Write the minimal implementation**

Refactor `SettingsView.tsx` to use two explicit intent paths:

```ts
const applyLocalSetting = (patch: LocalSettingsPatch) => dispatch(updateSettingsLocal(patch))
const applyServerSetting = (patch: ServerSettingsPatch) => {
  dispatch(previewServerSettingsPatch(patch))
  scheduleServerSave(patch)
}
```

Implementation rules:

- `SettingsView` must not call `patchBrowserPreferences()` directly; the middleware owns browser-local persistence.
- `defaultCwd` and coding-CLI provider `cwd` validation flows must keep their current validation-before-save behavior.
- `sidebar.excludeFirstChatSubstrings` and `sidebar.excludeFirstChatMustStart` remain a server-backed pair.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/SettingsView.panes.test.tsx test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx test/unit/client/components/SettingsView.editor.test.tsx test/unit/client/components/SettingsView.network-access.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/SettingsView.tsx test/unit/client/components/SettingsView.core.test.tsx test/unit/client/components/SettingsView.behavior.test.tsx test/unit/client/components/SettingsView.terminal-advanced.test.tsx test/unit/client/components/SettingsView.panes.test.tsx test/unit/client/components/SettingsView.coding-cli-cwd.test.tsx test/unit/client/components/SettingsView.editor.test.tsx test/unit/client/components/SettingsView.network-access.test.tsx
git commit -m "fix(settings): split settings view writes by persistence layer"
```

### Task 8: Make sidebar geometry and OSC52 truly local

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

- sidebar width and collapsed state never PATCH `/api/settings`.
- mobile auto-collapse still works, but only through local settings.
- OSC52 policy changes in both SettingsView and TerminalView prompt flow are local-only.
- no code path submits the full `sidebar` object to the server anymore.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.sidebar-resize.test.tsx test/unit/client/components/App.mobile.test.tsx test/unit/client/components/App.mobile-landscape.test.tsx test/e2e/mobile-sidebar-fullwidth-flow.test.tsx test/unit/client/components/TerminalView.osc52.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: FAIL because sidebar handlers and `persistOsc52Policy()` still PATCH `/api/settings`.

**Step 3: Write the minimal implementation**

Implementation rules:

- `App.tsx` sidebar resize and collapse handlers should dispatch `updateSettingsLocal({ sidebar: ... })` only.
- `TerminalView.tsx` should dispatch `updateSettingsLocal({ terminal: { osc52Clipboard: policy } })` only.
- Let the browser-preferences middleware persist these changes; do not add direct storage writes here.

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

### Task 9: Fix the remaining server-backed writers outside SettingsView

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx`

**Step 1: Write the failing tests**

Add or update tests so they prove:

- `PaneContainer` still saves coding-CLI provider `cwd` as a server-backed setting, but uses the server preview path instead of local-settings actions.
- `AgentChatView` still saves provider defaults and `agentChat.initialSetupDone` through server-backed settings.
- these writes remain optimistic in Redux without touching browser-local settings.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/agent-chat/AgentChatView.behavior.test.tsx
```

Expected: FAIL because these components still rely on the mixed settings actions.

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

### Task 10: Move ToolStrip and tab search range into browser preferences

**Files:**
- Modify: `src/components/agent-chat/ToolStrip.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `test/unit/client/components/agent-chat/ToolStrip.test.tsx`
- Modify: `test/unit/client/components/agent-chat/MessageBubble.test.tsx`
- Modify: `test/unit/client/store/tabRegistrySlice.test.ts`
- Modify: `test/e2e/tabs-view-search-range.test.tsx`
- Modify: `test/e2e/agent-chat-context-menu-flow.test.tsx`
- Modify: `test/e2e/agent-chat-polish-flow.test.tsx`

**Step 1: Write the failing tests**

Update the tests so they assert:

- ToolStrip reads and writes its expanded state through `src/lib/browser-preferences.ts`, not `freshell:toolStripExpanded`.
- `searchRangeDays` initializes from browser preferences, persists on change, and survives rerender or reload.
- tests that seed the legacy tool-strip key fail until the migration helper is used.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/store/tabRegistrySlice.test.ts test/e2e/tabs-view-search-range.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: FAIL because ToolStrip still uses the legacy key and `searchRangeDays` still resets on reload.

**Step 3: Write the minimal implementation**

Implementation rules:

- `ToolStrip.tsx` should use `useSyncExternalStore(subscribeBrowserPreferences, getToolStripExpandedPreference, () => false)`.
- `tabRegistrySlice.ts` should initialize `searchRangeDays` from `getSearchRangeDaysPreference()`.
- `TabsView.tsx` should only dispatch `setTabRegistrySearchRangeDays`; the browser-preferences middleware persists it.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/store/tabRegistrySlice.test.ts test/e2e/tabs-view-search-range.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/components/agent-chat/ToolStrip.tsx src/components/TabsView.tsx src/store/tabRegistrySlice.ts test/unit/client/components/agent-chat/ToolStrip.test.tsx test/unit/client/components/agent-chat/MessageBubble.test.tsx test/unit/client/store/tabRegistrySlice.test.ts test/e2e/tabs-view-search-range.test.tsx test/e2e/agent-chat-context-menu-flow.test.tsx test/e2e/agent-chat-polish-flow.test.tsx
git commit -m "fix(local-prefs): move tool strip and tabs range into browser preferences"
```

### Task 11: Sweep bootstrap and settings fixtures that still build the old mixed payload

**Files:**
- Modify: `test/unit/client/components/App.ws-extensions.test.tsx`
- Modify: `test/unit/client/components/App.perf-audit-bootstrap.test.tsx`
- Modify: `test/unit/client/components/App.lazy-views.test.tsx`
- Modify: `test/e2e/auth-required-bootstrap-flow.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
- Modify: `test/e2e/settings-devices-flow.test.tsx`

**Step 1: Write the failing tests**

Run the exact set of fixtures most likely to still construct mixed bootstrap or websocket settings payloads. Record every failure caused by old payload shapes or old storage keys.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/settings-devices-flow.test.tsx
```

Expected: at least one FAIL from fixtures that still send local-only fields in bootstrap or settings payloads, or seed the old tool-strip key.

**Step 3: Write the minimal implementation**

Update these fixtures to match the new contract:

- `/api/bootstrap` fixtures return server-only `settings` and optional `legacyLocalSettingsSeed`.
- websocket `settings.updated` fixtures return server-only settings.
- browser-local seeds go through the browser-preference blob or migration helpers, not the old ad hoc keys.

Do not add compatibility code in production just to placate stale tests. Fix the fixtures.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/settings-devices-flow.test.tsx
```

Expected: PASS

**Step 5: Commit**

```bash
git add test/unit/client/components/App.ws-extensions.test.tsx test/unit/client/components/App.perf-audit-bootstrap.test.tsx test/unit/client/components/App.lazy-views.test.tsx test/e2e/auth-required-bootstrap-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/settings-devices-flow.test.tsx
git commit -m "test(settings): update fixtures to server and local split"
```

### Task 12: Prove cross-surface semantics and run the final gate

**Files:**
- Create: `test/e2e-browser/specs/settings-persistence-split.spec.ts`
- Modify: `test/e2e-browser/specs/multi-client.spec.ts`

**Step 1: Write the failing tests**

Add a dedicated two-context Playwright spec that proves:

- Context A changes a local-only preference and reloads; it persists in A.
- Context B opens against the same server; it does not inherit A's local-only change.
- Context A changes a server-backed setting through `/api/settings`.
- Context B reloads; it does inherit the server-backed change.
- the isolated server `config.json` never contains the local-only preference.

Update `multi-client.spec.ts` so its existing broadcast assertion uses a server-backed field such as `defaultCwd`, not a local-only field.

**Step 2: Run the tests to verify they fail**

Run:

```bash
npm run test:e2e -- test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
```

Expected: FAIL because the local and server scoping is not fully implemented yet.

**Step 3: Write the minimal implementation**

Implementation rules:

- Use direct `page.evaluate()` access to the browser-preference blob for the local-only proof.
- Use `/api/settings` for the server-backed proof.
- Read the isolated server `config.json` from the test process to prove local-only settings never hit disk.
- Do not add screenshots or `docs/index.html` changes for this task.

**Step 4: Run the tests to verify they pass**

Run:

```bash
npm run test:e2e -- test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
npm run lint
npm run typecheck
FRESHELL_TEST_SUMMARY="settings persistence split final" npm test
```

Expected: PASS

**Step 5: Commit**

```bash
git add test/e2e-browser/specs/settings-persistence-split.spec.ts test/e2e-browser/specs/multi-client.spec.ts
git commit -m "test(settings): prove local and server persistence semantics"
```
