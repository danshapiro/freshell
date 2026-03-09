# Issue 163 FreshClaude Token Budget Indicator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Add the existing pane-header token budget "% used" indicator to FreshClaude panes, using the same formatting, placement, and indexed Claude session semantics already used for CLI terminal panes.

**Architecture:** Keep the rendering path unchanged: `PaneContainer` should resolve runtime metadata for FreshClaude panes and pass it through the existing `formatPaneRuntimeLabel()` / `formatPaneRuntimeTooltip()` header flow. Resolve FreshClaude metadata from indexed Claude sessions in `state.sessions.projects`, preferring the live SDK session's `cliSessionId` and falling back to the pane's persisted `resumeSessionId`, and generalize the formatter input to a minimal pane-runtime metadata shape so indexed-session data can reuse the same formatter without pretending to be terminal metadata.

**Tech Stack:** TypeScript, React, Redux Toolkit, Vitest, Testing Library.

---

## Strategy Gate

- The problem is header parity, not "show some token count somewhere in FreshClaude". The correct landing point is the existing pane-header metadata flow in `PaneContainer`, not `AgentChatView`.
- The token percentage must come from indexed Claude session metadata, not `sdk.result` totals. The indexed Claude sessions already carry `contextTokens`, `compactThresholdTokens`, and `compactPercent`; the SDK per-turn totals do not.
- This should remain a no-runtime-behavior change. `server/sdk-bridge.ts` already emits `cliSessionId`, `src/lib/sdk-message-handler.ts` already stores it in `agentChat`, and `AgentChatView` already persists it back to `resumeSessionId`. The only shared-layer change needed is exporting the existing token-summary type so client state can reuse the same shape.
- Match FreshClaude to indexed sessions by exact session identity, not by cwd heuristics:
  - first `agentChat.sessions[sessionId].cliSessionId`
  - then `pane.content.resumeSessionId`
- Do not special-case formatting for FreshClaude. If the header formatter needs a provider branch, the design is wrong.

## Key Decisions

- Reuse the existing `TokenSummarySchema` shape from `shared/ws-protocol.ts` by exporting its inferred TypeScript type there, then import that type everywhere on the client. Creating a third local token-summary type would be needless drift.
- Export a narrow `PaneRuntimeMeta` formatter input type from `src/lib/format-terminal-title-meta.ts`. `TerminalMetaRecord` should remain a richer store type, but the formatter should only accept the fields it actually reads.
- Keep the FreshClaude lookup helpers local to `PaneContainer`. They are view-integration helpers, not a general store abstraction.
- Do not add any new usage fields to `agentChatSlice`. The accepted source of truth is the indexed sessions store.
- `docs/index.html` does not need an update. This is a small parity fix inside an existing pane-header pattern.

## Task 1: Add Failing Unit Coverage for FreshClaude Header Metadata

**Files:**
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`

**Step 1: Mock `AgentChatView` so the test only exercises header behavior**

Add:

```ts
vi.mock('@/components/agent-chat/AgentChatView', () => ({
  default: ({ paneId }: { paneId: string }) => (
    <div data-testid={`agent-chat-${paneId}`}>Agent Chat</div>
  ),
}))
```

This keeps the tests focused on `PaneContainer` header metadata resolution instead of SDK/chat rendering.

**Step 2: Extend the test store to include `sessions` and `agentChat` state**

Update `createStore()` so it imports and registers:

```ts
import sessionsReducer, { applySessionsPatch, type SessionsState } from '@/store/sessionsSlice'
import agentChatReducer, { turnResult } from '@/store/agentChatSlice'
import type { AgentChatState } from '@/store/agentChatTypes'
```

Use middleware mirroring the app's `Set` handling:

```ts
middleware: (getDefault) =>
  getDefault({
    serializableCheck: {
      ignoredPaths: ['sessions.expandedProjects'],
    },
  }),
```

And preload:

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

**Step 3: Add a failing `cliSessionId`-first FreshClaude test that also rejects SDK-total fallback**

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

  expect(screen.getByText(/freshell \(main\*\)\s+25%/)).toBeInTheDocument()

  store.dispatch(applySessionsPatch({
    upsertProjects: [],
    removeProjectPaths: ['/home/user/code/freshell'],
  }))
  store.dispatch(turnResult({
    sessionId: 'sdk-session-1',
    usage: { input_tokens: 999, output_tokens: 888 },
  }))

  expect(screen.queryByText(/\d+%/)).not.toBeInTheDocument()
})
```

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

  expect(screen.getByText(/freshell \(main\)\s+25%/)).toBeInTheDocument()
})
```

**Step 5: Run the unit test file and confirm the new tests fail**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneContainer.test.tsx
```

Expected:
- FAIL
- both new tests fail because `PaneContainer` only resolves runtime metadata for `kind: 'terminal'`
- the `cliSessionId` test must stay in the red suite because its first assertion requires indexed-session metadata to render

**Step 6: Commit the red checkpoint**

```bash
git add test/unit/client/components/panes/PaneContainer.test.tsx
git commit -m "test(panes): cover freshclaude header metadata"
```

## Task 2: Add Failing App-Level Parity Coverage

**Files:**
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

**Step 1: Add `agentChat` support to the app test harness**

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

**Step 2: Extend `createStore()` so it can render a FreshClaude pane**

Add optional `freshClaudeTab`, `freshClaudePane`, and `agentChatState` inputs. When `freshClaudeTab` / `freshClaudePane` are provided, append them to the tab list and layouts:

```ts
const freshClaudeTab: Tab = {
  id: 'tab-fresh',
  createRequestId: 'req-fresh',
  title: 'FreshClaude Tab',
  status: 'running',
  mode: 'claude',
  createdAt: Date.now(),
  codingCliProvider: 'claude',
  ...(options?.freshClaudeTab || {}),
}

const freshClaudePane: AgentChatPaneContent = {
  kind: 'agent-chat',
  provider: 'freshclaude',
  createRequestId: 'req-fresh',
  sessionId: 'sdk-session-1',
  status: 'idle',
  ...(options?.freshClaudePane || {}),
}
```

Only append them when the option is present so the existing tests stay unchanged.

**Step 3: Make the sessions API mock match the app's paginated bootstrap call**

In `beforeEach`, change:

```ts
if (url === '/api/sessions') {
  return Promise.resolve([])
}
```

to:

```ts
if (typeof url === 'string' && url.startsWith('/api/sessions')) {
  return Promise.resolve({ projects: [] })
}
```

The app currently bootstraps with `/api/sessions?limit=100`, so the mock must accept either form.

**Step 4: Add a failing FreshClaude parity test**

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
})
```

This is the correct app-level assertion because the indicator must track indexed-session updates, not `sdk.result` totals.

**Step 5: Run the app-level test file and confirm the new test fails**

Run:

```bash
npm test -- test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected:
- FAIL
- the new FreshClaude test fails because the header path still ignores `kind: 'agent-chat'`

**Step 6: Commit the red checkpoint**

```bash
git add test/e2e/pane-header-runtime-meta-flow.test.tsx
git commit -m "test(app): cover freshclaude header parity"
```

## Task 3: Share the Runtime Metadata Types Cleanly

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/terminalMetaSlice.ts`
- Modify: `src/lib/format-terminal-title-meta.ts`
- Modify: `test/unit/client/components/panes/PaneHeader.test.tsx`

**Step 1: Add the shared `TokenSummary` type**

In `shared/ws-protocol.ts`, export the inferred type immediately after `TokenSummarySchema`:

```ts
export type TokenSummary = z.infer<typeof TokenSummarySchema>
```

This keeps the token-summary contract anchored to the existing shared protocol schema instead of duplicating it on the client.

**Step 2: Reuse `TokenSummary` from indexed sessions and terminal metadata**

In `src/store/types.ts`, extend `CodingCliSession` with:

```ts
import type { TokenSummary } from '@shared/ws-protocol'

gitBranch?: string
isDirty?: boolean
tokenUsage?: TokenSummary
```

In `src/store/terminalMetaSlice.ts`, replace the inline token type with:

```ts
import type { TokenSummary } from '@shared/ws-protocol'

export type TerminalTokenUsage = TokenSummary
```

**Step 3: Generalize the formatter input to `PaneRuntimeMeta`**

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

Then change the function signatures to:

```ts
export function formatPaneRuntimeLabel(meta: PaneRuntimeMeta | undefined): string | undefined
export function formatPaneRuntimeTooltip(meta: PaneRuntimeMeta | undefined): string | undefined
```

Do not change any formatting logic.

**Step 4: Update the formatter tests to assert the generic contract**

In `test/unit/client/components/panes/PaneHeader.test.tsx`, remove the terminal-only fields from the formatter tests and add one explicit FreshClaude-shaped assertion:

```ts
it('formats pane runtime metadata with the same label contract for FreshClaude as CLI panes', () => {
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

This is not the red test for the feature; it is a refactor lock that proves the shared formatter contract stays provider-agnostic.

**Step 5: Run the formatter test file**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneHeader.test.tsx
```

Expected:
- PASS

**Step 6: Commit the refactor checkpoint**

```bash
git add shared/ws-protocol.ts src/store/types.ts src/store/terminalMetaSlice.ts src/lib/format-terminal-title-meta.ts test/unit/client/components/panes/PaneHeader.test.tsx
git commit -m "refactor(panes): share runtime metadata typing"
```

## Task 4: Resolve FreshClaude Runtime Metadata in `PaneContainer`

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx`

**Step 1: Add the missing selectors and empty constants**

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

**Step 2: Add a pure indexed-session lookup helper**

Add a local helper above the component:

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

Keep this helper local to `PaneContainer`; it is only needed for header metadata resolution.

**Step 3: Add the FreshClaude resolver**

Add:

```ts
function resolveAgentChatRuntimeMeta(
  indexedProjects: ProjectGroup[],
  content: AgentChatPaneContent,
  session: ChatSessionState | undefined,
): PaneRuntimeMeta | undefined {
  const provider = getAgentChatProviderConfig(content.provider)?.codingCliProvider
  const indexedSessionId = session?.cliSessionId ?? content.resumeSessionId
  if (!provider || !indexedSessionId) return undefined

  const indexed = findIndexedSessionById(indexedProjects, provider, indexedSessionId)
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
- use `cliSessionId` first
- use `resumeSessionId` second
- use provider config instead of hardcoding `freshclaude -> claude`
- do not read `session.totalInputTokens` / `session.totalOutputTokens`

**Step 4: Wire `agent-chat` panes into the existing header metadata path**

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
      ? resolveAgentChatRuntimeMeta(
          indexedProjects,
          node.content,
          node.content.sessionId ? agentChatSessions[node.content.sessionId] : undefined,
        )
      : undefined
```

Keep the downstream formatter usage unchanged:

```ts
const paneMetaLabel = paneRuntimeMeta ? formatPaneRuntimeLabel(paneRuntimeMeta) : undefined
const paneMetaTooltip = paneRuntimeMeta ? formatPaneRuntimeTooltip(paneRuntimeMeta) : undefined
```

**Step 5: Run the targeted feature tests**

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

- Do not add any new WebSocket messages or server endpoints unless a test proves the required IDs are missing. The current code already provides the needed identifiers.
- Do not derive the percentage from SDK per-turn usage totals. That would violate the user's required semantics and drift from the existing CLI token display.
- Keep `TokenSummary` single-sourced from `shared/ws-protocol.ts`. Do not create another client-only copy of the same shape.
- Do not move pane-header logic into `AgentChatView`. It already persists `resumeSessionId`; the header belongs in `PaneContainer`.
- Do not broaden this into a general token-budget refactor. The necessary cleanups are:
  - shared `TokenSummary`
  - generic `PaneRuntimeMeta`
  - FreshClaude metadata resolution in `PaneContainer`
