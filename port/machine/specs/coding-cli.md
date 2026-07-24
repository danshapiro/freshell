# Ground-truth behavioral spec — CODING-CLI / FRESH-AGENT subsystem

**Scope:** `server/coding-cli/**`, `server/fresh-agent/**`, `server/sdk-bridge.ts`, the
`freshAgent.*` + `codingcli.*` handlers in `server/ws-handler.ts`, the MCP `freshell` tool
(`server/mcp/**`), and the REST orchestration surface (`server/agent-api/router.ts`).

**Purpose:** drive a faithful Rust reimplementation that the oracle's **T2** tier grades
(baselines: `port/oracle/baselines/t2/{opencode-kimi,claude-haiku,codex-gptmini}.json`;
invariants: `port/oracle/harness/invariants.ts`). Behavior below is derived from CODE and
cited `file:line`. Where the port must intentionally differ, the deviation ledger
(`port/oracle/DEVIATIONS.md`, DEV-0001/0002/0003) governs — all three live in THIS subsystem.

**Path convention:** all `file:line` are relative to the worktree
`/home/dan/code/freshell/.worktrees/rust-tauri-port/`. Read-only investigation; no source was
modified.

---

## 0. Architecture — three cooperating layers (do not conflate them)

There are **three distinct concerns** that all touch "coding CLI sessions". The port must keep
them separate; the oracle T2 tier exercises only layer B.

| Layer | Entry | Purpose | Graded by |
|---|---|---|---|
| **A. Legacy `codingcli.*`** | `CodingCliSessionManager` (`server/coding-cli/session-manager.ts`) | Spawn a provider CLI in **JSON-streaming** mode, parse stdout lines into `NormalizedEvent`s | T0 contract only (no live T2 baseline drives it) |
| **B. `freshAgent.*` runtime** | `FreshAgentRuntimeManager` (`server/fresh-agent/runtime-manager.ts`) → per-provider adapters | The in-app "fresh agent" chat runtime: create/send/turn-complete over SDK (claude), app-server JSON-RPC (codex), or serve HTTP (opencode) | **T2 (primary)** + T0 |
| **C. Session-indexer** | `CodingCliSessionsIndexer` (`server/coding-cli/session-indexer.ts`) | Read-only watch+parse of on-disk transcripts → `sessions.changed` / session directory | T2 side-effect assertions (`transcript.persisted/parseable`) + DEV-0002 liveness |

Session-type → runtime-provider map (`shared/fresh-agent.ts:77-99`):

| sessionType | runtimeProvider | label | notes |
|---|---|---|---|
| `freshclaude` | `claude` | Freshclaude | SDK-driven |
| `freshcodex` | `codex` | Freshcodex | app-server JSON-RPC |
| `kilroy` | `claude` | Kilroy | **hidden** (`hidden:true`), same adapter as freshclaude |
| `freshopencode` | `opencode` | Freshopencode | serve HTTP + SSE |

Composite key format: `` `${sessionType}:${provider}:${threadId}` `` (`shared/fresh-agent.ts:122-132`,
`makeFreshAgentThreadKey`/`makeFreshAgentSessionKey`). The runtime-manager keys its session map on
this (`runtime-manager.ts:426-428`).

The adapter contract every provider implements: `FreshAgentRuntimeAdapter`
(`server/fresh-agent/runtime-adapter.ts:57-74`) — `create` (required) + optional
`resume/attach/subscribe/send/interrupt/compact/kill/fork/answerQuestion/resolveApproval/getSnapshot/getTurnPage/getTurnBody/shutdown`.

Registration: `FreshAgentProviderRegistry` maps sessionType→registration and enforces one adapter
instance per runtimeProvider (`server/fresh-agent/provider-registry.ts:14-25`).

---

## 1. Session lifecycle per provider

All three flow through `FreshAgentRuntimeManager.create` (`runtime-manager.ts:103-131`) and are
dispatched from `ws-handler.ts` `case 'freshAgent.create'` (`ws-handler.ts:3291-3408`). The
manager records the session (`runtime-manager.ts:113-124`) and returns
`{ sessionId, sessionType, runtimeProvider, sessionRef }`. The ws-handler caches by `requestId`
(idempotent create: `ws-handler.ts:3304-3325`), authorizes the session on the client state
(`authorizeFreshAgentSession`, def `ws-handler.ts:1303-1306`, called `:3377`), sends `freshAgent.created`
(`ws-handler.ts:3378-3386`), and subscribes the socket (`ensureFreshAgentSubscription`).

**Materialization** is the placeholder→durable id transition. It is driven ENTIRELY by
`freshAgent.send`: when `adapter.send()` returns a `result.sessionId` that differs from the
locator's `sessionId`, the ws-handler emits `freshAgent.session.materialized`
(`ws-handler.ts:3471-3485`) and re-authorizes under the new id. **Only opencode's adapter returns
a new sessionId from send** — so materialization fires for opencode ONLY. (Confirmed by baselines:
`sessionMaterializedObserved: true` for opencode, `false` for claude/codex.)

### 1a. opencode (`server/fresh-agent/adapters/opencode/adapter.ts`)

- **create** (`:423-436`): returns a placeholder immediately, spawns NO provider session yet.
  Placeholder = `` `freshopencode-${requestId}` `` (`:74-76`, `:426`). `sessionRef =
  { provider:'opencode', sessionId: placeholder }`. State stored in a local `Map` keyed by
  placeholder (`remember`, `:107-110`).
- **first send → materialize** (`materializeOrSend`, `:324-387`): if `!state.realSessionId`, calls
  `serveManager.createSession({ directory: cwd })` → real id `ses_…` (`:340-341`), sets
  `providerCreatedInThisAdapter=true`, binds the serve SSE stream (`bindServeStream`, `:273-299`),
  and emits `freshAgent.session.materialized` (`emitMaterialized`, `:314-322`, called `:350`). The
  adapter's `send()` returns `{ sessionId: realId, sessionRef }` (`sendResult`, `:116-118`, returned
  `:382`), which is what triggers the ws-handler materialized broadcast.
- **durable id shape:** `` /^ses_[A-Za-z0-9]+$/ `` (`invariants.ts:168`).
- **attach** (`:466-498`): rehydrates an existing placeholder OR a durable `ses_…`; when a `cwd` is
  supplied it validates the session actually belongs to that cwd via
  `validateSessionRoute` (`:124-140`, compares canonicalized `session.directory` to `cwd`) —
  throws `FreshAgentLostSessionError` on mismatch. Placeholder ids and non-`ses_` ids are rejected
  as non-durable (`:481-483`).
- **resume** (`:438-464`): legacy `freshopencode-*` placeholder → `resolveLegacyPlaceholder`
  (`:631-649`, needs cwd + title/createdAt/updatedAt to find the real `ses_`); real `ses_…` →
  direct rebind + `reconcileStatus`.
- **fork** (`:546-563`): `serveManager.fork(realId)` → child `ses_…`; child is a fresh state with
  `providerCreatedInThisAdapter=true`.
- **runtime-manager recovery:** freshopencode is the ONLY provider with cwd-routed single-flight
  recovery (`requireOrRecoverSession`/`singleflightFreshOpenCodeAttach`,
  `runtime-manager.ts:430-550`): a durable `ses_…` locator with a cwd can be re-attached lazily
  after a server restart. `isDurableFreshOpenCode` = `freshopencode` ∧ `opencode` ∧ `ses_` prefix
  (`runtime-manager.ts:439-443`).

### 1b. claude / kilroy (`server/fresh-agent/adapters/claude/adapter.ts` + `server/sdk-bridge.ts`)

- **create** (`adapter.ts:119-130`): `sdkBridge.createSession(...)` → placeholder = a **bare
  `nanoid()`** (`sdk-bridge.ts:165`). The adapter returns `{ sessionId }` with **NO `sessionRef`**.
- **NO materialization:** the claude adapter's `send()` returns `void` (`adapter.ts:153-161`), so
  `result.sessionId` is undefined and the ws-handler never fires
  `freshAgent.session.materialized`. The ws `sessionId` stays the nanoid for the pane's whole life.
- **durable id** is the Claude CLI session UUID (`cliSessionId`), surfaced separately on the
  `freshAgent.session.init` event (from SDK `system/init.session_id`, `sdk-bridge.ts:369-385`) and
  as the on-disk `.jsonl` filename. T2 shapes: placeholder `` /^[A-Za-z0-9_-]{16,32}$/ `` (nanoid),
  durable `` /^[0-9a-f]{8}-…-[0-9a-f]{12}$/ `` (UUID) (`invariants.ts:180-182`). The T2 harness
  reads the durable UUID from `session.init.cliSessionId` + the persisted `.jsonl` name (baseline
  `claude-haiku.json` provenance).
- **resume** (`adapter.ts:132-143`): identical to create but passes `resumeSessionId` → SDK
  `resume` option (`sdk-bridge.ts:85`). Claude "resume" is create-with-resume, not a distinct
  handle.
- **fork:** NOT supported (no `fork` on the claude adapter) → `freshAgent.fork` throws
  `FreshAgentUnsupportedCapabilityError` (`runtime-manager.ts:287-289`).
- **subscribe** (`adapter.ts:145-151`): `sdkBridge.subscribe(sessionId, listener)`; the SDK bridge
  buffers messages until the first subscriber attaches (`sdk-bridge.ts:703-728`, replay buffer).

### 1c. codex (`server/fresh-agent/adapters/codex/adapter.ts` + `server/coding-cli/codex-app-server/**`)

- **create** (`adapter.ts:819-841`): `runtime.startThread({cwd,model,sandbox,approvalPolicy})` →
  `{ sessionId: started.threadId, sessionRef:{provider:'codex',sessionId:threadId} }`. The threadId
  is a **UUID (UUIDv7 in codex-cli 0.142.x)** and is **STABLE from create**.
- **NO materialization:** placeholder == durable (same UUID). `send()` returns
  `{ requestId, submittedTurnId }` with NO `sessionId` (`adapter.ts:1001`), so the ws-handler never
  materializes. T2 shapes: placeholder == durable == UUID regex (`invariants.ts:195-196`).
- **resume** (`adapter.ts:843-869`): requires `resumeSessionId`; `runtime.resumeThread(...)` returns
  the (same) threadId.
- **attach** (`adapter.ts:871-874`): a no-op that just remembers per-thread settings; returns the
  same id.
- **fork** (`adapter.ts:1053-1080`): `runtime.forkThread({threadId, …, excludeTurns:true})` → NEW
  child threadId; ws-handler emits `freshAgent.forked` (`ws-handler.ts:3567-3605`, reads
  `forked.threadId ?? forked.sessionId`).
- **`submittedTurnId`** is NOT the provider turn id — it is a signed, opaque **display id**
  (`createCodexDisplayId`, `adapter.ts:981-988`) HMAC'd with `displayIdSecret`; the real provider
  turn id is kept server-side (`rememberSubmittedInput`, `activeTurnByThread`).

### 1d. ws-handler lifecycle glue (`server/ws-handler.ts`)

- `freshAgent.attach` (`:3410-3453`): pending-attach dedupe by authorization key; authorizes +
  subscribes on success.
- `freshAgent.send` (`:3455-3501`): waits for authorization, calls `manager.send`, on new sessionId
  → `materializeFreshAgentSession` + broadcast, always sends `freshAgent.send.accepted` with
  `submittedTurnId`.
- `freshAgent.interrupt/compact/approval.respond/question.respond/kill` (`:3503-3630`): each requires
  authorization then delegates to the manager; `kill` retires session state and clears create caches.
- Provider event forwarding: `subscribe` listener output is normalized `sdk.* → freshAgent.*`
  (`normalizeFreshAgentProviderEvent`, `server/fresh-agent/sdk-events.ts:41-84`) and wrapped as
  `freshAgent.event` (`ws-handler.ts:1271-1279`); a `freshAgent.session.materialized` provider event
  is re-shaped and forwarded verbatim (`ws-handler.ts:1281-1301`).

---

## 2. Transcript persistence & parsing (layer C: session-indexer + providers)

Each provider exposes a read-only "provider" object implementing `CodingCliProvider`
(`server/coding-cli/provider.ts:15-36`) with `getSessionGlob/getSessionRoots/getSessionWatchBases/
listSessionFiles/parseSessionFile/extractSessionId`. The indexer watches the globs (chokidar),
parses changed files, and emits `ProjectGroup[]`.

### 2a. Claude — JSONL transcripts (`server/coding-cli/providers/claude.ts`)

- **home:** `getClaudeHome()` = `CLAUDE_HOME` or `~/.claude` (`server/claude-home.js:4-8`).
- **glob:** `<home>/projects/**/*.jsonl` (`claude.ts:517-518`).
- **roots:** `[<home>/projects]` (`claude.ts:521-522`). **watch-base:** `[<home>]` = `~/.claude`
  (`claude.ts:525-527`). ← key for DEV-0002.
- **layout:** `<home>/projects/<cwd-hash-dir>/<session-uuid>.jsonl`, plus subagents at
  `<project>/<session>/subagents/*.jsonl` (`listSessionFiles`, `claude.ts:529-580`).
- **id:** `extractSessionId` = basename minus `.jsonl` (`claude.ts:597-599`); parsing validates via
  `isValidClaudeSessionId` (`claude.ts:370`).
- **format:** newline-delimited JSON; `parseSessionContent` (`claude.ts:322-510`) walks records —
  `system/init`, `user`, `assistant`, `result` (semantic-record test `claude.ts:119-127`) — deriving
  sessionId, cwd, model, git branch/dirty, token usage (dedup by uuid/message-id, `claude.ts:174-182`),
  first user message, title. Token/context window model table `claude.ts:35-48`; autocompact snapshot
  read from `<home>/debug/<sessionId>.txt` (`claude.ts:201-282`).
- **degradation when absent:** `listSessionFiles` returns `[]` on missing `projects` dir
  (`claude.ts:532-536`).

### 2b. Codex — rollout JSONL (`server/coding-cli/providers/codex.ts`)

- **home:** `CODEX_HOME` or `~/.codex` (`codex.ts:25-27`).
- **glob:** `<home>/sessions/**/*.jsonl` (`codex.ts:448-449`). **roots:** `[<home>/sessions]`
  (`codex.ts:452-453`). **watch-base:** `[<home>]` = `~/.codex` (`codex.ts:456-458`).
- **layout / name:** `rollout-<ts>-<threadId>.jsonl` (baseline `codex-gptmini.json` provenance);
  `extractSessionIdFromFilename` pulls the embedded UUID (`codex.ts:417-421`), else `meta.sessionId`
  (`codex.ts:474-476`). Files walked recursively (`walkJsonlFiles`, `codex.ts:423-441`).
- **format:** JSONL of `session_meta`, `response_item` (payload `message`/`function_call`/
  `function_call_output`), `event_msg` (`agent_message`, `agent_reasoning`, `task_started`,
  `task_complete`, `turn_aborted`, `token_count`) — semantic sets `codex.ts:15-23`. Parser
  `parseCodexSessionContent` (`codex.ts:256-390`) derives sessionId (from `session_meta.payload.id`),
  cwd, git, subagent/forked flags (`codex.ts:304-306`), token envelope
  (`parseCodexTokenEnvelope`, `codex.ts:162-242`), and codex task-event snapshot
  (`latestTaskStartedAt/CompletedAt/TurnAbortedAt`, `codex.ts:343-358`).
- **note:** the coding-cli codex provider is **exec-mode streaming only**; `supportsSessionResume()`
  returns **false** (`codex.ts:652-655`) — streaming resume is unsupported at layer A (resume uses PTY
  or the layer-B app-server).

### 2c. OpenCode — SQLite (`server/coding-cli/providers/opencode.ts`)

- **data home:** `XDG_DATA_HOME/opencode` → win `LOCALAPPDATA/opencode` → `~/.local/share/opencode`
  (`opencode.ts:37-46`).
- **db:** `<dataHome>/opencode.db` (`opencode.ts:76-78`); watched paths `[db, db-wal]`
  (`opencode.ts:80-83`). **roots:** `[db]` (`opencode.ts:330-332`). **watch-base:**
  `[path.dirname(homeDir)]` = `~/.local/share` (`opencode.ts:334-336`). ← DEV-0002 relevance
  (a commonly-existing dir on real Linux hosts).
- **engine:** `node:sqlite` (Node ≥ 22.5). Read-only, `PRAGMA busy_timeout=5000`
  (`opencode.ts:28`, `:129-131`). The heavy listing query runs **off the event loop in a worker
  thread** (`createWorkerListingRunner`, `opencode.ts:73`, `:158`); schema/parent-id resolution runs
  inline with a 3-attempt/50 ms retry (`opencode.ts:235-299`).
- **schema:** table `session` with columns incl. `id`, `parent_id`
  (`PRAGMA table_info(session)`, `opencode.ts:312`; `SELECT id, parent_id FROM session WHERE id IN
  (…)`, `opencode.ts:253-255`). Missing `parent_id` → sessions treated as flat roots
  (`opencode.ts:243-245`, `:319-321`). The full listing marker SQL is
  `THREE_VIEWS_MARKER_SQL_PATTERN` (`opencode.ts:9`, from `providers/opencode-listing-query.ts`).
- **degradation classes** (`opencode.ts:17-25`): `missing_db` / `empty_db` /
  `sqlite_unavailable` / `sqlite_open_failed` / `schema_error` / `read_error` /
  `schema_missing_parent_id`, each logged once. A worker/read failure **re-throws** so the indexer
  keeps the previously-listed sessions rather than pruning the sidebar (`opencode.ts:159-166`).
- **supportsLiveStreaming = false** (`opencode.ts:370-372`); `supportsSessionResume = true`
  (`opencode.ts:374-376`).

### 2d. Session-indexer watcher arming + the DEV-0002 crash (`server/coding-cli/session-indexer.ts`)

Two chokidar watchers per enabled-provider set:

1. **glob watcher** `startSessionWatcher` (`:409-436`): `chokidar.watch(globs, {ignoreInitial:true})`
   over `getSessionWatchGlobs(providers)`; `add`/`change`/`unlink` → `markDirty/markDeleted` +
   `scheduleRefresh`; **has** an `'error'` handler (`:430`) so glob-watcher errors are logged, not
   fatal.
2. **root watcher** `startRootWatcher` (`:490-598`): watches the **nearest existing ancestor within
   the provider's watch-base** so a session-root that is absent at boot can be detected when it later
   appears. It computes the ancestor (`findNearestExistingAncestorWithin`, `:516-520`), arms
   `chokidar.watch([ancestors], {ignoreInitial:true, depth:maxDepth})` (`:538-541`), and on
   `addDir`/`unlinkDir`/`add`/`unlink` that `affectsWatchedRoot` fires `void
   this.reconfigureWatchers()` + a full rescan (`:553-595`). Its `'error'` handler is installed at
   **`:597`**.

`reconfigureWatchers` (`:465-488`) keys on `` `${provider}:${hasExistingRoot?1:0}` `` (`:467-470`);
when the key changes it **closes both watchers** (`:479-482`) and re-arms.

**The DEV-0002 process-fatal crash** (`port/oracle/DEVIATIONS.md`, DEV-0002; verified against code):
provider-home exists but the session-root subdir is absent at boot → root watcher arms on the
ancestor. When the first turn CREATES the subdir, the root watcher's `addDir` fires
`reconfigureWatchers` (`:553-556`); the watcher-key flips (root now exists) so reconfigure **closes
the old root watcher** (`:479-482`). chokidar's `close()` synchronously does
`removeAllListeners()` — destroying the `'error'` guard at `:597`. The in-flight `_addToNodeFs` for
the new dir then resumes on a later microtask, dereferences the now-closed watcher
(`undefined.on(...)`), emits `'error'` on a **listener-less** FSWatcher, and Node
`process.exit(1)`s **mid-turn**. In the oracle's isolated HOME only **claude** hits it (its ancestor
`~/.claude` exists via creds seeding); opencode's ancestor `~/.local/share` commonly exists on real
Linux hosts → structurally provider-agnostic.

**Port obligation (DEV-0002, accepted):** the Rust late-root watcher must **log + degrade (schedule a
rescan) and keep the process alive** — never abort — then resume precise-root watching once the
subdir exists. Pinned by a mandatory liveness test
(`crates/freshell-server/tests/coding_cli_late_root_watcher.rs`); the T2 message-differ is **blind**
to this (both sides pre-create `…/projects` for env parity, `t2-live-claude.ts:221-238`), so the
liveness test is the sole guard.

---

## 3. Turn-completion & status edges (server-authoritative, per provider)

The completion edge is the discrete `freshAgent.turn.complete` (server→client) or, for opencode,
the send-blocking idle. **The server, not the model, decides completion**, and it must chime ONLY on
a *positive* completion (never on interrupt/error). All edges use a per-session strictly-monotonic
`at` from `nextMonotonicTurnCompleteAt` (`server/fresh-agent/turn-complete-clock.ts`).

| Provider | Positive-completion predicate | Emit site | Wire event |
|---|---|---|---|
| **claude/kilroy** | SDK `result` message `subtype === 'success'` | `sdk-bridge.ts:469-477` → `sdk.turn.complete` | `freshAgent.turn.complete` (via `sdk-events.ts:71-72`) |
| **codex** | `turn/completed` with `params.turn.status ?? params.status === 'completed'` | `adapters/codex/adapter.ts:922-927` → `sdk.turn.complete` | `freshAgent.turn.complete` |
| **opencode** | `serveManager.onceIdle` resolves ∧ `!turnAborted ∧ !turnErrored` | `adapters/opencode/adapter.ts:377-381` → `sdk.turn.complete` | idle surfaced through blocking send + `freshAgent.turn.complete` |

Details / guards:

- **claude:** `result` handler sets status `idle`, accrues cost/usage, then chimes only on
  `subtype==='success'` (`sdk-bridge.ts:436-478`). Interrupts yield **no** result message; a natural
  stream end broadcasts `sdk.status idle` WITHOUT a chime (`sdk-bridge.ts:344-353`). A separate
  **waiting edge** `sdk.turn.waiting` fires on the `0 → ≥1` pending transition covering both
  permission and question requests (`emitWaitingEdge`, `sdk-bridge.ts:515-518`, called from
  `handlePermissionRequest:563` and `handleAskUserQuestion:625`).
- **codex:** `turn/completed` ALSO fires for interrupts/failures (`CodexTurnStatusSchema =
  completed|interrupted|failed|inProgress`, `protocol.ts:104`), so the adapter **status-guards** the
  chime and accepts EITHER shape `params.turn.status` (real cli 0.142.x) OR flat `params.status`
  (`adapter.ts:922-924`). On every `turn/completed` it also emits an idle status snapshot so the
  client re-fetches the committed transcript (`adapter.ts:906-914`). A crash/disconnect (`onExit`)
  emits `sdk.status exited` with **no** chime (`adapter.ts:935-946`); `thread_closed` emits
  `sdk.status exited` and releases the runtime (`adapter.ts:887-897`).
- **opencode:** `onceIdle` resolves on ANY idle (including an interrupt's abort-triggered idle or a
  post-error idle), so a positive completion additionally requires `!turnAborted` (set by
  `interrupt`, `adapter.ts:521`) and `!turnErrored` (set by an SSE `session.error`,
  `adapter.ts:278-282`). `compact` is a user-visible turn with the same chime discipline
  (`adapter.ts:226-257`).

**T2 grading of this** (`invariants.ts:317-358`): the fatal invariant is
`provider.emits-completion-signal` (claude/kilroy/codex → `turnCompleteEventObserved===true`) vs
`provider.emits-idle-signal` (opencode → `serverReportedIdle`). The persisted reply
(`turn.completed`) only CORROBORATES. Baselines: opencode `serverReportedIdle:true`; claude/codex
`turnCompleteEventObserved:true, serverReportedIdle:false`.

---

## 4. Codex app-server runtime (`server/coding-cli/codex-app-server/**`)

The codex runtime is a **spawned `codex … app-server --listen ws://127.0.0.1:<port>`** child
(`runtime.ts:1246-1261`, detached, `CODEX_MANAGED_REMOTE_CONFIG_ARGS` + `app-server --listen`),
driven over a **JSON-RPC-style request/response protocol over WebSocket**.

### 4a. Protocol (`codex-app-server/protocol.ts` + `client.ts`)

- **transport:** `ws` client; one JSON message per WS frame:
  `socket.send(JSON.stringify({ id, method, params }))` (`client.ts:796,808`). Envelopes are
  JSON-RPC 2.0-shaped: success `{ id, result }` (`protocol.ts:335-338`), error
  `{ id?, error:{code,message,data?} }` (`protocol.ts:329-343`), notification `{ method, params }`
  (`protocol.ts:345-348`). (The zod envelopes validate `id/result/error/method/params`; they do not
  enforce a literal `"jsonrpc":"2.0"` tag — the port should still SEND `2.0` for the real cli but must
  tolerate its absence when parsing.)
- **handshake:** `initialize` request → on success `notify('initialized')` (`client.ts:144-165`).
  Every non-`initialize` call awaits initialize first (`client.ts:777-778`).
- **requests:** `startThread` (`CodexThreadStartParamsSchema`, `protocol.ts:169-187`),
  `resumeThread` (`:189-204`), `forkThread` (`:206-221`, note `excludeTurns`),
  `startTurn` (`CodexTurnStartParamsSchema`, `:303-316` — carries `effort:
  CodexReasoningEffortSchema`, `input:[CodexUserInput]`, `sandboxPolicy`, `model`, `approvalPolicy`),
  `interruptTurn` (`:322-325`), `readThread`/`listThreadTurns`/`readThreadTurn`,
  `watchPath`/`unwatchPath`. The `thread` operation RESULT echoes `reasoningEffort:
  CodexReasoningEffortSchema` (`:233`).
- **notifications:** `thread/started`, `thread/closed`, `thread/status/changed`
  (`CodexThreadLifecycleNotificationSchema`, `:376-380`), `turn/started` (`:390-396`),
  `turn/completed` (`:398-415`, status-guarded per §3), `fs/changed` (`:382-388`).
- **status normalization** (`adapter.ts:246-254`): thread status `active→running`,
  `notLoaded→starting`, `systemError→exited`, `idle→idle`.

### 4b. Readiness / health (contrast with DEV-0001)

- `ensureReady(cwd)` (`runtime.ts:943-969`) single-flights `startRuntime`; refuses a second cwd for a
  running sidecar (`assertCompatibleLaunchCwd`, `:934-941`). Every request awaits it
  (`startTurn:1017-1018`, etc.).
- `startRuntime` (`:1228-…`) retries up to `startupAttemptLimit` (`:1236`); per attempt: allocate
  loopback port, spawn, wire client event handlers, then `waitForInitialize`.
- `waitForInitialize` (`:1476-1507`) is **BOUNDED**: it polls `client.initialize()` racing
  `childErrorPromise` and a `sleep(startupAttemptTimeoutMs)` that throws
  `"…did not finish initialize within {ms}ms"`. This is the codex analogue of a health-wait and is
  **already correctly bounded** — unlike the opencode `waitForHealth` (DEV-0001). The port must
  preserve the bound.

> DEV-0001 note: the task associates "readiness/health (DEV-0001)" with codex, but DEV-0001 is
> actually the **opencode** `serve-manager.waitForHealth` un-timed probe (§6b). The codex
> `waitForInitialize` is the healthy reference pattern; the port should mirror IT and fix opencode to
> match.

### 4c. Durability store (`codex-app-server/durability-store.ts`)

- Atomic JSON records at `FRESHELL_CODEX_DURABILITY_DIR` or `~/.freshell/codex-durability/`
  (`:25-28`), file `<encodeURIComponent(terminalId)>.json` (`:129-131`), written tmp+rename mode
  `0600` (`:112-119`).
- Keyed by `terminalId`; restore-by-locator can also match `{tabId, paneId, serverInstanceId}` and
  throws `CodexDurabilityRestoreAmbiguousError` on >1 match (`:55-90`). Schema-validated on read/write
  (`CodexDurabilityStoreRecordSchema`, `shared/codex-durability.ts`); a `candidate`
  (`candidateThreadId` + `rolloutPath`) is immutable once set (`:95-102`).

### 4d. Ownership / reaper (Linux `/proc`-based)

- Per-sidecar **ownership metadata** written to `metadataDir` with `serverInstanceId`
  (`FRESHELL_SERVER_INSTANCE_ID` or `srv-<pid>`, `:923`), `ownershipId`
  (`codex-sidecar-<uuid>`, `:924`), `wrapperPid`, `processGroupId`, and a complete wrapper
  process-identity (start-time-ticks + cwd + argv, `readProcessIdentity`, `:1283-1300`,
  `:1448-1468`). The child inherits `FRESHELL_CODEX_SIDECAR_ID` env (`:1258`).
- **Reaping / liveness** is process-group + `/proc`-scan based: `isProcessGroupGone`,
  `scanProcessGroupMembers`, identity match (`runtime.ts:452-586`); Linux-only proof
  (`assertProcOwnershipProofAvailable`, `:361-367`). On wrapper exit `attachChildExitHandler`
  (`:1532-1574`) tears down ownership and (if `!shutdownRequested`) fires `onExit` with source
  `app_server_exit` (`:1569-1573`) — the codex adapter uses this to clear BLUE without a chime
  (§3, `adapter.ts:935-946`). `shutdown()` (`:1110-1133`) closes the client, stops the child, and
  asserts no blocked ownership remains.
- **Port note:** this is the exact "ownership-safe, no-orphans" machinery the oracle's safety checks
  demand. A Rust port needs `/proc` PGID scanning parity (or an equivalent owned-process registry);
  naive `pkill`-style reaping is a divergence risk.

### 4e. Launch planning / recovery (terminal-mode codex, layer that feeds REST)

`codex-app-server/launch-planner.ts` + `launch-retry.ts` + `recovery-policy.ts` +
`restore-decision.ts` back the **terminal** codex mode (PTY), consumed by
`agent-api/router.ts:160-195` (`resolveSpawnProviderSettings` → `planCodexLaunchWithRetry` →
`codexAppServer` provider settings + `sidecar.adopt/publish/shutdown`). This is adjacent to the
fresh-agent path but shares the same runtime/durability primitives; the port must keep the sidecar
adopt→publish→(cleanup-on-failure) lifecycle (`agent-api/router.ts:250-264, 819, 1235`).

---

## 5. Model / effort normalization (`shared/fresh-agent-models.ts`; DEV-0003)

Every adapter normalizes model+effort on the way in via `normalizeFreshAgentModel` +
`normalizeFreshAgentEffort` (opencode `adapter.ts:80-83`, claude `adapter.ts:48-55`, codex
`adapter.ts:237-243`, and again in codex `send` `adapter.ts:961-963`).

- **Model menus** are HARDCODED per session type (`FRESH_AGENT_MODEL_OPTIONS_BY_SESSION_TYPE`,
  `:21-84`) with `thinkingEfforts[]` + `defaultEffort`. Defaults: freshcodex `gpt-5.5`/`max`
  (`:15-16`), freshclaude `high` (`:17`), freshopencode `opencode-go/glm-5.2`/`max` (`:18-19`).
- **`normalizeFreshAgentModel`** (`:106-119`): codex → `normalizeFreshcodexModel` (clamps to
  `{gpt-5.5, gpt-5.4-flash, gpt-5.3-codex-spark}`, fallback `gpt-5.5`, `:101-104`); opencode → trim
  or session default; claude → passthrough. **Consequence** (baseline `codex-gptmini.json`
  provenance): `gpt-5.4-mini` is silently rewritten to `gpt-5.5`; `gpt-5.3-codex-spark` is the only
  non-flagship model reachable through freshcodex — hence the cheapest T2 codex model.
- **`normalizeFreshAgentEffort`** (`:131-152`): opencode with no menu → trim or `max`; **codex
  `xhigh → max`** (`:142`); then clamp to the model's `thinkingEfforts`; fallback to `defaultEffort`
  else the last menu entry.
- **Adapter-level effort mapping to the wire:**
  - claude `toClaudeEffort` (`adapter.ts:41-46`): accepts only `low|medium|high|max` (else throws).
  - codex `toCodexReasoningEffort` (`adapter.ts:127-134`): `max|xhigh → xhigh`; `none|minimal|low|
    medium|high` **pass through verbatim**; else throws.

**DEV-0003 (REJECTED / NOT PROVEN):** `CodexReasoningEffortSchema =
z.enum(['none','minimal','low','medium','high','xhigh'])` (`protocol.ts:26`) models `none`/`minimal`
as VALID codex efforts, and the same schema governs both outbound `turn/start.effort`
(`protocol.ts:312`) and the inbound `thread…reasoningEffort` echo (`protocol.ts:233`). The proposed
"clamp none/minimal" fix was rejected — the port MUST **reproduce the original's verbatim
forwarding** and must NOT clamp. The differ grants NO tolerance here: any old-vs-new divergence in
codex effort handling is a port defect. (`DEVIATIONS.md`, DEV-0003.)

---

## 6. External orchestration surface

### 6a. MCP `freshell` tool (`server/mcp/freshell-tool.ts`, `server/mcp/server.ts`, `config-writer.ts`)

- **Single tool** `freshell({ action, params })` with action dispatch (obra pattern), routing to the
  Freshell REST API via an HTTP client (`freshell-tool.ts:560-908`). Fresh-agent-relevant actions:
  `new-tab`/`split-pane` with `agent="opencode"|"claude"|"codex"` + `model`/`effort`/`cwd`/`prompt`
  (`ACTION_PARAMS`, `:258-292`; `new-tab` handler `:595-624`; `split-pane` `:658-672`); `send-keys`
  (`:722-747`), `capture-pane` (`:748-760`), `wait-for` (`:761-774`), `run` (`:775-779`),
  `list-sessions`/`search-sessions` (`:853-858`), plus a direct `fresh-send` →
  `POST /api/fresh-agent/send` (`:587-592`).
- **Injected into the Claude SDK:** the SDK bridge registers this MCP server on every claude session
  (`createClaudeSdkMcpServers`, `sdk-bridge.ts:69-79`, command `node` + `buildMcpServerCommandArgs()`,
  env `FRESHELL_URL`/`FRESHELL_TOKEN`). So a freshclaude turn can drive the whole app back through
  MCP. Caller identity comes from `FRESHELL_TAB_ID`/`FRESHELL_PANE_ID` env
  (`freshell-tool.ts:131-137`).

### 6b. REST fresh-agent API (`server/agent-api/router.ts`)

Mounted under `/api`. Fresh-agent paths:

- **`POST /tabs`** (`:695-832`) and **`POST /panes/:id/split`** (`:1250-1394`): when `body.agent` is
  set → `createFreshAgentPane` (`:546-589`) → `freshAgentRuntimeManager.create({requestId, sessionType,
  provider, cwd, model, effort})`, attaches a `kind:'fresh-agent'` pane content with the placeholder
  sessionId, broadcasts a UI command.
- **`POST /panes/:id/send-keys`** (`:1669-1782`): for a fresh-agent pane →
  `freshAgentRuntimeManager.send(locator,{text,settings})`, then **blocks** on
  `waitForFreshAgentIdle` (polls `getSnapshot().status==='idle'`, `:89-101`, 600 s default
  `:87`). On materialization (`finalSessionId !== locator.sessionId`) it persists the durable id back
  into the pane and broadcasts `freshAgent.session.materialized` (`:1731-1744`). Auto-`attach`-then-
  retry on `FreshAgentLostSessionError` (`:1701-1708`).
- **`GET /panes/:id/capture`** (`:904-957`): fresh-agent → `getSnapshot` →
  `renderFreshAgentTranscript` (`:331-347`) as text/plain.
- **`GET /panes/:id/wait-for`** (`:959-1068`): fresh-agent → poll snapshot `status==='idle'`
  (`:964-988`); terminal panes → pattern/stable/exit/prompt matching on the PTY buffer.
- Provider gating: `AGENT_SESSION_TYPES` (`:540-544`) maps `opencode/claude/codex` →
  `{sessionType, provider}`; unknown agent → 400; missing runtime → 503.
- Error→status mapping: `agentRouteErrorStatus`/`freshAgentErrorStatus` (`:54-85`) — LostSession→404,
  Unsupported/LocatorMismatch/StaleRevision→409, RuntimeUnavailable→503, ContractValidation→502.
- Same mapping mirrored in the WS read-model router (`server/fresh-agent/router.ts:99-167`) for
  `GET /fresh-agent/threads/:sessionType/:provider/:threadId(/turns(/:turnId))`.

### 6c. Legacy `codingcli.*` WS handlers (`server/ws-handler.ts`)

- `codingcli.create` (`:3147-3256`): guards on `codingCliManager`, `hasProvider`, and
  `cfg.settings.codingCli.enabledProviders`; `manager.create(provider, opts)` spawns the CLI and
  subscribes `codingcli.event/.exit/.stderr`. `codingcli.input` (`:3258-3272`),
  `codingcli.kill` (`:3274-3289`).
- `CodingCliSessionManager` (`session-manager.ts:219-325`): spawns via provider `getStreamArgs`,
  line-buffers stdout, parses via `provider.parseEvent` into `NormalizedEvent`s (`:147-167`),
  captures the first `providerSessionId`, ring-buffers ≤ `FRESHELL_MAX_SESSION_EVENTS` events
  (`:130-145`), and auto-cleans completed sessions after 30 min (`:238-255`). Only providers with
  `supportsLiveStreaming()` are allowed (claude=true `claude.ts:748`, codex=true `codex.ts:646`,
  opencode=false `opencode.ts:370`); streaming resume requires `supportsSessionResume()`
  (`session-manager.ts:276-281`). **The T2 baselines do NOT drive this path** — decide during port
  whether to carry it (it is in the frozen contract, `WS_PROTOCOL_VERSION=7`).

---

## 7. Nondeterminism inventory (cross-checked vs `port/contract/nondeterministic-fields.md`)

Fields this subsystem emits that the oracle normalizes before diffing (must preserve **shape**, mask
**value**):

| Field | Kind | Where it originates in this subsystem |
|---|---|---|
| `sessionId` | provider session id | claude nanoid→UUID, codex thread UUID, opencode `freshopencode-*`→`ses_*` — `freshAgent.created/.event/.materialized/.send.accepted/.forked/.killed` |
| `previousSessionId` | prior id | `freshAgent.session.materialized` (opencode only) — `adapter.ts:318`, `ws-handler.ts:3479` |
| `submittedTurnId` | signed display id | `freshAgent.send.accepted` — codex `createCodexDisplayId` `adapter.ts:981-988`, opencode/claude undefined |
| `requestId` | correlation | `freshAgent.create/.send/.fork` |
| `serverInstanceId`, `bootId` | per-boot | codex ownership metadata (`runtime.ts:923`), `ready`/`terminal.create` |
| `candidateThreadId`, `durableThreadId`, `rolloutPath`, `cliVersion`, `capturedAt` | codex durability | `terminal.codex.durability.updated`, durability store |
| `cwd` | host path | all `freshAgent.*` + REST create |
| `at`, `completionSeq` | turn-complete clock | `freshAgent.turn.complete`, `*.activity.list.response` |
| token counts | usage | claude `result.usage` (`sdk-bridge.ts:439-455`), codex `token_count`, opencode message parts |
| `event` (unknown), `data`, `text`, `title`, `model` | opaque/LLM | `freshAgent.event` payloads, PTY `data`, provider stderr, model echo — assert parseable/present only |

Deterministic (must match exactly): `type` discriminants, `wsProtocolVersion=7`, enums
(`provider`, `sessionType`, `sandbox`, `permissionMode`, `CodexTurnStatus`, `ErrorCode`), `code`,
booleans (`ok/success/accepted`), and the id-SHAPE regexes (`invariants.ts:165-198`).

**Invariants the T2 oracle already asserts** for this subsystem (`invariants.ts:219-386`):
`session.created` (placeholder shape), `session.durable-id-shape`, `turn.accepted`, `turn.completed`
(reply persisted, secondary), `assistant.replied-sentinel` (sentinel substring only, never text
equality), `transcript.persisted` (isolated store row + ≥1 message), `transcript.parseable`,
`ownership.cleanup` (no sentinel-owned strays), and the FATAL provider-specific completion edge
(`provider.emits-completion-signal` for claude/codex, `provider.emits-idle-signal` for opencode).
Informational (non-gating): `wire.session-materialized`, `cost.live-calls-bounded` (1–2 live calls).

---

## 8. Port risk callouts & sidecar recommendations

### 8a. Native / SDK dependency inventory (`package.json`)

| Dep | Version | Used by | Rust equivalent? |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | ^0.2.40 | claude/kilroy runtime (`sdk-bridge.ts:1-15`) | **NONE** (JS-only vendor SDK) |
| `@modelcontextprotocol/sdk` | ^1.27.1 | freshell MCP server (`server/mcp/server.ts`), called by claude | **near-equivalent exists** (Rust `rmcp`/official rust-sdk) |
| `node-pty` | ^1.2.0-beta.10 | terminal PTYs (not fresh-agent core) | yes — `portable-pty` (per `port/AGENTS.md:46`) |
| codex app-server | (spawned `codex` binary; JSON-RPC/WS) | codex runtime | **yes** — `tokio-tungstenite` + serde |
| opencode serve | (spawned `opencode` binary; HTTP+SSE) | opencode runtime | **yes** — `reqwest` + an SSE client |
| `node:sqlite` | Node ≥22.5 builtin | opencode.db reads | **yes** — `rusqlite` |
| chokidar | 3.6.0 | session-indexer | **yes** — `notify` crate |

### 8b. Sidecar recommendation (per `port/AGENTS.md:48-53`)

The AGENTS.md rule: JS/Node sidecar is permitted ONLY when it is a *massive net savings* — a
dependency with **no Rust equivalent** (e.g. a vendor SDK that exists only in JS), justified in the
ADR with the missing-crate reason, isolated behind a process boundary, and oracle-covered.

- **RECOMMEND a Node sidecar for the Claude runtime (`@anthropic-ai/claude-agent-sdk`).**
  Justification: there is no Rust Anthropic Agent SDK. The SDK encapsulates a large, behavior-sensitive
  surface the T2 grader is sensitive to — subprocess `stream-json` framing, `result.subtype` values
  (the `'success'` completion edge), partial-message streaming, `canUseTool`/`AskUserQuestion`
  permission+question flows and their `0→≥1` waiting edge, `/compact`, plugin loading,
  `settingSources`, and the clean-env (`createClaudeSdkCleanEnv` strips `CLAUDECODE` +
  `ANTHROPIC_API_KEY`, `sdk-bridge.ts:64-66`). Reimplementing this against the raw `claude` CLI is
  high-risk for T2 divergence. A thin Node sidecar wrapping `SdkBridge` behind a process boundary
  (stdin/stdout JSON or a local WS) is the lower-risk path; the sidecar is graded by T2 like any other
  component. **Alternative** (allowed if proven): reimplement in Rust against the `claude` CLI's
  `--output-format stream-json --verbose` protocol (the layer-A codex/claude providers already show
  the CLI arg shapes, `claude.ts:605-629`) — only if a spike proves byte/edge parity.
- **MCP server (`@modelcontextprotocol/sdk`): NOT an independent sidecar candidate.** A Rust MCP SDK
  exists (`rmcp`), so the rule's "no equivalent" bar is not met. Two options: (a) reimplement the
  `freshell` tool server in Rust with `rmcp`; or (b) if the Claude sidecar is adopted, **reuse the
  existing Node MCP server as-is** (it is already spawned by `node` from within the SDK,
  `sdk-bridge.ts:72`) — no new sidecar, just retained tooling behind the claude sidecar boundary.
- **codex + opencode runtimes: pure Rust, no sidecar.** Both are process+protocol shims to vendor
  binaries (`codex`, `opencode`) with fully-portable transports (WS JSON-RPC; HTTP+SSE). The
  behavior lives in freshell's own adapters, which port directly.

### 8c. Top 3 fidelity risks (most likely to diverge)

1. **Claude SDK behavioral edges** (placeholder-nanoid vs cliSessionId-durable split; the
   `subtype==='success'` completion chime; the `0→≥1` pending waiting edge; MCP injection; clean-env).
   A CLI-reimplementation will most likely diverge here on T2 `provider.emits-completion-signal` and
   the id-shape invariants. **Mitigation:** the Node sidecar in §8b, or a red/green spike pinned to
   `claude-haiku.json`.
2. **Per-provider materialization + completion asymmetry.** opencode DOES materialize
   (`freshopencode-*` → `ses_*`, fires `freshAgent.session.materialized`) and completes on the idle
   edge; claude AND codex do NOT materialize (placeholder==durable, no materialized event) and
   complete on the discrete `freshAgent.turn.complete`, with codex's edge **status-guarded** on
   `params.turn.status ?? params.status === 'completed'`. Getting the materialize-yes/no per provider
   and the exact codex status guard right is precisely where the differ + `wire.session-materialized`
   / `provider.emits-completion-signal` invariants bite (baselines encode all three).
3. **session-indexer late-root watcher liveness (DEV-0002).** The port replaces chokidar with
   `notify`, whose close/teardown semantics differ; the original's crash-on-late-root must become
   **log + degrade + rescan, process stays alive**. The T2 message-differ is structurally blind to
   this (env parity pre-creates the roots), so the ONLY guard is the mandatory Rust liveness pinning
   test — easy to under-build.

Plus two ledger constraints that are port-behavior (not free choices): **DEV-0001** — the port's
opencode `waitForHealth` MUST bound each probe (2 s AbortController, 150 ms retry, unchanged outer
deadline) and land its pinning test; **DEV-0003** — the port MUST forward codex `none`/`minimal`
effort verbatim (no clamp).

---

## 9. Rust port acceptance checklist (behavior → verifying oracle tier)

Legend: **T0** = frozen WS/JSON-schema contract (`port/contract/ws-protocol.schema.json`);
**T2** = live cheapest-model behavioral invariants (`invariants.ts`, baselines in
`port/oracle/baselines/t2/`); **LT** = dedicated port-side liveness/unit test (differ-blind);
**T1** = deterministic PTY golden (not the primary tier here).

| # | Behavior (with cite) | Tier |
|---|---|---|
| 1 | `freshAgent.create` returns `{sessionId, sessionType, runtimeProvider, sessionRef?}`; idempotent by `requestId` (`ws-handler.ts:3304-3386`) | T0 + T2 `session.created` |
| 2 | opencode placeholder `^freshopencode-` (`adapter.ts:74-76`) | T2 `session.created` (baseline `opencode-kimi`) |
| 3 | claude placeholder = bare nanoid `^[A-Za-z0-9_-]{16,32}$` (`sdk-bridge.ts:165`) | T2 `session.created` (baseline `claude-haiku`) |
| 4 | codex placeholder = durable thread UUID (`adapter.ts:840`) | T2 `session.created` + `session.durable-id-shape` (baseline `codex-gptmini`) |
| 5 | opencode first-send materializes → `ses_*` + fires `freshAgent.session.materialized` (`adapter.ts:340-350`, `ws-handler.ts:3471-3485`) | T2 `session.durable-id-shape` + `wire.session-materialized` |
| 6 | claude & codex do NOT materialize (send returns void / no sessionId) (`adapter.ts:153-161`, codex `:1001`) | T2 `wire.session-materialized=false` (baselines) |
| 7 | claude completion chimes ONLY on SDK `result.subtype==='success'` (`sdk-bridge.ts:469`) | T2 `provider.emits-completion-signal` |
| 8 | codex completion status-guarded `params.turn.status ?? params.status==='completed'` (`adapter.ts:922-924`) | T2 `provider.emits-completion-signal` |
| 9 | opencode completion = idle ∧ `!turnAborted ∧ !turnErrored` (`adapter.ts:377-381`) | T2 `provider.emits-idle-signal` |
| 10 | interrupt/error/crash never chime (`sdk-bridge.ts:344-353`; codex `onExit`/`thread_closed` `:887-946`; opencode `turnAborted/turnErrored`) | T2 (negative — no false green) + LT |
| 11 | claude `0→≥1` pending → `freshAgent.turn.waiting` (`sdk-bridge.ts:515-518,563,625`) | T0 + LT |
| 12 | Transcript persists to the ISOLATED store (claude `.jsonl`, codex rollout, opencode.db) (§2) | T2 `transcript.persisted` + `transcript.parseable` |
| 13 | claude JSONL parse — sessionId/cwd/usage/title (`claude.ts:322-510`) | LT (unit) + T2 `transcript.parseable` |
| 14 | codex rollout parse — session_meta/response_item/event_msg (`codex.ts:256-390`) | LT (unit) + T2 |
| 15 | opencode.db schema+query — `session(id,parent_id)`, worker-thread listing, degrade classes (`opencode.ts:133-336`) | LT (unit) + T2 |
| 16 | session-indexer late-root watcher **degrades, never crashes** (DEV-0002; `session-indexer.ts:465-598`) | **LT** `coding_cli_late_root_watcher.rs` (differ-blind) |
| 17 | codex app-server JSON-RPC/WS: `initialize`→`initialized`, request/notify envelopes (`client.ts:144-165`, `protocol.ts:329-415`) | T0 (schema) + T2 |
| 18 | codex readiness bounded by `startupAttemptTimeoutMs` (`runtime.ts:1476-1507`) | LT (inject never-resolving initialize) |
| 19 | codex ownership/reaper: PGID + `/proc` scan, no orphans; onExit clears BLUE no-chime (`runtime.ts:1532-1595`, `adapter.ts:935-946`) | T2 `ownership.cleanup` + LT |
| 20 | codex durability store: atomic 0600 JSON by terminalId, immutable candidate (`durability-store.ts`) | LT (unit) |
| 21 | codex fork → new threadId `excludeTurns` (`adapter.ts:1053-1080`); opencode fork → child `ses_` (`adapter.ts:546-563`) | T0 + T2 (fork slice) |
| 22 | **DEV-0001** opencode `waitForHealth` bounded per-probe (2 s abort, 150 ms retry, deadline unchanged) — PORT fix, original stays pristine | LT `opencode_serve_health.rs` (+ interim TS mirror) |
| 23 | **DEV-0003** codex `none`/`minimal` effort forwarded VERBATIM, no clamp (`protocol.ts:26`, `adapter.ts:130-131`) | T2 codex differ (no tolerance) |
| 24 | Model/effort normalization: freshcodex model clamp, `xhigh→max`, menu clamp (`fresh-agent-models.ts:101-152`) | LT (unit) + T2 (model echo) |
| 25 | REST `/tabs`,`/panes/:id/{split,send-keys,capture,wait-for}` fresh-agent behavior incl. blocking send + idle poll + materialize persist (`agent-api/router.ts`) | T0 + T2 (drive path) |
| 26 | MCP `freshell` tool action-dispatch → REST; injected into claude SDK (`freshell-tool.ts`, `sdk-bridge.ts:69-79`) | T0 + LT (if claude sidecar retains it, reuse verbatim) |

---

## Appendix — key files (fastest path back in)

- Runtime spine: `server/fresh-agent/runtime-manager.ts`, `runtime-adapter.ts`, `provider-registry.ts`, `sdk-events.ts`; `shared/fresh-agent.ts`, `shared/fresh-agent-models.ts`.
- Adapters: `server/fresh-agent/adapters/{claude,codex,opencode}/adapter.ts`; `server/sdk-bridge.ts` (claude SDK), `server/fresh-agent/adapters/opencode/serve-manager.ts` (DEV-0001 `:269-301`).
- Codex app-server: `server/coding-cli/codex-app-server/{runtime.ts,client.ts,protocol.ts,durability-store.ts,launch-planner.ts,recovery-policy.ts,restore-decision.ts}`.
- Indexer + providers (layer C): `server/coding-cli/session-indexer.ts` (DEV-0002 `:465-598`), `server/coding-cli/providers/{claude,codex,opencode}.ts`.
- Legacy layer A: `server/coding-cli/session-manager.ts`; ws handlers `server/ws-handler.ts` (`codingcli.*` `:3147-3289`, `freshAgent.*` `:3291-3630`).
- Orchestration: `server/mcp/freshell-tool.ts`, `server/agent-api/router.ts`, `server/fresh-agent/router.ts`.
- Oracle cross-refs: `port/oracle/harness/invariants.ts`, `port/oracle/baselines/t2/*.json`, `port/contract/nondeterministic-fields.md`, `port/oracle/DEVIATIONS.md`.
