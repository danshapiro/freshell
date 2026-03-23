# Tab Layout Integrity Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Eliminate tab-content loss by making pane-backed tabs impossible to observe or persist without their layouts, and by surfacing explicit integrity errors instead of fabricating replacement content when corruption is already present.

**Architecture:** Fix this at the contract boundary, not with more fallback logic. Introduce shared workspace domain actions that update `tabs` and `panes` together for pane-backed create/restore/hydrate flows, move persistence authority to one validated combined workspace snapshot, and treat `existing pane-backed tab without layout` as corruption everywhere. Existing corruption renders a dedicated error surface and blocks all repair-by-fabrication paths, including `PaneLayout` auto-init and `openSessionTab(...)` layout repair.

**Tech Stack:** React 18, Redux Toolkit, localStorage, BroadcastChannel, Vitest, Playwright

---

## Frozen Decisions

1. `tab exists, layout missing` is corruption for any pane-backed tab. It is never a normal loading state and must never trigger implicit `initLayout(...)`.
2. A shared thunk is not enough for pane-backed creation integrity because multiple dispatches still expose intermediate state. Use shared workspace domain actions handled by both slices so create/restore/hydrate operations are coherent at the store boundary.
3. `codingCliSessionId` session-view tabs are exempt from pane-layout requirements because they render `SessionView`, not `PaneLayout`.
4. Persistence authority moves to one combined workspace snapshot key containing both `tabs` and `panes`. Legacy split keys remain read-only compatibility inputs when the combined key is absent.
5. Cross-tab sync hydrates the combined workspace snapshot as one payload. No new client may treat `tabs` and `panes` storage events as independent authoritative state once the combined key exists.
6. While the combined workspace key is authoritative, Freshell continues writing `freshell.tabs.v2` and `freshell.panes.v2` as compatibility mirrors derived from the same validated snapshot. They must never again be written from independent slice state.
7. Persistence fails closed. If the current workspace violates pane-backed layout integrity, Freshell keeps the last valid authoritative snapshot and logs the integrity failure rather than writing partial damage.
8. Existing corruption must preserve evidence and identity. It may show diagnostics and safe next steps, but it must not fabricate content, create terminals, or overwrite storage.
9. No new fallback behavior is introduced without explicit user approval.
10. Bootstrap cleanup must use the same authoritative snapshot as slice initialization. No code may prune layouts by re-reading `freshell.tabs.v2` directly once the combined workspace loader exists.

## User-Visible Contract

- Switching tabs, reopening tabs, reloading the page, or syncing with another browser window must not replace an existing tab’s content with `New Tab`, a blank coding pane, or any other synthesized fallback.
- If a pane-backed tab is corrupted and its layout is missing, the tab remains visible and selectable, but the content area shows an explicit integrity error explaining that the layout is missing and Freshell refused to fabricate replacement content.
- The integrity error surface must be deterministic and testable, with stable copy and a stable DOM marker such as `data-testid="missing-layout-error"`.
- Existing exact-session restore behavior remains fail-closed: degraded coding restore still reports `[Restore blocked: exact session identity missing]`.
- Fresh shell tabs, browser tabs, editor tabs, restored pane-backed tabs, and pane-backed coding tabs still open normally through the shared workspace create/restore actions.

## Integrity Invariants

1. Every pane-backed tab in `tabs.tabs` has a matching `panes.layouts[tab.id]` in every valid in-memory state, every valid persisted combined snapshot, and every valid cross-tab payload.
2. Pane-backed create and restore flows are expressed as shared workspace actions consumed by both `tabsSlice` and `panesSlice`, not as unrelated caller-managed dispatch pairs.
3. `PaneLayout` may auto-initialize only for explicitly new local creation workflows, never for an already-existing persisted or hydrated tab.
4. Code that targets an existing tab, including `openSessionTab(...)`, must treat a missing layout as corruption and surface the error state rather than repairing it by creating a new layout.
5. Persistence either writes one valid combined workspace snapshot or writes nothing. It must not publish a new tabs generation without matching layouts.
6. Error rendering is side-effect free: no `initLayout`, no `terminal.create`, no `addTerminalRestoreRequestId`, and no storage repair write.
7. All bootstrap readers agree on the same generation. `tabsSlice`, `panesSlice`, orphan-layout cleanup, and terminal restore bookkeeping must consume one shared loaded workspace snapshot, not separate ad hoc `localStorage` reads.

## File Map

**Create**

- `src/lib/tab-layout-integrity.ts` — shared helpers to classify pane-backed tabs, detect missing-layout corruption, and validate combined workspace snapshots.
- `src/store/workspaceActions.ts` — shared domain actions for pane-backed create, restore, and workspace hydrate operations.
- `src/store/workspacePersistence.ts` — authoritative combined workspace snapshot parse/load/serialize helpers with legacy split-key fallback and integrity validation.
- `src/components/panes/MissingLayoutError.tsx` — explicit error surface for pane-backed tabs whose layout is missing.
- `test/unit/client/lib/tab-layout-integrity.test.ts` — integrity helper coverage.
- `test/unit/client/store/workspaceActions.test.ts` — shared create/restore/hydrate action coverage.
- `test/unit/client/store/workspacePersistence.test.ts` — combined snapshot load/save and invalid-write coverage.
- `test/e2e-browser/specs/tab-layout-integrity.spec.ts` — browser regression coverage for reload and multi-client corruption paths.

**Modify**

- `src/store/storage-keys.ts`
- `src/store/persistedState.ts`
- `src/store/persistMiddleware.ts`
- `src/store/crossTabSync.ts`
- `src/store/layoutMirrorMiddleware.ts`
- `src/store/tabsSlice.ts`
- `src/store/panesSlice.ts`
- `src/store/codingCliThunks.ts`
- `src/lib/ui-commands.ts`
- `src/lib/terminal-restore.ts`
- `src/App.tsx`
- `src/components/TabContent.tsx`
- `src/components/panes/PaneLayout.tsx`
- `src/components/TabBar.tsx`
- `src/components/MobileTabStrip.tsx`
- `src/components/TabSwitcher.tsx`
- `src/components/context-menu/ContextMenuProvider.tsx`
- `src/components/TabsView.tsx`
- `src/components/SetupWizard.tsx`
- `src/components/settings/SafetySettings.tsx`
- `src/components/OverviewView.tsx`
- `src/components/BackgroundSessions.tsx`

**Tests**

- `test/unit/client/components/panes/PaneLayout.test.tsx`
- `test/unit/client/components/TabContent.test.tsx`
- `test/unit/client/components/TabsView.test.tsx`
- `test/unit/client/layout-mirror-middleware.test.ts`
- `test/unit/client/store/crossTabSync.test.ts`
- `test/unit/client/store/codingCliThunks.test.ts`
- `test/unit/client/store/panesPersistence.test.ts`
- `test/unit/client/store/persistBroadcast.test.ts`
- `test/unit/client/store/persistedState.test.ts`
- `test/unit/client/store/storage-migration.test.ts`
- `test/unit/client/store/tabsPersistence.test.ts`
- `test/unit/client/store/tabsSlice.test.ts`
- `test/unit/client/ui-commands.test.ts`
- `test/unit/lib/terminal-restore.test.ts`
- `test/unit/lib/visible-first-audit-seed-browser-storage.test.ts`
- `test/e2e-browser/perf/seed-browser-storage.ts`
- `test/e2e-browser/perf/run-sample.ts`
- `test/e2e-browser/specs/terminal-exact-session-identity.spec.ts`
- `test/e2e-browser/specs/tab-management.spec.ts`
- `test/e2e-browser/specs/multi-client.spec.ts`

## Strategy Gate

Why this is the right fix:

- The investigation already established that fallback creation is not just masking corruption; it becomes part of the destructive write path. Fixing only the UI fallback would convert data loss into an error state, which is better, but still not success.
- The common problem is broader than a tiny timing gap. Freshell currently permits ordinary pane-backed tab creation flows to exist without layouts, and later persistence/sync makes that state durable and contagious. Shared domain actions are the clean fix because they remove caller-managed split ownership at the store boundary.
- A combined authoritative workspace snapshot is the clean persistence fix because the regression came from persisting and hydrating `tabs` and `panes` independently. Keeping split keys as the main authority would preserve the defect surface.
- The authoritative workspace loader must also feed non-Redux restore bootstrap code. `terminal-restore.ts` discovers persisted restore IDs at module load, so leaving it on split-key reads would preserve a second skew path and risk rebreaking exact-session reload after the storage redesign.
- The authoritative workspace loader must also feed `cleanOrphanedLayouts(...)` in `panesSlice.ts`. Leaving that helper on a direct `TABS_STORAGE_KEY` read would let stale compatibility mirrors prune valid layouts during bootstrap even after the main persistence fix landed.
- No storage-version wipe is needed for this change. The new combined key is additive, and the loader can still read legacy split keys when the combined key is absent while refusing to bless invalid legacy combinations as healthy state.
- Because the repo already has storage seed helpers, perf fixtures, and low-level broadcast/storage tests that know about the split keys, mirror behavior cannot be left implicit. The implementation must either keep deterministic split-key mirrors or update those helpers in the same task; this plan chooses to keep validated mirrors and update the helpers/tests to assert that contract.
- `docs/index.html` does not need updating. The new UI is a corruption/error surface, not a material change to the normal product experience.

## Task 1: Define Integrity Rules And Shared Workspace Actions

**Files:**
- Create: `src/lib/tab-layout-integrity.ts`
- Create: `src/store/workspaceActions.ts`
- Create: `test/unit/client/lib/tab-layout-integrity.test.ts`
- Create: `test/unit/client/store/workspaceActions.test.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `test/unit/client/store/tabsSlice.test.ts`

- [x] **Step 1: Identify or write the failing tests**

Add or extend tests to prove the shared contract that is currently missing:

- `isPaneBackedTab(tab)` returns `true` for shell, browser/editor, PTY-backed coding tabs, and restored pane-backed tabs, and `false` for `codingCliSessionId` session-view tabs.
- `detectMissingLayoutCorruption({ tab, layout })` reports corruption for an existing pane-backed tab with no layout.
- shared workspace actions create or restore pane-backed tabs by updating both slices together in one action, not by requiring callers to coordinate `addTab(...)` and `initLayout(...)`.
- existing hydration/restore reducers still normalize tab defaults and pane defaults correctly when fed the shared actions.

- [x] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/tab-layout-integrity.test.ts test/unit/client/store/workspaceActions.test.ts test/unit/client/store/tabsSlice.test.ts
```

Expected: FAIL because the helper module and workspace action module do not exist yet, and the slices do not yet respond to shared create/restore/hydrate actions.

- [x] **Step 3: Implement integrity helpers and workspace domain actions**

Implement:

```ts
// src/lib/tab-layout-integrity.ts
export function isPaneBackedTab(tab: Tab): boolean
export function detectMissingLayoutCorruption(input: {
  tab: Tab
  layout: PaneNode | undefined
}): { kind: 'missing-layout'; tabId: string } | null
export function validateWorkspaceSnapshot(input: {
  tabs: TabsState
  panes: Pick<PanesState, 'layouts'>
}): { ok: true } | { ok: false; missingLayoutTabIds: string[] }
```

Add shared workspace actions such as:

```ts
// src/store/workspaceActions.ts
export const createPaneBackedTab = createAction(...)
export const restorePaneBackedTab = createAction(...)
export const hydrateWorkspaceSnapshot = createAction(...)
```

Wire `tabsSlice.ts` and `panesSlice.ts` to handle those actions directly so a single dispatch produces coherent store state for pane-backed create/restore/hydrate operations.

- [x] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [x] **Step 5: Refactor and verify**

Tighten payload shapes, remove duplicated pane-backed tab classification, and keep shared action names explicit. Re-run the targeted suite.

Run:

```bash
npm run test:vitest -- test/unit/client/lib/tab-layout-integrity.test.ts test/unit/client/store/workspaceActions.test.ts test/unit/client/store/tabsSlice.test.ts
```

Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/lib/tab-layout-integrity.ts src/store/workspaceActions.ts src/store/tabsSlice.ts src/store/panesSlice.ts test/unit/client/lib/tab-layout-integrity.test.ts test/unit/client/store/workspaceActions.test.ts test/unit/client/store/tabsSlice.test.ts
git commit -m "fix: define workspace layout integrity actions"
```

## Task 2: Migrate Pane-Backed Create And Restore Callers To Shared Actions

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/codingCliThunks.ts`
- Modify: `src/lib/ui-commands.ts`
- Modify: `src/App.tsx`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/MobileTabStrip.tsx`
- Modify: `src/components/TabSwitcher.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/components/SetupWizard.tsx`
- Modify: `src/components/settings/SafetySettings.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `test/unit/client/store/tabsSlice.test.ts`
- Modify: `test/unit/client/store/codingCliThunks.test.ts`
- Modify: `test/unit/client/ui-commands.test.ts`
- Modify: `test/unit/client/components/TabsView.test.tsx`
- Modify: `test/e2e-browser/specs/tab-management.spec.ts`

- [x] **Step 1: Identify or write the failing tests**

Extend tests so they fail until every ordinary pane-backed create or restore path uses the shared workspace actions before fallback removal lands:

- creating a fresh shell tab from keyboard shortcuts or tab-bar controls yields both a tab record and first layout via one shared action
- `ui.command` `tab.create` with pane content uses the shared create action instead of caller-managed `addTab(...)` plus `initLayout(...)`
- `openSessionTab(...)`, reopen flows, and closed-tab copy/open flows use the shared create or restore action
- browser tab, editor tab, attach-to-terminal tab, setup/firewall helper tabs, and background/overview attach flows still work through the shared path
- coding CLI session-view tabs remain exempt and continue to create only the tab/session view state they need

- [x] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- test/unit/client/store/tabsSlice.test.ts test/unit/client/store/codingCliThunks.test.ts test/unit/client/ui-commands.test.ts test/unit/client/components/TabsView.test.tsx
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-management.spec.ts
```

Expected: FAIL because callers still dispatch `addTab(...)` and `initLayout(...)` separately or otherwise bypass the shared create/restore actions.

- [x] **Step 3: Migrate callers to the shared workspace actions**

Rules:

- pane-backed tabs are created or restored only through the shared workspace actions
- `addTab(...)`, `initLayout(...)`, and `restoreLayout(...)` remain reducer primitives, not direct pane-backed UI orchestration APIs
- first-time auto-tab creation in `App.tsx` uses the shared pane-backed create action so disabling fallback later does not break normal new-tab flows
- attach/open flows preserve `createRequestId`, `resumeSessionId`, `terminalId`, `sessionRef`, and exact restore metadata
- session-view coding tabs created by `createCodingCliTab` stay on their exempt path unless they intentionally become pane-backed

- [x] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [x] **Step 5: Refactor and verify**

Collapse duplicated initial pane-content builders into the shared create helpers where sensible, then re-run the targeted suite plus the exact-session browser regression.

Run:

```bash
npm run test:vitest -- test/unit/client/store/tabsSlice.test.ts test/unit/client/store/codingCliThunks.test.ts test/unit/client/ui-commands.test.ts test/unit/client/components/TabsView.test.tsx
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-management.spec.ts test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
```

Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/store/tabsSlice.ts src/store/codingCliThunks.ts src/lib/ui-commands.ts src/App.tsx src/components/TabBar.tsx src/components/MobileTabStrip.tsx src/components/TabSwitcher.tsx src/components/context-menu/ContextMenuProvider.tsx src/components/TabsView.tsx src/components/SetupWizard.tsx src/components/settings/SafetySettings.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx test/unit/client/store/tabsSlice.test.ts test/unit/client/store/codingCliThunks.test.ts test/unit/client/ui-commands.test.ts test/unit/client/components/TabsView.test.tsx test/e2e-browser/specs/tab-management.spec.ts test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
git commit -m "fix: route pane-backed tabs through workspace actions"
```

## Task 3: Replace Fallback And Repair-By-Fabrication With Explicit Corruption UI

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/layoutMirrorMiddleware.ts`
- Create: `src/components/panes/MissingLayoutError.tsx`
- Modify: `src/components/TabContent.tsx`
- Modify: `src/components/panes/PaneLayout.tsx`
- Modify: `test/unit/client/store/tabsSlice.test.ts`
- Modify: `test/unit/client/components/TabContent.test.tsx`
- Modify: `test/unit/client/components/panes/PaneLayout.test.tsx`
- Modify: `test/unit/client/layout-mirror-middleware.test.ts`
- Create: `test/e2e-browser/specs/tab-layout-integrity.spec.ts`

- [x] **Step 1: Identify or write the failing tests**

Add tests that assert the corrected corruption behavior once ordinary create paths already use coherent workspace actions:

- an existing pane-backed tab with no layout renders the explicit missing-layout error surface
- `PaneLayout` does not dispatch `initLayout(...)` for an already-existing pane-backed tab missing its layout
- `TabContent` and the error surface dispatch no `terminal.create`, no `addTerminalRestoreRequestId(...)`, and no synthesized `New Tab` or blank coding fallback
- `openSessionTab(...)` treats `existing tab, missing layout` as corruption and does not repair it by calling `initLayout(...)`
- `layoutMirrorMiddleware` stops fabricating `fallbackSessionRef` for corrupted no-layout pane-backed tabs
- a browser boot from deliberately skewed persisted state shows the error surface instead of replacement content

- [x] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TabContent.test.tsx test/unit/client/components/panes/PaneLayout.test.tsx test/unit/client/store/tabsSlice.test.ts test/unit/client/layout-mirror-middleware.test.ts
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-layout-integrity.spec.ts
```

Expected: FAIL because current `TabContent`, `PaneLayout`, `layoutMirrorMiddleware`, and `openSessionTab(...)` still synthesize or repair layouts for missing-layout tabs.

- [x] **Step 3: Implement explicit corruption rendering and guards**

Implementation rules:

- `TabContent.tsx` detects existing pane-backed tabs with missing layouts before building fallback content
- `MissingLayoutError.tsx` renders stable user-facing copy plus deterministic test hooks
- `PaneLayout.tsx` only auto-initializes for explicitly new local creation workflows, not for existing persisted or hydrated tabs
- `tabsSlice.ts` removes repair-by-fabrication for existing missing-layout tabs in `openSessionTab(...)` and any similar path
- `layoutMirrorMiddleware.ts` mirrors actual pane state only; corrupted existing tabs with no layout stay visible in the tab list but do not export fabricated session identity
- no corruption render path may call `initLayout(...)`, `addTerminalRestoreRequestId(...)`, or mint fallback terminal/browser/editor content

- [x] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [x] **Step 5: Refactor and verify**

Tighten error copy, remove dead fallback branches for the corrupted-existing-tab case, and re-run the targeted suite plus the exact-session browser regression.

Run:

```bash
npm run test:vitest -- test/unit/client/components/TabContent.test.tsx test/unit/client/components/panes/PaneLayout.test.tsx test/unit/client/store/tabsSlice.test.ts test/unit/client/layout-mirror-middleware.test.ts
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-layout-integrity.spec.ts test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
```

Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/store/layoutMirrorMiddleware.ts src/components/panes/MissingLayoutError.tsx src/components/TabContent.tsx src/components/panes/PaneLayout.tsx src/store/tabsSlice.ts test/unit/client/components/TabContent.test.tsx test/unit/client/components/panes/PaneLayout.test.tsx test/unit/client/store/tabsSlice.test.ts test/unit/client/layout-mirror-middleware.test.ts test/e2e-browser/specs/tab-layout-integrity.spec.ts test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
git commit -m "fix: surface missing layouts as corruption"
```

## Task 4: Persist, Bootstrap, And Sync The Workspace Atomically

**Files:**
- Create: `src/store/workspacePersistence.ts`
- Modify: `src/store/storage-keys.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/crossTabSync.ts`
- Modify: `src/lib/terminal-restore.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `test/unit/client/store/workspacePersistence.test.ts`
- Modify: `test/unit/client/store/crossTabSync.test.ts`
- Modify: `test/unit/client/store/panesPersistence.test.ts`
- Modify: `test/unit/client/store/persistBroadcast.test.ts`
- Modify: `test/unit/client/store/persistedState.test.ts`
- Modify: `test/unit/client/store/storage-migration.test.ts`
- Modify: `test/unit/client/store/tabsPersistence.test.ts`
- Modify: `test/unit/lib/terminal-restore.test.ts`
- Modify: `test/unit/lib/visible-first-audit-seed-browser-storage.test.ts`
- Modify: `test/e2e-browser/perf/seed-browser-storage.ts`
- Modify: `test/e2e-browser/perf/run-sample.ts`
- Modify: `test/e2e-browser/specs/multi-client.spec.ts`
- Modify: `test/e2e-browser/specs/tab-layout-integrity.spec.ts`
- Modify: `test/e2e-browser/specs/terminal-exact-session-identity.spec.ts`

- [x] **Step 1: Identify or write the failing tests**

Add or extend tests for the atomic snapshot contract:

- one persisted workspace payload contains `tabs` and `panes` together under the new authoritative storage key
- `tabsSlice.ts` and `panesSlice.ts` bootstrap through the same combined snapshot loader and do not independently bless skewed split-key state as healthy when the combined key exists
- `cleanOrphanedLayouts(...)` and any other bootstrap cleanup logic use tab IDs from that same loaded workspace snapshot rather than performing a fresh direct `TABS_STORAGE_KEY` read
- legacy split keys still load only when the combined key is absent, and invalid legacy combinations are surfaced as corruption rather than silently normalized into healthy state
- cross-tab sync hydrates both slices from one combined payload and never applies a new `tabs` generation without matching `panes`
- invalid state with pane-backed tabs missing layouts is rejected for authoritative persistence
- `terminal-restore.ts` bootstraps restore request IDs from the same authoritative combined workspace snapshot that Redux bootstraps from, while still honoring legacy split snapshots only when the combined key is absent
- two pages syncing through the combined key do not synthesize fallback layouts for hidden tabs
- panes write failures after a successful tabs write can no longer advance authoritative persisted state
- compatibility mirrors for `freshell.tabs.v2` and `freshell.panes.v2` are emitted only from the validated combined snapshot, and storage seed helpers / low-level persistence tests are updated to assert that new contract

- [x] **Step 2: Run the focused tests to verify failure**

Run:

```bash
npm run test:vitest -- test/unit/client/store/workspacePersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/persistBroadcast.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/lib/terminal-restore.test.ts test/unit/lib/visible-first-audit-seed-browser-storage.test.ts
npm run test:e2e:chromium -- test/e2e-browser/specs/multi-client.spec.ts test/e2e-browser/specs/tab-layout-integrity.spec.ts test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
```

Expected: FAIL because persistence still writes split keys independently, bootstrap still reads split keys independently, and cross-tab sync still hydrates `tabs` and `panes` separately.

- [x] **Step 3: Implement combined workspace persistence and hydrate**

Implementation rules:

- add a new authoritative workspace storage key in `storage-keys.ts`
- `workspacePersistence.ts` owns parse/load/serialize for the combined snapshot and memoizes bootstrap reads so both slices see the same loaded workspace
- `loadPersistedTabs()` and `loadPersistedPanes()` become compatibility facades over that shared loader so existing callers/tests can migrate without reintroducing separate authority
- `persistMiddleware.ts` builds one validated combined workspace payload and writes the authoritative key before the required compatibility mirrors
- if `validateWorkspaceSnapshot(...)` fails, `persistMiddleware` logs a clear integrity error and skips the authoritative write entirely
- `tabsSlice.ts`, `panesSlice.ts`, and `cleanOrphanedLayouts(...)` bootstrap via the shared workspace loader instead of separate direct `localStorage.getItem(...)` reads for authority
- `terminal-restore.ts` reads restore IDs through the same shared workspace loader or a dedicated helper built on it, so reload bookkeeping sees the exact same migrated snapshot as Redux bootstrap
- `crossTabSync.ts` hydrates the shared workspace snapshot with one shared action, seeds its dedupe state from the authoritative combined key, and ignores split-key mirror events for authority once the combined key exists
- compatibility mirrors for `freshell.tabs.v2` and `freshell.panes.v2` stay downstream-only, are generated from the same validated snapshot, and are covered by the storage/broadcast helper tests

- [x] **Step 4: Run the focused tests to verify pass**

Run the command from Step 2.

Expected: PASS

- [x] **Step 5: Refactor and verify**

Remove duplicated split-key parsing where possible, keep the legacy fallback boundary narrow, and re-run the targeted suite plus the browser regression set that exercises switching, reload, and multi-client sync.

Run:

```bash
npm run test:vitest -- test/unit/client/store/workspacePersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/persistBroadcast.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/lib/terminal-restore.test.ts test/unit/lib/visible-first-audit-seed-browser-storage.test.ts
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-layout-integrity.spec.ts test/e2e-browser/specs/tab-management.spec.ts test/e2e-browser/specs/multi-client.spec.ts test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
```

Expected: PASS

- [x] **Step 6: Commit**

```bash
git add src/store/workspacePersistence.ts src/store/storage-keys.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/crossTabSync.ts src/lib/terminal-restore.ts src/store/tabsSlice.ts src/store/panesSlice.ts test/unit/client/store/workspacePersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/persistBroadcast.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/lib/terminal-restore.test.ts test/unit/lib/visible-first-audit-seed-browser-storage.test.ts test/e2e-browser/perf/seed-browser-storage.ts test/e2e-browser/perf/run-sample.ts test/e2e-browser/specs/multi-client.spec.ts test/e2e-browser/specs/tab-layout-integrity.spec.ts test/e2e-browser/specs/tab-management.spec.ts test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
git commit -m "fix: persist workspace snapshots atomically"
```

## Task 5: Final Verification

**Files:**
- Modify: `docs/plans/2026-03-22-tab-layout-integrity-fix.md`

- [x] **Step 1: Run the highest-value focused regression set**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/tab-layout-integrity.test.ts test/unit/client/store/workspaceActions.test.ts test/unit/client/store/workspacePersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/persistBroadcast.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/storage-migration.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/codingCliThunks.test.ts test/unit/client/ui-commands.test.ts test/unit/client/components/TabContent.test.tsx test/unit/client/components/panes/PaneLayout.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/layout-mirror-middleware.test.ts test/unit/lib/terminal-restore.test.ts test/unit/lib/visible-first-audit-seed-browser-storage.test.ts
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-layout-integrity.spec.ts test/e2e-browser/specs/tab-management.spec.ts test/e2e-browser/specs/multi-client.spec.ts test/e2e-browser/specs/terminal-exact-session-identity.spec.ts
```

Expected: PASS

- [x] **Step 2: Run the repo-required broad suite**

Run:

```bash
FRESHELL_TEST_SUMMARY="tab layout integrity fix" npm test
```

Expected: PASS

- [x] **Step 3: Check coordinator status**

Run:

```bash
npm run test:status
```

Expected: latest relevant entries show success for the full suite run you just completed.

- [x] **Step 4: Update the plan checklist if reality differed**

If implementation required small file-list or command adjustments, update this plan so it remains an accurate execution record. Do not soften acceptance criteria.

- [x] **Step 5: Commit the final state**

```bash
git add docs/plans/2026-03-22-tab-layout-integrity-fix.md
git commit -m "docs: finalize tab layout integrity plan"
```

- [x] **Step 6: Stop**

Execution is complete only when the focused regressions and `npm test` pass for legitimate reasons, with no weakened valid tests and no fallback reintroduced for missing-layout corruption.
