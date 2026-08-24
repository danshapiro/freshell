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

**Architecture:** Replace per-turn `buildBlocks` strip boundaries with a transcript-level single-pass layout in `FreshAgentTranscript.tsx`. The layout walks display turns once, keeping at most one OPEN activity line: a turn's leading activity items append to the open line when the turn has the same role as the line and no message item has rendered between; any message item or role change closes the line and later activity opens a new one. The line mounts once, in the article of the turn where its first item appears; turns fully absorbed into the line render no article. Per-turn articles, fork/rewind wiring, glom indexing, and live-strip liveness all keep working: `selectLiveActivityBlockId` is re-derived from the same layout, and the empty-streaming-turn injected strip is suppressed only when an adjacent open line already carries liveness.

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

- [ ] **Step 1: Write the failing behavioral tests**

Append a new `test.describe('activity line collapse', ...)` block at the end of `test/e2e-browser/specs/fresh-agent.spec.ts`, reusing the same file's picker/*route* seeding pattern:

```ts
test.describe('activity line collapse', () => {
  const STRIP = '.fresh-agent-activity-strip'

  async function seedCollapsePane(page: Parameters<typeof openPanePicker>[0], sessionId: string, turns: unknown[]) {
    await terminal... // NOTE TO IMPLEMENTER: mirror the setup of the 'style setting persists' test:
    // 1. await terminal.waitForTerminal(); await enableClaudeAndCodex(page)
    // 2. open the pane picker, click Freshcodex, accept the first option
    // 3. page.route(`**/api/fresh-agent/threads/freshcodex/codex/${sessionId}*`) fulfilling a snapshot with
    //    { sessionType:'freshcodex', provider:'codex', threadId:sessionId, sessionId, revision:1,
    //      latestTurnId:<last turn id>, status:'idle', summary:'', capabilities:{...true}, settings:{...},
    //      tokenUsage:{...zeros}, pendingApprovals:[], pendingQuestions:[], worktrees:[], diffs:[], turns }
    // 4. page.evaluate dispatching panes/updatePaneContent to point the new freshcodex leaf at sessionId
    //    (copy the findFreshcodexLeaf walk + dispatch from the serif test, minus the style filter)
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

  test('collapses adjacent same-role tool turns into one accumulating activity line (3 + 2 = 5)', async ({ page, terminal }) => {
    await seedCollapsePane(page, 'collapse-thread', [
      { id: 'turn-user', turnId: 'turn-user', role: 'user', summary: 'read files',
        items: [{ id: 'item-user', kind: 'text', text: 'read these five files' }] },
      toolTurn('turn-a', [['c1','src/a.ts'],['c2','src/b.ts'],['c3','src/c.ts']]),
      toolTurn('turn-b', [['c4','src/d.ts'],['c5','src/e.ts']]),
    ])
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    await expect(pane.locator(STRIP)).toHaveCount(1)
    await expect(pane.locator(STRIP).first()).toContainText('5 tools used')
    await pane.getByRole('button', { name: 'Toggle activity details' }).click()
    await expect(pane.locator('.fresh-agent-tool-block')).toHaveCount(5)
    await expect(pane.locator('.fresh-agent-tool-block').nth(0)).toContainText('src/a.ts')
    await expect(pane.locator('.fresh-agent-tool-block').nth(4)).toContainText('src/e.ts')
  })

  test('an intervening message keeps two tool lines separate', async ({ page, terminal }) => {
    await seedCollapsePane(page, 'split-thread', [
      toolTurn('turn-a', [['c1','src/a.ts']]),
      { id: 'turn-msg', turnId: 'turn-msg', role: 'assistant', summary: 'note',
        items: [{ id: 'item-msg', kind: 'text', text: 'First file read.' }] },
      toolTurn('turn-b', [['c2','src/b.ts']]),
    ])
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane).toBeVisible({ timeout: 10_000 })
    await expect(pane.locator(STRIP)).toHaveCount(2)
    await expect(pane.locator(STRIP).nth(0)).toContainText('1 tool used')
    await expect(pane.locator(STRIP).nth(1)).toContainText('1 tool used')
  })
})
```

The helper prose comments marked `NOTE TO IMPLEMENTER` must be replaced with the actual copied setup code from the serif test (lines ~233–374 of the same file at base).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `npm run test:e2e -- test/e2e-browser/specs/fresh-agent.spec.ts -g "activity line collapse"`

Expected: FAIL because the first test currently finds 2 strips ("3 tools used" and "2 tools used") instead of one strip with "5 tools used". The second test (intervening message) may PASS already — that is fine and expected; it guards the boundary.

Do NOT commit. The failing e2e is staged with Task 2's commit once green.

### Task 2: Transcript-level open activity line (layout pass + render wiring + unit suite)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

**Interfaces:**
- Consumes: `FreshAgentTurn`, `FreshAgentTranscriptItem` from `@shared/fresh-agent-contract`; existing `buildActivity`, `isActivityLike`, `FreshAgentActivityStrip`, `FreshAgentTurnArticle`.
- Produces: `buildTranscriptLayout(turns: FreshAgentTurn[]): TurnLayout[]` (module-scope pure function, not exported), `selectLiveActivityBlockIdFromLayout(...)`; `FreshAgentTurnArticle` gains a `blocks: RenderBlock[]` prop and drops its internal `buildBlocks` call.

- [ ] **Step 1: Write the failing behavioral tests (new unit cases)**

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

  it('fully absorbed turns render no article and fork targets the line origin', () => {
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
    expect(onFork).toHaveBeenCalledWith('native-a')
  })
})
```

(Note: thinking items require `showThinking` default true — the component default is `true`; these turns are activity-only thinking runs merging into one line, matching the "second thought" gh-of the old :892 test.)

- [ ] **Step 2: Run the new tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx -t "activity line collapse"`

Expected: FAIL — the collapse/merge/absorb cases currently render 2/2/2/1+2/more strips and articles because strip boundaries are per-turn (per-turn `buildBlocks` in `FreshAgentTurnArticle`, `FreshAgentTranscript.tsx:497`). The 'keeps separate' and 'trailing text' cases may pass already (they assert preserved boundaries).

- [ ] **Step 3: Add the production implementation**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`:

(a) After `buildBlocks` (:225), add the transcript-level layout pass:

```ts
type TurnLayout = { blocks: RenderBlock[] }

/**
 * One OPEN activity line per transcript state: a next turn's leading
 * activity items append to the open line when the turn has the same role and
 * no message item has rendered between (a role change paints a header, so it
 * counts as "something between"). Lines are re-built from the concatenated
 * item list so buildActivity's tool_use/tool_result stitching stays intact.
 */
function buildTranscriptLayout(turns: FreshAgentTurn[]): TurnLayout[] {
  const layouts: TurnLayout[] = []
  let open: { originIndex: number; role: FreshAgentTurn['role']; items: FreshAgentTranscriptItem[] } | null = null

  const flushOpen = () => {
    if (!open) return
    const rows = buildActivity(open.items)
    if (rows.length > 0) {
      layouts[open.originIndex].blocks.push({
        kind: 'activity',
        id: open.items.map((item) => item.id).join(':'),
        rows,
      })
    }
    open = null
  }

  for (const [turnIndex, turn] of turns.entries()) {
    const layout: TurnLayout = { blocks: [] }
    layouts.push(layout)
    let messageSeenInTurn = false
    for (const item of turn.items) {
      if (isActivityLike(item)) {
        if (open && open.role === turn.role && !messageSeenInTurn) {
          open.items.push(item)
        } else {
          flushOpen()
          open = { originIndex: turnIndex, role: turn.role, items: [item] }
        }
        continue
      }
      flushOpen()
      layout.blocks.push({ kind: 'item', item })
      messageSeenInTurn = true
    }
  }
  flushOpen()
  return layouts
}
```

(b) Replace `selectLiveActivityBlockId` (:307–339) with a layout-driven version:

```ts
function selectLiveActivityBlockIdFromLayout(
  layouts: TurnLayout[],
  turns: FreshAgentTurn[],
  isStreaming: boolean,
): string | null {
  let latestActivityBlockId: string | null = null
  let lastBlocksTurn = -1
  layouts.forEach((layout, index) => {
    if (layout.blocks.length > 0) lastBlocksTurn = index
    for (const block of layout.blocks) {
      if (block.kind === 'activity') latestActivityBlockId = block.id
    }
  })
  const lastBlocks = lastBlocksTurn >= 0 ? layouts[lastBlocksTurn].blocks : []
  const lastBlock = lastBlocks[lastBlocks.length - 1]
  const trailingThinkingBlockId =
    lastBlock?.kind === 'activity' && lastBlock.rows.at(-1)?.type === 'thinking'
      ? lastBlock.id
      : null

  if (!isStreaming) return trailingThinkingBlockId

  const lastTurn = turns[turns.length - 1]
  if (lastTurn && lastTurn.items.length > 0) return latestActivityBlockId

  // Last display turn streams with zero visible items: hand liveness to an
  // adjacent open line (same role, trailing activity) instead of injecting a
  // second empty strip line below it.
  const previousIndex = turns.length - 2
  if (previousIndex >= 0 && lastTurn) {
    const previousBlocks = layouts[previousIndex]?.blocks ?? []
    const previousLast = previousBlocks[previousBlocks.length - 1]
    if (previousLast?.kind === 'activity' && turns[previousIndex].role === lastTurn.role) {
      return previousLast.id
    }
  }
  return null
}
```

(c) In `FreshAgentTranscript` (:632), compute the layout and derive liveness from it:

```ts
const displayTurns = useMemo(() => (
  filterTurnsForDisplay(coalesceSyntheticToolResultTurns(turns), displayOptions, isStreaming)
), [displayOptions, turns, isStreaming])
const turnLayouts = useMemo(() => buildTranscriptLayout(displayTurns), [displayTurns])
const liveActivityBlockId = useMemo(
  () => selectLiveActivityBlockIdFromLayout(turnLayouts, displayTurns, isStreaming),
  [turnLayouts, displayTurns, isStreaming],
)
```

(d) In the render loop (:765–780), pass blocks in and skip fully-absorbed turns:

```tsx
{displayTurns.map((turn, index) => {
  const blocksForTurn = turnLayouts[index]?.blocks ?? []
  const absorbed = turn.items.length > 0 && blocksForTurn.length === 0
  const isLastStreaming = isStreaming && index === displayTurns.length - 1
  if (absorbed) return null
  if (isLastStreaming && blocksForTurn.length === 0 && turn.items.length === 0 && liveActivityBlockId !== null) return null
  return (
    <FreshAgentTurnArticle
      key={`${getFreshAgentDisplayTurnKey(turn)}:${index}`}
      turn={turn}
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
3. `'keeps adjacent activity-only display turns distinct and actionable'` (:892) — replace with the new absorb/fork-origin test from Step 1 (last case), delete the old two-article/two-strip assertions.
4. `'does not show a second running indicator on an earlier turn when the streaming last turn has no displayable items'` (:1179) — new expected behavior: exactly 1 strip total (the injected empty strip is suppressed; the previous turn's line carries the live reel), one `running` indicator, and the settled text `'1 tool used'` is NOT shown while live.

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

Expected: PASS (all new cases plus the rewritten legacy cases) then:
Run: `npm run test:e2e -- test/e2e-browser/specs/fresh-agent.spec.ts -g "activity line collapse"`
Expected: PASS (Task 1's failing test is now green).

- [ ] **Step 5: Refactor while green**

Specific cleanups: remove the now-unused `buildBlocks` function IF nothing else uses it (check `selectLiveActivityBlockId`'s replacement consumed the last caller — delete dead code and any now-unused `options` plumbing in `FreshAgentTurnArticle`); dedupe the `messageSeenInTurn` + `flushOpen` sequence if it reads cleaner extracted; keep `buildTranscriptLayout` and the live-selection function adjacent and pure. No behavior change.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every spec rendering `FreshAgentTranscript` or its children (the article/strip DOM contract changed: absorbed turns no longer render articles; strip mounting position unchanged otherwise).

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/shared/fresh-agent-turns.test.ts`

Expected: PASS — includes FreshAgentMobile.test.tsx, FreshAgentTurnActions.test.tsx, FreshAgentItemCard.test.tsx, FreshAgentSharedWidgets.test.tsx.

Then the e2e surface that touches fresh-agent DOM: `npm run test:e2e -- test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/fresh-agent-mobile.spec.ts test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (the last asserts `article[data-turn-index]` counts and fork hover — absorbed-turn skipping must not regress them; those fixtures have message content between tool runs, so no absorption occurs there).

Expected: PASS.

- [ ] **Step 7: Commit the task**

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

- [ ] **Step 1: Reading-time sanity of the browser_use script**

Verify by inspection (no edit expected) that `test/browser_use/tool_coalesce.py`'s goal ("consecutive tool uses in an assistant turn appear as ONE strip showing 'N tools used'") remains satisfied: within-turn grouping is unchanged, and the script's per-turn lookups still find one strip per message turn. Record the conclusion in the task receipt.

- [ ] **Step 2: Typecheck + lint the touched surface**

Run: `npx tsc --noEmit -p .` from the worktree and `npm run lint -- src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/e2e-browser/specs/fresh-agent.spec.ts`

Expected: PASS (eslint-plugin-jsx-a11y clean — no new interactive DOM added).

- [ ] **Step 3: Confirm no other render callers construct turn blocks differently**

Run: `grep -rn "buildBlocks\|coalesceSyntheticToolResultTurns" src/ test/unit | grep -v FreshAgentTranscript.tsx`

Expected: only the transcript test references; `FreshAgentView.tsx`/`FreshAgentMobile` consume `FreshAgentTranscript` as a component (no direct block construction).

- [ ] **Step 4: Record outcomes and commit (only if receipts/notes were written as part of the run log)**

```bash
git add docs/plans/2026-08-23-freshagent-activity-line.md
git commit -m "docs: mark freshagent-activity-line tasks complete with verification receipts"
```

(The full-suite gate is NOT part of this plan — the the-usual-beta execution stage owns the single final full-suite run after review loops, per its contract.)

## Risks / recorded decisions

- **Fork/rewind granularity:** a turn fully absorbed into an open line is no longer a fork/rewind target (its article does not render); the line's origin turn is the target. Server fork constraints (composite `turnId`) are honored: we never synthesize composite `turnId`s; the origin turn's own `turnId` is passed through unchanged.
- **Streaming empty-turn suppression** only engages when the previous display turn has a trailing activity line of the same role; all other streaming-empty cases keep the current injected-strip behavior (jp70 hardening untouched).
- **Role-change = boundary** matches the user's rule because a role change paints a visible header between strips; thinking/reasoning are line content, not boundaries.
