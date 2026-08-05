# Parity Campaign — Learnings Ledger (fable, overnight 2026-08-05)

Running log of key learnings from the massively-parallel-agent campaign.
Each entry: timestamp, category (PROCESS / TECH / REPO), learning.

## Entries

- **00:15 REPO** — Live Rust server runs on port **3001** (`.env PORT=3001`, pid file
  `rust-server-3001.pid`), not 3002 as AGENTS.md claimed. Launcher default is still 3002.
  Fixed in AGENTS.md. Lesson: verify runtime facts (`ss -tlnp`, pid files) before trusting docs.
- **00:16 REPO** — Rust server auth: `Authorization: Bearer` and `?token=` are REJECTED;
  only `X-Auth-Token: <token>` works for `/api/server-info`, `/api/debug`. `/api/perf` is a
  POST toggle (enables debug/perf logging), not a metrics reader.
- **00:18 TECH** — Suspected parity gap found before audit even started: Node has
  `server/perf-logger.ts` (cpuUsage/memoryUsage/rss sampling); no equivalent sampling code
  found in `crates/` (no sysinfo, no /proc/self/stat readers).
- **00:20 PROCESS** — Prior campaign hazard (from 2026-07-17 status doc): shared-index
  commit absorption. Standing rule: agents commit with explicit pathspecs (`git commit -- <files>`).
- **00:27 PROCESS** — Amplifier bash tool with `run_in_background=false` kills the process
  group on timeout — a `nohup ... &` inside a normal call still died. Long-running jobs MUST
  use `run_in_background=true`.
- **00:27 PROCESS** — opencode parallel dispatch (validated earlier): each agent needs its
  own working directory; concurrent first-run `.opencode` init in a shared fresh dir loses
  runs silently. `--auto` required for non-interactive file writes.
- **00:38 TECH** — Baselines on main (4eecc456c): `cargo test --workspace` EXIT 0 (all green);
  `npm test` = unit/default suites fully green; server suite has exactly ONE pre-existing
  failure: `api-edge-cases.test.ts > rejects __proto__ in request body (strict schema)`.
  Matches the coordinator's remembered `test:server=failure`. Treating as pre-existing;
  final gate = "no NEW failures vs this baseline".
- **00:38 PROCESS** — 18 read-only Kimi auditors + full cargo build + npm suite concurrently:
  load peaked ~31 on 32 cores, 21-23Gi available. Read-only agent waves are cheap locally
  (the heavy lifting is remote inference); builds are the local bottleneck.
- **00:38 PROCESS** — Kimi-K3 inside opencode spontaneously self-parallelizes: the config
  auditor announced "dispatch parallel explore agents" — opencode agents can spawn their own
  subagents. Amplification is nested; budget/watch accordingly.
- **00:56 PROCESS** — AUDIT WAVE 1 FAILURE MODE: 17/18 auditors hit the 25-min timeout with
  ZERO output. Only the 4-item section finished (superb quality). Causes: (a) batches too big
  (8-27 items × Kimi's thorough style), (b) output written only at the END — a timeout
  forfeits all work. Fixes adopted: write output INCREMENTALLY (item by item), and resume the
  timed-out sessions (`opencode run -c`) with a "dump what you have NOW" instruction — the
  exploration context is preserved in the session, so recovery is cheap vs restarting.
- **00:57 PROCESS** — Pipeline waves: don't serialize phases. Launched the DIAG-04 (perf
  logging) implementation worker from orchestrator-verified context while audits still run.
- **05:30 PROCESS** — Rebase-in-worker works for conflicts: EXT-01's cherry-pick conflicted
  with landed EXT-02/EXT-04 changes; instructing the worker session to `git rebase
  parity-campaign-20260805` in its own worktree and integrate both behaviors resolved it
  without orchestrator hand-editing. Reserve orchestrator manual resolution for trivial
  conflicts (SYNC-02's import-formatting conflict took 2 minutes by hand).
- **06:20 PROCESS** — Salvage-the-dirty-work pattern: SESSION-04's fix session timed out AFTER
  fixing both compile errors but BEFORE amending. The orchestrator amended the worker's dirty
  changes directly — always inspect a "failed" worker's worktree before retrying; the fix is
  often already sitting there uncommitted.
- **06:45 PROCESS** — Environment-sensitive tests are a Kimi blind spot: AUTO-10's real-shell
  route test failed 3 identical rounds until explicitly instructed to make it deterministic
  (seed registry state instead of spawning a shell). Workers don't internalize "your test runs
  on a different host" without being told.
- **07:00 STATS** — Final tally: 28 checklist items landed + 1 AUDIT_WRONG (already done) +
  1 dropped (SESSION-21: 3 sessions, zero output) + 1 cut at deadline (AUTO-05, dirty
  uncommitted). ~35 Kimi worker/auditor/fix sessions total. Every landed diff passed
  targeted cargo/vitest verification on the integration branch; full workspace gates run at
  the end. First-pass worker success ~30%; with fix loops + fresh-session recovery ~90%.
