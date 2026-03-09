# Issue 163 FreshClaude Token Budget Indicator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Add the same pane-header token budget percent-used indicator to FreshClaude panes that CLI terminal panes already show.

**Architecture:** Reuse the existing pane-header metadata path instead of inventing a FreshClaude-only badge. Resolve FreshClaude runtime metadata from the indexed Claude sessions already stored in `sessions.projects`, preferring the live SDK-linked `cliSessionId` and falling back to the persisted `resumeSessionId`, then feed that metadata through the existing pane-header formatter and `PaneHeader` props so label text, tooltip math, placement, and styling stay identical to CLI panes.

**Tech Stack:** TypeScript, React, Redux Toolkit, Vitest, Testing Library.

---

## Strategy Gate

- The actual requirement is header parity with CLI panes, not “show token usage somewhere in the FreshClaude UI.” The correct landing point is the existing `PaneHeader` `metaLabel` / `metaTooltip` path already used by terminals.
- The user explicitly asked to use the same Claude session metadata semantics that already power CLI token percentages. That means the source of truth is indexed Claude session metadata from `sessions.projects`, not `sdk.result` totals in `agentChatSlice`.
- The identified seams already provide the identities needed for that lookup:
  - `server/sdk-bridge.ts` emits `sdk.session.init` with `cliSessionId`
  - `src/lib/sdk-message-handler.ts` forwards that into Redux
  - `src/store/agentChatSlice.ts` stores `cliSessionId`
  - `src/components/agent-chat/AgentChatView.tsx` persists it as `resumeSessionId`
  - `server/coding-cli/session-indexer.ts` already indexes Claude `gitBranch`, `isDirty`, and `tokenUsage`
- Do not add a parallel FreshClaude formatter or a FreshClaude-specific header widget. Reuse `formatPaneRuntimeLabel()` and `formatPaneRuntimeTooltip()`.
- Do not add new server plumbing unless a failing test proves the client cannot see the already-indexed metadata. This issue should land as a client-side integration change.
- Keep the typing change tight. Introduce one shared runtime token-usage type on the client, and make the formatter accept a minimal pane-runtime metadata shape. Update the existing formatter tests to use that minimal shape so the type narrowing is real, not nominal.

## Acceptance Mapping

- FreshClaude panes display the same percent-used indicator in the pane header because `PaneContainer` resolves runtime metadata for `kind: 'agent-chat'` panes and passes it through the existing `metaLabel` / `metaTooltip` props.
- The displayed percentage matches CLI panes because both paths use the same formatter against the same `compactPercent`, `contextTokens`, and `compactThresholdTokens` semantics.
- Live FreshClaude panes work because runtime metadata resolution prefers the active SDK session’s `cliSessionId`.
- Restored FreshClaude panes work before reattach because runtime metadata resolution falls back to `resumeSessionId`.
- Placement and styling match the existing CLI implementation because `PaneHeader` remains unchanged.

## Planned Code Changes

- `src/store/types.ts`
  - Add a shared client-side runtime token usage type.
  - Extend `CodingCliSession` with `gitBranch`, `isDirty`, and `tokenUsage`.
- `src/store/terminalMetaSlice.ts`
  - Reuse the shared runtime token usage type so terminal metadata and indexed session metadata stay structurally aligned.
- `src/lib/format-terminal-title-meta.ts`
  - Export a minimal `PaneRuntimeMeta` shape containing only the fields the formatter actually reads.
  - Keep formatting behavior unchanged.
- `src/components/panes/PaneContainer.tsx`
  - Read `sessions.projects` and `agentChat.sessions`.
  - Resolve FreshClaude runtime metadata from indexed sessions using provider config plus `cliSessionId` first and `resumeSessionId` second.
  - Pass the resolved metadata through the existing formatter and existing `Pane` props.
- `test/unit/client/components/panes/PaneContainer.test.tsx`
  - Add FreshClaude header resolution coverage for both live and restored lookup paths.
  - Expand the test store helper to include `sessions` and `agentChat`.
- `test/unit/client/components/panes/PaneHeader.test.tsx`
  - Update the existing formatter tests to use the new minimal `PaneRuntimeMeta` contract instead of terminal-only records.
  - Add one explicit parity fixture representing session-index-derived FreshClaude metadata.
- `test/e2e/pane-header-runtime-meta-flow.test.tsx`
  - Add app-level parity coverage proving a FreshClaude pane gets the same header indicator and updates when indexed sessions change.

### Task 1: Add Failing Unit Tests For FreshClaude Header Resolution

**Files:**
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/components/panes/PaneHeader.test.tsx`

**Step 1: Expand the unit-test store helper for FreshClaude state**

In `test/unit/client/components/panes/PaneContainer.test.tsx`, extend `createStore()` so the reducer includes:

```ts
sessions: sessionsReducer,
agentChat: agentChatReducer,
```

and the preloaded state includes:

```ts
sessions: {
  projects: [],
  expandedProjects: new Set(),
  wsSnapshotReceived: false,
},
agentChat: {
  sessions: {},
  pendingCreates: {},
  availableModels: [],
},
```

Keep the existing terminal-focused defaults unchanged so current tests stay readable.

**Step 2: Add a failing live-session test keyed by `cliSessionId`**

In `test/unit/client/components/panes/PaneContainer.test.tsx`, add:

```ts
it('renders FreshClaude pane header token usage from the indexed Claude session linked by cliSessionId', () => {
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
    },
    [
      {
        projectPath: '/home/user/code/freshell',
        sessions: [
          {
            provider: 'claude',
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
  )

  renderWithStore(<PaneContainer tabId="tab-1" node={node} />, store)

  expect(screen.getByText(/freshell \(main\*\)\s+25%/)).toBeInTheDocument()
})
```

This is the primary requirement: the header must be driven by indexed Claude session metadata, keyed by the live SDK session identity.

**Step 3: Add a failing restored-pane fallback test keyed by `resumeSessionId`**

In the same file, add:

```ts
it('falls back to resumeSessionId for FreshClaude panes before the SDK session reattaches', () => {
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
    { sessions: {} },
    [
      {
        projectPath: '/home/user/code/freshell',
        sessions: [
          {
            provider: 'claude',
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
  )

  renderWithStore(<PaneContainer tabId="tab-1" node={node} />, store)

  expect(screen.getByText(/freshell \(main\)\s+25%/)).toBeInTheDocument()
})
```

**Step 4: Update the formatter tests to the real generic contract**

Do not bolt on a redundant formatter test while leaving the old terminal-only fixtures behind. In `test/unit/client/components/panes/PaneHeader.test.tsx`:

- Replace the existing formatter callsites that pass `terminalId`, `provider`, and `updatedAt` with a shared minimal fixture:

```ts
const runtimeMeta = {
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
}
```

- Keep the existing parity assertions, but run them against that generic shape.
- Add one explicit assertion naming the FreshClaude source semantics:

```ts
it('formats session-index-derived FreshClaude metadata with the same label and tooltip contract as CLI panes', () => {
  expect(formatPaneRuntimeLabel(runtimeMeta)).toBe('freshell (main*)  25%')
  expect(formatPaneRuntimeTooltip(runtimeMeta)).toBe(
    'Directory: /home/user/freshell/.worktrees/issue-163\n' +
    'branch: main*\n' +
    'Tokens: 15/60(25% full)',
  )
})
```

This matters because the implementation will narrow the formatter input type; the tests must validate that narrowed contract instead of accidentally depending on terminal-only fields.

**Step 5: Run the focused unit tests and confirm failure**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneHeader.test.tsx
```

Expected:
- FAIL because `PaneContainer` currently resolves runtime metadata only for terminal panes.

**Step 6: Commit the failing-test checkpoint**

```bash
git add test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneHeader.test.tsx
git commit -m "test(panes): cover freshclaude token budget header"
```

### Task 2: Implement Shared FreshClaude Runtime Metadata Resolution

**Files:**
- Modify: `src/store/types.ts`
- Modify: `src/store/terminalMetaSlice.ts`
- Modify: `src/lib/format-terminal-title-meta.ts`
- Modify: `src/components/panes/PaneContainer.tsx`

**Step 1: Add a shared runtime token usage type to the client store types**

In `src/store/types.ts`, add:

```ts
export interface RuntimeTokenUsage {
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

Then extend `CodingCliSession`:

```ts
export interface CodingCliSession {
  ...
  gitBranch?: string
  isDirty?: boolean
  tokenUsage?: RuntimeTokenUsage
  ...
}
```

This is the smallest client typing change that makes indexed session metadata usable without inventing a second shape.

**Step 2: Reuse that type from terminal metadata**

In `src/store/terminalMetaSlice.ts`, replace the inline token type with:

```ts
import type { CodingCliProviderName, RuntimeTokenUsage } from './types'

export type TerminalTokenUsage = RuntimeTokenUsage
```

Do not change the runtime shape of terminal metadata.

**Step 3: Narrow the formatter input to a true pane-runtime shape**

In `src/lib/format-terminal-title-meta.ts`, export:

```ts
export type PaneRuntimeMeta = {
  cwd?: string
  checkoutRoot?: string
  repoRoot?: string
  displaySubdir?: string
  branch?: string
  isDirty?: boolean
  tokenUsage?: TerminalMetaRecord['tokenUsage']
}
```

and update both formatters to accept `PaneRuntimeMeta | undefined`.

Important:
- Do not change formatting behavior.
- Do not duplicate token math.
- Keep `safeBasename()` and tooltip percent fallback exactly as they are today.

**Step 4: Resolve agent-chat runtime metadata in `PaneContainer`**

In `src/components/panes/PaneContainer.tsx`, add selectors for:

```ts
const indexedProjects = useAppSelector((s) => s.sessions.projects)
const agentChatSessions = useAppSelector((s) => s.agentChat.sessions)
```

Add small local helpers:

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

Then replace the terminal-only runtime metadata branch with a unified one:

```ts
const paneRuntimeMeta =
  node.content.kind === 'terminal'
    ? resolvePaneRuntimeMeta(...)
    : node.content.kind === 'agent-chat'
      ? resolveAgentChatRuntimeMeta(
          indexedProjects,
          node.content,
          node.content.sessionId ? agentChatSessions[node.content.sessionId] : undefined,
        )
      : undefined
```

Important implementation constraints:
- Prefer `session.cliSessionId` over `resumeSessionId`.
- Use `codingCliProvider` from provider config instead of hardcoding FreshClaude.
- Do not move header rendering into `AgentChatView`.
- Do not add server or websocket changes for this issue.

**Step 5: Re-run the focused unit tests**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneHeader.test.tsx
```

Expected:
- PASS

**Step 6: Commit the implementation checkpoint**

```bash
git add src/store/types.ts src/store/terminalMetaSlice.ts src/lib/format-terminal-title-meta.ts src/components/panes/PaneContainer.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneHeader.test.tsx
git commit -m "feat(panes): show freshclaude token budget in pane header"
```

### Task 3: Add App-Level Parity Coverage Through The Real Client Message Flow

**Files:**
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

**Step 1: Extend the e2e test harness for agent-chat panes**

Update the local `createStore()` helper so the reducer includes `agentChat: agentChatReducer`, and allow options for:

```ts
freshTab?: Partial<Tab>
freshPane?: Partial<AgentChatPaneContent>
agentChatState?: Partial<AgentChatState>
```

Preload a FreshClaude pane like:

```ts
const freshPane: AgentChatPaneContent = {
  kind: 'agent-chat',
  provider: 'freshclaude',
  createRequestId: 'req-fresh',
  sessionId: 'sdk-session-1',
  status: 'starting',
  initialCwd: '/home/user/code/freshell',
  ...(options?.freshPane || {}),
}
```

Keep the existing codex/claude terminal test intact; this file should now cover both terminal and FreshClaude paths.

**Step 2: Add an app-level FreshClaude parity test that exercises `sdk.session.init`**

In `test/e2e/pane-header-runtime-meta-flow.test.tsx`, add:

```ts
it('renders and updates the same percent-used pane header indicator for FreshClaude sessions backed by indexed Claude metadata', async () => {
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
    if (url === '/api/sessions?limit=100') {
      return Promise.resolve([
        {
          projectPath: '/home/user/code/freshell',
          sessions: [
            {
              provider: 'claude',
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
      ])
    }
    return Promise.resolve({})
  })

  const store = createStore({
    freshTab: {
      id: 'tab-fresh',
      createRequestId: 'req-fresh',
      title: 'FreshClaude Tab',
      status: 'running',
      mode: 'claude',
      createdAt: Date.now(),
    },
    freshPane: {
      sessionId: 'sdk-session-1',
      status: 'starting',
    },
    agentChatState: {
      sessions: {
        'sdk-session-1': {
          sessionId: 'sdk-session-1',
          status: 'starting',
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
    wsMocks.emitMessage({
      type: 'sdk.session.init',
      sessionId: 'sdk-session-1',
      cliSessionId: 'claude-session-1',
      cwd: '/home/user/code/freshell/.worktrees/issue-163',
    })
  })

  await waitFor(() => {
    expect(screen.getByText(/freshell \(main\*\)\s+25%/)).toBeInTheDocument()
  })

  act(() => {
    wsMocks.emitMessage({
      type: 'sessions.updated',
      projects: [
        {
          projectPath: '/home/user/code/freshell',
          sessions: [
            {
              provider: 'claude',
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
    })
  })

  await waitFor(() => {
    expect(screen.getByText(/freshell \(main\*\)\s+50%/)).toBeInTheDocument()
  })
})
```

This is the right e2e assertion because it exercises the real client path the user asked for:

1. `sdk.session.init` establishes `cliSessionId`
2. `sessions.projects` provides indexed Claude token metadata
3. `PaneContainer` resolves the header metadata
4. later `sessions.updated` changes refresh the displayed percentage

**Step 3: Keep the test focused if the full chat UI makes it noisy**

If mounting `AgentChatView` makes the harness unstable, mock only `@/components/agent-chat/AgentChatView` to a simple placeholder in this test file. Do not mock `PaneContainer`, `Pane`, or `PaneHeader`; those are the integration surface under test.

**Step 4: Run the focused app-level test**

Run:

```bash
npm test -- test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected:
- PASS

**Step 5: Commit the parity-test checkpoint**

```bash
git add test/e2e/pane-header-runtime-meta-flow.test.tsx
git commit -m "test(app): cover freshclaude pane header token usage"
```

### Task 4: Final Verification

**Files:**
- No additional source edits expected

**Step 1: Run the focused client suites together**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneHeader.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
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

**Step 3: Commit the verification checkpoint only if verification required code changes**

```bash
git add -A
git commit -m "chore: verify freshclaude token budget indicator"
```

Only make this commit if the verification pass forced additional edits. Do not create an empty or redundant commit.

## Notes For The Implementer

- If the unit tests show that `sessions.projects` already contains `gitBranch`, `isDirty`, and `tokenUsage` at runtime but TypeScript does not, fix the client typing only. Do not add server message changes for this issue.
- If the e2e test exposes stale `/api/sessions?limit=100` mocks in this file, update only the local mock setup needed for this issue; do not refactor the broader app bootstrap.
- Keep the scope tight. No FreshClaude-specific token math, no new header component, no SDK-total approximation, and no broader terminal/session metadata refactor.
