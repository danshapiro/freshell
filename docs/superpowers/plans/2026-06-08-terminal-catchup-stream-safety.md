# Terminal Catch-Up Stream Safety Implementation Plan

> **For agentic workers:** Execute this plan in one implementation worktree and one final PR. Local commits and internal task checkpoints are fine, but do not publish a PR until every task and final local proof gate passes. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make long-hidden terminal catch-up fast, loss-explicit, and safe across server replay batching, xterm parser semantics, attach races, side-effect parsing, and WebSocket backpressure.

**Proof status:** Implementation can proceed from this plan. The evidence dossier is committed at `docs/superpowers/proofs/2026-06-08-terminal-catchup-evidence-dossier.md`. It resolves the prior open architecture questions with reproducible probes and source inspection. The browser catch-up acceptance gate for the single implementation PR is the local production-style visible-first audit plus a local browser process-suspend stop/resume positive control on an isolated test server. A real Windows Chrome long-background soak remains useful release/user-acceptance evidence, but it is not a prerequisite for opening the single PR.

**Architecture:** Keep server-side replay batching as the primary performance fix, but turn it into a protocol-aware stream system. The server owns replay retention, batching, serialized byte budgets, gaps, and backpressure; the client owns xterm surface identity, attach generation safety, parser-applied acknowledgements, and side-effect gating. Paint is a UX signal only, not a replay safety boundary.

**Tech Stack:** TypeScript, Node.js ESM, React 18, xterm 6.0.0 behavior probes with exact dependency pinning or CI-probed dependency policy, ws WebSockets, Zod client-to-server protocol schemas, TypeScript server-to-client message unions, Vitest, Testing Library, Playwright visible-first audit tooling, structured JSONL logs.

---

## Findings That Led To This Plan

### The Original Symptom

A long-running Codex terminal tab stayed hidden for hours. When the tab became visible again, Freshell replayed/caught up very slowly, at roughly a few times realtime. The user-visible problem was terminal catch-up latency after a long-hidden tab.

### The Incomplete Former Fixes

PR #396, `fix-terminal-catchup`, attacked the problem on the client:

- It classified replay frames in `src/components/TerminalView.tsx`.
- It added replay mode and replay write coalescing in `src/components/terminal/terminal-write-queue.ts`.
- It originally used a larger 32 ms replay drain budget.

That was incomplete and partly misdirected:

- It coalesced after every WebSocket message, JSON parse, message dispatch, sequence-state update, and side-effect parser pass had already happened.
- Its tests used mocked xterm writes with synchronous callbacks, so they did not model xterm parse/render work.
- The 32 ms replay budget was not supported by later measurement. After server batching, it did not materially improve the 1,200-line audit-scale case and worsened RAF gaps on larger stress.
- It did not generation-tag queued writes or callbacks, so delayed writes from old attach generations could still mutate current terminal state.

PR #397, `fix-replay-server-batching`, moved the primary optimization to the server:

- It coalesced contiguous replay frames in `server/terminal-stream/replay-ring.ts`.
- It reduced replay WebSocket message count dramatically. A probe showed 1,200 replay lines dropped from 1,200 `terminal.output` messages to 2, and 12,000 lines dropped from 12,000 to 14.

That direction is correct, but the implementation is not complete:

- Batching budgets are based on raw UTF-8 `data` bytes, not serialized JSON/WebSocket payload bytes. A 16 KiB raw escape-heavy payload can serialize to about 98 KiB.
- Server replay batching currently concatenates strings and stores frames in arrays that evict with `shift()`, which is unsafe for many tiny retained frames.
- Foreground replay can still create avoidable buffered backpressure before normal pacing checks.
- Batching can change parser side effects unless replay/live context and parser-sensitive boundaries are explicit.

### Load-Bearing Validation Results

These facts are now established and must shape the architecture:

- xterm `Terminal.write(data, cb)` callback is a parser/buffer acknowledgement, not a paint/render acknowledgement. It fires before DOM paint.
- xterm write callbacks are FIFO in the probes, but callback order does not make them a visual render boundary.
- Concatenating contiguous terminal chunks preserves final xterm terminal state for tested terminal sequences, including split SGR, CSI, OSC title, alternate screen, and split UTF-8 input.
- Parser side effects are not universally chunk-boundary invariant. Turn-complete tracking has chunk-local semantics; startup probes, OSC52, and request-mode paths need explicit handling.
- Hidden in-app tabs keep mounted xterm DOM under Freshell's `visibility:hidden` layout, and rAF drains while the page remains active. Full browser-background throttling remains an unverified risk.
- A single sequence number is not enough to prove terminal-visible state across resize/wrapping, alternate-screen state, scrollback, geometry, or paint.
- Existing attach message guards do not protect queued client writes/callbacks. Stale queued writes from old attach generations can still write into the current xterm surface or advance cursors.
- The right performance lever is server message-count reduction, not restoring PR #396's replay drain budget.
- The current client rejects overlapping sequence ranges, so an oversized payload must not be split into multiple `terminal.output` messages with the same `seqStart`/`seqEnd`. Split oversized PTY output before sequence assignment, then give every fragment its own sequence range.
- JavaScript string slicing can split UTF-16 surrogate pairs. Any server splitter must split on Unicode code point boundaries and must test that no emitted chunk contains lone surrogates.
- A `terminal.output.gap` is not an xterm parser acknowledgement. Gap handling must not advance `parserAppliedSeq`; it must track lost ranges separately and invalidate or recreate the surface unless the gap is explicitly parser-safe.
- The persisted cursor is currently keyed only by `terminalId`. Persisted replay checkpoints must include stream/server identity, otherwise a restarted server or replaced stream can make stale local cursors look valid.
- Some parser side effects bypass `handleTerminalOutput`: request-mode replies are emitted from an xterm parser hook, OSC52 `always` can write to the clipboard directly, and title-change callbacks mutate Redux state. Side-effect suppression needs terminal-instance write scope that survives xterm's asynchronous parsing, not only a helper called before enqueueing output.
- Current server-to-client protocol is a TypeScript union, not a runtime Zod schema. Batch protocol work must either add an explicit server-message schema intentionally or test behavior/types directly; it cannot rely on a non-existent `ServerMessageSchema`.
- Current hello capabilities only advertise `uiScreenshotV1`. Batch output requires `terminalOutputBatchV1` negotiation inside protocol v6, plus a non-batch `terminal.output` fallback for v6 clients that omit the capability.
- Serialized byte budgets are exact for the application JSON payload passed to `ws.send`. They are not exact compressed on-wire byte counts. `ws.bufferedAmount` is useful server-side transport pressure, not a browser parser or paint acknowledgement.

### Second Load-Bearing Pass Results

The revised plan was load-bearing checked again. These additional facts change the implementation plan:

- xterm 6 processes writes asynchronously. Wrapping only the synchronous `term.write(data, cb)` call does not expose replay/live context to parser callbacks; CSI, OSC/title, DCS, and write callbacks can run after `term.write` returns and after a stack-scoped context is cleared.
- Already-submitted xterm writes cannot be made safe by callback filtering alone. Same-surface clear/replay hydrate must wait for the write queue to drain, or the client must replace the xterm surface and fence every callback by terminal-instance and attach-generation tokens.
- Fresh xterm plus replay from `sinceSeq=0` is not a universal full hydrate. It matched under the same geometry in probes, but differed under different current geometry and under a resize-history mismatch. Byte replay is a safe hydrate only when geometry history is compatible or replay includes the relevant resize/snapshot history.
- Unsafe gaps can leave xterm's parser desynchronized. Probes with missing OSC, DCS, and CSI boundaries showed later text being swallowed or interpreted incorrectly. A gap marker plus continued output on the same parser is not safe for parser-unsafe gaps.
- A stateless barrier classifier is not enough. Barrier classification must be stream-stateful across raw chunks and fragments, including pending ESC, CSI, OSC, DCS, APC, C1, BEL, startup-probe, request-mode, and turn-complete states.
- Current `node-pty` string mode loses invalid UTF-8 bytes and 8-bit C1 controls. This plan must either explicitly keep the terminal stream contract as UTF-8 string output with replacement semantics, or add a byte-preserving PTY/output protocol. The implementation path below keeps UTF-8 string output for this catch-up fix and treats replacement/control uncertainty as a conservative barrier; a byte-preserving terminal protocol is a separate architecture project.
- Fragmentation can safely happen after raw-output observers if it remains inside `server/terminal-stream`; current Codex/Claude trackers observe `terminal.output.raw` before the broker path.
- Current server attach staging and live-queue ownership are race-free under the existing synchronous broker attach critical section. The implementation must not add `await` points between attach id/mode reset, replay snapshot selection, staging drain, and `mode = 'live'`.
- `ws.bufferedAmount` is confirmed useful for server-side transport/sender pressure in installed `ws` 8.19.0, with the caveat that bytes accepted into the OS socket buffer can be invisible.
- Batch capability plumbing is feasible through hello/client state/broker attachment state, but batch frames must not mix replay/live source or parser-side-effect barriers. Non-batch fallback must emit safe `terminal.output` segments, not flatten arbitrary batches.
- Existing visible-first audit metrics do not yet capture replay message count, serialized replay bytes, parser-applied lag, gaps, full-hydrate fallback, or stale-generation rejection. Observability work must create those metrics before the browser audit can be acceptance evidence.
- xterm probes validate the installed 6.0.0 package, not the whole `^6.0.0` dependency range. Pin xterm exactly or add CI probes that run against every allowed resolved version.

### Third Load-Bearing Pass Results

Fresh Eyes and a third load-bearing pass found these additional constraints:

- xterm `dispose()` does not cancel pending `write` callbacks in installed `@xterm/xterm@6.0.0`. Runtime probes showed post-dispose write callbacks after both small and large writes; surface replacement is safe only when every write callback and async parser continuation checks terminal-instance and attach-generation fences before mutating state.
- Serial callback-chained xterm writes are acceptable on the tested desktop Chromium surface. A 50,000-write, 3.25 MB benchmark completed in 267 ms with fast first render and low callback latency, so one submitted write per terminal surface remains viable for live output on that class of machine. Replay should still coalesce; a single giant write hurt first-render latency.
- Side-effect gating by a named allow list was incomplete. Write callbacks that persist/advance checkpoints or complete attaches, link/action callbacks, local terminal notices, parser callbacks, clipboard writes, title updates, startup replies, request-mode replies, and turn-complete mutations all belong under a deny-by-default side-effect adapter.
- Local `term.writeln` notices are real today and are not currently tied to surface invalidation. The plan now requires out-of-band React notices where possible, or explicit surface invalidation before any future warm delta replay.
- `streamId` cannot be a loose optional field. It must be a server-owned output-stream identity that changes on new PTY/session stream, Codex PTY recovery replacement under the same `terminalId`, incompatible retention loss, and server restart without compatible persisted retention.
- Checkpoint compatibility needs geometry authority/history, scrollback, and xterm version in addition to terminal/server/stream/surface identity. Multi-client resize with unknown authority must reject warm delta replay unless the server provides compatible geometry history.
- Replay windows cannot reconstruct stream-stateful barrier scanner state from arbitrary prefixes. Retained frames must store barrier classification and scanner state snapshots at ingestion time.
- Broker output is centralized for current browser attach paths, but broker direct `ws.send(JSON.stringify(...))` lacks the handler send callback, large-payload instrumentation, and shared payload limits. Terminal broker sends must use a shared WebSocket sender.
- Batch protocol and capability negotiation do not exist today, and pre-v6 `terminal.output` lacks source/stream/segment metadata. Non-batch fallback is safe only as individual modern `terminal.output` frames with `seqStart`, `seqEnd`, `streamId`, `attachRequestId`, and segment `data`; it must not use the old registry direct-output shape.
- Full Chrome background/freeze behavior remains hard to reproduce deterministically in this environment. CDP `Page.setWebLifecycleState({ state: 'frozen' })` and Xvfb tab-background probes were tried and disproven as valid local proof because timers, RAF, and WebSocket delivery continued while the probes claimed to be frozen/backgrounded. A process-suspend probe proved the failure mechanic: WebSocket frames accumulate while browser execution is stopped and deliver as a burst after resume. The PR gate therefore uses that stop/resume positive control plus visible-first audit metrics; a real Windows Chrome soak remains post-PR acceptance evidence.

### Proof Dossier Results

The proof worktree produced durable evidence artifacts that are now committed with this plan:

- `docs/superpowers/proofs/2026-06-08-terminal-catchup-evidence-dossier.md`
- `docs/superpowers/proofs/artifacts/terminal-catchup-pty-metrics.json`
- `docs/superpowers/proofs/artifacts/terminal-json-serialization.json`
- `docs/superpowers/proofs/artifacts/xterm-write-dispose.json`
- `docs/superpowers/proofs/artifacts/browser-freeze-lifecycle.json`
- `docs/superpowers/proofs/artifacts/browser-background-visibility.json`
- `docs/superpowers/proofs/artifacts/browser-process-suspend.json`
- `scripts/proofs/terminal-catchup-pty-metrics.ts`
- `scripts/proofs/terminal-json-serialization-probe.ts`
- `scripts/proofs/xterm-write-dispose-probe.ts`
- `scripts/proofs/browser-freeze-lifecycle-probe.ts`
- `scripts/proofs/browser-background-visibility-probe.ts`
- `scripts/proofs/browser-process-suspend-probe.ts`

Decisive proof results:

- The PTY metrics harness exercised the real Freshell path: `TerminalRegistry` spawning a PTY, `TerminalStreamBroker` attaching, raw `terminal.output.raw` capture, and serialized broker sends. It did not rely on stdout-only logs.
- The `agent-burst-12000` stress trace produced 776,745 bytes in 3,239 raw PTY chunks. Current broker replay compressed that to 33 replay frames, and the conservative scanner would emit 170 batches while respecting control barriers.
- A real Codex turn produced 2,000 bytes in 15 raw chunks. `codex-help` produced 4,686 bytes in 7 raw chunks.
- Serialized JSON budgeting is mandatory. A raw 16 KiB ESC-heavy terminal output serialized to 98,423 bytes; a raw 16 KiB ANSI SGR payload serialized to 30,158 bytes.
- Installed `@xterm/xterm@6.0.0` has asynchronous writes and write callbacks can fire after `dispose()`. Callback fencing by terminal instance, surface epoch, attach generation, and write scope is mandatory.
- Local CDP freeze and Xvfb background probes are invalid acceptance proof here. The process-suspend probe proved the catch-up burst mechanic by stopping the Chromium process tree, sending 40 WebSocket frames, and observing all 40 arrive immediately after resume.
- Current 8 MiB coding-agent replay retention covers 8 hours only at about 291 B/s. A 32 MiB hot memory cap covers 8 hours at about 1,165 B/s; a 256 MiB disk cap covers 8 hours at about 9,320 B/s; a 1 GiB hard cap covers 8 hours at about 37,283 B/s.
- Multi-client geometry, rollout compatibility, sender parity, legacy direct registry output, warm replay validity, and replay side effects are resolved into concrete implementation rules in this plan and the dossier.

## Design Summary

### New Safety Vocabulary

Replace the bare rendered high-water cursor with a parser-applied checkpoint plus separate replay/loss cursors:

```ts
type TerminalSurfaceCheckpoint = {
  terminalId: string
  streamId: string | null
  serverInstanceId: string
  serverBootId?: string
  surfaceEpoch: number
  attachRequestId: string
  parserAppliedSeq: number
  cols: number
  rows: number
  geometryEpoch: number
  geometryAuthority: 'single_client' | 'server_stream' | 'multi_client_unknown'
  scrollback: number
  xtermVersion: string
  bufferType: 'normal' | 'alternate' | 'unknown'
  parserIdle: boolean
}

type TerminalReplayCursor = {
  parserAppliedSeq: number
  highestObservedSeq: number
  replayRequestSeq: number
  knownLostRanges: Array<{ fromSeq: number; toSeq: number }>
}
```

Rules:

- `parserAppliedSeq` advances only from the active attach generation's xterm write callback.
- It means xterm has parsed/applied the bytes to its model. It does not mean paint happened.
- `knownLostRanges` and `highestObservedSeq` never make a surface safe. They are loss accounting and replay bookkeeping only.
- `replayRequestSeq` is derived from safe parser-applied state. It must not jump over a gap that xterm did not parse.
- UI may wait one visible `requestAnimationFrame` before clearing "recovering" state, but protocol safety must not depend on paint.
- A warm delta replay is valid only when terminal id, stream id, server identity, surface epoch, geometry, geometry authority, scrollback, xterm version, parser state, and attach generation remain compatible.
- Retained replay from `sinceSeq=0` is a replay hydrate, not a universal full hydrate. It is trusted only when replay covers a compatible geometry history. Otherwise the old surface is quarantined or replaced; the client must not continue live I/O on a parser whose state was rebuilt from an untrusted hydrate.
- Explicit refresh, terminal replacement, unsafe geometry change, scrollback-setting change, parser-unsafe gap, stale persisted checkpoint, and stale in-flight writes use drain-then-hydrate, fresh-surface, quarantined-loss, or future snapshot paths. They must not advance a safe replay cursor.
- Local client notices such as gaps, reconnecting, launch errors, blocked input, and status banners should be rendered out-of-band in React UI rather than written into xterm. Any remaining local `term.write`/`term.writeln` path must bump `surfaceEpoch`, mark the surface local-mutated, and make the checkpoint ineligible for warm delta replay.

### Server Batching Rules

Batching belongs in `server/terminal-stream`, not the client write queue.

A batch may coalesce frames only when all of these are true:

- Same terminal id and stream id.
- Same attach request id.
- Same source context, either `live` or `replay`.
- Contiguous sequence ranges.
- No parser side-effect barrier between frames.
- Serialized application JSON payload bytes stay under the configured budget.
- The stream-stateful barrier scanner is in ground state before and after the coalesced span.

The server must not silently coalesce across these barriers:

- Gaps.
- Attach control.
- Terminal exit.
- Resize or geometry epoch changes.
- OSC52-sensitive spans.
- Request-mode query/reply paths.
- Startup probe phases.
- Client-authoritative turn-complete paths.
- ESC, OSC, DCS, APC, C1, BEL, and other control spans until classified safely.
- Incomplete/pending control spans from prior raw chunks or fragments.

The terminal stream contract for this plan remains UTF-8 string output. Invalid UTF-8 and raw 8-bit C1 bytes are not preserved by the current `node-pty` string-mode path, so the server must conservatively treat replacement characters and uncertain control bytes as barriers. A byte-preserving PTY protocol must be designed separately before claiming byte-stream-perfect terminal replay.

### Protocol Direction

The single implementation branch makes protocol v6 the compatibility boundary because safe post-attach terminal traffic requires server-owned `streamId` on output, batch, gap, attach-ready, and stream-change messages. Protocol v5 peers must be rejected during `hello` rather than accepted into a stream that would silently drop untagged output. Within protocol v6, explicit batches remain gated by `terminalOutputBatchV1`; v6 clients that omit that capability receive segmented `terminal.output` frames with sequence and stream metadata.

```ts
type TerminalOutputBatch = {
  type: 'terminal.output.batch'
  terminalId: string
  streamId: string
  attachRequestId: string
  source: 'live' | 'replay'
  seqStart: number
  seqEnd: number
  data: string
  serializedBytes: number
  segments: Array<{
    seqStart: number
    seqEnd: number
    endOffset: number
    data?: string
    rawFrameCount: number
    barrier?: 'control' | 'startup_probe' | 'osc52' | 'request_mode' | 'turn_complete' | 'gap' | 'geometry'
  }>
}
```

For this plan, `streamId` is server-owned output-stream identity. It is minted when a terminal output stream is created, remains stable across attach/detach/replay for that stream, and changes when the server replaces the stream identity, loses retention across restart, or intentionally starts a new PTY/session stream. Protocol v6 makes `streamId` mandatory on terminal stream messages; any missing or mismatched stream identity after attach is fail-closed by the client.

`segments[].endOffset` is a UTF-16 code-unit offset into the batch `data` string, matching JavaScript `String.prototype.slice` semantics. It must always fall on a code-point boundary; the batch builder must test emoji/surrogate-pair segment boundaries. If that contract becomes too fragile during implementation, replace offsets with required per-segment `data` and drop top-level slicing rather than leaving offset units implicit.

Protocol v6 clients that do not advertise `terminalOutputBatchV1` continue to receive compatible `terminal.output` messages, but the fallback must serialize safe batch segments as individual frames. It must not flatten an arbitrary multi-segment batch into one `terminal.output` if that batch crosses replay/live source, parser-barrier, stream-id, attach-id, or budget boundaries. Server-to-client runtime validation is not currently present; if this work adds it, create the schema explicitly and test it as a new behavior.

The client processes segments in order and runs side-effect parsers with explicit context:

```ts
type TerminalOutputSideEffectContext = {
  source: 'live' | 'replay'
  attachRequestId: string
  segment: {
    seqStart: number
    seqEnd: number
    barrier?: string
  }
}
```

Replay context suppresses external side effects such as clipboard prompts, request-mode replies, title updates, and client-minted turn-complete notifications. Because xterm write parsing is asynchronous, context must be terminal-instance scoped and remain associated with the submitted write until its xterm write callback fires. The write queue must allow at most one submitted xterm write per terminal surface unless it can prove parser callbacks are unambiguous for all in-flight writes. Parser callbacks and local terminal notices use a deny-by-default side-effect adapter: any new xterm parser callback, browser side effect, Redux mutation, PTY reply, clipboard action, or local xterm write must declare an effect type and be explicitly allowed for the active terminal-instance write scope.

## Evidence-Backed Single-Branch Execution Order

Execute the detailed tasks below in one implementation worktree and publish one PR only after the full local proof gate passes. The phases below are local continuation gates, not PR boundaries. Local commits after each task are still useful for review and recovery, but they all remain on the same implementation branch.

Before opening the final PR:

- All task-level red-green-refactor gates must pass locally.
- The focused client, server, parser side-effect, e2e, visible-first, and full coordinated checks in Final Verification must pass locally.
- The implementation must be proven against an isolated local test server on a unique port. Do not stop or restart the self-hosted dev server.
- The local browser proof gate must pass on an isolated local test server: production-style visible-first audit plus process-suspend stop/resume positive-control evidence. A real Windows Chrome long-background soak is recommended release/user-acceptance evidence, not a blocker for opening this PR.

### Phase 1: Sender, Metrics, And Protocol-Neutral Safety

Purpose: remove unsafe terminal send paths before adding richer replay behavior.

Use these work packages:

- Add `server/ws-send.ts` from the server file-structure section.
- Apply the shared sender portions of Task 8 and Task 10.
- Route broker and registry direct terminal sends through the shared sender.
- Keep output protocol as segmented `terminal.output` until Phase 5.

Local gate before continuing:

- Broker, registry direct terminal output, and `ws-handler` use the same serialization, ready-state, payload-measurement, backpressure, send-callback, and structured logging behavior.
- No browser-visible terminal path can emit unsequenced old-shape `terminal.output` without passing through the shared sender.
- Structured logs include severity, terminal id, stream id when known, attach id when known, seq range when applicable, serialized bytes, buffered amount, and rejection reason.

### Phase 2: Server Stream Identity, Scanner, And Retention Coverage

Purpose: make server replay safe and measurable before the client trusts warm replay.

Use these work packages:

- Task 5: serialized payload budgeting and pre-sequence fragmentation.
- Task 6: stream-stateful barrier-aware batching.
- Task 7: replay deque and retained scanner metadata.
- Add stream identity and retention coverage reporting from the server file-structure section.

Local gate before continuing:

- `streamId` is server-minted, stable across attach/detach, and changes on new PTY/session stream, Codex recovery PTY replacement, incompatible retention loss, and restart without compatible persisted retention.
- Oversized output is fragmented before sequence assignment and never splits Unicode surrogate pairs.
- Batch candidates never cross stream, attach, source, geometry, gap, scanner barrier, or serialized payload budget boundaries.
- Retention reports exact coverage for every attach; missing coverage emits a gap/quarantine reason and never advances parser-applied state.
- Memory and optional disk retention defaults reflect the dossier sizing: 32 MiB hot memory for coding-agent terminals, optional 256 MiB disk spool default, and 1 GiB configurable hard cap.

### Phase 3: Client Checkpoint, Write Queue Fencing, And Side Effects

Purpose: make the client safe to consume server replay without stale callbacks or replay side effects corrupting state.

Use these work packages:

- Task 1: client write generation safety fence.
- Task 2: parser-applied surface checkpoint.
- Task 3: TerminalView parser-applied cursor and attach generations.
- Task 4: async xterm write scope and side-effect suppression.

Local gate before continuing:

- Every queued/submitted xterm write and callback is fenced by terminal instance, surface epoch, attach generation, and write scope.
- `parserAppliedSeq` advances only from the active fenced xterm write callback.
- Gap receipt never advances `parserAppliedSeq`.
- Replay suppresses PTY replies, request-mode replies, OSC52 writes/prompts, title updates, client-minted turn completion, link opens, and local terminal writes by default.
- Any remaining local xterm write bumps `surfaceEpoch` and invalidates warm delta replay.

### Phase 4: Geometry Authority And Warm Replay Policy

Purpose: make warm replay opt-in based on known-compatible terminal geometry and surface identity.

Use these work packages:

- Geometry parts of Task 2 and Task 3.
- Server geometry epoch/history work from the server file-structure section.
- Attach policy updates from the client file-structure section.

Local gate before continuing:

- Warm replay is accepted only when terminal id, stream id, server identity, attach generation, surface epoch, geometry, geometry authority/history, scrollback, xterm version, parser-applied checkpoint, retention coverage, and sequence continuity are compatible.
- `geometryAuthority='multi_client_unknown'` quarantines or rebuilds instead of warm-replaying.
- `terminal.resize` updates geometry epoch/history and invalidates incompatible checkpoints.

### Phase 5: Batch Capability And Non-Batch Fallback

Purpose: add explicit batch protocol after both sides are safe and backwards compatible.

Use these work packages:

- Task 9: batch protocol.
- Server batch builder pieces from Task 6 that were not needed by segmented `terminal.output`.
- Client batch segment parsing in `TerminalView` and `terminal-attach-seq-state`.

Local gate before continuing:

- `terminal.output.batch` is sent only to clients advertising `terminalOutputBatchV1`.
- Batch-capable protocol v6 clients still accept segmented `terminal.output`.
- Protocol v5 clients are rejected at `hello`; protocol v6 clients without batch capability receive only segmented `terminal.output` with seq and stream metadata, never `terminal.output.batch`.
- Non-batch fallback emits the same safe segments as batch mode and never flattens across barriers or budgets.

### Phase 6: Browser Acceptance And Local Proof

Purpose: prove the implemented system handles the user-visible catch-up scenario and preserves the safety invariants under a browser that actually stops or throttles page execution.

Use these work packages:

- Task 10 observability that is not already complete.
- Task 11 browser-level verification.
- Final verification.

Local pre-PR gate:

- Visible-first audit records replay message count, serialized replay bytes, parser-applied lag, gap count/ranges, warm replay accepted/rejected reason, stale callback rejection count, side-effect suppression count, retention coverage, and browser lifecycle state.
- Local process-suspend or equivalent positive-control testing proves catch-up burst handling when browser execution is stopped.
- The local process-suspend stop/resume positive-control gate passes on an isolated local test server. CDP freeze or Xvfb tab switching cannot substitute for this gate in this environment unless their counters prove browser execution actually stopped or throttled.
- Only after these gates pass should the branch be pushed and a single implementation PR opened.

## File Structure

### Client

- Modify `src/components/terminal/terminal-write-queue.ts`
  - Own queued and submitted write generation metadata.
  - Own terminal-instance metadata for submitted xterm writes.
  - Submit at most one xterm write per terminal surface at a time unless a later implementation proves parallel submitted writes are context-safe.
  - Drop stale queued writes.
  - Suppress stale callbacks.
  - Report in-flight submitted writes that cannot be canceled.

- Create `src/lib/terminal-surface-checkpoint.ts`
  - Define `TerminalSurfaceCheckpoint`.
  - Validate whether an existing xterm surface can be used for delta replay.
  - Name semantics as parser-applied, not rendered.
  - Include stream/server identity, geometry authority, scrollback, and xterm version so persisted checkpoints cannot survive incompatible server restarts, stream replacements, resize history, scrollback changes, or xterm upgrades.

- Modify `src/lib/terminal-attach-policy.ts`
  - Take a checkpoint instead of a bare rendered sequence.
  - Return replay hydrate with an untrusted resulting surface, fresh-surface replacement, or future snapshot recovery when geometry, stream id, surface epoch, or parser state is unsafe.

- Modify `src/lib/terminal-attach-seq-state.ts`
  - Continue to handle sequence ranges, but do not imply sequence range equals full surface validity.
  - Keep parser-applied cursor advancement separate from gaps and known lost ranges.
  - Accept batch segment ranges in the batch protocol task on this branch.

- Modify `src/lib/terminal-cursor.ts`
  - Persist parser-applied checkpoints with stream/server identity.
  - Reject checkpoint reads when stream or server identity is missing or incompatible.

- Modify `src/components/TerminalView.tsx`
  - Rename rendered high-water state to parser-applied high-water.
  - Track `surfaceEpoch`, `streamId`, geometry, geometry authority, scrollback, xterm version, and attach generation.
  - Pass generation metadata into write queue.
  - Drain submitted writes before same-surface clear/replay hydrate, or replace the xterm surface and fence callbacks by terminal-instance token.
  - Associate replay/live write context with the submitted xterm write until its callback fires, not only while `term.write` is on the JavaScript stack.
  - Move local gap/status/error notices to an out-of-band React overlay where possible; any remaining local xterm write invalidates the surface for warm delta replay.

- Create `src/lib/terminal-output-side-effects.ts`
  - Centralize terminal-output side-effect decisions.
  - Deny by default for replay or unknown write scope.
  - Require every xterm parser callback, xterm write callback that advances checkpoint/attach state, clipboard write, PTY reply, title update, turn-complete mutation, startup reply, link/action callback, and local xterm notice write to declare an effect type before it can run.

- Modify `src/components/terminal/request-mode-bypass.ts`
  - Consult terminal-instance write scope before sending request-mode replies.

- Modify `src/lib/terminal-osc52.ts`
  - Suppress both prompted and `always` clipboard writes during replay.

- Test `test/unit/client/components/terminal/terminal-write-queue.test.ts`
  - Generation tagging, stale queued write dropping, stale callback suppression, in-flight tracking.

- Test `test/unit/client/lib/terminal-surface-checkpoint.test.ts`
  - Checkpoint compatibility and invalidation on geometry, stream, attach, and surface epoch changes.
  - Persisted checkpoint invalidation on server identity changes.

- Test `test/unit/client/lib/terminal-attach-policy.test.ts`
  - Warm delta only when checkpoint is compatible.

- Test `test/unit/client/lib/terminal-attach-seq-state.test.ts`
  - Same-seq duplicates remain rejected.
  - Gaps do not advance `parserAppliedSeq`.

- Test `test/unit/client/components/TerminalView.lifecycle.test.tsx`
  - Delayed xterm write callback from an old attach cannot advance current parser-applied cursor or complete current attach.
  - Unsafe stale in-flight write forces drain-or-surface-replace behavior.
  - Same-surface hydrate waits for xterm write drain; non-draining stale writes replace the xterm surface and bump `surfaceEpoch`.
  - Parser-unsafe output gaps quarantine or replace the surface instead of continuing to write later output into a desynchronized parser.
  - Replay request-mode replies, OSC52 writes, title updates, stale write-callback checkpoint updates, and attach-completion mutations are suppressed.
  - Link/action callbacks are token-fenced to the current terminal surface or explicitly declared outside replay gating.

### Server

- Create `server/terminal-stream/output-barrier-scanner.ts`
  - Track stream-stateful parser barrier state across raw chunks and fragments.
  - Conservative first version treats ESC, BEL, C1, OSC, CSI, DCS, APC, replacement characters, startup-probe spans, request-mode spans, and most control spans as barriers.
  - Expose whether the scanner is in ground state so batches only coalesce spans that start and end safely.

- Create `server/terminal-stream/stream-identity.ts`
  - Mint and store server-owned `streamId` values for terminal output streams.
  - Change `streamId` on new PTY/session stream, Codex PTY recovery replacement, incompatible retention loss, and server restart without compatible persisted retention.
  - Keep `streamId` stable across attach/detach for the same output stream.

- Create `server/terminal-stream/serialized-budget.ts`
  - Compute exact serialized application JSON payload byte size using the same payload shape passed to `ws.send`.
  - Provide code point-safe helper functions for finding the largest data segment that fits within a payload budget.

- Create `server/terminal-stream/output-fragments.ts`
  - Fragment oversized raw PTY output before sequence assignment.
  - Guarantee emitted chunks do not split surrogate pairs.
  - Preserve raw observer ordering by running inside `server/terminal-stream`, after `terminal.output.raw` subscribers have seen the original string event.
  - Document that this task does not change the current UTF-8 string terminal contract; byte-preserving PTY output is a separate project.

- Create `server/terminal-stream/replay-deque.ts`
  - Replace many-frame replay retention with a deque or indexed ring that does not evict with `Array.shift()`.
  - Retain byte and frame counts.
  - Retain per-frame barrier metadata and scanner state before/after the frame so arbitrary `sinceSeq` replay windows do not reconstruct stream-stateful parser state from the wrong prefix.
  - Support efficient bounded replay reads.

- Modify `server/terminal-stream/replay-ring.ts`
  - Either wrap `ReplayDeque` for compatibility or migrate callers to the new deque.
  - Assign distinct sequence ranges after fragmentation.
  - Keep gap semantics.
  - Attach stream identity and barrier metadata to retained frames.

- Create `server/terminal-stream/output-batch.ts`
  - Build batches from replay or live frames.
  - Preserve segment metadata.
  - Enforce serialized payload budget.
  - Stop at barriers.
  - Treat `segments[].endOffset` as a UTF-16 code-unit offset and prove offsets land on code-point boundaries, or switch to required per-segment `data`.

- Create `server/ws-send.ts`
  - Own JSON serialization, serialized application byte measurement, `ws.send`, `bufferedAmount` reads, send callback accounting, structured send/backpressure logs, and closed-socket handling.
  - Export a shared sender used by both `server/ws-handler.ts` and `server/terminal-stream/broker.ts`.

- Modify `server/terminal-stream/client-output-queue.ts`
  - Use the same batch builder for live queued output.
  - Avoid divergent replay/live batching semantics.

- Modify `server/terminal-stream/broker.ts`
  - Use batch builder for replay cursor flushes.
  - Pace foreground sends before creating avoidable buffered backpressure.
  - Keep background pause and catastrophic protection.
  - Preserve the synchronous attach critical section; do not add `await` between attach reset, replay snapshot, staging drain, and `mode = 'live'`.
  - Use the shared WebSocket sender instead of calling `ws.send` directly.
  - Emit structured JSONL logs for replay, batching, gaps, and pressure.

- Modify `shared/ws-protocol.ts`
  - Add required terminal stream identity metadata for protocol v6 terminal stream messages.
  - Define `streamId` lifecycle explicitly: server-minted per terminal output stream, stable across attach/detach for that stream, changed on stream replacement, restart without compatible retention, or new PTY stream.
  - Add `terminalOutputBatchV1` capability negotiation before emitting `terminal.output.batch`.
  - Add `terminal.output.batch` typing and client/server support in this branch.

- Test `test/unit/server/terminal-stream/output-barrier-scanner.test.ts`
  - Transparent text can batch.
  - ESC/BEL/OSC/DCS/CSI/APC/control spans stop batches.
  - Split `ESC [`, OSC, DCS, APC, and startup-probe spans remain barriers until the terminating state is observed.
  - Replacement characters from lossy PTY decoding are barriers.
  - Scanner state snapshots before and after a frame can be stored with replay retention and later used without mutating the live scanner.

- Test `test/unit/server/terminal-stream/serialized-budget.test.ts`
  - Escape-heavy data stays within serialized byte budget.
  - Oversized raw output is fragmented before sequence assignment.
  - Fragments never contain lone surrogates.

- Test `test/unit/server/terminal-stream/replay-deque.test.ts`
  - Eviction is O(1)-style and does not degrade with many tiny frames.
  - Replay during eviction emits gaps correctly.

- Test `test/unit/server/terminal-stream/output-batch.test.ts`
  - Batch builder preserves contiguous seq ranges, segment metadata, attach id, source, and budget.
  - Batch builder never emits multiple same-seq chunks for one frame.
  - Batch builder never combines frames unless the scanner starts and ends in ground state.
  - Batch segment `endOffset` values are UTF-16 code-unit offsets and never point into the middle of a surrogate pair.

- Update `test/unit/server/ws-handler-backpressure.test.ts`
  - Foreground replay pauses/yields before avoidable buffered growth.
  - Background replay still pauses at the background threshold.

- Update `test/server/ws-terminal-stream-v2-replay.test.ts`
  - Replay batches preserve correctness while respecting barriers and budget.

### Observability

- Modify `server/terminal-stream/broker.ts`
  - Log structured JSONL events with severity fields for:
    - `terminal.replay.gap`
    - `terminal.replay.batch`
    - `terminal.replay.backpressure_pause`
    - `terminal.replay.retention`
    - `terminal.replay.cursor_lag`

- Modify `src/components/TerminalView.tsx`
  - Log or emit perf marks for:
    - parser-applied lag
    - stale generation rejection
    - surface replacement fallback after stale in-flight writes

## Task 1: Client Write Generation Safety Fence

**Files:**
- Modify: `src/components/terminal/terminal-write-queue.ts`
- Modify: `test/unit/client/components/terminal/terminal-write-queue.test.ts`

- [ ] **Step 1: Add failing tests for generation invalidation**

Add these tests to `test/unit/client/components/terminal/terminal-write-queue.test.ts`:

```ts
it('drops queued writes from stale generations before they reach xterm', () => {
  const writes: string[] = []
  const callbacks: string[] = []
  const rafCallbacks: FrameRequestCallback[] = []

  const queue = createTerminalWriteQueue({
    write: (chunk, onWritten) => {
      writes.push(chunk)
      onWritten?.()
    },
    requestFrame: (cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    },
    cancelFrame: () => {},
  })

  queue.setActiveGeneration('attach-1')
  queue.enqueue('old', () => callbacks.push('old'), { generation: 'attach-1' })
  queue.setActiveGeneration('attach-2', { dropQueuedStaleWrites: true })
  queue.enqueue('new', () => callbacks.push('new'), { generation: 'attach-2' })

  rafCallbacks.shift()?.(16)

  expect(writes).toEqual(['new'])
  expect(callbacks).toEqual(['new'])
})

it('suppresses stale write callbacks after generation changes', () => {
  const callbacks: string[] = []
  const pendingCallbacks: Array<() => void> = []
  const rafCallbacks: FrameRequestCallback[] = []

  const queue = createTerminalWriteQueue({
    write: (_chunk, onWritten) => {
      if (onWritten) pendingCallbacks.push(onWritten)
    },
    requestFrame: (cb) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    },
    cancelFrame: () => {},
  })

  queue.setActiveGeneration('attach-1')
  queue.enqueue('old', () => callbacks.push('old'), { generation: 'attach-1' })
  rafCallbacks.shift()?.(16)

  expect(queue.hasInFlightWrites()).toBe(true)
  queue.setActiveGeneration('attach-2', { dropQueuedStaleWrites: true })
  pendingCallbacks.shift()?.()

  expect(callbacks).toEqual([])
  expect(queue.hasInFlightWrites()).toBe(false)
})
```

- [ ] **Step 2: Run the failing queue tests**

Run:

```bash
timeout 120s npm run test:vitest -- --run test/unit/client/components/terminal/terminal-write-queue.test.ts
```

Expected before implementation: TypeScript or test failures because `setActiveGeneration`, `generation`, and `hasInFlightWrites` do not exist.

- [ ] **Step 3: Implement generation-aware queue API**

Update `src/components/terminal/terminal-write-queue.ts` with these API additions:

```ts
export type TerminalWriteQueue = {
  enqueue: (data: string, onWritten?: () => void, options?: TerminalWriteQueueOptions) => void
  enqueueTask: (task: () => void, options?: TerminalWriteQueueOptions) => void
  setActiveGeneration: (
    generation: string,
    options?: { dropQueuedStaleWrites?: boolean },
  ) => void
  hasInFlightWrites: (generation?: string) => boolean
  clear: () => void
}

export type TerminalWriteQueueOptions = {
  mode?: TerminalWriteQueueMode
  generation?: string
}
```

Implementation rules:

- Store `generation` on every queue item.
- Keep `activeGeneration`.
- On `setActiveGeneration(next, { dropQueuedStaleWrites: true })`, remove queued items whose `generation !== next`.
- Before invoking a queued item, drop it if it has a stale generation.
- Increment an in-flight counter before calling `args.write`.
- Wrap `onWritten` so stale callbacks decrement in-flight but do not call user callbacks.
- `clear()` must clear queued work and reset in-flight accounting only for not-yet-submitted work. It cannot cancel callbacks already handed to xterm.

- [ ] **Step 4: Run queue tests to verify pass**

Run:

```bash
timeout 120s npm run test:vitest -- --run test/unit/client/components/terminal/terminal-write-queue.test.ts
```

Expected: all queue tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/components/terminal/terminal-write-queue.ts test/unit/client/components/terminal/terminal-write-queue.test.ts
git commit -m "Add generation safety to terminal write queue"
```

## Task 2: Parser-Applied Surface Checkpoint

**Files:**
- Create: `src/lib/terminal-surface-checkpoint.ts`
- Create: `test/unit/client/lib/terminal-surface-checkpoint.test.ts`
- Modify: `src/lib/terminal-cursor.ts`
- Modify: `test/unit/client/lib/terminal-cursor.test.ts`
- Modify: `src/lib/terminal-attach-seq-state.ts`
- Modify: `test/unit/client/lib/terminal-attach-seq-state.test.ts`
- Modify: `src/lib/terminal-attach-policy.ts`
- Modify: `test/unit/client/lib/terminal-attach-policy.test.ts`

- [ ] **Step 1: Write failing checkpoint tests**

Create `test/unit/client/lib/terminal-surface-checkpoint.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  createTerminalSurfaceCheckpoint,
  canUseCheckpointForDeltaReplay,
} from '@/lib/terminal-surface-checkpoint'

describe('terminal surface checkpoint', () => {
  it('accepts a compatible parser-applied checkpoint', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: true, sinceSeq: 42 })
  })

  it('rejects a checkpoint after geometry changes', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 100,
      rows: 40,
      geometryEpoch: 4,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'geometry_changed' })
  })

  it('rejects a checkpoint while parser work is still in flight', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: false,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'parser_busy' })
  })

  it('rejects a checkpoint from a different server instance', () => {
    const checkpoint = createTerminalSurfaceCheckpoint({
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-a',
      surfaceEpoch: 2,
      attachRequestId: 'attach-2',
      parserAppliedSeq: 42,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      bufferType: 'normal',
      parserIdle: true,
    })

    expect(canUseCheckpointForDeltaReplay(checkpoint, {
      terminalId: 'term-1',
      streamId: 'stream-1',
      serverInstanceId: 'server-b',
      surfaceEpoch: 2,
      cols: 120,
      rows: 40,
      geometryEpoch: 3,
      geometryAuthority: 'single_client',
      scrollback: 5000,
      xtermVersion: '6.0.0',
      requireParserIdle: true,
    })).toMatchObject({ ok: false, reason: 'server_changed' })
  })
})
```

- [ ] **Step 2: Run failing checkpoint tests**

Run:

```bash
timeout 120s npm run test:vitest -- --run test/unit/client/lib/terminal-surface-checkpoint.test.ts
```

Expected: fail because `src/lib/terminal-surface-checkpoint.ts` does not exist.

- [ ] **Step 3: Implement checkpoint helper**

Create `src/lib/terminal-surface-checkpoint.ts`:

```ts
export type TerminalBufferType = 'normal' | 'alternate' | 'unknown'
export type TerminalGeometryAuthority = 'single_client' | 'server_stream' | 'multi_client_unknown'

export type TerminalSurfaceCheckpoint = {
  terminalId: string
  streamId: string | null
  serverInstanceId: string
  serverBootId?: string
  surfaceEpoch: number
  attachRequestId: string
  parserAppliedSeq: number
  cols: number
  rows: number
  geometryEpoch: number
  geometryAuthority: TerminalGeometryAuthority
  scrollback: number
  xtermVersion: string
  bufferType: TerminalBufferType
  parserIdle: boolean
}

export type CheckpointDeltaReplayInput = {
  terminalId: string
  streamId: string | null
  serverInstanceId: string
  serverBootId?: string
  surfaceEpoch: number
  cols: number
  rows: number
  geometryEpoch: number
  geometryAuthority: TerminalGeometryAuthority
  scrollback: number
  xtermVersion: string
  requireParserIdle: boolean
}

export type CheckpointDeltaReplayDecision =
  | { ok: true; sinceSeq: number }
  | {
      ok: false
      reason:
        | 'missing_checkpoint'
        | 'terminal_changed'
        | 'stream_changed'
        | 'server_changed'
        | 'surface_changed'
        | 'geometry_changed'
        | 'geometry_authority_unknown'
        | 'scrollback_changed'
        | 'xterm_version_changed'
        | 'parser_busy'
        | 'no_applied_sequence'
    }

function normalizePositiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export function createTerminalSurfaceCheckpoint(
  input: TerminalSurfaceCheckpoint,
): TerminalSurfaceCheckpoint {
  return {
    ...input,
    surfaceEpoch: normalizePositiveInteger(input.surfaceEpoch),
    parserAppliedSeq: normalizePositiveInteger(input.parserAppliedSeq),
    cols: normalizePositiveInteger(input.cols),
    rows: normalizePositiveInteger(input.rows),
    geometryEpoch: normalizePositiveInteger(input.geometryEpoch),
    scrollback: normalizePositiveInteger(input.scrollback),
  }
}

export function canUseCheckpointForDeltaReplay(
  checkpoint: TerminalSurfaceCheckpoint | null | undefined,
  input: CheckpointDeltaReplayInput,
): CheckpointDeltaReplayDecision {
  if (!checkpoint) return { ok: false, reason: 'missing_checkpoint' }
  if (checkpoint.terminalId !== input.terminalId) return { ok: false, reason: 'terminal_changed' }
  if (checkpoint.streamId !== input.streamId) return { ok: false, reason: 'stream_changed' }
  if (checkpoint.serverInstanceId !== input.serverInstanceId) return { ok: false, reason: 'server_changed' }
  if (checkpoint.serverBootId && input.serverBootId && checkpoint.serverBootId !== input.serverBootId) {
    return { ok: false, reason: 'server_changed' }
  }
  if (checkpoint.surfaceEpoch !== input.surfaceEpoch) return { ok: false, reason: 'surface_changed' }
  if (
    checkpoint.cols !== input.cols
    || checkpoint.rows !== input.rows
    || checkpoint.geometryEpoch !== input.geometryEpoch
  ) {
    return { ok: false, reason: 'geometry_changed' }
  }
  if (
    checkpoint.geometryAuthority !== input.geometryAuthority
    || checkpoint.geometryAuthority === 'multi_client_unknown'
  ) {
    return { ok: false, reason: 'geometry_authority_unknown' }
  }
  if (checkpoint.scrollback !== input.scrollback) return { ok: false, reason: 'scrollback_changed' }
  if (checkpoint.xtermVersion !== input.xtermVersion) return { ok: false, reason: 'xterm_version_changed' }
  if (input.requireParserIdle && !checkpoint.parserIdle) return { ok: false, reason: 'parser_busy' }
  if (checkpoint.parserAppliedSeq <= 0) return { ok: false, reason: 'no_applied_sequence' }
  return { ok: true, sinceSeq: checkpoint.parserAppliedSeq }
}
```

- [ ] **Step 4: Add persisted cursor and gap-separation tests**

Modify `test/unit/client/lib/terminal-cursor.test.ts` and `test/unit/client/lib/terminal-attach-seq-state.test.ts` so they pin the load-bearing findings:

```ts
it('does not load a persisted checkpoint for a different server instance', () => {
  saveTerminalSurfaceCheckpoint({
    terminalId: 'term-1',
    streamId: 'stream-1',
    serverInstanceId: 'server-a',
    surfaceEpoch: 1,
    attachRequestId: 'attach-1',
    parserAppliedSeq: 25,
    cols: 80,
    rows: 24,
    geometryEpoch: 1,
    geometryAuthority: 'single_client',
    scrollback: 5000,
    xtermVersion: '6.0.0',
    bufferType: 'normal',
    parserIdle: true,
  })

  expect(loadTerminalSurfaceCheckpoint('term-1', {
    streamId: 'stream-1',
    serverInstanceId: 'server-b',
  })).toBeNull()
})

it('records gaps without advancing the parser-applied sequence', () => {
  const state = createTerminalAttachSeqState()
  const afterFrame = onOutputFrame(state, { seqStart: 1, seqEnd: 1 })
  const afterGap = onOutputGap(afterFrame.state, { fromSeq: 2, toSeq: 10 })

  expect(afterFrame.state.highestObservedSeq).toBe(1)
  expect(afterFrame.state.parserAppliedSeq).toBe(0)
  expect(afterGap.state.highestObservedSeq).toBe(10)
  expect(afterGap.state.parserAppliedSeq).toBe(0)
  expect(afterGap.state.knownLostRanges).toEqual([{ fromSeq: 2, toSeq: 10 }])
  expect(afterGap.surfaceSafeForDeltaReplay).toBe(false)
  expect(afterGap.requiresSurfaceQuarantine).toBe(true)
})
```

The exact helper names can follow local conventions, but the behavior is load-bearing: observed server order can advance on output and gaps, `parserAppliedSeq` advances only from a fenced xterm write acknowledgement, gaps do not advance parser-applied state, and persisted checkpoints require compatible stream/server identity.

- [ ] **Step 5: Implement cursor identity and gap separation**

Update `src/lib/terminal-cursor.ts` to store/load full `TerminalSurfaceCheckpoint` records instead of a terminal-id-only `{ seq, updatedAt }` cursor. Use a migration path that treats old records as incompatible unless the caller explicitly chooses a full hydrate fallback.

Update `src/lib/terminal-attach-seq-state.ts` so:

- `parserAppliedSeq` advances only after output is accepted and later acknowledged by xterm.
- `highestObservedSeq` or equivalent server-order bookkeeping can advance on output/gap.
- `knownLostRanges` records gaps.
- `onOutputGap` does not make `parserAppliedSeq` equal `toSeq`.
- Attach policy can see that an unsafe gap requires quarantine, xterm surface replacement, future snapshot recovery, or explicit loss UI. It must not continue writing later output into a parser that may be stuck inside an OSC/DCS/CSI/control sequence.
- Geometry changes and scrollback setting changes invalidate the checkpoint unless the replay stream includes compatible geometry history.

- [ ] **Step 6: Update attach policy tests**

Modify `test/unit/client/lib/terminal-attach-policy.test.ts` so warm reveal uses a checkpoint, not a bare rendered sequence. Add this test:

```ts
it('falls back to viewport hydrate when the parser-applied checkpoint is unsafe', () => {
  expect(resolveRevealAttachPlan({
    pendingIntent: 'viewport_hydrate',
    pendingReason: 'hidden_reveal',
    checkpointDecision: { ok: false, reason: 'geometry_changed' },
  })).toMatchObject({
    intent: 'viewport_hydrate',
    clearViewportFirst: true,
    priority: 'foreground',
  })
})
```

Add this geometry-history test:

```ts
it('does not treat replay from zero as trusted full hydrate without compatible geometry history', () => {
  expect(resolveRevealAttachPlan({
    pendingIntent: 'viewport_hydrate',
    pendingReason: 'hidden_reveal',
    checkpointDecision: { ok: false, reason: 'geometry_changed' },
    replayHydrateCoversCompatibleGeometryHistory: false,
  })).toMatchObject({
    intent: 'viewport_hydrate',
    clearViewportFirst: true,
    priority: 'foreground',
    trustResultingSurfaceForDeltaReplay: false,
  })
})
```

- [ ] **Step 7: Modify attach policy**

Update `src/lib/terminal-attach-policy.ts` so `RevealAttachPolicyInput` uses:

```ts
import type { CheckpointDeltaReplayDecision } from './terminal-surface-checkpoint'

export type RevealAttachPolicyInput = {
  pendingIntent: TerminalAttachIntent
  pendingReason: DeferredAttachReason
  checkpointDecision: CheckpointDeltaReplayDecision
  replayHydrateCoversCompatibleGeometryHistory?: boolean
}
```

Add `trustResultingSurfaceForDeltaReplay?: boolean` to the `RevealAttachPlan` return type. Leave it absent for ordinary plans where the resulting surface remains governed by existing compatibility checks, and set it explicitly to `false` when replay hydrate is chosen after an unsafe checkpoint without compatible geometry history.

Use `checkpointDecision.ok ? checkpointDecision.sinceSeq : undefined` when choosing delta replay. Replay hydrate from zero remains the default for explicit refresh or unsafe checkpoint, but it must set `trustResultingSurfaceForDeltaReplay: false` unless the server/client can prove compatible geometry history.

Leave `TerminalView.tsx` call-site migration to Task 3 so Task 2 can finish the policy helper in isolation. Task 3 must construct `checkpointDecision` with `canUseCheckpointForDeltaReplay(...)` before calling `resolveRevealAttachPlan`; intermediate commits are allowed to have a TODO adapter only if the focused tests still pass and the next task removes it before `npm run check`.

- [ ] **Step 8: Run focused tests**

Run:

```bash
timeout 180s npm run test:vitest -- --run test/unit/client/lib/terminal-surface-checkpoint.test.ts test/unit/client/lib/terminal-cursor.test.ts test/unit/client/lib/terminal-attach-seq-state.test.ts test/unit/client/lib/terminal-attach-policy.test.ts
```

Expected: pass.

- [ ] **Step 9: Commit**

```bash
git add src/lib/terminal-surface-checkpoint.ts test/unit/client/lib/terminal-surface-checkpoint.test.ts src/lib/terminal-cursor.ts test/unit/client/lib/terminal-cursor.test.ts src/lib/terminal-attach-seq-state.ts test/unit/client/lib/terminal-attach-seq-state.test.ts src/lib/terminal-attach-policy.ts test/unit/client/lib/terminal-attach-policy.test.ts
git commit -m "Model terminal catch-up checkpoints explicitly"
```

## Task 3: TerminalView Uses Parser-Applied Cursor And Attach Generations

**Files:**
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/e2e/terminal-create-attach-ordering.test.tsx`

- [ ] **Step 1: Add failing delayed callback lifecycle test**

Add this test inside the `attach sequence v2` describe block in `test/unit/client/components/TerminalView.lifecycle.test.tsx`, next to the existing stale attach tests:

```ts
it('does not let stale write callbacks advance the current parser-applied cursor', async () => {
  const { terminalId, term } = await renderTerminalHarness({
    status: 'running',
    terminalId: 'term-stale-write-callback',
    serverInstanceId: 'server-a',
    streamId: 'stream-1',
    clearSends: false,
  })

  const firstAttach = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
  expect(firstAttach?.attachRequestId).toBeTruthy()

  const delayedCallbacks: Array<() => void> = []
  term.write.mockImplementation((_data: string, onWritten?: () => void) => {
    if (onWritten) delayedCallbacks.push(onWritten)
  })

  act(() => {
    messageHandler!({
      type: 'terminal.output',
      terminalId,
      seqStart: 1,
      seqEnd: 1,
      data: 'old replay text',
      attachRequestId: firstAttach!.attachRequestId,
    })
  })

  expect(delayedCallbacks).toHaveLength(1)

  wsMocks.send.mockClear()
  act(() => {
    reconnectHandler?.()
  })

  const secondAttach = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
  expect(secondAttach?.attachRequestId).toBeTruthy()
  expect(secondAttach?.attachRequestId).not.toBe(firstAttach?.attachRequestId)

  saveTerminalSurfaceCheckpoint({
    terminalId,
    streamId: 'stream-1',
    serverInstanceId: 'server-a',
    surfaceEpoch: 1,
    attachRequestId: secondAttach!.attachRequestId,
    parserAppliedSeq: 0,
    cols: 80,
    rows: 24,
    geometryEpoch: 1,
    geometryAuthority: 'single_client',
    scrollback: 5000,
    xtermVersion: '6.0.0',
    bufferType: 'normal',
    parserIdle: true,
  })

  act(() => {
    delayedCallbacks.shift()?.()
  })

  const checkpointAfterStaleCallback = loadTerminalSurfaceCheckpoint(terminalId, {
    streamId: 'stream-1',
    serverInstanceId: 'server-a',
  })
  expect(checkpointAfterStaleCallback).not.toBeNull()
  expect(checkpointAfterStaleCallback?.attachRequestId).toBe(secondAttach?.attachRequestId)
  expect(checkpointAfterStaleCallback?.parserAppliedSeq).toBe(0)

  const currentAttach = wsMocks.send.mock.calls
    .map(([msg]) => msg)
    .find((msg) => msg?.type === 'terminal.attach' && msg?.terminalId === terminalId)
  expect(currentAttach?.attachRequestId).toBe(secondAttach?.attachRequestId)
})
```

- [ ] **Step 2: Run the failing lifecycle test**

Run:

```bash
timeout 180s npm run test:vitest -- --run test/unit/client/components/TerminalView.lifecycle.test.tsx -t "stale write callbacks"
```

Expected before implementation: fail because stale write callbacks are not generation checked.

- [ ] **Step 3: Rename cursor semantics in TerminalView**

In `src/components/TerminalView.tsx`:

- Rename local "rendered" cursor refs and functions to parser-applied names.
- Replace user-facing comments that imply paint/render acknowledgement.
- Keep behavior unchanged until generation checks are added.

Use names:

```ts
const parserAppliedSeqRef = useRef(0)
const markParserAppliedSeq = useCallback((terminalId: string | undefined, seq: number, context: {
  streamId: string | null
  serverInstanceId: string
  attachRequestId: string
  cols: number
  rows: number
  geometryEpoch: number
  geometryAuthority: TerminalGeometryAuthority
  scrollback: number
  xtermVersion: string
}) => {
  if (!terminalId || !Number.isFinite(seq)) return
  const parserAppliedSeq = Math.max(0, Math.floor(seq))
  if (parserAppliedSeq <= parserAppliedSeqRef.current) return
  parserAppliedSeqRef.current = parserAppliedSeq
  saveTerminalSurfaceCheckpoint({
    terminalId,
    streamId: context.streamId,
    serverInstanceId: context.serverInstanceId,
    surfaceEpoch: surfaceEpochRef.current,
    attachRequestId: context.attachRequestId,
    parserAppliedSeq,
    cols: context.cols,
    rows: context.rows,
    geometryEpoch: context.geometryEpoch,
    geometryAuthority: context.geometryAuthority,
    scrollback: context.scrollback,
    xtermVersion: context.xtermVersion,
    bufferType: currentBufferTypeRef.current ?? 'unknown',
    parserIdle: !writeQueueRef.current?.hasInFlightWrites(context.attachRequestId),
  })
}, [])
```

- [ ] **Step 4: Pass active attach generation into queued writes**

When calling `handleTerminalOutput`, pass the current attach generation into `enqueueTerminalWrite` through `TerminalWriteQueueOptions`:

```ts
handleTerminalOutput(
  raw,
  mode,
  tid,
  !frameOverlapsReplay,
  completeParserAppliedFrame,
  {
    mode: frameOverlapsReplay ? 'replay' : 'live',
    generation: currentAttachRef.current?.attachRequestId ?? 'no-attach',
  },
)
```

Before beginning a new attach, call:

```ts
writeQueueRef.current?.setActiveGeneration(nextAttachRequestId, {
  dropQueuedStaleWrites: true,
})
```

If `writeQueueRef.current?.hasInFlightWrites()` is true and the new attach would clear or full-hydrate the current surface, do not clear the existing xterm in place. Prefer a bounded drain. If the drain does not complete, recreate the xterm surface and increment `surfaceEpoch`.

- [ ] **Step 5: Gate parser-applied callbacks by generation**

Change frame completion callbacks to check attach generation before mutating state:

```ts
const completeParserAppliedFrame = () => {
  const activeAttach = currentAttachRef.current
  if (!activeAttach || activeAttach.attachRequestId !== frameAttachRequestId) return
  markParserAppliedSeq(tid, frameDecision.state.lastSeq, {
    streamId: frameDecision.state.streamId,
    serverInstanceId: frameDecision.state.serverInstanceId,
    attachRequestId: activeAttach.attachRequestId,
    cols: frameDecision.state.cols,
    rows: frameDecision.state.rows,
    geometryEpoch: frameDecision.state.geometryEpoch,
    geometryAuthority: frameDecision.state.geometryAuthority,
    scrollback: terminalScrollback,
    xtermVersion: XTERM_VERSION,
  })
  if (completedAttachOnFrame) {
    setIsAttaching(false)
    markAttachComplete()
  }
}
```

- [ ] **Step 6: Run client lifecycle tests**

Run:

```bash
timeout 240s npm run test:vitest -- --run test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/components/TerminalView.tsx test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx
git commit -m "Fence terminal catch-up by attach generation"
```

## Task 4: Async Xterm Write Scope And Side-Effect Suppression

**Files:**
- Create: `src/lib/terminal-output-write-scope.ts`
- Create: `src/lib/terminal-output-side-effects.ts`
- Create: `test/unit/client/lib/terminal-output-write-scope.test.ts`
- Create: `test/unit/client/lib/terminal-output-side-effects.test.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/components/terminal/terminal-write-queue.ts`
- Modify: `src/components/terminal/request-mode-bypass.ts`
- Modify: `src/lib/terminal-osc52.ts`
- Modify: `test/unit/client/components/terminal/terminal-write-queue.test.ts`
- Modify: `test/unit/client/lib/terminal-osc52.test.ts`
- Modify: `test/unit/shared/turn-complete-signal.test.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] **Step 1: Add async write-scope tests**

Create `test/unit/client/lib/terminal-output-write-scope.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  beginTerminalOutputWriteScope,
  getTerminalOutputWriteScope,
  shouldAllowTerminalOutputSideEffect,
} from '@/lib/terminal-output-write-scope'

describe('terminal output write scope', () => {
  it('keeps replay context visible until the submitted write completes', () => {
    const scope = beginTerminalOutputWriteScope({
      terminalInstanceId: 'surface-1',
      source: 'replay',
      attachRequestId: 'attach-1',
      generation: 'attach-1',
      suppressExternalSideEffects: true,
    })

    expect(getTerminalOutputWriteScope('surface-1')?.source).toBe('replay')
    scope.complete()
    expect(getTerminalOutputWriteScope('surface-1')).toBeNull()
  })

  it('suppresses external side effects during replay writes', () => {
    expect(shouldAllowTerminalOutputSideEffect({
      terminalInstanceId: 'surface-1',
      source: 'replay',
      effect: 'request_mode_reply',
      mode: 'shell',
    })).toBe(false)
    expect(shouldAllowTerminalOutputSideEffect({
      source: 'replay',
      effect: 'osc52_clipboard_write',
      mode: 'shell',
    })).toBe(false)
    expect(shouldAllowTerminalOutputSideEffect({
      source: 'replay',
      effect: 'title_update',
      mode: 'shell',
    })).toBe(false)
  })
})
```

Add focused regression tests in existing suites:

- A probe-style unit test models xterm's async behavior: `term.write` returns before parser callbacks, and the write scope still suppresses replay side effects until the callback completes.
- `request-mode-bypass` does not call `sendInput` while the terminal instance's submitted write scope is replay.
- OSC52 policy `always` does not write to the clipboard while the terminal instance's submitted write scope is replay.
- `TerminalView` ignores or defers xterm title callbacks fired during replay-scope writes.
- xterm write callbacks from stale or replay-suppressed scope do not advance parser-applied checkpoints, persist cursors, or complete attaches.
- local notices are rendered out-of-band or explicitly mark the terminal surface incompatible for warm delta replay.
- link/action callbacks are fenced to the current terminal-instance token or declared outside replay parsing.
- Startup probes and client-minted turn-complete signals are still allowed for live output and suppressed for replay output.

- [ ] **Step 2: Run failing scope and side-effect tests**

Run:

```bash
timeout 180s npm run test:vitest -- --run test/unit/client/lib/terminal-output-write-scope.test.ts test/unit/client/lib/terminal-output-side-effects.test.ts test/unit/client/lib/terminal-osc52.test.ts test/unit/shared/turn-complete-signal.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: fail because submitted-write scope does not exist and replay parser callbacks are not guarded.

- [ ] **Step 3: Implement terminal-instance write scope**

Create `src/lib/terminal-output-write-scope.ts`:

```ts
export type TerminalOutputSource = 'live' | 'replay'

export type TerminalOutputSideEffect =
  | 'startup_reply'
  | 'osc52_prompt'
  | 'osc52_clipboard_write'
  | 'request_mode_reply'
  | 'title_update'
  | 'turn_complete'
  | 'parser_applied_checkpoint'
  | 'attach_completion'
  | 'cursor_persist'
  | 'link_action'
  | 'terminal_action'
  | 'local_xterm_notice'

export type TerminalOutputWriteContext = {
  terminalInstanceId: string
  source: TerminalOutputSource
  attachRequestId: string | undefined
  generation: string
  suppressExternalSideEffects: boolean
}

const activeScopes = new Map<string, TerminalOutputWriteContext>()

export function getTerminalOutputWriteScope(
  terminalInstanceId: string | undefined,
): TerminalOutputWriteContext | null {
  if (!terminalInstanceId) return null
  return activeScopes.get(terminalInstanceId) ?? null
}

export function beginTerminalOutputWriteScope(
  context: TerminalOutputWriteContext,
): { complete: () => void } {
  activeScopes.set(context.terminalInstanceId, context)
  let completed = false
  return {
    complete: () => {
      if (completed) return
      completed = true
      if (activeScopes.get(context.terminalInstanceId) === context) {
        activeScopes.delete(context.terminalInstanceId)
      }
    },
  }
}
```

Create `src/lib/terminal-output-side-effects.ts` and export `shouldAllowTerminalOutputSideEffect(input)` from there. Replay or unknown scope suppresses all external side effects by default. Live output still follows existing mode-specific rules, including server-authoritative turn-complete for Claude and Codex. New side effects must fail closed until tests explicitly allow them for live/current-surface scope.

- [ ] **Step 4: Make xterm writes serial per terminal surface**

Update `src/components/terminal/terminal-write-queue.ts` and `src/components/TerminalView.tsx` so the queue submits at most one xterm write at a time for a terminal surface. Start the write scope immediately before submitting the xterm write, and complete it only in the xterm write callback. Do not submit the next queued write until the callback for the current submitted write has run.

Update existing queue tests at the same time. Any queue mock that accepts an `onWritten` callback must either call it explicitly or keep it in a pending callback list and drive it from the test. The existing live-mode time-slice tests must not accidentally stall just because the production queue now waits for xterm write completion before submitting the next write. If an implementation proves a separate live-only fast path is context-safe, cover that proof with tests; otherwise the tests should model serial completion.

Use the same source/generation/terminal-instance metadata passed to the write queue:

```ts
const scope = beginTerminalOutputWriteScope({
  terminalInstanceId,
  source: frameOverlapsReplay ? 'replay' : 'live',
  attachRequestId: frameAttachRequestId,
  generation: frameAttachRequestId ?? 'no-attach',
  suppressExternalSideEffects: frameOverlapsReplay,
})
term.write(data, () => {
  try {
    onWritten?.()
  } finally {
    scope.complete()
  }
})
```

Do not rely on stack-scoped context around `term.write`; xterm parsing is asynchronous. Do not rely on the old `allowReplies` boolean as a complete safety boundary.

- [ ] **Step 5: Gate parser side-effect paths**

Update the concrete side-effect paths found by load-bearing:

- `src/components/terminal/request-mode-bypass.ts`: check the terminal-instance write scope before `sendInput(response)`.
- `src/lib/terminal-osc52.ts`: check the terminal-instance write scope before prompts and before direct `always` clipboard writes.
- `src/components/TerminalView.tsx`: suppress xterm title-change Redux updates when the terminal-instance write scope is replay, or queue the latest live title only after replay completes.
- Startup probe replies and client-minted turn-complete dispatches use `shouldAllowTerminalOutputSideEffect`.

- [ ] **Step 6: Run parser and lifecycle tests**

Run:

```bash
timeout 300s npm run test:vitest -- --run test/unit/client/components/terminal/terminal-write-queue.test.ts test/unit/client/lib/terminal-output-write-scope.test.ts test/unit/client/lib/terminal-startup-probes.test.ts test/unit/client/lib/terminal-osc52.test.ts test/unit/shared/turn-complete-signal.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/codex-startup-probes.test.tsx test/e2e/opencode-startup-probes.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/terminal-output-write-scope.ts src/lib/terminal-output-side-effects.ts test/unit/client/lib/terminal-output-write-scope.test.ts test/unit/client/lib/terminal-output-side-effects.test.ts src/components/terminal/terminal-write-queue.ts test/unit/client/components/terminal/terminal-write-queue.test.ts src/components/TerminalView.tsx src/components/terminal/request-mode-bypass.ts src/lib/terminal-osc52.ts test/unit/client/lib/terminal-osc52.test.ts test/unit/shared/turn-complete-signal.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "Gate terminal output side effects by write scope"
```

## Task 5: Serialized Payload Budgeting And Pre-Sequence Fragmentation

**Files:**
- Create: `server/terminal-stream/stream-identity.ts`
- Create: `server/terminal-stream/serialized-budget.ts`
- Create: `server/terminal-stream/output-fragments.ts`
- Create: `test/unit/server/terminal-stream/stream-identity.test.ts`
- Create: `test/unit/server/terminal-stream/serialized-budget.test.ts`
- Create: `test/unit/server/terminal-stream/output-fragments.test.ts`
- Modify: `server/terminal-registry.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/terminal-stream/client-output-queue.ts`
- Modify: `server/terminal-stream/replay-ring.ts`

- [ ] **Step 1: Add failing serialized budget and fragmentation tests**

Create `test/unit/server/terminal-stream/serialized-budget.test.ts` and `test/unit/server/terminal-stream/output-fragments.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { measureTerminalOutputPayloadBytes } from '../../../../server/terminal-stream/serialized-budget'
import {
  containsLoneSurrogate,
  fragmentTerminalOutputForPayloadBudget,
} from '../../../../server/terminal-stream/output-fragments'

describe('terminal stream serialized budget', () => {
  it('measures escaped JSON bytes instead of raw data bytes', () => {
    const data = '\u001b'.repeat(16 * 1024)
    const bytes = measureTerminalOutputPayloadBytes({
      type: 'terminal.output',
      terminalId: 'term-1',
      data,
      seqStart: 1,
      seqEnd: 1,
      attachRequestId: 'attach-1',
    })

    expect(bytes).toBeGreaterThan(16 * 1024)
  })

  it('fragments escaped output before sequence assignment so every payload fits the budget', () => {
    const data = '\u001b'.repeat(16 * 1024)
    const chunks = fragmentTerminalOutputForPayloadBudget({
      maxSerializedBytes: 16 * 1024,
      payloadForData: (chunk) => ({
        type: 'terminal.output',
        terminalId: 'term-1',
        data: chunk,
        seqStart: 1,
        seqEnd: 1,
        attachRequestId: 'attach-1',
      }),
      data,
    })

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(measureTerminalOutputPayloadBytes({
        type: 'terminal.output',
        terminalId: 'term-1',
        data: chunk,
        seqStart: 1,
        seqEnd: 1,
        attachRequestId: 'attach-1',
      })).toBeLessThanOrEqual(16 * 1024)
    }
    expect(chunks.join('')).toBe(data)
  })

  it('does not split surrogate pairs', () => {
    const data = `prefix-${'😀'.repeat(2048)}-suffix`
    const chunks = fragmentTerminalOutputForPayloadBudget({
      maxSerializedBytes: 2048,
      payloadForData: (chunk) => ({
        type: 'terminal.output',
        terminalId: 'term-1',
        data: chunk,
        seqStart: 1,
        seqEnd: 1,
        attachRequestId: 'attach-1',
      }),
      data,
    })

    expect(chunks.join('')).toBe(data)
    expect(chunks.every((chunk) => !containsLoneSurrogate(chunk))).toBe(true)
  })

  it('preserves replacement characters emitted by current string-mode PTY decoding', () => {
    const chunks = fragmentTerminalOutputForPayloadBudget({
      maxSerializedBytes: 2048,
      payloadForData: (chunk) => ({
        type: 'terminal.output',
        terminalId: 'term-1',
        data: chunk,
        seqStart: 1,
        seqEnd: 1,
        attachRequestId: 'attach-1',
      }),
      data: `prefix-\ufffd-suffix`,
    })

    expect(chunks.join('')).toBe('prefix-\ufffd-suffix')
  })
})
```

Do not add replay-ring read-path coalescing assertions in this task. Task 5 proves the fragmentation helper and pre-sequence sequence-space expansion. Task 6 owns the replay read-path proof after the barrier scanner and serialized-budget batch builder exist; otherwise the existing raw-byte coalescing behavior can defeat this task's append-time fragmentation.

Create `test/unit/server/terminal-stream/stream-identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createTerminalStreamIdentityTracker } from '../../../../server/terminal-stream/stream-identity'

describe('terminal stream identity', () => {
  it('keeps stream id stable across attach and detach for the same output stream', () => {
    const tracker = createTerminalStreamIdentityTracker()
    const initial = tracker.ensureStream('term-1')

    expect(tracker.ensureStream('term-1')).toBe(initial)
    tracker.recordAttach('term-1', 'attach-1')
    tracker.recordDetach('term-1', 'attach-1')

    expect(tracker.ensureStream('term-1')).toBe(initial)
  })

  it('changes stream id on pty replacement and incompatible retention loss', () => {
    const tracker = createTerminalStreamIdentityTracker()
    const initial = tracker.ensureStream('term-1')

    const afterRecovery = tracker.replaceStream('term-1', 'codex_pty_recovery')
    const afterRetentionLoss = tracker.replaceStream('term-1', 'retention_lost')

    expect(afterRecovery).not.toBe(initial)
    expect(afterRetentionLoss).not.toBe(afterRecovery)
  })
})
```

- [ ] **Step 2: Run failing serialized budget and fragmentation tests**

Run:

```bash
timeout 120s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/unit/server/terminal-stream/stream-identity.test.ts test/unit/server/terminal-stream/serialized-budget.test.ts test/unit/server/terminal-stream/output-fragments.test.ts
```

Expected: fail because the helpers and pre-sequence fragmentation path do not exist.

- [ ] **Step 3: Implement serialized budget and Unicode-safe fragmentation helpers**

Create `server/terminal-stream/stream-identity.ts` and wire it into terminal stream ingestion. `streamId` changes on new PTY/session stream, Codex PTY recovery replacement, incompatible retention loss, and server restart without compatible persisted retention. It does not change on attach/detach. Codex recovery paths in `server/terminal-registry.ts` must emit enough lifecycle signal for the terminal stream broker to call `replaceStream('codex_pty_recovery')` when `record.pty` is replaced under the same `terminalId`.

Create `server/terminal-stream/serialized-budget.ts`:

```ts
export type JsonPayload = Record<string, unknown>

export function measureSerializedJsonBytes(payload: JsonPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8')
}

export function measureTerminalOutputPayloadBytes(payload: JsonPayload): number {
  return measureSerializedJsonBytes(payload)
}
```

Create `server/terminal-stream/output-fragments.ts`:

```ts
import { measureSerializedJsonBytes, type JsonPayload } from './serialized-budget.js'

export function containsLoneSurrogate(data: string): boolean {
  for (let i = 0; i < data.length; i += 1) {
    const code = data.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = data.charCodeAt(i + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      i += 1
      continue
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

export function fragmentTerminalOutputForPayloadBudget(input: {
  maxSerializedBytes: number
  data: string
  payloadForData: (data: string) => JsonPayload
}): string[] {
  // Oversized terminal chunks are rare, but this binary search reserializes
  // candidate JSON payloads. Keep the helper covered by a stress test or
  // replace it with incremental measurement if it appears in hot-path logs.
  const maxSerializedBytes = Math.max(1, Math.floor(input.maxSerializedBytes))
  if (measureSerializedJsonBytes(input.payloadForData(input.data)) <= maxSerializedBytes) {
    return [input.data]
  }

  const chunks: string[] = []
  const codePoints = Array.from(input.data)
  let offset = 0

  while (offset < codePoints.length) {
    let low = 1
    let high = codePoints.length - offset
    let best = 0

    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const candidate = codePoints.slice(offset, offset + mid).join('')
      const bytes = measureSerializedJsonBytes(input.payloadForData(candidate))
      if (bytes <= maxSerializedBytes) {
        best = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }

    if (best <= 0) {
      throw new Error('terminal output payload budget is too small for one code point')
    }

    chunks.push(codePoints.slice(offset, offset + best).join(''))
    offset += best
  }

  return chunks
}
```

- [ ] **Step 4: Fragment after raw observers and before assigning replay/live sequence numbers**

Update the terminal-stream broker ingestion path so `fragmentTerminalOutputForPayloadBudget` runs after `terminal.output.raw` observers receive the original string event, and before assigning `seqStart`/`seqEnd` for replay/live frames. The budget-measurement payload must still include representative `seqStart` and `seqEnd` fields, because those fields are present in the actual `terminal.output` JSON passed to `ws.send`. The resulting fragments become normal frames with distinct sequence ranges. Do not split a `ReplayFrame` after it already has a sequence number, because the current client treats repeated or overlapping sequence ranges as invalid.

Use the same fragmentation helper for live queue inputs and replay retention so live and replay semantics do not diverge. Keep raw byte counts for retention accounting only.

This task intentionally preserves the current UTF-8 string terminal contract. Add comments and tests that document current `node-pty` string-mode behavior for invalid UTF-8 and 8-bit C1 bytes as replacement characters. Do not claim byte-stream-perfect replay in this task.

- [ ] **Step 5: Use serialized application JSON bytes in server stream batching**

Replace raw `Buffer.byteLength(data, 'utf8')` batch limit checks for outgoing WebSocket payloads with `measureTerminalOutputPayloadBytes`. Name this budget "serialized application JSON bytes" in code and logs; do not call it exact wire bytes because per-message compression can change on-wire size.

- [ ] **Step 6: Run focused server stream tests**

Run:

```bash
timeout 300s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/unit/server/terminal-stream/stream-identity.test.ts test/unit/server/terminal-stream/serialized-budget.test.ts test/unit/server/terminal-stream/output-fragments.test.ts test/unit/server/terminal-stream/replay-ring.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
git add server/terminal-stream/stream-identity.ts test/unit/server/terminal-stream/stream-identity.test.ts server/terminal-stream/serialized-budget.ts server/terminal-stream/output-fragments.ts test/unit/server/terminal-stream/serialized-budget.test.ts test/unit/server/terminal-stream/output-fragments.test.ts server/terminal-registry.ts server/terminal-stream/broker.ts server/terminal-stream/client-output-queue.ts server/terminal-stream/replay-ring.ts
git commit -m "Fragment terminal output before sequence assignment"
```

## Task 6: Barrier-Aware Server Batching

**Files:**
- Create: `server/terminal-stream/output-barrier-scanner.ts`
- Create: `server/terminal-stream/output-batch.ts`
- Create: `test/unit/server/terminal-stream/output-barrier-scanner.test.ts`
- Create: `test/unit/server/terminal-stream/output-batch.test.ts`
- Modify: `server/terminal-stream/replay-ring.ts`
- Modify: `server/terminal-stream/client-output-queue.ts`
- Modify: `server/terminal-stream/broker.ts`

- [ ] **Step 1: Add stateful barrier scanner tests**

Create `test/unit/server/terminal-stream/output-barrier-scanner.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createTerminalOutputBarrierScanner } from '../../../../server/terminal-stream/output-barrier-scanner'

describe('terminal output barrier scanner', () => {
  it('treats plain printable text and newlines as transparent', () => {
    const scanner = createTerminalOutputBarrierScanner()
    expect(scanner.scan('hello\nworld\r\n')).toMatchObject({ barrier: false, ground: true })
  })

  it('treats escape sequences as barriers', () => {
    const scanner = createTerminalOutputBarrierScanner()
    expect(scanner.scan('\u001b[31mred')).toMatchObject({
      barrier: true,
      reason: 'control',
      ground: true,
    })
  })

  it('treats BEL as a turn-complete-sensitive barrier', () => {
    const scanner = createTerminalOutputBarrierScanner()
    expect(scanner.scan('\u0007')).toMatchObject({
      barrier: true,
      reason: 'turn_complete',
      ground: true,
    })
  })

  it('treats OSC sequences as OSC52-sensitive barriers', () => {
    const scanner = createTerminalOutputBarrierScanner()
    expect(scanner.scan('\u001b]52;c;SGVsbG8=\u0007')).toMatchObject({
      barrier: true,
      reason: 'osc52',
      ground: true,
    })
  })

  it('carries pending CSI state across fragments', () => {
    const scanner = createTerminalOutputBarrierScanner()
    expect(scanner.scan('\u001b[')).toMatchObject({
      barrier: true,
      reason: 'control',
      ground: false,
    })
    expect(scanner.scan('6n')).toMatchObject({
      barrier: true,
      reason: 'request_mode',
      ground: true,
    })
  })

  it('carries pending OSC state across fragments', () => {
    const scanner = createTerminalOutputBarrierScanner()
    expect(scanner.scan('\u001b]52;c;')).toMatchObject({
      barrier: true,
      reason: 'osc52',
      ground: false,
    })
    expect(scanner.scan('SGVsbG8=\u0007')).toMatchObject({
      barrier: true,
      reason: 'osc52',
      ground: true,
    })
  })

  it('treats replacement characters from lossy PTY decoding as barriers', () => {
    const scanner = createTerminalOutputBarrierScanner()
    expect(scanner.scan('\ufffd')).toMatchObject({
      barrier: true,
      reason: 'control',
      ground: true,
    })
  })

  it('returns scanner state snapshots that can be stored on retained frames', () => {
    const scanner = createTerminalOutputBarrierScanner()
    const first = scanner.scan('\u001b[')
    const second = scanner.scan('6n')

    expect(first.stateBefore.mode).toBe('ground')
    expect(first.stateAfter.mode).toBe('csi')
    expect(second.stateBefore.mode).toBe('csi')
    expect(second.stateAfter.mode).toBe('ground')
  })
})
```

- [ ] **Step 2: Add batch builder tests**

Create `test/unit/server/terminal-stream/output-batch.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildTerminalOutputBatches } from '../../../../server/terminal-stream/output-batch'

describe('terminal output batch builder', () => {
  it('coalesces contiguous transparent frames under the serialized budget', () => {
    const batches = buildTerminalOutputBatches({
      terminalId: 'term-1',
      attachRequestId: 'attach-1',
      source: 'replay',
      maxSerializedBytes: 16 * 1024,
      frames: [
        { seqStart: 1, seqEnd: 1, data: 'a', bytes: 1, at: 1 },
        { seqStart: 2, seqEnd: 2, data: 'b', bytes: 1, at: 2 },
      ],
    })

    expect(batches).toHaveLength(1)
    expect(batches[0]).toMatchObject({
      seqStart: 1,
      seqEnd: 2,
      data: 'ab',
      source: 'replay',
    })
    expect(batches[0].segments).toEqual([
      { seqStart: 1, seqEnd: 1, endOffset: 1, rawFrameCount: 1 },
      { seqStart: 2, seqEnd: 2, endOffset: 2, rawFrameCount: 1 },
    ])
  })

  it('does not coalesce across parser barriers', () => {
    const batches = buildTerminalOutputBatches({
      terminalId: 'term-1',
      attachRequestId: 'attach-1',
      source: 'replay',
      maxSerializedBytes: 16 * 1024,
      frames: [
        { seqStart: 1, seqEnd: 1, data: 'a', bytes: 1, at: 1 },
        { seqStart: 2, seqEnd: 2, data: '\u0007', bytes: 1, at: 2 },
        { seqStart: 3, seqEnd: 3, data: 'b', bytes: 1, at: 3 },
      ],
    })

    expect(batches.map((batch) => batch.data)).toEqual(['a', '\u0007', 'b'])
  })

  it('uses UTF-16 code-unit segment offsets on code-point boundaries', () => {
    const batches = buildTerminalOutputBatches({
      terminalId: 'term-1',
      attachRequestId: 'attach-1',
      source: 'replay',
      maxSerializedBytes: 16 * 1024,
      frames: [
        { seqStart: 1, seqEnd: 1, data: '😀', bytes: 4, at: 1 },
        { seqStart: 2, seqEnd: 2, data: 'b', bytes: 1, at: 2 },
      ],
    })

    expect(batches[0].data).toBe('😀b')
    expect(batches[0].segments).toMatchObject([
      { seqStart: 1, seqEnd: 1, endOffset: 2 },
      { seqStart: 2, seqEnd: 2, endOffset: 3 },
    ])
  })

  it('does not re-coalesce serialized-budget fragments across control barriers', () => {
    const frames = Array.from({ length: 8 }, (_unused, index) => ({
      seqStart: index + 1,
      seqEnd: index + 1,
      data: '\u001b'.repeat(2048),
      bytes: 2048,
      at: index + 1,
      barrier: true,
      barrierReason: 'control',
      scannerStateBefore: { mode: 'ground' },
      scannerStateAfter: { mode: 'ground' },
    }))

    const batches = buildTerminalOutputBatches({
      terminalId: 'term-1',
      attachRequestId: 'attach-1',
      source: 'replay',
      maxSerializedBytes: 16 * 1024,
      frames,
    })

    expect(batches.length).toBeGreaterThan(1)
    expect(new Set(batches.map((batch) => `${batch.seqStart}:${batch.seqEnd}`)).size)
      .toBe(batches.length)
    expect(batches.every((batch) => batch.serializedBytes <= 16 * 1024)).toBe(true)
  })
})
```

Also update `test/unit/server/terminal-stream/replay-ring.test.ts` in this task where existing read-path coalescing assertions conflict with scanner-aware semantics. Transparent text may still coalesce through `buildTerminalOutputBatches`; control-barrier fragments and serialized-budget fragments must not be re-coalesced into an oversized serialized payload. This is the task that reconciles the old raw-byte coalescing tests with the new barrier-aware replay contract.

- [ ] **Step 3: Run failing batch tests**

Run:

```bash
timeout 120s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/unit/server/terminal-stream/output-barrier-scanner.test.ts test/unit/server/terminal-stream/output-batch.test.ts
```

Expected: fail because the helpers do not exist.

- [ ] **Step 4: Implement conservative stateful barrier scanner**

Create `server/terminal-stream/output-barrier-scanner.ts`:

```ts
export type TerminalOutputBarrierReason =
  | 'control'
  | 'osc52'
  | 'request_mode'
  | 'turn_complete'
  | 'startup_probe'

export type TerminalOutputScannerMode = 'ground' | 'esc' | 'csi' | 'osc' | 'dcs' | 'apc'

export type TerminalOutputScannerState = {
  mode: TerminalOutputScannerMode
}

export type TerminalOutputBarrierClassification =
  | {
      barrier: false
      ground: boolean
      stateBefore: TerminalOutputScannerState
      stateAfter: TerminalOutputScannerState
    }
  | {
      barrier: true
      reason: TerminalOutputBarrierReason
      ground: boolean
      stateBefore: TerminalOutputScannerState
      stateAfter: TerminalOutputScannerState
    }

export type TerminalOutputBarrierScanner = {
  scan: (data: string) => TerminalOutputBarrierClassification
  isGround: () => boolean
}

const ESC = '\u001b'
const BEL = '\u0007'

export function createTerminalOutputBarrierScanner(): TerminalOutputBarrierScanner {
  // Implement a small conservative VT state machine, not a stateless substring scan.
  // Track at least: ground, esc, csi, osc, dcs, apc. Pending non-ground
  // state is itself a barrier and prevents coalescing until a terminator/final byte.
  // Treat U+FFFD as a barrier because current node-pty string mode may have
  // already lost invalid UTF-8 or 8-bit C1 control bytes.
  throw new Error('implement stateful scanner')
}
```

The implementation must be stream-stateful. It must remember pending control/string states across raw chunks and across serialized-budget fragments. It must return scanner-state snapshots that can be stored on retained frames at ingestion time; replay batching for arbitrary `sinceSeq` windows must consume stored metadata instead of mutating or reconstructing the live scanner from an unsafe prefix. A later byte-preserving terminal protocol may replace this scanner; this task must not rely on byte-perfect input.

- [ ] **Step 5: Implement batch builder**

Create `server/terminal-stream/output-batch.ts` using `createTerminalOutputBarrierScanner` and `measureTerminalOutputPayloadBytes`. The builder must:

- Preserve `seqStart`, `seqEnd`, `attachRequestId`, and source.
- Stop before barriers.
- Emit a barrier frame as its own batch.
- Stop before serialized budget overflow.
- Preserve segment metadata.
- Only coalesce transparent spans when the scanner is in ground state before and after the span.
- Consume stored frame barrier metadata (`barrier`, `barrierReason`, `scannerStateBefore`, `scannerStateAfter`) instead of re-scanning retained replay from an arbitrary window.
- Keep live scanner state with the terminal stream so live and replay batching see the same barrier decisions.
- Emit `segments[].endOffset` as a UTF-16 code-unit offset on code-point boundaries.

- [ ] **Step 6: Wire server replay and live queues to the batch builder**

Use `buildTerminalOutputBatches` in:

- `server/terminal-stream/replay-ring.ts` for replay batch reads.
- `server/terminal-stream/client-output-queue.ts` for live queued batch reads.
- `server/terminal-stream/broker.ts` for sending batches.

- [ ] **Step 7: Run server stream tests**

Run:

```bash
timeout 300s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/unit/server/terminal-stream/output-barrier-scanner.test.ts test/unit/server/terminal-stream/output-batch.test.ts test/unit/server/terminal-stream/replay-ring.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-handler-backpressure.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-edge-cases.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add server/terminal-stream/output-barrier-scanner.ts server/terminal-stream/output-batch.ts test/unit/server/terminal-stream/output-barrier-scanner.test.ts test/unit/server/terminal-stream/output-batch.test.ts test/unit/server/terminal-stream/replay-ring.test.ts server/terminal-stream/replay-ring.ts server/terminal-stream/client-output-queue.ts server/terminal-stream/broker.ts
git commit -m "Make terminal replay batching barrier aware"
```

## Task 7: Replace ReplayRing Eviction With A Deque

**Files:**
- Create: `server/terminal-stream/replay-deque.ts`
- Create: `test/unit/server/terminal-stream/replay-deque.test.ts`
- Modify: `server/terminal-stream/replay-ring.ts`
- Modify: `test/unit/server/terminal-stream/replay-ring.test.ts`

- [ ] **Step 1: Add deque stress tests**

Create `test/unit/server/terminal-stream/replay-deque.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { ReplayDeque } from '../../../../server/terminal-stream/replay-deque'

describe('ReplayDeque', () => {
  it('evicts many tiny frames without shifting the backing array per frame', () => {
    const deque = new ReplayDeque(1024)

    for (let i = 0; i < 4096; i += 1) {
      deque.append('x')
    }

    expect(deque.totalBytes()).toBeLessThanOrEqual(1024)
    expect(deque.headSeq()).toBe(4096)
    expect(deque.tailSeq()).toBeGreaterThan(1)
  })

  it('reports a gap after eviction while preserving retained frames', () => {
    const deque = new ReplayDeque(3)
    deque.append('a')
    deque.append('b')
    deque.append('c')
    deque.append('d')

    const replay = deque.replayBatchSince(0, 1024, 4)

    expect(replay.missedFromSeq).toBe(1)
    expect(replay.frames.map((frame) => frame.data).join('')).toBe('bcd')
  })

  it('preserves barrier metadata for arbitrary replay windows', () => {
    const deque = new ReplayDeque(1024)
    deque.append({
      data: '\u001b[',
      barrier: true,
      barrierReason: 'control',
      scannerStateBefore: { mode: 'ground' },
      scannerStateAfter: { mode: 'csi' },
    })
    deque.append({
      data: '6n',
      barrier: true,
      barrierReason: 'request_mode',
      scannerStateBefore: { mode: 'csi' },
      scannerStateAfter: { mode: 'ground' },
    })

    const replay = deque.replayBatchSince(1, 1024)

    expect(replay.frames[0]).toMatchObject({
      data: '6n',
      barrier: true,
      barrierReason: 'request_mode',
      scannerStateBefore: { mode: 'csi' },
      scannerStateAfter: { mode: 'ground' },
    })
  })
})
```

- [ ] **Step 2: Run failing deque tests**

Run:

```bash
timeout 120s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/unit/server/terminal-stream/replay-deque.test.ts
```

Expected: fail because `ReplayDeque` does not exist.

- [ ] **Step 3: Implement ReplayDeque**

Create `server/terminal-stream/replay-deque.ts` with:

```ts
import type { ReplayFrame } from './replay-ring.js'
import type {
  TerminalOutputBarrierReason,
  TerminalOutputScannerState,
} from './output-barrier-scanner.js'

export type ReplayDequeFrame = ReplayFrame & {
  barrier?: boolean
  barrierReason?: TerminalOutputBarrierReason
  scannerStateBefore?: TerminalOutputScannerState
  scannerStateAfter?: TerminalOutputScannerState
}

export type ReplayDequeAppendInput =
  | string
  | {
      data: string
      barrier?: boolean
      barrierReason?: TerminalOutputBarrierReason
      scannerStateBefore: TerminalOutputScannerState
      scannerStateAfter: TerminalOutputScannerState
    }

export class ReplayDeque {
  private frames: ReplayDequeFrame[] = []
  private start = 0
  private bytes = 0
  private nextSeq = 1
  private head = 0

  constructor(private readonly maxBytes: number) {}

  append(input: ReplayDequeAppendInput): ReplayDequeFrame {
    const data = typeof input === 'string' ? input : input.data
    const frame: ReplayDequeFrame = {
      seqStart: this.nextSeq,
      seqEnd: this.nextSeq,
      data,
      bytes: Buffer.byteLength(data, 'utf8'),
      at: Date.now(),
      ...(typeof input === 'string' ? {} : {
        barrier: input.barrier,
        barrierReason: input.barrierReason,
        scannerStateBefore: input.scannerStateBefore,
        scannerStateAfter: input.scannerStateAfter,
      }),
    }
    this.nextSeq += 1
    this.head = frame.seqEnd
    this.frames.push(frame)
    this.bytes += frame.bytes
    this.evictIfNeeded()
    return frame
  }

  totalBytes(): number {
    return this.bytes
  }

  headSeq(): number {
    return this.head
  }

  tailSeq(): number {
    const first = this.frames[this.start]
    return first ? first.seqStart : this.head + 1
  }

  replayBatchSince(sinceSeq: number, maxBytes: number, toSeq = Number.POSITIVE_INFINITY): {
    frames: ReplayDequeFrame[]
    missedFromSeq?: number
  } {
    const tail = this.tailSeq()
    const missedFromSeq = sinceSeq < tail - 1 ? sinceSeq + 1 : undefined
    const frames: ReplayDequeFrame[] = []
    let budget = Math.max(0, Math.floor(maxBytes))

    for (let i = this.start; i < this.frames.length; i += 1) {
      const frame = this.frames[i]
      if (!frame || frame.seqStart > toSeq) break
      if (frame.seqEnd <= sinceSeq) continue
      if (frame.bytes > budget && frames.length > 0) break
      frames.push({ ...frame })
      budget -= frame.bytes
      if (budget <= 0) break
    }

    return { frames, missedFromSeq }
  }

  private evictIfNeeded(): void {
    while (this.bytes > this.maxBytes && this.start < this.frames.length) {
      const frame = this.frames[this.start]
      this.start += 1
      if (frame) this.bytes -= frame.bytes
    }
    if (this.start > 4096 && this.start * 2 > this.frames.length) {
      this.frames = this.frames.slice(this.start)
      this.start = 0
    }
  }
}
```

Make `ReplayRing` delegate to `ReplayDeque` so existing imports remain stable while the internal storage changes. Update the affected `replay-ring.test.ts` assertions where the new scanner/barrier and no-implicit-coalescing semantics intentionally replace the old coalesced replay behavior.

- [ ] **Step 4: Run replay tests**

Run:

```bash
timeout 240s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/unit/server/terminal-stream/replay-deque.test.ts test/unit/server/terminal-stream/replay-ring.test.ts test/unit/server/ws-handler-backpressure.test.ts test/server/ws-terminal-stream-v2-replay.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add server/terminal-stream/replay-deque.ts test/unit/server/terminal-stream/replay-deque.test.ts server/terminal-stream/replay-ring.ts test/unit/server/terminal-stream/replay-ring.test.ts
git commit -m "Use deque storage for terminal replay retention"
```

## Task 8: Foreground Replay Pacing

**Files:**
- Create: `server/ws-send.ts`
- Create: `test/unit/server/ws-send.test.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`

- [ ] **Step 1: Add failing foreground pacing test**

Add this test to `test/unit/server/ws-handler-backpressure.test.ts`:

```ts
it('pauses foreground replay before avoidable buffered growth exceeds the pacing threshold', async () => {
  const registry = new FakeBrokerRegistry()
  const broker = new TerminalStreamBroker(registry as any, vi.fn())
  registry.createTerminal('term-foreground-paced')
  const pacingThresholdBytes = 512 * 1024
  const allowedBatchOvershootBytes = 64 * 1024

  for (let i = 1; i <= 1400; i += 1) {
    registry.emit('terminal.output.raw', {
      terminalId: 'term-foreground-paced',
      data: `line-${i};${'x'.repeat(2048)}`,
      at: Date.now(),
    })
  }

  const wsReplay = createMockWs({ bufferedAmount: 0 })
  wsReplay.send.mockImplementation((raw: string) => {
    wsReplay.bufferedAmount += Buffer.byteLength(raw, 'utf8')
  })

  await broker.attach(
    wsReplay as any,
    'term-foreground-paced',
    'transport_reconnect',
    80,
    24,
    0,
    'foreground-attach',
    undefined,
    'foreground',
  )

  vi.advanceTimersByTime(5)

  expect(wsReplay.bufferedAmount).toBeLessThanOrEqual(
    pacingThresholdBytes + allowedBatchOvershootBytes,
  )

  broker.close()
})
```

- [ ] **Step 2: Run failing pacing test**

Run:

```bash
timeout 180s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/unit/server/ws-handler-backpressure.test.ts -t "foreground replay"
```

Expected before implementation: fail. The seeded backlog is intentionally larger than 2 MiB and the mock socket never drains, so unpaced replay sends the full backlog and exceeds `pacingThresholdBytes + allowedBatchOvershootBytes`.

- [ ] **Step 3: Implement normal foreground pacing**

Create `server/ws-send.ts` and route both `server/ws-handler.ts` and `server/terminal-stream/broker.ts` through it. The shared sender must own:

- JSON serialization and serialized application byte measurement.
- `ws.send` callback handling.
- `ws.bufferedAmount` reads before and after sends.
- closed-socket handling.
- `ws_send_large` and replay/backpressure structured JSONL instrumentation.
- a single max serialized message budget shared by normal handler sends and terminal broker sends.

Then in `server/terminal-stream/broker.ts`:

- Keep catastrophic threshold behavior.
- Add a normal foreground replay pacing threshold lower than catastrophic, using serialized bytes and `ws.bufferedAmount`.
- After each replay send, re-read `ws.bufferedAmount`.
- If above threshold, schedule the next flush instead of continuing the same flush.
- Background threshold remains stricter than foreground threshold.
- Do not call `ws.send(JSON.stringify(...))` directly.

- [ ] **Step 4: Run backpressure tests**

Run:

```bash
timeout 240s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/unit/server/ws-send.test.ts test/unit/server/ws-handler-backpressure.test.ts test/server/ws-edge-cases.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add server/ws-send.ts test/unit/server/ws-send.test.ts server/ws-handler.ts server/terminal-stream/broker.ts test/unit/server/ws-handler-backpressure.test.ts
git commit -m "Pace foreground terminal replay under socket pressure"
```

## Task 9: Add Batch Protocol

**Files:**
- Modify: `shared/ws-protocol.ts`
- Modify: `src/lib/ws-client.ts`
- Modify: `server/ws-handler.ts`
- Modify: `server/terminal-stream/broker.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `src/lib/terminal-attach-seq-state.ts`
- Modify: `test/server/ws-protocol.test.ts`
- Modify: `test/unit/client/lib/ws-client.test.ts`
- Modify: `test/unit/client/lib/terminal-attach-seq-state.test.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`
- Modify: `test/server/ws-terminal-stream-v2-replay.test.ts`

- [ ] **Step 1: Add capability and protocol tests**

Add tests in `test/server/ws-protocol.test.ts` and `test/unit/client/lib/ws-client.test.ts` that validate:

- The client hello advertises `capabilities.terminalOutputBatchV1: true` only after the client can parse batches.
- The server records the capability on the WebSocket/client attachment state.
- A batch-capable client can receive the batch shape below.
- A protocol v6 client that omits the batch capability still receives compatible `terminal.output` messages.
- Non-batch fallback serializes safe batch segments as individual modern `terminal.output` frames that include `seqStart`, `seqEnd`, `streamId`, and `attachRequestId`; it must not use the old registry `{ type, terminalId, data }` shape.
- Non-batch fallback does not flatten arbitrary batches across parser barriers, stream id, attach id, budget, or replay/live source boundaries.
- Protocol v5 clients are rejected during `hello` so they cannot silently receive or drop unsafe untagged terminal stream messages.
- A batch-capable client rejects or splits any batch whose segments cannot all be accepted before bytes are written to xterm.

Batch shape:

```ts
{
  type: 'terminal.output.batch',
  terminalId: 'term-1',
  streamId: 'stream-1',
  attachRequestId: 'attach-1',
  source: 'replay',
  seqStart: 1,
  seqEnd: 2,
  data: 'ab',
  serializedBytes: 256,
  segments: [
    { seqStart: 1, seqEnd: 1, endOffset: 1, data: 'a', rawFrameCount: 1 },
    { seqStart: 2, seqEnd: 2, endOffset: 2, data: 'b', rawFrameCount: 1 },
  ],
}
```

`endOffset` is a UTF-16 code-unit offset into top-level `data`; segment `data` is optional redundancy for debugging and non-batch fallback. If `data` is present, the client and server tests must assert it equals the slice implied by the previous segment offset and `endOffset`.

Do not write a test against a non-existent `ServerMessageSchema`. If this task adds server-to-client runtime validation, add the schema intentionally in this task and test that new API. Otherwise, use type-level tests and behavior tests around client/server message handling.

- [ ] **Step 2: Run failing capability/protocol tests**

Run:

```bash
timeout 240s npm run test:vitest -- --run test/unit/client/lib/ws-client.test.ts
timeout 240s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/server/ws-protocol.test.ts test/server/ws-terminal-stream-v2-replay.test.ts -t "terminal.output.batch|terminalOutputBatchV1|legacy"
```

Expected: fail because the capability and batch behavior do not exist.

- [ ] **Step 3: Add protocol capability and message types**

In `shared/ws-protocol.ts`:

- Add `terminalOutputBatchV1?: boolean` to hello capabilities.
- Add `TerminalOutputBatchMessage` to the server-to-client TypeScript union.
- Keep existing `TerminalOutputMessage` support.
- If adding runtime validation for server-to-client messages, add an explicit `TerminalOutputBatchMessageSchema` and a tested server-message schema. Do not pretend the current TS-only union already validates server messages at runtime.

- [ ] **Step 4: Advertise and persist client capability**

In `src/lib/ws-client.ts`, advertise `terminalOutputBatchV1: true` only in the same branch that implements client parsing.

In `server/ws-handler.ts`, read the capability from the hello payload and pass it into terminal stream attachment state. Keep default false for clients that omit the capability.

- [ ] **Step 5: Emit batch messages only when supported**

In `server/terminal-stream/broker.ts`, emit `terminal.output.batch` only for clients whose attachment state says `terminalOutputBatchV1` is true. For protocol v6 clients without that capability, send `terminal.output` messages using the same server-side batch builder internally if useful, but serialize each safe segment as its own compatible output frame with `seqStart`, `seqEnd`, `streamId`, `attachRequestId`, and `data`.

Do not flatten an arbitrary batch into one fallback `terminal.output`. Fallback frames have less segment metadata than `terminal.output.batch`, so they must not cross replay/live source, attach id, stream id, parser-barrier, or serialized-budget boundaries. Do not route terminal stream fallback through the old registry direct-output shape, because current clients ignore output without sequence ranges.

- [ ] **Step 6: Process batch messages client-side**

In `src/components/TerminalView.tsx`, process `terminal.output.batch` by prevalidating every segment's sequence range before writing any batch bytes to xterm. If any segment is stale, overlapping, from an incompatible stream/attach/source, or parser-barrier-sensitive, do not partially write the combined batch.

Efficient writes are allowed only for a homogeneous accepted span:

- same source (`live` or `replay`);
- same attach request id and stream id;
- all segments accepted by sequence state;
- no parser-side-effect barrier inside the combined write;
- one terminal-instance write scope can safely cover the whole submitted write.

For barrier segments, mixed replay/live spans, or spans requiring different side-effect context, split the client write per segment. Advance `parserAppliedSeq` only after the corresponding xterm write callback, and never for segments that were not actually submitted.

- [ ] **Step 7: Run protocol and lifecycle tests**

Run:

```bash
timeout 300s npm run test:vitest -- --run test/unit/client/lib/ws-client.test.ts test/unit/client/lib/terminal-attach-seq-state.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
timeout 300s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/server/ws-protocol.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/unit/server/ws-handler-backpressure.test.ts
```

Expected: pass.

- [ ] **Step 8: Commit**

```bash
git add shared/ws-protocol.ts src/lib/ws-client.ts server/ws-handler.ts server/terminal-stream/broker.ts src/components/TerminalView.tsx src/lib/terminal-attach-seq-state.ts test/server/ws-protocol.test.ts test/unit/client/lib/ws-client.test.ts test/unit/client/lib/terminal-attach-seq-state.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/server/ws-terminal-stream-v2-replay.test.ts
git commit -m "Add protocol-aware terminal output batches"
```

## Task 10: Structured Observability And Retention SLO

**Files:**
- Modify: `server/terminal-stream/broker.ts`
- Modify: `server/terminal-stream/replay-ring.ts`
- Modify: `src/components/TerminalView.tsx`
- Modify: `test/unit/server/ws-handler-backpressure.test.ts`
- Modify: `test/unit/client/components/TerminalView.lifecycle.test.tsx`

- [ ] **Step 1: Add structured log assertions**

In `test/unit/server/ws-handler-backpressure.test.ts`, add assertions that the broker logger receives structured fields:

```ts
expect(log).toHaveBeenCalledWith(expect.objectContaining({
  event: 'terminal.replay.batch',
  severity: 'debug',
  terminalId: 'term-replay-coalesced',
  seqStart: 1,
  seqEnd: 1000,
  serializedBytes: expect.any(Number),
  rawFrameCount: expect.any(Number),
}), 'debug')
```

Add similar assertions for:

- `terminal.replay.gap`
- `terminal.replay.backpressure_pause`
- `terminal.replay.retention`

- [ ] **Step 2: Run failing log tests**

Run:

```bash
timeout 180s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/unit/server/ws-handler-backpressure.test.ts -t "terminal.replay"
```

Expected before implementation: fail because structured event names or fields are missing.

- [ ] **Step 3: Add server structured events**

In `server/terminal-stream/broker.ts`, emit JSON-friendly structured log payloads with at least:

```ts
{
  event: 'terminal.replay.batch',
  severity: 'debug',
  terminalId,
  attachRequestId,
  source,
  seqStart,
  seqEnd,
  rawFrameCount,
  dataBytes,
  serializedBytes,
  bufferedAmount,
}
```

For warnings:

```ts
{
  event: 'terminal.replay.gap',
  severity: 'warn',
  terminalId,
  attachRequestId,
  fromSeq,
  toSeq,
  reason,
}
```

- [ ] **Step 4: Add client perf marks**

In `src/components/TerminalView.tsx`, add perf marks for:

- `terminal.parser_applied`
- `terminal.attach_generation_stale_rejected`
- `terminal.catchup.full_hydrate_fallback`
- `terminal.catchup.surface_quarantined`

Use existing perf bridge patterns already present in `TerminalView.tsx`.

These marks must be promoted into the visible-first audit artifact in Task 11. Debug-only console logs are not enough.

- [ ] **Step 5: Run focused observability tests**

Run:

```bash
timeout 240s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/unit/server/ws-handler-backpressure.test.ts
timeout 240s npm run test:vitest -- --run test/unit/client/components/TerminalView.lifecycle.test.tsx
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add server/terminal-stream/broker.ts server/terminal-stream/replay-ring.ts src/components/TerminalView.tsx test/unit/server/ws-handler-backpressure.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx
git commit -m "Instrument terminal catch-up replay safety"
```

## Task 11: Browser-Level Verification

**Files:**
- Create: `test/e2e-browser/specs/terminal-background-freeze-catchup.spec.ts`
- Modify: `test/e2e-browser/perf/run-sample.ts`
- Modify: `test/e2e-browser/perf/scenarios.ts`
- Modify: `test/unit/lib/visible-first-audit-scenarios.test.ts`
- Modify: `test/unit/lib/visible-first-audit-derived-metrics.test.ts`
- Modify: `test/unit/lib/visible-first-audit-gate.test.ts`

- [ ] **Step 1: Add terminal catch-up acceptance metrics**

Extend the existing `terminal-reconnect-backlog` scenario to record:

- replay message count
- total serialized replay bytes
- parser-applied lag
- gaps count
- full hydrate fallback count
- surface quarantine count
- stale generation rejection count
- focused ready time
- terminal input to first output
- max RAF gap
- stopped/backgrounded duration covered by retention
- WebSocket state after process suspend/resume or real browser background/resume
- replay gaps or surface quarantine after suspend/background resume
- batch protocol coverage when `terminalOutputBatchV1` is enabled

When Phase 5 enables `terminal.output.batch`, update the `terminal-reconnect-backlog` audit scenario's `allowedWsTypesBeforeReady` to include both `terminal.output` and `terminal.output.batch`. Otherwise the audit can reject expected batch replay traffic before the first-output milestone for the wrong reason.

- [ ] **Step 2: Add unit tests for metrics contract**

Add a `requiredMetricIds` field to the visible-first audit scenario definitions, including `terminal-reconnect-backlog`, so scenarios can declare required derived metrics directly.

In `test/unit/lib/visible-first-audit-scenarios.test.ts`, `test/unit/lib/visible-first-audit-derived-metrics.test.ts`, and `test/unit/lib/visible-first-audit-gate.test.ts`, assert the scenario and derived metrics include terminal catch-up metrics:

```ts
expect(scenarioMap.get('terminal-reconnect-backlog')?.requiredMetricIds).toEqual(expect.arrayContaining([
  'terminalReplayMessageCount',
  'terminalReplaySerializedBytes',
  'terminalParserAppliedLagMs',
  'terminalReplayGapCount',
  'terminalFullHydrateFallbackCount',
  'terminalSurfaceQuarantineCount',
  'terminalStaleGenerationRejectionCount',
  'terminalStoppedRetentionCoveredMs',
  'terminalStopResumeGapCount',
]))
```

- [ ] **Step 3: Run failing audit contract tests**

Run:

```bash
timeout 120s npm run test:vitest -- --run test/unit/lib/visible-first-audit-scenarios.test.ts test/unit/lib/visible-first-audit-derived-metrics.test.ts test/unit/lib/visible-first-audit-gate.test.ts
```

Expected: fail until metric contract is added.

- [ ] **Step 4: Implement metric capture**

In `test/e2e-browser/perf/run-sample.ts`, collect metrics from:

- browser perf marks
- WebSocket recorder
- server structured logs
- terminal helper output checks

Do not rely on CDP `Network.webSocketFrameReceived.payloadData` as compressed wire-byte evidence. Treat its `payloadData` length as serialized application payload evidence only. Prefer server structured logs for serialized replay bytes and replay frame counts, and client perf marks for parser-applied lag and stale-generation rejection.

The acceptance target for the 1,200-line backlog case:

- Replay messages stay in the same order of magnitude as #397, not #396.
- No stale-generation cursor advancement.
- No replay-triggered OSC52 or startup replies.
- No replay gaps in the seeded audit scenario.
- No full hydrate fallback or surface quarantine in the compatible warm surface path.

- [ ] **Step 5: Add browser stop/resume positive-control probe**

Create `test/e2e-browser/specs/terminal-background-freeze-catchup.spec.ts`. It must:

- Open an isolated Freshell page through the existing Playwright server fixture.
- Seed terminal output while the page is active and establish a parser-applied checkpoint.
- Use a positive-control browser-execution stop mechanism that proves page work actually stopped or was throttled. Acceptable local proof is process-tree suspend/resume or another mechanism that records timer, RAF, and WebSocket counters before, during, and after the stopped period.
- Generate enough terminal output while browser execution is stopped to exercise server retention but stay within the configured retention budget.
- Resume browser execution.
- Assert the WebSocket behavior observed during stop/resume: still open and stalled, closed/reconnected, or buffered/resumed. The test must record which path happened.
- Assert catch-up either has no gaps and no quarantine for the covered retention window, or reports explicit gaps/quarantine when retention is exceeded. Silent parser-applied cursor jumps are failures.

This positive-control probe is required implementation evidence for the PR. CDP `Page.setWebLifecycleState({ state: 'frozen' })` and Xvfb tab switching were disproven as valid proof in `docs/superpowers/proofs/artifacts/browser-freeze-lifecycle.json` and `docs/superpowers/proofs/artifacts/browser-background-visibility.json` because page work continued at active rates.

- [ ] **Step 6: Run browser perf audit and positive-control probe for the terminal scenario**

Run:

```bash
timeout 1200s tsx scripts/visible-first-audit.ts --scenario terminal-reconnect-backlog --profile desktop_local --output /tmp/freshell-terminal-catchup-audit.json
timeout 1200s npm run test:e2e:chromium -- test/e2e-browser/specs/terminal-background-freeze-catchup.spec.ts
```

Expected: audit completes and writes `/tmp/freshell-terminal-catchup-audit.json`; the stop/resume spec passes, proves the page execution stop with timer/RAF/WebSocket counters, and records WebSocket state plus retention coverage.

- [ ] **Step 7: Record real Windows Chrome acceptance follow-up**

This is not a prerequisite for opening the single implementation PR. It is recommended release/user-acceptance evidence when a real Windows Chrome environment can be observed for a long background soak. If run, retain the artifact and summarize it in the PR or follow-up issue.

Required gate:

1. Start an isolated Freshell server from the feature worktree on a unique port. Do not touch the self-hosted dev server.
2. Open real Windows Chrome, not headless Chromium or Xvfb.
3. Create a terminal running the deterministic generator and at least one real Codex turn.
4. Confirm `document.visibilityState === 'hidden'` or record an OS freeze/suspend event while the Freshell tab is backgrounded, minimized, or otherwise stopped by the OS/browser.
5. Keep it backgrounded for a 4h soak at a calibrated 1 KiB/s stream and one shorter burst of at least 750 KiB.
6. Refocus and assert:
   - no unsafe warm replay after retention loss;
   - no unsequenced `terminal.output`;
   - no parser-unsafe gap continues on the same parser;
   - no replay-triggered OSC52/request-mode/title/turn side effect;
   - catch-up to server head completes under the configured UX budget for covered retention;
   - all terminal catch-up metrics are present in structured JSONL logs.
7. If disk retention is part of a later implementation, repeat one 8h overnight soak before enabling that retention mode by default.

- [ ] **Step 8: Commit**

```bash
git add test/e2e-browser/specs/terminal-background-freeze-catchup.spec.ts test/e2e-browser/perf/run-sample.ts test/e2e-browser/perf/scenarios.ts test/unit/lib/visible-first-audit-scenarios.test.ts test/unit/lib/visible-first-audit-derived-metrics.test.ts test/unit/lib/visible-first-audit-gate.test.ts
git commit -m "Audit terminal catch-up replay performance"
```

## Final Verification

- [ ] **Step 1: Run focused client suite**

```bash
timeout 600s npm run test:vitest -- --run test/unit/client/components/terminal/terminal-write-queue.test.ts test/unit/client/lib/terminal-surface-checkpoint.test.ts test/unit/client/lib/terminal-cursor.test.ts test/unit/client/lib/terminal-attach-seq-state.test.ts test/unit/client/lib/terminal-attach-policy.test.ts test/unit/client/lib/ws-client.test.ts test/unit/client/lib/terminal-output-side-effects.test.ts test/unit/client/components/TerminalView.lifecycle.test.tsx test/e2e/terminal-create-attach-ordering.test.tsx test/e2e/terminal-flaky-network-responsiveness.test.tsx
```

Expected: pass.

- [ ] **Step 2: Run focused server suite**

```bash
timeout 600s npm run test:vitest -- --config config/vitest/vitest.server.config.ts --run test/unit/server/terminal-stream/stream-identity.test.ts test/unit/server/terminal-stream/output-barrier-scanner.test.ts test/unit/server/terminal-stream/output-batch.test.ts test/unit/server/terminal-stream/serialized-budget.test.ts test/unit/server/terminal-stream/output-fragments.test.ts test/unit/server/terminal-stream/replay-deque.test.ts test/unit/server/terminal-stream/replay-ring.test.ts test/unit/server/terminal-stream/client-output-queue.test.ts test/unit/server/ws-send.test.ts test/unit/server/ws-handler-backpressure.test.ts test/server/ws-terminal-stream-v2-replay.test.ts test/server/ws-edge-cases.test.ts test/server/ws-protocol.test.ts
```

Expected: pass.

- [ ] **Step 3: Run parser side-effect suite**

```bash
timeout 600s npm run test:vitest -- --run test/unit/client/lib/terminal-output-write-scope.test.ts test/unit/client/lib/terminal-output-side-effects.test.ts test/unit/client/lib/terminal-startup-probes.test.ts test/unit/client/lib/terminal-osc52.test.ts test/unit/shared/turn-complete-signal.test.ts test/e2e/codex-startup-probes.test.tsx test/e2e/opencode-startup-probes.test.tsx test/e2e/terminal-osc52-policy-flow.test.tsx
```

Expected: pass.

- [ ] **Step 4: Run terminal visible-first audit and local stop/resume proof**

```bash
timeout 1200s tsx scripts/visible-first-audit.ts --scenario terminal-reconnect-backlog --profile desktop_local --output /tmp/freshell-terminal-catchup-audit.json
timeout 1200s npm run test:e2e:chromium -- test/e2e-browser/specs/terminal-background-freeze-catchup.spec.ts
```

Expected: pass and show no replay gaps, no stale cursor advancement, no unexpected surface quarantine, #397-class replay message count, explicit stop/resume retention coverage, and recorded timer/RAF/WebSocket counters proving the browser page was actually stopped or throttled during the local probe.

- [ ] **Step 5: Confirm browser acceptance scope**

The required local acceptance scope is the visible-first audit plus process-suspend stop/resume proof above. Record that real Windows Chrome long-background soak remains recommended user-acceptance evidence, not a blocker for this PR.

- [ ] **Step 6: Verify xterm dependency policy**

Either pin `@xterm/xterm` exactly to the probed version or run committed xterm parser probes in CI against every allowed resolved version.

```bash
node -e "const p=require('./package.json'); if (p.dependencies['@xterm/xterm'] !== '6.0.0') process.exit(1)"
```

Expected: pass if the implementation chooses exact pinning. If it chooses CI probes instead, replace this command with the committed probe command and explain that choice in the PR.

- [ ] **Step 7: Run repo-supported full check**

```bash
FRESHELL_TEST_SUMMARY="terminal catch-up stream safety" timeout 1800s npm run check
```

Expected: full coordinated check passes.

## Residual Risks And Cheapest Validations

- Stream-stateful barrier scanner may be too conservative and reduce batching for ANSI-heavy output. Cheapest validation: log batch reasons and compare real coding-agent sessions.
- Multi-client geometry remains inherently constrained by one PTY size. Cheapest validation: visible-client resize authority test plus logs for geometry epoch mismatches.
- Retained byte replay is not a complete snapshot system, especially across geometry history. Cheapest validation: observe retained age, retained bytes, output rate, gap frequency, and geometry changes before designing snapshots.
- Protocol v5 clients cannot safely interoperate with mandatory stream identity. Cheapest validation: keep the protocol v6 rejection test and deploy client/server together.
- Protocol v6 clients may omit `terminal.output.batch`. Cheapest validation: keep additive fallback until support policy says non-batch v6 clients can be dropped.
- Stream/server identity rollout may need a compatibility bridge for existing local cursors. Cheapest validation: tests that old cursor records force full hydrate instead of warm delta replay.
- Current terminal stream remains UTF-8 string based and is not byte-perfect for invalid UTF-8 or raw 8-bit C1 controls. Cheapest validation: decide whether coding-agent terminals need byte-perfect replay before starting a separate byte-protocol project.
- Real Windows Chrome long-background behavior remains valuable release/user-acceptance evidence. Cheapest validation: run the Task 11 Windows Chrome follow-up when a suitable environment is available; local CDP freeze and Xvfb background probes are not acceptable substitutes unless their counters prove page execution actually stopped or throttled.

## Self-Review

Spec coverage:

- The plan keeps #397's server-side batching benefit.
- The plan rejects #396's unsupported 32 ms replay budget.
- The plan fixes stale queued writes/callbacks with attach generation safety.
- The plan requires terminal-instance write scoping and drain-or-replace behavior for already-submitted xterm writes.
- The plan treats xterm disposal as non-canceling for pending write callbacks and requires token fences on post-dispose continuations.
- The plan replaces path-specific side-effect allow lists with a deny-by-default terminal output side-effect adapter.
- The plan replaces raw-byte send budgets with serialized application JSON payload budgets.
- The plan fragments oversized PTY output before sequence assignment, preserving distinct sequence ranges.
- The plan requires Unicode-safe fragmentation that does not split surrogate pairs.
- The plan defines server-owned stream identity and changes it on PTY/session replacement, Codex recovery replacement, retention loss, and incompatible restart.
- The plan explicitly preserves current UTF-8 string output semantics and does not claim byte-perfect terminal replay.
- The plan separates parser-applied sequence, observed sequence, replay request sequence, and known lost ranges.
- The plan quarantines parser-unsafe gaps instead of continuing to write into a potentially desynchronized parser.
- The plan replaces unsafe replay retention data structures.
- The plan treats parser side effects with an async terminal-instance xterm write scope, covering request-mode replies, OSC52 `always`, title updates, startup replies, write-callback checkpoint mutations, attach-completion mutations, local notices, link/action callbacks, and turn-complete.
- The plan replaces stateless barrier classification with a stream-stateful barrier scanner.
- The plan stores barrier scanner metadata with retained replay frames so arbitrary replay windows do not reconstruct unsafe parser state.
- The plan routes terminal broker WebSocket sends through a shared sender with callbacks, payload budgets, and instrumentation.
- The plan uses protocol v6 for mandatory stream identity, gates `terminal.output.batch` behind `terminalOutputBatchV1`, and keeps a non-batch v6 fallback.
- The plan requires safe non-batch fallback segmentation instead of flattening arbitrary batches.
- The plan adds observability for retention, lag, gaps, serialized bytes, and backpressure.
- The plan requires visible-first derived metrics and a local stop/resume positive-control probe before using browser audit results as PR acceptance evidence; real Windows Chrome long-background testing remains recommended release/user-acceptance follow-up.

Placeholder scan:

- Reviewer-facing placeholder tokens were scanned and none remain. Intentional test-first implementation stubs such as `throw new Error('implement stateful scanner')` remain only where the plan explicitly instructs workers to write failing tests before implementation.
- Every task has exact files, failing tests, commands, expected outcomes, and commits.

Type consistency:

- Cursor terminology is consistently `parserAppliedSeq`.
- Surface validity is consistently represented as `TerminalSurfaceCheckpoint`.
- Replay/loss bookkeeping is separate from parser-applied checkpoint validity.
- Output source is consistently `'live' | 'replay'`.
- Batch metadata consistently uses `segments`, `serializedBytes`, `seqStart`, and `seqEnd`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-08-terminal-catchup-stream-safety.md`.

Execution model:

1. **Single-Branch Execution (required)** - implement every task in one worktree branch, run every task gate and final local proof gate, then open one PR. Local commits can track task boundaries, but do not publish partial PRs.

2. **Agent Coordination** - scoped subagents can help with disjoint tasks or reviews inside that same branch, but integration remains local until the full end-to-end proof passes.
