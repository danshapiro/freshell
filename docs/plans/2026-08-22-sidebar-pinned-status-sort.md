# Pinned Status-Tier Sorting and Close-Tab Activity Ratchet Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Change Freshell's left-panel (sidebar) session list ordering: (1) within the pinned section (sessions open in tabs on this device), order sessions in four status tiers — busy on this device (blue) first, then needs-attention/turn-complete on this device (green), then busy on other devices (blue ring), then open on other devices (green ring) — with remaining pinned sessions after those tiers and existing time-based ordering within each tier; and (2) treat closing a tab as a user touch on that session: ratchet its locally-stored activity timestamp at close time so the just-closed session sorts near the top of the non-pinned (grey) section under the default activity sort mode.

### Explicit constraints
- None stated beyond the requested result.

### Accepted tradeoffs and residuals
- None stated.

**Goal:** Pinned sidebar sessions order into four status tiers (busy here → plain open here → busy elsewhere → open elsewhere) under the tab-pinning sort modes, and closing a tab bumps that session's activity timestamp so it floats to the top of the grey section under the default activity sort.

**Architecture:** Tiering lives in the pure sort path: `sortSessionItems` (src/store/selectors/sidebarSelectors.ts) gains an optional `pinnedStatus` option (`busySessionKeys: ReadonlySet<string>`, `remoteActivity: Record<string, 'busy' | 'open'>`) and a strict four-way `resolvePinnedStatusTier` partition applied only inside the pinned (`hasTab`) group of `activity` and `recency-pinned` modes; `makeSelectSortedSessionItems` accepts the status bag as a fourth passthrough argument, and `Sidebar.tsx` feeds it the already-memoized `busySessionKeySet` / `selectRemoteSessionActivity` values it computes for row props. The close-tab touch is three lines in the `closeTab` thunk (src/store/tabsSlice.ts): derive the closing tab's session refs from the pre-close snapshot and dispatch the existing ratchet-only `updateSessionActivity` per ref, letting the 5s-debounced persistence middleware handle localStorage.

**Tech Stack:** TypeScript, React 18, Redux Toolkit (`createSelector` / `createSlice` / `createAsyncThunk`), Vitest + Testing Library.

### Planner-verified design decisions (binding decisions A–F applied, with evidence at base `97373172509e8124e6d4bab833f13fb8663a1309`)

1. **Documented deviation from decision C's recommended shape — C's own blessed alternative is chosen: tier data is passed as a `sortSessionItems` option, not stamped as a `pinnedTier` item field by `buildSessionItems`.** Rationale, from verification: (a) stamping would force the high-churn activity slices (`codexActivity`/`claudeActivity`/`opencodeActivity`/`amplifierActivity`/`freshAgent.sessions` — new record objects per WS message) into `buildSessionItems`' input rail, re-running the full build+filter+sort on every blue blink; the repo contains zero `resultEqualityCheck` usage to stabilize a sub-selector (grep over `src/` finds none), while Sidebar.tsx:375-391 already computes exactly the primitive busy-key array (`shallowEqual`) and remote-activity record the sort needs. (b) The item-identity precedent from the remote-status-rings work is that status travels as props/sets, never as item fields. (c) The option shape leaves `buildSessionItems`, `SidebarSessionItem`, and every existing build test untouched.
2. **Decision C's "CRITICAL lockstep" (`isSessionItemEqual` must compare new fields or `useStableArray` swallows reorders) is resolved vacuously, verified:** `useStableArray` (src/hooks/useStableArray.ts:23-28) compares pairwise by index and `isSessionItemEqual` (Sidebar.tsx:142-165) compares `sessionId`, so any reorder of distinct sessions always adopts the new array; and under the chosen option shape there are no new item fields at all, so `isSessionItemEqual`, `areSessionItemsEqual`, `areSidebarItemPropsEqual`, and `Sidebar.render-stability.test.tsx` need no changes. Busy flips re-sort because `busySessionKeys` content changes (intended); unrelated WS churn cannot reach the selector (the component edge already reduces it to shallow-equal primitives).
3. **Documented refinement of tier-2 semantics per binding decision A:** the user-facing "needs-attention/turn-complete on this device (green)" tier is implemented as the sidebar's actual local green affordance — open here, not busy here, no remote state. Verification: the Sidebar never consumes turn-completion attention (`attentionByTab`/`attentionByPane` are tabId/paneId-keyed, no session-key projection exists, and `closeTab` clears them), so a pinned row's only local green is the persistent `hasTab` icon (Sidebar.tsx:1063-1070); decision A fixes this as a strict four-way partition with no fifth tier, so tier 2 is the catch-all for "remaining pinned sessions," ordered second. No new attention machinery is built (decision F: no new UI, no visual changes).
4. **Close-ratchet ref derivation uses `collectSessionRefsFromTabs([tab], panes)`, not `getTabSessionRefs`** — verified: `getTabSessionRefs` (src/lib/session-utils.ts:325-329) returns `[]` when the tab has no layout, while `collectSessionRefsFromTabs([tab], panes)` additionally resolves layout-less tabs through `buildTabFallbackLocator` (session-utils.ts:143-157, 268-305). The ratchet must cover both.
5. **Accepted residual (decision D, recorded):** the ratchet is applied unconditionally in the thunk, so REST/MCP/server-broadcast tab closes (which flow through the same `closeTab` thunk on every connected client) also ratchet — ratcheting a mirrored close is harmless-to-useful.
6. **Behavior boundaries (decision D, plain):** (i) the float is visible under the default `activity` sort only; `recency`/`recency-pinned` receive no ratchet input by existing design (`selectSessionActivityForSort` returns the shared `EMPTY_ACTIVITY` for non-`activity` modes, sidebarSelectors.ts:59-63), so no float there; (ii) a session whose only sidebar row was a client-side fallback row (never indexed by the server) disappears on close and cannot float — the ratchet value is stored and takes effect once the session is indexed.
7. **Testing-level dispositions (decisions E/F):** unit + component + integration coverage is specified per task below. No new e2e spec: tiering is a pure client-side composition of data whose end-to-end production paths already have coverage (busy derivation in `pane-activity` unit tests, remote-ring data flow in `test/e2e-browser/specs/sidebar-remote-status-rings-rust.spec.ts`); a meaningful tier-ordering e2e would require two devices plus a streaming agent, adding cost without exercising any new production path. `docs/index.html` is not updated: the mock does not encode row-order semantics and no new control, section, setting, or visual affordance is introduced (decision F default: skip).

## Global Constraints

- Server uses NodeNext/ESM (relative imports include .js) — client code follows existing TS/React/Redux Toolkit conventions.
- Coordinated test commands: focused vitest via `npm run test:vitest -- run <paths>` (never raw npx vitest); broad suites through the coordinator (`npm test`) from the worktree.
- TDD red/green/refactor for every change; no coverage reductions, no skipped tests.
- Commit author identity inherited from repo config — do not touch git config.
- Commit messages: conventional, focused.

### Task 1: Status-tier ordering inside `sortSessionItems`

**Files:**
- Modify: src/store/selectors/sidebarSelectors.ts:670-754 (`sortSessionItems`; insert the exported tier types/helper immediately above it, after line 668)
- Test: test/unit/client/store/selectors/sidebarSelectors.test.ts (new `describe('pinned status tiers')` inside `describe('sortSessionItems')`, after the `activity mode` block starting at line 1160)

**Interfaces:**
- Consumes: existing `sortSessionItems(items, sortMode, options?)` (sidebarSelectors.ts:670), `createSessionItem(overrides)` test builder (test file lines 13-26), `SidebarSessionItem` (sidebarSelectors.ts:14-48).
- Produces:
  - `export type PinnedStatusTier = 1 | 2 | 3 | 4`
  - `export interface PinnedSortStatus { busySessionKeys?: ReadonlySet<string>; remoteActivity?: Record<string, 'busy' | 'open'> }`
  - `export function resolvePinnedStatusTier(item: SidebarSessionItem, pinnedStatus?: PinnedSortStatus): PinnedStatusTier`
  - `sortSessionItems(items: SidebarSessionItem[], sortMode: string, options?: { disableTabPinning?: boolean; pinnedStatus?: PinnedSortStatus }): SidebarSessionItem[]` (Task 2 consumes the widened signature).

- [ ] **Step 1: Write the failing behavioral test**

```ts
    describe('pinned status tiers', () => {
      const pinned = (id: string, timestamp: number, extra: Partial<SidebarSessionItem> = {}) =>
        createSessionItem({ id, sessionId: id, timestamp, hasTab: true, ...extra })

      it('orders pinned rows into four tiers: busy here, plain open here, remote busy, remote open', () => {
        // Legacy time order would be remote-open > remote-busy > plain-open > busy-here.
        const items = [
          pinned('remote-open', 4000),
          pinned('remote-busy', 3000),
          pinned('plain-open', 2000),
          pinned('busy-here', 1000),
        ]

        const sorted = sortSessionItems(items, 'activity', {
          pinnedStatus: {
            busySessionKeys: new Set(['claude:busy-here']),
            remoteActivity: { 'claude:remote-busy': 'busy', 'claude:remote-open': 'open' },
          },
        })

        expect(sorted.map((i) => i.id)).toEqual(['busy-here', 'plain-open', 'remote-busy', 'remote-open'])
      })

      it('treats local-busy as tier 1 even when the session is also busy remotely', () => {
        const items = [pinned('both', 1000), pinned('plain', 2000)]

        const sorted = sortSessionItems(items, 'activity', {
          pinnedStatus: {
            busySessionKeys: new Set(['claude:both']),
            remoteActivity: { 'claude:both': 'busy' },
          },
        })

        expect(sorted.map((i) => i.id)).toEqual(['both', 'plain'])
      })

      it('keeps (ratchetedActivity ?? timestamp) ordering within a tier in activity mode', () => {
        const items = [
          pinned('old-ratcheted', 5000, { ratchetedActivity: 4000 }),
          pinned('new-untouched', 3000),
        ]

        const sorted = sortSessionItems(items, 'activity', { pinnedStatus: {} })

        expect(sorted.map((i) => i.id)).toEqual(['old-ratcheted', 'new-untouched'])
      })

      it('applies the same tiers in recency-pinned mode with timestamp ordering within a tier', () => {
        const items = [
          pinned('remote-open', 4000),
          pinned('busy-here', 1000),
          pinned('plain', 3000),
        ]

        const sorted = sortSessionItems(items, 'recency-pinned', {
          pinnedStatus: {
            busySessionKeys: new Set(['claude:busy-here']),
            remoteActivity: { 'claude:remote-open': 'open' },
          },
        })

        expect(sorted.map((i) => i.id)).toEqual(['busy-here', 'plain', 'remote-open'])
      })

      it('flattens tiers when disableTabPinning is set (active search)', () => {
        const items = [
          pinned('remote-open', 4000),
          pinned('busy-here', 1000),
        ]

        const sorted = sortSessionItems(items, 'activity', {
          disableTabPinning: true,
          pinnedStatus: {
            busySessionKeys: new Set(['claude:busy-here']),
            remoteActivity: { 'claude:remote-open': 'open' },
          },
        })

        expect(sorted.map((i) => i.id)).toEqual(['remote-open', 'busy-here'])
      })

      it('applies tiers within the archived partition (archived still last)', () => {
        const items = [
          createSessionItem({ id: 'arch-plain', sessionId: 'arch-plain', timestamp: 2000, hasTab: true, archived: true }),
          createSessionItem({ id: 'arch-busy', sessionId: 'arch-busy', timestamp: 1000, hasTab: true, archived: true }),
          createSessionItem({ id: 'live', sessionId: 'live', timestamp: 500, hasTab: false }),
        ]

        const sorted = sortSessionItems(items, 'activity', {
          pinnedStatus: { busySessionKeys: new Set(['claude:arch-busy']) },
        })

        expect(sorted.map((i) => i.id)).toEqual(['live', 'arch-busy', 'arch-plain'])
      })

      it('ignores pinnedStatus in recency and project modes', () => {
        const pinnedStatus = { busySessionKeys: new Set(['claude:busy-here']) }

        const recency = sortSessionItems([pinned('busy-here', 1000), pinned('plain', 2000)], 'recency', { pinnedStatus })
        expect(recency.map((i) => i.id)).toEqual(['plain', 'busy-here'])

        const project = sortSessionItems([
          createSessionItem({ id: 'busy-here', sessionId: 'busy-here', timestamp: 1000, hasTab: true, projectPath: '/b' }),
          createSessionItem({ id: 'plain', sessionId: 'plain', timestamp: 2000, hasTab: true, projectPath: '/a' }),
        ], 'project', { pinnedStatus })
        expect(project.map((i) => i.id)).toEqual(['plain', 'busy-here'])
      })

      it('leaves legacy pinned ordering untouched when pinnedStatus is omitted', () => {
        const sorted = sortSessionItems([pinned('older', 1000), pinned('newer', 2000)], 'activity')

        expect(sorted.map((i) => i.id)).toEqual(['newer', 'older'])
      })
    })
```

- [ ] **Step 2: Run the test and verify the intended failure**

```bash
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.test.ts -t 'pinned status tiers'
```

FAIL because `sortSessionItems` has no `pinnedStatus` option — the pure time-based pinned order is produced and the four-tier expectation receives `['remote-open', 'remote-busy', 'plain-open', 'busy-here']` instead of `['busy-here', 'plain-open', 'remote-busy', 'remote-open']`. (The three decision-B gating tests — `flattens tiers when disableTabPinning is set`, `ignores pinnedStatus in recency and project modes`, `leaves legacy pinned ordering untouched when pinnedStatus is omitted` — are expected green at red: they assert boundaries the step-3 code could wrongly change, and fail on such a mis-implementation.)

- [ ] **Step 3: Add the minimal production implementation**

Insert immediately above `sortSessionItems` (after line 668) in src/store/selectors/sidebarSelectors.ts:

```ts
export type PinnedStatusTier = 1 | 2 | 3 | 4

export interface PinnedSortStatus {
  /** Sessions currently busy on this device, keyed `provider:sessionId`. */
  busySessionKeys?: ReadonlySet<string>
  /** Per-session activity on OTHER devices (the fold already resolves busy-over-open). */
  remoteActivity?: Record<string, 'busy' | 'open'>
}

/**
 * Strict 4-way partition of pinned (hasTab) rows (coordinator decision A):
 *   1 = busy on this device (blue) · 2 = open here, not busy, no remote state
 *   3 = busy on another device (blue ring data) · 4 = open on another device (green ring data)
 * Local busy beats any remote state; tier 2 is the catch-all "remaining pinned"
 * bucket — exactly the rows rendering the sidebar's plain local green icon.
 */
export function resolvePinnedStatusTier(
  item: SidebarSessionItem,
  pinnedStatus?: PinnedSortStatus,
): PinnedStatusTier {
  const key = `${item.provider}:${item.sessionId}`
  if (pinnedStatus?.busySessionKeys?.has(key)) return 1
  const remote = pinnedStatus?.remoteActivity?.[key]
  if (remote === 'busy') return 3
  if (remote === 'open') return 4
  return 2
}
```

Widen the options type and sort pinned groups by tier first. Replace the whole `sortSessionItems` (lines 670-754) with:

```ts
export function sortSessionItems(
  items: SidebarSessionItem[],
  sortMode: string,
  options?: { disableTabPinning?: boolean; pinnedStatus?: PinnedSortStatus },
): SidebarSessionItem[] {
  const sorted = [...items]

  const active = sorted.filter((i) => !i.archived)
  const archived = sorted.filter((i) => i.archived)

  const compareBySessionKey = (a: SidebarSessionItem, b: SidebarSessionItem) =>
    a.provider.localeCompare(b.provider) || a.sessionId.localeCompare(b.sessionId)

  const compareByRecency = (a: SidebarSessionItem, b: SidebarSessionItem) =>
    b.timestamp - a.timestamp || compareBySessionKey(a, b)
  const compareByActivity = (a: SidebarSessionItem, b: SidebarSessionItem) => {
    const aHasRatcheted = typeof a.ratchetedActivity === 'number'
    const bHasRatcheted = typeof b.ratchetedActivity === 'number'
    if (aHasRatcheted !== bHasRatcheted) return aHasRatcheted ? -1 : 1
    const aTime = a.ratchetedActivity ?? a.timestamp
    const bTime = b.ratchetedActivity ?? b.timestamp
    return bTime - aTime || compareBySessionKey(a, b)
  }

  // Pinned status tier asc, then the mode's existing within-tier time
  // comparator (decisions A/B). With no pinnedStatus every pinned row is
  // tier 2, so tiering degenerates to the legacy comparators exactly.
  const tierOf = (item: SidebarSessionItem) => resolvePinnedStatusTier(item, options?.pinnedStatus)

  const sortByMode = (list: SidebarSessionItem[]) => {
    const copy = [...list]

    if (sortMode === 'recency') {
      return copy.sort(compareByRecency)
    }

    if (sortMode === 'recency-pinned') {
      if (options?.disableTabPinning) {
        return copy.sort(compareByRecency)
      }

      const withTabs = copy.filter((i) => i.hasTab)
      const withoutTabs = copy.filter((i) => !i.hasTab)

      withTabs.sort((a, b) => {
        const tierDelta = tierOf(a) - tierOf(b)
        if (tierDelta !== 0) return tierDelta
        return compareByRecency(a, b)
      })
      withoutTabs.sort(compareByRecency)

      return [...withTabs, ...withoutTabs]
    }

    if (sortMode === 'activity') {
      if (options?.disableTabPinning) {
        return copy.sort(compareByActivity)
      }

      const withTabs = copy.filter((i) => i.hasTab)
      const withoutTabs = copy.filter((i) => !i.hasTab)

      withTabs.sort((a, b) => {
        const tierDelta = tierOf(a) - tierOf(b)
        if (tierDelta !== 0) return tierDelta
        const aTime = a.ratchetedActivity ?? a.timestamp
        const bTime = b.ratchetedActivity ?? b.timestamp
        return bTime - aTime || compareBySessionKey(a, b)
      })

      withoutTabs.sort((a, b) => {
        const aHasRatcheted = typeof a.ratchetedActivity === 'number'
        const bHasRatcheted = typeof b.ratchetedActivity === 'number'
        if (aHasRatcheted !== bHasRatcheted) return aHasRatcheted ? -1 : 1
        const aTime = a.ratchetedActivity ?? a.timestamp
        const bTime = b.ratchetedActivity ?? b.timestamp
        return bTime - aTime || compareBySessionKey(a, b)
      })

      return [...withTabs, ...withoutTabs]
    }

    if (sortMode === 'project') {
      return copy.sort((a, b) => {
        const projA = a.projectPath || a.subtitle || ''
        const projB = b.projectPath || b.subtitle || ''
        if (projA !== projB) return projA.localeCompare(projB)
        return b.timestamp - a.timestamp || compareBySessionKey(a, b)
      })
    }

    return copy
  }

  return [...sortByMode(active), ...sortByMode(archived)]
}
```

- [ ] **Step 4: Run the focused test**

```bash
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.test.ts
```

Expected: PASS (all of `sortSessionItems`, including the new `pinned status tiers` block, plus the unchanged legacy describes).

- [ ] **Step 5: Refactor while green** — No-op by design: the tier/within-tier composition is already factored as `tierOf` + the mode comparator, and the only structural duplication (the two pinned branches) mirrors the pre-existing per-mode branch structure of this function; extracting a shared pinned-sort helper would couple `recency-pinned` and `activity` comparators that decision B deliberately keeps distinct.

- [ ] **Step 6: Run impacted-test verification** — the sibling suites that import this module:

```bash
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts
```

Expected: PASS. These call `sortSessionItems`/`buildSessionItems`/`makeSelectSortedSessionItems` without `pinnedStatus`; the all-tier-2 degeneration guarantees legacy order byte-for-byte.

- [ ] **Step 7: Commit the task**

```bash
git add src/store/selectors/sidebarSelectors.ts test/unit/client/store/selectors/sidebarSelectors.test.ts && git commit -m "feat(client): order pinned sidebar sessions by local/remote status tiers"
```

### Task 2: Feed status data through `makeSelectSortedSessionItems` and `Sidebar.tsx`

**Files:**
- Modify: src/store/selectors/sidebarSelectors.ts:50-74 (module consts + input selectors), :756-811 (`makeSelectSortedSessionItems` input list, result func, final call)
- Modify: src/components/Sidebar.tsx:23 (import type), :339 and :375-391 (relocate status computations above the selector call site, pass the memoized status bag)
- Test: test/unit/client/store/selectors/sidebarSelectors.test.ts (`describe('makeSelectSortedSessionItems')`, after line 1024)
- Test: test/unit/client/components/Sidebar.test.tsx (`describe('activity sort mode')`, after the test ending at line 1200)

**Interfaces:**
- Consumes: `PinnedSortStatus` (Task 1), widened `sortSessionItems` options (Task 1), `busySessionKeySet` (Sidebar.tsx:385, `Set<string>` memoized from `shallowEqual`-selected `busySessionKeys`), `remoteActivityBySessionKey` (Sidebar.tsx:390, `selectRemoteSessionActivity` from src/store/selectors/tabsRegistrySelectors.ts:162-165), `createSelectorState` / `createFallbackTab` test builders (test file lines 28-113), `createTestStore` / `renderSidebar` / `sessionId` harness (Sidebar.test.tsx lines 71-280).
- Produces: `makeSelectSortedSessionItems()` selector callable as `(state, terminals, filter, pinnedStatus?)`; omitting the fourth argument (all existing callers) behaves exactly as today via a shared module-level `EMPTY_PINNED_STATUS`.

- [ ] **Step 1: Write the failing behavioral test**

Append to `describe('makeSelectSortedSessionItems')` in test/unit/client/store/selectors/sidebarSelectors.test.ts:

```ts
    it('orders pinned sessions by status tier when pinnedStatus is provided, flat under applied search', () => {
      const busy = createFallbackTab('tab-busy', 'busy-s', 'Busy Session', '/tmp/a', 'codex')
      const idle = createFallbackTab('tab-idle', 'idle-s', 'Idle Session', '/tmp/b', 'claude')
      const projects = [
        {
          projectPath: '/tmp',
          sessions: [
            { sessionId: 'busy-s', provider: 'codex', projectPath: '/tmp', lastActivityAt: 1000, title: 'Busy Session', cwd: '/tmp' },
            { sessionId: 'idle-s', provider: 'claude', projectPath: '/tmp', lastActivityAt: 9000, title: 'Idle Session', cwd: '/tmp' },
          ],
        },
      ] as any
      const makeState = (extra: { appliedQuery?: string; appliedSearchTier?: 'title' } = {}) =>
        createSelectorState({
          projects,
          tabs: [busy.tab, idle.tab],
          panes: {
            layouts: { 'tab-busy': busy.layout, 'tab-idle': idle.layout },
            activePane: {},
            paneTitles: {},
          },
          sortMode: 'activity',
          ...extra,
        })
      const selectSortedItems = makeSelectSortedSessionItems()
      const pinnedStatus = { busySessionKeys: new Set(['codex:busy-s']), remoteActivity: {} }

      // Omitted pinnedStatus: legacy pinned time order (newest first).
      expect(selectSortedItems(makeState(), [], '').map((i) => i.sessionId)).toEqual(['idle-s', 'busy-s'])
      // Provided pinnedStatus: busy session leads the pinned section.
      expect(selectSortedItems(makeState(), [], '', pinnedStatus).map((i) => i.sessionId)).toEqual(['busy-s', 'idle-s'])
      // Applied server search flattens pinning; tiers go with it (decision B).
      expect(
        selectSortedItems(makeState({ appliedQuery: 'Session', appliedSearchTier: 'title' }), [], '', pinnedStatus)
          .map((i) => i.sessionId),
      ).toEqual(['idle-s', 'busy-s'])
    })
```

Append inside `describe('activity sort mode')` in test/unit/client/components/Sidebar.test.tsx (after the `uses ratcheted sessionActivity for closed tabs (preserves position)` block at lines 1154-1200):

```tsx
    it('orders a locally busy pinned session ahead of a newer idle pinned session', async () => {
      const now = Date.now()
      const busySid = sessionId('busy-pinned')
      const idleSid = sessionId('idle-pinned')
      const terminalId = 'term-busy-tier'
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: busySid,
              provider: 'codex',
              projectPath: '/home/user/project',
              lastActivityAt: now - 60000,
              title: 'Busy pinned session',
              cwd: '/home/user/project',
            },
            {
              sessionId: idleSid,
              projectPath: '/home/user/project',
              lastActivityAt: now - 1000,
              title: 'Idle pinned session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [
        { id: 'tab-busy', terminalId, resumeSessionId: busySid, mode: 'codex' },
        { id: 'tab-idle', resumeSessionId: idleSid, mode: 'claude' },
      ]

      const store = createTestStore({
        projects,
        tabs,
        sortMode: 'activity',
        codexActivity: {
          byTerminalId: {
            [terminalId]: {
              terminalId,
              sessionId: 'session-codex',
              phase: 'busy',
              lastActivityAt: 10,
            },
          },
        },
      })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const buttons = screen.getAllByRole('button').filter(
        (btn) => btn.textContent?.includes('pinned session')
      )

      // Busy (older) must lead the pinned section; idle (newer) follows.
      expect(buttons[0]).toHaveTextContent('Busy pinned session')
      expect(buttons[1]).toHaveTextContent('Idle pinned session')
    })
```

- [ ] **Step 2: Run the test and verify the intended failure**

```bash
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.test.ts -t 'orders pinned sessions by status tier'
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx -t 'orders a locally busy pinned session ahead'
```

FAIL because `makeSelectSortedSessionItems` has no fourth input/argument, so the provided `pinnedStatus` is ignored: the tiered call returns legacy order `['idle-s', 'busy-s']` instead of `['busy-s', 'idle-s']`; and the component feeds the selector only `(state, terminals, '')`, so the idle (newer) row renders first instead of the busy row.

- [ ] **Step 3: Add the minimal production implementation**

In src/store/selectors/sidebarSelectors.ts, after the `EMPTY_PANE_LAST_INPUT_AT` const (line 52):

```ts
const EMPTY_PINNED_STATUS: PinnedSortStatus = { busySessionKeys: new Set<string>(), remoteActivity: {} }
```

After the `selectFilter` input selector (line 74):

```ts
const selectPinnedStatus = (
  _state: RootState,
  _terminals: BackgroundTerminal[],
  _filter: string,
  pinnedStatus?: PinnedSortStatus,
): PinnedSortStatus => pinnedStatus ?? EMPTY_PINNED_STATUS
```

In `makeSelectSortedSessionItems` (lines 756-811): append `selectPinnedStatus,` to the input-selector array after `selectFilter,`; append `pinnedStatus` as the final parameter of the result func (after `filter`); change the final call to:

```ts
      return sortSessionItems(filtered, sortMode, {
        disableTabPinning: appliedQuery.trim().length > 0,
        pinnedStatus,
      })
```

In src/components/Sidebar.tsx: extend the existing sidebarSelectors import (line 23 area) with the type: `import { makeSelectSortedSessionItems, type PinnedSortStatus, ... } from '@/store/selectors/sidebarSelectors'`. Then relocate the four status computations currently at lines 375-391 (`busySessionKeys` selector, `busySessionKeySet` memo, `remoteActivityBySessionKey` selector, `sameDeviceSessionKeys` selector) to immediately BEFORE the current selector call site (line 339), and replace line 339 with the memoized status bag plus the 4-arg call:

```ts
  const busySessionKeys = useAppSelector((state) => collectBusySessionKeys({
    tabs: state.tabs.tabs,
    paneLayouts: state.panes?.layouts ?? EMPTY_LAYOUTS,
    codexActivityByTerminalId: state.codexActivity?.byTerminalId ?? EMPTY_CODEX_ACTIVITY_BY_ID,
    claudeActivityByTerminalId: state.claudeActivity?.byTerminalId ?? EMPTY_CLAUDE_ACTIVITY_BY_ID,
    amplifierActivityByTerminalId: state.amplifierActivity?.byTerminalId ?? EMPTY_AMPLIFIER_ACTIVITY_BY_ID,
    opencodeActivityByTerminalId: state.opencodeActivity?.byTerminalId ?? EMPTY_OPENCODE_ACTIVITY_BY_ID,
    paneRuntimeActivityByPaneId: state.paneRuntimeActivity?.byPaneId ?? EMPTY_PANE_RUNTIME_ACTIVITY_BY_ID,
    freshAgentSessions: state.freshAgent?.sessions ?? EMPTY_FRESH_AGENT_SESSIONS,
  }), shallowEqual)
  const busySessionKeySet = useMemo(() => new Set(busySessionKeys), [busySessionKeys])
  const remoteActivityBySessionKey = useAppSelector(selectRemoteSessionActivity)
  const sameDeviceSessionKeys = useAppSelector(selectSameDeviceSessionKeys)

  // Pinned status input for the sort selector (decision C, alternative shape):
  // reuse the already-memoized busy set and remote record so the selector only
  // recomputes when the primitive status data actually changes — busy flips
  // re-sort (intended); remote record identity changes at most once per
  // registry snapshot reply (~30s), and useStableArray absorbs no-op re-sorts.
  const pinnedSortStatus = useMemo<PinnedSortStatus>(
    () => ({ busySessionKeys: busySessionKeySet, remoteActivity: remoteActivityBySessionKey }),
    [busySessionKeySet, remoteActivityBySessionKey],
  )
  const localFilteredItems = useAppSelector((state) => selectSortedItems(state, terminals, '', pinnedSortStatus))
```

`localOpenSessionKeys` (lines 392-414) and `localSessionKeys` (lines 415-419) stay where they are; they do not feed the selector. Hook order is static in all renders, so the relocation is safe.

- [ ] **Step 4: Run the focused test**

```bash
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/components/Sidebar.test.tsx
```

Expected: PASS, including both new tests and all pre-existing sort/ring/activity describes (unchanged rows render in unchanged order because every status set is empty in the old fixtures).

- [ ] **Step 5: Refactor while green** — No-op by design: the component edge already had the exact memoization layering this needs (`shallowEqual` busy keys, memoized busy set, `useMemo` status bag); the selector gains a single passthrough input matching the existing `selectTerminals`/`selectFilter` pattern, and duplication was deliberately avoided by consuming the component's busy set instead of recomputing identity inside the selector.

- [ ] **Step 6: Run impacted-test verification** — every suite touching the selector or the Sidebar row pipeline:

```bash
npm run test:vitest -- run test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx
```

Expected: PASS. `App.ws-bootstrap.test.tsx:626` and the sibling selector suites call the selector with three arguments and take the `EMPTY_PINNED_STATUS` default; `Sidebar.render-stability.test.tsx` asserts comparators that are unchanged (no new item fields — planner note 2).

- [ ] **Step 7: Commit the task**

```bash
git add src/store/selectors/sidebarSelectors.ts src/components/Sidebar.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/components/Sidebar.test.tsx && git commit -m "feat(client): feed busy/remote status into the sidebar sort selector"
```

### Task 3: Close-tab activity ratchet in the `closeTab` thunk

**Files:**
- Modify: src/store/tabsSlice.ts:7 (extend the existing session-utils import), imports block (add `updateSessionActivity`, near line 13), :485-486 (insert the ratchet immediately after `const layout = stateBeforeClose.panes.layouts[tabId]`)
- Test: test/unit/client/store/tabsSlice.test.ts (new `describe('closeTab session activity ratchet')` after the `closeTab with multiple panes` block ending at line 578)
- Test: test/unit/client/components/Sidebar.test.tsx (`describe('activity sort mode')`, after the Task 2 test)
- Test: test/integration/activity-sort.test.tsx (new `it` after the existing test)

**Interfaces:**
- Consumes: `collectSessionRefsFromTabs(tabs, panes): SessionRef[]` (src/lib/session-utils.ts:294-305), `updateSessionActivity({ sessionId, provider?, lastInputAt })` — ratchet-only (src/store/sessionActivitySlice.ts:81-96, composite key via `makeSessionKey`, lines 13-17), `closeTab` thunk (tabsSlice.ts:480-536, pre-close snapshot at line 483), `VALID_CLAUDE_SESSION_ID` const (tabsSlice.test.ts:19), `splitPane` action (src/store/panesSlice.ts:1163, exported at 2406), `sessionActivityPersistMiddleware` / `SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS` / `resetSessionActivityFlushListenersForTests` (src/store/sessionActivityPersistence.ts:4,51,59), `SESSION_ACTIVITY_STORAGE_KEY` (src/store/sessionActivitySlice.ts:2,4).
- Produces: no new exported names; behavior: every `closeTab` dispatch ratchets `sessionActivity.sessions['provider:sessionId']` to `Date.now()` for each of the closing tab's session refs.

- [ ] **Step 1: Write the failing behavioral test**

Add to test/unit/client/store/tabsSlice.test.ts — extend the line-14 import to `import panesReducer, { initLayout, splitPane } from '../../../../src/store/panesSlice'` and add `import sessionActivityReducer from '../../../../src/store/sessionActivitySlice'`, then:

```ts
  describe('closeTab session activity ratchet', () => {
    const SECOND_CLAUDE_ID = '550e8400-e29b-41d4-a716-446655440001'

    function createRatchetStore(sessions: Record<string, number> = {}) {
      return configureStore({
        reducer: {
          tabs: tabsReducer,
          panes: panesReducer,
          sessionActivity: sessionActivityReducer,
        },
        preloadedState: { sessionActivity: { sessions } },
      })
    }

    it('ratchets activity for every session ref of the closing tab', async () => {
      const store = createRatchetStore()
      store.dispatch(addTab({ mode: 'claude' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId,
        content: {
          kind: 'terminal',
          mode: 'claude',
          resumeSessionId: VALID_CLAUDE_SESSION_ID,
          sessionRef: { provider: 'claude', sessionId: VALID_CLAUDE_SESSION_ID },
        },
      }))
      const leafId = (store.getState().panes.layouts[tabId] as any).id
      store.dispatch(splitPane({
        tabId,
        paneId: leafId,
        direction: 'horizontal',
        newContent: {
          kind: 'terminal',
          mode: 'claude',
          resumeSessionId: SECOND_CLAUDE_ID,
          sessionRef: { provider: 'claude', sessionId: SECOND_CLAUDE_ID },
        },
      }))

      const beforeClose = Date.now()
      await store.dispatch(closeTab(tabId))

      const sessions = store.getState().sessionActivity.sessions
      expect(sessions[`claude:${VALID_CLAUDE_SESSION_ID}`]).toBeGreaterThanOrEqual(beforeClose)
      expect(sessions[`claude:${SECOND_CLAUDE_ID}`]).toBeGreaterThanOrEqual(beforeClose)
    })

    it('records no activity when closing a sessionless shell tab', async () => {
      const store = createRatchetStore()
      store.dispatch(addTab({ mode: 'shell' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({ tabId, content: { kind: 'terminal', mode: 'shell' } }))

      await store.dispatch(closeTab(tabId))

      expect(store.getState().sessionActivity.sessions).toEqual({})
    })

    it('never downgrades a newer existing ratchet value', async () => {
      const future = Date.now() + 60_000
      const store = createRatchetStore({ [`claude:${VALID_CLAUDE_SESSION_ID}`]: future })
      store.dispatch(addTab({ mode: 'claude' }))
      const tabId = store.getState().tabs.tabs[0].id
      store.dispatch(initLayout({
        tabId,
        content: { kind: 'terminal', mode: 'claude', resumeSessionId: VALID_CLAUDE_SESSION_ID },
      }))

      await store.dispatch(closeTab(tabId))

      expect(store.getState().sessionActivity.sessions[`claude:${VALID_CLAUDE_SESSION_ID}`]).toBe(future)
    })

    it('ratchets layout-less tabs via tab-level fallback identity', async () => {
      const store = createRatchetStore()
      store.dispatch(hydrateTabs({
        tabs: [{
          id: 'layout-less',
          createRequestId: 'layout-less',
          title: 'Layout-less',
          status: 'running',
          mode: 'claude',
          resumeSessionId: VALID_CLAUDE_SESSION_ID,
          createdAt: 1,
        } as any],
        activeTabId: 'layout-less',
      }))

      const beforeClose = Date.now()
      await store.dispatch(closeTab('layout-less'))

      expect(store.getState().sessionActivity.sessions[`claude:${VALID_CLAUDE_SESSION_ID}`])
        .toBeGreaterThanOrEqual(beforeClose)
    })
  })
```

In test/unit/client/components/Sidebar.test.tsx: extend the line-8 import to `import tabsReducer, { closeTab } from '@/store/tabsSlice'`, then append inside `describe('activity sort mode')`:

```tsx
    it('floats a just-closed session to the top of the grey section', async () => {
      const now = Date.now()
      const closerSid = sessionId('closing-float')
      const greyNewerSid = sessionId('grey-newer')
      const greyOlderSid = sessionId('grey-older')
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: closerSid,
              projectPath: '/home/user/project',
              lastActivityAt: now - 7200000,
              title: 'Closing session',
              cwd: '/home/user/project',
            },
            {
              sessionId: greyNewerSid,
              projectPath: '/home/user/project',
              lastActivityAt: now - 1000,
              title: 'Grey newer session',
              cwd: '/home/user/project',
            },
            {
              sessionId: greyOlderSid,
              projectPath: '/home/user/project',
              lastActivityAt: now - 5000,
              title: 'Grey older session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]

      const tabs = [{ id: 'tab-closing', resumeSessionId: closerSid, mode: 'claude' }]
      const store = createTestStore({ projects, tabs, sortMode: 'activity' })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const buttons = () => screen.getAllByRole('button').filter(
        (btn) => btn.textContent?.endsWith('session')
      )

      // Pinned first, then grey newest-first.
      expect(buttons()[0]).toHaveTextContent('Closing session')
      expect(buttons()[1]).toHaveTextContent('Grey newer session')
      expect(buttons()[2]).toHaveTextContent('Grey older session')

      const beforeClose = Date.now()
      await act(async () => {
        await store.dispatch(closeTab('tab-closing') as any)
        vi.advanceTimersByTime(100)
      })

      // The close ratcheted the session's activity timestamp...
      expect(store.getState().sessionActivity.sessions[`claude:${closerSid}`])
        .toBeGreaterThanOrEqual(beforeClose)
      // ...so the stale session — sort order [newer, older, closer] without it —
      // lands on top of the grey section instead of sinking below both.
      expect(buttons()).toHaveLength(3)
      expect(buttons()[0]).toHaveTextContent('Closing session')
      expect(buttons()[0]).toHaveAttribute('data-has-tab', 'false')
      expect(buttons()[1]).toHaveTextContent('Grey newer session')
      expect(buttons()[2]).toHaveTextContent('Grey older session')
    })
```

In test/integration/activity-sort.test.tsx: extend the storage-key import to `import sessionActivityReducer, { SESSION_ACTIVITY_STORAGE_KEY } from '@/store/sessionActivitySlice'`, and add:

```tsx
import tabsReducer, { addTab, closeTab } from '@/store/tabsSlice'
import panesReducer, { initLayout } from '@/store/panesSlice'
import {
  sessionActivityPersistMiddleware,
  SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS,
  resetSessionActivityFlushListenersForTests,
} from '@/store/sessionActivityPersistence'
```

inside `beforeEach` after `localStorage.clear()`: `resetSessionActivityFlushListenersForTests()`, then append:

```tsx
  it('persists the close-tab activity ratchet to localStorage after the debounce', async () => {
    const claudeSessionId = '550e8400-e29b-41d4-a716-446655440000'
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        sessionActivity: sessionActivityReducer,
      },
      middleware: (getDefault) => getDefault().concat(sessionActivityPersistMiddleware),
    })

    store.dispatch(addTab({ mode: 'claude' }))
    const tabId = store.getState().tabs.tabs[0].id
    store.dispatch(initLayout({
      tabId,
      content: {
        kind: 'terminal',
        mode: 'claude',
        resumeSessionId: claudeSessionId,
        sessionRef: { provider: 'claude', sessionId: claudeSessionId },
      },
    }))

    const beforeClose = Date.now()
    await store.dispatch(closeTab(tabId))

    expect(store.getState().sessionActivity.sessions[`claude:${claudeSessionId}`])
      .toBeGreaterThanOrEqual(beforeClose)
    expect(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY)).toBeNull()

    vi.advanceTimersByTime(SESSION_ACTIVITY_PERSIST_DEBOUNCE_MS)

    const persisted = JSON.parse(localStorage.getItem(SESSION_ACTIVITY_STORAGE_KEY) || '{}')
    expect(persisted[`claude:${claudeSessionId}`]).toBeGreaterThanOrEqual(beforeClose)
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

```bash
npm run test:vitest -- run test/unit/client/store/tabsSlice.test.ts -t 'closeTab session activity ratchet'
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx -t 'floats a just-closed session'
npm run test:vitest -- run test/integration/activity-sort.test.tsx
```

FAIL because `closeTab` never dispatches `updateSessionActivity`: the ratchet assertions read `undefined` (`expected undefined to be >= <timestamp>`), and in the Sidebar float test the closed session sinks to `['Grey newer session', 'Grey older session', 'Closing session']`.

- [ ] **Step 3: Add the minimal production implementation**

In src/store/tabsSlice.ts: extend line 7 to `import { findTabIdForSession, collectSessionRefsFromTabs } from '@/lib/session-utils'` and add (grouped with the other store imports, after the tabRegistrySlice import at line 13): `import { updateSessionActivity } from './sessionActivitySlice'`. Then insert immediately after line 485 (`const layout = stateBeforeClose.panes.layouts[tabId]`):

```ts
    // Closing a tab counts as a user touch on its sessions: ratchet each
    // session's locally-stored activity timestamp so the just-closed session
    // floats to the top of the unpinned (grey) section under the default
    // 'activity' sort. Refs come from the pre-close snapshot via
    // collectSessionRefsFromTabs([tab], panes) — chosen over getTabSessionRefs
    // because it also covers layout-less tabs via buildTabFallbackLocator
    // (session-utils.ts:143-157). Unconditional by design: REST/MCP/server-
    // broadcast closes flow through this same thunk on every connected client
    // (accepted residual: ratcheting a mirrored close is harmless-to-useful).
    if (tab) {
      const touchedAt = Date.now()
      for (const ref of collectSessionRefsFromTabs([tab], stateBeforeClose.panes)) {
        dispatch(updateSessionActivity({
          sessionId: ref.sessionId,
          provider: ref.provider,
          lastInputAt: touchedAt,
        }))
      }
    }
```

- [ ] **Step 4: Run the focused test**

```bash
npm run test:vitest -- run test/unit/client/store/tabsSlice.test.ts test/unit/client/components/Sidebar.test.tsx test/integration/activity-sort.test.tsx
```

Expected: PASS, including all new tests and every pre-existing close-tab, sort, and persistence test.

- [ ] **Step 5: Refactor while green** — No-op by design: the insertion is a single guarded loop that reuses the existing pure extractor and the existing ratchet-only action; no helper extraction is warranted for three lines, and the slice/middleware already handle monotonicity, pruning, and persistence.

- [ ] **Step 6: Run impacted-test verification** — every suite that dispatches or pins `closeTab` / `removeTab` / session-activity behavior:

```bash
npm run test:vitest -- run test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsSlice.closed-registry.test.ts test/unit/client/store/tabsSlice.reopen.test.ts test/unit/client/store/turnCompletionSlice.test.ts test/unit/client/store/persistTabsEmptyGuard.test.ts test/unit/client/store/sessionActivitySlice.test.ts test/unit/client/store/sessionActivityPersistence.test.ts test/unit/client/components/Sidebar.test.tsx test/integration/activity-sort.test.tsx
```

Expected: PASS. Stores in adjacency suites without a `sessionActivity` reducer silently ignore the added dispatches; attention-clearing, closed-snapshot, reopen-stack, and tombstone assertions are behaviorally untouched.

- [ ] **Step 7: Commit the task**

```bash
git add src/store/tabsSlice.ts test/unit/client/store/tabsSlice.test.ts test/unit/client/components/Sidebar.test.tsx test/integration/activity-sort.test.tsx && git commit -m "feat(client): ratchet session activity when a tab closes"
```

## Final gate (after the last task, before any PR)

- [ ] Typecheck + lint + full coordinated suite from the worktree:

```bash
npm run lint
FRESHELL_TEST_SUMMARY="sidebar-pinned-status-sort final gate" npm run check
```

Expected: both exit 0.

- [ ] Confirm dispositions: no new e2e spec and no `docs/index.html` update (rationale in planner notes 7); no settings, toggles, or visual changes (decision F); no changes to remote-ring render suppression, ring visuals, or busy/green icon visuals.
- [ ] Stop before `gh pr create`: PR creation requires explicit user approval per repo rules.
