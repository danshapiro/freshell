# df1 Campaign Retrospective — massively parallel development, first full-scale run

**Campaign:** `df1/integration`, forked `4c2297667` (2026-08-08 23:01 PDT), merged to main as PR #640 (`44030caa8`, 2026-08-11 00:43). **49.2h wall clock**, ~19h orchestrator-active / ~29h awaiting agents+gates.

**Scale shipped:** 22 work items (18 wave items + 4 wrap), 271 pre-sync commits (257 files, +48,874/−899 effective; diff bulk: e2e tests 41%, rust server 36%, docs 15%, unit tests 3%, infra 4%, legacy production <1%). One merge PR; two in-flight main-sync merges (`b87c79c02`, `726850c41`).

**Scope queue:** 235 checklist items → 7 pre-checked, 66 host-limited, 162 swarm-eligible; 30 reached terminal state this wave (22 merged, 8 done); 148 remain queued with 9 named follow-up hand-offs.

---

## 1. Timeline

| Batch | Window (PDT) | Items merged | Peak agents |
|---|---|---|---|
| setup/preflight | 08-08 23:33–23:52 | — (queue INIT; base-greenness check) | 0 |
| B001 | 23:52→08-09 02:29 | CFG-04 | 2 + gate |
| B002 | 02:32→06:19 | SESSION-05 (fix2), JAN-87 | 2 + gate |
| B003 (harness wave) | 06:20→10:21 | HARNESS-03/04/05/06/11/14; H12 gate-fail → reverted → fixed | 7 + gate |
| B004 (big wave) + S1 sync | 10:22→21:32 | CFG-12, TERM-04, H12-fix1, SESSION-16, BROWSER-01, DIAG-01, AUTO-01, GATE-01, EXT-01 | 9 + gate |
| Wrap wave → B005 | 21:34→08-10 19:17 | JAN-88, RESTORE-01, SESSION-13, CFG-01 | 9 launched, 5 completed |
| Wrap-review r1–r6 | 14:21→20:44 | 14 majors fixed | external reviewer + gate |
| Final gates R1/R2 + syncs | 21:51→08-11 00:39 | 1 arbitration fix; 2 main-syncs | gate chain |
| PR #640 merge | 08-11 00:43 | — | — |

Sources: `~/.freshell/df1/events/launches.jsonl` (907 lines), `~/.freshell/df1/items.json`, `FINAL-WRAP.md`.

## 2. Machinery that ran it

- **Worktree-per-item** branches (`df1/<area>-<nn>-<slug>`), each with own `npm ci` and cargo target. 27 worktrees created; each worktree doubles as a crash-checkpoint (see SESSION-09).
- **Lease lanes** (`df1-control/df1-control/scripts/acquire.sh`): mkdir-atomic, 900s TTL + reaper, system guards (MemAvail≥4G, load1≤40, disk≥100G). Lanes: agent(32), cargo(3), pw(4), provision(2), sandbox(2), gate(1). Ledger traffic: pw 415 events (the hot lane), cargo 137, agent 107, gate 18.
- **Batch gating**: items merge only in batches (B001→B005); each batch re-gates (cargo/vitest/pw legs + ordering proofs); a failing item is unmerged and re-queued (H12 proved this works).
- **Role separation**: worker / verifier / gatekeeper / external wrap-reviewer as distinct agent sessions; orchestrator coordinates via ledger + status files, never via task_result text alone.
- **Wrap-review loop**: 6 rounds of independent review ("fresh eyes") after all self-reported work was complete — see §4.
- **Ledger as truth**: `launches.jsonl` + per-item `status/*.json` in `~/.freshell/df1/` + evidence files in git. Lesson codified mid-campaign: *never trust `task_result` prose; truth = ledger + branch head.*

## 3. Failure & adversity taxonomy

**Test flake regime** (policy: one isolated retry, then quiet-window adjudication; "no silent re-green", per posterity rule TODO-FLAKE-RULER):
- Deadline-under-load ws tests at saturated host (load≈45, 167 chrome processes): `codex_locator_activity` 35.46s→5.47s isolated; `auto_resume_e2e` 10.08s→0.84s isolated; both green in quiet-window 116/116-target run → ambient-load, not defects.
- Base+tip arbitration runs separated pre-existing reds from introduced ones: restore-contract-wall codex legs red at *both* base and tip → adjudicated pre-existing, deferred as TERM-22 with arbitration note. This single protocol decision prevented burning days chasing ghosts.
- GATE-01 baseline itself landed with a measured red/inventory (138 legs; 22 rust legs with F1-recovery interference) — deliberately inventoried rather than papered over.

**Infrastructure failures:**
- 70 reaped stale leases (~19% of grants), incl. batch-transition storms (×9/×9/×7/×5); the TTL reaper absorbed all of it. Lease abandonment was routine, never catastrophic.
- Worker deaths mid-item: SESSION-09 (heartbeat stale 3.3h → item requeued, its task-1 commit preserved on its branch), HARNESS-06 (empty task_result → resumed as `-resume1`). Worktree-as-checkpoint held both times.
- 4 workers launched in the wrap wave but never claimed their items (agent-lane capacity vs actual throughput miscalculation); items were returned to the queue at wrap, not silently dropped.
- Host poison incidents: stray `/tmp/.git` broke `repo_icon_git` under default TMPDIR → per-item TMPDIR convention; a live `docker build` observed mid-review-verification → wrapper stub hardened.
- Review tooling absences (no Task tool inside worker env, MCP pane timeouts) → fell back to `opencode run` review harness; fresheyes false-echo (its own PASSED marker dumped into the review stream) codified as a rule after hitting r2/r5/r6.

**Real bugs caught by gates and reviews** (the payoff column):
- Wrap-review r1–r6: **14 majors fixed after every worker had self-reported done.** Distribution: r1 6, r2 3, r3 3 + 1 *critical*, r4 2, r5/r6 0. Notables — r3 critical: the proxy forwarded `x-auth-token` and the `freshell-auth` cookie **verbatim to proxied apps, on both servers** (any loopback app got a bearer token) `8b13d83a6`; r3: stale mutable `:latest` e2e cloud image could make the gate vacuously green → content-addressed tags `ade55e095`; r2: create_dedupe never settled on two paths → cross-connection duplicate PTYs `c00630fec`; r1: settings_store in-memory leak on failed persist → rollback `3a6931dd3`.
- Post-merge gate caught: my own merged-test harness wiring defect (`9b2ee0709`), a fmt artifact (`3b7112842`), and two **pre-existing main-side bugs** — tooltip pointer-interception on sidebar rows (reproduced on pure origin/main), 4 novel a11y-gate violations in main-authored specs — both fixed as riders (`3b7112842`).

## 4. Control-plane honest evaluation

| Mechanism | Verdict | Evidence |
|---|---|---|
| Leases + TTL reaper | **EARNED** | 70 reaps absorbed with zero orphans; pw lane correctly identified RAM-bound bottleneck |
| Batch gatekeeper (unmerge-and-requeue) | **EARNED** | B001 rejected SESSION-05's batch twice; H12 reverted (`3dbba43c2`) then re-landed clean |
| Independent verifier role | **EARNED** | caught false-green twice before batch merges (SESSION-05 mock export, HARNESS-03 pw 21/78) |
| Worktree-per-item | **MIXED** | perfect crash checkpoints; unowned residual cost ~160G (130G target + 29G node_modules) with no post-campaign GC |
| Ledger in `~/.freshell` + evidence in git | **EARNED** | survived all crashes; mid-campaign rule "state must live in git or `~/.freshell`" after foreign agents deleted untracked design docs |
| Base-greenness preflight + base/tip arbitration | **EARNED** | added after B001 pain; made every later attribution unambiguous |
| Wrap-review fresh-eyes loop | **EARNED (highest value/effort)** | 14 majors incl. one critical security bug after "done" |
| Port/PID/ownership rules | **EARNED** | zero port collisions, zero cross-owner kills, zero production disturbances in 49h of chaos |
| Agent-lane cap 32 + ramp plan | **CEREMONY** | peak observed 9; sized aspirationally, never re-derived from measurement |
| Reaper-as-prompted (KILLED events) | **CEREMONY** | 0 KILLED events; practice drifted to ad-hoc orchestrator requeue — either automate or drop |

## 5. Integration learnings (syncing a moving main)

- **main moves fast:** 127 main-lineage commits in 1.38 days (~92/day ≈ 645/week). A long-running campaign branch WILL diverge; plan syncs, don't fear them — or rather: *do them per-batch, not once at the end*.
- **Conflict taxonomy across both syncs (11 files + 4 compile follow-ups):** dominated by class (a) *same-feature-divergent-implementations* — AUTO-01's layout store had shipped in both lineages. 6 of 11 conflict files trace to that ONE divergence. Genuine unions (settings_store, session_directory, playwright.config, e2e-cloud) were mechanical once examined file-by-file; test-harness drift (WsState literals gaining fields) was compile-gated and trivial.
- **`--rebase-merges` degenerates** when a branch's history embeds prior sync merges from a fork lineage (each historical stop re-litigates old-main-vs-new-main). Merge, resolve carefully, record decisions in the commit message + a doc (rerere recorded all postimages for free).
- **Sync was net-positive value**, not just cost: it surfaced two real main-side bugs (tooltip interception, a11y novels) that were fixed for everyone, and it let every gate run against *true* main before PR — no post-merge surprise.
- **Post-merge gate after each sync is non-optional.** Even "auto-merged cleanly" regions carried semantic drift (harness wiring, Node-exact listPanes contract, missing struct fields). Compile gate caught one class; the test gate caught the other. Both were needed.

## 6. Measured throughput & cost

- 22 items in ~19 orchestrator-active hours ≈ **1.2 items/active-hour**; batch cycle times: B001 2.6h (1 item, early machinery), B003 4h (6 items), B004 11.2h (9 items incl. sync).
- Effective parallelism was gated by RAM (pw lane) and the single gate lane, not by agent count — the 32-agent cap was fantasy; ~7 simultaneous was the real burst ceiling, and the queue drained item-limited, not lane-limited, after the big waves.
- Cost concentration: wrap-review + final gates + syncs ≈ 11h of the 19 active hours. **More than half the orchestration effort is integration, verification, and review — not work generation.** Plan staffing accordingly.

## 7. Playbook for doing this as a standard approach

1. **Preflight gate on the base**, always (greenness + provenance record), before the first worker spawns.
2. **Ledger-first state**: every launch/lease/verdict in an append-only log outside the repo; per-item status files; evidence docs in git. Orchestrator sessions are disposable and must be reconstructible from the ledger alone.
3. **Distrust self-reported completion.** `task_result` prose is a hint, never evidence. Verifier + gatekeeper roles pay for themselves every batch.
4. **Flake adjudication protocol, codified**: one isolated retry → runtime-pair evidence → quiet-window rerun → classify, or defer with arbitration note. Never silently re-green.
5. **Base+tip probes for any ambiguous red** — separates "we broke it" from "it was already broken" in one run.
6. **Sync main per batch** on campaigns >1 day; measure drift rate (here ~92 commits/day) and budget re-gating; keep conflict mass small by construction.
7. **Wrap-review with a hostile reviewer after all self-reported green.** Six rounds found a critical security bug at round 3. Stop when a round produces 0 majors — that's the completion signal.
8. **Size lanes from measured contention** (pw=cargo lanes were right; agent 32 was not) and instrument *denials* (currently unlogged).
9. **Worktree GC is a closing ceremony**, budgeted (residual ~160G here).
10. **Close with named hand-offs**, not vibes: every deferred item has an owner, reason, and evidence path (REV-01 chain, TERM-22, SESSION-09, GATE-01 pins…).

## 8. Open architecture questions for the next run

- Orchestrator durability: sessions are resumable from the ledger, but narration/context still dies on crash. Next step: orchestrator journal to disk per turn (or run orchestration under the same worktree-checkpoint regime as workers).
- Denial logging + queue-depth telemetry on the lease layer, so lane sizing becomes evidence-based.
- Reaper: automate KILLED-event emission as prompted, or simplify the charter to match actual practice (TTL-reap + ad-hoc requeue).
- Consider a real queue driver for >10 items/day; at 92 main-commits/day, an idle-assembled batch is already stale by gate time.

*Investigation performed post-merge by four parallel read-only agents (mechanics/timeline, failure taxonomy, control plane, integration) against the ledger, evidence bundle, git history, and control-plane branch. Sources are cited inline; the four raw reports are reconstructible from `~/.freshell/df1/` + `docs/plans/df1-evidence/`.*
