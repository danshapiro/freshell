# Compact Fresh Agent Panels Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Improve the panels above the Fresh Agent conversation across all Fresh Agents so large content cannot crowd out the conversation and latest user prompt.

### Explicit constraints
- Collapse Diffs by default into a compact row showing the changed-file count, and open detailed changes in a side panel.
- Keep requests needing the user's answer visible while collapsing long command arguments and other details.
- Combine routine notices into a compact status row; allow errors to expand for details and recovery actions.
- Limit the whole stack's height so the conversation and latest prompt retain useful space.
- Use the-usual workflow.
- Follow repository worktree, testing, commit, and PR approval rules; do not deploy or restart production.
- Check for an existing KataTracker report before filing the baseline failure.

### Accepted tradeoffs and residuals
- The failed baseline runtime build is waived for this task; retain the failure evidence and track it in KataTracker.

**Goal:** Every Fresh Agent keeps conversation and the latest prompt usable when changes, requests, notices, and errors are large or simultaneous.

**Architecture:** Change presentation in the existing provider-independent FreshAgentView, preserving its state, transport, ownership fences, and callbacks. Keep Diffs as a counted trigger opening a right-side dialog containing the existing file diff controls; use native disclosures for request details and grouped errors. Give the pane root ownership of the combined height of responsive metadata and the top stack, with requests before diagnostics in its own scroll flow, reserving useful actual transcript space and keeping the entire composer reachable. Preserve the wide metadata side column.

**Tech Stack:** React 18, TypeScript, existing Tailwind/CSS themes, Testing Library/Vitest, Playwright; no new dependencies or server/protocol changes.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/fresh-agent-compact-panels`, branch `the-usual/fresh-agent-compact-panels`, immutable base `6b1c961baf8301dc7ebf8d5fdca7105fbfca9cdb`. Follow AGENTS.md for tests, coordinator, sandbox, focused commits, and PR approval. Do not deploy or restart production.
- pnpm is pinned exactly to 10.34.5. Use repo test entrypoints; new relative imports use `.js`. Run tests in this worktree, reusing dependencies; ad hoc output belongs in `test-results/` and disposable data in `.test-tmp/`.
- Both test backends are already configured `cloud`. Do not silently substitute local when cloud fails. Broad gates use `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1`.
- Baseline preflight failed before integration/server execution; the user waived it. Evidence: `../.the-usual-logs/fresh-agent-compact-panels/reports/baseline-failure.md` and `workspace-baseline.md`. Existing KataTracker issue `freshell#qptf` (`01M6B53S9GZJKAS9GQGVBQQPTF`) tracks it after the coordinator checked existing reports. Do not file a duplicate or call the full baseline green.
- Preserve all existing approval decisions, plan feedback semantics, native provider decision restrictions, question/secret/multiselect input, elicitation validation and URL responses, recovery actions, disabled conditions, notice dismissals, diff lazy load/retry/404 mapping, inline native patch replacement, context-menu metadata, and composer comments. No automatic answers or focus changes when background updates arrive.
- Requests must remain outside disclosures for routine status/errors. Their identity, reason, inputs needed to answer, and answer controls remain accessible; only verbose arguments, patch/plan previews, and diagnostic details collapse. When requests exceed the bound they scroll, with an always-visible count in the stack header; no request is discarded.
- Use semantic buttons, summaries, labeled dialog/regions, visible focus, default/serif/mono and light/dark theme variables. New routine messages use `role="status"`; new errors have a concise alert summary even while details are closed. Reuse existing diagnostics; presentation toggles need no new logging pipeline.
- README is the only end-user Markdown documentation. Update `docs/index.html` for this significant UI change. No backend, persistence, capability, or dependency changes.

---

## File responsibilities and interfaces

1. `src/components/fresh-agent/FreshAgentDiffPanel.tsx`: counted Diffs trigger and existing file rendering, fetching and comments. Keep its existing public props `{ diffs: DiffSummary[]; cwd?: string; onComment?: (text: string) => void }`; add optional `paneRoot?: HTMLElement | null` for portal presentation/context and optional `scopeKey?: string` solely to reset open/fetched state on conversation identity changes. Export `DiffSummary` and a small count-result interface distinguishing an established exact file count from unresolved cardinality; no parser dependency. Accept only existing frontend identity metadata where needed, without changing server contracts.
2. `src/components/fresh-agent/FreshAgentDiffDrawer.tsx` (new): presentational right-side portal dialog, `({children: ReactNode, onClose: () => void, paneRoot: HTMLElement})`; focus trap/return and Escape. Follow `FreshAgentChildObserver.tsx` focus pattern and `OVERLAY_Z.modal` from `src/components/ui/overlay.ts`.
3. `src/components/fresh-agent/FreshAgentApprovalCard.tsx` and `FreshAgentPlanApprovalCard.tsx`: native closed `<details>` around verbose payload/plan only, keeping current public props and decisions.
4. `src/components/fresh-agent/FreshAgentNoticeStack.tsx` (new): grouped routine messages and error disclosures. Props `{ notices: Array<{id: string; text: string}>; errors: Array<{id: string; summary: string; content: ReactNode}> }`. It renders nothing for two empty arrays; no callbacks/state/transport ownership.
5. `src/components/fresh-agent/FreshAgentView.tsx:5178`: keep lifecycle branches and handlers in View, pass their original JSX as error `content`, reorder requests ahead of diagnostics, render a request count, and pass the existing live session identity to Diffs. Preserve question/elicitation components unchanged.
6. `src/index.css:125`: common structural height/scroll rules and side-dialog sizing, with necessary serif/mono overrides near existing stack/card selectors at lines 324/854.
7. Existing focused unit tests listed in tasks: preserve and extend behavioral assertions, opening disclosures before asserting hidden preview contents. New `FreshAgentNoticeStack.test.tsx` covers notice grouping/error callbacks; dialog tests live with DiffPanel tests.
8. New `test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts`: real browser presentation geometry and interactions on the configured cloud backend, independent of server provider availability. `README.md` documents controls; `docs/index.html` mirrors compact state.

### Task 1: Collapsed counted Diffs with accessible side details

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentDiffPanel.tsx:1`
- Create: `src/components/fresh-agent/FreshAgentDiffDrawer.tsx`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:5441`
- Modify: `src/index.css:125`
- Test: `test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx`
- Modify/Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` and `FreshAgentTranscript.claude-real-cli.test.tsx` in the same directory (open Changes before existing diff assertions).
- Modify if needed: `src/components/context-menu/ContextMenu.tsx`, `ContextMenuProvider.tsx`, and their existing behavioral tests, solely for context menus originating inside Changes.

**Interfaces:**
- Consumes existing `DiffSummary = { id: string; path?: string; title?: string; status?: string; diff?: string }`, `api.get<{diff: string}>`, and `onComment(text)`.
- Produces a count result with exact count or explicitly unresolved total, existing DiffPanel props plus optional `paneRoot` and `scopeKey` and narrowly scoped existing identity metadata if needed, and `FreshAgentDiffDrawer({children, onClose, paneRoot})`. Task 2 places the trigger outside request overflow; Task 3 exercises the dialog through its public controls.

- [ ] **Step 1: Write the failing behavioral test**

Add to existing DiffPanel suite (reuse its imports/mocked api):

```tsx
it('qualifies unresolved path namespaces and opens changes only on demand', async () => {
  const user = userEvent.setup()
  render(<FreshAgentDiffPanel diffs={[
    { id: 'one', path: '/repo/one.ts' },
    { id: 'native', title: 'Turn changes', diff: 'diff --git a/one.ts b/one.ts\n--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/two.ts b/two.ts\n--- a/two.ts\n+++ b/two.ts\n@@ -1 +1 @@\n-x\n+y' },
  ]} cwd="/repo" />)
  const trigger = screen.getByRole('button', { name: 'Diffs: 1 listed file; total unavailable' })
  expect(screen.queryByRole('button', { name: 'Diff: Turn changes' })).toBeNull()
  expect(apiGet).not.toHaveBeenCalled()
  await user.click(trigger)
  expect(screen.getByRole('dialog', { name: 'Changes' })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Diff: Turn changes' }))
  expect(screen.getByText('+new')).toBeVisible()
  expect(apiGet).not.toHaveBeenCalled()
  await user.keyboard('{Escape}')
  expect(screen.queryByRole('dialog', { name: 'Changes' })).toBeNull()
  expect(trigger).toHaveFocus()
})
```

Also add focused cases for ordinary duplicate paths; native multi-file additions/deletions/rename/binary headers, quoted spaces and escaped Git paths; overlap between ordinary/native paths; empty native patches yielding zero; pathless/opaque summaries producing an explicitly unavailable total rather than counting ids as files; absolute structured paths overlapping Git-root-relative headers when cwd is a subdirectory; unproved bases remaining qualified; source/destination rename identity; empty/invalidation native patches retaining structured rows; and inline patch replacement updating count while open. Count actual paths, never hunks or lines resembling paths inside file content. Add keyboard Tab/Shift+Tab wrapping, Close/outside dismissal, comment insertion/closing focus, and scope change closing and dropping fetched old file content. Add a Space-key activation regression that leaves composer text/focus untouched, and a context-menu regression verifying pane/file identity, visible menu above Changes, first Escape closing the menu and second closing Changes. Verify live serif/mono style changes while open propagate to the portal.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL because the counted compact trigger and Changes dialog do not exist. Existing tests still describe inline list rendering; adapt those tests in Step 3 while retaining their original assertions after opening Changes.

- [ ] **Step 3: Add the minimal production implementation**

Apply this precise patch design:

1. Export `DiffSummary`; derive an exact count only when available file identities establish it. Parse real file-header blocks, including quoted Git paths and the pinned Codex builder's unquoted paths containing spaces, without mistaking hunk content for headers. Ordinary Codex paths are absolute, while native headers may be Git-root-relative, use a different environment base, or represent a rename destination instead of its structured source. Do not assume cwd is the Git root, infer equality from suffixes, or blindly union those namespaces. Reuse already available merged transcript/native identity data only where its identity, completeness and currentness are established; otherwise keep the total explicitly unresolved. Use a compact numeric changed-file count whenever established; if only structured listed file identities are established, use `Diffs: ${count} listed file${count === 1 ? '' : 's'}; total unavailable`, and if none are established say `Diffs: file count unavailable`. Relative structured paths do not establish a shared Git-root namespace merely because cwd exists. Exact-count fixtures therefore use native headers only (no structured rows); the explicit mixed fixture above uses absolute structured paths with no proven root and must stay qualified. Add an exact two-native-file case and a production-shaped absolute Codex plus `codex-turn` patch case expecting `Diffs: 1 listed file; total unavailable`. Keep every original detail accessible. Opaque nonempty patches and pathless summaries do not prove one file; empty native patches do not erase structured file rows. No backend, new provider calls, general diff engine, or new fetch is required. Evidence and source semantics: `../.the-usual-logs/fresh-agent-compact-panels/reports/load-bearing-validator-lb-1.md`.
2. Replace DiffPanel's inline list with a single button: accessible name `Diffs: ${count} changed file${count === 1 ? '' : 's'}` for an established exact count, or the qualified/unavailable wording above, visible `Diffs` and its count state, `aria-haspopup="dialog"`, `aria-expanded={open}`. Return null only when diffs is empty, keeping an explicit zero native patch honest. Do not mount file controls or issue GET requests before open. On open render the existing list unchanged inside the drawer. Key the stateful inner panel by `scopeKey ?? cwd ?? ''`; View supplies `liveSessionKey`, so a changed conversation remounts/cleans state even if file ids/cwd coincide. Ordinary live diff replacement in the same scope must remain live.
3. Drawer portal structure: backdrop using `OVERLAY_Z.modal`, `<section role="dialog" aria-modal="true" aria-label="Changes">`, heading, semantic Close button, independently scrolling body. Right-align `width:min(38rem,100vw)` and full available viewport height; `min-width:0`, overflow wrapping, background/foreground theme variables. The required `paneRoot` is the owning Fresh Agent DOM root, obtained by a View callback ref as `paneRootElement` (null before mount) and passed through DiffPanel (add optional `paneRoot?: HTMLElement | null` to DiffPanel props; direct tests may resolve the trigger's closest Fresh Agent root, or use the document root for the default style; themed tests provide a themed root). Copy its Fresh Agent style classes, computed `--fresh-agent-*` variables, and `data-context`/`data-pane-id` onto the body portal wrapper, keeping inner file metadata intact; refresh copied style values when the owning pane style/theme changes while open. Narrow screens use full width; this is still the same right-side panel. Avoid duplicating the existing file renderer.
4. Mount effect remembers `document.activeElement`, focuses Close, and on unmount returns focus only when the remembered element is connected and focus is still inside the dialog/backdrop or body. Escape closes without reaching pane shortcuts; Tab/Shift+Tab wrap among current enabled focusable controls, re-querying after expansion. Backdrop click closes only on the backdrop itself. Do not refocus on diff updates. View capture must return immediately for event targets within this drawer before plain-key forwarding; verify Space activates a drawer button without modifying/focusing composer. Make comment controls visible while the drawer is open, including keyboard use; trap only rendered, visible, enabled controls. Preserve nested context menus and copy metadata; ensure a menu opened from this wrapper renders above this modal using a narrowly scoped menu-origin layer (extend existing menu components only if needed; leave ordinary menus unchanged); allow their normal close handling before an outer Escape consumes it. Comment buttons call the existing callback, close the drawer, then let the composer insertion focus win instead of returning focus to the trigger.
5. Keep existing lazy GET, retry/404 message, native supplied diff precedence, line numbering/comments and `data-file-path` metadata. Drawer unmount cleans its children; no new fetch/persist logic. Add structural CSS scoped to drawer classes; do not override global overlays.

- [ ] **Step 4: Run the focused test**

Run the Step 2 command. Expected: PASS, including adjusted existing load/retry/comment tests and the new count/focus cases.

- [ ] **Step 5: Refactor while green**

Keep file rendering separate from dialog lifecycle, remove duplicate parsing/count branches, and use one helper for Git path decoding. Do not extract a global dialog abstraction for one feature. Rerun Step 2 after cleanup.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.approvals.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.claude-real-cli.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS. These exercise the changed consumer and existing composer/approval wiring. Task 3 runs all fresh-agent client tests and browser coverage.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentDiffPanel.tsx src/components/fresh-agent/FreshAgentDiffDrawer.tsx src/components/fresh-agent/FreshAgentView.tsx src/index.css test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.claude-real-cli.test.tsx
# Also stage only the task-owned context-menu files/tests if changed.
git commit -m "feat: move Fresh Agent changes into a compact side panel"
```

### Task 2: Compact requests and grouped diagnostics within a bounded stack

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentApprovalCard.tsx:63`
- Modify: `src/components/fresh-agent/FreshAgentPlanApprovalCard.tsx:75`
- Create: `src/components/fresh-agent/FreshAgentNoticeStack.tsx`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:5178`
- Modify: `src/index.css:125`
- Test: `test/unit/client/components/fresh-agent/FreshAgentNoticeStack.test.tsx` (new)
- Test: `test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentPlanApprovalCard.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.approvals.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Modify/Test as identified by the lifecycle assertion audit: affected existing `test/unit/client/` and `test/e2e/*.test.tsx` tests; preserve each behavioral check and include each modified file in focused verification and the task commit.

**Interfaces:**
- Consumes unchanged approval/plan props and View's existing JSX recovery handlers. Uses Task 1 DiffPanel with `scopeKey={liveSessionKey}`.
- Produces `FreshAgentNoticeStack({notices, errors})` with the exact types above; no server/store changes. Existing question and elicitation props stay unchanged.

- [ ] **Step 1: Write the failing behavioral test**

Add imports `userEvent` and this test to ApprovalCard's existing suite:

```tsx
it('keeps answers visible while arguments are collapsed', async () => {
  const user = userEvent.setup()
  const { onRespond } = renderCard({
    requestId: 'compact-command', toolName: 'Bash',
    decisionReason: 'Needs your permission', input: { command: 'printf '.repeat(500) },
  })
  expect(screen.getByText('Needs your permission')).toBeVisible()
  expect(screen.getByText('printf '.repeat(500), { normalizer: value => value })).not.toBeVisible()
  expect(screen.getByRole('button', { name: 'Allow tool use' })).toBeVisible()
  await user.click(screen.getByText('Command details'))
  expect(screen.getByText('printf '.repeat(500), { normalizer: value => value })).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Allow tool use' }))
  expect(onRespond).toHaveBeenCalledExactlyOnceWith({ behavior: 'allow' })
})
```

New NoticeStack suite imports React/Testing Library/Vitest/userEvent and the new component; its central test is:

```tsx
it('groups routine notices and preserves recovery behind an error summary', async () => {
  const user = userEvent.setup()
  const retry = vi.fn()
  render(<FreshAgentNoticeStack
    notices={[{ id: 'restoring', text: 'Restoring session...' }, { id: 'notice', text: 'Settings updated' }]}
    errors={[{ id: 'load', summary: 'Conversation could not load', content: <button onClick={retry}>Retry history</button> }]}
  />)
  expect(screen.getByRole('status', { name: 'Agent notices' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Retry history' })).toBeNull() // hidden content excluded from role query
  expect(screen.getByRole('alert')).toHaveTextContent('Conversation could not load')
  await user.click(screen.getByText('Conversation could not load'))
  await user.click(screen.getByRole('button', { name: 'Retry history' }))
  expect(retry).toHaveBeenCalledOnce()
})
```

Retain the existing short Bash `git push origin main` visible-preview assertion. Add short native exec command visibility and long native command disclosure cases, including a visible bounded command identity outside details. Add native-decision and Edit preview disclosure cases; plan text closed initially but feedback and all four decisions retained; toggling details never answers. Preserve tests for feedback disabling approvals. Extend View approvals suite across Claude/Kilroy/Codex and existing question/elicitation suites via regression execution: details closed must not suppress response payloads or disabled guards. Add View cases showing routine notices in one status row, error summary then expansion/dismiss/retry, and pending questions/elicitation outside diagnostic disclosures. Exercise stuck restart/new-conversation, owner-fenced recovery, handoff actions, and ended resume via existing fixtures after expanding their error summaries.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx test/unit/client/components/fresh-agent/FreshAgentPlanApprovalCard.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL for initially visible long payload and missing Command details disclosure. For NoticeStack, first create only an importable empty component stub with its declared props, then add and run the central test with `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentNoticeStack.test.tsx --config config/vitest/vitest.config.ts`; expect a behavioral failure for missing grouped status/error controls. Do not count a missing-module failure as red. Implement the component in Step 3.

- [ ] **Step 3: Add the minimal production implementation**

Apply these exact structural changes, leaving all existing callback expressions and disabled predicates unchanged:

1. Preserve short commands inline. Define verbose as a preview exceeding 240 characters or 3 lines; use this same deterministic rule for shared and native commands. For long commands show a bounded command identity (tool plus first command line prefix, capped at 80 characters) outside closed `Command details`, with the complete exact command in the disclosure. Never truncate the only copy of the command. Native exec must expose its short command inline rather than burying it in JSON; only verbose arguments/other JSON details collapse into `Request details`. Keep existing short previews unchanged; verbose Edit/patch payloads may use `Request details`. Keep tool/path/reason and all decision buttons outside. Put a long permission suggestion list inside separate closed `Permission changes`, retaining its `suggestionsId`, mounted description and exact update payload. Preview containers use `max-height:10rem; overflow:auto; overflow-wrap:anywhere`. Use native closed details with payload mounted (no conditional mounting); tests assert visibility through the disclosure rather than text absence.
2. Plan card wraps only `fresh-agent-plan-body` in closed `Plan details`; retain path, feedback textarea, note hint, all three approval buttons and Keep planning outside. Limit open plan body to 10rem. Do not reset typed feedback on toggle. Key existing cards by requestId as now; a newly arrived request must start closed.
3. NoticeStack renders one `role="status" aria-label="Agent notices"` compact row for routine notices, displaying their count and a closed `Notice details` disclosure containing the individual full texts; single routine text may be displayed directly but is line-clamped with full text in disclosure. Errors render a count and individually closed `<details>` keyed by id, with `<summary><span role="alert">{summary}</span></summary>` and `content` always mounted inside native details, hidden while closed. Error summaries are concise fixed labels, never full stack traces or arbitrary-length error strings. Full original messages/actions remain in content. Dismissal removes the source using the original callback; no new error state cache. Closing/reopening must not unmount recovery components or reset their local errors/timers; add a regression clicking the handoff/fenced delayed action, closing details during its 750ms delay, and verifying the action still runs once. Request removal or conversation unmount retains existing cleanup semantics. Recovery callbacks can unmount the disclosure without focus stealing.
4. View replaces the unbounded children sequence with:

```tsx
<div className="fresh-agent-top-stack" role="group" aria-label="Agent requests and status">
  {requestCount > 0 ? <div className="fresh-agent-request-count" role="status">{requestCount} pending {requestCount === 1 ? 'request' : 'requests'}</div> : null}
  <div className="fresh-agent-top-stack-scroll" role="region" aria-label="Pending requests and notices">
    {/* Existing pendingApprovals, pendingElicitations and pendingQuestions maps, unchanged, in that order. */}
    {/* Existing managed runtime recovery decision card, when its current predicate is true, unchanged and visible. */}
    <FreshAgentNoticeStack notices={routineNotices} errors={visibleErrors} />
  </div>
  <FreshAgentDiffPanel diffs={projectedDiffs} cwd={paneContent.initialCwd ?? agentSession?.cwd} scopeKey={liveSessionKey} paneRoot={paneRootElement} onComment={(text) => composerRef.current?.insertText(text)} />
</div>
```

`paneRootElement` is the owning root element obtained with a callback ref in View (null before mount); use it for Task 1 portal context. `requestCount = pendingApprovals.length + (snapshot?.pendingElicitations?.length ?? 0) + pendingQuestions.length + (isManagedRuntimeRecoveryDecision(paneContent.recoverySummary) ? 1 : 0)`. Native scroll region has no explicit tabIndex, avoiding the repository noninteractive-tabindex lint rule; its child request/disclosure controls provide keyboard access. Do not render an empty scroll region or empty stack padding when no content exists. Routine entries are restoring (`isRestoring`), reconciliation (`paneContent.reconcileNotice`), `notice`, and passive owner transition. Error entries retain the current branch predicates/precedence: create, visible restore, pane restore, load, session error, close, stuck, fenced/terminal divergence, handoff, ended. Use stable ids matching those names; summary labels respectively: `Agent could not start`, `Restore failed`, `Pane restore failed`, `Conversation could not load`, `Agent error`, `Close failed`, `Agent appears stuck`, `Session needs recovery`/`Session opened elsewhere`, `Reopen failed`, `Session ended`. Managed runtime recovery is exclusively a visible request, never a diagnostic error entry. For every entry, move the entire current JSX and handlers into `content`; do not reconstruct or simplify lifecycle decisions. Keep the fenced-versus-terminal-versus-transition exclusive chain. A managed recovery decision that itself asks for a user choice belongs with visible requests (count it as one), rather than hiding that required answer under a diagnostic disclosure. Keep its existing card and actions intact. Error labels never replace full error messages in the expanded body.
5. Common CSS: give the Fresh Agent pane root the vertical size ownership, preserving its existing width-query behavior. When metadata is above main (below the existing 900px breakpoint), metadata and the top stack must share one pane-relative budget rather than independently consuming an 8rem metadata allowance and a main-relative stack allowance. Reserve at least 64px of actual transcript space at the supported 320px pane-root height, and retain the whole ordinary composer/status controls. Compact or scroll the existing metadata and request contents within the remaining budget; preserve all existing metadata controls and the wide side-column arrangement. Keep the top stack flex-shrinkable with zero minimum dimensions and modest included padding; its aggregate bound must account for the metadata sibling. Do not impose a minimum that pushes the pane beyond its root. The exact CSS is chosen against Task 3 browser measurements, not prescribed by an unexecuted formula. Evidence: `../.the-usual-logs/fresh-agent-compact-panels/reports/load-bearing-validator-lb-2.md`. `.fresh-agent-top-stack-scroll` has `min-height:0; overflow:auto; overscroll-behavior:contain; flex:1 1 auto`; count and diff trigger have `flex:0 0 auto` with compact heights. Remove `space-y-2` and neutralize old serif/mono child-margin/gap overrides that expand this stack. Set `min-width:0` and wrapping on cards/actions; do not force horizontal overflow for unbroken commands. If all fixed header/trigger space would consume a very short pane, allow the whole stack to scroll as fallback rather than clipping controls. Preserve transcript wrapper `flex-1 min-h-0` and composer. Browser tests in Task 3 decide whether values need tightening; no hard minimum height may force the page past the pane.

- [ ] **Step 4: Run the focused test**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx test/unit/client/components/fresh-agent/FreshAgentPlanApprovalCard.test.tsx test/unit/client/components/fresh-agent/FreshAgentNoticeStack.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.approvals.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS. Keep short-command assertions unchanged; open details only for verbose previews and open the matching error for positive recovery checks, retaining all original callback/payload checks. Audit every negative diagnostic/recovery assertion in client unit tests, `test/e2e/*.test.tsx`, and browser specs. Assert absence of the corresponding summary/entry by stable id or exact summary (including `Agent error` without the old colon), rather than absence/hiddenness of collapsed messages/buttons. When an entry is expected but an action forbidden, open that entry before checking the forbidden action. Cover session-ended/stuck/owner recovery and live managed recovery predicates explicitly; add a mutation check that deliberately admits the forbidden entry and confirms the updated absence check fails. Restore immediately and retain red evidence. Do not replace behavior tests with prose or class assertions. Run `pnpm run lint` in this task too; expect PASS.

- [ ] **Step 5: Refactor while green**

Use one local disclosure helper only if shared/native previews need identical state logic; keep it in ApprovalCard unless another consumer actually needs it. Remove duplicate top-stack banner render branches after moving them; verify each original predicate/handler survives exactly once. Keep form state in its current request component; never hide requests in the routine NoticeStack. Rerun Step 4.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`

Record each additional impacted client or `test/e2e/*.test.tsx` path found by the assertion audit and append those concrete paths to the preceding Vitest command before dispatch; expect all to PASS.

Run: `pnpm run typecheck:client`

Expected: PASS. This directory covers shared View lifecycle, question/elicitation, theme/mobile controls, status strip, and diffs affected by shared layout. Real geometry is verified in Task 3; jsdom passing is insufficient for height claims.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentApprovalCard.tsx src/components/fresh-agent/FreshAgentPlanApprovalCard.tsx src/components/fresh-agent/FreshAgentNoticeStack.tsx src/components/fresh-agent/FreshAgentView.tsx src/index.css test/unit/client/components/fresh-agent/FreshAgentNoticeStack.test.tsx test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx test/unit/client/components/fresh-agent/FreshAgentPlanApprovalCard.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.approvals.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
# Also stage each additional affected unit/test-e2e file identified by the assertion audit after reviewing its diff.
git commit -m "feat: keep Fresh Agent requests compact and bound panel height"
```

### Task 3: Prove pane space, keyboard safety, and all-provider/theme parity in browser

**Files:**
- Create: `test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts`
- Modify: affected existing browser specs from the mandatory Task 3 Step 6 command, including `fresh-agent.spec.ts:1160`; inspect all and edit only affected assertions.
- Modify: `README.md`
- Modify: `docs/index.html`
- Modify only if browser evidence requires: `src/index.css:125`, the task-owned Fresh Agent components above.

**Interfaces:**
- Consumes Tasks 1–2 semantic controls, `window.__FRESHELL_TEST_HARNESS__`, `test, expect` from `../helpers/fixtures.js`, `openPanePicker(page)` from `../helpers/pane-picker.js`, and routed snapshot/diff APIs. Browser rendering uses real production components/styles; routed data avoids depending on installed provider daemons.
- Produces a cloud-executed, non-skipped regression spec and updated existing diff/style interactions. No production test hook is introduced.

- [ ] **Step 1: Write the failing behavioral test**

Create this spec using the fixtures imports above and `Page` from `@playwright/test`. Define local `seedCompactPane(page: Page, variant: {sessionType: string; provider: string; style: 'sans' | 'serif' | 'mono'; theme: 'light' | 'dark'}): Promise<void>` with these precise setup steps:

1. Copy the existing local `enableFreshClientsAndOpencode`, `routeThreads`, `routeFileApis`, and `createFreshopencodePane` logic from `freshopencode-model-picker.spec.ts:64–229` into the new spec, not into shared infrastructure. Keep all network suppression BEFORE picker selection and route APIs BEFORE assigning the session. Use the same OpenCode picker route as a neutral seed, then update the actual fresh leaf via `panes/updatePaneContent` to the requested sessionType/provider/style and a synthetic id `compact-${sessionType}`. Set pane `settingsDismissed:true`, `reconcileNotice:'Session restored'`, `createError:{message:'Detailed create diagnostic '.repeat(200), retryable:true}`. Set the local app theme using `settings/updateSettingsLocal` with `{theme}`.
2. Route `**/api/fresh-agent/threads/**` to return the variant identity, status idle, revision 1, send/interrupt/approvals/questions true, tokenUsage zeros, standard settings and no worktrees in the base case. Add a required populated-metadata variant with enough valid worktrees or Codex plan steps to fill the previous sidebar allowance. For the base exact-count fixture use one established path namespace. Also add an unresolved-base/qualified-count variant. For exact count set `diffs` to one native inline patch containing 30 unique Git file-header blocks for `src/file-N.ts`, without structured rows. For qualified count use 30 absolute `/repo/src/file-N.ts` structured rows plus that native patch and no proven Git root; assert `Diffs: 30 listed files; total unavailable`. Set one Bash pending approval `{requestId:'long-command',toolName:'Bash',input:{command:'printf long-argument '.repeat(1000)}}`, one question `{requestId:'question-1',questions:[{question:'Continue?',header:'Confirm',options:[{label:'Yes',description:'Continue'},{label:'No',description:'Stop'}],multiSelect:false}]}`, and `pendingElicitations:[{requestId:'elicitation-1',mode:'form',serverName:'Fixture',message:'Enter a name',fields:[{id:'name',title:'Name',type:'string',required:true}]}]`. Seed `turns:[{id:'user-1',turnId:'user-1',role:'user',summary:'',items:[{id:'message-1',kind:'text',text:'Latest prompt must remain readable'}]}]`; keep snapshot/message schemas valid rather than casting invalid fixtures.
3. Return only after the latest prompt is rendered, snapshot route hit count is positive, and counted Diffs control is present. Store no filesystem data and start no provider process. Existing global network suppression must also cover later response clicks; payload correctness is already tested in Task 2's integrated unit tests.

Implement the geometry helper using these acceptance rules, then use the primary test body below: measure the actual Fresh Agent pane content root, responsive metadata, top stack, the actual transcript wrapper and its visible clipping region, and the whole composer form including action buttons. Assert at least 64px actual transcript height and latest-prompt intersection entirely inside that visible region; keep the whole composer and its controls within the root. Check the combined above-conversation budget rather than only a percentage of main. Do not count status-strip or composer padding as transcript space. Add a stable semantic region or test locator only if the existing transcript wrapper cannot be identified reliably. The helper must test populated and empty metadata states with explicit 100% and supported 125% UI scale. No new code example is prescribed until implementation executes it. Primary test body:

```ts
// Implement assertUsefulSpace from the acceptance rules immediately above.
// The previous main-relative helper was removed because it excluded metadata
// and counted status/composer padding as transcript space.

for (const [sessionType, provider] of [
  ['freshclaude', 'claude'], ['kilroy', 'claude'],
  ['freshcodex', 'codex'], ['freshopencode', 'opencode'],
]) {
  test(`${sessionType} preserves space with simultaneous panels`, async ({ freshellPage, page, terminal }) => {
    void freshellPage
    await terminal.waitForTerminal()
    await seedCompactPane(page, { sessionType, provider, style: 'sans', theme: 'light' })
    await assertUsefulSpace(page)
    await page.getByRole('button', { name: 'Diffs: 30 changed files' }).click()
    const dialog = page.getByRole('dialog', { name: 'Changes' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Diffs: 30 changed files' })).toBeFocused()
    await assertUsefulSpace(page)
  })
}
```

Add the same measured assertions for (a) phone 390×844, (b) desktop viewport with an actual horizontally split pane whose Fresh Agent content root is 320–400px high, including populated metadata, (c) a narrow vertical split 360–420px wide, (d) all three styles and both themes. Keep the matrix bounded: use four providers at ordinary desktop plus one shared provider for the six style/theme combinations at short/narrow sizes, and phone in light/dark. Use existing pane split UI/harness action to create actual split layouts; do not simulate short panes solely with viewport height. At a 320px pane-root height, including populated metadata and 125% UI scale, the latest prompt and at least 64px actual transcript space must remain available; adjust compact spacing rather than weakening the assertion.

Interaction cases scroll the request region to each question/elicitation/approval, assert center-point `elementFromPoint` hits the actual control before activation, and submit answers using real buttons. Expand command and error details simultaneously and rerun space assertions. Exercise native decisions and plan feedback in a separate fixture variant; preserve 44px mobile touch controls. Open drawer, Tab/Shift+Tab through file/comment/close controls, verify no escape into composer until close, comment then verify composer text/focus, close with Escape and trigger focus return, update native patch while open, and switch conversation while open to prove no stale panel. Background notices/snapshot updates while composer is focused must leave typing focus intact. Assert no horizontal document/pane overflow; inspect theme text/background contrast using the existing browser style helper pattern and retain screenshots for review.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e fresh-agent-compact-panels.spec.ts`

Expected before any Task 3 layout adjustments: nonzero tests execute, and any uncovered geometry/focus failure is a genuine failure. Since Tasks 1–2 may already fulfill all cases, demonstrate red by temporarily removing only their combined metadata/top-stack height bound in this task worktree, running the geometry cases, then immediately restoring the exact task-owned CSS before continuing; preserve red log evidence. This is an intentional mutation check, never a committed regression. If provider/cloud infrastructure fails before assertions, fix setup and rerun; do not call that red evidence. Do not add this spec to `CLOUD_SKIP_SPECS` or force local.

- [ ] **Step 3: Add the minimal production implementation**

Fix only measured regressions within Tasks 1–2's presentation design: reduce theme stack padding, keep disclosure payload scroll limits, correct flex minimums, and scope modal focus handling as proven necessary. Do not change provider transports or ownership behavior. Update existing `fresh-agent.spec.ts` diff/style assertions to click the counted Diffs trigger, assert file metadata/colors in `dialog Changes`, and close before continuing other pane controls; preserve its existing reasoning/style/composer checks. Audit all browser specs (not only fresh-agent named files), client unit and `test/e2e/*.test.tsx` suites for moved diffs, command previews, diagnostic text, recovery controls, and negative assertions. Open Changes and use dialog-scoped diff locators; expand matching error summaries for recovery actions; keep short-command expectations visible; apply Task 2 negative-assertion rules. Preserve original behavioral checks. The mandatory browser impact set is listed in Step 6; update only affected steps and add any newly discovered specs. Record an explicit affected/unaffected reason for each listed spec; a currently unaffected assertion is retained, not deleted.

Update README's Fresh Agent usage paragraph with compact Changes, request details, grouped status/errors and scrolling requests. Update `docs/index.html`'s Fresh Agent mock: compact counted Diffs row, command disclosure with visible answer buttons, small grouped notices, bounded scroll section, and right-side changes preview using its existing static mock conventions. Keep the mock implementation self-contained and nonfunctional like its existing content; do not introduce production runtime code there.

- [ ] **Step 4: Run the focused test**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e fresh-agent-compact-panels.spec.ts`

Expected: PASS with nonzero test count on configured cloud backend. Save command, backend, actual test count and report path under this run's reports; verify no skipped variant silently removed required coverage. Inspect at least default desktop, serif short pane, mono narrow pane, and phone dark screenshots.

- [ ] **Step 5: Refactor while green**

Remove duplicate fixture-building code inside this spec, retain only scenario-local helpers, and remove any temporary mutation/check CSS. Consolidate redundant theme selectors introduced by the fix while keeping common structural rules authoritative. Rerun focused browser spec after production changes; do not rerun unchanged whole gates merely for reassurance.

- [ ] **Step 6: Run impacted-test verification**

Run: `pnpm run test:vitest run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e fresh-agent-compact-panels.spec.ts fresh-agent.spec.ts fresh-agent-error-turn-attention.spec.ts restore-matrix.spec.ts fresh-agent-control-rust.spec.ts managed-recovery-contextual-ui.spec.ts freshclaude-approvals-rust.spec.ts freshcodex-live-transcript-rust.spec.ts freshclaude-live-transcript-rust.spec.ts freshclaude-durable-transcript-rust.spec.ts rust-baseline-browser-actions.spec.ts handoff-two-device-rust.spec.ts runtime-tabs-rehydrate-rust.spec.ts`

Run: `pnpm run lint`

Run: `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='Compact Fresh Agent panel final branch verification' pnpm run check`

Expected: focused tests, e2e cases, lint and typecheck PASS. The broad check must either PASS or separately establish the exact waived baseline preflight failure using saved evidence and report which suites did not execute; do not turn the baseline waiver into permission to ignore new failures. No Rust files change, but the shared View reaches all providers and therefore the coordinated branch suite is the final integration check. Do not silently use a local test backend if cloud fails. Run every listed spec with a nonzero executed count on configured cloud; inspect cloud skip/local-only configuration and do not count filtered/skipped tests as coverage. `pnpm run check` does not run Playwright. Any additional impacted specs identified in Step 3 are mandatory additions to the focused e2e command. Stop all task-owned test processes and remove disposable files according to AGENTS.md; preserve diagnostic results.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts test/e2e-browser/specs/fresh-agent.spec.ts README.md docs/index.html
git commit -m "test: verify compact Fresh Agent panels across pane sizes and themes"
```

Include any task-owned CSS/component fixes and additional impacted specs in this same focused commit after reviewing `git diff --stat`; do not stage unrelated files. Following the documented workflow, push the completed clean branch after checks, then stop for the user's explicit approval before PR creation. No deployment or production restart is part of this plan.

## Self-review and requirement coverage

- Changed-file compact row, initially hidden details, side panel: Task 1 component tests and Task 3 browser interactions. Exact counts use established identities; unresolved bases/opaque data are explicitly qualified instead of inventing cardinality. Cases include native multi-file patches, empty patches, overlapping summary paths, renames and live replacements.
- Visible answer requests with collapsed details: Task 2 preserves real response/recovery handlers and Task 3 proves reachability, plan/secret/elicitation controls and mobile sizing. Managed recovery decisions remain visible because they require an answer.
- Grouped routine notices, expandable errors and recovery: Task 2 NoticeStack plus actual View callback regressions; Task 3 expanded-error geometry. No lower StatusStrip functionality is duplicated.
- Aggregate height and latest prompt: Task 2 combined pane-root budget for responsive metadata and top stack; Task 3 measured actual transcript and entire composer geometry, populated metadata, clipping/hit tests, short/narrow actual split panes, phone, all Fresh Agent provider types and styles/themes, and explicit 100%/125% scale.
- Keyboard/focus/session reuse: Task 1 focus lifecycle and scope reset, Task 3 browser keyboard/comment/background-update tests. Existing request form state/decision restrictions survive toggles.
- Workflow/base/Kata/PR/safety: baseline evidence and existing issue retained above; three red/green/refactor/commit tasks, no source changes during planning, no deploy, no unapproved PR.

Self-review completed 2026-11-01: checked the User Request appears verbatim once; reconciled all requirements, file responsibilities, interfaces, test entrypoints, fixtures, existing failure waiver, docs and operational constraints. The source tree supersedes code drafts during execution; plan prose remains authoritative. No required outcome is deferred.


## Load-bearing review decisions

Stage 2 corrected two disproven planning assumptions without changing the User Request or adding backend work. File counts must respect the production path namespaces and rename identities, and unresolved totals must be presented honestly. Responsive metadata belongs in the same pane-root height decision as the request stack; the geometry fixture must include it and measure actual transcript space and the entire composer. Full evidence remains in the two validator reports linked above.

Changed-task self-review: Task 1 count interface, parsing/identity behavior and cases now agree; Tasks 2–3 share pane-root ownership and populated-metadata/scale acceptance criteria. No unexecuted validator code was introduced, no provider or transport changes are required, and all request/recovery callbacks remain preserved.

## Round 1 remediation self-review

Rechecked all edited interfaces and examples against the unchanged User Request: short commands remain readable; verbose payloads collapse; recovery content stays mounted; managed recovery is exclusively a counted visible request. Drawer owns its theme/context scope, keyboard capture exemption and visible tab stops. Exact native-only and qualified mixed-namespace count fixtures now have explicit labels. Each task stages its impacted test edits; Task 2 includes meaningful NoticeStack red evidence and nonvacuous negative lifecycle assertions, and Task 3 runs the full named affected Playwright set plus discovered impacts on configured cloud. Lint checks the task introducing semantics. Existing aggregate geometry, provider/theme/scale coverage, docs, baseline waiver/Kata and PR/deploy constraints remain intact. No production implementation was changed or tested during this plan-only remediation.
