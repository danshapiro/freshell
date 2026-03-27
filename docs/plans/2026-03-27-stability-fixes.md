# Freshell Stability Fixes — Implementation Plan

**Date:** 2026-03-27
**Status:** Ready for implementation
**Context:** Based on 6 investigation spikes. Full findings at `docs/lab-notes/2026-03-27-complete-characterization.md`.

---

## How to Use This Plan

Each issue below is a self-contained work item. An agent should:
1. Read the issue description and context files
2. Work in a dedicated worktree (branch off `data-model-review`)
3. Implement with TDD — write a failing test, make it pass, refactor
4. Build and run a server on a unique port to verify the fix works in a real browser
5. Use Chrome automation to confirm the user-visible behavior is fixed
6. Write findings/decisions in the lab note if anything surprising comes up
7. Commit frequently, with clear messages

Issues are ordered by independence (can be done without touching other fixes) and impact. Early issues are safe to parallelize. Later issues depend on earlier ones or touch overlapping code.

---

## Issue 1: Cache /api/version GitHub response

**What:** `/api/version` calls `https://api.github.com/repos/danshapiro/freshell/releases/latest` on every request. First call is 227ms, subsequent 44ms. No server-side cache.

**Why it matters:** It's the slowest request during page load. A 5-15 minute TTL cache is trivial and eliminates 227ms from every page load.

**Where to look:** `server/updater/version-checker.ts:76` — the `checkForUpdate()` function. Also `server/platform-router.ts:41` where the endpoint is defined.

**How to verify:** Start the server, call `GET /api/version` twice in quick succession with curl. First call should hit GitHub. Second call within TTL should return cached result in <1ms. Check server logs confirm no second GitHub fetch.

**Constraints:** Don't change the response format. Just add an in-memory cache with a TTL.

---

## Issue 2: Fix "Recovering terminal output..." on fresh terminals

**What:** The "Recovering terminal output..." banner briefly flashes on every new terminal creation, not just reconnects.

**Why it matters:** It makes every terminal creation look like something went wrong. On LAN/VPN it's clearly visible (100-500ms).

**Where to look:** `src/components/TerminalView.tsx:1995` — the banner render condition. The root cause is that `status` transitions to `'running'` before the attach completes, making `status !== 'creating' && isAttaching` true during the create→attach window. Spike 3 lab note (`docs/lab-notes/2026-03-27-spike-3-terminal-rendering.md`) has the full code path trace with line numbers.

**How to verify:** Build, run server, open in Chrome. Create a new shell terminal. The "Recovering" banner should NOT appear. Reconnect scenarios (WS drop, server restart) SHOULD still show the banner — don't break that.

**Constraints:** The fix should distinguish "first attach of a brand-new terminal" from "re-attach after disconnect." The intent parameter (`viewport_hydrate` vs `transport_reconnect`) or a "has this terminal ever been live" flag could work. Don't overcomplicate — this is a one-line-condition fix.

---

## Issue 3: Reduce session-directory over-polling

**What:** The session indexer broadcasts `sessions_changed` every 5-8 seconds. Every browser tab re-fetches the full `/api/session-directory` (~73KB with 720 sessions) on each broadcast. That's ~660KB/min per tab during complete idle.

**Why it matters:** It's the single biggest source of steady-state waste. Constant unnecessary network traffic and client-side JSON parsing. Scales linearly with browser tab count.

**Where to look:**
- Server: the indexer's broadcast frequency — find where `sessions_changed` is emitted and why it fires every 5-8s even when nothing changed
- Client: `sessionsThunks.ts:372` — `queueActiveSessionWindowRefresh()` which triggers the re-fetch. Also the handler in `App.tsx:727-728`
- The existing delta sync system (`sessions-sync/`) — it may already have the right primitives

**Possible approaches (pick the best one, don't overbuild):**
- Server sends a content hash with `sessions_changed`; client skips fetch if hash matches
- Server doesn't broadcast `sessions_changed` if nothing actually changed since last broadcast
- Client debounces more aggressively (e.g., once per 30s instead of every broadcast)
- Use the revision number that's already in the message — client only re-fetches if revision increased

**How to verify:** Start server, open in Chrome. Install a fetch interceptor (`window.fetch` wrapper) or check network tab. During 60 seconds of idle, count `/api/session-directory` requests. Should be dramatically fewer than the current ~9/min. Verify sidebar still updates when actual session changes happen (create a Claude session in another terminal, confirm it appears in sidebar).

**Constraints:** Don't break the sidebar. Sessions must still show up promptly when they actually change. The goal is to eliminate redundant fetches, not delay real updates.

---

## Issue 4: Add per-process boot ID to server `ready` message

**What:** `serverInstanceId` is loaded from `~/.freshell/instance-id` on disk, so it's the same across server restarts. The client can't distinguish "reconnect to same server" from "server restarted, all terminals gone."

**Why it matters:** Without this, the client must discover dead terminals one-by-one via INVALID_TERMINAL_ID errors. With a per-process ID, the client knows immediately that all terminals are gone and can skip the attach→error→create cascade.

**Where to look:**
- Server: where `serverInstanceId` is generated/loaded. It's in the server startup code and sent in the `ready` message at `ws-handler.ts:1071-1076`
- Client: `ws-client.ts` ready handler and `App.tsx` ready handler where `serverInstanceId` is captured and compared

**How to verify:** Start server, connect client, note the serverInstanceId. Kill server, restart. Connect again. The `ready` message should have a DIFFERENT serverInstanceId. The client should detect the change. (The client-side behavior change — what to DO with this detection — is Issue 7. This issue just makes the detection possible.)

**Constraints:** Don't break any existing behavior that depends on serverInstanceId being stable. Check if anything uses it for persistent identity (device tracking, tab sync). If so, keep the persistent ID for those uses and add a separate `bootId` or `processId` field to the `ready` message.

---

## Issue 5: Guard cross-tab sync against cross-kind pane overwrites

**What:** `mergeTerminalState()` in `panesSlice.ts` guards terminal↔terminal and agent-chat↔agent-chat transitions but silently allows cross-kind overwrites (e.g., terminal→browser). This can corrupt a Shell pane into a Browser pane during cross-tab sync.

**Why it matters:** This is the most severe data integrity bug found. A user's terminal pane becomes a "Enter a URL to browse" pane during reconnect recovery.

**Where to look:** `src/store/panesSlice.ts:405-485` — the `mergeTerminalState()` function. Also `hydratePanes` reducer. Spike 5 lab note (`docs/lab-notes/2026-03-27-spike-5-data-flow-tracing.md`) has the full mechanism trace.

**How to verify:** Write a unit test that calls `mergeTerminalState()` with local `kind: 'terminal'` and incoming `kind: 'browser'` — it should preserve the local content, not overwrite. Also test the reverse. Then test that same-kind merges (terminal↔terminal) still work as before.

**Constraints:** Think carefully about what the RIGHT behavior is for cross-kind transitions. Options: (a) always prefer local, (b) always prefer the newer one (needs a timestamp), (c) prefer whichever has a live terminal. The simplest correct answer is probably: if the local pane has an active terminal (terminalId is set and status is running), never overwrite it with a different kind.

---

## Issue 6: Make cross-tab hydration atomic for tabs + panes

**What:** `persistMiddleware` writes tabs and panes in one flush, but cross-tab sync processes them as separate storage events. Between the two hydrations, the receiving tab has inconsistent state (tab exists but layout is gone, or vice versa). This can cause unmount cascades and "offline reconnecting" in other tabs.

**Why it matters:** Closing a pane in one browser tab can crash another tab's rendering. The spike 5 lab note documents the mechanism.

**Where to look:**
- `src/store/persistMiddleware.ts` — the flush logic that writes both keys
- `src/store/crossTabSync.ts` — how storage events are processed per-key
- The `BroadcastChannel` path vs the `StorageEvent` path

**Possible approaches:**
- Bundle tabs + panes into a single localStorage key (simplest, but migration needed)
- Use BroadcastChannel to send both as one message, and only hydrate when both arrive
- Add a sequence number to both writes; receiving tab waits for matching sequence before hydrating

**How to verify:** Open Freshell in two browser tabs. In tab 1, close a pane or tab that tab 2 is also showing. Tab 2 should NOT flash "offline" or break its layout. It should smoothly remove the closed element.

**Constraints:** Don't break the existing cross-tab sync for normal operations (tab creation, rename, etc.). The fix should make the sync MORE reliable, not add new failure modes.

---

## Issue 7: Add terminal inventory to handshake snapshot

**What:** After `ready`, the server sends settings and that's it. The client has no idea what terminals exist. It discovers state reactively by trying to attach stale IDs and getting INVALID_TERMINAL_ID errors.

**Why it matters:** This is the core architectural gap that causes the reconnect cascade. The server can assemble terminal state in <1ms (spike 4 confirmed this). Adding it to the handshake eliminates the entire INVALID_TERMINAL_ID cascade.

**Where to look:**
- Server: `ws-handler.ts:962-978` — `sendHandshakeSnapshot()`. Also the terminal registry's `list()` method.
- Client: `App.tsx` ready handler. Also `src/store/terminalDirectorySlice.ts` and `src/store/terminalMetaSlice.ts` which have snapshot actions (`setTerminalMetaSnapshot`) that are wired but never called.
- Spike 4 lab note (`docs/lab-notes/2026-03-27-spike-4-server-audit.md`) has the analysis.
- Spike 6 lab note (`docs/lab-notes/2026-03-27-spike-6-consistency-audit.md`) documents the `terminalMetaListProvider` that's plumbed but unused.

**What to include in the snapshot:**
- Terminal list: id, mode, status (running/exited), title, resumeSessionId, createdAt
- Terminal metadata: cwd, branch, provider, sessionId, tokenUsage
- A per-process boot ID (from Issue 4) so the client knows if this is the same server

**Client behavior on receiving snapshot:**
- If boot ID matches previous: reconcile. Terminals in snapshot are alive; terminals NOT in snapshot are dead. Skip INVALID_TERMINAL_ID cascade — go straight to create for dead terminals.
- If boot ID is new: all previous terminals are gone. Don't even try to attach old IDs.
- Populate terminal metadata from snapshot (call `setTerminalMetaSnapshot`).

**How to verify:** Start server, create 3 terminals. Kill server, restart. The client should recover ALL terminals without any INVALID_TERMINAL_ID errors in the console. The recovery should be visibly faster (no cascade). Use Chrome automation to time it — compare against spike 1 measurements.

**Constraints:** This depends on Issue 4 (boot ID). Must be backward-compatible — if the client connects to an older server that doesn't send the snapshot, the old reactive behavior should still work. Add a capability flag or just check if the snapshot field exists in the ready message.

---

## Issue 8: Reconnect backoff tuning

**What:** Exponential backoff 1s→2s→4s→8s means a 5-second server restart causes 15s+ of client-side waiting. The server sends close code 4009 ("server shutting down") which resets backoff, but subsequent failures re-escalate.

**Why it matters:** 93% of the server restart recovery time is spent waiting in backoff timers.

**Where to look:** `src/lib/ws-client.ts` — the `scheduleReconnect()` function and the backoff logic.

**Possible approaches:**
- Cap max backoff at 4s instead of growing indefinitely
- After a 4009 close code, use faster retry (500ms intervals for the first 10 attempts)
- Add jitter to prevent thundering herd
- Probe with faster retries (1s intervals) after detecting server shutdown, then fall back to exponential only after 30s

**How to verify:** Kill server, time how long until client reconnects after restart. Should be under 5s for a 3s server restart, not 15s+.

**Constraints:** Don't create a reconnect storm. If the server is genuinely down for a long time, exponential backoff is still correct — just tune the initial parameters for the common case (brief restart).

---

## Issue 9: Proactive hidden-tab recovery

**What:** Only the active tab goes through reconnect recovery (INVALID→create→attach). Hidden tabs are left broken until the user switches to them, at which point they replay the full buffer (the fast-scroll symptom).

**Why it matters:** Every tab switch after a server restart shows broken/replaying content. The user has to wait for each tab to recover individually.

**Where to look:** `src/components/TerminalView.tsx:1868-1883` — the reconnect handler that checks `hiddenRef.current` and defers attach. Also the `useEffect` at line 1431-1446 that fires the deferred attach on visibility change.

**How to verify:** Start server, create 3 terminals across 3 tabs. Kill server, restart. After the active tab recovers, switch to the other tabs. They should already be recovered (or recover instantly without visible replay).

**Constraints:** This is closely related to Issue 7 (handshake snapshot). With a snapshot, the client knows which terminals are dead immediately and can proactively re-create ALL of them, not just the visible one. Implement this after Issue 7 — the snapshot makes the proactive recovery much cleaner because you don't need to try-and-fail for each hidden terminal.

---

## Dependencies and Ordering

```
Independent (can parallelize):
  Issue 1: /api/version cache
  Issue 2: "Recovering" banner fix
  Issue 3: Session-directory polling
  Issue 5: Cross-kind merge guard

Sequential chain:
  Issue 4: Boot ID → Issue 7: Handshake snapshot → Issue 9: Proactive hidden-tab recovery

Independent but benefits from context:
  Issue 6: Atomic cross-tab hydration (can be done anytime, doesn't depend on others)
  Issue 8: Backoff tuning (can be done anytime, synergizes with Issue 7)
```

## Verification Checklist (For Each Issue)

- [ ] Tests pass (both new tests and existing suite)
- [ ] Server builds and runs in production mode
- [ ] Behavior verified in Chrome with real terminals
- [ ] No regression in other scenarios (reconnect, page refresh, cross-tab sync)
- [ ] Commit with clear message explaining what and why
