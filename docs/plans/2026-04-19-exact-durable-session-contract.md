# Exact Durable Session Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the real provider contracts, then cut Freshell over to one explicit durable-session model where live reattach, durable restore, and launch-only inputs are separate states and only truly replay-safe provider identity is persisted.

**Architecture:** Persist two explicit state axes and nothing hybrid: a canonical durable restore target, `sessionRef = { provider, sessionId }`, and the existing live reattach handles already needed for same-server refresh recovery (`terminalId` for terminal panes, SDK `sessionId` for agent-chat panes). Reuse the existing terminal binding path instead of creating a second promotion event: `terminal.session.associated` becomes the single authoritative terminal durable-promotion event, while agent-chat keeps its existing live SDK `sessionId` separate from canonical durable Claude identity. Codex moves to one app-server sidecar per terminal, OpenCode promotes only from its authoritative control surface, and Claude/FreshClaude promote only when canonical UUID-backed history exists.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, WebSocket (`ws`), node-pty, Vitest, Testing Library, opt-in real-binary probe tests for `codex`, `claude`, and `opencode`

---

## Strategy Gate

- Do not implement from memory. Task 1's checked-in lab note and executable real-provider tests are the contract.
- Do not widen timeouts, add retries, or add “best effort” fallback resume behavior. The problem is identity semantics, not transport resilience.
- Do not create a second durable-promotion control plane if the existing one can be made authoritative. Reuse `SessionBindingAuthority`, existing registry binding APIs, and `terminal.session.associated` for terminal durable promotion.
- Do not persist names, titles, `/rename` results, fresh thread ids, or other launch-only tokens. Persist only canonical durable `sessionRef`.
- Do not encode `serverInstanceId` into canonical durable identity. It is locality/runtime state, not replay-safe identity.
- Do not flatten FreshClaude’s live SDK `sessionId` together with its durable Claude identity. Those are different state axes and must stay different.
- Do not remove persisted live handles that power same-server refresh recovery. Keep them explicit and separate from durable restore identity.
- Do not “solve” the migration by bumping `src/store/storage-migration.ts` to clear local state. Preserve persisted tabs/panes whenever canonical durable identity can still be proven; only surface restore-unavailable for entries that cannot be repaired safely.
- Do not infer identity from cwd matching, PTY stdout, timing, or title text for Codex or OpenCode.
- Do not silently fall back from “restore this session” to “start fresh.” If no durable target exists, surface restore-unavailable clearly.
- Do not kill live user terminals during probe cleanup. Only stop probe-owned or provably orphaned helper processes tied to temp homes or this worktree.

## Verified Planning Inputs

- Real-binary probes already confirmed:
  - `codex --version` -> `codex-cli 0.121.0`
  - `claude --version` -> `2.1.114 (Claude Code)`
  - `opencode --version` -> `1.4.11`
- The shipped regression from PR `#298` is still encoded in main:
  - `server/coding-cli/codex-app-server/launch-planner.ts` calls `thread/start` for fresh create and returns the fresh thread id as if it were replay-safe.
  - `server/ws-handler.ts` immediately persists that id as `effectiveResumeSessionId`.
  - `test/integration/server/codex-session-flow.test.ts` currently bakes that bad invariant into the expected CLI launch.
- Current Freshell behavior already separates some concerns, but not cleanly enough:
  - terminals have a live handle (`terminalId`)
  - terminal panes/tabs still persist ambiguous `resumeSessionId`
  - panes may also persist `sessionRef`
  - agent-chat keeps a live SDK `sessionId` plus durable-ish `cliSessionId` / `timelineSessionId`
- Existing authoritative sources should be reused, not replaced:
  - `server/session-binding-authority.ts` already enforces one session owner per terminal.
  - `server/session-association-coordinator.ts` and `server/session-association-updates.ts` already own Claude-style durable promotion.
  - `server/coding-cli/opencode-activity-tracker.ts` already consumes authoritative OpenCode control events and session IDs.
- FreshClaude cannot be flattened into the terminal model:
  - `src/store/agentChatTypes.ts` separates live SDK `sessionId` from `cliSessionId` / `timelineSessionId`.
  - `src/components/agent-chat/AgentChatView.tsx` already relies on that split during restore hydration.
- The user explicitly called out `/rename`-style cases. The contract work must prove that mutable names/titles are metadata only and never durable identity.

## External Contract Rule

Task 1 writes `docs/lab-notes/2026-04-20-coding-cli-session-contract.md`. That note is authoritative for provider behavior. If any current assumption disagrees with the note, update the tests and product code to match the note.

## End-State Contract And Invariants

### 1. Persisted durable identity

- For terminal panes/tabs, persist exactly one canonical durable identity:
  - `sessionRef = { provider, sessionId }`
- `sessionRef` is the only replay-safe identity written to persisted terminal pane/tab state.
- Persisted terminal and agent-chat pane state also keeps its existing live reattach handles (`terminalId` for terminals, SDK `sessionId` for agent-chat), but those fields remain live-only and must never be interpreted as durable restore targets.
- Agent-chat keeps its own canonical durable Claude fields; do not force it onto terminal `sessionRef` semantics just to share a type name.
- Raw `resumeSessionId` strings do not survive persistence after migration.

### 2. Live handles are separate from durable identity

- Terminal live reattach is keyed by:
  - `terminalId`
  - `serverInstanceId`
- Agent-chat live reattach is keyed by:
  - SDK `sessionId`
- `serverInstanceId` stays in connection/runtime matching state; it is never part of canonical `sessionRef`.
- Live handles are not replay targets and are never used as durable restore keys.

### 3. Launch-only inputs are explicit

- User-supplied or provider-supplied pre-durable inputs stay ephemeral only:
  - fresh Claude create UUID before transcript exists
  - named Claude resume values
  - fresh Codex thread ids before the durable rollout artifact exists
  - OpenCode startup state before authoritative session creation
- These inputs may exist in memory to finish the current live session, but they are never persisted as restore targets.

### 4. One authoritative promotion path

- For terminal panes, durable promotion reuses the existing terminal binding path:
  - `SessionBindingAuthority`
  - registry session binding
  - `terminal.session.associated`
- `terminal.session.associated` becomes the single authoritative terminal event for “this terminal now has canonical durable identity.”
- Do not add a second terminal durable-promotion event.

### 5. Provider-specific durable promotion sources

- Codex:
  - fresh create launches `codex --remote <ws>`
  - restore launches `codex --remote <ws> resume <durable-token>`
  - one app-server sidecar per terminal observes notifications and the provider-owned durable artifact
  - a fresh Codex pane may remain live-only with no thread id at all until the provider actually creates one
  - if an exact thread id appears before the durable artifact exists, it is still launch-only state and must never be persisted
- Claude terminal sessions:
  - fresh create uses the exact Task 1 input contract
  - canonical durable identity is the UUID-backed transcript identity
  - names and `/rename`-style titles are metadata only
- FreshClaude agent-chat:
  - keep live SDK `sessionId` separate
  - promote only the canonical durable Claude identity used by timeline/history
  - restore never depends on a mutable display name
- OpenCode:
  - durable promotion comes only from its authoritative localhost control surface and session events
  - PTY stdout and title text are never identity sources

### 6. Failure semantics

- If a live session never became durable and the live process is gone, restore fails with a clear restore-unavailable error.
- If the Codex sidecar dies or becomes invalid while its PTY is still up, terminate the terminal with a clear error; do not pretend the session is still safely restorable.
- Same-server reconnect prefers the live handle even when `sessionRef` already exists.
- Stale runtime `serverInstanceId` or dead live handle forces durable restore if `sessionRef` exists, otherwise restore-unavailable.

### 7. Mutable metadata is never identity

- Titles, named resumes, and `/rename`-style commands may change the display name.
- Those changes must not change canonical durable identity, matching, or restore behavior.

## File Structure

- Create: `docs/lab-notes/2026-04-20-coding-cli-session-contract.md`
  Responsibility: checked-in provider contract note with exact commands, versions, artifacts, fresh-create timing, rename/title findings, and cleanup rules.
- Create: `test/helpers/coding-cli/real-session-contract-harness.ts`
  Responsibility: isolated temp-home probes, artifact polling, control-surface capture, and deterministic cleanup for real-binary contract tests.
- Create: `test/integration/real/coding-cli-session-contract.test.ts`
  Responsibility: executable verification of every provider claim in the lab note.
- Create: `shared/session-contract.ts`
  Responsibility: canonical `sessionRef` helpers, separate live-handle helpers, launch-input helpers, migration helpers, and provider-aware validation.
- Create: `server/coding-cli/codex-app-server/sidecar.ts`
  Responsibility: per-terminal Codex app-server ownership, notification capture, durable-artifact polling, and cleanup.
- Create: `server/coding-cli/opencode-session-controller.ts`
  Responsibility: translate authoritative OpenCode control data into durable promotion updates.
- Create: `test/integration/server/opencode-session-flow.test.ts`
  Responsibility: OpenCode durable-promotion and restore contract coverage.
- Modify: `shared/ws-protocol.ts`
  Responsibility: make durable identity and live-handle semantics explicit on the wire and tighten `terminal.session.associated` semantics.
- Modify: `server/session-binding-authority.ts`
  Responsibility: keep a single durable owner per session and surface clearer binding state where needed.
- Modify: `server/session-association-coordinator.ts`
  Responsibility: limit heuristic association to provider-approved canonical promotion cases only.
- Modify: `server/session-association-updates.ts`
  Responsibility: collect only canonical durable promotions and stop treating association as a generic heuristic side effect.
- Modify: `server/index.ts`
  Responsibility: wire provider-specific durable promotion sources into the single terminal binding flow and broadcast authoritative updates.
- Modify: `server/ws-handler.ts`
  Responsibility: stop persisting fresh non-durable ids, prefer live reattach over durable restore, and surface restore-unavailable failures.
- Modify: `server/terminal-registry.ts`
  Responsibility: keep live handles, launch inputs, and canonical durable identity separate; own sidecar/controller lifecycle.
- Modify: `server/coding-cli/codex-app-server/client.ts`
  Responsibility: support the sidecar notification flow the terminal owns.
- Modify: `server/coding-cli/codex-app-server/protocol.ts`
  Responsibility: model the initialize/notification payloads needed by the sidecar.
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
  Responsibility: sidecar-friendly lifecycle and cleanup.
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts`
  Responsibility: stop preallocating fresh threads as restore ids.
- Modify: `server/coding-cli/opencode-activity-tracker.ts`
  Responsibility: expose authoritative OpenCode session creation/update data needed for durable promotion.
- Modify: `server/coding-cli/opencode-activity-wiring.ts`
  Responsibility: feed the OpenCode session controller from the authoritative tracker instead of parallel heuristics.
- Modify: `server/session-scanner/service.ts`
  Responsibility: reject non-canonical persisted Claude restore candidates during migration/read.
- Modify: `server/agent-timeline/ledger.ts`
  Responsibility: preserve canonical durable Claude identity without collapsing it into live SDK state.
- Modify: `server/terminal-view/types.ts`
  Responsibility: expose explicit live-vs-durable identity in read models.
- Modify: `server/terminal-view/service.ts`
  Responsibility: derive read models from the explicit contract.
- Modify: `server/terminals-router.ts`
  Responsibility: return terminal directory payloads with explicit durable semantics.
- Modify: `server/terminal-metadata-service.ts`
  Responsibility: key metadata off canonical durable identity, not mutable names.
- Modify: `server/agent-api/router.ts`
  Responsibility: normalize pane snapshots against the new contract.
- Modify: `server/mcp/freshell-tool.ts`
  Responsibility: expose the explicit session contract to MCP callers.
- Modify: `src/store/paneTypes.ts`
  Responsibility: persist canonical `sessionRef`, preserve existing live-handle fields separately, keep live-only launch inputs ephemeral, and preserve agent-chat’s separate live session fields.
- Modify: `src/store/types.ts`
  Responsibility: remove ambiguous tab-level `resumeSessionId` persistence.
- Modify: `src/store/panesSlice.ts`
  Responsibility: build pane state from separate live-handle and durable-restore fields and preserve live-only launch inputs only in-memory where needed.
- Modify: `src/store/paneTreeValidation.ts`
  Responsibility: validate the migrated persisted shape.
- Modify: `src/store/persistedState.ts`
  Responsibility: migrate legacy `resumeSessionId` snapshots into canonical `sessionRef` or explicit restore-unavailable state while preserving existing live-handle fields needed for same-server reconnect.
- Modify: `src/store/storage-migration.ts`
  Responsibility: explicitly preserve existing local state through targeted migration and prevent a schema-bump wipe from becoming the implementation shortcut.
- Modify: `src/store/persistMiddleware.ts`
  Responsibility: persist canonical durable identity plus existing live handles, never launch-only inputs.
- Modify: `src/store/persistControl.ts`
  Responsibility: flush canonical durable identity and existing live-handle state without reviving launch-only inputs.
- Modify: `src/store/layoutMirrorMiddleware.ts`
  Responsibility: mirror canonical durable identity and explicit live-handle state only.
- Modify: `src/store/crossTabSync.ts`
  Responsibility: merge cross-tab state without reviving raw resume strings.
- Modify: `src/store/tabsSlice.ts`
  Responsibility: remove tab-level fallback reliance on raw `resumeSessionId`.
- Modify: `src/store/selectors/sidebarSelectors.ts`
  Responsibility: match open sessions and running state from explicit live handles plus canonical durable identity.
- Modify: `src/lib/session-utils.ts`
  Responsibility: resolve canonical session lookup and live-handle matching without mutable-name fallback or hybrid `sessionRef` locality fields.
- Modify: `src/lib/tab-registry-snapshot.ts`
  Responsibility: stop synthesizing canonical identity from arbitrary strings and stop smuggling locality into durable `sessionRef`.
- Modify: `src/lib/ui-commands.ts`
  Responsibility: normalize session payloads to the explicit contract.
- Modify: `src/lib/session-type-utils.ts`
  Responsibility: build resume content from canonical durable identity.
- Modify: `src/lib/session-metadata.ts`
  Responsibility: key metadata off canonical durable identity.
- Modify: `src/lib/pane-activity.ts`
  Responsibility: activity matching against canonical durable identity and live handles only.
- Modify: `src/components/TerminalView.tsx`
  Responsibility: persist only on canonical durable promotion and surface restore-unavailable outcomes.
- Modify: `src/components/BackgroundSessions.tsx`
  Responsibility: prefer live reattach and never smuggle stale restore ids into new tabs.
- Modify: `src/components/Sidebar.tsx`
  Responsibility: render open-session state from canonical durable identity without title/name fallbacks.
- Modify: `src/components/TabBar.tsx`
  Responsibility: stop reconstructing identity from stale resume strings.
- Modify: `src/components/TabsView.tsx`
  Responsibility: reconcile persisted live handles versus canonical durable restore during rehydrate.
- Modify: `src/components/TabContent.tsx`
  Responsibility: surface restore-unavailable state explicitly.
- Modify: `src/components/panes/PaneContainer.tsx`
  Responsibility: prefer canonical durable identity and explicit live handles for header/runtime metadata.
- Modify: `src/components/context-menu/menu-defs.ts`
  Responsibility: session-oriented actions use canonical durable identity only.
- Modify: `src/store/agentChatTypes.ts`
  Responsibility: document and preserve the split between live SDK state and durable Claude identity.
- Modify: `src/store/agentChatSlice.ts`
  Responsibility: durable promotion updates agent-chat state without collapsing live SDK ids.
- Modify: `src/components/agent-chat/AgentChatView.tsx`
  Responsibility: keep live SDK attach separate from durable restore identity and canonical promotion.
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`
  Responsibility: sidecar notification and durability-artifact fixtures.
- Modify: `docs/index.html` only if user-visible restore wording/status changed materially.

## Task 1: Lock Down Real Provider Contracts And Mutable-Name Semantics

**Files:**
- Create: `docs/lab-notes/2026-04-20-coding-cli-session-contract.md`
- Create: `test/helpers/coding-cli/real-session-contract-harness.ts`
- Create: `test/integration/real/coding-cli-session-contract.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Build the real-provider probe harness**

Add isolated temp-home helpers for `codex`, `claude`, and `opencode` that can:
- launch providers under unique temp directories
- capture stdout, stderr, session artifacts, and authoritative control-surface responses
- poll for durable artifact creation without guessing
- record every child PID they start
- clean up only probe-owned processes deterministically

- [ ] **Step 2: Audit provider processes and define the cleanup rule**

Run provenance-first process audits such as:
- `ps -eo pid,ppid,stat,cmd --sort=pid | rg "codex|claude|opencode"`
- `ps -fp <pid>`

Document exactly which processes are safe to stop and which live sessions must be left untouched.

- [ ] **Step 3: Run real probes for create, durability, restore, and rename/title mutation**

Capture:
- Codex fresh interactive launch timing: whether it creates a thread immediately or only after the first real turn, any `thread/started` notification timing, durable artifact creation timing, and `/rename` or equivalent title-mutation behavior (or the absence of such a surface)
- Claude fresh exact-id timing, transcript durability timing, named resume behavior, and `/rename` or equivalent title-mutation behavior (or the absence of such a surface)
- OpenCode bare startup behavior, first authoritative session creation timing, authoritative restore behavior, and `/rename` or equivalent title-mutation behavior (or the absence of such a surface)

Save exact commands, versions, artifacts, and relevant output snippets in the lab note.

- [ ] **Step 4: Write the checked-in lab note**

Document:
- provider versions
- exact commands
- exact observed artifacts/endpoints/events
- whether fresh interactive launch is live-only or immediately allocates a provider session/thread
- which earlier assumptions were false
- whether `/rename`, titles, or names can change independently of canonical ids, or whether no such mutable-name surface exists in the tested mode
- cleanup rules for probe-owned processes
- the exact provider behaviors Freshell is allowed to build on

- [ ] **Step 5: Encode the lab note as opt-in real-provider tests**

Add `test/integration/real/coding-cli-session-contract.test.ts` so every factual claim in the lab note is executable.

- [ ] **Step 6: Run the real-provider contract suite**

Run: `cross-env FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/coding-cli-session-contract.test.ts`

Expected: PASS. If the test and the lab note disagree, fix the test or the note before touching product code.

- [ ] **Step 7: Commit**

```bash
git add package.json docs/lab-notes/2026-04-20-coding-cli-session-contract.md test/helpers/coding-cli/real-session-contract-harness.ts test/integration/real/coding-cli-session-contract.test.ts
git commit -m "test: lock coding cli provider contracts"
```

## Task 2: Lock Down Freshell’s Live-Versus-Durable Resume State Machine Before Refactor

**Files:**
- Create: `test/integration/server/durable-session-contract.test.ts`
- Create: `test/integration/server/opencode-session-flow.test.ts`
- Modify: `test/integration/server/codex-session-flow.test.ts`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`
- Modify: `test/e2e/codex-refresh-rehydrate-flow.test.tsx`
- Modify: `test/e2e/agent-chat-restore-flow.test.tsx`
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`

- [ ] **Step 1: Write the failing end-to-end state-matrix tests**

Cover:
- same-server reconnect reattaches by persisted live handle (`terminalId` or SDK `sessionId`) even when no canonical `sessionRef` exists yet
- same-server reconnect reattaches the live terminal/session and does not recreate from `sessionRef`
- stale `serverInstanceId` or dead live handle uses durable restore only when canonical `sessionRef` exists
- dead non-durable session surfaces restore-unavailable
- canonical durable identity survives rename/title changes
- FreshClaude keeps live SDK `sessionId` separate from durable Claude identity during restore

- [ ] **Step 2: Run the state-matrix suite and verify it fails**

Run: `npm run test:vitest -- test/integration/server/durable-session-contract.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/opencode-session-flow.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-session-repair.test.ts test/e2e/codex-refresh-rehydrate-flow.test.tsx test/e2e/agent-chat-restore-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx`

Expected: FAIL because current code still treats fresh ids as durable and still blurs live reattach with recreate.

- [ ] **Step 3: Tighten the tests until they describe the intended end state exactly**

Make sure the tests explicitly encode:
- when live reattach wins
- when durable restore wins
- when restore must fail
- that mutable names/titles do not affect identity

- [ ] **Step 4: Re-run the suite and keep it red for the right reasons**

Run the same command again and confirm failures are still contract failures, not harness mistakes.

- [ ] **Step 5: Commit**

```bash
git add test/integration/server/durable-session-contract.test.ts test/integration/server/opencode-session-flow.test.ts test/integration/server/codex-session-flow.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-session-repair.test.ts test/e2e/codex-refresh-rehydrate-flow.test.tsx test/e2e/agent-chat-restore-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx
git commit -m "test: lock live versus durable session behavior"
```

## Task 3: Introduce The Shared Durable Contract And Migrate Persisted State

**Files:**
- Create: `shared/session-contract.ts`
- Create: `test/unit/shared/session-contract.test.ts`
- Create: `test/unit/client/lib/session-contract.test.ts`
- Create: `test/unit/client/store/storage-migration.test.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/store/paneTreeValidation.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/storage-migration.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/store/layoutMirrorMiddleware.ts`
- Modify: `src/store/crossTabSync.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/lib/ui-commands.ts`
- Modify: `src/lib/session-type-utils.ts`

- [ ] **Step 1: Write the failing contract and migration tests**

Cover:
- legacy `resumeSessionId` persistence migrates to canonical `sessionRef` or explicit restore-unavailable state
- canonical `sessionRef` never carries `serverInstanceId`; existing persisted live handles stay separate
- pane and tab construction preserve live-only launch inputs only transiently
- terminal panes/tabs use `sessionRef`, while agent-chat keeps live SDK `sessionId` distinct from its own durable Claude identity
- websocket payload normalization does not revive raw persisted resume strings
- storage-version bootstrap does not clear restorable session state for this feature

- [ ] **Step 2: Run the targeted contract suite and verify it fails**

Run: `npm run test:vitest -- test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts test/unit/client/store/panesSlice.test.ts test/unit/client/store/tabsSlice.merge.test.ts test/unit/client/layout-mirror-middleware.test.ts test/unit/client/store/crossTabSync.test.ts test/unit/client/store/storage-migration.test.ts test/unit/server/agent-layout-schema.test.ts test/server/ws-protocol.test.ts`

Expected: FAIL because the explicit contract and migration helpers do not exist yet.

- [ ] **Step 3: Implement the shared contract and persistence migration**

Add canonical `sessionRef`, live-only launch-input helpers, and one-time migration away from ambiguous persisted `resumeSessionId` strings without clearing persisted tabs/panes wholesale.

- [ ] **Step 4: Re-run the targeted suite and verify it passes**

Run the same command again.

Expected: PASS.

- [ ] **Step 5: Refactor helpers and run adjacent construction tests**

Run: `npm run test:vitest -- test/unit/client/components/TabsView.test.tsx test/unit/client/components/panes/PaneContainer.createContent.test.tsx test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/lib/session-type-utils.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/session-contract.ts shared/ws-protocol.ts src/store/paneTypes.ts src/store/types.ts src/store/panesSlice.ts src/store/paneTreeValidation.ts src/store/persistedState.ts src/store/storage-migration.ts src/store/persistMiddleware.ts src/store/layoutMirrorMiddleware.ts src/store/crossTabSync.ts src/store/tabsSlice.ts src/lib/ui-commands.ts src/lib/session-type-utils.ts test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts test/unit/client/store/storage-migration.test.ts
git commit -m "refactor: add explicit durable session contract"
```

## Task 4: Make Existing Binding Paths The Only Durable-Promotion Path

**Files:**
- Modify: `server/session-binding-authority.ts`
- Modify: `server/session-association-coordinator.ts`
- Modify: `server/session-association-updates.ts`
- Modify: `server/index.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `src/store/persistControl.ts`
- Modify: `src/lib/session-utils.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/terminal-view-utils.ts`

- [ ] **Step 1: Write the failing promotion-path tests**

Cover:
- `terminal.created` no longer persists non-durable ids
- `terminal.created` preserves only the live handle needed for same-server reconnect
- `terminal.session.associated` is the only terminal event that persists canonical durable identity
- same-server live reattach beats durable recreate
- missing durable identity yields restore-unavailable rather than fresh-session fallback

- [ ] **Step 2: Run the promotion-path suite and verify it fails**

Run: `npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/unit/server/terminal-registry.findRunningTerminal.test.ts test/server/ws-protocol.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/lib/session-utils.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts test/e2e/codex-refresh-rehydrate-flow.test.tsx`

Expected: FAIL because current code still persists immediate resume ids and still treats `terminal.created` as durable enough.

- [ ] **Step 3: Refactor the server/client binding flow**

Implement:
- explicit live handle vs durable `sessionRef` separation
- reuse of `terminal.session.associated` as the single authoritative terminal durable-promotion event
- clear restore-unavailable failures
- no second terminal durable-promotion controller/event

- [ ] **Step 4: Re-run the promotion-path suite and verify it passes**

Run the same command again.

Expected: PASS.

- [ ] **Step 5: Refactor and run adjacent persistence checks**

Run: `npm run test:vitest -- test/unit/client/store/tabsSlice.test.ts test/unit/client/store/tabsSlice.merge.test.ts test/unit/client/store/persistControl.test.ts test/unit/client/components/TerminalView.lastInputAt.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/session-binding-authority.ts server/session-association-coordinator.ts server/session-association-updates.ts server/index.ts server/ws-handler.ts server/terminal-registry.ts src/store/persistControl.ts src/lib/session-utils.ts src/lib/tab-registry-snapshot.ts src/components/TerminalView.tsx src/components/terminal-view-utils.ts test/unit/server/terminal-registry.test.ts test/unit/server/terminal-registry.findRunningTerminal.test.ts test/server/ws-protocol.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/TerminalView.resumeSession.test.tsx test/unit/client/lib/session-utils.test.ts test/unit/client/lib/tab-registry-snapshot.test.ts
git commit -m "refactor: make durable promotion authoritative"
```

## Task 5: Cut Codex Over To Per-Terminal Sidecars And Durable Artifact Promotion

**Files:**
- Create: `server/coding-cli/codex-app-server/sidecar.ts`
- Modify: `server/coding-cli/codex-app-server/client.ts`
- Modify: `server/coding-cli/codex-app-server/protocol.ts`
- Modify: `server/coding-cli/codex-app-server/runtime.ts`
- Modify: `server/coding-cli/codex-app-server/launch-planner.ts`
- Modify: `server/index.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`

- [ ] **Step 1: Rewrite the Codex tests to the real-provider contract**

Change expectations so that:
- fresh create launches `codex --remote <ws>` with no preallocated `resume`
- restore launches `codex --remote <ws> resume <durable-token>`
- a fresh interactive Codex pane may still be live-only until the provider actually creates a thread
- once a thread exists, the sidecar learns any exact thread identity only from provider notifications
- durable promotion happens only after the provider-owned artifact exists
- sidecar death terminates the terminal with a clear error

- [ ] **Step 2: Run the Codex-focused suite and verify it fails**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/codex-session-rebind-regression.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/codex-activity-exact-subset.test.ts`

Expected: FAIL because current implementation still preallocates fresh threads and persists them immediately.

- [ ] **Step 3: Implement the sidecar and terminal lifecycle**

Add one sidecar per Codex terminal, keep fresh panes live-only until the provider actually creates a thread, parse the required notifications, promote durability only after artifact proof, and tear the sidecar down on terminal exit and every other cleanup path.

- [ ] **Step 4: Re-run the Codex suite and broader regressions**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/codex-session-rebind-regression.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/codex-activity-exact-subset.test.ts test/e2e/codex-refresh-rehydrate-flow.test.tsx test/e2e/codex-activity-indicator-flow.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/coding-cli/codex-app-server/sidecar.ts server/coding-cli/codex-app-server/client.ts server/coding-cli/codex-app-server/protocol.ts server/coding-cli/codex-app-server/runtime.ts server/coding-cli/codex-app-server/launch-planner.ts server/index.ts server/ws-handler.ts server/terminal-registry.ts test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/codex-session-rebind-regression.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/codex-activity-exact-subset.test.ts
git commit -m "refactor: move codex terminals to sidecar-owned durability"
```

## Task 6: Canonicalize Claude And FreshClaude Without Flattening Their Live State

**Files:**
- Modify: `server/session-scanner/service.ts`
- Modify: `server/agent-timeline/ledger.ts`
- Modify: `server/index.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/store/agentChatTypes.ts`
- Modify: `src/store/agentChatSlice.ts`
- Modify: `src/components/agent-chat/AgentChatView.tsx`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/server/session-association.test.ts`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`
- Modify: `test/unit/server/agent-timeline-ledger.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `test/integration/server/agent-timeline-router.test.ts`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx`
- Modify: `test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx`

- [ ] **Step 1: Rewrite the Claude and FreshClaude tests to the canonical contract**

Cover:
- fresh terminal Claude launches use the Task 1 contract and do not become durable until the transcript exists
- named resumes and rename/title changes are launch/display metadata only
- persisted Claude restore candidates are revalidated on read and bad legacy values are rejected
- FreshClaude keeps live SDK `sessionId` separate from canonical durable Claude identity during restore hydration

- [ ] **Step 2: Run the targeted Claude/FreshClaude suite and verify it fails**

Run: `npm run test:vitest -- test/server/session-association.test.ts test/server/ws-terminal-create-session-repair.test.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/ws-handler-sdk.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx test/e2e/agent-chat-restore-flow.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx`

Expected: FAIL because current flow still relies on raw resume strings and still blurs live SDK state with durable history identity.

- [ ] **Step 3: Implement canonical promotion and read-time validation**

Implement:
- canonical UUID-only durable promotion
- rejection of non-canonical persisted Claude restore inputs
- agent-chat durable promotion without collapsing live SDK state
- restore-unavailable when only a mutable name remains and no canonical durable UUID can be proven

- [ ] **Step 4: Re-run the targeted suite and verify it passes**

Run the same command again.

Expected: PASS.

- [ ] **Step 5: Run adjacent Claude/FreshClaude regressions**

Run: `npm run test:vitest -- test/unit/client/components/agent-chat/AgentChatView.split-pane.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/session-scanner/service.ts server/agent-timeline/ledger.ts server/index.ts server/terminal-registry.ts server/ws-handler.ts src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/components/agent-chat/AgentChatView.tsx src/components/TerminalView.tsx test/server/session-association.test.ts test/server/ws-terminal-create-session-repair.test.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/ws-handler-sdk.test.ts test/integration/server/agent-timeline-router.test.ts test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/unit/client/components/agent-chat/AgentChatView.session-lost.test.tsx
git commit -m "refactor: canonicalize claude and freshclaude restore identity"
```

## Task 7: Promote OpenCode Only From Its Authoritative Control Surface

**Files:**
- Create: `server/coding-cli/opencode-session-controller.ts`
- Modify: `server/coding-cli/opencode-activity-tracker.ts`
- Modify: `server/coding-cli/opencode-activity-wiring.ts`
- Modify: `server/index.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Modify: `test/integration/server/opencode-session-flow.test.ts`
- Modify: `test/server/ws-opencode-activity.test.ts`
- Modify: `test/unit/client/lib/pane-activity.test.ts`
- Modify: `test/e2e/pane-activity-indicator-flow.test.tsx`

- [ ] **Step 1: Write the failing OpenCode durability tests**

Cover:
- bare interactive startup remains live-only until the provider creates a session
- authoritative control events promote the pane to canonical durable identity
- restore uses only canonical durable `sessionRef`
- names/titles do not become restore keys

- [ ] **Step 2: Run the targeted OpenCode suite and verify it fails**

Run: `npm run test:vitest -- test/integration/server/opencode-session-flow.test.ts test/server/ws-opencode-activity.test.ts test/unit/client/lib/pane-activity.test.ts test/e2e/pane-activity-indicator-flow.test.tsx`

Expected: FAIL because OpenCode durable promotion is not yet modeled explicitly.

- [ ] **Step 3: Implement the authoritative OpenCode session controller**

Extend the current authoritative tracker/event stream so the controller can observe exact session creation, durable promotion, and cleanup without PTY heuristics.

- [ ] **Step 4: Re-run the targeted suite and verify it passes**

Run the same command again.

Expected: PASS.

- [ ] **Step 5: Run adjacent OpenCode checks**

Run: `npm run test:vitest -- test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/title-sync-flow.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/opencode-session-controller.ts server/coding-cli/opencode-activity-tracker.ts server/coding-cli/opencode-activity-wiring.ts server/index.ts server/terminal-registry.ts server/ws-handler.ts test/integration/server/opencode-session-flow.test.ts test/server/ws-opencode-activity.test.ts test/unit/client/lib/pane-activity.test.ts test/e2e/pane-activity-indicator-flow.test.tsx
git commit -m "refactor: promote opencode sessions from authoritative events"
```

## Task 8: Cut Over Read Models, Sidebar, Background Sessions, Agent Routes, And MCP

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
- terminal-directory and background-session payloads preserve live-vs-durable identity correctly
- sidebar matching uses canonical durable identity plus explicit live handles, not mutable names or hybrid `sessionRef` locality
- pane headers and runtime metadata stop depending on raw `resumeSessionId`
- context-menu, agent routes, and MCP surfaces send the explicit contract

- [ ] **Step 2: Run the targeted consumer suite and verify it fails**

Run: `npm run test:vitest -- test/server/terminals-api.test.ts test/integration/server/terminal-view-router.test.ts test/unit/server/terminal-metadata-service.test.ts test/unit/server/mcp/freshell-tool.test.ts test/server/agent-panes-write.test.ts test/server/agent-run.test.ts test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/TabContent.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/terminal-view-utils.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/sidebar-search-flow.test.tsx`

Expected: FAIL until all consumers stop depending on the old string semantics.

- [ ] **Step 3: Implement the remaining consumer cutover**

Finish the read-model, UI, agent, and MCP consumers so the repo consistently uses:
- live handles for same-server reattach
- canonical durable `sessionRef` for recreate and exact durable identity

- [ ] **Step 4: Re-run the targeted consumer suite and verify it passes**

Run the same command again.

Expected: PASS.

- [ ] **Step 5: Run the UI/read-model regression sweep**

Run: `npm run test:vitest -- test/server/ws-sidebar-snapshot-refresh.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/tabs-view-flow.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/sidebar-refresh-dom-stability.test.tsx test/e2e/sidebar-search-flow.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/terminal-view/types.ts server/terminal-view/service.ts server/terminals-router.ts server/terminal-metadata-service.ts server/agent-api/router.ts server/mcp/freshell-tool.ts src/store/selectors/sidebarSelectors.ts src/lib/session-metadata.ts src/lib/pane-activity.ts src/components/BackgroundSessions.tsx src/components/Sidebar.tsx src/components/TabBar.tsx src/components/TabsView.tsx src/components/TabContent.tsx src/components/panes/PaneContainer.tsx src/components/context-menu/menu-defs.ts test/server/terminals-api.test.ts test/integration/server/terminal-view-router.test.ts test/unit/server/terminal-metadata-service.test.ts test/unit/server/mcp/freshell-tool.test.ts test/server/agent-panes-write.test.ts test/server/agent-run.test.ts test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/Sidebar.render-stability.test.tsx test/unit/client/components/TabContent.test.tsx test/unit/client/components/TabsView.test.tsx test/unit/client/components/panes/PaneContainer.test.tsx test/unit/client/components/terminal-view-utils.test.ts test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts test/unit/client/store/terminalDirectorySlice.test.ts test/unit/client/store/terminalDirectoryThunks.test.ts
git commit -m "refactor: cut consumers over to explicit session identity"
```

## Task 9: Final Verification And Docs

**Files:**
- Modify: `docs/index.html` only if user-visible restore wording/status changed materially

- [ ] **Step 1: Update `docs/index.html` only if the visible restore contract changed**

Do not touch the mock unless the default experience now shows materially different restore wording or status affordances.

- [ ] **Step 2: Run lint**

Run: `npm run lint`

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Re-run the opt-in real-provider contract suite**

Run: `cross-env FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/coding-cli-session-contract.test.ts`

Expected: PASS.

- [ ] **Step 5: Run the focused cross-cutting regression sweep**

Run: `npm run test:vitest -- test/integration/server/durable-session-contract.test.ts test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/opencode-session-flow.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-session-repair.test.ts test/unit/server/agent-timeline-ledger.test.ts test/unit/server/ws-handler-sdk.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-opencode-activity.test.ts test/server/terminals-api.test.ts test/unit/client/components/BackgroundSessions.test.tsx test/unit/client/components/Sidebar.test.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/components/agent-chat/AgentChatView.reload.test.tsx test/e2e/codex-refresh-rehydrate-flow.test.tsx test/e2e/agent-chat-restore-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx`

Expected: PASS.

- [ ] **Step 6: Run the coordinated full suite**

Run: `FRESHELL_TEST_SUMMARY="exact durable session contract" npm test`

Expected: PASS. If any valid check fails, keep improving the implementation and tests. Do not stop on partial green.

- [ ] **Step 7: Commit any final doc or cleanup change from this task**

If Step 1 changed `docs/index.html` or verification exposed a final cleanup edit, commit it. If this task produced no file changes, skip the commit.

## Completion Checklist

- The checked-in lab note matches the executable real-provider contract suite.
- The implementation preserves existing persisted tabs/panes through targeted migration; it does not rely on a storage-version wipe.
- The contract tests explicitly prove when live reattach happens, when durable restore happens, and when restore must fail.
- Probe-owned helper processes are cleaned up deterministically and live user sessions were not killed.
- Canonical `sessionRef = { provider, sessionId }` is the only persisted replay identity; it never carries `serverInstanceId`.
- Persisted live handles needed for same-server refresh recovery remain separate for terminals and agent-chat.
- Mutable names/titles and `/rename`-style inputs are proven non-canonical and never used as restore keys.
- `terminal.session.associated` is the single authoritative terminal durable-promotion event.
- Fresh Codex sessions are started only by the Codex CLI itself over a terminal-owned sidecar, remain live-only until the provider actually creates a thread/session, and sidecar death fails clearly.
- Claude and FreshClaude restore only from canonical durable Claude identity.
- OpenCode durable promotion comes only from authoritative control data.
- Read models, sidebar state, background sessions, agent routes, and MCP all use the explicit contract consistently.
- Lint, typecheck, the focused regression sweep, the opt-in real-provider suite, and coordinated full `npm test` all pass.
