# Tab Title Source Precedence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make durable session/history tab names survive later generic terminal runtime titles, while still allowing plain single-pane terminals to surface useful runtime titles when nothing stronger exists.

**Architecture:** Add explicit title-source semantics: tabs get an authoritative `titleSource`, panes get authoritative `paneTitleSources`, and display resolution follows `user > stable > runtime > derived`. Keep `titleSetByUser` and `paneTitleSetByUser` as compatibility mirrors derived from those sources in reducers and persistence, so the fix lands cleanly without a repo-wide cleanup. Raw xterm `onTitleChange` becomes pane-only runtime metadata; durable session/rename paths flow through one stable-title sync thunk that updates pane state plus eligible single-pane tab state.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, xterm.js, Vitest, Playwright

---

## User-Visible Target

After this lands:

- A history/session tab that shows `codex resume ...` or any other durable title keeps that visible label after later OSC titles like `codex`.
- Single-pane shell and CLI tabs that do not have a stronger stable title can still show runtime titles such as `vim README.md`.
- Single-pane tab labels, pane headers, mobile strip labels, tab switcher labels, sidebar fallback items, persisted state, and reopened tabs all follow the same precedence.
- Durable titles seeded from history, terminal/session rename flows, overview/background-session attach flows, and copied tab snapshots are marked explicitly instead of relying on “custom string means stable” heuristics.

## Contracts And Invariants

1. Title precedence is semantic, not heuristic: `user > stable > runtime > derived`.
2. Raw xterm `onTitleChange` is never durable tab state. It only writes pane runtime metadata.
3. `terminal.title.updated` and explicit rename flows are the durable/stable path.
4. `titleSource` and `paneTitleSources` are authoritative. `titleSetByUser` and `paneTitleSetByUser` remain as compatibility mirrors derived from them until a separate cleanup.
5. `addTab({ title })` must not infer `stable` just because the string is non-default. Stable titles are opt-in at the call sites that truly own durable names.
6. Content replacement must only clear `derived` and `runtime` pane titles back to derived defaults. `stable` and `user` pane titles survive non-destructive lifecycle updates.
7. Any helper that computes visible tab labels must receive pane source metadata as input; otherwise it cannot implement precedence correctly.
8. Browser acceptance must use a real shell PTY emitting a real OSC title while the tab is backgrounded.

## Root Cause Summary

- [`src/components/TerminalView.tsx`](src/components/TerminalView.tsx) currently handles xterm `onTitleChange` by writing the cleaned runtime title directly into both tab state and pane state whenever `titleSetByUser` is false.
- History/session tabs start with meaningful titles but no stronger guard than “not user-set”, so a later generic runtime title like `codex` overwrites them.
- [`src/lib/tab-title.ts`](src/lib/tab-title.ts) prefers a single-pane stored pane title over a non-user tab title, so once the pane title is downgraded, the visible tab label downgrades too.
- The visible symptom appears during tab switching, but the mutation happens in the runtime title listener, not in the tab activation path.

## Strategy Gate

- **Chosen:** authoritative source metadata plus compatibility mirrors.
  Reason: it fixes the bug cleanly without forcing a repo-wide removal of `titleSetByUser` / `paneTitleSetByUser` in the same change.
- **Chosen:** explicit stable-title seeds at durable call sites.
  Reason: generic `addTab({ title }) => stable` would freeze unrelated titles and create regressions in flows that should still yield to runtime titles.
- **Rejected:** “reset every non-user pane title to derived on content replacement.”
  Reason: it would erase stable session/history titles during ordinary lifecycle updates and reintroduce the downgrade in a different form.
- **Rejected:** updating `getTabDisplayTitle` in isolation.
  Reason: the function needs `paneTitleSources`; without updating its callers, execution would either not compile or silently keep the old precedence.
- **Rejected:** keeping `paneTitleSync.ts` semantics separate from the new stable path.
  Reason: a split durable-title API would guarantee drift between history renames, server-promoted titles, and tests.

No user decision is required.

## File Structure

### New Files

- `src/lib/title-source.ts` — shared title-source types, precedence helpers, legacy inference, runtime-title normalization, and exit-title helpers
- `test/unit/client/lib/title-source.test.ts` — unit coverage for precedence, legacy inference, runtime-title normalization, and exit decoration rules
- `test/e2e-browser/specs/tab-title-source-precedence.spec.ts` — real-browser regression that backgrounds a tab, emits a real OSC title, and asserts the visible label stays on the durable title

### Modified Runtime Files

- `src/store/types.ts` — add authoritative `titleSource` to `Tab`, keep `titleSetByUser` as a compatibility mirror
- `src/store/paneTypes.ts` — add `paneTitleSources` to `PanesState`, keep `paneTitleSetByUser` as a compatibility mirror
- `src/store/tabsSlice.ts` — add `setTabTitle`, source-aware hydration/migration, conservative `addTab` defaults, reopen preservation
- `src/store/panesSlice.ts` — route pane title mutations through source-aware helpers, preserve stable/user titles through content replacement, hydrate/restore/reopen `paneTitleSources`
- `src/store/tabRegistrySlice.ts` — store `paneTitleSources` in reopen entries
- `src/store/persistedState.ts` — parse `titleSource` and `paneTitleSources`
- `src/store/persistMiddleware.ts` — persist new source metadata and derive compatibility mirrors during load/migration
- `src/store/crossTabSync.ts` — hydrate `titleSource` and `paneTitleSources` from persisted raw payloads
- `src/store/titleSync.ts` — keep explicit rename coordination and add the shared stable-title sync thunk
- `src/store/paneTitleSync.ts` — compatibility wrapper/re-export for the stable terminal-id title sync path
- `src/lib/tab-title.ts` — source-aware visible tab-label resolution
- `src/store/selectors/sidebarSelectors.ts` — source-aware fallback titles for sidebar session items
- `src/components/TabBar.tsx` — pass `paneTitleSources` into display-title resolution
- `src/components/MobileTabStrip.tsx` — same as `TabBar`
- `src/components/TabSwitcher.tsx` — same as `TabBar`
- `src/components/TerminalView.tsx` — runtime titles become pane-only, stable titles use the shared thunk, exit handling becomes source-aware
- `src/components/HistoryView.tsx` — session rename path uses the stable terminal-id sync thunk
- `src/components/OverviewView.tsx` — durable terminal titles use explicit stable sources
- `src/components/BackgroundSessions.tsx` — durable attach titles use explicit stable sources
- `src/components/TabsView.tsx` — copied tab/pane snapshot titles use explicit stable sources
- `src/components/SetupWizard.tsx` — fixed workflow tab title uses explicit stable source
- `src/components/settings/SafetySettings.tsx` — fixed workflow tab title uses explicit stable source
- `src/components/context-menu/ContextMenuProvider.tsx` — pass pane sources into display-title helpers and route durable terminal renames through the stable path

### Modified Test Files

- `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- `test/unit/client/components/TerminalView.test.tsx`
- `test/unit/client/components/TabBar.deriveTitle.test.tsx`
- `test/unit/client/components/Sidebar.test.tsx`
- `test/unit/client/store/tab-pane-title-sync.test.ts`
- `test/unit/client/store/tabsSlice.test.ts`
- `test/unit/client/store/tabsSlice.reopen-tab.test.ts`
- `test/unit/client/store/panesSlice.test.ts`
- `test/unit/client/store/panesSlice.restore-layout.test.ts`
- `test/unit/client/store/tabsPersistence.test.ts`
- `test/unit/client/store/panesPersistence.test.ts`
- `test/unit/client/store/crossTabSync.test.ts`
- `test/unit/client/store/persistedState.test.ts`
- `test/e2e/title-sync-flow.test.tsx`

## Task 1: Lock The Regressions First

**Files:**
- Create: `test/e2e-browser/specs/tab-title-source-precedence.spec.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] **Step 1: Write the browser regression that reproduces the user-visible downgrade**

Create `test/e2e-browser/specs/tab-title-source-precedence.spec.ts` with one real-browser scenario:

```ts
import { test, expect } from '../helpers/fixtures.js'

async function selectShellForActiveTab(page: any): Promise<void> {
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await button.isVisible().catch(() => false)) {
      await button.click()
      await page.locator('.xterm').last().waitFor({ state: 'visible', timeout: 30_000 })
      return
    }
  }
  throw new Error('No shell option available for the active tab')
}

test('stable single-pane tab label survives a later background OSC runtime title', async ({
  page,
  harness,
  terminal,
}) => {
  await terminal.waitForTerminal()
  await terminal.waitForPrompt()

  await page.locator('[data-context="tab-add"]').click()
  await harness.waitForTabCount(2)
  await selectShellForActiveTab(page)

  const state = await harness.getState()
  const targetTab = state.tabs.tabs[state.tabs.tabs.length - 1]
  const targetLayout = state.panes.layouts[targetTab.id]
  expect(targetLayout?.type).toBe('leaf')
  const terminalId = targetLayout.content.terminalId as string
  const stableTitle = 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346'

  await page.evaluate(({ tabId, terminalId, stableTitle }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'tabs/updateTab',
      payload: { id: tabId, updates: { title: stableTitle, titleSource: 'stable' } },
    })
    harness?.dispatch({
      type: 'panes/updatePaneTitleByTerminalId',
      payload: { terminalId, title: stableTitle, source: 'stable' },
    })
  }, { tabId: targetTab.id, terminalId, stableTitle })

  const tabs = page.locator('[data-context="tab"]')
  await tabs.first().click()

  await page.evaluate(({ terminalId }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const command =
      "printf '\\033]0;codex\\007'; printf 'hidden-osc-marker\\n'" + String.fromCharCode(13)
    harness?.sendWsMessage({ type: 'terminal.input', terminalId, data: command })
  }, { terminalId })

  await terminal.waitForOutput('hidden-osc-marker', { terminalId, timeout: 30_000 })

  const targetTabLocator = page.locator(`[data-context="tab"][data-tab-id="${targetTab.id}"]`)
  await expect(targetTabLocator).toContainText(stableTitle)

  await targetTabLocator.click()
  await expect(targetTabLocator).toContainText(stableTitle)
})
```

- [ ] **Step 2: Run the browser regression and confirm it is red on current code**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-title-source-precedence.spec.ts
```

Expected: FAIL because the visible tab label downgrades to `codex`.

- [ ] **Step 3: Add the fast hidden-tab lifecycle reproduction**

Extend `test/unit/client/components/TerminalView.lifecycle.test.tsx` with a focused reproduction that:

- seeds a hidden single-pane tab with `titleSource: 'stable'` and `paneTitleSources[tabId][paneId] = 'stable'`
- fires the mocked xterm `onTitleChange` callback with `codex` while that tab is inactive
- reactivates the tab
- asserts tab state, pane state, and visible display title all remain on the stable title

- [ ] **Step 4: Run the lifecycle regression and confirm it is red**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: FAIL because the runtime title callback still mutates the hidden tab’s title state.

- [ ] **Step 5: Commit the red regressions**

```bash
git add test/e2e-browser/specs/tab-title-source-precedence.spec.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "test: lock tab title precedence regressions"
```

## Task 2: Add Explicit Tab Title Sources Without Breaking Existing Callers

**Files:**
- Create: `src/lib/title-source.ts`
- Create: `test/unit/client/lib/title-source.test.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `test/unit/client/store/tabsSlice.test.ts`
- Modify: `test/unit/client/store/tabsPersistence.test.ts`
- Modify: `test/unit/client/store/persistedState.test.ts`

- [ ] **Step 1: Write the helper and tab-slice tests first**

Add `test/unit/client/lib/title-source.test.ts` for:

- `shouldReplaceTitleSource('stable', 'runtime') === false`
- `shouldReplaceTitleSource('runtime', 'stable') === true`
- `inferLegacyTabTitleSource({ titleSetByUser: true }) === 'user'`
- `inferLegacyTabTitleSource({ title: 'Tab 3', titleSetByUser: false }) === 'derived'`
- `normalizeRuntimeTitle('⠋ codex') === 'codex'`
- `shouldDecorateExitTitle('derived') === true`

Extend `test/unit/client/store/tabsSlice.test.ts`, `test/unit/client/store/tabsPersistence.test.ts`, and `test/unit/client/store/persistedState.test.ts` so they cover:

- `addTab()` defaults to `titleSource: 'derived'`
- `addTab({ titleSource: 'stable' })` preserves that explicit source
- `addTab({ title: 'Prompt title' })` does **not** silently become `stable`
- `openSessionTab()` creates/promotes stable titles explicitly
- hydration/load infer missing `titleSource` from legacy persisted tabs
- persisted raw tabs accept and round-trip `titleSource`

- [ ] **Step 2: Run the helper and tab-focused tests red**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/title-source.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistedState.test.ts
```

Expected: FAIL because the tab model still only knows about `titleSetByUser`.

- [ ] **Step 3: Implement authoritative tab title sources with compatibility mirrors**

In `src/lib/title-source.ts`, add:

```ts
export type TitleSource = 'derived' | 'runtime' | 'stable' | 'user'
export type TabTitleSource = Exclude<TitleSource, 'runtime'>

export function shouldReplaceTitleSource(current: TitleSource | undefined, next: TitleSource): boolean {
  const priority = { derived: 0, runtime: 1, stable: 2, user: 3 } as const
  return priority[next] >= priority[current ?? 'derived']
}
```

In `src/store/types.ts` and `src/store/tabsSlice.ts`:

- add `titleSource?: TabTitleSource` to `Tab`
- keep `titleSetByUser?: boolean`, but treat it as a mirror of `titleSource === 'user'`
- add `setTabTitle({ id, title, source })` and route all semantic title changes through it
- keep `updateTab` for non-title fields; if an old call site passes `updates.title` without a source, preserve the current source instead of inventing `stable`
- make `addTab` default to `derived` unless the payload explicitly supplies `titleSource` or legacy `titleSetByUser`
- make `loadInitialTabsState()` / `hydrateTabs()` infer missing sources from legacy payloads conservatively

- [ ] **Step 4: Run the helper and tab-focused tests green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/title-source.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistedState.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/title-source.ts src/store/types.ts src/store/tabsSlice.ts src/store/persistedState.ts test/unit/client/lib/title-source.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistedState.test.ts
git commit -m "refactor: add authoritative tab title sources"
```

## Task 3: Add Pane Title Sources Through Restore, Reopen, Persistence, And Hydration

**Files:**
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/crossTabSync.ts`
- Modify: `test/unit/client/store/panesSlice.test.ts`
- Modify: `test/unit/client/store/panesSlice.restore-layout.test.ts`
- Modify: `test/unit/client/store/tabsSlice.reopen-tab.test.ts`
- Modify: `test/unit/client/store/panesPersistence.test.ts`
- Modify: `test/unit/client/store/crossTabSync.test.ts`

- [ ] **Step 1: Extend the pane reducer and persistence tests first**

Add focused cases for:

- `updatePaneTitle({ source: 'runtime' })` can replace `derived` but cannot replace `stable` or `user`
- `updatePaneTitle({ source: 'stable' })` can replace `runtime`
- `updatePaneContent()` or `mergePaneContent()` only reset `derived` / `runtime` pane titles back to derived defaults
- `updatePaneContent()` does **not** erase `stable` or `user` titles
- `restoreLayout()` accepts and restores `paneTitleSources`
- reopen restores both `paneTitles` and `paneTitleSources`
- persisted/cross-tab payloads accept `paneTitleSources`
- legacy payloads with only `paneTitleSetByUser` still infer the right sources

- [ ] **Step 2: Run the pane-focused tests and confirm they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesSlice.restore-layout.test.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts
```

Expected: FAIL because panes still only track `paneTitleSetByUser`.

- [ ] **Step 3: Implement authoritative pane title sources with compatibility mirrors**

In `src/store/paneTypes.ts` and `src/store/panesSlice.ts`:

- add `paneTitleSources: Record<string, Record<string, PaneTitleSource>>`
- keep `paneTitleSetByUser` in runtime state, but update it as a mirror of `paneTitleSources === 'user'`
- route every pane title mutation through a small helper like:

```ts
function setPaneTitleWithSource(state: PanesState, input: {
  tabId: string
  paneId: string
  title: string
  source: PaneTitleSource
}) { ... }
```

- make `updatePaneTitle` and `updatePaneTitleByTerminalId` accept `source`
- make `updatePaneContent` / `mergePaneContent` preserve `stable` and `user` sources
- make `restoreLayout`, reopen, persistence load, and cross-tab hydration round-trip `paneTitleSources`

Update reopen plumbing:

- `ClosedTabEntry` in `src/store/tabRegistrySlice.ts` stores `paneTitleSources`
- `closeTab()` records them
- `reopenClosedTab()` passes them into `restoreLayout()`

- [ ] **Step 4: Run the pane-focused tests green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesSlice.restore-layout.test.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/paneTypes.ts src/store/panesSlice.ts src/store/tabRegistrySlice.ts src/store/tabsSlice.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/crossTabSync.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesSlice.restore-layout.test.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts
git commit -m "refactor: track pane title sources through restore and hydration"
```

## Task 4: Make Visible Tab Labels Source-Aware Everywhere They Render

**Files:**
- Modify: `src/lib/tab-title.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/MobileTabStrip.tsx`
- Modify: `src/components/TabSwitcher.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `test/unit/client/store/tab-pane-title-sync.test.ts`
- Modify: `test/unit/client/components/TabBar.deriveTitle.test.tsx`
- Modify: `test/unit/client/components/Sidebar.test.tsx`

- [ ] **Step 1: Turn the existing title-sync tests into a precedence matrix**

Extend the tests so they cover:

- single-pane `stable` tab title beats a later `runtime` pane title
- single-pane `stable` pane title beats a `derived` tab title
- single-pane `runtime` pane title still drives display when the tab source is `derived`
- multi-pane tabs ignore pane `runtime` / `stable` titles for the overall tab label
- sidebar fallback session items prefer the strongest durable title, not raw `paneTitle || tab.title`

- [ ] **Step 2: Run the display tests and confirm they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/TabBar.deriveTitle.test.tsx test/unit/client/components/Sidebar.test.tsx
```

Expected: FAIL because the display logic still treats non-user single-pane titles as interchangeable.

- [ ] **Step 3: Implement source-aware display resolution and update all callers**

Update `src/lib/tab-title.ts` so single-pane display uses:

1. tab `user`
2. pane `user`
3. pane `stable`
4. tab `stable`
5. pane `runtime`
6. derived tab / derived pane / fallback

Then update every caller so it supplies `paneTitleSources`:

- `src/components/TabBar.tsx`
- `src/components/MobileTabStrip.tsx`
- `src/components/TabSwitcher.tsx`
- `src/components/context-menu/ContextMenuProvider.tsx`

Use the same precedence in `src/store/selectors/sidebarSelectors.ts` for fallback session items.

- [ ] **Step 4: Run the display tests green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/TabBar.deriveTitle.test.tsx test/unit/client/components/Sidebar.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tab-title.ts src/store/selectors/sidebarSelectors.ts src/components/TabBar.tsx src/components/MobileTabStrip.tsx src/components/TabSwitcher.tsx src/components/context-menu/ContextMenuProvider.tsx test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/TabBar.deriveTitle.test.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "refactor: resolve tab labels by title source precedence"
```

## Task 5: Wire Runtime And Stable Title Events To The New Model

**Files:**
- Modify: `src/store/titleSync.ts`
- Modify: `src/store/paneTitleSync.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/components/SetupWizard.tsx`
- Modify: `src/components/settings/SafetySettings.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `test/e2e/title-sync-flow.test.tsx`
- Modify: `test/unit/client/components/TerminalView.test.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] **Step 1: Rewrite the low-fidelity terminal tests so they defend the new semantics**

Replace the old “last raw xterm title wins” expectations in `test/unit/client/components/TerminalView.test.tsx` with focused cases for:

- `normalizeRuntimeTitle()` behavior
- raw runtime titles updating pane runtime metadata only
- stable titles surviving later runtime titles
- exit decoration applying only to derived/default visible titles

Extend `test/e2e/title-sync-flow.test.tsx` so it proves:

- stable title sync shows in both the pane header and single-pane tab label
- a later runtime pane title does not downgrade that visible label

- [ ] **Step 2: Run the wiring-focused tests and confirm they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/title-sync-flow.test.tsx
```

Expected: FAIL because `TerminalView` still writes raw runtime titles directly into tab state and the durable title path is not source-aware.

- [ ] **Step 3: Implement the stable path, runtime path, and durable-title seed audit**

In `src/store/titleSync.ts`, add:

```ts
export function syncStableTitleByTerminalId(input: {
  terminalId: string
  title: string
}): TitleSyncThunk { ... }
```

That thunk must:

- dispatch `updatePaneTitleByTerminalId({ source: 'stable' })`
- update eligible single-pane tabs with `setTabTitle({ source: 'stable' })`
- leave `user` titles alone

In `src/store/paneTitleSync.ts`, re-export or wrap that stable thunk so old imports migrate cleanly during the change.

In `src/components/TerminalView.tsx`:

- replace raw xterm `updateTab(...)` writes with `updatePaneTitle({ source: 'runtime' })`
- keep throttling/deduping behavior unchanged
- route `terminal.title.updated` through `syncStableTitleByTerminalId(...)`
- when a terminal exits, only decorate derived/default visible titles; if the pane was only showing a `runtime` title, reset it back to derived before applying `(exit N)`

Audit durable title seeds and opt them into `titleSource: 'stable'` explicitly:

- `openSessionTab()` in `src/store/tabsSlice.ts`
- terminal attach/open flows in `src/components/OverviewView.tsx`
- detached terminal attach in `src/components/BackgroundSessions.tsx`
- copied tab/pane snapshot flows in `src/components/TabsView.tsx`
- fixed workflow tabs in `src/components/SetupWizard.tsx` and `src/components/settings/SafetySettings.tsx`
- terminal/session rename flows in `src/components/HistoryView.tsx` and `src/components/context-menu/ContextMenuProvider.tsx`

- [ ] **Step 4: Run the focused tests green, including the original regressions**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/title-sync-flow.test.tsx
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-title-source-precedence.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/titleSync.ts src/store/paneTitleSync.ts src/components/TerminalView.tsx src/components/HistoryView.tsx src/components/OverviewView.tsx src/components/BackgroundSessions.tsx src/components/TabsView.tsx src/components/SetupWizard.tsx src/components/settings/SafetySettings.tsx src/components/context-menu/ContextMenuProvider.tsx test/e2e/title-sync-flow.test.tsx test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix: preserve durable tab titles over runtime terminal titles"
```

## Task 6: Final Regression Sweep And Full Coordinated Suite

**Files:**
- Modify only if verification exposes a real defect

- [ ] **Step 1: Re-run the focused client and browser regression set**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/title-source.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts test/unit/client/store/panesSlice.restore-layout.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/persistedState.test.ts test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TabBar.deriveTitle.test.tsx test/unit/client/components/Sidebar.test.tsx test/e2e/title-sync-flow.test.tsx
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-title-source-precedence.spec.ts
```

Expected: PASS.

- [ ] **Step 2: Re-run the existing regression guards that must stay green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/tabsSlice.test.ts test/unit/client/components/HistoryView.mobile.test.tsx
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

- Covered directly: hidden-tab runtime downgrade, runtime-vs-stable precedence, explicit stable seed call sites, tab/pane restore and reopen semantics, persistence/hydration migration, sidebar fallback titles, exit-title behavior, real-browser OSC background-title behavior.
- Covered by existing guards that must remain green: session-title promotion, unified rename integration, restored-tab hot switching with no replay churn, session-opening flows from history.
- Intentionally not added: provider-dependent `codex resume` or `claude` browser journeys. The browser acceptance target here is Freshell’s handling of a real OSC title event, not external CLI auth/install behavior.
