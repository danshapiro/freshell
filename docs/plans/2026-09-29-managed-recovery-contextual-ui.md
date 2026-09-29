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

**Architecture:** Keep WebSocket negotiation, `managedRuntimeSlice`, supervisor inventory reconciliation, projection fields, session identity, and history behavior unchanged. Remove the fixed managed-agent dashboard and its resource editor. Add one presentational pane-local amber card driven by the already-projected `recoverySummary`; it offers same-soul retry for `blocked` and an explicitly labeled start-new action for certified `lost` state. Keep a narrow global notice path only for cleanup failures that have no pane-local decision, while silently retiring successful cleanup and ordinary-ended notices.

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
- Modify: `src/App.tsx` to remove the managed dashboard and notice mounts/imports while retaining managed-runtime readiness and refresh wiring.
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

Remove the dashboard and resource-editor imports/mounts from `App.tsx`. In `ManagedRuntimeNotices`, partition fetched notices by `kind === 'cleanup_failed'`; acknowledge non-actionable notices using the existing receipt endpoint, keep polling only while the managed capability and WebSocket are ready, and render the first actionable notice with the existing amber border/background classes, `role="alert"`, its user-facing message, Details when an incident exists, and Dismiss. Remove the 10-second auto-acknowledgement for the actionable error so the user can decide when to dismiss it. Delete the now-orphaned dashboard and resource-editor files.

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
- Modify: `src/components/TerminalView.tsx` to render the card only for projected `blocked`/`lost` states, retry the same soul with its revision fence, refresh inventory, and reuse the existing explicit start-fresh action for lost sessions.
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` to render the same card, retry with the projected revision, refresh inventory, and reuse the existing kill-before-new-conversation action for lost sessions.
- Modify: `test/unit/client/components/TerminalView.launchRetry.test.tsx` or the nearest existing TerminalView focused fixture to cover managed blocked/lost presentation and no automatic replacement.
- Modify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` with a focused managed blocked/lost case if its existing fixture can provide the projection without broad lifecycle setup.
- Modify: `test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts` and `test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts` only where they locate the removed dashboard/normal notice; retain their backend identity, detach/stop, incident, cleanup, and history assertions through existing pane or rig actions.
- Modify: `docs/index.html` to remove the routine “Restarting agent”/cleanup-notice mock and show the contextual amber intervention card in the affected pane.

**Interfaces:**
- Consumes: `ManagedRuntimeRecoverySummary`, `TerminalPaneContent`/`FreshAgentPaneContent` projection fields, `retryManagedRuntimeSoul`, `queueManagedRuntimeRefresh`, and the existing parent callbacks `startFreshConversation` and `startNewConversation`.
- Produces: `ManagedRuntimeRecoveryCard({ recoverySummary, onRetry, onStartFresh })`, returning `null` for `live`, `recovering`, `stopped`, or missing summaries and rendering one amber `role="alert"` only for `blocked` or `lost`.

- [ ] **Step 1: Write the failing behavioral test**

Create `ManagedRuntimeRecoveryCard.test.tsx` with a minimal provider-free render of the card. Cover: `live` and `recovering` render nothing; `blocked` renders one yellow alert and “Retry recovery”, calls the supplied async retry callback once, and reports a failed retry in the same card; `lost` renders a yellow alert explaining that the existing conversation could not be recovered and an explicitly labeled “Start new conversation” button that calls only after a user click. Assert that no test path creates a session during render.

- [ ] **Step 2: Run the test and verify the intended failure**

Run:

```bash
pnpm run test:vitest run test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx --config config/vitest/vitest.config.ts
```

Expected: FAIL because the component does not yet exist.

- [ ] **Step 3: Add the minimal production implementation**

Implement the card with this decision table:

```tsx
if (!summary || !['blocked', 'lost'].includes(summary.recoveryState)) return null
const blocked = summary.recoveryState === 'blocked'
return (
  <div role="alert" data-testid="managed-runtime-recovery-card" className="...amber...">
    <span>{blocked
      ? 'This session needs attention before it can continue.'
      : 'This session could not be recovered. Its existing conversation is still available in history.'}</span>
    {blocked ? <button onClick={retry}>Retry recovery</button>
      : <button onClick={onStartFresh}>Start new conversation</button>}
    {error ? <p role="alert">{error}</p> : null}
  </div>
)
```

In `TerminalView`, call `retryManagedRuntimeSoul(terminalContent.soulId, terminalContent.soulIntentRevision)` and then `queueManagedRuntimeRefresh(appStore, 'pane-recovery-retry')`; do not render the card when a more specific launch, owner-divergence, handoff, or existing terminal-exit card already owns the decision. For `lost`, reuse the existing `startFreshConversation`, which explicitly clears the old durable identity only after the user clicks. In `FreshAgentView`, use the same fenced retry call and inventory refresh, suppress the duplicate generic ended-session card while the managed lost card is visible, and reuse `startNewConversation` for the explicit new-conversation click. Do not change the existing provider recovery or session-history reducers unless a focused test proves they silently replace a managed lost session.

- [ ] **Step 4: Run the focused tests**

Run:

```bash
pnpm run test:vitest run \
  test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx \
  test/unit/client/components/TerminalView.launchRetry.test.tsx \
  test/unit/client/components/fresh-agent/FreshAgentView.test.tsx \
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
  test/unit/client/components/panes/HostStatsPane.test.tsx \
  --config config/vitest/vitest.config.ts
```

If the managed-runtime browser specs have a stable configured backend, run the affected selectors through the repository’s configured e2e wrapper and preserve the existing unrelated baseline failure in the run ledger.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/ManagedRuntimeRecoveryCard.tsx src/components/TerminalView.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/ManagedRuntimeRecoveryCard.test.tsx test/unit/client/components/TerminalView.launchRetry.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/e2e-browser/specs/runtime-lost-soul-notice-rust.spec.ts test/e2e-browser/specs/runtime-tabs-rehydrate-rust.spec.ts docs/index.html
git commit -m "feat(ui): show managed recovery in agent panes"
```

The task is complete only when existing agent panes, session history, explicit new-conversation semantics, and load-only System Status remain intact.
