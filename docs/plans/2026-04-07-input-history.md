# Bash-Style Input History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bash-style up/down arrow history navigation to the ChatComposer used by agent-chat panes, persisted per-pane to localStorage with a 500-entry cap.

**Architecture:** A three-layer design: (1) `input-history-store.ts` — a pure localStorage persistence module keyed by paneId, handling dedup and eviction; (2) `useInputHistory` — a React hook providing cursor-based navigation with draft save/restore; (3) ChatComposer integration wiring ArrowUp/ArrowDown keys through the hook. History is scoped per pane, persists across page reloads, and survives component unmount/remount.

**Tech Stack:** React hooks, localStorage, @testing-library/react (unit + integration), Playwright (e2e-browser)

---

## Design Decisions

### Cursor model
- `cursorRef = -1` means "at the input line" (newest position, below all history)
- `cursorRef = 0` means "showing the newest history entry"
- `cursorRef = history.length - 1` means "showing the oldest entry"
- ArrowUp increments cursor (toward older), ArrowDown decrements (toward newer)
- History array stored as `[oldest, ..., newest]` — `history[history.length - 1 - cursor]` returns the entry at the current cursor position

### Draft save/restore
- When the user first presses ArrowUp from position -1, the current text is saved as `draftRef`
- When they ArrowDown back to position -1, the draft is restored
- Intermediate edits to history entries are NOT preserved — this matches browser-console/IPython behavior (simpler than full bash line-editing model)
- Rationale: full bash-style per-position edit preservation requires tracking modified copies for every cursor position, which is complex and fragile. The draft-only model is the standard for non-terminal history inputs.

### Cursor position guards
- ArrowUp only navigates history when the textarea cursor is on the first line (no newline in text before selectionStart) OR the text is empty
- ArrowDown only navigates when the textarea cursor is on the last line (no newline in text after selectionStart) OR the text is empty
- This preserves normal arrow-key movement within multi-line input

### Dedup policy
- Consecutive identical entries are deduplicated on push: if `history[last] === entry`, skip
- Non-consecutive duplicates are kept (the user may send the same message at different times)

### Max size (500)
- When pushing an entry that exceeds 500, the oldest entry is evicted (shift from front)
- The eviction happens before save so localStorage never holds more than 500 entries per pane

### Storage format
- Key: `freshell.input-history.v1:${paneId}` — one localStorage key per pane
- Value: JSON stringified `string[]`
- Try/catch on parse: corrupted data returns empty array (defensive)

### Hook stability
- `navigateUp`, `navigateDown`, `reset` have zero dependencies (use refs only), so they're referentially stable
- `push` depends on `paneId` (stable between pane switches)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/store/storage-keys.ts` | Modify | Add `inputHistory` key constant |
| `src/lib/input-history-store.ts` | Create | localStorage persistence: load, save, push, clear |
| `src/hooks/useInputHistory.ts` | Create | React hook: cursor navigation, draft, push, reset |
| `src/components/agent-chat/ChatComposer.tsx` | Modify | Wire ArrowUp/ArrowDown keys and push-on-send |
| `test/unit/client/lib/input-history-store.test.ts` | Create | Unit tests for persistence layer |
| `test/unit/client/hooks/useInputHistory.test.ts` | Create | Unit tests for hook |
| `test/unit/client/components/agent-chat/ChatComposer.test.tsx` | Modify | Add history navigation tests |
| `test/e2e/agent-chat-input-history-flow.test.tsx` | Create | Integration test (jsdom) |
| `test/e2e-browser/specs/agent-chat-input-history.spec.ts` | Create | Playwright e2e browser tests |

---

## Task 1: Storage key + Persistence layer + Unit tests

**Files:**
- Modify: `src/store/storage-keys.ts`
- Create: `src/lib/input-history-store.ts`
- Create: `test/unit/client/lib/input-history-store.test.ts`

- [ ] **Step 1: Write failing tests for input-history-store**

```typescript
// test/unit/client/lib/input-history-store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { loadHistory, pushEntry, clearHistory } from '@/lib/input-history-store'

describe('input-history-store', () => {
  beforeEach(() => {
    clearHistory('test-pane')
    clearHistory('other-pane')
  })

  it('returns empty array for unknown paneId', () => {
    expect(loadHistory('nonexistent')).toEqual([])
  })

  it('pushEntry adds an entry and returns updated history', () => {
    const result = pushEntry('test-pane', 'hello')
    expect(result).toEqual(['hello'])
    expect(loadHistory('test-pane')).toEqual(['hello'])
  })

  it('pushEntry deduplicates consecutive identical entries', () => {
    pushEntry('test-pane', 'hello')
    const result = pushEntry('test-pane', 'hello')
    expect(result).toEqual(['hello'])
  })

  it('pushEntry keeps non-consecutive duplicates', () => {
    pushEntry('test-pane', 'hello')
    pushEntry('test-pane', 'world')
    pushEntry('test-pane', 'hello')
    expect(loadHistory('test-pane')).toEqual(['hello', 'world', 'hello'])
  })

  it('evicts oldest entries beyond 500', () => {
    for (let i = 0; i < 502; i++) {
      pushEntry('test-pane', `entry-${i}`)
    }
    const history = loadHistory('test-pane')
    expect(history).toHaveLength(500)
    expect(history[0]).toBe('entry-2')
    expect(history[499]).toBe('entry-501')
  })

  it('isolates history per paneId', () => {
    pushEntry('test-pane', 'a')
    pushEntry('other-pane', 'b')
    expect(loadHistory('test-pane')).toEqual(['a'])
    expect(loadHistory('other-pane')).toEqual(['b'])
  })

  it('clearHistory removes stored history', () => {
    pushEntry('test-pane', 'hello')
    clearHistory('test-pane')
    expect(loadHistory('test-pane')).toEqual([])
  })

  it('handles corrupted localStorage data gracefully', () => {
    localStorage.setItem('freshell.input-history.v1:corrupted', 'not json{')
    expect(loadHistory('corrupted')).toEqual([])
  })

  it('preserves entry order across save and load', () => {
    pushEntry('test-pane', 'first')
    pushEntry('test-pane', 'second')
    pushEntry('test-pane', 'third')
    expect(loadHistory('test-pane')).toEqual(['first', 'second', 'third'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/client/lib/input-history-store.test.ts --run`
Expected: FAIL — module not found

- [ ] **Step 3: Add storage key and implement input-history-store**

Modify `src/store/storage-keys.ts` — add to `STORAGE_KEYS` object:
```typescript
inputHistory: 'freshell.input-history.v1',
```

Create `src/lib/input-history-store.ts`:
```typescript
import { STORAGE_KEYS } from '@/store/storage-keys'

const MAX_ENTRIES = 500

function storageKey(paneId: string): string {
  return `${STORAGE_KEYS.inputHistory}:${paneId}`
}

export function loadHistory(paneId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(paneId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function pushEntry(paneId: string, entry: string): string[] {
  const history = loadHistory(paneId)
  if (history.length > 0 && history[history.length - 1] === entry) {
    return history
  }
  history.push(entry)
  while (history.length > MAX_ENTRIES) {
    history.shift()
  }
  saveHistory(paneId, history)
  return history
}

export function saveHistory(paneId: string, entries: string[]): void {
  localStorage.setItem(storageKey(paneId), JSON.stringify(entries))
}

export function clearHistory(paneId: string): void {
  localStorage.removeItem(storageKey(paneId))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/client/lib/input-history-store.test.ts --run`
Expected: all PASS

- [ ] **Step 5: Refactor and verify**

Review the store implementation for clarity. Ensure the 500-constant is not duplicated. Re-run:

Run: `npm run test:vitest -- test/unit/client/lib/input-history-store.test.ts --run`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/store/storage-keys.ts src/lib/input-history-store.ts test/unit/client/lib/input-history-store.test.ts
git commit -m "feat: add input-history-store with localStorage persistence and 500-entry cap"
```

---

## Task 2: useInputHistory hook + Unit tests

**Files:**
- Create: `src/hooks/useInputHistory.ts`
- Create: `test/unit/client/hooks/useInputHistory.test.ts`

- [ ] **Step 1: Write failing tests for useInputHistory**

```typescript
// test/unit/client/hooks/useInputHistory.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInputHistory } from '@/hooks/useInputHistory'
import { clearHistory, loadHistory } from '@/lib/input-history-store'

describe('useInputHistory', () => {
  beforeEach(() => {
    clearHistory('hook-pane')
    clearHistory('other-hook-pane')
  })

  it('navigateUp returns null when no history exists', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    expect(result.current.navigateUp('')).toBeNull()
  })

  it('navigateUp returns newest entry first', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => {
      result.current.push('first')
      result.current.push('second')
    })
    expect(result.current.navigateUp('')).toBe('second')
  })

  it('navigateUp returns null at oldest entry', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => { result.current.push('only') })
    result.current.navigateUp('')
    expect(result.current.navigateUp('only')).toBeNull()
  })

  it('navigateDown returns null at newest position', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => { result.current.push('entry') })
    expect(result.current.navigateDown('')).toBeNull()
  })

  it('navigateDown restores saved draft', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => { result.current.push('entry') })
    result.current.navigateUp('my draft')
    expect(result.current.navigateDown('entry')).toBe('my draft')
  })

  it('full navigation cycle: up twice, down twice', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => {
      result.current.push('first')
      result.current.push('second')
      result.current.push('third')
    })
    expect(result.current.navigateUp('')).toBe('third')
    expect(result.current.navigateUp('third')).toBe('second')
    expect(result.current.navigateDown('second')).toBe('third')
    expect(result.current.navigateDown('third')).toBe('')
  })

  it('push adds entry and resets cursor', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => {
      result.current.push('first')
      result.current.push('second')
    })
    result.current.navigateUp('')
    result.current.navigateUp('second')
    act(() => { result.current.push('third') })
    expect(result.current.navigateUp('')).toBe('third')
    expect(result.current.navigateUp('third')).toBe('second')
  })

  it('reset clears cursor and draft without pushing', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => { result.current.push('entry') })
    result.current.navigateUp('my draft')
    act(() => { result.current.reset() })
    expect(result.current.navigateDown('')).toBeNull()
    expect(result.current.navigateUp('')).toBe('entry')
  })

  it('saves draft on first navigateUp only', () => {
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    act(() => {
      result.current.push('first')
      result.current.push('second')
    })
    result.current.navigateUp('original draft')
    result.current.navigateUp('second')
    expect(result.current.navigateDown('first')).toBe('second')
    expect(result.current.navigateDown('second')).toBe('original draft')
  })

  it('resets when paneId changes', () => {
    const { result, rerender } = renderHook(
      ({ paneId }) => useInputHistory(paneId),
      { initialProps: { paneId: 'hook-pane' } }
    )
    act(() => { result.current.push('entry-a') })
    result.current.navigateUp('')
    rerender({ paneId: 'other-hook-pane' })
    expect(result.current.navigateUp('')).toBeNull()
  })

  it('loads history from store on mount', () => {
    const { pushEntry } = await import('@/lib/input-history-store')
    pushEntry('hook-pane', 'pre-existing')
    const { result } = renderHook(() => useInputHistory('hook-pane'))
    expect(result.current.navigateUp('')).toBe('pre-existing')
  })

  it('no-ops when paneId is undefined', () => {
    const { result } = renderHook(() => useInputHistory(undefined))
    expect(result.current.navigateUp('')).toBeNull()
    expect(result.current.navigateDown('')).toBeNull()
    act(() => { result.current.push('should not persist') })
    expect(loadHistory('undefined')).toEqual([])
  })
})
```

**Note:** The `await import` in "loads history from store on mount" should be a regular import at the top. Adjust accordingly:

```typescript
import { clearHistory, loadHistory, pushEntry } from '@/lib/input-history-store'

// ... in the test:
it('loads history from store on mount', () => {
  pushEntry('hook-pane', 'pre-existing')
  const { result } = renderHook(() => useInputHistory('hook-pane'))
  expect(result.current.navigateUp('')).toBe('pre-existing')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/client/hooks/useInputHistory.test.ts --run`
Expected: FAIL — module not found

- [ ] **Step 3: Implement useInputHistory hook**

Create `src/hooks/useInputHistory.ts`:
```typescript
import { useCallback, useEffect, useRef } from 'react'
import { loadHistory, pushEntry as storePushEntry } from '@/lib/input-history-store'

export interface UseInputHistoryReturn {
  navigateUp: (currentText: string) => string | null
  navigateDown: (currentText: string) => string | null
  push: (entry: string) => void
  reset: () => void
}

export function useInputHistory(paneId: string | undefined): UseInputHistoryReturn {
  const cursorRef = useRef(-1)
  const draftRef = useRef('')
  const historyRef = useRef<string[]>([])
  const paneIdRef = useRef(paneId)

  useEffect(() => {
    if (paneId !== paneIdRef.current || paneIdRef.current === undefined) {
      paneIdRef.current = paneId
    }
    historyRef.current = paneId ? loadHistory(paneId) : []
    cursorRef.current = -1
    draftRef.current = ''
  }, [paneId])

  const navigateUp = useCallback((currentText: string): string | null => {
    const history = historyRef.current
    if (history.length === 0) return null
    if (cursorRef.current >= history.length - 1) return null

    if (cursorRef.current === -1) {
      draftRef.current = currentText
    }

    cursorRef.current++
    return history[history.length - 1 - cursorRef.current]
  }, [])

  const navigateDown = useCallback((_currentText: string): string | null => {
    if (cursorRef.current <= -1) return null

    cursorRef.current--

    if (cursorRef.current === -1) {
      return draftRef.current
    }

    const history = historyRef.current
    return history[history.length - 1 - cursorRef.current]
  }, [])

  const push = useCallback((entry: string): void => {
    if (!paneId) return
    historyRef.current = storePushEntry(paneId, entry)
    cursorRef.current = -1
    draftRef.current = ''
  }, [paneId])

  const reset = useCallback((): void => {
    cursorRef.current = -1
    draftRef.current = ''
  }, [])

  return { navigateUp, navigateDown, push, reset }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/client/hooks/useInputHistory.test.ts --run`
Expected: all PASS

- [ ] **Step 5: Refactor and verify**

Review for clarity. Ensure callback deps are correct (navigateUp/navigateDown have no deps since they use refs; push depends on paneId). Re-run:

Run: `npm run test:vitest -- test/unit/client/hooks/useInputHistory.test.ts --run`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useInputHistory.ts test/unit/client/hooks/useInputHistory.test.ts
git commit -m "feat: add useInputHistory hook with cursor-based navigation and draft preservation"
```

---

## Task 3: ChatComposer integration + extended tests

**Files:**
- Modify: `src/components/agent-chat/ChatComposer.tsx`
- Modify: `test/unit/client/components/agent-chat/ChatComposer.test.tsx`

- [ ] **Step 1: Write failing tests for history navigation in ChatComposer**

Add the following test block to `test/unit/client/components/agent-chat/ChatComposer.test.tsx`:

```typescript
import { clearHistory } from '@/lib/input-history-store'

// Add to the existing afterEach:
// clearHistory('test-pane')
// clearHistory('pane-a')
// clearHistory('pane-b')

// New describe block:
describe('input history navigation', () => {
  afterEach(() => {
    clearHistory('test-pane')
  })

  it('ArrowUp on empty input navigates to previous history entry', async () => {
    const user = userEvent.setup()
    render(<ChatComposer paneId="test-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')

    await user.type(textarea, 'first message{Enter}')
    await user.type(textarea, 'second message{Enter}')
    await user.click(textarea)
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('second message')
  })

  it('ArrowUp navigates through multiple entries', async () => {
    const user = userEvent.setup()
    render(<ChatComposer paneId="test-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')

    await user.type(textarea, 'first{Enter}')
    await user.type(textarea, 'second{Enter}')
    await user.click(textarea)
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('second')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('first')
  })

  it('ArrowDown restores draft after navigating up', async () => {
    const user = userEvent.setup()
    render(<ChatComposer paneId="test-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')

    await user.type(textarea, 'history entry{Enter}')
    await user.type(textarea, 'my draft')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('history entry')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('my draft')
  })

  it('ArrowDown at bottom position does nothing', async () => {
    render(<ChatComposer paneId="test-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('')
  })

  it('ArrowUp does not navigate when cursor is not on first line', async () => {
    const user = userEvent.setup()
    render(<ChatComposer paneId="test-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')

    await user.type(textarea, 'history entry{Enter}')
    await user.type(textarea, 'line1{Shift>}{Enter}{/Shift}')
    // Cursor is now on line 2, not on first line — ArrowUp should NOT navigate
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('line1\n')
  })

  it('sends add to history and can be recalled', async () => {
    const onSend = vi.fn()
    const user = userEvent.setup()
    render(<ChatComposer paneId="test-pane" onSend={onSend} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')

    await user.type(textarea, 'sent message{Enter}')
    expect(onSend).toHaveBeenCalledWith('sent message')
    expect(textarea).toHaveValue('')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('sent message')
  })

  it('history is independent per pane', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <ChatComposer paneId="pane-a" onSend={() => {}} onInterrupt={() => {}} />
    )
    await user.type(screen.getByRole('textbox'), 'pane-a message{Enter}')
    unmount()

    render(<ChatComposer paneId="pane-b" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('')
  })
})
```

Also add `clearHistory('test-pane')`, `clearHistory('pane-a')`, `clearHistory('pane-b')` to the existing `afterEach` block in the main `describe('ChatComposer', ...)`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- test/unit/client/components/agent-chat/ChatComposer.test.tsx --run`
Expected: FAIL — history navigation tests fail (ArrowUp does not populate textarea)

- [ ] **Step 3: Implement ChatComposer integration**

Modify `src/components/agent-chat/ChatComposer.tsx`:

1. Add import:
```typescript
import { useInputHistory } from '@/hooks/useInputHistory'
```

2. Add helper functions before the component:
```typescript
function isOnFirstLine(textarea: HTMLTextAreaElement): boolean {
  const textBefore = textarea.value.substring(0, textarea.selectionStart)
  return !textBefore.includes('\n')
}

function isOnLastLine(textarea: HTMLTextAreaElement): boolean {
  const textAfter = textarea.value.substring(textarea.selectionStart)
  return !textAfter.includes('\n')
}
```

3. Inside the component, after the `text` state, add the hook:
```typescript
const { navigateUp, navigateDown, push, reset } = useInputHistory(paneId)
```

4. Modify `handleSend` to push to history and reset:
```typescript
const handleSend = useCallback(() => {
  const trimmed = text.trim()
  if (!trimmed) return
  push(trimmed)
  onSend(trimmed)
  setText('')
  if (paneId) clearDraft(paneId)
  if (textareaRef.current) {
    textareaRef.current.style.height = 'auto'
  }
}, [text, onSend, paneId, push])
```

5. Modify `handleKeyDown` to handle ArrowUp/ArrowDown:
```typescript
const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
  const tabDir = getTabSwitchShortcutDirection(e)
  if (tabDir) {
    e.preventDefault()
    e.stopPropagation()
    dispatch(tabDir === 'next' ? switchToNextTab() : switchToPrevTab())
    return
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSend()
    return
  }
  if (e.key === 'Escape' && isRunning) {
    e.preventDefault()
    onInterrupt()
    return
  }
  if (e.key === 'ArrowUp' && textareaRef.current && isOnFirstLine(textareaRef.current)) {
    const next = navigateUp(text)
    if (next !== null) {
      e.preventDefault()
      setText(next)
      if (paneId) setDraft(paneId, next)
    }
    return
  }
  if (e.key === 'ArrowDown' && textareaRef.current && isOnLastLine(textareaRef.current)) {
    const next = navigateDown(text)
    if (next !== null) {
      e.preventDefault()
      setText(next)
      if (paneId) setDraft(paneId, next)
    }
    return
  }
}, [dispatch, handleSend, isRunning, onInterrupt, navigateUp, navigateDown, text, paneId])
```

6. In the paneId-change effect, add `reset()`:
```typescript
useEffect(() => {
  if (paneId !== prevPaneIdRef.current) {
    prevPaneIdRef.current = paneId
    setText(paneId ? getDraft(paneId) : '')
    reset()
    requestAnimationFrame(() => {
      if (textareaRef.current) resizeTextarea(textareaRef.current)
    })
  }
}, [paneId, resizeTextarea, reset])
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- test/unit/client/components/agent-chat/ChatComposer.test.tsx --run`
Expected: all PASS (both old and new tests)

- [ ] **Step 5: Refactor and verify broader suite**

Check that the handleKeyDown dependency array is correct and minimal. Ensure no regressions in existing tests:

Run: `npm run test:vitest -- test/unit/client/components/agent-chat/ --run`
Expected: all PASS

Run: `npm run test:vitest -- test/unit/client/ --run`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/agent-chat/ChatComposer.tsx test/unit/client/components/agent-chat/ChatComposer.test.tsx
git commit -m "feat: wire useInputHistory into ChatComposer with ArrowUp/Down navigation"
```

---

## Task 4: E2E integration test (jsdom)

**Files:**
- Create: `test/e2e/agent-chat-input-history-flow.test.tsx`

This test validates the full ChatComposer → useInputHistory → input-history-store chain in jsdom with a real Redux store, exercising ArrowUp/ArrowDown via `fireEvent` and verifying textarea value changes.

- [ ] **Step 1: Write the integration test**

```typescript
// test/e2e/agent-chat-input-history-flow.test.tsx
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatComposer from '../../src/components/agent-chat/ChatComposer'
import { clearHistory } from '../../src/lib/input-history-store'

const mockDispatch = vi.fn()
vi.mock('@/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: () => ({}),
}))

vi.mock('@/store/tabsSlice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store/tabsSlice')>()
  return {
    ...actual,
    switchToNextTab: () => ({ type: 'tabs/switchToNextTab' }),
    switchToPrevTab: () => ({ type: 'tabs/switchToPrevTab' }),
  }
})

describe('agent chat input history flow', () => {
  afterEach(() => {
    cleanup()
    clearHistory('flow-pane')
    mockDispatch.mockClear()
  })

  it('end-to-end: send messages, navigate history, verify values', async () => {
    const onSend = vi.fn()
    const user = userEvent.setup()
    render(<ChatComposer paneId="flow-pane" onSend={onSend} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox', { name: 'Chat message input' })

    await user.type(textarea, 'message alpha{Enter}')
    expect(onSend).toHaveBeenCalledWith('message alpha')
    expect(textarea).toHaveValue('')

    await user.type(textarea, 'message beta{Enter}')
    expect(onSend).toHaveBeenCalledWith('message beta')
    expect(textarea).toHaveValue('')

    await user.click(textarea)
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('message beta')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('message alpha')

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('message beta')

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('')
  })

  it('preserves draft through navigation cycle', async () => {
    const user = userEvent.setup()
    render(<ChatComposer paneId="flow-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')

    await user.type(textarea, 'existing entry{Enter}')
    await user.type(textarea, 'work in progress')

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('existing entry')

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea).toHaveValue('work in progress')
  })

  it('history survives component unmount and remount', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <ChatComposer paneId="flow-pane" onSend={() => {}} onInterrupt={() => {}} />
    )
    await user.type(screen.getByRole('textbox'), 'persistent message{Enter}')
    unmount()

    render(<ChatComposer paneId="flow-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('persistent message')
  })

  it('deduplicates consecutive identical sends', async () => {
    const user = userEvent.setup()
    render(<ChatComposer paneId="flow-pane" onSend={() => {}} onInterrupt={() => {}} />)
    const textarea = screen.getByRole('textbox')

    await user.type(textarea, 'same{Enter}')
    await user.type(textarea, 'same{Enter}')
    await user.click(textarea)

    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('same')
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea).toHaveValue('same')
  })
})
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm run test:vitest -- test/e2e/agent-chat-input-history-flow.test.tsx --run`
Expected: all PASS

- [ ] **Step 3: Refactor and verify**

Run broader e2e suite to check no regressions:

Run: `npm run test:vitest -- test/e2e/ --run`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add test/e2e/agent-chat-input-history-flow.test.tsx
git commit -m "test: add e2e integration tests for agent chat input history navigation"
```

---

## Task 5: E2E browser tests (Playwright)

**Files:**
- Create: `test/e2e-browser/specs/agent-chat-input-history.spec.ts`

These tests run against a real production server and Chromium browser, exercising the complete stack including localStorage persistence across page reloads.

- [ ] **Step 1: Write the Playwright spec**

```typescript
// test/e2e-browser/specs/agent-chat-input-history.spec.ts
import { test, expect } from '../helpers/fixtures.js'

test.describe('Agent Chat Input History', () => {
  async function setupAgentChatPane(page: any, harness: any, terminal: any) {
    await terminal.waitForTerminal()

    const tabId = await harness.getActiveTabId()
    expect(tabId).toBeTruthy()
    const layout = await harness.getPaneLayout(tabId!)
    expect(layout?.type).toBe('leaf')
    const paneId = layout.id as string
    const sessionId = `sdk-e2e-history-${Date.now()}`
    const cliSessionId = '44444444-4444-4444-8444-444444444444'

    await page.evaluate((pId: string) => {
      window.__FRESHELL_TEST_HARNESS__?.setAgentChatNetworkEffectsSuppressed(pId, true)
    }, paneId)

    await page.evaluate((args: any) => {
      const h = window.__FRESHELL_TEST_HARNESS__
      h?.dispatch({ type: 'agentChat/sessionCreated', payload: { requestId: 'req-history', sessionId: args.sid } })
      h?.dispatch({ type: 'agentChat/sessionInit', payload: { sessionId: args.sid, cliSessionId: args.cliSid } })
      h?.dispatch({
        type: 'panes/updatePaneContent',
        payload: {
          tabId: args.tid,
          paneId: args.pid,
          content: {
            kind: 'agent-chat',
            provider: 'freshclaude',
            createRequestId: 'req-history',
            sessionId: args.sid,
            status: 'idle',
          },
        },
      })
    }, { tid: tabId, pid: paneId, sid: sessionId, cliSid: cliSessionId })

    const textarea = page.getByRole('textbox', { name: 'Chat message input' })
    await expect(textarea).toBeVisible()
    return { tabId: tabId!, paneId, sessionId, textarea }
  }

  test('ArrowUp cycles through sent messages', async ({ freshellPage, page, harness, terminal }) => {
    const { textarea } = await setupAgentChatPane(page, harness, terminal)

    await textarea.click()
    await page.keyboard.type('first message')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    await page.keyboard.type('second message')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    await page.keyboard.press('ArrowUp')
    await expect(textarea).toHaveValue('second message')

    await page.keyboard.press('ArrowUp')
    await expect(textarea).toHaveValue('first message')

    await page.keyboard.press('ArrowDown')
    await expect(textarea).toHaveValue('second message')

    await page.keyboard.press('ArrowDown')
    await expect(textarea).toHaveValue('')
  })

  test('ArrowUp preserves current draft when navigating away', async ({ freshellPage, page, harness, terminal }) => {
    const { textarea } = await setupAgentChatPane(page, harness, terminal)

    await textarea.click()
    await page.keyboard.type('history entry')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    await page.keyboard.type('my draft')
    await page.keyboard.press('ArrowUp')
    await expect(textarea).toHaveValue('history entry')

    await page.keyboard.press('ArrowDown')
    await expect(textarea).toHaveValue('my draft')
  })

  test('history persists across page reload', async ({ freshellPage, page, harness, terminal, serverInfo }) => {
    const { paneId, sessionId } = await setupAgentChatPane(page, harness, terminal)

    const textarea = page.getByRole('textbox', { name: 'Chat message input' })
    await textarea.click()
    await page.keyboard.type('persistent message')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection()

    await page.waitForTimeout(1000)

    const localStorageData = await page.evaluate((pid: string) => {
      return localStorage.getItem(`freshell.input-history.v1:${pid}`)
    }, paneId)
    expect(JSON.parse(localStorageData!)).toContain('persistent message')
  })

  test('history scoped per pane (different paneIds are independent)', async ({ freshellPage, page, harness, terminal }) => {
    const { paneId: firstPaneId, sessionId } = await setupAgentChatPane(page, harness, terminal)
    const textarea = page.getByRole('textbox', { name: 'Chat message input' })

    await textarea.click()
    await page.keyboard.type('pane-one message')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    const historyKey1 = await page.evaluate((pid: string) => {
      return localStorage.getItem(`freshell.input-history.v1:${pid}`)
    }, firstPaneId)
    expect(JSON.parse(historyKey1!)).toEqual(['pane-one message'])

    const unrelatedKey = `freshell.input-history.v1:other-pane-${Date.now()}`
    const unrelatedData = await page.evaluate((key: string) => {
      return localStorage.getItem(key)
    }, unrelatedKey)
    expect(unrelatedData).toBeNull()
  })

  test('max 500 entries — oldest evicted', async ({ freshellPage, page, harness, terminal }) => {
    const { paneId } = await setupAgentChatPane(page, harness, terminal)

    await page.evaluate((pid: string) => {
      const entries: string[] = []
      for (let i = 0; i < 502; i++) {
        entries.push(`entry-${i}`)
      }
      localStorage.setItem(`freshell.input-history.v1:${pid}`, JSON.stringify(entries))
    }, paneId)

    const stored = await page.evaluate((pid: string) => {
      const raw = localStorage.getItem(`freshell.input-history.v1:${pid}`)
      return JSON.parse(raw!)
    }, paneId)
    expect(stored).toHaveLength(502)

    const textarea = page.getByRole('textbox', { name: 'Chat message input' })
    await textarea.click()
    await page.keyboard.type('overflow entry')
    await page.keyboard.press('Enter')
    await expect(textarea).toHaveValue('')

    const afterPush = await page.evaluate((pid: string) => {
      const raw = localStorage.getItem(`freshell.input-history.v1:${pid}`)
      return JSON.parse(raw!)
    }, paneId)
    expect(afterPush).toHaveLength(500)
    expect(afterPush[0]).toBe('entry-3')
    expect(afterPush[499]).toBe('overflow entry')
  })
})
```

- [ ] **Step 2: Run the e2e browser tests**

```bash
cd /home/user/code/freshell/.worktrees/add-input-history
npx playwright test test/e2e-browser/specs/agent-chat-input-history.spec.ts --project=chromium
```

Expected: all PASS

- [ ] **Step 3: Refactor and verify**

Review test helpers for reuse. Ensure no flaky timing. Re-run:

```bash
npx playwright test test/e2e-browser/specs/agent-chat-input-history.spec.ts --project=chromium
```

Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/agent-chat-input-history.spec.ts
git commit -m "test: add Playwright e2e browser tests for agent chat input history"
```

---

## Task 6: Final verification and lint

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all PASS

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: no errors

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "chore: address lint/typecheck findings from input history feature"
```
