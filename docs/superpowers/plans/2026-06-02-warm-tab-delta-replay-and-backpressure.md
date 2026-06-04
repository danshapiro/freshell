# Warm Tab Delta Replay And Backpressure Plan

## Goal

Switching back to a tab that already has a rendered terminal screen should be fast and non-destructive. If the tab has changed while hidden, Freshell should keep the old screen visible and stream only the missing output from the last sequence the browser actually rendered.

At the same time, hidden/background catch-up should not flood the shared browser WebSocket. Freshell should keep streaming hidden panes when possible, but foreground panes must stay responsive and background replay must pause before it creates enough buffered data to trigger a backpressure reconnect.

## Plain-English Problem

The old behavior mixed up two different facts:

- "The server has output through sequence N."
- "The browser has rendered output through sequence N."

Only the second fact is safe to use for warm tab switching. If the client trusts a server cursor or a saved cursor before xterm has actually rendered that output, it can skip text. If the client distrusts a screen that is already rendered, it clears the terminal and replays old output, producing the visible flash/reload back to the same image.

The server also used to send attach replay directly during attach. A noisy old hidden pane could dump a large replay into the WebSocket path at the wrong time, increasing shared backpressure and making the active tab worse.

## Proposal

Use a rendered-surface cursor on the client:

- Track the highest terminal sequence after the xterm write callback fires.
- Treat the mounted xterm surface as trusted only after output has actually rendered.
- Persist the cursor only after render, not when output is merely received.
- On warm reveal, if the mounted surface is trusted, attach with `transport_reconnect` from the rendered high-water and do not clear the terminal.
- On explicit pane refresh, browser reload/remount, terminal identity replacement, or first hydration without a trusted surface, keep full `viewport_hydrate` from zero.
- On flaky network reconnect, do not full reset if the screen is trusted; reconnect from the rendered high-water.

Use priority-aware replay on the server:

- Add optional `priority: 'foreground' | 'background'` to `terminal.attach`.
- Default missing priority to foreground for compatibility.
- Stream attach replay through the broker flush path instead of synchronously dumping frames during attach.
- Keep replay state as a cursor on the attachment, not as a per-client replay backlog.
- Pause background replay when `ws.bufferedAmount` is above the background threshold.
- Continue foreground replay/live output unless the existing hard backpressure protections apply.

## Implemented Files

- `src/lib/terminal-attach-policy.ts`
  - Central reveal policy for trusted warm surfaces, explicit refresh, and untrusted hydrate.

- `src/components/TerminalView.tsx`
  - Adds rendered high-water tracking based on xterm write completion.
  - Uses rendered high-water for `keepalive_delta` and `transport_reconnect`.
  - Keeps full hydrate for explicit refresh and untrusted surfaces.
  - Registers trusted hidden reconnects for background catch-up without changing untrusted hidden remount behavior.
  - Sends attach priority.

- `src/lib/hydration-queue.ts`
  - Allows explicitly queued late registrations to advance after the initial queue has already started.

- `shared/ws-protocol.ts`
  - Adds optional attach priority schema.

- `server/ws-handler.ts`
  - Passes attach priority to the terminal stream broker.

- `server/terminal-stream/types.ts`
  - Adds attachment priority and replay cursor state.

- `server/terminal-stream/constants.ts`
  - Adds background buffered pause and retry constants.

- `server/terminal-stream/replay-ring.ts`
  - Adds bounded replay batch reads for cursor-based replay streaming.

- `server/terminal-stream/broker.ts`
  - Streams attach replay through scheduled flushes.
  - Pauses background replay under buffered socket pressure.
  - Preserves foreground delivery under background pressure.

## Key Behavior Rules

- Warm tab reveal with a trusted rendered screen:
  - Do not clear xterm.
  - Attach with `transport_reconnect`.
  - Use `sinceSeq` equal to the rendered high-water.
  - Priority is foreground.

- Hidden background catch-up with a trusted rendered screen:
  - Attach with `keepalive_delta`.
  - Use `sinceSeq` equal to the rendered high-water.
  - Priority is background.

- Hidden/untrusted reveal:
  - Attach with `viewport_hydrate`.
  - Use `sinceSeq: 0`.
  - Clear only when doing foreground full hydrate.

- Explicit pane refresh:
  - Always full hydrate.
  - Use `sinceSeq: 0`.
  - Clear/replay by user request.

- Browser reload or React remount:
  - Saved cursor alone is not trusted.
  - Full hydrate is allowed because the mounted rendered surface is gone.

- Flaky internet reconnect:
  - If the rendered surface is trusted, reconnect from rendered high-water.
  - If not trusted, reconnect from zero.

## Validation Findings

- Ordinary hidden-but-mounted xterm buffers survive tab switches, so warm reveal can preserve the image.
- Persisted cursor or `terminal.attach.ready.headSeq` does not prove the browser rendered that sequence.
- The cursor must advance only after xterm write completion.
- A hidden reconnect can happen while lifecycle state is not cleanly `live`; the trusted rendered surface must be considered directly.
- Attach replay should not be stored as a per-client frame backlog. A replay cursor is safer under long/noisy sessions.
- Background priority must pause based on shared socket buffered amount, while foreground delivery still drains.
- Late trusted hidden reconnects need an explicit queue path; ordinary untrusted hidden remounts should still wait for reveal unless they were already queued before the active tab became ready.

## Verification Run

These commands passed in `.worktrees/warm-tab-delta-replay`:

```bash
npm run test:vitest -- test/unit/client/components/TerminalView.lifecycle.test.tsx --run
npm run test:vitest -- test/unit/client/lib/terminal-attach-policy.test.ts --run
npm run test:vitest -- test/unit/server/terminal-stream/replay-ring.test.ts --run
npm run test:vitest -- test/unit/server/ws-handler-backpressure.test.ts --run
npm run test:vitest -- test/e2e/terminal-create-attach-ordering.test.tsx --run
npm run test:vitest -- test/e2e/terminal-settings-remount-scrollback.test.tsx --run
npm run test:vitest -- test/e2e/codex-refresh-rehydrate-flow.test.tsx --run
npm run typecheck
npm run build
```

Repo baseline note: the pre-worktree `npm run check` baseline was already red with unrelated Sidebar and PaneContainer failures. Those failures were not introduced by this work.

## Remaining Recommended Verification

- Run the coordinated full check after the unrelated baseline failures are resolved or accepted as known:

```bash
FRESHELL_TEST_SUMMARY="warm tab delta replay and backpressure" npm run check
```

- Run a private-server manual repro with a long noisy coding-agent tab:
  - Start a worktree server on a unique port.
  - Create a long-output terminal/coding-agent session.
  - Switch to another tab while output continues.
  - Switch back.
  - Expected: existing terminal image stays visible; no clear-and-replay flash; catch-up starts from rendered high-water.
