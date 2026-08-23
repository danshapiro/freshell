# Deep-dive: Campaigns / QA worktrees

Baseline: origin/main = `3d739ca4a` (2026-08-23). All four worktrees are clean (dirty=0 per baseline-data.jsonl).

Key relationship discovered: **`qa-campaign-20260806` is a strict superset of `parity-campaign-20260805`** — `git merge-base --is-ancestor 3fe59654f 45dada4c4` = YES. qa-campaign = parity-campaign (45 commits) + 12 unique commits (8 `fix(server)` commits on `crates/freshell-server/src/files.rs`, 4 docs commits). Both share merge-base `4eecc456c` with main.

---

## 1. qa-campaign

```yaml
worktree: qa-campaign
branch: qa-campaign-20260806
date: 2026-08-06
ahead: 57
behind: 860
verdict: finish-work
confidence: high
land-effort: small
```

### What it is
A two-stage campaign stacked on parity-campaign:
1. **QA panel experiment** (`3e6a49882`) — 16 review lenses run against `crates/freshell-server/src/files.rs`, producing confirmed defect clusters, each carrying a failing proof test (`docs/plans/parity-ledger/QA-PANEL-EXPERIMENT.md`).
2. **Closed-loop fix campaign** — detect → adjudicate → fix → **independent same-model review** → verify → integrate, documented in `QA-FIX-CAMPAIGN.md` (run 1) and `QA-FIX-CAMPAIGN-2.md` (run 2).

Run 1 (56 min): 7 of 8 clusters landed on-branch, each with a proof test and a **review-passed** verdict. The review gate caught 2 real bugs that had passed all tests: `tilde_expand`'s first version introduced a worse `~\/rest` absolute-path bug (bounced, reworked, landed: `fdb316f3d` + `dd6d6b36b`), and `completion_sort` was **honestly withheld** — its approximation of Node's ICU collation (`localeCompare`) sorted accented characters wrong; exact parity needs a collator crate. Run 2: a documented negative result — all 6 fixers timed out with zero commits (no WIP-commit discipline), nothing landed.

### Landed/unlanded status
**All 7 file fixes are UNLANDED.** Main's `crates/freshell-server/src/files.rs` is **byte-identical to the merge-base** (`git diff 4eecc456c origin/main -- crates/freshell-server/src/files.rs` = empty), so main never received any of this work, nor any equivalent: main has no `~\`-tilde expansion, no `ENOTDIR→409` mkdir mapping, no etag handling, no mime content-type map in the rust files surface (verified by inspection of `expand_tilde`, `mkdir`, and grep of files.rs @ origin/main).

Unlanded fix commits (each small, 27–58 lines, each with a permanent regression test):
- `3d50937a6` mkdir ENOTDIR (intermediate component is a file) → 409, not 500
- `b9a885e4f` POSIX path sanitization (strip quotes/whitespace on every flavor)
- `e413b31f0` mime content-type for `/local-file`-style serving
- `0f024b1a3` UNC classification
- `714d6a3d4` etag shape
- `e02f3d6a2` dot-segment collapse in display strings
- `fdb316f3d` + `dd6d6b36b` tilde expansion of `~\rest` (what Windows users type targeting a WSL host)

Also on this branch (inherited from parity-campaign): all `docs/plans/parity-ledger/*` — the re-audit ledger, learnings, writeup. None exists on main.

### Recommendation
Land the 7 reviewed fixes. They do not cherry-pick cleanly (their parent state includes the unlanded FILE-01/02/03/06 edits to files.rs from the parity layer), but each is tiny with an attached proof test, and main's files.rs is untouched since the merge-base — a careful hand-port is a **small** job and these are confirmed Node-oracle divergences in the production Rust server. File a kata for `completion_sort` (documented approximation vs. adding a collator crate — an open product decision the campaign deliberately refused to fudge). Also extract `docs/plans/parity-ledger/QA-SYSTEM-DESIGN.md` (a generic, iterated closed-loop parallel-agent bug-fix system — the most reusable artifact here) and the process learnings from `QA-FIX-CAMPAIGN{,-2}.md` before the branch dies. Worktree is small (66M, no node_modules).

---

## 2. parity-campaign

```yaml
worktree: parity-campaign
branch: parity-campaign-20260805
date: 2026-08-06
ahead: 45
behind: 860
verdict: throw-away-useless
confidence: high
land-effort: none
```

### What it is
Overnight 2026-08-05 massively-parallel campaign (~35 opencode/Kimi-K3 sessions): 18 auditors re-verdicted all 235 items of `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`, then implementation waves landed **31 checklist items on this one branch** (`docs/plans/parity-ledger/CAMPAIGN-RESULTS.md`: final audit 31 DONE / 118 PARTIAL / 58 MISSING / 23 UNCLEAR / 5 HOST-LIMITED at main@4eecc456c; both cargo + npm gates green). Its own results doc says explicitly: **"NOT pushed, no PR"** — the branch never left the machine.

### Landed/unlanded mapping
The branch's commits never landed, but main's own rust-port effort re-implemented the big-ticket areas independently (verified by file/content comparison against merge-base):
- **Covered on main (equivalent, usually larger):** BROWSER-02 WS-upgrade proxy relay (main's proxy.rs grew 285→1728 lines), NET-09 serialized settings store (`settings_store.rs` exists on main), NET-05 configure-firewall (37 matches in main's network.rs), SESSION-02 `createdAtOverride` overlay, SESSION-04 provider-aware AI titles (main has `ai_title.rs`, `auto_title*.rs`), TERM-04 create-dedupe (`create_dedupe.rs` on main), TERM-09 stall-window backpressure (14 `stall` refs in main's backpressure.rs), AUTO-06/08/10 automation parity, EXT-01/02/04 (main has a dedicated `freshell-extensions` crate).
- **UNLANDED (files byte-identical merge-base↔main, so campaign edits provably absent):** FILE-01 authenticated `/local-file` endpoint (main's Rust server has **no `/local-file` route at all** — while main's `src/components/panes/BrowserPane.tsx:68-91` still converts `file://` URLs to `/local-file?path=…`), FILE-02 Windows drive/UNC targets in `/local-file`, FILE-03 pinning `\\wsl$`/network-share UNC inert on read/stat/complete/mkdir, FILE-06 sandbox comparison hardening, SESSION-07 stale-query cancellation + amplifier file-tier search, SESSION-14 fractional-ms flooring, SESSION-19 safe bounded snippets, TERM-13 scrollback-cap eviction tests, SESSION-01 resume-identity test pins, DIAG-04 live perf process sampler (no `perf.rs` on main), SYNC-01/02/03/04 client unit tests.
- **Docs:** the entire `docs/plans/parity-ledger/` tree (corrected 235-item audit YAMLs with file:line evidence, LEARNINGS.md, WRITEUP.md, CAMPAIGN-RESULTS.md) exists nowhere on main.

### Recommendation
Delete this worktree, not the knowledge. Every commit here is an ancestor of `qa-campaign-20260806` (verified), so nothing committed is unique to this worktree — the unlanded residue (FILE-01/02/03/06, SESSION-07/14/19, DIAG-04, TERM-13, SYNC tests) and the ledger docs are all equally reachable via qa-campaign. The `/local-file` gap deserves a kata independent of whichever branch survives: main's client emits `/local-file` URLs but main's Rust server doesn't serve them (reachability should be confirmed, but FILE-01/02 was a reviewed, tested fix sitting ready-made). Reclaim ~1.2G (mostly node_modules).

---

## 3. deploy-compatibility-rollback

```yaml
worktree: deploy-compatibility-rollback
branch: feat/deploy-compatibility-rollback
date: 2026-07-31
ahead: 72
behind: 896
verdict: finish-work
confidence: high
land-effort: large
```

### What it is
Not a rollback *of* anything — it is a complete, tested implementation of **compatibility-aware deploys with immutable generations and proven rollback** for the Rust server/client (the name means "deploy rollback capability"). Per its own record (`docs/superpowers/plans/2026-07-29-compatibility-aware-rust-deploys.md`, status "Implemented… completed steps are checked"; `ecd496a7d` "record completed compatibility rollout"), +34,454 lines across 81 files:
- **`crates/freshell-deploy/`** (~19k lines incl. ~10k lines of tests): Rust deployment controller — immutable generation store, legacy working-closure capture (`/proc/<pid>/exe` after boot-ID/inode/digest verification), pidfd process identity, durable intent-before-side-effect journal, activation confirmation as roll-forward authority, rollback/replay.
- **`crates/freshell-deployment/`** — shared declaration/bounds/manifest/receipt types consuming the same golden conformance corpus as the JS side.
- **`scripts/deployment-compatibility.mjs`** (dependency-free strict parser/checker) + `config/deployment-compatibility.json` + 24-case JSONL conformance corpus.
- **`test/e2e-browser/deployment-compatibility.spec.ts`** (1,168 lines) proving exact rollback and browser continuity inside the Docker sandbox; sandbox hardening (`docker/sandbox/*`, `scripts/sandbox-test.sh`, `test/helpers/owned-child-process.ts`, `test/e2e-browser/helpers/wait-for-http.ts` with 94 lines of tests).
- `scripts/launch-rust.sh` +306/-142 to become a thin wrapper over the controller.

### Landed/unlanded status
**Nothing landed.** Checked individually: `crates/freshell-deploy`, `crates/freshell-deployment`, `scripts/deployment-compatibility.mjs`, `config/deployment-compatibility.json`, the e2e spec, the helper files, the plan doc — all absent at origin/main; no `freshell-deploy` references anywhere on main. Main went a deliberately simpler direction in the same period: launch-rust.sh gained only +31/-1 (the `setsid` detached launch the current AGENTS.md documents) plus `installers/{systemd,launchd,windows}` service units. So main has safe-restart supervision but **no** compatibility declarations, generation capture, or rollback journal. Merge-base→main evolution of shared files is heavy (main.rs +1498/-211 vs the branch's +1338 on the same file) — a rebase would be a rebuild, not a cherry-pick. **The branch is not pushed to origin; this worktree is the only copy.**

### Recommendation
This is a product decision, not litter: the campaign finished what it set out to build and the plan doc is an unusually good implementation record (including load-bearing findings like running-server-as-deleted-inode and PID-reuse races). If the user wants generation rollback/compatibility-gated deploys, revive the architecture as a fresh branch against current main (large effort — treat the branch as a reference implementation, not a rebase base). If the setsid+systemd direction is final, archive first (push the branch to origin or at minimum copy the plan doc and `deployment-compatibility.spec.ts` out) — file a kata noting the capability gap — then delete the 26G worktree (25G is Rust `target/`). Do not delete before one of those two preservation steps happens; nothing here exists anywhere else.

---

## 4. df1-control

```yaml
worktree: df1-control
branch: df1/control-plane
date: 2026-08-09
ahead: 6
behind: 735
verdict: throw-away-useless
confidence: high
land-effort: none
```

### What it is
Infrastructure-only control plane for the **df1** massively-parallel parity campaign (kickoff issue danshapiro/freshell#624): `df1-control/` with README, four agent prompts (worker/verifier/gatekeeper/reaper), `queue/items.json` (2,631 lines, generated by `scripts/build-queue.py` from the rust-tauri parity checklist — regenerable), and scripts `acquire.sh` / `build-queue.py` / `df1ctl.py`. Runtime state lived outside git at `~/.freshell/df1/` by design. Last commits add a `df1ctl add` subcommand and five "operational lessons" (never-run deferred specs forfeiting gate proofs, `test.fail` annotations masking stacked gaps, premature task_result acknowledgments, swarm-load flake attribution discipline).

### Landed/unlanded status
The campaign it controlled **fully landed**: `df1/integration` and every `df1/*` work branch are ancestors of origin/main (per baseline-data.jsonl), and main carries `docs/plans/df1/` + `docs/plans/df1-evidence/`. Main has no `df1-control/` directory — this harness was never intended to be repo content ("infra only" per its README). Crucially, **the branch is pushed to origin** (`refs/heads/df1/control-plane` @ `cc406d032` = worktree HEAD), so no content exists only here.

### Recommendation
Campaign litter with minor retrospective value — delete the worktree (8.7G, of which 7.5G is Rust `target/`) and rely on the origin branch. Nothing needs landing; the operational lessons are the only prose worth keeping and they survive on the remote branch. If a future parallel-agent campaign is planned, `df1ctl.py` + the prompts + the lessons in this README are the starting point — consider copying the five-lesson block into darkforge/agent docs at that time, but do not block deletion on it.

---

## Cross-cutting notes for the triage owner

1. **Kata candidates (unlanded findings worth preserving):**
   a. `/local-file` on the Rust server: main's client (`BrowserPane.tsx`) converts `file://` URLs to `/local-file?path=…`, but main's Rust server has no `/local-file` route; parity-campaign had a reviewed FILE-01/02 fix (auth + Windows drive/UNC) on-branch. Verify reachability of the client path, then port.
   b. Seven reviewed Node-oracle file fixes (mkdir ENOTDIR→409, `~\` tilde, etag shape, mime map, UNC classification, sanitize, dot-seg display) — ready-made with proof tests in qa-campaign.
   c. `completion_sort`: accept documented ASCII approximation vs. add a collator crate (deliberately withheld by the campaign; open scope decision).
   d. DIAG-04 perf process sampler: Node has `server/perf-logger.ts` (cpu/rss sampling); main's Rust server still has no equivalent (confirmed absent in the campaign's pre-audit and still true today).
   e. Deploy rollback/generation infrastructure: capability gap vs. main's simpler launcher approach, pending the product decision in §3.
2. **Disk reclaim if all four are deleted as recommended:** ~36G total (deploy-compat 26G, df1-control 8.7G, parity 1.2G, qa 66M — extract its fixes first).
3. **Surprise:** the parity/qa campaigns discovered during their own run that AGENTS.md had the wrong live-server port and that runtime facts must be verified against `ss -tlnp`/pid files — main's AGENTS.md now says 3001, but the campaigns' ledgers remain the most honest record of how stale docs mislead agents.
