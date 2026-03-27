# Freshell Stability Investigation — Spike Plan

**Date:** 2026-03-27
**Branch:** data-model-review
**Prior work:** See `docs/plans/2026-03-26-data-model-integrity.md` for the architectural review and `docs/lab-notes/2026-03-26-chrome-tooling-capabilities.md` for tooling recon.

---

## What we're trying to answer

Freshell feels flaky. We have architectural theories about why (split-brain state, no reconnect snapshot, 5 persistence mechanisms, 17 Redux slices), and we confirmed one real failure during recon (server restart reconnect took 35s and never fully recovered). But we don't have a complete picture of all the ways things break. The goal of these spikes is to build that picture across three layers before committing to fixes:

1. **Reconnect/crash recovery** — the dramatic failures
2. **Normal usage performance** — the subtle death-by-a-thousand-cuts
3. **Terminal rendering** — the xterm.js layer we haven't looked at yet

---

## Spike 1: Reconnect Cascade Measurement

### What we want to know
- Exactly how long the user sees broken/degraded UI after a reconnect, in each scenario
- The full sequence of WS messages, Redux actions, and DOM state changes during recovery
- Where time is actually spent (backoff? server processing? client rendering?)
- Whether production mode and dev mode have different failure characteristics

### Scenarios to test
1. **WS drop, server still running** — the "network hiccup" case. Terminals are alive on the server, client just needs to re-attach. This should be fast.
2. **Server restart** — everything on the server is gone. Client has stale terminalIds. This is the INVALID_TERMINAL_ID cascade.
3. **Page refresh (F5)** — localStorage has layout, server has terminals. Client needs to re-hydrate and re-attach.
4. **Long idle then interaction** — does anything go stale after 30+ minutes of no interaction?

### Approach
We can't use runtime Chrome injection for this because page reloads wipe our hooks. Need source-level instrumentation.

**Add a `ReconnectTracer` module** — a simple singleton that writes timestamped events to `window.__reconnectTrace` (an array that builds up over time). It would hook into:

- **ws-client.ts**: `disconnected`, `connecting`, `reconnect_attempt(n)`, `hello_sent`, `ready_received(serverInstanceId)`, `reconnect_failed(reason)`
- **TerminalView.tsx**: `attach_sent(terminalId)`, `attach_ready(terminalId, replayFromSeq, replayToSeq)`, `invalid_terminal_id(terminalId)`, `create_sent(requestId)`, `terminal_created(terminalId)`, `first_output(terminalId)`
- **App.tsx**: `settings_received`, `sessions_changed`, `terminals_changed`, `snapshot_received` (for when we add one)

The tracer module would be a single file (`src/lib/reconnect-tracer.ts`), imported where needed. We'd add ~1-2 lines at each hook point. Easily removable after investigation.

For each scenario, we:
1. Build production (`npm run build`) and run with `npm start` on the worktree port
2. Open in Chrome, create 3-5 terminals across 2-3 tabs
3. Install Chrome runtime dispatch interceptor for action counts
4. Trigger the scenario
5. Wait for full recovery (or confirm it doesn't recover)
6. Read `window.__reconnectTrace` via Chrome JS tool
7. Screenshot the UI at 1s, 5s, 10s, 30s intervals
8. Read server logs for the server's perspective

**Data we record per scenario:**
- Time from disconnect to ready (WS level)
- Time from ready to first terminal attached (per-pane)
- Time from first terminal attached to all panes live
- Number of INVALID_TERMINAL_ID errors
- Number of WS messages exchanged during recovery
- Number of Redux actions dispatched during recovery
- Visual state at key moments (screenshots)

### Output
Lab note with a timeline table per scenario. Something like:

```
Scenario: Server Restart (3 terminals, 2 tabs)
+0ms      server killed
+1200ms   WS disconnect detected
+2200ms   reconnect attempt 1 → failed (server not up)
+3200ms   reconnect attempt 2 → failed
...
+8000ms   server up, reconnect attempt N → WS open
+8100ms   hello sent
+8300ms   ready received (new serverInstanceId)
+8350ms   terminal.attach sent for term-1 → INVALID_TERMINAL_ID
+8400ms   terminal.attach sent for term-2 → INVALID_TERMINAL_ID
+8420ms   terminal.create sent for new term (requestId: xxx)
+8600ms   terminal.created received (terminalId: yyy)
+8650ms   terminal.attach sent for yyy
+8700ms   terminal.attach.ready received
+8800ms   first output rendered
Total recovery: 8800ms (7600ms waiting for server, 1200ms actual recovery)
```

This tells us whether the fix should focus on the backoff timing, the cascade, or both.

---

## Spike 2: Normal Usage Action Storms

### What we want to know
- How many Redux actions fire during common interactions (tab switch, sidebar click, terminal output burst)
- Whether the double-dispatch from cross-tab sync is causing real performance issues
- Whether idle time causes state drift between localStorage and Redux
- How many HTTP requests the client makes during normal browsing of the sidebar

### Approach
This is all Chrome runtime — no source changes needed. The Redux store is accessible via fiber tree in dev mode, and we can install a dispatch interceptor that survives as long as the page doesn't reload.

**Session protocol:**
1. Start dev server on worktree port
2. Open in Chrome, install dispatch interceptor and action counter
3. Create 5 terminals across 3 tabs (shell, claude, codex mix)
4. Baseline: record action count
5. **Tab switch test:** Switch between all 3 tabs, record actions per switch
6. **Sidebar test:** Click different sidebar sections (Coding Agents, Tabs, Panes, Projects), expand/collapse items, record actions and HTTP calls
7. **Terminal output test:** Run `yes | head -1000` in a shell, record action count during output burst
8. **Idle test:** Leave it alone for 10 minutes, then check action count, localStorage state, and Redux state for drift
9. **Multi-tab test:** Open Freshell in a second browser tab, make changes in one, observe the other for sync delay/conflicts

**Data we record:**
- Actions per tab switch (with types)
- Actions per sidebar interaction
- Actions during terminal output burst
- Background actions during idle (per minute)
- Any localStorage/Redux divergence
- Cross-tab sync delay

### Output
Lab note with action count tables and any anomalies found.

---

## Spike 3: Terminal Rendering Investigation

### What we want to know
- Why "Recovering terminal output..." appears on fresh terminal creation (not just reconnects)
- Whether xterm.js re-renders are causing visible jank during normal output
- Whether the scrollback buffer management causes issues (the 64KB ring buffer losing data, the scrollback setting propagation)
- How the attach/snapshot flow interacts with xterm.js rendering

### Approach
Mix of code reading and Chrome observation.

**Code review portion:**
- Read TerminalView.tsx top to bottom, focusing on the attach flow and how output gets written to xterm
- Read the `terminal-stream/broker.ts` attach method to understand the snapshot → replay → live transition
- Trace the "Recovering terminal output..." label — what condition triggers it? When does it clear?
- Understand the `seqState` tracking and how gaps are handled

**Chrome observation portion (dev mode):**
- Create a fresh terminal and observe:
  - Does "Recovering" flash briefly? How long?
  - What Redux actions fire during terminal creation?
  - Is there a visible blank/flash before the prompt appears?
- Run heavy output (`find / -type f 2>/dev/null`) and observe:
  - Does the terminal stutter?
  - Do Redux actions fire during output? (They shouldn't — output should go direct to xterm)
  - Does the action counter spike during output bursts?
- Tab away and back during heavy output:
  - Does re-attaching cause a visible flash?
  - How long does the "Recovering" state last?

### Output
Lab note documenting: the fresh terminal creation flow (why "Recovering" appears), any rendering issues found, and whether xterm.js performance is a real contributor to the flaky feel or a red herring.

---

## Spike 4: Server-Side Performance Audit

### What we want to know
- Whether the server is a bottleneck in any of the flows we're measuring
- How the server handles multiple simultaneous terminal.attach requests on reconnect
- Whether the JSONL session parsing is slow enough to affect sidebar responsiveness
- What the server logs tell us during the reconnect cascade

### Approach
Primarily server log analysis and targeted timing.

**During Spike 1 (reconnect):**
- Read server logs for the reconnect window
- Look for: slow request handling, WS message queueing, PTY spawn latency, session repair delays
- Check if `terminal.create` and `terminal.attach` are handled concurrently or sequentially

**Standalone tests:**
- Start server with 10+ existing Claude sessions in `~/.claude/projects/`
- Time the bootstrap/indexing phase
- Time a `GET /api/session-directory` request
- Time a `GET /api/terminals` request with 5, 10, 20 terminals
- Check memory usage baseline and after 30 minutes of operation

**Server log analysis:**
- The server already has structured JSON logging. Check for:
  - Request duration (`durationMs` in HTTP logs)
  - WS message processing latency (if logged)
  - Session indexer scan times
  - Terminal registry operations

### Output
Lab note with server-side timing data. Answers: is the server fast enough that client-side fixes alone will solve the problem, or are there server bottlenecks too?

---

## Spike 5: State Consolidation Map (Code Review)

### What we want to know
- Which of the 17 Redux slices are necessary and which are redundant
- Which persistence mechanisms can be eliminated
- What the minimal state tree would look like if we designed it from scratch with current knowledge

### Approach
Pure code review — no running server needed.

- Catalog each slice: what it stores, how it persists, whether it's server-derived or client-generated
- Map the data flow: for each piece of state, trace where it comes from (server push? API call? localStorage? user action?) and where it goes (rendered? persisted? sent to server?)
- Identify redundancy: state that exists in multiple places (e.g., `tab.terminalId` AND `pane.content.terminalId`)
- Identify ephemeral state masquerading as persistent (things persisted to localStorage that are immediately overwritten from the server on load)
- Propose a simplified tree grouping:
  - **Server-authoritative** (terminals, sessions, metadata) — should come from server, cached locally
  - **Client-local** (UI prefs, theme, font) — persists only in localStorage
  - **Ephemeral** (rename requests, zoom state) — never persists
  - **Derived** (sidebar items, activity indicators) — computed from other state, never stored

### Output
Lab note with the full catalog and a proposed simplification. This informs the Phase 3 implementation work.

---

## Spike 6: Server Snapshot Prototype (After 1-5)

### What we want to know
- Can the server assemble a complete state snapshot cheaply?
- How large is it for realistic configurations?
- Does it contain everything the client needs to skip the cascade?

### Approach
This is the first spike that writes real (non-instrumentation) code. Informed by all findings above.

- Add `assembleStateSnapshot()` to ws-handler.ts
- Include: terminal inventory (id, mode, status, title), terminal metadata (cwd, branch), sessions revision number, server instance ID
- Measure assembly time and serialized size
- Send after `ready` in handshake
- On client: log receipt but don't process yet — compare to what the client currently discovers piecemeal

### Output
Lab note with feasibility assessment: size, timing, completeness. Go/no-go on the snapshot approach.

---

## Execution Order and Dependencies

```
Spike 1 (reconnect measurement)  ←── requires source changes, ~2-3 hours
    ↓ informs
Spike 4 (server audit)           ←── runs alongside spike 1, reads same logs

Spike 2 (normal usage)           ←── Chrome only, no source changes, ~1-2 hours
Spike 3 (terminal rendering)     ←── Chrome + code reading, ~1-2 hours

Spike 5 (state map)              ←── pure code review, no dependencies, ~1 hour

Spike 6 (snapshot prototype)     ←── depends on findings from 1-5
```

Spikes 1+4 can run together (same test sessions, different perspectives).
Spikes 2 and 3 are independent of each other and of 1.
Spike 5 is pure code review with no dependencies.
Spike 6 waits for all others.

I'd suggest running **1+4 first** (they're the most likely to reveal critical issues), then **2+3 in parallel**, then **5**, then **6**.

---

## Tools Summary

| Tool | What it gives us | Limitations |
|------|-----------------|-------------|
| Chrome JS injection (dispatch interceptor) | Redux action flow, timing, counts | Lost on page reload. Dev mode only for store access. |
| Chrome screenshots | Visual state at any moment | Can't capture transitions/animations |
| Chrome console messages | Client-side errors and warnings | Messages are opaque "Object" in production |
| Chrome network requests | HTTP API calls, timing | No WebSocket frames |
| Source-level ReconnectTracer | Survives page reload, timestamps all reconnect events | Requires source changes (temporary) |
| Server logs (structured JSON) | Server-side processing times, error details | Need to correlate with client timestamps |
| `window.__reconnectTrace` | Full reconnect timeline accessible from Chrome | Only available after we add the tracer |
| localStorage direct read | Persisted state snapshot | Only shows what was flushed (may lag behind Redux) |

---

## What this investigation does NOT cover

To be clear about scope — these spikes are about diagnosing the existing problems, not about:
- **Feature work** — no new features during investigation
- **Network conditions** — we're not testing slow networks, high latency, or packet loss
- **Scale testing** — we're not testing with 50+ terminals or 100+ sessions (would be a separate investigation)
- **Security** — token handling, auth flows are not in scope
- **Mobile/responsive** — mobile-specific issues are not in scope

If any spike reveals a problem in these areas, we'll note it for future work.
