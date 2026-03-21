# Tab Title Source Precedence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make durable session/history tab names survive later generic terminal runtime titles, while still letting live single-pane terminals show useful raw runtime titles when no stronger durable title exists.

**Architecture:** Split title handling into two layers. Durable tab and pane titles get explicit source metadata (`derived`, `stable`, `user`) in Redux and persistence, while raw xterm/OSC titles move into a separate ephemeral runtime-title slice keyed by pane id and never persist, reopen, cross-tab hydrate, or mirror to the server agent layout store. Tabs and panes share the same source ordering, but runtime titles are eligible differently: tab labels may consult runtime only for the matching live single-pane pane, while pane headers may consult runtime for their own pane regardless of tab shape.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, xterm.js, Vitest, Playwright

---

## User-Visible Target

After this lands:

- A history/session tab that shows `codex resume ...` or any other durable title keeps that visible label after later OSC titles like `codex`.
- Plain single-pane terminals and CLI tabs can still surface live runtime titles like `vim README.md`, but those runtime titles disappear on reload/reopen until the live terminal emits them again.
- Tab labels, pane headers, mobile/tab-switcher labels, sidebar fallback items, reopened tabs, and cross-tab hydrated state all follow the same durable precedence rules.
- Raw runtime titles no longer mutate durable tab state, so attach/replay/hidden-tab reveal cannot downgrade a stable session title.
- Agent-layout mirroring preserves durable title semantics, so remote rename/swap/attach flows do not silently strip a stable title back to a derived one.

## Contracts And Invariants

1. Durable precedence is semantic, not heuristic: `user > stable > derived`. Runtime titles are never durable state and are only consulted at render time.
2. Raw xterm `onTitleChange` is ephemeral pane metadata only. It never writes durable tab state and never persists to storage, reopen snapshots, cross-tab sync, or mirrored layout payloads.
3. `terminal.title.updated`, history/session rename flows, copied-tab snapshot titles, prompt-derived coding-CLI titles, and explicit rename flows are the durable path.
4. `titleSource` and `paneTitleSources` are authoritative durable state. `titleSetByUser` and `paneTitleSetByUser` remain compatibility mirrors derived from them until a later cleanup.
5. `addTab({ title })` must not infer `stable` just because the string is non-default. Durable titles are opt-in at the call sites that truly own them.
6. Durable pane title updates clear any runtime title for that pane. Content replacement, terminal identity changes within a pane, and terminal exit also clear runtime titles for affected panes.
7. Derived pane titles can be recomputed on content replacement. Stable and user pane titles must survive non-destructive lifecycle updates.
8. Tab-label and pane-header helpers must use separate runtime-eligibility rules: tab labels may only read runtime titles for the matching single-pane live pane, while pane headers may read runtime titles for their own pane.
9. Legacy persisted state missing source metadata must normalize explicitly instead of guessing ad hoc: `user` when the legacy boolean is true; otherwise `derived` only when the stored title still matches the default/current derived title for that entity, else `stable`.
10. Legacy reducer payloads that still write `titleSetByUser` / `setByUser` must normalize through the new source model instead of bypassing it.
11. Browser acceptance must use a real shell PTY emitting a real OSC title while the tab is backgrounded.
12. Layout mirroring to the server agent store must round-trip durable title metadata, not runtime metadata.

## Root Cause Summary

- [`src/components/TerminalView.tsx`](src/components/TerminalView.tsx) currently mirrors xterm `onTitleChange` straight into both tab state and pane state whenever `titleSetByUser` is false.
- History/session tabs start with meaningful titles but no stronger protection than “not user-set”, so a later generic runtime title like `codex` overwrites them.
- [`src/lib/tab-title.ts`](src/lib/tab-title.ts) treats non-user single-pane tab titles and pane titles as interchangeable, so once the pane title is downgraded the visible label downgrades too.
- The visible symptom happens while switching tabs, but the mutation occurs in the runtime title listener, not in the tab activation path.

## Strategy Gate

- **Chosen:** durable source metadata plus a separate ephemeral runtime-title slice.
  Reason: this matches the approved “proper fix” architecture and prevents stale OSC titles from becoming persisted pane state.
- **Chosen:** explicit durable-title seeds at the call sites that truly own meaningful titles.
  Reason: `addTab({ title }) => stable` would freeze unrelated titles and create regressions in flows that should still yield to a better later durable title.
- **Chosen:** mirror only durable title metadata to the server agent layout store.
  Reason: agent/layout snapshots should preserve stable semantics, but raw runtime titles are local transient UI state and should not leak into that protocol.
- **Chosen:** normalize legacy persisted non-user titles to `stable` unless they still match the current derived/default title.
  Reason: old storage lost the runtime-vs-stable distinction already; preserving known meaningful titles is safer than downgrading every historical session title during the upgrade.
- **Rejected:** storing `runtime` inside `paneTitleSources` and persisting it.
  Reason: that reclassifies raw OSC titles as durable state and contradicts the approved design.
- **Rejected:** fixing only `getTabDisplayTitle`.
  Reason: the downgrade originates in the runtime write path; display-only changes would leave the wrong data model in place.
- **Rejected:** keeping agent-layout mirror paths on the legacy boolean model.
  Reason: server-side attach/swap/rename helpers would keep erasing or mis-moving stable titles after the client fix.

No user decision is required.

## File Structure

### New Files

- `src/lib/title-source.ts` — shared durable title-source types, precedence helpers, legacy inference, runtime-title normalization, and exit-title helpers
- `src/store/paneRuntimeTitleSlice.ts` — ephemeral pane runtime titles keyed by pane id; never persisted or mirrored
- `test/unit/client/lib/title-source.test.ts` — unit coverage for precedence, legacy inference, runtime normalization, and exit decoration rules
- `test/unit/client/store/paneRuntimeTitleSlice.test.ts` — reducer/thunk coverage for ephemeral runtime-title updates and cleanup
- `test/e2e-browser/specs/tab-title-source-precedence.spec.ts` — real-browser regression that backgrounds a tab, emits a real OSC title, and asserts the visible label stays on the durable title

### Modified Runtime Files

- `src/store/types.ts` — add authoritative durable `titleSource` to `Tab` while keeping `titleSetByUser` as a mirror
- `src/store/paneTypes.ts` — add durable `paneTitleSources` to `PanesState`
- `src/store/store.ts` — register the new `paneRuntimeTitleSlice`
- `src/store/tabsSlice.ts` — source-aware tab helpers, legacy inference, stable-source reopening, and durable-title hydration
- `src/store/panesSlice.ts` — durable pane title/source helpers, restore/reopen/persistence plumbing, and derived-title recomputation rules
- `src/store/persistedState.ts` — parse `titleSource` and `paneTitleSources`
- `src/store/persistMiddleware.ts` — bump pane schema version, load/store durable title metadata, and continue excluding ephemeral state
- `src/store/crossTabSync.ts` — hydrate durable title metadata while leaving runtime titles empty
- `src/store/tabRegistrySlice.ts` — store `paneTitleSources` in reopen entries
- `src/store/titleSync.ts` — keep explicit rename coordination and add the shared durable stable-title sync thunk
- `src/store/paneTitleSync.ts` — compatibility wrapper/re-export for the durable terminal-id title sync path
- `src/lib/tab-title.ts` — source-aware visible tab-label resolution using durable title state plus the ephemeral runtime-title slice
- `src/components/panes/PaneContainer.tsx` — source-aware pane-header resolution and rename prefill based on the currently visible title
- `src/store/selectors/sidebarSelectors.ts` — durable-only fallback titles for sidebar session items
- `src/components/TabBar.tsx` — pass durable pane sources and runtime titles into display-title resolution
- `src/components/MobileTabStrip.tsx` — same as `TabBar`
- `src/components/TabSwitcher.tsx` — same as `TabBar`
- `src/components/context-menu/ContextMenuProvider.tsx` — same display-title inputs plus stable-title rename/attach handling
- `src/components/TerminalView.tsx` — raw xterm titles write only to the runtime-title slice; durable title events use the shared stable thunk; exit clears runtime titles
- `src/components/HistoryView.tsx` — session rename path uses the durable stable terminal-id sync thunk
- `src/components/OverviewView.tsx` — durable terminal attach/open titles use explicit stable sources, and terminal rename flows write the correct durable source
- `src/components/BackgroundSessions.tsx` — durable attach titles use explicit stable sources
- `src/components/TabsView.tsx` — copied tab/pane snapshot titles use explicit stable sources
- `src/components/SetupWizard.tsx` — fixed workflow tab title uses explicit stable source
- `src/components/settings/SafetySettings.tsx` — fixed workflow tab title uses explicit stable source
- `src/store/codingCliThunks.ts` — prompt-derived coding-CLI tab titles opt into stable source
- `src/lib/ui-commands.ts` — `tab.create` with an explicit title opts into stable source
- `src/store/layoutMirrorMiddleware.ts` — mirror durable `titleSource` / `paneTitleSources`, not runtime titles
- `server/agent-api/layout-schema.ts` — accept durable title metadata in mirrored layout snapshots
- `server/agent-api/layout-store.ts` — preserve/swap/remove durable pane title sources correctly across rename, attach, split, and swap flows

### Modified Test Files

- `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- `test/unit/client/components/TerminalView.test.tsx`
- `test/unit/client/components/PaneContainer.test.tsx`
- `test/unit/client/components/TabBar.deriveTitle.test.tsx`
- `test/unit/client/components/MobileTabStrip.test.tsx`
- `test/unit/client/components/TabSwitcher.test.tsx`
- `test/unit/client/components/ContextMenuProvider.test.tsx`
- `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- `test/unit/client/store/tab-pane-title-sync.test.ts`
- `test/unit/client/store/tabsSlice.test.ts`
- `test/unit/client/store/tabsSlice.reopen-tab.test.ts`
- `test/unit/client/store/panesSlice.test.ts`
- `test/unit/client/store/panesSlice.restore-layout.test.ts`
- `test/unit/client/store/tabsPersistence.test.ts`
- `test/unit/client/store/panesPersistence.test.ts`
- `test/unit/client/store/crossTabSync.test.ts`
- `test/unit/client/store/persistedState.test.ts`
- `test/unit/client/store/codingCliThunks.test.ts`
- `test/unit/client/store/paneRuntimeTitleSlice.test.ts`
- `test/unit/client/ui-commands.test.ts`
- `test/unit/client/layout-mirror-middleware.test.ts`
- `test/unit/server/agent-layout-schema.test.ts`
- `test/unit/server/agent-layout-store-write.test.ts`
- `test/unit/client/components/OverviewView.test.tsx`
- `test/unit/client/components/BackgroundSessions.test.tsx`
- `test/unit/client/components/TabsView.test.tsx`
- `test/e2e/title-sync-flow.test.tsx`

## Task 1: Lock The Regression First

**Files:**
- Create: `test/e2e-browser/specs/tab-title-source-precedence.spec.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] **Step 1: Write the real-browser regression for the reported downgrade**

Create `test/e2e-browser/specs/tab-title-source-precedence.spec.ts` with one real-browser scenario:

- start from a live shell tab
- create a second real shell tab
- seed the second single-pane tab with the durable title `codex resume 019d1213-9c59-7bb0-80ae-70c74427f346` through the existing durable terminal-id sync path (`syncPaneTitleByTerminalId`) via the test harness
- switch away so that tab is hidden
- send a real OSC title update like `printf '\033]0;codex\007'` into the background PTY
- assert the visible tab text still shows the durable title before and after reselecting the tab

- [ ] **Step 2: Run the browser regression and confirm it is red on current code**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-title-source-precedence.spec.ts
```

Expected: FAIL because the visible tab label downgrades to `codex`.

- [ ] **Step 3: Add the fast hidden-tab lifecycle reproduction**

Extend `test/unit/client/components/TerminalView.lifecycle.test.tsx` with a focused reproduction that:

- seeds a hidden single-pane tab through `syncPaneTitleByTerminalId({ terminalId, title: 'codex resume ...' })`
- fires the mocked xterm `onTitleChange` callback with `codex` while that tab is inactive
- reactivates the tab
- asserts the visible label should still be the durable title

- [ ] **Step 4: Run the lifecycle regression and confirm it is red**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL because the runtime title callback still mutates the hidden tab’s visible title state.

- [ ] **Step 5: Commit the red regressions**

```bash
git add test/e2e-browser/specs/tab-title-source-precedence.spec.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "test: lock tab title downgrade regression"
```

## Task 2: Add Durable Title-Source Semantics For Tabs

**Files:**
- Create: `src/lib/title-source.ts`
- Create: `test/unit/client/lib/title-source.test.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `test/unit/client/store/tabsSlice.test.ts`
- Modify: `test/unit/client/store/tabsPersistence.test.ts`
- Modify: `test/unit/client/store/persistedState.test.ts`

- [ ] **Step 1: Write the helper and tab-model tests first**

Add `test/unit/client/lib/title-source.test.ts` for:

- `shouldReplaceDurableTitleSource('stable', 'stable') === true`
- `shouldReplaceDurableTitleSource('stable', 'derived') === false`
- `inferLegacyTabTitleSource({ titleSetByUser: true }) === 'user'`
- `inferLegacyTabTitleSource({ title: 'Tab 3', titleSetByUser: false }) === 'derived'`
- `inferLegacyTabTitleSource({ title: 'codex resume 019d...', titleSetByUser: false }) === 'stable'`
- `inferLegacyPaneTitleSource({ storedTitle: 'Shell', derivedTitle: 'Shell', titleSetByUser: false }) === 'derived'`
- `inferLegacyPaneTitleSource({ storedTitle: 'codex resume 019d...', derivedTitle: 'Shell', titleSetByUser: false }) === 'stable'`
- `normalizeRuntimeTitle('⠋ codex') === 'codex'`
- `shouldDecorateExitTitle('derived') === true`
- `shouldDecorateExitTitle('stable') === false`

Extend `test/unit/client/store/tabsSlice.test.ts`, `test/unit/client/store/tabsPersistence.test.ts`, and `test/unit/client/store/persistedState.test.ts` so they cover:

- `addTab()` defaults to `titleSource: 'derived'`
- `addTab({ titleSource: 'stable' })` preserves that explicit source
- `addTab({ title: 'Prompt title' })` does not silently become `stable`
- `openSessionTab()` creates stable titles explicitly
- legacy persisted tabs infer default names as `derived` and non-default non-user names as `stable`
- persisted raw tabs accept and round-trip `titleSource`

- [ ] **Step 2: Run the helper and tab-focused tests red**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/title-source.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistedState.test.ts
```

Expected: FAIL because tabs still only know about `titleSetByUser`.

- [ ] **Step 3: Implement durable tab title sources with compatibility mirrors**

In `src/lib/title-source.ts`, add the durable-source helpers:

```ts
export type DurableTitleSource = 'derived' | 'stable' | 'user'

export function shouldReplaceDurableTitleSource(
  current: DurableTitleSource | undefined,
  next: DurableTitleSource,
): boolean {
  const priority = { derived: 0, stable: 1, user: 2 } as const
  return priority[next] >= priority[current ?? 'derived']
}
```

Then update `src/store/types.ts` and `src/store/tabsSlice.ts` to:

- add `titleSource?: DurableTitleSource` to `Tab`
- keep `titleSetByUser?: boolean`, but derive it from `titleSource === 'user'`
- add `setTabTitle({ id, title, source })` for semantic title updates
- keep `updateTab` for non-title fields; if an old call site passes `updates.title` without a source, preserve the current source instead of inventing `stable`
- translate legacy `updateTab(... updates.titleSetByUser)` writes through the source model (`true` -> `user`; `false` only clears an existing `user` source when no explicit `source` was supplied)
- make `addTab` default to `derived` unless the payload explicitly supplies `titleSource` or legacy `titleSetByUser`
- make `loadInitialTabsState()` / `hydrateTabs()` infer missing sources from legacy payloads using the explicit default-vs-non-default rule above

- [ ] **Step 4: Run the helper and tab-focused tests green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/title-source.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistedState.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/title-source.ts src/store/types.ts src/store/tabsSlice.ts src/store/persistedState.ts test/unit/client/lib/title-source.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistedState.test.ts
git commit -m "refactor: add durable tab title sources"
```

## Task 3: Add Durable Pane Title Sources And A Separate Runtime-Title Slice

**Files:**
- Create: `src/store/paneRuntimeTitleSlice.ts`
- Create: `test/unit/client/store/paneRuntimeTitleSlice.test.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/store.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/crossTabSync.ts`
- Modify: `test/unit/client/store/panesSlice.test.ts`
- Modify: `test/unit/client/store/panesSlice.restore-layout.test.ts`
- Modify: `test/unit/client/store/tabsSlice.reopen-tab.test.ts`
- Modify: `test/unit/client/store/panesPersistence.test.ts`
- Modify: `test/unit/client/store/crossTabSync.test.ts`
- Modify: `test/unit/client/store/persistedState.test.ts`

- [ ] **Step 1: Extend the pane/store tests first**

Add focused cases for:

- `updatePaneTitle({ source: 'stable' })` replacing a derived durable title
- `updatePaneTitle({ source: 'stable' })` not overwriting a user durable title
- `updatePaneContent()` / `mergePaneContent()` recomputing only derived durable titles
- `updatePaneContent()` preserving stable and user durable titles
- legacy pane metadata inferring `derived` when the stored title still matches the pane’s current derived title
- legacy pane metadata inferring `stable` when the stored non-user title no longer matches the pane’s current derived title
- `restoreLayout()` accepting and restoring `paneTitleSources`
- reopen restoring both `paneTitles` and `paneTitleSources`
- pane persistence/cross-tab hydration round-tripping `paneTitleSources`
- runtime titles living in `paneRuntimeTitleSlice` only, clearing on close/remove/exit/content replacement/terminal-id replacement, and never appearing in persisted raw payloads

- [ ] **Step 2: Run the pane-focused tests and confirm they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesSlice.restore-layout.test.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/paneRuntimeTitleSlice.test.ts
```

Expected: FAIL because panes still only track `paneTitleSetByUser` and there is no separate runtime-title slice.

- [ ] **Step 3: Implement durable pane sources and ephemeral runtime titles**

Update `src/store/paneTypes.ts`, `src/store/panesSlice.ts`, and `src/store/paneRuntimeTitleSlice.ts` to:

- add `paneTitleSources: Record<string, Record<string, DurableTitleSource>>`
- keep `paneTitleSetByUser` as a compatibility mirror of `paneTitleSources === 'user'`
- add a helper like `setPaneDurableTitleWithSource(state, { tabId, paneId, title, source })`
- keep `updatePaneTitle` / `updatePaneTitleByTerminalId` for durable titles and allow `source`
- normalize legacy `setByUser` payloads through the new source model instead of branching separately
- initialize new panes as `derived`
- make `splitPane`, `addPane`, `swapPanes`, `replacePane`, `closePane`, `removeLayout`, and `restoreLayout` move/clear `paneTitleSources` exactly alongside `paneTitles`
- create `paneRuntimeTitleSlice` keyed by pane id, with actions/thunks for setting and clearing runtime titles by pane id and by terminal id
- clear runtime titles on content replacement, pane close, tab close, layout removal, terminal exit, and any terminal-id change that rebinds a pane to a different live terminal

Update persistence/hydration:

- add `zPaneTitleSources` to `src/store/persistedState.ts`
- bump `PANES_SCHEMA_VERSION` and update both the “already current” and migration paths in `src/store/persistMiddleware.ts` so `paneTitleSources` survives reload
- infer missing `paneTitleSources` from legacy `paneTitleSetByUser` plus the current derived pane title when loading old payloads
- keep `paneRuntimeTitleSlice` out of persistence and cross-tab hydration entirely
- store `paneTitleSources` in `ClosedTabEntry` so reopen preserves durable semantics

- [ ] **Step 4: Run the pane-focused tests green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesSlice.restore-layout.test.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/store/paneRuntimeTitleSlice.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/paneRuntimeTitleSlice.ts src/store/paneTypes.ts src/store/store.ts src/store/panesSlice.ts src/store/tabRegistrySlice.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/crossTabSync.ts test/unit/client/store/paneRuntimeTitleSlice.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesSlice.restore-layout.test.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/persistedState.test.ts
git commit -m "refactor: separate durable pane titles from runtime titles"
```

## Task 4: Make Tab Labels And Pane Headers Source-Aware Everywhere They Render

**Files:**
- Modify: `src/lib/tab-title.ts`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/MobileTabStrip.tsx`
- Modify: `src/components/TabSwitcher.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `test/unit/client/store/tab-pane-title-sync.test.ts`
- Modify: `test/unit/client/components/PaneContainer.test.tsx`
- Modify: `test/unit/client/components/TabBar.deriveTitle.test.tsx`
- Modify: `test/unit/client/components/MobileTabStrip.test.tsx`
- Modify: `test/unit/client/components/TabSwitcher.test.tsx`
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx`
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Modify: `test/e2e/title-sync-flow.test.tsx`

- [ ] **Step 1: Turn the existing display tests into a precedence matrix**

Extend the tests so they cover:

- single-pane durable stable title beating a later runtime title
- single-pane runtime title still driving display when the durable source is only `derived`
- pane headers showing runtime titles only when there is no stronger durable title
- user rename prefilling from the currently visible pane title
- multi-pane tabs ignoring pane runtime titles for the overall tab label
- context-menu copy tab name(s) using the same source-aware display title as TabBar
- sidebar fallback session items preferring the strongest durable title, not raw runtime pane titles

- [ ] **Step 2: Run the display tests and confirm they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/PaneContainer.test.tsx test/unit/client/components/TabBar.deriveTitle.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/e2e/title-sync-flow.test.tsx
```

Expected: FAIL because display helpers still only know about durable pane titles and do not read the separate runtime-title slice.

- [ ] **Step 3: Implement source-aware label resolution**

Update `src/lib/tab-title.ts` so tab labels resolve in this order:

1. strongest durable user title relevant to the tab
2. strongest durable stable title relevant to the tab
3. runtime title only for the matching single-pane live pane
4. derived/default title

Update `src/components/panes/PaneContainer.tsx` so pane headers resolve in this order:

1. pane-specific durable user title
2. pane-specific durable stable title
3. pane-specific runtime title
4. derived pane title

Then update every caller so it passes the new inputs:

- `src/components/TabBar.tsx`
- `src/components/MobileTabStrip.tsx`
- `src/components/TabSwitcher.tsx`
- `src/components/context-menu/ContextMenuProvider.tsx`

In `src/store/selectors/sidebarSelectors.ts`, keep fallback session items on durable titles only; do not let raw runtime titles leak into sidebar session names.

- [ ] **Step 4: Run the display tests green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/PaneContainer.test.tsx test/unit/client/components/TabBar.deriveTitle.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/e2e/title-sync-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tab-title.ts src/components/panes/PaneContainer.tsx src/store/selectors/sidebarSelectors.ts src/components/TabBar.tsx src/components/MobileTabStrip.tsx src/components/TabSwitcher.tsx src/components/context-menu/ContextMenuProvider.tsx test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/PaneContainer.test.tsx test/unit/client/components/TabBar.deriveTitle.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/e2e/title-sync-flow.test.tsx
git commit -m "refactor: resolve visible titles by source precedence"
```

## Task 5: Wire Runtime Events, Stable Events, And Durable Title Seeds To The New Model

**Files:**
- Modify: `src/store/titleSync.ts`
- Modify: `src/store/paneTitleSync.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/components/SetupWizard.tsx`
- Modify: `src/components/settings/SafetySettings.tsx`
- Modify: `src/store/codingCliThunks.ts`
- Modify: `src/lib/ui-commands.ts`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `test/unit/client/components/TerminalView.test.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/unit/client/components/OverviewView.test.tsx`
- Modify: `test/unit/client/components/BackgroundSessions.test.tsx`
- Modify: `test/unit/client/store/codingCliThunks.test.ts`
- Modify: `test/unit/client/ui-commands.test.ts`
- Modify: `test/unit/client/components/TabsView.test.tsx`
- Modify: `test/unit/client/store/tabsSlice.test.ts`

- [ ] **Step 1: Rewrite the wiring tests so they defend the new semantics**

Replace the old “last raw xterm title wins” expectations with focused cases for:

- `normalizeRuntimeTitle()` behavior
- raw runtime titles updating only the runtime-title slice
- durable stable titles surviving later runtime titles
- exit decoration applying only to derived/default visible titles
- `openSessionTab()` upgrading new tabs and both existing-tab branches (`terminalId` lookup and session-layout lookup) to `stable` when they are handed an explicit session title and the current title is still derived
- `openSessionTab`, `createCodingCliTab`, `tab.create`, background attach, overview attach, overview terminal rename, copied-tab open, and fixed workflow tabs using the intended durable source when they provide meaningful names

- [ ] **Step 2: Run the wiring-focused tests and confirm they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/OverviewView.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/store/codingCliThunks.test.ts test/unit/client/ui-commands.test.ts test/unit/client/components/TabsView.test.tsx test/unit/client/store/tabsSlice.test.ts
```

Expected: FAIL because `TerminalView` still writes raw runtime titles into durable title state and durable-title seed call sites are still using derived defaults.

- [ ] **Step 3: Implement the stable path, runtime path, and durable-seed audit**

In `src/store/titleSync.ts`, add a shared durable thunk like:

```ts
export function syncStableTitleByTerminalId(input: {
  terminalId: string
  title: string
}): TitleSyncThunk { ... }
```

That thunk must:

- dispatch the durable pane-title update with `source: 'stable'`
- update eligible single-pane tabs with `setTabTitle({ source: 'stable' })`
- leave user titles alone

Then wire the runtime/stable event paths:

- `src/store/paneTitleSync.ts` re-exports or wraps the durable thunk so old imports stay valid
- `src/components/TerminalView.tsx` routes raw xterm titles into the runtime-title slice only, routes `terminal.title.updated` through the durable stable thunk, and clears runtime titles on exit/content loss/terminal-id rebinding

Audit durable-title seeds and opt them into `titleSource: 'stable'` explicitly:

- `openSessionTab()` in `src/store/tabsSlice.ts`, including both existing-tab branches: the `terminalId` match path and the session-layout “existing matching tab” path when they are still on a derived title and the caller supplied an explicit stable session title
- `createCodingCliTab()` in `src/store/codingCliThunks.ts`
- `tab.create` with an explicit title in `src/lib/ui-commands.ts`
- terminal attach/open flows in `src/components/OverviewView.tsx`
- detached terminal attach in `src/components/BackgroundSessions.tsx`
- copied tab/pane snapshot flows in `src/components/TabsView.tsx`
- fixed workflow tabs in `src/components/SetupWizard.tsx` and `src/components/settings/SafetySettings.tsx`
- terminal/session rename flows in `src/components/HistoryView.tsx`, `src/components/context-menu/ContextMenuProvider.tsx`, and `src/components/OverviewView.tsx`

- [ ] **Step 4: Run the wiring-focused tests green, including the original regressions**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/OverviewView.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/store/codingCliThunks.test.ts test/unit/client/ui-commands.test.ts test/unit/client/components/TabsView.test.tsx test/unit/client/store/tabsSlice.test.ts
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-title-source-precedence.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/titleSync.ts src/store/paneTitleSync.ts src/store/tabsSlice.ts src/components/TerminalView.tsx src/components/HistoryView.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx src/components/TabsView.tsx src/components/SetupWizard.tsx src/components/settings/SafetySettings.tsx src/store/codingCliThunks.ts src/lib/ui-commands.ts src/components/context-menu/ContextMenuProvider.tsx test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/OverviewView.test.tsx test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/store/codingCliThunks.test.ts test/unit/client/ui-commands.test.ts test/unit/client/components/TabsView.test.tsx test/unit/client/store/tabsSlice.test.ts
git commit -m "fix: preserve durable titles over runtime terminal titles"
```

## Task 6: Carry Durable Title Metadata Through Layout Mirror And Agent Layout Store

**Files:**
- Modify: `src/store/layoutMirrorMiddleware.ts`
- Modify: `server/agent-api/layout-schema.ts`
- Modify: `server/agent-api/layout-store.ts`
- Modify: `test/unit/client/layout-mirror-middleware.test.ts`
- Modify: `test/unit/server/agent-layout-schema.test.ts`
- Modify: `test/unit/server/agent-layout-store-write.test.ts`

- [ ] **Step 1: Extend the mirror and agent-layout tests first**

Add focused cases for:

- mirrored `ui.layout.sync` payloads including `tabs[].titleSource` and `paneTitleSources`
- mirrored payloads still excluding runtime titles
- agent-layout schema accepting durable source metadata while remaining tolerant of legacy payloads without them
- agent-layout store preserving stable pane titles across attach/respawn updates
- agent-layout store swapping `paneTitleSources` alongside `paneTitles`
- agent-layout rename helpers setting user source metadata explicitly

- [ ] **Step 2: Run the mirror/layout tests and confirm they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/layout-mirror-middleware.test.ts test/unit/server/agent-layout-schema.test.ts test/unit/server/agent-layout-store-write.test.ts
```

Expected: FAIL because the mirrored payload and server-side layout snapshot still only know about `paneTitleSetByUser`.

- [ ] **Step 3: Implement durable source round-tripping for the agent layout path**

Update:

- `src/store/layoutMirrorMiddleware.ts` to mirror durable `titleSource` and `paneTitleSources`
- `server/agent-api/layout-schema.ts` to accept the new durable title metadata without dropping legacy payloads that omit it
- `server/agent-api/layout-store.ts` to seed derived pane sources, normalize legacy payloads that still only have `paneTitleSetByUser`, preserve stable/user pane titles on attach, recompute only derived titles, and swap/remove `paneTitleSources` correctly

Do not add runtime titles to the mirrored payload.

- [ ] **Step 4: Run the mirror/layout tests green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/layout-mirror-middleware.test.ts test/unit/server/agent-layout-schema.test.ts test/unit/server/agent-layout-store-write.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/layoutMirrorMiddleware.ts server/agent-api/layout-schema.ts server/agent-api/layout-store.ts test/unit/client/layout-mirror-middleware.test.ts test/unit/server/agent-layout-schema.test.ts test/unit/server/agent-layout-store-write.test.ts
git commit -m "refactor: mirror durable title metadata to agent layout store"
```

## Task 7: Final Regression Sweep And Full Coordinated Suite

**Files:**
- Modify only if verification exposes a real defect

- [ ] **Step 1: Re-run the focused client, browser, and mirror regression set**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/title-source.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/paneRuntimeTitleSlice.test.ts test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts test/unit/client/store/panesSlice.restore-layout.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/PaneContainer.test.tsx test/unit/client/components/TabBar.deriveTitle.test.tsx test/unit/client/components/MobileTabStrip.test.tsx test/unit/client/components/TabSwitcher.test.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/codingCliThunks.test.ts test/unit/client/ui-commands.test.ts test/unit/client/layout-mirror-middleware.test.ts test/unit/client/components/TabsView.test.tsx test/e2e/title-sync-flow.test.tsx test/unit/server/agent-layout-schema.test.ts test/unit/server/agent-layout-store-write.test.ts
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-title-source-precedence.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Re-run the existing regression guards that must stay green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/HistoryView.mobile.test.tsx
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-management.spec.ts --grep "restored top tabs stay hot across page reload and still switch without replay"
npm run test:vitest -- --config vitest.server.config.ts --run test/unit/server/session-title-sync.test.ts test/integration/server/unified-rename-integration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full coordinated suite before any merge decision**

Run:

```bash
FRESHELL_TEST_SUMMARY="tab title source precedence" npm test
```

Expected: PASS for the full coordinated suite. If anything fails, stop and fix the real failure before proceeding.

- [ ] **Step 4: Commit any verification-driven fixes**

If verification required follow-up edits:

```bash
git add <relevant files>
git commit -m "test: close tab title precedence verification gaps"
```

If verification is clean, do not create an empty commit.

## Coverage Summary

- Covered directly: hidden-tab runtime downgrade, durable-vs-runtime precedence, explicit durable seed call sites, pane header precedence, tabs/mobile/tab-switcher labels, durable state restore and reopen semantics, persistence/hydration migration, sidebar fallback titles, agent-layout mirror durability, exit-title behavior, and real-browser OSC background-title behavior.
- Covered by existing guards that must remain green: session-title promotion, unified rename integration, restored-tab hot switching with no replay churn, and session-opening flows from history.
- Intentionally not added: provider-dependent `codex resume` or `claude` browser journeys. The browser acceptance target here is Freshell’s handling of a real OSC title event, not external CLI auth/install behavior.
