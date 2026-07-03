# Codex Stale Resume Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a Codex session in the left bar must start a fresh resume when the only matching open pane points at an exited terminal, and durable Codex terminal exits must log enough structured detail to diagnose future silent exits.

**Architecture:** Keep session identity matching centralized in `src/lib/session-utils.ts`, but make "session match" mean "reusable match" for focus/dedupe paths. Exited terminal panes still keep their session identity for display and tab metadata, but `findPaneForSession` and `findTabIdForSession` skip them so `openSessionTab` creates a new resume pane. Add one durable Codex exit lifecycle event at the terminal registry boundary so server logs include exit code, signal, terminal ID, and durable thread ID.

**Tech Stack:** React 18, Redux Toolkit, TypeScript, Vitest, Testing Library, node-pty, Freshell session lifecycle JSONL logging.

---

## Scope Check

This plan covers two tightly related parts of the same incident:

- User recovery behavior: stale exited terminal panes must not trap left-bar session opens.
- Observability: durable Codex exits must include exit code and signal in session lifecycle logs.

Do not attempt a "running but wedged Codex TUI" health detector in this plan. That is a separate product and protocol question because a running terminal can be legitimately idle, waiting for input, or blocked by upstream Codex.

## File Structure

- Modify `src/lib/session-utils.ts`
  - Owns canonical session matching. Add stale-terminal candidate detection here so all focus/dedupe callers share the same behavior.
  - Export `findStalePaneForSession` for UI logging and diagnostics without changing the existing return type of `findPaneForSession`.

- Modify `src/store/tabsSlice.ts`
  - `openSessionTab` already has the right fresh-resume path. Add a structured warning when it bypasses a stale matching pane and creates a replacement tab.

- Modify `src/components/Sidebar.tsx`
  - Continue using `findPaneForSession` for focus. After the utility skips stale panes, the existing flow will call `openSessionTab` or `addPane`.
  - Add a structured warning for split-mode stale bypasses, because split mode does not call `openSessionTab`.

- Modify `server/session-observability.ts`
  - Add a `codex_durable_terminal_exit` lifecycle event and payload builder.

- Modify `server/terminal-registry.ts`
  - Emit `codex_durable_terminal_exit` from `finishTerminalPtyExit` when a durable Codex terminal reaches final exited state.

- Modify `test/unit/client/lib/session-utils.test.ts`
  - Unit coverage for reusable-vs-stale matching.

- Modify `test/unit/client/store/tabsSlice.test.ts`
  - Store-level coverage that `openSessionTab` creates a new resume tab instead of activating an exited matching pane.

- Modify `test/e2e/sidebar-click-opens-pane.test.tsx`
  - End-user click coverage for the left bar.

- Modify `test/unit/server/session-observability.test.ts`
  - Event payload and severity coverage for durable Codex exit logs.

- Modify `test/unit/server/terminal-registry.codex-recovery.test.ts`
  - Registry integration coverage that a clean durable Codex PTY exit records the new lifecycle event without changing recovery behavior.

No README or `docs/index.html` update is needed. This is a bug fix for existing behavior and diagnostic logging, not a new end-user feature or major UI change.

---

### Task 1: Session Matching Rejects Stale Terminal Handles

**Files:**
- Modify: `src/lib/session-utils.ts`
- Test: `test/unit/client/lib/session-utils.test.ts`

- [ ] **Step 1: Extend the test helper to build exited terminal pane content**

In `test/unit/client/lib/session-utils.test.ts`, change the `terminalContent` helper signature near the top of the file to accept a status:

```ts
function terminalContent(
  mode: TerminalPaneContent['mode'],
  options: {
    resumeSessionId?: string
    sessionRef?: SessionLocator
    serverInstanceId?: string
    terminalId?: string
    status?: TerminalPaneContent['status']
  } = {},
): TerminalPaneContent {
  const identity = options.sessionRef?.sessionId ?? options.resumeSessionId ?? 'fresh'
  return {
    kind: 'terminal',
    mode,
    status: options.status ?? 'running',
    createRequestId: `req-${identity}`,
    ...(options.terminalId ? { terminalId: options.terminalId } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    ...(options.sessionRef ? { sessionRef: options.sessionRef } : {}),
    ...(options.serverInstanceId ? { serverInstanceId: options.serverInstanceId } : {}),
  }
}
```

- [ ] **Step 2: Write failing unit tests for stale terminal matching**

Append these tests to the `findPaneForSession` and `findTabIdForSession` sections in `test/unit/client/lib/session-utils.test.ts`:

```ts
it('does not focus an exited terminal pane even when it has a matching canonical sessionRef', () => {
  const state = {
    tabs: {
      activeTabId: 'tab-stale',
      tabs: [{ id: 'tab-stale' }],
    },
    panes: {
      layouts: {
        'tab-stale': leaf('pane-stale', terminalContent('codex', {
          terminalId: 'term-stale',
          status: 'exited',
          sessionRef: { provider: 'codex', sessionId: 'thread-stale' },
        })),
      },
      activePane: { 'tab-stale': 'pane-stale' },
    },
  } as unknown as RootState

  expect(findPaneForSession(state, { provider: 'codex', sessionId: 'thread-stale' })).toBeUndefined()
})

it('reports the best stale pane separately for diagnostics', () => {
  const state = {
    tabs: {
      activeTabId: 'tab-stale',
      tabs: [{ id: 'tab-stale' }],
    },
    panes: {
      layouts: {
        'tab-stale': leaf('pane-stale', terminalContent('codex', {
          terminalId: 'term-stale',
          status: 'exited',
          sessionRef: { provider: 'codex', sessionId: 'thread-stale' },
        })),
      },
      activePane: { 'tab-stale': 'pane-stale' },
    },
  } as unknown as RootState

  expect(findStalePaneForSession(state, { provider: 'codex', sessionId: 'thread-stale' })).toEqual({
    tabId: 'tab-stale',
    paneId: 'pane-stale',
    terminalId: 'term-stale',
    terminalStatus: 'exited',
  })
})
```

Append this test to the `findTabIdForSession` section:

```ts
it('does not dedupe to a matching pane when terminal directory confirms its terminal exited', () => {
  const state = {
    tabs: {
      activeTabId: 'tab-stale',
      tabs: [{ id: 'tab-stale' }],
    },
    panes: {
      layouts: {
        'tab-stale': leaf('pane-stale', terminalContent('codex', {
          terminalId: 'term-stale',
          status: 'running',
          sessionRef: { provider: 'codex', sessionId: 'thread-stale' },
        })),
      },
      activePane: { 'tab-stale': 'pane-stale' },
    },
    terminalDirectory: {
      windows: {
        sidebar: {
          items: [{
            terminalId: 'term-stale',
            title: 'Flowchart',
            createdAt: 100,
            lastActivityAt: 200,
            cwd: '/home/dan/code/skill-flowchart',
            status: 'exited',
            hasClients: false,
            mode: 'codex',
            sessionRef: { provider: 'codex', sessionId: 'thread-stale' },
          }],
          nextCursor: null,
        },
      },
      searches: {},
    },
  } as unknown as RootState

  expect(findTabIdForSession(state, { provider: 'codex', sessionId: 'thread-stale' })).toBeUndefined()
})
```

Also update the import list at the top of the test:

```ts
import {
  collectSessionLocatorsFromTabs,
  collectSessionRefsFromNode,
  collectSessionRefsFromTabs,
  findPaneForSession,
  findStalePaneForSession,
  findTabIdForSession,
  getActiveSessionRefForTab,
  getSessionsForHello,
} from '@/lib/session-utils'
```

- [ ] **Step 3: Run the unit tests and verify they fail for the right reason**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/session-utils.test.ts
```

Expected: FAIL. The first new test still returns `{ tabId: 'tab-stale', paneId: 'pane-stale' }`, and TypeScript or Vitest reports that `findStalePaneForSession` is not exported.

- [ ] **Step 4: Implement reusable-vs-stale session candidates**

In `src/lib/session-utils.ts`, update the imports:

```ts
import type { PaneContent, PaneNode } from '@/store/paneTypes'
import type { RootState } from '@/store/store'
import type { CodingCliProviderName, TerminalStatus } from '@/store/types'
```

Replace the `SessionMatchCandidate` type with:

```ts
type SessionMatchCandidate = {
  tabId: string
  paneId: string | undefined
  locator: SessionMatchLocator
  serverInstanceIdHint?: string
  hasLiveHandleHint?: boolean
  terminalId?: string
  terminalStatus?: TerminalStatus
}

export type StaleSessionPaneMatch = {
  tabId: string
  paneId: string | undefined
  terminalId: string
  terminalStatus?: TerminalStatus
}
```

Replace `extractSessionLocatorLiveHandleHint` with these helpers:

```ts
function extractSessionLocatorLiveHandleHint(content: PaneContent): boolean {
  if (content.kind === 'terminal') {
    return isNonEmptyString(content.terminalId)
      && content.status !== 'exited'
      && content.status !== 'error'
  }
  if (content.kind === 'agent-chat') {
    return isNonEmptyString(content.sessionId)
  }
  return false
}

function extractTerminalCandidateFields(content: PaneContent): {
  terminalId?: string
  terminalStatus?: TerminalStatus
} {
  if (content.kind !== 'terminal') return {}
  return {
    ...(isNonEmptyString(content.terminalId) ? { terminalId: content.terminalId } : {}),
    terminalStatus: content.status,
  }
}
```

Inside `collectPaneSessionMatchCandidates`, add `const terminalFields = extractTerminalCandidateFields(node.content)` immediately after `const explicitLocator = extractExplicitSessionLocator(node.content)`, then add `...terminalFields` to both candidate objects:

```ts
const terminalFields = extractTerminalCandidateFields(node.content)
```

For the explicit locator candidate:

```ts
candidates.push({
  tabId,
  paneId: node.id,
  locator: explicitLocator,
  serverInstanceIdHint: extractSessionLocatorServerInstanceHint(node.content),
  hasLiveHandleHint: extractSessionLocatorLiveHandleHint(node.content),
  ...terminalFields,
})
```

For the implicit locator candidate:

```ts
candidates.push({
  tabId,
  paneId: node.id,
  locator,
  serverInstanceIdHint: extractSessionLocatorServerInstanceHint(node.content),
  hasLiveHandleHint: extractSessionLocatorLiveHandleHint(node.content),
  ...terminalFields,
})
```

Add these helpers below `matchScore`:

```ts
function findKnownTerminalStatus(state: RootState, terminalId: string): 'running' | 'exited' | undefined {
  const windows = (state as Partial<RootState>).terminalDirectory?.windows
  if (!windows) return undefined

  for (const window of Object.values(windows)) {
    const match = window.items.find((item) => item.terminalId === terminalId)
    if (match) return match.status
  }
  return undefined
}

function isStaleTerminalCandidate(state: RootState, candidate: SessionMatchCandidate): boolean {
  if (!candidate.terminalId) return false
  if (candidate.terminalStatus === 'exited' || candidate.terminalStatus === 'error') return true
  return findKnownTerminalStatus(state, candidate.terminalId) === 'exited'
}
```

Replace `selectBestSessionMatch` with:

```ts
function selectBestSessionMatch(
  state: RootState,
  candidates: SessionMatchCandidate[],
  target: SessionMatchLocator,
  localServerInstanceId?: string,
  options: { staleOnly?: boolean } = {},
): SessionMatchCandidate | undefined {
  let bestCandidate: SessionMatchCandidate | undefined
  let bestScore = 0

  for (const candidate of candidates) {
    const stale = isStaleTerminalCandidate(state, candidate)
    if (options.staleOnly ? !stale : stale) continue

    const score = matchScore(candidate, target, localServerInstanceId)
    if (score <= 0) continue
    if (score > bestScore) {
      bestCandidate = candidate
      bestScore = score
    }
  }

  return bestCandidate
}
```

Update both existing callers:

```ts
return selectBestSessionMatch(state, candidates, sanitizedTarget, localServerInstanceId)?.tabId
```

and:

```ts
const bestMatch = selectBestSessionMatch(state, candidates, sanitizedTarget, localServerInstanceId)
```

In `findTabIdForSession`, preserve terminal metadata when collapsing pane-level candidates into tab-level candidates. This is the dedupe path used by `openSessionTab`; if it drops `terminalId` or `terminalStatus`, `selectBestSessionMatch` cannot detect that the only matching pane is stale. In the `for (const candidate of paneCandidates)` rebuild loop, replace the pushed object with:

```ts
candidates.push({
  tabId: candidate.tabId,
  paneId: undefined,
  locator: candidate.locator,
  serverInstanceIdHint: candidate.serverInstanceIdHint,
  hasLiveHandleHint: candidate.hasLiveHandleHint,
  terminalId: candidate.terminalId,
  terminalStatus: candidate.terminalStatus,
})
```

Add this export after `findPaneForSession`:

```ts
export function findStalePaneForSession(
  state: RootState,
  target: SessionMatchLocator,
  localServerInstanceId?: string,
): StaleSessionPaneMatch | undefined {
  const sanitizedTarget = sanitizeSessionLocator(target)
  if (!sanitizedTarget) return undefined

  const candidates: SessionMatchCandidate[] = []
  for (const tab of state.tabs.tabs) {
    const layout = state.panes.layouts[tab.id]
    if (!layout) continue
    collectPaneSessionMatchCandidates(layout, tab.id, candidates)
  }

  const bestMatch = selectBestSessionMatch(
    state,
    candidates,
    sanitizedTarget,
    localServerInstanceId,
    { staleOnly: true },
  )
  if (!bestMatch?.terminalId) return undefined
  return {
    tabId: bestMatch.tabId,
    paneId: bestMatch.paneId,
    terminalId: bestMatch.terminalId,
    terminalStatus: bestMatch.terminalStatus,
  }
}
```

- [ ] **Step 5: Run the focused unit tests and verify they pass**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/session-utils.test.ts
```

Expected: PASS. Existing tests must still pass, including local-server-instance filtering and canonical Claude ID filtering.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/lib/session-utils.ts test/unit/client/lib/session-utils.test.ts
git commit -m "fix: ignore stale terminal panes in session matching"
```

---

### Task 2: `openSessionTab` Creates a Fresh Resume Instead of Activating a Stale Pane

**Files:**
- Modify: `src/store/tabsSlice.ts`
- Test: `test/unit/client/store/tabsSlice.test.ts`

- [ ] **Step 1: Write a failing store-level test**

In `test/unit/client/store/tabsSlice.test.ts`, no import changes are needed because `addTab`, `openSessionTab`, and `initLayout` are already imported. Add this test inside `describe('openSessionTab', () => { ... })` after the existing `activates existing tab when a pane already owns the session` test:

```ts
it('creates a fresh resume tab when the only canonical match is an exited terminal pane', async () => {
  const store = createOpenSessionStore('srv-local')

  store.dispatch(addTab({
    id: 'tab-stale',
    title: 'Flowchart',
    mode: 'codex',
    status: 'exited',
    sessionRef: {
      provider: 'codex',
      sessionId: 'thread-stale',
    },
  }))
  store.dispatch(initLayout({
    tabId: 'tab-stale',
    content: {
      kind: 'terminal',
      mode: 'codex',
      createRequestId: 'req-stale',
      terminalId: 'term-stale',
      status: 'exited',
      sessionRef: {
        provider: 'codex',
        sessionId: 'thread-stale',
      },
      serverInstanceId: 'srv-local',
      initialCwd: '/home/dan/code/skill-flowchart',
    },
  }))

  await store.dispatch(openSessionTab({
    sessionId: 'thread-stale',
    provider: 'codex',
    title: 'Flowchart',
    cwd: '/home/dan/code/skill-flowchart',
    hasTitle: true,
  }))

  const state = store.getState()
  expect(state.tabs.tabs).toHaveLength(2)
  expect(state.tabs.activeTabId).not.toBe('tab-stale')

  const replacementTab = state.tabs.tabs.find((tab) => tab.id !== 'tab-stale')
  expect(replacementTab).toMatchObject({
    title: 'Flowchart',
    mode: 'codex',
    codingCliProvider: 'codex',
    initialCwd: '/home/dan/code/skill-flowchart',
    sessionRef: {
      provider: 'codex',
      sessionId: 'thread-stale',
    },
  })

  const replacementLayout = replacementTab ? state.panes.layouts[replacementTab.id] : undefined
  expect(replacementLayout?.type).toBe('leaf')
  if (replacementLayout?.type !== 'leaf') throw new Error('Expected replacement leaf layout')
  expect(replacementLayout.content).toMatchObject({
    kind: 'terminal',
    mode: 'codex',
    sessionRef: {
      provider: 'codex',
      sessionId: 'thread-stale',
    },
    initialCwd: '/home/dan/code/skill-flowchart',
  })
  expect(replacementLayout.content).not.toHaveProperty('terminalId')
})
```

- [ ] **Step 2: Run the store test and verify it fails before Task 1 implementation is present**

Run this if Task 1 has not been implemented in the current execution branch:

```bash
npm run test:vitest -- test/unit/client/store/tabsSlice.test.ts
```

Expected before Task 1 implementation: FAIL because `state.tabs.tabs` remains length `1` and active tab is `tab-stale`.

Expected after Task 1 implementation: PASS before the logging change below.

- [ ] **Step 3: Add structured stale-bypass logging to `openSessionTab`**

In `src/store/tabsSlice.ts`, change the session utility import:

```ts
import { findStalePaneForSession, findTabIdForSession } from '@/lib/session-utils'
```

Inside `openSessionTab`, immediately before creating a new tab in the no-`terminalId` path, add this block after the `if (!forceNew) { ... }` dedupe block and before `if (isAgentChatProviderName(resolvedSessionType)) {`:

```ts
    const staleMatch = !forceNew
      ? findStalePaneForSession(
          state,
          { provider: resolvedProvider, sessionId },
          localServerInstanceId,
        )
      : undefined
    if (staleMatch) {
      log.warn('open_session_bypassing_stale_terminal_pane', {
        event: 'open_session_bypassing_stale_terminal_pane',
        severity: 'warn',
        provider: resolvedProvider,
        sessionId,
        staleTabId: staleMatch.tabId,
        stalePaneId: staleMatch.paneId,
        staleTerminalId: staleMatch.terminalId,
        staleTerminalStatus: staleMatch.terminalStatus,
        openMode: 'tab',
      })
    }
```

- [ ] **Step 4: Run the focused store tests**

Run:

```bash
npm run test:vitest -- test/unit/client/store/tabsSlice.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/store/tabsSlice.ts test/unit/client/store/tabsSlice.test.ts
git commit -m "fix: start fresh resume for stale session tabs"
```

---

### Task 3: Left-Bar Click Starts a Fresh Codex Resume for an Exited Existing Pane

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Test: `test/e2e/sidebar-click-opens-pane.test.tsx`

- [ ] **Step 1: Extend the sidebar e2e store harness with terminal directory state**

In `test/e2e/sidebar-click-opens-pane.test.tsx`, add the reducer import:

```ts
import terminalDirectoryReducer from '@/store/terminalDirectorySlice'
```

In the `configureStore` reducer map inside `createStore`, add:

```ts
terminalDirectory: terminalDirectoryReducer,
```

In `preloadedState`, add:

```ts
terminalDirectory: {
  windows: {
    sidebar: {
      items: options.terminals ?? [],
      nextCursor: null,
    },
  },
  searches: {},
},
```

- [ ] **Step 2: Write the end-user click test**

Append this test to `describe('sidebar click opens pane (e2e)', () => { ... })`:

```ts
it('clicking a stopped Codex session with an exited matching pane creates a fresh resume tab', async () => {
  const codexSessionId = '019e98e5-1504-78f2-91bd-77a64b792e08'
  const projects: ProjectGroup[] = [
    {
      projectPath: '/home/dan/code/skill-flowchart',
      sessions: [
        {
          provider: 'codex',
          sessionId: codexSessionId,
          projectPath: '/home/dan/code/skill-flowchart',
          lastActivityAt: Date.now(),
          title: 'Flowchart',
          cwd: '/home/dan/code/skill-flowchart',
          isRunning: false,
        },
      ],
    },
  ]

  const store = createStore({
    projects,
    tabs: [{
      id: 'tab-stale',
      title: 'Flowchart',
      mode: 'codex',
      status: 'exited',
    }],
    activeTabId: 'tab-stale',
    panes: {
      layouts: {
        'tab-stale': {
          type: 'leaf',
          id: 'pane-stale',
          content: {
            kind: 'terminal',
            mode: 'codex',
            createRequestId: 'req-stale',
            terminalId: 'term-stale',
            status: 'exited',
            sessionRef: {
              provider: 'codex',
              sessionId: codexSessionId,
            },
            serverInstanceId: 'srv-local',
            initialCwd: '/home/dan/code/skill-flowchart',
          },
        },
      },
      activePane: { 'tab-stale': 'pane-stale' },
      paneTitles: {},
      paneTitleSetByUser: {},
    },
    terminals: [{
      terminalId: 'term-stale',
      title: 'Flowchart',
      createdAt: Date.now() - 60_000,
      lastActivityAt: Date.now() - 30_000,
      cwd: '/home/dan/code/skill-flowchart',
      status: 'exited',
      hasClients: false,
      mode: 'codex',
      sessionRef: {
        provider: 'codex',
        sessionId: codexSessionId,
      },
    }],
  })

  const { onNavigate } = renderSidebar(store)

  await act(async () => {
    vi.advanceTimersByTime(100)
  })

  const sessionButton = screen.getByText('Flowchart').closest('button')
  fireEvent.click(sessionButton!)

  const state = store.getState()
  expect(onNavigate).toHaveBeenCalledWith('terminal')
  expect(state.tabs.activeTabId).not.toBe('tab-stale')
  expect(state.tabs.tabs).toHaveLength(2)

  const replacementTab = state.tabs.tabs.find((tab) => tab.id !== 'tab-stale')
  expect(replacementTab).toMatchObject({
    title: 'Flowchart',
    mode: 'codex',
    codingCliProvider: 'codex',
    initialCwd: '/home/dan/code/skill-flowchart',
    sessionRef: {
      provider: 'codex',
      sessionId: codexSessionId,
    },
  })

  const replacementLayout = replacementTab ? state.panes.layouts[replacementTab.id] : undefined
  expect(replacementLayout?.type).toBe('leaf')
  if (replacementLayout?.type !== 'leaf') throw new Error('Expected replacement leaf layout')
  expect(replacementLayout.content).toMatchObject({
    kind: 'terminal',
    mode: 'codex',
    sessionRef: {
      provider: 'codex',
      sessionId: codexSessionId,
    },
    initialCwd: '/home/dan/code/skill-flowchart',
  })
  expect(replacementLayout.content).not.toHaveProperty('terminalId')
})
```

- [ ] **Step 3: Run the e2e test and verify it passes after Tasks 1-2**

Run:

```bash
npm run test:vitest -- test/e2e/sidebar-click-opens-pane.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Add structured split-mode stale-bypass logging**

In `src/components/Sidebar.tsx`, change the session utility import:

```ts
import { findPaneForSession, findStalePaneForSession } from '@/lib/session-utils'
```

Add a logger near the top-level constants:

```ts
import { createLogger } from '@/lib/client-logger'
```

and below the `EMPTY_*` constants:

```ts
const log = createLogger('Sidebar')
```

In `handleItemClick`, keep stale-pane diagnostics in the split path only. Tab-mode opens route through `openSessionTab`, which logs its own stale-bypass event after Tasks 1-2, and the fallback path does not add a split pane.

Immediately before the final `dispatch(addPane({ ... }))` split-mode path, add:

```ts
    const staleExisting = findStalePaneForSession(
      state,
      { provider, sessionId: item.sessionId },
      localServerInstanceId,
    )
```

Then add:

```ts
    if (staleExisting) {
      log.warn('sidebar_session_open_bypassing_stale_terminal_pane', {
        event: 'sidebar_session_open_bypassing_stale_terminal_pane',
        severity: 'warn',
        provider,
        sessionId: item.sessionId,
        staleTabId: staleExisting.tabId,
        stalePaneId: staleExisting.paneId,
        staleTerminalId: staleExisting.terminalId,
        staleTerminalStatus: staleExisting.terminalStatus,
        openMode: 'split',
      })
    }
```

Do not pass `runningTerminalId` for the stale terminal. The selector already leaves `item.isRunning` false when the terminal directory says the terminal exited.

- [ ] **Step 5: Run focused sidebar tests**

Run:

```bash
npm run test:vitest -- test/e2e/sidebar-click-opens-pane.test.tsx test/unit/client/components/Sidebar.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/components/Sidebar.tsx test/e2e/sidebar-click-opens-pane.test.tsx
git commit -m "fix: recover stale Codex sidebar resumes"
```

---

### Task 4: Durable Codex Exit Lifecycle Event

**Files:**
- Modify: `server/session-observability.ts`
- Modify: `server/terminal-registry.ts`
- Test: `test/unit/server/session-observability.test.ts`
- Test: `test/unit/server/terminal-registry.codex-recovery.test.ts`

- [ ] **Step 1: Write the session observability unit test**

Append this test to `test/unit/server/session-observability.test.ts`:

```ts
it('records durable Codex terminal exits at warn with exit diagnostics', () => {
  recordSessionLifecycleEvent({
    kind: 'codex_durable_terminal_exit',
    provider: 'codex',
    terminalId: 'term-codex',
    sessionId: 'thread-durable',
    exitCode: 0,
    signal: 0,
    ageMs: 42_000,
    reason: 'pty_exit',
    ptyPid: 12345,
  })

  expect(warn).toHaveBeenCalledTimes(1)
  expect(info).not.toHaveBeenCalled()
  expect(warn.mock.calls[0][0]).toMatchObject({
    event: 'session_lifecycle',
    kind: 'codex_durable_terminal_exit',
    provider: 'codex',
    terminalId: 'term-codex',
    sessionId: 'thread-durable',
    exitCode: 0,
    signal: 0,
    ageMs: 42_000,
    reason: 'pty_exit',
    ptyPid: 12345,
  })
  expect(warn.mock.calls[0][1]).toBe('codex_durable_terminal_exit')
})
```

- [ ] **Step 2: Run the observability test and verify it fails**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/session-observability.test.ts
```

Expected: FAIL because `codex_durable_terminal_exit` is not part of `SessionLifecycleEvent`.

- [ ] **Step 3: Add the lifecycle event type and payload**

In `server/session-observability.ts`, add this union member immediately after `terminal_exit_without_durable_session`:

```ts
  | {
    kind: 'codex_durable_terminal_exit'
    provider: 'codex'
    terminalId: string
    sessionId: string
    exitCode: number
    signal?: number
    ageMs: number
    reason: 'pty_exit' | 'user_final_close'
    ptyPid?: number
  }
```

Update `isIncidentEvent`:

```ts
function isIncidentEvent(kind: SessionLifecycleEvent['kind']): boolean {
  return kind === 'terminal_exit_without_durable_session'
    || kind === 'codex_durable_terminal_exit'
    || kind === 'invalid_terminal_id_without_session_ref'
    || kind === 'client_restore_unavailable'
    || kind === 'restore_unavailable'
}
```

Add this `buildPayload` case immediately after `terminal_exit_without_durable_session`:

```ts
    case 'codex_durable_terminal_exit':
      return {
        ...base,
        provider: event.provider,
        terminalId: event.terminalId,
        sessionId: event.sessionId,
        exitCode: event.exitCode,
        signal: event.signal,
        ageMs: event.ageMs,
        reason: event.reason,
        ptyPid: event.ptyPid,
      }
```

- [ ] **Step 4: Run the observability test and verify it passes**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/session-observability.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the terminal registry integration assertion**

In `test/unit/server/terminal-registry.codex-recovery.test.ts`, update the logger import inside the existing test file by adding this line inside the `keeps a durable Codex PTY exit final when the visible process exits cleanly` test before the registry is created:

```ts
    const { sessionLifecycleLogger } = await import('../../../server/logger.js')
```

Then append this assertion to the end of that same test:

```ts
    expect(vi.mocked(sessionLifecycleLogger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'session_lifecycle',
        kind: 'codex_durable_terminal_exit',
        provider: 'codex',
        terminalId: record.terminalId,
        sessionId: 'thread-durable-1',
        exitCode: 0,
        signal: 0,
        reason: 'pty_exit',
        ptyPid: 12345,
      }),
      'codex_durable_terminal_exit',
    )
```

- [ ] **Step 6: Run the terminal registry test and verify it fails**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/terminal-registry.codex-recovery.test.ts
```

Expected: FAIL because the registry does not emit `codex_durable_terminal_exit` yet.

- [ ] **Step 7: Emit the durable Codex exit event from the registry**

In `server/terminal-registry.ts`, add this method after `recordTerminalExitWithoutDurableSession`:

```ts
  private recordCodexDurableTerminalExit(
    record: TerminalRecord,
    event: { exitCode: number; signal?: number },
    reason: 'pty_exit' | 'user_final_close',
  ): void {
    if (record.mode !== 'codex') return
    const sessionId = record.codexDurability?.state === 'durable'
      ? record.codexDurability.durableThreadId
      : record.resumeSessionId
    if (!sessionId) return

    recordSessionLifecycleEvent({
      kind: 'codex_durable_terminal_exit',
      provider: 'codex',
      terminalId: record.terminalId,
      sessionId,
      exitCode: event.exitCode,
      signal: event.signal,
      ageMs: Math.max(0, Date.now() - record.createdAt),
      reason,
      ...(record.pty.pid ? { ptyPid: record.pty.pid } : {}),
    })
  }
```

In `finishTerminalPtyExit`, immediately after:

```ts
    this.recordTerminalExitWithoutDurableSession(record, event.exitCode, 'pty_exit')
```

add:

```ts
    this.recordCodexDurableTerminalExit(record, event, 'pty_exit')
```

In `kill`, where the code currently calls `recordTerminalExitWithoutDurableSession(term, term.exitCode, 'user_final_close')`, add:

```ts
    this.recordCodexDurableTerminalExit(term, { exitCode: term.exitCode }, 'user_final_close')
```

Do not alter recovery decisions, terminal status transitions, or sidecar release ordering.

- [ ] **Step 8: Run focused server tests**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/session-observability.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add server/session-observability.ts server/terminal-registry.ts test/unit/server/session-observability.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts
git commit -m "chore: log durable Codex terminal exits"
```

---

### Task 5: Focused Regression Sweep

**Files:**
- Verify only.

- [ ] **Step 1: Run the client-focused session recovery tests**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/session-utils.test.ts test/unit/client/store/tabsSlice.test.ts test/e2e/sidebar-click-opens-pane.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx
```

Expected: PASS. This proves stale matching, tab creation, left-bar click behavior, and existing invalid-terminal recovery contracts still hold.

- [ ] **Step 2: Run the server-focused observability and Codex recovery tests**

Run:

```bash
npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/session-observability.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/integration/server/codex-session-flow.test.ts test/server/ws-session-observability.test.ts
```

Expected: PASS. This proves the new lifecycle event does not regress Codex recovery, clean-exit finalization, or stale-terminal websocket diagnostics.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit the verification note if any test-only adjustment was needed**

If Step 1, Step 2, or Step 3 required a code or test adjustment, commit those files:

```bash
git status --short
git add src/lib/session-utils.ts src/store/tabsSlice.ts src/components/Sidebar.tsx server/session-observability.ts server/terminal-registry.ts test/unit/client/lib/session-utils.test.ts test/unit/client/store/tabsSlice.test.ts test/e2e/sidebar-click-opens-pane.test.tsx test/unit/server/session-observability.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts
git commit -m "test: cover stale Codex resume recovery"
```

If no files changed during verification, do not create an empty commit.

---

### Task 6: Broad Verification and PR Prep

**Files:**
- Verify only.

- [ ] **Step 1: Check the coordinated test gate**

Run:

```bash
npm run test:status
```

Expected: either `state: idle` or a running holder. If a holder is active, wait for it rather than killing any process.

- [ ] **Step 2: Run the coordinated full check**

Run:

```bash
FRESHELL_TEST_SUMMARY="Codex stale resume recovery" npm run check
```

Expected: PASS for typecheck, client/default suite, server suite, and electron suite.

- [ ] **Step 3: Inspect final git state**

Run:

```bash
git status --short
git log --oneline --decorate -5
```

Expected: `git status --short` prints nothing. The last commits should include:

```text
fix: ignore stale terminal panes in session matching
fix: start fresh resume for stale session tabs
fix: recover stale Codex sidebar resumes
chore: log durable Codex terminal exits
```

- [ ] **Step 4: Push and open the PR**

Run:

```bash
git push -u origin plan/codex-stale-resume-recovery
gh pr create --base main --head plan/codex-stale-resume-recovery --title "Fix stale Codex resume recovery" --body "## Summary
- skip exited terminal panes when focusing or deduping sessions
- create a fresh Codex resume from the sidebar when an old pane points at a dead terminal
- log durable Codex terminal exits with exit code, signal, terminal ID, and session ID

## Tests
- npm run test:vitest -- test/unit/client/lib/session-utils.test.ts test/unit/client/store/tabsSlice.test.ts test/e2e/sidebar-click-opens-pane.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx
- npm run test:vitest -- --config config/vitest/vitest.server.config.ts test/unit/server/session-observability.test.ts test/unit/server/terminal-registry.codex-recovery.test.ts test/integration/server/codex-session-flow.test.ts test/server/ws-session-observability.test.ts
- npm run typecheck
- FRESHELL_TEST_SUMMARY=\"Codex stale resume recovery\" npm run check"
```

Expected: PR opens against `origin/main`.

## Self-Review

- Spec coverage: The stale exited terminal pane trap is covered by Task 1 utility tests, Task 2 store behavior, and Task 3 left-bar click behavior. Durable Codex exit opacity is covered by Task 4 event tests and registry integration.
- Placeholder scan: This plan contains concrete files, code snippets, commands, and expected results. It does not rely on unspecified follow-up work.
- Type consistency: `findStalePaneForSession`, `StaleSessionPaneMatch`, `codex_durable_terminal_exit`, `terminalStatus`, and `TerminalStatus` names are used consistently across tests and implementation steps.
