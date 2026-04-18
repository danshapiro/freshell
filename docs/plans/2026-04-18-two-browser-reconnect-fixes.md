# Two-Browser Reconnect Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use trycycle-executing to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shared agent and terminal sessions converge safely when two browsers are open on the same work, one or both disconnect, and they reconnect or recover, without forking live SDK sessions, reviving stale recovery state, or letting a reconnecting viewer resize somebody else's PTY.

**Architecture:** Keep the recently-landed restore-ledger and canonical durable-id persistence work intact, and finish the missing ownership rules at the reconnect boundary. `sdk.create` becomes reconnect-safe and idempotent through a normalized create-ownership key derived from either the request id or the restore-ledger-resolved resume identity, and that ownership must be materialized as a live owner-to-session cache immediately after `createSession()` returns so alias-normalized duplicates still reuse the first session during the pre-`sdk.session.init` window before ledger sync and CLI session discovery catch up. The reused-live-session path must reuse the existing transactional snapshot/init/replay machinery rather than inventing a weaker shortcut. Terminal attach intent becomes explicit on the wire so the broker can distinguish authoritative viewport hydration from passive reconnect re-subscription and skip PTY resize when another viewer is already attached; because that is a required protocol change, the WebSocket protocol version must bump in lockstep.

**Tech Stack:** TypeScript, React 18, Redux Toolkit, Express, WebSocket (`ws`), node-pty, Vitest, Playwright

---

## Scope And Strategy Gate

- Recent main already landed the important stale-hydration protection for agent chat:
  - canonical durable-id persistence via `src/store/persistControl.ts` and `flushPersistedLayoutNow`
  - stale cross-tab hydrate rejection in `src/store/crossTabSync.ts`
  - local-pane preference during agent-chat hydrate in `src/store/panesSlice.ts`
- Do not reopen that redesign. The remaining bug class is missing ownership at the reconnect boundary:
  - one durable agent history can still fork into multiple live SDK sessions
  - alias variants of the same durable history can still race unless ownership is normalized before create
  - one reconnecting terminal viewer can still mutate shared PTY geometry during reattach
  - `sdk.create` still lacks the reconnect resend/idempotence contract that `terminal.create` already has
- The clean end state is to finish ownership, not add more heuristics:
  - `sdk.create` must be idempotent on both the client and server
  - resumed `sdk.create` ownership must normalize stale/live/durable aliases that resolve to the same restore-ledger identity
  - reused create must reuse the current transactional snapshot/init/replay path, not degrade to snapshot-only attach behavior
  - terminal attach must carry explicit intent so the server can decide whether viewport data is authoritative
  - the wire-contract change must fail stale bundles fast with `PROTOCOL_MISMATCH`, not with a late `INVALID_MESSAGE`
  - browser coverage must prove the second page, because the current multi-client browser spec still does not
- Rejected approaches:
  - client-only `sdk.create` resend: reconnect still forks sessions server-side
  - server-only raw-`resumeSessionId` locking: canonical and stale aliases can still race into two creates
  - normalized create locking without a normalized owner-to-session cache: alias-normalized duplicates can still fork during the pre-`sdk.session.init` window because ordinary live-session lookup does not reliably discover the first fresh session yet
  - server-only `sdk.create` reuse that sends only `sdk.created` plus a snapshot: it drops pending interactive state and risks diverging from the existing create semantics
  - runtime-importing `WS_PROTOCOL_VERSION` from `shared/ws-protocol.ts` into the browser bundle: that file pulls Zod runtime; keep the existing client-side constant update in place unless a separate Zod-free constant file is intentionally introduced
  - full new cross-browser viewport-owner protocol: that is a bigger product decision than the current bug requires; attach-intent gating fixes the reconnect regression while preserving today's active resize behavior

No user decision is required.

## User-Visible Target

- Two browsers that recover the same agent-chat pane must converge on one live SDK session after reconnect or lost-session recovery, even if they reach that session through different stale or canonical resume aliases.
- That convergence must hold even when the second create arrives before the first live session has emitted `sdk.session.init` or otherwise become discoverable through ordinary restore-ledger / CLI-session lookup.
- If a browser disconnects after sending `sdk.create` but before `sdk.created`, reconnect must resend the same request id exactly once and eventually bind the pane without fabricating a second session.
- Reused `sdk.create` must surface the same interactive state as a fresh create: the second browser still gets the correct snapshot/init sequence and any pending prompts or buffered live session state needed to continue.
- Reconnecting a second viewer to an already-live terminal must reattach output without resizing the PTY out from under the still-live viewer.
- The existing canonical durable-id protections must remain intact:
  - stale cross-tab broadcasts must not overwrite a newer durable id
  - a recovered pane must still flush the canonical durable id immediately when it becomes known
- A stale browser bundle that reconnects after this deploy must fail fast at the WebSocket handshake with `PROTOCOL_MISMATCH` instead of limping into attach-time validation errors.
- The browser regression suite must verify the second page actually sees shared output and survives reconnect, and with mismatched page viewports it must prove that page 2 reconnect does not change page 1's PTY size.

## Contracts And Invariants

### 1. `sdk.create` ownership and idempotence

- `sdk.create` with `resumeSessionId` is session-scoped:
  - one live SDK session per normalized resume identity
  - normalization uses the restore ledger / live-session lookup so canonical durable ids and stale live aliases serialize onto the same owner key when they refer to the same history
  - once a fresh live session is created for that owner key, later creates resolving to the same owner key must reuse it immediately even before `sdk.session.init` or ledger sync makes it discoverable through the ordinary live-session lookup paths
  - concurrent creates from different sockets reuse the same live session
  - reconnect resend of the same create request must not fork a second session
- `sdk.create` without `resumeSessionId` is request-scoped:
  - duplicate request ids reuse the same created live session
  - reconnect resend with the same request id must not create a second fresh session
- Both the fresh-create and reused-create paths must emit the same public create sequence:
  1. `sdk.created`
  2. `sdk.session.snapshot`
  3. `sdk.session.init`
- After that sequence, reused create must still surface the same pending interactive requests and buffered live messages that the existing transactional create/attach paths would have delivered.
- Failure cleanup is ownership-sensitive:
  - if this `sdk.create` invocation created a brand-new live session and then fails before the create cutover is safely published, kill that session and remove only cache entries that still point at it
  - if this invocation reused an already-live shared session, do **not** kill or retire that session on follower failure; tear down only the temporary subscription/request bookkeeping for that requester
  - request-id and normalized-owner cache eviction must be compare-and-delete on `sessionId` so a late failing duplicate requester cannot wipe mappings that now belong to a successful owner
- `sdk.create.failed` must clear client/server in-flight state and must not leave a usable orphan session behind.

### 2. Restore identity and canonical durable ids

- The new `sdk.create` ownership rules must reuse the existing restore ledger and canonical durable-id plumbing; they must not add a second restore authority.
- When a durable or named resume id maps to a live session through the ledger or the bridge's live-session lookup, reused create must snapshot that exact live session rather than inventing a second one.
- Reused `sdk.create` must preserve the same snapshot/restore semantics that the current create and attach flows already expose for both durable resumes and named resumes. Factor the snapshot path so the existing named-resume and durable-resume assertions stay valid unless a strictly stronger assertion replaces them.
- Existing stale cross-tab and canonical durable-id tests must keep passing unchanged unless a stronger assertion replaces them.

### 3. Terminal attach semantics

- `terminal.attach` must carry the actual client intent:
  - `viewport_hydrate`
  - `keepalive_delta`
  - `transport_reconnect`
- Resize policy is keyed off that intent:
  - `viewport_hydrate`: keep current resize-on-attach behavior
  - `keepalive_delta`: never resize on attach
  - `transport_reconnect`: resize only when no other websocket is already attached to that terminal, or when the attach supersedes the same websocket attachment
- Explicit `terminal.resize` remains authoritative. This change only stops reconnect-time attach from stealing viewport ownership.
- Replay ordering, attach dedupe by `attachRequestId`, and `terminal.attach.ready` semantics must remain unchanged.

### 4. Wire compatibility

- Requiring `terminal.attach.intent` is a protocol-breaking change. `WS_PROTOCOL_VERSION` must bump in both the shared schema and the client hello constant during the same implementation.
- Do not runtime-import `shared/ws-protocol.ts` into `src/lib/ws-client.ts`; that would bundle Zod into the client. Update the existing client-side numeric constant in place, or extract a Zod-free shared constant only if that is done intentionally and fully.

## File Structure

- Modify: `src/lib/ws-client.ts`
  Responsibility: generalize in-flight create tracking so `sdk.create` gets the same reconnect resend and completion clearing guarantees that `terminal.create` already has, and keep the client-side protocol version constant aligned with the handshake schema without importing Zod runtime.
- Modify: `server/ws-handler.ts`
  Responsibility: add normalized SDK create ownership resolution, a normalized owner-to-session cache that survives the pre-init window, create locking and request/session dedupe, reuse existing live sessions for duplicate creates, share the transactional create/attach replay path for reused sessions, and plumb terminal attach intent into the broker.
- Modify: `shared/ws-protocol.ts`
  Responsibility: bump the WebSocket protocol version, define the explicit `terminal.attach` intent enum, and require it in the shared schema.
- Modify: `server/terminal-stream/broker.ts`
  Responsibility: make attach-time resize policy intent-aware so passive reconnects do not mutate shared PTY size.
- Modify: `src/components/TerminalView.tsx`
  Responsibility: send the already-known attach intent over the wire on every attach path.
- Modify: `test/unit/client/lib/ws-client.test.ts`
  Responsibility: prove reconnect resend and completion clearing for `sdk.create`, and keep the hello protocol version aligned with the shared constant.
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
  Responsibility: prove cross-socket same-resume create reuse, alias-normalized reuse, duplicate request-id create reuse, preserved `sdk.created -> snapshot -> init` ordering for reused creates, and retained pending interactive state for the reused-live-session path.
- Modify: `test/e2e/agent-chat-restore-flow.test.tsx`
  Responsibility: prove the pane-level user experience when reconnect happens after `sdk.create` but before `sdk.created`.
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
  Responsibility: prove attach intent tagging for hydrate, keepalive, and transport reconnect flows.
- Modify: `test/e2e/terminal-create-attach-ordering.test.tsx`
  Responsibility: lock the visible-create, hidden-reveal, and reconnect attach generations to the intended wire-level attach intents in the highest-signal client integration test for attach ordering.
- Modify: `test/e2e/terminal-settings-remount-scrollback.test.tsx`
  Responsibility: prove settings remount and hidden-tab reveal still use `viewport_hydrate` when they intentionally restart replay from seq 0, so the new reconnect intent does not leak into remount/rehydrate flows.
- Modify: `test/server/ws-protocol.test.ts`
  Responsibility: lock the new required `terminal.attach.intent` schema and keep protocol-version handshake expectations aligned with the bump.
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
  Responsibility: prove the broker does not resize during passive reconnect attach when another client is already attached.
- Modify: `test/server/ws-edge-cases.test.ts`
  Responsibility: preserve transport-reconnect replay ordering and keep direct `terminal.attach` fixtures aligned with the explicit intent field.
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`
  Responsibility: keep replay helpers and assertions aligned with the explicit attach intent field.
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`
  Responsibility for the three files above: update direct `terminal.attach` fixtures/helpers to send explicit intent so the protocol cutover is complete rather than silently defaulted.
- Modify: `test/e2e-browser/specs/multi-client.spec.ts`
  Responsibility: fix the broken "output appears in both clients" assertion and add a real reconnect regression for the second page.

## Task 1: Make `sdk.create` reconnect-safe, alias-safe, and idempotent

**Files:**
- Modify: `src/lib/ws-client.ts`
- Modify: `server/ws-handler.ts`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `test/unit/server/ws-handler-sdk.test.ts`
- Modify: `test/e2e/agent-chat-restore-flow.test.tsx`

- [ ] **Step 1: Add the failing tests**

Add these regressions before touching the implementation:

- In `test/unit/client/lib/ws-client.test.ts`:
  - `resends an in-flight sdk.create once after reconnect until sdk.created arrives`
  - `clears sdk.create reconnect tracking when sdk.create.failed arrives`
- In `test/unit/server/ws-handler-sdk.test.ts`:
  - `reuses one live sdk session for concurrent sdk.create requests with the same resumeSessionId`
  - `reuses one live sdk session when concurrent sdk.create requests resolve different resume aliases to the same durable history before sdk.session.init makes the first session discoverable by ordinary lookup`
  - `reuses the first created sdk session when the same fresh requestId is resent after reconnect`
  - `for reused sdk.create sends sdk.created, then sdk.session.snapshot, then sdk.session.init, then pending interactive state`
  - `does not kill or evict the shared live session when a reused sdk.create follower fails during replay/snapshot cutover`
  - the reuse tests must assert `mockSdkBridge.createSession` is called only once and both callers receive the same live `sessionId`
- In `test/e2e/agent-chat-restore-flow.test.tsx`:
  - `reconnect after sdk.create but before sdk.created resends the same request and binds one session without a retry loop`

- [ ] **Step 2: Run the focused tests and verify they fail for the right reason**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/ws-client.test.ts
npm run test:server -- --run test/unit/server/ws-handler-sdk.test.ts
npm run test:vitest -- test/e2e/agent-chat-restore-flow.test.tsx
```

Expected:

- the new `sdk.create` reconnect resend test fails because `WsClient` only tracks `terminal.create`
- the alias-normalization and duplicate-create tests fail because `ws-handler` still keys ownership off raw inputs and has no normalized owner-to-session cache for the pre-`sdk.session.init` window, so it calls `sdkBridge.createSession` again
- the reused-create sequencing test fails if the reused-live-session path shortcuts around the transactional replay logic

- [ ] **Step 3: Write the minimal end-state behavior**

Implement the ownership rules directly:

- In `src/lib/ws-client.ts`:
  - generalize `isTerminalCreateMessage` into create-request tracking that also recognizes `sdk.create`
  - keep dropping queued `terminal.attach` on reconnect, but resend in-flight `sdk.create` once per reconnect epoch just like `terminal.create`
  - clear the in-flight record on `sdk.created`, `sdk.create.failed`, and request-scoped `error` messages with a `requestId`
- In `server/ws-handler.ts`:
  - add a helper that resolves SDK create ownership before locking:
    - if there is no `resumeSessionId`, use the request id owner key
    - if there is a `resumeSessionId`, consult direct live-session lookup plus `agentHistorySource.resolve(...)` to derive a normalized owner key from the resolved durable timeline identity when available
    - if resolution is `missing` or `fatal`, fall back to raw `resumeSessionId` for locking only; do not change the existing restore-failure semantics
  - add `withSdkCreateLock(...)` keyed by that normalized owner key
  - add a normalized owner-to-session cache for resume-based creates:
    - resolve this cache before ordinary bridge / ledger live-session lookup
    - store `ownerKey -> sessionId` immediately after a fresh `sdkBridge.createSession(...)` succeeds, before snapshot/init/replay work begins
    - make stale-cache resolution lazy and strict: if the cached session no longer exists, delete the cache entry instead of falling back silently
    - clear the owner cache on create failure, explicit kill, and any teardown path that retires the live session
    - do not wait for `sdk.session.init`, CLI session discovery, or restore-ledger sync before making the first created session reusable by alias-normalized duplicates
  - add request-id caching similar to the terminal create cache so duplicate fresh creates reuse the same live session after reconnect
  - before calling `sdkBridge.createSession`, re-check for:
    - an already-cached request id
    - an already-cached normalized owner key
    - an already-live session for the normalized resume identity via the bridge and restore ledger-backed lookup
  - factor the reused-live-session path into one helper that reuses the existing transactional create/attach machinery:
    - subscribe with `skipReplayBuffer`
    - capture/drain replay state when available
    - send `sdk.created`
    - send the correct `sdk.session.snapshot`
    - send `sdk.session.init`
    - replay pending interactive requests
    - flush buffered live messages above the captured watermark
    - only then switch the subscription to live forwarding
  - ensure reused create drives snapshot resolution through the same shared helper inputs that the equivalent create/attach flow already uses, so named-resume and durable-resume behavior stays unchanged apart from the dedupe fix
  - after a fresh create succeeds, remember both:
    - the request id to session id mapping for reconnect resend reuse
    - the normalized owner key to session id mapping for alias-normalized reuse before init/ledger sync
  - make cleanup ownership-aware:
    - track whether each `sdk.create` invocation created a fresh session or reused an existing one
    - only kill/teardown the session on failure when this invocation created it and the session has not already been safely published for reuse
    - on reused-create failure, remove only the failing request's temporary subscription/bookkeeping and leave the shared live session plus its owner/request caches intact
    - when deleting request-id or owner-key cache entries, compare the currently cached `sessionId` before removing so a later failing duplicate requester cannot evict the winner's mapping
  - clear cached request ids on failure, explicit kill, natural exit/teardown, and any path that retires the live session

- [ ] **Step 4: Run the focused tests again and make them pass**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/ws-client.test.ts
npm run test:server -- --run test/unit/server/ws-handler-sdk.test.ts
npm run test:vitest -- test/e2e/agent-chat-restore-flow.test.tsx
```

Expected: all PASS.

- [ ] **Step 5: Refactor and verify the surrounding SDK restore surface**

Refactor only after the new behavior is green:

- keep the reused-create and fresh-create public ordering identical
- remove any duplicated "send snapshot/init/replay for this session" logic that would otherwise drift
- re-run the related SDK restore checks:

```bash
npm run test:server -- --run test/unit/server/ws-handler-sdk.test.ts
npm run test:vitest -- test/e2e/agent-chat-restore-flow.test.tsx
```

Expected: PASS with no weakened assertions.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ws-client.ts server/ws-handler.ts test/unit/client/lib/ws-client.test.ts test/unit/server/ws-handler-sdk.test.ts test/e2e/agent-chat-restore-flow.test.tsx
git commit -m "fix: dedupe sdk creates across reconnects"
```

## Task 2: Make terminal attach intent explicit and stop passive reconnect resizes

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/terminal-create-attach-ordering.test.tsx`
- Modify: `test/e2e/terminal-settings-remount-scrollback.test.tsx`
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `test/server/ws-edge-cases.test.ts`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-claude.test.ts`
- Modify: `test/server/ws-terminal-create-reuse-running-codex.test.ts`
- Modify: `test/server/ws-terminal-create-session-repair.test.ts`

- [ ] **Step 1: Add the failing tests**

Write the transport contract first:

- In `test/unit/client/components/TerminalView.lifecycle.test.tsx`:
  - assert `terminal.attach` includes `intent: 'viewport_hydrate'` for first visible attach
  - assert reconnect attach includes `intent: 'transport_reconnect'`
  - assert live keepalive attach includes `intent: 'keepalive_delta'`
- In `test/e2e/terminal-create-attach-ordering.test.tsx`:
  - assert visible create attach sends `intent: 'viewport_hydrate'`
  - assert hidden reveal attach sends `intent: 'viewport_hydrate'`
  - assert reconnect attach sends `intent: 'transport_reconnect'`
- In `test/e2e/terminal-settings-remount-scrollback.test.tsx`:
  - assert settings-remount and hidden-tab reveal attaches that intentionally restart replay from seq 0 keep `intent: 'viewport_hydrate'`
- In `test/server/ws-protocol.test.ts`:
  - `terminal.attach` requires `intent`
  - the hello/version-mismatch handshake still rejects stale clients with `PROTOCOL_MISMATCH` after the version bump from `3` to `4`
- In `test/unit/server/ws-handler-backpressure.test.ts`:
  - with one viewer already attached, a second viewer's `transport_reconnect` attach must send `terminal.attach.ready` and replay output without calling `registry.resize`
- In `test/server/ws-edge-cases.test.ts`:
  - keep the reconnect ordering coverage, but update it to use explicit attach intent and preserve the existing resize-before-ready behavior for the single-viewer reconnect case
- Update helper-based tests in the replay/create-reuse files to include explicit intent so the schema cutover is intentional and complete

- [ ] **Step 2: Run the focused terminal tests and verify they fail**

Run:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx
npm run test:vitest -- test/e2e/terminal-create-attach-ordering.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx
npm run test:server -- --run test/server/ws-protocol.test.ts test/unit/server/ws-handler-backpressure.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
```

Expected:

- client lifecycle tests fail because `TerminalView` does not send `intent`
- server/protocol tests fail because `terminal.attach` has no intent-aware schema or resize policy

- [ ] **Step 3: Write the explicit attach-intent contract**

Implement the protocol cut directly:

- In `shared/ws-protocol.ts`:
  - bump `WS_PROTOCOL_VERSION` from `3` to `4`
  - add `TerminalAttachIntentSchema = z.enum(['viewport_hydrate', 'keepalive_delta', 'transport_reconnect'])`
  - require `intent` on `TerminalAttachSchema`
- In `src/lib/ws-client.ts`:
  - update the existing local hello protocol version constant from `3` to `4`
  - do not runtime-import `shared/ws-protocol.ts` into the client file
- In `src/components/TerminalView.tsx`:
  - include the existing `AttachIntent` value on every `terminal.attach` send
- In `server/ws-handler.ts`:
  - pass `m.intent` through to the broker attach call
- In `server/terminal-stream/broker.ts`:
  - extend `attach(...)` to accept `intent`
  - keep replay and dedupe behavior unchanged
  - gate the internal `registry.resize(...)` call by intent:
    - `viewport_hydrate`: keep current behavior
    - `keepalive_delta`: skip resize
    - `transport_reconnect`: skip resize when another websocket is already attached to the terminal; otherwise resize normally
- In the affected server tests:
  - update every direct `terminal.attach` fixture or helper to supply the right explicit intent for that scenario

- [ ] **Step 4: Run the focused terminal tests again and make them pass**

Run:

```bash
npm run test:vitest -- test/unit/client/lib/ws-client.test.ts
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx
npm run test:vitest -- test/e2e/terminal-create-attach-ordering.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx
npm run test:server -- --run test/server/ws-protocol.test.ts test/unit/server/ws-handler-backpressure.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts
```

Expected: all PASS.

- [ ] **Step 5: Refactor and verify the reconnect-order invariants**

Refactor only if needed to keep the broker readable, then re-run the reconnect-focused server and handshake coverage:

```bash
npm run test:vitest -- test/unit/client/lib/ws-client.test.ts test/server/ws-protocol.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
```

Expected:

- `terminal.attach.ready` ordering remains unchanged
- passive reconnect attaches no longer mutate PTY size
- the explicit handshake/version tests in `test/server/ws-protocol.test.ts` still reject stale bundles with `PROTOCOL_MISMATCH`
- the client-side hello version assertion in `test/unit/client/lib/ws-client.test.ts` stays aligned with the schema bump

- [ ] **Step 6: Commit**

```bash
git add shared/ws-protocol.ts src/lib/ws-client.ts src/components/TerminalView.tsx server/ws-handler.ts server/terminal-stream/broker.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx test/e2e/terminal-settings-remount-scrollback.test.tsx test/server/ws-protocol.test.ts test/unit/server/ws-handler-backpressure.test.ts test/server/ws-edge-cases.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-terminal-create-reuse-running-claude.test.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts
git commit -m "fix: make shared terminal reconnect attaches passive and bump ws protocol"
```

## Task 3: Prove the second browser and finish verification

**Files:**
- Modify: `test/e2e-browser/specs/multi-client.spec.ts`

- [ ] **Step 1: Write the failing browser regressions**

Strengthen `test/e2e-browser/specs/multi-client.spec.ts` with two real assertions:

- Fix `terminal output appears in both clients` so it actually opens page 2, waits for the shared terminal layout there, and verifies `multi-client-marker` on page 2 as well as page 1.
- Add `reconnecting second viewer keeps page 1 PTY size stable and both pages keep shared output`:
  - open page 1 and page 2 with intentionally different viewport sizes so the reconnect bug is observable
  - create the shared terminal in page 1
  - wait for page 2 to hydrate the same layout
  - from page 1, run a shell command that prints a uniquely marked `stty size` sample such as `printf '__PTY_SIZE__:%s\n' \"$(stty size)\"` and capture the parsed `rows cols` value from the terminal buffer
  - clear page 2's outbound WS log through the existing harness
  - force-disconnect page 2
  - wait for page 2 to reconnect
  - assert page 2 sent one `terminal.attach` with `intent: 'transport_reconnect'`
  - from page 1, run the same uniquely marked `stty size` command again and assert the parsed `rows cols` value is unchanged from before the reconnect
  - run one more marker command in page 1 and verify the output appears in both pages afterward

- [ ] **Step 2: Run the browser spec and verify it fails**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/multi-client.spec.ts
```

Expected:

- the strengthened page-2 assertion fails on the current broken test
- with distinct viewport sizes, the reconnect regression fails because page 2's reconnect-time attach still changes the shared PTY size on the current implementation

- [ ] **Step 3: Implement any final harness-free test adjustments**

Keep this step small:

- prefer changing only the spec unless an assertion reveals one last production gap
- do not add a second browser-only code path; production code should already be correct after Tasks 1 and 2

- [ ] **Step 4: Run the browser spec again and make it pass**

Run:

```bash
npm run test:e2e:chromium -- test/e2e-browser/specs/multi-client.spec.ts
```

Expected:

- PASS
- the second page really receives shared output
- page 1's marked `stty size` sample stays stable across page 2 reconnect

- [ ] **Step 5: Run the broad verification before rebasing onto main**

Run the repo-required broad checks from the worktree:

```bash
npm run test:status
FRESHELL_TEST_SUMMARY="two-browser reconnect fixes" npm run check
npm run lint
npm run test:e2e:chromium -- test/e2e-browser/specs/multi-client.spec.ts test/e2e-browser/specs/reconnection.spec.ts test/e2e-browser/specs/server-restart-recovery.spec.ts
```

Expected:

- coordinated `check` PASS
- `lint` PASS
- the reconnect- and multi-client-focused Playwright specs PASS
- no test is weakened or deleted to get green

- [ ] **Step 6: Commit**

```bash
git add test/e2e-browser/specs/multi-client.spec.ts
git commit -m "test: cover two-browser reconnect recovery"
```

## Task 4: Rebase, squash, submit the PR, and land on local `main`

**Files:**
- No planned source edits. If rebasing `main` surfaces conflicts, resolve them only in files already touched by Tasks 1-3 and keep the same behavior and test coverage.

- [ ] **Step 1: Rebase the worktree branch onto local `main`**

Run from `/home/user/code/freshell/.worktrees/trycycle-two-browser-reconnect-fixes`:

```bash
git rebase main
```

Expected: the branch `trycycle/two-browser-reconnect-fixes` is cleanly rebased on local `main`.

- [ ] **Step 2: Squash the worktree commits into one intentional landing commit**

Do this only after Tasks 1-3 are committed and the branch is rebased:

```bash
git reset --soft "$(git merge-base main HEAD)"
git commit -m "fix: stabilize two-browser reconnect recovery"
```

Expected:

- the worktree branch now contains one intentional commit on top of `main`
- the task-by-task safety commits remain in reflog history, but local `main` will receive a single clean landing commit

- [ ] **Step 3: Re-run the required landing checks after the rebase and squash**

Run:

```bash
npm run test:status
FRESHELL_TEST_SUMMARY="two-browser reconnect fixes post-rebase" npm test
npm run lint
npm run test:e2e:chromium -- test/e2e-browser/specs/multi-client.spec.ts test/e2e-browser/specs/reconnection.spec.ts test/e2e-browser/specs/server-restart-recovery.spec.ts
```

Expected:

- coordinated `npm test` PASS after the rebase, satisfying the repo's fast-forward-to-main requirement
- `lint` PASS
- the focused browser regressions still PASS on top of rebased `main`
- if the coordinator gate is free and the branch is otherwise green, prefer one extra `test/e2e-browser` suite pass before fast-forwarding local `main`; treat it as added confidence, not a blocker

- [ ] **Step 4: Push the branch and submit the PR without merging remote `main`**

Run:

```bash
git push -u origin trycycle/two-browser-reconnect-fixes
cat > /tmp/two-browser-reconnect-pr.md <<'EOF'
## Summary
- dedupe `sdk.create` across reconnect resends and resume aliases
- stop passive reconnect terminal attaches from resizing shared PTYs
- strengthen two-browser reconnect coverage, including the second page assertions

## Testing
- `npm test`
- `npm run lint`
- `npm run test:e2e:chromium -- test/e2e-browser/specs/multi-client.spec.ts test/e2e-browser/specs/reconnection.spec.ts test/e2e-browser/specs/server-restart-recovery.spec.ts`
EOF
gh pr create --base main --head trycycle/two-browser-reconnect-fixes --title "fix: stabilize two-browser reconnect recovery" --body-file /tmp/two-browser-reconnect-pr.md
```

Expected:

- the branch is published to `origin`
- `gh pr create` prints the PR URL for the submitted review
- the PR description captures SDK create dedupe, passive terminal reconnect attaches, and strengthened browser coverage

Important: submit the PR for review, but do **not** use a GitHub merge button to land remote `main`.

- [ ] **Step 5: Fast-forward local `main` only**

First confirm the served checkout is safe to move:

```bash
git -C /home/user/code/freshell branch --show-current
git -C /home/user/code/freshell status --short
```

Expected:

- current branch is exactly `main`
- `status --short` prints nothing; if it is dirty or not on `main`, stop and report the blocker instead of touching the served checkout

Then run:

```bash
git -C /home/user/code/freshell merge --ff-only trycycle/two-browser-reconnect-fixes
```

Expected: local `main` fast-forwards atomically to the verified branch tip with no merge commit and no conflict markers written into the served branch.

## Landing Notes

- Execute everything in `/home/user/code/freshell/.worktrees/trycycle-two-browser-reconnect-fixes`.
- Do not merge on `main` directly. Rebase `main` into the worktree first, resolve there, run the full verification there, then fast-forward local `main`.
- Squash the worktree branch into one intentional landing commit before pushing and fast-forwarding `main`; frequent intermediate worktree commits still happen during Tasks 1-3.
- Before fast-forwarding `/home/user/code/freshell`, verify that checkout is clean and still on `main`. If another agent or the user has local changes there, stop and surface the blocker rather than risking the served branch.
- Do not press a remote merge button. The user explicitly asked to land the change on local `main` only.
