# Terminal Replay Scroll Investigation

**Date:** 2026-03-30
**Issue:** When a tab is visited after idle time or on first hydration (page refresh), the entire conversation rapidly replays — scrolling from top to bottom over ~1-2 seconds — instead of loading silently.

## Reproduction

1. Open Freshell at `localhost:3347`
2. Navigate to a tab with substantial terminal history (e.g., "Reload Me" tab with a Claude Code session)
3. Refresh the page (Cmd+R)
4. Observe: terminal content visibly scrolls from top to bottom rapidly

## Root Cause Analysis

The issue is in the interaction between the **server-side replay frame delivery**, the **client-side write queue**, and **xterm.js auto-scroll behavior**.

### The Flow

1. **Page loads** → terminal pane mounts with empty xterm.js instance
2. **WebSocket connects** → client sends `terminal.attach` with `sinceSeq: 0` (intent: `viewport_hydrate`)
3. **Server sends all replay frames synchronously** — `broker.ts:192-195` iterates through all frames in a tight loop:
   ```
   for (const frame of replayFrames) {
     sendFrame(ws, terminalId, frame, attachRequestId)
   }
   ```
4. **Client receives frames** → each triggers `handleTerminalOutput()` → `enqueueTerminalWrite()` → the write queue
5. **Write queue processes frames** using `requestAnimationFrame` with an 8ms budget per frame (`terminal-write-queue.ts:26-27`). Within each animation frame, it flushes as many `term.write()` calls as fit within 8ms.
6. **xterm.js auto-scrolls on each write** — this is built-in xterm behavior. When data is written that moves the cursor past the visible viewport, xterm adjusts `ydisp` to follow the cursor. There is no explicit `scrollToBottom` call in the replay path — confirmed by grep.
7. **Over many animation frames** (1-2 seconds total), the user sees content appearing and the viewport rapidly tracking the cursor from top to bottom.

### Why It's Visible

- The terminal container is **immediately visible** during replay — no CSS hiding
- `isAttaching` is true during replay, which shows "Recovering terminal output..." text, but the xterm canvas is fully rendered and visible beneath it
- The write queue's rAF-based batching causes the replay to span **many visual frames**, each showing intermediate states

### Key Code Locations

| Component | File | Lines | Role |
|-----------|------|-------|------|
| Server replay delivery | `server/terminal-stream/broker.ts` | 192-195 | Sends all frames synchronously |
| Client attach entry | `src/components/TerminalView.tsx` | 1395-1462 | `attachTerminal()` sends attach request with sinceSeq=0 |
| Output frame handler | `src/components/TerminalView.tsx` | 1624-1692 | Receives frames, calls `handleTerminalOutput()` |
| Terminal output processing | `src/components/TerminalView.tsx` | 813-851 | Cleans data, calls `enqueueTerminalWrite()` |
| Write queue | `src/components/terminal/terminal-write-queue.ts` | 16-67 | rAF-based batching with 8ms budget |
| Viewport hydrate trigger | `src/components/TerminalView.tsx` | 1417, 1486 | Sets sinceSeq=0, clears viewport |

### What Doesn't Cause It

- **No explicit scrollToBottom in the replay path** — confirmed. `scrollToBottom` is only called via user actions (Cmd+End) or scheduled layout, never during replay frames.
- **Not a DOM scroll issue** — xterm viewports show `scrollHeight === clientHeight` (456px). xterm uses canvas-based virtual scrolling internally.
- **Not the layout scheduler** — `requestTerminalLayout({ scrollToBottom: true })` is never invoked during replay.

## Potential Fix Approaches

### A. Hide terminal canvas during replay (simplest)
Add CSS `visibility: hidden` or `opacity: 0` to the xterm container while `isAttaching` is true. After replay completes (when `pendingReplay` clears at line 1686-1690), remove the hiding. This is cheap and doesn't change the data flow.

**Trade-off:** Terminal appears to "pop in" rather than gradually fill. User sees a blank area during the 1-2 second replay period.

### B. Batch all replay data into a single write
Accumulate all frames while `pendingReplay` is true in `seqState`, then write them all in one `term.write()` call when replay completes. xterm would only render the final state.

**Trade-off:** Requires changes to the frame handler and seq state tracking. More complex. May cause a noticeable pause on very large buffers since xterm processes the whole batch in one go.

### C. Suppress xterm viewport following during replay
Use xterm's internal API or a wrapper to freeze the viewport position during replay writes. After replay completes, jump to bottom.

**Trade-off:** Relies on xterm internals (`_core._bufferService.buffer.ydisp`). Fragile across xterm versions.

### D. Write all replay data outside the write queue
Bypass the rAF-based write queue during replay. Write all replay data synchronously to xterm in a single call stack, which would complete before the browser gets a chance to render.

**Trade-off:** May cause a brief UI freeze on very large buffers. Simpler than B since it doesn't change the frame accumulation logic.

## Related Prior Work

- `docs/plans/2026-02-21-console-violations-four-issue-fix.md` line 387 mentions "snapshot replay scroll work" should be coalesced — this appears to be a known/planned item.
- `docs/plans/2026-02-21-terminal-stream-v2-responsiveness.md` — foundational v2 protocol with bounded streaming.
- `docs/plans/2026-02-23-attach-generation-reconnect-hydration.md` — attach request ID tagging.

## Recommendation

**Approach A (CSS hiding)** is the quickest and least risky fix. The `isAttaching` state already exists and tracks exactly the right lifecycle. Adding `visibility: hidden` to the xterm container during that state would eliminate the visual replay entirely with minimal code change.

For a more polished UX, **Approach B (batch writes)** would be better long-term since it avoids the "pop in" effect and reduces unnecessary intermediate rendering work.
