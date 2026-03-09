# Issue 163 FreshClaude Token Budget Indicator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Add the existing pane-header token budget "% used" indicator to FreshClaude panes, with the same text, math, placement, and styling as CLI terminal panes.

**Architecture:** Keep the UI path unchanged: `PaneContainer` should resolve runtime metadata for FreshClaude panes and pass it through the same `formatPaneRuntimeLabel()` / `formatPaneRuntimeTooltip()` and `Pane` header props already used by CLI panes. Resolve FreshClaude token metadata from indexed Claude sessions in `state.sessions.projects`, keyed by the live SDK session's `cliSessionId` first and the pane's persisted `resumeSessionId` second. Mirror the indexed Claude token summary shape on the client once, reuse it for both indexed sessions and terminal metadata, and do not derive percentages from SDK per-turn totals.

**Tech Stack:** TypeScript, React, Redux Toolkit, Vitest, Testing Library.

---

## Strategy Gate

- The problem to solve is header parity, not "show token counts somewhere in FreshClaude." The correct landing point is the existing pane header metadata path, not a FreshClaude-only badge inside `AgentChatView`.
- The existing CLI percent-used indicator is already defined by `formatPaneRuntimeLabel()` and `formatPaneRuntimeTooltip()` in `src/lib/format-terminal-title-meta.ts`. Reusing that path is the simplest way to guarantee identical placement and styling.
- The token semantics must come from indexed Claude session metadata, not from `sdk.result` totals. The server-side Claude session index already computes `contextTokens`, `compactThresholdTokens`, and `compactPercent`; SDK per-turn totals do not.
- This issue should land entirely on the client. The server already provides the necessary ingredients:
  - `server/sdk-bridge.ts` sends `sdk.session.init` with `cliSessionId`
  - `src/lib/sdk-message-handler.ts` stores `cliSessionId` in `agentChat`
  - `src/components/agent-chat/AgentChatView.tsx` persists `resumeSessionId`
  - `server/coding-cli/session-indexer.ts` already indexes `gitBranch`, `isDirty`, `tokenUsage`, and `sessionType`
- Keep the change focused. Do not refactor the broader session system or terminal metadata system beyond the minimum shared typing needed to cleanly reuse the existing formatter.

## Key Decisions

- Put the shared client-side token summary type in `src/lib/coding-cli-types.ts`, not in `PaneContainer` or `terminalMetaSlice`. Both indexed sessions and terminal runtime metadata are coding-CLI concepts, so the shape should live in the shared coding-CLI types module.
- `PaneContainer` is the right integration seam. It already decides pane header title, status, and runtime metadata. Extending it to support `kind: 'agent-chat'` keeps all header metadata resolution in one place.
- `AgentChatView` should remain display-only for this issue. It already owns SDK lifecycle and session tagging; pushing header logic into it would duplicate the existing pane-header abstraction.
- Pane-focused tests should mock `AgentChatView` to a trivial placeholder. The acceptance target is header metadata resolution, not the chat UI itself.
- App-level coverage should extend the existing `test/e2e/pane-header-runtime-meta-flow.test.tsx` harness instead of creating a parallel file. This keeps CLI/FreshClaude parity in one place.

## Planned Code Changes

- `src/lib/coding-cli-types.ts`
  - Add a client-side `TokenSummary` type mirroring the indexed runtime token summary already used on the server.
- `src/store/types.ts`
  - Extend `CodingCliSession` with `gitBranch`, `isDirty`, and `tokenUsage?: TokenSummary`.
- `src/store/terminalMetaSlice.ts`
  - Alias `TerminalTokenUsage` to the shared `TokenSummary` type so indexed sessions and terminal metadata use the same token shape.
- `src/lib/format-terminal-title-meta.ts`
  - Export a narrow `PaneRuntimeMeta` type containing only the fields the formatter actually reads.
  - Update the formatter signatures to accept `PaneRuntimeMeta | undefined` without changing formatting behavior.
- `src/components/panes/PaneContainer.tsx`
  - Read `state.sessions.projects` and `state.agentChat.sessions`.
  - Resolve FreshClaude pane runtime metadata from indexed Claude sessions using provider config + `cliSessionId` first + `resumeSessionId` fallback.
  - Keep `PaneHeader` usage unchanged by passing the resolved metadata through the existing formatter.
- `test/unit/client/components/panes/PaneHeader.test.tsx`
  - Lock the formatter contract to the generic pane-runtime metadata shape instead of terminal-only records.
- `test/unit/client/components/panes/PaneContainer.test.tsx`
  - Add focused unit coverage for FreshClaude header metadata resolution.
  - Add an explicit `AgentChatView` mock so the tests stay about header behavior.
- `test/e2e/pane-header-runtime-meta-flow.test.tsx`
  - Extend the existing runtime metadata parity test harness to cover FreshClaude initial render and live indexed-session updates.

### Task 1: Add Failing Header-Parity Tests

**Files:**
- Modify: `test/unit/client/components/panes/PaneHeader.test.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`

**Step 1: Make the formatter tests target generic pane runtime metadata**

In `test/unit/client/components/panes/PaneHeader.test.tsx`, update the formatter tests so they pass plain pane metadata objects instead of full `TerminalMetaRecord`s. Add one explicit FreshClaude-style assertion:

```ts
it('formats FreshClaude runtime metadata with the same label contract as CLI panes', () => {
  const meta = {
    checkoutRoot: '/home/user/code/freshell',
    cwd: '/home/user/code/freshell/.worktrees/issue-163',
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
  }

  expect(formatPaneRuntimeLabel(meta)).toBe('freshell (main*)  25%')
  expect(formatPaneRuntimeTooltip(meta)).toBe(
    'Directory: /home/user/code/freshell/.worktrees/issue-163\n' +
    'branch: main*\n' +
    'Tokens: 15/60(25% full)',
  )
})
```

This should fail at first because the formatter currently requires `TerminalMetaRecord`.

**Step 2: Prepare `PaneContainer` tests for agent-chat panes**

In `test/unit/client/components/panes/PaneContainer.test.tsx`:

- add an explicit mock for `@/components/agent-chat/AgentChatView`
- extend the local `createStore()` helper to include `sessions` and `agentChat` reducers
- allow optional preloaded `sessions` and `agentChat` state

Use a trivial mock so the tests stay focused:

```ts
vi.mock('@/components/agent-chat/AgentChatView', () => ({
  default: ({ paneId }: { paneId: string }) => (
    <div data-testid={`agent-chat-${paneId}`}>Agent Chat</div>
  ),
}))
```

**Step 3: Add a failing live-session FreshClaude header test**

In `test/unit/client/components/panes/PaneContainer.test.tsx`, add:

```ts
it('renders FreshClaude header token usage from the indexed Claude session linked by cliSessionId', () => {
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
      expandedProjects: new Set(),
      wsSnapshotReceived: true,
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

  expect(screen.getByText(/freshell \(main\*\)\s+25%/)).toBeInTheDocument()
})
```

**Step 4: Add a failing restore-path fallback test**

In the same file, add:

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
      expandedProjects: new Set(),
      wsSnapshotReceived: true,
    },
    {
      sessions: {},
      pendingCreates: {},
      availableModels: [],
    },
  )

  renderWithStore(<PaneContainer tabId="tab-1" node={node} />, store)

  expect(screen.getByText(/freshell \(main\)\s+25%/)).toBeInTheDocument()
})
```

**Step 5: Run the focused unit tests and confirm failure**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx
```

Expected:
- FAIL because `formatPaneRuntimeLabel()` / `formatPaneRuntimeTooltip()` still require `TerminalMetaRecord`
- FAIL because `PaneContainer` only resolves runtime metadata for `kind: 'terminal'`

**Step 6: Commit the failing-test checkpoint**

```bash
git add test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx
git commit -m "test(panes): cover freshclaude token budget header"
```

### Task 2: Share the Indexed Token Summary Shape and Generic Formatter Contract

**Files:**
- Modify: `src/lib/coding-cli-types.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/terminalMetaSlice.ts`
- Modify: `src/lib/format-terminal-title-meta.ts`

**Step 1: Add the shared token summary type**

In `src/lib/coding-cli-types.ts`, add:

```ts
export interface TokenSummary {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
  contextTokens?: number
  modelContextWindow?: number
  compactThresholdTokens?: number
  compactPercent?: number
}
```

Place it near the existing token/event types so the client has one canonical runtime-token shape.

**Step 2: Extend indexed session typing and reuse the shared token shape**

In `src/store/types.ts`, import `TokenSummary` and extend `CodingCliSession`:

```ts
import type { TokenSummary } from '@/lib/coding-cli-types'

export interface CodingCliSession {
  provider: CodingCliProviderName
  sessionType?: string
  sessionId: string
  projectPath: string
  createdAt?: number
  updatedAt: number
  messageCount?: number
  title?: string
  summary?: string
  firstUserMessage?: string
  cwd?: string
  gitBranch?: string
  isDirty?: boolean
  tokenUsage?: TokenSummary
  archived?: boolean
  sourceFile?: string
  isSubagent?: boolean
  isNonInteractive?: boolean
}
```

In `src/store/terminalMetaSlice.ts`, replace the inline token shape with:

```ts
import type { TokenSummary } from '@/lib/coding-cli-types'

export type TerminalTokenUsage = TokenSummary
```

**Step 3: Narrow the formatter input to pane-runtime metadata**

In `src/lib/format-terminal-title-meta.ts`, export:

```ts
import type { TokenSummary } from '@/lib/coding-cli-types'

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

Then change both formatter signatures:

```ts
export function formatPaneRuntimeLabel(meta: PaneRuntimeMeta | undefined): string | undefined
export function formatPaneRuntimeTooltip(meta: PaneRuntimeMeta | undefined): string | undefined
```

Important:
- keep `safeBasename()` unchanged
- keep the percent rounding/clamping behavior unchanged
- keep the tooltip math unchanged

**Step 4: Re-run the formatter-focused tests**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneHeader.test.tsx
```

Expected:
- PASS for the formatter contract tests
- `PaneContainer` FreshClaude tests still FAIL because pane resolution is not implemented yet

**Step 5: Commit the shared-typing checkpoint**

```bash
git add src/lib/coding-cli-types.ts src/store/types.ts src/store/terminalMetaSlice.ts src/lib/format-terminal-title-meta.ts test/unit/client/components/panes/PaneHeader.test.tsx
git commit -m "refactor(panes): share runtime token summary typing"
```

### Task 3: Resolve FreshClaude Runtime Metadata in `PaneContainer`

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`

**Step 1: Add the missing selectors**

In `src/components/panes/PaneContainer.tsx`, add selectors for:

```ts
const indexedProjects = useAppSelector((s) => s.sessions.projects)
const agentChatSessions = useAppSelector((s) => s.agentChat.sessions)
```

Keep the existing terminal metadata selectors unchanged.

**Step 2: Add narrow helper functions local to `PaneContainer`**

Add a session lookup helper:

```ts
function findIndexedSession(
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

Add the FreshClaude resolver:

```ts
function resolveAgentChatRuntimeMeta(
  indexedProjects: ProjectGroup[],
  content: AgentChatPaneContent,
  session: ChatSessionState | undefined,
): PaneRuntimeMeta | undefined {
  const provider = getAgentChatProviderConfig(content.provider)?.codingCliProvider
  const indexedSessionId = session?.cliSessionId || content.resumeSessionId
  if (!provider || !indexedSessionId) return undefined

  const indexed = findIndexedSession(indexedProjects, provider, indexedSessionId)
  if (!indexed) return undefined

  return {
    cwd: indexed.cwd,
    checkoutRoot: indexed.projectPath,
    branch: indexed.gitBranch,
    isDirty: indexed.isDirty,
    tokenUsage: indexed.tokenUsage,
  }
}
```

Important:
- prefer `session.cliSessionId` over `content.resumeSessionId`
- use `getAgentChatProviderConfig(content.provider)?.codingCliProvider`; do not hardcode `freshclaude -> claude`
- do not touch `AgentChatView`

**Step 3: Use the resolved metadata in the existing pane-header flow**

Replace the terminal-only `paneRuntimeMeta` branch with a unified branch:

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
      ? resolveAgentChatRuntimeMeta(
          indexedProjects,
          node.content,
          node.content.sessionId ? agentChatSessions[node.content.sessionId] : undefined,
        )
      : undefined
```

Keep the existing formatter usage unchanged:

```ts
const paneMetaLabel = paneRuntimeMeta ? formatPaneRuntimeLabel(paneRuntimeMeta) : undefined
const paneMetaTooltip = paneRuntimeMeta ? formatPaneRuntimeTooltip(paneRuntimeMeta) : undefined
```

**Step 4: Re-run the focused unit tests**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx
```

Expected:
- PASS

**Step 5: Commit the implementation checkpoint**

```bash
git add src/components/panes/PaneContainer.tsx test/unit/client/components/panes/PaneContainer.test.tsx
git commit -m "feat(panes): show freshclaude token budget in header"
```

### Task 4: Add App-Level FreshClaude Parity Coverage

**Files:**
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

**Step 1: Extend the existing e2e harness for agent-chat panes**

In `test/e2e/pane-header-runtime-meta-flow.test.tsx`:

- add `agentChatReducer` to the store
- add a lightweight `AgentChatView` mock
- extend `createStore()` so it can optionally build a FreshClaude tab/pane and preload `agentChat`
- make `/api/sessions` mocking robust to the paginated client call by checking `url.startsWith('/api/sessions')`

Use:

```ts
vi.mock('@/components/agent-chat/AgentChatView', () => ({
  default: ({ paneId }: { paneId: string }) => <div data-testid={`agent-chat-${paneId}`}>Agent Chat</div>,
}))
```

And prefer:

```ts
if (typeof url === 'string' && url.startsWith('/api/sessions')) {
  return Promise.resolve({ projects: [] })
}
```

so the test keeps working whether the app calls `/api/sessions` or `/api/sessions?limit=100`.

**Step 2: Add a FreshClaude initial-render parity test**

Add:

```ts
it('renders the same percent-used header indicator for a FreshClaude pane backed by indexed Claude metadata', async () => {
  const store = createStore({
    freshClaudeTab: {
      id: 'tab-fresh',
      createRequestId: 'req-fresh',
      title: 'FreshClaude Tab',
      status: 'running',
      mode: 'claude',
      createdAt: Date.now(),
      codingCliProvider: 'claude',
    },
    freshClaudePane: {
      kind: 'agent-chat',
      provider: 'freshclaude',
      createRequestId: 'req-fresh',
      sessionId: 'sdk-session-1',
      status: 'idle',
    },
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
    },
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
    expect(screen.getByText(/freshell \(main\*\)\s+25%/)).toBeInTheDocument()
  })
})
```

**Step 3: Add a live indexed-session update assertion**

In the same test, emit a patch after initial render:

```ts
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
  expect(screen.getByText(/freshell \(main\*\)\s+50%/)).toBeInTheDocument()
})
```

This is the right app-level assertion because FreshClaude header metadata is supposed to follow indexed Claude session updates, not SDK `turnResult` totals.

**Step 4: Run the focused e2e file**

Run:

```bash
npm test -- test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected:
- PASS

**Step 5: Commit the parity-coverage checkpoint**

```bash
git add test/e2e/pane-header-runtime-meta-flow.test.tsx
git commit -m "test(app): cover freshclaude header token parity"
```

### Task 5: Final Verification

**Files:**
- No planned source edits

**Step 1: Run the focused FreshClaude/CLI header suites together**

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

**Step 3: Commit only if verification required follow-up fixes**

```bash
git add -A
git commit -m "chore: verify freshclaude token budget indicator"
```

## Notes for the Implementer

- Do not add any new SDK usage fields to `agentChatSlice` for this issue. The accepted source of truth is indexed Claude session metadata in the sessions store.
- Do not add new server endpoints or new WebSocket messages unless a test proves the required IDs are genuinely missing. Based on the current code, they are not missing.
- Do not special-case formatting for FreshClaude. If the formatter or header needs branching, the design is wrong.
- `docs/index.html` does not need an update for this issue. This is a small parity fix inside an existing header pattern, not a significant new UI flow.
