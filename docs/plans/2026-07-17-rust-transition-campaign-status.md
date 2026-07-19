# Rust Transition Campaign — Status (updated 2026-07-18 ~04:00, overnight run)

## Overnight run 2026-07-17→18 (waves 1–6, all pushed through 7905f102)

Seventeen commits landed, each TDD'd, adversarially reviewed, and gate-verified:
- **Codex-first headline:** found + fixed a REAL parity defect — Rust codex snapshots wedged
  `capabilities.send:false` after a turn (composer permanently disabled in the browser);
  root cause a stale in-memory `active_turn` OR'd into `is_running` (94a3ca94). Also: codex
  crash-recovery now RESUMES the same thread (memory preserved) instead of minting a new one.
- Structured JSONL logging + rotation + writer-level redaction (d5a526d3, beyond legacy — legacy
  has NO redaction); config backup + conservative auto-restore (41b04143 — legacy's own corrupt-boot
  path destroys its backup; ours doesn't); graceful shutdown + child reaping w/ 5s watchdog +
  stale-pid group-kill hardening (edf1e93d, a8d43d9d — sandbox-proven zero orphans);
  SESSION-09 live sidebar (sessions.changed sweep + write-site broadcasts, unified revision counter:
  0db588c4, b068d28b, 0855e27f, 7905f102); checkpoints list/restore/metadata (96e354ea — restore
  file-safety pinned: never deletes post-checkpoint files); narrow live settings reload
  (f766ad6c — idle-kill + scrollback apply without restart, Playwright-proven both kinds);
  restore-matrix scenario 3 fixed + SYNC-05 quiet-restart spec (8fd9233a — green both kinds);
  matrix conversions TERM-02/AGENT-02/TERM-18/SESSION-01/AGENT-08 (33f7b015, d4b8630a).
- **Checklist:** reconciliation doc (2026-07-18-checklist-reconciliation.md: 93 PARTIAL / 72
  no-evidence / 66 host-limited) + evidence-cited checkbox updates: now **4/233 checked**
  (TERM-02, TERM-18 new) + 14 items annotated PARTIAL with exact missing clauses.
- **Final gates at 7905f102: ALL PASS** — 889+145 cargo tests, oracle 99/99 (deep-equal true),
  Playwright matrix 79 passed / 2 failed (= the pre-existing multi-client flake, both kinds,
  deterministic on retry), sandbox shutdown acceptance green.
- **Staging (17874) redeployed + verified:** cold boot built the 22.5MB parse cache in 100s;
  **restart-to-sidebar now 2s** (was ~5min); checkpoints + structured logs live.
- **NOT done: :3002 bake-in still runs the 2026-07-17 binary** — restart needs user approval
  (live sessions). One command deploys everything above to it.
- Known debris: three shared-index commit-absorption incidents (all disclosed, content verified,
  attribution notes in commit bodies); sandbox cargo-target volume can serve stale rlibs after
  big rebases (`docker volume rm freshell-sandbox-cargo-target` clears; noted in gate report).

## Morning wave 8 (2026-07-18, post-incident)

- **17874 incident**: overnight staging restarts blanked the user's 6 live tabs. Root-caused to
  three CLIENT defects (claude-only lost-recovery guard; restore_unavailable persisting blank
  replacements; one-shot restore) — fixed on MAIN branch `restore-resilience` (c8ab9e9c, reviewed
  APPROVED ready-for-PR, awaiting user PR approval). User sessions recovered via rollout copies +
  codex resume commands. Rule extended: NO restart of ANY server without user approval.
- Landed on the port branch: SESSION-07 search tiers + pagination (bb29e9db), TERM-09/SAFE-06
  bounded output + frame limits (15b48427), CFG-07 persistent instanceId + DIAG-05 debug/perf/
  server-info (a2d23d4d), SAFE-08 diagnostics arm + SAFE-10 lag resync-close (61dc23e7),
  wave-8 specs doc (348b0ace), diag01 deflake (c62385ab).
- Checklist: PARTIAL/MISSING annotations added for SESSION-07, TERM-09, SAFE-06.
- Frozen-paths / bisectability record addition: bb29e9db does not build standalone (absorbed
  15b48427's main.rs wiring via the shared index — third occurrence). Mitigation now standing:
  agents MUST commit with explicit pathspecs (git commit -- <files>).
- :3002 now binds 0.0.0.0 (WSL localhost-relay failure workaround; same posture as legacy,
  protected by SAFE-01/03). Runs c62385ab binary; wave-8 commits await next approved restart.

# (previous snapshot below, 2026-07-17 morning)

**Goal:** seamless daily-driver switch to the Rust server, used from Chrome on Windows,
with all settings and state carried over. The user's declared core requirement: **restore
is bulletproof** (reload/reopen/restart always brings everything back).

**Branch:** `feat/rust-tauri-port` (pushed through `2d7612b5`). Frozen reference paths
(`server/`, `shared/`, `src/`) byte-untouched throughout — verify with
`git diff --name-only server/ shared/ src/` (must be empty).

---

## Where things stand

### Proven ready (deterministic evidence)
| Area | Evidence |
|---|---|
| Sessions sidebar at real scale (6,208 claude + 6,951 codex + opencode 4.6GB db) | staging measurements: cold ~2s, warm 46ms, post-TTL ~160ms (was 5–7s) |
| Lossless config writes (545 renames, secrets, migrations survive) | Batch A tests + staging write-probe zero-loss |
| Session actions (rename/archive/generate-title) + overrides cross-provider | smoke + matrix tests |
| Terminals, reload reattach, server-restart recovery | `restore-matrix.spec.ts` scenarios 1+4 green BOTH projects |
| Fresh-agent reload restore (create-with-resume contract) | `restore-matrix.spec.ts` scenario 2 green BOTH projects, 2 runs each |
| WS keepalive (idle sockets no longer die; was: zero pings) | `764242c4` + browser: 0 reconnect errors vs 7 baseline |
| Fresh-agent wire-shape parity vs legacy | differential oracle `test/unit/port/oracle/freshagent-wireshape-differential.test.ts` |
| Full gates | 850+ Rust tests, 98 oracle tests (incl. 28/28 mutation catches), Playwright matrix expected-profile |

### Campaign commit log (transition work, oldest first)
```
6e3af242 lossless config writer (Batch A)
5c020be3 session-directory index (Batch B)   ffa83d0c incremental refresh (B-fix)
408d0cdb codex+opencode sources (Batch C)
05fa66c5 codex WS interrupt/kill/self-heal (D PR-1)
b1b853d1 opencode WS runtime + continuity (D PR-2)
f7358d04 opencode serve-stream bridge (D PR-3)
0d46bc3a attach rehydrate + codex lazy-restart (D PR-4)
0002a1d0 threads snapshot REST endpoint (D PR-5)
d78e1f01 amplifier terminal mode manifest (Batch E)
ff8edc71 rich transcript items (D PR-6)      f4cd1abf role/splitting + think-tags (PR-6 fix)
e5670aec session-metadata route + codex ensure-runtime + includeTurns fallback
42f24759 tolerate unknown codex item types   ff3a5da0 30s thread-read budget
89f4b2fe attach resumes persisted sessions   b9e0c1a3 pane titles + exit surfacing
764242c4 WS keepalive                        58089d12+40ef4d9d restore-matrix suite
b4a3e5b9 attach double-snapshot fix + wireshape differential
a220d84e checkpoints endpoint (create-only)
d5cf534a naming cluster: PATCH /api/panes/:id, rename cascades, sidebar live-terminal join
```
(Interleaved `style:` commits are verified formatting-only.)

### Open items (honest list)
1. **d5cf534a review pending** (naming cluster) — adversarial review queued; all tests green + T0 oracle green.
2. **Fresh codex terminal residual sidebar duplicate** — session id unknown at spawn; needs the
   deferred association scanner (SESSION-09 slice). Documented, pinned by test.
3. **restore-matrix scenario 3** fixme (sidebar seeded-session visibility in that spec; both kinds).
4. **multi-client reconnect flake** — fails on BOTH server kinds + untouched baseline (pre-existing).
5. **Codex crash-recovery mints a new thread id** (no thread/resume on crash path) — UI continuity ok,
   model memory not preserved. Follow-up.
6. Checkpoints: create-only ported; list/restore deferred. Directory perf 0.55s multi-provider vs
   legacy 0.2s (fine for daily use; tracked).
7. Frozen-legacy finding: legacy-at-base **cannot run FreshCodex with codex-cli 0.144.5** at all —
   Rust exceeds the frozen baseline for fresh-agent; recorded as deliberate deviations.

## Relationship to the 233-item parity checklist

The full acceptance checklist lives at
`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` — **233 items, 2 formally
checked (HARNESS-01, HARNESS-02), 231 unchecked** as of this snapshot. Its bar is strict:
an item is checked only when its *stated* acceptance evidence (generally an isolated-home
Playwright test driving the real binary) has actually passed — implementation alone does not count.

The transition campaign above implemented substantial behavior behind many unchecked items
(config/CFG, session-directory/SESSION, fresh-agent/AGENT, terminal/TERM, WS lanes) and landed
reusable evidence machinery (the legacy/rust matrix, restore suite, wire-shape differential).
A reconciliation pass — mapping campaign evidence onto checklist IDs and checking off what now
genuinely qualifies — has NOT been done and is the natural next campaign task after cutover.
Do not infer checklist completion from the campaign log; the checklist is the source of truth
for what is *proven*, this doc for what is *built and working for the daily-driver goal*.

## Environments (as of this doc)
- **Live daily driver (do NOT touch):** legacy Node on `:3001` (pid 3381928, HOME=/home/dan).
- **Staging (Rust, real-data clone):** `http://localhost:17874/?token=<see /home/dan/freshell-qa/token.txt>`
  — HOME=/home/dan/freshell-qa/home-real-staging, pid file /tmp/freshell-qa-staging.pid,
  log /tmp/freshell-qa-staging.log. Restart: rebuild `cargo build --release -p freshell-server`
  in the worktree, kill pid-file pid, relaunch (same env; GOOGLE key sourced from the 17871
  process env). Clone snapshotted 2026-07-16 ~20:00; safe to mutate.
- **QA pair:** legacy `:17871` (pid 1660395) vs rust `:17872` (pid 2333544), QA homes under
  /home/dan/freshell-qa/ — used for side-by-side comparison.

## How to re-verify (the gates)
```bash
cargo test --workspace --exclude freshell-tauri && cargo test -p freshell-tauri
cargo build --release -p freshell-server
FRESHELL_TEST_SUMMARY="oracle gate" npm run test:vitest -- --config config/vitest/vitest.oracle.config.ts \
  test/unit/port/oracle/{t0-equivalence-rust,t1-equivalence-rust,t1-batch-equivalence-rust,mutation-validation,mutation-e2e}.test.ts --run
npx playwright test --config test/e2e-browser/playwright.config.ts --project=legacy-chromium --project=rust-chromium
```
Expected: all green except the annotated settings-persistence expected-fail (rust), the known
multi-client flake (both kinds), restore scenario-3 fixme skips.

## Self-hosting readiness plan (checklist triage, 2026-07-17)

Full 233-item triage for long-term self-hosting (SRE lens; desktop/installer items excluded):
**3 blockers, ~54 soon-after, ~68 nice-to-have, rest done/out-of-scope.**

**Fact that shapes the plan:** the live legacy server binds `0.0.0.0:3001` (LAN-reachable)
even though `settings.network.host` says `127.0.0.1` — so if any non-localhost device uses it,
the security gate is PRE-cutover, not optional.

- **Phase 0 — pre-cutover verification (no new code):**
  CFG-10 (boot-twice migration losslessness on a real-home clone),
  SESSION-03 (verify UI delete is SOFT — never removes provider .jsonl),
  binding decision (loopback-only vs 0.0.0.0 like today).
- **Phase 1 — security gate (required if 0.0.0.0):** SAFE-01 (auth hardening: reject
  empty/weak/conflicting token sources), SAFE-03 (WS Origin policy). Then NET-01/02/06/10 for a
  deliberate expose/retract surface; SAFE-02/04/06, FILE-05/06, BROWSER-04, AGENT-16 before
  untrusted-LAN trust.
- **Phase 2 — long-uptime hygiene (first week):** SAFE-11+TERM-22 (graceful shutdown + child
  reaping for every update restart), TERM-11 (honor autoKillIdleMinutes — SET in the user's real
  config, currently ignored), TERM-13 (honor terminal.scrollback — currently fixed 8MiB),
  TERM-09/SAFE-06 (output/frame bounds), DIAG-01/03 (structured logs + rotation + secret
  redaction — disk-fill protection), CFG-03 (config backup/restore), CFG-07/08+AUTO-15 (stable
  instance id + durable tab registry for multi-device), SESSION-09 (live sidebar updates),
  SAFE-08/10 (restore-loop prevention, broadcast-lag resync).
- **Phase 3 — as-used features:** checkpoints list/restore (AGENT-14), attachments (AGENT-11),
  fork/compact (AGENT-04/07), orchestration REST/MCP (AUTO-01..14), extensions (EXT-*),
  browser/file panes (BROWSER-*/FILE-*), search depth (SESSION-07/19).
- **Cross-cutting — SYNC-00:** this branch predates recent `main` work (#514 amplifier durable
  session tracking, editor-font-follows-terminal); cutover temporarily trades those away.
  Schedule a main-reconciliation pass after cutover stabilizes.

## Side-by-side bake-in (ACTIVE since 2026-07-17 ~15:00)

Rust runs against the REAL home alongside legacy: **http://localhost:3002** (same AUTH_TOKEN as
:3001; bind 127.0.0.1; pid file /tmp/freshell-bakein-3002.pid; log /tmp/freshell-bakein-3002.log).
Pre-flight completed: state backup (freshell-qa/backups/freshell-state-20260717-141613.tar.gz),
CFG-10 boot-twice on a real-config clone = byte-identical, SESSION-03 delete confirmed soft
(override flag only), config-writer hardening landed (flock sidecar + dirty-key adopt-from-disk
merge + mtime freshness reload, commit 9c346fc6) so Rust cannot clobber concurrent legacy writes
and legacy renames appear on Rust within ~1s.

**Discipline rules:** user-writes (renames/settings/archives) on ONE server at a time; never drive
the SAME agent conversation from both; terminals/layouts are per-server (different origins).

**Bake-in caveats discovered at launch:**
1. Cold boot on the real corpus takes ~4–5 min of CPU (parses 8.7GB codex jsonl once) before the
   sidebar responds; fast afterwards. Legacy avoids this with its persistent session-cache.json.
   FOLLOW-UP: persistent parse cache for the Rust index.
2. Env quirk: setting FRESHELL_HOME re-roots the PROVIDER sources too (claude/codex under
   $FRESHELL_HOME instead of $HOME) — legacy derives provider dirs from os.homedir(). Launch the
   bake-in WITHOUT FRESHELL_HOME. FOLLOW-UP: align home-root resolution with legacy.
3. Legacy on :3001 is now CURRENT MAIN (incl. #514 amplifier session indexing) — amplifier
   sessions appear in the legacy sidebar but NOT on :3002 (Rust doesn't index amplifier yet).

## Standing wave process (how every wave runs)

1. **Scope + dependency slice.** 3–5 items per wave from the readiness tiers; split into
   parallel-safe tasks with EXPLICIT file ownership (disjoint crates/files per agent). Anything
   sharing a file — especially main.rs wiring — goes in one task or sequential slots (lesson:
   the 64083989/8888df30 non-bisectable span came from shared-worktree wiring absorption).
2. **Investigate before building.** Non-obvious items get a read-only code-intel pass first,
   producing an implementer-ready spec with legacy/origin-main file:line citations (this caught
   "amplifier lists via metadata.json, not events.jsonl" before we built the wrong thing).
3. **Parallel TDD implementation — OUTCOME-ORIENTED (double loop).** Every item starts with an
   OUTER EXPERIENCE TEST: the thing the user/operator would actually do, failing the way they'd
   actually feel it (Playwright matrix spec for browser outcomes; process/filesystem-level
   harness test for operator outcomes like logs/shutdown/backup). Prove the outer test RED
   against the current binary FIRST, then inner unit TDD until the outer loop goes green.
   "Done" = OUTER green (unit-green with a broken experience does not count — the fresh-agent
   keepalive saga is the cautionary tale). Outer tests land in the permanent suites so outcomes
   can't regress. Where legacy supports the same outcome, legacy-chromium is the parity control.
   Each implementer must also: cite its parity source (frozen server/ or origin/main, stated per
   task), run focused crate tests + fmt/clippy, keep frozen paths clean, and do a REAL-DATA
   acceptance check against the staging clone or a throwaway home.

   **Destructive-test safety contract** (outer tests kill processes and corrupt files — on the
   machine that hosts the LIVE daily driver, real data, and the bake-in):
   - Destructive operations run ONLY against harness-owned servers on ephemeral 127.0.0.1:0
     ports with throwaway homes under /tmp. NEVER against ports 3001/3002/17871/17872/17874 or
     any process the test did not spawn.
   - Kill by RECORDED PID only, identity-verified (ps -fp + cmdline/cwd match) before signal.
     NEVER pattern/name-based kills (pkill/pgrep by name) — a real codex/claude/node is always
     running somewhere on this box.
   - Child-reap assertions check the recorded child PIDs, never sweep process names. Prefer
     fake sidecars (fake codex app-server) over real CLIs so kills hit fakes.
   - File-corruption tests (e.g. CFG-03) use guard assertions IN CODE: destructive helpers
     refuse any path not under the test's own tempdir (assert path starts with the sandbox
     root before truncate/rm). Real ~/.freshell is never a test target.
   - systemd experiments: user scope only, uniquely-named unit, no sudo, removed after.
   - Prefer mechanism over instruction: put these guards in shared harness helpers (kill_tree
     that refuses unrecorded PIDs; sandbox-path assertions) so the safe path is the easy path.
   - Reviewers explicitly audit destructive tests for blast radius as a named review item.
   - **Required home for these suites**: process-kill, config-corruption, and restart-storm
     suites run inside the disposable containerized test sandbox (`docker/sandbox/**`,
     `scripts/sandbox-test.sh` / `npm run test:sandbox`) — see
     `docs/development/test-sandbox.md`. The sandbox is a hard wall (own PID/network/FS
     namespaces, `--rm`, no real-data mounts by default) in addition to, not instead of, the
     in-code guard-rails above.
4. **Independent adversarial review.** Every commit reviewed at a pinned SHA in an isolated
   worktree; reviewer re-reads legacy sources itself, re-runs tests, and reverts implementations
   to prove tests bite (caught the untested reverse cascade and the chars-vs-bytes scrollback
   bug). Importants are fixed or explicitly adjudicated with the user before "done".
5. **Full gate run** by a separate fix-nothing ops agent: workspace tests + full oracle +
   wire-shape differential + Playwright matrix vs the expected profile.
6. **Deploy + record.** Rebuild; restart :3002 only in a user-approved window (live sessions);
   verify against real data; update THIS doc (deviations, follow-ups, checklist movement);
   push after every wave.

   **Fail-closed deploy guard (provenance-hardening lane, 2026-07-19):** the incident this
   closes -- a production investigation was slowed because the running binary's source commit
   was unknowable (built mid-WIP from a dirty tree, with no way to confirm that after the
   fact). The build+copy step of the rebuild above MUST abort if the tree is dirty:
   ```bash
   [ -z "$(git status --porcelain)" ] || { echo 'DIRTY TREE - refusing to deploy'; exit 1; }
   ```
   Run this guard immediately before the release build, from the worktree root that will be
   built and deployed. `GET /api/server-info` now proves provenance post-deploy independent of
   this guard: it reports `commit` (the git SHA baked in at compile time by
   `crates/freshell-server/build.rs`) and `buildDirty` (whether `git status --porcelain` was
   non-empty at that same build time, fail-closed to `true` if git was unavailable at build
   time) -- an operator can confirm exactly which commit + dirty-state a running `:3002` binary
   was built from without cross-referencing deploy logs. The boot line (`freshell-server
   listening on ... [commit <sha>]`) reports the same `commit` value for a same-glance check
   without an authenticated request.

Cross-cutting rules: codex-first triage (below); data-safety verified on clones before real
state; honest gaps stay visible (fixme-with-trail, N/A-with-reason — never silent skips).

## Standing priority directive (user, 2026-07-17)

**Codex CLI issues come first.** Codex is the user's default agent for the transition — drive
codex-related defects (terminal mode, freshcodex panes, resume, indexing, interrupt) to ZERO
before polishing other providers. Triage all new defect reports through this lens.

## Frozen-paths deviation record

2026-07-17 (commit f7b2c9e6): `src/components/icons/provider-icons.tsx` gained a 27-line
AmplifierIcon ported VERBATIM from origin/main (c5707455/ac0c2f09) — user-requested fix (amplifier
picker icon rendered as a black circle); icons are a pure client-side code map, so no server-side
fix exists. This is the FIRST and only intentional divergence from the frozen `src/` snapshot;
`server/` and `shared/` remain byte-frozen. The client bundle (dist/client) must be rebuilt for
the icon to ship. Oracle equivalence is unaffected (server-side only).

src/ deviation grown to 3 files — restore fixes cherry-picked from main 5c56ecc3 (#516) so the
port client carries them before reconciliation; adaptations listed in commit cd35c24c (none needed - clean apply).

src/ deviation grown to 5 files — persist-empty guard cherry-picked from main 811ab39e
(fix/client-guards: "fix(persist): guard against overwriting a non-empty layout with empty tabs")
so port users get the data-loss protection before reconciliation. Adds
`src/store/persistMiddleware.ts` + `src/store/tabsSlice.ts` guard logic (a transient tabs-load
failure no longer permanently overwrites a non-empty persisted layout with an empty one on the
next flush) plus its regression test `test/unit/client/store/persistTabsEmptyGuard.test.ts`
(test/, not src/). The port's frozen `src/store/persistMiddleware.ts` and `src/store/tabsSlice.ts`
were byte-identical to main at 811ab39e's parent, so the cherry-pick applied cleanly with zero
adaptation. `dist/client` rebuilt so the fix ships on the next approved restart.

2026-07-17 (commits `64083989`, `8888df30` — non-bisectable span, harmless at HEAD): these two
Batch 1 commits do not build standalone in isolation. `64083989` ("add Amplifier as a fourth
session-directory source") absorbed a concurrent agent's `main.rs` wiring change (the
`provider_home()` threading later formalized in `f7b2c9e6`) before that commit existed, so
`64083989` alone references symbols `f7b2c9e6` defines; `8888df30` ("persist the FileEntry parse
cache to disk") likewise depends on wiring that landed slightly out of commit order because three
implementer agents shared this one worktree concurrently. Neither commit was force-amended to
restore standalone-buildability, since doing so risked re-introducing the exact race the
concurrent-agent absorption avoided. Net effect: `git bisect` across this span may land on a
non-building commit; the branch HEAD (and every commit from `f7b2c9e6` onward) builds and tests
green. Treat `64083989..8888df30` as a single atomic unit for bisection purposes.

2026-07-17 (commit `1cb497ee` — deliberate hardening BEYOND legacy, not a parity gap): SAFE-03
(WS Origin policy) and part of SAFE-01 (auth) intentionally diverge from legacy to be MORE strict,
not less:
- **SAFE-03**: legacy's Origin check is advisory-only (logged, never enforced); the Rust port
  enforces an allow-list and rejects hostile/mismatched Origins outright. A client that legacy
  would have accepted (and merely logged) is rejected by the Rust server.
- **SAFE-01**: legacy's conflicting-source precedence (`headerToken || cookieToken`, `auth.ts:41`)
  is preserved byte-for-byte (header wins unconditionally when present, valid or not — see the
  `wrong_header_rejects_even_with_correct_cookie_present` test), but the Rust port ALSO rejects
  empty/too-short/default-value startup tokens that legacy's `validateStartupSecurity` would have
  let through in some paths. A wrong header + a correct cookie is accepted by legacy today but
  rejected by the Rust port.
These are intentional security improvements adopted during the port, not accidental parity
divergences — flagged here so a future bisection/regression hunt doesn't mistake "Rust rejects
something legacy would accept" for a bug.

## Cutover plan (gated on explicit user "APPROVED")
1. Backup real `~/.freshell` (tar + sha256). 2. Stop legacy on :3001 (record pid/cmd for rollback).
3. Start Rust release binary on :3001 with real HOME + existing AUTH_TOKEN + GOOGLE key
   (same-origin ⇒ Chrome carries tab/pane layout via localStorage automatically).
4. Verify: health, sidebar, one terminal, one fresh-agent turn, reload restore.
5. Rollback (one command): stop Rust, restart legacy exactly as before, restore config backup if needed.

## Ops: :3002 launch procedure (rev 2026-07-18, post kill-incident)

The 17:42 death was an external SIGTERM from a broad-scope kill (3x that day; fixtures
exonerated — see bug-hunter verdict). Prevention: production runs a DISTINCT binary
name+path that `pkill -f freshell-server` cannot match, outside the worktree:

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port
cargo build --release -p freshell-server
cp target/release/freshell-server /home/dan/.local/bin/freshell-prod
TOK=$(grep -E '^AUTH_TOKEN=' /home/dan/code/freshell/.env | cut -d= -f2-)
kill $(cat /tmp/freshell-bakein-3002.pid)   # verify ownership first (ps -fp)
AUTH_TOKEN="$TOK" setsid bash -c 'HOME=/home/dan PORT=3002 FRESHELL_BIND_HOST=0.0.0.0 \
  FRESHELL_CLIENT_DIR=/home/dan/code/freshell/.worktrees/rust-tauri-port/dist/client \
  /home/dan/.local/bin/freshell-prod > /tmp/freshell-bakein-3002.log 2>&1 & echo $! > /tmp/freshell-bakein-3002.pid'
```

Agents: NEVER kill by name/pattern; recorded-PID kills only (standing AGENTS.md rule).

## Ops: MCP QA lever (added 2026-07-18, MCP slice 2)

Slice 2 of the agent-API + MCP parity spec
(`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` §6/§8.3) is pinned by a
permanent regression test: `test/e2e-browser/specs/mcp-bridge-rust.spec.ts`
(wired into the `rust-chromium` Playwright project's `testMatch`, so it runs
on every `npm run test:e2e -- --project=rust-chromium` and every full
`test:e2e` pass). It boots an owned, ephemeral Rust `freshell-server`
(`RustServer`, HARNESS-01) and spawns the **UNMODIFIED legacy Node MCP stdio
binary** (`dist/server/mcp/server.js`, built from the FROZEN `server/mcp/`
source — never edited) against it, speaking the real stdio JSON-RPC wire
protocol end to end: `initialize` → `tools/list` → `new-tab` → `list-tabs` →
`send-keys` → `wait-for` → `capture-pane` → `list-panes`. This is the
"zero-Rust-MCP" lever the spec describes: there is no Rust-side MCP code at
all, only Rust-side REST compatibility (Slice 1,
`crates/freshell-freshagent/src/terminal_tabs.rs`) with the client the real
coding-CLI agents already use unmodified.

### How an operator/agent uses the lever

The **main repo** (not this worktree) already carries the wrapper config an
MCP client (e.g. Amplifier) registers to drive Freshell over stdio:
`/home/dan/code/freshell/.amplifier/mcp.json`:

```jsonc
{
  "mcpServers": {
    "freshell": {
      "command": "bash",
      "args": ["-c", "FRESHELL_URL=${FRESHELL_URL:-http://127.0.0.1:3002} FRESHELL_TOKEN=$(grep -E '^AUTH_TOKEN=' /home/dan/code/freshell/.env | cut -d= -f2-) exec node /home/dan/code/freshell/dist/server/mcp/server.js"]
    }
  }
}
```

It reads the auth token from `.env` and defaults `FRESHELL_URL` to the
`:3002` bake-in — but `FRESHELL_URL` is an environment override, so pointing
the SAME binary at an ephemeral QA target is just
`FRESHELL_URL=http://127.0.0.1:<ephemeral-port> FRESHELL_TOKEN=<ephemeral-token> node dist/server/mcp/server.js`
(exactly what `mcp-bridge-rust.spec.ts` does programmatically via
`helpers/mcp-stdio-client.ts`'s `McpStdioClient`).

**Action vocabulary exercised by the lever today:** `new-tab` (mode:`shell`
only — Slice 1's supported terminal mode), `list-tabs`, `list-panes`,
`send-keys` (terminal panes), `wait-for` (terminal panes, `pattern` only —
`stable`/`exit`/`prompt` are Slice 3), `capture-pane` (terminal + editor
panes). Slice 3
(`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` §7) will add the
remaining registered `freshell` tool actions against Rust: `select-tab`,
`kill-tab`, `rename-tab`, `has-tab`, `next-tab`, `prev-tab`, `split-pane`,
`select-pane`, `rename-pane`, `kill-pane`, `resize-pane`, `swap-pane`,
`respawn-pane`, `attach`, `navigate`, `run`, `screenshot` — the MCP tool
schema itself (`ACTION_PARAMS`) never changes; only Rust-side REST coverage
grows to match it.

**Hard rule — ephemeral targets only:** every QA/test invocation of this
lever (and any future one) MUST target an ephemeral, test-owned server
(random loopback port, isolated `FRESHELL_HOME`, e.g. `RustServer` /
`TestServer`) via `FRESHELL_URL` — **NEVER** point a QA run's `FRESHELL_URL`
at `:3001` (live legacy daily driver) or `:3002` (Rust bake-in with real
user data). This mirrors the standing destructive-test safety contract
above (§"Standing wave process" step 3): ephemeral ports and homes are the
wall between test automation and the user's live sessions.

**Current Rust-side coverage boundary (Slice 1, as pinned by this test):**
terminal-mode `POST /api/tabs` supports **`shell` only** (`claude` / `codex`
/ `gemini` / `kimi` return an honest 400 naming the deferral, not a silent
wrong-behavior fallback); `browser` and `editor` content-pane creation work
(cheap content kinds, no process); the pre-existing OpenCode fresh-agent
path (`agent:"opencode"`) is unchanged and still covered separately by
`agent-continuity-matrix.spec.ts`. Rich terminal modes (claude/codex/gemini/
kimi) and the rest of the pane surface (split/close/select/resize/swap/
respawn/attach/navigate, `run`, `screenshot`) land in Slice 3 / the "3a"
follow-up wave; this lever's coverage grows alongside that work rather than
being re-derived from scratch.

## Ops: MCP QA smoke (added 2026-07-19, full mode-matrix payoff)

Slice 1/3a/3b of the agent-API + MCP parity spec have since landed (rich
terminal-mode `POST /api/tabs` for every registered coding-CLI extension,
and the full Slice-3b-2 pane-lifecycle surface: split/close/select/resize/
swap/respawn/attach/navigate + tab select/rename/delete/has/next/prev +
`GET /api/layout/snapshot`). `test/e2e-browser/specs/mcp-qa-smoke-rust.spec.ts`
is the payoff regression pass the `mcp-bridge-rust.spec.ts` pin (above) was
built to unlock: it drives the SAME unmodified legacy MCP stdio binary
against ONE owned, ephemeral Rust server, but across **every** pane mode
instead of `shell` alone.

**What it covers** (one server boot, sequential actions, wired into the
`rust-chromium` project's `testMatch` alongside `mcp-bridge-rust.spec.ts`):

- `shell` -- one quick control assertion (full shell coverage stays with
  `mcp-bridge-rust.spec.ts`).
- `amplifier` -- fresh launch + submit, THEN a **separate** fresh `new-tab`
  call carrying `resume:<sessionId>` (MCP's `new-tab` derives
  `sessionRef:{provider:'amplifier',sessionId}` automatically for any
  non-codex mode). This is a different code path than
  `amplifier-restore-rust.spec.ts` (which proves resume across a
  browser-driven server *restart*) -- this proves resume works when an
  external MCP agent asks for it directly on a brand-new pane, with no
  browser involved at all.
- `opencode` -- fresh launch + submit (mirrors
  `opencode-terminal-restore-rust.spec.ts`'s fixture; resume-via-MCP for
  opencode terminal panes follows the identical shape amplifier already
  proves, so isn't re-proven here for runtime economy).
- `codex` -- fresh launch, then resume via the **`sessionRef` param
  directly** (`ACTION_PARAMS['new-tab']`'s optional `sessionRef` field). A
  raw `resume`/`resumeSessionId` for `mode:"codex"` is rejected outright by
  both the MCP tool's `rejectRawCodexResume` and the Rust
  `requested_resume_session_id_for_mode` -- this suite proves BOTH sides:
  the accepted `sessionRef` resume path, and the raw-resume rejection
  itself (so the guard can't silently regress into accepting the invalid
  shape).
- `browser` + `editor` content panes -- creation, `list-panes` kind
  cross-ref, and `navigate` on the browser pane.
- Slice 3b-2 pane-lifecycle routes -- `split-pane`, `resize-pane`,
  `swap-pane`, `respawn-pane`, `select-pane`, `select-tab`, `has-tab`,
  `kill-pane`, `kill-tab`, all driven through the shell tab from step 1.
  (`attach` is the one exposed-but-skipped action: it pairs a pane with a
  bare `terminalId` minted outside this REST/MCP surface -- a scope choice,
  not a coverage gap forced by the MCP binary lacking the action.)
- One `server.restart()` at the very end, asserting the CURRENT, honest
  behavior: the Slice-1/3a/3b agent-API registry
  (`FreshAgentState.tabs`/`terminal_panes`/`content_panes`/`pane_tabs`,
  `crates/freshell-freshagent/src/lib.rs`) is **in-process memory only** --
  there is no durable backing store for it (unlike the browser client's own
  localStorage-persisted layout, which this pure-REST/MCP suite never
  touches). Every tab/pane id minted before the restart is gone from
  `list-tabs`, and a stale pane's `capture-pane` 404s rather than returning
  stale data. This matches the MCP tool's own advertised contract
  (`freshell-tool.ts`'s `INSTRUCTIONS`: "Tab and pane IDs are ephemeral...").
  **This is a real, current gap, not something this suite papers over** --
  if the agent-API registry ever needs to survive a restart (e.g. to
  support "reconnect and keep driving the same panes" for an MCP-controlled
  session), that is follow-up scope, not something this pin claims already
  works.

**How to run it:**
```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium mcp-qa-smoke-rust.spec.ts
```
Same ephemeral-target hard rule as `mcp-bridge-rust.spec.ts` above applies
unchanged (own `RustServer`, random port, isolated `FRESHELL_HOME` -- never
`:3001`/`:3002`).

**What it would have caught (incident-to-assertion mapping):**

| Historical incident class | Guarding assertion in this suite |
|---|---|
| "Amplifier blank-tabs" class -- a coding-CLI pane silently launches FRESH instead of resuming, leaving the user looking at an empty prompt with no visible error and no way to tell their prior session was dropped | The amplifier-resume assertions: `wait-for` on `amplifier: resumed session` (not just `amplifier> `) after a `new-tab{resume:<id>}` call, PLUS the independent argv-log cross-check (`argv[0]==='resume' && argv[1]===sessionId`). A regression that silently drops the resume arg would show the fresh-launch banner instead and fail both checks -- not a blank pane that "looks fine" until inspected closely. |
| Codex resume-create silent-data-loss class -- a resume request for codex is accepted and appears to succeed, but the actual launched process never receives the resume identity (silently starts a new, unrelated thread), so the user's existing work is invisibly lost | The codex-resume assertions: `wait-for`/`capture-pane` on `codex: resumed session <id>` after `new-tab{sessionRef:{provider:'codex',sessionId}}`, cross-checked against the argv log's `resume <id>` entry, PLUS a companion assertion that a **raw** `resume`/`resumeSessionId` for `mode:"codex"` (no `sessionRef`) is REJECTED (`error` truthy) rather than silently accepted-and-ignored -- the exact shape of "looks like it worked, actually started fresh" this class describes. |
| Stale-ID-after-restart false-success -- an MCP/automation client keeps using pane/tab ids from before a server restart and gets a misleading "success" or stale cached content instead of an honest failure | The restart section: `list-tabs` after `server.restart()` must NOT contain any pre-restart tab id, and `capture-pane` on a pre-restart pane id must return an `error`, not stale/blank data. |
| Route-shape drift on the Slice-3b-2 pane-lifecycle surface (split/swap/respawn/etc. silently 404ing or changing response shape as the Rust port evolves) | The pane-ops section calls every one of those actions through the SAME unmodified MCP binary and asserts `status`/returned ids, so a regression in any one route surfaces as a broken assertion here rather than being discovered only when a real MCP agent hits it in the field. |

Verified 3x green locally (`1 passed` each run, ~33-43s per run); `mcp-bridge-rust.spec.ts` still green after this addition; frozen `server/`/`shared/`/`src/` untouched.
