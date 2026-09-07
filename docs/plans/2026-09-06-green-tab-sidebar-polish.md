# Green Tab & Sidebar Polish Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Improve dark-mode visibility of the green tab highlight; add repo icons to the left-hand panel matching the pane header's repo icon treatment; add green fill and highlight-line treatments to the left-hand panel. Apply thoughtful design judgment so all three changes look good in both light and dark mode.

### Explicit constraints
- Must look good in both light and dark mode
- Repo icons in the left-hand panel must match the pane header's repo icon treatment

### Accepted tradeoffs and residuals
- None stated.

**Goal:** Make the green needs-attention tab highlight clearly visible in dark mode, add repo icons to sidebar session rows (matching the pane header), and apply green fill + left-border highlight-line treatments to sidebar rows for open sessions — all with coherent light/dark theming.

**Architecture:** Three focused changes to the existing component tree. (1) Bump the dark-mode opacity of the `bg-success/15` fill on the active+attention tab in `TabItem.tsx` — the root cause is that `--success` is identical in both themes, so a 15% green wash over near-black is near-invisible. (2) Reuse the existing `RepoIcon` component + `repoIcons` Redux slice + `fetchRepoIconMeta` thunk (already plumbed in TabBar and PaneHeader) to render repo icons in `SidebarItem`, gated by the same `repoIconsOnTabs` setting. (3) Extend the `SidebarItem` button className to apply green fill (`emerald-*` with `dark:` overrides, matching the pane header idiom) + `border-l-2` left highlight line for open sessions, and blue fill + blue left line for busy sessions, replacing the flat `bg-muted` active treatment.

**Tech Stack:** React 18, Redux Toolkit, Tailwind CSS (CSS-variable theme tokens + raw `emerald-*`/`blue-*` with `dark:` overrides), Vitest + Testing Library.

## Global Constraints

- Server uses NodeNext/ESM; relative imports must include `.js` extensions (does not affect `@/` alias imports).
- TDD: write failing test first, confirm it fails for the right reason, implement, confirm pass, refactor.
- Do not reduce test coverage or skip tests.
- The `--success` CSS token is `142 71% 45%` in both light and dark mode (`src/theme-variables.css:20,62`) — this is the root cause of the dark-mode visibility issue and must not be changed globally (it ripples to the deck, HostStats, OverviewView, etc.).
- The pane header's repo-icon treatment to match is `<RepoIcon info={repoIconInfo} className="h-3.5 w-3.5 shrink-0" />` rendered before the pane-type icon (`src/components/panes/PaneHeader.tsx:180`).
- The pane header's green treatment to match is `bg-emerald-50 border-l-2 border-l-emerald-500 dark:bg-emerald-900/30` (`src/components/panes/PaneHeader.tsx:169`).
- The `repoIconsOnTabs` setting defaults to `true` (`shared/settings.ts:906`).
- Focused test runs: `npm run test:vitest -- run <path>` (vitest auto-discovers `config/vitest/vitest.config.ts`).
- Full-suite gate: `npm test` (coordinated).
- `docs/index.html` is a nonfunctional mock; significant UI changes should be reflected there.

---

### Task 1: Fix dark-mode green tab highlight visibility

**Files:**
- Modify: `src/components/TabItem.tsx:168`
- Test: `test/unit/client/components/TabItem.test.tsx`

**Interfaces:**
- Consumes: `--success` CSS token (unchanged), `tabAttentionStyle` prop (unchanged)
- Produces: no new interfaces; adds a `dark:bg-success/25` class to the active+attention+highlight path

**Context:** The active+attention tab (line 168) uses `bg-success/15` — a 15% green wash. In dark mode, `--success` is `142 71% 45%` (same as light), so 15% green over near-black `--background` (`240 10% 4%`, approx `#0a0a0b`) renders as a near-invisible dark forest green. The 3px `border-t-success` line is visible, but the fill is not. The inactive+attention path (line 178) already has `dark:bg-emerald-900/40` and reads fine. The fix: add `dark:bg-success/25` to bump the fill opacity to 25% in dark mode only.

- [ ] **Step 1: Write the failing behavioral test**

Add this test to `test/unit/client/components/TabItem.test.tsx`, after the existing `applies attention classes on active tab with highlight` test (around line 144):

```typescript
  it('bumps green fill opacity in dark mode for active attention tab with highlight', () => {
    render(<TabItem {...defaultProps} isActive={true} needsAttention={true} tabAttentionStyle="highlight" />)
    const el = getTabElement()
    expect(el?.className).toContain('bg-success/15')
    expect(el?.className).toContain('dark:bg-success/25')
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/TabItem.test.tsx`

Expected: FAIL because `dark:bg-success/25` is not present in the className — the current code only has `bg-success/15` with no dark-mode override.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/TabItem.tsx`, line 168, change:

```typescript
                  : 'border-t-[3px] border-t-success bg-success/15 shadow-[inset_0_4px_8px_hsl(var(--success)/0.2)]'
```

to:

```typescript
                  : 'border-t-[3px] border-t-success bg-success/15 dark:bg-success/25 shadow-[inset_0_4px_8px_hsl(var(--success)/0.2)]'
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/TabItem.test.tsx`

Expected: PASS — all existing tests plus the new dark-mode opacity test pass.

- [ ] **Step 5: Refactor while green**

No refactor needed — a single Tailwind class addition.

- [ ] **Step 6: Run impacted-test verification**

The change is scoped to `TabItem.tsx` line 168 (active+attention+highlight path). Impacted tests: `TabItem.test.tsx` (all), `TabBar.test.tsx` (integration with TabItem). The deck tests (`tile-state.test.ts`, `deck-selectors.test.ts`) classify tab state but do not assert CSS classes on the TabItem component, so they are not impacted.

Run: `npm run test:vitest -- run test/unit/client/components/TabItem.test.tsx test/unit/client/components/TabBar.test.tsx`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/components/TabItem.tsx test/unit/client/components/TabItem.test.tsx
git commit -m "fix(ui): bump dark-mode green tab fill opacity from 15% to 25%

The --success CSS token is identical in light and dark mode, so
bg-success/15 was near-invisible over the near-black dark background.
Add dark:bg-success/25 to make the green fill clearly visible in dark
mode while keeping the light-mode fill subtle."
```

---

### Task 2: Add repo icons to sidebar session rows

**Files:**
- Modify: `src/components/Sidebar.tsx` (imports, `Sidebar` component body, `SidebarItem` component, `SidebarItemProps`, `areSidebarItemPropsEqual`)
- Test: `test/unit/client/components/Sidebar.test.tsx` (add `repoIcons` reducer to `createTestStore`, add repo-icon tests)
- Test: `test/unit/client/components/SidebarItem.running-state.test.tsx` (no change needed — `repoIconInfo` is optional)

**Interfaces:**
- Consumes: `RepoIcon` component (`src/components/icons/RepoIcon.tsx`), `RepoIconInfo` type, `fetchRepoIconMeta` thunk (`src/store/repoIconsSlice.ts`), `pathBasename`/`buildRepoIconUrl` (`src/lib/repo-icon.ts`), `repoIconsOnTabs` setting
- Produces: `SidebarItem` gains optional `repoIconInfo?: RepoIconInfo` prop; `areSidebarItemPropsEqual` compares it by value (`repoKey` + `iconUrl`)

**Context:** The `SidebarItem` (`Sidebar.tsx:1038-1124`) currently renders only a `SessionIcon` (provider icon). The `SidebarSessionItem` already carries `cwd`, `repoPath`, and `projectPath` (`sidebarSelectors.ts:37,41,30`). The `RepoIcon` component and `repoIcons` Redux slice are already used by TabBar (`TabBar.tsx:265-293`) and PaneHeader (`PaneHeader.tsx:123-127,179-181`). The sidebar needs to: (1) select `repoIcons.byCwd` from state, (2) build a `repoIconInfoByCwd` map (same as TabBar), (3) probe meta for each visible item's cwd in a `useEffect`, (4) pass `repoIconInfo` to each `SidebarItem`, (5) render `<RepoIcon>` before the `SessionIcon`.

- [ ] **Step 1: Write the failing behavioral test**

**1a. Add a `RepoIcon` mock** at the top of `test/unit/client/components/Sidebar.test.tsx` (after the existing `vi.mock` blocks, around line 69):

```typescript
vi.mock('@/components/icons/RepoIcon', () => ({
  default: ({ info, className }: any) => (
    <span data-testid="repo-icon" data-repo-key={info?.repoKey} data-class={className} />
  ),
}))
```

This matches the pattern used in `test/unit/client/components/panes/PaneHeader.test.tsx` and keeps the test decoupled from the real `RepoIcon` SVG/img rendering. Capturing `className` lets the test verify the icon matches the pane header's `h-3.5 w-3.5 shrink-0` sizing.

**1b. Add the `repoIcons` reducer and a `panesSettings` option to `createTestStore`.**

In the imports section (after line 22), add:

```typescript
import repoIconsReducer from '@/store/repoIconsSlice'
```

Add `repoIcons` and `panesSettings` to the `createTestStore` options type (after line 116, `freshAgentSessions?: ...`):

```typescript
  repoIcons?: Record<string, any>
  panesSettings?: Partial<(typeof defaultSettings)['panes']>
```

In the `reducer` object inside `createTestStore` (after line 162, `freshAgent: freshAgentReducer,`), add:

```typescript
      repoIcons: repoIconsReducer,
```

In the `preloadedState.settings.settings.panes` block (around line 182), add the spread:

```typescript
          panes: {
            ...defaultSettings.panes,
            sessionOpenMode: options?.sessionOpenMode ?? defaultSettings.panes.sessionOpenMode,
            ...options?.panesSettings,
          },
```

In the `preloadedState` object (after the `freshAgent` block ending at line 249), add:

```typescript
      repoIcons: {
        byCwd: options?.repoIcons ?? {},
      },
```

**1c. Add tests** at the end of the file (before the final closing `})`):

```typescript
  describe('Sidebar repo icons', () => {
    it('renders a repo icon for a session with resolved repo icon meta', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/myproject',
          sessions: [
            {
              sessionId: sessionId('repo-icon-session'),
              projectPath: '/home/user/myproject',
              lastActivityAt: Date.now(),
              title: 'Repo icon session',
              cwd: '/home/user/myproject',
            },
          ],
        },
      ]

      const store = createTestStore({
        projects,
        repoIcons: {
          '/home/user/myproject': {
            status: 'ready',
            repoRoot: '/home/user/myproject',
            repoName: 'myproject',
            hasIcon: false,
          },
        },
      })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const button = screen.getByRole('button', { name: /repo icon session/i })
      const repoIcon = button.querySelector('[data-testid="repo-icon"]')
      expect(repoIcon).toBeTruthy()
      expect(repoIcon).toHaveAttribute('data-repo-key', '/home/user/myproject')
      // Verify the icon matches the pane header treatment: h-3.5 w-3.5 shrink-0
      expect(repoIcon).toHaveAttribute('data-class')
      expect(repoIcon?.getAttribute('data-class')).toContain('h-3.5')
      expect(repoIcon?.getAttribute('data-class')).toContain('w-3.5')
      // Verify placement: repo icon comes before the provider icon (first SVG) in DOM order
      const providerIcon = button.querySelector('svg')
      expect(repoIcon).toBeTruthy()
      expect(providerIcon).toBeTruthy()
      if (repoIcon && providerIcon) {
        expect(repoIcon.compareDocumentPosition(providerIcon) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      }
    })

    it('does not render a repo icon when repoIconsOnTabs is off', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/myproject',
          sessions: [
            {
              sessionId: sessionId('no-repo-icon-session'),
              projectPath: '/home/user/myproject',
              lastActivityAt: Date.now(),
              title: 'No repo icon session',
              cwd: '/home/user/myproject',
            },
          ],
        },
      ]

      const store = createTestStore({
        projects,
        repoIcons: {
          '/home/user/myproject': {
            status: 'ready',
            repoRoot: '/home/user/myproject',
            repoName: 'myproject',
            hasIcon: false,
          },
        },
        panesSettings: { repoIconsOnTabs: false },
      })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      const button = screen.getByRole('button', { name: /no repo icon session/i })
      expect(button.querySelector('[data-testid="repo-icon"]')).toBeNull()
    })

    it('dispatches fetchRepoIconMeta for sessions when repoIcons state is empty', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/myproject',
          sessions: [
            {
              sessionId: sessionId('probe-session'),
              projectPath: '/home/user/myproject',
              lastActivityAt: Date.now(),
              title: 'Probe session',
              cwd: '/home/user/myproject',
            },
          ],
        },
      ]

      const store = createTestStore({ projects, repoIcons: {} })
      renderSidebar(store, [])

      await act(async () => {
        vi.advanceTimersByTime(100)
      })

      // The probe effect dispatched the thunk, whose pending reducer set the
      // entry to { status: 'loading' }. Verifying state (not dispatch spy)
      // because Redux Toolkit's thunk middleware does not route internal
      // pending actions through the replaced store.dispatch property.
      expect(store.getState().repoIcons.byCwd['/home/user/myproject']).toEqual(
        expect.objectContaining({ status: 'loading' }),
      )
    })
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx -t "Sidebar repo icons"`

Expected: FAIL because `SidebarItem` does not yet render a `RepoIcon` — the mock `data-testid="repo-icon"` will not be found inside the button.

- [ ] **Step 3: Add the minimal production implementation**

**3a. Add imports to `src/components/Sidebar.tsx`** (after the existing imports, around line 36):

```typescript
import RepoIcon, { type RepoIconInfo } from '@/components/icons/RepoIcon'
import { fetchRepoIconMeta } from '@/store/repoIconsSlice'
import { pathBasename, buildRepoIconUrl } from '@/lib/repo-icon'
```

**3b. Add `repoIconInfo` to `SidebarItemProps`** (around line 1001):

Add after `showProjectBadge?: boolean`:

```typescript
  /** Repo icon info for this session's repo; absent when repoIconsOnTabs is off or no cwd. */
  repoIconInfo?: RepoIconInfo
```

**3c. Update `areSidebarItemPropsEqual`** (around line 1016):

Add after the `timestampTick` comparison:

```typescript
  if (prev.repoIconInfo?.repoKey !== next.repoIconInfo?.repoKey) return false
  if (prev.repoIconInfo?.repoName !== next.repoIconInfo?.repoName) return false
  if (prev.repoIconInfo?.iconUrl !== next.repoIconInfo?.iconUrl) return false
```

Also add `repoPath` to both `areSidebarItemPropsEqual` and `isSessionItemEqual` — the `item.repoPath` field is now load-bearing for repo-icon lookup but is not currently compared by either function:

In `areSidebarItemPropsEqual` (around line 1031, after `a.cwd === b.cwd &&`):
```typescript
    a.repoPath === b.repoPath &&
```

In `isSessionItemEqual` (around line 155, after `a.cwd === b.cwd &&`):
```typescript
    a.repoPath === b.repoPath &&
```

**3d. Add `repoIcons` plumbing to the `Sidebar` component.** In the `Sidebar` function body (after the existing `useAppSelector` calls, around line 230), add:

```typescript
  const repoIconsOnTabs = useAppSelector((s) => s.settings.settings.panes?.repoIconsOnTabs ?? true)
  const repoIconsByCwd = useAppSelector((s) => s.repoIcons?.byCwd ?? {})
```

Add the `repoIconInfoByCwd` memo (after the `selectSortedItems` memo, around line 227):

```typescript
  const repoIconInfoByCwd = useMemo(() => {
    if (!repoIconsOnTabs) return {}
    const out: Record<string, RepoIconInfo> = {}
    for (const [cwd, entry] of Object.entries(repoIconsByCwd)) {
      if (entry.status === 'loading') continue
      const repoKey = entry.repoRoot || cwd
      out[cwd] = {
        repoKey,
        repoName: entry.repoName || pathBasename(repoKey),
        iconUrl: entry.hasIcon ? buildRepoIconUrl(cwd) : undefined,
      }
    }
    return out
  }, [repoIconsOnTabs, repoIconsByCwd])
```

Add the probe `useEffect` (after `sortedItems` is declared at line 374 and `busySessionKeySet` at line 385 — placing it before `sortedItems` would hit the temporal dead zone):

```typescript
  useEffect(() => {
    if (!repoIconsOnTabs) return
    const cwds = new Set<string>()
    for (const item of sortedItems) {
      const cwd = item.repoPath ?? item.cwd
      if (cwd) cwds.add(cwd)
    }
    for (const cwd of cwds) {
      if (!repoIconsByCwd[cwd]) void dispatch(fetchRepoIconMeta(cwd))
    }
  }, [sortedItems, repoIconsOnTabs, repoIconsByCwd, dispatch])
```

Note: `sortedItems` is derived from `useStableArray` and the `selectSortedItems` selector — it's the same array used to render the session list. The fallback chain is `item.repoPath ?? item.cwd` (preferring the canonical repo root over the session's working directory, matching the pane header's repo-root-first priority).

**3e. Pass `repoIconInfo` to each `SidebarItem`** in the render loop (around line 946):

After the `item={item}` prop, add:

```typescript
                        repoIconInfo={
                          repoIconInfoByCwd[item.repoPath ?? item.cwd ?? '']
                        }
```

**3f. Render `RepoIcon` in `SidebarItem`.** In the `SidebarItem` component (around line 1062), the current provider icon section is:

```jsx
          {/* Provider icon */}
          <div className="flex-shrink-0">
```

Change the destructure on line 1039 to include `repoIconInfo`:

```typescript
  const { item, isActiveTab, isBusy = false, remoteStatus, showProjectBadge, repoIconInfo, onClick } = props
```

Add the `RepoIcon` before the `SessionIcon` wrapper:

```jsx
          {/* Repo icon + provider icon */}
          <div className="flex-shrink-0 flex items-center gap-1">
            {repoIconInfo && (
              <RepoIcon info={repoIconInfo} className="h-3.5 w-3.5 shrink-0" />
            )}
            <div className="relative">
```

And close the outer `div` after the existing `</div>` that closes the `relative` div (around line 1082):

```jsx
            </div>
          </div>
```

(The existing `</div>` that closes `flex-shrink-0` becomes the closer for the new combined wrapper. Adjust indentation so the `relative` div and the `remoteStatus` ring are inside the new combined wrapper.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx -t "Sidebar repo icons"`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Review the `repoIconInfoByCwd` memo and probe effect — they mirror TabBar's implementation (`TabBar.tsx:265-293`). If the duplication is significant enough to warrant a shared utility, extract one; otherwise leave as-is since both consumers are small. The duplication is a 10-line memo + a 10-line effect, which is acceptable for two consumers. No refactor needed.

- [ ] **Step 6: Run impacted-test verification**

Impacted tests: all `Sidebar*` tests (the `SidebarItem` component changed), `SidebarItem.running-state.test.tsx`, `SidebarItem.remote-status.test.tsx`, `Sidebar.render-stability.test.tsx` (the comparator changed). The `SidebarItem` tests that create their own store don't include `repoIcons` — but `repoIconInfo` is optional and defaults to undefined, so no repo icon renders and existing assertions are unaffected.

Run: `npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/SidebarItem.running-state.test.tsx test/unit/client/components/SidebarItem.remote-status.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/Sidebar.dom-stability.test.tsx`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx
git commit -m "feat(ui): add repo icons to sidebar session rows

Reuse the existing RepoIcon component and repoIcons Redux slice (already
plumbed in TabBar and PaneHeader) to render repo identity icons in the
sidebar. Gated by the same repoIconsOnTabs setting. The icon appears before
the provider icon, matching the pane header layout."
```

---

### Task 3: Add green fill and highlight-line treatments to sidebar rows

**Files:**
- Modify: `src/components/Sidebar.tsx` (`SidebarItem` button className, lines 1047-1052)
- Modify: `docs/index.html` (sidebar mock styling)
- Test: `test/unit/client/components/Sidebar.test.tsx` (add treatment tests, update existing `bg-muted` assertions)
- Test: `test/unit/client/components/SidebarItem.running-state.test.tsx` (update if needed)

**Interfaces:**
- Consumes: `item.hasTab`, `isBusy`, `isActiveTab` (all already on `SidebarItemProps`)
- Produces: no new interfaces; button className changes

**Context:** The `SidebarItem` button currently uses a flat `bg-muted` for active and `hover:bg-muted/50` for inactive, regardless of session status. The tab bar and pane header already use green fill + colored border-line treatments for needs-attention/open states. The sidebar should adopt the same vocabulary: green = open (hasTab, not busy), blue = busy, muted = closed. The left-border idiom (`border-l-2`) matches the pane header (`PaneHeader.tsx:169`) and TabsView (`TabsView.tsx:162`).

**Design (all six states):**

| State | Fill (light) | Fill (dark) | Left border |
|---|---|---|---|
| Active + busy | `bg-blue-100` | `dark:bg-blue-900/40` | `border-l-blue-500` |
| Active + open | `bg-emerald-100` | `dark:bg-emerald-900/40` | `border-l-emerald-500` |
| Active + closed | `bg-muted` | (same) | (none) |
| Inactive + busy | `bg-blue-50` | `dark:bg-blue-900/20` | `border-l-blue-500/70` |
| Inactive + open | `bg-emerald-50` | `dark:bg-emerald-900/20` | `border-l-emerald-500/70` |
| Inactive + closed | (none) | (same) | (none) |

All states include the base `border-l-2` width to keep content alignment stable (closed rows use `border-l-transparent`).

- [ ] **Step 1: Write the failing behavioral test**

Add these tests to `test/unit/client/components/Sidebar.test.tsx`, inside the `describe('Sidebar highlight logic ...')` block or a new `describe('Sidebar row green/blue treatments')` block:

```typescript
  describe('Sidebar row green/blue treatments', () => {
    it('applies green fill and left border for an active open session', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('active-open'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Active open session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]
      const tabs = [{ id: 'tab-1', resumeSessionId: sessionId('active-open'), mode: 'claude' }]
      const store = createTestStore({ projects, tabs, activeTabId: 'tab-1' })
      renderSidebar(store, [])

      await act(async () => { vi.advanceTimersByTime(100) })

      const button = screen.getByRole('button', { name: /active open session/i })
      expect(button).toHaveClass('bg-emerald-100')
      expect(button).toHaveClass('border-l-2')
      expect(button).toHaveClass('border-l-emerald-500')
      expect(button).toHaveClass('dark:bg-emerald-900/40')
      expect(button).not.toHaveClass('bg-muted')
    })

    it('applies blue fill and left border for an active busy session', async () => {
      const now = Date.now()
      const terminalId = 'term-busy-1'
      const busySid = sessionId('active-busy')
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: busySid,
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'Active busy session',
              cwd: '/home/user/project',
              provider: 'codex',
            },
          ],
        },
      ]
      const tabs = [{ id: 'tab-1', terminalId, resumeSessionId: busySid, mode: 'codex' }]
      const terminals: BackgroundTerminal[] = [
        {
          terminalId, title: 'Codex', createdAt: now, status: 'running', hasClients: true,
          mode: 'codex', sessionRef: { provider: 'codex', sessionId: busySid },
        },
      ]
      const store = createTestStore({
        projects, tabs, terminals, activeTabId: 'tab-1',
        codexActivity: { byTerminalId: { [terminalId]: { terminalId, sessionId: 's1', phase: 'busy', lastActivityAt: 10 } } },
      })
      renderSidebar(store, terminals)

      await act(async () => { vi.advanceTimersByTime(100) })

      const button = screen.getByRole('button', { name: /active busy session/i })
      expect(button).toHaveClass('bg-blue-100')
      expect(button).toHaveClass('border-l-2')
      expect(button).toHaveClass('border-l-blue-500')
      expect(button).toHaveClass('dark:bg-blue-900/40')
    })

    it('applies transparent border and no color treatment for an inactive closed session', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('inactive-closed'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Inactive closed session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]
      const store = createTestStore({ projects })
      renderSidebar(store, [])

      await act(async () => { vi.advanceTimersByTime(100) })

      const button = screen.getByRole('button', { name: /inactive closed session/i })
      expect(button).not.toHaveClass('bg-muted')
      expect(button).not.toHaveClass('border-l-emerald-500')
      expect(button).not.toHaveClass('border-l-blue-500')
      expect(button).toHaveClass('border-l-transparent')
    })

    it('applies light green fill for an inactive open session', async () => {
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: sessionId('inactive-open'),
              projectPath: '/home/user/project',
              lastActivityAt: Date.now(),
              title: 'Inactive open session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]
      const tabs = [{ id: 'tab-1', resumeSessionId: sessionId('inactive-open'), mode: 'claude' }]
      const store = createTestStore({ projects, tabs })
      renderSidebar(store, [])

      await act(async () => { vi.advanceTimersByTime(100) })

      const button = screen.getByRole('button', { name: /inactive open session/i })
      expect(button).toHaveClass('bg-emerald-50')
      expect(button).toHaveClass('border-l-2')
      expect(button).toHaveClass('border-l-emerald-500/70')
      expect(button).toHaveClass('dark:bg-emerald-900/20')
    })

    it('applies light blue fill and left border for an inactive busy session', async () => {
      const now = Date.now()
      const terminalId = 'term-inactive-busy'
      const busySid = sessionId('inactive-busy')
      const projects: ProjectGroup[] = [
        {
          projectPath: '/home/user/project',
          sessions: [
            {
              sessionId: busySid,
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'Inactive busy session',
              cwd: '/home/user/project',
              provider: 'codex',
            },
            {
              sessionId: sessionId('other-session'),
              projectPath: '/home/user/project',
              lastActivityAt: now,
              title: 'Other active session',
              cwd: '/home/user/project',
            },
          ],
        },
      ]
      // Two tabs: the active one is a shell (so the busy session is NOT active),
      // and the second tab has the busy codex session with a pane terminal.
      const tabs: Array<{ id: string; mode: string; terminalId?: string; resumeSessionId?: string }> = [
        { id: 'tab-active', mode: 'shell' },
        { id: 'tab-busy', mode: 'codex', terminalId, resumeSessionId: busySid },
      ]
      const terminals: BackgroundTerminal[] = [
        {
          terminalId, title: 'Codex', createdAt: now, status: 'running', hasClients: true,
          mode: 'codex', sessionRef: { provider: 'codex', sessionId: busySid },
        },
      ]
      const store = createTestStore({
        projects, tabs, terminals, activeTabId: 'tab-active',
        codexActivity: { byTerminalId: { [terminalId]: { terminalId, sessionId: 's1', phase: 'busy', lastActivityAt: 10 } } },
      })
      renderSidebar(store, terminals)

      await act(async () => { vi.advanceTimersByTime(100) })

      const button = screen.getByRole('button', { name: /inactive busy session/i })
      expect(button).toHaveClass('bg-blue-50')
      expect(button).toHaveClass('border-l-2')
      expect(button).toHaveClass('border-l-blue-500/70')
      expect(button).toHaveClass('dark:bg-blue-900/20')
    })
  })
```

Also update the existing `bg-muted` assertions for active+hasTab sessions:

At line 878, change:
```typescript
      expect(rows.filter((row) => row.classList.contains('bg-muted'))).toHaveLength(1)
```
to:
```typescript
      expect(rows.filter((row) => row.classList.contains('bg-emerald-100'))).toHaveLength(1)
```

At line 935, change:
```typescript
      expect(button).toHaveClass('bg-muted')
```
to:
```typescript
      expect(button).toHaveClass('bg-emerald-100')
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx -t "Sidebar row green/blue treatments"`

Expected: FAIL because the `SidebarItem` button still uses the flat `bg-muted` / `hover:bg-muted/50` treatment — the green/blue classes are not present.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/Sidebar.tsx`, replace the `SidebarItem` button className (lines 1047-1052):

```jsx
          className={cn(
            'w-full flex items-center gap-2 px-2 py-3 md:py-2 rounded-md text-left transition-colors group border-l-2',
            isActiveTab
              ? isBusy
                ? 'bg-blue-100 dark:bg-blue-900/40 border-l-blue-500'
                : item.hasTab
                  ? 'bg-emerald-100 dark:bg-emerald-900/40 border-l-emerald-500'
                  : 'bg-muted border-l-transparent'
              : isBusy
                ? 'bg-blue-50 dark:bg-blue-900/20 border-l-blue-500/70 hover:bg-blue-100 dark:hover:bg-blue-900/30'
                : item.hasTab
                  ? 'bg-emerald-50 dark:bg-emerald-900/20 border-l-emerald-500/70 hover:bg-emerald-100 dark:hover:bg-emerald-900/30'
                  : 'hover:bg-muted/50 border-l-transparent'
          )}
```

**Update `docs/index.html`** to reflect the sidebar visual change. The sidebar mock uses `.sb-item` (around line 192), NOT `.sv-session` (which is the Projects tab). Add a left-border accent and green fill for open session rows:

In the `.sb-item` CSS rule (around line 192), add:

```css
.sb-item { border-left: 3px solid transparent; transition: background-color .15s, border-color .15s; }
.sb-item.open { border-left-color: hsl(142 71% 45%); background: hsl(142 71% 45% / .08); }
.sb-item.open:hover { background: hsl(142 71% 45% / .12); }
.dark .sb-item.open { background: hsl(142 71% 45% / .15); }
.dark .sb-item.open:hover { background: hsl(142 71% 45% / .2); }
.sb-item-repo-icon { display: inline-block; width: 14px; height: 14px; border-radius: 2px; background: hsl(210 60% 55%); margin-right: 6px; flex-shrink: 0; }
```

And in the sidebar HTML (around lines 650-651), add the `open` class and a repo-icon span before the `sb-item-icon` div for the first two rows (representing open tabs):

```html
<div class="sb-item open"><span class="sb-item-repo-icon"></span><div class="sb-item-icon"><svg viewBox="...
```

(Add the `open` class and `sb-item-repo-icon` span to the first two `sb-item` rows. Leave the remaining rows unchanged.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx`

Expected: PASS — all new treatment tests pass, all updated existing tests pass.

- [ ] **Step 5: Refactor while green**

Review the className expression. It's a nested ternary (3 levels deep), which is the same pattern used by `TabItem.tsx:162-183` and `PaneHeader.tsx:168-170`. It's readable and consistent with the codebase. No refactor needed.

- [ ] **Step 6: Run impacted-test verification**

Impacted tests: all `Sidebar*` tests, `SidebarItem.running-state.test.tsx`, `SidebarItem.remote-status.test.tsx`. The `SidebarItem.running-state.test.tsx` tests use `hasTab: false` (closed), so the active row would get `bg-muted border-l-transparent` and inactive gets `hover:bg-muted/50 border-l-transparent` — the `text-success`/`text-blue-500`/`text-muted-foreground` icon assertions are unaffected. The `SidebarItem.remote-status.test.tsx` tests also use `hasTab: false` — same reasoning.

Run: `npm run test:vitest -- run test/unit/client/components/Sidebar.test.tsx test/unit/client/components/SidebarItem.running-state.test.tsx test/unit/client/components/SidebarItem.remote-status.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/Sidebar.dom-stability.test.tsx test/unit/client/components/Sidebar.highlight.test.ts`

Expected: PASS

- [ ] **Step 7: Run typecheck and lint**

The changes add new imports, props, and JSX to `Sidebar.tsx`. Run TypeScript and accessibility lint to catch type errors and a11y violations before committing:

Run: `npx tsc --noEmit && npm run lint`

Expected: PASS (no type errors, no new a11y violations)

- [ ] **Step 8: Commit the task**

```bash
git add src/components/Sidebar.tsx test/unit/client/components/Sidebar.test.tsx docs/index.html
git commit -m "feat(ui): add green fill and highlight-line treatments to sidebar rows

Sidebar session rows now use the same green/blue vocabulary as tabs and
pane headers: open sessions (hasTab, not busy) get a green fill +
emerald left-border line, busy sessions get a blue fill + blue left-border
line, and closed sessions keep the muted treatment. The left border
width is always present (transparent for closed rows) to keep content
aligned. Matches the pane header's border-l-2 idiom for light and dark."
```

---

## Post-Implementation Notes

**Manual visual verification (both themes):** The unit tests verify that the correct CSS class tokens (including `dark:` overrides) are present, but they run in jsdom which has no real rendering engine. Before marking the work complete, start a dev server on a unique port following the repo's process safety procedure (record PID, log to file, stop by PID when done), and visually verify in a browser that:
1. The green tab highlight is clearly visible in dark mode (Task 1)
2. Repo icons appear in the sidebar before the provider icon, sized the same as the pane header (Task 2)
3. Sidebar rows show green fill + green left-border for open sessions, blue fill + blue left-border for busy sessions, in both light and dark mode (Task 3)
Toggle between light and dark mode (UI Settings → Theme) to confirm both look correct.

**E2e screenshot baselines:** The sidebar visual changes (green fill, left borders, repo icons) will change pixel content in `test/e2e-browser/specs/screenshot-baselines.spec.ts` (`default-layout.png`, `sidebar-collapsed.png`). These baselines use `maxDiffPixelRatio: 0.05` and will likely fail. Re-baselining requires a running server and browser (`npm run test:e2e:local -- --update-snapshots`), which is outside the unit TDD scope. The baselines should be re-captured after the changes are verified locally. This is a follow-up step, not a task.
