# Exact Durable Session Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the real coding-agent session contracts, then cut Freshell over to one durable-session model where live reattach, restore targets, and canonical provider identity are explicit and only truly durable provider state is persisted.

**Architecture:** Start with isolated real-binary probes and a checked-in lab note; the observed provider behavior becomes the contract. Then refactor shared state, websocket payloads, read models, and UI around one persisted canonical `sessionRef`, while keeping fresh ids, named resumes, and other non-durable launch inputs in memory only until canonical promotion. Move Codex to per-terminal app-server sidecars so fresh sessions can be attributed without heuristics, and promote Claude, FreshClaude, and OpenCode into the same durable contract only when the provider has actually produced a replay-safe canonical id.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, WebSocket (`ws`), node-pty, Vitest, Testing Library, opt-in real-binary probe tests for `codex`, `claude`, and `opencode`

---

## Strategy Gate

- Do not write implementation tests from memory or prior assumptions. The checked-in lab note and real-provider probes are the source of truth.
- Do not patch Codex by widening timeouts or layering more retries around `thread/start` / `thread/resume`. PR `#298` broke the contract, not the transport.
- Do not persist provider ids until the provider has actually made them durable.
- Do not keep `resumeSessionId` as a multi-meaning string. Internal runtime state must distinguish `terminalId` / `serverInstanceId`, ephemeral launch input, and canonical durable `sessionRef`.
- Do not reintroduce same-cwd or timing heuristics for Codex or OpenCode.
- Do not kill the user's live agent terminals during process cleanup. Only stop probe-owned or clearly orphaned helper processes that can be proven safe to kill.
- Do not silently fall back from "restore this session" to "start fresh." Missing durable state must surface a clear restore-unavailable error.
- Do not persist named resumes, fresh thread ids, or any other non-durable launch token. The only persisted replay identity is canonical `sessionRef`.

## Verified Planning Inputs

- Provider versions were checked in planning:
  - `codex --version` -> `codex-cli 0.121.0`
  - `claude --version` -> `2.1.114 (Claude Code)`
  - `opencode --version` -> `1.4.11`
- The current code still encodes the bad Codex invariant from PR `#298`:
  - `server/coding-cli/codex-app-server/launch-planner.ts` preallocates `thread/start` for fresh launches.
  - `server/ws-handler.ts` immediately persists the returned thread id as `effectiveResumeSessionId`.
  - `test/integration/server/codex-session-flow.test.ts` asserts fresh create launches `codex --remote ... resume thread-new-1`.
- There are active `codex`, `claude`, and app-server processes outside this implementation worktree. Cleanup has to be provenance-based, not pattern-based, or it risks killing the user's live sessions.
- The previous plan missed real consumers of `resumeSessionId` / `sessionRef`, including:
  - `src/store/panesSlice.ts`
  - `src/store/paneTreeValidation.ts`
  - `src/store/layoutMirrorMiddleware.ts`
  - `src/store/crossTabSync.ts`
  - `src/store/selectors/sidebarSelectors.ts`
  - `src/components/BackgroundSessions.tsx`
  - `src/components/TabBar.tsx`
  - `src/components/TabsView.tsx`
  - `src/components/panes/PaneContainer.tsx`
  - `src/components/context-menu/menu-defs.ts`
  - `server/agent-timeline/ledger.ts`
  - `server/session-scanner/service.ts`
  - `server/terminal-view/types.ts`
  - `server/terminal-view/service.ts`
  - `server/terminals-router.ts`
- OpenCode already has an authoritative localhost control surface in existing code:
  - `server/coding-cli/opencode-activity-tracker.ts` reads `/session/status` and SSE events carrying `sessionID`.
  - The refactor should extend that authoritative surface, not invent a second heuristic source.
- Existing restore and agent-history tests already encode live-only-versus-durable behavior and must be updated as part of the cutover, not rediscovered late:
  - `test/server/ws-terminal-create-session-repair.test.ts`
  - `test/unit/server/agent-timeline-ledger.test.ts`
  - `test/unit/server/ws-handler-sdk.test.ts`
  - `test/integration/server/agent-timeline-router.test.ts`

## External Contract Rule

Task 1 produces a checked-in lab note at `docs/lab-notes/2026-04-20-coding-cli-session-contract.md`. That note is the implementation contract. If any currently expected provider behavior differs from the note, update the tests and the implementation to match the note, not the earlier assumption.

## End-State Contract And Invariants

### 1. Live reattach is not restore

- Live reattach is keyed by:
  - `terminalId`
  - `serverInstanceId`
- Restore after the live process is gone is keyed only by canonical durable `sessionRef`.

### 2. Shared durable-session contract

- Add one shared persisted contract used by server, client, persistence, and websocket payloads:
  - `sessionRef`
- `sessionRef` is the canonical exact durable provider identity and the only persisted replay target:
  - `{ provider, sessionId, serverInstanceId? }`
- For all verified providers, replay commands derive directly from canonical `{ provider, sessionId }`; there is no second persisted replay token.
- Exact-but-not-durable provider ids and named/user-supplied launch inputs are server-memory or pane-memory `exact_pending` / `launchResumeInput` state. They never cross durability boundaries.

### 3. Durable promotion is explicit

- `terminal.created` means only that the PTY exists.
- Fresh creates must not piggyback non-durable provider ids or launch inputs into `terminal.created`.
- Add `terminal.session.durable` as the only server-to-client event that persists a new canonical durable `sessionRef`.
- Named/user-supplied launch inputs upgrade through the same durable event once the provider reveals the canonical durable identity. If that never happens before the live session is lost, restore is unavailable.

### 4. Provider rules

- Codex:
  - Freshell must not call `thread/start` or `thread/resume` to create or restore terminal sessions.
  - Fresh launch is `codex --remote <ws>`.
  - Restore is `codex --remote <ws> resume <durable-token>`.
  - Because fresh `thread/started` notifications are no longer attributable through a shared runtime without heuristics, each Codex terminal owns its own app-server sidecar.
  - A Codex id is not durable until Task 1's documented artifact check says it is.
- Claude terminal sessions:
  - Fresh launches must use the exact provider input proven by Task 1. The current expected path is `--session-id <uuid>`, but the lab note is authoritative.
  - Fresh exact ids remain `exact_pending` until the transcript exists.
  - Named resumes are create-time launch inputs only. Freshell promotes only the canonical UUID to `sessionRef` and never persists the name as a restore target.
- OpenCode:
  - Fresh exact / durable identity can come only from the authoritative localhost control surface proven by Task 1.
  - PTY stdout, cwd matching, and startup escape-sequence parsing are never identity sources.
  - Restore uses only canonical durable `sessionRef`.

### 5. Failure behavior

- If a terminal never became durable and the live process is gone, Freshell shows a clear restore-unavailable error.
- Freshell must not start a fresh session under a stale tab/session identity.

## File Structure

- Create: `shared/session-contract.ts`
  Responsibility: shared canonical `sessionRef` helpers, ephemeral launch-input helpers, legacy normalization, provider-aware validation, and migration utilities.
- Create: `server/coding-cli/session-contract-controller.ts`
  Responsibility: server-memory `exact_pending` / `launchResumeInput` / `durable` lifecycle, durable promotion, and provider-controller registration.
- Create: `server/coding-cli/codex-app-server/sidecar.ts`
  Responsibility: one Codex app-server process per terminal, notification intake, lifecycle, and teardown.
- Create: `server/coding-cli/opencode-session-controller.ts`
  Responsibility: authoritative OpenCode session observation and durable promotion from localhost control events.
- Create: `test/helpers/coding-cli/real-session-contract-harness.ts`
  Responsibility: isolated temp-home real-binary probes and deterministic cleanup.
- Create: `test/integration/real/coding-cli-session-contract.test.ts`
  Responsibility: opt-in real-provider contract coverage matching the lab note.
- Create: `test/unit/shared/session-contract.test.ts`
  Responsibility: shared contract normalization and legacy migration coverage.
- Create: `test/unit/client/lib/session-contract.test.ts`
  Responsibility: client helpers and no-layout fallback behavior under the new contract.
- Create: `test/integration/server/opencode-session-flow.test.ts`
  Responsibility: fresh OpenCode promotion and durable-only restore semantics.
- Create: `docs/lab-notes/2026-04-20-coding-cli-session-contract.md`
  Responsibility: exact commands, versions, outputs, cleanup rules, and the allowed provider assumptions.
- Modify: `package.json`
  Responsibility: add an explicit opt-in real-provider contract script.
- Modify: `shared/ws-protocol.ts`
  Responsibility: introduce canonical durable-session schemas, `terminal.session.durable`, and boundary normalization.
- Modify: `server/index.ts`
  Responsibility: wire the new session-contract controller, Codex sidecars, OpenCode controller, and durable event broadcast.
- Modify: `server/ws-handler.ts`
  Responsibility: stop persisting fresh non-durable ids, normalize legacy input, and return clear restore-unavailable failures.
- Modify: `server/terminal-registry.ts`
  Responsibility: separate spawn inputs, exact-pending state, durable binding, and sidecar / controller lifecycle.
- Modify: `server/session-association-coordinator.ts`
  Responsibility: limit association work to canonical-promotion cases and remove fresh-session ownership assumptions.
- Modify: `server/session-association-updates.ts`
  Responsibility: emit durable-promotion semantics instead of generic association wording.
- Modify: `server/agent-timeline/ledger.ts`
  Responsibility: resolve live-only launch inputs versus canonical durable ids without treating names as persisted restore targets.
- Modify: `server/session-scanner/service.ts`
  Responsibility: validate or reject legacy Claude restore candidates without reviving a persisted alias path.
- Modify: `server/terminal-view/types.ts`
  Responsibility: expose explicit durable identity fields in terminal-directory and read-model types.
- Modify: `server/terminal-view/service.ts`
  Responsibility: populate terminal-directory snapshots from durable contract state.
- Modify: `server/terminals-router.ts`
  Responsibility: serve terminal-directory payloads that preserve durable identity semantics.
- Modify: `server/terminal-metadata-service.ts`
  Responsibility: key metadata by canonical durable session identity.
- Modify: `server/agent-api/router.ts`
  Responsibility: normalize incoming and outgoing terminal pane contract data.
- Modify: `server/mcp/freshell-tool.ts`
  Responsibility: expose the new terminal and session contract to MCP callers.
- Modify: `src/store/paneTypes.ts`
  Responsibility: replace ambiguous pane identity fields with canonical durable `sessionRef` and non-persisted launch-input state where needed.
- Modify: `src/store/types.ts`
  Responsibility: replace tab-level `resumeSessionId` fallback semantics with explicit durable fields.
- Modify: `src/store/panesSlice.ts`
  Responsibility: construct pane content from the new contract and preserve only canonical durable identity on merges.
- Modify: `src/store/paneTreeValidation.ts`
  Responsibility: validate persisted pane trees under the new shape.
- Modify: `src/store/persistedState.ts`
  Responsibility: one-time migration from legacy `resumeSessionId` strings.
- Modify: `src/store/persistMiddleware.ts`
  Responsibility: persist only the new contract shape.
- Modify: `src/store/persistControl.ts`
  Responsibility: durable-only flush logic and canonical-vs-live-only handling.
- Modify: `src/store/layoutMirrorMiddleware.ts`
  Responsibility: sync layout snapshots using canonical durable `sessionRef` only.
- Modify: `src/store/crossTabSync.ts`
  Responsibility: preserve canonical durable state during broadcast hydration.
- Modify: `src/store/tabsSlice.ts`
  Responsibility: tab hydration, merge, and fallback identity under the new contract.
- Modify: `src/store/selectors/sidebarSelectors.ts`
  Responsibility: sidebar open-session matching and running-terminal matching using canonical durable identity.
- Modify: `src/lib/session-utils.ts`
  Responsibility: exact-session lookup from canonical `sessionRef` with legacy-boundary handling only where migration still requires it.
- Modify: `src/lib/tab-registry-snapshot.ts`
  Responsibility: stop synthesizing canonical session identity from arbitrary strings after migration.
- Modify: `src/lib/ui-commands.ts`
  Responsibility: carry canonical `sessionRef` and non-persisted launch inputs through UI command payloads.
- Modify: `src/lib/session-metadata.ts`
  Responsibility: key metadata off canonical durable identity.
- Modify: `src/lib/session-type-utils.ts`
  Responsibility: build resume content from the new contract shape.
- Modify: `src/lib/pane-activity.ts`
  Responsibility: activity matching against canonical durable identity.
- Modify: `src/components/TerminalView.tsx`
  Responsibility: create terminals with the new contract, persist only on `terminal.session.durable`, and surface restore-unavailable errors.
- Modify: `src/components/BackgroundSessions.tsx`
  Responsibility: reattach live terminals without smuggling stale resume ids into new tabs.
- Modify: `src/components/Sidebar.tsx`
  Responsibility: render session and open-state from canonical `sessionRef` while ignoring live-only launch inputs.
- Modify: `src/components/TabBar.tsx`
  Responsibility: fallback pane-content synthesis under the new contract.
- Modify: `src/components/TabsView.tsx`
  Responsibility: server-snapshot hydration and same-server fallback under the new contract.
- Modify: `src/components/TabContent.tsx`
  Responsibility: tab resume and restore affordances using explicit durable identity.
- Modify: `src/components/panes/PaneContainer.tsx`
  Responsibility: pane-local running-session resolution and durable-identity preference.
- Modify: `src/components/terminal-view-utils.ts`
  Responsibility: remove raw `resumeSessionId` helpers.
- Modify: `src/components/context-menu/menu-defs.ts`
  Responsibility: session-oriented menu actions using the new contract.
- Modify: `src/store/agentChatTypes.ts`
  Responsibility: align shared identity naming where agent-chat panes persist Claude durable state.
- Modify: `src/store/agentChatSlice.ts`
  Responsibility: preserve canonical durable Claude identity in agent-chat state.
- Modify: `src/components/agent-chat/AgentChatView.tsx`
  Responsibility: canonical promotion and restore flows using the new contract.
- Modify: `server/coding-cli/codex-app-server/client.ts`
  Responsibility: consume app-server notifications needed for sidecar-owned Codex sessions.
- Modify: `server/coding-cli/codex-app-server/protocol.ts`
  Responsibility: model initialize and notification payloads used by the sidecar flow.
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
  Responsibility: runtime cleanup and sidecar-friendly startup behavior.
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts`
  Responsibility: stop fresh-thread preallocation and return sidecar launch inputs only.
- Modify: `server/coding-cli/opencode-activity-tracker.ts`
  Responsibility: share authoritative session data with the new OpenCode session controller.
- Modify: `server/coding-cli/opencode-activity-wiring.ts`
  Responsibility: wire OpenCode activity and durable promotion together.
- Modify: `server/coding-cli/codex-activity-wiring.ts`
  Responsibility: bind Codex activity to the new durable-promotion semantics instead of immediate fresh-thread binding.
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`
  Responsibility: support sidecar-owned notification and durability-promotion fixtures.
- Modify: `docs/index.html` only if user-visible restore wording changes enough to require the mock to match.

## Task 1: Lock Down Real Provider Contracts Before Refactoring

**Files:**
- Create: `test/helpers/coding-cli/real-session-contract-harness.ts`
- Create: `test/integration/real/coding-cli-session-contract.test.ts`
- Create: `docs/lab-notes/2026-04-20-coding-cli-session-contract.md`
- Modify: `package.json`

- [ ] **Step 1: Build the real-provider probe harness**

Add isolated temp-home helpers for `codex`, `claude`, and `opencode` that can:
- launch providers with unique temp directories
- capture stdout, stderr, session artifacts, and control-surface responses
- register every child PID they start
- clean up probe-owned processes deterministically

- [ ] **Step 2: Audit running provider processes and stop only safe probe-owned or orphaned helpers**

Run a provenance-based audit such as:
- `ps -eo pid,ppid,stat,cmd --sort=pid | rg "codex|claude|opencode"`
- `ps -fp <pid>`

Only kill processes that are clearly tied to isolated probe temp homes or the implementation worktree. Do not kill live user sessions served from main. Record the cleanup rule and any untouched live sessions in the lab note.

- [ ] **Step 3: Run the real probes and capture actual behavior**

Use the harness to capture:
- Codex fresh remote start notification timing, thread-id timing, and durability timing
- Claude fresh exact-id timing, transcript durability timing, and live-only named-resume behavior
- OpenCode authoritative control-surface timing for exact and durable ids

Save exact commands, versions, and relevant outputs.

- [ ] **Step 4: Write the checked-in lab note**

Document:
- provider versions
- exact commands
- exact observed artifacts and endpoints
- which earlier assumptions were false
- the cleanup rules for probe-owned processes
- the exact assumptions Freshell is allowed to build on

- [ ] **Step 5: Encode the lab note as opt-in real-provider tests**

Add `test/integration/real/coding-cli-session-contract.test.ts` so every claim in the lab note becomes executable.

- [ ] **Step 6: Run the opt-in provider contract suite**

Run: `cross-env FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/coding-cli-session-contract.test.ts`

Expected: PASS. If the test and the lab note disagree, fix the test or the note before touching product code.

- [ ] **Step 7: Commit**

```bash
git add package.json test/helpers/coding-cli/real-session-contract-harness.ts test/integration/real/coding-cli-session-contract.test.ts docs/lab-notes/2026-04-20-coding-cli-session-contract.md
git commit -m "test: lock coding cli provider contracts"
```

## Task 2: Introduce The Explicit Session Contract And Migrate Stored State

**Files:**
- Create: `shared/session-contract.ts`
- Create: `test/unit/shared/session-contract.test.ts`
- Create: `test/unit/client/lib/session-contract.test.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/paneTreeValidation.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/layoutMirrorMiddleware.ts`
- Modify: `src/store/crossTabSync.ts`
- Modify: `src/lib/ui-commands.ts`
- Modify: `src/lib/session-type-utils.ts`

- [ ] **Step 1: Write the failing contract and migration tests**

Cover:
- legacy `resumeSessionId` string hydration into canonical `sessionRef` or explicit restore-unavailable state
- pane and tab construction under the new shape
- pane-tree validation
- layout-mirror and cross-tab sync payloads
- websocket boundary normalization

- [ ] **Step 2: Run the targeted suite and verify it fails**

Run: `npm run test:vitest -- test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/tabsSlice.merge.test.ts test/unit/client/layout-mirror-middleware.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/server/agent-layout-schema.test.ts test/server/ws-protocol.test.ts`

Expected: FAIL because the shared contract and migration logic do not exist yet.

- [ ] **Step 3: Implement the shared contract and boundary normalization**

Add canonical `sessionRef`, non-persisted launch-input state, migrate persisted state once, and remove new internal reliance on raw legacy `resumeSessionId` strings.

- [ ] **Step 4: Re-run the targeted suite and verify it passes**

Run: `npm run test:vitest -- test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/tabsSlice.merge.test.ts test/unit/client/layout-mirror-middleware.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/server/agent-layout-schema.test.ts test/server/ws-protocol.test.ts`

Expected: PASS.

- [ ] **Step 5: Refactor helpers and run adjacent construction tests**

Run: `npm run test:vitest -- test/unit/client/components/TabsView.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/lib/session-type-utils.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/session-contract.ts shared/ws-protocol.ts src/store/paneTypes.ts src/store/types.ts src/store/panesSlice.ts src/store/paneTreeValidation.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/layoutMirrorMiddleware.ts src/store/crossTabSync.ts src/lib/ui-commands.ts src/lib/session-type-utils.ts test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts
git commit -m "refactor: add explicit durable session contract"
```

## Task 3: Make Durable Promotion The Only Persistence Path

**Files:**
- Create: `server/coding-cli/session-contract-controller.ts`
- Modify: `server/index.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/session-association-updates.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/persistControl.ts`
- Modify: `src/lib/session-utils.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/terminal-view-utils.ts`

- [ ] **Step 1: Write the failing durable-promotion tests**

Cover:
- fresh create does not persist non-durable ids
- `terminal.session.durable` is the only event that persists durable identity
- non-durable lost terminals surface restore-unavailable
- exact session lookup uses `sessionRef`, not fallback strings

- [ ] **Step 2: Run the targeted suite and verify it fails**

Run: `npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/unit/server/terminal-registry.findRunningTerminal.test.ts test/server/ws-protocol.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/lib/session-utils.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/e2e/codex-refresh-rehydrate-flow.test.tsx`

Expected: FAIL because the current code still persists immediate resume ids and has no durable-promotion event.

- [ ] **Step 3: Implement the durable-promotion control plane**

Add server-memory `exact_pending` / `launchResumeInput` state, emit `terminal.session.durable`, and make client persistence update only on durable promotion or on restores that already had canonical durable `sessionRef`.

- [ ] **Step 4: Re-run the targeted suite and verify it passes**

Run: `npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/unit/server/terminal-registry.findRunningTerminal.test.ts test/server/ws-protocol.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/lib/session-utils.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/e2e/codex-refresh-rehydrate-flow.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor and run adjacent persistence checks**

Run: `npm run test:vitest -- test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsSlice.merge.test.ts test/unit/client/store/persistControl.test.ts test/unit/client/components/TerminalView.lastInputAt.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/session-contract-controller.ts server/index.ts server/ws-handler.ts server/terminal-registry.ts server/session-association-updates.ts src/store/tabsSlice.ts src/store/persistControl.ts src/lib/session-utils.ts src/lib/tab-registry-snapshot.ts src/components/TerminalView.tsx src/components/terminal-view-utils.ts test/unit/server/terminal-registry.test.ts test/unit/server/terminal-registry.findRunningTerminal.test.ts test/server/ws-protocol.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/lib/session-utils.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/e2e/codex-refresh-rehydrate-flow.test.tsx
git commit -m "refactor: persist only durable session identity"
```

## Task 4: Replace Codex Preallocation With Terminal-Owned Sidecars

**Files:**
- Create: `server/coding-cli/codex-app-server/sidecar.ts`
- Modify: `server/coding-cli/codex-app-server/client.ts`
- Modify: `server/coding-cli/codex-app-server/protocol.ts`
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts`
- Modify: `server/coding-cli/codex-activity-wiring.ts`
- Modify: `server/index.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`

- [ ] **Step 1: Rewrite the Codex tests to the Task 1 contract**

Change expectations so that:
- fresh Codex create launches `codex --remote <ws>` with no preallocated `resume`
- Freshell does not call `thread/start` or `thread/resume`
- the sidecar learns exact thread identity from app-server notifications
- durable promotion happens later, not in `terminal.created`

- [ ] **Step 2: Run the Codex-focused suite and verify it fails**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/codex-session-rebind-regression.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts`

Expected: FAIL because the current implementation still preallocates fresh threads and persists them immediately.

- [ ] **Step 3: Implement the sidecar class and notification parsing**

Add one Codex app-server sidecar per terminal, model the required notifications in the protocol layer, wire Codex activity through durable promotion instead of preallocated binding, and ensure startup and shutdown do not leak child processes.

- [ ] **Step 4: Wire fresh and restore launch flow through the sidecar**

Implement:
- fresh spawn with `codex --remote <ws>`
- restore spawn with `codex --remote <ws> resume <durable-token>`
- durable promotion only after the provider's documented durable artifact exists
- sidecar teardown on terminal exit and other terminal-registry cleanup paths

- [ ] **Step 5: Re-run the Codex-focused suite and the broader Codex regressions**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/codex-session-rebind-regression.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/codex-activity-exact-subset.test.ts test/unit/server/terminal-lifecycle.test.ts test/e2e/codex-activity-indicator-flow.test.tsx test/e2e/codex-refresh-rehydrate-flow.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-app-server/sidecar.ts server/coding-cli/codex-app-server/client.ts server/coding-cli/codex-app-server/protocol.ts server/coding-cli/codex-app-server/runtime.ts server/coding-cli/codex-app-server/launch-planner.ts server/coding-cli/codex-activity-wiring.ts server/index.ts server/ws-handler.ts server/terminal-registry.ts test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/codex-session-rebind-regression.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
git commit -m "refactor: move codex terminals to sidecar-owned sessions"
```

## Task 5: Canonicalize Claude And FreshClaude Before Persistence

**Files:**
- Modify: `server/session-association-coordinator.ts`
- Modify: `server/session-association-updates.ts`
- Modify: `server/agent-timeline/ledger.ts`
- Modify: `server/session-scanner/service.ts`
- Modify: `server/index.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`
- Modify: `test/unit/server/agent-timeline-ledger.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `test/integration/server/agent-timeline-router.test.ts`

- [ ] **Step 1: Rewrite the Claude and FreshClaude tests to the Task 1 contract**

Cover:
- fresh terminal Claude launches use the exact fresh-session input documented in Task 1
- fresh creates no longer rely on same-cwd association to become exact
- explicit named resumes stay live-only launch inputs and never become persisted restore targets
- canonical durable identity wins for restore and matching
- agent-timeline, sdk attach/create, and session-repair paths stop treating a name as a durable id once canonical history exists or when no canonical durable id can be proven

- [ ] **Step 2: Run the targeted Claude suite and verify it fails**

Run: `npm run test:vitest -- test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-session-repair.test.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/ws-handler-sdk.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx test/e2e/agent-chat-restore-flow.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx`

Expected: FAIL because the current flow still relies on generic association, persisted raw resume strings, and live-only named inputs being treated as replayable ids.

- [ ] **Step 3: Implement exact fresh-session tracking and canonical promotion**

Implement:
- fresh terminal launches using the provider input proven in Task 1
- server-memory `exact_pending` / `launchResumeInput` tracking for fresh Claude and FreshClaude sessions
- canonical durable upgrades that rewrite pane and tab state to `sessionRef`
- restore-unavailable outcomes when only a live-only name remains and no canonical durable UUID can be proven

- [ ] **Step 4: Re-run the targeted Claude suite and verify it passes**

Run: `npm run test:vitest -- test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-session-repair.test.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/ws-handler-sdk.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx test/e2e/agent-chat-restore-flow.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor and run adjacent Claude restore tests**

Run: `npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/session-association-coordinator.ts server/session-association-updates.ts server/agent-timeline/ledger.ts server/session-scanner/service.ts server/index.ts server/terminal-registry.ts server/ws-handler.ts src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/components/agent-chat/AgentChatView.tsx src/components/TerminalView.tsx test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-session-repair.test.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/ws-handler-sdk.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx test/e2e/agent-chat-restore-flow.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx
git commit -m "refactor: persist only canonical claude session ids"
```

## Task 6: Promote OpenCode Only From Authoritative Control Data

**Files:**
- Create: `server/coding-cli/opencode-session-controller.ts`
- Create: `test/integration/server/opencode-session-flow.test.ts`
- Modify: `server/coding-cli/opencode-activity-tracker.ts`
- Modify: `server/coding-cli/opencode-activity-wiring.ts`
- Modify: `server/index.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`

- [ ] **Step 1: Write the failing OpenCode durability tests**

Cover:
- fresh interactive startup does not persist canonical durable identity before the provider actually creates one
- authoritative control events or surfaces promote the pane to a durable exact id
- restore uses only canonical durable `sessionRef`

- [ ] **Step 2: Run the targeted OpenCode suite and verify it fails**

Run: `npm run test:vitest -- test/integration/server/opencode-session-flow.test.ts test/server/ws-opencode-activity.test.ts test/unit/client/lib/pane-activity.test.ts test/e2e/pane-activity-indicator-flow.test.tsx`

Expected: FAIL because OpenCode durable promotion is not currently modeled explicitly.

- [ ] **Step 3: Implement the OpenCode session controller**

Extend the authoritative localhost control surface so the controller can observe exact session creation, durable promotion, and cleanup without relying on PTY output.

- [ ] **Step 4: Re-run the targeted OpenCode suite and verify it passes**

Run: `npm run test:vitest -- test/integration/server/opencode-session-flow.test.ts test/server/ws-opencode-activity.test.ts test/unit/client/lib/pane-activity.test.ts test/e2e/pane-activity-indicator-flow.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor and run adjacent OpenCode checks**

Run: `npm run test:vitest -- test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/title-sync-flow.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/opencode-session-controller.ts server/coding-cli/opencode-activity-tracker.ts server/coding-cli/opencode-activity-wiring.ts server/index.ts server/terminal-registry.ts server/ws-handler.ts test/integration/server/opencode-session-flow.test.ts test/server/ws-opencode-activity.test.ts test/e2e/pane-activity-indicator-flow.test.tsx
git commit -m "refactor: promote opencode sessions from authoritative control data"
```

## Task 7: Cut Over Read Models, Sidebar, Background Sessions, And Command Surfaces

**Files:**
- Modify: `server/terminal-view/types.ts`
- Modify: `server/terminal-view/service.ts`
- Modify: `server/terminals-router.ts`
- Modify: `server/terminal-metadata-service.ts`
- Modify: `server/agent-api/router.ts`
- Modify: `server/mcp/freshell-tool.ts`
- Modify: `src/store/selectors/sidebarSelectors.ts`
- Modify: `src/lib/session-metadata.ts`
- Modify: `src/lib/pane-activity.ts`
- Modify: `src/components/BackgroundSessions.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/components/TabContent.tsx`
- Modify: `src/components/panes/PaneContainer.tsx`
- Modify: `src/components/context-menu/menu-defs.ts`

- [ ] **Step 1: Write or extend the failing consumer regression tests**

Cover:
- terminal-directory and background-session payloads preserve durable identity correctly
- sidebar open-session matching uses canonical `sessionRef`
- running-terminal and busy-state matching do not regress when live-only launch input differs from durable identity
- pane header and sidebar search flows stop depending on raw `resumeSessionId`
- context-menu and MCP / agent surfaces send the new contract

- [ ] **Step 2: Run the targeted consumer suite and verify it fails**

Run: `npm run test:vitest -- test/server/terminals-api.test.ts test/integration/server/terminal-view-router.test.ts test/unit/server/terminal-metadata-service.test.ts test/unit/server/mcp/freshell-tool.test.ts test/server/agent-panes-write.test.ts test/server/agent-run.test.ts test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/TabContent.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/terminal-view-utils.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/sidebar-search-flow.test.tsx`

Expected: FAIL until all consumers stop using the old string semantics.

- [ ] **Step 3: Implement the remaining consumer cutover**

Finish the read-model, terminal-directory, sidebar, pane-container, background-session, context-menu, agent, and MCP consumers so the repo consistently uses:
- `terminalId` for live reattach
- canonical `sessionRef` for recreate and exact durable identity

- [ ] **Step 4: Re-run the targeted consumer suite and verify it passes**

Run: `npm run test:vitest -- test/server/terminals-api.test.ts test/integration/server/terminal-view-router.test.ts test/unit/server/terminal-metadata-service.test.ts test/unit/server/mcp/freshell-tool.test.ts test/server/agent-panes-write.test.ts test/server/agent-run.test.ts test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/TabContent.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/terminal-view-utils.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/sidebar-search-flow.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run the UI and read-model regressions**

Run: `npm run test:vitest -- test/server/ws-sidebar-snapshot-refresh.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/tabs-view-flow.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/sidebar-refresh-dom-stability.test.tsx test/e2e/sidebar-search-flow.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/terminal-view/types.ts server/terminal-view/service.ts server/terminals-router.ts server/terminal-metadata-service.ts server/agent-api/router.ts server/mcp/freshell-tool.ts src/store/selectors/sidebarSelectors.ts src/lib/session-metadata.ts src/lib/pane-activity.ts src/components/BackgroundSessions.tsx src/components/Sidebar.tsx src/components/TabBar.tsx src/components/TabsView.tsx src/components/TabContent.tsx src/components/panes/PaneContainer.tsx src/components/context-menu/menu-defs.ts test/server/terminals-api.test.ts test/integration/server/terminal-view-router.test.ts test/unit/server/terminal-metadata-service.test.ts test/unit/server/mcp/freshell-tool.test.ts test/server/agent-panes-write.test.ts test/server/agent-run.test.ts test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/TabContent.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/terminal-view-utils.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts
git commit -m "refactor: cut consumers over to durable session contracts"
```

## Task 8: Run Final Verification And Update Docs Only If Needed

**Files:**
- Modify: `docs/index.html` only if user-visible restore wording changed enough to require the mock to match

- [ ] **Step 1: Update `docs/index.html` if the user-visible restore contract changed**

Only touch the mock if the implemented wording or status affordances are visibly different in the default experience.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Re-run the real-provider contract suite**

Run: `cross-env FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/coding-cli-session-contract.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the focused cross-cutting regression sweep**

Run: `npm run test:vitest -- test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/opencode-session-flow.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-session-repair.test.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/ws-handler-sdk.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-opencode-activity.test.ts test/server/terminals-api.test.ts test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/codex-refresh-rehydrate-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx`

Expected: PASS.

- [ ] **Step 6: Run the coordinated full suite**

Run: `FRESHELL_TEST_SUMMARY="exact durable session contract" npm test`

Expected: PASS. If any valid check fails, keep improving the implementation and tests. Do not stop on partial green.

- [ ] **Step 7: Commit any final doc or cleanup changes from this task**

If Step 1 changed `docs/index.html` or verification exposed a final cleanup edit, commit it:

```bash
git add docs/index.html
git commit -m "docs: align restore contract mock"
```

If this task produced no file changes, skip the commit instead of creating an empty commit.

## Completion Checklist

- The checked-in lab note matches the opt-in real-provider test suite.
- Probe-owned helper processes are cleaned up deterministically, and live user sessions were not killed during the work.
- Canonical `sessionRef` is the only persisted replay identity.
- Live-only launch inputs are never persisted and never masquerade as replay-safe restore targets.
- Fresh Codex sessions are started only by the Codex CLI itself over a terminal-owned app-server sidecar.
- Freshell never persists a fresh Codex notification id until the provider proves durability.
- Claude exact fresh-session behavior follows the Task 1 lab note and does not rely on same-cwd association.
- Named Claude/FreshClaude resumes are launch-only inputs and canonicalize to UUIDs before persistence.
- OpenCode durable promotion comes only from authoritative control data.
- Non-durable terminals fail clearly when the live terminal is gone and no recreate target exists.
- Read models, sidebar state, background sessions, agent routes, and MCP consumers all use the new contract consistently.
- Lint, typecheck, the focused regression sweep, the opt-in provider contract suite, and coordinated full `npm test` all pass.
