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
- **01:15 PROCESS** — Audit spot-checks (SAFE-01, SESSION-10, TERM-28 DONE claims): evidence
  citations check out against real code (e.g. validate_auth_token at main.rs:1554 confirmed).
  Kimi audit quality is high WHEN it finishes.
- **01:23 PROCESS** — The AUDIT_WRONG escape hatch works: SYNC-06 worker independently
  discovered the feature already landed (PR #592) and refused to invent work instead of
  fabricating a diff. Give every worker an explicit honest-stop path; it converts audit
  false-positives from wasted diffs into free re-verification.
- **01:24 PROCESS** — Continuous-flow beats discrete waves: verify+merge each worker the
  moment it commits (SESSION-14 landed while 6 peers still ran). Shared CARGO_TARGET_DIR
  with the main checkout's warm 28G cache made worktree builds fast instead of cold.
- **01:50 PROCESS** — Topology B (write-only workers + central serial build) first results:
  6 committed items -> 2 passed unchanged, 3 failed with exactly ONE failing test each
  (their own new tests — assertion bugs), 1 landed after review. Fix loops via
  `opencode run -c` with the exact panic output are cheap.
- **01:55 PROCESS** — Timeouts must be sized to Kimi's thoroughness: 40-min impl timeout was
  too short for M items (DIAG-04, SESSION-21 both hit it mid-flight). Plan 45-60 min for
  M-effort items, and instruct WIP commits.
- **02:00 PROCESS** — `git branch --list` prefixes worktree-checked-out branches with `+`;
  scripting refs from its porcelain output silently breaks (use --format='%(refname:short)').
- **02:07 PROCESS/PERF** — DANGER SPIKE: load hit 148 (32 cores), availG down to 13Gi when a
  4-item cargo verify chain overlapped 8 live agents + 2 session resumes. Recovered without
  crash; rule adopted: at most ONE verify chain at a time, no new agent launches while a
  chain runs.
- **02:11 PROCESS** — Fix-loop effectiveness: 3/3 failed items passed on re-verify after one
  resume round with exact panic output. Wave-1 Rust yield: 8/8 attempted items landed or
  honestly closed (7 merged + 1 AUDIT_WRONG).
- **02:38 PROCESS** — TS/client items are the cheapest wins: SYNC-01/03 (test-coverage gaps)
  passed vitest first-try. Two workers touching the SAME test file sequentially (fork after
  the first lands) avoids conflicts entirely. Slot-refill discipline: worker slots are cheap,
  orchestrator attention is the scarce resource — batch status checks and resume in groups.
- **04:15 PROCESS** — DIAG-04 escalation path: after FOUR Kimi sessions timed out on the same
  M item (each produced good docs/skeleton but kept exploring), the orchestrator implemented
  it directly reusing the sessions' module docs as the spec. Cap retries at ~3, then split
  the item into S-slices or escalate. Sunk subagent work (docs, skeletons) is still input.
- **04:23 PROCESS** — FRESH sessions beat resumed sessions for stuck items: BROWSER-02 and
  AUTO-10 both committed within ~35 min of a fresh-session restart pointed at their own
  dirty worktrees, after resume rounds failed repeatedly. Resumed sessions inherit
  exploration momentum; fresh ones inherit only the artifacts.
- **04:29 TECH** — My own DIAG-04 first verify failed on a trivial Rust lifetime error in a
  test helper — the same class of single-test failure the Kimi workers produce. The central
  build catches everyone equally; nobody skips verification.
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
- **09:15 PROCESS** — NOTE-KEEPING BUG FOUND POST-CAMPAIGN: twelve mid-campaign entries
  (01:15-04:29) were silently destroyed during the night because the verify script's
  failure path ran `git reset --hard` in the SAME worktree where LEARNINGS.md appends sat
  uncommitted. Restored from the orchestrator session transcript. Rule: a ledger that lives
  inside a worktree subject to reset/cherry-pick automation must be committed on EVERY
  append (or kept outside the build tree entirely).
- **10:55 PROCESS/QA** — QA-panel experiment (16 lenses on files.rs). Verification plumbing
  ate 3 wrong attempts before the right one: (1) shared CARGO_TARGET_DIR served slot-01's
  cached test binary to all 16 worktrees (WSL2 stale-rlib footgun, AGENTS.md-warned);
  (2) a fresh dedicated target dir hit an unrelated cross-crate error; (3) per-slot builds
  same staleness. WINNER: concatenate all 16 uniquely-named qa_probe_NN modules into ONE
  files.rs, compile+run ONCE, attribute results by module path. One bad module fails the
  whole build → bisect by line→module, exclude the 2 non-compiling ones, rebuild. Lesson:
  for N parallel code artifacts that share a package, verify them in ONE build with unique
  namespaces, not N builds sharing a target.
- **10:55 QA** — Panel result: 14 compiling lenses → 65 failing proof tests → 17 clusters;
  narrow adversarial lenses (breaker, spec-clause) beat broad "review this" 3:1; lens
  DIVERSITY adds clusters, lens REPETITION doesn't; 5-lens set-cover reproduces 100%.
  Flagship (empty-string allowedFilePaths disables sandbox) found by 7 independent lenses
  and adjudicated REAL by reading is_path_allowed (files.rs:733). Proof-only rule kept
  false alarms to 1/66.
