# Contextual Managed Recovery UI Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Implement the revised durable-runtime UI so automatic recovery stays invisible; use existing yellow error popups only when a user decision or intervention is needed; keep System Status focused on system load; remove the persistent managed-runtime dashboard, routine notices, and per-agent resource controls; preserve existing agent panes and session history/actions.

### Explicit constraints
- Use the existing pane/agent error surfaces and yellow error popups for failures or decisions.
- Do not add a System Status error surface; System Status remains load/resource monitoring.
- Do not expose lifecycle/recovery details during normal operation.
- Do not silently create a replacement conversation; retain history and explicitly label any start-new action.
- Work in a dedicated worktree and complete the-usual workflow with tests and independent review.

### Accepted tradeoffs and residuals
- Runtime recovery internals and diagnostics may remain available to the implementation and existing panes; only unnecessary always-visible user-facing surfaces should be removed.
- Existing unrelated OpenCode baseline test failure is outside this UI change.

**Goal:** Make managed-runtime recovery quiet during healthy operation and actionable only in the affected agent pane when the user must intervene.

**Architecture:** Keep WebSocket negotiation, `managedRuntimeSlice`, supervisor inventory reconciliation, projection fields, session identity, and history behavior intact. Remove the fixed managed-agent dashboard and its resource editor. Add one presentational pane-local amber card driven by the projected `recoverySummary`; it offers same-soul retry for `blocked` and an explicitly labeled start-new action for certified `lost` state. Keep the existing notice mount only for cleanup failures that have no pane-local decision, while silently retiring successful cleanup and ordinary-ended notices. Repair the client merge so represented lost souls reach their existing panes without reconstructing or launching a replacement.

**Tech Stack:** React 18, TypeScript, Redux Toolkit selectors, existing `FreshAgentApprovalBanner`/terminal amber-card patterns, Vitest/Testing Library, and the existing Playwright managed-runtime coverage.

## Global Constraints

- Work only in `/home/dan/code/freshell/.worktrees/managed-recovery-contextual-ui` on `the-usual/managed-recovery-contextual-ui`; never edit the primary checkout.
- The immutable base is `12e5e9f55fa049fd33b81f8f7ff64f451605b907`.
- Preserve the pre-existing `.tmp-native-smoke/` changes in the primary checkout.
- Use pnpm `10.34.5`, frozen installs, repository-owned test commands, and the configured Cloud Run backend for broad gates.
- Do not weaken, skip, or delete tests merely to obtain a green result. The baseline has one ledger-recorded unrelated failure in `test/unit/tooling/testing/opencode-native-history.test.ts`.
- Keep System Status (`HostStatsPane`) load-only. Do not route runtime recovery or incident data into it.
- Preserve session identity, history, existing pane actions, and the explicit kill-before-new-conversation semantics. Never auto-create a replacement conversation.
- Update `docs/index.html` for this significant user-facing UI change.

---

### Task 1: Remove always-visible managed-runtime surfaces and retain only actionable error delivery

**Files:**
- Modify: `src/App.tsx` to remove the managed dashboard import/mount while retaining the narrow cleanup-failure notice mount, managed-runtime readiness, and refresh wiring.
- Delete: `src/components/ManagedAgentRecoveryStatus.tsx`.
- Delete: `src/components/AgentResourceLimits.tsx`.
- Modify: `src/components/ManagedRuntimeNotices.tsx` to show only cleanup failures in the existing amber error-popup style, silently acknowledge routine success/ended notices, and never show a ready count, startup scan, IDs, or resource controls.
- Modify: `test/unit/client/components/ManagedRuntimeNotices.test.tsx` to protect actionable-error-only behavior.
- Delete: `test/unit/client/components/ManagedAgentRecoveryStatus.test.tsx` after its dashboard/resource assertions are replaced by Task 2 card tests.

**Interfaces:**
- Consumes: `getManagedRuntimeNotices`, `recordManagedRuntimeNoticeReceipt`, `ManagedRuntimeNotice`, and the existing `managedRuntime.available`/connection selectors.
- Produces: no new public API; App continues to expose only internal managed-runtime recovery state and pane projections.

- [ ] **Step 1: Write the failing behavioral test**

Add tests to `ManagedRuntimeNotices.test.tsx` that render a `cleanup_succeeded` and an `ended_without_process` notice and assert no popup is rendered, while a `cleanup_failed` notice renders one amber `role="alert"` with its message and an explicit Dismiss action. Assert routine notices are acknowledged through the existing receipt API so they do not block later actionable notices. Assert the component never renders `Managed agent recovery`, `ready`, `Resource limits and usage`, or a runtime identifier.

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
pnpm run test:vitest run test/unit/client/components/ManagedRuntimeNotices.test.tsx --config config/vitest/vitest.config.ts
```

Expected: FAIL because the current component renders successful and ended notices and uses the old generic popup behavior.

- [ ] **Step 3: Add the minimal production implementation**

Remove only the dashboard import/mount from `App.tsx`; keep the notice mount. In `ManagedRuntimeNotices`, partition fetched notices by `kind === 'cleanup_failed'`; acknowledge non-actionable notices using the existing receipt endpoint, keep polling only while the managed capability and WebSocket are ready, and render the first actionable notice with the existing amber border/background classes, `role="alert"`, its user-facing message, Details when an incident exists, and Dismiss. Remove the 10-second auto-acknowledgement for the actionable error so the user can decide when to dismiss it. Delete the now-orphaned dashboard and resource-editor files.

- [ ] **Step 4: Run the focused test**

Run the command from Step 2.

Expected: PASS, including the routine-notice suppression and cleanup-failure popup behavior.

- [ ] **Step 5: Refactor while green**

Keep notice filtering and acknowledgement in small named helpers, keep the existing API/receipt contracts unchanged, and remove dead imports/constants without changing managed-runtime refresh or host-stats code.

- [ ] **Step 6: Run impacted-test verification**

Run:

```bash
pnpm run test:vitest run \
  test/unit/client/components/ManagedRuntimeNotices.test.tsx \
  test/unit/client/components/App.machine-identity.test.tsx \
  test/unit/client/components/App.inventory-title-fold.test.tsx \
  test/unit/client/components/panes/HostStatsPane.test.tsx \
  test/unit/client/components/App.hoststats-ws.test.tsx \
  --config config/vitest/vitest.config.ts
```

Expected: PASS. The App tests must still cover managed-runtime bootstrap indirectly, and HostStats tests must remain unchanged and load-only.

- [ ] **Step 7: Commit the task**

```bash
git add src/App.tsx src/components/ManagedRuntimeNotices.tsx test/unit/client/components/ManagedRuntimeNotices.test.tsx
git rm src/components/ManagedAgentRecoveryStatus.tsx src/components/AgentResourceLimits.tsx test/unit/client/components/ManagedAgentRecoveryStatus.test.tsx
git commit -m "refactor(ui): remove managed runtime dashboard"
```

Do not modify `HostStatsPane` or the managed-runtime backend/API contracts in this task.

### Task 2: Surface blocked and lost recovery inside the affected pane

**Files:**
- Create: `src/components/ManagedRuntimeRecoveryCard.tsx`.
- Create: `test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx`.
- Modify: `src/lib/recovery/managed-runtime-recovery.ts` so an already represented `desiredState: 'stopped', recoveryState: 'lost'` soul updates its existing pane projection without creating a new tab or launching a replacement.
- Modify: `test/unit/lib/managed-runtime-recovery.test.ts` with terminal and Fresh Agent live-to-lost merge coverage, including the no-create rule for absent lost views.
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` recovery effects and deferred reconcile callbacks so managed `blocked`/`lost` projections cannot arm provider recovery or an identity-less create before the explicit user action.
- Modify: `src/components/TerminalView.tsx` to render the card only for projected `blocked`/`lost` states, retry the same soul with its revision fence, refresh inventory, and reuse the existing explicit start-fresh action for lost sessions.
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` to render the same card, retry with the projected revision, refresh inventory, and reuse the existing kill-before-new-conversation action for lost sessions.
- Modify: `test/unit/client/components/TerminalView.launchRetry.test.tsx` or the nearest existing TerminalView focused fixture to cover managed blocked/lost presentation and no automatic replacement.
- Modify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` with a focused managed blocked/lost case if its existing fixture can provide the projection without broad lifecycle setup.

**Interfaces:**
- Consumes: `ManagedRuntimeRecoverySummary`, `TerminalPaneContent`/`FreshAgentPaneContent` projection fields, `retryManagedRuntimeSoul`, `queueManagedRuntimeRefresh`, and the existing parent callbacks `startFreshConversation` and `startNewConversation`.
- Produces: `ManagedRuntimeRecoveryCard({ recoverySummary, onRetry, onStartFresh })`, returning `null` for `live`, `recovering`, `stopped`, or missing summaries and rendering one amber `role="alert"` only for `blocked` or `lost`.

- [ ] **Step 1: Write the failing behavioral test**

Create `ManagedRuntimeRecoveryCard.test.tsx` with a minimal provider-free render of the card. Cover: `live` and `recovering` render nothing; `blocked` renders one yellow alert and “Retry recovery”, calls the supplied async retry callback once, and reports a failed retry in the same card; `lost` renders a yellow alert explaining that the existing conversation could not be recovered and an explicitly labeled “Start new conversation” button that calls only after a user click. Extend `test/unit/lib/managed-runtime-recovery.test.ts` with real merge-plan cases proving a represented stopped/lost terminal and Fresh Agent receive the lost projection while an absent lost view produces no create. Add a FreshAgentView regression fixture proving managed blocked/lost state prevents both the normal `.lost` effect and a deferred fresh verdict from arming an identity-less create. Assert that no test path creates a session during render.

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
pnpm run test:vitest run test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx --config config/vitest/vitest.config.ts
```

Expected: FAIL because the component does not yet exist.

- [ ] **Step 3: Add the minimal production implementation**

Implement the card with this decision table and prop shape:

```tsx
type Props = {
  recoverySummary?: ManagedRuntimeRecoverySummary
  onRetry: () => Promise<void>
  onStartFresh: () => void
}

function ManagedRuntimeRecoveryCard({ recoverySummary, onRetry, onStartFresh }: Props) {
  const summary = recoverySummary
  if (!summary || !['blocked', 'lost'].includes(summary.recoveryState)) return null
  const blocked = summary.recoveryState === 'blocked'
  return (
  <div
    role="alert"
    data-testid="managed-runtime-recovery-card"
    className="pointer-events-auto flex items-center justify-between gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
  >
    <span>{blocked
      ? 'This session needs attention before it can continue.'
      : 'This session could not be recovered. Its existing conversation is still available in history.'}</span>
    {blocked ? <button onClick={() => void onRetry()}>Retry recovery</button>
      : <button onClick={onStartFresh}>Start new conversation</button>}
  </div>
  )
}
```

In `buildManagedRuntimeMergePlan`, match and update existing pane locations for `recoveryState === 'lost'` even when `desiredState === 'stopped'`, then keep the visible-only creation path gated to desired running souls; a lost soul absent from local layout must never create a new pane. In `TerminalView`, call `retryManagedRuntimeSoul(terminalContent.soulId, terminalContent.soulIntentRevision)` and then `queueManagedRuntimeRefresh(appStore, 'pane-recovery-retry')`; do not render the card when a more specific launch, owner-divergence, handoff, or existing terminal-exit card already owns the decision. For `lost`, reuse the existing `startFreshConversation`, which explicitly clears the old durable identity only after the user clicks. In `FreshAgentView`, guard both the `.lost` recovery effect and any deferred/reconcile callback on the current managed summary, use the same fenced retry call and inventory refresh, suppress the duplicate generic ended-session card while the managed lost card is visible, and reuse `startNewConversation` for the explicit new-conversation click. A managed `lost` or `blocked` state must retain the old session reference until the user chooses a new conversation; a new-conversation transition must clear `soulId`, `incarnationId`, `runtimeState`, `viewIntentId`, `viewIntentRevision`, `soulIntentRevision`, `incidentId`, `placementGroup`, `resourceSummary`, and `recoverySummary` so an old inventory snapshot cannot reattach the new pane to the retired soul.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
pnpm run test:vitest run \
  test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx \
  test/unit/client/components/TerminalView.launchRetry.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/lib/managed-runtime-recovery.test.ts \
  --config config/vitest/vitest.config.ts
```

Expected: PASS. The managed card is silent during automatic recovery, exposes only the affected pane’s decision, preserves the existing session reference until an explicit new-conversation action, and keeps existing terminal/fresh-agent tests green.

- [ ] **Step 5: Refactor while green**

Keep the card presentational and small, share its copy and amber classes across both parents, and keep retry ownership in each parent so each API call carries the current pane’s revision fence. Ensure repeated runtime snapshots clear the card automatically when recovery becomes `live`.

- [ ] **Step 6: Run impacted-test verification**

Run:

```bash
pnpm run test:vitest run \
  test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx \
  test/unit/client/components/TerminalView.launchRetry.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
  test/unit/lib/managed-runtime-recovery.test.ts \
  test/unit/client/components/panes/HostStatsPane.test.tsx \
  --config config/vitest/vitest.config.ts
```

If the managed-runtime browser specs have a stable configured backend, run the affected selectors through the repository’s configured e2e wrapper and preserve the existing unrelated baseline failure in the run ledger.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/ManagedRuntimeRecoveryCard.tsx src/components/TerminalView.tsx src/components/fresh-agent/FreshAgentView.tsx src/lib/recovery/managed-runtime-recovery.ts src/store/panesSlice.ts test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx test/unit/client/components/TerminalView.launchRetry.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/unit/lib/managed-runtime-recovery.test.ts
git commit -m "feat(ui): show managed recovery in agent panes"
```

The task is complete only when existing agent panes, session history, explicit new-conversation semantics, and load-only System Status remain intact.

### Task 3: Preserve managed view intent on ordinary close and align product examples

**Files:**
- Modify: `src/components/panes/PaneContainer.tsx` (or the shared close thunk if that is the smallest existing seam) to mark a managed view `detached` with its current view/soul revision before removing the pane, preserving close failure behavior when the server does not acknowledge the visibility change.
- Modify: `test/unit/client/components/panes/PaneContainer.test.tsx` or the focused close-thunk test to cover managed detach-before-close and the refusal/error path.
- Modify: `test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts` to replace dashboard Close view interaction with ordinary pane close and assert the running soul remains detached after an inventory refresh; retain Stop agent coverage through the existing terminal shift-close path or rig action as appropriate.
- Modify: `test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts` to stop expecting a routine success notice and instead assert the actionable cleanup-failure or pane-local error path actually rendered; retain incident persistence, exact cleanup, identity, and receipt assertions consistent with what the UI displays.
- Modify: `docs/index.html` to remove the routine “Restarting agent”/cleanup-notice mock and show the contextual amber intervention card in the affected pane.

**Interfaces:**
- Consumes: managed pane projection fields (`viewIntentId`, `viewIntentRevision`, `soulIntentRevision`), `updateManagedRuntimeViewVisibility`, existing pane close acknowledgements, and existing browser helpers.
- Produces: ordinary pane/tab close detaches a managed view before layout removal, while unmanaged pane close behavior remains unchanged.

- [ ] **Step 1: Write the failing behavioral test**

Add a focused close test with a managed terminal pane carrying a view ID and both revision values. Assert the visibility PATCH is sent with `detached` and the current revisions before the close thunk removes the pane; assert an API refusal leaves the pane visible and exposes its existing close error surface. Add a browser assertion that the affected managed view is not recreated after a later inventory refresh.

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
pnpm run test:vitest run test/unit/client/components/panes/PaneContainer.test.tsx --config config/vitest/vitest.config.ts
```

Expected: FAIL because ordinary close currently journals pane removal without updating the managed view intent’s visibility.

- [ ] **Step 3: Add the minimal production implementation**

Before the existing `closePaneWithCleanup` dispatch for managed terminal and Fresh Agent panes, send `updateManagedRuntimeViewVisibility(viewIntentId, 'detached', viewIntentRevision, soulIntentRevision)`. Await the acknowledgement; on failure, leave the pane in place and use the existing pane-close error path. Keep terminal detach and Fresh Agent kill/close sequencing intact, and skip the managed PATCH for panes without a view intent.

- [ ] **Step 4: Run the focused test**

Run the command from Step 2.

Expected: PASS, including unchanged unmanaged close behavior.

- [ ] **Step 5: Refactor while green**

Keep the managed-detach operation in one helper used by pane and tab close paths, preserve revision fencing, and avoid reintroducing a global stop/detach control surface.

- [ ] **Step 6: Run impacted-test verification**

Run:

```bash
pnpm run test:vitest run \
  test/unit/client/components/panes/PaneContainer.test.tsx \
  test/unit/client/components/panes/PaneContainer.createContent.test.tsx \
  test/unit/client/components/ManagedRuntimeNotices.test.tsx \
  test/unit/lib/managed-runtime-recovery.test.ts \
  --config config/vitest/vitest.config.ts
```

If the configured e2e backend and runtime fixtures are available, run the two affected specs with the repository’s e2e wrapper. Do not weaken or skip their backend identity and cleanup assertions because the dashboard was removed.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/panes/PaneContainer.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts docs/index.html
git commit -m "fix(ui): preserve managed view intent on close"
```
