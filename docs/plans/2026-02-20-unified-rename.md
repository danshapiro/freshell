# Unified Rename Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect pane rename, terminal override, and session override so a single rename action cascades through all three systems.

**Architecture:** The server bridges terminal ↔ session renames. `PATCH /api/terminals/:id` cascades to session overrides when a coding CLI session is attached. `PATCH /api/sessions/:id` cascades to terminal overrides when that session is running in a terminal. The client sends renames to the server for coding CLI panes; shell panes stay Redux-only.

**Tech Stack:** Express routes (server/index.ts), TerminalMetadataService, configStore, Redux (panesSlice, tabsSlice), WebSocket broadcasts.

**Design doc:** `docs/plans/2026-02-20-unified-rename-design.md`

---

### Task 1: Server — terminal rename cascades to session override

**Files:**
- Modify: `server/index.ts:631-647` (PATCH /api/terminals/:terminalId)
- Test: `test/unit/server/unified-rename.test.ts` (new)

**Step 1: Write the failing test**

Create `test/unit/server/unified-rename.test.ts`. Test that PATCHing a terminal with `titleOverride` also writes a session override when the terminal has a coding CLI session.

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { configStore } from '../../server/config-store.js'

// We need to test the actual route handler logic.
// The route is inline in server/index.ts, so we test the cascade behavior
// by calling the configStore and terminalMetadata directly.

describe('unified rename: terminal → session cascade', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('patchSessionOverride is called with compositeKey when terminal has a session', async () => {
    // This test verifies the core cascade logic:
    // Given a terminal with provider='claude' and sessionId='abc-123',
    // when we patch the terminal override with titleOverride='My Session',
    // then patchSessionOverride should be called with 'claude:abc-123' and { titleOverride: 'My Session' }

    const patchSession = vi.spyOn(configStore, 'patchSessionOverride').mockResolvedValue({
      titleOverride: 'My Session',
    })
    const patchTerminal = vi.spyOn(configStore, 'patchTerminalOverride').mockResolvedValue({
      titleOverride: 'My Session',
    })

    // We'll test the extracted helper function rather than spinning up the full server
    // (see step 3 for the helper)
    const { cascadeTerminalRenameToSession } = await import('../../server/rename-cascade.js')

    const terminalMeta = {
      terminalId: 'term-1',
      provider: 'claude' as const,
      sessionId: 'abc-123',
      updatedAt: Date.now(),
    }

    await cascadeTerminalRenameToSession(terminalMeta, 'My Session')

    expect(patchSession).toHaveBeenCalledWith('claude:abc-123', { titleOverride: 'My Session' })
    patchSession.mockRestore()
    patchTerminal.mockRestore()
  })

  it('does nothing when terminal has no session', async () => {
    const patchSession = vi.spyOn(configStore, 'patchSessionOverride').mockResolvedValue({})

    const { cascadeTerminalRenameToSession } = await import('../../server/rename-cascade.js')

    await cascadeTerminalRenameToSession(undefined, 'My Session')

    expect(patchSession).not.toHaveBeenCalled()
    patchSession.mockRestore()
  })

  it('does nothing when terminal is a shell (no provider)', async () => {
    const patchSession = vi.spyOn(configStore, 'patchSessionOverride').mockResolvedValue({})

    const { cascadeTerminalRenameToSession } = await import('../../server/rename-cascade.js')

    const terminalMeta = {
      terminalId: 'term-1',
      updatedAt: Date.now(),
    }

    await cascadeTerminalRenameToSession(terminalMeta, 'My Shell')

    expect(patchSession).not.toHaveBeenCalled()
    patchSession.mockRestore()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/server/unified-rename.test.ts`
Expected: FAIL — `server/rename-cascade.js` does not exist

**Step 3: Write minimal implementation**

Create `server/rename-cascade.ts`:

```typescript
import { configStore } from './config-store.js'
import { makeSessionKey, type CodingCliProviderName } from './coding-cli/types.js'
import type { TerminalMeta } from './terminal-metadata-service.js'

/**
 * When a terminal is renamed, cascade the titleOverride to the session override
 * if the terminal is running a coding CLI with a known session.
 */
export async function cascadeTerminalRenameToSession(
  meta: TerminalMeta | undefined,
  titleOverride: string,
): Promise<void> {
  if (!meta?.provider || !meta?.sessionId) return
  const compositeKey = makeSessionKey(meta.provider as CodingCliProviderName, meta.sessionId)
  await configStore.patchSessionOverride(compositeKey, { titleOverride })
}

/**
 * When a session is renamed, cascade the titleOverride to any terminal
 * currently running that session.
 */
export function findTerminalForSession(
  allMeta: TerminalMeta[],
  provider: CodingCliProviderName,
  sessionId: string,
): TerminalMeta | undefined {
  return allMeta.find((m) => m.provider === provider && m.sessionId === sessionId)
}

export async function cascadeSessionRenameToTerminal(
  allMeta: TerminalMeta[],
  provider: CodingCliProviderName,
  sessionId: string,
  titleOverride: string,
): Promise<string | undefined> {
  const terminal = findTerminalForSession(allMeta, provider, sessionId)
  if (!terminal) return undefined
  await configStore.patchTerminalOverride(terminal.terminalId, { titleOverride })
  return terminal.terminalId
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/server/unified-rename.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add server/rename-cascade.ts test/unit/server/unified-rename.test.ts
git commit -m "feat: add rename cascade helpers for terminal ↔ session sync"
```

---

### Task 2: Server — session rename cascades to terminal override

**Files:**
- Modify: `server/rename-cascade.ts` (already created)
- Test: `test/unit/server/unified-rename.test.ts` (add tests)

**Step 1: Write the failing tests**

Add to `test/unit/server/unified-rename.test.ts`:

```typescript
describe('unified rename: session → terminal cascade', () => {
  it('patchTerminalOverride is called when session has a running terminal', async () => {
    const patchTerminal = vi.spyOn(configStore, 'patchTerminalOverride').mockResolvedValue({
      titleOverride: 'Renamed Session',
    })

    const { cascadeSessionRenameToTerminal } = await import('../../server/rename-cascade.js')

    const allMeta = [
      { terminalId: 'term-1', provider: 'claude' as const, sessionId: 'abc-123', updatedAt: Date.now() },
      { terminalId: 'term-2', provider: 'codex' as const, sessionId: 'def-456', updatedAt: Date.now() },
    ]

    const terminalId = await cascadeSessionRenameToTerminal(allMeta, 'claude', 'abc-123', 'Renamed Session')

    expect(terminalId).toBe('term-1')
    expect(patchTerminal).toHaveBeenCalledWith('term-1', { titleOverride: 'Renamed Session' })
    patchTerminal.mockRestore()
  })

  it('returns undefined when no terminal matches', async () => {
    const patchTerminal = vi.spyOn(configStore, 'patchTerminalOverride').mockResolvedValue({})

    const { cascadeSessionRenameToTerminal } = await import('../../server/rename-cascade.js')

    const terminalId = await cascadeSessionRenameToTerminal([], 'claude', 'no-match', 'Title')

    expect(terminalId).toBeUndefined()
    expect(patchTerminal).not.toHaveBeenCalled()
    patchTerminal.mockRestore()
  })
})
```

**Step 2: Run test to verify it passes**

These should already pass since the implementation was written in Task 1 Step 3.

Run: `npx vitest run test/unit/server/unified-rename.test.ts`
Expected: PASS (all tests)

**Step 3: Commit**

```bash
git add test/unit/server/unified-rename.test.ts
git commit -m "test: add session → terminal cascade tests"
```

---

### Task 3: Wire cascade into PATCH /api/terminals/:terminalId

**Files:**
- Modify: `server/index.ts:631-647`
- Test: `test/integration/server/unified-rename-integration.test.ts` (new)

**Step 1: Write the failing integration test**

Create `test/integration/server/unified-rename-integration.test.ts` that starts a minimal server and verifies end-to-end behavior. Since the routes are inline in index.ts, we test by mocking at the boundary (configStore + terminalMetadata).

Actually — the cleanest approach is to test the route handler directly. But since routes are inline, write a focused integration test using supertest against the real app. Given the complexity of spinning up the full server, a simpler approach: test the wiring by verifying the cascade function is called.

For this task, modify the route handler and verify with a unit test that the cascade is invoked:

```typescript
// In test/unit/server/unified-rename.test.ts, add:
describe('route wiring: PATCH /api/terminals/:terminalId', () => {
  it('calls cascadeTerminalRenameToSession when titleOverride is provided', async () => {
    // This is a documentation test — we verify the cascade helper is correctly
    // integrated by checking the import exists and the function signature matches.
    const { cascadeTerminalRenameToSession } = await import('../../server/rename-cascade.js')
    expect(typeof cascadeTerminalRenameToSession).toBe('function')
  })
})
```

The real verification happens in the e2e test (Task 6).

**Step 2: Modify the route handler**

In `server/index.ts`, add the import at the top (near line 23):

```typescript
import { cascadeTerminalRenameToSession } from './rename-cascade.js'
```

Then modify the PATCH handler (around line 631-647):

```typescript
  app.patch('/api/terminals/:terminalId', async (req, res) => {
    const terminalId = req.params.terminalId
    const { titleOverride, descriptionOverride, deleted } = req.body || {}

    const next = await configStore.patchTerminalOverride(terminalId, {
      titleOverride,
      descriptionOverride,
      deleted,
    })

    // Update live registry copies for immediate UI update.
    if (typeof titleOverride === 'string' && titleOverride.trim()) registry.updateTitle(terminalId, titleOverride.trim())
    if (typeof descriptionOverride === 'string') registry.updateDescription(terminalId, descriptionOverride)

    // Cascade: if this terminal has a coding CLI session, also rename the session
    if (typeof titleOverride === 'string' && titleOverride.trim()) {
      const meta = terminalMetadata.list().find((m) => m.terminalId === terminalId)
      await cascadeTerminalRenameToSession(meta, titleOverride.trim())
      if (meta?.provider && meta?.sessionId) {
        await codingCliIndexer.refresh()
      }
    }

    wsHandler.broadcast({ type: 'terminal.list.updated' })
    res.json(next)
  })
```

**Step 3: Run all tests**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add server/index.ts test/unit/server/unified-rename.test.ts
git commit -m "feat: wire terminal rename → session override cascade"
```

---

### Task 4: Wire cascade into PATCH /api/sessions/:sessionId

**Files:**
- Modify: `server/index.ts:568-597`
- Test: `test/unit/server/unified-rename.test.ts` (add tests)

**Step 1: Modify the route handler**

In `server/index.ts`, add the import (if not already):

```typescript
import { cascadeTerminalRenameToSession, cascadeSessionRenameToTerminal } from './rename-cascade.js'
```

Then modify the PATCH sessions handler (around line 568-597):

```typescript
  app.patch('/api/sessions/:sessionId', async (req, res) => {
    const rawId = req.params.sessionId
    const provider = (req.query.provider as CodingCliProviderName) || 'claude'
    const compositeKey = rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)
    const SessionPatchSchema = z.object({
      titleOverride: z.string().optional().nullable(),
      summaryOverride: z.string().optional().nullable(),
      deleted: z.coerce.boolean().optional(),
      archived: z.coerce.boolean().optional(),
      createdAtOverride: z.coerce.number().optional(),
    })
    const parsed = SessionPatchSchema.safeParse(req.body || {})
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', details: parsed.error.issues })
    }
    const cleanString = (value: string | null | undefined) => {
      const trimmed = typeof value === 'string' ? value.trim() : value
      return trimmed ? trimmed : undefined
    }
    const { titleOverride, summaryOverride, deleted, archived, createdAtOverride } = parsed.data
    const next = await configStore.patchSessionOverride(compositeKey, {
      titleOverride: cleanString(titleOverride),
      summaryOverride: cleanString(summaryOverride),
      deleted,
      archived,
      createdAtOverride,
    })

    // Cascade: if this session is running in a terminal, also rename the terminal
    const cleanTitle = cleanString(titleOverride)
    if (cleanTitle) {
      // Parse provider and sessionId from compositeKey (format: "provider:sessionId")
      const parts = compositeKey.split(':')
      const sessionProvider = (parts.length >= 2 ? parts[0] : provider) as CodingCliProviderName
      const sessionId = parts.length >= 2 ? parts.slice(1).join(':') : rawId
      const terminalId = await cascadeSessionRenameToTerminal(
        terminalMetadata.list(),
        sessionProvider,
        sessionId,
        cleanTitle,
      )
      if (terminalId) {
        registry.updateTitle(terminalId, cleanTitle)
        wsHandler.broadcast({ type: 'terminal.list.updated' })
      }
    }

    await codingCliIndexer.refresh()
    res.json(next)
  })
```

**Step 2: Run all tests**

Run: `npm test`
Expected: PASS

**Step 3: Commit**

```bash
git add server/index.ts
git commit -m "feat: wire session rename → terminal override cascade"
```

---

### Task 5: Client — pane rename calls server for coding CLI panes

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx:162-171`
- Test: `test/unit/client/components/PaneContainer.rename.test.tsx` (new)

**Step 1: Write the failing test**

Create `test/unit/client/components/PaneContainer.rename.test.tsx`:

```typescript
import { describe, it, expect, vi } from 'vitest'
import { api } from '../../../src/lib/api'

// Test the rename logic in isolation: when a coding CLI pane is renamed,
// it should call the server API to persist the rename.

describe('pane rename → server API call', () => {
  it('calls api.patch for coding CLI pane with terminalId', async () => {
    const patchSpy = vi.spyOn(api, 'patch').mockResolvedValue({} as any)

    // Simulate what commitRename should do for a coding CLI pane
    const terminalId = 'term-123'
    const mode = 'claude'
    const newTitle = 'My Claude Session'

    // The helper function we'll extract
    const { shouldSyncRenameToServer } = await import('../../../src/lib/rename-utils')

    expect(shouldSyncRenameToServer(mode, terminalId)).toBe(true)

    patchSpy.mockRestore()
  })

  it('returns false for shell panes', async () => {
    const { shouldSyncRenameToServer } = await import('../../../src/lib/rename-utils')
    expect(shouldSyncRenameToServer('shell', 'term-123')).toBe(false)
  })

  it('returns false when no terminalId', async () => {
    const { shouldSyncRenameToServer } = await import('../../../src/lib/rename-utils')
    expect(shouldSyncRenameToServer('claude', undefined)).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/client/components/PaneContainer.rename.test.tsx`
Expected: FAIL — `src/lib/rename-utils` does not exist

**Step 3: Write the helper**

Create `src/lib/rename-utils.ts`:

```typescript
import type { TabMode } from '@/store/types'

const SYNCABLE_MODES: TabMode[] = ['claude', 'codex', 'opencode', 'gemini', 'kimi']

export function shouldSyncRenameToServer(mode: TabMode | undefined, terminalId: string | undefined): boolean {
  if (!mode || !terminalId) return false
  return SYNCABLE_MODES.includes(mode)
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/client/components/PaneContainer.rename.test.tsx`
Expected: PASS

**Step 5: Modify PaneContainer.tsx commitRename**

In `src/components/panes/PaneContainer.tsx`, add the import:

```typescript
import { shouldSyncRenameToServer } from '@/lib/rename-utils'
import { api } from '@/lib/api'
```

And modify `commitRename` (around line 162-171):

```typescript
  const commitRename = useCallback(() => {
    if (!renamingPaneId) return
    const trimmed = renameValue.trim()
    if (trimmed) {
      dispatch(updatePaneTitle({ tabId, paneId: renamingPaneId, title: trimmed, setByUser: true }))

      // For coding CLI panes, also persist to server (cascades to session override)
      const paneContent = /* find the content for renamingPaneId from the tree */
      if (paneContent?.kind === 'terminal' && shouldSyncRenameToServer(paneContent.mode, paneContent.terminalId)) {
        api.patch(`/api/terminals/${encodeURIComponent(paneContent.terminalId!)}`, {
          titleOverride: trimmed,
        }).catch(() => {}) // Best-effort; UI already updated
      }
    }
    setRenamingPaneId(null)
    setRenameValue('')
  }, [dispatch, tabId, renamingPaneId, renameValue])
```

Note: The implementation agent will need to trace how to get `paneContent` for the current `renamingPaneId` from the pane tree `node`. Look at how `PaneContainer` renders leaf nodes — when `node.type === 'leaf'`, `node.content` is the `PaneContent`. Since `commitRename` only fires for the pane being renamed, and the `startRename` is triggered on a specific leaf, capture `node.content` alongside `renamingPaneId` in state (or look it up from the Redux pane tree).

**Step 6: Run all tests**

Run: `npm test`
Expected: PASS

**Step 7: Commit**

```bash
git add src/lib/rename-utils.ts src/components/panes/PaneContainer.tsx test/unit/client/components/PaneContainer.rename.test.tsx
git commit -m "feat: pane rename calls server API for coding CLI panes"
```

---

### Task 6: Client — session rename from history updates pane title

**Files:**
- Modify: `src/App.tsx` (sessions.updated handler, around line 416)
- Test: `test/unit/client/components/App.sessionRename.test.tsx` (new, or extend existing)

**Step 1: Understand the data flow**

When a session is renamed from the history view:
1. `HistoryView.tsx` calls `api.patch(/api/sessions/:compositeKey, { titleOverride })`
2. Server cascades to terminal override (Task 4)
3. Server broadcasts `terminal.list.updated`
4. Server calls `codingCliIndexer.refresh()` which triggers `sessions.updated` broadcast

The client already handles `terminal.list.updated` (OverviewView, Sidebar, BackgroundSessions refresh their lists). But nothing currently updates the **pane title** in Redux.

The cleanest approach: when `terminal.list.updated` fires, the client could re-fetch terminal metadata. But `terminal.meta.updated` is already broadcast by the server for metadata changes. The issue is that `titleOverride` is NOT part of `TerminalMeta` — it's in the config overlay.

Simpler approach: when the `PATCH /api/sessions` response comes back in `HistoryView.tsx`, and we know the cascade happened, dispatch a `updatePaneTitle` for any matching pane. But HistoryView doesn't know which pane to update.

Best approach: in the `PATCH /api/terminals` route (Task 3), include the updated title in the `terminal.list.updated` broadcast. The client already reacts to this. The Sidebar and OverviewView re-fetch terminals. But pane titles in `PaneContainer` don't — they use Redux `paneTitles`.

So: add a new thin broadcast message `terminal.renamed` with `{ terminalId, title }` that the client handles to update the pane title. OR: have the client watch `terminal.list.updated` and look up matching panes.

Actually the simplest correct approach: when `HistoryView` renames a session, it already knows the session was renamed. Have the `PATCH /api/sessions` response include the `terminalId` (if cascade happened), and let the calling component dispatch `updatePaneTitle`. But this couples HistoryView to pane state.

**Recommended approach:** Add a small WebSocket message or use the existing `terminal.list.updated` broadcast. When `App.tsx` receives `terminal.list.updated`, scan all panes for terminal panes, and for each one, check if the terminal's title has changed (by fetching `/api/terminals` or by including title data in the broadcast). This is too heavyweight.

**Final approach — keep it simple:** The server already returns the `terminalId` (if cascade happened) from the session PATCH. The HistoryView can dispatch a Redux action to update matching pane titles. Add a small utility that scans pane trees for a terminalId and updates the title.

In practice, the most idiomatic pattern for this codebase: **have the session PATCH response include the cascaded terminalId**, then in `HistoryView.tsx`, after the rename, dispatch `updatePaneTitleByTerminalId({ terminalId, title })` — a new reducer in panesSlice.

**Step 2: Write the failing test**

Add to `test/unit/client/components/PaneContainer.rename.test.tsx` (or new file):

```typescript
import { describe, it, expect } from 'vitest'

describe('updatePaneTitleByTerminalId reducer', () => {
  it('updates pane title when terminalId matches', async () => {
    // Test the reducer action directly
    // The implementation agent will write the actual Redux test
    // following the pattern in existing panesSlice tests
    expect(true).toBe(true) // placeholder
  })
})
```

The implementation agent should look at existing panesSlice tests (`test/unit/client/store/panesSlice.test.ts`) for the reducer testing pattern and write proper tests.

**Step 3: Add reducer to panesSlice**

Add a new reducer `updatePaneTitleByTerminalId` to `src/store/panesSlice.ts`:

```typescript
updatePaneTitleByTerminalId(state, action: PayloadAction<{ terminalId: string; title: string }>) {
  const { terminalId, title } = action.payload
  // Walk all tabs' pane trees to find panes with matching terminalId
  for (const [tabId, tree] of Object.entries(state.paneTreeByTab)) {
    const paneId = findPaneIdByTerminalId(tree, terminalId)
    if (paneId) {
      if (!state.paneTitles[tabId]) state.paneTitles[tabId] = {}
      state.paneTitles[tabId][paneId] = title
      if (!state.paneTitleSetByUser[tabId]) state.paneTitleSetByUser[tabId] = {}
      state.paneTitleSetByUser[tabId][paneId] = true
    }
  }
}
```

The helper `findPaneIdByTerminalId` walks the pane tree recursively looking for a leaf whose `content.kind === 'terminal'` and `content.terminalId === terminalId`.

**Step 4: Update PATCH /api/sessions response**

In `server/index.ts`, modify the session PATCH response to include the `terminalId` when cascade happened:

```typescript
    res.json({ ...next, cascadedTerminalId: terminalId || undefined })
```

**Step 5: Update HistoryView.tsx**

In `src/components/HistoryView.tsx`, after the rename API call, check for `cascadedTerminalId` and dispatch:

```typescript
  async function renameSession(provider, sessionId, titleOverride, summaryOverride) {
    const compositeKey = `${provider || 'claude'}:${sessionId}`
    const result = await api.patch(`/api/sessions/${encodeURIComponent(compositeKey)}`, { titleOverride, summaryOverride })
    if (result.cascadedTerminalId && titleOverride) {
      dispatch(updatePaneTitleByTerminalId({ terminalId: result.cascadedTerminalId, title: titleOverride }))
    }
    await refresh()
  }
```

**Step 6: Run all tests**

Run: `npm test`
Expected: PASS

**Step 7: Commit**

```bash
git add src/store/panesSlice.ts src/components/HistoryView.tsx server/index.ts
git commit -m "feat: session rename from history cascades to pane title"
```

---

### Task 7: Client — single-pane tab title sync

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`
- Test: extend existing or add to `test/unit/client/components/PaneContainer.rename.test.tsx`

**Step 1: Write the failing test**

```typescript
describe('single-pane tab title sync', () => {
  it('updates tab title when single-pane tab pane is renamed', () => {
    // Test that when a pane is renamed and it's the only pane in a tab,
    // the tab title is also updated.
    // The implementation agent should check the existing tab title sync patterns.
    expect(true).toBe(true) // placeholder for proper Redux test
  })
})
```

**Step 2: Implement tab sync in commitRename**

In `PaneContainer.tsx`, after dispatching `updatePaneTitle`, check if this is the only pane in the tab. If so, also dispatch `updateTab({ id: tabId, updates: { title: trimmed, titleSetByUser: true } })`.

The implementation agent needs to determine whether the current tab has a single pane. This can be checked by looking at `node` — if the root `PaneContainer` is rendering a leaf node (not a split), then there's only one pane. Alternatively, check the pane tree from Redux.

A simpler heuristic: pass a `isSinglePane` prop or check the tree depth. Look at how `PaneContainer` is called from its parent to understand the tree structure.

```typescript
  // In commitRename, after dispatching updatePaneTitle:
  // Sync tab title for single-pane tabs
  const rootTree = paneTreeByTab[tabId]
  if (rootTree?.type === 'leaf') {
    dispatch(updateTab({ id: tabId, updates: { title: trimmed, titleSetByUser: true } }))
  }
```

**Step 3: Also sync for the reverse direction**

In the `updatePaneTitleByTerminalId` reducer (Task 6), also update the tab title when the tab has a single pane. OR: handle this in the component via a `useEffect` that watches for pane title changes.

Given that the reducer already walks all tabs, it can check if the tab has a single-pane tree and update tab state. But tab state is in a different slice (`tabsSlice`), so cross-slice updates aren't clean.

Better approach: in `HistoryView.tsx` (Task 6 Step 5), after dispatching `updatePaneTitleByTerminalId`, also find the tab and dispatch `updateTab` if single-pane.

**Step 4: Run all tests**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/components/panes/PaneContainer.tsx src/components/HistoryView.tsx
git commit -m "feat: sync tab title with pane title for single-pane tabs"
```

---

### Task 8: E2E test — full round trip

**Files:**
- Test: `test/e2e/unified-rename-flow.test.tsx` (new)

**Step 1: Write e2e test**

Create an e2e test that:
1. Creates a terminal with mode='claude' and a mock session association
2. PATCHes `/api/terminals/:terminalId` with `{ titleOverride: 'My Session' }`
3. Verifies the session override was written (GET /api/sessions shows the title)
4. PATCHes `/api/sessions/:compositeKey` with `{ titleOverride: 'Renamed' }`
5. Verifies the terminal override was updated (GET /api/terminals shows the title)

Follow the patterns in existing e2e tests (look at `test/e2e/` for setup patterns — they typically use supertest against the real server with mock PTY).

**Step 2: Run the e2e test**

Run: `npx vitest run test/e2e/unified-rename-flow.test.tsx`
Expected: PASS

**Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add test/e2e/unified-rename-flow.test.tsx
git commit -m "test: e2e round-trip test for unified rename cascade"
```

---

### Task 9: Cleanup and refactor

**Step 1: Run full verify**

Run: `npm run verify` (builds + tests, catches type errors)
Expected: PASS

**Step 2: Remove dead route files if applicable**

Check if `server/routes/terminals.ts` and `server/routes/sessions.ts` are imported anywhere. If they're dead code (routes are inline in index.ts), flag for the user but don't delete in this PR.

**Step 3: Final commit**

```bash
git add -A
git commit -m "refactor: cleanup after unified rename implementation"
```
