# Codex Thread Identity Invariant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new Freshell Codex panes resume the correct Codex thread by construction. A pane's canonical Codex `sessionRef` is the identity. Terminal ids, same-server live handles, tab/pane ids, and Codex durability records are evidence or plumbing, not pane identity.

**Architecture:** The implementation must make canonical identity authoritative at every place a stale terminal could be reused, replayed, written to, or rebound into a pane. When canonical identity is missing, Freshell must prefer a restore-unavailable/fresh-safe path over guessing. Resuming the wrong Codex thread is worse than refusing to resume.

**Tech Stack:** TypeScript, NodeNext/ESM, React 18, Redux Toolkit, WebSocket protocol schemas with Zod, Vitest, superwstest, Testing Library.

---

## Scope

This plan deliberately ignores heuristic recovery for already-corrupted historical panes. It does not add "latest Codex history", cwd/title/time matching, prompt-recency guessing, or a legacy resolver.

The fixed invariant for future sessions is:

- A Codex pane's expected identity is only a canonical `sessionRef` with `provider === "codex"` and a non-empty `sessionId`.
- `codexDurability` is restore evidence. It may help prove or resume a session, but it is not enough by itself to authorize attach/input/resize or live-terminal reuse for a pane.
- A `candidateThreadId` is never authoritative for user replay/input/resize. Candidate state can trigger proof or block input while proof runs, but cannot authorize side effects.
- A `liveTerminal` handle, `terminalId`, `serverInstanceId`, `tabId`, and `paneId` are never identity. They can be reused only after the server proves the live terminal's canonical identity matches the expected `sessionRef`.
- Mismatch is recoverable when the client has a canonical expected identity: clear stale runtime plumbing, keep `sessionRef`, bump `createRequestId`, and let the normal create effect restore that session.
- Mismatch is an error only when Freshell cannot determine a canonical target without guessing.

## Load-Bearing Review Findings

The load-bearing review falsified several assumptions in the first plan. The implementation must account for all of these facts:

- Candidate-only Codex identity is not safe for side effects. Current `restore-decision.ts` can return `proof_failed_attach_live_candidate`, and `ws-handler.ts` can then attach that live terminal even after proof fails.
- `TerminalRecord.mode`, `resumeSessionId`, and `codexDurability` are not a complete actual-identity authority by themselves. `buildTerminalSessionRef` already refuses Codex identity unless `resumeSessionId` and durable state agree, and the registry also has a binding authority.
- `terminal.attach`, `terminal.input`, and `terminal.resize` currently operate by `terminalId` only. `TerminalStreamBroker.attach` mutates attach/resize/replay state internally after an async lock.
- All `terminal.create` reuse returns currently funnel through `attachReusedTerminal`, which is the right central server gate. The request-id caches currently store only `requestId -> terminalId`, so the gate must validate cached reuse too.
- `restore-decision.ts` does not accept an arbitrary requested live terminal object. Requested live handle validation belongs in `ws-handler.ts` unless the decision API is intentionally redesigned.
- Client association and durability messages are currently accepted by `terminalId`. A stale `terminal.session.associated` can overwrite pane `sessionRef`, and stale `terminal.codex.durability.updated` can reintroduce stale durability.
- `TerminalView` has multiple outbound attach/input/resize send sites. `contentRef` is synchronized by effect, not guaranteed current during render, so send helpers should read current pane state from Redux or a deliberately updated ref boundary.
- Mismatch repair cannot just clear fields and send `terminal.create`. `terminal.created` is request-id gated, and the create effect reruns on `createRequestId`. Repair needs an explicit request-id-bumped transition.
- Pane content has no `liveTerminal` field. Persisted stale live plumbing is `terminalId`, `serverInstanceId`, and `streamId`; outbound `liveTerminal` is derived from those fields.
- REST/MCP/CLI paths are in scope. `/api/panes/:id/attach` can bind a pane to a caller-supplied terminal id, and `/api/panes/:id/send-keys` writes through `registry.input` without expected identity.
- Durability-store fallback by `terminalId` / `tabId` / `paneId` is not pane identity. It must not be used to choose a Codex session when the pane lacks canonical `sessionRef`.
- Tab-registry snapshots publish both `sessionRef` and `liveTerminal`; `TabsView` restores same-server `liveTerminal` without validating it against `sessionRef`. Cross-tab merge can reintroduce stale runtime fields unless hardened.

## File Structure

- Modify `shared/ws-protocol.ts`
  - Add optional `expectedSessionRef?: SessionLocator` to `terminal.attach`, `terminal.input`, and `terminal.resize`.
  - Add `SESSION_IDENTITY_MISMATCH` to `ErrorCode`.
  - Add optional `expectedSessionRef` and `actualSessionRef` to `ErrorMessage`.

- Create `server/terminal-session-identity.ts`
  - Central server helper for actual canonical identity.
  - Uses `buildTerminalSessionRef(record)` for canonical identity.
  - Does not treat Codex candidate identity as a side-effect authority.

- Modify `server/ws-handler.ts`
  - Validate identity before and during attach/input/resize operations.
  - Centralize create reuse authorization in `attachReusedTerminal`.
  - Reject or ignore stale live-terminal/request-id reuse when expected identity does not match.
  - Stop using durability-store fallback to infer a restore target when no canonical `sessionRef` exists.

- Modify `server/terminal-stream/broker.ts`
  - Accept an optional expected identity predicate/session ref for attach.
  - Re-check identity inside the broker terminal lock immediately before `registry.attach`, resize, and replay.

- Modify `server/terminal-registry.ts`
  - Add identity-aware `input` and `resize` variants or options.
  - Keep `buildTerminalSessionRef` as the canonical actual identity source for side effects.

- Modify `server/coding-cli/codex-app-server/restore-decision.ts`
  - Remove proof-failed live-candidate attach as an allowed restore result, or keep the type only for non-side-effect diagnostics. A failed proof must not attach/replay/write to a Codex terminal as a restored pane.

- Modify `server/agent-api/router.ts`
  - Enforce expected identity on `/api/panes/:id/attach` and `/api/panes/:id/send-keys`.
  - Allow terminal-id-only attach/send only for non-Codex terminals or for panes without canonical Codex identity, according to tests.

- Modify `server/mcp/freshell-tool.ts` and `server/cli/index.ts`
  - Pass `sessionRef`/expected identity through attach and send-keys when available.
  - Make Codex terminal attach by raw terminal id require matching identity or fail clearly.

- Modify `src/components/terminal-view-utils.ts`
  - Add helpers for expected identity, operation message construction, stale runtime clearing, and safe live-terminal inclusion.
  - Do not derive expected operation identity from `codexDurability` alone.

- Modify `src/components/TerminalView.tsx`
  - Use centralized helpers for every attach/input/resize send.
  - Guard stale association/durability broadcasts against existing canonical `sessionRef`.
  - Repair identity mismatch by bumping `createRequestId`, clearing `terminalId`/`serverInstanceId`/`streamId`, preserving `sessionRef`, and relying on the normal create effect.

- Modify `src/lib/terminal-session-association.ts` and `src/store/panesSlice.ts`
  - Refuse conflicting `terminal.session.associated` updates for panes that already have a different canonical `sessionRef`.
  - Provide an atomic reducer for Codex identity mismatch repair.

- Modify `src/components/TabsView.tsx` and cross-tab merge code in `src/store/panesSlice.ts`; inspect `src/lib/tab-registry-snapshot.ts` to preserve its output contract unless explicit server-validated live-handle proof metadata is added.
  - Preserve canonical `sessionRef` over live runtime fields.
  - Discard or quarantine same-server `liveTerminal` handles when they are paired with a canonical `sessionRef` that has not been server-validated.

- Add tests:
  - `test/unit/server/terminal-session-identity.test.ts`
  - `test/server/ws-terminal-codex-identity-invariant.test.ts`
  - `test/server/ws-terminal-create-reuse-running-codex.test.ts`
  - `test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts`
  - `test/server/agent-codex-identity-invariant.test.ts`
  - `test/unit/client/components/terminal-view-utils.test.ts`
  - `test/unit/client/components/TerminalView.codex-identity.test.tsx`
  - `test/unit/client/lib/terminal-session-association.test.ts`
  - `test/unit/client/store/panesSlice.test.ts`
  - `test/unit/client/store/crossTabSync.test.ts`
  - `test/unit/client/components/TabsView.test.tsx`
  - `test/e2e/tabs-view-flow.test.tsx`
  - `test/e2e/codex-wrong-thread-resume.test.tsx`

## Identity Rule

Use this rule for side-effecting operations:

```ts
import type { SessionLocator } from '../shared/ws-protocol.js'

function canonicalActualSessionRef(record: TerminalRecord): SessionLocator | undefined {
  return buildTerminalSessionRef(record)
}

function terminalMatchesExpectedSession(
  record: TerminalRecord,
  expectedSessionRef: SessionLocator | undefined,
): boolean {
  if (!expectedSessionRef) return true
  const actual = canonicalActualSessionRef(record)
  return actual?.provider === expectedSessionRef.provider
    && actual.sessionId === expectedSessionRef.sessionId
}
```

Do not add candidate acceptance here. Candidate state is pre-proof evidence and can only trigger proof/recovery/blocking behavior.

Durability-only behavior:

- `codexDurability.state === "durable"` can be used by create/restore code as proof evidence when a pane already has matching canonical `sessionRef`, or to promote an association when proof is server-owned.
- A pane without canonical `sessionRef` is not restored from durability fallback for this future-facing invariant. It follows restore-unavailable/fresh-safe behavior.

## Task 1: Define Canonical Server Identity

**Files:**
- Create: `server/terminal-session-identity.ts`
- Test: `test/unit/server/terminal-session-identity.test.ts`

- [ ] **Step 1: Write failing unit tests**

Cover these cases:

- Missing expected identity returns match for backwards-compatible non-Codex paths.
- Codex durable identity matches only when `buildTerminalSessionRef(record)` returns the same `{ provider: "codex", sessionId }`.
- Codex candidate-only durability does not match expected identity for side effects.
- Codex durable state with a mismatched `resumeSessionId` does not match.
- Provider mismatch fails.
- A helper such as `buildSessionIdentityMismatchDetails(record, expectedSessionRef)` returns the mismatch payload fields: `expectedSessionRef` and `actualSessionRef` when `buildTerminalSessionRef(record)` can prove an actual canonical identity.

- [ ] **Step 2: Run failing test**

```bash
npm run test:vitest -- test/unit/server/terminal-session-identity.test.ts --run
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement helper**

The helper must call `buildTerminalSessionRef(record)` rather than duplicating Codex candidate/durability rules. That keeps side-effect identity aligned with the registry's canonical binding behavior. Export a concrete mismatch-detail builder from this module so `ws-handler.ts`, broker, and REST paths do not each hand-roll expected/actual payload construction.

- [ ] **Step 4: Run tests**

```bash
npm run test:vitest -- test/unit/server/terminal-session-identity.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/terminal-session-identity.ts test/unit/server/terminal-session-identity.test.ts
git commit -m "test: define canonical terminal session identity"
```

## Task 2: Add Expected Identity To WebSocket Protocol

**Files:**
- Modify: `shared/ws-protocol.ts`
- Test: `test/server/ws-protocol.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Add schema tests proving `terminal.attach`, `terminal.input`, and `terminal.resize` parse and preserve:

```ts
expectedSessionRef: { provider: 'codex', sessionId: 'thread-1' }
```

The assertion must inspect the parsed result, not only `safeParse().success`, because the current non-strict Zod object schemas silently strip unknown keys. Add a protocol enum test proving `ErrorCode` accepts `SESSION_IDENTITY_MISMATCH`. Do not add a tautological runtime test for the `ErrorMessage` TypeScript type; Task 3 proves the server actually emits the mismatch fields.

- [ ] **Step 2: Run failing protocol tests**

```bash
npm run test:vitest -- test/server/ws-protocol.test.ts --run
```

Expected: FAIL because parsed attach/input/resize messages do not retain `expectedSessionRef`, and the error enum lacks `SESSION_IDENTITY_MISMATCH`.

- [ ] **Step 3: Extend schemas**

Add `expectedSessionRef: SessionLocatorSchema.optional()` to attach/input/resize. Add `SESSION_IDENTITY_MISMATCH` to `ErrorCode`. Extend `ErrorMessage` with optional `expectedSessionRef` and `actualSessionRef`.

- [ ] **Step 4: Run protocol tests**

```bash
npm run test:vitest -- test/server/ws-protocol.test.ts --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/ws-protocol.ts test/server/ws-protocol.test.ts
git commit -m "feat: carry expected session identity on terminal operations"
```

## Task 3: Enforce Identity At Side-Effect Boundaries

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/terminal-registry.ts`
- Test: `test/server/ws-terminal-codex-identity-invariant.test.ts`

- [ ] **Step 1: Write failing server tests**

Test all three side effects:

- `terminal.attach` with expected `thread-new` against live Codex `thread-old` returns `SESSION_IDENTITY_MISMATCH` and does not send `terminal.attach.ready` or replay old output.
- `terminal.input` with expected `thread-new` against live Codex `thread-old` returns `SESSION_IDENTITY_MISMATCH` and does not call `pty.write`.
- `terminal.resize` with expected `thread-new` against live Codex `thread-old` returns `SESSION_IDENTITY_MISMATCH` and does not resize.

Also test candidate-only Codex durability:

- A terminal with `codexDurability.state === "captured_pre_turn"` and matching candidate id must not satisfy expected identity for attach/input/resize.

- [ ] **Step 2: Run failing tests**

```bash
npm run test:vitest -- test/server/ws-terminal-codex-identity-invariant.test.ts --run
```

Expected: FAIL because operations currently use `terminalId` only.

- [ ] **Step 3: Implement identity mismatch responses**

Add a single server mismatch builder. Log a structured lifecycle event with:

- operation
- terminalId
- expected provider/session id
- actual provider/session id when available

The server must return `SESSION_IDENTITY_MISMATCH` before replay/write/resize.

- [ ] **Step 4: Re-check inside side-effect owners**

Do not rely only on a pre-call check in `ws-handler.ts`.

- `TerminalStreamBroker.attach` must accept expected identity or a predicate and evaluate it inside the terminal lock immediately before `registry.attach`, before resize, and before replay.
- `TerminalRegistry.input` must accept expected identity or expose `inputIfSessionMatches`.
- `TerminalRegistry.resize` must accept expected identity or expose `resizeIfSessionMatches`.

- [ ] **Step 5: Run focused tests**

```bash
npm run test:vitest -- test/server/ws-terminal-codex-identity-invariant.test.ts --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts server/terminal-stream/broker.ts server/terminal-registry.ts server/terminal-session-identity.ts test/server/ws-terminal-codex-identity-invariant.test.ts
git commit -m "fix: enforce session identity at terminal side effects"
```

## Task 4: Make Create Reuse Identity-Gated

**Files:**
- Modify: `server/ws-handler.ts`
- Modify: `server/coding-cli/codex-app-server/restore-decision.ts`
- Test: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Test: `test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts`

- [ ] **Step 1: Write failing create/reuse tests**

Cover these branches:

- Requested `liveTerminal` for `thread-old` with `sessionRef` `thread-new` is ignored. Create/restore targets `thread-new`.
- Cached request-id reuse for `thread-old` with current request `sessionRef` `thread-new` is rejected or ignored, not returned.
- Canonical running-terminal reuse for matching `thread-new` still works.
- Same-server live handle without `sessionRef` does not invent Codex identity.

- [ ] **Step 2: Write failing restore-decision tests**

Update the restore-decision tests to match the real API boundary:

- `resolveCodexCreateRestoreDecision` accepts `findLiveTerminalByCandidate`, not an arbitrary requested live terminal.
- Proof failure must not return a side-effecting `proof_failed_attach_live_candidate` decision. It should return `proof_failed_fresh_create` or another non-side-effect result.
- Proof success can return a live terminal only after proof promotes the durable session id.

- [ ] **Step 3: Run failing tests**

```bash
npm run test:vitest -- \
  test/server/ws-terminal-create-reuse-running-codex.test.ts \
  test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts \
  --run
```

Expected: FAIL on stale live/cached reuse and proof-failed live candidate behavior.

- [ ] **Step 4: Centralize create reuse authorization**

Make `attachReusedTerminal(record)` the one identity gate for every reuse branch, including:

- existing request-id cache
- existing-after-config request-id cache
- requested live terminal
- proof-promoted live terminal
- canonical running terminal by session

`attachReusedTerminal` must receive the current expected `sessionRef` and refuse mismatched records before sending `terminal.created` or remembering `requestId -> terminalId`.

- [ ] **Step 5: Fix request-id idempotency**

Store or validate an identity fingerprint with created request ids:

```ts
type CreatedTerminalRequestBinding = {
  terminalId: string
  expectedSessionKey?: string
}
```

If the same request id is later used with a different expected session key, do not return the cached terminal.

- [ ] **Step 6: Remove unsafe durability fallback**

When Codex `restore === true` and there is no canonical `sessionRef`, do not read durability by `terminalId`/`tabId`/`paneId` to pick a thread. Return restore unavailable. Keep durability proof only when it is already tied to the pane's canonical `sessionRef`.

- [ ] **Step 7: Run focused tests**

```bash
npm run test:vitest -- \
  test/server/ws-terminal-create-reuse-running-codex.test.ts \
  test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts \
  --run
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/ws-handler.ts server/coding-cli/codex-app-server/restore-decision.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts
git commit -m "fix: gate Codex create reuse by canonical identity"
```

## Task 5: Cover REST, MCP, And CLI Terminal Paths

**Files:**
- Modify: `server/agent-api/router.ts`
- Modify: `server/mcp/freshell-tool.ts`
- Modify: `server/cli/index.ts`
- Test: `test/server/agent-codex-identity-invariant.test.ts`
- Extend: `test/server/agent-panes-write.test.ts`
- Extend: `test/server/agent-send-keys.test.ts`

- [ ] **Step 1: Write failing API tests**

Cover:

- `/api/panes/:id/attach` cannot attach a Codex terminal whose canonical identity differs from the pane's existing `sessionRef`.
- `/api/panes/:id/send-keys` cannot write to a Codex terminal when the pane has a conflicting canonical `sessionRef`.
- Existing shell/non-Codex attach/send behavior remains unchanged.
- MCP `attach` and CLI `attach` pass enough expected identity or receive the same server-side rejection.

- [ ] **Step 2: Run failing tests**

```bash
npm run test:vitest -- \
  test/server/agent-codex-identity-invariant.test.ts \
  test/server/agent-panes-write.test.ts \
  test/server/agent-send-keys.test.ts \
  --run
```

Expected: FAIL because attach/send-keys currently operate by terminal id.

- [ ] **Step 3: Implement API identity enforcement**

In `server/agent-api/router.ts`:

- Resolve pane content before attach/send.
- If pane has canonical Codex `sessionRef`, require target terminal actual identity to match before attach/send.
- If request includes `sessionRef`, validate it against the target terminal and preserve it in pane content.
- If pane has no canonical Codex `sessionRef`, do not infer one from `codexDurability` or terminal id.

In MCP and CLI:

- Include `sessionRef` where the tool can derive it from pane/session context.
- Surface `SESSION_IDENTITY_MISMATCH` as an actionable error.

- [ ] **Step 4: Run focused tests**

```bash
npm run test:vitest -- \
  test/server/agent-codex-identity-invariant.test.ts \
  test/server/agent-panes-write.test.ts \
  test/server/agent-send-keys.test.ts \
  --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/agent-api/router.ts server/mcp/freshell-tool.ts server/cli/index.ts test/server/agent-codex-identity-invariant.test.ts test/server/agent-panes-write.test.ts test/server/agent-send-keys.test.ts
git commit -m "fix: enforce Codex identity on agent terminal APIs"
```

## Task 6: Centralize Client Operation Sends

**Files:**
- Modify: `src/components/terminal-view-utils.ts`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/terminal-view-utils.test.ts`
- Test: `test/unit/client/components/TerminalView.codex-identity.test.tsx`

- [ ] **Step 1: Write failing helper tests**

Add helpers that:

- Return expected operation identity only from canonical `content.sessionRef`.
- Return `undefined` for Codex durability-only content.
- Include outbound `liveTerminal` only when no canonical `sessionRef` exists, or when the caller explicitly allows a live handle after server validation.
- Build attach/input/resize payloads with `expectedSessionRef` whenever canonical identity exists.
- Update the existing `getCreateSessionStateFromRef` expectation that currently returns both `sessionRef` and `liveTerminal`; the new assertion must prove a canonical `sessionRef` suppresses unproven outbound `liveTerminal`.

- [ ] **Step 2: Run failing helper tests**

```bash
npm run test:vitest -- test/unit/client/components/terminal-view-utils.test.ts --run
```

Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Implement helper**

Do not derive expected identity from `codexDurability`.

```ts
export function getExpectedSessionRefForTerminalOperation(
  content: TerminalPaneContent | null | undefined,
): SessionLocator | undefined {
  return content?.sessionRef
}
```

Keep the provider generic, but tests must pin Codex behavior.

- [ ] **Step 4: Replace TerminalView call sites**

Every TerminalView operation send must use the central helper:

- `sendInput`
- Shift+Enter direct input
- resize send
- attach send

The current TerminalView send sites to cover are the input helper, resize, direct Shift+Enter input, and attach. Keep firewall setup input outside TerminalView either intentionally exempted in tests or covered separately.

- [ ] **Step 5: Write TerminalView outbound tests**

Test:

- attach includes expected Codex `sessionRef`
- normal input includes expected Codex `sessionRef`
- Shift+Enter input includes expected Codex `sessionRef`
- resize includes expected Codex `sessionRef`
- durability-only Codex content does not send expected identity and does not send a guessed session id

- [ ] **Step 6: Run client tests**

```bash
npm run test:vitest -- \
  test/unit/client/components/terminal-view-utils.test.ts \
  test/unit/client/components/TerminalView.codex-identity.test.tsx \
  --run
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/terminal-view-utils.ts src/components/TerminalView.tsx test/unit/client/components/terminal-view-utils.test.ts test/unit/client/components/TerminalView.codex-identity.test.tsx
git commit -m "feat: send canonical session identity with terminal operations"
```

## Task 7: Guard Client Association And Durability Broadcasts

**Files:**
- Modify: `src/lib/terminal-session-association.ts`
- Modify: `src/store/panesSlice.ts`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/lib/terminal-session-association.test.ts`
- Test: `test/unit/client/components/TerminalView.codex-identity.test.tsx`

- [ ] **Step 1: Write failing association tests**

Cover:

- Existing pane `sessionRef: thread-new` plus `terminal.session.associated` for same terminal id but `thread-old` must not overwrite the pane.
- Matching association still persists canonical identity and clears raw `resumeSessionId`.
- Conflicting association returns a clear status so callers can repair or ignore it.

- [ ] **Step 2: Write failing durability broadcast tests**

Cover:

- Existing pane `sessionRef: thread-new` plus durability update for `thread-old` is ignored and does not update pane or tab durability.
- Matching durable update is preserved.
- Candidate-only update is persisted only as evidence when no canonical sessionRef exists, and never changes expected operation identity.

- [ ] **Step 3: Run failing tests**

```bash
npm run test:vitest -- \
  test/unit/client/lib/terminal-session-association.test.ts \
  test/unit/client/components/TerminalView.codex-identity.test.tsx \
  --run
```

Expected: FAIL because association/durability currently reconcile by terminal id.

- [ ] **Step 4: Implement guards**

`reconcileTerminalSessionAssociation` must refuse a conflicting update when matched pane content already has a different canonical `sessionRef`.

`TerminalView` durability handling must compare durability durable/candidate ids against existing `sessionRef`:

- durable id matches sessionRef: accept
- candidate id matches sessionRef but state is not durable: store only if needed, but do not treat as expected identity
- durable/candidate conflicts with sessionRef: ignore, log structured warning, and do not send candidate persisted ack

- [ ] **Step 5: Run focused tests**

```bash
npm run test:vitest -- \
  test/unit/client/lib/terminal-session-association.test.ts \
  test/unit/client/components/TerminalView.codex-identity.test.tsx \
  --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/terminal-session-association.ts src/store/panesSlice.ts src/components/TerminalView.tsx test/unit/client/lib/terminal-session-association.test.ts test/unit/client/components/TerminalView.codex-identity.test.tsx
git commit -m "fix: ignore stale Codex identity broadcasts"
```

## Task 8: Repair Stale Runtime Plumbing With A Request-Id Transition

**Files:**
- Modify: `src/store/panesSlice.ts`
- Modify: `src/components/TerminalView.tsx`
- Test: `test/unit/client/components/TerminalView.codex-identity.test.tsx`

- [ ] **Step 1: Write failing repair tests**

Cover:

- On `SESSION_IDENTITY_MISMATCH`, pane keeps `sessionRef: thread-new`.
- Pane clears `terminalId`, `serverInstanceId`, and `streamId`.
- Pane receives a new `createRequestId`.
- Pane status becomes `creating`.
- The next `terminal.create` sent by the normal create effect includes `restore: true` and `sessionRef: thread-new`.
- Duplicate mismatch errors for the same stale terminal id do not create multiple competing request ids.

- [ ] **Step 2: Run failing tests**

```bash
npm run test:vitest -- \
  test/unit/client/components/TerminalView.codex-identity.test.tsx \
  --run
```

Expected: FAIL because mismatch repair does not exist.

- [ ] **Step 3: Add atomic reducer**

Add a reducer such as:

```ts
repairCodexIdentityMismatch({
  tabId,
  paneId,
  staleTerminalId,
  expectedSessionRef,
  createRequestId,
})
```

It must:

- no-op if pane no longer has `staleTerminalId`
- no-op if pane has a different canonical `sessionRef`
- clear runtime plumbing: `terminalId`, `serverInstanceId`, `streamId`
- preserve `sessionRef`
- preserve matching durable `codexDurability` only when it is durable and matches sessionRef
- set `createRequestId`
- set status `creating`

- [ ] **Step 4: Wire TerminalView to reducer**

On `SESSION_IDENTITY_MISMATCH`:

- validate `msg.expectedSessionRef`
- confirm the pane still owns `staleTerminalId` and has no repair already pending for that stale terminal; if the check fails, return before creating a new request id
- generate new request id only after the guard passes
- mark it as restore via `addTerminalRestoreRequestId(newRequestId)`
- clear terminal refs/checkpoints for the stale terminal
- dispatch reducer
- update `requestIdRef.current` only after dispatching a repair that still applies
- do not manually call `sendCreate`; let the create effect run from `createRequestId`

- [ ] **Step 5: Run focused tests**

```bash
npm run test:vitest -- \
  test/unit/client/components/TerminalView.codex-identity.test.tsx \
  --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/panesSlice.ts src/components/TerminalView.tsx test/unit/client/components/TerminalView.codex-identity.test.tsx
git commit -m "fix: repair stale Codex runtime plumbing"
```

## Task 9: Harden Tab Registry And Cross-Tab Sync

**Files:**
- Inspect: `src/lib/tab-registry-snapshot.ts`
- Modify: `src/components/TabsView.tsx`
- Modify: `src/store/panesSlice.ts`
- Test: `test/unit/client/store/panesSlice.test.ts`
- Test: `test/unit/client/components/TabsView.test.tsx`
- Test: `test/unit/client/store/crossTabSync.test.ts`
- Test: `test/e2e/tabs-view-flow.test.tsx`

- [ ] **Step 1: Write failing tab-registry tests**

Cover:

- A registry record with `sessionRef: thread-new` and same-server `liveTerminal: term-old` does not hydrate `terminalId: term-old` unless the live handle is proven/declared matching.
- A registry record without `sessionRef` may still use liveTerminal for non-Codex live-only behavior.
- `tab-registry-snapshot` still publishes `liveTerminal` for UI discovery, but consumers treat it as runtime plumbing.
- Update the existing `tabs-view-flow` case `opens same-server tab copies with an explicit live terminal handle` so a copied pane with canonical `sessionRef` does not copy `terminalId` from an unproven same-server `liveTerminal`; it should rely on canonical restore/create instead.

- [ ] **Step 2: Write failing cross-tab tests**

Cover:

- Incoming pane content cannot overwrite local canonical `sessionRef` with a different `sessionRef`.
- Incoming `terminalId`/`serverInstanceId`/`streamId` are discarded when they conflict with local canonical Codex `sessionRef`.
- Matching canonical session can still merge safe non-runtime fields.

- [ ] **Step 3: Run failing tests**

```bash
npm run test:vitest -- \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/store/crossTabSync.test.ts \
  test/e2e/tabs-view-flow.test.tsx \
  --run
```

Expected: FAIL because same-server live handles and cross-tab merge currently allow stale runtime fields.

- [ ] **Step 4: Implement sync hardening**

In `TabsView`:

- If sanitized payload has canonical `sessionRef`, do not hydrate `terminalId` from `liveTerminal` unless there is a server-validated matching proof in the record. If no such proof exists, leave `terminalId` undefined and let create/restore target the sessionRef.

In cross-tab merge:

- canonical `sessionRef` wins over incoming runtime fields
- conflicting runtime fields are dropped
- `codexDurability` is retained only when it matches canonical `sessionRef`

- [ ] **Step 5: Run focused tests**

```bash
npm run test:vitest -- \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/store/crossTabSync.test.ts \
  test/e2e/tabs-view-flow.test.tsx \
  --run
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/TabsView.tsx src/store/panesSlice.ts test/unit/client/store/panesSlice.test.ts test/unit/client/components/TabsView.test.tsx test/unit/client/store/crossTabSync.test.ts test/e2e/tabs-view-flow.test.tsx
git commit -m "fix: keep canonical Codex identity across tab sync"
```

## Task 10: Incident-Shaped End-To-End Regression

**Files:**
- Create: `test/e2e/codex-wrong-thread-resume.test.tsx`

- [ ] **Step 1: Write the regression**

Model the incident:

- Pane has canonical `sessionRef: thread-new`.
- Pane has stale runtime plumbing `terminalId: term-old`, `serverInstanceId`, and `streamId`.
- Client first tries attach/input with `expectedSessionRef: thread-new`.
- Server emits `SESSION_IDENTITY_MISMATCH` with actual `thread-old`.
- Client clears stale runtime plumbing, bumps `createRequestId`, and sends restore create for `thread-new`.
- Test asserts no input goes to `term-old` after mismatch.

Use the existing component-level e2e style in `test/e2e/terminal-restart-recovery.test.tsx`.

- [ ] **Step 2: Run failing e2e**

```bash
FRESHELL_TEST_SUMMARY="codex wrong-thread resume e2e" npm run test:vitest -- test/e2e/codex-wrong-thread-resume.test.tsx --run
```

Expected: FAIL before the implementation tasks are complete.

- [ ] **Step 3: Run passing e2e**

After Tasks 1-9:

```bash
FRESHELL_TEST_SUMMARY="codex wrong-thread resume e2e" npm run test:vitest -- test/e2e/codex-wrong-thread-resume.test.tsx --run
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/codex-wrong-thread-resume.test.tsx
git commit -m "test: cover Codex wrong-thread resume regression"
```

## Task 11: Full Verification

**Files:**
- No production file changes unless verification exposes failures.

- [ ] **Step 1: Run status check**

```bash
npm run test:status
```

Expected: coordinator is idle or shows a reusable green baseline. If another agent holds the broad gate, wait rather than killing it.

- [ ] **Step 2: Run focused suites**

```bash
FRESHELL_TEST_SUMMARY="codex identity focused server" npm run test:vitest -- \
  test/unit/server/terminal-session-identity.test.ts \
  test/server/ws-protocol.test.ts \
  test/server/ws-terminal-codex-identity-invariant.test.ts \
  test/server/ws-terminal-create-reuse-running-codex.test.ts \
  test/unit/server/coding-cli/codex-app-server/restore-decision.test.ts \
  test/server/agent-codex-identity-invariant.test.ts \
  --run
```

```bash
FRESHELL_TEST_SUMMARY="codex identity focused client" npm run test:vitest -- \
  test/unit/client/components/terminal-view-utils.test.ts \
  test/unit/client/components/TerminalView.codex-identity.test.tsx \
  test/unit/client/lib/terminal-session-association.test.ts \
  test/unit/client/store/panesSlice.test.ts \
  test/unit/client/components/TabsView.test.tsx \
  test/unit/client/store/crossTabSync.test.ts \
  test/e2e/tabs-view-flow.test.tsx \
  test/e2e/codex-wrong-thread-resume.test.tsx \
  --run
```

Keep server-owned and default-owned targets in separate invocations. The coordinated `test:vitest` passthrough routes mixed ownership through the default config, which excludes `test/server/**` and `test/unit/server/**`.

Expected: PASS.

- [ ] **Step 3: Run repo check**

```bash
FRESHELL_TEST_SUMMARY="codex thread identity invariant final check" npm run check
```

Expected: PASS.

- [ ] **Step 4: Inspect git diff**

```bash
git status --short
git diff --stat
```

Expected: only files listed in this plan are changed.

- [ ] **Step 5: Final commit if verification caused changes**

```bash
git add shared/ws-protocol.ts server src test
git commit -m "fix: enforce Codex thread identity invariant"
```

## Self-Review

- Spec coverage: The revised plan no longer relies on candidate-only identity, durability-only identity, same-server live handles, request-id cache identity, or terminal id as proof.
- Load-bearing fixes: Every falsified load-bearing assumption now changes a task: side-effect gates move inside operation owners, create reuse is centralized, REST/MCP/CLI paths are in scope, broadcasts are identity-aware, and tab-registry/cross-tab sync drops stale runtime fields.
- Non-legacy approach: The plan still ignores heuristic recovery. When canonical `sessionRef` is absent, Freshell refuses to guess.
- Test shape: Tests protect the incident behavior directly: input/replay must not reach the old thread, stale runtime plumbing must be cleared, and restore/create must target the expected Codex `sessionRef`.
- PR callout: Removing `proof_failed_attach_live_candidate` intentionally reduces Codex live-terminal reuse when rollout proof fails, because resuming the wrong thread is worse than a fresh/restore-unavailable path. Omitting unproven outbound `liveTerminal` when canonical `sessionRef` exists also disables the same-server live-handle fast path across providers; reuse should happen through server-side canonical lookup instead. The eventual PR description should make both behavior changes explicit.
- Known implementation adjustment: Helper and fixture names must follow the repo's existing test harnesses. Preserve the behavior and assertion shape when adapting names.
