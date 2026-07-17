# Rust Transition Campaign — Status (2026-07-17 morning)

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

## Cutover plan (gated on explicit user "APPROVED")
1. Backup real `~/.freshell` (tar + sha256). 2. Stop legacy on :3001 (record pid/cmd for rollback).
3. Start Rust release binary on :3001 with real HOME + existing AUTH_TOKEN + GOOGLE key
   (same-origin ⇒ Chrome carries tab/pane layout via localStorage automatically).
4. Verify: health, sidebar, one terminal, one fresh-agent turn, reload restore.
5. Rollback (one command): stop Rust, restart legacy exactly as before, restore config backup if needed.
