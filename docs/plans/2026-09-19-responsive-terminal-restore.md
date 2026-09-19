# Reliable, Responsive Pane Restore — Diagnosis and Plan

Status: proposed (diagnosis complete; no code changes yet)
Date: 2026-09-19
Incident: live self-hosted server on garageserver (`192.168.3.150:3001`), Electron client on DANDESKTOP
Related: `docs/plans/2026-03-30-paginated-terminal-replay.md`, `docs/plans/2026-07-24-rust-attach-viewport.md` (TERM-07 open items)

## Summary

When a client connects, the server resends each terminal pane's entire retained past output in one burst. With the user's layout that is roughly 21 MB across seven terminal panes. The client cannot process it fast enough, the server's "client is too slow" guard fires before its own graceful spill mechanism can run, and the connection is disconnected. The client reconnects and starts over from zero because a restore that never completed leaves no record of how far it got. That loop repeats indefinitely, so panes never finish coming back — including the terminal pane for `opencode --session ses_f5434…`.

The fix is five workstreams: restore the current screen first and history on demand, make restores resume instead of restarting, spill old output instead of hanging up, provide a real "load earlier history" control, and stop covering panes that already have content (the "Refreshing conversation…" cover).

## What the user experienced

- The pane for `opencode --session ses_f5434cdf6ffeZYNTjLVLre77W8` never finished resuming; it appeared hung behind a "Refreshing conversation…" cover.
- Restarting the Electron client did not help: the reconnect/disconnect loop resumed immediately.
- Other panes in the same app showed similar restoring/refreshing symptoms because they share one connection.

## Diagnosis

### The failure loop

1. On connect, the client attaches to every pane in its layout (7 terminal panes plus 7 agent-conversation panes in the incident layout).
2. For each terminal attach, the server resends the terminal's full retained past output ("replay"). Measured ~3 MB per pane.
3. The client asks for only the newest 128 KB per normal terminal pane. The server ignores that request: the field (`maxReplayBytes`) exists in the protocol but no server code reads it. Verified by attaching with a 128 KB request and still receiving ~3 MB.
4. Full-screen terminal apps (opencode) request no limit at all, by design.
5. The connection therefore queues ~21 MB at once. The client's renderer cannot parse that quickly (color-heavy full-screen redraws, plus repeated 6 MB agent-conversation snapshots), so the queue stays above the server's 16 MB threshold for the required 10 seconds.
6. The server disconnects the connection with code 4008 ("catastrophic backpressure"). The client reconnects and repeats from step 1. Progress is discarded each cycle, so there is no convergence.
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
- Legacy behavior to restore: `server/terminal-stream/broker.ts:454-481` at commit `a7d36d5f8^` (budget walk newest-to-oldest, `replay_budget_exceeded` gap); the Rust port leaves `maxReplayBytes` unimplemented per the TERM-07 note in `docs/plans/2026-07-24-rust-attach-viewport.md`.

### Why it cannot recover

Three design choices combine into a permanent loop:

1. Every connect resends everything (no budget honored).
2. Every failure forgets progress (a partial restore leaves no usable position, so the retry is a full replay).
3. Every slow client gets disconnected (the kill fires before the spill).

Fixing only the ignored budget shrinks the burst but leaves (2) and (3) able to reproduce the loop under other load.

### Not the cause

- The OpenCode session is healthy: idle, last turn completed 17:21 UTC, no error state.
- The terminal programs are not flooding: their own writes were ~0 bytes during the incident. The traffic is entirely resent history.
- The server is up and serving; this is not a crash or restart problem.
- The client/server build mismatch is real but handled correctly (the one-shot reload guard suppresses further reloads). It is unrelated.

### How to reproduce

From a machine that can reach the server, open a WebSocket to `/ws`, complete the `hello` handshake (protocol version 10, token), and send `terminal.attach` for a terminal with a full scrollback, with and without `maxReplayBytes`. Count the payload bytes of the `terminal.output.batch` messages for five seconds:

- Without the field: ~3 MB arrives in under a second, then silence.
- With `maxReplayBytes: 131072`: the same ~3 MB arrives — proof the server ignores the request.

To reproduce the user-visible loop, open the app with several full-scrollback terminal panes and watch the server log for `ws.terminal_stream.catastrophic_close` followed by `ws.connection.closed reason=catastrophic_backpressure code=4008`, then a fresh `ws.connection.established` — repeating.

## Goals

What the person at the keyboard should get:

1. Opening Freshell with many busy panes: the pane they are looking at is alive in about a second and accepts typing immediately.
2. Panes that are not visible cost almost nothing.
3. Scrolling up loads older output in small pieces without stalling anything; there is an honest "load earlier" control when more exists.
4. A dropped connection keeps what was already shown; on reconnect only the missing part is fetched, and the restore always finishes.
5. No pane is covered by a full-screen "refreshing" curtain while it has content to show.

## Plan

### Workstream 1 — Send the current screen first, history later (server; client)

The client already asks for a small slice; make the server honor it, for every pane type.

Implementation notes:

- Parse `max_replay_bytes` in `handle_attach` and thread it through `attach_with_geometry` / `attach_to_shared` (`crates/freshell-ws/src/terminal.rs:6916`, `crates/freshell-terminal/src/registry.rs:1558`).
- Keep the newest frames within the budget, measured the way the wire measures them (serialized payload bytes, per the legacy broker at `broker.ts:454-481`), walking newest-to-oldest and stopping at the first frame that does not fit.
- Start the kept slice at a safe boundary (do not begin mid-escape-sequence), and let the existing modes preamble (surface reset) precede the replay as it does today.
- Report the dropped span with the existing gap message and `replay_budget_exceeded`; the client already turns that into a "load more history" affordance (`TerminalView.tsx:4335`). Set `replayFromSeq` / `replayToSeq` to the kept span.
- Add a per-connection total startup budget as a backstop so a workspace with many panes stays bounded regardless of tab count.
- Include opencode: have the client request a budget for opencode panes too, or apply a server-side default cap. The newest output of these full-screen apps contains complete repaints of the current screen, so a small slice reconstructs it. If a pane has been quiet (no repaint in the newest slice), trigger one repaint (a resize nudge) before capturing the replay. Verify with a screen-reconstruction test on the real TUIs before turning off the exemption.
- Client-side: hidden panes should request little or nothing until revealed; on reveal, top up from the pane's position.

Tests:

- Registry unit tests: newest-first budget walk; exact boundary behavior; gap range for the dropped span; empty/small budgets.
- WS integration: attach with a budget returns payload ≤ budget plus the gap frame; `replayFromSeq`/`replayToSeq` match the kept span.
- A screen-reconstruction test for opencode (newest slice + preamble yields the same visible screen as a full replay).

### Workstream 2 — Resume instead of restarting (client + server)

Implementation notes:

- The client currently resets its output position to zero on every viewport hydrate (`TerminalView.tsx:3098`), so a hydrate interrupted by a disconnect restarts from zero. Record the applied position per pane even when a hydrate is incomplete, and on retry ask only for what comes after it (the server already honors `since_seq` at `registry.rs:1616-1621`).
- Keep a full replay only when the terminal surface itself was recreated (page load or user reset).
- The server must tell the client when the requested position is older than the retained window: emit the existing gap message for that span (today only queue overflow emits gaps, `connection_writer.rs:490-498`). Without this, a resumed attach could silently miss output.
- Bound retries and surface an explicit "couldn't finish loading — retry" state instead of looping silently.

Tests:

- Client unit: an interrupted hydrate retries with the applied position, not zero; a recreated surface still full-replays.
- Integration: drop the connection mid-replay, reconnect, assert the second attach requests only the remainder and the pane converges to the same content.
- Integration: request a position older than the retained window and assert a gap is reported.

### Workstream 3 — Spill old output instead of hanging up (server)

Implementation notes:

- Today the queue spills at 32 MB but the connection is killed at 16 MB, so the graceful path never runs (`output_queue.rs:22`, `backpressure.rs:68-75`). Make the spill threshold lower than the disconnect threshold, or exclude resent history from the disconnect measure.
- Disconnect only when the connection makes no drain progress at all for a long window — slow processing is not a dead socket.
- Keep the existing spill behavior (drop oldest unsent output, emit a gap) as the primary response to overload.

Tests:

- A deliberately slow consumer stays connected and receives gaps instead of a close.
- A genuinely dead consumer is still closed.
- Queue memory stays bounded under a replay burst larger than both thresholds.

### Workstream 4 — Load earlier history on demand (client + server)

Implementation notes:

- The "load more history" affordance and gap state already exist; today the only fill path is a full re-attach. Add a bounded "fetch older output before position X" request (design decision: a new client message versus extending the attach path).
- Fetch in fixed-size chunks on a low-priority lane; preserve scroll position while prepending; show an honest boundary line while earlier output is not loaded.
- Only the requesting pane is affected; other panes never fetch.

Tests:

- E2E: scroll to the top of a long terminal, load a chunk, repeat — history walks backwards without stalls, and the boundary is visible until fully loaded.

### Workstream 5 — Stop covering panes that have content (client + server)

Implementation notes:

- Replace the full-pane overlay in `FreshAgentView.tsx:3360`/`:3742` with an in-place refresh: render the last known conversation immediately and show a small status line while updating.
- Paginate the conversation snapshot endpoint (`/api/fresh-agent/threads/...`, currently 6 MB): recent turns first, older turns on demand, with a cursor.
- Hidden panes do not poll or fetch at all; on reveal, fetch the recent slice only.

Tests:

- Client: a revealed pane shows its last known content instantly while refreshing (no full-pane cover).
- Server: snapshot payloads are bounded and support fetching older turns.
- Client: hidden panes issue no requests.

## Sequencing

1. Workstreams 1 and 2 together — the correctness floor: bounded restores that always finish.
2. Workstream 3 — small server change that removes the last way to get stuck.
3. Workstream 4 — the history-loading experience.
4. Workstream 5 — the agent-pane experience.

## Acceptance criteria

End-user:

- With the incident layout (7 terminals + 7 agent panes), the active pane is interactive in about a second; total startup traffic is a few hundred KB per pane; no disconnects; no multi-second freezes.
- Cutting the network mid-restore: the UI keeps showing what it had, and the restore completes after reconnect without resending everything.
- Scrolling to the top of a long terminal loads chunks without stalling and shows an honest boundary.
- No pane is ever covered by a full-screen refreshing curtain while it has content.

Automated:

- Per-pane attach payloads stay within the requested budget; a budget gap is reported.
- A slow consumer receives gaps, never a disconnect; a dead consumer is still disconnected.
- A retry after a mid-restore drop requests only the remainder.
- Hidden panes neither attach nor poll.

## Risks and open questions

- Alt-screen reconstruction: a small slice of a full-screen app must reliably rebuild the visible screen. Validate on opencode, Codex, and Claude TUIs; keep the repaint nudge as the fallback if a quiet pane's newest slice does not cover the screen.
- Budget defaults: 128 KB for visible panes; decide the hidden-pane and per-connection totals.
- History fetch transport: new WebSocket message versus an HTTP endpoint; pick during implementation.
- Retry ceiling: how many attempts before showing the explicit failure state.
- Deployment: server-side changes require a restart of the live 3.150 server, which needs the user's explicit approval.
- Base health: the coordinator's latest full-suite run is red for reasons unrelated to this document; re-check the base before implementing.

## Appendix — incident log excerpts

```
WARN ws.terminal_stream.catastrophic_close pending_bytes=21754500 threshold=16777216
INFO ws.connection.closed reason=catastrophic_backpressure code=4008
INFO ws.connection.established
... repeating every 15-20 s
```

Client console during the loop: `xterm.js: Parsing error` entries while re-parsing replay data on each reconnect; the app remained connected but could not finish restoring.
