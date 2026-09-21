# RCA: Blank pane after kill→recreate — terminal.attach refused on stale ownership fence (no create-commit owner broadcast)

**Date:** 2026-09-20
**App:** Freshell v0.7.0 (self-hosted production, port 3001, server pid 1983788, started 2026-09-18T16:26:11Z)
**Component:** session runtime-ownership coordinator (client fence discipline + WS terminal create/attach lanes)
**Severity:** user-visible functional break — pane renders nothing while its terminal runs headless; deterministic on every kill→recreate of a sessionRef-owned terminal pane

## Problem

The pane that is supposed to be showing `opencode --session ses_f4464ad77ffe9UM8IDcxL519Ba`:

- **Pane:** `lcIkQQ8DRXs1egpbIZCoK` in tab `vFjwFhieHs6n1dUaPsBD3` ("Fix codex resume \"moved to new runtime\" error"), createRequestId `Z7TV0ZHzwrI1BpPztPs_f`, sessionRef `opencode:ses_f4464ad77ffe9UM8IDcxL519Ba`.
- **What it shows:** a blank terminal. It never attached to its terminal.
- **What runs behind it:** terminal `14aad38bfd344cf9b8f4d64d8d60e636`, pid 616526 on pts/28, alive and rendering live TUI output (`opencode --hostname 127.0.0.1 --port 44239 --session ses_f4464ad77ffe9UM8IDcxL519Ba`, verified via the terminal search API returning opentui escape-sequence content). The process streams to an audience of zero.

Not the same pane: the tab "opencode pane lag with --session flag" (`Donwf2sPrsBJEXa4UMTWm`, pane `xi9uVijJA2-Hek571SAm5`) holds a different, healthy opencode TUI (`f056a164…`, session `ses_f3ff480d1ffeWPC3uP1sj7BBrq` — whose session title literally is "opencode pane lag with --session flag"). That pane attached successfully several times during the day.

## Evidence timeline (all UTC, from `~/.freshell/logs/rust-server.jsonl`, log window 18:24:51Z onward)

| Time | Event |
|---|---|
| 22:20:04.829 | `ownership.handoff.begin` FreshAgent→Terminal for `opencode:ses_f4464ad77ffe9UM8IDcxL519Ba` (initiator `device-pp9wfejc`), granted |
| 22:20:04.917 | `invariant` ERROR `freshagent.start_cancellation_registration_declined` on `handoff-717e4aa7…` (watchdog registration declined; see Side findings) |
| 22:20:05.191–210 | Handoff spawns terminal T1 `1b9b7c90-…` (pid 544340), `session_ref.winner_bound`, `ownership.live.commit` **generation 2**, `ownership.handoff.done` committed |
| 22:27:32.251–577 | Client kills T1 (`term-kill`, initiator `ws-kill-device-pp9wfejc-client-5n5vzpjj…`); `terminal.killed`; `ownership.stop.commit` → **Vacant, generation 3** — kill-side `broadcast_vacant_frame` fires (b8ke ext r18 F1) |
| 22:27:35.403 | Client re-creates with the same pane key: `term-create-Z7TV0ZHzwrI1BpPztPs_f` (`ownership.start.begin`) |
| 22:27:35.843–860 | `terminal.created` T2 `14aad38bfd344cf9b8f4d64d8d60e636` (pid 616526, mode opencode, `resume_applied: true`); `session_ref.winner_bound`; `ownership.live.commit` **generation 4** — **no `session.runtimeOwner` frame is broadcast on this commit**; `ws.terminal.create.settled` |
| 22:27:36.230 | Client's `terminal.attach` for T2 is refused: `terminal_attach_refused: the observed fence is stale — the queued attach answers typed, nothing restamps` (**observed generation 3 < current 4**) → `SESSION_RESERVED` "Session ownership moved on (stale observed generation); refresh and retry." |
| after 22:27:36 | **Nothing.** No attach-guard event for `14aad38b…` ever fires (a successful attach always logs one), no further lifecycle events, no retry. pid 616526 still alive hours later (verified via `ps` and `GET /api/terminals/<id>/search`). |

T1 (`1b9b7c90…`) also has **zero attach events in the log** — no attach was ever sent for it. The user stared at a blank pane for ~7 minutes, killed it, and the pane's recreate (T2) wedged again the same hour. This exact refusal appears exactly once in the log window; the pane never recovered on its own.

## Root cause (two-part)

### 1. Server: the WS terminal-create ownership commit is broadcast-silent

The session runtime-ownership coordinator is the fence authority: every lifecycle transition bumps a `(epoch, generation)` pair, and clients observe it via `session.runtimeOwner` broadcasts folded into `state.freshAgent.runtimeOwners` (`src/store/freshAgentSlice.ts:676-695`, epoch-aware monotonic fold; reset on every ready/reconnect at `:697-706`).

- The **kill** half of a kill→recreate sequence broadcasts: `commit_terminal_stop` fires `broadcast_vacant_frame` carrying the committed pair (`crates/freshell-ws/src/terminal.rs:8052-8070`). Its own comment (b8ke ext r18 F1) names the exact hazard: *"connected panes and the kill → immediate recreate sequence converge on the vacant owner and the NEW generation (pre-r18 the commit changed the coordinator with no broadcast, so a recreate carrying the stale observed generation was fenced…)"*.
- The **recreate** half does not: the WS create settle commits `Live{Terminal}` via `TerminalOwnershipClaim::commit` (`crates/freshell-ws/src/terminal.rs:2690-2722`, called at `:5630-5659`), which is a registry-level commit (`registry.commit_session_ref_ownership`) with **no `session.runtimeOwner` broadcast**. A repo-wide search shows the only runtimeOwner broadcast in the WS terminal lanes is the kill-side vacant frame (`terminal.rs:8063`).

So after the 22:27:32 kill, the client's owner record stood at (epoch, **gen 3**) from the vacant broadcast; the 22:27:35 create committed **gen 4** silently; the client's record never advanced.

### 2. Client: the pane's attach fences against the stale record, and the typed refusal is dropped

- Right after `terminal.created` arrives, the pane attaches (`src/components/TerminalView.tsx:4752`), and the attach carries the pane's observed fence read from the client store at send time (`TerminalView.tsx:3164-3180`, `selectPaneOwnerFence` from `src/store/selectors/runtimeOwner.ts:159-176`). That fence was still (epoch, 3).
- The server's stale-fence check refuses typed: `crates/freshell-ws/src/terminal.rs:1262-1296` answers `SESSION_RESERVED` "Session ownership moved on (stale observed generation); **refresh and retry**" — but the frame is sent with `request_id: None` (the attach message carries an `attachRequestId` the server does not echo into the refusal).
- The client has no consumer for that frame. The only `SESSION_RESERVED` handling is create-correlated (`TerminalView.tsx:5135`, requires `msg.requestId === reqId`); App-level error handling covers reconcile errors only (`src/App.tsx:1447-1464`). An `error` frame with no `requestId` matches nothing and is silently dropped. No attach watchdog exists for a refused attach. The pane stays blank forever.

### Why this is deterministic, not a one-off race

For any session that already has a client-side owner record, a kill→recreate (or handoff→recreate) sequence wedges the pane by construction:

1. Kill broadcasts vacant at generation N → client folds (epoch, N).
2. Recreate commits generation N+1 with no broadcast → client record unchanged.
3. The pane's attach observes N < N+1 → typed refusal → dropped by the client → no attach, no retry.

The user hit this twice in a row on this session (T1's blank pane — see Side findings for its separate mechanism — then T2's refused attach). Until fixed, **killing and recreating the terminal from the UI re-wedges it every time**.

## Recommendation

Two independent fixes; ship both (each covers the other's races):

1. **Server (primary): broadcast the create-lane ownership commit.** After `TerminalOwnershipClaim::commit` succeeds in the WS create settle (`terminal.rs:5630-5659`), broadcast the authoritative owner frame via the existing `broadcast_owner_frame_if_authoritative` helper (`crates/freshell-ws/src/identity_ownership.rs:761`, transition e.g. `terminal-create-committed`), mirroring the r18 kill-side precedent. Because the broadcast channel and the connection's direct reply are separate sinks, also **additively include the committed `(epoch, generation)` pair on the `TerminalCreated` reply** (same socket, ordered before the client's attach) so the creator folds the fresh pair synchronously before attaching; the broadcast converges every *other* connected client watching the same session.
2. **Client (defense in depth): implement the refusal's own instruction.** Handle the attach-path `SESSION_RESERVED` refusal (`code === 'SESSION_RESERVED'`, `terminalId`-matched, no `requestId`): fold the frame's `ownerEpoch`/`ownerGeneration` (the refusal already carries both, `terminal.rs:1277-1279`; the wire schema at `shared/ws-protocol.ts:1202-1205` documents this exact "refresh its observed fence from the refusal itself" consumer intent — it was never wired) into `runtimeOwners`, then bounded re-drive of the attach (one retry with the refreshed pair; reuse the existing quarantine/redrive budget pattern). Design notes from the load-bearing validation: the re-drive must be scoped to the fence-staleness refusal arms (frames *without* `ownerKind`); the live-owner conflict arm (`terminal.rs:1239`) sends the same no-`requestId` shape *with* `ownerKind` and belongs on the typed failure-card path instead; and because the refusal does not echo `attachRequestId`, correlation must key on `terminalId`. The `INVALID_TERMINAL_ID` handler already accepts no-`requestId` frames (`TerminalView.tsx:5275`) — the gap is specific to `SESSION_RESERVED`.

   **Repo precedent:** the freshagent SDK lane already fixed this same gap for itself — b8ke ext r29 F1 ("EVERY commit-to-Live broadcasts the …", `crates/freshell-freshagent/src/lib.rs:1130`, structural invariant documented at `:6757`); the WS terminal lane never received that treatment. The server-side fix above is the terminal-lane application of the same invariant.
3. **Tests:**
   - freshell-ws integration test pinning the kill→recreate sequence: kill a sessionRef-owned terminal (vacant broadcast at gen N), recreate via WS create (commits gen N+1), assert a `session.runtimeOwner` frame with the new pair is broadcast (and the `TerminalCreated` reply carries it), and that a follow-up attach with the folded pair succeeds.
   - TerminalView unit test: the attach-refusal frame (no `requestId`, `terminalId` set) folds the fence and re-drives the attach once.

## Immediate remediation (before the fix ships)

- **Hard-reload the Freshell browser tab.** On reconnect the server replays current runtime-owner state on every handshake (`crates/freshell-ws/src/lib.rs:577-615`, `ownership.snapshot_records()` — its comment names the page-reload case verbatim); the client resets its owner records and folds the replay at generation 4, and the remounting pane attaches with a current fence (or unfenced, which is admitted using the server's current snapshot). Load-bearing validation confirmed both arms empirically as well: after this wedge, reconnected clients attached to `14aad38b…` cleanly (clean `adopt_guard.armed/released` pairs in the server log the next day). The session's conversation is intact in opencode's storage regardless.
- **Do not** kill and recreate the terminal from the UI to "fix" it — that sequence deterministically re-wedges (see above), and reconnection is the only unwedge channel.
- **Time qualifier:** agent-mode terminals are spared by the idle reaper for 24 h of inactivity, not forever (`IDLE_HARD_CAP_MS` in `crates/freshell-terminal/src/registry.rs:1189`, pinned by `idle_sweep_spares_detached_agent_terminals`). Reload within ~24 h of the wedge to recover the still-running terminal; after that the sweep may have reaped it and the pane will recreate from the durable session instead.

## Side findings (separate issues, not required for this fix)

1. **The handoff pane (T1) never sent an attach at all.** No attach attempt was logged for `1b9b7c90…` in its 7-minute life. Hypothesis (unproven — needs client console logs): the client's transition-block discipline (`derivePaneOwnerDivergence`, R5-3 in `src/store/selectors/runtimeOwner.ts:214-222`: `handoff-started` ⇒ `inProgress`, "no attach actions until the transition's committed frame supersedes it") left the pane blocked because the `handoff-committed` owner frame never arrived or never superseded. Worth its own investigation; the same-symptom user experience suggests the handoff→pane convergence path has a second hole in this family.
2. **`freshagent.start_cancellation_registration_declined` invariant errors** (4 in the log window; one on this very handoff): "the watchdog registration declined — the operation proceeds with NO cancellation/settle armed (fail-closed fencing risk…)". Pre-existing, separately tracked.
3. **REST `capture-pane` 404s for WS-created panes.** `GET /api/panes/:id/capture` resolves through `state.terminal_panes`, which only the REST spawn pipeline populates (`crates/freshell-freshagent/src/terminal_tabs.rs:3204-3222`); client-created panes live only in the client-reported layout mirror, so agent/MCP capture-pane answers `pane not found` for them. This blocked live capture during this investigation and affects every agent workflow against user-created panes.
4. **`ownership.handoff.begin` logged `duration_ms: 88891085`** (~24.7 h) for the 22:20 handoff — anomalous duration accounting worth a look.
5. **RuntimeOwner broadcasts are not logged**, which is why "no frame reached the client" had to be established by code inspection plus the attach's observed generation rather than by direct log evidence. An INFO line per owner-frame broadcast (like the ownership lifecycle events) would have made this RCA a one-liner.

## Load-bearing validation (usual-load-bearing stage, 2026-09-21)

Every decision-controlling, previously-unproven claim in this RCA was validated read-only (static code inspection + live-log corroboration). Ledger: `.worktrees/.the-usual-logs/rca-attach-wedge/load-bearing-ledger.md`; full reports under `.worktrees/.the-usual-logs/rca-attach-wedge/reports/load-bearing-validator-{1,2,3}.md`.

- **LB-1 (client drops the attach-path refusal)** — verified. 16 error-frame consumers enumerated across the client; the only terminal-lane `SESSION_RESERVED` consumer is create-correlated (`TerminalView.tsx:5135`); the no-`requestId` refusal matches nothing and is not even logged; none of the 8 `attachTerminal` re-drive sites is triggered by the refusal.
- **LB-2 (create-commit is broadcast-silent)** — verified. 12 production `session.runtimeOwner` producers enumerated across crates/ with triggers classified; zero fire on the WS create settle; the WS terminal lanes' only producer is the kill-side vacant frame (`terminal.rs:8063`).
- **LB-3 (kill→recreate wedge is deterministic)** — verified. No competing trigger can update the client's record in the window for a resumed terminal-mode pane (locator arms only fresh non-resuming panes, `opencode_association.rs:46-60`; signal-lane same-id case is a coordinator no-op; the only client-side writers of `runtimeOwners` are the broadcast fold and the ready replay).
- **LB-4 (reload un-wedges the pane)** — verified, including the ready-replay contents, the unfenced-attach admission branch (`terminal.rs:1261`, `:1339-1353`), the mount-attach path for a persisted terminalId (`TerminalView.tsx:5605-5632`), the 24 h agent idle cap, and live post-wedge successful reconnects.
- **Provenance:** the live server binary was built at commit `34f425fa` (extracted from `/proc/1983788/exe`; the banner commit `2536acad` in `rust-server-3001.log` belongs to a stale prior instance), an ancestor of the inspected `855dae72a` with a test-module-only diff over the ownership-relevant files — the code anchors in this document hold for the deployed server.

## Evidence appendix

- Log: `~/.freshell/logs/rust-server.jsonl` — grep `14aad38bfd344cf9b8f4d64d8d60e636`, `1b9b7c90`, `Z7TV0ZHzwrI1BpPztPs_f`, `ses_f4464ad77ffe9UM8IDcxL519Ba`, `terminal_attach_refused` (single hit).
- Process: `ps -fp 616526` — `opencode … --session ses_f4464ad77ffe9UM8IDcxL519Ba`, parent = freshell-server pid 1983788, tty pts/28, started 15:27 local (22:27Z).
- Live buffer proof: `GET /api/terminals/14aad38bfd344cf9b8f4d64d8d60e636/search?query=opencode` returns opentui TUI escape output.
- Layout truth: `GET /api/tabs-sync/snapshots/device-pp9wfejc` — pane `lcIkQQ8DRXs1egpbIZCoK` payload: `createRequestId Z7TV0ZHzwrI1BpPztPs_f`, `sessionRef opencode:ses_f4464ad77ffe9UM8IDcxL519Ba`, `liveTerminal.terminalId 14aad38bfd344cf9b8f4d64d8d60e636`.
- Session size (rules out a load/lag mechanism): opencode DB `session`/`message`/`part` — 125 messages / 508 parts / 1.2 MB (the largest live pane's session is 22.8 MB by comparison and renders fine).
- Code anchors: `crates/freshell-ws/src/terminal.rs` (`:1262-1296` stale-fence refusal; `:2690-2722` claim commit; `:5630-5659` settle; `:5693` created reply; `:8052-8070` kill-side broadcast), `crates/freshell-ws/src/identity_ownership.rs:761`, `src/components/TerminalView.tsx` (`:3164-3180` attach fence; `:3474-3499` create fence; `:4625-4753` created→attach; `:5135` create-only SESSION_RESERVED), `src/store/freshAgentSlice.ts:660-706`, `src/store/selectors/runtimeOwner.ts:150-232`, `src/App.tsx:1447-1464`.
