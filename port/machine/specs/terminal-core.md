# Terminal Core — Ground-Truth Behavioral Specification

**Scope:** the PTY core that a Rust `freshell-terminal` crate (built on `portable-pty`) must
reproduce byte-for-byte and message-for-message so the oracle's **T0** (protocol conformance) and
**T1** (deterministic PTY byte/seq replay) tiers grade the port green.

**Source of truth = the CODE**, not docs. Every claim below cites `file:line` in
`.worktrees/rust-tauri-port`. Where the code fixes/omits something the frozen contract still
allows, it is flagged as a **[DIVERGENCE]** or **[PORT RISK]**.

**Primary files**
- `server/terminal-registry.ts` (4933 ln) — PTY spawn, `TerminalRecord`, lifecycle, input/resize/kill, char scrollback.
- `server/terminal-stream/broker.ts` (2285 ln) — seq ring, attach/replay, output framing, gaps, backpressure.
- `server/terminal-stream/*.ts` — ring/deque, batch builder, barrier scanner, client queue, stream identity.
- `server/ws-handler.ts` (3879 ln) — `terminal.*` message dispatch (`case` @ 1949/2621/2785/2804/2930/2965).
- Frozen contract: `port/contract/ws-server-messages.schema.json`, `ws-protocol.schema.json`, `nondeterministic-fields.md`.

**Two-buffer architecture (critical mental model).** There are **two independent buffers** per terminal:

| Buffer | Where | Unit | Default cap | Purpose | Seq? |
|---|---|---|---|---|---|
| `ChunkRingBuffer` | `TerminalRecord.buffer`, registry | **UTF‑16 chars** (`str.length`) | `computeScrollbackMaxChars` = clamp(`scrollbackLines*300`, 64 KiB, 4 MiB), env default **512 KiB** | one-shot **snapshot** seed on first broker attach | no |
| `ReplayRing`→`ReplayDeque` | `BrokerTerminalState.replayRing`, broker | **UTF‑8 bytes** | plain shell **1 MiB**; coding-CLI floor **32 MiB** | authoritative **seq'd replay** for `terminal.output`/`.gap` | **yes** |

Evidence: `terminal-registry.ts:1644` (`buffer: new ChunkRingBuffer(this.scrollbackMaxChars)`),
`terminal-registry.ts:810-853` (`ChunkRingBuffer`, char-measured), `terminal-registry.ts:57-60`
(scrollback constants), `broker.ts:688-704` (`getOrCreateTerminalState` → `new ReplayRing`),
`replay-ring.ts:22` (`DEFAULT_TERMINAL_REPLAY_RING_MAX_BYTES = 1 MiB`), `broker.ts:50`
(`DEFAULT_CODING_CLI_REPLAY_RING_MAX_BYTES = 32 MiB`), `broker.ts:418-423` (snapshot seeds the ring
only when `replayRing.headSeq() === 0`).

---

## 1. Terminal lifecycle state machine

### 1.1 Identifiers and how they relate

| Id | Minted by | Shape | Evidence |
|---|---|---|---|
| `terminalId` | `nanoid()` at create | nanoid alphabet | `terminal-registry.ts:1560` |
| `createRequestId`/`requestId` | client (`terminal.create.requestId`) | client-chosen correlation | schema `terminal.create` requires `requestId`; echoed in `terminal.created.requestId` `ws-handler.ts:2156` |
| `streamId` | `randomUUID()`, per terminal, **replaceable** | UUID v4 | `stream-identity.ts:24,54-58`; ensured `broker.ts:805`, replaced `broker.ts:2171-2191` |
| `attachRequestId` | client (`terminal.attach.attachRequestId`) | client correlation, ≤512-byte serialized budget | budget `serialized-budget.ts:17-23`; stored `broker.ts:412` |
| `serverInstanceId` | `srv-${pid}` or env | per-boot | `terminal-registry.ts:1300` |

**Relationship:** one `terminalId` owns exactly one live `streamId` at a time (generation-counted in
`stream-identity.ts:16-19`). A new PTY session (codex recovery / restart) mints a **new** `streamId`
and emits `terminal.stream.changed` (`broker.ts:2194-2208`). `attachRequestId` scopes a single
attach attempt of one ws to one terminal and is echoed back on `attach.ready`/`output`/`gap`.

### 1.2 States (server-authoritative)

`TerminalRecord.status: 'running' | 'exited'` (`terminal-registry.ts:565`). There is no explicit
"attached/detached" record status — **detached ≡ `clients.size === 0`** while still `running`
(background session). Per-attachment (broker) state adds `mode: 'attaching' | 'live'` and
`priority: 'foreground' | 'background'` (`types.ts:6-7`, `broker.ts:410,603`).

```
                         terminal.create
 (none) ───────────────────────────────────────────▶ running (clients=0, detached/background)
                                                        │  ▲
                       terminal.attach (broker.attach)  │  │ terminal.detach  (clients→0)
                       mode attaching→live, clients+1    ▼  │
                                                     running (clients≥1, foreground/attached)
                                                        │
        pty onExit  │  terminal.kill  │  idle auto-kill │
                    ▼                 ▼                  ▼
                                     exited  ──(reap, keep ≤ maxExitedTerminals=200)──▶ (deleted)
```

**Transition details & the emitted wire events:**

- **create** — `registry.create()` `terminal-registry.ts:1544-1740`. Spawns PTY, builds record with
  `status:'running'`, `clients:new Set()`, `createdAt=lastActivityAt=Date.now()`. ws-handler then sends
  **`terminal.created`** `{type, requestId, terminalId, createdAt, cwd?, sessionRef?, clearCodexDurability?, restoreError?}` (`ws-handler.ts:2154-2163`). Create does **not** attach; the client must send `terminal.attach` next.
  Guard: `runningCount() >= maxTerminals` throws (`terminal-registry.ts:1556-1558`).
- **attach** — `broker.attach*()` `broker.ts:258-610`. Sets `mode='attaching'`, seeds ring if empty,
  computes replay, sends **`terminal.attach.ready`**, optional **`terminal.output.gap`**, then flips
  `mode='live'` and schedules flush. Adds ws to `record.clients` via `registry.attach(...,{suppressOutput:true})` (`broker.ts:348`).
- **detach** — `broker.detach()` `broker.ts:618-639` → `registry.detach()`; ws-handler replies
  **`terminal.detached`** `{type, terminalId}` (`ws-handler.ts:2800`). Terminal keeps running.
- **exit (pty)** — `ptyProc.onExit` `terminal-registry.ts:1751` → (codex recovery branch may intercept)
  → `finishTerminalPtyExit()` `1479-1510`: `status='exited'`, `exitCode`, sends **`terminal.exit`**
  `{type, terminalId, exitCode}` to every client, clears clients, `emit('terminal.exit')` (broker listens
  → `handleTerminalExit`), `reapExitedTerminals()`.
- **kill** — `registry.kill()` `3997-4033`: `pty.kill()`, `status='exited'`, `exitCode = exitCode ?? 0`,
  sends **`terminal.exit`** to clients, `emit('terminal.exit')`.

### 1.3 Background (detached) sessions + idle timeout

- A terminal with `clients.size === 0` keeps running and buffering (both buffers) — this is the
  **background session**. Output still flows into `ChunkRingBuffer` (`1685`) and (via the broker's
  `terminal.output.raw` listener) into the `ReplayRing` (`broker.ts:777-801`); with no attachments the
  broker just accumulates seqs.
- **Idle auto-kill:** `startIdleMonitor()` `terminal-registry.ts:1335-1340` runs `setInterval(30_000ms)`.
  `enforceIdleKills()` `1406-1425`: for each `status==='running'` terminal with **`clients.size===0`**
  (`1415`, "only detached"), if `(now - lastActivityAt)/60000 >= settings.safety.autoKillIdleMinutes`
  → `kill(terminalId,{recoverableForRestore:true})`. Disabled when `autoKillIdleMinutes <= 0` (`1410`).
- `lastActivityAt` is bumped on **every** PTY output (`1684`) and **every** input write (`3873`).

### 1.4 Exited-terminal retention

`reapExitedTerminals()` `1512-1527` keeps at most `maxExitedTerminals` (env `MAX_EXITED_TERMINALS`,
default **200**, `1298`) exited terminals **without a sidecar**, deleting the oldest by `exitedAt`.
Attaching to an exited terminal → `INVALID_TERMINAL_ID` error with `terminalExitCode` (`ws-handler.ts:2648-2662`).

> **Port scope note:** codex/claude/opencode durability, session-binding, `codexInputGate`, and sidecar
> recovery machinery are **coding‑CLI concerns**, out of scope for `freshell-terminal` (a plain PTY).
> The port must implement the **`mode:'shell'`** path faithfully and treat coding-CLI branches as no-ops.

---

## 2. PTY spawn (must match `portable-pty` exactly)

Single spawn site for `mode:'shell'`: `terminal-registry.ts:1594-1600`:

```ts
pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: procCwd, env })
```

### 2.1 Geometry defaults
- `cols = opts.cols || 120`, `rows = opts.rows || 30` (`terminal-registry.ts:1562-1563`).
  (Note the `||`: a client-sent `0` falls back to the default.)
- PTY name is the literal **`'xterm-256color'`** (`1595`).

### 2.2 Shell resolution (`ShellType = 'system'|'cmd'|'powershell'|'wsl'`, `74`)

`resolveShell()` `949-965` then `buildSpawnSpec()` `1059-1266`:

- **Linux/macOS (non-WSL):** everything normalizes to `'system'` (`963-964`). `getSystemShell()`
  `971-989`: `$SHELL` if set & `existsSync`; else macOS → `/bin/zsh`→`/bin/bash`→`/bin/sh`, Linux →
  `/bin/bash`→`/bin/sh`. **shell mode args = `['-l']`** (`1255`): `{file: systemShell, args:['-l'], cwd: unixCwd, env}`.
- **Native Windows:** `'system'`→`'cmd'` (`952`). cmd → `getWindowsExe('cmd')` = `cmd.exe`, args `['/K']`
  (`1200`). powershell → `powershell.exe` (env `POWERSHELL_EXE`), args `['-NoLogo']` (`1232`).
- **WSL:** `'system'`/`'wsl'`→ Linux shell (above). `'cmd'`/`'powershell'` use interop; a Linux `cwd`
  forces WSL mode from native Windows (`1130`). WSL mode → `wsl.exe` (env `WSL_EXE`) with
  `['--cd', <linuxCwd>, '--exec','bash','-l']` for shell (`1141-1160`); optional `-d <distro>` (`1145`).
  Windows exe paths on WSL come from `WSL_WINDOWS_SYS32 || /mnt/c/Windows/System32` (`896`).

### 2.3 cwd
`cwd = opts.cwd || getDefaultCwd(settings) || (isWindows() ? undefined : os.homedir())`
(`1565`). `getDefaultCwd` `855-860` validates `settings.defaultCwd` via `isReachableDirectorySync`.
For unix shell the value passed to `pty.spawn` is `resolveUnixShellCwd(cwd)` (`1252`, `907-909`). On
WSL/Windows-exe paths `procCwd` is often `undefined` and cwd is applied inside the command
(`cd /d`, `Set-Location`) — **[PORT RISK]** platform-glue territory (see §9).

### 2.4 Environment (exact)
`buildSpawnSpec` `1083-1105`:
- **Stripped from parent env:** `CLAUDECODE, CI, NO_COLOR, FORCE_COLOR, COLOR, PORT, AUTH_TOKEN,
  ALLOWED_ORIGINS, NODE_ENV, npm_lifecycle_script, OPENCODE_SERVER_USERNAME, OPENCODE_SERVER_PASSWORD`.
- **Forced overrides (in order):**
  `TERM = process.env.TERM || 'xterm-256color'`, `COLORTERM = process.env.COLORTERM || 'truecolor'`,
  `LANG = 'en_US.UTF-8'`, `LC_ALL = 'en_US.UTF-8'` (`1100-1103`).
- **Then `envOverrides`** = `buildTerminalBaseEnv()` `1529-1541`:
  `FRESHELL_URL` (`http://localhost:${port}`), `FRESHELL_TOKEN` (`AUTH_TOKEN||''`),
  `FRESHELL_TERMINAL_ID = terminalId`, plus `FRESHELL_TAB_ID`/`FRESHELL_PANE_ID` when present.

> **[PORT RISK — determinism]** `LANG`/`LC_ALL`/`TERM`/`COLORTERM` and the strip-list must match exactly, or
> the child shell's prompt/coloring bytes differ and **T1 goldens break**. `FRESHELL_URL` embeds a port
> (nondeterministic → not part of PTY byte stream, but leaks into child env; keep out of golden‑visible output).

---

## 3. Scrollback ring buffer & the seq contract (highest-fidelity area — T1)

The seq/byte contract lives entirely in the **broker's** `ReplayRing`→`ReplayDeque`, not the char scrollback.

### 3.1 Seq assignment (`ReplayDeque`, `replay-deque.ts:37-81`)
- `nextSeq` starts at **1**; `head` starts at **0** (`41-42`).
- Each `append`: `seq = nextSeq++`; frame gets `seqStart = seqEnd = seq`; `head = seq` (`59-61,65-66`).
  **One appended fragment = one seq = one frame.** (Multi-seq spans only appear after batch *merge*, §4.)
- `bytes = Buffer.byteLength(data,'utf8')` (`68`) — **UTF‑8 byte length**, even though offsets are char-based (§4).

### 3.2 How raw output becomes frames (`broker.ts:803-826`)
`appendOutputFrames(terminalId, data)`:
1. `streamId = ensureStream(terminalId)`.
2. `fragmentTerminalOutputForPayloadBudget()` (`output-fragments.ts:17-59`) splits `data` on **code
   points** (never mid surrogate pair) so each fragment's *serialized `terminal.output` JSON* ≤
   `TERMINAL_STREAM_BATCH_MAX_BYTES`. Measured with a worst-case seq placeholder
   `Number.MAX_SAFE_INTEGER` and a 512-char reserve `attachRequestId` (`broker.ts:812-816`).
3. Each fragment → `replayRing.append(fragment,{streamId})` → one `ReplayFrame`.

`TERMINAL_STREAM_BATCH_MAX_BYTES` = `max(1024, env || MAX_REALTIME_MESSAGE_BYTES)` (`constants.ts:3-6`).

### 3.3 Byte-budget eviction (`replay-deque.ts:159-187`)
- After append, while `retainedBytes > maxBytes && retainedCount > 0`: drop front frame,
  `retainedBytes -= frame.bytes`, set `retentionLossPending = true` (`160-166`). Eviction is
  **whole-frame**, front-to-back (FIFO).
- `ReplayRing.append` first passes data through `normalizeFrameData` (`replay-ring.ts:139-154`):
  if a single chunk exceeds `maxBytes`, it is **truncated to the last `maxBytes` bytes on a valid
  UTF‑8 boundary** (fatal decoder walk). Barrier classification then becomes conservative (`115-129`).
- `consumeRetentionLoss()` is polled after appends → broker logs retention loss and, on a stale attach,
  surfaces a gap / `terminal.stream.changed reason:'retention_lost'` (`broker.ts:2235-2267`).

### 3.4 Seq accessors (must match exactly)
- `headSeq()` = `head` (0 when empty, else last assigned seq) — `replay-deque.ts:135-137`.
- `tailSeq()` = `firstFrame.seqStart` (or `head+1` when empty) — `139-142`.
- `replaySince(sinceSeq)` `89-98`: `normalizeSinceSeq`: `undefined|0 → 0` (`144-146`). Returns all frames
  with `seqStart > sinceSeq` (binary search `firstFrameIndexAfter`, `197-218`).
- **`missedFromSeq`** (gap detector) `148-157`: with a retained `firstFrame`, returns `sinceSeq+1`
  **iff `sinceSeq < firstFrame.seqStart - 1`** (requested point is older than the retained window);
  else `undefined`. Empty ring: returns `sinceSeq+1` iff `sinceSeq < head`.

### 3.5 Snapshot-on-attach + replay window (`broker.ts:312-610` — the core of T1)

Sequence inside `withTerminalLock` (`broker.ts:2269-2284`, per-terminal serialization):

1. `normalizedSinceSeq = (sinceSeq===undefined||0) ? 0 : sinceSeq` (`329`).
2. `registry.attach(...,{suppressOutput:true})` adds ws to `record.clients` (`348`).
3. Resize-on-attach (§5.3). `mode='attaching'`, `priority`, `queue.clear()`, `attachStaging=[]` (`410-415`).
4. **Seed ring from char snapshot only if empty:** `if replayRing.headSeq()===0 { appendOutputFrames(snapshot) }`
   (`418-423`). The `ChunkRingBuffer.snapshot()` becomes seqs `1..N`.
5. `streamId = recordAttach(terminalId)` (`425`).
6. **Replay-reset:** if `geometryAuthority==='multi_client_unknown' && normalizedSinceSeq>0` →
   `replayResetReason='geometry_authority_unknown'`, `effectiveSinceSeq=0` (full replay); else
   `effectiveSinceSeq=normalizedSinceSeq` (`426-429`).
7. `replay = replayRing.replaySince(effectiveSinceSeq)`; `headSeq=replayRing.headSeq()` (`441-445`).
8. **`maxReplayBytes` budget truncation** (`449-482`): walk frames newest→oldest summing serialized
   `terminal.output` bytes; keep the tail that fits; if truncated set `budgetTruncated=true` and
   `effectiveMissedFromSeq`.
9. Stream filter (`484`): drop frames whose `streamId != current` (records `skippedGaps`).
10. `replayFromSeq = frames.length>0 ? frames[0].seqStart : headSeq+1` (`488`).
    `replayToSeq = frames.length>0 ? frames[last].seqEnd : headSeq` (`489`).
11. **Send `terminal.attach.ready`** (`503-517`) — fields §6-table below.
12. If `effectiveMissedFromSeq !== undefined`: `missedToSeq = replayFromSeq-1`;
    `reason = budgetTruncated ? 'replay_budget_exceeded' : 'replay_window_exceeded'`; if
    `missedToSeq >= effectiveMissedFromSeq` send **`terminal.output.gap`** BEFORE replay frames (`521-567`).
13. Stage live frames that arrived during attach with `seqStart > replayToSeq` (`586`); set
    `replayCursor = frames.length>0 ? {nextSeq:replayFromSeq, toSeq:replayToSeq, streamId} : null` (`588`).
14. `mode='live'`; schedule flush (`603-606`).

**`terminal.attach.ready` field derivation** (frozen: required `headSeq, replayFromSeq, replayToSeq, streamId, terminalId, type`):

| Field | Value | Evidence |
|---|---|---|
| `streamId` | `recordAttach(terminalId)` | `broker.ts:425,506` |
| `geometryEpoch` | `terminalState.geometryEpoch` (starts 1, +1 per real geometry change) | `695,681,507` |
| `geometryAuthority` | `single_client｜server_stream｜multi_client_unknown` | `508`, enum `nondeterministic-fields.md`/schema |
| `requestedSinceSeq` | `normalizedSinceSeq` | `509` |
| `effectiveSinceSeq` | `replayResetReason?0:normalizedSinceSeq` | `510` |
| `replayResetReason?` | only `'geometry_authority_unknown'` | `511` |
| `headSeq` | `replayRing.headSeq()` | `512` |
| `replayFromSeq` | first replayed `seqStart`, else `headSeq+1` | `513` |
| `replayToSeq` | last replayed `seqEnd`, else `headSeq` | `514` |
| `attachRequestId?` | echoed if present | `515` |
| `sessionRef?` | coding-CLI only | `516` |

### 3.6 Live replay pacing (`flushReplayCursor`, `broker.ts:960-1057`)
Replay frames stream in `replayBatchSince(cursor.nextSeq-1, BATCH_MAX, cursor.toSeq, …)` batches
(`971-977`), one payload at a time, with mid-stream stream-mismatch gaps converted to
`terminal.output.gap` (`1000-1044`). Cursor completes when `nextSeq > toSeq` or ring drained (`1046-1049`).
Foreground reflushes at delay 0, background at `TERMINAL_STREAM_RETRY_FLUSH_MS=50ms` (`1052-1055`).

### 3.7 Gap contract (`terminal.output.gap`)
Payload `{type, terminalId, streamId, fromSeq, toSeq, reason, attachRequestId?}` — `broker.ts:1741-1749`,
`543-551`. `reason ∈ {queue_overflow, replay_window_exceeded, replay_budget_exceeded}` (frozen enum).
`fromSeq..toSeq` is the **inclusive** missing seq range. Sources:
- **replay window/budget:** attach-time (`523`) and cursor-time (`979-997`).
- **queue overflow:** client output queue evicted frames (`client-output-queue.ts:196-211`,
  `broker.ts:915-937`, reason `'queue_overflow'`). Adjacent evicted ranges are coalesced (`198-210`).
- **stream change:** `convertReplayCursorToCurrentStreamGap` (`broker.ts:2210-2233`).

---

## 4. Output framing

### 4.1 `terminal.output` (legacy / batchV1-off)  — frozen required: `data,seqEnd,seqStart,streamId,terminalId,type`
Built by `buildTerminalOutputPayload` (`broker.ts:2132-2152`):
`{type:'terminal.output', terminalId, streamId, seqStart, seqEnd, data, attachRequestId?, source?}`.
`attachRequestId`/`source` are **omitted when falsy** (`2149-2150`). `source ∈ {live, replay}`.
`data` is **raw UTF‑8** (the exact PTY string). One `ReplayFrame` → one message (`1347-1360`).

### 4.2 `terminal.output.batch` (capability `terminalOutputBatchV1`)
**Negotiation:** client `hello.capabilities.terminalOutputBatchV1` → `state.supportsTerminalOutputBatchV1`
(`ws-handler.ts:1846-1848`, default `false` `1131`), forwarded into `broker.attach` and stored on the
attachment (`broker.ts:399`). Batch form is used **only** when `terminalOutputBatchV1 && attachRequestId`
present (`broker.ts:1315-1343`); otherwise the batch is decomposed into per-segment `terminal.output`
messages (`sendLegacyOutputSegments`, `1522-1546`).

**Merge rule** (`output-batch.ts:235-249,355-415`): consecutive frames merge into one batch **iff**
all hold: next is *transparent-ground* (no barrier, scanner `ground→ground`), current not a barrier,
`next.seqStart === current.seqEnd+1` (contiguous), same `streamId`, same `attachRequestId`, same `source`.
A barrier/non-ground frame (contains ESC/CSI/OSC/DCS/APC/control per §4.4) is emitted **standalone**
(`393-397`). Merge is also capped by `maxSerializedBytes` (`400-405`).

**Wire payload** (`broker.ts:1452-1500`), frozen required:
`attachRequestId,data,segments,seqEnd,seqStart,serializedBytes,source,streamId,terminalId,type`:
- `seqStart`/`seqEnd` = first/last segment span.
- `data` = `batch.data.slice(startOffset,endOffset)` — the **concatenated raw UTF‑8** of the segments.
- `serializedBytes` = self-referential JSON byte size, computed by ≤4-pass fixpoint (`1486-1494`).
- `segments[]` (`buildTerminalOutputBatchWireSegments`, `1502-1520`): each
  `{seqStart, seqEnd, endOffset, rawFrameCount, barrier?}` where:
  - `endOffset` = cumulative **UTF‑16 code-unit** offset (`segment.endOffset - baseOffset`,
    `str.length` units — see `output-batch.ts:194` `endOffset: offset + frame.data.length`).
  - `rawFrameCount = max(1, seqEnd-seqStart+1)` (`1516`).
  - `barrier` present **only** when the segment is a barrier, and its value is the **reason STRING**
    (`{barrier: segment.barrierReason}`, `1517`), not a boolean.

> **[DIVERGENCE — schema looser than runtime]** The frozen segment schema also allows an optional
> per-segment **`data`** field and a `barrier` enum including `'gap'`/`'geometry'`
> (`ws-server-messages.schema.json` segments items). **The runtime never emits segment `data`**, and
> only ever emits the 5 barrier-scanner reasons `control|osc52|request_mode|turn_complete|startup_probe`
> (`output-barrier-scanner.ts:1-6`). The Rust port must match the **runtime** (omit segment `data`; barrier
> reason from the scanner), which is a strict subset the schema still validates. T0 must not require segment `data`.

**Over-budget splitting** (`buildTerminalOutputBatchPayloads`, `1377-1422`): if the full batch's
`serializedBytes > BATCH_MAX`, greedily repack segments into multiple `terminal.output.batch`
messages; a single oversize segment falls back to one `terminal.output` (`1425-1450`).

### 4.3 Backpressure — when the server coalesces / pauses / drops / gaps
Per attachment, `flushAttachment` (`broker.ts:840-958`):
- **ws closed** → `detach` (`843-846`).
- **Catastrophic** (`catastrophicBlocked`, `1087-1109`): `ws.bufferedAmount > 16 MiB`
  (`TERMINAL_WS_CATASTROPHIC_BUFFERED_BYTES`) sustained ≥ 10 s (`TERMINAL_WS_CATASTROPHIC_STALL_MS`)
  → close socket; below threshold resets the timer (`1094-1097`).
- **Background pause:** `priority==='background' && bufferedAmount > 512 KiB`
  (`TERMINAL_BACKGROUND_BUFFERED_PAUSE_BYTES`) → reschedule at 100 ms, don't send (`859-869`).
- **Coalescing:** `queue.prepareBatch(BATCH_MAX,…)` builds merged batches (§4.2) up to budget (`894-898`).
- **Drop → gap:** `ClientOutputQueue` cap = `DEFAULT_TERMINAL_CLIENT_QUEUE_MAX_BYTES = 32 MiB`
  (`client-output-queue.ts:33`); overflow evicts oldest queued frames → **`terminal.output.gap
  reason:'queue_overflow'`** (`157-165,196-211`).
- Retry cadence `TERMINAL_STREAM_RETRY_FLUSH_MS = 50 ms` (`constants.ts:18-21`).

Constants: `constants.ts:8-31`, `broker.ts:50-70`.

### 4.4 Barrier scanner (drives merge + `barrier` reason) — `output-barrier-scanner.ts`
A stateful VT parser over code points, modes `ground｜esc｜csi｜osc｜dcs｜apc` (`8`). Ground TAB/LF/CR
(`0x09/0x0a/0x0d`) are *transparent* (`74-76`); other C0/C1/DEL are `control` barriers (`78-81`).
Reasons by priority (`46-52`): `osc52`(OSC), `request_mode`(CSI `…6n`), `startup_probe`(CSI `…c`),
`turn_complete`(BEL), `control`(else) — see `classifyCsiFinal` `83-92`. Only *transparent-ground*
frames merge; everything else is a standalone segment carrying its reason.

> **[PORT RISK — highest]** This scanner is **byte-exact and stateful across frames** (`scannerStateBefore/
> After` persist in the ring, `replay-ring.ts:62-78`). It decides batch boundaries, so `segments[]`,
> `endOffset`, and `rawFrameCount` all depend on it. A faithful Rust port must reproduce this state machine
> exactly or `terminal.output.batch` framing diverges under T1. (Plain `terminal.output` — batchV1 off — is
> immune, since it's one frame per message.)

---

## 5. Input & resize

### 5.1 Input write path — `terminal.input` (frozen required: `data,terminalId,type`)
`ws-handler.ts:2804-2914` → `registry.inputIfSessionMatches(terminalId, data, expectedSessionRef)`
(`terminal-registry.ts:3896-3942`):
- `no_terminal` → `INVALID_TERMINAL_ID` error (`ws-handler.ts:2911`).
- session mismatch / `not_running` (`3918`) handled.
- **shell path:** `writeTerminalInput` (`3867-3894`): `lastActivityAt=now`, perf accounting,
  `record.pty.write(data)` (`3888`), `emit('terminal.input.raw')`. Returns `{status:'written'}` (no wire reply).
- codex gates (`3905-3939`) produce **`terminal.input.blocked`** — out of scope for shell port.

### 5.2 `terminal.input.blocked` (frozen required: `reason,terminalId,type`)
`{type, terminalId, reason}` (`ws-handler.ts:2828-2899`). Reason enum (all **codex-only**):
`codex_identity_pending, codex_identity_capture_timeout, codex_identity_unavailable,
codex_recovery_pending, codex_clean_exit_decision_pending, codex_lifecycle_loss_pending`. **A plain
shell terminal never emits `terminal.input.blocked`.**

### 5.3 Resize — `terminal.resize` (frozen required: `cols,rows,terminalId,type`)
`ws-handler.ts:2930-2963` → `registry.resizeIfSessionMatches()` (`terminal-registry.ts:3975-3995`):
`missing`/mismatch/`not_running`; **`unchanged`** if `cols===term.cols && rows===term.rows` (`3986`);
else set `term.cols/rows`, `pty.resize(cols,rows)` (errors swallowed, `3989-3993`), return `resized`.
No dedicated success wire message; the effect is observed via subsequent PTY output.

**Geometry epoch** (broker, surfaced on `attach.ready`): `recordTerminalGeometry` `broker.ts:666-686`
normalizes `cols=max(2,floor(cols||80))`, `rows=max(2,floor(rows||24))`; `geometryEpoch += 1` **only on
an actual change** vs previous geometry (`676-682`). Authority: `single_client` default; `multi_client_unknown`
when other sockets attached (`394-395,657-663`). Resize-on-attach fires when
`intent==='viewport_hydrate'` or (`transport_reconnect` && (no other sockets || re-attach)) (`358-362`).
`terminal.attach` intents: `viewport_hydrate｜keepalive_delta｜transport_reconnect` (schema).

---

## 6. Turn-complete / status (server-authoritative edges)

### 6.1 `terminal.turn.complete` (frozen required: `at,completionSeq,provider,terminalId,type`)
**Coding-CLI only.** Broadcast via `broadcastTerminalTurnComplete` (`ws-handler.ts:3742-3754`), called
from `index.ts:446/461/467`, driven by the codex/opencode/claude **activity trackers**
(`coding-cli/*-activity-tracker.ts` own `completionSeq`). `provider ∈ {codex,claude,opencode}`;
`sessionId?` optional. **Plain shell terminals produce no `terminal.turn.complete`.** The `completionSeq`
is a per-provider monotonic counter, *not* the PTY output seq.

### 6.2 `terminal.status` (frozen required: `status,terminalId,type`; `status ∈ {running,recovering}`)
> **[FINDING — no emitter in reference]** `type:'terminal.status'` appears **only** as the TS type
> (`shared/ws-protocol.ts:636-642`); there is **no `broadcast/send` site** anywhere in `server/`
> (verified by exhaustive grep). It is a **defined-but-unemitted** message in the current reference (codex
> "recovering" UX was evidently never wired, or removed). **Port implication:** T0/T1 will never observe it;
> the port need not emit it, but must remain schema-valid if it ever does. Flag for the antagonist as a
> latent contract/impl mismatch (candidate `DELIBERATE_FIX`/ledger note, not a port defect).

### 6.3 `terminal.exit` (frozen required: `exitCode,terminalId,type`)
The true server-authoritative terminal edge for a plain PTY. Sent to each client on pty `onExit`
(`finishTerminalPtyExit`, `terminal-registry.ts:1495`) and on `kill` (`4019`). `exitCode` is the PTY
exit code (`event.exitCode`); on `kill` it defaults to `0` when unknown (`4013`).

---

## 7. Concurrency & ordering guarantees the port MUST preserve

1. **Per-terminal serialization of attach/replay:** `withTerminalLock` chains attach ops per `terminalId`
   (`broker.ts:2269-2284`). Two concurrent attaches to one terminal run strictly in order.
2. **Per-terminal seq monotonicity:** seqs are assigned by a single `ReplayDeque.nextSeq` per terminal,
   strictly increasing, contiguous, never reused (`replay-deque.ts:59-61`). Output order == append order.
3. **Multi-client fan-out:** each attached ws has its own `BrokerClientAttachment` (queue, cursor,
   `lastSeq`, priority) — `broker.ts:739-761`. Every client sees the **same seq stream**; per-client
   drops manifest as per-client `terminal.output.gap`, never as reordering.
4. **Attach staging:** frames arriving while `mode==='attaching'` are buffered in `attachStaging`
   (`broker.ts:783-785`) and only those with `seqStart > replayToSeq` are re-enqueued post-replay
   (`586-601`) — guarantees **no duplicate and no gap** across the replay→live handoff.
5. **`terminals.changed` revision counter** (registry inventory) is **run-monotonic** and normalized by
   the oracle (`nondeterministic-fields.md:71`); the port must emit a monotonically increasing `revision`,
   value itself not asserted.
6. **`geometryEpoch` monotonicity:** increments only on real geometry change, shared across clients
   (`broker.ts:681`).
7. **stream identity generation:** a replaced `streamId` invalidates old-stream frames; clients attaching
   with an old `sinceSeq` get filtered frames + gaps, never cross-stream bytes (`filterReplayFramesForStream`
   `broker.ts:1063-1085`).

---

## 8. Nondeterminism inventory (vs `nondeterministic-fields.md`)

| Field(s) | In messages | Oracle treatment | Port obligation |
|---|---|---|---|
| `terminalId` | all `terminal.*` | mask `<TID:n>`, assert nanoid shape | generate nanoid-alphabet id |
| `streamId` | attach.ready, output, output.batch, gap, stream.changed | mask `<…>`, assert UUID shape | generate UUID v4, one live per terminal |
| `attachRequestId` | attach(.ready), output(.batch), gap | echo client value (opaque) | echo verbatim; enforce ≤512-byte serialized budget (`serialized-budget.ts`) |
| `seqStart,seqEnd` | output, output.batch(+segments) | per-stream ordinal; assert **ordering/monotonic** | reproduce exact seq *arithmetic* (start=1, +1/fragment) so **relative** seqs match T1 |
| `headSeq, replayFromSeq, replayToSeq, requestedSinceSeq, effectiveSinceSeq` | attach.ready | run-monotonic normalize | reproduce derivation §3.5 exactly |
| `fromSeq,toSeq` | output.gap | run-monotonic | reproduce inclusive range math §3.7 |
| `geometryEpoch` | attach.ready | run-monotonic | +1-per-change semantics §5.3 |
| `endOffset,rawFrameCount,serializedBytes` | output.batch(+segments) | run-monotonic / structural | **must match exactly** (deterministic function of data+framing) under T1 |
| `createdAt` | terminal.created | mask `<TS:n>` | any epoch-ms; not byte-diffed |
| `at` | turn.complete | mask `<TS:n>` | coding-CLI only |
| `cwd` | terminal.created | mask `<PATH:n>` | echo resolved cwd |
| `data` | output, output.batch | **opaque blob** — deterministic only for fixed commands (T1), never for LLM | reproduce byte-exact for T1 fixtures |
| **must match exactly (NOT normalized)** | `type`, `reason` enums, `barrier` reason, `source`, `status`, `geometryAuthority`, `provider`, `exitCode`, `protocolVersion=7` | byte-equal | emit identical literals |

Ref: `nondeterministic-fields.md:28-111`.

---

## 9. Porting risk callouts

### 9.1 node-pty behaviors with no direct `portable-pty` equivalent
- **`onData` delivers JS strings, not bytes** (`terminal-registry.ts:1681`, comment in
  `output-fragments.ts:27-29`). node-pty decodes PTY bytes to UTF‑16 with its own chunk boundaries.
  `portable-pty` yields raw `Vec<u8>`. **The chunking boundary and the UTF‑8↔UTF‑16 decode are part of
  the observable `data`/seq contract.** The port must (a) decode UTF‑8 to match string content, and
  (b) reproduce fragment boundaries via the same `fragmentTerminalOutputForPayloadBudget` code-point
  splitting — but *raw read-chunk boundaries from the OS PTY are timing-dependent and may not be byte-stable*.
  → **T1 fixtures must use commands whose total output is < one batch** so chunk boundaries don't affect the
  final merged frame set, OR the port must buffer-and-refragment deterministically. **Top risk #1.**
- **`ptyProc.pid`, `.resize`, `.kill`, `.onExit({exitCode,signal})`** map cleanly to `portable-pty`
  (`CommandBuilder`, `MasterPty::resize`, `Child::kill/wait`). Exit `signal` is used only for codex recovery.
- **`bufferedAmount` backpressure** (`broker.ts:1090`) is a WS-transport property, not PTY — lives in the
  transport layer, not `freshell-terminal`.

### 9.2 Platform-specific (flag for platform-glue investigation)
- Windows/WSL shell resolution, `cwd` juggling (`cd /d`, `Set-Location`, `wsl --cd`), UNC-path avoidance,
  cmd/PowerShell arg quoting (`terminal-registry.ts:997-1057,1127-1249`). **Do not** re-implement inside the
  PTY crate; expose a `SpawnSpec { file, args, cwd, env }` and let platform-glue build it. The bell-writer
  PowerShell one-liner (`218`) is a Windows notification concern, not PTY-core.
- `getSystemShell()` filesystem probing and `$SHELL` semantics (`971-989`) must match for T1 goldens on Linux.

### 9.3 The 2–3 places most likely to diverge (watch under T0/T1)
1. **Barrier-scanner + batch framing (§4.4/§4.2).** Stateful VT parsing → `segments[]`, `endOffset`
   (UTF‑16 units!), `rawFrameCount`, merge boundaries. Highest surface area for subtle divergence.
   *Mitigation:* port `output-barrier-scanner.ts` and `output-batch.ts` behavior 1:1; unit-diff against fixtures.
2. **seq/byte accounting mismatch: bytes are UTF‑8, offsets are UTF‑16.** `frame.bytes =
   byteLength(utf8)` (`replay-deque.ts:68`) but `endOffset = data.length` (UTF‑16, `output-batch.ts:194`).
   A Rust port using byte offsets everywhere will produce wrong `endOffset`/`serializedBytes`. **Top risk #2.**
3. **`serializedBytes` fixpoint + fragment budget** (`broker.ts:1486-1494`, `output-fragments.ts`). The
   self-referential JSON size and the worst-case-seq/attachRequestId reserve must match, or batch-split
   points (and thus message boundaries) drift. **Top risk #3.**

---

## Rust port acceptance checklist (behavior → oracle tier)

| # | Behavior | Assertion | Tier |
|---|---|---|---|
| A1 | `terminal.create` → `terminal.created` shape `{type,requestId,terminalId,createdAt,cwd?}` | schema-valid, required fields present | **T0** |
| A2 | PTY spawn: name `xterm-256color`, cols/rows default 120/30, `['-l']` login shell (unix) | golden boot bytes stable across 2 boots | **T1** |
| A3 | Env: strip-list + `TERM/COLORTERM/LANG=en_US.UTF-8/LC_ALL` + `FRESHELL_*` | child-emitted env-echo golden matches | **T1** |
| A4 | `terminal.attach` → `terminal.attach.ready` with correct `headSeq/replayFromSeq/replayToSeq/effectiveSinceSeq/geometryEpoch/geometryAuthority` | schema-valid + derivation §3.5 | **T0**+**T1** |
| A5 | Snapshot seeds ring only when `headSeq===0`; snapshot bytes == scrollback | replayed `data` byte-equal to captured | **T1** |
| A6 | seq assignment: start=1, +1/fragment, contiguous, monotonic | relative seq stream matches | **T1** |
| A7 | `terminal.output` (batchV1 off): one frame/msg, raw UTF‑8 `data`, `source` omitted-when-falsy | byte-equal messages | **T1** |
| A8 | `terminal.output.batch` (batchV1 on): `segments[]` `{seqStart,seqEnd,endOffset(UTF‑16),rawFrameCount,barrier?}`, no segment `data`, `serializedBytes` fixpoint, merge rule | structural byte-equal | **T0**+**T1** |
| A9 | Barrier scanner classification (control/osc52/request_mode/turn_complete/startup_probe) → merge boundaries | segment boundaries match on control-heavy fixture | **T1** |
| A10 | `terminal.output.gap` `{fromSeq,toSeq,reason}` for replay_window/replay_budget/queue_overflow | schema-valid + inclusive range | **T0** |
| A11 | `terminal.input` write path: `pty.write(data)`, no wire reply, `lastActivityAt` bump | echo/output golden | **T1** |
| A12 | `terminal.resize`: `unchanged` when equal, else `pty.resize`; geometryEpoch +1 only on change | epoch value in attach.ready | **T0** |
| A13 | `terminal.detach` → `terminal.detached`; terminal stays running | schema-valid; still attachable | **T0** |
| A14 | `terminal.kill` / pty exit → `terminal.exit` `{exitCode}` to all clients | schema-valid; exitCode correct | **T0**+**T1** |
| A15 | Idle auto-kill of detached (clients=0) terminals after `autoKillIdleMinutes` | detached idle → exit | (integration; not core T0/T1) |
| A16 | Multi-client: same seq stream, per-client gaps only, no reorder | 2-client transcript ordering | **T1** |
| A17 | Exited-terminal reap keeps ≤ `maxExitedTerminals`; attach to exited → `INVALID_TERMINAL_ID` | error shape | **T0** |
| A18 | Backpressure: background pause @512 KiB, catastrophic close @16 MiB/10 s, queue overflow @32 MiB→gap | gap emission under load | **T1** (stress) |
| A19 | Capability negotiation `hello.capabilities.terminalOutputBatchV1` gates batch vs legacy framing | correct message variant per handshake | **T0** |
| A20 | `terminal.status` NOT emitted for shell (reference has no emitter) | absence holds | **T0** (negative) |

**Do-not-implement in `freshell-terminal` (coding-CLI / out of scope):** `terminal.input.blocked`,
`terminal.turn.complete`, codex `codexInputGate`/durability/recovery, session binding, sidecars.
These belong to the coding-CLI layer; the PTY crate exposes only the shell path.
