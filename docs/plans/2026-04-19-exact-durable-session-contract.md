# Exact Durable Session Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Freshell's ambiguous coding-CLI resume model with one verified session contract that separates live reattach, explicit resume targets, and canonical durable session identity, then cut Codex, Claude terminal sessions, and OpenCode over to that model without heuristic drift or silent fallbacks.

**Architecture:** Introduce one shared session contract across server, client, and persisted state: live reattach remains `terminalId` plus `serverInstanceId`, relaunch uses an explicit `resumeTarget`, and exact durable identity uses `sessionRef`. Do not persist exact-but-not-durable provider ids. Fresh Codex and OpenCode terminals learn durability from terminal-owned control sidecars; fresh Claude terminals use Freshell-generated `--session-id` values and only keep bounded alias-promotion logic for explicitly non-exact named resumes.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, WebSocket (`ws`), node-pty, Vitest, Testing Library, opt-in real CLI probe tests for Codex/Claude/OpenCode

---

## Architecture

## Why This Is The Right End State

- PR `#298` was directionally right about one thing: Freshell should stop guessing which provider session belongs to a pane.
- The regression came from collapsing two distinct states:
  - provider allocated an exact session/thread identity
  - that identity is durable enough to replay after the original live terminal is gone
- The durable fix is therefore not "patch Codex resume again." It is "make the session contract explicit everywhere so Freshell cannot persist or replay the wrong class of token."
- The clean steady state has three separate concepts:
  - live terminal handle: reconnect to an already-running process on the same server
  - resume target: explicit provider input Freshell may use to recreate a session
  - session reference: canonical exact durable provider identity for matching, metadata, sidebar state, and cross-device snapshots
- This is the same conceptual split the repo already arrived at in FreshClaude restore work, but the terminal providers never got the same rigor.

## Strategy Gate

These paths are intentionally rejected:

- Do not widen Codex timeouts or only harden stdio drain. That fixes transport symptoms, not the contract bug that shipped in `996f48b9`.
- Do not keep `resumeSessionId` as a generic string that can mean alias, pending exact id, or durable resume token depending on call site. That ambiguity is the bug class.
- Do not keep Freshell issuing Codex `thread/start` or `thread/resume` RPCs itself while also launching the Codex TUI. The Codex CLI already owns those flows; dual ownership created the exact regression.
- Do not keep shared-runtime Codex `thread/started` matching. Once fresh sessions stop being preallocated, a shared app-server cannot attribute notifications to a specific terminal without reintroducing heuristics.
- Do not persist exact-but-not-durable ids. Recreating a dead session from a token the provider had not actually persisted would fabricate a new conversation under an old-looking identity.
- Do not silently fall back from "restore this session" to "start a fresh one." The product should fail clearly when a session was never durable enough to restore.

## What Was Verified During Planning

- Local provider versions were verified in this planning session:
  - `codex --version` → `codex-cli 0.121.0`
  - `claude --version` → `2.1.114 (Claude Code)`
  - `opencode --version` → `1.4.11`
- The current code still persists fresh Codex `thread/start` ids immediately:
  - [server/coding-cli/codex-app-server/launch-planner.ts](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/coding-cli/codex-app-server/launch-planner.ts)
  - [server/ws-handler.ts](/home/user/code/freshell/.worktrees/exact-durable-session-contract/server/ws-handler.ts)
  - [test/integration/server/codex-session-flow.test.ts](/home/user/code/freshell/.worktrees/exact-durable-session-contract/test/integration/server/codex-session-flow.test.ts)
- The implementation worktree has no background processes attached to it, so there is nothing safe to tear down from this workspace.

## What Must Be Re-verified Before Code Changes

- Every provider behavior assumption that the implementation depends on must be re-locked by an executable probe suite before the refactor lands.
- Those probes must run against the installed local binaries and record what Freshell is allowed to assume, including:
  - Codex fresh remote launch notification timing, exact thread identity timing, and durability timing
  - Claude `--session-id`, `--resume`, and named-resume durability behavior
  - OpenCode interactive startup, `session.created`, `/session`, and durable id timing on the authoritative localhost control surface
- Those probe results must be written down in a checked-in lab note, with provider versions and exact commands used.
- The rest of the refactor then builds against those verified contracts, not the other way around.

## User-Visible Behavior

- Refreshing the browser while the server still owns the live terminal reattaches to the existing terminal by `terminalId`, regardless of whether the provider session is already durable.
- A fresh coding-CLI pane is not marked as restorable until the provider has actually produced a durable replay target.
- Once durability is confirmed, the pane and its tab persist:
  - the explicit `resumeTarget`
  - the canonical durable `sessionRef`
- If the server loses a non-durable terminal and there is no explicit resume target, the pane shows a clear restore-unavailable error. It does not silently create a fresh session.
- Explicit alias resumes remain supported only where the provider actually supports them:
  - the alias is stored as an explicit non-canonical resume target
  - the pane upgrades in place to the canonical durable `sessionRef` once the provider reveals it
  - exact matching, sidebar identity, and metadata switch to the canonical durable identity immediately on upgrade

## End-State Contracts And Invariants

### 1. One Shared Session Contract

- Add one shared contract type used by server, client, persisted state, and websocket payloads:
  - `resumeTarget`
  - `sessionRef`
- `resumeTarget` is a discriminated union:
  - `{ kind: 'durable', token: string }`
  - `{ kind: 'alias', token: string }`
- `sessionRef` is always the canonical exact durable provider identity:
  - `{ provider, sessionId, serverInstanceId? }`
- `resumeTarget.kind === 'durable'` may use the same string as `sessionRef.sessionId`, but code must not assume that relationship without the type saying so.
- Exact-but-not-durable provider ids are server-memory-only state. They are never persisted into `resumeTarget` or `sessionRef`.

### 2. Live Reattach Is Not Resume

- Live reattach uses:
  - `terminalId`
  - `serverInstanceId`
- Resume after the live process is gone uses only `resumeTarget`.
- These paths must stay distinct in code and in tests.

### 3. Durable Promotion Is Explicit

- `terminal.created` means only that the PTY exists.
- Fresh creates must not piggyback non-durable session ids into `terminal.created`.
- Introduce a server-to-client durable-promotion message:
  - `terminal.session.durable`
- That message is the only point where fresh terminal panes persist a new `resumeTarget.kind = 'durable'` and `sessionRef`.
- Restores that already start from a durable target may include the durable target in `terminal.created`, but they do not need a later promotion event unless the canonical `sessionRef` changes.

### 4. Provider-Specific Rules

#### Codex

- Freshell no longer issues `thread/start` or `thread/resume` RPCs to manage Codex sessions.
- Each Codex terminal owns its own loopback app-server sidecar.
- Fresh launch path:
  - start sidecar
  - launch `codex --remote <ws>`
  - observe sidecar notifications to learn the exact thread id
  - promote to durable only when the provider's durable rollout/session artifact is actually present
- Restore path:
  - start new sidecar
  - launch `codex --remote <ws> resume <durable-token>`
- Reason for sidecars:
  - once `thread/start` preallocation is removed, exact notification attribution must still be deterministic
  - a terminal-owned sidecar gives that determinism without same-cwd or timing heuristics

#### Claude Terminal Sessions

- Fresh terminal launches use a Freshell-generated UUID via `--session-id <uuid>`.
- That UUID is exact immediately, but it is not durable until the provider transcript actually exists.
- Therefore:
  - the UUID may be kept as server-memory exact state for that running terminal
  - it is not persisted as `resumeTarget` until the transcript is durable
- Explicit named resume remains supported as `resumeTarget.kind = 'alias'`.
- Alias promotion is a narrow, explicit mechanism:
  - it exists only for providers and launch modes that truly have alias resumes
  - it never handles fresh session creation
  - it only upgrades alias targets to canonical durable `sessionRef`

#### OpenCode

- Fresh OpenCode interactive startup may not create a durable session immediately.
- The authoritative source is the terminal-owned localhost control endpoint, not cwd heuristics.
- Promote to durable only when the control server or its durable store exposes a real exact session id.
- Resume uses `resumeTarget.kind = 'durable'` only.

### 5. Durable Binding Authority Owns Only Durable Identity

- `SessionBindingAuthority` and any exact-session reuse lookup must bind only canonical durable `sessionRef` identities.
- Pending exact ids are not part of durable ownership and do not participate in sidebar/open-session matching.
- Alias targets are not part of durable ownership either.

### 6. Compatibility Is Boundary-Only

- Existing persisted layout state may still contain `resumeSessionId` string fields.
- Hydration must normalize them exactly once:
  - known durable ids become `resumeTarget.kind = 'durable'`
  - known alias cases become `resumeTarget.kind = 'alias'`
  - explicit `sessionRef` is created only when the old state truly identifies a canonical durable session
- After hydration, runtime code must not keep consulting the legacy string field.
- API and websocket boundaries may accept the legacy string input temporarily, but internal state and new outbound payloads use the new contract only.

## File Structure

- Create: `shared/session-contract.ts`
  Responsibility: canonical `resumeTarget` schemas, `sessionRef` helpers, legacy normalization, and provider-aware validators shared by server and client.
- Create: `server/coding-cli/session-contract-controller.ts`
  Responsibility: server-memory lifecycle state for terminal sessions (`none`, `exact_pending`, `durable`), durable promotion, and provider controller registration.
- Create: `server/coding-cli/codex-app-server/sidecar.ts`
  Responsibility: per-terminal Codex app-server lifecycle, initialization, notification intake, and safe teardown.
- Create: `server/coding-cli/opencode-session-controller.ts`
  Responsibility: watch the authoritative OpenCode localhost control surface for exact session creation and durable promotion.
- Create: `server/coding-cli/alias-promotion-coordinator.ts`
  Responsibility: bounded alias-to-canonical upgrade logic for providers that support non-exact alias resumes.
- Create: `test/helpers/coding-cli/real-session-contract-harness.ts`
  Responsibility: isolated temp-home launch helpers for real Codex, Claude, and OpenCode probes.
- Create: `test/integration/real/coding-cli-session-contract.test.ts`
  Responsibility: opt-in local provider contract verification, skipped unless explicitly enabled.
- Create: `test/unit/shared/session-contract.test.ts`
  Responsibility: lock the shared contract normalization and migration rules.
- Create: `test/unit/client/lib/session-contract.test.ts`
  Responsibility: lock client helpers for `resumeTarget`, `sessionRef`, and no-layout fallback behavior.
- Create: `test/integration/server/opencode-session-flow.test.ts`
  Responsibility: lock fresh OpenCode durability promotion and exact-session restore semantics.
- Create: `docs/lab-notes/2026-04-19-coding-cli-session-contract.md`
  Responsibility: checked-in behavior matrix with verified provider versions, probe commands, and conclusions.
- Modify: `package.json`
  Responsibility: add an explicit opt-in script for real provider contract probes.
- Modify: `shared/ws-protocol.ts`
  Responsibility: add `resumeTarget` schema, `terminal.session.durable`, and legacy input normalization at the protocol boundary.
- Modify: `server/ws-handler.ts`
  Responsibility: consume normalized resume targets, stop persisting fresh non-durable ids, surface `terminal.session.durable`, and error clearly when no recreate target exists.
- Modify: `server/terminal-registry.ts`
  Responsibility: separate durable binding from exact-pending runtime state, expose controller hooks, and stop assuming the spawn resume token is durable.
- Modify: `server/index.ts`
  Responsibility: wire the new contract controller, sidecars, alias promotion, and indexer integration.
- Modify: `server/session-association-coordinator.ts`
  Responsibility: remove fresh-session ownership from the old coordinator or replace it with a thin compatibility shim while the new alias coordinator takes over.
- Modify: `server/session-association-updates.ts`
  Responsibility: switch from generic association wording to explicit durable-promotion semantics.
- Modify: `server/agent-api/router.ts`
  Responsibility: normalize incoming legacy `resumeSessionId` to `resumeTarget` and pass the new contract through terminal creation APIs.
- Modify: `src/store/paneTypes.ts`
  Responsibility: persist `resumeTarget` plus `sessionRef` instead of a generic `resumeSessionId` string.
- Modify: `src/store/types.ts`
  Responsibility: give tabs explicit `resumeTarget` and `sessionRef` fallback fields.
- Modify: `src/store/persistedState.ts`
  Responsibility: parse old persisted layouts and migrate them into the new contract.
- Modify: `src/store/persistMiddleware.ts`
  Responsibility: write only the new contract shape and stop persisting legacy string fields.
- Modify: `src/store/tabsSlice.ts`
  Responsibility: hydrate, merge, and protect canonical session state using `resumeTarget` plus `sessionRef`.
- Modify: `src/store/persistControl.ts`
  Responsibility: compute durable-promotion updates using the new contract and stop equating resume token with canonical session id.
- Modify: `src/lib/session-utils.ts`
  Responsibility: exact session lookup from `sessionRef`, compatibility-only fallback from durable resume targets, and explicit alias handling.
- Modify: `src/lib/tab-registry-snapshot.ts`
  Responsibility: stop synthesizing exact `sessionRef` from arbitrary string resume ids except at legacy migration seams.
- Modify: `src/components/TerminalView.tsx`
  Responsibility: create terminals using normalized resume targets, persist only on `terminal.session.durable`, and surface clear restore-unavailable errors when a lost terminal never became durable.
- Modify: `src/lib/ui-commands.ts`
  Responsibility: carry `resumeTarget` and `sessionRef` through UI command payloads.
- Modify: `src/store/agentChatTypes.ts`, `src/store/agentChatSlice.ts`, `src/components/agent-chat/AgentChatView.tsx`
  Responsibility: align shared pane/tab persistence naming with the new contract without redesigning the existing FreshClaude restore ledger.
- Modify: `test/integration/server/codex-session-flow.test.ts`
  Responsibility: replace the incorrect "fresh create immediately persists durable resume id" expectation with the new sidecar + promotion contract.
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
  Responsibility: lock fresh-create, running-terminal reuse, and durable-promotion behavior under the new contract.
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
  Responsibility: lock Claude `--session-id` fresh creates and explicit alias resume behavior.
- Modify: `test/e2e/codex-refresh-rehydrate-flow.test.tsx`
  Responsibility: prove refresh/rehydrate only persists and reuses Codex once durability has actually been promoted.
- Modify: `test/e2e/open-tab-session-sidebar-visibility.test.tsx`, `test/e2e/pane-activity-indicator-flow.test.tsx`, `test/e2e/sidebar-busy-icon-flow.test.tsx`
  Responsibility: lock sidebar identity and activity against `sessionRef` plus explicit resume targets rather than ambiguous fallback strings.

## Task 1: Lock Down Real Provider Behavior

**Files:**
- Create: `test/helpers/coding-cli/real-session-contract-harness.ts`
- Create: `test/integration/real/coding-cli-session-contract.test.ts`
- Create: `docs/lab-notes/2026-04-19-coding-cli-session-contract.md`
- Modify: `package.json`

- [ ] **Step 1: Write the failing opt-in provider contract tests**

Add real-provider tests that exercise the exact behaviors this refactor depends on:
- Codex fresh remote start yields an exact thread identity before durability, but not immediate replay-safe durability
- Claude `--session-id` is exact immediately but not durable until transcript persistence
- Claude named resume is a valid alias input but not a canonical durable identity
- OpenCode authoritative control surfaces reveal when a real exact durable session id exists

- [ ] **Step 2: Run the new probe suite and verify it fails for legitimate reasons**

Run: `cross-env FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/coding-cli-session-contract.test.ts`

Expected: FAIL because the harness, helpers, and checked-in contract note do not exist yet.

- [ ] **Step 3: Implement the real-provider probe harness and checked-in lab note**

Implement isolated temp-home helpers that:
- run against the locally installed `codex`, `claude`, and `opencode`
- avoid leaving background processes behind
- record exact commands, versions, and observed behavior

Update the lab note with:
- provider versions
- exact command lines
- exact assumptions Freshell may rely on
- explicit statements for anything the probes disproved

- [ ] **Step 4: Re-run the provider contract suite and verify it passes**

Run: `cross-env FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/coding-cli-session-contract.test.ts`

Expected: PASS.

- [ ] **Step 5: Refactor probe helpers for clarity and re-run the narrow checks**

Tighten the harness, remove duplication, and make cleanup deterministic.

Run: `cross-env FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/coding-cli-session-contract.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json test/helpers/coding-cli/real-session-contract-harness.ts test/integration/real/coding-cli-session-contract.test.ts docs/lab-notes/2026-04-19-coding-cli-session-contract.md
git commit -m "test: lock coding cli session contracts"
```

## Task 2: Introduce The Explicit Session Contract And Migration

**Files:**
- Create: `shared/session-contract.ts`
- Create: `test/unit/shared/session-contract.test.ts`
- Create: `test/unit/client/lib/session-contract.test.ts`
- Modify: `shared/ws-protocol.ts`
- Modify: `src/store/paneTypes.ts`
- Modify: `src/store/types.ts`
- Modify: `src/store/persistedState.ts`
- Modify: `src/store/persistMiddleware.ts`
- Modify: `src/lib/ui-commands.ts`

- [ ] **Step 1: Write the failing shared-contract and migration tests**

Cover:
- legacy string `resumeSessionId` migration to explicit `resumeTarget`
- durable id vs alias normalization by provider
- `sessionRef` validation rules
- persisted tab and pane fallback behavior after migration

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run: `npm run test:vitest -- test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts test/server/ws-protocol.test.ts`

Expected: FAIL because the shared contract types and migration logic do not exist yet.

- [ ] **Step 3: Implement the shared contract and storage/protocol normalization**

Add the new shared types and update websocket plus persisted-state parsing so:
- old inputs still hydrate
- new runtime state uses `resumeTarget` plus `sessionRef`
- no new code path relies on a raw legacy `resumeSessionId` string

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

Run: `npm run test:vitest -- test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts test/server/ws-protocol.test.ts`

Expected: PASS.

- [ ] **Step 5: Refactor the contract helpers and re-run the broader local persistence checks**

Run: `npm run test:vitest -- test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts test/unit/client/components/App.ws-bootstrap.test.tsx test/unit/client/store/settingsSlice.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/session-contract.ts shared/ws-protocol.ts src/store/paneTypes.ts src/store/types.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/lib/ui-commands.ts test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts
git commit -m "refactor: add explicit session contract"
```

## Task 3: Make Durable Promotion The Only Persistence Path

**Files:**
- Create: `server/coding-cli/session-contract-controller.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/session-association-updates.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/persistControl.ts`
- Modify: `src/lib/session-utils.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/server/terminal-registry.test.ts`
- Test: `test/server/ws-protocol.test.ts`
- Test: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Test: `test/e2e/codex-refresh-rehydrate-flow.test.tsx`

- [ ] **Step 1: Write or extend the failing durable-promotion tests**

Add coverage for:
- fresh terminal creates do not persist non-durable ids
- `terminal.session.durable` is the only event that persists a new durable target
- lost non-durable terminals surface explicit restore-unavailable errors
- exact matching uses `sessionRef`, not a guessed fallback string

- [ ] **Step 2: Run the targeted tests and verify they fail**

Run: `npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/server/ws-protocol.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-refresh-rehydrate-flow.test.tsx`

Expected: FAIL because fresh creates still persist immediate resume ids and the new durable-promotion event does not exist.

- [ ] **Step 3: Implement durable-only persistence and the new websocket event contract**

Implement:
- server-memory exact-pending state in the new controller
- durable-only binding in the registry
- `terminal.session.durable` server-to-client messages
- client persistence that only updates on durable promotion or on restores that already had durable targets

- [ ] **Step 4: Re-run the targeted tests and verify they pass**

Run: `npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/server/ws-protocol.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-refresh-rehydrate-flow.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor and re-run related selector/sidebar checks**

Run: `npm run test:vitest -- test/unit/server/terminal-registry.test.ts test/server/ws-protocol.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/unit/client/lib/session-contract.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/session-contract-controller.ts server/terminal-registry.ts server/ws-handler.ts server/session-association-updates.ts src/store/tabsSlice.ts src/store/persistControl.ts src/lib/session-utils.ts src/lib/tab-registry-snapshot.ts src/components/TerminalView.tsx test/unit/server/terminal-registry.test.ts test/server/ws-protocol.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-refresh-rehydrate-flow.test.tsx
git commit -m "refactor: persist only durable session identity"
```

## Task 4: Replace Codex Preallocation With Terminal-Owned Sidecars

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
- Test: `test/unit/server/coding-cli/codex-app-server/client.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/runtime.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts`
- Test: `test/integration/server/codex-session-flow.test.ts`
- Test: `test/server/ws-terminal-create-reuse-running-codex.test.ts`

- [ ] **Step 1: Rewrite the failing Codex tests to the correct contract**

Change expectations so that:
- fresh Codex create launches `codex --remote <ws>` with no preallocated `resume`
- Freshell does not call `thread/start` or `thread/resume`
- the sidecar learns exact thread identity from app-server notifications
- durable promotion happens later, not in `terminal.created`

- [ ] **Step 2: Run the Codex-focused suite and verify it fails**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/integration/server/codex-session-flow.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts`

Expected: FAIL because the current implementation still preallocates fresh threads and persists them immediately.

- [ ] **Step 3: Implement the sidecar-owned Codex launch flow**

Implement:
- one Codex app-server sidecar per terminal
- notification intake for exact thread identity
- fresh spawn with `codex --remote <ws>`
- restore spawn with `codex --remote <ws> resume <durable-token>`
- durable promotion only after the provider's durable artifact exists
- removal or reduction of obsolete planner responsibilities once start/resume RPC ownership is gone

- [ ] **Step 4: Re-run the Codex-focused suite and verify it passes**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/integration/server/codex-session-flow.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts`

Expected: PASS.

- [ ] **Step 5: Refactor sidecar cleanup and re-run the broader Codex checks**

Run: `npm run test:vitest -- test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/integration/server/codex-session-flow.test.ts test/server/codex-activity-exact-subset.test.ts test/e2e/codex-activity-indicator-flow.test.tsx test/e2e/codex-refresh-rehydrate-flow.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/codex-app-server/sidecar.ts server/coding-cli/codex-app-server/client.ts server/coding-cli/codex-app-server/protocol.ts server/coding-cli/codex-app-server/runtime.ts server/coding-cli/codex-app-server/launch-planner.ts server/index.ts server/ws-handler.ts server/terminal-registry.ts test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/unit/server/coding-cli/codex-app-server/launch-planner.test.ts test/integration/server/codex-session-flow.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts
git commit -m "refactor: move codex terminals to sidecar-owned sessions"
```

## Task 5: Remove Fresh Claude Heuristics And Bound Alias Promotion

**Files:**
- Create: `server/coding-cli/alias-promotion-coordinator.ts`
- Modify: `server/session-association-coordinator.ts`
- Modify: `server/session-association-updates.ts`
- Modify: `server/index.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/server/session-association.test.ts`
- Test: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Test: `test/e2e/agent-chat-restore-flow.test.tsx`
- Test: `test/e2e/agent-chat-resume-history-flow.test.tsx`

- [ ] **Step 1: Write or update the failing Claude identity tests**

Cover:
- fresh terminal Claude launches use Freshell-generated `--session-id`
- fresh creates no longer depend on same-cwd association to become exact
- explicit named resumes are represented as alias targets and upgrade later
- exact durable matching and recovery prefer canonical `sessionRef`

- [ ] **Step 2: Run the targeted Claude tests and verify they fail**

Run: `npm run test:vitest -- test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/e2e/agent-chat-restore-flow.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx`

Expected: FAIL because the current terminal flow still relies on generic association and shared string resume semantics.

- [ ] **Step 3: Implement fresh Claude UUID launches and the bounded alias coordinator**

Implement:
- `--session-id <uuid>` for fresh Claude terminal launches
- server-memory exact-pending tracking for fresh UUID-based terminals
- a narrow alias-promotion coordinator used only for alias resumes, not fresh sessions
- canonical durable upgrades that switch pane/tab state to `sessionRef` plus durable `resumeTarget`

- [ ] **Step 4: Re-run the targeted Claude tests and verify they pass**

Run: `npm run test:vitest -- test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/e2e/agent-chat-restore-flow.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor and re-run the broader restore and sidebar checks**

Run: `npm run test:vitest -- test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/alias-promotion-coordinator.ts server/session-association-coordinator.ts server/session-association-updates.ts server/index.ts server/terminal-registry.ts server/ws-handler.ts src/components/TerminalView.tsx test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/e2e/agent-chat-restore-flow.test.tsx test/e2e/agent-chat-resume-history-flow.test.tsx
git commit -m "refactor: bound alias promotion to explicit resume aliases"
```

## Task 6: Promote OpenCode Only From Authoritative Control Events

**Files:**
- Create: `server/coding-cli/opencode-session-controller.ts`
- Create: `test/integration/server/opencode-session-flow.test.ts`
- Modify: `server/coding-cli/opencode-activity-tracker.ts`
- Modify: `server/coding-cli/opencode-activity-wiring.ts`
- Modify: `server/index.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/ws-handler.ts`
- Test: `test/server/ws-opencode-activity.test.ts`
- Test: `test/e2e/pane-activity-indicator-flow.test.tsx`

- [ ] **Step 1: Write the failing OpenCode durability tests**

Cover:
- fresh interactive startup does not persist a durable resume target before the provider actually creates a session
- authoritative control events or surfaces promote the pane to a durable exact id
- restore uses only durable targets

- [ ] **Step 2: Run the targeted OpenCode tests and verify they fail**

Run: `npm run test:vitest -- test/integration/server/opencode-session-flow.test.ts test/server/ws-opencode-activity.test.ts test/e2e/pane-activity-indicator-flow.test.tsx`

Expected: FAIL because OpenCode durable promotion is not currently modeled explicitly.

- [ ] **Step 3: Implement the OpenCode session controller and durable promotion**

Wire the terminal-owned localhost endpoint so that:
- durability promotion comes from authoritative provider data
- the controller updates the shared contract controller
- activity tracking and durable identity stay in sync

- [ ] **Step 4: Re-run the targeted OpenCode tests and verify they pass**

Run: `npm run test:vitest -- test/integration/server/opencode-session-flow.test.ts test/server/ws-opencode-activity.test.ts test/e2e/pane-activity-indicator-flow.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor OpenCode controller lifecycle and re-run related tab/sidebar checks**

Run: `npm run test:vitest -- test/integration/server/opencode-session-flow.test.ts test/server/ws-opencode-activity.test.ts test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/title-sync-flow.test.tsx`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/coding-cli/opencode-session-controller.ts server/coding-cli/opencode-activity-tracker.ts server/coding-cli/opencode-activity-wiring.ts server/index.ts server/terminal-registry.ts server/ws-handler.ts test/integration/server/opencode-session-flow.test.ts test/server/ws-opencode-activity.test.ts test/e2e/pane-activity-indicator-flow.test.tsx
git commit -m "refactor: promote opencode sessions from authoritative control events"
```

## Task 7: Cut All Consumers Over And Run Full Verification

**Files:**
- Modify: `src/lib/session-utils.ts`
- Modify: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/store/tabsSlice.ts`
- Modify: `src/store/persistControl.ts`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/components/TabContent.tsx`
- Modify: `server/terminal-metadata-service.ts`
- Modify: `server/agent-api/router.ts`
- Modify: `server/mcp/freshell-tool.ts`
- Modify: `docs/index.html` only if user-visible restore/status wording changed enough to require the mock to match

- [ ] **Step 1: Add or extend the failing consumer regression tests**

Cover:
- sidebar open-session matching uses canonical `sessionRef`
- tab fallback identity uses explicit `sessionRef` plus `resumeTarget`, not guessed strings
- metadata and activity do not regress when the durable target differs from an alias input
- clear restore-unavailable errors appear instead of silent fresh sessions

- [ ] **Step 2: Run the cross-cutting targeted tests and verify they fail**

Run: `npm run test:vitest -- test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx`

Expected: FAIL until all consumers stop using the old string semantics.

- [ ] **Step 3: Implement the remaining consumer cutover**

Finish all selector, sidebar, metadata, API, and MCP consumers so the repo consistently uses:
- `terminalId` for live reattach
- `resumeTarget` for recreate
- `sessionRef` for exact durable identity

- [ ] **Step 4: Re-run the cross-cutting targeted tests and verify they pass**

Run: `npm run test:vitest -- test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx test/e2e/sidebar-click-opens-pane.test.tsx test/e2e/pane-header-runtime-meta-flow.test.tsx`

Expected: PASS.

- [ ] **Step 5: Run final verification, refactor any weak spots, and keep going until green**

Run: `npm run lint`

Run: `npm run typecheck`

Run: `cross-env FRESHELL_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- test/integration/real/coding-cli-session-contract.test.ts`

Run: `npm run test:vitest -- test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts test/unit/server/coding-cli/codex-app-server/client.test.ts test/unit/server/coding-cli/codex-app-server/runtime.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/opencode-session-flow.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-opencode-activity.test.ts test/e2e/codex-refresh-rehydrate-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx`

Run: `FRESHELL_TEST_SUMMARY="exact durable session contract" npm test`

Expected: all PASS. If any valid check fails, continue improving the implementation and tests. Do not stop on partial green.

- [ ] **Step 6: Commit**

```bash
git add shared/session-contract.ts shared/ws-protocol.ts server/coding-cli/session-contract-controller.ts server/coding-cli/codex-app-server/sidecar.ts server/coding-cli/opencode-session-controller.ts server/coding-cli/alias-promotion-coordinator.ts server/index.ts server/ws-handler.ts server/terminal-registry.ts server/session-association-coordinator.ts server/session-association-updates.ts server/agent-api/router.ts server/terminal-metadata-service.ts server/mcp/freshell-tool.ts src/store/paneTypes.ts src/store/types.ts src/store/persistedState.ts src/store/persistMiddleware.ts src/store/tabsSlice.ts src/store/persistControl.ts src/lib/session-utils.ts src/lib/tab-registry-snapshot.ts src/lib/ui-commands.ts src/components/TerminalView.tsx src/components/Sidebar.tsx src/components/TabContent.tsx src/store/agentChatTypes.ts src/store/agentChatSlice.ts src/components/agent-chat/AgentChatView.tsx test/helpers/coding-cli/real-session-contract-harness.ts test/integration/real/coding-cli-session-contract.test.ts test/unit/shared/session-contract.test.ts test/unit/client/lib/session-contract.test.ts test/integration/server/codex-session-flow.test.ts test/integration/server/opencode-session-flow.test.ts test/server/session-association.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-opencode-activity.test.ts test/e2e/codex-refresh-rehydrate-flow.test.tsx test/e2e/open-tab-session-sidebar-visibility.test.tsx test/e2e/pane-activity-indicator-flow.test.tsx test/e2e/sidebar-busy-icon-flow.test.tsx docs/lab-notes/2026-04-19-coding-cli-session-contract.md package.json
git commit -m "refactor: cut coding cli sessions to exact durable contracts"
```

## Completion Checklist

- Fresh Codex sessions are started only by the Codex CLI itself over a terminal-owned app-server sidecar.
- Freshell never persists a fresh Codex `thread/started` id until the provider proves durability.
- Fresh Claude terminal sessions use Freshell-generated `--session-id` values and do not rely on same-cwd association.
- OpenCode durable promotion comes only from authoritative control data.
- `resumeTarget` is explicit and typed everywhere.
- `sessionRef` is the only canonical durable exact identity.
- Non-durable terminals fail clearly when the live terminal is gone and no recreate target exists.
- Real-provider probe tests and checked-in behavior docs match the implementation's assumptions.
- Focused targeted suites, lint, typecheck, and coordinated full `npm test` all pass.
