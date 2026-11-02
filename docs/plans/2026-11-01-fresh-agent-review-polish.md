# Fresh Agent Review Polish Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix the optional Fresh Agent compact-panel review findings 7 through 12: clearer routine feedback and delivery instructions; correct notice expiry across disclosure and severity changes; better use of narrow/tiny-pane space and visibility of multiple diagnostic summaries; readable approval JSON without a repeated native path; stable drawer focus during pane/session updates and simpler focus-list work where justified; accessible diagnostic severity counts; quieter screenshot logs and accurate, portable historical-plan status/evidence links.

### Explicit constraints
- Apply shared UI improvements to all Fresh Agents.
- Use the-usual workflow, meaningful red/green/refactor behavior tests, and affected integration/browser coverage on the configured test backends.
- Keep pending answer/recovery controls reachable, preserve usable conversation/composer space, and preserve existing provider behavior.
- Work in a dedicated worktree from current origin/main; preserve unrelated work and historical verification/review outcomes.
- Existing pane-wide Space-key behavior and unrelated baseline lint cleanup (finding 6) are outside this follow-up.
- Do not deploy or restart production.

### Accepted tradeoffs and residuals
- The previous compact-panel implementation and thinking-effort labels are already merged; this task adds the approved optional refinements.
- Assess the review suggestions against current source and runtime evidence; avoid speculative caching or unrelated restructuring.
- The user waived the recorded clean-main baseline failures and approved proceeding with the UI fixes while tracking those failures in Kata. Preserve the failed baseline result, the two Codex failures and blocked provider-parity cases, and all unreached coverage; do not silently call the full suite green.

**Goal:** Every Fresh Agent provides immediately useful compact feedback, readable request scope, dependable diagnostic reading/expiry, and stable Changes focus, with quieter review evidence and an accurate historical implementation record.

**Architecture:** Keep provider transport, store state, approval decisions, session ownership, and lifecycle behavior in their current owners. A small disclosure helper in NoticeStack reports the open state of the actual mounted reading surface; one provisional shared CSS allocation must pass combined real-browser geometry before Task 2 is accepted, and ApprovalCard removes a path only when the same value is displayed separately. The existing View adoption callback respects its own portaled drawer during retained status/epoch updates and opening after that callback was queued; shared restoration and explicit Composer actions retain their behavior. Redact screenshot bytes only at the cloud runner's human-display boundary, retaining reconstructable raw Cloud Logging records.

**Tech Stack:** React 18, TypeScript, native details/summary, existing Tailwind/CSS container queries, Testing Library/Vitest, Playwright, Bash cloud-runner contracts; no new dependencies, server routes, schema, persistence, or deployment.

## Global Constraints

1. Work in `/home/dan/code/freshell/.worktrees/fresh-agent-review-polish`, branch `the-usual/fresh-agent-review-polish`, immutable base `520626c46b7e5bfcbdddd85480fd375cdc9cb783`. Follow AGENTS.md for pnpm 10.34.5, test coordination/sandbox, atomic commits, and the explicit PR approval boundary. The user explicitly waived this run's recorded clean-main baseline failures and approved proceeding; preserve the raw FAILED result and Kata tracking below. Do not repair the baseline as part of these UI changes. Parent orchestration owns shared usual run-state/review bookkeeping. Never edit main, discard unrelated changes, deploy, or restart production.
2. Both configured backends are `cloud`; use supported `pnpm run test:vitest` and `pnpm run test:e2e` entrypoints. Broad checks use `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1`. No silent local fallback. Keep actual execution/image/revision receipts, nonzero executed counts, exact selector/skip qualifications, and recovered-retry failures. Tests run in the task worktree; evidence goes under `test-results/fresh-agent-review-polish/`, disposable data under `.test-tmp/`. Existing test fixture temporary directories remain owned/cleaned by their fixture.
3. Preserve request answer/recovery reachability, draft text, the original ambiguous-send payload/persistence marker and queue reservation, duplicate-provider-notice policy, source severity, rate-limit formatting, provider capabilities, existing request/native decisions, diff patch replacement, comments, Escape/tab/conversation close, and explicit pane focus behavior when no owned drawer has focus. No pane-wide Space-key or finding-6 lint cleanup.
4. A geometry assertion must examine the painted text/control, clipping ancestors, and hit testing before a scroll helper where initial visibility is required. DOM text presence or jsdom visibility cannot prove wrapping or useful pane space. Keep existing actual transcript/composer bounds and supported tiny request scrolling. Improve any historical fixed allocation only with measured joint geometry, never by weakening a failing assertion merely to pass.
5. Documentation edits are archival corrections, not executable product tests. Never add prose/config/class/hash match tests. Keep original failed plan-review and raw full-check outcomes, accepted historical exclusions, and original worktree/commit identity. Do not mark unchecked historical draft instructions complete merely because equivalent implementation shipped. Agent documentation stays in `docs/plans/`; no end-user Markdown file besides README is needed. These refinements do not add a major new UI feature, so the nonfunctional `docs/index.html` mock needs no speculative redraw.
6. Plan code is a pre-implementation draft; after execution starts, source wins. Update progress checkboxes only for work actually completed with evidence. Keep source and verification repairs in their task, with the required fresh specification/quality review before dependent execution.


**Current-run baseline qualification:** `bash scripts/base-gate.sh test` exited **1 / FAILED** on clean immutable base `520626c46b7e5bfcbdddd85480fd375cdc9cb783`; the later user waiver authorizes this UI work and does not alter that result. [Workspace baseline](../../../.the-usual-logs/fresh-agent-review-polish/reports/workspace-baseline.md), [full failure output](../../../.the-usual-logs/fresh-agent-review-polish/reports/base-gate-failure-output.txt), and [Kata tracking receipt](../../../.the-usual-logs/fresh-agent-review-polish/reports/kata-tracking.md) are retained run-local evidence, not published artifacts. Their pre-waiver pause wording records the earlier state; the current accepted-tradeoff bullet above records the later explicit authorization.

| Baseline scope | Preserved result and disposition |
| --- | --- |
| Cloud default client/tooling | 722 files / 12,921 tests passed; all four cloud tasks succeeded. This is not a full-suite pass. |
| Required local server companion | 2 failed / 18 passed / 8 skipped tests. Hosted Codex completion carried the original managed session ID while the predicate expected the materialized native ID; tracked as `freshell#kprs` (`01M6DC5V12VD4PHTN4N532KPRS`). The installed-wrapper fixture passed an unawaited Promise to JSON.parse at `codex-local-provider.mjs:162`; tracked on existing `freshell#fy2w`. No common cause is inferred and neither issue is repaired here. |
| Provider-parity contract | Its prerequisite reproduces the Codex identity failure; all seven dependent cases were blocked/unexecuted, not passing. The eighth companion skip is the existing startup-crash opt-in, not an additional demonstrated failure. |
| Source-runtime, broad Rust, Electron | Not reached after the companion failure. Four narrow sandbox Cargo checks inside the fixture do not replace broad Rust coverage. |
| Browser E2E | Outside the baseline command; no baseline browser coverage claimed. |

Final verification may accept only failures recorded in the run's exception ledger and reproduced at this immutable base. Record raw final failure separately from any adjusted accepted-baseline verdict. A new or changed failure requires classification and evidence; this waiver is not permission to waive unrelated failures, skip affected coverage, weaken assertions, or call the full suite green.

---

## File responsibilities and task interfaces

Stage 1 creates this agent plan and adds its link beside the existing compact-panel plan in `AGENTS.md`. Those are the only Stage 1 committed changes; the files below belong to later implementation tasks.

| File | Responsibility and owner |
| --- | --- |
| `src/components/fresh-agent/FreshAgentNoticeStack.tsx` | Task 1: one local details-state helper, routine summaries, actual reading-state notifications, accessible severity count. |
| `src/components/fresh-agent/FreshAgentView.tsx` | Task 1: route its transient reading callback to the current containing disclosure and put genuine ambiguous-send instructions first. Task 2: conditional shared layout wrapper only if measured CSS cannot preserve required geometry. Task 3: preserve focus in its owned Changes portal during the scheduled adoption frame. |
| `src/index.css` | Task 2: shared compact header, metadata, tiny fallback and request-space allocation only. |
| `src/components/fresh-agent/FreshAgentApprovalCard.tsx` | Task 2: generic preview wrapping and native presentation deduplication only. |
| `test/unit/client/components/fresh-agent/FreshAgentNoticeStack.test.tsx` | Task 1: actual disclosure insertion/removal state, summary feedback, accessibility semantics/count derivation. |
| `test/unit/client/components/fresh-agent/FreshAgentView.live-tail.test.tsx` | Task 1: real view/provider severity-transition expiry and reading grace. |
| `test/unit/client/components/fresh-agent/FreshAgentView.approvals.test.tsx` | Task 1: immediately readable routine feedback and genuine ambiguous-send payload/persistence/queue safety. |
| `test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx` | Task 2: scope shown once while preserving exact data and native answer callbacks. |
| `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` | Task 1: closed-summary/expanded-body ambiguous-delivery assertions. Task 3: real drawer/pane adoption race, focus epochs, draft and close behavior. |
| `test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts` | Tasks 1–3, sequentially: real shared rendering/keyboard geometry through existing fixture. Task 4 uses its unchanged screenshot transport for artifact reconstruction. |
| `test/e2e-browser/specs/freshcodex-send-delivery-rust.spec.ts` | Task 1: server-backed send-delivery behavior, with the prevention instruction checked while closed and the full diagnostic checked after expansion. |
| `test/e2e-browser/specs/fresh-agent-checkpoint-unavailable-rust.spec.ts` | Task 1: server-backed rewind notice selectors scoped to the summary and expanded body. |
| `test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts` | Task 1: scope the undo-refill notice assertion to its summary/body after the duplicate notice text is introduced. |
| `test/e2e-browser/specs/agent-checkpoint-rewind.spec.ts` | Task 1: keep the cloud-excluded rewind assertion scoped to its summary/body; selector maintenance only, not claimed as configured-cloud coverage. |
| `scripts/e2e-cloud.sh` | Task 4: human-display redaction, retaining raw storage and runner verdicts. |
| `scripts/test/cloud-e2e-logging-receipt.test.sh` | Task 4: exercise the real runner using fake external gcloud responses, preserve/decode raw PNG data. |
| `docs/plans/2026-11-01-fresh-agent-compact-panels.md` | Task 4: archival status and published-versus-local evidence links. |

No shared focus framework, Redux disclosure state, focus cache, MutationObserver cache, artifact storage service, provider branch, or unrelated source reorganization is needed. Reuse `FreshAgentDiffDrawer`'s existing ownership attributes and keep its live trap; Stage 2 records traversal optimization as OPTIONAL rather than a required repair.

## Stage 2 decisions and implementation acceptance gates

1. **Disclosure ownership verified within its planning boundary:** the exact helper and actual NoticeStack tree support keeping the existing timer in View with its stable React setter. The settled pause must follow the currently mounted containing details through insertion, removal, native queued toggles and severity transfers; the genuine ambiguous-delivery exemption stays independent. Keep the helper local and the callback stable. Task 1 still must execute the full View/provider and browser RED/GREEN cases; the in-memory ownership result is not that coverage. [Retained local lifecycle evidence](../../../.the-usual-logs/fresh-agent-review-polish/reports/load-bearing-validator-lb-f1.md).
2. **Joint short-pane allocation is acceptable but genuinely unproven:** Stage 2 could inspect retained geometry, source constraints and sizing contracts, but measuring the unimplemented proposal requires source/build/browser/fixture changes outside read-only validation. Evaluate 560×320, 390×320, 390×400 and 560×400 in authorized Task 2 RED/GREEN. At 560×320, 390×400 and 560×400, require one populated state to paint meaningful metadata and both concise diagnostic labels while preserving the complete composer and reachable pending answers/recoveries. At 390×320, require both labels and reachable requests/composer in a metadata-absent state, and separately verify a metadata-bearing compact state with metadata values and Child links reachable after intentional scrolling; do not require the metadata line alongside all diagnostics and requests at that size, where the provisional panel estimate exceeds the protected budget. The starting CSS below is not a verified fit; account for real borders, count/summary line boxes, fixed chrome, wrapping and scale rather than relying on nominal caps. If measurements defeat that allocation, permit the smallest shared local layout/markup adjustment coordinating intrinsic panel tracks with actual composer/transcript reservations. Keep independent intended scrolling, existing target sizes, ≥64px actual short transcript, tall-pane ≥40% transcript and ≤35% combined panels, and the existing style/theme/scale/split matrix. Do not manufacture a new full width/style/scale cross-product from reference arithmetic. Whole-layout scrolling remains accepted below 320px for pending-request recovery and below the measured composer minimum for no-request composer reachability; preserve immediate visibility in the no-panel 270px case. Task 2 cannot pass without combined real-browser geometry on the configured backend; if no compliant allocation passes, report FAILED/non-converged. [Retained local geometry decision/evidence](../../../.the-usual-logs/fresh-agent-review-polish/reports/load-bearing-validator-lb-f2.md).
3. **Focus boundary and optional traversal advice:** use the local View callback-time ownership guard for retained same-session/diff status changes, explicit same-pane epochs and opening Changes after that View frame is queued. Do not rely on a universal claim that this is the only asynchronous focus writer or suppress shared descriptor restoration, explicit delivery/undo editing focus, or intentional comment/close focus. The bounded retained-transition decision is supported; a modeled broader handoff interaction is not a demonstrated application defect. Preserve actual disabled/enabled setup, draft/control identity, foreign-owner adoption and all intentional closes in Task 3, without a settle-all-timers precondition on the pending-frame case. The live trap already reads style once per candidate and reflects dynamic controls. Lazy traversal could reduce per-Tab work for very large diffs. No demonstrated latency defect requires that optional change, so keep the trap and avoid a benchmark gate or speculative cache. [Bounded retained-focus evidence](../../../.the-usual-logs/fresh-agent-review-polish/reports/load-bearing-validator-lb-f3-fallback.md), [broader mechanism limits](../../../.the-usual-logs/fresh-agent-review-polish/reports/load-bearing-validator-lb-f3.md).
4. **Screenshot evidence:** Cloud Run filesystem screenshots alone are not durable exports. Existing PNG chunks remain in raw Cloud Logging. Display redaction reduces terminal output only, not Cloud Logging storage/ingestion bytes. Verify extraction against both structured jsonPayload and reporter-prefixed textPayload and inspect reconstructed PNGs before claiming preserved evidence.

### Task 1: Useful feedback with correct reading/expiry and accessible severity

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentNoticeStack.tsx:1`
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:5164`
- Test: `test/unit/client/components/fresh-agent/FreshAgentNoticeStack.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.live-tail.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.approvals.test.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (delivery-notice assertions only; Task 3 owns its focus cases)
- Test: `test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts`
- Test: `test/e2e-browser/specs/freshcodex-send-delivery-rust.spec.ts`
- Test: `test/e2e-browser/specs/fresh-agent-checkpoint-unavailable-rust.spec.ts`
- Test: `test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts`
- Update only: `test/e2e-browser/specs/agent-checkpoint-rewind.spec.ts` (cloud-excluded selector maintenance; do not claim it ran)

**Interfaces:**
- Consumes unchanged `FreshAgentNotice`, `FreshAgentError`, `FreshAgentView` notice payload, six-second timer, stable `setNoticeExpanded`, and `deliveryNoticeRef` full-text marker.
- Produces `FreshAgentNoticeStack({notices, errors, onNoticesExpandedChange?})`, where `onNoticesExpandedChange?: (expanded: boolean) => void`; error entry `onToggle?: (expanded: boolean) => void` is unchanged. Routine entries no longer carry an entry-level callback. Local `NoticeDisclosure({children, errorId?, onExpandedChange?})` owns the actual details-open state and reports mount/change/unmount. No provider/store interface changes.

- [ ] **Step 1: Write failing behavioral tests**

Append these tests to NoticeStack's existing suite. Add `fireEvent` to its Testing Library imports. Unlike a static prose check, the tests render, open, insert, remove, and rerender the production component; caller-provided message data is asserted on the actual disclosure surface.

```tsx
it('shows a single routine message in its closed summary', () => {
  const text = 'Code rewound to the selected checkpoint'
  render(<FreshAgentNoticeStack notices={[{ id: 'notice', text }]} errors={[]} />)
  const status = screen.getByRole('status', { name: 'Agent notices' })
  expect(status.querySelector('summary')).toHaveTextContent(text)
  expect(status.querySelector('details')).not.toHaveAttribute('open')
})

it('reports the already-open routine surface when a transient joins, then clears ownership', () => {
  const onOpen = vi.fn()
  const restoring = { id: 'restoring', text: 'Restoring session...' }
  const { rerender } = render(<FreshAgentNoticeStack notices={[restoring]} errors={[]} />)
  const details = screen.getByRole('status', { name: 'Agent notices' }).querySelector('details')!
  details.open = true
  fireEvent(details, new Event('toggle', { bubbles: true }))
  rerender(<FreshAgentNoticeStack notices={[restoring, { id: 'notice', text: 'Settings saved' }]} errors={[]} onNoticesExpandedChange={onOpen} />)
  expect(onOpen).toHaveBeenLastCalledWith(true)
  rerender(<FreshAgentNoticeStack notices={[restoring]} errors={[]} />)
  expect(onOpen).toHaveBeenLastCalledWith(false)
})

it('clears a removed diagnostic surface and derives named severity counts after updates', () => {
  const onOpen = vi.fn()
  const first = { id: 'notice', summary: 'Provider warning', level: 'warning' as const, content: <p>Original details</p>, onToggle: onOpen }
  const { rerender } = render(<FreshAgentNoticeStack notices={[]} errors={[first, { id: 'create', summary: 'Agent could not start', content: null }]} />)
  const count = screen.getByRole('img', { name: '1 error, 1 warning' })
  expect(count).toHaveTextContent('2')
  const details = screen.getByRole('alert', { name: 'Agent warning' }).closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle', { bubbles: true }))
  expect(onOpen).toHaveBeenLastCalledWith(true)
  rerender(<FreshAgentNoticeStack notices={[]} errors={[{ id: 'create', summary: 'Agent could not start', content: null }]} />)
  expect(onOpen).toHaveBeenLastCalledWith(false)
  expect(screen.getByRole('img', { name: '1 error' })).toHaveTextContent('1')
  expect(screen.queryByRole('img', { name: '1 error, 1 warning' })).toBeNull()
})
```

Append to `describe('provider notices (transcript-live D6)')` in the live-tail suite, reusing that file's real view/store/provider-frame helpers:

```tsx
it.each([['info', 'warning'], ['warning', 'info'], ['error', 'info']] as const)(
  'expires a new closed %s → %s surface after the reading surface changes',
  async (from, to) => {
    serve(() => claudeSnapshot([userTurn('u-user', 'question')]))
    const store = createStore()
    await mount(store)
    deliver(store, { type: 'freshAgent.notice', level: from, code: 'FIRST', message: 'First feedback' })
    const first = from === 'info'
      ? screen.getByRole('status', { name: 'Agent notices' }).querySelector('details')!
      : screen.getByRole('alert').closest('details')!
    first.open = true
    fireEvent(first, new Event('toggle', { bubbles: true }))
    await advance(0)
    deliver(store, { type: 'freshAgent.notice', level: to, code: 'NEXT', message: 'Replacement feedback' })
    await advance(6_001)
    expect(screen.queryByText('Replacement feedback')).toBeNull()
  },
)

it('keeps a replacement diagnostic while its same reading surface stays open, then gives full close grace', async () => {
  serve(() => claudeSnapshot([userTurn('u-user', 'question')]))
  const store = createStore()
  await mount(store)
  deliver(store, { type: 'freshAgent.notice', level: 'warning', code: 'FIRST', message: 'First warning' })
  const details = screen.getByRole('alert', { name: 'Agent warning' }).closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle', { bubbles: true }))
  await advance(0)
  deliver(store, { type: 'freshAgent.notice', level: 'error', code: 'NEXT', message: 'Replacement error' })
  await advance(10_000)
  expect(screen.getByRole('alert')).toHaveTextContent('Replacement error')
  details.open = false
  fireEvent(details, new Event('toggle', { bubbles: true }))
  await advance(5_999)
  expect(screen.getByRole('alert')).toHaveTextContent('Replacement error')
  await advance(2)
  expect(screen.queryByText('Replacement error')).toBeNull()
})

it('does not revive the open state of a removed routine disclosure', async () => {
  serve(() => claudeSnapshot([userTurn('u-user', 'question')]))
  const store = createStore()
  await mount(store)
  deliver(store, { type: 'freshAgent.notice', level: 'info', code: 'ONE', message: 'First routine' })
  const details = screen.getByRole('status', { name: 'Agent notices' }).querySelector('details')!
  details.open = true
  fireEvent(details, new Event('toggle', { bubbles: true }))
  await advance(0)
  deliver(store, { type: 'freshAgent.notice', level: 'warning', code: 'TWO', message: 'Middle diagnostic' })
  deliver(store, { type: 'freshAgent.notice', level: 'info', code: 'THREE', message: 'Last routine' })
  await advance(6_001)
  expect(screen.queryByText('Last routine')).toBeNull()
})

it('inherits an already-open routine group when new provider feedback arrives', async () => {
  serve(() => claudeSnapshot([userTurn('u-user', 'question')]))
  const store = createStore()
  await mount(store)
  act(() => store.dispatch(mergePaneContent({ tabId: 'tab-1', paneId: 'pane-1', updates: { reconcileNotice: 'Session restored' } })))
  const details = screen.getByRole('status', { name: 'Agent notices' }).querySelector('details')!
  details.open = true
  fireEvent(details, new Event('toggle', { bubbles: true }))
  await advance(0)
  deliver(store, { type: 'freshAgent.notice', level: 'info', code: 'SAVED', message: 'New settings saved' })
  await advance(10_000)
  // Reconciliation may expire, but the info notice keeps this same group mounted.
  expect(screen.getByRole('status', { name: 'Agent notices' }).querySelector('summary')).toHaveTextContent('New settings saved')
  details.open = false
  fireEvent(details, new Event('toggle', { bubbles: true }))
  await advance(6_001)
  expect(screen.queryByText('New settings saved')).toBeNull()
})
```

Update the existing info-severity test to scope the summary in `role=status` and assert immediate message visibility, then open Notice details and assert the full body. The same message can now occur twice; scope existing reading tests to summary/body instead of ambiguous global `getByText(message)`. Retain all existing provider level/rate-limit/running-state/repeat-after-expiry assertions and genuine ambiguous-send safety tests. Strengthen the ambiguous-send test: summary text starts with `Check the conversation before sending again.`, full original request ID/reason remains in the body after expansion, draft restored, notice persistent after 7 seconds, and only the original send frame exists.

- [ ] **Step 2: Run tests and verify intended failures**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentNoticeStack.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.live-tail.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.approvals.test.tsx --config config/vitest/vitest.config.ts`

Expected: behavioral FAIL for missing named count role, hidden single feedback, missed open-state insertion/removal, stale severity-transition expiry, and the trailing instruction. Fix TypeScript/import/setup errors before accepting RED. Record which existing assertions need body scoping, preserving their behavior.

- [ ] **Step 3: Add minimal production implementation**

In NoticeStack, import `useLayoutEffect` and `useState`. Remove `onToggle` only from the routine notice type. Add this helper in the same file:

```tsx
function NoticeDisclosure({ children, errorId, onExpandedChange }: {
  children: ReactNode
  errorId?: string
  onExpandedChange?: (expanded: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  useLayoutEffect(() => {
    onExpandedChange?.(expanded)
    return () => onExpandedChange?.(false)
  }, [expanded, onExpandedChange])
  return <details data-agent-error={errorId} onToggle={event => setExpanded(event.currentTarget.open)}>{children}</details>
}
```

Add `onNoticesExpandedChange` to the stack's destructured props and type. Replace the routine `<details onToggle=...>` with `<NoticeDisclosure onExpandedChange={onNoticesExpandedChange}>` and the matching closing tag. Replace each error's `<details key={error.id} ...>` with `<NoticeDisclosure key={error.id} errorId={error.id} onExpandedChange={error.onToggle}>` and the matching closing tag; preserve all existing summary/body/recovery JSX. Replace the summary expression with:

```tsx
const summarizeNotice = (text: string) => text.length > 160 ? `${text.slice(0, 160)}…` : text
const latestRoutineNotice = [...notices].reverse().find(notice => !notice.prominent)
const noticeSummary = notices.length === 1 ? summarizeNotice(notices[0].text) : <>
  {notices.length} notices
  {latestRoutineNotice ? <span className="fresh-agent-notice-summary">{summarizeNotice(latestRoutineNotice.text)}</span> : null}
  {notices.filter(notice => notice.prominent).map(notice => <span key={notice.id} className="fresh-agent-notice-summary">{summarizeNotice(notice.text)}</span>)}
</>
```

Add `role="img"` to the numeric severity-count span, retaining its `aria-label={diagnosticCount}`, `title`, text and class. It is a named static graphic count, not a second live alert. Error summaries retain their individual accessible names and warning/error semantics.

In View, remove `onToggle: setNoticeExpanded` from only the routine transient entry. Pass `onNoticesExpandedChange={notice?.level === 'info' ? setNoticeExpanded : undefined}` to the stack. Error transient entries still pass the stable `setNoticeExpanded` through their existing `onToggle`. Preserve the timer/payload/sequence logic. Replace only the summary formatting declarations and transient error entry's body expression:

```tsx
const verboseNotice = notice && (notice.text.length > 240 || notice.text.split('\n').length > 3)
const uncertainDelivery = Boolean(notice && notice.text === deliveryNoticeRef.current)
const noticeSummary = uncertainDelivery
  ? 'Check the conversation before sending again. Delivery is uncertain.'
  : verboseNotice ? `${notice.text.slice(0, 160)}…` : notice?.text
```

The transient diagnostic `content` becomes `(verboseNotice || uncertainDelivery) ? <p>{notice.text}</p> : null`. Never recognize delivery by provider code/prefix, rewrite `notice.text`, or move `deliveryNoticeRef` to the summary. The instruction itself is first and short; Task 2's browser layout proves it is painted while closed.

- [ ] **Step 4: Run focused tests**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentNoticeStack.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.live-tail.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.approvals.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Run: `pnpm exec eslint src/components/fresh-agent/FreshAgentNoticeStack.tsx src/components/fresh-agent/FreshAgentView.tsx`

Expected: PASS, including the previously existing pause, provider semantics, capped closed routine summaries with full expanded text, transient feedback alongside prominent notices, exact original diagnostic, restored draft, persistence, and no-replay checks.

- [ ] **Step 5: Refactor while green**

Keep the helper local and callback stable; remove obsolete entry-callback wiring and duplicated lifecycle assertions only where another behavioral assertion still protects the same case. Do not move timer state to Redux or add notice identity generation. Rerun the focused command after cleanup.

- [ ] **Step 6: Run impacted verification and add browser feedback coverage**

In the existing compact browser fixture, assert the transient info message in the closed summary both alone and while a prominent reconciliation notice is also present; opening the disclosure still exposes all original notice text. Add mixed-severity count using `getByRole('img', {name:'1 error, 1 warning'})`, changed count after state updates, and an ARIA snapshot scoped to that count (assert a named `img`, not a whole-page snapshot). Existing count selectors become `getByRole('img', {name:'2 errors'})`.

Add a genuine ambiguous-send browser case using the existing `harness` fixture and `seedCompactPane` with Codex, no pending requests and no create error. The fixture intentionally suppresses network effects: `sendSuppressedAwareFreshAgentFrame` records the real submitted frame in the existing harness spy instead of sending it over WebSocket, so a routeWebSocket interceptor cannot observe this send. Keep that suppression in place, fill the real composer, press Send, and retrieve the unique matching `freshAgent.send` frame with `harness.getSentWsMessages()`. Inject the correlated top-level server error through the existing `harness.receiveWsMessage({type:'error', code:'INTERNAL_ERROR', requestId:sent.requestId, message:'CODEX_DELIVERY_AMBIGUOUS: ' + 'Long explanation '.repeat(30)})`. This is the production send-refusal/ambiguous-delivery handler, not a synthetic provider notice with a DELIVERY_UNCERTAIN code. At 560×320 and 390×700 assert the closed summary starts with the prevention instruction and also explains that delivery is uncertain; after 7 seconds assert persistence, restored draft, matching send count one, and full original diagnostic on expansion. Task 2 separately adds the painted-text assertion to this existing passing case when its layout implementation is ready. Keep the existing synthetic provider-warning test as ordinary provider behavior. This UI fixture covers real client send/error state while intentionally replacing provider transport; affected Rust-backed approval/rollback cases below retain server/provider integration coverage, with no claim that this fixture launches a real Codex provider.

Update `freshcodex-send-delivery-rust.spec.ts` to assert the prevention instruction in the closed delivery notice, then expand it before checking the full native-response diagnostic. In `fresh-agent-checkpoint-unavailable-rust.spec.ts`, `fresh-agent-rollback-rust.spec.ts`, and `FreshAgentView.test.tsx`, target the summary separately from the body so the same rendered message does not create an ambiguous text locator; retain full-diagnostic assertions on expanded bodies. Apply the same summary/body scoping to the cloud-excluded `agent-checkpoint-rewind.spec.ts`, preserve its current cloud skip, and do not count it as executed coverage.

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/ test/e2e/fresh-agent-turn-complete-notification.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS for all matched client Fresh Agent suites and the actual notification integration test, with nonzero executed counts.

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e fresh-agent-compact-panels.spec.ts fresh-agent-rollback-rust.spec.ts freshcodex-live-transcript-rust.spec.ts freshcodex-send-delivery-rust.spec.ts fresh-agent-checkpoint-unavailable-rust.spec.ts`

Expected: PASS on cloud, nonzero intended cases with no recovered retry. Task 1 adds only its passing behavioral cases; Task 2 owns its later new painted-layout assertions, RED evidence, production repair and GREEN. Do not commit a red browser suite or claim Task 2's unimplemented assertions passed.

- [ ] **Step 7: Commit task**

```bash
git add src/components/fresh-agent/FreshAgentNoticeStack.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentNoticeStack.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.live-tail.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.approvals.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts test/e2e-browser/specs/freshcodex-send-delivery-rust.spec.ts test/e2e-browser/specs/fresh-agent-checkpoint-unavailable-rust.spec.ts test/e2e-browser/specs/fresh-agent-rollback-rust.spec.ts test/e2e-browser/specs/agent-checkpoint-rewind.spec.ts
git commit -m "fix: make fresh agent feedback readable and expiry follow disclosures"
```

### Task 2: Readable request scope and compact space without hidden diagnostics

**Files:**
- Modify: `src/index.css:1606`
- Modify: `src/components/fresh-agent/FreshAgentApprovalCard.tsx:72`
- Modify conditionally: `src/components/fresh-agent/FreshAgentView.tsx` (only if browser measurements show the shared CSS wrappers cannot meet protected geometry)
- Test: `test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx`
- Test: `test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts`
- Existing impacted test: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (real Codex native approval and decision path)

**Interfaces:**
- Consumes Task 1's unchanged DOM ownership classes/IDs and named count; existing `seedCompactPane`, `fitRoot`, `assertUsefulSpace`, `hitAndClick`, snapshot update and provider response path.
- Produces no new product interface. Browser helper `assertPainted(control: Locator): Promise<void>` verifies all nonempty text rectangles inside clipping ancestors and an actual hit at each rectangle. CSS behavior remains provider-independent.

- [ ] **Step 1: Write failing behavioral tests**

Remove the grantRoot-only member from the existing parameterized test that assumes every native fixture has JSON; preserve that coverage with these new cases in ApprovalCard's suite. The other permission fixtures retain exact parse/value/decision assertions.

```tsx
it('shows a native grant root exactly once with no empty JSON, preserving the offered decisions', () => {
  const path = '/srv/generated'
  const { onRespond } = renderCard({ requestId: 'root-only', toolName: 'Edit', native: { grantRoot: path, availableDecisions: ['acceptForSession', 'decline'] } })
  const card = screen.getByRole('alert', { name: 'Permission request for Edit' })
  expect(card.textContent?.split(path)).toHaveLength(2)
  expect(card.querySelector('pre')).toBeNull()
  expect(within(card).queryByText('Request details')).toBeNull()
  fireEvent.click(within(card).getByRole('button', { name: 'Allow for this session', exact: true }))
  fireEvent.click(within(card).getByRole('button', { name: 'Decline', exact: true }))
  expect(onRespond.mock.calls).toEqual([[{ nativeDecision: 'acceptForSession' }], [{ nativeDecision: 'decline' }]])
})

it('keeps the remaining exact native scope when its separately displayed path is deduplicated', () => {
  const path = '/srv/generated'
  const permissions = { network: true }
  const { onRespond } = renderCard({ requestId: 'root-scope', toolName: 'Additional permissions', native: { grantRoot: path, cwd: '/srv', permissions, availableDecisions: ['accept', 'decline'] } })
  const card = screen.getByRole('alert', { name: 'Permission request for Additional permissions' })
  expect(card.textContent?.split(path)).toHaveLength(2)
  expect(JSON.parse(card.querySelector('pre')!.textContent!)).toEqual({ directory: '/srv', permissions })
  fireEvent.click(within(card).getByRole('button', { name: 'Allow', exact: true }))
  expect(onRespond).toHaveBeenCalledExactlyOnceWith({ nativeDecision: 'accept' })
})
```

Add this complete browser helper beside `hitAndClick`:

```ts
async function assertPainted(control: Locator): Promise<void> {
  const result = await control.evaluate(el => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0)
    const clips: DOMRect[] = []
    for (let parent: Element | null = el; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      if (parent.matches('.fresh-agent-pane') || /(hidden|auto|scroll|clip)/.test(style.overflowX + style.overflowY)) clips.push(parent.getBoundingClientRect())
    }
    return { count: rects.length, readable: rects.every(r => clips.every(c => r.left >= c.left - 1 && r.right <= c.right + 1 && r.top >= c.top - 1 && r.bottom <= c.bottom + 1) && (() => {
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return hit === el || Boolean(hit && el.contains(hit))
    })()) }
  })
  expect(result.count).toBeGreaterThan(0)
  expect(result.readable).toBe(true)
}
```

Strengthen/add the following existing-fixture cases, using the exact data and observations below rather than CSS-class assertions:

1. Existing two-provider multiple-diagnostic test: before opening/scrolling anything, call `assertPainted` on the alert spans for `Agent could not start` and `Close failed` at all existing 1100×700, 560×320, 390×700 sizes. Click the second summary, then its current Close-error recovery/dismiss action and assert the actual state/result; retain count and long prominent-status checks.
2. New narrow request-space cases at 800×900 and 390×700: seed one short `Bash` approval `{requestId:'short-request', toolName:'Bash', input:{command:'echo ok'}}`, no questions/elicitations/diffs, and a routine notice `Settings saved`. Clear fixture create/reconcile errors through the existing pane merge action; inject info through `receiveWsMessage`. Assert Allow's full bounds are initially inside Pending requests and hit-test its center before calling `hitAndClick`; use `assertUsefulSpace`. Repeat after removing all diagnostic/routine content. This rejects an empty/flexible middle track reserving half the request budget.
3. Short metadata cases at 320px and 400px root height, 560px and 390px width, populated Claude and Codex variants: at 560×320, 390×400 and 560×400, put meaningful metadata, both concise diagnostics, and real pending requests/recoveries in the same fixture state. Before opening or scrolling the diagnostic/metadata surfaces, require at least one actual metadata value line and both concise diagnostic labels to have all glyphs painted. At 390×320, require both concise labels, real pending requests and composer reachability in a metadata-absent state; separately verify a metadata-bearing compact state without the diagnostic/request stack and confirm metadata values and any selected Child link after intentionally scrolling its metadata panel. This avoids requiring the estimated 89px combined metadata/header area when the protected 390×320 panel budget is about 81px, while retaining the narrow metadata and multiple-summary checks. Use `assertUsefulSpace`, the complete composer and all request decisions through their intended internal surfaces. A title/empty rectangle or separate favorable fixtures are insufficient. Metadata may scroll internally; do not demand every metadata item appear at once. Retain the existing style/theme/scale/split matrix without silently claiming unexecuted combinations.
4. Tiny cases: no requests, errors, notices, sidebar or diffs at 270px must show the complete composer/action row immediately. At 200px and 120px, assert that the complete composer/action row remains reachable by scrolling when there are no requests, after the final pending request is answered, and with a lone Diffs trigger or info notice; these states must not depend on a request-scroller element. Use a long info notice at 390px width to assert the closed summary is ellipsized, the notices container has `scrollWidth <= clientWidth + 1`, and the full text remains in the expanded body. Scroll the existing `.fresh-agent-layout` container explicitly, then require all composer/action-row text and controls to be painted and hit-testable. At 200px and 270px, the lone trigger/notice must have no empty 68px request floor (assert the stack is no taller than its measured content plus actual padding). Existing nested 120px/200px real-request tests retain whole-layout scrolling, recovery, conversation/composer reachability and provider answers. Keep the immediate no-panel 270px checks separate from intentionally scrolling short-pane cases.
5. Generic JSON matrix: tool/input pairs `['WebFetch',{url:'https://example.com/'+'a'.repeat(120)}]`, `['Write',{file_path:'/tmp/x',content:'b'.repeat(120)}]`, `['mcp__fixture__lookup',{key:'c'.repeat(120)}]`, at 390px and 560px. Keep total compact JSON below 240 characters, so it is initially visible. Use the existing Claude fixture with only that approval and no other requests; assert `JSON.parse(pre.textContent)` equals the exact input, `scrollWidth <= clientWidth + 1`, multi-line painted height, and all text rectangles inside the preview. Answer through Allow and use `harness.getSentWsMessages()` to assert `{type:'freshAgent.approval.respond',sessionId:'compact-freshclaude',sessionType:'freshclaude',provider:'claude',requestId,decision:{behavior:'allow'}}`. Retain verbose JSON disclosure tests and native desktop scope/answer behavior.
6. Include Task 1's genuine ambiguous-send closed prevention instruction in the painted text checks; do not claim expanded-only text proves this requirement.

- [ ] **Step 2: Run tests and verify intended failure**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL because grantRoot is repeated and the root-only request still has JSON.

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e fresh-agent-compact-panels.spec.ts`

Expected: FAIL in the newly added painted-summary, combined short metadata/no-panel-tiny, request allocation, and unbroken generic preview cases. Record measured rectangles/screenshots; syntax/fixture errors, zero executed cases or skipped/excluded selections are not RED evidence. Existing allowed request scrolling at 120px/200px must still pass.

- [ ] **Step 3: Add minimal production implementation**

ApprovalCard precise patch: omit the grant-root member from the derived display JSON only when the existing typed-string path paragraph actually renders that same value. Preserve the existing display projection otherwise; this is presentation deduplication, not a new provider schema or permission transformation. Keep the native object/decision callbacks untouched, and test rendered scope plus exact decisions. Add `whitespace-pre-wrap` to the generic JSON `<pre className="fresh-agent-approval-preview mt-2 ...">` just as native/Bash previews already have. Existing `overflow-wrap:anywhere` then wraps unbroken strings; compact versus verbose threshold remains unchanged.

Apply these CSS replacements as a provisional starting layout in Task 2, then correct them against its combined RED/GREEN browser measurements before acceptance; consolidate existing rules rather than appending competing overrides:

```css
.fresh-agent-error-summaries {
  display: flex;
  flex-wrap: wrap;
  align-content: start;
  column-gap: .5rem;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.fresh-agent-error-summaries > details { min-width: 0; max-width: 100%; }
.fresh-agent-errors:has(details[open]) .fresh-agent-error-summaries { display: block; }
.fresh-agent-notices { min-width: 0; max-width: 100%; }
.fresh-agent-notices details:not([open]) > summary {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

In `@container (max-height:479px) or (min-width:900px)`, replace `grid-template-columns:auto repeat(3,minmax(0,1fr))` with `auto minmax(0,1fr) fit-content(55%) auto` and `grid-template-rows:20px minmax(44px,1fr)` with `minmax(0,max-content) minmax(44px,1fr)`. Preserve existing cell placement and independent request overflow. Closed concise errors flow side by side; long ordinary diagnostics retain the bounded closed summary plus full expansion. The special prevention instruction is short enough to paint in the diagnostic track; the browser must establish this, including metadata's influence.

In narrow/tall query, replace only the equally flexible row template with `grid-template-rows:20px minmax(0,max-content) minmax(44px,1fr)`; let error labels flow/wrap inside the intrinsic diagnostic row, and retain the existing aggregate cap. Do not allocate half the budget to an empty/short row. Remove the narrower query's conflicting fixed `18px` row override so the common intrinsic header rule applies.

In the short/narrow query, reduce metadata/header chrome together. The following unverified initial candidate replaces the previous `.125` allocation and removes the mobile query's conflicting sidebar-budget assignment; its ratio, line heights and 250px reserve are provisional and must be revised when real joint geometry requires it:

```css
@container (max-height: 479px) and (max-width: 899px) {
  .fresh-agent-layout {
    --fresh-agent-short-sidebar-budget: min(10cqh, calc(var(--fresh-agent-short-panel-budget) * .2));
  }
  .fresh-agent-sidebar-content { gap: 0 .5rem; }
  .fresh-agent-sidebar-section {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    column-gap: .375rem;
    border: 0;
    padding: 0;
    min-width: 0;
  }
  .fresh-agent-sidebar-title { margin: 0; font-size: .625rem; line-height: 14px; }
  .fresh-agent-sidebar-section :is(p, li) { margin-block: 0; font-size: .75rem; line-height: 14px; }
  .fresh-agent-pane .fresh-agent-top-stack:has(.fresh-agent-top-stack-scroll) { padding-block: 0; row-gap: 0; }
  .fresh-agent-top-stack .fresh-agent-request-count,
  .fresh-agent-top-stack summary,
  .fresh-agent-top-stack .fresh-agent-diff-trigger { font-size: .625rem; line-height: 12px; }
}
```

Do not treat these nominal caps as final occupied sizes or a proof that a full metadata line and header fit. Include the existing sidebar border and independently sized diagnostic count in actual intrinsic measurements; text line boxes, glyph painting, style scale and mobile/desktop chrome can disagree with the starting arithmetic. Task 2 owns settling the allocation through real combined browser geometry before its review/acceptance, as the Stage 2 decision records. Prefer revising the same shared allocation; if measured failures require a local common layout/markup adjustment, preserve every protected outcome and keep one budget owner. Do not hide actionable metadata or either concise diagnostic, shrink protected targets, relax transcript/composer assertions or add whole-layout scrolling at supported 320px sizes. If an intrinsic shared track removes the need for this custom property, remove it. Preserve metadata scrolling/all values/links and Sidebar provider-data parsing. No new unexecuted corrective code is asserted by this planning decision.

Replace the tiny container block with these short-pane fallbacks:

```css
@container (max-height: 239px) {
  .fresh-agent-layout { overflow: auto; }
  .fresh-agent-main { min-height: 320px; flex-shrink: 0; }
}

@container (max-height: 317px) {
  .fresh-agent-layout:has(.fresh-agent-top-stack-scroll) { overflow: auto; }
  .fresh-agent-main:has(.fresh-agent-top-stack-scroll) { min-height: 320px; flex-shrink: 0; }
  .fresh-agent-pane .fresh-agent-top-stack:has(.fresh-agent-top-stack-scroll) {
    min-height: 68px;
    max-height: 78px;
    flex-shrink: 0;
  }
  .fresh-agent-pane .fresh-agent-top-stack:not(:has(.fresh-agent-top-stack-scroll)):has(.fresh-agent-notices, .fresh-agent-errors, .fresh-agent-diff-trigger) {
    max-height: min(25cqh, 78px);
    flex-shrink: 0;
  }
}
```

The no-request stack has no request viewport/count floor. Keep the 270px empty-pane case immediately visible, but below the measured composer minimum (239px is the provisional fallback threshold) make the layout/main scrollable even when there is no request scroller. That height-scoped fallback must still apply after the last request is answered and for a lone notice/Changes trigger, so the composer stays reachable without imposing the request floor on the whole stack. For genuinely too-small panes with long diagnostic-only details, allow that existing detail surface to scroll. Preserve expanded diagnostic flow rules and original recovery controls. Browser evidence, not this starting formula, decides the final shared numeric allocation.

- [ ] **Step 4: Run focused tests**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx --config config/vitest/vitest.config.ts`

Run: `pnpm exec eslint src/components/fresh-agent/FreshAgentApprovalCard.tsx src/components/fresh-agent/FreshAgentView.tsx`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e fresh-agent-compact-panels.spec.ts`

Expected: PASS with nonzero cloud cases covering the new matrix and every existing style/theme/scale/split/expanded/native/recovery case. Inspect selected reconstructed screenshots and measured text/control rectangles. Joint geometry failure is a production allocation defect to repair in this task, not authorization to change the protected test outcomes.

- [ ] **Step 5: Refactor while green**

Remove superseded grid/minimum/padding overrides and keep each container case's allocation in one place. Preserve style variables and the wide metadata side column. Keep display deduplication confined to ApprovalCard. Rerun both focused commands after cleanup; no new generic layout component is warranted.

- [ ] **Step 6: Run impacted verification**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e fresh-agent-compact-panels.spec.ts fresh-agent.spec.ts fresh-agent-mobile.spec.ts fresh-agent-mobile-attention.spec.ts fresh-agent-hidden-approval-reveal.spec.ts freshclaude-approvals-rust.spec.ts fresh-agent-control-rust.spec.ts fresh-agent-model-dialog-parity.spec.ts fresh-agent-rollback-rust.spec.ts freshcodex-live-transcript-rust.spec.ts`

Expected: PASS on configured cloud. Preserve exact provider decisions, mobile targets, server-backed approve/refuse/rollback paths, dialogs, runtime notices and recovery. Review the excluded `agent-checkpoint-rewind.spec.ts`/paired `code-checkpoint-workspace-external.spec.ts` affected selectors without claiming they ran. The executed compact real-send/feedback fixture must cover the changed UI outcome; excluded external provider/filesystem rollback coverage remains honestly unexecuted. No local backend substitution.

- [ ] **Step 7: Commit task**

```bash
git add src/index.css src/components/fresh-agent/FreshAgentApprovalCard.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentApprovalCard.test.tsx test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts
git commit -m "fix: preserve compact fresh agent space and readable approval scope"
```

### Task 3: Keep focus in the owned Changes drawer through pane updates

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx:4746`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
- Test: `test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts`
- Existing impacted tests: `test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx`

**Interfaces:**
- Consumes unchanged drawer overlay `.fresh-agent-diff-drawer-overlay` and `data-tab-id`/`data-pane-id`, `usePaneFocusAdoption(paneId,isActivePane,focusEpoch)`, existing rAF adoption scheduling.
- Produces no new public interface. The View's scheduled adoption callback leaves focus in an overlay only when both owning IDs match this view; other panes still use existing adoption rules. This is protection from that adoption callback during retained View/session/diff updates, not global immunity from independently initiated focus actions.

- [ ] **Step 1: Write failing behavioral tests**

Extend the existing real diff-panel wiring tests and browser `native patch`/`opaque patch` keyboard cases. In the unit suite, use `StoreBackedFreshAgentView`, a snapshot with retained inline diff, a nonempty draft, and the real Changes button/dialog; do not fabricate an unrelated DOM element as the sole proof. For each Close, file-toggle and comment control: focus it, update the actual snapshot idle→exited→idle while retaining the same Fresh session/diffs, prove the actual disabled/enabled transition, advance pending snapshot/rAF effects, and assert the same control still owns focus and draft is unchanged. Separately bump explicit focus epoch while the same drawer control is focused; repeat with Changes opened before an already-scheduled View adoption frame fires, without first imposing a settle-all-focus-timers condition. Preserve comment-to-composer and Escape/trigger restoration checks. Include a second pane's overlay focused while this pane is explicitly selected: the guard must not treat it as owned. Do not turn explicit handoff, delivery-refusal, undo or comment focus into a new global focus policy; if a required retained transition actually exposes another owner, preserve the reproduction and resolve that concrete cause before accepting this task.

For exact browser insertion, after obtaining `dialog` in the current keyboard fixture, before the existing Tab loop, add:

```ts
const close = dialog.getByRole('button', { name: 'Close', exact: true })
await close.focus()
await page.evaluate(() => {
  const h = window.__FRESHELL_TEST_HARNESS__!
  const s = h.getState()
  const tabId = s.tabs.activeTabId!
  h.dispatch({ type: 'panes/setActivePane', payload: { tabId, paneId: s.panes.activePane[tabId], focusNudge: true } })
})
await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
await expect(close).toBeFocused()
const statusComposer = page.getByRole('textbox', { name: 'Chat message input' })
await expect(statusComposer).toBeEnabled()
await state.update({ status: 'exited' })
await expect(statusComposer).toBeDisabled()
await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
await expect(close).toBeFocused()
await state.update({ status: 'idle' })
await expect(statusComposer).toBeEnabled()
await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
await expect(close).toBeFocused()
```

The fixture's snapshot event currently hard-codes `status:'idle'`; in `seedCompactPane.update`, after assigning the new `current`, compute:

```ts
const status = FreshAgentSnapshotSchema.parse({
  ...freshAgentSnapshot(variant.sessionType, variant.provider, `compact-${variant.sessionType}`),
  ...current,
}).status
```

Add `status` to the existing page.evaluate argument object, and replace the event's hard-coded `status:'idle'` with `status:v.status`. The return type stays unchanged and the event status is schema-validated. Require the composer disabled/enabled transition as a setup assertion so an inert fixture cannot falsely pass. Preserve the existing body-origin Tab/Shift+Tab, native comments, replacement patch, Escape, typed-key, session-switch, hidden-tab, disabled/dynamic-control and menu tests.

- [ ] **Step 2: Run tests and verify intended failure**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e fresh-agent-compact-panels.spec.ts --grep 'keyboard drawer'`

Expected: FAIL because pane adoption moves focus out of Changes during a real disabled/epoch/pending-frame update. Confirm the exact focused element and snapshot status in the receipt; non-triggered fixture transitions do not qualify.

- [ ] **Step 3: Add minimal production implementation**

Inside the existing scheduled pane-adoption rAF immediately after `const active = document.activeElement`, before the editable-root check, insert:

```tsx
const drawer = active instanceof Element ? active.closest('.fresh-agent-diff-drawer-overlay') : null
if (drawer?.getAttribute('data-tab-id') === tabId
  && drawer.getAttribute('data-pane-id') === paneId) return
```

Add `tabId` and `paneId` to that effect's dependency array, retaining the other dependencies. The ownership check runs at callback time, so it covers a drawer opened after scheduling. Keep the key handler, usePaneFocusAdoption, shared descriptor restoration, explicit Composer actions, overlay synchronization and existing trap unchanged; the bounded Stage 2 evidence supports this local decision, not a universal sole-writer assertion. Focus-list advice is OPTIONAL: lazy traversal could reduce style reads for very large diffs. The existing live list preserves dynamic controls and no demonstrated latency defect requires additional machinery, so no benchmark gate, cache or speculative traversal rewrite belongs in this repair.

- [ ] **Step 4: Run focused tests**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx --config config/vitest/vitest.config.ts`

Run: `pnpm exec eslint src/components/fresh-agent/FreshAgentView.tsx`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e fresh-agent-compact-panels.spec.ts --grep 'keyboard drawer|Changes closes'`

Expected: PASS, including non-owner adoption, pending-frame case, draft preservation, real disabled transition and existing keyboard/dialog lifecycle. No recovered retry.

- [ ] **Step 5: Refactor while green**

Keep the two-attribute ownership check in the sole adoption callback, and remove any temporary instrumentation. No helper or cache is needed for this single use. Rerun the focused commands after cleanup.

- [ ] **Step 6: Run impacted verification**

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:vitest run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts`

Run: `GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e fresh-agent-compact-panels.spec.ts fresh-agent.spec.ts fresh-agent-mobile.spec.ts fresh-agent-hidden-approval-reveal.spec.ts fresh-agent-model-dialog-parity.spec.ts`

Expected: PASS with nonzero cloud cases, preserving ordinary explicit pane selection when no owned drawer holds focus. Existing unrelated pane-wide Space behavior stays outside this change.

- [ ] **Step 7: Commit task**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts
git commit -m "fix: preserve changes drawer focus during fresh agent updates"
```

### Task 4: Quiet screenshot display and honest portable historical records

**Files:**
- Modify: `scripts/e2e-cloud.sh:1019`
- Modify: `scripts/test/cloud-e2e-logging-receipt.test.sh:31`
- Modify: `docs/plans/2026-11-01-fresh-agent-compact-panels.md:1`
- Existing producer: `test/e2e-browser/specs/fresh-agent-compact-panels.spec.ts:231` (retain PNG/chunk emission).

**Interfaces:**
- Consumes unchanged `compact_panel_screenshot` JSONL `{event,severity,path,offset,data}` and retry-trace chunks. Produces human display with the same event/path/offset metadata and `data:"<retained-in-cloud-logging>"`; raw Cloud Logging data remains byte-for-byte reconstructable. No environment propagation, storage service or deployment.
- Historical document links distinguish a published PR from retained ignored local evidence. Prior review/test verdicts stay historical facts.

- [ ] **Step 1: Write failing behavioral runner test**

In the fake gcloud's `executions logs read` branch, after incrementing its read counter and before existing footer cases, add:

```bash
if [ "${STUB_SCREENSHOT_DISPLAY:-0}" = 1 ]; then
  cat "$STUB_CAPTURE/screenshot-display.log"
  echo '{"event":"e2e_playwright_retry_trace_chunk","artifactId":"trace-original","offset":0,"data":"RETRY_TRACE_BYTES_SHOULD_STAY_RAW"}'
  echo '{"event":"ordinary_diagnostic","message":"keep readable diagnostic"}'
fi
```

After `records_no_retry` is defined and before existing delayed-ingestion assertions, add a fixture that invokes the actual wrapper. Generate a valid large PNG so the display test uses realistic screenshot chunk volume, with structured and reporter-prefixed records; exact-execution raw image reconstruction is checked in Step 6:

```bash
node - "$WORK/capture" <<'NODE'
const fs = require('node:fs')
const zlib = require('node:zlib')
const root = process.argv[2]
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
  chunk('tEXt', Buffer.from('review\0' + 'large-review-note-'.repeat(1000))),
  chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk('IEND', Buffer.alloc(0)),
])
const base64 = png.toString('base64')
const records = []
for (let offset = 0; offset < base64.length; offset += 12000) {
  const payload = { event: 'compact_panel_screenshot', severity: 'INFO', path: 'test-results/review.png', offset, data: base64.slice(offset, offset + 12000) }
  records.push(offset === 0 ? { jsonPayload: payload } : { textPayload: '[chromium] ' + JSON.stringify(payload) })
}
const payload = record => record.jsonPayload ?? JSON.parse(record.textPayload.slice(record.textPayload.indexOf('{')))
const displayedRecords = records.filter(record => record.textPayload)
fs.writeFileSync(root + '/screenshot-display.log', displayedRecords.map(record => record.textPayload).join('\n') + '\n')
fs.writeFileSync(root + '/displayed-chunks.txt', displayedRecords.map(record => payload(record).data).join('\n') + '\n')
NODE
OUT="$(env PATH="$WORK/bin:$PATH" STUB_CAPTURE="$WORK/capture" STUB_SCREENSHOT_DISPLAY=1 STUB_LOGGING_JSON="$records_no_retry" GCLOUD_IDENT=stub@example.invalid "$SCRIPT" run --cloud --shards=2 2>&1)" || {
  echo "FAIL: screenshot-display wrapper run failed"; echo "$OUT"; exit 1
}
while IFS= read -r chunk; do
  [ -z "$chunk" ] && continue
  if grep -Fq "$chunk" <<< "$OUT"; then
    echo 'FAIL: default wrapper display leaked a screenshot payload chunk'; exit 1
  fi
done < "$WORK/capture/displayed-chunks.txt"
if grep -Fq 'RETRY_TRACE_BYTES_SHOULD_STAY_RAW' <<< "$OUT"; then
  echo 'FAIL: default wrapper display leaked retry-trace payload bytes'; exit 1
fi
for retained in compact_panel_screenshot test-results/review.png offset retained-in-cloud-logging ordinary_diagnostic 'keep readable diagnostic'; do
  if ! grep -Fq "$retained" <<< "$OUT"; then echo "FAIL: lost display metadata/diagnostic: $retained"; exit 1; fi
done
```

The human-display fixture includes only reporter-prefixed `textPayload` chunks; the structured first chunk is not printed by `executions logs read`. The shell assertions check the actual wrapper output for every screenshot data chunk that the formatter would display. The local stub payload is only a fixture for those display assertions; its bytes are not decoded because the exact-execution cloud check reconstructs and inspects records retained by Cloud Logging.

- [ ] **Step 2: Run test and verify intended failure**

Run: `bash scripts/test/cloud-e2e-logging-receipt.test.sh`

Expected: FAIL because the default runner display contains reporter-prefixed screenshot chunks before redaction; existing retry bytes should already be redacted. Preserve temporary-path ownership/cleanup used by this existing script. Record RED output under the task's test-results directory.

- [ ] **Step 3: Add minimal implementation and archival clarification**

Change the existing display redaction sed selector from only `e2e_playwright_retry_trace_chunk` to both events; match JSON whitespace without depending on reporter prefixes:

```bash
display_log_output=$(printf '%s\n' "$log_output" | sed -E \
  '/"event"[[:space:]]*:[[:space:]]*"(e2e_playwright_retry_trace_chunk|compact_panel_screenshot)"/ s/("data"[[:space:]]*:[[:space:]]*")[^"]*/\1<retained-in-cloud-logging>/' )
```

Update the adjacent comment to say both retry traces and review screenshots retain raw bytes in Cloud Logging and only their displayed data is redacted. Preserve runner summary/retry reconciliation, raw `log_output`, screenshot production, and raw remote records. Do not make the image emitter opt-in; that would silently discard the normal cloud artifact path.

Add a short dated archival note immediately below the historical plan title, separate from its immutable User Request:

```markdown
> Archived 2026-11-01: this document is the original implementation plan, including draft code and its original step checkboxes. The implementation later landed in [PR #894](https://github.com/danshapiro/freshell/pull/894), merge `520626c46b7e5bfcbdddd85480fd375cdc9cb783`. The capped plan-review loop remains **FAILED/non-converged**; later final implementation review passed. These are separate outcomes. See [landing receipt](../../test-results/fresh-agent-compact-panels/workflow/reports/landing-final.md) and [verification receipt](../../test-results/fresh-agent-compact-panels/workflow/reports/landing-verification.md), both retained local evidence and not published GitHub artifacts.
>
> Original unchecked steps describe the historical draft and are not a statement that the merged implementation is unfinished. The historical raw full check **FAILED**; its adjusted accepted-baseline result and exact excluded scope remain in the [Stage 5 receipt](../../test-results/fresh-agent-compact-panels/workflow/reports/stage-5-final-gate-receipt.md). No full-suite-green claim is made. The published PR is portable across checkouts; retained local evidence requires the preserved ignored `test-results/fresh-agent-compact-panels/` directory.
```

Replace the historical baseline evidence strings with Markdown links to `../../test-results/fresh-agent-compact-panels/workflow/reports/baseline-failure.md` and `../../test-results/fresh-agent-compact-panels/workflow/reports/workspace-baseline.md`, labeled retained local evidence. Replace the old load-bearing path with `../../test-results/fresh-agent-compact-panels/workflow/reports/load-bearing-validator-lb-2.md`, similarly labeled. Do not edit raw reports, old review accumulators, failed/aborted attempt receipts, capped review verdict, baseline waiver, old immutable worktree identity, or unchecked original steps. This run's reconciliation belongs in its own evidence/review ledger.

- [ ] **Step 4: Run focused tests and inspect document links**

Run: `bash scripts/test/cloud-e2e-logging-receipt.test.sh`

Expected: PASS; displayed screenshot metadata/ordinary diagnostics remain and every reporter-prefixed `textPayload` screenshot/trace data chunk is absent from wrapper display. The real cloud preservation check in Step 6 reconstructs and inspects the exact execution's retained images.

Run: `python3 -c 'from pathlib import Path; import subprocess; repo=Path(subprocess.check_output(["git","rev-parse","--git-common-dir"],text=True).strip()).resolve().parent; paths=["baseline-failure.md","workspace-baseline.md","load-bearing-validator-lb-2.md","landing-final.md","landing-verification.md","stage-5-final-gate-receipt.md"]; root=repo/"test-results/fresh-agent-compact-panels/workflow/reports"; print("\n".join(str((root/name).resolve()) for name in paths)); assert all((root/name).is_file() for name in paths)'`

Expected: six actual retained paths resolve in the original checkout located through Git's common directory. The ignored evidence is not copied into the feature worktree: a plan link in a fresh worktree without that retained directory remains explicitly qualified as local evidence. The published PR is the checkout-independent reference. Do not copy large evidence/workspaces merely to make a worktree link check pass; do not introduce a prose-match product test. Read rendered Markdown and the linked receipt summaries to confirm the statuses are described faithfully.

- [ ] **Step 5: Refactor while green**

Keep one display redaction expression and one raw artifact format. Remove temporary test duplication/instrumentation, preserving footer/structured receipt regressions. Rerun the shell test. No shared artifact abstraction or screenshot-storage redesign is required.

- [ ] **Step 6: Run impacted runner contracts and real cloud preservation check**

Run: `bash scripts/test/cloud-e2e-logging-receipt.test.sh`

Run: `bash scripts/test/cloud-e2e-retry-receipt.test.sh`

Run: `bash scripts/test/cloud-e2e-structured-receipts.test.sh`

Expected: PASS, preserving skipped-only rejection, ingestion lag, exact task attribution, recovered-retry rejection and raw metadata.

Run from the task worktree after all product changes:

```bash
mkdir -p test-results/fresh-agent-review-polish
set -o pipefail
GCLOUD_ROBOT_REQUIRE=1 pnpm run test:e2e fresh-agent-compact-panels.spec.ts 2>&1 | tee test-results/fresh-agent-review-polish/final-compact-browser.log
```

Expected: nonzero cloud GREEN without bulky image bytes in default terminal output. Fetch only that exact execution's raw records, with the same identity ladder as the runner; do not query a latest shared job. The following evidence-only commands use repository-owned identity code and contain the complete extractor, so ignored historical tooling is not an execution dependency:

```bash
set -euo pipefail
GCP_PROJECT="${FRESHELL_GCP_PROJECT:-misc-puttering-project}"
GCP_ACCOUNT="${FRESHELL_GCP_ACCOUNT:-}"
export GCLOUD_ROBOT_REQUIRE=1
source scripts/lib/gcp-identity.sh
freshell_resolve_cloud_identity 'logging.logEntries.list'
polish_execution="$(python3 - test-results/fresh-agent-review-polish/final-compact-browser.log <<'PY'
import re, sys
text = re.sub(r'\x1b\[[0-9;]*m', '', open(sys.argv[1]).read())
matches = re.findall(r'Execution \[?([A-Za-z0-9][A-Za-z0-9-]*)', text)
if len(set(matches)) != 1:
    raise SystemExit('Need exactly one attributed execution in this run receipt')
print(matches[0])
PY
)"
test -n "$polish_execution"
gcloud logging read "resource.type=\"cloud_run_job\" AND labels.\"run.googleapis.com/execution_name\"=\"${polish_execution}\" AND (jsonPayload.event=\"compact_panel_screenshot\" OR textPayload:\"compact_panel_screenshot\")" --account="$GCP_ACCOUNT" --project="$GCP_PROJECT" --format=json --limit=100000 > test-results/fresh-agent-review-polish/raw-screenshots.json
python3 - test-results/fresh-agent-review-polish/raw-screenshots.json test-results/fresh-agent-review-polish/reconstructed <<'PY'
import base64, json, pathlib, sys
from PIL import Image
entries = json.loads(pathlib.Path(sys.argv[1]).read_text())
destination = pathlib.Path(sys.argv[2])
destination.mkdir(parents=True, exist_ok=True)
chunks = {}
for entry in entries:
    payload = entry.get('jsonPayload')
    if not payload or 'event' not in payload:
        text = entry.get('textPayload', '')
        try:
            payload = json.loads(text[text.index('{'):])
        except (ValueError, json.JSONDecodeError):
            continue
    if payload.get('event') != 'compact_panel_screenshot':
        continue
    parts = chunks.setdefault(payload['path'], {})
    previous = parts.get(payload['offset'])
    if previous is not None and previous != payload['data']:
        raise ValueError('Conflicting screenshot offset')
    parts[payload['offset']] = payload['data']
if not chunks:
    raise SystemExit('No raw screenshot chunks found; do not claim preservation')
receipts = []
for name, parts in sorted(chunks.items()):
    expected = 0
    for offset, data in sorted(parts.items()):
        if offset != expected:
            raise ValueError(f'Missing screenshot offset for {name}: {expected}')
        expected += len(data)
    data = base64.b64decode(''.join(data for _, data in sorted(parts.items())), validate=True)
    path = destination / pathlib.Path(name).name
    path.write_bytes(data)
    with Image.open(path) as screenshot:
        screenshot.load()
        receipts.append({'source': name, 'path': str(path), 'bytes': len(data), 'width': screenshot.width, 'height': screenshot.height})
(destination / 'receipts.json').write_text(json.dumps(receipts, indent=2) + '\n')
print(json.dumps(receipts, indent=2))
PY
```

The existing environment used Pillow for the previous retained extractor; if missing, prepare it in the task's `.test-tmp/` Python virtual environment and record/clean that owned directory rather than changing global Python. Raw records may arrive after the runner footer; if missing, retry the exact execution query through the already documented bounded ingestion window and retain failed retrieval attempts. Inspect selected desktop, phone, serif/mono and tiny PNGs. Record execution/image/SHA and the generated receipt paths. Do not claim raw storage is smaller; only terminal display is quieter.

- [ ] **Step 7: Commit task**

```bash
git add scripts/e2e-cloud.sh scripts/test/cloud-e2e-logging-receipt.test.sh docs/plans/2026-11-01-fresh-agent-compact-panels.md
git commit -m "fix: quiet screenshot display and clarify compact panel history"
```

## Requirement-to-evidence map and final gate

| Requested finding | Observable result | Required evidence |
| --- | --- | --- |
| 7, routine/delivery/expiry subcases | Single routine feedback in summary; prevention instruction painted before expansion; real disclosure controls timer across insertion/removal/severity | Task 1 callback/view/send RED/GREEN; Task 2 closed text geometry; provider/Rust-backed affected browser cases |
| 8, narrow/tiny/multiple diagnostics/metadata | Intrinsic request allocation; both concise labels painted; no empty tiny request floor; a real metadata line; supported transcript/full composer | Task 2 measured matrix plus existing styles/themes/scales/split/nested reachability and all answers/recoveries |
| 9, JSON/native duplicate | Generic short JSON wraps; native root once; other scope/decisions unchanged | Task 2 parse/value/callback unit tests and actual preview/control/browser frame checks |
| 10, focus/performance advice | Owned drawer focus survives the specified retained pane/session/rAF/epoch adoption updates; no speculative cache | Task 3 real drawer unit/browser keyboard cases; Stage 2 bounded causal/ownership evidence and explicit OPTIONAL focus-list disposition |
| 11, accessible severity count | Accessibility tree contains named breakdown and updated numeric total | Task 1 semantic role/rerender tests and scoped browser ARIA evidence |
| 12, screenshot/history | Small default display, raw reconstructable images; portable published PR link and accurately qualified local evidence/history | Task 4 real-runner shell contracts, raw cloud reconstruction/inspection, manual filesystem/link/receipt verification |

Before any completion claim, the parent usual workflow must finish required task reviews/delta/final verification and retain exact current-run receipts. The coordinated final check is `GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='Fresh Agent review polish final verification' pnpm run check`; it does not run Playwright, so the affected browser union above is independently required. Preserve every raw failure. Only this run's ledger-recorded baseline failures, reproduced at immutable base `520626c46b7e5bfcbdddd85480fd375cdc9cb783`, may qualify an adjusted gate under the user's waiver; the previous compact-panel task's different historical build/lint qualification is not inherited. Raw final check FAILED remains FAILED even if an adjusted gate accepts precisely reproduced baseline exceptions. Do not report the seven blocked provider-contract cases, skipped cloud/external specs, or a passing subset as full-suite coverage.


If the coordinated check returns after a reproduced waived companion failure and leaves default phases unreached, preserve that failure and run these supported continuations at the same committed HEAD; they provide their own receipts and do not repair/relabel the failed companion:

```bash
GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='Fresh Agent review polish source-runtime continuation' pnpm run test:source-runtime
GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='Fresh Agent review polish Rust continuation' pnpm run test:rust
GCLOUD_ROBOT_REQUIRE=1 FRESHELL_RUST_TEST_SANDBOX=1 FRESHELL_TEST_SUMMARY='Fresh Agent review polish Electron continuation' pnpm run test:vitest run --config config/vitest/vitest.electron.config.ts
```

Expected: each continuation PASS with nonzero actual coverage and settled sandbox/resources. A new failure is not automatically covered by the waiver. Unexecuted or blocked scopes remain explicitly unexecuted/blocked in the final receipt; broad Rust passing does not turn the blocked JavaScript provider-contract cases into coverage.

Scope exclusions remain explicit: finding 6 baseline lint, existing pane-wide Space behavior, deployments/restarts, provider architecture, and unmeasured focus caching. If a binding outcome cannot be met, retain the result as FAILED/non-converged with the exact conflict rather than silently deferring it. End with a clean committed feature worktree; push is allowed by repository policy, but PR creation/landing/worktree removal require the user's later explicit approval under the parent workflow.
