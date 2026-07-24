# Reconnection-Reconciliation Handshake — Design

**Date:** 2026-07-22
**Branch:** `feat/rust-tauri-port` (worktree `.worktrees/rust-tauri-port`, designed at HEAD `75019af0`)
**Mode:** DESIGN (keystone Option B of `2026-07-19-state-sync-resilience-assessment.md`)
**Companion state map:** `2026-07-19-state-sync-cartography.md`
**Revision:** council-review pass 2026-07-22, re-anchored at HEAD `3310817f` (all `file:line`
anchors below re-verified against that HEAD; drift corrected inline).

> One protocol replaces the N ad-hoc client-side latches: on every WS (re)connect the client
> *presents* its pane view; the server answers with an authoritative per-pane **verdict**
> derived from the terminal registry + identity registry + disk session index. The client
> stops guessing. The exchange is a pure read on the server and is safe to repeat any
> number of times — which is the entire idempotency story.

---

## 0. Council Review (2026-07-22)

**Verdict: implement-with-changes — unanimous, no redesign.** Six review lenses over two
rounds of cold fan-out → debate-to-consensus. No lens voted to redesign or block; every lens
converged on "the shape is right; land it with the fixes below." This revision folds the
seven required changes into the affected sections (decision table §5.3, idempotency argument
§7, test plan §9, fences §11, phases §13, invariants §8).

**Headline debate — the two-tab double-respawn blocker (→ consensus fix #1).** The council
found that §7's original claim — that the handshake "reduces [the blind-create race] window
to near-zero" — was *inverted*. The handshake does not shrink that window; it **synchronizes**
the two creates: two browser tabs that both reconcile after a restart are both told `respawn`
for the *same* `createRequestId`, and each fires its own `terminal.create`. The result is two
live PTYs on one `createRequestId`, i.e. **two JSONL writers appending to one session file** —
the precise data-loss shape this whole design exists to prevent. Consensus fix: promote the
idempotent-create-by-`createRequestId` hardening from "later, out of scope" into a **v1,
capability-gated, server-side single-flight create-dedupe** (change #1). This was the only
finding that rose to blocker status, and its fix is the load-bearing change in this revision.

**Standing tradeoff awaiting the user.** One decision is deliberately left OPEN for the user
(change #4a): the `retry`-verdict mechanism. The majority favors keeping the tri-state
(`retry` split into transient `index_warming` vs permanent `index_unavailable`); Sam's
minimal-design dissent argues to delete `retry` from the wire entirely (bounded server-side
wait, then a plain `RECONCILE_UNAVAILABLE` error). Both are council-stable — the design is
correct under either. This is a **USER DECISION PENDING**, recorded fairly in §5.3/§8 rather
than silently resolved here.

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

1. **Identity stamping has (partly) landed** (parallel lane, per brief constraint d): the
   server stamps canonical `sessionRef` on REST resume creates and terminal frames as of
   **commit `80772ff2`** ("stamp canonical sessionRef on REST resume creates and terminal
   frames"), so the `TerminalIdentityRegistry` (`crates/freshell-ws/src/identity.rs`) is
   populated for resumed terminals, and the `inventory()` `session_ref: None` placeholder now
   survives at only one site (`crates/freshell-terminal/src/registry.rs:258`; the second,
   formerly cited at `:631`, was replaced when `TerminalRegistry::create` took a real
   `session_ref` parameter — `registry.rs:588-665`). This design *reads* that registry; it
   does not build it.
   **Phase-1 ACCEPTANCE CHECK (not a recital):** Phase 1 must *verify*, not assume, that the
   REST-created-resume identity path is resolvable across the crate boundary. The gap is
   documented in the code itself: `IdentityProbeRow.resume_session_id`
   (`crates/freshell-terminal/src/registry.rs:273-278`) exists precisely because "REST-created
   resumes … can't reach the WS-owned identity registry across the crate boundary." Phase 1's
   acceptance is a test proving a REST-created resumed terminal reconciles to `respawn`/`attach`
   with the correct `sessionRef` — i.e. the derivation reads identity via the registry-side
   `resume_session_id` when the WS identity registry has no entry. If that check fails, rows
   2–3 lose their authoritative source for REST-origin panes and adoption must wait.
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
   (AGENTS.md pane-system contract; `paneTypes.ts:76`). **This is now an enforced contract,
   not a hope** (§5.5): the server rejects/flags duplicate keys within one reconcile request,
   and the two current codebase violations — `persistMiddleware.ts:229` re-minting on hydrate
   and REST ingress minting none — are recorded as **preconditions to fix/account before the
   §10 adoption phase.**

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
          // attach: authoritative identity (fold into pane — REINFORCES the Incident-4
          //         closure already landed in commit 80772ff2; not the sole closer)
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

1. **`create_request_id` stamped on the registry entry, ATOMICALLY with the registry
   insert.** The key is a field on `TerminalRegistry::create` (`registry.rs:499`), written
   **under the same registry lock that inserts the `TerminalShared` row** (`registry.rs:169`)
   — *not* merely "recorded before the `terminal.created` emit." Ordering-before-emit is not
   enough: it leaves an interleave in which a second concurrent create observes the inserted
   row **before** the key is attached to it, and the single-flight dedupe (§5.4) misses. Only
   set-under-the-insert-lock makes the key visible to any observer exactly when the row is.
   Today the registry does not retain the key at all (`TerminalShared`, `registry.rs:169` has
   no such field; the create handler only echoes it back on the wire,
   `crates/freshell-ws/src/terminal.rs:753,1105`). Two new accessors, both scanning **newest
   generation first** — a pane can have had several terminal generations under one key:
   - `newest_live_by_create_request_id(id) -> Option<TerminalId>` — the newest **live**
     terminal for the key. **Stamped-but-spawn-failed rows are excluded** (a row inserted
     with the key whose PTY spawn then failed must never be returned as live — §9.1 names
     this test). Idempotency keystone (§7) and single-flight dedupe key (§5.4).
   - `newest_by_create_request_id(id) -> Option<TerminalId>` — the newest terminal for the
     key **INCLUDING exited generations**, used by §5.2 to recover a retired terminal's
     retained identity before declaring `fresh`.
2. **`SessionExistence` handle on `WsState`**: `exists(provider, session_id) ->
   Present | Absent | Unknown`, with **defined semantics**: `Present`/`Absent` require a
   **known provider** whose index has been consulted; an **unknown provider** returns
   `Absent`/`invalid` (never `Unknown`) — `Unknown` is reserved strictly for a *cold index on
   a known provider*, never for "I don't recognize this provider." Backed by the shared
   session index, constructed in `freshell-server::main` and cloned in — the exact precedent
   of `identity` and the locator handles already on `WsState` (`lib.rs:114-122,200-217`).
   `Unknown` (cold/unavailable index, boot sweep not finished) is what makes the `retry`
   verdict honest instead of guessing — *pending the retry-mechanism decision in §5.3 / change
   #4a*. Trait-shaped so crate tests inject a fake; §9.1 adds **one real-index staleness
   test** (a `provider:sessionId` written to disk after a cold read must resolve `Present` on
   re-query, never latch a stale `Absent`).

### 5.2 Per-pane derivation (pure function, no mutation)

```text
resolve_authoritative_ref(pane):
  1. identity.get(pane.terminalId)                       # server memory wins, even retired
  2. else identity.get(newest_by_create_request_id(k))   # retired identity of the newest
                                                         #   EXITED generation for this key
                                                         #   (identity.rs preserves entries
                                                         #    across retirement)
  3. else pane.sessionRef                                # client claim, validated below
  4. else promote(pane.resumeSessionId, pane.mode)       # ONE uniform rule: {provider: mode, sessionId}
  -> Option<SessionRef>

verdict(pane):
  if pane malformed (no createRequestId / bad kind)        -> invalid(reason)
  k  = pane.createRequestId
  T1 = registry.newest_live_by_create_request_id(k)        # newest LIVE for the key
  T2 = registry.get(pane.terminalId) if pane.terminalId and live
  # 'both live': client is attached to a live T2 while a NEWER duplicate generation T1
  # exists for the same key. Prefer the client's live attached terminal; flag the
  # duplicate. NEVER silently switch the client to T1 out from under a live attachment.
  if T1 and T2 and T1 != T2  -> attach(T2, identity.get(T2), duplicate = T1)   # + flag
  if T1 exists               -> attach(T1, identity.get(T1))
  if T2 exists               -> attach(T2, identity.get(T2))
  # no LIVE terminal for this key from here on — recover a retired identity if one exists
  sref = resolve_authoritative_ref(pane)                   # step 2 consults the EXITED gen
  if sref is None:
      -> fresh(reason = 'no_recoverable_identity')          # shell panes; CLI with nothing to resume
  match disk.exists(sref):
      Present -> respawn(sref)          # subject to the respawn-generation cap (§7.5)
      Absent  ->
          if identity_ever_observed_on_disk(sref)  -> dead_session(sref, reason='session_not_on_disk')
          else                                     -> fresh(reason='identity_never_observed')
          # dead_session is gated on the identity having been SEEN on disk at least once.
          # A ref the index has NEVER observed (e.g. a stale/typo client claim) falls
          # through to fresh, not dead_session — we never raise a data-loss-shaped verdict
          # for an identity disk has no memory of.
      Unknown -> retry(reason = 'index_warming', retryAfterMs)   # OPEN — §5.3 retry note / change #4a
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
| 2b | `terminalId` T (client **live-attached** to T) | T live **and** a *newer* duplicate generation T′ exists under the same `createRequestId` | — | `attach(T)` + **flag duplicate T′** (`duplicate: T′`) | **both-live**: prefer the client's live attached terminal; never silently switch it to T′ (invariant I6) |
| 3 | `terminalId` T | T exited/unknown | identity registry (retired entry, incl. exited gen) or claim → **Present** | `respawn(sref)` | Inc. 1, Inc. 2 (server names the resume identity; client never guesses) |
| 4 | `terminalId` T | T exited/unknown | ref resolvable, **identity ever seen on disk** → **Absent** | `dead_session(sref)` | silent-blank class (I5): explicit, actionable |
| 4b | `terminalId` T | T exited/unknown | ref resolvable, **identity NEVER observed on disk** → **Absent** | `fresh(reason='identity_never_observed')` | stale/typo claim: never raise a data-loss-shaped verdict for an identity disk never saw |
| 5 | `terminalId` T | T exited/unknown | ref → **Unknown** (index cold) | `retry(retryAfterMs)` **[OPEN — §5.3 note / change #4a]** | boot-race class: never guess against a cold index |
| 6 | no `terminalId`, ref claim | no match | **Present** | `respawn(sref)` | restore-after-persist-cycle |
| 7 | no `terminalId`, ref claim | no match | **Absent**, identity ever seen on disk | `dead_session(sref)` | Thu incident class made loud |
| 8 | no `terminalId`, no ref, `mode=shell` | no match | — | `fresh` | (by design — shells are stateless) |
| 9 | no `terminalId`, no ref, CLI mode | no match | — | `fresh(reason='no_recoverable_identity')` | Inc. 2's "restored FRESH" becomes an *explicit, labeled* fresh, never a surprise |
| 10 | malformed entry | — | — | `invalid(reason)` | protocol hygiene |

**Single-flight create-dedupe (change #1) applies before rows 3/6 ever produce a second
PTY.** When two reconciling connections both receive `respawn` for the same
`createRequestId` (guaranteed identical by the pure-read derivation), the *first*
`terminal.create` spawns and stamps the key; the *second*, on any `paneReconcileV1`
connection, hits `newest_live_by_create_request_id` at the top of `handle_create` (§5.4) and
adopts the existing terminal instead of spawning a duplicate. Rows 3/6 therefore converge to
row 1 on the very next reconcile even under concurrency.

**Retry row is OPEN (change #4a).** Row 5's `retry` verdict is a **USER DECISION PENDING**:
either keep the tri-state (`retry` split into transient `index_warming` → bounded-budget
retry vs permanent `index_unavailable` → explicit terminal verdict) — the council majority —
or delete `retry` from the wire entirely in favor of a bounded server-side wait then a plain
`RECONCILE_UNAVAILABLE` error (Sam's minimal design). §8 records both fairly; the rest of the
table is invariant under the choice.

The client's follow-up per verdict uses **only existing frames**: `attach` →
`terminal.attach`; `respawn` → `terminal.create {createRequestId, restore-style resume
with verdict.sessionRef}`; `fresh` → `terminal.create` plain; `dead_session`/`invalid` →
render explicit error state (I5); `retry` → leave pane untouched, re-request after
`retryAfterMs`. The handshake is **mechanism**: it answers "what is true"; what a client
does about `fresh` vs `dead_session` UI is policy that stays client-side.

### 5.4 Single-flight create-dedupe (v1, capability-gated) — the two-tab blocker fix

The council's one blocker-class finding (§0) is closed here, not deferred. On `handle_create`
(`crates/freshell-ws/src/terminal.rs:726`), **for connections that negotiated
`paneReconcileV1` only**, the handler first consults
`newest_live_by_create_request_id(create.createRequestId)`:

- **hit** (a live terminal already carries this key): the handler **adopts** it — it emits
  `terminal.created` naming the *existing* `terminalId` (the same frame shape the client
  already expects) and spawns **nothing**. This is the single-flight guarantee: two
  reconciling connections that both received `respawn` for one key converge to one PTY.
- **miss**: the normal spawn path runs and stamps the key atomically with the insert (§5.1).

**The frozen client is byte-for-byte untouched.** The dedupe is gated on the capability the
frozen client never negotiates, so its `terminal.create` flow is entirely unchanged; only an
adopting (`paneReconcileV1`) connection can take the adopt branch. This respects fence
"No `terminal.create` semantic change for the frozen client" (§11) while still closing the
double-respawn data-loss path for adopters.

**Backstop detector (always-on, capability-independent).** Independently of the gate, the
registry gains a `≥2-live-PTYs-per-create-request-id` check: whenever a create completes,
if the key now has two or more live terminals, emit a telemetry/warn event
(`ws.reconcile.duplicate_pty`, carrying the key and both `terminalId`s). This makes any
residual violation — from a race the dedupe missed, or a non-adopting path — **loud**
rather than a silent second JSONL writer. It is the observability floor under the invariant,
not a substitute for the dedupe.

**Why this is correct, not just defensive.** The idempotency argument (§7) already proves the
verdict sequence converges; the dedupe closes the one remaining write-side gap that
convergence alone could not, because two *correct* `respawn` verdicts legitimately arrive
concurrently. The dedupe is the write-side dual of the read-side pure derivation: reads
agree, and now writes single-flight.

### 5.5 `createRequestId` is a contract — and the codebase currently violates it twice

Row 1 and the single-flight dedupe both rest on Assumption 6: `createRequestId` is **unique
per pane and stable across that pane's terminal generations**. This revision promotes that
from a stated assumption to an **enforced contract**, and records the two places the current
codebase breaks it — both of which must be fixed or explicitly accounted **before the
frozen-client adoption phase (§10)**, because they silently defeat row-1 matching on the exact
paths reconciliation depends on.

**Server-side enforcement (Phase 1).** Within one `pane.reconcile.request`, two panes
carrying the **same** `createRequestId` are a contract violation: the server rejects/flags the
duplicate rather than emitting two independent verdicts that could each drive a
`terminal.create` (§9.1 test 14). Uniqueness within a request is cheap to check and is the
server's half of the contract.

**Two client-side violations to fix/account before adoption:**

1. **`src/store/persistMiddleware.ts:229` re-mints on hydrate.** The hydration normalizer
   does `createRequestId: content.createRequestId || nanoid()` — so any persisted terminal
   pane that lacks a stored key gets a **fresh `nanoid()` on every load**. That is precisely
   the restore path reconciliation must match on: a pane that hydrates with a new key each
   time can never hit row 1, silently degrading `attach` to `respawn`/`fresh`. Adoption must
   guarantee a **stable, persisted** `createRequestId` (mint-once, never re-mint on hydrate).
2. **REST ingress mints none.** Panes/terminals created via the REST agent API do not carry a
   `createRequestId` at all, so their identity cannot be matched by row 1. Adoption must
   either mint-and-persist a stable key at REST ingress or explicitly document these panes as
   out-of-scope for reconciliation (and why that is safe).

Both are **client/edge** fixes that land with §10, not Phase-1 server work — but they are
recorded here as contract preconditions so adoption does not silently ship a defeated row 1.

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
   under any interleaving of N disconnects, server restarts, or duplicated requests. **This
   "at most one respawn" claim holds only with the respawn-generation cap of §7.5**; without
   it the corrupt-JSONL case below breaks the bound.

### 7.5 Respawn-generation cap (makes "at most one respawn" true, not aspirational)

Point 5's bound assumes a `respawn` produces a *live* terminal that the next handshake sees
via row 1. One case violates that assumption: a **respawn ↔ instant-exit loop**. If the
resumed session's JSONL is corrupt (or the CLI exits immediately on resume for any reason),
the spawned PTY dies before the next reconcile, so the next handshake sees no live terminal,
re-derives `respawn`, and loops. The verdict is *stable* but the system *thrashes* — it never
reaches an absorbing state.

The cap closes this: the registry tracks a **respawn-generation counter per
`createRequestId`** (bounded, e.g. 3). Once a key has spawned N generations that each exited
within a short liveness window, the derivation stops returning `respawn` and instead returns
`dead_session(reason='respawn_exhausted')` — a **terminal state with a defined user exit
affordance** (§8, invariant I7). This converts an infinite `respawn` loop into a single,
labeled, actionable terminal verdict, restoring the point-5 bound as a *guarantee* rather than
a best case. The counter resets when a generation survives the liveness window (a healthy
resume is not penalized).

Two browser tabs presenting the same pane both resolve to `attach` on the same terminal
*when a live terminal already exists* (multi-subscriber fan-out is existing behavior,
`registry.rs:230-240`). But the harder case — **both tabs reconcile after a restart with no
live terminal** — is where the naive story failed council review, and it is corrected here.

**Correction (council finding — the original "reduces its window to near-zero" claim was
inverted).** The handshake does not shrink the two-concurrent-create race; it **synchronizes
it into certainty**. After a server restart, two browser tabs presenting the same pane both
receive `respawn` for the *same* `createRequestId` (the derivation is a deterministic pure
read — §7.2 — so both get identical verdicts), and each fires its own `terminal.create`.
Absent a server-side guard, that yields **two live PTYs on one `createRequestId`**, i.e. two
JSONL writers appending to a single session file — the precise data-loss shape this entire
design exists to prevent. The handshake makes the two creates *agree on identity*, which is
exactly what turns a rare blind-resend race into a reliable double-respawn.

The fix is not "hope it's rare" — it is the **capability-gated single-flight create-dedupe**
specified in §5.4: on `paneReconcileV1` connections only, `handle_create` first consults
`newest_live_by_create_request_id` and, if a live terminal already exists for that key,
adopts it (emits `terminal.created` for the existing terminal) instead of spawning a second.
This collapses `retry* → respawn → attach` even across two concurrent reconciling
connections. The `≥2-live-PTYs-per-key` detector (§5.4) is the backstop that makes any
residual violation loud rather than silent.

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

### 8.0 OPEN — the `retry` mechanism (USER DECISION PENDING, change #4a)

Both options below are council-stable: the rest of the design is invariant under the choice.
Presented fairly, no default pre-selected here:

- **Option A — keep the tri-state (council majority).** `retry` stays on the wire, but split
  into two honest sub-cases: **transient `index_warming`** (the boot sweep is still running)
  → client retries under a **bounded budget** (finite attempts / total time), and **permanent
  `index_unavailable`** (the index cannot be built) → an **explicit terminal verdict** the
  client renders like `dead_session`, with an exit affordance (I7). Optimizes for the honest
  "I don't know yet vs I can't know" distinction; costs one more wire state and a client
  retry loop.
- **Option B — delete `retry` from the wire (Sam's minimal design).** No `retry` verdict at
  all. On a cold index the server does a **bounded server-side wait** for the sweep, then
  either answers with the now-warm verdict or emits a plain `RECONCILE_UNAVAILABLE` error
  frame (§8, already specified). Optimizes for a smaller protocol surface and no client retry
  machinery; costs a held request during the wait and coarser signal (one error for both
  transient and permanent).

Until the user decides, §5.2/§5.3 show `retry(index_warming)` as a placeholder; adopting
Option B collapses row 5 into the existing `RECONCILE_UNAVAILABLE` path with **no other table
change**.

### 8.1 User-facing invariants (named, enforceable)

These are the user-observable guarantees the design owes; each is testable (§9) and each has a
defined exit — **no verdict ever strands the user in an error state with no way out.**

- **I5 — No silent blank.** Every unrecoverable pane surfaces an *explicit, labeled* state
  (`dead_session` / `fresh(reason=…)` / `invalid`), never a mystery grey pane. (Pre-existing;
  restated here as the parent of I6/I7.)
- **I6 — No silent identity replacement.** The server never swaps the identity of a pane the
  user is *actively attached to* out from under them. When a live client attachment (T) and a
  newer duplicate generation (T′) both exist for one `createRequestId`, the verdict keeps the
  user on **T** and merely *flags* T′ (`duplicate: T′`); it does not switch, and it does not
  silently `corrected`-rewrite a live attachment's identity to a different session. Row 2b and
  §5.4's dedupe are the two halves of this invariant (read-side: don't switch; write-side:
  don't create a second). **User sees:** their session continues uninterrupted, optionally
  with a non-destructive "a duplicate was detected and ignored" affordance.
- **I7 — Every terminal verdict has an exit affordance.** The two absorbing "bad" states are
  defined in user terms, never as a dead-end error:
  - `dead_session` (session gone / never on disk): the pane renders an explicit card — *"This
    session is no longer available on disk"* — with a **Start fresh here** action (fires a
    plain `terminal.create` reusing the same `createRequestId`) and a **Close pane** action.
    Nothing is auto-closed; disk is untouched.
  - `dead_session(reason='respawn_exhausted')` (the §7.5 respawn-generation cap fired): the
    pane renders *"This session kept exiting on resume and was stopped after N attempts"* with
    the same **Start fresh here** / **Close pane** affordances, plus a link to the last exit
    output. The cap turns an infinite respawn loop into this single, escapable terminal state.
  Neither state is an opaque error toast; both are panes the user can act on or dismiss.

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
5. **Atomic stamp — insert-edge interleave (replaces the old write-ordering test):** two
   concurrent `create`s for the same `createRequestId` race the registry insert; assert the
   key is visible on the row **at the instant the row is observable** (never a window where a
   row exists without its key), so a second observer's `newest_live_by_create_request_id`
   either sees no row or sees the row-with-key — never row-without-key. This is the
   set-under-the-insert-lock guarantee of §5.1, not mere ordering-before-emit.
6. **Honest unknowns:** `SessionExistence::Unknown` (cold index, known provider) → `retry`
   with `retryAfterMs`; never `dead_session`. **Unknown provider** → `Absent`/`invalid`,
   **never** `Unknown` (change #4c).
7. **Limits + errors:** 201 panes → `RECONCILE_TOO_LARGE`; injected index failure →
   `RECONCILE_UNAVAILABLE` carrying the `reconcileId`.
8. **Trust boundary:** client claims a `sessionRef` contradicting the identity registry →
   verdict carries the server's ref + `corrected: true`.
9. **Spawn-failed exclusion (named):** a row inserted with `createRequestId` whose PTY spawn
   then fails is **never** returned by `newest_live_by_create_request_id` — assert the next
   reconcile re-derives `respawn`/`fresh`, not a phantom `attach` to a dead handle.
10. **Single-flight create-dedupe (change #1):** on a `paneReconcileV1` connection, a
    `terminal.create` for a `createRequestId` that already has a live terminal **adopts** it
    (emits `terminal.created` for the existing `terminalId`, spawns nothing); on a
    non-negotiating connection the legacy spawn path is byte-for-byte unchanged.
11. **Exited-generation identity recovery (change #2):** newest generation for the key has
    **exited**; its retired identity (`identity.rs` preserved) drives `respawn(sref)` — not
    `fresh`. Paired: an identity the index has **never observed** → `fresh(identity_never_
    observed)`, **never** `dead_session`.
12. **Both-live (change #2):** client presents live-attached T while a newer duplicate T′
    exists for the key → verdict is `attach(T, duplicate: T′)`; assert the client is **not**
    switched to T′ (invariant I6).
13. **Real-index staleness (change #4c):** against a real `SessionIndex`, a `provider:
    sessionId` written to disk after a cold read resolves `Present` on re-query — no latched
    stale `Absent`.
14. **`createRequestId` contract (change #5):** two panes in **one** request carrying the
    **same** `createRequestId` → the server rejects/flags the duplicate (per §5.5), rather
    than silently emitting two independent verdicts that could each drive a create.
15. **Respawn-generation cap (change #4b):** a fixture whose resume exits within the liveness
    window N+1 times → the (N+1)th derivation returns `dead_session(respawn_exhausted)`, not
    another `respawn`; a healthy resume resets the counter.

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
7. **Two concurrent reconciling connections (change #1 — the two-tab blocker):** two raw
   `WebSocket` connections, both `paneReconcileV1`, present the **same** `createRequestId`
   after a server restart. Both receive `respawn` for that key; both fire `terminal.create`.
   Assert **≤ 1 live PTY** for the key afterward (via `/api/terminals`) and that the second
   create took the adopt branch (§5.4) — i.e. exactly one JSONL writer on the session file.
   This is the direct regression test for the data-loss shape the council flagged as the sole
   blocker.

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
- **No `terminal.create` semantic change *for the frozen client* in v1.** The single-flight
  create-dedupe-by-`createRequestId` (§5.4) **is built in v1** — the council found the
  two-tab double-respawn to be a data-loss blocker (§0), so it is no longer deferred. But it
  is strictly **capability-gated**: only `paneReconcileV1` connections can take the adopt
  branch, so the frozen client's create flow is byte-for-byte unchanged. What stays fenced
  out is any *unconditional* create-semantics change and any change to the frozen client's
  path.
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
| **1. Server + protocol** | this branch (Rust only) | protocol frames + capability plumbing; registry `create_request_id` stamp (**atomic-with-insert**, §5.1) + both accessors; single-flight dedupe (§5.4) + `≥2-live-PTY` detector; `SessionExistence` handle (defined semantics, §5.1) + respawn-generation cap (§7.5); pure verdict function + WS handler; unit tests §9.1. **Acceptance includes the Assumption-1 REST-identity crate-boundary check.** | Yes — provably inert (§3, test 9.1.1) | **M** — ~6 TDD tasks |
| **2. Synthetic-client proof** | this branch | crate tests §9.1 + PW-RUST specs §9.2 (restart / double-restart / WSL / dead-session / **two-concurrent-connection**) | Yes | **S–M** — ~4 tasks; harness restart support already exists |
| **3. Client adoption** | later, on main | §10, deviation files, capability-gated, legacy path intact behind the gate; **the §5.5 `createRequestId` violations fixed (persist re-mint + REST ingress); dead-code deletions land as Phase-3 acceptance gates** (terminal-restore.ts latch + legacy inventory loop removed once the gated path is proven) | Yes — old servers unaffected | **M** — ~5 tasks + e2e with the real SPA |
| **4. Residual convergence (Option E)** | later, on main | shrink `matchScore`, retire `session-utils` guessing now that `sessionRef`s are always correct | Yes | **S** — success measured in lines removed |

**Phase-3 trigger (explicit):** **Phase 3 begins when 9.2 is green** — the synthetic-client
e2e suite passing on this branch is the gate that authorizes frozen-client adoption work.
No adoption work starts against an un-proven server.

**CI posture:** the §9.1 crate suite and §9.2 PW-RUST suite are **default, always-run CI**
(not opt-in / not nightly-only). They are the standing regression wall for every incident
class this design closes; they must run on every PR to this branch and to main once adopted.

**Definition of done (borrowed from the assessment §11 user-outcome metrics, not a code
checklist):** the effort is done when the assessment's user-facing outcomes hold — zero
silent-blank panes across restart/double-restart/WSL-restart, correct resume identity after
reconnect, and no duplicate-writer data loss — measured by the §9.2 scenarios standing green
and the incident classes (Inc. 1/2/4 + silent-blank I5) staying closed. Lines-removed in
Phase 4 is a *secondary* metric, not the finish line.

**Interim posture (what protects the user between Phase 1 and Phase 3):** the server ships
first and the frozen client does not yet speak the protocol, so during that window the user
is protected not by the handshake but by the **already-landed identity stamping (commit
`80772ff2`)** and the **persist guards from #516/#518** (bounded resume + persist-empty
guard). Those keep resume identity correct and stop the empty-persist wipe that the handshake
will later supersede. The handshake is additive hardening on top of an already-improved
baseline — it does not leave a protection gap while it waits for adoption.

**Deviation-budget arithmetic (8-file budget):** the frozen-client budget is 8 files. Prior
spend on this branch already consumed part of it — **#516** (bounded resume / re-anchor) and
**#518** (persist-empty guard + MCP resume alias) touched client files. Adoption's §10 lists
**5 deviation files** (4 modified + 1 new). Phase 3 must re-count the *remaining* budget
against the #516/#518 spend before adoption, and the §5.5 `createRequestId` fixes
(`persistMiddleware.ts`, REST ingress) must be booked against it too — if the running total
would exceed 8, adoption is re-scoped, not silently over-budget.

**Tradeoff summary** (per the assessment's Option-B row, now concretized): optimizes for
server-authoritative linkage and self-healing reconnects at the cost of one extra
round-trip per connect (amortized, O(open panes)) and one new protocol contract. What it
sacrifices — a heavier connect path and a contract that must be honored long-term — is
bounded by the three-gate rollout and the fences above. What would make this the wrong
choice: if the identity-stamping lane (assumption 1) stalls, rows 2–3 of the decision
table lose their authoritative source and the design must wait — the handshake without
stamped identity would just relocate the guessing, not remove it.
