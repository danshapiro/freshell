# Deep Dive 05: 0gdd Investigation Residue (3 worktrees)

The 0gdd kata investigated the Rust server's chronic ~50–79%-of-a-core CPU baseline
(suspected session-directory polling). The investigation ran a deliberately
uncommitted, env-gated "Level 1" measurement harness and a deliberately uncommitted
24-hour file-notice observer, then wrote up all findings, evidence locations, safety
model, and a continuation plan in a 1,482-line handoff doc. The handoff doc records
an explicit disposition decision: the diagnostic instrumentation is **not** to be
merged as production code. Critically, since 2026-08-15 main has independently
shipped the production design the investigation argued for (dirty-marking +
`SessionWatcher` + event-driven sweeps + 15-min TTL, plus amplifier managed watch
sets), so the diagnostic code is doubly superseded.

## 1. 0gdd-measurement

```yaml
worktree: 0gdd-measurement
branch: investigation/0gdd-measurement
date: 2026-08-12
ahead: 0
behind: 301
verdict: throw-away-useless
confidence: high
land-effort: none
```

### Evidence

Uncommitted content (branch HEAD 225a91db3 is an ancestor of origin/main; nothing
committed is unlanded):

- 5 dirty entries = 3 modified tracked files + 2 untracked scripts.
  `git diff --stat`: `main.rs` +213, `directory_index.rs` +358/-bulk of 62
  deletions, `auto_title_sweep.rs` +11 — 520 insertions, 62 deletions total.
- The diff is a master-gated diagnostic package: `Level1Config` parsed from
  `FRESHELL_0GDD_LEVEL1` / `SESSION_SWEEP` / `AUTO_TITLE_SWEEP` / `REFRESH_MODE`
  / `CACHE_WRITES` env vars (startup refuses unknown controls); gates the sessions
  sweep and auto-title sweep; adds `0gdd.sessions_sweep`, `0gdd.auto_title_sweep`,
  `0gdd.index_refresh_finished`, `0gdd.cache_save_started/finished`
  `tracing::info!` timing events; adds `SessionIndex::with_diagnostic_options*`
  constructors with a `persist_writes` kill switch. Plus a Rust unit test for the
  config gate.
- Untracked: `scripts/measure-0gdd-level1.ts` (818 lines — orchestration harness
  that spawns the release binary with the env controls, samples `/proc`, applies
  A/B conditions, and rejects private strings in evidence) and
  `test/unit/scripts/measure-0gdd-level1.test.ts` (543 lines).

What main has: **none of it.** `grep -r FRESHELL_0GDD crates/` on main
(3d739ca4a) returns zero matches; `with_diagnostic_options`/`DiagnosticState` do
not exist in main's `directory_index.rs`. Main instead has the real fix:
`ad98829fd feat(sessions): add dirty-marking and change notifications to
SessionIndex`, `85ba0a401 feat(server): wire SessionWatcher, raise TTL to 15min,
event-driven sweeps`, a full `session_watcher_tests.rs` notify suite, and the
amplifier watch-set/watch-reduction series — i.e. the watcher-driven design the
investigation recommended. `directory_index.rs` alone has ~20 commits since
2026-08-15, so the stale diff would not apply anyway.

The investigation's own handoff doc is authoritative on disposition: "The harness
is intentionally uncommitted because it is diagnostic instrumentation, not an
approved production design" (§3.3); inventory table: "**Do not merge** as
production code" (§4.1); "Do not merge these as production implementation: the
Level 1 environment-variable controls and diagnostic event instrumentation;
`scripts/measure-0gdd-level1.ts`…" (§4.7). Level 1 results are fully preserved in
the handoff doc (65.28pp warm-only reduction, 34.79pp 10s-cadence reduction,
28.56pp no-GET upper bound).

### Recommendation

Throw away. This is served-its-purpose diagnostics whose findings are preserved in
the handoff doc, whose merging was explicitly forbidden by the investigation
itself, and whose purpose (motivating watcher-driven invalidation) has been
fulfilled on main by a different, production-approved implementation. Salvaging it
as a committed branch would only enshrine dead env-gated code that cannot apply to
current main. Deleting the worktree loses nothing the handoff doc does not
already record.

## 2. 0gdd-observer

```yaml
worktree: 0gdd-observer
branch: investigation/0gdd-observer
date: 2026-08-12
ahead: 0
behind: 301
verdict: throw-away-useless
confidence: high
land-effort: none
```

### Evidence

Uncommitted content (branch HEAD 225a91db3 is an ancestor of origin/main):

- Exactly one untracked item: `crates/freshell-sessions/examples/observer_0gdd.rs`
  — 4,776 lines / ~180KB. A standalone, read-only 24-hour fs-event observation
  program (`notify`-based) with an extreme safety envelope: no network port, 5%
  CPU systemd cap plus a 6% software self-limit, watch-count caps, production-port
  guards, preflight handoff files, dedup/reconcile machinery, and privacy-safe
  schemas.
- The handoff doc records its SHA-256
  (`4f63ec34…a75a3f`, §3.4) and states: "The worktree contains exactly that one
  untracked source file. It is intentionally uncommitted because it is a temporary
  diagnostic/prototype, not approved production code" (§3.4); §4.7 lists
  "`observer_0gdd.rs` in its current one-file diagnostic form" under **Do not
  merge**; the executive summary says the observer "should become an iterative
  replacement prototype" — i.e. a *new* artifact, not this one.

What main has: no observer example (`examples/` does not exist in main's
freshell-sessions), and no need for one — main shipped the production
`SessionWatcher` (see §1). The observer's campaign already concluded: final run
`-08` completed exactly 24h (8,104 file-state changes, 98.21% exact-path notice
coverage, 90.87% rapid-repeat noise, 0.72% mean CPU), and all durable evidence is
retained outside the repo at
`/home/dan/.local/state/freshell/0gdd-observer-20260814-08/`
(`events.jsonl`, `state.json`, `report.json`) plus partial runs `-03/-04/-06/-07`
and five preflight handoffs (handoff §4.2). The doc also forbids launching another
unattended long observer run without explicit approval.

### Recommendation

Throw away. The 24-hour campaign the observer was built for is complete with its
evidence archived outside the repo, and the investigation's own decision record
bars committing this prototype as production code — the follow-on row-comparator
prototype was meant to be written fresh from the retained findings. Main has since
implemented the real watcher design, so the binary's raison d'être is gone.
Nothing here should be committed anywhere; deleting the worktree discards only the
source of a finished experiment.

## 3. 0gdd-handoff

```yaml
worktree: 0gdd-handoff
branch: docs/0gdd-handoff
date: 2026-08-15
ahead: 1
behind: 301
verdict: finish-work
confidence: high
land-effort: tiny
```

### Evidence

Unlike the other two, this branch is **not** an ancestor of main: it has exactly one
unlanded commit, `2aec62a10 docs: add 0gdd session-index investigation handoff`
(2026-08-15), adding `docs/lab-notes/2026-08-15-0gdd-session-index-performance-handoff.md`
(1,482 lines). Plus one untracked file:
`docs/lab-notes/2026-08-16-0gdd-session-index-observations-only.md` (2,493 lines),
self-described as an "uncommitted" cold-start evidence packet for an independent
parallel investigation, with a strict privacy boundary and evidence-tier scheme.

What main has: no 0gdd documentation at all (`git ls-tree -r origin/main | grep -i
0gdd` → empty); `docs/lab-notes/` on main exists and follows exactly this
dated-investigation-doc pattern (latest entry 2026-05-13), so both files fit an
established convention. The handoff doc is the sole authoritative record of the
completed investigation: executive findings, chronology, Level 1 numbers, observer
run `-08` results, evidence archive locations, the "do not merge" dispositions
quoted above, and the continuation plan. Since 2026-08-15 main shipped the
watcher design (§1); the docs are now also the provenance record for why that work
exists. The doc's own "publication via push or PR remains approval-gated" note is
process gating, not a don't-land judgment.

### Recommendation

Land both docs on main as documentation. Mechanics: commit the untracked
2026-08-16 observations file onto `docs/0gdd-handoff` (the file itself declares
that intent), then PR the branch — total diff is two docs-only files, no build or
test surface, so a docs-only CI pass should suffice. Landing them on main is also
what makes the two diagnostic worktrees above safe to delete, since the handoff
doc is their preservation artifact. If there is any hesitation, it is only that
doc references now-dead worktree paths — acceptable for a dated lab-note and
already anticipated by its explicit worktree inventory table.
