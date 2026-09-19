# Reliable, Responsive Pane Restore — Diagnosis and Plan

Status: revised proposal after source review; screen reconstruction and history representation require design validation before implementation (no code changes yet)
Date: 2026-09-19
Incident: live self-hosted server on garageserver (`192.168.3.150:3001`), Electron client on DANDESKTOP
Related: `docs/plans/2026-03-30-paginated-terminal-replay.md`, `docs/plans/2026-07-24-rust-attach-viewport.md` (TERM-07 open items)

## Summary

When a client attaches to a terminal, the server sends its entire retained output newer than the requested position and ignores the requested replay budget. In the incident, initial and repeated full hydrations amounted to roughly 21 MB across seven terminals. The server's sustained-backlog disconnect threshold is lower than its output-spill threshold, creating a reconnect loop. The client already records parser-applied progress, but an incomplete fresh-surface hydrate and other safety checks can force the next attempt back to zero.

The fix must bound delivery without treating arbitrary terminal output as a screen snapshot. First establish a correct reconstruction and resume contract, then implement bounded delivery, resumable hydration, and backpressure handling together. Terminal history browsing and conversation pagination are separate follow-on work. Removing the conversation refresh cover also requires fixing the same-revision refresh retry condition.

This revision incorporates source review of the existing client checkpoints, terminal queues, OpenCode recovery, and conversation refresh paths. Incident measurements below are retained from the original investigation; the review did not repeat live probes or establish how much of the network backlog was caused specifically by renderer work.

## What the user experienced

- The pane for `opencode --session ses_f5434cdf6ffeZYNTjLVLre77W8` never finished resuming; it appeared hung behind a "Refreshing conversation…" cover.
- Restarting the Electron client did not help: the reconnect/disconnect loop resumed immediately.
- Other panes in the same app showed similar restoring/refreshing symptoms because they share one connection.

The "Refreshing conversation…" cover is implemented by `FreshAgentView`, whereas terminal replay is handled by `TerminalView`. Treat these as separate recovery paths observed in the same incident; record pane IDs and content types in the reproduction rather than attributing the conversation overlay directly to terminal replay.

## Diagnosis

### The failure loop

1. Initial connection and subsequent hydration schedule terminal attachments across the layout (7 terminals plus 7 agent-conversation panes in the incident). Existing background hydration/rebind queues already stage some work; this is not one unconditional synchronous attach of every pane.
2. For each zero-position terminal hydrate, the server resends the terminal's full retained past output ("replay"). Measured ~3 MB per pane.
3. The client asks for only the newest 128 KB per normal terminal pane. The server ignores that request: the field (`maxReplayBytes`) exists in the protocol but no server code reads it. Verified by attaching with a 128 KB request and still receiving ~3 MB.
4. Full-screen terminal apps (opencode) request no limit at all, by design.
5. The observed server output backlog is ~21–25 MB and remains above 16 MB for the required 10 seconds. The writer measures queued plus in-flight terminal output, not xterm's parsing progress. Color-heavy replay and large HTTP conversation snapshots are additional client work, but HTTP snapshot bytes are not part of that terminal queue measurement.
6. The server disconnects with code 4008 ("catastrophic backpressure"). Reconnect can force another fresh-surface hydrate, which resets the usable replay position despite some output having reached the parser; the observed attempts do not converge.
7. The server's graceful fallback — spill the oldest unsent output — only runs at 32 MB, above the 16 MB disconnect threshold, so it never gets a chance.

### Evidence

| Measurement | Value |
| --- | --- |
| Resend for terminal `c1d8efc…` (`ses_f5434…`) | 2,996,228 bytes / 7,491 frames per attach |
| Resend for the other OpenCode terminal (`8ff6bee0…`) | 3,017,089 bytes / 18,805 frames |
| Resend for a Codex terminal (`a6af3bdf…`) | 2,999,964 bytes / 14,487 frames |
| Resend with `maxReplayBytes: 131072` requested | 3,000,000 bytes (cap ignored) |
| Bytes written by the opencode TUI processes over 3 s | ~0 (no live output during the incident) |
| Server queue at disconnect | 21–25 MB vs 16,777,216-byte threshold |
| Disconnect cadence | every 15–20 s, repeating; 28 closures on Sep 18 and continuing Sep 19 |
| Agent-conversation snapshot | 6,015,324 bytes; 6.5 s to fetch for the active pane |

Supporting source locations:

- Attach handling: `crates/freshell-ws/src/terminal.rs:6916` (`handle_attach`) → `crates/freshell-terminal/src/registry.rs:1594` (`attach_to_shared`); the full-replay snapshot is taken at `registry.rs:1616-1621`.
- Ignored budget field: `crates/freshell-protocol/src/client_messages.rs:371` (`max_replay_bytes`); no reader anywhere in `crates/freshell-ws` or `crates/freshell-terminal`.
- Client budget request: `src/components/TerminalView.tsx:221` (`TRUNCATED_REPLAY_BYTES = 128 * 1024`) and `:278` (`viewportHydrateReplayOptions`, which returns no limit for opencode).
- Client handling of a budget gap: `src/components/TerminalView.tsx:4335` (`replay_budget_exceeded` → "load more" affordance).
- Thresholds: `crates/freshell-terminal/src/output_queue.rs:22` (queue spill at 32 MB), `crates/freshell-ws/src/backpressure.rs:68-75` (disconnect at 16 MB sustained 10 s), monitor at `crates/freshell-ws/src/terminal.rs:400-410` and close at `:549-565`.
- Graceful gap emission today: `crates/freshell-ws/src/connection_writer.rs:490-498` (queue overflow only; no gap is emitted when the requested position predates the retained history).
- Agent-pane cover: `src/components/fresh-agent/FreshAgentView.tsx:3360` and `:3742` (full-pane overlay while `snapshotDirty`).
- Legacy budget behavior: `server/terminal-stream/broker.ts:454-481` at commit `a7d36d5f8^` (budget walk newest-to-oldest, `replay_budget_exceeded` gap); the Rust port leaves `maxReplayBytes` unimplemented per the TERM-07 note in `docs/plans/2026-07-24-rust-attach-viewport.md`. Restoring the tail selection alone is insufficient for screen correctness and resumable progress.

### Why it cannot recover

Three design choices combine into a permanent loop:

1. A full hydrate sends the entire retained ring because its budget is ignored; an already-valid delta attach does honor `since_seq`.
2. An incomplete fresh-surface hydrate can force another full hydrate. Furthermore, reporting a skipped prefix through the existing gap handler prevents the parser-applied checkpoint from advancing past that prefix.
3. Sustained terminal backlog can trigger disconnect before spilling begins, even if socket sends are still making progress.

Fixing only the ignored budget shrinks the burst but leaves (2) and (3) able to reproduce the loop under other load.

### Not the cause

- The OpenCode session is healthy: idle, last turn completed 17:21 UTC, no error state.
- The terminal programs are not flooding: their own writes were ~0 bytes during the incident. The traffic is entirely resent history.
- The server is up and serving; this is not a crash or restart problem.
- The client/server build mismatch is real but handled correctly (the one-shot reload guard suppresses further reloads). It is unrelated.

### How to reproduce

For future reproduction, use a disposable test instance populated with equivalent scrollback, not live user terminals. Open a WebSocket to `/ws`, complete the `hello` handshake (protocol version 10, token), and send `terminal.attach` for a terminal with a full scrollback, with and without `maxReplayBytes`. Count the payload bytes of the `terminal.output.batch` messages for five seconds. The original incident probe observed:

- Without the field: ~3 MB arrives in under a second, then silence.
- With `maxReplayBytes: 131072`: the same ~3 MB arrives — proof the server ignores the request.

To reproduce the user-visible loop, open the app with several full-scrollback terminal panes and watch the server log for `ws.terminal_stream.catastrophic_close` followed by `ws.connection.closed reason=catastrophic_backpressure code=4008`, then a fresh `ws.connection.established` — repeating.

## Goals

What the person at the keyboard should get:

1. Opening Freshell with many panes: target an interactive, correct active screen in about a second on the incident hardware. Measure this; a bounded network payload alone does not establish responsiveness.
2. Hidden panes do not hydrate terminal screens or fetch conversation bodies until revealed. Cheap lifecycle, ownership, and status subscriptions remain available.
3. Earlier retained history is available in bounded pages without disturbing the live terminal; distinguish unloaded history from history that has expired.
4. A dropped connection keeps what was already shown. With compatible terminal state and retained missing output, reconnect resumes from applied progress. If reconstruction is impossible, preserve the view and show an explicit recovery state instead of silently looping or restarting a healthy process.
5. No pane is covered by a full-screen "refreshing" curtain while it has content to show.

## Plan

### Shared restore contract — implement before enabling truncation

Terminal output is a stateful instruction stream. An escape-sequence boundary is not necessarily a point from which a blank terminal can reconstruct cells, cursor position, text attributes, scroll regions, or alternate-screen state. Existing `terminal.modes.sync` restores mode flags only. The server currently has no canonical screen snapshot that proves a retained suffix is independently renderable.

Use these distinctions throughout server responses, client state, history controls, and tests:

| Condition | Meaning | Required client behavior |
| --- | --- | --- |
| Intentionally unloaded older history (`replay_budget_exceeded`) | Older bytes remain fetchable, and the current screen has an independently validated baseline | Show a history boundary; do not invalidate that baseline merely because older history is unloaded |
| Retention loss (`replay_window_exceeded`) | Requested bytes have expired | Mark the unavailable span honestly; resume only from a replacement valid baseline, otherwise retain the visible surface and show recovery state |
| Delivery loss (`queue_overflow`) | This connection missed sequenced output | Repair from retained output or a valid screen snapshot; never silently advance the applied cursor across the gap |

The existing `onOutputGap` records every span as a lost range and `markParserAppliedSeq` cannot cross it (`src/lib/terminal-attach-seq-state.ts`). Thus emitting a budget gap for `1..N` currently leaves a fresh surface's applied cursor at zero even after its retained tail is rendered. Add explicit baseline coverage and history availability to the state model; do not fix this by treating missing parser input as applied. A raw tail without a validated baseline remains incomplete, even if it looks plausible.

Scope all restore state to terminal ID, stream ID, server identity/boot, surface generation, attach generation, and compatible geometry. Responses must identify requested/effective sequence bounds, current head, oldest retained sequence, and any lost interval. Define additive capability negotiation for new reconstruction, continuation, and gap semantics before enabling them. Older clients must not receive newly introduced retention gaps that enter their automatic OpenCode replacement path; retain compatible behavior until negotiation selects the new contract.

Evidence for these constraints: `TerminalView.tsx` (`completeParserAppliedFrame`, `attachTerminal`, `beginOpenCodeReplacementAfterExit`); `src/lib/terminal-surface-checkpoint.ts`; `test/unit/client/lib/terminal-attach-seq-state.test.ts` (lost-prefix checkpoint remains zero); `crates/freshell-terminal/src/registry.rs` (`apply_attach_geometry`, `attach_to_shared`, reader ingestion); `crates/freshell-terminal/src/mode_tracker.rs`; and the append-only limitation recorded in `docs/plans/2026-03-30-paginated-terminal-replay.md`.

### Workstream 1 — Bound restore delivery and establish a correct screen (server + client)

Deliver in two increments. Paced replay fixes the unbounded burst; a screen snapshot is needed to make fresh TUI restoration independent of history size. The first increment must not be presented as meeting the final one-second screen-first goal.

1. **Paced forward restoration.** Negotiate a continuation/credit capability (proposed name: `pacedTerminalReplayV1`) that sends bounded, ascending sequence batches from a compatible applied cursor or a proven fresh-surface baseline. Parser acknowledgements carry terminal, stream, attach generation, and the last fully applied sequence; stale acknowledgements or values beyond the sent window cannot grant credit. Grant more replay credit only after xterm applies the prior batch. Keep a fixed initial catch-up target so ongoing live output cannot move the completion condition indefinitely; subsequently deliver live output in sequence order. Do not let live frames for the same terminal overtake unapplied replay. Input and other panes' traffic remain schedulable.
2. **Validated current-screen restoration.** Prototype a server-maintained terminal emulator/checkpoint, updated in PTY output order, that can reconstruct both normal and alternate buffers plus cursor, attributes, modes, and geometry. A snapshot carries its stream/geometry identity and covered sequence; snapshot capture and subscription installation must establish a gap-free snapshot→delta handoff. Compare its output against the real client parser before selecting the implementation. Do not add an emulator dependency solely on the assumption that it is xterm-compatible.

The paced path can reconstruct exactly only if its starting state and required bytes are available. The retained ring may already have lost essential state, so replaying its entire remaining tail is not a proof of correctness either. In that case use a validated snapshot when available, or show an explicit incomplete-screen state with retry; do not restart the program automatically. A newly introduced server emulator cannot retroactively reconstruct missing history for an already-running stream: mark its initial baseline unknown until a verified reset/repaint boundary, or use the explicit unavailable state.

Implementation requirements:

- Thread `max_replay_bytes` through both geometry-authorized and geometry-skipped attach paths in `handle_attach` and the registry. Preserve the legacy field's serialized application-JSON tail-budget meaning (confirmed in `broker.ts:454-481` at `a7d36d5f8^`); introduce negotiated forward-page limits rather than silently redefining it as a continuation protocol. Apply newest-tail selection only where the snapshot/baseline contract proves it correct.
- Specify terminal-data UTF-8 bytes separately from serialized message bytes. The existing replay-frame byte count is not the full JSON wire size. Enforce a serialized delivery budget including escaping, batch metadata, and envelope; account for ready/gap/mode controls separately under bounded control limits. Cover multibyte text, JSON escaping, empty replay, zero/undersized budgets, and a frame larger than the budget. Return a bounded explicit result rather than sending an oversized frame or an endless zero-progress page; any frame fragmentation needs sequence plus offset semantics and reassembly tests.
- Bound both per-pane unacknowledged replay and total per-connection admitted bytes, including snapshot/replay copies and the frame being sent. Select pages before cloning payloads; do not first allocate one full replay copy per pane. Cancellation, superseded attaches, and disconnect release credits and temporary state.
- Do not pin an unbounded replay backlog for a slow client. If retention overtakes a continuation cursor, report the exact lost interval and enter bounded baseline recovery. A finite retention window cannot guarantee convergence against indefinitely faster output production.
- Remove the proposed resize nudge. Attach resize and replay capture currently share the terminal lock needed by the output reader; an immediate capture cannot include the asynchronous repaint, and waiting under that lock prevents ingestion. Same-size resize is a no-op, and another subscriber may own geometry. Any future repaint protocol must await a verifiable result outside that lock, respect geometry ownership, and fall back on timeout; it is not a prerequisite for the paced path.
- Hidden panes do not request screen hydration until revealed. Preserve cheap lifecycle/status subscriptions separately from output delivery and terminal lifetime. Do not use ordinary `terminal.detach` as a visibility toggle without checking its release/reap semantics. Remove hidden hydration-queue grants rather than sending a nominal zero budget that the current truthy serializer omits. On reveal, use a valid retained surface checkpoint or request a fresh baseline.

Tests:

- Registry/WS: byte budgets, continuation bounds, fixed catch-up target, snapshot→live ordering under concurrent output, expired continuation, cancellation, and bounded aggregate memory with many panes.
- Client/WS: withhold parser callbacks to prove replay credit does not advance on receipt; release callbacks and prove forward progress without duplicate output or same-terminal reordering.
- Reconstruction: compare visible cells, cursor, attributes, modes, and subsequent input behavior against an uninterrupted xterm reference using shell, OpenCode, Codex, and Claude recordings, plus real TUI smoke tests. Include quiet/no-repaint output, split control sequences, alternate-buffer transitions, different geometry, second viewers, and screen representations larger than the nominal budget.
- Compatibility: new/old client-server pairs select supported behavior; lack of capability never causes an automatic kill or claims a raw suffix is a complete screen.

### Workstream 2 — Resume instead of restarting (client + server)

Implementation notes:

- Reuse the existing parser-applied checkpoint machinery. `completeParserAppliedFrame` saves progress after xterm's write callback; receipt/highest-observed sequence is not sufficient. The defect is that `surfaceFreshRef` can override an otherwise usable partial checkpoint and force zero replay, not that progress recording is entirely absent.
- Represent incomplete hydration separately from a newly created blank surface. A compatible partial hydrate can resume on the same mounted xterm without clearing it, replaying a mode preamble, or claiming `surfaceReset` again. Applying a complete validated snapshot establishes its covered-sequence baseline only after the parser applies it; incomplete snapshot installation must not be mistaken for resumable terminal deltas.
- Retain `canUseCheckpointForDeltaReplay` checks for terminal/stream/server identity, surface generation, geometry and authority, scrollback, parser readiness, and xterm version. Recreated surfaces, changed streams, or incompatible geometry need a new valid baseline, even if the old sequence is nonzero. Scope checkpoints to the actual surface so sibling panes showing the same terminal cannot borrow each other's rendered progress.
- When writes are in flight, freeze generation transitions and wait boundedly for the owned queue to drain before deciding whether its applied checkpoint remains usable. Do not clear a surface while an earlier write can still mutate it. If current quarantine rules have already invalidated that generation, preserve quarantine and rebuild from a valid baseline rather than accepting stale callbacks.
- Implement reason-aware gaps from the shared contract. In particular, remove the `replay_window_exceeded` → `beginOpenCodeReplacementAfterExit` automatic kill path before enabling new server retention-gap notifications. Restore gaps must not emit `terminal.kill`, change terminal identity, or spawn a replacement for a healthy process. Any explicit restart action remains separate user intent.
- Bound automatic recovery by attempts and lack of applied progress. Reset recovery accounting on genuine parser progress or explicit retry, not merely on receiving `attach.ready` or another reconnect. Preserve visible content and show an accessible failure/retry state when the limit is reached.

Tests:

- Interrupt a hydrate after some xterm callbacks: same surface requests only the remainder, without clear/reset/preamble, and converges to the uninterrupted reference.
- Interrupt before a callback, delay old callbacks across recovery, and independently change each checkpoint identity/geometry field: no false progress, duplicate writes, or stale checkpoint acceptance. Page reload and sibling surfaces cannot reuse a cursor without their corresponding state.
- Start with a validated bounded screen and unloaded history, apply live output, reconnect: the applied cursor advances while the history boundary remains. A true delivery gap still blocks unsafe advancement.
- A healthy idle OpenCode terminal with expired retained output reports incomplete history/screen state as appropriate; terminal ID and process remain unchanged and subsequent live output still arrives. Repeat for a queue gap; separately verify the compatible path for an older unnegotiated client.
- Recovery with no progress reaches a visible retry state and does not enter an automatic kill/recreate or reconnect loop.

### Workstream 3 — Spill old output instead of hanging up (server)

Implementation notes:

- Set consistent byte limits so normal output pressure reaches bounded admission/spill before any pressure-related disconnect. Include the leased in-flight frame; `DeliveryQueue::outstanding_bytes` already charges reserved bytes. Keep independent hard bounds on metadata/control mailboxes. Validate environment overrides so a configuration cannot silently restore the 32 MB spill / 16 MB disconnect mismatch.
- Replace the sustained-byte-count-only disconnect decision for healthy draining clients. Preserve the existing independent socket-send timeout and keepalive failure handling; slow consumption alone is not a dead socket. If tracking drain progress, count successful sends, not falling queue size: eviction and superseded attachments also reduce queue bytes. Parser credit from workstream 1 governs restore production independently of socket liveness.
- Keep ordered, generation-scoped overflow gaps and non-evictable sequenced controls. A spill bounds memory but does not repair a terminal screen: route the loss through workstream 2's repair contract. Do not exempt replay from memory accounting or silently drop control frames.
- Reuse existing focused/visible/background byte-fair scheduling. Keep input, completion/status, and other panes responsive while a terminal restores; avoid a second competing priority scheduler.

Tests:

- A slow consumer that continues making sends stays connected under sustained replay pressure; ordinary replay is paced and overflow produces an exact gap when necessary.
- A genuinely blocked send and a missing keepalive response still close the connection; eviction alone cannot masquerade as send progress.
- Queue + in-flight + restore-state memory and control/metadata counts stay bounded under a burst larger than all limits. Include an oversized indivisible frame and conflicting environment overrides.
- A gap followed by repair yields the correct screen; focused-pane input and sequenced exit/status delivery survive other panes' backlog.

### Workstream 4 — Load earlier history on demand (client + server)

Implementation direction:

- Use a separate read-only history surface within the pane, with a clear return-to-live control. xterm has no supported prepend operation; `handleLoadMoreHistory` currently clears and reattaches from zero. Do not feed backwards pages into the live terminal or its forward-only sequence/cursor state.
- Before implementation, select a historical content representation: independently renderable normal-buffer rows from the validated server emulator/checkpoint machinery, or pages reconstructed from a retained parser checkpoint plus subsequent output. Raw ANSI fragments alone are not independently renderable history. Bound checkpoint/row retention alongside replay retention; no unlimited archival store is included in this change. Do not manufacture older content that was never retained.
- Add a read-only, byte-bounded earlier-history endpoint with a terminal/stream-scoped cursor, exclusive before-position, oldest available position, and explicit exhausted/expired outcomes. Prefer the existing authenticated HTTP infrastructure for this separate read path; it must not attach, resize, claim geometry, change subscription generation, or alter the live applied cursor. Keep concurrency low and visible demand explicit.
- Preserve the history view's stable row/turn anchor when inserting older pages. Live terminal output continues on its own surface; returning to live reveals its current screen. Alternate-screen TUI redraw streams are not a chronological transcript: expose only meaningful retained normal-buffer history or clearly state that earlier history is unavailable.
- The affordance says "Load earlier" only while a valid continuation exists. If the ring advances while browsing, show an expired boundary and stop requesting that cursor instead of triggering full reattachment.

Tests:

- E2E: enter history, load several bounded pages while the terminal produces live output, preserve the history scroll anchor, and return to an unchanged live stream identity and correct current screen. No `terminal.attach`, resize, or cursor reset is emitted by a history fetch.
- Integration: cursor expiry, stream replacement, Unicode/control-sequence boundaries, alternate-screen history unavailability, and oversized content all produce bounded, honest results with no repeated zero-progress fetches.

### Workstream 5 — Stop covering panes that have content (client + server)

Split this work into a refresh-correctness change and a subsequent pagination change. The former does not need to wait for a new transcript format.

Refresh correctness:

- Replace the full-pane overlay in `FreshAgentView.tsx` with the last known conversation plus a small accessible refresh/error status and retry control. Preserve composer focus, selection, and scroll; an empty first load can still show a loading state.
- Fix the dirty-state condition, not just its presentation. Hidden reconnect calls `markSnapshotDirty`, capturing the current revision, but reveal currently accepts only a strictly greater revision (`FreshAgentView.tsx`, `markSnapshotDirty`, reconnect effect, and `revealRevisionIsFresh`). An unchanged idle conversation can therefore retry every 250 ms until error despite successful GETs.
- Track why a snapshot is dirty and the invalidation generation. For transport-only uncertainty, accept an authoritative same-revision response from a request started after that invalidation, with matching thread, owner, and request identity and no newer invalidation. A lower revision or response started before the invalidation cannot clear it. For a known mutation, require the advertised minimum revision or mutation-specific acknowledgement; do not globally replace `>` with `>=` and accidentally accept pre-mutation content.
- Retain the shared snapshot scheduler's single-flight, trailing refresh, and 429 backoff behavior. Hidden polling and event-triggered fetch suppression already exist; close the initial identity-fetch gap and add execution-time visibility demand to queued work. A hidden pane must not abort a shared request needed by a visible sibling. If no consumer remains visible, skip unstarted body fetches; a request already in flight may finish without scheduling follow-up work.
- Make freshness refer to actual scheduler execution, not just a caller's render/effect time. Preserve the existing rule that a request scheduled during an in-flight GET receives a trailing execution. Define visible-demand registration per snapshot key so the latest hidden caller cannot suppress work required by a visible consumer. Provider revisions are not one global sequence: audit each provider's revision and successful-response ownership metadata before defining mutation freshness, adding missing contract fields where necessary.
- Preserve lightweight fresh-agent attachment and status delivery for hidden panes: these support ownership, approvals, and completion notifications and are not transcript hydration.

Pagination contract:

- Reuse or extend `FreshAgentTurnPageSchema` and `FreshAgentTurnBodySchema` in `shared/fresh-agent-contract.ts` and the turns/body query and stale-revision schemas in `shared/read-models.ts`; their existence is not evidence of implemented Rust paging routes. `crates/freshell-freshagent/src/snapshot.rs` currently serves the full snapshot route. Define typed query validation and exhausted/stale/invalid-cursor responses, then update Rust responses, strict client schemas, API helpers, and consumers together. The existing whole-turn body schema cannot represent item previews or partial bodies without an explicit extension.
- Return current status, capabilities, approval/question state, revision, and a bounded recent-turn page. Older pages have stable turn/item IDs and a cursor scoped to thread identity and transcript revision. Explicitly report exhausted or invalidated cursors. Decide capability negotiation before changing the existing full-snapshot response consumed by older clients and the settings UI.
- Enforce serialized UTF-8 response-byte limits, including metadata and `rolledBackTurns`, not just a turn count. Large text, tool results, commands, attachments, and extension bodies need explicit previews plus lazy, bounded body/item pages. Never split JSON or pretend a truncated tool result is complete. A single oversized turn must still make progress through its body cursor. Keep approval/question semantics intact; if essential control metadata itself exceeds the supported budget, return an explicit bounded error instead of silently omitting controls.
- Replace whole-transcript replacement with revision-aware page storage. `mergeSnapshotForDisplay` currently replaces all turns on idle snapshots, which would discard loaded older pages. Define refresh page replacement, deduplication, and invalidation when revision changes; retain older pages only when continuity is established. Rollback/redo/fork must invalidate affected pages and bodies so a late response cannot resurrect removed turns. Treat rolled-back markers as separately paged history while retaining current redo metadata.
- Keep optimistic sends, send acknowledgements, and pending approvals separate from page membership. Absence from a partial recent page is not proof that a submitted turn was rejected or removed. Audit `localEchoLanded` / `shouldClearStaleLocalEcho` and the outgoing-turn completion path for that assumption.
- Bound server work as well as response size: prefer provider paging where available; otherwise reuse a bounded per-thread normalized index/cache. Do not rebuild and serialize a 6 MB transcript for every small page or every sibling pane. Measure provider-specific time and memory before claiming the one-second goal.

Tests:

- Hide → reconnect → reveal an unchanged idle conversation: one current same-revision response clears transport dirtiness; an older in-flight response or a response racing a new invalidation does not.
- A reveal scheduled while an earlier GET is in flight receives a fresh trailing execution. Hiding during debounce, 429 backoff, or an active shared request neither starts unnecessary follow-up work nor blocks a visible sibling.
- Refresh failure and 429 leave existing content usable; retry converges without a full-pane cover or focus/scroll loss.
- Hidden initial mount, poll, event, and queued refresh do not start body fetches; a visible sibling sharing the key still receives its response. Hidden status/completion/approval updates continue.
- Load older pages, then refresh while idle and while busy: no duplicates or unintended history loss; rollback/redo/fork followed by a late page/body response does not resurrect stale turns.
- A single multi-megabyte tool result, a large rolled-back history, and an optimistic turn outside the recent page exercise the real HTTP-to-client path. Assert bounded page/body bytes, honest continuation, and correct send state.

## Sequencing

1. **Contract and reconstruction validation.** Specify baseline coverage, parser credit, capability negotiation, loss outcomes, and screen comparison fixtures. Prototype the current-screen representation and record supported/unsupported terminal state. Select the history representation before implementing workstream 4. A failed prototype is a design blocker for screen-first delivery, not permission to ship arbitrary tail reconstruction.
2. **Bounded recovery increment: workstreams 1 (paced path), 2, and 3 together.** Implement and test partial-hydrate checkpoints, removal of automatic OpenCode gap kills, bounded replay production, gap repair, and liveness limits as one coherent behavior change. A red base gate blocks implementation per repository rules. This increment can improve connection stability without yet meeting fresh-screen latency targets when no valid baseline exists.
3. **Screen-first increment: workstream 1 snapshot path.** Enable only after the reconstruction gate passes for the supported terminal modes and snapshot→delta handoff. Measure actual first-screen/input latency on the incident layout. A capability or supported-state fallback must remain explicit and non-destructive.
4. **History increment: workstream 4.** Implement its chosen content model and separate history view after the baseline machinery is established. Update `docs/index.html` for the significant UI change and README usage guidance.
5. **Conversation increments: workstream 5.** Refresh correctness and visibility scheduling can proceed independently of terminal work. Paginated transcripts follow their strict page/body/merge contract and provider validation; update the UI mock and README when the new history controls land.

Use red/green/refactor for implementation, extending existing behavior tests rather than tests that assert plan text. Changes are authored in dedicated worktrees from a freshly checked green base; coordinate broad tests and use the configured backends. No PR creation or live deployment is authorized by this plan. Prepare and verify each increment, then obtain the user's explicit PR approval under repository rules.

## Acceptance criteria

Correctness and resource limits (required for the bounded recovery increment):

- Every rendered current screen is backed by a compatible applied checkpoint or validated reconstruction. Incomplete/unavailable state is labeled honestly; no healthy process is killed or replaced because replay is missing.
- Cutting the network mid-restore preserves the visible surface. A compatible partial restore requests only bytes after its parser-applied position; incompatible state takes the explicit baseline-recovery path. Retention expiry has a bounded failure outcome.
- Serialized batches, unacknowledged windows, per-connection restore state, writer queue/in-flight bytes, and metadata stay within declared limits. Large individual frames and snapshots have explicit continuation or bounded failure behavior, not silent over-budget sends.
- A slow, progressing consumer remains connected under terminal-output pressure; a dead socket still times out. Gap delivery and repair preserve per-terminal ordering and never advance checkpoints over missing parser input.
- Hidden panes start no screen/body hydration while hidden; necessary lifecycle and lightweight status subscriptions continue. A visibility change preserves terminal lifetime and other devices' geometry.
- Mixed-version tests prove new restore messages are negotiated and legacy OpenCode clients do not encounter newly introduced kill-triggering retention gaps.

Final user experience (required before calling the entire plan complete):

- On the incident layout (7 terminals + 7 agent panes), target p95 active-pane correct-screen and input-echo latency of approximately one second over repeated cold-client and reconnect trials on the incident hardware/network. Report trial count, terminal modes, retained bytes, and provider/snapshot sizes. Record main-thread long tasks and input latency during restore so "no multi-second freezes" is measured rather than inferred from payload size.
- Use 128 KiB as the initial terminal batch target, not a universal claim about total reconstruction size. Record total startup bytes separately from in-flight bytes; a full paced replay may legitimately exceed one batch, while a validated screen snapshot should avoid reading all history. Select aggregate window limits from measurements and publish them with the implementation.
- Earlier retained terminal history loads in bounded pages with a stable scroll anchor and an honest unloaded/expired boundary; live output continues independently. Returning to live shows the correct screen.
- Conversations with existing content remain usable during refresh, including same-revision reconnects and refresh failure. Recent pages and large bodies are byte-bounded; older loaded content, optimistic sends, and rollback state remain consistent.

Use a deterministic fixture matching the incident's data sizes for repeatable integration/browser tests, then a manually observed Windows Electron smoke check. Validate affected browser specs on the configured backend and ensure they actually execute; destructive restart/kill test cases belong in the disposable sandbox. Do not experiment on live user terminals to manufacture loss.

Observability: add structured events for restore start/completion/failure, baseline source, requested/applied sequence, raw versus serialized bytes, unacknowledged bytes, queue/in-flight pressure, gap reason, successful-send progress, retries, and first-screen/input timing. For conversation refreshes include trigger, execution generation, revision acceptance reason, page bytes, and visible demand. Log identifiers and measurements, not terminal or conversation contents. Keep diagnostic logging lightweight and debug perf logging off outside investigations.

## Risks and open questions

- **Screen reconstruction gate:** choose and validate the emulator/checkpoint format, state coverage, initialization for already-running streams, and maximum snapshot size. This is the main unresolved design decision; mode flags and resize nudges are not substitutes. If it cannot meet fidelity and latency requirements, revise the screen-first design before implementation of that increment.
- **History representation gate:** choose bounded normal-buffer rows or independently reconstructible pages. Define scroll anchors and retention cost; do not claim arbitrary TUI redraw history is a transcript.
- **Protocol details:** finalize parser-credit window, oversized-frame handling, atomic baseline installation, capability names, and compatibility behavior. Preserve the existing `maxReplayBytes` meaning and distinguish raw payload from wire accounting.
- **Limits and retries:** select aggregate byte/metadata limits and recovery-attempt/no-progress deadlines from fixture measurements. Define explicit behavior when output production outruns finite retention; "always finishes" is not a defensible unconditional promise.
- **Provider pagination:** provider revision semantics and paging support differ. Validate stale-page handling, large-body access, pending-send reconciliation, ownership changes, and full-snapshot callers before enabling partial responses.
- **Deployment:** server changes require the approved self-hosted launch runbook and an explicit `APPROVED` before restarting the live server. Neither this plan edit nor test-instance permission authorizes that restart.
- **Base health:** the original investigation reported a red latest full-suite result. That is historical, not a current gate result; re-check `scripts/base-gate.sh` before creating an implementation worktree. This documentation revision does not require a production restart or a broad test run.

## Appendix — incident log excerpts

```
WARN ws.terminal_stream.catastrophic_close pending_bytes=21754500 threshold=16777216
INFO ws.connection.closed reason=catastrophic_backpressure code=4008
INFO ws.connection.established
... repeating every 15-20 s
```

Client console during the loop: `xterm.js: Parsing error` entries while re-parsing replay data on each reconnect; the app remained open but could not finish restoring.
