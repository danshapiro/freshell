# Fresh-Agent Header Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every fresh-agent pane header match coding CLI pane header structure: one left-to-right text run like `freshcodex freshell (main) 56%`, then compact controls in a stable order, with no open-terminal control and no separate `ctx` meter.

**Architecture:** Keep runtime metadata resolution in `PaneContainer` and render all header chrome in `PaneHeader`. Fresh-agent headers render no leading provider/pane icon; the lowercase `sessionType` is the leftmost visible item, followed by the same `metaLabel` produced by `formatPaneRuntimeLabel()` as CLI panes. The fresh-agent settings gear stays because it is the only pane-local style/model control, but it is ordered before optional refresh and the normal zoom/close controls.

**Tech Stack:** React 18, Redux Toolkit selectors, Vitest + Testing Library, existing lucide icon system.

## Global Constraints

- The visual target is the attached CLI-agent header: text like `freshell (main) 56%`, then compact controls.
- For fresh agents, render the lowercase session type such as `freshcodex` as the leftmost visible item and render one combined text sequence like `freshcodex freshell (main) 56%`.
- Fresh-agent headers must not show a leading pane/provider icon before `freshcodex`.
- Fresh-agent headers must not duplicate the pane title and metadata as `freshcodex freshell freshell (main) 56%`.
- Context formatting must reuse the CLI runtime metadata format and must not show `ctx`.
- Remove the fresh-agent open-terminal header button.
- Apply to all fresh-agent types: `freshclaude`, `freshcodex`, `freshopencode`, and `kilroy`.
- Preserve the fresh-agent settings gear because pane-local model/style controls still need an access point.
- Keep control ordering stable: settings gear, refresh when available, zoom, close for fresh-agent panes; existing terminal search/refresh/zoom/close order stays unchanged.
- If runtime metadata has no context percent yet, the fresh-agent header may render only the directory and branch text, but it must not fall back to a separate `ctx` meter.
- Do not restart the self-hosted Freshell server.
- Use focused tests first, then coordinated full-suite verification before completion.

---

## File Structure

- Modify `src/components/panes/PaneHeader.tsx`
  - Owns header layout for all pane kinds.
  - Render fresh-agent left text from `content.sessionType`.
  - Suppress the normal leading `PaneIcon` only for fresh-agent panes so `content.sessionType` is the leftmost visible item.
  - For fresh-agent panes, render `metaLabel ?? title` immediately after `content.sessionType`, and do not render a second metadata span in the control cluster.
  - Remove `FreshAgentToolIcons`, `FreshAgentContextMeter`, and `FreshAgentOpenTerminalButton` from the header.
  - Reorder fresh-agent controls so the settings gear appears before optional refresh, then zoom, then close.
- Modify `test/unit/client/components/panes/PaneHeader.test.tsx`
  - Adds regression coverage for fresh-agent text order, no leading pane icon, no duplicate metadata/title, no open-terminal button, no separate context meter, and control order.
  - Keeps existing CLI metadata formatter tests.
- Keep `src/components/fresh-agent/FreshAgentContextMeter.tsx` and its focused tests unchanged
  - The component is no longer used in pane headers, but deleting the component is not required to satisfy this visual change.
- No `docs/index.html` change
  - This is a pane-header consistency fix, not a new user-facing feature or major static mock change.

## Task 1: Fresh-Agent Header Contract Tests

**Files:**
- Modify: `test/unit/client/components/panes/PaneHeader.test.tsx`

**Interfaces:**
- Consumes: `PaneHeader` props `content`, `metaLabel`, `metaTooltip`, `onRefresh`, `onToggleZoom`, and `onClose`.
- Produces: failing tests that define the desired header contract before implementation.

- [ ] **Step 1: Update test mocks and stale imports**

Add an accessible settings-button stub so action order can be tested by role:

```tsx
vi.mock('@/components/fresh-agent/FreshAgentSettingsButton', () => ({
  default: () => (
    <button type="button" aria-label="Agent settings" title="Agent settings" data-testid="settings-button-stub" />
  ),
}))
```

Keep or remove the `SquareTerminal` lucide mock as needed by unchanged tests; the new fresh-agent parity test must assert that no open-terminal control renders.

Keep `sessionInit` only if the seeded negative tool-icon test uses it. Add `freshAgentSnapshotReceived` if the seeded negative context-meter test uses a snapshot payload.

- [ ] **Step 2: Replace stale fresh-agent tool-icon tests with fresh-agent parity tests**

Remove or rewrite the existing `describe('fresh-agent tool icons')` block in `PaneHeader.test.tsx`. That block currently asserts that header tool icons render from session tools; the new contract is that those tool icons do not render in the header.

Add these tests inside `describe('PaneHeader', () => { describe('rendering', () => { ... }) })`:

```tsx
it('renders fresh-agent identity as the leftmost visible header item before CLI-style metadata', () => {
  render(
    <Provider store={makeFreshAgentStore()}>
      <PaneHeader
        tabId="tab-1"
        paneId="pane-1"
        title="freshell"
        metaLabel="freshell (main)  56%"
        metaTooltip="Directory: /home/dan/code/freshell"
        status="running"
        isActive={true}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onToggleZoom={vi.fn()}
        content={{
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          sessionId: 'fresh-session-1',
          createRequestId: 'fresh-req-1',
          status: 'idle',
        }}
      />
    </Provider>,
  )

  const banner = screen.getByRole('banner', { name: 'Pane: freshell' })
  const identity = screen.getByText('freshcodex')
  const metadata = screen.getByText(/freshell \(main\)\s+56%/)

  expect(banner).toContainElement(identity)
  expect(banner).toContainElement(metadata)
  expect(screen.queryByTestId('pane-icon')).toBeNull()
  expect(screen.getAllByText(/freshell/)).toHaveLength(1)
  expect(
    identity.compareDocumentPosition(metadata) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
})

it.each([
  ['freshclaude', 'claude'],
  ['freshcodex', 'codex'],
  ['freshopencode', 'opencode'],
  ['kilroy', 'claude'],
] as const)('renders %s as the fresh-agent header identity', (sessionType, provider) => {
  render(
    <Provider store={makeFreshAgentStore()}>
      <PaneHeader
        tabId="tab-1"
        paneId="pane-1"
        title="freshell"
        metaLabel="freshell (main)  56%"
        status="running"
        isActive={true}
        onClose={vi.fn()}
        content={{
          kind: 'fresh-agent',
          sessionType,
          provider,
          sessionId: `${sessionType}-session`,
          createRequestId: `${sessionType}-req`,
          status: 'idle',
        }}
      />
    </Provider>,
  )

  expect(screen.getByText(sessionType)).toBeInTheDocument()
})

it('renders fresh-agent controls in settings refresh zoom close order without open-terminal or context-meter controls', () => {
  const store = makeFreshAgentStore()
  store.dispatch(sessionInit({
    sessionId: 'fresh-session-1',
    sessionType: 'freshcodex',
    provider: 'codex',
    tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Glob' }, { name: 'WebFetch' }],
  }))
  store.dispatch(freshAgentSnapshotReceived({
    snapshot: makeFreshAgentSnapshot({
      threadId: 'fresh-session-1',
      sessionType: 'freshcodex',
      provider: 'codex',
      tokenUsage: {
        inputTokens: 1200,
        outputTokens: 300,
        contextTokens: 1500,
        compactPercent: 56,
      },
    }),
  }))

  render(
    <Provider store={store}>
      <PaneHeader
        tabId="tab-1"
        paneId="pane-1"
        title="freshell"
        metaLabel="freshell (main)  56%"
        status="running"
        isActive={true}
        onClose={vi.fn()}
        onRefresh={vi.fn()}
        onSearch={vi.fn()}
        onToggleZoom={vi.fn()}
        content={{
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          sessionId: 'fresh-session-1',
          createRequestId: 'fresh-req-1',
          status: 'idle',
        }}
      />
    </Provider>,
  )

  const actionLabels = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') || button.getAttribute('title'))

  expect(actionLabels).toEqual([
    'Agent settings',
    'Refresh pane',
    'Maximize pane',
    'Close pane',
  ])
  expect(screen.queryByTitle('Bash, Read, Glob, WebFetch')).toBeNull()
  expect(screen.queryByTestId('terminal-icon')).toBeNull()
  expect(screen.queryByTestId('filetext-icon')).toBeNull()
  expect(screen.queryByTestId('filesearch-icon')).toBeNull()
  expect(screen.queryByTestId('globe-icon')).toBeNull()
  expect(screen.queryByTitle('Search in terminal')).toBeNull()
  expect(screen.queryByLabelText('Open terminal at session directory')).toBeNull()
  expect(screen.queryByRole('status', { name: /context/i })).toBeNull()
  expect(screen.queryByText(/ctx/i)).toBeNull()
})

it('omits refresh from the fresh-agent control order when no refresh handler is provided', () => {
  render(
    <Provider store={makeFreshAgentStore()}>
      <PaneHeader
        tabId="tab-1"
        paneId="pane-1"
        title="freshell"
        metaLabel="freshell (main)"
        status="running"
        isActive={true}
        onClose={vi.fn()}
        onToggleZoom={vi.fn()}
        content={{
          kind: 'fresh-agent',
          sessionType: 'freshcodex',
          provider: 'codex',
          sessionId: 'fresh-session-1',
          createRequestId: 'fresh-req-1',
          status: 'idle',
        }}
      />
    </Provider>,
  )

  const actionLabels = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') || button.getAttribute('title'))

  expect(actionLabels).toEqual([
    'Agent settings',
    'Maximize pane',
    'Close pane',
  ])
  expect(screen.queryByText(/ctx/i)).toBeNull()
})
```

- [ ] **Step 3: Add the store helper used by these tests**

Add this helper near the existing helper functions:

```tsx
function makeFreshAgentStore() {
  return configureStore({
    reducer: { freshAgent: freshAgentReducer },
  })
}
```

Add a small `makeFreshAgentSnapshot` fixture helper near the store helper if the test suite does not already have one. It only needs the fields required by `freshAgentSnapshotReceived`.

- [ ] **Step 4: Run the failing test**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/panes/PaneHeader.test.tsx -t "fresh-agent"
```

Expected: FAIL because the current header still renders a leading pane icon, duplicates `freshell`, renders the capitalized chip, includes seeded tool icons, includes seeded context status/`ctx`, includes the open-terminal button, and puts controls in the wrong order.

## Task 2: Implement Header Parity

**Files:**
- Modify: `src/components/panes/PaneHeader.tsx`

**Interfaces:**
- Consumes: `PaneHeader` props and existing `metaLabel`/`metaTooltip` formatting.
- Produces: fresh-agent headers with text sequence `freshcodex freshell (main)  56%`, no leading pane icon, no duplicated `freshell`, and control sequence settings, optional refresh, zoom, close.

- [ ] **Step 1: Remove header-only imports and helpers**

In `src/components/panes/PaneHeader.tsx`, remove:

```tsx
import { X, Maximize2, Minimize2, Search, RefreshCw, SquareTerminal, Terminal, FileSearch, Globe, FilePen, FileText } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { splitPane } from '@/store/panesSlice'
import { makeFreshAgentSessionKey } from '@shared/fresh-agent'
import FreshAgentContextMeter from '@/components/fresh-agent/FreshAgentContextMeter'
import { getFreshAgentLabel } from '@/lib/fresh-agent-registry'
```

Replace the lucide import with:

```tsx
import { X, Maximize2, Minimize2, Search, RefreshCw } from 'lucide-react'
```

Delete the hooks import entirely; `PaneHeader` should not read or write Redux state after the header-only helper removals.

Delete the `FRESH_AGENT_TOOL_ICONS`, `FreshAgentToolIcons`, and `FreshAgentOpenTerminalButton` definitions.

- [ ] **Step 2: Add a small action button helper**

Inside `PaneHeader`, before the `return`, add:

```tsx
  const refreshButton = onRefresh ? (
    <button
      onClick={(e) => {
        e.stopPropagation()
        onRefresh()
      }}
      className="inline-flex h-6 w-6 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity sm:h-4 sm:w-4"
      title="Refresh pane"
      aria-label="Refresh pane"
    >
      <RefreshCw className="h-[18px] w-[18px] sm:h-3 sm:w-3" />
    </button>
  ) : null
```

Use this for both terminal and fresh-agent refresh rendering so there is one refresh button definition.

- [ ] **Step 3: Derive the visible title once**

Before `return`, derive whether the pane is a fresh-agent pane and which title text should be visible. Fresh-agent panes use the CLI-style metadata label as their main text so the header does not render both `freshell` and `freshell (main)  56%`:

```tsx
  const isFreshAgentPane = content.kind === 'fresh-agent'
  const visibleTitle = isFreshAgentPane ? (metaLabel ?? title) : title
  const visibleTitleTooltip = isFreshAgentPane ? (metaTooltip || metaLabel || title) : title
```

- [ ] **Step 4: Render fresh-agent identity as the leftmost visible item**

Suppress the normal leading `PaneIcon` for fresh-agent panes:

```tsx
      {!isFreshAgentPane ? (
        <PaneIcon
          content={content}
          className={cn(
            'h-4 w-4 flex-shrink-0',
            content.kind === 'terminal' ? getTerminalStatusIconClassName(status) : undefined,
          )}
        />
      ) : null}
```

Change the left title container to include the fresh-agent identity before `visibleTitle`:

```tsx
      <div className="min-w-0 flex flex-1 items-center gap-1.5">
        {isFreshAgentPane && !isRenaming ? (
          <span
            className="shrink-0 text-sm text-muted-foreground"
            title={`${content.sessionType} session`}
          >
            {content.sessionType}
          </span>
        ) : null}
        {isRenaming ? (
          <input
            ref={inputRef}
            className="bg-transparent outline-none w-full min-w-0 text-sm"
            value={renameValue ?? ''}
            onChange={(e) => onRenameChange?.(e.target.value)}
            onBlur={onRenameBlur}
            onKeyDown={onRenameKeyDown}
            onClick={(e) => e.stopPropagation()}
            aria-label="Rename pane"
            aria-invalid={renameError ? true : undefined}
          />
        ) : (
          <span className="block min-w-0 truncate" title={visibleTitleTooltip}>
            {visibleTitle}
          </span>
        )}
      </div>
```

- [ ] **Step 5: Keep the right-side metadata span for non-fresh panes only**

Fresh-agent panes render `metaLabel` in the title area. Keep the existing right-side metadata span for CLI terminal panes and other non-fresh panes only:

```tsx
        {!isFreshAgentPane && metaLabel && (
          <span
            className="max-w-[18rem] truncate text-xs text-muted-foreground text-right"
            title={metaTooltip || metaLabel}
          >
            {metaLabel}
          </span>
        )}
```

Do not render `FreshAgentContextMeter`; the metadata span is the only context display in the header.

- [ ] **Step 6: Render controls in the desired order**

For terminal panes, keep the existing order:

```tsx
        {onSearch && content.kind === 'terminal' && (...)}
        {!isFreshAgentPane ? refreshButton : null}
```

For fresh-agent panes, render settings before optional refresh:

```tsx
        {isFreshAgentPane && (
          <FreshAgentSettingsButton
            tabId={tabId}
            paneId={paneId}
            paneContent={content}
          />
        )}

        {isFreshAgentPane ? refreshButton : null}
```

Then leave the existing zoom and close buttons after this block.

- [ ] **Step 7: Run the focused test**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/panes/PaneHeader.test.tsx -t "fresh-agent"
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

Run:

```bash
git add src/components/panes/PaneHeader.tsx test/unit/client/components/panes/PaneHeader.test.tsx
git commit -m "fix: align fresh-agent pane headers with cli panes"
```

## Task 3: Integration Coverage And Verification

**Files:**
- Modify: `test/e2e/pane-header-runtime-meta-flow.test.tsx`
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx`

**Interfaces:**
- Consumes: updated `PaneHeader`.
- Produces: verified behavior through the existing `PaneContainer` integration path.

- [ ] **Step 1: Extend the runtime metadata flow coverage**

In `test/e2e/pane-header-runtime-meta-flow.test.tsx`, extend the existing fresh-agent metadata test to assert that the lowercase fresh-agent identity is present next to the CLI-style metadata after the indexed metadata update:

```tsx
expect(screen.getByText('freshclaude')).toBeInTheDocument()
expect(screen.getByText(/freshell \(main\*\)\s+50%/)).toBeInTheDocument()
```

- [ ] **Step 2: Add a refresh-unavailable PaneContainer regression**

In `test/unit/client/components/panes/PaneContainer.test.tsx`, add a fresh-agent pane case with no `sessionId` and an inactive status such as `idle` or `create-failed`, then assert `screen.queryByTitle('Refresh pane')` is absent. This protects the `settings, optional refresh, zoom, close` contract through the real PaneContainer wiring.

- [ ] **Step 3: Run PaneHeader and PaneContainer coverage together**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx -t "fresh-agent|refresh button"
```

Expected: PASS.

- [ ] **Step 4: Run nearby fresh-agent component and runtime metadata tests**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck:client
```

Expected: PASS with no missing import or deleted-file errors.

- [ ] **Step 6: Run diff hygiene**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 7: Commit integration coverage**

Commit the e2e metadata assertion and any necessary PaneContainer test adjustment:

```bash
git add test/e2e/pane-header-runtime-meta-flow.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx
git commit -m "test: cover fresh-agent header parity integration"
```

## Task 4: Visual Smoke

**Files:**
- No expected file edits.

**Interfaces:**
- Consumes: built or development UI in the worktree.
- Produces: visual confirmation that the header looks like the attached CLI-agent reference.

- [ ] **Step 1: Start a worktree-only dev server on a unique port**

Start the server from this worktree, bound to `0.0.0.0`, recording the PID in `/tmp` and without touching the self-hosted Freshell process:

```bash
NODE_ENV=development PORT=3344 npm run dev > /tmp/freshell-header-parity-3344.log 2>&1 & echo $! > /tmp/freshell-header-parity-3344.pid
```

If port `3344` is in use, choose another unique port and keep the PID/log filenames aligned.

- [ ] **Step 2: Inspect desktop and narrow layouts**

Use the browser or Playwright against the worktree dev server to inspect one CLI pane and one fresh-agent pane. Confirm:

- CLI pane still reads like `freshell (main) 56%` followed by search, refresh, zoom, close.
- Fresh-agent pane reads like `freshcodex freshell (main) 56%` followed by settings, optional refresh, zoom, close.
- There is no leading pane icon before `freshcodex`, no open-terminal control, no `ctx` text, and no obvious text/control overlap at desktop or narrow width.

- [ ] **Step 3: Stop only the recorded worktree server PID**

Before stopping, verify the PID belongs to this worktree:

```bash
ps -fp "$(cat /tmp/freshell-header-parity-3344.pid)"
kill "$(cat /tmp/freshell-header-parity-3344.pid)"
rm -f /tmp/freshell-header-parity-3344.pid
```

## Task 5: Final Verification

**Files:**
- No expected file edits.

**Interfaces:**
- Consumes: all committed implementation work.
- Produces: final verification evidence for PR readiness.

- [ ] **Step 1: Run coordinated check**

Run:

```bash
FRESHELL_TEST_SUMMARY='fresh-agent header parity' npm run check
```

Expected: client, server, and Electron suites pass.

- [ ] **Step 2: Confirm branch state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -5
```

Expected: branch is clean, ahead of `main`, with the plan commit and implementation commit(s).

## Self-Review

**Spec coverage:** The plan covers the attached CLI-style shape, leftmost lowercase fresh-agent identity, all fresh-agent session types, context percent formatting through `formatPaneRuntimeLabel()`, removal of the open-terminal control, and focused + broad verification.

**Placeholder scan:** No `TBD`, `TODO`, `implement later`, or unspecified tests remain.

**Type consistency:** The plan uses existing `PaneHeader` prop names and existing fresh-agent content fields: `sessionType`, `provider`, `sessionId`, `createRequestId`, and `status`.
