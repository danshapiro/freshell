# Test Plan: Bash-Style Input History

> **Companion to:** `2026-04-07-input-history.md` (implementation plan)
> **Feature:** Up/down arrow history navigation in ChatComposer, persisted per-pane to localStorage with 500-entry cap.

---

## 1. Strategy Reconciliation

The AGENTS.md testing strategy requires:

| Requirement | How Satisfied |
|---|---|
| Red-Green-Refactor TDD | Each task in the plan writes failing tests first (steps 1-2), then implements (step 3), then verifies green (step 4) |
| Both unit & e2e coverage | Unit: store tests + hook tests + component tests. E2E: jsdom integration flow test. E2E-browser: Playwright spec |
| Check logs for debugging | Not directly applicable (no server component) |
| Full suite pass before merge | Task 6 runs `npm test`, `npm run lint`, `npx tsc --noEmit` |

All three test layers are covered. No deviations from the approved strategy.

---

## 2. Test Inventory

### Layer 1: Unit — Persistence Store

**File:** `test/unit/client/lib/input-history-store.test.ts`
**Source under test:** `src/lib/input-history-store.ts`

| # | Test Name | What It Verifies | Key Assertions |
|---|-----------|------------------|----------------|
| 1 | `returns empty array for unknown paneId` | `loadHistory` returns `[]` when no data exists | `loadHistory('nonexistent')` → `toEqual([])` |
| 2 | `pushEntry adds an entry and returns updated history` | Basic push + load round-trip | `pushEntry(...)` returns `['hello']`; `loadHistory(...)` returns `['hello']` |
| 3 | `pushEntry deduplicates consecutive identical entries` | Consecutive dedup: `['hello']` then push `'hello'` → still `['hello']` | Result length is 1, entry unchanged |
| 4 | `pushEntry keeps non-consecutive duplicates` | Same value at different times is kept | `['hello', 'world', 'hello']` after three pushes |
| 5 | `evicts oldest entries beyond 500` | Push 502 unique entries; oldest 2 are evicted | `history.length === 500`, `history[0] === 'entry-2'`, `history[499] === 'entry-501'` |
| 6 | `isolates history per paneId` | Different paneIds have independent histories | `loadHistory('test-pane')` ≠ `loadHistory('other-pane')` |
| 7 | `clearHistory removes stored history` | `clearHistory` deletes the localStorage key | `loadHistory` returns `[]` after clear |
| 8 | `handles corrupted localStorage data gracefully` | Bad JSON returns `[]`, no throw | `localStorage.setItem(key, 'not json{')` then `loadHistory` → `[]` |
| 9 | `preserves entry order across save and load` | Order is `[oldest, ..., newest]` after multiple pushes | `['first', 'second', 'third']` |

**Assessment:** 9 tests. Fully specified in the plan (Task 1, Step 1). No gaps.

---

### Layer 2: Unit — React Hook

**File:** `test/unit/client/hooks/useInputHistory.test.ts`
**Source under test:** `src/hooks/useInputHistory.ts`

| # | Test Name | What It Verifies | Key Assertions |
|---|-----------|------------------|----------------|
| 1 | `navigateUp returns null when no history exists` | Empty history is a no-op | `navigateUp('')` → `null` |
| 2 | `navigateUp returns newest entry first` | Cursor starts at -1, first Up shows newest | After push 'first','second': `navigateUp('')` → `'second'` |
| 3 | `navigateUp returns null at oldest entry` | Boundary: can't go past oldest | Two Ups on 1-entry history: second returns `null` |
| 4 | `navigateDown returns null at newest position` | Boundary: can't go past newest (cursor=-1) | `navigateDown('')` → `null` with no prior navigation |
| 5 | `navigateDown restores saved draft` | Draft saved on first Up, restored on Down to -1 | Up saves draft; Down returns `'my draft'` |
| 6 | `full navigation cycle: up twice, down twice` | Complete 3-entry cycle with draft restore | Up→'third', Up→'second', Down→'third', Down→`''` |
| 7 | `push adds entry and resets cursor` | After push, navigation restarts from newest | After navigating to older entry, push resets; next Up shows newest |
| 8 | `reset clears cursor and draft without pushing` | `reset()` returns to -1 without modifying history | After Up+reset, Down returns `null`; Up returns entry |
| 9 | `saves draft on first navigateUp only` | Draft is the text at the moment of first Up | Up×2 then Down×2 returns to original draft, not intermediate |
| 10 | `resets when paneId changes` | Hook reloads history for new paneId | After push+navigate on pane A, switch to pane B → no history |
| 11 | `loads history from store on mount` | Pre-existing localStorage data is available | `pushEntry` before mount; `navigateUp('')` → `'pre-existing'` |
| 12 | `no-ops when paneId is undefined` | Graceful handling of missing paneId | `navigateUp`/`navigateDown` → `null`; `push` doesn't persist |

**Assessment:** 12 tests. Fully specified in the plan (Task 2, Step 1). No gaps.

---

### Layer 3: Unit — ChatComposer Integration

**File:** `test/unit/client/components/agent-chat/ChatComposer.test.tsx`
**Source under test:** `src/components/agent-chat/ChatComposer.tsx`
**Action:** Add a new `describe('input history navigation')` block to the existing file

#### 3a. Existing Tests (must continue passing)

The existing 17 tests cover: rendering, send on Enter, Shift+Enter newline, disabled state, stop button, Escape interrupt, send button disabled, draft preservation (5 tests), autoFocus on disabled transition (3 tests), tab switching shortcuts (3 tests).

**Cleanup changes:**
- Add `import { clearHistory } from '@/lib/input-history-store'` to imports
- Add `clearHistory('test-pane')`, `clearHistory('pane-a')`, `clearHistory('pane-b')` to the existing `afterEach` block

#### 3b. New Tests

| # | Test Name | What It Verifies | Key Assertions |
|---|-----------|------------------|----------------|
| 1 | `ArrowUp on empty input navigates to previous history entry` | Send 2 messages, Up shows newest | After sending 'first','second': ArrowUp → value `'second message'` |
| 2 | `ArrowUp navigates through multiple entries` | Up×2 walks newest→oldest | ArrowUp → 'second', ArrowUp → 'first' |
| 3 | `ArrowDown restores draft after navigating up` | Draft save/restore through textarea | Type draft, Up → history entry, Down → original draft |
| 4 | `ArrowDown at bottom position does nothing` | No navigation below cursor=-1 | ArrowDown on empty → value stays `''` |
| 5 | `ArrowUp does not navigate when cursor is not on first line` | Multi-line guard for ArrowUp | Multi-line text + ArrowUp → value unchanged (`'line1\n'`) |
| 6 | `sends add to history and can be recalled` | Push-on-send + recall | After Enter, onSend called; ArrowUp shows sent text |
| 7 | `history is independent per pane` | Per-pane isolation in the component | Send on pane-a, unmount, mount pane-b → ArrowUp shows empty |

**Assessment:** 7 new tests + cleanup changes. Fully specified in the plan (Task 3, Step 1).

---

### Layer 4: E2E Integration (jsdom)

**File:** `test/e2e/agent-chat-input-history-flow.test.tsx`
**Source under test:** Full ChatComposer → useInputHistory → input-history-store chain

Uses the same mock pattern as the existing ChatComposer unit tests (`vi.mock('@/store/hooks')`, `vi.mock('@/store/tabsSlice')`).

| # | Test Name | What It Verifies | Key Assertions |
|---|-----------|------------------|----------------|
| 1 | `end-to-end: send messages, navigate history, verify values` | Full send→Up×2→Down×2 cycle | Values at each step: 'message beta' → 'message alpha' → 'message beta' → `''` |
| 2 | `preserves draft through navigation cycle` | Draft in real textarea survives Up/Down | Type draft, Up, Down → draft restored |
| 3 | `history survives component unmount and remount` | localStorage persistence across remount | Unmount after send, remount, ArrowUp → 'persistent message' |
| 4 | `deduplicates consecutive identical sends` | Consecutive dedup visible at UI level | Send 'same' twice; only 1 history entry (Up×2 stays at 'same', Down goes to '') |

**Assessment:** 4 tests. Fully specified in the plan (Task 4, Step 1). No gaps.

---

### Layer 5: E2E Browser (Playwright)

**File:** `test/e2e-browser/specs/agent-chat-input-history.spec.ts`
**Source under test:** Full stack in real Chromium with production server

Uses a shared `setupAgentChatPane` helper that:
1. Waits for terminal to be ready
2. Gets active tab/pane IDs from the Redux harness
3. Suppresses agent-chat network effects
4. Dispatches `agentChat/sessionCreated`, `agentChat/sessionInit`, and `panes/updatePaneContent` to set up an agent-chat pane
5. Returns `{ tabId, paneId, sessionId, textarea }`

| # | Test Name | What It Verifies | Key Assertions |
|---|-----------|------------------|----------------|
| 1 | `ArrowUp cycles through sent messages` | Full navigation in real browser | Send 2 msgs, Up×2→Down×2 with correct values at each step |
| 2 | `ArrowUp preserves current draft when navigating away` | Draft save/restore in real browser | Type draft, Up→history, Down→draft |
| 3 | `history persists across page reload` | localStorage survives full page reload | Send msg, `page.goto()` to reload, check localStorage contains 'persistent message' |
| 4 | `history scoped per pane (different paneIds are independent)` | Per-pane localStorage isolation | Send on pane A; check unrelated localStorage key is null |
| 5 | `max 500 entries — oldest evicted` | Eviction in real browser | Pre-populate 502 entries in localStorage, send 1 msg through UI → 500 entries, oldest evicted |

**Assessment:** 5 tests. Fully specified in the plan (Task 5, Step 1). No gaps.

---

## 3. Gaps and Additional Tests

### 3.1. Gap: ArrowDown multi-line guard

The plan tests that **ArrowUp** is blocked when the cursor is on line 2 of multi-line input (test 5 in Layer 3). However, there is no corresponding test for **ArrowDown** being blocked when the cursor is on line 1 of multi-line input.

**Recommended addition to Layer 3:**

```
Test: "ArrowDown does not navigate when cursor is not on last line"
File: test/unit/client/components/agent-chat/ChatComposer.test.tsx
Verify: ArrowDown on line 1 of 'line1\nline2' does NOT navigate history
Setup: Send a message to create history, type 'line1\nline2', place cursor on line 1
Assert: fireEvent.keyDown(ArrowDown) → textarea value still 'line1\nline2'
```

**Note:** Testing cursor position in jsdom can be fragile. If `selectionStart` is not reliably tracked by `userEvent`, this test may need to set `textarea.selectionStart` directly. If the test proves flaky, it can be moved to the Playwright layer where cursor positioning is reliable.

### 3.2. Gap: Push with whitespace-only or empty string

The `input-history-store.pushEntry` does not guard against empty/whitespace strings. The ChatComposer trims before calling `push`, so this won't happen in practice. But the store itself has no guard.

**Verdict:** Low risk. The hook's `push` function is only called from `handleSend` which trims and early-returns on empty. No additional test needed — the component-level tests cover this path.

### 3.3. Gap: Hook referential stability

The plan's design decisions state that `navigateUp`, `navigateDown`, and `reset` have zero dependencies and are referentially stable. No test verifies this explicitly.

**Verdict:** This is an implementation detail, not a behavior contract. Not required for correctness. If performance optimization becomes important later, a stability test can be added.

### 3.4. Gap: Intermediate edit discard

When the user navigates to a history entry, edits it in the textarea, then navigates away (Up or Down), the edit is lost. This matches the design (draft-only model), but no test explicitly verifies this behavior.

**Recommended addition to Layer 4 (e2e jsdom):**

```
Test: "editing a history entry then navigating away discards the edit"
File: test/e2e/agent-chat-input-history-flow.test.tsx
Verify: Navigate to history entry, edit it, navigate away then back → original entry
Setup: Send 'original', navigate Up to show 'original', type 'modified' suffix,
       navigate Down then Up again
Assert: textarea shows 'original' (edit was not preserved)
```

### 3.5. Gap: localStorage quota exceeded

No test for `localStorage.setItem` throwing due to quota.

**Verdict:** Extremely unlikely with 500 string entries. Acceptable to skip.

---

## 4. Summary

| Layer | File | Test Count | Plan Coverage | Gap Tests |
|---|---|---|---|---|
| Unit: Store | `test/unit/client/lib/input-history-store.test.ts` | 9 | 100% specified | 0 |
| Unit: Hook | `test/unit/client/hooks/useInputHistory.test.ts` | 12 | 100% specified | 0 |
| Unit: Component | `test/unit/client/components/agent-chat/ChatComposer.test.tsx` | 7 new | 100% specified | +1 (ArrowDown guard) |
| E2E Integration | `test/e2e/agent-chat-input-history-flow.test.tsx` | 4 | 100% specified | +1 (edit discard) |
| E2E Browser | `test/e2e-browser/specs/agent-chat-input-history.spec.ts` | 5 | 100% specified | 0 |
| **Total** | | **37** | | **+2 recommended** |

### Recommended gap tests to add (2 tests, low effort)

1. **ArrowDown multi-line guard** — Add to ChatComposer unit test block. ~10 lines.
2. **Intermediate edit discard** — Add to e2e integration flow test. ~15 lines.

Both are optional but improve coverage of the multi-line guard and draft-only design decision.

### No strategy deviations

The plan's test specifications fully satisfy the AGENTS.md requirements for TDD, unit coverage, and e2e coverage. No changes to the approved testing strategy are needed.

---

## 5. Execution Order

Tests should be written in the same order as the plan's tasks:

1. **Task 1:** `input-history-store.test.ts` → implement store → green
2. **Task 2:** `useInputHistory.test.ts` → implement hook → green
3. **Task 3:** ChatComposer history tests → wire integration → green + existing tests still pass
4. **Task 4:** E2E integration flow test → green (implementation already complete)
5. **Task 5:** Playwright spec → green
6. **Task 6:** Full suite verification (`npm test`, `npm run lint`, `npx tsc --noEmit`)
