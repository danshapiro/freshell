# Spike 1+4 Synthesis: What We Know So Far

**Date:** 2026-03-27
**Sources:** spike-1 reconnect measurement, spike-4 server audit, spike-0 chrome recon

---

## The Picture So Far

We've characterized the server and the reconnect/recovery paths. Here's what the data tells us, and — critically — what it doesn't.

---

## What We've Confirmed

### The server is fast and not the bottleneck
API endpoints respond in <5ms. Session indexer takes ~960ms on startup but doesn't block the event loop. Memory is reasonable (37MB heap for 720 sessions). The server can assemble terminal state in under 1ms. The machinery is there; it's just not being used at the right time.

### The reconnect cascade is fast when it runs — the waiting is the problem
The actual INVALID_TERMINAL_ID → create → attach cycle takes ~25ms. The time breakdown for a server restart recovery:
- **93% backoff timers** (14.7s of 15.7s in measured scenario)
- **5% waiting for first output** (~700ms)
- **0.2% the cascade itself** (~25ms)

The backoff overshoots because the exponential sequence (1s→2s→4s→8s) means a 5-second server restart causes 15+ seconds of client-side waiting. The server was ready by ~6s but the client didn't try again until 15s.

### Page refresh is already fast (~400ms)
The pre-queuing of attach messages before WS connects is smart design. No issues found.

### Normal WS drops recover cleanly (~1s)
The 1s base backoff dominates. Actual reconnection is 8ms. No errors.

---

## Bugs Found (Documented, Not Fixed)

| Bug | Severity | Source |
|-----|----------|--------|
| **Pane type corruption during reconnect** — Shell becomes Browser pane | High | Spike 1, Scenario 2 |
| **serverInstanceId persists to disk** — client can't detect server restart | High | Spike 1, Scenario 2 |
| **Hidden tabs don't recover proactively** — broken until manually switched to | Medium | Spike 1, Scenario 2 |
| **Duplicate/triplicate INVALID_TERMINAL_ID** — cross-tab sync re-dispatches 2-3x | Medium | Spike 1, Scenarios 2+4 |
| **Exponential backoff overshoots** — misses reconnect window by seconds | Medium | Spike 1, Scenario 2 |
| **"Recovering terminal output..." on fresh terminals** — recovery UI fires for new terminals | Low | Spike 1, baseline; Spike 0 |
| **replayFromSeq > replayToSeq** — misleading sequence numbers | Low | Spike 1, Scenario 1 |
| **/api/version hits GitHub on every call** — 227ms uncached network call | Low | Spike 4 |
| **Session repair wait up to 10s per terminal.create** — serializes behind lock | High (for Claude sessions) | Spike 4 |
| **Broadcast storm during reconnect** — 10 broadcasts for 5 terminals | Medium | Spike 4 |

---

## Architectural Gaps Confirmed

### 1. No state snapshot on handshake
The server sends `ready` + settings. The client has no idea what terminals exist. It discovers state reactively by trying to attach to stale IDs and getting errors back. The server has the data and can serve it in <1ms.

### 2. serverInstanceId is not per-process
It's loaded from `~/.freshell/instance-id` on disk, so it's the same across restarts. The client can't use it to distinguish "reconnect to same server" from "server restarted, everything's gone." This forces the client through the attach→INVALID→create cascade every time, even though the server could say "I'm a new instance" upfront.

### 3. Cross-tab sync amplifies every event
Every Redux action dispatches 2-3 times due to the BroadcastChannel/storage re-dispatch. This means every INVALID_TERMINAL_ID error, every broadcast from the server, every state update is multiplied. This is the mechanism behind the "action storms" we hypothesized but haven't yet measured in normal usage.

### 4. Session repair is a hidden reconnect killer
For Claude/Codex sessions, `terminal.create` can block up to 10s waiting for session repair. Multiple terminals for the same session serialize behind a lock. This is likely what caused the 35s recovery in the Chrome recon — it wasn't just backoff, it was backoff + repair waits stacking.

---

## What We Still Don't Know

These are the gaps that spikes 2 and 3 are supposed to fill:

### Normal usage degradation (Spike 2)
- How many Redux actions fire per tab switch? Is the 2-3x multiplier from cross-tab sync actually causing visible jank, or is it just wasted work that the user doesn't notice?
- Does idle state drift? Do localStorage and Redux diverge over time?
- How much HTTP traffic does the sidebar generate during normal browsing? The 73KB session-directory response is fetched on every `sessions.changed` broadcast (every ~5s from the indexer). Is the client re-fetching 73KB every 5 seconds?
- How does the system behave with 2+ browser tabs open? The cross-tab sync was designed for this, but we haven't tested it.

### Terminal rendering (Spike 3)
- Why does "Recovering terminal output..." appear on fresh terminals? This is confirmed in two independent observations but we don't know the code path that triggers it.
- Does xterm.js stutter during heavy output? We haven't tested terminal rendering performance at all.
- What happens visually when you tab-switch to a terminal that's been producing output in the background? Is there a visible repaint/flash?
- Is the scrollback buffer management causing any issues (the 64KB ring buffer losing data)?

### The "death by a thousand cuts" question
The reconnect cascade is dramatic but rare (only happens on server restart). The everyday "flaky feel" might come from:
- Action storms during normal tab switches
- Sidebar re-fetching 73KB every 5 seconds
- Terminal rendering hitches
- The "Recovering" banner flashing on every terminal interaction
- Cross-tab sync causing oscillation when multiple tabs are open

**We don't have data on any of these yet.** Spikes 1 and 4 characterized the catastrophic failure path. We haven't characterized the steady-state experience.

---

## What the Data Does NOT Tell Us

1. **Whether users primarily hit the server restart case.** If the server rarely restarts in practice, the 15s recovery might not be the main source of "flaky." The everyday experience (spikes 2+3) might matter more.

2. **Whether the pane corruption bug is a one-off or systematic.** Shell→Browser corruption was observed once. Is this a consistent bug in the reconnect path, or a rare race condition?

3. **Whether the 73KB session-directory payload is causing client-side parsing jank.** The server serves it fast, but the client parsing 73KB of JSON on every sidebar update might be noticeable.

4. **What happens with 10+ terminals.** All measurements used 3-5 terminals. At 10+, the broadcast storm, the action multiplication, and the serial session repair could compound in ways we haven't measured.

5. **Whether the cross-tab sync overhead is O(n) in the number of open browser tabs.** Two tabs might be fine; five might not.

---

## Recommended Next Step

Run spikes 2 and 3. They target the steady-state experience that we haven't characterized. The reconnect path is well-understood now — we know what's slow and why. But we don't know if fixing it would make the product feel solid, or if there's a whole other category of problems in everyday usage that would still make it feel flaky.

Specifically:
- **Spike 2** should focus on: action counts per interaction, the 73KB re-fetch frequency, multi-tab behavior, and idle drift
- **Spike 3** should focus on: the "Recovering" banner code path, tab-switch terminal rendering, and heavy output performance

After those two, we'll have characterized all three layers (reconnect, normal usage, rendering) and can make an informed decision about what to fix and in what order.
