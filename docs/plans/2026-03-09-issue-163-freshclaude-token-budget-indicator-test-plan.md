# Issue 163 FreshClaude Token Budget Indicator Test Plan

Strategy reconciliation: no user-approval changes are needed. The implementation plan confirms the original strategy still holds: this is a client-side pane-header parity change, the existing Vitest React harnesses are sufficient with small extensions, the percentage must come from indexed Claude sessions keyed by `cliSessionId` first and `resumeSessionId` second, and there are no new paid APIs, infrastructure requirements, or server-side contracts that need separate test infrastructure.

## Harness requirements

### 1. PaneContainer FreshClaude unit harness

- What it does: extends the existing `test/unit/client/components/panes/PaneContainer.test.tsx` harness so a single `PaneContainer` can be rendered with preloaded `sessions` and `agentChat` state, while `AgentChatView` is mocked out to keep assertions focused on the header.
- What it exposes: programmatic store setup for `panes`, `tabs`, `sessions`, `agentChat`, `terminalMeta`, and dispatch access for follow-up actions such as `applySessionsPatch` and `turnResult`; DOM inspection of the pane header label and tooltip.
- Estimated complexity: low.
- Tests that depend on it: 3, 4, 7.

### 2. App pane-header parity harness

- What it does: extends the existing `test/e2e/pane-header-runtime-meta-flow.test.tsx` harness so the full app can boot with an optional FreshClaude pane, preloaded `agentChat` state, mocked `AgentChatView`, mocked `/api/sessions*` bootstrap responses, and live store/websocket updates.
- What it exposes: realistic app bootstrap, websocket `ready`/metadata events, sessions API bootstrap data, Redux dispatch for later session patches, and DOM assertions against rendered pane headers.
- Estimated complexity: medium.
- Tests that depend on it: 1, 2.

### 3. Shared formatter unit harness

- What it does: reuses the existing `test/unit/client/components/panes/PaneHeader.test.tsx` formatter tests to compare pure `formatPaneRuntimeLabel` / `formatPaneRuntimeTooltip` outputs without rendering the full app.
- What it exposes: direct function calls with CLI-shaped and FreshClaude-shaped runtime metadata.
- Estimated complexity: low.
- Tests that depend on it: 5, 6.

## Test plan

Named sources of truth used below:

- Issue #163 acceptance criteria: FreshClaude panes display the same percent-used indicator as CLI terminal panes; the indicator reflects context-window or token-budget percentage consumed; placement and styling match the existing CLI implementation.
- Issue conversation directive: use Claude session metadata semantics already powering CLI token percentages; resolve from indexed client sessions keyed by `cliSessionId` first and `resumeSessionId` second; do not approximate from SDK per-turn totals.
- Implementation plan, Architecture and Key Decisions: keep rendering in `PaneContainer`, reuse the shared formatter path, wire behavior only for FreshClaude in this issue, and avoid cwd heuristics or a broader refactor.
- Existing CLI reference implementation: current pane-header formatter contract in `src/lib/format-terminal-title-meta.ts` and current app-level pane-header metadata flow in `test/e2e/pane-header-runtime-meta-flow.test.tsx`.
- Existing FreshClaude identity flow: `sdk.session.init` stores `cliSessionId` in `agentChat`, and `AgentChatView` persists it back to `resumeSessionId`.

1. Name: FreshClaude panes show, update, and clear the same percent-used indicator during normal app runtime.
   Type: scenario.
   Harness: App pane-header parity harness.
   Preconditions: The app boots with one CLI pane and one FreshClaude pane; the FreshClaude pane has an SDK session in `agentChat.sessions` whose `cliSessionId` matches an indexed Claude session returned by `/api/sessions*`; the indexed session includes `gitBranch`, `isDirty`, and `tokenUsage.compactPercent`.
   Actions:
   1. Render `<App />`, let websocket bootstrap complete, and provide the terminal metadata snapshot for the CLI pane plus indexed sessions data for the FreshClaude pane.
   2. Confirm both pane headers are visible.
   3. Update the indexed FreshClaude session with a different `compactPercent`.
   4. Remove the indexed FreshClaude session and then dispatch an `sdk.result`-style token-total update for the SDK session.
   Expected outcome:
   - The FreshClaude header renders the same label contract as the CLI header, including repository/subdir, branch dirty marker, and percent text such as `freshell (main*)  25%`. Source: Issue #163 acceptance criteria; existing CLI reference implementation.
   - Updating indexed `compactPercent` updates the FreshClaude header text to the new percent. Source: Issue #163 acceptance criteria; implementation plan Architecture.
   - Once indexed session metadata is removed, the FreshClaude percent indicator disappears and is not recreated from SDK totals alone. Source: issue conversation directive; implementation plan Strategy Gate and Key Decisions.
   Interactions: App bootstrap, sessions API loading, websocket readiness, sessions slice, agentChat slice, pane header rendering, shared formatter.

2. Name: A restored FreshClaude pane shows the percent-used indicator before `sdk.session.init` arrives.
   Type: scenario.
   Harness: App pane-header parity harness.
   Preconditions: The app boots with a FreshClaude pane that has `resumeSessionId` but no `sessionId`; `/api/sessions*` returns an indexed Claude session whose `sessionId` matches that `resumeSessionId`; no SDK init event has been emitted yet.
   Actions:
   1. Render `<App />` and allow normal settings/platform/sessions bootstrap.
   2. Do not emit `sdk.session.init`.
   3. Observe the FreshClaude pane header immediately after bootstrap settles.
   Expected outcome:
   - The FreshClaude header already shows the percent-used indicator from the indexed session matched by `resumeSessionId`. Source: issue conversation directive; implementation plan Key Decisions.
   - The user does not need to wait for a live SDK init event before seeing the restored token-budget state. Source: implementation plan Architecture; existing FreshClaude identity flow.
   Interactions: sessions API bootstrap, persisted pane content, pane header rendering, FreshClaude restore path.

3. Name: When both identities exist, FreshClaude header resolution prefers `cliSessionId` over `resumeSessionId`.
   Type: integration.
   Harness: PaneContainer FreshClaude unit harness.
   Preconditions: A single FreshClaude pane has both `sessionId` and `resumeSessionId`; `agentChat.sessions[sessionId].cliSessionId` points to indexed session A; `resumeSessionId` points to indexed session B; A and B have different branch/token metadata.
   Actions:
   1. Render `PaneContainer` for the FreshClaude pane.
   2. Read the rendered header label and tooltip.
   Expected outcome:
   - The rendered label and tooltip come from indexed session A, the one matched by `cliSessionId`, not from the stale `resumeSessionId` session B. Source: issue conversation directive; implementation plan Key Decisions.
   - The displayed branch/dirty marker and percent correspond exactly to session A’s indexed metadata. Source: Issue #163 acceptance criteria; implementation plan Architecture.
   Interactions: pane-content identity, agentChat slice, sessions slice, shared formatter.

4. Name: FreshClaude header resolution uses exact indexed-session identity and never falls back to cwd matching or SDK token totals.
   Type: integration.
   Harness: PaneContainer FreshClaude unit harness.
   Preconditions: A FreshClaude pane has no indexed session match by `cliSessionId` or `resumeSessionId`; the store still contains another Claude session with a matching cwd and a large percent; the SDK session contains large accumulated `totalInputTokens` and `totalOutputTokens`.
   Actions:
   1. Render `PaneContainer` for the FreshClaude pane.
   2. Dispatch additional SDK turn results to inflate SDK totals further.
   3. Re-check the header.
   Expected outcome:
   - No percent-used indicator is shown for the FreshClaude pane when there is no exact indexed-session match. Source: issue conversation directive; implementation plan Key Decisions.
   - The unrelated indexed Claude session matched only by cwd is ignored. Source: implementation plan Key Decisions.
   - SDK per-turn totals alone never create a percent-used indicator. Source: issue conversation directive; implementation plan Strategy Gate.
   Interactions: pane header resolution helper, sessions slice, agentChat slice, shared formatter.

5. Name: FreshClaude-shaped runtime metadata formats identically to the existing CLI header contract.
   Type: differential.
   Harness: Shared formatter unit harness.
   Preconditions: One CLI-shaped runtime metadata object and one FreshClaude-shaped runtime metadata object carry the same directory, branch, dirty flag, and token-usage values.
   Actions:
   1. Call `formatPaneRuntimeLabel` with both metadata objects.
   2. Call `formatPaneRuntimeTooltip` with both metadata objects.
   3. Compare the outputs.
   Expected outcome:
   - Label output is byte-for-byte identical for equivalent CLI and FreshClaude metadata. Source: Issue #163 acceptance criteria; existing CLI reference implementation.
   - Tooltip output is byte-for-byte identical for equivalent CLI and FreshClaude metadata. Source: Issue #163 acceptance criteria; existing CLI reference implementation.
   Interactions: shared formatter only.

6. Name: Existing CLI pane headers keep their current label and tooltip behavior after the formatter input is narrowed.
   Type: regression.
   Harness: Shared formatter unit harness.
   Preconditions: Existing codex/claude formatter fixtures used by current pane-header tests remain available.
   Actions:
   1. Run the formatter label and tooltip assertions for existing CLI metadata fixtures.
   2. Verify both label and tooltip outputs.
   Expected outcome:
   - Existing CLI label output remains unchanged, including spacing and omission of percent when compact-threshold usage is unavailable. Source: implementation plan Task 1 Step 3; existing CLI reference implementation.
   - Existing CLI tooltip output remains unchanged, including directory, branch, and token fullness text. Source: implementation plan Task 1 Step 3; existing CLI reference implementation.
   Interactions: shared formatter only.

7. Name: Non-FreshClaude agent-chat panes do not gain the token-budget indicator in this issue.
   Type: regression.
   Harness: PaneContainer FreshClaude unit harness.
   Preconditions: A `kilroy` agent-chat pane has agentChat/session-store data that would otherwise be sufficient to render the same Claude-session token metadata.
   Actions:
   1. Render `PaneContainer` for the `kilroy` pane with matching indexed Claude session metadata present.
   2. Inspect the header area.
   Expected outcome:
   - No token-budget percent indicator is rendered for `kilroy`. Source: implementation plan Key Decisions: “only wire this behavior into FreshClaude panes for this issue.”
   - Existing `kilroy` pane title/status rendering remains otherwise unchanged. Source: implementation plan scope guard.
   Interactions: agent-chat provider config, pane header rendering, sessions slice.

## Coverage summary

- Covered action space:
  - FreshClaude pane header rendering during normal app bootstrap.
  - FreshClaude pane header updates when indexed Claude session metadata changes.
  - FreshClaude pane header clearing when indexed Claude metadata disappears.
  - Restored FreshClaude panes before `sdk.session.init`.
  - Exact session-identity precedence (`cliSessionId` before `resumeSessionId`).
  - Shared formatter parity with the existing CLI contract.
  - Regression protection for unchanged CLI pane-header behavior.
  - Scope protection so this issue only affects FreshClaude, not all agent-chat providers.

- Explicitly excluded by strategy:
  - Server-side token-percentage calculation changes in `server/sdk-bridge.ts` or the Claude session indexer; the implementation plan treats those paths as already providing the needed identity and metadata.
  - Broad token-budget refactors across all agent-chat providers.
  - Performance benchmarking; this change is a low-risk header-resolution path with no agreed performance scope.

- Risk carried by exclusions:
  - If the pre-existing server identity chain (`sdk.session.init` -> `agentChat.cliSessionId` -> `resumeSessionId` persistence -> indexed session metadata) is already broken outside this issue’s seam, these tests will expose the client symptom but not add new server diagnostics.
  - Because scope intentionally excludes non-FreshClaude providers, later rollouts for `kilroy` or other agent-chat panes will need their own parity plan instead of relying on this issue’s coverage.
