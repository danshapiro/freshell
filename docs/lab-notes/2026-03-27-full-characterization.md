# Freshell Stability: Full System Characterization

**Date:** 2026-03-27
**Sources:** Spikes 0 (Chrome recon), 1 (reconnect measurement), 2 (action storms), 3 (terminal rendering), 4 (server audit)

---

## Executive Summary

We investigated three layers — reconnect/recovery, normal usage, and terminal rendering — to understand why Freshell feels flaky. The picture that emerges is:

**The terminal rendering layer is solid.** Output bypasses Redux, goes direct to xterm.js via a well-designed RAF-batched write queue. Tab switches don't detach/reattach. Heavy output is smooth. This layer is not contributing to flakiness.

**The server is fast.** All API endpoints <5ms. Event loop stays responsive. Session indexer is efficient. The server is not a bottleneck for any measured operation.

**The flakiness has two distinct sources operating at different timescales:**

1. **Steady-state: session-directory over-polling.** The session indexer broadcasts `sessions_changed` every 5-8 seconds. Every browser tab re-fetches the full `/api/session-directory` (73KB with ~720 sessions) on each broadcast. That's ~660KB/min of redundant traffic per tab, 9 HTTP requests/min during complete idle. This is the constant background hum of unnecessary work.

2. **Catastrophic: reconnect cascade after server restart.** Exponential backoff overshoots (15s wait for a 5s restart), no server restart detection (serverInstanceId persists to disk), pane type corruption (Shell→Browser), hidden tabs left broken until visited, session repair blocking up to 10s per terminal. This is the dramatic failure that makes everything feel unreliable after any disruption.

There is also one cosmetic issue that bridges both: **"Recovering terminal output..." flashes on every fresh terminal creation** due to a status/isAttaching race in the create→attach flow. It's brief on localhost but visible on LAN/VPN.

---

## Findings by Layer

### Layer 1: Terminal Rendering (Spike 3) — HEALTHY

| Aspect | Status | Details |
|--------|--------|---------|
| Output path | Clean | WS → seq validation → RAF write queue → xterm.write(). Zero Redux for shell output. |
| Heavy output | Smooth | `find / \| head -50000` rendered without stutter. 8ms/frame write budget works. |
| Tab switch rendering | Correct | CSS visibility toggle, no detach/reattach. No flash. |
| Scrollback/replay | Working as designed | 256KB replay ring evicts oldest frames. Gap messages inform client. 8MB floor for coding CLIs. |
| Queue backpressure | Handled | Transient queue buildup during heavy output, zero data drops. |

**One bug found:** "Recovering terminal output..." banner on fresh terminals. Root cause traced to `TerminalView.tsx:1995` — the condition `status !== 'creating' && isAttaching` matches during the window between `terminal.created` (sets status='running') and `terminal.attach.ready` (clears isAttaching). One WS round-trip of visible recovery UI for brand-new terminals.

### Layer 2: Normal Usage (Spike 2) — ONE MAJOR ISSUE

| Aspect | Status | Details |
|--------|--------|---------|
| Tab switch actions | Fine | 2-4 actions per switch. No storm. |
| Terminal output actions | Excellent | Zero Redux actions for shell output. |
| Cross-tab sync | Moderate overhead | +4 actions on structural changes. Doesn't amplify idle polling. |
| localStorage drift | None | Redux and localStorage stay consistent. |
| **Session-directory polling** | **Problem** | **9 fetches/min per browser tab during idle. ~660KB/min on real instance.** |
| Sidebar fetches | Redundant | 2-4 session-directory fetches per sidebar click where 0-1 should suffice. |

**The session-directory polling is the single biggest steady-state issue.** Every `sessions_changed` broadcast (every 5-8s from the indexer) triggers a full re-fetch. With 2 browser tabs, that's ~16 requests/min. With 720 sessions at 73KB per response, this is significant wasted bandwidth and client-side JSON parsing.

### Layer 3: Server (Spike 4) — FAST, BUT MISSING KEY HANDSHAKE DATA

| Aspect | Status | Details |
|--------|--------|---------|
| API endpoints | <5ms all | settings <1ms, terminals <1ms, sessions <3ms, bootstrap ~9ms |
| /api/version | Slow (227ms) | Hits GitHub API on every call. No server-side cache. |
| Session indexer | 960ms startup | 728 files, consistent across runs. Event loop stays responsive. |
| Memory | Reasonable | 37MB heap for 720 sessions. |
| WS message handling | Concurrent | `void this.onMessage()` discards promise. Parallel for different terminals. |
| Session repair | **Bottleneck** | Up to 10s wait per terminal.create for Claude sessions. Serializes behind lock. |
| Handshake snapshot | **Missing** | No terminal inventory in `ready` message. Client discovers state reactively. |
| Broadcast storm | During reconnect | 10 broadcasts for 5 terminals (2 per terminal: changed + runtime). |

### Layer 4: Reconnect/Recovery (Spike 1) — MULTIPLE ISSUES

| Scenario | Recovery Time | Issues Found |
|----------|--------------|-------------|
| WS drop (server alive) | ~1s | Clean. 1s backoff dominates, 8ms actual reconnect. |
| Server restart | ~16s | Backoff overshoot, no restart detection, pane corruption, hidden tabs broken. |
| Page refresh | ~400ms | Excellent. Pre-queued attach messages. No issues. |
| Idle (external restart) | ~4.6s | Triple INVALID_TERMINAL_ID dispatch. Otherwise similar to restart. |

---

## Complete Bug/Issue Inventory

### High Severity

| Issue | Source | Impact |
|-------|--------|--------|
| Session-directory over-polling | Spike 2 | ~660KB/min wasted per browser tab. Constant unnecessary work. |
| Pane type corruption on reconnect | Spike 1 | Shell pane becomes Browser pane. User loses their terminal. |
| serverInstanceId persists to disk | Spike 1 | Client can't detect server restart. Must discover dead terminals one-by-one. |
| Session repair blocks terminal.create up to 10s | Spike 4 | Multiple terminals for same session serialize. Likely cause of 35s recovery in spike 0. |
| No terminal inventory in handshake | Spike 4 | Client discovers state reactively via errors instead of proactively. |

### Medium Severity

| Issue | Source | Impact |
|-------|--------|--------|
| Exponential backoff overshoots | Spike 1 | 15s wait for a 5s restart. Misses reconnect window by seconds. |
| Hidden tabs don't recover proactively | Spike 1 | Broken state on every tab switch after server restart. |
| Duplicate/triplicate INVALID_TERMINAL_ID | Spike 1 | Cross-tab sync amplifies error events 2-3x. Variable count suggests race. |
| Broadcast storm during reconnect | Spike 4 | 10 broadcasts for 5 terminals. Feeds into Redux action multiplication. |
| Redundant sidebar session-directory fetches | Spike 2 | 2-4 fetches per sidebar click where 0-1 should suffice. |

### Low Severity

| Issue | Source | Impact |
|-------|--------|--------|
| "Recovering terminal output..." on fresh terminals | Spike 1, 3 | Cosmetic flash. Brief on localhost, visible on LAN/VPN. Root cause fully traced. |
| /api/version hits GitHub on every call | Spike 4 | 227ms uncached. Slowest request during page load. |
| replayFromSeq > replayToSeq | Spike 1 | Misleading sequence numbers. Off-by-one or reporting issue. |
| tabRegistry/setTabRegistrySyncError fires constantly | Spike 2 | Transient error set/cleared during normal navigation. Noise. |

---

## What We Didn't Investigate

- **Scale beyond 5 terminals / 720 sessions.** All measurements used small terminal counts. Behavior at 20+ terminals or 5000+ sessions is unknown.
- **Network conditions.** No testing on slow/lossy networks. The "Recovering" banner and reconnect timing would be more severe over WAN.
- **Mobile/responsive.** Not in scope.
- **Long-term stability (hours/days).** Idle observation was only 3-10 minutes. Memory leaks, handle leaks, or gradual degradation over hours are unmeasured.
- **Multi-device sync (tabs.sync.push).** Not tested.

---

## What This Tells Us About the Architecture

### What's well-designed
- **Terminal output path.** WS → seq validation → RAF write queue → xterm.js. No Redux involvement. This is the right architecture for high-throughput data.
- **Tab switch implementation.** CSS visibility toggle, no detach/reattach. Terminals stay attached in background. Smart.
- **Page refresh recovery.** Pre-queuing attach messages before WS connects. 400ms to fully live.
- **Session content caching (PR #222).** Stat-based LRU cache with request coalescing. Good pattern.
- **Work scheduler (PR #224).** Priority lanes prevent starvation. Bootstrap always gets a slot.

### What's not well-designed
- **Session-directory polling model.** Broadcast fires every 5-8s → client does full re-fetch every time. No delta mechanism, no content hashing, no debouncing. The delta sync system (PR #222) exists for session snapshots but doesn't help for the directory re-fetch pattern.
- **Reconnect recovery.** Reactive (discover errors one at a time) instead of proactive (server tells client what exists). The serverInstanceId-on-disk decision means the client can never skip the cascade.
- **Cross-tab sync amplification.** Every Redux action dispatches through BroadcastChannel to other tabs. Error events, broadcast handlers, state updates — all multiplied. Not catastrophic but adds noise and wasted work.

### The fundamental tension
The system was designed for **eventual consistency** — the server broadcasts changes, the client reacts. This works for a collaborative document editor where changes trickle in. It does not work well for a terminal multiplexer where the user expects instant, deterministic state. Terminals either exist or they don't. The client shouldn't have to poll to find out.

---

## Recommended Next Steps

This is the characterization complete. All four spikes are done. The full picture:

1. **Steady-state problem:** Session-directory over-polling (~660KB/min per tab)
2. **Catastrophic problem:** Reconnect cascade after server restart (15-35s recovery, pane corruption, hidden tabs broken)
3. **Cosmetic problem:** "Recovering" banner on fresh terminals

The characterization is clear enough to move to prioritized fix planning. But that's your call, Matt — I wanted to lay out the complete picture first so we're making decisions based on full data rather than partial observations.
