# Fresh-Agent Transcript: Single Accumulating Activity Line Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
In fresh-agent transcripts, adjacent tool-activity lines with nothing rendered between them (e.g. "3 tools used" followed by "2 tools used") appear as one line whose tool count accumulates (e.g. "5 tools used"); the single line keeps absorbing tool activity until a message appears, and only then does a new line start. If anything renders between two tool runs, they stay as separate lines.

### Explicit constraints
- Implement via the the-usual-beta workflow (dedicated worktree, committed plan, load-bearing validation, independent plan review, TDD execution, independent delta review, plain-language recap; PR only after explicit user approval).
- Build the behavior as one open activity line that tool runs join as they stream (start in the right place), not as after-the-fact moving of tool items between turns.
- If anything (message text, user message, role-change header) renders between tool runs, the runs must not collapse.

### Accepted tradeoffs and residuals
- (none stated)

**Goal:** Adjacent fresh-agent tool-activity strips with nothing between them render as one accumulating "N tools used" line (opened once, extended in place) instead of one strip per turn; any intervening message or role-change header keeps them separate.

**Architecture:** Replace per-turn `buildBlocks` strip boundaries with a transcript-level single-pass layout in `FreshAgentTranscript.tsx`. The layout walks display turns once, keeping at most one OPEN activity line: a turn's leading activity items append to the open line when the turn has the same role as the line and no message item has rendered between; any message item or role change closes the line and later activity opens a new one. The line mounts once, in the article of the turn where its first item appears; turns fully absorbed into the line render no article. Fork/rewind/copy affordances are preserved at line granularity: a merged line's actions resolve to the line's LAST contributing turn (the most recent point the line covers), so the existing "fork from the latest activity turn" protection stays intact. `selectLiveActivityBlockId` is re-derived from the same layout, and the empty-streaming-turn injected strip is suppressed only when an adjacent open line already carries liveness.

**Tech Stack:** React 18, TypeScript, Vitest + Testing Library (unit), Playwright e2e via the repo's configured backend (`test/e2e-browser`). No server or Rust changes — both servers feed the same REST snapshot shape into this one client component (verified by exploration).

## Global Constraints

- Work only in the worktree `/home/dan/code/freshell/.worktrees/freshagent-activity-line` (branch `the-usual/freshagent-activity-line`, anchored at `6d5b5394ccfd00844579d8857180ff7fad4a2ef9`). Never touch the main checkout.
- TDD red/green/refactor; never reduce coverage, skip tests, or loosen assertions to pass.
- All vitest runs use the repo-owned path from the worktree: `npm run test:vitest -- run <paths>` (never raw `npx vitest`).
- e2e runs use the configured `FRESHELL_E2E_BACKEND` (cloud by default here): `npm run test:e2e -- <spec>`.
- Server code uses NodeNext/ESM with `.js` relative import extensions (not applicable to the client change here, but the constraint stands for any touched server file).
- Commits are focused and conventional (`feat:`, `test:`, `docs:`). Never set git config/identity. Never amend, force-push, or create PRs.
- Never synthesize composite `turnId`s: server fork paths parse format-sensitive ids (Rust codex strips a trailing `:row-N`, Rust opencode gates on `^msg`). Composite display `id`s joined with `:` are established precedent (`appendTurnItems` in the same file) and are fine for React keys only.
- The `## User Request` block above is verbatim and must not be edited by remediation.
- `docs/index.html` is a mock of major UX surfaces; this change is a rendering-rule refinement of an existing surface, so no mock update is required (recorded decision, not an oversight).
- `test/browser_use/tool_coalesce.py` asserts a within-turn "N tools used" strip; strips still show that text after this change, so the script needs no edit (recorded decision).

---

### Task 1: Failing e2e coverage for adjacent-strip collapsing

**Files:**
- Test: `test/e2e-browser/specs/fresh-agent.spec.ts`

**Interfaces:**
- Consumes: existing harness pattern — `page.route('**/api/fresh-agent/threads/freshcodex/codex/<session>*', ...)` fulfilling the snapshot REST call; picker flow via `openPanePicker(page)`; `panes/updatePaneContent` dispatch to point the pane at the seeded session (see the 'style setting persists per Fresh Agent pane type and applies serif rendering' test in the same file for the exact flow).
- Produces: two failing e2e tests proving the pre-fix behavior (later turned green by Task 2).

- [x] **Step 1: Write the failing behavioral tests**

Append a new `test.describe('activity line collapse', ...)` block at the end of `test/e2e-browser/specs/fresh-agent.spec.ts`, reusing the same file's picker/*route* seeding pattern:

```ts
test.describe('activity line collapse', () => {
  async function seedCollapsePane(
    page: Parameters<typeof openPanePicker>[0],
    terminal: { waitForTerminal: () => Promise<void> },
    sessionId: string,
    turns: unknown[],
  ) {
    // NOTE TO IMPLEMENTER: mirror the setup of the 'style setting persists per Fresh Agent pane type
    // and applies serif rendering' test in this same file AND copy its fixture set ({ freshellPage,
    // page, harness, terminal } — the repository fixtures perform navigation/harness setup only when
    // freshellPage is requested; the helper below receives page + terminal, which is sufficient once
    // the TEST CALLBACKS request freshellPage/harness):
    // 1. await terminal.waitForTerminal(); await enableClaudeAndCodex(page)
    // 2. open the pane picker, click Freshcodex, accept the first option
    // 3. page.route(`**/api/fresh-agent/threads/freshcodex/codex/${sessionId}*`) fulfilling a snapshot with
    //    { sessionType:'freshcodex', provider:'codex', threadId:sessionId, sessionId, revision:1,
    //      latestTurnId:<last turn id>, status:'idle', summary:'', capabilities:{...true}, settings:{...},
    //      tokenUsage:{...zeros}, pendingApprovals:[], pendingQuestions:[], worktrees:[], diffs:[], turns }
    // 4. page.evaluate dispatching panes/updatePaneContent via window.__FRESHELL_TEST_HARNESS__ to point
    //    the new freshcodex leaf at sessionId (copy the leaf-walk + dispatch from the serif test, minus
    //    the style filter)
  }

  function toolTurn(turnId: string, calls: Array<[string, string]>) {
    // calls: [callId, filePath] pairs; produces an assistant turn whose items are
    // tool_use(toolUseId=callId, name:'Read', input:{file_path}) followed by its tool_result(content:'ok').
    return {
      id: turnId, turnId, role: 'assistant', summary: '',
      items: calls.flatMap(([callId, filePath]) => [
        { id: `tool-${callId}`, kind: 'tool_use', toolUseId: callId, name: 'Read', input: { file_path: filePath } },
        { id: `result-${callId}`, kind: 'tool_result', toolUseId: callId, content: 'ok', isError: false },
      ]),
    }
  }

  test('collapses adjacent same-role tool turns into one accumulating activity line (3 + 2 = 5)', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    await seedCollapsePane(page, terminal, 'collapse-thread', [
      { id: 'turn-user', turnId: 'turn-user', role: 'user', summary: 'read files',
        items: [{ id: 'item-user', kind: 'text', text: 'read these five files' }] },
      toolTurn('turn-a', [['c1','src/a.ts'],['c2','src/b.ts'],['c3','src/c.ts']]),
      toolTurn('turn-b', [['c4','src/d.ts'],['c5','src/e.ts']]),
    ])
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    const strips = pane.getByRole('region', { name: 'Activity strip' })
    await expect(strips).toHaveCount(1)
    await expect(strips.first()).toContainText('5 tools used')
    await pane.getByRole('button', { name: 'Toggle activity details' }).click()
    await expect(pane.getByRole('button', { name: 'Read tool call' })).toHaveCount(5)
    await expect(pane.getByText('src/a.ts')).toBeVisible()
    await expect(pane.getByText('src/e.ts')).toBeVisible()
  })

  test('an intervening message keeps two tool lines separate', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    await seedCollapsePane(page, terminal, 'split-thread', [
      toolTurn('turn-a', [['c1','src/a.ts']]),
      { id: 'turn-msg', turnId: 'turn-msg', role: 'assistant', summary: 'note',
        items: [{ id: 'item-msg', kind: 'text', text: 'First file read.' }] },
      toolTurn('turn-b', [['c2','src/b.ts']]),
    ])
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    const strips = pane.getByRole('region', { name: 'Activity strip' })
    await expect(strips).toHaveCount(2)
    await expect(strips.nth(0)).toContainText('1 tool used')
    await expect(strips.nth(1)).toContainText('1 tool used')
  })
})
```

The helper prose comments marked `NOTE TO IMPLEMENTER` must be replaced with the actual copied setup code from the serif test (lines ~233–374 of the same file at base).

- [x] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:e2e -- test/e2e-browser/specs/fresh-agent.spec.ts --grep "activity line collapse"`

Expected: FAIL because the first test currently finds 2 strips ("3 tools used" and "2 tools used") instead of one strip with "5 tools used". The second test (intervening message) may PASS already — that is fine and expected; it guards the boundary.

Do NOT commit. The failing e2e is staged with Task 2's commit once green.

### Task 2: Transcript-level open activity line (layout pass + render wiring + unit suite)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

**Interfaces:**
- Consumes: `FreshAgentTurn`, `FreshAgentTranscriptItem` from `@shared/fresh-agent-contract`; existing `buildActivity`, `isActivityLike`, `FreshAgentActivityStrip`, `FreshAgentTurnArticle`.
- Produces: `buildTranscriptLayout(turns: DisplayTurn[], paintedSummaryKeys: PaintedSummaryStore): { layouts: TurnLayout[]; lineEndIndex: Map<number, number>; tail: { blockId: string; turnIndex: number } | null }` (module-scope pure function, not exported; `lineEndIndex` maps a line's origin-turn index → the index of the line's LAST contributing display turn; `tail` names the last rendered block when it is an activity line), `rendersVisibly(...)`, `summaryIsAuthoredContent(...)`, `recordPaintedSummary(...)`/`paintedSummaryMatches(...)` (per-turnId prefix-matched painted-summary identity), `selectLiveActivityBlockIdFromLayout(...)`; `FreshAgentTurnArticle` gains `blocks: RenderBlock[]` and `actionTurn: FreshAgentTurn` props and drops its internal `buildBlocks` call.

- [x] **Step 1: Write the failing behavioral tests (new unit cases)**

Add to `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (a new `describe('activity line collapse', ...)`):

```tsx
describe('activity line collapse', () => {
  const toolTurn = (turnId: string, calls: Array<[string, string]>): FreshAgentTurn => ({
    id: turnId,
    turnId,
    role: 'assistant',
    summary: '',
    items: calls.flatMap(([callId, filePath]): FreshAgentTranscriptItem[] => [
      { id: `tool-${callId}`, kind: 'tool_use', toolUseId: callId, name: 'Read', input: { file_path: filePath } },
      { id: `result-${callId}`, kind: 'tool_result', toolUseId: callId, content: 'ok', isError: false },
    ]),
  })

  it('collapses adjacent same-role tool-only turns into one accumulating strip line', () => {
    render(
      <FreshAgentTranscript
        turns={[
          { id: 'turn-user', role: 'user', summary: 'req',
            items: [{ id: 'item-user', kind: 'text', text: 'read five files' }] },
          toolTurn('turn-a', [['c1','src/a.ts'],['c2','src/b.ts'],['c3','src/c.ts']]),
          toolTurn('turn-b', [['c4','src/d.ts'],['c5','src/e.ts']]),
        ]}
      />,
    )
    const strips = screen.getAllByRole('region', { name: 'Activity strip' })
    expect(strips).toHaveLength(1)
    expect(strips[0]).toHaveTextContent('5 tools used')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getAllByText(/^src\/[a-e]\.ts$/)).toHaveLength(5)
    expect(screen.getByText('src/e.ts')).toBeInTheDocument()
  })

  it('keeps tool lines separate when a message renders between them', () => {
    render(
      <FreshAgentTranscript
        turns={[
          toolTurn('turn-a', [['c1','src/a.ts']]),
          { id: 'turn-msg', role: 'assistant', summary: 'note',
            items: [{ id: 'item-msg', kind: 'text', text: 'First file read.' }] },
          toolTurn('turn-b', [['c2','src/b.ts']]),
        ]}
      />,
    )
    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
  })

  it('does not collapse tool lines across a role change', () => {
    render(
      <FreshAgentTranscript
        turns={[
          toolTurn('turn-a', [['c1','src/a.ts']]),
          { ...toolTurn('turn-b', [['c2','src/b.ts']]), role: 'tool' },
        ]}
      />,
    )
    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    // the role change renders a header between the lines
    expect(screen.getByText('Tool')).toBeInTheDocument()
  })

  it('a trailing text card in the earlier turn keeps the lines separate', () => {
    render(
      <FreshAgentTranscript
        turns={[
          { id: 'turn-a', role: 'assistant', summary: 'work',
            items: [
              { id: 'tool-c1', kind: 'tool_use', toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } },
              { id: 'item-msg', kind: 'text', text: 'done with a' },
            ] },
          toolTurn('turn-b', [['c2','src/b.ts']]),
        ]}
      />,
    )
    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
  })

  it('merges a chain of three adjacent tool-only turns', () => {
    render(
      <FreshAgentTranscript
        turns={[
          toolTurn('turn-a', [['c1','src/a.ts'],['c2','src/b.ts']]),
          toolTurn('turn-b', [['c3','src/c.ts'],['c4','src/d.ts']]),
          toolTurn('turn-c', [['c5','src/e.ts'],['c6','src/f.ts']]),
        ]}
      />,
    )
    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('6 tools used')
  })

  it('fully absorbed turns render no article and fork targets the line end', () => {
    const onFork = vi.fn()
    render(
      <FreshAgentTranscript
        canFork
        onForkFromTurn={onFork}
        turns={[
          { id: 'turn-a', turnId: 'native-a', role: 'assistant', summary: '',
            items: [{ id: 't1', kind: 'thinking', text: 'first thought' }] },
          { id: 'turn-b', turnId: 'native-b', role: 'assistant', summary: '',
            items: [{ id: 't2', kind: 'thinking', text: 'second thought' }] },
        ]}
      />,
    )
    expect(screen.getAllByRole('article', { name: 'Assistant transcript turn' })).toHaveLength(1)
    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    // merged thinking-only line settles to 'thought'
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getByText('Thinking')).toBeInTheDocument()
    const forkButtons = screen.getAllByRole('button', { name: 'Fork conversation from here' })
    fireEvent.click(forkButtons[0])
    expect(onFork).toHaveBeenCalledWith('native-b')
  })

  it('treats a zero-item turn as a boundary between tool lines', () => {
    render(
      <FreshAgentTranscript
        turns={[
          toolTurn('turn-a', [['c1','src/a.ts']]),
          { id: 'turn-empty', turnId: 'turn-empty', role: 'assistant', summary: '', items: [] },
          toolTurn('turn-b', [['c2','src/b.ts']]),
        ]}
      />,
    )
    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
  })

  it('renders both tools when TS-claude duplicate item ids collide across merged turns', () => {
    render(
      <FreshAgentTranscript
        turns={[
          { id: 'turn-a', turnId: 'turn:msg-1', role: 'assistant', summary: '',
            items: [{ id: 'turn:msg-1:item:0', kind: 'tool_use', toolUseId: 'toolu_1', name: 'Read', input: { file_path: 'src/a.ts' } }] },
          { id: 'turn-b', turnId: 'turn:msg-1', role: 'assistant', summary: '',
            items: [{ id: 'turn:msg-1:item:0', kind: 'tool_use', toolUseId: 'toolu_2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
        ]}
      />,
    )
    expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('2 tools used')
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getByText('src/a.ts')).toBeInTheDocument()
    expect(screen.getByText('src/b.ts')).toBeInTheDocument()
  })

  it('extends the open line in place as adjacent tool turns stream in (same DOM node, no regroup)', () => {
    const userTurn = {
      id: 'turn-user', role: 'user' as const, summary: 'req',
      items: [{ id: 'item-user', kind: 'text' as const, text: 'read five files' }],
    }
    const turnA = toolTurn('turn-a', [['c1','src/a.ts'],['c2','src/b.ts'],['c3','src/c.ts']])
    const { rerender } = render(<FreshAgentTranscript turns={[userTurn, turnA]} />)
    const first = screen.getByRole('region', { name: 'Activity strip' })
    expect(first).toHaveTextContent('3 tools used')

    rerender(<FreshAgentTranscript turns={[userTurn, turnA, toolTurn('turn-b', [['c4','src/d.ts'],['c5','src/e.ts']])]} />)
    const merged = screen.getByRole('region', { name: 'Activity strip' })
    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    expect(merged).toBe(first)
    expect(merged).toHaveTextContent('5 tools used')
  })

  it('keeps two same-turn lines distinct when a message splits them (tool → text → tool)', () => {
    render(
      <FreshAgentTranscript
        turns={[{
          id: 'turn-mixed', role: 'assistant', summary: '',
          items: [
            { id: 'tool-a', kind: 'tool_use', toolUseId: 'ca', name: 'Read', input: { file_path: 'src/a.ts' } },
            { id: 'item-note', kind: 'text', text: 'first pass done' },
            { id: 'tool-b', kind: 'tool_use', toolUseId: 'cb', name: 'Read', input: { file_path: 'src/b.ts' } },
          ],
        }]}
      />,
    )
    const strips = screen.getAllByRole('region', { name: 'Activity strip' })
    expect(strips).toHaveLength(2)
    expect(strips[0]).toHaveTextContent('1 tool used')
    expect(strips[1]).toHaveTextContent('1 tool used')
  })

  it('an invisible (whitespace-only) text item does not split the line', () => {
    render(
      <FreshAgentTranscript
        turns={[
          toolTurn('turn-a', [['c1','src/a.ts']]),
          { id: 'turn-empty-text', role: 'assistant', summary: '',
            items: [{ id: 'item-empty', kind: 'text', text: '   ' }] },
          toolTurn('turn-b', [['c2','src/b.ts']]),
        ]}
      />,
    )
    expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('2 tools used')
  })

  it('hands liveness to the merged line across an absorbed previous turn while the last turn streams empty', () => {
    render(
      <FreshAgentTranscript
        isStreaming
        turns={[
          toolTurn('turn-a', [['c1','src/a.ts']]),
          toolTurn('turn-b', [['c2','src/b.ts']]),
          { id: 'turn-streaming', role: 'assistant', summary: '', items: [] },
        ]}
      />,
    )
    expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    expect(screen.getAllByLabelText('running')).toHaveLength(1)
    expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('Read')
    expect(screen.queryByText('2 tools used')).not.toBeInTheDocument()
  })
})
```

(Note: thinking items require `showThinking` default true — the component default is `true`; these turns are activity-only thinking runs merging into one line, matching the "second thought" gh-of the old :892 test.)

- [x] **Step 2: Run the new tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx -t "activity line collapse"`

Expected: FAIL — the collapse/merge/absorb cases currently render 2/2/2/1+2/more strips and articles because strip boundaries are per-turn (per-turn `buildBlocks` in `FreshAgentTurnArticle`, `FreshAgentTranscript.tsx:497`). The 'keeps separate' and 'trailing text' cases may pass already (they assert preserved boundaries).

- [x] **Step 3: Add the production implementation**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`:

(a) After `buildBlocks` (:225), add the transcript-level layout pass. Two validator-driven hardening rules are baked in — see "Validated design notes" at the bottom:

```ts
type TurnLayout = { blocks: RenderBlock[] }

/** Mirrors FreshAgentItemCard's null-render path for text items: a text item
 * that renders nothing must not close an open line (nothing visibly between). */
function rendersVisibly(item: FreshAgentTranscriptItem): boolean {
  if (item.kind === 'text') return stripSystemReminders(item.text).trim().length > 0
  return true
}

/**
 * One OPEN activity line per transcript state: a next turn's leading
 * activity items append to the open line when the turn has the same role and
 * no message item has rendered between (a role change paints a header, so it
 * counts as "something between"). Lines are re-built from the concatenated
 * item list so buildActivity's tool_use/tool_result stitching stays intact.
 *
 * Line ids use a global per-layout sequence (`line:${n}`), NOT the origin turn
 * index: one turn can own two lines (`tool → text → tool`), and identical keys
 * would make React reuse state/DOM across what must stay two separate strips.
 * The key is stable while a line extends (no new line opens mid-extension), so
 * the strip keeps its DOM node — the "started in the right place" behavior.
 *
 * Zero-item turns (Rust codex `subAgentActivity` rows, opencode structural
 * messages) render real articles today, so they hard-close any open line —
 * they are "something between" by definition. Absorbed follower items get
 * display-only id dedupe (TS claude reuses item ids across turns sharing one
 * provider message id; stitching keys toolUseId, which is verified unique, so
 * stitching is unaffected — only React keys need this).
 */
function buildTranscriptLayout(turns: DisplayTurn[], paintedSummaryKeys: PaintedSummaryStore): {
  layouts: TurnLayout[]
  lineEndIndex: Map<number, number>
  tail: { blockId: string; turnIndex: number } | null
} {
  const layouts: TurnLayout[] = []
  let open: { originIndex: number; role: FreshAgentTurn['role']; items: FreshAgentTranscriptItem[] } | null = null
  const lineEndIndex = new Map<number, number>()
  let lineSeq = 0

  const flushOpen = () => {
    if (!open) return
    const rows = buildActivity(open.items)
    if (rows.length > 0) {
      const id = `line:${lineSeq++}`
      layouts[open.originIndex].blocks.push({ kind: 'activity', id, rows })
    }
    open = null
  }

  for (const [turnIndex, turn] of turns.entries()) {
    const layout: TurnLayout = { blocks: [] }
    layouts.push(layout)
    if (turn.items.length === 0) {
      flushOpen()
      continue
    }
    for (const item of turn.items) {
      if (isActivityLike(item)) {
        // Cross-turn absorb is refused by either boundary guard: an authored
        // summary (no echo among the turn's pre-filter items), or a summary
        // this view already painted (prefix-matched per turnId). Intra-turn
        // chaining into the turn's own line is always free.
        if (
          open
          && open.role === turn.role
          && (
            open.originIndex === turnIndex
            || (!paintedSummaryMatches(paintedSummaryKeys, turn) && !summaryIsAuthoredContent(turn))
          )
        ) {
          const taken = new Set(open.items.map((openItem) => openItem.id))
          let displayItem = item
          let counter = 2
          while (taken.has(displayItem.id)) {
            displayItem = { ...item, id: `${item.id}:d${counter}` }
            counter += 1
          }
          open.items.push(displayItem as FreshAgentTranscriptItem)
          lineEndIndex.set(open.originIndex, turnIndex)
        } else {
          flushOpen()
          open = { originIndex: turnIndex, role: turn.role, items: [item] }
        }
        continue
      }
      if (!rendersVisibly(item)) {
        // Invisible content only. Same-role turns merge freely (nothing renders
        // between the lines). A different-role turn still paints its header, so
        // it closes the open line and keeps its (invisible-bodied) block,
        // matching the pre-change renderer's chrome.
        if (open && turn.role !== open.role) {
          flushOpen()
          layout.blocks.push({ kind: 'item', item })
        }
        continue
      }
      flushOpen()
      layout.blocks.push({ kind: 'item', item })
    }
  }
  flushOpen()

  // tail = last rendered block overall when it is an activity line; null when
  // the transcript visibly ends in a message.
  let tail: { blockId: string; turnIndex: number } | null = null
  for (let i = layouts.length - 1; i >= 0; i--) {
    const blocks = layouts[i].blocks
    if (blocks.length === 0) continue
    const last = blocks[blocks.length - 1]
    if (last.kind === 'activity') tail = { blockId: last.id, turnIndex: i }
    break
  }
  return { layouts, lineEndIndex, tail }
}
```

Note: after a message flushes the open line, `open` is null, so later activity in the SAME turn opens a fresh line whose remaining activity items absorb normally — `text → tool_use → tool_result` stays ONE line, exactly matching today's in-turn `buildBlocks` batching — while `tool → text → tool` yields two lines with distinct `line:N` identities.

(b) Replace `selectLiveActivityBlockId` (:307–339) with a layout-driven version:

```ts
function selectLiveActivityBlockIdFromLayout(
  layouts: TurnLayout[],
  turns: FreshAgentTurn[],
  isStreaming: boolean,
  tail: { blockId: string; turnIndex: number } | null,
): string | null {
  let latestActivityBlockId: string | null = null
  layouts.forEach((layout) => {
    for (const block of layout.blocks) {
      if (block.kind === 'activity') latestActivityBlockId = block.id
    }
  })

  const lastIndex = turns.length - 1
  const lastTurn = turns[lastIndex]

  if (!isStreaming) {
    // Settled sessions mark only a trailing thinking strip as live. Mirror the
    // old last-turn rule; when the last turn was absorbed, its items live at
    // the tail of the latest line, so check that line instead.
    const blocks = lastIndex >= 0 ? layouts[lastIndex].blocks : []
    const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null
    const candidateId = lastBlock?.kind === 'activity'
      ? lastBlock.id
      : (lastTurn?.items.length ?? 0) > 0 && tail && tail.turnIndex < lastIndex
        ? tail.blockId
        : null
    if (!candidateId) return null
    const candidate = [...layouts.flatMap((l) => l.blocks)].find((b) => b.kind === 'activity' && b.id === candidateId)
    return candidate?.kind === 'activity' && candidate.rows.at(-1)?.type === 'thinking'
      ? candidate.id
      : null
  }

  if (lastTurn && lastTurn.items.length > 0) return latestActivityBlockId
  if (!lastTurn || !tail) return null
  // A summary-only last turn renders its own article (summary markdown plus
  // the injected live strip); handing liveness to the tail line would skip
  // that article and hide the summary. A rendered summary is a message — it
  // closes the line.
  if (lastTurn.summary && lastTurn.summary.trim().length > 0) return null

  // Last display turn streams with zero visible items: hand liveness to the
  // trailing line when nothing rendered between them (intermediate turns were
  // absorbed into that line; a zero-item or message intermediate is a real
  // boundary) and roles match the whole way across.
  const absorbedOnly = turns.slice(tail.turnIndex + 1, lastIndex)
    .every((turn, offset) =>
      turn.items.length > 0 && layouts[tail.turnIndex + 1 + offset].blocks.length === 0)
  if (absorbedOnly && turns[tail.turnIndex].role === lastTurn.role) {
    return tail.blockId
  }
  return null
}
```

(c) In `FreshAgentTranscript` (:632), compute the layout and derive liveness from it:

```ts
const displayTurns = useMemo(() => (
  filterTurnsForDisplay(coalesceSyntheticToolResultTurns(turns), displayOptions, isStreaming, paintedSummaryKeysRef.current)
), [displayOptions, turns, isStreaming])
const { layouts: turnLayouts, lineEndIndex, tail } = useMemo(
  () => buildTranscriptLayout(displayTurns, paintedSummaryKeysRef.current),
  [displayTurns],
)
const liveActivityBlockId = useMemo(
  () => selectLiveActivityBlockIdFromLayout(turnLayouts, displayTurns, isStreaming, tail),
  [turnLayouts, displayTurns, isStreaming, tail],
)
```

(Painted-summary tracking: an effect records, per turnId, each zero-item summary this view actually rendered; `filterTurnsForDisplay` keeps an invisible placeholder for a fully-filtered turn whose summary painted, and `buildTranscriptLayout`'s absorb guard refuses a painted follower. Prefix matching on the summary text lets a growing streaming summary inherit its boundary while duplicate turnIds with unrelatable summaries do not. A transcript that mounts already-settled never painted, so its hidden summaries do not block merging.)

(d) In the render loop (:765–780), pass blocks in, skip fully-absorbed turns, and resolve the article's action turn to the line's LAST contributing turn so fork/rewind/context-menu affordances survive merging at line-end granularity:

```tsx
{displayTurns.map((turn, index) => {
  const blocksForTurn = turnLayouts[index]?.blocks ?? []
  const absorbed = turn.items.length > 0 && blocksForTurn.length === 0
  const isLastStreaming = isStreaming && index === displayTurns.length - 1
  if (absorbed) return null
  if (isLastStreaming && blocksForTurn.length === 0 && turn.items.length === 0 && liveActivityBlockId !== null) return null
  const actionTurn = displayTurns[lineEndIndex.get(index) ?? index]
  return (
    <FreshAgentTurnArticle
      key={`${getFreshAgentDisplayTurnKey(turn)}:${index}`}
      turn={turn}
      actionTurn={actionTurn}
      blocks={blocksForTurn}
      actions={actions}
      agentLabel={agentLabel}
      showTimecodes={resolvedShowTimecodes}
      showTools={showTools}
      showHeader={index === 0 || displayTurns[index - 1]?.role !== turn.role}
      continuation={index > 0 && displayTurns[index - 1]?.role === turn.role}
      liveActivityBlockId={liveActivityBlockId}
      isStreamingLastTurn={isLastStreaming}
      index={index}
    />
  )
})}
```

In `FreshAgentTurnArticle`, every action surface (`FreshAgentTurnActions`, the context menu handler, the long-press action sheet opener) uses the new `actionTurn` prop instead of `turn` for `onForkFromTurn`/`onRewindToTurn`/`buildTurnActionItems`/`onOpenActions` — so a merged line forks from the last point the line covers (`(none stated)` residual: mid-line fork targets between absorbed turns are removed, a required consequence of rendering one line).

(e) In `FreshAgentTurnArticle`, accept `blocks` as a prop (remove its internal `buildBlocks` call and the now-unused `displayOptions` prop if it was only used for that), and change the injected-strip condition (:573) so it only fires when no open line took over liveness:

```tsx
{isStreamingLastTurn && blocks.length === 0 && liveActivityBlockId === null ? (
  <FreshAgentActivityStrip rows={[]} live initialExpanded={showTools} />
) : null}
```

Note the article still renders its fallback summary path only when `blocks.length === 0 && turn.items.length > 0` is IMPOSSIBLE by construction (parent returns null for that case), so the existing `:566–572` fallback continues to apply only to legacy empty-item turns.

(f) Update the four existing tests that encode the old per-turn boundary:

1. `'keeps consecutive activity-only assistant turns separate while marking only the latest live'` (~:459) — replace expectation block: now ONE strip, one running indicator; click Toggle once; `src/one.ts`, `src/two.ts`, `src/three.ts` all visible; running indicator count stays 1. Rename to `'collapses consecutive activity-only assistant turns into one live strip'`.
2. `'coalesces adjacent Claude tool-use/result exchanges without rendering synthetic You turns'` (:576) — after synthetic coalescing the two exchanges are adjacent same-role activity-only turns: change `strips` to length 1, expect `'2 tools used'`, headers still `['You', 'Freshclaude']`, still zero user-role strips.
3. `'keeps adjacent activity-only display turns distinct and actionable'` (:892) — replace with the line-end-fork test from Step 1 (last case); the protection is preserved at line granularity: the single merged article's fork resolves to the line's last contributing turn (`display-activity-2`), delete the old two-article/two-strip assertions.
4. `'does not show a second running indicator on an earlier turn when the streaming last turn has no displayable items'` (:1179) — final behavior: when the last turn carries a painted summary, the visible-summary guard refuses the liveness handoff, so that turn renders its own article (summary + injected live strip) and the previous turn's settled line stays: exactly 2 strips with exactly 1 running indicator (the injected strip). An EMPTY-summary fixture collapses to 1 strip whose prior line goes live.

- [x] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

Expected: PASS (all new cases plus the rewritten legacy cases) then:
Run: `npm run test:e2e -- test/e2e-browser/specs/fresh-agent.spec.ts --grep "activity line collapse"`
Expected: PASS (Task 1's failing test is now green).

- [x] **Step 5: Refactor while green**

Specific cleanups: remove the now-unused `buildBlocks` function IF nothing else uses it (check `selectLiveActivityBlockId`'s replacement consumed the last caller — delete dead code and any now-unused `options` plumbing in `FreshAgentTurnArticle`); dedupe the `messageSeenInTurn` + `flushOpen` sequence if it reads cleaner extracted; keep `buildTranscriptLayout` and the live-selection function adjacent and pure. No behavior change.

- [x] **Step 6: Run impacted-test verification**

Impacted set: every spec rendering `FreshAgentTranscript` or its children (the article/strip DOM contract changed: absorbed turns no longer render articles; strip mounting position unchanged otherwise).

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/shared/fresh-agent-turns.test.ts`

Expected: PASS — includes FreshAgentMobile.test.tsx, FreshAgentTurnActions.test.tsx, FreshAgentItemCard.test.tsx, FreshAgentSharedWidgets.test.tsx.

Then the e2e surface that touches fresh-agent DOM: `npm run test:e2e -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (the last asserts `article[data-turn-index]` counts and fork hover — absorbed-turn skipping must not regress them; those fixtures have message content between tool runs, so no absorption occurs there).

Expected: PASS.

- [x] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx \
        test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx \
        test/e2e-browser/specs/fresh-agent.spec.ts
git commit -m "feat(fresh-agent): collapse adjacent tool activity into one accumulating strip line"
```

### Task 3: Whole-surface verification + residual checks

**Files:**
- Modify: none expected.
- Test: impacted breadth only.

**Interfaces:**
- Consumes: the Task 2 implementation.
- Produces: verification receipts for the recap.

- [x] **Step 1: Reading-time sanity of the browser_use script**

Verify by inspection (no edit expected) that `test/browser_use/tool_coalesce.py`'s goal ("consecutive tool uses in an assistant turn appear as ONE strip showing 'N tools used'") remains satisfied: within-turn grouping is unchanged, and the script's per-turn lookups still find one strip per message turn. Record the conclusion in the task receipt.

- [x] **Step 2: Typecheck + lint the touched surface**

Run: `npx tsc --noEmit -p .` from the worktree and `npm run lint -- src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/e2e-browser/specs/fresh-agent.spec.ts`

Expected: PASS (eslint-plugin-jsx-a11y clean — no new interactive DOM added).

- [x] **Step 3: Confirm no other render callers construct turn blocks differently**

Run: `grep -rn "buildBlocks\|coalesceSyntheticToolResultTurns" src/ test/unit | grep -v FreshAgentTranscript.tsx || true`

Expected: EMPTY output — the transcript test and component are the only references; `FreshAgentView.tsx`/`FreshAgentMobile` consume `FreshAgentTranscript` as a component (no direct block construction). (`|| true` required: empty matches exit 1.)

- [x] **Step 4: Record outcomes and commit (only if receipts/notes were written as part of the run log)**

```bash
git add docs/plans/2026-08-23-freshagent-activity-line.md
git commit -m "docs: mark freshagent-activity-line tasks complete with verification receipts"
```

(The full-suite gate is NOT part of this plan — the the-usual-beta execution stage owns the single final full-suite run after review loops, per its contract.)

## Risks / recorded decisions

- **Fork/rewind granularity:** a merged activity line exposes its fork/rewind/context-menu actions against the line's LAST contributing turn (the most recent point the line covers), so the existing protection "fork from the latest activity turn" holds verbatim. Mid-line fork targets between absorbed turns are removed — a required consequence of rendering one line. Server fork constraints (composite `turnId`) are honored: never synthesize composite `turnId`s; the last contributor's own `turnId` passes through unchanged.
- **Streaming empty-turn suppression** only engages when the previous display turn has a trailing activity line of the same role; all other streaming-empty cases keep the current injected-strip behavior (jp70 hardening untouched).
- **Role-change = boundary** matches the user's rule because a role change paints a visible header between strips; thinking/reasoning are line content, not boundaries.

## Validated design notes (load-bearing stage, 2026-08-24)

- **Zero-item turns are real** (Rust codex `subAgentActivity` rows emit `{role:"assistant", summary:"", items:[]}`; opencode structural messages likewise) and they render real article chrome today. The layout pass hard-closes any open line on a zero-item turn — two halves of a codex tool run split by a `subAgentActivity` marker therefore stay two strips. Residual, accepted: fixing THAT split needs a provider-level turn-shape decision, out of scope for this render-rule change.
- **TS-claude item-id reuse across turns** (one provider message id spanning multiple JSONL lines yields duplicate `turn:<msg>:item:N` ids) is handled by display-only id dedupe in the absorb path; `toolUseId` stitching is verified unique (615MB × 813 real transcripts, zero repeats) and unaffected. Validator evidence (external run logs, by workflow design outside the tracked tree): `/home/dan/code/freshell/.worktrees/.the-usual-logs/freshagent-activity-line/reports/load-bearing-validator-c2.md` and `.../load-bearing-validator-n1.md`.
- **Stable line identity:** each open line's React key is a per-layout sequence `line:<n>` unique across all lines (one turn can own two), stable while the line extends — the strip keeps its DOM node (verified by an incremental rerender test asserting node identity), scroll position, and expanded state across extension; this is what distinguishes an extending open line from an after-the-fact regrouping remount.
- **Invisible items are not boundaries:** text items that render nothing (whitespace/system-reminder-only after `stripSystemReminders`; `FreshAgentItemCard` returns null for them) neither close the open line nor emit item blocks, so the visual rule "if anything renders between them" is evaluated on what actually renders.
- **Non-streaming liveness:** mirrors the old last-turn trailing-thinking rule, extended to cover a last turn that was absorbed (its items close the latest line, so the check reads that line's trailing row).
