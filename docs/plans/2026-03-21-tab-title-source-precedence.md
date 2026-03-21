# Tab Title Source Precedence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make durable session/history tab names survive later generic terminal runtime titles, while still allowing plain single-pane terminals to surface useful runtime titles.

**Architecture:** Introduce explicit title-source semantics. Tabs carry a durable `titleSource` (`derived | stable | user`); panes carry `paneTitleSources` (`derived | runtime | stable | user`). Raw xterm `onTitleChange` becomes pane-only runtime metadata. Durable session/terminal rename paths update both pane state and eligible single-pane tab state with `stable` source. Display selectors resolve visible labels by precedence instead of overwrite-by-latest, and hydration migrates legacy boolean-only state into the new source model conservatively.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, xterm.js, Vitest, Playwright

---

## User-Visible Target

After this lands:

- A history/session tab that shows `codex resume ...` or any other durable title must keep that visible tab label after later OSC titles like `codex`.
- Single-pane shell and CLI tabs that do not have a stronger stable title can still show runtime titles such as `vim README.md`.
- Pane headers keep showing the strongest available title: `user > stable > runtime > derived`.
- Hidden-tab reveal, reattach, persistence/hydration, reopen-closed-tab, and sidebar fallback views all preserve the same precedence.
- Terminal exit must not mutate stable or user titles; only derived/default titles may receive an `(exit N)` suffix.

## Contracts And Invariants

1. Title precedence is semantic, not heuristic: `user > stable > runtime > derived`.
2. Tabs never treat raw xterm `onTitleChange` as durable state. Runtime titles may influence single-pane display only through pane state.
3. Durable session/terminal title updates must update both pane state and any eligible single-pane tab state so persistence, reopen, sidebar fallback, and registry snapshots stay consistent.
4. Legacy persisted non-user, non-default titles migrate into the `stable` bucket. Migration must bias toward preserving meaningful labels rather than letting future runtime noise downgrade them.
5. Multi-pane tabs never let one pane’s runtime or stable title hijack the whole tab label unless the user explicitly renamed the tab.
6. `restoreLayout` and `reopenClosedTab` preserve pane title sources, not just title strings.
7. Runtime Redux state becomes source-authoritative. Legacy booleans (`titleSetByUser`, `paneTitleSetByUser`) remain only as derived boundary payloads where existing registry/layout sync consumers still need them.
8. Browser acceptance uses a real shell PTY emitting a real OSC title sequence while the tab is backgrounded.

## Root Cause Summary

- [`src/components/TerminalView.tsx`](src/components/TerminalView.tsx) currently handles xterm `onTitleChange` by writing the cleaned runtime title directly into both `tabs.title` and `panes.paneTitles` whenever `titleSetByUser` is false.
- History/session tabs start life with a meaningful title but no stronger guard than “not user-set”, so a later generic runtime title like `codex` overwrites them.
- [`src/lib/tab-title.ts`](src/lib/tab-title.ts) prefers single-pane stored pane titles over non-user tab titles, so once the pane title is downgraded, the visible tab label downgrades too.
- Tab switching is only the timing surface. The actual mutation is the runtime title listener, not tab activation.

## Strategy Gate

- **Chosen:** use an explicit `stable` source instead of literal `session`.
  Reason: the key distinction is durable vs runtime, and durable titles come from more than indexed sessions: history-opened titles, server-promoted session titles, terminal/session rename overrides, and migrated legacy state.
- **Rejected:** “never update tabs from runtime titles” without adding source metadata.
  Reason: it fixes the symptom but leaves persistence, reopen, sidebar fallback, and future title paths without a coherent precedence model.
- **Rejected:** string heuristics such as “prefer the longer title” or “prefer titles that contain spaces”.
  Reason: brittle across providers and impossible to defend long-term.
- **Rejected:** keeping `titleSetByUser` / `paneTitleSetByUser` as the authoritative runtime model.
  Reason: `user-set vs not-user-set` cannot distinguish durable stable titles from transient runtime titles, which is the core bug.

No user decision is required.

## File Structure

### New Files

- `src/lib/title-source.ts` — shared title-source types, precedence helpers, legacy migration helpers, runtime title normalization, and exit-decoration rules
- `test/unit/client/lib/title-source.test.ts` — unit coverage for precedence, migration defaults, and title normalization
- `test/e2e-browser/specs/tab-title-source-precedence.spec.ts` — real-browser regression that backgrounds a tab, emits a real OSC title, and asserts the visible tab text stays stable

### Modified Runtime Files

- `src/store/types.ts` — replace boolean-only tab title semantics with `titleSource`
- `src/store/tabsSlice.ts` — source-aware tab title reducer, legacy tab hydration, stable-title promotion in `openSessionTab`, reopen preservation
- `src/store/paneTypes.ts` — add `paneTitleSources` to `PanesState`
- `src/store/panesSlice.ts` — source-aware pane title reducer, legacy pane hydration, source-preserving restore/reopen helpers
- `src/store/titleSync.ts` — keep rename coordination here and add a shared `syncStableTitleByTerminalId` thunk
- `src/lib/tab-title.ts` — source-aware visible tab-label resolution
- `src/store/selectors/sidebarSelectors.ts` — use source-aware fallback titles instead of raw `paneTitle || tab.title`
- `src/store/persistedState.ts` — parse `titleSource` and `paneTitleSources`
- `src/store/persistMiddleware.ts` — persist source metadata and migrate legacy pane payloads
- `src/store/crossTabSync.ts` — hydrate `paneTitleSources` / `titleSource` from persisted raw payloads
- `src/store/layoutMirrorMiddleware.ts` — keep emitting derived `paneTitleSetByUser` for existing UI layout consumers
- `src/store/tabRegistrySlice.ts` — preserve `paneTitleSources` in the reopen stack
- `src/store/tabRegistrySync.ts` — derive legacy `titleSetByUser` fingerprints from `titleSource`
- `src/lib/tab-registry-snapshot.ts` — derive legacy `titleSetByUser` booleans from `titleSource`
- `src/components/TerminalView.tsx` — runtime titles become pane-only; stable titles and exit decorations become source-aware
- `src/components/HistoryView.tsx` — session rename path dispatches the stable-title sync thunk
- `src/components/OverviewView.tsx` — terminal-rename path updates local tabs via stable source-aware actions
- `src/components/context-menu/ContextMenuProvider.tsx` — same as OverviewView for terminal rename and open-tab rename surfaces

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
- `test/unit/client/layout-mirror-middleware.test.ts`
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

test('stable single-pane tab label survives a later background OSC title downgrade', async ({
  page,
  harness,
  terminal,
}) => {
  await terminal.waitForTerminal()
  await terminal.waitForPrompt()

  await page.locator('[data-context="tab-add"]').click()
  await harness.waitForTabCount(2)
  await selectShellForActiveTab(page)
  await terminal.waitForPrompt({ timeout: 30_000 })

  const state = await harness.getState()
  const targetTab = state.tabs.tabs[state.tabs.tabs.length - 1]
  const targetLayout = state.panes.layouts[targetTab.id]
  expect(targetLayout?.type).toBe('leaf')
  const targetPaneId = targetLayout.id as string
  const terminalId = targetLayout.content.terminalId as string
  const stableTitle = 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346'

  await page.evaluate(({ tabId, terminalId: tid, stableTitle: label }) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    harness?.dispatch({
      type: 'tabs/updateTab',
      payload: { id: tabId, updates: { title: label, titleSource: 'stable' } },
    })
    harness?.dispatch({
      type: 'panes/updatePaneTitleByTerminalId',
      payload: { terminalId: tid, title: label, source: 'stable' },
    })
  }, { tabId: targetTab.id, terminalId, stableTitle })

  const tabs = page.locator('[data-context="tab"]')
  await tabs.first().click()

  await page.evaluate(({ terminalId: tid }) => {
    window.__FRESHELL_TEST_HARNESS__?.sendWsMessage({
      type: 'terminal.input',
      terminalId: tid,
      data: "printf '\\033]0;codex\\007'; printf 'hidden-osc-marker\\n'",
    })
  }, { terminalId })

  await terminal.waitForOutput('hidden-osc-marker', { terminalId, timeout: 30_000 })

  const targetTabLocator = page.locator(`[data-context="tab"][data-tab-id="${targetTab.id}"]`)
  await expect(targetTabLocator.getByText(stableTitle)).toBeVisible()

  await targetTabLocator.click()
  await expect(targetTabLocator.getByText(stableTitle)).toBeVisible()
})
```

- [ ] **Step 2: Run the browser regression and confirm it is red on current code**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-title-source-precedence.spec.ts
```

Expected: FAIL because the visible tab label downgrades to `codex`.

- [ ] **Step 3: Add the fast hidden-tab lifecycle reproduction**

Extend `test/unit/client/components/TerminalView.lifecycle.test.tsx` with a focused store-level reproduction:

```ts
it('does not let a background runtime title overwrite a stable single-pane tab title', async () => {
  const stableTitle = 'codex resume 019d1213-9c59-7bb0-80ae-70c74427f346'
  const tabId = 'tab-stable'
  const paneId = 'pane-stable'
  const otherTabId = 'tab-other'

  // Preload the hidden tab with a stable title source and a matching stable pane title.
  // The current code still downgrades both when xterm emits "codex".
  // Use the existing xterm mock and expose the onTitleChange callback in this file.
})
```

The assertion should verify all three outcomes after firing the mocked xterm title callback with `codex`:

- `tabs.tabs.find(tab.id === tabId).title` is still the stable title
- `panes.paneTitles[tabId][paneId]` is still the stable title
- `getTabDisplayTitle(...)` still resolves to the stable title

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

## Task 2: Add Explicit Title Sources For Tabs

**Files:**
- Create: `src/lib/title-source.ts`
- Create: `test/unit/client/lib/title-source.test.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `test/unit/client/store/tabsSlice.test.ts`
- Modify: `test/unit/client/store/tabsPersistence.test.ts`
- Modify: `test/unit/client/store/persistedState.test.ts`

- [ ] **Step 1: Write the helper tests first**

Create `test/unit/client/lib/title-source.test.ts` with coverage for:

```ts
describe('shouldReplaceTitleSource', () => {
  it('lets stable replace derived and runtime', () => {
    expect(shouldReplaceTitleSource('derived', 'stable')).toBe(true)
    expect(shouldReplaceTitleSource('runtime', 'stable')).toBe(true)
  })

  it('blocks runtime from replacing stable or user', () => {
    expect(shouldReplaceTitleSource('stable', 'runtime')).toBe(false)
    expect(shouldReplaceTitleSource('user', 'runtime')).toBe(false)
  })
})

describe('inferLegacyTabTitleSource', () => {
  it('maps user-set legacy tabs to user', () => {
    expect(inferLegacyTabTitleSource({ title: 'Ops desk', titleSetByUser: true })).toBe('user')
  })

  it('maps default Tab N titles to derived', () => {
    expect(inferLegacyTabTitleSource({ title: 'Tab 3', titleSetByUser: false })).toBe('derived')
  })

  it('maps legacy custom non-user titles to stable', () => {
    expect(inferLegacyTabTitleSource({ title: 'codex resume 019d...', titleSetByUser: false })).toBe('stable')
  })
})

describe('normalizeRuntimeTitle', () => {
  it('strips spinner/status prefix noise and ignores all-noise titles', () => {
    expect(normalizeRuntimeTitle('⠋ codex')).toBe('codex')
    expect(normalizeRuntimeTitle('***')).toBeNull()
  })
})

describe('shouldDecorateExitTitle', () => {
  it('only decorates derived titles', () => {
    expect(shouldDecorateExitTitle('derived')).toBe(true)
    expect(shouldDecorateExitTitle('stable')).toBe(false)
    expect(shouldDecorateExitTitle('user')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the helper tests red**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/title-source.test.ts
```

Expected: FAIL because `src/lib/title-source.ts` does not exist yet.

- [ ] **Step 3: Extend the tab slice tests for the new semantics**

Add focused cases to `test/unit/client/store/tabsSlice.test.ts` and `test/unit/client/store/tabsPersistence.test.ts`:

- `openSessionTab` creates new tabs with `titleSource: 'stable'`
- `openSessionTab` promotes an existing non-user tab from generic provider label to a stable session title when `title` is supplied
- `openSessionTab` does not overwrite a `user` tab title
- `hydrateTabs` / `loadInitialTabsState` infer `titleSource` from legacy persisted tabs
- tabs persistence keeps `titleSource` while still stripping `lastInputAt`

Also extend `test/unit/client/store/persistedState.test.ts` so `parsePersistedTabsRaw` accepts payloads that include `titleSource`.

- [ ] **Step 4: Run the tab-focused tests and confirm they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/title-source.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistedState.test.ts
```

Expected: FAIL because the runtime model still only knows about `titleSetByUser`.

- [ ] **Step 5: Implement `titleSource` for tabs**

In `src/lib/title-source.ts`, add the canonical model:

```ts
export type TitleSource = 'derived' | 'runtime' | 'stable' | 'user'
export type TabTitleSource = Exclude<TitleSource, 'runtime'>

export function shouldReplaceTitleSource(current: TitleSource | undefined, next: TitleSource): boolean {
  const priority = { derived: 0, runtime: 1, stable: 2, user: 3 } as const
  return priority[next] >= priority[current ?? 'derived']
}
```

Implement the migration helpers there too:

```ts
export function inferLegacyTabTitleSource(input: {
  title?: string
  titleSetByUser?: boolean
}): TabTitleSource {
  if (input.titleSetByUser) return 'user'
  if (!input.title || /^Tab \d+$/.test(input.title)) return 'derived'
  return 'stable'
}
```

Then update `src/store/types.ts` and `src/store/tabsSlice.ts`:

- add `titleSource?: TabTitleSource` to `Tab`
- add a dedicated `setTabTitle` reducer that applies precedence through `shouldReplaceTitleSource`
- make `addTab` infer `titleSource` as:
  - explicit payload `titleSource` when provided
  - `'user'` when legacy `titleSetByUser` is true
  - `'stable'` when the caller passes an explicit non-default title
  - `'derived'` otherwise
- make `loadInitialTabsState()` and `hydrateTabs()` infer `titleSource` from legacy persisted data when missing
- make `openSessionTab()` call `setTabTitle({ source: 'stable' })` for new tabs and existing non-user tabs when a session title is available
- preserve `titleSource` through reopen-stack restore

Do not remove `updateTab`; keep it for non-title fields, but normalize any legacy `updates.titleSetByUser` payload into `titleSource` so old call sites/tests do not silently drift.

- [ ] **Step 6: Run the tab-focused tests green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/lib/title-source.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistedState.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/title-source.ts src/store/types.ts src/store/tabsSlice.ts src/store/persistedState.ts test/unit/client/lib/title-source.test.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/store/persistedState.test.ts
git commit -m "refactor: add explicit tab title sources"
```

## Task 3: Add Pane Title Sources, Persistence, And Reopen/Restore Support

**Files:**
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/tabRegistrySlice.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/crossTabSync.ts`
- Modify: `src/store/layoutMirrorMiddleware.ts`
- Modify: `test/unit/client/store/panesSlice.test.ts`
- Modify: `test/unit/client/store/panesSlice.restore-layout.test.ts`
- Modify: `test/unit/client/store/tabsSlice.reopen-tab.test.ts`
- Modify: `test/unit/client/store/panesPersistence.test.ts`
- Modify: `test/unit/client/store/crossTabSync.test.ts`
- Modify: `test/unit/client/layout-mirror-middleware.test.ts`

- [ ] **Step 1: Extend the reducer and persistence tests before touching code**

Add or extend the following cases:

- `test/unit/client/store/panesSlice.test.ts`
  - `updatePaneTitle({ source: 'runtime' })` can replace `derived`
  - `updatePaneTitle({ source: 'runtime' })` cannot replace `stable`
  - `updatePaneTitle({ source: 'stable' })` can replace `runtime`
  - `updatePaneTitle({ source: 'user' })` cannot be replaced by `stable` or `runtime`
  - `updatePaneContent` resets non-user pane titles back to `derived`
- `test/unit/client/store/panesSlice.restore-layout.test.ts`
  - `restoreLayout` accepts and restores `paneTitleSources`
  - `restoreLayout` keeps restored stable sources attached to the matching pane ids
- `test/unit/client/store/tabsSlice.reopen-tab.test.ts`
  - reopened tabs preserve `tab.titleSource`
  - reopened layouts preserve `paneTitleSources`
- `test/unit/client/store/panesPersistence.test.ts`
  - persisted panes payload includes `paneTitleSources`
  - hydration restores `paneTitleSources`
- `test/unit/client/store/crossTabSync.test.ts`
  - cross-tab hydration accepts `paneTitleSources`
  - legacy `paneTitleSetByUser` payloads still infer the correct sources
- `test/unit/client/layout-mirror-middleware.test.ts`
  - mirrored `paneTitleSetByUser` is derived from `paneTitleSources === 'user'`
  - stable/runtime pane titles do not get mirrored as `setByUser: true`

- [ ] **Step 2: Run the pane-focused tests and confirm they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesSlice.restore-layout.test.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/layout-mirror-middleware.test.ts
```

Expected: FAIL because panes still only track `paneTitleSetByUser`.

- [ ] **Step 3: Implement `paneTitleSources` and keep legacy boundary booleans derived**

In `src/store/paneTypes.ts`:

```ts
import type { TitleSource } from '@/lib/title-source'

export type PaneTitleSource = TitleSource

export interface PanesState {
  layouts: Record<string, PaneNode>
  activePane: Record<string, string>
  paneTitles: Record<string, Record<string, string>>
  paneTitleSources: Record<string, Record<string, PaneTitleSource>>
  // remove paneTitleSetByUser from runtime state
  ...
}
```

In `src/store/panesSlice.ts`, add small helpers and route every title mutation through them:

```ts
function setPaneTitleWithSource(state: PanesState, input: {
  tabId: string
  paneId: string
  title: string
  source: PaneTitleSource
}) { ... }

function setDerivedPaneTitle(state: PanesState, tabId: string, paneId: string, content: PaneContent) { ... }

function inferLegacyPaneTitleSources(...) { ... }
```

Then update all pane lifecycle reducers:

- `initLayout`, `splitPane`, `addPane`, `restoreLayout`, `replacePane`, `mergePaneContent`, `updatePaneContent`, `resetLayout`, `swapPanes`, `closePane`, `removeLayout`, `hydratePanes`
- `updatePaneTitle` should accept `{ source?: PaneTitleSource }` and default to `'user'`
- `updatePaneTitleByTerminalId` should accept and honor `source`
- non-user content replacement must reset the title back to `derived`
- restored layouts must accept both `paneTitles` and `paneTitleSources`

Update reopen plumbing:

- `ClosedTabEntry` in `src/store/tabRegistrySlice.ts` stores `paneTitleSources`
- `closeTab` records them
- `reopenClosedTab` passes them into `restoreLayout`

Update persistence/hydration:

- `parsePersistedPanesRaw` returns `paneTitleSources`
- `loadPersistedPanes()` infers sources from legacy `paneTitleSetByUser` when `paneTitleSources` are absent
- `crossTabSync` hydrates `paneTitleSources`

Update the layout mirror boundary only, not runtime state:

```ts
function derivePaneTitleSetByUser(paneTitleSources: Record<string, Record<string, PaneTitleSource>>) {
  ...
}
```

Use that helper in `src/store/layoutMirrorMiddleware.ts` so the existing server-side agent-layout snapshot schema keeps working.

- [ ] **Step 4: Run the pane-focused tests green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesSlice.restore-layout.test.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/layout-mirror-middleware.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/paneTypes.ts src/store/panesSlice.ts src/store/tabRegistrySlice.ts src/store/tabsSlice.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/crossTabSync.ts src/store/layoutMirrorMiddleware.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/panesSlice.restore-layout.test.ts test/unit/client/store/tabsSlice.reopen-tab.test.ts test/unit/client/store/panesPersistence.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/layout-mirror-middleware.test.ts
git commit -m "refactor: track pane title sources through restore and hydration"
```

## Task 4: Make Visible Tab Labels Source-Aware Everywhere

**Files:**
- Modify: `src/lib/tab-title.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/store/tabRegistrySync.ts`
- Modify: `test/unit/client/store/tab-pane-title-sync.test.ts`
- Modify: `test/unit/client/components/TabBar.deriveTitle.test.tsx`
- Modify: `test/unit/client/components/Sidebar.test.tsx`

- [ ] **Step 1: Turn the existing title-sync tests into a precedence matrix**

Extend `test/unit/client/store/tab-pane-title-sync.test.ts` so it covers:

- single-pane `stable` pane title beats a `derived` tab title
- single-pane `stable` tab title beats a later `runtime` pane title
- single-pane `runtime` pane title still drives display when the tab source is `derived`
- multi-pane tabs ignore runtime/stable pane titles for the overall tab label
- shared-terminal updates keep both single-pane tabs stable when their tab source is not user

Extend `test/unit/client/components/TabBar.deriveTitle.test.tsx` with fixture state that includes `titleSource` and `paneTitleSources`:

- `stable` tab title over `runtime` pane title
- `runtime` pane title over `derived` tab title
- `stable` pane title over `derived` tab title

Extend `test/unit/client/components/Sidebar.test.tsx` with one fallback session case where:

- the tab has `titleSource: 'stable'`
- the pane title has `source: 'runtime'`
- the sidebar item must show the stable session title, not the runtime pane title

- [ ] **Step 2: Run the display tests and confirm they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/TabBar.deriveTitle.test.tsx test/unit/client/components/Sidebar.test.tsx
```

Expected: FAIL because the display logic still treats any non-user single-pane stored title as interchangeable.

- [ ] **Step 3: Implement source-aware display resolution**

Update `src/lib/tab-title.ts` so single-pane display uses this candidate order:

1. tab `user`
2. pane `user`
3. pane `stable`
4. tab `stable`
5. pane `runtime`
6. derived tab name / derived pane title / fallback tab string

Concrete shape:

```ts
function getSinglePaneStoredTitleState(...) {
  return {
    title: paneTitles?.[layout.id],
    source: paneTitleSources?.[layout.id] ?? inferLegacyPaneTitleSource(...),
  }
}
```

Use the same precedence in `src/store/selectors/sidebarSelectors.ts` for fallback session items instead of raw `paneTitle || tab.title`.

Update the registry helpers:

- `src/lib/tab-registry-snapshot.ts`
- `src/store/tabRegistrySync.ts`

They should derive legacy `titleSetByUser` booleans from `tab.titleSource === 'user'` so close-tab heuristics and revision fingerprints still behave exactly as before.

- [ ] **Step 4: Run the display tests green**

Run:

```bash
npm run test:vitest -- --run test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/TabBar.deriveTitle.test.tsx test/unit/client/components/Sidebar.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tab-title.ts src/store/selectors/sidebarSelectors.ts src/lib/tab-registry-snapshot.ts src/store/tabRegistrySync.ts test/unit/client/store/tab-pane-title-sync.test.ts test/unit/client/components/TabBar.deriveTitle.test.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "refactor: resolve tab labels by title source precedence"
```

## Task 5: Wire Runtime And Stable Title Events To The New Model

**Files:**
- Modify: `src/store/titleSync.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/HistoryView.tsx`
- Modify: `src/components/OverviewView.tsx`
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `test/e2e/title-sync-flow.test.tsx`
- Modify: `test/unit/client/components/TerminalView.test.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] **Step 1: Rewrite the low-fidelity tests so they stop defending the bug**

Replace the old “last raw xterm title wins” expectations in `test/unit/client/components/TerminalView.test.tsx` with two focused behaviors:

- `normalizeRuntimeTitle` strips prefix noise and ignores all-noise input
- exit decoration only applies to `derived` titles, not `stable` or `user`

Extend `test/e2e/title-sync-flow.test.tsx` to prove the stable path end-to-end in DOM terms:

```ts
it('shows stable title sync in the pane header and single-pane tab label, and later runtime updates do not downgrade it', async () => {
  // seed a single-pane terminal
  // dispatch stable title sync for term-1
  // assert both PaneHeader and TabBar show the stable title
  // dispatch updatePaneTitle({ source: 'runtime', title: 'codex' })
  // assert the visible labels still show the stable title
})
```

Keep the lifecycle regression from Task 1 in this same task’s focused suite.

- [ ] **Step 2: Run the wiring-focused tests and confirm they fail**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/title-sync-flow.test.tsx
```

Expected: FAIL because `TerminalView` still writes raw runtime titles directly into tab state and still decorates all non-user titles on exit.

- [ ] **Step 3: Implement the new runtime vs stable wiring**

In `src/store/titleSync.ts`, add a shared stable-path thunk:

```ts
export function syncStableTitleByTerminalId(input: {
  terminalId: string
  title: string
}): TitleSyncThunk { ... }
```

That thunk must:

- dispatch `updatePaneTitleByTerminalId({ source: 'stable' })`
- find eligible tabs and dispatch `setTabTitle({ source: 'stable' })` for:
  - tabs whose layout is a single leaf terminal with the matching `terminalId`
  - tabs with matching `tab.terminalId` but no layout yet

Then wire every durable caller to that thunk:

- `HistoryView.renameSession`
- `TerminalView` handling `terminal.title.updated`
- terminal/session rename flows in `OverviewView` and `ContextMenuProvider`

In `src/components/TerminalView.tsx`:

- replace the raw xterm listener’s `updateTab(...)` call with `updatePaneTitle({ source: 'runtime' })`
- use `normalizeRuntimeTitle(...)` from `src/lib/title-source.ts`
- update the exit handler so it only appends `(exit N)` when `shouldDecorateExitTitle(tab.titleSource)` is true

Do not change attach/reveal timing, throttling, or title dedupe. This fix is semantic, not transport-related.

- [ ] **Step 4: Run the focused tests green, including the original regressions**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/title-sync-flow.test.tsx
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-title-source-precedence.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/titleSync.ts src/components/TerminalView.tsx src/components/HistoryView.tsx src/components/OverviewView.tsx src/components/context-menu/ContextMenuProvider.tsx test/e2e/title-sync-flow.test.tsx test/unit/client/components/TerminalView.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix: preserve stable tab titles over runtime terminal titles"
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
npm run test:e2e:chromium -- test/e2e-browser/specs/tab-management.spec.ts --grep "restored top tabs stay hot across page reload and still switch without replay"
npm run test:vitest -- --config vitest.server.config.ts --run test/unit/server/session-title-sync.test.ts test/integration/server/unified-rename-integration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the full coordinated suite before any merge decision**

Run:

```bash
FRESHELL_TEST_SUMMARY="tab title source precedence" npm test
```

Expected: PASS for the full coordinated suite. If it fails anywhere, stop and fix the real failure before proceeding.

- [ ] **Step 4: Commit any verification-driven fixes**

If verification required follow-up edits:

```bash
git add <relevant files>
git commit -m "test: close tab title precedence verification gaps"
```

If verification is clean, do not create an empty commit.

## Coverage Summary

- Covered directly: hidden-tab runtime downgrade, runtime-vs-stable precedence, tab/pane restore and reopen semantics, persistence/hydration migration, sidebar fallback titles, terminal exit title decoration, real-browser OSC background-title behavior.
- Covered by existing guards that must remain green: session-title promotion, unified rename integration, restored-tab hot switching with no replay churn.
- Intentionally not added: provider-dependent `codex resume` or `claude` browser journeys. The browser acceptance target here is Freshell’s handling of a real terminal OSC event, not external CLI auth/install behavior.
