# eaw7 exploration: server-side fresh-agent status + snapshot emission (Node + Rust)

Work item: add a provider-agnostic, server-authoritative per-session monotonic status
sequence (`statusSeq`) carried on every status-bearing frame and snapshot, so a stale
snapshot arriving after a reconnect cannot clobber newer status (BLUE/busy correctness).

All paths are relative to the worktree root.

---

## 1. Node server — snapshot payload composition sites

### 1a. Primary REST snapshot route (the one the SPA fetches)

`server/fresh-agent/router.ts:202-275` — `router.get('/fresh-agent/threads/:sessionType/:provider/:threadId', ...)`
calls `deps.runtimeManager.getSnapshot({...})` at **router.ts:229** and `res.json(snapshot)` at **242**.

`FreshAgentRuntimeManager.getSnapshot` (`server/fresh-agent/runtime-manager.ts:375-397`) dispatches to the
registered adapter and contract-validates:

```ts
const snapshot = await registration.adapter.getSnapshot({ sessionType, provider, threadId, cwd }, input.revision)
const parsed = FreshAgentSnapshotSchema.safeParse(snapshot)
```

The wire shape is `FreshAgentSnapshotSchema`, `shared/fresh-agent-contract.ts:247-267` (a `.strict()` zod object):
`sessionType, provider, threadId, sessionId?, revision, latestTurnId?, status: z.string().min(1) (:251), summary?,
capabilities, settings?, tokenUsage, pendingApprovals[], pendingQuestions[], worktrees[], diffs[], childThreads[],
turns[], extensions{claude?,codex?,opencode?}, commands?`. Field names also registered in
`FRESH_AGENT_CONTRACT_SCHEMA_NAMES` (:306-319).

Per-provider adapter composition of the REST snapshot's `status`:
- **claude/kilroy** — `server/fresh-agent/adapters/claude/adapter.ts:196-246` (`getSnapshot`): live session →
  `normalizeClaudeThreadSnapshot({..., status: liveSession.status})` (:209, :226); disk-only fallback → `status: 'idle'` (:244).
- **codex** — `server/fresh-agent/adapters/codex/adapter.ts:1082-1122` (`getSnapshot`): status is the FRESHLY READ
  app-server thread status, `normalizeCodexThreadStatus(rawSnapshot.thread?.status)` (:1116). Note: this is an
  out-of-band provider read, NOT the tracked last-emitted ws status — the prime stale-status race surface.
- **opencode** — `server/fresh-agent/adapters/opencode/adapter.ts:1163-1185`: `status: liveState?.status ?? 'idle'`
  (:1179) plus the busy-clear gate hint `statusFromLiveState: liveState?.initialReconcileCompleted === true` (:1183),
  consumed client-side only via `extensions.opencode.statusFromLiveState`.

### 1b. agent-api (tmux-style) fresh-agent snapshot reads

`server/agent-api/router.ts:900-953`: `/panes/:id/capture` — for `paneSnapshot?.kind === 'fresh-agent'`, calls
`freshAgentRuntimeManager.getSnapshot({ sessionType: c.sessionType, provider: c.provider, threadId: c.sessionId, cwd })`
at **:910-915**, returns only rendered transcript text (`renderFreshAgentTranscript(snapshot)`).

`server/agent-api/router.ts:955-984`: `/panes/:id/wait-for` — polls `freshAgentRuntimeManager.getSnapshot(...)`
at **:970-975** and reads `snap?.status` (:976) against `'idle'`. Also `layout/snapshot` (:881-892) is the layout
store, not fresh-agent status.

### 1c. WS-side "snapshot" frames (shape distinct from the REST snapshot)

The WS flow has NO full snapshot; the status-bearing ws frame is `sdk.session.snapshot`
(`server/sdk-bridge-types.ts:61-70`):

```ts
| { type: 'sdk.session.snapshot'; sessionId: string; latestTurnId: string | null; status: SdkSessionStatus;
    timelineSessionId?: string; revision: number; streamingActive?: boolean; streamingText?: string }
```

where `SdkSessionStatus = 'creating'|'starting'|'connected'|'running'|'idle'|'compacting'|'exited'`
(sdk-bridge-types.ts:44). `sdk-bridge.ts` itself NEVER emits this frame (only `sdk.session.changed`
invalidations; see the comment at `server/sdk-bridge.ts:631-632`: "emits the existing snapshot-invalidation
edge (sdk.session.changed → freshAgent.session.changed → the client refetches the snapshot)"). Emitters are the
provider adapters (section 2). Type normalization `sdk.* → freshAgent.*` is
`server/fresh-agent/sdk-events.ts:41-84` (`freshAgent.session.snapshot` union member at :5-14); the ws envelope
wrap is `WsHandler.freshAgentEventMessage`, `server/ws-handler.ts:1341-1349`:
`{ type:'freshAgent.event', sessionId, sessionType, provider, event: <normalized> }`.

### 1d. WS handshake snapshot does NOT cover fresh agents

`server/ws-handler.ts:1813-1846` (`scheduleHandshakeSnapshot`/`sendHandshakeSnapshot`): provider wired at
`server/index.ts:415-427` returns only `{ settings, projects, perfLogging, configFallback }`; the handler sends
`settings.updated`, `perf.logging`, `config.fallback`, `terminal.inventory`. NO fresh-agent session state is
delivered at handshake — a reconnecting client re-learns fresh-agent status ONLY via (i) the per-pane
`freshAgent.attach` ws round-trip acks (provider-dependent, see §2) and (ii) the REST snapshot fetch (§1a).
These two channels have no mutual ordering — the race this work item fixes.

Node `freshAgent.attach` handling (`server/ws-handler.ts:3600-3654`) emits NO ack frame itself; it calls
`manager.attach(...)` then `ensureFreshAgentSubscription` (:3619; subscription registry at :1540-1620, per-client
`state.freshAgentSubscriptions` keyed `${sessionType}:${provider}:${sessionId}`, :1274-1276). Whatever arrives is
whatever the provider emits on attach: Node opencode attach runs `reconcileStatus`
(`adapters/opencode/adapter.ts:1050`; reconcile emits only on a status transition, :291-344), Node codex attach
emits nothing (`adapters/codex/adapter.ts:871-874`), Node claude attach → sdk-bridge subscribe may REPLAY buffered
messages to the first subscriber (`server/sdk-bridge.ts:827-852` — `sp.messageBuffer` replay, first-subscriber
only), and `broadcastToSession` (:947-964) assigns a per-session `sequence` used only as replay metadata.

---

## 2. Node server — every status-bearing ws frame for fresh agents

All are wrapped per §1c in `freshAgent.event`. Effects on BLUE: client `isFreshAgentBusy = streamingActive ||
status==='running'` (comment at `src/store/freshAgentSlice.ts:399-404`).

| Provider | Frame (post-normalize) | Site | Payload |
|---|---|---|---|
| freshclaude/kilroy | `sdk.status`→`freshAgent.status` {sessionId,status:'idle'} | `server/sdk-bridge.ts:436-437` | stream-end idle |
| freshclaude/kilroy | `freshAgent.status` {status:'compacting'} | `server/sdk-bridge.ts:493-497` | compacting |
| freshclaude/kilroy | (no `running` status frame; running is tracked server-side via `state.status='running'` at sdk-bridge.ts:529 and sdk.assistant folds streaming streamingActive client-side) | sdk-bridge.ts:527-529 | — |
| freshclaude/kilroy | `sdk.turn.complete`→`freshAgent.turn.complete` {sessionId, at} | sdk-bridge.ts:572-580 | `const at = nextMonotonicTurnCompleteAt(state.lastTurnCompleteAt, Date.now()); state.lastTurnCompleteAt = at` (:573-574); only on `rMsg.subtype === 'success'` (:572) |
| freshclaude/kilroy | `sdk.turn.waiting`→`freshAgent.turn.waiting` {sessionId, at} | sdk-bridge.ts:618-622 (`emitWaitingEdge`) | same clock, own `state.lastWaitingAt` (:619-620); fired on 0→≥1 pending approval/question (:687) |
| freshcodex | `sdk.session.snapshot`→`freshAgent.session.snapshot` {sessionId, latestTurnId:null, status, timelineSessionId, revision?} | `adapters/codex/adapter.ts:256-265` (`makeCodexStatusEvent`), emitted :884, :903, :914 | status = `normalizeCodexThreadStatus` (:246-254) |
| freshcodex | `sdk.status`→`freshAgent.status` {status:'exited'} | adapter.ts:891-896 (thread_closed) and :945 (`onExit` crash self-heal, no chime) | — |
| freshcodex | `sdk.turn.complete` {sessionId, at} | adapter.ts:925-927 | `nextMonotonicTurnCompleteAt(lastTurnCompleteAtByThread.get(sessionId), Date.now())`; positive-completion guard `status==='completed'` :922-924 |
| freshopencode | `sdk.session.snapshot`→`freshAgent.session.snapshot` {sessionId, status:'running'\|'idle'} | `adapters/opencode/serve-events.ts:99-119` maps serve SSE `session.idle`/`session.status{busy,retry,idle}` (:102-107); re-emitted via `emitStatus` `adapters/opencode/adapter.ts:507-509` (`state.events.emit('event', { type:'sdk.session.snapshot', sessionId: state.placeholderId, status })`) | status-only snapshot |
| freshopencode | `sdk.turn.complete` {sessionId, at} | adapter.ts:431-433 (compact), :666-668, :801-803 (send settle) | `nextMonotonicTurnCompleteAt(state.lastTurnCompleteAt, Date.now())`, gated on `!turnAborted && !turnErrored` |

The clock helper: `server/fresh-agent/turn-complete-clock.ts:1-21` — `nextMonotonicTurnCompleteAt(lastAt, now)`
returns `last+1` when `now <= last`. Its doc comment is the canonical home of the at-monotonic dedupe regime;
acceptance asks statusSeq semantics to be documented alongside it.

**Per-session state that would own the counter (Node):**
- `SdkBridge.sessions: Map<sessionId, SdkSessionState>` — `server/sdk-bridge-types.ts:101-146` — already hosts
  `lastTurnCompleteAt?` (:132-133) and `lastWaitingAt?` (:134-135); the natural `statusSeq` home for freshclaude/kilroy.
- `FreshAgentRuntimeManager.sessions` — `server/fresh-agent/runtime-manager.ts:98-100` — keyed
  `sessionType:provider:sessionId` (`makeFreshAgentSessionKey`, key() at :470-472). Provider-agnostic choke point;
  lives for the process lifetime (entries deleted on kill, :317-327). Could host the counter IF adapters report
  status transitions to it (today they don't — status is written inside adapters).
- codex adapter closure maps — `adapters/codex/adapter.ts:295-299` (`activeTurnByThread`, `lastTurnCompleteAtByThread`,
  `settingsByThread`) — per-thread map lifetime = adapter instance = process.
- opencode adapter `OpencodeSessionState` — `adapters/opencode/adapter.ts:77-132` — hosts `status` (:89),
  `lastTurnCompleteAt?` (:93-94), and `stateGeneration` (:82, module-scope counter :69-75). NOTE: the state object
  is recreated on recovery/rebind, so a counter kept HERE resets; a runtime-level map (or a generation-stable map)
  is safer.

---

## 3. Rust crates — the deployed production path (port 3001)

AGENTS.md: the live production server is the RUST server. The Rust ws slices live in `crates/freshell-ws`
(`WsState` fields `fresh_codex`/`fresh_claude`/`fresh_opencode`, `crates/freshell-ws/src/lib.rs:161-178`; all
broadcast on ONE shared `broadcast_tx: tokio::sync::broadcast::Sender<String>`, lib.rs:140-145). Provider logic in
`crates/freshell-freshagent` (+ `freshell-codex`).

**freshclaude/kilroy (Rust):** `FreshClaudeState` (`crates/freshell-freshagent/src/claude.rs`), sessions map
`Arc<TokioMutex<HashMap<String, ClaudeSession>>>` (:82). It spawns a VENDORED NODE SIDECAR per session —
`crates/freshell-claude-sidecar/index.mjs` (path resolved at claude.rs:2056-2066, spawn at :1963-1999) — which
re-implements sdk-bridge status semantics: `sdk.status` compacting (:152) / idle (:216), and
`sdk.turn.complete` with the same `nextMonotonic(last, now)` clamp (:127-129, :182-184). The Rust stdout consumer
(claude.rs:1466-1600) folds the tracked status per session BEFORE broadcast:
`sdk.assistant→"running"` (:1504-1506), `sdk.result→"idle"` (:1507-1509), raw `sdk.status` fold (:1510-1514), into
`ClaudeSession.last_status: Arc<std::sync::Mutex<String>>` (:214-220, read via `current_status()` :223-229) — **this
fold site is the single per-session status writer for claude in production; the natural statusSeq home.** Frames are
renamed `sdk.X → freshAgent.X` preserving all fields — see `sdk_line_to_frame` (:1812-1828) and rename table
`normalize_sdk_type` (:1832-1856, incl. `sdk.turn.waiting` pass-through). Attach ACKS (a reconnect-critical frame):
`status_snapshot_frame` (:1913-1931) emits

```json
{ "type": "freshAgent.session.snapshot", "sessionId", "latestTurnId": null, "status": <tracked truth>, "timelineSessionId" }
```

from `try_rebind_to_live` (:1206-1234; doc at :1200-1205 says: "announcing the session's REAL tracked status —
never a hardcoded 'idle'") and `resume_for_attach` (:1414). `handle_attach` entry: :1060-1134.

**freshcodex (Rust):** `CodexSession` (codex.rs:192-225: `active_turn: Arc<StdMutex<Option<String>>>` :207, sidecar
watcher, `exited: Arc<AtomicBool>` :224). The status/completion reducer is `CodexSubscription`
(`crates/freshell-codex/src/events.rs:101-243`) with `last_turn_complete_at: Option<i64>` (:107) and
`next_monotonic_turn_complete_at` (:70-75; ported from turn-complete-clock.ts), emitting
`CodexAdapterEvent::{StatusSnapshot, TurnComplete, Status}` (:80-99). Wire frames built in
`adapter_event_to_frame` (codex.rs:3985-4021):
- `StatusSnapshot` → `freshAgent.session.snapshot {type, sessionId, latestTurnId:null, status, timelineSessionId, revision?}` (:3992-4001)
- `TurnComplete` → `freshAgent.turn.complete {type, sessionId, at}` (:4003-4007)
- `Status` → `freshAgent.status {type, sessionId, status}` (:4008-4012) (exited, no chime)
`handle_attach` (:1828-1922) emits a `StatusSnapshot` ack on recovered/respawned/resumed attaches (:1905-1921)
from `active_turn` presence (`running`/`idle`).

**freshopencode (Rust):** `FreshOpencodeState` sessions map (opencode_ws.rs:100) of
`Arc<TokioMutex<OpencodeSession>>` (:150-210) — fields `turn_task` (:192), `turn_aborted`/`turn_errored` (:196/:200),
`last_turn_complete_at: Arc<StdMutex<Option<i64>>>` (:201-203), `serve_bridge` (:209). Status frames:
`snapshot_event(session_id, status)` (:1722-1723) → `freshAgent.session.snapshot {type,sessionId,status}`;
`turn_complete_event` (:1740-1742); shared settle tail `settle_turn_outcome` (:1750-1770, unconditional idle
snapshot + gated chime). Serve-SSE bridge forwards `session.idle`/`session.status` at :1611-1638. `handle_attach`
(:1339-1421) ALWAYS acks with a snapshot (:1416-1420) whose status = `turn_task.is_finished()` ? `idle` : `running`
(:1397-1401) — in-process truth, NOT a fresh provider read. Interrupt also broadcasts idle snapshots (:922-932).

**Rust REST snapshot endpoint:** `crates/freshell-freshagent/src/snapshot.rs` — axum router
`GET /api/fresh-agent/threads/{sessionType}/{provider}/{threadId}` (:90-97, handler :99-…), `SnapshotState` holds all
three provider slices (:66-87). Status stamped per provider today:
- freshcodex: `build_codex_snapshot_json` (codex.rs:3615-3700+) → `"status": normalize_codex_thread_status(thread.status).as_str()` (:3621, :3675), from the FRESH app-server `readThread` (get_snapshot :2644-2665) — same out-of-band-read race as Node.
- freshopencode: `build_opencode_snapshot_json` (lib.rs:1507-1562) → hardcoded `"status": "idle"` (:1537), honestly
  documented (:1501-1506: "this REST read has no live busy/idle bit to consult… the client's WS-driven busy chrome
  already covers the live case").
- claude/kilroy: disk-only `build_claude_snapshot_json` (`claude_snapshot.rs:573-613`) → hardcoded `"status": "idle"`
  (:592-596, comment: "live status is authoritative via the WS status events, so the client ignores this on live
  sessions"), overlaid with live pendings for live sessions (snapshot.rs module doc :29-39).

**Authoritative split:** In production the Rust server authors ALL fresh-agent ws frames and REST snapshots.
The Node server code remains the parity reference (and drives the vendored claude sidecar's semantics). Any fix
that touches only `server/` does not fix production; any fix touching only `crates/` breaks Node-parity tests.

**Ordering guarantees (Rust):** one process-wide `broadcast_tx`; per-connection forwarding task reads FIFO; on lag
the socket is closed 4008 "Backpressure" forcing reconnect resync (`crates/freshell-ws/src/terminal.rs:515-548`).
So per-session ws frames are strictly ordered on one socket. REST responses have NO ordering vs ws frames — this is
exactly the cross-channel race.

---

## 4. Zod / schema sites (where `statusSeq` would be declared)

- REST snapshot contract: `shared/fresh-agent-contract.ts:247-267` `FreshAgentSnapshotSchema` (`.strict()`); add
  `statusSeq: z.number()...` next to `status` (:251). Name is registered for contract tests via
  `FRESH_AGENT_CONTRACT_SCHEMA_NAMES` (:306-319).
- WS client→server: `shared/ws-protocol.ts:496-615` (`FreshAgentCreateSchema` … `FreshAgentClientMessageSchema`
  discriminatedUnion :605-615) — unaffected (no status fields client→server).
- WS server→client: `shared/ws-protocol.ts:1117-1124` `FreshAgentServerMessage` — **a TS type union, NOT zod**;
  `freshAgent.event` carries `event: unknown` (:1121). The inner provider-event type unions are server-side:
  `server/sdk-bridge-types.ts:52-85` (`sdk.session.snapshot` :61-70, `sdk.status` :79, `sdk.turn.complete` :80,
  `sdk.turn.waiting` :81) and `server/fresh-agent/sdk-events.ts:4-39` (`freshAgent.session.snapshot` :5-14,
  `freshAgent.status` :34, `freshAgent.turn.complete` :35, `freshAgent.turn.waiting` :36). The client folds ws
  frames by unchecked casts in `src/lib/fresh-agent-ws.ts` (snapshot fold :205-215 → `sessionSnapshotReceived`;
  status fold :236-241 → `setSessionStatus`; turn.complete :242-256 with `at` validity gate :246-249; turn.waiting
  :257-268) — so `statusSeq` on ws frames is a TYPE-ONLY contract addition in `sdk-events.ts`/`sdk-bridge-types.ts`
  + cast reads in fresh-agent-ws.ts; no zod gate exists on this channel.
- Rust wire structs: `crates/freshell-protocol/src/server_messages.rs:650-658` `FreshAgentEvent { event: Value, provider, session_id, session_type }`
  — the inner event is an OPAQUE `serde_json::Value`; builders are the producer-side constraint (claude.rs:1913,
  codex.rs:3985, opencode_ws.rs:1722 + `sdk_line_to_frame` pass-through claude.rs:1812). Client messages:
  `crates/freshell-protocol/src/client_messages.rs:522-680`.

---

## 5. Reconnect flow — how a stale snapshot lands AFTER newer live status

Client side:
1. Socket reconnect completes; `ws-client.ts:353-355` fires `reconnectHandlers` after the ready flush.
2. `src/components/fresh-agent/FreshAgentView.tsx:1594-1622` (`ws.onReconnect`): every pane re-sends
   `freshAgent.attach`; a VISIBLE pane also calls `requestSnapshotRefresh('reconnect')` (:1619) →
   `src/lib/fresh-agent-snapshot-scheduler` → `GET /api/fresh-agent/threads/...` (§1a / §3-REST). Hidden panes
   defer the fetch to reveal (`pendingRevealRefreshRef`, :1606-1616, reveal consume :1624-1630).
3. The REST response is folded by `applySnapshot` (FreshAgentView.tsx:1911-2036): `resolved.status` is adopted into
   redux status via `setSessionStatus` (:2008-2013) gated ONLY by heuristics — `canAdoptSnapshotStatus` (:1991-1997:
   codex always, opencode only busy-or-`extensions.opencode.statusFromLiveState`, claude never),
   `wouldRegressStatus` via `isStatusRegression` (:1985-1987, :228-230: only blocks connected/starting→EARLY_STATES
   regressions), and `statusChangedSinceRequest` (:1983, compares a `statusVersion` ref sampled at request time
   — a client-local version, NOT a server-minted sequence; it cannot distinguish "changed then changed back" and it
   does nothing for ws-folded statuses recorded after request start when the current status equals the request-time one).
4. Meanwhile the reconnect attach makes the SERVER emit ws status frames: Rust acks (§3: claude.rs:1227/1414,
   codex.rs:1905-1922, opencode_ws.rs:1416-1420) plus any live provider events that arrive during the HTTP fetch.
   These are folded by `src/lib/fresh-agent-ws.ts:205-241` → `sessionSnapshotReceived`
   (`src/store/freshAgentSlice.ts:278-317`) — which calls `writeSessionStatus(session, action.payload.status)`
   UNCONDITIONALLY (:304), as does `setSessionStatus` (:395-405).
5. `freshAgentSnapshotReceived` (`freshAgentSlice.ts:363-393`, the kata-cited clobber site at :374-376) writes
   `snapshot.status` unconditionally too, but note its own comment (:370-374): "This reducer is currently
   production-dormant (no dispatch site)". The LIVE clobber paths are (a) `sessionSnapshotReceived` for ws frames
   and (b) `applySnapshot` for the REST response. There is no shared freshness key across these channels today.

Race instantiation: reconnect → attach ack ws frame says `running` (truth, statusSeq-less) → REST snapshot fetched
moments EARLIER (read while provider thread read returned `idle`, or opencode reconcile saw absence) lands LATER →
`applySnapshot` folds `idle` over `running` → pane lies idle while the agent works (or, opencode-before-materialization,
vice versa). `statusChangedSinceRequest` only guards the narrow fetch-window case and only per-pane refs.

## Implications for statusSeq design

**Which payloads must carry `statusSeq`:**
1. Every status-bearing WS frame, all providers: `freshAgent.session.snapshot` (the live status frame — claude.rs:1913,
   codex.rs:3993, opencode_ws.rs:1723 + Node counterparts sdk-bridge-types.ts:61-70/sdk-events.ts:5-14) and
   `freshAgent.status` (sdk-events.ts:34; codex.rs:4008).
2. The REST snapshot: `FreshAgentSnapshotSchema` (`shared/fresh-agent-contract.ts:247-267`) — the fold target in
   `SessionSnapshot` commits (`applySnapshot`).
3. NOT needed: `freshAgent.turn.complete` / `freshAgent.turn.waiting` (already `at`-monotonic and non-status-bearing),
   `freshAgent.session.changed` (pure invalidation). `stream`/streamingActive deliberation: `sessionSnapshotReceived`
   also overwrites `streamingActive` (:307) — BLUE = streamingActive || running, so the seq-gated fold should cover
   streaming fields too or apply as one unit.

**Where the counter must live:**
- Node: colocate with the status writers (per §2): sdk-bridge `SdkSessionState` (sdk-bridge-types.ts:101-146) for
  claude/kilroy; codex adapter per-thread map ↔ `lastTurnCompleteAtByThread` (adapter.ts:298); opencode — NOT on
  `OpencodeSessionState` (recreated per generation, adapter.ts:69-75) but on a process-stable per-session map (or
  `FreshAgentRuntimeManager.sessions` record, runtime-manager.ts:90-100) so recovery doesn't reset it.
  Snapshot composition must read the SAME counter value as the ws frames from the same status record, atomically.
- Rust (production): claude → `ClaudeSession` next to `last_status` (claude.rs:214-220), bumped at the single fold
  site in the stdout consumer (:1503-1516) so EVERY frame plus every attach ack inherits it (sidecar stays
  seq-agnostic; Rust stamps on broadcast — one writer). codex → `CodexSession`
  (codex.rs:192-225) or `CodexSubscription` (events.rs:105-127), stamped in `adapter_event_to_frame` (:3985); the
  REST `get_snapshot`/`build_codex_snapshot_json` (:2644/:3615) must fold the freshly-read thread status THROUGH the
  tracker (or at minimum read tracker's current seq) rather than stamping raw provider output. opencode →
  `OpencodeSession` (opencode_ws.rs:~150-210), stamped in `snapshot_event`; note Rust REST opencode/claude snapshots
  hardcode `idle` (lib.rs:1537; claude_snapshot.rs:592-596) and the client never adopts those statuses
  (`canAdoptSnapshotStatus`, FreshAgentView.tsx:1991-1997) — adding statusSeq there is harmless but inert for the bug.
- One server or both? Production is Rust-only, so Rust is REQUIRED; Node parity is expected by this repo's
  port-oracle test culture (dual-server e2e/cert harnesses) and the claude sidecar reuses Node semantics — implement
  + document the semantics once (turn-complete-clock.ts vicinity in TS; mirror comment in
  `crates/freshell-codex/src/events.rs`) and stamp in both servers. The ws `freshAgent.event` envelope is opaque
  (`event: unknown` / `Value`), so no protocol-struct diff is needed beyond the provider-event type declarations and
  the REST zod schema (leave `statusSeq` OPTIONAL on the wire initially so mixed old-server/new-client folds parse;
  acceptance's "stale snapshot" test should drive server+client in one step).
- Restart caveat (mirrors turn-complete): a per-process counter resets on restart; the client already has the reset
  hook — `resetCompletionDedupeBaselines` on `ready`/bootId change (src/App.tsx:1042-1053) — add the statusSeq
  baseline reset there. Alternatively define statusSeq AS a monotonic wall-clock `at` (same clamp helper) to inherit
  the existing restart story verbatim; document alongside `nextMonotonicTurnCompleteAt`
  (`server/fresh-agent/turn-complete-clock.ts:1-21`).

**Ordering guarantees:** within one ws connection, per-session frames are FIFO on both servers (single socket per
subscribed session in Node — ws-handler.ts:1540-1620; single process-wide broadcast channel in Rust with a
close-on-lag resync — terminal.rs:515-548). There is NO ordering between the ws channel and REST responses (and the
Node/Rust REST snapshot builders read status by an out-of-band fresh provider read for codex), so the client-side
guard must be value-, not arrival-, based: keep `lastStatusSeq` per session freshAgent state; fold a status only
when `frame.statusSeq > lastStatusSeq` (ties: prefer ws over REST, or drop — pick one rule and pin it in tests);
the REST fold in `applySnapshot` must compare the snapshot's `statusSeq` against the same baseline, replacing the
fragile `statusChangedSinceRequest`/regression heuristics for the status field. Server-side, status+seq must be
sampled atomically at snapshot composition so a snapshot can't pair NEW seq with OLD status.
