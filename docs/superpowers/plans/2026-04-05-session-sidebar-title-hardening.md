# Session Sidebar Title Hardening Implementation Plan

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make inferred session titles durable, keep active or running sessions visible in the sidebar, and improve lightweight Codex title recovery so long-lived sessions do not disappear from the left pane.

**Architecture:** Treat this as one indexing contract fix spanning server and client. The server becomes the durable source of inferred titles via a sticky metadata field plus monotonic index merges, the client selector merges live tab state into server rows instead of suppressing it, and the lightweight scan learns enough of the Codex JSONL shape to recover titles during cold start without waiting for full enrichment. Keep user session overrides authoritative and preserve the existing `hideEmptySessions` behavior for inactive, truly titleless sessions.

**Tech Stack:** TypeScript, Node.js, Express, React 18, Redux Toolkit, Vitest, Testing Library, Supertest.

---

## Scope Check

These three fixes are tightly coupled parts of the same failure mode:

1. server-side sticky derived titles
2. client-side sidebar visibility invariants
3. lightweight Codex title recovery

Keep them in one plan so the same regression harnesses prove the full user-visible behavior.

Spec source: the current Freshell session thread about sticky derived titles, sidebar visibility for active sessions, and lightweight Codex title recovery. There is no separate spec document.

## Guardrails

- Execute only from a dedicated git worktree under `.worktrees/`. Do not edit `main` directly.
- Follow Red-Green-Refactor for every code change in this plan.
- Preserve precedence: user rename override > freshly parsed title > previous cached title > persisted derived title.
- Do not let session metadata writes become unbounded. Only persist `derivedTitle` when the non-empty value changes.
- `hideEmptySessions` may still hide inactive, truly empty sessions. It must not hide sessions that are open in a tab or actively running.
- Keep `readLightweightMeta()` bounded to head/tail reads. Do not turn cold start back into a full-file parse.
- Keep `POST /api/session-metadata` backward compatible. Updating `sessionType` must not clear stored `derivedTitle`.
- Scope this change to file-backed providers (`claude`, `codex`, and other JSONL-backed providers). Do not widen the direct-listing provider contract in this pass.

## File Structure Map

- Modify: `server/session-metadata-store.ts`
  - Purpose: persist a sticky `derivedTitle` field and merge metadata patches instead of overwriting sibling fields.
- Modify: `test/unit/server/session-metadata-store.test.ts`
  - Purpose: lock in merged metadata semantics and defensive-copy behavior for `derivedTitle`.
- Modify: `test/integration/server/session-metadata-api.test.ts`
  - Purpose: prove the existing session metadata API still updates `sessionType` without clearing stored sticky titles.
- Modify: `server/coding-cli/session-indexer.ts`
  - Purpose: preserve non-empty titles across reparses, hydrate lightweight rows from persisted metadata, persist newly discovered titles, and improve lightweight Codex title extraction.
- Modify: `test/unit/server/coding-cli/session-indexer.test.ts`
  - Purpose: capture title-preservation regressions, cold-start metadata hydration, metadata persistence, and lightweight Codex title recovery.
- Modify: `src/store/selectors/sidebarSelectors.ts`
  - Purpose: merge fallback live-tab data into matching server-backed rows and guarantee active/running sessions are not hidden by `hideEmptySessions`.
- Modify: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
  - Purpose: prove a titleless indexed row is upgraded by matching tab state instead of shadowing the fallback row.
- Modify: `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`
  - Purpose: prove empty-session filtering still hides inactive empty rows but keeps open/running ones visible.
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`
  - Purpose: reproduce the user-visible regression through `App`, including HTTP-owned sidebar refresh and an open Codex tab whose indexed row is titleless.

## Chunk 1: Persist And Preserve Derived Titles

### Task 1: Extend session metadata storage for sticky inferred titles

**Files:**
- Modify: `server/session-metadata-store.ts`
- Test: `test/unit/server/session-metadata-store.test.ts`
- Test: `test/integration/server/session-metadata-api.test.ts`

- [ ] **Step 1: Write the failing metadata-store unit tests**

```ts
it('merges derivedTitle into an existing metadata record', async () => {
  await store.set('codex', 'sess-1', { sessionType: 'codex' })
  await store.set('codex', 'sess-1', { derivedTitle: 'Investigate sidebar visibility' })

  expect(await store.get('codex', 'sess-1')).toEqual({
    sessionType: 'codex',
    derivedTitle: 'Investigate sidebar visibility',
  })
})

it('returns defensive copies that include derivedTitle', async () => {
  await store.set('codex', 'sess-2', { derivedTitle: 'Sticky title' })

  const entry = await store.get('codex', 'sess-2')
  entry!.derivedTitle = 'mutated'

  expect((await store.get('codex', 'sess-2'))?.derivedTitle).toBe('Sticky title')
})
```

- [ ] **Step 2: Write the failing integration test for the existing metadata API**

```ts
it('preserves derivedTitle when the session metadata API updates sessionType', async () => {
  await sessionMetadataStore.set('claude', 'sess-123', { derivedTitle: 'Sticky title' })

  const res = await request(app)
    .post('/api/session-metadata')
    .set('x-auth-token', TEST_AUTH_TOKEN)
    .send({ provider: 'claude', sessionId: 'sess-123', sessionType: 'agent' })

  expect(res.status).toBe(200)
  expect(await sessionMetadataStore.get('claude', 'sess-123')).toEqual({
    sessionType: 'agent',
    derivedTitle: 'Sticky title',
  })
})
```

- [ ] **Step 3: Run the new red tests**

Run: `npm run test:vitest -- test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts`

Expected: FAIL because `SessionMetadataEntry` does not include `derivedTitle`, and `set()` currently overwrites the whole record instead of merging.

- [ ] **Step 4: Implement sticky-title metadata support**

```ts
export interface SessionMetadataEntry {
  sessionType?: string
  derivedTitle?: string
}

sessions[provider][sessionId] = {
  ...(sessions[provider][sessionId] ?? {}),
  ...entry,
}
```

Implementation notes:
- Keep `set()` copy-safe by cloning the merged object before saving.
- Do not special-case the API route; the store merge semantics should make it safe automatically.

- [ ] **Step 5: Run the server metadata tests to verify green**

Run: `npm run test:vitest -- test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the metadata-store change**

```bash
git add server/session-metadata-store.ts test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts
git commit -m "feat: persist sticky derived session titles"
```

### Task 2: Lock in monotonic title resolution inside the session indexer

**Files:**
- Modify: `server/coding-cli/session-indexer.ts`
- Test: `test/unit/server/coding-cli/session-indexer.test.ts`

- [ ] **Step 1: Write the failing indexer regression tests**

```ts
it('keeps an existing non-empty title when the same session reparses without one', async () => {
  const fileA = path.join(tempDir, 'session-a.jsonl')
  await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Original title' }) + '\n')

  const provider = makeProvider([fileA])
  const indexer = new CodingCliSessionIndexer([provider])
  await indexer.refresh()

  await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a' }) + '\n')
  ;(indexer as any).markDirty(fileA)
  await indexer.refresh()

  expect(indexer.getProjects()[0]?.sessions[0]?.title).toBe('Original title')
})

it('hydrates a cold-start lightweight row from metadata-store derivedTitle when parsing finds no title', async () => {
  const files: string[] = []
  const sessionId = 'older-codex-session'
  const fileA = path.join(tempDir, `${sessionId}.jsonl`)
  await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a' }) + '\n')
  await fsp.utimes(fileA, new Date(2026, 0, 1), new Date(2026, 0, 1))
  files.push(fileA)

  for (let i = 0; i < 151; i += 1) {
    const file = path.join(tempDir, `recent-${i}.jsonl`)
    await fsp.writeFile(file, JSON.stringify({ cwd: `/project/${i}`, title: `Recent ${i}` }) + '\n')
    files.push(file)
  }

  const provider = makeProvider(files, { name: 'codex' })
  const metadataStore = mockMetadataStore({
    [makeSessionKey('codex', sessionId)]: { derivedTitle: 'Sticky old title' },
  })

  vi.mocked(configStore.snapshot).mockResolvedValue({
    sessionOverrides: {},
    settings: { codingCli: { enabledProviders: ['codex'], providers: {} } },
  })

  const indexer = new CodingCliSessionIndexer([provider], {}, metadataStore)
  await indexer.refresh()

  const olderSession = indexer.getProjects()
    .flatMap((group) => group.sessions)
    .find((session) => session.sessionId === sessionId)

  expect(olderSession?.title).toBe('Sticky old title')
})

it('persists a newly parsed non-empty title to the metadata store', async () => {
  const fileA = path.join(tempDir, 'session-b.jsonl')
  await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Fresh title' }) + '\n')

  const metadataStore = mockMetadataStore({})
  metadataStore.set = vi.fn().mockResolvedValue(undefined)

  const indexer = new CodingCliSessionIndexer([makeProvider([fileA])], {}, metadataStore)
  await indexer.refresh()

  expect(metadataStore.set).toHaveBeenCalledWith('claude', 'session-b', {
    derivedTitle: 'Fresh title',
  })
})

it('does not rewrite derivedTitle when the parsed title matches the stored title', async () => {
  const fileA = path.join(tempDir, 'session-c.jsonl')
  await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Stable title' }) + '\n')

  const metadataStore = mockMetadataStore({
    [makeSessionKey('claude', 'session-c')]: { derivedTitle: 'Stable title' },
  })
  metadataStore.set = vi.fn().mockResolvedValue(undefined)

  const indexer = new CodingCliSessionIndexer([makeProvider([fileA])], {}, metadataStore)
  await indexer.refresh()

  expect(metadataStore.set).not.toHaveBeenCalled()
})

it('resolves title precedence as parsed title, then previous cached title, then stored derivedTitle', async () => {
  const fileA = path.join(tempDir, 'session-d.jsonl')
  await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a', title: 'Parsed title' }) + '\n')

  const metadataStore = mockMetadataStore({
    [makeSessionKey('claude', 'session-d')]: { derivedTitle: 'Stored title' },
  })

  const indexer = new CodingCliSessionIndexer([makeProvider([fileA])], {}, metadataStore)
  await indexer.refresh()
  expect(indexer.getProjects()[0]?.sessions[0]?.title).toBe('Parsed title')

  await fsp.writeFile(fileA, JSON.stringify({ cwd: '/project/a' }) + '\n')
  ;(indexer as any).markDirty(fileA)
  await indexer.refresh()

  expect(indexer.getProjects()[0]?.sessions[0]?.title).toBe('Parsed title')
})
```

- [ ] **Step 2: Run the new red tests**

Run: `npm run test:vitest -- test/unit/server/coding-cli/session-indexer.test.ts`

Expected: FAIL because the indexer demotes `title` to `undefined`, does not read `derivedTitle` from metadata, and never persists parsed titles back to the metadata store.

- [ ] **Step 3: Implement monotonic title resolution in the indexer**

```ts
const metaKey = makeSessionKey(provider.name, sessionId)
const storedTitle = sessionMetadata[metaKey]?.derivedTitle?.trim()
const parsedTitle = meta.title?.trim()
const resolvedTitle = parsedTitle || previous?.title || storedTitle

const baseSession: CodingCliSession = {
  ...,
  title: resolvedTitle,
}

if (this.sessionMetadataStore && parsedTitle && parsedTitle !== storedTitle) {
  await this.sessionMetadataStore.set(provider.name, sessionId, { derivedTitle: parsedTitle })
}
```

Implementation notes:
- Use the same resolution order for both lightweight cache entries and full cache entries.
- Update the local `mockMetadataStore()` helper in `test/unit/server/coding-cli/session-indexer.test.ts` so its entry shape accepts `derivedTitle` alongside `sessionType`.
- Persist only the freshly parsed non-empty title, not the fallback title from user overrides.
- Leave direct-listing providers alone in this change. They do not go through `readLightweightMeta()` and are not part of the regression being fixed.
- Keep `sessionType` merge behavior unchanged.

- [ ] **Step 4: Run the full indexer unit suite to verify green**

Run: `npm run test:vitest -- test/unit/server/coding-cli/session-indexer.test.ts`

Expected: PASS

- [ ] **Step 5: Commit the indexer durability change**

```bash
git add server/coding-cli/session-indexer.ts test/unit/server/coding-cli/session-indexer.test.ts
git commit -m "fix: preserve inferred session titles across refreshes"
```

## Chunk 2: Keep Active Sessions Visible In The Sidebar

### Task 3: Add selector-level regressions for fallback merge and visibility invariants

**Files:**
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Test: `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`

- [ ] **Step 1: Write the failing selector merge test**

```ts
it('merges open-tab fallback data into a matching server-backed titleless session', () => {
  const sessionId = 'claude-current'
  const items = buildSessionItems(
    [makeProject([{ provider: 'claude', sessionId, title: undefined, lastActivityAt: 10 }])],
    [{
      id: 'tab-1',
      title: 'Current Session',
      mode: 'claude',
      resumeSessionId: sessionId,
      createdAt: 20_000,
      sessionMetadataByKey: {
        'claude:claude-current': {
          sessionType: 'freshclaude',
          firstUserMessage: 'IMPORTANT: internal trycycle task',
          isSubagent: true,
          isNonInteractive: true,
        },
      },
    }] as any,
    {
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'claude',
            status: 'running',
            createRequestId: 'req-1',
            resumeSessionId: sessionId,
            initialCwd: '/repo',
          },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'Current Session' } },
    } as any,
    emptyTerminals,
    emptyActivity,
  )

  expect(items).toEqual([
    expect.objectContaining({
      sessionId,
      provider: 'claude',
      title: 'Current Session',
      hasTitle: true,
      hasTab: true,
      sessionType: 'freshclaude',
      firstUserMessage: 'IMPORTANT: internal trycycle task',
      isSubagent: true,
      isNonInteractive: true,
      isFallback: undefined,
    }),
  ])
})
```

- [ ] **Step 2: Write the failing visibility tests**

```ts
it('keeps titleless sessions visible when they have an open tab', () => {
  const result = filterSessionItemsByVisibility([
    createSessionItem({ id: '1', title: 'deadbeef', hasTitle: false, hasTab: true }),
  ], {
    ...baseSettings,
    showSubagents: true,
    showNoninteractiveSessions: true,
    hideEmptySessions: true,
  })

  expect(result.map((item) => item.id)).toEqual(['1'])
})

it('keeps titleless sessions visible when they are running', () => {
  const result = filterSessionItemsByVisibility([
    createSessionItem({ id: '1', title: 'deadbeef', hasTitle: false, isRunning: true }),
  ], {
    ...baseSettings,
    showSubagents: true,
    showNoninteractiveSessions: true,
    hideEmptySessions: true,
  })

  expect(result.map((item) => item.id)).toEqual(['1'])
})
```

- [ ] **Step 3: Run the selector tests to verify red**

Run: `npm run test:vitest -- test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`

Expected: FAIL because `knownKeys` suppresses the fallback row entirely and `hideEmptySessions` still drops the indexed row.

### Task 4: Add an App-level regression for an open Codex session with a titleless indexed row

**Files:**
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

- [ ] **Step 1: Write the failing App regression**

```tsx
it('keeps an open Codex session visible when the indexed sidebar row is titleless', async () => {
  const sessionId = 'codex-current'
  fetchSidebarSessionsSnapshot.mockResolvedValue({
    projects: [
      {
        projectPath: '/repo',
        sessions: [
          {
            provider: 'codex',
            sessionId,
            projectPath: '/repo',
            lastActivityAt: 40,
            title: undefined,
            cwd: '/repo',
          },
        ],
      },
    ],
    totalSessions: 1,
    oldestIncludedTimestamp: 40,
    oldestIncludedSessionId: `codex:${sessionId}`,
    hasMore: false,
  })

  const store = createStore({
    tabs: [{
      id: 'tab-1',
      title: 'Investigate sidebar visibility',
      mode: 'codex',
      resumeSessionId: sessionId,
      createdAt: Date.now(),
    }],
    panes: {
      layouts: {
        'tab-1': {
          type: 'leaf',
          id: 'pane-1',
          content: {
            kind: 'terminal',
            mode: 'codex',
            createRequestId: 'req-1',
            status: 'running',
            resumeSessionId: sessionId,
            initialCwd: '/repo',
          },
        },
      },
      activePane: { 'tab-1': 'pane-1' },
      paneTitles: { 'tab-1': { 'pane-1': 'Investigate sidebar visibility' } },
    },
  })

  render(<Provider store={store}><App /></Provider>)

  await waitFor(() => {
    expect(screen.getAllByText('Investigate sidebar visibility').length).toBeGreaterThan(0)
  })

  act(() => {
    broadcastWs({ type: 'sessions.changed', revision: 1 })
  })

  await waitFor(() => {
    expect(fetchSidebarSessionsSnapshot).toHaveBeenCalled()
    expect(screen.getAllByText('Investigate sidebar visibility').length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run the new e2e regression to verify red**

Run: `npm run test:vitest -- test/e2e/open-tab-session-sidebar-visibility.test.tsx`

Expected: FAIL because the server-backed row shadows the fallback row and the empty-session filter hides it.

### Task 5: Implement sidebar row merging and the active-session visibility invariant

**Files:**
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts`
- Test: `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`
- Test: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

- [ ] **Step 1: Merge fallback row data into an existing item instead of discarding it**

```ts
const existing = itemsByKey.get(key)
if (existing) {
  existing.hasTab = true
  existing.timestamp = Math.max(existing.timestamp, input.timestamp ?? 0)
  if (!existing.hasTitle && input.title?.trim()) {
    existing.title = input.title.trim()
    existing.hasTitle = true
  }
  const fallbackSessionType = input.metadata?.sessionType || input.sessionType
  if (fallbackSessionType && (!existing.sessionType || existing.sessionType === existing.provider)) {
    existing.sessionType = fallbackSessionType
  }
  if (!existing.cwd && input.cwd) existing.cwd = input.cwd
  if (!existing.firstUserMessage && input.metadata?.firstUserMessage) {
    existing.firstUserMessage = input.metadata.firstUserMessage
  }
  if (existing.isSubagent === undefined && input.metadata?.isSubagent !== undefined) {
    existing.isSubagent = input.metadata.isSubagent
  }
  if (existing.isNonInteractive === undefined && input.metadata?.isNonInteractive !== undefined) {
    existing.isNonInteractive = input.metadata.isNonInteractive
  }
  return
}
```

Implementation notes:
- Keep one row per `provider:sessionId`.
- Server-backed rows should remain server-backed; do not flip them to `isFallback`.
- Prefer the existing non-empty server title if one already exists.
- Preserve fallback metadata that affects filtering and labeling: `sessionType`, `firstUserMessage`, `isSubagent`, and `isNonInteractive`.

- [ ] **Step 2: Update empty-session filtering so open/running rows survive**

```ts
if (settings.hideEmptySessions && !item.hasTitle && !item.hasTab && !item.isRunning) {
  return false
}
```

- [ ] **Step 3: Run the selector and e2e tests to verify green**

Run: `npm run test:vitest -- test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx`

Expected: PASS

- [ ] **Step 4: Commit the sidebar selector hardening**

```bash
git add src/store/selectors/sidebarSelectors.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "fix: keep active sessions visible in the sidebar"
```

## Chunk 3: Improve Lightweight Codex Title Recovery

### Task 6: Add a cold-start regression for older Codex sessions outside the enrichment batch

**Files:**
- Modify: `server/coding-cli/session-indexer.ts`
- Test: `test/unit/server/coding-cli/session-indexer.test.ts`

- [ ] **Step 1: Write the failing lightweight Codex title test**

```ts
it('extracts a lightweight title from a Codex response_item user message on cold start', async () => {
  const files: string[] = []
  for (let i = 0; i < 151; i += 1) {
    const file = path.join(tempDir, `recent-${i}.jsonl`)
    await fsp.writeFile(file, [
      JSON.stringify({ type: 'session_meta', payload: { id: `recent-${i}`, cwd: `/project/${i}` } }),
      JSON.stringify({
        timestamp: new Date(2026, 3, 5, 12, i).toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `Recent task ${i}` }],
        },
      }),
    ].join('\n'))
    files.push(file)
  }

  const olderSessionId = 'older-codex-session'
  const olderFile = path.join(tempDir, `${olderSessionId}.jsonl`)
  await fsp.writeFile(olderFile, [
    JSON.stringify({ type: 'session_meta', payload: { id: olderSessionId, cwd: '/project/older' } }),
    JSON.stringify({
      timestamp: new Date(2026, 0, 1).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Investigate sidebar visibility' }],
      },
    }),
  ].join('\n'))
  files.push(olderFile)

  vi.mocked(configStore.snapshot).mockResolvedValue({
    sessionOverrides: {},
    settings: { codingCli: { enabledProviders: ['codex'], providers: {} } },
  })

  const provider = makeProvider(files, {
    name: 'codex',
    parseSessionFile: codexProvider.parseSessionFile,
  })

  const indexer = new CodingCliSessionIndexer([provider], { fullScanIntervalMs: 0 })
  await indexer.refresh()

  const olderSession = indexer.getProjects()
    .flatMap((group) => group.sessions)
    .find((session) => session.sessionId === olderSessionId)

  expect(olderSession?.title).toBe('Investigate sidebar visibility')
})
```

- [ ] **Step 2: Add the failing lightweight system-context guard test**

```ts
it('does not synthesize a lightweight title from older system-context user records', async () => {
  const files: string[] = []
  const systemOnlyId = 'system-only'
  const fileA = path.join(tempDir, `${systemOnlyId}.jsonl`)
  await fsp.writeFile(fileA, JSON.stringify({
    sessionId: systemOnlyId,
    cwd: '/project/a',
    role: 'user',
    content: '<environment_context>\n  <cwd>/project/a</cwd>\n</environment_context>',
    timestamp: new Date(2026, 0, 1).toISOString(),
  }) + '\n')
  await fsp.utimes(fileA, new Date(2026, 0, 1), new Date(2026, 0, 1))
  files.push(fileA)

  for (let i = 0; i < 151; i += 1) {
    const file = path.join(tempDir, `recent-system-${i}.jsonl`)
    await fsp.writeFile(file, [
      JSON.stringify({ type: 'session_meta', payload: { id: `recent-system-${i}`, cwd: `/project/${i}` } }),
      JSON.stringify({
        timestamp: new Date(2026, 3, 5, 12, i).toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `Recent task ${i}` }],
        },
      }),
    ].join('\n'))
    files.push(file)
  }

  vi.mocked(configStore.snapshot).mockResolvedValue({
    sessionOverrides: {},
    settings: { codingCli: { enabledProviders: ['codex'], providers: {} } },
  })

  const provider = makeProvider(files, {
    name: 'codex',
    parseSessionFile: codexProvider.parseSessionFile,
  })

  const indexer = new CodingCliSessionIndexer([provider], { fullScanIntervalMs: 0 })
  await indexer.refresh()

  const systemOnlySession = indexer.getProjects()
    .flatMap((group) => group.sessions)
    .find((session) => session.sessionId === systemOnlyId)

  expect(systemOnlySession?.title).toBeUndefined()
})
```

- [ ] **Step 3: Add the failing IDE-context lightweight title test**

```ts
it('extracts lightweight Codex titles from IDE-context messages', async () => {
  const ideSessionId = 'ide-context-session'
  const ideFile = path.join(tempDir, `${ideSessionId}.jsonl`)
  await fsp.writeFile(ideFile, [
    JSON.stringify({ type: 'session_meta', payload: { id: ideSessionId, cwd: '/project/ide' } }),
    JSON.stringify({
      timestamp: new Date(2026, 0, 1).toISOString(),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: '# Context from my IDE setup:\n\n## My request for Codex:\nFix the authentication bug in the login form',
        }],
      },
    }),
  ].join('\n'))
  await fsp.utimes(ideFile, new Date(2026, 0, 1), new Date(2026, 0, 1))

  const files = [ideFile]
  for (let i = 0; i < 151; i += 1) {
    const file = path.join(tempDir, `recent-ide-${i}.jsonl`)
    await fsp.writeFile(file, [
      JSON.stringify({ type: 'session_meta', payload: { id: `recent-ide-${i}`, cwd: `/project/${i}` } }),
      JSON.stringify({
        timestamp: new Date(2026, 3, 5, 12, i).toISOString(),
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `Recent task ${i}` }],
        },
      }),
    ].join('\n'))
    files.push(file)
  }

  vi.mocked(configStore.snapshot).mockResolvedValue({
    sessionOverrides: {},
    settings: { codingCli: { enabledProviders: ['codex'], providers: {} } },
  })

  const provider = makeProvider(files, {
    name: 'codex',
    parseSessionFile: codexProvider.parseSessionFile,
  })

  const indexer = new CodingCliSessionIndexer([provider], { fullScanIntervalMs: 0 })
  await indexer.refresh()

  const ideSession = indexer.getProjects()
    .flatMap((group) => group.sessions)
    .find((session) => session.sessionId === ideSessionId)

  expect(ideSession?.title).toBe('Fix the authentication bug in the login form')
})
```

- [ ] **Step 4: Run the targeted red tests**

Run: `npm run test:vitest -- test/unit/server/coding-cli/session-indexer.test.ts`

Expected: FAIL because `readLightweightMeta()` only recognizes flat `role/content` records and does not apply the same IDE-context or system-context handling as the full Codex parser.

### Task 7: Teach the lightweight scan enough of the Codex message shape to recover titles safely

**Files:**
- Modify: `server/coding-cli/session-indexer.ts`
- Test: `test/unit/server/coding-cli/session-indexer.test.ts`

- [ ] **Step 1: Implement bounded lightweight title extraction for nested message payloads**

```ts
const nestedMessagePayload =
  obj?.type === 'response_item' && obj?.payload?.type === 'message'
    ? obj.payload
    : undefined

const rawContent =
  nestedMessagePayload?.content ??
  obj?.message?.content ??
  obj?.content

const isUser =
  nestedMessagePayload?.role === 'user' ||
  obj?.role === 'user' ||
  obj?.type === 'user' ||
  obj?.message?.role === 'user'

const rawText = typeof rawContent === 'string'
  ? rawContent
  : Array.isArray(rawContent)
    ? rawContent
        .filter((part: any) => typeof part?.text === 'string')
        .map((part: any) => part.text)
        .join('\n')
    : undefined

if (isUser) {
  const ideRequest = rawText ? extractFromIdeContext(rawText) : undefined
  const candidate = ideRequest || (!isSystemContext(rawText ?? '') ? rawText?.replace(/<\/?image[^>]*>/g, '').trim() : '')
  if (!title && candidate) {
    title = extractTitleFromMessage(candidate, 200)
  }
}
```

Implementation notes:
- Import the same helpers the full Codex parser uses: `extractTitleFromMessage`, `extractFromIdeContext`, and `isSystemContext`.
- Preserve the current flat-record behavior (`obj.content`, `obj.message?.content`, `obj.role === 'user'`) while adding nested `response_item.payload` support.
- Keep the logic inside the existing head-only scan. Do not call the full provider parser from the lightweight path.

- [ ] **Step 2: Run the indexer unit suite to verify green**

Run: `npm run test:vitest -- test/unit/server/coding-cli/session-indexer.test.ts`

Expected: PASS

- [ ] **Step 3: Commit the lightweight Codex parsing improvement**

```bash
git add server/coding-cli/session-indexer.ts test/unit/server/coding-cli/session-indexer.test.ts
git commit -m "fix: improve lightweight codex session titles"
```

## Chunk 4: Final Verification And Merge Readiness

### Task 8: Run the focused pack, then the coordinated full suite

**Files:**
- Verify only:
  - `server/session-metadata-store.ts`
  - `test/unit/server/session-metadata-store.test.ts`
  - `test/integration/server/session-metadata-api.test.ts`
  - `server/coding-cli/session-indexer.ts`
  - `test/unit/server/coding-cli/session-indexer.test.ts`
  - `src/store/selectors/sidebarSelectors.ts`
  - `test/unit/client/store/selectors/sidebarSelectors.test.ts`
  - `test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts`
  - `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

- [ ] **Step 1: Run the focused client/e2e regression pack**

Run: `npm run test:vitest -- test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx`

Expected: PASS under the default JSDOM/client Vitest config.

- [ ] **Step 2: Run the focused server/integration regression pack**

Run: `npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-metadata-store.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/integration/server/session-metadata-api.test.ts`

Expected: PASS under the server/node Vitest config.

- [ ] **Step 3: Check the coordinated test gate before the broad run**

Run: `npm run test:status`

Expected: no conflicting holder, or a clear signal to wait for the shared coordinator before starting `npm test`.

- [ ] **Step 4: Run the full coordinated suite**

Run: `FRESHELL_TEST_SUMMARY="session sidebar title hardening" npm test`

Expected: PASS across the coordinated default and server configs.

- [ ] **Step 5: Review the final diff for scope**

Run: `git diff --stat "$(git merge-base main HEAD)"..HEAD`

Expected: the diff covers the full branch and only includes the planned server, selector, and regression-test files. If anything extra appears, inspect it before continuing.

- [ ] **Step 6: If the full suite forced any cleanup, make the minimal fix, rerun the focused packs and the coordinated suite, then create a final commit**

```bash
npm run test:vitest -- test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx
npm run test:vitest -- --config vitest.server.config.ts test/unit/server/session-metadata-store.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/integration/server/session-metadata-api.test.ts
FRESHELL_TEST_SUMMARY="session sidebar title hardening" npm test
git add server/session-metadata-store.ts server/coding-cli/session-indexer.ts src/store/selectors/sidebarSelectors.ts test/unit/server/session-metadata-store.test.ts test/integration/server/session-metadata-api.test.ts test/unit/server/coding-cli/session-indexer.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.visibility.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "fix: harden session sidebar title recovery"
```
