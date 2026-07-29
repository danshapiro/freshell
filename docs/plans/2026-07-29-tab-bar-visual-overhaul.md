# Tab Bar Visual Overhaul Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Overhaul the tab bar visuals: optically center the letter-in-circle placeholder, make every tab a fixed 240px wide, render tab provider logos in dark grey only, darken the sidebar selected-item highlight, and remap the existing server-authoritative status machinery onto three canonical tab visual states (GREY = working, GREEN = ready, GREEN + GREEN BAR = ready-and-unacknowledged).

**Architecture:** All changes are client-side React/Tailwind presentation work. The status *machinery* (server-authoritative `turn.complete`/`terminal.idle`/`turn.waiting` edges, monotonic dedupe baselines, `resolvePaneActivity`) is NOT touched. A new pure function `resolveTabVisualState` becomes the single canonical mapping from existing booleans to a visual state, plus one small additive store field (`readyByTab`) that records "this tab has turned ready at least once" so a tab stays green after the user acknowledges it.

**Tech Stack:** React 18 + TypeScript, Redux Toolkit, Tailwind CSS, Vitest + @testing-library/react (jsdom), Vite build.

## Global Constraints

- **DO NOT push, DO NOT create a PR, DO NOT merge.** Stop after execution + review with work committed on the worktree branch. The user will review a live test server before deciding.
- Worktree: `/home/dan/code/freshell/.worktrees/tab-bar-visual-overhaul`, branch `feat/tab-bar-visual-overhaul`, based on `origin/main` at `02f862a7` (includes icon-discovery PR #572). All paths in this plan are relative to that worktree root.
- Tabs are a fixed **240px** wide, all the time (`w-60` = 15rem = 240px), with truncation/ellipsis for overflow.
- Tab provider logos: **dark grey only** (`text-zinc-600 dark:text-zinc-400`). Do NOT change LHS sidebar icon behavior/coloring.
- LHS sidebar selected-item highlight: slightly **darker grey** than today's `bg-muted`.
- The underlying state machinery (server-authoritative turn.complete edges, dedupe regimes) must NOT be changed — presentation-layer remapping only.
- TDD (Red-Green-Refactor). Frequent, focused, atomic commits.
- Client-only deploy: `npm run build:client` produces `dist/client`, served from disk by the Rust server. No server rebuild needed.
- Do NOT edit `src/components/icons/provider-icons.tsx` or `src/components/icons/PaneIcon.tsx` for coloring — they are shared with the sidebar/pane-header and changes there would leak into the sidebar.
- `docs/tab-design.md` is the authoritative spec for the tab border stroke — do not change tab border colors/weights beyond what this plan states.
- README.md is the only end-user markdown doc; this plan under `docs/plans/` is a working/agent doc.
- Focused test runs: `npm run test:vitest -- run <file> --config config/vitest/vitest.config.ts` (the only script that accepts `--config`; never raw `npx vitest`). Full client suite: `npm run test:client` (coordinator-gated).

---

## The Canonical Visual State Mapping (design decision record)

New pure function (Task 2) — the single source of truth for tab visuals:

| Visual state | Meaning | Derivation (all inputs already exist) |
|---|---|---|
| `working` (GREY tab) | agent actively working (today's blue/busy) | `getBusyPaneIdsForTab(...).length > 0` (via `resolvePaneActivity`) |
| `ready-unacked` (GREEN tab + GREEN BAR) | turn completed / waiting, user hasn't visited yet | `attentionByTab[tabId]` set AND tab not active |
| `ready` (GREEN tab) | agent has turned ready; user has acknowledged (or the tab is currently selected) | `attentionByTab[tabId]` set on the ACTIVE tab, OR `readyByTab[tabId]` set (new, presentation-only field) |
| `neutral` | plain shell tab / never-completed / dead tab | everything else |

**Precedence:** `no live pane → neutral` > `working` > `ready-unacked` > `ready` > `neutral`.

**Edge-case decisions (explicit, tested in Task 2):**

1. **Turn completes while the tab is selected:** no bar while selected (`hasAttention && isActive → 'ready'`). The attention flag itself is NOT cleared by us — existing machinery keeps it until the user switches away and back (documented behavior in `useTurnCompletionNotifications.ts`), so if the user switches away without engaging, the bar appears on the now-inactive tab. This preserves existing acknowledgement semantics exactly.
2. **Waiting-for-approval:** the server-authoritative `freshAgent.turn.waiting` edge already (a) suppresses busy (`isFreshAgentBusy` returns false when pending permissions/questions exist) and (b) sets attention via the `#waiting` dedupe namespace. Mapping: **waiting → GREEN + GREEN BAR** (`ready-unacked`) — the agent is blocked on the user, which is an attention state, not a working state. No machinery change.
3. **Disconnected/exited panes:** a tab whose terminal panes are ALL `exited`/`error` renders `neutral` (never green/grey), regardless of stale ready/attention flags. Fresh-agent and browser panes count as "live" (their lifecycle is session-managed; an exited SDK session still shows its transcript and can be resumed).
4. **Acknowledgement:** clicking a tab already dispatches `dismissTabGreen` (in `attentionDismiss === 'click'` mode) which deletes `attentionByTab[tabId]` → bar clears; `readyByTab[tabId]` remains → plain green tab. In `'type'` mode keystrokes dismiss — same mapping applies with zero changes.
5. **Grey again after ready:** when a new turn starts, busy takes precedence over ready — tab goes grey; when the turn completes, attention + ready are set again → green + bar. `readyByTab` never needs busy-edge clearing.
6. **`tabAttentionStyle` setting** (`'highlight' | 'pulse' | 'darken' | 'none'`) now controls only the *unacknowledged emphasis*: `highlight` (default) → green bar; `pulse` → green bar + `animate-pulse`; `darken` → the darken treatment *instead of* the green fill AND instead of the bar (mutually exclusive — this codebase's `cn` is a plain join with no tailwind-merge, so conflicting `bg-*`/`text-*` utilities must never co-fire); `none` → no unacked emphasis (renders as plain `ready`). The grey/green base states are unconditional. **Explicit consequence (decided):** since `ready-unacked` never occurs on the ACTIVE tab, no emphasis (including `darken`) ever applies to the active tab — with `darken` selected, an active tab holding attention now renders plain green, where the old code darkened it. Deliberate behavior change, consistent with edge case 1.
7. **Validated edge-firing scope:** the ready/attention edges are mode-gated at every layer (client BEL signal extraction, Node tracker wiring, Rust activity engine) — plain-shell panes can never receive `markTabAttention`, so `readyByTab` needs no mode gating. (The client BEL dispatch in `TerminalView.tsx` was found to be dead code for all modes; do not treat it as a live input.)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/tab-visual-state.ts` | Create | Pure canonical mapping booleans → `TabVisualState` (+ `hasLivePane` helper) |
| `test/unit/client/lib/tab-visual-state.test.ts` | Create | Exhaustive unit tests for the mapping incl. all edge cases |
| `src/components/icons/RepoIcon.tsx` | Modify | Optically center the placeholder letter |
| `test/unit/client/components/icons/RepoIcon.test.tsx` | Modify | Lock the letter geometry |
| `src/store/turnCompletionSlice.ts` | Modify | Add `readyByTab` (set in `markTabAttention`, new `clearTabReady`, rehydrated) |
| `src/store/persistMiddleware.ts` | Modify | Persist pruned `readyByTab`; extend the dirty check to `readyByTab` refs |
| `test/unit/client/store/turnCompletionSlice.test.ts` | Modify | Tests for `readyByTab` lifecycle |
| `test/unit/client/store/turnCompletionPersistence.test.ts` | Modify | Dirty-check flush + prune-to-live-tabs tests |
| `src/store/tabsSlice.ts` | Modify | `closeTab` AND `closePaneWithCleanup` also clear `readyByTab` |
| `test/e2e/*.test.tsx` (2 files) + `test/e2e-browser/specs/*` (4 files) | Modify | Tab-scoped `text-blue-500` assertions/locators → grey (Task 4 Step 4b) |
| `src/components/TabItem.tsx` | Modify | Consume `resolveTabVisualState`; grey/green/bar styling; grey icons; fixed width; label flex |
| `test/unit/client/components/TabItem.test.tsx` | Modify | Rewrite literal-className assertions for the new scheme |
| `src/components/TabBar.tsx` | Modify | Pass `isReady` to tabs; `shrink-0` on dnd wrapper |
| `test/unit/client/components/TabBar.test.tsx` | Modify | Integration assertions for bar show/clear |
| `src/components/Sidebar.tsx` | Modify | Darker selected-row highlight (one line) |
| `test/unit/client/components/Sidebar.test.tsx` | Modify | Update highlight class assertions |
| `docs/index.html` | Modify | Mock reflects fixed-width tabs + new state colors |
| `AGENTS.md` | Modify | One-sentence addendum documenting the visual mapping |

---

### Task 1: Optically center the placeholder letter (RepoIcon)

The letter-in-circle placeholder renders its letter ~1px too low. Root cause (verified by inspection, no flex/line-height involved — it's pure SVG geometry in `src/components/icons/RepoIcon.tsx`):

- **Bias A:** the `<text>` uses `y="8.5"` — a hand-added +0.5 user-unit nudge below the circle center (`cy="8"`).
- **Bias B:** `dominantBaseline="central"` centers the font's *em box* (midpoint ≈ 0.30em above baseline), but a capital letter's optical center is cap-height/2 ≈ 0.35em above baseline — pushing the glyph another ≈0.05em × 9 ≈ 0.45 units down.

Total ≈ 0.95 user units ≈ 1px at rendered sizes. **Proper fix:** drop `dominantBaseline` (it also has cross-browser interop history) and place the alphabetic baseline explicitly so the cap box is centered on the circle: `y = 8 + (capHeight ≈ 0.70em × 9)/2 = 11.15`.

This component is used in `src/components/TabItem.tsx:133` and `src/components/panes/PaneHeader.tsx:132` (both benefit; it is NOT used in the sidebar — no sidebar impact).

**Files:**
- Modify: `src/components/icons/RepoIcon.tsx` (the `<text>` element, currently lines 53-63)
- Test: `test/unit/client/components/icons/RepoIcon.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged component API (`RepoIcon({ info, className })`); only SVG `<text>` attributes change.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('RepoIcon', ...)` block in `test/unit/client/components/icons/RepoIcon.test.tsx`:

```tsx
  it('optically centers the letter (alphabetic baseline at cap-height/2 below center, no dominant-baseline)', () => {
    render(<RepoIcon info={{ repoKey: '/r', repoName: 'freshell' }} />)
    const text = document.querySelector('svg text')!
    expect(text).toBeTruthy()
    // Cap-centered placement: y = 8 (circle center) + (0.70 * 9)/2 = 11.15.
    expect(text.getAttribute('y')).toBe('11.15')
    // dominant-baseline must be gone: 'central' centers the em box, which sits
    // ~0.05em below a capital glyph's optical center and is a browser-interop hazard.
    expect(text.getAttribute('dominant-baseline')).toBeNull()
    expect(text.getAttribute('text-anchor')).toBe('middle')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/components/icons/RepoIcon.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — `expected '8.5' to be '11.15'` (existing 5 tests stay green).

- [ ] **Step 3: Implement the fix**

In `src/components/icons/RepoIcon.tsx`, replace the `<text>` element:

```tsx
      <text
        x="8"
        y="8.5"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="9"
        fontWeight="600"
        fill="white"
      >
```

with:

```tsx
      {/*
        Optical centering: place the alphabetic baseline so the CAP box (the
        uppercase glyph spans baseline..cap-height ≈ 0.70em) is centered on the
        circle: y = 8 + (0.70 * 9) / 2 = 11.15. dominant-baseline="central" is
        deliberately NOT used — it centers the em box (which reserves empty
        descender space below a capital), rendering the letter ~1px low, and
        has cross-browser interop quirks.
      */}
      <text
        x="8"
        y="11.15"
        textAnchor="middle"
        fontSize="9"
        fontWeight="600"
        fill="white"
      >
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/components/icons/RepoIcon.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/icons/RepoIcon.tsx test/unit/client/components/icons/RepoIcon.test.tsx
git commit -m "fix(repo-icon): optically center placeholder letter (cap-height baseline, drop dominant-baseline)"
```

---

### Task 2: Canonical tab visual state module

Create the pure mapping described in "The Canonical Visual State Mapping" above. No UI wiring yet — this task delivers the documented, unit-tested state machine.

**Files:**
- Create: `src/lib/tab-visual-state.ts`
- Test: `test/unit/client/lib/tab-visual-state.test.ts`

**Interfaces:**
- Consumes: `PaneContent` type from `@/store/paneTypes`, `Tab` type from `@/store/types` (types only).
- Produces (used by Tasks 4-5):
  - `type TabVisualState = 'neutral' | 'working' | 'ready' | 'ready-unacked'`
  - `interface TabVisualStateInputs { isBusy: boolean; hasAttention: boolean; isReady: boolean; isActive: boolean; hasLivePane: boolean }`
  - `function resolveTabVisualState(input: TabVisualStateInputs): TabVisualState`
  - `function tabHasLivePane(tab: Pick<Tab, 'status'>, paneEntries?: Array<{ content: PaneContent }>): boolean`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/client/lib/tab-visual-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveTabVisualState, tabHasLivePane } from '@/lib/tab-visual-state'
import type { PaneContent } from '@/store/paneTypes'

const base = {
  isBusy: false,
  hasAttention: false,
  isReady: false,
  isActive: false,
  hasLivePane: true,
}

describe('resolveTabVisualState', () => {
  it('returns neutral for a plain tab (no busy, no attention, no ready)', () => {
    expect(resolveTabVisualState({ ...base })).toBe('neutral')
  })

  it('returns working (GREY) when any pane is busy', () => {
    expect(resolveTabVisualState({ ...base, isBusy: true })).toBe('working')
  })

  it('working takes precedence over ready and attention (new turn started)', () => {
    expect(resolveTabVisualState({ ...base, isBusy: true, isReady: true, hasAttention: true }))
      .toBe('working')
  })

  it('returns ready-unacked (GREEN + BAR) when attention is set and tab is not active', () => {
    expect(resolveTabVisualState({ ...base, hasAttention: true })).toBe('ready-unacked')
  })

  it('never shows the bar on the active tab: attention + active -> ready (plain GREEN)', () => {
    expect(resolveTabVisualState({ ...base, hasAttention: true, isActive: true })).toBe('ready')
  })

  it('returns ready (plain GREEN) after acknowledgement: ready flag persists, attention cleared', () => {
    expect(resolveTabVisualState({ ...base, isReady: true })).toBe('ready')
  })

  it('waiting-for-approval maps to ready-unacked (attention set via #waiting, busy suppressed upstream)', () => {
    // Upstream machinery guarantees isBusy=false while pending permissions/questions exist
    // and marks attention via the `${sessionKey}#waiting` dedupe namespace.
    expect(resolveTabVisualState({ ...base, isBusy: false, hasAttention: true, isReady: true }))
      .toBe('ready-unacked')
  })

  it('a dead tab is neutral regardless of stale flags', () => {
    expect(resolveTabVisualState({
      ...base, hasLivePane: false, isBusy: true, hasAttention: true, isReady: true,
    })).toBe('neutral')
  })
})

describe('tabHasLivePane', () => {
  const terminal = (status: 'creating' | 'running' | 'recovering' | 'exited' | 'error'): PaneContent =>
    ({ kind: 'terminal', createRequestId: 'r', status, mode: 'shell' }) as PaneContent

  it('true when any terminal pane is not exited/error', () => {
    expect(tabHasLivePane({ status: 'running' }, [
      { content: terminal('exited') },
      { content: terminal('running') },
    ])).toBe(true)
  })

  it('false when ALL terminal panes are exited/error', () => {
    expect(tabHasLivePane({ status: 'running' }, [
      { content: terminal('exited') },
      { content: terminal('error') },
    ])).toBe(false)
  })

  it('fresh-agent panes count as live (session-managed lifecycle)', () => {
    const freshAgent = { kind: 'fresh-agent' } as PaneContent
    expect(tabHasLivePane({ status: 'exited' }, [{ content: freshAgent }])).toBe(true)
  })

  it('falls back to tab.status when there are no pane entries', () => {
    expect(tabHasLivePane({ status: 'running' })).toBe(true)
    expect(tabHasLivePane({ status: 'exited' }, [])).toBe(false)
    expect(tabHasLivePane({ status: 'error' })).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/lib/tab-visual-state.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `Cannot find module '@/lib/tab-visual-state'` (or equivalent resolve error).

- [ ] **Step 3: Implement the module**

Create `src/lib/tab-visual-state.ts`:

```ts
import type { Tab } from '@/store/types'
import type { PaneContent } from '@/store/paneTypes'

/**
 * Canonical tab visual states (presentation layer ONLY — the underlying
 * server-authoritative status machinery is untouched):
 *
 * - 'working'       GREY tab. An agent is actively working (formerly blue/busy).
 *                   Source: resolvePaneActivity via getBusyPaneIdsForTab.
 * - 'ready-unacked' GREEN tab + GREEN BAR. A turn completed (or the agent is
 *                   waiting for approval) and the user has not visited the tab
 *                   since. Source: turnCompletion.attentionByTab.
 * - 'ready'         GREEN tab, no bar. The agent has turned ready at least once
 *                   and the user has acknowledged (clicked/typed), OR the tab is
 *                   currently selected (a selected tab never shows the bar).
 *                   Source: turnCompletion.readyByTab (persistent) / attention on
 *                   the active tab.
 * - 'neutral'       Plain tab: shell tabs, agents that never completed a turn,
 *                   and tabs whose panes are all exited/errored.
 *
 * Edge-case decisions (locked):
 * - Waiting-for-approval => 'ready-unacked': the waiting edge suppresses busy
 *   (isFreshAgentBusy) and marks attention via the `#waiting` namespace, so it
 *   lands here naturally. The agent is blocked ON THE USER — an attention state.
 * - Completion on the ACTIVE tab shows plain green (no bar) while selected.
 *   Attention is not cleared by the mapping; existing dismissal semantics
 *   (click/switch/type via dismissTabGreen) decide when the flag goes away.
 * - A tab with no live pane is 'neutral' no matter what flags are set.
 */
export type TabVisualState = 'neutral' | 'working' | 'ready' | 'ready-unacked'

export interface TabVisualStateInputs {
  /** Any pane busy per resolvePaneActivity (getBusyPaneIdsForTab().length > 0). */
  isBusy: boolean
  /** turnCompletion.attentionByTab[tabId] — the unacknowledged flag. */
  hasAttention: boolean
  /** turnCompletion.readyByTab[tabId] — "turned ready at least once" (persistent). */
  isReady: boolean
  /** Tab is the currently selected tab. */
  isActive: boolean
  /** At least one pane is not exited/errored (see tabHasLivePane). */
  hasLivePane: boolean
}

export function resolveTabVisualState(input: TabVisualStateInputs): TabVisualState {
  if (!input.hasLivePane) return 'neutral'
  if (input.isBusy) return 'working'
  if (input.hasAttention && !input.isActive) return 'ready-unacked'
  if (input.hasAttention || input.isReady) return 'ready'
  return 'neutral'
}

/**
 * A tab is "live" when at least one pane can still do work. Terminal panes are
 * dead when exited/errored; fresh-agent and browser panes count as live (their
 * lifecycle is session-managed — an exited SDK session still shows its
 * transcript and can be resumed). With no pane entries (layout not hydrated),
 * fall back to the aggregate tab.status.
 */
export function tabHasLivePane(
  tab: Pick<Tab, 'status'>,
  paneEntries?: Array<{ content: PaneContent }>,
): boolean {
  if (paneEntries && paneEntries.length > 0) {
    return paneEntries.some((entry) =>
      entry.content.kind !== 'terminal'
      || (entry.content.status !== 'exited' && entry.content.status !== 'error'))
  }
  return tab.status !== 'exited' && tab.status !== 'error'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/lib/tab-visual-state.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tab-visual-state.ts test/unit/client/lib/tab-visual-state.test.ts
git commit -m "feat(tabs): add canonical tab visual state mapping (grey/green/green+bar)"
```

---

### Task 3: `readyByTab` store field (persistent "has turned ready")

The green tab must persist after the user clicks (only the BAR clears). Today green is keyed solely off `attentionByTab`, which is deleted on acknowledgement. Add a presentation-only `readyByTab` record to `turnCompletionSlice`: set wherever attention is marked (which is the single funnel for ALL three server edges — turn-complete, terminal-idle, waiting), cleared on tab close AND on the closePane cleanup path (see below), persisted to localStorage alongside the attention maps. No event edges or dedupe baselines are touched.

**Validated persistence/lifecycle facts this task must honor (load-bearing validation findings):**
1. The persistence WRITE site is `src/store/persistMiddleware.ts:652-660` (payload `{ version: 1, attentionByTab, attentionByPane }`), but the **dirty check at `persistMiddleware.ts:705-708` compares only `attentionByTab`/`attentionByPane` references** — a `readyByTab`-only mutation (e.g. `clearTabReady` on a tab whose attention was already acknowledged) would never flush. The dirty check MUST also compare `readyByTab` references (verified: there is NO cross-window turn-completion receive path — `crossTabSync.ts:34-38` handles only LAYOUT/BROWSER_PREFERENCES/TAB_RECENCY — so send-side is the only broadcast change needed, and it comes free with the payload).
2. `closeTab` is NOT the only tab-death path: multi-window closes remove tabs via the `hydrateTabs` tombstone merge (`tabsSlice.ts:360-413`) without dispatching `closeTab`, and a permanent flag with no pruning grows localStorage without bound. Therefore the persisted `readyByTab` payload is **pruned to live tab ids at the write site** (filter against `state.tabs.tabs`), which also stops other windows' whole-map flushes from resurrecting deleted entries.
3. `closePaneWithCleanup` (`tabsSlice.ts:462-478`) already treats agent-pane departure as invalidating tab-level attention (`clearTabAttention` at :475). `readyByTab` gets the same treatment there — otherwise closing the agent pane leaves a permanently green shell-only tab. (This is what keeps tab-level granularity correct; verified there is no cross-tab pane-move flow, `panesSlice.ts:2195-2224`.)
4. Verified safe: the ready/attention edges are mode-gated at every layer (client `shared/turn-complete-signal.ts:129-147`, Node tracker wiring `server/index.ts:539-546` + `activity-wiring-factory.ts:65-68`, Rust `crates/freshell-ws/src/activity.rs:518-548`) — plain-shell panes can NEVER receive `markTabAttention`, so setting `readyByTab` unconditionally in `markTabAttention` needs no mode gating.

**Files:**
- Modify: `src/store/turnCompletionSlice.ts` (state shape, `markTabAttention`, new `clearTabReady`, persistence read)
- Modify: `src/store/persistMiddleware.ts` (write payload ~lines 652-660: add pruned `readyByTab`; dirty check ~lines 705-708: also compare `readyByTab` references)
- Modify: `src/store/tabsSlice.ts` (`closeTab` thunk — where it already dispatches `clearTabAttention`, around lines 529-534; AND `closePaneWithCleanup` — the `clearTabAttention` dispatch at ~line 475)
- Test: `test/unit/client/store/turnCompletionSlice.test.ts`
- Test: `test/unit/client/store/turnCompletionPersistence.test.ts` (dirty-check + prune coverage)

**Interfaces:**
- Consumes: existing `markTabAttention` / `clearTabAttention` reducers and the `closeTab` cleanup path.
- Produces (used by Task 5):
  - `TurnCompletionState.readyByTab: Record<string, boolean>`
  - action `clearTabReady(payload: { tabId: string })` exported from the slice.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/client/store/turnCompletionSlice.test.ts` (it already imports the reducer and actions; extend the imports with `clearTabReady`):

```ts
describe('readyByTab (persistent ready flag)', () => {
  it('markTabAttention also marks the tab ready', () => {
    const state = reducer(undefined, markTabAttention({ tabId: 'T1' }))
    expect(state.attentionByTab['T1']).toBe(true)
    expect(state.readyByTab['T1']).toBe(true)
  })

  it('clearTabAttention does NOT clear ready (acknowledged tab stays green)', () => {
    let state = reducer(undefined, markTabAttention({ tabId: 'T1' }))
    state = reducer(state, clearTabAttention({ tabId: 'T1' }))
    expect(state.attentionByTab['T1']).toBeUndefined()
    expect(state.readyByTab['T1']).toBe(true)
  })

  it('clearTabReady removes the ready flag and is a no-op when absent', () => {
    let state = reducer(undefined, markTabAttention({ tabId: 'T1' }))
    state = reducer(state, clearTabReady({ tabId: 'T1' }))
    expect(state.readyByTab['T1']).toBeUndefined()
    // no-op path must not throw
    state = reducer(state, clearTabReady({ tabId: 'nope' }))
    expect(state.readyByTab['nope']).toBeUndefined()
  })
})
```

Also cover the close-path: this file already contains a `closeTab` cleanup test (search the file for `closeTab` — it dispatches `closeTab(...)` on a real multi-slice store and asserts `attentionByTab[...]` is cleared). DUPLICATE that entire `it` block verbatim (same store construction, same `markTabAttention` + `closeTab` dispatches), rename the copy to `'closeTab clears readyByTab for the closed tab'`, and replace its final assertions with exactly:

```ts
    expect(store.getState().turnCompletion.readyByTab[tabId]).toBeUndefined()
```

(where `tabId` is whatever tab id the copied test uses). The store setup MUST be the byte-identical copy of the neighboring test — copy it, don't invent it.

Do the same for the closePane cleanup path: this file (or `test/unit/client/store/turnCompletionAttention.test.ts` — whichever holds the existing closePane/`clearTabAttention` coverage; find it with `grep -rln "closePaneWithCleanup\|closePane" test/unit/client/store/`) has a test asserting attention is cleared when the relevant pane closes. Duplicate it the same way, renamed `'closing the pane that earned readiness clears readyByTab'`, asserting `readyByTab[tabId]` is `undefined` after the pane close. If no such test exists, write one against the real thunk (`closePaneWithCleanup`) with a two-pane tab: mark attention, close the agent pane, assert both `attentionByTab[tabId]` and `readyByTab[tabId]` are cleared.

And the persistence behaviors, in `test/unit/client/store/turnCompletionPersistence.test.ts` (reuse its existing localStorage/store harness — read the file's helpers first):

```ts
  it('flushes a readyByTab-only change (clearTabReady after attention already cleared)', () => {
    // markTabAttention -> clearTabAttention (flush happens; ready persists)
    // then clearTabReady alone -> the persisted payload must lose the entry.
  })

  it('prunes persisted readyByTab to live tabs (no unbounded growth / cross-window resurrection)', () => {
    // Seed readyByTab with an id absent from state.tabs.tabs; trigger a flush;
    // assert the persisted payload contains only live tab ids.
  })
```

(Write real assertions against the file's actual harness — the comments above are the contract.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/store/turnCompletionSlice.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `readyByTab` is `undefined` / `clearTabReady` is not exported.

- [ ] **Step 3: Implement**

In `src/store/turnCompletionSlice.ts`:

a) Extend the state interface:

```ts
export interface TurnCompletionState {
  seq: number
  lastAtByTerminalId: Record<string, number>
  /** Truly-idle (terminal.idle) dedupe baseline — separate namespace from turn-complete `at`s. */
  lastIdleAtByTerminalId: Record<string, number>
  pendingEvents: TurnCompleteEvent[]
  attentionByTab: Record<string, boolean>
  attentionByPane: Record<string, boolean>
  /**
   * Presentation-only: tab has turned ready (turn complete / idle / waiting) at
   * least once. Unlike attentionByTab this SURVIVES acknowledgement — it keeps
   * the tab green after the user clicks; only the green BAR (attention) clears.
   * Cleared on tab close. Never consulted by dedupe or event machinery.
   */
  readyByTab: Record<string, boolean>
}
```

b) Add `readyByTab: {}` to the initial state (and rehydrate it in `loadPersistedTurnCompletionState` exactly like `attentionByTab`, defaulting to `{}` when absent so existing version-1 payloads keep loading — do not bump the version).

c) Update `markTabAttention` and add `clearTabReady`:

```ts
    markTabAttention(state, action: PayloadAction<{ tabId: string }>) {
      state.readyByTab ??= {}
      state.readyByTab[action.payload.tabId] = true
      if (state.attentionByTab[action.payload.tabId]) return
      state.attentionByTab[action.payload.tabId] = true
    },
    clearTabReady(state, action: PayloadAction<{ tabId: string }>) {
      if (!state.readyByTab?.[action.payload.tabId]) return
      delete state.readyByTab[action.payload.tabId]
    },
```

Export `clearTabReady` from the slice's action exports alongside `clearTabAttention`.

d) Persistence — in `src/store/persistMiddleware.ts` (three coordinated edits, per the validated facts above):

- **Write payload** (~lines 652-660): where `{ version: 1, attentionByTab, attentionByPane }` is built, include `readyByTab` — but **pruned to live tabs**: filter its keys against the current tab ids from `state.tabs.tabs` (e.g. `Object.fromEntries(Object.entries(readyByTab).filter(([id]) => liveTabIds.has(id)))`). Keep `version: 1` (additive field, backward-compatible read per (b)). The cross-window broadcast send picks this up for free; there is no turn-completion receive path to change.
- **Dirty check** (~lines 705-708): extend the reference comparison that sets `turnCompletionDirty` to also compare `prev.turnCompletion.readyByTab !== next.turnCompletion.readyByTab` — without this, `readyByTab`-only mutations (e.g. `clearTabReady` on an already-acknowledged tab) never flush.

e) In `src/store/tabsSlice.ts`, dispatch `clearTabReady({ tabId })` (import it from `./turnCompletionSlice`) at BOTH attention-cleanup sites:

- the `closeTab` flow where `clearTabAttention({ tabId })` is dispatched (~lines 529-534), and
- `closePaneWithCleanup` (~lines 462-478), next to its existing `clearTabAttention` dispatch at ~line 475 — pane departure invalidates tab-level readiness exactly as it already invalidates tab-level attention.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/store/turnCompletionSlice.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS. Also run the persistence + attention suites to catch regressions:

```bash
npm run test:vitest -- run test/unit/client/store/turnCompletionPersistence.test.ts --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/store/turnCompletionAttention.test.ts --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/hooks/useTurnCompletionNotifications.test.tsx --config config/vitest/vitest.config.ts
```
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/store/turnCompletionSlice.ts src/store/persistMiddleware.ts src/store/tabsSlice.ts test/unit/client/store/turnCompletionSlice.test.ts test/unit/client/store/turnCompletionPersistence.test.ts
git commit -m "feat(tabs): persistent readyByTab flag (green survives acknowledgement)"
```

(Also `git add test/unit/client/store/turnCompletionAttention.test.ts` if the closePane test landed there.)

---

### Task 4: TabItem restyle — grey working / green ready / green bar / grey icons

Rework `src/components/TabItem.tsx` to consume `resolveTabVisualState` and render the three canonical states, replace ALL blue busy accents with dark grey, and render provider logos in dark grey only. Confine every change to `TabItem.tsx` (the sidebar and pane header share the leaf SVGs — never touch `provider-icons.tsx`/`PaneIcon.tsx`).

Current status-relevant code in `TabItem.tsx` (for orientation; line numbers from `origin/main`):
- `StatusDot` (lines 20-25): `busy ? 'fill-blue-500 text-blue-500' : getTerminalStatusDotClassName(status)`
- `PaneIcon` call (lines 139-146): `isBusy ? 'text-blue-500' : getTerminalStatusIconClassName(status)`
- `+N` overflow badge (line ~152): `hiddenBusyPane ? 'text-blue-500' : 'text-muted-foreground'`
- The container `cn(...)` block (lines ~158-184) branches on `isActive` / `needsAttention` / `tabAttentionStyle`.

**Files:**
- Modify: `src/components/TabItem.tsx`
- Test: `test/unit/client/components/TabItem.test.tsx`
- Test: `test/e2e/pane-activity-indicator-flow.test.tsx` + `test/e2e/codex-activity-indicator-flow.test.tsx` (tab-scoped `text-blue-500` assertions → grey; see Step 4b)
- Test: `test/e2e-browser/specs/pane-activity-indicator.spec.ts`, `truly-idle-alerting.spec.ts`, `terminal-activity-rust.spec.ts`, `codex-status-completeness-rust.spec.ts` (browser-suite locators; see Step 4b)

**Interfaces:**
- Consumes: `resolveTabVisualState`, `tabHasLivePane`, `TabVisualState` from `@/lib/tab-visual-state` (Task 2).
- Produces (used by Task 5):
  - `TabItemProps` gains `isReady?: boolean` (default `false`). All other props unchanged.
  - The unacked bar is `data-testid="tab-attention-bar"`.

- [ ] **Step 1: Update/extend the failing tests**

In `test/unit/client/components/TabItem.test.tsx` (it mocks `lucide-react`, `PaneIcon`, `RepoIcon` and has `defaultProps`/`createTab`/`getTabElement` helpers — reuse them):

a) Update the existing blue-assertion tests (three of them) to expect grey. Find these `it` blocks and change the assertions (keep the scenarios):

- `'shows a blue single dot when a pane is busy even if the aggregate tab.status is not running'` → rename to `'shows a grey single dot when a pane is busy even if the aggregate tab.status is not running'`; replace `expect(dot.getAttribute('class')).toContain('fill-blue-500')` with:

```tsx
    expect(dot.getAttribute('class')).toContain('fill-zinc-500')
    expect(dot.getAttribute('class')).not.toContain('fill-blue-500')
```

- `'shows blue icon only for the exact busy terminal in split tabs'` → the icon color no longer varies by busy; rename to `'renders all pane icons in dark grey regardless of busy state'` and assert:

```tsx
    const icons = screen.getAllByTestId('pane-icon')
    for (const icon of icons) {
      expect(icon.getAttribute('class')).toContain('text-zinc-600')
      expect(icon.getAttribute('class')).not.toContain('text-blue-500')
      expect(icon.getAttribute('class')).not.toContain('text-success')
    }
```

- `'shows blue overflow indicator when the exact busy terminal is hidden beyond the visible icon cap'` → rename to `'shows grey emphasized overflow indicator when the busy terminal is hidden beyond the icon cap'` and assert:

```tsx
    expect(screen.getByText('+4').getAttribute('class')).toContain('text-zinc-600')
    expect(screen.getByText('+4').getAttribute('class')).not.toContain('text-blue-500')
```

b) Add new tests for the canonical states:

```tsx
  describe('canonical visual states', () => {
    it('working: busy inactive tab renders GREY (not blue, not emerald)', () => {
      render(<TabItem {...defaultProps} busy={true} />)
      const el = getTabElement()
      expect(el?.className).toContain('bg-zinc-300')
      expect(el?.className).not.toContain('bg-emerald-100')
      expect(el?.className).not.toContain('blue-500')
    })

    it('ready: isReady inactive tab renders GREEN without the bar', () => {
      render(<TabItem {...defaultProps} isReady={true} />)
      const el = getTabElement()
      expect(el?.className).toContain('bg-emerald-100')
      expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
    })

    it('ready-unacked: attention on an inactive tab renders GREEN with the GREEN BAR', () => {
      render(<TabItem {...defaultProps} needsAttention={true} />)
      const el = getTabElement()
      expect(el?.className).toContain('bg-emerald-100')
      const bar = screen.getByTestId('tab-attention-bar')
      expect(bar.className).toContain('bg-emerald-500')
    })

    it('the ACTIVE tab never shows the bar even with attention', () => {
      render(<TabItem {...defaultProps} isActive={true} needsAttention={true} />)
      expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
      const el = getTabElement()
      expect(el?.className).toContain('border-t-success')
    })

    it('working takes precedence over ready/attention', () => {
      render(<TabItem {...defaultProps} busy={true} isReady={true} needsAttention={true} />)
      const el = getTabElement()
      expect(el?.className).toContain('bg-zinc-300')
      expect(el?.className).not.toContain('bg-emerald-100')
      expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
    })

    it('a tab whose panes all exited is neutral even when flagged ready', () => {
      render(
        <TabItem
          {...defaultProps}
          tab={createTab({ status: 'exited' })}
          isReady={true}
        />
      )
      const el = getTabElement()
      expect(el?.className).toContain('bg-muted')
      expect(el?.className).not.toContain('bg-emerald-100')
    })

    it('tabAttentionStyle none suppresses the bar but keeps the green base', () => {
      render(<TabItem {...defaultProps} needsAttention={true} tabAttentionStyle="none" />)
      expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
      expect(getTabElement()?.className).toContain('bg-emerald-100')
    })

    it('tabAttentionStyle pulse animates the unacked tab', () => {
      render(<TabItem {...defaultProps} needsAttention={true} tabAttentionStyle="pulse" />)
      expect(getTabElement()?.className).toContain('animate-pulse')
      expect(screen.getByTestId('tab-attention-bar')).toBeTruthy()
    })
  })
```

c) Reconcile the four pre-existing attention-style tests with the new scheme (same file, currently asserting on `needsAttention`):
- `'applies emerald attention styles for highlight style (default)'` — still passes (emerald base retained); keep.
- `'applies emerald attention styles with animation for pulse style'` — still passes; keep.
- `'applies foreground-based attention styles for darken style'` — still valid (darken replaces the bar); additionally assert `expect(screen.queryByTestId('tab-attention-bar')).toBeNull()`.
- `'applies no attention styles when style is none'` — under the new scheme `none` keeps the GREEN base and only suppresses the emphasis; update this test to assert there is no bar and no `animate-pulse`, but the emerald base IS present (mirrors the new `'tabAttentionStyle none...'` test above; adjust its existing negative assertions accordingly).

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npm run test:vitest -- run test/unit/client/components/TabItem.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — new tests fail (`bg-zinc-300` absent, `tab-attention-bar` missing, `isReady` prop unknown); the updated blue→grey tests fail on class assertions.

- [ ] **Step 3: Implement**

In `src/components/TabItem.tsx`:

a) Imports:

```ts
import { resolveTabVisualState, tabHasLivePane } from '@/lib/tab-visual-state'
```

b) Props — add to `TabItemProps` after `busyPaneIds`:

```ts
  /** Tab has turned ready at least once (turnCompletion.readyByTab). */
  isReady?: boolean
```

and destructure with default `isReady = false`.

c) `StatusDot` (grey busy):

```tsx
function StatusDot({ status, busy }: { status: TerminalStatus; busy?: boolean }) {
  // `busy` is already the authoritative per-pane busy aggregate (busyPaneIds);
  // do NOT AND it with the last-writer-wins tab.status, which a sibling pane's
  // 'exited' can clobber and wrongly suppress the working indicator.
  return (
    <Circle
      className={cn(
        'h-2 w-2',
        busy
          ? 'fill-zinc-500 text-zinc-500 dark:fill-zinc-400 dark:text-zinc-400'
          : getTerminalStatusDotClassName(status),
      )}
    />
  )
}
```

d) Provider logos in tabs — always dark grey (spec: no color in tabs; sidebar untouched because it never renders through this call site). Replace the `PaneIcon` call (currently `isBusy ? 'text-blue-500' : getTerminalStatusIconClassName(status)`):

```tsx
              <PaneIcon
                key={paneId}
                content={content}
                className={cn(
                  // Tabs render provider logos in dark grey ONLY (no status
                  // coloring) — the tab container now carries the state color.
                  'h-3 w-3 shrink-0 text-zinc-600 dark:text-zinc-400',
                  status === 'exited' && 'opacity-40',
                )}
              />
```

If `getTerminalStatusIconClassName` becomes unused in this file after this change, remove it from the import (keep `getTerminalStatusDotClassName`).

e) `+N` overflow badge — replace `hiddenBusyPane ? 'text-blue-500' : 'text-muted-foreground'` with:

```ts
hiddenBusyPane ? 'text-zinc-600 dark:text-zinc-400 font-semibold' : 'text-muted-foreground'
```

f) Compute the visual state at the top of the component body (after the `useEffect`):

```ts
  const visualState = resolveTabVisualState({
    isBusy: !!busy,
    hasAttention: needsAttention,
    isReady,
    isActive,
    hasLivePane: tabHasLivePane(tab, paneEntries),
  })
  const isGreen = visualState === 'ready' || visualState === 'ready-unacked'
  // tabAttentionStyle governs only the UNACKED emphasis:
  //   highlight (default) -> green bar; pulse -> bar + pulse;
  //   darken -> darken treatment instead of the bar; none -> plain green.
  const attentionEmphasis = visualState === 'ready-unacked' && tabAttentionStyle !== 'none'
  const showAttentionBar = attentionEmphasis && tabAttentionStyle !== 'darken'
```

g) Replace the container `className={cn(...)}` block with the following. **Structural constraint (load-bearing, validated):** this codebase's `cn` (`src/lib/utils.ts`) is a plain `filter(Boolean).join(' ')` — there is NO tailwind-merge — so two conflicting same-group utilities (`bg-*`, `text-*`, `hover:bg-*`) in one class list resolve by generated-stylesheet order, which is unspecified. Branches that can co-fire MUST be mutually exclusive (the current production code uses an exclusive ternary; keep that property). That is why the darken treatment below is the ternary ALTERNATIVE to the emerald classes, never additive:

```tsx
      className={cn(
        'group relative flex items-center gap-2 h-8 px-3 rounded-t-md border-x border-t border-muted-foreground/45 text-sm cursor-pointer transition-colors',
        isActive
          ? cn(
              "z-30 border-b border-b-background bg-background text-foreground after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-[2px] after:bg-background after:content-['']",
              visualState === 'working'
                && 'border-t-[3px] border-t-zinc-500 dark:border-t-zinc-400',
              isGreen
                && 'border-t-[3px] border-t-success bg-success/15 shadow-[inset_0_4px_8px_hsl(var(--success)/0.2)]'
              // NOTE (deliberate behavior change, decided during load-bearing
              // validation): `ready-unacked` is unreachable on the ACTIVE tab
              // (Task 2 mapping), so no darken/pulse emphasis ever applies here.
              // With tabAttentionStyle='darken', an active tab with attention now
              // renders plain GREEN (previously it was darkened). Base states are
              // unconditional; the style setting governs only unacked emphasis.
            )
          : cn(
              'shadow-[inset_0_-1px_0_hsl(var(--muted-foreground)/0.45)]',
              visualState === 'neutral'
                && 'bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/90',
              visualState === 'working'
                && 'bg-zinc-300 text-zinc-800 hover:bg-zinc-300/80 dark:bg-zinc-600/70 dark:text-zinc-100 dark:hover:bg-zinc-600/60',
              // Mutually exclusive: darken REPLACES the emerald fill (plain-join
              // cn cannot safely stack conflicting bg-*/text-* utilities).
              isGreen
                && (attentionEmphasis && tabAttentionStyle === 'darken'
                  ? 'bg-foreground/15 text-foreground hover:bg-foreground/20 dark:bg-foreground/20 dark:text-foreground dark:hover:bg-foreground/25'
                  : 'bg-emerald-100 text-emerald-900 hover:bg-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-100 dark:hover:bg-emerald-900/55'),
              attentionEmphasis && tabAttentionStyle === 'pulse' && 'animate-pulse'
            ),
        isDragging && 'opacity-50'
      )}
```

h) Render the bar inside the container `<div>`, immediately after the close `</button>`:

```tsx
      {showAttentionBar && (
        <span
          data-testid="tab-attention-bar"
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-1.5 bottom-[3px] h-[3px] rounded-full bg-emerald-500"
        />
      )}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/components/TabItem.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/TabBar.test.tsx --config config/vitest/vitest.config.ts
```
Expected: TabItem PASS. If TabBar tests assert old blue/emerald classnames, update those assertions to the new scheme (same substitutions as Step 1a; do not delete scenarios).

- [ ] **Step 4b: Update out-of-task suites that assert tab-icon blue (validated inventory — exactly these)**

A grep sweep of the whole test tree found six files OUTSIDE this plan's unit-test list that hard-assert `text-blue-500` on TAB-scoped icons (pane-scoped blue assertions are untouched — pane headers keep their coloring):

- `test/e2e/pane-activity-indicator-flow.test.tsx` (lines ~287, 347, 381, 466, 483, 535, 600 — positive tab-icon assertions)
- `test/e2e/codex-activity-indicator-flow.test.tsx` (line ~160 — `tabButton` assertion)
- `test/e2e-browser/specs/pane-activity-indicator.spec.ts` (~line 23)
- `test/e2e-browser/specs/truly-idle-alerting.spec.ts` (~line 141)
- `test/e2e-browser/specs/terminal-activity-rust.spec.ts` (~line 189 — busy-tab locator helper)
- `test/e2e-browser/specs/codex-status-completeness-rust.spec.ts` (~line 180 — same helper)

In each, update only the TAB-scoped expectations: `text-blue-500` → `text-zinc-600` (and where a locator selects busy tabs by the blue class, select by the new grey class or a structural attribute instead). Keep every scenario. Then verify the two vitest e2e suites:

```bash
npm run test:vitest -- run test/e2e/pane-activity-indicator-flow.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/e2e/codex-activity-indicator-flow.test.tsx --config config/vitest/vitest.config.ts
```

Expected: PASS. (The `test/e2e-browser/specs/*` Playwright specs are not runnable in this environment — update the locators for consistency; they run in the browser-suite pipeline.)

- [ ] **Step 5: Commit**

```bash
git add src/components/TabItem.tsx test/unit/client/components/TabItem.test.tsx test/unit/client/components/TabBar.test.tsx \
  test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/codex-activity-indicator-flow.test.tsx \
  test/e2e-browser/specs/pane-activity-indicator.spec.ts test/e2e-browser/specs/truly-idle-alerting.spec.ts \
  test/e2e-browser/specs/terminal-activity-rust.spec.ts test/e2e-browser/specs/codex-status-completeness-rust.spec.ts
git commit -m "feat(tabs): grey working / green ready / green-bar unacked states; dark-grey tab icons"
```

---

### Task 5: TabBar wiring — pass `isReady`, verify click clears the bar

`TabBar.renderSortableTab` already computes `needsAttention={!!attentionByTab[tab.id]}` and `busy` per tab, and its `onClick` already dispatches `dismissTabGreen(tab.id)` in `'click'` mode. Wire the new `isReady` prop through (both `SortableTab` and the `DragOverlay` `TabItem` around line 606), and add an integration test proving the bar shows for an unacked inactive tab and clears on click while the tab stays green.

**Files:**
- Modify: `src/components/TabBar.tsx`
- Test: `test/unit/client/components/TabBar.test.tsx`

**Interfaces:**
- Consumes: `TabItemProps.isReady` (Task 4), `turnCompletion.readyByTab` (Task 3), existing `attentionByTab` selector pattern in `TabBar.tsx`.
- Produces: `SortableTabProps.isReady: boolean`; no new exports.

- [ ] **Step 1: Write the failing test**

`test/unit/client/components/TabBar.test.tsx` (47KB) builds a real store with `configureStore` and renders `<TabBar/>` under a `<Provider>`. First read its top ~150 lines to learn the exact store-builder and render helper names, then add this test using those helpers verbatim (the assertions below are the contract; adapt only the setup calls to the file's existing helpers):

```tsx
  describe('canonical state wiring', () => {
    it('unacked inactive tab shows the green bar; clicking it clears the bar but keeps green', async () => {
      // Setup with the file's existing helpers: two tabs, tab-2 NOT active.
      // Then mark tab-2 ready+unacked through the real reducers:
      store.dispatch(markTabAttention({ tabId: 'tab-2' }))

      // Bar visible on the inactive unacked tab.
      expect(screen.getByTestId('tab-attention-bar')).toBeTruthy()

      // Click tab-2 (attentionDismiss defaults to 'click').
      fireEvent.click(screen.getByText('Tab 2'))

      // Attention cleared -> bar gone; readyByTab persists -> still green.
      // NOTE: after the click tab-2 is the ACTIVE tab, so "green" renders as the
      // active-ready style (green top border), not the inactive emerald fill.
      expect(store.getState().turnCompletion.attentionByTab['tab-2']).toBeUndefined()
      expect(store.getState().turnCompletion.readyByTab['tab-2']).toBe(true)
      expect(screen.queryByTestId('tab-attention-bar')).toBeNull()
      const tabEl = screen.getByText('Tab 2').closest('div[class*="group"]')
      expect(tabEl?.className).toContain('border-t-success')
    })
  })
```

Import `markTabAttention` from `@/store/turnCompletionSlice` in the test file if not already imported. If the helper's tab titles differ, use the titles the helper creates.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.test.tsx --config config/vitest/vitest.config.ts`
Expected: the new test FAILS on the final assertion — after the click, attention is cleared so nothing keeps the tab green (`bg-emerald-100` missing), because `isReady` is not wired yet. (The bar itself already renders via `needsAttention` from Task 4.)

- [ ] **Step 3: Implement**

In `src/components/TabBar.tsx`:

a) Where `attentionByTab` is selected from the store (search `attentionByTab` in the file), add next to it:

```ts
  const readyByTab = useAppSelector((s) => s.turnCompletion.readyByTab ?? {})
```

(Match the file's existing selector style — it may use a plain `useSelector`/typed hook; copy the `attentionByTab` line's form.)

b) `SortableTabProps`: add `isReady: boolean` after `needsAttention: boolean`; destructure it in `SortableTab` and pass `isReady={isReady}` to `<TabItem>`.

c) In `renderSortableTab`, pass `isReady={!!readyByTab[tab.id]}` after `needsAttention={...}`, and add `readyByTab` to the `useCallback` dependency array.

d) Find the `DragOverlay` `TabItem` (~line 606) — pass `isReady={activeId ? !!readyByTab[activeId] : false}` there too (match how it passes `needsAttention`; if it hardcodes `needsAttention={false}` for the overlay, hardcode `isReady={false}` for symmetry).

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/components/TabBar.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/TabBar.multirow.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/TabBar.a11y.test.tsx --config config/vitest/vitest.config.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TabBar.tsx test/unit/client/components/TabBar.test.tsx
git commit -m "feat(tabs): wire persistent ready state into the tab bar"
```

---

### Task 6: Uniform fixed 240px tab width

Tabs currently size to content: no width classes on the tab root, the label is capped at `max-w-[5rem]`, the rename input is `w-32` (tab jumps wider on rename), and the dnd-kit wrapper `<div>` (`TabBar.tsx` `SortableTab` return, ~line 124/272) has NO className, so tabs flex-shrink before the strip scrolls. Make every tab exactly `w-60` (240px), label truncating with ellipsis, rename input filling the same space, wrapper `shrink-0` so flex can never compress a tab. Multirow wrapping (`flex-wrap` on the strip) then produces clean aligned rows automatically.

**Files:**
- Modify: `src/components/TabItem.tsx` (container width, label span, rename input)
- Modify: `src/components/TabBar.tsx` (dnd-kit wrapper div)
- Test: `test/unit/client/components/TabItem.test.tsx`

**Interfaces:**
- Consumes: Task 4's container `cn(...)` block (edits its first string literal).
- Produces: visual contract only — tab root carries `w-60 shrink-0`; wrapper div carries `shrink-0`.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/client/components/TabItem.test.tsx`:

```tsx
  describe('fixed tab width', () => {
    it('every tab is fixed at 240px (w-60) and never flex-shrinks', () => {
      render(<TabItem {...defaultProps} />)
      const el = getTabElement()
      expect(el?.className).toContain('w-60')
      expect(el?.className).toContain('shrink-0')
    })

    it('the label fills the fixed width and truncates with ellipsis', () => {
      render(<TabItem {...defaultProps} tab={createTab({ title: 'Test Tab' })} />)
      const label = screen.getByText('Test Tab')
      expect(label.className).toContain('truncate')
      expect(label.className).toContain('flex-1')
      expect(label.className).toContain('min-w-0')
      expect(label.className).not.toContain('max-w-[5rem]')
    })

    it('the rename input fills the same space (no width jump on rename)', () => {
      render(<TabItem {...defaultProps} isRenaming={true} renameValue="abc" />)
      const input = screen.getByDisplayValue('abc')
      expect(input.className).toContain('flex-1')
      expect(input.className).toContain('min-w-0')
      expect(input.className).not.toContain('w-32')
    })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/components/TabItem.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — `w-60`/`shrink-0`/`flex-1` absent.

- [ ] **Step 3: Implement**

a) `src/components/TabItem.tsx` — container base string (first literal of the Task 4 `cn(...)` block): change

```
'group relative flex items-center gap-2 h-8 px-3 rounded-t-md border-x border-t border-muted-foreground/45 text-sm cursor-pointer transition-colors'
```

to

```
'group relative flex items-center gap-2 h-8 w-60 shrink-0 px-3 rounded-t-md border-x border-t border-muted-foreground/45 text-sm cursor-pointer transition-colors'
```

b) Label span: change

```tsx
        <span className="whitespace-nowrap truncate text-sm max-w-[5rem]">
```

to

```tsx
        <span className="whitespace-nowrap truncate text-sm flex-1 min-w-0">
```

c) Rename input: change

```tsx
          className="bg-transparent outline-none w-32 text-sm"
```

to

```tsx
          className="bg-transparent outline-none flex-1 min-w-0 text-sm"
```

d) `src/components/TabBar.tsx` — the `SortableTab` wrapper div:

```tsx
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
```

becomes

```tsx
    <div ref={setNodeRef} style={style} className="shrink-0" {...attributes} {...listeners}>
```

- [ ] **Step 4: Run tests to verify they pass (and check the scroll/overflow suites)**

```bash
npm run test:vitest -- run test/unit/client/components/TabItem.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/TabBar.overflow.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/TabBar.multirow.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/TabBar.mobile.test.tsx --config config/vitest/vitest.config.ts
```
Expected: PASS (jsdom does no real layout — the overflow suites mock scroll geometry, so class changes should be inert; if any assert the old label cap or wrapper classlist, update them to the new classes). Known concretely (validated by grep): `test/unit/client/components/TabItem.test.tsx` lines ~342 and ~346 POSITIVELY assert the old `max-w-[5rem]` cap — update those two to the new `flex-1 min-w-0` contract.

Validated (load-bearing check, code-level): TabBar's scroll/overflow/multirow JS needs NO logic changes — `useTabBarScroll` is entirely live-measurement-based (`scrollWidth`/`clientWidth`/rects, no width assumptions), the multirow strip contains only tab wrappers (arrows hidden in multirow; + button outside), and dnd-kit uses measured rects (DragOverlay inherits `w-60` from the TabItem class). At the live-server review stage, eyeball: inter-row `gap-0.5` aesthetics in multirow, and hold-scroll speed feel with wider tabs.

Note: `MobileTabStrip.tsx` is intentionally untouched — mobile shows only the active tab title, no tab chips, so fixed width does not apply there.

- [ ] **Step 5: Commit**

```bash
git add src/components/TabItem.tsx src/components/TabBar.tsx test/unit/client/components/TabItem.test.tsx test/unit/client/components/TabBar.overflow.test.tsx test/unit/client/components/TabBar.multirow.test.tsx
git commit -m "feat(tabs): fixed 240px tab width with label truncation (clean multirow alignment)"
```

(Only add the TabBar test files if they actually changed.)

---

### Task 7: Darker sidebar selected-item highlight

The selected sidebar row uses `bg-muted` (`src/components/Sidebar.tsx`, the `SidebarItem` `<button>` — the `isActiveTab ? 'bg-muted' : 'hover:bg-muted/50'` branch, ~line 957). `--muted` resolves to ≈`#F4F4F5` (light) / ≈`#27272A` (dark); the sidebar surface behind rows is `bg-card` (≈`#FAFAFA` light / ≈`#18181B` dark). Make the highlight slightly darker grey in both themes. Dark-mode note: the current dark highlight (`L=16%`) is *lighter* than the dark surface (`L=10%`); "darker" there means moving toward the surface, so use a translucent zinc-800 that composites to ≈`#212126` — still distinguishable from the `#18181B` card but visibly darker than today's `#27272A`. Do NOT change sidebar icon colors or hover styling.

**Files:**
- Modify: `src/components/Sidebar.tsx` (one line)
- Test: `test/unit/client/components/Sidebar.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: visual contract only — selected row class is `bg-zinc-200 dark:bg-zinc-800/60`.

- [ ] **Step 1: Update the failing tests**

In `test/unit/client/components/Sidebar.test.tsx`, find the two highlight assertions (search the file for `toHaveClass('bg-muted')` — there are exactly two: one positive on the selected row, one negative on an unselected row) and change them to:

```ts
      expect(button).toHaveClass('bg-zinc-200')
```

and

```ts
      expect(button).not.toHaveClass('bg-zinc-200')
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — the positive assertion fails (row still has `bg-muted`).

- [ ] **Step 3: Implement**

In `src/components/Sidebar.tsx`, in the `SidebarItem` button className:

```tsx
    isActiveTab
      ? 'bg-muted'
      : 'hover:bg-muted/50'
```

becomes

```tsx
    isActiveTab
      ? // Slightly darker selected highlight than bg-muted (zinc-100/zinc-800).
        // Dark mode uses translucent zinc-800 over the bg-card surface so it is
        // darker than the old #27272A while staying distinguishable from #18181B.
        'bg-zinc-200 dark:bg-zinc-800/60'
      : 'hover:bg-muted/50'
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx --config config/vitest/vitest.config.ts
npm run test:vitest -- run test/unit/client/components/SidebarItem.running-state.test.tsx --config config/vitest/vitest.config.ts
```
Expected: PASS (the running-state suite asserts icon colors, which are untouched).

- [ ] **Step 5: Commit**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "feat(sidebar): slightly darker selected-item highlight"
```

---

### Task 8: Update docs/index.html mock and AGENTS.md status note

Per AGENTS.md: "When adding new user-facing features or making significant UI changes, update `docs/index.html` to reflect them." Fixed-width tabs + new state colors qualify. `docs/index.html` is a self-contained static mock with a `/* ===== Tab Bar ===== */` CSS block (`.tab`, `.tab-dot`, `.tab-label`, ~lines 94-157) and static tab markup (~lines 648-682). Also append one sentence to the AGENTS.md "Agent Status Indicators" paragraph documenting the new visual mapping (the machinery description there stays as-is).

**Files:**
- Modify: `docs/index.html`
- Modify: `AGENTS.md` (the "Agent Status Indicators" paragraph, line ~172)

**Interfaces:**
- Consumes: final class/colors from Tasks 4, 6, 7.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Update the tab bar CSS in `docs/index.html`**

In the `/* ===== Tab Bar ===== */` block (this is a mock — keep it minimal and mirror the real values):

a) `.tab` rule: add fixed width + flex-none:

```css
.tab {
  width: 240px; flex: none;
  height: 32px; padding: 0 12px; display: flex; align-items: center; gap: 8px;
  border: 1px solid hsl(var(--muted-foreground) / .45); border-bottom: 1px solid hsl(var(--muted-foreground) / .45);
  border-radius: 6px 6px 0 0; cursor: pointer; white-space: nowrap;
  font-size: 14px; color: hsl(var(--muted-foreground)); background: hsl(var(--muted));
  transition: all .15s; user-select: none; position: relative; z-index: 1; margin-top: 4px;
}
```

b) `.tab-label` rule: fill the fixed width instead of a hard cap:

```css
.tab-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: 14px; }
```

(and delete the `.tab.active .tab-label { max-width: 10rem; }` rule).

c) State colors — replace the `.tab-dot.busy` blue and add the three canonical tab states after the `.tab.active::after` rule:

```css
/* Canonical tab states: grey = working, green = ready, green + bar = ready & unacknowledged */
.tab.working { background: #d4d4d8; color: #27272a; }
.tab.ready { background: #d1fae5; color: #064e3b; }
.tab.ready::before { content: none; }
.tab.ready.unacked::before {
  content: ''; position: absolute; left: 6px; right: 6px; bottom: 3px;
  height: 3px; border-radius: 9999px; background: #10b981;
}
.tab-dot.busy, .tab-dot.running { background: #71717a; }
.tab-dot.attention { background: hsl(var(--success)); }
.tab-dot.idle { background: hsl(var(--muted-foreground) / .4); }
.tab-icons .icon-xs { width: 12px; height: 12px; color: #52525b; }
.tab.active .tab-icons .icon-xs { color: #52525b; }
```

(The last two lines replace the existing `.tab-icons .icon-xs` color and the `.tab.active .tab-icons .icon-xs { color: hsl(var(--success)); }` rule — tab icons are dark grey only now.)

d) In the static tab markup (~lines 648-682), set one non-active tab's class to `class="tab working"` and another to `class="tab ready unacked"` so the mock demonstrates the states (adjust whichever demo tabs exist; keep the markup structure).

- [ ] **Step 2: Append the mapping note to AGENTS.md**

At the end of the "Agent Status Indicators" paragraph (AGENTS.md line ~172), append this sentence (single line, same paragraph):

```
Tab-bar visuals map these signals through `resolveTabVisualState` (`src/lib/tab-visual-state.ts`): GREY tab = busy/working, GREEN tab = ready (persistent `readyByTab`, survives acknowledgement), GREEN tab + green bar = ready and not yet acknowledged (`attentionByTab`; never shown on the active tab; waiting-for-approval also lands here); tabs whose panes have all exited render neutral.
```

- [ ] **Step 3: Eyeball the mock**

Open `docs/index.html` in a browser (`xdg-open docs/index.html` or view via any static server) and confirm the tab bar mock shows fixed-width tabs with a grey working tab and a green+bar unacked tab. No automated test covers this file.

- [ ] **Step 4: Commit**

```bash
git add docs/index.html AGENTS.md
git commit -m "docs: reflect fixed-width tabs and canonical tab states in mock + AGENTS.md"
```

---

### Task 9: Full verification, client build, and handoff report (NO push/PR)

**Files:** none created (verification only).

**Interfaces:**
- Consumes: everything above.
- Produces: a committed, buildable branch and a handoff summary.

- [ ] **Step 1: Typecheck and lint**

```bash
npm run typecheck:client
npm run lint
```
Expected: both exit 0. Fix any errors introduced by this work (and only those) before proceeding.

- [ ] **Step 2: Full client test suite**

Run: `npm run test:client` (coordinator-gated; may wait for the test lock — increase the command timeout accordingly, e.g. 900s)
Expected: PASS. If unrelated pre-existing failures appear, verify they also fail on the base commit (`git stash` is NOT needed — check `git log` for the file and reason before touching anything) and report them; do not "fix" unrelated failures in this branch.

- [ ] **Step 3: Build the client**

Run: `npm run build:client`
Expected: exit 0, output in `dist/client`. This is the only artifact needed to deploy to a test server (the Rust server serves `dist/client` from disk; `scripts/launch-rust.sh --client-only` + hard refresh picks it up without a server restart).

- [ ] **Step 4: Confirm clean tree and NO push**

```bash
git status --short   # expect: empty
git log --oneline origin/main..HEAD
```
Expected: clean tree; the branch contains this plan's commits. **Do NOT push, do NOT open a PR, do NOT merge.**

- [ ] **Step 5: Report**

Report in the final summary (no commit needed):
- Worktree: `/home/dan/code/freshell/.worktrees/tab-bar-visual-overhaul`
- Branch: `feat/tab-bar-visual-overhaul`
- Build for test server: `cd /home/dan/code/freshell/.worktrees/tab-bar-visual-overhaul && npm run build:client` (then `scripts/launch-rust.sh --client-only` + hard refresh)
- The canonical state mapping table and edge-case decisions from this plan's "Canonical Visual State Mapping" section.

---

## Self-Review Notes (performed while writing)

1. **Spec coverage:** (1) placeholder letter ~1px low → Task 1 (root-cause fix, not a blind nudge); (2) uniform fixed ~240px tabs with truncation, clean multirow rows → Task 6; (3) tab provider logos dark grey only, sidebar icons untouched → Task 4 (d), constrained to `TabItem.tsx`; sidebar highlight slightly darker → Task 7; (4) canonical grey/green/green+bar states with explicit mapping, unit tests, edge cases (active-tab completion, waiting, exited panes), no machinery changes → Tasks 2, 3, 4, 5; docs/index.html major-UI update → Task 8; TDD + client-only build + no-push → all tasks + Task 9; branch based on origin/main with PR #572 → verified (`02f862a7`).
2. **No silent deferrals:** every requirement has a production code path and a test; the only untested artifact is the static `docs/index.html` mock (eyeball step, Task 8 Step 3 — it is a nonfunctional mock by design). `readyByTab` is real store state wired end-to-end (Task 3 store → Task 5 UI → TabBar integration test proving click-clears-bar-keeps-green).
3. **Type consistency:** `TabVisualState`/`resolveTabVisualState`/`tabHasLivePane` (Task 2) are consumed with identical names/signatures in Task 4; `isReady?: boolean` (Task 4 TabItemProps) matches Task 5's `SortableTabProps.isReady: boolean` and `isReady={!!readyByTab[tab.id]}`; `clearTabReady({ tabId })` (Task 3) matches its dispatches in `tabsSlice` (closeTab AND closePaneWithCleanup); `data-testid="tab-attention-bar"` is used consistently in Tasks 4, 5.
4. **Load-bearing validation pass (post-planning):** 12 assumptions were surfaced and validated (ledger: `.worktrees/.the-usual-logs/tab-bar-visual-overhaul/load-bearing-ledger.md`). Verified: mode-gated edges (shells can never turn green — no gating needed in new code), baseline suites green (143/143), TabBar scroll/overflow JS width-agnostic (Task 6 stays CSS-only), theme color arithmetic exact, `hasLivePane` fallback fail-safe. Falsified & fixed in this plan: persistence dirty check must include `readyByTab` (Task 3d), `closePaneWithCleanup` must clear `readyByTab` + persisted map pruned to live tabs (Task 3d/e — covers multi-window tombstone removal), `cn` has no tailwind-merge so darken/green branches are now mutually exclusive (Task 4g, incl. the recorded decision that no emphasis applies to the active tab), and six out-of-plan e2e suites assert tab-icon blue (Task 4 Step 4b). Accepted residual risks: tab-vs-pane-header green split-brain (deliberate tab-bar-only scope) and the `y=11.15` cap-height constant (verifiable only in the live-server visual review).
