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

## Cutover plan (gated on explicit user "APPROVED")
1. Backup real `~/.freshell` (tar + sha256). 2. Stop legacy on :3001 (record pid/cmd for rollback).
3. Start Rust release binary on :3001 with real HOME + existing AUTH_TOKEN + GOOGLE key
   (same-origin ⇒ Chrome carries tab/pane layout via localStorage automatically).
4. Verify: health, sidebar, one terminal, one fresh-agent turn, reload restore.
5. Rollback (one command): stop Rust, restart legacy exactly as before, restore config backup if needed.
