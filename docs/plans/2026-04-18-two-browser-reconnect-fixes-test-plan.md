# Test Plan: Two-Browser Reconnect Fixes

> **Companion to:** `docs/plans/2026-04-18-two-browser-reconnect-fixes.md`
> **Primary sources of truth:** user request in the trycycle transcript, confirmed findings from the reconnect audit, and the implementation plan sections `User-Visible Target` and `Contracts And Invariants`

## Strategy Reconciliation

The testing strategy still holds as written. The implementation plan keeps the same interaction surface the audit identified: `sdk.create` reconnect/idempotence, restore-ledger-backed resume aliasing, `terminal.attach` reconnect semantics, WebSocket protocol negotiation, and true two-page browser recovery. No extra infrastructure, paid API access, or scope increase is required.

The only adjustment is prioritization: the strongest acceptance check remains the real two-page Playwright flow, but the first red checks should be the existing client and server harnesses where the regressions are mechanically created. That keeps TDD honest and makes the final browser pass diagnostic rather than exploratory.

## Harness Requirements

No new harnesses need to be built. The existing harnesses already expose the required user-visible surfaces and failure signals.

`test/unit/client/lib/ws-client.test.ts` mock WebSocket harness
What it does: simulates open, ready, close, reconnect, and raw server messages against the real `WsClient`.
What it exposes: outbound wire payloads, reconnect epochs, request tracking behavior.
Estimated complexity to build: none.
Tests that depend on it: 1, 2.

`test/unit/server/ws-handler-sdk.test.ts` real `WsHandler` + mocked `SdkBridge` / `AgentHistorySource` harness
What it does: drives authenticated browser WebSocket messages through the real server handler while inspecting live session creation, replay, and teardown behavior.
What it exposes: real message ordering, bridge call counts, shared session reuse, restore resolution, follower-failure cleanup.
Estimated complexity to build: none.
Tests that depend on it: 3, 4, 5, 6, 7.

`test/e2e/agent-chat-restore-flow.test.tsx` Redux + React Testing Library restore harness
What it does: renders a real agent-chat pane against store state and SDK message handling.
What it exposes: pane binding, reconnect resend behavior, visible restored content, retry-loop absence.
Estimated complexity to build: none.
Tests that depend on it: 8.

`test/unit/client/components/TerminalView.lifecycle.test.tsx` and `test/e2e/*.tsx` terminal lifecycle harnesses
What they do: render real `TerminalView` instances with captured WS sends and reconnect triggers.
What they expose: outbound `terminal.attach` payloads, attach request IDs, attach sequencing across visible, hidden, remount, and reconnect flows.
Estimated complexity to build: none.
Tests that depend on it: 10, 11.

`test/server/ws-protocol.test.ts`, `test/server/ws-edge-cases.test.ts`, `test/unit/server/ws-handler-backpressure.test.ts`, and `test/server/ws-terminal-stream-v2-replay.test.ts` real-protocol server harnesses
What they do: validate the shared WS schema and broker behavior through authenticated WebSocket sessions and fake terminal registries.
What they expose: handshake rejection codes, attach validation, resize calls, replay ordering, duplicate-attach behavior.
Estimated complexity to build: none.
Tests that depend on it: 9, 11, 12.

`test/e2e-browser/helpers/test-harness.ts` and `test/e2e-browser/helpers/terminal-helpers.ts` Playwright multi-page harness
What they do: drive the production-built browser UI in Chromium and inspect terminal buffers plus outbound WS transcripts through `window.__FRESHELL_TEST_HARNESS__`.
What they expose: per-page terminal output, forced disconnects, reconnect readiness, sent WS message logs, Redux state, real viewport control.
Estimated complexity to build: none.
Tests that depend on it: 13.

## Test Plan

1. **Name:** Reconnect resends one in-flight `sdk.create` until `sdk.created` arrives
   **Type:** regression
   **Disposition:** extend
   **Harness:** `test/unit/client/lib/ws-client.test.ts` mock WebSocket harness
   **Preconditions:** A `WsClient` has queued or sent `sdk.create { requestId }`; the server has not yet replied with `sdk.created`.
   **Actions:** Connect, send `sdk.create`, force a transport close after ready, reconnect, emit `ready`, and inspect the second socket's outbound frames.
   **Expected outcome:** Per `Contracts And Invariants §1` and `User-Visible Target` bullet 3, the client resends the same `sdk.create` exactly once for the new reconnect epoch, keeps the original `requestId`, and does not emit a second synthetic request. Proof is the outbound wire transcript, not internal state.
   **Interactions:** Client reconnect queueing, outbound create tracking, WebSocket ready handshake.

2. **Name:** `sdk.create.failed` clears reconnect resend tracking for the failed request
   **Type:** regression
   **Disposition:** extend
   **Harness:** `test/unit/client/lib/ws-client.test.ts` mock WebSocket harness
   **Preconditions:** A `WsClient` has an in-flight `sdk.create { requestId }` and receives `sdk.create.failed` for that request before a reconnect.
   **Actions:** Connect, send `sdk.create`, deliver `sdk.create.failed`, force reconnect, emit `ready`, and inspect the next socket's outbound frames.
   **Expected outcome:** Per `Contracts And Invariants §1`, a failed create must clear request-scoped in-flight state; no resend for that `requestId` appears after reconnect. The source of truth is the request-scoped failure cleanup contract.
   **Interactions:** Client error handling, reconnect queue eviction, request-scoped message correlation.

3. **Name:** Two browsers resuming the same durable agent history converge on one live SDK session
   **Type:** integration
   **Disposition:** extend
   **Harness:** `test/unit/server/ws-handler-sdk.test.ts` real `WsHandler` + mocked `SdkBridge` / `AgentHistorySource`
   **Preconditions:** Two authenticated sockets issue concurrent `sdk.create` calls with the same `resumeSessionId`; `AgentHistorySource.resolve` identifies one durable timeline.
   **Actions:** Send both `sdk.create` messages before the first session becomes observable through ordinary `sdk.session.init` or later ledger sync.
   **Expected outcome:** Per `User-Visible Target` bullets 1 and 2 and `Contracts And Invariants §1`, both callers receive the same live `sessionId`, `mockSdkBridge.createSession` is called once, and no second session is fabricated during the pre-init window.
   **Interactions:** Server create locking, restore identity resolution, live owner cache, bridge session allocation.

4. **Name:** Different stale and canonical resume aliases for the same history still reuse one live SDK session
   **Type:** regression
   **Disposition:** extend
   **Harness:** `test/unit/server/ws-handler-sdk.test.ts` real `WsHandler` + mocked `SdkBridge` / `AgentHistorySource`
   **Preconditions:** Two authenticated sockets send concurrent `sdk.create` requests whose `resumeSessionId` values differ, but `AgentHistorySource.resolve` maps both to the same durable history.
   **Actions:** Deliver both create messages before the first live session emits `sdk.session.init`.
   **Expected outcome:** Per audit finding 2 and `Contracts And Invariants §§1-2`, alias-normalized creates serialize onto one owner key, `createSession` runs once, and both callers bind to the same session. User-visible proof is the shared `sessionId` and ordered SDK lifecycle frames to both clients.
   **Interactions:** Restore ledger alias normalization, owner-key cache, concurrent socket handling.

5. **Name:** Reconnecting a fresh `sdk.create` request reuses the first created live session instead of forking
   **Type:** regression
   **Disposition:** extend
   **Harness:** `test/unit/server/ws-handler-sdk.test.ts` real `WsHandler` + mocked `SdkBridge` / `AgentHistorySource`
   **Preconditions:** A fresh `sdk.create` without `resumeSessionId` has already allocated a live session for `requestId`, and the same request is resent after reconnect.
   **Actions:** Send the original `sdk.create`, simulate reconnect-style duplicate delivery of the same `requestId`, and observe the server responses.
   **Expected outcome:** Per `Contracts And Invariants §1`, request-scoped duplicates reuse the original live session, `createSession` remains single-call, and both callers observe the same `sessionId`.
   **Interactions:** Request ID cache, reconnect resend handling, duplicate create dedupe.

6. **Name:** Reused `sdk.create` preserves the same public restore sequence and interactive state as a fresh create
   **Type:** integration
   **Disposition:** extend
   **Harness:** `test/unit/server/ws-handler-sdk.test.ts` real `WsHandler` + mocked `SdkBridge` / `AgentHistorySource`
   **Preconditions:** A live SDK session already exists for the normalized owner key and has pending interactive requests or buffered live messages.
   **Actions:** Attach a second caller via reused `sdk.create` and capture its server message order.
   **Expected outcome:** Per `Contracts And Invariants §1` and `User-Visible Target` bullet 4, the reused path emits `sdk.created`, then `sdk.session.snapshot`, then `sdk.session.init`, then the pending interactive state and buffered live messages needed to continue. The proof surface is the exact user-visible server message stream.
   **Interactions:** Transactional replay gate, bridge subscription replay, snapshot generation, pending permission/question forwarding.

7. **Name:** A follower failure during reused `sdk.create` does not kill the shared live session or evict the winning caches
   **Type:** boundary
   **Disposition:** extend
   **Harness:** `test/unit/server/ws-handler-sdk.test.ts` real `WsHandler` + mocked `SdkBridge` / `AgentHistorySource`
   **Preconditions:** One caller already owns a live shared SDK session; a second caller reuses it and then fails during replay or cutover.
   **Actions:** Induce follower failure after session reuse begins, then attempt a normal send or attach against the still-live session.
   **Expected outcome:** Per `Contracts And Invariants §1`, the failing follower receives `sdk.create.failed`, but the shared session is not killed, the owner/request caches still resolve to the winner's `sessionId`, and the winning caller remains authorized to interact.
   **Interactions:** Failure cleanup, compare-and-delete cache eviction, bridge kill/teardown paths.

8. **Name:** Pane recovery after reconnect between `sdk.create` and `sdk.created` binds once and avoids a retry loop
   **Type:** scenario
   **Disposition:** extend
   **Harness:** `test/e2e/agent-chat-restore-flow.test.tsx` Redux + RTL restore harness
   **Preconditions:** An agent-chat pane is in create/recovery state, transport drops after the client sends `sdk.create`, and the pane still has the preserved `createRequestId`.
   **Actions:** Render the pane, trigger reconnect, deliver the retried server responses, and observe the pane content plus outbound WS sends.
   **Expected outcome:** Per `User-Visible Target` bullets 1, 3, and 4, the pane sends the same `requestId` once, binds to one session, restores visible content, and does not enter a retry loop or fabricate a second session.
   **Interactions:** Agent chat pane state, SDK message handler, persisted pane request IDs, reconnect callbacks.

9. **Name:** Stale bundles fail the handshake with `PROTOCOL_MISMATCH`, and `terminal.attach` without `intent` fails validation
   **Type:** integration
   **Disposition:** extend
   **Harness:** `test/server/ws-protocol.test.ts` real protocol server harness
   **Preconditions:** The WS protocol version has been bumped and `terminal.attach.intent` is required by the shared schema.
   **Actions:** Open one authenticated socket with an older `protocolVersion`; separately, send `terminal.attach` frames with missing or partial `intent` data.
   **Expected outcome:** Per `Wire compatibility` and `User-Visible Target` bullet 7, the handshake rejects stale clients with `PROTOCOL_MISMATCH` before later attach-time failures, and attach frames missing `intent` are rejected with `INVALID_MESSAGE`. The proof surface is the real WS error/close behavior.
   **Interactions:** Shared Zod schema, hello handshake validation, server close codes.

10. **Name:** `TerminalView` tags each attach with the correct user intent
    **Type:** unit
    **Disposition:** extend
    **Harness:** `test/unit/client/components/TerminalView.lifecycle.test.tsx` terminal lifecycle harness
    **Preconditions:** A running terminal pane is exercised through visible first attach, reconnect attach, and live keepalive attach paths.
    **Actions:** Render the pane, drive each attach path, and inspect outbound `terminal.attach` messages.
    **Expected outcome:** Per `Contracts And Invariants §3`, first visible and reveal/remount attaches use `intent: 'viewport_hydrate'`, reconnect uses `intent: 'transport_reconnect'`, and live keepalive attach uses `intent: 'keepalive_delta'`.
    **Interactions:** Terminal view visibility logic, reconnect hooks, attach sequence state, outbound WS message construction.

11. **Name:** Intended resize-on-attach behavior remains unchanged for visible create, hidden reveal, settings remount, and single-viewer reconnect
    **Type:** integration
    **Disposition:** extend
    **Harness:** `test/e2e/terminal-create-attach-ordering.test.tsx`, `test/e2e/terminal-settings-remount-scrollback.test.tsx`, and `test/server/ws-edge-cases.test.ts`
    **Preconditions:** A terminal exists in four states: first visible create, hidden-tab reveal, settings remount from seq 0, and reconnect when no other viewer is attached.
    **Actions:** Drive each attach path and capture outbound attach frames plus server replay ordering.
    **Expected outcome:** Per `Contracts And Invariants §3`, the visible hydrate paths still advertise `viewport_hydrate`, the replay ordering remains resize before `terminal.attach.ready` before replay output, and the single-viewer reconnect still resizes when reconnecting viewer ownership is authoritative.
    **Interactions:** Client attach intent selection, broker replay ordering, registry resize calls, hidden-tab lifecycle.

12. **Name:** A passive reconnecting viewer does not resize a PTY that another viewer already owns, and direct attach fixtures remain protocol-complete
    **Type:** integration
    **Disposition:** extend
    **Harness:** `test/unit/server/ws-handler-backpressure.test.ts`, `test/server/ws-terminal-stream-v2-replay.test.ts`, `test/server/ws-terminal-create-reuse-running-claude.test.ts`, `test/server/ws-terminal-create-reuse-running-codex.test.ts`, and `test/server/ws-terminal-create-session-repair.test.ts`
    **Preconditions:** One socket is already attached to a running terminal; a second socket reconnects or reattaches with a different viewport.
    **Actions:** Issue `terminal.attach` with `intent: 'transport_reconnect'`, inspect `registry.resize` calls, and run the existing direct-attach replay/create-reuse flows with explicit intent fields.
    **Expected outcome:** Per audit finding 3 and `Contracts And Invariants §3`, the passive reconnect still receives `terminal.attach.ready` and replay output, but no resize is applied while another socket remains attached. The helper-based replay/create-reuse flows continue to pass with explicit intent so the protocol cutover is complete, not silently defaulted.
    **Interactions:** Terminal broker attach policy, registry resize ownership, replay ring helpers, create-reuse server fixtures.

13. **Name:** Two real browser pages keep shared output in sync, and reconnecting page 2 leaves page 1 PTY size unchanged
    **Type:** scenario
    **Disposition:** extend
    **Harness:** `test/e2e-browser/specs/multi-client.spec.ts` Playwright multi-page harness
    **Preconditions:** Two Chromium pages connect to the same Freshell server with different viewport sizes; page 1 creates the shared terminal and page 2 hydrates that same layout.
    **Actions:** Verify shared output on both pages, record a marked `stty size` sample from page 1, clear page 2's sent WS transcript, force-disconnect page 2, wait for reconnect, assert exactly one reconnect attach from page 2 with `intent: 'transport_reconnect'`, run the marked `stty size` command again from page 1, and then emit one more unique marker command.
    **Expected outcome:** Per `User-Visible Target` bullets 5 and 8, page 2 sees the same shared terminal output as page 1, page 2 reconnects with an explicit passive attach, page 1's parsed `rows cols` sample does not change across page 2's reconnect, and fresh output continues appearing on both pages afterward.
    **Interactions:** Real browser WS reconnects, Redux rehydration, terminal attach intent logging, PTY geometry, multi-page shared session behavior.

## Coverage Summary

Covered action space

`sdk.create` send, resend, failure clearing, same-request replay, normalized durable resume reuse, alias-normalized resume reuse, reused-session replay ordering, and follower failure cleanup.

`terminal.attach` handshake validation, client intent tagging, visible hydrate attach, hidden reveal attach, settings-remount attach, keepalive attach, single-viewer reconnect attach, passive second-viewer reconnect attach, and replay ordering around `terminal.attach.ready`.

WebSocket hello handshake protocol negotiation, including stale bundle rejection through `PROTOCOL_MISMATCH`.

Real two-page browser behavior: shared output propagation to page 2, forced disconnect on one page, reconnect recovery, outbound reconnect attach transcript, and PTY size stability under mismatched viewports.

Explicitly excluded

New tests for the stale cross-tab hydrate overwrite fix and canonical durable-ID flush logic already landed on main in `persistControl`, `crossTabSync`, and `panesSlice`. Those remain protected by their existing tests; this plan treats them as adjacency risks rather than reopening that redesign.

Dedicated performance assertions. The change set is correctness- and protocol-focused, and the agreed strategy did not call for performance measurement. The residual risk is low: if the new caches or replay path introduce catastrophic latency, the browser reconnect scenarios and focused Vitest suites should still catch functional failure, but not small regressions.

Manual QA. Every acceptance check in this plan resolves to an automated artifact: WS transcript, rendered pane state, terminal buffer content, browser-controlled viewport measurement, or bridge/registry interaction used only to sharpen diagnosis after the user-visible assertion.

Residual risks from exclusions

If an unrelated regression reopens stale cross-tab broadcast overwrites, this plan will only detect it indirectly when it affects reconnect/create convergence. The existing stale-hydration tests remain necessary guardrails.

If attach-intent changes cause subtle throughput or memory regressions without breaking ordering or correctness, this plan will not measure them directly. That is acceptable for the current scope because the reported bugs are correctness failures, not performance failures.
