# Reconnection-Reconciliation Handshake — Design

**Date:** 2026-07-22
**Branch:** `feat/rust-tauri-port` (worktree `.worktrees/rust-tauri-port`, designed at HEAD `75019af0`)
**Mode:** DESIGN (keystone Option B of `2026-07-19-state-sync-resilience-assessment.md`)
**Companion state map:** `2026-07-19-state-sync-cartography.md` (all `file:line` anchors below verified in this worktree)

> One protocol replaces the N ad-hoc client-side latches: on every WS (re)connect the client
> *presents* its pane view; the server answers with an authoritative per-pane **verdict**
> derived from the terminal registry + identity registry + disk session index. The client
> stops guessing. The exchange is a pure read on the server and is safe to repeat any
> number of times — which is the entire idempotency story.

---

## 1. Problem Framing

Today the client re-derives pane↔terminal↔session linkage on every reconnect through a
scatter of mechanisms: the restore-arming latch (`src/lib/terminal-restore.ts:9-63`), the
inventory-driven `clearDeadTerminals` loop (`src/App.tsx:976-991`), the `matchScore`
heuristic (`src/lib/session-utils.ts:107-185`), and per-provider promotion rules duplicated
in ≥6 places that disagree (cartography Part 5, weakness 1). Each mechanism is a client-side
*guess* about two facts only the server owns: **is this terminal alive?** and **does this
session exist on disk?** The four incidents (assessment §7, cartography Part 4) are all
failures of those guesses under disruption.

This design specifies the single exchange that replaces the guessing:

- Client → server: `pane.reconcile.request` — "here is every pane I have and every identity
  key I believe about it."
- Server → client: `pane.reconcile.result` — one **verdict per pane**: `attach` /
  `respawn` / `fresh` / `dead_session` / `retry` / `invalid`.

Scope is **linkage and identity only**. Cosmetic layout (tab order, splits, titles) stays
client-authoritative per the assessment's hybrid verdict (§5.2). The server never sees or
stores the pane tree; it sees a flat list of identity claims keyed by an opaque `paneKey`.

## 2. Explicit Assumptions

1. **Identity stamping has landed** (parallel lane, per brief constraint d): the server
   stamps `sessionRef` on every frame that names a `terminalId` and on REST create — i.e.
   the `TerminalIdentityRegistry` (`crates/freshell-ws/src/identity.rs`) is populated for
   every non-shell terminal, fresh or resumed, and `inventory()`'s `session_ref: None`
   placeholders (`crates/freshell-terminal/src/registry.rs:258,631`) are being replaced.
   This design *reads* that registry; it does not build it.
2. **The production client is a frozen bundle** with an 8-file deviation budget. Phase 1–2
   must be fully implementable and testable with a synthetic client; frozen-client adoption
   is a later, separately-shippable phase (§10).
3. **`shared/ws-protocol.ts` is frozen.** All wire additions land in the Rust
   `freshell-protocol` crate only. The TS mirror is updated only in the later client
   phase, on main, as part of the adoption change.
4. **`protocolVersion` stays 7.** A mismatch is fatal before auth
   (`crates/freshell-ws/src/lib.rs:368-381`); this feature must not touch it.
   Negotiation rides the existing `hello.capabilities` pattern
   (`terminalOutputBatchV1`, `uiScreenshotV1` — `client_messages.rs:111-116`).
5. **Single primary user, self-hosted.** Multi-client is "same person, two browser tabs" —
   supported by the existing multi-subscriber fan-out, not a contended-writer problem.
6. `createRequestId` is unique per pane and stable across that pane's terminal generations
   (AGENTS.md pane-system contract; `paneTypes.ts:76`).

## 3. Frozen-Client Compatibility (the load-bearing constraint, verified)

The server half must be **inert** for today's client. Verified mechanics:

- **Unknown server frames are silently ignored by the frozen client.** The client parses
  incoming frames with a bare `JSON.parse` — no Zod validation, no discriminated-union
  rejection (`src/lib/ws-client.ts:345-353`; invalid JSON is dropped at `:349-351`).
  `handleIncomingMessage` is a chain of `if (msg.type === …)` blocks (`ws-client.ts:146-240`)
  that fall through to `messageHandlers.forEach(handler(msg))` (`ws-client.ts:244,253`);
  every registered consumer (e.g. the `App.tsx` fold) is likewise an if/switch chain on
  `msg.type`. A frame type no handler matches is a no-op. The only frames that trigger
  active behavior (`error` + `NOT_AUTHENTICATED`/`PROTOCOL_MISMATCH`) are explicit
  (`ws-client.ts:229-240,358-372`).
- **Stronger guarantee anyway: the server never volunteers the new frame.**
  `pane.reconcile.result` is sent *only* in response to `pane.reconcile.request`, which the
  frozen client never sends. Inertness does not even rely on the ignore behavior above.
- **Handshake bytes stay pinned.** `build_handshake` is pinned byte-identical by the
  oracle's determinism tiers (`crates/freshell-ws/src/lib.rs:311-350`). The one additive
  field this design puts in `ready` (§4.2) is `Option` + `skip_serializing_if`, emitted
  **only when the client's `hello` opted in** — today's client doesn't, so the emitted
  handshake is byte-for-byte unchanged.
- **Extra `hello` fields are already tolerated by the server.** `evaluate_hello` inspects
  only `type` / `protocolVersion` / `token` (`crates/freshell-ws/src/lib.rs:368-381`), and
  the `Hello` struct has no `deny_unknown_fields` — precedent: the `sidebarOpenSessions`
  hello extension (`client_messages.rs:147-149`, sent via `helloExtensionProvider`,
  `ws-client.ts:329-342`).
- **Symmetric server tolerance exists for a new client on an old server**: unknown client
  frames are accept-and-strip ignored (`crates/freshell-ws/src/terminal.rs:401-423`). An
  adopting client on a pre-reconcile server sends nothing anyway, because the server never
  advertised the capability (§4.2) — the frame is never emitted, the legacy path runs.

Three independent gates, any one of which keeps the feature dark: client capability in
`hello`, server advertisement in `ready`, result-only-in-response-to-request.

## 4. Protocol Frames

All additions are additive entries in `crates/freshell-protocol` — new variants in the
`ClientMessage`/`ServerMessage` enums plus the `CLIENT_MESSAGE_TYPES` (27→28) and
`SERVER_MESSAGE_TYPES` (52→53) name arrays. `shared/ws-protocol.ts` untouched (frozen).

### 4.1 Capability (client → server, in `hello`)

`HelloCapabilities` gains:

```rust
#[serde(skip_serializing_if = "Option::is_none")]
pub pane_reconcile_v1: Option<bool>,   // wire: capabilities.paneReconcileV1
```

### 4.2 Advertisement (server → client, in `ready`)

`Ready` gains:

```rust
#[serde(skip_serializing_if = "Option::is_none")]
pub capabilities: Option<ReadyCapabilities>,   // { paneReconcileV1: true }
```

Populated **iff** the connection's `hello` carried `capabilities.paneReconcileV1 == true`.
This preserves the pinned clean-boot handshake bytes (§3) and gives the adopting client a
deterministic "may I send the request?" signal. A client must not send
`pane.reconcile.request` unless the `ready` it just received advertised the capability.

### 4.3 `pane.reconcile.request` (client → server)

```jsonc
{
  "type": "pane.reconcile.request",
  "reconcileId": "rec-8f2k…",          // client-minted, echoed verbatim; correlation only
  "panes": [
    {
      "paneKey": "tab3:paneA",          // OPAQUE to the server; echoed verbatim
      "kind": "terminal",               // v1: "terminal" only (fresh-agent: §12)
      "mode": "amplifier",              // TerminalMode string as persisted
      "createRequestId": "cr-…",        // required — the pane's stable creation key
      "terminalId": "term-…",           // optional — last known live handle
      "serverInstanceId": "srv-…",      // optional — locality hint, informational
      "sessionRef": { "provider": "amplifier", "sessionId": "…" },  // optional claim
      "resumeSessionId": "…",           // optional legacy single-key claim
      "status": "running"               // optional, informational only — never trusted
    }
  ]
}
```

Rules:
- `panes` is a flat list — no tree, no tab structure. Cap: **200 entries**; an over-cap
  request is answered with a standard `error` frame, code `RECONCILE_TOO_LARGE`
  (never silently truncated).
- The request may be sent at most once per `ready` on a given socket, but is safe to
  re-send on every reconnect and safe for the server to receive N times (§7).
- All client claims (`terminalId`, `sessionRef`, `resumeSessionId`, `status`) are
  **hints to be validated, never trusted** (assessment Option B, security row).

### 4.4 `pane.reconcile.result` (server → client)

```jsonc
{
  "type": "pane.reconcile.result",
  "reconcileId": "rec-8f2k…",          // echoed
  "bootId": "boot-…",                   // this server process's boot
  "serverInstanceId": "srv-…",
  "verdicts": [
    {
      "paneKey": "tab3:paneA",          // echoed verbatim, 1:1 with request order
      "verdict": "attach",              // attach | respawn | fresh | dead_session | retry | invalid
      "terminalId": "term-…",           // attach only: the live terminal to attach to
      "sessionRef": { "provider": "…", "sessionId": "…" },
          // attach: authoritative identity (fold into pane — this alone closes Incident 4)
          // respawn: THE identity to resume with (client passes it back on terminal.create)
          // dead_session: the claimed-but-missing identity, for the error UI
      "corrected": true,                // present iff server overrode a differing client claim
      "reason": "session_not_on_disk",  // fresh | dead_session | retry | invalid: machine-readable code
      "retryAfterMs": 2000              // retry only
    }
  ]
}
```

**Cardinality invariant:** `verdicts.length == panes.length`, matched 1:1 by `paneKey`.
Every presented pane gets exactly one verdict — a malformed entry gets `invalid` with a
reason, never omission (§8).

### 4.5 Versioning

- Additive fields on either frame: plain serde-tolerant evolution (both sides ignore
  unknown fields; the TS side has no runtime validation of server frames at all, §3).
- Breaking change: new capability name (`paneReconcileV2`) + new frame names. Never mutate
  v1 semantics in place; never touch `protocolVersion`.

## 5. Server-Side Reconciliation Algorithm

### 5.1 Inputs (all existing, all read-only)

| Source | What it answers | Anchor |
|---|---|---|
| `TerminalRegistry` | terminal live/exited, mode, `resume_session_id` | `crates/freshell-terminal/src/registry.rs:196-260` |
| `TerminalIdentityRegistry` | terminalId → `{provider, sessionId}`, **retire-preserving** (`get()` returns identity even after process exit) | `crates/freshell-ws/src/identity.rs` (get/list semantics in module doc) |
| Disk session index | does `provider:sessionId` exist on disk? | `crates/freshell-sessions` (`SessionIndex`; `Option` convention noted at `crates/freshell-ws/src/lib.rs:200-206`) |

Two additive server-side pieces (no wire impact):

1. **`create_request_id` stamped on the registry entry** at terminal create, **write-ahead**
   (recorded before `terminal.created` is emitted). Today the registry does not retain it
   (`TerminalShared`, `registry.rs:196-228` has no such field; the create handler only
   echoes it, `crates/freshell-ws/src/terminal.rs:753,1071`). New accessor:
   `newest_live_by_create_request_id(id) -> Option<TerminalId>` (newest generation wins —
   one pane can have had several terminal generations under the same key). This field is
   the idempotency keystone (§7).
2. **`SessionExistence` handle on `WsState`**: `exists(provider, session_id) ->
   Present | Absent | Unknown`. Backed by the shared session index, constructed in
   `freshell-server::main` and cloned in — the exact precedent of `identity` and the
   locator handles already on `WsState` (`lib.rs:114-122,200-217`). `Unknown` means the
   index is cold/unavailable (boot sweep not finished) and is what makes the `retry`
   verdict honest instead of guessing. Trait-shaped so crate tests inject a fake.

### 5.2 Per-pane derivation (pure function, no mutation)

```text
resolve_authoritative_ref(pane):
  1. identity.get(pane.terminalId)                  # server memory wins, even retired
  2. else pane.sessionRef                           # client claim, validated below
  3. else promote(pane.resumeSessionId, pane.mode)  # ONE uniform rule: {provider: mode, sessionId}
  -> Option<SessionRef>

verdict(pane):
  if pane malformed (no createRequestId / bad kind)        -> invalid(reason)
  T1 = registry.newest_live_by_create_request_id(pane.createRequestId)
  if T1 exists                                             -> attach(T1, identity.get(T1))
  T2 = registry.get(pane.terminalId) if pane.terminalId
  if T2 exists and live                                    -> attach(T2, identity.get(T2))
  # terminal dead or unknown from here on
  sref = resolve_authoritative_ref(pane)
  if sref is None:
      -> fresh(reason = 'no_recoverable_identity')          # shell panes; CLI panes with nothing to resume
  match disk.exists(sref):
      Present -> respawn(sref)
      Absent  -> dead_session(sref, reason = 'session_not_on_disk')
      Unknown -> retry(reason = 'index_warming', retryAfterMs)
```

`corrected: true` is set on `attach`/`respawn` whenever the returned `sessionRef` differs
from the client's claim — the server-wins rule that retires the client's `matchScore`
guessing. Step 3's single promotion rule deliberately replaces the six divergent
per-provider promotion matrices (cartography Part 5 weakness 1) with **one server-side
rule validated against disk** — a wrong promotion can no longer mint a phantom identity,
because a non-existent `provider:sessionId` yields an explicit `dead_session`, not a
silent grey pane.

### 5.3 Decision table (client-presented pane state × server state → verdict)

| # | Client claim | Registry (by `createRequestId`, then `terminalId`) | Identity/claim → disk | Verdict | Incident class closed |
|---|---|---|---|---|---|
| 1 | anything | **live terminal under this `createRequestId`** | — | `attach` (that terminal, authoritative ref) | double-restart / interrupted-respawn orphan (Inc. 2 compound) |
| 2 | `terminalId` T | T live | — | `attach(T)` + corrected ref | Inc. 4 (identity folded on attach) |
| 3 | `terminalId` T | T exited/unknown | identity registry (retired entry) or claim → **Present** | `respawn(sref)` | Inc. 1, Inc. 2 (server names the resume identity; client never guesses) |
| 4 | `terminalId` T | T exited/unknown | ref resolvable → **Absent** | `dead_session(sref)` | silent-blank class (I5): explicit, actionable |
| 5 | `terminalId` T | T exited/unknown | ref → **Unknown** (index cold) | `retry(retryAfterMs)` | boot-race class: never guess against a cold index |
| 6 | no `terminalId`, ref claim | no match | **Present** | `respawn(sref)` | restore-after-persist-cycle |
| 7 | no `terminalId`, ref claim | no match | **Absent** | `dead_session(sref)` | Thu incident class made loud |
| 8 | no `terminalId`, no ref, `mode=shell` | no match | — | `fresh` | (by design — shells are stateless) |
| 9 | no `terminalId`, no ref, CLI mode | no match | — | `fresh(reason='no_recoverable_identity')` | Inc. 2's "restored FRESH" becomes an *explicit, labeled* fresh, never a surprise |
| 10 | malformed entry | — | — | `invalid(reason)` | protocol hygiene |

The client's follow-up per verdict uses **only existing frames**: `attach` →
`terminal.attach`; `respawn` → `terminal.create {createRequestId, restore-style resume
with verdict.sessionRef}`; `fresh` → `terminal.create` plain; `dead_session`/`invalid` →
render explicit error state (I5); `retry` → leave pane untouched, re-request after
`retryAfterMs`. The handshake is **mechanism**: it answers "what is true"; what a client
does about `fresh` vs `dead_session` UI is policy that stays client-side.

## 6. Sequence Diagram

```text
 CLIENT (synthetic or adopted)                    RUST SERVER
   |                                                  |
   |-- WS connect ----------------------------------->|
   |-- hello {v7, token,                              |
   |          capabilities.paneReconcileV1:true} ---->|  evaluate_hello (lib.rs:368)
   |                                                  |
   |<-- ready {bootId, serverInstanceId,              |  build_handshake (lib.rs:321)
   |           capabilities.paneReconcileV1:true} ----|  (bytes unchanged for frozen client)
   |<-- settings.updated / perf.logging / [config.fallback]
   |<-- terminal.inventory ---------------------------|
   |                                                  |
   |-- pane.reconcile.request {reconcileId,           |
   |     panes:[{paneKey, createRequestId,            |
   |             terminalId?, sessionRef?, ...}]} --->|  READ-ONLY derivation:
   |                                                  |   registry × identity × disk (§5.2)
   |<-- pane.reconcile.result {reconcileId, bootId,   |
   |     verdicts:[attach|respawn|fresh|              |
   |               dead_session|retry|invalid]} ------|
   |                                                  |
   |   per verdict (existing frames only):            |
   |-- terminal.attach {terminalId} ----------------->|   (attach)
   |-- terminal.create {createRequestId,              |   (respawn/fresh;
   |                    resume=verdict.sessionRef} -->|    create stamps createRequestId
   |                                                  |    WRITE-AHEAD in registry)
   |<-- terminal.created {requestId, terminalId,      |
   |                      sessionRef} ----------------|
   |                                                  |
   X  ~~~~ interruption at ANY point above ~~~~       |
   |                                                  |
   |-- reconnect, hello, ready ---------------------->|
   |-- pane.reconcile.request (rebuilt from           |
   |     CURRENT client state — no latches) --------->|
   |<-- result: pane that already respawned now       |
   |     matches row 1 by createRequestId -> attach --|   (convergence, §7)
```

## 7. Idempotency Argument (why N interrupted handshakes converge)

The four incidents share one shape: a **one-shot mechanism interrupted mid-flight**
(assessment §1 meta-pattern). This protocol has no one-shot anything:

1. **The request is stateless and re-derivable.** It is built from the client's *current*
   state each time — no armed flags, no consumed tokens, nothing that a crash between
   "arm" and "settle" can strand (contrast `terminal-restore.ts`'s arm/peek/clear
   choreography, cartography weakness 5).
2. **The derivation is a pure read.** The server mutates nothing while computing verdicts
   (§5.2). Receiving the same request 1 or N times, on 1 or N sockets, is
   indistinguishable from receiving it once. There is no server-side handshake state
   machine to be left half-stepped.
3. **The only side effect in the whole flow is keyed and discoverable.** The single write —
   PTY creation on `respawn`/`fresh` — is stamped with the pane's `createRequestId`
   *before* `terminal.created` is emitted (write-ahead, §5.1). Therefore, for any
   interruption point:
   - before the create was sent → next handshake re-derives `respawn` identically;
   - after the create landed but before the client learned the `terminalId` → next
     handshake hits **row 1** (`newest_live_by_create_request_id`) and returns `attach`.
   Per pane, the verdict sequence is monotone: `retry* → (respawn | fresh)? → attach`, or
   `retry* → dead_session` (stable). It never oscillates and never double-spawns, because
   the write is discovered by the very mechanism that would otherwise repeat it.
4. **Stale results cannot mis-apply.** Results carry `{reconcileId, bootId}`; the client
   applies a result only if it matches the latest in-flight `reconcileId` on the current
   socket epoch. A result crossing a reconnect boundary is dropped; the new connection's
   handshake supersedes it. Absence of a result is never acted on (§8) — the failure
   posture is "keep current state and re-present," not "guess."
5. **Fixpoint.** With unchanged server state, the derivation is deterministic, so repeated
   handshakes return identical verdicts. Every pane reaches one of the absorbing states
   {attached, dead_session-rendered, fresh-settled} in at most one `respawn` round —
   under any interleaving of N disconnects, server restarts, or duplicated requests.

Two browser tabs presenting the same pane both resolve to `attach` on the same terminal
(multi-subscriber fan-out is existing behavior, `registry.rs:230-240`). The narrow race of
two clients concurrently sending the *first* `terminal.create` for one `createRequestId`
predates this design and is out of scope; the optional hardening (idempotent create) is
fenced in §11 and the handshake reduces its window to near-zero by making blind create
re-sends unnecessary.

## 8. Failure Semantics (explicit verdicts, never silence)

- **Total cardinality:** every presented pane gets exactly one verdict; malformed entries
  get `invalid{reason}` rather than being dropped. A client can assert
  `verdicts.length === panes.length` as a runtime invariant (Option D synergy).
- **Cold index is honest:** `retry{reason:'index_warming', retryAfterMs}` — the server
  never converts "I don't know yet" into `dead_session` (which would be data-loss-shaped)
  or into optimistic `respawn` (which would resurrect Incident-1 blanks).
- **Frame-level failure:** if derivation itself fails (poisoned lock, index handle error),
  the server sends the standard `error` frame with code `RECONCILE_UNAVAILABLE` and the
  `reconcileId`; the client keeps its current state and may re-send. Codes:
  `RECONCILE_TOO_LARGE`, `RECONCILE_UNAVAILABLE` — additive `ErrorCode` variants.
- **No response at all** (old server, dropped socket): the adopting client only ever waits
  for a result when `ready` advertised the capability; otherwise the legacy path runs.
  Either way, silence ≠ action.
- **`dead_session` is a UI state, not a deletion:** the server asserts the fact; the client
  renders an explicit, actionable error (invariant I5). Nothing is auto-closed. Disk is
  never touched.

## 9. Synthetic-Client Test Plan (Phases 1–2, no frozen-client involvement)

### 9.1 Crate level — `crates/freshell-ws/tests/pane_reconcile.rs`

Raw-WS (tungstenite) integration tests against an in-process server, following the
established pattern (`hello_timeout.rs`, `keepalive.rs`, `origin_policy.rs`,
`max_payload.rs`). The registry supports headless terminals for exactly this
(`registry.rs:286-288`); the identity registry is seeded directly; `SessionExistence` is a
test fake per §5.1.

1. **Negotiation:** hello *without* the capability → `ready` has no `capabilities` field
   and the full handshake is byte-identical to the pinned clean-boot handshake (the
   frozen-client inertness proof, at wire level). Hello *with* it → advertised.
2. **Decision table:** one test per row of §5.3 (table-driven over the pure verdict
   function for the matrix; wire-level spot checks for rows 1, 3, 7).
3. **Cardinality + opacity:** N panes in → N verdicts out, `paneKey` echoed verbatim
   including hostile strings; order preserved.
4. **Idempotency:** (a) same request twice on one socket → byte-identical results;
   (b) request → `respawn` verdict → `terminal.create` → **disconnect before
   `terminal.created` is read** → reconnect → re-present pane without `terminalId` →
   verdict is `attach` to the already-spawned terminal (row 1). This is the Incident-2
   regression test at protocol level.
5. **Write-ahead ordering:** `create_request_id` is queryable in the registry before the
   `terminal.created` frame is observable on any socket.
6. **Honest unknowns:** `SessionExistence::Unknown` → `retry` with `retryAfterMs`; never
   `dead_session`.
7. **Limits + errors:** 201 panes → `RECONCILE_TOO_LARGE`; injected index failure →
   `RECONCILE_UNAVAILABLE` carrying the `reconcileId`.
8. **Trust boundary:** client claims a `sessionRef` contradicting the identity registry →
   verdict carries the server's ref + `corrected: true`.

### 9.2 E2E — `test/e2e-browser` (PW-RUST, HARNESS-01)

The Playwright harness owns the real Rust server — "its isolated home, fixtures, exact
PID, restart, and teardown" (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md:75`).
The synthetic client is a raw Node `WebSocket` inside the spec (no SPA involvement),
driving the real server + real fixture home directories:

1. **Server restart (Incident 1/2 shape):** create real PTY terminals (one shell, one
   resumed CLI with a fixture session file), harness-restart the server, reconcile →
   shell gets `fresh`, CLI gets `respawn` with the correct `sessionRef`; complete the
   respawn; reconcile again → `attach`.
2. **Double restart / interrupted round:** restart, send request, kill the server between
   request and result, restart again, re-request → convergent verdicts, exactly one live
   PTY per `createRequestId` at the end (assert via `/api/terminals`).
3. **WSL-restart equivalence:** same as (1) — registry emptied, disk intact — asserted as
   its own named scenario so the assessment's latent compound mode gets an explicit test.
4. **Server+browser simultaneous analogue:** synthetic client discards all pre-restart
   state except its persisted-shape pane list (simulating a refreshed browser), then
   reconciles → identical outcome to (1); proves the protocol needs no client memory
   beyond the persisted layout.
5. **Dead session:** fabricated `sessionRef` → `dead_session`, and the session directory
   on disk is untouched afterward.
6. **Frozen-client regression:** the existing PW-RUST spec suite passes unchanged against
   the reconcile-capable server (e2e-level inertness).

## 10. Later Client Adoption (sketch, sized against the 8-file deviation budget)

Ships separately, on main, after Phases 1–2 prove the server. Gated end-to-end on
`ready.capabilities.paneReconcileV1` — with an old server the client behaves exactly as
today.

| # | File | Change |
|---|---|---|
| 1 | **NEW** `src/lib/pane-reconcile.ts` | Build request from Redux/persisted pane state; fold verdicts into *existing* reducers: `attach` → `reconcileTerminalSessionAssociation` (`src/lib/terminal-session-association.ts:62-141`) + attach flow; `respawn`/`fresh` → the create path with server-named identity; `dead_session` → the existing `restoreError` rendering (`RESTORE_UNAVAILABLE` family). Cardinality invariant checker lives here (Option D). |
| 2 | `src/lib/ws-client.ts` | Surface `ready.capabilities`; suppress the blind `inFlightCreates` re-send on reconnect (`ws-client.ts:193-203`) for panes under reconcile (verdicts, not resends, decide). Small; follows the `helloExtensionProvider` precedent. |
| 3 | `src/App.tsx` | On ready-with-capability: send request, apply folds; gate the legacy inventory-reconcile loop (`App.tsx:976-991`) behind `!paneReconcileV1`. |
| 4 | `src/lib/terminal-restore.ts` | Bypass the arm/peek latch entirely when the capability is active (deletion candidate in the cleanup phase). |
| 5 | `src/components/TerminalView.tsx` | Respawn path consumes `verdict.sessionRef` for resume args instead of local inference. |

**5 deviation files (4 modified + 1 new) of the 8-file budget.** `session-utils.ts`
(`matchScore` shrink) and `sidebarSelectors.ts` are deliberately *not* touched at adoption
time — they keep working on the now-always-correct `sessionRef`s and die later in the
Option-E convergence phase, measured in lines removed (assessment §11). The TS protocol
mirror (`shared/ws-protocol.ts`) gains the two frame schemas in the same PR — it is frozen
*for this port branch*, not on main.

## 11. NOT-to-Build Fences

- **ONE handshake, not a sync framework.** One request per `ready` (re-send only on
  reconnect or `retry`). No continuous diffing, no subscriptions, no server-pushed
  reconcile — the server never volunteers a result.
- **No server-side layout knowledge.** `paneKey` is opaque; no tab verdicts, no pane-tree
  echo, no cosmetic fields (titles, order, splits) on the wire. Cosmetics stay
  client-authoritative (assessment §5.2, fence 3).
- **No `terminal.create` semantic change in v1.** Idempotent-create-by-`createRequestId`
  is a possible later hardening for the multi-client first-create race (§7); recorded as
  residual, not built — the frozen client's create flow must not change under it.
- **No `protocolVersion` bump.** Capability-gated only.
- **No fresh-agent verdicts in v1.** Mapping sketched in §12; terminal panes prove the
  protocol first.
- **No persistence schema bump.** `layout.v3` untouched; the request is derived from
  existing persisted fields.
- **No retry/queue machinery.** The reconnect-and-re-present loop *is* the retry. No
  server-side pending-verdict state, no acks, no sequence numbers beyond `reconcileId`.
- **No multi-user ownership model.** Server-side validation of client claims (§5.2) is
  required; tenancy is not (assessment fence 6).

## 12. Fresh-Agent Extension (sketch only, deferred)

`kind: "fresh-agent"` panes present `{provider, resumeSessionId/sessionRef}`; the server
consults the `FreshAgentRuntimeManager` live sessions (≙ registry) and provider durable
stores (claude JSONL / codex durability / opencode sidecar sessions ≙ disk index). The
verdict set and idempotency argument carry over unchanged: `attach` ≙ `freshAgent.attach`,
`respawn` ≙ `freshAgent.create` with resume. Codex's durability-proof machinery stays
where it is; the handshake would only *name* the identity, exactly as for terminals.

## 13. Rollout & Effort

| Phase | Where | Contents | Ships alone? | Size |
|---|---|---|---|---|
| **1. Server + protocol** | this branch (Rust only) | protocol frames + capability plumbing; registry `create_request_id` stamp (write-ahead) + accessor; `SessionExistence` handle; pure verdict function + WS handler; unit tests | Yes — provably inert (§3, test 9.1.1) | **M** — ~5 TDD tasks: protocol types; registry stamp; existence handle; verdict fn (table-driven); wire handler |
| **2. Synthetic-client proof** | this branch | crate tests §9.1 + PW-RUST specs §9.2 (restart / double-restart / WSL / dead-session) | Yes | **S–M** — ~4 tasks; harness restart support already exists |
| **3. Client adoption** | later, on main | §10, 5 deviation files, capability-gated, legacy path intact behind the gate | Yes — old servers unaffected | **M** — ~5 tasks + e2e with the real SPA |
| **4. Deletion (Option E convergence)** | later, on main | remove `terminal-restore.ts` latch, legacy inventory loop, shrink `matchScore` | Yes | **S** — success measured in lines removed |

**Tradeoff summary** (per the assessment's Option-B row, now concretized): optimizes for
server-authoritative linkage and self-healing reconnects at the cost of one extra
round-trip per connect (amortized, O(open panes)) and one new protocol contract. What it
sacrifices — a heavier connect path and a contract that must be honored long-term — is
bounded by the three-gate rollout and the fences above. What would make this the wrong
choice: if the identity-stamping lane (assumption 1) stalls, rows 2–3 of the decision
table lose their authoritative source and the design must wait — the handshake without
stamped identity would just relocate the guessing, not remove it.
