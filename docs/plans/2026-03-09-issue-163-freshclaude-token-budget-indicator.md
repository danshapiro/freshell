# Issue 163 FreshClaude Token Budget Indicator Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task.

**Goal:** Add the same pane-header token budget percent-used indicator to FreshClaude panes that CLI terminal panes already show.

**Architecture:** Reuse the existing pane-header metadata path instead of inventing a FreshClaude-only widget. Resolve FreshClaude runtime token metadata from the already-indexed Claude session records in `sessions.projects`, keyed by the SDK session's `cliSessionId` first and the persisted `resumeSessionId` second, then feed that metadata through the same formatter and `PaneHeader` props used by CLI panes. Keep the formatter input generic enough for both terminal metadata records and session-index-derived FreshClaude metadata so the percentage text, tooltip math, placement, and styling stay identical.

**Tech Stack:** TypeScript, React, Redux Toolkit, Vitest, Testing Library.

---

## Strategy Gate

- The real requirement is pane-header parity, not “show some token number somewhere in FreshClaude.” The correct landing point is the existing `PaneHeader` `metaLabel`/`metaTooltip` path.
- Do **not** derive the indicator from `sdk.result` totals in `src/store/agentChatSlice.ts`. Those totals are cumulative turn usage counts, but the existing CLI indicator is based on Claude session metadata that includes `contextTokens`, `compactThresholdTokens`, and `compactPercent`. Recomputing from SDK totals would drift from CLI behavior and violate the acceptance criteria.
- Do **not** add a parallel FreshClaude token formatter. The existing formatter in `src/lib/format-terminal-title-meta.ts` already defines the visual contract. Reuse it.
- Do **not** add new server plumbing unless a failing test proves the current client already lacks the needed identifiers. The current path is already sufficient:
  - `server/sdk-bridge.ts` emits `sdk.session.init` with `cliSessionId`
  - `src/lib/sdk-message-handler.ts` forwards that into Redux
  - `src/store/agentChatSlice.ts` stores `cliSessionId`
  - `src/components/agent-chat/AgentChatView.tsx` mirrors that into `resumeSessionId`
  - `server/coding-cli/session-indexer.ts` already computes Claude `tokenUsage`, `gitBranch`, `isDirty`, and `cwd`
- Use the existing `codingCliProvider` field in `src/lib/agent-chat-utils.ts` as the source of truth for which indexed provider backs a given agent-chat pane. Do **not** hardcode `freshclaude -> claude` inside `PaneContainer`.
- Keep the typing change tight and steady-state: share the client-side token summary shape between indexed sessions and terminal metadata, and narrow the formatter input to only the fields it actually uses.

## Acceptance Mapping

- FreshClaude panes render the percent-used indicator in the pane header because `PaneContainer` now computes runtime metadata for `kind: 'agent-chat'` panes and passes it through the existing `metaLabel`/`metaTooltip` props.
- The displayed percentage matches CLI terminal panes because both paths use `formatPaneRuntimeLabel()` and `formatPaneRuntimeTooltip()` against the same `compactPercent` / `contextTokens` / `compactThresholdTokens` semantics.
- Fresh creates and restored panes both work because runtime metadata resolution prefers the live SDK-linked `cliSessionId` and falls back to the persisted `resumeSessionId`.
- Placement and styling match the CLI implementation because `PaneHeader` is unchanged; only the metadata source expands.

## Planned Code Changes

- `src/store/types.ts`
  - Add a shared client-side runtime token usage type for indexed coding-CLI sessions.
  - Extend `CodingCliSession` with the Claude metadata fields the pane header already needs: `gitBranch`, `isDirty`, and `tokenUsage`.
- `src/store/terminalMetaSlice.ts`
  - Reuse the shared token usage type so indexed sessions and terminal metadata stay structurally aligned.
- `src/lib/format-terminal-title-meta.ts`
  - Narrow the formatter input type from “entire terminal metadata record” to a generic pane-runtime metadata shape containing only the fields the formatter reads.
- `src/components/panes/PaneContainer.tsx`
  - Read `sessions.projects` and `agentChat.sessions`.
  - Resolve FreshClaude runtime metadata from indexed sessions using provider config + `cliSessionId` / `resumeSessionId`.
  - Pass that resolved metadata through the existing formatter and existing `Pane` props.
- `test/unit/client/components/panes/PaneContainer.test.tsx`
  - Add failing unit coverage for FreshClaude pane headers using indexed Claude metadata.
  - Cover both live-session (`cliSessionId`) and restored-session (`resumeSessionId`) resolution paths.
- `test/unit/client/components/panes/PaneHeader.test.tsx`
  - Lock the formatter contract to a generic pane-runtime metadata input so FreshClaude cannot regress into a divergent label/tooltip format later.
- `test/e2e/pane-header-runtime-meta-flow.test.tsx`
  - Add an app-level parity test proving a FreshClaude pane renders and updates the same percent-used header indicator as the existing CLI path.

### Task 1: Add Failing FreshClaude Header Resolution Tests

**Files:**
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`
- Modify: `test/unit/client/components/panes/PaneHeader.test.tsx`

**Step 1: Add a failing PaneContainer test for live FreshClaude sessions**

In `test/unit/client/components/panes/PaneContainer.test.tsx`, expand the test store helper to include `sessions` and `agentChat` reducers, then add:

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

**Step 2: Add a failing PaneContainer restore-path test**

In `test/unit/client/components/panes/PaneContainer.test.tsx`, add:

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

**Step 3: Add a failing formatter test that codifies generic pane-runtime parity**

In `test/unit/client/components/panes/PaneHeader.test.tsx`, add:

```ts
it('formats session-index-derived FreshClaude metadata with the same label and tooltip contract as CLI panes', () => {
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
    'Directory: /home/user/code/freshell/.worktrees/issue-163\\n' +
    'branch: main*\\n' +
    'Tokens: 15/60(25% full)',
  )
})
```

**Step 4: Run the targeted unit tests and confirm failure**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneHeader.test.tsx
```

Expected:
- FAIL because `PaneContainer` currently only resolves runtime metadata for terminal panes, and the formatter input is still terminal-record-shaped.

**Step 5: Commit the failing-test checkpoint**

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

**Step 1: Share the client-side token usage shape**

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

In `src/store/terminalMetaSlice.ts`, replace the inline token usage definition with the shared type:

```ts
import type { CodingCliProviderName, RuntimeTokenUsage } from './types'

export type TerminalTokenUsage = RuntimeTokenUsage
```

**Step 2: Narrow the formatter to a generic pane-runtime metadata shape**

In `src/lib/format-terminal-title-meta.ts`, export a generic type:

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

Update both formatters to accept `PaneRuntimeMeta | undefined` instead of `TerminalMetaRecord | undefined`.

Important:
- Do **not** change formatting behavior.
- Do **not** move this logic into agent-chat-specific code.
- Keep `safeBasename()` and token tooltip math exactly as the CLI path uses them today.

**Step 3: Resolve FreshClaude runtime metadata from indexed sessions in `PaneContainer`**

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
  const config = getAgentChatProviderConfig(content.provider)
  const provider = config?.codingCliProvider
  const claudeSessionId = session?.cliSessionId || content.resumeSessionId
  if (!provider || !claudeSessionId) return undefined

  const indexed = findIndexedSession(indexedProjects, provider, claudeSessionId)
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

Then, in the leaf-pane render path, replace the terminal-only runtime metadata branch with a unified one:

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

Important implementation details:
- Prefer `session.cliSessionId` over `resumeSessionId`; the live SDK-linked Claude session is the freshest identity.
- Use `getAgentChatProviderConfig(content.provider)?.codingCliProvider` instead of hardcoding Claude.
- Reuse the existing `formatPaneRuntimeLabel()` and `formatPaneRuntimeTooltip()` calls unchanged after the metadata object is resolved.
- Do **not** surface the indicator inside `AgentChatView`; the header already gives the correct placement and styling.

**Step 4: Re-run the targeted unit tests**

Run:

```bash
npm test -- test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneHeader.test.tsx
```

Expected:
- PASS

**Step 5: Commit the implementation checkpoint**

```bash
git add src/store/types.ts src/store/terminalMetaSlice.ts src/lib/format-terminal-title-meta.ts src/components/panes/PaneContainer.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/panes/PaneHeader.test.tsx
git commit -m "feat(panes): show freshclaude token budget in pane header"
```

### Task 3: Add App-Level Parity Coverage for FreshClaude

**Files:**
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`

**Step 1: Add a failing app-level FreshClaude parity test**

In `test/e2e/pane-header-runtime-meta-flow.test.tsx`, extend the harness store to include `agentChat` reducer/state and add a FreshClaude tab/pane variant. Add:

```ts
it('renders the same percent-used pane header indicator for FreshClaude sessions backed by indexed Claude metadata', async () => {
  const store = createStore({
    freshTab: {
      id: 'tab-fresh',
      createRequestId: 'req-fresh',
      title: 'FreshClaude Tab',
      status: 'running',
      mode: 'claude',
      createdAt: Date.now(),
      codingCliProvider: 'claude',
    },
    freshPane: {
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
    if (url === '/api/sessions?limit=100') {
      return Promise.resolve([
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
      ])
    }
    ...
  })

  render(...)

  await waitFor(() => {
    expect(screen.getByText(/freshell \(main\*\)\s+25%/)).toBeInTheDocument()
  })
})
```

If the existing test file would become noisy by mounting the full real chat UI, mock `@/components/agent-chat/AgentChatView` to a simple placeholder in this file so the test remains focused on header behavior.

**Step 2: Add a failing update-path assertion**

In the same test, after initial render, push a sessions update that changes `compactPercent`:

```ts
act(() => {
  wsMocks.emitMessage({
    type: 'sessions.updated',
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
```

This keeps parity coverage honest: FreshClaude must react to live indexed-session updates the same way terminal panes react to `terminal.meta.updated`.

**Step 3: Run the focused e2e/header test file and confirm it passes**

Run:

```bash
npm test -- test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected:
- PASS

**Step 4: Commit**

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

**Step 3: Commit the verification checkpoint if any test-only adjustments were needed**

```bash
git add -A
git commit -m "chore: verify freshclaude token budget indicator"
```

## Notes for the Implementer

- If a test shows `sessions.projects` does not yet carry `gitBranch`, `isDirty`, or `tokenUsage` on the client even though the server emits them, fix the client typing and normalization only; do not add a new websocket message for this issue.
- If the app-level test reveals that `AgentChatView` mounting makes the harness noisy, mock only the view component, not `PaneContainer` or `PaneHeader`; the acceptance target is header integration.
- Keep the plan focused. Do **not** refactor the broader terminal metadata system, the session indexer, or the SDK bridge unless a failing test proves this issue cannot be landed cleanly without it.
