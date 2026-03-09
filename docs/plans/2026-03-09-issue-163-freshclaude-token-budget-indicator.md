# Issue 163 FreshClaude Token Budget Indicator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use `@trycycle-executing` to implement this plan task-by-task.

**Goal:** Add the existing pane-header token budget "% used" indicator to FreshClaude panes, using the same formatting, placement, and Claude session metadata semantics already used for CLI terminal panes.

**Architecture:** Keep the display in the existing pane-header metadata flow inside `PaneContainer`. Resolve FreshClaude runtime metadata from indexed Claude sessions already stored in `state.sessions.projects`, keyed by `cliSessionId` first and `resumeSessionId` second, then feed that metadata through the existing shared label/tooltip formatter so FreshClaude and CLI panes render identical token-budget UI.

**Tech Stack:** TypeScript, React, Redux Toolkit, Vitest, Testing Library.

---

## Strategy Gate

- The problem is pane-header parity, not "show token totals somewhere in FreshClaude". The correct landing point is `PaneContainer`, because it already owns pane header metadata for CLI panes.
- The token percentage must come from indexed Claude session metadata, not SDK per-turn totals. The indexed sessions already carry `contextTokens`, `compactThresholdTokens`, and `compactPercent`; `agentChat.totalInputTokens` / `totalOutputTokens` do not.
- The server and SDK plumbing already provide the required identity chain:
  - `server/sdk-bridge.ts` emits `cliSessionId`
  - `src/lib/sdk-message-handler.ts` stores it in `agentChat`
  - `src/components/agent-chat/AgentChatView.tsx` persists it back to `resumeSessionId`
  No server changes should be made unless a test proves that identity chain is missing.
- Current code inspection shows the real gap is entirely client-side:
  - `src/components/panes/PaneContainer.tsx` only resolves runtime metadata for `kind: 'terminal'`
  - `src/lib/format-terminal-title-meta.ts` already contains the shared percent/tooltip formatting logic we want
  - `src/store/types.ts` is missing `gitBranch`, `isDirty`, and `tokenUsage` on `CodingCliSession`, even though the indexed-session payload already includes them
- Because the formatter already does the right display work, the clean path is to adapt FreshClaude onto that existing contract, not to invent a second header formatter and not to infer percentages from SDK totals.
- Keep scope tight to FreshClaude. This is not a broader token-budget refactor and not a generic agent-chat header project. The only structural cleanup worth doing is the minimum needed to let FreshClaude reuse the existing formatter without type hacks.

## Key Decisions

- Export a shared `TokenSummary` type from `shared/ws-protocol.ts` so the client sessions store can type the indexed token metadata it already receives. This avoids writing red tests that fail at TypeScript compile time before they ever reach the intended runtime assertions.
- Generalize `src/lib/format-terminal-title-meta.ts` to accept a narrow `PaneRuntimeMeta` shape instead of the richer terminal-only record. The formatting logic stays unchanged; only the input contract is narrowed to the fields the formatter actually reads.
- Resolve FreshClaude metadata by exact session identity in this order:
  - `state.agentChat.sessions[sessionId].cliSessionId`
  - `pane.content.resumeSessionId`
  No cwd heuristics and no approximation from SDK totals.
- Use `getAgentChatProviderConfig('freshclaude')?.codingCliProvider` instead of hardcoding `'claude'`, but only wire this behavior into FreshClaude panes for this issue.
- Do not extract a new cross-app selector or shared lookup utility for this issue. A small local helper in `PaneContainer` is the right scope until a second consumer exists.
- `docs/index.html` does not need an update. This is pane-header parity inside an existing UI pattern, not a new feature surface.

## Task 1: Align Runtime Metadata Typing Before Feature Tests

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/terminalMetaSlice.ts`
- Modify: `src/lib/format-terminal-title-meta.ts`
- Modify: `test/unit/client/components/panes/PaneHeader.test.tsx`

**Step 1: Run the existing formatter tests as a green baseline**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneHeader.test.tsx
```

Expected:
- PASS

This captures the current formatting behavior before the type-only refactor.

**Step 2: Export `TokenSummary` and reuse it in client session metadata**

In `shared/ws-protocol.ts`, export the inferred type immediately after `TokenSummarySchema`:

```ts
export type TokenSummary = z.infer<typeof TokenSummarySchema>
```

In `src/store/types.ts`, import that type and extend `CodingCliSession` so the client sessions store can represent the indexed Claude metadata already sent by the server:

```ts
import type { CodingCliProviderName, TokenSummary } from '@shared/ws-protocol'
```

Add these fields to `CodingCliSession`:

```ts
gitBranch?: string
isDirty?: boolean
tokenUsage?: TokenSummary
```

In `src/store/terminalMetaSlice.ts`, replace the inline token type with the shared one:

```ts
import type { TokenSummary } from '@shared/ws-protocol'

export type TerminalTokenUsage = TokenSummary
```

This step must happen before any new red tests that construct indexed sessions with `gitBranch`, `isDirty`, or `tokenUsage`.

**Step 3: Narrow the formatter input to the fields it actually consumes**

In `src/lib/format-terminal-title-meta.ts`, add:

```ts
import type { TokenSummary } from '@shared/ws-protocol'

export type PaneRuntimeMeta = {
  cwd?: string
  checkoutRoot?: string
  repoRoot?: string
  displaySubdir?: string
  branch?: string
  isDirty?: boolean
  tokenUsage?: TokenSummary
}
```

Change the function signatures to:

```ts
export function formatPaneRuntimeLabel(meta: PaneRuntimeMeta | undefined): string | undefined
export function formatPaneRuntimeTooltip(meta: PaneRuntimeMeta | undefined): string | undefined
```

Do not change the formatting logic itself in this task.

**Step 4: Update the formatter tests to lock the provider-agnostic contract**

In `test/unit/client/components/panes/PaneHeader.test.tsx`, stop depending on terminal-only fields such as `terminalId`, `provider`, and `updatedAt` in the formatter tests, and add one explicit FreshClaude-shaped assertion:

```ts
it('formats FreshClaude runtime metadata with the same label contract as CLI panes', () => {
  const label = formatPaneRuntimeLabel({
    checkoutRoot: '/home/user/freshell',
    cwd: '/home/user/freshell/.worktrees/issue-163',
    branch: 'main',
    isDirty: true,
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      totalTokens: 15,
      contextTokens: 15,
      compactThresholdTokens: 60,
      compactPercent: 25,
    },
  })

  expect(label).toBe('freshell (main*)  25%')
})
```

This is a refactor lock, not the feature test.

**Step 5: Re-run the formatter tests**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneHeader.test.tsx
```

Expected:
- PASS

**Step 6: Commit the typing/refactor checkpoint**

```bash
git add shared/ws-protocol.ts src/store/types.ts src/store/terminalMetaSlice.ts src/lib/format-terminal-title-meta.ts test/unit/client/components/panes/PaneHeader.test.tsx
git commit -m "refactor(panes): share pane runtime metadata types"
```

## Task 2: Add Failing Unit Coverage for FreshClaude Header Resolution

**Files:**
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`

**Step 1: Mock `AgentChatView` so the tests stay focused on the header**

Add:

```ts
vi.mock('@/components/agent-chat/AgentChatView', () => ({
  default: ({ paneId }: { paneId: string }) => (
    <div data-testid={`agent-chat-${paneId}`}>Agent Chat</div>
  ),
}))
```

**Step 2: Extend the unit-test store with `sessions` and `agentChat` reducers**

Import and register:

```ts
import sessionsReducer, { applySessionsPatch, type SessionsState } from '@/store/sessionsSlice'
import agentChatReducer, { turnResult } from '@/store/agentChatSlice'
import type { AgentChatState } from '@/store/agentChatTypes'
```

Update `createStore()` so it accepts `initialSessionsState` and `initialAgentChatState`, adds the reducers, and uses the middleware needed for `sessions.expandedProjects`:

```ts
middleware: (getDefault) =>
  getDefault({
    serializableCheck: {
      ignoredPaths: ['sessions.expandedProjects'],
    },
  }),
```

Preload:

```ts
sessions: {
  projects: [],
  expandedProjects: new Set(),
  wsSnapshotReceived: true,
  ...initialSessionsState,
},
agentChat: {
  sessions: {},
  pendingCreates: {},
  availableModels: [],
  ...initialAgentChatState,
},
```

**Step 3: Add a failing `cliSessionId`-first test that rejects SDK-total fallback**

Add:

```ts
it('renders FreshClaude header token usage from the indexed Claude session linked by cliSessionId and does not approximate from SDK totals', () => {
  const node: PaneNode = {
    type: 'leaf',
    id: 'pane-fresh',
    content: {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-fresh',
      sessionId: 'sdk-session-1',
      status: 'idle',
    },
  }

  const store = createStore(
    {
      layouts: { 'tab-1': node },
      activePane: { 'tab-1': 'pane-fresh' },
    },
    {},
    {
      projects: [
        {
          projectPath: '/home/user/code/freshell',
          sessions: [
            {
              provider: 'claude',
              sessionType: 'freshclaude',
              sessionId: 'claude-session-1',
              projectPath: '/home/user/code/freshell',
              cwd: '/home/user/code/freshell/.worktrees/issue-163',
              gitBranch: 'main',
              isDirty: true,
              updatedAt: 1,
              tokenUsage: {
                inputTokens: 10,
                outputTokens: 5,
                cachedTokens: 0,
                totalTokens: 15,
                contextTokens: 15,
                compactThresholdTokens: 60,
                compactPercent: 25,
              },
            },
          ],
        },
      ],
    },
    {
      sessions: {
        'sdk-session-1': {
          sessionId: 'sdk-session-1',
          cliSessionId: 'claude-session-1',
          status: 'idle',
          messages: [],
          streamingText: '',
          streamingActive: false,
          pendingPermissions: {},
          pendingQuestions: {},
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
      },
      pendingCreates: {},
      availableModels: [],
    },
  )

  renderWithStore(<PaneContainer tabId="tab-1" node={node} />, store)

  expect(screen.getByText(/freshell \\(main\\*\\)\\s+25%/)).toBeInTheDocument()

  store.dispatch(applySessionsPatch({
    upsertProjects: [],
    removeProjectPaths: ['/home/user/code/freshell'],
  }))
  store.dispatch(turnResult({
    sessionId: 'sdk-session-1',
    usage: { input_tokens: 999, output_tokens: 888 },
  }))

  expect(screen.queryByText(/\\d+%/)).not.toBeInTheDocument()
})
```

The final assertion matters: once indexed session metadata is removed, inflated SDK totals must not invent a percentage.

**Step 4: Add a failing `resumeSessionId` fallback test**

Add:

```ts
it('falls back to resumeSessionId for FreshClaude panes before sdk.session.init arrives', () => {
  const node: PaneNode = {
    type: 'leaf',
    id: 'pane-fresh',
    content: {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-fresh',
      status: 'starting',
      resumeSessionId: 'claude-session-restored',
    },
  }

  const store = createStore(
    {
      layouts: { 'tab-1': node },
      activePane: { 'tab-1': 'pane-fresh' },
    },
    {},
    {
      projects: [
        {
          projectPath: '/home/user/code/freshell',
          sessions: [
            {
              provider: 'claude',
              sessionType: 'freshclaude',
              sessionId: 'claude-session-restored',
              projectPath: '/home/user/code/freshell',
              cwd: '/home/user/code/freshell/.worktrees/issue-163',
              gitBranch: 'main',
              isDirty: false,
              updatedAt: 1,
              tokenUsage: {
                inputTokens: 10,
                outputTokens: 5,
                cachedTokens: 0,
                totalTokens: 15,
                contextTokens: 15,
                compactThresholdTokens: 60,
                compactPercent: 25,
              },
            },
          ],
        },
      ],
    },
    {
      sessions: {},
      pendingCreates: {},
      availableModels: [],
    },
  )

  renderWithStore(<PaneContainer tabId="tab-1" node={node} />, store)

  expect(screen.getByText(/freshell \\(main\\)\\s+25%/)).toBeInTheDocument()
})
```

**Step 5: Run the unit test file and confirm the new tests fail**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneContainer.test.tsx
```

Expected:
- FAIL
- both new FreshClaude tests fail because `PaneContainer` only resolves runtime metadata for terminal panes

**Step 6: Commit the red checkpoint**

```bash
git add test/unit/client/components/panes/PaneContainer.test.tsx
git commit -m "test(panes): cover freshclaude header metadata"
```

## Task 3: Add Failing App-Level Parity Coverage

**Files:**
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

**Step 1: Extend the app test harness so it can render a FreshClaude pane**

Import and register:

```ts
import agentChatReducer from '@/store/agentChatSlice'
import type { AgentChatState } from '@/store/agentChatTypes'
import type { AgentChatPaneContent } from '@/store/paneTypes'
```

Add a lightweight mock:

```ts
vi.mock('@/components/agent-chat/AgentChatView', () => ({
  default: ({ paneId }: { paneId: string }) => (
    <div data-testid={`agent-chat-${paneId}`}>Agent Chat</div>
  ),
}))
```

Add `agentChat: agentChatReducer` to the store reducer and preload:

```ts
agentChat: {
  sessions: {},
  pendingCreates: {},
  availableModels: [],
  ...(options?.agentChatState || {}),
},
```

Extend `createStore()` with optional `freshClaudeTab`, `freshClaudePane`, and `agentChatState` inputs. Only append the FreshClaude tab/layout when those options are provided so the existing tests stay unchanged.

**Step 2: Make the sessions API mock match the app bootstrap path**

In `beforeEach`, change the sessions mock from an exact `/api/sessions` match to:

```ts
if (typeof url === 'string' && url.startsWith('/api/sessions')) {
  return Promise.resolve({ projects: [] })
}
```

The app currently bootstraps with `/api/sessions?limit=100`.

**Step 3: Add a failing FreshClaude parity test**

Add:

```ts
it('renders and updates the same percent-used header indicator for a FreshClaude pane from indexed Claude metadata', async () => {
  const store = createStore({
    freshClaudeTab: {
      id: 'tab-fresh',
      createRequestId: 'req-fresh',
      title: 'FreshClaude Tab',
      status: 'running',
      mode: 'claude',
      createdAt: Date.now(),
    },
    freshClaudePane: {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-fresh',
      sessionId: 'sdk-session-1',
      status: 'idle',
    } satisfies AgentChatPaneContent,
    agentChatState: {
      sessions: {
        'sdk-session-1': {
          sessionId: 'sdk-session-1',
          cliSessionId: 'claude-session-1',
          status: 'idle',
          messages: [],
          streamingText: '',
          streamingActive: false,
          pendingPermissions: {},
          pendingQuestions: {},
          totalCostUsd: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
        },
      },
      pendingCreates: {},
      availableModels: [],
    } satisfies AgentChatState,
  })

  apiGet.mockImplementation((url: string) => {
    if (url === '/api/settings') {
      return Promise.resolve({
        ...defaultSettings,
        sidebar: { ...defaultSettings.sidebar, collapsed: true },
      })
    }
    if (url === '/api/platform') {
      return Promise.resolve({
        platform: 'linux',
        availableClis: { codex: true, claude: true },
      })
    }
    if (url.startsWith('/api/sessions')) {
      return Promise.resolve({
        projects: [
          {
            projectPath: '/home/user/code/freshell',
            sessions: [
              {
                provider: 'claude',
                sessionType: 'freshclaude',
                sessionId: 'claude-session-1',
                projectPath: '/home/user/code/freshell',
                cwd: '/home/user/code/freshell/.worktrees/issue-163',
                gitBranch: 'main',
                isDirty: true,
                updatedAt: 1,
                tokenUsage: {
                  inputTokens: 10,
                  outputTokens: 5,
                  cachedTokens: 0,
                  totalTokens: 15,
                  contextTokens: 15,
                  compactThresholdTokens: 60,
                  compactPercent: 25,
                },
              },
            ],
          },
        ],
      })
    }
    return Promise.resolve({})
  })

  render(
    <Provider store={store}>
      <App />
    </Provider>
  )

  await waitFor(() => {
    expect(wsMocks.connect).toHaveBeenCalled()
  })

  act(() => {
    wsMocks.emitMessage({ type: 'ready' })
  })

  await waitFor(() => {
    expect(screen.getByText(/freshell \\(main\\*\\)\\s+25%/)).toBeInTheDocument()
  })

  act(() => {
    wsMocks.emitMessage({
      type: 'sessions.patch',
      upsertProjects: [
        {
          projectPath: '/home/user/code/freshell',
          sessions: [
            {
              provider: 'claude',
              sessionType: 'freshclaude',
              sessionId: 'claude-session-1',
              projectPath: '/home/user/code/freshell',
              cwd: '/home/user/code/freshell/.worktrees/issue-163',
              gitBranch: 'main',
              isDirty: true,
              updatedAt: 2,
              tokenUsage: {
                inputTokens: 10,
                outputTokens: 5,
                cachedTokens: 0,
                totalTokens: 15,
                contextTokens: 15,
                compactThresholdTokens: 60,
                compactPercent: 50,
              },
            },
          ],
        },
      ],
      removeProjectPaths: [],
    })
  })

  await waitFor(() => {
    expect(screen.getByText(/freshell \\(main\\*\\)\\s+50%/)).toBeInTheDocument()
  })
})
```

This test proves parity at the app boundary and proves that live indexed-session updates drive the label.

**Step 4: Run the app-level test file and confirm the new test fails**

Run:

```bash
npm test -- test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected:
- FAIL
- the new FreshClaude test fails because the pane-header runtime metadata path still ignores `kind: 'agent-chat'`

**Step 5: Commit the red checkpoint**

```bash
git add test/e2e/pane-header-runtime-meta-flow.test.tsx
git commit -m "test(app): cover freshclaude header parity"
```

## Task 4: Implement FreshClaude Runtime Metadata Resolution in `PaneContainer`

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`

**Step 1: Add the selectors and empty constants for indexed sessions and agent-chat sessions**

Add:

```ts
import type { ProjectGroup, CodingCliSession } from '@/store/types'
import type { AgentChatPaneContent } from '@/store/paneTypes'
import type { ChatSessionState } from '@/store/agentChatTypes'
import type { PaneRuntimeMeta } from '@/lib/format-terminal-title-meta'
```

and:

```ts
const EMPTY_PROJECTS: ProjectGroup[] = []
const EMPTY_AGENT_CHAT_SESSIONS: Record<string, ChatSessionState> = {}
```

Then select:

```ts
const indexedProjects = useAppSelector((s) => s.sessions?.projects ?? EMPTY_PROJECTS)
const agentChatSessions = useAppSelector((s) => s.agentChat?.sessions ?? EMPTY_AGENT_CHAT_SESSIONS)
```

**Step 2: Add a local exact-match helper for indexed Claude sessions**

Add above the component:

```ts
function findIndexedSessionById(
  projects: ProjectGroup[],
  provider: CodingCliProviderName,
  sessionId: string,
): CodingCliSession | undefined {
  for (const project of projects) {
    const match = project.sessions.find((session) => (
      session.provider === provider && session.sessionId === sessionId
    ))
    if (match) return match
  }
  return undefined
}
```

**Step 3: Add a FreshClaude-specific runtime metadata resolver**

Add:

```ts
function resolveFreshClaudeRuntimeMeta(
  indexedProjects: ProjectGroup[],
  content: AgentChatPaneContent,
  session: ChatSessionState | undefined,
): PaneRuntimeMeta | undefined {
  if (content.provider !== 'freshclaude') return undefined

  const provider = getAgentChatProviderConfig(content.provider)?.codingCliProvider
  const indexedSessionId = session?.cliSessionId ?? content.resumeSessionId
  if (!provider || !indexedSessionId) return undefined

  const indexed = findIndexedSessionById(indexedProjects, provider, indexedSessionId)
  if (!indexed) return undefined

  return {
    cwd: indexed.cwd,
    checkoutRoot: indexed.projectPath,
    repoRoot: indexed.projectPath,
    branch: indexed.gitBranch,
    isDirty: indexed.isDirty,
    tokenUsage: indexed.tokenUsage,
  }
}
```

Important:
- use `cliSessionId` first
- use `resumeSessionId` second
- use indexed sessions only
- do not read `session.totalInputTokens` or `session.totalOutputTokens`

**Step 4: Wire FreshClaude panes into the existing header metadata path**

Replace the terminal-only branch with:

```ts
const paneRuntimeMeta =
  node.content.kind === 'terminal'
    ? resolvePaneRuntimeMeta(terminalMetaById, {
        terminalId: node.content.terminalId,
        tabTerminalId,
        isOnlyPane,
        provider: paneProvider,
        resumeSessionId: paneResumeSessionId,
        initialCwd: paneInitialCwd,
      })
    : node.content.kind === 'agent-chat'
      ? resolveFreshClaudeRuntimeMeta(
          indexedProjects,
          node.content,
          node.content.sessionId ? agentChatSessions[node.content.sessionId] : undefined,
        )
      : undefined
```

Keep the downstream formatter calls unchanged:

```ts
const paneMetaLabel = paneRuntimeMeta ? formatPaneRuntimeLabel(paneRuntimeMeta) : undefined
const paneMetaTooltip = paneRuntimeMeta ? formatPaneRuntimeTooltip(paneRuntimeMeta) : undefined
```

**Step 5: Run the focused feature tests**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected:
- PASS

**Step 6: Commit the feature checkpoint**

```bash
git add src/components/panes/PaneContainer.tsx
git commit -m "feat(panes): show freshclaude token budget in header"
```

## Task 5: Final Verification

**Files:**
- No planned source edits

**Step 1: Re-run the focused suite**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected:
- PASS

**Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected:
- PASS

**Step 3: Commit only if verification required follow-up edits**

```bash
git add -A
git commit -m "chore: verify freshclaude token budget indicator"
```

## Notes for the Implementer

- Do not add new WebSocket messages or server endpoints unless a failing test proves the `cliSessionId` chain is missing. The current architecture should already provide the required identifiers.
- Do not approximate a percentage from SDK per-turn totals. If indexed session metadata is unavailable, the correct behavior is to show no percent indicator.
- Do not move header logic into `AgentChatView`. It already persists `resumeSessionId`; the header remains a `PaneContainer` concern.
- Do not widen this issue into a generic token-budget overhaul. The only planned cleanups are:
  - shared `TokenSummary`
  - provider-agnostic `PaneRuntimeMeta`
  - FreshClaude runtime metadata lookup in `PaneContainer`
- `src/lib/agent-chat-utils.ts`, `src/lib/sdk-message-handler.ts`, `server/sdk-bridge.ts`, and `server/coding-cli/session-indexer.ts` are reference seams for reasoning, not planned edit targets for this issue.
