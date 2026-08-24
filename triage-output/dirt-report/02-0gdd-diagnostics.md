# Dirt report — 0gdd diagnostics family

**Reader pass date:** 2026-08-23. Every dirty file enumerated fresh via `git status --porcelain` and physically read (diffs for tracked, full content or full structural read for untracked). Read-only: nothing modified, deleted, committed, or tested.

**Handoff-claim verification summary**
- ✅ "Do not merge" marking: real — `docs/lab-notes/2026-08-15-...-handoff.md` lines 802–803 mark both diagnostic worktrees "**Do not merge** as production code"; §7.4 lists "committing or pushing either diagnostic worktree" under actions requiring user approval.
- ✅ Evidence archive: real — `~/.local/state/freshell/0gdd-observer-20260814-08/` contains `events.jsonl` (2,163,713 B, 1,635 records), `state.json`, `report.json`; report shows `status:"complete"`, full 86,400,000 ms window, 1,440 buckets, 0 production mismatches. All three SHA-256 hashes match the lab-notes §9.2 retained hashes exactly. Partial runs -03/-04/-06/-07 and five preflight handoffs also present as claimed.
- ⚠️ Material gap in the claim's implication: the **Level 1 CPU campaign output is gone** — 76 files / 1,265,171 B lived in `/tmp` and a WSL reboot destroyed them (lab-notes §1.6). Values survive only as transcribed tiers in the uncommitted lab-notes doc.

---

## 1. Per-worktree roll-up

### `.worktrees/0gdd-measurement` — branch `investigation/0gdd-measurement` @ 225a91db3
**Verdict: read-useful.** The Level 1 measurement capability exists nowhere else (grep confirms zero `FRESHELL_0GDD` / `with_diagnostic_options` anywhere on main; `scripts/` on main has only the unrelated `measure-bandwidth.ts`). The five dirty files form one coherent diagnostic bundle: three tracked Rust diffs add env-gated diagnostic controls + `0gdd.*` tracing events; the two untracked TS files are the campaign runner and its unit test. Output evidence is destroyed (WSL reboot), but the lab-notes doc retained the values, and the source hashes recorded there still match on-disk (verified). Handoff says do-not-merge → archive all five in triage.
Useful paths: `scripts/measure-0gdd-level1.ts`, `test/unit/scripts/measure-0gdd-level1.test.ts`, and the three tracked diffs (capture via `git diff`).

### `.worktrees/0gdd-observer` — branch `investigation/0gdd-observer` @ 225a91db3
**Verdict: read-useful.** Sole dirty path is the 180 KB observer example (the `examples/` dir holds exactly one file — nothing else). The aggregate *output* it produced is durably archived outside the repo (hash-verified above), but the *source itself* exists only in this worktree: main's `crates/freshell-sessions` has no `examples/` dir and no such tool, and the lab-notes doc records its hash, not its content. Hash check: on-disk file matches lab-notes §5.1 retained hash `4f63ec34…` exactly. → archive source in triage; do not land (do-not-merge + function superseded by main's shipped SessionWatcher).
Useful paths: `crates/freshell-sessions/examples/observer_0gdd.rs`.

### `.worktrees/df1-session-09-live-watching` — branch `df1/session-09-live-watching` @ d823c9870
**Verdict: read-useful.** Two dirty files, opposite fates. The main.rs diff is **confirmed poison** (explicit "TEMPORARY MUTATION (black-box red proof)" label; degrades the sweep signature to the old blind (len, max) shape) → never-commit-poison. The untracked test is a genuine black-box WS-wire acceptance test that covers a surface main's tests do not (no `sessions.changed` wire-level test exists anywhere on main) → extract-to-new-branch.
Useful paths: `crates/freshell-server/tests/session09_live_watching.rs`.

### `.worktrees/0gdd-handoff` — branch `docs/0gdd-handoff` @ 2aec62a10
**Verdict: read-useful.** Sole dirty path is the 2,493-line observations-only evidence packet. It is the sole surviving record of the Level 1 campaign (values tier) and the integrity index (hashes) for every other artifact in this family — and it currently exists only as an untracked file. Matches the established `docs/lab-notes/YYYY-MM-DD-slug.md` convention (same dir already holds 11 dated notes on the branch base; main has 12). → land-via-PR.
Useful paths: `docs/lab-notes/2026-08-16-0gdd-session-index-observations-only.md`.

---

## 2. Per-file dispositions

### 0gdd-measurement

| Path | Size | What it actually is (from reading) | Disposition |
|---|---|---|---|
| `crates/freshell-server/src/main.rs` (M) | +213/−0 diff lines | Adds `FRESHELL_0GDD_LEVEL1` master env gate plus four sub-controls (session sweep on/off, auto-title sweep on/off, refresh-mode TTL `normal/10s/warm-only`, cache-writes on/off), wires `SessionIndex::with_diagnostic_options`, emits `0gdd.sessions_sweep` tracing events per tick, includes a gating/parsing unit test. Diagnostic scaffolding for the supplanted TTL-poll architecture. | archive-in-triage |
| `crates/freshell-server/src/auto_title_sweep.rs` (M) | +11 diff lines | Adds a `diagnostic_events: bool` parameter to `spawn_auto_title_sweep` and emits `0gdd.auto_title_sweep` (duration_ms, rows, identity_count) per pass. Part of the same Level 1 bundle. | archive-in-triage |
| `crates/freshell-sessions/src/directory_index.rs` (M) | +358/−62 diff lines | Adds `DiagnosticState`, `with_diagnostic_options[_and_cache_path]` constructors, `RefreshStats`/`SourceStats`, structured `0gdd.index_refresh_started/finished`, `0gdd.index_source`, `0gdd.cache_save_started/finished` tracing events, a persist-writes kill switch (`save_cache_file` now returns byte count), and a `diagnostic_cache_can_load_without_writing` test. Core of the Level 1 instrumentation. | archive-in-triage |
| `scripts/measure-0gdd-level1.ts` (??) | 48,959 B / 818 lines | Self-contained Level 1 campaign runner: spawns scratch release-binary servers under `/tmp` with per-condition controls; heavy safety engineering — production (port 3001) process/listener fingerprint verification before and after each condition, loopback-only scratch listener verification before any authenticated request, `/proc`-based CPU/RSS/IO sampling, staged A/quiet/A bracket design with stability/materiality predicates, boundary-tracked clean sampling windows, evidence sanitizer that rejects tokens/absolute paths/private field names, exact-fingerprint stop (SIGTERM→SIGKILL) + private-tree cleanup, checkpointed sanitized output outside the raw root. | archive-in-triage |
| `test/unit/scripts/measure-0gdd-level1.test.ts` (??) | 31,451 B / 543 lines | Companion vitest suite for the runner: 31 tests over proc parsing, env allow-listing, port/listener/fingerprint guards, JSONL tailing, event schema reduction, BoundaryTracker pairing, orchestration decision-tree branches, run-validity bounds, evidence sanitization, cleanup invariants. Lab-notes records "31 passed" on 2026-08-16. | archive-in-triage |

Rationale for archive (not land): the bundle only functions against the TTL-poll sweep architecture it instruments; main has shipped the watcher-driven design, and the committed handoff explicitly marks the worktree do-not-merge. Rationale for archive (not delete): the capability exists nowhere else, the measurement output was destroyed by an environment reboot, and this source is the sole re-derivation path for the lab-notes' [A]/[D]-tier values.

### 0gdd-observer

| Path | Size | What it actually is (from reading) | Disposition |
|---|---|---|---|
| `crates/freshell-sessions/examples/observer_0gdd.rs` (??) | 180,425 B / 4,776 lines | Standalone unix-only Rust example binary: passive 24-hour filesystem observer over the four provider roots (claude/codex/amplifier recursive watch, opencode DB parent non-recursive). `preflight`/`run`/`smoke` CLI; metadata-only inventory scans (size/mtime/ctime/dev/inode — never parses content) cross-checked against `notify` watcher notices on 15-min reconciliation; salted path-id pseudonymization so no real paths appear in output; production fingerprint guard; inotify watch-budget accounting; CPU self-limit (6% soft guard); 58 embedded unit tests (structural read: sections cover CLI parsing, preflight handoff, ingress coalescing, correlation, bucket schedules, output writer, run loop). This is the instrument that produced the archived -03..-08 runs. | archive-in-triage |

Rationale: the *output* is safely archived outside the repo (hash-verified), but the *source* is not reproduced anywhere — deleting the worktree would destroy the only copy of the tooling behind the investigation's central quantitative claim (main's shipped comment "the watcher handles ~98.2% of file changes" traces directly to this tool's -08 numbers). Do-not-merge per handoff; main's `SessionWatcher` now fills the production role.

### df1-session-09-live-watching

| Path | Size | What it actually is (from reading) | Disposition |
|---|---|---|---|
| `crates/freshell-server/src/main.rs` (M) | +7/−10 diff lines | **Confirmed deliberate poison.** The diff carries the literal label `// TEMPORARY MUTATION (black-box red proof): old blind shape` — the per-session signature tuple is gutted to `("", "", None, None, None, …)`, then the refs vector is `.clear()`ed and replaced with a single `vec![(items.len(), max_last_activity)]` tuple, restoring exactly the old (len, max) blindness the SESSION-09 fix removed. Written to force the acceptance test below red. | never-commit-poison |
| `crates/freshell-server/tests/session09_live_watching.rs` (??) | 18,928 B / 424 lines | Full black-box WS-wire acceptance test that boots the real release binary against an isolated temp home, completes the hello→ready handshake, and drives on-disk mutations through five change classes asserting live `sessions.changed` frames with strictly monotonic revisions: quiet-boot (no spurious frames), create, content-identical rewrite (no re-broadcast), in-place modify below corpus max, hidden→visible `is_non_interactive` flip, delete, and a 5-append burst asserting ≤2 coalesced frames, then SIGTERM graceful-exit check. | extract-to-new-branch |

Rationale for extract: main has *no* wire-level sessions.changed test — `crates/freshell-server/tests/` on main holds only browser01/diag01×2/diag02/net09/safe11/sighup suites; coverage of the signature digest lives only in in-crate `sessions_sweep_tests` unit tests (main has 4; none exercise a booted binary + websocket). The test's frame expectation `{"type":"sessions.changed","revision":N}` matches main's `broadcast_sessions_changed` exactly.
Extraction caveats (recorded for whoever lands it): (a) the test was authored against the 2 s poll-sweep paradigm — its comments reason about frames arriving "inside ONE 2s sweep tick", while current main broadcasts on watcher generation-advance and uses the signature gate only on the 2 s identity ticker; all change legs should still fire via the watcher path, but the burst `≤2 frames` bound and the 6.5 s quiet-boot window (watcher startup barrier) need revalidation against watcher-era timing; (b) it was written at the df1 branch point — rebase onto current main before landing.

### 0gdd-handoff

| Path | Size | What it actually is (from reading) | Disposition |
|---|---|---|---|
| `docs/lab-notes/2026-08-16-0gdd-session-index-observations-only.md` (??) | 104,750 B / 2,493 lines | The "observations only" evidence packet: six-tier evidence scheme, quarantine boundary, source-behavior walkthrough at pinned `225a91db3`, Level 1 harness description + every retained run's resource/request tables + bracket arithmetic, observer implementation + full attempt chronology (-03…-08), complete 24 h -08 evidence (inventory, notices, distributions, classification totals, hashes, privacy scan), artifact map with retained hashes, read-only reproduction commands, and an explicit unknowns/absent-measurements audit. Self-describes (line 9) as an uncommitted observations file on `docs/0gdd-handoff`. | land-via-PR |

Rationale for land (not archive): it matches the repo's established `docs/lab-notes/` convention (dated single-topic investigation docs, 11 siblings on this branch base, 12 on main); it is the *sole surviving record* of the Level 1 campaign (whose /tmp output a WSL reboot destroyed — §1.6); and it is the integrity anchor for the rest of this family — I re-hashed the observer source, the runner, the runner test, and all three -08 archive files against its §5.1/§4.1/§9.2 retained hashes and all five match exactly. Minor landing note: the "Document status: Uncommitted" line goes stale on commit — either accept as historical or edit 1 line before PR.

---

## 3. Proof excerpts for non-obvious calls

### 3.1 Poison confirmation (df1 main.rs)
```
-                s.session_id.as_str(),
-                s.project_path.as_str(),
-                s.title.as_deref(),
-                s.summary.as_deref(),
-                s.first_user_message.as_deref(),
-                s.last_activity_at,
-                s.created_at,
-                s.cwd.as_deref(),
-                s.is_subagent,
-                s.is_non_interactive,
+                // TEMPORARY MUTATION (black-box red proof): old blind shape
+                // == only identity-ish fields, no content fields.
+                "", "", None, None, None, s.last_activity_at, None, None, false, false,
...
+    // drop per-session identity too: keep only (len, max) semantics
+    session_refs.clear();
+    let mut session_refs: Vec<(usize, i64)> =
+        vec![(items.len(), items.iter().map(|s| s.last_activity_at).max().unwrap_or(0))];
```
Label present, semantics match "blind old shape", and the test file's own comments describe the exact class this mutation re-blinds ("the OLD signature is provably unmoved…"). Triple-confirmed poison; consistent with the black-box red-proof protocol (test exists to go red, mutation never designed to ship).

### 3.2 Destroyed Level 1 output (why the lab-notes doc is load-bearing)
Lab-notes §1.6: *"The final Level 1 result directory was created under /tmp. A prior inventory recorded 76 files and 1,265,171 bytes. A later WSL reboot removed the directory."* §9.1: `/tmp/freshell-0gdd-output-1130474-ycH6V9` — "That path is absent." §4.7/§4.9 tables are headered "transcribed from vanished Level 1 output." The -08 observer output by contrast sits durably under `~/.local/state/` and hash-verifies.

### 3.3 Hash re-verification against the untracked doc (all match)
| Artifact | Doc-retained SHA-256 | On-disk now | Match |
|---|---|---|---|
| observer_0gdd.rs (§5.1) | 4f63ec34…a3f | 4f63ec34…a3f | ✅ |
| measure-0gdd-level1.ts (§4.1) | 9aee493d…90 | 9aee493d…90 | ✅ |
| measure-…test.ts (§4.1) | da97873e…54 | da97873e…54 | ✅ |
| -08 events.jsonl (§9.2) | 846368a9…5a | 846368a9…5a | ✅ |
| -08 report.json (§9.2) | bac9da47…b9 | bac9da47…b9 | ✅ |
| -08 state.json (§9.2) | 29c179c5…b6 | 29c179c5…b6 | ✅ |

### 3.4 Lineage into shipped code
Archived `-08/report.json`: `correlation.matched = 7802`, `missed = 145` → 7802/(7802+145) = 98.17 %. Main's current `crates/freshell-server/src/main.rs` sweep comment: *"the SessionWatcher feeds inotify events … This covers ~98.2% of file changes with sub-second latency."* The uncommitted observer's measurement is the literal source of the number quoted in shipped production code — the strongest single argument for archiving the observer and runner sources rather than discarding them as spent scaffolding.
