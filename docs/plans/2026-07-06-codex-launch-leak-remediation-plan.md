# Codex Launch-Leak Remediation Plan — Stage 0a/0b + 1a/1c (v2.1)

**Date:** 2026-07-06 (v2.1, night)
**Target:** freshell `main` (TypeScript/Node server). Anchors verified at `02f95b70`
and re-verified at `9f3a5035` (only `providers/codex.ts` `parseTimestampMs` changed;
no anchor impact). **Re-pin to current main before implementing.**
**Status:** Plan — not yet implemented
**v2 changes:** folds in the first 2026-07-06 adversarial review (factual fixes
F1–F6, per-stage design flaws, gaps G1–G6) and the log-dampening validation
experiment run the same evening (§3).
**v2.1 changes:** folds in the second-round adversarial review — §3 measurement
rewritten to a prune-immune metric (blocking #1); 1c quarantine narrowed to
confirmed-gone groups + quarantine rescan (blocking #2); composite `RUST_LOG`
directive (#3); backoff/monitor given concrete homes (#4); `logs_2` backup via
`VACUUM INTO` (#5); dampening-skip observability (#6); executable 1a acceptance
scoping, specified hard-exit timeout, structural I3 assertion (#7–9); §8 ordering
reconciled + DoD reclaim figure derived (#10); `id` schema check before the VACUUM
oracle (#11); anchor drift corrected (WSL wrap `:1141-1149`; ~12 throwing-contract
test sites; unreferenced alias).

Terminology note: `RUST_LOG` is the log-level environment variable of the **codex
binary** (OpenAI's CLI, which happens to be written in Rust). It is unrelated to any
freshell code.

**Scope:** the four near-term items (0a, 0b, 1a, 1c) plus a small observability
line-item promoted into scope. Follow-ups — durable resume-TUI boot reaper ("1b")
and the shared-app-server architecture ("Stage 2") — are out of scope and tracked
separately.

---

## 1. Problem (corrected model)

Codex CLI intermittently wedges on launch (blocks in `futex_wait_queue` while opening
`~/.codex/logs_2.sqlite`). The mechanism, corrected per review F1 and confirmed by
measurement:

1. **Per-pane codex processes hold the log DB open around the clock.** freshell
   spawns, **per pane**:
   - one `codex app-server --listen ws://…` via
     `child_process.spawn(..., { detached: true })` —
     `server/coding-cli/codex-app-server/runtime.ts:1246-1261`
   - one `codex … resume <uuid>` node-pty — `server/terminal-registry.ts:1592-1600`
     (recovery re-spawn `:3694-3700`)

   With ~10 panes attached: ~19–21 codex processes permanently connected.

2. **Log churn, not table growth, floods the WAL.** codex persists tracing rows into
   `logs_2.sqlite` and **bounds the table per process (~1,000 rows)** — inserts are
   continuously matched by prune deletes. The table stays small; the **WAL traffic
   does not**. Measured on this machine (2026-07-06, prune-immune incremental
   sampling): the live pane population writes **~22 MB/min** of WAL churn, ~99%
   `TRACE` rows with `target=log` (the Rust `log` facade forwarding **inotify
   file-event spam**).

3. **The WAL can never reset.** A WAL reset/truncate requires that **no read
   transaction spans the checkpoint** (review F1: it is *not* "zero connections" —
   idle connections alone don't pin it; the continuous overlapping read/write activity
   across ~20 permanent connections does). Under constant churn from many holders, a
   truncating checkpoint never gets its window; the WAL grows to a multi-GB high-water
   mark (~5 GB observed over ~10 days).

4. **The wedge.** A new `codex` must open that DB; against a multi-GB WAL index and
   ~20 active connections it blocks in `futex_wait_queue` during init → "won't
   launch."

**Amplifiers (0 addressed here; 1a/1c partially):**
- `detached: true` children survive ungraceful server exit; teardown runs only on
  graceful `SIGTERM`/`SIGINT` (`server/index.ts:1147-1148`).
- On reboot the client re-creates every pane (restore-all) on top of any orphans.
- The startup reaper covers app-servers only, and can **fail closed**: besides the
  explicit throw in `assertCodexStartupReaperSucceeded` (`runtime.ts:863-876` →
  `index.ts:1151-1154` `process.exit(1)`), three additional paths abort boot —
  `readFile` of a record (`runtime.ts:811`), the `/proc` ownership-proof assert
  (`:800`, per `:360-379`), and non-ENOENT `readdir` errors (`:803-806`) (review F2).

**Out of scope / codex-internal (upstream asks):** even with a clean DB,
`codex doctor` synchronously scans all ~6,000 rollout files ("Checking thread
inventory…"). Excluded from this plan's acceptance gate. Upstream asks: bound own WAL
(`journal_size_limit`/`wal_autocheckpoint` + periodic passive checkpoints); stop
persisting inotify events at TRACE by default; lazy thread-inventory scan; a
documented log-level knob.

## 2. Hard constraints (design invariants)

- **I1 — Lossless.** Never delete or risk Codex sessions/long-term state
  (`~/.codex/sessions/`, goals, memories, thread graph). Cleanup = checkpoint/VACUUM
  only, behind a **consistent** backup. Never `rm` live data (including `-wal` files).
- **I2 — No cap.** Unlimited simultaneous panes is the product's core value. Nothing
  here limits pane/session count.
- **I3 — Never touch a live pane** in steady-state operation. No reaper/teardown may
  signal a client-attached pane. The idle reaper's `clients.size > 0` skip
  (`terminal-registry.ts:1409-1422`) stays intact. **Explicit carve-out:** Stage 0b is
  a one-time, user-acknowledged **maintenance window** that terminates all codex
  processes, including live panes (§5). This is declared, consented downtime — not a
  steady-state behavior.
- **I4 — Never fail-closed at boot.** No fix may introduce (or leave) a "won't
  launch" path.
- **I5 — Accepted tradeoff.** Log dampening thins codex `/feedback` telemetry.

---

## 3. Stage 0-pre — Validate the dampening mechanism (RESOLVED 2026-07-06: ALL CANDIDATES FAILED — 0a DROPPED)

> **Outcome:** the full protocol was run the same night (see
> `2026-07-06-codex-launch-leak-s3-validation-results.md`). Best candidate
> achieved −25% vs the ≥90% bar; `RUST_LOG=off` proved the sink ignores the env
> filter entirely. **Candidate 3 (the drop path) is invoked: 0a is dropped**,
> the upstream issue is drafted in the results doc, and protection reduces to
> 0b + 1c observability + 1a/1c, with Stage 2 as the load-bearing fix.

The v1 plan bet its sequencing on `RUST_LOG=error` gating codex's SQLite log sink.
The first review demanded validation before implementation; an initial experiment was
run 2026-07-06 evening.

### Results so far (evidence, this machine, codex-cli 0.142.5)

| Test (idle TUI, 78 s, cwd=$HOME, pty) | Surviving attributable rows (post-prune **lower bound**) |
|---|---|
| Control — `RUST_LOG` unset | 1 |
| Treatment — `RUST_LOG=error` | ≥1,013 — **at the ~1,000-row prune ceiling** |
| Ambient — live pane population, no test proc | ~64k rows/min ≈ **22 MB/min** (measured incrementally — prune-immune) |

**Measurement caveat (second-review blocking #1, folded in):** codex prunes each
process's rows to a ~1,000-row bound (§1.2), so an end-of-window
`count(*) WHERE process_uuid=…` measures **survivors, not writes**. The treatment
figure sits exactly at the prune ceiling — it means "wrote **at least** 1,013 rows,
possibly far more." The control-vs-treatment numbers therefore support only the
**qualitative** conclusion — plain `RUST_LOG=error` demonstrably does **not** silence
the sink — and cannot quantify rates. The ambient 22 MB/min figure *was* measured
prune-immune (incremental `max(id)`/`estimated_bytes` deltas over a sampling window)
and stands.

**Conclusions:**
1. **Plain `RUST_LOG=error` is NOT validated** — evidence is negative.
2. **An idle, freshly-launched TUI is not the firehose.** The firehose is the
   long-running pane population (insert+prune churn, `TRACE`/`target=log` inotify
   events). Acceptance tests must use a representative long-running workload.
3. The binary embeds a default filter string
   (`codex_cli=info,codex_core=info,codex_login=info`) and the sink schema
   (`feedback_log_body`, `bounded_feedback_logs`), so a filter layer exists — the
   right directive just isn't confirmed yet.

### Required protocol before 0a is implemented (no code until one candidate passes)

- **Workload:** a freshell-spawned codex pane pair (app-server + resume) left running
  ≥15 min under inotify-generating conditions (cwd=$HOME), control and treatment run
  the same evening.
- **Metric — prune-immune, one of (second-review #1):**
  1. **Isolated-holder WAL-growth diff (preferred):** run the window when the test
     pair are the **only** `logs_2.sqlite` holders (immediately after the 0b quiesce,
     before restarting the servers — see §8 — or against a scratch `CODEX_HOME`).
     Sample `stat -c%s logs_2.sqlite-wal` every 10 s; compare total growth,
     control vs treatment.
  2. **Incremental insert attribution:** poll `max(id)` every 1 s on a `mode=ro`
     connection and accumulate new rows/`estimated_bytes` per test `process_uuid`
     **as they appear**, counting inserts before pruning can delete them.
- **Candidates, in order:**
  1. **Composite directive** (second-review #3):
     `RUST_LOG='codex_cli=info,codex_core=info,codex_login=info,log=off'`.
     Any `RUST_LOG` value **replaces** the binary's embedded default filter, so a
     bare `log=off` would silently reset every `codex_*` target — candidate strings
     must be composites of the embedded default plus the `log=off` (or `log=error`)
     suppression. **The §3 result record must capture the exact final directive
     string.**
  2. A codex `-c` config knob (candidate keys: `log.level`, `tui.*` logging toggles).
     Plumbing caveat (second-review verification #4): the managed-args channel
     (`CODEX_MANAGED_REMOTE_CONFIG_ARGS`, `codex-managed-config.ts:1-4`) reaches the
     app-server spawn unconditionally, but the pty path pushes it **only when
     `providerSettings.codexAppServer` is present** (`terminal-registry.ts:306`), and
     spawn site 3 (`codex exec`, `providers/codex.ts:483-501`) has **no `-c` channel
     at all** — the args-variant of 0a needs new plumbing for sites 2–3.
  3. If neither works: **0a is dropped**, the upstream ask is filed as the only
     firehose fix (the WAL-growth measurements from this protocol become the issue's
     evidence), and this plan's protection reduces to 0b + observability + 1a/1c
     (see §10 — recurrence in days-to-weeks of heavy use, now *detectable* instead of
     silent).
- **Pass bar:** ≥90% reduction in **measured write traffic** (WAL growth bytes, or
  incrementally attributed insert bytes) vs the same-evening undampened control, and
  the pane still functions (turn completes, rollout file written).

## 4. Stage 0a — Codex spawn-env log dampening (DROPPED — §3 candidates all failed; retained for reference)

### Change

One shared helper; the value is whatever §3 validated.

```ts
// server/coding-cli/codex-log-dampening.ts  (new)
// placeholder: exact composite string validated by §3
export const CODEX_LOG_DIRECTIVE =
  'codex_cli=info,codex_core=info,codex_login=info,log=off'

export function withCodexLogDampening<T extends NodeJS.ProcessEnv>(
  env: T,
  onSkip?: (reason: string) => void,
): T {
  // Consult ONLY the env the child will actually see (both call sites spread
  // process.env, so a separate process.env fallback is dead-or-wrong).
  if (env.RUST_LOG !== undefined) {
    onSkip?.('RUST_LOG preset') // set — even '' — is an explicit choice
    return env
  }
  if (process.env.FRESHELL_CODEX_LOG_DAMPENING === '0') {
    onSkip?.('kill switch')
    return env
  }
  return { ...env, RUST_LOG: CODEX_LOG_DIRECTIVE }
}
```

**Dampening-skip observability (second-review #6):** when the helper skips because
`RUST_LOG` is preset (e.g. a developer shell exporting `RUST_LOG` for unrelated Rust
work leaks into every codex child and silently disables dampening), emit one
structured `warn` per boot (deduped) via the `onSkip` callback. Fail-open must not be
fail-silent.

Call sites — **three** (review G1):

1. **App-server spawn** — `runtime.ts:1255-1259`:
   `env: withCodexLogDampening({ ...process.env, ...this.env, FRESHELL_CODEX_SIDECAR_ID: ownershipId })`.
   Covers all planner-owned and fresh-agent-adapter runtimes (they flow through this
   constructor — `index.ts:338`, `:372`).
2. **Resume-TUI spawn** — inside `buildSpawnSpec` (`terminal-registry.ts:~1059`) on
   the env it returns, **only when the pane mode is codex** (don't thin
   claude/opencode telemetry). Covers both pty consumers (`:1594` primary, `:3694`
   recovery; fed at `:1573`/`:3684`).
3. **`CodingCliSession` spawn** — `server/coding-cli/session-manager.ts:88-92`
   (spawns `codex exec --json …`/`codex resume …` via
   `providers/codex.ts:479-501`), currently `env: { ...process.env }` with no
   dampening. Apply the same helper when the provider is codex.

If §3 validated the `-c` knob instead, the helper becomes an args helper — noting the
plumbing gaps at sites 2–3 (§3 candidate 2 caveat).

### Platform note (review G3; anchor corrected per second review)

On a native-Windows host, `buildSpawnSpec` selects Windows-like handling at
`terminal-registry.ts:1127-1139` and wraps codex in `wsl.exe …` at `:1141-1149`; an
env var set on the Windows-side process does not cross into WSL without `WSLENV`. The
current deployment is WSL2-native (unaffected), but the helper's coverage is
platform-conditional; add `WSLENV` plumbing or document Windows-host as out of scope.

### Why safe

- Additive env/args; no lifecycle change; no effect on pane count (I2) or boot (I4).
- Only-if-unset guard: a developer's explicit `RUST_LOG` (any value, including empty)
  is never overridden — and the skip is logged (see above).
- Dampening gates codex's tracing sink only; sessions/goals/memories/thread-graph are
  written by normal code paths, not tracing (I1).

### Acceptance test

1. Repeat the §3 protocol (representative pane pair, 15 min, prune-immune metric)
   with the helper active: ≥90% write-traffic reduction vs an undampened control
   window run the same evening.
2. Unit tests: helper is a no-op (with `onSkip` fired) when `RUST_LOG` is preset
   (any value incl. `''`) or the kill switch is set; `FRESHELL_CODEX_SIDECAR_ID` and
   `this.env` overrides preserved; non-codex modes in `buildSpawnSpec` untouched
   (review G5); the skip `warn` is emitted once per boot.
3. Launch check: codex TUI reaches `Ready`; a turn completes; new rollout appears.

### Rollback

`FRESHELL_CODEX_LOG_DAMPENING=0` **plus a server restart** (env is read at spawn
time; there is no live-toggle — review F3), or revert the three call sites.

### User-facing risk

Sparse codex `/feedback` traces (I5, accepted). Masks — does not fix — the inotify
storm generation (upstream ask). **Severity: Low.**

---

## 5. Stage 0b — One-time lossless cleanup (maintenance-window runbook)

**What this is (honest framing):** a **declared maintenance window** that terminates
**all codex processes, including live attached panes**. In-flight codex turns are
lost (their transcripts up to that point are already on disk in rollout files).
Long-term state is untouched. Get explicit operator acknowledgment before starting.
This is the documented I3 carve-out (§2).

**Preconditions:**
- **Run from outside freshell** — an ssh/tmux/console session that is *not* a
  freshell pane (otherwise the runbook's own server is in the operator's ancestry and
  can never be stopped — the ancestry deadlock).
- Check for supervisors/watchdogs (`systemd`, pm2, `tsx watch`) that would restart a
  stopped server mid-window. Expect the window to last **minutes** (a ~6 GB VACUUM),
  not seconds.

### Runbook (ordered; each step gates the next)

1. **Consistent backup + provisional baseline (writers still live).**
   - `logs_2.sqlite`: **use `VACUUM INTO '<backup-dir>/logs_2.sqlite'`** — SQLite's
     online `.backup` restarts whenever another connection writes the source; at
     ~22 MB/min across ~20 writers it may never converge (second-review #5).
     `VACUUM INTO` takes a single consistent snapshot read.
   - Low-churn DBs (`state_5`, `goals_1`, `memories_1`):
     `sqlite3 <db> ".backup '<backup-dir>/<db>.sqlite'"` is fine.
   - Copy `history.jsonl`, `auth.json`, `config.toml` normally.
   - Verify `PRAGMA integrity_check` = `ok` on every backup. Record **provisional**
     row counts (final baselines at step 4).
2. **Announce + gracefully stop freshell servers (prod and dev — both hold the DB).**
   `SIGTERM`; their existing teardown (`index.ts:1078-1145` →
   `registry.shutdownGracefully`, `terminal-registry.ts:4891-4902`) reaps most codex
   children. Then **reap stragglers** — kill set from `lsof ~/.codex/logs_2.sqlite`
   filtered to codex cmdlines; dry-run and print first; protected-PID guard (never
   the operator's own session ancestry); **SIGTERM first, grace ≥10 s** (codex
   flushes rollout `.jsonl` appends on TERM), then SIGKILL survivors.
   **This straggler kill is load-bearing, not belt-and-braces** (second review):
   whether resume TUIs exit on SIGTERM/pty-close is an open question (§6 acceptance
   4), so plan on stragglers existing.
3. **Reach 0 holders.** `lsof ~/.codex/logs_2.sqlite` empty. Nothing may respawn
   (servers are stopped). **Belt-and-braces:** now also take plain file copies
   (`.sqlite` + `-wal` + `-shm` together) — the byte-identical restore set.
4. **Final baselines at 0 holders.**
   - **Schema check first (second-review #11):** verify the `logs` table declares
     `id INTEGER PRIMARY KEY` (explicit rowid alias) — VACUUM preserves rowids only
     for such tables; if it is an implicit rowid, drop the `max(id)` oracle and rely
     on `count(*)` alone.
   - Row counts: `sessions/` file count, `goals_1.thread_goals`, `state_5.threads`,
     `state_5.thread_spawn_edges`, `memories_1.*` (checkpoint `memories_1`'s WAL
     first before trusting counts), and **`logs_2` `count(*)` + `max(id)`** (for the
     VACUUM equality check).
5. **Checkpoint — never rm.** For each `~/.codex/*.sqlite` with a non-empty `-wal`:
   `PRAGMA busy_timeout=15000; PRAGMA wal_checkpoint(TRUNCATE);`
6. **Compact.** Prefer `VACUUM INTO '<new-file>'` (original untouched; verify the new
   file, then atomically swap). Plain in-place `VACUUM` is acceptable (crash
   mid-VACUUM rolls back transactionally). Requires 0 holders + free disk ≈ DB size.
7. **Verify.**
   - `PRAGMA integrity_check` = `ok` on all live DBs.
   - **`logs_2` `count(*)` (and `max(id)`, if step 4's schema check passed) equal
     step 4 exactly** — VACUUM must not change row population.
   - All other counts **≥ step-4 baseline with any delta explained** (nothing should
     write during the window; an unexplained delta = stop and investigate).
   - `sessions/` file count unchanged; holders = 0; `logs_2.sqlite-wal` = 0 bytes.
   - **Never auto-restore on a mismatch** (a stale-backup restore would itself
     destroy data). Mismatch = halt, investigate, decide manually.
   - Record **disk reclaimed ≈ prior WAL size + vacuumed dead pages** (measured
     figure — second-review #10; do not assume a fixed "~2 GB").
8. **Restart freshell servers**; restore-all respawns the (dampened, if 0a landed)
   generation; spot-check a codex pane reaches `Ready`.

*(Optional: between steps 7 and 8 is the ideal window for the §3 isolated-holder
WAL-growth measurement — the test pair are the only holders.)*

### Why safe

DB backups are snapshot-consistent (`VACUUM INTO`/`.backup` per churn level); the WAL
is folded in via checkpoint, never deleted; VACUUM preserves all rows (checked by
exact `logs_2` equality); baselines are taken at a quiesced moment so the oracle is
coherent; no `sessions/` file is ever touched; restore is a manual decision, never
automatic (I1).

### Rollback

Restore the step-1 snapshot backups (consistent by construction) or the step-3 file
copies (byte-identical, taken at 0 holders).

### User-facing risk

All codex panes terminate for the window (minutes); in-flight turns lost; panes
restore from rollouts afterward. **Severity: Medium** (declared downtime).

---

## 6. Stage 1a — Exception/signal-safe teardown on server exit

*(renamed from "crash-safe" — first review)*

### What `process.on('exit')` actually covers (honest enumeration)

**Covered:** normal exit (`process.exit()` — both the graceful path `index.ts:1144`
and the fatal path `:1153`), event-loop drain, default-fatal uncaught
exceptions/unhandled rejections, and signals we handle (SIGTERM/SIGINT/SIGHUP →
`shutdown()` → `process.exit`).
**Not covered:** `SIGKILL`, **V8 OOM abort** (a realistic failure mode for a leaking
long-lived server), native segfault/abort, unhandled default-fatal signals. Hard-crash
coverage requires the durable on-disk ownership + boot reaper (follow-up **1b**, out
of scope) — this stage narrows the orphan window; it does not close it.

### Change

1. **Registry** (`server/coding-cli/codex-child-registry.ts`, new): `{ pid, pgid,
   kind }` for every codex child.
   - app-server: pgid == `child.pid` (`processGroupId`, `runtime.ts:1291-1292`).
     Register on spawn. **Deregister only on confirmed group death** — after
     `teardownOwnedProcessGroup` returns `true` (`runtime.ts:692-734`), *not* at
     wrapper exit (`:1533-1575`), which can leave live grandchildren untracked.
   - resume pty: register `pty.pid` at both spawn sites (`terminal-registry.ts:1594`,
     `:3694`). **Deregister on the pty's `exit` event**, not in `kill()` (`:4008`
     only *sends* a signal).
2. **Bindings** (installed once, near `index.ts:1147-1148`):
   - `process.on('exit', reapSync)` — synchronous best-effort
     `process.kill(-pgid, 'SIGKILL')` per still-registered group, try/catch'd.
     Guards: only registered pgids; never `-1`/`0`/`1`/our own pgid; cheap sync
     identity re-check (`/proc/<pid>/cmdline` contains codex) before signalling.
     **Residual pgid-reuse window:** the sync check-then-kill race is narrower than
     nothing but wider than the async reaper's fresh-classification
     (`runtime.ts:698-711`); accepted at process-death time and documented.
   - `process.on('SIGHUP', …)` — route into the existing graceful
     `shutdown('SIGHUP')` (idempotent via `isShuttingDown`, `index.ts:1079`).
   - **Hard-exit timeout (specified — second-review #9):** arm a **15 s** timer
     (`.unref()`d) on `shutdown()` entry — **all three signals** (SIGTERM/SIGINT/
     SIGHUP share the identical hang exposure at `:1102-1113`) — that calls
     `process.exit(1)` if teardown hangs. Note: because `shutdown()` is invoked
     un-awaited (`:1147-1148`), a *throw* from `joinCodexShutdownOwners` already dies
     via unhandled rejection → `'exit'` → `reapSync`; the timer exists specifically
     for the **hang** case.
   - `process.on('uncaughtExceptionMonitor', …)` — **observe/log only.** The default
     fatal behavior of `uncaughtException` is left in place; the fatal path then runs
     `'exit'` → `reapSync`.
3. **Platform gating:** negative-pid group kill and `/proc` checks are POSIX/Linux;
   gate the registry's reap on POSIX and document Windows-host as out of scope
   (consistent with `assertUnixSidecarSupport`, `runtime.ts:360-364`).

### Why safe

`exit` cannot fire on a recoverable, *caught* error — a survivable blip can never
nuke live panes (I3). At true termination the children's transport is dying anyway;
reaping prevents orphan accumulation. Guarded, synchronous, try/catch'd; cannot block
boot (I4).

### Acceptance tests (made executable — second-review #7, #8)

1. Dev server + ≥2 codex panes. **Before termination, snapshot the registry** (a
   structured log line, or a test-only endpoint, listing registered `{pid, pgid}`).
   Terminate via `SIGHUP` and via normal exit → every snapshotted pid is gone.
   Additionally scan surviving processes' `/proc/<pid>/environ` for
   `FRESHELL_CODEX_SIDECAR_ID` (app-servers — `runtime.ts:1258`) **or**
   `FRESHELL_TERMINAL_ID` (resume ptys — `terminal-registry.ts:1538`; ptys do **not**
   carry the sidecar id) matching this instance → none found. (Bare `pgrep` cannot
   scope to one instance — prod + dev coexist.)
2. **Uncaught-exception test:** throw an uncaught exception → process dies →
   snapshotted groups are gone. The I3 property is asserted **structurally** (not as
   a universal negative): the group-kill primitive has exactly one caller
   (`reapSync`), and `reapSync` is referenced only from the `'exit'` binding —
   enforce with a unit/lint test on the module graph.
3. `SIGKILL` the server → survivors expected; documented boundary (1b's job).
4. **Empirical check:** verify whether the codex resume TUI exits on pty-master close
   (kernel SIGHUP). If codex ignores it, resume ptys outlive the server on paths 1a
   doesn't cover — record the result; it sets 1b's priority and 0b step 2's
   straggler expectations.

### Rollback

Remove the three listeners + registry wiring; behavior reverts to
SIGTERM/SIGINT-only.

### User-facing risk

None in steady state. SIGHUP now tears down a dev server left in a closing terminal.
**Severity: Low.**

---

## 7. Stage 1c — Startup reaper: complete fail-open + minimal observability

### Change

1. **Per-record isolation.** Wrap the *per-record* body of the reap loop
   (`runtime.ts:808-848`) in try/catch so an unreadable record file (`:811` —
   permissions, torn write) affects only that record (introduce the `unreadable`
   classification the plan names but the code lacks). Treat non-ENOENT `readdir`
   failures (`:803-806`) and an unavailable `/proc` ownership proof (`:800`,
   `:360-379`) as **degrade-and-continue** (log, skip reaping this boot), not aborts.
2. **Backstop.** try/catch around the `runCodexStartupReaper` call at `index.ts:256`:
   log and continue. Boot must never die in the reaper (I4).
3. **Quarantine — only for records whose process group is confirmed GONE, or
   unparseable records (second-review blocking #2).**
   - **Unparseable/corrupt record** → quarantine (nothing to retry against).
   - **Owner dead + group confirmed gone** → normal happy path (record deleted).
   - **Owner dead but group STILL ALIVE** (`teardownOwnedProcessGroup` returned
     `false` — the group survived SIGTERM+SIGKILL, `runtime.ts:714-729`, e.g. a codex
     process in D-state I/O against the bloated WAL — this incident's exact
     signature) → **NEVER quarantine.** The record is the only tether to a live DB
     holder; retry in place with backoff.
   - **Owner alive but identity-mismatched** (`runtime.ts:826-831` — reachable via
     transient `/proc` races) → retry in place with backoff.
   - **Safety net:** each boot, the reaper also **rescans `quarantine/`** for records
     whose pgid is still alive and promotes them back for retry (no permanent
     invisible holder can hide there).
   - Quarantine moves are atomic renames preserving `0600` (records embed command
     lines and cwd's — review G6), with a `{ reason, firstSeen, attempts }` note.
4. **Backoff state — concrete home (second-review #4).** Retry state lives in a
   sidecar file **`<record>.reaper.json`** next to the ownership record (atomic
   write, `0600`, `{ firstSeen, attempts, lastAttempt }`; `firstSeen` falls back to
   the record's mtime). It is written only by the reaper, so it cannot race the
   owning server's own record rewrites (`runtime.ts:1297-1300`). Semantics: the
   per-boot reap attempt **always runs**; backoff gates only **log escalation**
   (info→warn after N attempts) and the **hourly** re-attempt frequency (below) — it
   never defers the boot-time decision. Time-based (keyed on `firstSeen`), so shared
   prod+dev dirs and `tsx watch` restart storms cannot burn the budget; on concurrent
   boots, rename-ENOENT = the other instance won (treat as success).
5. **Observability — concrete home (second-review #4; review G4).** New module
   **`server/coding-cli/codex-observability.ts`**, started from `index.ts` at boot:
   emits one structured line at boot and then on an **hourly `setInterval(...).unref()`**
   timer:
   `codex-log-db: wal_bytes=<stat logs_2.sqlite-wal> holders=<count via /proc fd scan> quarantined=<n>`
   with `warn` when `wal_bytes > 500 MB` or holders exceed a threshold. Read-only —
   `stat` + `/proc` fd scan; **never opens the SQLite DB, never signals anything.**
   This module also hosts the hourly retry of live-group records (step 3/4) and the
   quarantine rescan trigger. Converts every silent failure mode in this plan (0a
   ineffective, 1c lingering holder, regrowth) into a detectable one.
6. **Remove the fail-closed assert.** `assertCodexStartupReaperSucceeded`
   (`runtime.ts:863-876`) is deleted/reduced to a warning aggregator. **Test impact
   is a contract inversion:** ~12 assertion sites in
   `test/unit/server/coding-cli/codex-app-server/runtime.test.ts` (`:1440-1787`)
   assert the throwing contract — rewrite to assert no-throw + quarantine/backoff
   behavior. The exported alias `reapOrphanedCodexAppServerSidecarsOnStartup`
   (`runtime.ts:861`) is referenced nowhere (including tests) — delete it.

### Why safe

Fail-open at every layer (I4); reap decisions still require the same ownership proof
(I3 unchanged); quarantine can no longer hide a live process (confirmed-gone-only +
rescan); the monitor is observation-only.

### Acceptance tests

1. Seed a record for a dead owner whose group is gone but the record is stale →
   server boots; record quarantined `0600`; warning logged.
2. Seed an **unreadable** record file (chmod 000) → server boots; that record
   isolated; others still processed.
3. Simulate `/proc` proof unavailable → server boots; reaping skipped with a warning.
4. Seed an alive-but-mismatched record → retried in place with backoff state in
   `<record>.reaper.json`; **not** quarantined; still present next boot.
5. Seed an owner-dead-**group-alive** record (mock teardown returning `false`) →
   **not** quarantined; retried; hourly timer re-attempts.
6. Plant a quarantined record whose pgid is alive → rescan promotes it back for
   retry.
7. Reapable orphan → still reaped exactly as before.
8. Boot line appears with correct WAL size/holder count against fixtures; `warn`
   fires above thresholds; verify the monitor holds no fd on the SQLite files.

### Rollback

Restore the assert (one function); disable the observability module.

### User-facing risk

Ambiguous records now linger (flagged, retried with backoff) instead of blocking
boot. Strictly better availability. **Severity: Low, net-positive.**

---

## 8. Deploy choreography (ordering reconciled — second-review #10)

Deploying 0a/1a/1c requires restarting freshell — **prod and dev both** (both hold
the DB). A restart is itself a pane-recycling event (graceful teardown + restore-all).
Sequence the whole rollout as **one declared window**:

1. Merge 0a (if §3 validated) + 1a + 1c.
2. Announce the maintenance window (§5 framing).
3. **Run the 0b runbook from its step 1.** Note the ordering inside 0b: the
   snapshot backups (step 1) happen **while writers are still live, before the
   servers stop** (step 2); the servers then remain stopped through step 7.
4. *(Optional)* run the §3 isolated-holder measurement in the 0 holders window.
5. Restart both servers (0b step 8).
6. Post-checks: pane reaches `Ready`; boot observability line shows
   `wal_bytes≈0, holders == 2×(open codex panes)`; over the next day, the hourly line
   shows WAL bounded (0a working) or growing (0a failed → §10).

## 9. Sequencing & dependencies

```
§3 validation experiment  ──►  0a implementation (only if a candidate passes)
1a, 1c                    ──►  independent; implement in parallel with §3
merge (0a?, 1a, 1c)       ──►  §8 window: 0b (backups live → stop → clean → restart)
boot/hourly observability ──►  ships inside 1c; watches everything afterward
```

- 0a and 0b remain complementary: 0a (if validated) shrinks churn volume; 0b clears
  the accumulated WAL/dead pages. Neither reduces holder count — that is Stage 2's
  job (out of scope).
- 1b (durable resume-TUI ownership + boot reaper) is the committed follow-up that
  closes 1a's SIGKILL/OOM boundary.

## 10. Residual risk (honest statement)

- **Holders remain by design** (I2/I3): ~2 codex processes per open pane keep the DB
  open around the clock. This plan does not change that.
- **If §3 validates a knob:** WAL churn ≈ 0; the cliff should not recur before
  Stage 2 lands. Remaining exposure: the knob's behavior under codex upgrades
  (watched by the hourly line).
- **If §3 fails:** churn continues at ~22 MB/min of active use; the WAL re-approaches
  the cliff in **days-to-weeks**. The observability line makes this loudly visible
  (500 MB warn threshold ≈ weeks of margin before the ~5 GB wedge), 0b can be re-run
  as a stopgap during any maintenance window, and the §3 measurements ship with the
  upstream issue. Stage 2 (shared app-server, holders==1) becomes urgent.
- 1a/1c reduce orphan accumulation and boot fragility but do not change WAL
  mechanics.

## 11. Constraint traceability

| Constraint | Honored by |
|---|---|
| I1 lossless | 0b: snapshot-consistent backups (`VACUUM INTO` for the churning DB), checkpoint/VACUUM only, exact `logs_2` row/`max(id)` equality check (schema-verified), **no auto-restore**; 1a/1c reap processes, never data; rollouts remain source of truth |
| I2 no cap | No stage limits panes; observability is read-only |
| I3 no live-pane kills (steady state) | 1a binds `exit` (cannot fire on recoverable errors) with the structural single-caller assertion; monitor observe-only; 1c reaps only with the same ownership proof, retries ambiguity in place, and can no longer hide a live group in quarantine; idle-reaper attached-pane skip untouched. **0b is the one declared, consented exception** (maintenance window, §5) |
| I4 no new won't-launch | 1c: per-record isolation + degrade-and-continue + backstop try/catch (covers `:800`, `:803-806`, `:811`, `:863-876`); 0a additive; 1a exit-path only, try/catch'd, hard-exit timer bounded |
| I5 telemetry tradeoff | 0a documented, only-if-unset (incl. `''`), skip-logged, kill switch (restart required — stated honestly) |

## 12. Definition of done

1. **§3:** a documented pass/fail per candidate using the prune-immune metric,
   including the exact final directive string; 0a proceeds only on a pass (≥90%
   write-traffic reduction on the representative workload).
2. **0a (if implemented):** acceptance re-run post-deploy passes; unit tests green
   (incl. `''`-preset, kill switch, `this.env`, sidecar-id preservation, non-codex
   modes untouched, skip-warn emitted); TUI `Ready` + turn completes.
3. **0b:** integrity `ok`; `logs_2` `count(*)` (and `max(id)` if schema-verified)
   exactly equal step-4 baseline; other counts ≥ baseline with deltas explained;
   `sessions/` count unchanged; holders 0 at completion; WAL 0 bytes; **disk
   reclaimed ≈ prior WAL size + vacuumed dead pages (measured figure recorded)**;
   no auto-restore occurred.
4. **1a:** SIGHUP/normal-exit → zero survivors (registry-snapshot + environ-scan
   assertion incl. `FRESHELL_TERMINAL_ID` for ptys); uncaught-exception path reaps;
   structural single-caller assertion in place; 15 s hard-exit timer on all three
   signals; pty-master-close behavior of codex recorded; POSIX-gated; Windows
   documented out of scope.
5. **1c:** all eight acceptance tests pass, including the three formerly-fatal boot
   paths, the owner-dead-group-alive no-quarantine case, and the quarantine rescan;
   test-suite contract inversions completed (~12 sites) and the unreferenced alias
   deleted; boot/hourly observability line live with thresholds from
   `codex-observability.ts`.
