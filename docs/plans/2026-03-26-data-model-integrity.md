# Data Model Integrity: Investigation & Improvement Plan

**Date:** 2026-03-26
**Status:** Research phase — spikes and exploration before committing to implementation

---

## What We Know

### The Symptom
Freshell feels flaky compared to a desktop terminal. Panes flash through error states on reconnect, sidebar data goes stale, server restarts cause visible cascading recovery, and cross-tab state can oscillate.

### The Root Cause: Split-Brain by Design
There is no single source of truth. The client (localStorage + Redux) owns tabs, pane layouts, and terminal bindings. The server (in-memory) owns terminal processes, scrollback buffers, and session data. Neither side has the full picture.

Reconciliation is **reactive** — the client discovers problems one at a time via INVALID_TERMINAL_ID errors — rather than **proactive** — the server telling the client what's alive on connect.

### Specific Mechanisms Contributing to Flakiness

1. **No state snapshot on reconnect.** After WebSocket `ready`, the server sends settings and that's it. The client must:
   - Re-attach each terminal individually (each can fail with INVALID_TERMINAL_ID)
   - Wait for `terminals.changed` / `sessions.changed` broadcasts
   - Poll APIs to discover what exists
   - This means every reconnect has a visible "partially stale" window

2. **Ephemeral broadcast events with no replay.** Terminal titles, metadata (cwd, git branch), session lists, and terminal directory changes are broadcast as fire-and-forget events. Miss one during a disconnect and you stay stale until the next broadcast — which may never come.

3. **Cascading error recovery.** Each pane independently discovers its terminal is gone, then goes through 3-4 round trips (attach → error → new createRequestId → create → attach). All visible to the user.

4. **Five persistence/sync mechanisms:**
   - persistMiddleware (tabs/panes → localStorage, 500ms debounce)
   - sessionActivityPersistMiddleware (activity → localStorage, 5000ms debounce)
   - browserPreferencesPersistenceMiddleware (prefs → localStorage, 500ms debounce)
   - crossTabSync (BroadcastChannel + storage events)
   - layoutMirrorMiddleware (layout → server via WS, 200ms debounce)

   Each has its own debounce, its own storage key, and its own merge strategy. They can conflict.

5. **17 Redux slices** with inconsistent persistence strategies — some persisted, some not, some debounced at different intervals, some server-derived, some client-generated.

### What the Recent Upstream PRs Contributed

- **#222 (session content caching):** Good transparent read-through cache with stat-based invalidation and request coalescing. Proves the team can do caching right. Doesn't help reconnect but is a pattern to build on.
- **#224 (search starvation):** Bumps foreground concurrency to 3 so bootstrap can't be starved by deep searches. Directly helps reconnect reliability.
- **#220 (extensions):** No data model impact.

### What Prior Plans Already Fixed

The team has been aware of symptoms and fixed many specific bugs:
- Sessions delta sync (2026-02-07): COMPLETE — reduced bandwidth from session broadcasts
- Attach generation tokens (2026-02-23): Prevents stale-message races during reconnect
- Session restore consistency (2026-02-08): Fixed 7 specific restore bugs
- Pane-first terminal ownership (2026-01-29): Correct ownership model (panes own terminals, not tabs)
- WS attach chunking (2026-02-10): Transport-layer backpressure handling

These were good fixes but they're patches on the symptom. The architectural root cause (split-brain, no snapshot, reactive recovery) remains.

---

## What We Think (Hypotheses to Validate)

### H1: A server state snapshot on reconnect would eliminate most visible flakiness
**Thesis:** If the server sends a complete terminal inventory + metadata + session summary immediately after `ready`, the client can skip the cascading discovery phase. Panes that reference dead terminals can go straight to re-creation without the attach → error → create dance.

**What we need to know:**
- How large is the snapshot for realistic terminal counts (5, 20, 50)?
- How long does assembly take?
- Does sending it in the handshake add noticeable latency?

### H2: The server can be the layout source of truth
**Thesis:** The server already receives layout mirrors via `ui.layout.sync`. If it stores and returns these, localStorage becomes a fallback cache rather than source of truth. This eliminates cross-tab merge conflicts and stale-layout problems.

**What we need to know:**
- What does the layout mirror actually contain vs. what the full pane tree needs?
- Is there a gap? How big?
- Memory/storage cost of one layout per device?
- What happens on server restart — do we need disk persistence?

### H3: The 17 slices / 5 persistence mechanisms can be dramatically simplified
**Thesis:** Many slices exist because the system grew organically. Several are redundant with server state or could be derived from a single authoritative source.

**What we need to know:**
- Which slices are purely server-derived and don't need client persistence?
- Which are legitimately client-local (UI prefs)?
- Can we get down to 2 persistence mechanisms (one for UI prefs, one for server-sync)?

### H4: Revision-gapped event replay would close the "missed broadcast" hole
**Thesis:** If broadcasts include revision numbers and the client tracks its last-seen revision, it can detect gaps and request a catch-up snapshot instead of staying stale.

**What we need to know:**
- Do the existing `terminals.changed` and `sessions.changed` revision numbers already support this?
- What's the cost of the server maintaining a short event log for catch-up?

---

## Research Spikes

### Spike 1: Measure the Reconnect Experience
**Goal:** Quantify the actual problem. How long is the gap between "ready" and "all panes live"? How often does INVALID_TERMINAL_ID trigger?

**Approach:**
- Add timing instrumentation to ws-client.ts (reconnect milestones) and TerminalView.tsx (per-pane attach timing)
- Trigger reconnects in three scenarios: normal, server restart, long disconnect
- Record actual timings
- Remove instrumentation after

**Output:** Lab note with measurements. This tells us if the problem is 100ms (not worth fixing architecturally) or 2-5s (worth it).

### Spike 2: Server Snapshot Feasibility
**Goal:** Can the server cheaply assemble a complete state snapshot?

**Approach:**
- Write a prototype `assembleStateSnapshot()` in ws-handler.ts that collects terminal inventory + metadata
- Measure assembly time and JSON size with varying terminal counts
- Test sending it in the handshake flow (don't process on client, just log receipt)

**Output:** Lab note with size/timing data. Go/no-go on the snapshot approach.

### Spike 3: Layout Mirror Gap Analysis
**Goal:** What's in the layout mirror vs. what the client needs?

**Approach:**
- Read layoutMirrorMiddleware.ts to see what's sent
- Read the server's ui.layout.sync handler to see what's stored
- Compare to the full persisted pane tree from panesSlice
- Document the gap

**Output:** Lab note answering: can the server return the client's layout, or is too much missing?

### Spike 4: State Consolidation Map
**Goal:** Catalog all 17 slices and their persistence, identify what can be cut.

**Approach:**
- For each slice: what it stores, how it's persisted, is it server-derived or client-generated
- Group into: server-authoritative, client-local, redundant, ephemeral
- Sketch a simplified state tree

**Output:** Lab note with the catalog and a proposed consolidation.

---

## Rough Phasing (Contingent on Spike Results)

**Phase 1: Quick wins — Server snapshot on reconnect**
If Spike 2 confirms feasibility: add a `state.snapshot` message to the handshake. Client uses it to pre-validate terminal IDs before attaching. Eliminates the cascading INVALID_TERMINAL_ID dance. Biggest bang for lowest risk.

**Phase 2: Proactive sync — Revision-gapped events**
Add change details to `terminals.changed` broadcasts. Client detects missed revisions and requests snapshot catch-up. Closes the "missed broadcast" hole.

**Phase 3: Consolidation — Persistence simplification**
If Spike 3 confirms the layout mirror is sufficient: make server-stored layout the source of truth. Reduce persistence to one mechanism for UI prefs. Simplify Redux to fewer slices.

**Phase 4: Polish — Invisible reconnect**
With server snapshot + proactive sync + consolidated persistence, reconnect should be invisible. This phase is about UX polish: no spinners, no flash, no jitter.

---

## Test Baseline (2026-03-26)

- 2816 passing, 9 failing, 11 skipped across 291 test files
- The 9 failures appear pre-existing on this branch
- Should investigate before starting implementation work

---

## Open Questions

1. **Server restart recovery:** If the server restarts, all in-memory state (terminals, buffers, metadata) is gone. Should the server persist layouts to disk so it can return them on restart? Or is localStorage-as-fallback acceptable for the restart case?
2. **Offline/disconnected mode:** If the server is unreachable, localStorage is the only option. Keep as degraded-mode fallback?
3. **Migration path:** Existing users have localStorage state. Need to handle the transition without losing their setup.
4. **Cross-device sync:** The `tabs.sync.push` mechanism exists for multi-device. Does server-authoritative layout replace this or work alongside it?
