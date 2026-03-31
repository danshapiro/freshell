# Paginated Terminal Replay & Progressive Background Hydration

## Goal

Eliminate the visible fast-scroll replay when switching to a terminal tab that hasn't been visited since page load. Tabs should appear instantly with recent content, and older history should be available on demand.

## Context

On page load, only the active tab attaches to its server-side terminal. All other tabs defer with `viewport_hydrate` intent (`TerminalView.tsx:1992-1996`). When the user first visits a deferred tab, the client sends `terminal.attach` with `sinceSeq: 0`, and the server sends the entire replay ring (up to 8 MB for Claude Code sessions). The client's write queue processes this across many animation frames, causing a visible 1-2 second fast-scroll replay through the xterm canvas.

### Key architectural facts

- Single WebSocket per browser tab; all Freshell panes share it
- Replay ring: 256 KB default, 8 MB for coding CLI terminals
- Replay ring is in-memory only (no disk persistence)
- `ReplayRing.replaySince(seq)` already supports partial replay from any sequence
- `terminal.output.gap` already signals when replay data was skipped
- `terminal.attach.ready` already reports `replayFromSeq`/`replayToSeq` bounds
- xterm.js auto-scrolls to cursor on every `write()` — this is the source of the visual jank
- xterm is append-only — you can't prepend to scrollback
- WS catastrophic backpressure kills the connection at 16 MB sustained for 10s

### Related investigation

See `docs/lab-notes/2026-03-30-terminal-replay-scroll-investigation.md` for the full root cause analysis.

## Design

### 1. Server-side truncated replay

Add an optional `maxReplayBytes` field to the `terminal.attach` Zod schema. When present, `broker.attach()` takes only the **tail** frames from the replay ring that fit within the byte budget. Frames before the budget cutoff are reported as a gap via the existing `terminal.output.gap` message (reason: `replay_window_exceeded`).

No new message types. The gap mechanism already handles this — the client just needs to recognize that an attach-time gap means "there's more history above."

### 2. Client-side "Load more history" affordance

When TerminalView receives a `terminal.output.gap` during an attach with `maxReplayBytes`, it stores the gap range. The UI shows a clickable element at the top of the terminal viewport (above the xterm canvas or as a banner). Clicking it triggers a full `viewport_hydrate` with no `maxReplayBytes` — the existing full-replay behavior, which the user has opted into.

### 3. Progressive background hydration

After the active tab's initial attach completes, a coordinator progressively hydrates background tabs:

- One tab at a time, to avoid WS backpressure
- **Neighbor-first ordering**: tabs adjacent to the active tab hydrate first, expanding outward
- Background tabs do full hydration (no `maxReplayBytes`) since they're CSS-hidden and the replay is invisible
- Each background tab attaches, receives full replay, writes to its xterm canvas (invisible), and becomes ready
- When the user switches to an already-hydrated tab, it appears instantly with full history
- If the user switches to a tab the queue hasn't reached yet, that tab does a truncated attach (with `maxReplayBytes`) for instant display, and gets the "load more" option

### 4. Queue interruption on tab switch

When the user switches to an un-hydrated tab, the progressive queue pauses, the newly active tab gets priority (truncated attach), and the queue resumes after. Already-in-progress background hydrations complete normally — they don't need to be interrupted since they're just writing to a hidden canvas.

## Verification Criteria

1. **No visible scroll replay on tab switch**: switching to any tab should show content instantly — either from progressive hydration (full history) or truncated attach (recent history)
2. **"Load more history" appears and works**: when a tab was loaded with truncated history, scrolling to the top shows the affordance. Clicking it loads the full history (visible replay is acceptable here — user opted in)
3. **Progressive hydration completes without backpressure issues**: background tabs hydrate one at a time without triggering WS catastrophic backpressure (16 MB threshold)
4. **Active tab is unaffected**: the currently active tab's terminal responsiveness is not degraded by background hydration
5. **Page refresh still works**: full page refresh hydrates active tab immediately, queues the rest progressively
6. **Non-coding-CLI terminals work correctly**: regular shell tabs (256 KB replay rings) also benefit from progressive hydration and truncated attach
7. **All existing terminal attach/detach/reconnect tests pass**

## Files involved

| Area | Files |
|------|-------|
| Protocol schema | `shared/ws-protocol.ts` |
| Server attach handler | `server/ws-handler.ts` |
| Replay ring truncation | `server/terminal-stream/broker.ts`, `server/terminal-stream/replay-ring.ts` |
| Client attach flow | `src/components/TerminalView.tsx` |
| Client seq state | `src/lib/terminal-attach-seq-state.ts` |
| Progressive hydration coordinator | New: likely `src/lib/hydration-queue.ts` or similar |
| "Load more" UI | Within `src/components/TerminalView.tsx` |
