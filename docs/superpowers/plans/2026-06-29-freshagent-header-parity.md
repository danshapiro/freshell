# Fresh-Agent Header Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every fresh-agent pane header match coding CLI pane header structure: lowercase fresh-agent identity first, cwd/branch/context text formatted like CLI panes, then compact controls in a stable order, with no open-terminal control and no separate `ctx` meter.

**Architecture:** Keep runtime metadata resolution in `PaneContainer` and render all header chrome in `PaneHeader`. Fresh-agent headers use the same `metaLabel` produced by `formatPaneRuntimeLabel()` as CLI panes; `FreshAgentContextMeter` and fresh-agent tool icons are removed from the pane header so no second context display or tool-icon strip competes with the CLI-style header. The fresh-agent settings gear stays because it is the only pane-local style/model control, but it is ordered with the normal header controls.

**Tech Stack:** React 18, Redux Toolkit selectors, Vitest + Testing Library, existing lucide icon system.

## Global Constraints

- The visual target is the attached CLI-agent header: text like `freshell (main) 56%`, then compact controls.
- For fresh agents, prepend the lowercase session type such as `freshcodex` as the leftmost text item.
- Context formatting must reuse the CLI runtime metadata format and must not show `ctx`.
- Remove the fresh-agent open-terminal header button.
- Apply to all fresh-agent types: `freshclaude`, `freshcodex`, `freshopencode`, and `kilroy`.
- Preserve the fresh-agent settings gear because pane-local model/style controls still need an access point.
- Keep control ordering stable: settings gear, refresh, zoom, close for fresh-agent panes; existing terminal search/refresh/zoom/close order stays unchanged.
- Do not restart the self-hosted Freshell server.
- Use focused tests first, then coordinated full-suite verification before completion.

---

## File Structure

- Modify `src/components/panes/PaneHeader.tsx`
  - Owns header layout for all pane kinds.
  - Add fresh-agent left label rendering from `content.sessionType`.
  - Remove `FreshAgentToolIcons`, `FreshAgentContextMeter`, and `FreshAgentOpenTerminalButton` from the header.
  - Reorder fresh-agent controls so the settings gear appears before refresh, then zoom, then close.
- Modify `test/unit/client/components/panes/PaneHeader.test.tsx`
  - Adds regression coverage for fresh-agent text order, no open-terminal button, no separate context meter, and control order.
  - Keeps existing CLI metadata formatter tests.
- Remove `src/components/fresh-agent/FreshAgentContextMeter.tsx`
  - The component exists only for the header-specific meter that is no longer part of the desired design.
- Remove `test/unit/client/components/fresh-agent/FreshAgentContextMeter.test.tsx`
  - Remove stale coverage for the deleted meter.
- No `docs/index.html` change
  - This is a pane-header consistency fix, not a new user-facing feature or major static mock change.

## Task 1: Fresh-Agent Header Contract Tests

**Files:**
- Modify: `test/unit/client/components/panes/PaneHeader.test.tsx`

**Interfaces:**
- Consumes: `PaneHeader` props `content`, `metaLabel`, `metaTooltip`, `onRefresh`, `onToggleZoom`, and `onClose`.
- Produces: failing tests that define the desired header contract before implementation.

- [ ] **Step 1: Update test mocks**

Add an accessible settings-button stub so action order can be tested by role:

```tsx
vi.mock('@/components/fresh-agent/FreshAgentSettingsButton', () => ({
  default: () => (
    <button type="button" aria-label="Agent settings" title="Agent settings" data-testid="settings-button-stub" />
  ),
}))
```

Remove the `SquareTerminal` lucide mock from this file after the implementation removes the open-terminal button.

- [ ] **Step 2: Add failing fresh-agent parity tests**

Add these tests inside `describe('PaneHeader', () => { describe('rendering', () => { ... }) })`:

```tsx
it('renders fresh-agent identity as the leftmost header text before CLI-style metadata', () => {
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
  const metadata = screen.getByText('freshell (main)  56%')

  expect(banner).toContainElement(identity)
  expect(banner).toContainElement(metadata)
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

  const actionLabels = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') || button.getAttribute('title'))

  expect(actionLabels).toEqual([
    'Agent settings',
    'Refresh pane',
    'Maximize pane',
    'Close pane',
  ])
  expect(screen.queryByLabelText('Open terminal at session directory')).toBeNull()
  expect(screen.queryByRole('status', { name: /context/i })).toBeNull()
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

- [ ] **Step 4: Run the failing test**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/panes/PaneHeader.test.tsx -t "fresh-agent"
```

Expected: FAIL because the current header still renders the capitalized chip, tool icons, open-terminal button, and context meter before the desired control order.

## Task 2: Implement Header Parity

**Files:**
- Modify: `src/components/panes/PaneHeader.tsx`
- Remove: `src/components/fresh-agent/FreshAgentContextMeter.tsx`
- Remove: `test/unit/client/components/fresh-agent/FreshAgentContextMeter.test.tsx`

**Interfaces:**
- Consumes: `PaneHeader` props and existing `metaLabel`/`metaTooltip` formatting.
- Produces: fresh-agent headers with text sequence `freshcodex freshell (main)  56%` and control sequence settings, refresh, zoom, close.

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

- [ ] **Step 3: Render fresh-agent identity as plain left text**

Change the left title container to include the fresh-agent identity before the visible title:

```tsx
      <div className="min-w-0 flex flex-1 items-center gap-1.5">
        {content.kind === 'fresh-agent' && !isRenaming ? (
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
          <span className="block min-w-0 truncate" title={title}>
            {title}
          </span>
        )}
      </div>
```

- [ ] **Step 4: Render metadata immediately before compact controls**

Keep the existing metadata span:

```tsx
        {metaLabel && (
          <span
            className="max-w-[18rem] truncate text-xs text-muted-foreground text-right"
            title={metaTooltip || metaLabel}
          >
            {metaLabel}
          </span>
        )}
```

Do not render `FreshAgentContextMeter`; the metadata span is the only context display in the header.

- [ ] **Step 5: Render controls in the desired order**

For terminal panes, keep the existing order:

```tsx
        {onSearch && content.kind === 'terminal' && (...)}
        {content.kind !== 'fresh-agent' ? refreshButton : null}
```

For fresh-agent panes, render settings before refresh:

```tsx
        {content.kind === 'fresh-agent' && (
          <FreshAgentSettingsButton
            tabId={tabId}
            paneId={paneId}
            paneContent={content}
          />
        )}

        {content.kind === 'fresh-agent' ? refreshButton : null}
```

Then leave the existing zoom and close buttons after this block.

- [ ] **Step 6: Delete the old context meter files**

Remove:

```bash
git rm src/components/fresh-agent/FreshAgentContextMeter.tsx test/unit/client/components/fresh-agent/FreshAgentContextMeter.test.tsx
```

- [ ] **Step 7: Run the focused test**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/panes/PaneHeader.test.tsx -t "fresh-agent"
```

Expected: PASS.

- [ ] **Step 8: Commit Task 2**

Run:

```bash
git add src/components/panes/PaneHeader.tsx test/unit/client/components/panes/PaneHeader.test.tsx src/components/fresh-agent/FreshAgentContextMeter.tsx test/unit/client/components/fresh-agent/FreshAgentContextMeter.test.tsx
git commit -m "fix: align fresh-agent pane headers with cli panes"
```

## Task 3: Integration Coverage And Verification

**Files:**
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx` only if the existing refresh/materialization tests fail after the header change.

**Interfaces:**
- Consumes: updated `PaneHeader`.
- Produces: verified behavior through the existing `PaneContainer` integration path.

- [ ] **Step 1: Run PaneHeader and PaneContainer coverage together**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/panes/PaneHeader.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx -t "fresh-agent|refresh button"
```

Expected: PASS.

- [ ] **Step 2: Run nearby fresh-agent component tests**

Run:

```bash
npm run test:vitest -- --run test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck:client
```

Expected: PASS with no missing import or deleted-file errors.

- [ ] **Step 4: Run diff hygiene**

Run:

```bash
git diff --check
```

Expected: no output.

- [ ] **Step 5: Commit verification-only test updates if any**

If Task 3 required test edits, commit them:

```bash
git add test/unit/client/components/panes/PaneContainer.test.tsx
git commit -m "test: cover fresh-agent header parity integration"
```

If Task 3 did not require file edits, do not create an empty commit.

## Task 4: Final Verification

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
