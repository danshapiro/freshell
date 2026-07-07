# Codex Launch-Leak Remediation Plan — Stage 0a/0b + 1a/1c

**Date:** 2026-07-06
**Target:** freshell `main @ 02f95b70` (TypeScript/Node server)
**Status:** Plan — not yet implemented
**Scope:** The four near-term, no-regret items. Follow-ups (resume-TUI boot reaper "1b",
shared-app-server architecture "Stage 2", read-only WAL monitor) are out of scope here and
tracked separately.

---

## 1. Problem

Codex CLI intermittently wedges on launch (blocks forever in `futex_wait_queue` while
opening `~/.codex/logs_2.sqlite`). Root cause is a self-reinforcing loop driven by
freshell:

1. **Per-pane codex processes held open forever.** freshell spawns, **per pane**:
   - one `codex app-server --listen ws://…` via `child_process.spawn(..., { detached: true })`
     — `server/coding-cli/codex-app-server/runtime.ts:1246-1261`
   - one `codex … resume <uuid>` node-pty — `server/terminal-registry.ts:1592-1600`
     (recovery re-spawn at `:3694-3700`)

   With ~10 panes attached, 19+ codex processes hold `logs_2.sqlite` open continuously.
   SQLite can only truncate its WAL when **zero** connections hold the DB, so the WAL can
   never truncate.

2. **TRACE log firehose.** codex is spawned with no log-level env
   (`runtime.ts:1255-1259` — no `RUST_LOG`), so it persists TRACE-level tracing
   (dominated by inotify file-OPEN events) into that DB at ~27–56 MB/min while a
   session is active.

Together: the WAL grows unbounded (~5 GB over ~10 days), and a new `codex` launch then
blocks on the SQLite lock/WAL index and never finishes init.

**Amplifiers (addressed by 1a/1c here; 1b later):**
- `detached: true` children orphan to init on ungraceful server exit; teardown only runs
  on graceful `SIGTERM`/`SIGINT` (`server/index.ts:1147-1148`).
- On reboot the client re-creates every pane (restore-all), spawning a fresh full set on
  top of any orphans.
- The startup reaper covers app-servers only, and **throws** on an un-reapable record
  (`runtime.ts:863-876` → `index.ts:1151-1154` `process.exit(1)`), which can hard-block
  freshell's own boot — a self-inflicted "won't launch."

**Out of scope / codex-internal:** even with a clean DB, `codex doctor` synchronously
scans all ~6,000 rollout files ("Checking thread inventory…"). That lives in the codex
binary; it is excluded from this plan's acceptance gate (upstream ask).

## 2. Hard constraints (design invariants)

- **I1 — Lossless.** Never delete or risk Codex sessions/long-term state
  (`~/.codex/sessions/`, goals, memories, thread graph). Cleanup = checkpoint/VACUUM
  only, behind a verified backup. Never `rm` live data (including `-wal` files).
- **I2 — No cap.** Unlimited simultaneous panes is the product's core value. Nothing in
  this plan limits pane/session count.
- **I3 — Never touch a live pane.** No teardown/reaper may signal a client-attached pane,
  especially one with an in-flight turn. The idle reaper's `clients.size > 0` skip
  (`terminal-registry.ts:1409-1422`) stays intact.
- **I4 — Never fail-closed at boot.** No fix may introduce a new "won't launch" path.
- **I5 — Accepted tradeoff.** Log dampening thins codex `/feedback` telemetry.

---

## 3. Stage 0a — Codex spawn-env log dampening

### Change

New shared helper, applied at both codex spawn paths. Sets a quiet log level **only if
the operator hasn't set one**.

```ts
// server/coding-cli/codex-log-dampening.ts  (new, ~15 lines + tests)
export const CODEX_DEFAULT_LOG_LEVEL = 'error' // single tunable

export function withCodexLogDampening<T extends NodeJS.ProcessEnv>(env: T): T {
  const userSet = env.RUST_LOG ?? process.env.RUST_LOG
  if (userSet && userSet.trim() !== '') return env // never clobber an explicit choice
  if (process.env.FRESHELL_CODEX_LOG_DAMPENING === '0') return env // kill switch
  return { ...env, RUST_LOG: CODEX_DEFAULT_LOG_LEVEL }
}
```

Call sites:

1. **App-server spawn** — `runtime.ts:1255-1259`: wrap the env object:
   `env: withCodexLogDampening({ ...process.env, ...this.env, FRESHELL_CODEX_SIDECAR_ID: ownershipId })`
2. **Resume-TUI spawn** — inside `buildSpawnSpec` (`terminal-registry.ts:~1059`), applied
   to the returned `env` **only when the pane mode is codex**. This single site covers
   both `pty.spawn` consumers (`:1594` primary, `:3694` recovery).

Optional refinement (validate during acceptance): if codex honors a config-level override
(e.g. `-c log.level="error"` alongside `CODEX_MANAGED_REMOTE_CONFIG_ARGS`,
`runtime.ts:1248`), prefer it for the app-server path; keep `RUST_LOG` as the universal
fallback for both paths.

### Why safe

- Purely additive env; no lifecycle change; no effect on pane count (I2) or boot (I4).
- Only-if-unset guard: a developer running `RUST_LOG=debug` is never silently overridden.
- `RUST_LOG` gates codex's tracing subsystem — the thing that fills `logs_2.sqlite`.
  Sessions/goals/memories/thread-graph are written by normal code paths, not tracing (I1).

### Acceptance test

1. Open one codex pane; sample `stat -c%s ~/.codex/logs_2.sqlite-wal` every 30 s for
   5 min, with and without the helper. **Pass:** growth drops from ~27–56 MB/min to
   near-zero. **If it does not drop:** codex's SQLite sink isn't gated by `RUST_LOG` —
   record findings, file the upstream ask, and treat 0a as cosmetic (0b still buys time;
   Stage 2 remains the structural fix).
2. Unit test: helper is a no-op when `RUST_LOG` is preset or the kill switch is set.
3. Launch check: codex TUI still reaches `Ready`; new rollout file still appears.

### Rollback

Set `FRESHELL_CODEX_LOG_DAMPENING=0` (no redeploy) or revert the two call sites.

### User-facing risk

Codex `/feedback` bug reports carry sparse traces (I5, accepted). Masks — does not fix —
whatever generates the inotify storm (upstream ask). **Severity: Low.**

---

## 4. Stage 0b — One-time lossless cleanup (operational runbook)

Reclaims the current bloat (multi-hundred-MB regrowing WAL + ~2.24 GB dead pages inside
the 6 GB `logs_2.sqlite`) without losing a single row. Run **after** 0a is deployed so
regrowth is pre-dampened.

### Runbook (ordered; each step gates the next)

1. **Backup + baseline.** Copy `~/.codex/{logs_2,state_5,goals_1,memories_1}.sqlite*`
   (keep `.sqlite` + `-wal` + `-shm` together) plus `history.jsonl`, `auth.json`,
   `config.toml` to a timestamped dir on the same filesystem. Run
   `PRAGMA integrity_check` on each copied DB (expect `ok`). Record baseline row counts
   as the restore oracle: `sessions/` file count, `goals_1.thread_goals`,
   `state_5.threads`, `state_5.thread_spawn_edges`, `memories_1.stage1_outputs/jobs`.
   (A verified backup from 2026-07-06 exists at `/home/dan/codex-backup-20260706_023506`;
   make a fresh one anyway — cheap.)
2. **Reap codex processes only — guarded.** Build the kill set from
   `lsof ~/.codex/logs_2.sqlite` filtered to codex cmdlines
   (`codex-linux-x64/vendor`, `app-server`, `resume`), plus their immediate codex
   wrappers. **Protected-PID guard:** never signal freshell prod/dev servers, amplifier,
   or the operator shell's ancestry — abort if any protected PID lands in the set.
   **Dry-run and print the set first.** SIGTERM, wait ~4 s, SIGKILL stragglers.
3. **Reach 0 holders.** `lsof ~/.codex/logs_2.sqlite` must be empty. If a live freshell
   server keeps respawning codex children into the window: briefly `SIGSTOP` **only the
   non-ancestry respawner**, with a guaranteed `SIGCONT` in a `trap`/`finally`; re-reap;
   proceed. (Never stop a server in the operator's own process ancestry.)
4. **Checkpoint — never rm.** For each `~/.codex/*.sqlite` with a non-empty `-wal`
   (do `memories_1` before trusting any "0 rows" reading):
   `PRAGMA busy_timeout=15000; PRAGMA wal_checkpoint(TRUNCATE);`
5. **Compact.** `VACUUM;` on `logs_2.sqlite` (reclaims the ~2.24 GB free pages; needs
   0 holders + free disk ≈ DB size — currently ~170 GB free, fine).
6. **Verify.** `PRAGMA integrity_check` = `ok` on all live DBs; every baseline row count
   matches; `sessions/` file count unchanged (± legitimately new sessions); holders = 0;
   `logs_2.sqlite-wal` = 0 bytes; codex TUI launches to `Ready`.
7. Resume the SIGSTOP'd server (already guaranteed by trap); confirm freshell panes
   reconnect.

### Why safe

WAL is *folded into* the main DB (`wal_checkpoint(TRUNCATE)`), never deleted; `VACUUM`
is lossless; every step is gated behind a verified backup + integrity check + row-count
equality (I1). Only codex processes are signalled, orphaned/crashed ones at that; live
freshell servers and attached panes are protected by the guard (I3).

### Rollback

Restore the timestamped backup (byte-identical copies taken while 0 holders).

### User-facing risk

Seconds-long pause of one respawning server during the checkpoint window; codex panes
briefly unavailable while their (already-wedged/orphaned) processes are reaped.
**Severity: Low.**

---

## 5. Stage 1a — Crash-safe teardown on server exit

### Change

Today, codex child teardown only runs from the async `shutdown()` on `SIGTERM`/`SIGINT`
(`index.ts:1147-1148`). A crash, `SIGKILL`-adjacent exit, or `SIGHUP` leaves every
`detached: true` app-server and resume pty orphaned. Add a best-effort, **synchronous**
process-group reap bound to true exit paths:

1. **Registry.** A small module (e.g. `server/coding-cli/codex-child-registry.ts`)
   tracking `{ pid, pgid, kind }` for every codex child freshell spawns:
   - app-server: pgid == `child.pid` (already captured as `processGroupId`,
     `runtime.ts:1291-1292`) — register on spawn, deregister in the existing exit handler
     (`runtime.ts:1533-1575`) and ownership teardown.
   - resume pty: register `pty.pid` at both spawn sites (`terminal-registry.ts:1594`,
     `:3694`), deregister on pty exit and in `kill()` (`:3997-4035`).
2. **Bindings** (installed once, alongside `index.ts:1147-1148`):
   - `process.on('exit', reapSync)` — synchronously best-effort
     `process.kill(-pgid, 'SIGKILL')` for each still-registered group, wrapped in
     try/catch. Guard: never signal `-1`, `0`, `1`, or our own pgid; only pgids we
     registered. Where cheap, re-verify identity (e.g. `/proc/<pid>/cmdline` contains
     codex) before signalling to defend against pgid reuse.
   - `process.on('SIGHUP', …)` — route into the existing graceful `shutdown('SIGHUP')`.
   - `process.on('uncaughtExceptionMonitor', …)` — **observe/log only.** Never kill.
3. **Idempotency.** The existing async shutdown path drains the registry as it tears
   children down (`joinCodexShutdownOwners`, `index.ts:1104-1109`), so `reapSync` at
   `exit` is a no-op after a clean shutdown.

Explicitly **not** bound to `uncaughtException`: `exit` cannot fire on a recoverable,
caught error, so a survivable blip can never nuke live panes (I3).

### Why safe

- `exit` fires only when the process is genuinely terminating — at which point the
  children's sockets are dying anyway and their in-flight turns are already lost with the
  server; reaping them prevents orphan accumulation without touching any live pane (I3).
- Synchronous, guarded signalling of only-our-own pgids; cannot throw out of the exit
  path; cannot block boot (I4).

### Acceptance test

1. Start the dev server with ≥2 codex panes; terminate with `SIGHUP` and with a normal
   exit → `pgrep -f 'codex-linux-x64/vendor'` shows zero survivors from that instance;
   `lsof ~/.codex/logs_2.sqlite` shows no holders owned by it.
2. Throw a caught-and-handled exception in a request handler → **all panes stay alive**
   (I3 regression guard).
3. `SIGKILL` the server → survivors expected (documented boundary; closed by follow-up
   1b, out of scope here).

### Rollback

Remove the three listeners (single module); behavior reverts to SIGTERM/SIGINT-only.

### User-facing risk

Removes any accidental "app-server survives a dead server" reattach behavior — durable
state lives in on-disk rollouts, so the next launch resumes losslessly (I1). SIGHUP now
tears down a dev server left in a closing terminal (previously it might linger).
**Severity: Low.**

---

## 6. Stage 1c — Startup reaper: log-and-continue (fail-open)

### Change

`assertCodexStartupReaperSucceeded` throws when any sidecar ownership record can't be
classified/reaped (`runtime.ts:863-876`). It is `await`ed before `server.listen`
(`index.ts:256`), and the throw propagates to `main().catch → process.exit(1)`
(`index.ts:1151-1154`) — the whole server refuses to boot because one stale JSON record
was ambiguous. That is a self-inflicted "won't launch" (violates I4).

Replace fail-closed with fail-open:

1. In `runCodexStartupReaper` / its caller: for each record classified `failed` /
   `indeterminate` / `unreadable`:
   - log a structured `warn` with the record path, classification, and reason;
   - **move the record to `~/.freshell/codex-sidecars/quarantine/`** (atomic rename)
     with a `{ reason, firstSeen, attempts }` sidecar note;
   - continue.
2. Delete `assertCodexStartupReaperSucceeded` (or reduce it to a warning aggregator).
   Startup proceeds unconditionally.
3. Bounded retry: on each subsequent boot, re-attempt quarantined records (increment
   `attempts`, give up permanently after e.g. 5, leaving the record for manual review).
4. Expose the quarantine count via the existing logger/metrics so the (future) monitor
   can surface it.

### Why safe

The correct worst case for an ambiguous orphan is "one possibly-orphaned sidecar lingers,
flagged" — never "no server at all" (I4). Quarantining prevents boot-loop churn on a
permanently bad record. No change to what gets killed (I3): reap decisions still require
the same ownership proof; we only change what happens when proof is unavailable.

### Acceptance test

1. Seed a deliberately un-reapable ownership record (e.g. valid JSON pointing at a live
   PID that fails the ownership proof) → server boots to ready; record lands in
   `quarantine/`; warning logged; no `process.exit(1)`.
2. Seed a reapable orphan record → still reaped exactly as before (no regression).
3. Existing reaper unit tests updated: no-throw contract.

### Rollback

Restore the throw (revert one function); quarantine dir is inert.

### User-facing risk

On an ambiguous record the server now starts with a possibly-lingering orphan (flagged,
retried next boot) instead of refusing to start. Strictly better availability.
**Severity: Low, net-positive.**

---

## 7. Sequencing

```
0a (code)  ──►  deploy  ──►  0b (runbook, once)
1a (code)  ──┐
1c (code)  ──┴─►  same PR or sibling PRs; independent of each other and of 0a
```

- 0a first, then 0b, so the WAL doesn't regrow at firehose rate behind the cleanup.
- 1a and 1c are independent of 0a/0b and of each other; land in any order.
- Follow-ups (not in this plan): 1b (durable resume-TUI ownership + boot-reaper
  coverage — closes the `SIGKILL` boundary left by 1a), Stage 2 (single shared
  app-server; holders == 1 regardless of pane count — the permanent structural fix),
  read-only WAL/holder monitor, upstream codex asks (bound own WAL; stop TRACE inotify
  persistence; lazy thread-inventory scan; documented log-level knob).

## 8. Constraint traceability

| Constraint | Honored by |
|---|---|
| I1 lossless | 0b: checkpoint/VACUUM only, verified backup + integrity + row-count oracle; 1a: reaps processes, never data; rollouts remain source of truth |
| I2 no cap | No stage limits panes; 0a/1a/1c don't touch pane creation |
| I3 no live-pane kills | 1a binds `exit` (can't fire on recoverable errors), `uncaughtExceptionMonitor` observe-only; 0b protected-PID guard + dry-run; idle-reaper attached-pane skip untouched; 1c changes only the no-proof branch |
| I4 no new won't-launch | 1c removes the fail-closed boot throw; 0a additive env; 1a exit-path only, try/catch'd |
| I5 telemetry tradeoff | 0a documented, only-if-unset, kill switch, single tunable |

## 9. Definition of done

1. **0a:** WAL growth with an active codex pane drops to near-zero (measured); helper
   no-op when `RUST_LOG` preset; TUI reaches `Ready`.
2. **0b:** integrity `ok` on all DBs; all baseline row counts match; `sessions/` count
   unchanged; holders 0 at completion; `logs_2.sqlite-wal` 0 bytes; `logs_2.sqlite`
   shrunk by ~2 GB.
3. **1a:** SIGHUP/normal exit leaves zero codex survivors; caught exception kills no
   panes.
4. **1c:** server reaches ready with an un-reapable record present; record quarantined
   and logged; reapable orphans still reaped.
