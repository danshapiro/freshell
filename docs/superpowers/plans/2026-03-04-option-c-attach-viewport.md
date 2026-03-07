# Option C Terminal Attach Viewport + Create/Attach Decoupling Implementation Plan

> Execution note: this branch is a one-shot protocol cutover. This document replaces the earlier phased compatibility plan and is the authoritative contract for review.

> **For Claude:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix terminal restore, remount, and reconnect scroll corruption by making replay impossible until the server has applied a concrete viewport, and by converging on a single explicit `create -> created -> attach` lifecycle.

**Architecture:** Ship a hard protocol cut. `terminal.create` only creates or resolves the terminal identity. `terminal.attach` is the only replay ingress and must carry `cols` and `rows` every time. Hidden panes defer their first attach until visible geometry is available. Reconnect follows the same explicit lifecycle: reconnect to the socket, wait for `ready`, then either resend the unresolved `terminal.create` or send a new `terminal.attach` for the known `terminalId`.

**Tech Stack:** TypeScript, React 18, xterm.js, Node/Express, WebSocket (`ws`), Zod protocol validation, Vitest (`vitest.server.config.ts` for server/node and `vitest.config.ts` for client/jsdom).

---

## Final Contract

- Mixed-version compatibility is intentionally not supported. This rollout requires a protocol version bump and rejects stale clients with `PROTOCOL_MISMATCH`.
- `terminal.create` returns exactly one `terminal.created` for a given `requestId`. It never auto-attaches, never replays output, and never emits `terminal.attach.ready`.
- `terminal.attach` is the only replay entrypoint.
- Every `terminal.attach` must include `cols` and `rows`.
- The server must call `registry.resize(terminalId, cols, rows)` before broker attach/replay for that generation.
- Hidden panes do not attach on `terminal.created`. They enter a deferred `waiting_for_geometry` state and send exactly one viewport attach when revealed.
- Reconnect behavior is deterministic after `ready`:
  - If `terminalId` is unknown for an in-flight create, resend the original `terminal.create` exactly once for that reconnect epoch.
  - If `terminalId` is known, send a fresh `terminal.attach` with viewport.
- Attach generations are identified by `attachRequestId`. While an attach generation is active, stale or untagged replay frames are ignored.
- Split capability negotiation is removed from this feature. `ready` does not advertise create/attach split flags, and `hello` does not send them.
- Stale out-of-contract fields are ignored by schema stripping. They are not part of the final contract.

---

## Non-Goals

- No phased rollout.
- No migration telemetry gate.
- No fallback path for viewport-less attach.
- No create-time replay compatibility for old browsers or old servers.

---

## File Structure Map

- Modify: `shared/ws-protocol.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/terminal-flaky-network-responsiveness.test.tsx`
- Modify: `test/e2e/terminal-settings-remount-scrollback.test.tsx`
- Create: `test/e2e/terminal-create-attach-ordering.test.tsx`

---

## Task 1: Cut the Protocol to Explicit-Only

**Files:**
- `shared/ws-protocol.ts`
- `server/ws-handler.ts`
- `server/terminal-stream/broker.ts`
- `test/server/ws-protocol.test.ts`
- `test/server/ws-edge-cases.test.ts`

- [ ] Bump `WS_PROTOCOL_VERSION` so stale browser bundles fail closed instead of hanging on missing legacy auto-attach.
- [ ] Require `cols` and `rows` on `terminal.attach`.
- [ ] Ensure `terminal.create` only emits `terminal.created`.
- [ ] Remove all create-time attach/replay helpers, including `sendCreatedAndAttach`.
- [ ] Remove `attachOnCreate` from the typed protocol and keep it out of the decision tree.
- [ ] Add or update protocol tests to prove:
  - `ready` carries no split capability negotiation for this feature.
  - protocol mismatch closes with `PROTOCOL_MISMATCH`.
  - `terminal.attach` without viewport is rejected.
  - `terminal.create` never emits `terminal.attach.ready`.

---

## Task 2: Make the Server Enforce Resize-Before-Replay Everywhere

**Files:**
- `server/ws-handler.ts`
- `server/terminal-stream/broker.ts`
- `test/server/ws-edge-cases.test.ts`
- `test/server/ws-terminal-stream-v2-replay.test.ts`
- `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- `test/server/ws-terminal-create-session-repair.test.ts`

- [ ] Reuse and idempotent `terminal.create` branches must still return `terminal.created` only.
- [ ] `terminal.attach` must resize before broker attach for both fresh and reused terminals.
- [ ] Duplicate `requestId` handling must remain idempotent with no duplicate replay churn.
- [ ] Reconnect/replay tests must prove ordering:
  - `resize -> terminal.attach.ready -> replay output`
  - the same ordering holds for reused/resumed terminals.

---

## Task 3: Rewrite the Client Around a Single Lifecycle

**Files:**
- `src/lib/ws-client.ts`
- `src/components/TerminalView.tsx`
- `test/unit/client/lib/ws-client.test.ts`
- `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] Remove lifecycle mode and split capability branching from `WsClient` and `TerminalView`.
- [ ] Queue `terminal.create` until `ready`; do not emit create before the handshake completes.
- [ ] Track unresolved creates by `requestId` so reconnect can resend them exactly once per reconnect epoch.
- [ ] On `terminal.created`, always take the explicit attach path:
  - visible pane: send `terminal.attach` immediately with measured viewport
  - hidden pane: enter deferred `waiting_for_geometry` and do not attach yet
- [ ] Replace boolean hydration flags with a single deferred attach state machine that captures:
  - `none`
  - `waiting_for_geometry`
  - `attaching`
  - `live`
- [ ] Gate replay by attach generation:
  - accept only current `attachRequestId`
  - drop stale generation frames
  - drop untagged frames while a generation is active
- [ ] Preserve reconnect semantics:
  - known `terminalId` reconnects via explicit attach
  - unknown `terminalId` reconnects via create resend

---

## Task 4: Add Coverage for the Final Contract

**Files:**
- `test/unit/client/lib/ws-client.test.ts`
- `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- `test/e2e/terminal-flaky-network-responsiveness.test.tsx`
- `test/e2e/terminal-settings-remount-scrollback.test.tsx`
- `test/e2e/terminal-create-attach-ordering.test.tsx`

- [ ] Add client unit coverage for:
  - pre-`ready` create queueing
  - reconnect resend of unresolved creates
  - clearing resend tracking on `terminal.created` or request-scoped error
- [ ] Add lifecycle coverage for:
  - `create -> created -> attach`
  - hidden `created` deferral until visibility
  - hidden reconnect preserving `viewport_hydrate` intent
  - stale and untagged frame rejection during active attach generations
- [ ] Add dedicated ordering e2e coverage in `terminal-create-attach-ordering.test.tsx` for:
  - fresh create ordering
  - hidden restore ordering
  - reconnect generation replacement
- [ ] Keep existing settings/remount and flaky-network suites aligned with the final explicit-only contract.

---

## Verification

Run server suites:

```bash
npx vitest run \
  test/server/ws-protocol.test.ts \
  test/server/ws-edge-cases.test.ts \
  test/server/ws-terminal-stream-v2-replay.test.ts \
  test/server/ws-terminal-create-reuse-running-claude.test.ts \
  test/server/ws-terminal-create-reuse-running-codex.test.ts \
  test/server/ws-terminal-create-session-repair.test.ts \
  --config vitest.server.config.ts
```

Run client/jsdom suites:

```bash
npx vitest run \
  test/unit/client/lib/ws-client.test.ts \
  test/unit/client/components/TerminalView.lifecycle.test.tsx \
  test/e2e/terminal-flaky-network-responsiveness.test.tsx \
  test/e2e/terminal-settings-remount-scrollback.test.tsx \
  test/e2e/terminal-create-attach-ordering.test.tsx \
  --config vitest.config.ts
```

Run full regression suite:

```bash
npm test
```

---

## Definition of Done

- [ ] `terminal.create` never auto-attaches or replays, including reuse and duplicate-request branches.
- [ ] `terminal.attach` is the only replay ingress and requires `cols` and `rows`.
- [ ] Server-side replay ordering is always `resize -> attach.ready -> output`.
- [ ] Client create flow is `ready -> create -> created -> attach`.
- [ ] Hidden panes never attach before they have concrete visible geometry.
- [ ] Reconnect never leaves a pane in `created-without-attach`.
- [ ] Reconnect with unknown `terminalId` resends create; reconnect with known `terminalId` sends attach.
- [ ] Stale or untagged replay frames from superseded attach generations are ignored.
- [ ] Dedicated ordering coverage exists for create, hidden reveal, and reconnect.
- [ ] Full `npm test` passes on the worktree branch.
