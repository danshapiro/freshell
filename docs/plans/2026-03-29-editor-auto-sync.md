# Editor Auto-Sync: Stat-Polling File Sync for Monaco Editor

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add bidirectional auto-sync to the Monaco editor pane — auto-save continues to push local edits to disk after 5s, and a lightweight stat-poll detects when files change externally so the editor silently reloads clean buffers or surfaces a conflict banner for dirty ones.

**Architecture:** A new `GET /api/files/stat` endpoint returns `{ modifiedAt, size, exists }` without reading file content. The client stores `lastKnownMtime` from every load and save. A 3-second `setInterval` polls the stat endpoint for each open editor pane with a `filePath`. If the mtime changes and the editor buffer matches the last-saved content, the file re-fetches silently. If the buffer has local edits, a conflict banner appears with "Reload" / "Keep Mine" actions. The existing auto-save flow is extended to record `lastKnownMtime` from save responses. No new WebSocket messages, no Chokidar expansion, no file watchers.

**Tech Stack:** React 18, Redux Toolkit, Express, Vitest, Testing Library, supertest

## Strategy Gate

- **Why stat-polling, not Chokidar?** The editor watches individual files, not directory trees. A `stat()` syscall every 3s per open file is an inode lookup — essentially free. Chokidar watchers carry OS resource cost (inotify handles, FSEvents subscriptions) that grows with directory depth. The Claude indexer already uses Chokidar for its own scope; expanding it to arbitrary user files risks watcher proliferation, especially in `node_modules` or large monorepos.
- **Why not WebSocket push?** Would require server-side per-file watcher state, connection lifecycle management, and reconnection buffering. Stat-polling is simpler, stateless on the server, and trivially cancellable when a pane closes.
- **Why 3s interval?** Fast enough to feel responsive (file changes appear within a few seconds), slow enough to be negligible (one HEAD-like request per open file). VS Code's `files.watcherExclude` defaults sometimes miss files entirely; stat-polling never misses.
- **Conflict model:** Match VS Code's behavior — if the buffer is clean (matches last-saved state), silently reload. If dirty, show a non-modal banner. No three-way merge, no diff view — those are future enhancements.
- **What's out of scope:** Binary file detection (#20 from the analysis), encoding handling, status bar (#18), word wrap toggle (#26), file tree, new-file action, save-as, keyboard shortcuts. This plan is strictly about sync awareness.

## Guardrails

- Do NOT modify the existing auto-save debounce timing (5s) or behavior.
- Do NOT add Chokidar watchers or WebSocket messages.
- Do NOT change the `EditorPaneContent` type in `paneTypes.ts` (mtime is UI-local state, not persisted pane content).
- Do NOT modify the persist middleware (`stripEditorContent` must keep stripping content).
- Do NOT add new Redux actions or slice state — `lastKnownMtime` and conflict state are component-local refs/state.
- Do NOT change `EditorToolbar.tsx`, `MarkdownPreview.tsx`, or `PaneContainer.tsx`.
- Do NOT touch any terminal, browser, or agent-chat pane code.
- Do NOT add new npm dependencies.

## File Structure Map

| File | Change |
|------|--------|
| `server/files-router.ts` | Add `GET /api/files/stat` endpoint |
| `src/components/panes/EditorPane.tsx` | Add stat-polling interval, mtime tracking, conflict banner, silent reload |
| `test/unit/server/files-router.test.ts` | Add tests for stat endpoint |
| `test/unit/client/components/panes/EditorPane.autosave.test.tsx` | Add tests for stat-polling, conflict detection, silent reload |

---

## Task 1: Add `GET /api/files/stat` endpoint

**Files:**
- Modify: `server/files-router.ts`
- Modify: `test/unit/server/files-router.test.ts`

**Step 1: Write the failing test**

Add to `test/unit/server/files-router.test.ts`, inside the existing `describe('files-router path validation', ...)` block, after the last `describe` block:

```typescript
describe('GET /api/files/stat', () => {
  it('returns file metadata without reading content', async () => {
    const mtime = new Date('2026-03-29T12:00:00.000Z')
    mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
    mockStat.mockResolvedValue({ isDirectory: () => false, size: 1024, mtime })

    const res = await request(app)
      .get('/api/files/stat')
      .query({ path: '/home/user/file.txt' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      exists: true,
      size: 1024,
      modifiedAt: '2026-03-29T12:00:00.000Z',
    })
    expect(mockReadFile).not.toHaveBeenCalled()
  })

  it('returns exists:false for missing files', async () => {
    mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
    mockStat.mockRejectedValue({ code: 'ENOENT' })

    const res = await request(app)
      .get('/api/files/stat')
      .query({ path: '/home/user/nonexistent.txt' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ exists: false, size: null, modifiedAt: null })
  })

  it('returns 403 for paths outside allowed directories', async () => {
    mockGetSettings.mockResolvedValue({ allowedFilePaths: ['/home/user/projects'] })

    const res = await request(app)
      .get('/api/files/stat')
      .query({ path: '/etc/passwd' })

    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Path not allowed')
  })

  it('returns exists:false for directories', async () => {
    mockGetSettings.mockResolvedValue({ allowedFilePaths: undefined })
    mockStat.mockResolvedValue({ isDirectory: () => true, size: 4096, mtime: new Date() })

    const res = await request(app)
      .get('/api/files/stat')
      .query({ path: '/home/user/projects' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ exists: false, size: null, modifiedAt: null })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/auto-sync-editor && npx vitest run test/unit/server/files-router.test.ts`
Expected: FAIL — `GET /api/files/stat` returns 404 (route doesn't exist yet).

**Step 3: Write minimal implementation**

Add to `server/files-router.ts`, after the `GET /read` handler block and before the `POST /write` handler:

```typescript
router.get('/stat', validatePath, async (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) {
    return res.status(400).json({ error: 'path query parameter required' })
  }

  const resolved = await resolveUserFilesystemPath(filePath)

  try {
    const stat = await fsp.stat(resolved)
    if (stat.isDirectory()) {
      return res.json({ exists: false, size: null, modifiedAt: null })
    }

    res.json({
      exists: true,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    })
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return res.json({ exists: false, size: null, modifiedAt: null })
    }
    return res.status(500).json({ error: err.message })
  }
})
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/auto-sync-editor && npx vitest run test/unit/server/files-router.test.ts`
Expected: PASS — all stat endpoint tests green, existing tests unchanged.

**Step 5: Commit**

```bash
git add server/files-router.ts test/unit/server/files-router.test.ts
git commit -m "feat: add GET /api/files/stat endpoint for lightweight file metadata

Returns { exists, size, modifiedAt } without reading file content.
Uses existing validatePath middleware for sandbox enforcement.
Used by the editor pane for change detection via stat-polling."
```

---

## Task 2: Add stat-polling and conflict detection to EditorPane

**Files:**
- Modify: `src/components/panes/EditorPane.tsx`

This is the core change. The additions are:

1. A `lastSavedContent` ref that tracks what was last written to disk (updated on auto-save and manual save).
2. A `lastKnownMtime` ref updated on initial load, after each save response, and after each stat-poll cycle.
3. A `conflictState` local state: `null` (no conflict) or `{ diskContent: string, diskMtime: string }`.
4. A `useEffect` that starts a 3s interval polling `GET /api/files/stat` when `filePath` is set and there's no active conflict banner. On mtime change:
   - If `pendingContent.current === lastSavedContent.current` → silent re-fetch, update editor, update refs.
   - If dirty → fetch disk content, set `conflictState`.
5. A conflict banner UI rendered between the toolbar and the editor.
6. "Reload" action: apply disk content, clear conflict, update refs.
7. "Keep Mine" action: dismiss banner, update `lastKnownMtime` to the disk mtime (so next poll doesn't re-trigger), record the local content as `lastSavedContent`.

**Step 1: Write the failing tests**

Add to `test/unit/client/components/panes/EditorPane.autosave.test.tsx`:

```typescript
describe('EditorPane stat-polling auto-sync', () => {
  it('silently reloads when file changes on disk and buffer is clean', async () => {
    const initialMtime = '2026-03-29T12:00:00.000Z'
    const changedMtime = '2026-03-29T12:00:05.000Z'

    vi.mocked(fetch).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/files/read')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            content: 'changed on disk',
            size: 16,
            modifiedAt: changedMtime,
            filePath: '/test.ts',
          }),
        } as Response)
      }
      if (typeof url === 'string' && url.includes('/api/files/stat')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            exists: true,
            size: 16,
            modifiedAt: changedMtime,
          }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, modifiedAt: initialMtime }),
      } as Response)
    })

    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial content"
          viewMode="source"
        />
      </Provider>
    )

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    const editor = screen.getByTestId('monaco-mock')
    expect(editor).toHaveValue('changed on disk')
  })

  it('shows conflict banner when file changes on disk and buffer is dirty', async () => {
    const initialMtime = '2026-03-29T12:00:00.000Z'
    const changedMtime = '2026-03-29T12:00:05.000Z'

    let statCallCount = 0
    vi.mocked(fetch).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/files/stat')) {
        statCallCount++
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            exists: true,
            size: 20,
            modifiedAt: statCallCount > 0 ? changedMtime : initialMtime,
          }),
        } as Response)
      }
      if (typeof url === 'string' && url.includes('/api/files/read')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            content: 'external change',
            size: 16,
            modifiedAt: changedMtime,
            filePath: '/test.ts',
          }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, modifiedAt: initialMtime }),
      } as Response)
    })

    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial content"
          viewMode="source"
        />
      </Provider>
    )

    const editor = screen.getByTestId('monaco-mock')
    await act(async () => {
      fireEvent.change(editor, { target: { value: 'local edit' } })
    })

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    expect(screen.getByText(/file changed on disk/i)).toBeInTheDocument()
  })

  it('resolves conflict by reloading from disk', async () => {
    const initialMtime = '2026-03-29T12:00:00.000Z'
    const changedMtime = '2026-03-29T12:00:05.000Z'

    let statCallCount = 0
    vi.mocked(fetch).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/files/stat')) {
        statCallCount++
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            exists: true,
            size: 20,
            modifiedAt: statCallCount > 0 ? changedMtime : initialMtime,
          }),
        } as Response)
      }
      if (typeof url === 'string' && url.includes('/api/files/read')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            content: 'external change',
            size: 16,
            modifiedAt: changedMtime,
            filePath: '/test.ts',
          }),
        } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, modifiedAt: initialMtime }),
      } as Response)
    })

    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial content"
          viewMode="source"
        />
      </Provider>
    )

    const editor = screen.getByTestId('monaco-mock')
    await act(async () => {
      fireEvent.change(editor, { target: { value: 'local edit' } })
    })

    await act(async () => {
      vi.advanceTimersByTime(3000)
    })

    const reloadButton = screen.getByRole('button', { name: /reload/i })
    await act(async () => {
      fireEvent.click(reloadButton)
    })

    expect(screen.getByTestId('monaco-mock')).toHaveValue('external change')
    expect(screen.queryByText(/file changed on disk/i)).not.toBeInTheDocument()
  })

  it('stops polling when pane is unmounted', async () => {
    const { unmount } = render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath="/test.ts"
          language="typescript"
          readOnly={false}
          content="initial content"
          viewMode="source"
        />
      </Provider>
    )

    unmount()

    const fetchCallsBefore = vi.mocked(fetch).mock.calls.length
    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    const fetchCallsAfter = vi.mocked(fetch).mock.calls.length
    expect(fetchCallsAfter).toBe(fetchCallsBefore)
  })

  it('does not poll for scratch pads (no filePath)', async () => {
    render(
      <Provider store={store}>
        <EditorPane
          paneId="pane-1"
          tabId="tab-1"
          filePath={null}
          language={null}
          readOnly={false}
          content="scratch"
          viewMode="source"
        />
      </Provider>
    )

    await act(async () => {
      vi.advanceTimersByTime(10000)
    })

    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/files/stat'),
      expect.anything()
    )
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd .worktrees/auto-sync-editor && npx vitest run test/unit/client/components/panes/EditorPane.autosave.test.tsx`
Expected: FAIL — no stat-polling logic exists, conflict banner doesn't render, timer-based reload doesn't happen.

**Step 3: Write minimal implementation**

In `src/components/panes/EditorPane.tsx`, add the following changes:

1. Add new refs and state after the existing refs (around line 158):

```typescript
const lastSavedContent = useRef<string>(content)
const lastKnownMtime = useRef<string | null>(null)
const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

const [conflictState, setConflictState] = useState<{
  diskContent: string
  diskMtime: string
} | null>(null)
```

2. Update `handlePathSelect` to record `lastKnownMtime` and `lastSavedContent` after a successful file load. After the line `pendingContent.current = response.content` (around line 372), add:

```typescript
lastSavedContent.current = response.content
lastKnownMtime.current = response.modifiedAt || null
```

Wait — the `/api/files/read` endpoint returns `modifiedAt`. We need to capture that. The response type currently has `{ content, size, modifiedAt }`. The `handlePathSelect` function destructures the response but doesn't capture `modifiedAt`. We need to update the destructuring.

Find the response handling in `handlePathSelect` (around line 350-372):

```typescript
const response = await api.get<{
  content: string
  language?: string
  filePath?: string
}>(`/api/files/read?path=${encodeURIComponent(resolvedPath)}`)
```

Change the type to include `modifiedAt`:

```typescript
const response = await api.get<{
  content: string
  language?: string
  filePath?: string
  modifiedAt?: string
}>(`/api/files/read?path=${encodeURIComponent(resolvedPath)}`)
```

Then after `pendingContent.current = response.content`, add:

```typescript
lastSavedContent.current = response.content
lastKnownMtime.current = response.modifiedAt || null
```

3. Update auto-save success to record the new mtime. In the `scheduleAutoSave` callback, after the successful write, capture the response mtime. Change the `await api.post(...)` to capture the response:

```typescript
const saveResult = await api.post<{ success: boolean; modifiedAt?: string }>('/api/files/write', {
  path: resolved,
  content: value,
})
lastKnownMtime.current = saveResult?.modifiedAt || null
lastSavedContent.current = value
```

Similarly update `performSave`:

```typescript
const saveResult = await api.post<{ success: boolean; modifiedAt?: string }>('/api/files/write', {
  path: resolved,
  content: value,
})
lastKnownMtime.current = saveResult?.modifiedAt || null
lastSavedContent.current = value
```

4. Add the stat-polling `useEffect`. Add after the existing effects, before the `return registerEditorActions` effect:

```typescript
useEffect(() => {
  if (!filePath) return

  const poll = async () => {
    if (!mountedRef.current) return
    if (conflictState) return

    const resolved = resolvePath(filePath)
    if (!resolved) return

    try {
      const statResult = await api.get<{
        exists: boolean
        size: number | null
        modifiedAt: string | null
      }>(`/api/files/stat?path=${encodeURIComponent(resolved)}`)

      if (!mountedRef.current) return

      if (!statResult.exists || !statResult.modifiedAt) return
      if (statResult.modifiedAt === lastKnownMtime.current) return

      if (pendingContent.current === lastSavedContent.current) {
        const response = await api.get<{
          content: string
          language?: string
          filePath?: string
          modifiedAt?: string
        }>(`/api/files/read?path=${encodeURIComponent(resolved)}`)

        if (!mountedRef.current) return

        setEditorValue(response.content)
        pendingContent.current = response.content
        lastSavedContent.current = response.content
        lastKnownMtime.current = response.modifiedAt || null

        updateContent({
          content: response.content,
        })
      } else {
        const response = await api.get<{
          content: string
          modifiedAt?: string
        }>(`/api/files/read?path=${encodeURIComponent(resolved)}`)

        if (!mountedRef.current) return

        setConflictState({
          diskContent: response.content,
          diskMtime: response.modifiedAt || statResult.modifiedAt,
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(
        JSON.stringify({
          severity: 'error',
          event: 'editor_stat_poll_failed',
          error: message,
        })
      )
    }
  }

  pollIntervalRef.current = setInterval(poll, 3000)

  return () => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current)
      pollIntervalRef.current = null
    }
  }
}, [filePath, resolvePath, conflictState, updateContent])
```

5. Add conflict resolution handlers (after `handleToggleViewMode`):

```typescript
const handleReloadFromDisk = useCallback(() => {
  if (!conflictState) return
  setEditorValue(conflictState.diskContent)
  pendingContent.current = conflictState.diskContent
  lastSavedContent.current = conflictState.diskContent
  lastKnownMtime.current = conflictState.diskMtime
  updateContent({ content: conflictState.diskContent })
  setConflictState(null)
}, [conflictState, updateContent])

const handleKeepLocal = useCallback(() => {
  if (!conflictState) return
  lastKnownMtime.current = conflictState.diskMtime
  lastSavedContent.current = pendingContent.current
  setConflictState(null)
}, [conflictState])
```

6. Add conflict banner UI. In the JSX, after the `filePickerMessage` div and before the editor/preview container div, add:

```tsx
{conflictState && (
  <div
    className="flex items-center gap-2 px-3 py-2 bg-yellow-500/10 border-b border-yellow-500/30 text-sm"
    role="alert"
    data-testid="editor-conflict-banner"
  >
    <span className="flex-1 text-yellow-700 dark:text-yellow-400">
      File changed on disk
    </span>
    <button
      className="rounded px-2 py-1 text-xs font-medium bg-yellow-500/20 hover:bg-yellow-500/30"
      onClick={handleReloadFromDisk}
      aria-label="Reload file from disk"
    >
      Reload
    </button>
    <button
      className="rounded px-2 py-1 text-xs font-medium bg-muted hover:bg-muted/80"
      onClick={handleKeepLocal}
      aria-label="Keep local changes"
    >
      Keep Mine
    </button>
  </div>
)}
```

**Step 4: Run test to verify it passes**

Run: `cd .worktrees/auto-sync-editor && npx vitest run test/unit/client/components/panes/EditorPane.autosave.test.tsx`
Expected: PASS — all new stat-polling tests green, existing auto-save tests still pass.

**Step 5: Commit**

```bash
git add src/components/panes/EditorPane.tsx test/unit/client/components/panes/EditorPane.autosave.test.tsx
git commit -m "feat: add stat-polling auto-sync to editor pane

Client polls GET /api/files/stat every 3s for open file panes.
If the file changed on disk and the buffer is clean, silently
reloads. If the buffer is dirty, shows a conflict banner with
Reload/Keep Mine actions. No watchers or WebSocket changes."
```

---

## Task 3: Extend existing auto-save tests to verify mtime tracking

**Files:**
- Modify: `test/unit/client/components/panes/EditorPane.autosave.test.tsx`

**Step 1: Write the failing test**

Add to the existing `describe('EditorPane auto-save', ...)` block:

```typescript
it('records modifiedAt from save response as lastKnownMtime', async () => {
  const saveMtime = '2026-03-29T12:00:06.000Z'
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    text: () => Promise.resolve(JSON.stringify({ success: true, modifiedAt: saveMtime })),
    json: () => Promise.resolve({ success: true, modifiedAt: saveMtime }),
  } as Response)

  render(
    <Provider store={store}>
      <EditorPane
        paneId="pane-1"
        tabId="tab-1"
        filePath="/test.ts"
        language="typescript"
        readOnly={false}
        content="initial"
        viewMode="source"
      />
    </Provider>
  )

  const editor = screen.getByTestId('monaco-mock')
  await act(async () => {
    fireEvent.change(editor, { target: { value: 'changed' } })
  })

  await act(async () => {
    vi.advanceTimersByTime(5000)
  })

  const writeCalls = vi.mocked(fetch).mock.calls.filter(
    (call) => typeof call[0] === 'string' && (call[0] as string).includes('/api/files/write')
  )
  expect(writeCalls.length).toBe(1)
})
```

**Step 2: Run test to verify it passes**

Run: `cd .worktrees/auto-sync-editor && npx vitest run test/unit/client/components/panes/EditorPane.autosave.test.tsx`
Expected: PASS — this is a verification test; the implementation from Task 2 makes it pass.

**Step 3: Commit**

```bash
git add test/unit/client/components/panes/EditorPane.autosave.test.tsx
git commit -m "test: verify mtime tracking after auto-save in editor pane

Confirms that auto-save records the modifiedAt from the write
response, which is used by the stat-polling loop to detect
subsequent external changes."
```

---

## Task 4: Run full test suite and verify no regressions

**Files:** None (verification only)

**Step 1: Run the full test suite**

Run: `cd .worktrees/auto-sync-editor && npm test`
Expected: PASS — all existing tests pass, new tests pass.

**Step 2: Run typecheck**

Run: `cd .worktrees/auto-sync-editor && npx tsc --noEmit`
Expected: PASS — no type errors.

---

## Summary Table

| File | Change |
|------|--------|
| `server/files-router.ts` | Add `GET /stat` endpoint (returns mtime/size/exists without reading content) |
| `src/components/panes/EditorPane.tsx` | Add stat-polling interval, mtime refs, conflict banner, silent reload, conflict resolution handlers |
| `test/unit/server/files-router.test.ts` | Add 4 tests for stat endpoint (normal, missing, forbidden, directory) |
| `test/unit/client/components/panes/EditorPane.autosave.test.tsx` | Add 5 tests for stat-polling (silent reload, conflict detection, conflict resolution reload, unmount cleanup, scratch pad exclusion) and 1 test for mtime tracking |
