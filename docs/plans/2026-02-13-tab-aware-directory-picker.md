# Tab-Aware Directory Picker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the directory picker default to the most-used directory in the current tab, and boost other tab directories plus the previous global default above the general candidate list.

**Architecture:** A pure frontend utility function computes the tab-preferred default by counting `initialCwd` occurrences across sibling panes. The `PickerWrapper` component passes this as `defaultCwd` and provides a `tabDirectories` list. The `DirectoryPicker` re-ranks its candidate list client-side: tab directories and the previous global default are boosted above the rest. No backend changes needed.

**Tech Stack:** React, Redux Toolkit, TypeScript, Vitest

---

### Task 1: Create `getTabDirectoryPreference` utility

A pure function that takes a `PaneNode` tree and returns `{ defaultCwd: string | undefined, tabDirectories: string[] }`. It walks the tree collecting `initialCwd` from all terminal and claude-chat panes, counts frequency, picks the most-used (alphabetical tiebreaker), and returns the sorted-by-frequency list.

**Files:**
- Create: `src/lib/tab-directory-preference.ts`
- Test: `test/unit/client/lib/tab-directory-preference.test.ts`

**Step 1: Write the failing tests**

Create the test file:

```typescript
import { describe, it, expect } from 'vitest'
import { getTabDirectoryPreference } from '@/lib/tab-directory-preference'
import type { PaneNode } from '@/store/paneTypes'

// Helper to create a terminal leaf
function terminalLeaf(id: string, initialCwd?: string): PaneNode {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'terminal',
      mode: 'claude',
      shell: 'system',
      createRequestId: `cr-${id}`,
      status: 'running',
      initialCwd,
    },
  }
}

// Helper to create a claude-chat leaf
function chatLeaf(id: string, initialCwd?: string): PaneNode {
  return {
    type: 'leaf',
    id,
    content: {
      kind: 'claude-chat',
      createRequestId: `cr-${id}`,
      status: 'connected',
      initialCwd,
    },
  }
}

// Helper to create a picker leaf
function pickerLeaf(id: string): PaneNode {
  return { type: 'leaf', id, content: { kind: 'picker' } }
}

// Helper to create a browser leaf
function browserLeaf(id: string): PaneNode {
  return { type: 'leaf', id, content: { kind: 'browser', url: '', devToolsOpen: false } }
}

function split(left: PaneNode, right: PaneNode): PaneNode {
  return {
    type: 'split',
    id: 'split-1',
    direction: 'horizontal',
    children: [left, right],
    sizes: [50, 50],
  }
}

describe('getTabDirectoryPreference', () => {
  it('returns undefined default and empty list for a single picker pane', () => {
    const result = getTabDirectoryPreference(pickerLeaf('p1'))
    expect(result).toEqual({ defaultCwd: undefined, tabDirectories: [] })
  })

  it('returns the only directory when one terminal pane exists', () => {
    const node = split(
      terminalLeaf('t1', '/home/user/code/freshell'),
      pickerLeaf('p1'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/home/user/code/freshell')
    expect(result.tabDirectories).toEqual(['/home/user/code/freshell'])
  })

  it('picks the most-used directory as default', () => {
    const node: PaneNode = {
      type: 'split',
      id: 's1',
      direction: 'horizontal',
      children: [
        split(
          terminalLeaf('t1', '/code/alpha'),
          terminalLeaf('t2', '/code/beta'),
        ),
        split(
          terminalLeaf('t3', '/code/alpha'),
          pickerLeaf('p1'),
        ),
      ],
      sizes: [50, 50],
    }
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/code/alpha')
    // tabDirectories sorted by frequency desc, then alpha
    expect(result.tabDirectories).toEqual(['/code/alpha', '/code/beta'])
  })

  it('uses alphabetical tiebreaker when directories have equal frequency', () => {
    const node = split(
      terminalLeaf('t1', '/code/beta'),
      terminalLeaf('t2', '/code/alpha'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/code/alpha')
    expect(result.tabDirectories).toEqual(['/code/alpha', '/code/beta'])
  })

  it('includes claude-chat pane directories', () => {
    const node = split(
      chatLeaf('c1', '/code/project'),
      terminalLeaf('t1', '/code/project'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/code/project')
    expect(result.tabDirectories).toEqual(['/code/project'])
  })

  it('ignores panes without initialCwd', () => {
    const node = split(
      terminalLeaf('t1', undefined),
      terminalLeaf('t2', '/code/alpha'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/code/alpha')
    expect(result.tabDirectories).toEqual(['/code/alpha'])
  })

  it('ignores browser and editor panes', () => {
    const node = split(
      browserLeaf('b1'),
      terminalLeaf('t1', '/code/alpha'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result.defaultCwd).toBe('/code/alpha')
    expect(result.tabDirectories).toEqual(['/code/alpha'])
  })

  it('returns undefined default and empty list when no panes have directories', () => {
    const node = split(
      terminalLeaf('t1', undefined),
      browserLeaf('b1'),
    )
    const result = getTabDirectoryPreference(node)
    expect(result).toEqual({ defaultCwd: undefined, tabDirectories: [] })
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/client/lib/tab-directory-preference.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `src/lib/tab-directory-preference.ts`:

```typescript
import type { PaneNode } from '@/store/paneTypes'

export type TabDirectoryPreference = {
  /** The best default directory for new panes in this tab (most-used, alpha tiebreaker) */
  defaultCwd: string | undefined
  /** All directories in use in this tab, sorted by frequency desc then alphabetically */
  tabDirectories: string[]
}

/**
 * Walk a pane tree and compute directory preference for the tab.
 * Counts initialCwd occurrences across terminal and claude-chat panes.
 * Returns the most-used directory (alphabetical tiebreaker) and a
 * frequency-sorted list of all tab directories.
 */
export function getTabDirectoryPreference(root: PaneNode): TabDirectoryPreference {
  const counts = new Map<string, number>()

  function walk(node: PaneNode): void {
    if (node.type === 'leaf') {
      const content = node.content
      if (content.kind === 'terminal' || content.kind === 'claude-chat') {
        const cwd = content.initialCwd?.trim()
        if (cwd) {
          counts.set(cwd, (counts.get(cwd) ?? 0) + 1)
        }
      }
      return
    }
    walk(node.children[0])
    walk(node.children[1])
  }

  walk(root)

  if (counts.size === 0) {
    return { defaultCwd: undefined, tabDirectories: [] }
  }

  // Sort by frequency descending, then alphabetically
  const sorted = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1]
    return a[0].localeCompare(b[0])
  })

  return {
    defaultCwd: sorted[0][0],
    tabDirectories: sorted.map(([dir]) => dir),
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/client/lib/tab-directory-preference.test.ts`
Expected: PASS (all 8 tests)

**Step 5: Commit**

```bash
git add src/lib/tab-directory-preference.ts test/unit/client/lib/tab-directory-preference.test.ts
git commit -m "feat: add getTabDirectoryPreference utility for tab-aware directory ranking

Walk the pane tree to count initialCwd occurrences across terminal and
claude-chat panes. Returns the most-used directory (alphabetical
tiebreaker) as defaultCwd and a frequency-sorted list of all tab
directories. Pure function, no Redux dependency."
```

---

### Task 2: Create `rankCandidateDirectories` utility

A pure function that takes the raw candidate list from the API, the tab directories, and the previous global default, and returns a re-ranked list where tab directories and the global default are boosted to the top.

**Files:**
- Modify: `src/lib/tab-directory-preference.ts` (add the function)
- Modify: `test/unit/client/lib/tab-directory-preference.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to the existing test file:

```typescript
import { getTabDirectoryPreference, rankCandidateDirectories } from '@/lib/tab-directory-preference'

// ... existing tests ...

describe('rankCandidateDirectories', () => {
  it('boosts tab directories and global default above other candidates', () => {
    const candidates = ['/code/gamma', '/code/alpha', '/code/beta', '/code/delta']
    const tabDirectories = ['/code/alpha', '/code/beta']
    const globalDefault = '/code/gamma'

    const result = rankCandidateDirectories(candidates, tabDirectories, globalDefault)

    // Tab dirs first (in tab frequency order), then global default, then rest
    expect(result).toEqual([
      '/code/alpha',
      '/code/beta',
      '/code/gamma',
      '/code/delta',
    ])
  })

  it('deduplicates when global default is also a tab directory', () => {
    const candidates = ['/code/alpha', '/code/beta', '/code/gamma']
    const tabDirectories = ['/code/alpha']
    const globalDefault = '/code/alpha'

    const result = rankCandidateDirectories(candidates, tabDirectories, globalDefault)

    expect(result).toEqual(['/code/alpha', '/code/beta', '/code/gamma'])
  })

  it('preserves original order for non-boosted candidates', () => {
    const candidates = ['/z/last', '/a/first', '/m/middle']
    const tabDirectories: string[] = []
    const globalDefault = undefined

    const result = rankCandidateDirectories(candidates, tabDirectories, globalDefault)

    expect(result).toEqual(['/z/last', '/a/first', '/m/middle'])
  })

  it('includes global default even if not in candidate list', () => {
    const candidates = ['/code/alpha']
    const tabDirectories: string[] = []
    const globalDefault = '/code/beta'

    const result = rankCandidateDirectories(candidates, tabDirectories, globalDefault)

    expect(result).toEqual(['/code/beta', '/code/alpha'])
  })

  it('includes tab directories even if not in candidate list', () => {
    const candidates = ['/code/gamma']
    const tabDirectories = ['/code/alpha']
    const globalDefault = undefined

    const result = rankCandidateDirectories(candidates, tabDirectories, globalDefault)

    expect(result).toEqual(['/code/alpha', '/code/gamma'])
  })

  it('handles empty candidates gracefully', () => {
    const result = rankCandidateDirectories([], ['/code/alpha'], '/code/beta')
    expect(result).toEqual(['/code/alpha', '/code/beta'])
  })

  it('handles everything empty', () => {
    const result = rankCandidateDirectories([], [], undefined)
    expect(result).toEqual([])
  })
})
```

**Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/unit/client/lib/tab-directory-preference.test.ts`
Expected: New `rankCandidateDirectories` tests FAIL (function not exported)

**Step 3: Write minimal implementation**

Add to `src/lib/tab-directory-preference.ts`:

```typescript
/**
 * Re-rank a candidate directory list by boosting tab directories and the
 * global provider default above the general candidates.
 *
 * Order: tab directories (in frequency order) → global default → rest (original order preserved).
 * All entries are deduplicated.
 */
export function rankCandidateDirectories(
  candidates: string[],
  tabDirectories: string[],
  globalDefault: string | undefined,
): string[] {
  const result: string[] = []
  const seen = new Set<string>()

  // 1. Tab directories first (already sorted by frequency)
  for (const dir of tabDirectories) {
    if (!seen.has(dir)) {
      seen.add(dir)
      result.push(dir)
    }
  }

  // 2. Global default next
  if (globalDefault && !seen.has(globalDefault)) {
    seen.add(globalDefault)
    result.push(globalDefault)
  }

  // 3. Remaining candidates in original order
  for (const dir of candidates) {
    if (!seen.has(dir)) {
      seen.add(dir)
      result.push(dir)
    }
  }

  return result
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/client/lib/tab-directory-preference.test.ts`
Expected: PASS (all 15 tests)

**Step 5: Commit**

```bash
git add src/lib/tab-directory-preference.ts test/unit/client/lib/tab-directory-preference.test.ts
git commit -m "feat: add rankCandidateDirectories for boosting tab/global dirs

Re-ranks the candidate directory list by placing tab directories
(frequency-ordered) and the global provider default above the general
candidates. Deduplicates and preserves original order for the rest."
```

---

### Task 3: Wire `PickerWrapper` to use tab-aware defaults

Modify `PickerWrapper` in `PaneContainer.tsx` to read the pane tree for the current tab, compute the tab preference, and pass both `defaultCwd` and `tabDirectories` through to `DirectoryPicker`.

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx` (PickerWrapper function, ~lines 387-541)
- Modify: `src/components/panes/DirectoryPicker.tsx` (accept new props, re-rank candidates)
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx` (add wiring test)

**Step 1: Write the failing wiring test**

Add a new `describe` block to the **existing** `test/unit/client/components/panes/PaneContainer.test.tsx`. This test verifies that when a picker pane opens in a tab that already has Claude panes with `initialCwd`, the directory picker pre-fills with the tab-preferred directory instead of the global provider default.

Add this test at the end of the existing `PickerWrapper shell type handling` describe block, using the existing `createStoreWithClaude` helper and mock setup:

```typescript
    it('pre-fills directory picker with tab-preferred cwd instead of global default', () => {
      // Tab already has a Claude pane working in /code/tab-project
      const existingClaude: PaneNode = {
        type: 'leaf',
        id: 'pane-existing',
        content: {
          kind: 'terminal',
          mode: 'claude',
          shell: 'system',
          createRequestId: 'cr-existing',
          status: 'running',
          terminalId: 'term-existing',
          initialCwd: '/code/tab-project',
        },
      }
      const pickerNode: PaneNode = {
        type: 'leaf',
        id: 'pane-1',
        content: { kind: 'picker' },
      }
      const splitNode: PaneNode = {
        type: 'split',
        id: 'split-1',
        direction: 'horizontal',
        sizes: [50, 50],
        children: [existingClaude, pickerNode],
      }

      // Global provider default is /code/global-default — should NOT be used
      const store = createStoreWithClaude(splitNode, { cwd: '/code/global-default' })

      renderWithStore(
        <PaneContainer tabId="tab-1" node={splitNode} />,
        store
      )

      // Navigate to directory picker by selecting Claude
      const container = document.querySelector('[data-context="pane-picker"]')!
      fireEvent.keyDown(container, { key: 'l' })
      fireEvent.transitionEnd(container)

      // The input should pre-fill with the tab's directory, not the global default
      const input = screen.getByLabelText('Starting directory for Claude') as HTMLInputElement
      expect(input.value).toBe('/code/tab-project')
    })
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/panes/PaneContainer.test.tsx -t "pre-fills directory picker"`
Expected: FAIL — input will show `/code/global-default` (current behavior) instead of `/code/tab-project`

**Step 3: Update `DirectoryPicker` props**

In `src/components/panes/DirectoryPicker.tsx`, add two new optional props:

```typescript
type DirectoryPickerProps = {
  providerType: CodingCliProviderName | 'claude-web'
  providerLabel: string
  defaultCwd?: string
  tabDirectories?: string[]
  globalDefault?: string
  onConfirm: (cwd: string) => void
  onBack: () => void
}
```

**Step 4: Update `DirectoryPicker` to re-rank candidates**

In the `useEffect` that fetches `/api/files/candidate-dirs` (~line 69-84), after merging candidates, apply `rankCandidateDirectories`:

```typescript
import { rankCandidateDirectories } from '@/lib/tab-directory-preference'

// In the useEffect:
.then((result) => {
  if (cancelled) return
  const raw = dedupeDirectories([...(result.directories || []), defaultCwd || ''])
  const ranked = rankCandidateDirectories(raw, tabDirectories ?? [], globalDefault)
  setCandidates(ranked)
})
.catch(() => {
  if (cancelled) return
  const fallback = dedupeDirectories([defaultCwd || ''])
  const ranked = rankCandidateDirectories(fallback, tabDirectories ?? [], globalDefault)
  setCandidates(ranked)
})
```

Also update the dependency array of this `useEffect` to include `tabDirectories` and `globalDefault`.

**Step 5: Update `PickerWrapper` to compute and pass tab preference**

In `PaneContainer.tsx`, add the import and selector:

```typescript
import { getTabDirectoryPreference } from '@/lib/tab-directory-preference'

// Inside PickerWrapper:
const paneLayout = useAppSelector((s) => s.panes.layouts[tabId])
const tabPref = useMemo(
  () => paneLayout ? getTabDirectoryPreference(paneLayout) : { defaultCwd: undefined, tabDirectories: [] },
  [paneLayout],
)
```

Then in the directory step rendering (~line 516-529), change:

```typescript
if (step.step === 'directory') {
  const providerType = step.providerType
  const providerLabel = providerType === 'claude-web' ? 'Claude Web' : getProviderLabel(providerType)
  const settingsKey = providerType === 'claude-web' ? 'claude' : providerType
  const globalDefault = settings?.codingCli?.providers?.[settingsKey]?.cwd
  const defaultCwd = tabPref.defaultCwd ?? globalDefault
  return (
    <DirectoryPicker
      providerType={providerType}
      providerLabel={providerLabel}
      defaultCwd={defaultCwd}
      tabDirectories={tabPref.tabDirectories}
      globalDefault={globalDefault}
      onConfirm={handleDirectoryConfirm}
      onBack={() => setStep({ step: 'type' })}
    />
  )
}
```

**Step 6: Run tests to verify the wiring test passes and nothing broke**

Run: `npx vitest run test/unit/client/components/panes/PaneContainer.test.tsx -t "pre-fills directory picker"`
Expected: PASS — input now shows `/code/tab-project`

Then: `npm test`
Expected: PASS — all existing tests still pass. The new props are optional, so no existing call sites break.

**Step 7: Commit**

```bash
git add src/components/panes/PaneContainer.tsx src/components/panes/DirectoryPicker.tsx test/unit/client/components/panes/PaneContainer.test.tsx
git commit -m "feat: wire tab-aware directory preference into PickerWrapper

PickerWrapper now computes the tab's directory preference from the pane
tree and passes it to DirectoryPicker. The default pre-fills with the
most-used directory in the tab (falling back to global provider default).
DirectoryPicker re-ranks its candidate list to boost tab directories and
the global default above general candidates."
```

---

### Task 4: Add DirectoryPicker re-ranking tests

Test that `DirectoryPicker` correctly re-ranks candidates when `tabDirectories` and `globalDefault` are provided.

**Files:**
- Modify: `test/unit/client/components/panes/DirectoryPicker.test.tsx` (add tests to existing file)

**Step 1: Write the tests**

Add a new `describe` block to the **existing** `test/unit/client/components/panes/DirectoryPicker.test.tsx`. The file already has `mockApiGet`/`mockApiPost` hoisted mocks and a `renderDirectoryPicker` helper. Add the new tests inside the existing top-level `describe('DirectoryPicker', ...)` block:

```typescript
  describe('tab-aware candidate re-ranking', () => {
    it('renders candidates from API in original order without tab context', async () => {
      mockApiGet.mockResolvedValueOnce({
        directories: ['/code/gamma', '/code/alpha', '/code/beta'],
      })

      renderDirectoryPicker({ defaultCwd: '' })

      await waitFor(() => {
        expect(screen.getByRole('listbox')).toBeInTheDocument()
      })

      const options = screen.getAllByRole('option')
      expect(options.map(o => o.textContent)).toEqual([
        '/code/gamma',
        '/code/alpha',
        '/code/beta',
      ])
    })

    it('boosts tab directories and global default above API candidates', async () => {
      mockApiGet.mockResolvedValueOnce({
        directories: ['/code/gamma', '/code/alpha', '/code/beta', '/code/delta'],
      })

      renderDirectoryPicker({
        defaultCwd: '',
        tabDirectories: ['/code/beta', '/code/alpha'],
        globalDefault: '/code/delta',
      })

      await waitFor(() => {
        const options = screen.getAllByRole('option')
        expect(options.length).toBeGreaterThanOrEqual(4)
      })

      const options = screen.getAllByRole('option')
      // Tab dirs first (in provided order), then global default, then rest
      expect(options.map(o => o.textContent)).toEqual([
        '/code/beta',
        '/code/alpha',
        '/code/delta',
        '/code/gamma',
      ])
    })

    it('pre-fills input with tab-preferred defaultCwd', () => {
      mockApiGet.mockResolvedValueOnce({ directories: [] })

      renderDirectoryPicker({ defaultCwd: '/code/tab-preferred' })

      const input = screen.getByRole('combobox')
      expect(input).toHaveValue('/code/tab-preferred')
    })
  })
```

**Step 2: Run tests to verify they pass**

Run: `npx vitest run test/unit/client/components/panes/DirectoryPicker.test.tsx`
Expected: PASS — all existing + new tests pass (Task 3's implementation is already in place).

**Step 3: Commit**

```bash
git add test/unit/client/components/panes/DirectoryPicker.test.tsx
git commit -m "test: add DirectoryPicker tests for tab-aware candidate re-ranking

Verify that tab directories and global default are boosted above
general API candidates, and that the input pre-fills with the
tab-preferred default."
```

---

### Task 5: Run full verification and refactor

**Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass including new ones.

**Step 2: Run build verification**

Run: `npm run verify`
Expected: Build + tests pass (catches any type errors vitest might miss).

**Step 3: Review and refactor**

Check for:
- Any duplication between `dedupeDirectories` in DirectoryPicker and `rankCandidateDirectories` — they serve different purposes (dedup vs. rank+dedup), so both should remain
- The `useEffect` dependency array in DirectoryPicker is correct (includes `tabDirectories`, `globalDefault`)
- `useMemo` for `tabPref` in PickerWrapper is correct (depends on `paneLayout`)
- No unnecessary re-renders from new props (tabDirectories is a new array each render — consider memoizing in PickerWrapper if needed)

If `tabDirectories` causes unnecessary re-renders because it's a new array reference each time `useMemo` recomputes, add a shallow-compare memo or serialize to a stable reference. This is likely fine since the pane layout doesn't change frequently.

**Step 4: Commit any refactoring**

```bash
git add -A
git commit -m "refactor: stabilize tab directory preference memoization"
```

(Only if changes were needed.)

**Step 5: Final commit / tag**

Run: `npm test` one final time to confirm everything passes.
