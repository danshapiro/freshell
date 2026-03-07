# Show Open-Tab Sessions In Sidebar Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Ensure any session already open in a tab is present in the left sidebar even when it falls outside the paginated 100-session window.

**Architecture:** Keep `state.sessions.projects` as the canonical sidebar data source and hydrate missing open-tab sessions into that state with exact server lookups. Do not synthesize fake sidebar rows from tab state alone; fetch the canonical indexed session records, merge them into Redux without disturbing pagination state, and keep existing visibility filters (`showSubagents`, `hideEmptySessions`, etc.) unchanged.

**Tech Stack:** React 18, Redux Toolkit, Express, Zod, Vitest, Testing Library, supertest

**Worktree:** `/home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar`

**Notes:**
- The mounted sessions router is `server/sessions-router.ts`. Do not patch `server/routes/sessions.ts`; it is not used by `server/index.ts`.
- Pagination semantics stay intact. The first page is still the newest 100 sessions; open-tab sessions are hydrated out-of-band and merged into canonical state.
- No `docs/index.html` update is needed for this change because the UI layout does not change; only sidebar data hydration changes.

---

### Task 1: Extract Shared Open-Session Reference Collection

**Files:**
- Modify: `src/lib/session-utils.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Test: `test/unit/client/lib/session-utils.test.ts`

**Step 1: Write the failing tests**

Add focused tests to `test/unit/client/lib/session-utils.test.ts` for a new helper that walks tabs + pane layouts and returns deduped `{ provider, sessionId }` refs for all open sessions. Cover:

- terminal panes with `resumeSessionId`
- agent-chat panes (`provider: 'claude'`)
- tabs without layouts using the legacy tab-level fallback
- duplicate session refs across multiple panes/tabs
- invalid Claude IDs ignored the same way existing helpers already ignore them

Use concrete expectations like:

```typescript
expect(collectSessionRefsFromTabs(tabs, panes)).toEqual([
  { provider: 'codex', sessionId: 'codex-session-1' },
  { provider: 'claude', sessionId: VALID_SESSION_ID },
])
```

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts
```

Expected: FAIL because `collectSessionRefsFromTabs` does not exist yet.

**Step 3: Implement the shared helper and refactor sidebar tab detection**

In `src/lib/session-utils.ts`, add a pure helper with the same matching rules already used by the sidebar:

```typescript
export function collectSessionRefsFromTabs(
  tabs: RootState['tabs']['tabs'],
  panes: Pick<RootState['panes'], 'layouts'>,
): Array<{ provider: CodingCliProviderName; sessionId: string }> {
  const seen = new Set<string>()
  const refs: Array<{ provider: CodingCliProviderName; sessionId: string }> = []

  const push = (provider: CodingCliProviderName, sessionId: string) => {
    const key = `${provider}:${sessionId}`
    if (seen.has(key)) return
    seen.add(key)
    refs.push({ provider, sessionId })
  }

  // Layout-based refs first, then legacy fallback for tabs without layouts.
  // Keep the same Claude UUID validation rules as extractSessionRef().
}
```

Then refactor `src/store/selectors/sidebarSelectors.ts` so `buildSessionItems()` uses `collectSessionRefsFromTabs()` instead of keeping its own inline tab traversal logic.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/lib/session-utils.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/lib/session-utils.ts src/store/selectors/sidebarSelectors.ts test/unit/client/lib/session-utils.test.ts
git commit -m "refactor: share open-tab session reference collection"
```

---

### Task 2: Add Exact Session Resolve API For Open Tabs

**Files:**
- Modify: `server/sessions-router.ts`
- Modify: `src/lib/api.ts`
- Create: `test/unit/server/sessions-router.resolve.test.ts`
- Modify: `test/unit/client/lib/api.test.ts`

**Step 1: Write the failing server and client API tests**

Create `test/unit/server/sessions-router.resolve.test.ts` with cases for:

- `POST /sessions/resolve` returns only requested sessions, grouped by project
- duplicate request entries are deduped
- missing sessions are ignored instead of failing the whole request
- malformed bodies return `400`

Add client tests to `test/unit/client/lib/api.test.ts` that verify a new helper POSTs JSON like:

```json
{
  "sessions": [
    { "provider": "codex", "sessionId": "019cbc9d-bea0-7c93-9248-21d7e48f8ead" }
  ]
}
```

to `/api/sessions/resolve`.

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/server/sessions-router.resolve.test.ts test/unit/client/lib/api.test.ts
```

Expected: FAIL because the route/helper do not exist yet.

**Step 3: Implement the route and client helper**

In `server/sessions-router.ts`, add:

```typescript
const ResolveSessionsRequestSchema = z.object({
  sessions: z.array(z.object({
    provider: CodingCliProviderSchema,
    sessionId: z.string().min(1),
  })).min(1).max(200),
})

router.post('/sessions/resolve', async (req, res) => {
  const parsed = ResolveSessionsRequestSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
  }

  const wanted = new Set(
    parsed.data.sessions.map((session) => makeSessionKey(session.provider, session.sessionId)),
  )

  const projects = codingCliIndexer.getProjects()
    .map((project) => ({
      ...project,
      sessions: project.sessions.filter((session) =>
        wanted.has(makeSessionKey(session.provider, session.sessionId)),
      ),
    }))
    .filter((project) => project.sessions.length > 0)

  res.json({ projects })
})
```

In `src/lib/api.ts`, add a typed helper:

```typescript
export async function resolveSessions(
  sessions: Array<{ provider: CodingCliProviderName; sessionId: string }>,
): Promise<{ projects: ProjectGroup[] }> {
  return api.post('/api/sessions/resolve', { sessions })
}
```

If `ProjectGroup` import would create a runtime cycle, use `import type`.

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/server/sessions-router.resolve.test.ts test/unit/client/lib/api.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add server/sessions-router.ts src/lib/api.ts test/unit/server/sessions-router.resolve.test.ts test/unit/client/lib/api.test.ts
git commit -m "feat: add exact session resolve API for open tabs"
```

---

### Task 3: Merge Resolved Sessions Into Canonical Redux Session State

**Files:**
- Modify: `src/store/sessionsSlice.ts`
- Modify: `test/unit/client/store/sessionsSlice.test.ts`

**Step 1: Write the failing reducer tests**

Add a new `describe('mergeResolvedProjects', ...)` block to `test/unit/client/store/sessionsSlice.test.ts` covering:

- adding an older resolved session into an already-loaded project without dropping existing sessions
- adding a resolved session for a project not yet present in `state.projects`
- replacing a stale copy of an already-known session by `provider:sessionId`
- preserving provider collisions (`claude:s1` and `codex:s1` are different sessions)

Use concrete examples like:

```typescript
state = sessionsReducer(state, mergeResolvedProjects([
  {
    projectPath: '/project/a',
    sessions: [
      { provider: 'codex', sessionId: 'open-old', projectPath: '/project/a', updatedAt: 123, title: 'Open old session' },
    ],
  },
]))
```

**Step 2: Run the reducer tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/sessionsSlice.test.ts
```

Expected: FAIL because `mergeResolvedProjects` does not exist yet.

**Step 3: Implement `mergeResolvedProjects`**

Add a reducer to `src/store/sessionsSlice.ts` that treats the incoming projects as non-authoritative partial upserts:

```typescript
mergeResolvedProjects: (state, action: PayloadAction<ProjectGroup[]>) => {
  const incoming = normalizeProjects(action.payload)
  const projectMap = new Map(
    state.projects.map((project) => [project.projectPath, { ...project, sessions: [...project.sessions] }]),
  )

  for (const incomingProject of incoming) {
    const existing = projectMap.get(incomingProject.projectPath)
    if (!existing) {
      projectMap.set(incomingProject.projectPath, incomingProject)
      continue
    }

    const sessionsByKey = new Map(
      existing.sessions.map((session: any) => [`${session.provider || 'claude'}:${session.sessionId}`, session]),
    )

    for (const session of incomingProject.sessions as any[]) {
      sessionsByKey.set(`${session.provider || 'claude'}:${session.sessionId}`, session)
    }

    projectMap.set(incomingProject.projectPath, {
      ...existing,
      ...(incomingProject.color ? { color: incomingProject.color } : {}),
      sessions: Array.from(sessionsByKey.values()).sort((a: any, b: any) => b.updatedAt - a.updatedAt),
    })
  }

  state.projects = sortProjectsByRecency(Array.from(projectMap.values()))
  state.lastLoadedAt = Date.now()
}
```

Do not use `mergeProjects()` here; that reducer replaces whole projects and would drop paginated or previously resolved siblings.

**Step 4: Re-run the reducer tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/sessionsSlice.test.ts test/unit/client/sessionsSlice.pagination.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/store/sessionsSlice.ts test/unit/client/store/sessionsSlice.test.ts
git commit -m "feat: merge resolved sessions into sidebar state"
```

---

### Task 4: Add Missing Open-Session Selectors And App-Side Hydration

**Files:**
- Create: `src/store/selectors/openSessionSelectors.ts`
- Create: `test/unit/client/store/selectors/openSessionSelectors.test.ts`
- Modify: `src/App.tsx`
- Create: `test/unit/client/components/App.open-tab-session-hydration.test.tsx`

**Step 1: Write the failing selector and App tests**

Create `test/unit/client/store/selectors/openSessionSelectors.test.ts` covering:

- only open sessions missing from `state.sessions.projects` are returned
- output is deduped by composite key
- unrelated state changes return the same memoized array reference

Create `test/unit/client/components/App.open-tab-session-hydration.test.tsx` covering:

- bootstrap loads `/api/sessions?limit=100` without the open session
- App then calls `POST /api/sessions/resolve` exactly once for the missing open session
- App dispatches `mergeResolvedProjects()` and the store ends up containing that session
- once the session is known, App does not keep re-posting the same resolve request

Mock heavy children (`TabContent`, `HistoryView`, etc.) but keep the real store and `App`.

**Step 2: Run the targeted tests to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/selectors/openSessionSelectors.test.ts test/unit/client/components/App.open-tab-session-hydration.test.tsx
```

Expected: FAIL because the selectors/effect do not exist yet.

**Step 3: Implement the selectors and hydration effect**

Create `src/store/selectors/openSessionSelectors.ts` with stable memoized selectors:

```typescript
const selectProjects = (state: RootState) => state.sessions.projects
const selectTabs = (state: RootState) => state.tabs.tabs
const selectPanes = (state: RootState) => state.panes

function toSessionKey(provider: CodingCliProviderName, sessionId: string): string {
  return `${provider}:${sessionId}`
}

export const selectMissingOpenSessionRefs = createSelector(
  [selectProjects, selectTabs, selectPanes],
  (projects, tabs, panes) => {
    const known = new Set<string>()
    for (const project of projects) {
      for (const session of project.sessions) {
        known.add(toSessionKey(session.provider || 'claude', session.sessionId))
      }
    }

    return collectSessionRefsFromTabs(tabs, panes).filter(
      (ref) => !known.has(toSessionKey(ref.provider, ref.sessionId)),
    )
  },
)
```

In `src/App.tsx`, add a post-bootstrap hydration effect:

```typescript
const lastLoadedAt = useAppSelector((state) => state.sessions.lastLoadedAt)
const missingOpenSessionRefs = useAppSelector(selectMissingOpenSessionRefs)
const openSessionResolveInFlightRef = useRef<string | null>(null)

useEffect(() => {
  if (typeof lastLoadedAt !== 'number' || missingOpenSessionRefs.length === 0) return

  const requestKey = missingOpenSessionRefs
    .map((ref) => `${ref.provider}:${ref.sessionId}`)
    .sort()
    .join('|')

  if (openSessionResolveInFlightRef.current === requestKey) return
  openSessionResolveInFlightRef.current = requestKey

  let cancelled = false
  void resolveSessions(missingOpenSessionRefs)
    .then((response) => {
      if (!cancelled) {
        dispatch(mergeResolvedProjects(response.projects || []))
      }
    })
    .catch((err) => {
      if (!cancelled) log.warn('Failed to resolve open-tab sessions', err)
    })
    .finally(() => {
      if (!cancelled && openSessionResolveInFlightRef.current === requestKey) {
        openSessionResolveInFlightRef.current = null
      }
    })

  return () => { cancelled = true }
}, [dispatch, lastLoadedAt, missingOpenSessionRefs])
```

Key guardrails:

- do not run before the first HTTP/WS session baseline exists
- do not dispatch placeholder sidebar rows before the canonical payload arrives
- allow future session snapshots to trigger a new resolve only if the missing-key set changes

**Step 4: Re-run the targeted tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/unit/client/store/selectors/openSessionSelectors.test.ts test/unit/client/components/App.open-tab-session-hydration.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add src/store/selectors/openSessionSelectors.ts src/App.tsx test/unit/client/store/selectors/openSessionSelectors.test.ts test/unit/client/components/App.open-tab-session-hydration.test.tsx
git commit -m "feat: hydrate missing open-tab sessions after bootstrap"
```

---

### Task 5: Add A User-Visible Sidebar Regression Test

**Files:**
- Create: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

**Step 1: Write the failing end-to-end regression test**

Create a focused UI flow in `test/e2e/open-tab-session-sidebar-visibility.test.tsx` that:

1. renders `App` with a preloaded tab/pane resuming `codex:019cbc9d-bea0-7c93-9248-21d7e48f8ead`
2. mocks `/api/sessions?limit=100` to return a page that does **not** include that session
3. mocks `/api/sessions/resolve` to return the canonical session record with its real title/project
4. keeps the real `Sidebar` mounted
5. asserts the sidebar eventually shows the resolved session title and marks it as having a tab

Target assertion shape:

```typescript
const button = await screen.findByRole('button', { name: /codex resume 019cbc9d/i })
expect(button).toHaveAttribute('data-has-tab', 'true')
expect(button).toHaveAttribute('data-provider', 'codex')
```

**Step 2: Run the new e2e test to verify failure**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/open-tab-session-sidebar-visibility.test.tsx
```

Expected: FAIL before Task 4 is in place; PASS after Task 4.

**Step 3: Make the smallest production fix only if the e2e exposes a real gap**

Most likely no new production change is needed here. If the e2e still fails after Task 4, fix the actual issue it reveals instead of weakening the assertion.

**Step 4: Re-run the e2e and closely related sidebar flows**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 5: Commit**

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git add test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "test: cover paginated open sessions in the sidebar"
```

---

### Task 6: Full Verification And Final Cleanup

**Files:**
- No new files expected unless the full suite exposes follow-up fixes

**Step 1: Run the full focused regression set**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npx vitest run \
  test/unit/client/lib/session-utils.test.ts \
  test/unit/server/sessions-router.resolve.test.ts \
  test/unit/client/lib/api.test.ts \
  test/unit/client/store/sessionsSlice.test.ts \
  test/unit/client/store/selectors/openSessionSelectors.test.ts \
  test/unit/client/components/App.open-tab-session-hydration.test.tsx \
  test/e2e/open-tab-session-sidebar-visibility.test.tsx \
  test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

**Step 2: Run typecheck + tests**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npm run check
```

Expected: PASS.

**Step 3: Run the full test suite required before merge**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
npm test
```

Expected: PASS.

**Step 4: Inspect the worktree and commit any suite-driven fixups**

Run:

```bash
cd /home/user/code/freshell/.worktrees/show-open-tab-sessions-in-sidebar
git status --short
```

If the full suite required follow-up fixes, commit them with:

```bash
git add <exact files>
git commit -m "fix: finalize open-tab session sidebar hydration"
```

If `git status --short` is empty, do not create an empty commit.

