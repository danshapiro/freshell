# Freshell Complete System Characterization

**Date:** 2026-03-27
**Sources:** All 6 spikes + Chrome recon + user-reported symptoms

---

## Where We Are

We have now characterized the entire system across four dimensions: performance, correctness, consistency, and user experience. The picture is clear enough to make architectural decisions.

## The Fundamental Problem

The system has **three tiers of consistency**, and only one of them is reliable:

| Tier | What | Mechanism | Reliable? |
|------|------|-----------|-----------|
| **Strong** | Terminal I/O | Sequence numbers, gap detection, replay ring | Yes |
| **Eventual** | Sessions, settings | Periodic broadcast → full HTTP re-fetch | Yes (5-8s lag) |
| **Fire-and-forget** | Terminal metadata, layout mirror, pane state across tabs | Incremental updates, no snapshot, no reconciliation | **No** |

Everything in Tier 3 can permanently diverge. The infrastructure to fix it exists (snapshot actions, list providers) but nobody calls the reconciliation paths.

Compounding this: **cross-tab sync is non-atomic and last-write-wins with no version counter.** Tabs and panes are persisted together but hydrated separately via per-key storage events, creating windows of inconsistent state between the two. During these windows, pane content can be corrupted (Shell→Browser), layouts can break, and terminal IDs can diverge.

---

## Complete Issue Inventory

### Data Integrity / Correctness

| Issue | Mechanism | Severity |
|-------|-----------|----------|
| **Pane type corruption (Shell→Browser)** | `mergeTerminalState()` doesn't guard cross-kind transitions. Incoming pane with different `kind` silently overwrites. | Critical |
| **Terminal metadata permanently diverges** | No initial snapshot on connect. No reconciliation on reconnect. `terminalMetaListProvider` is wired but never called. | High |
| **Cross-tab sync is non-atomic** | `hydrateTabs` and `hydratePanes` dispatch separately from separate storage events. Window of inconsistent state between the two. | High |
| **Terminal ID dual source of truth** | `tab.terminalId` and `pane.content.terminalId` set by separate dispatches, can diverge. Tab-level is legacy. | Medium |
| **Cross-tab last-write-wins with no versioning** | Concurrent edits by different browser tabs lose one tab's changes. No vector clock or generation counter. | Medium |
| **Pane close in one tab can break another tab** | Cross-tab hydration of removed layouts causes unmount cascades. Can trigger "offline reconnecting" state. | Medium |
| **Layout mirror can go permanently stale** | One-way push, no retry. Lost `ui.layout.sync` = stale server state until next user interaction. | Low |
| **`terminal.runtime.updated` is dead code** | Server broadcasts it, no client handler exists. | Low |

### Performance / UX

| Issue | Mechanism | Severity |
|-------|-----------|----------|
| **Session-directory over-polling** | Indexer broadcasts every 5-8s → client re-fetches full 73KB directory each time. ~660KB/min per browser tab idle. | High |
| **Reconnect backoff overshoots** | 1s→2s→4s→8s exponential. 5s server restart → 15s+ client wait. | Medium |
| **serverInstanceId persists to disk** | Client can't detect server restart. Must discover dead terminals one-by-one via INVALID_TERMINAL_ID. | Medium |
| **Hidden tabs don't recover proactively** | Only active tab goes through reconnect recovery. Others broken until manually visited. | Medium |
| **Session repair blocks terminal.create up to 10s** | Claude sessions serialize behind lock. Multiple terminals = stacked waits. | Medium |
| **No terminal inventory in handshake** | Client discovers state reactively via errors instead of proactively. | Medium |
| **Broadcast storm during reconnect** | 10 broadcasts for 5 terminals (2 per terminal). Feeds into action multiplication. | Low |
| **Redundant sidebar session-directory fetches** | 2-4 fetches per sidebar click where 0-1 should suffice. | Low |
| **"Recovering terminal output..." on fresh terminals** | Status/isAttaching race in create→attach flow. Brief flash on localhost, visible on LAN/VPN. | Low |
| **/api/version hits GitHub uncached** | 227ms first call. Slowest request during page load. | Low |

### User-Reported Symptoms Explained

| Symptom | Root Cause |
|---------|------------|
| **Tab switch causes full conversation replay/fast-scroll** | Deferred reconnect: if a WS reconnect happened while the tab was hidden, the re-attach fires on tab switch with `viewport_hydrate` (full replay from seq 0). The cause (reconnect) is decoupled from the effect (replay on switch). |
| **Closing panes in one tab breaks another tab** | Cross-tab sync hydrates removed layouts non-atomically, causing unmount cascades and transient "offline" state in the receiving tab. |
| **Things feel flaky / get out of sync** | Tier 3 fire-and-forget state (metadata, layout mirror) has no self-healing. Cross-tab sync has no conflict resolution. Session-directory polling creates constant background churn. |

---

## What's Well-Designed (Keep These)

- **Terminal I/O path**: WS → seq validation → RAF write queue → xterm.js. Zero Redux. 8ms/frame budget. Handles heavy output smoothly.
- **Tab switch rendering**: CSS visibility toggle, no detach/reattach. Terminals stay attached in background.
- **Page refresh recovery**: Pre-queued attach messages. 400ms to fully live.
- **Session content caching** (PR #222): Stat-based LRU with request coalescing.
- **Work scheduler** (PR #224): Priority lanes prevent starvation.
- **Terminal create idempotency**: requestId-based dedup on server prevents duplicate terminals.
- **Session delta sync**: Reduces ambient broadcast churn for session data.

---

## Architectural Root Causes (The "Why" Behind the Issues)

### 1. No authoritative state snapshot on connect/reconnect
The handshake sends `ready` + settings. The client must discover everything else reactively. Terminal metadata starts empty. Terminal existence is discovered via INVALID_TERMINAL_ID errors. The server has all this data and can serve it in <1ms but doesn't.

### 2. Cross-tab sync is a bolt-on, not a first-class concern
Tabs and panes are stored in separate localStorage keys, hydrated via separate storage events, merged with kind-unaware logic. The `mergeTerminalState` function guards terminal↔terminal and agent-chat↔agent-chat but silently accepts cross-kind overwrites. There's no version counter, no conflict resolution, no atomicity.

### 3. Dual sources of truth with no reconciliation
`tab.terminalId` vs `pane.content.terminalId`. Client localStorage vs server state. Multiple persistence middlewares with different debounce timers writing overlapping state. When these diverge, there's no mechanism to detect or correct the divergence.

### 4. The server knows more than it tells
The server tracks terminal metadata, terminal lifecycle, session state, and layout mirrors. But on reconnect, it only sends settings. Everything else must be discovered by the client through a series of individual requests and error responses.

---

## What We Still Don't Know

- **Long-term stability (hours/days)**: All observations were minutes long. Memory leaks, handle leaks, gradual degradation unmeasured.
- **Scale**: All tests used 3-5 terminals, 720 sessions. 20+ terminals, 5000+ sessions untested.
- **Network conditions**: No testing on slow/lossy networks where the "Recovering" banner and reconnect timing would be more severe.
- **Multi-device sync**: `tabs.sync.push` mechanism not tested.
- **Reproducibility of pane corruption**: Mechanism identified via code analysis but not reliably reproduced in a test.
