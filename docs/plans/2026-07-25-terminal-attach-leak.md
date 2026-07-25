# Terminal Attach Leak Fix Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Whenever the client stops referencing a terminal by ANY path (pane re-point, pane recreate, pane/tab close, split removal, layout replacement), send `terminal.detach` for the old terminalId — refcount-guarded across all pane layouts — so the server sees `hasClients=false` and its idle reaper can collect abandoned terminals.

**Architecture:** A new Redux middleware (`terminalDetachMiddleware`) diffs the set of terminalIds referenced across ALL pane layouts before/after every action and sends `terminal.detach` for every id that drops out. This single choke point covers every leak path uniformly (component gestures, keyboard shortcuts, `ui-commands`, REST/MCP agent API, layout restores). The triplicated caller-side detach sends in TabBar/PaneContainer/ContextMenuProvider are removed (the middleware now emits the identical message on the same dispatch). A tiny release-marks module suppresses redundant detaches for terminals that were just explicitly killed. The set-based diff gives the multi-pane guard for free: a terminalId referenced by two panes only detaches when the LAST reference disappears.

**Tech Stack:** React 18, Redux Toolkit (middleware), TypeScript, Vitest + Testing Library (jsdom).

## Global Constraints

- **Client-side fix ONLY.** Do NOT touch server idle-kill logic (`crates/freshell-terminal/src/registry.rs`, `crates/freshell-server/`, `server/terminal-registry.ts`) and do NOT address the separate PTY-output-bumps-`last_activity_at` hole — both explicitly out of scope.
- **Explicit tab-close semantics unchanged:** plain close ⇒ `terminal.detach` is still sent for each of the tab's terminals; Shift+click ⇒ `terminal.kill`. (After this plan, the detach is emitted by the middleware on the same `closeTab` dispatch instead of by TabBar directly — same message, same trigger, now refcount-guarded.)
- The detach-then-reattach in `TerminalView.runRefreshAttach` (src/components/TerminalView.tsx:2607) is a same-terminal refresh, NOT a release. It stays in the component untouched; the layout diff never fires for it (the id never leaves the layouts).
- `terminal.detach` wire shape is exactly `{ type: 'terminal.detach', terminalId }` (shared/ws-protocol.ts:348-351). The server replies with an error for a non-existent terminal (test/server/ws-protocol.test.ts:1425) — the middleware must not detach ids dropped by the dead-terminal census actions (`clearDeadTerminals`, `clearTerminalLiveHandles`).
- Red-Green-Refactor TDD for every task. Focused test runs: `npm run test:vitest -- run <paths> --config config/vitest/vitest.config.ts` (this default config governs `test/unit/client/**` AND `test/e2e/*.test.tsx`). Never raw `npx vitest`. Broad runs go through the coordinator gate (`npm test` / `npm run check`; check `npm run test:status` first).
- Client test setup (`test/setup/dom.ts`) makes ANY `console.error` a test failure and calls `resetWsClientForTests()` after each test. The new middleware must never `console.error` and must keep all diff state derived from `getState()` (no module-scope diff state). The only module-scope state introduced (release marks) gets a reset hook wired into `dom.ts`.
- Work happens in this worktree (`.worktrees/terminal-attach-leak`, branch `fix/terminal-attach-leak`). Never restart the self-hosted freshell server; never use broad kill patterns.
- Commit messages: conventional commits, each with the Amplifier co-author trailer (shown in every commit step below).
- Test-id hygiene: terminal ids are server-generated nanoids and never reused in production — the release-marks design depends on this (a stale mark can only ever suppress a detach for a terminal that no longer needs one).

## Design Notes (context for every task)

**Where the leak is:** `terminal.attach` is sent from exactly one place (`attachTerminal()`, src/components/TerminalView.tsx:2564). `terminal.detach` today is sent only from explicit gestures: TabBar close (src/components/TabBar.tsx:315), PaneContainer close (src/components/panes/PaneContainer.tsx:341), and three ContextMenuProvider actions (src/components/context-menu/ContextMenuProvider.tsx:301, :311, :1226). TerminalView never detaches on unmount (cleanup at :4422-4430) nor when `terminalId` changes (ref-sync effect at :959-989). Every other reference-dropping path — `updatePaneContent` re-point, `repairCodexIdentityMismatch`, `closeTab` via keyboard/ui-commands/agent API, split-subtree removal, `restoreLayout`/`hydratePanes` — leaks the subscription, so the server's idle reaper sees `hasClients=true` forever (observed in production 2026-07-25: 10 orphaned CLI terminals idle 10.8h–22.6h against a 3h threshold).

**Why a middleware:** `src/store/layoutMirrorMiddleware.ts` already proves the derive-from-layouts pattern (state diff after `next(action)`, sends WS via `getWsClient()`). `state.panes.layouts` is the single source of truth for "which terminals does the client reference"; diffing it catches all 7+ leak paths with one mechanism and makes the multi-pane guard structural (duplicate references ARE possible via `openSessionTab({ terminalId, forceNew: true })`, src/store/tabsSlice.ts:675-716).

**Why remove the component sends:** with the middleware in place they become double-detaches, and they lack the refcount guard (today TabBar detaches a terminal even if another tab still shows it). The middleware emits the identical message on the identical dispatch, so observable semantics are preserved — proven by keeping the existing component-level test assertions passing with the middleware concat'd into their test stores.

**Why release marks:** kill sites (`TabBar` shift-close, `ContextMenuProvider.tsx:930` session-reopen, `TerminalView.tsx:2910` opencode self-heal, `BackgroundSessions.tsx:120`) send `terminal.kill`; the subsequent layout change would make the middleware send a redundant `terminal.detach` for a terminal the server just removed (server replies with an error for non-existent terminals). `sendTerminalKill()` marks the id as released; the middleware consumes the mark and skips.

**Why skip `clearDeadTerminals` / `clearTerminalLiveHandles`:** these two actions (src/store/panesSlice.ts:1724, :1754) strip terminalIds ONLY for terminals the server itself reported dead or unrecoverable (payloads come from `terminal.inventory` / `terminals.changed` handling in App.tsx:883-885, :1044-1049). There is no live subscription to release, and detaching would generate a server error frame per corpse. This is not a scope reduction: the spec's goal (server-side reapability) is vacuous for terminals the server already reaped. `repairCodexIdentityMismatch` is deliberately NOT skipped — its stale terminal is typically still live and leaked.

**Close-during-create race (found in load-bearing validation):** the server does NOT auto-attach on `terminal.create` — the subscription is created only by the client's `terminal.created` handler (src/components/TerminalView.tsx:3754-3844), which writes the id into layouts via `updateContent` (:3799, synchronous dispatch) and then calls `attachTerminal` (:3842). If the pane is closed after the create is sent and `terminal.created` is processed in the dispatch→React-commit window, `updateContent` no-ops (pane node gone) yet `attachTerminal` still fires — a subscription for an id the layouts never contained, invisible to the middleware diff and leaked until disconnect. Task 11 closes this by gating `attachTerminal` on layout membership (`collectAllTerminalIds`); the same gate closes the sub-millisecond quarantine-repair re-attach race (TerminalView.tsx:797-819). Any residual acquisition leak is bounded to the connection lifetime: the server clears every subscription per-socket on close (server/ws-handler.ts:1219 `detachAllForSocket`).

**Validated server semantics the design relies on** (load-bearing validation 2026-07-25; assumption ledger + evidence reports live in the workflow logs dir): subscriptions are a per-connection `Set` — one detach fully clears them and `hasClients` is `clients.size > 0` (server/terminal-registry.ts:584, :4302), so a sole-client detach makes the terminal reaper-eligible; detach for a live terminal that isn't attached (or was already detached) succeeds benignly — only unknown ids draw an error frame (server/ws-handler.ts:2820-2836), which the client consumes benignly (no `console.error`; at most a `clearTerminalLiveHandles` dispatch, itself skip-listed — so no detach feedback loop is possible); `recoverableTerminalIds` are emitted only for terminals with `clients.size === 0` (PTY-exit and idle-kill paths, terminal-registry.ts:1502, :1424-1432), confirming the skip-list is not a preserved leak; terminal ids are minted server-side (`nanoid()`, terminal-registry.ts:1570) and `TerminalCreateSchema` is `.strict()` with no client-supplied id, underwriting the release-marks design.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/lib/pane-utils.ts` | Modify | Add `collectAllTerminalIds(layouts)` — union of terminal ids across all tab layouts |
| `src/lib/terminal-release-marks.ts` | Create | Module-scope set of terminal ids already released by an explicit send (kill); consumed by the middleware |
| `src/lib/terminal-kill.ts` | Create | `sendTerminalKill(terminalId)` — mark released + send `terminal.kill` (single home for all kill sends) |
| `src/store/terminalDetachMiddleware.ts` | Create | Layout-diff middleware that emits `terminal.detach` for dropped references |
| `src/store/store.ts` | Modify | Register the middleware |
| `test/setup/dom.ts` | Modify | Reset release marks after each test |
| `src/components/TabBar.tsx` | Modify | Remove plain-close detach loop; shift-close uses `sendTerminalKill` |
| `src/components/panes/PaneContainer.tsx` | Modify | Remove detach send in `handleClose` |
| `src/components/context-menu/ContextMenuProvider.tsx` | Modify | Remove 3 detach sends; kill site uses `sendTerminalKill` |
| `src/components/TerminalView.tsx` | Modify | Opencode self-heal kill (line 2910) uses `sendTerminalKill`; `attachTerminal` gated on layout membership (Task 11) |
| `src/components/BackgroundSessions.tsx` | Modify | Kill button uses `sendTerminalKill` |
| `test/unit/client/lib/collect-all-terminal-ids.test.ts` | Create | Helper tests |
| `test/unit/client/lib/terminal-release-marks.test.ts` | Create | Marks module tests |
| `test/unit/client/lib/terminal-kill.test.ts` | Create | Kill helper tests |
| `test/unit/client/store/terminalDetachMiddleware.test.ts` | Create | Core middleware behavior (all leak paths + guards) |
| `test/unit/client/store/storeDetachRegistration.test.ts` | Create | Production store registers the middleware |
| `test/unit/client/components/TabBar.test.tsx` | Modify | Middleware in test store; exactly-once + shift-no-detach tests |
| `test/unit/client/components/panes/PaneContainer.test.tsx` | Modify | Middleware in test store; exactly-once test |
| `test/unit/client/components/ContextMenuProvider.test.tsx` | Modify | Middleware in test store |
| `test/e2e/tab-focus-behavior.test.tsx` | Modify | Middleware in test store (assertions unchanged) |
| `test/e2e/replace-pane.test.tsx` | Modify | Convert tautological hand-rolled detach sends into real middleware-backed assertions |
| `test/unit/client/components/TerminalView.lifecycle.test.tsx` | Modify | Close-during-create: no attach for a pane no longer in layouts (Task 11) |

---

### Task 1: `collectAllTerminalIds` layout helper

**Files:**
- Modify: `src/lib/pane-utils.ts` (append after `collectTerminalIds`, which ends at line ~112 of the current file; `collectTerminalIds(node: PaneNode): string[]` sits at lines 30-42)
- Test: `test/unit/client/lib/collect-all-terminal-ids.test.ts` (create)

**Interfaces:**
- Consumes: existing `collectTerminalIds(node: PaneNode): string[]` and `PaneNode` type from `@/store/paneTypes` (already imported at the top of pane-utils.ts).
- Produces: `collectAllTerminalIds(layouts: Record<string, PaneNode | undefined>): Set<string>` exported from `@/lib/pane-utils` — Tasks 4+ rely on this exact name and signature.

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/lib/collect-all-terminal-ids.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { collectAllTerminalIds } from '@/lib/pane-utils'
import type { PaneNode } from '@/store/paneTypes'

function terminalLeaf(paneId: string, terminalId?: string): PaneNode {
  return {
    type: 'leaf',
    id: paneId,
    content: {
      kind: 'terminal',
      mode: 'shell',
      status: 'running',
      createRequestId: `req-${paneId}`,
      ...(terminalId ? { terminalId } : {}),
    },
  }
}

describe('collectAllTerminalIds', () => {
  it('returns an empty set for no layouts', () => {
    expect(collectAllTerminalIds({})).toEqual(new Set())
  })

  it('collects ids across multiple tab layouts', () => {
    const layouts: Record<string, PaneNode | undefined> = {
      'tab-1': terminalLeaf('pane-1', 'term-a'),
      'tab-2': terminalLeaf('pane-2', 'term-b'),
    }
    expect(collectAllTerminalIds(layouts)).toEqual(new Set(['term-a', 'term-b']))
  })

  it('walks split trees', () => {
    const layouts: Record<string, PaneNode | undefined> = {
      'tab-1': {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [terminalLeaf('pane-1', 'term-a'), terminalLeaf('pane-2', 'term-b')],
      },
    }
    expect(collectAllTerminalIds(layouts)).toEqual(new Set(['term-a', 'term-b']))
  })

  it('dedupes a terminal referenced by two layouts', () => {
    const layouts: Record<string, PaneNode | undefined> = {
      'tab-1': terminalLeaf('pane-1', 'term-dup'),
      'tab-2': terminalLeaf('pane-2', 'term-dup'),
    }
    expect(collectAllTerminalIds(layouts)).toEqual(new Set(['term-dup']))
  })

  it('ignores undefined layouts, non-terminal panes, and terminals without ids', () => {
    const layouts: Record<string, PaneNode | undefined> = {
      'tab-1': undefined,
      'tab-2': { type: 'leaf', id: 'pane-x', content: { kind: 'picker' } },
      'tab-3': terminalLeaf('pane-y'), // no terminalId yet (creating)
    }
    expect(collectAllTerminalIds(layouts)).toEqual(new Set())
  })
})
```

If the `PaneNode` split-literal above fails typecheck because of extra/missing fields, mirror the exact split-node shape used in `test/e2e/replace-pane.test.tsx` (it builds split `PaneNode` literals the same way).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/lib/collect-all-terminal-ids.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `collectAllTerminalIds` is not exported from `@/lib/pane-utils`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/lib/pane-utils.ts` (directly after the existing `collectTerminalIds` function):

```ts
/**
 * Union of every terminalId referenced by any pane in any tab layout.
 * This is the client's complete "terminals I currently reference" set —
 * the primitive the detach middleware diffs to spot dropped references.
 */
export function collectAllTerminalIds(
  layouts: Record<string, PaneNode | undefined>
): Set<string> {
  const ids = new Set<string>()
  for (const layout of Object.values(layouts)) {
    if (!layout) continue
    for (const terminalId of collectTerminalIds(layout)) {
      ids.add(terminalId)
    }
  }
  return ids
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/lib/collect-all-terminal-ids.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pane-utils.ts test/unit/client/lib/collect-all-terminal-ids.test.ts
git commit -m "feat(client): add collectAllTerminalIds layout helper" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: terminal release marks module

**Files:**
- Create: `src/lib/terminal-release-marks.ts`
- Modify: `test/setup/dom.ts` (add reset call to the existing `afterEach`)
- Test: `test/unit/client/lib/terminal-release-marks.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces (from `@/lib/terminal-release-marks`):
  - `markTerminalReleased(terminalId: string): void`
  - `consumeTerminalReleaseMark(terminalId: string): boolean` — returns true (and clears the mark) if the id was marked
  - `resetTerminalReleaseMarks(): void` — test hygiene
  Tasks 3, 4, and the global test setup rely on these exact names.

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/lib/terminal-release-marks.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  markTerminalReleased,
  consumeTerminalReleaseMark,
  resetTerminalReleaseMarks,
} from '@/lib/terminal-release-marks'

describe('terminal release marks', () => {
  beforeEach(() => {
    resetTerminalReleaseMarks()
  })

  it('consume returns false for an unmarked terminal', () => {
    expect(consumeTerminalReleaseMark('term-1')).toBe(false)
  })

  it('consume returns true exactly once for a marked terminal', () => {
    markTerminalReleased('term-1')
    expect(consumeTerminalReleaseMark('term-1')).toBe(true)
    expect(consumeTerminalReleaseMark('term-1')).toBe(false)
  })

  it('marks are independent per terminal id', () => {
    markTerminalReleased('term-1')
    expect(consumeTerminalReleaseMark('term-2')).toBe(false)
    expect(consumeTerminalReleaseMark('term-1')).toBe(true)
  })

  it('reset clears all marks', () => {
    markTerminalReleased('term-1')
    resetTerminalReleaseMarks()
    expect(consumeTerminalReleaseMark('term-1')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-release-marks.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — module `@/lib/terminal-release-marks` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/terminal-release-marks.ts`:

```ts
/**
 * Terminal ids whose server-side subscription has already been (or is about
 * to be) released by an explicit send — currently terminal.kill. The detach
 * middleware consumes a mark instead of sending a redundant terminal.detach
 * for a terminal the server just removed (the server replies with an error
 * for detach on a non-existent terminal).
 *
 * Terminal ids are server-generated and never reused, so a stale mark can
 * only ever suppress a detach for a terminal that no longer needs one.
 */
const releasedTerminalIds = new Set<string>()

export function markTerminalReleased(terminalId: string): void {
  releasedTerminalIds.add(terminalId)
}

export function consumeTerminalReleaseMark(terminalId: string): boolean {
  return releasedTerminalIds.delete(terminalId)
}

export function resetTerminalReleaseMarks(): void {
  releasedTerminalIds.clear()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-release-marks.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire the reset into global test hygiene**

In `test/setup/dom.ts`, extend the imports (currently `import { resetWsClientForTests } from '@/lib/ws-client'` at the top of the file):

```ts
import { resetTerminalReleaseMarks } from '@/lib/terminal-release-marks'
```

and in the existing `afterEach` (the one that starts with `resetWsClientForTests()`, around line 118), add the reset immediately after it:

```ts
afterEach(() => {
  resetWsClientForTests()
  resetTerminalReleaseMarks()
  // ... rest of the existing afterEach unchanged (console.error trap etc.)
```

- [ ] **Step 6: Run the two new suites plus one existing suite to prove setup still works**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-release-marks.test.ts test/unit/client/lib/collect-all-terminal-ids.test.ts test/unit/client/lib/terminal-attach-policy.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/terminal-release-marks.ts test/unit/client/lib/terminal-release-marks.test.ts test/setup/dom.ts
git commit -m "feat(client): add terminal release-marks module with global test reset" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: `sendTerminalKill` helper

**Files:**
- Create: `src/lib/terminal-kill.ts`
- Test: `test/unit/client/lib/terminal-kill.test.ts` (create)

**Interfaces:**
- Consumes: `getWsClient()` from `@/lib/ws-client` (`send(msg: unknown): void`); `markTerminalReleased` from Task 2.
- Produces: `sendTerminalKill(terminalId: string): void` from `@/lib/terminal-kill` — Tasks 6, 8, 9 replace raw `ws.send({ type: 'terminal.kill', ... })` calls with this.

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/lib/terminal-kill.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendTerminalKill } from '@/lib/terminal-kill'
import {
  consumeTerminalReleaseMark,
  resetTerminalReleaseMarks,
} from '@/lib/terminal-release-marks'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: mockSend }),
}))

describe('sendTerminalKill', () => {
  beforeEach(() => {
    mockSend.mockClear()
    resetTerminalReleaseMarks()
  })

  it('sends the terminal.kill message', () => {
    sendTerminalKill('term-1')
    expect(mockSend).toHaveBeenCalledWith({ type: 'terminal.kill', terminalId: 'term-1' })
  })

  it('marks the terminal released before sending', () => {
    sendTerminalKill('term-1')
    expect(consumeTerminalReleaseMark('term-1')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-kill.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — module `@/lib/terminal-kill` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/terminal-kill.ts`:

```ts
import { getWsClient } from './ws-client'
import { markTerminalReleased } from './terminal-release-marks'

/**
 * Send terminal.kill for a terminal, marking it released first so the
 * detach middleware does not follow up with a redundant terminal.detach
 * when the pane reference disappears from the layouts.
 *
 * Every terminal.kill send in the client goes through here.
 */
export function sendTerminalKill(terminalId: string): void {
  markTerminalReleased(terminalId)
  getWsClient().send({ type: 'terminal.kill', terminalId })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/lib/terminal-kill.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/terminal-kill.ts test/unit/client/lib/terminal-kill.test.ts
git commit -m "feat(client): add sendTerminalKill helper that marks terminals released" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: `terminalDetachMiddleware` (core)

**Files:**
- Create: `src/store/terminalDetachMiddleware.ts`
- Test: `test/unit/client/store/terminalDetachMiddleware.test.ts` (create)

**Interfaces:**
- Consumes: `collectAllTerminalIds` (Task 1), `consumeTerminalReleaseMark` (Task 2), `getWsClient` from `@/lib/ws-client`, action creators `clearDeadTerminals` / `clearTerminalLiveHandles` from `./panesSlice` (both exported — see src/store/panesSlice.ts export block at ~:1822-1856).
- Produces: `terminalDetachMiddleware: Middleware` exported from `@/store/terminalDetachMiddleware` — Tasks 5–8 and 10 concat this into stores.

Verified action payloads used in the tests below (from src/store/panesSlice.ts):
- `initLayout({ tabId, content, paneId? })` (:870)
- `updatePaneContent({ tabId, paneId, content })` (:1309)
- `splitPane({ tabId, paneId, direction, newContent, newPaneId? })` (:927)
- `closePane({ tabId, paneId })` (:1039 — no-op on single-leaf layouts)
- `replacePane({ tabId, paneId })` (:1266 — content becomes `{ kind: 'picker' }`)
- `removeLayout({ tabId })` (:1537 — the tab-close cascade target)
- `clearDeadTerminals({ liveTerminalIds })` (:1724)
- `clearTerminalLiveHandles({ terminalIds })` (:1754)
- `repairCodexIdentityMismatch({ tabId, paneId, staleTerminalId, expectedSessionRef, createRequestId })` (:1778)

- [ ] **Step 1: Write the failing tests**

Create `test/unit/client/store/terminalDetachMiddleware.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { configureStore } from '@reduxjs/toolkit'
import panesReducer, {
  initLayout,
  updatePaneContent,
  splitPane,
  closePane,
  replacePane,
  removeLayout,
  clearDeadTerminals,
  clearTerminalLiveHandles,
  repairCodexIdentityMismatch,
} from '@/store/panesSlice'
import { terminalDetachMiddleware } from '@/store/terminalDetachMiddleware'
import {
  markTerminalReleased,
  resetTerminalReleaseMarks,
} from '@/lib/terminal-release-marks'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({ send: mockSend }),
}))

function createStore() {
  return configureStore({
    reducer: { panes: panesReducer },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware().concat(terminalDetachMiddleware),
  })
}

function terminalContent(terminalId: string, createRequestId = `req-${terminalId}`) {
  return {
    kind: 'terminal' as const,
    mode: 'shell' as const,
    status: 'running' as const,
    terminalId,
    createRequestId,
  }
}

function detachedIds(): string[] {
  return mockSend.mock.calls
    .map(([msg]) => msg as { type?: string; terminalId?: string })
    .filter((msg) => msg?.type === 'terminal.detach')
    .map((msg) => msg.terminalId as string)
}

beforeEach(() => {
  mockSend.mockClear()
  resetTerminalReleaseMarks()
})

describe('terminalDetachMiddleware', () => {
  it('does not send anything when layouts only grow', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('term-b'),
      newPaneId: 'pane-2',
    }))
    expect(detachedIds()).toEqual([])
  })

  it('does not send anything for actions that do not touch pane layouts', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a') }))
    mockSend.mockClear()
    store.dispatch({ type: 'test/noop' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('detaches the old terminal when a pane is re-pointed to a new terminal', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-old') }))
    mockSend.mockClear()
    store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-new') }))
    expect(detachedIds()).toEqual(['term-old'])
  })

  it('detaches when a pane is replaced with the picker', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a') }))
    mockSend.mockClear()
    store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(detachedIds()).toEqual(['term-a'])
  })

  it('detaches when a split pane is closed', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('term-b'),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    store.dispatch(closePane({ tabId: 'tab-1', paneId: 'pane-2' }))
    expect(detachedIds()).toEqual(['term-b'])
  })

  it('detaches every terminal in a removed layout (tab close cascade)', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-a') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'vertical',
      newContent: terminalContent('term-b'),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    expect(detachedIds().sort()).toEqual(['term-a', 'term-b'])
  })

  it('does NOT detach a terminal still referenced by another tab (refcount guard)', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-dup', 'req-1') }))
    store.dispatch(initLayout({ tabId: 'tab-2', paneId: 'pane-2', content: terminalContent('term-dup', 'req-2') }))
    mockSend.mockClear()
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    expect(detachedIds()).toEqual([])
    store.dispatch(removeLayout({ tabId: 'tab-2' }))
    expect(detachedIds()).toEqual(['term-dup'])
  })

  it('sends a single detach when one action drops multiple references to the same terminal', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-dup', 'req-1') }))
    store.dispatch(splitPane({
      tabId: 'tab-1',
      paneId: 'pane-1',
      direction: 'horizontal',
      newContent: terminalContent('term-dup', 'req-2'),
      newPaneId: 'pane-2',
    }))
    mockSend.mockClear()
    store.dispatch(removeLayout({ tabId: 'tab-1' }))
    expect(detachedIds()).toEqual(['term-dup'])
  })

  it('skips detach for terminals dropped by clearDeadTerminals (server already reaped them)', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-dead') }))
    mockSend.mockClear()
    store.dispatch(clearDeadTerminals({ liveTerminalIds: [] }))
    expect(detachedIds()).toEqual([])
  })

  it('skips detach for terminals dropped by clearTerminalLiveHandles (recoverable-loss path)', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-lost') }))
    mockSend.mockClear()
    store.dispatch(clearTerminalLiveHandles({ terminalIds: ['term-lost'] }))
    expect(detachedIds()).toEqual([])
  })

  it('detaches the stale terminal on codex identity repair', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-stale') }))
    mockSend.mockClear()
    store.dispatch(repairCodexIdentityMismatch({
      tabId: 'tab-1',
      paneId: 'pane-1',
      staleTerminalId: 'term-stale',
      expectedSessionRef: { provider: 'codex', sessionId: 'session-1' },
      createRequestId: 'req-repair',
    }))
    expect(detachedIds()).toEqual(['term-stale'])
  })

  it('skips detach for a terminal marked released (explicit kill), consuming the mark', () => {
    const store = createStore()
    store.dispatch(initLayout({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-k') }))
    mockSend.mockClear()
    markTerminalReleased('term-k')
    store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(detachedIds()).toEqual([])

    // The mark was consumed: a fresh reference drop for the same id detaches again.
    store.dispatch(updatePaneContent({ tabId: 'tab-1', paneId: 'pane-1', content: terminalContent('term-k', 'req-k2') }))
    mockSend.mockClear()
    store.dispatch(replacePane({ tabId: 'tab-1', paneId: 'pane-1' }))
    expect(detachedIds()).toEqual(['term-k'])
  })
})
```

Note: if `initLayout`'s `paneId` option or the `terminalContent` literal trips the `PaneContentInput` type, adapt the literal minimally (e.g. add `shell: 'system' as const`) — do not change the assertions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/store/terminalDetachMiddleware.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — module `@/store/terminalDetachMiddleware` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/store/terminalDetachMiddleware.ts`:

```ts
import type { Middleware } from '@reduxjs/toolkit'
import { getWsClient } from '@/lib/ws-client'
import { collectAllTerminalIds } from '@/lib/pane-utils'
import { consumeTerminalReleaseMark } from '@/lib/terminal-release-marks'
import { clearDeadTerminals, clearTerminalLiveHandles } from './panesSlice'
import type { PaneNode } from './paneTypes'

type PanesStateSlice = { panes: { layouts: Record<string, PaneNode | undefined> } }

/**
 * These actions strip terminalIds ONLY for terminals the server itself
 * reported dead or unrecoverable (terminal.inventory / terminals.changed).
 * There is no live subscription to release, and the server replies with an
 * error for terminal.detach on a non-existent terminal — so skip them.
 */
const skipDetachActionTypes = new Set<string>([
  clearDeadTerminals.type,
  clearTerminalLiveHandles.type,
])

/**
 * Detach reconciler: whenever an action makes a terminalId disappear from
 * ALL pane layouts, the client no longer references that terminal and must
 * release its server-side attach subscription — otherwise the server sees
 * hasClients=true forever and its idle reaper can never collect the
 * terminal. The set diff over every layout is what guards the multi-pane
 * case: a terminal referenced by two panes only detaches when the LAST
 * reference goes away.
 *
 * Stateless by design (derives everything from getState) — safe under the
 * test suite's per-test ws-client reset.
 */
export const terminalDetachMiddleware: Middleware = (store) => (next) => (action) => {
  const beforeLayouts = (store.getState() as PanesStateSlice).panes.layouts
  const result = next(action)
  const afterLayouts = (store.getState() as PanesStateSlice).panes.layouts
  if (afterLayouts === beforeLayouts) return result

  const actionType = (action as { type?: unknown }).type
  if (typeof actionType === 'string' && skipDetachActionTypes.has(actionType)) {
    return result
  }

  const before = collectAllTerminalIds(beforeLayouts)
  if (before.size === 0) return result
  const after = collectAllTerminalIds(afterLayouts)

  for (const terminalId of before) {
    if (after.has(terminalId)) continue
    if (consumeTerminalReleaseMark(terminalId)) continue
    getWsClient().send({ type: 'terminal.detach', terminalId })
  }
  return result
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/store/terminalDetachMiddleware.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (12 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/terminalDetachMiddleware.ts test/unit/client/store/terminalDetachMiddleware.test.ts
git commit -m "feat(client): add terminalDetachMiddleware releasing dropped terminal references" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: register the middleware in the production store

**Files:**
- Modify: `src/store/store.ts` (middleware concat list at lines ~62-77)
- Test: `test/unit/client/store/storeDetachRegistration.test.ts` (create)

**Interfaces:**
- Consumes: `terminalDetachMiddleware` (Task 4).
- Produces: production store behavior — every reference drop in the real app now emits `terminal.detach`. (Between this task and Tasks 6–8 the components still ALSO send detach, so production would transiently double-detach; that is harmless — the server treats a second detach of a live terminal as a no-op subscriber removal — and is resolved by Tasks 6–8.)

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/store/storeDetachRegistration.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }))

vi.mock('@/lib/ws-client', () => ({
  getWsClient: () => ({
    send: mockSend,
    connect: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn().mockReturnValue(() => {}),
    onReconnect: vi.fn().mockReturnValue(() => {}),
    onDisconnect: vi.fn().mockReturnValue(() => {}),
  }),
  resetWsClientForTests: vi.fn(),
}))

import { store } from '@/store/store'
import { initLayout, removeLayout } from '@/store/panesSlice'

describe('production store', () => {
  it('registers terminalDetachMiddleware (removing a layout emits terminal.detach)', () => {
    store.dispatch(initLayout({
      tabId: 'detach-reg-tab',
      paneId: 'detach-reg-pane',
      content: {
        kind: 'terminal',
        mode: 'shell',
        status: 'running',
        terminalId: 'detach-reg-term',
        createRequestId: 'detach-reg-req',
      },
    }))
    mockSend.mockClear()
    store.dispatch(removeLayout({ tabId: 'detach-reg-tab' }))
    expect(mockSend).toHaveBeenCalledWith({ type: 'terminal.detach', terminalId: 'detach-reg-term' })
  })
})
```

Note: mocking `resetWsClientForTests` is required because `test/setup/dom.ts` imports it from the same mocked module. If other middleware (layoutMirror) emits additional messages during the dispatches, that is fine — the assertion uses `toHaveBeenCalledWith`, not exact call counts.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/store/storeDetachRegistration.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — no `terminal.detach` sent (middleware not registered).

- [ ] **Step 3: Register the middleware**

In `src/store/store.ts`, add the import next to the other middleware imports:

```ts
import { terminalDetachMiddleware } from './terminalDetachMiddleware'
```

and add it to the `.concat(...)` list after `layoutMirrorMiddleware`:

```ts
      layoutMirrorMiddleware,
      terminalDetachMiddleware,
      sessionActivityPersistMiddleware,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/store/storeDetachRegistration.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

Also run the one existing test that imports the production store, to confirm no interference:

Run: `npm run test:vitest -- run test/unit/client/fresh-agent-only-ui-state.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/store.ts test/unit/client/store/storeDetachRegistration.test.ts
git commit -m "feat(client): register terminalDetachMiddleware in production store" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 6: TabBar — middleware-backed close semantics

**Files:**
- Modify: `src/components/TabBar.tsx` (close handler at lines ~311-324)
- Modify: `test/unit/client/components/TabBar.test.tsx` (store helper + tests at :593 and :671)
- Modify: `test/e2e/tab-focus-behavior.test.tsx` (store helper at ~:77; detach assertions at :330-334 stay unchanged)

**Interfaces:**
- Consumes: `sendTerminalKill` (Task 3), `terminalDetachMiddleware` (Task 4).
- Produces: TabBar plain close relies on the middleware for detach; shift-close still kills. User-visible semantics unchanged.

Current handler (src/components/TabBar.tsx:311-324, verbatim):

```tsx
        onClose={(e) => {
          const terminalIds = getTerminalIdsForTab(tab)
          if (terminalIds.length > 0) {
            const messageType = e.shiftKey ? 'terminal.kill' : 'terminal.detach'
            for (const terminalId of terminalIds) {
              ws.send({
                type: messageType,
                terminalId,
              })
            }
          }
          dispatch(closeTab(tab.id))
        }}
```

- [ ] **Step 1: Add the middleware to both test stores**

In `test/unit/client/components/TabBar.test.tsx`: the file's `configureStore` helper currently has no `middleware:` key. Add one:

```ts
import { terminalDetachMiddleware } from '@/store/terminalDetachMiddleware'
```

and inside the `configureStore({...})` call:

```ts
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(terminalDetachMiddleware),
```

In `test/e2e/tab-focus-behavior.test.tsx`: same addition to its `createStore` (`configureStore` at ~line 78, currently no `middleware:` key).

Run both suites — they must still be green (double-send is not asserted anywhere yet):

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.test.tsx test/e2e/tab-focus-behavior.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 2: Write the failing tests**

In `test/unit/client/components/TabBar.test.tsx`, inside the `describe('tab interactions')` block (starts ~:530), add two tests. Reuse the exact same store construction, render helper, and close-button interaction code as the existing test `'close button sends detach message when pane has terminalId'` at :593 (same preloaded layout with `terminalId: 'term-1'`, same `fireEvent.click` on the close button; the file's hoisted ws send mock is the `expect` target — match the local mock variable name used at :627):

```ts
  it('plain close sends exactly one terminal.detach per terminal', () => {
    // ...same setup + plain close click as the test at :593...
    const detachMessages = sendMock.mock.calls
      .map(([msg]) => msg as { type?: string; terminalId?: string })
      .filter((msg) => msg?.type === 'terminal.detach')
    expect(detachMessages).toEqual([{ type: 'terminal.detach', terminalId: 'term-1' }])
  })

  it('shift close sends terminal.kill and no terminal.detach', () => {
    // ...same setup, but close click with { shiftKey: true }...
    const sentTypes = sendMock.mock.calls
      .map(([msg]) => (msg as { type?: string })?.type)
    expect(sentTypes).toContain('terminal.kill')
    expect(sentTypes).not.toContain('terminal.detach')
    expect(sendMock).toHaveBeenCalledWith({ type: 'terminal.kill', terminalId: 'term-1' })
  })
```

(`sendMock` here stands for the file's actual hoisted ws send mock — use its real name.)

- [ ] **Step 3: Run to verify both fail**

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL —
- exactly-once test: TWO detach messages (component + middleware);
- shift test: a `terminal.detach` appears (middleware fires because the raw kill send sets no release mark).

- [ ] **Step 4: Fix the component**

In `src/components/TabBar.tsx`, add the import:

```ts
import { sendTerminalKill } from '@/lib/terminal-kill'
```

and replace the close handler body:

```tsx
        onClose={(e) => {
          if (e.shiftKey) {
            const terminalIds = getTerminalIdsForTab(tab)
            for (const terminalId of terminalIds) {
              sendTerminalKill(terminalId)
            }
          }
          dispatch(closeTab(tab.id))
        }}
```

If `ws` (from `const ws = useMemo(() => getWsClient(), [])` at :182) is now unused in this file, remove it and drop it from the `renderSortableTab` `useCallback` dependency list (:352). If it is still used elsewhere in the file, leave it.

- [ ] **Step 5: Run TabBar + e2e suites to verify green**

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.test.tsx test/e2e/tab-focus-behavior.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS — the pre-existing detach assertions (:593 single-terminal, :671 split-layout multi-terminal, e2e :330-334 ordered multi-terminal) now pass via the middleware, proving plain-close semantics are unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/components/TabBar.tsx test/unit/client/components/TabBar.test.tsx test/e2e/tab-focus-behavior.test.tsx
git commit -m "fix(client): route TabBar close detach through terminalDetachMiddleware" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 7: PaneContainer — remove caller-side detach

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx` (`handleClose` at lines ~336-343)
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx` (store helper + `describe('terminal cleanup on pane close')` at :420)

**Interfaces:**
- Consumes: `terminalDetachMiddleware` (Task 4).
- Produces: pane close detach flows through the middleware (also covering the previously-leaking keyboard/`ui-commands`/agent-API close paths, which dispatch the same `closePaneWithCleanup` thunk).

Current code (src/components/panes/PaneContainer.tsx:336-343, verbatim head):

```tsx
  const handleClose = useCallback((paneId: string, content: PaneContent) => {
    // Clean up terminal process if this pane has one
    if (content.kind === 'terminal' && content.terminalId) {
      ws.send({
        type: 'terminal.detach',
        terminalId: content.terminalId,
      })
    }
```

- [ ] **Step 1: Add the middleware to the test store**

In `test/unit/client/components/panes/PaneContainer.test.tsx`, the `configureStore` helper already has a `middleware:` key that only tunes `getDefaultMiddleware` options. Extend it with `.concat(terminalDetachMiddleware)`:

```ts
import { terminalDetachMiddleware } from '@/store/terminalDetachMiddleware'
```

```ts
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({ /* keep the existing options object unchanged */ }).concat(terminalDetachMiddleware),
```

Run: `npm run test:vitest -- run test/unit/client/components/panes/PaneContainer.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS (nothing asserts single-send yet; the negative tests at :466/:507 involve panes without terminal ids, so the middleware stays silent there).

- [ ] **Step 2: Write the failing test**

Inside `describe('terminal cleanup on pane close')` (:420), add — reusing the setup and close interaction of the existing test at :421 verbatim, changing only the assertions:

```ts
  it('sends exactly one terminal.detach when closing a pane with terminalId', () => {
    // ...same setup + close interaction as the test at :421...
    const detachMessages = sendMock.mock.calls
      .map(([msg]) => msg as { type?: string; terminalId?: string })
      .filter((msg) => msg?.type === 'terminal.detach')
    expect(detachMessages).toHaveLength(1)
  })
```

(`sendMock` = the file's actual hoisted ws send mock name.)

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/components/panes/PaneContainer.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — two detach messages (component + middleware).

- [ ] **Step 4: Fix the component**

In `src/components/panes/PaneContainer.tsx`, delete the detach block from `handleClose` (keep everything else in the function — the dispatch of `closePaneWithCleanup` etc. is unchanged):

```tsx
  const handleClose = useCallback((paneId: string, content: PaneContent) => {
```

(the `if (content.kind === 'terminal' && content.terminalId) { ws.send({ type: 'terminal.detach', ... }) }` block is removed; the middleware fires on the resulting `closePane`/`closeTab` state change — note `closePaneWithCleanup` escalates single-leaf layouts to `closeTab`, so the `closePane` single-leaf no-op case is covered). If `content` or `ws` becomes unused, clean up per lint.

- [ ] **Step 5: Run to verify green**

Run: `npm run test:vitest -- run test/unit/client/components/panes/PaneContainer.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS — including the pre-existing positive tests (:421, :555/:592) now satisfied by the middleware, and the negative tests (:466 no-terminalId, :507 browser pane) still negative.

- [ ] **Step 6: Commit**

```bash
git add src/components/panes/PaneContainer.tsx test/unit/client/components/panes/PaneContainer.test.tsx
git commit -m "fix(client): route pane-close detach through terminalDetachMiddleware" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 8: ContextMenuProvider — remove caller-side detaches, mark the kill

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (four sites: ~:298-303, ~:306-315, ~:929-930, ~:1223-1229)
- Modify: `test/unit/client/components/ContextMenuProvider.test.tsx` (store helper + test at :2286)

**Interfaces:**
- Consumes: `sendTerminalKill` (Task 3), `terminalDetachMiddleware` (Task 4).
- Produces: context-menu replace/close flows rely on the middleware; the session-reopen kill is release-marked.

The four current sites (verbatim):

Site A — replace pane (~:298-303):
```tsx
    if (content?.kind === 'terminal' && content.terminalId) {
      ws.send({ type: 'terminal.detach', terminalId: content.terminalId })
    }
    dispatch(replacePane({ tabId, paneId }))
```

Site B — close tab (~:306-315):
```tsx
  const closeTabById = useCallback((tabId: string) => {
    const layout = panes[tabId]
    if (layout) {
      const terminalIds = collectTerminalIds(layout)
      for (const terminalId of terminalIds) {
        ws.send({ type: 'terminal.detach', terminalId })
      }
    }
    dispatch(closeTab(tabId))
  }, [dispatch, panes, ws])
```

Site C — session-reopen kill (~:929-930):
```tsx
    if (latest.content.kind === 'terminal' && latest.content.terminalId) {
      ws.send({ type: 'terminal.kill', terminalId: latest.content.terminalId })
    } else if (latest.content.kind === 'fresh-agent' && latest.content.sessionId) {
```

Site D — close pane (~:1223-1229):
```tsx
        closePane: (tabId, paneId) => {
          const content = panes[tabId] ? findPaneContent(panes[tabId], paneId) : null
          if (content?.kind === 'terminal' && content.terminalId) {
            ws.send({ type: 'terminal.detach', terminalId: content.terminalId })
          }
          dispatch(closePaneWithCleanup({ tabId, paneId }))
        },
```

- [ ] **Step 1: Add the middleware to the test store**

In `test/unit/client/components/ContextMenuProvider.test.tsx`, extend the existing `configureStore` `middleware:` option (it currently only tunes `getDefaultMiddleware`) with `.concat(terminalDetachMiddleware)` and add the import, exactly as in Task 7 Step 1.

Run: `npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 2: Write the failing test**

Next to the existing `it('detaches terminal and replaces pane with picker via context menu')` (:2286), add — reusing that test's setup and menu interaction verbatim, changing only the assertions:

```ts
  it('sends exactly one terminal.detach when replacing a pane via context menu', async () => {
    // ...same setup + "Replace pane" menu interaction as the test at :2286...
    const detachMessages = sendMock.mock.calls
      .map(([msg]) => msg as { type?: string; terminalId?: string })
      .filter((msg) => msg?.type === 'terminal.detach')
    expect(detachMessages).toHaveLength(1)
  })
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — two detach messages.

- [ ] **Step 4: Fix the component**

In `src/components/context-menu/ContextMenuProvider.tsx`:

Add the import:
```ts
import { sendTerminalKill } from '@/lib/terminal-kill'
```

Site A becomes:
```tsx
    dispatch(replacePane({ tabId, paneId }))
```

Site B becomes:
```tsx
  const closeTabById = useCallback((tabId: string) => {
    dispatch(closeTab(tabId))
  }, [dispatch])
```

Site C becomes:
```tsx
    if (latest.content.kind === 'terminal' && latest.content.terminalId) {
      sendTerminalKill(latest.content.terminalId)
    } else if (latest.content.kind === 'fresh-agent' && latest.content.sessionId) {
```

Site D becomes:
```tsx
        closePane: (tabId, paneId) => {
          dispatch(closePaneWithCleanup({ tabId, paneId }))
        },
```

Clean up any now-unused locals/imports (`collectTerminalIds`, `findPaneContent`, `panes`, `ws`) ONLY if they have no other uses in the file — check each before removing; adjust `useCallback` dependency arrays accordingly.

- [ ] **Step 5: Run to verify green**

Run: `npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx test/e2e/refresh-context-menu-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS. (`refresh-context-menu-flow` covers the TerminalView refresh detach ordering, which this task must not disturb.)

- [ ] **Step 6: Commit**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx test/unit/client/components/ContextMenuProvider.test.tsx
git commit -m "fix(client): route context-menu detach through terminalDetachMiddleware and mark reopen kill" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 9: remaining kill sites use `sendTerminalKill`

**Files:**
- Modify: `src/components/TerminalView.tsx` (line ~2910, opencode replay-window self-heal)
- Modify: `src/components/BackgroundSessions.tsx` (line ~120, Kill button)

**Interfaces:**
- Consumes: `sendTerminalKill` (Task 3).
- Produces: every `terminal.kill` in the client now sets a release mark (uniform rule; prevents a follow-up detach for the self-healed terminal when its pane is later recreated).

- [ ] **Step 1: Make the mechanical replacements**

In `src/components/TerminalView.tsx`, add the import and replace line ~2910:

```ts
import { sendTerminalKill } from '@/lib/terminal-kill'
```

```tsx
      sendTerminalKill(terminalId)
```

(was `ws.send({ type: 'terminal.kill', terminalId })`).

In `src/components/BackgroundSessions.tsx`, add the same import and replace line ~120:

```tsx
                    onClick={() => sendTerminalKill(t.terminalId)}
```

(was `onClick={() => ws.send({ type: 'terminal.kill', terminalId: t.terminalId })}`). If `ws` becomes unused in BackgroundSessions, remove its `useMemo(() => getWsClient(), [])` and import.

The wire message is byte-identical, and both files' tests mock `@/lib/ws-client` — `sendTerminalKill` routes through the same mocked `getWsClient()`, so existing kill assertions keep passing unchanged. That is the (existing) test coverage for this step; the mark behavior itself is covered by Task 3's unit tests and Task 4's marked-release middleware test.

- [ ] **Step 2: Run the affected suites**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx --config config/vitest/vitest.config.ts` (timeout: this file is large — allow up to 10 minutes)
Expected: PASS.

Then find and run any BackgroundSessions test file (search `test/unit/client` for `BackgroundSessions`); if one exists, run it — Expected: PASS. If none exists, note that in the commit body.

- [ ] **Step 3: Commit**

```bash
git add src/components/TerminalView.tsx src/components/BackgroundSessions.tsx
git commit -m "refactor(client): route remaining terminal.kill sends through sendTerminalKill" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 10: make replace-pane e2e assertions real

**Files:**
- Modify: `test/e2e/replace-pane.test.tsx`

**Interfaces:**
- Consumes: `terminalDetachMiddleware` (Task 4).
- Produces: previously-tautological detach assertions (the test hand-rolled `wsMocks.send({ type: 'terminal.detach', ... })` itself at :107, :197, :276) become genuine proof that the store emits the detach.

- [ ] **Step 1: Convert the tests (RED first)**

In `test/e2e/replace-pane.test.tsx`:

1. Add the middleware to `createStore` (the `configureStore` at ~:28 has no `middleware:` key):

```ts
import { terminalDetachMiddleware } from '@/store/terminalDetachMiddleware'
```
```ts
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(terminalDetachMiddleware),
```

2. In each of the three tests (at :88, :176, :238), DELETE the hand-rolled send block, e.g. at ~:103-108:

```ts
    // Simulate what ContextMenuProvider does: detach terminal, then dispatch replacePane
    const paneContent = findPaneContent(store.getState().panes.layouts['tab-1'], 'pane-1')
    expect(paneContent?.kind).toBe('terminal')
    if (paneContent?.kind === 'terminal' && paneContent.terminalId) {
      wsMocks.send({ type: 'terminal.detach', terminalId: paneContent.terminalId })
    }
```

becomes:

```ts
    const paneContent = findPaneContent(store.getState().panes.layouts['tab-1'], 'pane-1')
    expect(paneContent?.kind).toBe('terminal')
```

(keep the `replacePane` / `closePane` dispatch and the existing `expect(wsMocks.send).toHaveBeenCalledWith({ type: 'terminal.detach', terminalId: 'term-1' })` assertions — they are now satisfied only if the middleware really emits).

To honor RED: make the deletions FIRST without adding the middleware, run the file, and confirm the three assertions fail; then add the middleware concat and re-run.

Caveat for the test at :238 ("closing pane with matching terminal"): if it dispatches `closePane` on a single-leaf layout, the reducer is a no-op and the middleware will not fire — in that case restructure that one test's preloaded layout to a two-pane split (mirror the split-layout literal already used elsewhere in the same file) so the close actually removes the pane.

- [ ] **Step 2: Run RED then GREEN**

Run: `npm run test:vitest -- run test/e2e/replace-pane.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL after deletions (3 tests), PASS after the middleware concat.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/replace-pane.test.tsx
git commit -m "test(e2e): assert replace-pane detach from the middleware instead of hand-rolling it" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 11: gate `attachTerminal` on layout membership (close-during-create fix)

**Files:**
- Modify: `src/components/TerminalView.tsx` (`attachTerminal()`, line ~2564)
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

**Interfaces:**
- Consumes: `collectAllTerminalIds` from `@/lib/pane-utils` (Task 1); the current Redux state read imperatively inside the component (use react-redux's `useStore()` — `const store = useStore()` — unless TerminalView already has an imperative state-access pattern; match the file's existing pattern if one exists).
- Produces: `attachTerminal` becomes a silent no-op for any terminalId not currently referenced by `state.panes.layouts`.

**Why (validated in the load-bearing stage, validator-G4):** the server does not auto-attach on create; the client's `terminal.created` handler writes the id into layouts (`updateContent`, :3799) and then attaches (:3842). If the pane's layout removal is dispatched after the create was sent but before `terminal.created` is processed, `updateContent` no-ops yet the attach still fires — a subscription for an id the layouts never contained, invisible to the middleware diff, leaked until the socket closes. Gating at `attachTerminal` (the single attach choke point, :2564) closes that race AND the sub-millisecond quarantine-repair re-attach race (:797-819). Every legitimate attach passes the gate: the created handler dispatches `updateContent` synchronously before attaching, and mount/refresh/hydration attaches use ids the layouts already reference.

- [ ] **Step 1: Write the failing test**

In `test/unit/client/components/TerminalView.lifecycle.test.tsx`, locate the existing test that exercises the create → `terminal.created` → attach flow (it delivers a `terminal.created` message and asserts a `terminal.attach` send for the new id). Add a sibling test reusing that test's setup verbatim: `it('does not attach when the pane was removed before terminal.created arrives')` — after the create request is sent but BEFORE delivering `terminal.created`, dispatch the layout removal for the pane's tab through the test store (`removeLayout`/`closeTab`, matching how the harness manipulates layouts), then deliver the `terminal.created` message and assert that NO `{ type: 'terminal.attach', terminalId: <newId> }` is ever sent:

```ts
    const attachMessages = sendMock.mock.calls
      .map(([msg]) => msg as { type?: string; terminalId?: string })
      .filter((msg) => msg?.type === 'terminal.attach' && msg.terminalId === newId)
    expect(attachMessages).toHaveLength(0)
```

(`sendMock` = the file's actual hoisted ws send mock name.) If the harness cannot deliver a created message after a store change while the component is still mounted, fall back to any deterministic path through `attachTerminal` with the id absent from layouts (e.g. remove the layout via store dispatch, then trigger the component's refresh/re-attach path and assert no re-attach send).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx --config config/vitest/vitest.config.ts` (timeout: this file is large — allow up to 10 minutes)
Expected: the new test FAILS — attach is currently sent unconditionally.

- [ ] **Step 3: Write minimal implementation**

In `src/components/TerminalView.tsx`, add the imports (`collectAllTerminalIds` from `@/lib/pane-utils`; `useStore` from react-redux if no imperative state access exists yet) and, at the top of `attachTerminal()` (:2564) before any send:

```ts
    // Never attach a terminal the layouts no longer reference: the layout-diff
    // middleware can only release subscriptions it saw acquired. Covers the
    // close-during-create race and stale deferred re-attach timers.
    const layouts = store.getState().panes.layouts
    if (!collectAllTerminalIds(layouts).has(terminalId)) {
      return
    }
```

- [ ] **Step 4: Run to verify green**

Run: `npm run test:vitest -- run test/unit/client/components/TerminalView.lifecycle.test.tsx --config config/vitest/vitest.config.ts` (allow up to 10 minutes)
Expected: PASS — the new test plus every pre-existing lifecycle test. If a pre-existing test fails because its store genuinely lacks a layout entry for the terminal it attaches, fix that TEST's preloaded layouts to include the pane (matching production, where every mounted TerminalView has a layout node) — never weaken the gate.

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "fix(client): gate terminal attach on layout membership to close create-race leak" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 12: full verification

**Files:** none new.

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: clean (fix any unused-variable fallout from Tasks 6-9 with `npm run lint:fix` or targeted edits, then re-run).

- [ ] **Step 2: Coordinated full suite (typecheck + both vitest configs)**

First check the gate: `npm run test:status` — if another agent holds it, wait (do NOT kill a foreign holder).

Run: `FRESHELL_TEST_SUMMARY="terminal-attach-leak: middleware-based detach reconciler" npm run check` (timeout: allow up to 30 minutes)
Expected: typecheck clean, full suite green.

- [ ] **Step 3: Fix anything that fails, then re-run until green**

Likely fallout candidates and their fixes:
- Tests that build stores with the panes reducer and mock `@/lib/ws-client` may now observe extra `terminal.detach` sends if they drop terminal references mid-test. Fix by adjusting the assertion to filter message types (never by weakening the middleware).
- Tests that do NOT mock `@/lib/ws-client` but dispatch reference-dropping panes actions through the PRODUCTION store would hit a real `WsClient` — `test/setup/dom.ts` resets the singleton per test and jsdom has no live socket; sends queue harmlessly. Only act if a failure actually appears.

- [ ] **Step 4: Commit any test-fallout fixes**

```bash
git add -A
git commit -m "test(client): align remaining suites with middleware-based terminal detach" -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

(Skip this commit if Step 3 required no changes.)

---

## Self-Review Record

**1. Spec coverage** — every leak path in the spec maps to a covering mechanism + test:

| Spec path | Mechanism | Test |
|---|---|---|
| Pane re-pointed to a new terminal (resume session into pane) | middleware diff on `updatePaneContent` | Task 4 "re-pointed" test |
| Dead-terminal recreate (`clearTerminalContentForRecreate` via `clearDeadTerminals`/`clearTerminalLiveHandles`) | deliberately skipped — the terminal is server-reported dead/unrecoverable; no subscription exists to release and detach would only draw server error frames. Design Notes documents this; it preserves the spec's outcome (reapability) rather than reducing scope | Task 4 skip tests |
| Codex identity repair (live stale terminal) | middleware diff on `repairCodexIdentityMismatch` | Task 4 repair test |
| Pane closed (button, context menu, keyboard, ui-commands, agent API) | all paths dispatch `closePaneWithCleanup` → `closePane`/`closeTab`; middleware diff | Task 4 close test; Task 7 component tests |
| Split-pane removed | middleware diff sees every leaf of a removed subtree | Task 4 removeLayout multi-terminal test |
| Tab closed (any path incl. keyboard/API, previously leaking) | `closeTab` → `removeLayout`; middleware diff | Task 4 removeLayout tests; Task 6 TabBar tests; tab-focus e2e |
| TerminalView unmount | every unmount that drops the reference does so via a layouts change (restoreLayout/hydratePanes/removeLayout/closePane), caught by the diff; unmount WITHOUT a state change (tab switch) still references the terminal and must NOT detach — background attach is intentional (`registerForBackgroundHydration`) | Task 4 (all diff tests); "no layouts change ⇒ no send" test |
| Multi-pane guard ("another pane still displays the same terminal") | set-diff over ALL layouts | Task 4 refcount test |
| Explicit tab-close semantics unchanged | plain close ⇒ middleware emits detach on same dispatch; Shift ⇒ `sendTerminalKill` | Task 6 (pre-existing assertions kept passing + 2 new tests) |
| Close-during-create race (subscription acquired for an id never present in layouts — found by load-bearing validation, falsified assumption A9) | `attachTerminal` gated on layout membership via `collectAllTerminalIds`; also closes the quarantine-repair re-attach timer race | Task 11 no-attach-after-removal test |
| Scope guard: no server changes | no server/crates file appears in the File Structure | — |

**1b. No silent deferrals** — the only mocked boundary is `@/lib/ws-client` in unit tests; the production wire path (`getWsClient().send`) is exercised unmocked in the app and the message shape matches the server's Zod schema (shared/ws-protocol.ts:348). No stub is left standing in for production behavior; the production store registration itself is behavior-tested (Task 5). The clearDead/clearLiveHandles skip is an explicit, documented design decision (dead terminals have no subscription), not a deferral.

**2. Placeholder scan** — the two component-test steps (Tasks 6-8) intentionally reference the neighbouring test's setup by exact line number instead of duplicating unquotable file-local harness code; all assertions, all production code, and all new modules are given in full. No TBD/TODO items remain.

**3. Type consistency** — `collectAllTerminalIds(layouts: Record<string, PaneNode | undefined>): Set<string>` (Task 1) matches its uses in Task 4; `markTerminalReleased`/`consumeTerminalReleaseMark`/`resetTerminalReleaseMarks` (Task 2) match Tasks 3-4 and the dom.ts wiring; `sendTerminalKill(terminalId: string): void` (Task 3) matches Tasks 6, 8, 9; `terminalDetachMiddleware: Middleware` (Task 4) matches every concat site (Tasks 5-8, 10); `collectAllTerminalIds` (Task 1) is also consumed by the Task 11 attach gate with the same `Record<string, PaneNode | undefined> -> Set<string>` signature.

**4. Load-bearing validation (2026-07-25)** — the plan's silent dependencies were verified against the actual server and client code (assumption ledger + evidence reports in the workflow logs dir). Verified: set-based per-connection subscriptions with one-detach-full-clear; benign detach of live-but-unattached terminals (covers the Task 5→8 transitional double-detach); benign client handling of the detach error frame (no console.error, no feedback loop — the only follow-on dispatch, `clearTerminalLiveHandles`, is skip-listed); `recoverableTerminalIds` emitted only at `clients.size === 0` (the skip-list preserves no leak); server-minted, never-reused terminal ids (release-marks safety); no transient drop-then-readd layout flow (immediate detach is safe); no re-attach path for dropped ids; per-socket cleanup on disconnect. Falsified: "every subscription's id appears in layouts" — the close-during-create race acquires an invisible subscription; fixed by Task 11's attach gate.
