# Terminal Catch-Up Evidence Dossier

Created in proof worktree: `/home/dan/code/freshell/.worktrees/proof-terminal-catchup-architecture`

Verdict: **implementation can proceed now**, with one explicit do-not-merge gate for real browser background/OS freeze behavior. All other implementation-shaping ambiguity is either proven in this worktree or converted into concrete architecture rules below.

## Evidence Artifacts

- `scripts/proofs/terminal-catchup-pty-metrics.ts`
- `scripts/proofs/terminal-catchup-agent-output-generator.mjs`
- `scripts/proofs/terminal-json-serialization-probe.ts`
- `scripts/proofs/xterm-write-dispose-probe.ts`
- `scripts/proofs/browser-freeze-lifecycle-probe.ts`
- `scripts/proofs/browser-background-visibility-probe.ts`
- `scripts/proofs/browser-process-suspend-probe.ts`
- `docs/superpowers/proofs/artifacts/terminal-catchup-pty-metrics.json`
- `docs/superpowers/proofs/artifacts/terminal-json-serialization.json`
- `docs/superpowers/proofs/artifacts/xterm-write-dispose.json`
- `docs/superpowers/proofs/artifacts/browser-freeze-lifecycle.json`
- `docs/superpowers/proofs/artifacts/browser-background-visibility.json`
- `docs/superpowers/proofs/artifacts/browser-process-suspend.json`

## Assumptions Ledger

| Status | Claim | Why it matters | Proof method | Evidence location | Confidence | Implementation implication |
|---|---|---|---|---|---:|---|
| PROVEN | Freshell PTY output enters the broker through `node-pty -> TerminalRegistry -> terminal.output.raw -> ReplayRing -> TerminalStreamBroker`. | Metrics must exercise the real terminal path, not stdout-only logs. | Harness spawned real PTYs through `TerminalRegistry`, attached via `TerminalStreamBroker`, captured raw events and broker sends. | `terminal-catchup-pty-metrics.ts`; `server/terminal-registry.ts:1523`; `server/terminal-stream/broker.ts:385` | 0.98 | Performance work belongs server-side in `server/terminal-stream`, with client safety around xterm application. |
| PROVEN | Real Codex CLI and stress traces have small chunks but bursty delivery; stress output reached 776,745 bytes in one burst and replay compressed 3,239 raw PTY chunks into 33 replay frames. | Sizes retention and batching; proves message-count reduction. | PTY harness scenarios: `codex-version`, `codex-help`, `codex-real-turn`, `agent-burst-12000`, `control-barrier`. | `terminal-catchup-pty-metrics.json` | 0.95 | Keep server batching; do not rely on client write coalescing as the primary fix. |
| PROVEN | A conservative stream scanner still batches heavily: 3,239 stress chunks become 170 conservative batches while respecting control barriers. | Shows safety barriers do not eliminate batching gains. | Stateful scanner in harness treats OSC/DCS/request/replacement/pending states as barriers. | `terminal-catchup-pty-metrics.json`, `agent-burst-12000.scanner` | 0.90 | Implement scanner snapshots at ingestion; batch only when scanner ground-state and no side-effect barrier. |
| PROVEN | Raw 16 KiB budget is not serialized JSON budget. ESC-only 16 KiB data serialized as 98,423 bytes; ANSI SGR 16 KiB serialized as 30,158 bytes. | Current budget can overshoot WebSocket payload/backpressure limits. | JSON serialization probe around current `terminal.output` shape. | `terminal-json-serialization.json`; `server/terminal-stream/broker.ts:593`; `server/terminal-stream/broker.ts:661` | 0.99 | Batch budgets must be serialized application payload bytes, measured before send. |
| DISPROVEN | CDP `Page.setWebLifecycleState({state:'frozen'})` is a valid local proof of frozen-tab behavior in this environment. | Would have closed browser-background ambiguity. | Headless and headed/Xvfb probes kept timers, RAF, and WS at active rates while command reported success. | `browser-freeze-lifecycle.json` | 0.99 | Do not cite CDP lifecycle freeze as acceptance evidence here. |
| DISPROVEN | Xvfb `bringToFront()` produces real background-tab `document.hidden` behavior locally. | Would have proven OS-tab background throttling. | Two-page headed/Xvfb probe showed `visibilityState:"visible"` and active-rate timers/RAF/WS for the covered page. | `browser-background-visibility.json` | 0.99 | Real OS/browser background remains a do-not-merge acceptance gate. |
| PROVEN | When browser execution is actually stopped, WS data accumulates and delivers as a catch-up burst on resume. | Proves the failure mechanics even though OS background is gated. | Suspended exact Chromium process tree with `SIGSTOP`; server sent 40 WS frames while stopped; after resume immediate page delta had 1 interval tick, 3 RAF ticks, and 40 WS messages. | `browser-process-suspend.json` | 0.95 | Retention and replay must tolerate frozen clients that receive a burst on resume. |
| GATED | Real Windows/Chrome/OS background/freeze behavior for Freshell tabs is not proven in this environment. | The original bug involved a browser tab backgrounded for hours. | Feasible local probes failed to enter real hidden/frozen browser state. | `browser-freeze-lifecycle.json`; `browser-background-visibility.json` | 0.70 | Coding can start; merge requires the acceptance gate below. |
| PROVEN | Current multi-client resize authority is partial: broker attach resizes on `viewport_hydrate` always and `transport_reconnect` only when no other socket or same socket, but standalone `terminal.resize` resizes unconditionally. | Geometry changes alter wrapping and invalidate byte replay. | Source inspection. | `server/terminal-stream/broker.ts:109`; `server/ws-handler.ts:3203`; `server/terminal-registry.ts:3160` | 0.98 | Warm replay is allowed only under compatible geometry authority/history; unknown multi-client geometry quarantines/rebuilds. |
| PLAN-FIXED | Geometry authority must be explicit: `single_client`, `server_stream`, or `multi_client_unknown`. | Without this, a client can replay bytes into a surface wrapped at a different size. | Current source lacks geometry epochs/history and only stores current `cols/rows`. | `server/terminal-registry.ts:3164`; `src/lib/terminal-attach-policy.ts:31` | 0.93 | Add geometry epoch/history to server stream metadata and checkpoint validation. |
| PROVEN | Current hello capabilities only include `uiScreenshotV1`; server stores only that flag. | Batch protocol must not break old clients. | Source inspection and runtime `HelloSchema.safeParse` with added `terminalOutputBatchV1`: accepted and stripped. | `shared/ws-protocol.ts:225`; `src/lib/ws-client.ts:333`; `server/ws-handler.ts:2131`; command output from `tsx -e HelloSchema.safeParse(...)` | 0.99 | Additive capability rollout is safe if new clients still accept legacy `terminal.output`. |
| PROVEN | Server-to-client messages are TypeScript-only; no runtime server-message schema exists. | Tests must not pretend a `ServerMessageSchema` already validates batches. | Source comment and union inspection. | `shared/ws-protocol.ts:1`; `shared/ws-protocol.ts:981` | 0.99 | Either add explicit server-message schema intentionally or test sender output directly. |
| PLAN-FIXED | Warm replay validity needs terminal id, stream id, server identity, attach generation, geometry authority/history, scrollback, xterm version, parser-applied checkpoint, local surface epoch, retention coverage, and seq continuity. | A `seq` alone does not prove equivalent terminal surface state. | Current state has terminalId/renderedSeq/serverInstanceId/bootId/attachRequestId, but no streamId/surfaceEpoch/geometryEpoch/parserApplied/retention coverage. | `src/components/TerminalView.tsx:535`; `shared/ws-protocol.ts:626`; `src/components/TerminalView.tsx:1666` | 0.95 | Implement checkpoint validation; if any key is absent/incompatible, quarantine or full rebuild. |
| PROVEN | xterm writes are asynchronous in this install and callbacks survive `dispose()`. | Stale callbacks can mutate a new surface unless fenced. | Installed `@xterm/xterm@6.0.0` probe: small write callbacks after write returns; large callback fired 310 ms after dispose; 500 queued callbacks all fired after dispose, FIFO. | `xterm-write-dispose.json`; `package.json:92` | 0.99 | Every xterm callback and parser side effect must check surface epoch + attach generation before mutating state. |
| PROVEN | Broker send and handler send are not equivalent. | Terminal stream sends need same backpressure, payload, and instrumentation behavior as other WS sends. | Source inspection: handler send logs large payloads and callback timing; broker `safeSend` only `JSON.stringify` + `ws.send`. | `server/ws-handler.ts:1492`; `server/ws-handler.ts:1511`; `server/terminal-stream/broker.ts:661` | 0.99 | Introduce shared sender and route broker/direct terminal sends through it. |
| PROVEN | Legacy direct registry output path is still reachable for any `registry.attach` call without `suppressOutput`. Browser attach uses suppressOutput via broker, but direct path emits unsequenced `terminal.output`. | Rollout must not leave a path that bypasses seq/batch/stream safety. | Source inspection. | Browser path: `server/ws-handler.ts:3027`; suppress: `server/terminal-stream/broker.ts:103`; direct path: `server/terminal-registry.ts:3045`; unsequenced send: `server/terminal-registry.ts:3463` | 0.98 | During rollout, migrate or fence direct path; legacy fallback must emit modern segmented frames with seq metadata. |
| PROVEN | Current client rejects untagged/overlapping output during active attach and ignores missing sequence ranges. | Old direct frames can be dropped, and new batching must preserve seq continuity. | Source inspection. | `src/components/TerminalView.tsx:1666`; `src/components/TerminalView.tsx:2119`; `src/components/TerminalView.tsx:2128` | 0.98 | Do not emit old-shape `terminal.output` from any browser-visible path. |
| PROVEN | Replay-sensitive side effects exist before xterm write and inside xterm callbacks/handlers: startup replies, OSC52, turn completion, link handling, title updates, local `writeln` notices, perf marks, checkpoint persistence. | Replay must not re-send PTY replies, clipboard writes, Redux updates, or mutate the local surface invisibly. | Source inspection. | `src/components/TerminalView.tsx:1078`; `src/components/TerminalView.tsx:1035`; `src/components/TerminalView.tsx:1096`; `src/components/terminal/request-mode-bypass.ts:237`; `src/components/TerminalView.tsx:1268`; `src/components/TerminalView.tsx:1597`; local writes at `src/components/TerminalView.tsx:1985`, `2243`, `2518`, `2550`, `2646` | 0.98 | Add deny-by-default side-effect adapter; local terminal writes invalidate warm replay unless moved out-of-band. |
| PROVEN | Current client write queue coalesces replay writes but has no attach/surface generation metadata. | Delayed callbacks can advance stale checkpoints or complete stale attach generations. | Source inspection. | `src/components/terminal/terminal-write-queue.ts:22`; `src/components/terminal/terminal-write-queue.ts:54`; `src/components/terminal/terminal-write-queue.ts:85` | 0.98 | Write queue must own generation-tagged queued/submitted writes and callback fences. |
| PROVEN | Current replay ring uses array `shift()` eviction and coalesces by raw bytes, not scanner/serialized budgets. | Many tiny frames can make eviction O(n); raw budget is unsafe for JSON. | Source inspection. | `server/terminal-stream/replay-ring.ts:57`; `server/terminal-stream/replay-ring.ts:81`; `server/terminal-stream/replay-ring.ts:143` | 0.98 | Replace with indexed deque/ring; store scanner state snapshots and serialized byte accounting. |
| PROVEN | Current coding CLI replay retention floor is 8 MiB; this covers 8 hours only at about 291 B/s. | The bug is hours-long hidden catch-up; 8 MiB is not enough for sustained multi-KiB/s output. | Source default and measured rate math. | `server/terminal-stream/broker.ts:19`; `terminal-catchup-pty-metrics.json` | 0.95 | Add explicit memory/disk retention budgets and coverage gates; missing coverage invalidates warm replay. |

No row is `BLOCKED`. The only remaining uncertainty is intentionally `GATED`.

## Decisive Proofs

### PTY Metrics

The PTY harness exercises the real Freshell terminal path. It spawns a shell PTY through `TerminalRegistry`, attaches through `TerminalStreamBroker`, sends commands via `registry.input`, captures `terminal.output.raw`, and captures the broker's serialized WebSocket messages.

Key results from `terminal-catchup-pty-metrics.json`:

- `codex-real-turn`: 2,000 raw bytes, 15 raw chunks, 120 B/s over the measured turn; preview contains `proof-line-1` through `proof-line-40`.
- `codex-help`: 4,686 raw bytes, 7 raw chunks, 7,025 B/s during the help burst.
- `agent-burst-12000`: 776,745 raw bytes, 3,239 raw chunks, 622,392 B/s during the local burst; broker replay emitted 33 output frames.
- `control-barrier`: scanner found 7 barrier frames, 6 side-effect barriers, 1 replacement frame, and 2 pending-state frames.

The stress scenario is intentionally a burst upper bound, not a claim that real agents sustain 622 KiB/s for hours.

### Browser Lifecycle

Local browser lifecycle proof is split into three artifacts:

- `browser-freeze-lifecycle.json`: CDP `Page.setWebLifecycleState({state:'frozen'})` did not freeze page work. During the supposed frozen period, page counters advanced 40 intervals, 120 RAFs, and 40 WS messages, exactly matching the server's 40 sends.
- `browser-background-visibility.json`: Xvfb `bringToFront()` did not make the prior tab hidden. `document.hidden` stayed false and all counters ran at active rates.
- `browser-process-suspend.json`: stopping the full Chromium process tree did stop page work. The server sent 40 WS frames while stopped. Immediately after resume, page counters advanced by 1 interval and 3 RAFs but received all 40 queued WS messages.

Conclusion: local probes prove the catch-up mechanics but do not prove real OS tab background behavior. Merge must be gated on the acceptance test below.

### Retention Sizing

Measured rates converted to retained bytes:

| Rate source | Rate | 4h retained | 8h retained |
|---|---:|---:|---:|
| Actual small Codex turn | 120 B/s | 1.65 MiB | 3.30 MiB |
| Current 8 MiB coding CLI floor coverage | 291 B/s for 8h | 8 MiB covers 4h at 582 B/s | 8 MiB covers 8h at 291 B/s |
| `codex-help` burst if sustained | 7,025 B/s | 96.5 MiB | 193 MiB |
| 32 MiB memory cap coverage | 1,165 B/s for 8h | 32 MiB covers 4h at 2,330 B/s | 32 MiB covers 8h at 1,165 B/s |
| 256 MiB disk cap coverage | 9,320 B/s for 8h | 256 MiB covers 4h at 18,641 B/s | 256 MiB covers 8h at 9,320 B/s |
| 1 GiB disk cap coverage | 37,283 B/s for 8h | 1 GiB covers 4h at 74,565 B/s | 1 GiB covers 8h at 37,283 B/s |
| Local stress burst if sustained | 622,392 B/s | 8.35 GiB | 16.70 GiB |

Retention rule:

- Keep a hot memory replay ring with a default coding-agent cap of 32 MiB per terminal.
- Add an optional disk replay spool defaulting to 256 MiB per coding-agent terminal, with a 1 GiB configurable hard cap.
- Warm replay is valid only when retention covers every byte since `parserAppliedSeq + 1`.
- If coverage is missing, emit a gap and quarantine/rebuild. Do not silently continue warm replay.

### Geometry Authority

Current source proves that resize authority is not fully tracked:

- Attach path resizes on `viewport_hydrate`, and on `transport_reconnect` only when no other attached socket exists or the same socket is reconnecting: `server/terminal-stream/broker.ts:109`.
- Any `terminal.resize` message calls `registry.resize` unconditionally: `server/ws-handler.ts:3203`.
- `TerminalRegistry.resize` stores only current `cols`/`rows` and calls `pty.resize`: `server/terminal-registry.ts:3160`.

Architecture rule:

- Warm replay is allowed only under `geometryAuthority='single_client'` or `geometryAuthority='server_stream'` with compatible history from checkpoint to head.
- If any other client can resize without compatible server-side geometry history, set `geometryAuthority='multi_client_unknown'` and quarantine/rebuild instead of warm replay.

### Rollout Matrix

Use an additive capability, not a protocol bump, for `terminalOutputBatchV1`.

| Client | Server | Proven behavior / required behavior |
|---|---|---|
| old | old | Existing legacy `terminal.output` path works. |
| new | old | Proven compatible: current `HelloSchema` accepts and strips unknown `terminalOutputBatchV1`; old server sends legacy output; new client must support legacy. |
| old | new | New server sees no batch capability and must send only legacy segmented `terminal.output` with seq metadata. Do-not-merge if batch is sent without capability. |
| new | new | New server may send `terminal.output.batch` only when capability is present; unsafe/barrier segments may still use legacy `terminal.output`. |

### Warm Replay Validity Keys

| Key | Current state | Required rule |
|---|---|---|
| Terminal id | Present in output and pane content. | Must match checkpoint. |
| Stream identity | No terminal output stream id; unrelated opencode tracker stream ids exist and are not terminal byte-stream ids. | Server mints `streamId`; changes on PTY/session replacement, Codex recovery PTY replacement, incompatible retention loss, and incompatible restart. |
| Server identity | `ready` includes `serverInstanceId` and `bootId`. | Checkpoint must include both; boot/server mismatch invalid unless persisted replay retention proves compatibility. |
| Attach generation | Current `attachRequestId` tags stream messages. | Every queued/submitted write and callback must also carry attach generation. |
| Geometry authority/history | Current `cols/rows`; no history/epoch. | Include `geometryEpoch`, authority, and resize history/snapshots needed for replay. |
| Scrollback | xterm and server settings have scrollback, but checkpoints do not include it. | Include scrollback in checkpoint; change invalidates warm replay. |
| xterm version | Package range is `^6.0.0`; installed is 6.0.0. | Pin exact xterm or run CI probe for resolved version; include version in checkpoint. |
| Parser-applied checkpoint | Current `renderedSeq` is advanced from write callback naming, but stored as terminal cursor only. | Rename to `parserAppliedSeq`; advance only from fenced xterm write callback. |
| Local mutation epoch | Local `term.writeln` paths exist. | Out-of-band React notices preferred; remaining local writes bump `surfaceEpoch` and invalidate warm delta replay. |
| Retention coverage | Current ring can evict and reports gaps. | Warm replay requires retained coverage from checkpoint to target; missing coverage quarantines/rebuilds. |
| Seq continuity | Client rejects overlap and missing seq. | Batch/legacy fallback must preserve unique contiguous seq ranges; gaps never advance parser-applied state. |

### xterm Fence Requirement

The installed package behavior is decisive:

- Small write callbacks run after `term.write` returns.
- A large write callback fired after `term.dispose()`.
- 500 queued write callbacks all fired after dispose and remained FIFO.

Required fence:

- Every write callback receives `{ terminalInstanceId, surfaceEpoch, attachRequestId, seqEnd, source }`.
- Callback mutates checkpoint/attach state only if all identity fields still match active state.
- Parser callbacks and side effects must use the same active write scope. Stack-scoped context around `term.write()` is not enough.

### Shared Sender

Required shared sender behavior:

- Check `readyState`.
- Check and close on configured backpressure threshold.
- Serialize exactly once.
- Measure serialized payload bytes.
- Enforce payload budget before `ws.send`.
- Use send callback for large-payload timing and error logging.
- Return boolean delivery acceptance to callers.
- Emit structured JSONL events with severity and stable event names.

Broker and registry direct output must use this sender.

### Side-Effect Adapter

Deny-by-default effect contract:

```ts
type TerminalSideEffectContext = {
  terminalId: string
  streamId: string
  terminalInstanceId: string
  surfaceEpoch: number
  attachRequestId: string
  source: 'live' | 'replay'
  parserAppliedSeq?: number
  segmentSeqStart?: number
  segmentSeqEnd?: number
}

type TerminalSideEffect =
  | { type: 'pty.reply.startup_probe'; data: string }
  | { type: 'pty.reply.request_mode'; data: string }
  | { type: 'clipboard.osc52.write'; text: string }
  | { type: 'clipboard.osc52.prompt'; event: unknown }
  | { type: 'redux.turn_complete.record' }
  | { type: 'redux.title.update'; title: string }
  | { type: 'pane.link.open'; uri: string }
  | { type: 'terminal.local_notice.write'; text: string }
  | { type: 'checkpoint.persist'; seq: number }
  | { type: 'attach.complete'; seq: number }
  | { type: 'perf.mark'; name: string }
```

Default policy:

- Replay denies PTY replies, clipboard writes/prompts, title changes, link opens, client-minted turn completion, and local terminal writes.
- Live allows declared effects only if the context matches the active surface.
- Unknown effect type is a test failure and runtime suppression.

## Implementation Plan

### PR 1: Sender, Metrics, And Protocol-Neutral Safety

Expected files touched:

- `server/ws-handler.ts`
- `server/terminal-stream/broker.ts`
- `server/terminal-registry.ts`
- `server/terminal-stream/constants.ts`
- `server/perf-logger.ts`
- New `server/ws-sender.ts`

Work:

- Extract shared WebSocket sender.
- Route broker sends and registry terminal sends through it.
- Add serialized byte measurements and structured JSONL logs:
  - `terminal_catchup.replay_hit`
  - `terminal_catchup.replay_miss`
  - `terminal_catchup.batch_sent`
  - `terminal_catchup.gap`
  - `terminal_catchup.sender_backpressure`
- Keep protocol output as legacy `terminal.output`.

Tests:

- Unit shared sender: readyState, backpressure, payload byte warning, send callback errors.
- Regression: broker and handler send same serialized payload and same close behavior.

### PR 2: Server Stream Identity, Scanner, And Retention Coverage

Expected files touched:

- `server/terminal-stream/replay-ring.ts`
- New `server/terminal-stream/control-sequence-scanner.ts`
- New `server/terminal-stream/retention-store.ts`
- `server/terminal-stream/types.ts`
- `server/terminal-stream/broker.ts`
- `server/terminal-registry.ts`

Work:

- Add terminal byte-stream `streamId`.
- Replace array/`shift()` ring with indexed deque.
- Store scanner state snapshots at ingestion.
- Split frames on code-point boundaries before seq assignment when needed.
- Add serialized-byte budgeting.
- Add memory retention cap and optional disk spool cap.
- Emit explicit coverage result for every attach.

Tests:

- Scanner state across split ESC/CSI/OSC/DCS/APC/BEL/C1/replacement.
- No lone surrogate chunks.
- Batch never crosses source/stream/attach/geometry/barrier/budget.
- Retention miss emits gap and never advances parser-applied seq.
- Ring eviction avoids O(n) shift behavior.

### PR 3: Client Checkpoint, Write Queue Fencing, And Side Effects

Expected files touched:

- `src/components/TerminalView.tsx`
- `src/components/terminal/terminal-write-queue.ts`
- `src/components/terminal/request-mode-bypass.ts`
- New `src/lib/terminal-surface-checkpoint.ts`
- New `src/lib/terminal-side-effects.ts`
- `src/lib/terminal-attach-policy.ts`
- Cursor persistence helper currently used by `TerminalView`

Work:

- Replace bare rendered cursor with `TerminalSurfaceCheckpoint`.
- Rename semantics to `parserAppliedSeq`.
- Add `surfaceEpoch`, `terminalInstanceId`, `xtermVersion`, `scrollback`, geometry, stream/server ids.
- Submit at most one xterm write per surface unless later tests prove parallel scoped parser callbacks.
- Fence callbacks after dispose/stale attach.
- Move local terminal notices out-of-band where possible; otherwise bump surface mutation epoch.
- Add deny-by-default side-effect adapter.

Tests:

- xterm dispose callback regression from artifact.
- Stale callback cannot mark attach complete or persist cursor.
- Replay suppresses OSC52, request-mode replies, title changes, turn completion, link opens.
- Local notice invalidates warm replay.

### PR 4: Geometry Authority And Warm Replay Policy

Expected files touched:

- `server/terminal-stream/broker.ts`
- `server/terminal-registry.ts`
- `shared/ws-protocol.ts`
- `src/lib/terminal-attach-policy.ts`
- `src/components/TerminalView.tsx`

Work:

- Add `geometryEpoch`, authority, and resize history.
- Make warm replay validator require compatible geometry.
- Quarantine/rebuild on multi-client unknown authority.
- Ensure `terminal.resize` updates server geometry epoch and invalidates affected checkpoints.

Tests:

- Single client warm delta allowed.
- Same socket reconnect allowed if geometry unchanged.
- Other client resize marks unknown/incompatible.
- Replay after incompatible geometry refuses warm delta and uses rebuild/quarantine.

### PR 5: Batch Capability And Legacy Fallback

Expected files touched:

- `shared/ws-protocol.ts`
- `src/lib/ws-client.ts`
- `server/ws-handler.ts`
- `server/terminal-stream/broker.ts`
- `src/components/TerminalView.tsx`

Work:

- Add `terminalOutputBatchV1` hello capability.
- Add `terminal.output.batch` type and tests.
- Server sends batch only for capable client.
- Legacy fallback emits individual modern `terminal.output` segments with seq metadata; never old-shape unsequenced output.

Tests:

- Old client/new server receives no batch.
- New client/old server works with legacy output.
- New/new receives batch for safe segments.
- Unsafe/barrier batch falls back or splits without changing semantics.

### PR 6: Browser Acceptance And Tuning

Expected files touched:

- `test/e2e-browser/...`
- `scripts/visible-first-audit.ts`
- `scripts/assert-visible-first-audit-gate.ts`
- `docs/index.html` only if user-facing behavior changes are visible.

Work:

- Add visible-first metrics:
  - replay message count
  - serialized replay bytes
  - parser-applied lag
  - gap count/ranges
  - warm replay accepted/rejected reason
  - stale callback rejection count
  - side-effect suppression count
- Add real browser background acceptance gate.

Exact do-not-merge browser gate:

1. Start an isolated Freshell server from the feature worktree on a unique port; do not touch the self-hosted dev server.
2. Open real Windows Chrome, not headless/Xvfb.
3. Create a terminal running the deterministic generator and at least one real Codex turn.
4. Confirm `document.visibilityState === 'hidden'` or an OS freeze/suspend event while the tab is backgrounded/minimized.
5. Keep it backgrounded for a 4h soak at a calibrated 1 KiB/s stream and one shorter burst at >=750 KiB total.
6. Refocus and assert:
   - no unsafe warm replay after retention loss;
   - no unsequenced `terminal.output`;
   - no parser-unsafe gap continues on same parser;
   - no replay-triggered OSC52/request-mode/title/turn side effect;
   - catch-up to server head completes under configured UX budget for covered retention;
   - all metrics above are present in JSONL logs.
7. Repeat one 8h overnight soak before merge if disk retention is part of the PR.

## Invariants

- Sequence ranges are unique, contiguous within a stream, and never overlap.
- Split oversized output before seq assignment, on Unicode code-point boundaries.
- `parserAppliedSeq` advances only from active fenced xterm write callback.
- Gap receipt never advances `parserAppliedSeq`.
- Warm replay requires every validity key to match.
- Batch never crosses stream, attach, source, geometry, parser barrier, gap, or serialized budget boundary.
- Legacy fallback emits the same safe segments as batch mode.
- Side effects are denied by default.
- Local terminal writes invalidate warm replay unless rendered out-of-band.
- Shared sender is the only terminal WebSocket send path.

## Kill Switches And Rollback

- `TERMINAL_CATCHUP_ENABLED=false`: disable warm delta replay and use viewport hydrate/quarantine path.
- `TERMINAL_OUTPUT_BATCH_V1=false`: force legacy segmented `terminal.output`.
- `TERMINAL_REPLAY_DISK_SPOOL=false`: memory-only retention.
- `TERMINAL_REPLAY_MAX_MEMORY_BYTES`: hard memory cap.
- `TERMINAL_REPLAY_MAX_DISK_BYTES`: hard disk cap.
- `TERMINAL_REPLAY_WARM_GEOMETRY=false`: quarantine on any resize history mismatch.
- Runtime setting/logged config snapshot must include every switch value.

Rollback path:

- Disable batch capability first.
- Disable warm replay second.
- Keep shared sender and logging; they are safety improvements and should remain unless they are the failure source.

## Do-Not-Merge Criteria

- Any batch is sent to a client that did not advertise `terminalOutputBatchV1`.
- Any terminal output path can emit old-shape unsequenced `terminal.output` to browser clients.
- Any xterm callback can mutate state without surface + attach-generation fence.
- Any gap advances `parserAppliedSeq`.
- Any batch crosses a scanner barrier, source boundary, stream id, attach id, geometry epoch, or serialized byte budget.
- Any local `term.write`/`term.writeln` does not either render out-of-band or invalidate warm replay.
- Any replay side effect is allowed by default.
- xterm remains a loose semver range without CI behavior probes for the resolved version.
- Browser background acceptance gate is missing or fails.
- Structured JSONL observability is missing severity, terminal id, stream id, attach id, seq range, and rejection reason.
