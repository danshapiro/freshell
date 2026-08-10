# SESSION-09 — Wire live watching and coalesced `sessions.changed`

> **For agentic workers:** df1 swarm worker document. TDD red-green-refactor per task; commit at every task boundary. Playwright posture for this item is `deferred-with-probe` (spec authored + MATRIX_SPECS-registered, then ONE probe run per relevant leg with per-leg outcome classification — never iterated to green unless a leg is red from THIS item's defect).

## Goal

On the **Rust server** (parity target), new, modified, moved, and deleted provider files each produce exactly one effective directory revision/render after coalescing:

1. **Detection completeness** — the periodic sweep's change signature must detect the `modified` and `moved` classes, not just count/max-moving `new`/`deleted`: any change to a sidebar-visible, parse-layer-comparable session field must move the signature even when the corpus `(len, max lastActivityAt)` pair is unmoved.
2. **SESSION-16 handoff (folded in)** — the visibility-flip blindness documented in `docs/plans/df1-evidence/SESSION-16.md` § "Adjacent discovery": a hidden non-interactive session gaining its second user message (becoming sidebar-visible) with stale timestamps moves neither `len` nor max-`lastActivityAt`, so no `sessions.changed` is broadcast and the browser only converges at an unrelated later broadcast. Legacy's `hasSessionDirectorySnapshotChange` (`server/session-directory/projection.ts`, full comparable diff) broadcasts there. This MUST be closed by this item's differ.
3. **Coalescing** — bursts of writes collapse into one effective `sessions.changed` revision (the 2s sweep tick subsumes legacy's 150ms coalescing window; the client in-flight dedupe in `src/store/sessionsThunks.ts::queueActiveSessionWindowRefresh` bounds refetch storms). No refresh storm, no full-list flicker, stable focus, two connected pages converge.

**Parity source (named):**
- Legacy differ: `server/sessions-sync/service.ts::SessionsSyncService.flush` — on every `codingCliIndexer.onUpdate(projects)` (watcher- and route-driven refreshes alike, `server/index.ts:882`), diffs via `server/session-directory/projection.ts::hasSessionDirectorySnapshotChange` over `buildSessionDirectoryComparableSnapshot`: per-session `provider/sessionId/projectPath/checkoutPath/title/summary/lastActivityAt/createdAt/archived/cwd/sessionType/isSubagent/isNonInteractive/firstUserMessage` (plus the color-blind map exception for SESSION-05 recolors). ANY comparable change ⇒ revision bump + `broadcastSessionsChanged` (`server/ws-handler.ts:3846`, `{type:'sessions.changed', revision}`).
- Legacy coalescing: `SessionsSyncService.publish` — leading flush immediately, trailing writes inside a 150ms window flush ONCE at window end (`onWindowElapsed`); in-flight refreshes re-check.
- Rust detection substrate (already landed): `crates/freshell-server/src/main.rs::spawn_sessions_sweep` (2s interval poll over `SessionIndex::snapshot()`, `MissedTickBehavior::Skip`, boot-seed avoids spurious first broadcast) + the unified `sessions_revision` Arc shared by sweep / `sessions.rs` PATCH write-site / fresh-agent materialize paths via `freshell_ws::terminal::broadcast_sessions_changed`.

**Acceptance evidence (definition of done for `deferred-with-probe` posture):**

1. The sweep signature detects `modified` (in-place, max-neutral), `moved` (delete+add same-tick, count/max-neutral), and the SESSION-16 visibility flip (digest-level), proven at Rust unit + real-`SessionIndex` integration depth, PLUS one black-box WS-level proof that the real binary emits `sessions.changed` for each class.
2. Focused runs green ×2 (timing-sensitive tests re-run to classify flakiness), `cargo fmt` + `cargo clippy --all-targets -- -D warnings` clean on touched crates.
3. Playwright spec `test/e2e-browser/specs/session-live-updates.spec.ts` authored (two pages, all four backend shapes, create/rename=move/append/delete, burst coalescing, focus stability, no-flicker node-identity), one additive `MATRIX_SPECS` line, probed ONCE per leg (`legacy-chromium` control / `rust-chromium` target), per-leg outcomes classified in the evidence note.
4. Review loop (≤5 rounds) reports no serious findings.
5. Evidence file `docs/plans/df1-evidence/SESSION-09.md` in the established style.

## Current-state findings (verified by reading code at base `origin/df1/integration` = `5521f3aba`)

1. **Sweep + unified revision machinery — PRESENT.** `spawn_sessions_sweep` (main.rs:2259) ticks every 2s (`SESSIONS_SWEEP_INTERVAL` ≥ the index's 1s TTL), snapshots, compares `sessions_sweep_signature`, and calls `broadcast_sessions_changed` (freshell-ws/terminal.rs:4095), which mints the shared `Arc<AtomicI64>` revision (counter unified across producers, "UNIFIED counter (commit b068d28b)" doc). Client folds frames through the monotonic-revision guard (`src/App.tsx` `msg.type === 'sessions.changed'` arm) into `queueActiveSessionWindowRefresh`, which in-flight-dedupes per surface (no storm).
2. **`new`/`deleted` detection — PRESENT & PINNED.** `(len, max_last_activity_at)` covers both regardless of timestamps (`new_session_file_changes_the_signature`, `new_older_session_file_is_still_detected_as_a_change`); e2e create/delete legs green in `session-directory-matrix.spec.ts` (create mid-test + removed-from-disk tests; checklist annotation 2026-07-19).
3. **`modified` detection — PARTIAL/GAP.** Only modifications that move the *corpus-wide* max `lastActivityAt` or change count fire. An in-place content change whose parse-affecting fields change but whose `last_activity_at` stays below the corpus max (e.g. any back-dated append, a title-affecting edit with unchanged recency, a `first_user_message`/summary change) is **invisible** to the signature. Legacy's full comparable diff fires there. **This is the item's core gap.**
4. **`moved` detection — GAP (documented as accepted "gap 2").** A same-tick delete+add that leaves `(len, max)` unmoved is undetectable by the current signature. A full multiset digest closes it; the "ACCEPTED, exotic" note becomes obsolete for the classes a digest covers.
5. **SESSION-16 visibility-flip blindness — GAP (handoff, NOW IN SCOPE).** `is_non_interactive` is derived at parse (`crates/freshell-sessions/src/parse/claude.rs:469`: `user_message_count <= 1`); the flip 1→2 user messages changes `is_non_interactive`/`first_user_message`-class parse fields but can leave `(len, max)` unmoved → no broadcast. Legacy broadcasts (its comparable list includes `isNonInteractive`/`firstUserMessage`). Must carry a digest field.
6. **Override-layer changes — PRESENT (closed elsewhere, NOT this item).** Rename/archive/delete PATCHes broadcast at the write site sharing the same revision counter (gap 1 doc note + `patch_*_broadcasts_sessions_changed_*` pins in sessions.rs). External-process override edits remain accepted for bake-in (gap 3). Fields legacy diffs that `IndexedSession` cannot produce (`archived` from overrides, `sessionType` SESSION-06, `checkoutPath` SESSION-08) stay at their projection/write-site layers — explicitly out of the sweep differ's contract (documented in the rewritten fn doc).
7. **`source_file` deliberately NOT in the digest.** Legacy's comparable snapshot is projection-derived (cwd grouping), so a pure file move with unchanged content is silent there too; including `source_file` would make Rust *stricter* than legacy (spurious broadcasts for invisible moves). Parity = exclude.
8. **Client-side storm/flicker guards — PRESENT.** `queueActiveSessionWindowRefresh` per-surface in-flight dedupe + `invalidationRefreshState.queued` collapse; sidebar rows keyed by `sessionKey` (`src/components/Sidebar.tsx:890`) so an unchanged row's DOM node survives a refetch (flicker-free by construction; PW spec asserts node identity).
9. **Reconciliation note `restore-matrix scenario 3 test.fixme` — STALE.** No `fixme` remains in that file at this base; not part of this item.
10. **`SessionIndex::snapshot()` — `Arc<Vec<IndexedSession>>`** with stale-while-revalidate; sweep-side one-tick lag already tolerated by the existing poll-if-needed test pattern (50×20ms settle loops).

## Design

**Class C item** (behavior partially present; differ semantics wrong/incomplete). ONE production change:
replace `main.rs::sessions_sweep_signature`'s `(usize, i64, u64)` (count, max-ts, identity
digest) with an **opaque full-comparable digest** covering:

- every parse-layer comparable field of every `IndexedSession`: `provider, session_id,
  project_path, title, summary, first_user_message, last_activity_at, created_at, cwd,
  is_subagent, is_non_interactive` — exactly legacy's comparable list minus the
  projection/override-layer fields in finding 6, minus `source_file` (finding 7).
  Hashed as a **sorted tuple multiset** (order-independent; multiset-faithful — a
  same-tick delete+add changes the multiset).
- the existing identity-registry digest (terminal_id/provider/session_id triples;
  `updated_at` deliberately excluded — `identity_updated_at_alone_does_not_move_the_sweep_signature`
  stays green, the sweep must not become a heartbeat firehose), hashed into the same
  signature behind a domain separator.

Return type becomes an opaque `u64` newtype-free `SweepSignature` (PartialEq-only
contract — no component accessors). The two structurally-coupled tests
(`empty_snapshot_signature_is_zero_count_zero_activity`,
`signature_pairs_count_with_the_max_last_activity_at`) are re-expressed behaviorally
(empty ≠ seeded; seeded ≠ seeded+1; count-and-max inputs now subsumed by the digest).
The count/max *behavior* they pinned (add with older ts detected; unchanged home stable)
is already carried by the two real-index tests, which keep passing unchanged.

**Performance:** one extra O(N log N) sort + O(Σbytes) hash per 2s tick over the already
in-memory snapshot — strictly cheaper than legacy's full deep-equal per 150ms-coalesced
refresh. No new I/O.

**Teeth (mutation spot-check, per df1 discipline):** with the digest rewritten, drop
`is_non_interactive` from the tuple once → exactly the visibility-flip pins must go red,
everything else green; revert and re-verify.

**What is NOT changing:** sweep cadence/substrate (2s interval, Skip, boot-seed, FENCE
respecting `directory_index`'s request-pull design — no filesystem watcher introduced;
the poll tick IS the coalescer), the broadcast function/counter, the client listener, and
every override write-site broadcast.

### Task 1 — Rust: full comparable sweep signature (TDD)

**Files:**
- Modify: `crates/freshell-server/src/main.rs` (`sessions_sweep_signature` rewrite: fn body + doc comment; `spawn_sessions_sweep` unchanged except doc touch-ups that reference the old shape)
- Test: `crates/freshell-server/src/main.rs` `mod sessions_sweep_tests` (in-file unit + real-index integration tests — the established location)

RED (new pins, must fail against the old tuple signature; written FIRST):
- `in_place_modification_below_corpus_max_moves_the_signature` — pure builder: items `[A(ts=100,title=X), B(ts=500)]` vs `[A(ts=100,title=Y), B(ts=500)]`: count and max identical ⇒ old signature equal ⇒ RED; digest must differ.
- `delete_and_add_same_tick_matching_max_moves_the_signature` — `[A(ts=500), B(ts=100)]` vs `[C(ts=500), B(ts=100)]` (C ≠ A in identity, same ts) ⇒ old (2,500,digest-of-only-identity-registry) equal ⇒ RED.
- Per-field digest pins (pure builder, table of the comparable fields): title, summary, first_user_message, created_at, cwd, is_subagent, is_non_interactive, project_path, provider, session_id each individually move the digest.
- `visibility_flip_is_detected_with_stale_corpus_max` — REAL `SessionIndex` over a tempdir claude home: seed corpus-max anchor session (ts 2030) + one hidden seed with ONE user message (ts 2025) → signature S0; append a SECOND user message back-dated *older* than the hidden session's first message (so its `last_activity_at` does not advance; corpus len/max both unmoved) → settle-poll ⇒ signature must move. Direct pin of the SESSION-16 §"Adjacent discovery" scenario.
- `moved_to_another_project_dir_is_detected` — REAL index: file moved from `projects/-a/` to `projects/-b/` WITH cwd rewritten to `/b` ⇒ project_path (and thus the digest) moves while `(len, max)` stay fixed ⇒ detected.

GREEN-adjacent (kept, adapted where they touched tuple components):
- `identity_registry_changes_move_the_sweep_signature`, `identity_updated_at_alone_does_not_move_the_sweep_signature` — unchanged (identity digest still folded in).
- `unchanged_home_keeps_a_stable_signature`, `new_session_file_changes_the_signature`, `new_older_session_file_is_still_detected_as_a_change` — unchanged *except* any `.0/.1` component access re-expressed against non-empty-vs-empty or before/after digest equality.
- `order_of_items_does_not_change_the_signature` (new, replaces the two structurally-coupled tests' equivalence side) + `seeded_home_differs_from_empty` (replaces their discriminating side).

Run `cargo test -p freshell-server sessions_sweep` (cargo lease). Implement, re-run, then the mutation spot-check, then `cargo fmt` + `clippy -p freshell-server --all-targets -- -D warnings`. Commit.

### Task 2 — Rust: black-box WS integration proof

**Files:**
- Create: `crates/freshell-server/tests/session09_live_watching.rs`

Harness pattern duplicated from `safe11_term22_shutdown_reaping.rs` / `diag01_lifecycle_logging.rs` (established convention: real binary, temp home, ephemeral port, `hello`→`ready`). Legs, each asserting a `sessions.changed` frame arrives within 8s (2s tick + detached-revalidate + margin; deterministic non-arrival windows are 2×tick+margin ≈ 6s):
1. **create**: write a claude JSONL mid-run ⇒ frame.
2. **modified (max-moving)**: append a turn with a NEWER timestamp ⇒ frame. *(Digest-level max-neutral modification is crate-proven in Task 1; this leg proves the wiring classes a browser actually hits.)*
3. **visibility-flip (SESSION-16 handoff, end-to-end)**: a ONE-user-message session (hidden) already indexed (its create already fired a frame); record the current revision R by observing a trigger frame from an independent create, asserting monotonic sequencing; then append a back-dated 2nd user message ⇒ a **new** frame with revision > R must arrive. Guard against masking: assert the frame's revision strictly exceeds R (the unified counter makes "some other producer's frame" impossible here — no PATCH/fresh-agent traffic exists in this test).
4. **delete**: remove the file ⇒ frame.
5. **coalescing quiescence**: a 5-append burst inside ~1s ⇒ after the LAST induced frame, ZERO further `sessions.changed` frames for 6s (no storm; the sweep only emits on change).
6. **no spurious broadcast**: an untouched home yields ZERO frames across 6s before leg 1 seeds anything (boot-seed discipline).

`FRESHELL_SERVER_BIN` honored (same as existing tests); `nice -n 19`. Green ×2. Commit.

### Task 3 — Playwright spec + MATRIX_SPECS registration (deferred posture)

**Files:**
- Create: `test/e2e-browser/specs/session-live-updates.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (ONE additive `/session-live-updates\.spec\.ts$/` line + comment)

Spec (`freshellPage` fixtures + `createE2eServerHandle` + `construct.setupHome` seeding all four providers with OLD timestamps; a second `context` makes page B; amplifier legs `e2eServerKind === 'rust'`-gated — established KNOWN DIVERGENCE):
1. **two-page create convergence**: write a new claude session mid-test ⇒ renders in BOTH pages without reload.
2. **append convergence**: append a 3rd turn (newest ts) to an existing claude session ⇒ it becomes the TOP sidebar item in both pages.
3. **move/rename convergence**: `fs.rename` a claude file into a new project dir with rewritten cwd+new title area ⇒ old render gone / new render present in both pages.
4. **codex shape**: append `response_item` records (newest ts) ⇒ codex session top in both pages.
5. **opencode shape**: `UPDATE session SET time_updated` in `opencode.db` ⇒ opencode session top in both pages.
6. **amplifier shape (rust-only)**: rewrite `metadata.json` (newer `description_updated_at`, new `name`) ⇒ updated title renders in both pages.
7. **burst coalescing + focus + no-flicker** (claude): focus the sidebar search input in page A; fire 5 rapid appends; after convergence assert (a) `document.activeElement` is still the search input, (b) node identity of an UNRELATED stable row is preserved (`page.evaluate(({a,b}) => a === b, …)` on pre/post element handles), (c) quiescence: a 6s window with zero `/api/session-directory` requests after the final induced one, (d) bounded attribution: `/api/session-directory` requests fired between burst start and settle ≤ 3 on `rust-chromium` (≤ one per swept change tick) and ≤ 3 on `legacy-chromium` (leading+trailing ≤ 2 + wiggle) — legacy is the control pinning the bound as sound.

Probe: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=legacy-chromium test/e2e-browser/specs/session-live-updates.spec.ts` ONCE (pw lease), same for `--project=rust-chromium`; classify per-leg outcomes verbatim in the evidence note; iterate ONLY if a rust leg is red from THIS item's defect.

### Task 4 — Evidence + checklist-annotation style writeup

**Files:** Create `docs/plans/df1-evidence/SESSION-09.md` (summary: parity source, clause→evidence map, what landed, deliberate scoping/non-claims — incl. override-layer fields staying at their write sites and why `source_file` is excluded, probe classifications, mutation spot-check record, review-loop rounds). End state `df1ctl update` `"state":"review","terminal":"COMPLETED"`.

## Global constraints

- Work only in `.worktrees/df1-session-09-live-watching`; explicit-pathspec commits; NO push/PR/git-config/checklist edits.
- Scoped runs only: cargo via cargo lease (`acquire.sh cargo …`), vitest only the named focused files, pw via pw lease, sandbox lease for anything destructive. NO `npm test/check/verify`, no unscoped vitest/cargo.
- `nice -n 19` on all builds/tests.
- `server/` (legacy) is FROZEN — read-only parity source. Client (`src/`) unchanged: the listener/dedupe/keying are already sufficient (finding 8).
- No new dependencies whatsoever.
- Forbidden ports/processes per df1 worker contract (3001/3002/17871/17872/17874, foreign PIDs); tests allocate ephemeral ports only.
